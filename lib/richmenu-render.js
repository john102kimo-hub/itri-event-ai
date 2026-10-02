// 圖文選單「報名那一格」的畫字（批次 113）。
//
// 為什麼要有：選單底圖是一張靜態 PNG，格子上的字（原本寫死「眺望研討會報名／10/28 起」）換活動就要改程式、
// 到原本那台機器重產底圖。朱朱要的是「後台挑哪一場、按一下直接同步」，所以同步的當下把那一場的名稱畫到格子上，
// 再把整張圖送給 LINE。
//
// 怎麼畫：拿現成的底圖（public/richmenu-reporter-reg.png，其餘五格一個像素都不動），只把中間那一格的標題與副標
// 區塗白，用 Noto Sans TC Bold（SIL OFL，public/fonts/）重畫。**純 JS**：opentype.js 取字形輪廓、自己填色
// （抗鋸齒用「累加面積」法）、pngjs 讀寫 PNG。不用 Chromium、不用原生模組，Vercel 的 Function 裡就跑得起來。
//
// ⚠️ opentype.js、pngjs 是**動態載入**（render 時才 import）：CI 的 `npm test` 不做 npm install，
// 載入失敗只會讓「畫圖」失敗（呼叫端會退回舊圖或回報），不會讓整支 Function 起不來。
// 純函式（排版、填色）不依賴它們，npm test 直接測；真的畫一張圖見 tools/richmenu-render-check。

// 格子與字的位置，量自原本那張底圖（public/richmenu-reporter-reg.png，2500x1686）：
//   標題（92px 粗體）墨跡 y=489–569、副標（52px）墨跡 y=621–666、圖示圓底 y=166–445；格線 2px 畫在格子右緣與下緣。
// 用墨跡的垂直中心對齊，這樣換字型後標題仍跟左右兩格同一條基線。
export const LABEL = { size: 92, spacing: 2, color: [0x14, 0x20, 0x2E], inkCenter: 529, maxWidth: 777 };
export const SUB = { size: 52, spacing: 1, color: [0x8A, 0x94, 0xA0], inkCenter: 643, maxWidth: 777 };
export const CLEAR_TOP = 470;          // 從圖示圓底下方開始塗白
export const CLEAR_BOTTOM_PAD = 50;    // 離格子下緣留白（格線在最下面 2px）
// Noto Sans TC 的 CJK 字墨跡相對基線約 -0.85em ～ +0.09em，中心約在基線上方 0.38em
const INK_CENTER_ABOVE_BASELINE = 0.38;

// ── 填色：font-rs 的「累加面積」法 ─────────────────────────────────────
// 每條邊把「它切過的每個像素」的有號面積累加進去，最後沿列累加就是各像素的覆蓋率。
// 重疊的同向輪廓（CJK 筆畫常見）累加超過 1，取 min(1, |acc|)；反向輪廓（洞）自然抵銷。
function addLine(a, stride, h, x0, y0, x1, y1) {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) { dir = -1; [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  let yStart = Math.floor(y0);
  if (y0 < 0) { x -= y0 * dxdy; yStart = 0; }
  const yEnd = Math.min(h, Math.ceil(y1));
  const maxX = stride - 2;
  for (let y = Math.max(0, yStart); y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    let xa = x < xnext ? x : xnext, xb = x < xnext ? xnext : x;
    xa = Math.min(Math.max(xa, 0), maxX); xb = Math.min(Math.max(xb, 0), maxX);
    const x0f = Math.floor(xa), x0i = x0f;
    const x1c = Math.ceil(xb), x1i = x1c;
    if (x1i <= x0i + 1) {
      const xmf = 0.5 * (xa + xb) - x0f;
      a[row + x0i] += d - d * xmf;
      a[row + x0i + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const x0fr = xa - x0f;
      const a0 = 0.5 * s * (1 - x0fr) * (1 - x0fr);
      const x1fr = xb - x1c + 1;
      const am = 0.5 * s * x1fr * x1fr;
      a[row + x0i] += d * a0;
      if (x1i === x0i + 2) {
        a[row + x0i + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - x0fr);
        a[row + x0i + 1] += d * (a1 - a0);
        for (let xi = x0i + 2; xi < x1i - 1; xi++) a[row + xi] += d * s;
        const a2 = a1 + (x1i - x0i - 3) * s;
        a[row + x1i - 1] += d * (1 - a2 - am);
      }
      a[row + x1i] += d * am;
    }
    x = xnext;
  }
}

/** contours：[[ [x,y], ... ], ...]（每條輪廓自動封閉）。回傳 Float32Array(w*h)，每格 0..1 的覆蓋率。 */
export function coverage(w, h, contours) {
  const stride = w + 2;
  const acc = new Float32Array(stride * h + 2);
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const p = c[i], q = c[(i + 1) % c.length];
      addLine(acc, stride, h, p[0], p[1], q[0], q[1]);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * stride + x];
      out[y * w + x] = Math.min(1, Math.abs(sum));
    }
  }
  return out;
}

