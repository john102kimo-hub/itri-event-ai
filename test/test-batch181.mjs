// 批次 181：記者端「近期活動」改成圖像卡。
//   一、純函式 buildCalendarFlex()：每場一列、日期方塊、整列可點（只有有資料的場次）、沒有場次回 null
//   二、LINE 流程：1 對 1 送圖像卡＋只留五顆固定入口；群組維持文字（要引用原問題）；Flex 送不出去退回文字；「回首頁」開場白不丟
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

const { buildCalendarFlex, buildCalendarCards } = await import('../lib/router.js');

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
async function group(gid, uid, text) {
  sent.length = 0;
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: `@米亞 ${text}`, mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } };
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const jsonOf = (o) => JSON.stringify(o);

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('── 一、純函式 ──');
{
  // events 表欄位：A id, B name, C color, D knowledge_base, E status, F 日期（A～O，見 lib/router.js buildAllCalendarCards）
  const row = (id, name, date, kb) => [id, name, '#0F9E7A', kb, 'active', date, '', '', '', '工研院', '', '', '', '', ''];
  const KB = '【新聞稿】這是一段足夠長的新聞稿內容，用來讓知識庫算「有資料」。';
  const cards = buildCalendarCards([
    row('a', '五天後有資料的發表會', isoOffset(5), KB),
    row('b', '十天後只有基本資料', isoOffset(10), ''),
    row('c', '三天前辦過的記者會', isoOffset(-3), KB),
    row('d', '還沒定日期的論壇', '', KB)
  ]);
  const card = buildCalendarFlex(cards, { notes: ['（備註一）', '（備註二）'] });
  const js = jsonOf(card);
  check('★ 每場一列：即將舉行、最近辦過、日期未定的都在', card && ['五天後有資料的發表會', '十天後只有基本資料', '三天前辦過的記者會', '還沒定日期的論壇'].every((n) => js.includes(n)), js.slice(0, 200));
  check('　 有資料的整列可點（點了＝打活動名稱）；只有基本資料的不能點、寫「僅基本資料」', js.includes('"action":{"type":"message","label":"問這一場","text":"五天後有資料的發表會"}') && !js.includes('"text":"十天後只有基本資料"}') && /僅基本資料/.test(js), js.slice(0, 200));
  check('　 日期方塊：月份與日、星期與倒數；沒日期寫「未定」', /還有 5 天/.test(js) && /週[日一二三四五六]/.test(js) && /"text":"未定"/.test(js));
  check('　 備註一則一行放在底部；altText 寫得出場數（通知與聊天列表只看得到它）', /（備註一）/.test(js) && /（備註二）/.test(js) && /近期活動：即將舉行 \d+ 場/.test(card.altText), card?.altText);
  check('★ 沒有任何場次 → null（呼叫端照舊發那句文字）', buildCalendarFlex([]) === null && buildCalendarFlex(null) === null);
  check('　 只有過了 30 天的舊場次 → 也是 null', buildCalendarFlex(buildCalendarCards([row('z', '兩個月前', isoOffset(-60), KB)])) === null);
}

// ═══ 二、LINE 流程 ═════════════════════════════════════════════════════════════
console.log('\n── 二、LINE 流程 ──');
reset(); await fresh();
{
  state.rawCalendarFlex = true;
  let out = await dm('U_r', '最近有哪些活動');
  const flex = out.find((o) => o.kind === 'flex');
  const msg = flex?.messages?.[flex.messages.length - 1];
  check('★ 1 對 1 問「最近有哪些活動」→ 圖像卡（不是文字清單）', !!flex && msg?.type === 'flex' && /近期活動/.test(msg.altText) && !out.some((o) => o.kind === 'text' && /【近期活動】/.test(o.text)), jsonOf(out).slice(0, 300));
  const chips = (msg?.quickReply?.items || []).map((i) => i.action.text);
  check('　 快速回覆只剩五顆固定入口（活動改由卡上每一列點）', JSON.stringify(chips) === JSON.stringify(['產業趨勢分析', '問技術與洽案', '媒體邀訪需求', '找真人', '使用說明']), JSON.stringify(chips));
  check('　 卡上有點得到的活動列、底部提醒媒體邀訪需求窗口', /"label":"問這一場"/.test(jsonOf(msg)) && /媒體邀訪需求/.test(jsonOf(msg)), jsonOf(msg).slice(0, 200));

  out = await dm('U_r', '回首頁');
  const f2 = out.find((o) => o.kind === 'flex');
  check('★ 「回首頁」：開場白（文字）＋圖像卡一次送出，開場白不能掉', !!f2 && f2.messages[0]?.type === 'text' && /已經回到首頁/.test(f2.messages[0].text) && f2.messages.at(-1)?.type === 'flex', jsonOf(out).slice(0, 300));

  state.flexFails = true;
  out = await dm('U_r', '最近有哪些活動');
  state.flexFails = false;
  const t = out.find((o) => o.kind === 'text');
  check('★ Flex 送不出去 → 退回純文字清單＋活動名稱按鈕（跟批次 181 之前一樣）', !out.some((o) => o.kind === 'flex') && /【近期活動】/.test(t?.text || '') && (t?.quickReply || []).some((c) => /智慧醫療解決方案記者會/.test(typeof c === 'object' ? c.text : c)), jsonOf(out).slice(0, 300));

  out = await group('C_g', 'U_r', '最近有哪些活動');
  check('★ 群組維持文字（回覆要引用原問題，Flex 的送法不帶引用）', !out.some((o) => o.kind === 'flex') && out.some((o) => o.kind === 'text' && /【近期活動】/.test(o.text)), jsonOf(out).slice(0, 300));
  state.rawCalendarFlex = false;
}

console.log(`\n${fail ? '❌' : '✅'} 批次 181 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
