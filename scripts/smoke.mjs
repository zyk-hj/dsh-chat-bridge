#!/usr/bin/env node
/**
 * Self-test for the bridge.
 *
 *   node scripts/smoke.mjs            # offline checks only (no model calls)
 *   node scripts/smoke.mjs --e2e      # + boot `dsh --profile sdk` and ask it something
 *
 * The offline half pins the pure logic (YAML, config, CQ parsing, chunking,
 * OneBot V11 HTTP reporting and WebSocket action round-trip). The `--e2e` half
 * proves the whole chain: runtime handshake → prompt → assistant text back.
 */

import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { defaultConfig, deepMerge, loadConfig, mergeConfigFile, validateConfig } from '../src/config.mjs'
import { chunkText, clampText, encodeCqText, decodeCqEntities } from '../src/util.mjs'
import { extractInboundText, segmentToText, ChatGateway } from '../src/chat-gateway.mjs'
import { parseYaml, toYamlDocument } from '../src/yaml.mjs'
import { ConversationPool } from '../src/conversation.mjs'
import { DshRuntime, resolveDshCommand } from '../src/dsh-runtime.mjs'
import { OneBotClient } from '../src/onebot.mjs'
import { readCredentials, renderConfig, writeCredentials } from '../src/bridge-app.mjs'
import { CONSOLE_HTML } from '../src/console-page.mjs'

// A stray rejection anywhere must name itself instead of killing the run with a
// bare "fetch failed".
process.on('unhandledRejection', (reason) => {
  console.error('!! unhandled rejection:', reason instanceof Error ? reason.stack : reason)
})

let passed = 0
let failed = 0

