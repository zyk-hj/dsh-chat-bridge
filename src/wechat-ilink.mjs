/**
 * WeChat iLink Bot provider — WeChat's own bot API.
 *
 * Every other WeChat route in this bridge is a workaround: wcferry injects a DLL
 * into a client build Tencent no longer lets you log into, WeFlow needs a native
 * decryption library, and the 4.x client draws its own UI so there is nothing for
 * UI automation to hold on to. iLink is different — it is the interface WeChat
 * publishes for bots:
 *
 *   GET  /ilink/bot/get_bot_qrcode?bot_type=3   → a QR session id
 *   GET  /ilink/bot/get_qrcode_status?qrcode=…  → scaned / confirmed / expired
 *   POST /ilink/bot/getupdates                  → long-poll for messages
 *   POST /ilink/bot/sendmessage                 → send a reply
 *   POST /ilink/bot/getconfig, /sendtyping      → typing indicator
 *
 * The bot shows up as a normal contact in WeChat: scan the QR once, then chat
 * with the agent from the phone or the desktop client. Direct messages only —
 * iLink bots do not join group chats.
 *
 * Authentication is a bearer token minted by the QR scan, so the credential file
 * is as sensitive as a password. The reply `context_token` is per-conversation
 * and must be echoed back on every send, which is why it is cached per user.
 *
 * Three properties of this API shape everything below, and each one is a failure
 * mode that has already bitten someone in public — they are not defensive
 * guesswork, so do not "simplify" them away:
 *
 *  - **Replying only; never initiating.** A reply needs the `context_token` that
 *    arrived with the user's message, and nothing except another inbound message
 *    refreshes it (openclaw#52153, "proactive sends require contextToken"). Every
 *    community implementation ends up surfacing the same user-facing state,
 *    「凭证过期 → 请在微信里给机器人再发一条消息」, which is why a missing or
 *    expired token is reported here as a normal, user-fixable condition.
 *  - **One message, and not a long one.** Sending an answer as several messages
 *    back-to-back — or as one very long message — can fail at the user-visible
 *    layer while the API still answers `ret=0` (openclaw#79293, P1
 *    message-loss: "Longer messages and/or rapid multi-part sends can fail at the
 *    user-visible layer while OpenClaw still returns success"). The chat gateway
 *    therefore delivers an iLink reply as ONE message, capped by
 *    {@link ILINK_MAX_REPLY_CHARS}, instead of chunking it.
 *  - **`ret=0` is acceptance, not delivery.** It says the gateway took the
 *    message; whether WeChat ever shows it is a different question (same report,
 *    plus a window reported on 腾讯云 2212822 where every downstream message was
 *    silently discarded). Send results therefore carry `accepted: true` and
 *    `delivered: 'unknown'`, and no log line claims more than that.
 */

import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createLogger } from './util.mjs'

const log = createLogger('ilink')

/** Production endpoint. `wechat.ilink.baseUrl` can point somewhere else. */
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Identifies this client as a bot to the iLink gateway. */
export const ILINK_APP_ID = 'bot'

/**
 * Channel version. Sent in the body as `base_info.channel_version`.
 *
 * This is the version we *claim* on the wire. It tracks the official
 * `@tencent-weixin/openclaw-weixin` build whose protocol this client follows,
 * so it is also what the `iLink-App-ClientVersion` header packs. Claiming the
 * version of a build old enough to predate a protocol change is its own bug:
 * the server routes on these two headers (see CHANGELOG 2.4.3, where shipping
 * them empty in production broke the login handshake).
 */
export const ILINK_PROTOCOL_VERSION = '2.4.9'

/**
 * `bot_type` for the ClawBot / iLink login QR. Official default, unchanged
 * across every published version of the plugin.
 */
export const ILINK_BOT_TYPE = '3'

/** How long the gateway holds a `get_qrcode_status` long-poll open. */
export const QR_STATUS_TIMEOUT_MS = 35000

/**
 * How long a `context_token` is trusted after the message that carried it.
 *
 * iLink bots can only reply, and the token that authorises a reply is minted
 * with the user's message: nothing but another inbound message refreshes it
 * (openclaw#52153, "proactive sends require contextToken"). The gateway has never
 * published the server-side lifetime, so this is a *client-side* bookkeeping
 * value and both directions of error cost something real:
 *
 *  - too long, and we hand the gateway a token it has already dropped, which is
 *    precisely the silent failure of openclaw#79293 — `ret=0` and nothing on the
 *    phone;
 *  - too short, and we refuse to answer a conversation the server would still
 *    have accepted.
 *
 * 24 hours: WeChat's own customer-service style reply window after a user
 * message is 48 hours (公众号客服消息), and iLink is the same "reply soon after
 * they wrote to you" model, so a day sits comfortably inside any plausible
 * server window while covering a full working day of back-and-forth. It is
 * overridable as `wechat.ilink.contextTokenTtlMs` for anyone who measures the
 * real value.
 */
export const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How much of one reply iLink is trusted to deliver as a single message.
 *
 * openclaw#79293 (P1, message-loss) reports that on WeChat "longer messages
 * and/or rapid multi-part sends can fail at the user-visible layer while OpenClaw
 * still returns success", and the chat gateway used to answer a long reply by
 * sending several chunks back-to-back — exactly the pattern that report blames.
 * `ret=0` cannot tell us it failed, so the only safe design is to send once and
 * make it fit.
 *
 * 900 characters: a phone screen shows roughly 500–900 CJK characters (or about
 * 1800 latin ones) before it starts scrolling, and the public reports do not say
 * where the server's own limit is. 900 is the top of the "one screen" band and
 * still leaves room for the truncation notice and the message envelope, so a
 * delivered reply stays under ~1000 characters even when it is cut.
 */
export const ILINK_MAX_REPLY_CHARS = 900

/**
 * What a successful send is allowed to claim.
 *
 * `ret=0` means the gateway took the message; whether WeChat ever shows it is a
 * different question (openclaw#79293, 腾讯云 2212822), so every send path reports
 * acceptance and says so out loud. One string, used by both the text and the media
 * sender, because two spellings of the same caveat is how one of them ends up
 * overstating what happened.
 */
const ILINK_ACCEPTED_DETAIL = 'iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理'

/**
 * The media CDN the protocol uses, in *both* directions.
 *
 * iLink never inlines bytes: `image_item` / `file_item` carry an
 * `encrypted_query_param` plus an AES key, and the bytes themselves live on this
 * CDN. Both halves hang off one base — `<base>/download` to fetch, `<base>/upload`
 * to publish — which is how the official client builds them (`cdn/cdn-url.ts`,
 * and `CDN_BASE_URL` in `auth/accounts.ts`, the same host).
 */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/**
 * The download endpoint inbound attachments are fetched from.
 *
 * Overridable as `wechat.ilink.cdnBaseUrl` (tests point it at a stub). That key
 * historically named this whole URL rather than the bare base, so
 * {@link cdnUploadBaseUrl} strips the `/download` suffix to recover the base for
 * uploads — one configured host, no second key to keep in sync, and a test stub
 * keeps working for both directions.
 */
export const ILINK_CDN_DOWNLOAD_URL = `${ILINK_CDN_BASE_URL}/download`

/**
 * Refuse to upload more than this in one outbound attachment.
 *
 * The whole file is read, encrypted and held in memory before the first request
 * goes out — the protocol has no streaming form — so this is a memory ceiling as
 * much as a courtesy limit. 20 MB mirrors {@link ILINK_MEDIA_MAX_BYTES}: what the
 * bridge accepts inbound is what it will send back out. Overridable as
 * `wechat.ilink.uploadMaxBytes`.
 */
export const ILINK_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/**
 * Per-attempt timeout for a CDN upload POST.
 *
 * The official client's upload has no timeout at all, so a CDN that accepts the
 * connection and then stalls would leave the reply unresolved forever. The
 * download half of this file already bounds itself (`wechat.ilink.mediaTimeoutMs`),
 * and uploads get the same treatment with a longer leash (the body is bigger).
 * Overridable as `wechat.ilink.uploadTimeoutMs`.
 */
export const ILINK_UPLOAD_TIMEOUT_MS = 60000

/**
 * How many times one CDN upload POST is attempted.
 *
 * Three, matching `cdn/cdn-upload.ts`: enough to ride out a flaky edge, few enough
 * that a real outage does not turn one reply into a retry storm. There is no
 * backoff there either, and none here — the gateway's long-poll already paces this
 * loop, and a sleep would only delay a reply the user is waiting for.
 */
export const ILINK_CDN_UPLOAD_ATTEMPTS = 3

/**
 * Refuse to buffer more than this from the media CDN, per attachment.
 *
 * The download is best-effort and happens inside the poll loop, so an unbounded
 * body would stall message handling and can exhaust memory on a hostile or
 * broken CDN reply.
 *
 * 20 MB, matching `wechat.ilink.maxBytes` in `defaultConfig()`: a photo or
 * screenshot is compressed well under this, but the file path exists precisely so
 * people can hand the agent a document, and a PDF or spreadsheet of a few MB is
 * ordinary. One buffer is held at a time (the loop awaits each download), so the
 * cap is also the memory ceiling this feature can add.
 */
export const ILINK_MEDIA_MAX_BYTES = 20 * 1024 * 1024

/**
 * Floor on the gap between two polls.
 *
 * A healthy connection never gets near this: the client asks the gateway to hold
 * `getupdates` for tens of seconds (`wechat.ilink.pollTimeoutMs`, 40 s by
 * default), and the server may shorten that, not lengthen it. It exists for the
 * unhealthy case — an answer that returns instantly would make the poll loop a
 * microtask-only busy loop, which never yields to the timer phase and therefore
 * starves every `setTimeout` in the process. A stub that answers immediately
 * exposed exactly that; see the regression stub in `scripts/check-ilink.mjs`.
 */
export const ILINK_MIN_POLL_INTERVAL_MS = 250

/** How many saved bot tokens the server is told about, newest first. */
export const LOCAL_TOKEN_LIST_MAX = 10

/** Who wrote a message. Only `USER` messages are worth answering. */
export const MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 }

/** Lifecycle of an outgoing message; a finished reply is `FINISH`. */
export const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 }

/** Payload kinds inside `item_list`. */
export const MESSAGE_ITEM_TYPE = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }

/**
 * `media_type` for `/ilink/bot/getuploadurl` (`proto: UploadMediaType`).
 *
 * Deliberately separate from {@link MESSAGE_ITEM_TYPE}: the two number the same
 * concepts differently — an image is `2` in `item_list` and `1` here — and passing
 * one where the other belongs asks the gateway for an upload target of the wrong
 * kind, which fails later at the CDN with nothing pointing at the cause.
 */
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

/** Typing indicator states for `/ilink/bot/sendtyping`. */
export const TYPING_STATUS = { TYPING: 1, CANCEL: 2 }

/** The gateway's own error code for "your QR login is no longer valid". */
export const ERRCODE_SESSION_EXPIRED = -14

/**
 * Pack a dotted version into the 0x00MMNNPP form the header needs: `2.1.3` →
 * `0x020103`.
 *
 * @param {string} version - dotted version.
 * @returns {number} the packed integer.
 */
export function buildClientVersion(version = ILINK_PROTOCOL_VERSION) {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/**
 * Build the headers every iLink request carries.
 *
 * These two are the identity the gateway routes on, and they must be present and
 * non-zero on every call: an earlier official build shipped them empty in
 * production and every request failed until that was fixed (CHANGELOG 2.4.3).
 * The optional `SKRouteTag` is a deployment concern, not part of the identity.
 *
 * @param {{ appVersion?: string, routeTag?: string }} [options] - header options.
 * @returns {Record<string, string>} the GET headers.
 */
export function buildCommonHeaders(options = {}) {
  const headers = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(options.appVersion ?? ILINK_PROTOCOL_VERSION)),
  }
  if (options.routeTag !== undefined && options.routeTag !== '') headers.SKRouteTag = String(options.routeTag)
  return headers
}

/**
 * `X-WECHAT-UIN` is a random uint32 rendered as a *decimal string* and then
 * base64'd — not four raw random bytes. The server parses it back into a
 * number, so the two encodings are not interchangeable.
 *
 * @returns {string} the header value.
 */
export function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/**
 * Build the headers for a POST.
 *
 * The login calls deliberately do not use this: the official client sends the
 * QR-status poll with only the common headers, and `get_bot_qrcode` with the
 * JSON headers but no `Authorization`.
 *
 * @param {{ token?: string, appVersion?: string, routeTag?: string }} [options] - header options.
 * @returns {Record<string, string>} request headers.
 */
