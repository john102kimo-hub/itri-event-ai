// 批次 173（LINE 那一半）：職員在 LINE 按「發布」——活動前有邀請函、新聞稿還沒貼，照樣可以發布。
// 規則跟後台同一支（lib/event-status.js eventChecklist）；這裡驗 LINE 的活動卡與發布流程真的跟著放行。
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

const ev = (id, name, date, kb, invite) =>
  [id, name, '#0F9E7A', kb, 'draft', date, '', '', '', '工研院', 'code_' + id, '10:00', '南港展覽館', '記者會', '王小明 0912-345-678', '', invite, ''];
const { KB_TEMPLATE } = await import('../lib/kb-template.js');

reset();
state.events.push(
  ev('v1', '儲電新技術發表會', isoOffset(3), KB_TEMPLATE, '親愛的媒體朋友：誠摯邀請蒞臨採訪，10:00 開始。'),
  ev('v2', '沒有邀請函的發表會', isoOffset(3), KB_TEMPLATE, ''),
);
await fresh();
await dm('U_s', 'openseasame');

let out = await dm('U_s', '儲電新技術發表會');
check('★ 活動卡：新聞稿那一格打勾、寫「活動前先用邀請函」，而且出現「🚀 發布」', /新聞稿（活動前先用邀請函）/.test(JSON.stringify(out)) && JSON.stringify(out).includes('發布：儲電新技術發表會'), JSON.stringify(out).slice(0, 600));
out = await dm('U_s', '發布：儲電新技術發表會');
check('★ 按發布 → 進到確認（不再說「還不能發布，缺新聞稿」），也不跳邀請函警告（已經有邀請函）', /要發布《儲電新技術發表會》嗎/.test(textOf(out)) && !/還不能發布/.test(textOf(out)) && !/⚠️/.test(textOf(out)), textOf(out));
out = await dm('U_s', '🚀 確認發布');
check('　 確認 → 發布', state.events.find((e) => e[0] === 'v1')[4] === 'active' && /已發布 ✅/.test(textOf(out)), textOf(out));
out = await dm('U_s', '發布：沒有邀請函的發表會');
check('★ 沒有邀請函、也沒新聞稿 → 照舊「還不能發布，必填還缺：新聞稿」', /還不能發布/.test(textOf(out)) && /新聞稿/.test(textOf(out)) && state.events.find((e) => e[0] === 'v2')[4] === 'draft', textOf(out));

console.log(`\n${fail ? '❌' : '✅'} 批次 173（LINE）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
