// robots.txt：明確允許生成式 AI 爬蟲讀取記者問答頁，擋掉後台與訓練頁
// 對外路徑是 /robots.txt（由 vercel.json rewrite 過來）
//
// 注意：這裡「允許」只是解除封鎖，還沒結束的記者會頁面另外由 event-page.js
// 掛 noindex，所以新聞稿不會在記者會前被索引。

const SITE = 'https://itri-event-ai.vercel.app';

// 生成式引擎的爬蟲。分開列出來，之後要單獨停掉哪一家比較好改。
const AI_BOTS = [
  'GPTBot',            // OpenAI 訓練用
  'OAI-SearchBot',     // ChatGPT 搜尋
  'ChatGPT-User',      // ChatGPT 使用者即時瀏覽
  'ClaudeBot',         // Anthropic 訓練用
  'Claude-User',       // Claude 使用者即時瀏覽
  'Claude-SearchBot',  // Claude 搜尋
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',   // Google AI 摘要／Gemini
  'Applebot-Extended',
  'Bingbot',
  'CCBot'              // Common Crawl，多數模型的資料來源
];

export default function handler(req, res) {
  const lines = [];

  lines.push('# 記者會 AI 新聞助理');
  lines.push('# 後台與訓練頁不開放；記者問答頁開放，但未結束的場次會另掛 noindex');
  lines.push('');

  for (const bot of AI_BOTS) {
    lines.push(`User-agent: ${bot}`);
    lines.push('Allow: /event');
    lines.push('Disallow: /admin');
    lines.push('Disallow: /training');
    lines.push('Disallow: /api/');
    lines.push('');
  }

  lines.push('User-agent: *');
  lines.push('Allow: /event');
  lines.push('Disallow: /admin');
  lines.push('Disallow: /training');
  lines.push('Disallow: /api/');
  lines.push('');
  lines.push(`Sitemap: ${SITE}/sitemap.xml`);
  lines.push('');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(lines.join('\n'));
}
