# 变更记录

本项目的所有重要变更都记在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)（1.0 之前，小版本也可能有破坏性变更）。

## [0.1.0] - 2026-09-29

第一个可用版本：微信侧走**腾讯官方 iLink Bot**（已扫码绑定、双向实测通过），QQ 侧保留 **OneBot V11**，
**零运行时依赖**（`package.json` 里没有 `dependencies`，只用 Node 内置能力）。

### Added

- **微信官方 iLink Bot 主线**：扫码登录（`node src/index.mjs --ilink-login`，或控制台「微信」页点「扫码登录」）、
  长轮询 `/ilink/bot/getupdates` 收消息、`/ilink/bot/sendmessage` 回消息。绑定后机器人就是你微信里的一个联系人。
- **可视化控制台**（<http://127.0.0.1:8787/console>，六个面板：状态 / 模型与密钥 / 微信 / QQ·OneBot / 聊天设置 / 运行日志）：
  看状态、改配置、填密钥、测连通性、用浏览器打开聊天页；底层是一组本地 HTTP 管理接口（见 README）。
- **控制台里的 iLink 扫码**：页面实时显示二维码链接与登录状态机（`wait` / `scaned` / `need_verifycode` /
  `confirmed` / `binded_redirect` / `expired`），扫码成功后**立刻开始收发，不用重启进程**；
  重复点「扫码登录」不会另起一个流程。
- **配对码登录**：微信要求「手机上显示的配对码」时，页面给出输入框，提交后喂给同一个登录流程。
- **聊天命令**：`/new`（`/reset`）、`/status`（`/状态`）、`/ping`、`/say <内容>`、`/help`（`/帮助`）。
- **收发文件**：智能体在回答里单独写一行 `[[send-file: <完整路径>]]`，桥接把这一行从正文里删掉、
  把文件加密上传到腾讯 CDN，再作为**真正的微信附件**发出；图片（`png/jpg/jpeg/gif/webp`）走图片通道，
  其余扩展名走文件通道。默认单文件上限 20 MB（`wechat.ilink.uploadMaxBytes`）。
- **入站媒体**：图片/文件从腾讯 CDN 取回后用 AES-128-ECB 解密后交给智能体——图片作为内联附件，
  文件落盘并把路径写进内容里；取不到就降级成占位文本（`[图片]` / `[语音] <转写>` / `[文件] <名字>` / `[视频]`），
  不丢消息也不抛错。
- **Webhook 入站**（`wechat.inbound: webhook`）：本服务监听一个 HTTP 端口，任何工具都能 POST 消息进来；
  字段名支持多种拼写、支持数组批量投递，`GET /health` 免令牌，返回 `202` 表示已入队。
- **QQ 侧 OneBot V11**：反向 WebSocket（默认）/ 正向 WebSocket / HTTP 上报 / 关闭四种模式，CQ 码与数组段都能解析。
- **安装与分发**：`install.ps1`（复制到 `%LOCALAPPDATA%\DshChatBridge`，建桌面与开始菜单快捷方式，
  支持 `-InstallDir` / `-AutoStart` / `-SkipCopy` / `-Uninstall`）、`scripts/make-launchers.mjs` 生成的
  `.cmd` / `.vbs` 启动脚本、`scripts/make-icon.mjs` 生成的图标。
- **自检**：6 个套件（`smoke` / `check-wechat` / `check-ilink` / `check-console-ui` / `console-e2e` /
  `check-ilink-e2e`），`node scripts/test-all.mjs` 串行跑完并打印汇总表；`node scripts/check-ilink.mjs --live` 会真的请求微信接口。
- **`docs/ilink-scan-findings.md`**：iLink 扫码失败真因的完整调查，每条结论都附可复核的证据。

### Changed

- **路线收敛到官方接口**：微信侧只保留 iLink Bot + webhook。配置里 `wechat.inbound` 只认
  `ilink` / `webhook` / `none`，`wechat.sendStrategy` 只认 `ilink` / `command` / `http`；
  控制台的下拉框、字段说明与错误提示同步，已删除的路线在界面上不再出现。
- **长回复不切块连发**：iLink 单条回复上限 900 字（`ILINK_MAX_REPLY_CHARS`），超出时在段落边界截断，
  并在消息里注明「后续约 N 字已省略」——连续多条发送在 iLink 上会静默丢消息，宁可截断也不连发。
  QQ 侧仍是原来的分片行为（传输层没声明上限时行为完全不变）。
- **送达语义如实**：`ret=0` / HTTP 200 只代表网关受理，日志与控制台一律说「已受理，送达未确认」，
  不再用看起来像送达回执的说法。
- **`context_token` 带 TTL**（默认 24 小时，`wechat.ilink.contextTokenTtlMs`）：过期即视为没有发送凭证，
  失败原因变成可操作的「先在微信里给机器人发一条消息」，而不是含糊错误；控制台「检查微信状态」会显示凭证状态。
- **随附配置改用 `dsh --profile wechat`**：它等于 `sdk` 加上面向手机聊天的人格（中文、先给结论、700 字内），
  并且是**唯一告诉模型 `[[send-file: …]]` 约定**的地方。代码里的默认值仍然是 `['--profile', 'sdk']`。
