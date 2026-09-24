// 批次 86 的回歸測試：已經在問某一場時的閒聊、官網補查只附真的相關的報導。
// 回報的群組截圖：綁著「眺望 2027」時打「米亞 天氣如何」，米亞婉拒得很得體，後面卻接了
// 「本場資料沒有，不過官網有相關報導」＋一篇能源管理新聞（官網全文比對，內文順帶提過天氣）。
// 跑真的 api/line.js（Sheets／LINE／Anthropic／工研院官網用 test/fakes.mjs 的假版本）。
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
async function fresh() { handler = (await import(new URL(`../api/line.js?b86=${++modSeq}`, import.meta.url).href)).default; }
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
async function g(gid, uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'group', groupId: gid, userId: uid }, message: { type: 'text', id: 'm' + seq, quoteToken: 'q' + seq, text } }]), res);
  return sent.slice();
}
const texts = (out) => out.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
const qr = (out) => (out.filter((s) => s.kind === 'text').at(-1)?.quickReply || []).map((i) => (typeof i === 'object' ? i.text : i));
const bind = (id, event = 'quad') => state.bindings.set(id, { event_id: event, media_name: '中央社', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 10 * 60 * 1000 });

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

// ── 一、群組：綁定中叫米亞問天氣 ──────────────────────────────────────────────
console.log('\n── 一、群組綁著某一場時「米亞 天氣如何」──');
reset(); await fresh();
bind('Cwx');
{
  const out = await g('Cwx', 'U朱', '米亞 天氣如何');
  check('★ 回寫死的天氣俏皮話（跟沒綁定時同一句）', /天氣預報我真的答不出來/.test(texts(out)), texts(out));
  check('★ 不呼叫模型、不算成一題提問', !out.some((o) => o.kind === 'answer'), JSON.stringify(out.map((o) => o.kind)));
  check('★ 後面沒有接「官網有相關報導」', !/官網新聞中心|相關報導/.test(texts(out)), texts(out));
  check('按鈕是這場的整排（還在問這場）', qr(out)[0] === '回首頁' && qr(out).includes('重點'), JSON.stringify(qr(out)));
}
{
  const out = await g('Cwx', 'U朱', '米亞 活動當天如果下雨會照常舉行嗎？');
  check('反面：跟活動有關的雨天問題照樣交給這場回答（不被「天氣」攔下）', out.some((o) => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out.map((o) => o.kind)));
}
{
  const out = await g('Cwx', 'U李', '在嗎？');
  check('反面：續問視窗內沒叫米亞的「在嗎？」不會被當成打招呼回一句', !/公關小特派/.test(texts(out)), texts(out));
}

// ── 二、1 對 1：綁定中的閒聊 ─────────────────────────────────────────────────
console.log('\n── 二、1 對 1 綁著某一場時的閒聊 ──');
reset(); await fresh();
bind('Udm');
{
  let out = await dm('Udm', '天氣如何');
  check('1 對 1「天氣如何」→ 寫死的俏皮話＋這場的按鈕', /天氣預報我真的答不出來/.test(texts(out)) && qr(out).includes('回首頁') && !out.some((o) => o.kind === 'answer'),
    JSON.stringify(out.map((o) => o.kind + ':' + String(o.text || '').slice(0, 20))));
  out = await dm('Udm', '你好可愛');
  check('「你好可愛」→ 寫死的回覆，不送模型', /不好意思/.test(texts(out)) && !out.some((o) => o.kind === 'answer'), texts(out));
  out = await dm('Udm', '答錯了');
  check('反面：「答錯了」照樣交給模型連同上一輪重答（批次 72 的設計）', out.some((o) => o.kind === 'answer'), JSON.stringify(out.map((o) => o.kind)));
}

// ── 三、官網補查：標題或摘要沒提到的不附 ─────────────────────────────────────────
console.log('\n── 三、官網補查只附真的相關的報導 ──');
reset(); await fresh();
bind('Unews');
state.noDataKeyword = '量子電腦'; // 官網假資料只有機器人、院士兩則，都沒提到量子電腦
{
  const out = await dm('Unews', '有量子電腦的資料嗎？');
  check('★ 官網搜得到東西、但標題／摘要都沒提到這個詞 → 不附「官網有相關報導」', !/官網新聞中心|相關報導/.test(texts(out)), texts(out));
  check('答案本身照樣送出', /沒有資料/.test(texts(out)), texts(out));
}
state.noDataKeyword = '院士';
{
  const out = await dm('Unews', '今年院士有誰？');
  const t = texts(out);
  check('反面：標題真的提到「院士」→ 照樣附官網報導', /工研院官網新聞中心/.test(t) && /院士授證/.test(t), t.slice(0, 300));
  check('而且只附相關的那一則（機器人那則不附）', !/足型機器人/.test(t), t.slice(0, 400));
}
state.noDataKeyword = '';

console.log(`\n${fail ? '❌' : '✅'} 批次 86 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
