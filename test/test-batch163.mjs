// 批次 163：管理員自己在同仁模式新增活動，名稱是純數字（「123」）會被待教清單的攔截吃掉
//   api/line.js 的「待教清單提示」原本排在同仁判斷前面；管理員（LINE_ADMIN_USER_ID）本人同時是同仁時，
//   parseQueueCommand('123') 判成「選第 123 題」，回「要先登入職員模式才能用待教清單」，同仁模式整段沒走到。
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
process.env.LINE_ADMIN_USER_ID = 'U_admin';

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

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const colleagueRow = (uid) => [uid, '朱朱', '2026-10-13', '', '', 'colleague'];
const evNames = () => state.events.map((r) => r[1]);

console.log('── 管理員本人在同仁模式 ──');
reset(); state.staff.push(colleagueRow('U_admin')); await fresh();
{
  await dm('U_admin', '新增活動');
  const out = await dm('U_admin', '123');
  check('★ 新增活動 → 回「123」：建出《123》，不是「要先登入職員模式」',
    evNames().includes('123') && /已建立《123》/.test(textOf(out)) && !/要先登入職員模式/.test(textOf(out)), textOf(out));
}
{
  const out = await dm('U_admin', '1');
  check('　 同仁模式裡單打「1」不被待教清單攔走', !/待教清單/.test(textOf(out)), textOf(out));
}

console.log('\n── 管理員沒登入（維持批次 145 的提示）──');
reset(); await fresh();
{
  const out = await dm('U_admin', '待教清單');
  check('★ 管理員還沒登入、打「待教清單」→ 仍提示先登入職員模式', /要先登入職員模式才能用待教清單/.test(textOf(out)), textOf(out));
}
{
  const out = await dm('U_someone', '待教清單');
  check('　 不是管理員的人打同一句 → 沒有提示（不讓記者知道有這組指令）', !/要先登入職員模式/.test(textOf(out)), textOf(out));
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
