#!/usr/bin/env node
/**
 * Console front-end check.
 *
 * The console page is a single HTML string with an inline script, so a typo or a
 * wrong field name would only ever show up in the browser as a toast. This lifts
 * the real script out of the page, runs it against a stub DOM and a stub API, and
 * asserts the observable outcomes: the form gets populated, the status grid gets
 * written, an out-of-order status poll before the config arrives does not throw,
 * and the iLink card renders the QR link, the login state and the failure reason
 * (including the -14 "scan again" message) it is handed.
 *
 *   node scripts/check-console-ui.mjs
 */

import { CONSOLE_HTML } from '../src/console-page.mjs'

let failures = 0
/** @param {string} name - check name. @param {boolean} ok - result. @param {string} [note] - detail. */
function assert(name, ok, note = '') {
  if (ok) console.log(`  ✓ ${name}${note === '' ? '' : ` — ${note}`}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${note === '' ? '' : ` — ${note}`}`)
  }
}

/** Pull the page's inline script out of the HTML. */
function extractScript(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('页面里找不到 <script> 块')
  return match[1]
}

/** The fields the console reads and writes, with the ids its markup declares. */
const CONFIG = {
  dsh: {
    command: 'dsh',
    args: ['--profile', 'sdk'],
    cwd: 'D:\\work',
    env: {},
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    turnTimeoutMs: 600000,
    startupTimeoutMs: 180000,
  },
  onebot: { mode: 'reverse', url: 'ws://127.0.0.1:3001', accessToken: '', host: '127.0.0.1', port: 8080, httpApi: '' },
  chat: {
    maxReplyChars: 1500,
    maxSessionChars: 60000,
    maxInboundChars: 4000,
    prewarmCount: 2,
    requireAtInGroup: true,
    ackOnBusy: true,
    replyAtInGroup: false,
    replyToMessage: true,
    allowedUsers: [10001, 10002],
    allowedGroups: null,
  },
  wechat: {
    enabled: true,
    inbound: 'ilink',
    ilink: { baseUrl: 'https://ilinkai.weixin.qq.com', token: '', statePath: 'ilink-account.json', pollTimeoutMs: 40000 },
    webhook: { host: '127.0.0.1', port: 8788, path: '/message', token: 'secret-token' },
    botNicknames: ['小号', '机器人'],
    sendEnabled: true,
    sendStrategy: 'command',
    recipients: { '12345@chatroom': '项目群' },
    command: { command: 'python', args: [], timeoutMs: 30000 },
    http: { url: '', token: '', timeoutMs: 30000 },
  },
  web: { port: 8787, host: '127.0.0.1' },
}

const STATUS = {
  ok: true,
  uptimeMs: 125000,
  runtimeReady: true,
  restarting: false,
  transport: 'websocket(reverse)',
  conversations: 3,
  sessions: 5,
  configPath: 'D:\\bridge.config.yaml',
  credentialsPath: 'C:\\Users\\x\\.dsh\\.credentials.yaml',
  apiKeySet: true,
  apiKeyFromEnv: false,
  dsh: { found: true, detail: 'C:\\dsh\\bin.js' },
  lastError: null,
  logLevel: 'info',
}

/**
 * One iLink login snapshot the page has to be able to render: a scan in flight
 * that the phone answered with a pairing-code challenge.
 */
