/**
 * Conversation layer: maps one chat conversation onto one DSH session.
 *
 * The runtime's `session/prompt` is only an admission receipt — the answer
 * arrives later as `assistant/message` session events. This module owns that
 * gap: it accumulates the assistant text of the live turn, watches
 * `session.status` for the `idle` transition, and resolves one turn promise per
 * chat message.
 *
 * The same layer owns context-window hygiene. Rather than sending the
 * runtime's `session/compact` (which costs an extra model call), it renews the
 * whole session once the conversation has carried `maxSessionChars` of chat
 * text, and keeps `prewarmCount` spare session ids so a renewal costs the user
 * no handshake.
 */

import { randomBytes } from 'node:crypto'
import { createLogger, clampText, oneLine } from './util.mjs'

const log = createLogger('chat')

/**
 * The assistant text of one turn. A turn may produce several assistant
 * messages (one per model step), so their text blocks are concatenated.
 * @param {any} event - an `assistant/message` session event.
 * @returns {string} joined visible text.
 */
export function assistantTextOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('').trim()
}

/**
 * A one-line human summary of the model's tool use, for progress reporting.
 * @param {any} event - a `tool/call` session event.
 * @returns {string} e.g. `pwsh(Get-Process)`.
 */
export function describeToolCall(event) {
  const name = String(event?.data?.name ?? 'tool')
  let hint = ''
  try {
    const args = JSON.parse(String(event?.data?.arguments ?? '{}'))
    hint =
      args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.description ?? args.prompt ?? ''
  } catch {
    hint = ''
  }
  const text = oneLine(hint)
  return text === '' ? name : `${name}(${text.length > 50 ? `${text.slice(0, 50)}…` : text})`
}

/** One chat conversation bound to one DSH session. */
class Conversation {
  #pool
  #key
  #kind
  #session = null
  #turn = null
  #queue = Promise.resolve()
  #ready

