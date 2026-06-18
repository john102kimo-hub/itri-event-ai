// 問答分析 API
// GET  ?password=xxx             → 全部活動統計（含 row_num 供刪除）
// GET  ?password=xxx&event_id=xx → 單一活動統計
// POST {action:'delete', row_num, password} → 標記刪除單筆 Q&A

import { readRange, updateRange } from './lib/sheets.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminPassword = process.env.ADMIN_PASSWORD;

  // ── POST：刪除單筆 ────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, password, row_num } = req.body || {};
    if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
    if (action === 'delete' && row_num) {
      // 將該列 event_id 欄（B）標記為 [deleted]，analytics GET 會過濾掉
      await updateRange(`qa_log!B${row_num}:B${row_num}`, [['[deleted]']]);
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: '不支援的操作' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET：統計 ────────────────────────────────────────────
  const { password, event_id } = req.query;
  if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });

  try {
    const rawRows = await readRange('qa_log!A2:F');
    // 保留原始 row_num（sheet 第幾列，row 2 = index 0）
    const rowsWithNum = rawRows.map((r, i) => ({ r, rowNum: i + 2 }));

    // 過濾已刪除
    const valid = rowsWithNum.filter(({ r }) => r[1] && r[1] !== '[deleted]');
    const filtered = event_id
      ? valid.filter(({ r }) => r[1] === event_id)
      : valid;

    // 按活動分組
    const byEvent = {};
    filtered.forEach(({ r }) => {
      const eid = r[1] || 'unknown';
      if (!byEvent[eid]) {
        byEvent[eid] = { event_id: eid, event_name: r[2] || eid, count: 0, media_list: new Set(), questions: [] };
      }
      byEvent[eid].count++;
      if (r[3] && r[3] !== '（未填寫）') byEvent[eid].media_list.add(r[3]);
      byEvent[eid].questions.push({ time: r[0], media: r[3], question: r[4], answer: r[5] });
    });

    const byEventArr = Object.values(byEvent).map(e => ({
      ...e,
      media_list: [...e.media_list],
      media_count: e.media_list.size
    }));

    // 關鍵字統計
    const stopWords = new Set([
      '的', '了', '是', '在', '有', '和', '與', '這', '那', '什麼', '請問',
      '可以', '嗎', '呢', '嗎？', '?', '？', '一', '會', '不', '也', '都',
      '我', '你', '他', '她', '我們', '他們', '您', '這個', '那個', '如何',
      '為什麼', '是否', '能否', '目前', '已經', '未來', '關於'
    ]);
    const keywords = {};
    filtered.forEach(({ r }) => {
      const q = r[4] || '';
      const matches = q.match(/[一-龥]{2,8}|[a-zA-Z]{3,}/g) || [];
      matches.forEach(word => {
        if (!stopWords.has(word)) keywords[word] = (keywords[word] || 0) + 1;
      });
    });
    const topKeywords = Object.entries(keywords)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // 每小時分佈
    const hourly = Array(24).fill(0);
    filtered.forEach(({ r }) => {
      const match = (r[0] || '').match(/(\d{1,2}):\d{2}/);
      if (match) { const h = parseInt(match[1]); if (h >= 0 && h < 24) hourly[h]++; }
    });

    // 媒體排行
    const mediaCount = {};
    filtered.forEach(({ r }) => {
      const m = r[3];
      if (m && m !== '（未填寫）') mediaCount[m] = (mediaCount[m] || 0) + 1;
    });
    const topMedia = Object.entries(mediaCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return res.status(200).json({
      total: filtered.length,
      by_event: byEventArr,
      top_keywords: topKeywords,
      top_media: topMedia,
      hourly_distribution: hourly,
      recent: filtered.slice(-50).reverse().map(({ r, rowNum }) => ({
        time: r[0], event_id: r[1], event: r[2], media: r[3], question: r[4], row_num: rowNum
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
