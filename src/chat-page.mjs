/**
 * The local chat page served at `/`.
 *
 * It exists so the whole chain — message → gateway → DSH runtime → model →
 * chunked reply — can be exercised before any bot is connected, and so a
 * packaged install has something to talk to immediately.
 */

export const CHAT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>聊天桥接 · 聊天测试</title>
<style>
  :root { color-scheme:dark; --bg:#0b0d12; --panel:#141821; --panel2:#1b202b; --line:#262d3b;
          --text:#e8ecf4; --muted:#8b95ab; --me:#2f6fd0; }
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text);
         font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .pill { font-size:12px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:2px 11px; }
  header a { margin-left:auto; font-size:12.5px; color:#6ea8fe; text-decoration:none; border:1px solid var(--line);
             border-radius:9px; padding:6px 12px; }
  header a:hover { border-color:#3b82f6; color:#fff; }
  main { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; }
  .row { display:flex; } .row.me { justify-content:flex-end; }
  .bubble { max-width:min(780px,86%); padding:10px 14px; border-radius:14px; white-space:pre-wrap;
            word-break:break-word; }
  .me .bubble { background:var(--me); }
  .bot .bubble { background:var(--panel); border:1px solid var(--line); }
  .sys .bubble { background:transparent; border:1px dashed var(--line); color:var(--muted); font-size:12.5px; }
  form { display:flex; gap:10px; padding:14px 20px; border-top:1px solid var(--line); background:var(--panel); }
  textarea { flex:1; resize:none; height:56px; padding:12px 14px; border-radius:12px; border:1px solid var(--line);
             background:#0a0c11; color:inherit; font:inherit; }
  textarea:focus { outline:1px solid #3b82f6; }
  button { padding:0 22px; border:0; border-radius:12px; background:#3b82f6; color:#fff; font:inherit; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
<header>
  <h1>聊天测试</h1>
  <span class="pill" id="status">连接中…</span>
  <span class="pill">这里与真实微信消息走同一条管线</span>
  <a href="/console">控制台</a>
</header>
<main id="main"></main>
<form id="form">
  <textarea id="input" placeholder="输入消息，回车发送（/help 查看命令）"></textarea>
  <button type="submit" id="send">发送</button>
</form>
<script>
  const main = document.getElementById('main');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const statusEl = document.getElementById('status');

  function addRow(kind, text) {
    const row = document.createElement('div');
    row.className = 'row ' + kind;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    main.appendChild(row);
    main.scrollTop = main.scrollHeight;
    return bubble;
  }

  async function refreshStatus() {
    try {
      const info = await (await fetch('/api/status')).json();
      statusEl.textContent = '运行时 ' + (info.runtimeReady ? '就绪' : '未就绪') + ' · ' + info.transport +
        ' · 会话 ' + info.conversations;
    } catch { statusEl.textContent = '服务不可用'; }
  }

  const events = new EventSource('/events');
  events.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    if (payload.kind === 'transcript') { addRow(payload.role === 'user' ? 'me' : 'bot', payload.text); refreshStatus(); }
    else if (payload.kind === 'log' && payload.text.includes('progress:')) addRow('sys', payload.text.split('progress: ')[1]);
  };
  events.onerror = () => { statusEl.textContent = '连接已断开'; };

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    send.disabled = true;
    addRow('me', text);
    try {
      await fetch('/api/send', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ text }) });
    } catch (error) { addRow('sys', '发送失败：' + error); }
    finally { send.disabled = false; input.focus(); }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.getElementById('form').requestSubmit(); }
  });

  refreshStatus();
  setInterval(refreshStatus, 5000);
  input.focus();
</script>
</body>
</html>
`