/** @param {string} name - case name. @param{() => void} body - assertions. */
function check(name, body) {
  try {
    body()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * Async case: awaited, so a rejection is reported as a failure instead of
 * escaping as an unhandled rejection.
 * @param {string} name - case name.
 * @param {() => Promise<void>} body - async assertions.
 */
async function acheck(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}`)
  }
}

/** @param {unknown} actual - observed value. @param {unknown} expected - required value. */
function equal(actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`expected ${b}, got ${a}`)
}

/** @param {unknown} value - value that must be truthy. @param {string} [note] - failure note. */
function ok(value, note = 'expected a truthy value') {
  if (!value) throw new Error(note)
}

console.log('\n[1/5] YAML 子集解析')
check('嵌套映射与数组', () => {
  const parsed = parseYaml(`
# 注释
dsh:
  model: deepseek-flash
  args: [--profile, sdk]
chat:
  allowedUsers: null
  requireAtInGroup: true
  maxReplyChars: 1500
`)
  equal(parsed.dsh.model, 'deepseek-flash')
  equal(parsed.dsh.args, ['--profile', 'sdk'])
  equal(parsed.chat.allowedUsers, null)
  equal(parsed.chat.requireAtInGroup, true)
  equal(parsed.chat.maxReplyChars, 1500)
})
check('引号内井号不是注释', () => {
  const parsed = parseYaml('onebot:\n  url: "ws://127.0.0.1:3001/#token"  # 注释\n')
  equal(parsed.onebot.url, 'ws://127.0.0.1:3001/#token')
})
check('对象数组', () => {
  const parsed = parseYaml('items:\n  - id: a\n    value: 1\n  - id: b\n    value: 2\n')
  equal(parsed.items, [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ])
})
check('写出后再读回，值不变', () => {
  const document = {
    dsh: { model: 'deepseek-flash', cwd: 'D:\\my project', args: ['--profile', 'sdk'] },
    chat: { allowedUsers: null, requireAtInGroup: false, maxReplyChars: 1500, note: "含 ' 引号与 # 井号" },
  }
  const text = toYamlDocument(document, '# 头注释')
  const back = parseYaml(text)
  equal(back.dsh, document.dsh)
  equal(back.chat, document.chat)
})
check('空容器以子行写出后仍能读回', () => {
  // The serializer emits an empty map/sequence as its own child line.
  const back = parseYaml('dsh:\n  env:\n    {}\n  args:\n    []\n  model: x\n')
  equal(back.dsh.env, {})
  equal(back.dsh.args, [])
  equal(back.dsh.model, 'x')
})
check('on/off/yes/no 保持字符串，不变成布尔', () => {
  // Regression: `mode: off` was read back as `false`, which then failed config
  // validation on the next boot after a console save.
  const back = parseYaml('onebot:\n  mode: off\n  path: on\n  token: no\n  flag: true\n')
  equal(back.onebot.mode, 'off')
  equal(back.onebot.path, 'on')
  equal(back.onebot.token, 'no')
  equal(back.onebot.flag, true)
})

check('控制台写出的配置能被自己读回', () => {
  // Regression: the writer emitted `env:` + `{}` on separate lines, which the
  // reader used to reject, so saving once from the console bricked the next boot.
  const config = defaultConfig()
  config.chat.allowedUsers = [10001, 10002]
  config.chat.allowedGroups = null
  const back = parseYaml(renderConfig(config))
  equal(back.dsh, config.dsh)
  equal(back.onebot, config.onebot)
  equal(back.chat, config.chat)
  equal(back.web, config.web)
  equal(back.log, config.log)
})

console.log('\n[2/5] 配置装配')
check('默认配置通过校验', () => {
  validateConfig(defaultConfig())
})
check('非法端口被拒绝', () => {
  let threw = false
  try {
    validateConfig(deepMerge(defaultConfig(), { web: { port: 0 } }))
  } catch {
    threw = true
  }
  ok(threw, 'port 0 should be rejected')
})
check('覆盖合并保留同级字段', () => {
  const config = deepMerge(defaultConfig(), { chat: { maxReplyChars: 500 } })
  equal(config.chat.maxReplyChars, 500)
  equal(config.chat.requireAtInGroup, true)
})
check('工作区配置可加载', () => {
  const { config, path } = loadConfig(resolve(process.cwd(), 'bridge.config.yaml'))
  ok(path !== null, 'expected to load bridge.config.yaml')
  // Assert what the product requires of *any* config, not what this deployment
  // happens to have chosen. Pinning `onebot.mode` here meant that turning QQ off
  // in one's own config — a perfectly legal choice — turned the suite red.
  ok(
    ['reverse', 'forward', 'http-post', 'off'].includes(config.onebot.mode),
    `onebot.mode 必须是四个合法值之一，实际 ${config.onebot.mode}`,
  )
  ok(typeof config.dsh.model === 'string' && config.dsh.model !== '', 'dsh.model 不能为空')
})

// A `.cmd` shim cannot be spawned directly on Windows — Node has refused it since
// the CVE-2024-27980 fix, failing with `spawn EINVAL`. The resolver must therefore
// hand back a real executable plus the shim's Node entry script, never the shim
// itself. This was a live outage: the Desktop launcher's `dsh.cmd` writes `%~dp0`
// (with a tilde) and the resolver only understood `%dp0%`, so it could not find
// the entry script and fell back to spawning the `.cmd`.
check('dsh 解析结果永远不是不可 spawn 的 .cmd/.bat/.ps1', () => {
  const launch = resolveDshCommand('dsh')
  if (launch === null) {
    // Acceptable: dsh is genuinely not installed here. Say so rather than pass
    // silently, so a broken resolver cannot hide behind "not installed".
    console.log('      （本机没有 dsh，跳过）')
    return
  }
  const command = launch.command.toLowerCase()
  ok(
    !command.endsWith('.cmd') && !command.endsWith('.bat') && !command.endsWith('.ps1'),
    `resolveDshCommand 返回了脚本 shim：${launch.command}`,
  )
  // When a shim was resolved, it must be launched through a Node entry script.
  if (launch.prefix.length > 0) {
    ok(
      launch.prefix[0].toLowerCase().endsWith('.js') || launch.prefix[0].toLowerCase().endsWith('.mjs'),
      `prefix 应当是 Node 入口脚本，实际 ${launch.prefix[0]}`,
    )
    ok(existsSync(launch.prefix[0]), `入口脚本不存在：${launch.prefix[0]}`)
  }
})

console.log('\n[3/5] 消息解析（OneBot CQ 码 / 数组段）')
check('数组段：@机器人 + 文本', () => {
  const text = extractInboundText({
    message: [
      { type: 'at', data: { qq: '1234', name: 'Bot' } },
      { type: 'text', data: { text: ' 帮我看看这个报错' } },
    ],
  })
  equal(text, '@Bot 帮我看看这个报错')
})
check('字符串段：CQ 码解码且转义还原', () => {
  const text = extractInboundText({
    raw_message: '[CQ:at,qq=1234] &#91;重要&#93; 看下 [CQ:image,file=a.png]',
  })
  equal(text, '@1234 [重要] 看下 [图片]')
})
check('未知 CQ 码降级为标签', () => {
  equal(segmentToText({ type: 'record', data: {} }), '[语音]')
  equal(segmentToText({ type: 'unknownthing', data: {} }), '[unknownthing]')
})
check('CQ 转义往返', () => {
  const raw = '数组 [0] & "引号"'
  equal(decodeCqEntities(encodeCqText(raw)), raw)
})

console.log('\n[4/5] 文本工具')
check('长文本按段落分片', () => {
  const chunks = chunkText(`${'甲'.repeat(150)}\n\n${'乙'.repeat(150)}`, 200)
  equal(chunks.length, 2)
  ok(chunks[0].startsWith('甲'), 'first chunk should start with 甲')
  ok(chunks[1].startsWith('乙'), 'second chunk should start with 乙')
})
check('超长单段也会被切开', () => {
  const chunks = chunkText('丙'.repeat(500), 200)
  ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`)
  ok(
    chunks.every((chunk) => chunk.length <= 200),
    'every chunk must respect the limit',
  )
})
check('入站文本截断', () => {
  const clamped = clampText('丁'.repeat(100), 10)
  ok(clamped.startsWith('丁'.repeat(10)), 'prefix should be kept')
  ok(clamped.includes('截断'), 'truncation should be announced')
})

