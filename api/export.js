// 問答紀錄匯出 API — 下載 CSV（Excel 可直接開啟）
// GET ?password=xxx&event_id=xxx

import { readRange } from './lib/sheets.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { password, event_id } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });

  try {
    const rows = await readRange('qa_log!A2:F');
    const filtered = event_id ? rows.filter(r => r[1] === event_id) : rows;

    const headers = ['時間', '活動ID', '活動名稱', '媒體名稱', '記者問題', 'AI回答'];
    const csvRows = [headers, ...filtered.map(r => [
      r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || ''
    ])];

    const csv = csvRows.map(row =>
      row.map(cell => `"${cell.toString().replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const now = new Date().toISOString().slice(0, 10);
    const filename = event_id
      ? `${event_id}-qa-${now}.csv`
      : `all-events-qa-${now}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.write('﻿'); // BOM — 讓 Excel 正確顯示中文
    return res.end(csv);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
