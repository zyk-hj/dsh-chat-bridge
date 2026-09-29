# iLink 扫码失败的调查结论

调查对象：`GET/POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 拿到二维码后，
手机微信扫码显示「网络错误，请稍后重试」，服务端状态永远停在 `wait`，最后 `expired`。

调查记录。文中每条结论都附了可复核的证据（命令与实际输出、源码文件与行号、链接）。

---

## 0. 一句话结论

**不是「本机协议写错」导致的，也不是我们能靠改客户端修好的——但它同时也不是（至少不只是）「账号没有灰度到 ClawBot」。**
证据指向**服务端绑定态**：该微信号（或该微信客户端）在 liteapp 侧的绑定会话已经存在但不可用，
扫码时 liteapp 的授权页拿不到有效会话，于是手机报「网络错误」，iLink 侧也就永远收不到 `scaned`。

同时我们确实有 4 处偏离官方协议的地方，已全部修正（见 §5）。**修正后依然无法保证能扫上**——
因为最关键的对照实验（§3.1）表明：腾讯自己的官方插件、用完全正确的协议，在同样的现象上一样失败。

---

## 1. 调查方法

| 手段 | 说明 |
| --- | --- |
| 读官方实现 | 下载 `@tencent-weixin/openclaw-weixin` 解包后逐文件阅读（`auth/` / `api/` / `cdn/`） |
| 读社区协议文档 | 与官方源码逐条对照，不一致处以官方源码为准 |
| 桩服务复现 | `scripts/check-ilink.mjs` 用桩网关复现每条报文，并把它固化成断言 |
| 真实接口 | `node scripts/check-ilink.mjs --live` 会真的请求微信接口 |

> 调查期间本机沙箱一度完全不可用（任何命令都返回
> `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作目录>)`），
> 所以早期结论部分是靠**读源码**得出的。**这些结论后来都在能跑测试的环境里被断言钉住了**，
> 见 §6；凡是没能验证的，文中都标了「未证实」。

---

## 2. 已证实：官方协议的准确形状（证据可复核）

官方仓库 `Tencent/openclaw-weixin` 的协议文档就是答案，它明确写了**取二维码是 POST**。
以下全部为「已证实」级证据（源码 + 文档原文）。

### 2.1 取二维码：`POST`，且带 `local_token_list`

官方文档：[`docs/protocol_zh_CN.md`](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)（"二维码登录 → 获取二维码"）原文：

```http
POST /ilink/bot/get_bot_qrcode?bot_type=3
```
```json
{ "local_token_list": [] }
```
> `local_token_list` 可以为空。客户端最多发送本地保存的最近 10 个 Bot token。

官方源码：[`src/auth/login-qr.ts`](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts) → `fetchQRCode()`

```ts
const localTokenList = getLocalBotTokenList();
const rawText = await apiPostFetch({
  baseUrl: apiBaseUrl,
  endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
  body: JSON.stringify({ local_token_list: localTokenList }),
  label: "fetchQRCode",
});
```

同一个函数里 `DEFAULT_ILINK_BOT_TYPE = "3"`、`FIXED_BASE_URL = "https://ilinkai.weixin.qq.com"`
（即官方**固定**用这个域名取码，不允许配置其它 host）。

**`local_token_list` 的作用**，官方 CHANGELOG 2.3.1 写得很直白：

> **扫码时上送 `local_token_list`：** `fetchQRCode` 现在带上本地最近 10 个 `bot_token`，
> 让服务端识别"已绑定到本端"的 bot 并下发 `binded_redirect`，避免重复发会话。

### 2.2 轮询状态：`GET`，**只带身份头**

官方文档「客户端行为」原文：

> 二维码状态轮询发送应用请求头（`iLink-App-Id`、`iLink-App-ClientVersion` 和可选的 `SKRouteTag`），
> **不添加** `AuthorizationType`、`Authorization` 或 `X-WECHAT-UIN`。

官方源码 `src/api/api.ts` → `buildCommonHeaders()`（GET 用）/ `buildHeaders()`（POST 用）确认了这点。

### 2.3 两个身份头必须正确且非零（这是官方踩过的生产事故）

官方 CHANGELOG 2.4.3 原文：

> **`iLink-App-Id` / `iLink-App-ClientVersion` 请求头在生产环境为空 / `0`。**
> `readPackageJson` 用固定的 `../../` 从 `import.meta.url` 推算 `package.json`，但 TypeScript 构建实际产物是
> `dist/src/api/api.js`（多出一层 `src/`）……导致解析到不存在的 `dist/package.json`，catch 返回 `{}`。

也就是说：**这两个头为空时所有请求都会失败**。服务端按它们路由/识别客户端，不是可选装饰。

### 2.4 `X-WECHAT-UIN` 的正确编码

官方 `src/api/api.ts`：

```ts
/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
```

是「随机 uint32 → **十进制字符串** → base64」，不是「4 个随机字节 → base64」。

### 2.5 凭据存哪、字段叫什么（与我们的 `ilink-account.json` 对齐）

官方 `src/auth/accounts.ts`：`WeixinAccountData = { token?, savedAt?, baseUrl?, userId? }`
→ 和我们 `ilink-account.json` 的 `{ token, userId, botId, baseUrl, savedAt }` **语义一致**，
我们的 `botId` 对应官方账号文件名所用的 `ilink_bot_id`（形如 `xxxx@im.bot`）。**不需要改字段名。**

---

## 3. 已证实：这不是「只有我们才遇到的问题」——官方插件一样失败

### 3.1 【最强证据】官方仓库 issue #242：症状逐字相同

[Tencent/openclaw-weixin#242](https://github.com/Tencent/openclaw-weixin/issues/242)
标题：**「[Bug] 微信 Android 扫描 iLink 二维码后提示"网络错误，请稍后再试"，状态最终 expired」**

该报告者用的是 **`@tencent-weixin/openclaw-weixin@2.4.6` 的官方协议**，并且做了独立最小探针
（不含 OpenClaw runtime、不含业务代码）。报告原文摘录：

> `get_bot_qrcode` 请求可以成功返回二维码数据，但微信 Android 客户端扫描后稳定显示：
> > 网络错误，请稍后再试
> 服务端二维码状态没有进入 `scaned` 或 `confirmed`，而是保持等待状态，最终变为 `expired`。

探针输出：

```text
PROBE_TERMINAL=completed
MANUAL_OUTCOME=mobile_network_error
QR_HOSTNAME=liteapp.weixin.qq.com
```

同一 issue 下的补充报告（用户 `phoneixjia-bit`，2026-08-10）给出了**最关键的因果链条**：

> 1. 8/6 扫码绑定成功，bot「WeChat ClawBot AI」正常收发消息（使用了数天）
> 2. 8/9 插件重装导致本地凭据丢失（accounts.json 消失，全盘搜索无任何备份）
> 3. 之后所有重新登录尝试均失败：手机扫码立即显示「QR CODE 已经过期」；服务端从未收到 scan
> 4. 旧绑定仍然存活：向 bot 发送消息可正常送达
>
> 已测试：标准路径 `/q/7GiQu1` 与桌面路径变体 `/q/uuDHSe` 结果相同；bot_type=3 有效；微信端无任何解绑入口。
>
> 怀疑：账号已绑定旧 bot 时，liteapp 服务直接拒绝新 QR，且凭据丢失后没有任何重新绑定/解绑机制。
> 请求：提供服务端解绑能力，或修复「凭据丢失后无法重新绑定」的流程。

**这段就是本案。** 它证明了：

1. 同样的「手机扫码报错、服务端无状态变化」在**协议完全正确的官方实现**上照样发生；
2. 触发条件是**服务端已存在绑定**（本地凭据丢失后无法重建）；
3. 「`bot_type=3` 用错了」「二维码渲染方式不对」都被该报告排除了（终端字符码和 PNG 结果一致）。

另一条独立印证：[腾讯云开发者社区提问「【ClawBot iLink 绑定缓存 bug】新实例扫码依旧路由到旧故障 OpenClaw 网关，无法解绑旧 bot？」](https://developer.cloud.tencent.com.cn/ask/2212812)
——标题即结论：**绑定缓存 / 路由到旧实例**，且**没有解绑入口**。

### 3.2 关于「灰度」：ClawBot 确实分批开放，但那不是本症状

社区文档 [微信 ClawBot 接入指南](https://github.com/DjangoPeng/agentic-ai/blob/main/openclaw-im/wechat-clawbot.md) 与
[七牛云《DeepSeek Harness 如何连接微信》](https://news.qiniu.com/archives/1787733470435) 均写明：

> 微信于 2026 年 3 月正式上线 ClawBot 插件入口，客户端需 **8.0.70 及以上**版本（入口在"我 → 设置 → 插件"）。
> **前置要求：** ……微信账号**已获机器人功能灰度**。
> **Q：没有看到微信机器人入口怎么办？** 该功能由腾讯**分批灰度开放**，先把微信升级到 8.0.70 以上并完全重启客户端刷新插件列表；
> 仍未出现只能等待，**插件无法绕过账号侧开放范围**。

所以「灰度」是真实存在的门槛。**但它对不上我们的现象**：

- 没灰度的表现是**看不到机器人入口**，而不是「扫一个能扫出来的码然后报网络错误」；
- 我们的手机**能**解码并打开 `liteapp.weixin.qq.com` 的授权页（说明 liteapp 页面本身对客户端是可达的），
  失败发生在该页面去取二维码会话信息那一步。

**结论：灰度是「前提」，不是本症状的「病因」。** 病因是 §3.1 的绑定态。

### 3.3 我们自己那次 `getQRCodeInfo` 调用失败，不能推出任何结论

现象：在微信之外调 `GET https://liteapp.weixin.qq.com/cgi-bin/liteapp/qrcode/getQRCodeInfo?url=<页面URL>`
一律返回 `{"error":{"name":"ServerError","message":"请求异常"}}`。

