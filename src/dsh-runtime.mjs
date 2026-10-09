/**
 * Client for the DeepSeek Harness SDK runtime (server side:
 * `@deepseek-ai/dsh-sdk-jsonrpc-server`, mounted by `dsh --profile sdk`).
 *
 * The wire is newline-delimited JSON-RPC 2.0 over the runtime's stdin/stdout:
 *
 *   → initialize       { cwd, provider, model, reasoningEffort? }  → { serverInfo }
 *   → session/prompt   { sessionId, contentBlocks }                → { messageId }
 *   → shutdown         {}                                          → {}
 *   ← session.event    { sessionId, event }      (every session in the runtime)
 *   ← session.status   { sessionId, status }     (whole-agent running|idle)
 *
 * `session/prompt` is only an admission receipt: the assistant's answer arrives
 * later as `assistant/message` session events. stdout carries protocol frames
 * exclusively, so every diagnostic this process prints goes to stderr.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createLogger } from './util.mjs'

const log = createLogger('sdk')

const WINDOWS = process.platform === 'win32'
const PATH_EXTENSIONS = WINDOWS ? ['.cmd', '.exe', '.bat', '.ps1'] : ['']

/** Candidate install directories for a global `npm i -g @deepseek-ai/dsh`. */
function globalBinDirs() {
  const dirs = []
  if (process.env.APPDATA !== undefined && process.env.APPDATA !== '') {
    dirs.push(join(process.env.APPDATA, 'npm'))
  }
  if (process.env.LOCALAPPDATA !== undefined && process.env.LOCALAPPDATA !== '') {
    dirs.push(join(process.env.LOCALAPPDATA, 'pnpm'))
  }
  if (process.env.PNPM_HOME !== undefined && process.env.PNPM_HOME !== '') dirs.push(process.env.PNPM_HOME)
  dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  return dirs
}

/**
 * Extract the Node entry script out of an npm shim (`.cmd`, `.ps1`, or the
 * extensionless POSIX shim — all three spell it as a `…/node_modules/…` path,
 * sometimes behind the shim's own `%dp0%` / `$basedir` directory variable).
 */
function shimTarget(text, shimPath) {
  const match = text.match(/"([^"\r\n]*node_modules[^"\r\n]*?\.(?:js|cjs|mjs))"/i)
  if (match === null) return null
  const shimDir = dirname(shimPath)
  // `%~dp0` (with the tilde) is what cmd.exe actually writes for npm and for the
  // Desktop launcher; `%dp0%` without it is the same idea for a plain variable.
  // Only handling the tilde-less spelling meant a `%~dp0` shim never resolved,
  // and the caller then fell back to spawning the `.cmd` itself.
  const raw = match[1]
    .replaceAll('%~dp0', shimDir)
    .replaceAll('%dp0%', shimDir)
    .replaceAll('$basedir', shimDir)
  return isAbsolute(raw) ? raw : resolve(shimDir, raw)
}

/**
 * Resolve a script shim to the Node entry script it launches.
 *
 * @param {string} shimPath - absolute path to the shim.
 * @returns {string | null} the entry script, or null when it cannot be resolved
 *   to a file that actually exists.
 */
function shimEntryScript(shimPath) {
  try {
    const target = shimTarget(readFileSync(shimPath, 'utf8'), shimPath)
    if (target === null || !existsSync(target)) return null
    return target
  } catch {
    return null
  }
}

/**
 * Find a runnable `dsh` without trusting the caller's PATH.
 *
 * npm's Windows shim (`dsh.cmd`) cannot be spawned directly without a shell. Node
 * has refused that since the CVE-2024-27980 fix (it fails with `spawn EINVAL`),
 * and routing through a shell would insert an extra process between this bridge
 * and the runtime — killing the child would then leave the real runtime orphaned.
 * So a shim is always resolved to its underlying Node entry script and launched
 * with the Node that runs this bridge, which also keeps both on the same major
 * version.
 *
 * @param {string} command - configured command name or path (`dsh` by default).
 * @returns {{ command: string, prefix: string[] } | null} an absolute launch recipe.
 */
