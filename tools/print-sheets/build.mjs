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
// QR 放活動網頁連結（`https://{網域}/event?id={活動代碼}`），掃了開的是網頁版 AI 問答，所以印刷品上的說明文字
// 一律講「AI 問答頁」、不提 LINE（朱朱要求：點進去不是 LINE，旁邊的字就不能寫 LINE）。
// 想讓 QR 直接開 LINE 的話，--url 換成後台「LINE QR」彈窗給的網址（lib/line-link.js lineBindUrl()），
// 步驟文字（build.mjs 裡的 .steps 與 .how）也要跟著改成「掃描 → 按傳送」。
// 輸出的 PDF／PNG 不進 git（.gitignore 的 assets/print/），印完或傳完就丟，要改場次重跑即可。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.join(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

// 預設是 2027 產業發展趨勢研討會。
const CFG = {
  url: arg('url', 'https://itri-event-ai.vercel.app/event?id=2027--mu3o3x5r'),
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
.hero { position: absolute; left: 16mm; right: 16mm; top: 36mm; }
.eyebrow { color: var(--green); font-size: 6mm; letter-spacing: 1mm; }
h1 { font-size: 14.5mm; line-height: 1.12; margin-top: 0; letter-spacing: -.3mm; }
h1 em { font-style: normal; color: var(--green); }
.lead { margin-top: 4mm; font-size: 5.4mm; color: var(--mute); line-height: 1.5; white-space: nowrap; }
.card { position: absolute; left: 50%; top: 88mm; transform: translateX(-50%); width: 144mm; padding: 2mm; border: 1.6mm solid var(--green); border-radius: 9mm; background: #fff; }
.scan { position: absolute; left: 50%; top: 83.5mm; transform: translateX(-50%); background: #06C755; color: #fff; font-size: 6mm; padding: 1.8mm 7mm; border-radius: 99mm; white-space: nowrap; z-index: 2; letter-spacing: .4mm; }
.steps { position: absolute; left: 16mm; right: 16mm; top: 240mm; display: flex; gap: 6mm; }
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
    <h1>掃描 QR code<br><em>直接問</em> AI 新聞助理</h1>
    <p class="lead">新聞稿重點、講者、議程、新聞照片，掃描後直接問米亞。</p>
  </div>
  <div class="scan">掃描 QR code</div>
  <div class="card">${QR}</div>
  <div class="steps">
    <div class="step"><i>1</i><div>用手機掃描<span>開啟相機對準即可</span></div></div>
    <div class="step"><i>2</i><div>進入 AI 問答頁<span>先留下媒體與姓名</span></div></div>
    <div class="step"><i>3</i><div>直接輸入問題<span>米亞馬上回答</span></div></div>
  </div>
  <div class="foot">
    <img src="${MIA}" alt="">
    <div class="ev">${esc(CFG.title)}<br>${esc(CFG.subtitle)}<small>${esc(CFG.shortDate)}</small></div>
    <div class="who">工研院 MIA<br>公關小特派</div>
  </div>
</div></body></html>`;

// ── ② 新聞稿封面（放在紙本新聞稿最前面，單獨一頁）──────────────────────────────
// 做成「書封」：上面一塊色底放書名（新聞稿＋活動名稱），下面是整張的主角——大 QR。
// ⚠️ 訂書針只會訂左上角：左上 30×30 mm 不放任何字、圖、QR，色塊本身讓訂書針穿過沒關係。
// ⚠️ 辦公室印表機印不到紙邊（通常留 4～5 mm），所以不做滿版出血，色塊與外框都內縮 12 mm。
// 記者沒有耐心：QR 圖樣約 112 mm 見方、一眼就是重點，其餘文字都收到最少。
const cover = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>新聞稿封面 A4</title><style>${BASE_CSS}
.head { position: absolute; left: 12mm; top: 12mm; width: 186mm; height: 102mm; background: var(--green); border-radius: 6mm; color: #fff; overflow: hidden; }
.head .logo-chip { position: absolute; right: 8mm; top: 8mm; background: #fff; border-radius: 3mm; padding: 2.4mm 4mm; }
.head .logo-chip .logo { height: 11mm; }
.head .eyebrow { position: absolute; left: 14mm; top: 36mm; font-size: 4.2mm; letter-spacing: .5mm; opacity: .9; }
.head h1 { position: absolute; left: 14mm; top: 43mm; font-size: 30mm; line-height: 1; letter-spacing: 1.5mm; }
.head .mia { position: absolute; right: 12mm; top: 44mm; width: 40mm; height: 40mm; border-radius: 50%; background: #fff; border: 1.6mm solid rgba(255,255,255,.55); }
.head .ev { position: absolute; left: 14mm; right: 10mm; top: 79mm; }
.head .ev b { display: block; font-size: 7.4mm; line-height: 1.3; }
.head .ev span { display: block; font-size: 5mm; line-height: 1.4; opacity: .92; margin-top: 1mm; }
.ask { position: absolute; left: 0; right: 0; top: 119mm; text-align: center; font-size: 8.6mm; line-height: 1.2; }
.ask em { font-style: normal; color: var(--green); }
.qrcard { position: absolute; left: 50%; top: 131mm; transform: translateX(-50%); width: 140mm; padding: 0; border: 1.6mm solid var(--green); border-radius: 8mm; background: #fff; overflow: hidden; }
.contact { position: absolute; left: 12mm; right: 12mm; top: 273mm; text-align: center; font-size: 4.4mm; }
.contact small { color: var(--mute); font-size: 3.8mm; letter-spacing: .5mm; margin-right: 3mm; }
.note { position: absolute; left: 12mm; right: 12mm; top: 281mm; text-align: center; font-size: 3.2mm; color: var(--mute); }
</style></head><body><div class="page">
  <div class="head">
    <div class="logo-chip">${LOGO}</div>
    <div class="eyebrow">PRESS RELEASE　｜　${esc(CFG.date)}</div>
    <h1>新聞稿</h1>
    <img class="mia" src="${MIA}" alt="">
    <div class="ev"><b>${esc(CFG.title)}</b><span>${esc(CFG.subtitle)}</span></div>
  </div>
  <div class="ask">不想翻紙本？<em>掃描直接問米亞</em></div>
  <div class="qrcard">${QR}</div>
  <div class="contact reg"><small>新聞聯絡人</small>${esc(CFG.contact)}</div>
  <div class="note reg">米亞是工研院的 AI 新聞助理，內容僅供參考，正式引用請以工研院官網新聞稿或發言為準。</div>
</div></body></html>`;

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
