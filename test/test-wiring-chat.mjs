// 批次 132／134 接線：網頁問答 api/chat.js
//   一、基本行為不變：請求位元組、串流格式、qa_log
//   二、答案出口檢查（批次 132）：預設影子模式不改任何位元組、ANSWER_GROUNDING=on 才附提醒、哪些東西不查
//   三、拒答（批次 134）非串流：Haiku 被攔下 → Sonnet 5.5 重答／重答也被攔／逾時／非 2xx
//   四、拒答（批次 134）串流：輸出前被攔下 → 重答；輸出到一半被攔下 → 補一句說明
//   五、企業場拒答：同一把金鑰、出口檢查照舊
//   六、既有行為不變：錯誤碼與訊息、限流、CORS、媒體名稱、斷線路徑
//
// 跑的是真的 api/chat.js 與 lib/*.js；只有 Google Sheets（test/fakes-sheets82.mjs）與 Anthropic／LINE（下面攔截 fetch）是假的。
// 這個環境沒有 ANTHROPIC_API_KEY，也沒有真的 API 可以驗：串流拒答事件的形狀來自官方文件，沒驗證過的部分見 api/chat.js
// streamRefusalDetails() 上面的說明。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.ANTHROPIC_API_KEY = 'key-main';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_ADMIN_USER_ID = 'Uadmin';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
delete process.env.ANTHROPIC_API_KEY_BUSINESS;
delete process.env.ANSWER_GROUNDING;
delete process.env.AI_REFUSAL_FALLBACKS;

const { book } = await import('./fakes-sheets82.mjs');
const { resetAiAlertThrottle } = await import('../lib/ai-alert.js');
const { resetRefusalFallbacks, refusalReply, FALLBACK_BETA, isRefusalReply } = await import('../lib/ai-refusal.js');
const { findResidualSimplified, ZH_TW_RULE, toTraditionalTW } = await import('../lib/zh-tw.js');
const { systemPromptFor } = await import('../lib/prompt.js');
const chat = (await import('../api/chat.js')).default;

// ── 檢查工具 ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const out = (s) => process.stdout.write(s + '\n');
function check(label, cond, detail) {
  if (cond) { pass++; out(`✅ ${label}`); }
  else { fail++; out(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

// 攔截 console：模型端與出口檢查的 log 都在這裡看，也不讓它們洗版
const logBuf = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logBuf.push(a.map(String).join(' ')); };
const logsMatching = (re) => logBuf.filter((l) => re.test(l));

// ── 假的 Anthropic／LINE ────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let plan = [];
let calls = [];
const linePushes = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.line.me/')) { linePushes.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); }
  if (!u.startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
  const call = { body: JSON.parse(opts.body), raw: opts.body, headers: { ...(opts.headers || {}) }, signal: opts.signal };
  calls.push(call);
  const responder = plan.shift();
  if (!responder) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'PLAN EXHAUSTED：測試沒有安排這一次呼叫' } }), { status: 500 });
  return typeof responder === 'function' ? responder(call) : responder;
};

// 非串流回應
const msgJson = (text, o = {}) => ({
  id: 'msg_x', type: 'message', role: 'assistant', model: o.model || 'claude-haiku-5-5',
  content: text === null ? [] : [{ type: 'text', text }],
  stop_reason: o.stop_reason || 'end_turn', stop_details: o.stop_details ?? null,
  usage: { input_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 30 }
});
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const okJson = (text, o) => json(msgJson(text, o));
const refusalJson = (o = {}) => json(msgJson(o.partial ?? null, {
  stop_reason: 'refusal', model: o.model,
  stop_details: o.details === undefined ? { type: 'refusal', category: o.category === undefined ? 'cyber' : o.category, explanation: '測試' } : o.details
}));
const errJson = (status, type, message) => json({ type: 'error', error: { type, message } }, status);