  /**
   * @param {ConversationPool} pool - owning pool.
   * @param {string} key - stable conversation key.
   * @param {'private'|'group'|'web'} kind - chat kind, for logging.
   */
  constructor(pool, key, kind) {
    this.#pool = pool
    this.#key = key
    this.#kind = kind
    this.#ready = pool.checkout().then((session) => {
      this.#session = session
    })
    // Never leave an unhandled rejection on the readiness promise.
    this.#ready.catch(() => {})
  }

  /** @returns {string | null} the bound session id, once known. */
  get sessionId() {
    return this.#session === null ? null : this.#session.id
  }

  /**
   * Bind this conversation to its session in the pool's routing table, so a
   * notification that arrives before `#ready` resolves is not attributed to
   * another conversation.
   * @param {string} sessionId - the session this conversation now owns.
   */
  bind(sessionId) {
    this.#pool.bindSession(sessionId, this)
  }

  /** @returns {number} session starts so far (diagnostics). */
  get renewals() {
    return this.#pool.renewals
  }

  /**
   * Handle one inbound chat message: serialize it behind earlier messages of
   * this conversation, then resolve with the assistant reply.
   * @param {{
   *   text: string,
   *   speaker?: string,
   *   onProgress?: (note: string) => void,
   *   timeoutMs?: number,
   *   attachments?: Array<{ type: 'image', data: string, mimeType: string }>,
   * }} input - the message, with any images to hand the model.
   * @returns {Promise<string>} the assistant's reply text.
   */
  send(input) {
    // Register the turn synchronously, before any `await`, so notifications that
    // arrive while the session is still binding are attributed to this turn
    // rather than dropped or misrouted.
    const turn = {
      resolve: null,
      reject: null,
      text: '',
      tools: 0,
      error: null,
      settleTimer: null,
      finished: false,
      onProgress: input.onProgress,
      /** The runtime's turn number for this prompt; `null` until `turn/start`. */
      number: null,
    }
    const promise = new Promise((resolve, reject) => {
      turn.resolve = resolve
      turn.reject = reject
    })
    turn.promise = promise
    this.#turn = turn

    const run = this.#queue.then(
      () => this.#runTurn(input, turn),
      () => this.#runTurn(input, turn),
    )
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #runTurn({ text, speaker, timeoutMs, attachments }, turn) {
    try {
      await this.#ready
    } catch (error) {
      // No session could be created: fail this turn instead of leaving the
      // caller waiting for an answer that can never arrive.
      if (this.#turn === turn) this.#turn = null
      turn.reject(error instanceof Error ? error : new Error(String(error)))
      return turn.promise
    }
    const session = this.#session
    if (session === null) throw new Error('conversation has no session')
    this.bind(session.id)

    const timer = setTimeout(() => {
      this.#finishTurn('timeout')
    }, timeoutMs ?? this.#pool.turnTimeoutMs)
    turn.timer = timer

    const prompt = speaker === undefined || speaker === '' ? text : `[${speaker}] ${text}`
    try {
      await this.#pool.runtime.prompt(session.id, clampText(prompt, this.#pool.maxInboundChars), attachments)
      session.chars += prompt.length
    } catch (error) {
      clearTimeout(timer)
      if (this.#turn === turn) this.#turn = null
      throw error
    }

    const answer = await turn.promise
    if (session.chars >= this.#pool.maxSessionChars) this.#renew()
    return answer
  }

  #renew() {
    const stale = this.#session
    log.info(`conversation ${this.#key}: context reached ${stale?.chars ?? 0} chars, starting a fresh session`)
    this.#session = null
    this.#ready = this.#pool.checkout().then((session) => {
      this.#session = session
      this.bind(session.id)
    })
    this.#ready.catch((error) => log.error(`conversation ${this.#key} renew failed:`, error))
    this.#pool.invalidate(stale)
  }

  /**
   * Record one runtime notification for this conversation.
   * @param {string} method - notification method.
   * @param {any} params - notification payload.
   * @returns {boolean} whether the notification belonged to this conversation.
   */
  handleNotification(method, params) {
    // Until the session is bound, accept events for the turn registered by
    // `send`; the pool's session routing already keeps other chats out.
    if (this.#session !== null && params?.sessionId !== this.#session.id) return false
    const turn = this.#turn
    if (method === 'session.status') {
      if (params.status === 'idle') this.#finishTurn('idle')
      return true
    }
    if (method !== 'session.event' || turn === null) return true
    const event = params.event
    const eventTurn = event?.data?.turn
    // Our own turn number is whichever `turn/start` follows the prompt. Anything
    // whose turn number is already known to differ — a priming reply, or a turn
    // the runtime began on its own — is not ours.
    const ours = () => turn.number !== null && eventTurn === turn.number
    const foreign = () => turn.number !== null && eventTurn !== undefined && eventTurn !== turn.number
    switch (event?.type) {
      case 'turn/start': {
        if (turn.number === null) {
          // Lock onto this turn. Its `turn/start` is the first boundary the
          // runtime emits after the prompt was queued.
          turn.number = eventTurn
          break
        }
        // Another turn started on this session: ours is over and its text is
        // complete, so answer now rather than waiting for an idle that may not
        // belong to us.
        if (eventTurn !== turn.number) this.#finishTurn('next-turn')
        break
      }
      case 'assistant/message': {
        if (foreign() || turn.number === null) break
        const text = assistantTextOf(event)
        if (text !== '') turn.text = turn.text === '' ? text : `${turn.text}\n\n${text}`
        // A continuation step can trail the last stream event; give the runtime
        // a short grace period before trusting an idle status.
        if (turn.settleTimer !== null) clearTimeout(turn.settleTimer)
        turn.settleTimer = setTimeout(() => this.#finishTurn('settled'), 1500)
        break
      }
      case 'tool/call': {
        if (!ours()) break
        turn.tools += 1
        turn.onProgress?.(describeToolCall(event))
        if (turn.settleTimer !== null) clearTimeout(turn.settleTimer)
        break
      }
      case 'turn/end': {
        if (!ours()) break
        const kind = event?.data?.reason?.kind
        if (kind === 'error') {
          const failure = event?.data?.reason?.error
          turn.error = String(failure?.message ?? failure?.code ?? 'model call failed')
        } else if (kind === 'aborted' || kind === 'interrupted') {
          turn.error = '这一轮被中断了'
        } else if (kind === 'max-tokens') {
          turn.error = '这一轮回答达到了输出上限'
        }
        break
      }
      default:
        break
    }
    return true
  }

  #finishTurn(trigger) {
    const turn = this.#turn
    if (turn === null || turn.finished) return
    turn.finished = true
    if (turn.timer !== undefined) clearTimeout(turn.timer)
    if (turn.settleTimer !== null) clearTimeout(turn.settleTimer)
    this.#turn = null
    log.debug(`turn finished (${trigger}) for ${this.#key}: ${turn.text.length} chars, ${turn.tools} tool calls`)
    if (turn.error !== null && turn.text === '') turn.reject(new Error(turn.error))
    else turn.resolve(turn.text)
  }

  /** Reject any in-flight turn (runtime went down). */
  abort(error) {
    const turn = this.#turn
    if (turn === null || turn.finished) return
    turn.finished = true
    if (turn.timer !== undefined) clearTimeout(turn.timer)
    if (turn.settleTimer !== null) clearTimeout(turn.settleTimer)
    this.#turn = null
    turn.reject(error)
  }
}

/**
 * Owns every conversation and the buffer of spare session ids.
 */
export class ConversationPool {
  #config
  #runtime
  #conversations = new Map()
  #bySession = new Map()
  #spare = []
  #spareCount = 0
  #renewals = 0
  #onLog

