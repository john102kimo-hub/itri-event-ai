// 批次 175：模擬記者會當天（同仁試問）。
// 朱朱：「活動前記者問答只會顯示媒體邀請函內容，無法測試記者會當天真實問答狀況」。
//   一、規則（lib/prompt.js）：sim_day 旗標讓「活動前」的判斷全部當成活動當天；沒帶旗標的行為一個字不變
//   二、網頁問答 API（api/chat.js）：編輯碼對才放行；記者自己帶參數拿不到；試問記成（內部職員）
//   三、活動頁資料（api/events.js get_public）：同樣要編輯碼；回應不給 CDN 記住
//   四、畫面：編輯頁、後台、記者前台的按鈕與提示
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');
const P = await import('../lib/prompt.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], body: undefined, headersSent: false, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.send = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (x) => { r.headersSent = true; r.chunks.push(String(x)); return true; };
  r.flush = () => {};
  r.end = (x) => { if (x !== undefined) r.chunks.push(String(x)); r.ended = true; return r; };
  return r;
}

const inDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const INVITE = '親愛的媒體朋友：誠摯邀請蒞臨採訪。時間：10:00；地點：中興院區 51 館。';
const KB = '【新聞稿全文】\n工研院今日發表新一代儲電技術，預計 2027 年第二季量產。';
const IMG = 'https://example.com/a.jpg|量產線照片';
const row = (o = {}) => [
  o.id || 'e1', o.name || '儲電新技術發表會', '#0F9E7A', o.kb ?? KB, o.status || 'active', o.date ?? inDays(3), o.chips ?? '當天提問一\n當天提問二', o.images ?? IMG, '', '工研院',
  'cc', '10:00', '中興院區 51 館', '記者會', '林小華 03-5912222', '', o.invite ?? INVITE, o.inviteChips ?? '邀請函是什麼？'
];

// ═══ 一、規則 ═════════════════════════════════════════════════════════════════
console.log('\n── 一、規則（lib/prompt.js）──');
{
  const ev = { knowledge_base: KB, invite_letter: INVITE, event_date: inDays(3), chips: '當天提問一', images: IMG, invite_letter_chips: '邀請函是什麼？' };
  const normal = P.resolveEventContent(ev);
  const sim = P.resolveEventContent(P.simulateEventDay(ev));
  check('★ 沒帶旗標：活動前照舊只給邀請函（知識庫換成邀請函、照片清空、換成活動前快速提問）', normal.knowledge_base === INVITE && normal.images === '' && normal.chips === '邀請函是什麼？');
  check('★ 帶 sim_day：知識庫、照片、快速提問都是活動當天那一份', sim.knowledge_base === KB && sim.images === IMG && sim.chips === '當天提問一', JSON.stringify(sim));
  check('　 isPreEventMode：模擬時是 false（system prompt 不會多寫「目前是邀請函」那條規則）', P.isPreEventMode(ev) === true && P.isPreEventMode(P.simulateEventDay(ev)) === false);
  check('　 system prompt 裡沒有邀請函模式的提醒', !P.buildSystemPrompt(P.resolveEventContent(P.simulateEventDay(ev))).includes('目前活動尚未舉行') && P.buildSystemPrompt(normal).includes('目前活動尚未舉行'));
  const noKb = { ...ev, knowledge_base: '' };
  const simNoKb = P.resolveEventContent(P.simulateEventDay(noKb));
  check('★ 新聞稿還沒貼（知識庫沒內容）→ 模擬跟真的當天一樣，繼續用邀請函（批次 173 的保險）', simNoKb.knowledge_base === INVITE && simNoKb.invite_fallback === true, JSON.stringify(simNoKb).slice(0, 200));
  const basics = P.formatEventBasics({ event_date: inDays(3), event_time: '10:00', venue: '中興院區 51 館', sim_day: true });
  check('★ 活動基本資料寫「就是今天」，不再寫「還有 3 天」', basics.includes('就是今天') && !basics.includes('還有 3 天'), basics);
  const basicsReal = P.formatEventBasics({ event_date: inDays(3), event_time: '10:00', venue: '中興院區 51 館' });
  check('　 沒帶旗標：照舊「還有 3 天」', basicsReal.includes('還有 3 天'), basicsReal);
  check('canSimulateDay：還沒到＋有邀請函才需要模擬', P.canSimulateDay(ev) && !P.canSimulateDay({ ...ev, invite_letter: '' }) && !P.canSimulateDay({ ...ev, event_date: inDays(0) }) && !P.canSimulateDay({ ...ev, event_date: inDays(-2) }));
}

