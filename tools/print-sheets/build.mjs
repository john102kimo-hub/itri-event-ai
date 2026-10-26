// 現場印刷品：A4 報到立牌、A4 新聞稿封面（放在紙本新聞稿最前面）。
//
//   node tools/print-sheets/build.mjs                          # 用下面 DEFAULT 的這一場
//   node tools/print-sheets/build.mjs --url "https://line.me/R/oaMessage/%40xxxx/?%23活動代碼" \
//        --title "活動名稱" --subtitle "副標" --date "2026 年 10 月 28 日（三）" --short-date "10/28（三）" \
//        --contact "朱則瑋 0934267766" --out assets/print/另一場
//
// 輸出（每張各一份）：*.html（來源）、*.pdf（印刷用，向量 QR）、*.png（預覽、傳 LINE 用）。
// 開發機要有 Chromium＋Playwright（見 README.md）。
//
// QR 的網址格式見 lib/line-link.js lineBindUrl()：`https://line.me/R/oaMessage/{LINE_BASIC_ID}/?%23{活動代碼}`，
// 記者掃了會打開米亞的聊天室、輸入框已帶好「#活動代碼」，按傳送就接上這一場。
// 不要自己手組——忘了 %23 或 @ 沒編碼，記者掃了就接不上。後台「LINE QR」彈窗給的網址可直接貼進 --url。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.join(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

// 預設是 2027 產業發展趨勢研討會（QR 取自現場用的那張圖，掃出來的網址）。
const CFG = {
  url: arg('url', 'https://line.me/R/oaMessage/%40300adknw/?%232027--mu3o3x5r'),
  title: arg('title', '眺望～2027 產業發展趨勢研討會'),
  subtitle: arg('subtitle', '開幕暨年度專刊《啟自主：無人科技 百業新生》'),
  date: arg('date', '2026 年 10 月 28 日（三）'),
  shortDate: arg('short-date', '10/28（三）'),
  contact: arg('contact', '朱則瑋 0934267766'),
  out: path.resolve(ROOT, arg('out', 'assets/print/2027-trend-forum'))
};

