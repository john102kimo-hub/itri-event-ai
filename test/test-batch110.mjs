// 批次 110：資安衛生。
//
// 通盤檢討時實測到的事，每一條都對應下面的一段：
//   ① 【fail-open】ADMIN_PASSWORD 沒設定時，不帶任何密碼就通過管理員驗證（`undefined !== undefined` 是 false）。
//   ② 密碼比對不是固定時間比對；登入失敗沒有限流。
//   ③ 管理員密碼可以放在網址 ?password=（會進存取紀錄）；lib/staff.js 的內部呼叫就這樣做。
//   ④ vercel.json 沒有任何安全標頭；CDN 資源沒有 SRI；沒有 .gitignore、沒有 CI。
// 跑的是真的 api/*.js 與 lib/*.js，只有 Google Sheets（fakes-sheets82）與外部呼叫是假的。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 's';
process.env.EVENTS_TABLE_TTL_MS = '0';   // 這支要直接改假試算表，不吃活動表快取（快取本身見 test-batch109）
process.env.ADMIN_PASSWORD = 'pw';

const { book, calls, reset } = await import('./fakes-sheets82.mjs');
const A = await import('../lib/auth.js');
const { clientIp, createLimiter } = await import('../lib/rate-limit.js');
const eventsApi = (await import('../api/events.js')).default;
const analyticsApi = (await import('../api/analytics.js')).default;
const exportApi = (await import('../api/export.js')).default;
const mediaApi = (await import('../api/media.js')).default;
const exposureApi = (await import('../api/exposure.js')).default;
const trainingApi = (await import('../api/training.js')).default;
const geoApi = (await import('../api/geo.js')).default;
const staff = await import('../lib/staff.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + d : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const reads = () => calls.filter((c) => c[0] === 'read').length;
const mkRes = () => {
  const r = { statusCode: 200, headers: {} };
  r.setHeader = (k, v) => (r.headers[k] = v, r);
  r.status = (c) => (r.statusCode = c, r);
  r.json = (o) => (r.body = o, r);
  r.send = (b) => (r.body = b, r);
  r.write = () => r; r.end = () => r;
  return r;
};
let ipSeq = 0;
const call = async (handler, req) => {
  const { ip, headers = {}, ...rest } = req;
  const r = mkRes();
  await handler({ query: {}, socket: {}, ...rest, headers: { 'x-forwarded-for': ip || `10.1.0.${++ipSeq % 250}`, ...headers } }, r);
  return r;
};
const iso = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const fixture = () => {
  reset();
  A.resetAuthLimiter();
  book.events = [['id'], ['e1', '活動e1', '#0F9E7A', '【新聞稿】內容', 'active', iso(5), '', '', '', '工研院', 'CODE1', '14:00', '台北', '', '王小姐 02-1234-5678']];
  book.qa_log = [['ts'], ['t', 'e1', '活動e1', '媒體A', '請問何時量產？', 'a', '', 'web']];
  book.training_log = [['ts']];
};

/* ───────── 一、lib/auth.js 本身 ───────── */
console.log('\n── 一、驗證小工具 ──');
check('safeEqual：相同字串通過', A.safeEqual('abc', 'abc') === true);
check('safeEqual：不同字串、長度不同都不通過（也不丟例外）', A.safeEqual('abc', 'abd') === false && A.safeEqual('abc', 'abcd') === false && A.safeEqual('a', 'a'.repeat(5000)) === false);
check('safeEqual：空字串、undefined、null、數字、陣列一律不通過（兩邊都是 undefined 也不通過）',
  [['', ''], [undefined, undefined], [null, null], [1, 1], [['a'], ['a']], ['a', undefined], [undefined, 'a']].every(([a, b]) => A.safeEqual(a, b) === false));
check('isAdminPassword：有設定且相符才通過', A.isAdminPassword('pw') === true && A.isAdminPassword('PW') === false && A.isAdminPassword('') === false && A.isAdminPassword(undefined) === false);
const keep = process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_PASSWORD;
check('★ ADMIN_PASSWORD 沒設定：任何輸入（含 undefined、空字串）都不通過（fail-closed）', [undefined, '', 'pw', 'undefined'].every((x) => A.isAdminPassword(x) === false));
process.env.ADMIN_PASSWORD = keep;
check('codeMatches：編輯碼相符才通過；活動沒有編輯碼（空）一律不通過；數字也能比', A.codeMatches('abc', 'abc') && !A.codeMatches('abc', '') && !A.codeMatches('', '') && !A.codeMatches('abc', undefined) && A.codeMatches(1234, '1234'));
check('passwordFrom：header 優先，其次 POST 內文，**不讀網址**',
  A.passwordFrom({ headers: { 'x-admin-password': 'h' }, body: { password: 'b' }, query: { password: 'q' } }) === 'h'
  && A.passwordFrom({ headers: {}, body: { password: 'b' }, query: { password: 'q' } }) === 'b'
  && A.passwordFrom({ headers: {}, query: { password: 'q' } }) === ''
  && A.passwordFrom({}) === '');
{
  const lim = createLimiter({ windowMs: 1000, max: 3 });
  const t = 1_000_000;
  const r = [lim.hit('k', t), lim.hit('k', t + 1), lim.hit('k', t + 2), lim.hit('k', t + 3)];
  check('限流：超過 max 才回 true、視窗過了就歸零、不同 key 互不影響',
    r.join() === 'false,false,false,true' && lim.hit('k', t + 5000) === false && lim.hit('other', t) === false);
  const l2 = createLimiter({ windowMs: 1000, max: 2 });
  l2.hit('x', t); l2.hit('x', t);
  check('blocked()：只看不記，滿 max 次就擋', l2.blocked('x', t) === true && l2.blocked('x', t + 2000) === false && l2.blocked('y', t) === false);
}
check('clientIp：取 x-forwarded-for 的第一個、沒有就退回 socket、再沒有就 unknown',
  clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }) === '1.2.3.4' && clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }) === '9.9.9.9' && clientIp({}) === 'unknown');

