/**
 * The desktop control console served at `/console`.
 *
 * A single self-contained page: no framework, no external assets, so it works
 * from a packaged folder with no network access. It talks to the bridge's admin
 * API (`/api/*`) and polls status so the operator sees live state while a
 * restart is in progress.
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>聊天桥接 · 控制台</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#141821; --panel2:#1b202b; --line:#262d3b;
          --text:#e8ecf4; --muted:#8b95ab; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; --accent:#4b8ef7; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--text);
         font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { padding:18px 26px 0; }
  h1 { font-size:17px; margin:0 0 4px; font-weight:650; }
  .sub { color:var(--muted); font-size:12.5px; }
  nav { display:flex; gap:6px; padding:16px 26px 0; border-bottom:1px solid var(--line); }
  nav button { background:none; border:0; border-bottom:2px solid transparent; color:var(--muted);
               padding:9px 14px; font:inherit; cursor:pointer; }
  nav button.active { color:var(--text); border-bottom-color:var(--accent); }
  main { padding:22px 26px 40px; max-width:1000px; }
  section { display:none; } section.active { display:block; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 14px; font-weight:600; color:var(--text); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  .field { display:flex; flex-direction:column; gap:5px; }
  .field label { font-size:12.5px; color:var(--muted); }
  .field .hint { font-size:11.5px; color:var(--muted); opacity:.85; }
  input,select,textarea { background:var(--panel2); border:1px solid var(--line); border-radius:9px;
                          color:var(--text); font:inherit; padding:8px 10px; width:100%; }
  input:focus,select,textarea:focus { outline:1px solid var(--accent); }
  textarea { min-height:74px; resize:vertical; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  .check { display:flex; align-items:center; gap:8px; font-size:13px; }
  .check input { width:auto; }
  button.btn { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:9px 18px;
               font:inherit; cursor:pointer; }
  button.btn.ghost { background:var(--panel2); border:1px solid var(--line); color:var(--text); }
  button.btn:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .status { display:flex; gap:22px; flex-wrap:wrap; }
  .stat { min-width:130px; }
  .stat .k { font-size:12px; color:var(--muted); }
  .stat .v { font-size:15px; margin-top:2px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; vertical-align:1px; }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--bad); } .dot.warn { background:var(--warn); }
  pre.log { background:#080a0e; border:1px solid var(--line); border-radius:10px; padding:12px;
            max-height:340px; overflow:auto; font-size:12px; color:#9fb0c9; margin:0; }
  .toast { position:fixed; right:20px; bottom:20px; background:var(--panel2); border:1px solid var(--line);
           border-left:3px solid var(--accent); border-radius:10px; padding:12px 16px; max-width:460px;
           box-shadow:0 10px 30px rgba(0,0,0,.45); display:none; white-space:pre-wrap; }
  .toast.show { display:block; } .toast.ok { border-left-color:var(--ok); } .toast.bad { border-left-color:var(--bad); }
  code { background:var(--panel2); padding:1px 6px; border-radius:5px; font-size:12px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>聊天桥接 · 控制台</h1>
  <div class="sub" id="subtitle">正在读取状态…</div>
</header>
<nav>
  <button data-tab="status" class="active">状态</button>
  <button data-tab="model">模型与密钥</button>
  <button data-tab="wechat">微信</button>
  <button data-tab="bot">QQ / OneBot</button>
  <button data-tab="chat">聊天设置</button>
  <button data-tab="log">运行日志</button>
</nav>
<main>
  <section id="tab-status" class="active">
    <div class="card">
      <h2>运行状态</h2>
      <div class="status" id="status-grid"></div>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="btn-chat">打开聊天窗口</button>
        <button class="btn ghost" id="btn-restart-runtime">重启智能体运行时</button>
        <button class="btn ghost" id="btn-restart-bot">重连机器人</button>
        <button class="btn ghost" id="btn-test-runtime">测试模型连通性</button>
      </div>
    </div>
    <div class="card">
      <h2>说明</h2>
      <div class="sub" id="howto"></div>
    </div>
  </section>

  <section id="tab-model">
    <div class="card">
      <h2>模型路由</h2>
      <div class="grid">
        <div class="field"><label>服务商</label><input id="dsh-provider"></div>
        <div class="field"><label>模型</label><input id="dsh-model"></div>
        <div class="field"><label>推理强度</label>
          <select id="dsh-effort">
            <option value="">（用模型默认）</option>
            <option value="off">off</option><option value="low">low</option>
            <option value="high">high</option><option value="max">max</option>
          </select>
        </div>
        <div class="field"><label>单条消息超时（毫秒）</label><input id="dsh-turn-timeout" type="number"></div>
      </div>
    </div>
    <div class="card">
      <h2>DeepSeek API Key</h2>
      <div class="grid">
        <div class="field" style="grid-column:1/-1">
          <label>API Key</label>
          <input id="api-key" type="password" placeholder="sk-…（留空表示不修改）" autocomplete="off">
          <span class="hint" id="api-key-hint"></span>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="btn-save-key">保存密钥</button>
        <button class="btn ghost" id="btn-clear-key">清除已存密钥</button>
      </div>
    </div>
  </section>

  <section id="tab-wechat">
    <div class="card">
      <h2>智能体工作目录</h2>
      <div class="hint" style="margin-bottom:12px">
        微信里让它做的事（读写文件、跑命令）都发生在这个目录内。<b>它和微信收发是两件事</b>，但放在这里，
        是因为它出问题时你正是在微信里先感觉到的。
      </div>
      <div class="field">
        <label>目录</label>
        <input id="dsh-cwd" placeholder="留空 = 使用桥接服务所在目录">
        <span class="hint">改完点页面底部“应用并重启”。</span>
      </div>
      <div class="row">
        <button id="btn-cwd-check" class="ghost">检查这个目录</button>
        <button id="btn-cwd-create" class="ghost">创建并检查</button>
      </div>
      <div id="cwd-result" class="hint"></div>
      <span class="hint">
        为什么要检查：DSH 启动时要在工作目录上写一条自己的授权项。如果那个目录上已经有一条
        <b>旧的、显式的</b>授权残留，这一步会失败，智能体在微信里就会“能聊天但一用工具就报 ACL 错误”。
        换到一个从未被 DSH 当过工作目录的新目录通常就好了。
      </span>
    </div>
    <div class="card">
      <h2>微信（个人号）</h2>
      <div class="hint" style="margin-bottom:12px">
        收消息和发消息是<b>两个独立选择</b>：用哪个工具收、用哪种方式发，互不影响。
        现在只保留微信官方 iLink 机器人接口这一条主线：入站和出站都推荐选 <code>ilink</code>，扫码绑定一次即可长期收发。
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" id="wechat-enabled"> 启用微信路线</label>
        <label class="check"><input type="checkbox" id="wechat-send"> 允许发送</label>
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="field"><label>收消息方式</label>
          <select id="wechat-inbound">
            <option value="ilink">ilink · 微信官方机器人接口（推荐，扫码登录）</option>
            <option value="webhook">webhook · 其它工具把消息 POST 给本服务</option>
            <option value="none">none · 只发不收</option>
          </select>
        </div>
        <div class="field"><label>发消息方式</label>
          <select id="wechat-strategy">
            <option value="ilink">ilink · 与收消息共用官方机器人接口（推荐）</option>
            <option value="command">command · 调用你自己的发送脚本</option>
            <option value="http">http · POST 到你自己的发送接口</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>机器人自己的微信昵称（每行一个）</label>
          <textarea id="wechat-nicknames" placeholder="我的小号"></textarea>
          <span class="hint">用于群聊判断是否 @ 了机器人，并防止它回答自己发出的消息。留空也可以，只是群聊里 @ 判断会更保守。</span>
        </div>
      </div>
    </div>

    <div class="card" id="card-ilink">
      <h2>iLink 扫码登录（微信官方机器人接口）</h2>
      <div class="hint" style="margin-bottom:12px">
        微信官方的机器人接口：扫码绑定一次即可长期收发，不需要装任何额外工具，也不需要开着微信窗口。
        二维码是一个<b>链接</b>，拿到后必须<b>在微信里打开它</b>，具体见下面的「iLink 怎么用」。
        绑定成功后本服务会<b>立刻开始收消息</b>，不用重启；但发送凭证要先<b>给机器人发一条消息</b>才会解锁。
      </div>
      <div class="status" id="ilink-status-grid">
        <div class="stat"><div class="k">登录状态</div><div class="v" id="ilink-loggedin">读取中…</div></div>
        <div class="stat"><div class="k">机器人账号</div><div class="v" id="ilink-account">—</div></div>
        <div class="stat"><div class="k">接口地址</div><div class="v" id="ilink-baseurl" style="font-size:12.5px">—</div></div>
        <div class="stat" style="min-width:100%"><div class="k">凭据文件</div><div class="v" id="ilink-account-path" style="font-size:12.5px">—</div></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="btn-ilink-login">扫码登录</button>
        <button class="btn ghost" id="btn-ilink-check">检查 iLink 连接</button>
      </div>
      <div class="hint" id="ilink-hint" style="margin-top:10px"></div>
      <div class="row" style="margin-top:12px" id="ilink-qr-row" hidden>
        <a id="ilink-qr-link" target="_blank" rel="noreferrer"></a>
        <button class="btn ghost" id="btn-ilink-copy">复制二维码链接</button>
      </div>
      <div id="ilink-login-state" style="margin-top:10px"></div>
      <div class="hint" id="ilink-login-detail"></div>
      <div class="row" style="margin-top:12px" id="ilink-verify-row" hidden>
        <div class="field" style="max-width:220px"><label>手机上的配对码</label>
          <input id="ilink-verify-code" placeholder="手机上显示的数字" autocomplete="off">
        </div>
        <button class="btn" id="btn-ilink-verify">提交配对码</button>
      </div>
      <div class="hint" id="ilink-check-result" style="margin-top:10px"></div>
      <div class="hint" style="margin-top:10px">
        你也可以在命令行里跑 <code>node src/index.mjs --ilink-login --open</code>。
        页面不画二维码图片：拿到的就是一个链接，<b>在微信里打开它</b>才算绑定（见下面「iLink 怎么用」）。
        登录失效（错误码 -14）时回来重新扫一次即可。
        <br>如果扫码后手机上显示「网络错误」：<b>先不要反复重扫</b>（重复绑定可能加重服务端的限制）。
        这多半是账号在服务端的绑定态问题，排查结论与证据见 <code>docs/ilink-scan-findings.md</code>，
        也可以在「微信 → 我 → 设置 → 插件」里确认机器人入口是否已经存在。
      </div>
    </div>

    <div class="card">
      <h2>入站 Webhook</h2>
      <div class="grid">
        <div class="field"><label>监听端口</label><input id="webhook-port" type="number"></div>
        <div class="field"><label>路径</label><input id="webhook-path" placeholder="/message"></div>
        <div class="field" style="grid-column:1/-1"><label>令牌（建议设置）</label><input id="webhook-token" type="password"></div>
      </div>
      <div class="hint" style="margin-top:10px">
        把你的工具指向 <code>http://127.0.0.1:端口/路径</code>，POST 一个 JSON 即可。字段名支持多种写法：<br>
        <code>{"chatId":"wxid_xxx","senderName":"张三","text":"你好"}</code><br>
        <code>{"session_id":"123@chatroom","sender_name":"李四","text":"@机器人 在吗"}</code><br>
        也接受数组批量投递；可用 <code>Authorization: Bearer 令牌</code> 或 <code>?token=</code> 鉴权。
      </div>
    </div>

    <div class="card">
      <h2>出站：外部命令 / HTTP</h2>
      <div class="grid">
        <div class="field" style="grid-column:1/-1"><label>发送命令（command 方式）</label>
          <input id="send-command" placeholder="例如 python、某个 wechat-send.exe 或 .cmd 的绝对路径">
          <span class="hint">本服务会执行它并追加两个参数：<code>收件人显示名</code> 和 <code>正文</code>。脚本可打印一行 <code>{"ok":true}</code> 作为结果；退出码非 0 视为失败。</span>
        </div>
        <div class="field" style="grid-column:1/-1"><label>发送接口 URL（http 方式）</label>
          <input id="send-http-url" placeholder="http://127.0.0.1:9000/send">
          <span class="hint">会 POST <code>{"recipient":"…","text":"…","peerId":"…"}</code> 到该地址。</span>
        </div>
        <div class="field" style="grid-column:1/-1"><label>会话 → 显示名映射</label>
          <textarea id="wechat-recipients" placeholder="12345678@chatroom = 项目群"></textarea>
          <span class="hint">每行 <code>wxid = 显示名</code>。只有 command / http 这两种发送方式需要它；ilink 直接用会话 id 寻址，不用填。</span>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="btn-wechat-apply">保存并重连微信</button>
        <button class="btn ghost" id="btn-wechat-status">检查微信状态</button>
        <button class="btn ghost" id="btn-wechat-test">测试发送通道</button>
      </div>
    </div>

    <div class="card">
      <h2>iLink 怎么用（推荐路线）</h2>
      <div class="hint">
        微信个人号现在只保留官方 iLink 机器人接口这一条主线：不注入 DLL、不读本地数据库、不模拟鼠标键盘，也不需要开着微信窗口。
        <br>· <b>第 1 步 · 扫码绑定</b>：点上面的「扫码登录」，本服务会向微信申请一个二维码<b>链接</b>。
        这个链接<b>必须在微信里打开</b>才算绑定，两种做法都行：<br>
        &nbsp;&nbsp;1）在手机上依次点<b>「我 → 设置 → 插件 → 微信 ClawBot」</b>，从机器人入口进去扫码；
        <br>&nbsp;&nbsp;2）点「复制二维码链接」，把链接发到<b>文件传输助手</b>，再在手机上点开这条消息。
        <br>· <b>第 2 步 · 先给机器人发一条消息</b>：绑定成功后它就是一个普通联系人，会出现在会话列表里，
        但<b>发送凭证要等你先给它发一条消息才会解锁</b>。在那之前页面可能显示「未登录 / 不可用」，这是正常的。
        <br>· <b>第 3 步 · 回来检查</b>：点「检查 iLink 连接」确认能收能发；如果提示登录失效（错误码 -14），重新扫一次即可。
        <br>· <b>收消息方式</b>：选 <code>ilink</code> 时收发都走这个接口；选 <code>webhook</code> 只是让别的工具把消息 POST 进来（解决收，不解决发）；选 <code>none</code> 表示只发不收。
        <br>· <b>发消息方式</b>：<code>ilink</code> 是推荐值；<code>command</code> 走你自己的发送脚本，<code>http</code> 走你自己的发送接口，
        这两种需要上面那张「会话 → 显示名映射」表。
      </div>
    </div>
  </section>

  <section id="tab-bot">
    <div class="card">
      <h2>OneBot 连接方式</h2>
      <div class="grid">
        <div class="field"><label>模式</label>
          <select id="onebot-mode">
            <option value="reverse">reverse · 本服务去连机器人（推荐）</option>
            <option value="forward">forward · 机器人来连本服务</option>
            <option value="http-post">http-post · 机器人用 HTTP 上报</option>
            <option value="off">off · 不启用 QQ（代码保留，随时切回来）</option>
          </select>
        </div>
        <div class="field"><label>机器人 WebSocket 地址</label><input id="onebot-url"></div>
        <div class="field"><label>访问令牌</label><input id="onebot-token" type="password" placeholder="与机器人端一致，没有就留空"></div>
        <div class="field"><label>监听主机</label><input id="onebot-host"></div>
        <div class="field"><label>监听端口</label><input id="onebot-port" type="number"></div>
        <div class="field"><label>机器人 HTTP API</label><input id="onebot-httpapi" placeholder="http://127.0.0.1:3000（http-post 模式必填）"></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn ghost" id="btn-reconnect">保存并重连</button>
      </div>
    </div>
  </section>

  <section id="tab-chat">
    <div class="card">
      <h2>回复行为</h2>
      <div class="grid">
        <div class="field"><label>单条回复最大长度</label><input id="chat-maxreply" type="number"></div>
        <div class="field"><label>会话上下文上限（字符）</label><input id="chat-maxsession" type="number"></div>
        <div class="field"><label>单条入站消息上限（字符）</label><input id="chat-maxinbound" type="number"></div>
        <div class="field"><label>备用会话数</label><input id="chat-prewarm" type="number"></div>
      </div>
      <div class="row" style="margin-top:14px">
        <label class="check"><input type="checkbox" id="chat-requireat"> 群聊需要 @ 机器人才回应</label>
        <label class="check"><input type="checkbox" id="chat-ack"> 收到消息先回「正在处理…」</label>
        <label class="check"><input type="checkbox" id="chat-replyat"> 群聊回复时 @ 对方</label>
        <label class="check"><input type="checkbox" id="chat-quote"> 回复时引用原消息</label>
      </div>
    </div>
    <div class="card">
      <h2>白名单（强烈建议设置）</h2>
      <div class="grid">
        <div class="field"><label>允许的 QQ 号</label><textarea id="chat-users" placeholder="每行一个；留空 = 不限制"></textarea>
          <span class="hint">不限制时，任何加到机器人的好友都能让它在本机执行操作。</span></div>
        <div class="field"><label>允许的群号</label><textarea id="chat-groups" placeholder="每行一个；留空 = 不限制"></textarea></div>
      </div>
    </div>
    <div class="card">
      <h2>本控制台</h2>
      <div class="grid">
        <div class="field"><label>端口</label><input id="web-port" type="number"></div>
        <div class="field"><label>监听主机</label><input id="web-host"></div>
      </div>
      <div class="hint" style="margin-top:8px">改端口后需要手动重启桥接服务（不能自己重启自己）。</div>
    </div>
  </section>

  <section id="tab-log">
    <div class="card">
      <h2>运行日志 <span class="sub" id="log-note"></span></h2>
      <pre class="log" id="log-view">（等待日志…）</pre>
    </div>
  </section>

  <div class="row" style="margin-top:6px">
    <button class="btn" id="btn-apply">应用并重启</button>
    <button class="btn ghost" id="btn-reload">放弃修改，重新读取</button>
    <span class="sub" id="config-path"></span>
  </div>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const toast = (text, kind) => {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show ' + (kind || '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, kind === 'bad' ? 9000 : 5000);
};

let config = null;
let status = null;

document.querySelectorAll('nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + button.dataset.tab));
    if (button.dataset.tab === 'wechat') refreshIlink();
  });
});

async function api(path, options) {
  const response = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok) throw new Error((payload && payload.error) || ('HTTP ' + response.status));
  return payload;
}

function linesToArray(text) {
  const items = String(text || '').split(/[\\n,]/).map((s) => s.trim()).filter((s) => s !== '');
  return items.length === 0 ? null : items.map((s) => (/^\\d+$/.test(s) ? Number(s) : s));
}
function arrayToLines(value) {
  return Array.isArray(value) ? value.join('\\n') : '';
}

/**
 * Assign a stored setting to a <select>, never leaving it blank.
 *
 * A select silently reports an empty value when the setting has no matching
 * option, and saving that empty string then fails validation with a message that
 * points at the config rather than at the real cause — while the UI looked fine
 * the whole time. This has already happened twice (a removed sendStrategy, then
 * onebot.mode), so every enum goes through here and falls back to a legal value.
 *
 * Keep this comment free of backticks: it sits inside the page template literal.
 *
 * @param {string} id - the select's element id.
 * @param {unknown} value - the stored setting.
 * @param {string} fallback - a value the select actually offers.
 * @returns {string} what the select ended up holding.
 */
