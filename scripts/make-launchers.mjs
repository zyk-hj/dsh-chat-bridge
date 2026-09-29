#!/usr/bin/env node
/**
 * Generate the Windows double-click launchers with the encoding each one needs.
 *
 * This exists because Windows is encoding-sensitive in a way that silently
 * breaks a launcher:
 *
 *   - `cmd.exe` parses a .cmd file byte by byte using the *system* code page. A
 *     UTF-8 file with Chinese comments is read as GBK, so a stray byte pair
 *     becomes a "command" and the batch file dies with `'浠讹級' 不是内部或外部命令`.
 *     A `chcp 65001` line cannot save it: the rest of the line was already
 *     mis-decoded while locating it. So the .cmd files here are pure ASCII, and
 *     the Chinese the user reads comes from Node at run time.
 *   - The script host reads a .vbs file as ANSI unless it carries a UTF-16 LE BOM,
 *     so a Chinese MsgBox needs exactly that encoding.
 *   - Windows PowerShell 5.1 reads a .ps1 file as ANSI unless it has a UTF-8 BOM,
 *     which would corrupt every Chinese message in install.ps1.
 *
 * Encoding is therefore a build step, not a detail: run this after editing the
 * strings below, and `install.ps1` runs it again so a fresh checkout is safe.
 *
 *   node scripts/make-launchers.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** ASCII-only batch file: safe under any console code page. */
const START_WINDOW = `@echo off
rem ============================================================
rem  dsh-chat-bridge - start the bridge and open the console
rem  (ASCII only on purpose: see scripts/make-launchers.mjs)
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

node "scripts/launch.mjs" %*
if errorlevel 1 goto :failed
endlocal
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js was not found on PATH.
echo   Install Node.js 22 or newer: https://nodejs.org/
call :maybe_pause
endlocal
exit /b 1

:failed
echo.
echo   Startup failed. See bridge.log in this folder,
echo   or run the troubleshooting launcher to watch the output.
call :maybe_pause
endlocal
exit /b 1

rem Wait for a key only when a human is watching; when the output is redirected
rem or piped (automation, CI, a script calling us) waiting would hang forever.
:maybe_pause
set "_interactive=1"
2>nul (set /p =<nul) || set "_interactive="
if defined _interactive pause
exit /b 0
`

/** Start the service only, no window. */
const START_SERVICE = `@echo off
rem Start the bridge service in the background (no console window).
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 22 or newer.
  pause
  endlocal
  exit /b 1
)

node "scripts/launch.mjs" --no-window
endlocal
`

/** Run the service in the foreground so errors stay visible. */
const START_VERBOSE = `@echo off
rem Run the bridge in the foreground so every message stays on screen.
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 22 or newer.
  pause
  endlocal
  exit /b 1
)

echo Starting dsh-chat-bridge in the foreground. Press Ctrl+C to stop.
echo.
node "src/index.mjs" %*
echo.
echo The service has stopped.
pause
endlocal
`

/** Stop whatever is listening on the console port. */
const STOP_SERVICE = `@echo off
rem Stop the running bridge (whatever listens on the console port).
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"
node "scripts/launch.mjs" --kill
echo.
endlocal
`

/**
 * The VBS launcher, in Chinese: written as UTF-16 LE with a BOM so the script
 * host decodes it correctly, and it stays silent (no console flash).
 */
const SILENT_VBS = `' ============================================================
'  聊天桥接 · 静默启动（双击不弹黑框，随后打开控制台窗口）
'  需要 Node.js 22+ 已安装并在 PATH 中。
' ============================================================
Option Explicit

Dim shell, fso, root, script, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = root & "\\scripts\\launch.mjs"

If Not fso.FileExists(script) Then
  MsgBox "找不到 " & script & vbCrLf & "请确认文件完整。", 16, "聊天桥接"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
' 0 = 隐藏窗口；True = 等待退出码，这样启动失败时能提示
command = "cmd /c node """"" & script & """"""
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  MsgBox "启动失败（退出码 " & exitCode & "）。" & vbCrLf & vbCrLf & _
         "请查看 bridge.log，或双击「启动窗口模式.cmd」查看详细错误。", 16, "聊天桥接"
End If
`

/**
 * Encode a string as GBK when the platform can do it, otherwise fall back to
 * UTF-8. Used only to report what happened; the launchers themselves are ASCII
 * or UTF-16 and never depend on this.
 * @param {string} text - text to encode.
 * @returns {Buffer} encoded bytes.
 */
function encodeForConsole(text) {
  try {
    return Buffer.from(new TextEncoder().encode(text))
  } catch {
    return Buffer.from(text, 'utf8')
  }
}

/** UTF-16 LE with BOM, the only encoding the script host decodes reliably. */
function toUtf16Le(text) {
  const body = Buffer.from(text, 'utf16le')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body])
}

const written = []
/** @param {string} name - file name. @param {Buffer|string} content - bytes. */
function emit(name, content) {
  const path = join(root, name)
  writeFileSync(path, content, typeof content === 'string' ? 'utf8' : undefined)
  written.push(`${name}  ${(typeof content === 'string' ? Buffer.byteLength(content) : content.length)} bytes`)
}

emit('启动窗口模式.cmd', START_WINDOW)
emit('启动服务.cmd', START_SERVICE)
emit('排错运行.cmd', START_VERBOSE)
emit('停止服务.cmd', STOP_SERVICE)
emit('启动聊天桥接.vbs', toUtf16Le(SILENT_VBS))
// The installer is full of Chinese messages, so it needs a UTF-8 BOM for
// Windows PowerShell 5.1 to read it as UTF-8 instead of the system code page.
const installer = readFileSync(join(root, 'install.ps1'), 'utf8').replace(/^\uFEFF/, '')
emit('install.ps1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(installer, 'utf8')]))

console.log('已生成启动脚本：')
for (const line of written) console.log(`  ${line}`)

// Prove the property that matters: no launcher cmd.exe might parse contains a
// byte above 0x7F, and the VBS carries its BOM.
for (const name of ['启动窗口模式.cmd', '启动服务.cmd', '排错运行.cmd', '停止服务.cmd']) {
  const bytes = readFileSync(join(root, name))
  const offending = bytes.findIndex((byte) => byte > 0x7f)
  if (offending >= 0) {
    console.error(`  错误：${name} 在偏移 ${offending} 处含非 ASCII 字节：${encodeForConsole(name).toString('hex')}`)
    process.exitCode = 1
  }
}
const vbs = readFileSync(join(root, '启动聊天桥接.vbs'))
if (vbs[0] !== 0xff || vbs[1] !== 0xfe) {
  console.error('  错误：启动聊天桥接.vbs 缺少 UTF-16 LE BOM')
  process.exitCode = 1
}
if (process.exitCode !== 1) console.log('校验通过：四个 .cmd 均为纯 ASCII，.vbs 带 UTF-16 LE BOM。')
if (!existsSync(join(root, 'scripts', 'launch.mjs'))) {
  console.error('  错误：找不到 scripts/launch.mjs')
  process.exitCode = 1
}