export function buildIlinkHeaders(options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(options),
  }
  const token = String(options.token ?? '')
  if (token !== '') headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Strip markdown, because WeChat renders messages as plain text.
 *
 * Without this a reply full of `**bold**` and ``` fences arrives looking like
 * punctuation soup. Code fences keep their body; links keep their target.
 *
 * @param {string} text - possibly formatted text.
 * @returns {string} plain text.
 */
export function markdownToPlainText(text) {
  return (
    String(text ?? '')
      // A fence that opens on its own line (optionally tagged with a language) and
      // closes on its own line: keep the body, drop the fence. Anchoring both ends
      // to line boundaries is what makes this safe.
      .replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, '$1')
      // Whatever fences are left are inline — a model writing its output as
      // "``` sandbox-ok ```" on one line. Keep the body there too.
      //
      // The earlier single pattern required a newline right after the opening
      // fence, so an inline fence made it run to the *next* newline and delete
      // everything in between: a reply whose whole point was the captured command
      // output arrived with that output silently removed.
      .replace(/```([\s\S]*?)```/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/___(.+?)___/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*_]{3,}$/gm, '---')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * The marker a reply uses to ask the bridge to send a file.
 *
 * This is a *bridge* convention, not part of the iLink protocol: the model cannot
 * hand bytes to the gateway, so it writes a marker into its answer and the
 * outbound path turns that into an upload. It lives here, in one place, because
 * three things must agree on the exact spelling — the model's instructions, the
 * outbound scanner ({@link extractFileMarkers}), and whatever renders it back
 * ({@link formatFileMarker}).
 *
 * A single line is the boundary: a path never contains a newline, and letting the
 * match run across lines would turn an unterminated marker into a deletion that
 * swallows the rest of the reply.
 */
const FILE_MARKER_PATTERN = /\[\[send-file:\s*([^\n]+?)\s*\]\]/g

/**
 * Render the marker for one path. The inverse of {@link extractFileMarkers}.
 *
 * @param {string} filePath - path of the file to send.
 * @returns {string} the marker text.
 */
export function formatFileMarker(filePath) {
  return `[[send-file: ${String(filePath ?? '')}]]`
}

/**
 * Pull `[[send-file: …]]` markers out of a reply.
 *
 * The markers are addressed to the bridge, not to the reader, so they must never
 * reach WeChat: this returns the text with them removed, plus the paths in the
 * order they were mentioned with duplicates dropped — a model that repeats itself
 * must not send the same file twice.
 *
 * The whitespace half is the fiddly part. A marker usually sits alone on its own
 * line, and deleting just the marker text would leave a blank hole in the middle
 * of the reply; two markers on one line would leave a double space. Both are
 * cleaned up, but *only* when a marker was actually found — a reply without one is
 * returned byte-for-byte, so this is safe to call on every message.
 *
 * @param {string} text - the reply as the model wrote it.
 * @returns {{ text: string, paths: string[] }} the reply without markers, and the paths to send.
 */
export function extractFileMarkers(text) {
  const source = String(text ?? '')
  const paths = []
  const seen = new Set()
  let found = false
  // A NUL placeholder survives the removal pass, so a marker that occupied a whole
  // line can still be recognised afterwards and have its line dropped — deciding
  // that from the surrounding whitespace alone would eat real blank lines the
  // model wrote on purpose.
  const marked = source.replace(FILE_MARKER_PATTERN, (_match, rawPath) => {
    found = true
    const path = String(rawPath).trim()
    if (path !== '' && !seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
    return '\u0000'
  })
  if (!found) return { text: source, paths: [] }
  const cleaned = marked
    // A lone marker takes its whole line with it, newline included.
    .replace(/^[ \t]*\u0000[ \t]*\r?\n?/gm, '')
    // What is left is an inline marker: remove it, then tidy the gap it left.
    .replace(/\u0000/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned, paths }
}

/** Error carrying the gateway's own ret/errcode so callers can branch on them. */
export class IlinkError extends Error {
  /**
   * @param {string} message - human-readable summary.
   * @param {{ status?: number, ret?: number, errcode?: number }} [details] - codes.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'IlinkError'
    this.status = details.status ?? 0
    this.ret = details.ret
    this.errcode = details.errcode
  }

  /** @returns {boolean} whether this is the "re-scan the QR code" failure. */
  get sessionExpired() {
    return this.errcode === ERRCODE_SESSION_EXPIRED
  }
}

/**
 * A raw inbound media reference, before it is downloaded and decrypted.
 *
 * iLink hands out a CDN query parameter plus a key instead of bytes; this is what
 * {@link hydrateIlinkMedia} turns into something the model can use.
 *
 * @typedef {object} IlinkMediaRef
 * @property {'image'|'file'} kind - which payload the bytes belong to.
 * @property {string} encryptQueryParam - `encrypted_query_param` for the CDN download.
 * @property {string} aesKey - base64 AES key, in whichever of the two encodings the server used.
 * @property {string} fileName - original name when the protocol sends one.
 * @property {string} mimeType - declared type, or a sensible fallback.
 */

/**
 * One inbound iLink message in the shape every provider in this bridge emits.
 *
 * `wechat.mjs` reads the first ten fields for every provider; `media` and the
 * inline-attachment fields are iLink-specific:
 *
 *  - `media` is the raw CDN reference, kept on the event so the download can be
 *    redone by a caller that wants the bytes itself.
 *  - `imageBase64` / `imageMimeType` appear once an image has been fetched and
 *    decrypted, and are what `WeChatAdapter` turns into a model attachment.
 *
 * @typedef {object} IlinkMessageEvent
 * @property {'message.new'} event - the only event kind this provider emits.
 * @property {string} sessionId - the peer's user id (iLink is direct-message only).
 * @property {'private'} sessionType - always private: iLink bots cannot join groups.
 * @property {string} rawid - message id or seq, used for de-duplication.
 * @property {string} sourceName - the sender's display name (the user id; iLink sends no nickname).
 * @property {string} content - what the agent reads, with placeholders for media.
 * @property {number} timestamp - seconds since the epoch.
 * @property {boolean} isSend - always false: the poll only returns the user's side.
 * @property {string} localPath - path of a downloaded file, when one was written.
 * @property {string} contextToken - reply credential, echoed on every send for this peer.
 * @property {IlinkMediaRef} [media] - raw CDN reference, when the message carried media.
 * @property {string} [imageBase64] - decrypted image bytes, base64.
 * @property {string} [imageMimeType] - MIME type of those bytes.
 */

/**
 * Pull a CDN reference out of one media payload.
 *
 * The protocol nests it (`image_item.media.aes_key`) in the versions we have seen,
 * but flat spellings circulate too, and the cost of accepting both is a few lines
 * against an attachment the agent can never see. Missing either half means there
 * is nothing to download, so that is reported as "no media" rather than a
 * half-filled reference.
 *
 * @param {any} source - `image_item` / `file_item`.
 * @param {'image'|'file'} kind - the payload kind.
 * @param {string} fallbackMime - MIME type to assume when the server omits one.
 * @returns {IlinkMediaRef | null} the reference, or null when it cannot be used.
 */
function mediaRefFrom(source, kind, fallbackMime) {
  if (source === null || typeof source !== 'object') return null
  const nested = source.media !== null && typeof source.media === 'object' ? source.media : source
  const encryptQueryParam = String(
    nested.encrypt_query_param ?? nested.encryptQueryParam ?? source.encrypt_query_param ?? source.encryptQueryParam ?? '',
  )
  const aesKey = String(nested.aes_key ?? nested.aesKey ?? source.aes_key ?? source.aesKey ?? '')
  if (encryptQueryParam === '' || aesKey === '') return null
  return {
    kind,
    encryptQueryParam,
    aesKey,
    fileName: String(source.file_name ?? source.fileName ?? ''),
    mimeType: String(source.mime_type ?? source.mimeType ?? '') || fallbackMime,
  }
}

/**
 * Turn one iLink message into the event shape every provider in this bridge
 * emits.
 *
 * Media is *not* fetched here: this stays synchronous because it is the pure
 * "what did they send" mapping. The CDN reference is attached so
 * {@link IlinkBridge} can hydrate it (asynchronously) before emitting.
 *
 * @param {any} message - a `WeixinMessage` from `getupdates`.
 * @returns {IlinkMessageEvent | null} the event, or null when it carries nothing to answer.
 */
export function normalizeIlinkMessage(message) {
  if (message === null || message === undefined) return null
  if (Number(message.message_type ?? MESSAGE_TYPE.NONE) !== MESSAGE_TYPE.USER) return null
  const fromUserId = String(message.from_user_id ?? '')
  if (fromUserId === '') return null

  const items = Array.isArray(message.item_list) ? message.item_list : []
  const texts = []
  let attachment = ''
  /** @type {IlinkMediaRef | null} */
  let media = null
  for (const item of items) {
    const type = Number(item?.type ?? MESSAGE_ITEM_TYPE.NONE)
    if (type === MESSAGE_ITEM_TYPE.TEXT && typeof item.text_item?.text === 'string') {
      texts.push(item.text_item.text)
    } else if (type === MESSAGE_ITEM_TYPE.IMAGE) {
      attachment = '[图片]'
      media = mediaRefFrom(item.image_item, 'image', 'image/jpeg') ?? media
    } else if (type === MESSAGE_ITEM_TYPE.VOICE) {
      // Voice messages arrive with a transcription when the server produced one.
      // The audio itself is a voice blob the model cannot read, so it is left as
      // text: there is nothing useful to hand over even when the download works.
      const spoken = item.voice_item?.text
      attachment = typeof spoken === 'string' && spoken !== '' ? `[语音] ${spoken}` : '[语音]'
    } else if (type === MESSAGE_ITEM_TYPE.FILE) {
      attachment = `[文件] ${String(item.file_item?.file_name ?? '')}`.trim()
      media = mediaRefFrom(item.file_item, 'file', 'application/octet-stream') ?? media
    } else if (type === MESSAGE_ITEM_TYPE.VIDEO) {
      attachment = '[视频]'
    }
  }

  const content = [...texts, attachment].filter((part) => part !== '').join('\n')
  if (content === '') return null

  return {
    event: 'message.new',
    // iLink is direct-message only, so the peer is always the human on the other
    // end and the conversation id is simply their user id.
    sessionId: fromUserId,
    sessionType: 'private',
    rawid: String(message.message_id ?? message.seq ?? ''),
    sourceName: fromUserId,
    content,
    timestamp: Math.floor(Number(message.create_time_ms ?? Date.now()) / 1000),
    isSend: false,
    localPath: '',
    /** Echoed back on every reply; without it the gateway rejects the send. */
    contextToken: String(message.context_token ?? ''),
    // Only present when there is something to fetch, so events for plain text are
    // byte-for-byte what they always were.
    ...(media === null ? {} : { media }),
  }
}

/**
 * Decode an `aes_key` from the media payload into 16 raw key bytes.
 *
 * The protocol has been observed in all three spellings and getting this wrong
 * looks like "the CDN returned garbage", so all of them are accepted:
 *
 *   base64(16 raw bytes)       the documented form
 *   base64(32 hex characters)  a key that was hex-encoded before being base64'd
 *   32 hex characters          hex with no base64 at all
 *
 * @param {string} value - the key as it arrived.
 * @returns {Buffer | null} exactly 16 key bytes, or null when nothing usable was found.
 */
export function decodeMediaAesKey(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, 'hex')
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('utf8'))) {
    return Buffer.from(decoded.toString('utf8'), 'hex')
  }
  return null
}

/** Remove PKCS#7 padding when it is actually there. @param {Buffer} buffer - decrypted bytes. */
function stripPkcs7(buffer) {
  const last = buffer[buffer.length - 1]
  if (last === undefined || last < 1 || last > 16 || last > buffer.length) return buffer
  for (let index = buffer.length - last; index < buffer.length; index += 1) {
    if (buffer[index] !== last) return buffer
  }
  return buffer.subarray(0, buffer.length - last)
}

/**
 * Decrypt one media payload: AES-128-ECB, no IV, key taken straight from `aes_key`.
 *
 * ECB with a raw key is what the protocol specifies (and the only mode that needs
 * no key exchange), so this uses `node:crypto` directly rather than pulling in a
 * dependency. Both padded and unpadded streams are accepted: the documented form
 * is PKCS#7 padded, but an unpadded image is still valid ciphertext and failing on
 * it would lose the attachment for no reason.
 *
 * @param {Buffer | Uint8Array} ciphertext - the bytes from the CDN.
 * @param {Buffer | null} key - 16 key bytes from {@link decodeMediaAesKey}.
 * @returns {Buffer | null} the plaintext, or null when it cannot be decrypted.
 */
export function decryptMediaEcb(ciphertext, key) {
  const data = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext ?? [])
  if (key === null || key === undefined || key.length !== 16) return null
  if (data.length === 0 || data.length % 16 !== 0) return null
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    // No padding to validate: decrypt raw and strip the padding by hand if present.
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    return stripPkcs7(Buffer.concat([decipher.update(data), decipher.final()]))
  } catch {
    return null
  }
}

/**
 * Recover the CDN *base* from the configured download endpoint.
 *
 * The official protocol builds both URLs from one base (`${base}/download`,
 * `${base}/upload` — `cdn/cdn-url.ts`), but `wechat.ilink.cdnBaseUrl` in this
 * bridge names the finished download URL, because downloading is all there used to
 * be. Rather than invent a second setting that can disagree with the first,
 * strip the known suffix. The practical reason is sharper than tidiness: a test
 * stub points `cdnBaseUrl` at itself, and without this an upload would post to the
 * *real* CDN while the download went to the stub — a production request fired from
 * a test.
 *
 * A value with no `/download` suffix is assumed to already be a base.
 *
 * @param {string} downloadUrl - the configured download endpoint (or a bare base).
 * @returns {string} the base to append `/upload` to.
 */
export function cdnUploadBaseUrl(downloadUrl) {
  const raw = String(downloadUrl ?? '').trim().replace(/\/+$/, '')
  if (raw === '') return ILINK_CDN_BASE_URL
  return raw.endsWith('/download') ? raw.slice(0, -'/download'.length) : raw
}

/**
 * Ciphertext size of a PKCS#7-padded AES-128-ECB payload.
 *
 * Note the `+ 1`: PKCS#7 *always* pads, so a payload that already ends on a block
 * boundary grows a whole extra block. The gateway is told this number as
 * `filesize` while the plaintext size goes in `rawsize`, and the CDN checks the
 * bytes it receives against what was declared.
 *
 * Mirrors `aesEcbPaddedSize` in the official `cdn/aes-ecb.ts` line for line — it is
 * exported so the declared size and the size of what {@link encryptMediaEcb}
 * actually produces can be compared instead of trusted.
 *
 * @param {number} plaintextSize - plaintext bytes.
 * @returns {number} ciphertext bytes.
 */
export function aesEcbPaddedSize(plaintextSize) {
  const size = Math.floor(Number(plaintextSize))
  if (!Number.isFinite(size) || size < 0) return 0
  return Math.ceil((size + 1) / 16) * 16
}

/**
 * Encrypt one outbound payload: AES-128-ECB, PKCS#7 padding, no IV.
 *
 * The mirror image of {@link decryptMediaEcb}, and the only mode the protocol
 * offers — which is exactly why the key can travel inside the message body instead
 * of needing a key exchange.
 *
 * @param {Buffer | Uint8Array | string} plaintext - the bytes to encrypt.
 * @param {Buffer | Uint8Array} key - exactly 16 key bytes, not a hex string.
 * @returns {Buffer} the ciphertext, padded to a 16-byte boundary.
 * @throws {IlinkError} when the key is not 16 bytes. That is a bug in the caller,
 *   not a condition the network can explain, and encrypting with a wrong-sized key
 *   would produce a file that nobody — including the recipient — can ever decrypt.
 */
export function encryptMediaEcb(plaintext, key) {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext ?? [])
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key ?? [])
  if (keyBytes.length !== 16) {
    throw new IlinkError(`iLink 媒体加密需要 16 字节 aeskey，实际是 ${keyBytes.length} 字节`)
  }
  const cipher = createCipheriv('aes-128-ecb', keyBytes, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/**
 * Render a byte count for an operator.
 *
 * @param {number} bytes - the size.
 * @returns {string} e.g. `1.5 MB`, `512 字节`.
 */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value >= 1024 * 1024) return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`
  if (value >= 1024) return `${Math.round((value / 1024) * 10) / 10} KB`
  return `${Math.round(value)} 字节`
}

