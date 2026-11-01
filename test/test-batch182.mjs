// 批次 182：小按鈕越少越好，要選的東西放到卡片上。
//   記者回報：不知道快速回覆可以左右滑，一直卡在那；記者的 AI 使用能力偏弱。
//   一、規矩：每則回覆最多 4 顆、固定的只有「回首頁」「找真人」；答案底下是三顆（還能問什麼、回首頁、找真人）
//   二、「還能問什麼」：題目一題一顆列在卡片上（沒綁定場次就給活動清單）；群組不用 @ 也按得動
//   三、選單卡片：領域、窗口、完整新聞稿、回首頁（活動＋其他功能）、歡迎卡——按鈕在卡上、送出的字跟以前一模一樣
//   四、Flex 送不出去：退回以前的快速回覆那一排，沒有死路
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
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

const { detectMetaIntent, buildWelcomeFlex } = await import('../lib/menu.js');
const { buildButtonCard, buildQuestionsCard } = await import('../lib/reporter-cards.js');
const rt = await import('../lib/line-runtime.js');

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
async function group(gid, uid, text, { mention = true } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: mention ? `@米亞 ${text}` : text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const flexOf = (out) => out.find((o) => o.kind === 'flex');
const lastMsg = (out) => { const f = flexOf(out); return f?.messages?.[f.messages.length - 1]; };
const chipsOfFlex = (out) => (lastMsg(out)?.quickReply?.items || []).map((i) => ({ label: i.action.label, text: i.action.text }));
const tapsOf = (out) => { const found = []; (function walk(n) { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; if (n.type === 'button' && n.action?.type === 'message') found.push({ label: n.action.label, text: n.action.text }); else if (n.action?.type === 'message' && n.type === 'box') found.push({ label: n.action.label, text: n.action.text }); Object.values(n).forEach(walk); })(flexOf(out)?.messages?.map((m) => m.contents)); return found; };
const textChips = (out) => (out.filter((o) => o.kind === 'text').at(-1)?.quickReply || []).map((c) => (typeof c === 'object' ? { label: c.label, text: c.text } : { label: c, text: c }));
const jsonOf = (o) => JSON.stringify(o);

// ═══ 一、規矩 ═══════════════════════════════════════════════════════════════
console.log('── 一、小按鈕的規矩 ──');
{
  check('★ slim()：下一步最多 2 顆，後面固定是回首頁、找真人，總共不超過 4 顆', rt.slim().map((b) => b.text).join() === '回首頁,找真人' && rt.slim('甲', '乙', '丙').length === 4 && rt.slim('甲', '乙', '丙').slice(-2).map((b) => b.text).join() === '回首頁,找真人' && rt.slim(null, undefined).length === 2);
  const withQs = ['這次活動的重點是什麼？', '活動的時間和地點？'].join('\n');
  const row = (chips) => { const r = Array(18).fill(''); r[0] = 'x'; r[1] = '測試場'; r[3] = '【新聞稿】足夠長的新聞稿內容，用來讓知識庫算有資料。'; r[4] = 'active'; r[5] = '2099-01-01'; r[6] = chips; return r; };
  check('★ 答案底下：有題目可問 → 還能問什麼、回首頁、找真人（三顆）', rt.eventQuickChips(row(withQs)).map((b) => b.text).join() === '還能問什麼,回首頁,找真人');
  check('　 HOME_MENU 與預設導覽只有三顆：最近活動、回首頁、找真人（其他功能在回首頁那張卡）', rt.HOME_MENU.map((b) => b.text).join() === '最近有哪些活動,回首頁,找真人');
  check('★ 「還能問什麼」只認整句，不會吃掉真的提問（「可以問什麼時候開始」是在問時間）',
    ['還能問什麼', '還能問什麼？', '可以問什麼', '能問什麼'].every((t) => detectMetaIntent(t) === 'questions')
    && !['可以問什麼時候開始', '請問還能問什麼時候報名', '這場還能問什麼技術', '你還能問什麼嗎我想知道時間'].some((t) => detectMetaIntent(t) === 'questions'),
    ['可以問什麼時候開始', '請問還能問什麼時候報名', '這場還能問什麼技術'].map((t) => detectMetaIntent(t)).join('|'));
}

// ═══ 二、還能問什麼 ═════════════════════════════════════════════════════════
console.log('\n── 二、還能問什麼 ──');
reset(); await fresh();
state.rawCalendarFlex = true;
{
  let out = await dm('U_q', '半導體先進封裝技術發表會'); // 點一場（過去的）→ 綁定
  out = await dm('U_q', '重點是什麼？');
  const ans = out.filter((o) => o.kind === 'text' && o.quickReply?.length).at(-1);
  check('★ 答完一題：快速回覆只有三顆，不用左右滑', ans && ans.quickReply.map((c) => (typeof c === 'object' ? c.text : c)).join() === '還能問什麼,回首頁,找真人', jsonOf(ans?.quickReply));
  out = await dm('U_q', '還能問什麼');
  const f = flexOf(out);
  const qs = tapsOf(out);
  check('★ 按「還能問什麼」→ 一張卡，這場的題目一題一顆（預設題目依知識庫算出來的）', !!f && /可以這樣問/.test(jsonOf(f.messages)) && qs.length >= 2 && qs.every((b) => b.label.length <= 20 && b.text.length > 0) && qs.some((b) => /重點/.test(b.text)), jsonOf(f?.messages).slice(0, 300) + jsonOf(qs));
  check('　 卡片之外的快速回覆只剩回首頁、找真人', chipsOfFlex(out).map((c) => c.text).join() === '回首頁,找真人', jsonOf(chipsOfFlex(out)));
  const qText = qs.find((b) => /重點/.test(b.text))?.text;
  out = await dm('U_q', qText);
  check('★ 點題目 → 就是在問那一題（走正常問答）', out.some((o) => o.kind === 'answer'), jsonOf(out.map((o) => o.kind)));

  // 沒綁定場次 → 當成「最近有哪些活動」
  const out2 = await dm('U_new', '還能問什麼');
  check('★ 沒綁定任何一場時按「還能問什麼」→ 給活動清單（先選場次才有題目），不是空白', !!flexOf(out2) && /近期活動/.test(flexOf(out2).messages.at(-1).altText || ''), jsonOf(out2).slice(0, 200));

  // 群組：沒 @ 也按得動
  await group('C_ask', 'U_a', '半導體先進封裝技術發表會');
  const g = await group('C_ask', 'U_b', '還能問什麼', { mention: false });
  check('★ 群組裡別人按「還能問什麼」（沒 @）也會出題目卡', !!flexOf(g) && /可以這樣問/.test(jsonOf(flexOf(g).messages)), jsonOf(g).slice(0, 200));

  const card = buildQuestionsCard('測試場', Array.from({ length: 15 }, (_, i) => `這是第 ${i + 1} 個很長很長很長很長很長很長很長的題目文字內容`));
  const btns = JSON.stringify(card).match(/"type":"button"/g) || [];
  check('　 卡片最多 12 題；題目太長 label 縮到 20 字內，送出的字仍是完整一句', btns.length === 12 && (JSON.stringify(card).match(/"label":"([^"]*)","text"/) || [])[1]?.length === 20 && /"label":"這是第 1 個[^"]*…","text":"這是第 1 個很長很長很長很長很長很長很長的題目文字內容"/.test(JSON.stringify(card)), btns.length + JSON.stringify(card).slice(300, 700));
}

// ═══ 三、選單卡片 ═══════════════════════════════════════════════════════════
console.log('\n── 三、選單卡片：按鈕在卡上，送出的字跟以前一樣 ──');
{
  const cardChips = (out) => chipsOfFlex(out).map((c) => c.text);
  let out = await dm('U_m1', '產業趨勢分析');
  let taps = tapsOf(out);
  check('★ 產業趨勢：八個領域都是卡片上的按鈕（兩顆一列），快速回覆只有回首頁、找真人', taps.filter((b) => /^趨勢關鍵字：/.test(b.text)).length === 8 && cardChips(out).join() === '回首頁,找真人' && /想了解哪個領域的產業趨勢/.test(jsonOf(flexOf(out).messages)), jsonOf(taps));
  check('　 領域按鈕送出的句型跟以前的快速回覆完全一樣（規則層、群組放行不用改）', taps.some((b) => b.text === '趨勢關鍵字：半導體' && b.label === '半導體') && taps.some((b) => b.text === '趨勢關鍵字：最新'));
  out = await dm('U_m2', '問技術與洽案');
  taps = tapsOf(out);
  check('★ 技術與洽案：六個領域都在卡上，範例關鍵字寫在說明裡，沒有 11 顆快速回覆', taps.filter((b) => /^技術領域：/.test(b.text)).length === 6 && cardChips(out).join() === '回首頁,找真人' && /電池、機器人、AI 晶片/.test(jsonOf(flexOf(out).messages)), jsonOf(taps));
  out = await dm('U_m3', '媒體邀訪需求');
  taps = tapsOf(out);
  check('★ 邀訪窗口：三個選項（某一場活動／各技術單位／其他）在卡上，一列一顆', taps.map((b) => b.text).join() === '最近有哪些活動,邀訪：各單位,邀訪：其他' && cardChips(out).join() === '找真人', jsonOf(taps));
  out = await dm('U_m3', '邀訪：各單位');
  taps = tapsOf(out);
  check('　 各技術單位：單位都是卡上的按鈕（所名當標籤、送出「邀訪：主題」），回上一層在快速回覆（批次 100：單位選單不放找真人）', taps.length >= 3 && taps.every((b) => /^邀訪：/.test(b.text)) && taps.some((b) => b.label === '生醫所' && b.text === '邀訪：生醫') && cardChips(out).join() === '媒體邀訪需求', jsonOf(taps).slice(0, 300) + jsonOf(cardChips(out)));
  out = await dm('U_m4', '給我完整新聞稿');
  taps = tapsOf(out);
  check('★ 完整新聞稿：要哪一場，活動一列一顆（點了就給那一場）', taps.length >= 2 && taps.every((b) => /^給我《.+》的完整新聞稿$/.test(b.text)), jsonOf(taps));

  out = await dm('U_m5', '回首頁');
  const f = flexOf(out);
  taps = tapsOf(out);
  check('★ 回首頁：開場白＋一張卡——活動在上面、其他功能（技術、新聞、趨勢、窗口、找真人）在下面；快速回覆只有找真人', f?.messages[0].type === 'text' && taps.filter((b) => ['問技術與洽案', '近期工研院新聞', '產業趨勢分析', '媒體邀訪需求', '找真人'].includes(b.text)).length === 5 && cardChips(out).join() === '找真人', jsonOf(f?.messages).slice(0, 200));
  out = await group('C_home', 'U_g', '回首頁');
  check('　 群組的回首頁也送這張卡（其他功能在群組裡也看得到，不用左右滑）', !!flexOf(out) && tapsOf(out).some((b) => b.text === '問技術與洽案'), jsonOf(out).slice(0, 200));

  const w = buildWelcomeFlex('工研院');
  const wt = []; (function walk(n) { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; if (n.action?.type === 'message') wt.push(n.action); Object.values(n).forEach(walk); })(w.contents.footer);
  check('★ 歡迎卡：所有功能都是卡上的按鈕，標籤 20 字內、送出的字每一個都認得', wt.length === 7 && wt.every((a) => a.label.length <= 20 && detectMetaIntent(a.text) !== null), jsonOf(wt));

  const bc = buildButtonCard({ title: 't', buttons: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, text: `T${i}` })), columns: 2 });
  const rows = bc.contents.body.contents;
  check('　 buildButtonCard：兩顆一列，單數時補一個空格（不會讓最後一顆被拉得很寬）', rows.length === 3 && rows[2].contents.length === 2 && rows[2].contents[1].type === 'filler');
}

