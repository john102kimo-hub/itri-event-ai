// 批次 109：公開入口不再放大 Google Sheets 的讀取額度。
//
// 背景（通盤檢討實測）：Sheets 讀取額度是每分鐘 60 次、全站共用。以前
//   ① 活動頁 get_public：每開一次頁讀一次（20 次＝20 次讀取，沒有任何快取標頭）
//   ② 網頁問答 chat：帶不存在的 event_id，每次讀一次（找不到的結果不快取）
//   ③ 媒體訓練 training：沒帶任何密碼，也先讀 events 與整張 qa_log 才驗身分（20 次＝20＋20 次）
// 這支跑真的 api/*.js 與 lib/events-table.js，只有 Google Sheets（fakes-sheets82）與模型是假的，
// 用假試算表的 calls 陣列「數」讀了幾次——測的是結果（讀取次數），不是程式裡有沒有某個字串。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 's';
// 刻意不設 EVENTS_TABLE_TTL_MS：這支要測的就是預設的 30 秒快取

const { book, calls, ctl, reset } = await import('./fakes-sheets82.mjs');
const { readEventRows, invalidateEventsTable, EVENTS_TTL_MS } = await import('../lib/events-table.js');
const eventsApi = (await import('../api/events.js')).default;
const chatApi = (await import('../api/chat.js')).default;
const trainingApi = (await import('../api/training.js')).default;
const pageApi = (await import('../api/event-page.js')).default;

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + d : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const reads = (prefix) => calls.filter((c) => c[0] === 'read' && (!prefix || c[1].startsWith(prefix))).length;
const mkRes = () => {
  const r = { statusCode: 200, headers: {} };
  r.setHeader = (k, v) => (r.headers[k] = v, r);
  r.status = (c) => (r.statusCode = c, r);
  r.json = (o) => (r.body = o, r);
  r.send = (b) => (r.body = b, r);
  r.end = () => r;
  return r;
};
const call = async (handler, req) => { const r = mkRes(); await handler({ headers: {}, query: {}, socket: {}, ...req }, r); return r; };
const iso = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// events 表一列：A id, B name, C color, D kb, E status, F date, G chips, H images, I greeting, J organizer,
// K edit_code, L time, M venue, N type, O press_contact
const eventRow = (id, status, extra = {}) => [id, '活動' + id, '#0F9E7A', '【新聞稿】內容', status, iso(5), '', '', '', '工研院', extra.code ?? 'CODE-' + id,
  '14:00', '台北', '', '王小姐 02-1234-5678'];
const fixture = () => {
  reset();
  invalidateEventsTable();
  book.events = [['id'], eventRow('e1', 'active'), eventRow('e2', 'draft')];
  book.qa_log = [['ts'], ...Array.from({ length: 50 }, (_, i) => ['t', 'e1', '活動e1', '媒體' + (i % 5), '請問問題編號' + i + '是什麼？', 'a', '', 'web'])];
  book.training_log = [['ts']];
};

/* ───────── 一、lib/events-table.js 本身 ───────── */
console.log('\n── 一、共用活動表快取 ──');
const realNow = Date.now;
let T = realNow();
Date.now = () => T;
try {
  fixture();
  let b = reads('events');
  await readEventRows(); await readEventRows(); await readEventRows();
  check('TTL 內連讀三次只讀一次 Sheets', reads('events') - b === 1, `讀了 ${reads('events') - b} 次`);

  T += EVENTS_TTL_MS + 1000;
  b = reads('events');
  await readEventRows();
  check('過了 TTL 重讀一次', reads('events') - b === 1);

  invalidateEventsTable();
  b = reads('events');
  await Promise.all(Array.from({ length: 50 }, () => readEventRows()));
  check('★ 快取剛失效、50 個請求同時進來：只讀一次（不能變成 50 次）', reads('events') - b === 1, `讀了 ${reads('events') - b} 次`);

  b = reads('events');
  await readEventRows({ fresh: true });
  check('fresh:true 繞過快取（給需要最新的人）', reads('events') - b === 1);

  // 寫入後失效
  fixture();
  await readEventRows();
  book.events.push(eventRow('e3', 'active'));
  invalidateEventsTable();
  check('寫入後 invalidate：下一次讀到新的一列', (await readEventRows()).some((r) => r[0] === 'e3'));

  // 讀取進行到一半有人寫入：那一次讀回來的是寫入前的資料，不能放進快取
  fixture();
  const inflight = readEventRows();            // 這一讀拿到的是「舊」表
  book.events.push(eventRow('e9', 'active'));
  invalidateEventsTable();                       // 寫入發生了
  const old = await inflight;
  const next = await readEventRows();
  check('★ 進行中的讀取遇上寫入：舊結果不會被存成快取（下一次讀到新的）',
    !old.some((r) => r[0] === 'e9') && next.some((r) => r[0] === 'e9'));

  // 讀取失敗：有舊資料就先用舊的
  fixture();
  await readEventRows();
  T += EVENTS_TTL_MS + 1000;
  ctl.failReads.add('events');
  b = reads('events');
  let rows = null;
  try { rows = await readEventRows(); } catch { /* 下面的檢查會標紅 */ }
  check('★ Sheets 讀取失敗（429 之類）而手上有舊資料：沿用舊資料，不報錯', rows?.length === 2 && reads('events') - b === 1);
  b = reads('events');
  await readEventRows().catch(() => {}); await readEventRows().catch(() => {});
  check('失敗後 5 秒內不再重試（不讓每個請求都卡在重試）', reads('events') - b === 0, `又讀了 ${reads('events') - b} 次`);
  T += 6000;
  b = reads('events');
  await readEventRows().catch(() => {});
  check('5 秒後再試一次', reads('events') - b === 1);
  T += 11 * 60_000;
  let threw = false;
  try { await readEventRows(); } catch { threw = true; }
  check('舊資料超過 10 分鐘就不用了（寧可明確報錯）', threw);

  fixture();
  ctl.failReads.add('events');
  threw = false;
  try { await readEventRows(); } catch { threw = true; }
  check('一開始就讀不到、沒有舊資料：照樣報錯，不裝沒事', threw);
  ctl.failReads.delete('events');
} finally {
  Date.now = realNow;
}