/**
 * Coerce a configured number to something usable, or fall back.
 *
 * A configured `0`, a negative or a typo must not become the effective limit:
 * `0` would reject every file and `NaN` would silently disable the size check
 * altogether, which is the failure mode the check exists to prevent.
 *
 * @param {number} value - the configured value.
 * @param {number} fallback - what to use when it is not a positive finite number.
 * @returns {number} the value or the fallback.
 */
function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Extensions WeChat renders as an inline picture.
 *
 * The same four the inbound side can sniff (`sniffImageMimeType`), so anything the
 * bridge accepted as an image can be sent back as one. The protocol has no
 * sniffing step of its own: the official sender routes on the file's MIME type
 * (`messaging/send-media.ts`), and an extension is the closest thing this bridge
 * has without guessing at content it has not read yet.
 */
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Build the one `item_list` entry that carries an uploaded payload.
 *
 * Two protocol details here are easy to get wrong, and both are spelled out in the
 * official sender (`messaging/send.ts`):
 *
 *  - `media.aes_key` is base64 of the key's **hex spelling**, not of the raw key
 *    bytes. The upload was described with `aeskey: <hex>`, and the receiver's
 *    decoder turns base64 back into ASCII hex before it gets 16 bytes (that is the
 *    first branch of {@link decodeMediaAesKey}). Base64 of the raw bytes is a
 *    different string for the same key, and the file arrives undecryptable.
 *  - `encrypt_type: 1` means "the whole payload is encrypted", which is what was
 *    uploaded; `0` would claim only the file id is encrypted.
 *
 * The sizes are not interchangeable either: an image reports the *ciphertext* size
 * as `mid_size`, a file reports the *plaintext* size as `len` (a string, because
 * the proto field is an int64 that JSON must not round).
 *
 * @param {{ mediaType: number, fileName: string, uploaded: { downloadParam: string, aeskeyHex: string, plainSize: number, cipherSize: number } }} params - media type, display name and the uploaded reference.
 * @returns {any} one `item_list` entry.
 */
function buildUploadedMediaItem(params) {
  const media = {
    encrypt_query_param: String(params.uploaded.downloadParam),
    // utf8 is explicit: `Buffer.from(<hex string>)` must be read as text, never as
    // hex bytes, or the key that reaches WeChat is half the length it should be.
    aes_key: Buffer.from(String(params.uploaded.aeskeyHex), 'utf8').toString('base64'),
    encrypt_type: 1,
  }
  if (Number(params.mediaType) === UPLOAD_MEDIA_TYPE.IMAGE) {
    return {
      type: MESSAGE_ITEM_TYPE.IMAGE,
      image_item: { media, mid_size: Number(params.uploaded.cipherSize) },
    }
  }
  return {
    type: MESSAGE_ITEM_TYPE.FILE,
    file_item: {
      media,
      file_name: String(params.fileName),
      len: String(params.uploaded.plainSize),
    },
  }
}

/**
 * Guess an image MIME type from its magic bytes.
 *
 * This is not decoration: `WeChatAdapter` only admits png/jpeg/webp/gif
 * attachments, so a wrong guess silently drops the image the operator was
 * promised. Sniffing beats trusting a field the protocol may leave empty.
 *
 * @param {Buffer} bytes - decrypted image bytes.
 * @returns {string | null} a supported MIME type, or null when it is not an image.
 */
export function sniffImageMimeType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/**
 * Fetch and decrypt one media reference.
 *
 * The URL carries only the opaque `encrypted_query_param`; the key never leaves
 * this process, which is why the download and the decryption live in one function
 * and everything above it deals in plain bytes.
 *
 * @param {IlinkMediaRef} media - the reference from {@link normalizeIlinkMessage}.
 * @param {{ fetchImpl?: typeof fetch, cdnBaseUrl?: string, maxBytes?: number, timeoutMs?: number }} [options] - seams and limits.
 * @returns {Promise<Buffer | null>} the plaintext, or null when it could not be fetched.
 */
/**
 * Resolve the configured CDN download endpoint.
 *
 * `wechat.ilink.cdnBaseUrl` ships as an empty string and an empty string means
 * "use the default". Testing that with `??` looked right and was not: `'' ?? x` is
 * `''`, so the endpoint collapsed to a bare query string and every inbound image
 * or file failed with "Failed to parse URL from ?encrypted_query_param=…". The bug
 * sat unnoticed because a reply that is only text never touches the CDN — it took
 * someone actually sending a document to surface it.
 *
 * @param {unknown} configured - the `wechat.ilink.cdnBaseUrl` value.
 * @returns {string} a usable download endpoint.
 */
export function cdnDownloadUrl(configured) {
  const raw = String(configured ?? '').trim()
  return raw === '' ? ILINK_CDN_DOWNLOAD_URL : raw
}

export async function downloadIlinkMedia(media, options = {}) {
  const key = decodeMediaAesKey(media?.aesKey)
  if (key === null) {
    log.debug('iLink 媒体：aes_key 无法解析，保留占位文本')
    return null
  }
  const base = cdnDownloadUrl(options.cdnBaseUrl)
  const url = `${base}${base.includes('?') ? '&' : '?'}encrypted_query_param=${encodeURIComponent(String(media.encryptQueryParam))}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const configuredMax = Number(options.maxBytes ?? ILINK_MEDIA_MAX_BYTES)
  const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : ILINK_MEDIA_MAX_BYTES
  const configuredTimeout = Number(options.timeoutMs ?? 20000)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20000
  const response = await fetchImpl(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    log.warn(`iLink 媒体下载失败：HTTP ${response.status}`)
    return null
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0 || buffer.length > maxBytes) {
    log.warn(`iLink 媒体大小异常（${buffer.length} 字节），已跳过`)
    return null
  }
  const plain = decryptMediaEcb(buffer, key)
  if (plain === null) {
    log.warn('iLink 媒体解密失败（AES-128-ECB），保留占位文本')
    return null
  }
  return plain
}

/**
 * Copy the sender's original file name into something a Windows path can hold.
 *
 * The name comes from the network, so it is sanitised rather than trusted: a
 * `..\..\` in a file name must not decide where the bridge writes.
 *
 * @param {IlinkMediaRef} media - the reference.
 * @returns {string} a safe base name.
 */
function safeMediaFileName(media) {
  const name = String(media?.fileName ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '')
  const trimmed = name.trim().replace(/^\.+/, '')
  return trimmed === '' ? 'download.bin' : trimmed.slice(-120)
}

/**
 * Download and decrypt one inbound attachment, in place.
 *
 * iLink never inlines bytes: without this an image reaches the agent as the
 * literal text `[图片]` — visible in the log, invisible to the model. The
 * contract is deliberately best-effort: a rotated key, a dead CDN or a corrupt
 * blob degrades back to that same placeholder, because the message has already
 * been consumed and there is nothing the user could retry.
 *
 * @param {IlinkMessageEvent} event - a normalized event, possibly carrying `media`.
 * @param {{ fetchImpl?: typeof fetch, cdnBaseUrl?: string, tmpDir?: string, maxBytes?: number, timeoutMs?: number }} [options] - seams and limits.
 * @returns {Promise<IlinkMessageEvent>} the same event, hydrated when that worked.
 */
export async function hydrateIlinkMedia(event, options = {}) {
  const media = event?.media
  if (media === undefined || media === null) return event
  try {
    const bytes = await downloadIlinkMedia(media, options)
    if (bytes === null) return event
    if (media.kind === 'image') {
      // `content` deliberately stays `[图片]`: that is what makes the adapter
      // classify the message as an image and attach the bytes below.
      const declared = String(media.mimeType ?? '')
      event.imageBase64 = bytes.toString('base64')
      event.imageMimeType = sniffImageMimeType(bytes) ?? (declared.startsWith('image/') ? declared : 'image/jpeg')
      return event
    }
    const directory = String(options.tmpDir ?? '') || join(tmpdir(), 'dsh-chat-bridge-media')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${safeMediaFileName(media)}`)
    writeFileSync(path, bytes)
    event.localPath = path
    // Append rather than replace: the placeholder may sit next to the sender's
    // own text, and silently dropping that text would be worse than a long line.
    event.content = `${String(event.content ?? '')}\n（文件已下载到本地，可用路径读取：${path}）`.trim()
    return event
  } catch (error) {
    log.warn(`iLink 媒体处理失败（保留占位文本）：${error instanceof Error ? error.message : error}`)
    return event
  }
}

