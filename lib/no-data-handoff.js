// 答不出來時，「程式接上去」的那一半（批次 196，docs/mia-answer-quality-handoff-20261110.md 工單 B2～B4）。
//
// 講法（接住 → 能說的先說 → 講界線）是 prompt 的事，偶爾沒照做不會出事（lib/line-format.js LINE_NO_DATA_RULE）。
// 但下面三件事偶爾沒照做會出事，所以寫成程式、擋在出口（CLAUDE.md 第 2 條）：
//   ① 「我已經轉給同仁了」這句話必須是真的——推播成功才由程式接上，模型不准自己寫（以前的 11/10 截圖：米亞說「請洽朱則瑋」，
//      朱則瑋不知道有人被擋下來；即時通知只有記者自己打「找真人」才會發）。
//   ② 聯絡人的姓名電話錯一碼就找不到人。
//   ③ 口徑外的固定說法會被截圖，要公關寫好的原文，不經模型改寫。
//
// 這支只放純邏輯與推播，不 import lib/line-reporter.js（它 import 這支）。

import { pushMessage } from './line.js';
import { getOwnerMap } from './event-owner.js';
import { sanitize } from './line-format.js';

// 敏感場次與口徑外固定說法的判斷在 lib/sensitive-event.js（純函式，發布前檢查也要用）；這裡 re-export，呼叫端只 import 這一支。
export { SENSITIVE_EVENT_TYPES, isSensitiveEvent, OUT_OF_SCOPE_HEADING, OUT_OF_SCOPE_KEYWORD, outOfScopeStatement } from './sensitive-event.js';

