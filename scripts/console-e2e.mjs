#!/usr/bin/env node
/**
 * Console end-to-end self-test.
 *
 * Boots a real `BridgeApp` with an HTTP listener on a free port, then drives
 * every admin endpoint the console uses — status, config read, config write with
 * a live rebuild, runtime restart, the template probe, credential save, log
 * fetch, an invalid-config rejection, and the iLink QR login against a stub
 * gateway (state machine, concurrency guard, pairing code, already-bound,
 * expired) — everything runs in this one process, so a hang is attributable to
 * the code under test rather than to the harness.
 *
 *   node scripts/console-e2e.mjs
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { BridgeApp, readCredentials } from '../src/bridge-app.mjs'
import { defaultConfig, deepMerge } from '../src/config.mjs'
import { configureLogging, createLogger } from '../src/util.mjs'

const log = createLogger('console-e2e')
configureLogging('info')

let failures = 0
/** @param {string} name - check name. @param {boolean} ok - result. @param {string} [note] - detail. */
function assert(name, ok, note = '') {
  if (ok) console.log(`  ✓ ${name}${note === '' ? '' : ` — ${note}`}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${note === '' ? '' : ` — ${note}`}`)
  }
}

/** Call the console API with a hard timeout so a hang fails fast. */
async function call(base, path, options = {}, timeoutMs = 120000) {
  const started = Date.now()
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  return { status: response.status, payload, ms: Date.now() - started }
}

/** Poll `/api/status` while a long request is in flight, to expose stalls. */
function watch(getStatus, label) {
  const started = Date.now()
  const timer = setInterval(async () => {
    try {
      const status = await getStatus()
      log.info(`  … ${label} ${((Date.now() - started) / 1000).toFixed(0)}s progress=${status.progress ?? '-'}`)
    } catch {
      // the server may be briefly unavailable while it rebuilds
    }
  }, 4000)
  return () => clearInterval(timer)
}

/**
 * A stand-in for the iLink gateway.
 *
 * The QR login state machine is what this exercises, so the stub answers from
 * `state.mode` rather than from a queue of replies: a reply is a pure function of
 * the request, so a duplicate or retried poll cannot desync the script (which is
 * exactly what a consumable queue did — the verify-code poll was answered with
 * "wait" forever because an extra request had eaten its queue entry).
 *
 *   `scan`    the first two polls report the scan, the third confirms
 *   `verify`  confirms only a poll that carries the code the operator typed
 *   `bind`    always `binded_redirect` (the account is already bound)
 *   `expire`  always `expired`
 *
 * `confirmed` mints its token from the QR session id in the request, so the
 * stored credential is deterministic per session.
 *
 * @returns {{ state: { url: string, mode: string, qrIssued: number, statusPolls: number, scanPolls: number, updates: number, verifyCode: string, requests: Array<{ mode: string, qrcode: string, verifyCode: string }> }, server: import('node:http').Server }} the stub.
 */
function startIlinkStub() {
  const state = {
    url: '',
    mode: 'scan',
    qrIssued: 0,
    statusPolls: 0,
    scanPolls: 0,
    updates: 0,
    verifyCode: '',
    /** Every status poll, for diagnosing a failure. */
    requests: [],
  }
  const confirmed = (qrcode) => ({
    status: 'confirmed',
    bot_token: `stub-token-${qrcode}`,
    ilink_user_id: 'stub-user',
    ilink_bot_id: 'stub-bot',
    baseurl: state.url,
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      state.qrIssued += 1
      return send({ qrcode: `stub-qr-${state.qrIssued}`, qrcode_img_content: `${state.url}/qr/stub-qr-${state.qrIssued}` })
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      const qrcode = url.searchParams.get('qrcode') ?? ''
      const verifyCode = url.searchParams.get('verify_code') ?? ''
      state.statusPolls += 1
      state.requests.push({ mode: state.mode, qrcode, verifyCode })
      log.info(`  · 桩网关 status#${state.statusPolls} mode=${state.mode} qrcode=${qrcode} verify=${verifyCode === '' ? '-' : verifyCode}`)
      if (state.mode === 'expire') return send({ status: 'expired' })
      if (state.mode === 'bind') return send({ status: 'binded_redirect' })
      if (state.mode === 'verify') {
        return send(verifyCode !== '' && verifyCode === state.verifyCode ? confirmed(qrcode) : { status: 'need_verifycode' })
      }
      state.scanPolls += 1
      return send(state.scanPolls >= 3 ? confirmed(qrcode) : { status: 'scaned' })
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      state.updates += 1
      request.resume()
      // Hold the long poll open the way the real gateway does: answering
      // instantly would spin the receive loop at full speed.
      const timer = setTimeout(() => {
        if (response.writableEnded || response.destroyed) return
        send({ ret: 0, msgs: [], get_updates_buf: `stub-cursor-${state.updates}`, longpolling_timeout_ms: 800 })
      }, 700)
      response.on('close', () => clearTimeout(timer))
      return
    }
    return send({ ret: 0 })
  })
  return { state, server }
}