const ILINK_SNAPSHOT = {
  state: 'waiting',
  url: 'https://ilinkai.weixin.qq.com/qr/stub-code',
  qrcode: 'stub-code',
  detail: '微信要求输入手机上的配对码：请在下方输入手机上显示的数字',
  attempt: 1,
  running: true,
  needVerifyCode: true,
  alreadyBound: false,
  available: true,
  availableDetail: '',
  enabled: true,
  inbound: 'ilink',
  loggedIn: false,
  connected: false,
  accountUser: '',
  accountBot: '',
  savedAt: null,
  accountPath: 'D:\\ilink-account.json',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

/** What POST /api/wechat/ilink/login answers once the scan is confirmed. */
const ILINK_POST_RESULT = {
  ...ILINK_SNAPSHOT,
  ok: true,
  reused: false,
  state: 'confirmed',
  detail: '登录成功：机器人账号 wxid_stub_bot，已开始收发消息',
  running: false,
  needVerifyCode: false,
  loggedIn: true,
  connected: true,
  accountUser: 'wxid_stub_bot',
  accountBot: 'stub-bot-id',
}

/** `/api/workspace/check` for a directory that is brand new and usable. */
const WORKSPACE_CHECK = {
  path: 'D:\\fresh-workspace',
  requested: 'D:\\fresh-workspace',
  exists: true,
  created: false,
  isDirectory: true,
  writable: true,
  grantCount: 0,
  isProcessCwd: false,
  error: '',
  hint: '目录可写，且上面没有 DSH 的旧授权残留 —— 作为新工作目录条件良好。',
}

/** `/api/wechat/status` with a credential the gateway rejected: the -14 case. */
const WECHAT_STATUS = {
  enabled: true,
  provider: 'ilink',
  inboundOk: false,
  inboundDetail: '登录已失效（errcode -14），请重新扫码',
  sendEnabled: false,
  sendStrategy: 'ilink',
}

/**
 * Run the page script in a stubbed browser.
 * @param {{ order?: 'status-first'|'config-first', ilink?: { snapshot?: Record<string, any>, postResult?: Record<string, any> }, wechatStatus?: Record<string, any> }} [options] - response ordering and iLink payloads.
 * @returns {Promise<{ texts: Map<string,string>, errors: string[], apiCalls: string[], bodies: Array<{ url: string, body: any }>, elements: Map<string, any>, state: any, click: (id: string) => Promise<any> }>}
 */
/**
 * Every `<select>` on the page, mapped to the values it actually offers.
 *
 * The stub DOM uses this to behave like a real select, which is what makes the
 * "an unrecognised setting must not be silently wiped" assertions mean anything.
 */
const SELECT_OPTIONS = new Map()
for (const select of CONSOLE_HTML.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  SELECT_OPTIONS.set(select[1], [...select[2].matchAll(/value="([^"]+)"/g)].map((entry) => entry[1]))
}

async function runPage(options = {}) {
  const script = extractScript(CONSOLE_HTML)
  const elements = new Map()
  const errors = []
  const apiCalls = []
  const bodies = []

  const makeElement = (id) => {
    const node = {
      id,
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      className: '',
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      dataset: {},
      style: {},
      addEventListener() {},
      appendChild() {},
      classList: { toggle() {}, add() {}, remove() {} },
      querySelectorAll: () => [],
      remove() {},
    }
    // A real <select> refuses a value it has no <option> for and reports an empty
    // string instead. Without that, every "the page must not wipe this setting"
    // assertion passes trivially: storing an unknown string in a plain object just
    // works. That gap is exactly how a missing <option> shipped twice, so the stub
    // emulates the real rule for every select it can find on the page.
    const allowed = SELECT_OPTIONS.get(id)
    if (allowed !== undefined) {
      let held = ''
      Object.defineProperty(node, 'value', {
        enumerable: true,
        get: () => held,
        set: (next) => {
          const text = next === undefined || next === null ? '' : String(next)
          held = allowed.includes(text) ? text : ''
        },
      })
    }
    return node
  }
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id))
    return elements.get(id)
  }

  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
  const statusResponse = jsonResponse(STATUS)
  const configResponse = jsonResponse({ config: options.config ?? CONFIG, configPath: CONFIG_PATH, status: STATUS })
  const ilinkSnapshot = { ...ILINK_SNAPSHOT, ...(options.ilink?.snapshot ?? {}) }
  const ilinkPost = { ...ILINK_POST_RESULT, ...(options.ilink?.postResult ?? {}) }
  const wechatStatus = { ...WECHAT_STATUS, ...(options.wechatStatus ?? {}) }

  const fetchStub = async (url, init) => {
    apiCalls.push(`${init?.method ?? 'GET'} ${url}`)
    if (typeof init?.body === 'string') {
      try {
        bodies.push({ url, body: JSON.parse(init.body) })
      } catch {
        bodies.push({ url, body: init.body })
      }
    }
    if (url === '/api/status') return statusResponse
    if (url === '/api/config') return configResponse
    if (url === '/api/logs') return jsonResponse({ lines: [] })
    if (url === '/api/wechat/status') return jsonResponse(wechatStatus)
    if (url === '/api/workspace/check') {
      // Echo the path back so the test proves the page sent what the operator typed.
      let asked = ''
      try {
        asked = JSON.parse(String(init?.body ?? '{}')).path ?? ''
      } catch {
        asked = ''
      }
      return jsonResponse({ ...WORKSPACE_CHECK, path: asked, requested: asked })
    }
    if (url === '/api/wechat/ilink/login') {
      return (init?.method ?? 'GET') === 'POST' ? jsonResponse(ilinkPost) : jsonResponse(ilinkSnapshot)
    }
    return jsonResponse({})
  }

  const document = {
    getElementById: element,
    querySelectorAll: () => [],
  }
  const sandboxGlobals = {
    document,
    fetch: fetchStub,
    EventSource: class {
      constructor() {
        this.onmessage = null
        this.onerror = null
      }
    },
    setInterval: () => 1,
    clearInterval: () => {},
    clearTimeout: () => {},
    // The page uses setTimeout for toasts and settle timers; running the callback
    // immediately keeps the check synchronous without changing what it observes.
    setTimeout: (fn) => {
      if (typeof fn === 'function') fn()
      return 1
    },
    confirm: () => true,
    window: { open() {} },
    console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    Promise,
    RegExp,
  }

  const names = Object.keys(sandboxGlobals)
  const factory = new Function(...names, `${script}\n;return { __peek: () => ({ config, status, ilink }) };`)

  // The script kicks off async loading; let the microtask queue drain. With
  // `status-first` the status poll is answered before the config request, which
  // is the race that used to throw.
  const ordered = options.order !== 'status-first'
  if (ordered) {
    sandboxGlobals.fetch = async (url, init) => {
      await Promise.resolve()
      return fetchStub(url, init)
    }
  }

  let handle
  try {
    handle = factory(...names.map((name) => sandboxGlobals[name]))
  } catch (error) {
    errors.push(String(error))
    return { texts: new Map(), errors, apiCalls, bodies, elements, state: null, click: async () => null, field: element }
  }
  // Four loads (status, config, logs, iLink) plus the chained connection probe
  // have to settle before the observations below mean anything.
  for (let i = 0; i < 120; i += 1) await Promise.resolve()

  const texts = new Map()
  for (const [id, value] of elements) texts.set(id, value.value === '' ? value.textContent : value.value)
  // The script's own state is not part of the contract, but a silent failure to
  // populate it would otherwise look like a pass.
  const state = typeof handle.__peek === 'function' ? handle.__peek() : null
  if (state !== null && state.config === null) errors.push('页面没有拿到 config')
  // Buttons are wired with `onclick`, so a "click" is calling that handler.
  const click = async (id) => {
    const target = elements.get(id)
    if (target === undefined || typeof target.onclick !== 'function') {
      errors.push(`按钮 ${id} 没有绑定点击处理`)
      return null
    }
    const result = target.onclick()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') await result
    return result
  }
  return { texts, errors, apiCalls, bodies, elements, state, click, field: element }
}