// ═══ 二、網頁問答 API ═════════════════════════════════════════════════════════
console.log('\n── 二、網頁問答 API（api/chat.js）──');
const modelCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(opts.body);
    modelCalls.push(body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '預計 2027 年第二季量產。' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const chat = (await import('../api/chat.js')).default;
let seq = 0;
const ask = async (body, headers = {}) => {
  seq++;
  const r = fakeRes();
  await chat({ method: 'POST', headers: { 'x-forwarded-for': `10.1.0.${seq}`, ...headers }, socket: {}, body: { client_id: `c${seq}`, ...body } }, r);
  return r;
};
const sysOf = (b) => (b.system || []).map((s) => s.text).join('\n');
const QA_HEAD = ['timestamp', 'event_id', 'event_name', 'media_name', 'question', 'answer', 'deleted', 'source', 'reporter_name'];
const resetBook = (...rows) => { reset(); book.events = [['id'], ...rows]; book.qa_log = [QA_HEAD]; };
const qaRows = () => book.qa_log.slice(1);

resetBook(row());
{
  modelCalls.length = 0;
  let r = await ask({ event_id: 'e1', media_name: '經濟日報', messages: [{ role: 'user', content: '何時量產？' }] });
  check('★ 記者問：活動前只拿到邀請函（沒有新聞稿、沒有「2027 年第二季」）', r.statusCode === 200 && sysOf(modelCalls.at(-1)).includes('誠摯邀請蒞臨採訪') && !sysOf(modelCalls.at(-1)).includes('2027 年第二季量產'));

  r = await ask({ event_id: 'e1', media_name: '經濟日報', sim_day: true, messages: [{ role: 'user', content: '何時量產？' }] });
  check('★ 記者自己帶 sim_day、沒有編輯碼 → 403，不呼叫模型', r.statusCode === 403 && modelCalls.length === 1, r.statusCode);
  r = await ask({ event_id: 'e1', media_name: '經濟日報', sim_day: true, edit_code: 'wrong', messages: [{ role: 'user', content: '何時量產？' }] });
  check('★ 編輯碼錯 → 403', r.statusCode === 403 && modelCalls.length === 1);
  r = await ask({ event_id: 'e1', media_name: '經濟日報', sim_day: 'true', edit_code: 'cc', messages: [{ role: 'user', content: '何時量產？' }] });
  check('　 sim_day 不是布林 true（字串 "true"）→ 當一般提問，仍然只給邀請函', r.statusCode === 200 && sysOf(modelCalls.at(-1)).includes('誠摯邀請蒞臨採訪') && !sysOf(modelCalls.at(-1)).includes('2027 年第二季量產'));
  r = await ask({ event_id: 'e1', media_name: '經濟日報', edit_code: 'cc', messages: [{ role: 'user', content: '何時量產？' }] });
  check('　 只帶編輯碼、沒帶 sim_day → 一般提問，沒有任何放行', r.statusCode === 200 && !sysOf(modelCalls.at(-1)).includes('2027 年第二季量產'));

  const before = modelCalls.length;
  r = await ask({ event_id: 'e1', sim_day: true, edit_code: 'cc', messages: [{ role: 'user', content: '何時量產？' }] });
  const sys = sysOf(modelCalls.at(-1));
  check('★ 編輯碼對：不用填媒體名稱、用活動當天的新聞稿回答', r.statusCode === 200 && modelCalls.length === before + 1 && sys.includes('2027 年第二季量產') && !sys.includes('誠摯邀請蒞臨採訪'), `${r.statusCode} ${JSON.stringify(r.body)}`);
  check('　 活動基本資料寫「就是今天」、沒有邀請函模式的提醒', sys.includes('就是今天') && !sys.includes('目前活動尚未舉行'), sys.slice(-400));
  check('　 編輯碼本身不會進 prompt', !sys.includes('"cc"') && !/edit_code/.test(sys));
  r = await ask({ event_id: 'e1', sim_day: true, messages: [{ role: 'user', content: '何時量產？' }] }, { 'x-admin-password': 'pw' });
  check('　 後台管理員密碼也可以（後台的按鈕走編輯碼，這是備用）', r.statusCode === 200 && sysOf(modelCalls.at(-1)).includes('2027 年第二季量產'));
  r = await ask({ event_id: 'e1', media_name: '經濟日報', messages: [{ role: 'user', content: '何時量產？' }] });
  check('　 試問完，記者再問：照舊只拿到邀請函（沒有快取殘留）', sysOf(modelCalls.at(-1)).includes('誠摯邀請蒞臨採訪') && !sysOf(modelCalls.at(-1)).includes('2027 年第二季量產'));

  // 問答紀錄：試問記成（內部職員）
  const logged = qaRows();
  check('★ 試問的問答記成「（內部職員）」；記者那幾題照記者名稱記（結案報告與統計本來就會濾掉內部職員）',
    logged.filter((x) => x[3] === '（內部職員）').length === 2 && logged.filter((x) => x[3] === '經濟日報').length >= 3, JSON.stringify(logged.map((x) => x[3])));
}
// 草稿與封存照舊不給
resetBook(row({ id: 'e2', status: 'draft' }));   // 活動設定在 chat.js 快取 60 秒，換一個 id 才不會讀到上面那場
{
  const r = await ask({ event_id: 'e2', sim_day: true, edit_code: 'cc', messages: [{ role: 'user', content: '何時量產？' }] });
  check('未發布的場次：測試前台跟記者前台一樣找不到（404）', r.statusCode === 404);
}

// ═══ 三、活動頁資料 ═══════════════════════════════════════════════════════════
console.log('\n── 三、活動頁資料（api/events.js get_public）──');
const events = (await import('../api/events.js')).default;
const getPublic = async (query) => { const r = fakeRes(); await events({ method: 'GET', query: { action: 'get_public', id: 'e1', ...query }, headers: {}, socket: {} }, r); return r; };
resetBook(row());
{
  let r = await getPublic({});
  check('★ 一般：活動前沒有照片、快速提問是活動前那組', r.statusCode === 200 && r.body.event.images === '' && r.body.event.chips.includes('邀請函是什麼？') && !r.body.event.sim_day, JSON.stringify(r.body.event));
  r = await getPublic({ sim_day: '1' });
  check('★ 帶 sim_day 沒有編輯碼 → 403，不給照片', r.statusCode === 403 && !JSON.stringify(r.body).includes('example.com'));
  r = await getPublic({ sim_day: '1', code: 'wrong' });
  check('　 編輯碼錯 → 403', r.statusCode === 403 && r.headers['cache-control'] === 'no-store');
  r = await getPublic({ code: 'cc' });
  check('　 只帶編輯碼、沒帶 sim_day → 一般回應，沒有照片', r.statusCode === 200 && r.body.event.images === '');
  r = await getPublic({ sim_day: '1', code: 'cc' });
  check('★ 編輯碼對：照片、快速提問都是活動當天那一份，而且標著 sim_day', r.statusCode === 200 && r.body.event.images === IMG && r.body.event.chips.includes('當天提問一') && r.body.event.sim_day === true, JSON.stringify(r.body.event));
  check('　 這種回應不能被 CDN 記住（no-store）；也不外送邀請函全文與編輯碼', r.headers['cache-control'] === 'no-store' && !JSON.stringify(r.body).includes('誠摯邀請蒞臨採訪') && !JSON.stringify(r.body).includes('"cc"'));
  r = await getPublic({});
  check('　 試問完，一般請求照舊沒有照片，也沒被 no-store 影響快取設定', r.body.event.images === '' && r.headers['cache-control'] !== 'no-store');
}

// ═══ 四、畫面 ═════════════════════════════════════════════════════════════════
console.log('\n── 四、畫面 ──');
{
  const edit = read('public/edit.html');
  const admin = read('public/index.html');
  const ev = read('public/event.html');
  check('編輯頁：邀請函那一張卡裡有「試問：記者會當天的答案」，連到測試前台（帶編輯碼）', edit.includes('id="sim-link"') && edit.includes('試問：記者會當天的答案') && edit.includes('&sim=day&code='));
  check('　 只在「活動還沒到、有邀請函」時顯示；其他情況藏起來', /simRow\.hidden = !\(date && left > 0 && v\('input-invite-letter'\)\)/.test(edit));
  check('　 說明寫得出：測試用、只有你看得到、不算統計、要先儲存', ['測試用的記者前台', '只有你看得到', '不會算進統計', '先按「儲存內容」'].every((t) => edit.includes(t)));
  check('後台：同一顆按鈕，走 ensure_edit_code 取編輯碼再開測試前台', admin.includes('id="sim-btn"') && admin.includes('openSimDay(') && admin.includes('&sim=day&code='));
  check('　 後台沒存過的新活動（沒有 id）不顯示', /v\('edit-event-id'\)\)/.test(admin));
  check('記者前台：sim=day 只是把參數轉給後端，不自己決定內容', ev.includes("params.get('sim') === 'day'") && ev.includes('sim_day: true, edit_code: SIM_CODE') && ev.includes('&sim_day=1&code='));
  check('　 提示條寫明「記者看不到、不算統計」，媒體欄藏起來、不跳彈窗', ev.includes('id="sim-banner"') && ev.includes('這是測試，記者看不到，問答也不會算進統計') && /if \(SIM\) \{[\s\S]*?media-banner'\)\.style\.display = 'none'[\s\S]*?startConversation\(\)[\s\S]*?\} else \{[\s\S]*?showMediaModal\(event\)/.test(ev));
  check('　 試問的對話不存進瀏覽器、也不會接上記者那一份', /function saveChat\(\) \{\s*if \(!eventId \|\| SIM\) return;/.test(ev) && /function loadChat\(\) \{\s*if \(SIM\) return \[\];/.test(ev));
}

// ═══ 五、後台活動卡片的「更多」選單（批次 176）═══════════════════════════════
console.log('\n── 五、後台活動卡片「更多」選單 ──');
{
  resetBook(row({ id: 'a1' }), row({ id: 'a2', invite: '' }));
  const r = fakeRes();
  await events({ method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' }, socket: {} }, r);
  const byId = Object.fromEntries(r.body.events.map((e) => [e.id, e]));
  check('★ list_admin 只給「有沒有邀請函」的旗標，不外送邀請函全文', byId.a1.has_invite === true && byId.a2.has_invite === false && !JSON.stringify(r.body).includes('誠摯邀請蒞臨採訪'));
  const admin = read('public/index.html');
  check('★ 更多選單：進行中＋有邀請函＋不是企業場＋活動還沒到 才列「試問：記者會當天的答案」',
    /if \(ev\.status === 'active' && ev\.has_invite && !isBusinessCard\(ev\) && eventDateIso\(ev\) > todayTaipeiIso\(\)\) add\('microphone-2', '試問：記者會當天的答案', \(\) => openSimDay\(id\)\)/.test(admin));
  check('　 編輯視窗與選單共用同一支 openSimDay(eventId, btn)', /async function openSimDay\(eventId, btn\)/.test(admin) && admin.includes("openSimDay(document.getElementById('edit-event-id').value, this)"));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 175 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
