// 產生 public/richmenu-reporter.png 與 public/richmenu-staff.png。
//
// 為什麼是腳本、不是手寫兩份 HTML：底圖上的字必須跟 lib/menu.js 的 REPORTER_MENU／
// STAFF_MENU 逐格對齊。手維護兩份 HTML 的話，改了定義忘了改圖（或反過來）就會變成
// 「圖上寫 A、按下去送出 B」，而且沒有任何測試抓得到——使用者只會覺得選單壞了。
// 從同一份定義生成，這種走鐘在結構上就不可能發生。
//
// 用法（開發機要有 Chromium，這支不會在 Vercel 上執行）：
//   node assets/build-richmenu.mjs
//   CHROME=/path/to/chrome node assets/build-richmenu.mjs   # 指定瀏覽器
//
// 改完記得在 LINE 用職員模式重打一次「設定圖文選單」，線上才會換成新的圖。

import { writeFileSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ALL_MENUS, RICH_MENU_SIZE, buildRichMenuDefinition } from '../lib/menu.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { width, height } = RICH_MENU_SIZE;
const BRAND = '#0F9E7A';

// 格線寬高直接從 buildRichMenuDefinition() 產出的可點區域反推，不在這裡重算一次。
// 這兩組數字只要差一個像素，圖上的格線就會跟 LINE 那邊的可點區域錯開，使用者會
// 按到隔壁那格；而重算就是它們會錯開的原因。同一個來源就不可能錯開。
const AREAS = buildRichMenuDefinition(ALL_MENUS[0]).areas.map(a => a.bounds);
const COL_W = AREAS.filter(b => b.y === 0).map(b => b.width);
const ROW_H = [...new Set(AREAS.map(b => b.y))].sort((a, b) => a - b)
  .map(y => AREAS.find(b => b.y === y).height);

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function html(menu) {
  const cells = menu.buttons.slice(0, 6).map(b => `
    <div class="cell">
      <div class="icon">${b.icon}</div>
      <div class="label">${b.label}</div>
      <div class="sub">${b.sub}</div>
    </div>`).join('');

  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; overflow:hidden; }
  body {
    font-family:"WenQuanYi Zen Hei","Noto Sans CJK TC",sans-serif;
    background:#FFFFFF;
    display:grid;
    /* 逐格寫死像素，數值來自 buildRichMenuDefinition() 的可點區域（見檔案上方）。
       用 1fr 或 gap 都會讓圖上的格線與 LINE 那邊的可點區域對不齊。 */
    grid-template-columns:${COL_W.join('px ')}px;
    grid-template-rows:${ROW_H.join('px ')}px;
  }
  .cell {
    background:#FFFFFF;
    display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:24px;
    padding:32px 24px;
    /* 格線用 inset box-shadow 畫：完全不影響版面尺寸，格子仍精準等於可點區域。
       border 會吃進寬高、gap 會多出縫隙，兩者都會破壞上面那組對齊。 */
    box-shadow:inset -2px 0 0 #E8ECEA, inset 0 -2px 0 #E8ECEA;
  }
  .icon {
    width:210px; height:210px; border-radius:50%;
    background:#E7F6F1;
    display:flex; align-items:center; justify-content:center;
    font-size:108px; line-height:1;
  }
  .label { font-size:70px; font-weight:700; color:#14202E; letter-spacing:2px; text-align:center; }
  .sub   { font-size:42px; color:#7C8794; letter-spacing:1px; text-align:center; }
  /* 頂端一條主色：圖文選單貼著聊天室下緣，這是選單與對話內容的分界 */
  body::before {
    content:""; position:fixed; top:0; left:0; right:0; height:14px;
    background:${BRAND}; z-index:1;
  }
</style></head><body>${cells}</body></html>`;
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* 下一個 */ }
  }
  throw new Error(`找不到 Chromium。裝一個，或用 CHROME=/path/to/chrome 指定。\n找過：\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

const chrome = findChrome();
const tmp = mkdtempSync(join(tmpdir(), 'richmenu-'));

for (const menu of ALL_MENUS) {
  const src = join(tmp, `${menu.key}.html`);
  const out = join(ROOT, 'public', `richmenu-${menu.key}.png`);
  writeFileSync(src, html(menu));
  execFileSync(chrome, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    '--default-background-color=FFFFFFFF',
    `file://${src}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`✅ public/richmenu-${menu.key}.png  （${menu.name}：${menu.buttons.map(b => b.label).join('／')}）`);
}
