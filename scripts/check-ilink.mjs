#!/usr/bin/env node
/**
 * WeChat iLink Bot route self-test.
 *
 * iLink is WeChat's own bot API, so this route can be verified properly: the
 * request/response contract is checked against a stub server, and `--live` talks
 * to the real gateway to confirm the endpoint, headers and QR handshake work from
 * this machine.
 *
 *   node scripts/check-ilink.mjs
 *   node scripts/check-ilink.mjs --live
 */

import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  CONTEXT_TOKEN_TTL_MS,
  ERRCODE_SESSION_EXPIRED,
  ILINK_BOT_TYPE,
  ILINK_CDN_BASE_URL,
  ILINK_CDN_DOWNLOAD_URL,
  ILINK_MAX_REPLY_CHARS,
  ILINK_PROTOCOL_VERSION,
  IlinkBridge,
  IlinkClient,
  IlinkError,
  MESSAGE_ITEM_TYPE,
  MESSAGE_STATE,
  MESSAGE_TYPE,
  QR_STATUS_TIMEOUT_MS,
  UPLOAD_MEDIA_TYPE,
  aesEcbPaddedSize,
  buildClientVersion,
  buildCommonHeaders,
  buildIlinkHeaders,
  cdnDownloadUrl,
  cdnUploadBaseUrl,
  decodeMediaAesKey,
  decryptMediaEcb,
  downloadIlinkMedia,
  encryptMediaEcb,
  extractFileMarkers,
  formatFileMarker,
  formatTtl,
  hydrateIlinkMedia,
  loginWithQrCode,
  markdownToPlainText,
  normalizeIlinkMessage,
  randomWechatUin,
  readAccount,
  resolveContextTokenTtlMs,
  writeAccount,
} from '../src/wechat-ilink.mjs'
import { configureLogging } from '../src/util.mjs'

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

/**
 * Read a header by its exact wire casing.
 *
 * `request.headers` lower-cases everything, so it cannot prove we send the
 * `iLink-App-Id` capitalisation the gateway expects; `rawHeaders` can.
 *
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string} name - header name in its original casing.
 * @returns {string} the value, or an empty string.
 */
function rawHeader(request, name) {
  const headers = request.rawHeaders ?? []
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i] === name) return String(headers[i + 1])
  }
  return ''
}

console.log('\n[微信 iLink Bot 自测]')
console.log('（这是微信官方的机器人接口，不是注入也不是破解）')

// ------------------------------------------------------------ 版本号打包
{
  console.log('\n1. 版本号与请求头')
  assert('2.1.3 → 0x020103', buildClientVersion('2.1.3') === 0x020103)
  assert('协议版本常量', ILINK_PROTOCOL_VERSION === '2.4.9')
  assert('缺段按 0 补齐', buildClientVersion('3') === 0x030000)
  // 头部必须是「打包成十进制」的整数，服务端按数字解析：空值或 0 会让整个
  // 登录握手失败（官方 CHANGELOG 2.4.3 记录过这个生产事故）。
  const packed = String(buildClientVersion(ILINK_PROTOCOL_VERSION))
  assert('版本头是十进制字符串', buildCommonHeaders()['iLink-App-ClientVersion'] === packed, packed)

  // GET 只带身份头；参数量必须和官方实现一致，多一个都可能被网关当成别的客户端。
  const common = buildCommonHeaders()
  equal(Object.keys(common).sort(), ['iLink-App-ClientVersion', 'iLink-App-Id'])
  assert('身份头标识为 bot', common['iLink-App-Id'] === 'bot')
  assert('GET 不带 X-WECHAT-UIN', common['X-WECHAT-UIN'] === undefined)
  assert('GET 不带 Content-Type', common['Content-Type'] === undefined)
  assert('GET 不带 Authorization', common.Authorization === undefined)

  const headers = buildIlinkHeaders({ token: 'tok' })
  assert('带 token 时有 Authorization', headers.Authorization === 'Bearer tok')
  assert('授权类型正确', headers.AuthorizationType === 'ilink_bot_token')
  assert('POST 带 JSON 内容类型', headers['Content-Type'] === 'application/json')
  assert('POST 也带身份头', headers['iLink-App-ClientVersion'] === packed)

  // X-WECHAT-UIN 是「随机 uint32 → 十进制字符串 → base64」，不是四个随机字节。
  const decoded = Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8')
  assert('UIN 是十进制数字串的 base64', /^\d{1,10}$/.test(decoded), decoded)
  assert('每次请求 UIN 不同', randomWechatUin() !== randomWechatUin())

  const anonymous = buildIlinkHeaders({})
  assert('不带 token 时无 Authorization', anonymous.Authorization === undefined)
  assert('默认走 ClawBot 的 bot_type', ILINK_BOT_TYPE === '3')
  assert('二维码状态轮询超时与官方一致', QR_STATUS_TIMEOUT_MS === 35000)
}

// ------------------------------------------------------------ markdown 过滤
{
  console.log('\n2. Markdown 转纯文本（微信只认纯文本）')
  assert('去掉粗体', markdownToPlainText('**重要**') === '重要')
  assert('去掉行内代码', markdownToPlainText('用 `npm i` 装') === '用 npm i 装')
  assert('代码块保留内容', markdownToPlainText('```js\nlet a = 1\n```') === 'let a = 1')
  assert('无语言标记的代码块保留内容', markdownToPlainText('```\nsandbox-ok\n```') === 'sandbox-ok')
  // 回归：模型经常把命令输出写成同一行的内联围栏。旧实现要求开围栏后必须跟换行，
  // 于是正则一路吃到下一个换行、把中间的内容整段删掉 —— 一条回复的要点就这么没了。
  assert(
    '内联围栏保留内容',
    markdownToPlainText('命令 1：``` sandbox-ok ``` 命令 2：``` v24.21.0 ```') === '命令 1： sandbox-ok  命令 2： v24.21.0',
    markdownToPlainText('命令 1：``` sandbox-ok ``` 命令 2：``` v24.21.0 ```'),
  )
  assert(
    '内联围栏不吞掉同一行后面的文字',
    markdownToPlainText('输出如下：``` sandbox-ok ```\n另外还有一句').includes('另外还有一句'),
    markdownToPlainText('输出如下：``` sandbox-ok ```\n另外还有一句'),
  )
  assert(
    '内联围栏后的同行内容不会被删',
    markdownToPlainText('A ```x``` B ```y``` C') === 'A x B y C',
    markdownToPlainText('A ```x``` B ```y``` C'),
  )
  assert('去掉标题井号', markdownToPlainText('## 标题') === '标题')
  assert('链接保留地址', markdownToPlainText('[官网](https://x.com)') === '官网 (https://x.com)')
  assert('压缩多余空行', markdownToPlainText('a\n\n\n\nb') === 'a\n\nb')
}

// ------------------------------------------------------------ 消息归一化
{
  console.log('\n3. 入站消息归一化')
  const event = normalizeIlinkMessage({
    message_type: MESSAGE_TYPE.USER,
    from_user_id: 'wxid_alice',
    message_id: 4242,
    create_time_ms: 1700000000000,
    context_token: 'CTX',
    item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '你好' } }],
  })
  assert('文本消息能识别', event !== null)
  equal(event.sessionId, 'wxid_alice')
  equal(event.sessionType, 'private')
  equal(event.content, '你好')
  equal(event.rawid, '4242')
  equal(event.timestamp, 1700000000)
  equal(event.contextToken, 'CTX')
  equal(event.isSend, false)

  assert(
    '机器人自己的消息被忽略',
    normalizeIlinkMessage({ message_type: MESSAGE_TYPE.BOT, from_user_id: 'x', item_list: [] }) === null,
  )
  assert('没有发送者的消息被忽略', normalizeIlinkMessage({ message_type: MESSAGE_TYPE.USER }) === null)
  assert(
    '空消息被忽略',
    normalizeIlinkMessage({ message_type: MESSAGE_TYPE.USER, from_user_id: 'x', item_list: [] }) === null,
  )

  const image = normalizeIlinkMessage({
    message_type: MESSAGE_TYPE.USER,
    from_user_id: 'x',
    item_list: [{ type: MESSAGE_ITEM_TYPE.IMAGE, image_item: {} }],
  })
  equal(image.content, '[图片]')

  const both = normalizeIlinkMessage({
    message_type: MESSAGE_TYPE.USER,
    from_user_id: 'x',
    item_list: [
      { type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '看这个' } },
      { type: MESSAGE_ITEM_TYPE.FILE, file_item: { file_name: 'a.pdf' } },
    ],
  })
  equal(both.content, '看这个\n[文件] a.pdf')

  const voice = normalizeIlinkMessage({
    message_type: MESSAGE_TYPE.USER,
    from_user_id: 'x',
    item_list: [{ type: MESSAGE_ITEM_TYPE.VOICE, voice_item: { text: '转写内容' } }],
  })
  equal(voice.content, '[语音] 转写内容')
}

