/**
 * The bridge application: one object that owns the whole live stack and can
 * rebuild parts of it on demand.
 *
 *   OneBot transport  ⇄  ChatGateway  ⇄  ConversationPool  ⇄  DshRuntime
 *                              ▲
 *                        WebServer (chat page + control console + admin API)
 *
 * The desktop console edits the config and then asks for a rebuild; because the
 * runtime and the bot transport own long-lived child processes and sockets,
 * "apply settings" is a teardown-then-start of the affected halves rather than
 * a live patch. The HTTP listener survives a rebuild so the console stays
 * reachable while the restarts happen.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { createLogger, withTimeout } from './util.mjs'
import { deepMerge, defaultConfig, loadConfig, mergeConfigFile, validateConfig } from './config.mjs'
import { ChatGateway } from './chat-gateway.mjs'
import { ConversationPool } from './conversation.mjs'
import { DshRuntime, resolveDshCommand } from './dsh-runtime.mjs'
import { describeIlinkError } from './ilink-login.mjs'
import { OneBotClient } from './onebot.mjs'
import { readAccount } from './wechat-ilink.mjs'
import { WebServer } from './web-server.mjs'
import { parseYaml, stringifyYaml, toYamlDocument } from './yaml.mjs'

const log = createLogger('app')

/** Comment header written above a console-managed credentials document. */
const CREDENTIALS_HEADER = '# DeepSeek Harness 凭据文件：API Key 由控制台写入，其余内容由 harness 管理。'

/**
 * Chinese annotations emitted beside the fields they explain, so a console
 * rewrite keeps the file as readable as the hand-written one it replaces.
 */
const FIELD_COMMENTS = {
  'dsh.command': '启动运行时的命令；找不到 dsh 时改成绝对路径',
  'dsh.args': '分参数书写，不要写成一行',
  'dsh.cwd': '智能体的工作目录：微信里让它做的事都发生在该目录内',
  'dsh.env': '额外注入运行时的环境变量',
  'dsh.provider': '模型服务商',
  'dsh.model': '模型名',
  'dsh.reasoningEffort': 'off / low / high / max（deepseek-flash 不支持 medium；留空用模型默认）',
  'dsh.turnTimeoutMs': '单条消息最长处理时间（毫秒）',
  'dsh.startupTimeoutMs': '等待运行时握手的最长时间（毫秒）',
  'onebot.mode': 'reverse = 本服务去连机器人；forward = 机器人来连本服务；http-post = 机器人 HTTP 上报',
  'onebot.url': '反向模式要连接的机器人 WebSocket 地址',
  'onebot.accessToken': '与机器人端一致的访问令牌，没有就留空',
  'onebot.host': 'forward / http-post 模式的监听主机',
  'onebot.port': 'forward / http-post 模式的监听端口',
  'onebot.path': '正向模式的 WebSocket 路径',
  'onebot.postPath': 'HTTP 上报的路径',
  'onebot.httpApi': '机器人的 HTTP API，例如 http://127.0.0.1:3000；留空则只走 WebSocket',
  'onebot.reconnectDelayMs': '断线重连间隔（毫秒）',
  'chat.requireAtInGroup': '群聊里只回应 @ 了机器人的消息',
  'chat.allowedUsers': '允许的 QQ 号 / 群号；null 表示不限制',
  'chat.allowedGroups': '允许的群号；null 表示不限制',
  'chat.maxReplyChars': '单条回复最大长度；QQ 侧超出自动分片，iLink 侧只发一条并把超出部分省略（腾讯的下行通道对长消息和连发会静默丢包）',
  'chat.maxSessionChars': '一个会话累积多少字符后换新会话（保持上下文干净）',
  'chat.maxInboundChars': '单条入站消息的最大长度，超出会被截断',
  'chat.prewarmCount': '常备几个备用会话 id（0 表示关闭；不会额外调用模型）',
  'chat.ackOnBusy': '收到消息先回一句“正在处理…”',
  'chat.replyAtInGroup': '群聊回复时 @ 对方',
  'chat.replyToMessage': '回复时引用原消息',
  'chat.typingIndicator': '发送“正在输入”状态（部分实现不支持）',
  'chat.groupErrorBudget': '群聊连续失败多少次后静默',
  'chat.groupCooldownMs': '静默时长（毫秒）',
  'web.enabled': '是否启用控制台与聊天页',
  'web.host': '只监听本机；改成其他地址等于把它暴露给能访问该地址的人',
  'web.port': '控制台与聊天页端口',
  'wechat.enabled': '是否启用微信（个人号）路线',
  'wechat.botNicknames': '机器人自己微信昵称（可多个）：群聊 @ 判断 + 防止回答自己的消息；用 ilink 发送时不必填',
  'wechat.inbound': '收消息方式：ilink（微信官方机器人接口，推荐）/ webhook（其它工具 POST 过来）/ none（只发不收）',
  'wechat.ilink.baseUrl': 'iLink 接口地址，一般不用改（官方：https://ilinkai.weixin.qq.com）',
  'wechat.ilink.statePath': '扫码登录后的凭据文件路径；相对路径按启动目录解析',
  'wechat.ilink.pollTimeoutMs': '长轮询窗口（毫秒）；服务端可能自行调短',
  'wechat.ilink.contextTokenTtlMs': '发送凭证有效期（毫秒）：超过这么久没收到对方消息就当凭证过期，回复会直接被拒并提示你先给机器人发一条消息；填 0 关闭检查',
  'wechat.ilink.clientVersion': '向网关申报的协议版本；留空用内置的',
  'wechat.ilink.routeTag': '可选的 SKRouteTag 头，用于固定某个网关路由；一般留空',
  'wechat.ilink.mediaDownload': '是否把图片/文件从腾讯 CDN 取回来（AES-128-ECB 解密后交给智能体）；关掉则只给占位文本',
  'wechat.ilink.cdnBaseUrl': '媒体 CDN 的下载地址（完整 URL）；上传地址由它去掉结尾的 /download 推导，测试时可让两个方向指向同一个桩',
  'wechat.ilink.mediaDir': '下载的媒体存放目录；留空用系统临时目录',
  'wechat.ilink.maxBytes': '单个媒体文件下载大小上限（字节），超过就不下载',
  'wechat.ilink.mediaTimeoutMs': '单个媒体下载超时（毫秒）',
  'wechat.ilink.uploadMaxBytes': '允许发送给用户的单个文件大小上限（字节），超过就拒绝并说明原因',
  'wechat.ilink.uploadTimeoutMs': '单个文件上传超时（毫秒，含 CDN 上传）',
  'wechat.webhook.host': '入站接口监听地址；保持 127.0.0.1 最安全',
  'wechat.webhook.port': '入站接口端口（与控制台端口不能相同）',
  'wechat.webhook.path': '接收消息的路径',
  'wechat.webhook.token': '入站令牌；监听非本机地址时必须设置',
  'wechat.sendEnabled': '是否允许发送；关闭时只收不回',
  'wechat.sendStrategy': '发消息方式：ilink（官方接口，推荐）/ command（你自己的脚本）/ http（你自己的接口）',
  'wechat.recipients': 'wxid → 微信显示名；只有 command / http 需要（ilink 直接按会话 id 寻址）',
  'wechat.command.command': '发送命令；会追加「收件人 正文」两个参数',
  'wechat.command.args': '固定参数，放在收件人和正文之前',
  'wechat.http.url': '发送接口；会 POST {recipient,text,peerId}',
  'log.level': 'error / warn / info / debug',
}