/* ───────── 二、fail-open：ADMIN_PASSWORD 沒設定 ───────── */
console.log('\n── 二、ADMIN_PASSWORD 沒設定：所有管理員入口一律拒絕 ──');
fixture();
delete process.env.ADMIN_PASSWORD;
const cases = [
  ['events GET list_admin（含編輯碼的後台列表）', eventsApi, { method: 'GET', query: { action: 'list_admin' } }],
  ['events GET get（單場含知識庫與編輯碼）', eventsApi, { method: 'GET', query: { action: 'get', id: 'e1' } }],
  ['events GET contacts_directory', eventsApi, { method: 'GET', query: { action: 'contacts_directory' } }],
  ['events POST archive（封存活動）', eventsApi, { method: 'POST', body: { action: 'archive', id: 'e1' } }],
  ['events POST create（新增活動）', eventsApi, { method: 'POST', body: { action: 'create', name: '駭客活動' } }],
  ['events POST update', eventsApi, { method: 'POST', body: { action: 'update', id: 'e1', name: '被改掉' } }],
  ['events POST contacts_directory_save', eventsApi, { method: 'POST', body: { action: 'contacts_directory_save', content: 'x' } }],
  ['events POST reg_admin_save_campaign（媒體報名後台）', eventsApi, { method: 'POST', body: { action: 'reg_admin_save_campaign', id: 'x' } }],
  ['events GET reg_admin_list（媒體報名後台）', eventsApi, { method: 'GET', query: { action: 'reg_admin_list' } }],
  ['analytics GET（全部問答紀錄）', analyticsApi, { method: 'GET' }],
  ['analytics POST delete（刪問答）', analyticsApi, { method: 'POST', body: { action: 'delete', row_num: 2 } }],
  ['export GET（問答匯出 CSV）', exportApi, { method: 'GET', query: { event_id: 'e1' } }],
  ['media GET export（記者名單匯出）', mediaApi, { method: 'GET', query: { action: 'export' } }],
  ['media POST seed（整批覆寫記者名單）', mediaApi, { method: 'POST', body: { action: 'seed', csv: 'a\nb' } }],
  ['media POST settings_save（重發共用連結）', mediaApi, { method: 'POST', body: { action: 'settings_save', regenerate: true } }],
  ['exposure GET analysis（露出 × 提問交叉分析）', exposureApi, { method: 'GET', query: { action: 'analysis', id: 'e1' } }],
  ['training GET summary（訓練成績彙整）', trainingApi, { method: 'GET', query: { action: 'summary' } }],
  ['training POST 彙整模式', trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'all', messages: [{ role: 'user', content: 'hi' }] } }],
  ['geo GET status', geoApi, { method: 'GET', query: { action: 'status' } }],
  ['geo POST seed', geoApi, { method: 'POST', body: { action: 'seed' } }],
];
for (const [label, h, req] of cases) {
  A.resetAuthLimiter();
  const r = await call(h, { ...req, ip: '2.2.2.2' });
  check(`★ ${label} → 401（以前直接放行）`, r.statusCode === 401, `回了 ${r.statusCode} ${JSON.stringify(r.body || '').slice(0, 80)}`);
}
check('　 而且什麼都沒被改到（e1 還是進行中、沒有多出活動、名稱沒被改）',
  book.events[1][4] === 'active' && book.events[1][1] === '活動e1' && book.events.length === 2);
