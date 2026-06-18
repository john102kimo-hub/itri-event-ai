// 問答分析 API
// GET ?password=xxx             → 全部活動統計
// GET ?password=xxx&event_id=xx → 單一活動統計

import { readRange } from './lib/sheets.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { password, event_id } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });

  try {
    const rows = await readRange('qa_log!A2:F');
    const filtered = event_id ? rows.filter(r => r[1] === event_id) : rows;

    // 按活動分組
    const byEvent = {};
    filtered.forEach(r => {
      const eid = r[1] || 'unknown';
      if (!byEvent[eid]) {
        byEvent[eid] = { event_id: eid, event_name: r[2] || eid, count: 0, media_list: new Set(), questions: [] };
      }
      byEvent[eid].count++;
      if (r[3] && r[3] !== '（未填寫）') byEvent[eid].media_list.add(r[3]);
      byEvent[eid].questions.push({ time: r[0], media: r[3], question: r[4], answer: r[5] });
    });

    // 序列化（Set 不能直接 JSON）
    const byEventArr = Object.values(byEvent).map(e => ({
      ...e,
      media_list: [...e.media_list],
      media_count: e.media_list.size
    }));

    // 關鍵字統計（簡易斷詞）
    const stopWords = new Set([
      '的', '了', '是', '在', '有', '和', '與', '這', '那', '什麼', '請問',
      '可以', '嗎', '呢', '嗎？', '?', '？', '一', '會', '不', '也', '都',
      '我', '你', '他', '她', '我們', '他們', '您', '這個', '那個', '如何',
      '為什麼', '是否', '能否', '目前', '已經', '未來', '關於'
    ]);
    const keywords = {};
    filtered.forEach(r => {
      const q = r[4] || '';
      // 擷取 2-8 字的中文詞彙與英文單字
      const matches = q.match(/[一-龥]{2,8}|[a-zA-Z]{3,}/g) || [];
      matches.forEach(word => {
        if (!stopWords.has(word)) {
          keywords[word] = (keywords[word] || 0) + 1;
        }
      });
    });

    const topKeywords = Object.entries(keywords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // 每小時分佈
    const hourly = Array(24).fill(0);
    filtered.forEach(r => {
      const timeStr = r[0] || '';
      const match = timeStr.match(/(\d{1,2}):\d{2}/);
      if (match) {
        const hour = parseInt(match[1]);
        if (hour >= 0 && hour < 24) hourly[hour]++;
      }
    });

    // 媒體排行
    const mediaCount = {};
    filtered.forEach(r => {
      const m = r[3];
      if (m && m !== '（未填寫）') mediaCount[m] = (mediaCount[m] || 0) + 1;
    });
    const topMedia = Object.entries(mediaCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return res.status(200).json({
      total: filtered.length,
      by_event: byEventArr,
      top_keywords: topKeywords,
      top_media: topMedia,
      hourly_distribution: hourly,
      recent: filtered.slice(-30).reverse().map(r => ({
        time: r[0], event_id: r[1], event: r[2], media: r[3], question: r[4]
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
