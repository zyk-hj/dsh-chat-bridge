#!/usr/bin/env node
/**
 * dsh-chat-bridge — 把 DSH 智能体接到微信/QQ 上。
 *
 * 数据流：
 *   微信/QQ ⇄ NapCat（OneBot V11）⇄ 本桥接服务 ⇄ dsh --profile sdk（JSON-RPC/stdio）⇄ 模型
 *
 * 用法：
 *   node src/index.mjs                         # 用 ./bridge.config.yaml（不存在则生成）
 *   node src/index.mjs --cwd "D:\my-project"   # 指定智能体的工作目录
 *   node src/index.mjs --console-only          # 只开控制台，不连机器人
 */

import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { BridgeApp, writeConfigFile } from './bridge-app.mjs'
import { defaultConfig, deepMerge, loadConfig, validateConfig } from './config.mjs'
import { configureLogging, createLogger } from './util.mjs'

const USAGE = `dsh-chat-bridge — 把 DSH 智能体接到微信/QQ

选项：
  --config <path>     配置文件路径（默认 ./bridge.config.yaml）
  --cwd <path>        智能体的工作目录（默认桥接服务所在目录）
  --port <n>          控制台与聊天页端口（默认 8787）
  --web-port <n>      同 --port
  --onebot-port <n>   监听/连接机器人的端口
  --ws <url>          反向模式要连接的机器人 WebSocket 地址
  --http-api <url>    机器人的 HTTP API 地址
  --model <name>      模型名（默认 deepseek-flash）
  --effort <level>    推理强度：off/low/high/max（默认 max；deepseek-flash 不支持 medium）
  --log <level>       日志级别：error/warn/info/debug（默认 info）
  --prewarm <n>       备用会话 id 的数量（默认 2，0 表示关闭）
  --no-prewarm        等同 --prewarm 0
  --no-web            不启动控制台（只跑机器人链路）
  --console-only      只启动控制台，不连接机器人
  --ilink-login       只做微信官方机器人（iLink）扫码登录，登录完就退出
  --ack / --no-ack    是否发送“正在处理…”提示（默认开）
  --open              启动后用浏览器/窗口打开控制台
  --help              显示本帮助

路径里有空格时必须整体加引号，例如：--cwd "D:\\my project"
`

const log = createLogger('main')

/**
 * Parse the bridge's command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ options: Record<string, any>, help: boolean }} parsed options.
 */
