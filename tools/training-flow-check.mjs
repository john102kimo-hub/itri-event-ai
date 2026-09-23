// 在真的瀏覽器裡把媒體訓練「打字作答、中斷後接著練、結算報告、單題重練」跑一遍（批次 72）。
//
//   node tools/training-flow-check.mjs            （要截圖：SHOT_DIR=某個資料夾 node …）
//
// 跟 tools/training-voice-check.mjs 是一對：那支驗麥克風與錄音，這支驗整場流程。
// 一樣**不放進 npm test**——需要 playwright 跟一顆 Chromium（前置：`npm i playwright`，
// 不要加進 package.json）。後端用本機假 server 頂替，不呼叫任何真的模型。
//
// 這支存在的理由是批次 72 抓到的那個 bug：打字模式按送出鍵，送出去的是
// 「[object PointerEvent]」。靜態檢查看得到綁定寫法，但「點下去畫面上出現什麼」
// 只有真的點一次才知道——而那正是主管看到的東西。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.join(import.meta.dirname, '..', 'public');
const OUT = process.env.SHOT_DIR || '';  // 設了就存截圖（390×664，iPhone 尺寸）
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
let n = 0, evalDelay = 0; const reqs = [];
const EVAL = (i) => `---評分---\n整體分數：${[6,4,8,7,5][i%5]} / 10\n\n優點：\n• 有數字\n• 口氣穩\n\n改進建議：\n• 建議${i}：先講結論，再補背景\n• 少用「基本上」\n\n建議更好的答法：\n（示範）\n\n可直接引用的一句：\n「句子${i}：年底量產。」\n\n---下一題---\n第${i+2}題：那成本呢？`;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/events') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ events: [{ id: 'ev', name: '測試記者會' }] })); }
  if (url === '/api/training') {
    let b = ''; req.on('data', c => b += c); req.on('end', async () => {
      const body = JSON.parse(b); reqs.push(body);
      res.setHeader('content-type','application/json');
      if (body.mode === 'reporter') return res.end(JSON.stringify({ reply: '第1題：國產化比例多少？', outlet: { id: 'cna', name: '中央社', beat: 'x' } }));
      if (body.mode === 'evaluate') { if (evalDelay) await new Promise(r => setTimeout(r, evalDelay)); return res.end(JSON.stringify({ reply: EVAL(n++) })); }
      if (body.mode === 'log_session') return res.end(JSON.stringify({ success: true, avg_score: 6 }));
      res.end('{}');
    }); return;
  }
  const f = path.join(ROOT, url === '/training' ? 'training.html' : url);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