function setSelect(id, value, fallback) {
  const select = $(id);
  select.value = value === undefined || value === null ? '' : String(value);
  if (select.value === '') select.value = fallback;
  return select.value;
}

function fillForm() {
  $('dsh-provider').value = config.dsh.provider;
  $('dsh-model').value = config.dsh.model;
  $('dsh-effort').value = config.dsh.reasoningEffort ?? '';
  $('dsh-turn-timeout').value = config.dsh.turnTimeoutMs;
  $('dsh-cwd').value = config.dsh.cwd;
  setSelect('onebot-mode', config.onebot.mode, 'off');
  $('onebot-url').value = config.onebot.url;
  $('onebot-token').value = config.onebot.accessToken;
  $('onebot-host').value = config.onebot.host;
  $('onebot-port').value = config.onebot.port;
  $('onebot-httpapi').value = config.onebot.httpApi;
  $('chat-maxreply').value = config.chat.maxReplyChars;
  $('chat-maxsession').value = config.chat.maxSessionChars;
  $('chat-maxinbound').value = config.chat.maxInboundChars;
  $('chat-prewarm').value = config.chat.prewarmCount;
  $('chat-requireat').checked = config.chat.requireAtInGroup === true;
  $('chat-ack').checked = config.chat.ackOnBusy === true;
  $('chat-replyat').checked = config.chat.replyAtInGroup === true;
  $('chat-quote').checked = config.chat.replyToMessage === true;
  $('chat-users').value = arrayToLines(config.chat.allowedUsers);
  $('chat-groups').value = arrayToLines(config.chat.allowedGroups);
  $('web-port').value = config.web.port;
  $('web-host').value = config.web.host;
  const wechat = config.wechat || {};
  $('wechat-enabled').checked = wechat.enabled === true;
  $('wechat-send').checked = wechat.sendEnabled === true;
  setSelect('wechat-inbound', wechat.inbound, 'ilink');
  setSelect('wechat-strategy', wechat.sendStrategy, 'ilink');
  $('wechat-nicknames').value = arrayToLines(wechat.botNicknames);
  $('wechat-recipients').value = mapToLines(wechat.recipients);
  const webhook = wechat.webhook || {};
  $('webhook-port').value = webhook.port ?? '';
  $('webhook-path').value = webhook.path || '/message';
  $('webhook-token').value = webhook.token || '';
  $('send-command').value = (wechat.command && wechat.command.command) || '';
  $('send-http-url').value = (wechat.http && wechat.http.url) || '';
  $('config-path').textContent = config.configPath ? ('配置文件：' + config.configPath) : '';
}

