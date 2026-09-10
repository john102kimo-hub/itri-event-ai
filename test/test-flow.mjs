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

// 任意 webhook 事件（join、非文字訊息…）——makeReq／makeGroupReq 都只組得出文字訊息。
function makeRawReq(events) {
  const body = JSON.stringify({ events });
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
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, messages: s.messages, sys: s.sys, sysAll: s.sysAll, question: s.question, msgs: s.msgs }));
}

async function sendRaw(events) {
  sent.length = 0;
  await handler(makeRawReq(events), res);
  return sent.map(x => ({ kind: x.kind, text: x.text, event: x.event, quickReply: x.quickReply, messages: x.messages, sys: x.sys, sysAll: x.sysAll, question: x.question, msgs: x.msgs }));
}

async function sendGroup(text, opts) {
  sent.length = 0;
  await handler(makeGroupReq(text, opts), res);
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, messages: s.messages, sys: s.sys, sysAll: s.sysAll, question: s.question, msgs: s.msgs }));
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

// 回報的意見：這顆按鈕原本叫「換一場活動」，但這個帳號能問的不只活動，已經
// 改名成「回首頁」（見 lib/menu.js REPORTER_MENU 的說明）；「換一場活動」等舊
// 講法仍然有效，見 test-menu.mjs 的 SWITCH_RE 回歸測試。
out = await send('回首頁');
check('「回首頁」→ 解除綁定並列清單',
  out[0]?.kind === 'text' && /已經回到首頁/.test(out[0].text), JSON.stringify(out));
check('回覆也點出產業趨勢／技術這兩個入口，不是只提活動（回報的意見：這裡不是只能問活動）',
  /產業趨勢分析/.test(out[0]?.text || '') && /想問什麼技術/.test(out[0]?.text || ''), out[0]?.text);
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

// 獨立開一個乾淨的群組（不沿用上面已經軟綁定 quad 的 Cgroup1），下面第二步驗證
// 「沒有活動綁定時，按鈕點下去要導向全域邀訪窗口清單」才不會被前面的軟綁定狀態
// 干擾、誤判成剛好命中 quad 自己的聯絡窗口。
reset(); await freshModule();

out = await sendGroup('@我', { mentionSelf: true, mentionText: '@我' });
check('只 @ 沒接問題 → 友善自我介紹，同時帶出「最近活動」與「媒體邀訪需求」兩種可以問的方向，不會噴例外或送空白問題給 AI',
  out[0]?.kind === 'text' && /米亞/.test(out[0].text) && /最近有哪些活動/.test(out[0].text) && /媒體邀訪需求/.test(out[0].text),
  JSON.stringify(out));
check('只 @ 沒接問題也附快速回覆按鈕，記者不用自己打字就能點問（含新增的產業趨勢分析／想問什麼技術）',
  JSON.stringify(out[0]?.quickReply) === JSON.stringify(['最近有哪些活動', '產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']),
  JSON.stringify(out[0]?.quickReply));
check('只 @ 沒接問題也算「有回答」，續問視窗要續命——不然按鈕點下去（沒有 @）會被當成沒被 @ 安靜吃掉，按鈕變成按了沒反應',
  state.bindings.get('Cgroup1')?.groupSessionUntil > Date.now(), JSON.stringify(state.bindings.get('Cgroup1')));

// 只 @ 沒接問題附的按鈕要是真的按得下去——點「媒體邀訪需求」送出的純文字沒有 @，
// 要靠上面剛續命的視窗才能被接住，不是空談；這個群組還沒綁定任何活動，正確結果
// 是全域邀訪窗口清單（見 sendGlobalContactMenu()），不是卡在「找不到活動」。
out = await sendGroup('媒體邀訪需求', { mentionSelf: false });
check('點下「只 @」引導附的按鈕（媒體邀訪需求）→ 續問視窗內接得住、不用重新 @，並正確導向全域邀訪窗口清單',
  out.length > 0 && out[0]?.kind === 'text' && /技術領域/.test(out[0].text), JSON.stringify(out));

// 實際回報的答非所問（附截圖）：群組裡 @ 問「妳能幫我什麼」，因為不含「怎麼／
// 如何」，detectMetaIntent() 舊版的 HELP_ABOUT_BOT_RE 接不住，掉進 routeIntent()
// 被判成 other，回一句跟問題完全對不上的「不確定您想問哪一場活動」——記者問的
// 明明是「你能做什麼」。批次 19 加了 HELP_CAPABILITY_RE／HELP_WHOAMI_RE 接住
// 這類問句，改成回 HELP_TEXT。
reset(); await freshModule();
out = await sendGroup('@我 妳能幫我什麼', { mentionSelf: true, mentionText: '@我 ' });
check('群組 @ 問「妳能幫我什麼」→ 回使用說明，不是答非所問的「不確定您想問哪一場活動」',
  /怎麼使用這個帳號/.test(out[0]?.text || '') && !/不確定/.test(out[0]?.text || ''),
  JSON.stringify(out));

// 沒有 @ 到、單純打字問「妳能幫我什麼」（1 對 1，每則訊息本來就都算在跟我們講話）
// 也要走同一條路，不是群組限定的修法。
reset(); await freshModule();
out = await send('你是誰');
check('1 對 1 問「你是誰」→ 回使用說明，不是答非所問的萬用兜底文案',
  /怎麼使用這個帳號/.test(out[0]?.text || ''), JSON.stringify(out));

// ── 使用說明要「直接在對話裡播影片」，不是丟一條連結（回報，批次 46）──────────
// 回報的原話：「影片現在是跳連結，有可能直接在對話傳或播影片嗎？不會有人特別還會去
// 點連結的」。一條連結把「看」變成一個要主動決定的動作，多數人就滑過去了。
console.log('── 使用說明：影片直接播在對話裡 ──');
reset(); await freshModule();
out = await send('使用說明');
{
  const msgs = out[0]?.messages || [];
  const video = msgs.find(m => m.type === 'video');
  check('第一則就是可以直接播的影片，不是連結', !!video, JSON.stringify(msgs.map(m => m.type)));
  check('影片與封面都是自家站台的 https 直連網址（LINE 只收這種）',
    /^https:\/\/[^\s]+\.mp4$/.test(video?.originalContentUrl || '') &&
    /^https:\/\/[^\s]+\.(jpg|jpeg|png)$/.test(video?.previewImageUrl || ''),
    JSON.stringify(video));
  check('影片後面接著文字說明，不是只有影片', /怎麼使用這個帳號/.test(out[0]?.text || ''), out[0]?.text?.slice(0, 60));
  check('文字那則仍然附著按鈕', (msgs.find(m => m.type === 'text')?.quickReply?.items || []).length > 0,
    JSON.stringify(msgs.find(m => m.type === 'text')?.quickReply));
}

// 迴歸：真的問不出所以然的話，兜底文案還在——不是把安全網拿掉。
// 批次 24 改寫了這段文案：舊版把「猜不出來」一律講成「我沒抓到您想問哪一場活動」，
// 但這個帳號有四條路（活動／產業趨勢／工研院技術／邀訪窗口），活動只是其中一條，
// 記者根本沒在問活動時那句話本身就是答非所問（見情境 19 的回報截圖）。新版不預設
// 記者一定是在問活動，四條路一次講清楚。
//
// 批次 28 又改了一次：那份固定清單本身就是「答非所問」的另一種形式——記者問的是
// 一句具體的話，收到的卻是把說明書再念一次。現在先讓米亞針對「這一句」講一段貼題
// 的話（composeFallbackReply()），組不出來才退回固定清單。入口按鈕兩條路都照舊。
reset(); await freshModule();
out = await send('隨便問一句跟任何主題都不相關的話');
check('真的判不出意圖 → 走智慧兜底，針對記者那一句回話，不是把功能選單再貼一次',
  out.some(o => o.kind === 'fallback') &&
  out.at(-1)?.kind === 'text' && /這題我這邊查不到/.test(out.at(-1).text) &&
  !/沒抓到您想問哪一場活動/.test(out.at(-1).text), JSON.stringify(out));
check('智慧兜底拿到的是記者的原話，不是按鈕文字或空字串',
  out.find(o => o.kind === 'fallback')?.question === '隨便問一句跟任何主題都不相關的話',
  JSON.stringify(out.find(o => o.kind === 'fallback')?.question));
check('智慧兜底的 system prompt 明確禁止生成事實內容（這條是它敢上線的前提）',
  /不要提供任何事實內容/.test(out.find(o => o.kind === 'fallback')?.sys || ''),
  (out.find(o => o.kind === 'fallback')?.sys || '').slice(0, 120));
check('智慧兜底照樣附上四條路的入口按鈕，記者不用自己打字',
  JSON.stringify(out.at(-1)?.quickReply) === JSON.stringify(['最近有哪些活動', '產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']),
  JSON.stringify(out.at(-1)?.quickReply));

// 輸出守門：模型講太多、或吐回來的其實是 askAnthropic() 自己的失敗訊息時，一律退回
// 固定文案——那份永遠不會講錯話，是這條路徑的安全底線（見 composeFallbackReply()）。
// 批次 32 起「混進 Markdown」不再需要退回固定文案——askAnthropic() 的出口會統一把
// Markdown 清乾淨（見 stripMarkdownForLine()），清完的內容本身是好的，沒有理由丟掉。
for (const [label, bad] of [
  ['太長', '很長的回答'.repeat(80)],
  ['其實是 API 失敗訊息', '抱歉，目前無法取得回應，請稍後再試。']
]) {
  reset(); await freshModule();
  state.fallbackReply = bad;
  out = await send('隨便問一句跟任何主題都不相關的話');
  check(`智慧兜底輸出${label} → 退回固定兜底文案，四條路都講到，不會把壞輸出丟給記者`,
    out.at(-1)?.kind === 'text' && /不太確定該從哪邊幫您找答案/.test(out.at(-1).text) &&
    ['活動名稱', '產業趨勢', '工研院', '媒體邀訪需求'].every(x => out.at(-1).text.includes(x)),
    JSON.stringify(out.at(-1)));
}
state.fallbackReply = null;

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

// 回報的意見：批次 14 的「@ 別人」否決只擋得住訊號很強的那個子集，續問視窗內
// 一般的純聊天（例如回報案例「友信你覺得呢」，沒有 @ 任何人）當時還是會被硬答
// 一段答非所問的內容。批次 16 給 routeIntent() 加上 currentEventId 提示，讓它
// 分得出「延續目前這場」跟「真的無關」，other 才能放心拿來當安靜門檻。
console.log('── 續問視窗：訊息跟目前這場活動無關（沒有 @ 別人）→ 也要安靜 ──');
{
  const before = Date.now() + 60000;
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: before });
  out = await sendGroup('友信你覺得呢', { mentionSelf: false });
  check('續問視窗內、訊息跟目前這場活動及所有場次都無關 → 安靜，不會硬答一段答非所問的內容',
    out.length === 0, JSON.stringify(out));
  check('沒有因為這則亂回而幫續問視窗續命（groupSessionUntil 沒被延長）',
    state.bindings.get('Cgroup1')?.groupSessionUntil === before, String(state.bindings.get('Cgroup1')?.groupSessionUntil));
}

