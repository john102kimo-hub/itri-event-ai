// 媒體訓練 API
// mode: 'reporter' — AI 扮犀利記者出題
// mode: 'evaluate' — AI 評估主管的回答並出下一題

import { readRange } from './lib/sheets.js';

const eventCache = new Map();

async function getEventConfig(eventId) {
  // 特殊模式：彙整所有活動
  if (eventId === 'all') {
    const cacheKey = '__all__';
    const cached = eventCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return cached.data;

    const rows = await readRange('events!A2:F');
    const activeRows = rows.filter(r => r[0] && r[4] !== 'archived');
    const combined = activeRows
      .map(r => `【${r[1] || r[0]}】\n${r[3] || ''}`)
      .join('\n\n---\n\n');
    const names = activeRows.map(r => r[1] || r[0]).join('、');
    const data = {
      id: 'all',
      name: `工研院彙整訓練（${names}）`,
      knowledge_base: combined || '（無活動資料）'
    };
    eventCache.set(cacheKey, { data, expiry: Date.now() + 5 * 60 * 1000 });
    return data;
  }

  const cached = eventCache.get(eventId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const rows = await readRange('events!A2:F');
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;

  const data = { id: row[0], name: row[1], knowledge_base: row[3] || '' };
  eventCache.set(eventId, { data, expiry: Date.now() + 5 * 60 * 1000 });
  return data;
}

// 真實提問快取（5 分鐘）
const qaCache = new Map();

/**
 * 從 qa_log 撈記者「真的問過」的問題。
 * 這是這支 API 和純靠知識庫想像題目最大的差別：
 * 本場問過的優先，其餘場次的高頻題當補充，辦愈多場愈準。
 */
async function getRealQuestions(eventId) {
  const key = 'q:' + (eventId || 'all');
  const cached = qaCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.data;

  let rows = [];
  try { rows = await readRange('qa_log!A2:F'); } catch { rows = []; }

  const norm = (q) => String(q || '').replace(/\s+/g, '').replace(/[？?。.，,、！!]/g, '');
  const seen = new Set();
  const take = (list, limit) => {
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      const q = String(list[i][4] || '').trim();
      if (q.length < 5 || q.length > 200) continue;
      const k = norm(q);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ q, media: String(list[i][3] || '').trim() });
    }
    return out;
  };

  const thisEvent = eventId && eventId !== 'all' ? rows.filter((r) => r[1] === eventId) : rows;
  const data = {
    thisEvent: take(thisEvent, 15),
    otherEvents: eventId && eventId !== 'all' ? take(rows.filter((r) => r[1] !== eventId), 12) : [],
    totalLogged: rows.length,
  };
  qaCache.set(key, { data, expiry: Date.now() + 5 * 60 * 1000 });
  return data;
}

function realQuestionBlock(rq) {
  if (!rq || (!rq.thisEvent.length && !rq.otherEvents.length)) return '';
  const fmt = (arr) => arr.map((x) => `- ${x.q}${x.media ? `（${x.media}）` : ''}`).join('\n');
  let s = '\n\n【記者實際問過的問題 —— 這是真實資料，不是推測】\n';
  if (rq.thisEvent.length) s += `\n本場活動記者已經問過：\n${fmt(rq.thisEvent)}\n`;
  if (rq.otherEvents.length) s += `\n工研院其他場次記者常問（可推測本場也會被問到）：\n${fmt(rq.otherEvents)}\n`;
  s += '\n請優先從上面這些「真的被問過」的角度切入與追問，並依此推想同一路線記者接下來會追問什麼。'
     + '這些比你自己想像的問題更有價值，因為它們反映記者真正關心的點。';
  return s;
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
    const [event, realQuestions] = await Promise.all([
      event_id ? getEventConfig(event_id) : null,
      getRealQuestions(event_id),
    ]);
    const eventName = event?.name || '工研院活動';
    const knowledgeBase = event?.knowledge_base || '（活動資料未設定）';
    const realQ = realQuestionBlock(realQuestions);

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
${knowledgeBase}${realQ}

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
${knowledgeBase}${realQ}

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
        // Sonnet 5 預設開啟 adaptive thinking（4.6 預設是關的），
        // 而 max_tokens 是「思考＋回答」的總上限 —— 原本的 1200 會讓評分被截斷。
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: systemPrompt,
        messages: messages.length > 0 ? messages : [{ role: 'user', content: '請開始。' }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API 錯誤' });

    // Adaptive thinking 開啟時 content[0] 常是 thinking block，真正文字要找 type === 'text' 那塊
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    return res.status(200).json({ reply: textBlock?.text || '無法取得回應。' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
}