/** Render a key/value map as "key = value" lines. */
function mapToLines(map) {
  if (!map || typeof map !== 'object') return '';
  return Object.entries(map).map(([key, value]) => key + ' = ' + value).join('\\n');
}

/** Parse "key = value" lines back into a map (empty object when none). */
function linesToMap(text) {
  const lines = String(text || '').split('\\n').map((s) => s.trim()).filter((s) => s !== '');
  if (lines.length === 0) return {};
  const map = {};
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key !== '' && value !== '') map[key] = value;
  }
  return map;
}

function readForm() {
  return {
    dsh: {
      provider: $('dsh-provider').value.trim(),
      model: $('dsh-model').value.trim(),
      reasoningEffort: $('dsh-effort').value,
      turnTimeoutMs: Number($('dsh-turn-timeout').value),
      cwd: $('dsh-cwd').value.trim(),
    },
    onebot: {
      mode: $('onebot-mode').value,
      url: $('onebot-url').value.trim(),
      accessToken: $('onebot-token').value,
      host: $('onebot-host').value.trim(),
      port: Number($('onebot-port').value),
      httpApi: $('onebot-httpapi').value.trim(),
    },
    chat: {
      maxReplyChars: Number($('chat-maxreply').value),
      maxSessionChars: Number($('chat-maxsession').value),
      maxInboundChars: Number($('chat-maxinbound').value),
      prewarmCount: Number($('chat-prewarm').value),
      requireAtInGroup: $('chat-requireat').checked,
      ackOnBusy: $('chat-ack').checked,
      replyAtInGroup: $('chat-replyat').checked,
      replyToMessage: $('chat-quote').checked,
      allowedUsers: linesToArray($('chat-users').value),
      allowedGroups: linesToArray($('chat-groups').value),
    },
    web: { port: Number($('web-port').value), host: $('web-host').value.trim() },
    wechat: {
      enabled: $('wechat-enabled').checked,
      sendEnabled: $('wechat-send').checked,
      inbound: $('wechat-inbound').value,
      sendStrategy: $('wechat-strategy').value,
      botNicknames: linesToArray($('wechat-nicknames').value) || [],
      recipients: linesToMap($('wechat-recipients').value),
      webhook: {
        port: Number($('webhook-port').value),
        path: $('webhook-path').value.trim() || '/message',
        token: $('webhook-token').value,
      },
      command: { command: $('send-command').value.trim() },
      http: { url: $('send-http-url').value.trim() },
    },
  };
}