// 同一句話真的被 @ 到時完全不受影響——明確叫了機器人就不能不理人，跟批次 14
// 的原則一致，這裡用目前綁定的場次回答。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('友信你覺得呢');
check('1 對 1 完全不受影響——每則訊息本來就都算在跟我們講話，照樣用目前這場回答',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

// 迴歸驗證：合法的續問（依賴上一句才聽得懂，見情境 9 第三步）不能被連帶擋掉——
// 這正是批次 14 曾經考慮、後來否決「直接用 intent==='other' 當門檻」的原因。
reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('那合作廠商有哪些', { mentionSelf: false });
check('加了 currentEventId 提示之後，續問視窗內的合法續問依然正常回答，沒有被連帶擋掉',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

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
// 批次 32 起「活動全名」是我們自己送出的按鈕文字，視窗外也接得住（見
// isOwnButtonText()），所以這裡改用一句真的不是按鈕的訊息來驗「視窗過期＝不回應」。
out = await sendGroup('我等等把資料寄給你', { mentionSelf: false });
check('視窗過期後，沒 @ 的一般訊息又變回完全不回應', out.length === 0, JSON.stringify(out));

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

// 群組問答也要附 chips——但群組沒有圖文選單，同一排還要背負「導覽」的責任（批次 40）
reset(); await freshModule();
out = await sendGroup('@我 四足機器人記者會的重點', { mentionSelf: true, mentionText: '@我 ' });
{
  const texts = (out[1]?.quickReply || []).map(i => (typeof i === 'object' ? i.text : i));
  check('群組問答一樣附得到同仁自訂的 chips', texts.includes('重點') && texts.includes('應用'), JSON.stringify(out[1]?.quickReply));
}

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

out = await send('回首頁'); // 按鈕已改名，見情境 1 的說明
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  // 批次 29 起這排不再只有「活動＋媒體邀訪需求」，而是活動之後固定接上四條路的入口
  // （回報的截圖：正式站只有一場有資料的活動時，整排只剩兩顆，看起來很空，而且另外
  // 兩條路從來沒出現在這裡）。驗的是「四條路都在、順序固定」，不是「某一顆在最後」。
  check('「回首頁」的按鈕列在活動之後固定接上四條路的入口',
    JSON.stringify(labels.slice(-4)) === JSON.stringify(['產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']), JSON.stringify(labels));
  // 回報的意見：按鈕不夠明顯，容易被忽略——文字裡也要有這個入口，不能只靠按鈕。
  check('「回首頁」的文字裡也提到媒體邀訪需求（不只靠按鈕）',
    /媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}

out = await send('最近有哪些活動');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('綁定中查「最近有哪些活動」的按鈕列也一樣固定接上四條路的入口',
    JSON.stringify(labels.slice(-4)) === JSON.stringify(['產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']), JSON.stringify(labels));
  check('綁定中查活動列表的文字裡也提到媒體邀訪需求', /媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}

// 沒綁定時要真的走 handleUnbound() 自己的 'calendar' 分支（跟上面兩個測試不同
// 路徑）——「最近如何」故意不含活動／場次／記者會字樣，過不了 detectMetaIntent()
// 的 CALENDAR_RE，才不會被 handleMetaIntent() 攔走，落到自然語言路由這條路。
reset(); await freshModule();
out = await send('最近如何');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('沒綁定時查活動列表的按鈕列也一樣固定接上四條路的入口',
    JSON.stringify(labels.slice(-4)) === JSON.stringify(['產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']), JSON.stringify(labels));
  check('沒綁定時查活動列表的文字裡也提到媒體邀訪需求', /媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}
out = await send('媒體邀訪需求');
check('點下去真的會走全域技術窗口清單，不是被當成活動名稱去問答',
  /請問想了解哪個技術領域/.test(out[0]?.text || ''), out[0]?.text);

// 職員模式自己的活動列表不套用這顆按鈕、也不套用文字提示——「媒體邀訪需求」是
// 講給記者聽的措辭，同仁已經有整套 STAFF_QUICK_REPLIES，多這些只是用不到的雜訊。
reset(); await freshModule();
state.staff.push(['U_staff', '', '2026-08-27', '', '']);
out = await send('最近有哪些活動', 'U_staff');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('職員模式查活動列表不會多出媒體邀訪需求這顆按鈕', !labels.includes('媒體邀訪需求'), JSON.stringify(labels));
  check('職員模式查活動列表的文字裡也不會多出媒體邀訪需求', !/媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}

// ── 情境 17：產業趨勢問答（批次 20，資料來源見 lib/industry-trends.js）───────
// 記者問的不是某一場記者會的內容，是整體產業趨勢／市場現況（例如「半導體最近
// 有什麼趨勢」）——routeIntent() 判成 industry_trend，答案用 IEK 產業情報網
// 免費焦點清單（只有標題／日期／約 100 字摘要，不是完整報告），結尾一律附上
// 「產業趨勢分析」這個既有全域窗口（見 lib/contacts-directory.js），不管有沒有
// 綁定活動、1 對 1 還是群組都答得到。

reset(); await freshModule();
out = await send('半導體現在有什麼趨勢');
check('沒綁定、1 對 1 問產業趨勢 → 走 industry_trend，不是掉進「不確定您想問哪一場活動」',
  out.length > 0 && !/沒抓到您想問哪一場活動/.test(out.map(o => o.text).join('')), JSON.stringify(out));
check('system prompt 裡帶了 IEK 清單的標題與摘要，不是空氣',
  out.some(o => o.sys?.includes('半導體先進封裝供需展望') && o.sys?.includes('先進封裝需求持續攀升')),
  JSON.stringify(out.map(o => o.sys?.slice(0, 50))));
check('最終回覆附上警語＋公關窗口聯絡資訊，用使用者要求的措辭（僅供參考，正式媒體報導引用請聯繫 公關窗口）',
  out.some(o => o.kind === 'text' && /僅供參考，正式媒體報導引用請聯繫 公關窗口 朱則瑋/.test(o.text) && /0934-266-766/.test(o.text)),
  JSON.stringify(out));
// 批次 24：按鈕列最前面多一顆「跨到另一條路」的入口——IEK 免費焦點只有十來則，
// 覆蓋不到記者問的領域是常態，「這裡沒有，可以改從工研院自己的技術報導找」本來就
// 該是預設出口，而不是讓記者自己猜下一步要打什麼（見情境 19 的回報截圖）。
check('最終回覆附快速回覆按鈕（跨路入口／活動列表／媒體邀訪需求），不是只丟一句話就結束',
  out.some(o => o.kind === 'text' && JSON.stringify(o.quickReply) === JSON.stringify([
    { label: '工研院的半導體技術', text: '工研院 半導體' }, '最近有哪些活動', '媒體邀訪需求'
  ])),
  JSON.stringify(out));

// 實際回報的問題：點「產業趨勢分析」這顆按鈕，AI 沒有直接摘要最新幾則，反而列了
// 一串範例主題反問「請問您想了解哪個產業或技術領域」——跟打「半導體現在有什麼
// 趨勢」這種明確請求句拿到的乾淨摘要體驗不一致。根因是 handleMetaIntent() 原本把
// 按鈕送出的原始文字（例如「產業趨勢分析」這種比較像分類標籤、不像一句請求的
// 名詞短語）直接當「記者的問題」丟給 AI。修法是四個固定觸發詞一律換成一句明確
// 的請求句——這裡驗證的就是「呼叫端送給 AI 的是這句固定請求句，不是按鈕原始
// 文字」，不是驗證真的 LLM 會不會反問（那要看真的跑，這支測試模擬不了）。
for (const trigger of ['產業趨勢分析', '產業趨勢', '最近趨勢', '最新趨勢']) {
  reset(); await freshModule();
  out = await send(trigger);
  check(`按鈕／固定觸發詞「${trigger}」→ 送給 AI 的是固定的明確請求句，不是按鈕原始文字`,
    out.some(o => o.kind === 'answer' && o.question === '最近有哪些產業趨勢重點'),
    JSON.stringify(out.map(o => ({ kind: o.kind, question: o.question }))));
}

reset(); await freshModule();
out = await sendGroup('@我 AI晶片產業現況如何', { mentionSelf: true, mentionText: '@我 ' });
check('群組 @ 問產業趨勢 → 一樣答得到',
  out.some(o => o.kind === 'text' && /朱則瑋/.test(o.text)), JSON.stringify(out));

// 後台「邀訪窗口分工」還沒填「產業趨勢分析」這個主題的電話（或整個主題都還沒建）
// 時，要退回使用者確認過的預設號碼，讓功能一上線就能用，不用等同仁先去後台補
// 資料；一旦後台補上了任一欄，上面的情境已經證明會改用後台那組，這裡只測「完全
// 沒有」的那條退路。
reset(); await freshModule();
state.contactsDirectory = ['生醫｜生醫所｜丁嘉琳｜03-1111111｜lineid_ding｜智慧醫療、醫材相關技術'].join('\n');
out = await send('半導體現在有什麼趨勢');
check('後台完全沒設定「產業趨勢分析」窗口時，退回程式內建的預設聯絡人與電話',
  out.some(o => o.kind === 'text' && /僅供參考，正式媒體報導引用請聯繫 公關窗口 朱則瑋　📞 0934-267-766/.test(o.text)),
  JSON.stringify(out));

// 已經綁定某場活動時問產業趨勢題——不該被硬塞進當前活動的問答（那場的知識庫
// 跟半導體產業趨勢無關，AI 只會說「這部分我沒有資料」），也不該打亂原本的
// 活動綁定：這題答完，下一題沒有新線索的話還是回到原本那場。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('半導體現在有什麼趨勢');
check('1 對 1 綁定中問產業趨勢 → 不會被塞進目前綁定活動（quad）的問答',
  !out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out));
check('1 對 1 綁定中問產業趨勢 → 正確答上（附聯絡窗口），不是答非所問',
  out.some(o => o.kind === 'text' && /朱則瑋/.test(o.text)), JSON.stringify(out));
out = await send('這場的重點是什麼'); // 沒有新線索，應該還在原本那場
check('答完產業趨勢題，活動綁定沒有被打亂，下一題還是原本那場',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

// 群組續問視窗內（沒有再 @）問產業趨勢——這是明確可回答的意圖，不是「猜不出來」，
// 不該被 silentOnOther 那道安靜門檻擋掉，而且答完要幫續問視窗續命。
reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('市場現況怎麼樣', { mentionSelf: false });
check('群組續問視窗內（沒 @）問產業趨勢 → 照樣答得到，不會被安靜擋掉',
  out.some(o => o.kind === 'text' && /朱則瑋/.test(o.text)), JSON.stringify(out));
check('答完產業趨勢題續問視窗有續命',
  state.bindings.get('Cgroup1')?.groupSessionUntil > Date.now(), JSON.stringify(state.bindings.get('Cgroup1')));

// IEK 網站抓不到資料（網路問題／網站改版）——誠實告知，不能整支掛掉或裝死。
reset(); await freshModule();
state.iekFetchFail = true;
out = await send('半導體現在有什麼趨勢');
check('IEK 抓取失敗時誠實告知抓不到資料，不會噴例外讓記者什麼都收不到',
  out.length > 0 && out[0]?.kind === 'text' && /暫時抓不到最新的產業趨勢資料/.test(out[0].text), JSON.stringify(out));
check('抓取失敗時一樣附上聯絡窗口，不是單純說一句抓不到就結束',
  /朱則瑋/.test(out[0]?.text || ''), out[0]?.text);
check('抓取失敗時沒有呼叫 Anthropic 硬答（沒有 answer 這個 kind）',
  !out.some(o => o.kind === 'answer'), JSON.stringify(out));

// ── 情境 18：想問什麼技術（回報的新功能，資料來源見 lib/itri-news.js）───────
// 記者想直接問工研院自己在某項技術上的研發成果，不是在問某一場記者會、也不是在問
// 整體產業趨勢（那是 industry_trend／情境 17 的事）——資料來源是工研院官網新聞
// 中心，用記者給的技術名稱當關鍵字去查。跟產業趨勢問答不同，這裡不能直接答：
// 「想問什麼技術」按鈕本身不是技術名稱，要先問一次、等記者打了名稱才真的去查
// （見 handleTechQueryMessage() 的說明）。

reset(); await freshModule();
out = await send('想問什麼技術');
check('1 對 1 按「想問什麼技術」→ 先問想了解哪一項技術，不會直接硬答',
  out.length === 1 && out[0]?.kind === 'text' && /想了解工研院哪一項技術/.test(out[0].text),
  JSON.stringify(out));

out = await send('機器人');
check('接著打技術名稱 → 真的去查工研院官網新聞（不是被當成一般提問吃掉）',
  !out.some(o => o.kind === 'answer' && o.event !== 'unknown'), JSON.stringify(out));
check('system prompt 帶了工研院官網新聞中心查到的標題與摘要，不是空氣',
  out.some(o => o.sys?.includes('工研院攜AMRA打造足型機器人新標準') && o.sys?.includes('機器人應用落地的最大課題')),
  JSON.stringify(out.map(o => o.sys?.slice(0, 60))));
check('最終回覆比對到「機器人」這個技術領域的專屬窗口（不是只給一句「請洽媒體邀訪窗口」）',
  out.some(o => o.kind === 'text' && /譚宇哲/.test(o.text) && /03-3333333/.test(o.text)),
  JSON.stringify(out));

// 實際回報（附截圖）：按鈕引導流程問「請問您想了解工研院哪一項技術呢？」之後，
// 記者不是照範例打單一技術名稱，而是打一整句「最近的國際合作」——這條路徑不經過
// routeIntent()，下面「工研院半導體有什麼新聞嗎」那段（PR #32）的關鍵字抽取只補
// 了自然語言那條路，按鈕流程當時沒補到。實測過真的官網：「最近的國際合作」查 0
// 筆，去掉語助詞的「國際合作」查得到——用 itriKeywordMustInclude 模擬這個真實
// 落差，驗證 fetchItriNews() 查無資料時真的會去語助詞重試一次，不用逼呼叫端自己
// 保證是乾淨關鍵字，見 lib/itri-news.js fetchItriNews() 的說明。
reset(); await freshModule();
state.itriKeywordMustInclude = '國際合作';
await send('想問什麼技術');
out = await send('最近的國際合作');
check('按鈕引導流程回一整句（含語助詞）→ 去語助詞重試後查得到，不會誤報查無資料',
  !out.some(o => o.kind === 'text' && /沒有找到跟/.test(o.text)), JSON.stringify(out));
check('重試查到的清單真的餵給 AI，不是空氣',
  out.some(o => o.sys?.includes('工研院攜AMRA打造足型機器人新標準')),
  JSON.stringify(out.map(o => o.sys?.slice(0, 60))));

// 群組：按鈕在續問視窗內一樣接得住，不用重新 @——跟「邀訪：其他」自由輸入同一套
// 一次性旗標機制（見 handleTechQueryMessage() 的說明）。
reset(); await freshModule();
await sendGroup('@我 想問什麼技術', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('機器人', { mentionSelf: false });
check('群組續問視窗內（沒 @）打技術名稱 → 照樣答得到，不會被安靜擋掉',
  out.some(o => o.kind === 'text' && /譚宇哲/.test(o.text)), JSON.stringify(out));

// 實際回報（附截圖）：群組裡 @ 問「媒體邀訪需求」→ 點「邀訪：產業趨勢分析」拿到
// 窗口聯絡人之後，接著（沒有再 @）打「技術呢」想換個主題繼續問，完全沒有反應，
// 體感是「卡住了，無法持續聊」——跟批次 19「你能做啥」同一種落空：這句話沒對到
// 任何規則，掉進 routeIntent() 判成 other，續問視窗內沒被 @ 到時 other 是安靜門檻。
// 補進 TECH_QUERY_EXACT_RE 之後，「技術呢」會被 detectMetaIntent() 直接認出來，
// 不會走到 routeIntent() 那一步，也就不會被安靜擋掉。
reset(); await freshModule();
await sendGroup('@我 媒體邀訪需求', { mentionSelf: true, mentionText: '@我 ' });
await sendGroup('邀訪：產業趨勢分析', { mentionSelf: false });
out = await sendGroup('技術呢', { mentionSelf: false });
check('群組續問視窗內（沒 @）打「技術呢」→ 先問想了解哪一項技術，不會被安靜擋掉',
  out.length === 1 && out[0]?.kind === 'text' && /想了解工研院哪一項技術/.test(out[0]?.text || ''),
  JSON.stringify(out));

// 自然語言直接問（不用先按按鈕）：問句裡明確提到「工研院」，routeIntent() 判成
// tech_query（見 lib/router.js 的說明），不用先問一次要查什麼。
reset(); await freshModule();
out = await send('工研院在機器人技術上有什麼進展');
check('1 對 1 自然語言直接問「工研院在ＸＸ技術上」→ 不用先問一次，直接答',
  out.some(o => o.kind === 'text' && /譚宇哲/.test(o.text)), JSON.stringify(out));

// 實際回報的落空：問「工研院半導體有什麼新聞嗎」，整句原話（含「有什麼」「嗎」
// 這類語助詞）拿去查工研院官網的關鍵字搜尋查到 0 筆——實測過真的網站，那邊接近
// 精準比對，只有抽出來的核心關鍵字（例如「半導體」）查得到。修法：routeIntent()
// 判成 tech_query 時順手抽一個關鍵字，answerTechQuery() 優先用這個關鍵字，不是
// 整句原話（見 lib/router.js、api/line.js 的說明）。這裡驗證的是「呼叫端真的用了
// 抽出來的關鍵字」，不是驗證真的 LLM 抽詞抽得多準（那要看真的跑）。
reset(); await freshModule();
out = await send('工研院半導體有什麼新聞嗎');
check('自然語言問句帶語助詞 → 送去查／送給 AI 回答的是抽出來的關鍵字，不是整句原話',
  out.some(o => o.kind === 'answer' && o.question === '半導體'),
  JSON.stringify(out.map(o => ({ kind: o.kind, question: o.question }))));

// 已經綁定某場活動時自然語言問技術題——不該被硬塞進當前活動的問答（那場的知識庫
// 跟機器人技術無關），也不該打亂原本的活動綁定，跟情境 17 產業趨勢那段同一個道理。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('工研院在機器人技術上有什麼進展');
check('1 對 1 綁定中問工研院技術 → 不會被塞進目前綁定活動（quad）的問答',
  !out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out));
out = await send('這場的重點是什麼'); // 沒有新線索，應該還在原本那場
check('答完技術題，活動綁定沒有被打亂，下一題還是原本那場',
  out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));

// 查無資料是正常結果（工研院官網不是每個技術都報導過，或記者打的詞比較冷門）——
// 要老實說查不到，不是網站壞了，也不能硬答或裝死。
reset(); await freshModule();
state.itriHtml = '';
await send('想問什麼技術');
out = await send('這個技術官網完全沒報導過');
check('查無資料時老實說查不到，不會硬答或裝死',
  out.length === 1 && out[0]?.kind === 'text' && /沒有找到跟「這個技術官網完全沒報導過」直接相關的報導/.test(out[0].text),
  JSON.stringify(out));
check('查無資料時沒有呼叫 Anthropic 硬答（跟「抓取失敗」不同，查無資料不需要問 AI）',
  !out.some(o => o.kind === 'answer'), JSON.stringify(out));

// 工研院官網抓不到資料（網路問題／網站改版）——誠實告知，不能整支掛掉或裝死，
// 跟情境 17 IEK 抓取失敗那段同一個原則。
reset(); await freshModule();
state.itriFetchFail = true;
await send('想問什麼技術');
out = await send('機器人');
check('抓取失敗時誠實告知抓不到資料，不會噴例外讓記者什麼都收不到',
  out.length > 0 && out[0]?.kind === 'text' && /暫時抓不到工研院官網的最新資料/.test(out[0].text), JSON.stringify(out));
check('抓取失敗時沒有呼叫 Anthropic 硬答',
  !out.some(o => o.kind === 'answer'), JSON.stringify(out));

// ── 情境 19：問完產業趨勢之後的追問（實際回報的截圖，批次 24）─────────────────
// 記者問產業趨勢 → 拿到 IEK 免費焦點的摘要（回覆結尾還主動寫著「有更具體的技術
// 領域，如衛星通訊、太空科技等，歡迎再提問」）→ 照著打了「太空」兩個字 → 收到
// 「嗯～我沒抓到您想問哪一場活動耶 🤔」。他從頭到尾沒有在問活動，這句兜底本身就是
// 答非所問，而且是我們自己邀請他再問一次的。
//
// 修法有兩層，兩層都不依賴對方（見 api/line.js getRecentTopic()／sendFallbackGuide()）：
//   ① 話題記憶：答完趨勢／技術題把話題記進 line_users H 欄，下一則的 routeIntent()
//      多拿到一個「上一則剛回答完什麼」的提示，裸名詞才接得回同一個話題
//   ② 兜底文案：即使話題記憶過期或不存在，也不再假設記者一定是在問活動——看起來
//      像主題詞的訊息直接複誦回去，給兩條真的走得通的路

reset(); await freshModule();
await send('半導體現在有什麼趨勢');
check('答完產業趨勢題 → 話題記進 line_users H 欄（下一則才接得回來）',
  /^industry_trend@\d+$/.test(state.bindings.get('U_reporter')?.lastTopic || ''),
  JSON.stringify(state.bindings.get('U_reporter')));

out = await send('太空');
check('回報的截圖案例：問完趨勢再打一個裸名詞「太空」→ 不會掉進「沒抓到您想問哪一場活動」',
  !/沒抓到您想問哪一場活動/.test(out.map(o => o.text).join('')), JSON.stringify(out));
check('「太空」被接回產業趨勢那條路（送給 AI 的就是這個詞，不是被當成活動名稱）',
  out.some(o => o.kind === 'answer' && o.question === '太空' && o.sys?.includes('IEK 產業情報網')),
  JSON.stringify(out.map(o => ({ kind: o.kind, question: o.question }))));
check('接回趨勢話題後，回覆一樣附上跨到「工研院技術」那條路的按鈕',
  out.some(o => o.kind === 'text' && JSON.stringify(o.quickReply?.[0]) === JSON.stringify({ label: '工研院的太空技術', text: '工研院 太空' })),
  JSON.stringify(out));

// 技術題那條路對稱：答完之後只打一個技術名詞，一樣要接得回來（不用再打一次
// 「工研院」三個字，記者不會知道那個字是路由的關鍵）。
reset(); await freshModule();
await send('工研院在機器人技術上有什麼進展');
check('答完工研院技術題 → 話題記進 H 欄',
  /^tech_query@\d+$/.test(state.bindings.get('U_reporter')?.lastTopic || ''),
  JSON.stringify(state.bindings.get('U_reporter')));
out = await send('光通訊');
check('問完技術題再打一個裸技術名詞 → 接回工研院技術那條路，不用重打「工研院」',
  out.some(o => o.kind === 'answer' && o.sys?.includes('工研院官網新聞中心 搜尋「光通訊」')),
  JSON.stringify(out.map(o => ({ kind: o.kind, question: o.question }))));

// 綁定中一樣要接得回來：趨勢題不動活動綁定（情境 17 已經驗過），所以下一則裸名詞
// 會同時看到「currentEventId=quad」跟「上一則在聊趨勢」兩個提示——不處理的話會被
// 前者硬拉回那場活動的問答，記者拿到那場的 AI 說「這部分我沒有資料」，只是換一種
// 形式的答非所問。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
await send('半導體現在有什麼趨勢');
out = await send('太空');
check('綁定中問完趨勢、再打裸名詞 → 接回趨勢，不會被硬塞進目前綁定活動（quad）的問答',
  !out.some(o => o.kind === 'answer' && o.event === 'quad') &&
  out.some(o => o.kind === 'answer' && o.sys?.includes('IEK 產業情報網')),
  JSON.stringify(out.map(o => ({ kind: o.kind, event: o.event }))));

// 第二層（不依賴話題記憶）：完全沒有前文、一進來就打一個主題詞——複誦回去給兩條
// 真的走得通的路，不要叫記者自己猜，也不要硬猜一條路答下去（猜錯就是另一種問A答B）。
reset(); await freshModule();
out = await send('太空');
check('沒有任何前文、直接打一個主題詞 → 複誦回去問「趨勢還是工研院技術」，不是丟一句沒抓到',
  out[0]?.kind === 'text' && /「太空」/.test(out[0].text) && !/沒抓到您想問哪一場活動/.test(out[0].text),
  JSON.stringify(out));
check('兩條路各給一顆按鈕，按下去送出的文字真的路由得到（趨勢／工研院技術）',
  JSON.stringify(out[0]?.quickReply?.slice(0, 2)) === JSON.stringify([
    { label: '太空的產業趨勢', text: '太空產業趨勢' },
    { label: '工研院的太空技術', text: '工研院 太空' }
  ]), JSON.stringify(out[0]?.quickReply));
check('沒有硬猜一條路直接呼叫 AI 答下去（沒有 answer 這個 kind）',
  !out.some(o => o.kind === 'answer'), JSON.stringify(out));

// 按鈕真的按得動——複誦那則給的兩顆按鈕送出的文字，要真的分別走到兩條路。
out = await send('太空產業趨勢');
check('按「太空的產業趨勢」→ 真的走到產業趨勢那條路',
  out.some(o => o.kind === 'answer' && o.sys?.includes('IEK 產業情報網')), JSON.stringify(out.map(o => o.kind)));
reset(); await freshModule();
out = await send('工研院 太空');
check('按「工研院的太空技術」→ 真的走到工研院技術那條路，關鍵字是「太空」',
  out.some(o => o.kind === 'answer' && o.sys?.includes('工研院官網新聞中心 搜尋「太空」')),
  JSON.stringify(out.map(o => o.kind)));

// 招呼語不能被當成主題詞複誦回去——「『你好』這個題目我可以從兩個方向幫您找」
// 比不複誦難看得多，見 api/line.js looksLikeBareTopic() 的說明。
for (const greeting of ['你好', '謝謝', '哈哈', 'ok']) {
  reset(); await freshModule();
  out = await send(greeting);
  // 批次 28 起兜底那一則可能是智慧兜底生成的（見情境 8），驗的是「沒被複誦成主題詞」
  // 這個不變量，不是某一段固定文案。
  check(`招呼語「${greeting}」不會被當成主題詞複誦`,
    out.at(-1)?.kind === 'text' && !out.at(-1).text.includes(`「${greeting}」我可以從兩個方向`),
    JSON.stringify(out));
}

// 「回首頁」是記者明確說「這一輪聊完了」——話題記憶要一起清掉，不然回首頁之後
// 打的第一個詞會被接回舊話題（見 api/line.js clearBinding() 的說明）。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
await send('半導體現在有什麼趨勢');
await send('回首頁');
check('「回首頁」把話題記憶一起清掉',
  !state.bindings.get('U_reporter')?.lastTopic, JSON.stringify(state.bindings.get('U_reporter')));
out = await send('太空');
check('回首頁之後打主題詞 → 走複誦那條路（話題已清），不是接回舊話題',
  out[0]?.kind === 'text' && /「太空」/.test(out[0].text), JSON.stringify(out));

// 群組：續問視窗內（沒有再 @）打裸名詞，一樣要接得回上一輪的話題。這是最容易被
// 誤擋的組合——群組沒被 @ 到時 other 是安靜門檻（silentOnOther），接不回話題的話
// 記者連一句回覆都收不到，體感是「卡住了」（跟批次 21「技術呢」那次同一種病）。
reset(); await freshModule();
await sendGroup('@我 半導體現在有什麼趨勢', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('太空', { mentionSelf: false });
check('群組續問視窗內打裸名詞 → 接回趨勢話題，不會被安靜門檻擋掉',
  out.some(o => o.kind === 'answer' && o.sys?.includes('IEK 產業情報網')), JSON.stringify(out.map(o => o.kind)));

// ── 情境 20：閒聊短問句被當成主題詞複誦（實際回報的截圖，批次 27）─────────────
// 記者打「天氣如何」→ 收到「『天氣如何』我可以從兩個方向幫您找 🙂」，底下還掛著
// 「天氣如何的產業趨勢」「工研院的天氣如何技術」兩顆按鈕。情境 19 的複誦本身是對的
// （記者打「太空」時很有用），漏的是守門：原本只有一份寫死的招呼語名單，擋得住
// 「你好」，擋不住任何一句**沒有標點的短問句**。而且那兩顆按鈕不只是文案難看，
// 按下去真的會把「天氣如何產業趨勢」送出去查。
// 見 api/line.js looksLikeBareTopic()／SENTENCE_RE 的說明。
for (const chat of ['天氣如何', '吃飽沒', '現在幾點', '怎麼辦', '要不要', '股票怎樣', '午餐吃什麼', '你在幹嘛']) {
  reset(); await freshModule();
  out = await send(chat);
  // 批次 28 起這條路先走智慧兜底（見情境 8），所以驗的是「沒有被複誦成主題詞」這個
  // 不變量，不是某一段固定文案——複誦那條路的兩顆按鈕才是當初真正難看的地方。
  check(`閒聊短問句「${chat}」不會被當成主題詞複誦`,
    out.at(-1)?.kind === 'text' && !out.at(-1).text.includes(`「${chat}」我可以從兩個方向`),
    JSON.stringify(out));
  check(`閒聊短問句「${chat}」不會生出「${chat}的產業趨勢」這種按了只會查到亂碼的按鈕`,
    !JSON.stringify(out.at(-1)?.quickReply || []).includes(chat), JSON.stringify(out.at(-1)?.quickReply));
}

// 守門收緊之後，真的主題詞還是要複誦得到——那才是情境 19 那條路存在的理由。
// 「能源」「太陽能」這種**含有疑問句常用字**（能）的題目刻意放進來：SENTENCE_RE
// 只收多字組合（能不能／幾點），不收單字的「能」「幾」，就是為了不誤傷這些真的
// 會被問到的題目。
for (const topic of ['太空', '光通訊', '能源', '太陽能', '量子電腦']) {
  reset(); await freshModule();
  out = await send(topic);
  check(`主題詞「${topic}」照舊複誦回去，兩顆按鈕也照舊`,
    out[0]?.kind === 'text' && out[0].text.includes(`「${topic}」`) &&
    JSON.stringify(out[0]?.quickReply?.slice(0, 2)) === JSON.stringify([
      { label: `${topic}的產業趨勢`, text: `${topic}產業趨勢` },
      { label: `工研院的${topic}技術`, text: `工研院 ${topic}` }
    ]), JSON.stringify(out));
}

// 純表情／顏文字也不該被複誦。第一道門檻改成「只由中文字與英數組成」的白名單之後
// 這種輸入連進都進不來（原本的 `[^\s]{2,8}` 會放行，只擋了幾個列舉的標點）。
for (const junk of ['😀😀', '^_^', 'ＸＤ']) {
  reset(); await freshModule();
  out = await send(junk);
  check(`表情／符號「${junk}」不會被當成主題詞複誦`,
    out.at(-1)?.kind === 'text' && !out.at(-1).text.includes(`「${junk}」我可以從兩個方向`),
    JSON.stringify(out));
}

// 回報的截圖（批次 29）：按鈕列只有孤零零兩顆，看起來很空——原因是這排只列「有資料
// 的活動」，正式站當下只有一場符合，而另外兩條路（產業趨勢、工研院技術）從來沒被放
// 進這排。加上四條路的入口之後，要確認沒有撞到 LINE quick reply 的 13 顆硬上限：
// 撞到的話 buildQuickReply() 會從尾巴截掉，被截掉的正好是新加的固定入口，等於白加。
reset(); await freshModule();
out = await send('最近有哪些活動');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('活動清單的按鈕總數沒有超過 LINE 的 13 顆上限', labels.length <= 13, `${labels.length} 顆：${JSON.stringify(labels)}`);
  check('四條路的入口真的都在（不是被上限截掉）',
    ['產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明'].every(x => labels.includes(x)), JSON.stringify(labels));
}

// ── 情境 21：被拉進群組（join 事件）＋ 群組續問視窗的守門（批次 28）─────────────
// 回報的意見：「被拉進群組時也能回答，回答時不要答非所問，而且不會亂回」。
// 這個情境分三段驗：被拉進去那一刻要講話、視窗內不該接的別接、該接的不能被誤擋。

console.log('── join：被拉進群組時要自我介紹，並先把「只有被 @ 才說話」的規矩講清楚 ──');
reset(); await freshModule();
out = await sendRaw([{ type: 'join', replyToken: 'rt_join', source: { type: 'group', groupId: 'Cgroup1' } }]);
check('被拉進群組 → 有自我介紹（批次 28 之前完全不出聲，被拉進去像個壞掉的帳號）',
  out[0]?.kind === 'text' && /米亞/.test(out[0].text), JSON.stringify(out));
check('自我介紹第一件事就是講規矩：只有被叫到才會說話，不會插話也不會推播',
  /只有被叫到的時候才會說話/.test(out[0]?.text || '') && /不會插話/.test(out[0]?.text || ''), out[0]?.text);
// 批次 30：兩種呼叫方式都要講出來——實測回報有人的 LINE @ 選單裡找不到這個帳號，
// 只講 @ 等於對那些人什麼都沒講（見 WAKE_WORD_RE 的說明）。
check('自我介紹同時講出兩種叫得動它的方式（@ 與「米亞」開頭），不是只講 @',
  /@ 我一下/.test(out[0]?.text || '') && /「米亞」開頭/.test(out[0]?.text || ''), out[0]?.text);
check('並且點名「@ 選單裡找不到我」這個實際會遇到的狀況，給出替代做法',
  /@ 選單裡找不到我/.test(out[0]?.text || ''), out[0]?.text);
check('同時把四條路都講出來，群組成員不用自己猜能問什麼',
  ['活動', '產業趨勢', '工研院', '邀訪'].every(x => (out[0]?.text || '').includes(x)), out[0]?.text);
check('附上快速回覆按鈕，第一個想試的人不用先學會怎麼 @',
  JSON.stringify(out[0]?.quickReply) === JSON.stringify(['最近有哪些活動', '產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']),
  JSON.stringify(out[0]?.quickReply));
check('join 之後續問視窗有開——不然上面那排按鈕（送出的是沒有 @ 的純文字）按了會沒反應',
  state.bindings.get('Cgroup1')?.groupSessionUntil > Date.now(), JSON.stringify(state.bindings.get('Cgroup1')));

// room（多人聊天室）走同一條路
reset(); await freshModule();
out = await sendRaw([{ type: 'join', replyToken: 'rt_join', source: { type: 'room', roomId: 'Rroom1' } }]);
check('被拉進 room（多人聊天室）也一樣自我介紹', out[0]?.kind === 'text' && /米亞/.test(out[0].text), JSON.stringify(out));

// memberJoined（有「別人」進群）刻意不理——每次有人進群就自我介紹一次是洗版
reset(); await freshModule();
out = await sendRaw([{ type: 'memberJoined', replyToken: 'rt_mj', source: { type: 'group', groupId: 'Cgroup1' }, joined: { members: [{ type: 'user', userId: 'Uxx' }] } }]);
check('有「別人」加入群組（memberJoined）→ 完全安靜，不會每進一個人就自我介紹一次',
  out.length === 0, JSON.stringify(out));

console.log('── 續問視窗守門：不是在跟我們講話的訊息，一律安靜 ──');
// 這幾句在批次 28 之前全部會被硬答：前三句命中 detectMetaIntent()／路由，而那幾條路
// 根本不看「有沒有被 @」，最後一句則是路由判成 industry_trend 就直接開講。
for (const [label, chat] of [
  ['命中活動清單關鍵字的閒聊', '那個案子後面還有活動要辦'],
  ['命中「換一場」的閒聊', '這邊先換一場再說'],
  ['聊到某個產業的陳述句', '台積電最近在擴廠'],
  ['純粹的工作對話', '我等等把資料寄給你']
]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 60000 });
  out = await sendGroup(chat, { mentionSelf: false });
  check(`續問視窗內、${label}（「${chat}」）→ 安靜，不會插話`, out.length === 0, JSON.stringify(out));
}