check('控制台页面内联脚本可解析', () => {
  // The console is one HTML string with an inline script; a wrong field name in
  // it only ever shows up as a toast in the browser. `check-console-ui.mjs` runs
  // the script for real; this keeps a syntax error out of the suite.
  const script = /<script>([\s\S]*?)<\/script>/.exec(CONSOLE_HTML)?.[1] ?? ''
  ok(script.length > 1000, '控制台页面里应当有内联脚本')
  new Function(script)
})

console.log('\n[5/6] 控制台：凭据读写不破坏其他内容')
await acheck('写入 API Key 只改一行，其他记录原样保留', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-cred-'))
  const path = join(home, '.credentials.yaml')
  const original = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      label: 浏览器会话',
    '      secret: abc123def456',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-old-key',
    '',
  ].join('\n')
  writeFileSync(path, original, 'utf8')

  writeCredentials(home, 'sk-new-key-value')
  const after = readFileSync(path, 'utf8')
  ok(after.includes('sk-new-key-value'), 'the new key must be stored')
  ok(!after.includes('sk-old-key'), 'the old key must be gone')
  ok(after.includes('client-connection/browser-session'), 'unrelated records must survive')
  ok(after.includes('secret: abc123def456'), 'unrelated payload values must survive')
  ok(after.includes('label: 浏览器会话'), 'non-ASCII payload values must survive')
  equal(readCredentials(home).key, 'sk-new-key-value')

  writeCredentials(home, '')
  const cleared = readFileSync(path, 'utf8')
  ok(!cleared.includes('DEEPSEEK_API_KEY'), 'clearing must remove the key line')
  ok(cleared.includes('secret: abc123def456'), 'clearing must not touch other records')
  equal(readCredentials(home).key, '')

  writeCredentials(home, 'sk-second')
  equal(readFileSync(path, 'utf8').includes('secret: abc123def456'), true, 'adding the key back must stay surgical')
  rmSync(home, { recursive: true, force: true })
})

await acheck('空凭据文件也能正常创建', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-cred2-'))
  writeCredentials(home, 'sk-fresh')
  equal(readCredentials(home).key, 'sk-fresh')
  rmSync(home, { recursive: true, force: true })
})

console.log('\n[6/6] OneBot 传输与网关')
const config = deepMerge(defaultConfig(), {
  onebot: { mode: 'http-post', host: '127.0.0.1', port: 0 },
  web: { enabled: false },
  chat: { prewarmCount: 0, ackOnBusy: false },
})

const client = new OneBotClient(config)
await client.start()
const port = client.httpPort ?? config.onebot.port

await acheck('HTTP 上报的事件被解析为 message 事件', async () => {
  const seen = once(client, 'event')
  const response = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 10001,
      self_id: '9999',
      raw_message: '你好',
      message: [{ type: 'text', data: { text: '你好' } }],
    }),
  })
  equal(response.status, 204)
  const [event] = await Promise.race([seen, new Promise((r) => setTimeout(() => r([null]), 3000))])
  ok(event !== null, 'no event arrived over HTTP reporting')
  equal(event.user_id, 10001)
})

await client.stop()

