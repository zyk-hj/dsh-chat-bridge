/**
 * Chat gateway — everything between "a chat message arrived" and "the agent
 * answered", independent of which transport delivered it.
 *
 * Both the OneBot adapter and the local browser test page feed normalized
 * inbound messages into this one gateway, so the test page exercises exactly
 * the code path a real QQ/WeChat message takes.
 *
 * Responsibilities: OneBot event → text, command handling, allowlists,
 * group-mention policy, per-chat serialization, typing feedback, chunked
 * replies, and per-group failure budgets.
 */

import { createLogger, chunkText, decodeCqEntities, encodeCqText, clampText, oneLine } from './util.mjs'

const log = createLogger('gateway')

/** CQ codes that carry no text but are worth telling the model about. */
const CQ_LABELS = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  bface: '[表情]',
  sface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  rps: '[猜拳]',
  dice: '[骰子]',
  shake: '[窗口抖动]',
  poke: '[戳一戳]',
  music: '[音乐]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  forward: '[合并转发]',
  node: '[合并转发]',
  markdown: '[卡片消息]',
}

/** Parse a CQ code parameter string (`k=v,k=v`) into an object. */
function parseCqParams(body) {
  const params = {}
  for (const pair of String(body).split(',')) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    params[pair.slice(0, index)] = decodeCqEntities(pair.slice(index + 1))
  }
  return params
}

/**
 * Turn one OneBot segment into display text for the model.
 * @param {{ type: string, data?: Record<string, any> }} segment - OneBot message segment.
 * @returns {string} text (possibly empty).
 */
export function segmentToText(segment) {
  const type = String(segment?.type ?? 'text')
  const data = segment?.data ?? {}
  switch (type) {
    case 'text':
      return decodeCqEntities(data.text ?? '')
    case 'at': {
      const target = String(data.qq ?? '')
      if (target === 'all') return '@全体成员'
      return `@${data.name ?? target}`
    }
    case 'file':
      return `[文件: ${data.name ?? data.file ?? '未知'}]`
    default:
      return CQ_LABELS[type] ?? `[${type}]`
  }
}

/**
 * Extract model-readable text from a OneBot message, whether the bot reported
 * an array of segments or a raw CQ-coded string.
 * @param {{ message?: any, raw_message?: string }} event - the OneBot event.
 * @returns {string} normalized text, with `@bot` mentions preserved as `@bot`.
 */
export function extractInboundText(event) {
  const segments = Array.isArray(event?.message) ? event.message : null
  if (segments !== null) {
    return segments
      .map((segment) => segmentToText(segment))
      .join('')
      .trim()
  }
  let text = decodeCqEntities(event?.raw_message ?? '')
  text = text.replace(/\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g, (_match, type, body) => {
    const params = parseCqParams(body.replace(/^,/, ''))
    if (type === 'at') return params.qq === 'all' ? '@全体成员' : `@${params.name ?? params.qq ?? ''}`
    if (type === 'file') return `[文件: ${params.name ?? params.file ?? '未知'}]`
    return CQ_LABELS[type] ?? `[${type}]`
  })
  return text.trim()
}

/** @returns {boolean} whether this message @-mentions the bot itself. */
function mentionsSelf(event, selfId) {
  const segments = Array.isArray(event?.message) ? event.message : null
  if (segments !== null) {
    return segments.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === String(selfId))
  }
  return new RegExp(`\\[CQ:at,[^\\]]*qq=${selfId}(?:,[^\\]]*)?\\]`).test(String(event?.raw_message ?? ''))
}

/**
 * The contract every chat transport implements, so the gateway never has to know
 * whether it is talking to OneBot or to WeChat's desktop client.
 *
 * @typedef {object} ChatTransport
 * @property {string} transportLabel - short human label for status output.
 * @property {boolean} connected - whether outbound sends can succeed right now.
 * @property {(target: { kind: 'private'|'group', peerId: number|string, segments: Array<Record<string, any>> }) => Promise<any>} send - deliver one message.
 * @property {(target: { kind: 'private'|'group', peerId: number|string }, status?: boolean) => Promise<void>} [setTyping] - optional typing indicator.
 * @property {number} [maxReplyChars] - how much this transport will deliver in ONE message; omit for "no cap".
 * @property {() => Promise<void>} stop - release sockets and child processes.
 */