/**
 * A thin HTTP client for the iLink Bot endpoints.
 *
 * Kept separate from the bridge so it can be exercised against a stub server
 * without a real WeChat account.
 */
export class IlinkClient {
  #baseUrl
  #cdnBaseUrl
  #token
  #fetch
  #timeoutMs
  #appVersion
  #routeTag

  /**
   * @param {{ baseUrl?: string, cdnBaseUrl?: string, token?: string, fetchImpl?: typeof fetch, timeoutMs?: number, appVersion?: string, routeTag?: string }} [options] - client options.
   */
  constructor(options = {}) {
    this.#baseUrl = String(options.baseUrl ?? ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#cdnBaseUrl = cdnUploadBaseUrl(options.cdnBaseUrl ?? ILINK_CDN_BASE_URL)
    this.#token = String(options.token ?? '')
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#timeoutMs = Number(options.timeoutMs ?? 40000)
    this.#appVersion = String(options.appVersion ?? ILINK_PROTOCOL_VERSION)
    this.#routeTag = options.routeTag === undefined ? '' : String(options.routeTag)
  }

  /** @returns {string} the endpoint in use. */
  get baseUrl() {
    return this.#baseUrl
  }

  /** @returns {string} the media CDN base uploads are posted under. */
  get cdnBaseUrl() {
    return this.#cdnBaseUrl
  }

  /** @returns {string} the bearer token in use. */
  get token() {
    return this.#token
  }

  /**
   * Swap in the token from a completed QR login.
   *
   * @param {string} token - bearer token.
   * @returns {void}
   */
  setToken(token) {
    this.#token = String(token ?? '')
  }

  /**
   * Issue one request and normalize failures into `IlinkError`.
   *
   * @param {string} path - endpoint path, e.g. `/ilink/bot/getupdates`.
   * @param {{ method?: string, body?: any, signal?: AbortSignal, timeoutMs?: number, auth?: boolean, baseUrl?: string }} [options] - request options.
   * @returns {Promise<any>} the parsed JSON body.
   */
  async #request(path, options = {}) {
    const method = options.method ?? 'POST'
    const timeoutMs = Number(options.timeoutMs ?? this.#timeoutMs)
    const baseUrl = String(options.baseUrl ?? this.#baseUrl).replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const init = {
        method,
        // A GET carries only the identity headers; every other header on those
        // requests is noise the server has no use for.
        headers:
          method === 'GET'
            ? buildCommonHeaders({ appVersion: this.#appVersion, routeTag: this.#routeTag })
            : buildIlinkHeaders({
                token: options.auth === false ? '' : this.#token,
                appVersion: this.#appVersion,
                routeTag: this.#routeTag,
              }),
        signal: controller.signal,
      }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      const response = await this.#fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      let payload = null
      if (text !== '') {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        throw new IlinkError(
          `iLink ${path} 失败：HTTP ${response.status}${payload?.errmsg ? ` — ${payload.errmsg}` : ''}`,
          { status: response.status, ret: payload?.ret, errcode: payload?.errcode },
        )
      }
      if (payload === null) {
        throw new IlinkError(`iLink ${path} 返回了非 JSON 内容`, { status: response.status })
      }
      return payload
    } catch (error) {
      if (error instanceof IlinkError) throw error
      if (error?.name === 'AbortError') throw error
      throw new IlinkError(`iLink ${path} 网络错误：${error instanceof Error ? error.message : error}`)
    } finally {
      clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener?.('abort', onAbort)
    }
  }

  /**
   * Start a QR login session.
   *
   * This is a `POST` with a body, not a bare `GET`: the server expects
   * `local_token_list`, which is how it notices that the scanning account is
   * already bound to one of the tokens this client holds and answers
   * `binded_redirect` instead of silently refusing the scan.
   *
   * @param {{ localTokenList?: string[], baseUrl?: string }} [options] - QR options.
   * @returns {Promise<{ qrcode: string, url: string }>} the session id and a URL that renders the code.
   */
  async getQrCode(options = {}) {
    const localTokenList = Array.isArray(options.localTokenList)
      ? options.localTokenList.map((token) => String(token)).filter((token) => token !== '').slice(-LOCAL_TOKEN_LIST_MAX)
      : []
    const payload = await this.#request(
      `/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
      {
        method: 'POST',
        auth: false,
        baseUrl: options.baseUrl,
        body: { local_token_list: localTokenList },
      },
    )
    const qrcode = String(payload?.qrcode ?? '')
    if (qrcode === '') throw new IlinkError('iLink 没有返回二维码，请稍后重试')
    return { qrcode, url: String(payload?.qrcode_img_content ?? '') }
  }

  /**
   * Ask whether the QR code has been scanned yet.
   *
   * The gateway holds this request open until the state actually changes, so a
   * slow reply is expected rather than a symptom. It reports more than a yes/no:
   * an IDC redirect, a pairing-code challenge and an "already bound" shortcut all
   * arrive here, and ignoring them leaves the caller polling forever.
   *
   * @param {string} qrcode - session id from {@link getQrCode}.
   * @param {{ verifyCode?: string, baseUrl?: string, timeoutMs?: number }} [options] - poll options.
   * @returns {Promise<{ status: string, token: string, baseUrl: string, userId: string, botId: string, redirectHost: string }>} the current state.
   */
  async getQrStatus(qrcode, options = {}) {
    const query = new URLSearchParams({ qrcode })
    if (options.verifyCode !== undefined && options.verifyCode !== '') {
      query.set('verify_code', String(options.verifyCode))
    }
    const target = options.baseUrl ?? this.#baseUrl
    const payload = await this.#request(`/ilink/bot/get_qrcode_status?${query.toString()}`, {
      method: 'GET',
      baseUrl: target,
      timeoutMs: Number(options.timeoutMs ?? QR_STATUS_TIMEOUT_MS),
    })
    return {
      status: String(payload?.status ?? ''),
      token: String(payload?.bot_token ?? ''),
      baseUrl: String(payload?.baseurl ?? ''),
      userId: String(payload?.ilink_user_id ?? ''),
      botId: String(payload?.ilink_bot_id ?? ''),
      redirectHost: String(payload?.redirect_host ?? ''),
    }
  }

  /**
   * Long-poll for new messages.
   *
   * A poll that times out with no traffic is normal and reported as an empty
   * batch rather than an error, so the caller can simply poll again.
   *
   * @param {string} cursor - opaque `get_updates_buf` from the previous batch.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - poll options.
   * @returns {Promise<{ ret?: number, errcode?: number, errmsg?: string, msgs: any[], cursor: string, longpollingTimeoutMs: number }>} one batch.
   */
  async getUpdates(cursor, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.#timeoutMs)
    try {
      const payload = await this.#request('/ilink/bot/getupdates', {
        body: { get_updates_buf: cursor ?? '', base_info: { channel_version: ILINK_PROTOCOL_VERSION } },
        timeoutMs,
        signal: options.signal,
      })
      return {
        ret: payload?.ret,
        errcode: payload?.errcode,
        errmsg: payload?.errmsg,
        msgs: Array.isArray(payload?.msgs) ? payload.msgs : [],
        cursor: String(payload?.get_updates_buf ?? cursor ?? ''),
        longpollingTimeoutMs: Number(payload?.longpolling_timeout_ms ?? 0),
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { ret: 0, msgs: [], cursor: cursor ?? '', longpollingTimeoutMs: 0 }
      }
      throw error
    }
  }

  /**
   * Send one plain-text reply.
   *
   * The return value is deliberately *not* called "sent": `ret=0` means the
   * gateway accepted the message, and openclaw#79293 shows the user-visible layer
   * can still drop it while this call reports success. Callers must keep the two
   * apart, so the acknowledgement is spelled out here once instead of being
   * re-derived (and mis-stated) in every caller.
   *
   * @param {{ toUserId: string, text: string, contextToken?: string }} params - recipient and body.
   * @returns {Promise<{ ret: number, accepted: true, delivered: 'unknown', detail: string }>} the gateway's acknowledgement.
   * @throws {IlinkError} when the gateway rejects the message (`ret`/`errcode` non-zero) or the request fails.
   */
  async sendText(params) {
    const payload = await this.#request('/ilink/bot/sendmessage', {
      body: {
        msg: {
          to_user_id: String(params.toUserId),
          from_user_id: '',
          client_id: randomUUID(),
          message_type: MESSAGE_TYPE.BOT,
          message_state: MESSAGE_STATE.FINISH,
          context_token: params.contextToken ?? '',
          item_list: [
            {
              type: MESSAGE_ITEM_TYPE.TEXT,
              text_item: { text: markdownToPlainText(params.text) },
            },
          ],
        },
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
    })
    this.#assertGatewayAccepted(payload, 'iLink 发送失败')
    return {
      ret: Number(payload?.ret ?? 0),
      accepted: true,
      delivered: 'unknown',
      detail: ILINK_ACCEPTED_DETAIL,
    }
  }

  /**
   * Throw unless the gateway acknowledged a send.
   *
   * The HTTP status is not the signal a send fails on: the gateway answers `200`
   * and puts the verdict in `ret` / `errcode`. Shared by the text and media
   * senders so the two cannot drift apart on which of them is checked.
   *
   * @param {any} payload - the parsed `sendmessage` response.
   * @param {string} label - what failed, for the message.
   * @returns {void}
   * @throws {IlinkError} when either code is non-zero.
   */
  #assertGatewayAccepted(payload, label) {
    if ((payload?.ret ?? 0) !== 0 || (payload?.errcode ?? 0) !== 0) {
      throw new IlinkError(
        `${label}：ret=${payload?.ret} errcode=${payload?.errcode} ${payload?.errmsg ?? ''}`.trim(),
        { ret: payload?.ret, errcode: payload?.errcode },
      )
    }
  }

  /**
   * Ask the gateway for a pre-signed CDN upload target.
   *
   * The gateway is told both sizes and the plaintext MD5 *before* anything is
   * uploaded (`api/api.ts#getUploadUrl`), and the CDN later checks the bytes it
   * receives against them: `rawsize` is the file as it sits on disk, `filesize` is
   * what will actually be POSTed after PKCS#7 padding, and `rawfilemd5` is the
   * hash of the former. The key travels as its hex spelling because it is a `bytes`
   * proto field and JSON carries those as strings.
   *
   * @param {{ filekey: string, media_type: number, to_user_id: string, rawsize: number, rawfilemd5: string, filesize: number, thumb_rawsize?: number, thumb_rawfilemd5?: string, thumb_filesize?: number, no_need_thumb?: boolean, aeskey: string }} params - the upload descriptor.
   * @returns {Promise<{ upload_param?: string, upload_full_url?: string, thumb_upload_param?: string }>} the raw response; `upload_full_url` wins when present.
   */
  async getUploadUrl(params) {
    return this.#request('/ilink/bot/getuploadurl', {
      body: {
        filekey: params.filekey,
        media_type: params.media_type,
        to_user_id: params.to_user_id,
        rawsize: params.rawsize,
        rawfilemd5: params.rawfilemd5,
        filesize: params.filesize,
        // No thumbnail is generated here, and the official client says so
        // explicitly with `no_need_thumb: true` rather than leaving the three thumb
        // fields for the server to guess about. `undefined` keys are dropped by
        // JSON.stringify, which is exactly what the server expects for the rest.
        thumb_rawsize: params.thumb_rawsize,
        thumb_rawfilemd5: params.thumb_rawfilemd5,
        thumb_filesize: params.thumb_filesize,
        no_need_thumb: params.no_need_thumb ?? true,
        aeskey: params.aeskey,
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
    })
  }

  /**
   * POST one encrypted payload to the CDN and return the download parameter.
   *
   * Deliberately **not** {@link #request}: that helper signs the call with the iLink
   * bearer token, sets a JSON content type and parses the body. A CDN upload is a
   * bare `application/octet-stream` POST to a *pre-signed* URL — the credential is
   * the URL itself, so sending the bot token along would leak it to a third host —
   * and the value worth returning is a response **header**, not the body (official
   * `cdn/cdn-upload.ts` reads `x-encrypted-param` and never parses the body at all).
   *
   * Retry policy mirrors the official client: any 4xx fails immediately, because a
   * rejected `filekey` or an expired signature will not heal between attempts, while
   * 5xx, transport errors and a `200` that omits `x-encrypted-param` are retried up
   * to {@link ILINK_CDN_UPLOAD_ATTEMPTS} times.
   *
   * @param {{ ciphertext?: Buffer | Uint8Array, buf?: Buffer | Uint8Array, plaintext?: Buffer | Uint8Array, aeskey?: Buffer | Uint8Array, uploadFullUrl?: string, uploadParam?: string, filekey: string, cdnBaseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} params - the body and its target. Provide `ciphertext` to send it verbatim, or `buf`/`plaintext` plus `aeskey` to have it encrypted here (the official shape).
   * @returns {Promise<string>} `x-encrypted-param`, to be echoed in the media item.
   * @throws {IlinkError} when the upload never succeeded.
   */
  async uploadToCdn(params) {
    const ciphertext =
      params.ciphertext !== undefined
        ? Buffer.from(params.ciphertext)
        : encryptMediaEcb(params.buf ?? params.plaintext ?? Buffer.alloc(0), params.aeskey)
    if (ciphertext.length === 0) throw new IlinkError('iLink 上传失败：没有可上传的内容（0 字节）')
    const uploadFullUrl = String(params.uploadFullUrl ?? '').trim()
    const uploadParam = String(params.uploadParam ?? '')
    const filekey = String(params.filekey ?? '')
    const cdnBaseUrl = cdnUploadBaseUrl(params.cdnBaseUrl ?? this.#cdnBaseUrl)
    // `upload_full_url` is the server's own target and takes precedence; the
    // fallback spelling is assembled exactly as `cdn/cdn-url.ts` does.
    const url =
      uploadFullUrl !== ''
        ? uploadFullUrl
        : uploadParam !== '' && filekey !== ''
          ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
          : ''
    if (url === '') {
      throw new IlinkError('iLink 上传失败：网关没有返回上传地址（upload_full_url 与 upload_param 都是空的）')
    }
    const fetchImpl = params.fetchImpl ?? this.#fetch
    const timeoutMs = positiveOr(Number(params.timeoutMs ?? ILINK_UPLOAD_TIMEOUT_MS), ILINK_UPLOAD_TIMEOUT_MS)
    let lastError = null
    for (let attempt = 1; attempt <= ILINK_CDN_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          // A fresh copy per attempt: some fetch implementations detach the buffer
          // they were handed, and a retry then posts zero bytes.
          body: new Uint8Array(ciphertext),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.status >= 400 && response.status < 500) {
          const reason = response.headers.get('x-error-message') ?? (await response.text())
          throw new IlinkError(
            `iLink CDN 上传被拒绝：HTTP ${response.status}${reason ? ` — ${reason}` : ''}`.trim(),
            { status: response.status },
          )
        }
        if (response.status !== 200) {
          const reason = response.headers.get('x-error-message') ?? `HTTP ${response.status}`
          throw new IlinkError(`iLink CDN 上传失败：${reason}`, { status: response.status })
        }
        const downloadParam = response.headers.get('x-encrypted-param') ?? ''
        if (downloadParam === '') {
          throw new IlinkError('iLink CDN 上传响应里没有 x-encrypted-param 头，无法拼出下载参数')
        }
        return downloadParam
      } catch (error) {
        lastError = error
        const status = Number(error instanceof IlinkError ? (error.status ?? 0) : 0)
        if (status >= 400 && status < 500) throw error
        log.warn(
          `iLink CDN 上传第 ${attempt}/${ILINK_CDN_UPLOAD_ATTEMPTS} 次失败：${error instanceof Error ? error.message : error}`,
        )
      }
    }
    if (lastError instanceof IlinkError) throw lastError
    throw new IlinkError(
      `iLink CDN 上传失败（已重试 ${ILINK_CDN_UPLOAD_ATTEMPTS} 次）：${lastError instanceof Error ? lastError.message : lastError}`,
    )
  }

