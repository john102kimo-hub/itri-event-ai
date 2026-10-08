// AI 叫不動時，用 LINE 通知管理員（批次 85）。
//
// 2026-09-24 的實際事件：Anthropic 金鑰失效，整站的 AI 回答全部失敗——但沒有任何人
// 被通知。路由失敗會退回「聽不懂」的兜底文案，記者看到的像是「米亞答不出來」，不像
// 「系統壞了」；是朱朱自己在群組測試、截圖回報，才去 Vercel Logs 查到 `API key is invalid`。
// 這正是 CLAUDE.md 第 4 條那句話的另一面：**我們自己知道出事了，卻沒有告訴該知道的人。**
//
// 只通知「不會自己好」的錯誤：金鑰失效／沒權限（401、403）、額度用完。429（太頻繁）、
// 529（過載）、逾時都是暫時的，通知了也只是洗版。每個執行個體一小時最多通知一次——
// 出事的時候每一題都會失敗，不擋的話管理員一分鐘收幾十則。
//
// 通知失敗不能影響問答本身：整支包在 try 裡，呼叫端照常把「目前無法取得回應」回給記者。
import { pushMessage } from './line.js';

const GAP_MS = 60 * 60 * 1000;
// 每一把金鑰各自節流（批次 119）：企業場可以用另一把（ANTHROPIC_API_KEY_BUSINESS）。那一把先出事、吃掉這一小時的
// 通知額度的話，記者那一把同一小時內真的壞了，管理員就收不到——業發處的事不能蓋掉記者那邊的警報。
const lastNotifiedAt = new Map();
export const BUSINESS_KEY_NAME = 'ANTHROPIC_API_KEY_BUSINESS';

export function isFatalAiError(status, message) {
  const m = String(message || '');
  if (status === 401 || status === 403) return true;
  if (/api[ -]?key|x-api-key|authentication|permission/i.test(m)) return true;
  return isBillingError(m);
}
function isBillingError(message) {
  return /credit balance|billing|purchase credits/i.test(String(message || ''));
}

// where：哪一個功能先撞到（「LINE 問答」「網頁版記者問答」…），寫進通知裡方便判斷影響範圍。
// keyName：這一次實際用的是哪一把金鑰。企業場那一把出事只影響企業場，通知要講清楚，免得管理員以為記者那邊也壞了、
// 跑去換掉好好的 ANTHROPIC_API_KEY。
export async function reportAiFailure({ status = 0, message = '', where = '', keyName = 'ANTHROPIC_API_KEY' } = {}) {
  try {
    if (!isFatalAiError(status, message)) return false;
    const ownerId = process.env.LINE_ADMIN_USER_ID;
    if (!ownerId || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return false;
    if (Date.now() - (lastNotifiedAt.get(keyName) || 0) < GAP_MS) return false;
    lastNotifiedAt.set(keyName, Date.now());
    const detail = `${where ? where + '，' : ''}Anthropic 回 ${status || '錯誤'}：${String(message).slice(0, 120)}`;
    const text = keyName === BUSINESS_KEY_NAME
      ? `⚠️ 企業場的 AI 叫不動了（${detail}）\n\n用的是業發處那一把金鑰 ${BUSINESS_KEY_NAME}：企業場的提問都只會拿到「目前無法取得回應」。記者那邊用的是另一把，不受影響。\n請到 Anthropic Console 檢查那一把的金鑰與額度：https://console.anthropic.com/settings/keys\n換好之後到 Vercel 更新 ${BUSINESS_KEY_NAME}，再重新部署。\n\n（同一個問題一小時內只通知一次）`
      : isBillingError(message)
      ? `⚠️ 米亞的 AI 額度用完了（${detail}）\n\n現在記者問什麼都只會拿到「目前無法取得回應」，不會自己恢復。\n請到 Anthropic Console 的 Plans & Billing 加值：https://console.anthropic.com/settings/billing\n\n（同一個問題一小時內只通知一次）`
      : `⚠️ 米亞的 AI 現在叫不動（${detail}）\n\n這代表記者問什麼都只會拿到「目前無法取得回應」，不會自己恢復。\n請到 Anthropic Console 檢查金鑰：https://console.anthropic.com/settings/keys\n換好之後到 Vercel 更新 ANTHROPIC_API_KEY，再重新部署。\n\n（同一個問題一小時內只通知一次）`;
    const res = await pushMessage(ownerId, text);
    if (res && res.ok === false) console.error('AI 失效通知送不出去:', res.status);
    console.error(`[ai-alert] 已通知管理員 ${detail}`);
    return true;
  } catch (e) {
    console.error('AI 失效通知送不出去:', e.message);
    return false;
  }
}

// 測試用：把一小時的節流歸零。
export function resetAiAlertThrottle() { lastNotifiedAt.clear(); }
