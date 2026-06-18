// 媒體訓練 API
// mode: 'reporter' — AI 扮犀利記者出題
// mode: 'evaluate' — AI 評估主管的回答並出下一題

import { readRange } from './lib/sheets.js';

const eventCache = new Map();

async function getEventConfig(eventId) {
  const cached = eventCache.get(eventId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const rows = await readRange('events!A2:F');
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;

  const data = { id: row[0], name: row[1], knowledge_base: row[3] || '' };
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

  const { messages, event_id, mode = 'reporter' } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '請求格式錯誤' });

  try {
    const event = event_id ? await getEventConfig(event_id) : null;
    const eventName = event?.name || '工研院活動';
    const knowledgeBase = event?.knowledge_base || '（活動資料未設定）';

    let systemPrompt;

    if (mode === 'evaluate') {
      // AI 評分 + 出下一題
      systemPrompt = `你是一位資深媒體訓練師，正在幫「${eventName}」的發言人進行媒體訓練。

你剛才以記者身份問了一個問題，對方（發言人）已回答。請評估這個回答。

【評估標準】
1. 訊息清晰度 — 重點是否清楚
2. 媒體友善度 — 是否適合直接引用
3. 危機應對 — 是否妥善處理敏感或陷阱問題
4. 整體表現

【活動背景資料】
${knowledgeBase}

【回覆格式（請嚴格遵守）】
---評分---
整體分數：X / 10

優點：
• （2條）

改進建議：
• （1-2條）

建議更好的答法：
（簡短示範）

---下一題---
（繼續扮演記者，提出下一個更尖銳的問題，不加任何前綴說明）`;

    } else {
      // AI 扮犀利記者
      systemPrompt = `你是一位來自台灣知名財經媒體的資深記者，正在對「${eventName}」的發言人進行專訪。

你的風格：
- 問題犀利、有深度，不接受官腔回答
- 追問具體數字、成效、與競爭者的差異
- 對技術宣稱保持懷疑，要求佐證
- 適時提出反例或市場現實來挑戰說法
- 一次只問一個問題，問完就等對方回答

【你已做好的功課（活動背景資料）】
${knowledgeBase}

開場：先自我介紹（虛構媒體名稱與你的名字），說明今天想深入了解的角度，然後提出第一個問題。
整個訓練共進行 5 題左右。`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API 錯誤' });

    return res.status(200).json({ reply: data.content?.[0]?.text || '無法取得回應。' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
}