/** opentype.js 的路徑指令（M/L/Q/C/Z）攤平成折線輪廓。 */
export function flattenCommands(commands) {
  const contours = [];
  let cur = null, px = 0, py = 0;
  const steps = (len) => Math.min(24, Math.max(4, Math.ceil(len / 3)));
  for (const c of commands) {
    if (c.type === 'M') { if (cur && cur.length > 1) contours.push(cur); cur = [[c.x, c.y]]; px = c.x; py = c.y; }
    else if (!cur) continue;
    else if (c.type === 'L') { cur.push([c.x, c.y]); px = c.x; py = c.y; }
    else if (c.type === 'Q') {
      const n = steps(Math.hypot(c.x1 - px, c.y1 - py) + Math.hypot(c.x - c.x1, c.y - c.y1));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        cur.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y]);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'C') {
      const n = steps(Math.hypot(c.x1 - px, c.y1 - py) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        cur.push([
          u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'Z') { if (cur && cur.length > 1) contours.push(cur); cur = null; }
  }
  if (cur && cur.length > 1) contours.push(cur);
  return contours;
}

// ── 排版 ──────────────────────────────────────────────────────────────
/** 逐字貪婪換行（CJK 每個字都可以斷）。超過 maxLines 回 null。measure(text) 回像素寬。 */
export function wrapLines(text, measure, maxWidth, maxLines) {
  const lines = [];
  let cur = '';
  for (const ch of [...String(text)]) {
    if (cur && measure(cur + ch) > maxWidth) { lines.push(cur); cur = ch; }
    else cur += ch;
    if (lines.length >= maxLines) return null;
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/**
 * 標題排版：先試一行（字級 92→70，放得下就不換行，免得剩一個字孤零零在第二行）；
 * 一行放不下才平均切成兩行（字級 80→62，切點選兩行寬度最接近的地方）；全都放不下才截斷加「…」。
 * measure(text, size) 回像素寬。回傳 { size, lines }。
 */
export function layoutLabel(text, measure, { oneLine = [92, 80, 70], twoLine = [80, 70, 62], maxWidth = LABEL.maxWidth } = {}) {
  const t = String(text || '').trim();
  for (const size of oneLine) if (measure(t, size) <= maxWidth) return { size, lines: [t] };
  const split = (chars, size) => {   // 兩行寬度最接近、而且都放得下的切點；沒有回 null
    let best = null;
    for (let i = 1; i < chars.length; i++) {
      const a = chars.slice(0, i).join(''), b = chars.slice(i).join('');
      const wa = measure(a, size), wb = measure(b, size);
      if (wa > maxWidth || wb > maxWidth) continue;
      if (!best || Math.abs(wa - wb) < best.diff) best = { diff: Math.abs(wa - wb), lines: [a, b] };
    }
    return best && best.lines;
  };
  const chars = [...t];
  for (const size of twoLine) {
    const lines = split(chars, size);
    if (lines) return { size, lines };
  }
  const size = twoLine[twoLine.length - 1];
  for (let n = chars.length - 1; n >= 2; n--) {   // 還是放不下：從尾巴一個字一個字拿掉，補「…」
    const lines = split([...chars.slice(0, n), '…'], size);
    if (lines) return { size, lines };
  }
  return { size, lines: [chars[0] || ''] };
}

/** 副標：一行；放不下就縮字級，最後截斷加「…」。 */
export function layoutSub(text, measure, { sizes = [52, 46, 40, 34], maxWidth = SUB.maxWidth } = {}) {
  const t = String(text || '').trim();
  for (const size of sizes) if (measure(t, size) <= maxWidth) return { size, line: t };
  const size = sizes[sizes.length - 1];
  let chars = [...t];
  while (chars.length > 1) { chars = chars.slice(0, -1); if (measure(chars.join('') + '…', size) <= maxWidth) return { size, line: chars.join('') + '…' }; }
  return { size, line: t };
}

// ── 畫圖 ──────────────────────────────────────────────────────────────
let fontCache = null;
export function resetFontCache() { fontCache = null; }

async function loadFont(fetchFont) {
  if (fontCache) return fontCache;
  const ot = (await import('opentype.js')).default;
  const buf = await fetchFont();
  fontCache = ot.parse(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return fontCache;
}

function makeMeasure(font, spacing) {
  return (text, size) => {
    const chars = [...text];
    const scale = size / font.unitsPerEm;
    return chars.reduce((w, ch) => w + font.charToGlyph(ch).advanceWidth * scale, 0) + spacing * Math.max(0, chars.length - 1);
  };
}

function blend(img, bx, by, w, h, cov, [r, g, b]) {
  for (let y = 0; y < h; y++) {
    const iy = by + y;
    if (iy < 0 || iy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const c = cov[y * w + x];
      if (c <= 0.003) continue;
      const ix = bx + x;
      if (ix < 0 || ix >= img.width) continue;
      const i = (iy * img.width + ix) * 4;
      img.data[i] = Math.round(img.data[i] + (r - img.data[i]) * c);
      img.data[i + 1] = Math.round(img.data[i + 1] + (g - img.data[i + 1]) * c);
      img.data[i + 2] = Math.round(img.data[i + 2] + (b - img.data[i + 2]) * c);
    }
  }
}

function drawLine(img, font, text, { cx, baseline, size, spacing, color }) {
  const scale = size / font.unitsPerEm;
  const chars = [...text];
  const adv = chars.map((ch) => font.charToGlyph(ch).advanceWidth * scale);
  const total = adv.reduce((s, v) => s + v, 0) + spacing * Math.max(0, chars.length - 1);
  const bx = Math.floor(cx - total / 2) - 6, by = Math.floor(baseline - size * 1.1);
  const w = Math.ceil(total) + 12, h = Math.ceil(size * 1.6);
  const contours = [];
  let x = cx - total / 2 - bx;
  chars.forEach((ch, i) => {
    const g = font.charToGlyph(ch);
    // 字型裡沒有的字（index 0 是 .notdef 的方框）不畫，免得選單上出現豆腐方塊；寬度照留
    if (g.index !== 0 && ch.trim()) contours.push(...flattenCommands(g.getPath(x, baseline - by, size).commands));
    x += adv[i] + spacing;
  });
  blend(img, bx, by, w, h, coverage(w, h, contours), color);
}

/**
 * 把「報名那一格」的標題與副標換成指定的字，回傳新的 PNG（Buffer）。
 *   basePng：底圖（public/richmenu-reporter-reg.png 的內容）
 *   tile：{ x, y, width, height }，該格的可點區域（來自 buildRichMenuDefinition，跟 LINE 那邊同一個來源）
 *   deps.fetchFont：() => Promise<ArrayBuffer>，取字型檔（見 lib/richmenu-sync.js）
 * 其餘五格、格線、圖示一個像素都不動。
 */
export async function renderRegMenuImage(basePng, { label, sub, tile }, deps = {}) {
  const { PNG } = deps.PNG ? { PNG: deps.PNG } : (await import('pngjs')).default;
  const font = deps.font || await loadFont(deps.fetchFont);
  const img = PNG.sync.read(basePng);
  if (img.width !== 2500 || img.height !== 1686) throw new Error(`底圖尺寸不對（${img.width}x${img.height}），要 2500x1686`);

  // 塗白：標題與副標區（避開右緣與下緣各 2px 的格線）
  const x0 = tile.x + 6, x1 = tile.x + tile.width - 6;
  const y0 = tile.y + CLEAR_TOP, y1 = tile.y + tile.height - CLEAR_BOTTOM_PAD;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = 255;
  }

  const cx = tile.x + tile.width / 2;
  const lab = layoutLabel(label, makeMeasure(font, LABEL.spacing), { maxWidth: Math.min(LABEL.maxWidth, tile.width - 56) });
  const lineH = Math.round(lab.size * 1.04);
    // 第一行的墨跡中心固定在原圖標題的 y=529（跟左右兩格同一條線）；兩行時第二行往下延伸，不往上頂到圖示
  const firstCenter = LABEL.inkCenter;
  lab.lines.forEach((text, i) => drawLine(img, font, text, {
    cx, baseline: firstCenter + i * lineH + lab.size * INK_CENTER_ABOVE_BASELINE, size: lab.size, spacing: LABEL.spacing, color: LABEL.color
  }));
  // 副標跟在標題下方：單行時就是原圖的位置；標題變兩行時往下讓出空間
  const s = layoutSub(sub, makeMeasure(font, SUB.spacing));
  const subCenter = SUB.inkCenter + (lab.lines.length - 1) * lineH;
  if (s.line) drawLine(img, font, s.line, { cx, baseline: subCenter + s.size * INK_CENTER_ABOVE_BASELINE, size: s.size, spacing: SUB.spacing, color: SUB.color });

  const out = PNG.sync.write(img, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 });
  if (out.length > 1_000_000) throw new Error(`選單圖 ${out.length} bytes，超過 LINE 的 1MB 上限`);
  return out;
}
