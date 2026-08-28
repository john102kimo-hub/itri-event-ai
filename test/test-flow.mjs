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
function makeGroupReq(text, { groupId = 'Cgroup1', mentionSelf = true, mentionText = '@我 ', asRoom = false, mentionOther = false } = {}) {
  const mention = mentionSelf
    ? { mentionees: [{ index: 0, length: mentionText.length, type: 'user', userId: 'Ubot', isSelf: true }] }
    // mentionOther：模擬「@ 到別人，不是我們」——mentionees 裡有東西，但沒有一個
    // isSelf:true，用來測 handleGroupEvent() 的人類提及否決（見該處說明）。
    : mentionOther
      ? { mentionees: [{ index: 0, length: mentionText.length, type: 'user', userId: 'Uother', isSelf: false }] }
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
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, sys: s.sys }));
}

async function sendGroup(text, opts) {
  sent.length = 0;
  await handler(makeGroupReq(text, opts), res);
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, sys: s.sys }));
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
// ⚠️ 純粹選台不是問題，不該呼叫 AI／寫 qa_log（review 抓到的坑：這裡原本會把
// 「半導體先進封裝技術發表會」這句話當成提問送給 AI，灌水「累積回答題數」）——
// 改成只回確認訊息，kind 應該是 'text' 不是 'answer'。
check('綁定中打另一場完整名稱 → 換過去並回確認訊息，不當提問處理（不寫 qa_log）',
  out[0]?.kind === 'text' && /已為您換到.*半導體先進封裝技術發表會/.test(out[0].text), JSON.stringify(out));
check('換場後綁定指向新場次', state.bindings.get('U_reporter')?.event_id === 'semi');
check('換場保留媒體名稱', state.bindings.get('U_reporter')?.media_name === '中央社');
check('已經有媒體名稱時換場不會再補問一次',
  out.length === 1 && !out.some(o => /方便留個貴媒體的名稱/.test(o.text || '')), JSON.stringify(out));

// ⚠️ 實際回報的坑：換場這條路一直都不會問媒體名稱，不管換過去之前有沒有被問過——
// 只靠打活動名稱換場的記者，media_name 永遠是空字串，後台分析永遠看到「（未填寫）」。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('半導體先進封裝技術發表會');
check('換場前從沒被問過媒體名稱 → 換場後用 push 補問一次（不擋住剛剛的確認訊息）',
  out.length === 2 && out[0]?.kind === 'text' && out[1]?.text?.includes('方便留個貴媒體的名稱'),
  JSON.stringify(out));
check('補問會設 ask_name 旗標，沿用既有的一次性擷取機制',
  state.bindings.get('U_reporter')?.note === 'ask_name');
out = await send('中央社');
check('補問視窗內回名稱 → 正常記錄', state.bindings.get('U_reporter')?.media_name === '中央社', JSON.stringify(out));

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

// 換場一定要先清掉舊的 ask_name（不管等一下會不會重新設回去），不然新舊兩次的
// 「一次性」語意會疊在一起搞混。這個人剛好還沒被問過名稱（media_name 是空字串），
// 所以換場後 note 會被換場邏輯重新設回 'ask_name'（見上面新增的補問測試），不是
// 停留在空字串——重點是接下來真正的問題不能被誤判成在報名稱。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: 'ask_name', bound_at: Date.now() });
await send('半導體先進封裝技術發表會');
check('換場後 note 是重新設定的 ask_name（因為還沒填過名稱），不是舊視窗殘留',
  state.bindings.get('U_reporter')?.note === 'ask_name');
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
// geo_status 現在優先送一則 Flex 卡片（見 lib/geo-brief.js），fakes.mjs 的
// replyOrPushMessages 記成 {kind:'flex', messages}，沒有 .text 欄位可比對。
// 這裡跑到的時候 ADMIN_PASSWORD 還是情境 7 留下的 ''（見上面那行的註解），
// getGeoStatusSummary()／getGeoTrendSeries() 都會回 null，buildGeoBriefFlex()
// 因此也回 null，會直接退回純文字版——用兩種 kind 都找得到 /geo 連結來驗證，
// 不管兩份資料查不查得到，同仁都要有辦法點到儀表板。
const geoContent = out[0]?.kind === 'flex' ? JSON.stringify(out[0].messages) : (out[0]?.text || '');
check('GEO 狀態要附 /geo 連結（有資料送 Flex 卡片、沒資料退回純文字，兩種都要附）',
  geoContent.includes('itri-event-ai.vercel.app/geo'), JSON.stringify(out));

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

