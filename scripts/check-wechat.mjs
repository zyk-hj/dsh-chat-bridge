#!/usr/bin/env node
/**
 * WeChat route self-test.
 *
 * The WeChat route is provider-based, so this checks each layer separately and
 * then end to end:
 *
 *   - **payload normalisation** — the webhook accepts several spellings, because
 *     whoever writes the pushing script should not have to read our source.
 *   - **inbound, end to end** — a real HTTP POST to the real webhook listener
 *     reaches the gateway and becomes a DSH prompt, with auth, batching, dedup,
 *     group @-detection and self-filtering all exercised.
 *   - **outbound strategies** — all three are driven for real: `command` runs a
 *     tiny Node script and reads its JSON result, `http` posts to a local
 *     endpoint, and `ilink` is handed a stub bridge so the pass-through (which
 *     owns the context token) is checked without needing a logged-in account.
 *   - **configuration** — the rules that would otherwise fail later, at a
 *     confusing moment, are asserted to fail now instead.
 *
 *   node scripts/check-wechat.mjs [--verbose]
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { classifyContent, mentionsBot, stripBotMention, WeChatAdapter } from '../src/wechat.mjs'
import { normalizeWebhookEvent } from '../src/wechat-webhook.mjs'
import { createSender } from '../src/wechat-outbound.mjs'
import { ChatGateway } from '../src/chat-gateway.mjs'
import { ConversationPool } from '../src/conversation.mjs'
import { defaultConfig, deepMerge, migrateConfig, validateConfig } from '../src/config.mjs'
import { configureLogging } from '../src/util.mjs'

// `--verbose` turns on the adapter's own logging, which is the fastest way to see
// where an event stopped moving.
configureLogging(process.argv.includes('--verbose') ? 'debug' : 'warn')

let failures = 0
/** @param {string} name - check name. @param {boolean} ok - result. @param {string} [note] - detail. */
function assert(name, ok, note = '') {
  if (ok) console.log(`  ✓ ${name}${note === '' ? '' : ` — ${note}`}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${note === '' ? '' : ` — ${note}`}`)
  }
}

/** @param {unknown} actual - observed. @param {unknown} expected - required. */
function equal(actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`expected ${b}, got ${a}`)
}

/** @param {Record<string, any>} candidate - config to validate. @returns {boolean} whether validation rejected it. */
function rejects(candidate) {
  try {
    validateConfig(candidate)
    return false
  } catch {
    return true
  }
}

/** @param {Record<string, any>} candidate - config to validate. @returns {boolean} whether validation accepted it. */
function accepts(candidate) {
  try {
    validateConfig(candidate)
    return true
  } catch {
    return false
  }
}

console.log('\n[微信链路自测]')
console.log('（入站用通用 Webhook——任何工具都能往里推；出站支持 ilink / 外部命令 / HTTP）')

// ------------------------------------------------------- 入站载荷归一化
{
  const camel = normalizeWebhookEvent({
    sessionId: 'wxid_a',
    sessionType: 'private',
    sourceName: '张三',
    content: '你好',
    messageId: 'm1',
  })
  equal(camel.sessionId, 'wxid_a')
  equal(camel.sessionType, 'private')
  equal(camel.sourceName, '张三')
  equal(camel.event, 'message.new')
}
{
  // A caller using snake_case and a group id ending in @chatroom must just work.
  const snake = normalizeWebhookEvent({ session_id: '9@chatroom', sender_name: '李四', text: '在吗', svrid: 's1' })
  equal(snake.sessionType, 'group')
  equal(snake.sourceName, '李四')
  equal(snake.content, '在吗')
}
{
  const revoke = normalizeWebhookEvent({ type: 'message.revoke', chatId: 'wxid_a' })
  equal(revoke.event, 'message.revoke')
}
{
  // An own message must be marked as such, or the bot answers itself forever.
  equal(normalizeWebhookEvent({ chatId: 'x', text: 'hi', isSend: 1 }).isSend, true)
  equal(normalizeWebhookEvent({ chatId: 'x', text: 'hi' }).isSend, false)
  equal(normalizeWebhookEvent({ content: '没有会话 id' }), null)
}