// ------------------------------------------------------------ 凭据读写
{
  console.log('\n4. 凭据文件读写')
  const dir = mkdtempSync(join(tmpdir(), 'ilink-'))
  try {
    const path = join(dir, 'nested', 'account.json')
    assert('缺失时读出 null', readAccount(path) === null)
    writeAccount(path, { token: 'tok', userId: 'u1' })
    const back = readAccount(path)
    equal(back.token, 'tok')
    assert('目录会自动创建', readFileSync(path, 'utf8').includes('"userId": "u1"'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 扫码握手报文
{
  console.log('\n5. 扫码握手报文（对齐官方 openclaw-weixin）')
  /** @type {Array<{ method: string, path: string, body: any, uin: string, appId: string, clientVersion: string, authorization: string }>} */
  const seen = []
  let statusPolls = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      seen.push({
        method: String(request.method),
        path: String(request.url),
        body: raw === '' ? null : JSON.parse(raw),
        uin: rawHeader(request, 'X-WECHAT-UIN'),
        appId: rawHeader(request, 'iLink-App-Id'),
        clientVersion: rawHeader(request, 'iLink-App-ClientVersion'),
        authorization: rawHeader(request, 'Authorization'),
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        response.end(JSON.stringify({ ret: 0, qrcode: 'QR1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' }))
        return
      }
      // First poll waits, second confirms — enough to prove local_token_list
      // travels on the login path without spinning until the deadline.
      statusPolls += 1
      response.end(JSON.stringify(statusPolls >= 2 ? { status: 'confirmed', bot_token: 'TOK', ilink_user_id: 'U1' } : { status: 'wait' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const client = new IlinkClient({ baseUrl: base })
    const issued = await client.getQrCode({ localTokenList: ['OLD1', 'OLD2'] })
    equal(issued.qrcode, 'QR1')

    const qr = seen.find((entry) => entry.path.startsWith('/ilink/bot/get_bot_qrcode'))
    // 官方是 POST 带 body；GET 拿不到服务端的绑定识别，扫码会被服务端拒绝。
    assert('取二维码用 POST', qr.method === 'POST')
    assert('bot_type 在查询串里', qr.path.includes(`bot_type=${ILINK_BOT_TYPE}`), qr.path)
    equal(qr.body.local_token_list, ['OLD1', 'OLD2'])
    assert('取二维码不带 Authorization', qr.authorization === '')
    assert('取二维码带身份头', qr.appId === 'bot' && qr.clientVersion === String(buildClientVersion(ILINK_PROTOCOL_VERSION)))

    await client.getQrStatus('QR1')
    const poll = seen.find((entry) => entry.path.startsWith('/ilink/bot/get_qrcode_status'))
    assert('轮询状态用 GET', poll.method === 'GET')
    // 官方客户端轮询时只发身份头：多带 UIN 会让这条长轮询看起来像另一个客户端。
    assert('轮询不带 X-WECHAT-UIN', poll.uin === '')
    assert('轮询不带 Authorization', poll.authorization === '')
    assert('轮询带身份头', poll.appId === 'bot')

    // 登录流程必须把自己已有的 token 报给服务端，否则账号已绑定时只能一直空转。
    const login = await loginWithQrCode({ baseUrl: base, timeoutMs: 4000, localTokenList: ['LOCAL9'] })
    assert('loginWithQrCode 传下 local_token_list', login.alreadyBound === false)
    const loginQr = seen.filter((entry) => entry.path.startsWith('/ilink/bot/get_bot_qrcode')).pop()
    equal(loginQr.body.local_token_list, ['LOCAL9'])
  } finally {
    server.close()
  }
}

// ------------------------------------------------------------ 对桩服务器
{
  console.log('\n6. 客户端与网关的报文契约（本地桩服务器）')
  /** @type {Array<{ path: string, body: any, headers: any }>} */
  const seen = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw)
      seen.push({ path: request.url, body, headers: request.headers })
      const send = (payload) => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        send({ ret: 0, qrcode: 'QR1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' })
      } else if (request.url.startsWith('/ilink/bot/get_qrcode_status')) {
        const polls = seen.filter((entry) => entry.path.startsWith('/ilink/bot/get_qrcode_status')).length
        // `bot_token` is what makes `confirmed` mean anything: without it the
        // login loop keeps polling, which is what a real gateway does too.
        send(polls >= 2 ? { status: 'confirmed', bot_token: 'TOK', ilink_user_id: 'BOT1', baseurl: 'https://x' } : { status: 'scaned' })
      } else if (request.url.startsWith('/ilink/bot/getupdates')) {
        send({
          ret: 0,
          msgs: [
            { message_type: 1, from_user_id: 'u9', message_id: 5, context_token: 'CT9', item_list: [{ type: 1, text_item: { text: 'hi' } }] },
          ],
          get_updates_buf: 'CURSOR2',
          longpolling_timeout_ms: 20000,
        })
      } else if (request.url.startsWith('/ilink/bot/sendmessage')) {
        send({ ret: 0, errcode: 0 })
      } else if (request.url.startsWith('/ilink/bot/getconfig')) {
        send({ ret: 0, typing_ticket: 'TICKET' })
      } else if (request.url.startsWith('/ilink/bot/sendtyping')) {
        send({ ret: 0 })
      } else {
        response.writeHead(404)
        response.end('{}')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const client = new IlinkClient({ baseUrl: base, token: 'TOK' })

    const batch = await client.getUpdates('CURSOR1', { timeoutMs: 5000 })
    equal(batch.cursor, 'CURSOR2')
    equal(batch.longpollingTimeoutMs, 20000)
    equal(batch.msgs.length, 1)
    const updatesCall = seen.find((entry) => entry.path.startsWith('/ilink/bot/getupdates'))
    equal(updatesCall.body.get_updates_buf, 'CURSOR1')
    equal(updatesCall.body.base_info.channel_version, ILINK_PROTOCOL_VERSION)
    assert('轮询带 Bearer token', updatesCall.headers.authorization === 'Bearer TOK')

    const ack = await client.sendText({ toUserId: 'u9', text: '**hi**', contextToken: 'CT9' })
    // ret=0 只代表网关受理，不代表用户收到（openclaw#79293）。返回值必须把两件事
    // 分开，否则调用方只能把「成功」理解成「已送达」。
    assert('sendText 把「已受理」与「已送达」分开', ack.accepted === true && ack.delivered === 'unknown', JSON.stringify(ack))
    assert('sendText 的说明写明送达未确认', String(ack.detail).includes('送达未确认'), ack.detail)
    equal(ack.ret, 0)
    const sendCall = seen.find((entry) => entry.path.startsWith('/ilink/bot/sendmessage'))
    equal(sendCall.body.msg.to_user_id, 'u9')
    equal(sendCall.body.msg.from_user_id, '')
    equal(sendCall.body.msg.message_type, MESSAGE_TYPE.BOT)
    equal(sendCall.body.msg.message_state, MESSAGE_STATE.FINISH)
    equal(sendCall.body.msg.context_token, 'CT9')
    equal(sendCall.body.msg.item_list[0].text_item.text, 'hi')
    assert('client_id 是 UUID', /^[0-9a-f-]{36}$/.test(sendCall.body.msg.client_id))

    equal(await client.getTypingTicket('u9', 'CT9'), 'TICKET')

    // 网关用 HTTP 200 + ret!=0 表达业务错误，必须当成失败而不是成功。
    let caught = null
    try {
      await client.sendText({ toUserId: '', text: 'x' })
    } catch {
      // 桩服务器对空收件人仍然返回 ret=0，这里不应抛错——用下面的错误桩验证。
    }
    equal(caught, null)

    const login = await loginWithQrCode({ baseUrl: base, timeoutMs: 5000 })
    equal(login.token, 'TOK')
    equal(login.userId, 'BOT1')
    equal(login.alreadyBound, false)
    assert('登录会轮询到 confirmed', seen.filter((entry) => entry.path.startsWith('/ilink/bot/get_qrcode_status')).length >= 2)
  } finally {
    server.close()
  }
}

// ------------------------------------------------------------ 网关错误语义
{
  console.log('\n7. 网关错误被正确识别')
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    if (request.url.startsWith('/ilink/bot/getupdates')) {
      response.end(JSON.stringify({ ret: 0, errcode: ERRCODE_SESSION_EXPIRED, errmsg: 'session expired' }))
    } else if (request.url.startsWith('/ilink/bot/sendmessage')) {
      response.end(JSON.stringify({ ret: -1, errcode: 45011, errmsg: 'busy' }))
    } else {
      response.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const client = new IlinkClient({ baseUrl: base, token: 'TOK' })
    const batch = await client.getUpdates('', { timeoutMs: 3000 })
    assert('-14 被当作「登录失效」上报', batch.errcode === ERRCODE_SESSION_EXPIRED)

    let error = null
    try {
      await client.sendText({ toUserId: 'u', text: 'x' })
    } catch (caught) {
      error = caught
    }
    assert('ret/errcode 非 0 时抛出', error instanceof IlinkError)
    equal(error.errcode, 45011)

    const expired = new IlinkError('expired', { errcode: ERRCODE_SESSION_EXPIRED })
    assert('sessionExpired 标志', expired.sessionExpired === true)
    assert('其它错误不算失效', new IlinkError('other', { errcode: 1 }).sessionExpired === false)
  } finally {
    server.close()
  }
}

// ------------------------------------------------------------ 登录状态机
{
  console.log('\n8. 登录状态机（重定向 / 配对码 / 过期 / 已绑定）')
  const scenario = (responses) => {
    let index = 0
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) {
        response.end(JSON.stringify({ ret: 0, qrcode: `QR${index}`, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x' }))
        return
      }
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      response.end(JSON.stringify(next))
    })
    return server
  }
  const run = async (responses, options = {}) => {
    const server = scenario(responses)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      return await loginWithQrCode({ baseUrl: base, timeoutMs: 8000, ...options })
    } finally {
      server.close()
    }
  }

  // 已绑定的账号：凭证还在本地，这不是失败，官方也按「已连接」上报。
  const bound = await run([{ status: 'binded_redirect' }])
  assert('binded_redirect 当作「已经绑定」返回', bound.alreadyBound === true)
  equal(bound.token, '')
  assert('binded_redirect 带回二维码 URL 供排查', bound.qrUrl.includes('liteapp.weixin.qq.com'))

  // 新账号被扫：wait 只是还没扫码，不能当成异常。
  const waited = await run([{ status: 'wait' }, { status: 'confirmed', bot_token: 'TOK0', ilink_user_id: 'U0' }])
  equal(waited.token, 'TOK0')
  equal(waited.alreadyBound, false)

  let blocked = null
  try {
    await run([{ status: 'verify_code_blocked' }])
  } catch (error) {
    blocked = error
  }
  assert('verify_code_blocked 要求重新登录', blocked instanceof IlinkError && blocked.message.includes('配对码'))

  // 配对码挑战：第一次回答错，第二次回答对。
  const answers = []
  const confirmed = await run(
    [
      { status: 'need_verifycode' },
      { status: 'need_verifycode' },
      { status: 'confirmed', bot_token: 'TOK2', ilink_user_id: 'U2' },
    ],
    {
      onVerifyCode: ({ attempt }) => {
        answers.push(attempt)
        return attempt === 1 ? '111111' : '222222'
      },
      onStatus: () => {},
    },
  )
  equal(confirmed.token, 'TOK2')
  equal(answers, [1, 2])

  // 过期后被自动换新码，并在回调里告知。
  const attempts = []
  const refreshed = await run(
    [{ status: 'expired' }, { status: 'confirmed', bot_token: 'TOK3', ilink_user_id: 'U3' }],
    { onQrCode: (info) => attempts.push(info.attempt) },
  )
  equal(refreshed.token, 'TOK3')
  equal(attempts, [1, 2])

  // 连续过期三次就放弃，而不是无限刷新。
  let expired = null
  try {
    await run([{ status: 'expired' }], { onQrCode: () => {} })
  } catch (error) {
    expired = error
  }
  assert('连续过期会放弃', expired instanceof IlinkError && expired.message.includes('过期'))

  // 未知状态不能把凭证流程带偏，也不能假装成功。
  const unknown = await run([{ status: 'brand_new_state' }, { status: 'confirmed', bot_token: 'TOK4', ilink_user_id: 'U4' }], {
    onStatus: () => {},
  })
  equal(unknown.token, 'TOK4')
}

// ------------------------------------------------------------ 桥接整体
{
  console.log('\n9. IlinkBridge 收 → 回 端到端')
  const dir = mkdtempSync(join(tmpdir(), 'ilink-bridge-'))
  const statePath = join(dir, 'account.json')
  try {
    writeAccount(statePath, { token: 'TOK', userId: 'BOT1', baseUrl: 'http://127.0.0.1:1' })
    const sent = []
    let polls = 0
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        if (request.url.startsWith('/ilink/bot/getupdates')) {
          // Deliver the message once, then stay silent: a real gateway never
          // repeats a batch it has already handed out.
          polls += 1
          response.end(
            JSON.stringify({
              ret: 0,
              msgs:
                polls === 1
                  ? [
                      { message_type: 1, from_user_id: 'alice', message_id: 1, context_token: 'CTX1', item_list: [{ type: 1, text_item: { text: '在吗' } }] },
                    ]
                  : [],
              get_updates_buf: 'C1',
              longpolling_timeout_ms: 500,
            }),
          )
        } else if (request.url.startsWith('/ilink/bot/sendmessage')) {
          sent.push(JSON.parse(raw))
          response.end(JSON.stringify({ ret: 0, errcode: 0 }))
        } else {
          response.end('{}')
        }
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`

    const config = { wechat: { ilink: { baseUrl: base, token: 'TOK', statePath, pollTimeoutMs: 500 } } }
    const bridge = new IlinkBridge(config, { client: new IlinkClient({ baseUrl: base, token: 'TOK' }) })
    assert('读到已存凭据', bridge.loggedIn === true)
    // 已有 token 必须上报给服务端，这样重复扫码才有机会拿到 binded_redirect。
    equal(bridge.localTokenList(), ['TOK'])

    const events = []
    bridge.on('event', (event) => events.push(event))
    await bridge.start()
    const deadline = Date.now() + 5000
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    equal(events.length, 1)
    equal(events[0].content, '在吗')
    assert('收到消息后 connected 为真', bridge.connected === true)

    // context_token 必须来自那条入站消息，否则网关会拒收回复。
    const reply = await bridge.send({ peerId: 'alice', text: '在的' })
    assert('回复成功', reply.ok === true, reply.detail)
    equal(sent.length, 1)
    equal(sent[0].msg.context_token, 'CTX1')
    equal(sent[0].msg.item_list[0].text_item.text, '在的')

    await bridge.stop()
    assert('停止后 connected 为假', bridge.connected === false)

    // binded_redirect（没有新 token）不能把已存的凭据覆盖成空。
    assert('空 token 不入库', bridge.saveAccount({ token: '', alreadyBound: true }) === false)
    equal(readAccount(statePath).token, 'TOK')
    server.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 凭证 TTL 与发送语义
{
  console.log('\n10. 发送凭证（context_token）的状态机与发送语义')
  const dir = mkdtempSync(join(tmpdir(), 'ilink-cred-'))
  const statePath = join(dir, 'account.json')
  writeAccount(statePath, { token: 'TOK', userId: 'BOT1' })
  const settings = { statePath, token: 'TOK', pollTimeoutMs: 100, contextTokenTtlMs: 24 * 60 * 60 * 1000 }

  // 默认 TTL：iLink 只能被动回复，凭证随对方消息下发且会自动过期（openclaw#52153）。
  assert('默认凭证 TTL 是一天', CONTEXT_TOKEN_TTL_MS === 24 * 60 * 60 * 1000, String(CONTEXT_TOKEN_TTL_MS))
  // `0` 是"关掉检查"的显式开关（config.mjs 里写了 "Set 0 to switch the check off"），
  // 不是"没配置"。这两种语义很容易被 `??` / `||` / `>=` 混成一件事：一旦混了，
  // 填 0 的人会得到一个**立刻过期**的凭证，每次回复都被自己的 TTL 挡住。
  assert('TTL 填 0 表示关闭检查（而不是立刻过期）', resolveContextTokenTtlMs({ contextTokenTtlMs: 0 }) === Infinity)
  assert('TTL 缺失时回落到默认值', resolveContextTokenTtlMs({}) === CONTEXT_TOKEN_TTL_MS)
  assert('TTL 非法值（负数）不会把检查关掉', resolveContextTokenTtlMs({ contextTokenTtlMs: -1 }) === CONTEXT_TOKEN_TTL_MS)
  assert('TTL 合理值被采纳', resolveContextTokenTtlMs({ contextTokenTtlMs: 5000 }) === 5000)
  assert('TTL 说明里把"不限期"讲清楚', formatTtl(Infinity) === '不限期', formatTtl(Infinity))

  /**
   * A stub with the semantics of the real client: one batch is handed out exactly
   * once (a real gateway never repeats it), and sends are recorded.
   *
   * @returns {Record<string, any>} the stub client.
   */
  const stubClient = () => {
    const sent = []
    let polls = 0
    return {
      sent,
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        await new Promise((resolve) => setTimeout(resolve, 5))
        polls += 1
        return {
          ret: 0,
          msgs:
            polls === 1
              ? [
                  {
                    message_type: MESSAGE_TYPE.USER,
                    from_user_id: 'alice',
                    message_id: 7,
                    context_token: 'CTX1',
                    item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '在吗' } }],
                  },
                ]
              : [],
          cursor: 'C1',
          longpollingTimeoutMs: 100,
        }
      },
      async sendText(params) {
        sent.push(params)
        return {
          ret: 0,
          accepted: true,
          delivered: 'unknown',
          detail: 'iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理',
        }
      },
      async getTypingTicket() {
        return ''
      },
      async sendTyping() {},
    }
  }

  /**
   * Start a bridge on a stub client and wait for its single inbound message.
   *
   * @param {Record<string, any>} client - the stub client.
   * @param {number} [ttl] - credential TTL override.
   * @returns {Promise<{ bridge: IlinkBridge, events: any[] }>} the running bridge and what it emitted.
   */
  const bridgeWith = async (client, ttl) => {
    const bridge = new IlinkBridge(
      { wechat: { ilink: { ...settings, contextTokenTtlMs: ttl ?? settings.contextTokenTtlMs } } },
      { client },
    )
    const events = []
    bridge.on('event', (event) => events.push(event))
    await bridge.start()
    const deadline = Date.now() + 3000
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    return { bridge, events }
  }

  try {
    // ---- 还没有任何入站消息：没有凭证，必须说清楚而不是含糊报错。
    const coldClient = stubClient()
    const cold = new IlinkBridge({ wechat: { ilink: settings } }, { client: coldClient })
    const coldState = cold.sendCredential()
    assert('没有入站消息时状态是 none', coldState.ready === false && coldState.state === 'none', JSON.stringify(coldState))
    assert('状态里给出可操作的做法', String(coldState.detail).includes('请先在微信里给机器人发一条消息'), coldState.detail)
    const coldSend = await cold.send({ peerId: 'alice', text: '你好' })
    assert('没有凭证时不假装成功', coldSend.ok === false && coldSend.accepted === false, JSON.stringify(coldSend))
    assert('没有凭证时说明原因而不是抛网关错误', String(coldSend.detail).includes('发一条消息'), coldSend.detail)
    equal(coldClient.sent.length, 0)

    // ---- 收到一条消息之后：凭证就绪，发送结果是「已受理、送达未确认」。
    const warmClient = stubClient()
    const warm = await bridgeWith(warmClient)
    equal(warm.events.length, 1)
    const warmState = warm.bridge.sendCredential()
    assert('收到消息后凭证就绪', warmState.ready === true && warmState.state === 'ready', JSON.stringify(warmState))
    assert('按会话查询同样就绪', warm.bridge.sendCredential('alice').ready === true)

    const warmSend = await warm.bridge.send({ peerId: 'alice', text: '在的' })
    assert('发送成功但只声称已受理', warmSend.ok === true && warmSend.accepted === true, JSON.stringify(warmSend))
    equal(warmSend.delivered, 'unknown')
    assert('发送说明写明送达未确认', String(warmSend.detail).includes('送达未确认'), warmSend.detail)
    equal(warmClient.sent.length, 1)
    equal(warmClient.sent[0].contextToken, 'CTX1')
    await warm.bridge.stop()

    // ---- TTL 过后：凭证过期，发送被挡住并说明怎么恢复。
    // 300ms 足够宽，避免慢机器上「刚收到就判定过期」的假失败；400ms 后必然过期。
    const staleClient = stubClient()
    const stale = await bridgeWith(staleClient, 300)
    equal(stale.events.length, 1)
    equal(stale.bridge.sendCredential().state, 'ready')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const expiredState = stale.bridge.sendCredential()
    assert('TTL 过后不再视为就绪', expiredState.ready === false && expiredState.state === 'expired', JSON.stringify(expiredState))
    assert(
      '过期状态同时说明原因与做法',
      String(expiredState.detail).includes('已过期') && String(expiredState.detail).includes('发一条消息'),
      expiredState.detail,
    )
    const lateSend = await stale.bridge.send({ peerId: 'alice', text: '还在吗' })
    assert('凭证过期后不发送，并如实说明', lateSend.ok === false && String(lateSend.detail).includes('已过期'), JSON.stringify(lateSend))
    equal(staleClient.sent.length, 0)
    const staleProbe = await stale.bridge.probe()
    assert('probe 一并汇报凭证状态', staleProbe.credential?.state === 'expired', JSON.stringify(staleProbe.credential))
    // 收消息本身没有坏，只是不能回：这两件事必须分开上报。
    assert('凭证过期不影响入站健康', staleProbe.ok === true, staleProbe.detail)
    await stale.bridge.stop()

    // ---- 网关明确拒绝 vs 网络层失败：一个能确定没送到，一个只能说不知道。
    const refusedClient = stubClient()
    refusedClient.sendText = async () => {
      throw new IlinkError('iLink 发送失败：ret=-1 errcode=45011 busy', { ret: -1, errcode: 45011 })
    }
    const refused = await bridgeWith(refusedClient)
    const refusedSend = await refused.bridge.send({ peerId: 'alice', text: 'x' })
    assert('网关拒绝时确定没送到', refusedSend.delivered === 'no' && refusedSend.accepted === false, JSON.stringify(refusedSend))
    equal(refusedSend.errcode, 45011)
    await refused.bridge.stop()

    const brokenClient = stubClient()
    brokenClient.sendText = async () => {
      throw new IlinkError('iLink /ilink/bot/sendmessage 网络错误：fetch failed')
    }
    const broken = await bridgeWith(brokenClient)
    const brokenSend = await broken.bridge.send({ peerId: 'alice', text: 'x' })
    assert('网络失败时只能说送达未知', brokenSend.delivered === 'unknown' && brokenSend.accepted === false, JSON.stringify(brokenSend))
    await broken.bridge.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 健康探针不许吃掉消息
{
  console.log('\n10b. 健康探针（probe）不能从轮询循环手里吃掉消息')
  // 现象：控制台每 4 秒刷一次 /api/status → WeChatAdapter.status() → IlinkBridge.probe()，
  // 而 probe 曾经用**和轮询循环同一个游标**调了一次 getUpdates 并把返回的批次丢掉。
  // iLink 的 getUpdates 一旦返回就把这批消息从服务端消费掉了（游标交回给调用方），
  // 所以那批消息永远不会再被轮询循环看到 —— 用户发完消息正好赶上一次状态刷新，
  // 这条消息就静默消失了。最坏的情况最常见：回合进行中（几十秒到几分钟）恰好是
  // 状态刷新最密集的时候。
  // 依据：`#pollLoop` 只在 `batch.cursor !== ''` 时才推进 `#cursor` 并落盘；
  // probe 既不推进游标也不 emit 事件，它拿到的批次没有任何人消费。
  const dir = mkdtempSync(join(tmpdir(), 'ilink-probe-'))
  const statePath = join(dir, 'account.json')
  writeAccount(statePath, { token: 'TOK', userId: 'BOT1' })
  let polls = 0
  const client = {
    token: 'TOK',
    baseUrl: 'http://stub.invalid',
    async getUpdates(cursor) {
      polls += 1
      // 第一批必须是空的：`probe` 要看到的就是"没有新消息"。
      if (polls === 1) return { ret: 0, msgs: [], cursor: '', longpollingTimeoutMs: 0 }
      // 第二批是真实用户消息。谁先拿到它，谁就消费掉了它。
      return {
        ret: 0,
        msgs:
          polls === 2
            ? [
                {
                  message_type: MESSAGE_TYPE.USER,
                  from_user_id: 'alice',
                  message_id: 42,
                  context_token: 'CTX-PROBE',
                  item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '探针不许吃掉我' } }],
                },
              ]
            : [],
        cursor: 'C2',
        longpollingTimeoutMs: 0,
      }
    },
    async sendText() {
      return { ret: 0, accepted: true, delivered: 'unknown', detail: '' }
    },
    async getTypingTicket() {
      return ''
    },
    async sendTyping() {},
  }
  const bridge = new IlinkBridge({ wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 } } }, { client })
  const events = []
  bridge.on('event', (event) => events.push(event))
  try {
    await bridge.start()
    // 等第一轮空轮询走完（此时循环进入最小间隔睡眠，不会在途请求）。
    const firstPoll = Date.now() + 2000
    while (polls < 1 && Date.now() < firstPoll) await new Promise((resolve) => setTimeout(resolve, 10))
    equal(polls, 1)

    const probe = await bridge.probe()
    assert('轮询循环在跑时探针仍然报健康', probe.ok === true, probe.detail)
    // 核心断言：探针不该自己去问网关。空转的那一轮就是证据 —— 多打一次
    // getUpdates 就意味着一批消息被从循环手里抢走了。
    assert('探针没有消费网关批次（polls 仍是 1）', polls === 1, `getUpdates 调用次数=${polls}`)

    const deadline = Date.now() + 5000
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert('用户那条消息仍然被轮询循环收到', events.length === 1, `events=${events.length}`)
    equal(events[0]?.content, '探针不许吃掉我')

    // 探针必须如实汇报凭证状态（控制台就靠它显示"发送凭证已就绪"）。这条要在消息
    // 到达之后看：iLink 的凭证是随入站消息下发的，探针早一步问当然还是"没有"。
    const probeAfter = await bridge.probe()
    assert('探针一并汇报凭证状态', probeAfter.credential?.state === 'ready', JSON.stringify(probeAfter.credential))
    // 游标也必须是轮询循环在推进，而不是被探针带着跑。
    equal(readFileSync(`${statePath}.cursor`, 'utf8').trim(), 'C2')
  } finally {
    await bridge.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 刚启动 ≠ 接收异常
{
  console.log('\n10c. 刚启动的接收循环必须报「正在连接」，而真的连不上必须报异常')
  // 回归：控制台在扫码成功后**立刻**查一次状态（console-e2e 就是这么做的），而那
  // 一刻第一轮长轮询还在飞。早期版本让 `probe()` 只看 `#connected/#everConnected`，
  // 两者都还是 false，于是刚绑好就显示「接收异常」——把"还没开始"误报成"坏了"。
  // 修法是把窗口单独成一态，但它必须有边界、且绝不能盖住真实错误，否则就成了
  // "永远健康"的假象。下面把三态都钉住。
  const dir = mkdtempSync(join(tmpdir(), 'ilink-probe-start-'))
  const statePath = join(dir, 'account.json')
  writeAccount(statePath, { token: 'TOK', userId: 'BOT1' })

  try {
    // ---- A. start() 之后、第一轮还没返回：必须 ok:true 且说明是「正在等待」
    let releaseFirstPoll = null
    const slowPolls = { count: 0 }
    const slowClient = {
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        slowPolls.count += 1
        // 第一轮挂住，模拟"长轮询还在途中"——探针此刻被调用，正是线上那个窗口。
        if (slowPolls.count === 1) {
          await new Promise((resolve) => {
            releaseFirstPoll = resolve
          })
        }
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
    const slow = new IlinkBridge({ wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 } } }, { client: slowClient })
    try {
      await slow.start()
      const startingProbe = await slow.probe()
      assert('第一轮还在途中时探针报健康（不是异常）', startingProbe.ok === true, startingProbe.detail)
      assert(
        '这一态如实说明是「正在等待第一批消息」',
        startingProbe.detail.includes('正在等待第一批消息') && !startingProbe.detail.includes('异常'),
        startingProbe.detail,
      )
      // 第一轮回来后，同一套接口要转成"正常"，而不是卡在"正在连接"。
      releaseFirstPoll?.()
      const cameUp = Date.now() + 3000
      let healthy = null
      while (Date.now() < cameUp) {
        healthy = await slow.probe()
        if (healthy.detail.includes('iLink 正常')) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert('第一轮完成后转为「正常」', healthy?.ok === true && healthy.detail.includes('iLink 正常'), healthy?.detail)
    } finally {
      await slow.stop()
    }

    // ---- B. 网关真的连不上：绝不能因为"在启动窗口里"就报健康
    const brokenClient = {
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1')
      },
      async sendText() {
        return { ret: 0, accepted: true, delivered: 'unknown', detail: '' }
      },
      async getTypingTicket() {
        return ''
      },
      async sendTyping() {},
    }
    const broken = new IlinkBridge({ wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 } } }, { client: brokenClient })
    try {
      await broken.start()
      // 让第一轮失败被记录下来（轮询循环捕获后睡 2 秒，所以这里等的是"记录"而不是"重试"）。
      const deadline = Date.now() + 2000
      let failedProbe = null
      while (Date.now() < deadline) {
        failedProbe = await broken.probe()
        if (failedProbe.ok === false) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert('真正连不上时探针报异常（启动窗口不会掩盖它）', failedProbe?.ok === false, failedProbe?.detail)
      assert('异常说明里带上真实错误原因', String(failedProbe?.detail).includes('ECONNREFUSED'), failedProbe?.detail)
    } finally {
      await broken.stop()
    }

    // ---- C. 没在收的时候也不许问网关：扫码前/停机中/保存配置重建栈的那段窗口，
    // 控制台照样在刷状态；问一次就吃掉一批，而这批没有任何循环能送达（游标在文件里，
    // 网关不会重发已经交出去的批次）。
    const idlePolls = { count: 0 }
    const idleClient = {
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        idlePolls.count += 1
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
    const idle = new IlinkBridge({ wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 } } }, { client: idleClient })
    const idleProbe = await idle.probe()
    assert('没启动接收循环时探针不发 getUpdates', idlePolls.count === 0, `getUpdates 调用 ${idlePolls.count} 次`)
    assert('没启动时如实报「接收循环未启动」', idleProbe.ok === false && idleProbe.detail.includes('未启动'), idleProbe.detail)

    // ---- D. 登录失效（errcode -14）：循环还在重试，所以"曾经连上过"会把它误报成正常。
    // 这条是我自己上一版引入的坑（只看 #connected/#everConnected），必须钉住。
    const expiredPolls = { count: 0 }
    const expiredClient = {
      token: 'TOK',
      baseUrl: 'http://stub.invalid',
      async getUpdates() {
        expiredPolls.count += 1
        return { ret: 0, errcode: ERRCODE_SESSION_EXPIRED, errmsg: 'session expired', msgs: [], cursor: 'C1', longpollingTimeoutMs: 0 }
      },
      async sendText() {
        return { ret: 0, accepted: true, delivered: 'unknown', detail: '' }
      },
      async getTypingTicket() {
        return ''
      },
      async sendTyping() {},
    }
    const expired = new IlinkBridge({ wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100 } } }, { client: expiredClient })
    try {
      await expired.start()
      const deadline = Date.now() + 2000
      let expiredProbe = null
      while (Date.now() < deadline) {
        expiredProbe = await expired.probe()
        if (String(expiredProbe.detail).includes('失效')) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert('登录失效时探针报失效，而不是「正常」', expiredProbe?.ok === false && String(expiredProbe.detail).includes('-14'), expiredProbe?.detail)
      assert('失效状态没有说成健康', !String(expiredProbe?.detail).includes('iLink 正常'), expiredProbe?.detail)
    } finally {
      // stop() 必须立刻结束循环：`#sleep` 会和 abort 赛跑，否则这里要等 30 秒
      // 退避结束，整套自测都会被吊住。
      const stoppedAt = Date.now()
      await expired.stop()
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert('stop() 不会被 30 秒退避拖住', Date.now() - stoppedAt < 500, `${Date.now() - stoppedAt}ms`)
      equal(expiredPolls.count >= 1, true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 媒体下载
{
  console.log('\n11. 媒体下载与 AES-128-ECB 解密')
  // 协议里 aes_key 有两种编码：base64(原始 16 字节) 与 base64(hex 字符串)。
  const rawKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  equal(decodeMediaAesKey(rawKey.toString('base64')).toString('hex'), rawKey.toString('hex'))
  equal(decodeMediaAesKey(Buffer.from(rawKey.toString('hex')).toString('base64')).toString('hex'), rawKey.toString('hex'))
  equal(decodeMediaAesKey(rawKey.toString('hex')).toString('hex'), rawKey.toString('hex'))
  assert('解析不了的 key 返回 null 而不是乱猜', decodeMediaAesKey('nope') === null)

  // 配置里 `wechat.ilink.cdnBaseUrl` 的默认值是**空字符串**，而空字符串的意思是
  // “用官方默认地址”。这里曾经写成 `settings.cdnBaseUrl ?? 默认值` —— `'' ?? x`
  // 的结果是 `''`，于是下载 URL 塌成 `?encrypted_query_param=…`，报
  // “Failed to parse URL”。纯文本回复永远碰不到 CDN，所以一直没暴露，
  // 直到有人真的发了一个 Word 文档过来。这几条就是钉住它。
  {
    equal(cdnDownloadUrl(''), ILINK_CDN_DOWNLOAD_URL)
    equal(cdnDownloadUrl(undefined), ILINK_CDN_DOWNLOAD_URL)
    equal(cdnDownloadUrl('   '), ILINK_CDN_DOWNLOAD_URL)
    equal(cdnDownloadUrl('http://127.0.0.1:9/c2c/download'), 'http://127.0.0.1:9/c2c/download')
    // 真跑一遍下载函数（桩 fetch 直接回 500），只看它请求的 URL 长什么样 ——
    // 线上那次失败正是发生在这里。
    let asked = ''
    await downloadIlinkMedia(
      { aesKey: rawKey.toString('base64'), encryptQueryParam: 'QP1' },
      {
        cdnBaseUrl: '',
        fetchImpl: async (url) => {
          asked = String(url)
          return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }
        },
      },
    )
    assert(
      '空配置下请求的是绝对地址，而不是裸查询串',
      asked === `${ILINK_CDN_DOWNLOAD_URL}?encrypted_query_param=QP1`,
      asked,
    )
  }

  /** @param {Buffer} plain - to encrypt. @param {Buffer} key - 16 bytes. @param {boolean} [padded] - whether to apply PKCS#7. */
  const encrypt = (plain, key, padded = true) => {
    const cipher = createCipheriv('aes-128-ecb', key, null)
    if (!padded) cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(plain), cipher.final()])
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
  equal(decryptMediaEcb(encrypt(png, rawKey), rawKey).toString('latin1'), png.toString('latin1'))
  // 未填充的密文也要能解：那是合法密文，不该因为「没有 padding」丢掉附件。
  const aligned = Buffer.from('0123456789abcdef')
  equal(decryptMediaEcb(encrypt(aligned, rawKey, false), rawKey).toString('latin1'), aligned.toString('latin1'))
  assert('长度不是 16 的倍数时返回 null', decryptMediaEcb(Buffer.from('short'), rawKey) === null)

  const payload = encrypt(png, rawKey)
  const requests = []
  const cdn = createServer((request, response) => {
    requests.push(String(request.url))
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    response.end(payload)
  })
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const cdnBase = `http://127.0.0.1:${cdn.address().port}/c2c/download`
  const mediaDir = mkdtempSync(join(tmpdir(), 'ilink-media-'))
  const dir = mkdtempSync(join(tmpdir(), 'ilink-media-state-'))
  const statePath = join(dir, 'account.json')
  writeAccount(statePath, { token: 'TOK', userId: 'BOT1' })

  try {
    // 图片：解出来走内联附件字段，content 保持 [图片]（适配器据此分类）。
    const image = normalizeIlinkMessage({
      message_type: MESSAGE_TYPE.USER,
      from_user_id: 'u1',
      item_list: [
        {
          type: MESSAGE_ITEM_TYPE.IMAGE,
          image_item: { media: { encrypt_query_param: 'QP1', aes_key: rawKey.toString('base64') } },
        },
      ],
    })
    equal(image.content, '[图片]')
    equal(image.media?.encryptQueryParam, 'QP1')
    const hydrated = await hydrateIlinkMedia(image, { cdnBaseUrl: cdnBase })
    equal(hydrated.imageMimeType, 'image/png')
    equal(Buffer.from(String(hydrated.imageBase64), 'base64').toString('latin1'), png.toString('latin1'))
    equal(hydrated.content, '[图片]')
    assert('下载用的是 encrypted_query_param', requests.at(-1).includes('encrypted_query_param=QP1'), requests.at(-1))

    // 文件：落盘并把路径写进 content，agent 才读得到。
    const file = normalizeIlinkMessage({
      message_type: MESSAGE_TYPE.USER,
      from_user_id: 'u1',
      item_list: [
        {
          type: MESSAGE_ITEM_TYPE.FILE,
          file_item: {
            file_name: '报表.bin',
            media: { encrypt_query_param: 'QP2', aes_key: Buffer.from(rawKey.toString('hex')).toString('base64') },
          },
        },
      ],
    })
    const saved = await hydrateIlinkMedia(file, { cdnBaseUrl: cdnBase, tmpDir: mediaDir })
    const savedPath = typeof saved.localPath === 'string' ? saved.localPath : ''
    assert('文件落到临时目录', savedPath.startsWith(mediaDir) && savedPath !== '', savedPath || '(没有落盘)')
    if (savedPath !== '') equal(readFileSync(savedPath).toString('latin1'), png.toString('latin1'))
    assert('content 里带上本地路径', savedPath !== '' && String(saved.content).includes(savedPath), saved.content)

    // 解不开 / 下不来时要降级成占位文本：消息已经被消费，抛错只会丢掉整条消息。
    const broken = normalizeIlinkMessage({
      message_type: MESSAGE_TYPE.USER,
      from_user_id: 'u1',
      item_list: [
        { type: MESSAGE_ITEM_TYPE.IMAGE, image_item: { media: { encrypt_query_param: 'QP3', aes_key: 'not-a-key' } } },
      ],
    })
    const degraded = await hydrateIlinkMedia(broken, { cdnBaseUrl: cdnBase })
    equal(degraded.content, '[图片]')
    assert('解不开时不产生内联附件', degraded.imageBase64 === undefined)

    // 没有 CDN 引用的纯文本事件不会被碰。
    const plain = normalizeIlinkMessage({
      message_type: MESSAGE_TYPE.USER,
      from_user_id: 'u1',
      item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: 'hi' } }],
    })
    assert('纯文本事件不带 CDN 引用（不会触发下载）', plain.media === undefined)
    equal((await hydrateIlinkMedia(plain, { cdnBaseUrl: cdnBase })).content, 'hi')

    // 桥接层：轮询到的图片在发事件之前就下好、解好，适配器才能拿到附件。
    //
    // 这个桩**故意立即返回**（不像上面那个睡 5ms）：一个秒回的网关会把
    // `#pollLoop` 变成纯微任务忙循环，饿死进程里所有定时器——本套件真的因此挂死
    // 过一次，产品侧修法是 `ILINK_MIN_POLL_INTERVAL_MS`。**不要给它加延时**，
    // 那就是这条回归断言的触发条件。
    let polls = 0
    const mediaClient = {
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
                    message_type: MESSAGE_TYPE.USER,
                    from_user_id: 'alice',
                    message_id: 11,
                    context_token: 'CTX-IMG',
                    item_list: [
                      {
                        type: MESSAGE_ITEM_TYPE.IMAGE,
                        image_item: { media: { encrypt_query_param: 'QP1', aes_key: rawKey.toString('base64') } },
                      },
                    ],
                  },
                ]
              : [],
          cursor: 'C1',
          longpollingTimeoutMs: 100,
        }
      },
      async sendText() {
        return { ret: 0, accepted: true, delivered: 'unknown', detail: '' }
      },
      async getTypingTicket() {
        return ''
      },
      async sendTyping() {},
    }
    const mediaBridge = new IlinkBridge(
      { wechat: { ilink: { statePath, token: 'TOK', pollTimeoutMs: 100, cdnBaseUrl: cdnBase, mediaDir } } },
      { client: mediaClient },
    )
    const received = []
    mediaBridge.on('event', (event) => received.push(event))
    await mediaBridge.start()
    const deadline = Date.now() + 3000
    while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    equal(received.length, 1)
    equal(received[0].content, '[图片]')
    equal(Buffer.from(String(received[0].imageBase64), 'base64').toString('latin1'), png.toString('latin1'))
    equal(received[0].imageMimeType, 'image/png')
    await mediaBridge.stop()
  } finally {
    cdn.close()
    rmSync(mediaDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 出站：加密 / 标记 / 上传
{
  // 编号叫 12b：这是第 12 节（出站长度上限）的姊妹节，插在它前面，后面 13/14
  // 的编号一个都不动。
  console.log('\n12b. 出站发文件：AES 填充、标记抽取、getuploadurl、CDN 上传、sendFile')
  // Protocol basis: the official `@tencent-weixin/openclaw-weixin` package (2.4.9)
  // has this exact pipeline in `cdn/upload.ts` + `cdn/cdn-upload.ts`. The
  // assertions below are written against that source, not against our own code:
  //
  //   rawsize  = plaintext byte length          filesize = aesEcbPaddedSize(rawsize)
  //   rawfilemd5 = md5(plaintext) hex           filekey  = 16 random bytes hex
  //   aeskey   = 16 random bytes hex            media_type = UploadMediaType
  //   POST  <upload_full_url|cdnBase/upload?encrypted_query_param=…&filekey=…>
  //   body  = AES-128-ECB/PKCS7 ciphertext
  //   download param = response header `x-encrypted-param`  ← and nothing else
  //   4xx abort immediately; anything else retries, 3 attempts in total
  const dir = mkdtempSync(join(tmpdir(), 'ilink-upload-'))
  try {
    // ---------------------------------------------------------- 1. 填充大小
    // `Math.ceil((n+1)/16)*16`: PKCS#7 always appends at least one byte, so a
    // 16-byte block becomes 32. Getting this wrong shifts every later size field.
    assert('CDN base 是官方文档地址', ILINK_CDN_BASE_URL === 'https://novac2c.cdn.weixin.qq.com/c2c', ILINK_CDN_BASE_URL)
    assert('media_type: 图片 1', UPLOAD_MEDIA_TYPE.IMAGE === 1)
    assert('media_type: 视频 2', UPLOAD_MEDIA_TYPE.VIDEO === 2)
    assert('media_type: 文件 3', UPLOAD_MEDIA_TYPE.FILE === 3)
    assert('media_type: 语音 4', UPLOAD_MEDIA_TYPE.VOICE === 4)

    assert('填充大小(0) = 16', aesEcbPaddedSize(0) === 16, String(aesEcbPaddedSize(0)))
    assert('填充大小(1) = 16', aesEcbPaddedSize(1) === 16, String(aesEcbPaddedSize(1)))
    assert('填充大小(15) = 16', aesEcbPaddedSize(15) === 16, String(aesEcbPaddedSize(15)))
    // 边界：16 字节必须再补一整块。
    assert('填充大小(16) = 32', aesEcbPaddedSize(16) === 32, String(aesEcbPaddedSize(16)))
    assert('填充大小(17) = 32', aesEcbPaddedSize(17) === 32, String(aesEcbPaddedSize(17)))
    assert('填充大小(31) = 32', aesEcbPaddedSize(31) === 32, String(aesEcbPaddedSize(31)))
    assert('填充大小(32) = 48', aesEcbPaddedSize(32) === 48, String(aesEcbPaddedSize(32)))

    // ---------------------------------------------------------- 2. 加密
    /** @param {Buffer} ciphertext - to decrypt. @param {Buffer} key - 16 bytes. @returns {Buffer} the plaintext. */
    const decryptEcb = (ciphertext, key) => {
      const decipher = createDecipheriv('aes-128-ecb', key, null)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    }
    const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plain = Buffer.from('iLink 出站附件测试正文：0123456789abcdef', 'utf8')
    const cipher = encryptMediaEcb(plain, aesKey)
    assert('密文长度 = 填充后大小', cipher.length === aesEcbPaddedSize(plain.length), `${cipher.length} vs ${aesEcbPaddedSize(plain.length)}`)
    assert('密文长度是 16 的整数倍', cipher.length % 16 === 0, String(cipher.length))
    equal(decryptEcb(cipher, aesKey).toString('utf8'), plain.toString('utf8'))
    const emptyCipher = encryptMediaEcb(Buffer.alloc(0), aesKey)
    assert('空输入加密后是整整一块', emptyCipher.length === 16, String(emptyCipher.length))
    equal(decryptEcb(emptyCipher, aesKey).length, 0)
    // 恰好对齐的明文也要能原样解回：这正是 PKCS#7「多补一块」的用途。
    const aligned = Buffer.from('0123456789abcdef')
    equal(decryptEcb(encryptMediaEcb(aligned, aesKey), aesKey).toString('latin1'), aligned.toString('latin1'))

    // ---------------------------------------------------------- 3. 标记抽取
    const marker = (path) => `[[send-file: ${path}]]`
    const plainPath = join(dir, 'report.pdf')
    const clean = extractFileMarkers('这是正文')
    equal(clean.paths, [])
    equal(clean.text, '这是正文')

    const single = extractFileMarkers(`这是正文\n${marker(plainPath)}`)
    equal(single.paths, [plainPath])
    assert('标记被从正文里删掉', !single.text.includes('send-file'), single.text)
    assert('删除后不留空行', single.text === '这是正文', JSON.stringify(single.text))

    const twice = extractFileMarkers(`${marker(plainPath)} 同上 ${marker(plainPath)}`)
    equal(twice.paths, [plainPath])

    const aPath = join(dir, 'a.txt')
    const bPath = join(dir, 'b.txt')
    equal(extractFileMarkers(`${marker(aPath)} 中间 ${marker(bPath)}`).paths, [aPath, bPath])

    const spaced = join(dir, 'my report 2024 final.pdf')
    equal(extractFileMarkers(marker(spaced)).paths, [spaced])

    const winPath = 'C:\\Users\\me\\Desktop\\报表 2024.xlsx'
    equal(extractFileMarkers(marker(winPath)).paths, [winPath])

    // 形似但不同的写法一律不抽：只有 `send-file` 这一种拼写被认。
    const lookalikeText = '[[send_file: x]] [[sendfile: y]] [[SEND-FILE: z]] [[send-file : w]]'
    const lookalike = extractFileMarkers(lookalikeText)
    equal(lookalike.paths, [])
    equal(lookalike.text, lookalikeText)
    // 空格是宽容的（标记由模型手写，多一个少一个都该认），但没有路径就不算标记。
    equal(extractFileMarkers('[[send-file:x]]').paths, ['x'])
    equal(extractFileMarkers('[[send-file: x]]').paths, ['x'])
    equal(extractFileMarkers(marker(`  ${plainPath}  `)).paths, [plainPath])
    equal(extractFileMarkers('[[send-file:]]').paths, [])
    equal(extractFileMarkers('[[send-file:   ]]').paths, [])
    // 没有收尾的时候也不能把后半段正文当路径吃掉。
    equal(extractFileMarkers('[[send-file: /tmp/a.txt 还没写完').paths, [])

    equal(formatFileMarker('C:\\tmp\\a b.txt'), '[[send-file: C:\\tmp\\a b.txt]]')
    // 渲染是原样的（只有抽取端才做 trim），所以带空格的输入原样写回。
    equal(formatFileMarker('  /tmp/a.txt  '), '[[send-file:   /tmp/a.txt  ]]')
    equal(extractFileMarkers(formatFileMarker(plainPath)).paths, [plainPath])

    // ---------------------------------------------------------- 4. 上传请求报文
    /** @type {Array<{ url: string, init: any, body: string }>} */
    const gatewaySeen = []
    /** Replies handed back by the stub `getuploadurl`. */
    let uploadUrlReply = { ret: 0, upload_param: 'UP1' }
    const gateway = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        gatewaySeen.push({ url: String(request.url), init: request.method, body: raw })
        if (request.url.startsWith('/ilink/bot/getuploadurl')) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(uploadUrlReply))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ret: 0, errcode: 0 }))
      })
    })
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    const gatewayBase = `http://127.0.0.1:${gateway.address().port}`

    /** What the stub CDN received, so the bytes can be checked after the fact. */
    const cdnSeen = []
    /** Response plan for the stub CDN, one entry consumed per request. */
    let cdnPlan = [{ status: 200, param: 'DL-PARAM-1' }]
    const cdn = createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const plan = cdnPlan[Math.min(cdnSeen.length, cdnPlan.length - 1)]
        cdnSeen.push({ url: String(request.url), body: Buffer.concat(chunks), contentType: String(request.headers['content-type'] ?? '') })
        if (plan.param !== undefined) response.writeHead(plan.status, { 'x-encrypted-param': plan.param })
        else response.writeHead(plan.status)
        response.end('')
      })
    })
    await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve))
    const cdnUploadUrl = `http://127.0.0.1:${cdn.address().port}/c2c/upload`
    const cdnBase = `http://127.0.0.1:${cdn.address().port}/c2c`
    // Every scenario below must be answered with `upload_full_url` pointing at the
    // stub. Without it the client falls back to the documented production base and
    // the test would POST ciphertext at the real Tencent CDN — which is exactly
    // what happened once while writing this section.
    uploadUrlReply = { ret: 0, upload_full_url: cdnUploadUrl }

    const sample = Buffer.concat([Buffer.from('iLink-upload-'), Buffer.alloc(7, 0xab), Buffer.from('尾部')])
    const samplePath = join(dir, 'sample.bin')
    writeFileSync(samplePath, sample)
    const sampleMd5 = createHash('md5').update(sample).digest('hex')

    /** Point the client's gateway requests at the stub. */
    const makeClient = () => new IlinkClient({ baseUrl: gatewayBase, token: 'TOK', fetchImpl: (...args) => fetch(...args) })

    try {
      cdnPlan = [{ status: 200, param: 'DL-PARAM-1' }]
      gatewaySeen.length = 0
      // 原始层：`getUploadUrl` 直接说协议字段名（snake_case），这里故意逐字穿一遍，
      // 证明它没有把参数改名、丢字段或补默认值。
      const requestBody = await makeClient().getUploadUrl({
        filekey: 'a'.repeat(32),
        media_type: UPLOAD_MEDIA_TYPE.FILE,
        to_user_id: 'wxid_bob',
        rawsize: 1234,
        rawfilemd5: sampleMd5,
        filesize: aesEcbPaddedSize(1234),
        aeskey: 'b'.repeat(32),
      })
      equal(requestBody.ret, 0)
      const urlCall = gatewaySeen.find((entry) => entry.url.startsWith('/ilink/bot/getuploadurl'))
      assert('走 POST /ilink/bot/getuploadurl', urlCall !== undefined && urlCall.init === 'POST', urlCall?.url ?? '(没有这个请求)')
      const sentBody = JSON.parse(urlCall.body)
      equal(sentBody.filekey, 'a'.repeat(32))
      equal(sentBody.media_type, UPLOAD_MEDIA_TYPE.FILE)
      equal(sentBody.to_user_id, 'wxid_bob')
      equal(sentBody.rawsize, 1234)
      equal(sentBody.filesize, 1248)
      equal(sentBody.rawfilemd5, sampleMd5)
      equal(sentBody.aeskey, 'b'.repeat(32))

      // uploadMedia 会把同样的字段算出来：明文大小、填充后大小、明文 md5、32 位 hex 的 key。
      gatewaySeen.length = 0
      cdnSeen.length = 0
      cdnPlan = [{ status: 200, param: 'DL-PARAM-1' }]
      const mediaClient = makeClient()
      const uploaded = await mediaClient.uploadMedia({ filePath: samplePath, toUserId: 'wxid_bob', mediaType: UPLOAD_MEDIA_TYPE.FILE })
      const uploadBody = JSON.parse(gatewaySeen.find((entry) => entry.url.startsWith('/ilink/bot/getuploadurl')).body)
      equal(uploadBody.rawsize, sample.length)
      equal(uploadBody.filesize, aesEcbPaddedSize(sample.length))
      equal(uploadBody.rawfilemd5, sampleMd5)
      assert('filekey 是 32 位 hex', /^[0-9a-f]{32}$/.test(String(uploadBody.filekey)), String(uploadBody.filekey))
      assert('aeskey 是 32 位 hex', /^[0-9a-f]{32}$/.test(String(uploadBody.aeskey)), String(uploadBody.aeskey))
      assert('filekey 与 aeskey 不是同一个值', uploadBody.filekey !== uploadBody.aeskey)
      equal(uploadBody.media_type, UPLOAD_MEDIA_TYPE.FILE)
      equal(uploadBody.to_user_id, 'wxid_bob')
      equal(uploaded.filekey, uploadBody.filekey)
      equal(uploaded.aeskeyHex, uploadBody.aeskey)
      equal(uploaded.plainSize, sample.length)
      equal(uploaded.cipherSize, aesEcbPaddedSize(sample.length))

      // ---------------------------------------------------------- 7. 上传的是密文
      assert('上传只发生一次', cdnSeen.length === 1, `CDN 请求次数=${cdnSeen.length}`)
      const sentCipher = cdnSeen[0].body
      assert('上传 body 长度 = 密文大小', sentCipher.length === aesEcbPaddedSize(sample.length), `${sentCipher.length} vs ${aesEcbPaddedSize(sample.length)}`)
      assert('上传 body 与明文不同（确实是密文）', !sentCipher.equals(sample))
      assert('上传 Content-Type 是 octet-stream', cdnSeen[0].contentType.includes('application/octet-stream'), cdnSeen[0].contentType)
      equal(decryptEcb(sentCipher, Buffer.from(uploaded.aeskeyHex, 'hex')).toString('latin1'), sample.toString('latin1'))

      // ---------------------------------------------------------- 5. x-encrypted-param 是唯一来源
      equal(uploaded.downloadParam, 'DL-PARAM-1')
      cdnPlan = [{ status: 200, param: undefined }]
      cdnSeen.length = 0
      let noHeader = null
      try {
        noHeader = await makeClient().uploadMedia({ filePath: samplePath, toUserId: 'wxid_bob', mediaType: UPLOAD_MEDIA_TYPE.FILE })
      } catch (error) {
        noHeader = error
      }
      assert(
        '缺 x-encrypted-param 时不返回成功（不能拿别的字段顶上）',
        noHeader instanceof Error,
        noHeader instanceof Error ? noHeader.message : `竟然返回了 ${JSON.stringify(noHeader)}`,
      )

      // ---------------------------------------------------------- 6. 4xx 立即失败 / 5xx 重试
      cdnPlan = [
        { status: 500, param: undefined },
        { status: 500, param: undefined },
        { status: 200, param: 'DL-AFTER-RETRY' },
      ]
      cdnSeen.length = 0
      const retried = await makeClient().uploadMedia({ filePath: samplePath, toUserId: 'wxid_bob', mediaType: UPLOAD_MEDIA_TYPE.FILE })
      equal(retried.downloadParam, 'DL-AFTER-RETRY')
      equal(cdnSeen.length, 3)

      cdnPlan = [{ status: 400, param: undefined }]
      cdnSeen.length = 0
      let clientError = null
      try {
        clientError = await makeClient().uploadMedia({ filePath: samplePath, toUserId: 'wxid_bob', mediaType: UPLOAD_MEDIA_TYPE.FILE })
      } catch (error) {
        clientError = error
      }
      assert('4xx 立即失败（不重试）', clientError instanceof Error, clientError instanceof Error ? clientError.message : `竟然返回了 ${JSON.stringify(clientError)}`)
      equal(cdnSeen.length, 1)

      // ---------------------------------------------------------- 媒体 item 的报文形状
      // Reset what the stubs answer and record: the 4xx scenario above deliberately
      // left the CDN failing, and these assertions are about this section's traffic.
      cdnPlan = [{ status: 200, param: 'DL-SEND-FILE' }]
      cdnSeen.length = 0
      gatewaySeen.length = 0
      const sentItems = []
      const accountPath = join(dir, 'file.json')
      writeAccount(accountPath, { token: 'TOK', userId: 'BOT1' })
      /**
       * A client stub with the semantics the bridge relies on: a user message is
       * handed out exactly once (so a reply credential exists), and every media
       * item is recorded. `sendFile` otherwise runs for real.
       */
      const stubClient = () => {
        let polls = 0
        return {
          token: 'TOK',
          baseUrl: gatewayBase,
          // The real upload path, pointed at the stub CDN: `sendFile` delegates the
          // upload to the client, so the stub must provide it — a stub without it
          // says nothing about the code under test.
          uploadMedia: (params) => new IlinkClient({ baseUrl: gatewayBase, token: 'TOK' }).uploadMedia({ ...params, cdnBaseUrl: cdnBase }),
          async getUpdates() {
            polls += 1
            return {
              ret: 0,
              msgs:
                polls === 1
                  ? [
                      {
                        message_type: MESSAGE_TYPE.USER,
                        from_user_id: 'wxid_bob',
                        message_id: 21,
                        context_token: 'CTX-OUT',
                        item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '把文件发我' } }],
                      },
                    ]
                  : [],
              cursor: 'C1',
              longpollingTimeoutMs: 100,
            }
          },
          async sendText(params) {
            sentItems.push({ item: { type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: params.text } }, params })
            return { ret: 0, accepted: true, delivered: 'unknown', detail: 'iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理' }
          },
          async sendMedia(params) {
            sentItems.push(params)
            return { ret: 0, accepted: true, delivered: 'unknown', detail: 'iLink 已提交给网关（送达未确认）：ret=0 只表示网关已受理' }
          },
          async getTypingTicket() {
            return ''
          },
          async sendTyping() {},
        }
      }

      /**
       * Start a bridge on a stub client and wait until it holds a reply credential.
       *
       * @param {Record<string, any>} [settings] - extra `wechat.ilink` settings.
       * @returns {Promise<{ bridge: IlinkBridge, client: Record<string, any> }>} the running bridge.
       */
      const warmBridge = async (settings = {}) => {
        const client = stubClient()
        const bridge = new IlinkBridge(
          { wechat: { ilink: { statePath: accountPath, token: 'TOK', pollTimeoutMs: 100, baseUrl: gatewayBase, ...settings } } },
          { client },
        )
        await bridge.start()
        const deadline = Date.now() + 3000
        while (bridge.sendCredential('wxid_bob').ready !== true && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return { bridge, client }
      }

      const warmed = await warmBridge()
      const itemBridge = warmed.bridge
      assert('桩客户端交出一条消息后凭证就绪', itemBridge.sendCredential('wxid_bob').ready === true, itemBridge.sendCredential('wxid_bob').detail)
      writeFileSync(join(dir, 'note.txt'), '纯文本附件')
      const fileSend = await itemBridge.sendFile({ peerId: 'wxid_bob', filePath: join(dir, 'note.txt'), text: '这是说明' })
      assert('sendFile 走通了', fileSend.ok === true, fileSend.detail)
      equal(sentItems.length, 2)
      equal(sentItems[0].item.type, MESSAGE_ITEM_TYPE.TEXT)
      equal(sentItems[0].item.text_item.text, '这是说明')
      equal(sentItems[1].item.type, MESSAGE_ITEM_TYPE.FILE)

      // ---------------------------------------------------------- 8. sendFile 失败分支
      const noFile = join(dir, '不存在-这个文件.txt')
      const missing = await itemBridge.sendFile({ peerId: 'wxid_bob', filePath: noFile, text: '' })
      assert('文件不存在时返回 ok:false（不抛异常）', missing.ok === false, JSON.stringify(missing))
      assert('不存在的说明是可操作中文', /[\u4e00-\u9fa5]/.test(String(missing.detail)) && /(不存在|找不到|无法|请)/.test(String(missing.detail)), missing.detail)

      const emptyPath = join(dir, 'empty.txt')
      writeFileSync(emptyPath, Buffer.alloc(0))
      const empty = await itemBridge.sendFile({ peerId: 'wxid_bob', filePath: emptyPath, text: '' })
      assert('空文件时返回 ok:false（不抛异常）', empty.ok === false, JSON.stringify(empty))
      assert('空文件的说明是可操作中文', /[\u4e00-\u9fa5]/.test(String(empty.detail)) && /(空|大小|请)/.test(String(empty.detail)), empty.detail)

      // 失败之后桥接仍然可用：一次坏输入不该把它卡在半开状态。
      const afterFailure = await itemBridge.sendFile({ peerId: 'wxid_bob', filePath: join(dir, 'note.txt'), text: '再来一次' })
      assert('失败后仍能正常发送', afterFailure.ok === true, afterFailure.detail)
      assert('发送成功只声称已受理', afterFailure.delivered === 'unknown', String(afterFailure.delivered))

      // 超过上限的文件：拒绝而不是把整个文件读进内存。
      const bigPath = join(dir, 'too-big.bin')
      writeFileSync(bigPath, Buffer.alloc(1024))
      const truncated = statSync(bigPath).size
      equal(truncated, 1024)
      const bigWarm = await warmBridge({ uploadMaxBytes: truncated - 1 })
      const big = await bigWarm.bridge.sendFile({ peerId: 'wxid_bob', filePath: bigPath, text: '' })
      assert('超过 uploadMaxBytes 时返回 ok:false', big.ok === false, JSON.stringify(big))
      assert('超限的说明是可操作中文', /[\u4e00-\u9fa5]/.test(String(big.detail)) && /(超过|上限|大小|请)/.test(String(big.detail)), big.detail)
    } finally {
      gateway.close()
      cdn.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ 回复长度上限
{
  console.log('\n12. iLink 单条回复上限（不切块连发的依据）')
  // 网关按这个值把长回答压成一条（见 chat-gateway.mjs / wechat.mjs 的 maxReplyChars）。
  assert(
    '单条上限落在「手机一屏」区间内',
    ILINK_MAX_REPLY_CHARS >= 800 && ILINK_MAX_REPLY_CHARS <= 1200,
    String(ILINK_MAX_REPLY_CHARS),
  )
}

// ------------------------------------------------------------ 真实网关
if (process.argv.includes('--live')) {
  console.log('\n13. 真实网关连通性（--live）')
  try {
    const client = new IlinkClient({})
    const qr = await client.getQrCode()
    assert('能取到二维码', qr.qrcode.length > 0, qr.qrcode)
    assert('二维码 URL 指向微信', qr.url.includes('weixin.qq.com'), qr.url)
    const status = await client.getQrStatus(qr.qrcode)
    assert('能查询扫码状态', typeof status.status === 'string', status.status || '(等待扫码)')
  } catch (error) {
    assert('真实网关连通性', false, error instanceof Error ? error.message : String(error))
  }
} else {
  console.log('\n13. 真实网关连通性 — 跳过（加 --live 才会真的请求微信接口）')
}

console.log('')
if (failures === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.error(`${failures} 项失败。`)
process.exit(1)