export function parseArgs(argv) {
  const options = { overrides: {} }
  const value = (index, flag) => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 需要一个参数`)
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--config':
        options.configPath = value(i, arg)
        i += 1
        break
      case '--cwd':
        options.overrides.dsh = { ...options.overrides.dsh, cwd: value(i, arg) }
        i += 1
        break
      case '--port':
      case '--web-port':
        options.overrides.web = { ...options.overrides.web, port: Number(value(i, arg)) }
        i += 1
        break
      case '--onebot-port':
        options.overrides.onebot = { ...options.overrides.onebot, port: Number(value(i, arg)) }
        i += 1
        break
      case '--ws':
        options.overrides.onebot = { ...options.overrides.onebot, url: value(i, arg), mode: 'reverse' }
        i += 1
        break
      case '--http-api':
        options.overrides.onebot = { ...options.overrides.onebot, httpApi: value(i, arg) }
        i += 1
        break
      case '--model':
        options.overrides.dsh = { ...options.overrides.dsh, model: value(i, arg) }
        i += 1
        break
      case '--effort':
        options.overrides.dsh = { ...options.overrides.dsh, reasoningEffort: value(i, arg) }
        i += 1
        break
      case '--log':
        options.overrides.log = { ...options.overrides.log, level: value(i, arg) }
        i += 1
        break
      case '--prewarm':
        options.overrides.chat = { ...options.overrides.chat, prewarmCount: Number(value(i, arg)) }
        i += 1
        break
      case '--no-prewarm':
        options.overrides.chat = { ...options.overrides.chat, prewarmCount: 0 }
        break
      case '--no-web':
        options.overrides.web = { ...options.overrides.web, enabled: false }
        break
      case '--console-only':
        options.consoleOnly = true
        break
      case '--ilink-login':
        options.ilinkLogin = true
        break
      case '--ack':
        options.overrides.chat = { ...options.overrides.chat, ackOnBusy: true }
        break
      case '--no-ack':
        options.overrides.chat = { ...options.overrides.chat, ackOnBusy: false }
        break
      case '--open':
        options.open = true
        break
      default:
        if (!arg.startsWith('--')) {
          throw new Error(`多余的参数：${arg}\n  提示：路径里有空格时必须整体加引号，例如 --cwd "D:\\my project"`)
        }
        throw new Error(`无法识别的参数：${arg}`)
    }
  }
  return options
}

/** Resolve `$DSH_HOME`, matching the harness's own precedence. */
export function resolveDshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return resolve(homedir(), '.dsh')
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (parsed.help === true) {
    console.log(USAGE)
    return
  }

  let config
  let configPath
  try {
    const loaded = loadConfig(parsed.configPath)
    config = loaded.config
    configPath = loaded.path
  } catch (error) {
    console.error(`配置错误：${error.message}`)
    process.exitCode = 2
    return
  }
  // A first run writes the defaults out so the file stays editable; an existing
  // file is read here but never rewritten by the launcher.
  if (configPath === null && parsed.configPath === undefined) {
    const target = resolve(process.cwd(), 'bridge.config.yaml')
    if (existsSync(target)) {
      Object.assign(config, loadConfig(target).config)
      configPath = target
    } else {
      const defaults = deepMerge(defaultConfig(), parsed.overrides)
      writeConfigFile(target, validateConfig(defaults))
      configPath = target
      Object.assign(config, validateConfig(defaults))
      console.log(`已生成默认配置：${target}`)
    }
  }
  // Snapshot the file's own values before the flags are layered on: the console
  // saves onto this, so `--port` stays a per-run override instead of becoming
  // permanent configuration.
  const baseline = structuredClone(config)
  deepMerge(config, parsed.overrides)
  if (config.dsh.cwd !== '' && !existsSync(config.dsh.cwd)) {
    log.warn(`dsh.cwd 不存在，改用当前目录：${config.dsh.cwd}`)
    config.dsh.cwd = ''
  }

  configureLogging(config.log.level)

  // `--ilink-login` is a one-shot action, not a service: run the QR flow against
  // the configured credential path and exit, so it composes with the launchers.
  if (parsed.ilinkLogin === true) {
    const { runIlinkLogin, describeIlinkError } = await import('./ilink-login.mjs')
    const settings = config.wechat.ilink ?? {}
    const statePath = resolve(String(settings.statePath ?? 'ilink-account.json'))
    console.log('微信 iLink Bot 扫码登录（微信官方机器人接口）')
    console.log(`接口地址：${settings.baseUrl ?? 'https://ilinkai.weixin.qq.com'}`)
    console.log(`凭据文件：${statePath}`)
    console.log('')
    try {
      const account = await runIlinkLogin({
        statePath,
        baseUrl: String(settings.baseUrl ?? ''),
        openBrowser: parsed.open === true,
        onQrCode: ({ url, attempt }) => {
          console.log(attempt > 1 ? `二维码已刷新（第 ${attempt} 次）：` : '请用手机微信扫描下面这个链接里的二维码：')
          console.log(`  ${url}`)
          console.log('')
        },
        onStatus: (status, detail) => {
          if (status === 'scaned') console.log('已扫码，请在手机上点击确认…')
          else if (status === 'scaned_but_redirect') console.log(`服务器要求换到 ${detail?.redirectHost} 继续查询…`)
          else if (status === 'need_verifycode') console.log('配对码不对，请重新输入…')
        },
      })
      console.log(`登录成功，凭据已写入 ${account.savedTo}`)
      console.log(`机器人账号：${account.userId || '(未返回)'}`)
      console.log('下一步：把 wechat.inbound 和 wechat.sendStrategy 设为 ilink，重启后即可在微信里跟它对话。')
    } catch (error) {
      console.error(`登录失败：${describeIlinkError(error)}`)
      process.exitCode = 1
    }
    return
  }

  log.info(`启动 dsh-chat-bridge${configPath === null ? '（使用内置默认配置）' : `（配置：${configPath}）`}`)
  if (config.web.host !== '127.0.0.1' && config.web.host !== 'localhost') {
    log.warn(
      `控制台监听在 ${config.web.host}，它没有鉴权：能访问这个端口的人就能改配置并让智能体在 ${config.dsh.cwd || process.cwd()} 里执行操作。`,
    )
  }

  const app = new BridgeApp({
    config,
    configPath,
    baseline,
    overrides: parsed.overrides,
    consoleOnly: parsed.consoleOnly === true,
    home: resolveDshHome(),
    serverOnly: false,
  })

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`收到 ${signal}，正在退出…`)
    await app.stop()
    log.info('已退出。')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝：', reason))
  process.on('uncaughtException', (error) => log.error('未捕获异常：', error))

  log.info('正在启动 DSH 运行时…')
  const startedAt = Date.now()
  try {
    await app.start()
  } catch (error) {
    log.error('启动失败：')
    log.error(error instanceof Error ? error.message : String(error))
    log.error('请确认已安装并登录 DSH（`dsh --profile sdk --help` 能正常运行），模型 API Key 已配置。')
    await app.stop().catch(() => {})
    process.exitCode = 1
    return
  }
  log.info(`就绪，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  log.info(`控制台：http://${config.web.host}:${config.web.port}/console`)
  if (parsed.open === true) void openConsole(config.web.port)
}

/** Open the console in the default browser (best effort, no dependencies). */
async function openConsole(port) {
  const { spawn } = await import('node:child_process')
  const url = `http://127.0.0.1:${port}/console`
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch (error) {
    log.warn('无法自动打开浏览器：', error instanceof Error ? error.message : error)
  }
}

main().catch((error) => {
  console.error('致命错误：', error)
  process.exit(1)
})
