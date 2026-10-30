// 活動承辦人（批次 177）：這場活動的資料「由誰負責補」，活動前一天的提醒要推給誰。
//
// 為什麼是獨立的 event_owners 分頁，不是 events 表多一欄：events 表的欄位（A～R）在後台、同仁編輯頁、
// 垃圾桶、業發處匯入、測試假資料都各有一份寫死的欄位數，多一欄要同時動很多地方，漏一個就是整列被截掉。
// 承辦人只有 LINE 會讀寫，獨立一張表不碰那些。
//
// append-only、最後一列算數：認領、轉手都是再 append 一列，不改舊的——跟 event_changes 同一個做法，
// 誰在什麼時候把這場交給誰，之後查得到。

import { readRange, appendRows, ensureSheets } from './sheets.js';

export const OWNERS_RANGE = 'event_owners!A2:E';
const HEADER = ['活動 id', '承辦人 LINE ID', '承辦人姓名', '時間', '來源'];

// 成功才記住，失敗 60 秒後再試（理由同 lib/staff.js ensureStaffSheet()：失敗也記成已完成，
// 冷啟動撞到一次暫時性錯誤，這個 instance 就永遠建不起來）
let ensuredAt = 0;
async function ensureOwnersSheet() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60 * 1000) return;
  try { await ensureSheets({ event_owners: HEADER }); ensuredAt = Infinity; }
  catch (e) { console.error('ensureSheets(event_owners) 失敗，60 秒後再試:', e.message); ensuredAt = Date.now(); }
}

/** 活動 id → { userId, name }。讀不到（分頁還沒建、試算表忙碌）就是空的：沒有承辦人，提醒會改推給管理員。 */
export async function getOwnerMap() {
  let rows = [];
  try { rows = await readRange(OWNERS_RANGE); } catch { return new Map(); }
  const map = new Map();
  for (const r of rows || []) {
    if (r[0] && r[1]) map.set(r[0], { userId: r[1], name: r[2] || '' });
  }
  return map;
}

/** 寫入承辦人。成功回 true；寫不進去回 false（呼叫端要老實跟同仁說，不能讓他以為會被提醒）。 */
export async function setEventOwner(eventId, userId, userName = '', source = 'line') {
  if (!eventId || !userId) return false;
  await ensureOwnersSheet();
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    await appendRows('event_owners!A:E', [[eventId, userId, userName || '', now, source]]);
    return true;
  } catch (e) {
    console.error('寫入 event_owners 失敗:', e.message);
    return false;
  }
}