// ------------------------------------------------------------ 内容分类规则
equal(classifyContent('你好'), 'text')
equal(classifyContent('[图片]'), 'image')
equal(classifyContent('[语音]'), 'voice')
equal(classifyContent('[动画表情]'), 'emoji')
equal(classifyContent('[系统消息]'), 'system')
equal(classifyContent('这是[图片]两个字而已'), 'text')

// ------------------------------------------------------------ @ 与自过滤
assert('组内 @ 检测命中', mentionsBot('@小明 帮我看下这个', ['小明']) === true)
assert('组内未 @ 时不误判', mentionsBot('大家早上好', ['小明']) === false)
equal(stripBotMention('@小明 帮我看下这个', ['小明']), '帮我看下这个')
assert('空昵称不会匹配一切', mentionsBot('随便什么', ['']) === false)

// ------------------------------------------------------------ 配置校验
{
  const conflicting = defaultConfig()
  conflicting.wechat.enabled = true
  // State the provider explicitly: the default is now `ilink`, which has no
  // listener of its own, so the port check only applies to the webhook route.
  conflicting.wechat.inbound = 'webhook'
  conflicting.wechat.webhook.port = conflicting.web.port
  assert('入站端口与控制台端口冲突会被拒绝', rejects(conflicting))
}
{
  // The removed routes must be rejected outright rather than silently ignored:
  // a config left over from an older version should fail loudly at startup.
  const deadInbound = defaultConfig()
  deadInbound.wechat.enabled = true
  deadInbound.wechat.inbound = 'wcferry'
  assert('已删除的入站方式（wcferry / weflow）被拒绝', rejects(deadInbound))

  const deadStrategy = defaultConfig()
  deadStrategy.wechat.enabled = true
  deadStrategy.wechat.sendEnabled = true
  deadStrategy.wechat.sendStrategy = 'uia'
  assert('已删除的发送方式（uia / weixin）被拒绝', rejects(deadStrategy))
}
{
  const noCommand = defaultConfig()
  noCommand.wechat.enabled = true
  noCommand.wechat.sendEnabled = true
  noCommand.wechat.sendStrategy = 'command'
  assert('command 方式没填可执行文件时被拒绝', rejects(noCommand))

  const noUrl = defaultConfig()
  noUrl.wechat.enabled = true
  noUrl.wechat.sendEnabled = true
  noUrl.wechat.sendStrategy = 'http'
  assert('http 方式没填 url 时被拒绝', rejects(noUrl))
}
{
  const ilinkOnly = defaultConfig()
  ilinkOnly.wechat.enabled = true
  ilinkOnly.wechat.sendEnabled = true
  ilinkOnly.wechat.inbound = 'ilink'
  ilinkOnly.wechat.sendStrategy = 'ilink'
  // iLink tags the sender itself, so the nickname list is optional here.
  assert('收发都走 iLink 的配置能通过校验', accepts(ilinkOnly))
}
{
  // A config written before the providers were split still carries the flat
  // `weflowEnabled` flag, and the route it named is gone. Migration must land on
  // a *legal* provider: otherwise validation rejects the file and an existing
  // installation refuses to start after upgrading.
  const legacy = defaultConfig()
  legacy.wechat.enabled = true
  legacy.wechat.weflowEnabled = true
  migrateConfig(legacy)
  assert(
    '旧 weflowEnabled 配置迁移后不会让校验失败',
    legacy.wechat.weflowEnabled === undefined && accepts(legacy),
    String(legacy.wechat.inbound),
  )

  const stale = defaultConfig()
  stale.wechat.enabled = true
  stale.wechat.inbound = 'wcferry'
  migrateConfig(stale)
  assert('存量文件里已删除的入站方式被迁移成合法值', accepts(stale), String(stale.wechat.inbound))
}

