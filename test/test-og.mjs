// 記者頁的社群預覽卡（og:image）。
// 這支測的是「貼連結到 LINE/FB 會不會出現預覽卡」——關鍵是活動沒上傳照片時
// 一定要有退路，因為線上實際的狀況就是「已發布的場次 images 欄位是空的」。
//
// api/event-page.js 的 firstImageUrl() 沒有 export（那支是整頁 SSR handler，
// 為了測試而 export 內部函式會讓公開介面變大）。這裡改成直接跑整支 handler，
// 用假的 lib/sheets.js 餵資料，驗真正吐出來的 HTML——測到的是使用者真的會拿到的東西。
import { register } from 'node:module';

register('./loader-og.mjs', import.meta.url);
const { state } = await import('./fakes-og.mjs');
const handler = (await import('../api/event-page.js')).default;

const SITE = 'https://itri-event-ai.vercel.app';
const FALLBACK = `${SITE}/og-default.png`;

async function render(id) {
  let html = '';
  const res = {
    setHeader() { return this; },
    status() { return this; },
    send(body) { html = body; return this; }
  };
  await handler({ query: { id } }, res);
  return html;
}
const metaOf = (html, key) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`));
  return m ? m[1] : null;
};

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

// ── 沒有照片的場次（線上目前的真實狀況）────────────────────────────
let html = await render('no-photos');
check('沒照片也要有 og:image，否則 LINE 直接不出預覽卡', metaOf(html, 'og:image') === FALLBACK,
  String(metaOf(html, 'og:image')));
check('沒照片時 twitter:image 也要有', metaOf(html, 'twitter:image') === FALLBACK);
check('twitter:card 是大圖卡', metaOf(html, 'twitter:card') === 'summary_large_image');
check('og:image:width/height 有給（沒有的話第一次分享常出空白卡）',
  metaOf(html, 'og:image:width') === '1200' && metaOf(html, 'og:image:height') === '630');
check('og:title 仍是活動名稱', metaOf(html, 'og:title') === '沒有照片的記者會');
check('og:image:alt 帶活動名稱', metaOf(html, 'og:image:alt') === '沒有照片的記者會');

// ── 有照片的場次：優先用真正的新聞照 ────────────────────────────────
html = await render('with-photos');
check('有照片時用第一張活動照片，不是預設圖',
  metaOf(html, 'og:image') === 'https://blob.example.com/a.jpg', String(metaOf(html, 'og:image')));

// ── 照片欄位格式的各種歪招 ──────────────────────────────────────────
html = await render('caption');
check('「網址｜圖說」只取網址（全形分隔線）',
  metaOf(html, 'og:image') === 'https://blob.example.com/b.png', String(metaOf(html, 'og:image')));

html = await render('bad-formats');
check('webp／gif／http／Drive 分享連結都跳過，退回預設圖',
  metaOf(html, 'og:image') === FALLBACK, String(metaOf(html, 'og:image')));

html = await render('mixed');
check('前面幾行不合格時，挑得到後面第一張合格的',
  metaOf(html, 'og:image') === 'https://blob.example.com/ok.jpeg', String(metaOf(html, 'og:image')));

// ── 未結束的場次也要有卡（noindex 不等於不能分享）──────────────────
html = await render('active');
check('未結束場次一樣有 og:image', metaOf(html, 'og:image') === FALLBACK);
check('未結束場次維持 noindex', /noindex/.test(metaOf(html, 'robots') || ''));

console.log(`\n${fail === 0 ? '✅' : '❌'} 預覽卡測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
