// 批次 162：「新增活動」連名稱一起打，字面就認得；沒進入同仁模式的人打「新增活動」要被提醒先進入
//   一、line_staff 讀取失敗不能讓已登入的人變成記者（沿用上一份名單、幾秒後重試，不是把 [] 快取 60 秒）
//   二、登入時 line_staff 寫不進去，不能回「已啟用」也不能換選單
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, getStaffModelCalls } = await import('./fakes.mjs');
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


const evNames = () => state.events.map((r) => r[1]);
const created = (name) => state.events.find((r) => r[1] === name);
const noModelAnswer = (out) => !kinds(out).includes('answer') && !kinds(out).includes('fallback');
const { parseCreateEventText, isCreateEventAsk } = await import('../lib/staff.js?v=p162');

// ═══ 一、解析：認得的、不認得的 ═══════════════════════════════════════════════
console.log('── 一、parseCreateEventText() ──');
const T = '2026-10-23';
const yes = [
  ['新增活動：原鄉成果發表會', '原鄉成果發表會', ''],
  ['新增活動:原鄉成果發表會', '原鄉成果發表會', ''],
  ['新增活動 原鄉成果發表會', '原鄉成果發表會', ''],
  ['新增活動原鄉成果發表會', '原鄉成果發表會', ''],
  ['建立活動 眺望研討會', '眺望研討會', ''],
  ['新增一場活動，名稱是「奈米論壇」謝謝', '奈米論壇', ''],
  ['請幫我新增一場活動叫做 半導體論壇', '半導體論壇', ''],
  ['我要新增活動「智慧醫療論壇」', '智慧醫療論壇', ''],
  ['新增活動：名稱：測試論壇', '測試論壇', ''],
  ['新增活動 眺望研討會 10/28', '眺望研討會', '2026-10-28'],
  ['新增活動 眺望研討會 10月28日', '眺望研討會', '2026-10-28'],
  ['新增活動 眺望研討會 2026-12-05', '眺望研討會', '2026-12-05'],
  ['新增活動 眺望研討會 3/5', '眺望研討會', '2027-03-05'],
  ['新增活動 為你而來音樂會', '為你而來音樂會', ''],
  ['新增活動 2026 AI 論壇', '2026 AI 論壇', '']
];
for (const [text, name, date] of yes) {
  const r = parseCreateEventText(text, T);
  check(`認得：${text}`, r && r.name === name && r.date === date, JSON.stringify(r));
}
const no = ['新增活動', '新增一場活動', '新增活動怎麼做？', '新增活動的方法', '新增活動管理要怎麼做', '新增活動 算了', '新增活動 不用了',
  '新增活動 眺望研討會 明天', '新增活動 眺望研討會 下週三', '新增活動 眺望研討會 13/45', '新增新聞稿', '新增記者', '智慧醫療那場地點改成南港展覽館', '活動', '新增活動 一場'];
for (const text of no) check(`不認得（照原流程）：${text}`, parseCreateEventText(text, T) === null, JSON.stringify(parseCreateEventText(text, T)));

