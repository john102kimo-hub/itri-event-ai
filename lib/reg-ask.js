// 報名頁右下角的米亞問答「能不能出現」（批次 213）。
//
// 頁面本身不判斷：只有這支回了活動代碼，報名頁才畫得出圖示（CLAUDE.md 第 2 條——絕對不能發生的事擋在程式出口）。
// 問答本身完全沿用活動問答頁（public/event.html?embed=1 → api/chat.js），這裡只多一道「要不要在報名頁主動端出來」的門。
//
// 這道門刻意比活動問答頁嚴：問答頁的網址是同仁自己決定要不要發出去的，報名頁卻是**活動前**就寄給記者的邀請函連結，
// 掛上圖示等於主動邀請提問。所以下面任一種情況都不顯示：
//   ① 報名沒有關聯活動，或關聯的活動找不到
//   ② 活動沒發布（草稿、封存；只認 PUBLIC_STATUSES）
//   ③ 敏感場次（聲明稿、回應說明）
//   ④ 企業場（報名對象或活動類型任一是企業）：技術與合作內容只給受邀企業，要開放再另外決定
//   ⑤ 未解禁：還沒標「已結束」，而且（沒填活動日期）或（活動日還沒到、又沒有媒體邀請函——這時問答會用整份知識庫回答）
//     活動日前有邀請函的照常顯示：api/chat.js 的 resolveEventContent() 只拿邀請函回答。
// 對外只回活動代碼，不回任何活動內容，也不說是哪一個理由被擋。
import { getCampaign, audienceOf } from './registration.js';
import { readEventRows } from './events-table.js';
import { PUBLIC_STATUSES, eventDateOf, taipeiToday } from './event-status.js';
import { isSensitiveEvent } from './sensitive-event.js';
import { isBusinessEvent } from './audience.js';

/** 活動表的一列（A～R，欄位同 api/events.js）能不能在報名頁提供問答。純函式。 */
export function canAskOnRegisterPage(row, todayIso = taipeiToday()) {
  if (!row || !row[0]) return false;
  const status = row[4] || 'active';
  if (!PUBLIC_STATUSES.includes(status)) return false;
  if (isSensitiveEvent(row[13]) || isBusinessEvent(row[13])) return false;
  if (status === 'ended') return true;
  const date = eventDateOf(row[5]);
  if (!date) return false;
  return date <= todayIso || !!String(row[16] || '').trim();
}

/** 回 { event_id } 或 null。任何一步出錯都回 null：問答是加分項，不能讓報名頁跟著壞。 */
export async function askForCampaign(campaignId) {
  try {
    const c = await getCampaign(campaignId);
    if (!c || !c.event_id || audienceOf(c) === 'business') return null;
    const row = (await readEventRows()).find((r) => r[0] === c.event_id);
    return canAskOnRegisterPage(row) ? { event_id: row[0] } : null;
  } catch (e) {
    console.error('[reg-ask] 查報名頁問答失敗（當作不提供）:', e.message);
    return null;
  }
}
