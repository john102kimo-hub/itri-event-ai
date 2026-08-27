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
// 群組事件：mentionSelf 決定送出的訊息有沒有 @ 到機器人（isSelf: true）。
// mentionText 是要 @ 掉的那段字串（預設整個 '@我 '），用來算 index/length——
// 跟 lib/line.js stripMentionText() 真正吃的是同一種偏移量格式。
function makeGroupReq(text, { groupId = 'Cgroup1', mentionSelf = true, mentionText = '@我 ', asRoom = false } = {}) {
  const mention = mentionSelf
    ? { mentionees: [{ index: 0, length: mentionText.length, type: 'user', userId: 'Ubot', isSelf: true }] }
    : undefined;
  const source = asRoom ? { type: 'room', roomId: groupId } : { type: 'group', groupId };
  const body = JSON.stringify({
    events: [{
      type: 'message', replyToken: 'rt_' + Math.random(), source,
      message: { type: 'text', text, ...(mention ? { mention } : {}) }
    }]
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

async function sendGroup(text, opts) {
  sent.length = 0;
  await handler(makeGroupReq(text, opts), res);
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

// ── 情境 7：職員追問「哪一場」要接得住 ──────────────────────────────
// 回報的 bug：「查活動後台數據」→「請問是想查哪一場？」→ 打「四足」→ 跑去問答。
process.env.ADMIN_PASSWORD = '';   // getGeoStatusSummary() 會回 null，走沒資料那條
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);

out = await send('查活動後台數據', 'U_staff');
check('問後台數據沒指定場次 → 反問哪一場', /哪一場的後台數據/.test(out[0]?.text || ''), JSON.stringify(out));
check('反問時附上活動名稱按鈕', (sent[0]?.quickReply || []).length > 0, JSON.stringify(sent[0]?.quickReply));
check('記下 pending', /^event_analytics:/.test(state.staff[0][4] || ''), String(state.staff[0][4]));

out = await send('四足', 'U_staff');
check('追問回「四足」→ 給後台數據，不是跑去問答（回報的 bug）',
  /後台數據/.test(out[0]?.text || '') && out[0]?.kind !== 'answer', JSON.stringify(out));
check('後台數據要附後台連結', /itri-event-ai\.vercel\.app\/admin/.test(out[0]?.text || ''), out[0]?.text);
check('後台數據要附這場的記者問答頁連結',
  /itri-event-ai\.vercel\.app\/event\?id=quad/.test(out[0]?.text || ''), out[0]?.text);
check('pending 用掉後清空', !state.staff[0][4], String(state.staff[0][4]));

// 用掉之後不能再影響下一則——不然之後每次打活動名稱都會變成查數據
out = await send('四足', 'U_staff');
check('pending 清掉後，再打活動名稱回到正常問答', out[0]?.kind === 'answer', JSON.stringify(out));

// 媒體訓練連結：同一套追問，且要真的給出連結
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('要媒體訓練連結', 'U_staff');
check('問媒體訓練沒指定場次 → 反問哪一場', /哪一場的媒體訓練連結/.test(out[0]?.text || ''), JSON.stringify(out));
out = await send('半導體先進封裝技術發表會', 'U_staff');
check('追問後給媒體訓練連結', /\/training\?id=semi&code=/.test(out[0]?.text || ''), out[0]?.text);
check('同時附上同仁編輯連結', /\/edit\?id=semi&code=/.test(out[0]?.text || ''), out[0]?.text);

// 舊活動沒有編輯碼時要當場補、不能把同仁踢回後台
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
state.events.find(e => e[0] === 'semi')[10] = ''; // 清掉編輯碼，模擬舊活動
out = await send('要 半導體先進封裝技術發表會 的媒體訓練連結', 'U_staff');
check('沒有編輯碼時當場補一個，仍然給得出連結',
  /\/training\?id=semi&code=/.test(out[0]?.text || ''), out[0]?.text);
check('補出來的編輯碼有寫回 events 表', !!state.events.find(e => e[0] === 'semi')[10]);

// GEO 狀態要附連結
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('GEO現在狀況', 'U_staff');
check('GEO 狀態要附 /geo 連結', /itri-event-ai\.vercel\.app\/geo/.test(out[0]?.text || ''), out[0]?.text);

// 新增活動的追問：整句就是名稱，不能被重判成問活動內容
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('新增活動', 'U_staff');
check('新增活動沒給名稱 → 反問名稱', /請告訴我新活動的名稱/.test(out[0]?.text || ''), JSON.stringify(out));
check('記下 create_event pending', /^create_event:/.test(state.staff[0][4] || ''), String(state.staff[0][4]));
const before = state.events.length;
out = await send('智慧製造技術發表會', 'U_staff');
check('追問回名稱 → 真的建立活動，不是跑去問答',
  /已建立《智慧製造技術發表會》/.test(out[0]?.text || ''), JSON.stringify(out));
check('活動有寫進 events 表', state.events.length === before + 1);
check('新活動是 draft', state.events[state.events.length - 1][4] === 'draft');
check('回覆附上同仁編輯連結', /\/edit\?id=.+&code=/.test(out[0]?.text || ''), out[0]?.text);

// pending 過期不能誤接
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', `event_analytics:${Date.now() - 11 * 60 * 1000}`]);
out = await send('四足', 'U_staff');
check('pending 超過 10 分鐘就失效，不會誤接成查數據', out[0]?.kind === 'answer', JSON.stringify(out));

// ── 情境 8：群組／多人聊天，仿美玉姨——只有被 @ 到才回答 ──────────────
reset(); await freshModule();

out = await sendGroup('這場記者會的重點是什麼', { mentionSelf: false });
check('群組裡沒有 @ 到我們 → 完全不回應（不能在群組裡自己插話）', out.length === 0, JSON.stringify(out));

out = await sendGroup('@我 這是四足機器人記者會的重點嗎', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡 @ 到我們 → 有回應', out.length > 0, JSON.stringify(out));
check('@ 到我們時走一般問答（比對到 quad）', out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

out = await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
check('群組問活動列表 → 走 calendar，不會被當成活動內容提問',
  out[0]?.kind === 'text' && /近期活動/.test(out[0].text), JSON.stringify(out));

out = await sendGroup('@我', { mentionSelf: true, mentionText: '@我' });
check('只 @ 沒接問題 → 引導怎麼問，不會噴例外或送空白問題給 AI',
  out[0]?.kind === 'text' && /請在 @ 我的後面接您的問題/.test(out[0].text), JSON.stringify(out));

// 群組軟綁定：@ 問過一次某場之後，同群組其他人 @ 問後續問題不用重打活動名稱
reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('@我 那合作廠商有哪些', { mentionSelf: true, mentionText: '@我 ' });
check('群組軟綁定：後續 @ 問題直接回答上次那場，不用重打活動名稱',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

// 密語與 #代碼在群組裡完全不接——不能讓群組意外開啟職員模式
reset(); await freshModule();
out = await sendGroup('@我 openseasame', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡講密語不會進入職員模式（走一般路由，判成 other 或找不到活動）',
  !/職員模式已啟用/.test(out[0]?.text || ''), JSON.stringify(out));
out = await sendGroup('@我 #quad', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡打 #代碼不會觸發綁定文案', !/已為您接上/.test(out[0]?.text || ''), JSON.stringify(out));

// room（多人聊天室，非群組）也要走同一條路
reset(); await freshModule();
out = await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ', asRoom: true, groupId: 'Rroom1' });
check('room 來源一樣支援 @ 提及問答', out[0]?.kind === 'text' && /近期活動/.test(out[0].text), JSON.stringify(out));

// 限流用 groupId 為 key，不會被個別使用者的額度互相影響
reset(); await freshModule();
{
  let last;
  for (let i = 0; i < 16; i++) last = await sendGroup(`@我 問題${i}`, { mentionSelf: true, mentionText: '@我 ' });
  check('群組限流：超過額度後給出提示，不會一直往下噴 AI 呼叫',
    /提問太頻繁/.test(last[0]?.text || ''), JSON.stringify(last));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 流程測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
