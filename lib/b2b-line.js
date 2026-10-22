// 米亞（LINE）跟業發處合作洽詢有關的兩件事（批次 119）。資料層在 lib/b2b.js。
//
//   ① 「企業合作洽詢」只指路：回一句話＋洽詢單網址，不在聊天室裡收任何企業資料（公司、需求、聯絡方式）。
//      米亞的定位是媒體窗口（LINE-PLAN.md 第 0 節），這個帳號的對話紀錄也不是存客戶資料的地方。
//      只認「整句就是在問怎麼洽談合作」的講法——記者問「工研院跟台積電的技術合作」是新聞題，不能被攔走。
//      業發處沒設定（B2B_SPREADSHEET_ID）或洽詢單暫停收件時完全不攔，米亞的行為跟以前一樣。
//   ② 業務窗口綁定 LINE 通知：後台按「綁定 LINE 通知」→ 米亞收到「#業務 M7K3Q-K8PQ2X」→ 之後新的洽詢、
//      期限提醒推到這個 LINE。檢查碼從成員的個人連結算出來，猜不到；失敗一天 5 次就先停手。

import { replyOrPush, HOME_MENU, SITE } from './line-runtime.js';
import { b2bConfigured, loadSettings, intakeOpen, slaDays, bindMemberLine, unbindMemberLine } from './b2b.js';
import { createLimiter } from './rate-limit.js';

// 批次 145：放寬成廠商常見的講法（「我們公司想跟工研院合作」「想洽談技術合作」「合作窗口」「我是 OO 廠商想洽詢合作」
// 「想委託工研院開發」「我想技轉」）。仍然是**整句吻合**：記者的新聞題（「工研院跟台積電合作的新聞」「這場有合作廠商嗎」）
// 一定帶著別的字，對不上。刻意不收單獨的「產學合作」「技術合作」——那是記者常打的新聞關鍵字，不是要洽談。
const PARTNER_SUBJECT = '(?:(?:我們|我|本|敝)(?:公司|廠商|企業|單位)?|(?:我|我們)是[^，,。！!？?]{0,20}?(?:公司|廠商|企業)的?)?[，,、]?';
const PARTNER_WANT = '(?:請問|想請問|想要|想|希望|要)?';
const PARTNERSHIP_RE = new RegExp(
  '^' + PARTNER_SUBJECT + PARTNER_WANT + '(?:' + [
    '(?:企業|技術|產學|產業)?合作洽(?:詢|談)',
    '(?:技術授權|技術移轉|技轉|委託研究|委託開發)(?:洽詢|洽談|怎麼談|要找誰|找誰)',
    '(?:要|想要|想)?(?:怎麼|如何)?(?:跟|和|與)工研院(?:談|洽談)?合作(?:要找誰|找誰|窗口|管道)?',
    '(?:跟|和|與)?(?:工研院)?(?:洽詢|洽談|談|討論)(?:技術|產學|業務|企業)?合作(?:的?(?:事宜|機會))?',
    '(?:技術|產學|企業|產業)?合作(?:的)?(?:窗口|管道)(?:是誰|在哪|有哪些)?',
    // 單獨的「技轉」「授權」可能是記者的新聞關鍵字，要帶「想／要」才算
    '(?:想|想要|要)(?:技轉|技術移轉|取得授權|授權)(?:工研院的?[^，,。？?]{0,12}?技術)?',
    '授權工研院的?[^，,。？?]{0,12}?技術',
    '委託工研院(?:開發|研究|做研究)'
  ].join('|') + ')[?？。!！～~]*$'
);
const GREETING_PREFIX_RE = /^(?:(?:你好|您好|哈囉|哈嘍|嗨|hi|hello|hey|早安|午安|晚安|不好意思|打擾了)[，,。.！!～~、]*)+/i;
/** 整句就是在問「怎麼跟工研院洽談合作」（不是在問某一則合作新聞）。 */
export function isPartnershipAsk(text) {
  // 開頭的招呼語先拿掉再比（批次 144 走查：廠商第一句常是「你好，我想跟工研院談合作」，整句比對認不得）。
  // 句型刻意要整句吻合，才不會把「工研院跟台積電合作的新聞」這種記者提問攔走。
  const s = String(text || '').replace(/\s+/g, '').replace(GREETING_PREFIX_RE, '');
  return PARTNERSHIP_RE.test(s);
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

// 「取消綁定」（批次 160）：整句就是這個意思才算（「取消綁定」「解除綁定」「取消通知」「取消 LINE 通知」…）。
// 只有這個 LINE 真的綁著成員才處理；沒綁過的人（記者、一般使用者）打同一句，照原本的路徑走，不會被攔走。
const UNBIND_PHRASES = new Set(['取消綁定', '解除綁定', '解綁', '取消綁定通知', '解除綁定通知', '取消綁定line通知', '解除綁定line通知',
  '取消通知', '取消line通知', '解除通知', '停止通知', '關閉通知', '不要通知', '取消推播', '停止推播']);
export function isUnbindAsk(text) {
  const s = String(text || '').replace(/\s+/g, '').toLowerCase().replace(/^(?:我要|我想|請|麻煩)/, '').replace(/[。.!！～~]+$/, '');
  return UNBIND_PHRASES.has(s);
}
export async function handleB2BUnbind(replyToken, userId) {
  if (!b2bConfigured()) return false;
  let r;
  try { r = await unbindMemberLine(userId); }
  catch (e) { console.error('[b2b] 取消綁定失敗，照原路徑:', e.message); return false; }
  if (!r.ok) return false;
  await replyOrPush(replyToken, userId,
    `已取消綁定 ✅ ${r.members.map((m) => m.name).join('、')} 您好\n\n之後的合作洽詢與期限提醒不會再推到這個 LINE（洽詢仍然會在企業洽案管理的收件匣裡）。\n要再收通知，請到企業洽案管理按「綁定 LINE 通知」重新綁定。`);
  return true;
}

const bindFails = createLimiter({ windowMs: 24 * 3600e3, max: 5 });
export async function handleB2BBind(replyToken, userId, { memberId, check }) {
  if (bindFails.blocked(userId)) {
    await replyOrPush(replyToken, userId, '綁定的嘗試次數太多了，請明天再試，或請企業洽案管理員協助。');
    return;
  }
  if (!b2bConfigured()) {
    await replyOrPush(replyToken, userId, '企業洽案管理系統還沒啟用，暫時不能綁定。');
    return;
  }
  const r = await bindMemberLine(memberId, check, userId);
  if (!r.ok) {
    bindFails.hit(userId);
    await replyOrPush(replyToken, userId, '這個綁定碼對不上（可能連結已經重發過）。請回到企業洽案管理，重新按一次「綁定 LINE 通知」。');
    return;
  }
  await replyOrPush(replyToken, userId,
    `${r.already ? '這個 LINE 早就綁定好了' : '綁定完成'} ✅ ${r.member.name} 您好\n\n之後分給您的合作洽詢、期限提醒，都會推到這裡（只會寫編號與期限，詳細內容請到企業洽案管理看）。\n不想收通知了，傳「取消綁定」給我就好。`);
}