export function resolveDshCommand(command) {
  // Prefer the platform's native shims over the extensionless POSIX one, which
  // Windows cannot spawn.
  const extensions = WINDOWS ? ['.cmd', '.exe', '.bat', '.ps1', ''] : ['']
  const candidates = []
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    candidates.push(resolve(command))
  } else {
    const dirs = [...(process.env.PATH ?? '').split(delimiter), ...globalBinDirs()]
    for (const dir of dirs) {
      if (dir === '') continue
      for (const extension of extensions) candidates.push(join(dir, `${command}${extension}`))
    }
  }
  /** Candidates that exist but cannot be launched, kept for the failure message. */
  const unusable = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const lower = candidate.toLowerCase()
    // A real executable is spawnable as-is.
    if (lower.endsWith('.exe') || lower.endsWith('.com')) return { command: candidate, prefix: [] }
    // Anything else PATH offers is a script shim: `.cmd`/`.bat`/`.ps1` on Windows,
    // an extensionless shell script elsewhere. Resolve it to its entry script.
    const target = shimEntryScript(candidate)
    if (target !== null) return { command: process.execPath, prefix: [target] }
    // Unresolvable. On POSIX the candidate may still be a runnable binary, so fall
    // back to spawning it directly. On Windows there is no such fallback: returning
    // the shim would guarantee `spawn EINVAL` the moment the runtime starts, so
    // skip it and keep looking — a later candidate (the npm shim, say) may be fine.
    if (!WINDOWS) return { command: candidate, prefix: [] }
    unusable.push(candidate)
  }
  // A bare command name that PATH failed to resolve may still be reachable as a
  // local DSH checkout beside this bridge (see `findLocalDsh`).
  if (command === 'dsh' || command === 'dsh.js') {
    const local = findLocalDsh()
    if (local !== null) return { command: process.execPath, prefix: [local] }
  }
  if (unusable.length > 0) {
    // Without this the operator sees only "找不到 dsh", which is wrong — it was
    // found, it just cannot be launched from here.
    log.warn(`找到 dsh 但无法启动：${unusable.join('、')}（这些是脚本 shim，且解析不出 Node 入口脚本）`)
  }
  return null
}

/** Recursively list `@deepseek-ai/dsh/lib/bin.js` under a package root. */
function findDshBin(root) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) continue
    const direct = join(dir, 'lib', 'bin.js')
    if (existsSync(direct) && existsSync(join(dir, 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest.name === '@deepseek-ai/dsh') return direct
      } catch {
        // not the DSH package
      }
    }
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) stack.push(join(dir, entry.name))
    }
  }
  return null
}

/**
 * One JSON-RPC 2.0 endpoint over newline-delimited streams. Requests are only
 * ever issued by the bridge (client→server), while the runtime pushes the
 * notifications in `notificationMethods`.
 */
export class JsonRpcLineTransport extends EventEmitter {
  #input
  #output
  #buffer = ''
  #decoder = new StringDecoder('utf8')
  #pending = new Map()
  #nextId = 1
  #closed = false

  /**
   * @param {NodeJS.ReadableStream} input - frame source (runtime stdout).
   * @param {NodeJS.WritableStream} output - frame sink (runtime stdin).
   */
  constructor(input, output) {
    super()
    this.#input = input
    this.#output = output
    this.#input.on('data', this.#onData)
    this.#input.on('error', this.#onError)
    this.#input.on('end', this.#onEnd)
  }

