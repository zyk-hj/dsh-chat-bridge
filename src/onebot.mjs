/**
 * OneBot V11 transport — the link between this bridge and a local bot
 * implementation such as NapCat, Lagrange, or LLOneBot.
 *
 * Four standard wirings are supported:
 *
 *   reverse   (default) the bridge dials the bot's WebSocket server — NapCat's
 *             "反向WebSocket" client. The access token rides as `?access_token=`.
 *   forward   the bridge listens and the bot dials in (NapCat's WebSocket
 *             server mode pointed at this bridge; also known as reverse-WS on
 *             the bot side). The RFC 6455 server side is implemented here.
 *   http-post the bot POSTs every event to `onebot.postPath` on this bridge.
 *   http-api  outbound-only fallback: actions go to `onebot.httpApi`, so a
 *             reply can still be sent while the socket is reconnecting.
 *
 * Inbound events are normalized into `message` events carrying the raw OneBot
 * event plus a `segments` array; everything else is the caller's business.
 */

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createLogger } from './util.mjs'

const log = createLogger('onebot')

const EVENT_POST_TYPES = new Set(['message', 'notice', 'request', 'meta_event'])
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Encode one server→client WebSocket text frame (unmasked, RFC 6455 §5.2). */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * A server-side WebSocket peer: frame decode for masked client frames, frame
 * encode for text replies, `send`/`close`, and `open`/`message`/`close` events.
 */
class ServerSocket extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #fragment = Buffer.alloc(0)
  #fragmentOpcode = 0
  readyState = 1

  /** @param {import('node:net').Socket} socket - the upgraded TCP socket. */
  constructor(socket) {
    super()
    this.#socket = socket
    socket.on('data', this.#onData)
    socket.on('close', () => this.#shutdown())
    socket.on('error', (error) => {
      log.debug('bot socket error:', error.message)
      this.#shutdown()
    })
    socket.setNoDelay(true)
  }

  /** Send one text frame. */
  send(text) {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.#socket.write(encodeFrame(text))
  }

  /** Send a close frame and tear the socket down. */
  close() {
    if (this.readyState !== 1) return
    this.readyState = 2
    try {
      this.#socket.write(Buffer.from([0x88, 0x00]))
    } catch {
      // the peer is already gone
    }
    this.#socket.end()
  }

  #shutdown() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  #onData = (chunk) => {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const frame = this.#readFrame()
      if (frame === null) return
      if (frame.opcode === 0x8) {
        this.close()
        return
      }
      if (frame.opcode === 0x9) {
        this.#socket.write(Buffer.from([0x8a, frame.payload.length]))
        this.#socket.write(frame.payload)
        continue
      }
      if (frame.opcode === 0xa) continue
      if (frame.opcode === 0x0) {
        this.#fragment = Buffer.concat([this.#fragment, frame.payload])
      } else {
        this.#fragment = frame.payload
        this.#fragmentOpcode = frame.opcode
      }
      if (frame.fin) {
        if (this.#fragmentOpcode === 0x1) this.emit('message', this.#fragment.toString('utf8'))
        this.#fragment = Buffer.alloc(0)
      }
    }
  }

  #readFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return null
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return null
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4]
      payload = unmasked
    }
    this.#buffer = buffer.subarray(offset + maskLength + length)
    return { fin, opcode, payload }
  }
}

export class OneBotClient extends EventEmitter {
  #config
  #socket = null
  #peers = new Set()
  #server = null
  #closed = false
  #reconnectTimer = null
  /** Consecutive failed dials; drives log verbosity and the backoff curve. */
  #dialAttempts = 0
  #pending = new Map()
  #nextEcho = 1

  /**
   * OneBot interprets CQ codes inside outbound text, so the gateway must escape
   * reply text before handing it over (see `ChatGateway#encodeText`).
   */
  escapesCqCodes = true

  /** @param {Record<string, any>} config - resolved bridge configuration. */
  constructor(config) {
    super()
    this.#config = config
  }

