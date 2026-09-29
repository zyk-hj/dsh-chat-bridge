/**
 * WeChat adapter — wires the two halves of the WeChat route into the gateway.
 *
 *   inbound:  WeChat ⇄ iLink Bot (official API)  →  this adapter  →  ChatGateway
 *   outbound: ChatGateway  →  this adapter  →  WeChat via the configured strategy
 *
 * Everything here goes through WeChat's own iLink Bot API, so both directions are
 * ordinary HTTP: receiving is a long poll and sending is a POST. The three earlier
 * routes (DLL injection, UI Automation, simulated input) were removed after being
 * measured on a real machine — see `defaultConfig()` in `config.mjs` for what each
 * one failed on.
 *
 * Three WeChat-specific things this adapter still owns:
 *
 *  - **Group @-mentions.** WeChat has no mention flag, so "was the bot
 *    addressed?" is answered by looking for the bot's nickname in the text. iLink
 *    bots are direct-message only, so this only matters on the webhook route.
 *  - **Images.** People send screenshots constantly. Whatever the provider can
 *    reach travels inline in the event and is handed to the agent as attachment
 *    blocks, so the model can actually see them.
 *  - **One message per reply.** iLink loses long or back-to-back sends without
 *    saying so (openclaw#79293), which is why this adapter declares
 *    {@link WeChatAdapter.maxReplyChars} and lets the gateway fit the answer into
 *    a single message instead of chunking it.
 */

import { EventEmitter } from 'node:events'
import { createLogger, oneLine } from './util.mjs'
import { createSender } from './wechat-outbound.mjs'
import { WeChatWebhook } from './wechat-webhook.mjs'
import { ILINK_MAX_REPLY_CHARS, IlinkBridge, extractFileMarkers } from './wechat-ilink.mjs'

const log = createLogger('wechat')

/** How the providers mark a non-text message inside `content`. */
const PLACEHOLDER = {
  image: /^\[(图片|照片)\]$/,
  voice: /^\[(语音|音频)\]$/,
  video: /^\[(视频)\]$/,
  file: /^\[(文件|传输文件)\]$/,
  emoji: /^\[(表情|动画表情)\]$/,
  link: /^\[(链接|图文链接)\]$/,
  location: /^\[(位置|位置共享)\]$/,
  card: /^\[(名片|个人名片)\]$/,
  transfer: /^\[(转账|微信红包|红包)\]$/,
  system: /^\[(系统消息|撤回消息|拍一拍|群公告)\]$/,
}

/**
 * Classify a message body.
 * @param {string} content - the message's display text.
 * @returns {string} one of the PLACEHOLDER keys, or `text`.
 */
export function classifyContent(content) {
  const text = String(content ?? '').trim()
  if (text === '') return 'text'
  for (const [kind, pattern] of Object.entries(PLACEHOLDER)) {
    if (pattern.test(text)) return kind
  }
  return 'text'
}

/**
 * Does this message address the bot by name?
 * WeChat exposes no mention metadata, so the nickname is the only signal.
 * @param {string} content - the message text.
 * @param {string[]} nicknames - the bot's own display names.
 * @returns {boolean} whether the bot was addressed.
 */
export function mentionsBot(content, nicknames) {
  const text = String(content ?? '')
  return nicknames.some((nickname) => nickname !== '' && text.includes(nickname))
}

/**
 * Remove the bot's own nickname from a message so the agent does not read it as
 * part of the sentence.
 * @param {string} content - the message text.
 * @param {string[]} nicknames - the bot's own display names.
 * @returns {string} cleaned text.
 */
export function stripBotMention(content, nicknames) {
  let text = String(content ?? '')
  for (const nickname of nicknames) {
    if (nickname === '') continue
    text = text.split(`@${nickname}`).join(' ')
    text = text.split(nickname).join(' ')
  }
  return text.replace(/[ \t]{2,}/g, ' ').trim()
}

/** Map a MIME type onto the attachment block types the SDK accepts. */
function attachmentType(contentType) {
  const type = String(contentType).split(';')[0].trim().toLowerCase()
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/gif') return type
  // WeChat sends screenshots as PNG and photos as JPEG; anything else is safest
  // presented as PNG only if it really is one, otherwise skip the attachment.
  return null
}