// ── 情境 9：群組的免 @ 續問視窗（實際回報的體感落差）──────────────────
// 回報的操作：群組裡 @ 問「最近有哪些活動」拿到清單之後，接著（沒有再 @）打清單裡
// 某場的活動名稱，完全沒反應。每則都要 @ 的規則本身沒錯，但體感是「剛剛不是才理
// 我嗎」。修法是 GROUP_SESSION_MS 續問視窗：@ 到並回答之後，短時間內同一群組不用
// 重新 @ 也算在跟我們對話。
reset(); await freshModule();

out = await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
check('第一步：@ 問活動列表，正常拿到清單', out[0]?.kind === 'text' && /近期活動/.test(out[0].text), JSON.stringify(out));

out = await sendGroup('半導體先進封裝技術發表會', { mentionSelf: false });
check('第二步：沒有再 @，接著打一個真的存在的活動名稱 → 續問視窗內照樣回答，不是回報時的「完全沒反應」',
  out.length > 0 && out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

out = await sendGroup('那合作廠商有哪些', { mentionSelf: false });
check('第三步：續問視窗內繼續追問（已經軟綁定 semi），一樣不用 @',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

// 回報的意見：續問視窗內只要有人講話就會回，即使明顯是在跟另一個人講話，機器人
// 還是煞有其事答一段答非所問的內容。已經綁定活動時（跟上面「軟綁定 semi」同一種
// 狀態）沒有 handleUnbound() 那道 silentOnOther 門檻可用——routeIntent() 沒有對話
// 記憶，沒辦法分辨「那合作廠商有哪些」這種依賴上一句的續問跟純聊天的差別，用它來
// 判斷會連上面那個測試的合法續問一起擋掉。改用更精準、免呼叫 AI 的訊號：訊息明確
// @ 了別人（不是我們）就是最乾脆的「不是在跟我講話」。
console.log('── 續問視窗：@ 到別人（不是我們）→ 安靜，不是在跟我們講話 ──');
{
  const before = Date.now() + 60000;
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: before });
  out = await sendGroup('我再跟＠小明說話', { mentionSelf: false, mentionOther: true, mentionText: '＠小明' });
  check('續問視窗內、訊息明確 @ 別人 → 安靜，不會硬答一段答非所問的內容',
    out.length === 0, JSON.stringify(out));
  check('沒有因為這則亂回而幫續問視窗續命（groupSessionUntil 沒被延長）',
    state.bindings.get('Cgroup1')?.groupSessionUntil === before, String(state.bindings.get('Cgroup1')?.groupSessionUntil));
}

console.log('── 續問視窗：判不出意圖時要安靜，不能沒事插話 ──');
reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('大家中午吃什麼', { mentionSelf: false });
check('續問視窗內、沒有 @、又猜不出問題在問什麼 → 安靜，不會跳出「不確定您想問哪一場」插話群組聊天',
  out.length === 0, JSON.stringify(out));

console.log('── 續問視窗：非文字訊息（貼圖）安靜略過 ──');
reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
{
  const body = JSON.stringify({
    events: [{ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'group', groupId: 'Cgroup1' }, message: { type: 'sticker' } }]
  });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  sent.length = 0;
  await handler(req, res);
  check('續問視窗內傳貼圖（非文字）→ 安靜略過，不會亂回', sent.length === 0, JSON.stringify(sent));
}