// 串流回應（SSE 位元組，chunk>0 時切成固定大小的小塊，測事件被切在半途）
const enc = new TextEncoder();
function sse(events, { chunk = 0 } = {}) {
  const bytes = enc.encode(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  return new Response(new ReadableStream({
    start(c) {
      if (!chunk) c.enqueue(bytes);
      else for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const ME = { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_details: null, usage: { input_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } };
const BLOCK_START = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const BLOCK_STOP = { type: 'content_block_stop', index: 0 };
const delta = (t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const mdelta = (stop_reason, stop_details) => ({
  type: 'message_delta',
  delta: { stop_reason, stop_sequence: null, ...(stop_details === undefined ? {} : { stop_details }) },
  usage: { output_tokens: 20 }
});
const MSTOP = { type: 'message_stop' };
const okStream = (parts, o) => sse([ME, BLOCK_START, ...parts.map(delta), BLOCK_STOP, mdelta('end_turn'), MSTOP], o);
const REFUSAL_DETAILS = (category = 'cyber') => ({ type: 'refusal', category, explanation: '測試' });

// ── 假的 res／req ───────────────────────────────────────────────────────────
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], body: undefined, headersSent: false, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (x) => { r.headersSent = true; r.chunks.push(String(x)); return true; };
  r.flush = () => {};
  r.end = (x) => { if (x !== undefined) r.chunks.push(String(x)); r.ended = true; return r; };
  return r;
}
const sseEvents = (res) => res.chunks.join('').split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

// ── 活動資料（events!A:R 的欄位順序見 test/fakes.mjs）──────────────────────────────
const KB = '【新聞稿】工研院發表四足機器人，預計 2027 年第二季量產，年產能 500 台。技術詳見 https://www.itri.org.tw/robot 。';
const KB_BIZ = '【技術說明】產線熱管理模組XJ9：計畫總經費新台幣 3 億元，適用 CNC 與射出成型產線。';
const row = (id, name, kb, extra = {}) => {
  const r = [id, name, '#0F9E7A', kb, 'active', '2026-09-24', '', '', '', '工研院', 'cc', '', '', '', '', '', '', ''];
  for (const [i, v] of Object.entries(extra)) r[i] = v;
  return r;
};
book.events = [['id'],
  row('ev', '四足機器人發表會', KB, { 14: '王小明 03-1111111' }),
  row('plain', '無基本資料場', KB, { 5: '' }),               // 沒日期、時間、地點、聯絡人 → 沒有「活動基本資料」那一塊
  row('simp', '簡體聯絡人場', KB, { 14: '王小明（发言人）03-1111111' }),
  row('pv', '光伏聯絡人場', KB, { 14: '光伏事業部 林經理 0912-345-678' }),   // 單位名稱含大陸用語詞：名稱要原樣，不能被用語層改掉
  row('biz', '智慧製造技術說明會', KB_BIZ, { 13: '企業說明會', 14: '業務窗口 林小姐 03-5912345' }),
  row('draft', '草稿', KB, { 4: 'draft' })
];
book.qa_log = [['timestamp']];

const W = '內容僅供參考，以工研院官網新聞稿或發言為準。';
const CLEAN = `預計 2027 年第二季量產，年產能 500 台。\n${W}`;
const FAB = `預計 2028 年第二季量產，並投資 800 億元，詳見 https://fake.example.com/robot。\n${W}`;
const FAB_NUM = `預計 2028 年量產。\n${W}`;
const FAB_URL = `詳見 https://fake.example.com/robot。\n${W}`;
const FAB_PARTS = ['預計 2028 年第二季量產，', '並投資 800 億元，', '詳見 https://fake.example.com/robot。\n', W];
const NOTE_START = '\n\n⚠️ 以上內容有幾處（';
const NOTE_END = '）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。';
const FIXED_EV = refusalReply({ contact: '王小明 03-1111111' });
const MIDWAY = '（這一題後半段沒辦法回答，建議洽新聞聯絡人。）';

let seq = 0;
async function run({ plan: p = [], q = '產能多少？', stream = false, event = 'ev', messages, body = {} } = {}) {
  plan = [...p]; calls = []; logBuf.length = 0; book.qa_log.length = 1;
  seq++;
  const res = fakeRes();
  await chat({
    method: 'POST', headers: { 'x-forwarded-for': `10.20.${Math.floor(seq / 250)}.${seq % 250}` }, socket: {},
    body: { event_id: event, media_name: '中央社', client_id: 'w' + seq, stream, messages: messages || [{ role: 'user', content: q }], ...body }
  }, res);
  const events = res.chunks.length ? sseEvents(res) : [];
  const qaRows = book.qa_log.slice(1);
  return {
    res, calls: [...calls], events, qaRows, body: res.body, raw: res.chunks.join(''),
    text: events.filter((e) => typeof e.t === 'string').map((e) => e.t).join(''),
    qa: (qaRows[qaRows.length - 1] || [])[5],
    logs: [...logBuf]
  };
}
const setMode = (v) => { if (v === undefined) delete process.env.ANSWER_GROUNDING; else process.env.ANSWER_GROUNDING = v; };
const J = JSON.stringify;
const hasGrounding = (r) => r.logs.some((l) => l.startsWith('[grounding]'));
const noError = (r) => !r.events.some((e) => 'error' in e);
const lastIsDone = (r) => r.events.length > 0 && r.events[r.events.length - 1].done === true;

/* ═════════ 一、基本行為不變 ═════════ */
out('\n── 一、基本行為不變 ──');
{
  const q = '產能多少？';
  const r = await run({ event: 'plain', plan: [okJson(CLEAN)], q });
  const expected = JSON.stringify({
    model: 'claude-haiku-5-5', max_tokens: 4096, thinking: { type: 'disabled' }, stream: false,
    system: [{ type: 'text', text: systemPromptFor({ name: '無基本資料場', organizer: '工研院', knowledge_base: KB, images: '', event_date: '', invite_letter: '', event_type: '' }) + '\n' + ZH_TW_RULE, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: q }]
  });
  check('非串流：回 200 與 { reply }，qa_log 記同一段', r.res.statusCode === 200 && r.body?.reply === CLEAN && r.qa === CLEAN, JSON.stringify(r.body));
  check('★ 送給模型的請求位元組跟接線前逐 byte 相同（欄位順序、thinking 關閉、快取區塊）', r.calls.length === 1 && r.calls[0].raw === expected, r.calls[0]?.raw.slice(0, 200));
  check('　 用記者那一把金鑰與固定的 API 版本標頭，沒帶 beta 標頭、沒帶 fallbacks（Haiku 本來就不能帶）',
    r.calls[0].headers['x-api-key'] === 'key-main' && r.calls[0].headers['anthropic-version'] === '2023-06-01' && !('anthropic-beta' in r.calls[0].headers) && !('fallbacks' in r.calls[0].body));
  check('　 正常回答不會冒出 [ai-refusal]，也沒有任何 LINE 通知', !r.logs.some((l) => l.startsWith('[ai-refusal]')) && linePushes.length === 0);
  check('　 用量照記（批次 117）', r.logs.some((l) => /^\[ai-usage\] 網頁問答 model=claude-haiku-5-5 in=1200 cache_read=1000/.test(l)), r.logs.join('|'));
}
{
  const parts = ['工研院表示，', '預計 2027 年第二季量產。\n', W];
  const r = await run({ stream: true, plan: [okStream(parts)] });
  const expected = ': ok\n\n' + parts.map((t) => `data: ${JSON.stringify({ t })}\n\n`).join('') + 'data: {"done":true}\n\n';
  check('★ 串流：送出的位元組逐 byte 是 ": ok" ＋ 每段 {"t"} ＋ {"done":true}（格式沒變）', r.raw === expected, JSON.stringify(r.raw).slice(0, 300));
  check('　 串流請求 stream:true、只打一次模型、qa_log 記完整答案', r.calls.length === 1 && r.calls[0].body.stream === true && r.qa === parts.join(''), r.qa);
  check('　 SSE 標頭照舊', r.res.headers['content-type'] === 'text/event-stream; charset=utf-8' && r.res.headers['x-accel-buffering'] === 'no');
}
{
  const r = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('答案裡提到 "stop_reason":"refusal" 這個字串，'), delta('但那只是文字。'), BLOCK_STOP, mdelta('end_turn'), MSTOP])] });
  check('★ 答案文字裡剛好寫著 "stop_reason":"refusal" 不算拒答（只看事件的 stop_reason 欄位）', r.calls.length === 1 && r.text === '答案裡提到 "stop_reason":"refusal" 這個字串，但那只是文字。' && noError(r), r.text);
}
{
  const r = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('答到上限就停，'), BLOCK_STOP, mdelta('max_tokens'), MSTOP])] });
  check('　 stop_reason 是 max_tokens 也不算拒答：不重答、不補說明', r.calls.length === 1 && r.text === '答到上限就停，' && lastIsDone(r));
}

/* ═════════ 二、答案出口檢查（批次 132）═════════ */
out('\n── 二、答案出口檢查：預設影子模式不改任何位元組 ──');
{
  setMode(undefined);
  const dflt = await run({ plan: [okJson(FAB)] });
  setMode('shadow');
  const shadow = await run({ plan: [okJson(FAB)] });
  setMode('off');
  const off = await run({ plan: [okJson(FAB)] });
  setMode('typo');
  const typo = await run({ plan: [okJson(FAB)] });
  setMode(undefined);
  check('★ 非串流：影子模式（沒設／shadow／打錯字）回覆跟 off 逐字相同，也等於模型原文', dflt.body.reply === FAB && shadow.body.reply === FAB && typo.body.reply === FAB && off.body.reply === FAB, JSON.stringify([dflt.body, shadow.body]));
  check('　 qa_log 也一樣', dflt.qa === FAB && shadow.qa === FAB && off.qa === FAB);
  check('★ 影子模式有記 [grounding]（編造的數字與網址被標出）；off 完全不記', hasGrounding(dflt) && hasGrounding(shadow) && !hasGrounding(off), shadow.logs.join('|'));
  const g = shadow.logs.find((l) => l.startsWith('[grounding]')) || '';
  check('　 log 只記被標出的項目，不記答案全文與問題', /2028 年/.test(g) && /800 億元/.test(g) && /fake\.example\.com/.test(g) && !g.includes('投資') && !g.includes('產能多少'), g);
  check('　 log 標明是哪一條路與哪一場：where=web-chat event=ev', /^\[grounding\] where=web-chat event=ev /.test(g), g);
}
{
  setMode(undefined);
  const dflt = await run({ stream: true, plan: [okStream(FAB_PARTS)] });
  setMode('shadow');
  const shadow = await run({ stream: true, plan: [okStream(FAB_PARTS)] });
  setMode('off');
  const off = await run({ stream: true, plan: [okStream(FAB_PARTS)] });
  setMode(undefined);
  const expected = ': ok\n\n' + FAB_PARTS.map((t) => `data: ${JSON.stringify({ t })}\n\n`).join('') + 'data: {"done":true}\n\n';
  check('★ 串流：影子模式送出的位元組跟 off 逐 byte 相同，也等於「沒接線」時的標準輸出', dflt.raw === expected && shadow.raw === expected && off.raw === expected, JSON.stringify(shadow.raw).slice(0, 200));
  check('　 串流的 qa_log 沒有提醒', shadow.qa === FAB_PARTS.join('') && dflt.qa === FAB);
  const g = shadow.logs.find((l) => l.startsWith('[grounding]')) || '';
  check('　 串流也記 [grounding]，where=web-chat-stream；off 不記', /^\[grounding\] where=web-chat-stream event=ev /.test(g) && !hasGrounding(off), g);
}

