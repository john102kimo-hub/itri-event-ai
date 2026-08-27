// 端到端流程測試：把 Sheets／LINE／Anthropic 全部換成假的，直接驗 api/line.js 的
// handler 對一則 webhook 事件做了什麼。重點是「綁定中問別的問題」不再被吃掉。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── 用 loader 攔截 lib/sheets.js 與 lib/line.js ──────────────────────
register('./loader.mjs', import.meta.url);

const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

// api/line.js 有模組層的 60 秒快取（eventsCache / lineUsersCache）。測試在同一個
// 進程裡跑，情境之間直接改 state.bindings 不會讓那份快取失效，第二個情境就會讀到
// 第一個情境的殘留。每個情境重新 import 一次（用查詢字串繞開模組快取）最乾淨，
// 也順便驗證了冷啟動路徑。
let handler;
let modSeq = 0;
async function freshModule() {
  handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default;
}

function makeReq(text, userId = 'U_reporter') {
  const body = JSON.stringify({
    events: [{ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', text } }]
  });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

async function send(text, userId) {
  sent.length = 0;
  await handler(makeReq(text, userId), res);
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event }));
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

// ── 情境 1：使用者回報的 bug ─────────────────────────────────────────
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });

let out = await send('這場的重點是什麼');
check('綁定中的正常提問 → 走該場問答', out[0]?.kind === 'answer' && out[0].event === 'quad',
  JSON.stringify(out));

out = await send('最近活動');
check('綁定中打「最近活動」→ 給活動清單，不是丟給該場 AI（就是回報的 bug）',
  out[0]?.kind === 'text' && /近期活動|近期已結束/.test(out[0].text), JSON.stringify(out));
check('活動清單有提醒目前在哪一場', /您目前在問的是/.test(out[0]?.text || ''), out[0]?.text);

out = await send('使用說明');
check('綁定中打「使用說明」→ 給說明', /怎麼使用這個帳號/.test(out[0]?.text || ''), JSON.stringify(out));

out = await send('換一場活動');
check('「換一場活動」→ 解除綁定並列清單',
  out[0]?.kind === 'text' && /已經離開原本那一場/.test(out[0].text), JSON.stringify(out));
check('綁定真的被清掉', !state.bindings.get('U_reporter')?.bound_at,
  JSON.stringify(state.bindings.get('U_reporter')));

// ── 情境 2：按活動清單的按鈕換場 ─────────────────────────────────────
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });
out = await send('半導體先進封裝技術發表會');
check('綁定中打另一場完整名稱 → 換過去並用新那場回答',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));
check('換場後綁定指向新場次', state.bindings.get('U_reporter')?.event_id === 'semi');
check('換場保留媒體名稱', state.bindings.get('U_reporter')?.media_name === '中央社');

// ── 情境 3：ask_name 視窗不能吃掉真正的問題 ──────────────────────────
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: 'ask_name', bound_at: Date.now() });
out = await send('最近活動');
check('ask_name 視窗內按選單 → 不會被記成媒體名稱', !/已記錄/.test(out[0]?.text || ''), JSON.stringify(out));
check('ask_name 旗標當場作廢', state.bindings.get('U_reporter')?.note === '');
out = await send('給我完整新聞稿');
check('接著問真正的問題 → 有被回答，沒被當成名字',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

// ask_name 正常流程沒有回歸
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: 'ask_name', bound_at: Date.now() });
out = await send('中央社');
check('ask_name 視窗內回媒體名稱 → 仍正常記錄', /已記錄/.test(out[0]?.text || ''), JSON.stringify(out));
check('媒體名稱有寫進去', state.bindings.get('U_reporter')?.media_name === '中央社');

