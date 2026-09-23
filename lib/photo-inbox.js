// 同仁剛傳、還沒選場次的照片（批次 80）。
//
// ⚠️ 為什麼不存在 line_staff 的追問欄位裡：一次傳好幾張時，LINE 會一張一張送 webhook，
// 常常**同時**打到不同的 instance。舊版把整份清單存在同一格，兩邊同時「讀舊清單 → 加一張
// → 寫回去」，後寫的蓋掉先寫的，傳 5 張只加進去 3 張，而且沒有任何錯誤訊息。
// 改成每張照片 append 一列：append 不會互相蓋掉，選場次時再把這個人還沒用掉的全部撈出來。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';

const RANGE = 'line_photo_inbox!A2:D'; // LINE ID | messageId | 毫秒時戳 | 已用（'1'）
export const INBOX_TTL_MS = 10 * 60 * 1000; // 跟職員追問同一個時效
export const PHOTO_BATCH_MAX = 10;

let ensured = false;
async function ensureInbox() {
  if (ensured) return;
  try { await ensureSheets({ line_photo_inbox: ['LINE ID', 'messageId', '時間', '已用'] }); ensured = true; }
  catch (e) { console.error('ensureSheets(line_photo_inbox) 失敗:', e.message); }
}

// 這個人還沒用掉、還沒過期的照片：[{ rowNumber, messageId }]，舊的在前，最多 PHOTO_BATCH_MAX 張
export async function pendingPhotos(userId, now = Date.now()) {
  let rows = [];
  try { rows = await readRange(RANGE); } catch { return []; }
  return rows
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => r[0] === userId && r[3] !== '1' && now - Number(r[2]) <= INBOX_TTL_MS)
    .map(({ r, rowNumber }) => ({ rowNumber, messageId: r[1] }))
    .slice(-PHOTO_BATCH_MAX);
}

// 收一張。回傳目前累計幾張（含這張）。
export async function addPhoto(userId, messageId) {
  await ensureInbox();
  await appendRows('line_photo_inbox!A:D', [[userId, messageId, String(Date.now()), '']]);
  const list = await pendingPhotos(userId);
  // 剛 append 的那一列萬一還讀不到，至少算上這一張
  return Math.max(list.length, 1);
}

// 用掉（加進活動、或同仁說不用了）
export async function consumePhotos(items) {
  for (const it of items) {
    try { await updateRange(`line_photo_inbox!D${it.rowNumber}`, [['1']]); }
    catch (e) { console.error('標記照片已用失敗:', e.message); }
  }
}