console.log('── 續問視窗守門：真的在跟我們講話的，一句都不能被誤擋 ──');
// 守門收得緊，代價是可能誤擋真的在問我們的人。這幾種是「不放行就會壞掉」的路徑，
// 每一種都對應 looksAddressedToBot() 裡的一類，見該處說明。
reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('半導體先進封裝技術發表會', { mentionSelf: false });
check('活動清單按鈕送出的活動全名（沒有問號、沒有疑問詞）→ 照樣接得住，按鈕不會變成按了沒反應',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

reset(); await freshModule();
await sendGroup('@我 最近有哪些活動', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('媒體邀訪需求', { mentionSelf: false });
check('固定選單按鈕（媒體邀訪需求）→ 照樣接得住', out.length > 0, JSON.stringify(out));

reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('那合作廠商有哪些', { mentionSelf: false });
check('一句真的提問（有疑問詞）→ 照樣接得住，合法續問沒有被守門連帶擋掉',
  out[0]?.kind === 'answer' && out[0].event === 'semi', JSON.stringify(out));

reset(); await freshModule();
await sendGroup('@我 產業趨勢分析', { mentionSelf: true, mentionText: '@我 ' });
out = await sendGroup('太空', { mentionSelf: false });
check('剛回答完趨勢題、接著打一個裸名詞追問 → 接得回同一個話題（那是我們自己邀請他打的）',
  out.some(o => o.kind === 'answer' || o.kind === 'text'), JSON.stringify(out.map(o => o.kind)));

// 同一個裸名詞，在沒有話題記憶時就不放行——群組裡一個沒頭沒尾的名詞多半是別人在
// 聊自己的事，不是在問我們。這是「③ 要有話題記憶才放行」那條的反面驗證。
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 60000 });
out = await sendGroup('半導體', { mentionSelf: false });
check('沒有話題記憶時、群組裡冒出一個裸名詞 → 安靜，不會自作主張開始講產業趨勢',
  out.length === 0, JSON.stringify(out));