process.env.ADMIN_PASSWORD = 'pw';

/* ───────── 三、密碼只收 header／POST 內文，不收網址 ───────── */
console.log('\n── 三、密碼從哪裡來 ──');
fixture();
let r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' }, ip: '3.3.3.3' });
check('header 帶對的密碼 → 200', r.statusCode === 200 && Array.isArray(r.body.events));
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin', password: 'pw' }, ip: '3.3.3.3' });
check('★ 網址 ?password=pw → 401（不再接受，不會留在存取紀錄）', r.statusCode === 401);
r = await call(analyticsApi, { method: 'GET', query: { password: 'pw' }, ip: '3.3.3.3' });
check('★ analytics 也一樣不收網址密碼', r.statusCode === 401);
r = await call(eventsApi, { method: 'POST', body: { action: 'create', name: '新活動', password: 'pw' }, ip: '3.3.3.3' });
check('POST 內文帶密碼 → 仍然可以（內文不進存取紀錄）', r.statusCode === 200 && r.body.success === true);
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'PW' }, ip: '3.3.3.3' });
check('錯的密碼 → 401', r.statusCode === 401);
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin', password: ['a', 'pw'] }, ip: '3.3.3.3' });
check('網址帶重複參數（變成陣列）→ 401，不丟例外', r.statusCode === 401);

/* ───────── 四、猜密碼與猜編輯碼的失敗限流 ───────── */
console.log('\n── 四、失敗限流 ──');
fixture();
let last;
for (let i = 0; i < 30; i++) last = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'wrong' + i }, ip: '4.4.4.4' });
check('前 30 次錯的都是 401', last.statusCode === 401);
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'wrong-31' }, ip: '4.4.4.4' });
check('★ 第 31 次起 429（連比對都不做）', r.statusCode === 429 && /10 分鐘/.test(r.body.error || ''));
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' }, ip: '4.4.4.4' });
check('　 被擋的來源，連正確的密碼也先擋（猜中了也進不來）', r.statusCode === 429);
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' }, ip: '4.4.4.5' });
check('　 別的來源不受影響', r.statusCode === 200);
r = await call(analyticsApi, { method: 'GET', headers: { 'x-admin-password': 'pw' }, ip: '4.4.4.4' });
check('　 同一個來源打別支管理員 API 也擋（共用同一份失敗計數）', r.statusCode === 429);
A.resetAuthLimiter();
for (let i = 0; i < 29; i++) await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'x' + i }, ip: '4.4.4.6' });
r = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' }, ip: '4.4.4.6' });
check('　 失敗 29 次之後輸入正確密碼：照常進得去（辦公室共用 IP 打錯幾次不會被鎖）', r.statusCode === 200);