  /** @returns {boolean} whether a bot connection is usable for sending. */
  get connected() {
    if (this.#config.onebot.mode === 'forward') {
      for (const peer of this.#peers) if (peer.readyState === 1) return true
      return false
    }
    return this.#socket !== null && this.#socket.readyState === 1
  }

  /** @returns {string} a short label for status output. */
  get transportLabel() {
    if (this.connected) return `websocket(${this.#config.onebot.mode})`
    if (this.#config.onebot.mode === 'http-post') return 'http-post(receiving)'
    return this.#config.onebot.httpApi === '' ? 'offline' : 'http-api'
  }

  /**
   * @returns {number|null} the port the event listener actually bound (useful
   * with `port: 0`, which asks the OS for a free port).
   */
  get httpPort() {
    const address = this.#server?.address()
    return address !== null && address !== undefined && typeof address === 'object' ? address.port : null
  }

  /** Begin connecting (reverse) or listening (forward / http-post). Idempotent. */
  async start() {
    this.#closed = false
    if (this.#config.onebot.mode === 'reverse') this.#dial()
    else await this.#listen()
    return this
  }

  /** Stop reconnecting and close every socket and the listener. */
  async stop() {
    this.#closed = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    for (const peer of this.#peers) {
      try {
        peer.close()
      } catch {
        // already gone
      }
    }
    this.#peers.clear()
    try {
      this.#socket?.close()
    } catch {
      // already gone
    }
    this.#socket = null
    if (this.#server !== null) {
      const server = this.#server
      this.#server = null
      await new Promise((resolve) => server.close(resolve))
    }
  }

  #dial() {
    const { url, accessToken } = this.#config.onebot
    const target =
      accessToken === '' ? url : `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`
    // One bot that is simply not running should not fill the log: the WeChat side
    // is the common case and its log is unreadable if every three seconds prints a
    // line about QQ. The first few attempts are worth reporting; after that the
    // retries drop to debug and only a periodic summary stays at info.
    this.#dialAttempts += 1
    if (this.#dialAttempts <= 2) log.info(`connecting to bot: ${url}`)
    else if (this.#dialAttempts % 20 === 0) {
      log.info(`bot 仍未连上（已尝试 ${this.#dialAttempts} 次）：${url} —— 没在用 QQ 的话可以在配置里把 onebot.mode 设为 off`)
    } else log.debug(`connecting to bot: ${url}`)
    let socket
    try {
      socket = new WebSocket(target)
    } catch (error) {
      log.warn(`bot connection failed: ${error instanceof Error ? error.message : error}`)
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      this.#dialAttempts = 0
      log.info('bot connected (reverse websocket)')
      this.emit('connected')
    })
    socket.addEventListener('message', (message) => {
      this.#ingest(typeof message.data === 'string' ? message.data : String(message.data))
    })
    socket.addEventListener('error', () => log.debug('bot socket error'))
    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = null
      if (!this.#closed) this.#scheduleReconnect()
    })
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer !== null) return
    // Back off towards a minute so a bot that is simply absent costs one line per
    // minute instead of one per reconnectDelayMs, and recovers quickly once it
    // actually appears.
    const base = Number(this.#config.onebot.reconnectDelayMs) || 3000
    const delay = Math.min(base * 2 ** Math.min(this.#dialAttempts, 5), 60000)
    const timer = setTimeout(() => {
      this.#reconnectTimer = null
      if (!this.#closed) this.#dial()
    }, delay)
    // Never let a pending retry hold the process open: with a 60 s ceiling this
    // timer would otherwise keep a test run (or a shutting-down bridge) alive for
    // up to a minute after everything else had finished.
    timer.unref?.()
    this.#reconnectTimer = timer
  }

  async #listen() {
    const { host, port, path, accessToken } = this.#config.onebot
    const wsPath = path === '' ? '/onebot' : path
    const postPath = this.#config.onebot.postPath === '' ? '/onebot/event' : this.#config.onebot.postPath

    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method === 'POST' && (url.pathname === postPath || url.pathname === '/')) {
        this.#handleHttpPost(request, response)
        return
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, transport: this.transportLabel }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found\n')
    })

