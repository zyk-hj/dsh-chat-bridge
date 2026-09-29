/**
 * Diagnostic: boot the SDK runtime, prompt it, and print every notification the
 * runtime pushes. Used to verify the wire assumptions the bridge relies on.
 *
 *   node scripts/diag-events.mjs [--effort low] [--text "…"]
 */

import { DshRuntime } from '../src/dsh-runtime.mjs'
import { defaultConfig, deepMerge } from '../src/config.mjs'

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const config = deepMerge(defaultConfig(), {
  dsh: { cwd: process.cwd(), reasoningEffort: argValue('--effort', 'low') },
  log: { level: 'info' },
})
const runtime = new DshRuntime(config)

const counts = new Map()
const startedAt = Date.now()
runtime.on('notification', (method, params) => {
  counts.set(method, (counts.get(method) ?? 0) + 1)
  const stamp = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  if (method === 'session.event') {
    const event = params.event
    const detail =
      event.type === 'assistant/message'
        ? JSON.stringify(event.data.message.content).slice(0, 300)
        : event.type === 'turn/end'
          ? JSON.stringify(event.data.reason)
          : event.type === 'tool/call'
            ? `${event.data.name} ${String(event.data.arguments).slice(0, 80)}`
            : ''
    console.log(`${stamp} ${params.sessionId} ${event.type} ${detail}`)
    return
  }
  console.log(`${stamp} ${method} ${JSON.stringify(params).slice(0, 200)}`)
})
runtime.on('down', (error) => console.log(`runtime down: ${error.message}`))

await runtime.start()
console.log('--- runtime ready, prompting ---')
await runtime.prompt('diag-session', argValue('--text', '只回复两个字：收到'))
console.log('--- prompt queued, waiting 90s for notifications ---')
await new Promise((resolve) => setTimeout(resolve, 90000))
console.log('--- notification counts ---')
for (const [method, count] of counts) console.log(`${count}  ${method}`)
await runtime.stop()