/**
 * Fit a reply into a single message, telling the reader what was left out.
 *
 * Used for transports that declare `maxReplyChars` — iLink is why this exists:
 * sending an answer as several messages in a row, or as one enormous one, can be
 * dropped at the user-visible layer while the API still reports success
 * (openclaw#79293, P1 message-loss). Truncating in the open is the lesser evil;
 * a silent loss cannot be detected from this side at all.
 *
 * The cut prefers the same paragraph/sentence boundaries the chunker uses, so a
 * capped reply still ends somewhere sensible rather than mid-word.
 *
 * @param {string} text - the full reply.
 * @param {number} limit - maximum characters for the single message.
 * @returns {{ text: string, omitted: number }} the message to send, and how many characters were left out.
 */
export function singlePartReply(text, limit) {
  // Normalise newlines exactly as the chunker does, so the two paths cannot
  // disagree about what a "line" is just because one of them ran.
  const full = String(text ?? '').replaceAll('\r\n', '\n').trim()
  const budget = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : Infinity
  if (full === '' || full.length <= budget) return { text: full, omitted: 0 }
  const pieces = chunkText(full, budget)
  // `chunkText` has a 200-character floor of its own, so a tiny budget can still
  // come back with a longer piece: cut it again rather than overrun the cap.
  let head = pieces[0] ?? full.slice(0, budget)
  if (head.length > budget) head = head.slice(0, budget).trimEnd()
  const omitted = full.length - head.length
  return { text: `${head}\n\n…（后续约 ${omitted} 字因单条长度限制已省略）`, omitted }
}

/**
 * The key one conversation is stored under. Transports that push events use this
 * to ask about a chat before the gateway has seen it.
 *
 * @param {'private'|'group'|'web'} chatKind - the chat kind.
 * @param {string|number} chatId - the chat id.
 * @param {string|number} [senderId] - the sender; private chats are keyed by it.
 * @returns {string} the conversation key.
 */
export function chatKeyOf(chatKind, chatId, senderId) {
  if (chatKind === 'web') return `web:${chatId}`
  if (chatKind === 'group') return `group:${chatId}`
  return `private:${senderId ?? chatId}`
}

/** The shape every transport hands to the gateway. */
export class ChatGateway {  #config
  #pool
  #transport = null
  #busy = new Set()
  #groupErrors = new Map()
  #groupMutedUntil = new Map()
  #observers
  #webSink = null

  /**
   * @param {Record<string, any>} config - resolved bridge configuration.
   * @param {import('./conversation.mjs').ConversationPool} pool - conversation/session pool.
   * @param {{ onInbound?: (note: string) => void, onOutbound?: (note: string) => void }} [options]
   */
  constructor(config, pool, options = {}) {
    this.#config = config
    this.#pool = pool
    this.#observers = { inbound: options.onInbound, outbound: options.onOutbound }
  }

  /** @returns {string} a short status line for `/status`. */
  statusLine() {
    return (
      `桥接状态：${this.#transport === null ? '仅本地测试' : this.#transport.transportLabel}` +
      `｜会话数 ${this.#pool.size}｜已开会话 ${this.#pool.renewals}`
    )
  }

  /**
   * Install the outbound transport. Replacing one is how a rebuild swaps
   * transports without recreating the gateway.
   * @param {ChatTransport | null} transport - the transport, or null to detach.
   */
  setTransport(transport) {
    this.#transport = transport
  }

  /** @returns {ChatTransport | null} the installed transport. */
  get transport() {
    return this.#transport
  }

