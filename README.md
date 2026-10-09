# dsh-chat-bridge

> **v0.1.0** · 微信主线：腾讯官方 **iLink Bot**（已扫码绑定、双向实测通过）· QQ 侧：OneBot V11（代码完整，默认暂停）· **零运行时依赖**（没有 `dependencies`，只用 Node 内置能力）· 要求 Node.js ≥ 22
>
> 变更记录见 [CHANGELOG.md](CHANGELOG.md)。

把 **DeepSeek Harness 智能体**接到微信 / QQ 上：你在手机里发消息，本机这个桥接服务把它交给一个真正带工具（读写文件、跑命令、搜索、子智能体…）的 DSH 智能体，再把回答发回聊天窗口。

```text
微信客户端                          QQ 客户端
   ▲ ▼                                 ▲ ▼
 iLink Bot（微信官方接口）        NapCat 等 OneBot 实现
   ▲ ▼  长轮询收 / HTTP 发             ▲ ▼  OneBot V11（WebSocket / HTTP）
   │                                   │
   └──────────────┬────────────────────┘
                  ▼
          dsh-chat-bridge          ← 本服务：会话管理、分片、命令、错误兜底
                  ▲ ▼  JSON-RPC over stdio
          dsh --profile wechat       ← DSH 运行时：智能体、工具、持久化（代码默认 sdk）
                  ▲ ▼
            模型（默认 deepseek-flash）
```

两条路线可以同时开：QQ 侧走 OneBot（本地机器人圈子最通用的接口，NapCat / Lagrange / LLOneBot / go-cqhttp 都支持），微信侧走**腾讯官方的 iLink Bot 接口**——扫码绑定后它就是你微信里的一个联系人。

