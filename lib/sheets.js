// Google Sheets API 共用工具
// 使用 Service Account JWT 認證，無需外部套件

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const apiBase = (sid) => `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;

function base64url(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 統一加上重試的 fetch：遇到 429（配額用完）或 500/503（Google 端暫時性錯誤）
 * 就重試，最多 3 次、間隔 500ms → 1500ms → 3000ms。
 *
 * 為什麼要這層：Sheets API 配額是每個服務帳號每分鐘讀寫各 60 次，全站共用
 * 同一個帳號。記者會當天幾十位記者在開場後十分鐘內集中發問，很容易瞬間撞到
 * 配額——沒有這層重試，撞到就直接 throw，記者端會看到「伺服器錯誤」。
 */
// 每一次嘗試的逾時（批次 57）。原本完全沒有 signal——Sheets 若「連上了但不回應」，
// 這支會一直等下去，在 api/line.js 那邊的後果是整支 function 被 Vercel 在 60 秒砍掉，
// 記者收到的是已讀不回（見 api/line.js apologise()／ANSWER_TIMEOUT_MS 的說明）。
// 逾時會讓 fetch 丟 AbortError，正好走進下面既有的「重試 → 最後往外拋」那條路，
// 呼叫端該接的接、該道歉的道歉，不會再有無聲的等待。
const SHEETS_TIMEOUT_MS = 10_000;

// ⚠️ 批次 117：重送不是每一種請求都安全。讀取與「整格覆寫」（updateRange）送幾次結果都一樣，照舊
// 遇到 429／500／503、逾時、斷線都重試。但「在最後面加一列」（appendRows）與「刪列、加分頁」
// （batchUpdate）不是——第一次其實已經寫進去、只是回應慢了（逾時）或回 500，重送就是多一列重複的
// 問答紀錄（後台的數字是要報給長官的）；刪列更糟：同一個列號再刪一次，刪掉的是**下一場活動**。
// 所以這兩種只在「確定沒寫進去」時重試：429（配額用完，Google 根本沒處理）、連線根本沒建立
// （DNS 失敗、連線被拒）；appendRows 另外收 503（服務暫時不可用）。逾時、連線中途斷掉、500 一律
// 往外拋——呼叫端本來就會記 log 或回「請稍後再試」，少一列比多一列、刪錯一列好查也好補。
const NEVER_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const neverSent = (err) => NEVER_SENT_CODES.has(err?.cause?.code || err?.code);
const SAFE_RETRY = { retryStatus: [429, 500, 503], retryUnsure: true };
const APPEND_RETRY = { retryStatus: [429, 503], retryUnsure: false };
const STRUCTURE_RETRY = { retryStatus: [429], retryUnsure: false };

async function fetchWithRetry(url, options, { retryStatus, retryUnsure } = SAFE_RETRY, maxRetries = 3) {
  const delays = [500, 1500, 3000];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS) });
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && (retryUnsure || neverSent(err))) { await sleep(delays[attempt]); continue; }
      throw err;
    }
    if (retryStatus.includes(res.status) && attempt < maxRetries) {
      await sleep(delays[attempt]);
      continue;
    }
    return res;
  }
  throw lastErr || new Error('請求失敗');
}

// Token 快取（同一個 Function 執行週期內重用）
let tokenCache = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenExpiry) return tokenCache;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !privateKey) throw new Error('Google 服務帳號憑證未設定');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64url({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  });

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('取得 Token 失敗: ' + JSON.stringify(data));

  tokenCache = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return tokenCache;
}

async function call(url, options, retry) {
  const res = await fetchWithRetry(url, options, retry);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// 每一支都綁定一本試算表。預設是 GOOGLE_SPREADSHEET_ID；業發處的資料放在另一本（批次 119，
// 見 sheetsFor()），兩本的分享對象可以分開設定——記者會那本給公關，業務那本只給業發處。
function boundTo(sid) {
  const readRange = async (range) => {
    const token = await getAccessToken();
    const data = await call(`${apiBase(sid)}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` } });
    return data.values || [];
  };

  // 一次讀好幾段（批次 117）：values:batchGet，回傳順序跟傳進來的 ranges 一樣。
  // 用來跳過用不到又很大的欄位——qa_log 的 F 欄（AI 回答全文，每列動輒上千字）。
  const readRanges = async (ranges) => {
    const token = await getAccessToken();
    const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const data = await call(`${apiBase(sid)}/values:batchGet?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    return (data.valueRanges || []).map((v) => v.values || []);
  };

  const appendRows = async (range, values) => {
    const token = await getAccessToken();
    return call(
      `${apiBase(sid)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) },
      APPEND_RETRY
    );
  };

  // 結構操作（新增分頁、刪列）
  const batchUpdate = async (requests) => {
    const token = await getAccessToken();
    return call(
      `${apiBase(sid)}:batchUpdate`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) },
      STRUCTURE_RETRY
    );
  };

  const listSheets = async () => {
    const token = await getAccessToken();
    const data = await call(`${apiBase(sid)}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${token}` } });
    return (data.sheets || []).map((s) => s.properties);
  };

  const updateRange = async (range, values) => {
    const token = await getAccessToken();
    return call(
      `${apiBase(sid)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
    );
  };

  // 確保分頁存在，缺的就建立並寫入表頭。回傳實際新建的分頁名稱。
  const ensureSheets = async (spec) => {
    const existing = new Set((await listSheets()).map((p) => p.title));
    const missing = Object.keys(spec).filter((t) => !existing.has(t));
    if (!missing.length) return [];
    await batchUpdate(missing.map((title) => ({
      addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } }
    })));
    for (const t of missing) await updateRange(`${t}!A1`, [spec[t]]);
    return missing;
  };

  return { readRange, readRanges, appendRows, batchUpdate, listSheets, updateRange, ensureSheets };
}

const main = boundTo(SPREADSHEET_ID);
export const readRange = main.readRange;
export const readRanges = main.readRanges;
export const appendRows = main.appendRows;
export const batchUpdate = main.batchUpdate;
export const listSheets = main.listSheets;
export const updateRange = main.updateRange;
export const ensureSheets = main.ensureSheets;

/** 另一本試算表的同一組工具（批次 119：業發處的資料不跟記者會那本放在一起）。 */
export function sheetsFor(spreadsheetId) {
  if (!spreadsheetId) throw new Error('沒有指定試算表 ID');
  return boundTo(spreadsheetId);
}

// 讓呼叫端在請求一開始就（不 await 地）預熱 access token：簽 JWT + 跟 oauth2.googleapis.com
// 換 token 冷的時候要 0.3～0.6 秒，先跟模型生成平行跑掉，最後要寫 qa_log 時就不必再等。
export function warmAuth() {
  return getAccessToken().catch(() => {});
}

// 測試用（批次 117）：重試規則是這支檔案最容易被「好心」改回去的地方，test-batch117 直接驗。
export const __test = { fetchWithRetry, SAFE_RETRY, APPEND_RETRY, STRUCTURE_RETRY };
