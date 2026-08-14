// sitemap.xml：只列出已結束的記者會
// 還沒辦的場次掛 noindex，列進 sitemap 只會讓爬蟲白跑一趟，也可能提前洩漏場次名稱。

import { readRange } from './lib/sheets.js';

const RANGE = 'events!A2:K';
const SITE = 'https://itri-event-ai.vercel.app';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function parseEventDate(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(dt.getTime()) ? null : dt;
}

// 與 event-page.js 的判斷保持一致
function isConcluded(status, rawDate) {
  if (status === 'ended') return true;
  const dt = parseEventDate(rawDate);
  if (!dt) return false;
  return Date.now() > dt.getTime() + 36 * 60 * 60 * 1000;
}

export default async function handler(req, res) {
  let rows = [];
  try {
    rows = await readRange(RANGE);
  } catch (err) {
    console.error('sitemap 讀取活動失敗:', err.message);
  }

  const urls = rows
    .filter(r => r[0] && r[4] !== 'archived' && isConcluded(r[4], r[5]))
    .map(r => {
      const dt = parseEventDate(r[5]);
      return {
        loc: `${SITE}/event?id=${encodeURIComponent(r[0])}`,
        lastmod: dt ? dt.toISOString().slice(0, 10) : ''
      };
    });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(u => [
      '  <url>',
      `    <loc>${esc(u.loc)}</loc>`,
      u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : '',
      '    <changefreq>monthly</changefreq>',
      '  </url>'
    ].filter(Boolean).join('\n')),
    '</urlset>',
    ''
  ].join('\n');

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(xml);
}
