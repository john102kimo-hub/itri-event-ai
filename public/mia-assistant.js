// 後台助理——右下角的胖胖米亞（批次 141）。每一個要管理員密碼的後台頁都用 <script src="/mia-assistant.js" defer></script> 引入。
//
// 它只做三件事：把使用者的話送到 /api/events（action=assistant_chat）、把回答顯示出來、
// 顯示「確認卡」並在使用者按下「確認」後執行。
//
// ⚠️ 確認卡要執行的請求，這裡再擋一次（ALLOWED）：只允許新增記者、修改記者、新增活動草稿、記住／忘掉一件事這幾種，
// 打的網址與 action 都要在白名單裡。伺服器端的 propose_action 本來就只會產生這三種，這裡是第二道門——
// 回應被竄改或以後有人改壞伺服器端時，頁面也不會去打刪除、發布、改設定之類的 API。
// 要擴充提議的種類，請伺服器端（lib/assistant.js）與這裡的 ALLOWED 一起改。
//
// 密碼用的是各頁登入時存進 sessionStorage 的 itri_pwd（同分頁導覽免重登，跟成效報告、活動報名等頁一致）；
// 沒有登入就不顯示按鈕。所有顯示一律用 textContent，模型回的字不會被當成 HTML。
(function () {
  'use strict';
  if (window.__miaAssistant) return;
  window.__miaAssistant = true;

  var STORE_KEY = 'mia_assist_v1';
  var ALLOWED = [
    { url: '/api/media', actions: ['add', 'update'] },
    { url: '/api/events', actions: ['create', 'assistant_remember', 'assistant_forget'] }
  ];
  var CHIPS = ['這幾天記者問了什麼？', '最近有哪些活動？', '報名狀況怎麼樣？', 'AI 追蹤最近表現如何？'];

  // 頭像：右下角的按鈕是會眨眼的動態圖，查資料時對話框裡是拿放大鏡的動態圖；對話框標題與「減少動態效果」的使用者用靜態圖。
  var STILL = '/mia-avatar.png', IDLE = '/mia-avatar-idle.webp', BUSY = '/mia-avatar-busy.webp';
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  function avatar(src, alt) {
    var img = document.createElement('img');
    img.src = reduced ? STILL : src; img.alt = alt || '';
    img.onerror = function () { img.onerror = null; img.src = STILL; }; // 動態圖載入失敗就退回靜態圖
    return img;
  }

  function pwd() { try { return sessionStorage.getItem('itri_pwd') || ''; } catch (e) { return ''; } }
  function load() { try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]') || []; } catch (e) { return []; } }
  function save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state.log.slice(-40))); } catch (e) {} }

  // log 項目：{role:'user'|'assistant', text} 或 {role:'card', proposal, status:'pending'|'done'|'cancelled'|'error', note}
  var state = { log: load(), busy: false, open: false };

  var css = [
    '#mia-fab{position:fixed;right:18px;bottom:18px;width:68px;height:68px;border-radius:50%;border:3px solid #fff;background:#dbeafe;box-shadow:0 6px 20px rgba(15,23,42,.28);cursor:pointer;padding:0;z-index:9000;display:none;overflow:hidden;transition:transform .15s}',
    '#mia-fab:hover{transform:scale(1.06)}',
    '#mia-fab img{width:100%;height:100%;object-fit:cover;display:block}',
    '.mia-m.busy{display:flex;align-items:center;gap:8px;padding:6px 12px 6px 6px}',
    '.mia-m.busy img{width:44px;height:44px;border-radius:50%;flex:none}',
    '#mia-panel{position:fixed;right:18px;bottom:96px;width:372px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 120px);background:#fff;border-radius:18px;box-shadow:0 14px 48px rgba(15,23,42,.3);z-index:9001;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#0f172a}',
    '#mia-panel.open{display:flex}',
    '#mia-head{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#1d4ed8;color:#fff}',
    '#mia-head img{width:38px;height:38px;border-radius:50%;background:#dbeafe;object-fit:cover}',
    '#mia-head .t{flex:1;font-size:.95rem;font-weight:700;line-height:1.25}',
    '#mia-head .t small{display:block;font-weight:400;font-size:.72rem;opacity:.85}',
    '#mia-head button{background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:8px;padding:5px 9px;font-size:.78rem;cursor:pointer}',
    '#mia-msgs{flex:1;overflow-y:auto;padding:12px;background:#f1f5f9;display:flex;flex-direction:column;gap:9px}',
    '.mia-m{max-width:86%;padding:9px 12px;border-radius:14px;font-size:.88rem;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
    '.mia-m.u{align-self:flex-end;background:#1d4ed8;color:#fff;border-bottom-right-radius:4px}',
    '.mia-m.a{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}',
    '.mia-m.a.err{background:#fef2f2;border-color:#fecaca;color:#991b1b}',
    '.mia-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.mia-chips button{background:#fff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:16px;padding:6px 11px;font-size:.8rem;cursor:pointer}',
    '.mia-card{align-self:stretch;background:#fff;border:2px solid #93c5fd;border-radius:14px;padding:11px 12px;font-size:.86rem}',
    '.mia-card h4{margin:0 0 6px;font-size:.9rem;color:#1d4ed8}',
    '.mia-card dl{margin:0 0 9px;display:grid;grid-template-columns:auto 1fr;gap:3px 10px}',
    '.mia-card dt{color:#64748b}.mia-card dd{margin:0;word-break:break-all}',
    '.mia-card .row{display:flex;gap:8px}',
    '.mia-card button{flex:1;border-radius:9px;padding:8px;font-size:.84rem;font-weight:700;cursor:pointer;border:1px solid #cbd5e1;background:#fff}',
    '.mia-card button.ok{background:#1d4ed8;border-color:#1d4ed8;color:#fff}',
    '.mia-card button:disabled{opacity:.5;cursor:default}',
    '.mia-card .st{font-size:.82rem;margin-top:2px}',
    '#mia-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}',
    '#mia-input{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:12px;padding:9px 11px;font:inherit;font-size:16px;max-height:90px;outline:none}',
    '#mia-input:focus{border-color:#1d4ed8}',
    '#mia-send{background:#1d4ed8;color:#fff;border:none;border-radius:12px;padding:0 16px;font-size:.88rem;font-weight:700;cursor:pointer}',
    '#mia-send:disabled{opacity:.5;cursor:default}',
    '@media (max-width:520px){#mia-panel{right:8px;left:8px;width:auto;max-width:none;bottom:92px}#mia-fab{right:12px;bottom:12px}}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var fab, panel, msgs, input, sendBtn;

  function build() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    fab = el('button');
    fab.id = 'mia-fab'; fab.type = 'button'; fab.title = '問米亞'; fab.setAttribute('aria-label', '開啟後台小幫手米亞');
    fab.appendChild(avatar(IDLE, '米亞'));
    fab.onclick = toggle;

    panel = el('div'); panel.id = 'mia-panel';
    var head = el('div'); head.id = 'mia-head';
    var himg = document.createElement('img'); himg.src = STILL; himg.alt = '';
    var t = el('div', 't', '米亞・後台小幫手'); t.appendChild(el('small', '', '可以問活動、報名、記者名單、問答與 AI 追蹤；也能教我記事情'));
    var clear = el('button', '', '清除'); clear.type = 'button'; clear.onclick = function () { state.log = []; save(); render(); };
    var close = el('button', '', '✕'); close.type = 'button'; close.setAttribute('aria-label', '關閉'); close.onclick = toggle;
    head.appendChild(himg); head.appendChild(t); head.appendChild(clear); head.appendChild(close);

    msgs = el('div'); msgs.id = 'mia-msgs';
    var form = el('form'); form.id = 'mia-form';
    input = el('textarea'); input.id = 'mia-input'; input.rows = 1; input.placeholder = '想問什麼？Enter 送出';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    sendBtn = el('button', '', '送出'); sendBtn.id = 'mia-send'; sendBtn.type = 'submit';
    form.appendChild(input); form.appendChild(sendBtn);
    form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });

    panel.appendChild(head); panel.appendChild(msgs); panel.appendChild(form);
    document.body.appendChild(fab); document.body.appendChild(panel);
    render();
    syncVisible();
    setInterval(syncVisible, 1500); // 登入／登出後按鈕跟著出現或消失
  }

  function syncVisible() {
    var on = !!pwd();
    fab.style.display = on ? 'block' : 'none';
    if (!on && state.open) { state.open = false; panel.classList.remove('open'); }
  }

  function toggle() {
    state.open = !state.open;
    panel.classList.toggle('open', state.open);
    if (state.open) { render(); setTimeout(function () { try { input.focus(); } catch (e) {} }, 50); }
  }

  function render() {
    msgs.textContent = '';
    if (!state.log.length) {
      msgs.appendChild(el('div', 'mia-m a', '嗨，我是米亞！可以直接問我後台的資料，例如活動、報名狀況、記者名單、記者問了什麼、AI 追蹤。也可以請我新增記者或活動草稿——我會先做一張確認卡，你按「確認」才會真的寫進去。'));
      var chips = el('div', 'mia-chips');
      CHIPS.forEach(function (c) { var b = el('button', '', c); b.type = 'button'; b.onclick = function () { ask(c); }; chips.appendChild(b); });
      msgs.appendChild(chips);
    }
    state.log.forEach(function (m, i) {
      if (m.hidden) return; // 卡片後續（remember）：要送給模型、不顯示
      if (m.role === 'card') return msgs.appendChild(cardEl(m, i));
      msgs.appendChild(el('div', 'mia-m ' + (m.role === 'user' ? 'u' : 'a') + (m.err ? ' err' : ''), m.text));
    });
    if (state.busy) { var b = el('div', 'mia-m a busy'); b.appendChild(avatar(BUSY, '')); b.appendChild(el('span', '', '米亞查詢中…')); msgs.appendChild(b); }
    msgs.scrollTop = msgs.scrollHeight;
    sendBtn.disabled = state.busy;
  }

  function allowed(req) {
    return !!req && ALLOWED.some(function (a) { return a.url === req.url && req.body && a.actions.indexOf(req.body.action) >= 0; });
  }

  function cardEl(m, i) {
    var p = m.proposal, card = el('div', 'mia-card');
    card.appendChild(el('h4', '', p.title));
    var dl = el('dl');
    (p.fields || []).forEach(function (f) { dl.appendChild(el('dt', '', f.label)); dl.appendChild(el('dd', '', f.value)); });
    card.appendChild(dl);
    if (m.status === 'pending') {
      var row = el('div', 'row');
      var ok = el('button', 'ok', '確認執行'), no = el('button', '', '取消');
      ok.type = no.type = 'button';
      ok.onclick = function () { execute(i); };
      no.onclick = function () { m.status = 'cancelled'; m.note = '已取消，沒有寫入任何資料。'; remember('（使用者取消了「' + p.title + '」，沒有寫入。）'); save(); render(); };
      row.appendChild(ok); row.appendChild(no); card.appendChild(row);
    } else {
      card.appendChild(el('div', 'st', (m.status === 'done' ? '✅ ' : m.status === 'error' ? '⚠️ ' : '') + (m.note || '')));
    }
    return card;
  }

  // 讓模型下一輪知道這張卡後來怎麼了（它看不到頁面）；用 assistant 訊息帶過去，不會顯示在畫面上
  function remember(text) { state.log.push({ role: 'assistant', text: text, hidden: true }); }

  async function execute(i) {
    var m = state.log[i];
    if (!m || m.status !== 'pending') return;
    var req = m.proposal.request;
    if (!allowed(req)) { m.status = 'error'; m.note = '這個動作不在允許清單內，沒有執行。'; save(); render(); return; }
    m.status = 'working'; m.note = '執行中…'; render();
    try {
      var res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pwd() }, body: JSON.stringify(req.body) });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.error) throw new Error(data.error || ('失敗（' + res.status + '）'));
      m.status = 'done'; m.note = '已完成。頁面上的資料請重新整理一下就會看到。';
      remember('（使用者按了確認，「' + m.proposal.title + '」已經執行完成。）');
      try { window.dispatchEvent(new CustomEvent('mia-assistant-change', { detail: { kind: m.proposal.kind } })); } catch (e) {}
    } catch (e) {
      m.status = 'error'; m.note = '沒有成功：' + e.message;
      remember('（「' + m.proposal.title + '」執行失敗：' + e.message + '，沒有寫入。）');
    }
    save(); render();
  }

  function history() {
    // 只送文字；卡片已經用 remember() 轉成一句話。連續同角色的合併，最後一則一定是使用者
    var out = [];
    state.log.forEach(function (m) {
      if (m.role !== 'user' && m.role !== 'assistant') return;
      if (m.err) return;
      var last = out[out.length - 1];
      if (last && last.role === m.role) last.content += '\n' + m.text; else out.push({ role: m.role, content: m.text });
    });
    return out.slice(-12);
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    if (!pwd()) { state.log.push({ role: 'assistant', text: '請先登入後台再問我。', err: true }); render(); return; }
    input.value = '';
    state.log.push({ role: 'user', text: text.slice(0, 2000) });
    state.busy = true; render();
    try {
      var res = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pwd() }, body: JSON.stringify({ action: 'assistant_chat', messages: history() }) });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 401) throw new Error('密碼不對或已過期，請重新登入後台');
      if (!res.ok || data.error) throw new Error(data.error || ('失敗（' + res.status + '）'));
      state.log.push({ role: 'assistant', text: String(data.reply || '') });
      (data.proposals || []).forEach(function (p) { state.log.push({ role: 'card', proposal: p, status: 'pending' }); });
    } catch (e) {
      state.log.push({ role: 'assistant', text: e.message || '連線失敗，請稍後再試', err: true });
    }
    state.busy = false; save(); render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
