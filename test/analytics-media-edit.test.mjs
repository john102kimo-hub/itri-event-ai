// api/analytics.js 新增的三個動作：update_media（手動改媒體名稱）、
// scan_dirty_media／clean_dirty_media（掃出並清理「媒體名稱其實是問題」的髒資料）。
// 用 mock fetch 模擬 Sheets，不需要任何環境變數或真實網路連線。
import { generateKeyPairSync } from 'crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
process.env.GOOGLE_PRIVATE_KEY = privateKey;
process.env.GOOGLE_SPREADSHEET_ID = 'test-sheet-id';
process.env.ADMIN_PASSWORD = 'test-admin-pwd';

// qa_log!A2:H：timestamp, event_id, event_name, media_name, question, answer, deleted, source
let qaRows = [
  ['2026-08-27 10:00:00', 'ev1', '智慧醫療記者會', '自由時報', '這場的重點是什麼', '答案A', '', 'line'],
  ['2026-08-27 10:05:00', 'ev1', '智慧醫療記者會', '給我完整新聞稿', '給我完整新聞稿', '答案B', '', 'line'], // 髒資料：問題被誤記成媒體名稱
  ['2026-08-27 10:10:00', 'ev1', '智慧醫療記者會', '（未填寫）', '有照片嗎', '答案C', '', 'line'],
  ['2026-08-27 10:15:00', 'ev1', '智慧醫療記者會', '請問技術規格', '請問技術規格', '答案D', '', 'line'], // 髒資料：疑問詞開頭
];

globalThis.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url));
  if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'x', expires_in: 3600 });

  let body = {};
  try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }

  if (u.includes('/values/qa_log!A2:H') && (!opts.method || opts.method === 'GET')) {
    return jsonRes({ values: qaRows });
  }
  const rangeMatch = u.match(/\/values\/qa_log!A(\d+):E\d+(\?|$)/);
  if (rangeMatch && (!opts.method || opts.method === 'GET')) {
    const idx = Number(rangeMatch[1]) - 2;
    return jsonRes({ values: qaRows[idx] ? [qaRows[idx].slice(0, 5)] : [] });
  }
  const dMatch = u.match(/\/values\/qa_log!D(\d+):D\d+\?/);
  if (dMatch && opts.method === 'PUT') {
    const idx = Number(dMatch[1]) - 2;
    if (qaRows[idx]) qaRows[idx][3] = body.values[0][0];
    return jsonRes({});
  }
  throw new Error('未預期的 URL: ' + u + ' method=' + opts.method);
};
function jsonRes(o, s = 200) { return { ok: s >= 200 && s < 300, status: s, json: async () => o, text: async () => JSON.stringify(o) }; }

function fakeReq(method, body, query = {}) {
  return { method, body, query, headers: {} };
}
function fakeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = c => (res.statusCode = c, res);
  res.json = o => (res.body = o, res);
  res.end = () => res;
  res.setHeader = () => {};
  return res;
}

const { default: handler } = await import('file:///C:/Users/User/Documents/Claude/itri-event-ai-port/api/analytics.js');

let pass = true;
const check = (label, cond) => { console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`); pass = pass && cond; };

// ── update_media ─────────────────────────────────────────────────────
{
  const res = fakeRes();
  await handler(fakeReq('POST', {
    action: 'update_media', password: 'test-admin-pwd', row_num: 2,
    timestamp: qaRows[0][0], question: qaRows[0][4], media_name: '中央社'
  }), res);
  check('update_media 密碼對、資料對得上 → 成功', res.body.success === true);
  check('update_media 真的寫進 D 欄', qaRows[0][3] === '中央社');
}
{
  const res = fakeRes();
  await handler(fakeReq('POST', {
    action: 'update_media', password: 'test-admin-pwd', row_num: 2,
    timestamp: '不對的時間戳', question: qaRows[0][4], media_name: '亂改'
  }), res);
  check('update_media 時間戳對不上（資料已變動）→ 409，不會誤改', res.statusCode === 409 && qaRows[0][3] === '中央社');
}
{
  const res = fakeRes();
  await handler(fakeReq('POST', { action: 'update_media', password: 'wrong', row_num: 2, media_name: 'x' }), res);
  check('update_media 密碼錯 → 401', res.statusCode === 401);
}
{
  const res = fakeRes();
  await handler(fakeReq('POST', { action: 'update_media', password: 'test-admin-pwd', row_num: 3, media_name: '   ' }), res);
  check('update_media 名稱是空白 → 擋下，不會清空媒體名稱', res.statusCode === 400);
}

// ── scan_dirty_media ─────────────────────────────────────────────────
{
  const res = fakeRes();
  await handler(fakeReq('POST', { action: 'scan_dirty_media', password: 'test-admin-pwd' }), res);
  const rows = res.body.dirty.map(d => d.row_num);
  check('scan_dirty_media 抓到「給我完整新聞稿」那筆（row 3）', rows.includes(3));
  check('scan_dirty_media 抓到「請問技術規格」那筆（row 5，疑問詞開頭）', rows.includes(5));
  check('scan_dirty_media 不會誤判「中央社」（剛改好的正常名稱）', !rows.includes(2));
  check('scan_dirty_media 不會誤判「（未填寫）」', !rows.includes(4));
  check('scan_dirty_media 只回傳這兩筆，沒有多抓', res.body.dirty.length === 2);
}

// ── clean_dirty_media ────────────────────────────────────────────────
{
  const res = fakeRes();
  await handler(fakeReq('POST', { action: 'clean_dirty_media', password: 'test-admin-pwd', row_nums: [3] }), res);
  check('clean_dirty_media 只清指定的那幾列', res.body.cleaned === 1 && qaRows[1][3] === '（未填寫）');
  check('clean_dirty_media 沒清到沒被勾選的 row 5', qaRows[3][3] === '請問技術規格');
}
{
  const res = fakeRes();
  await handler(fakeReq('POST', { action: 'clean_dirty_media', password: 'test-admin-pwd', row_nums: [] }), res);
  check('clean_dirty_media 空陣列 → 400，不會誤觸', res.statusCode === 400);
}

console.log(pass ? '\n=== 全部通過 ===' : '\n=== 有失敗項目 ===');
process.exit(pass ? 0 : 1);
