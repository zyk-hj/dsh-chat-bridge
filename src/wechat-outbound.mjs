/**
 * Outbound strategies — interchangeable ways to get a reply into WeChat.
 *
 *   `ilink`    reply through WeChat's own bot API. Official, needs no window and
 *              no extra tool, and is the only route that works against a current
 *              client. It only reaches the account that scanned the QR code, and
 *              only while that account's `context_token` is fresh.
 *   `command`  run a program or script of your own — the tool you already have for
 *              sending. The bridge passes the recipient and text as arguments and
 *              reads a JSON result.
 *   `http`     POST to an HTTP endpoint your own tool exposes.
 *
 * Two desktop strategies used to live here (`uia` and `weixin`). They were removed
 * after being measured on a real machine: WeChat 4.x draws its whole interface
 * itself, so there is no control tree to address, and driving the window with real
 * mouse and keyboard reported success while delivering nothing. `config.mjs` keeps
 * the details next to `defaultConfig()`.
 */

import { spawn } from 'node:child_process'
import { createLogger } from './util.mjs'

const log = createLogger('wechat-send')

/**
 * @typedef {object} SendResult
 * @property {boolean} ok - whether the message was handed off successfully.
 * @property {string} detail - human-readable outcome.
 */

/**
 * Build the outbound sender named by the configuration.
 *
 * @param {Record<string, any>} config - resolved bridge configuration.
 * @param {{ send: (p: { text: string, peerId: string }) => Promise<SendResult>, probe: () => Promise<SendResult>, loggedIn?: boolean } | null} [ilink]
 *   The iLink bridge, when that is the running provider: replies go back over the
 *   same official API the messages arrived on, which is also the only way to echo
 *   the `context_token` the gateway expects.
 * @returns {{ strategy: string, send: (params: { recipient: string, text: string, peerId: string }) => Promise<SendResult>, probe: () => Promise<SendResult>, lastResult: () => SendResult | null }}
 */
export function createSender(config, ilink = null) {
  const strategy = String(config.wechat.sendStrategy ?? 'ilink')
  switch (strategy) {
    case 'ilink':
      return ilinkSender(ilink)
    case 'command':
      return commandSender(config)
    case 'http':
      return httpSender(config)
    default:
      return {
        strategy,
        async send() {
          return { ok: false, detail: `未知的发送方式 "${strategy}"（可选 ilink / command / http）` }
        },
        async probe() {
          return { ok: false, detail: `未知的发送方式 "${strategy}"` }
        },
        lastResult: () => null,
      }
  }
}

/**
 * iLink: reply over WeChat's official bot API.
 *
 * The peer id is the sender's user id, and the reply must echo the context token
 * that came with their message, so the bridge has to be the same instance that
 * received it — hence the explicit null check rather than a fallback.
 *
 * @param {{ send: (p: { text: string, peerId: string }) => Promise<SendResult>, probe: () => Promise<SendResult> } | null} bridge - the iLink bridge.
 * @returns {{ strategy: string, send: Function, probe: Function, lastResult: () => SendResult | null }} the sender.
 */
function ilinkSender(bridge) {
  if (bridge === null) {
    return {
      strategy: 'ilink',
      async send() {
        return { ok: false, detail: 'iLink 发送不可用：入站方式不是 ilink（请把 wechat.inbound 也设为 ilink）' }
      },
      async sendFile() {
        return { ok: false, detail: 'iLink 发送不可用：入站方式不是 ilink（请把 wechat.inbound 也设为 ilink）' }
      },
      async probe() {
        return { ok: false, detail: 'iLink 未启用' }
      },
      lastResult: () => null,
    }
  }
  let last = null
  return {
    strategy: 'ilink',
    async send({ text, peerId }) {
      last = await bridge.send({ text, peerId })
      return last
    },
    // Uploading a file is a different code path from sending text (getuploadurl →
    // CDN POST → sendmessage with a media item), so it gets its own entry point
    // rather than being smuggled through `send` as a special text payload.
    async sendFile({ filePath, text, peerId }) {
      last = await bridge.sendFile({ filePath, text, peerId })
      return last
    },
    async probe() {
      return bridge.probe()
    },
    lastResult: () => last,
  }
}

