# 分发与打包说明

这个程序**没有构建步骤、没有第三方依赖**——`package.json` 的 `dependencies` 是空的，
所有代码都是原生 ES 模块，直接用 Node.js 运行。所以「打包」就是把这个目录整理好交给别人。

---

## 目录

- [给使用者：怎么装](#给使用者怎么装)
- [给分发者：怎么打包](#给分发者怎么打包)
- [两种交付方式](#两种交付方式)
- [运行期依赖](#运行期依赖)
- [卸载](#卸载)
- [打包后的目录结构](#打包后的目录结构)

---

## 给使用者：怎么装

1. 安装 **Node.js 22 或更高版本**（<https://nodejs.org/>，一路下一步即可）。
2. 安装并登录 **DSH**：

   ```powershell
   npm i -g @deepseek-ai/dsh
   ```

3. 解压本程序到任意目录，例如 `D:\DshChatBridge`。
4. 右键 `install.ps1` → **使用 PowerShell 运行**；或在解压目录里执行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   它会把程序复制到 `%LOCALAPPDATA%\DshChatBridge`（可用 `-InstallDir` 改），并在**桌面**和**开始菜单**创建「聊天桥接」快捷方式。

5. 双击桌面上的 **聊天桥接** —— 会静默启动服务，然后弹出一个独立窗口（控制台）。
6. 在控制台里：
   - 「模型与密钥」→ 填入 DeepSeek API Key，保存；
   - 「机器人连接」→ 选连接方式并保存；
   - 用手机私聊机器人发一句「你好」。

可选参数：

```powershell
# 装到指定目录，并加入开机自启
powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\DshChatBridge" -AutoStart

# 不复制文件，只在当前目录建快捷方式（适合就地运行）
powershell -ExecutionPolicy Bypass -File install.ps1 -SkipCopy

# 卸载（删除快捷方式；程序目录保留）
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

> 脚本执行策略如果被阻止，用上面带 `-ExecutionPolicy Bypass` 的命令即可，不需要改系统设置。

---

## 给分发者：怎么打包

```powershell
# 1) 生成图标（如果 assets/app.ico 已存在可跳过）
node scripts/make-icon.mjs

# 2) 生成启动脚本（改了它们的文案就必须重跑，原因见下）
node scripts/make-launchers.mjs

# 3) 自检，确保交付的代码是好的
node scripts/smoke.mjs            # 离线断言，不调用模型
node scripts/console-e2e.mjs      # 控制台全链路（会启动真实运行时，约 30 秒）

# 4) 打 ZIP 包
cd ..
Compress-Archive -Path dsh-chat-bridge -DestinationPath dsh-chat-bridge-0.1.0.zip -Force
```

> **为什么启动脚本是「生成」出来的**：Windows 对编码很敏感，而且是静默出错。
> `cmd.exe` 按**系统代码页**逐行解析 `.cmd`，所以一个带中文注释的 UTF-8 批处理文件在
> 中文系统上会被当成 GBK 读——乱码字节直接变成「命令」，批处理在某一行崩掉，
> 报出 `'浠讹級' 不是内部或外部命令`。而 `chcp 65001` 救不了它：那一行本身也是被误解码
> 之后才被找到的。脚本宿主读 `.vbs` 时只认 UTF-16 LE BOM，Windows PowerShell 5.1 读
> `.ps1` 时只认 UTF-8 BOM。
>
> 所以 `scripts/make-launchers.mjs` 统一负责编码：四个 `.cmd` 写成**纯 ASCII**（中文提示由
> Node 在运行时打印，那走的是控制台代码页，没问题），`.vbs` 写成 UTF-16 LE + BOM，
> `install.ps1` 补上 UTF-8 BOM。生成器最后会自己校验这些性质。
> `install.ps1` 在安装时也会调用一次，所以全新检出的目录不会拿到坏的启动脚本。

打之前建议删掉：`bridge.log`、`bridge.config.yaml`（让使用者拿到的是首次运行的默认配置）、
`.git`、`node_modules`。

`bridge.config.yaml` 里如果写死了你本机的 `dsh.cwd`，交付前请清空：

```yaml
dsh:
  cwd: ''
```

---

## 两种交付方式

| 方式 | 适用 | 代价 |
|---|---|---|
| **便携目录 + 安装脚本**（本仓库现成） | 自己用、给同事、内部分发 | 需要对方装 Node.js |
| **免安装 Node 的便携包** | 给完全不想装环境的人 | 包体约 +80MB；要手动下载 Node |

第二种的做法：从 <https://nodejs.org/dist/> 下载 `node-v22.x.x-win-x64.zip`，把其中的
`node.exe` 放到本程序目录下（和 `启动窗口模式.cmd` 同级），然后把三个启动脚本里的
`node` 改成 `"%~dp0node.exe"`。`scripts/launch.mjs` 用的是 `process.execPath`，会自动
跟着走。这样对方解压即用。

暂时**没有**提供单文件 `.exe`：Node 的 SEA 打包无法可靠地把 `dsh` 子进程和它的
profile 目录（`~/.dsh`）一起装进去，做出来会是一个「看起来独立、实际仍然依赖 dsh」的
假独立程序，反而不如现在这样诚实。

---

## 运行期依赖

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| Node.js ≥ 22 | 必需 | 需要全局 `WebSocket`、`fetch`、`AbortSignal.timeout` |
| `@deepseek-ai/dsh` | 必需 | 智能体运行时；程序会用 `dsh --profile sdk` 启动它 |
| DeepSeek API Key | 必需 | 在控制台或 DSH 里配置 |
| NapCat 等 OneBot 实现 | 接真实微信/QQ 时必需 | 不装也能用内置聊天页测试 |
| Microsoft Edge / Chrome | 可选 | 只用于把控制台开成独立窗口；没有就用默认浏览器打开标签页 |

程序查找 `dsh` 的顺序：配置里的 `dsh.command` → PATH → npm/pnpm 全局目录
（含 `%APPDATA%\npm`）→ 本程序附近的 DSH 检出。找不到时控制台「状态」页会显示
「dsh 未找到」并给出提示。

---

## 卸载

1. 运行安装目录里的 `停止服务.cmd`（或直接结束 node 进程）。
2. 运行 `install.ps1 -Uninstall` 删除快捷方式。
3. 手动删除程序目录（默认 `%LOCALAPPDATA%\DshChatBridge`）。
4. 控制台生成的窗口配置目录可以一并删除：`%LOCALAPPDATA%\dsh-chat-bridge`。
5. 程序的配置和日志都在程序目录里，不会写到别处；API Key 存在 DSH 自己的
   `~/.dsh/.credentials.yaml`，如需清理请在 DSH 里操作或删除对应行。

---

## 打包后的目录结构

```text
dsh-chat-bridge/
├─ 启动窗口模式.cmd      ← 双击：启动 + 打开控制台窗口
├─ 启动聊天桥接.vbs      ← 双击：静默启动（无黑框）
├─ 启动服务.cmd          ← 只启动服务，不开窗口
├─ 停止服务.cmd          ← 停止
├─ install.ps1           ← 一键安装（快捷方式 / 开机自启）
├─ bridge.config.yaml    ← 配置（控制台会自动读写；含中文注释）
├─ bridge.log            ← 运行日志（首次运行后生成）
├─ package.json
├─ README.md             ← 使用说明
├─ PACKAGING.md          ← 本文件
├─ assets/
│  └─ app.ico            ← 快捷方式图标（由 scripts/make-icon.mjs 生成）
├─ scripts/
│  ├─ launch.mjs         ← 启动器：等就绪后再开窗口
│  ├─ make-icon.mjs      ← 生成图标
│  ├─ smoke.mjs          ← 自检（离线 + --e2e）
│  ├─ console-e2e.mjs    ← 控制台端到端自检
│  ├─ web-chat.mjs       ← 命令行聊天客户端
│  ├─ diag-events.mjs    ← 会话事件诊断
│  └─ diag-apply.mjs     ← 「应用设置」耗时诊断
└─ src/
   ├─ index.mjs          ← 入口：命令行、启动编排
   ├─ bridge-app.mjs     ← 应用层：运行时可重建、配置与凭据读写
   ├─ web-server.mjs     ← HTTP：聊天页 / 控制台 / 管理 API / SSE
   ├─ console-page.mjs   ← 控制台界面（单文件，无外部资源）
   ├─ chat-page.mjs      ← 聊天测试页
   ├─ chat-gateway.mjs   ← 网关：CQ 解析、命令、白名单、分片
   ├─ conversation.mjs   ← 会话与回合管理
   ├─ dsh-runtime.mjs    ← DSH SDK 运行时客户端（stdio JSON-RPC）
   ├─ onebot.mjs         ← OneBot V11 传输（反向/正向 WS、HTTP）
   ├─ config.mjs         ← 配置模型与校验
   ├─ yaml.mjs           ← 极简 YAML 读写
   └─ util.mjs           ← 日志、分片、CQ 转义
```