// 被 @ 到時整道守門跳過——明確叫了機器人就不能不理人（跟批次 14／16 同一個原則）
reset(); await freshModule();
out = await sendGroup('@我 我等等把資料寄給你', { mentionSelf: true, mentionText: '@我 ' });
check('真的被 @ 到時守門完全不生效，一定會有回應（明確叫了機器人就不能不理人）',
  out.length > 0, JSON.stringify(out));

console.log('── 群組的一次性旗標要綁「是誰按的」，別人的話不會被吃掉 ──');
// 這是「亂回」最尖銳的一種：旗標存在 line_users 的 F 欄，群組用 groupId 當 key，
// 也就是整個群組共用一格。A 按了「想問什麼技術」之後，B 隨口講的下一句就會被當成
// 技術名稱送去查工研院官網，B 根本沒在跟機器人講話。見 pendingNoteFor() 的說明。
reset(); await freshModule();
await sendRaw([{
  type: 'message', replyToken: 'rt1', source: { type: 'group', groupId: 'Cgroup1', userId: 'U_alice' },
  message: { type: 'text', text: '@我 想問什麼技術', mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } }
}]);
check('A 按了「想問什麼技術」→ 機器人反問想了解哪一項技術',
  state.bindings.get('Cgroup1')?.note?.startsWith('await_tech_query'), JSON.stringify(state.bindings.get('Cgroup1')?.note));
