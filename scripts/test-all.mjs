#!/usr/bin/env node
/**
 * Run every self-test suite, one after another.
 *
 * Serial on purpose, not by accident: `check-wechat` binds a fixed port (8899)
 * and `console-e2e` starts servers of its own, so running suites in parallel
 * would make them fight over ports and fail for reasons that have nothing to do
 * with the code under test.
 *
 * Each suite decides pass/fail through its exit code. Its last non-empty output
 * line is echoed as the result, the wall-clock time is recorded, and a summary
 * table is printed at the end. Any failure makes this script exit 1.
 *
 *   node scripts/test-all.mjs [--verbose]
 *
 * `--verbose` streams each suite's output as it runs instead of only its last
 * line (the suites read the same flag).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// Resolve everything against this file, so the script works from any directory.
const ROOT = join(import.meta.dirname, '..')

/** The suites, in the order they must run. */
const SUITES = [
  { name: 'smoke', file: 'scripts/smoke.mjs', title: '冒烟测试（基础链路）' },
  { name: 'check-wechat', file: 'scripts/check-wechat.mjs', title: '微信链路（Webhook 入站 / 三种出站策略）' },
  { name: 'check-ilink', file: 'scripts/check-ilink.mjs', title: 'iLink 官方接口协议' },
  { name: 'check-console-ui', file: 'scripts/check-console-ui.mjs', title: '控制台前端资源' },
  { name: 'console-e2e', file: 'scripts/console-e2e.mjs', title: '控制台端到端' },
  { name: 'check-ilink-e2e', file: 'scripts/check-ilink-e2e.mjs', title: 'iLink 端到端收发' },
]

const verbose = process.argv.includes('--verbose')
const forwarded = verbose ? ['--verbose'] : []

/**
 * The line worth showing as a suite's result.
 *
 * Usually that is simply the last non-empty line. Some suites sign off with an
 * advisory hint in full-width parentheses (`smoke` ends with "（加 --e2e …）"),
 * which says nothing about the outcome, so those are skipped — falling back to
 * the raw last line when a suite prints nothing else.
 *
 * @param {string} text - captured output.
 * @returns {string} the result line, trimmed.
 */
function lastLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const meaningful = lines.filter((line) => !/^（.*）$/.test(line))
  return (meaningful.length > 0 ? meaningful : lines).at(-1) ?? ''
}

/**
 * How long one suite may take before it is treated as hung.
 *
 * A suite that never exits used to wedge the whole run with no output at all —
 * which is exactly what a poll loop that does not yield to the timer phase looks
 * like from the outside. A hard ceiling turns that into a named failure.
 */
const SUITE_TIMEOUT_MS = Number(process.env.DSH_TEST_TIMEOUT_MS ?? 180000)

/**
 * Run one suite and wait for it to finish.
 *
 * @param {{ name: string, file: string }} suite - the suite to run.
 * @returns {Promise<{ code: number, last: string }>} exit code and last output line.
 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, suite.file), ...forwarded], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      // Report what it managed to print before hanging: that is usually enough to
      // see which section never came back.
      const where = lastLine(stdout) || lastLine(stderr)
      child.kill()
      finish({
        code: -2,
        last: `超过 ${Math.round(SUITE_TIMEOUT_MS / 1000)} 秒未结束，已终止${where === '' ? '' : `（最后输出：${where}）`}`,
      })
    }, SUITE_TIMEOUT_MS)
    timer.unref?.()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (verbose) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (verbose) process.stderr.write(chunk)
    })
    // `error` fires instead of `close` when the process cannot start at all.
    child.on('error', (error) => {
      finish({ code: -1, last: `无法启动：${error.message}` })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1, last: lastLine(stdout) || lastLine(stderr) || '（没有输出）' })
    })
  })
}

console.log('\n[全部自测]')
console.log(`共 ${SUITES.length} 个套件，串行执行（每个套件都可能独占端口，不能并发）\n`)

const results = []
for (const [index, suite] of SUITES.entries()) {
  console.log(`── [${index + 1}/${SUITES.length}] ${suite.name} — ${suite.title}`)
  const startedAt = Date.now()

  if (!existsSync(join(ROOT, suite.file))) {
    console.log(`   ✗ 套件文件不存在：${suite.file}\n`)
    results.push({ name: suite.name, title: suite.title, last: `套件文件不存在：${suite.file}`, seconds: 0, ok: false })
    continue
  }

  const result = await runSuite(suite)
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1))
  const ok = result.code === 0
  console.log(`   ${ok ? '✓' : '✗'} ${result.last}（${seconds}s）\n`)
  results.push({ name: suite.name, title: suite.title, last: result.last, seconds, ok })
}

const failed = results.filter((entry) => !entry.ok)
const nameWidth = Math.max(...results.map((entry) => entry.name.length))
const secondsWidth = Math.max(...results.map((entry) => `${entry.seconds}s`.length))
const rule = '─'.repeat(nameWidth + secondsWidth + 20)

console.log('汇总')
console.log(rule)
for (const entry of results) {
  const name = entry.name.padEnd(nameWidth)
  const seconds = `${entry.seconds}s`.padStart(secondsWidth)
  console.log(`  ${entry.ok ? '✓' : '✗'} ${name}  ${seconds}  ${entry.title}`)
}
console.log(rule)
console.log(`共 ${results.length} 个套件：${results.length - failed.length} 通过 / ${failed.length} 失败`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((entry) => entry.name).join('、')}`)
  console.log('（加 --verbose 可看到每个套件的完整输出）')
}
console.log('')

process.exit(failed.length === 0 ? 0 : 1)