/* ───────── 二、活動頁 get_public ───────── */
console.log('\n── 二、活動頁 /api/events?action=get_public ──');
fixture();
let b = reads('events');
const rs = await Promise.all(Array.from({ length: 100 }, () => call(eventsApi, { method: 'GET', query: { action: 'get_public', id: 'e1' } })));
check('★ 100 個記者同時開同一場活動頁：Sheets 只讀 1 次（以前 100 次）', reads('events') - b === 1, `讀了 ${reads('events') - b} 次`);
check('　 全部回 200 且內容正確', rs.every((r) => r.statusCode === 200 && r.body.event.id === 'e1' && r.body.event.name === '活動e1'));
check('　 200 的回應帶 CDN 快取標頭（s-maxage）', /s-maxage=15/.test(rs[0].headers['Cache-Control'] || ''), rs[0].headers['Cache-Control']);

b = reads('events');
const bogus = await Promise.all(Array.from({ length: 60 }, (_, i) => call(eventsApi, { method: 'GET', query: { action: 'get_public', id: 'nope-' + i } })));
check('★ 亂填 60 個不存在的 id：Sheets 一次都不讀（以前每個都讀）', reads('events') - b === 0, `讀了 ${reads('events') - b} 次`);
check('　 全部 404 且 no-store（404 不能被 CDN 記住）', bogus.every((r) => r.statusCode === 404 && r.headers['Cache-Control'] === 'no-store'));

const draft = await call(eventsApi, { method: 'GET', query: { action: 'get_public', id: 'e2' } });
check('未發布（draft）仍然 404，且 no-store——發布後要馬上看得到', draft.statusCode === 404 && draft.headers['Cache-Control'] === 'no-store');

const list = await call(eventsApi, { method: 'GET', query: {} });
check('公開列表：不含 draft、帶 CDN 快取標頭、不多讀 Sheets',
  list.statusCode === 200 && list.body.events.map((e) => e.id).join() === 'e1' && /s-maxage/.test(list.headers['Cache-Control'] || '') && reads('events') - b === 0);

// 寫入後立刻生效（同一個 instance）
const gp = () => call(eventsApi, { method: 'GET', query: { action: 'get_public', id: 'e1' } });
check('封存前：e1 對外 200', (await gp()).statusCode === 200);
const arch = await call(eventsApi, { method: 'POST', body: { action: 'archive', id: 'e1', password: 'pw' } });
check('★ 後台按封存之後，同一個 instance 立刻 404（不等 30 秒）', arch.statusCode === 200 && (await gp()).statusCode === 404);
check('　 公開列表也立刻拿掉', (await call(eventsApi, { method: 'GET', query: {} })).body.events.length === 0);

// 後台與同仁編輯仍然讀最新（有密碼／編輯碼才進得來，要看到剛改的）
fixture();
await gp();                                          // 把快取暖起來
book.events.push(eventRow('e5', 'draft'));            // 直接改試算表，模擬別的 instance 剛寫入
const adm = await call(eventsApi, { method: 'GET', query: { action: 'list_admin' }, headers: { 'x-admin-password': 'pw' } });
check('後台 list_admin 不吃快取：馬上看到剛新增的一列', adm.statusCode === 200 && adm.body.events.some((e) => e.id === 'e5'));
book.events[1][10] = 'NEWCODE';
const ed = await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: 'e1', code: 'NEWCODE' } });
check('同仁編輯 get_edit 不吃快取：換過的編輯碼馬上有效', ed.statusCode === 200);

