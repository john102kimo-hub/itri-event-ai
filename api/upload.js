// 圖片上傳 API — 供「圖片資源」欄位用，檔案直接從瀏覽器傳到 Vercel Blob，
// 這支只負責核發上傳權杖（token），實際檔案位元組不經過這支 function，
// 拿回的直連網址貼進 events 表的 images 欄位即可，跟原本手貼 URL 的用法完全相容。
//
// 授權方式跟本平台其他同仁功能一致：同仁用該場的 edit_code，管理員用 ADMIN_PASSWORD。

import { handleUpload } from '@vercel/blob/client';
import { readEventRows } from '../lib/events-table.js';
import { adminAttempt, codeMatches, authFailed } from '../lib/auth.js';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayloadStr) => {
        let payload = {};
        try { payload = JSON.parse(clientPayloadStr || '{}'); } catch { /* 格式錯誤當空物件處理 */ }
        const { event_id, code, password } = payload;

        // 批次 110：沒設 ADMIN_PASSWORD 一律不是管理員；固定時間比對；猜編輯碼的來源有失敗限流（lib/auth.js）
        // 批次 116：密碼帶錯也要記失敗、被擋下的來源連密碼都不比——以前這裡猜密碼不受任何限流
        const who = adminAttempt(req, password);
        if (who === 'blocked') throw new Error('嘗試的次數太多了，請 10 分鐘後再試');

        if (who !== 'admin') {
          if (!event_id || !code) throw new Error('缺少授權資訊');
          const rows = await readEventRows(); // 批次 109：共用快取，亂填 event_id 不多打 Sheets
          const row = rows.find(r => r[0] === event_id);
          if (!row) { authFailed(req); throw new Error('活動不存在'); }
          if (row[4] === 'archived') throw new Error('活動已封存，無法上傳');
          if (!codeMatches(code, row[10])) { authFailed(req); throw new Error('編輯碼錯誤'); }
        }

        return {
          allowedContentTypes: ALLOWED_TYPES,
          maximumSizeInBytes: MAX_SIZE,
          addRandomSuffix: true,
        };
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    return res.status(400).json({ error: err.message || '上傳失敗' });
  }
}