function renderStatus() {
  if (!status) return;
  // The config may still be in flight when a status poll lands first, so every
  // read below falls back to a neutral value instead of throwing.
  const cfg = config || {};
  const onebotUrl = (cfg.onebot && cfg.onebot.url) || 'ws://127.0.0.1:3001';
  const cwd = (cfg.dsh && cfg.dsh.cwd) || '(桥接服务所在目录)';
  const wechatOn = status.wechatEnabled === true;
  const dot = (ok) => '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>';
  const runtimeOk = status.runtimeReady;
  const botOk = status.transport && status.transport.indexOf('websocket') === 0;
  const uptime = Math.round((status.uptimeMs || 0) / 1000);
  const mm = Math.floor(uptime / 60), ss = uptime % 60;
  $('status-grid').innerHTML = [
    '<div class="stat"><div class="k">智能体运行时</div><div class="v">' + dot(runtimeOk) + (runtimeOk ? '就绪' : (status.restarting ? '重启中…' : '未就绪')) + '</div></div>',
    '<div class="stat"><div class="k">机器人连接</div><div class="v">' + dot(botOk) + (status.transport || '未知') + '</div></div>',
    wechatOn
      ? '<div class="stat"><div class="k">微信</div><div class="v">' + dot(String(status.transport || '').indexOf('wechat') === 0) + (status.wechatSendEnabled ? '收发' : '只收不回') + '</div></div>'
      : '',
    '<div class="stat"><div class="k">进行中的会话</div><div class="v">' + status.conversations + '</div></div>',
    '<div class="stat"><div class="k">已开会话总数</div><div class="v">' + status.sessions + '</div></div>',
    '<div class="stat"><div class="k">运行时长</div><div class="v">' + mm + ' 分 ' + ss + ' 秒</div></div>',
    '<div class="stat"><div class="k">dsh 可执行文件</div><div class="v" style="font-size:12.5px">' + (status.dsh && status.dsh.found ? '已找到' : '未找到') + '</div></div>',
  ].join('');
  $('subtitle').textContent = '运行时 ' + (runtimeOk ? '就绪' : '未就绪') + ' · 机器人 ' + (status.transport || '未知') +
    ' · 会话 ' + status.conversations + (status.lastError ? ' · 最近错误：' + status.lastError : '');
  $('howto').innerHTML = [
    '1. 在「机器人连接」里选好模式并保存。NapCat 侧用反向 WebSocket 指向 <code>' + onebotUrl + '</code> 即可。',
    '2. 在「模型与密钥」里确认模型路由，必要时填入 API Key。',
    '3. 用手机私聊机器人发一句「你好」；群里需要 @ 它。',
    '4. 智能体的工作目录是 <code>' + cwd + '</code>，它在微信里做的事都发生在那里。',
  ].join('<br>');
  const busy = status.restarting === true;
  ['btn-restart-runtime', 'btn-restart-bot', 'btn-apply', 'btn-save-key'].forEach((id) => { $(id).disabled = busy; });
}

