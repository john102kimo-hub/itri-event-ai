// 在真的瀏覽器裡把媒體訓練的語音作答跑一遍。
//
//   node tools/training-voice-check.mjs
//
// ⚠️ 這支**刻意不放在 `test/`、也不進 `npm test`**：它需要 playwright 跟一顆
// Chromium，而 `test/` 裡的每一支都是「拿到原始碼就跑得起來」的（見
// test/test-guide-video.mjs 開頭那段「刻意不依賴 ffprobe」的說明）。前端該有的
// 靜態檢查已經在 test/training-voice.test.mjs 第 9 節做完了——element id、三層
// 退路、前後端秒數一致。這支補的是那些檢查看不到的那一半：**載進瀏覽器之後
// 到底跑不跑得起來**。
//
// 它抓得到、而靜態檢查抓不到的東西：
//   - 載入或互動時噴的 JS 執行期錯誤
//   - 麥克風真的開得起來、音量真的量得到（用 Chromium 的假裝置餵訊號）
//   - 錄完之後麥克風有沒有真的釋放（沒放掉的話，分頁的錄音紅點會一直亮著）
//   - 計時器跨過 30／60／90 秒時，class 與提示語有沒有真的換
//   - 版面在桌面寬度下沒有跑掉
//
// 前置：`npm i playwright`（不要加進 package.json 的 dependencies——正式部署用不到）。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'public');

// Chromium 的位置：先問 playwright 自己，找不到再去 PLAYWRIGHT_BROWSERS_PATH 底下翻。
// 這台機器上的路徑帶版本號（chromium-1194），寫死會在下次更新時安靜地壞掉。
function findChromium() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// 本機起一個只服務 public/ 的小 server。用 localhost 而不是 file:// 是必要的：
// file:// 不是安全上下文，navigator.mediaDevices 根本不存在，整支會直接走到
// 「這個瀏覽器不支援錄音」那條退路，語音的部分一行都測不到。
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/events') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ events: [{ id: 'ev-demo', name: '測試記者會' }] }));
  }
  const f = path.join(ROOT, url === '/training' ? 'training.html' : url);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: findChromium(),
  // 假麥克風：Chromium 會餵一段間歇的 beep 進去，MediaRecorder 真的錄得到東西。
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-capture', '--no-sandbox'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  // CDN 的圖示字型在沙箱裡連不出去、這支簡易 server 也沒有 favicon——
  // 都是跑測試的環境造成的，不是頁面的問題。真正的執行期錯誤一個都不放過。
  if (m.type() === 'error' && !/ERR_CERT|Failed to load resource/.test(t)) errors.push('console.error: ' + t);
});

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); };

await page.goto(`${base}/training?id=ev-demo&code=test`, { waitUntil: 'networkidle' });

console.log('[A] 頁面載入');
ok(errors.length === 0, `載入過程沒有 JS 錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
ok((await page.locator('#mic-btn').count()) === 1, '麥克風按鈕在');
ok((await page.title()).includes('測試記者會'), '活動名稱有帶進標題');

console.log('\n[B] 開始訓練後的語音介面');
// 出題那支 API 這裡不存在，攔下來回一題假的，把流程推到「可以作答」
await page.route('**/api/training', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ reply: '我是財經日報記者。這項技術的成本何時能降到市售水準？' }),
}));
await page.click('#start-btn');
await page.waitForSelector('#mic-btn:not([disabled])', { timeout: 10000 });
ok(await page.locator('#voice-pane').isVisible(), '預設進到語音作答（不是打字）');
ok((await page.locator('#mic-label').textContent()) === '按一下開始講', '按鈕文字正確');

console.log('\n[C] 真的錄一段（假麥克風）');
await page.click('#mic-btn');
await page.waitForTimeout(2500);
ok(await page.locator('#rec-status').isVisible(), '錄音狀態列出現');
const peak = await page.evaluate(() => peakLevel);
ok(peak > 0.02, `整段峰值 ${peak.toFixed(2)} 有過門檻 —— 「有沒有收到聲音」看的是峰值，`
  + '不是瞬間值（講話的停頓本來就會讓瞬間值歸零，用瞬間值判斷會一路誤報）');
ok(await page.evaluate(() => levelRaf !== null), '音量條的更新迴圈還活著');
ok((await page.locator('#rec-time').textContent()).match(/0:0[12]/), '計時器在跑');
const trackW = await page.locator('#level-track').evaluate((el) => el.getBoundingClientRect().width);
ok(trackW > 0 && trackW <= 210,
  `音量條在寬螢幕上沒有拉滿整行（${Math.round(trackW)}px）—— 它顯示的是瞬間音量，`
  + '一條上千 px 寬的東西跟著每個音節狂閃，會把注意力從計時器上拉走');

console.log('\n[D] 分區提示：講到第幾秒就換提示語');
for (const [sec, cls, hint] of [
  [10, 'zone-short', '1 分鐘內講完重點'],
  [40, 'zone-target', '可以準備收尾'],
  [70, 'zone-long', '請收尾'],
  [100, 'zone-toolong', '記者會抓不到重點'],
]) {
  const got = await page.evaluate((s) => {
    updateTimeZone(s);
    return { cls: document.getElementById('rec-status').className,
             hint: document.getElementById('rec-hint').textContent };
  }, sec);
  ok(got.cls.includes(cls) && got.hint.includes(hint), `${sec} 秒 → ${cls}「${got.hint}」`);
}

console.log('\n[E] 停止錄音 → 逐字稿確認畫面');
await page.route('**/api/training', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ text: '我們預計三年內把成本壓到市售水準的一半。', engine: 'openai' }),
}));
await page.click('#mic-btn');
await page.waitForSelector('#confirm-pane:visible', { timeout: 15000 });
ok((await page.locator('#transcript-box').inputValue()) === '我們預計三年內把成本壓到市售水準的一半。',
  '逐字稿帶進可編輯的框裡');
ok((await page.locator('#confirm-head-text').textContent()).includes('可以直接改'), '有告知送出前可以改');
ok(!(await page.evaluate(() => !!window.mediaStream)), '錄音停止後麥克風已釋放（分頁不會一直亮紅點）');

console.log('\n[F] 切換到打字這條退路');
await page.click('#redo-btn');
await page.click('#switch-to-type');
ok(await page.locator('#type-pane').isVisible() && !(await page.locator('#voice-pane').isVisible()), '切得過去');
ok(!(await page.locator('#user-input').isDisabled()), '打字框可以用');
ok(!(await page.locator('#send-btn').isDisabled()), '送出鈕也跟著啟用（切換模式後兩個都要能用）');

console.log(errors.length ? `\n⚠️ 期間的 JS 錯誤：\n${errors.join('\n')}` : '\n全程沒有任何 JS 錯誤');
console.log(fails === 0 ? '瀏覽器驗證全部通過 ✅' : `失敗 ${fails} 項 ❌`);
await browser.close();
server.close();
process.exit(fails === 0 ? 0 : 1);