// Chromium 的位置：先問 playwright 自己，找不到再去 PLAYWRIGHT_BROWSERS_PATH 底下翻（同 training-voice-check.mjs）
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
const browser = await chromium.launch({ executablePath: findChromium() });
const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => { sessionStorage.setItem('itri_pwd', 'x'); localStorage.setItem('itri_training_answer_mode', 'type'); });
page.on('dialog', d => d.accept());
const check = (c, m) => { if (!c) fails++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const shot = (name) => (OUT ? page.screenshot({ path: path.join(OUT, name) }) : null);
const answer = async (t) => { await page.fill('#user-input', t); await page.click('#send-btn'); };
await page.goto(`${base}/training?id=ev`);
await page.click('.q-chip[data-n="3"]');
check(await page.textContent('#q-counter') === '0 / 3 題', '選 3 題後進度條顯示 0 / 3');
await page.click('#start-btn');
await page.waitForSelector('.msg.reporter');
check(await page.isHidden('#info-card'), '開始後說明卡收起來');
check(reqs.at(-1).total === 3, '出題請求帶 total=3');
await answer('答案一');
await page.waitForFunction(() => document.querySelectorAll('.msg.eval').length === 1);
// ── 重新整理後接著練 ──
await page.reload();
await page.waitForSelector('#resume-box', { state: 'visible' });
await shot('1-resume.png');
check((await page.textContent('#resume-text')).includes('1 / 3'), '接著練的提示寫出 1 / 3 題已評分');
await page.click('#resume-btn');
check(await page.locator('.msg.reporter').count() === 2 && await page.locator('.msg.eval').count() === 1, '接著練：畫面重畫出兩題一評');
check(!(await page.isDisabled('#user-input')), '接著練：直接可以答第二題');
// ── 評分途中重新整理 ──
evalDelay = 3000;
await answer('答案二');
await page.waitForTimeout(300);
await page.reload();
evalDelay = 0;
await page.waitForSelector('#resume-box', { state: 'visible' });
await page.click('#resume-btn');
check(await page.locator('.retry-btn').count() === 1, '評分途中中斷：接著練給一顆「接著評分」，不叫他重講');
const evBefore = reqs.filter(r => r.mode === 'evaluate').length;
await page.click('.retry-btn');
await page.waitForFunction(() => document.querySelectorAll('.msg.eval').length === 2);
const lastEval = reqs.filter(r => r.mode === 'evaluate').at(-1);
check(lastEval.messages.at(-1).content === '答案二', '補評分送的是剛才那段回答');
check(lastEval.messages.map(m => m.role).join(',') === 'assistant,user,assistant,user', `歷程沒有連續同角色：${lastEval.messages.map(m => m.role).join(',')}`);
check(await page.locator('.msg.user').count() === 2, '作答泡泡沒有重複');
await answer('答案三');
await page.waitForSelector('#end-screen', { state: 'visible' });
await page.waitForTimeout(700);
await shot('2-end.png');
const rep = await page.textContent('#report-body');
check(rep.includes('最該改的三件事') && rep.includes('建議'), '報告有「最該改的三件事」');
check((await page.locator('#report-body li').count()) === 3, '三件事有三條');
check(rep.includes('句子'), '報告有可以直接拿去用的一句');
check(reqs.filter(r => r.mode === 'log_session').length === 1, '整場只記一次 training_log');
check(reqs.find(r => r.mode === 'log_session').scores.length === 3, 'training_log 記 3 題分數');
await page.click('#copy-report-btn');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.includes('【媒體訓練紀錄】測試記者會') && clip.includes('最該改的三件事'), '複製出來的是可貼 LINE 的純文字重點');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-report-btn')]);
const dlPath = await dl.path(); const dlText = fs.readFileSync(dlPath, 'utf8');
check(dlText.includes('【我的回答】答案二') && dlText.includes('【訓練師】'), '下載的完整紀錄含每題回答與評語');
check(await page.evaluate(() => sessionStorage.getItem('itri_training_session:ev')) === null, '練完就清掉接著練的暫存');
// ── 最低分那題，再答一次 ──
await page.click('#drill-btn');
check((await page.textContent('.msg.reporter .bubble')).includes('第2題'), '單題重練出的是最低分（4 分）那題原文');
await answer('更好的答案');
await page.waitForSelector('#end-screen', { state: 'visible' });
await page.waitForTimeout(600);
await shot('3-drill.png');
check((await page.textContent('#report-body')).includes('4 →'), '重練結果顯示「上次 → 這次」');
check(reqs.filter(r => r.mode === 'log_session').length === 1, '單題重練不寫 training_log');
await page.click('#restart-btn');
check(await page.isVisible('#start-area') && await page.textContent('#q-counter') === '0 / 3 題', '再練一場：回到開始畫面、題數回到 3');
check((await page.textContent('#last-session')).includes('上次練習'), '開始畫面看得到上次練習');
await shot('4-last.png');
check(errs.length === 0, `全程沒有 JS 執行期錯誤${errs.length ? '：' + errs.join('；') : ''}`);
await browser.close(); server.close();
console.log(fails === 0 ? '\n瀏覽器流程驗證全部通過 ✅' : `\n失敗 ${fails} 項 ❌`);
process.exit(fails === 0 ? 0 : 1);
