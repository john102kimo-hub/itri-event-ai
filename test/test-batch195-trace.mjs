// 批次 195（工單 A）：每一題的決策紀錄。
//   一、純函式（lib/route-trace.js）：狀態判斷的優先序、qa_log J～Q 八格的樣子
//   二、讀取端（lib/teach-queue.js isUnansweredRow）：J 欄有值以它為準，沒有才退回比對措辭
//   三、LINE 端到端（真的 api/line.js，只有 Sheets／LINE／模型是假的）：
//       問 5 題（活動、產業趨勢、技術、閒聊、一題答不出來），qa_log 與 route_log 合起來剛好 5 列，每列看得出判成什麼
//   四、不該留紀錄的：群組裡米亞安靜的訊息、職員模式、純選台
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';   // 要開著，問答才會寫進 qa_log／route_log
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

const T = await import('../lib/route-trace.js');
const TQ = await import('../lib/teach-queue.js');

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('\n── 一、狀態判斷與八格欄位 ──');
{
  const s = T.answerStatusOf;
  check('一般：answered', s({}) === 'answered');
  check('★ 邀請窗口 ＞ 拒答 ＞ 沒資料：同時成立時取最前面的', s({ contact: true, refused: true, noData: true }) === 'contact' && s({ refused: true, noData: true }) === 'refused');
  check('　 沒資料：補查官網沒查到是 no_data，查到並接在答案後面是 no_data_news', s({ noData: true }) === 'no_data' && s({ noData: true, newsHint: true }) === 'no_data_news');
  check('　 沒有「沒資料」卻補查到東西（不會發生，但不能誤標）→ 仍是 answered', s({ newsHint: true }) === 'answered');
  check('answer_status 的合法值就這五個', T.ANSWER_STATUS.join() === 'answered,no_data,no_data_news,refused,contact');

  check('表頭：J～Q 八格，跟 qaExtraCells 的格數一樣', T.QA_EXTRA_HEADER.length === 8 && T.qaExtraCells().length === 8);
  const bare = T.qaExtraCells({ status: 'no_data', kb: 'kb+news', keyword: '院士', flags: 'n:3', prev: true, scope: 'web' });
  check('沒有 trace（網頁版、測試直接呼叫）：intent 固定 qa、場次與把握度是空的，scope 由呼叫端給',
    bare.join('|') === 'no_data|qa|||web+prev|kb+news|院士|n:3', bare.join('|'));
  check('出口檢查標記壓成一格短字串（n 數字、u 網址、t 英文名詞）',
    T.groundingFlagsText({ numbers: ['3億'], urls: ['http://x.test'], terms: ['AI'] }) === 'n:3億|u:http://x.test|t:AI' && T.groundingFlagsText(null) === '' && T.groundingFlagsText({ numbers: [], urls: [], terms: [] }) === '');
}

