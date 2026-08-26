// Google Sheets API 共用工具
// 使用 Service Account JWT 認證，無需外部套件

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

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
async function fetchWithRetry(url, options, maxRetries = 3) {
  const delays = [500, 1500, 3000];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) { await sleep(delays[attempt]); continue; }
      throw err;
    }
    if ((res.status === 429 || res.status === 500 || res.status === 503) && attempt < maxRetries) {
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

export async function readRange(range) {
  const token = await getAccessToken();
  const res = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.values || [];
}

export async function appendRows(range, values) {
  const token = await getAccessToken();
  const res = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// 結構操作（新增分頁）
export async function batchUpdate(requests) {
  const token = await getAccessToken();
  const res = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

export async function listSheets() {
  const token = await getAccessToken();
  const res = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.sheets || []).map(s => s.properties);
}

// 確保分頁存在，缺的就建立並寫入表頭。回傳實際新建的分頁名稱。
export async function ensureSheets(spec) {
  const existing = new Set((await listSheets()).map(p => p.title));
  const missing = Object.keys(spec).filter(t => !existing.has(t));
  if (!missing.length) return [];
  await batchUpdate(missing.map(title => ({
    addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } }
  })));
  for (const t of missing) await updateRange(`${t}!A1`, [spec[t]]);
  return missing;
}

export async function updateRange(range, values) {
  const token = await getAccessToken();
  const res = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// 讓呼叫端在請求一開始就（不 await 地）預熱 access token：簽 JWT + 跟 oauth2.googleapis.com
// 換 token 冷的時候要 0.3～0.6 秒，先跟模型生成平行跑掉，最後要寫 qa_log 時就不必再等。
export function warmAuth() {
  return getAccessToken().catch(() => {});
}