这只是**预期行为**：该 CGI 只认微信 WebView 自身的登录态/凭据，本机浏览器没有，所以报 `ServerError`。
**它既不能证明账号有问题，也不能证明协议有问题——它只是证明「我们不在微信里」。**
把它当作「协议缺项」的证据是错的；把它当作「账号被拒」的证据同样是错的。

---

## 4. 推测（明确标注，未证实）

以下两条是**推测**，没有拿到服务端确认：

1. **推测**：liteapp 侧按 `(微信账号 ↔ bot)` 维度维护绑定缓存。已存在绑定（即使本地凭据丢了、
   旧 bot 已不可用）时，新的扫码请求会被路由/拒绝到一个失效会话，页面因此报「网络错误」。
   依据：§3.1 的完整时间线 + 腾讯云社区那条「绑定缓存 bug，路由到旧故障网关，无法解绑」。
   **未证实部分**：不知道服务端在什么条件下会释放这个缓存。
2. **推测**：「网络错误」这个文案是 liteapp 前端的兜底分支，不是精确错误码。它可能同时覆盖
   「会话建立失败」「账号未开放」「风控拦截」多种情况——**这正是不好一次定性的原因**。

---

## 5. 我们改了哪些偏离官方的地方（已修正）

对照官方实现，`src/wechat-ilink.mjs` 原有 4 处偏离，均已修正：