check('旗標有記下是誰按的（群組才加這個後綴）',
  state.bindings.get('Cgroup1')?.note === 'await_tech_query#U_alice', state.bindings.get('Cgroup1')?.note);

out = await sendRaw([{
  type: 'message', replyToken: 'rt2', source: { type: 'group', groupId: 'Cgroup1', userId: 'U_bob' },
  message: { type: 'text', text: '機器人' }
}]);
check('換 B 講話（沒有 @）→ 不會被當成 A 要查的技術名稱，這是最典型的「亂回」',
  !out.some(o => o.sys?.includes('工研院官網新聞中心 搜尋')), JSON.stringify(out.map(o => o.kind)));
check('B 那句話也沒有用掉 A 的旗標，A 回來還接得住',
  state.bindings.get('Cgroup1')?.note === 'await_tech_query#U_alice', state.bindings.get('Cgroup1')?.note);

out = await sendRaw([{
  type: 'message', replyToken: 'rt3', source: { type: 'group', groupId: 'Cgroup1', userId: 'U_alice' },
  message: { type: 'text', text: '機器人' }
}]);
check('A 自己回來打技術名稱 → 照樣查得到，守門沒有把正主也擋掉',
  out.some(o => o.sys?.includes('工研院官網新聞中心 搜尋「機器人」')), JSON.stringify(out.map(o => o.kind)));

// 1 對 1 不加後綴，舊行為完全不變
reset(); await freshModule();
await send('想問什麼技術');
check('1 對 1 的旗標不加「是誰按的」後綴（targetId 就是本人，多存一份只是雜訊）',
  state.bindings.get('U_reporter')?.note === 'await_tech_query', state.bindings.get('U_reporter')?.note);

console.log('── 被守門擋掉的訊息不能吃掉限流額度，更不能讓機器人冒出「提問太頻繁」插話 ──');
// 上線後走查實測到的：守門原本排在 rateLimited() 後面，於是群組連續聊了十幾句自己的
// 事（我們全程安靜、一句都沒回），第 16 句時機器人突然冒出一句「提問太頻繁，請稍候
// 片刻再試。」——沒有人在跟它講話，這正是「亂回」本身；而且那些閒聊燒光了額度，接著
// 真的 @ 我們問問題的人反而被擋下來。限流保護的是 Anthropic／Sheets 的呼叫額度，被
// 守門擋掉的訊息根本走不到那些呼叫，本來就不該計入。
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 60000 });
{
  let spoke = 0;
  for (let i = 0; i < 16; i++) {
    const o = await sendGroup(`我等等把第 ${i} 份資料寄給你`, { mentionSelf: false }); // 純陳述句，守門一定擋掉
    if (o.length) spoke++;
  }
  check('群組連續 16 句閒聊 → 全程一句都沒開口，不會冒出「提問太頻繁」插話', spoke === 0, `開口 ${spoke} 次`);
  out = await sendGroup('@我 這場的重點是什麼', { mentionSelf: true, mentionText: '@我 ' });
  check('閒聊沒有燒掉限流額度 → 接著真的 @ 我們問問題，照樣答得到',
    out[0]?.kind === 'answer' && out[0].event === 'quad', JSON.stringify(out));
}

// 限流本身沒有被拿掉——真的連續發問（每句都通過守門）還是要擋得住。
reset(); await freshModule();
{
  let last;
  for (let i = 0; i < 16; i++) last = await sendGroup(`@我 問題${i}是什麼`, { mentionSelf: true, mentionText: '@我 ' });
  check('真的連續發問超過額度 → 限流照舊生效，不是被這次改動關掉了',
    /提問太頻繁/.test(last[0]?.text || ''), JSON.stringify(last));
}

// ── 情境 21.5：群組裡叫得動它嗎（實測回報的兩個問題，批次 30）───────────────
// 回報的截圖（真的拉同事進群組測）：
//   ① 同事按了快速回覆按鈕「媒體邀訪需求」，完全沒反應——按鈕會一直留在對話紀錄
//      裡，他隔了約 9 分鐘才按，續問視窗（當時 5 分鐘）早就過期
//   ② 同事想改用 @ 叫它，「我的 @ 找不到他 哈哈」——LINE 的 @ 選單裡只有真人成員，
//      對他來說「只有被 @ 才說話」等於完全叫不動

console.log('── 視窗過期後，自家按鈕還是要按得動 ──');
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: '', media_name: '', note: '', bound_at: 0, groupSessionUntil: Date.now() - 60000 }); // 視窗已過期
out = await sendGroup('媒體邀訪需求', { mentionSelf: false });
check('續問視窗過期後按「媒體邀訪需求」按鈕 → 照樣接得住，不是按了沒反應',
  out.length > 0 && /技術領域/.test(out[0]?.text || ''), JSON.stringify(out));

// 但「視窗外也接」只放行幾乎不可能在閒聊裡打出來的那幾種，其餘維持安靜——
// 不然這個放寬就變成新的亂回來源。
// ⚠️ 批次 30 這裡原本也列了「半導體先進封裝技術發表會」，批次 32 刻意推翻：活動全名
// 是活動清單按鈕送出的文字，它按了沒反應就是回報的那個 bug 本身。規則收斂成「只要是
// 我們自己放到按鈕上的字就一定按得動」，見 isOwnButtonText()。
for (const chat of ['那合作廠商有哪些', '大家中午吃什麼']) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
  out = await sendGroup(chat, { mentionSelf: false });
  check(`視窗過期後、非按鈕文字「${chat}」→ 維持安靜，放寬沒有變成新的亂回來源`,
    out.length === 0, JSON.stringify(out));
}

console.log('── 喚醒詞「米亞」等同被 @，不必依賴 LINE 的 @ 選單 ──');
for (const [label, text, expect] of [
  ['開頭喚醒詞＋問題', '米亞 最近有哪些活動', /近期活動/],
  ['喚醒詞後接全形逗號', '米亞，最近有哪些活動', /近期活動/],
  ['手打的 @（選單選不到、送出的是純文字）', '@米亞 最近有哪些活動', /近期活動/]
]) {
  reset(); await freshModule(); // 全新群組：沒有續問視窗，證明真的是喚醒詞在起作用
  out = await sendGroup(text, { mentionSelf: false });
  check(`${label}「${text}」→ 沒有 @、沒有視窗也答得到`,
    expect.test(out[0]?.text || ''), JSON.stringify(out));
}

reset(); await freshModule();
out = await sendGroup('米亞', { mentionSelf: false });
check('只打喚醒詞沒接問題 → 跟只 @ 一樣給自我介紹，不是把「米亞」當問題送去查',
  /米亞/.test(out[0]?.text || '') && /最近有哪些活動/.test(out[0]?.text || ''), JSON.stringify(out));
check('只打喚醒詞也會開續問視窗，後面的按鈕才按得動',
  state.bindings.get('Cgroup1')?.groupSessionUntil > Date.now(), JSON.stringify(state.bindings.get('Cgroup1')));

// ⚠️ 界線：談論這個帳號 ≠ 呼叫它。只認開頭，中間出現不算。
for (const chat of ['等等問米亞好了', '剛剛米亞說的那個活動', '你去問米亞']) {
  reset(); await freshModule();
  out = await sendGroup(chat, { mentionSelf: false });
  check(`句中提到「米亞」但不是開頭（「${chat}」）→ 安靜，那是在談論它不是在叫它`,
    out.length === 0, JSON.stringify(out));
}

// 喚醒詞在 1 對 1 不該有副作用——那邊每則訊息本來就都算在跟我們講話
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('米亞 這場的重點是什麼');
check('1 對 1 打「米亞 這場的重點是什麼」→ 照常回答（喚醒詞只影響群組的判斷）',
  out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out.map(o => o.kind)));

// ── 情境 21.8：這場答不出來時，自動補查工研院官網（回報的截圖，批次 31）─────────
// 回報：記者在群組問「今年院士有誰」，機器人照實說「我這邊目前沒有得獎名單的資料」
// ——答得沒錯，但工研院官網新聞中心搜「院士」第一筆就是那篇授證新聞（實測過真的
// 官網）。根因是路由：tech_query 要求問句裡明確出現「工研院」，這句沒有，加上當時
// 綁著一場活動就被判成 qa，我們手上另一個有答案的來源從頭到尾沒被問過。

console.log('── 這場沒有資料 → 補查官網、把原文連結接在答案後面 ──');
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士'; // 模擬 AI 判斷「背景資料答不出這題」
out = await send('今年院士有誰');
{
  // ⚠️ 只看 kind==='text'（真的送出去給記者的訊息）。kind==='answer' 是 fakes 記下的
  // **模型原始輸出**，標記本來就還在裡面，拿它來驗「有沒有切乾淨」會驗錯東西。
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('原本那句誠實的「我沒有資料」還在，沒有被補查蓋掉',
    /沒有資料/.test(sentText), JSON.stringify(out.map(o => o.text?.slice(0, 40))));
  check('後面接上工研院官網的相關報導與原文連結',
    /工研院官網新聞中心/.test(sentText) && /itri\.org\.tw/.test(sentText),
    JSON.stringify(sentText.slice(0, 300)));
  check('⚠️ 機器可讀標記一定要切掉，不能讓記者看到 [[NO_DATA:…]]',
    !/NO_DATA/.test(sentText), sentText);
  // 批次 33：實際回報就是這個位置漏掉的——警語規則佔住最後一行，標記被擠到它前面，
  // 而第一版正則錨定在字串結尾。驗一下警語本身還在（切標記沒有連累它）。
  check('切掉標記不會連累後面的警語',
    /內容僅供參考/.test(sentText), sentText);
  // 批次 34 的回報形狀：回覆同時給了鄰近資訊（38 國代表）與聯絡人，記者問的「院士」
  // 那一項仍然沒答出來——這種「部分答到」也必須觸發補查，不然記者拿到一堆旁邊的
  // 資訊、就是拿不到他問的那個。
  check('回覆同時提供了鄰近資訊與聯絡人時，補查照樣要跑（不是只有「完全沒東西」才跑）',
    /38 國代表/.test(sentText) && /工研院官網新聞中心/.test(sentText), sentText.slice(0, 400));
}
state.noDataKeyword = '';

// 補查是「查得到才附」——官網查不到時不能硬掰，也不能因此連原本的答案都不見
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.itriKeywordMustInclude = '絕對查不到的字';
out = await send('今年院士有誰');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('官網也查不到 → 只給原本那句誠實的答案，不附空的連結區塊',
    /沒有資料/.test(sentText) && !/工研院官網新聞中心/.test(sentText) && !/NO_DATA/.test(sentText),
    sentText);
}
state.itriKeywordMustInclude = '';
state.noDataKeyword = '';

