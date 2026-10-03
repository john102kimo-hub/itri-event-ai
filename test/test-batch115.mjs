// 批次 115 的回歸測試：選單「新聞稿全文」按下去，不能被模型判成「官網搜尋」。
//
// 回報（LINE 截圖）：按圖文選單「新聞稿全文」→ 回「工研院官網新聞中心目前沒有找到跟『給我完整新聞稿』
// 直接相關的報導」。根因：正式環境的模型把這句判成 tech_query、抽不出關鍵字，整句被丟去官網搜尋；
// 批次 85 那條「反問要哪一場」排在路由之後，路由判成別的就永遠輪不到。
//
// ⚠️ 這份測試的重點是 `state.routeForce`：test/fakes.mjs 的假模型剛好把這句判成 other，所以批次 85 的測試
// 一直是綠的——它驗的是「模型剛好判對」的那條路。這裡逐一強迫假模型判成別的意圖，才是在驗 CLAUDE.md 第 2 條
// 要的「不靠模型」。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset, getStaffModelCalls } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b115=${++modSeq}`, import.meta.url).href)).default; }
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
async function g(gid, uid, text, { mention = false } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
const texts = (out) => out.filter((s) => s.kind === 'text');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

const ev = (id, name, status, date) =>
  [id, name, '#0F9E7A', '【新聞稿】' + name + '的內容', status, date, '', '', '', '工研院', 'c-' + id, '', '', '', '王小明 03-1111111', '', '', ''];
function seed() {
  reset();
  state.events = [
    ev('up5', '五天後的綠能論壇', 'active', isoOffset(5)),
    ev('past3', '晶鏈高峰論壇測試場', 'active', isoOffset(-3))
  ];
}

// 正式環境的模型判過的、以及可能判成的各種意圖。每一種都不能讓這顆按鈕走偏。
const WRONG_ROUTES = {
  'tech_query（沒抽出關鍵字，截圖那一種）': () => ({ intent: 'tech_query', event_ids: [], confidence: 'high', tech_keyword: '' }),
  'tech_query（抽成整句）': (t) => ({ intent: 'tech_query', event_ids: [], confidence: 'high', tech_keyword: t }),
  'industry_trend': () => ({ intent: 'industry_trend', event_ids: [], confidence: 'high' }),
  'calendar': () => ({ intent: 'calendar', event_ids: [], confidence: 'high' }),
  'other': () => ({ intent: 'other', event_ids: [], confidence: 'low' })
};
const isPicker = (out) => /想要哪一場的完整新聞稿/.test(texts(out)[0]?.text || '');
const wentToSiteSearch = (out) => out.some((o) => /官網新聞中心|抓不到工研院官網/.test(o.text || ''));

// ⚠️ 放在最前面：lib/staff.js 的職員名單快取 60 秒，要在任何人查過之前先放好（同 test-buttons-84.mjs）。
console.log('── 〇、職員選單的固定句型：不靠模型 ──');
{
  // 職員模式裡這五顆按鈕原本整個靠 Haiku 判意圖。強迫模型一律回 other（最壞的情況），按鈕仍要做對的事。
  const { STAFF_MENU } = await import('../lib/menu.js');
  const { STAFF_BUTTON_INTENTS } = await import('../lib/staff.js');
  const expect = {
    '新增活動': /新活動的名稱/,
    '查活動後台數據': /哪一場的後台數據/,
    'GEO現在狀況': /GEO/,
    '要媒體訓練連結': /哪一場的媒體訓練連結/,
    '設定圖文選單': /圖文選單/
  };
  check('職員選單每一格送出的字，不是在固定句型裡、就是已有字面比對處理',
    STAFF_MENU.buttons.every((b) => STAFF_BUTTON_INTENTS[b.text] || ['活動與進度', '更新活動', '更多功能'].includes(b.text)),
    JSON.stringify(STAFF_MENU.buttons.filter((b) => !STAFF_BUTTON_INTENTS[b.text]).map((b) => b.text)));
  for (const [btn, re] of Object.entries(expect)) {
    seed(); await fresh();
    state.staff.push(['U_staff', '', '2026-08-27', '', '']);
    state.staffRouteForce = () => ({ intent: 'other', event_ids: [], new_event_name: '', new_event_date: '', update_field: '', update_value: '', confidence: 'low' });
    const before = getStaffModelCalls();
    const out = await dm('U_staff', btn);
    const t = texts(out)[0]?.text || '';
    check(`模型一律回 other 時，按「${btn}」仍做對的事`, re.test(t) && !/這句我不太確定|查不到耶|我可以從兩個方向/.test(t), t.slice(0, 80));
    check('　 沒有呼叫職員路由模型', getStaffModelCalls() === before, `呼叫了 ${getStaffModelCalls() - before} 次`);
  }
  // 反面：帶著活動名稱、有主題的講法照舊進模型
  seed(); await fresh();
  state.staff.push(['U_staff', '', '2026-08-27', '', '']);
  const before = getStaffModelCalls();
  await dm('U_staff', '晶鏈高峰論壇測試場的媒體訓練連結');
  check('反面：「ＸＸ場的媒體訓練連結」整句不等於按鈕的字，照舊進模型比對活動', getStaffModelCalls() === before + 1, `呼叫了 ${getStaffModelCalls() - before} 次`);
}

console.log('── 一、沒綁定：模型判成什麼都一樣，反問「要哪一場」 ──');
for (const [name, route] of Object.entries(WRONG_ROUTES)) {
  seed(); await fresh();
  state.routeForce = (t) => route(t);
  const out = await dm('Uunbound', '給我完整新聞稿');
  check(`模型判成 ${name} → 照樣反問要哪一場`, isPicker(out), JSON.stringify(out.map((o) => String(o.text || o.kind).slice(0, 40))));
  check('　 沒有跑去官網搜尋', !wentToSiteSearch(out), JSON.stringify(out.map((o) => String(o.text || '').slice(0, 40))));
}
{
  seed(); await fresh();
  state.routeForce = WRONG_ROUTES['tech_query（沒抽出關鍵字，截圖那一種）'];
  const out = await dm('Uunbound', '給我完整新聞稿');
  const btn = (texts(out)[0]?.quickReply || []).map((i) => (typeof i === 'object' ? i.text : i));
  check('反問的按鈕是每一場的「給我《…》的完整新聞稿」', btn.includes('給我《晶鏈高峰論壇測試場》的完整新聞稿') && btn.includes('給我《五天後的綠能論壇》的完整新聞稿'), JSON.stringify(btn));
  const out2 = await dm('Uunbound', '給我《晶鏈高峰論壇測試場》的完整新聞稿');
  check('按下去之後直接答那一場', out2.some((o) => o.kind === 'answer' && o.event === 'past3'), JSON.stringify(out2.map((o) => o.kind + ':' + (o.event || ''))));
}

console.log('\n── 二、選單的文字與手打的常見講法 ──');
for (const t of ['給我完整新聞稿', '完整新聞稿', '新聞稿全文', '我要完整新聞稿', '想要整篇新聞稿', '請給我完整新聞稿', '給我完整新聞稿？', '可以給我完整新聞稿嗎', '新聞稿全部']) {
  seed(); await fresh();
  state.routeForce = WRONG_ROUTES['tech_query（沒抽出關鍵字，截圖那一種）'];
  check(`「${t}」→ 反問要哪一場`, isPicker(await dm('Utyped', t)));
}

console.log('\n── 三、有主題、點名活動的不吃：照舊交給路由 ──');
for (const t of ['半導體的完整新聞稿', 'AI 晶片完整新聞稿', '這場的完整新聞稿']) {
  seed(); await fresh();
  state.routeForce = () => ({ intent: 'tech_query', event_ids: [], confidence: 'high', tech_keyword: '半導體' });
  check(`「${t}」不被固定句型攔走（還是走路由）`, !isPicker(await dm('Utopic', t)), t);
}

console.log('\n── 四、已經綁定某一場：直接答那一場，不管模型判成什麼 ──');
for (const [name, route] of Object.entries(WRONG_ROUTES)) {
  seed(); await fresh();
  state.bindings.set('Ubound', { event_id: 'past3', media_name: '中央社', note: '', bound_at: Date.now() });
  state.routeForce = (t) => route(t);
  const out = await dm('Ubound', '給我完整新聞稿');
  check(`模型判成 ${name} → 答綁定的那一場`, out.some((o) => o.kind === 'answer' && o.event === 'past3') && !isPicker(out) && !wentToSiteSearch(out),
    JSON.stringify(out.map((o) => o.kind + ':' + String(o.text || o.event || '').slice(0, 30))));
}

console.log('\n── 五、群組 ──');
for (const [name, route] of Object.entries(WRONG_ROUTES)) {
  seed(); await fresh();
  state.routeForce = (t) => route(t);
  const out = await g('Cgrp', 'U王', '米亞 給我完整新聞稿', { mention: false });
  check(`群組叫米亞、沒綁定，模型判成 ${name} → 反問要哪一場`, isPicker(out) && !wentToSiteSearch(out), JSON.stringify(out.map((o) => String(o.text || o.kind).slice(0, 40))));
}
for (const [name, route] of Object.entries(WRONG_ROUTES)) {
  seed(); await fresh();
  state.bindings.set('Cbound', { event_id: 'past3', media_name: '', note: '', bound_at: Date.now() });
  state.routeForce = (t) => route(t);
  const out = await g('Cbound', 'U王', '米亞 給我完整新聞稿');
  check(`群組叫米亞、已綁定，模型判成 ${name} → 答綁定的那一場`, out.some((o) => o.kind === 'answer' && o.event === 'past3') && !wentToSiteSearch(out),
    JSON.stringify(out.map((o) => o.kind + ':' + String(o.text || o.event || '').slice(0, 30))));
}
{
  seed(); await fresh();
  state.routeForce = WRONG_ROUTES['tech_query（沒抽出關鍵字，截圖那一種）'];
  const out = await g('Cquiet', 'U路人', '給我完整新聞稿');
  check('群組裡沒叫米亞、不在續問視窗內 → 還是安靜（不因為這條規則開始插話）', out.length === 0, JSON.stringify(out));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 115 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