  /**
   * Wait until the gateway has accepted a message for one conversation.
   *
   * A transport that pushes events wants to know its message was taken without
   * waiting for the answer, which can be minutes away. The busy flag is set the
   * moment the message is accepted, so it is the signal to watch.
   *
   * @param {'private'|'group'|'web'} chatKind - the chat kind.
   * @param {string|number} chatId - the chat id (peer id for private chats).
   * @param {string} [senderId] - the sender, which private chats are keyed by.
   * @param {number} [timeoutMs] - how long to wait before giving up.
   * @returns {Promise<boolean>} whether the message was observed as accepted.
   */
  async waitUntilBusy(chatKind, chatId, senderId, timeoutMs = 5000) {
    const key = chatKeyOf(chatKind, chatId, senderId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Two things must be true before the message is really in flight: the
      // gateway has taken it, and its conversation has a session to queue it on.
      if (this.#busy.has(key) && this.#pool.isBound(key)) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }

  /**
   * Attach the OneBot transport (optional — the test page works without it).
   * @param {import('./onebot.mjs').OneBotClient} client - the connected client.
   */
  attachOneBot(client) {
    this.setTransport(client)
    client.on('event', (event) => {
      void this.handleOneBotEvent(event)
    })
  }

  /**
   * Entry point for OneBot events.
   * @param {any} event - the raw OneBot V11 event.
   */
  async handleOneBotEvent(event) {
    if (event?.post_type !== 'message') return
    if (event.sub_type === 'anonymous') return
    const messageType = event.message_type
    if (messageType !== 'private' && messageType !== 'group') return

    const selfId = String(event.self_id ?? '')
    const atSelf = messageType === 'group' ? mentionsSelf(event, selfId) : true
    const text = extractInboundText(event)
    const senderName = String(event.sender?.card ?? '') || String(event.sender?.nickname ?? '') || String(event.user_id ?? '')
    // Drop only the mention of the bot itself; other people's @ stay readable,
    // and the rest of the line keeps its shape.
    const cleaned = text
      .replace(/@(全体成员|机器人|Bot|bot)\b/g, ' ')
      .replace(new RegExp(`@${String(event.self_id ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()

    await this.handleInbound({
      chatKind: messageType,
      chatId: messageType === 'group' ? event.group_id : event.user_id,
      senderId: event.user_id,
      senderName,
      text: cleaned === '' ? text : cleaned,
      atSelf,
      raw: event,
      messageId: event.message_id,
    })
  }

  /**
   * The single entry point every transport uses.
   * @param {{
   *   chatKind: 'private'|'group'|'web',
   *   chatId: number|string,
   *   senderId: number|string,
   *   senderName?: string,
   *   text: string,
   *   atSelf?: boolean,
   *   raw?: any,
   *   messageId?: number|string,
   *   attachments?: Array<{ type: 'image', data: string, mimeType: string }>,
   * }} inbound - normalized inbound message.
   */
  async handleInbound(inbound) {
    const chatKind = inbound.chatKind
    const chatId = String(inbound.chatId ?? 'local')
    const senderId = String(inbound.senderId ?? chatId)
    const text = clampText(String(inbound.text ?? '').trim(), this.#config.chat.maxInboundChars)
    const attachments = Array.isArray(inbound.attachments) ? inbound.attachments : []
    // An image-only message is legitimate, so emptiness is judged on both parts.
    if (text === '' && attachments.length === 0) return

    const groupAllowed = chatKind !== 'group' || this.#groupAllowed(chatId)
    const chatKey = chatKeyOf(chatKind, chatId, senderId)
    this.#observers.inbound?.(
      `${chatKey} ${inbound.senderName ?? senderId}: ${oneLine(text)}${
        attachments.length === 0 ? '' : `（+${attachments.length} 张图片）`
      }`,
    )

    if (text.startsWith('/') && attachments.length === 0) {
      const reply = await this.#handleCommand(text, chatKey)
      if (reply !== null) await this.#deliver(inbound, reply)
      return
    }

    if (!groupAllowed) {
      log.debug(`ignoring a message in a group outside the allowlist: ${chatId}`)
      return
    }
    if (this.#config.chat.allowedUsers !== null && chatKind === 'private') {
      if (!this.#config.chat.allowedUsers.map(String).includes(senderId)) {
        log.debug(`ignoring a private message from a user outside the allowlist: ${senderId}`)
        return
      }
    }
    if (chatKind === 'group' && this.#config.chat.requireAtInGroup && inbound.atSelf !== true) return
    if (chatKind === 'group' && this.#isMuted(chatId)) {
      log.debug(`group ${chatId} is cooling down after repeated failures; staying silent`)
      return
    }

    const conversation = this.#pool.conversation(chatKey, chatKind === 'web' ? 'web' : chatKind)
    const busy = this.#busy.has(chatKey)
    if (!busy) {
      this.#busy.add(chatKey)
      if (this.#config.chat.ackOnBusy) await this.#deliver(inbound, '🤔 收到，正在处理…', { transient: true })
    }

    const onProgress = (note) => {
      this.#observers.outbound?.(`${chatKey} progress: ${note}`)
    }

    try {
      const reply = await conversation.send({
        text,
        speaker: chatKind === 'group' ? String(inbound.senderName ?? senderId) : undefined,
        onProgress,
        attachments,
      })
      const answer = reply.trim() === '' ? '（这一轮没有产生文字回复）' : reply.trim()
      await this.#deliver(inbound, answer)
      this.#groupErrors.delete(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`turn failed for ${chatKey}: ${message}`)
      await this.#deliver(inbound, `⚠️ 出错了：${oneLine(message).slice(0, 300)}`, { transient: true })
      if (chatKind === 'group') {
        const failures = (this.#groupErrors.get(chatId) ?? 0) + 1
        this.#groupErrors.set(chatId, failures)
        // A group that keeps failing (model outage, revoked key) would otherwise
        // spam every @ with an apology; go quiet for a while instead.
        if (failures >= this.#config.chat.groupErrorBudget) {
          this.#groupErrors.set(chatId, 0)
          this.#groupMutedUntil.set(chatId, Date.now() + this.#config.chat.groupCooldownMs)
          log.warn(
            `group ${chatId} muted for ${Math.round(this.#config.chat.groupCooldownMs / 1000)}s after ${failures} consecutive failures`,
          )
        }
      }
    } finally {
      this.#busy.delete(chatKey)
    }
  }

  #groupAllowed(groupId) {
    const allow = this.#config.chat.allowedGroups
    if (allow === null) return true
    return allow.map(String).includes(String(groupId))
  }

  /** @returns {boolean} whether a group is cooling down after repeated failures. */
  #isMuted(groupId) {
    const until = this.#groupMutedUntil.get(groupId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.#groupMutedUntil.delete(groupId)
      return false
    }
    return true
  }