// 官網整個抓不到（網路問題、改版）也不能連累原本的答案
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.itriFetchFail = true;
out = await send('今年院士有誰');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('官網抓取失敗 → 原本的答案照樣送得出去，不會整題掛掉',
    /沒有資料/.test(sentText) && !/NO_DATA/.test(sentText), sentText);
}
state.itriFetchFail = false;
state.noDataKeyword = '';

// 答得出來的正常提問完全不受影響——不多打一次官網、回覆裡也沒有多餘的區塊
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await send('這場的重點是什麼');
check('這場答得出來的正常提問 → 不補查、回覆裡沒有多餘的連結區塊（一個字節都沒變慢）',
  !/工研院官網新聞中心/.test(out.filter(o => o.kind === 'text').map(o => o.text).join('')),
  JSON.stringify(out.map(o => o.text?.slice(0, 40))));

// 群組（回報的實際情境）也要有同一條後備
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
out = await sendGroup('@我 今年院士有誰', { mentionSelf: true, mentionText: '@我 ' });
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('群組裡同一題（回報的實際情境）也接得上官網補查',
    /工研院官網新聞中心/.test(sentText) && !/NO_DATA/.test(sentText), sentText.slice(0, 300));
}
state.noDataKeyword = '';

// 標記出現在任何位置、任何寫法都要抓乾淨——位置本來就不該由我們決定（批次 33）。
{
  const { extractNoDataKeyword } = await import(new URL(`../api/line.js?v=${modSeq}`, import.meta.url).href);
  for (const [label, raw, expectKw] of [
    ['標記在警語前面（實際回報的形狀）', '沒有資料。\n\n[[NO_DATA:院士]]\n\n內容僅供參考。', '院士'],
    ['標記在整段最後', '沒有資料。\n[[NO_DATA:得獎名單]]', '得獎名單'],
    ['標記在最前面', '[[NO_DATA:太空]]\n沒有資料。', '太空'],
    ['全形冒號', '沒有資料。\n[[NO_DATA：光通訊]]\n警語。', '光通訊'],
    ['括號打壞、少一邊', '沒有資料。\n[[NO_DATA:院士\n警語。', ''],
    ['完全沒有標記（答得出來）', '這場的重點是三項技術發表。\n內容僅供參考。', '']
  ]) {
    const r = extractNoDataKeyword(raw);
    check(`標記抽取：${label} → 不留任何殘留`, !/NO_DATA/.test(r.text), JSON.stringify(r.text));
    check(`標記抽取：${label} → 關鍵詞是「${expectKw}」`, r.keyword === expectKw, JSON.stringify(r.keyword));
  }
}

// ── 情境 21.9：LINE 不渲染 Markdown（回報的截圖，批次 32）─────────────────────
// 回報：記者收到的聯絡人那行長這樣——「**徐喬涵** | 03-5915128」，星號原封不動印在
// 畫面上；分隔線也是三個裸露的 ---。既有規則寫成「需要附連結時⋯⋯不要用 Markdown」，
// 範圍只有連結，模型拿它去加粗人名時完全不覺得違規。
console.log('── 模型吐出的 Markdown 不能原樣印給記者 ──');
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.answerText = '建議您直接洽新聞聯絡人：\n\n**徐喬涵** | 03-5915128\n\n- 第一點\n- 第二點\n\n## 小標\n參考 [活動網頁](https://example.com/a?id=1)\n\n---\n內容僅供參考。';
out = await send('給我新聞稿');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('粗體的星號被拿掉，人名本身完整保留', /徐喬涵/.test(sentText) && !/\*\*/.test(sentText), sentText);
  check('電話號碼一個字都沒被動到', /03-5915128/.test(sentText), sentText);
  check('項目符號換成 LINE 上讀得順的「・」，不是留著 -', /・第一點/.test(sentText) && !/^- 第一點/m.test(sentText), sentText);
  check('# 標題的井號被拿掉，標題文字留著', /小標/.test(sentText) && !/#\s*小標/.test(sentText), sentText);
  check('[文字](網址) 攤平成「文字 網址」，網址一定要留著（記者要點）',
    /活動網頁/.test(sentText) && /https:\/\/example\.com\/a\?id=1/.test(sentText) && !/\]\(/.test(sentText), sentText);
  check('--- 水平線不會裸露在畫面上', !/^-{3,}$/m.test(sentText), sentText);
}
state.answerText = '';

// ── 情境 21.95：所有「我們自己送出的按鈕」都要按得動（回報的截圖，批次 32）────────
// 回報：同事按「半導體相關乾淨帶畫面提供」完全沒反應，只好自己補一句「按鈕 按了
// 因為沒寫米亞 會沒反應」。那是**邀訪窗口關鍵字**按鈕，送出的是原始關鍵字（沒有
// 「邀訪：」前綴，見 handleMetaIntent() 的 contacts 分支），批次 30 的視窗外放行
// 只認固定選單詞與「邀訪：ＸＸ」，沒涵蓋到——「按鈕按了沒反應」換顆按鈕又發生一次。
console.log('── 視窗過期後，同仁自訂的按鈕（chips／邀訪窗口關鍵字）也要按得動 ──');
for (const [label, text] of [
  ['邀訪窗口關鍵字', '技術規格'],
  ['自訂快速提問 chip', '新聞稿'],
  ['活動清單的活動全名', '半導體先進封裝技術發表會']
]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
  out = await sendGroup(text, { mentionSelf: false });
  check(`視窗過期後按「${text}」（${label}）→ 接得住，不用先寫「米亞」`, out.length > 0, JSON.stringify(out));
}

// 放寬之後，一般閒聊仍然要安靜——不然這就變成新的亂回來源
for (const chat of ['那合作廠商有哪些', '大家中午吃什麼', '我等等把資料寄給你']) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
  out = await sendGroup(chat, { mentionSelf: false });
  check(`視窗過期後、非按鈕的一般訊息「${chat}」→ 維持安靜`, out.length === 0, JSON.stringify(out));
}

// ── 情境 21.97：群組守門要接得住英文，導流按鈕也要按得動（批次 34）──────────────
console.log('── 群組：英文提問不能被中文守門擋掉 ──');
// 回報的截圖：群組裡打「Please reply in English.」完全沒反應——句號結尾、沒問號、
// 沒有任何中文疑問詞，守門三道規則全部落空。這個帳號本來就支援英文提問
// （lib/prompt.js 有很強的語言跟隨規則），外籍記者在群組裡卻等於完全問不到東西。
for (const en of [
  'Please reply in English.',
  'What are the highlights of this event',
  'Can you send me the press release',
  'Is there an English version'
]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 60000 });
  out = await sendGroup(en, { mentionSelf: false });
  check(`續問視窗內的英文提問「${en}」→ 接得住，不會被中文守門擋掉`, out.length > 0, JSON.stringify(out));
}

// 英文那條同樣是「第一層」，不是放行一切：純陳述的閒聊照樣要安靜（守門放行之後，
// routeIntent 判成 other 仍然會擋下來，兩層一起才是完整的門檻）。
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 60000 });
out = await sendGroup('ok got it thanks', { mentionSelf: false });
check('群組英文閒聊「ok got it thanks」→ 仍然安靜', out.length === 0, JSON.stringify(out));

console.log('── 兩顆導流按鈕在視窗外也要按得動（批次 32 破例，批次 34 補回來）──');
for (const [label, text] of [['工研院＋技術名稱', '工研院 太空'], ['技術名稱＋產業趨勢', '太空產業趨勢']]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
  out = await sendGroup(text, { mentionSelf: false });
  check(`視窗過期後按導流按鈕「${text}」（${label}）→ 接得住`, out.length > 0, JSON.stringify(out.map(o => o.kind)));
}

// 精確形狀比對：自然書寫的「工研院那邊怎麼說」（沒有空白）不該被當成按鈕
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
out = await sendGroup('工研院那邊怎麼說', { mentionSelf: false });
check('視窗過期後、自然書寫的「工研院那邊怎麼說」（沒有空白）→ 不算按鈕，維持安靜',
  out.length === 0, JSON.stringify(out));

console.log('── 補查的引言要跟著答案的語言走 ──');
// 我們自己接上去的那句引言不受 lib/prompt.js 語言規則管轄，得自己判斷；不然英文記者
// 會拿到英文答案、下面突然接一句中文。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.answerText = "I don't have that information in this event's material.\n[[NO_DATA:院士]]";
out = await send('Who are this year fellows');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('答案是英文時，補查的引言也用英文，不會中英夾雜',
    /ITRI's official newsroom/.test(sentText) && !/這題本場的新聞資料裡沒有/.test(sentText), sentText.slice(0, 300));
}
state.answerText = '';
state.noDataKeyword = '';

// ── 情境 21.98：補查不能只靠模型自己標記（實測回報，批次 37）─────────────────────
// 連續三批（31→33→34）都在修「標記為什麼沒出現」，最後一次實測仍然沒跑：回覆明明就是
// 「這題目前我手上沒有具體的名單資料」，補查那條路照樣沒動。請模型在回答裡順手加一個
// 機器讀的標記，本來就不是可靠的機制——標記留著（語意最準），但不能再是唯一觸發條件。
{
  const { guessNoDataKeyword } = await import(new URL(`../api/line.js?v=${modSeq}`, import.meta.url).href);
  console.log('── 從問句猜關鍵詞（標記沒出現時的退路）──');
  for (const [q, expect] of [
    ['今年院士', '院士'],                       // 回報截圖裡的原話
    ['今年院士有誰', '院士'],
    ['得獎名單', '得獎名單'],
    ['今年的得獎名單是什麼', '得獎名單'],       // 尾巴的「是」要切掉
    ['這次活動的合作廠商有哪些', '合作廠商'],
    ['有機材料的應用', '有機材料應用'],         // 詞中間的「有」不能動
    ['好', ''],                                  // 太短 → 放棄（不補查，不會更糟）
    ['？？', '']
  ]) {
    check(`猜關鍵詞：「${q}」→「${expect}」`, guessNoDataKeyword(q) === expect, JSON.stringify(guessNoDataKeyword(q)));
  }
}

console.log('── 模型沒加標記，但回覆就是在說「我沒有這項資料」→ 照樣補查 ──');
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
// 刻意不設 noDataKeyword：模擬「模型沒有照規則加標記」——那正是實測發生的事
state.answerText = '這題目前我手上沒有具體的名單資料，得洽現場新聞聯絡人確認喔。';
out = await send('今年院士');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('沒有標記也要補查官網並附上原文連結（不再只靠模型自己標記）',
    /工研院官網新聞中心/.test(sentText) && /itri\.org\.tw/.test(sentText), sentText.slice(0, 300));
  check('原本那句誠實的回答還在，沒有被補查蓋掉',
    /沒有具體的名單資料/.test(sentText), sentText.slice(0, 120));
}
state.answerText = '';

// 反面：答得出來的回覆不能被誤判成「沒有資料」而多查一次官網
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.answerText = '這場的重點是四足機器人平台的三項技術突破，分別是感測、運動控制與 AI 決策。';
out = await send('這場的重點是什麼');
check('正常答得出來的回覆 → 不會被誤判成沒有資料、不會多附官網連結',
  !/工研院官網新聞中心/.test(out.filter(o => o.kind === 'text').map(o => o.text).join('')),
  JSON.stringify(out.filter(o => o.kind === 'text').map(o => o.text?.slice(0, 60))));
state.answerText = '';

console.log('── 標記查不到時要退回句型判斷猜的關鍵詞（批次 39）──');
// 實測踩到的：模型的標記吐成一整句「今年受證院士的具體名單和人數」（官網查 0 筆），
// 而句型判斷猜出來的「院士」查得到——卻因為「標記優先、標記查不到就放棄」而從來
// 沒被試過。兩個來源不該二選一，該依序試。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '今年受證院士的具體名單和人數'; // 模型吐了一整句當標記
state.itriKeywordMustInclude = '院士';                 // 官網只有查「院士」才有結果
out = await send('今年院士');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('標記是一整句查不到 → 退回句型判斷猜的「院士」，照樣補查得到',
    /工研院官網新聞中心/.test(sentText) && /itri\.org\.tw/.test(sentText), sentText.slice(-300));
}
state.noDataKeyword = '';
state.itriKeywordMustInclude = '';

// 兩個候選都查不到時，安靜退回原本的答案，不硬掰
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.itriKeywordMustInclude = '絕對查不到的字';
out = await send('今年院士');
check('所有候選都查不到 → 只給原本那句誠實的回答，不附空區塊',
  !/工研院官網新聞中心/.test(out.filter(o => o.kind === 'text').map(o => o.text).join('')),
  JSON.stringify(out.filter(o => o.kind === 'text').map(o => o.text?.slice(0, 60))));