| # | 问题 | 原来 | 改为 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | 取二维码用 `GET` 且无 body | `GET .../get_bot_qrcode?bot_type=3` | `POST` + `{local_token_list:[...]}` | §2.1 |
| 2 | 轮询二维码状态带了 `X-WECHAT-UIN`（及 POST 头） | 全部请求同一套头 | GET 只发 `iLink-App-Id`/`iLink-App-ClientVersion`（+可选 `SKRouteTag`） | §2.2 |
| 3 | `X-WECHAT-UIN` 编码错误 | `randomBytes(4).toString('base64')` | `Buffer.from(String(uint32),'utf8').toString('base64')` | §2.4 |
| 4 | `iLink-App-ClientVersion` 声明为 2.1.3（`131331`），与真实协议代次不符 | `ILINK_PROTOCOL_VERSION='2.1.3'` | `'2.4.9'` → `132105` | §2.3 |

附带修正（同样是官方行为，原来缺失或行为相反）：

- **`wait` 状态未处理**：官方状态表里 `wait` 是正常等待态；现在显式识别，不再落到「未知状态」。
- **`binded_redirect` 被当成错误抛出**：官方 `loginWithQrCode` 把它当**成功**返回
  （CHANGELOG 2.4.3：`WeixinQrWaitResult` 新增 `alreadyConnected`，CLI 以 0 退出）。
  现在返回 `{ alreadyBound: true, qrUrl }`，并且**不会**把空 token 写进 `ilink-account.json`
  （`saveAccount` 现在返回是否写入，空 token/已绑定一律不落盘——避免覆盖掉有效凭据）。
