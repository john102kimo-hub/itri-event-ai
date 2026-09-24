// LINE 官方帳號的入口連結（批次 82）。
//
// LINE-PLAN.md 第 7 節「記者端的入口」早就寫好了做法：每一場給一個
// `https://line.me/R/oaMessage/{LINE_BASIC_ID}/?%23{活動代碼}` 的 QR——記者掃了直接打開
// 米亞的聊天室、輸入框已經帶好「#代碼」，按送出就接上這一場（api/line.js 的 #代碼綁定）。
// SETUP.md 也要承辦人設好 LINE_BASIC_ID「給後台產生 QR 用」。**但從來沒有任何一支程式
// 用到這個變數**——後台沒有 QR、沒有連結，承辦人得自己手組網址、自己找工具做 QR，
// 組錯一個字元（忘了 %23、@ 沒編碼）記者掃了就接不上。
//
// 純函式、不碰網路；api/events.js（後台與記者頁）共用。

function basicId() {
  const raw = String(process.env.LINE_BASIC_ID || '').trim();
  if (!raw) return '';
  return raw.startsWith('@') ? raw : '@' + raw;
}

/** 打開米亞的聊天室、輸入框預先帶好「#活動代碼」。沒設定 LINE_BASIC_ID 時回空字串。 */
export function lineBindUrl(eventId) {
  const id = basicId();
  if (!id || !eventId) return '';
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent('#' + eventId)}`;
}

/** 單純加好友（同仁加入職員模式、平時的記者入口用）。沒設定時回空字串。 */
export function lineAddFriendUrl() {
  const id = basicId();
  return id ? `https://line.me/R/ti/p/${encodeURIComponent(id)}` : '';
}

export function lineBasicId() {
  return basicId();
}