const CONFIG_PATH = 'D:\\bridge.config.yaml'

console.log('\n[控制台前端检查]')

const script = extractScript(CONSOLE_HTML)
assert('页面内联脚本存在且非空', script.length > 1000, `${script.length} 字符`)

// 1) The script must parse as JavaScript at all.
let parsed = true
try {
  new Function(script)
} catch (error) {
  parsed = false
  console.error(`      ${error.message}`)
}
assert('内联脚本语法正确', parsed)

// 2) Normal load: form populated from the API envelope.
const normal = await runPage()
assert('加载过程没有抛错', normal.errors.length === 0, normal.errors.join(' | '))
assert('表单读到了模型名', normal.texts.get('dsh-model') === 'deepseek-flash', String(normal.texts.get('dsh-model')))
assert('表单读到了工作目录', normal.texts.get('dsh-cwd') === 'D:\\work', String(normal.texts.get('dsh-cwd')))
assert('白名单数字转成多行文本', normal.texts.get('chat-users') === '10001\n10002', JSON.stringify(normal.texts.get('chat-users')))
assert('端口写入表单', normal.texts.get('web-port') === 8787, String(normal.texts.get('web-port')))
assert('状态网格已渲染', normal.texts.get('status-grid') !== undefined)

// The WeChat tab must be populated too, or the operator cannot set it up at all.
assert('微信面板读到入站端口', normal.texts.get('webhook-port') === 8788, String(normal.texts.get('webhook-port')))
assert('微信面板读到入站路径', normal.texts.get('webhook-path') === '/message', String(normal.texts.get('webhook-path')))
assert('微信面板读到发送命令', normal.texts.get('send-command') === 'python', String(normal.texts.get('send-command')))
assert('微信昵称按行展开', normal.texts.get('wechat-nicknames') === '小号\n机器人', JSON.stringify(normal.texts.get('wechat-nicknames')))
assert(
  '会话映射按 key = value 展开',
  normal.texts.get('wechat-recipients') === '12345@chatroom = 项目群',
  String(normal.texts.get('wechat-recipients')),
)