console.log('── 續問視窗：超過時間就失效，退回一定要 @ ──');
reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
state.bindings.get('Cgroup1').groupSessionUntil = Date.now() - 1000; // 模擬視窗已過期
out = await sendGroup('半導體先進封裝技術發表會', { mentionSelf: false });
check('視窗過期後，沒 @ 的訊息又變回完全不回應', out.length === 0, JSON.stringify(out));

console.log('── 續問視窗：只有真的 @ 到／回答成功才續命，不是每個事件都續 ──');
reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
check('第一次 @ 之後有建立續問視窗', state.bindings.get('Cgroup1')?.groupSessionUntil > Date.now(),
  JSON.stringify(state.bindings.get('Cgroup1')));

// 1 對 1（非群組）完全不受這個機制影響——沒有 mention 概念，本來每則就都算在對我們講話
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('這場的重點是什麼');
check('1 對 1 完全不受群組續問視窗機制影響，維持原本行為', out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

// ── 情境 10：綁定後的答案要附同仁自訂的快速提問按鈕（chips）──────────────
// 回報的意見：網頁版問答介面一直都有同仁在後台設定的快速提問 chips（活動的
// 「本場次提供資料」欄位），記者點一下就能問；LINE 這邊之前完全沒接這個資料，
// 同仁特地設定的關鍵字記者在 LINE 上根本看不到。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });

out = await send('這場的重點是什麼');
check('綁定中的答案要附上這場自訂的 chips（quad 的 fixture 是「重點／應用」）',
  JSON.stringify(out[1]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out));

reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() });
out = await send('這場的重點是什麼');
check('活動沒設定自訂 chips 時（semi 的 fixture 是空字串）退回預設問題，不是空按鈕列',
  out[1]?.quickReply?.length > 0 && !JSON.stringify(out[1]?.quickReply).includes('重點'), JSON.stringify(out));

// #代碼綁定：ask_name 解決的那一刻（「已記錄，謝謝」）就要看得到 chips，
// 不用等問完第一題才第一次看到
reset(); await freshModule();
out = await send('#quad');
check('#代碼綁定確認訊息本身不附 chips（避免跟 ask_name 擷取衝突）',
  !(out[0]?.quickReply?.length > 0), JSON.stringify(out));
out = await send('中央社');
check('回覆媒體名稱、ask_name 解決之後，「已記錄」那則就附上 chips',
  JSON.stringify(out[0]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out));

// 職員模式問活動內容一樣要看得到 chips（同一支 answerQuestion()，沒有另外分岔邏輯）
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('四足機器人的重點', 'U_staff');
check('職員模式問活動內容一樣附 chips（走同一支 answerQuestion）',
  JSON.stringify(out[1]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out));

// 群組問答也要附 chips，跟 1 對 1 一致
reset(); await freshModule();
out = await sendGroup('@我 四足機器人記者會的重點', { mentionSelf: true, mentionText: '@我 ' });
check('群組問答也附 chips', JSON.stringify(out[1]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out));

// ── 情境 11：自然語言綁定時順手問媒體名稱（回報的分析缺口）────────────
// 回報的問題：用打活動名稱軟綁定（handleUnbound 的 qa 高信心分支）的記者從頭到尾
// 沒被問過媒體名稱，跟 #代碼 QR 掃碼綁定（有 ask_name 一次性擷取視窗）不一樣，
// 後台的問答分析永遠只看到「（未填寫）」。
reset(); await freshModule();

out = await send('四足機器人的重點');
check('自然語言命中照樣直接回答（不被補問卡住）',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));
check('答案本身還是附著 chips（補問是額外一則，不影響原本的回答格式）',
  JSON.stringify(out[1]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out));