async function refreshStatus() {
  try {
    status = await api('/api/status');
    $('api-key-hint').textContent = status.apiKeySet
      ? ('已保存密钥' + (status.apiKeyFromEnv ? '，但环境变量 DEEPSEEK_API_KEY 优先级更高' : '') + ' · 文件：' + status.credentialsPath)
      : ('尚未保存密钥 · 文件：' + status.credentialsPath);
    renderStatus();
  } catch (error) {
    $('subtitle').textContent = '无法连接桥接服务：' + error.message;
  }
}

async function loadConfig() {
  try {
    const payload = await api('/api/config');
    // The endpoint answers an envelope of config + path + status; the form works
    // on the inner document, not on the envelope itself.
    if (!payload || typeof payload.config !== 'object' || payload.config === null) {
      throw new Error('服务返回的配置为空');
    }
    config = payload.config;
    if (payload.status) status = payload.status;
    fillForm();
    renderStatus();
  } catch (error) {
    toast('读取配置失败：' + error.message, 'bad');
  }
}

async function apply(options) {
  try {
    toast('正在应用…');
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(options || readForm()) });
    config = result.config || config;
    fillForm();
    status = result.status || status;
    renderStatus();
    toast('已保存并重启完成', 'ok');
  } catch (error) {
    toast('应用失败：' + error.message, 'bad');
  }
}