  /**
   * Run the whole outbound upload pipeline for one local file.
   *
   * Read → hash → encrypt → ask for a target → POST the ciphertext, which is
   * exactly the official order (`cdn/upload.ts#uploadMediaToCdn`). Doing the
   * encryption here rather than in the caller means the key exists in exactly one
   * function, and the caller only ever sees it in the hex spelling the *message*
   * needs.
   *
   * @param {{ filePath: string, toUserId: string, mediaType?: number, maxBytes?: number, timeoutMs?: number, cdnBaseUrl?: string, fetchImpl?: typeof fetch }} params - what to send, and where.
   * @returns {Promise<{ filekey: string, downloadParam: string, aeskeyHex: string, plainSize: number, cipherSize: number }>} the uploaded reference.
   * @throws {IlinkError} when the file is unusable or the upload failed.
   */
  async uploadMedia(params) {
    const filePath = String(params.filePath ?? '')
    let plaintext
    try {
      plaintext = readFileSync(filePath)
    } catch (error) {
      throw new IlinkError(
        `iLink 无法读取要发送的文件：${filePath}（${error instanceof Error ? error.message : error}）`,
      )
    }
    const rawsize = plaintext.length
    const maxBytes = positiveOr(Number(params.maxBytes ?? ILINK_UPLOAD_MAX_BYTES), ILINK_UPLOAD_MAX_BYTES)
    if (rawsize === 0) throw new IlinkError(`iLink 不能发送空文件（0 字节）：${filePath}`)
    if (rawsize > maxBytes) {
      throw new IlinkError(
        `iLink 文件太大：${filePath} 共 ${formatBytes(rawsize)}，超过上限 ${formatBytes(maxBytes)}`,
      )
    }
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
    const aeskey = randomBytes(16)
    const ciphertext = encryptMediaEcb(plaintext, aeskey)
    // PKCS#7 only ever grows the payload to a block boundary, so this equals
    // `aesEcbPaddedSize(rawsize)`. Taking it from the buffer that is about to be
    // sent keeps the declared `filesize` and the bytes on the wire from ever
    // disagreeing — the CDN checks exactly that.
    const filesize = ciphertext.length
    const filekey = randomBytes(16).toString('hex')
    const uploadUrl = await this.getUploadUrl({
      filekey,
      media_type: Number(params.mediaType ?? UPLOAD_MEDIA_TYPE.FILE),
      to_user_id: String(params.toUserId ?? ''),
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    })
    const uploadFullUrl = String(uploadUrl?.upload_full_url ?? '').trim()
    const uploadParam = String(uploadUrl?.upload_param ?? '')
    if (uploadFullUrl === '' && uploadParam === '') {
      throw new IlinkError('iLink 上传失败：网关没有返回上传地址（getuploadurl 响应里两者都为空）')
    }
    const downloadParam = await this.uploadToCdn({
      ciphertext,
      uploadFullUrl,
      uploadParam,
      filekey,
      cdnBaseUrl: params.cdnBaseUrl,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
    })
    log.debug(
      `iLink 媒体已上传：filekey=${filekey} 明文=${rawsize} 密文=${filesize} md5=${rawfilemd5}`,
    )
    return {
      filekey,
      downloadParam,
      aeskeyHex: aeskey.toString('hex'),
      plainSize: rawsize,
      cipherSize: filesize,
    }
  }

  /**
   * Send one already-built media item.
   *
   * Kept separate from {@link sendText} because the item is assembled by the
   * caller: an image item and a file item carry different fields (`mid_size` versus
   * `file_name` + `len`) and the upload pipeline is what knows them. The
   * acknowledgement contract is identical — `ret=0` means the gateway took it and
   * nothing more (openclaw#79293) — and so is the "one item per request" rule: a
   * caption is its own call, never a second entry in this `item_list`
   * (`messaging/send.ts#sendMediaItems`).
   *
   * @param {{ toUserId: string, contextToken?: string, item: any }} params - recipient and the item to send.
   * @returns {Promise<{ ret: number, accepted: true, delivered: 'unknown', detail: string }>} the gateway's acknowledgement.
   * @throws {IlinkError} when the gateway rejects the message (`ret`/`errcode` non-zero) or the request fails.
   */
  async sendMedia(params) {
    const payload = await this.#request('/ilink/bot/sendmessage', {
      body: {
        msg: {
          to_user_id: String(params.toUserId),
          from_user_id: '',
          client_id: randomUUID(),
          message_type: MESSAGE_TYPE.BOT,
          message_state: MESSAGE_STATE.FINISH,
          context_token: params.contextToken ?? '',
          item_list: [params.item],
        },
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
    })
    this.#assertGatewayAccepted(payload, 'iLink 媒体发送失败')
    return {
      ret: Number(payload?.ret ?? 0),
      accepted: true,
      delivered: 'unknown',
      detail: ILINK_ACCEPTED_DETAIL,
    }
  }

  /**
   * Fetch the per-user typing ticket needed to show the "…" indicator.
   *
   * @param {string} userId - the conversation partner.
   * @param {string} [contextToken] - the conversation's context token.
   * @returns {Promise<string>} the ticket, or an empty string.
   */
  async getTypingTicket(userId, contextToken = '') {
    const payload = await this.#request('/ilink/bot/getconfig', {
      body: {
        ilink_user_id: String(userId),
        context_token: contextToken,
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
    })
    return String(payload?.typing_ticket ?? '')
  }

  /**
   * Show or clear the native typing indicator.
   *
   * @param {{ userId: string, typingTicket: string, status: number }} params - indicator state.
   * @returns {Promise<void>} resolves when accepted.
   */
  async sendTyping(params) {
    await this.#request('/ilink/bot/sendtyping', {
      body: {
        ilink_user_id: String(params.userId),
        typing_ticket: params.typingTicket,
        status: params.status,
        base_info: { channel_version: ILINK_PROTOCOL_VERSION },
      },
    })
  }
}

/**
 * Run a complete QR login and return the credentials it produced.
 *
 * Scanning happens on the phone; this only asks for codes and watches the
 * status. The gateway reports several states that a naive loop would spin on
 * forever, and they are all handled here:
 *
 *   `scaned_but_redirect`  move polling to the IDC host the server names
 *   `need_verifycode`      WeChat is showing a pairing code; ask for the digits
 *   `verify_code_blocked`  too many wrong codes — this code is dead
 *   `binded_redirect`      this account is already bound to this client
 *   `expired`              issue a fresh code, a few times
 *   `wait`                 nothing has happened yet
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number, localTokenList?: string[], onQrCode?: (info: { qrcode: string, url: string, attempt: number }) => void, onStatus?: (status: string, detail?: { redirectHost?: string }) => void, onVerifyCode?: (info: { attempt: number }) => Promise<string> | string }} [options] - login options.
 * @returns {Promise<{ token: string, userId: string, botId: string, baseUrl: string, alreadyBound: boolean, qrUrl: string }>} credentials.
 */