export class WeChatAdapter extends EventEmitter {
  #config
  #gateway
  #runtime
  /** The configured inbound provider: the iLink bridge or the webhook listener. */
  #inbound
  /** The iLink bridge, when that provider is in use; also serves outbound sends. */
  #ilink = null
  #sender
  #seen = new Set()
  #recentOrder = []
  #connected = false

  /**
   * @param {Record<string, any>} config - resolved bridge configuration.
   * @param {import('./chat-gateway.mjs').ChatGateway} gateway - the shared gateway.
   * @param {import('./dsh-runtime.mjs').DshRuntime} runtime - for attachment admission.
   * @param {{ ilink?: any }} [providers] - test seams: an iLink bridge override, so
   *   the provider logic can be exercised against a stub gateway.
   */
  constructor(config, gateway, runtime, providers = {}) {
    super()
    this.#config = config
    this.#gateway = gateway
    this.#runtime = runtime
    // Both halves are pluggable: which tool delivers messages in, and which
    // method sends replies out, are independent choices.
    const inbound = String(config.wechat.inbound)
    if (inbound === 'ilink') {
      this.#ilink = new IlinkBridge(config, providers.ilink ?? {})
      this.#inbound = this.#ilink
    } else this.#inbound = new WeChatWebhook(config)
    this.#sender = createSender(config, this.#ilink)
  }

  /** The contract `ChatGateway` expects from a transport. */
  get transportLabel() {
    const inbound = String(this.#config.wechat.inbound)
    if (inbound === 'none') return `wechat(只发不收·${this.#sender.strategy})`
    const state = this.#connected ? '已连接' : '未连接'
    const out = this.#config.wechat.sendEnabled === true ? this.#sender.strategy : '只收不回'
    return `wechat(${inbound}·${state}·${out})`
  }

  /**
   * How much this transport will deliver in ONE message.
   *
   * The gateway reads this to decide between chunking a long answer and fitting
   * it into a single message. iLink has to be the second kind: sending a reply as
   * several messages back-to-back — or as one very long one — can fail at the
   * user-visible layer while the API still answers `ret=0`, so the user gets
   * nothing and the bridge logs success (openclaw#79293, P1 message-loss). A
   * single, phone-screen-sized message is the only shape that report does not
   * blame, hence {@link ILINK_MAX_REPLY_CHARS}.
   *
   * Every other outbound route keeps `Infinity`, which is what makes the gateway
   * behave exactly as it did before this property existed: `command` / `http`
   * senders are the operator's own tool and QQ has a chunked protocol of its own.
   *
   * @returns {number} the per-message character budget, or Infinity for "no cap".
   */
  get maxReplyChars() {
    return this.#sender.strategy === 'ilink' ? ILINK_MAX_REPLY_CHARS : Infinity
  }

  /** @returns {boolean} whether inbound messages are flowing. */
  get connected() {
    return this.#connected
  }

  /**
   * The inbound provider, exposed for diagnostics and tests (e.g. to watch raw
   * frames or probe the webhook's health).
   * @returns {import('./wechat-ilink.mjs').IlinkBridge | WeChatWebhook} the provider.
   */
  get inbound() {
    return this.#inbound
  }

  /** @returns {boolean} whether outbound sending is configured. */
  get #senderEnabled() {
    return this.#config.wechat.sendEnabled === true
  }