// ------------------------------------------------------------ 端到端：Webhook → DSH
const config = deepMerge(defaultConfig(), {
  wechat: {
    enabled: true,
    inbound: 'webhook',
    webhook: { host: '127.0.0.1', port: 0, path: '/message', token: 'test-token' },
    botNicknames: ['小明'],
    sendEnabled: false,
    recipients: {},
  },
  chat: { prewarmCount: 0, ackOnBusy: false },
})
// `port: 0` picks a free port, which is what a test wants but not what a stored
// config may contain.
config.wechat.webhook.port = 8899

/** A runtime stand-in that records prompts and answers them. */
function fakeRuntime() {
  const prompts = []
  return {
    prompts,
    ready: true,
    on() {},
    async start() {},
    async stop() {},
    async prompt(sessionId, text, attachments) {
      prompts.push({ sessionId, text, attachments })
      return 'msg_1'
    },
  }
}

const runtime = fakeRuntime()
const pool = new ConversationPool(config, runtime)
const gateway = new ChatGateway(config, pool)
const adapter = new WeChatAdapter(config, gateway, runtime)
await adapter.start()
const port = adapter.inbound.port
const endpoint = `http://127.0.0.1:${port}${config.wechat.webhook.path}`
assert('Webhook 入站已监听', typeof port === 'number' && port > 0, `端口 ${port}`)