const CONFIG_HEADER = '# dsh-chat-bridge 配置\n# 由控制台写入；手动编辑同样有效，改完在控制台点“应用并重启”即可生效。'

/** How long the console's "scan to log in" request waits for the first QR code. */
const ILINK_FIRST_QR_TIMEOUT_MS = 25000

/** How long a pairing-code challenge waits for the operator before giving up. */
const ILINK_VERIFY_CODE_TIMEOUT_MS = 120000

/**
 * Read the stored DeepSeek API key without touching the rest of the credentials
 * document. The key lives in the `refs` section of `$DSH_HOME/.credentials.yaml`.
 *
 * @param {string} home - resolved DSH home directory.
 * @returns {{ path: string, key: string, envOverride: boolean }} key state.
 */
export function readCredentials(home) {
  const path = joinPath(home, '.credentials.yaml')
  const envOverride = (process.env.DEEPSEEK_API_KEY ?? '') !== ''
  let key = ''
  if (existsSync(path)) {
    try {
      const document = parseYaml(readFileSync(path, 'utf8'))
      const value = document?.refs?.DEEPSEEK_API_KEY
      if (typeof value === 'string') key = value
    } catch (error) {
      log.warn('无法读取凭据文件：', error instanceof Error ? error.message : error)
    }
  }
  return { path, key, envOverride }
}

/**
 * Store the DeepSeek API key.
 *
 * When the document is in the current version-1 shape, only the one line under
 * `refs:` is rewritten — every other byte, comment and record in that file
 * belongs to the harness and must survive untouched. Anything this code does not
 * recognize is re-rendered from its parsed form instead of being edited blind.
 *
 * @param {string} home - resolved DSH home directory.
 * @param {string} key - the API key, or an empty string to remove it.
 * @returns {string} the credentials file path.
 */
export function writeCredentials(home, key) {
  const path = joinPath(home, '.credentials.yaml')
  const trimmed = String(key ?? '').trim()
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const updated = patchApiKeyLine(existing, trimmed)
  if (updated !== null) {
    writeFileSync(path, updated, 'utf8')
    return path
  }
  const document = existing.trim() === '' ? { version: 1 } : parseYaml(existing)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('凭据文件格式无法识别，已放弃写入以免破坏它')
  }
  if (document.version !== 1) document.version = 1
  if (document.refs === null || typeof document.refs !== 'object' || Array.isArray(document.refs)) document.refs = {}
  if (trimmed === '') delete document.refs.DEEPSEEK_API_KEY
  else document.refs.DEEPSEEK_API_KEY = trimmed
  writeFileSync(path, toYamlDocument(document, CREDENTIALS_HEADER), 'utf8')
  return path
}

/** Join a directory and a file name with the platform separator. */
function joinPath(directory, name) {
  const trimmed = String(directory).replace(/[\\/]+$/, '')
  return `${trimmed}${process.platform === 'win32' ? '\\' : '/'}${name}`
}