    if (this.#config.onebot.mode === 'forward') {
      this.#server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
        if (url.pathname !== wsPath) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        if (accessToken !== '' && url.searchParams.get('access_token') !== accessToken) {
          log.warn('rejected a bot connection with a wrong access token')
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        const key = request.headers['sec-websocket-key']
        if (typeof key !== 'string') {
          socket.destroy()
          return
        }
        const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        void head
        const peer = new ServerSocket(socket)
        this.#peers.add(peer)
        log.info('bot connected (forward websocket)')
        this.emit('connected')
        peer.on('message', (text) => this.#ingest(text))
        peer.on('close', () => this.#peers.delete(peer))
      })
    }

    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, host, () => {
        const what = this.#config.onebot.mode === 'forward' ? `ws://${host}:${port}${wsPath}` : `http://${host}:${port}${postPath}`
        log.info(`listening for the bot on ${what}`)
        resolve()
      })
    })
  }

  #handleHttpPost(request, response) {
    const { accessToken } = this.#config.onebot
    if (accessToken !== '') {
      const header = request.headers.authorization ?? ''
      const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (provided !== accessToken) {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('unauthorized\n')
        return
      }
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(204)
      response.end()
      const body = Buffer.concat(chunks).toString('utf8')
      if (body.trim() === '') return
      try {
        const payload = JSON.parse(body)
        if (Array.isArray(payload)) for (const item of payload) this.#ingestObject(item)
        else this.#ingestObject(payload)
      } catch {
        log.warn('ignoring a malformed HTTP event report')
      }
    })
  }

  #ingest(text) {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      log.warn('ignoring a non-JSON frame from the bot')
      return
    }
    this.#ingestObject(payload)
  }

  #ingestObject(payload) {
    if (payload === null || typeof payload !== 'object') return
    const { echo, post_type: postType } = payload
    if (typeof echo === 'string' && this.#pending.has(echo)) {
      const entry = this.#pending.get(echo)
      this.#pending.delete(echo)
      entry.resolve(payload)
      return
    }
    if (typeof postType !== 'string' || !EVENT_POST_TYPES.has(postType)) return
    if (postType === 'message' && Array.isArray(payload.message)) {
      // Normalize string-format segments into objects when the bot sent an array
      // of strings (rare, but some implementations do it).
      payload.message = payload.message.map((segment) =>
        typeof segment === 'string' ? { type: 'text', data: { text: segment } } : segment,
      )
    }
    this.emit('event', payload)
  }

  /**
   * Invoke one OneBot action.
   * @param {string} action - OneBot action name, e.g. `send_private_msg`.
   * @param {Record<string, any>} params - action parameters.
   * @returns {Promise<any>} the action result payload.
   */
  async call(action, params) {
    if (this.connected) return this.#callOverSocket(action, params)
    const httpApi = this.#config.onebot.httpApi
    if (httpApi !== '') return this.#callOverHttp(httpApi, action, params)
    throw new Error(`bot is not connected and onebot.httpApi is not configured (action: ${action})`)
  }

  #callOverSocket(action, params) {
    const socket = this.#config.onebot.mode === 'forward' ? [...this.#peers].find((peer) => peer.readyState === 1) : this.#socket
    if (socket === null || socket === undefined || socket.readyState !== 1) {
      return Promise.reject(new Error(`bot socket is not open (action: ${action})`))
    }
    const echo = `b${this.#nextEcho++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`bot did not answer ${action} within 15s`))
      }, 15000)
      this.#pending.set(echo, {
        resolve: (payload) => {
          clearTimeout(timer)
          resolve(payload)
        },
      })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(echo)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #callOverHttp(base, action, params) {
    const url = `${base.replace(/\/$/, '')}/${action}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#config.onebot.accessToken === '' ? {} : { authorization: `Bearer ${this.#config.onebot.accessToken}` }),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`bot HTTP API ${action} failed: HTTP ${response.status}`)
    const payload = await response.json().catch(() => null)
    if (payload !== null && typeof payload === 'object' && typeof payload.status === 'string' && payload.status !== 'ok') {
      throw new Error(`bot HTTP API ${action} returned ${payload.status}: ${payload.msg ?? payload.wording ?? ''}`)
    }
    return payload
  }

  /**
   * Send one chat message.
   * @param {{ kind: 'private'|'group', peerId: number|string, segments: Array<Record<string, any>> }} target
   * @returns {Promise<any>} the action result.
   */
  send(target) {
    const params = { message: target.segments, auto_escape: false }
    if (target.kind === 'group') return this.call('send_group_msg', { group_id: Number(target.peerId), ...params })
    return this.call('send_private_msg', { user_id: Number(target.peerId), ...params })
  }

  /**
   * Best-effort typing indicator; a bot without the API must not break a reply.
   * @param {{ kind: 'private'|'group', peerId: number|string }} target
   * @param {boolean} [status] - whether the bot is typing.
   */
  async setTyping(target, status = true) {
    if (target.kind !== 'group') return
    try {
      await this.call('set_group_typing', { group_id: Number(target.peerId), status })
    } catch {
      // optional API
    }
  }

  /** @returns {string} a fresh action echo id (used by tests). */
  static newEcho() {
    return randomUUID()
  }
}