/* ───────── 三、網頁問答 chat：不存在的 event_id ───────── */
console.log('\n── 三、網頁問答 /api/chat ──');
fixture();
b = reads('events');
const chatRes = [];
for (let i = 0; i < 40; i++) {
  chatRes.push(await call(chatApi, {
    method: 'POST', headers: { 'x-forwarded-for': '7.7.7.' + (i % 5) },
    body: { messages: [{ role: 'user', content: 'hi' }], event_id: 'nope-' + i, media_name: '某媒體', client_id: 'c' + i },
  }));
}
check('★ 亂填 40 個不存在的 event_id：整張活動表只讀 1 次（以前每個 1 次）', reads('events') - b <= 1, `讀了 ${reads('events') - b} 次`);
check('　 全部 404（沒進到模型）', chatRes.every((r) => r.statusCode === 404));

/* ───────── 四、媒體訓練 training：先驗身分再讀 qa_log ───────── */
console.log('\n── 四、媒體訓練 /api/training ──');
fixture();
let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { modelCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '您好，我是記者，請問這項技術何時量產？' }], stop_reason: 'end_turn' }) }; };
try {
  b = reads();
  const anon = [];
  for (let i = 0; i < 20; i++) anon.push(await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'probe-' + i, messages: [{ role: 'user', content: 'hi' }] } }));
  check('★ 20 次沒帶任何密碼、亂填 event_id：qa_log 一次都不讀（以前 20 次）', reads('qa_log') === 0, `qa_log 讀了 ${reads('qa_log')} 次`);
  check('　 活動表最多讀 1 次（以前 20 次）', reads('events') <= 1, `events 讀了 ${reads('events')} 次`);
  check('　 全部被擋下（404／401），沒呼叫模型', anon.every((r) => r.statusCode === 404 || r.statusCode === 401) && modelCalls === 0);

  const noCode = await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'e1', code: 'WRONG', messages: [{ role: 'user', content: 'hi' }] } });
  check('真的活動、編輯碼錯：401，qa_log 沒被讀', noCode.statusCode === 401 && reads('qa_log') === 0);

  invalidateEventsTable(); b = reads();
  const allAnon = await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'all', messages: [{ role: 'user', content: 'hi' }] } });
  check('「彙整」模式沒帶管理員密碼：401，活動表與 qa_log 都沒讀', allAnon.statusCode === 401 && reads() - b === 0, `讀了 ${reads() - b} 次`);

  const good = await call(trainingApi, { method: 'POST', body: { mode: 'reporter', event_id: 'e1', code: 'CODE-e1', messages: [{ role: 'user', content: 'hi' }] } });
  check('★ 編輯碼正確：照常運作（讀 qa_log、呼叫模型、回出題）', good.statusCode === 200 && /量產/.test(good.body.reply || '') && reads('qa_log') >= 1 && modelCalls === 1, JSON.stringify(good.body || {}).slice(0, 120));
  const admAll = await call(trainingApi, { method: 'POST', headers: {}, body: { mode: 'reporter', event_id: 'all', password: 'pw', messages: [{ role: 'user', content: 'hi' }] } });
  check('管理員的「彙整」模式照常運作', admAll.statusCode === 200 && modelCalls === 2, JSON.stringify(admAll.body || {}).slice(0, 120));
} finally {
  globalThis.fetch = realFetch;
}

/* ───────── 五、SSR 活動頁、上傳授權 ───────── */
console.log('\n── 五、SSR 活動頁與上傳授權 ──');
fixture();
await call(pageApi, { query: { id: 'e1' } });
b = reads('events');
for (let i = 0; i < 30; i++) await call(pageApi, { query: { id: 'nope-' + i } });
check('★ SSR 活動頁亂填 30 個 id：Sheets 一次都不讀', reads('events') - b === 0, `讀了 ${reads('events') - b} 次`);
const upSrc = read('api/upload.js');
check('上傳授權（帶錯編輯碼的人）也走共用快取', /readEventRows\(\)/.test(upSrc) && !/readRange\(/.test(upSrc));

/* ───────── 六、接線：公開入口不再各自直接讀活動表 ───────── */
console.log('\n── 六、接線 ──');
for (const f of ['api/chat.js', 'api/event-page.js', 'api/upload.js']) {
  check(`${f} 不再直接 readRange('events!…')`, !/readRange\(\s*['"`]events!/.test(read(f)) && /readEventRows/.test(read(f)));
}
check('api/training.js 的活動表走共用快取（qa_log／training_log 仍直接讀）', !/readRange\(\s*['"`]events!/.test(read('api/training.js')) && /readEventRows/.test(read('api/training.js')));
const ev = read('api/events.js');
check('api/events.js：寫入路徑都會讓快取失效（新增／更新／同仁更新／封存／刪除／補編輯碼＋例外）', (ev.match(/invalidateEventsTable\(\)/g) || []).length >= 7);
check('api/events.js：後台與同仁編輯（get／list_admin／get_edit）直接讀，不吃快取', /const direct = action === 'get_edit' \|\| action === 'get' \|\| action === 'list_admin'/.test(ev));

console.log(`\n${fail ? '❌' : '✅'} 批次 109 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
