// 記者問答頁的伺服器端渲染（SSR）版本
// ──────────────────────────────────────────────────────────────────────
// 為什麼需要這支：public/event.html 是純前端渲染，活動名稱與新聞稿都是頁面
// 載入後才用 fetch 抓回來的。ChatGPT、Perplexity、Claude 這類 AI 爬蟲多數不執行
// JS，抓到的只有一個空殼，等於這個頁面對生成式引擎完全不存在。
// 這支 function 先把資料抓好、直接寫進 HTML，爬蟲才讀得到。
//
// 內容開放政策（依主辦方要求）：
//   記者會「已結束」或活動日期已過 → 渲染完整新聞稿，開放索引
//   還沒結束                      → 只出通用敘述 + noindex，避免新聞稿提前外洩
//
// vercel.json 需搭配：
//   rewrites:  /event → /api/event-page
//   functions: api/event-page.js 的 includeFiles 要含 public/event.html

import fs from 'fs';
import path from 'path';
import { readRange } from './lib/sheets.js';

const RANGE = 'events!A2:K';
const SITE = 'https://itri-event-ai.vercel.app';

// 冷啟動讀一次就好，同一個 instance 的後續請求直接用快取
let cachedTemplate = null;
function loadTemplate() {
  if (cachedTemplate === null) {
    cachedTemplate = fs.readFileSync(path.join(process.cwd(), 'public', 'event.html'), 'utf8');
  }
  return cachedTemplate;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// created_at 欄位有兩種格式：手動填的 "2026-07-08"，跟系統寫入的 "2026/6/18 下午11:06:04"
function parseEventDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return isNaN(dt.getTime()) ? null : dt;
}

function toISODate(dt) {
  return dt ? dt.toISOString().slice(0, 10) : '';
}

// 記者會辦完了沒？狀態標記為 ended，或活動日期已經過去，都算結束。
// 日期那條是保險：同仁常忘了回頭把狀態改成「已結束」。
function isConcluded(status, rawDate) {
  if (status === 'ended') return true;
  const dt = parseEventDate(rawDate);
  if (!dt) return false;
  // 給一天緩衝，避免當天早上就被當成已結束
  return Date.now() > dt.getTime() + 36 * 60 * 60 * 1000;
}

// 新聞稿純文字 → 段落 HTML。知識庫上限 45000 字，這裡不截斷，
// 讓爬蟲拿到完整內容才有 GEO 價值。
function renderBody(text) {
  return String(text)
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n      ');
}

// 摘要：給 meta description / og:description 用，控制在 155 字內
function makeSummary(name, organizer, kb, concluded) {
  if (concluded && kb) {
    const plain = String(kb).replace(/\s+/g, ' ').trim();
    if (plain.length > 20) {
      return plain.length > 150 ? plain.slice(0, 150) + '…' : plain;
    }
  }
  return `${name}＜${organizer} 記者會 AI 新聞助理。記者可直接提問新聞稿內容、技術規格、合作廠商等資訊，無需登入即時取得回覆。`;
}