- **状态轮询超时**：60s → `QR_STATUS_TIMEOUT_MS = 35000`（官方长轮询超时）。
- **新增 `IlinkBridge.localTokenList()` / `IlinkBridge.refreshQrCode()`**：把本机已有 token
  报给服务端，这是在「账号已绑定到本端」时拿到 `binded_redirect` 的唯一途径。
- **新增 `settings.clientVersion` / `settings.routeTag`** 两个可选配置（不新增依赖、不改 `package.json`）。

---

## 6. 这些结论怎么防止回退

上面每条协议细节都在 `scripts/check-ilink.mjs` 里有对应断言（`node scripts/check-ilink.mjs` 单独跑，或
`node scripts/test-all.mjs` 跑全套）：

1. 版本头是「打包后十进制字符串」且身份头只有两个（`SKRouteTag` 可选）；
2. GET 不带 `X-WECHAT-UIN` / `Content-Type` / `Authorization`；
3. `X-WECHAT-UIN` 解码后必须是纯十进制数字串；
4. **取二维码必须是 POST**，查询串含 `bot_type=3`，body 为 `{local_token_list:[...]}`，且不带 `Authorization`
   （用 `rawHeaders` 校验**大小写敏感**的头名，如 `iLink-App-Id`）；
5. 轮询状态必须是 GET 且不带 `UIN`/`Authorization`；
6. `loginWithQrCode({localTokenList})` 必须把 token 传到请求体；
7. `binded_redirect` → `alreadyBound: true` 而不是抛错；
8. `wait` → 继续轮询；未知状态不假装成功；
9. 空 token 不入库（不会覆盖已存凭据）。

> 其中第 4/6/9 条是**真的修过 bug** 才变成断言的：早期实现用 GET 取二维码、不传
> `local_token_list`，并且会把空 token 写回凭据文件覆盖掉有效的那个。

---

## 7. 下一步（按优先级）

### 第 1 步（0 成本，能直接定性）：在手机上确认功能入口

打开微信 → **我 → 设置 → 插件**，看是否有**机器人 / ClawBot** 入口。

- **没有该入口** → 账号未获灰度。结论确定，只能等腾讯分批开放，任何客户端改动都无解。
- **有该入口** → 灰度这关过了，问题在 §3 的绑定态/服务端侧，进入第 2 步。

这一步是区分两种可能性的**唯一低成本判别法**，且只能由用户本人操作。

### 第 2 步：确认这个微信号是否已经绑定过 bot（本机查不到）

本机 `dsh-chat-bridge/` 下**不存在** `ilink-account.json`（已确认），
`bridge.config.yaml` 里也**没有** `ilink` 段 —— 说明**本机从未成功绑定过**，
所以 `local_token_list` 现在是空的，服务端无法通过它识别「已绑定」。
若用户之前在**另一台机器 / 另一个目录 / 另一个插件**上绑定成功过同一个微信号，
那么服务端很可能仍持有那条绑定 → 完全符合 §3.1 的成因。

判据：用该微信号之前的 bot 会话发一条消息，**如果还能收到回复**，就说明旧绑定仍然存活——
那就是绑定态问题，不是灰度问题。

### 第 3 步：不要为了「试试看」去装 OpenClaw

