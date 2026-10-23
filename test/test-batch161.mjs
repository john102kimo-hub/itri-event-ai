// 批次 161：同仁明明登入了，傳「新增活動：原鄉成果發表會」卻拿到記者那邊的回答（「我這個帳號只能查詢」）。
//   一、line_staff 讀取失敗不能讓已登入的人變成記者（沿用上一份名單、幾秒後重試，不是把 [] 快取 60 秒）
//   二、登入時 line_staff 寫不進去，不能回「已啟用」也不能換選單
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_COLLEAGUE_PASSCODE = 'Jerry';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
async function dm(uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res);
  return sent.slice();
}
const textOf = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
const kinds = (out) => out.map((o) => o.kind);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const colleagueRow = (uid) => [uid, '小華', '2026-10-13', '', '', 'colleague'];
const staffRow = (uid) => [uid, '小美', '2026-08-27', '', ''];
const realLog = console.error; // 假的讀取失敗會被記成 console.error，測試輸出不需要它
const quiet = (fn) => async (...a) => { console.error = () => {}; try { return await fn(...a); } finally { console.error = realLog; } };

// ═══ 一、讀取失敗不能把已登入的人變成記者 ═══════════════════════════════════
console.log('── 一、line_staff 讀取失敗：沿用上一份名單 ──');
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
{
  // 讓 60 秒快取過期：用假時鐘把 Date.now 往後撥，再讓讀取失敗
  const realNow = Date.now;
  let out = await dm('U_c', '新增活動');
  check('基準：登入的同仁走同仁模式', /請告訴我新活動的名稱/.test(textOf(out)), textOf(out));
  Date.now = () => realNow() + 61 * 1000;
  state.staffSheetFail = 'read';
  try {
    out = await quiet(dm)('U_c', '新增活動：原鄉成果發表會');
  } finally { Date.now = realNow; }
  const t = textOf(out);
  check('★ 快取過期、這一刻剛好讀不到 line_staff → 仍然是同仁模式（沿用上一份名單），不是記者問答',
    !kinds(out).includes('answer') && !kinds(out).includes('fallback') && !/只能查詢|沒辦法新增/.test(t) && /新活動|已建立|名稱/.test(t), JSON.stringify(out.map((o) => [o.kind, (o.text || '').slice(0, 60)])));

  // 失敗之後只隔幾秒就再試，不是把「沒有名單」記 60 秒
  state.staffSheetFail = null;
  Date.now = () => realNow() + 61 * 1000 + 6 * 1000;
  try { out = await dm('U_c', '同仁選單'); } finally { Date.now = realNow; }
  check('　 讀取恢復後幾秒內就回到正常（不用等 60 秒）', /要做什麼呢/.test(textOf(out)), textOf(out));
}

reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  const realNow = Date.now;
  let out = await dm('U_s', '新增活動');
  check('基準：職員打「新增活動」→ 問名稱', /新活動|名稱/.test(textOf(out)), textOf(out));
  Date.now = () => realNow() + 61 * 1000;
  state.staffSheetFail = 'read';
  try { out = await quiet(dm)('U_s', '新增活動'); } finally { Date.now = realNow; }
  check('★ 職員也一樣：讀取失敗不會被降成記者（還是在問新活動名稱）', /新活動|名稱/.test(textOf(out)) && !kinds(out).includes('answer') && !kinds(out).includes('fallback'), JSON.stringify(out.map((o) => [o.kind, (o.text || '').slice(0, 60)])));
  state.staffSheetFail = null;
}

reset(); await fresh();
{
  // 沒有上一份名單（冷啟動就讀不到）：照舊當作沒有身分，但不會整支掛掉
  state.staffSheetFail = 'read';
  const out = await quiet(dm)('U_new', '哈囉');
  check('　 冷啟動就讀不到：照記者處理、不丟例外', out.length > 0, JSON.stringify(out));
  state.staffSheetFail = null;
}

// ═══ 二、登入寫不進去：老實說，不假裝成功 ═════════════════════════════════════
console.log('\n── 二、登入時 line_staff 寫入失敗 ──');
for (const [who, pass_] of [['同仁', 'Jerry'], ['職員', 'openseasame']]) {
  reset(); await fresh();
  state.richMenus.push({ richMenuId: 'rm_col', name: '同仁主選單' }, { richMenuId: 'rm_staff', name: '職員主選單' });
  state.staffSheetFail = 'write';
  const out = await quiet(dm)('U_x', pass_);
  const t = textOf(out);
  check(`★ ${who}密語對、但名單寫不進去 → 回「登入沒有成功」，不說已啟用`, /登入沒有成功/.test(t) && !/模式已啟用/.test(t), t);
  check(`　 ${who}：不換選單（名單裡沒有他，換了只會讓他以為成功）`, !state.linkedMenus.has('U_x'), JSON.stringify([...state.linkedMenus]));
  check(`　 ${who}：訊息裡有下一步（過一分鐘再傳一次、一直這樣找管理員）`, /再傳一次密語/.test(t) && /管理員/.test(t), t);
  state.staffSheetFail = null;
  const again = await dm('U_x', pass_);
  check(`　 ${who}：之後試算表恢復，再傳一次密語就登入成功`, /模式已啟用/.test(textOf(again)) && state.staff.length === 1, textOf(again));
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