// ═══ 二、同仁：連名稱一起打 ═══════════════════════════════════════════════════
console.log('\n── 二、同仁模式 ──');
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
{
  let before = getStaffModelCalls();
  for (const [text, name] of [['新增活動：原鄉成果發表會', '原鄉成果發表會'], ['新增活動:原鄉成果發表會二', '原鄉成果發表會二'], ['新增活動 原鄉成果發表會三', '原鄉成果發表會三'], ['新增活動原鄉成果發表會四', '原鄉成果發表會四']]) {
    const out = await dm('U_c', text);
    check(`★ 「${text}」→ 直接建立《${name}》、名稱乾淨`, !!created(name) && new RegExp(`已建立《${name}》`).test(textOf(out)), textOf(out));
  }
  check('★ 這四句都沒有問模型', getStaffModelCalls() === before, `${getStaffModelCalls() - before} 次`);
  check('　 沒有建出名稱裡帶著「新增活動」的草稿', !evNames().some((n) => /新增活動/.test(n)), JSON.stringify(evNames()));

  let out = await dm('U_c', '新增活動 眺望研討會B 10/28');
  const row = created('眺望研討會B');
  check('★ 結尾帶日期 → 日期寫進去、回覆講出來（含星期）', row && /^\d{4}-10-28$/.test(row[5]) && /10-28（/.test(textOf(out)), JSON.stringify([row && row[5], textOf(out)]));

  await dm('U_c', '新增活動');
  out = await dm('U_c', '新增活動：重打一次的論壇');
  check('★ 米亞剛問「新活動叫什麼」、同仁整句重打 → 名稱乾淨（以前會建出「新增活動:…」）', !!created('重打一次的論壇') && !evNames().some((n) => /新增活動/.test(n)), JSON.stringify(evNames()));

  const n = state.events.length;
  out = await dm('U_c', '新增活動');
  check('　 只打「新增活動」→ 照舊問名稱，不建', state.events.length === n && /請告訴我新活動的名稱/.test(textOf(out)), textOf(out));
  for (const text of ['新增活動怎麼做？', '新增活動 算了', '新增活動 眺望研討會 明天']) {
    await dm('U_c', '算了');
    const m = state.events.length;
    out = await dm('U_c', text);
    check(`　 「${text}」→ 不自己猜、不建（照原流程）`, state.events.length === m && noModelAnswer(out), JSON.stringify(evNames().slice(-2)));
  }
}

// ═══ 三、職員 ═════════════════════════════════════════════════════════════════
console.log('\n── 三、職員模式 ──');
reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  const before = getStaffModelCalls();
  const out = await dm('U_s', '新增活動：職員建的論壇 11/12');
  check('★ 職員也一樣：直接建、日期帶進去、沒問模型', !!created('職員建的論壇') && /已建立《職員建的論壇》/.test(textOf(out)) && getStaffModelCalls() === before, textOf(out));
}

// ═══ 四、還沒進入同仁模式：提醒先進入 ═══════════════════════════════════════
console.log('\n── 四、沒有進入同仁模式的人打「新增活動」 ──');
reset(); await fresh();
{
  const n = state.events.length;
  for (const text of ['新增活動', '新增活動：原鄉成果發表會', '新增一場活動', '建立活動 眺望研討會 10/28']) {
    const out = await dm('U_x', text);
    const t = textOf(out);
    check(`★ 「${text}」→ 提醒先進入同仁模式、再輸入一次密語，不是記者問答`, /還沒有進入/.test(t) && /同仁模式/.test(t) && /再輸入一次密語/.test(t) && noModelAnswer(out), t);
    check('　 　不建任何活動、訊息裡沒有密語本身', state.events.length === n && !t.includes('Jerry') && !t.includes('openseasame'), t);
  }
  const out = await dm('U_x', '新增活動的報名方式是什麼？');
  check('　 一般提問（「新增活動的報名方式⋯？」）不被攔', !/還沒有進入/.test(textOf(out)), textOf(out));
  const out2 = await dm('U_x', '最近有什麼活動');
  check('　 記者的一般問題不受影響', !/還沒有進入/.test(textOf(out2)), textOf(out2));

  // 進入之後同一句話就能用
  await dm('U_x', 'Jerry');
  const out3 = await dm('U_x', '新增活動：進入後建的論壇');
  check('★ 照提醒輸入密語後，同一句話就建得起來', !!created('進入後建的論壇') && !/還沒有進入/.test(textOf(out3)), textOf(out3));

  // 退出之後又打：再次提醒
  await dm('U_x', '退出同仁模式');
  const out4 = await dm('U_x', '新增活動');
  check('★ 退出之後（以為還在）打「新增活動」→ 再次提醒', /還沒有進入/.test(textOf(out4)), textOf(out4));
}
reset();
{
  const sc = process.env.LINE_COLLEAGUE_PASSCODE, st = process.env.LINE_STAFF_PASSCODE;
  delete process.env.LINE_COLLEAGUE_PASSCODE; delete process.env.LINE_STAFF_PASSCODE;
  await fresh();
  const out = await dm('U_y', '新增活動');
  check('　 兩組密語都沒設定（同仁模式停用）→ 不提醒「去輸入密語」', !/還沒有進入/.test(textOf(out)), textOf(out));
  process.env.LINE_COLLEAGUE_PASSCODE = sc; process.env.LINE_STAFF_PASSCODE = st;
}

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