state.noDataKeyword = '';
state.itriKeywordMustInclude = '';

console.log('── 官網找到了就「讀懂它」，不是只丟連結（批次 38）──');
// 使用者確認：院士授證那場的知識庫是空的，內容只存在工研院官網新聞室——也就是說
// 這條補查是這題唯一答得出來的路，那就不能只給連結叫記者自己點進去看。
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
out = await send('今年院士有誰');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  const answers = out.filter(o => o.kind === 'answer');
  check('本場答不出來時，官網那幾篇真的被讀過一次（多一次模型呼叫，只在這條路上）',
    answers.length === 2, `模型呼叫 ${answers.length} 次`);
  check('第二次呼叫餵的是官網搜到的報導，不是活動知識庫',
    /工研院官網新聞中心 搜尋「院士」/.test(answers[1]?.sys || ''), (answers[1]?.sys || '').slice(0, 120));
  check('引言改成「我在工研院官網新聞中心找到了」，不是「有相關報導請自己看」',
    /我在工研院官網新聞中心找到了/.test(sentText), sentText.slice(0, 300));
  check('原文連結照樣附上（讀懂了還是要能查證）', /itri\.org\.tw/.test(sentText), '');
  check('⚠️ 第二段也不能漏出機器可讀標記', !/NO_DATA/.test(sentText), sentText);
}
state.noDataKeyword = '';

// 官網那幾篇其實答不出記者的問題時（模型照規則回空字串）→ 退回只給連結，不硬掰
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.answerText = ''; // 讓活動問答那支照舊帶標記
{
  // 只讓「官網補查」那一支回空字串：用一個只有空白的假回覆模擬模型判斷「摘要裡沒有」
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes('api.anthropic.com')) {
      const b = JSON.parse(o.body);
      if ((b.system?.[0]?.text || '').includes('工研院官網新聞中心 搜尋')) {
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: '   ' }] }) };
      }
    }
    return origFetch(u, o);
  };
  out = await send('今年院士有誰');
  globalThis.fetch = origFetch;
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('官網摘要答不出來 → 退回只給連結，不硬掰一段答案',
    /有相關報導/.test(sentText) && /itri\.org\.tw/.test(sentText), sentText.slice(-260));
}
state.noDataKeyword = '';

// ── 情境 21.995：群組裡切到某一場之後，要有路走得回來（回報的截圖，批次 40）────────
// 回報：「群組對話 如果切到特定活動 比較難切回來 因為圖示不會像 1 對 1 出現」。
// 圖文選單是 LINE 的 1 對 1 專屬功能，群組聊天室不顯示——1 對 1 的記者隨時有 🏠
// 可以按，群組裡的記者答完一題之後，按鈕列整排都是「這場活動的快速提問」，一條
// 往外的路都沒有。功能其實一直都在（打「回首頁」就會動），是**看不到**。
console.log('── 群組：答完一題之後，按鈕列要有往外的路 ──');
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await sendGroup('@我 這場的重點是什麼', { mentionSelf: true, mentionText: '@我 ' });
{
  const chips = out.at(-1)?.quickReply || [];
  const texts = chips.map(i => (typeof i === 'object' ? i.text : i));
  const labels = chips.map(i => (typeof i === 'object' ? i.label : i));
  check('群組答案的按鈕列有「回首頁」（就是回報說找不到的那條路）', texts.includes('回首頁'), JSON.stringify(chips));
  check('也有「最近有哪些活動」，可以不解除綁定直接看清單換場', texts.includes('最近有哪些活動'), JSON.stringify(chips));
  check('另外兩條路（產業趨勢／問技術）也在，跟 1 對 1 圖文選單同一組', 
    texts.includes('產業趨勢分析') && texts.includes('想問什麼技術'), JSON.stringify(chips));
  check('邀訪窗口沒有被擠掉', texts.includes('媒體邀訪需求'), JSON.stringify(chips));
  check('⚠️ 往外的兩顆排在最前面（藏在自訂提問後面等於沒有，手機一次只看得到兩三顆）',
    texts[0] === '回首頁' && texts[1] === '最近有哪些活動', JSON.stringify(texts));
  check('顯示用的標籤帶 icon、跟圖文選單同一組視覺', /🏠/.test(labels[0]) && /📅/.test(labels[1]), JSON.stringify(labels));
  check('⚠️ 不超過 LINE 的 13 顆硬上限（超過會從尾巴被截掉，截掉的正好是導覽）', chips.length <= 13, `${chips.length} 顆`);
}

// 1 對 1 不動：那邊圖文選單一直顯示在畫面下方，同一組入口再塞進按鈕列只會排擠掉
// 同仁自訂的提問
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });
out = await send('這場的重點是什麼');
check('1 對 1 的按鈕列維持原樣（有圖文選單頂著，不重複塞導覽）',
  JSON.stringify(out[1]?.quickReply) === JSON.stringify(['重點', '應用', '媒體邀訪需求']), JSON.stringify(out[1]?.quickReply));

// 按下去要真的會動——而且是在「續問視窗已經過期」的情況下（按鈕會留在對話紀錄裡，
// 記者往上滑才按是常態，這正是批次 30/32 踩過兩次的坑）
for (const [label, text] of [['回首頁', '回首頁'], ['其他活動', '最近有哪些活動']]) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60000 });
  out = await sendGroup(text, { mentionSelf: false });
  check(`視窗過期後按「${label}」→ 接得住，不用先 @ 也不用寫「米亞」`, out.length > 0, JSON.stringify(out));
}

// 「回首頁」要真的解除綁定，不是只回一句話——不解除的話記者接著打的新場次名稱
// 會先被當成對舊場次的提問
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await sendGroup('@我 回首頁', { mentionSelf: true, mentionText: '@我 ' });
// 綁定是靠 bound_at 判定有沒有效（見 getBinding() 的 TTL），clearBinding() 清的
// 就是那一格——不是把 event_id 抹掉
check('群組按「回首頁」→ 真的解除這個群組的活動綁定', !state.bindings.get('Cgroup1')?.bound_at,
  JSON.stringify(state.bindings.get('Cgroup1')));
check('並且列出活動清單，讓人當場挑下一場', /活動|場次/.test(out.at(-1)?.text || ''), JSON.stringify(out));
// 行為上的驗證：解除之後再問一句沒指名場次的話，不會再被當成對舊那場（quad）的提問
out = await sendGroup('@我 這場的重點是什麼', { mentionSelf: true, mentionText: '@我 ' });
check('解除後的下一句不再自動算在舊場次頭上', !out.some(o => o.kind === 'answer' && o.event === 'quad'),
  JSON.stringify(out));

// 群組換場的確認訊息，原本完全沒有按鈕——換完場正是最需要導覽的一刻
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
out = await sendGroup('@我 半導體先進封裝技術發表會', { mentionSelf: true, mentionText: '@我 ' });
{
  const last = out.at(-1);
  const texts = (last?.quickReply || []).map(i => (typeof i === 'object' ? i.text : i));
  check('群組換場確認訊息也附按鈕（換錯了要能馬上換回去）',
    /已為您換到/.test(last?.text || '') && texts.includes('回首頁'), JSON.stringify(out));
}

// ── 情境 21.996：按鈕永遠要按得動，不管隔多久（實測回報，批次 41）─────────────────
// 回報的截圖：群組裡的按鈕列停在下午 6:55 那則答案上，晚上 8:58 有人滑回去點
// 「這次活動的主要發表內容是什麼？」——完全沒反應。「人家按按鈕，不會再特別加 @ 或
// 米亞」，所以按鈕沉默等於整條路斷掉。
//
// 根因是兩道**各自獨立**的門，只要有一道關著就沉默：
//   ① 守門（isOwnButtonText）本來拿「目前綁定的那場」比對 chips，但活動綁定有 6 小時
//      TTL，過了就 getBinding() → null，連比對都沒得比
//   ② 就算守門放行，handleGroupMessage() 的 getBinding() 照樣 null → 掉進
//      handleUnbound() 的 silentOnOther → 沉默的位置只是往後挪了一段
console.log('── 群組：隔了幾小時再點按鈕，一樣要答得出來 ──');
const HOURS_7 = 7 * 60 * 60 * 1000;

reset(); await freshModule();
state.bindings.set('Cgroup1', {
  event_id: 'semi', media_name: '', note: '',
  bound_at: Date.now() - HOURS_7,                 // 綁定早就過了 6 小時 TTL
  groupSessionUntil: Date.now() - 60000           // 續問視窗也過期
});
out = await sendGroup('這次活動的主要發表內容是什麼？', { mentionSelf: false });
check('綁定過期 7 小時後點預設 chip → 綁定接回原本那場並回答（就是回報的截圖）',
  out.some(o => o.kind === 'answer' && o.event === 'semi'), JSON.stringify(out));

reset(); await freshModule();
state.bindings.set('Cgroup1', {
  event_id: 'quad', media_name: '', note: '',
  bound_at: Date.now() - HOURS_7, groupSessionUntil: Date.now() - 60000
});
out = await sendGroup('重點', { mentionSelf: false });
check('綁定過期後點同仁自訂的 chip（quad 的「重點」）→ 一樣接得回來',
  out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out));

// 邀訪窗口關鍵字按鈕也是我們送出去的，同樣不該因為綁定過期就啞掉
reset(); await freshModule();
state.bindings.set('Cgroup1', {
  event_id: 'quad', media_name: '', note: '',
  bound_at: Date.now() - HOURS_7, groupSessionUntil: Date.now() - 60000
});
out = await sendGroup('技術規格', { mentionSelf: false });
check('綁定過期後點邀訪窗口關鍵字 → 一樣給得出聯絡人', out.length > 0 && /陳美玲/.test(out.at(-1)?.text || ''),
  JSON.stringify(out));

// 連綁定都被清掉、只剩一顆每場共用的預設 chip——推不出是哪一場沒關係，
// **就是不能沉默**：反問一句「您想問哪一場」也好過按了沒反應
reset(); await freshModule();
out = await sendGroup('這次活動的主要發表內容是什麼？', { mentionSelf: false });
check('完全沒有綁定時點預設 chip → 至少要有回覆，不能沉默', out.length > 0, JSON.stringify(out));

// 自訂 chip 只有那一場有，就算完全沒綁定也推得出來是哪一場
reset(); await freshModule();
out = await sendGroup('這場的技術突破是什麼？', { mentionSelf: false });
check('沒有綁定時點某一場專屬的自訂 chip → 直接接到那一場（soon）',
  out.some(o => o.kind === 'answer' && o.event === 'soon'), JSON.stringify(out));

// 活動前那組 invite_letter_chips 也算我們的按鈕
reset(); await freshModule();
out = await sendGroup('邀請函內容是什麼？', { mentionSelf: false });
check('沒有綁定時點「活動前」那組 chip → 一樣接得到那一場', out.length > 0, JSON.stringify(out));

console.log('── 放寬之後，一般閒聊仍然要安靜 ──');
for (const chat of ['大家中午吃什麼', '我等等把資料寄給你', '那我先走囉']) {
  reset(); await freshModule();
  state.bindings.set('Cgroup1', {
    event_id: 'semi', media_name: '', note: '',
    bound_at: Date.now() - HOURS_7, groupSessionUntil: Date.now() - 60000
  });
  out = await sendGroup(chat, { mentionSelf: false });
  check(`綁定過期後的一般閒聊「${chat}」→ 維持安靜（守門沒有被放寬）`, out.length === 0, JSON.stringify(out));
}

// ⚠️ 保守：綁定還在的時候，點到別場的舊按鈕**不會**偷偷換場。跨場次比對只用來
// 「認出這是我們的按鈕」跟「沒有綁定時推出場次」，不拿來當換場依據——「新聞稿」
// 這種字同時是 quad 的邀訪關鍵字、也是任何一場都可能想問的東西，拿它換場等於
// 把記者從他正在問的那場拉走（LINE-PLAN.md 坑 6）。
reset(); await freshModule();
state.bindings.set('Cgroup1', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() });
out = await sendGroup('@我 重點', { mentionSelf: true, mentionText: '@我 ' });
check('綁定還在時點到別場的舊 chip → 不會偷偷換到別場去',
  !out.some(o => o.kind === 'answer' && o.event === 'quad'), JSON.stringify(out));

