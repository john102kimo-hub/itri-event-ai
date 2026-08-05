// 圖片上傳 API — 供「圖片資源」欄位用，檔案直接從瀏覽器傳到 Vercel Blob，
// 這支只負責核發上傳權杖（token），實際檔案位元組不經過這支 function，
// 拿回的直連網址貼進 events 表的 images 欄位即可，跟原本手貼 URL 的用法完全相容。
//
// 授權方式跟本平台其他同仁功能一致：同仁用該場的 edit_code，管理員用 ADMIN_PASSWORD。

import { handleUpload } from '@vercel/blob/client';
import { readRange } from './lib/sheets.js';

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

        const adminPassword = process.env.ADMIN_PASSWORD;
        const isAdmin = adminPassword && password === adminPassword;

        if (!isAdmin) {
          if (!event_id || !code) throw new Error('缺少授權資訊');
          const rows = await readRange('events!A2:K');
          const row = rows.find(r => r[0] === event_id);
          if (!row) throw new Error('活動不存在');
          if (row[4] === 'archived') throw new Error('活動已封存，無法上傳');
          if (!row[10] || String(code) !== String(row[10])) throw new Error('編輯碼錯誤');
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