  async #handleCommand(text, chatKey) {
    const [command, ...rest] = text.slice(1).split(/\s+/)
    const name = command.toLowerCase()
    switch (name) {
      case 'new':
      case 'reset':
        this.#pool.resetConversation(chatKey)
        return '✅ 已开始新会话，之前的上下文已清空。'
      case 'status':
      case '状态':
        return this.statusLine()
      case 'ping':
        return 'pong'
      case 'help':
      case '帮助':
        return [
          '可用命令：',
          '/new — 清空上下文，开始新会话',
          '/status — 查看桥接状态',
          '/ping — 连通性测试',
          '/say <内容> — 原样发回（调试用）',
          '',
          '直接发消息即可与我对话。',
        ].join('\n')
      case 'say':
        return rest.join(' ') || '（空）'
      default:
        return `未知命令：/${name}。发送 /help 查看可用命令。`
    }
  }

  /**
   * Send one reply, chunked to the platform's limit and split at paragraph
   * boundaries — unless the transport says it cannot be sent to twice in a row.
   *
   * The transport receives OneBot-shaped segments because that is the richest
   * common vocabulary; a transport without that vocabulary (WeChat's desktop
   * client) reads the text out of the segments and ignores the rest.
   *
   * `transport.maxReplyChars`, when it is a finite number, is the most that
   * transport will deliver in ONE message: the reply is then sent once, cut at a
   * boundary and marked as cut, because sending several parts back-to-back is
   * what silently loses messages on iLink (openclaw#79293). A transport without
   * the property — OneBot/QQ, and everything written before it existed — takes the
   * old chunking path unchanged.
   *
   * @param {any} inbound - the message being answered.
   * @param {string} markdown - the reply text.
   * @param {{ transient?: boolean }} [options] - `transient` marks an acknowledgement.
   */
  async #deliver(inbound, markdown, options = {}) {
    const transport = this.#transport
    // The local test page renders whatever it is handed and never talks to a chat
    // platform, so platform caps do not apply to it.
    const inChat = inbound.chatKind !== 'web'
    // `?? Infinity` is load-bearing: a transport that does not declare the
    // property must keep the previous behaviour exactly.
    const declared = Number(transport?.maxReplyChars ?? Infinity)
    const transportLimit = inChat && Number.isFinite(declared) && declared > 0 ? declared : Infinity
    const limit = Math.min(this.#config.chat.maxReplyChars, transportLimit)
    let chunks
    if (transportLimit !== Infinity) {
      const single = singlePartReply(markdown, limit)
      chunks = single.text === '' ? [] : [single.text]
      if (single.omitted > 0) {
        // Never drop content quietly: the reader is told in the message itself,
        // and the operator gets the numbers here.
        log.warn(
          `回复超过单条上限 ${limit} 字：已截断后一次发出（省略约 ${single.omitted} 字），` +
            '不切块连发——多次连续发送在 iLink 上会静默丢消息（openclaw#79293）',
        )
      }
    } else {
      chunks = chunkText(markdown, limit)
      if (chunks.length > 1) log.debug(`回复超过 ${limit} 字：分 ${chunks.length} 条发送`)
    }
    if (chunks.length === 0) {
      // Ending here silently is how "the model had nothing to say" becomes
      // indistinguishable from "the reply was dropped on the floor" — the operator
      // sees a turn finish and then nothing at all, with no line explaining which
      // happened. A real report of exactly that silence is why this logs now.
      log.warn(`没有可发送的内容（${inbound.chatKind}:${inbound.chatId}），本轮不产生任何出站消息`)
      return
    }
    this.#observers.outbound?.(`${inbound.chatKind}:${inbound.chatId} ← ${oneLine(chunks[0])}`)
    if (inbound.chatKind === 'web') {
      await this.#webSink?.(inbound, chunks, options)
      return
    }
    if (transport === null) {
      log.warn('没有可用的聊天传输，出站消息被丢弃')
      return
    }
    const target = { kind: inbound.chatKind, peerId: inbound.chatId }
    if (this.#config.chat.typingIndicator && !options.transient && typeof transport.setTyping === 'function') {
      await transport.setTyping(target, false)
    }
    for (const [index, chunk] of chunks.entries()) {
      const segments = []
      if (index === 0 && this.#config.chat.replyToMessage && inbound.messageId !== undefined) {
        segments.push({ type: 'reply', data: { id: String(inbound.messageId) } })
      }
      if (index === 0 && inbound.chatKind === 'group' && this.#config.chat.replyAtInGroup) {
        segments.push({ type: 'at', data: { qq: String(inbound.senderId) } })
        segments.push({ type: 'text', data: { text: ' ' } })
      }
      segments.push({ type: 'text', data: { text: this.#encodeText(transport, chunk) } })
      try {
        await transport.send({ ...target, segments })
      } catch (error) {
        log.error(`回复分片发送失败：${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * Escape reply text the way the installed transport needs.
   * OneBot reads CQ codes inside text, so brackets and ampersands must be
   * escaped; a transport that sends plain text must not receive those escapes.
   * @param {ChatTransport} transport - the installed transport.
   * @param {string} text - the reply chunk.
   * @returns {string} text safe for that transport.
   */
  #encodeText(transport, text) {
    return transport.escapesCqCodes === true ? encodeCqText(text) : text
  }

  /**
   * Install the sink used for `chatKind: 'web'` replies (the test page).
   * @param {(inbound: any, chunks: string[], options: any) => Promise<void>|void} sink
   */
  setWebSink(sink) {
    this.#webSink = sink
  }

  /** Enable or disable the "received, working on it" acknowledgement. */
  setAck(enabled) {
    this.#config.chat.ackOnBusy = enabled
  }
}