// ── 情境 21.985：補查不能亂抓（實測回報的截圖，批次 44）─────────────────────────
// 回報：群組裡打「新聞稿」，本場正確地回了「這場狀態是稍晚提供，還沒有完整新聞稿全文」
// ＋大會手冊＋新聞聯絡人——到這裡都對。壞在後面自動接上的補查區塊：拿「新聞稿」三個字
// 去搜官網，撈回三篇只因為內文出現過「新聞稿」而中的無關報導（致茂論文競賽、管風琴演
// 奏會），還一本正經列出原文連結；而且開頭寫「我在工研院官網新聞中心找到了：」，內文卻
// 寫「我手上資料沒有能直接回答的內容耶」——同一則訊息自己打自己。
console.log('── 泛用關鍵詞不拿去查官網（查了只會撈到雜訊）──');
// ⚠️ 綁 semi 不綁 quad：quad 的 fixture 把「新聞稿」設成邀訪窗口關鍵字，那條路會先
// 命中、根本走不到補查，測了等於沒測（第一版就是這樣，在壞掉的程式上照樣綠燈）。
for (const generic of ['新聞稿', '照片', '資料', '名單', '簡報']) {
  reset(); await freshModule();
  state.bindings.set('U_reporter', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() });
  state.noDataKeyword = generic;
  out = await send(generic);
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check(`「${generic}」→ 不去查官網、不附無關連結`,
    !/工研院官網新聞中心/.test(sentText) && !/itri\.org\.tw\/ListStyle/.test(sentText), sentText.slice(0, 200));
}
// 有主題的詞不受影響——「得獎名單」「開幕照片」照樣查
for (const real of ['得獎名單', '院士']) {
  reset(); await freshModule();
  state.bindings.set('U_reporter', { event_id: 'semi', media_name: '', note: '', bound_at: Date.now() });
  state.noDataKeyword = real;
  out = await send(real);
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check(`「${real}」是有主題的詞 → 照樣補查`, /工研院官網新聞中心/.test(sentText), sentText.slice(0, 200));
}

console.log('── 補查的模型自己說「答不出來」時，不能被當成答案用 ──');
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
// 回報截圖裡模型真的吐出來的那段話（規則叫它回空字串，它改成用一整段話說沒查到）
state.newsDigestText = '這題我手上資料沒有能直接回答的內容耶。目前查到的三篇都是工研院官網新聞中心的報導，但都跟您問的內容沒有直接對應資訊 😊\n\n建議您可以換個更明確的關鍵字，例如活動名稱或日期，我再幫您查一次。';
out = await send('今年院士有誰');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('模型那段「答不出來」的話不會出現在記者收到的訊息裡',
    !/沒有能直接回答|換個更明確的關鍵字|再幫您查一次/.test(sentText), sentText.slice(0, 400));
  check('退回「只附原文連結」那條路，連結還是給得到',
    /itri\.org\.tw/.test(sentText), sentText.slice(0, 400));
  check('⚠️ 引言不能說「找到了」——那是前後文自己打自己的來源',
    !/新聞中心找到了/.test(sentText), sentText.slice(0, 400));
}

// 模型真的答得出來時，照舊用它的答案（批次 38 的行為不能被這次的防線誤殺）
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
state.noDataKeyword = '院士';
state.newsDigestText = '工研院官網新聞中心 2026/09/07 的報導寫到，第 15 屆新任院士由賴總統親自授證，涵蓋半導體、資通訊與智慧醫療三個領域。';
out = await send('今年院士有誰');
{
  const sentText = out.filter(o => o.kind === 'text').map(o => o.text).join('\n');
  check('模型答得出來時，答案照舊送出去', /第 15 屆新任院士由賴總統親自授證/.test(sentText), sentText.slice(0, 400));
  check('這種時候引言才會說「找到了」', /新聞中心找到了/.test(sentText), sentText.slice(0, 400));
}

// ── 情境 21.99：跨場次——答案在別場的新聞稿裡也要答得出來（批次 36）─────────────
// 回報的意見：「這一定要切來切去特定活動專屬回答系統嗎？不能一體適用？」
// 記者問「今年院士有誰」，答案就寫在《工研院院士授證典禮》那場的新聞稿裡，但問答只讀
// 「目前綁定的這一場」，於是不是答不出來、就是要先切過去。
console.log('── 主場次答不出來、但別場的新聞稿裡有 → 自動把那場帶進來 ──');
{
  // 這個情境需要一場「內容裡真的有院士名單」的活動。加進 fixture 之後一定要還原——
  // reset() 不會重建 state.events，留著會污染後面所有情境。
  state.events.push(['fellow', '工研院院士授證典禮', '#0F9E7A',
    '【新聞稿】本屆新任院士包括張三、李四、王五三位，由總統親自授證。', 'active', '2026-09-07',
    '', '', '', '工研院', 'code9', '', '', '', '', '', '', '']);
  try {
    reset(); await freshModule();
    state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
    out = await send('今年院士有誰');
    const a = out.find(o => o.kind === 'answer');
    check('主場次仍然是綁定的那一場（沒有偷偷換場）', a?.event === 'quad', a?.event);
    check('第一個（吃快取的）system 區塊還是主場次的內容', /四足機器人/.test(a?.sys || ''), (a?.sys || '').slice(0, 60));
    check('答案寫在別場新聞稿裡 → 那一場被自動帶進來（回報的案例）',
      /其他場次：工研院院士授證典禮/.test(a?.sysAll || ''), (a?.sysAll || '').slice(-300));
    check('帶進來的是那場的新聞稿內容，不是只有名字',
      /本屆新任院士包括張三/.test(a?.sysAll || ''), '');
    check('⚠️ 同時一定要有「必須講出是哪一場」的規則（張冠李戴比答不出來嚴重）',
      /必須在回答裡明確講出是哪一場/.test(a?.sysAll || ''), '');
    check('跨場次資料不進第一個區塊（不然每題都會打散 ephemeral 快取）',
      !/其他場次：/.test(a?.sys || ''), '');

    // 問的就是本場的內容時，不該把不相干的場次拖進來（只是拖慢、變貴）
    reset(); await freshModule();
    state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
    out = await send('四足機器人的應用場域為何');
    check('問的就是本場內容 → 不會把院士那場拖進來',
      !/其他場次：工研院院士授證典禮/.test(out.find(o => o.kind === 'answer')?.sysAll || ''), '');

    // 群組走同一支 answerQuestion，一樣要有
    reset(); await freshModule();
    state.bindings.set('Cgroup1', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now() });
    out = await sendGroup('@我 今年院士有誰', { mentionSelf: true, mentionText: '@我 ' });
    check('群組裡同一題也會帶入那一場',
      /其他場次：工研院院士授證典禮/.test(out.find(o => o.kind === 'answer')?.sysAll || ''), '');
  } finally {
    state.events.pop(); // 還原 fixture，不然後面的情境會多出一場活動
  }
}

// ── 情境 22：1 對 1 的上一輪對話記憶（批次 28）───────────────────────────────
// 回報的意見：「對答要更如真人般」。最不像人的地方不是語氣，是完全沒有對話記憶——
// 記者問「這項技術何時商業化」，答完再問「那成本呢」，模型連上一句是什麼都看不到。
console.log('── 1 對 1：上一輪對話要帶進下一題，「那成本呢」才接得住 ──');
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });
await send('這項技術預計何時商業化？');
check('答完第一題後，上一輪被記下來（line_users I 欄）',
  !!state.bindings.get('U_reporter')?.lastTurn, state.bindings.get('U_reporter')?.lastTurn);
{
  const turn = JSON.parse(state.bindings.get('U_reporter').lastTurn);
  check('記下來的是這一輪的問題與答案，而且標明是哪一場（換場後不能誤用）',
    turn.q === '這項技術預計何時商業化？' && turn.e === 'quad' && !!turn.a, JSON.stringify(turn));
}

out = await send('那成本呢');
check('下一題把上一輪當成對話脈絡送上去，模型看得到「那」指的是什麼',
  JSON.stringify(out.find(o => o.kind === 'answer')?.msgs) === JSON.stringify([
    { role: 'user', content: '這項技術預計何時商業化？' },
    { role: 'assistant', content: '（假回答）' },
    { role: 'user', content: '那成本呢' }
  ]), JSON.stringify(out.find(o => o.kind === 'answer')?.msgs));

// 換場之後不能回放上一場的問答——那等於把另一場的內容當成這一場的脈絡餵給模型，
// 跟「換錯場」是同一種風險（記者不會發現答案其實混到別場）。
reset(); await freshModule();
state.bindings.set('U_reporter', {
  event_id: 'semi', media_name: '', note: '', bound_at: Date.now(),
  lastTurn: JSON.stringify({ t: Date.now(), e: 'quad', q: '四足機器人的重點是什麼', a: '（上一場的答案）' })
});
out = await send('那合作廠商有哪些');
check('上一輪是別場的問答 → 不回放，這一場的答案不會混到別場的脈絡',
  out.find(o => o.kind === 'answer')?.event === 'semi' &&
  out.find(o => o.kind === 'answer')?.msgs?.length === 1,
  JSON.stringify(out.find(o => o.kind === 'answer')?.msgs));

// 過期的記憶不回放——記者隔了半小時再回來打「那成本呢」，那個「那」早就不成立了
reset(); await freshModule();
state.bindings.set('U_reporter', {
  event_id: 'quad', media_name: '', note: '', bound_at: Date.now(),
  lastTurn: JSON.stringify({ t: Date.now() - 30 * 60 * 1000, e: 'quad', q: '舊問題', a: '舊答案' })
});
out = await send('這場的重點是什麼');
check('超過 TTL 的對話記憶不回放，退回單則問答的行為',
  out.find(o => o.kind === 'answer')?.msgs?.length === 1,
  JSON.stringify(out.find(o => o.kind === 'answer')?.msgs));

// 壞掉的記憶（手動改過的儲存格、舊格式）不能讓記者問不到東西
reset(); await freshModule();
state.bindings.set('U_reporter', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), lastTurn: '{壞掉的 JSON' });
out = await send('這場的重點是什麼');
check('對話記憶那一格是壞資料 → 當作沒有記憶照常回答，不會整支掛掉',
  out.find(o => o.kind === 'answer')?.event === 'quad' &&
  out.find(o => o.kind === 'answer')?.msgs?.length === 1,
  JSON.stringify(out.find(o => o.kind === 'answer')?.msgs));

// 群組刻意不開對話記憶——多人交錯提問，「上一輪」很可能是別人的問題
reset(); await freshModule();
await sendGroup('@我 半導體先進封裝技術發表會的重點', { mentionSelf: true, mentionText: '@我 ' });
check('群組不記對話記憶（多人交錯提問，回放上一輪只會製造答非所問）',
  !state.bindings.get('Cgroup1')?.lastTurn, state.bindings.get('Cgroup1')?.lastTurn);

// 「回首頁」要把對話記憶一起清掉——記者明確說這一輪聊完了
reset(); await freshModule();
state.bindings.set('U_reporter', {
  event_id: 'quad', media_name: '', note: '', bound_at: Date.now(),
  lastTurn: JSON.stringify({ t: Date.now(), e: 'quad', q: '舊問題', a: '舊答案' })
});
await send('回首頁');
check('「回首頁」把上一輪對話記憶一起清掉，下一句不會被接回舊脈絡',
  !state.bindings.get('U_reporter')?.lastTurn, state.bindings.get('U_reporter')?.lastTurn);

// ── 情境 23：非文字訊息的回覆要有人味（批次 28）───────────────────────────────
console.log('── 非文字訊息：貼圖、照片各有各的講法，不是同一句系統公告 ──');
for (const [type, must] of [['sticker', '貼圖'], ['image', '圖'], ['audio', '語音'], ['location', '位置']]) {
  reset(); await freshModule();
  out = await sendRaw([{ type: 'message', replyToken: 'rt_' + type, source: { type: 'user', userId: 'U_reporter' }, message: { type } }]);
  check(`1 對 1 收到 ${type} → 回覆針對這個型別講話，不是同一句「目前僅支援文字訊息提問」`,
    out[0]?.kind === 'text' && out[0].text.includes(must) && !/目前僅支援文字訊息提問/.test(out[0].text),
    JSON.stringify(out));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 流程測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
