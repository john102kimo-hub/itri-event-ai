// 在真的瀏覽器裡把 AI 能見度頁（/geo）跑一遍（批次 72）。
//
//   node tools/geo-ui-check/check.mjs          （要截圖：OUT=某個資料夾 node …）
//
// 後端用的是**真的 api/geo.js**，只有 Google Sheets 換成 data.mjs 的合成資料——所以
// 驗到的是「真的後端算出來的東西，在真的瀏覽器裡長什麼樣子」。不呼叫任何 AI、不碰網路。
// 跟 tools/training-voice-check.mjs 一樣不進 npm test（需要 playwright 與 Chromium，
// 前置：`npm i playwright`，不要加進 package.json）。
//
// 驗的是批次 72 改版後最容易壞、而且壞了不會報錯的幾件事：分頁切換、摘要不搶先下結論、
// 簡報產生／播放／存 PDF 一頁一張、複製文字沒有殘留符號、同仁連結不會一片空白。
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
process.env.ADMIN_PASSWORD = 'pw'; process.env.ANTHROPIC_API_KEY = 'x'; process.env.GEMINI_API_KEY = 'y';
const ROOT = path.join(import.meta.dirname, '..', '..');
const { default: handler } = await import(path.join(ROOT, 'api', 'geo.js'));
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/geo') {
    let b = ''; for await (const c of req) b += c;
    const r = { query: Object.fromEntries(u.searchParams), method: req.method, headers: req.headers, body: b ? JSON.parse(b) : {} };
    let code = 200;
    const out = { setHeader: (k, v) => res.setHeader(k, v), status(c) { code = c; return out; },
      json(o) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return out; },
      end(x) { res.statusCode = code; res.end(x); return out; }, send(x) { res.statusCode = code; res.end(x); return out; } };
    try { await handler(r, out); } catch (e) { console.error(e); res.statusCode = 500; res.end('{}'); }
    return;
  }
  const f = path.join(ROOT, 'public', u.pathname === '/geo' ? 'geo.html' : u.pathname);
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
function findChromium() {
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  const b = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(b)) return undefined;
  for (const d of fs.readdirSync(b).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(b, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (c, m) => { if (!c) fails++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const browser = await chromium.launch({ executablePath: findChromium() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => sessionStorage.setItem('itri_pwd', 'pw'));
await page.goto(base + '/geo'); await page.waitForTimeout(2000);
check(await page.isVisible('#summary-card'), '打開就是總覽：一眼看懂');
check(/能見度指數 <b>[\d.]+<\/b> 分/.test(await page.innerHTML('#summary-out')), '摘要寫出近 14 天分數');
check(!/下降 -/.test(await page.textContent('#summary-out')), '「下降」後面不再帶負號');
check(!/基線抬升/.test(await page.textContent('#summary-out')), '摘要不說「基線抬升」（第 15–30 天是餘波期）');
check(await page.isHidden('section[data-tab="track"]'), '追蹤表單不在總覽裡擠版面');
check(await page.locator('.kpi .trend .base').count() === 1, 'KPI 趨勢膠囊分兩行（基準值自己一行）');
// 議題排行 → 簡報
await page.click('#board .linkbtn >> nth=0');
await page.waitForSelector('#deck-slides .slide');
check(page.url().endsWith('#deck'), '議題排行按「簡報」→ 切到簡報分頁');
const n = await page.locator('#deck-slides .slide').count();
check(n >= 6, `產生 ${n} 張投影片`);
check((await page.textContent('#deck-slides .slide.cover')).includes('固態電池'), '封面是剛點的議題');
check(!(await page.textContent('#deck-slides')).includes('成果績效報告'), '沒通過 D+31 檢定時，簡報不會掛「成果績效」的名');
if (OUT) await page.screenshot({ path: OUT + '/g-deck.png' });
// 播放
await page.click('#deck-slides .slide >> nth=1');
check(await page.isVisible('#deck-stage.on'), '點縮圖 → 全螢幕播放');
await page.keyboard.press('ArrowRight');
check((await page.textContent('#deck-stage-no')).startsWith('3 /'), '→ 下一張');
await page.keyboard.press('ArrowLeft');
check((await page.textContent('#deck-stage-no')).startsWith('2 /'), '← 上一張');
if (OUT) await page.screenshot({ path: OUT + '/g-present.png' });
await page.keyboard.press('Escape');
check(await page.isHidden('#deck-stage'), 'Esc 離開播放');
// 複製簡報文字：不能有大括號
await page.click('text=複製簡報文字');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.includes('【投影片標題】') && !/[{}]/.test(clip), '複製簡報文字：沒有殘留的 { } 大括號');
// 列印成 PDF：一頁一張
await page.evaluate(() => { const st = document.createElement('style'); st.textContent = '@page{size:A4 landscape;margin:8mm}'; document.head.appendChild(st); document.body.classList.add('print-deck'); });
const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
check(pages === n, `存 PDF：${pages} 頁 = ${n} 張投影片`);
if (OUT) fs.writeFileSync(OUT + '/deck.pdf', pdf);
await page.evaluate(() => document.body.classList.remove('print-deck'));
// 詳細版一頁報告還在
check(await page.isVisible('#rep-card'), '詳細版一頁報告在簡報下面');
// 活動效應欄位
await page.click('#tabs button[data-go="overview"]');
check((await page.textContent('#events')).includes('第 15–30 天'), '活動效應欄位改名，不叫「基線抬升」');
// 同仁連結
const staff = await browser.newPage();
const serrs = []; staff.on('pageerror', e => serrs.push(e.message));
await staff.goto(base + '/geo?code=abc#settings'); await staff.waitForTimeout(2000);
check(await staff.isVisible('#summary-card'), '同仁連結停在 #settings：退回總覽，不是一片空白');
check(await staff.locator('#tabs button[data-go="settings"]').count() === 0, '同仁看不到設定分頁');
check(serrs.length === 0, `同仁連結沒有 JS 錯誤 ${serrs.join('；')}`);
check(errs.length === 0, `全程沒有 JS 錯誤 ${errs.join('；')}`);
await browser.close();
server.close();
console.log(fails ? `\n失敗 ${fails} 項 ❌` : '\nGEO 瀏覽器驗證全部通過 ✅');
process.exit(fails ? 1 : 0);
