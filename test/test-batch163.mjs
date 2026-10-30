// 批次 163：管理員自己在同仁模式新增活動，名稱打「123」被待教清單的攔截吃掉
//   原因：api/line.js 的「待教清單提示」排在同仁判斷前面；管理員（LINE_ADMIN_USER_ID）本人同時是同仁時，
//   parseQueueCommand('123') 判成「選第 123 題」，同仁模式整段沒走到。
//   為什麼以前沒被測到：test-batch138 的同仁是 U_c、管理員是 U_admin——「管理員同時是同仁」這個身分組合沒人測過。
//   這支把「身分」當成一個維度：同一套新增／修改／發布／媒體訓練，同仁、管理員兼同仁、管理員兼職員都要過。
//   一、身分矩陣：三種身分各走完整流程
//   二、數字、題號、井號這類「長得像指令」的名稱，同仁／管理員兼同仁都要建得起來
//   三、職員模式：米亞正在問名稱／哪一場時，只回數字不是選待教題
//   四、批次 145 的提示沒被改壞（管理員還沒登入）
//   五、結構防線：api/line.js 在「同仁／職員接管」之前，只准有登記過的字面攔截
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
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
const staffRow = (uid) => [uid, '朱朱', '2026-08-27', '', ''];
const evNames = () => state.events.map((r) => r[1]);
const byName = (n) => state.events.find((r) => r[1] === n);
const readyEvent = (id, name) => [id, name, '#0F9E7A', '【新聞稿】先進製程成果：良率提升與量產時程說明。', 'draft', isoOffset(10), '', '', '', '工研院', 'code' + id, '', '南港展覽館', '', '王小明 0912-345-678', '', '', ''];

// ═══ 一、身分矩陣：同一套流程，三種身分各走一遍 ═══════════════════════════════
const IDENTITIES = [
  { who: '一般同仁', uid: 'U_c', row: colleagueRow, prefix: '同仁' },
  { who: '管理員兼同仁（朱朱本人）', uid: 'U_admin', row: colleagueRow, prefix: '同仁' },
  { who: '管理員兼職員', uid: 'U_admin', row: staffRow, prefix: '職員' },
];
for (const { who, uid, row, prefix } of IDENTITIES) {
  console.log(`\n── 一、${who}：新增 → 修改 → 發布 → 媒體訓練 ──`);
  reset(); state.staff.push(row(uid));
  const rid = 'rdy' + seq;
  state.events.push(readyEvent(rid, `先進製程成果發表${rid}`));
  await fresh();
  const L = (s) => `【${who}】${s}`;

  // 新增：點「新增活動」→ 打名稱。名稱用純數字，這是這次出事的那一句
  let out = await dm(uid, '新增活動');
  check(L('「新增活動」→ 問名稱'), /新活動的名稱/.test(textOf(out)), textOf(out));
  out = await dm(uid, '123');
  check(L('★ 回「123」→ 建出《123》草稿，不是「要先登入職員模式」'), byName('123')?.[4] === 'draft' && /已建立《123》/.test(textOf(out)) && !/待教清單|要先登入/.test(textOf(out)), textOf(out));
  out = await dm(uid, '新增活動：氫能應用成果展 11/12');
  check(L('　 連名稱帶日期一次講完 → 直接建'), /已建立《氫能應用成果展》/.test(textOf(out)) && /11-12/.test(byName('氫能應用成果展')?.[5] || ''), textOf(out));

  // 修改：活動卡 → 地點 → 確認
  if (prefix === '同仁') {
    // 同仁模式：入口 → 點活動出活動卡 → 接著只說「地點改成⋯」（卡上已經指定那一場）
    out = await dm(uid, '修改活動');
    check(L('　 「修改活動」→ 列出活動'), /要改哪一場/.test(textOf(out)), textOf(out));
    out = await dm(uid, '智慧醫療解決方案記者會');
    // 批次 178：同仁活動卡是 Flex 圖像卡，活動名稱在標頭裡（不是文字訊息）
    check(L('　 點活動 → 活動卡'), out.some((s) => s.kind === 'flex' && /智慧醫療解決方案記者會/.test(JSON.stringify(s.messages))), JSON.stringify(out).slice(0, 300));
    out = await dm(uid, '地點改成南港展覽館');
  } else {
    // 職員模式沒有活動卡（點活動名稱是問答），改資料一律連場次一起講
    out = await dm(uid, '智慧醫療那場地點改成南港展覽館');
  }
  check(L('★ 「地點改成南港展覽館」→ 先問確認'), /南港展覽館/.test(textOf(out)) && /確認修改/.test(JSON.stringify(out)), textOf(out));
  out = await dm(uid, '✅ 確認修改');
  check(L('★ 確認 → 改好了'), state.events.find((e) => e[0] === 'med')[12] === '南港展覽館' && /已更新 ✅/.test(textOf(out)), textOf(out));
  // 修改日期之類純數字的值也不能被攔
  out = await dm(uid, '智慧醫療那場時間改成 14:00');
  out = await dm(uid, '✅ 確認修改');
  check(L('　 再改一欄（時間）→ 也成功'), state.events.find((e) => e[0] === 'med')[11] === '14:00' || /已更新/.test(textOf(out)), textOf(out));

  // 發布
  out = await dm(uid, `發布：先進製程成果發表${rid}`);
  check(L('★ 發布 → 先確認'), /要發布《先進製程成果發表/.test(textOf(out)), textOf(out));
  out = await dm(uid, '🚀 確認發布');
  check(L('★ 確認 → 已發布'), state.events.find((e) => e[0] === rid)[4] === 'active' && /已發布 ✅/.test(textOf(out)), textOf(out));

  // 媒體訓練
  out = await dm(uid, '媒體訓練');
  out = await dm(uid, '智慧醫療解決方案記者會');
  check(L('★ 媒體訓練 → 給連結'), /\/training\?id=med&code=/.test(textOf(out)), textOf(out));
}

