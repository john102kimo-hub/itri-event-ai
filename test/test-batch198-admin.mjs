// 批次 198（工單 C）的後台那一半：api/events.js 的 org_kb（讀）與 org_kb_save（寫）。
//   管理員才進得來；整份覆蓋；上限 6,000 字；回傳過期／沒標日期的統計；分頁第一次用到時自動建、不種任何內容；
//   後台頁面有編輯區與警告。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
}
let seq = 0;
const call = async (method, query, body, admin = true) => {
  const r = fakeRes();
  await events({ method, query: query || {}, body: body || {}, headers: { ...(admin ? { 'x-admin-password': 'pw' } : {}), 'x-forwarded-for': `10.9.0.${++seq}` }, socket: {} }, r);
  return r;
};
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

reset();
book.events = [['id']];

let r = await call('GET', { action: 'org_kb' }, null, false);
check('★ 沒有管理員密碼：讀不到（401）', r.statusCode === 401, r.statusCode);
r = await call('POST', {}, { action: 'org_kb_save', content: '2026-05-01｜甲' }, false);
check('★ 沒有管理員密碼：存不進去（401），分頁也沒被建出來', r.statusCode === 401 && !book.org_kb, r.statusCode);

r = await call('GET', { action: 'org_kb' });
check('★ 第一次讀：自動建 org_kb 分頁（只有表頭，不種任何內容——第一版寫什麼、誰寫，是朱朱要決定的事）', r.statusCode === 200 && r.body.content === '' && Array.isArray(book.org_kb) && book.org_kb[0][0] === 'content' && r.body.stats.total === 0, JSON.stringify([r.statusCode, r.body, book.org_kb]));

const content = [
  `${iso(-5)}｜採訪申請：請洽傳播處新聞聯絡人。`,
  `${iso(-300)}｜工研院共有數個研究所。`,
  '沒有日期的一條'
].join('\n');
r = await call('POST', {}, { action: 'org_kb_save', content });
check('★ 存檔（整份覆蓋）：回傳統計——超過 180 天的標出來、沒標日期的標出來', r.statusCode === 200 && r.body.success && r.body.stats.stale.length === 1 && r.body.stats.stale[0].days === 300 && r.body.stats.total === 2, JSON.stringify(r.body));
check('　 真的寫進 org_kb!A2（一格存整份）', book.org_kb[1][0] === content, JSON.stringify(book.org_kb));
r = await call('GET', { action: 'org_kb' });
check('　 再讀回來一字不差，統計一致', r.body.content === content && r.body.stats.length === content.length && r.body.stats.limit === 6000, JSON.stringify(r.body.stats));

const tooLong = '2026-05-01｜' + '字'.repeat(6000);
r = await call('POST', {}, { action: 'org_kb_save', content: tooLong });
check('★ 超過 6,000 字：擋下（400）並說明，原本的內容沒被蓋掉', r.statusCode === 400 && /6000/.test(r.body.error) && book.org_kb[1][0] === content, JSON.stringify(r.body));
const exactly = '2026-05-01｜' + '字'.repeat(6000 - '2026-05-01｜'.length);
r = await call('POST', {}, { action: 'org_kb_save', content: exactly });
check('　 剛好 6,000 字可以存', r.statusCode === 200 && exactly.length === 6000);
r = await call('POST', {}, { action: 'org_kb_save', content: '' });
check('　 存空字串＝清空（回到沒填的狀態）', r.statusCode === 200 && r.body.stats.total === 0);

// 後台頁面
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
check('後台頁面：「記者與邀訪」有機構資料編輯區，載入與儲存打 org_kb／org_kb_save，並列出過期與沒標日期的條目',
  html.includes('id="input-org-kb"') && html.includes('/api/events?action=org_kb') && html.includes("action: 'org_kb_save'") && html.includes('超過 180 天沒更新') && html.includes('沒標更新日期') && /loadOrgKb\(\)/.test(html));
check('　 頁面上限寫的跟後端一致（6000）', /ORG_KB_LIMIT = 6000/.test(html));

console.log(`\n${fail ? '❌' : '✅'} 批次 198（機構資料・後台）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