// 3) The race that produced "读取配置失败：Cannot read properties of undefined".
const statusFirst = await runPage({ order: 'status-first' })
assert('状态先返回时不抛错（原 bug）', statusFirst.errors.length === 0, statusFirst.errors.join(' | '))
assert('状态先返回后表单仍被填充', statusFirst.texts.get('dsh-model') === 'deepseek-flash', String(statusFirst.texts.get('dsh-model')))

// 4) The API calls the page actually makes.
assert('页面请求了 /api/status 与 /api/config', normal.apiCalls.includes('GET /api/status') && normal.apiCalls.includes('GET /api/config'), normal.apiCalls.join(', '))

// 5) The iLink card: login state, account, paths, QR link and the live detail.
assert('页面请求了 iLink 登录状态', normal.apiCalls.includes('GET /api/wechat/ilink/login'), normal.apiCalls.join(', '))
assert('iLink 凭据文件路径已渲染', normal.texts.get('ilink-account-path') === ILINK_SNAPSHOT.accountPath, String(normal.texts.get('ilink-account-path')))
assert('iLink 接口地址已渲染', normal.texts.get('ilink-baseurl') === ILINK_SNAPSHOT.baseUrl, String(normal.texts.get('ilink-baseurl')))
assert('未登录时状态显示为未登录', String(normal.elements.get('ilink-loggedin').innerHTML).includes('未登录'), String(normal.elements.get('ilink-loggedin').innerHTML))
assert('二维码行在有链接时可见', normal.elements.get('ilink-qr-row').hidden === false)
assert('二维码链接写入了 href', normal.elements.get('ilink-qr-link').href === ILINK_SNAPSHOT.url, String(normal.elements.get('ilink-qr-link').href))
assert('二维码链接用新窗口打开', CONSOLE_HTML.includes('id="ilink-qr-link" target="_blank"'))
assert('配对码要求如实显示', String(normal.texts.get('ilink-login-detail')).includes('配对码'), String(normal.texts.get('ilink-login-detail')))
assert('需要配对码时出现输入行', normal.elements.get('ilink-verify-row').hidden === false)
assert('登录失效 -14 显示在连接自检里', String(normal.texts.get('ilink-check-result')).includes('-14'), String(normal.texts.get('ilink-check-result')))
assert('页面保存了最近一次 iLink 状态', normal.state !== null && normal.state.ilink !== null && normal.state.ilink.state === 'waiting', JSON.stringify(normal.state?.ilink?.state))
assert('内联脚本里没有反引号（历史 bug）', script.includes('\u0060') === false)

// 6) Clicking 扫码登录 drives the new POST and renders the confirmed state.
await normal.click('btn-ilink-login')
assert('点击「扫码登录」调用 POST /api/wechat/ilink/login', normal.apiCalls.includes('POST /api/wechat/ilink/login'), normal.apiCalls.join(', '))
assert('扫码登录发送空请求体（表示「开始 / 继续」）', normal.bodies.some((call) => call.url === '/api/wechat/ilink/login' && Object.keys(call.body ?? {}).length === 0), JSON.stringify(normal.bodies))
assert('扫码成功后显示已登录', String(normal.elements.get('ilink-loggedin').innerHTML).includes('已登录'), String(normal.elements.get('ilink-loggedin').innerHTML))
assert('扫码成功后显示成功详情', String(normal.elements.get('ilink-login-detail').textContent).includes('登录成功'), String(normal.elements.get('ilink-login-detail').textContent))
assert('扫码成功后按钮重新可用', normal.elements.get('btn-ilink-login').disabled === false)