  /**
   * Send a request and resolve with its result.
   * @param {string} method - JSON-RPC method name.
   * @param {unknown} params - request parameters.
   * @param {number} [timeoutMs] - reject after this many milliseconds.
   * @returns {Promise<any>} the response result.
   */
  request(method, params, timeoutMs) {
    if (this.#closed) return Promise.reject(new Error(`runtime transport is closed (${method})`))
    const id = `r${this.#nextId++}`
    return new Promise((resolve, reject) => {
      let timer = null
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`runtime did not answer ${method} within ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.#pending.set(id, {
        resolve: (value) => {
          if (timer !== null) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer !== null) clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.#pending.delete(id)
        if (timer !== null) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Detach listeners and fail every in-flight request. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#input.off('data', this.#onData)
    this.#input.off('error', this.#onError)
    this.#input.off('end', this.#onEnd)
    this.#failAll(new Error('runtime transport closed'))
  }

  #failAll(error) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  #onData = (chunk) => {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line !== '') this.#dispatch(line)
    }
  }

  #onError = (error) => {
    log.warn('runtime stream error:', error)
    this.#failAll(error instanceof Error ? error : new Error(String(error)))
  }

  #onEnd = () => {
    this.#buffer += this.#decoder.end()
    this.#closed = true
    this.#failAll(new Error('runtime stdout closed'))
    this.emit('exit', null)
  }

  #dispatch(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // The runtime owns stdout purity; an unparsable line is a deployment bug,
      // never a reason to tear the bridge down.
      log.warn(`ignoring non-JSON runtime stdout line (${line.length} bytes)`)
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const { id, method, params, result, error } = frame
    if (id !== undefined && method === undefined) {
      const entry = this.#pending.get(id)
      if (entry === undefined) return
      this.#pending.delete(id)
      if (error !== undefined && error !== null) {
        entry.reject(new Error(`runtime error ${error.code ?? ''}: ${error.message ?? 'unknown'}`.trim()))
      } else {
        entry.resolve(result)
      }
      return
    }
    if (typeof method === 'string') this.emit('notification', method, params ?? {})
  }
}

/**
 * Last-resort discovery: a bridge checked out beside the DSH package (as in this
 * workspace) can always find its runtime without relying on PATH.
 * @returns {string | null} absolute path to the DSH `bin.js`.
 */
export function findLocalDsh() {
  const starts = [resolve(import.meta.dirname, '..'), process.cwd()]
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 3; depth += 1) {
      const found = findDshBin(dir)
      if (found !== null) return found
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/**
 * A booted `dsh --profile sdk` runtime: owns the child process, the transport,
 * and the one-time `initialize` handshake.
 */
export class DshRuntime extends EventEmitter {
  #config
  #child = null
  #transport = null
  #initialized = false
  #starting = null
  #stderrTail = []

  /** @param {Record<string, any>} config - the resolved bridge configuration. */
  constructor(config) {
    super()
    this.#config = config
  }

  /** @returns {boolean} whether the runtime answered `initialize`. */
  get ready() {
    return this.#initialized
  }

  /**
   * Spawn the runtime if needed and complete the `initialize` handshake once.
   * @returns {Promise<void>} resolves when prompts may be queued.
   */
  async start() {
    if (this.#initialized) return
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#doStart().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #doStart() {
    const { command, args, cwd, env } = this.#config.dsh
    const childCwd = cwd === '' ? process.cwd() : cwd
    const launch = resolveDshCommand(command)
    if (launch === null) {
      throw new Error(
        `找不到 dsh 可执行文件（${command}）。` +
          '请确认已全局安装 @deepseek-ai/dsh，或在配置里把 dsh.command 写成绝对路径。',
      )
    }
    const argv = [...launch.prefix, ...args]
    log.info(`spawning runtime: ${launch.command} ${argv.join(' ')}  (cwd=${childCwd})`)
    const child = spawn(launch.command, argv, {
      cwd: childCwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    this.#child = child

    child.on('error', (error) => {
      log.error(`cannot start runtime: ${error.message}`)
      this.#initialized = false
      this.emit('down', error)
    })
    child.on('exit', (code, signal) => {
      log.warn(`runtime exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      this.#initialized = false
      this.#transport?.close()
      this.#transport = null
      this.emit('down', new Error(`runtime exited with code ${code ?? 'null'}`))
    })

    // stderr is the runtime's diagnostic channel; keep a rolling tail so a
    // failed handshake can be explained with the runtime's own words.
    const stderrLines = createInterface({ input: child.stderr })
    stderrLines.on('line', (line) => {
      this.#stderrTail.push(line)
      if (this.#stderrTail.length > 40) this.#stderrTail.shift()
      // Runtime diagnostics always reach the operator, even at info level: a
      // dying runtime is exactly when its last words matter.
      log.warn(`runtime stderr: ${line}`)
    })

    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    this.#transport = transport
    transport.on('notification', (method, params) => this.emit('notification', method, params))

    const { provider, model, reasoningEffort, startupTimeoutMs } = this.#config.dsh
    const params = { cwd: childCwd, provider, model }
    if (reasoningEffort !== '' && reasoningEffort !== null) params.reasoningEffort = reasoningEffort
    try {
      const result = await transport.request('initialize', params, startupTimeoutMs)
      this.#initialized = true
      log.info(`runtime ready: ${result?.serverInfo?.name ?? 'unknown'} ${result?.serverInfo?.version ?? ''} route=${provider}/${model}`)
      this.emit('ready')
    } catch (error) {
      const tail = this.#stderrTail.slice(-12).join('\n')
      throw new Error(
        `runtime initialize failed: ${error instanceof Error ? error.message : String(error)}` +
          (tail === '' ? '' : `\n--- runtime stderr tail ---\n${tail}`),
      )
    }
  }

  /**
   * Queue one user turn on a session, creating the session on first use.
   *
   * Images travel as inline encoded blocks; the runtime admits them into its
   * durable attachment store before the message reaches the model, so a
   * screenshot can be part of the prompt.
   *
   * @param {string} sessionId - bridge-owned session id.
   * @param {string} text - the user message text.
   * @param {Array<{ type: 'image', data: string, mimeType: string }>} [attachments] - images to attach.
   * @returns {Promise<string>} the runtime's admission receipt (message id).
   */
  async prompt(sessionId, text, attachments) {
    if (!this.#initialized || this.#transport === null) throw new Error('runtime is not ready')
    const contentBlocks = [{ type: 'text', text }]
    for (const attachment of attachments ?? []) {
      if (attachment?.type !== 'image' || typeof attachment.data !== 'string') continue
      contentBlocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType })
    }
    const result = await this.#transport.request('session/prompt', { sessionId, contentBlocks }, 60000)
    return result?.messageId ?? ''
  }

  /**
   * Shut the runtime down.
   *
   * The SDK app binds stdin EOF to a bounded successful shutdown — the
   * documented client-disconnect path — so closing stdin comes first and a
   * signal is only the escalation. The protocol's own `shutdown` method is
   * deliberately not used: it disposes the root fiber and exits the process
   * before its response can be read, which makes it indistinguishable from a
   * crash and unreliable to wait on.
   */
  async stop() {
    const child = this.#child
    if (child === null) return
    this.#initialized = false
    try {
      child.stdin?.end()
    } catch {
      // stdin is already gone
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const onExit = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        log.warn('runtime did not exit on stdin EOF; killing it')
        child.off('exit', onExit)
        child.kill('SIGKILL')
        resolve()
      }, 10000)
      child.once('exit', onExit)
    })
    this.#transport?.close()
    this.#child = null
    this.#transport = null
  }
}