out('\n── 二之二、ANSWER_GROUNDING=on：被標出才附提醒，排在警語之後 ──');
{
  setMode('on');
  const r = await run({ plan: [okJson(FAB)] });
  const reply = r.body.reply;
  check('★ 非串流 on：原文一字不動，後面接 "\\n\\n⚠️ 以上內容有幾處（…）在新聞稿原文裡查不到…"', reply.startsWith(FAB + NOTE_START) && reply.endsWith(NOTE_END), reply);
  check('　 提醒排在警語之後、點名了編造的數字與網址', reply.indexOf(W) < reply.indexOf('⚠️') && /2028 年/.test(reply) && /800 億元/.test(reply) && /https:\/\/fake\.example\.com\/robot/.test(reply), reply);
  check('　 qa_log 與記者看到的一致', r.qa === reply);
  const n = await run({ plan: [okJson(FAB_NUM)] });
  check('　 只有編造的數字：提醒只點名數字', n.body.reply === FAB_NUM + NOTE_START + '2028 年' + NOTE_END, n.body.reply);
  const u = await run({ plan: [okJson(FAB_URL)] });
  check('　 只有編造的網址：提醒點名網址', u.body.reply === FAB_URL + NOTE_START + 'https://fake.example.com/robot' + NOTE_END, u.body.reply);
  const c = await run({ plan: [okJson(CLEAN)] });
  check('★ 乾淨的答案（數字、網址都在新聞稿與活動資料裡）：不附提醒、不記 [grounding]', c.body.reply === CLEAN && !hasGrounding(c), c.body.reply);
  check('　 提醒是固定的繁體句，沒有殘留簡體字', findResidualSimplified(reply).length === 0 && toTraditionalTW(reply) === reply);
}
{
  setMode('on');
  const r = await run({ stream: true, plan: [okStream(FAB_PARTS)] });
  const ev = r.events;
  const tEvents = ev.filter((e) => typeof e.t === 'string');
  const note = tEvents[tEvents.length - 1]?.t || '';
  check('★ 串流 on：{done:true} 之前多送一個 {t:"\\n\\n⚠️…"} 事件，原本的幾段一字不動',
    tEvents.length === FAB_PARTS.length + 1 && tEvents.slice(0, FAB_PARTS.length).map((e) => e.t).join('') === FAB_PARTS.join('') && note.startsWith(NOTE_START) && note.endsWith(NOTE_END), JSON.stringify(tEvents.map((e) => e.t.slice(0, 20))));
  check('　 事件順序：提醒緊接在 done 前面，done 是最後一個，沒有 error', ev[ev.length - 1].done === true && ev[ev.length - 2].t === note && noError(r));
  check('　 qa_log 記的是答案＋提醒（跟記者畫面一致）', r.qa === FAB + note, r.qa);
  check('　 串流 log：where=web-chat-stream', r.logs.some((l) => /^\[grounding\] where=web-chat-stream event=ev /.test(l)));
  const c = await run({ stream: true, plan: [okStream(['預計 2027 年第二季量產，', '年產能 500 台。\n', W])] });
  check('　 串流 on、乾淨的答案：沒有多送任何事件', c.events.length === 4 && c.events.every((e) => e.done === true || typeof e.t === 'string') && !c.text.includes('⚠️'), JSON.stringify(c.events));
}
{
  setMode('on');
  const un = await run({ q: '2029 年會量產嗎？', plan: [okJson(`目前新聞稿沒有提到 2029 年的計畫。\n${W}`)] });
  check('★ 記者自己問題裡的數字算「模型看到的」：答案複述 2029 年不被標出', !hasGrounding(un) && !un.body.reply.includes('⚠️'), un.body.reply);
  const history = [
    { role: 'user', content: '產能多少？' },
    { role: 'assistant', content: `年產能 3000 億元。\n${W}` },   // 模型先前自己編的
    { role: 'user', content: '再說一次' }
  ];
  const washed = await run({ messages: history, plan: [okJson(`年產能 3000 億元。\n${W}`)] });
  check('★ shownText 只放 user 輪、不放 assistant 輪：模型先前編的 3000 億元不會被洗白', washed.body.reply.includes('⚠️') && /3000 億元/.test(washed.body.reply.split('⚠️')[1] || ''), washed.body.reply);
  const sentBody = washed.calls[0].body;
  check('　 （對照）那段 assistant 的話照樣送給了模型，只是檢查不把它當來源', sentBody.messages.some((m) => m.role === 'assistant' && m.content.includes('3000 億元')));
  const basics = await run({ q: '聯絡人電話？', plan: [okJson(`新聞聯絡人是王小明，電話 03-1111111。\n${W}`)] });
  check('　 活動基本資料（聯絡人電話）算來源：不被標出', !hasGrounding(basics), basics.logs.join('|'));
  const kb = await run({ q: '網址？', plan: [okJson(`技術詳見 https://www.itri.org.tw/robot 。\n${W}`)] });
  check('　 新聞稿裡的網址原樣引用：不被標出', !hasGrounding(kb), kb.logs.join('|'));
}
{
  setMode('on');
  const biz = await run({ event: 'biz', plan: [okJson(`這套模組主要用在 CNC 產線，預計 2028 年導入。\n`)] });
  check('★ 企業場不跑答案出口檢查（它有 guardBusinessAnswer）：沒有 [grounding]、沒有提醒', !hasGrounding(biz) && !biz.body.reply.includes('⚠️'), biz.body.reply);
  check('　 企業場照舊補免責句', /不構成報價或合作承諾/.test(biz.body.reply), biz.body.reply);
  const off = await run({ plan: [okJson('')] });
  check('　 模型沒回文字：照舊「抱歉，無法取得回應。」，不做檢查', off.body.reply === '抱歉，無法取得回應。' && !hasGrounding(off) && off.qa === '抱歉，無法取得回應。', off.body.reply);
  const sr = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('預計 2028 年量產，'), delta('但後面'), mdelta('end_turn'), MSTOP])] });
  check('　 串流：答案被截在半途的 on 模式也照常出提醒（答案是完整收到的）', sr.text.includes('⚠️') && lastIsDone(sr), sr.text);
  setMode(undefined);
}

