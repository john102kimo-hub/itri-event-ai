import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// ⚠️ viewport 用 360×640（設計就是照手機寬度做的），deviceScaleFactor 2 讓錄下來
// 是 720×1280 的實際像素。用 720 當 viewport 會讓字級相對畫面縮成一半。
const ctx = await b.newContext({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 1,
  recordVideo: { dir: "vid", size: { width: 360, height: 640 } }
});
const t0 = Date.now();
const page = await ctx.newPage();
await page.goto('file:///home/user/itri-event-ai/public/guide.html', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.body.classList.add('clean');
  document.getElementById('again').click();   // 從第 1 格重播
});
const offset = (Date.now() - t0) / 1000;
await page.waitForTimeout(30600);
await ctx.close();
await b.close();
console.log('OFFSET=' + offset.toFixed(2));