- 控制台页面遇到旧配置里残留的已删除取值时，下拉框回落成推荐值（留空会让下一次保存提交空字符串、被校验拒绝）。
- README 按 v0.1.0 重整：加版本与状态、补「收发文件」章节、修正面板数量与自检套件清单。

### Removed

四条微信路线实测走死后全部删除（代码、工具脚本、npm 依赖一起删）。这里保留它们**具体怎么失败的**，
是为了不让下一个人重新踩：

- **wcferry（注入 DLL）**：它只认微信 3.9.12.17，而腾讯服务端**已经不让这个版本登录**——扫码成功、
  手机确认之后，服务端在最后一步踢回「当前微信版本过低，请升级至最新版本」。把内存里的版本号
  （6 处 4 字节常量 + 77 处 ASCII + 52 处 UTF-16 字符串）全改成 4.1.13.65 也无效：服务端不看你内存里写了什么。
  上游仓库已归档。
- **uia（UI 自动化）**：微信 4.x 整站自绘——主窗口在 UIAutomation 下只有 **3 个元素**，
  MSAA 内容面板 **0 个子元素**，既没有搜索框也没有输入框可以定位。
- **模拟键鼠（`sendStrategy: weixin`）**：真机打了 4 次，只有第 1 次真的送达，之后 3 次**都报成功而一条没到**：
  微信的搜索面板会把主窗口从 896 撑到 1340，按窗口比例算出的输入框坐标落到聊天区外面，脚本却照常以退出码 0 结束。
- **weflow / 读本地数据库解密**：它只提供一个推送流、不附带二进制，要求使用方自备原生解密组件；
  而「读本地数据库解密」这条技术路线本身还有真实法律风险——标杆项目
  [chatlog](https://github.com/sjzar/chatlog) 已因腾讯法务函于 2025-10-20 整库删除。

一并删除：`@wechatferry/core` 依赖（于是本项目零运行时依赖）、`wechat-wcferry.mjs`、
`wechat-uia-sender.mjs`、`wechat-uia-send.ps1`、`wechat-weixin-sender.mjs`、`weflow.mjs` 及配套探针脚本，
以及配置里的 `wechat.wcferry.*` / `wechat.uia.*` / `wechat.weixin.*` / `wechat.weflowUrl` / `wechat.weflowToken`
等字段。

### Fixed

- **空字符串配置被 `??` 漏过，媒体下载 URL 塌掉**：`wechat.ilink.cdnBaseUrl` 出厂是空字符串（空 = 用默认值），
  用 `'' ?? 默认值` 判断的结果仍是空串，下载地址退化成 `?encrypted_query_param=…`，
  每个入站图片/文件都失败在 `Failed to parse URL from ?encrypted_query_param=…`。
  纯文本回复根本不碰 CDN，所以这个 bug 一直没被看见，直到真有人发来一个文档。现在空串会回落到官方默认地址。
- **轮询循环在网关秒回时饿死定时器**：`getupdates` 若立刻返回，轮询循环会退化成纯微任务忙等，
  永远不让出到定时器阶段，于是进程里所有 `setTimeout` 都被饿死。现在有最小轮询间隔
  （`ILINK_MIN_POLL_INTERVAL_MS = 250`），并用一个「秒回」的桩网关把这条钉进回归测试。
- **markdown 内联围栏吃掉正文**：剥 markdown 的旧正则要求开围栏之后必须换行，于是**写在同一行里的行内围栏**
  会一路匹配到下一个换行，把夹在中间的内容整段删掉——一条专门贴命令输出的回复，正文就这么静默消失了。
  现在行内围栏同样保留正文。
- **iLink 扫码协议 4 处偏离官方实现**（依据官方 `protocol_zh_CN.md` 与 `login-qr.ts`）：
  取二维码从 `GET` 改成 `POST` 并带上 `local_token_list`；状态轮询只发身份头
  （不再发 `X-WECHAT-UIN` / `Authorization` / `Content-Type`）；
  `X-WECHAT-UIN` 改成「随机 uint32 → 十进制字符串 → base64」；协议版本头从声明的 `2.1.3` 改成 `2.4.9`。
- **`wait` 不再被当成未知状态，`binded_redirect` 不再被当成失败**：账号已经绑定过本端时，
  如实返回「已经绑定过」，并且**不会**把空 token 写进 `ilink-account.json` 覆盖掉有效凭据。
- **扫码状态轮询超时**从 60 秒改成官方长轮询的 35 秒（`QR_STATUS_TIMEOUT_MS`）。
- **长回复不再静默丢内容**：截断会在消息里写明省略了多少字，日志同时给出字数；
  「这一轮没有任何内容可发」也会记一条日志，不再和「回复被丢掉了」长得一模一样。
- **测到一半挂住的套件不再拖死整轮测试**：`scripts/test-all.mjs` 给每个套件加了硬超时（默认 180 秒，
  `DSH_TEST_TIMEOUT_MS` 可调），超时会报出套件名和它最后打印的那一行。