  /**
   * @param {Record<string, any>} config - resolved bridge configuration.
   * @param {import('./dsh-runtime.mjs').DshRuntime} runtime - the booted runtime.
   * @param {{ onLog?: (note: string) => void }} [options]
   */
  constructor(config, runtime, options = {}) {
    this.#config = config
    this.#runtime = runtime
    this.#onLog = options.onLog
    runtime.on('down', (error) => {
      for (const conversation of this.#conversations.values()) conversation.abort(error)
    })
  }

  get runtime() {
    return this.#runtime
  }

  get maxSessionChars() {
    return this.#config.chat.maxSessionChars
  }

  get maxInboundChars() {
    return this.#config.chat.maxInboundChars
  }

  get turnTimeoutMs() {
    return this.#config.dsh.turnTimeoutMs
  }

  /** @returns {number} how many fresh sessions have been started. */
  get renewals() {
    return this.#renewals
  }

  /** @returns {number} live conversations (not spare sessions). */
  get size() {
    return this.#conversations.size
  }

  /** Boot the runtime and fill the spare-session buffer. Call once at startup. */
  async start() {
    await this.#runtime.start()
    this.#runtime.on('notification', (method, params) => this.#fanout(method, params))
    await this.#fillSpare()
  }

  #fanout(method, params) {
    // Route by session id: notifications can arrive before a conversation has
    // finished binding its session, and a session never belongs to two chats.
    const bound = params?.sessionId === undefined ? undefined : this.#bySession.get(params.sessionId)
    if (bound !== undefined) {
      bound.handleNotification(method, params)
      return
    }
    for (const conversation of this.#conversations.values()) {
      if (conversation.handleNotification(method, params)) return
    }
  }

  /** Top the spare-session buffer back up to `chat.prewarmCount`. */
  async #fillSpare() {
    const target = this.#config.chat.prewarmCount
    while (this.#spare.length + this.#spareCount < target) {
      this.#spareCount += 1
      this.#createSession().then(
        (session) => {
          this.#spareCount -= 1
          this.#spare.push(session)
          log.debug(`spare session ready (${this.#spare.length} available)`)
        },
        (error) => {
          this.#spareCount -= 1
          log.warn('could not prepare a spare session:', error instanceof Error ? error.message : error)
        },
      )
    }
  }

  /** Mint one unused session id. */
  async #createSession() {
    // The runtime creates a session lazily on its first prompt, so a spare is
    // only an id — deliberately *not* primed with a throwaway model call: that
    // would cost tokens and leave a stray reply in the very history the model
    // reads on the user's first real turn.
    this.#renewals += 1
    return { id: `wx_${randomBytes(9).toString('hex')}`, chars: 0 }
  }

  /** Take one session from the pool, creating one if the pool is empty. */
  async checkout() {
    const session = this.#spare.shift()
    this.#fillSpare()
    if (session !== undefined) return session
    return this.#createSession()
  }

  /** Retire a full session (the runtime has no per-session close method). */
  invalidate(session) {
    if (session === null || session === undefined) return
    this.#bySession.delete(session.id)
    this.#onLog?.(`sessions started: ${this.#renewals}, retired: ${session.id}`)
  }

  /**
   * Register which conversation owns a session.
   * @param {string} sessionId - the session id.
   * @param {Conversation} conversation - its owning conversation.
   */
  bindSession(sessionId, conversation) {
    this.#bySession.set(sessionId, conversation)
  }

  /**
   * Find the conversation that owns a session.
   * @param {string} sessionId - the session id.
   * @returns {Conversation | undefined} the owner, when one is bound.
   */
  conversationForSession(sessionId) {
    return this.#bySession.get(sessionId)
  }

  /**
   * Does this conversation have a session yet?
   *
   * A message can be accepted before its session exists (the pool binds one
   * asynchronously), and a caller that wants to know "is it queued yet?" has to
   * wait for both.
   *
   * @param {string} key - the conversation key.
   * @returns {boolean} whether the conversation has a bound session.
   */
  isBound(key) {
    const conversation = this.#conversations.get(key)
    return conversation !== undefined && conversation.sessionId !== null
  }

  /**
   * Get or create the conversation for one chat key.
   * @param {string} key - stable chat key, e.g. `private:12345`.
   * @param {'private'|'group'|'web'} [kind] - chat kind.
   * @returns {Conversation} the conversation.
   */
  conversation(key, kind = 'private') {
    let conversation = this.#conversations.get(key)
    if (conversation === undefined) {
      conversation = new Conversation(this, key, kind)
      this.#conversations.set(key, conversation)
    }
    return conversation
  }

  /** Reset one conversation: the next message starts from an empty context. */
  resetConversation(key) {
    const conversation = this.#conversations.get(key)
    if (conversation !== undefined) {
      const sessionId = conversation.sessionId
      if (sessionId !== null) this.#bySession.delete(sessionId)
    }
    return this.#conversations.delete(key)
  }
}
