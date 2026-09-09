// 「群組裡的人按下任何一顆按鈕，一定會得到回覆」——這是使用者明確要求要保證的一件事
// （批次 41）：「請設定我群組只要按下按鈕都會回答……人家按按鈕，不會再特別加 @ 或米亞。」
//
// 這支測試刻意不寫死一份按鈕清單。寫死的清單只會證明「我當初想到的那幾顆會動」，而
// 這條路上已經連續三次（批次 30、32、40）都是敗在「漏掉的那一顆」。所以改成兩段：
//
//   ① 採集：實際把機器人走過一輪（入群、看清單、選一場、問一題、邀訪窗口、產業趨勢、
//      技術查詢…），把它**真的送出去的每一顆 quick reply** 的送出文字收集起來
//   ② 重放：對每一顆按鈕，在四種狀態下各按一次，而且**完全不 @、不寫「米亞」**，
//      斷言一定有回覆
//
// 之後有人加了新按鈕，只要那顆按鈕出現在採集路徑上，這支就會自動涵蓋它；漏接了就會
// 在這裡紅掉，不用等使用者回報。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

let handler, modSeq = 0;
async function freshModule() {
  handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default;
}
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

function groupReq(text, { groupId, mentionSelf }) {
  const mention = mentionSelf
    ? { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] }
    : undefined;
  const body = JSON.stringify({
    events: [{
      type: 'message', replyToken: 'rt_' + Math.random(),
      source: { type: 'group', groupId, userId: 'Uspeaker' },
      message: { type: 'text', text, ...(mention ? { mention } : {}) }
    }]
  });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
async function tap(text, { groupId = 'Cgroup1', mentionSelf = false } = {}) {
  sent.length = 0;
  await handler(groupReq(mentionSelf ? '@我 ' + text : text, { groupId, mentionSelf }), res);
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply || [] }));
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}
const btnText = i => (typeof i === 'object' && i ? (i.text ?? i.label) : i);

// ── ① 採集：機器人真的送出去的每一顆按鈕 ────────────────────────────────
console.log('── 採集：走一輪，把它送出去的按鈕全部收集起來 ──');
const buttons = new Map(); // 送出文字 → 是在哪一步看到的（紅掉時好追）

async function harvest(step, out) {
  for (const msg of out) for (const item of msg.quickReply || []) {
    const t = String(btnText(item) || '').trim();
    if (t && !buttons.has(t)) buttons.set(t, step);
  }
}

// 入群自我介紹 → 活動清單 → 選一場 → 問一題 → 邀訪窗口 → 產業趨勢 → 技術查詢
reset(); await freshModule();
{
  const body = JSON.stringify({ events: [{ type: 'join', replyToken: 'rt_join', source: { type: 'group', groupId: 'Cgroup1' } }] });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  sent.length = 0;
  await handler(req, res);
  await harvest('入群自我介紹', sent.map(s => ({ quickReply: s.quickReply || [] })));
}
await harvest('只 @ 沒接問題', await tap('', { mentionSelf: true }));
await harvest('活動清單', await tap('最近有哪些活動', { mentionSelf: true }));
await harvest('選一場（quad）', await tap('經濟部四足機器人國產研發平台發表記者會', { mentionSelf: true }));
await harvest('綁定後問一題', await tap('這場的重點是什麼', { mentionSelf: true }));
await harvest('邀訪窗口（這場有設定）', await tap('媒體邀訪需求', { mentionSelf: true }));
await harvest('回首頁', await tap('回首頁', { mentionSelf: true }));
await harvest('全域邀訪窗口清單', await tap('媒體邀訪需求', { mentionSelf: true }));
await harvest('產業趨勢分析', await tap('產業趨勢分析', { mentionSelf: true }));
await harvest('工研院技術查詢', await tap('工研院 半導體', { mentionSelf: true }));
await harvest('使用說明', await tap('使用說明', { mentionSelf: true }));
// 沒設定自訂 chips 的場次 → 預設五題
reset(); await freshModule();
await harvest('預設 chips（semi）', await tap('半導體先進封裝技術發表會的重點', { mentionSelf: true }));
// 活動前那組 invite_letter_chips
reset(); await freshModule();
await harvest('活動前 chips（soon）', await tap('奈米材料前瞻應用發表會的重點', { mentionSelf: true }));

