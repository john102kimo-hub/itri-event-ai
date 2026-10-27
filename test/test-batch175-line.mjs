// 批次 175（LINE 那一半）：職員、同仁在 LINE「試問記者會當天的答案」。
//   活動卡上出現「🎤 試問當天答案」（只在活動還沒到、有邀請函時）→ 按下去進入試問 → 每一句都用活動當天的內容回答
//   → 「結束試問」離開；選單、退出、換場次會先結束試問；記者自己打「試問：」沒有任何效果。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';   // 要開著，問答才會寫進 qa_log（見 lib/line-reporter.js logQa）
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
const cardButtons = (out) => JSON.stringify(out);
const answerOf = (out) => out.find((s) => s.kind === 'answer');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

const INVITE = '親愛的媒體朋友：誠摯邀請蒞臨採訪，10:00 開始。';
const KB = '【新聞稿全文】儲電新技術發表會：工研院今日發表新一代儲電技術，預計 2027 年第二季量產。\n新聞聯絡人：王小明';
const ev = (id, name, date, kb, invite) =>
  [id, name, '#0F9E7A', kb, 'active', date, '', '', '', '工研院', 'code_' + id, '10:00', '南港展覽館', '記者會', '王小明 0912-345-678', '', invite, ''];

reset();
state.events.push(
  ev('s1', '儲電新技術發表會', isoOffset(3), KB, INVITE),
  ev('s2', '沒有邀請函的發表會', isoOffset(3), KB, ''),
  ev('s3', '今天的發表會', isoOffset(0), KB, INVITE),
);
await fresh();

// ═══ 職員模式 ═════════════════════════════════════════════════════════════════
console.log('\n── 職員模式 ──');
await dm('U_s', 'openseasame');
let out = await dm('U_s', '儲電新技術發表會');
check('★ 活動卡（活動還沒到、有邀請函）出現「🎤 試問當天答案」', cardButtons(out).includes('試問：儲電新技術發表會') && cardButtons(out).includes('試問當天答案'), cardButtons(out).slice(0, 500));
out = await dm('U_s', '沒有邀請函的發表會');
check('　 沒有邀請函的場次：不放這顆按鈕（記者現在問到的本來就是新聞稿）', !cardButtons(out).includes('試問：'), cardButtons(out).slice(0, 300));
out = await dm('U_s', '今天的發表會');
check('　 活動當天的場次：不放', !cardButtons(out).includes('試問：'));

out = await dm('U_s', '試問：沒有邀請函的發表會');
check('★ 直接按沒必要的場次 → 說「不用模擬」，沒有進入試問', /不用模擬/.test(textOf(out)) && !/開始試問/.test(textOf(out)), textOf(out));

out = await dm('U_s', '試問：儲電新技術發表會');
check('★ 按「🎤 試問當天答案」→ 說清楚這是什麼（用當天內容、記者不受影響、不算統計、怎麼結束）', ['開始試問', '活動當天', '記者現在問到的還是邀請函', '不會算進統計', '結束試問'].every((t) => textOf(out).includes(t)), textOf(out));
check('　 按鈕：第一顆就是「🔚 結束試問」', buttons(out)[0] === '結束試問', JSON.stringify(buttons(out)));

out = await dm('U_s', '這項技術何時量產？');
let a = answerOf(out);
check('★ 試問中問問題：用活動當天的新聞稿回答（不是邀請函）', a && a.sys.includes('2027 年第二季量產') && !a.sys.includes('誠摯邀請蒞臨採訪'), a?.sys?.slice(0, 300));
check('　 活動基本資料寫「就是今天」，沒有「還有 3 天」', a && (a.sysAll.includes('就是今天') && !a.sysAll.includes('還有 3 天')), a?.sysAll?.slice(-300));
check('　 答案開頭標明「模擬記者會當天」與怎麼離開', /模擬記者會當天（打「結束試問」離開）/.test(textOf(out)), textOf(out));
check('　 問答記成「（內部職員）」（結案報告與統計會濾掉）', state.qaAppended.some((r) => r[3] === '（內部職員）' && /量產/.test(r[4] || '')), JSON.stringify(state.qaAppended.at(-1)));

out = await dm('U_s', '還有哪些細節？');
check('　 連續問第二題仍在試問裡（每問一題把 10 分鐘重新算）', answerOf(out)?.sys.includes('2027 年第二季量產') && /模擬記者會當天/.test(textOf(out)));