/** Poll the console until the login flow leaves its running states. */
async function waitForIlink(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = (await call(base, '/api/wechat/ilink/login', {}, 10000)).payload
    if (last?.running !== true && ['confirmed', 'failed', 'expired'].includes(String(last?.state))) return last
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return last
}

const home = mkdtempSync(join(tmpdir(), 'bridge-e2e-home-'))
const configPath = join(mkdtempSync(join(tmpdir(), 'bridge-e2e-conf-')), 'bridge.config.yaml')
// A fixed port: `port: 0` is legal for the library but not for a stored config,
// and the console path validates what it is about to persist.
const port = 8899

// The WeChat route runs against a local stub, so a scan can be driven end to end
// without WeChat and without any call leaving this machine.
const ilinkStub = startIlinkStub()
await new Promise((resolve, reject) => {
  ilinkStub.server.once('error', reject)
  ilinkStub.server.listen(0, '127.0.0.1', resolve)
})
ilinkStub.state.url = `http://127.0.0.1:${ilinkStub.server.address().port}`
const ilinkStatePath = join(home, 'ilink-account.json')

const config = deepMerge(defaultConfig(), {
  web: { enabled: true, host: '127.0.0.1', port },
  onebot: { mode: 'off' },
  dsh: { cwd: process.cwd(), reasoningEffort: 'low' },
  chat: { prewarmCount: 0, ackOnBusy: false },
  wechat: {
    enabled: true,
    inbound: 'ilink',
    sendEnabled: false,
    ilink: { baseUrl: ilinkStub.state.url, statePath: ilinkStatePath },
  },
})
const app = new BridgeApp({ config, configPath, baseline: structuredClone(config), home, consoleOnly: false })

console.log('\n[控制台端到端自测]')
const bootStarted = Date.now()
await app.start()
const base = `http://127.0.0.1:${port}`
assert('应用启动并监听', typeof app.webPort === 'number' && app.webPort > 0, `端口 ${app.webPort}，用时 ${((Date.now() - bootStarted) / 1000).toFixed(1)}s`)

const getStatus = async () => (await call(base, '/api/status', {}, 8000)).payload

let result = await call(base, '/api/status', {}, 10000)
assert('GET /api/status', result.status === 200 && result.payload.runtimeReady === true, `${result.ms}ms`)

result = await call(base, '/api/health', {}, 10000)
assert('GET /api/health（控制台健康检查）', result.status === 200 && result.payload.dsh?.found === true)

result = await call(base, '/api/config', {}, 10000)
assert('GET /api/config', result.status === 200 && result.payload.config?.dsh?.model === 'deepseek-flash')
/** Kept aside: later calls overwrite `result`. */
const loadedConfig = result.payload.config

result = await call(base, '/api/logs', {}, 10000)
assert('GET /api/logs', result.status === 200 && Array.isArray(result.payload.lines), `${result.payload?.lines?.length ?? 0} 行`)

