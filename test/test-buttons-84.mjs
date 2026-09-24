// 批次 84「按鈕盤點」的回歸測試。跑真的 api/line.js（Sheets／LINE／Anthropic 用 test/fakes.mjs
// 的假版本），把記者在 1 對 1 與群組會走的每一步走一遍，檢查**每一則回覆最後掛的按鈕**
// （LINE 只顯示最新一則訊息的按鈕）。
//
// 測試同仁的回報：「可否下列小按鈕可以長駐？有時點進去最近活動，下面小按鈕就會變只有
// 幾個或是不見」。按鈕本身不能常駐（LINE 的規定），所以這裡驗的是：
//   ① 每一則回覆都帶著按鈕，沒有死路
//   ② 同一個功能在每一則裡長得一樣（同一個圖示、同一個字）
//   ③ 「找真人」在每一則都找得到（批次 81 的承諾）
//   ④ 第一次點活動之後，補問媒體名稱那則不會把整排按鈕蓋掉
//   ⑤ 按鈕被收掉了，打「選單」叫得回來（群組不用 @）
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

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b84=${++modSeq}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
// 每一步換一個 id（同一個人／群組每分鐘限 15 則），需要延續狀態的步驟自己指定同一個 id。
async function say(where, id, text) {
  const source = where === 'group' ? { type: 'group', groupId: id, userId: 'Ureporter' } : { type: 'user', userId: id };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source, message: { type: 'text', id: 'm' + seq, quoteToken: 'q' + seq, text } }]), res);
  return sent.slice();
}
async function lifecycle(where, id, type) {
  const source = where === 'group' ? { type: 'group', groupId: id } : { type: 'user', userId: id };
  sent.length = 0;
  await handler(post([{ type, replyToken: 'rt' + (++seq), source }]), res);
  return sent.slice();
}
const textOf = (i) => (typeof i === 'object' && i ? (i.text ?? i.label) : i);
const labelOf = (i) => (typeof i === 'object' && i ? (i.label ?? i.text) : i);
// 最後一則「看得到的」訊息上的按鈕（text 或 flex／影片那一組）
function lastButtons(out) {
  const visible = out.filter((s) => s.kind === 'text' || s.kind === 'flex');
  const last = visible[visible.length - 1];
  if (!last) return null;
  if (last.kind === 'text') return (last.quickReply || []).map((i) => ({ label: labelOf(i), text: textOf(i) }));
  const m = (last.messages || [])[last.messages.length - 1];
  return (m?.quickReply?.items || []).map((i) => ({ label: i.action?.label, text: i.action?.text }));
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

// 功能按鈕：送出的字 → 唯一允許的顯示字
const NAV_LABELS = {
  '回首頁': ['🏠 回首頁'],
  '最近有哪些活動': ['📅 最近活動', '📅 其他活動', '📅 某一場的窗口'],
  '產業趨勢分析': ['📊 產業趨勢'],
  '想問什麼技術': ['🔬 問技術'],
  '媒體邀訪需求': ['📞 邀訪窗口'],
  '找真人': ['🙋 找真人'],
  '使用說明': ['❓ 使用說明']
};

// ── 〇、職員模式不被塞記者按鈕（放最前面：lib/staff.js 的職員名單快取 60 秒，要在任何人查過之前先放好）──
console.log('\n── 〇、職員模式 ──');
{
  reset(); await fresh();
  state.staff.push(['Ustaff84', '', '2026-09-24', '', '']);
  const out = await say('dm', 'Ustaff84', '這是一句不在任何指令裡的話');
  const b = lastButtons(out) || [];
  check('職員收到的按鈕不會混進記者那排（沒有「🙋 找真人」）', !b.some((x) => x.text === '找真人'), JSON.stringify(b.map((x) => x.label)));
  const out2 = await say('dm', 'Ustaff84', '選單');
  check('職員打「選單」→ 職員功能表（不是記者那排）', out2.length > 0 && !(lastButtons(out2) || []).some((x) => x.text === '找真人'),
    JSON.stringify(out2.map((o) => o.kind + ':' + String(o.text || '').slice(0, 30))));
}

// ── 一、走一輪：每一則都有按鈕、字一致、找得到真人 ─────────────────────────
console.log('\n── 一、1 對 1 與群組各走一輪，看每一則回覆最後的按鈕 ──');
const steps = [];
async function walk(where) {
  reset(); await fresh();
  const P = where === 'group' ? '米亞 ' : '';
  const A = where === 'group' ? 'Cwalk1' : 'Uwalk1';
  const B = where === 'group' ? 'Cwalk2' : 'Uwalk2';
  const C = where === 'group' ? 'Cwalk3' : 'Uwalk3';
  const run = async (name, out) => steps.push({ where, name, out, btn: lastButtons(out) });
  await run(where === 'group' ? '入群自我介紹' : '加好友', await lifecycle(where, A, where === 'group' ? 'join' : 'follow'));
  if (where === 'group') await run('只叫米亞', await say(where, A, '米亞'));
  await run('最近有哪些活動', await say(where, A, P + '最近有哪些活動'));
  await run('點一場', await say(where, A, '半導體先進封裝技術發表會'));
  await run('問一題', await say(where, A, P + '重點是什麼？'));
  await run('換一場', await say(where, A, '智慧醫療解決方案記者會'));
  await run('媒體邀訪需求', await say(where, A, '媒體邀訪需求'));
  await run('產業趨勢分析', await say(where, A, '產業趨勢分析'));
  await run('想問什麼技術', await say(where, A, '想問什麼技術'));
  await run('（技術名稱）', await say(where, A, '機器人'));
  await run('使用說明', await say(where, B, '使用說明'));
  await run('找真人', await say(where, B, '找真人'));
  await run('謝謝', await say(where, B, P + '謝謝'));
  await run('回首頁', await say(where, B, '回首頁'));
  await run('聽不懂的話', await say(where, B, P + '今天天氣如何'));
  await run('選單', await say(where, C, '選單'));
}
await walk('dm');
await walk('group');

for (const s of steps) {
  const tag = `${s.where === 'group' ? '群組' : '1 對 1'}「${s.name}」`;
  check(`${tag}：最後一則有按鈕（${s.btn ? s.btn.length : 0} 顆）`, s.btn && s.btn.length >= 4, JSON.stringify(s.out.map((o) => o.kind + ':' + String(o.text || '').slice(0, 20))));
  const bad = (s.btn || []).filter((b) => NAV_LABELS[b.text] && !NAV_LABELS[b.text].includes(b.label));
  check(`${tag}：功能按鈕的字跟其他回覆一致`, bad.length === 0, JSON.stringify(bad));
  if (s.name !== '找真人') {
    check(`${tag}：找得到「🙋 找真人」`, (s.btn || []).some((b) => b.text === '找真人'), JSON.stringify((s.btn || []).map((b) => b.label)));
  }
  check(`${tag}：不超過 LINE 的 13 顆上限`, (s.btn || []).length <= 13, `${(s.btn || []).length}`);
}

// ── 二、第一次點活動（1 對 1）：補問媒體名稱那則不能把按鈕蓋掉 ─────────────────
console.log('\n── 二、1 對 1 第一次點活動：答案之後的補問也帶著整排按鈕 ──');
{
  const s = steps.find((x) => x.where === 'dm' && x.name === '點一場');
  const last = s.out.filter((o) => o.kind === 'text').at(-1);
  check('★ 最後一則是補問媒體名稱（這一則的按鈕才是記者看得到的）', /方便留個貴媒體的名稱/.test(last?.text || ''), last?.text);
  check('★ 補問那則帶著「略過」＋這場的整排按鈕', s.btn?.[0]?.text === '略過' && s.btn.some((b) => b.text === '回首頁') && s.btn.some((b) => b.text === '找真人'),
    JSON.stringify(s.btn?.map((b) => b.label)));
  const sw = steps.find((x) => x.where === 'dm' && x.name === '換一場');
  check('★ 1 對 1 換場確認有這場的按鈕（原本一顆都沒有）', /已為您換到/.test(sw.out[0]?.text || '') && sw.out[0]?.quickReply?.length >= 6, JSON.stringify(sw.out[0]));
}

// ── 三、「選單」把按鈕叫回來 ─────────────────────────────────────────────────
console.log('\n── 三、打「選單」叫回按鈕 ──');
{
  reset(); await fresh();
  let out = await say('group', 'Cmenu', '選單');
  check('★ 群組裡沒 @、沒寫米亞，只打「選單」也回（按鈕被別人的訊息收掉時用）', lastButtons(out)?.length >= 6, JSON.stringify(out));
  out = await say('group', 'Cmenu2', '今天中午吃什麼');
  check('反面：一般閒聊照樣安靜', out.length === 0, JSON.stringify(out));
  out = await say('dm', 'Umenu', '半導體先進封裝技術發表會');
  out = await say('dm', 'Umenu', '選單');
  const b = lastButtons(out) || [];
  check('1 對 1 正在問某一場時，「選單」給的是那場的整排', b.some((x) => x.text === '回首頁') && b.length >= 11 && /半導體先進封裝/.test(out.at(-1)?.text || ''), JSON.stringify(out.at(-1)));
  out = await say('dm', 'Umenu2', '米亞');
  check('1 對 1 只打「米亞」也叫得出按鈕', (lastButtons(out) || []).length >= 6, JSON.stringify(out));
}

// ── 四、「想問什麼技術」的一鍵範例：群組裡別人按也會動 ─────────────────────────
console.log('\n── 四、問技術的一鍵範例 ──');
{
  reset(); await fresh();
  let out = await say('group', 'Ctech', '米亞 想問什麼技術');
  const ex = (lastButtons(out) || []).find((b) => b.label === '機器人');
  check('「想問什麼技術」附上一鍵範例（機器人／半導體／AI 晶片）', !!ex && ex.text === '工研院 機器人', JSON.stringify(lastButtons(out)));
  // 另一位成員按範例（旗標綁的是發問的那個人），不 @
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'group', groupId: 'Ctech', userId: 'Uother' }, message: { type: 'text', id: 'm' + seq, text: '工研院 機器人' } }]), res);
  out = sent.slice();
  check('★ 群組裡別人按範例按鈕也會回（不是按了沒反應）', out.some((o) => o.kind === 'text' || o.kind === 'answer'), JSON.stringify(out.map((o) => o.kind)));
  out = await say('dm', 'Utech', '想問什麼技術');
  out = await say('dm', 'Utech', '工研院 半導體');
  check('1 對 1 按範例 → 查工研院的技術（送進模型的是半導體這一題）', out.some((o) => o.kind === 'answer' && /半導體/.test(JSON.stringify(o.question || o.sys || ''))) && out.some((o) => o.kind === 'text'),
    JSON.stringify(out.map((o) => o.kind + ':' + String(o.question || o.text || '').slice(0, 30))));
}

// ── 五、按鈕上的字 ──────────────────────────────────────────────────────────
console.log('\n── 五、按鈕上的字修正 ──');
{
  const s = steps.find((x) => x.where === 'dm' && x.name === '產業趨勢分析');
  check('★ 按「產業趨勢分析」不再冒出「工研院的有哪些技術」這顆', !(s.btn || []).some((b) => /有哪些/.test(b.label)), JSON.stringify(s.btn?.map((b) => b.label)));
  const c = steps.find((x) => x.where === 'dm' && x.name === '媒體邀訪需求');
  check('邀訪窗口選單裡「活動名稱」改成看得懂的「📅 某一場的窗口」', (c.btn || []).some((b) => b.label === '📅 某一場的窗口') && !(c.btn || []).some((b) => b.label === '活動名稱'),
    JSON.stringify(c.btn?.map((b) => b.label)));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 84 按鈕測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
