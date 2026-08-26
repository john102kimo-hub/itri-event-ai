// 記者問答 API — 動態讀取活動知識庫，並將問答寫入 Google Sheets
//
// 回應分兩種模式：
//   1. 前端帶 stream: true → SSE 逐字串流（現行前台走這條）
//   2. 沒帶 → 維持原本一次回傳 { reply } 的 JSON（舊前端／外部呼叫者不會被打斷）

import { readRange, appendRows, warmAuth } from '../lib/sheets.js';
import { buildSystemPrompt } from '../lib/prompt.js';

// 活動設定快取（60 秒；記者會現場臨時改稿也能很快生效）
const eventCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function fetchEventConfig(eventId) {
  const rows = await readRange('events!A2:J'); // O 欄的新增欄位（時間/地點/類型/聯絡人）這裡用不到，讀到 J 就夠
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active', organizer: row[9] || '工研院',
    images: row[7] || ''
  };
}

// 快取過期時「先回舊的、背景再更新」（stale-while-revalidate）。
// 原本是過期就同步重讀 Sheets，等於每 60 秒就有一位倒楣的記者要多等一趟 Google 往返
// （實測 0.5～0.9 秒）。改成背景更新後，那筆讀取不再卡在記者的等待時間裡，
// 「最多晚 60 秒生效」的行為不變——只是慢的那一位變成不用等。
async function getEventConfig(eventId) {
  const cached = eventCache.get(eventId);
  if (cached) {
    if (Date.now() >= cached.expiry && !cached.refreshing) {
      cached.refreshing = true;
      fetchEventConfig(eventId)
        .then(data => {
          if (data) eventCache.set(eventId, { data, expiry: Date.now() + CACHE_TTL_MS });
        })
        .catch(e => console.error('活動設定背景更新失敗:', e.message))
        .finally(() => { cached.refreshing = false; });
    }
    return cached.data;
  }
  const data = await fetchEventConfig(eventId);
  if (data) eventCache.set(eventId, { data, expiry: Date.now() + CACHE_TTL_MS });
  return data;
}

// 陽春限流：同一 IP 60 秒內最多 15 次提問。擋不住分散式濫用，但擋得住單來源無腦迴圈。
const ipHits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 15;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 2000) {
    for (const [k, v] of ipHits) {
      if (!v.length || now - v[v.length - 1] > RATE_LIMIT_WINDOW_MS) ipHits.delete(k);
    }
  }
  return hits.length > RATE_LIMIT_MAX;
}

// 寫入 qa_log 前淨化：截斷長度、壓平換行，避免污染分析統計與後續媒體訓練 prompt
const sanitize = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// 把這輪問答寫進 qa_log。串流模式下是在「文字已經全部送到瀏覽器之後」才呼叫——
// 記者已經讀得到完整答案，但 Function 還沒 res.end()，所以寫入照樣有完整執行時間，
// 不會重蹈當年 fire-and-forget 被凍結、寫到一半消失的覆轍。
async function logQA({ event_id, eventName, media_name, question, reply }) {
  if (!process.env.GOOGLE_SPREADSHEET_ID || !question) return;
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    // H 欄（source）批次 2 新增，用來分辨這題是網頁問的還是 LINE 問的（見 api/line.js）。
    // G 欄是既有的刪除旗標欄，這裡一定要補空字串佔位，不然 source 會寫錯格、
    // 後台會把這筆資料當成已刪除。
    await appendRows('qa_log!A:H', [[
      timestamp, event_id, eventName,
      sanitize(media_name, 40) || '（未填寫）', sanitize(question, 2000), reply, '', 'web'
    ]]);
  } catch (e) {
    console.error('Sheets 寫入失敗:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 未設定' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: '提問太頻繁，請稍候片刻再試。' });
  }

  const { messages, event_id, media_name, stream } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '請求格式錯誤' });
  if (!event_id) return res.status(400).json({ error: '缺少活動 ID' });

  // 裁切輸入：只留最近 12 則、每則截 8000 字 —— 沒有這道限制，輸入成本完全由呼叫者決定
  const trimmed = messages
    .slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 8000) : m.content
    }));
  if (!trimmed.length) return res.status(400).json({ error: '請求格式錯誤' });

  try {
    // 先把 Google 的 access token 熱起來（不 await），讓它跟模型生成平行跑；
    // 等到最後要寫 qa_log 時 token 通常已經備妥，省下一趟 OAuth 往返。
    warmAuth();

    const event = await getEventConfig(event_id);
    // draft 是「後台先開好框架、內容還在填」的未發布狀態，跟 archived 一樣不讓記者問到——
    // 差別只在 archived 是「問過了、現在下架」，draft 是「根本還沒對外」。
    if (!event || event.status === 'archived' || event.status === 'draft') {
      return res.status(404).json({ error: '活動不存在或已結束' });
    }

    const eventName = event.name;
    const systemPrompt = buildSystemPrompt(event);
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === 'user');
    const question = !lastUserMsg
      ? ''
      : (typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : (lastUserMsg.content?.[0]?.text || ''));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        stream: !!stream,
        // 知識庫在 60 秒快取視窗內逐 byte 穩定，加 ephemeral cache 讓同場記者連續發問時
        // 讀取只收 0.1 倍價（記者會現場正是這種「同一份知識庫、多人連續提問」的場景）
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: trimmed
      })
    });

    // 錯誤一律在切換成 SSE 之前處理掉，這樣還能回乾淨的 JSON 錯誤碼給前端
    if (!response.ok) {
      let msg = 'API 錯誤';
      try {
        const j = await response.json();
        msg = j.error?.message || msg;
      } catch (e) { /* 回應不是 JSON 就沿用預設訊息 */ }
      return res.status(response.status).json({ error: msg });
    }

    if (!stream) {
      const data = await response.json();
      const reply = data.content?.[0]?.text || '抱歉，無法取得回應。';
      await logQA({ event_id, eventName, media_name, question, reply });
      return res.status(200).json({ reply });
    }

    // ---- SSE 串流 ----
    // no-transform 與 X-Accel-Buffering 是必要的：少了它們，中間的代理會把小塊回應
    // 先攢起來再一次吐出，串流就退化回原本那種「等很久、一次全部冒出來」。
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': ok\n\n'); // 先推一個 SSE 註解行，讓瀏覽器立刻確定連線已開

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let reply = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || ''; // 最後一段可能被切在半途，留到下一輪再拼
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          reply += evt.delta.text;
          res.write(`data: ${JSON.stringify({ t: evt.delta.text })}\n\n`);
          res.flush?.();
        } else if (evt.type === 'error') {
          res.write(`data: ${JSON.stringify({ error: evt.error?.message || 'API 錯誤' })}\n\n`);
        }
      }
    }

    if (!reply) reply = '抱歉，無法取得回應。';
    // 先告訴前端「講完了」，輸入框立刻解鎖；寫 Sheets 排在這之後，記者不必等它。
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.flush?.();

    await logQA({ event_id, eventName, media_name, question, reply });
    return res.end();
  } catch (err) {
    console.error(err);
    // 已經切成 SSE 就不能再改 status code，只能用事件把錯誤帶回去
    if (res.headersSent) {
      try { res.write(`data: ${JSON.stringify({ error: '伺服器錯誤，請稍後再試。' })}\n\n`); } catch (e) {}
      return res.end();
    }
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試。' });
  }
}
