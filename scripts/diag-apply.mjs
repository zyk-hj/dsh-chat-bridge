#!/usr/bin/env node
/**
 * Diagnostic for the console's "apply settings" path: boots the live stack, saves
 * a configuration edit, and prints how long each stage took.
 *
 *   node scripts/diag-apply.mjs
 */

import process from 'node:process'
import { BridgeApp } from '../src/bridge-app.mjs'
import { configureLogging, createLogger } from '../src/util.mjs'
import { loadConfig } from '../src/config.mjs'

const log = createLogger('diag')
configureLogging('debug')

const { config, path } = loadConfig('./bridge.config.yaml')
config.web.enabled = false
config.onebot.mode = 'off'
config.dsh.cwd = process.cwd()

const app = new BridgeApp({ config, configPath: path, baseline: structuredClone(config), home: process.env.DSH_HOME ?? '', consoleOnly: true })

const stage = (name, from) => log.info(`>>> ${name}: ${((Date.now() - from) / 1000).toFixed(1)}s`)

let t = Date.now()
await app.start()
stage('启动完成', t)

const probe = setInterval(() => {
  const status = app.status()
  if (status.progress !== null) log.warn(`…… 仍在进行：${status.progress}`)
}, 5000)

t = Date.now()
try {
  const status = await app.saveConfig({ chat: { allowedUsers: [10001], ackOnBusy: false } })
  stage('保存并重启完成', t)
  log.info(`runtimeReady=${status.runtimeReady} transport=${status.transport}`)
} catch (error) {
  log.error('保存失败：', error)
}
clearInterval(probe)

t = Date.now()
await app.stop()
stage('关闭完成', t)
process.exit(0)