check('沒問過名字的人，答完之後會多一則補問媒體名稱（不擋住答案本身）',
  out[2]?.kind === 'text' && /方便留個貴媒體的名稱/.test(out[2].text), JSON.stringify(out));
check('補問時設定 ask_name 旗標，下一則會走既有的擷取機制',
  state.bindings.get('U_reporter')?.note === 'ask_name', JSON.stringify(state.bindings.get('U_reporter')));

out = await send('中央社');
check('回覆名稱 → 沿用既有 ask_name 擷取機制正常記錄', /已記錄/.test(out[0]?.text || ''), JSON.stringify(out));
check('媒體名稱真的寫進去了', state.bindings.get('U_reporter')?.media_name === '中央社');

// 綁定過期（6 小時 TTL）不代表「不知道這個人是誰」——媒體名稱要留著，不能再問一次
state.bindings.get('U_reporter').bound_at = Date.now() - 7 * 60 * 60 * 1000;
await freshModule();
out = await send('智慧醫療解決方案記者會的重點');
check('綁定過期後再次自然語言命中 → 沿用先前的媒體名稱，不再補問',
  out.length === 2 && out[0]?.kind === 'answer' && out[0].event === 'med', JSON.stringify(out));

// 回「略過」的人也要記得住——同樣不再重複補問
reset(); await freshModule();
await send('四足機器人的重點');
await send('略過');
check('回「略過」後媒體名稱記成「（未提供）」', state.bindings.get('U_reporter')?.media_name === '（未提供）');
// 綁定過期後再進一次 handleUnbound（還在綁定期間內會走「換場」而不是這條路，
// 見 matchEventByName 對完整句子跟純活動名稱的比對差異），驗證「略過」也記得住
state.bindings.get('U_reporter').bound_at = Date.now() - 7 * 60 * 60 * 1000;
await freshModule();
out = await send('半導體先進封裝技術發表會');
check('之前回過「略過」的人，綁定過期後再次自然語言命中不會又被補問一次',
  out.length === 2 && out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

// 群組不會被問「貴媒體名稱」——群組裡沒有單一個人身分的概念
reset(); await freshModule();
out = await sendGroup('@我 四足機器人記者會的重點', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡自然語言命中不會被追問媒體名稱（只有答案本身兩則，沒有第三則補問）',
  out.length === 2 && out[0]?.kind === 'answer', JSON.stringify(out));

// ── 情境 12：邀訪聯絡窗口分工（回報的新功能）────────────────────────────
// quad 的 fixture 設定了兩組窗口：技術規格／新聞稿（見 test/fakes.mjs）
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });

out = await send('媒體邀訪需求');
check('點「媒體邀訪需求」→ 列出這場設定過的關鍵字，不呼叫 AI',
  out.length === 1 && JSON.stringify(out[0]?.quickReply) === JSON.stringify(['技術規格', '新聞稿']),
  JSON.stringify(out));
check('文字裡有提示可以直接打關鍵字', /請選擇想聯絡的主題|直接打關鍵字/.test(out[0]?.text || ''), out[0]?.text);

out = await send('技術規格');
check('打中設定過的關鍵字 → 直接回聯絡資訊，不呼叫 AI（out.length===1，沒有 answer 標記）',
  out.length === 1, JSON.stringify(out));
check('聯絡資訊包含姓名、電話、LINE ID', /陳美玲/.test(out[0]?.text || '') && /03-1111111/.test(out[0]?.text || '') && /lineid_amy/.test(out[0]?.text || ''),
  out[0]?.text);

out = await send('　技術規格　'); // 前後帶全形空白，驗證比對有先正規化
check('關鍵字比對會忽略前後空白', out.length === 1 && /陳美玲/.test(out[0]?.text || ''), JSON.stringify(out));

out = await send('技術');
check('只打關鍵字的一部分不算命中（精準比對，避免給錯窗口）→ 走一般問答',
  out[0]?.kind === 'answer', JSON.stringify(out));