  /**
   * Attach to the gateway and start receiving.
   * @returns {Promise<void>} resolves once inbound is ready.
   */
  async start() {
    this.#gateway.setTransport(this)
    // The listener must not return a promise the emitter waits on: a turn can run
    // for minutes, and holding the callback would stall the inbound read loop
    // behind it. Dispatch in the background and surface failures explicitly.
    this.#inbound.on('event', (event) => {
      void this.dispatch(event)
    })
    this.#inbound.on('connected', () => {
      this.#connected = true
    })
    this.#inbound.on('disconnected', () => {
      this.#connected = false
    })
    const provider = String(this.#config.wechat.inbound)
    if (provider === 'none') {
      log.info('微信入站已关闭（wechat.inbound=none）：只会发送，不接收')
      return
    }
    if (provider === 'ilink') {
      await this.#inbound.start()
      // A missing or expired token is a normal state, not a crash: the console
      // shows a scan-to-login button and the rest of the bridge keeps working.
      if (this.#inbound.loggedIn !== true) {
        log.warn('iLink 未登录：请在控制台「微信」页点「扫码登录」，或运行 node src/index.mjs --ilink-login')
      }
      this.#connected = this.#inbound.connected === true
      return
    }
    // webhook: we are the server, so "connected" is simply "listening".
    await this.#inbound.start()
    this.#connected = true
  }

  /**
   * Send one reply to WeChat through the configured outbound strategy.
   *
   * The gateway hands over OneBot-shaped segments; WeChat only needs the text,
   * which is also the only thing any of the strategies can deliver reliably.
   *
   * @param {{ kind: 'private'|'group', peerId: string, segments: Array<any> }} target - where to send.
   * @returns {Promise<void>} resolves when the hand-off finished.
   */
  async send(target) {
    const raw = target.segments
      .filter((segment) => segment?.type === 'text')
      .map((segment) => String(segment.data?.text ?? ''))
      .join('')
      .trim()
    if (raw === '') return

    // The agent cannot call the bridge directly, so it asks for an attachment with
    // a marker line in its reply (`[[send-file: <path>]]`) and the bridge turns that
    // into a real upload. Pulling the markers out first means the text the user
    // reads never contains the plumbing.
    const { text, paths } = extractFileMarkers(raw)
    if (raw !== '' && text === '' && paths.length === 0) return
    if (!this.#senderEnabled) {
      log.warn(`微信发送未启用（wechat.sendEnabled=false），已跳过：${oneLine(raw).slice(0, 60)}`)
      return
    }
    const recipient = this.#recipientFor(target)
    if (text !== '') {
      await this.#sendText(target, recipient, text)
    }
    // Text and attachment are two separate gateway messages, which brushes against
    // the constraint that makes this bridge send replies as one message: rapid
    // multi-part sends get dropped silently (openclaw#79293). It is acceptable here
    // for two reasons, and if an attachment ever goes missing while its text
    // arrives, re-examine this order first. (1) The official client sends them the
    // same way, so deviating would be the untested path, and we have no live
    // account to test a combined `item_list` against. (2) Uploading sits between the
    // two sends and takes real time — reading, encrypting and POSTing the file — so
    // this is not the "rapid" burst the constraint describes.
    for (const filePath of paths) {
      await this.#sendOneFile(target, recipient, filePath)
    }
  }

  /**
   * Send one text body, throwing when the sender reports a failure.
   *
   * @param {{ peerId: string }} target - the conversation.
   * @param {string} recipient - the address the strategy uses.
   * @param {string} text - the body.
   * @returns {Promise<void>} resolves once handed off.
   */
  async #sendText(target, recipient, text) {
    // Every surviving strategy addresses the conversation by id, so a display
    // name is a nicety for the operator's logs and for external senders, never a
    // precondition. There is deliberately no "cannot work out who to send to"
    // guard here any more: the removed desktop routes were the only ones that
    // needed a name to type into a search box.
    const result = await this.#sender.send({ recipient, text, peerId: target.peerId })
    if (!result.ok) {
      log.error(`发送失败：${result.detail}`)
      throw new Error(result.detail)
    }
    // `ret=0` means the gateway took the message, not that the phone showed it
    // (openclaw#79293). The log says which of the two happened instead of a bare
    // 「已发送」, which reads like a delivery receipt the bridge cannot issue.
    const accepted = result.delivered === 'unknown' ? '（已受理，送达未确认）' : ''
    log.info(
      `已通过 ${this.#sender.strategy} 发送给「${recipient || target.peerId}」${accepted}：${oneLine(text).slice(0, 60)}`,
    )
  }

  /**
   * Send one attachment, reporting the reason instead of failing the whole reply.
   *
   * An attachment that cannot be read or uploaded must not swallow the answer that
   * already went out, so the failure comes back to the user as a short line.
   *
   * @param {{ peerId: string }} target - the conversation.
   * @param {string} recipient - the address the strategy uses.
   * @param {string} filePath - the file to attach.
   * @returns {Promise<void>} resolves once the attempt finished.
   */
  async #sendOneFile(target, recipient, filePath) {
    if (this.#sender.strategy !== 'ilink') {
      // Only the iLink path can carry a file: `command` and `http` are text-only
      // by contract, so say so rather than silently dropping the attachment.
      const note = `（附件无法发送：当前发送方式是 ${this.#sender.strategy}，只有 ilink 支持发文件）文件位置：${filePath}`
      log.warn(note)
      await this.#sendText(target, recipient, note)
      return
    }
    const result = await this.#sender.sendFile({ filePath, text: '', peerId: target.peerId })
    if (result.ok !== true) {
      log.error(`发送文件失败：${result.detail}`)
      await this.#sendText(target, recipient, `附件发送失败：${result.detail}`)
      return
    }
    // A file that carries its own caption can lose just the caption. The file is
    // the point of the call so it still succeeds, but the text was meant to be
    // read: say so rather than reporting a clean send. (This bridge always sends
    // the text separately, so the branch is for callers that do not.)
    if (String(result.captionFailure ?? '') !== '') {
      log.warn(`文件已发出，但随附说明发送失败：${result.captionFailure}`)
    }
    log.info(`已通过 ilink 发送文件给「${recipient || target.peerId}」：${filePath}`)
  }

  /** @returns {string} which outbound strategy is configured. */
  get sendStrategy() {
    return this.#sender.strategy
  }

  /**
   * Show or clear the "…" typing indicator in WeChat.
   *
   * Only iLink has one: it exposes a native indicator through the gateway, while
   * the desktop-automation routes have no equivalent and are no-ops here. The
   * gateway calls this with `status === false` just before delivering the reply,
   * which is exactly when a recipient expects the indicator to disappear.
   *
   * @param {{ kind: 'private'|'group', peerId: number|string }} target - the conversation.
   * @param {boolean} [status] - the gateway's requested state.
   * @returns {Promise<void>} resolves once the indicator was requested.
   */
  async setTyping(target, status) {
    if (this.#ilink === null || this.#sender.strategy !== 'ilink') return
    const peerId = String(target?.peerId ?? '')
    if (peerId === '') return
    if (status === false) await this.#ilink.clearTyping(peerId)
    else await this.#ilink.setTyping(peerId)
  }

  /**
   * Work out the display name a reply should be labelled with.
   *
   * Purely cosmetic now: iLink addresses the conversation by user id and the
   * external `command` / `http` senders get both the name and the id, so an
   * unmapped chat simply falls back to its id rather than blocking the send. The
   * name is learned from the sender of the first inbound message.
   *
   * @param {{ kind: 'private'|'group', peerId: string }} target - the chat.
   * @returns {string} the display name, or the peer id when nothing is known.
   */
  #recipientFor(target) {
    const map = this.#config.wechat.recipients ?? {}
    const mapped = map[target.peerId]
    if (typeof mapped === 'string' && mapped.trim() !== '') return mapped.trim()
    const remembered = this.#names.get(target.peerId)
    if (remembered !== undefined) return remembered
    return String(target.peerId)
  }

  /** Display names learned from inbound messages, keyed by conversation id. */
  #names = new Map()

  /**
   * Dispatch one event without making the caller wait for the turn it starts.
   *
   * `handleEvent` resolves only when the agent has answered, which is the right
   * contract for a caller that wants the result — but a push-stream listener must
   * not block on it. This wrapper is what the stream uses.
   *
   * @param {IlinkMessageEvent} event - the push payload.
   * @returns {Promise<void>} resolves as soon as the message is queued.
   */
  async dispatch(event) {
    try {
      // `handleEvent` awaits the whole turn; start it and return.
      const running = this.handleEvent(event)
      void running.catch((error) => {
        log.error(`处理微信事件失败：${error instanceof Error ? error.message : error}`)
      })
    } catch (error) {
      log.error(`处理微信事件失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Handle one inbound push event.
   *
   * Resolves once the agent has answered, so it is the entry point for callers
   * that need the outcome; the push stream uses {@link dispatch} instead.
   *
   * @param {IlinkMessageEvent} event - the push payload.
   */
  async handleEvent(event) {
    if (event?.event === 'message.revoke') return
    if (event?.event !== undefined && event.event !== 'message.new') return
    const chatId = String(event.sessionId ?? '')
    if (chatId === '') return
    // The providers recommend de-duplicating on the raw id; the same message can be
    // re-pushed when the stream reconnects.
    const rawId = String(event.rawid ?? '')
    if (rawId !== '' && this.#seen.has(rawId)) return
    if (rawId !== '') {
      this.#seen.add(rawId)
      this.#recentOrder.push(rawId)
      if (this.#recentOrder.length > 500) {
        const oldest = this.#recentOrder.shift()
        if (oldest !== undefined) this.#seen.delete(oldest)
      }
    }

    const isGroup = String(event.sessionType ?? '') === 'group' || chatId.endsWith('@chatroom')
    const kind = isGroup ? 'group' : 'private'
    const senderName = String(event.sourceName ?? '').trim()
    if (kind === 'private' && senderName !== '') this.#names.set(chatId, senderName)
    if (kind === 'group' && event.groupName !== undefined && String(event.groupName).trim() !== '') {
      this.#names.set(chatId, String(event.groupName).trim())
    }

    const nicknames = (this.#config.wechat.botNicknames ?? []).map((name) => String(name))
    const content = String(event.content ?? '')
    if (this.#isOwnMessage(event, senderName, nicknames)) {
      log.debug('忽略自己发出的消息')
      return
    }
    const atSelf = kind === 'private' ? true : mentionsBot(content, nicknames)
    const kindOfContent = classifyContent(content)

    if (kindOfContent === 'system') {
      log.debug(`忽略系统消息：${oneLine(content)}`)
      return
    }

    const cleaned = kind === 'group' ? stripBotMention(content, nicknames) : content
    const attachments = await this.#attachmentsFor(chatId, kindOfContent, event)
    const text = cleaned.trim() === '' && attachments.length === 0 ? `（收到一条 ${kindOfContent} 消息，但取不到内容）` : cleaned
    // Private chats are keyed by the sender; a group is keyed by the group.
    const senderId = kind === 'private' && senderName !== '' ? senderName : chatId

    log.info(
      `收到微信消息 ${kind === 'group' ? `群「${event.groupName ?? chatId}」` : '私聊'} ` +
        `${senderName === '' ? '' : `${senderName}: `}${oneLine(text).slice(0, 80)}`,
    )

    // Show WeChat's native "…" while the agent works. Only iLink has one; the
    // desktop routes are no-ops, so this is safe to call unconditionally. It is
    // deliberately not awaited: a slow indicator must never delay the turn.
    if (this.#config.chat.typingIndicator === true && this.#ilink !== null) {
      void this.#ilink.setTyping(chatId)
    }

    // Hand the message to the gateway without waiting for the answer. The gateway
    // accepts as soon as the message is queued; awaiting it would mean this method
    // resolves only when the agent has finished, minutes later — far too late for
    // a push-stream listener to wait on.
    const queued = this.#gateway.handleInbound({
      chatKind: kind,
      chatId,
      senderId,
      senderName,
      text,
      atSelf,
      attachments,
    })
    queued.catch((error) => {
      log.error(`消息处理失败：${error instanceof Error ? error.message : error}`)
    })
    // Report success only once the message is really in flight, so a caller (and
    // the tests) can rely on it having been accepted.
    await this.#gateway.waitUntilBusy(kind, chatId, senderId)
  }

  /**
   * Is this push the bot's own outgoing message?
   *
   * The push stream reports messages in both directions, and the bot's own replies
   * otherwise be answered again — an infinite loop with the model on the hook.
   * @param {IlinkMessageEvent} event - the push payload.
   * @param {string} senderName - the sender's display name.
   * @param {string[]} nicknames - the bot's own display names.
   * @returns {boolean} whether to ignore the message.
   */
  #isOwnMessage(event, senderName, nicknames) {
    if (event.isSend === true || event.isSend === 1) return true
    return nicknameMatches(senderName, nicknames)
  }

  /**
   * Collect image attachments for one message.
   *
   * iLink delivers images and files as CDN references, and the webhook route's
   * pusher decides what it sends, so for both the bytes have to arrive inline in
   * the event. Failure is always non-fatal — the agent still gets the text.
   *
   * @param {string} talker - the conversation id.
   * @param {string} kind - the classified content kind.
   * @param {import('./wechat-ilink.mjs').IlinkMessageEvent} event - the inbound event.
   * @returns {Promise<Array<{ type: string, data: string, mimeType: string }>>} encoded images.
   */
  async #attachmentsFor(talker, kind, event) {
    if (kind !== 'image') return []
    return this.#inlineAttachments(event)
  }

  /**
   * Use an image the caller embedded in the event.
   *
   * Neither surviving provider can hand over a file path, so the bytes travel
   * inline; this accepts both a base64 string and a data URL.
   *
   * @param {import('./wechat-ilink.mjs').IlinkMessageEvent} event - the inbound event.
   * @returns {Array<{ type: string, data: string, mimeType: string }>} encoded images.
   */
  #inlineAttachments(event) {
    const inline = event?.imageBase64
    if (typeof inline !== 'string' || inline === '') return []
    const match = /^data:([^;]+);base64,(.*)$/s.exec(inline)
    const data = match === null ? inline : match[2]
    const declared = match === null ? (event.imageMimeType ?? 'image/jpeg') : match[1]
    const mimeType = attachmentType(declared)
    if (mimeType === null) {
      log.debug(`跳过不支持的图片类型：${declared}`)
      return []
    }
    return [{ type: 'image', data, mimeType }]
  }

  /** Health snapshot for the console. */
  async status() {
    const provider = String(this.#config.wechat.inbound)
    const base = {
      provider,
      sendEnabled: this.#senderEnabled,
      sendStrategy: this.#sender.strategy,
      lastSend: this.#sender.lastResult(),
    }
    if (provider === 'webhook') {
      return {
        ...base,
        inboundOk: this.#inbound.connected === true,
        inboundDetail: this.#inbound.connected
          ? `监听 http://${this.#config.wechat.webhook.host}:${this.#inbound.port}${this.#config.wechat.webhook.path}`
          : '入站接口未启动',
      }
    }
    if (provider === 'ilink') {
      const probe = await this.#inbound.probe()
      // Receiving and replying have separate health on iLink: the long poll keeps
      // working while the reply credential has expired, and an operator looking at
      // 「已登录」 needs to know that sending still waits for the user to write
      // something (openclaw#52153).
      const credential = probe.credential ?? this.#inbound.sendCredential?.() ?? null
      return {
        ...base,
        inboundOk: probe.ok,
        inboundDetail: probe.detail,
        loggedIn: this.#inbound.loggedIn === true,
        accountPath: this.#inbound.accountPath,
        accountUser: this.#inbound.account?.userId ?? '',
        baseUrl: this.#config.wechat.ilink?.baseUrl ?? '',
        sendCredentialReady: credential?.ready === true,
        sendCredentialState: credential?.state ?? 'unknown',
        sendCredentialDetail: credential?.detail ?? '',
        /** `null` means "no per-message cap"; a number is the single-message budget. */
        replyLimitChars: Number.isFinite(this.maxReplyChars) ? this.maxReplyChars : null,
      }
    }
    return { ...base, inboundOk: false, inboundDetail: '入站已关闭（只发不收）' }
  }

  /** Test the outbound path without sending a real message where possible. */
  async probeSender() {
    return this.#sender.probe()
  }

  /** Stop receiving and release resources. */
  async stop() {
    await this.#inbound.stop()
    this.#connected = false
  }

  /**
   * The iLink bridge, when that is the configured provider.
   *
   * Exposed so the console can drive the QR login against the very same client
   * the running service uses, instead of a second copy holding its own token.
   *
   * @returns {import('./wechat-ilink.mjs').IlinkBridge | null} the bridge.
   */
  get ilink() {
    return this.#ilink
  }
}

/** Compare a sender's display name against the bot's own names. */
function nicknameMatches(senderName, nicknames) {
  const name = String(senderName ?? '').trim()
  if (name === '') return false
  return nicknames.some((nickname) => nickname !== '' && name === nickname)
}