$('btn-apply').onclick = () => apply();
$('btn-reload').onclick = () => loadConfig();

// 工作目录检查：DSH 启动时要在工作目录上写一条自己的授权项，目录里若已有旧的
// 显式残留就会失败，表现是「能聊天但一用工具就 ACL 报错」。这里把判断依据摊开给用户。
async function checkWorkspace(create) {
  const path = $('dsh-cwd').value.trim();
  const box = $('cwd-result');
  if (path === '') { box.textContent = '先填一个目录；留空表示用桥接服务所在目录。'; return; }
  box.textContent = create ? '正在创建并检查…' : '正在检查…';
  try {
    const r = await api('/api/workspace/check', { method: 'POST', body: JSON.stringify({ path: path, create: create === true }) });
    const lines = [];
    lines.push(r.exists ? (r.created ? '已创建目录：' + r.path : '目录存在：' + r.path) : '目录不存在：' + r.path);
    if (r.exists) {
      lines.push('可写：' + (r.writable ? '是' : '否') + '（桥接服务进程的实际写入测试）');
      lines.push('DSH 显式授权项：' + (r.grantCount > 0
        ? '有 ' + r.grantCount + ' 条 —— 这个目录被 DSH 当过工作目录'
        : '没有 —— 从未被 DSH 当过工作目录'));
      lines.push('是当前桥接服务的工作目录：' + (r.isProcessCwd ? '是' : '否'));
    }
    lines.push('结论：' + r.hint);
    box.textContent = lines.join('\\n');
  } catch (e) {
    box.textContent = '检查失败：' + e.message;
  }
}
$('btn-cwd-check').onclick = () => checkWorkspace(false);
$('btn-cwd-create').onclick = () => checkWorkspace(true);