// ═══ 二、長得像指令的名稱 ═════════════════════════════════════════════════════
// 純數字（待教清單的「選第 N 題」）、帶「教」「第 N 題」「略過」字樣、井號（活動代碼綁定）、全形數字
console.log('\n── 二、長得像指令的名稱，同仁與管理員兼同仁都要建得起來 ──');
const LOOKALIKES = ['1', '2026', '0', '7', '123456', '１２３', '2027眺望', '第 3 題論壇'];
for (const { who, uid } of IDENTITIES.slice(0, 2)) {
  reset(); state.staff.push(colleagueRow(uid)); await fresh();
  for (const name of LOOKALIKES) {
    await dm(uid, '新增活動');
    const out = await dm(uid, name);
    check(`【${who}】名稱「${name}」→ 建出草稿`, !!byName(name) && /已建立/.test(textOf(out)) && !/待教清單|要先登入/.test(textOf(out)), textOf(out));
  }
}

// ═══ 三、職員模式：回答追問時的數字不是選待教題 ═════════════════════════════
console.log('\n── 三、職員模式：米亞在問名稱時，數字跟待教題號撞上 ──');
reset(); state.staff.push(staffRow('U_admin'));
state.teachQueue = [[123, '2026/10/24', 'med', '智慧醫療解決方案記者會', '請問有沒有停車位？', 'fallback', 3, '', 'open', 'Y']];
await fresh();
{
  await dm('U_admin', '新增活動');
  let out = await dm('U_admin', '123');
  check('★ 待教清單上剛好有第 123 題，米亞正在問新活動名稱 → 「123」是名稱，建出《123》', !!byName('123') && /已建立《123》/.test(textOf(out)), textOf(out));
  out = await dm('U_admin', '123');
  check('★ 沒有追問的時候，「123」照舊是選第 123 題（批次 146 沒被改壞）：列出題目、沒有再建一場《123》',
    /停車位/.test(textOf(out)) && evNames().filter((n) => n === '123').length === 1, textOf(out));
  out = await dm('U_admin', '待教清單');
  check('　 明確的「待教清單」照舊可用', /待教|123/.test(textOf(out)), textOf(out));
}

