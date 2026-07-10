// 記者問答 API — 動態讀取活動知識庫，並將問答寫入 Google Sheets

import { readRange, appendRows } from './lib/sheets.js';

// 活動設定快取（5 分鐘）
const eventCache = new Map();

async function getEventConfig(eventId) {
    const cached = eventCache.get(eventId);
    if (cached && Date.now() < cached.expiry) return cached.data;

  const rows = await readRange('events!A2:J');
    const row = rows.find(r => r[0] === eventId);
    if (!row) return null;

  const data = {
        id: row[0], name: row[1], color: row[2] || '#0F9E7A',
        knowledge_base: row[3] || '', status: row[4] || 'active', organizer: row[9] || '工研院'
  };
    eventCache.set(eventId, { data, expiry: Date.now() + 5 * 60 * 1000 });
    return data;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 未設定' });

  const { messages, event_id, media_name } = req.body || {};
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '請求格式錯誤' });

  try {
        let systemPrompt;
        let eventName = '工研院活動';

      if (event_id) {
              const event = await getEventConfig(event_id);
              if (event && event.status !== 'archived') {
                        eventName = event.name;
                        const organizer = event.organizer || '工研院';
                        systemPrompt = `你是「${event.name}」的 AI 新聞助理，專門服務前來採訪的媒體記者。本記者會主辦單位為「${organizer}」。

                        你的任務：
                        - 只回答與本次記者會相關的問題；若問題超出本次範圍，請禮貌婉拒並引導回相關主題
                        - 提供新聞稿內容、技術介紹、發表內容說明、合作廠商資訊、受訪者／貴賓、活動議程等
                        - 態度專業、友善、回答精確，適合媒體直接引用

                        【本次活動背景資料】
                        ${event.knowledge_base}

                        回答規則：
                        - 一般問題請簡潔有力地回答，適合記者直接引用；但若記者要求完整新聞稿、全文、逐字稿或完整內容，請直接提供背景資料中的完整文字，不要摘要、不要省略、不要自行縮短。
                        - 每則回答的最後，務必另起一行加註警語：「內容僅供參考，以${organizer}官網新聞稿或發言為準。」`;
              }
      }

      if (!systemPrompt) {
              systemPrompt = '你是工研院活動的 AI 新聞助理，請根據活動資料專業地回答記者問題。';
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 8192,
                        system: systemPrompt,
                        messages
              })
      });

      const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API 錯誤' });

      const reply = data.content?.[0]?.text || '抱歉，無法取得回應。';

      // 非同步寫入 Google Sheets（不影響回應速度）
      if (event_id && process.env.GOOGLE_SPREADSHEET_ID) {
              const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
              if (lastUserMsg) {
                        const question = typeof lastUserMsg.content === 'string'
                          ? lastUserMsg.content
                                    : (lastUserMsg.content?.[0]?.text || '');
                        const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

                appendRows('qa_log!A:F', [[
                            timestamp, event_id, eventName,
                            media_name || '（未填寫）', question, reply
                          ]]).catch(e => console.error('Sheets 寫入失敗:', e.message));
              }
      }

      return res.status(200).json({ reply });
  } catch (err) {
        console.error(err);
        return res.status(500).json({ error: '伺服器錯誤，請稍後再試。' });
  }
}
