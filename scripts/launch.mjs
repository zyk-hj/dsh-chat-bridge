#!/usr/bin/env node
/**
 * Desktop launcher: start the bridge, wait until it is actually ready, then open
 * the console as a stand-alone window.
 *
 * The window is Microsoft Edge in `--app=` mode — the same mechanism the WebView2
 * runtime uses — so there is no Electron download and the result still looks and
 * behaves like a desktop application. Fallbacks: another Chromium browser, then
 * the default browser.
 *
 *   node scripts/launch.mjs                 # start, then open the window
 *   node scripts/launch.mjs --no-window     # start only (used by the quiet .vbs)
 *   node scripts/launch.mjs --kill          # stop a bridge already listening
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)

/**
 * Read the console port from the config file's `web:` block.
 *
 * Matching the first `port:` in the file would pick up `onebot.port` (8080), so
 * this walks the document instead of scanning lines.
 */
function consolePort() {
  const path = join(root, 'bridge.config.yaml')
  if (!existsSync(path)) return 8787
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let inWeb = false
  for (const line of lines) {
    if (/^\s*(#|$)/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (!inWeb) {
      if (/^web:\s*$/.test(line.trim())) inWeb = true
      continue
    }
    // A new top-level section ends the `web:` block.
    if (indent === 0) break
    // The written config carries a trailing comment on the same line.
    const match = /^port:\s*(\d+)\b/.exec(line.trim())
    if (match !== null) return Number(match[1])
  }
  return 8787
}

async function isReady(port, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Wait until `/api/health` answers, which means the runtime handshake is done.
 *
 * @param {number} port - the console port.
 * @param {() => number | null} childExitCode - the service's exit code, or null
 *   while it is still running; a service that dies during startup must fail the
 *   launch immediately instead of burning the whole timeout.
 * @param {number} timeoutMs - the overall budget.
 * @returns {Promise<boolean>} whether the service became ready.
 */
async function waitForReady(port, childExitCode, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let misses = 0
  while (Date.now() < deadline) {
    if (await isReady(port)) return true
    const code = childExitCode()
    if (code !== null) {
      console.error(`桥接服务在启动过程中退出了（退出码 ${code}）。`)
      return false
    }
    misses += 1
    // The first probes race the child's own startup, so only mention waiting
    // once it has had a fair chance (~10s).
    if (misses === 6) console.log('仍在等待服务响应…（若长时间无响应，请看 bridge.log）')
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  return false
}

/** Candidate Chromium browsers, in preference order. */
function browserCandidates() {
  const candidates = []
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']]
  for (const base of programFiles) {
    if (base === undefined || base === '') continue
    candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return candidates.filter((path) => existsSync(path))
}

/**
 * Open the console as an application window.
 * @param {number} port - the console port.
 * @returns {boolean} whether a browser was launched.
 */
export function openWindow(port) {
  const url = `http://127.0.0.1:${port}/console`
  const profile = join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-chat-bridge', 'console-profile')
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--window-size=1040,820',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebar',
  ]
  for (const browser of browserCandidates()) {
    try {
      spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      return true
    } catch {
      // try the next candidate
    }
  }
  // Last resort: the default browser opens it as a normal tab.
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * Stop a bridge that is already listening on the console port.
 *
 * Synchronous on purpose: the launcher exits immediately afterwards, so an
 * asynchronous kill would be racing its own process teardown and usually lose.
 *
 * @param {number} port - the console port.
 * @returns {number} how many processes were asked to stop.
 */
function killExisting(port) {
  const script =
    `$p = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique); ` +
    `foreach ($id in $p) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; ` +
    `$p.Count`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
  })
  const count = Number.parseInt((result.stdout ?? '').trim(), 10)
  return Number.isNaN(count) ? 0 : count
}

/**
 * Wait until nothing listens on the port any more.
 * @param {number} port - the console port.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<boolean>} whether the port came free.
 */
async function waitForPortFree(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isReady(port))) {
      // The HTTP endpoint being gone is the signal that matters; the socket may
      // linger a moment longer in TIME_WAIT, which does not block a restart.
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/**
 * Is anything listening on the loopback port?
 *
 * Asked by trying to bind it: unlike shelling out to `netstat`, this is the exact
 * condition that would make the bridge fail with EADDRINUSE.
 *
 * @param {number} port - the console port.
 * @returns {Promise<boolean>} whether the port is taken.
 */
function portIsBound(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, '127.0.0.1')
  })
}

const port = consolePort()

if (hasFlag('--kill')) {
  const count = killExisting(port)
  if (count === 0) {
    console.log(`没有发现监听 ${port} 端口的桥接服务。`)
  } else {
    const freed = await waitForPortFree(port)
    console.log(
      freed
        ? `已停止 ${count} 个桥接服务进程（端口 ${port} 已释放）。`
        : `已请求停止 ${count} 个进程，但端口 ${port} 仍在响应，请稍候或手动结束 node 进程。`,
    )
  }
  process.exit(0)
}

// A second double-click should focus the running instance rather than fail on a
// busy port, so an already-ready bridge just opens the window.
if (await isReady(port)) {
  console.log(`桥接服务已在运行：http://127.0.0.1:${port}/console`)
  if (!hasFlag('--no-window')) openWindow(port)
  process.exit(0)
}

// A bridge may be holding the port without answering yet (still booting, or
// wedged). Starting a second one would only fail on EADDRINUSE, so wait it out.
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await portIsBound(port))) break
  if (attempt === 0) console.log(`端口 ${port} 已被占用，正在等待它释放…`)
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const logPath = join(root, 'bridge.log')
const logHandle = openSync(logPath, 'a')
writeSync(logHandle, `\n# 由启动器在 ${new Date().toISOString()} 启动\n`)
// Detached with the log as its stdio: the console window closes immediately, and
// whatever the service prints still lands in bridge.log for diagnosis.
const out = spawn(process.execPath, [join(root, 'src', 'index.mjs'), ...argv.filter((a) => a !== '--no-window')], {
  cwd: root,
  detached: true,
  stdio: ['ignore', logHandle, logHandle],
  windowsHide: true,
})
out.unref()
// `exitCode` stays null while the process runs; the launcher polls it so a child
// that dies immediately is reported as a failure instead of a timeout.
let childExit = null
out.on('exit', (code) => {
  childExit = code ?? 1
})
out.on('error', (error) => {
  childExit = 1
  console.error(`无法启动桥接服务：${error.message}`)
})

console.log('正在启动桥接服务…')
const ready = await waitForReady(port, () => childExit)
if (!ready) {
  console.error(`启动失败或超时：请查看 ${logPath}，或运行「排错运行.cmd」直接看输出。`)
  closeSync(logHandle)
  process.exit(1)
}
console.log(`已就绪：http://127.0.0.1:${port}/console`)
if (!hasFlag('--no-window')) openWindow(port)
closeSync(logHandle)
process.exit(0)
