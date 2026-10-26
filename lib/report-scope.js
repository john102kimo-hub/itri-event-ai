// 成效報告的口徑：哪些問答算「這場活動的成效」（批次 166）。
//
// 緣起（朱朱看互動簡報）：「最多的使用的名稱是 hi，一看就知道是測試的，還有一些一眼看過去就知道是假的」。
// 對過正式資料之後，問題不只是一個「hi」——每一場活動「辦之前」都有一段同仁測試期，「結束很久之後」
// 也有同仁拿舊活動試新功能，那些問答全被當成記者在問：
//   · 晶鏈論壇 9/1 辦：8/28–8/31 是群組提問、TEST、測試、hi×7、Teat；9/1 當天才是中央社、經濟日報、公視…
//   · SEMICON 9/2 辦：8/27–9/1 是「給我完整新聞稿」×N、VVV、。。、XXX
//   · 創新日 9/15 辦：9/9–9/14 是測試、給我完整新聞稿、群組提問；9/15 當天才是真的記者
//   · 四足 7/8 辦：8/5–8/25 全是測試，其中 8/24 兩分鐘內連打「工商時報、天下雜誌、中央社、電子時報、今周刊」
//   · 眺望 10/28 才辦：9/23 起的 57 筆全是上線前測試
// 媒體名稱的規則（lib/media-name.js isTestMedia）抓得到「測試」「hi」，抓不到同仁隨手打的真媒體名。
// 時間抓得到：所以成效報告只算「活動當天起 REPORT_WINDOW_DAYS 天內」的問答。
//
// 只給成效報告（/report、互動簡報）與部會唯讀頁（lib/impact.js）用。後台首頁、問答分析照舊看全部——
// 那兩個是當天監看用的，活動前的測試問答也要看得到。
import { eventDateOf } from './event-status.js';

// 7 天：會後 72 小時（LINE-PLAN 第 0 節網頁問答的使用情境）再多留幾天給跟進報導。
// 正式資料裡活動結束一週之後的問答，看到的都是同仁的內部測試。
export const REPORT_WINDOW_DAYS = 7;

// qa_log 的時間戳是 toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })：「2026/9/1 上午7:59:34」
export function qaDateOf(ts) {
  const m = String(ts || '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

function addDays(iso, n) {
  const t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 這一則問答（時間戳）落在這場活動的成效期間內。活動沒有正式日期（只有建立時間戳）、或時間戳讀不出日期，就不限——判斷不了的不丟。 */
export function inReportWindow(eventDateRaw, ts) {
  const start = eventDateOf(eventDateRaw);
  if (!start) return true;
  const day = qaDateOf(ts);
  if (!day) return true;
  return day >= start && day <= addDays(start, REPORT_WINDOW_DAYS - 1);
}

// 測試用的活動（正式資料裡有：test、pwtest、測試活動、測試 技術洽談、測試活動-請忽略可刪除-驗證用、10/29測試）。
// 英文只認整個名稱就是 test／demo——「Contest」「Test Bed」這種真的活動名稱不能被誤殺。
export function isTestEventName(name) {
  const s = String(name || '').trim();
  return /測試|請忽略|可刪除|驗證用/.test(s) || /^(pw)?test\d*$|^demo$/i.test(s);
}

/**
 * 依活動表組出口徑。eventRows 是 events!A2:R 的列（lib/events-table.js readEventRows()）。
 * 活動表讀不到（空陣列）時只看時間戳以外的規則都不套——寧可多算，也不要整份報告變成空的。
 */
export function buildReportScope(eventRows) {
  const byId = new Map((eventRows || []).filter((r) => r && r[0]).map((r) => [r[0], r]));
  const known = byId.size > 0;
  return {
    /** 這場活動要不要出現在成效報告：已刪除（不在活動表）、草稿、測試活動都不算 */
    includesEvent(eventId) {
      if (!known) return true;
      const r = byId.get(eventId);
      if (!r) return false;
      if ((r[4] || 'active') === 'draft') return false;
      return !isTestEventName(r[1]);
    },
    /** 這一則問答算不算：活動要算、而且在活動當天起的期間內 */
    includesQa(eventId, ts) {
      if (!this.includesEvent(eventId)) return false;
      const r = byId.get(eventId);
      return r ? inReportWindow(r[5], ts) : true;
    },
    /** 活動現在的名稱（改過名的話，qa_log 裡存的是當時的舊名） */
    nameOf(eventId) { return byId.get(eventId)?.[1] || ''; },
    dateOf(eventId) { return eventDateOf(byId.get(eventId)?.[5]); }
  };
}