// 換場也要清掉 ask_name
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: 'ask_name', bound_at: Date.now() });
await send('半導體先進封裝技術發表會');
check('用「打別場名稱」換場也會清掉 ask_name 旗標', state.bindings.get('U_reporter')?.note === '');
out = await send('給我完整新聞稿');
check('換場後的第一個問題沒被媒體名稱擷取吃掉',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

// ── 情境 4：沒綁定時 ────────────────────────────────────────────────
reset(); await freshModule();
out = await send('使用說明');
check('沒綁定也問得到使用說明', /怎麼使用這個帳號/.test(out[0]?.text || ''), JSON.stringify(out));
out = await send('最近活動');
check('沒綁定打「最近活動」→ 清單，且不呼叫 AI 路由', out[0]?.kind === 'text' && /近期活動/.test(out[0].text));
check('沒綁定時清單不會出現「您目前在問的是」', !/您目前在問的是/.test(out[0]?.text || ''));

// ── 情境 5：follow 事件送歡迎圖卡 ───────────────────────────────────
reset(); await freshModule();
sent.length = 0;
{
  const body = JSON.stringify({ events: [{ type: 'follow', replyToken: 'rt', source: { type: 'user', userId: 'U_new' } }] });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  await handler(req, res);
}
check('加好友 → 送 Flex 歡迎圖卡', sent[0]?.kind === 'flex', JSON.stringify(sent));
check('圖卡有 altText', typeof sent[0]?.messages?.[0]?.altText === 'string' && sent[0].messages[0].altText.length > 0);

// ── 情境 6：職員模式登入／退出 ──────────────────────────────────────
// 「退出職員模式」原本會被 AI 路由判成 other、只回一份能力清單，永遠退不出去。
process.env.LINE_STAFF_PASSCODE = 'openseasame';
const { STAFF_MENU, REPORTER_MENU } = await import('../lib/menu.js');

reset(); await freshModule();
state.richMenus.push(
  { richMenuId: 'rm_reporter', name: REPORTER_MENU.name },
  { richMenuId: 'rm_staff', name: STAFF_MENU.name }
);

out = await send('openseasame', 'U_staff');
check('講對密語 → 進入職員模式', /職員模式已啟用/.test(out[0]?.text || ''), JSON.stringify(out));
check('登入時把下方選單換成職員版', state.linkedMenus.get('U_staff') === 'rm_staff',
  String(state.linkedMenus.get('U_staff')));
check('職員快速回覆按鈕涵蓋全部功能（不再只有兩顆）',
  (sent[0]?.quickReply || []).length >= 6, JSON.stringify(sent[0]?.quickReply));

out = await send('退出職員模式', 'U_staff');
check('「退出職員模式」真的退出，不是回一份能力清單',
  /已退出職員模式/.test(out[0]?.text || ''), JSON.stringify(out));
check('line_staff 標記 revoked（保留稽核軌跡，不刪列）',
  state.staff.length === 1 && state.staff[0][3] === 'revoked', JSON.stringify(state.staff));
check('解除個人選單連結 → 落回記者選單', !state.linkedMenus.has('U_staff'));

// 退出後就是一般記者
out = await send('最近活動', 'U_staff');
check('退出後「最近活動」走記者路徑', /近期活動|近期已結束/.test(out[0]?.text || ''), JSON.stringify(out));

// 其他講法也要能退出
for (const phrase of ['離開職員模式', '登出', '退出職員身分']) {
  reset(); await freshModule();
  state.staff.push(['U_s2', '', '2026-08-27', '']);
  out = await send(phrase, 'U_s2');
  check(`「${phrase}」也要能退出`, /已退出職員模式/.test(out[0]?.text || ''), JSON.stringify(out));
}

// 退出後重新輸入密語要能復權，而且不能長出第二列
reset(); await freshModule();
state.staff.push(['U_s3', '小明', '2026-08-27', 'revoked']);
out = await send('openseasame', 'U_s3');
check('退出後重新輸入密語 → 復權', /職員模式已啟用/.test(out[0]?.text || ''), JSON.stringify(out));
check('復權是改原本那列，不是再 append 一列',
  state.staff.length === 1 && state.staff[0][3] === '', JSON.stringify(state.staff));

// 一般記者打「退出」不能誤觸任何東西
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('退出');
check('記者打「退出」不會被當成職員指令', out[0]?.kind === 'answer', JSON.stringify(out));

console.log(`\n${fail === 0 ? '✅' : '❌'} 流程測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