// ── 通知的上限（B2.4）─────────────────────────────────────────────────────
// 推播額度是全帳號共用的（記者、業發處、提醒都在用），所以一定要有上限：
//   · 同一個對話 10 分鐘內只通知一次（敏感場次不受這條限制：每一題都要讓公關看到）
//   · 每場每小時最多 N 次（敏感場次另設較高的上限）
//   · 全站每天最多 N 次
// 超過就只記不推（qa_log 的 answer_status 本來就記了，後台「疑似答不出來」數得到）。
// ⚠️ 上限值是暫定，請朱朱決定（交接文件第六節第 3 點）；環境變數可以不改程式就調整：
//   NODATA_NOTIFY_EVENT_PER_HOUR（預設 5）、NODATA_NOTIFY_SENSITIVE_PER_HOUR（預設 20）、NODATA_NOTIFY_PER_DAY（預設 30）；設 0＝不推。
// ⚠️ 計數放在這台機器的記憶體裡（best-effort，同 lib/line-reporter.js 的 humanNotified）：Vercel 可能同時有好幾個執行個體，
// 實際上限最多是設定值乘以執行個體數；寧可偶爾多推一則，也不要為了精準去多讀寫一次 Sheets。
export const CONVERSATION_GAP_MS = 10 * 60 * 1000;
const envNum = (name, dflt) => {
  const raw = String(process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const notifyLimits = () => ({
  perEventHour: envNum('NODATA_NOTIFY_EVENT_PER_HOUR', 5),
  perEventHourSensitive: envNum('NODATA_NOTIFY_SENSITIVE_PER_HOUR', 20),
  perDay: envNum('NODATA_NOTIFY_PER_DAY', 30),
});
const convSent = new Map();   // 對話（targetId）→ 最後一次通知的時間
const eventSent = new Map();  // 活動 id → 一小時內通知的時間們
const day = { key: '', n: 0 };
/** 測試用：清掉所有計數 */
export function __resetNotifyState() { convSent.clear(); eventSent.clear(); day.key = ''; day.n = 0; }
const dayKey = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

/**
 * 答不出來時通知公關同仁（管理員，有活動負責人就一併通知）。
 * 回傳 { forwarded, sentNow, reason }：
 *   forwarded＝「這題公關已經知道了」是真的（這次推成功，或這個對話 10 分鐘內已經推過）——尾巴能不能說「已轉告」只看這個
 *   sentNow＝這一次真的推出去了
 */
export async function notifyUnanswered({ event, text, targetId, speakerId = '', group = false, sensitive = false, outOfScope = false, requested = false, now = Date.now() }) {
  // 對話的 key：群組要連發問的人一起算——同一個群組裡甲被通知過，乙問了另一題答不出來的，乙的題目還沒有人看到，不能對乙說「已轉告」
  const convKey = group ? `${targetId}|${speakerId}` : targetId;
  const recent = (convSent.get(convKey) || 0) > now - CONVERSATION_GAP_MS;
  // requested＝記者自己回了「是」（批次 197）：他明講要找人，不能因為這個對話 10 分鐘內通知過別題就跳過；上限（每場、每天）照舊
  if (recent && !sensitive && !requested) return { forwarded: true, sentNow: false, reason: 'recent' };

  const asker = speakerId || targetId;
  const recipients = new Set();
  if (process.env.LINE_ADMIN_USER_ID) recipients.add(process.env.LINE_ADMIN_USER_ID);
  try {
    const owner = (await getOwnerMap()).get(event?.id);
    if (owner?.userId) recipients.add(owner.userId);
  } catch { /* 讀不到負責人就只推管理員 */ }
  recipients.delete(asker); // 同仁自己試問，不要通知他自己
  if (!recipients.size) return { forwarded: recent, sentNow: false, reason: 'no-recipient' };

  const lim = notifyLimits();
  const hourAgo = now - 60 * 60 * 1000;
  const evKey = event?.id || '-';
  const evTimes = (eventSent.get(evKey) || []).filter((t) => t > hourAgo);
  eventSent.set(evKey, evTimes);
  if (evTimes.length >= (sensitive ? lim.perEventHourSensitive : lim.perEventHour)) {
    console.log(`[nodata-notify] 略過（這場一小時內已通知 ${evTimes.length} 次）event=${evKey}`);
    return { forwarded: recent, sentNow: false, reason: 'event-cap' };
  }
  const dk = dayKey(now);
  if (day.key !== dk) { day.key = dk; day.n = 0; }
  if (day.n >= lim.perDay) {
    console.log(`[nodata-notify] 略過（全站今天已通知 ${day.n} 次）`);
    return { forwarded: recent, sentNow: false, reason: 'day-cap' };
  }

  const body = `${requested ? '🙋 有記者請米亞轉介真人' : '🙋 有人問了米亞答不出來的問題'}\n${group ? '（在群組裡）' : ''}《${event?.name || '（未知場次）'}》${sensitive ? '〔敏感場次〕' : ''}${outOfScope ? '〔口徑以外〕' : ''}\n` +
    `原話：「${sanitize(text, 100)}」\n\n` +
    (group ? (requested ? '記者在群組裡請米亞轉介真人；請同仁視情況聯絡他。' : '這題在群組裡，米亞只說明了界線；請同仁視情況處理。') : '可以到 LINE 官方帳號管理後台的「聊天」直接回覆他。');
  let ok = false;
  for (const to of recipients) {
    try {
      const res = await pushMessage(to, body);
      if (res !== false && res?.ok !== false) ok = true; // 真的 pushMessage 回 Response（看 .ok）；測試的假版本失敗時回 false 或 { ok: false }
    } catch (e) { console.error('答不出來的通知送不出去:', e.message); }
  }
  if (!ok) return { forwarded: recent, sentNow: false, reason: 'push-failed' };
  convSent.set(convKey, now);
  evTimes.push(now);
  day.n++;
  return { forwarded: true, sentNow: true, reason: 'sent' };
}

// 上一題也是答不出來時加在第二個 system 區塊（工單 B3）：真人被追問第二次會換講法，不會把同一套話再念一遍。
// 住在這裡而不是 line-reporter.js，是因為評測（tools/eval/）要用同一句。
export const REPEAT_NO_DATA_HINT = '上一題你已經向記者說明過這部分的界線了。這一題如果還是給不出來，不要重複同一套話，兩行以內。';

// ── 程式接上的句子（批次 197，朱朱 11/10 定的流程）──────────────────────────────────────
// 批次 196 的做法是「答不出來就直接推播、然後對記者說已轉告」。朱朱改成：**先問記者要不要轉介真人**，
// 記者回「是」才通知（批次 196 的上限、負責人、敏感場次那些都沿用）。理由：不是每個答不出來的問題記者都想找人，
// 全部推播會吃掉額度與公關的注意力；而且「已轉告」要記者明講要才說得出口，才是真的。
//   · 資料沒寫（任何活動）：「目前尚未有這部分資料，是否幫您轉介公關同仁?」→ 回「是」→ 通知
//   · 口徑以外：
//       聲明稿／敏感新聞回應說明：「這部分我們暫無回應，主要仍以聲明稿內容為主」（知識庫有【口徑外的問題】就用那一段原文）。
//                                 不問要不要轉介；但公關同仁會被默默通知（每一題，上限見上），不對記者說「已轉告」。
//       一般活動：「目前尚無這部分資料，需要我幫您轉介真人嗎」→ 回「是」→ 通知
// 這幾句是程式接的，不交給模型（見 lib/line-format.js LINE_NO_DATA_RULE：模型只寫接住與能說的）。
// ⚠️ 句子是朱朱給的原文（問號、標點照她的）。群組的說法不承諾「會在這裡回您」：同仁能不能在群組直接回，要看 LINE 官方帳號後台設定。
export const OFFER_BLANK = '目前尚未有這部分資料，是否幫您轉介公關同仁?';
export const OFFER_GENERAL = '目前尚無這部分資料，需要我幫您轉介真人嗎';
export const STATEMENT_DEFAULT = '這部分我們暫無回應，主要仍以聲明稿內容為主';

/** 提供轉介時，記者要怎麼回：1 對 1 有一顆按鈕，群組要打字 */
const REPLY_HINT_GROUP = '（要的話請回覆「是」）';

/**
 * 答不出來時接在模型那段話後面的句子。回傳 { text, offered }：offered＝這一則有問「要不要轉介」，下一句的「是」才算數。
 * @param {object} p
 * @param {boolean} p.sensitive    敏感場次（聲明稿、敏感新聞回應說明）
 * @param {boolean} p.outOfScope   模型把關鍵詞標成「口徑外」
 * @param {string}  p.statement    知識庫【口徑外的問題】的原文（沒有就是空字串）
 * @param {boolean} p.escalate     上一題也是答不出來（同一場、10 分鐘內）
 * @param {string}  p.contact      新聞聯絡人
 */
export function noDataTail({ sensitive = false, outOfScope = false, statement = '', escalate = false, contact = '', group = false } = {}) {
  const hint = group ? REPLY_HINT_GROUP : '';
  if (sensitive && outOfScope) {
    // 連續追問時院方的說法已經講過一次，不再重貼整段，用預設那一句收尾（短）
    return { text: escalate || !statement ? STATEMENT_DEFAULT : statement, offered: false };
  }
  const base = outOfScope ? OFFER_GENERAL : OFFER_BLANK;
  if (escalate) {
    const who = sanitize(contact, 100);
    // 連續追問（工單 B3）：這幾題都超出範圍，再問也一樣；仍然是「問」要不要轉介，沒有人說過要才不能說「已轉給」
    return { text: `這幾題都超出我能說的範圍，再問我也是一樣的答案，不想耽誤您時間。${base}${hint}${who ? `\n趕稿的話，直接找 ${who} 最快。` : ''}`, offered: true };
  }
  return { text: `${base}${hint}`, offered: true };
}

// ── 記者回「是」或「不用」──────────────────────────────────────────────
const norm = (t) => String(t || '').replace(/^[@＠]\S+\s*/, '').replace(/[\s。！!？?～~,，、．.]+/g, '').toLowerCase();
const YES = new Set(['是', '是的', '是啊', '好', '好的', '好啊', '好喔', '好哦', '要', '要的', '需要', '麻煩', '麻煩你', '麻煩您', '麻煩了', '請', '請轉介', '要轉介', '要請轉介', '麻煩轉介', '轉介', '可以', '拜託', '拜託了', '對', '嗯', '嗯嗯', 'ok', 'yes', 'y']);
const NO = new Set(['不用', '不用了', '不要', '不需要', '不必', '算了', '沒關係', '沒事', '不', 'no', 'n']);
/** 整句就是「是」或「不用」才算（'yes' | 'no' | ''）；夾著別的話的當一般提問，不攔 */
export function classifyHandoffReply(text) {
  const t = norm(text);
  if (!t || t.length > 12) return '';
  return YES.has(t) ? 'yes' : NO.has(t) ? 'no' : '';
}
/** 1 對 1 在轉介詢問那則帶的按鈕（點下去等於回「是」） */
export const HANDOFF_YES_BUTTON = { label: '要，請轉介', text: '要，請轉介' };

/** 記者說「是」之後的回覆。forwarded＝通知真的送出（或這個對話剛通知過），沒送出就老實說，只留聯絡人。 */
export function handoffConfirmText({ forwarded = false, group = false, contact = '' } = {}) {
  const who = sanitize(contact, 100);
  const rush = who ? `趕稿的話，直接打給新聞聯絡人比較快：${who}` : '趕稿的話，請直接洽現場新聞聯絡人';
  if (forwarded) return `好的，我已經通知公關同仁了${group ? '' : '，他們看到會直接在這裡回您'}；${rush}`;
  return `我這邊暫時沒辦法通知到同仁，${rush}`;
}
export const HANDOFF_DECLINED_TEXT = '好的，有需要再跟我說 🙂';
