// 每一題的決策紀錄（批次 195，docs/mia-answer-quality-handoff-20261110.md 工單 A）。
//
// 為什麼要有這支：「這一題答得怎麼樣」以前只藏在回答的措辭裡（「這部分我沒有資料」），後台的「疑似答不出來」、
// 待教清單、評測都靠比對那幾個字。措辭一改，三個一起瞎掉。另外 LINE 只有活動問答會寫 qa_log，產業趨勢、
// 工研院技術、活動清單、兜底引導完全沒有紀錄——記者問活動卻被判去產業趨勢，後台看不到這一題存在過。
//
// 兩份紀錄，各管一件事（不要混）：
//   ① qa_log 從 J 欄往後加欄位（A～I 不動，所有讀取端都是寫死範圍）：這一題**是怎麼答的**。
//   ② route_log 新分頁：米亞有回、但**沒進 qa_log** 的訊息各一列（路由判成什麼、走了哪條路）。
//      ⚠️ 不要把路由紀錄寫進 qa_log 當一題：後台「累積回答題數」會灌水（批次 84 修過同一件事）。
//
// 怎麼把路由結果帶到寫入點：不改幾十個呼叫端的參數。每則事件各開一個 trace（AsyncLocalStorage），
// 路由判完的地方 setTrace()，寫 qa_log 的地方讀出來。lib/line.js 在「真的有送出訊息」時 markReplied()，
// 所以群組裡米亞保持安靜的訊息不會留下紀錄（那是別人的聊天）。
//
// 這支刻意不 import 任何 LINE 相關檔案（lib/line.js 要 import 它，反過來會繞圈）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';

/** qa_log J～Q 欄的表頭（A～I 是既有欄位，見 lib/qa-log.js） */
export const QA_EXTRA_HEADER = [
  'answer_status', 'intent', 'routed_event_ids', 'confidence', 'context_source', 'kb_source', 'no_data_keyword', 'grounding_flags',
];
/** route_log 分頁的表頭 */
export const ROUTE_LOG_HEADER = ['time', 'scope', 'intent', 'routed_event_ids', 'confidence', 'path', 'question'];

/** answer_status 的合法值。「疑似答不出來」只算 no_data、no_data_news（見 lib/teach-queue.js isUnansweredRow()） */
export const ANSWER_STATUS = ['answered', 'no_data', 'no_data_news', 'refused', 'contact'];
export const NO_DATA_STATUSES = new Set(['no_data', 'no_data_news']);

const traceStore = new AsyncLocalStorage();

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stampNow = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

/**
 * 這則事件的 trace：在 fn 執行期間（含它 await 的一切）setTrace()／markReplied() 都寫到這一份。
 * fn 結束（成功或丟例外）後，若米亞有回、而且沒進 qa_log，補一列 route_log。
 * init：{ scope: '1:1' | 'group', question }。每則事件各開一份，前一則的狀態不會漏到下一則。
 */
export async function runTraced(init, fn) {
  const t = { scope: '', question: '', replied: false, qaLogged: false, internal: false, ...init };
  return traceStore.run(t, async () => {
    try { return await fn(); }
    finally { await flushRouteLog(t); }
  });
}

/** 把路由結果等資訊記進這則事件的 trace（沒有 trace，例如測試直接呼叫答題函式時，什麼都不做） */
export function setTrace(patch) {
  const t = traceStore.getStore();
  if (t && patch) Object.assign(t, patch);
}
export const getTrace = () => traceStore.getStore() || null;
/** lib/line.js：真的有訊息送出去（reply／push 成功）才呼叫 */
export function markReplied() { const t = traceStore.getStore(); if (t) t.replied = true; }
/** 寫完 qa_log 就不用再寫 route_log（同一題不兩邊都記） */
export function markQaLogged() { const t = traceStore.getStore(); if (t) t.qaLogged = true; }
/** 職員／同仁模式：問的是後台資料，不是記者的提問，不進 route_log */
export function markInternal() { const t = traceStore.getStore(); if (t) t.internal = true; }

/**
 * 這一題答得怎麼樣。優先序：邀訪窗口 ＞ 拒答 ＞ 沒資料 ＞ 一般。
 * noData＝模型標了 NO_DATA 關鍵詞、或回覆的句型像「我沒有這項資料」（見 lib/line-nodata.js）；
 * newsHint＝補查官網真的查到東西接在答案後面。
 */
