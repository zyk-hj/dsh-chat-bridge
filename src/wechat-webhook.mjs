/**
 * Generic inbound webhook — the provider-agnostic way into the WeChat route.
 *
 * The lesson behind this file: every "read WeChat locally" tool is either
 * unstable, unreleased, or asks the user to supply a native decryption library.
 * So instead of betting on one of them, the bridge exposes a documented HTTP
 * endpoint that *any* tool can post to — a sender script of your own, a database
 * watcher, a phone-forwarding app, or a ten-line Python file.
 *
 *   POST /message        one inbound message
 *   POST /revoke         a message was recalled
 *   GET  /health         is the receiver up
 *
 * The payload is deliberately small and fault-tolerant: extra fields are
 * ignored, missing ones fall back to sensible defaults, and both snake_case and
 * camelCase keys are accepted so a caller does not have to read the source to
 * get it right.
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createLogger } from './util.mjs'

const log = createLogger('webhook')

/** Read the first present key, tolerating snake_case and camelCase callers. */
function pick(source, ...names) {
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/**
 * Normalize a posted payload into the event shape the adapter consumes.
 *
 * @param {Record<string, any>} body - the parsed request body.
 * @returns {import('./wechat-ilink.mjs').IlinkMessageEvent | null} the event, or null when unusable.
 */
export function normalizeWebhookEvent(body) {
  if (body === null || typeof body !== 'object') return null
  const sessionId = pick(body, 'sessionId', 'session_id', 'chatId', 'chat_id', 'roomId', 'room_id', 'wxid', 'talker')
  if (sessionId === undefined) return null
  const content = pick(body, 'content', 'text', 'message', 'msg') ?? ''
  const eventName = String(pick(body, 'event', 'type') ?? 'message.new')
  const isGroup = pick(body, 'sessionType', 'session_type', 'chatType', 'chat_type', 'isGroup', 'is_group')
  return {
    event: eventName.includes('revoke') ? 'message.revoke' : 'message.new',
    sessionId: String(sessionId),
    sessionType:
      isGroup === undefined
        ? String(sessionId).endsWith('@chatroom')
          ? 'group'
          : 'private'
        : isGroup === true || isGroup === 'group' || isGroup === 1 || isGroup === '1'
          ? 'group'
          : 'private',
    rawid: String(pick(body, 'rawid', 'rawId', 'id', 'messageId', 'message_id', 'svrid') ?? `${Date.now()}-${Math.random()}`),
    sourceName: String(pick(body, 'sourceName', 'source_name', 'sender', 'senderName', 'sender_name', 'nickname', 'from') ?? ''),
    groupName: pick(body, 'groupName', 'group_name', 'roomName', 'room_name'),
    content: String(content),
    timestamp: Number(pick(body, 'timestamp', 'time', 'createTime', 'create_time') ?? Math.floor(Date.now() / 1000)),
    isSend: pick(body, 'isSend', 'is_send', 'self', 'outgoing') === true || pick(body, 'isSend', 'is_send', 'self', 'outgoing') === 1,
  }
}

export class WeChatWebhook extends EventEmitter {
  #config
  #server = null

  /** @param {Record<string, any>} config - resolved bridge configuration. */
  constructor(config) {
    super()
    this.#config = config
  }

  /** @returns {number|null} the bound port (resolves `port: 0`). */
  get port() {
    const address = this.#server?.address()
    return address !== null && address !== undefined && typeof address === 'object' ? address.port : null
  }

  /** @returns {boolean} whether the receiver is listening. */
  get connected() {
    return this.#server !== null
  }

  /** @returns {string} a short label for status output. */
  get transportLabel() {
    return this.#server === null ? 'webhook(未启动)' : `webhook(:${this.port})`
  }

  async start() {
    const { host, port, path } = this.#config.wechat.webhook
    const endpoint = path === '' ? '/message' : path
    this.#server = createServer((request, response) => {
      void this.#route(request, response, endpoint)
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        reject(
          error?.code === 'EADDRINUSE'
            ? new Error(`微信入站端口 ${port} 已被占用，请改 wechat.webhook.port`)
            : error,
        )
      }
      this.#server.once('error', onError)
      this.#server.listen(port, host, () => {
        this.#server.off('error', onError)
        log.info(`微信入站接口已就绪：http://${host}:${this.port}${endpoint}`)
        resolve()
      })
    })
    return this
  }

  async stop() {
    if (this.#server === null) return
    const server = this.#server
    this.#server = null
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }

  async #route(request, response, endpoint) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === `${endpoint}/health`)) {
      sendJson(response, 200, { ok: true, provider: 'webhook' })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '只接受 POST' })
      return
    }
    const token = String(this.#config.wechat.webhook.token ?? '')
    if (token !== '') {
      const header = request.headers.authorization ?? ''
      const provided = header.startsWith('Bearer ') ? header.slice(7) : String(url.searchParams.get('token') ?? '')
      if (provided !== token) {
        log.warn('入站消息被拒绝：令牌不匹配')
        sendJson(response, 401, { error: '令牌不匹配' })
        return
      }
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Accept a single object or a batch, so a caller can flush a backlog.
    const payloads = Array.isArray(body) ? body : [body]
    let accepted = 0
    for (const payload of payloads) {
      const event = normalizeWebhookEvent(payload)
      if (event === null) continue
      accepted += 1
      this.emit('event', event)
    }
    if (accepted === 0) {
      sendJson(response, 400, { error: '缺少 sessionId（或 chatId / wxid / talker）字段' })
      return
    }
    // Answer before the agent runs: the caller is usually a tool waiting on a
    // simple ack, not on the reply.
    sendJson(response, 202, { ok: true, accepted })
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function readJson(request, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大（上限 8MB，图片请用 URL 而不是内联 base64）'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve(null)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}
