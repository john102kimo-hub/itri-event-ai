// 真的畫一張圖文選單底圖，驗「只動報名那一格」（批次 113）。
//
//   npm install --no-package-lock --no-save   （要有 opentype.js、pngjs；不進 npm test，CI 不做 npm install）
//   node tools/richmenu-render-check/check.mjs          （要看圖：OUT=某個資料夾 node …）
//
// 用的是真的 lib/richmenu-render.js、真的 public/fonts/NotoSansTC-Bold.ttf 與 public/richmenu-reporter-reg.png。
// 驗：尺寸與 1MB 上限、標題與副標區以外的每一個像素都跟底圖相同（其餘五格、圖示、格線）、格子內確實有新字、
// 長名稱與兩行名稱放得進格子、字型裡沒有的字不會畫出方框。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { renderRegMenuImage, CLEAR_TOP, CLEAR_BOTTOM_PAD } from '../../lib/richmenu-render.js';
import { buildRichMenuDefinition, REPORTER_MENU_REG } from '../../lib/menu.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (c, m) => { if (!c) fails++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const base = fs.readFileSync(path.join(ROOT, 'public/richmenu-reporter-reg.png'));
const fontBuf = fs.readFileSync(path.join(ROOT, 'public/fonts/NotoSansTC-Bold.ttf'));
const fetchFont = async () => fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength);
const tile = buildRichMenuDefinition(REPORTER_MENU_REG).areas[1].bounds;
const baseImg = PNG.sync.read(base);

const cases = [
  ['short', '活動報名', '選場次・1 分鐘'],
  ['digits', '眺望2099場次報名', '10/28 起・選場次'],
  ['two-lines', '一二三四五六七八九十一二三四五六七八報名', '選場次'],
  ['too-long', '字'.repeat(40) + '報名', '很長很長很長很長很長很長很長很長很長很長很長很長很長'],
  ['rare-char', '眺望\u{20000}場次報名', '選場次']
];
for (const [name, label, sub] of cases) {
  const t0 = Date.now();
  const png = await renderRegMenuImage(base, { label, sub, tile }, { fetchFont });
  const img = PNG.sync.read(png);
  console.log(`── ${name}（${label.length} 字）${Date.now() - t0}ms，${png.length} bytes`);
  check(img.width === 2500 && img.height === 1686, '尺寸 2500x1686');
  check(png.length < 1_000_000, 'LINE 的 1MB 上限內');
  const y0 = tile.y + CLEAR_TOP, y1 = tile.y + tile.height - CLEAR_BOTTOM_PAD, x0 = tile.x + 6, x1 = tile.x + tile.width - 6;
  let outside = 0, inside = 0, ink = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const same = img.data[i] === baseImg.data[i] && img.data[i + 1] === baseImg.data[i + 1] && img.data[i + 2] === baseImg.data[i + 2];
    const inBand = x >= x0 && x < x1 && y >= y0 && y < y1;
    if (!inBand && !same) outside++;
    if (inBand) { inside++; if (img.data[i] < 200) ink++; }
  }
  check(outside === 0, `★ 標題與副標區以外 ${img.width * img.height - inside} 個像素跟底圖完全相同（不同：${outside}）`);
  check(ink > 2000, `格子內有字（深色像素 ${ink}）`);
  // 字不能超出格子左右（留 28px 邊）
  let minX = 1e9, maxX = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; if (img.data[i] < 200) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); } }
  check(minX >= tile.x + 20 && maxX <= tile.x + tile.width - 20, `字在格子左右邊界內（${minX - tile.x}～${maxX - tile.x} / ${tile.width}）`);
  if (OUT) fs.writeFileSync(path.join(OUT, `menu-${name}.png`), png);
}
console.log(fails ? `\n❌ ${fails} 項失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