$('btn-chat').onclick = () => window.open('/', '_blank');
$('btn-wechat-apply').onclick = async () => {
  await apply(readForm());
  try { await api('/api/bot/reconnect', { method: 'POST' }); toast('微信连接已重建', 'ok'); } catch (e) { toast('重连失败：' + e.message, 'bad'); }
  refreshStatus();
};
$('btn-wechat-status').onclick = async () => {
  try {
    const info = await api('/api/wechat/status');
    if (!info.enabled) { toast('微信路线未启用（先勾选「启用微信路线」并保存）', 'bad'); return; }
    // iLink 的 ret=0 只代表腾讯受理了，不代表对方收到（见 docs/ilink-scan-findings.md
    // 与 openclaw#79293），所以这里不能把 ok 直接说成「成功」。
    const sent = info.lastSend
      ? (info.lastSend.ok
          ? (info.lastSend.delivered === 'no' ? '未送达' : '已受理，送达未确认')
          : '失败')
      : '';
    toast(
      '收消息：' + info.provider + ' — ' + (info.inboundOk ? '正常' : '不可用') + '（' + info.inboundDetail + '）' +
        '\\n发消息：' + (info.sendEnabled ? info.sendStrategy : '未启用（只收不回）') +
        (info.sendCredentialState && info.sendCredentialState !== 'ready'
          ? '\\n发送凭证：' + (info.sendCredentialDetail || info.sendCredentialState)
          : '') +
        (info.replyLimitChars && isFinite(info.replyLimitChars)
          ? '\\n单条回复上限：' + info.replyLimitChars + ' 字（超出部分省略，避免长消息被腾讯静默丢弃）'
          : '') +
        (info.lastSend ? '\\n上次发送：' + sent + ' — ' + info.lastSend.detail : ''),
      info.inboundOk ? 'ok' : 'bad',
    );
  } catch (e) { toast('检查失败：' + e.message, 'bad'); }
};
$('btn-wechat-test').onclick = async () => {
  toast('正在测试发送通道…');
  try {
    const result = await api('/api/wechat/probe', { method: 'POST' });
    toast((result.ok ? '可用：' : '不可用：') + result.detail, result.ok ? 'ok' : 'bad');
  } catch (e) { toast('测试失败：' + e.message, 'bad'); }
};

// ---- iLink 扫码登录 ------------------------------------------------------
let ilink = null;
let ilinkTimer = null;

/** Read one string field off a possibly-missing API payload. */
function ilinkValue(info, key, fallback) {
  const value = info ? info[key] : null;
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

/** The one-line label for a login state. */
function ilinkStateLabel(info) {
  const state = ilinkValue(info, 'state', 'idle');
  if (info && info.alreadyBound === true) return '这个微信号已经绑定过机器人';
  if (state === 'waiting') return '等待扫码…';
  if (state === 'scaned') return '已扫码，请在手机上确认';
  if (state === 'confirmed') return '登录成功，已开始收发消息';
  if (state === 'failed') return '登录失败';
  if (state === 'expired') return '二维码已过期';
  return '未在登录';
}

function startIlinkPolling() {
  if (ilinkTimer !== null) return;
  ilinkTimer = setInterval(refreshIlink, 2000);
}
function stopIlinkPolling() {
  if (ilinkTimer === null) return;
  clearInterval(ilinkTimer);
  ilinkTimer = null;
}

function renderIlink() {
  const info = ilink || {};
  const loggedIn = info.loggedIn === true;
  const available = info.available === true;
  const url = ilinkValue(info, 'url', '');
  const attempt = Number(info.attempt || 0);

  $('ilink-loggedin').innerHTML = '<span class="dot ' + (loggedIn ? 'ok' : 'bad') + '"></span>' + (loggedIn ? '已登录' : '未登录');
  $('ilink-account').textContent = loggedIn || info.accountUser ? (ilinkValue(info, 'accountUser', '未知账号') + (info.accountBot ? (' · ' + info.accountBot) : '')) : '—';
  $('ilink-baseurl').textContent = ilinkValue(info, 'baseUrl', '—');
  $('ilink-account-path').textContent = ilinkValue(info, 'accountPath', '—');
  $('btn-ilink-login').disabled = !available;
  $('ilink-hint').textContent = available
    ? (loggedIn ? '已保存凭据，服务重启后会自动继续接收；换一个微信号就再扫一次。' : '点「扫码登录」，然后用手机微信扫描下面出现的二维码链接。')
    : ilinkValue(info, 'availableDetail', '当前无法扫码登录：请先启用微信路线并把收消息方式选成 ilink。');

  $('ilink-qr-row').hidden = url === '';
  $('ilink-qr-link').href = url;
  $('ilink-qr-link').textContent = url === '' ? '' : ('打开二维码：' + url);

  $('ilink-login-state').innerHTML = '<b>' + ilinkStateLabel(info) + '</b>' + (attempt > 1 ? ('（第 ' + attempt + ' 个二维码）') : '');
  $('ilink-login-detail').textContent = ilinkValue(info, 'detail', '');
  $('ilink-verify-row').hidden = info.needVerifyCode !== true;
  if (info.running === true) startIlinkPolling();
  else stopIlinkPolling();
}

async function refreshIlink() {
  try {
    ilink = await api('/api/wechat/ilink/login');
    renderIlink();
  } catch (error) {
    $('ilink-login-detail').textContent = '读取 iLink 登录状态失败：' + error.message;
  }
}

/** Ask the running route what it thinks of the stored credential (the -14 case). */
async function checkIlinkConnection() {
  try {
    const info = await api('/api/wechat/status');
    if (info.enabled !== true) {
      $('ilink-check-result').textContent = '微信路线未启用：请先勾选「启用微信路线」并保存。';
      return false;
    }
    const ok = info.inboundOk === true;
    $('ilink-check-result').textContent =
      'iLink 连接自检：' + (ok ? '正常' : '不可用') + ' — ' + ilinkValue(info, 'inboundDetail', '（服务端没有返回详情）');
    return ok;
  } catch (error) {
    $('ilink-check-result').textContent = '连接自检失败：' + error.message;
    return false;
  }
}

$('btn-ilink-login').onclick = async () => {
  $('ilink-login-detail').textContent = '正在向微信申请二维码…';
  try {
    ilink = await api('/api/wechat/ilink/login', { method: 'POST', body: JSON.stringify({}) });
    renderIlink();
    if (ilink.ok === false) toast(ilinkValue(ilink, 'detail', '无法开始扫码登录'), 'bad');
    else if (ilinkValue(ilink, 'url', '') === '') toast('二维码正在获取，请稍候…');
    else toast('请用手机微信扫描下面的二维码链接', 'ok');
  } catch (error) {
    toast('开始扫码登录失败：' + error.message, 'bad');
  }
};
$('btn-ilink-copy').onclick = () => {
  const url = ilinkValue(ilink, 'url', '');
  if (url === '') { toast('还没有二维码链接：先点「扫码登录」', 'bad'); return; }
  const clipboard = window.navigator && window.navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    clipboard.writeText(url).then(() => toast('二维码链接已复制', 'ok'), () => toast('复制失败，请手动复制：' + url, 'bad'));
  } else {
    toast('这个浏览器不允许自动复制，请手动复制：' + url);
  }
};
$('btn-ilink-verify').onclick = async () => {
  const code = $('ilink-verify-code').value.trim();
  if (code === '') { toast('请先填写手机上显示的配对码', 'bad'); return; }
  try {
    ilink = await api('/api/wechat/ilink/login', { method: 'POST', body: JSON.stringify({ verifyCode: code }) });
    $('ilink-verify-code').value = '';
    renderIlink();
    if (ilink.ok === false) toast(ilinkValue(ilink, 'detail', '配对码提交失败'), 'bad');
    else toast('配对码已提交，正在等待微信确认…', 'ok');
  } catch (error) {
    toast('提交配对码失败：' + error.message, 'bad');
  }
};
$('btn-ilink-check').onclick = async () => {
  $('ilink-check-result').textContent = '正在检查…';
  const ok = await checkIlinkConnection();
  toast($('ilink-check-result').textContent, ok ? 'ok' : 'bad');
};