/** POST a payload to the inbound webhook. */
async function post(body, token = 'test-token') {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** Wait until the gateway has taken a message for a chat. */
async function waitForPrompt(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && runtime.prompts.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Finish the turn a fake runtime is holding.
 *
 * Turns are serialized per conversation, so a test that never ends turn N will
 * never see turn N+1 queued. Real turns end with an `assistant/message` followed
 * by an `idle` status; this replays exactly those two notifications.
 *
 * @param {ReturnType<typeof fakeRuntime>} targetRuntime - the runtime holding the turn.
 * @param {ConversationPool} targetPool - the pool that owns the conversation.
 * @param {number} index - which recorded prompt to answer.
 */
async function settleWith(targetRuntime, targetPool, index) {
  const recorded = targetRuntime.prompts[index]
  if (recorded === undefined) throw new Error(`没有第 ${index} 条 prompt 可供结束`)
  const owner = targetPool.conversationForSession(recorded.sessionId)
  if (owner === undefined) throw new Error(`会话 ${recorded.sessionId} 还没有绑定对话`)
  owner.handleNotification('session.event', {
    sessionId: recorded.sessionId,
    event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '好的' }] } } },
  })
  owner.handleNotification('session.status', { sessionId: recorded.sessionId, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** Finish a turn on the main test runtime. */
const settle = (index) => settleWith(runtime, pool, index)

// 鉴权
{
  const denied = await post({ chatId: 'wxid_friend', text: '你好' }, 'wrong-token')
  equal(denied.status, 401)
  const health = await fetch(`http://127.0.0.1:${port}/health`)
  equal(health.status, 200)
  assert('健康检查无需令牌', (await health.json()).ok === true)
}

// 私聊消息走完整条链路
{
  const response = await post({
    chatId: 'wxid_friend',
    chatType: 'private',
    senderName: '张三',
    text: '帮我看看这个报错',
    messageId: 'r1',
  })
  equal(response.status, 202)
  await waitForPrompt(1)
  const prompt = runtime.prompts.at(-1)
  assert('私聊消息被送进 DSH 会话', prompt?.text === '帮我看看这个报错', prompt?.text)
  await settle(0)
}

// 重复推送（工具重连时会重发）不能被回答两次
{
  await post({ chatId: 'wxid_friend', chatType: 'private', senderName: '张三', text: '帮我看看这个报错', messageId: 'r1' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert('相同 messageId 的消息被去重', runtime.prompts.length === 1, `prompt 数 ${runtime.prompts.length}`)
}

// 群聊 @ 规则
{
  await post({ chatId: '12345@chatroom', senderName: '李四', groupName: '项目群', text: '大家早上好', messageId: 'r2' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert('群聊未 @ 机器人时不触发模型', runtime.prompts.length === 1)

  await post({
    chatId: '12345@chatroom',
    senderName: '李四',
    groupName: '项目群',
    text: '@小明 这个接口报错了',
    messageId: 'r3',
  })
  await waitForPrompt(2)
  const prompt = runtime.prompts.at(-1)
  assert('群聊 @ 机器人后触发模型', runtime.prompts.length === 2, `prompt 数 ${runtime.prompts.length}`)
  assert('群聊消息带发送者前缀', prompt?.text?.startsWith('[李四]'), prompt?.text)
  assert('机器人昵称已从正文剥离', prompt?.text?.includes('这个接口报错了') === true && !prompt.text.includes('@小明'), prompt?.text)
}

// 自己发出的消息必须被忽略，否则会变成模型跟自己对聊
{
  await post({ chatId: 'wxid_friend', senderName: '小明', text: '我是机器人的回复', isSend: 1, messageId: 'r4' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert('机器人自己的消息不会被再次回答', runtime.prompts.length === 2, `prompt 数 ${runtime.prompts.length}`)
}

// 系统消息与撤回事件
{
  await post({ chatId: 'wxid_friend', senderName: '张三', text: '[系统消息]', messageId: 'r5' })
  await post({ type: 'message.revoke', chatId: 'wxid_friend', messageId: 'r6' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert('系统消息与撤回事件不触发模型', runtime.prompts.length === 2, `prompt 数 ${runtime.prompts.length}`)
}

// 批量投递（工具补推积压消息）
{
  const batch = await post([
    { chatId: 'wxid_batch', senderName: '王五', text: '第一条', messageId: 'b1' },
    { chatId: 'wxid_batch', senderName: '王五', text: '第二条', messageId: 'b2' },
  ])
  equal(batch.status, 202)
  equal(batch.body.accepted, 2)
  assert('批量消息被接受', batch.body.accepted === 2)
}

// 缺少会话 id 的请求要被明确拒绝，而不是静默丢弃
{
  const bad = await post({ text: '没有会话 id' })
  equal(bad.status, 400)
  assert('缺少会话 id 的请求被拒绝并说明原因', String(bad.body.error).includes('sessionId'), bad.body.error)
}

// 未知发送方式要有明确报错，而不是静默不工作
{
  const unknown = defaultConfig()
  unknown.wechat.sendStrategy = 'telepathy'
  const sender = createSender(unknown)
  const result = await sender.send({ recipient: 'x', text: 'y', peerId: 'z' })
  assert('未知发送方式会明确报错', result.ok === false && result.detail.includes('telepathy'), result.detail)
}

// iLink 出站：回的是官方接口，所以发送方只是一个转发器
{
  // No bridge is running when inbound is not `ilink`: the reply has no context
  // token to echo, so the sender must say which setting to change.
  const orphan = defaultConfig()
  orphan.wechat.sendStrategy = 'ilink'
  const orphanSender = createSender(orphan)
  assert('ilink 出站策略被正确选中', orphanSender.strategy === 'ilink', orphanSender.strategy)
  const orphaned = await orphanSender.send({ recipient: '张三', text: '你好', peerId: 'wxid_a' })
  assert(
    '入站不是 ilink 时，ilink 出站给出可操作的提示',
    orphaned.ok === false && orphaned.detail.includes('wechat.inbound'),
    orphaned.detail,
  )
}
{
  const sent = []
  const bridge = {
    async send({ text, peerId }) {
      sent.push({ text, peerId })
      return { ok: true, detail: `已通过 iLink 发送给 ${peerId}` }
    },
    async probe() {
      return { ok: true, detail: 'iLink 已登录' }
    },
  }
  const cfg = defaultConfig()
  cfg.wechat.sendStrategy = 'ilink'
  const sender = createSender(cfg, bridge)
  const result = await sender.send({ recipient: '张三', text: '你好', peerId: 'wxid_a' })
  assert(
    'ilink 出站把 peerId 和正文交给 iLink 桥接',
    result.ok === true && sent.at(-1)?.peerId === 'wxid_a' && sent.at(-1)?.text === '你好',
    result.detail,
  )
  assert('ilink 出站的 lastResult 保留最近一次结果', sender.lastResult()?.ok === true)
  const probe = await sender.probe()
  assert('ilink 探测转发给 iLink 桥接', probe.ok === true && probe.detail.includes('已登录'), probe.detail)
}

// 外部命令发送：真的执行一个脚本并读取它的 JSON 结果
{
  const dir = mkdtempSync(join(tmpdir(), 'bridge-send-'))
  const script = join(dir, 'send.mjs')
  writeFileSync(
    script,
    'const [recipient, text] = process.argv.slice(2)\n' +
      'console.log(JSON.stringify({ ok: true, detail: `已发送给 ${recipient}` }))\n' +
      'if (text === "fail") { console.log(JSON.stringify({ ok: false, detail: "模拟失败" })); process.exit(1) }\n',
    'utf8',
  )
  const cfg = defaultConfig()
  cfg.wechat.sendStrategy = 'command'
  cfg.wechat.command = { command: process.execPath, args: [script], timeoutMs: 15000 }
  const sender = createSender(cfg)
  assert('外部命令发送方式被识别', sender.strategy === 'command')

  const ok = await sender.send({ recipient: '张三', text: '你好', peerId: 'wxid_a' })
  assert('外部命令发送成功并读到结果', ok.ok === true && ok.detail.includes('张三'), ok.detail)

  const failed = await sender.send({ recipient: '张三', text: 'fail', peerId: 'wxid_a' })
  assert('外部命令报错时如实上报', failed.ok === false && failed.detail.includes('模拟失败'), failed.detail)
  rmSync(dir, { recursive: true, force: true })
}

// HTTP 发送：对本地端点真的发一次
{
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push(JSON.parse(body || '{}'))
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sendPort = server.address().port

  const cfg = defaultConfig()
  cfg.wechat.sendStrategy = 'http'
  cfg.wechat.http = { url: `http://127.0.0.1:${sendPort}/send`, token: 'abc', timeoutMs: 10000 }
  const sender = createSender(cfg)
  const result = await sender.send({ recipient: '张三', text: '你好', peerId: 'wxid_a' })
  assert('HTTP 发送成功', result.ok === true, result.detail)
  equal(received.at(-1), { recipient: '张三', text: '你好', peerId: 'wxid_a' })
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

// 网关级：空回答与"还没轮到发送就返回"的每一条路径
//
// 现场是一段线上日志：用户发了 Word 文档 → 又发了一条改写要求 → 回合以
// `0 chars, 0 tool calls` 结束 → **用户一个字都没收到**，而且连"已通过 ilink 发送"
// 都没有。日志里没有 `回复分片发送失败`，也没有 `⚠️ 出错了`，所以要么兜底文案
// 压根没发出去，要么这条消息根本没走到发送那一步。这一节把两种情况都钉死。
{
  console.log('\n网关级：空回答与静默返回路径')

  /**
   * A gateway whose one conversation answers with whatever the test says.
   *
   * @param {string|Error} answer - the reply text, or an error to throw.
   * @returns {{ gateway: ChatGateway, chats: Array<any>, inbound: Array<any>, outbound: Array<any>, level: { value: string } }} the harness.
   */
  const gatewayWith = (answer) => {
    const chats = []
    const inbound = []
    const outbound = []
    const level = { value: 'warn' }
    const cfg = deepMerge(defaultConfig(), { web: { enabled: false }, chat: { prewarmCount: 0 } })
    const pool = {
      size: 0,
      renewals: 0,
      isBound: () => true,
      resetConversation() {},
      conversation: (key) => ({
        async send(params) {
          chats.push({ key, params })
          if (answer instanceof Error) throw answer
          return answer
        },
      }),
    }
    const gateway = new ChatGateway(cfg, pool, {
      onInbound: (note) => inbound.push(note),
      onOutbound: (note) => outbound.push(note),
    })
    return { gateway, chats, inbound, outbound, level }
  }

  /** The shape `WeChatAdapter` presents to the gateway, plus what it was asked to send. */
  const stubTransport = () => {
    const sent = []
    return {
      sent,
      transportLabel: 'stub(ilink)',
      maxReplyChars: 900,
      setCalls: 0,
      async send(target) {
        sent.push(target)
      },
      async setTyping() {
        this.setCalls += 1
      },
    }
  }

  const privateInbound = { chatKind: 'private', chatId: 'peer-test-0001', senderId: 'peer-test-0001', senderName: '用户', text: '把这段文字改一下再发给我' }

  // ---- 1. 桩 conversation 返回空字符串：兜底文案必须被发出去
  {
    const { gateway, chats } = gatewayWith('')
    const transport = stubTransport()
    gateway.setTransport(transport)
    await gateway.handleInbound({ ...privateInbound })
    equal(chats.length, 1)
    // `chat.ackOnBusy` 默认开着，所以第一条是「🤔 收到，正在处理…」，兜底文案是第二条。
    // 断言写成"其中一条是兜底"而不是"只有一条"，否则测的是 ack 配置而不是兜底行为。
    const texts = transport.sent.map((target) => target.segments.map((segment) => segment.data?.text ?? '').join(''))
    assert('回合返回空字符串时，兜底文案被真的发出去', texts.some((text) => text.includes('没有产生文字回复')), JSON.stringify(texts))
    assert('兜底之后确实调用了传输层', transport.sent.length >= 1, `transport.send 调用 ${transport.sent.length} 次`)
  }

  // ---- 1b. 关掉 ackOnBusy 也一样：兜底文案不受"正在处理"提示影响
  {
    const cfg = deepMerge(defaultConfig(), { web: { enabled: false }, chat: { prewarmCount: 0, ackOnBusy: false } })
    const pool = { size: 0, renewals: 0, isBound: () => true, resetConversation() {}, conversation: () => ({ async send() { return '' } }) }
    const gateway = new ChatGateway(cfg, pool)
    const transport = stubTransport()
    gateway.setTransport(transport)
    await gateway.handleInbound({ ...privateInbound })
    const texts = transport.sent.map((target) => target.segments.map((segment) => segment.data?.text ?? '').join(''))
    assert('没有 ack 时兜底文案是唯一一条', texts.length === 1 && texts[0].includes('没有产生文字回复'), JSON.stringify(texts))
  }

  // ---- 2. 桩 conversation 返回纯空白：同样要有兜底
  {
    const { gateway, chats } = gatewayWith('   \n  ')
    const transport = stubTransport()
    gateway.setTransport(transport)
    await gateway.handleInbound({ ...privateInbound })
    equal(chats.length, 1)
    const texts = transport.sent.map((target) => target.segments.map((segment) => segment.data?.text ?? '').join(''))
    assert('回合只返回空白时，兜底文案被真的发出去', texts.some((text) => text.includes('没有产生文字回复')), JSON.stringify(texts))
  }

  // ---- 3. 逐条列出 handleInbound 里"还没走到 conversation.send 就返回"的路径
  // 关键点：这些路径**不应该**调用 conversation.send。线上那条消息走到了 send
  // （回合在 14:09:42 结束），所以它不属于这一类 —— 除非某条路径连日志都不留。
  {
    const cases = [
      { label: '空文本且没有附件', inbound: { ...privateInbound, text: '' } },
      { label: '群里没 @ 机器人', inbound: { chatKind: 'group', chatId: 'g1', senderId: 'u1', text: '普通发言' } },
      { label: '私聊发送者不在 allowedUsers 里', inbound: { ...privateInbound }, config: { allowedUsers: ['someone-else'] } },
      { label: '群不在 allowedGroups 里', inbound: { chatKind: 'group', chatId: 'g1', senderId: 'u1', text: '@bot 你好', atSelf: true }, config: { allowedGroups: ['g2'] } },
    ]
    for (const item of cases) {
      const { gateway, chats } = gatewayWith('不会用到')
      if (item.config !== undefined) {
        // A fresh gateway is cheaper than mutating private state: rebuild with the allowlist.
        const cfg = deepMerge(defaultConfig(), { web: { enabled: false }, chat: { prewarmCount: 0, ...item.config } })
        const pool = { size: 0, renewals: 0, isBound: () => true, resetConversation() {}, conversation: () => ({ async send() { return '' } }) }
        const listed = new ChatGateway(cfg, pool)
        listed.setTransport(stubTransport())
        await listed.handleInbound(item.inbound)
      } else {
        gateway.setTransport(stubTransport())
        await gateway.handleInbound(item.inbound)
      }
      assert(`静默返回：${item.label}`, chats.length === 0, `conversation.send 调用 ${chats.length} 次`)
    }
  }

  // ---- 4. 回合抛异常：必须有一条 ⚠️ 说明，而不是沉默
  {
    const { gateway } = gatewayWith(new Error('模型挂了'))
    const transport = stubTransport()
    gateway.setTransport(transport)
    await gateway.handleInbound({ ...privateInbound })
    const texts = transport.sent.map((target) => target.segments.map((segment) => segment.data?.text ?? '').join(''))
    assert('回合抛异常时用户收到说明', texts.some((text) => text.includes('出错了')), JSON.stringify(texts))
  }

  // ---- 5. 传输层自己抛错：不能把异常抛回给 inbound 调用方
  {
    const { gateway } = gatewayWith('有内容的回答')
    const transport = { transportLabel: 'stub(broken)', maxReplyChars: 900, async send() { throw new Error('HTTP 500') } }
    gateway.setTransport(transport)
    let threw = null
    try {
      await gateway.handleInbound({ ...privateInbound })
    } catch (error) {
      threw = error
    }
    assert('传输层失败不会把异常抛回去（网关记日志后继续）', threw === null, threw === null ? '' : String(threw))
  }

  // ---- 6. 没有传输层：这确实是"用户收不到"，但必须留一条日志
  {
    const { gateway } = gatewayWith('有内容的回答')
    gateway.setTransport(null)
    let threw = null
    try {
      await gateway.handleInbound({ ...privateInbound })
    } catch (error) {
      threw = error
    }
    assert('没有传输层时不抛异常', threw === null, threw === null ? '' : String(threw))
  }

  // ---- 7. 适配器层：网关发出的兜底文案必须真的走到 ilink 发送
  // 上面证明了网关**会**发出「（这一轮没有产生文字回复）」。但网关的 `#deliver`
  // 只是把它交给 transport；用户能不能收到，取决于 `WeChatAdapter.send()` 有没有
  // 走到底。这一层不在网关的测试范围里，而线上缺的正是 `wechat.mjs` 那条
  // `已通过 ilink 发送…` 日志 —— 所以必须在这里钉住。
  {
    const dir = mkdtempSync(join(tmpdir(), 'wechat-adapter-'))
    const statePath = join(dir, 'account.json')
    writeFileSync(statePath, JSON.stringify({ token: 'TOK', userId: 'BOT1' }), 'utf8')
    const sent = []
    let polls = 0
    // 真的 IlinkBridge + 桩 client：凭证必须来自一条真实入站消息，否则发送会在
    // 「尚未获得发送凭证」处停住 —— 那正是这条链路要验证的地方。
    const client = {
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        polls += 1
        return {
          ret: 0,
          msgs:
            polls === 1
              ? [
                  {
                    message_type: 1,
                    from_user_id: 'peer-test-0001',
                    message_id: 7,
                    context_token: 'CTX-1',
                    item_list: [{ type: 1, text_item: { text: '把里边的内容改成你好' } }],
                  },
                ]
              : [],
          cursor: 'C1',
          longpollingTimeoutMs: 10,
        }
      },
      async sendText(params) {
        sent.push(params)
        return { ret: 0, accepted: true, delivered: 'unknown', detail: 'iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理' }
      },
      async getTypingTicket() {
        return ''
      },
      async sendTyping() {},
    }
    const cfg = deepMerge(defaultConfig(), {
      web: { enabled: false },
      chat: { prewarmCount: 0, typingIndicator: true },
      wechat: {
        enabled: true,
        inbound: 'ilink',
        sendEnabled: true,
        sendStrategy: 'ilink',
        botNicknames: [],
        ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 },
      },
    })
    const lines = []
    configureLogging('debug', (entry) => lines.push(entry))
    const adapterUnderTest = new WeChatAdapter(cfg, new ChatGateway(cfg, pool), runtime, { ilink: { client } })
    const inbound = adapterUnderTest.inbound
    await inbound.start()
    const deadline = Date.now() + 3000
    while (inbound.sendCredential('peer-test-0001').ready !== true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert('适配器测试桩：入站消息把凭证带到桥接', inbound.sendCredential('peer-test-0001').ready === true, inbound.sendCredential('peer-test-0001').detail)

    await adapterUnderTest.send({
      kind: 'private',
      peerId: 'peer-test-0001',
      segments: [{ type: 'text', data: { text: '（这一轮没有产生文字回复）' } }],
    })
    await inbound.stop()
    configureLogging('debug')
    assert('兜底文案真的被送进 ilink 桥接', sent.length === 1 && sent[0].text === '（这一轮没有产生文字回复）', JSON.stringify(sent))
    assert('兜底文案的发送留下「已通过 ilink 发送…」日志', lines.some((entry) => entry.message.includes('已通过 ilink 发送')), lines.map((entry) => entry.message).join(' | ').slice(0, 300))
    rmSync(dir, { recursive: true, force: true })
  }
}

// 适配器状态：`inboundOk` 是 console-e2e 在"扫码成功后立刻查状态"时断言的那个字段。
// 那一刻第一轮长轮询还在途中，所以它必须是 true —— 「还没开始」不是「坏了」。
// 这条断言单独存在，是因为 console-e2e 在本沙箱跑不到（它要 spawn 真的 dsh，
// 而这里的管道 spawn 一律 EPERM），所以把它的关键字段在能跑的地方钉一遍。
{
  console.log('\n适配器状态：刚启动时 inboundOk 不能报异常')
  const dir = mkdtempSync(join(tmpdir(), 'wechat-status-'))
  const statePath = join(dir, 'account.json')
  writeFileSync(statePath, JSON.stringify({ token: 'TOK', userId: 'BOT1' }), 'utf8')
  let release = null
  const client = {
    token: 'TOK',
    baseUrl: 'http://stub.invalid',
    async getUpdates() {
      // 第一轮挂住 = 扫码刚成功、长轮询还没回来。
      await new Promise((resolve) => {
        release = resolve
      })
      return { ret: 0, msgs: [], cursor: 'C1', longpollingTimeoutMs: 0 }
    },
    async sendText() {
      return { ret: 0, accepted: true, delivered: 'unknown', detail: '' }
    },
    async getTypingTicket() {
      return ''
    },
    async sendTyping() {},
  }
  const cfg = deepMerge(defaultConfig(), {
    web: { enabled: false },
    chat: { prewarmCount: 0 },
    wechat: {
      enabled: true,
      inbound: 'ilink',
      sendEnabled: true,
      sendStrategy: 'ilink',
      botNicknames: [],
      ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 },
    },
  })
  const adapterUnderTest = new WeChatAdapter(cfg, new ChatGateway(cfg, pool), runtime, { ilink: { client } })
  try {
    await adapterUnderTest.inbound.start()
    const status = await adapterUnderTest.status()
    assert('刚启动（第一轮还没回来）时 inboundOk 为 true', status.inboundOk === true, `inboundOk=${status.inboundOk} detail=${status.inboundDetail}`)
    assert(
      '状态说明写的是「正在等待第一批消息」而不是异常',
      String(status.inboundDetail).includes('正在等待第一批消息'),
      status.inboundDetail,
    )
    assert('登录状态仍然如实为 true', status.loggedIn === true, String(status.loggedIn))
    release?.()
  } finally {
    await adapterUnderTest.inbound.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

await adapter.stop()
assert('停止后端口释放', true)

console.log(`\n微信链路自测：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
