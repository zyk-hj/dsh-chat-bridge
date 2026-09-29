#!/usr/bin/env node
/**
 * iLink 端到端链路自测：微信网关 → 适配器 → DSH 会话 → 回复 → 微信网关。
 *
 * `scripts/check-ilink.mjs` 只测 `IlinkBridge` 自己（协议、状态机、报文形状）。
 * 这里补的是它测不到的那一层：**真正的 `WeChatAdapter`**。整条链路上有好几个
 * 只有把两边接起来才会暴露的接缝：
 *
 *   - `config.wechat.inbound = 'ilink'` 时 provider 有没有被正确选中；
 *   - 入站事件有没有被 `handleEvent` 的昵称/去重/内容分类逻辑误伤
 *     （iLink 是私聊、没有昵称，这几条判断很容易把消息吃掉）；
 *   - 回复时 `#recipientFor()` 会不会因为「拿不到显示名」而拒绝发送
 *     —— iLink 按 user id 投递，根本不需要显示名；
 *   - 回复有没有带上入站消息里的 `context_token`（少它就发不出去）；
 *   - markdown 有没有被转成纯文本。
 *
 * 用一个本地桩网关 + 假 runtime 跑，不碰真实微信、不需要账号。
 *
 *   node scripts/check-ilink-e2e.mjs [--verbose]
 */

import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ChatGateway, singlePartReply } from '../src/chat-gateway.mjs'
import { ConversationPool } from '../src/conversation.mjs'
import { deepMerge, defaultConfig, validateConfig } from '../src/config.mjs'
import { WeChatAdapter } from '../src/wechat.mjs'
import { ILINK_MAX_REPLY_CHARS, TYPING_STATUS, aesEcbPaddedSize, extractFileMarkers, formatFileMarker, writeAccount } from '../src/wechat-ilink.mjs'
import { configureLogging } from '../src/util.mjs'

/** Every log line the run produced, so the tests can prove the operator is told what happened. */
const logLines = []
configureLogging(process.argv.includes('--verbose') ? 'debug' : 'warn', (entry) => logLines.push(entry))

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

console.log('\n[微信 iLink 端到端自测]')
console.log('（桩网关 + 真适配器，验证收 → 智能体 → 回的完整链路）')

/**
 * A runtime stand-in that records prompts and lets the test finish the turn.
 *
 * @returns {Record<string, any>} the fake runtime.
 */
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
      return `msg_${prompts.length}`
    },
  }
}

const state = {
  /** Every request the stub gateway saw, for assertions. */
  calls: [],
  /** Messages the stub hands out on the next poll. */
  outbox: [],
  /** Cursor handed back to the client. */
  cursor: '',
}

/**
 * Upload target handed back by `getuploadurl`.
 *
 * It is filled in after the stub CDN is listening; a handler runs only once a
 * request arrives, never at definition time, so the late assignment is safe.
 */
let uploadBase = ''

const server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk) => {
    raw += chunk
  })
  request.on('end', () => {
    const body = raw === '' ? null : JSON.parse(raw)
    state.calls.push({ path: request.url, body, headers: request.headers })
    const send = (payload) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (request.url.startsWith('/ilink/bot/getupdates')) {
      // Hand out whatever the test queued, then go quiet — a real gateway never
      // repeats a batch it has already delivered.
      const msgs = state.outbox
      state.outbox = []
      state.cursor = state.cursor === '' ? 'CURSOR1' : `CURSOR${Number(state.cursor.slice(6)) + 1}`
      send({ ret: 0, msgs, get_updates_buf: state.cursor, longpolling_timeout_ms: 300 })
      return
    }
    if (request.url.startsWith('/ilink/bot/getconfig')) {
      send({ ret: 0, typing_ticket: 'TICKET1' })
      return
    }
    if (request.url.startsWith('/ilink/bot/getuploadurl')) {
      // Point the file upload at the stub CDN below. `upload_full_url` is the
      // server-supplied upload target from the official protocol; the CDN stub
      // answers with the download parameter in a response header.
      send({ ret: 0, upload_full_url: uploadBase })
      return
    }
    send({ ret: 0, errcode: 0 })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'ilink-e2e-'))