// ═══ 四、批次 145：管理員還沒登入，回待教清單指令仍提示先登入 ═══════════════
console.log('\n── 四、管理員沒登入（維持批次 145 的提示）──');
reset(); await fresh();
{
  let out = await dm('U_admin', '待教清單');
  check('★ 管理員沒登入、打「待教清單」→ 提示先登入職員模式', /要先登入職員模式才能用待教清單/.test(textOf(out)), textOf(out));
  out = await dm('U_someone', '待教清單');
  check('　 不是管理員的人打同一句 → 沒有提示（不讓記者知道有這組指令）', !/要先登入職員模式/.test(textOf(out)), textOf(out));
}

// ═══ 五、結構防線 ═════════════════════════════════════════════════════════════
// 這次的根因是「排在身分判斷前面、不分身分的字面攔截」。同仁／職員的訊息整段由各自的模式接管，
// 所以在那兩道門「之前」，凡是拿使用者原文（text）去比對的攔截，都必須是登記過的、而且確定不會吃到一般文字。
// 以後有人想在這一段加新的攔截，這支會紅：請改放到同仁／職員那兩道門的後面；真的要放前面，先證明它不會吃到
// 「123」「新增活動」這種一般輸入，再把名字加進下面的清單並說明理由。
console.log('\n── 五、結構防線：身分門之前的字面攔截 ──');
{
  const src = readFileSync(new URL('../api/line.js', import.meta.url), 'utf8');
  const start = src.indexOf('await startLoading(userId, 55);');
  const gate = src.indexOf('await handleColleagueMessage(replyToken, userId, text);');
  const staffGate = src.indexOf('await handleStaffMessage(replyToken, userId, text);');
  check('　 找得到「開始」「職員門」「同仁門」三個定位點', start > 0 && gate > start && staffGate > start, JSON.stringify([start, staffGate, gate]));
  const body = src.slice(start, Math.max(gate, staffGate));
  // 逐一找「拿 text 去呼叫」的函式：xxx(text ...) 或 xxx(...text)
  const calls = new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(([^()]*\btext\b[^()]*)\)/g)].map((m) => m[1]));
  const ALLOWED = new Map([
    ['isPasscodeMatch', '密語本身：只認設定好的那串字'],
    ['isColleaguePasscodeMatch', '密語本身'],
    ['parseRegBindText', '「#報名 代碼」：# 開頭＋格式固定'],
    ['parseRegBindCheck', '同上，驗檢查碼'],
    ['parseB2BBind', '「#業務 代碼-檢查碼」：# 開頭＋格式固定'],
    ['isUnbindAsk', '「取消綁定」：整句比對，而且 handleB2BUnbind 只在真的綁著時才處理（沒綁就放行）'],
    ['handleStaffMessage', '職員門本身'],
    ['handleColleagueMessage', '同仁門本身'],
    ['String', '轉字串'],
    ['replyOrPush', '送出回覆，不是比對'],
    ['console', ''],
  ]);
  const unknown = [...calls].filter((n) => !ALLOWED.has(n));
  check('★ 身分門之前，拿使用者原文去比對的只有登記過的幾個（新增攔截請放到門後面）', unknown.length === 0, `未登記：${unknown.join('、')}`);
  // 待教清單提示這種「只對特定身分」的攔截，一定排在同仁門後面
  const queueHint = src.indexOf('parseQueueCommand(text)');
  check('★ 待教清單提示排在同仁門「之後」（這次出事的順序）', queueHint > gate, JSON.stringify([queueHint, gate]));
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
