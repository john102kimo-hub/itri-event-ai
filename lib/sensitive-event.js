// 敏感場次（聲明稿、回應說明）的純判斷（批次 196，docs/mia-answer-quality-handoff-20261110.md 工單 B4）。
// 刻意獨立成一支、不 import 任何 LINE 相關檔案：發布前檢查（lib/event-status.js）與 LINE 答題都要用，
// 前者不該連帶載入推播。
import { kbSections } from './kb-template.js';

// 用一份明確的清單，寫法比照 lib/audience.js BUSINESS_EVENT_TYPES，不用「名稱含某字就算」——猜錯的方向是把一般記者會
// 當成敏感場次（多通知、少補查），或反過來把爭議場次漏掉，而且沒有人會發現。
// 活動類型是自由輸入的下拉選單（public/index.html、edit.html），
// 改這份清單時，那兩處的選項與提示文字一起改。
// 敏感場次在程式裡固定：不補查官網、不帶別場資料（跨場次）、不帶機構資料、每一題答不出來都通知（上限見 lib/no-data-handoff.js）。
export const SENSITIVE_EVENT_TYPES = ['聲明稿', '敏感新聞回應說明']; // 朱朱 11/10 定的名稱
const SENSITIVE_SET = new Set(SENSITIVE_EVENT_TYPES);
/** event 物件（看 event_type），或直接傳活動類型字串。 */
export function isSensitiveEvent(eventOrType) {
  const t = typeof eventOrType === 'string' ? eventOrType : eventOrType?.event_type;
  return SENSITIVE_SET.has(String(t || '').trim());
}

// 口徑外的固定說法：不加 events 表欄位（lib/event-owner.js 檔頭寫了原因：A～R 欄在很多地方寫死）。
// 口徑放知識庫裡，敏感場次的知識庫多一段【口徑外的問題】，公關寫一句固定說法；程式用 kbSections() 取出，
// 答不出來而且模型標的關鍵詞是「口徑外」時，原樣接在回覆後面（lib/line-reporter.js answerQuestion()）。
export const OUT_OF_SCOPE_HEADING = '口徑外的問題';
export const OUT_OF_SCOPE_KEYWORD = '口徑外';
/** 知識庫裡【口徑外的問題】那一段的原文（沒有或沒寫就是空字串）。 */
export function outOfScopeStatement(kb) {
  const sec = kbSections(kb).find((s) => s.heading === OUT_OF_SCOPE_HEADING);
  return sec ? sec.content.join('\n').trim() : '';
}

/** 【常見問答 Q&A】有沒有真的寫了問答（只有「Q：」「A：」空標籤不算）。 */
export function hasPreparedQa(kb) {
  const sec = kbSections(kb).find((s) => /^常見問答/.test(s.heading));
  return !!sec && sec.content.length > 0;
}
