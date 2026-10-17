// 批次 145（LINE 那兩點）：
//   一、限流：記者每分鐘 15 則；職員與同仁放寬到 40 則（一路點按鈕的操作），超過時回他們自己的選單
//   二、待教清單：推播對象（LINE_ADMIN_USER_ID）還沒登入職員模式時，提醒先登入；他打「教 N：」不會被當成記者提問
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
process.env.CRON_SECRET = 'cron-secret';
process.env.LINE_ADMIN_USER_ID = 'U_admin';

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } });
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
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res());
  return sent.slice();
}
async function cron() {
  sent.length = 0;
  const r = res();
  await handler({ method: 'GET', query: { action: 'cron_teach' }, headers: { authorization: 'Bearer cron-secret' }, socket: {} }, r);
  return r;
}
const chipTexts = (q) => (q || []).map((c) => (typeof c === 'object' && c ? (c.text ?? c.label) : String(c)));
const staffRow = (uid) => [uid, '小美', '2026-08-27', '', ''];
const colleagueRow = (uid) => [uid, '小華', '2026-10-13', '', '', 'colleague'];

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

// ═══ 一、限流 ═══════════════════════════════════════════════════════════════
console.log('── 一、限流：記者 15、職員與同仁 40 ──');
{
  reset(); await fresh();
  let out;
  for (let i = 1; i <= 16; i++) out = await dm('U_rep', '使用說明');
  check('記者一分鐘第 16 則 → 「提問太頻繁」（跟以前一樣）', /提問太頻繁/.test(out.map((s) => s.text).join()), JSON.stringify(out).slice(0, 200));

  reset(); await fresh();
  state.staff.push(colleagueRow('U_col'));
  const replies = [];
  for (let i = 1; i <= 30; i++) replies.push((await dm('U_col', i % 2 ? '修改活動' : '同仁選單')).map((s) => s.text).join());
  check('★ 同仁一分鐘連點 30 下 → 一則都沒被擋（以前第 16 下就「提問太頻繁」）', replies.every((t) => !/太頻繁|太快/.test(t)), replies.find((t) => /太頻繁|太快/.test(t)));
  for (let i = 31; i <= 41; i++) out = await dm('U_col', '同仁選單');
  check('　 第 41 下才擋，而且回的是同仁的選單（不是記者那一排）', /點得太快/.test(out[0]?.text) && chipTexts(out[0]?.quickReply).at(-1) === '同仁選單', JSON.stringify(out));

  reset(); await fresh();
  state.staff.push(staffRow('U_staff'));
  const staffReplies = [];
  for (let i = 1; i <= 41; i++) staffReplies.push(await dm('U_staff', '職員選單'));
  check('★ 職員也是 40 則才擋，擋的時候帶職員選單', staffReplies.slice(0, 40).every((o) => !/太頻繁|太快/.test(o.map((s) => s.text).join()))
    && /點得太快/.test(staffReplies[40][0]?.text) && chipTexts(staffReplies[40][0]?.quickReply).at(-1) === '職員選單', JSON.stringify(staffReplies[40]));
}

// ═══ 二、待教清單：管理員還沒登入職員模式 ══════════════════════════════════
console.log('\n── 二、待教清單：推播對象還沒登入職員模式 ──');
{
  reset(); await fresh();
  const stamp = (minAgo) => new Date(Date.now() - minAgo * 60000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  state.qaLog = [[stamp(30), 'med', '智慧醫療解決方案記者會', '經濟日報', '發言人是誰', '這部分我沒有資料，建議洽現場新聞聯絡人。', '', 'line', '']];
  await cron();
  const push = sent.find((s) => s.to === 'U_admin');
  check('★ 管理員不在職員模式 → 推播裡提醒「要先打一次職員密語」，而且不附「待教清單」按鈕（按了也只會被當成一般問題）',
    push && /要先在這裡打一次職員密語/.test(push.text) && !chipTexts(push.quickReply).includes('待教清單'), JSON.stringify(push));

  let out = await dm('U_admin', '教 1：發言人是張副院長');
  check('★ 管理員沒登入就回「教 1：⋯」→ 提醒先登入，不會被當成記者提問送去問模型、也不會寫進記憶',
    /要先登入職員模式/.test(out[0]?.text) && !out.some((s) => s.kind === 'answer' || s.kind === 'fallback') && !(state.memories || []).length, JSON.stringify(out));
  out = await dm('U_admin', '待教清單');
  check('　 「待教清單」也一樣提醒先登入', /要先登入職員模式/.test(out[0]?.text));
  out = await dm('U_rep', '教 1：這場延期了');
  check('★ 不是管理員的人打「教 1：⋯」→ 不會看到這段提醒（不讓記者知道有這組指令），照一般訊息處理',
    !out.some((s) => /職員模式|職員密語/.test(s.text || '')) && !(state.memories || []).length, JSON.stringify(out).slice(0, 300));

  await dm('U_admin', 'openseasame');
  out = await dm('U_admin', '教 1：發言人是張副院長');
  check('登入職員模式之後，「教 1：⋯」照常寫進記憶', /學會了/.test(out.map((s) => s.text).join()) && (state.memories || []).some((m) => /張副院長/.test(m[3])), JSON.stringify(out));

  state.qaLog.push([stamp(5), 'med', '智慧醫療解決方案記者會', '中央社', '有沒有現場直播', '這部分我沒有資料，建議洽現場新聞聯絡人。', '', 'line', '']);
  await fresh();
  await cron();
  const push2 = sent.find((s) => s.to === 'U_admin');
  check('　 管理員已經是職員 → 推播不帶那句提醒、附「待教清單」按鈕', push2 && !/要先在這裡打一次職員密語/.test(push2.text) && chipTexts(push2.quickReply).includes('待教清單'), JSON.stringify(push2));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 145（LINE）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