// ═══ 二、讀取端 ═══════════════════════════════════════════════════════════════
console.log('\n── 二、isUnansweredRow：先看 J 欄，沒有才比對措辭 ──');
{
  const row = (a, j) => { const r = ['t', 'e', 'n', 'm', 'q', a, '', 'line', '']; if (j !== undefined) r[9] = j; return r; };
  const NO = '這部分我沒有資料，建議洽現場新聞聯絡人。';
  check('★ J 欄 no_data：就算回答裡沒有那句話，也算答不出來（措辭換了不會瞎掉）', TQ.isUnansweredRow(row('了解，這一點我不方便替院方多做解讀。', 'no_data')) === true);
  check('　 J 欄 no_data_news 也算', TQ.isUnansweredRow(row('x', 'no_data_news')) === true);
  check('★ J 欄 answered：就算回答裡剛好有那句話，也不算（以程式算的狀態為準）', TQ.isUnansweredRow(row(NO, 'answered')) === false);
  check('　 J 欄 refused／contact 不算「答不出來」', TQ.isUnansweredRow(row(NO, 'refused')) === false && TQ.isUnansweredRow(row(NO, 'contact')) === false);
  check('★ 舊資料（沒有 J 欄）：退回比對措辭，跟以前一樣', TQ.isUnansweredRow(row(NO)) === true && TQ.isUnansweredRow(row('活動在南港舉行。')) === false && TQ.isUnansweredRow(row(NO, '')) === true);
  check('　 壞資料不丟例外', TQ.isUnansweredRow(null) === false && TQ.isUnansweredRow([]) === false);

  // 待教清單：findSuspects 也走同一支
  const now = Date.now();
  const stamp = new Date(now - 3600_000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const q = (question, a, j) => { const r = [stamp, 'e1', '測試場', '甲報', question, a, '', 'line', '']; if (j) r[9] = j; return r; };
  const got = TQ.findSuspects([q('停車位在哪裡', '了解，這一點我不方便替院方多做解讀。', 'no_data'), q('午餐有提供嗎', NO, 'answered'), q('舊資料的題目', NO)], { now });
  check('★ 待教清單：J 欄 no_data 的進清單、J 欄 answered 的不進、舊資料照舊比對措辭',
    got.map((x) => x.question).sort().join() === '停車位在哪裡,舊資料的題目', got.map((x) => x.question).join());
}

// ═══ 三、LINE 端到端 ══════════════════════════════════════════════════════════
console.log('\n── 三、LINE：5 題 → qa_log ＋ route_log 剛好 5 列 ──');
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
async function grp(gid, uid, text, { mention = false } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
const qaCount = () => state.qaAppended.length;
const routeCount = () => state.routeLog.length;
const last = (arr) => arr[arr.length - 1];

reset();
state.itriHtml = '';   // 官網補查「查無資料」：答不出來時不會接上新聞連結
await fresh();

// 1. 活動問答（路由命中、軟綁定）
await dm('U1', '半導體先進封裝技術發表會的重點');
let qa = last(state.qaAppended) || [];
check('★ 活動問答 → qa_log 多一列（17 格）：answered、intent qa、選到 semi、把握度 high、1:1 路由命中、資料來源 kb（假資料裡跨場次會多帶 related:場次）',
  qaCount() === 1 && qa.length === 17 && qa[9] === 'answered' && qa[10] === 'qa' && qa[11] === 'semi' && qa[12] === 'high' && qa[13] === '1:1/route' && /^kb(\+|$)/.test(qa[14]), JSON.stringify(qa.slice(8)));
check('　 A～H 欄跟以前一樣（時間、活動、媒體、問題、回答、刪除旗標、來源），I 欄（姓名）LINE 不填',
  qa[1] === 'semi' && /半導體先進封裝/.test(qa[4]) && qa[6] === '' && qa[7] === 'line' && qa[8] === '', JSON.stringify(qa.slice(0, 9)));
check('　 這一題沒有另外寫 route_log（同一題不兩邊都記）', routeCount() === 0);

// 1b. 活動前（只有邀請函）：kb_source 記 invite，看得出這題的底稿不是正式新聞稿
await dm('U1b', '奈米材料前瞻應用發表會的採訪方式');
let qaInv = last(state.qaAppended) || [];
check('★ 活動前的場次（只拿得到邀請函）→ kb_source 以 invite 開頭；一般場次是 kb', qaCount() === 2 && /^invite(\+|$)/.test(qaInv[14]) && /^kb(\+|$)/.test(qa[14]), JSON.stringify([qaInv[1], qaInv[14], qa[14]]));
state.qaAppended.length = 1; // 後面的筆數從「只有第 1 題」算起（1b 只是順手驗資料來源）

// 2. 產業趨勢
state.routeForce = () => ({ intent: 'industry_trend', event_ids: [], confidence: 'high' });
await dm('U2', '最近有什麼產業趨勢值得注意');
let rl = last(state.routeLog) || [];
check('★ 產業趨勢 → 不進 qa_log，route_log 多一列：1:1、industry_trend、high、走 industry_trend 這條路、問題前 60 字',
  qaCount() === 1 && routeCount() === 1 && rl[1] === '1:1' && rl[2] === 'industry_trend' && rl[4] === 'high' && rl[5] === 'industry_trend' && /最近有什麼產業趨勢/.test(rl[6]), JSON.stringify(rl));

// 3. 工研院技術
state.routeForce = () => ({ intent: 'tech_query', event_ids: [], confidence: 'high', tech_keyword: '機器人' });
await dm('U3', '工研院在機器人技術上有什麼進展');
rl = last(state.routeLog) || [];
check('★ 工研院技術 → route_log：tech_query', qaCount() === 1 && routeCount() === 2 && rl[2] === 'tech_query' && rl[5] === 'tech_query', JSON.stringify(rl));

// 4. 閒聊（路由判成 other，兜底引導裡的閒聊固定回覆）
state.routeForce = null;
await dm('U4', '你好');
rl = last(state.routeLog) || [];
check('★ 閒聊 → route_log：路由判的 other 照實記、走的路是 fallback:chitchat', qaCount() === 1 && routeCount() === 3 && rl[2] === 'other' && rl[5] === 'fallback:chitchat', JSON.stringify(rl));

// 5. 一題答不出來（模型標了關鍵詞）
state.noDataKeyword = '停車';
await dm('U1', '半導體先進封裝技術發表會有提供停車嗎');
qa = last(state.qaAppended) || [];
check('★ 答不出來 → qa_log：answer_status 是 no_data、no_data_keyword 記「停車」',
  qaCount() === 2 && qa[9] === 'no_data' && qa[15] === '停車', JSON.stringify(qa.slice(8)));
check('★ 合起來剛好 5 列（qa_log 2 ＋ route_log 3），每一題都留下痕跡', qaCount() + routeCount() === 5, `qa=${qaCount()} route=${routeCount()}`);
check('　 綁定之後再問：context_source 記「1:1/」開頭', /^1:1\//.test(qa[13]), qa[13]);

// 5b. 補查官網有查到 → no_data_news
reset();   // 官網假資料回到預設（有一則「院士／得獎名單」的報導）
await fresh();
state.noDataKeyword = '院士';
await dm('U5', '半導體先進封裝技術發表會有哪些院士出席');
qa = last(state.qaAppended) || [];
check('　 答不出來、補查官網有接上報導 → no_data_news', qa[9] === 'no_data_news' && /news/.test(qa[14]), JSON.stringify(qa.slice(8)));

// 6. 綁定中的選台（純確認訊息）不是一題
reset();
await fresh();
await dm('U6', '半導體先進封裝技術發表會的重點');
const q0 = qaCount(), r0 = routeCount();
await dm('U6', '智慧醫療解決方案記者會');
check('★ 綁定中打另一場的活動名稱（純選台）：不進 qa_log；route_log 記一列規則層處理',
  qaCount() === q0 && routeCount() === r0 + 1 && last(state.routeLog)[2] === 'rule', JSON.stringify(last(state.routeLog)));

// 7. 職員模式不留紀錄
reset();
await fresh();
await dm('U_staff', 'openseasame');
await dm('U_staff', '功能');
check('★ 職員模式（問的是後台資料）：route_log 不留紀錄', routeCount() === 0, JSON.stringify(state.routeLog));

// 8. 群組：沒被叫到、米亞保持安靜 → 不留紀錄；被叫到才留
console.log('\n── 四、群組：安靜的訊息不留紀錄 ──');
reset();
await fresh();
await dm('U7', '半導體先進封裝技術發表會的重點'); // 先讓 1:1 有一筆，確認群組不會被它影響
const q1 = qaCount(), r1 = routeCount();
await grp('C1', 'U8', '大家中午吃什麼');
check('★ 群組裡沒被叫到、也不是活動相關 → 米亞沒開口 → qa_log、route_log 都不留紀錄', qaCount() === q1 && routeCount() === r1, `qa=${qaCount() - q1} route=${routeCount() - r1}`);
state.routeForce = () => ({ intent: 'industry_trend', event_ids: [], confidence: 'high' });
await grp('C2', 'U9', '米亞 最近有什麼產業趨勢', { mention: true });
rl = last(state.routeLog) || [];
check('　 群組裡被叫到、問產業趨勢 → route_log 一列，scope 是 group', routeCount() === r1 + 1 && rl[1] === 'group' && rl[2] === 'industry_trend', JSON.stringify(rl));
state.routeForce = null;
await grp('C3', 'U10', '米亞 半導體先進封裝技術發表會的重點', { mention: true });
qa = last(state.qaAppended) || [];
check('　 群組裡被叫到、問活動 → qa_log：context_source 以 group/ 開頭', /^group\//.test(qa[13] || ''), JSON.stringify(qa.slice(8)));

console.log(`\n${fail ? '❌' : '✅'} 批次 195（決策紀錄：qa_log 八欄＋route_log）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