out = await dm('U_s', '結束試問');
check('★ 「結束試問」→ 結束，說記者那邊不受影響', /結束試問/.test(textOf(out)) && /記者那邊不受影響/.test(textOf(out)) && !answerOf(out), textOf(out));
out = await dm('U_s', '這項技術何時量產？');
a = answerOf(out);
check('　 結束之後再問：回到職員平常的問法（沒有「模擬」字樣）', !/模擬記者會當天/.test(textOf(out)), textOf(out));

// 試問中按選單：先結束試問
await dm('U_s', '試問：儲電新技術發表會');
out = await dm('U_s', '職員選單');
check('★ 試問中按「職員選單」→ 回選單，不當成問題', !answerOf(out) && /職員|選單|做什麼/.test(textOf(out)), textOf(out));
out = await dm('U_s', '這項技術何時量產？');
check('　 選單之後再問：試問已經結束', !/模擬記者會當天/.test(textOf(out)), textOf(out));

await dm('U_s', '試問：儲電新技術發表會');
out = await dm('U_s', '活動與進度');
check('★ 試問中按選單格子「活動與進度」→ 照原本的功能，不當成問題', !answerOf(out) && !/模擬記者會當天/.test(textOf(out)), textOf(out));

await dm('U_s', '試問：儲電新技術發表會');
out = await dm('U_s', '不用報名嗎？');
check('★ 「不用報名嗎？」開頭是「不用」但不是結束，照問題回答', !!answerOf(out) && /模擬記者會當天/.test(textOf(out)), textOf(out));
await dm('U_s', '結束試問');

// ═══ 同仁模式 ═════════════════════════════════════════════════════════════════
console.log('\n── 同仁模式 ──');
await dm('U_c', 'Jerry');
out = await dm('U_c', '儲電新技術發表會');
check('★ 同仁的活動卡也有「🎤 試問當天答案」，沒邀請函的場次沒有', cardButtons(out).includes('試問：儲電新技術發表會'), cardButtons(out).slice(0, 500));
out = await dm('U_c', '沒有邀請函的發表會');
check('　 沒邀請函：沒有這顆', !cardButtons(out).includes('試問：'));

out = await dm('U_c', '這項技術何時量產？');
check('同仁平常問問題：照舊「幫不上忙」（同仁模式沒有問答，不因為這批多出任何入口）', !answerOf(out) && /幫不上忙/.test(textOf(out)), textOf(out));

out = await dm('U_c', '試問：儲電新技術發表會');
check('★ 按下去：開始試問，有「結束試問」', /開始試問/.test(textOf(out)) && buttons(out)[0] === '結束試問', textOf(out));
out = await dm('U_c', '這項技術何時量產？');
a = answerOf(out);
check('★ 同仁在試問裡問問題：用活動當天的新聞稿回答、記成「（內部職員）」', a && a.sys.includes('2027 年第二季量產') && !a.sys.includes('誠摯邀請蒞臨採訪') && state.qaAppended.at(-1)?.[3] === '（內部職員）' && /量產/.test(state.qaAppended.at(-1)[4]), JSON.stringify(state.qaAppended.at(-1)));
out = await dm('U_c', '新增活動');
check('★ 試問中按「新增活動」→ 結束試問、照原本的流程（不是當成問題問米亞）', !answerOf(out) && /名稱/.test(textOf(out)), textOf(out));
out = await dm('U_c', '算了');
out = await dm('U_c', '試問：儲電新技術發表會');
out = await dm('U_c', '退出同仁模式');
check('★ 試問中退出同仁模式 → 照常退出（權限關閉不被試問擋住）', /已退出同仁模式/.test(textOf(out)), textOf(out));

// ═══ 記者 ═════════════════════════════════════════════════════════════════════
console.log('\n── 記者自己打「試問：」──');
out = await dm('U_r', '試問：儲電新技術發表會');
check('★ 記者打「試問：某某活動」沒有任何特殊效果（不進試問、拿不到新聞稿）', !/開始試問/.test(textOf(out)) && !(answerOf(out)?.sys || '').includes('2027 年第二季量產'), textOf(out));

console.log(`\n${fail ? '❌' : '✅'} 批次 175（LINE）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