// 活動沒設定窗口分工時退回既有的單一新聞聯絡人欄位
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() });
out = await send('媒體邀訪需求');
check('沒設定過窗口分工的活動 → 退回單一新聞聯絡人，不是空清單',
  /陳大文/.test(out[0]?.text || '') && /新聞聯絡人/.test(out[0]?.text || ''), out[0]?.text);

// 連單一新聞聯絡人都沒填的活動 → 退到全域技術窗口清單（不再是「目前沒有設定聯絡窗口」
// 死路一條，這場什麼都沒設定也還有跨活動的清單可以查）
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'med', media_name: '', note: '', bound_at: Date.now() });
out = await send('媒體邀訪需求');
check('這場活動兩個窗口欄位都沒填 → 退到全域技術窗口清單，不是死路',
  /請問想了解哪個技術領域/.test(out[0]?.text || ''), out[0]?.text);

// ── 情境 13：全域技術窗口分工（跨活動，不需要先綁定，回報的新功能）───────────
// fixture 見 test/fakes.mjs 的 state.contactsDirectory：生醫→丁嘉琳、機械→林潔玲、
// 其他→朱則瑋。

// 還沒綁定任何活動時點「媒體邀訪需求」→ 不再引導先選活動，直接給全域主題選單
reset(); await freshModule();
out = await send('媒體邀訪需求');
check('沒綁定活動時問邀訪需求 → 直接給全域技術主題選單，不再要求先選活動',
  /請問想了解哪個技術領域/.test(out[0]?.text || ''), out[0]?.text);
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('全域選單含活動名稱／技術主題／其他，且不超過 13 顆',
    labels.includes('活動名稱') && labels.includes('生醫') && labels.includes('其他') && labels.length <= 13,
    JSON.stringify(labels));
  const texts = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.text : i));
  check('主題按鈕送出的文字帶「邀訪：」前綴，不會跟記者自己打字問問題撞在一起',
    texts.includes('邀訪：生醫') && texts.includes('最近有哪些活動'), JSON.stringify(texts));
}

// 點主題按鈕（送出「邀訪：生醫」）→ 直接回聯絡資訊，不管有沒有綁定活動
out = await send('邀訪：生醫');
check('點「生醫」主題按鈕 → 直接給生醫所的聯絡窗口',
  /丁嘉琳/.test(out[0]?.text || '') && /03-1111111/.test(out[0]?.text || '') && /lineid_ding/.test(out[0]?.text || ''),
  out[0]?.text);

// 綁定某場活動的情況下，點全域主題按鈕仍然要能查到（不會被當前綁定的活動問答吃掉）
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() }); // semi 沒設定 events!P
out = await send('邀訪：機械');
check('已綁定活動時點主題按鈕，一樣直接查全域窗口，不會被送進當前活動的問答',
  out.length === 1 && /林潔玲/.test(out[0]?.text || ''), JSON.stringify(out));

// 查不到的主題
reset(); await freshModule();
out = await send('邀訪：不存在的主題');
check('主題查不到 → 給明確訊息，不是報錯或空白',
  /目前還沒有設定聯絡窗口/.test(out[0]?.text || ''), out[0]?.text);

// 「其他」→ 提示自由輸入，下一則消費掉這個一次性旗標
reset(); await freshModule();
out = await send('邀訪：其他');
check('點「其他」→ 提示直接打字描述想問的主題', /請直接輸入想了解的技術主題/.test(out[0]?.text || ''), out[0]?.text);

out = await send('我想了解一下貴單位的機械手臂技術');
check('「其他」後自由輸入，句子裡含「機械」→ 寬鬆比對命中機械所',
  /林潔玲/.test(out[0]?.text || ''), out[0]?.text);

