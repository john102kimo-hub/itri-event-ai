// 米亞（LINE）跟業發處合作洽詢有關的兩件事（批次 119）。資料層在 lib/b2b.js。
//
//   ① 「企業合作洽詢」只指路：回一句話＋洽詢單網址，不在聊天室裡收任何企業資料（公司、需求、聯絡方式）。
//      米亞的定位是媒體窗口（LINE-PLAN.md 第 0 節），這個帳號的對話紀錄也不是存客戶資料的地方。
//      只認「整句就是在問怎麼洽談合作」的講法——記者問「工研院跟台積電的技術合作」是新聞題，不能被攔走。
//      業發處沒設定（B2B_SPREADSHEET_ID）或洽詢單暫停收件時完全不攔，米亞的行為跟以前一樣。
//   ② 業務窗口綁定 LINE 通知：後台按「綁定 LINE 通知」→ 米亞收到「#業務 M7K3Q-K8PQ2X」→ 之後新的洽詢、
//      期限提醒推到這個 LINE。檢查碼從成員的個人連結算出來，猜不到；失敗一天 5 次就先停手。

import { replyOrPush, HOME_MENU, SITE } from './line-runtime.js';
import { b2bConfigured, loadSettings, intakeOpen, slaDays, bindMemberLine } from './b2b.js';
import { createLimiter } from './rate-limit.js';

const PARTNERSHIP_RE = new RegExp(
  '^(?:請問|想請問|我想|我要|我們想)?\\s*(?:' + [
    '(?:企業|技術|產學|產業)?合作洽(?:詢|談)',
    '(?:技術授權|技術移轉|技轉|委託研究|委託開發)(?:洽詢|洽談|怎麼談|要找誰|找誰)',
    '(?:要|想要|想)?(?:怎麼|如何)?(?:跟|和|與)工研院(?:談|洽談)?合作(?:要找誰|找誰|窗口|管道)?'
  ].join('|') + ')[?？。!！～~]*$'
);
/** 整句就是在問「怎麼跟工研院洽談合作」（不是在問某一則合作新聞）。 */
export function isPartnershipAsk(text) {
  return PARTNERSHIP_RE.test(String(text || '').replace(/\s+/g, '').trim());
}

/** 回洽詢單網址。業發處沒設定、或暫停收件時回 false（呼叫端照原本的路徑走）。 */
export async function handlePartnershipAsk(replyToken, targetId) {
  if (!b2bConfigured()) return false;
  let cfg;
  try { cfg = await loadSettings(); } catch (e) { console.error('[b2b] 讀設定失敗，合作洽詢照原路徑:', e.message); return false; }
  if (!intakeOpen(cfg)) return false;
  await replyOrPush(replyToken, targetId,
    `謝謝您對工研院技術合作的興趣 🙂\n\n合作洽詢由業務窗口專人處理，我這邊不收資料。請填這份洽詢單（約 2 分鐘），業務窗口會在 ${slaDays(cfg)} 個工作天內與您聯繫：\n${SITE}/inquiry`,
    HOME_MENU);
  return true;
}

const B2B_BIND_RE = /^[#＃]\s*業務\s*[:：]?\s*(M[A-Za-z0-9]{5})\s*[-－]\s*([A-Za-z0-9]{6})\s*$/i;
/** 「#業務 M7K3Q-K8PQ2X」→ { memberId, check }；不是這種格式回 null。要排在一般「#活動代碼」之前判斷。 */
export function parseB2BBind(text) {
  const m = String(text || '').trim().match(B2B_BIND_RE);
  return m ? { memberId: m[1].toUpperCase(), check: m[2].toUpperCase() } : null;
}

const bindFails = createLimiter({ windowMs: 24 * 3600e3, max: 5 });
export async function handleB2BBind(replyToken, userId, { memberId, check }) {
  if (bindFails.blocked(userId)) {
    await replyOrPush(replyToken, userId, '綁定的嘗試次數太多了，請明天再試，或請業發處管理員協助。');
    return;
  }
  if (!b2bConfigured()) {
    await replyOrPush(replyToken, userId, '業發處的合作洽詢系統還沒啟用，暫時不能綁定。');
    return;
  }
  const r = await bindMemberLine(memberId, check, userId);
  if (!r.ok) {
    bindFails.hit(userId);
    await replyOrPush(replyToken, userId, '這個綁定碼對不上（可能連結已經重發過）。請回到業務後台，重新按一次「綁定 LINE 通知」。');
    return;
  }
  await replyOrPush(replyToken, userId,
    `${r.already ? '這個 LINE 早就綁定好了' : '綁定完成'} ✅ ${r.member.name} 您好\n\n之後分給您的合作洽詢、期限提醒，都會推到這裡（只會寫編號與期限，詳細內容請到業務後台看）。`);
}