const pageResponse = await fetch(`${base}/console`)
assert('GET /console 返回控制台页面', pageResponse.status === 200 && (await pageResponse.text()).includes('聊天桥接'))
const chatResponse = await fetch(`${base}/`)
assert('GET / 返回聊天页', chatResponse.status === 200 && (await chatResponse.text()).includes('聊天测试'))

// The risky one: edit settings and rebuild the runtime underneath a live server.
const patch = structuredClone(loadedConfig)
patch.chat = { ...patch.chat, allowedUsers: [10001, 10002], ackOnBusy: false }
let stopWatch = watch(getStatus, '保存中')
result = await call(base, '/api/config', { method: 'POST', body: JSON.stringify(patch) }, 180000)
stopWatch()
assert(
  'POST /api/config（写盘 + 重建运行时）',
  result.status === 200 && result.payload.status?.runtimeReady === true,
  `${(result.ms / 1000).toFixed(1)}s`,
)

stopWatch = watch(getStatus, '重启运行时中')
result = await call(base, '/api/runtime/restart', { method: 'POST', body: '{}' }, 180000)
stopWatch()
assert('POST /api/runtime/restart', result.status === 200 && result.payload.runtimeReady === true, `${(result.ms / 1000).toFixed(1)}s`)

result = await call(base, '/api/bot/reconnect', { method: 'POST', body: '{}' }, 60000)
assert('POST /api/bot/reconnect（未启用机器人也能返回）', result.status === 200)

result = await call(base, '/api/config', { method: 'POST', body: JSON.stringify({ web: { port: 0 } }) }, 30000)
assert(
  'POST /api/config 拒绝非法配置',
  result.status === 400 && String(result.payload.error).includes('port'),
  String(result.payload.error).split('\n')[0],
)

result = await call(base, '/api/credentials', { method: 'POST', body: JSON.stringify({ apiKey: 'sk-e2e-test-key' }) }, 180000)
assert(
  'POST /api/credentials（写密钥 + 重启运行时）',
  result.status === 200 && result.payload.status?.apiKeySet === true,
  `${(result.ms / 1000).toFixed(1)}s`,
)
assert('密钥确实落盘', readCredentials(home).key === 'sk-e2e-test-key')
assert('配置文件已写出且可读回', existsSync(configPath) && readFileSync(configPath, 'utf8').includes('10001'))

result = await call(base, '/api/config', {}, 10000)
assert('白名单已持久化', JSON.stringify(result.payload.config?.chat?.allowedUsers) === '[10001,10002]')

// ---------------------------------------------------------------------------
// iLink scan login: the console's QR entry point, driven against the stub.
// ---------------------------------------------------------------------------
/** The stored iLink account, parsed. */
const readIlinkAccount = () => JSON.parse(readFileSync(ilinkStatePath, 'utf8'))

result = await call(base, '/api/wechat/ilink/login', {}, 15000)
assert(
  'GET /api/wechat/ilink/login 初始为 idle',
  result.status === 200 && result.payload.state === 'idle' && result.payload.loggedIn === false,
  `state=${result.payload?.state} loggedIn=${result.payload?.loggedIn}`,
)
assert(
  '未登录时给出可用的扫码入口与凭据路径',
  result.payload.available === true && result.payload.accountPath === ilinkStatePath,
  `available=${result.payload?.available} accountPath=${result.payload?.accountPath}`,
)

ilinkStub.state.mode = 'scan'
result = await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '{}' }, 30000)
assert(
  'POST /api/wechat/ilink/login 返回二维码链接',
  result.status === 200 && result.payload.ok === true && String(result.payload.url).includes('/qr/stub-qr-'),
  `${result.ms}ms url=${result.payload?.url}`,
)
assert('POST 同时带回二维码会话 id', String(result.payload.qrcode).startsWith('stub-qr-'), String(result.payload.qrcode))

