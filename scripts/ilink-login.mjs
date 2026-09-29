#!/usr/bin/env node
/**
 * Scan-to-login for the WeChat iLink Bot API.
 *
 * Asks the iLink gateway for a QR session, opens the page that renders the code
 * in the default browser, then waits for the phone to confirm. On success the
 * bearer token is written to `ilink-account.json`, which is what the bridge reads
 * on startup.
 *
 *   node scripts/ilink-login.mjs
 *   node scripts/ilink-login.mjs --out D:\path\ilink-account.json
 *   node scripts/ilink-login.mjs --base https://ilinkai.weixin.qq.com --no-open
 *
 * The token is a full credential: anyone holding it can send messages as the
 * bot. Treat the file like a password.
 */

import { resolve } from 'node:path'
import { ILINK_DEFAULT_BASE_URL } from '../src/wechat-ilink.mjs'
import { describeIlinkError, runIlinkLogin } from '../src/ilink-login.mjs'

/**
 * Parse `--flag value` pairs, falling back to a default.
 *
 * @param {string[]} argv - process arguments.
 * @param {string} flag - flag name without dashes.
 * @param {string} fallback - value used when the flag is absent.
 * @returns {string} the resolved value.
 */
function option(argv, flag, fallback) {
  const index = argv.indexOf(`--${flag}`)
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1]
  return fallback
}

const argv = process.argv.slice(2)
const outPath = resolve(option(argv, 'out', 'ilink-account.json'))
const baseUrl = option(argv, 'base', ILINK_DEFAULT_BASE_URL)

console.log('微信 iLink Bot 扫码登录')
console.log(`接口地址：${baseUrl}`)
console.log(`凭据文件：${outPath}`)
console.log('')

try {
  const account = await runIlinkLogin({
    statePath: outPath,
    baseUrl,
    timeoutMs: Number(option(argv, 'timeout', '480000')),
    openBrowser: !argv.includes('--no-open'),
    onQrCode: ({ url, attempt }) => {
      console.log(attempt > 1 ? `二维码已刷新（第 ${attempt} 次）：` : '请用手机微信扫描下面这个链接里的二维码：')
      console.log(`  ${url}`)
      console.log('  （已尝试用默认浏览器打开该链接）')
      console.log('')
    },
    onStatus: (status, detail) => {
      if (status === 'scaned') console.log('已扫码，请在手机上点击确认…')
      else if (status === 'scaned_but_redirect') console.log(`服务器要求换到 ${detail?.redirectHost} 继续查询…`)
      else if (status === 'need_verifycode') console.log('配对码不对，请重新输入…')
    },
  })

  console.log('登录成功。')
  console.log(`  机器人账号：${account.userId || '(未返回)'}`)
  console.log(`  接口地址：${account.baseUrl}`)
  console.log(`  凭据已写入 ${account.savedTo}`)
  console.log('')
  console.log('下一步：在微信里找到这个机器人（它会作为一个联系人出现），给它发消息即可。')
  process.exit(0)
} catch (error) {
  console.error(`登录失败：${describeIlinkError(error)}`)
  process.exit(1)
}
