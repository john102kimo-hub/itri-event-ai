// 產生 public/food-icon-*.png（「吃什麼地圖」加到手機主畫面時的圖示）。
//
// 為什麼用腳本而不是手工圖檔：圖示要四種尺寸（180 給 iOS、192／512 給 Android，
// 另一張 maskable 版留安全邊距），手工輸出很容易某一張忘了更新，
// 而使用者只會在某一支手機上看到舊圖、幾乎不會回報。從同一份定義生就不可能不同步。
//
// 為什麼自己畫點陣圖、不用 Chromium 截圖（assets/build-richmenu.mjs 的做法）：
// Chromium 的 --window-size 含瀏覽器介面高度，截出來的圖底部會固定少 82 像素，
// 圖示這種「尺寸必須剛好」的東西一被裁掉就整個歪掉。這裡的圖形只有半圓、圓角矩形
// 與三條曲線，直接算像素反而更短、更準，而且開發機不必裝瀏覽器。
//
// 用法：node assets/build-food-icon.mjs
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = [15, 158, 122];   // #0F9E7A，跟平台其他頁面同一個主色
const WHITE = [255, 255, 255];
const SS = 4;                    // 超取樣倍率：先畫 4 倍大再縮，邊緣才不會有鋸齒

// ── 幾何判斷（都在 0..1 的相對座標上算，換尺寸不用改任何數字）──────────
const insideRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// 碗身：半圓，只取圓心以下那一半
const insideBowl = (x, y, cx, cy, r) => y >= cy && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
// 線段距離，用來把折線加粗成筆畫
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// 三次貝茲取樣成折線；蒸氣的波浪就是這樣畫的
function bezier(p0, p1, p2, p3, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ]);
  }
  return pts;
}
const STEAM = [
  bezier([.383, .406], [.344, .363], [.422, .328], [.383, .277]),
  bezier([.500, .391], [.461, .344], [.539, .305], [.500, .250]),
  bezier([.617, .406], [.578, .363], [.656, .328], [.617, .277])
];
const nearPolyline = (x, y, pts, w) => {
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= w / 2) return true;
  }
  return false;
};

/**
 * 畫一張圖示。pad 是四周留白比例：maskable 版要留 0.2，
 * 因為 Android 會把圖示裁成圓形或圓角方形，沒留邊碗緣就會被切掉。
 */
function draw(size, pad) {
  const n = size * SS;
  const acc = new Float64Array(n * n * 4);
  const k = 1 - pad * 2;
  const m = (v) => pad + v * k;   // 相對座標 → 加了留白之後的相對座標

  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = (px + .5) / n, y = (py + .5) / n;
      let col = null, a = 0;
      // 底：圓角方形（maskable 版滿版，因為外框由系統裁）
      if (insideRoundRect(x, y, m(0), m(0), m(1), m(1), pad ? 0 : .219)) { col = BRAND; a = 1; }
      if (a) {
        const inBowl = insideBowl(x, y, m(.5), m(.523), .25 * k);
        const inRim = insideRoundRect(x, y, m(.203), m(.488), m(.797), m(.547), .029 * k);
        let white = inBowl || inRim;
        if (!white) {
          for (const s of STEAM) {
            if (nearPolyline(x, y, s.map(([sx, sy]) => [m(sx), m(sy)]), .031 * k)) { white = true; break; }
          }
        }
        if (white) col = WHITE;
      }
      const o = (py * n + px) * 4;
      acc[o] = col ? col[0] : 0; acc[o + 1] = col ? col[1] : 0; acc[o + 2] = col ? col[2] : 0; acc[o + 3] = a ? 255 : 0;
    }
  }

  // 4×4 平均縮回目標尺寸 = 抗鋸齒。顏色要用「乘上 alpha 再平均」才不會在
  // 透明邊緣長出一圈黑邊（未乘 alpha 的透明像素顏色是 0,0,0）。
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * size * SS + (x * SS + dx)) * 4;
        const al = acc[o + 3] / 255;
        r += acc[o] * al; g += acc[o + 1] * al; b += acc[o + 2] * al; a += al;
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / (SS * SS) * 255);
    }
  }
  return out;
}

// ── 最小 PNG 編碼（RGBA、無濾波）────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter type 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const [file, size, pad] of [
  ['food-icon-512.png', 512, 0],
  ['food-icon-192.png', 192, 0],
  ['food-icon-180.png', 180, 0],
  ['food-icon-maskable.png', 512, 0.2]
]) {
  writeFileSync(join(ROOT, 'public', file), png(draw(size, pad), size));
  console.log(`✅ public/${file}  ${size}×${size}${pad ? '（maskable，留 20% 邊距）' : ''}`);
}