const statePath = join(dir, 'account.json')
writeAccount(statePath, { token: 'TOK', userId: 'BOT1', baseUrl: base })

// The media CDN, stubbed. iLink never inlines bytes: the message carries an
// `encrypted_query_param` and an AES key, and the image only becomes visible to
// the model if the bridge fetches it, decrypts it and hands it over. Serving an
// AES-128-ECB encrypted PNG is what proves that whole path.
/** One fixed payload is enough: every assertion below is about this image arriving intact. */
const mediaKey = randomBytes(16)
const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('e2e-image'),
])
const encryptedImage = (() => {
  const cipher = createCipheriv('aes-128-ecb', mediaKey, null)
  return Buffer.concat([cipher.update(pngBytes), cipher.final()])
})()
/** Every CDN request, for assertions. */
const cdnRequests = []
const cdn = createServer((request, response) => {
  cdnRequests.push(String(request.url))
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  response.end(encryptedImage)
})
await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
const cdnBase = `http://127.0.0.1:${cdn.address().port}/c2c/download`

// The upload half of the CDN, stubbed. Outbound files travel the other way: the
// bridge encrypts the bytes locally, POSTs the ciphertext here, and reads the
// download parameter out of the `x-encrypted-param` RESPONSE HEADER — which is
// why the stub keeps the body it received: the only way to prove the upload was
// the ciphertext (and not the plaintext) is to decrypt it again below.
/** Every upload the stub CDN received. */
const uploads = []
const uploadCdn = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    uploads.push({
      url: String(request.url),
      method: String(request.method),
      contentType: String(request.headers['content-type'] ?? ''),
      body: Buffer.concat(chunks),
    })
    // `x-encrypted-param` is the ONLY source of the download parameter; the body
    // is deliberately left empty so an implementation that reads the body instead
    // cannot pass by accident.
    response.writeHead(200, { 'x-encrypted-param': `DL-${uploads.length}` })
    response.end('')
  })
})
await new Promise((resolve) => uploadCdn.listen(0, '127.0.0.1', resolve))
uploadBase = `http://127.0.0.1:${uploadCdn.address().port}/c2c/upload`

const config = validateConfig(
  deepMerge(defaultConfig(), {
    web: { enabled: false },
    chat: { prewarmCount: 0, ackOnBusy: false, typingIndicator: true },
    wechat: {
      enabled: true,
      inbound: 'ilink',
      sendEnabled: true,
      sendStrategy: 'ilink',
      botNicknames: [],
      ilink: {
        baseUrl: base,
        statePath,
        token: 'TOK',
        pollTimeoutMs: 300,
        cdnBaseUrl: cdnBase,
        mediaDir: join(dir, 'media'),
      },
    },
  }),
)

const runtime = fakeRuntime()
const pool = new ConversationPool(config, runtime)
const gateway = new ChatGateway(config, pool)
const adapter = new WeChatAdapter(config, gateway, runtime)

/**
 * Wait until a condition holds, or give up.
 *
 * @param {() => boolean} predicate - the condition.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<boolean>} whether it became true.
 */
async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