// 7) The pairing-code form posts the digits the operator typed.
const verifyRun = await runPage()
verifyRun.field('ilink-verify-code').value = '2468'
await verifyRun.click('btn-ilink-verify')
assert(
  '提交配对码把验证码发给服务端',
  verifyRun.bodies.some((call) => call.url === '/api/wechat/ilink/login' && call.body?.verifyCode === '2468'),
  JSON.stringify(verifyRun.bodies),
)
assert('提交后清空配对码输入框', verifyRun.field('ilink-verify-code').value === '')

// 8) 工作目录检查：把候选目录发给服务端，并把结论原样摊开给操作者。
{
  const cwdRun = await runPage()
  assert('工作目录卡片有检查按钮', cwdRun.elements.get('btn-cwd-check') !== undefined)
  assert('工作目录卡片有创建按钮', cwdRun.elements.get('btn-cwd-create') !== undefined)

  cwdRun.field('dsh-cwd').value = 'D:\\fresh-workspace'
  await cwdRun.click('btn-cwd-check')
  assert(
    '点击检查会 POST /api/workspace/check',
    cwdRun.apiCalls.includes('POST /api/workspace/check'),
    cwdRun.apiCalls.join(', '),
  )
  assert(
    '检查把目录原样发给服务端',
    cwdRun.bodies.some((call) => call.url === '/api/workspace/check' && call.body?.path === 'D:\\fresh-workspace'),
    JSON.stringify(cwdRun.bodies),
  )
  // 结论区必须真的渲染出来，否则按钮点了没有任何反馈。
  // 注意读 elements 而不是 texts：texts 是页面加载时的快照，点击后的状态只能从元素上取。
  const shown = String(cwdRun.elements.get('cwd-result').textContent ?? '')
  assert('检查结论渲染到页面上', shown.includes('D:\\fresh-workspace'), shown || '(空)')
  assert('结论里带上服务端给的建议', shown.includes('条件良好'), shown)
  assert('结论不带 undefined（服务端字段缺失时会露出来）', shown.includes('undefined') === false, shown)

  // 留空时不该发请求，而是就地提示。
  const emptyRun = await runPage()
  emptyRun.field('dsh-cwd').value = ''
  await emptyRun.click('btn-cwd-create')
  assert(
    '目录留空时不发请求，只就地提示',
    emptyRun.apiCalls.includes('POST /api/workspace/check') === false,
    emptyRun.apiCalls.join(', '),
  )
  assert(
    '留空时给出就地提示',
    String(emptyRun.elements.get('cwd-result').textContent ?? '').includes('留空'),
    String(emptyRun.elements.get('cwd-result').textContent ?? '(空)'),
  )
}

// 8) When the route cannot drive iLink at all, say what to change instead.
const unavailable = await runPage({
  ilink: {
    snapshot: {
      ...ILINK_SNAPSHOT,
      available: false,
      url: '',
      running: false,
      needVerifyCode: false,
      detail: '',
      availableDetail: '当前「收消息方式」是 webhook，不是 ilink：请在上面选成 ilink 并保存，再回来扫码',
    },
  },
})
assert('不可用时禁用扫码登录按钮', unavailable.elements.get('btn-ilink-login').disabled === true)
assert('不可用时说明要改哪里', String(unavailable.texts.get('ilink-hint')).includes('ilink'), String(unavailable.texts.get('ilink-hint')))
assert('没有二维码时不显示二维码行', unavailable.elements.get('ilink-qr-row').hidden === true)
assert('不需要配对码时不显示输入行', unavailable.elements.get('ilink-verify-row').hidden === true)
assert('不可用时页面没有抛错', unavailable.errors.length === 0, unavailable.errors.join(' | '))

// 9) `binded_redirect`: the account is already bound, so say that instead of "失败".
const bound = await runPage({
  ilink: {
    snapshot: {
      ...ILINK_SNAPSHOT,
      state: 'failed',
      running: false,
      needVerifyCode: false,
      alreadyBound: true,
      url: '',
      detail: '这个微信号已经绑定过本机器人，微信没有下发新凭据（本机凭据未改动）：不要反复重扫；换一个微信号，或先在「微信 → 我 → 设置 → 插件」里确认机器人入口',
    },
  },
})
assert('已绑定时不再显示「登录失败」', String(bound.elements.get('ilink-login-state').innerHTML).includes('已经绑定过'), String(bound.elements.get('ilink-login-state').innerHTML))
assert('已绑定时给出下一步提示', String(bound.texts.get('ilink-login-detail')).includes('不要反复重扫'), String(bound.texts.get('ilink-login-detail')))