// ── QR：用後台同一份 qrcode-generator，輸出成向量 path（印多大都不糊）──────────
function qrSvg(url, { quiet = 4 } = {}) {
  const ctx = { window: {}, module: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/qrcode.js'), 'utf8') + '\n;this.__qr = qrcode;', ctx);
  const qr = ctx.__qr(0, 'Q'); // Q：約 25% 容錯，紙張折到、沾到髒污還掃得到
  qr.addData(url, 'Byte'); qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n;) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let e = c; while (e < n && qr.isDark(r, e)) e++;
      d += `M${c + quiet} ${r + quiet}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  }
  const size = n + quiet * 2;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

// ── 工研院 logo：官網 https://www.itri.org.tw/images/itrilogo.svg 原檔（260x60）──
const LOGO = fs.readFileSync(path.join(import.meta.dirname, 'itrilogo.svg'), 'utf8')
  .replace(/<\?xml[^>]*>/, '')
  .replace(/id="[^"]*"/, '')
  .replace(/<title>.*?<\/title>/s, '')
  .replace(/\.cls-/g, '.itri-cls-').replace(/class="cls-/g, 'class="itri-cls-')
  .replace(/<svg /, '<svg class="logo" ');
const MIA = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public/mia-avatar.png')).toString('base64');
const FONT = 'file://' + path.join(ROOT, 'public/fonts/NotoSansTC-Bold.ttf');
const QR = qrSvg(CFG.url);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const BASE_CSS = `
@font-face { font-family: "NotoTC"; src: url("${FONT}"); font-weight: 700; }
@page { size: 210mm 297mm; margin: 0; }
:root { --green: #0F9E7A; --green-d: #0B7A5E; --ink: #1E3A4A; --mute: #5B7080; --soft: #EAF6F2; --itri: #00AAEA; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 210mm; height: 297mm; }
body { font-family: "NotoTC", "WenQuanYi Zen Hei", sans-serif; font-weight: 700; color: var(--ink); background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; }
.logo { display: block; height: 15mm; width: auto; }
.qr { display: block; width: 100%; height: auto; }
.reg { font-family: "WenQuanYi Zen Hei", "NotoTC", sans-serif; font-weight: 400; }
`;

// ── ① 報到立牌（放在立架上，記者走近就看得到：大標、大 QR、三步驟）────────────
const standee = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>報到立牌 A4</title><style>${BASE_CSS}
.top { position: absolute; left: 16mm; right: 16mm; top: 14mm; display: flex; align-items: center; justify-content: space-between; }
.chip { background: var(--green); color: #fff; font-size: 5.2mm; padding: 2.4mm 6mm; border-radius: 99mm; letter-spacing: .5mm; }
.hero { position: absolute; left: 16mm; right: 16mm; top: 38mm; }
.eyebrow { color: var(--green); font-size: 6mm; letter-spacing: 1mm; }
h1 { font-size: 17.5mm; line-height: 1.12; margin-top: 3mm; letter-spacing: -.3mm; }
h1 em { font-style: normal; color: var(--green); }
.lead { margin-top: 5mm; font-size: 6.4mm; color: var(--mute); line-height: 1.5; }
.card { position: absolute; left: 50%; top: 128mm; transform: translateX(-50%); width: 100mm; padding: 6mm; border: 1.6mm solid var(--green); border-radius: 9mm; background: #fff; }
.scan { position: absolute; left: 50%; top: 123.5mm; transform: translateX(-50%); background: #06C755; color: #fff; font-size: 6mm; padding: 1.8mm 7mm; border-radius: 99mm; white-space: nowrap; z-index: 2; letter-spacing: .4mm; }
.steps { position: absolute; left: 16mm; right: 16mm; top: 238mm; display: flex; gap: 6mm; }
.step { flex: 1; display: flex; align-items: flex-start; gap: 3mm; font-size: 4.7mm; line-height: 1.4; }
.step i { flex: none; width: 9mm; height: 9mm; border-radius: 50%; background: var(--ink); color: #fff; font-style: normal; font-size: 5.4mm; display: flex; align-items: center; justify-content: center; }
.step span { display: block; font-size: 3.7mm; color: var(--mute); margin-top: .8mm; }
.foot { position: absolute; left: 0; right: 0; bottom: 0; height: 36mm; background: var(--soft); padding: 0 16mm; display: flex; align-items: center; gap: 7mm; }
.foot img { width: 22mm; height: 22mm; border-radius: 50%; flex: none; background: #fff; }
.foot .ev { font-size: 5.6mm; line-height: 1.35; }
.foot .ev small { display: block; font-size: 4.3mm; color: var(--mute); margin-top: 1.5mm; }
.foot .who { margin-left: auto; text-align: right; font-size: 4.2mm; color: var(--green-d); line-height: 1.5; flex: none; }
</style></head><body><div class="page">
  <div class="top">${LOGO}<div class="chip">記者報到</div></div>
  <div class="hero">
    <div class="eyebrow">SCAN ＆ ASK</div>
    <h1>掃描 QR code<br><em>直接問</em> AI 新聞助理</h1>
    <p class="lead">新聞稿重點、講者、議程、新聞照片，<br>在 LINE 上問米亞，馬上回答。</p>
  </div>
  <div class="scan">用 LINE 掃描</div>
  <div class="card">${QR}</div>
  <div class="steps">
    <div class="step"><i>1</i><div>打開 LINE 掃描<span>LINE → 掃描 QR code</span></div></div>
    <div class="step"><i>2</i><div>按「傳送」<span>已幫您填好，免打字</span></div></div>
    <div class="step"><i>3</i><div>直接問米亞<span>像跟同事聊天一樣提問</span></div></div>
  </div>
  <div class="foot">
    <img src="${MIA}" alt="">
    <div class="ev">${esc(CFG.title)}<br>${esc(CFG.subtitle)}<small>${esc(CFG.shortDate)}</small></div>
    <div class="who">工研院 MIA<br>公關小特派</div>
  </div>
</div></body></html>`;

// ── ② 新聞稿封面（放在紙本新聞稿最前面，單獨一頁；版面走「公文封面」的調性，跟立牌不同）──
const cover = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>新聞稿封面 A4</title><style>${BASE_CSS}
.bar { position: absolute; left: 0; top: 0; bottom: 0; width: 9mm; background: var(--green); }
.bar::after { content: ""; position: absolute; left: 0; top: 0; width: 9mm; height: 40mm; background: var(--itri); }
.inner { position: absolute; left: 28mm; right: 20mm; top: 0; bottom: 0; }
.logo-row { position: absolute; top: 18mm; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; }
.logo-row .date { font-size: 4.6mm; color: var(--mute); }
.kind { position: absolute; top: 58mm; left: 0; }
.kind .en { color: var(--green); font-size: 5mm; letter-spacing: 1.6mm; }
.kind h1 { font-size: 38mm; line-height: 1; margin-top: 4mm; letter-spacing: 2mm; }
.rule { position: absolute; top: 118mm; left: 0; width: 24mm; height: 2mm; background: var(--green); }
.title { position: absolute; top: 128mm; left: 0; right: 0; }
.title b { display: block; font-size: 10.5mm; line-height: 1.3; }
.title span { display: block; font-size: 7mm; line-height: 1.45; color: var(--mute); margin-top: 3mm; }
.scanbox { position: absolute; top: 178mm; left: 0; right: 0; height: 66mm; border-radius: 6mm; background: var(--soft); display: flex; align-items: center; gap: 8mm; padding: 0 8mm; }
.scanbox .q { flex: none; width: 50mm; background: #fff; padding: 2.2mm; border-radius: 3mm; }
.scanbox h2 { font-size: 8mm; line-height: 1.25; }
.scanbox h2 em { font-style: normal; color: var(--green); }
.scanbox ul { list-style: none; margin-top: 3.5mm; font-size: 4.6mm; line-height: 1.75; color: var(--ink); }
.scanbox li::before { content: ""; display: inline-block; width: 2.2mm; height: 2.2mm; border-radius: 50%; background: var(--green); margin-right: 2.6mm; vertical-align: .3mm; }
.scanbox .how { margin-top: 3mm; font-size: 3.9mm; color: var(--mute); }
.mia { position: absolute; right: -2mm; top: -9mm; width: 20mm; height: 20mm; border-radius: 50%; background: #fff; border: 1.2mm solid var(--soft); }
.contact { position: absolute; left: 0; right: 0; bottom: 30mm; font-size: 4.6mm; line-height: 1.6; display: flex; gap: 5mm; align-items: baseline; }
.contact small { color: var(--mute); font-size: 3.9mm; letter-spacing: .6mm; }
.note { position: absolute; left: 0; right: 0; bottom: 15mm; font-size: 3.5mm; color: var(--mute); line-height: 1.5; border-top: .3mm solid #D5E0E6; padding-top: 3mm; }
</style></head><body><div class="page"><div class="bar"></div><div class="inner">
  <div class="logo-row">${LOGO}<div class="date">${esc(CFG.date)}</div></div>
  <div class="kind"><div class="en">PRESS RELEASE</div><h1>新聞稿</h1></div>
  <div class="rule"></div>
  <div class="title"><b>${esc(CFG.title)}</b><span>${esc(CFG.subtitle)}</span></div>
  <div class="scanbox">
    <div class="q">${QR}</div>
    <div>
      <h2>不想翻紙本？<br>掃描後<em>直接問米亞</em></h2>
      <ul><li>新聞稿重點與數據</li><li>講者、議程、活動資訊</li><li>新聞照片與下載連結</li></ul>
      <div class="how">用 LINE 掃描 → 按「傳送」即可開始提問</div>
    </div>
    <img class="mia" src="${MIA}" alt="">
  </div>
  <div class="contact"><small>新聞聯絡人</small><span>${esc(CFG.contact)}</span></div>
  <div class="note reg">米亞是工研院的 AI 新聞助理，內容僅供參考，正式引用請以工研院官網新聞稿或發言為準。</div>
</div></div></body></html>`;

// ── 輸出 ───────────────────────────────────────────────────────────────────
fs.mkdirSync(CFG.out, { recursive: true });
const sheets = { '報到立牌-A4': standee, '新聞稿封面-A4': cover };
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
for (const [name, html] of Object.entries(sheets)) {
  const base = path.join(CFG.out, name);
  fs.writeFileSync(base + '.html', html);
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 3 });
  await page.goto('file://' + base + '.html');
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: base + '.pdf', width: '210mm', height: '297mm', printBackground: true, preferCSSPageSize: true });
  await page.screenshot({ path: base + '.png', clip: { x: 0, y: 0, width: 794, height: 1123 } });
  await page.close();
  console.log('✅', path.relative(ROOT, base) + '.{html,pdf,png}');
}
await browser.close();