try {
  await adapter.start()

  /** Queue one inbound message for the stub to deliver. */
  const deliver = (message) => {
    state.outbox.push(message)
  }

  // ---------------------------------------------------------- 收
  console.log('\n1. 收到微信消息 → 送进 DSH 会话')
  assert('适配器以 ilink 作为入站 provider', adapter.transportLabel.includes('ilink'), adapter.transportLabel)
  deliver({
    message_type: 1,
    from_user_id: 'alice@im.wechat',
    to_user_id: 'bot@im.bot',
    message_id: 1001,
    create_time_ms: 1700000000000,
    context_token: 'CTX-ALICE',
    item_list: [{ type: 1, text_item: { text: '帮我看下这个报错' } }],
  })
  const gotPrompt = await waitFor(() => runtime.prompts.length >= 1)
  assert('消息被送进 DSH 会话', gotPrompt, `prompts=${runtime.prompts.length}`)
  const prompt = runtime.prompts.at(-1)
  equal(prompt?.text, '帮我看下这个报错')

  // iLink 的私聊没有昵称，显示名回落成 user id 是预期行为，不该被当成群聊。
  assert('私聊会话 id 用的是对方 user id', prompt?.sessionId !== undefined)

  // ---------------------------------------------------------- 输入状态
  console.log('\n2. 原生「正在输入」状态')
  const typingShown = await waitFor(() =>
    state.calls.some((call) => call.path.startsWith('/ilink/bot/sendtyping') && call.body?.status === TYPING_STATUS.TYPING),
  )
  assert('生成期间显示了「正在输入」', typingShown)
  const typingTicket = state.calls.find((call) => call.path.startsWith('/ilink/bot/getconfig'))
  assert('先取过 typing_ticket 再发状态', typingTicket !== undefined)

  // ---------------------------------------------------------- 回
  console.log('\n3. 智能体回答 → 回到微信')
  const conversation = pool.conversationForSession(prompt.sessionId)
  if (conversation === undefined) throw new Error('会话还没有绑定，无法结束回合')
  // `turn/start` must come first: the pool locks onto the turn number it carries,
  // and every later event is matched against it. Replaying only the assistant
  // message would look like a foreign turn and be dropped.
  conversation.handleNotification('session.event', {
    sessionId: prompt.sessionId,
    event: { type: 'turn/start', data: { turn: 1 } },
  })
  conversation.handleNotification('session.event', {
    sessionId: prompt.sessionId,
    event: {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '**结论**：是空指针。\n\n`x.y` 没初始化。' }] } },
    },
  })
  conversation.handleNotification('session.status', { sessionId: prompt.sessionId, status: 'idle' })

  const sent = await waitFor(() => state.calls.some((call) => call.path.startsWith('/ilink/bot/sendmessage')))
  assert('回复被发回微信', sent)
  const sendCall = state.calls.find((call) => call.path.startsWith('/ilink/bot/sendmessage'))
  const outgoing = sendCall?.body?.msg

  equal(outgoing?.to_user_id, 'alice@im.wechat')
  equal(outgoing?.message_type, 2)
  equal(outgoing?.message_state, 2)
  // 少了这个 token，网关会把回复丢进虚空——这是整个协议最容易踩的坑。
  equal(outgoing?.context_token, 'CTX-ALICE')
  const replied = outgoing?.item_list?.[0]?.text_item?.text ?? ''
  assert('回复走了纯文本（markdown 已剥离）', !replied.includes('**') && !replied.includes('`'), replied)
  assert('回复内容完整保留', replied.includes('结论') && replied.includes('空指针'), replied)

  const typingCleared = state.calls.some(
    (call) => call.path.startsWith('/ilink/bot/sendtyping') && call.body?.status === TYPING_STATUS.CANCEL,
  )
  assert('发送前清掉了「正在输入」', typingCleared)

  // ---------------------------------------------------------- 过滤
  console.log('\n4. 不该回答的消息')
  const before = runtime.prompts.length
  deliver({ message_type: 2, from_user_id: 'alice@im.wechat', message_id: 1002, item_list: [{ type: 1, text_item: { text: '机器人自己发的' } }] })
  deliver({ message_type: 1, from_user_id: 'alice@im.wechat', message_id: 1003, item_list: [] })
  // `[系统消息]` is the exact placeholder `classifyContent` recognises; anything
  // else is ordinary text and *should* wake the agent.
  deliver({ message_type: 1, from_user_id: 'alice@im.wechat', message_id: 1004, item_list: [{ type: 1, text_item: { text: '[系统消息]' } }] })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert('机器人自己发的 / 空消息 / 系统占位都不会唤醒智能体', runtime.prompts.length === before, `prompts=${runtime.prompts.length}`)

  // 同一条消息重投（网关游标回退时会这样）不能被回答两次。
  deliver({ message_type: 1, from_user_id: 'alice@im.wechat', message_id: 1001, item_list: [{ type: 1, text_item: { text: '帮我看下这个报错' } }] })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert('重复投递的同一条消息只被回答一次', runtime.prompts.length === before, `prompts=${runtime.prompts.length}`)

  // ---------------------------------------------------------- 状态
  console.log('\n5. status() 正确汇报 iLink 状态')
  const status = await adapter.status()
  equal(status.provider, 'ilink')
  equal(status.sendStrategy, 'ilink')
  equal(status.loggedIn, true)
  assert('凭据路径被回报', String(status.accountPath).includes('account.json'), status.accountPath)
  assert('机器人账号被回报', status.accountUser === 'BOT1', status.accountUser)
  assert('入站健康检查通过', status.inboundOk === true, status.inboundDetail)
  // 收到过 alice 的消息，所以回复凭证应当就绪：iLink 只能被动回复，凭证随对方
  // 消息下发（openclaw#52153），控制台要能看出这一点。
  equal(status.sendCredentialState, 'ready')
  assert('发送凭证已就绪被回报', status.sendCredentialReady === true, status.sendCredentialDetail)
  // 单条上限告诉控制台：iLink 的回复不会切成多条连发（openclaw#79293）。
  assert('单条回复上限被回报', status.replyLimitChars === ILINK_MAX_REPLY_CHARS, String(status.replyLimitChars))

  // ---------------------------------------------------------- 图片
  console.log('\n6. 图片消息降级为占位文本而不是报错')
  deliver({
    message_type: 1,
    from_user_id: 'alice@im.wechat',
    message_id: 2001,
    context_token: 'CTX-ALICE',
    item_list: [{ type: 2, image_item: {} }],
  })
  const gotImage = await waitFor(() => runtime.prompts.length > before)
  assert('图片消息也能唤醒智能体', gotImage)
  equal(runtime.prompts.at(-1)?.text, '[图片]')

  // ---------------------------------------------------------- 图片内容真的到了模型
  console.log('\n7. 图片被下载解密后作为附件交给智能体')
  const imagePromptsBefore = runtime.prompts.length
  // A fresh chat on purpose: the pool runs one turn per conversation at a time,
  // and the placeholder check above deliberately leaves its turn open.
  deliver({
    message_type: 1,
    from_user_id: 'bob@im.wechat',
    message_id: 2002,
    context_token: 'CTX-BOB',
    item_list: [
      {
        type: 2,
        image_item: { media: { encrypt_query_param: 'E2E-QP', aes_key: mediaKey.toString('base64') } },
      },
    ],
  })
  const gotAttachment = await waitFor(() => runtime.prompts.length > imagePromptsBefore)
  assert('带媒体的图片消息被送进智能体', gotAttachment, `prompts=${runtime.prompts.length}`)
  const imagePrompt = runtime.prompts.at(-1)
  // `content` 仍是 [图片]：适配器据此把消息分类成图片，再挂上下载到的字节。
  equal(imagePrompt?.text, '[图片]')
  const attachment = imagePrompt?.attachments?.[0]
  equal(attachment?.type, 'image')
  equal(attachment?.mimeType, 'image/png')
  equal(Buffer.from(String(attachment?.data), 'base64').toString('latin1'), pngBytes.toString('latin1'))
  assert(
    '下载用的是 encrypted_query_param',
    String(cdnRequests.at(-1)).includes('encrypted_query_param=E2E-QP'),
    String(cdnRequests.at(-1)),
  )

  // ---------------------------------------------------------- 长回复只发一条
  console.log('\n8. 长回答只发一条（iLink 单条上限，不切块连发）')
  const sendsBefore = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length
  // A 3000-character answer: 20 paragraphs, well past both the chat limit and the
  // iLink budget, so the old code would have sent several messages back-to-back —
  // the exact pattern openclaw#79293 reports as silently lost.
  const longAnswer = Array.from({ length: 20 }, (_unused, index) => `第 ${index + 1} 段：${'甲'.repeat(140)}`).join('\n\n')
  assert('测试用的长回答确实超长', longAnswer.length > 2000, `${longAnswer.length} 字`)

  // 直接钉住「压成一条」的边界行为：上限之内原样通过，超出只截一次并如实报出省略字数。
  equal(singlePartReply('短回答', ILINK_MAX_REPLY_CHARS), { text: '短回答', omitted: 0 })
  const cappedDirect = singlePartReply(longAnswer, ILINK_MAX_REPLY_CHARS)
  assert('压成一条后不超过上限（含说明）', cappedDirect.text.length <= ILINK_MAX_REPLY_CHARS + 60, `${cappedDirect.text.length} 字`)
  assert(
    '省略了多少字被如实报出',
    cappedDirect.omitted > 0 && cappedDirect.text.includes(`约 ${cappedDirect.omitted} 字`),
    String(cappedDirect.omitted),
  )

  /**
   * A pool stand-in whose one conversation answers with a fixed string.
   *
   * The gateway only asks a pool for `conversation(key, kind).send({…}) → string`,
   * which is the whole contract this check needs; the real pool's turn machinery
   * (session binding, turn locking) is exercised by `smoke.mjs` and
   * `check-wechat.mjs`.
   */
  const answeringPool = {
    size: 0,
    renewals: 0,
    isBound: () => true,
    resetConversation() {},
    conversation: () => ({ async send() { return longAnswer } }),
  }
  const longGateway = new ChatGateway(config, answeringPool)
  // The adapter is already the installed transport on the real gateway; pointing a
  // second gateway at the same object is what lets this check drive one long reply
  // through the real adapter, the real sender and the real HTTP path.
  longGateway.setTransport(adapter)
  await longGateway.handleInbound({
    chatKind: 'private',
    chatId: 'alice@im.wechat',
    senderId: 'alice@im.wechat',
    senderName: 'alice',
    text: '给我一段很长的说明',
    atSelf: true,
  })
  const longSends = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).slice(sendsBefore)
  // 这是本条约束的核心：以前会按 1500 字切块连发好几条，正好命中 iLink 的静默丢消息。
  assert('长回答只发一条消息', longSends.length === 1, `sendmessage 次数=${longSends.length}`)
  const longText = longSends[0]?.body?.msg?.item_list?.[0]?.text_item?.text ?? ''
  assert(
    '单条消息不超过上限（含截断说明）',
    longText.length <= ILINK_MAX_REPLY_CHARS + 60,
    `${longText.length} 字`,
  )
  // 截断必须让用户看见，而不是悄悄丢内容。
  assert('被截断的部分在消息里说明', longText.includes('已省略'), longText.slice(-40))
  const truncatedLog = logLines.find((entry) => entry.level === 'warn' && entry.message.includes('已截断'))
  assert('截断同时写进日志', truncatedLog !== undefined, truncatedLog?.message ?? '(没有日志)')

  // 同一路径下的普通短回答不受影响：仍然是一条，且没有多余说明。
  const shortSendsBefore = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length
  const shortPool = {
    size: 0,
    renewals: 0,
    isBound: () => true,
    resetConversation() {},
    conversation: () => ({ async send() { return '短回答' } }),
  }
  const shortGateway = new ChatGateway(config, shortPool)
  shortGateway.setTransport(adapter)
  await shortGateway.handleInbound({
    chatKind: 'private',
    chatId: 'alice@im.wechat',
    senderId: 'alice@im.wechat',
    senderName: 'alice',
    text: '简短点',
    atSelf: true,
  })
  const shortSends = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).slice(shortSendsBefore)
  equal(shortSends.length, 1)
  equal(shortSends[0]?.body?.msg?.item_list?.[0]?.text_item?.text, '短回答')

  // ---------------------------------------------------------- 没有凭证
  console.log('\n9. 还没有发送凭证时的失败原因')
  const freshPath = join(dir, 'fresh.json')
  writeAccount(freshPath, { token: 'TOK', userId: 'BOT1', baseUrl: base })
  const freshConfig = validateConfig(
    deepMerge(defaultConfig(), {
      web: { enabled: false },
      chat: { prewarmCount: 0 },
      wechat: {
        enabled: true,
        inbound: 'ilink',
        sendEnabled: true,
        sendStrategy: 'ilink',
        botNicknames: [],
        ilink: { baseUrl: base, statePath: freshPath, token: 'TOK', pollTimeoutMs: 300 },
      },
    }),
  )
  // 一份全新的凭据文件 = 一个刚重启的进程：登录没问题，但还没有任何人给它发过消息。
  const freshAdapter = new WeChatAdapter(freshConfig, new ChatGateway(freshConfig, pool), runtime)
  const freshStatus = await freshAdapter.status()
  equal(freshStatus.sendCredentialState, 'none')
  equal(freshStatus.sendCredentialReady, false)
  assert('状态里给出可操作的做法', String(freshStatus.sendCredentialDetail).includes('发一条消息'), freshStatus.sendCredentialDetail)
  let freshError = null
  try {
    await freshAdapter.send({ kind: 'private', peerId: 'bob@im.wechat', segments: [{ type: 'text', data: { text: '你好' } }] })
  } catch (error) {
    freshError = error
  }
  assert(
    '没有凭证时发送给出可操作失败原因',
    freshError !== null && String(freshError.message).includes('请先在微信里给机器人发一条消息'),
    freshError === null ? '(竟然成功了)' : String(freshError.message),
  )
  // ---------------------------------------------------------- 出站发文件
  console.log('\n10. 回答里带附件标记 → 先文字、后媒体（上传密文到 CDN）')
  // One failure must not hide the rest of this section: an assertion that throws
  // inside here is recorded as a failure and the remaining checks still run.
  try {
    /** @param {Buffer} ciphertext - to decrypt. @param {Buffer} key - 16 bytes. @returns {Buffer} the plaintext. */
    const decryptEcb = (ciphertext, key) => {
      const decipher = createDecipheriv('aes-128-ecb', key, null)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    }

    // A fresh chat: the reply is addressed by chat id, and a conversation keyed by
    // a peer that has never written in has no `context_token` to echo, which iLink
    // refuses to deliver. `carol` writes first so the bridge holds one.
    const carol = 'carol@im.wechat'
    const beforCarol = runtime.prompts.length
    deliver({
      message_type: 1,
      from_user_id: carol,
      message_id: 3001,
      context_token: 'CTX-CAROL',
      item_list: [{ type: 1, text_item: { text: '把报告发我' } }],
    })
    assert('carol 的消息被受理（拿到回复凭证）', await waitFor(() => runtime.prompts.length > beforCarol), `prompts=${runtime.prompts.length}`)

    const imagePath = join(dir, 'report-image.png')
    const imageBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('e2e-outbound-image')])
    writeFileSync(imagePath, imageBytes)
    const imageMd5 = createHash('md5').update(imageBytes).digest('hex')

    // The exact copy the model writes: a sentence, then the marker on its own
    // line. `formatFileMarker` is the shared spelling, so the test cannot drift
    // away from what the outbound scanner looks for.
    const label = '报告已经生成，见附件。'
    const answer = `${label}\n${formatFileMarker(imagePath)}`
    assert('标记是 [[send-file: …]]', answer.includes(`[[send-file: ${imagePath}]]`), answer)
    // The scanner and the renderer must agree on the exact spelling, otherwise the
    // adapter would hand WeChat a path it never unwraps.
    const roundTrip = extractFileMarkers(answer)
    equal(roundTrip.paths, [imagePath])
    equal(roundTrip.text, label)

    // Drive the real chain: real `ChatGateway` → real `WeChatAdapter` → real
    // `IlinkBridge` → stub gateway + stub CDN. The gateway is what hands the
    // marker text to the adapter, so the test does not assume where the marker is
    // unwrapped.
    const beforeUpload = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length
    const filePool = {
      size: 0,
      renewals: 0,
      isBound: () => true,
      resetConversation() {},
      conversation: () => ({ async send() { return answer } }),
    }
    const fileGateway = new ChatGateway(config, filePool)
    fileGateway.setTransport(adapter)
    await fileGateway.handleInbound({
      chatKind: 'private',
      chatId: carol,
      senderId: carol,
      senderName: 'carol',
      text: '把报告发我',
      atSelf: true,
    })
    await waitFor(() => state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length >= beforeUpload + 2)

    const outbound = state.calls
      .filter((call) => call.path.startsWith('/ilink/bot/sendmessage'))
      .slice(beforeUpload)
      .filter((call) => call.body?.msg?.to_user_id === carol)
    equal(outbound.length, 2)
    equal(outbound[0]?.body?.msg?.context_token, 'CTX-CAROL')
    equal(outbound[1]?.body?.msg?.context_token, 'CTX-CAROL')
    // 顺序是硬要求：官方先把 TEXT 作为独立一次请求发出去，再发媒体（一次一个 item）。
    // 桩网关按到达顺序记录，所以这里就是线上顺序。
    equal(
      outbound.map((call) => call.body?.msg?.item_list?.[0]?.type),
      [1, 2],
    )

    // ---- 先一条 TEXT，正文里的标记已经被删干净
    const textItem = outbound[0]?.body?.msg?.item_list?.[0]
    equal(textItem?.type, 1)
    const outgoingText = String(textItem?.text_item?.text ?? '')
    assert('标记没有再发给用户', !outgoingText.includes('send-file'), outgoingText)
    assert('正文说明还在', outgoingText.includes('报告已经生成'), outgoingText)
    equal(outgoingText, label)

    // ---- 再一条媒体 item：图片走 image_item
    const imageItem = outbound[1]?.body?.msg?.item_list?.[0]
    equal(imageItem?.type, 2)
    const imageMedia = imageItem?.image_item?.media
    assert('媒体引用了 CDN 下载参数', typeof imageMedia?.encrypt_query_param === 'string' && imageMedia.encrypt_query_param !== '', String(imageMedia?.encrypt_query_param))
    equal(imageMedia?.encrypt_type, 1)
    // 密文大小（不是明文）：官方把 ImageItem.mid_size 填成加密后的字节数。
    equal(imageItem?.image_item?.mid_size, aesEcbPaddedSize(imageBytes.length))

    // ---- aes_key 是 hex 字符串的 base64，能解回同一个 key
    const aesKeyB64 = String(imageMedia?.aes_key ?? '')
    const keyFromItem = Buffer.from(aesKeyB64, 'base64')
    equal(keyFromItem.length, 32)
    assert('aes_key 是 hex 字符串的 base64', /^[0-9a-f]{32}$/.test(keyFromItem.toString('utf8')), keyFromItem.toString('utf8'))
    assert('aes_key 不是 16 字节原始 key 的 base64', keyFromItem.length !== 16)

    // ---- getuploadurl 的报文：明文大小 / 密文大小 / 明文 md5 / media_type
    // Read the calls only now: this section's traffic is what is being asserted, so
    // the snapshot must be taken after the reply has actually gone out.
    const uploadRequests = state.calls
      .filter((call) => call.path.startsWith('/ilink/bot/getuploadurl'))
      .map((call) => ({ body: call.body }))
    equal(uploadRequests.length, 1)
    const uploadBody = uploadRequests[0].body
    // 同一个 key 必须两边一致：`aeskey` 是 hex，媒体 item 里的 `aes_key` 是它的 base64。
    equal(keyFromItem.toString('utf8'), String(uploadBody.aeskey))
    equal(uploadBody.rawsize, imageBytes.length)
    equal(uploadBody.filesize, aesEcbPaddedSize(imageBytes.length))
    equal(uploadBody.rawfilemd5, imageMd5)
    assert('图片的 media_type 是 1', Number(uploadBody.media_type) === 1, String(uploadBody.media_type))
    equal(uploadBody.to_user_id, carol)
    assert('filekey 是 32 位 hex', /^[0-9a-f]{32}$/.test(String(uploadBody.filekey)), String(uploadBody.filekey))

    // ---- 上传到桩 CDN 的确实是密文，且能解回原文件
    equal(uploads.length, 1)
    assert('上传用 POST', uploads[0].method === 'POST', uploads[0].method)
    assert('上传 Content-Type 是 octet-stream', uploads[0].contentType.includes('application/octet-stream'), uploads[0].contentType)
    equal(uploads[0].body.length, aesEcbPaddedSize(imageBytes.length))
    assert('上传的不是明文', !uploads[0].body.equals(imageBytes))
    equal(decryptEcb(uploads[0].body, Buffer.from(String(uploadBody.aeskey), 'hex')).toString('latin1'), imageBytes.toString('latin1'))
    equal(imageMedia?.encrypt_query_param, 'DL-1')

    // ---- 非图片走 file_item：file_name / len(明文) / 同一套 media 字段
    const textPath = join(dir, '报表 2024.txt')
    const textBytes = Buffer.from('iLink 出站文件内容：中文也要原样到达。', 'utf8')
    writeFileSync(textPath, textBytes)
    const deliverBefore = state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length
    const textPool = {
      size: 0,
      renewals: 0,
      isBound: () => true,
      resetConversation() {},
      conversation: () => ({ async send() { return `文件在这里\n${formatFileMarker(textPath)}` } }),
    }
    const textGateway = new ChatGateway(config, textPool)
    textGateway.setTransport(adapter)
    await textGateway.handleInbound({
      chatKind: 'private',
      chatId: carol,
      senderId: carol,
      senderName: 'carol',
      text: '再发个表格',
      atSelf: true,
    })
    await waitFor(() => state.calls.filter((call) => call.path.startsWith('/ilink/bot/sendmessage')).length >= deliverBefore + 2)
    const fileCalls = state.calls
      .filter((call) => call.path.startsWith('/ilink/bot/sendmessage'))
      .slice(deliverBefore)
      .filter((call) => call.body?.msg?.to_user_id === carol)
    equal(fileCalls.length, 2)
    const mediaItem = fileCalls[1]?.body?.msg?.item_list?.[0]
    equal(mediaItem?.type, 4)
    equal(mediaItem?.file_item?.file_name, '报表 2024.txt')
    equal(mediaItem?.file_item?.len, String(textBytes.length))
    equal(mediaItem?.file_item?.media?.encrypt_type, 1)
    assert('文件也带下载参数', String(mediaItem?.file_item?.media?.encrypt_query_param ?? '') !== '', String(mediaItem?.file_item?.media?.encrypt_query_param))
    // Re-read now that both replies have gone out: the image above and this file.
    const allUploadRequests = state.calls
      .filter((call) => call.path.startsWith('/ilink/bot/getuploadurl'))
      .map((call) => ({ body: call.body }))
    equal(allUploadRequests.length, 2)
    equal(allUploadRequests[1]?.body?.media_type, 3)
    equal(allUploadRequests[1]?.body?.rawsize, textBytes.length)
    equal(allUploadRequests[1]?.body?.rawfilemd5, createHash('md5').update(textBytes).digest('hex'))
    equal(uploads.length, 2)
    const fileKey = Buffer.from(String(mediaItem?.file_item?.media?.aes_key ?? ''), 'base64').toString('utf8')
    // The file path gets the same exact-bytes check as the image: a length-only
    // assertion would pass even if the wrong bytes were uploaded.
    assert('文件的 aes_key 也是 hex 字符串的 base64', /^[0-9a-f]{32}$/.test(fileKey), fileKey)
    equal(decryptEcb(uploads[1].body, Buffer.from(fileKey, 'hex')).toString('utf8'), textBytes.toString('utf8'))
    const staleUpload = uploads[1].body
    assert('文件上传的确实是密文', !staleUpload.equals(textBytes))
    equal(staleUpload.length, aesEcbPaddedSize(textBytes.length))
  } catch (error) {
    failures += 1
    console.error(`  ✗ 出站发文件小节中断：${error instanceof Error ? error.message : error}`)
  }
} finally {
  await adapter.stop()
  server.close()
  cdn.close()
  uploadCdn.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log('iLink 端到端自测：全部通过')
  process.exit(0)
}
console.error(`iLink 端到端自测：${failures} 项失败`)
process.exit(1)
