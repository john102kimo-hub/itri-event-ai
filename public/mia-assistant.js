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
  var CHIPS = ['這幾天記者問了什麼？', '報名狀況怎麼樣？', 'AI 追蹤最近表現如何？'];

  // ── 主管快看（批次 170）──────────────────────────────────────────────────────────────
  // 朱朱：「讓比較懶或看不懂的主管，可以快速了解後台狀況、效益、這套系統厲害之處，可透過圖表、圖示呈現，
  // 但務必確保不要太複雜」。所以只有三顆大按鈕，按了直接出圖卡；圖卡**不經過 AI**：
  //   ① 數字是要報給長官的，不能靠模型轉述（CLAUDE.md 第 2 條）；成效數字跟 /report 打同一支 API（report=1），
  //      跟互動簡報一定一致；② 秒出、不花錢、不會「查詢中」等半天。
  // 按鈕固定三顆，不要再往上加——加多了主管就不知道要按哪一顆。要問別的，照舊打字問米亞。
  var QUICK = [
    { key: 'kpi', icon: '📊', label: '一分鐘看成效', sub: '問了幾題、服務幾家媒體、省下多少人力' },
    { key: 'events', icon: '📅', label: '活動近況', sub: '接下來有哪些活動、準備好了沒' },
    { key: 'wow', icon: '✨', label: '這套系統做了什麼', sub: '五個重點，一分鐘看懂' }
  ];
  var MIN_PER_Q = 3; // 每題人工回覆估 3 分鐘：跟成效報告的預設值一樣，兩邊講同一個數字
  var BIZ_TYPES = ['企業說明會', '技術媒合會', '客戶參訪', '技術交流會']; // 同 lib/audience.js
  var WEEK = '日一二三四五六';
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function hoursStr(h) { return h >= 10 ? String(Math.round(h)) : h.toFixed(1); } // 同成效報告
  function taipeiToday(now) { return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); }
  // F 欄只有純日期才算活動日期（後面帶時間的是系統寫的建立時間戳，同 lib/event-status.js eventDateOf）
  function isoDate(raw) { var m = String(raw || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); return m ? m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) : ''; }
  function mdw(iso) { var p = iso.split('-').map(Number); return p[1] + '/' + p[2] + '（' + WEEK[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] + '）'; }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  // 測試用的活動不給主管看（同 lib/report-scope.js isTestEventName）
  function isTestName(n) { var s = String(n || '').trim(); return /測試|請忽略|可刪除|驗證用/.test(s) || /^(pw)?test\d*$|^demo$/i.test(s); }
  function sumCounts(list) { return list.reduce(function (n, e) { return n + (Number(e.count) || 0); }, 0); }

  // A：/api/analytics?summary=1&exclude_test=1&report=1；X：/api/exposure?action=analysis_all（可能是 null）
  function kpiData(A, X) {
    A = A || {};
    var evs = (A.by_event || []).filter(function (e) { return e.audience !== 'business'; }); // 企業場不算（同成效報告）
    var total = A.business_qa ? sumCounts(evs) : (Number(A.total) || 0);
    var hours = total * MIN_PER_Q / 60;
    return {
      total: total, media: Number(A.media_total) || 0, events: evs.length,
      hours: hoursStr(hours), days: (hours / 8).toFixed(1),
      exposure: X && Number(X.totalExposure) || 0,
      top: evs.slice().sort(function (a, b) { return (b.count || 0) - (a.count || 0); }).slice(0, 5)
        .map(function (e) { return { name: e.event_name || e.event_id, count: Number(e.count) || 0 }; }),
      topics: (A.top_keywords || []).slice(0, 5).map(function (t) { return { word: t.word, count: t.count }; }),
      window: Number(A.report_window_days) || 0
    };
  }

  // L：/api/events?action=list_admin；A：同上（拿各場題數）
  function eventsData(L, A, now) {
    var today = taipeiToday(now || Date.now());
    var counts = {};
    ((A && A.by_event) || []).forEach(function (e) { counts[e.event_id] = Number(e.count) || 0; });
    var evs = ((L && L.events) || []).filter(function (e) { return e.id && e.name && !isTestName(e.name) && e.status !== 'archived'; })
      .map(function (e) { return { id: e.id, name: e.name, status: e.status || 'active', date: isoDate(e.event_date), missing: e.missing || [], biz: BIZ_TYPES.indexOf(String(e.event_type || '').trim()) >= 0 }; })
      .filter(function (e) { return e.date; });
    var up = evs.filter(function (e) { return e.date >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    // 最近辦完的：近 60 天、而且真的有人問過（0 題的不列——不是成效）
    var recent = evs.filter(function (e) { return e.date < today && dayDiff(e.date, today) <= 60 && counts[e.id]; })
      .sort(function (a, b) { return a.date > b.date ? -1 : 1; });
    return {
      today: mdw(today), upcomingTotal: up.length,
      upcoming: up.slice(0, 4).map(function (e) { return { name: e.name, date: mdw(e.date), days: dayDiff(today, e.date), status: e.status, missing: e.missing, biz: e.biz }; }),
      recent: recent.slice(0, 3).map(function (e) { return { name: e.name, date: mdw(e.date), count: counts[e.id] }; })
    };
  }

  function wowData(A, X) { return kpiData(A, X); } // 亮點卡用的數字跟成效卡同一份

  // 給模型看的一句話：主管看完圖卡接著問「那哪一場最多？」，模型要知道剛剛畫面上是什麼
  function briefSummary(kind, d) {
    if (kind === 'kpi') {
      if (!d.total) return '（我用圖卡顯示了成效：目前還沒有記者問答紀錄。）';
      return '（我用圖卡顯示了成效，口徑跟成效報告一樣' + (d.window ? '：每場只算活動當天起 ' + d.window + ' 天內' : '') + '、已排除測試資料。記者問了 ' + d.total + ' 題、服務 ' + d.media + ' 家媒體、估計省下 ' + d.hours + ' 小時' +
        (d.exposure ? '、媒體露出 ' + d.exposure + ' 則' : '') + '；題數最多的：' + d.top.map(function (t) { return t.name + ' ' + t.count + ' 題'; }).join('、') + '。）';
    }
    if (kind === 'events') {
      return '（我用圖卡列出了活動近況。接下來 ' + d.upcomingTotal + ' 場：' + d.upcoming.map(function (e) { return e.date + e.name + (e.missing.length ? '（還缺：' + e.missing.join('、') + '）' : ''); }).join('；') +
        '。最近辦完：' + (d.recent.map(function (e) { return e.name + ' ' + e.count + ' 題'; }).join('、') || '無') + '。）';
    }
    return '（我用圖卡介紹了這套系統的五個重點：24 小時 AI 新聞助理、不亂講、省下人力、成效自動統計、發言人會前演練；目前記者問了 ' + d.total + ' 題、服務 ' + d.media + ' 家媒體、估計省下 ' + d.hours + ' 小時。）';
  }
  window.MiaBrief = { kpiData: kpiData, eventsData: eventsData, briefSummary: briefSummary, isTestName: isTestName }; // 測試用

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

  // log 項目：{role:'user'|'assistant', text} 或 {role:'card', proposal, status:'pending'|'working'|'done'|'cancelled'|'error'|'unknown', note}
  var state = { log: load(), busy: false, open: false };
  // 上次按了「確認執行」、還沒等到結果就離開（重新整理、關分頁）的卡片（批次 145）：不知道到底寫進去了沒有，
  // 不能再給一顆「確認執行」——再按一次，活動草稿就會建出兩份。改成「不確定」、請人先去頁面上看。
  state.log.forEach(function (m) {
    if (m.role === 'card' && m.status === 'working') {
      m.status = 'unknown';
      m.note = '上次按了確認後就離開了頁面，不確定有沒有完成。請先到頁面上確認；沒有的話，再請我重新做一次。';
    }
  });

  var css = [
    '#mia-fab{position:fixed;right:18px;bottom:18px;width:68px;height:68px;border-radius:50%;border:3px solid #fff;background:#dbeafe;box-shadow:0 6px 20px rgba(15,23,42,.28);cursor:pointer;padding:0;z-index:9000;display:none;overflow:hidden;transition:transform .15s}',
    '#mia-fab:hover{transform:scale(1.06)}',
    // 長按拖曳（批次 147）：拖的時候不能讓頁面跟著捲、不能跳出 iOS 長按圖片的「儲存影像」選單
    '#mia-fab{touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
    '#mia-fab img{pointer-events:none;-webkit-user-drag:none}',
    '#mia-fab.dragging{transform:scale(1.15);box-shadow:0 12px 30px rgba(15,23,42,.4);cursor:grabbing;transition:none}',
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
    // 主管快看（批次 170）：三顆大按鈕、圖卡（數字方塊、長條、清單）、對話開始後輸入框上方的小按鈕列
    '.mia-big{display:flex;flex-direction:column;gap:7px}',
    '.mia-big button{display:flex;align-items:center;gap:10px;text-align:left;background:#fff;border:2px solid #bfdbfe;border-radius:14px;padding:10px 12px;cursor:pointer;font:inherit;color:#0f172a}',
    '.mia-big button:hover{border-color:#1d4ed8;background:#eff6ff}',
    '.mia-big .ic{font-size:1.6rem;line-height:1;flex:none}',
    '.mia-big b{display:block;font-size:.95rem;color:#1d4ed8}',
    '.mia-big small{display:block;font-size:.76rem;color:#64748b;margin-top:1px}',
    '.mia-or{font-size:.76rem;color:#64748b;margin:2px 2px -3px}',
    '.mia-brief{align-self:stretch;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px;font-size:.85rem;line-height:1.5}',
    '.mia-brief h4{margin:0 0 2px;font-size:.98rem;color:#0f172a}',
    '.mia-brief .note{font-size:.72rem;color:#64748b;margin-bottom:9px}',
    '.mia-brief h5{margin:11px 0 6px;font-size:.8rem;color:#475569}',
    '.mia-tiles{display:grid;grid-template-columns:1fr 1fr;gap:7px}',
    '.mia-tile{border-radius:12px;padding:8px 10px;background:#eff6ff}',
    '.mia-tile:nth-child(2){background:#ecfdf5}.mia-tile:nth-child(3){background:#fff7ed}.mia-tile:nth-child(4){background:#f5f3ff}',
    '.mia-tile .lab{font-size:.74rem;color:#475569}',
    '.mia-tile .num{font-size:1.45rem;font-weight:800;line-height:1.2;color:#0f172a}',
    '.mia-tile .num small{font-size:.75rem;font-weight:600;margin-left:2px;color:#475569}',
    '.mia-tile .hint{font-size:.7rem;color:#64748b}',
    '.mia-bar{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin-bottom:6px}',
    '.mia-bar .nm{font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mia-bar .v{font-size:.78rem;font-weight:700;text-align:right}',
    '.mia-bar .tr{grid-column:1/3;height:8px;border-radius:5px;background:#e2e8f0;overflow:hidden}',
    '.mia-bar .tr i{display:block;height:100%;border-radius:5px;background:#1d4ed8}',
    '.mia-tags{display:flex;flex-wrap:wrap;gap:5px}',
    '.mia-tags span{background:#f1f5f9;border-radius:10px;padding:2px 8px;font-size:.76rem}',
    '.mia-row{display:flex;gap:9px;padding:7px 0;border-top:1px solid #f1f5f9}',
    '.mia-row:first-of-type{border-top:none}',
    '.mia-row .d{flex:none;width:68px;font-size:.76rem;font-weight:700;color:#1d4ed8}',
    '.mia-row .d small{display:block;font-weight:400;color:#64748b}',
    '.mia-row .b{flex:1;min-width:0}',
    '.mia-row .b b{display:block;font-size:.84rem;font-weight:700;word-break:break-word}',
    '.mia-row .b span{font-size:.76rem;color:#475569}',
    '.mia-row .b span.warn{color:#b45309}',
    '.mia-wow{display:flex;gap:9px;padding:6px 0}',
    '.mia-wow .ic{font-size:1.35rem;line-height:1.2;flex:none}',
    '.mia-wow b{display:block;font-size:.86rem}',
    '.mia-wow span{font-size:.78rem;color:#475569}',
    '.mia-brief .go{margin-top:10px;width:100%;background:#1d4ed8;color:#fff;border:none;border-radius:10px;padding:9px;font-weight:700;font-size:.84rem;cursor:pointer}',
    '#mia-quick{display:flex;gap:6px;padding:7px 10px 0;background:#fff;border-top:1px solid #e2e8f0}',
    '#mia-quick button{flex:1;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:10px;padding:6px 4px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap}',
    '#mia-quick button:disabled{opacity:.5;cursor:default}',
    '#mia-form{border-top:none}',
    '@media (max-width:520px){#mia-panel{right:8px;left:8px;width:auto;max-width:none;bottom:92px}#mia-fab{right:12px;bottom:12px}}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var fab, panel, msgs, input, sendBtn, quick;

  function build() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    fab = el('button');
    fab.id = 'mia-fab'; fab.type = 'button'; fab.title = '問米亞（長按可以拖到別的位置）'; fab.setAttribute('aria-label', '開啟後台小幫手米亞');
    fab.appendChild(avatar(IDLE, '米亞'));
    fab.onclick = function () { if (suppressClick) { suppressClick = false; return; } toggle(); };
    setupDrag();

    panel = el('div'); panel.id = 'mia-panel';
    var head = el('div'); head.id = 'mia-head';
    var himg = document.createElement('img'); himg.src = STILL; himg.alt = '';
    var t = el('div', 't', '米亞・後台小幫手'); t.appendChild(el('small', '', '按按鈕看重點，或直接打字問我'));
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

    // 對話開始之後，三顆快看按鈕縮成輸入框上方的一列（開場畫面已經有大按鈕，那時候不重複顯示）
    quick = el('div'); quick.id = 'mia-quick';
    QUICK.forEach(function (q) {
      var b = el('button', '', q.icon + ' ' + q.label.replace('一分鐘看', '').replace('這套系統做了什麼', '系統亮點'));
      b.type = 'button'; b.title = q.label; b.onclick = function () { return brief(q.key); };
      quick.appendChild(b);
    });
    panel.appendChild(head); panel.appendChild(msgs); panel.appendChild(quick); panel.appendChild(form);
    document.body.appendChild(fab); document.body.appendChild(panel);
    render();
    syncVisible();
    setInterval(syncVisible, 1500); // 登入／登出後按鈕跟著出現或消失
    window.addEventListener('resize', function () { if (fab.style.display !== 'none') placeFab(); });
    // 編輯視窗（.modal-overlay）打開時米亞先躲起來（批次 147，朱朱截圖：米亞壓在編輯視窗的「儲存」上）。
    // 用 MutationObserver 即時跟著視窗開關，不要等 1.5 秒的輪詢。
    try {
      // 只看「別人」的變化：米亞自己（按鈕、對話框）與 body（placeFab 會改它的 padding）的樣式變化不算，
      // 不然拖曳時每移動一下都會觸發重新定位，把按鈕拉回原位（走查實際踩到）。
      new MutationObserver(function (list) {
        var relevant = false;
        for (var i = 0; i < list.length && !relevant; i++) {
          var t = list[i].target;
          relevant = t !== document.body && t !== fab && !fab.contains(t) && !panel.contains(t);
        }
        if (!relevant || syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(function () { syncQueued = false; syncVisible(); });
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) {}
  }
  var syncQueued = false;

  // ── 長按拖曳（批次 147，朱朱：「右下米亞設定長按可以到處移動」）───────────────────────────
  // 點一下＝打開對話；按住 0.45 秒不動＝拿起來，拖到哪放到哪。位置記在這台裝置的瀏覽器（localStorage），
  // 存的是「中心點在畫面的比例」，換手機直橫向、視窗大小也放得對；放開時會被夾回畫面內、不壓到底部選單。
  var POS_KEY = 'mia_fab_pos_v1';
  var LONG_PRESS_MS = 450;
  var customPos = loadPos();
  var suppressClick = false;
  function loadPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      return p && typeof p.fx === 'number' && typeof p.fy === 'number' ? p : null;
    } catch (e) { return null; }
  }
  function savePos(p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (e) {} }
  // 把按鈕左上角放到 (x, y)，夾在畫面內、不壓底部選單
  function moveFabTo(x, y) {
    var size = fab.offsetWidth || 68, w = window.innerWidth, h = window.innerHeight, inset = bottomInset();
    x = Math.min(Math.max(x, 6), w - size - 6);
    y = Math.min(Math.max(y, 6), h - inset - size - 6);
    fab.style.left = x + 'px'; fab.style.top = y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
  }
  function applyCustomPos() {
    var size = fab.offsetWidth || 68;
    moveFabTo(customPos.fx * window.innerWidth - size / 2, customPos.fy * window.innerHeight - size / 2);
  }
  function setupDrag() {
    var press = null;
    fab.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    fab.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: false };
      press.timer = setTimeout(function () {
        if (!press) return;
        press.dragging = true;
        fab.classList.add('dragging');
        try { fab.setPointerCapture(press.id); } catch (err) {}
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) {}
      }, LONG_PRESS_MS);
    });
    fab.addEventListener('pointermove', function (e) {
      if (!press) return;
      if (!press.dragging) {
        // 還沒到長按就移動了＝不是要拖，取消（也就不會變成一次點擊以外的東西）
        if (Math.abs(e.clientX - press.x0) > 10 || Math.abs(e.clientY - press.y0) > 10) { clearTimeout(press.timer); press = null; }
        return;
      }
      e.preventDefault();
      var size = fab.offsetWidth || 68;
      moveFabTo(e.clientX - size / 2, e.clientY - size / 2);
    });
    function end() {
      if (!press) return;
      clearTimeout(press.timer);
      var dragged = press.dragging;
      press = null;
      if (!dragged) return;
      fab.classList.remove('dragging');
      suppressClick = true; // 放開時瀏覽器還會送一次 click，那一次不是要打開對話
      setTimeout(function () { suppressClick = false; }, 400);
      var r = fab.getBoundingClientRect();
      customPos = { fx: (r.left + r.width / 2) / window.innerWidth, fy: (r.top + r.height / 2) / window.innerHeight };
      savePos(customPos);
    }
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
  }

  // 頁面上有編輯視窗、確認視窗開著（.modal-overlay 看得到）
  function overlayOpen() {
    var list = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < list.length; i++) if (list[i].getClientRects().length) return true;
    return false;
  }

  // 頁面底部有固定的導覽列（後台首頁手機版的 #sidebar）時，按鈕與對話框往上讓開（批次 144 走查）：
  // 以前手機上米亞剛好蓋住底部選單最右邊的「更多」，而記者名單、活動報名、登出都只能從「更多」進去。
  function bottomInset() {
    var sb = document.getElementById('sidebar');
    if (!sb) return 0;
    try {
      var r = sb.getBoundingClientRect(), h = window.innerHeight || 0;
      if (getComputedStyle(sb).position !== 'fixed' || !r.height || r.height > 160 || r.top < h / 2) return 0;
      return Math.max(0, Math.ceil(h - r.top));
    } catch (e) { return 0; }
  }
  function placeFab() {
    var inset = bottomInset();
    if (customPos) applyCustomPos(); // 拖過的位置優先（仍然夾在畫面內、不壓底部選單）
    else { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = inset ? (inset + 10) + 'px' : ''; }
    panel.style.bottom = inset ? (inset + 84) + 'px' : '';
    panel.style.maxHeight = inset ? 'calc(100vh - ' + (inset + 108) + 'px)' : '';
    // 按鈕抬到選單上面之後，捲到頁面最底時會蓋住最後一段內容的右下角（朱朱手機截圖：「顯示全部 6 場」）。
    // 頁面底部多留一個按鈕的高度，捲到底時內容會停在按鈕上方。
    document.body.style.paddingBottom = inset ? '84px' : '';
  }

  function syncVisible() {
    var on = !!pwd();
    fab.style.display = on && !overlayOpen() ? 'block' : 'none';
    if (fab.style.display === 'block' && !fab.classList.contains('dragging')) placeFab(); // 拖曳中不要重新定位
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
      msgs.appendChild(el('div', 'mia-m a', '嗨，我是米亞！想快速了解狀況，按下面的按鈕就好。也可以直接打字問我，或請我新增記者、活動草稿（我會先給你確認）。'));
      var big = el('div', 'mia-big');
      QUICK.forEach(function (q) {
        var b = el('button'); b.type = 'button'; b.onclick = function () { return brief(q.key); };
        b.appendChild(el('span', 'ic', q.icon));
        var tx = el('span'); tx.appendChild(el('b', '', q.label)); tx.appendChild(el('small', '', q.sub)); b.appendChild(tx);
        big.appendChild(b);
      });
      msgs.appendChild(big);
      msgs.appendChild(el('div', 'mia-or', '或直接問我：'));
      var chips = el('div', 'mia-chips');
      CHIPS.forEach(function (c) { var b = el('button', '', c); b.type = 'button'; b.onclick = function () { ask(c); }; chips.appendChild(b); });
      msgs.appendChild(chips);
    }
    state.log.forEach(function (m, i) {
      if (m.hidden) return; // 卡片後續（remember）：要送給模型、不顯示
      if (m.role === 'card') return msgs.appendChild(cardEl(m, i));
      if (m.role === 'brief') return msgs.appendChild(briefEl(m));
      msgs.appendChild(el('div', 'mia-m ' + (m.role === 'user' ? 'u' : 'a') + (m.err ? ' err' : ''), m.text));
    });
    if (state.busy) { var b = el('div', 'mia-m a busy'); b.appendChild(avatar(BUSY, '')); b.appendChild(el('span', '', '米亞查詢中…')); msgs.appendChild(b); }
    msgs.scrollTop = msgs.scrollHeight;
    sendBtn.disabled = state.busy;
    if (quick) {
      quick.style.display = state.log.length ? 'flex' : 'none';
      Array.prototype.forEach.call(quick.children || [], function (b) { b.disabled = state.busy; });
    }
  }

  // ── 主管快看的圖卡（批次 170）。一律 textContent；數字是程式算的，不是模型寫的 ──────────
  function tile(label, num, unit, hint) {
    var t = el('div', 'mia-tile');
    t.appendChild(el('div', 'lab', label));
    var n = el('div', 'num', num); if (unit) n.appendChild(el('small', '', unit)); t.appendChild(n);
    if (hint) t.appendChild(el('div', 'hint', hint));
    return t;
  }
  function bars(list, unit) {
    var box = el('div'), max = Math.max.apply(null, [1].concat(list.map(function (x) { return x.count; })));
    list.forEach(function (x) {
      var r = el('div', 'mia-bar');
      r.appendChild(el('div', 'nm', x.name)); r.appendChild(el('div', 'v', x.count + ' ' + unit));
      var tr = el('div', 'tr'), fill = el('i'); fill.style.width = Math.max(4, Math.round(x.count / max * 100)) + '%'; tr.appendChild(fill); r.appendChild(tr);
      box.appendChild(r);
    });
    return box;
  }
  function briefEl(m) {
    var d = m.data || {}, card = el('div', 'mia-brief');
    if (m.kind === 'kpi') {
      card.appendChild(el('h4', '', '📊 成效一覽'));
      card.appendChild(el('div', 'note', '跟成效報告同一套算法' + (d.window ? '：每場只算活動當天起 ' + d.window + ' 天內' : '') + '，已排除測試資料'));
      if (!d.total) { card.appendChild(el('div', '', '目前還沒有記者問答紀錄。活動辦完、記者問過之後，這裡就會有數字。')); return card; }
      var tiles = el('div', 'mia-tiles');
      tiles.appendChild(tile('記者提問', d.total, '題', d.events + ' 場活動'));
      tiles.appendChild(tile('服務媒體', d.media, '家', '同一家只算一次'));
      tiles.appendChild(tile('節省人力', d.hours, '小時', '約 ' + d.days + ' 個工作天'));
      if (d.exposure) tiles.appendChild(tile('媒體露出', d.exposure, '則', '監測公司的露出清單'));
      card.appendChild(tiles);
      if (d.top.length) { card.appendChild(el('h5', '', '各場記者提問數')); card.appendChild(bars(d.top, '題')); }
      if (d.topics.length) {
        card.appendChild(el('h5', '', '記者最常問'));
        var tags = el('div', 'mia-tags'); d.topics.forEach(function (t) { tags.appendChild(el('span', '', t.word + '・' + t.count)); }); card.appendChild(tags);
      }
      var go = el('button', 'go', '▶ 打開完整互動簡報（給長官看的）'); go.type = 'button';
      go.onclick = function () { location.href = '/report#deck'; };
      card.appendChild(go);
      return card;
    }
    if (m.kind === 'events') {
      card.appendChild(el('h4', '', '📅 活動近況'));
      card.appendChild(el('div', 'note', '今天是 ' + d.today));
      card.appendChild(el('h5', '', '接下來' + (d.upcomingTotal > d.upcoming.length ? '（共 ' + d.upcomingTotal + ' 場，列最近 ' + d.upcoming.length + ' 場）' : '')));
      if (!d.upcoming.length) card.appendChild(el('div', '', '目前沒有排定日期的活動。'));
      d.upcoming.forEach(function (e) {
        var r = el('div', 'mia-row'), dd = el('div', 'd', e.date);
        dd.appendChild(el('small', '', e.days === 0 ? '今天' : '還有 ' + e.days + ' 天'));
        var b = el('div', 'b'); b.appendChild(el('b', '', e.name + (e.biz ? '（企業場）' : '')));
        var ready = !e.missing.length;
        var line = e.status === 'draft' ? (ready ? '🔒 資料齊了，還沒發布' : '🔒 未發布・還缺：' + e.missing.join('、'))
          : (ready ? '✅ 已發布，資料齊全' : '⚠️ 已發布，但還缺：' + e.missing.join('、'));
        b.appendChild(el('span', ready ? '' : 'warn', line));
        r.appendChild(dd); r.appendChild(b); card.appendChild(r);
      });
      if (d.recent.length) {
        card.appendChild(el('h5', '', '最近辦完'));
        d.recent.forEach(function (e) {
          var r = el('div', 'mia-row'), b = el('div', 'b');
          b.appendChild(el('b', '', e.name)); b.appendChild(el('span', '', '記者問了 ' + e.count + ' 題'));
          r.appendChild(el('div', 'd', e.date)); r.appendChild(b); card.appendChild(r);
        });
      }
      return card;
    }
    // wow：這套系統做了什麼（說明是固定文字，數字是即時的）
    card.appendChild(el('h4', '', '✨ 這套系統做了什麼'));
    card.appendChild(el('div', 'note', '五個重點'));
    [
      ['🤖', '記者 24 小時都問得到', '掃活動 QR 或加 LINE 就能問米亞，網頁和 LINE 用同一份新聞資料。' + (d.total ? '到目前已回答 ' + d.total + ' 題、服務 ' + d.media + ' 家媒體。' : '')],
      ['🛡️', '不亂講', '只根據同仁放的新聞資料回答；沒有的就老實說，並請記者找新聞聯絡人。'],
      ['⏱️', '替同仁省下人力', d.total ? '估計省下 ' + d.hours + ' 小時，約 ' + d.days + ' 個工作天（每題以 ' + MIN_PER_Q + ' 分鐘估算）。' : '記者的例行問題由米亞先回答，同仁不用一則一則回訊息。'],
      ['📈', '成效自動算好', '題數、媒體家數、媒體露出都自動統計' + (d.exposure ? '（已登錄 ' + d.exposure + ' 則露出）' : '') + '，一鍵變成給長官看的互動簡報。'],
      ['🎤', '發言人會前演練', '「媒體訓練」讓 AI 扮記者出題、逐題評分，發言人上台前先練過一輪。']
    ].forEach(function (w) {
      var r = el('div', 'mia-wow'); r.appendChild(el('div', 'ic', w[0]));
      var b = el('div'); b.appendChild(el('b', '', w[1])); b.appendChild(el('span', '', w[2])); r.appendChild(b);
      card.appendChild(r);
    });
    return card;
  }

  // 只讀、要管理員密碼的 GET（同一分鐘內重複按不重打）
  var cacheGet = {};
  async function getJSON(url) {
    var hit = cacheGet[url];
    if (hit && Date.now() - hit.t < 60000) return hit.d;
    var res = await fetch(url, { headers: { 'X-Admin-Password': pwd() } });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401) throw new Error('密碼不對或已過期，請重新登入後台');
    if (!res.ok || data.error) throw new Error(data.error || ('讀取失敗（' + res.status + '）'));
    cacheGet[url] = { t: Date.now(), d: data };
    return data;
  }
  var ANALYTICS_URL = '/api/analytics?summary=1&exclude_test=1&report=1'; // 跟 /report 同一個口徑

  async function brief(kind) {
    var q = QUICK.filter(function (x) { return x.key === kind; })[0];
    if (!q || state.busy) return;
    if (!pwd()) { state.log.push({ role: 'assistant', text: '請先登入後台再問我。', err: true }); render(); return; }
    state.log.push({ role: 'user', text: q.icon + ' ' + q.label });
    state.busy = true; render();
    try {
      var data;
      if (kind === 'events') {
        var both = await Promise.all([getJSON('/api/events?action=list_admin'), getJSON(ANALYTICS_URL).catch(function () { return null; })]);
        data = eventsData(both[0], both[1]);
      } else {
        // 露出讀不到就當沒有（那一格不出現），不影響其他數字
        var r = await Promise.all([getJSON(ANALYTICS_URL), getJSON('/api/exposure?action=analysis_all').catch(function () { return null; })]);
        data = kind === 'kpi' ? kpiData(r[0], r[1]) : wowData(r[0], r[1]);
      }
      state.log.push({ role: 'brief', kind: kind, data: data });
    } catch (e) {
      state.log.push({ role: 'assistant', text: e.message || '讀取失敗，請稍後再試', err: true });
    }
    state.busy = false; save(); render();
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
      card.appendChild(el('div', 'st', (m.status === 'done' ? '✅ ' : m.status === 'error' || m.status === 'unknown' ? '⚠️ ' : '') + (m.note || '')));
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
    m.status = 'working'; m.note = '執行中…'; save(); render(); // 先存：執行到一半離開頁面，回來才不會又是一顆可以按的「確認執行」
    var res = null;
    try {
      res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pwd() }, body: JSON.stringify(req.body) });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.error) throw new Error(data.error || ('失敗（' + res.status + '）'));
      m.status = 'done'; m.note = '已完成。頁面上的資料請重新整理一下就會看到。';
      remember('（使用者按了確認，「' + m.proposal.title + '」已經執行完成。）');
      try { window.dispatchEvent(new CustomEvent('mia-assistant-change', { detail: { kind: m.proposal.kind } })); } catch (e) {}
    } catch (e) {
      if (!res) {
        // 沒拿到伺服器的回應（斷線、逾時、頁面重新整理把請求中斷）：請求可能已經送到、也寫進去了（批次 145 走查）。
        // 不能說「沒有成功」——人會再叫米亞做一次，活動草稿就變兩份。
        m.status = 'unknown'; m.note = '連線中斷，不確定有沒有完成。請先到頁面上確認；沒有的話，再請我重新做一次。';
        remember('（「' + m.proposal.title + '」執行時連線中斷，不確定有沒有寫入；請使用者先確認，不要直接再提議一次。）');
      } else {
        m.status = 'error'; m.note = '沒有成功：' + e.message;
        remember('（「' + m.proposal.title + '」執行失敗：' + e.message + '，沒有寫入。）');
      }
    }
    save(); render();
  }

  function history() {
    // 只送文字；卡片已經用 remember() 轉成一句話。連續同角色的合併，最後一則一定是使用者
    var out = [];
    state.log.forEach(function (m) {
      // 圖卡（批次 170）轉成一句話給模型：主管看完接著問「那哪一場最多？」才接得上
      if (m.role === 'brief') m = { role: 'assistant', text: briefSummary(m.kind, m.data || {}) };
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