/**
 * External command: the bridge appends the recipient and the text as the last two
 * arguments, then reads stdout.
 *
 * A tool that prints nothing still counts as success (many CLI senders are
 * silent), while a non-zero exit code is a failure. Printing
 * `{"ok":true,"detail":"…"}` gives the console a better message.
 */
function commandSender(config) {
  const { command, args, timeoutMs } = config.wechat.command
  if (String(command).trim() === '') {
    return {
      strategy: 'command',
      async send() {
        return { ok: false, detail: 'wechat.command.command 未配置' }
      },
      async probe() {
        return { ok: false, detail: 'wechat.command.command 未配置' }
      },
      lastResult: () => null,
    }
  }
  let last = null

  /**
   * @param {{ recipient: string, text: string, peerId: string }} params - the message.
   * @returns {Promise<SendResult>} the outcome.
   */
  const run = (params) =>
    new Promise((resolve) => {
      const argv = [...args, params.recipient, params.text]
      log.debug(`执行发送命令：${command} ${argv.map((a) => (a.length > 20 ? `${a.slice(0, 20)}…` : a)).join(' ')}`)
      let settled = false
      // `timer` is assigned after `spawn`, so a synchronous failure inside
      // `spawn` (or the try/catch below) must be able to call `finish` before it
      // exists — hence the guard rather than a direct clearTimeout.
      let timer = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        last = result
        resolve(result)
      }
      let child
      try {
        child = spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, detail: `无法启动发送命令：${error.message}` })
        return
      }
      timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, detail: `发送命令超过 ${timeoutMs}ms 未结束` })
      }, timeoutMs)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => finish({ ok: false, detail: `发送命令启动失败：${error.message}` }))
      child.on('close', (code) => {
        const line = stdout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.startsWith('{'))
          .pop()
        let parsed = null
        if (line !== undefined) {
          try {
            parsed = JSON.parse(line)
          } catch {
            parsed = null
          }
        }
        if (parsed !== null && typeof parsed.ok === 'boolean') {
          finish({ ok: parsed.ok, detail: String(parsed.detail ?? (parsed.ok ? '已发送' : '发送失败')) })
          return
        }
        if (code === 0) {
          finish({ ok: true, detail: '发送命令执行成功' })
          return
        }
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ')
        finish({ ok: false, detail: `发送命令退出码 ${code}${tail === '' ? '' : `：${tail}`}` })
      })
    })

  return {
    strategy: 'command',
    send: run,
    async probe() {
      return { ok: true, detail: `已配置发送命令：${command}（真正发送时才会执行）` }
    },
    lastResult: () => last,
  }
}

/** HTTP endpoint: POST a small JSON body to whatever service you run. */
function httpSender(config) {
  const { url, token, timeoutMs } = config.wechat.http
  if (String(url).trim() === '') {
    return {
      strategy: 'http',
      async send() {
        return { ok: false, detail: 'wechat.http.url 未配置' }
      },
      async probe() {
        return { ok: false, detail: 'wechat.http.url 未配置' }
      },
      lastResult: () => null,
    }
  }
  let last = null
  return {
    strategy: 'http',
    async send({ recipient, text, peerId }) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ recipient, text, peerId }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await response.text()
        const ok = response.ok
        last = { ok, detail: ok ? `HTTP ${response.status}` : `HTTP ${response.status}：${body.slice(0, 200)}` }
        return last
      } catch (error) {
        last = { ok: false, detail: error instanceof Error ? error.message : String(error) }
        return last
      }
    },
    async probe() {
      try {
        const response = await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(5000) })
        return { ok: true, detail: `端点可达（HTTP ${response.status}；发送用 POST）` }
      } catch (error) {
        return { ok: false, detail: `端点不可达：${error instanceof Error ? error.message : String(error)}` }
      }
    },
    lastResult: () => last,
  }
}