export function answerStatusOf({ contact = false, refused = false, noData = false, newsHint = false } = {}) {
  if (contact) return 'contact';
  if (refused) return 'refused';
  if (noData) return newsHint ? 'no_data_news' : 'no_data';
  return 'answered';
}

/** 答案出口檢查（checkAnswerGrounding）標出的東西，壓成一格短字串：n=數字 u=網址 t=英文名詞 */
export function groundingFlagsText(g) {
  if (!g) return '';
  const part = (k, arr) => (Array.isArray(arr) && arr.length ? `${k}:${arr.slice(0, 5).map((x) => clip(typeof x === 'string' ? x : (x?.text ?? x?.value ?? JSON.stringify(x)), 30)).join(',')}` : '');
  return clip([part('n', g.numbers), part('u', g.urls), part('t', g.terms)].filter(Boolean).join('|'), 200);
}

/**
 * qa_log J～Q 欄那 8 格。路由相關的（intent、場次、把握度、怎麼選到這場）從 trace 讀；
 * 這一題自己才知道的（狀態、資料來源、關鍵詞、出口檢查）由呼叫端傳進來。
 * context_source：`<1:1|group>/<怎麼選到這場>`，後面的值：bound 綁定中、route 路由命中、switch 路由自動換場、
 * pick 清單點名、date 只打日期、button 按鈕；發問者自己有上一題可接時再加「+prev」。
 */
export function qaExtraCells({ status = 'answered', kb = 'kb', keyword = '', flags = '', prev = false, scope } = {}) {
  // scope：網頁版（沒有 trace）傳 'web'；LINE 從 trace 讀（1:1 或 group）
  const t = { ...(traceStore.getStore() || {}), ...(scope ? { scope } : {}) };
  const how = t.context || '';
  const context = [t.scope, how].filter(Boolean).join('/') + (prev ? '+prev' : '');
  return [
    status,
    clip(t.intent || 'qa', 20),
    clip((t.event_ids || []).join(','), 80),
    clip(t.confidence || '', 10),
    clip(context, 40),
    clip(kb, 80),
    clip(keyword, 20),
    clip(flags, 200),
  ];
}

// ── 寫入 ────────────────────────────────────────────────────────────────

let qaHeaderEnsuredAt = 0;
/** qa_log J1:Q1 沒有表頭就補上。失敗只記 log（60 秒後再試），不擋寫入。 */
export async function ensureQaLogHeader() {
  if (qaHeaderEnsuredAt === Infinity) return;
  if (Date.now() - qaHeaderEnsuredAt < 60_000) return;
  try {
    const have = await readRange('qa_log!J1:Q1');
    if (!have[0] || !have[0].some((c) => String(c || '').trim())) await updateRange('qa_log!J1:Q1', [QA_EXTRA_HEADER]);
    qaHeaderEnsuredAt = Infinity;
  } catch (e) {
    console.error('qa_log 補表頭失敗，60 秒後再試:', e.message);
    qaHeaderEnsuredAt = Date.now();
  }
}

let routeSheetEnsuredAt = 0;
async function ensureRouteLogSheet() {
  if (routeSheetEnsuredAt === Infinity) return;
  if (Date.now() - routeSheetEnsuredAt < 60_000) return;
  try { await ensureSheets({ route_log: ROUTE_LOG_HEADER }); routeSheetEnsuredAt = Infinity; }
  catch (e) { console.error('ensureSheets(route_log) 失敗，60 秒後再試:', e.message); routeSheetEnsuredAt = Date.now(); }
}

/** 測試用：清掉「已經確認過表頭／分頁」的記憶 */
export function __resetEnsured() { qaHeaderEnsuredAt = 0; routeSheetEnsuredAt = 0; }

async function flushRouteLog(t) {
  try {
    if (!process.env.GOOGLE_SPREADSHEET_ID) return;
    if (!t.replied || t.qaLogged || t.internal || !t.question) return;
    await ensureRouteLogSheet();
    await appendRows('route_log!A:G', [[
      stampNow(), t.scope || '1:1',
      clip(t.intent || 'rule', 20),            // rule＝規則層直接處理，沒問路由（閒聊、按鈕、清單）
      clip((t.event_ids || []).join(','), 80), clip(t.confidence || '', 10),
      clip(t.path || 'rule', 40), clip(t.question, 60),
    ]]);
  } catch (e) {
    console.error('route_log 寫入失敗:', e.message); // 寫失敗不能擋回覆（回覆早就送出去了）
  }
}
