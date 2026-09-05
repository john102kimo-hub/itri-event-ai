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
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, sys: s.sys, question: s.question }));
}

async function sendGroup(text, opts) {
  sent.length = 0;
  await handler(makeGroupReq(text, opts), res);
  return sent.map(s => ({ kind: s.kind, text: s.text, event: s.event, quickReply: s.quickReply, sys: s.sys, question: s.question }));
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
  out[0]?.kind === 'text' && /怎麼使用這個帳號/.test(out[0].text) && !/不確定/.test(out[0].text),
  JSON.stringify(out));

// 沒有 @ 到、單純打字問「妳能幫我什麼」（1 對 1，每則訊息本來就都算在跟我們講話）
// 也要走同一條路，不是群組限定的修法。
reset(); await freshModule();
out = await send('你是誰');
check('1 對 1 問「你是誰」→ 回使用說明，不是答非所問的萬用兜底文案',
  out[0]?.kind === 'text' && /怎麼使用這個帳號/.test(out[0].text), JSON.stringify(out));

// 迴歸：真的問不出所以然的話，兜底文案還在——不是把安全網拿掉。
// 批次 24 改寫了這段文案：舊版把「猜不出來」一律講成「我沒抓到您想問哪一場活動」，
// 但這個帳號有四條路（活動／產業趨勢／工研院技術／邀訪窗口），活動只是其中一條，
// 記者根本沒在問活動時那句話本身就是答非所問（見情境 19 的回報截圖）。新版不預設
// 記者一定是在問活動，四條路一次講清楚。
reset(); await freshModule();
out = await send('隨便問一句跟任何主題都不相關的話');
check('真的判不出意圖 → 兜底文案仍然出現，四條路都講到，且附上核心入口按鈕',
  out[0]?.kind === 'text' &&
  /不太確定該從哪邊幫您找答案/.test(out[0].text) &&
  !/沒抓到您想問哪一場活動/.test(out[0].text) &&
  ['活動名稱', '產業趨勢', '工研院', '媒體邀訪需求'].every(s => out[0].text.includes(s)) &&
  JSON.stringify(out[0]?.quickReply) === JSON.stringify(['最近有哪些活動', '產業趨勢分析', '想問什麼技術', '媒體邀訪需求', '使用說明']),
  JSON.stringify(out));

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

out = await send('回首頁'); // 按鈕已改名，見情境 1 的說明
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('「回首頁」的按鈕列最後一格是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
  // 回報的意見：按鈕不夠明顯，容易被忽略——文字裡也要有這個入口，不能只靠按鈕。
  check('「回首頁」的文字裡也提到媒體邀訪需求（不只靠按鈕）',
    /媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}

out = await send('最近有哪些活動');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('綁定中查「最近有哪些活動」的按鈕列最後一格也是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
  check('綁定中查活動列表的文字裡也提到媒體邀訪需求', /媒體邀訪需求/.test(out[0]?.text || ''), out[0]?.text);
}

// 沒綁定時要真的走 handleUnbound() 自己的 'calendar' 分支（跟上面兩個測試不同
// 路徑）——「最近如何」故意不含活動／場次／記者會字樣，過不了 detectMetaIntent()
// 的 CALENDAR_RE，才不會被 handleMetaIntent() 攔走，落到自然語言路由這條路。
reset(); await freshModule();
out = await send('最近如何');
{
  const labels = (out[0]?.quickReply || []).map(i => (typeof i === 'object' ? i.label : i));
  check('沒綁定時查活動列表的按鈕列最後一格也是媒體邀訪需求', labels[labels.length - 1] === '媒體邀訪需求', JSON.stringify(labels));
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
  check(`招呼語「${greeting}」不會被當成主題詞複誦，走的是四條路都講清楚的泛用兜底`,
    out[0]?.kind === 'text' && /不太確定該從哪邊幫您找答案/.test(out[0].text) && !out[0].text.includes(`「${greeting}」`),
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

console.log(`\n${fail === 0 ? '✅' : '❌'} 流程測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