fixture();
for (let i = 0; i < 30; i++) await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: i % 2 ? 'e1' : 'nope-' + i, code: 'guess' + i }, ip: '5.5.5.5' });
const before = reads();
r = await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: 'e1', code: 'CODE1' }, ip: '5.5.5.5' });
check('★ 猜編輯碼（含亂填 id）失敗 30 次：第 31 次連正確的碼也擋，而且不讀 Sheets', r.statusCode === 429 && reads() === before, `status ${r.statusCode}, 讀了 ${reads() - before} 次`);
r = await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: 'e1', code: 'CODE1' }, ip: '5.5.5.6' });
check('　 別的來源用正確的編輯碼：200', r.statusCode === 200 && r.body.id === 'e1');
fixture();
for (let i = 0; i < 30; i++) await call(eventsApi, { method: 'POST', body: { action: 'update_edit', id: 'e1', code: 'bad' + i, name: 'x' }, ip: '5.5.5.7' });
r = await call(eventsApi, { method: 'POST', body: { action: 'update_edit', id: 'e1', code: 'CODE1', name: '改名' }, ip: '5.5.5.7' });
check('update_edit 猜編輯碼也一樣有限流', r.statusCode === 429 && book.events[1][1] === '活動e1');
r = await call(eventsApi, { method: 'POST', body: { action: 'update_edit', id: 'e1', code: 'CODE1', name: '改名' }, ip: '5.5.5.8' });
check('　 正確的編輯碼照常可以改（回歸）', r.statusCode === 200 && book.events[1][1] === '改名');

fixture();
for (let i = 0; i < 30; i++) await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'e1', code: 'bad' + i, messages: [{ role: 'user', content: 'hi' }] }, ip: '5.6.0.1' });
r = await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'e1', code: 'CODE1', messages: [{ role: 'user', content: 'hi' }] }, ip: '5.6.0.1' });
check('媒體訓練猜編輯碼也有限流', r.statusCode === 429);