// ═══ 四、Flex 送不出去 ═════════════════════════════════════════════════════════
console.log('\n── 四、Flex 送不出去 → 退回以前的快速回覆，沒有死路 ──');
{
  state.flexFails = true;
  let out = await dm('U_f1', '產業趨勢分析');
  let chips = textChips(out);
  check('★ 趨勢領域卡送不出去 → 文字＋領域按鈕（以前那一排）＋回首頁、找真人', !flexOf(out) && /想了解哪個領域的產業趨勢/.test(out.at(-1).text) && chips.filter((c) => /^趨勢關鍵字：/.test(c.text)).length === 8 && chips.some((c) => c.text === '找真人') && chips.length <= 13, jsonOf(chips));
  out = await dm('U_f2', '問技術與洽案');
  chips = textChips(out);
  check('　 技術領域卡送不出去 → 六個領域按鈕與範例關鍵字都還在', chips.filter((c) => /^技術領域：/.test(c.text)).length === 6 && chips.some((c) => c.text === '技術關鍵字：電池') && chips.length <= 13, jsonOf(chips));
  out = await dm('U_f3', '媒體邀訪需求');
  chips = textChips(out);
  check('　 邀訪窗口選單送不出去 → 三個選項與找真人都在', ['最近有哪些活動', '邀訪：各單位', '邀訪：其他', '找真人'].every((t) => chips.some((c) => c.text === t)), jsonOf(chips));
  out = await dm('U_f4', '回首頁');
  chips = textChips(out);
  check('　 回首頁卡送不出去 → 活動清單文字＋最多 3 顆活動名稱按鈕＋找真人', !flexOf(out) && /近期活動/.test(out.map((o) => o.text).join('')) && chips.length <= 4 && chips.some((c) => c.text === '找真人'), jsonOf(chips));
  state.flexFails = false;
}
state.rawCalendarFlex = false;

console.log(`\n${fail ? '❌' : '✅'} 批次 182 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
