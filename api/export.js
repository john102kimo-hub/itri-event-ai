// 問答紀錄匯出 API — 下載 CSV（Excel 可直接開啟）
// GET ?event_id=xxx
// 管理員密碼走 X-Admin-Password header（也相容舊的 ?password= query，供直接貼網址測試用）

import { readRange } from '../lib/sheets.js';

// CSV 公式注入防護：記者輸入以 =／+／-／@ 開頭的內容，管理員用 Excel 開啟時
// 會被當公式執行；在前面補一個單引號讓 Excel 只當純文字顯示。
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const password = req.headers['x-admin-password'] || req.query.password;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });

  const { event_id } = req.query;

  try {
    const rows = await readRange('qa_log!A2:H');
    // 已刪除的問答（G 欄標記，或舊資料殘留的 B 欄 [deleted]）不該出現在結案報告的匯出檔裡。
    // 同仁在 LINE 職員模式下的試問（H 欄 source=staff）也一樣要濾掉——這份 CSV 是結案
    // 報告的附件，混進自己人的測試等於在正式文件裡灌水。讀到 H 欄就是為了看得到 source。
    const valid = rows.filter(r => r[1] && r[1] !== '[deleted]' && r[6] !== '1' && (r[7] || 'web') !== 'staff');
    const filtered = event_id ? valid.filter(r => r[1] === event_id) : valid;

    const headers = ['時間', '活動ID', '活動名稱', '媒體名稱', '記者問題', 'AI回答'];
    const csvRows = [headers, ...filtered.map(r => [
      r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || ''
    ])];

    const csv = csvRows.map(row => row.map(csvCell).join(',')).join('\r\n');

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