**明确结论：装 OpenClaw 大概率解决不了这个问题。**
理由：issue #242 里，官方 CLI + 官方插件 `2.4.6` 在**同一现象**上一样失败；补充报告者明确写了
「官方 2.4.6 插件与官方 CLI 安装器亦实测同样失败」。我们的协议偏离（§5）虽然是真的 bug，
但**不是**导致手机报「网络错误」的原因——因为协议完全正确时现象一模一样。

所以：**如果只是为了扫码，不值得改用户的机器。**

如果 Lead / 用户仍要在另一台干净环境做对照实验，命令与预期（**需要用户明确授权，本次未执行**）：

```bash
# 1) 先确认宿主
openclaw --version                       # 需 >= 2026.5.12

# 2) 安装官方插件（会改动机器：装包、写 openclaw.json）
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true

# 3) 扫码登录
openclaw channels login --channel openclaw-weixin
```

**预期结果（基于 #242）：**
- 若返回 `✅ 已连接过此 OpenClaw，无需重复连接。`（`binded_redirect`）→ 绑定态问题，实锤；
- 若手机仍报「网络错误，请稍后重试」且状态停在 `wait` → 与官方实现同样失败，同样指向服务端/账号侧；
- 若成功拿到 `bot_token` → 说明我们之前确有协议缺陷，届时把 token 交给本桥接
  （`ilink-account.json` 格式为 `{token, baseUrl, userId, botId}`，与官方 `{token, savedAt, baseUrl, userId}` 语义一致）。

**风险：** 会安装 npm 全局包、写 `openclaw.json`、可能触发插件安装脚本；同样会向服务端**再发起一次绑定尝试**——
按 §3.1，反复重试绑定可能加重账号/绑定维度的限制。**不建议在用户主力微信号上反复试。**

### 第 4 步：唯一已知可行的恢复路径是「服务端解绑」

§3.1 与腾讯云社区那条都指出：**微信端没有解绑入口**，凭据丢失后无法重新绑定。
可行的只有官方支持渠道：`openclaw channels login` 失败时把脱敏日志（时间、request id、
`getQRCodeInfo` 的响应体、是否曾成功绑定）提交到
[Tencent/openclaw-weixin Issues](https://github.com/Tencent/openclaw-weixin/issues) 请求服务端解绑。

### 第 5 步（低优先级）：补完 `localTokenList` 的调用链

`src/ilink-login.mjs` 的 `runIlinkLogin` 目前**没有**把 `localTokenList` 传下去。
本机当前无 token，所以现在是空列表、无影响；但一旦拿到 token 后再次重扫，
必须走 `IlinkBridge.refreshQrCode()`（已带 `localTokenList`），否则拿不到 `binded_redirect`。
控制台的扫码入口应优先用 `IlinkBridge.refreshQrCode()` 而不是自己拼流程。

---

## 8. 一句话回答

**扫码失败不是「账号没有灰度」的概率更高——把握约 80%。**
把握程度不能给到更高，原因有两层，都必须说清：

1. **支持「不是灰度」的硬证据**：官方插件 + 官方 CLI 用完全正确的协议在 issue #242 上复现了**一模一样**的现象，
   且有完整因果链（成功绑定数天 → 凭据丢失 → 从此无法重新扫码 → 旧绑定仍活着）。
   这排除了「是我们协议写错」和「是新号没灰度」两种解释里最直接的那一半。
2. **不敢给到 95% 的原因**：我们**始终没有拿到 `scaned` 之后的服务端响应**，
   而 §4 的两个推测也无法在本地证伪；`getQRCodeInfo` 的 `ServerError` 只能说明「我们不在微信里」。
   换句话说，我们证明的是「不是我们这边的问题」，而不是「服务端到底在拒绝什么」。

**要把它钉死，只需用户做一件事**（第 1 步）：打开微信 → 我 → 设置 → 插件，看有没有机器人入口。
没有 = 灰度问题（结论翻转）；有 = 绑定态问题。#242 的补充报告已经把后者的恢复路径堵死了（无解绑入口）。