out = await send('隨便問一句跟任何主題都不相關的話');
check('「其他」旗標只消費一次——上一則已經用掉了，這則不該再被當成主題自由輸入',
  !/請直接輸入想了解的技術主題|目前沒有抓到明確對應的窗口/.test(out[0]?.text || ''), out[0]?.text);

// 「其他」→ 打的內容完全比對不到任何主題或單位 → 退回綜合聯絡人（朱則瑋）
reset(); await freshModule();
await send('邀訪：其他');
out = await send('這是一個完全查不到對應窗口的奇怪問題內容');
check('「其他」自由輸入比對不到任何主題 → 退回綜合聯絡人（朱則瑋）',
  /目前沒有抓到明確對應的窗口/.test(out[0]?.text || '') && /朱則瑋/.test(out[0]?.text || ''), out[0]?.text);

// 群組裡也要能查到全域技術窗口——跟 1 對 1 共用同一支 handleContactTopicMessage()，
// 這裡只驗證兩邊的 dispatch 有接上，不重複測比對邏輯本身。
reset(); await freshModule();
out = await sendGroup('@我 邀訪：生醫', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡點主題按鈕（@ 到）→ 一樣直接給聯絡窗口',
  out.length === 1 && /丁嘉琳/.test(out[0]?.text || ''), JSON.stringify(out));

// ── 情境 14：媒體邀請函（活動前只給邀請函，不給正式新聞稿／照片）─────────
// fixture 見 test/fakes.mjs 的 'soon'：活動日期是「明天」，knowledge_base 是正式
// 新聞稿，invite_letter 是邀請函文字，兩者刻意不同，才驗證得出來 system prompt
// 裡到底帶的是哪一份。

// 記者（不管有沒有綁定，這裡走自然語言命中）問到這場 → 只看得到邀請函
reset(); await freshModule();
out = await send('奈米材料前瞻應用發表會的重點是什麼');
check('活動前記者提問 → 有正常回答（沒有被卡住）',
  out.some(o => o.kind === 'answer' && o.event === 'soon'), JSON.stringify(out));
{
  const answered = out.find(o => o.kind === 'answer' && o.event === 'soon');
  check('system prompt 帶的是邀請函內容', /邀請函.*誠摯邀請貴媒體蒞臨採訪/.test(answered?.sys || ''), answered?.sys?.slice(0, 200));
  check('system prompt 不含正式新聞稿內容', !/正式新聞稿.*完整技術規格與時程/.test(answered?.sys || ''), answered?.sys?.slice(0, 200));

  // 回報的意見：chips 沒跟著換，記者點原本的「活動內容」問句只會得到「沒有資料」。
  const textReply = out.find(o => o.kind === 'text');
  check('活動前的快速提問按鈕換成 invite_letter_chips，不是原本問活動內容那組',
    textReply?.quickReply?.includes('邀請函內容是什麼？') && textReply?.quickReply?.includes('採訪申請方式？') &&
    !textReply?.quickReply?.includes('這場的技術突破是什麼？'),
    JSON.stringify(textReply?.quickReply));
}

// 職員模式問同一場 → 要看得到真正的新聞稿內容準備活動，不能被自己設的「活動前」卡住
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('奈米材料前瞻應用發表會的重點', 'U_staff');
{
  const answered = out.find(o => o.kind === 'answer' && o.event === 'soon');
  check('職員模式有正常回答', !!answered, JSON.stringify(out));
  check('職員模式看到的是正式新聞稿，不是邀請函（同仁要準備真正的活動內容）',
    /正式新聞稿.*完整技術規格與時程/.test(answered?.sys || ''), answered?.sys?.slice(0, 200));
}

// ── 情境 15：綁定改成預設值——問到別場內容時自動換場並直接回答（批次 7）─────
// 回報的意見：選哪個活動，LINE 就變那場的專屬機器人；換一場活動，記者就再也
// 問不到其他場——因為綁定原本是鎖，不是預設值。現在每則問題都會先過一次跟
// handleUnbound() 同一支 routeIntent()，訊息明確指向別場（confidence high、
// 只指到一場、且不是目前這場）才自動換，其餘維持原場繼續回答。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });

