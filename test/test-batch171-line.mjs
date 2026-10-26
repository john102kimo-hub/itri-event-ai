// 批次 171（LINE 那一半）：職員／同仁在 LINE 按「🚀 發布」——活動前、沒填媒體邀請函，確認訊息先把後果講清楚，
// 附編輯頁連結讓他去填。規則跟後台、同仁編輯頁同一支（lib/event-status.js preEventWithoutInvite／inviteLetterWarning）。
// LINE 本來就有「確認發布」那一步，所以不多加一個視窗，只把話講清楚。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
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
const buttons = (out) => {
  const last = out.filter((s) => s.kind === 'text').at(-1);
  return (last?.quickReply || []).map((c) => (typeof c === 'object' ? c.text ?? c.label : c));
};

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

const KB = '【新聞稿】先進製程成果：良率提升與量產時程說明。';
const ev = (id, name, date, invite = '', type = '') =>
  [id, name, '#0F9E7A', KB, 'draft', date, '', '', '', '工研院', 'code_' + id, '', '南港展覽館', type, '王小明 0912-345-678', '', invite, ''];

for (const [who, uid, pass_] of [['職員', 'U_s', 'openseasame'], ['同仁', 'U_c', 'Jerry']]) {
  console.log(`\n── ${who}模式 ──`);
  reset();
  state.events.push(
    ev('p1', '先進製程成果發表', isoOffset(3)),
    ev('p2', '有邀請函的發表會', isoOffset(3), '親愛的媒體朋友：誠摯邀請蒞臨採訪。'),
    ev('p3', '今天辦的發表會', isoOffset(0)),
  );
  await fresh();
  await dm(uid, pass_);

  let out = await dm(uid, '發布：先進製程成果發表');
  const t = textOf(out);
  check(`★ ${who}按發布：活動前、沒邀請函 → 確認訊息講清楚後果（記者會拿到整份知識庫、新聞稿全文、照片）`,
    /要發布《先進製程成果發表》嗎/.test(t) && /⚠️ 這場 \d+\/\d+（.）才辦（還有 3 天），但還沒填「媒體邀請函」/.test(t) && /新聞稿全文、照片/.test(t), t);
  check('　 附編輯頁連結，告訴他先按「先不發布」去填', /先不發布/.test(t) && /\/edit\?id=p1&code=code_p1/.test(t), t);
  check('　 一樣只有確認／取消兩顆（不多加步驟）', JSON.stringify(buttons(out)) === JSON.stringify(['🚀 確認發布', '✖ 先不發布']), JSON.stringify(buttons(out)));
  out = await dm(uid, '🚀 確認發布');
  check(`★ 看過後果、按確認 → 照樣發布（不是每場都需要邀請函）`, state.events.find((e) => e[0] === 'p1')[4] === 'active' && /已發布 ✅/.test(textOf(out)), textOf(out));

  out = await dm(uid, '發布：有邀請函的發表會');
  check('　 有填邀請函 → 確認訊息不出現警告', /要發布《有邀請函的發表會》嗎/.test(textOf(out)) && !/⚠️/.test(textOf(out)) && !/媒體邀請函/.test(textOf(out)), textOf(out));
  await dm(uid, '✖ 先不發布');
  out = await dm(uid, '發布：今天辦的發表會');
  check('　 活動當天發布 → 不出現警告（當天起本來就用知識庫）', /要發布《今天辦的發表會》嗎/.test(textOf(out)) && !/⚠️/.test(textOf(out)), textOf(out));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 171（LINE）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