$('btn-reconnect').onclick = async () => {
  await apply(readForm());
  try { await api('/api/bot/reconnect', { method: 'POST' }); toast('机器人传输已重连', 'ok'); } catch (e) { toast('重连失败：' + e.message, 'bad'); }
  refreshStatus();
};
$('btn-restart-runtime').onclick = async () => {
  toast('正在重启运行时…');
  try { status = await api('/api/runtime/restart', { method: 'POST' }); renderStatus(); toast('运行时已重启', 'ok'); }
  catch (e) { toast('重启失败：' + e.message, 'bad'); }
};
$('btn-restart-bot').onclick = async () => {
  try { status = await api('/api/bot/reconnect', { method: 'POST' }); renderStatus(); toast('机器人传输已重连', 'ok'); }
  catch (e) { toast('重连失败：' + e.message, 'bad'); }
};
$('btn-test-runtime').onclick = async () => {
  toast('正在测试（会启动一个临时运行时，约 3-10 秒）…');
  try {
    const result = await api('/api/runtime/test', { method: 'POST' });
    toast('测试结果：' + result.message, result.ok ? 'ok' : 'bad');
  } catch (e) { toast('测试失败：' + e.message, 'bad'); }
};
$('btn-save-key').onclick = async () => {
  const key = $('api-key').value.trim();
  if (key === '') { toast('请先填写 API Key（清除请用右侧按钮）', 'bad'); return; }
  toast('正在保存密钥并重启运行时…');
  try {
    const result = await api('/api/credentials', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    $('api-key').value = '';
    status = result.status || status;
    renderStatus();
    toast('密钥已保存，运行时已重启', 'ok');
  } catch (e) { toast('保存失败：' + e.message, 'bad'); }
};
$('btn-clear-key').onclick = async () => {
  if (!confirm('确定清除已保存的 DeepSeek API Key？')) return;
  try {
    const result = await api('/api/credentials', { method: 'POST', body: JSON.stringify({ apiKey: '' }) });
    status = result.status || status;
    renderStatus();
    toast('已清除', 'ok');
  } catch (e) { toast('清除失败：' + e.message, 'bad'); }
};

const logView = $('log-view');
let logBuffer = [];
function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 400) logBuffer = logBuffer.slice(-400);
  logView.textContent = logBuffer.join('\\n');
  logView.scrollTop = logView.scrollHeight;
}
fetch('/api/logs').then((r) => r.json()).then((data) => {
  $('log-note').textContent = '（缓冲 ' + data.lines.length + ' 行）';
  data.lines.forEach(pushLog);
}).catch(() => {});
const events = new EventSource('/events');
events.onmessage = (message) => {
  const payload = JSON.parse(message.data);
  if (payload.kind === 'log') pushLog(payload.text);
};

refreshStatus();
loadConfig();
// The iLink card starts with a local snapshot, then one connection probe so an
// expired credential (-14) is visible without clicking anything.
refreshIlink().then(() => checkIlinkConnection());
setInterval(refreshStatus, 4000);
</script>
</body>
</html>
`
