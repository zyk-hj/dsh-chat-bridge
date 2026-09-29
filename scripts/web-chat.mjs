#!/usr/bin/env node
/**
 * Minimal client for the bridge's local test page: stream `/events` and send
 * one message through `/api/send`, then print the transcript.
 *
 *   node scripts/web-chat.mjs "你好"
 */

import process from 'node:process'

const text = process.argv.slice(2).join(' ') || '你好'
const base = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787'

const controller = new AbortController()
const stream = await fetch(`${base}/events`, { signal: controller.signal })
if (!stream.ok) {
  console.error(`cannot subscribe to ${base}/events: HTTP ${stream.status}`)
  process.exit(1)
}

const decoder = new TextDecoder()
let buffer = ''
const consume = async () => {
  for await (const chunk of stream.body) {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const index = buffer.indexOf('\n\n')
      if (index < 0) break
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
      if (line === undefined) continue
      const payload = JSON.parse(line.slice(6))
      if (payload.kind === 'transcript') {
        console.log(`${payload.role === 'user' ? '我' : '机器人'}：${payload.text.replaceAll('\n', '\n        ')}`)
        // Hold the stream open until the real answer arrives; the transient
        // "working on it" note is not the answer.
        if (payload.role !== 'user' && payload.transient !== true) return
      } else if (payload.kind === 'log') {
        console.log(`  · ${payload.text}`)
      }
    }
  }
}

const sender = fetch(`${base}/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
})

const timeout = setTimeout(() => {
  console.error('\n[timeout] 等待回答超时')
  controller.abort()
  process.exit(2)
}, Number(process.env.BRIDGE_TIMEOUT_MS ?? 300000))

console.log(`发送：${text}\n`)
const response = await sender
if (!response.ok) {
  console.error(`send failed: HTTP ${response.status}`)
  process.exit(1)
}
await consume()
clearTimeout(timeout)
controller.abort()
console.log('\n[done]')
process.exit(0)
