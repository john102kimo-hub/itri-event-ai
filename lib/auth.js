// 驗證小工具（批次 110）：管理員密碼、同仁編輯碼的比對，全部走這一支。
//
// 為什麼要集中：通盤檢討時實測到三件事，每一件都是「各檔案各寫一份」造成的——
//   ① 【fail-open】`password !== process.env.ADMIN_PASSWORD`：環境變數沒設（被刪掉、新環境忘了設、
//      預覽部署沒帶）時，兩邊都是 undefined、`undefined !== undefined` 是 false，**不帶任何密碼就通過**。
//      實測 ADMIN_PASSWORD 未設定時，不帶密碼就能列出後台活動（含編輯碼）、讀知識庫、封存活動、
//      看全部問答紀錄。CLAUDE.md 第 2 條：絕對不能發生的事，擋在程式出口。現在「沒設定」一律拒絕。
//   ② 比對用 `!==`，不是固定時間比對（timingSafeEqual），而且登入失敗沒有任何限流。
//   ③ 密碼可以放在網址 `?password=`（會進伺服器存取紀錄、瀏覽器歷史），lib/staff.js 的內部呼叫就這樣做。
//      現在只收 header（X-Admin-Password）或 POST 內文，不再讀網址。
//
// 比對方式：兩邊先各做一次 SHA-256 再 timingSafeEqual——長度不同不會洩漏、也不會丟例外。
// 空字串、非字串（例如 ?password=a&password=b 變成陣列）一律不通過。
//
// 失敗限流是 best-effort（計數在單一 instance 的記憶體裡，見 lib/rate-limit.js）：擋得住單一來源無腦猜，
// 擋不住分散式。每個 IP 10 分鐘內失敗 30 次就先擋 10 分鐘（辦公室共用一個對外 IP，所以門檻不能太低）。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createLimiter, clientIp } from './rate-limit.js';

const sha = (s) => createHash('sha256').update(s).digest();

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  return timingSafeEqual(sha(a), sha(b));
}

let warned = false;
export function isAdminPassword(given) {
  const admin = process.env.ADMIN_PASSWORD;
  if (!admin) {
    if (!warned) { warned = true; console.error('[auth] ADMIN_PASSWORD 沒有設定：後台、匯出、訓練等管理員功能一律拒絕。請到 Vercel 環境變數補上。'); }
    return false;
  }
  return safeEqual(given, admin);
}

// 編輯碼／共用連結碼：沒有預期值（活動沒有編輯碼）一律不通過
export function codeMatches(given, expected) {
  return safeEqual(String(given ?? ''), String(expected ?? ''));
}

// 管理員密碼從哪裡來：header 優先，其次 POST 內文。**不讀網址**（見檔頭 ③）。
export function passwordFrom(req) {
  const h = req?.headers?.['x-admin-password'];
  if (typeof h === 'string' && h) return h;
  const b = req?.body?.password;
  return typeof b === 'string' ? b : '';
}

const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 30;
const failures = createLimiter({ windowMs: FAIL_WINDOW_MS, max: FAIL_MAX });

export const authBlocked = (req) => failures.blocked(clientIp(req));
export const authFailed = (req) => { failures.hit(clientIp(req)); };
export const resetAuthLimiter = () => failures.reset();
export const tooManyAttempts = (res) =>
  res.status(429).json({ error: '嘗試的次數太多了，請 10 分鐘後再試。' });

/**
 * 管理員閘門。通過回 true；沒通過已經把回應送出去（401／429），呼叫端 `if (!requireAdmin(...)) return;` 即可。
 * 被擋下的來源連比對都不做，猜密碼的流量不會再多一分資訊。
 */
export function requireAdmin(req, res, given = passwordFrom(req), msg = '密碼錯誤') {
  if (authBlocked(req)) { tooManyAttempts(res); return false; }
  if (isAdminPassword(given)) return true;
  authFailed(req);
  res.status(401).json({ error: msg });
  return false;
}