/**
 * Rewrite only the `DEEPSEEK_API_KEY` line under `refs:`.
 * @param {string} text - current document text.
 * @param {string} key - the new key, or an empty string to remove the line.
 * @returns {string | null} updated text, or null when the shape is not recognized.
 */
function patchApiKeyLine(text, key) {
  if (text.trim() === '') {
    return key === '' ? text : `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${quote(key)}\n`
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  let refsIndent = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = /^([A-Za-z0-9_]+):/.exec(line.trimStart())
    if (match === null) continue
    if (!inRefs) {
      if (match[1] !== 'refs') continue
      inRefs = true
      refsIndent = indent
      continue
    }
    if (indent <= refsIndent) break
    if (match[1] !== 'DEEPSEEK_API_KEY') continue
    if (key === '') {
      lines.splice(i, 1)
      return lines.join('\n')
    }
    lines[i] = `${' '.repeat(indent)}DEEPSEEK_API_KEY: ${quote(key)}`
    return lines.join('\n')
  }
  if (!inRefs) {
    const separator = text.endsWith('\n') ? '' : '\n'
    return key === '' ? text : `${text}${separator}refs:\n  DEEPSEEK_API_KEY: ${quote(key)}\n`
  }
  if (key === '') return text
  // `refs:` exists but holds no such key: append it as the section's first entry.
  const insertion = lines.findIndex((line, index) => index > 0 && /^refs:/.test(lines[index - 1].trimStart()))
  const at = insertion < 0 ? lines.length : insertion + 1
  lines.splice(at, 0, `  DEEPSEEK_API_KEY: ${quote(key)}`)
  return lines.join('\n')
}