// The concurrency guard: a second click must not start a competing scan, which
// would invalidate the code already on screen.
const qrBeforeSecondClick = ilinkStub.state.qrIssued
const second = await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '{}' }, 30000)
assert(
  '重复 POST 不会起第二个登录流程',
  second.payload.reused === true && ilinkStub.state.qrIssued === qrBeforeSecondClick,
  `reused=${second.payload?.reused} qrIssued=${qrBeforeSecondClick}→${ilinkStub.state.qrIssued}`,
)

let ilinkState = await waitForIlink(base)
assert('扫码流程走到 confirmed', ilinkState?.state === 'confirmed', `state=${ilinkState?.state} detail=${ilinkState?.detail}`)
assert(
  '凭据写进了配置指定的文件',
  existsSync(ilinkStatePath) && readIlinkAccount().userId === 'stub-user',
  `${ilinkStatePath} → accountUser=${String(ilinkState?.accountUser)}`,
)
const firstToken = existsSync(ilinkStatePath) ? String(readIlinkAccount().token ?? '') : ''

result = await call(base, '/api/wechat/status', {}, 20000)
assert(
  '扫码成功后立刻开始收发（无需重启进程）',
  result.payload.loggedIn === true && result.payload.inboundOk === true,
  `loggedIn=${result.payload?.loggedIn} inboundOk=${result.payload?.inboundOk} detail=${result.payload?.inboundDetail}`,
)
assert('扫码没有重启控制台', app.webPort === port, String(app.webPort))
assert('接收循环真的在轮询桩网关', ilinkStub.state.updates > 0, `getupdates=${ilinkStub.state.updates}`)

// A fresh scan that the phone answers with a pairing code.
ilinkStub.state.mode = 'verify'
ilinkStub.state.verifyCode = '2468'
result = await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '{}' }, 30000)
assert('已登录后可以重新发起扫码', result.payload.ok === true && result.payload.state === 'waiting', `state=${result.payload?.state}`)

let challenge = null
for (let i = 0; i < 30; i += 1) {
  challenge = (await call(base, '/api/wechat/ilink/login', {}, 10000)).payload
  if (challenge.needVerifyCode === true || challenge.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 300))
}
assert(
  '要求配对码时如实上报',
  challenge?.needVerifyCode === true && String(challenge.detail).includes('配对码'),
  `needVerifyCode=${challenge?.needVerifyCode} detail=${challenge?.detail} 最近轮询=${JSON.stringify(ilinkStub.state.requests.slice(-3))}`,
)

result = await call(base, '/api/wechat/ilink/login', { method: 'POST', body: JSON.stringify({ verifyCode: '2468' }) }, 20000)
assert(
  '提交配对码是喂给现有流程而不是另起一个',
  result.payload.reused === true && result.payload.ok === true,
  `reused=${result.payload?.reused} ok=${result.payload?.ok} state=${result.payload?.state}`,
)
ilinkState = await waitForIlink(base, 25000)
assert(
  '配对码正确后登录成功',
  ilinkState?.state === 'confirmed',
  `state=${ilinkState?.state} detail=${ilinkState?.detail} 最近轮询=${JSON.stringify(ilinkStub.state.requests.slice(-3))}`,
)
const secondToken = existsSync(ilinkStatePath) ? String(readIlinkAccount().token ?? '') : ''
assert(
  '新凭据覆盖了旧凭据',
  secondToken.startsWith('stub-token-') && secondToken !== firstToken,
  `${firstToken} → ${secondToken}`,
)

// `binded_redirect`: the account is already bound to a token this machine holds.
// WeChat issues no new credential, and the stored one must survive untouched.
ilinkStub.state.mode = 'bind'
await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '{}' }, 30000)
ilinkState = await waitForIlink(base)
assert(
  '已绑定时不谎报「登录成功」',
  ilinkState?.state === 'failed' && ilinkState.alreadyBound === true && ilinkState.loggedIn === true,
  `state=${ilinkState?.state} alreadyBound=${ilinkState?.alreadyBound} loggedIn=${ilinkState?.loggedIn}`,
)
const keptToken = existsSync(ilinkStatePath) ? String(readIlinkAccount().token ?? '') : '(无文件)'
assert('已绑定时不覆盖本机凭据', keptToken === secondToken, `${secondToken} → ${keptToken}`)
assert('已绑定时提示不要反复重扫', String(ilinkState?.detail).includes('不要反复重扫'), String(ilinkState?.detail))
result = await call(base, '/api/wechat/status', {}, 20000)
assert(
  '已绑定时既有收发没有被中断',
  result.payload.loggedIn === true && result.payload.inboundOk === true,
  `inboundOk=${result.payload?.inboundOk}`,
)