console.log(`   採集到 ${buttons.size} 顆按鈕：`);
for (const [text, step] of buttons) console.log(`     ・${text}　（${step}）`);
check('採集到的按鈕數量合理（少於 10 顆代表採集路徑自己壞了）', buttons.size >= 10, `${buttons.size} 顆`);

// ── ② 重放：四種狀態 × 每一顆按鈕，一律不 @、不寫「米亞」───────────────────
// LINE 的按鈕會永遠留在對話紀錄裡，所以「隔多久才按」是使用者說了算，不是我們。
const H = 60 * 60 * 1000;
const STATES = [
  ['綁定活著＋續問視窗內', () => ({ event_id: 'quad', bound_at: Date.now(), groupSessionUntil: Date.now() + 5 * 60 * 1000 })],
  ['綁定活著＋視窗過期', () => ({ event_id: 'quad', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 })],
  ['綁定過期 7 小時＋視窗過期', () => ({ event_id: 'quad', bound_at: Date.now() - 7 * H, groupSessionUntil: Date.now() - 60000 })],
  ['完全沒有綁定', () => null]
];

for (const [stateName, mk] of STATES) {
  console.log(`── 重放：${stateName}（不 @、不寫「米亞」）──`);
  const silent = [];
  for (const [text, step] of buttons) {
    reset(); await freshModule();
    const b = mk();
    if (b) state.bindings.set('Cgroup1', { media_name: '', note: '', ...b });
    const out = await tap(text);
    if (!out.length) silent.push(`「${text}」（來自：${step}）`);
  }
  check(`${stateName}：每一顆按鈕都有回覆`, silent.length === 0,
    silent.length ? `沉默的按鈕 ${silent.length} 顆：\n     ` + silent.join('\n     ') : '');
}

// ── ③ 導覽鈕不可以把綁定接回上一場 ─────────────────────────────────────
// 上面那個「四種狀態都要有回覆」的保證，很容易用錯方法達成：把每一顆按鈕都拿去回推
// 場次、接回綁定，確實每顆都會有回覆——但「回首頁」的本意就是解除綁定，接回去等於
// 這顆鈕自己把自己取消掉。實測抓到過一次，所以釘在這裡。
console.log('── 導覽鈕（跨場次的功能入口）不可以接回綁定 ──');
reset(); await freshModule();
await tap('經濟部四足機器人國產研發平台發表記者會', { mentionSelf: true }); // 先綁一場
await tap('回首頁', { mentionSelf: true });                                  // 明確要求解除綁定
{
  const out = await tap('媒體邀訪需求');
  const last = out.at(-1)?.text || '';
  check('回首頁之後按「媒體邀訪需求」→ 給跨活動的全域窗口清單，不是被接回剛剛那場',
    /哪個技術領域|哪一場活動的邀訪窗口/.test(last), JSON.stringify(out));
  check('（同上）不會冒出剛剛那場的專屬窗口', !/陳美玲|王小明/.test(last), last.slice(0, 200));
}
for (const nav of ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', '使用說明']) {
  reset(); await freshModule();
  await tap('經濟部四足機器人國產研發平台發表記者會', { mentionSelf: true });
  await tap('回首頁', { mentionSelf: true });
  await tap(nav);
  const b = state.bindings.get('Cgroup1');
  const alive = !!b?.bound_at && Date.now() - Number(b.bound_at) < 6 * 60 * 60 * 1000;
  check(`回首頁之後按「${nav}」→ 綁定維持解除狀態`, !alive, JSON.stringify(b));
}
// 反過來：內容 chip 本來就該接回去（沒有場次就答不出內容）
reset(); await freshModule();
await tap('經濟部四足機器人國產研發平台發表記者會', { mentionSelf: true });
await tap('回首頁', { mentionSelf: true });
{
  const out = await tap('重點');
  check('回首頁之後按「重點」（這場的內容提問）→ 接回那一場並回答', 
    out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out));
}

// ── ③ 反面：放寬守門不能把一般閒聊也放進來 ──────────────────────────────
console.log('── 反面：一般閒聊仍然要安靜 ──');
for (const chat of [
  '大家中午吃什麼', '我等等把資料寄給你', '那我先走囉', '好的收到', '謝謝',
  '這個我再確認一下', '明天幾點集合', '照片我晚點傳'
]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() - 7 * H, groupSessionUntil: Date.now() - 60000 });
  const out = await tap(chat);
  check(`閒聊「${chat}」→ 安靜`, out.length === 0, JSON.stringify(out));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 群組按鈕測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