// 10) Every legal select value needs an <option>. A missing one is not cosmetic:
// assigning an unknown value leaves the select empty, and the next "save" posts
// an empty string that the config validator rejects, so the service will not start.
/** @param {string} html - the page. @param {string} id - the select's id. @returns {string[]} its option values. */
function optionValues(html, id) {
  const match = new RegExp('<select id="' + id + '">([\\s\\S]*?)</select>').exec(html)
  if (match === null) return []
  return [...match[1].matchAll(/value="([^"]+)"/g)].map((entry) => entry[1])
}
// Keep in sync with the whitelists in src/config.mjs (`validateConfig`).
const SEND_STRATEGIES = ['ilink', 'command', 'http']
const INBOUND_PROVIDERS = ['ilink', 'webhook', 'none']

const strategyOptions = optionValues(CONSOLE_HTML, 'wechat-strategy')
const missingStrategies = SEND_STRATEGIES.filter((value) => !strategyOptions.includes(value))
assert(
  '发消息方式下拉框覆盖全部合法取值',
  missingStrategies.length === 0,
  missingStrategies.length === 0 ? strategyOptions.join(', ') : `缺少 ${missingStrategies.join(', ')}`,
)

const inboundOptions = optionValues(CONSOLE_HTML, 'wechat-inbound')
const missingInbound = INBOUND_PROVIDERS.filter((value) => !inboundOptions.includes(value))
assert(
  '收消息方式下拉框覆盖全部合法取值',
  missingInbound.length === 0,
  missingInbound.length === 0 ? inboundOptions.join(', ') : `缺少 ${missingInbound.join(', ')}`,
)

// The same rule for every other enum on the page. This is not hypothetical: a
// select that lacks the stored value silently reports '', and the next save posts
// that empty string, so the operator gets "onebot.mode must be one of … got \"\""
// while the form looked perfectly fine. It has happened twice already.
const ONEBOT_MODES = ['reverse', 'forward', 'http-post', 'off']
const modeOptions = optionValues(CONSOLE_HTML, 'onebot-mode')
const missingModes = ONEBOT_MODES.filter((value) => !modeOptions.includes(value))
assert(
  'OneBot 模式下拉框覆盖全部合法取值',
  missingModes.length === 0,
  missingModes.length === 0 ? modeOptions.join(', ') : `缺少 ${missingModes.join(', ')}`,
)

// 11) The four dead routes must not come back, in the selects or anywhere else on
// the page. Each was measured on a real machine before being dropped: wcferry
// injects a DLL into a client build Tencent refuses to log in, uia finds no
// addressable control in WeChat 4.x (it draws its own UI), weixin (simulated
// mouse and keyboard) reported success while delivering nothing, and weflow ships
// no native decryption component. `src/config.mjs` rejects all four values now, so
// one stale <option> or paragraph would let an operator build a configuration the
// service then refuses to start. Only the official iLink Bot and webhook remain.
const REMOVED_ROUTES = ['wcferry', 'weflow', 'weixin', 'uia']
// The official iLink hostname genuinely contains "weixin", so take it out of the
// haystack before scanning for route names.
const scannedPage = CONSOLE_HTML.toLowerCase().split('ilinkai.weixin.qq.com').join('ilink-host')
const leftoverText = REMOVED_ROUTES.filter((route) => scannedPage.includes(route))
assert('页面上没有已删除路线的残留文字', leftoverText.length === 0, leftoverText.join(', ') || '干净')
const leftoverOptions = [...strategyOptions, ...inboundOptions, ...modeOptions].filter((value) => REMOVED_ROUTES.includes(value))
assert('下拉框里没有已删除路线的取值', leftoverOptions.length === 0, leftoverOptions.join(', ') || '干净')

// A stored value with no matching option must be repaired on load, not carried
// into the next save. Feeding the page a config naming a removed route is exactly
// the state an older build left behind.
{
  const stale = await runPage({ config: { ...CONFIG, onebot: { ...CONFIG.onebot, mode: 'reverse-but-gone' } } })
  assert(
    '无法识别的模式被回落成合法值，而不是留空',
    stale.field('onebot-mode').value !== '',
    'value=' + JSON.stringify(stale.field('onebot-mode').value),
  )
}

console.log(`\n控制台前端检查：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
