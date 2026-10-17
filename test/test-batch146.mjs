// 批次 146：待教清單——回編號就能教（朱朱 LINE 截圖：推播列出【1】，她回「1」，米亞回「我只收到一個『1』，沒辦法判斷你想問什麼」）。
//   一、推播：每題寫「回『N』教這題」，附「✏️ 教第 N 題」「略過 N」按鈕
//   二、回「1」→ 列出題目、請他打答案；下一句就是答案，寫進記憶
//   三、選了題之後改變主意：「算了」、按別的按鈕、打別的指令，都不會被誤當成答案
//   四、只回數字但清單上沒有那一題（「2026」）→ 照一般訊息處理
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
  await fresh(); // 每句重新載入：限流歸零、模組快取清掉（追問狀態在假試算表裡，照樣接得上）
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res());
  const out = sent.slice();
  out.text = out.map((s) => s.text || '').join('\n');
  out.chips = (out.at(-1)?.quickReply || []).map((c) => (typeof c === 'object' && c ? (c.text ?? c.label) : String(c)));
  return out;
}
async function cron() {
  await fresh();
  sent.length = 0;
  await handler({ method: 'GET', query: { action: 'cron_teach' }, headers: { authorization: 'Bearer cron-secret' }, socket: {} }, res());
  return sent.slice();
}
const stamp = (minAgo) => new Date(Date.now() - minAgo * 60000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const NO_DATA = '這部分我沒有資料，建議洽現場新聞聯絡人。';
const qa = (minAgo, q, media) => [stamp(minAgo), 'med', '智慧醫療解決方案記者會', media, q, NO_DATA, '', 'line', ''];
const queueRow = (id) => state.teachQueue.find((x) => Number(x[0]) === id);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

reset();
state.staff.push(['U_admin', '朱朱', '2026-08-27', '', '']);
state.qaLog = [qa(60, '這場的發言人是誰', '經濟日報'), qa(50, '現場有提供停車位嗎', '中央社'), qa(40, '會有線上直播嗎', '聯合報')];

// ═══ 一、推播 ═════════════════════════════════════════════════════════════
console.log('── 一、推播的說法與按鈕 ──');
{
  const out = await cron();
  const push = out.find((s) => s.to === 'U_admin');
  const chips = (push?.quickReply || []).map((c) => (typeof c === 'object' ? c.text : c));
  check('每題寫「回『N』教這題」（不是只有「教 N：正確答案」這種要整句打對的格式）', /回「1」教這題/.test(push?.text) && /回「3」教這題/.test(push?.text), push?.text);
  check('　 一次打完的寫法也提一下（教 1：正確答案）', /也可以一次打完：教 1：正確答案/.test(push?.text));
  check('★ 附按鈕：每題「教 N」「略過 N」＋「待教清單」（點了就不用打字）', ['教 1', '略過 1', '教 3', '略過 3', '待教清單'].every((c) => chips.includes(c)) && chips.length <= 13, JSON.stringify(chips));
  const list = await dm('U_admin', '待教清單');
  check('　 打「待教清單」的回覆也附「教第 N 題」按鈕', ['教 1', '教 2', '教 3'].every((c) => list.chips.includes(c)), JSON.stringify(list.chips));
}

// ═══ 二、回「1」→ 列出題目 → 下一句是答案 ═══════════════════════════════════
console.log('\n── 二、回編號就能教 ──');
{
  const id = Number(state.teachQueue.find((x) => /發言人/.test(x[4]))[0]);
  let out = await dm('U_admin', String(id));
  check(`★ 回「${id}」（截圖的情況）→ 列出那一題、請他直接打答案；不是「我只收到一個『${id}』」`,
    /請直接打正確答案/.test(out.text) && /這場的發言人是誰/.test(out.text) && !/只收到/.test(out.text) && !out.some((s) => s.kind === 'answer' || s.kind === 'fallback'), out.text);
  check('　 按鈕有「略過 N」和「先不教」', out.chips.includes(`略過 ${id}`) && out.chips.includes('算了'), JSON.stringify(out.chips));
  out = await dm('U_admin', '發言人是工研院副院長張博士');
  check('★ 下一句就是答案 → 學會了，記在智慧醫療那一場、這題標成已教', /學會了/.test(out.text) && state.memories.some((m) => m[1] === 'med' && /張博士/.test(m[3]) && m[5] === 'on') && queueRow(id)[8] === 'taught', out.text);
  out = await dm('U_admin', '那停車位呢');
  check('　 追問是一次性的：再下一句不會又被當成答案', !/學會了/.test(out.text) && state.memories.length === 1, out.text);

  const id2 = Number(state.teachQueue.find((x) => /停車位/.test(x[4]))[0]);
  out = await dm('U_admin', `第 ${id2} 題`);
  check(`「第 ${id2} 題」「教 ${id2}」（按鈕）也一樣是選題`, /請直接打正確答案/.test(out.text) && /停車位/.test(out.text), out.text);
  out = await dm('U_admin', '園區有訪客停車場，記者可以停'.repeat(20));
  check('　 答案太長 → 請他濃縮，直接再打一次就好（不用再選一次題）', /答案有點長/.test(out.text) && /直接再打一次/.test(out.text) && state.memories.length === 1, out.text);
  out = await dm('U_admin', '園區有訪客停車場，記者可以停');
  check('　 濃縮後再打一次 → 學會了', /學會了/.test(out.text) && state.memories.length === 2, out.text);
}

// ═══ 三、選了題又改變主意 ═════════════════════════════════════════════════
console.log('\n── 三、選了題之後改變主意 ──');
{
  const id3 = Number(state.teachQueue.find((x) => /直播/.test(x[4]))[0]);
  let out = await dm('U_admin', `教 ${id3}`);
  out = await dm('U_admin', '算了');
  check('回「算了」→ 先不教，那題還在清單上（不會把「算了」記成答案）', /先不教/.test(out.text) && queueRow(id3)[8] === 'open' && state.memories.length === 2, out.text);
  await dm('U_admin', String(id3));
  out = await dm('U_admin', '活動與進度');
  check('★ 選了題卻按了選單「活動與進度」→ 照選單做事，不會把按鈕文字記成答案', !/學會了/.test(out.text) && state.memories.length === 2 && queueRow(id3)[8] === 'open', out.text);
  await dm('U_admin', String(id3));
  out = await dm('U_admin', `略過 ${id3}`);
  check('　 選了題之後回「略過 N」→ 照略過處理', /不教了/.test(out.text) && queueRow(id3)[8] === 'skipped', out.text);
}

// ═══ 四、只回數字、清單上沒這題 ═══════════════════════════════════════════
console.log('\n── 四、只回數字但不是在選題 ──');
{
  const out = await dm('U_admin', '2026');
  check('★ 職員打「2026」（清單上沒有第 2026 題）→ 照一般訊息處理，不會回「沒有第 2026 題」', !/沒有第 2026 題|請直接打正確答案/.test(out.text), out.text);
  const out2 = await dm('U_rep', '1');
  check('★ 記者打「1」→ 跟待教清單無關（不洩漏題目、不提示登入）', !/請直接打正確答案|職員模式|待教/.test(out2.text) && !/發言人/.test(out2.text), out2.text);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 146 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