out = await send('智慧醫療解決方案記者會有提到什麼技術突破？');
check('問句明確指向別場 → 自動換場並直接回答那一場，不用先手動切換',
  out[0]?.kind === 'answer' && out[0].event === 'med', JSON.stringify(out));
check('綁定真的換過去了', state.bindings.get('U_reporter')?.event_id === 'med',
  JSON.stringify(state.bindings.get('U_reporter')));
check('回答附上換場提示，記者看得出來這題被切去別場回答',
  /已切換到《智慧醫療解決方案記者會》/.test(out[1]?.text || ''), JSON.stringify(out));
check('換場保留原本的媒體名稱', state.bindings.get('U_reporter')?.media_name === '中央社');

// 換場後接著問，不用再點名活動名稱——已經是新的預設場次，也不會每次都跳提示
out = await send('這場的技術突破是什麼');
check('換場後續問直接沿用新場次，不用重打名稱', out[0]?.kind === 'answer' && out[0].event === 'med', JSON.stringify(out));
check('沿用新場次時不會又跳出換場提示（問句沒有指向別場）', !/已切換到/.test(out[1]?.text || ''), JSON.stringify(out));

// 問不出明確場次線索的問題 → 留在原場，不會亂跳
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('這項技術大概什麼時候可以商業化？');
check('問句沒有指向任何別場的線索 → 留在原場繼續回答，不會誤判亂跳',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));
check('沒有換場，binding 維持原本那場', state.bindings.get('U_reporter')?.event_id === 'quad');

// 群組一樣適用——跟 1:1 同一套邏輯（見 handleGroupMessage() 的說明）
reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('@我 智慧醫療解決方案記者會有什麼技術突破', { mentionSelf: true, mentionText: '@我 ' });
check('群組裡問到別場內容一樣會自動換場', out[0]?.kind === 'answer' && out[0].event === 'med', JSON.stringify(out));
check('群組綁定真的換過去了', state.bindings.get('Cgroup1')?.event_id === 'med');

// ── 情境 16：活動清單要附「媒體邀訪需求」按鈕（回報的意見）─────────────────
// 回報的意見：換場／查活動列表時只列得出活動名稱按鈕，找不到入口問「媒體邀訪
// 需求」——這件事本來就不是針對某一場活動，是跨活動的議題詢問，塞在「先選一場」
// 的清單裡反而選錯位置，記者只能自己打字才問得到。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });

out = await send('換一場活動');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('「換一場活動」的按鈕列最後一格是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
}

out = await send('最近有哪些活動');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('綁定中查「最近有哪些活動」的按鈕列最後一格也是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
}

// 沒綁定時要真的走 handleUnbound() 自己的 'calendar' 分支（跟上面兩個測試不同
// 路徑）——「最近如何」故意不含活動／場次／記者會字樣，過不了 detectMetaIntent()
// 的 CALENDAR_RE，才不會被 handleMetaIntent() 攔走，落到自然語言路由這條路。
reset(); await freshModule();
out = await send('最近如何');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('沒綁定時查活動列表的按鈕列最後一格也是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
}
out = await send('媒體邀訪需求');
check('點下去真的會走全域技術窗口清單，不是被當成活動名稱去問答',
  /請問想了解哪個技術領域/.test(out[0]?.text || ''), out[0]?.text);

// 職員模式自己的活動列表不套用這顆按鈕——「媒體邀訪需求」是講給記者聽的措辭，
// 同仁已經有整套 STAFF_QUICK_REPLIES，多這顆只是用不到的雜訊。
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('最近有哪些活動', 'U_staff');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('職員模式查活動列表不會多出媒體邀訪需求這顆按鈕', !labels.includes('媒體邀訪需求'), JSON.stringify(labels));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 流程測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
