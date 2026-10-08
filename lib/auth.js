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

/**
 * 「管理員密碼或某一組碼，擇一」的入口用這支先看密碼（批次 116）：上傳照片、記者名單、露出上傳。
 * 回傳 'blocked'（這個來源錯太多次，呼叫端回 429）、'admin'，或 'none'（沒帶密碼、或帶錯——
 * 帶錯的已經記一次失敗，呼叫端接著驗它自己的碼）。
 *
 * 為什麼要有：那三支各自寫「先 isAdminPassword() 再檢查限流」，密碼錯了也不記失敗——
 * 實測同一個 IP 在上傳端點連猜 100 次照樣 400、第 101 次猜對 200；記者名單被擋下的 IP 仍然
 * 分得出密碼對錯（錯 429、對 200）。批次 110 的猜密碼限流在這幾個門口等於沒有。
 */
export function adminAttempt(req, given) {
  if (authBlocked(req)) return 'blocked';
  if (!given) return 'none';
  if (isAdminPassword(given)) return 'admin';
  authFailed(req);
  return 'none';
}