/** Single-quote a scalar for YAML. */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Locate a PowerShell host, for the one check Node cannot do itself.
 *
 * Node has no ACL API and this project takes no dependencies, so reading a
 * directory's explicit ACEs means shelling out. Returning `null` when neither host
 * exists is deliberate: the caller reports "could not check" instead of inventing
 * an answer.
 *
 * @returns {string | null} the executable name, or null when there is none.
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    try {
      const probe = spawnSync('where', [candidate], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
      if (probe.status === 0 && String(probe.stdout ?? '').trim() !== '') return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Count the explicit (non-inherited) `S-1-4-*` grant ACEs on a directory.
 *
 * DSH adds one of these every time it boots with that directory as its workspace,
 * so their presence — and especially a *stale* one — is the fingerprint behind the
 * "boots fine, then every tool call fails with an ACL error" symptom.
 *
 * @param {string} directory - absolute path to inspect.
 * @returns {number | null} the count, or null when it could not be determined.
 */
function countExplicitGrantAces(directory) {
  const host = findPowerShell()
  if (host === null) return null
  // LiteralPath, and single quotes doubled, so a directory name cannot break out.
  const literal = directory.replaceAll("'", "''")
  const script = `@((Get-Acl -LiteralPath '${literal}').Access | Where-Object { -not $_.IsInherited -and $_.IdentityReference -like 'S-1-4-*' }).Count`
  try {
    const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    if (result.status !== 0) return null
    const count = Number.parseInt(String(result.stdout ?? '').trim(), 10)
    return Number.isFinite(count) && count >= 0 ? count : null
  } catch {
    return null
  }
}

export class BridgeApp {
  #options
  #config
  #configPath
  #runtime = null
  #pool = null
  #gateway = null
  #onebot = null
  #web = null
  #wechat = null
  #restarting = null
  #lastError = null
  #startedAt = Date.now()
  /** A short description of the long operation currently running, for the console. */
  #progress = null
  /** The values that came from the config file, before command-line overrides. */
  #baseline
  /**
   * The console-driven iLink QR login: at most one flow at a time, plus the live
   * state the console polls while a scan is in progress.
   */
  #ilinkLogin = {
    state: 'idle',
    url: '',
    qrcode: '',
    detail: '',
    attempt: 0,
    needVerifyCode: false,
    /** Set when WeChat answered `binded_redirect`: no new credential was issued. */
    alreadyBound: false,
    startedAt: null,
    finishedAt: null,
    running: false,
    /** `{ resolve, reject, timer }` while WeChat is asking for a pairing code. */
    pendingVerify: null,
  }

  /**
   * @param {{
   *   config: Record<string, any>,
   *   configPath: string | null,
   *   baseline?: Record<string, any>,
   *   home: string,
   *   serverOnly?: boolean,
   * }} options - resolved configuration and runtime paths. `baseline` excludes
   * command-line overrides so a console save never persists a transient flag.
   */
  constructor(options) {
    this.#options = options
    this.#config = options.config
    this.#configPath = options.configPath
    this.#baseline = options.baseline ?? structuredClone(options.config)
  }

  /** @returns {Record<string, any>} the live configuration object. */
  get config() {
    return this.#config
  }

  /** @returns {import('./dsh-runtime.mjs').DshRuntime | null} the live runtime. */
  get runtime() {
    return this.#runtime
  }

  /** @returns {string} the path of the config file, or a note that none is used. */
  get configPath() {
    return this.#configPath ?? '(内置默认配置，尚未写入文件)'
  }

  /** @returns {number | null} the bound console port (resolves `port: 0`). */
  get webPort() {
    return this.#web?.port ?? null
  }

  /** Build the runtime, conversation pool, gateway and (optionally) the bot transport. */
  async start() {
    this.#lastError = null
    await this.#buildRuntime()
    this.#gateway = new ChatGateway(this.#config, this.#pool, {
      onInbound: (note) => this.#web?.push({ kind: 'log', text: `← ${note}` }),
      onOutbound: (note) => this.#web?.push({ kind: 'log', text: `→ ${note}` }),
    })
    if (this.#options.serverOnly !== true && this.#config.web.enabled) {
      this.#web = new WebServer(this.#config, this.#gateway, this)
      await this.#web.start()
    }
    await this.#buildOneBot()
    await this.#buildWeChat()
    this.#startedAt = Date.now()
  }

  async #buildRuntime() {
    const runtime = new DshRuntime(this.#config)
    const pool = new ConversationPool(this.#config, runtime)
    await pool.start()
    this.#runtime = runtime
    this.#pool = pool
  }

  async #buildOneBot() {
    if (this.#options.consoleOnly === true) return undefined
    const mode = this.#config.onebot.mode
    if (mode !== 'reverse' && mode !== 'forward' && mode !== 'http-post') return undefined
    const onebot = new OneBotClient(this.#config)
    this.#gateway.attachOneBot(onebot)
    try {
      await onebot.start()
    } catch (error) {
      this.#lastError = `OneBot 传输启动失败：${error instanceof Error ? error.message : error}`
      log.error(this.#lastError)
    }
    this.#onebot = onebot
    return onebot
  }

  /**
   * Start the WeChat route when it is configured.
   *
   * It can run next to OneBot: both feed the same gateway, and the transport that
   * started last owns outbound sends. That is what makes QQ and WeChat usable at
   * the same time.
   */
  async #buildWeChat() {
    if (this.#options.consoleOnly === true) return undefined
    if (this.#config.wechat.enabled !== true) return undefined
    const { WeChatAdapter } = await import('./wechat.mjs')
    const adapter = new WeChatAdapter(this.#config, this.#gateway, this.#runtime)
    try {
      await adapter.start()
    } catch (error) {
      this.#lastError = `微信适配器启动失败：${error instanceof Error ? error.message : error}`
      log.error(this.#lastError)
    }
    this.#wechat = adapter
    return adapter
  }

  /**
   * Rebuild the live stack after a configuration change. The HTTP listener and
   * the console survive; the bot transport and the runtime are rebuilt with the
   * new settings, so an in-flight answer is dropped.
   *
   * @param {{ config?: Record<string, any>, restartBot?: boolean }} [options]
   * @returns {Promise<Record<string, unknown>>} the new status.
   */
  async applyConfig(options = {}) {
    if (this.#restarting !== null) return this.#restarting
    this.#restarting = this.#doApply(options).finally(() => {
      this.#restarting = null
    })
    return this.#restarting
  }

  async #doApply({ config, restartBot = true }) {
    const target = config ?? this.#config
    log.info(`正在应用设置：重建运行时${restartBot ? '与机器人连接' : ''}`)
    // Order matters: stop the producers before the runtime they feed.
    if (restartBot) {
      this.#progress = '正在停止机器人连接…'
      await this.#stopOneBot()
      this.#progress = '正在停止微信连接…'
      await this.#stopWeChat()
    }
    this.#progress = '正在停止智能体运行时…'
    await this.#stopRuntime()
    this.#progress = '正在启动智能体运行时…'
    await this.#buildRuntime()
    this.#progress = '正在重建会话层…'
    this.#gateway = new ChatGateway(target, this.#pool, {
      onInbound: (note) => this.#web?.push({ kind: 'log', text: `← ${note}` }),
      onOutbound: (note) => this.#web?.push({ kind: 'log', text: `→ ${note}` }),
    })
    this.#web?.reattach(this.#gateway, this)
    if (restartBot) {
      this.#progress = '正在连接机器人…'
      await this.#buildOneBot()
      this.#progress = '正在连接微信…'
      await this.#buildWeChat()
    }
    this.#progress = null
    return this.status()
  }

  /**
   * Stop the bot transport, bounded: a socket that refuses to close must not
   * wedge the console's "apply settings" button.
   */
  async #stopOneBot() {
    const onebot = this.#onebot
    this.#onebot = null
    if (onebot === null) return
    const stopped = await withTimeout(onebot.stop(), 8000, 'timeout')
    if (stopped === 'timeout') log.warn('机器人传输未在 8 秒内关闭，已放弃等待')
  }

  /** Stop the WeChat adapter, bounded like the OneBot transport. */
  async #stopWeChat() {
    const wechat = this.#wechat
    this.#wechat = null
    if (wechat === null) return
    const stopped = await withTimeout(wechat.stop(), 8000, 'timeout')
    if (stopped === 'timeout') log.warn('微信适配器未在 8 秒内关闭，已放弃等待')
  }

  /** Stop the runtime, bounded, so a wedged child cannot block a rebuild. */
  async #stopRuntime() {
    const runtime = this.#runtime
    this.#runtime = null
    this.#pool = null
    if (runtime === null) return
    const stopped = await withTimeout(runtime.stop(), 20000, 'timeout')
    if (stopped === 'timeout') log.warn('智能体运行时未在 20 秒内退出，已放弃等待（可能会留下一个残留进程）')
  }

  /** Stop the bot transport and start it again (connection troubleshooting). */
  async restartOneBot() {
    this.#progress = '正在重连机器人…'
    await this.#stopOneBot()
    await this.#buildOneBot()
    this.#progress = null
    return this.status()
  }

  /** Stop and start just the DSH runtime, keeping chats and config as they are. */
  async restartRuntime() {
    this.#progress = '正在重启智能体运行时…'
    await this.#applyRuntimeOnly()
    this.#progress = null
    return this.status()
  }

  async #applyRuntimeOnly() {
    const gatewayConfig = this.#config
    // The adapters hold a reference to the runtime for their own calls, so they
    // are rebuilt with it.
    await this.#stopWeChat()
    await this.#stopRuntime()
    await this.#buildRuntime()
    this.#gateway = new ChatGateway(gatewayConfig, this.#pool, {
      onInbound: (note) => this.#web?.push({ kind: 'log', text: `← ${note}` }),
      onOutbound: (note) => this.#web?.push({ kind: 'log', text: `→ ${note}` }),
    })
    this.#web?.reattach(this.#gateway, this)
    if (this.#onebot !== null) this.#gateway.setTransport(this.#onebot)
    await this.#buildWeChat()
  }

  /**
   * Write an edited configuration to disk and apply it live.
   *
   * The edit is merged onto the file's own values rather than onto the live
   * object, so a setting that came from a command-line flag stays a per-run
   * override instead of being silently frozen into the file.
   *
   * @param {Record<string, any>} patch - partial configuration from the console.
   * @returns {Promise<Record<string, unknown>>} the new status.
   */
  async saveConfig(patch) {
    const persisted = validateConfig(mergeConfigFile(this.#baseline, patch))
    if (this.#configPath !== null) {
      writeConfigFile(this.#configPath, persisted)
      this.#baseline = structuredClone(persisted)
      log.info(`配置已写入 ${this.#configPath}`)
    }
    // The live configuration keeps this run's overrides on top of what was saved.
    const live = this.#options.overrides === undefined ? persisted : deepMerge(structuredClone(persisted), this.#options.overrides)
    // Mutate in place so every component that captured the object sees the new
    // values, then rebuild the halves that cannot change underfoot.
    for (const key of Object.keys(this.#config)) delete this.#config[key]
    Object.assign(this.#config, validateConfig(live))
    return this.applyConfig({ config: this.#config })
  }

  /**
   * Save the DeepSeek API key.
   * @param {string} key - the key, or an empty string to clear it.
   * @returns {Promise<Record<string, unknown>>} the new status.
   */
  async saveApiKey(key) {
    writeCredentials(this.#options.home, key)
    return this.applyConfig({ config: this.#config, restartBot: false })
  }

  /**
   * Start a throwaway runtime to check that the current route and credentials
   * work, without disturbing the running one.
   * @returns {Promise<{ ok: boolean, message: string }>} the probe result.
   */
  async testRuntime() {
    const probeConfig = deepMerge(defaultConfig(), this.#config)
    probeConfig.dsh = { ...probeConfig.dsh, cwd: process.cwd() }
    probeConfig.chat = { ...probeConfig.chat, prewarmCount: 0 }
    const runtime = new DshRuntime(probeConfig)
    const startedAt = Date.now()
    try {
      await withTimeout(runtime.start(), probeConfig.dsh.startupTimeoutMs, undefined)
      if (!runtime.ready) throw new Error('运行时未在超时时间内完成握手')
      return { ok: true, message: `握手成功，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      await runtime.stop().catch(() => {})
    }
  }

  /**
   * Report whether the DSH runtime can be launched at all.
   * @returns {{ found: boolean, detail: string }} resolution result.
   */
  checkDsh() {
    const command = this.#config.dsh.command
    const launch = resolveDshCommand(command)
    if (launch === null) return { found: false, detail: `找不到 ${command}` }
    return { found: true, detail: launch.prefix.length > 0 ? launch.prefix[0] : launch.command }
  }

  /** Snapshot for the console: status, paths and live counters. */
  status() {
    const credentials = readCredentials(this.#options.home)
    return {
      ok: true,
      uptimeMs: Date.now() - this.#startedAt,
      runtimeReady: this.#runtime?.ready === true,
      restarting: this.#restarting !== null,
      progress: this.#progress,
      transport: this.#transportLabel(),
      wechatEnabled: this.#config.wechat.enabled === true,
      wechatSendEnabled: this.#config.wechat.sendEnabled === true,
      conversations: this.#pool?.size ?? 0,
      sessions: this.#pool?.renewals ?? 0,
      configPath: this.#configPath,
      credentialsPath: credentials.path,
      apiKeySet: credentials.key !== '',
      apiKeyFromEnv: credentials.envOverride,
      dsh: this.checkDsh(),
      lastError: this.#lastError,
      logLevel: this.#config.log.level,
    }
  }

  /** @returns {string} which transport currently owns outbound sends. */
  #transportLabel() {
    if (this.#wechat !== null) return this.#wechat.transportLabel
    if (this.#onebot !== null) return this.#onebot.transportLabel
    return 'offline'
  }

  /** Snapshot the WeChat route for the console: which inbound provider runs, and its health. */
  async wechatStatus() {
    if (this.#wechat === null) {
      return { enabled: false, detail: this.#config.wechat.enabled === true ? '已启用但未启动' : '未启用' }
    }
    const status = await this.#wechat.status()
    return { enabled: true, ...status }
  }

  /**
   * Inspect a candidate agent working directory before the operator commits to it.
   *
   * The path alone says nothing about whether it will work. DSH adds its own
   * explicit grant ACE to whatever directory it boots in, and a directory that
   * already carries one from an earlier session can make that step fail — the
   * symptom is not a startup error but "the agent chats fine and every tool call
   * comes back as an ACL failure". Two things are therefore reported:
   *
   *  - a real write test, because that is the part a wrong answer would mislead on;
   *  - how many explicit (non-inherited) `S-1-4-*` grant ACEs already sit on the
   *    directory, which is the fingerprint of "DSH has used this before".
   *
   * The ACL part needs PowerShell; when it is unavailable the count comes back as
   * `null` and the hint says so, rather than guessing.
   *
   * @param {{ path: string, create?: boolean }} params - candidate directory.
   * @returns {Promise<Record<string, any>>} the findings, plus a plain-language hint.
   */
  async checkWorkspace(params) {
    const requested = String(params?.path ?? '').trim()
    const target = isAbsolute(requested) ? requested : resolve(requested)
    let created = false
    let exists = existsSync(target)
    let isDirectory = false
    let writable = false
    let error = ''

    if (!exists && params?.create === true) {
      try {
        mkdirSync(target, { recursive: true })
        created = true
        exists = true
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
    }
    if (exists) {
      try {
        isDirectory = statSync(target).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (exists && isDirectory) {
      // A real write, then clean up: existence and permissions are not the same
      // question, and it is the write that the agent actually needs.
      const probe = resolve(target, `.dsh-bridge-write-test-${process.pid}`)
      try {
        writeFileSync(probe, 'ok', 'utf8')
        rmSync(probe, { force: true })
        writable = true
      } catch (failure) {
        if (error === '') error = failure instanceof Error ? failure.message : String(failure)
        try {
          rmSync(probe, { force: true })
        } catch {
          // Leaving a stray probe file is worse than ignoring this.
        }
      }
    }

    const grantCount = isDirectory ? countExplicitGrantAces(target) : null
    const isProcessCwd = resolve(process.cwd()) === target

    let hint
    if (!exists) hint = '目录不存在。点「创建并检查」会先把它建出来，再验证能不能写。'
    else if (!isDirectory) hint = '这个路径是个文件，不是目录。'
    else if (!writable) hint = `桥接服务写不进去${error === '' ? '' : `（${error}）`}。换一个有权限的目录。`
    else if (grantCount === null) hint = '目录可写，可以设为工作目录。DSH 授权项未能检测（没找到 PowerShell），所以无法预判沙箱那一步。'
    else if (grantCount > 0) {
      hint =
        `目录可写，但它上面已经有 ${grantCount} 条 DSH 显式授权项 —— 说明它被 DSH 当过工作目录。` +
        '若智能体在微信里“能聊天但一用工具就报 ACL 错误”，换一个从未被 DSH 用过的新目录通常就好了。'
    } else hint = '目录可写，且上面没有 DSH 的旧授权残留 —— 作为新工作目录条件良好。'

    return { path: target, requested, exists, created, isDirectory, writable, grantCount, isProcessCwd, error, hint }
  }

  /** Probe the configured outbound strategy once, to prove the send path works. */
  async probeWeChatSender() {
    if (this.#wechat === null) return { ok: false, detail: '微信适配器未启动（请先在配置里启用 wechat.enabled）' }
    return this.#wechat.probeSender()
  }

  /**
   * The iLink bridge that is live right now, when the WeChat route runs with
   * `inbound: ilink`. The console drives its QR login instead of starting a
   * second copy that would hold a different token.
   *
   * @returns {import('./wechat-ilink.mjs').IlinkBridge | null} the bridge.
   */
  #ilinkBridge() {
    const adapter = this.#wechat
    if (adapter === null || adapter === undefined) return null
    return adapter.ilink ?? null
  }

  /**
   * Where the iLink credentials live, whether or not the route is running.
   * @returns {string} the credential file path.
   */
  #ilinkAccountPath() {
    return this.#ilinkBridge()?.accountPath ?? String(this.#config.wechat?.ilink?.statePath ?? 'ilink-account.json')
  }

  /**
   * Snapshot of the iLink login for the console. Deliberately local: it never
   * touches the network, so the page can poll it while a scan is in progress.
   * `state` is the login flow's life cycle, `loggedIn` says whether a usable
   * credential is stored — the two are independent (a stored token can be stale).
   *
   * @returns {Record<string, any>} state, QR url, detail and the stored account.
   */
  ilinkLoginStatus() {
    const bridge = this.#ilinkBridge()
    const login = this.#ilinkLogin
    const accountPath = this.#ilinkAccountPath()
    const account = bridge?.account ?? readAccount(accountPath)
    const enabled = this.#config.wechat.enabled === true
    const inbound = String(this.#config.wechat.inbound)
    let availableDetail = ''
    if (bridge === null) {
      availableDetail = enabled
        ? `当前「收消息方式」是 ${inbound}，不是 ilink：请在上面选成 ilink 并保存，再回来扫码`
        : '微信路线未启用：请先勾选「启用微信路线」、把收消息方式选成 ilink 并保存'
    }
    return {
      state: login.state,
      url: login.url,
      qrcode: login.qrcode,
      detail: login.detail,
      attempt: login.attempt,
      running: login.running,
      needVerifyCode: login.needVerifyCode,
      alreadyBound: login.alreadyBound === true,
      startedAt: login.startedAt,
      finishedAt: login.finishedAt,
      // Whether a scan can be driven at all, and what to change when it cannot.
      available: bridge !== null,
      availableDetail,
      enabled,
      inbound,
      loggedIn: bridge !== null ? bridge.loggedIn === true : String(account?.token ?? '') !== '',
      connected: bridge?.connected === true,
      accountUser: String(account?.userId ?? ''),
      accountBot: String(account?.botId ?? ''),
      savedAt: account?.savedAt ?? null,
      accountPath,
      baseUrl: String(account?.baseUrl ?? this.#config.wechat?.ilink?.baseUrl ?? ''),
    }
  }

  /**
   * Start a QR login, or answer the pairing-code challenge of the one running.
   *
   * Only one flow runs at a time: a second POST while one is in progress is
   * answered with the current state rather than starting a competing scan, which
   * would invalidate the code already on screen.
   *
   * @param {{ verifyCode?: string }} [payload] - pairing code typed by the operator.
   * @returns {Promise<Record<string, any>>} the login state, including the QR url.
   */
  async startIlinkLogin(payload = {}) {
    const verifyCode = String(payload?.verifyCode ?? '').trim()
    const login = this.#ilinkLogin
    if (login.running) {
      if (verifyCode !== '') return this.#submitVerifyCode(verifyCode)
      const snapshot = this.ilinkLoginStatus()
      return { ...snapshot, ok: true, reused: true, detail: snapshot.detail || '登录流程已在进行中' }
    }

    const bridge = this.#ilinkBridge()
    if (bridge === null) {
      const snapshot = this.ilinkLoginStatus()
      return { ...snapshot, ok: false, reused: false, detail: snapshot.availableDetail }
    }

    this.#ilinkLogin = {
      state: 'waiting',
      url: '',
      qrcode: '',
      detail: '正在向微信申请二维码…',
      attempt: 0,
      needVerifyCode: false,
      alreadyBound: false,
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      pendingVerify: null,
    }
    let announceFirstQr = null
    const firstQr = new Promise((resolve) => {
      announceFirstQr = resolve
    })
    void this.#runIlinkLogin({ bridge, announceFirstQr })
    // The caller wants the link in the reply; give the gateway a moment to mint
    // it, then answer with whatever the flow has reached so far.
    await withTimeout(firstQr, ILINK_FIRST_QR_TIMEOUT_MS, null)
    const snapshot = this.ilinkLoginStatus()
    const alive = snapshot.state === 'waiting' || snapshot.state === 'scaned' || snapshot.state === 'confirmed'
    return { ...snapshot, ok: alive, reused: false }
  }

  /**
   * Hand the operator's pairing code to the flow that is waiting for it.
   *
   * @param {string} code - the digits shown on the phone.
   * @returns {Record<string, any>} the login state.
   */
  #submitVerifyCode(code) {
    const login = this.#ilinkLogin
    const pending = login.pendingVerify
    if (pending === null) {
      const snapshot = this.ilinkLoginStatus()
      return { ...snapshot, ok: false, reused: true, detail: '当前登录流程没有在等待配对码' }
    }
    login.pendingVerify = null
    login.needVerifyCode = false
    login.detail = '已提交配对码，正在等待微信确认…'
    clearTimeout(pending.timer)
    pending.resolve(code)
    return { ...this.ilinkLoginStatus(), ok: true, reused: true }
  }

  /**
   * Wait for the operator to type the pairing code WeChat shows on the phone.
   *
   * Bounded on purpose: an abandoned scan must not hold the flow open forever.
   *
   * @returns {Promise<string>} the code.
   */
  #waitForVerifyCode() {
    const login = this.#ilinkLogin
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        login.pendingVerify = null
        login.needVerifyCode = false
        reject(new Error('等待配对码超时：请在控制台重新发起扫码登录'))
      }, ILINK_VERIFY_CODE_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      login.needVerifyCode = true
      login.detail = '微信要求输入手机上的配对码：请在下方输入手机上显示的数字'
      login.pendingVerify = { resolve, reject, timer }
    })
  }

  /**
   * Run one QR login to completion and, on success, store the credentials and
   * start receiving — in this process, with no restart.
   *
   * The flow itself lives on the bridge (`refreshQrCode`), because the gateway
   * needs the tokens this machine already holds to answer `binded_redirect`
   * instead of failing the scan.
   *
   * @param {{ bridge: any, announceFirstQr: ((info: any) => void) | null }} params - flow inputs.
   * @returns {Promise<void>} resolves once the flow ended, successfully or not.
   */
  async #runIlinkLogin({ bridge, announceFirstQr }) {
    const login = this.#ilinkLogin
    let announced = false
    const announce = (info) => {
      if (announced) return
      announced = true
      announceFirstQr?.(info ?? null)
    }
    try {
      const account = await bridge.refreshQrCode({
        onQrCode: (info) => {
          // A re-issued code replaces the one on screen: the previous QR is dead.
          login.url = String(info?.url ?? '')
          login.qrcode = String(info?.qrcode ?? '')
          login.attempt = Number(info?.attempt ?? login.attempt)
          if (login.state !== 'scaned') login.state = 'waiting'
          login.detail =
            login.attempt > 1 ? `上一个二维码已过期，已重新获取（第 ${login.attempt} 个）` : '请用手机微信扫描下面的二维码'
          announce(info)
        },
        onStatus: (state) => {
          if (state === 'scaned') {
            login.state = 'scaned'
            login.detail = '已扫码，请在手机上确认登录'
          } else if (state === 'scaned_but_redirect') {
            login.detail = '已扫码，正在切换到就近的微信服务器…'
          } else if (state === 'need_verifycode') {
            login.detail = '已提交配对码，正在核对…'
          } else if (state === 'binded_redirect') {
            login.detail = '微信说这个微信号已经绑定过本机器人，正在确认本机凭据…'
          }
        },
        onVerifyCode: () => this.#waitForVerifyCode(),
      })
      // A rebuild during the scan may have replaced the bridge underneath us, so
      // store through whichever one is attached now (a different instance would
      // otherwise keep polling with no token).
      const current = this.#ilinkBridge() ?? bridge
      if (account.alreadyBound === true || String(account.token ?? '') === '') {
        // `binded_redirect`: the scanned account is already wired to a token this
        // machine holds, so WeChat issues no new one. Writing an empty token over
        // the working credential file would break the setup — leave it alone and
        // only make sure the receive loop is running. Re-scanning repeatedly is
        // what the official client warns against (#242).
        login.alreadyBound = true
        login.state = 'failed'
        login.detail =
          '这个微信号已经绑定过本机器人，微信没有下发新凭据（本机凭据未改动）：不要反复重扫；' +
          '换一个微信号，或先在「微信 → 我 → 设置 → 插件」里确认机器人入口'
        log.warn('iLink 扫码返回 binded_redirect：该账号已绑定过本机器人，本机凭据未改动')
        await current.start()
      } else {
        current.saveAccount(account)
        await current.start()
        login.alreadyBound = false
        login.state = 'confirmed'
        login.detail = `登录成功：机器人账号 ${account.userId !== '' ? account.userId : '未知'}，已开始收发消息`
        log.info(`iLink 扫码登录成功：${account.userId !== '' ? account.userId : '未知'}，凭据已存入 ${current.accountPath}`)
      }
    } catch (error) {
      const message = describeIlinkError(error)
      login.state = message.includes('过期') ? 'expired' : 'failed'
      login.detail = message
      log.warn(`iLink 扫码登录失败：${message}`)
    } finally {
      login.running = false
      login.needVerifyCode = false
      login.finishedAt = Date.now()
      if (login.pendingVerify !== null) {
        clearTimeout(login.pendingVerify.timer)
        login.pendingVerify = null
      }
      announce(null)
    }
  }

  /** Stop every live component; the process may exit afterwards. */
  async stop() {
    await Promise.allSettled([this.#onebot?.stop(), this.#wechat?.stop(), this.#web?.stop()])
    await this.#runtime?.stop()
    this.#onebot = null
    this.#wechat = null
    this.#web = null
    this.#runtime = null
    this.#pool = null
  }
}

/**
 * Write a configuration document to disk, annotated with the field comments the
 * hand-written template carries.
 * @param {string} path - config file path.
 * @param {Record<string, any>} config - the configuration to write.
 */
export function writeConfigFile(path, config) {
  writeFileSync(path, renderConfig(config), 'utf8')
}

/**
 * Render the configuration as annotated YAML.
 * @param {Record<string, any>} config - the configuration.
 * @returns {string} file-ready text.
 */
export function renderConfig(config) {
  const lines = [CONFIG_HEADER, '']
  emitSection(lines, config, 0, '')
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function emitSection(lines, value, indent, path) {
  const pad = '  '.repeat(indent)
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = path === '' ? key : `${path}.${key}`
    const comment = FIELD_COMMENTS[fieldPath]
    const suffix = comment === undefined ? '' : `   # ${comment}`
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${key}: []${suffix}`)
        continue
      }
      lines.push(`${pad}${key}:${suffix}`)
      for (const element of item) {
        const rendered = scalar(element)
        lines.push(rendered.includes('\n') ? `${pad}  -\n${rendered}` : `${pad}  - ${rendered}`)
      }
      continue
    }
    const nested = item !== null && typeof item === 'object' && Object.keys(item).length > 0
    if (nested) {
      lines.push(`${pad}${key}:`)
      emitSection(lines, item, indent + 1, fieldPath)
      continue
    }
    lines.push(`${pad}${key}: ${scalar(item)}${suffix}`)
  }
}

/** Render one leaf value the same way the YAML writer does. */
function scalar(value) {
  return stringifyYaml(value, 0)
}

export { loadConfig }