// Expired codes: the flow retries twice, then reports the dead QR as `expired`.
ilinkStub.state.mode = 'expire'
await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '{}' }, 30000)
ilinkState = await waitForIlink(base, 40000)
assert(
  '二维码连续过期时状态为 expired',
  ilinkState?.state === 'expired',
  `state=${ilinkState?.state} detail=${ilinkState?.detail} qrIssued=${ilinkStub.state.qrIssued}`,
)
assert('过期原因如实显示', String(ilinkState?.detail).includes('过期'), String(ilinkState?.detail))

result = await call(base, '/api/wechat/ilink/login', { method: 'POST', body: '[]' }, 10000)
assert('POST /api/wechat/ilink/login 拒绝非对象请求体', result.status === 400, String(result.payload?.error))

// 工作目录检查：控制台让操作者改智能体的工作目录，而“这个目录能不能用”从路径上看不出来。
// DSH 会在自己启动的目录上写一条显式授权项，目录里已有旧的残留正是「能聊天但一用工具就 ACL 报错」
// 的成因，所以这条接口要如实报出来。
{
  const missing = join(tmpdir(), `bridge-e2e-missing-${Date.now()}`, 'nested')
  result = await call(base, '/api/workspace/check', { method: 'POST', body: JSON.stringify({ path: missing }) }, 30000)
  assert('目录不存在时如实上报', result.status === 200 && result.payload.exists === false, JSON.stringify(result.payload?.exists))
  assert('不存在时给出可操作提示', String(result.payload?.hint).includes('创建'), String(result.payload?.hint))

  result = await call(
    base,
    '/api/workspace/check',
    { method: 'POST', body: JSON.stringify({ path: missing, create: true }) },
    30000,
  )
  assert('create 会真的把目录建出来', result.payload?.created === true && result.payload?.exists === true, JSON.stringify(result.payload?.path))
  assert('新建目录可写（真写了一次再删）', result.payload?.writable === true, String(result.payload?.error))
  // 全新目录上不该有 DSH 的显式授权项 —— 这正是「换个新目录」能修好沙箱的依据。
  assert(
    '全新目录没有 DSH 显式授权残留',
    result.payload?.grantCount === 0 || result.payload?.grantCount === null,
    `grantCount=${result.payload?.grantCount}`,
  )
  assert('全新目录的结论是正面的', String(result.payload?.hint).includes('良好'), String(result.payload?.hint))

  // 项目目录本身被 DSH 当过工作区，应当能看到显式授权项（PowerShell 不可用时为 null）。
  result = await call(base, '/api/workspace/check', { method: 'POST', body: JSON.stringify({ path: process.cwd() }) }, 30000)
  assert('已用过的工作目录被识别出来', result.payload?.grantCount === null || result.payload?.grantCount >= 1, `grantCount=${result.payload?.grantCount}`)
  assert('已用过的目录会解释沙箱风险', String(result.payload?.hint).includes('ACL'), String(result.payload?.hint))

  result = await call(base, '/api/workspace/check', { method: 'POST', body: JSON.stringify({}) }, 10000)
  assert('缺少 path 时被拒', result.status === 400, String(result.payload?.error))
}

const stopStarted = Date.now()
await app.stop()
assert('优雅关闭', true, `${((Date.now() - stopStarted) / 1000).toFixed(1)}s`)

ilinkStub.server.closeAllConnections?.()
await new Promise((resolve) => ilinkStub.server.close(resolve))

rmSync(home, { recursive: true, force: true })
console.log(`\n控制台自测：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