export async function loginWithQrCode(options = {}) {
  const client = new IlinkClient({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl })
  const deadline = Date.now() + Number(options.timeoutMs ?? 480000)
  const localTokenList = Array.isArray(options.localTokenList)
    ? options.localTokenList.map((token) => String(token)).filter((token) => token !== '')
    : []
  let attempt = 0
  let issued = await client.getQrCode({ localTokenList })
  attempt += 1
  options.onQrCode?.({ ...issued, attempt })

  // Polling may be redirected to another IDC after the scan; keep the host here
  // rather than mutating the client, so the service base URL stays the configured
  // one for everything that follows the login.
  let pollBaseUrl = undefined
  let verifyCode = ''
  let wrongCodes = 0
  let scanReported = false

  while (Date.now() < deadline) {
    const status = await client.getQrStatus(issued.qrcode, { baseUrl: pollBaseUrl, verifyCode })

    if (status.status === 'confirmed' && status.token !== '') {
      return {
        token: status.token,
        userId: status.userId,
        botId: status.botId,
        baseUrl: status.baseUrl !== '' ? status.baseUrl : (options.baseUrl ?? ILINK_DEFAULT_BASE_URL),
        alreadyBound: false,
        qrUrl: issued.url,
      }
    }

    if (status.status === 'scaned_but_redirect' && status.redirectHost !== '') {
      pollBaseUrl = status.redirectHost.startsWith('http')
        ? status.redirectHost
        : `https://${status.redirectHost}`
      options.onStatus?.('scaned_but_redirect', { redirectHost: pollBaseUrl })
    } else if (status.status === 'need_verifycode') {
      if (typeof options.onVerifyCode !== 'function') {
        throw new IlinkError('微信要求输入手机上的配对码，但当前登录流程无法交互')
      }
      const entered = String((await options.onVerifyCode({ attempt: wrongCodes + 1 })) ?? '').trim()
      if (entered === '') throw new IlinkError('没有输入配对码，登录已取消')
      verifyCode = entered
      wrongCodes += 1
      options.onStatus?.('need_verifycode')
    } else if (status.status === 'verify_code_blocked') {
      throw new IlinkError('配对码连续输错，这个二维码已失效：请重新登录')
    } else if (status.status === 'binded_redirect') {
      // The server is telling us the scanned account is already wired to a bot
      // token this client holds; no new credentials are issued and nothing is
      // broken. The official plugin reports this as success, so do the same
      // rather than sending the operator to re-scan forever (#242).
      options.onStatus?.('binded_redirect')
      return {
        token: '',
        userId: '',
        botId: '',
        baseUrl: options.baseUrl ?? ILINK_DEFAULT_BASE_URL,
        alreadyBound: true,
        qrUrl: issued.url,
      }
    } else if (status.status === 'expired') {
      if (attempt >= 3) throw new IlinkError('二维码连续过期，请重新登录')
      issued = await client.getQrCode({ localTokenList })
      attempt += 1
      pollBaseUrl = undefined
      verifyCode = ''
      options.onQrCode?.({ ...issued, attempt })
    } else if (status.status === 'scaned' && !scanReported) {
      scanReported = true
      options.onStatus?.('scaned')
    } else if (status.status === 'wait' || status.status === 'scaned') {
      // Still queued, or a repeat of a state already reported: poll again.
    } else {
      // An unknown status must not look like progress, but it also must not
      // restart the loop with a stale code — surface it and keep waiting.
      options.onStatus?.(status.status)
    }

    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  throw new IlinkError('登录超时：请重新发起扫码')
}

/**
 * Resolve the configured `context_token` lifetime.
 *
 * Only a positive, finite number of milliseconds is honoured: a typo like
 * `contextTokenTtlMs: -1` or `"900"` must not silently disable the check, because
 * a token we believe in but the gateway has dropped is exactly the silent failure
 * this whole path exists to prevent. Anything else falls back to
 * {@link CONTEXT_TOKEN_TTL_MS}.
 *
 * @param {any} settings - `config.wechat.ilink`.
 * @returns {number} milliseconds, or Infinity when the check is switched off.
 */
export function resolveContextTokenTtlMs(settings) {
  // 0 is an explicit opt-out for an operator who has measured the real lifetime;
  // it is not the same as "no value configured".
  if (settings?.contextTokenTtlMs === 0) return Infinity
  const configured = Number(settings?.contextTokenTtlMs)
  if (Number.isFinite(configured) && configured > 0) return configured
  return CONTEXT_TOKEN_TTL_MS
}

/**
 * Render a TTL for the operator.
 * @param {number} ms - the lifetime in milliseconds.
 * @returns {string} e.g. `24 小时`, `5 分钟`, `不限期`.
 */
export function formatTtl(ms) {
  if (!Number.isFinite(ms)) return '不限期'
  if (ms >= 3600000) return `${Math.round((ms / 3600000) * 10) / 10} 小时`
  if (ms >= 60000) return `${Math.round(ms / 60000)} 分钟`
  if (ms >= 1000) return `${Math.round(ms / 1000)} 秒`
  return `${Math.round(ms)} 毫秒`
}

/**
 * The inbound provider: long-polls iLink, emits the same events every other
 * provider does, and sends replies back through the same client.
 */
export class IlinkBridge extends EventEmitter {
  #config
  #client
  #account
  #accountPath
  #cursorPath
  #cursor = ''
  #controller = null
  #running = false
  #connected = false
  /**
   * Whether the receive loop has ever completed a poll since {@link start}.
   *
   * Kept apart from {@link #connected} because that one flips back to false on a
   * dropped connection, and the health probe has to stay out of the stream during a
   * reconnect too — see {@link probe}, where calling `getUpdates` would take the
   * very message the loop is retrying for.
   */
  #everConnected = false
  /**
   * When the receive loop last started, and the last poll error it recorded.
   *
   * Together they let {@link probe} tell "the first poll is still in flight" apart
   * from "the first poll already failed". Without that distinction a bridge that is
   * merely *starting* looks identical to one that cannot reach the gateway at all —
   * and the console polls `/api/status` immediately after a QR scan, so the honest
   * answer there is 「正在连接」, never 「接收异常」.
   */
  #startedAt = 0
  #lastPollError = ''
  /**
   * Whether the gateway has told us the login is dead (`errcode -14`).
   *
   * The loop stops treating the stream as connected when that happens, but it keeps
   * retrying, so "disconnected" alone is not enough for {@link probe} to report:
   * `#everConnected` would still be true and a dead session would read as healthy.
   */
  #sessionExpired = false
  /**
   * userId → `{ token, at }`. Required for replies, learned from inbound messages.
   *
   * The timestamp is not bookkeeping for its own sake: the token is only ever
   * refreshed by another inbound message, so "how long ago did they write to us"
   * is the only signal we have for whether the gateway still accepts it
   * (openclaw#52153). See {@link CONTEXT_TOKEN_TTL_MS}.
   */
  #contextTokens = new Map()
  /**
   * Peers that have ever supplied a credential.
   *
   * Tracking this per peer (rather than as one process-wide flag) is what lets
   * {@link sendCredential} tell "this person has never written to the bot" from
   * "their credential went stale" — different stories, same fix, and an operator
   * debugging a silent reply needs to know which one they are in.
   */
  #peersWithCredential = new Set()
  /** How long a token stays usable; `Infinity` disables the check. */
  #contextTokenTtlMs
  /**
   * Media download seams and limits, or null when downloading is turned off.
   *
   * Read from `config.wechat.ilink`: `mediaDownload` (default on), `cdnBaseUrl`,
   * `mediaDir`, `maxBytes`, `mediaTimeoutMs`.
   */
  #media = null
  /**
   * Outbound upload seams and limits.
   *
   * Read from `config.wechat.ilink`: `uploadMaxBytes`, `uploadTimeoutMs`, and the
   * CDN base derived from `cdnBaseUrl` (see {@link cdnUploadBaseUrl}).
   */
  #upload = null
  /** userId → typing ticket, fetched lazily. */
  #typingTickets = new Map()

  /**
   * @param {any} config - the merged bridge config.
   * @param {{ account?: any, client?: IlinkClient }} [seams] - test seams.
   */
  constructor(config, seams = {}) {
    super()
    this.#config = config
    const settings = config?.wechat?.ilink ?? {}
    const statePath = String(settings.statePath ?? 'ilink-account.json')
    this.#accountPath = statePath
    this.#cursorPath = `${statePath}.cursor`
    this.#contextTokenTtlMs = resolveContextTokenTtlMs(settings)
    this.#media =
      settings.mediaDownload === false
        ? null
        : {
            cdnBaseUrl: cdnDownloadUrl(settings.cdnBaseUrl),
            tmpDir: String(settings.mediaDir ?? ''),
            maxBytes: Number(settings.maxBytes ?? ILINK_MEDIA_MAX_BYTES),
            timeoutMs: Number(settings.mediaTimeoutMs ?? 20000),
          }
    this.#account = seams.account ?? readAccount(statePath)
    // One CDN setting drives both directions: `wechat.ilink.cdnBaseUrl` holds the
    // download endpoint, and the upload base is recovered from it so a stub (or a
    // private deployment) only has to be pointed at one URL. See cdnUploadBaseUrl.
    const cdnBaseUrl = cdnUploadBaseUrl(settings.cdnBaseUrl ?? ILINK_CDN_DOWNLOAD_URL)
    this.#upload = {
      maxBytes: positiveOr(Number(settings.uploadMaxBytes ?? ILINK_UPLOAD_MAX_BYTES), ILINK_UPLOAD_MAX_BYTES),
      timeoutMs: positiveOr(Number(settings.uploadTimeoutMs ?? ILINK_UPLOAD_TIMEOUT_MS), ILINK_UPLOAD_TIMEOUT_MS),
      cdnBaseUrl,
    }
    this.#client =
      seams.client ??
      new IlinkClient({
        baseUrl: settings.baseUrl || this.#account?.baseUrl || ILINK_DEFAULT_BASE_URL,
        cdnBaseUrl,
        token: settings.token || this.#account?.token || '',
        timeoutMs: Number(settings.pollTimeoutMs ?? 40000) + 5000,
        appVersion: settings.clientVersion || ILINK_PROTOCOL_VERSION,
        routeTag: settings.routeTag ?? '',
      })
    if (settings.token) this.#account = { ...(this.#account ?? {}), token: String(settings.token) }
  }

  /**
   * Bot tokens this machine already holds, newest first.
   *
   * Sent on `get_bot_qrcode` so the gateway can recognise a scan from an account
   * that is already bound to one of them and answer `binded_redirect` instead of
   * failing the scan with a bare "network error" page.
   *
   * @returns {string[]} the tokens to disclose, capped at {@link LOCAL_TOKEN_LIST_MAX}.
   */
  localTokenList() {
    const settings = this.#config?.wechat?.ilink ?? {}
    const candidates = [
      String(settings.token ?? ''),
      String(this.#account?.token ?? ''),
      String(this.#client.token ?? ''),
    ]
    return [...new Set(candidates.filter((token) => token !== ''))].slice(-LOCAL_TOKEN_LIST_MAX)
  }

  /** @returns {boolean} whether the long-poll loop is live. */
  get connected() {
    return this.#connected
  }

  /** @returns {any} the stored account, if a QR login has ever completed. */
  get account() {
    return this.#account
  }

  /** @returns {string} where the credentials are stored. */
  get accountPath() {
    return this.#accountPath
  }

  /** @returns {boolean} whether a usable token is configured or stored. */
  get loggedIn() {
    return String(this.#client.token ?? '') !== ''
  }

  /**
   * Persist freshly minted credentials.
   *
   * A `binded_redirect` login holds no new token, so there is nothing to store:
   * writing the empty token would destroy working credentials on disk.
   *
   * @param {{ token: string, userId?: string, botId?: string, baseUrl?: string, alreadyBound?: boolean }} account - login result.
   * @returns {boolean} whether credentials were written.
   */
  saveAccount(account) {
    if (account?.alreadyBound === true || String(account?.token ?? '') === '') return false
    this.#account = { ...account, savedAt: new Date().toISOString() }
    writeAccount(this.#accountPath, this.#account)
    this.#client.setToken(account.token)
    return true
  }

  /**
   * Run a QR login that discloses this machine's existing tokens, and store the
   * result.
   *
   * @param {{ onQrCode?: (info: { qrcode: string, url: string, attempt: number }) => void, onStatus?: (status: string, detail?: { redirectHost?: string }) => void, onVerifyCode?: (info: { attempt: number }) => Promise<string> | string, timeoutMs?: number }} [options] - login callbacks.
   * @returns {Promise<{ token: string, userId: string, botId: string, baseUrl: string, alreadyBound: boolean, qrUrl: string, savedTo: string }>} the login result.
   */
  async refreshQrCode(options = {}) {
    const settings = this.#config?.wechat?.ilink ?? {}
    const account = await loginWithQrCode({
      baseUrl: settings.baseUrl || this.#client.baseUrl,
      timeoutMs: options.timeoutMs,
      localTokenList: this.localTokenList(),
      onQrCode: options.onQrCode,
      onStatus: options.onStatus,
      onVerifyCode: options.onVerifyCode,
    })
    this.saveAccount(account)
    return { ...account, savedTo: this.#accountPath }
  }

  /**
   * Start the long-poll loop.
   *
   * @returns {Promise<void>} resolves once polling has begun.
   */
  async start() {
    if (this.#running) return
    if (!this.loggedIn) {
      log.warn('iLink 尚未登录：请先在控制台点「扫码登录」或运行 node src/index.mjs --ilink-login')
      return
    }
    this.#running = true
    this.#controller = new AbortController()
    this.#startedAt = Date.now()
    this.#lastPollError = ''
    this.#sessionExpired = false
    this.#cursor = existsSync(this.#cursorPath) ? readFileSync(this.#cursorPath, 'utf8').trim() : ''
    log.info(`iLink 开始接收消息（${this.#client.baseUrl}）`)
    // A fresh process has no reply credential yet — iLink hands one over with the
    // next inbound message and never before — so say so instead of letting the
    // first reply fail silently. (openclaw#52153)
    const credential = this.sendCredential()
    if (credential.ready !== true) log.info(`iLink 发送凭证：${credential.detail}`)
    void this.#pollLoop()
  }

  /** The long-poll loop; runs until {@link stop}. @returns {Promise<void>} */
  async #pollLoop() {
    let consecutiveErrors = 0
    let timeoutMs = Number(this.#config?.wechat?.ilink?.pollTimeoutMs ?? 40000)
    while (this.#running && !this.#controller?.signal.aborted) {
      const startedAt = Date.now()
      try {
        const batch = await this.#client.getUpdates(this.#cursor, {
          timeoutMs,
          signal: this.#controller?.signal,
        })
        if (batch.errcode === ERRCODE_SESSION_EXPIRED) {
          log.error('iLink 登录已失效（errcode -14）：请在控制台重新扫码登录')
          // Remembered for the health probe: the loop keeps retrying after this, so
          // without the flag a dead session would be reported as 「正常」.
          this.#sessionExpired = true
          this.#connected = false
          this.emit('disconnected')
          await this.#sleep(30000)
          continue
        }
        if (batch.ret !== undefined && batch.ret !== 0) {
          throw new IlinkError(`getupdates 返回 ret=${batch.ret} ${batch.errmsg ?? ''}`.trim(), {
            ret: batch.ret,
            errcode: batch.errcode,
          })
        }
        consecutiveErrors = 0
        // Set before the `connected` flag: this is the record that the loop has
        // spoken to the gateway at least once, which the health probe uses to stay
        // out of the stream across a reconnect.
        this.#everConnected = true
        this.#lastPollError = ''
        this.#sessionExpired = false
        if (!this.#connected) {
          this.#connected = true
          this.emit('connected')
        }
        if (batch.longpollingTimeoutMs > 0) timeoutMs = batch.longpollingTimeoutMs + 5000
        for (const message of batch.msgs) {
          const event = normalizeIlinkMessage(message)
          if (event === null) continue
          // Remember the context token before emitting: a reply may be produced
          // within milliseconds, and without the token the gateway rejects it.
          // The stored timestamp restarts the TTL clock on every message, which
          // mirrors the server: the credential belongs to the user's *last*
          // message, not to the conversation (openclaw#52153).
          if (event.contextToken !== '') {
            this.#contextTokens.set(event.sessionId, { token: event.contextToken, at: Date.now() })
            this.#peersWithCredential.add(event.sessionId)
          }
          // Fetch and decrypt any attachment before emitting: the adapter turns
          // the bytes into a model attachment in the same tick, and an image that
          // arrives after that is just a `[图片]` the agent cannot see. Failure is
          // handled inside and always degrades to the placeholder text.
          await this.#hydrateMedia(event)
          this.emit('event', event)
        }
        if (batch.cursor !== '') {
          this.#cursor = batch.cursor
          try {
            writeFileSync(this.#cursorPath, this.#cursor, 'utf8')
          } catch (error) {
            log.debug(`无法写入 iLink 游标：${error instanceof Error ? error.message : error}`)
          }
        }
        // A poll that comes back immediately must still yield. A healthy gateway
        // holds the request for tens of seconds, so this never triggers in
        // production — but a fast empty answer (a stub, a proxy erroring out, a
        // gateway that stops long-polling) would otherwise turn this into a
        // microtask-only busy loop. That loop never reaches the timer phase, which
        // starves every `setTimeout` in the process: callbacks stop running and the
        // CPU pins. One short sleep keeps the poll rate sane and the loop alive.
        if (Date.now() - startedAt < ILINK_MIN_POLL_INTERVAL_MS) {
          await this.#sleep(ILINK_MIN_POLL_INTERVAL_MS - (Date.now() - startedAt))
        }
      } catch (error) {
        if (!this.#running) break
        if (error?.name === 'AbortError') continue
        consecutiveErrors += 1
        // Recorded for the health probe: a poll that actually failed is evidence the
        // gateway is unreachable, and 「正在连接」 must never cover for it.
        this.#lastPollError = error instanceof Error ? error.message : String(error)
        log.warn(`iLink 轮询出错（第 ${consecutiveErrors} 次）：${this.#lastPollError}`)
        await this.#sleep(consecutiveErrors >= 3 ? 30000 : 2000)
        if (consecutiveErrors >= 3) consecutiveErrors = 0
      }
    }
    this.#connected = false
  }

  /**
   * Download and decrypt one event's attachment, when it has one.
   *
   * @param {IlinkMessageEvent} event - the event, hydrated in place.
   * @returns {Promise<void>} resolves once the attempt finished.
   */
  async #hydrateMedia(event) {
    if (this.#media === null || event.media === undefined) return
    await hydrateIlinkMedia(event, this.#media)
  }

  /**
   * Drop expired reply credentials.
   *
   * Kept as a sweep rather than a timer: the map is small, and a stale entry is
   * only harmful at the moment someone tries to send with it, which is exactly
   * when {@link sendCredential} and {@link send} run.
   *
   * @returns {void}
   */
  #pruneContextTokens() {
    for (const [peerId, entry] of [...this.#contextTokens]) {
      if (this.#expired(entry)) this.#forgetContextToken(peerId)
    }
  }

  /** @returns {boolean} whether a stored credential has outlived the TTL. */
  #expired(entry) {
    if (!Number.isFinite(this.#contextTokenTtlMs)) return false
    return Date.now() - Number(entry?.at ?? 0) >= this.#contextTokenTtlMs
  }

  /**
   * Forget one peer's reply credential.
   *
   * The typing ticket goes with it: it was minted against the same token, so
   * keeping it would present a credential the gateway no longer honours.
   *
   * @param {string} peerId - the conversation partner.
   * @returns {void}
   */
  #forgetContextToken(peerId) {
    this.#contextTokens.delete(peerId)
    this.#typingTickets.delete(peerId)
  }

  /**
   * The reply credential for one peer, or an empty string when there is none.
   *
   * @param {string} peerId - the conversation partner.
   * @returns {string} the token to echo, or ''.
   */
  #contextTokenFor(peerId) {
    const entry = this.#contextTokens.get(peerId)
    if (entry === undefined) return ''
    if (this.#expired(entry)) {
      this.#forgetContextToken(peerId)
      return ''
    }
    return String(entry.token ?? '')
  }

  /**
   * Whether a reply can be sent right now, and why not when it cannot.
   *
   * iLink is passive: the credential comes down with the user's message, is
   * refreshed only by another message, and expires on its own (openclaw#52153).
   * "No credential" is therefore a normal state that the operator can fix from
   * their phone, not an error to bury — the console shows this verbatim.
   *
   * @param {string} [peerId] - ask about one conversation instead of all of them.
   * @returns {{ ready: boolean, state: 'ready'|'expired'|'none'|'logged-out', peers: number, detail: string }} the state.
   */
  sendCredential(peerId) {
    this.#pruneContextTokens()
    if (!this.loggedIn) {
      return {
        ready: false,
        state: 'logged-out',
        peers: 0,
        detail: '尚未扫码登录：请在控制台点「扫码登录」，或运行 node src/index.mjs --ilink-login',
      }
    }
    const target = peerId === undefined ? '' : String(peerId)
    if (target !== '') {
      const fresh = this.#contextTokenFor(target) !== ''
      const known = this.#peersWithCredential.has(target)
      return {
        ready: fresh,
        state: fresh ? 'ready' : known ? 'expired' : 'none',
        peers: fresh ? 1 : 0,
        detail: fresh ? this.#credentialReadyDetail(1) : this.#credentialMissingDetail(known),
      }
    }
    const peers = this.#contextTokens.size
    if (peers > 0) {
      return { ready: true, state: 'ready', peers, detail: this.#credentialReadyDetail(peers) }
    }
    const known = this.#peersWithCredential.size > 0
    return {
      ready: false,
      state: known ? 'expired' : 'none',
      peers: 0,
      detail: this.#credentialMissingDetail(known),
    }
  }

  /** @returns {string} the "you can send" wording. */
  #credentialReadyDetail(peers) {
    return `发送凭证已就绪（${peers} 个会话，${formatTtl(this.#contextTokenTtlMs)}内收到过消息即有效）`
  }

  /**
   * @param {boolean} hadOneBefore - whether this conversation ever had a credential.
   * @returns {string} the actionable "ask them to write first" wording.
   */
  #credentialMissingDetail(hadOneBefore) {
    // Both cases get the same instruction, because it is the same fix: send the
    // bot a message. Only the reason differs, and the operator needs the reason to
    // tell "nobody has written yet" from "the token went stale overnight".
    return hadOneBefore
      ? `发送凭证已过期（超过 ${formatTtl(this.#contextTokenTtlMs)} 没有收到对方消息）：请先在微信里给机器人发一条消息`
      : '尚未获得发送凭证：请先在微信里给机器人发一条消息（iLink 只能被动回复，凭证随对方消息下发）'
  }

  /**
   * Send one reply through iLink.
   *
   * The result separates three questions that used to be one boolean: did the
   * gateway take it (`accepted`), did the user get it (`delivered`), and what
   * should a human read (`detail`). `delivered` is `'unknown'` even on success,
   * because that is the honest answer — `ret=0` only means "received"
   * (openclaw#79293, 腾讯云 2212822) — and `'no'` only when the gateway rejected
   * it outright.
   *
   * @param {{ recipient?: string, text: string, peerId: string }} params - recipient and body.
   * @returns {Promise<{ ok: boolean, accepted: boolean, delivered: 'unknown'|'no', detail: string, ret?: number, errcode?: number }>} the outcome.
   */
  async send(params) {
    const toUserId = String(params.peerId ?? params.recipient ?? '')
    if (toUserId === '') {
      return { ok: false, accepted: false, delivered: 'no', detail: 'iLink 需要一个对话 id' }
    }
    // No credential means the send cannot work at all: say why, in the words the
    // operator can act on, instead of letting the gateway answer with an opaque
    // rejection (or worse, accepting a message nobody will ever see).
    const contextToken = this.#contextTokenFor(toUserId)
    if (contextToken === '') {
      const detail = this.#credentialMissingDetail(this.#peersWithCredential.has(toUserId))
      return { ok: false, accepted: false, delivered: 'no', detail }
    }
    try {
      const ack = await this.#client.sendText({ toUserId, text: params.text, contextToken })
      return {
        ok: true,
        accepted: true,
        delivered: 'unknown',
        detail: ack?.detail ?? `iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理（${toUserId}）`,
        ret: ack?.ret ?? 0,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // An IlinkError carrying any gateway code means the gateway answered and
      // refused the message; a bare network failure leaves it unknown whether the
      // request ever arrived.
      const rejected =
        error instanceof IlinkError &&
        (error.ret !== undefined || error.errcode !== undefined || Number(error.status ?? 0) !== 0)
      return {
        ok: false,
        accepted: false,
        delivered: rejected ? 'no' : 'unknown',
        detail,
        ...(error instanceof IlinkError && error.ret !== undefined ? { ret: error.ret } : {}),
        ...(error instanceof IlinkError && error.errcode !== undefined ? { errcode: error.errcode } : {}),
      }
    }
  }

  /**
   * Upload one local file and send it to a peer, with an optional caption.
   *
   * iLink is a passive channel — the reply credential arrives with the user's
   * message and expires on its own (openclaw#52153) — so this can fail before it
   * ever touches the file. Every one of those outcomes is *returned* as
   * `{ ok: false, detail }` with a sentence the operator can act on: an exception
   * here would abort the outbound path that called it and throw away the reason.
   *
   * The order follows the official client (`messaging/send.ts#sendMediaItems`): the
   * caption goes first as its own TEXT message, then the uploaded media as its own
   * item. iLink wants exactly one item per request, so "caption + attachment" is two
   * calls, never one call with two items. A caption the gateway rejects does *not*
   * cancel the file — the file is the whole reason this method exists — but the
   * failure is reported rather than swallowed.
   *
   * The extension decides the media type, because an image and a file are different
   * upload kinds on the wire ({@link UPLOAD_MEDIA_TYPE} is numbered differently from
   * {@link MESSAGE_ITEM_TYPE}). The protocol has no sniffing step: the official
   * sender routes on the file's MIME type, and an extension is the closest thing
   * available before the bytes are read.
   *
   * @param {{ peerId: string, filePath: string, text?: string }} params - recipient, file and caption.
   * @returns {Promise<{ ok: boolean, detail: string, delivered: 'unknown'|'no' }>} the outcome. Exactly these three keys: this is the contract other modules branch on.
   */
  async sendFile(params) {
    const toUserId = String(params?.peerId ?? '')
    if (toUserId === '') return { ok: false, detail: 'iLink 需要一个对话 id', delivered: 'no' }

    const rawPath = String(params?.filePath ?? '').trim()
    if (rawPath === '') return { ok: false, detail: '没有可发送的文件路径', delivered: 'no' }
    const filePath = resolve(rawPath)
    let size = 0
    try {
      const info = statSync(filePath)
      if (!info.isFile()) return { ok: false, detail: `不是一个文件：${filePath}`, delivered: 'no' }
      size = info.size
    } catch {
      // Missing and unreadable are the same answer to the operator: send a path
      // that exists. The underlying ENOENT/EACCES detail is already in the log.
      return { ok: false, detail: `文件不存在或读不到：${filePath}`, delivered: 'no' }
    }
    if (size === 0) {
      return { ok: false, detail: `文件是空的（0 字节），微信不会发送空文件：${filePath}`, delivered: 'no' }
    }
    const maxBytes = Number(this.#upload?.maxBytes ?? ILINK_UPLOAD_MAX_BYTES)
    if (size > maxBytes) {
      return {
        ok: false,
        delivered: 'no',
        detail: `文件太大：${basename(filePath)} 是 ${formatBytes(size)}，超过上限 ${formatBytes(maxBytes)}（可用 wechat.ilink.uploadMaxBytes 调大）`,
      }
    }

    // Same check {@link send} makes, and for the same reason: without a credential
    // the upload would succeed and the message would be rejected, which is the
    // worst of both worlds — bytes on the CDN and nothing on the phone.
    const contextToken = this.#contextTokenFor(toUserId)
    if (contextToken === '') {
      return {
        ok: false,
        delivered: 'no',
        detail: this.#credentialMissingDetail(this.#peersWithCredential.has(toUserId)),
      }
    }

    const caption = String(params?.text ?? '')
    let captionFailure = ''
    if (caption.trim() !== '') {
      const sent = await this.send({ peerId: toUserId, text: caption })
      if (sent.ok !== true) captionFailure = String(sent.detail ?? '')
    }

    const mediaType = IMAGE_FILE_EXTENSIONS.has(extname(filePath).replace(/^\./, '').toLowerCase())
      ? UPLOAD_MEDIA_TYPE.IMAGE
      : UPLOAD_MEDIA_TYPE.FILE
    const fileName = basename(filePath)
    try {
      const uploaded = await this.#client.uploadMedia({
        filePath,
        toUserId,
        mediaType,
        maxBytes: this.#upload?.maxBytes,
        timeoutMs: this.#upload?.timeoutMs,
        cdnBaseUrl: this.#upload?.cdnBaseUrl,
      })
      await this.#client.sendMedia({
        toUserId,
        contextToken,
        item: buildUploadedMediaItem({ mediaType, fileName, uploaded }),
      })
      const delivered = `文件已提交给网关（送达未确认）：${fileName}（${formatBytes(uploaded.plainSize)}）`
      return {
        ok: true,
        delivered: 'unknown',
        // Structural as well as textual: the file is the point of this call, so a
        // failed caption must not fail it — but a caller has to be able to notice
        // that part of the message was lost without string-matching a sentence.
        captionFailure,
        detail: captionFailure === '' ? delivered : `${delivered}；但说明文字发送失败：${captionFailure}`,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // An IlinkError carrying a code means the gateway (or the CDN) answered and
      // refused; a bare transport failure leaves it unknown whether the upload
      // landed — the same distinction {@link send} draws for text.
      const rejected =
        error instanceof IlinkError &&
        (error.ret !== undefined || error.errcode !== undefined || Number(error.status ?? 0) !== 0)
      const prefix = captionFailure === '' ? '' : `说明文字发送失败：${captionFailure}；`
      return { ok: false, detail: `${prefix}文件发送失败：${reason}`, delivered: rejected ? 'no' : 'unknown' }
    }
  }

  /**
   * Look up (and memoize) the ticket a typing indicator needs.
   *
   * @param {string} userId - the conversation partner.
   * @returns {Promise<string>} the ticket, or an empty string when unsupported.
   */
  async #typingTicketFor(userId) {
    let ticket = this.#typingTickets.get(userId)
    if (ticket === undefined) {
      ticket = await this.#client.getTypingTicket(userId, this.#contextTokenFor(userId))
      this.#typingTickets.set(userId, ticket)
    }
    return ticket
  }

  /**
   * Show or clear the native typing indicator.
   *
   * @param {string} peerId - the conversation partner.
   * @param {number} status - one of {@link TYPING_STATUS}.
   * @returns {Promise<void>} resolves once the request was made.
   */
  async #typing(peerId, status) {
    const userId = String(peerId ?? '')
    if (userId === '') return
    try {
      const ticket = await this.#typingTicketFor(userId)
      if (ticket === '') return
      await this.#client.sendTyping({ userId, typingTicket: ticket, status })
    } catch (error) {
      // The indicator is decoration: never let it break a reply.
      log.debug(`iLink 输入状态发送失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Show the native typing indicator, which iLink supports natively.
   *
   * @param {string} peerId - the conversation partner.
   * @returns {Promise<void>} resolves when the indicator was requested.
   */
  async setTyping(peerId) {
    await this.#typing(peerId, TYPING_STATUS.TYPING)
  }

  /**
   * Clear the typing indicator, which the gateway asks for just before sending.
   *
   * @param {string} peerId - the conversation partner.
   * @returns {Promise<void>} resolves when the request was made.
   */
  async clearTyping(peerId) {
    await this.#typing(peerId, TYPING_STATUS.CANCEL)
  }

  /**
   * Report whether the stored credential still works, and whether a reply could
   * be sent right now.
   *
   * The two are different questions on iLink: receiving keeps working while the
   * reply credential has expired, and an operator staring at "已登录" deserves to
   * be told that sending still needs a fresh inbound message (openclaw#52153).
   *
   * @returns {Promise<{ ok: boolean, detail: string, credential: { ready: boolean, state: string, peers: number, detail: string } }>} probe result.
   */
  /**
   * Sleep, but wake immediately when the loop is being stopped.
   *
   * `stop()` only flips a flag and aborts the controller, so a plain `setTimeout`
   * here makes shutdown wait out the longest backoff — up to 30 seconds after a dead
   * login or repeated poll errors — and that pending timer also holds the whole
   * process open. Racing the abort signal makes the loop leave on the next tick.
   *
   * @param {number} ms - how long to wait when nothing interrupts.
   * @returns {Promise<void>} resolves on timeout or on abort.
   */
  #sleep(ms) {
    const signal = this.#controller?.signal
    if (signal === undefined || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = null
      const onAbort = () => {
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * How long a freshly started receive loop may go without a completed poll before
   * {@link probe} calls it a failure.
   *
   * The first poll is a *long* poll: the gateway is entitled to hold it open for the
   * whole configured window, so a shorter grace would report a perfectly working
   * bridge as broken. The margin covers the client's own request timeout
   * (`pollTimeoutMs + 5s`) plus scheduling slack.
   *
   * @returns {number} milliseconds.
   */
  #startupGraceMs() {
    const configured = Number(this.#config?.wechat?.ilink?.pollTimeoutMs ?? 40000)
    const window = Number.isFinite(configured) && configured > 0 ? configured : 40000
    return window + 15000
  }

  /**
   * Health probe for the console.
   *
   * Two independent questions are answered here: is receiving alive, and can a
   * reply be sent right now. They really are separate on iLink — the long poll
   * keeps running while the reply credential has expired, and an operator staring
   * at 「已登录」 deserves to be told that sending still waits for a fresh inbound
   * message (openclaw#52153).
   *
   * The probe never polls while the receive loop is running. `getUpdates` does not
   * mean "look at the stream": the gateway hands the batch to whoever asks and
   * advances the cursor for them, so a second caller with the same cursor *takes*
   * those messages, and this method has nowhere to put them — the batch used to be
   * dropped on the floor. The console refreshes `/api/status` every few seconds,
   * so during a turn (when a user is most likely to type) a refresh landing right
   * after a message arrived would silently swallow it forever. Reporting the
   * loop's own state costs nothing and cannot lose anything; the loop already
   * probes the gateway every few seconds by definition. The condition is
   * `#everConnected` rather than `#connected` so this holds through a reconnect
   * too, where calling here would steal the message the loop is retrying for.
   *
   * Only a bridge that is *not* receiving makes a request of its own, which is the
   * one case where that request is the only source of truth.
   *
   * @returns {Promise<{ ok: boolean, detail: string, credential: { ready: boolean, state: string, peers: number, detail: string } }>} probe result.
   */
  async probe() {
    const credential = this.sendCredential()
    if (!this.loggedIn) {
      return { ok: false, detail: '尚未扫码登录；请在控制台点「扫码登录」', credential }
    }
    if (this.#running) {
      // A dead login outranks everything else: the loop keeps retrying, so it can
      // still look "connected at some point" while nothing will ever arrive.
      if (this.#sessionExpired) {
        return { ok: false, detail: '登录已失效（errcode -14），请重新扫码', credential }
      }
      // Never touch the stream here: see the note above. `#everConnected` means the
      // loop has completed at least one poll, which is exactly the evidence a probe
      // would be looking for.
      const connected = this.#connected || this.#everConnected
      // "Just started" is not "broken". The console asks for status immediately
      // after a QR scan, while the first long poll is still in flight — reporting
      // 接收异常 there would be alarming and wrong, so that window gets its own
      // answer. It is bounded by the configured poll window plus a margin, so it
      // cannot hide a gateway that never answers: once the window passes without a
      // single completed poll, this reports a failure like any other.
      const warmingUp =
        !connected &&
        this.#lastPollError === '' &&
        Date.now() - this.#startedAt < this.#startupGraceMs()
      if (connected) {
        return {
          ok: true,
          detail: `iLink 正常（${this.#client.baseUrl}，账号 ${this.#account?.userId ?? '未知'}）；${credential.detail}`,
          credential,
        }
      }
      if (warmingUp) {
        return {
          ok: true,
          detail: `接收循环已启动，正在等待第一批消息（${this.#client.baseUrl}，账号 ${this.#account?.userId ?? '未知'}）；${credential.detail}`,
          credential,
        }
      }
      const reason =
        this.#lastPollError === ''
          ? '接收循环启动后一直没有拿到任何一批消息，请检查网络或重新扫码'
          : `接收循环连不上网关：${this.#lastPollError}`
      return {
        ok: false,
        detail: `iLink 接收异常（${this.#client.baseUrl}，账号 ${this.#account?.userId ?? '未知'}）；${reason}；${credential.detail}`,
        credential,
      }
    }
    // Not receiving: the same reasoning applies, and asking the gateway here is not
    // a harmless health check either. `getUpdates` *hands over* a batch and nothing
    // would deliver it — the cursor lives in a file, and the gateway does not replay
    // what it has already given out. This window is not hypothetical: saving the
    // config rebuilds the stack (the adapter is stopped and a new one started) while
    // the console keeps polling status, so a message arriving during any save could
    // be swallowed. Report the state instead of consuming from the stream.
    return {
      ok: false,
      detail: `接收循环未启动（${this.#client.baseUrl}，账号 ${this.#account?.userId ?? '未知'}）；桥接启动后才会开始收消息；${credential.detail}`,
      credential,
    }
  }

  /**
   * Stop polling and release the socket.
   *
   * @returns {Promise<void>} resolves once the loop has stopped.
   */
  async stop() {
    this.#running = false
    this.#controller?.abort()
    this.#controller = null
    this.#connected = false
  }
}

/**
 * Read the stored iLink account.
 *
 * @param {string} path - credential file path.
 * @returns {any} the account, or null when absent or unreadable.
 */
export function readAccount(path) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write the iLink account, creating the directory if needed.
 *
 * @param {string} path - credential file path.
 * @param {any} account - the account to store.
 * @returns {void}
 */
export function writeAccount(path, account) {
  const directory = dirname(path)
  if (directory !== '' && directory !== '.' && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(path, `${JSON.stringify(account, null, 2)}\n`, 'utf8')
}

export { join as joinPath }