微信侧曾经有四条别的路（注入 DLL、UI 自动化、模拟键鼠、读本地数据库），**都实测走死了，代码与依赖已全部删除**，原因见[下面那张表](#为什么只剩这一条路另外四条都实测走死了)。

## 目录

- [快速开始](#快速开始)
- [可视化控制台](#可视化控制台)
- [接微信（个人号）](#接微信个人号)
  - [能力与边界](#能力与边界先看这张表比看文档快)
  - [为什么只剩这一条路](#为什么只剩这一条路另外四条都实测走死了)
  - [第 1 步：扫码绑定](#第-1-步扫码绑定)
  - [第 2 步：先给它发一条消息](#第-2-步先给它发一条消息)
  - [出站策略](#出站策略) · [入站策略](#入站策略) · [已知限制](#已知限制)
  - [媒体：收图片 / 文件](#媒体收图片--文件) · [收发文件：把文件发到你手机上](#收发文件把文件发到你手机上)
  - [Webhook：接你自己的消息源](#webhook接你自己的消息源)
- [接 QQ](#接-qq)
- [聊天里能用的命令](#聊天里能用的命令)
- [配置说明](#配置说明)
- [安装与分发](#安装与分发)
- [工作原理](#工作原理)
- [自检与排错](#自检与排错)

## 快速开始

要求：Node.js ≥ 22、已安装并能正常使用的 `dsh`。

**最省事的方式**：双击 **`启动窗口模式.cmd`** —— 它会启动服务、等到真正就绪，然后以独立窗口打开控制台。之后在控制台里填 API Key、选连接方式即可，不用碰命令行。

**想用命令行**：

```powershell
cd <你解压出来的目录>\dsh-chat-bridge

node scripts/smoke.mjs         # 离线自检：纯逻辑，不调用模型
node src/index.mjs             # 启动服务（自动生成/读取 ./bridge.config.yaml）
```

启动后日志会给出两个地址：

```text
INFO [web] 控制台与聊天页：http://127.0.0.1:8787
INFO [sdk] runtime ready: deepseek-harness-sdk-runtime 0.0.1 route=deepseek-official/deepseek-flash
```

| 地址 | 用途 |
|---|---|
| <http://127.0.0.1:8787/console> | **控制台**：看状态、改配置、填密钥、测连通性 |
| <http://127.0.0.1:8787> | **聊天页**：和真实消息走同一条管线，用来先验证链路 |

聊天页和真实微信/QQ 消息经过的是同一个网关、同一个会话池、同一个运行时，所以它验证通过就说明接线后行为一致——唯一区别是它不经过网络层。

## 可视化控制台

控制台就是那个「窗口」，分六个面板（和页面顶部的标签页一一对应）：

| 面板 | 能做什么 |
|---|---|
| **状态** | 运行时/机器人连接指示灯、会话数、运行时长、`dsh` 是否找到；一键**重启智能体运行时**、**重连机器人**、**测试模型连通性**、打开聊天窗口 |
| **模型与密钥** | 服务商、模型名、推理强度、单条超时；**填写或清除 DeepSeek API Key**（保存后自动重启运行时生效） |
| **微信** | 微信路线开关与发送开关、收/发方式、**iLink 扫码登录**与连接自检、机器人昵称、Webhook 入站参数、外部命令/HTTP 出站、会话→显示名映射 |
| **QQ / OneBot** | 智能体工作目录；OneBot 四种接线方式的全部参数（模式、地址、令牌、监听主机与端口、HTTP API） |
| **聊天设置** | 回复长度、上下文上限、单条入站上限、备用会话数、群聊 @ 规则、引用回复、**QQ/群白名单**，以及本控制台的端口与监听地址 |
| **运行日志** | 实时日志流（含工具调用进度与微信收发记录），排查问题时不用回命令行 |

底层是一组本地 HTTP 接口，界面只是它的前端，你也能直接调用：

| 接口 | 作用 |
|---|---|
| `GET /api/health` · `GET /api/status` | 健康检查 / 状态快照（含重启进度、微信连接状态、发送凭证状态） |
| `GET /api/config` · `POST /api/config` | 读配置 / **写盘并热重启**（可以只提交改动的分组，缺的字段从默认值补） |
| `POST /api/credentials` | 保存或清除 API Key |
| `POST /api/runtime/restart` · `POST /api/runtime/test` | 重启运行时 / 用临时运行时探测模型 |
| `POST /api/bot/reconnect` | 重连机器人（OneBot 与微信都会重建） |
| `GET /api/wechat/status` · `POST /api/wechat/probe` | 微信链路状态 / 探测发送通道（不真的发消息） |
| `GET /api/wechat/ilink/login` · `POST /api/wechat/ilink/login` | 读扫码进度 / 开始或继续扫码（空 body 表示开始，`{verifyCode}` 提交配对码；重复调用复用同一次登录） |
| `POST /api/workspace/check` | 检查候选的智能体工作目录（DSH 授权是否可用 + 真实写入测试） |
| `POST /api/send` | 聊天页用的入口：`{text}` 走和真实消息同一条管线，返回 `202` |
| `GET /api/logs` · `GET /events` | 日志缓冲 / 实时事件流（SSE） |

几点实现上的取舍，值得知道：

- **控制台只监听 `127.0.0.1`**。它没有账号密码，能打开它的人就能让智能体在你机器上干活；改成其他地址时启动日志会明确警告。
- **命令行参数不会被写进配置文件**。`--port 8791` 只影响这一次运行；从控制台保存时写的是文件里原本的值加上你的编辑，所以临时参数不会变成永久配置。
- **API Key 只改一行**。它存在 DSH 的 `~/.dsh/.credentials.yaml` 里，控制台定位到 `refs.` 下的那一行做替换，harness 的其他记录和格式原样保留（有回归测试钉着）。
- **改端口需要手动重启**：服务没法自己重启自己的监听端口。


## 接微信（个人号）

走**微信官方的 iLink Bot 接口**（产品名「微信 ClawBot 插件」，域名 `ilinkai.weixin.qq.com`）。扫码绑定后，它作为**一个普通联系人**出现在你的微信里，你直接跟它对话——官方接口，不注入、不解密、没有封号风险。

### 能力与边界（先看这张表，比看文档快）

| | |
|---|---|
| ✅ **能** | 私聊收发文本；收图片/文件（见[媒体](#媒体收图片--文件)）；**把本机的图片/文件作为真附件发给你**（见[收发文件](#收发文件把文件发到你手机上)）；消息只在你和腾讯之间，不经第三方 |
| ❌ **不能** | **群聊**——iLink 只支持一对一；**主动推送**——它只能回复你，不能自己找你 |
| ⚠️ **坑** | **长消息 / 连续多条可能静默失败**：腾讯返回 `ret=0`，但你手机上什么都没有 |

最后一条不是推测：[openclaw#79293](https://github.com/openclaw/openclaw/issues/79293)（P1、label 为 message-loss）原文是 "Longer messages and/or rapid multi-part sends can fail at the user-visible layer while OpenClaw still returns success"。所以本桥接在 iLink 上**不切块连发**，只发单条短回复，并且日志说的是「已提交网关」而不是「已送达」——`ret=0` 只代表腾讯受理了，不代表你收到了。

### 为什么只剩这一条路（另外四条都实测走死了）

| 路线 | 为什么删掉 |
|---|---|
| **wcferry**（注入 DLL） | 它只认微信 3.9.12.17，而腾讯服务端**已经不让这个版本登录**。我录到了完整过程：扫码成功 → 手机确认 → 客户端显示「正在进入..」→ 服务端最后一步踢回「**当前微信版本过低，请升级至最新版本。**」。把内存里的版本号（6 处 4 字节常量 + 77 处 ASCII + 52 处 UTF-16 字符串）全改成 4.1.13.65 也无效——服务端不看你内存里写了什么。上游仓库已归档。 |
| **uia**（UI 自动化） | 微信 4.x 整站自绘：主窗口在 UIAutomation 下只有 **3 个元素**，MSAA 内容面板 **0 个子元素**。既没有搜索框也没有输入框可以定位。 |
| **模拟键鼠** | 真机打了 4 次，只有第 1 次真的送达，之后 3 次**都报成功而一条没到**：微信的搜索面板会把主窗口从 896 撑到 1340，按窗口比例算出的输入框坐标就落到聊天区外面了，脚本却照常退出码 0。 |
| **读本地数据库解密** | 技术可行但法律风险真实：标杆项目 [chatlog](https://github.com/sjzar/chatlog) 已因腾讯法务函于 2025-10-20 整库删除。 |

代码里这些路线已经全部删除（连工具脚本和 npm 依赖一起）。为什么不保留「反正不用就行」：它们每一个都会**报成功却什么都没做**，留着只会浪费下一个人一天时间去查。

### 第 1 步：扫码绑定

**前提**：手机微信 **≥ 8.0.70**，且账号已被灰度到 ClawBot。检查方法：微信 → **我 → 设置 → 插件**，看有没有「**微信 ClawBot**」。列表为空就先从后台**彻底杀掉微信**（不是最小化）再重开。

```bash
node src/index.mjs --ilink-login          # 或控制台「微信」页点「扫码登录」
```

拿到的是**一个链接**（不是图片）。**必须在微信里打开它**——这是整件事最容易做错的一步：

- ① 手机上「我 → 设置 → 插件 → 微信 ClawBot」进入机器人入口；或
- ② 把链接发到**文件传输助手**，在手机上点开（推荐，最快）

然后微信弹出确认页 → 点绿色「**连接**」。

> ⚠️ **不要用微信通用的「扫一扫」去扫这个链接生成的二维码。**
> 那会把 `liteapp.weixin.qq.com` 当成「轻应用」丢进小程序容器，结果是整页加载失败：红色感叹号 + 「**网络错误 / 请稍后再试**」。而服务端**永远收不到扫码事件**，你只会看到状态一直停在 `wait`。我就是这么卡了很久，最后是靠读[官方接入指南](https://github.com/DjangoPeng/agentic-ai/blob/main/openclaw-im/wechat-clawbot.md)才发现的。

> 二维码有时效（约一两分钟）。服务端报 `expired` 时客户端会自动换一张并打印**新链接**——一定要用最新那条，扫旧的就是上面那个错误页。

**登录状态**存进 `wechat.ilink.statePath`（默认 `ilink-account.json`），里面有 `token` / `userId` / `botId`。**这个 token 等同于密码**，能直接以机器人身份发消息；它已经在 `.gitignore` 里，别提交、别外传。

### 第 2 步：先给它发一条消息

绑定成功后它只是你的一个普通联系人，**发送凭证（`context_token`）要等你先发一条消息才会解锁**。在那之前控制台显示「未登录 / 不可用」是正常的——这不是 bug，是 iLink 的设计：**机器人只能被动回复，不能主动找你**。

这也是为什么「主动给你推送通知」这类需求在 iLink 上做不到。

### 第 3 步：开聊

```yaml
wechat:
  enabled: true
  inbound: ilink            # 收：官方接口长轮询
  sendEnabled: true
  sendStrategy: ilink       # 发：同一个官方接口
  ilink:
    statePath: 'ilink-account.json'
```

配置完在控制台点「应用并重启」。之后你在微信里发什么，就是发给这台机器上的智能体。

### 出站策略

| 策略 | 说明 |
|---|---|
| `ilink` | 走同一个官方接口回消息。**推荐**，不需要任何额外程序，也是唯一能发图片/文件的方式。 |
| `command` | 调你自己的发送脚本：桥接把「收件人 正文」作为最后两个参数传入，读 stdout；非零退出码算失败。 |
| `http` | POST `{recipient,text,peerId}` 到你自己的接口。 |

（另有一条官方路线之外的选择：入站用 `webhook`，让任何能读到微信消息的工具 POST 过来。见下。）

### 入站策略

| 策略 | 说明 |
|---|---|
| `ilink` | 官方接口长轮询 `getupdates`，默认 hold 住 40 秒（`wechat.ilink.pollTimeoutMs`），服务端可能自行调短。**推荐**。 |
| `webhook` | 本服务监听一个 HTTP 端口，任何工具都能往里 POST。当你想接自己的消息源时用。 |
| `none` | 只发不收。 |

### 已知限制

- **只有私聊**：iLink 机器人不支持群聊，所以 `wechat.botNicknames` 的 @ 判断实际用不上。
- **不能主动推送**：只能回复。`context_token` 过期后需要你再发一条消息来「续期」，控制台会显示凭证状态。
- **长消息 / 连发会静默失败**：所以 iLink 上**只发一条**，单条上限 900 字（`ILINK_MAX_REPLY_CHARS`）；
  超出时在段落边界截断，并在消息里注明「后续约 N 字已省略」，绝不切块连发。
  `chat.maxReplyChars` 只能把上限压得更低（实际阈值取两者的较小值），压不过传输层的 900。
- **收文件是尽力而为**：CDN 取不到或解密失败时只留占位文本（`[图片]` / `[文件] <名字>`），消息本身不会丢。
- **下行通道历史上出过故障**：2026-08-26 起有多个账号报下行消息被全量静默丢弃，而上行正常（[腾讯云 2212822](https://cloud.tencent.cn/developer/ask/2212822)）。如果突然「发出去没反应」而上行日志正常，先怀疑腾讯那一侧，不要反复重扫。
- **会话过期**：日志出现 `errcode -14` 就是登录失效，重新扫码即可。控制台的「检查 iLink 连接」会直接告诉你。

### 媒体：收图片 / 文件

iLink 把图片和文件放在腾讯 CDN 上，用 AES-128-ECB 加密，协议里给的是 CDN 引用而不是本地路径。收到非文本消息时，桥接会尽量把内容取回来交给智能体：

- **图片**作为内联附件交给模型（它真的能「看见」这张图）；MIME 类型不被支持时只保留占位符。
- **文件**下载到本地（`wechat.ilink.mediaDir`，留空用系统临时目录），并把路径写进消息内容里，
  智能体可以用它读取、分析，或者再用下面的标记原样发回给你。
- **取不到就降级成占位文本**（`[图片]`、`[文件] xxx.pdf`、`[语音] <转写>`、`[视频]`），不会因此丢消息或报错。
- 单件上限 20 MB（`wechat.ilink.maxBytes`），单件下载超时 `wechat.ilink.mediaTimeoutMs`（默认 20 秒）。

### 收发文件：把文件发到你手机上

智能体在回答里**单独写一行** `[[send-file: <完整路径>]]`，桥接会把这一行从正文里删掉、把文件加密上传到腾讯 CDN，再作为**真正的微信附件**发给你——不是链接，也不是把文件内容粘在聊天里。

```text
报告生成好了，一共 12 页。
[[send-file: D:\my-project\report.pdf]]
```

- **图片和文件都支持**：`png` / `jpg` / `jpeg` / `gif` / `webp` 走图片通道，其余扩展名走文件通道（PDF、表格、压缩包、代码都行）。
- **一个文件一行标记**，路径写全（绝对路径最稳）；同一个文件重复写也只发一次。
- **上限 20 MB**：单个文件超过 `wechat.ilink.uploadMaxBytes`（默认 `20971520` 字节）会被拒绝，并说明它有多大、超了多少。
- **失败不吞正文**：文件不存在、是空文件（0 字节）、超限、上传被拒……正文照常发出，随后补一条「附件发送失败：<可操作的原因>」。
- **只有 `ilink` 能发文件**：`command` / `http` 是纯文本通道，这时会回一句说明，并告诉你文件在本机的哪个路径。
- **送达语义和文本一致**：上传成功也只说「文件已提交给网关（送达未确认）」。
- ⚠️ **前提是模型知道这个约定**：本项目随附的 `bridge.config.yaml` 用 `dsh --profile wechat`，那个人格里写了 `[[send-file: …]]` 规则；
  换成默认的 `--profile sdk` 或别的 profile，模型不知道这个标记，文件永远不会发出去（见[运行时怎么起](#运行时怎么起)）。

### Webhook：接你自己的消息源

如果 iLink 满足不了（比如你需要群聊），可以让任何能读到微信消息的工具把消息 POST 给本服务，出站继续用 `ilink` 或你自己的脚本：

```yaml
wechat:
  enabled: true
  inbound: webhook
  webhook:
    host: 127.0.0.1        # 除非你清楚后果，否则别改成 0.0.0.0
    port: 8788
    path: /message
    token: '自己设一个随机串'  # 监听非本机地址时必填，否则任何人都能让智能体执行操作
  sendEnabled: true
  sendStrategy: ilink
```

载荷接受多种拼写（`chatId` / `chat_id` / `sessionId` / `wxid` / `talker`，camel 与 snake 都行），也支持数组批量推：

```bash
curl -X POST http://127.0.0.1:8788/message \
  -H 'authorization: Bearer 自己设一个随机串' \
  -H 'content-type: application/json' \
  -d '{"chatId":"wxid_test","chatType":"private","senderName":"张三","text":"你好","messageId":"m1"}'
```

服务返回 `202` 表示已入队。健康检查是 `GET /health`，不需要令牌。

## 接 QQ

QQ 侧走 **OneBot V11**——本地机器人圈子里最通用的接口，NapCat / Lagrange / LLOneBot / go-cqhttp 都支持。桥接服务这一侧已经就绪，剩下的接线在 NapCat 那边。

### 第 1 步：启动 NapCat 并登录

用你自己的方式把 NapCat 跑起来（Windows 上通常是 NapCatQQ 启动器或 Docker），扫码登录你的**小号**，进入 WebUI。

### 第 2 步：选一种接线方式

本服务四种都支持，任选其一即可。

#### 方式 A：反向 WebSocket（默认，推荐）

NapCat WebUI → **网络配置 → 新建 → 反向WebSocket**：

| 项 | 值 |
|---|---|
| URL | `ws://127.0.0.1:3001` |
| Access Token | 留空，或与配置里的 `onebot.accessToken` 一致 |
| 消息格式 | `array`（推荐）或 `string`，两种都能解析 |

本服务保持默认配置即可：

```yaml
onebot:
  mode: reverse
  url: ws://127.0.0.1:3001
```

#### 方式 B：正向 WebSocket（bot 来连本服务）

NapCat → **网络配置 → 新建 → WebSocket 服务器**，端口 `8080`，然后把配置改成：

```yaml
onebot:
  mode: forward
  host: 127.0.0.1
  port: 8080
  path: /onebot
```

#### 方式 C：HTTP 上报（最省事，只收不发 WS）

NapCat → **网络配置 → 新建 → HTTP 服务器**（或 "HTTP 上报"）：

| 项 | 值 |
|---|---|
| 上报地址 | `http://127.0.0.1:8080/onebot/event` |
| 上报密钥 | 留空，或与 `onebot.accessToken` 一致 |
| 启用心跳 | 可不勾 |

```yaml
onebot:
  mode: http-post
  host: 127.0.0.1
  port: 8080
  postPath: /onebot/event
  # 发消息走 bot 的 HTTP API
  httpApi: http://127.0.0.1:3000
```

> 注意：`http-post` 收事件要用 HTTP，而**发消息**仍需一个出口——填上 NapCat 的 HTTP API 地址（HTTP 服务器端口，通常是 `3000`），否则机器人收得到消息却发不出回复。

#### 方式 D：不接机器人 / 不开控制台

```powershell
node src/index.mjs --no-web   # 只跑机器人链路，不开控制台与聊天页
```

想反过来「只开控制台与聊天页、不连任何机器人」：把配置里的 `onebot.mode` 设成 `off`（这是合法的取值，但控制台的下拉框里没有它，要直接编辑配置文件）。

### 第 3 步：验证

1. 私聊机器人发一句「你好」——应该先收到「🤔 收到，正在处理…」，随后是正式回答。
2. 群里需要 **@机器人** 才会回应（可在 `chat.requireAtInGroup` 关掉）。
3. 服务日志会显示 `bot connected (reverse websocket)`；`/status` 命令也能看到链路状态。

## 聊天里能用的命令

| 命令 | 作用 |
|---|---|
| `/new`（或 `/reset`） | 清空当前会话上下文，重新开始 |
| `/status`（或 `/状态`） | 看桥接链路状态、会话数 |
| `/ping` | 连通性测试 |
| `/say <内容>` | 原样发回，调试用 |
| `/help`（或 `/帮助`） | 命令列表 |

其余任意文本都会作为消息交给智能体。命令必须独占一条消息（带图片时不算命令）。

## 配置说明

配置文件 `bridge.config.yaml`（首次启动自动生成）。常用项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dsh.cwd` | `''` | **智能体的工作目录**。留空表示当前目录；微信里让它做的事都发生在该目录内 |
| `dsh.args` | `['--profile','sdk']` | 启动运行时的参数；随附配置里是 `['--profile','wechat']`（见[收发文件](#收发文件把文件发到你手机上)） |
| `dsh.model` | `deepseek-flash` | 模型名 |
| `dsh.reasoningEffort` | `max` | 推理强度：`off`/`low`/`high`/`max`（`deepseek-flash` 不支持 `medium`；留空用模型默认） |
| `dsh.turnTimeoutMs` | `600000` | 单条消息最长处理时间 |
| `onebot.mode` | `reverse` | `reverse`/`forward`/`http-post` |
| `chat.requireAtInGroup` | `true` | 群聊是否需要 @ 机器人 |
| `chat.allowedUsers` | `null` | 允许的 QQ 号数组；`null` 不限制 |
| `chat.allowedGroups` | `null` | 允许的群号数组；`null` 不限制 |
| `chat.maxReplyChars` | `1500` | 单条回复最大长度；QQ 侧超出自动分片，iLink 侧取它与 900 的较小值、在段落边界截断 |
| `chat.maxSessionChars` | `60000` | 会话累计多少字符后自动换新会话 |
| `chat.prewarmCount` | `2` | 常备几个备用会话 id，换会话时无需重新握手（**不额外调用模型**） |
| `chat.ackOnBusy` | `true` | 是否先回一句「正在处理…」 |
| `chat.groupErrorBudget` | `3` | 群聊连续失败几次后静默 |
| `chat.groupCooldownMs` | `300000` | 静默时长（毫秒） |
| `wechat.enabled` | `false` | 微信路线总开关 |
| `wechat.inbound` | `ilink` | 收消息方式：`ilink` / `webhook` / `none` |
| `wechat.sendEnabled` | `false` | 是否允许发送；关掉就是只收不回 |
| `wechat.sendStrategy` | `ilink` | 发消息方式：`ilink` / `command` / `http` |
| `wechat.ilink.statePath` | `ilink-account.json` | iLink 凭据文件；**里面的 token 等同密码**，别提交、别外传 |
| `wechat.ilink.contextTokenTtlMs` | `86400000` | 发送凭证有效期（24 小时）；过期要你重新给机器人发一条消息 |
| `wechat.ilink.uploadMaxBytes` | `20971520` | 单个出站附件上限（20 MB） |
| `wechat.webhook.port` | `8788` | Webhook 入站端口（不能与 `web.port` 相同） |
| `web.port` | `8787` | 控制台与聊天页端口 |
| `log.level` | `info` | `error`/`warn`/`info`/`debug` |

命令行覆盖（不改文件）：

```powershell
node src/index.mjs --cwd "D:\my-project" --port 9000 --log debug --no-prewarm
```

> `--no-prewarm` 只影响备用会话 id 的缓存，**不会**省下模型调用——备用会话是惰性创建的，本服务从不为预热而调用模型。

## 安装与分发

### 一键安装（推荐给使用者）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

它会检查 Node.js / `dsh`，把程序复制到 `%LOCALAPPDATA%\DshChatBridge`，并在**桌面**和**开始菜单**创建「聊天桥接」快捷方式（带图标）。之后双击快捷方式即可——静默启动服务 + 弹出控制台窗口。

```powershell
# 装到指定目录并开机自启
powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\DshChatBridge" -AutoStart

# 就地运行，不复制文件
powershell -ExecutionPolicy Bypass -File install.ps1 -SkipCopy

# 卸载（删快捷方式）
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

### 手动启动脚本

| 文件 | 作用 |
|---|---|
| `启动窗口模式.cmd` | 启动服务 + 打开控制台窗口（有黑框，能看到错误） |
| `启动聊天桥接.vbs` | 同上，但**不弹黑框**（快捷方式指向它） |
| `排错运行.cmd` | 前台运行，所有输出都留在窗口里（排查启动失败时用这个） |
| `启动服务.cmd` | 只启动服务，不开窗口 |
| `停止服务.cmd` | 停止服务（只停控制台端口的那个进程） |

> 「窗口」是 Microsoft Edge 的 `--app=` 模式（也就是 WebView2 同款机制），所以不需要下载 Electron，看起来就是一个独立应用的窗口。没装 Edge/Chrome 时会退回默认浏览器标签页。
>
> 这几个启动脚本的编码是被生成器管起来的（`.cmd` 必须纯 ASCII、`.vbs` 必须 UTF-16 LE BOM），因为 Windows 的 cmd.exe 会按系统代码页解析批处理文件——UTF-8 中文注释会被当成乱码命令执行。改动前请先读 `scripts/make-launchers.mjs` 里的说明，改完运行 `node scripts/make-launchers.mjs` 重新生成。

### 打包给别人

本项目**零依赖、无构建步骤**，打包就是把目录整理好：

```powershell
node scripts/make-icon.mjs       # 生成图标（已有可跳过）
node scripts/make-launchers.mjs  # 生成启动脚本（改动过它们的文案就要重跑）
node scripts/smoke.mjs           # 确认交付的代码是好的
cd .. ; Compress-Archive -Path dsh-chat-bridge -DestinationPath dsh-chat-bridge-0.1.0.zip -Force
```

细节（包括「免装 Node 的便携包」怎么做、要删哪些文件）见 **[PACKAGING.md](PACKAGING.md)**。

## 工作原理

### 一个聊天 = 一个 DSH 会话

私聊按对方的 id（微信用户 id / QQ 号）、群聊按群 id 建一个会话（`sessionId`），映射关系放在 `ConversationPool` 里。同一个人接着聊，模型记得上文；`/new` 之后重新开始。

**为什么不用 `session/compact`**：DSH 的 SDK 协议里没有压缩方法，而且压缩本身要额外调一次模型。这里改成「旧的直接扔掉、换一个新会话」——`prewarmCount` 常备几个备用会话 id，切换时不需要重新握手。群聊共享一个会话，所以发言会带 `[昵称]` 前缀，模型知道是谁在说话。

### 一条消息的完整旅程

1. 消息到达（iLink 长轮询 / Webhook POST / OneBot 事件）→ 归一化成统一事件：CQ 码与数组段解析、图片与语音转成可读文本或内联附件。
2. 网关处理命令、白名单、群聊 @ 规则，然后**按会话串行排队**（同一会话的消息不会并发，避免上下文乱序）。
3. `session/prompt` 只是「入队回执」，**不是**回答。真正的回答以 `assistant/message` 会话事件形式异步流回来。
4. **回合锁定**：入队后，桥接服务等该会话的下一个 `turn/start`，把它记为「本回合」，只累积该回合的助手消息——这样运行时的预热回复、目标续跑等「自己发起的回合」不会混进用户的答案里。
5. 回合结束（`session.status` 变 `idle`，或 `turn/end` 后短暂静默）后，回答按段落边界分片，逐条发回聊天窗口。工具调用记进日志（`progress:` 行）。
   iLink 是例外——它不连发，只发一条（见[已知限制](#已知限制)）。

### 运行时怎么起

桥接服务用 `dsh.args` 里的参数启动运行时，默认是 `dsh --profile sdk`：它挂载 `@deepseek-ai/dsh-sdk-jsonrpc-server`，用 stdio 讲 newline-delimited JSON-RPC——`spawn` 一个常驻子进程，握手一次 `initialize`（`cwd` + `provider` + `model` + `reasoningEffort`），之后所有会话共用它。**不是每条消息起一个进程**，所以第一条消息之后响应很快。

本项目随附的 `bridge.config.yaml` 用的是 `dsh --profile wechat`：它在 `sdk` 之上换了一套面向手机聊天的人格（中文、先给结论、700 字内、不用 markdown 表格），并且**明确告诉模型 `[[send-file: <完整路径>]]` 这个发文件的约定**——换回 `sdk` 的话，发文件功能永远不会被触发。人格文件在 `~/.dsh/profiles/wechat/cordis.patch.yml`。

## 自检与排错

```powershell
npm test                         # 一条命令跑完全部 6 个套件（串行，约 50 秒，末尾给汇总表）
node scripts/test-all.mjs        # 同 npm test；--verbose 会实时打印每个套件的完整输出
```

单个套件（排查时用）：

| 套件 | 覆盖 |
|---|---|
| `scripts/smoke.mjs` | 25 项离线断言：YAML/配置往返、CQ 解析、分片、OneBot 上报、网关规则、回合锁定、凭据读写、控制台页面语法。加 `--e2e` 会再启动真实运行时跑一轮真实模型对话 |
| `scripts/check-wechat.mjs` | 微信链路：载荷归一化、内容分类、@ 与自我过滤、Webhook 入站端到端、三种出站策略（命令策略会真起一个 node 子进程）、配置校验 |
| `scripts/check-ilink.mjs` | iLink 官方接口：报文契约、错误语义、登录状态机、出站发文件（AES 填充、标记抽取、`getuploadurl`、CDN 上传、`sendFile`）。加 `--live` 会真的请求微信接口 |
| `scripts/check-console-ui.mjs` | 控制台前端：把页面内联脚本抽出来用桩 DOM 真跑一遍（含加载竞态回归），并断言两个下拉框覆盖全部合法取值、已删除的路线不会回来 |
| `scripts/console-e2e.mjs` | 控制台后端全链路：起服务 → 逐个打管理接口 → 写盘热重启 → iLink 扫码状态机 |
| `scripts/check-ilink-e2e.mjs` | iLink 端到端：桩网关 → 真 `WeChatAdapter` → DSH 会话 → 回复（含 `context_token` 回传、markdown 剥离、`[[send-file: …]]` 变成附件） |

**这些套件会监听端口、起子进程**（`check-wechat` 固定占 8899），所以必须串行——`scripts/test-all.mjs` 就是为此存在的。
每个套件还有硬超时（默认 180 秒，`DSH_TEST_TIMEOUT_MS` 可调），超时会报出套件名和它最后打印的那一行。

```powershell
# 手工调试用
node scripts/web-chat.mjs "你好"        # 通过聊天页发一条消息并打印回答
node scripts/diag-events.mjs            # 打印运行时推送的每一个会话事件（排查回合问题的利器）
node scripts/diag-apply.mjs             # 「应用并重启」各阶段耗时（排查卡顿）
node scripts/make-launchers.mjs         # 重新生成启动脚本（改了它们的文案后必须跑）
node src/index.mjs --ilink-login        # 重新扫码绑定微信
```

常见问题：

| 现象 | 原因与处理 |
|---|---|
| 双击启动器没反应 | 看程序目录里的 `bridge.log`；或改双击 `启动窗口模式.cmd`（有黑框，能看到报错） |
| 微信扫码后手机报「网络错误 / 请稍后再试」 | **扫的方式不对**。这条链接必须在微信里打开（插件入口，或发到文件传输助手后点开），不能用通用「扫一扫」。详见[第 1 步](#第-1-步扫码绑定) |
| 绑定成功了但控制台显示「未登录 / 不可用」 | 正常。**先在微信里给机器人发一条消息**，发送凭证才会解锁 |
| 日志出现 `errcode -14` | 登录会话过期，重新扫码即可 |
| 发出去了但你手机没收到 | iLink 的 `ret=0` 只代表腾讯受理。先确认不是你超过凭证有效期（再给机器人发一条消息试试）；也可能是腾讯那侧的下行故障 |
| `runtime initialize failed` | 运行时没起来。日志会附上运行时 stderr 的最后几行；`reasoningEffort` 不被该模型支持是最常见原因 |
| 控制台显示「dsh 未找到」 | 桥接服务会在 PATH、npm/pnpm 全局目录、以及本目录附近查找 `dsh`。都不在就把绝对路径写进 `dsh.command` |
| `listen EADDRINUSE` | 端口被占：在控制台换 `web.port` 并手动重启，或先运行 `停止服务.cmd` |
| `多余的参数：(2)` | 路径里有空格没整体加引号：`--cwd "D:\my project"`（`(2)` 是 `my project` 被拆开后的第二段） |
| 私聊没反应、日志无事件 | QQ 那侧 OneBot 没连上。确认 `mode`/`url`/端口与 NapCat 侧一致，`accessToken` 两边相同；控制台日志面板能看到原始事件 |
| 群聊不理我 | 默认需要 @ 机器人。想改成有消息就回：`chat.requireAtInGroup: false` |
| 收得到消息、发不出回复 | `http-post` 模式下必须配 `onebot.httpApi`；反向/正向 WS 模式则看日志里的 send 报错 |
| 回复被拆成多条 | QQ 侧的正常行为，`chat.maxReplyChars` 控制分片阈值；**iLink 侧不会分片**（单条上限 900 字） |
| 回答末尾出现「后续约 N 字已省略」 | 撞上了 iLink 的单条 900 字上限。让智能体答短一点，或让它把长内容写进文件用 `[[send-file: …]]` 发给你 |
| 智能体说发了文件、我这边没收到 | 看日志：`已提交给网关（送达未确认）` 说明腾讯受理了（送达无法确认）；`附件发送失败：…` 会给出原因（文件不存在 / 0 字节 / 超过 `wechat.ilink.uploadMaxBytes` / 没有发送凭证）。另外确认运行时用的是带 `[[send-file: …]]` 人格的 `wechat` profile |
| 回答里混进无关内容 | 看 `node scripts/diag-events.mjs` 的事件流；回合锁定依赖 `turn/start`，若运行时行为有变可据此定位 |
| 回答很慢 | 智能体在真干活（读写文件、跑命令）。控制台日志面板 / `--log debug` 能看到 `progress:` 工具调用；`dsh.reasoningEffort` 降到 `low` 会快很多 |
| 提示「上下文已满」之类 | 不会发生：本服务按 `maxSessionChars` 自动换会话 |

安全提醒：

- 群里 @ 机器人就等于**给了对方一个能在这台机器上跑命令的智能体**。上生产前请在控制台「聊天设置」里设置 QQ / 群白名单。
- 让机器人用**小号**，个人号自动化存在被风控的风险，这条路线自己承担。
- 控制台**没有鉴权**，默认只监听 `127.0.0.1`；不要把它暴露到公网（改 `web.host` 时启动日志会警告）。
- API Key 存在 DSH 的 `~/.dsh/.credentials.yaml`，只有你的 OS 用户可读；但智能体的工具进程以同一用户运行，所以这个存储隔离不了它——别把机器人接到你不信任的群里。

## 许可证

[**MIT**](LICENSE)。你可以自由使用、修改、分发、商用，甚至闭源再发布 —— 只需保留版权声明和许可证原文。

```text
Copyright (c) 2026 3066586604 <3066586604@qq.com>
```

> 想换个显示名：改 `LICENSE` 里这一行，再把提交作者一起改掉 ——
> `git config user.name "你的名字"` 然后 `git commit --amend --reset-author --no-edit`。

本项目在实现 iLink Bot 协议时参考了腾讯官方
[`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 的公开源码（协议字段与流程对齐），
但**没有复制其代码**；仓库中不包含任何第三方源码副本。