export default async function handler(req, res) {
  const id = req.query?.id;
  const template = loadTemplate();

  // 沒帶 id 就原樣吐出靜態頁，讓前端自己顯示「請在網址加上 ?id=」的錯誤
  if (!id) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(200).send(template);
  }

  let row = null;
  try {
    const rows = await readRange(RANGE);
    row = rows.find(r => r[0] === id) || null;
  } catch (err) {
    // 試算表讀取失敗時不要讓整頁掛掉，退回靜態頁由前端重試
    console.error('SSR 讀取活動失敗:', err.message);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(200).send(template);
  }

  if (!row || row[4] === 'archived') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(404).send(
      template.replace('<title>AI 新聞助理</title>',
        '<title>找不到活動 — AI 新聞助理</title>\n<meta name="robots" content="noindex">')
    );
  }

  const ev = {
    id: row[0],
    name: row[1] || 'AI 新聞助理',
    color: /^#[0-9A-Fa-f]{6}$/.test(row[2] || '') ? row[2] : '#0F9E7A',
    knowledge_base: row[3] || '',
    status: row[4] || 'active',
    date: row[5] || '',
    chips: row[6] || '',
    organizer: row[9] || '工研院'
  };

  const concluded = isConcluded(ev.status, ev.date);
  const dt = parseEventDate(ev.date);
  const isoDate = toISODate(dt);
  const pageUrl = `${SITE}/event?id=${encodeURIComponent(ev.id)}`;
  const summary = makeSummary(ev.name, ev.organizer, ev.knowledge_base, concluded);
  const chipList = ev.chips.split('\n').map(s => s.trim()).filter(Boolean);

  // ── head 注入：title / meta / Open Graph / JSON-LD ──────────────────
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'NewsMediaOrganization',
        '@id': `${SITE}/#organization`,
        name: ev.organizer,
        url: SITE
      },
      {
        '@type': 'Event',
        name: ev.name,
        eventStatus: concluded
          ? 'https://schema.org/EventScheduled'
          : 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        ...(isoDate ? { startDate: isoDate } : {}),
        organizer: { '@id': `${SITE}/#organization` },
        description: summary,
        url: pageUrl
      }
    ]
  };

  // 新聞稿只在記者會結束後才進結構化資料，避免提前外洩
  if (concluded && ev.knowledge_base) {
    jsonLd['@graph'].push({
      '@type': 'NewsArticle',
      headline: ev.name.slice(0, 110),
      ...(isoDate ? { datePublished: isoDate } : {}),
      publisher: { '@id': `${SITE}/#organization` },
      mainEntityOfPage: pageUrl,
      articleBody: ev.knowledge_base
    });
  }

  const headBlock = [
    `<title>${esc(ev.name)} — AI 新聞助理｜${esc(ev.organizer)}</title>`,
    `<meta name="description" content="${esc(summary)}">`,
    `<meta name="robots" content="${concluded ? 'index, follow, max-snippet:-1, max-image-preview:large' : 'noindex, nofollow'}">`,
    `<link rel="canonical" href="${esc(pageUrl)}">`,
    `<meta property="og:type" content="${concluded ? 'article' : 'website'}">`,
    `<meta property="og:site_name" content="${esc(ev.organizer)} 記者會 AI 新聞助理">`,
    `<meta property="og:title" content="${esc(ev.name)}">`,
    `<meta property="og:description" content="${esc(summary)}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    `<meta property="og:locale" content="zh_TW">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(ev.name)}">`,
    `<meta name="twitter:description" content="${esc(summary)}">`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
  ].join('\n');

  let html = template.replace('<title>AI 新聞助理</title>', headBlock);

  // ── body 注入：記者會結束後才把新聞稿寫進 HTML ──────────────────────
  // 還沒結束的活動只在 head 出通用敘述並掛 noindex，body 不放任何實質內容。
  if (concluded) {
    const article = `
<article id="geo-article">
  <div class="geo-tag">記者會已結束 · 新聞資料存檔</div>
  <h1>${esc(ev.name)}</h1>
  <div class="geo-meta">${esc(ev.organizer)}${isoDate ? ` · ${esc(isoDate)}` : ''}</div>
  ${chipList.length ? `<div class="geo-topics"><h2>本場次提供資料</h2><ul>${chipList.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
  ${ev.knowledge_base ? `<div class="geo-body"><h2>新聞資料全文</h2>
      ${renderBody(ev.knowledge_base)}
  </div>` : ''}
  <div class="geo-foot">本頁由 ${esc(ev.organizer)} 記者會 AI 新聞助理提供。</div>
</article>`;

    const articleStyle = `
<style>
  #geo-article {
    max-width: 760px; margin: 0 auto; padding: 32px 20px 64px;
    line-height: 1.9; font-size: 0.95rem; color: #1a1a2e;
    overflow-y: auto; flex: 1;
  }
  #geo-article .geo-tag {
    display: inline-block; background: #fef3c7; color: #92400e;
    font-size: 0.75rem; font-weight: 700; padding: 4px 12px;
    border-radius: 20px; margin-bottom: 16px;
  }
  #geo-article h1 { font-size: 1.5rem; font-weight: 800; line-height: 1.4; margin-bottom: 8px; }
  #geo-article .geo-meta { color: #6b7280; font-size: 0.85rem; margin-bottom: 28px; }
  #geo-article h2 {
    font-size: 1rem; font-weight: 700; margin: 28px 0 12px;
    padding-bottom: 6px; border-bottom: 2px solid var(--primary);
    display: inline-block;
  }
  #geo-article ul { padding-left: 22px; }
  #geo-article li { margin-bottom: 4px; }
  #geo-article .geo-body p { margin-bottom: 16px; }
  #geo-article .geo-foot {
    margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb;
    font-size: 0.8rem; color: #9ca3af;
  }
  /* 存檔模式：藏掉聊天介面，只留文章 */
  body.archive-mode #media-banner,
  body.archive-mode #welcome,
  body.archive-mode #chips,
  body.archive-mode #messages,
  body.archive-mode #input-area,
  body.archive-mode #image-gallery { display: none !important; }
</style>`;

    html = html
      .replace('</head>', articleStyle + '\n</head>')
      .replace('</body>', article + '\n</body>');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 讓 CDN 快取 5 分鐘、背景重新驗證，減少對 Google Sheets 的請求量
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
  if (!concluded) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).send(html);
}
