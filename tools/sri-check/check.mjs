// 在真的瀏覽器裡驗證 CDN 資源的 SRI（批次 110）。
//
//   node tools/sri-check/check.mjs                      （從 jsDelivr 抓原檔；要網路）
//   CDN_DIR=某資料夾 node tools/sri-check/check.mjs     （資料夾裡放 tabler-icons.min.css 與 mammoth.browser.min.js）
//
// 為什麼要有這支：SRI 的雜湊值寫錯，或升版時只改了網址沒改雜湊，後果是「圖示全部消失」或「Word 匯入壞掉」，
// 而且是瀏覽器默默擋掉、伺服器 log 乾淨——跟 CLAUDE.md 第 4 條同一個形狀：「送出成功」不等於「使用者看得到」。
// 靜態檢查（test/test-batch110.mjs）只能看到雜湊「有寫」，看不到「對不對」。這支用真的 Chromium 驗兩件事：
//   ① 原檔：圖示字型真的套用、mammoth 真的載得進來（雜湊對）
//   ② 竄改過的檔（原檔多一個字）：瀏覽器必須拒絕（SRI 真的在把關，不是擺著好看）
// 跟 tools/geo-ui-check 一樣不進 npm test（需要 playwright 與 Chromium；前置：`npm i playwright --no-save`）。
// 升級圖示字型或 mammoth 時：改頁面的網址與 integrity，再跑這支確認；雜湊用
//   curl -s <網址> | openssl dgst -sha384 -binary | openssl base64 -A
// 算，並與 npm 官方套件（npm pack 套件@版本）的檔案逐位元比對過再貼上。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = process.env.PUBLIC_DIR || path.join(import.meta.dirname, '..', '..', 'public');
const CDN_DIR = process.env.CDN_DIR;
const TABLER_URL = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.3.0/dist/tabler-icons.min.css';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

async function genuine(url, name) {
  if (CDN_DIR) return fs.readFileSync(path.join(CDN_DIR, name));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`抓不到 ${url}：${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const tabler = await genuine(TABLER_URL, 'tabler-icons.min.css');
const mammoth = await genuine(MAMMOTH_URL, 'mammoth.browser.min.js');
const tamper = (buf) => Buffer.concat([buf, Buffer.from('\n/* 被動過手腳 */\n')]);

// 本機靜態伺服器：只提供 public/，API 一律 404（這支只看 CDN 資源，不需要後端）
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{}'); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(f));
});
await new Promise((ok) => server.listen(0, ok));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + d : ''))); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
async function open(pageName, { tablerBody, mammothBody }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = route.request().url();
    const body = u.includes('tabler-icons') ? tablerBody : u.includes('mammoth') ? mammothBody : Buffer.alloc(0);
    route.fulfill({
      status: 200, body,
      headers: { 'access-control-allow-origin': '*', 'content-type': u.endsWith('.css') ? 'text/css' : 'application/javascript' },
    });
  });
  // 字型檔與 Google Fonts 不是這支要驗的東西，直接放空
  await page.route(/fonts\.(googleapis|gstatic)\.com|tabler-icons\.(woff2?|ttf|eot)/, (r) => r.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } }));
  await page.goto(`${base}/${pageName}`, { waitUntil: 'load' });
  return { page, ctx, errors };
}
// 圖示 CSS 有沒有套用：頁面上找得到 tabler 那張樣式表、而且裡面真的有 .ti 規則
const tablerApplied = (page) => page.evaluate(() => {
  const sheet = [...document.styleSheets].find((s) => s.href && s.href.includes('tabler-icons'));
  if (!sheet) return false;
  try { return [...sheet.cssRules].some((r) => r.selectorText && r.selectorText.includes('.ti')); } catch { return false; }
});

const PAGES = ['edit.html', 'event.html', 'geo.html', 'index.html', 'report.html', 'training.html'];
for (const name of PAGES) {
  let t = await open(name, { tablerBody: tabler, mammothBody: mammoth });
  check(`${name}：原檔 → 圖示樣式表真的套用（雜湊正確）`, await tablerApplied(t.page), t.errors.join(' | ').slice(0, 160));
  await t.ctx.close();
  t = await open(name, { tablerBody: tamper(tabler), mammothBody: mammoth });
  const applied = await tablerApplied(t.page);
  check(`${name}：竄改過的檔 → 瀏覽器拒絕套用（SRI 真的在把關）`, !applied && t.errors.some((e) => /integrity|digest/i.test(e)), `套用了嗎=${applied}；console=${t.errors.join(' | ').slice(0, 160)}`);
  await t.ctx.close();
}

// mammoth：edit.html 在使用者按下「匯入 Word」才動態載入——直接呼叫它的 loadMammoth()
{
  let t = await open('edit.html', { tablerBody: tabler, mammothBody: mammoth });
  const okLoad = await t.page.evaluate(async () => { try { const m = await loadMammoth(); return typeof m.convertToHtml === 'function' || typeof m.extractRawText === 'function'; } catch (e) { return 'ERR ' + e.message; } });
  check('edit.html：mammoth 原檔 → 載得進來、能用（雜湊正確）', okLoad === true, String(okLoad));
  await t.ctx.close();
  t = await open('edit.html', { tablerBody: tabler, mammothBody: tamper(mammoth) });
  const bad = await t.page.evaluate(async () => { try { await loadMammoth(); return 'LOADED'; } catch (e) { return e.message; } });
  check('edit.html：mammoth 被竄改 → 載入失敗、不會執行（Word 匯入會跳「元件載入失敗」，而不是執行未知程式碼）', /載入失敗/.test(bad), bad);
  await t.ctx.close();
}

await browser.close();
server.close();
console.log(`\n${fail ? '❌' : '✅'} SRI 真瀏覽器驗證：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
