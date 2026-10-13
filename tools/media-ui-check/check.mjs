// 在真的瀏覽器裡把「記者名單健檢」頁跑一遍（批次 137）：新增記者、挑收件人、複製、下載 Outlook CSV。
//
//   node tools/media-ui-check/check.mjs          （要截圖：OUT=某個資料夾 node …）
//
// 後端是真的 api/media.js，只有 Google Sheets 換成 test/fakes-sheets82.mjs 的假試算表。
// 跟 tools/reg-ui-check 一樣不進 npm test（需要 playwright 與 Chromium，不要加進 package.json）。
import { register } from 'node:module';
register('../../test/loader-82.mjs', import.meta.url);
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';

process.env.ADMIN_PASSWORD = 'pw'; process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
const ROOT = path.join(import.meta.dirname, '..', '..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire('/opt/node-tools/')('playwright')); }

const { book } = await import(path.join(ROOT, 'test', 'fakes-sheets82.mjs'));
const media = (await import(path.join(ROOT, 'api', 'media.js'))).default;
const iso = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/media.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(ROOT, 'public/media.html'))); }
  if (u.pathname === '/api/media') {
    let raw = ''; for await (const c of req) raw += c;
    let code = 200;
    const out = { setHeader: (k, v) => res.setHeader(k, v), status(c) { code = c; return out; },
      json(o) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return out; },
      send(o) { res.statusCode = code; res.end(o); return out; }, end() { res.end(); return out; } };
    await media({ method: req.method, query: Object.fromEntries(u.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : {}, socket: { remoteAddress: '1.1.1.1' } }, out);
    return;
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// 先用管理員匯入 40 位記者：半導體 25 位（其中 1 位沒 mail）、生醫 15 位
const rows = ['id,name,outlet,beat,email,invited_count,last_invited'];
for (let i = 1; i <= 25; i++) rows.push(`R${i},半導${i},${i % 2 ? '聯合報' : '工商時報'},半導體,${i === 3 ? '' : `semi${i}@news.com`},5,${iso(30)}`);
for (let i = 1; i <= 15; i++) rows.push(`B${i},生醫${i},中央社,生醫,bio${i}@news.com,2,${iso(30)}`);
await fetch(`${base}/api/media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'seed', password: 'pw', csv: rows.join('\n') }) });

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`✅ ${label}`); } else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); } };
const OUT = process.env.OUT;
const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, name), fullPage: true }); } };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());

// 管理員進場
await page.goto(`${base}/media.html`);
await page.fill('#gate-input', 'pw'); await page.click('#gate-box button');
await page.waitForSelector('#app', { state: 'visible' });
check('管理員進得去，路線下拉選單已填入 8 個路線（新增表單與挑人共用）', (await page.locator('#add-beat option').count()) === 9 && (await page.locator('#pick-beat option').count()) === 9);

// 新增記者
await page.fill('#add-name', '陳新人'); await page.fill('#add-outlet', '經濟日報'); await page.fill('#add-email', 'NEW＠ctee.com.tw');
await page.selectOption('#add-beat', '財經／產業'); await page.click('#add-btn');
await page.waitForFunction(() => /已新增/.test(document.getElementById('add-msg').textContent));
check('新增記者：顯示「已新增」、欄位清空、在職人數 40 → 41', (await page.inputValue('#add-name')) === '' && (await page.textContent('#kpi-total')) === '41', await page.textContent('#kpi-total'));
await page.fill('#add-name', '重複'); await page.fill('#add-outlet', '別家'); await page.fill('#add-email', 'new@ctee.com.tw'); await page.click('#add-btn');
await page.waitForFunction(() => /已經在名單裡/.test(document.getElementById('add-msg').textContent));
check('再新增同一個 mail：擋下並說是誰，已填的欄位還在', /陳新人（經濟日報）/.test(await page.textContent('#add-msg')) && (await page.inputValue('#add-email')) === 'new@ctee.com.tw');
await shot(page, '1-add.png');

// 挑收件人：半導體、每批 10 人
await page.selectOption('#pick-beat', '半導體'); await page.fill('#pick-size', '10'); await page.click('text=挑出名單');
await page.waitForSelector('.pick-batch');
const sum = await page.textContent('.pick-sum');
check('挑「半導體」：25 位符合、24 位可寄，另提醒 1 位沒有 mail', /25\s*位，可以寄的有\s*24/.test(sum) && /1 位沒有 mail/.test(sum), sum);
check('每批 10 人 → 3 批（10／10／4）', (await page.locator('.pick-batch').count()) === 3 && /第 3 批・4 人/.test(await page.locator('.pick-batch').nth(2).textContent()));
await shot(page, '2-pick.png');
await page.locator('.pick-batch button').nth(0).click();
await page.waitForFunction(() => /已複製第 1 批/.test(document.getElementById('toast').textContent));
const clip = await page.evaluate(() => navigator.clipboard.readText());
check('★ 按「複製收件人」：剪貼簿真的是第 1 批 10 個 mail、用「; 」隔開', clip.split('; ').length === 10 && clip.startsWith('semi1@news.com; semi2@news.com; semi4@news.com') && !clip.includes(','), clip);

// 下載 Outlook CSV
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=下載 Outlook 通訊錄 CSV')]);
const csv = fs.readFileSync(await dl.path(), 'utf8');
check('下載的 Outlook CSV：只有半導體的 24 位、有標題列、有 BOM', csv.charCodeAt(0) === 0xFEFF && csv.split('\r\n').length === 25 && csv.includes('"電子郵件"') && !csv.includes('生醫'), csv.slice(0, 120));

// 同仁身分：看不到挑收件人，但可以新增
const staff = await ctx.newPage();
staff.on('pageerror', (e) => errors.push('staff: ' + e.message));
await staff.goto(`${base}/media.html?code=staffcode1`);
await staff.waitForSelector('#app', { state: 'visible' });
check('同仁連結：看得到新增表單，看不到「挑收件人」管理區', await staff.locator('#add-card').isVisible() && !(await staff.locator('#admin-panel').isVisible()));
await shot(staff, '3-staff.png');
check('頁面沒有任何 JS 錯誤', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(`\n${fail ? '❌' : '✅'} 記者名單頁瀏覽器走查：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