/* ═════════ 三、拒答（非串流）═════════ */
out('\n── 三、拒答：Haiku 被攔下 → Sonnet 5.5 重答（非串流）──');
{
  const SONNET = '预计 2027 年第二季量产，年产能 500 台。\n内容仅供参考，以工研院官网新闻稿或发言为准。';
  const r = await run({ plan: [refusalJson({ category: 'cyber' }), okJson(SONNET, { model: 'claude-sonnet-5-5' })] });
  check('★ 拒答 → Sonnet 重答成功：記者拿到重答的文字（而且過繁體出口）', r.res.statusCode === 200 && r.body.reply === CLEAN, JSON.stringify(r.body));
  check('　 qa_log 記重答的答案，不是「抱歉，無法取得回應。」', r.qa === CLEAN && r.qaRows.length === 1, r.qa);
  check('　 打了兩次模型：第一次 Haiku、第二次 Sonnet 5.5', r.calls.length === 2 && r.calls[0].body.model === 'claude-haiku-5-5' && r.calls[1].body.model === 'claude-sonnet-5-5');
  const b = r.calls[1]?.body || {};
  check('★ 重答的 thinking 是 {type:"between_tools"}（Sonnet 5.5 不收 disabled）', JSON.stringify(b.thinking) === '{"type":"between_tools"}', JSON.stringify(b.thinking));
  check('★ 重答不帶 temperature／top_p／top_k／budget_tokens，thinking 裡也沒有 budget_tokens', !('temperature' in b) && !('top_p' in b) && !('top_k' in b) && !('budget_tokens' in b) && !('budget_tokens' in (b.thinking || {})));
  check('　 重答是非串流；system、messages、max_tokens 原樣', b.stream === false && JSON.stringify(b.system) === JSON.stringify(r.calls[0].body.system) && JSON.stringify(b.messages) === JSON.stringify(r.calls[0].body.messages) && b.max_tokens === 4096);
  check('★ 重答帶伺服器端備援（fallbacks:"default" ＋ beta 標頭）；第一次（Haiku）沒有', b.fallbacks === 'default' && r.calls[1].headers['anthropic-beta'] === FALLBACK_BETA && !('fallbacks' in r.calls[0].body) && !('anthropic-beta' in r.calls[0].headers));
  check('　 兩次都用記者那把金鑰', r.calls[0].headers['x-api-key'] === 'key-main' && r.calls[1].headers['x-api-key'] === 'key-main');
  const lines = r.logs.filter((l) => l.startsWith('[ai-refusal]'));
  check('★ 記一行 [ai-refusal]：哪一條路、哪個模型、分類、哪一場', lines.length === 1 && lines[0] === '[ai-refusal] where=網頁問答 model=claude-haiku-5-5 category=cyber event=ev', lines.join('|'));
  check('　 Haiku 與 Sonnet 的用量各記一行，Sonnet 那行註明「拒答改 Sonnet」', r.logs.some((l) => /^\[ai-usage\] 網頁問答 model=claude-haiku-5-5/.test(l)) && r.logs.some((l) => /^\[ai-usage\] 網頁問答（拒答改 Sonnet） model=claude-sonnet-5-5/.test(l)), r.logs.filter((l) => l.startsWith('[ai-usage]')).join('|'));
  check('★ 200＋拒答不是金鑰／額度警報：沒有 LINE 通知', linePushes.length === 0, JSON.stringify(linePushes));
}
{
  const r = await run({ plan: [refusalJson({ category: null, partial: '根據新聞稿，這項技術可以用來' }), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('★ 拒答時 content 有一半的文字：丟掉，不拿來用', r.body.reply === CLEAN && !r.body.reply.includes('可以用來') && !r.qa.includes('可以用來'), r.body.reply);
  check('　 stop_details.category 是 null 照樣處理（log 記 null）', r.logs.some((l) => /^\[ai-refusal\] where=網頁問答 .*category=null/.test(l)));
  const noDetails = await run({ plan: [refusalJson({ details: null }), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('　 沒有 stop_details 也照樣重答', noDetails.body.reply === CLEAN && noDetails.calls.length === 2);
}
{
  const r = await run({ plan: [refusalJson({ category: 'bio' }), refusalJson({ category: 'bio', model: 'claude-sonnet-5-5' })] });
  check('★ 重答也被攔：給固定句（含新聞聯絡人），status 200', r.res.statusCode === 200 && r.body.reply === FIXED_EV && /王小明 03-1111111/.test(r.body.reply), JSON.stringify(r.body));
  check('　 qa_log 記固定句，不是「抱歉，無法取得回應。」', r.qa === FIXED_EV && !r.qa.includes('抱歉'), r.qa);
  check('　 兩次拒答各記一行（Haiku、Sonnet），Sonnet 那行標明是重答', r.logs.filter((l) => l.startsWith('[ai-refusal]')).length === 2 && r.logs.some((l) => /^\[ai-refusal\] where=網頁問答（改 Sonnet 重答） model=claude-sonnet-5-5 category=bio/.test(l)), r.logs.filter((l) => l.startsWith('[ai-refusal]')).join('|'));
  check('　 只重答一次（共 2 次呼叫），沒有無限重試', r.calls.length === 2);
  check('　 固定句：isRefusalReply 認得、沒有簡體、沒有 Markdown', isRefusalReply(r.body.reply) && findResidualSimplified(r.body.reply).length === 0 && !/[*_`#]/.test(r.body.reply));
}
{
  const r = await run({ plan: [refusalJson(), () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }] });
  check('★ 重答逾時：給固定句、回 200（不是 504，Haiku 那邊已經是成功的請求）', r.res.statusCode === 200 && r.body.reply === FIXED_EV && r.qa === FIXED_EV, JSON.stringify(r.body));
  const bad = await run({ plan: [refusalJson(), errJson(529, 'overloaded_error', 'Overloaded')] });
  check('★ 重答回非 2xx（529）：給固定句、回 200', bad.res.statusCode === 200 && bad.body.reply === FIXED_EV && bad.qa === FIXED_EV, JSON.stringify(bad.body));
  const empty = await run({ plan: [refusalJson(), okJson(null, { model: 'claude-sonnet-5-5' })] });
  check('　 重答回 200 但沒有文字：也是固定句', empty.body.reply === FIXED_EV);
  const bad401 = await run({ plan: [refusalJson(), errJson(401, 'authentication_error', 'invalid x-api-key')] });
  check('　 重答失敗不觸發金鑰警報（那一把金鑰剛剛才成功過）；也不讓整題變 500', bad401.res.statusCode === 200 && bad401.body.reply === FIXED_EV && linePushes.length === 0, JSON.stringify(linePushes));
}
{
  const en = await run({ q: 'What is the annual capacity?', plan: [refusalJson(), refusalJson()] });
  check('　 記者用英文問：固定句是英文', en.body.reply === refusalReply({ contact: '王小明 03-1111111', english: true }) && /^I'm unable to answer/.test(en.body.reply), en.body.reply);
  const plain = await run({ event: 'plain', plan: [refusalJson(), refusalJson()] });
  check('　 活動沒填新聞聯絡人：只說「洽新聞聯絡人」', plain.body.reply === '這一題我這邊沒辦法回答，建議洽新聞聯絡人。', plain.body.reply);
  const simp = await run({ event: 'simp', plan: [refusalJson(), refusalJson()] });
  check('★ 固定句過繁體出口：後台貼進來的聯絡人是簡體（发言人）→ 送出去是繁體（發言人）', simp.body.reply.includes('發言人') && !simp.body.reply.includes('发') && simp.qa === simp.body.reply, simp.body.reply);
}
{
  setMode('on');
  const fixed = await run({ plan: [refusalJson(), refusalJson()] });
  check('★ 拒答的固定句不做答案出口檢查（on 模式也不附提醒、不記 [grounding]）', fixed.body.reply === FIXED_EV && !hasGrounding(fixed));
  const redo = await run({ plan: [refusalJson(), okJson(FAB, { model: 'claude-sonnet-5-5' })] });
  check('★ Sonnet 重答出來的真答案要檢查：編造的數字照樣附提醒', redo.body.reply.startsWith(FAB + NOTE_START) && hasGrounding(redo), redo.body.reply);
  setMode(undefined);
}
{
  // 剩餘時間：沿用 55 秒上限扣掉已用，最少 5 秒
  const realNow = Date.now;
  const realTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const slow = (ms) => () => { offset += ms; return refusalJson(); };
    offset = 0; timeouts.length = 0;
    await run({ plan: [slow(20_000), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    const t20 = [...timeouts];
    offset = 0; timeouts.length = 0;
    await run({ plan: [slow(52_000), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    const t52 = [...timeouts];
    offset = 0; timeouts.length = 0;
    await run({ plan: [refusalJson(), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    const t0 = [...timeouts];
    check('★ 重答的逾時＝55 秒扣掉已用掉的（Haiku 那趟花了 20 秒 → 約 35 秒）', t20.length === 2 && t20[0] > 54_000 && t20[0] <= 55_000 && t20[1] > 34_000 && t20[1] <= 35_000, JSON.stringify(t20));
    check('　 已經用掉 52 秒：最少給 5 秒（不是負數、不是 3 秒）', t52.length === 2 && t52[1] === 5_000, JSON.stringify(t52));
    check('　 Haiku 馬上就回：重答幾乎有整個 55 秒', t0.length === 2 && t0[1] > 54_000 && t0[1] <= 55_000, JSON.stringify(t0));
  } finally {
    Date.now = realNow;
    AbortSignal.timeout = realTimeout;
  }
}
{
  // 預設就是「拒答不吃進 Haiku 的失敗」：一般的 API 錯誤行為不變，也不重答
  const r400 = await run({ plan: [errJson(400, 'invalid_request_error', 'messages: bad')] });
  check('★ 一般 400：照舊回 400 與固定中文訊息，不重答', r400.res.statusCode === 400 && r400.body.error === '暫時無法取得回應，請稍後再試，或洽現場新聞聯絡人。' && r400.calls.length === 1, JSON.stringify(r400.body));
  const r529 = await run({ plan: [errJson(529, 'overloaded_error', 'Overloaded')] });
  check('★ 529：照舊回 529 與「詢問的人比較多」，不重答、不洩漏 Overloaded 原文', r529.res.statusCode === 529 && r529.body.error === '目前詢問的人比較多，請稍候幾秒再問一次。' && r529.calls.length === 1);
  const rs529 = await run({ stream: true, plan: [errJson(529, 'overloaded_error', 'Overloaded')] });
  check('　 串流請求遇到 529：同樣在切 SSE 之前回 JSON 錯誤碼', rs529.res.statusCode === 529 && /稍候/.test(rs529.body.error) && rs529.raw === '' && rs529.calls.length === 1);
  check('　 這些錯誤沒有 [ai-refusal]、也沒有 qa_log', !r529.logs.some((l) => l.startsWith('[ai-refusal]')) && r529.qaRows.length === 0);
}
{
  // 對照組：真正的金鑰失效（401）照舊通知管理員——證明上面「沒有通知」不是因為偵測壞了
  resetAiAlertThrottle();
  linePushes.length = 0;
  const r = await run({ plan: [errJson(401, 'authentication_error', 'invalid x-api-key')] });
  check('（對照）金鑰失效 401：照舊回 401 並通知管理員一次', r.res.statusCode === 401 && linePushes.length === 1 && linePushes[0].to === 'Uadmin', JSON.stringify(linePushes.map((p) => p.to)));
  linePushes.length = 0;
  resetAiAlertThrottle();
}
{
  // 備援參數被 API 退回（400）的自癒：重答走的是 postAnthropic，不是裸 fetch
  resetRefusalFallbacks();
  const r = await run({ plan: [refusalJson(), errJson(400, 'invalid_request_error', 'fallbacks: Extra inputs are not permitted'), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('★ 重答遇到「備援參數被退回」的 400：自動不帶備援重送一次，記者照樣拿到答案', r.body.reply === CLEAN && r.calls.length === 3 && r.calls[1].body.fallbacks === 'default' && !('fallbacks' in r.calls[2].body) && !('anthropic-beta' in r.calls[2].headers), `${r.calls.length} ${JSON.stringify(r.body)}`);
  resetRefusalFallbacks();
}

/* ═════════ 四、拒答（串流）═════════ */
out('\n── 四、拒答：串流 ──');
const SONNET_TEXT = '预计 2027 年第二季量产，年产能 500 台。\n内容仅供参考，以工研院官网新闻稿或发言为准。';
{
  const r = await run({ stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP]), okJson(SONNET_TEXT, { model: 'claude-sonnet-5-5' })] });
  check('★ 串流：輸出前就被攔下 → Sonnet 非串流重答，成功就照常用 SSE 格式送出（過繁體出口）', r.text === CLEAN && lastIsDone(r) && noError(r) && r.raw.startsWith(': ok\n\n'), JSON.stringify(r.events));
  check('　 重答是非串流請求、Sonnet 5.5、thinking 是 between_tools、沒有 temperature／budget_tokens', r.calls.length === 2 && r.calls[1].body.model === 'claude-sonnet-5-5' && r.calls[1].body.stream === false && r.calls[1].body.thinking?.type === 'between_tools' && !('temperature' in r.calls[1].body) && !('budget_tokens' in (r.calls[1].body.thinking || {})) && r.calls[1].body.fallbacks === 'default');
  check('　 qa_log 記重答的答案', r.qa === CLEAN && r.qaRows.length === 1, r.qa);
  check('　 [ai-refusal] 記一行，分類取自 message_delta 的 delta.stop_details', r.logs.filter((l) => l.startsWith('[ai-refusal]')).join('|') === '[ai-refusal] where=網頁問答 model=claude-haiku-5-5 category=cyber event=ev', r.logs.filter((l) => l.startsWith('[ai-refusal]')).join('|'));
  check('　 被攔下那一趟的用量照記，Sonnet 重答另記一行；沒有金鑰警報', r.logs.some((l) => /^\[ai-usage\] 網頁問答 model=claude-haiku-5-5 in=1200 cache_read=1000/.test(l)) && r.logs.some((l) => /^\[ai-usage\] 網頁問答（拒答改 Sonnet） model=claude-sonnet-5-5/.test(l)) && linePushes.length === 0);
}
{
  const r = await run({ stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), refusalJson({ model: 'claude-sonnet-5-5' })] });
  check('★ 串流輸出前被攔、重答也被攔：送固定句（{t} 事件，不是 error 事件），然後 done', r.text === FIXED_EV && noError(r) && lastIsDone(r), JSON.stringify(r.events));
  check('　 qa_log 記固定句', r.qa === FIXED_EV);
  const to = await run({ stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }] });
  check('　 重答逾時：同樣是固定句，連線正常收尾', to.text === FIXED_EV && noError(to) && lastIsDone(to) && to.qa === FIXED_EV);
  const bad = await run({ stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), errJson(529, 'overloaded_error', 'Overloaded')] });
  check('　 重答回 529：同樣是固定句', bad.text === FIXED_EV && noError(bad) && lastIsDone(bad));
  const en = await run({ q: 'Tell me the capacity', stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), refusalJson()] });
  check('　 英文提問：固定句是英文', en.text === refusalReply({ contact: '王小明 03-1111111', english: true }), en.text);
  const simp = await run({ event: 'simp', stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), refusalJson()] });
  check('★ 串流的固定句也過繁體出口（发言人 → 發言人）', simp.text.includes('發言人') && !simp.text.includes('发'), simp.text);
}
{
  // 事件形狀文件沒寫死：stop_reason 在 delta、事件本身、message_start 的 message 任何一處都算
  const shapes = {
    'delta.stop_reason': [ME, mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP],
    '事件本身的 stop_reason＋stop_details': [ME, { type: 'message_delta', stop_reason: 'refusal', stop_details: REFUSAL_DETAILS('frontier_llm'), usage: { output_tokens: 0 } }, MSTOP],
    'message_start 的 message.stop_reason': [{ ...ME, message: { ...ME.message, stop_reason: 'refusal', stop_details: REFUSAL_DETAILS('general_harms') } }, MSTOP],
    '沒有 message_stop、沒有 stop_details': [ME, { type: 'message_delta', delta: { stop_reason: 'refusal' } }]
  };
  for (const [name, events] of Object.entries(shapes)) {
    const r = await run({ stream: true, plan: [sse(events), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    check(`★ 寬鬆的事件形狀「${name}」：認得是拒答並重答`, r.calls.length === 2 && r.text === CLEAN, `${r.calls.length} ${r.text}`);
  }
  const cat = await run({ stream: true, plan: [sse(shapes['事件本身的 stop_reason＋stop_details']), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('　 stop_details 在事件本身時，category 也讀得到（log 用）', cat.logs.some((l) => /category=frontier_llm/.test(l)));
  const nodetail = await run({ stream: true, plan: [sse(shapes['沒有 message_stop、沒有 stop_details']), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('　 找不到 stop_details：category=null，照樣處理', nodetail.logs.some((l) => /^\[ai-refusal\] .*category=null/.test(l)));
}
{
  const r = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('半截沒有標點的字'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP]), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('★ 串流：只有囤在繁體轉換器裡、還沒送出的半截字就被攔 → 當成「輸出前被攔」：半截字丟掉、改用重答', r.text === CLEAN && !r.raw.includes('半截') && r.calls.length === 2, r.text);
}
{
  const r = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('根據新聞稿，預計 2028 年量產，'), delta('並且還有'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP])] });
  const ts = r.events.filter((e) => typeof e.t === 'string').map((e) => e.t);
  check('★ 串流：輸出到一半被攔 → 已送出的字照舊，接著送說明，然後 done', JSON.stringify(ts) === JSON.stringify(['根據新聞稿，預計 2028 年量產，', '\n\n' + MIDWAY]) && lastIsDone(r), JSON.stringify(ts));
  check('　 不重答（字已經送出去了，收不回來）、沒有 error 事件', r.calls.length === 1 && noError(r));
  check('　 被攔下來、沒送出的半截字（並且還有）不會出現', !r.raw.includes('並且還有'));
  check('　 qa_log 記完整內容：已送出的字＋說明', r.qa === '根據新聞稿，預計 2028 年量產，\n\n' + MIDWAY, r.qa);
  check('　 說明是繁體、不含 Markdown', findResidualSimplified(MIDWAY).length === 0 && toTraditionalTW(MIDWAY) === MIDWAY && !/[*_`#]/.test(MIDWAY));
  check('　 記一行 [ai-refusal]，沒有金鑰警報', r.logs.filter((l) => l.startsWith('[ai-refusal]')).length === 1 && linePushes.length === 0);
  const en = await run({ q: 'What is the target year?', stream: true, plan: [sse([ME, BLOCK_START, delta('The target is 2027, '), delta('and'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP])] });
  check('　 英文提問：說明是英文', en.text === 'The target is 2027, \n\n(The rest of this answer could not be completed. Please contact the press contact.)', en.text);
  setMode('on');
  const g = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('根據新聞稿，預計 2028 年量產，'), delta('並且還有'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP])] });
  setMode(undefined);
  check('★ 中途被攔的半截答案＋說明不做答案出口檢查（on 模式也不附提醒、不記 [grounding]）', !g.text.includes('⚠️') && !hasGrounding(g) && g.qa.endsWith(MIDWAY), g.text);
}
{
  // 事件被切在位元組中間：偵測不受影響
  const chunked = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('根據新聞稿，'), delta('預計'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP], { chunk: 7 })] });
  check('　 SSE 位元組切成 7 byte 一塊：照樣偵測到拒答、說明照樣送出', chunked.text === '根據新聞稿，\n\n' + MIDWAY && lastIsDone(chunked), chunked.text);
  const chunked2 = await run({ stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP], { chunk: 5 }), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
  check('　 輸出前被攔、SSE 切成 5 byte 一塊：照樣重答', chunked2.text === CLEAN && chunked2.calls.length === 2);
}
{
  // 既有的斷線路徑不能被破壞
  setMode('on');
  const r = await run({ stream: true, plan: [sse([ME, BLOCK_START, delta('預計 2028 年量產，'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] });
  setMode(undefined);
  const ev = r.events;
  check('★ 答到一半斷線（error 事件）：已送的字照舊、補「沒有答完」、done；on 模式也不附提醒', ev.filter((e) => e.t).map((e) => e.t).join('') === '預計 2028 年量產，' && ev.some((e) => e.error === '（連線中斷，這一題沒有答完，請再問一次。）') && lastIsDone(r) && !r.text.includes('⚠️'), JSON.stringify(ev));
  check('　 斷線時 qa_log 照舊是「答案＋換行＋斷線說明」', r.qa === '預計 2028 年量產，\n（連線中斷，這一題沒有答完，請再問一次。）', r.qa);
  check('　 斷線不算拒答：不重答、沒有 [ai-refusal]', r.calls.length === 1 && !r.logs.some((l) => l.startsWith('[ai-refusal]')));
  const none = await run({ stream: true, plan: [sse([ME, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] });
  check('　 一個字都沒出就斷線：照舊送「詢問的人比較多」', none.events.some((e) => e.error === '目前詢問的人比較多，請稍候幾秒再問一次。') && none.calls.length === 1);
  const empty = await run({ stream: true, plan: [sse([ME, BLOCK_START, BLOCK_STOP, mdelta('end_turn'), MSTOP])] });
  check('　 模型什麼都沒說（不是拒答）：照舊「抱歉，無法取得回應。」，qa_log 同', empty.qa === '抱歉，無法取得回應。' && empty.calls.length === 1);
}
{
  // 串流時 Sonnet 重答的時間
  const realNow = Date.now;
  const realTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const slow = () => { offset += 53_000; return sse([ME, mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP]); };
    await run({ stream: true, plan: [slow, okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    check('　 串流：Haiku 那趟用掉 53 秒 → 重答最少給 5 秒', timeouts.length === 2 && timeouts[1] === 5_000, JSON.stringify(timeouts));
  } finally {
    Date.now = realNow;
    AbortSignal.timeout = realTimeout;
  }
}

/* ═════════ 四之二、批次 134 審查補強：對話歷史、聯絡人名稱、提醒語言、固定句語言 ═════════ */
out('\n── 四之二、被拒答的那一輪不再帶進下一題（回歸 F1）──');
{
  const Q_BAD = '被誤判的生醫題';
  const hist = [
    { role: 'user', content: '產能多少？' },
    { role: 'assistant', content: CLEAN },
    { role: 'user', content: Q_BAD },
    { role: 'assistant', content: FIXED_EV },
    { role: 'user', content: '量產時間？' }
  ];
  const r = await run({ messages: hist, plan: [okJson(CLEAN)] });
  const sent = r.calls[0]?.body.messages || [];
  check('★ 之前被拒答的那一輪（問題＋固定句）不帶進這一題的請求，其餘原樣、最後一題留著',
    J(sent.map((m) => m.content)) === J(['產能多少？', CLEAN, '量產時間？']) && sent[0].role === 'user' && sent[sent.length - 1].content === '量產時間？', J(sent.map((m) => m.content.slice(0, 10))));
  check('　 記者看到的答案、qa_log 照常（沒有因為過濾而變）', r.body.reply === CLEAN && r.qa === CLEAN && r.res.statusCode === 200);

  const sr = await run({ stream: true, messages: hist, plan: [okStream(['預計 2027 年第二季量產，', '年產能 500 台。\n', W])] });
  check('　 串流請求一樣過濾', J((sr.calls[0]?.body.messages || []).map((m) => m.content)) === J(['產能多少？', CLEAN, '量產時間？']), J((sr.calls[0]?.body.messages || []).map((m) => m.content.slice(0, 10))));

  // 輸出到一半被攔下的那一輪（半截答案＋說明句）也一樣；英文版說明句也是
  const midHist = [
    { role: 'user', content: '前一題' }, { role: 'assistant', content: '根據新聞稿，\n\n' + MIDWAY },
    { role: 'user', content: 'English one' }, { role: 'assistant', content: 'The target is 2027, \n\n(The rest of this answer could not be completed. Please contact the press contact.)' },
    { role: 'user', content: '產能多少？' }
  ];
  const mr = await run({ messages: midHist, plan: [okJson(CLEAN)] });
  check('★ 半截答案加說明句的那一輪（中英文兩種說明）也整輪拿掉', J((mr.calls[0]?.body.messages || []).map((m) => m.content)) === J(['產能多少？']), J((mr.calls[0]?.body.messages || []).map((m) => m.content.slice(0, 10))));

  // 半截答案很長（超過 8000 字上限）：說明句在結尾，要在截斷之前判斷，不然說明句被截掉就認不出這一輪被拒答過
  const longMid = await run({ messages: [{ role: 'user', content: '前一題' }, { role: 'assistant', content: '長'.repeat(8500) + '。\n\n' + MIDWAY }, { role: 'user', content: '產能多少？' }], plan: [okJson(CLEAN)] });
  check('　 半截答案超過 8000 字、說明句在結尾：照樣認得是被拒答的一輪、整輪拿掉', J((longMid.calls[0]?.body.messages || []).map((m) => m.content)) === J(['產能多少？']), J((longMid.calls[0]?.body.messages || []).map((m) => m.content.length)));

  // 拿掉之後仍然以 user 開頭、不會把唯一的一題拿光
  const only = await run({ messages: [{ role: 'user', content: Q_BAD }, { role: 'assistant', content: FIXED_EV }, { role: 'user', content: '產能多少？' }], plan: [okJson(CLEAN)] });
  check('★ 整段歷史只有那一輪被拒答：拿掉之後只剩現在這一題，仍以 user 開頭，照常回答', only.res.statusCode === 200 && J(only.calls[0].body.messages) === J([{ role: 'user', content: '產能多少？' }]), J(only.calls[0]?.body.messages));
  const lastAssistant = await run({ messages: [{ role: 'user', content: Q_BAD }, { role: 'assistant', content: FIXED_EV }], plan: [okJson(CLEAN)] });
  check('　 最後一則是 assistant 的固定句（怪請求）：不動它，不把使用者這一題拿光（照舊交給模型 API 決定，不是我們變出 400）', lastAssistant.calls.length === 1 && lastAssistant.calls[0].body.messages.length === 2, J(lastAssistant.calls[0]?.body.messages));
  const normal = await run({ messages: [{ role: 'user', content: '產能多少？' }, { role: 'assistant', content: CLEAN }, { role: 'user', content: '再說一次' }], plan: [okJson(CLEAN)] });
  check('★ 沒有拒答的歷史：請求內容跟以前一模一樣（三則原樣送出）', J(normal.calls[0].body.messages.map((m) => m.content)) === J(['產能多少？', CLEAN, '再說一次']));
  // 模型自己寫出同開頭的正常答案，不能被當成拒答而被拿掉
  const lookalike = '這一題我這邊沒辦法回答，因為新聞稿沒有提到。';
  const keep = await run({ messages: [{ role: 'user', content: '有沒有得獎名單？' }, { role: 'assistant', content: lookalike }, { role: 'user', content: '再說一次' }], plan: [okJson(CLEAN)] });
  check('　 正常答案剛好以「這一題我這邊沒辦法回答」開頭（整句不是固定句）：不當成拒答，照樣留在歷史裡', keep.calls[0].body.messages.length === 3, J(keep.calls[0]?.body.messages));
  // 端到端：拒答之後再問一題，前端把整串送回來
  const t1 = await run({ plan: [refusalJson(), refusalJson()] });
  const t2 = await run({ messages: [{ role: 'user', content: '產能多少？' }, { role: 'assistant', content: t1.body.reply }, { role: 'user', content: '量產時間？' }], plan: [okJson(CLEAN)] });
  check('★ 端到端：伺服器真的送出去的拒答固定句，下一題就被認得、不再帶上去', t2.calls[0].body.messages.length === 1 && t2.calls[0].body.messages[0].content === '量產時間？', J(t2.calls[0]?.body.messages));
}

out('\n── 四之二之二、拒答固定句裡的聯絡人是名稱：只轉字、不轉用語，跟 LINE 一致（回歸 F4／規範 F3）──');
{
  const FIXED_PV = refusalReply({ contact: '光伏事業部 林經理 0912-345-678' });
  const r = await run({ event: 'pv', plan: [refusalJson(), refusalJson()] });
  check('★ 非串流：後台打的單位名稱「光伏事業部」原樣顯示，沒有被用語層改成「太陽光電事業部」', r.body.reply === FIXED_PV && r.body.reply.includes('光伏事業部') && !r.body.reply.includes('太陽光電') && r.qa === FIXED_PV, r.body.reply);
  const rs = await run({ event: 'pv', stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), refusalJson({ model: 'claude-sonnet-5-5' })] });
  check('★ 串流（輸出前被攔、重答也被攔）：同樣原樣顯示', rs.text === FIXED_PV && rs.qa === FIXED_PV, rs.text);
  const en = await run({ event: 'pv', q: 'What is the annual capacity?', plan: [refusalJson(), refusalJson()] });
  check('　 英文版固定句裡的聯絡人也一樣原樣', en.body.reply === refusalReply({ contact: '光伏事業部 林經理 0912-345-678', english: true }), en.body.reply);
  const simp = await run({ event: 'simp', plan: [refusalJson(), refusalJson()] });
  check('　 簡體字照轉（发言人 → 發言人）：只是不轉用語，簡體防線還在', simp.body.reply.includes('發言人') && !simp.body.reply.includes('发'), simp.body.reply);
}

out('\n── 四之二之三、固定句的語言：只打縮寫或數字的短問題當中文（規範 F6）──');
{
  const cases = [['TSMC?', false], ['HBM4？', false], ['5G', false], ['2026', false], ['TSMC capacity?', true], ['What is the annual capacity?', true], ['產能多少？', false]];
  const bad = [];
  for (const [q, english] of cases) {
    const r = await run({ q, plan: [refusalJson(), refusalJson()] });
    if (r.body.reply !== refusalReply({ contact: '王小明 03-1111111', english })) bad.push(`${q} → ${r.body.reply}`);
    const rs = await run({ q, stream: true, plan: [sse([ME, mdelta('refusal', REFUSAL_DETAILS('bio')), MSTOP]), refusalJson({ model: 'claude-sonnet-5-5' })] });
    if (rs.text !== refusalReply({ contact: '王小明 03-1111111', english })) bad.push(`串流 ${q} → ${rs.text}`);
  }
  check('★ 非串流與串流：「TSMC?」「HBM4？」「5G」「2026」收到中文固定句；夠像一句英文的才收到英文', bad.length === 0, bad.join('\n'));
  const mid = await run({ q: 'TSMC?', stream: true, plan: [sse([ME, BLOCK_START, delta('台積電，'), mdelta('refusal', REFUSAL_DETAILS('cyber')), MSTOP])] });
  check('　 輸出到一半被攔：說明句也跟著問題的語言（縮寫提問 → 中文說明）', mid.text === '台積電，\n\n' + MIDWAY, mid.text);
}

out('\n── 四之二之四、ANSWER_GROUNDING=on：英文答案附英文版提醒（規範 F4）──');
{
  const FAB_EN = 'The target is 2028 with an investment of 800 billion NT dollars.';
  const WE = 'For reference only; please rely on the official ITRI press release.';
  setMode('on');
  const r = await run({ q: 'What is the target year?', plan: [okJson(`${FAB_EN}\n${WE}`)] });
  const note = r.body.reply.split('\n\n').pop();
  check('★ 非串流 on：英文答案後面接英文版提醒（沒有中文字、沒有 Markdown），點名編造的數字', /^⚠️ Some items above \(.*2028.*\) could not be found in the press release\. Please confirm with the press contact before citing\.$/.test(note) && !/[一-鿿]/.test(note) && !/[*_`#]/.test(note), r.body.reply);
  check('　 提醒排在警語之後；qa_log 一致', r.body.reply.indexOf(WE) < r.body.reply.indexOf('⚠️') && r.qa === r.body.reply);
  const zhWarn = await run({ q: 'What is the target year?', plan: [okJson(`${FAB_EN}\n內容僅供參考，以工研院官網新聞稿或發言為準。`)] });
  check('★ 英文答案結尾的警語仍是中文：照樣判成英文（先拿掉警語再判斷語言），提醒是英文版', /Some items above/.test(zhWarn.body.reply) && !/以上內容有幾處/.test(zhWarn.body.reply), zhWarn.body.reply);
  const rs = await run({ stream: true, q: 'What is the target year?', plan: [okStream([FAB_EN.slice(0, 30), FAB_EN.slice(30) + '\n', WE])] });
  const sn = rs.events.filter((e) => typeof e.t === 'string').map((e) => e.t).pop() || '';
  check('　 串流 on：多送的那個 {t} 事件是英文版提醒；qa_log 一致', sn.startsWith('\n\n⚠️ Some items above (') && lastIsDone(rs) && rs.qa.endsWith(sn), JSON.stringify(rs.events.slice(-3)));
  const zh = await run({ plan: [okJson(FAB)] });
  check('★ （對照）中文答案仍然是中文版提醒，一個字都沒變', zh.body.reply.startsWith(FAB + NOTE_START) && zh.body.reply.endsWith(NOTE_END), zh.body.reply);
  setMode(undefined);
}

/* ═════════ 五、企業場 ═════════ */
out('\n── 五、企業場拒答 ──');
{
  const redoOk = '這套模組主要用在 CNC 產線的熱管理。';
  const r = await run({ event: 'biz', stream: true, q: '用在哪裡？', plan: [refusalJson({ category: 'cyber' }), okJson(redoOk, { model: 'claude-sonnet-5-5' })] });
  check('★ 企業場：前台要串流也不串流（先整則檢查）；拒答 → Sonnet 重答成功', r.calls.length === 2 && r.calls[0].body.stream === false && r.calls[1].body.stream === false && r.raw === '' && typeof r.body?.reply === 'string', JSON.stringify(r.body));
  check('　 重答的文字照舊過 guardBusinessAnswer：補企業免責句', r.body.reply.startsWith(redoOk) && /不構成報價或合作承諾/.test(r.body.reply), r.body.reply);
  check('　 qa_log 記同一段', r.qa === r.body.reply);
  check('　 [ai-refusal] 標明是企業場那一條路', r.logs.some((l) => /^\[ai-refusal\] where=網頁問答（企業場） model=claude-haiku-5-5 category=cyber event=biz$/.test(l)), r.logs.filter((l) => l.startsWith('[ai-refusal]')).join('|'));
  check('　 Sonnet 用量那行也標企業場', r.logs.some((l) => /^\[ai-usage\] 網頁問答（企業場）（拒答改 Sonnet） model=claude-sonnet-5-5/.test(l)), r.logs.filter((l) => l.startsWith('[ai-usage]')).join('|'));
  const quote = await run({ event: 'biz', q: '授權金多少？', plan: [refusalJson(), okJson('授權金大約 500 萬元。', { model: 'claude-sonnet-5-5' })] });
  check('★ 重答的文字裡有背景資料沒有的金額：照舊整則換成「不能代為報價」的固定回覆', /不能代為報價或承諾/.test(quote.body.reply) && !/500/.test(quote.body.reply), quote.body.reply);
}
{
  const r = await run({ event: 'biz', q: '用在哪裡？', plan: [refusalJson(), refusalJson({ model: 'claude-sonnet-5-5' })] });
  const fixed = refusalReply({ contact: '業務窗口 林小姐 03-5912345' });
  check('★ 企業場重答也被攔：固定句（含活動聯絡窗口）', r.res.statusCode === 200 && r.body.reply === fixed, r.body.reply);
  check('　 決定：固定句不再補企業免責句（沒有答案時本來就不補；固定句沒說任何價格或承諾）', !/不構成報價/.test(r.body.reply) && r.qa === fixed);
  check('　 企業場不做答案出口檢查，也沒有金鑰警報', !hasGrounding(r) && linePushes.length === 0);
  const to = await run({ event: 'biz', q: '用在哪裡？', plan: [refusalJson(), () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }] });
  check('　 企業場重答逾時：固定句、200', to.res.statusCode === 200 && to.body.reply === fixed);
}
{
  process.env.ANTHROPIC_API_KEY_BUSINESS = 'biz-key';
  try {
    const biz = await run({ event: 'biz', q: '用在哪裡？', plan: [refusalJson(), okJson('主要用在 CNC 產線。', { model: 'claude-sonnet-5-5' })] });
    const media = await run({ event: 'ev', plan: [refusalJson(), okJson(CLEAN, { model: 'claude-sonnet-5-5' })] });
    check('★ 企業場拒答改 Sonnet 重答：用企業那一把金鑰（原本那次與重答都是）', biz.calls.length === 2 && biz.calls[0].headers['x-api-key'] === 'biz-key' && biz.calls[1].headers['x-api-key'] === 'biz-key', JSON.stringify(biz.calls.map((c) => c.headers['x-api-key'])));
    check('　 記者場的重答仍用記者那一把，不被企業金鑰影響', media.calls[0].headers['x-api-key'] === 'key-main' && media.calls[1].headers['x-api-key'] === 'key-main');
    resetAiAlertThrottle(); linePushes.length = 0;
    const down = await run({ event: 'biz', plan: [errJson(401, 'authentication_error', 'invalid x-api-key')] });
    check('（對照）企業金鑰失效 401：照舊通知，且寫明只影響企業場', down.res.statusCode === 401 && linePushes.length === 1 && /企業場/.test(linePushes[0].messages[0].text), JSON.stringify(linePushes));
    linePushes.length = 0; resetAiAlertThrottle();
  } finally {
    delete process.env.ANTHROPIC_API_KEY_BUSINESS;
  }
}

/* ═════════ 六、既有行為不變 ═════════ */
out('\n── 六、既有行為不變：媒體名稱、限流、CORS、活動狀態 ──');
{
  const o = fakeRes();
  await chat({ method: 'OPTIONS', headers: {}, socket: {}, body: {} }, o);
  check('CORS：OPTIONS 回 200，三個 Access-Control 標頭都在', o.statusCode === 200 && o.headers['access-control-allow-origin'] === '*' && o.headers['access-control-allow-methods'] === 'POST,OPTIONS' && o.headers['access-control-allow-headers'] === 'Content-Type');
  const g = fakeRes();
  await chat({ method: 'GET', headers: {}, socket: {}, body: {} }, g);
  check('　 GET → 405', g.statusCode === 405 && g.body.error === 'Method not allowed');
  const m = await run({ body: { media_name: '  ' }, plan: [okJson(CLEAN)] });
  check('★ 沒填媒體名稱：400＋code=media_required，不呼叫模型', m.res.statusCode === 400 && m.body.code === 'media_required' && m.calls.length === 0 && m.qaRows.length === 0, JSON.stringify(m.body));
  const d = await run({ event: 'draft', plan: [okJson(CLEAN)] });
  check('　 未發布的活動：404，不呼叫模型', d.res.statusCode === 404 && d.body.error === '活動不存在或已結束' && d.calls.length === 0);
  const bad = await run({ messages: [{ role: 'assistant', content: '哈囉' }], plan: [okJson(CLEAN)] });
  check('　 整串都沒有記者的問題：400「請求格式錯誤」', bad.res.statusCode === 400 && bad.body.error === '請求格式錯誤' && bad.calls.length === 0);
  const noMsg = fakeRes();
  await chat({ method: 'POST', headers: { 'x-forwarded-for': '10.99.99.1' }, socket: {}, body: { event_id: 'ev', media_name: 'x' } }, noMsg);
  check('　 沒帶 messages：400「請求格式錯誤」', noMsg.statusCode === 400 && noMsg.body.error === '請求格式錯誤');
}
{
  // 限流：同一位記者（client_id）每分鐘 15 題，第 16 題 429
  plan = []; calls = [];
  let last = null, firstBlocked = 0;
  for (let i = 1; i <= 16; i++) {
    plan.push(okJson(CLEAN));
    const res = fakeRes();
    await chat({ method: 'POST', headers: { 'x-forwarded-for': '10.77.0.1' }, socket: {}, body: { event_id: 'ev', media_name: '中央社', client_id: 'rate-limit-client', messages: [{ role: 'user', content: `第 ${i} 題` }] } }, res);
    last = res;
    if (!firstBlocked && res.statusCode === 429) firstBlocked = i;
  }
  check('限流：同一位記者第 16 題才 429，訊息不變', firstBlocked === 16 && last.body.error === '提問太頻繁，請稍候片刻再試。', `${firstBlocked} ${JSON.stringify(last.body)}`);
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
Object.assign(console, realConsole);
out(`\n${fail === 0 ? '✅' : '❌'} 批次 132／134 網頁問答接線測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
