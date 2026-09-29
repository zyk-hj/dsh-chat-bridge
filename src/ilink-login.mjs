/**
 * Interactive QR login for the WeChat iLink Bot API.
 *
 * Shared by `node src/index.mjs --ilink-login` and `scripts/ilink-login.mjs` so
 * there is exactly one implementation of the flow, and by the console, which
 * passes its own callbacks to stream the QR into the browser instead of a
 * terminal.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ILINK_DEFAULT_BASE_URL, IlinkError, loginWithQrCode, writeAccount } from './wechat-ilink.mjs'

/**
 * Ask the operator to read the pairing code WeChat is showing on their phone.
 *
 * The gateway interposes this challenge on some accounts: the phone displays
 * digits and nothing proceeds until the client echoes them back.
 *
 * @param {string} question - the prompt to show.
 * @returns {Promise<string>} what the operator typed, trimmed.
 */
export function askForPairingCode(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(String(answer ?? '').trim())
    })
  })
}

/**
 * Open a URL in the machine's default browser.
 *
 * @param {string} url - page to open.
 * @returns {boolean} whether a launcher was spawned.
 */
export function openInBrowser(url) {
  if (typeof url !== 'string' || url === '') return false
  const target =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }
  try {
    spawn(target.file, target.args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * Run a complete QR login and store the resulting credentials.
 *
 * `onQrCode` fires again whenever the gateway expires a code and a fresh one is
 * issued, so a caller that renders the code must be prepared to replace it.
 *
 * @param {{ statePath: string, baseUrl?: string, timeoutMs?: number, openBrowser?: boolean, interactive?: boolean, onQrCode?: (info: { qrcode: string, url: string, attempt: number }) => void, onStatus?: (status: string, detail?: { redirectHost?: string }) => void, onVerifyCode?: (info: { attempt: number }) => Promise<string> | string }} options - login options.
 * @returns {Promise<{ token: string, userId: string, botId: string, baseUrl: string, alreadyBound: boolean, qrUrl: string, savedTo: string }>} the stored account.
 */
export async function runIlinkLogin(options) {
  const baseUrl = String(options.baseUrl ?? ILINK_DEFAULT_BASE_URL)
  let opened = false
  // Without a terminal to type into, prompting would hang forever; say so instead.
  const onVerifyCode =
    options.onVerifyCode ??
    (options.interactive === false
      ? undefined
      : async () => askForPairingCode('微信手机上显示了一串配对码，请在这里输入：'))
  const account = await loginWithQrCode({
    baseUrl,
    timeoutMs: options.timeoutMs,
    onQrCode: (info) => {
      if (options.openBrowser === true && !opened) {
        opened = openInBrowser(info.url)
      }
      options.onQrCode?.(info)
    },
    onStatus: options.onStatus,
    onVerifyCode,
  })
  // `binded_redirect` carries no token: the scan is already satisfied by the
  // credentials on disk, so leave those alone.
  if (account.alreadyBound === true || account.token === '') {
    return { ...account, savedTo: options.statePath }
  }
  writeAccount(options.statePath, { ...account, savedAt: new Date().toISOString() })
  return { ...account, savedTo: options.statePath }
}

/**
 * Describe a login failure in one line, including the re-scan hint when the
 * credential simply went stale.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string} a user-facing message.
 */
export function describeIlinkError(error) {
  if (error instanceof IlinkError) {
    return error.sessionExpired ? `${error.message}（登录已失效，需要重新扫码）` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}
