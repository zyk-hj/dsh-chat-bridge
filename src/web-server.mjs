/**
 * The bridge's HTTP surface — one listener serving three things:
 *
 *   `/`         the local chat page (same pipeline as a real chat message)
 *   `/console`  the desktop control console (status, settings, logs)
 *   `/api/*`    the admin API the console drives
 *   `/events`   server-sent events: transcript lines and log lines
 *
 * The listener deliberately survives a configuration rebuild, so the console
 * stays reachable while the runtime and bot transport restart underneath it.
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { CHAT_PAGE } from './chat-page.mjs'
import { CONSOLE_HTML } from './console-page.mjs'
import { createLogger, observeLogs } from './util.mjs'

const log = createLogger('web')

/** How many recent log lines to keep for a console that connects late. */
const LOG_BUFFER_SIZE = 300

export class WebServer extends EventEmitter {
  #config
  #gateway
  #app
  #server = null
  #clients = new Set()
  #logBuffer = []
  #unobserve = null

  /**
   * @param {Record<string, any>} config - resolved bridge configuration.
   * @param {import('./chat-gateway.mjs').ChatGateway} gateway - the live gateway.
   * @param {import('./bridge-app.mjs').BridgeApp} app - the owning application.
   */
  constructor(config, gateway, app) {
    super()
    this.#config = config
    this.#gateway = gateway
    this.#app = app
    this.#unobserve = observeLogs(({ level, scope, message }) => {
      const line = `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
      this.#logBuffer.push(line)
      if (this.#logBuffer.length > LOG_BUFFER_SIZE) this.#logBuffer.shift()
      this.push({ kind: 'log', text: line })
    })
    this.#attachGateway(gateway)
  }

  /** Point the console at a rebuilt gateway (after a settings change). */
  reattach(gateway, app) {
    this.#gateway = gateway
    if (app !== undefined) this.#app = app
    this.#attachGateway(gateway)
  }

  #attachGateway(gateway) {
    gateway.setWebSink((inbound, chunks, options) => {
      for (const chunk of chunks) {
        this.push({ kind: 'transcript', role: 'bot', text: chunk, transient: options?.transient === true })
      }
    })
  }

  /** @param {Record<string, unknown>} payload - an event for every connected page. */
  push(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of this.#clients) {
      try {
        client.write(frame)
      } catch {
        this.#clients.delete(client)
      }
    }
  }

  /** @returns {number|null} the bound port (useful with `port: 0`). */
  get port() {
    const address = this.#server?.address()
    return address !== null && address !== undefined && typeof address === 'object' ? address.port : null
  }

  async start() {
    const { host, port } = this.#config.web
    this.#server = createServer((request, response) => {
      void this.#route(request, response)
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        reject(
          error?.code === 'EADDRINUSE'
            ? new Error(`端口 ${this.#config.web.port} 已被占用：先关掉上一个桥接服务，或在配置里换 web.port`)
            : error,
        )
      }
      this.#server.once('error', onError)
      this.#server.listen(port, host, () => {
        this.#server.off('error', onError)
        log.info(`控制台与聊天页：http://${host}:${this.port}`)
        resolve()
      })
    })
  }

  async stop() {
    this.#unobserve?.()
    this.#unobserve = null
    for (const client of this.#clients) client.end()
    this.#clients.clear()
    if (this.#server === null) return
    const server = this.#server
    this.#server = null
    await new Promise((resolve) => server.close(resolve))
  }

  async #route(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const route = `${request.method} ${url.pathname}`
    try {
      switch (route) {
        case 'GET /':
          return sendHtml(response, CHAT_PAGE)
        case 'GET /console':
          return sendHtml(response, CONSOLE_HTML)
        case 'GET /events':
          return this.#subscribe(request, response)
        case 'GET /api/health':
          return sendJson(response, 200, this.#app.status())
        case 'GET /api/status':
          return sendJson(response, 200, this.#app.status())
        case 'GET /api/config':
          return sendJson(response, 200, { config: this.#config, configPath: this.#app.configPath, status: this.#app.status() })
        case 'GET /api/logs':
          return sendJson(response, 200, { lines: this.#logBuffer })
        case 'POST /api/config':
          return await this.#saveConfig(request, response)
        case 'POST /api/credentials':
          return await this.#saveCredentials(request, response)
        case 'POST /api/runtime/restart':
          return sendJson(response, 200, await this.#app.restartRuntime())
        case 'POST /api/runtime/test':
          return sendJson(response, 200, await this.#app.testRuntime())
        case 'POST /api/bot/reconnect':
          return sendJson(response, 200, await this.#app.restartOneBot())
        case 'GET /api/wechat/status':
          return sendJson(response, 200, await this.#app.wechatStatus())
        case 'POST /api/wechat/probe':
          return sendJson(response, 200, await this.#app.probeWeChatSender())
        case 'GET /api/wechat/ilink/login':
          return sendJson(response, 200, this.#app.ilinkLoginStatus())
        case 'POST /api/wechat/ilink/login':
          return await this.#startIlinkLogin(request, response)
        case 'POST /api/workspace/check':
          return await this.#checkWorkspace(request, response)
        case 'POST /api/send':
          return await this.#sendChat(request, response)
        default:
          return sendJson(response, 404, { error: `未知接口：${route}` })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`接口 ${route} 失败：${message}`)
      return sendJson(response, 400, { error: message })
    }
  }

  #subscribe(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write(': connected\n\n')
    this.#clients.add(response)
    request.on('close', () => this.#clients.delete(response))
  }

  async #saveConfig(request, response) {
    const body = await readJson(request)
    if (body === null || typeof body !== 'object') return sendJson(response, 400, { error: '请求体必须是 JSON 对象' })
    const status = await this.#app.saveConfig(body)
    return sendJson(response, 200, { ok: true, config: this.#config, configPath: this.#app.configPath, status })
  }

  async #saveCredentials(request, response) {
    const body = await readJson(request)
    if (body === null || typeof body !== 'object' || typeof body.apiKey !== 'string') {
      return sendJson(response, 400, { error: '需要 { apiKey: string }' })
    }
    const status = await this.#app.saveApiKey(body.apiKey)
    return sendJson(response, 200, { ok: true, status })
  }

  /**
   * Start the iLink QR login, or feed the pairing code it is waiting for.
   *
   * The body is optional: `{ verifyCode }` answers a phone-side pairing-code
   * challenge, an empty body starts (or joins) a scan. The reply is the login
   * state itself, so the page can render the QR link from it directly.
   *
   * @param {import('node:http').IncomingMessage} request - the POST request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   */
  async #startIlinkLogin(request, response) {
    const body = await readJson(request)
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      return sendJson(response, 400, { error: '需要 { verifyCode?: string }' })
    }
    return sendJson(response, 200, await this.#app.startIlinkLogin(body ?? {}))
  }

  /**
   * Inspect a candidate agent working directory.
   *
   * The console lets an operator retarget the agent's workspace, and the thing
   * that decides whether that will work is invisible from the path alone: DSH
   * writes its own explicit grant ACE onto the directory when it boots, and a
   * directory that already carries a stale one makes that step fail — which shows
   * up later as "the agent chats fine but every tool call reports an ACL error".
   * This endpoint surfaces that, plus a real write test.
   *
   * @param {import('node:http').IncomingMessage} request - the POST request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   */
  async #checkWorkspace(request, response) {
    const body = await readJson(request)
    const path = String(body?.path ?? '').trim()
    if (path === '') return sendJson(response, 400, { error: '需要 { path: string }' })
    return sendJson(response, 200, await this.#app.checkWorkspace({ path, create: body?.create === true }))
  }

  async #sendChat(request, response) {
    const body = await readJson(request)
    const text = String(body?.text ?? '')
    if (text.trim() === '') return sendJson(response, 400, { error: '消息内容为空' })
    sendJson(response, 202, { ok: true })
    void this.#gateway.handleInbound({
      chatKind: 'web',
      chatId: 'local',
      senderId: 'local',
      senderName: '本地测试',
      text,
      atSelf: true,
    })
  }
}

function sendHtml(response, html) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(html)
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function readJson(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
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
