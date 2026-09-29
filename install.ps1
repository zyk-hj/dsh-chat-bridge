<#
  聊天桥接 · 一键安装脚本

  作用：
    1. 检查 Node.js 与 dsh 是否可用
    2. 可选：把整个程序复制到指定目录（默认 %LOCALAPPDATA%\DshChatBridge）
    3. 在桌面和开始菜单创建快捷方式（指向「启动聊天桥接.vbs」，双击即用）
    4. 可选：创建开机自启项

  用法（在本目录打开 PowerShell）：
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\DshChatBridge" -AutoStart
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'DshChatBridge'),
  [switch]$AutoStart,
  [switch]$Uninstall,
  [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$launcher = Join-Path $InstallDir '启动聊天桥接.vbs'
$shortcutName = '聊天桥接.lnk'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }

function New-Shortcut([string]$path, [string]$target, [string]$workdir, [string]$icon) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $target
  $shortcut.WorkingDirectory = $workdir
  $shortcut.Description = '把 DSH 智能体接到微信/QQ'
  if ($icon -and (Test-Path $icon)) { $shortcut.IconLocation = $icon }
  $shortcut.Save()
}

if ($Uninstall) {
  Write-Step '卸载'
  Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter $shortcutName -ErrorAction SilentlyContinue | Remove-Item -Force
  Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Filter $shortcutName -ErrorAction SilentlyContinue | Remove-Item -Force
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  Get-ChildItem $startup -Filter $shortcutName -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Ok '已删除桌面、开始菜单和开机自启的快捷方式。'
  Write-Warn2 "程序文件仍在 $InstallDir （如需删除请手动删掉这个目录）。"
  return
}

Write-Step '检查运行环境'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn2 '没有找到 Node.js。请先安装 Node.js 22 或更高版本：https://nodejs.org/'
  exit 1
}
Write-Ok "Node.js $(& node -v)"

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) { Write-Ok "dsh 已安装：$($dsh.Source)" }
else {
  Write-Warn2 '没有找到 dsh。请先安装并登录 DSH，否则智能体无法启动：'
  Write-Warn2 '    npm i -g @deepseek-ai/dsh'
}

# 启动脚本的编码由生成器负责（cmd.exe 按系统代码页解析 .cmd，UTF-8 中文会让它崩掉）。
# 全新检出的目录里可能还没有生成过，这里补一次，避免装完拿到坏的启动器。
$launcherCmd = Join-Path $source '启动窗口模式.cmd'
if (-not (Test-Path $launcherCmd)) {
  Write-Step '生成启动脚本（编码处理）'
  & node (Join-Path $source 'scripts\make-launchers.mjs') | Out-Null
  Write-Ok '已生成。'
}

if (-not $SkipCopy) {
  if ($source -ne $InstallDir) {
    Write-Step "复制程序到 $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    foreach ($item in Get-ChildItem $source -Force) {
      if ($item.Name -in @('.git', 'node_modules', 'bridge.log')) { continue }
      Copy-Item $item.FullName -Destination $InstallDir -Recurse -Force
    }
    Write-Ok '已复制。'
  } else {
    Write-Ok '已在安装目录内，跳过复制。'
  }
} else {
  $InstallDir = $source
  $launcher = Join-Path $InstallDir '启动聊天桥接.vbs'
  Write-Ok '按要求跳过复制，直接使用当前目录。'
}

Write-Step '创建快捷方式'
$icon = Join-Path $InstallDir 'assets\app.ico'
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName) $launcher $InstallDir $icon
New-Shortcut (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$shortcutName") $launcher $InstallDir $icon
Write-Ok '桌面和开始菜单快捷方式已创建（双击「聊天桥接」即可启动窗口）。'

if ($AutoStart) {
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $startup $shortcutName))
  $shortcut.TargetPath = 'wscript.exe'
  $shortcut.Arguments = "`"$launcher`""
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Save()
  Write-Ok '已加入开机自启。'
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "  程序目录：$InstallDir"
Write-Host '  启动方式：双击桌面上的「聊天桥接」，或在开始菜单里搜索它'
Write-Host '  停止服务：程序目录里的「停止服务.cmd」'
Write-Host ''
Write-Host '首次使用请在弹出的控制台里：' -ForegroundColor Cyan
Write-Host '  1) 「模型与密钥」填入 DeepSeek API Key'
Write-Host '  2) 「机器人连接」选择连接方式并保存'
Write-Host '  3) 用手机私聊机器人发一句「你好」'
