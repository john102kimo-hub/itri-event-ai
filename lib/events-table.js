// 活動表（events 分頁）的共用讀取快取（批次 109）。
//
// 為什麼要有這支：Google Sheets 的讀取額度是「每個服務帳號每分鐘 60 次、全站共用」
// （lib/sheets.js、LINE-PLAN「坑 4」）。LINE 那條路早就自己有 60 秒快取，網頁這邊以前沒有：
//   ① 活動頁每開一次（api/events.js get_public）就讀一次 Sheets；
//   ② 網頁問答（api/chat.js）帶不存在的 event_id，每次都讀一次（找不到的不快取）；
//   ③ 媒體訓練（api/training.js）沒帶任何密碼，也會先讀 events 與整張 qa_log 才驗身分。
// 記者會現場同一分鐘開頁的人一多，額度就被這幾個入口用光，LINE 與問答跟著一起讀不到。
//
// 這支把「整張活動表」快取起來，而不是一個 id 一份：不存在的 id 也是在快取過的整張表裡
// 查不到，所以亂填 id 不會多打任何一次 Sheets（這是 per-id 快取做不到的）。
//
// 三個行為（都有測試，見 test/test-batch109.mjs）：
//   1. TTL 內直接回快取。預設 30 秒，跟「臨時改稿也要很快生效」的需求是同一個尺度。
//   2. 同一時間多個請求只讀一次（合併進行中的讀取）。快取剛過期那一刻有一百個請求進來，
//      不能變成一百次讀取——那正是額度被用光的樣子。
//   3. 讀取失敗（429、逾時）而手上有舊資料時，先用舊的、5 秒內不再重試，不讓一次額度用光
//      演變成每個請求都卡在重試裡。舊資料超過 10 分鐘就不用了，寧可明確報錯。
//
// 寫入端（api/events.js 的新增／更新／封存／刪除）一律呼叫 invalidateEventsTable()：
// 同一個 instance 內立刻生效；別的 instance 最多晚一個 TTL。
//
// ⚠️ 回傳的是共用陣列，呼叫端只能讀、不能改它（find／filter／map 都沒問題）。
// ⚠️ 管理員與同仁編輯（get／list_admin／get_edit／update_*）仍然直接讀 Sheets——
//    它們要看到最新內容，而且要有密碼或編輯碼才進得來。
import { readRange } from './sheets.js';

export const EVENTS_RANGE = 'events!A2:R';
export const EVENTS_TTL_MS = 30_000;
const MAX_STALE_MS = 10 * 60_000;
const FAIL_BACKOFF_MS = 5_000;

// 測試用：EVENTS_TABLE_TTL_MS=0 等於不快取（仍會合併同時進來的讀取）。執行時才讀，順序不會出錯。
function ttlMs() {
  const v = process.env.EVENTS_TABLE_TTL_MS;
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? EVENTS_TTL_MS : Number(v);
}

let slot = { rows: null, loadedAt: 0, expiry: 0, inflight: null };
// 每次寫入就加一：讀取進行到一半時有人寫入，那一次讀回來的是寫入前的資料，不能放進快取。
let epoch = 0;

export function invalidateEventsTable() {
  epoch++;
  slot = { rows: null, loadedAt: 0, expiry: 0, inflight: null };
}

export async function readEventRows({ fresh = false } = {}) {
  if (!fresh) {
    if (slot.rows && Date.now() < slot.expiry) return slot.rows;
    if (slot.inflight) return slot.inflight;
  }
  const myEpoch = epoch;
  const p = (async () => {
    try {
      const rows = await readRange(EVENTS_RANGE);
      if (myEpoch === epoch) slot = { rows, loadedAt: Date.now(), expiry: Date.now() + ttlMs(), inflight: slot.inflight };
      return rows;
    } catch (err) {
      if (myEpoch === epoch && slot.rows && Date.now() - slot.loadedAt < MAX_STALE_MS) {
        console.error('活動表讀取失敗，先沿用舊資料：', err.message);
        slot.expiry = Date.now() + FAIL_BACKOFF_MS;
        return slot.rows;
      }
      throw err;
    }
  })();
  if (!fresh) {
    slot.inflight = p;
    const clear = () => { if (slot.inflight === p) slot.inflight = null; };
    p.then(clear, clear);
  }
  return p;
}