await acheck('网关命令：/help 与 /ping', async () => {
  const runtime = { prompt: async () => 'msg_1', ready: true, on: () => {}, start: async () => {} }
  const pool = new ConversationPool(config, runtime)
  const gateway = new ChatGateway(config, pool)
  const replies = []
  gateway.setWebSink((_inbound, chunks) => {
    replies.push(chunks.join('\n'))
  })
  await gateway.handleInbound({ chatKind: 'web', chatId: 'local', senderId: 'local', text: '/ping' })
  await gateway.handleInbound({ chatKind: 'web', chatId: 'local', senderId: 'local', text: '/help' })
  equal(replies[0], 'pong')
  ok(replies[1].includes('/new'), '/help should document /new')
})

await acheck('群聊未 @ 机器人时不触发模型', async () => {
  let prompted = false
  const runtime = {
    prompt: async () => {
      prompted = true
      return 'msg_1'
    },
    ready: true,
    on: () => {},
    start: async () => {},
  }
  const pool = new ConversationPool(config, runtime)
  const gateway = new ChatGateway(config, pool)
  await gateway.handleInbound({
    chatKind: 'group',
    chatId: 20002,
    senderId: 10001,
    senderName: '小明',
    text: '大家早上好',
    atSelf: false,
  })
  equal(prompted, false)
})

/**
 * Wait until a conversation has bound its session.
 * @param {{ sessionId: string | null }} conversation - the conversation to watch.
 * @returns {Promise<string>} the bound session id.
 */
async function waitForSession(conversation) {
  for (let i = 0; i < 200; i += 1) {
    const id = conversation.sessionId
    if (id !== null) return id
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('conversation never bound a session')
}

await acheck('回合锁定：上一回合的事件不会混进本回合回答', async () => {
  // Regression: a runtime turn that began on its own (session priming, a goal
  // continuation round) could deliver its `assistant/message` after the next
  // prompt was queued, prefixing the user's answer with the stray reply.
  const runtime = { prompt: async () => 'msg_1', ready: true, on: () => {}, start: async () => {} }
  const pool = new ConversationPool(config, runtime)
  const conversation = pool.conversation('private:90001', 'private')
  const sessionId = await waitForSession(conversation)
  conversation.bind(sessionId)

  const answerPromise = conversation.send({ text: '你好', timeoutMs: 5000 })
  // Let the turn register itself, then replay the runtime's notifications.
  queueMicrotask(() => {
    const event = (type, data) => ({ sessionId, event: { type, data } })
    conversation.handleNotification(
      'session.event',
      event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '好' }] } }),
    )
    conversation.handleNotification('session.event', event('turn/start', { turn: 2 }))
    conversation.handleNotification(
      'session.event',
      event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '收到' }] } }),
    )
    conversation.handleNotification('session.status', { sessionId, status: 'idle' })
  })

  equal(await answerPromise, '收到')
})

console.log(`\n离线检查：${passed} 通过，${failed} 失败`)

if (!process.argv.includes('--e2e')) {
  console.log('（加 --e2e 可额外验证 `dsh --profile sdk` 运行时与真实模型回合）\n')
  process.exit(failed === 0 ? 0 : 1)
}

console.log('\n[e2e] 启动 dsh --profile sdk 并跑一轮真实对话')
const e2eConfig = deepMerge(defaultConfig(), {
  dsh: { cwd: process.cwd(), reasoningEffort: 'low' },
  chat: { prewarmCount: 0 },
  web: { enabled: false },
  log: { level: process.argv.includes('--debug') ? 'debug' : 'info' },
})
const runtime = new DshRuntime(e2eConfig)
const pool = new ConversationPool(e2eConfig, runtime)
const startedAt = Date.now()
try {
  await pool.start()
  console.log(`  ✓ 运行时握手成功（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  passed += 1
} catch (error) {
  failed += 1
  console.error(`  ✗ 运行时启动失败\n      ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

const conversation = pool.conversation('smoke:local', 'web')
try {
  const answer = await conversation.send({
    text: '请只回答两个字：收到',
    timeoutMs: 180000,
  })
  ok(answer.trim() !== '', 'the model returned an empty answer')
  console.log(`  ✓ 模型回答：${answer.trim().slice(0, 120)}`)
  passed += 1
} catch (error) {
  failed += 1
  console.error(`  ✗ 对话失败\n      ${error instanceof Error ? error.message : error}`)
}

await runtime.stop()
console.log(`\n总计：${passed} 通过，${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