/* ───────── 四之二、GEO 排程（cron）的驗證 ───────── */
console.log('\n── 四之二、GEO 排程驗證 ──');
{
  const keepSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  fixture();
  // 驗證通過之後排程會真的去打外部 AI 引擎——這支測試只想看「驗證有沒有放行」，一律擋掉外部呼叫並記下來
  const externalCalls = [];
  const realFetch0 = globalThis.fetch;
  globalThis.fetch = async (url) => { externalCalls.push(String(url)); throw new Error('測試中不准打外部網路'); };
  const cron = (q, headers = {}, ip) => call(geoApi, { method: 'GET', query: { action: 'cron', ...q }, headers, ip: ip || '8.8.0.' + (++ipSeq % 200) });
  let c = await cron({ calibrate: '1', password: 'pw' });
  check('★ 沒設 CRON_SECRET：calibrate（全量重掃）帶網址 ?password=pw → 401（以前這樣就過）', c.statusCode === 401);
  c = await cron({ calibrate: '1' }, { 'x-admin-password': 'pw' });
  check('　 改帶 header 的管理員密碼 → 通過驗證（之後才會被「金鑰沒設」之類的就緒檢查擋，不是 401）', c.statusCode !== 401 && c.statusCode !== 429, String(c.statusCode));
  c = await cron({ calibrate: '1' }, { 'user-agent': 'vercel-cron/1.0' });
  check('　 只靠偽造 User-Agent 不能跑 calibrate（沿用原本的規則）', c.statusCode === 401);
  c = await cron({}, { 'user-agent': 'vercel-cron/1.0' });
  check('　 Vercel 排程自己的一般批次（UA）照常放行', c.statusCode !== 401);
  c = await cron({});
  check('　 什麼都沒帶 → 401', c.statusCode === 401);

  process.env.CRON_SECRET = 'cron-secret-xyz';
  c = await cron({}, { authorization: 'Bearer cron-secret-xyz' });
  check('設了 CRON_SECRET：Bearer 正確 → 通過驗證', c.statusCode !== 401);
  c = await cron({ calibrate: '1' }, { authorization: 'Bearer wrong' });
  check('　 Bearer 錯 → 401', c.statusCode === 401);
  c = await cron({ calibrate: '1', secret: 'cron-secret-xyz' });
  check('　 ?secret= 仍可手動觸發（既有文件寫的用法，維持相容）', c.statusCode !== 401);
  c = await cron({ calibrate: '1', password: 'pw' });
  check('　 設了 CRON_SECRET 之後，管理員密碼不能代替它', c.statusCode === 401);
  globalThis.fetch = realFetch0;
  console.log('   （驗證通過之後排程嘗試的外部呼叫：' + externalCalls.length + ' 次，全部被測試擋下）');
  if (keepSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = keepSecret;
  A.resetAuthLimiter();
}

/* ───────── 五、lib/staff.js 不再把密碼放網址 ───────── */
console.log('\n── 五、內部呼叫 ──');
{
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { seen.push({ url: String(url), headers: opts.headers || {} }); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    await staff.getGeoStatusSummary();
    await staff.getGeoTrendSeries(7);
  } finally { globalThis.fetch = realFetch; }
  check('★ GEO 狀態／趨勢的內部呼叫：網址裡沒有密碼', seen.length === 2 && seen.every((s) => !/password/i.test(s.url) && !s.url.includes('pw')), seen.map((s) => s.url).join(' | '));
  check('　 密碼改放 X-Admin-Password header', seen.every((s) => s.headers['X-Admin-Password'] === 'pw'));
  check('　 網址仍帶對的 action 與 days', /action=status/.test(seen[0].url) && /action=series/.test(seen[1].url) && /days=7/.test(seen[1].url));
}

/* ───────── 六、vercel.json 安全標頭 ───────── */
console.log('\n── 六、安全標頭 ──');
const vercel = JSON.parse(read('vercel.json'));
const rules = vercel.headers || [];
const hdrsFor = (p) => {
  const out = {};
  for (const rule of rules) if (new RegExp('^' + rule.source + '$').test(p)) for (const h of rule.headers) out[h.key] = h.value;
  return out;
};
const ADMIN_PATHS = ['/admin', '/geo', '/report', '/registrations', '/edit', '/training',
  '/index.html', '/geo.html', '/report.html', '/registrations.html', '/edit.html', '/training.html', '/media.html'];
check('所有路徑都有 nosniff 與 Referrer-Policy', ['/', '/event', '/register', '/api/chat', ...ADMIN_PATHS].every((p) => {
  const h = hdrsFor(p); return h['X-Content-Type-Options'] === 'nosniff' && /origin/.test(h['Referrer-Policy'] || '');
}));
check('★ 後台與同仁頁面不能被別的網站用 iframe 嵌進去（X-Frame-Options＋frame-ancestors）', ADMIN_PATHS.every((p) => {
  const h = hdrsFor(p); return h['X-Frame-Options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(h['Content-Security-Policy'] || '');
}), ADMIN_PATHS.filter((p) => !hdrsFor(p)['X-Frame-Options']).join(', '));
const PUBLIC_PAGES = ['event.html', 'register.html', 'guide.html'];
const adminPages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html') && !PUBLIC_PAGES.includes(f));
check('★ public/ 底下每一頁後台頁面（除了記者公開的三頁）都在保護清單裡——以後新增後台頁沒補規則會紅燈',
  adminPages.every((f) => hdrsFor('/' + f)['X-Frame-Options'] === 'SAMEORIGIN'), adminPages.filter((f) => !hdrsFor('/' + f)['X-Frame-Options']).join(', '));
check('記者公開頁（/event、/register）維持可被嵌入（沒有擋 iframe）——這是刻意的，要改請連同使用情境一起想', !hdrsFor('/event')['X-Frame-Options'] && !hdrsFor('/register')['X-Frame-Options']);
// 批次 119 加了 /inquiry、/b2b 兩條 rewrite 與業發處的期限提醒排程（functions 不變：搭在 api/events.js 上）
check('原有的 rewrites、functions、crons 沒被動到', vercel.rewrites.length === 12 && Object.keys(vercel.functions).length === 6 && vercel.crons.length === 6);

/* ───────── 七、CDN 資源的 SRI、.gitignore、CI ───────── */
console.log('\n── 七、供應鏈與工程衛生 ──');
{
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const tag = /<(link|script)\b[^>]*cdn\.jsdelivr\.net[^>]*>/gi;
  const bad = [];
  const hashes = new Set();
  for (const f of pages) {
    for (const m of read('public/' + f).matchAll(tag)) {
      const t = m[0];
      const sri = /integrity="(sha384-[A-Za-z0-9+/]{64})"/.exec(t);
      if (!sri || !/crossorigin="anonymous"/.test(t)) bad.push(f);
      else hashes.add(sri[1]);
    }
  }
  check('★ 頁面上直接引用 jsDelivr 的 <link>／<script> 全部帶 SRI（sha384）與 crossorigin', bad.length === 0, bad.join(', '));
  check('　 六個頁面的圖示 CSS 用同一組雜湊（版本鎖在 3.3.0）', hashes.size === 1 && pages.filter((f) => /icons-webfont@3\.3\.0/.test(read('public/' + f))).length === 6);
  const edit = read('public/edit.html');
  check('★ edit.html 動態載入 mammoth 也帶 SRI（integrity＋crossOrigin）', /MAMMOTH_SRI = 'sha384-[A-Za-z0-9+/]{64}'/.test(edit) && /sc\.integrity = MAMMOTH_SRI/.test(edit) && /sc\.crossOrigin = 'anonymous'/.test(edit));
  check('　 mammoth 版本仍是鎖死的 1.8.0（SRI 雜湊對的是這一版）', /mammoth@1\.8\.0\/mammoth\.browser\.min\.js/.test(edit));
}
{
  const gi = read('.gitignore');
  check('.gitignore 擋 node_modules、.env、.vercel', /^node_modules\/$/m.test(gi) && /^\.env$/m.test(gi) && /^\.vercel\/$/m.test(gi));
  const wf = read('.github/workflows/test.yml');
  check('CI：PR 與 main 推送都會跑；跑 npm test 與位移 90 天的 npm test；權限只有 contents: read',
    /pull_request:/.test(wf) && /branches: \[main\]/.test(wf) && /run: npm test/.test(wf) && /SHIFT_DAYS=90 npm test/.test(wf) && /contents: read/.test(wf));
}

/* ───────── 八、接線：程式裡不再有舊寫法 ───────── */
console.log('\n── 八、接線 ──');
{
  const files = [...fs.readdirSync(path.join(ROOT, 'api')).map((f) => 'api/' + f), ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => 'lib/' + f)].filter((f) => f.endsWith('.js'));
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hit = (re) => files.filter((f) => re.test(strip(read(f)))).join(', ');
  check('★ 程式裡不再讀網址的密碼（query.password）', hit(/query\??\.password/) === '', hit(/query\??\.password/));
  check('★ 程式裡不再用 !== / === 直接比 ADMIN_PASSWORD 或 adminPassword', hit(/(!==|===)\s*(process\.env\.ADMIN_PASSWORD|adminPassword)\b|\b(adminPassword|admin)\s*(!==|===)\s*password/) === '', hit(/(!==|===)\s*(process\.env\.ADMIN_PASSWORD|adminPassword)\b/));
  check('　 編輯碼不再用 String(code) !== String(…) 直接比', hit(/String\(code\)\s*!==\s*String\(/) === '', hit(/String\(code\)\s*!==\s*String\(/));
  check('　 網址裡不再拼 password=', hit(/[?&]password=\$\{/) === '', hit(/[?&]password=\$\{/));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 110 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
