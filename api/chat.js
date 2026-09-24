// 記者問答 API — 動態讀取活動知識庫，並將問答寫入 Google Sheets
//
// 回應分兩種模式：
//   1. 前端帶 stream: true → SSE 逐字串流（現行前台走這條）
//   2. 沒帶 → 維持原本一次回傳 { reply } 的 JSON（舊前端／外部呼叫者不會被打斷）

import { readRange, appendRows, warmAuth } from '../lib/sheets.js';
import { buildSystemPrompt, resolveEventContent, formatEventBasics } from '../lib/prompt.js';
import { toTraditionalTW, createTraditionalStream, ZH_TW_RULE } from '../lib/zh-tw.js';
import { reportAiFailure } from '../lib/ai-alert.js';

// 這支是記者看得到的出口，跟 api/line.js 一樣要過繁體轉換（CLAUDE.md 第 1、2 條）。
// 批次 82 之前這裡完全沒有接：LINE 在批次 45 補了兩層防線，網頁版一層都沒有——
// 截圖裡那句「内容仅供参考，以工研院官网新闻稿或发言为准。」網頁版照樣會原樣出現，
// 而且網頁版用的是 Haiku，比 LINE 那邊的模型更容易寫出簡體。

// 模型那端出狀況時，記者看到的是一句中文，不是「Overloaded」這種 API 原文。
// 原文照樣寫進 log（console.error），除錯用的資訊不會少。
function friendlyApiError(status) {
  if (status === 429 || status === 529 || status === 503) return '目前詢問的人比較多，請稍候幾秒再問一次。';
  return '暫時無法取得回應，請稍後再試，或洽現場新聞聯絡人。';
}
const STREAM_BROKEN_MSG = '（連線中斷，這一題沒有答完，請再問一次。）';

// 整次請求的時間上限。vercel.json 給這支 60 秒，時間到 function 會被直接砍掉，
// 記者只會看到三個點一直跳、最後變成「連線錯誤」。55 秒先自己停下來，還來得及
// 送出一句說明、把已經答出來的部分寫進 qa_log（跟 api/line.js REQUEST_BUDGET_MS 同一個道理）。
const REQUEST_BUDGET_MS = 55_000;

// 活動設定快取（60 秒；記者會現場臨時改稿也能很快生效）
const eventCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

// 讀到 Q 欄（invite_letter，媒體邀請函）——原本只讀到 J 就夠，批次 9.1 加了「活動前
// 只給邀請函」（見 lib/prompt.js resolveEventContent()），這裡也要跟著讀，不然網頁版
// 問答永遠拿不到邀請函內容，活動前一樣把還沒定案的新聞稿端出去，等於 LINE 端擋了、
// 網頁端沒擋。
async function fetchEventConfig(eventId) {
  const rows = await readRange('events!A2:Q');
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active', event_date: row[5] || '',
    organizer: row[9] || '工研院', images: row[7] || '', invite_letter: row[16] || '',
    // 時間、地點、新聞聯絡人（批次 72）：記者問「幾點開始／在哪裡」時答得出來，見 formatEventBasics()
    event_time: row[11] || '', venue: row[12] || '', press_contact: row[14] || ''
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

// 陽春限流。擋不住分散式濫用，但擋得住單來源無腦迴圈。
//
// ⚠️ 為什麼不能只用 IP 當 key：記者會現場所有記者都掛在同一組會場 Wi-Fi 上，對外
// 是同一個 IP。開場後十分鐘正是大家同時發問的時候，「每 IP 每分鐘 15 題」等於全場
// 記者共用 15 題的額度，第 16 位就會收到「提問太頻繁」——而且偏偏發生在這個平台
// 最需要表現的那十分鐘。api/line.js 早就避開了這個坑（改用 line_user_id 當 key），
// 網頁端一直沒有。
//
// 改成兩層：
//   - 每位記者（瀏覽器自己產生、存在 localStorage 的 client_id）每分鐘 15 題
//     ——這才是原本想限制的「一個人不要無腦連打」
//   - 每個 IP 每分鐘 120 題當防線 —— client_id 是前端送來的、可以偽造，所以 IP 這層
//     一定要留著；額度放到單場記者會不可能踩到、但無腦迴圈跑不了幾秒就會撞上
const hitLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PER_CLIENT_MAX = 15;
const PER_IP_MAX = 120;

function bump(key, max) {
  const now = Date.now();
  const hits = (hitLog.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  hitLog.set(key, hits);
  if (hitLog.size > 4000) {
    for (const [k, v] of hitLog) {
      if (!v.length || now - v[v.length - 1] > RATE_LIMIT_WINDOW_MS) hitLog.delete(k);
    }
  }
  return hits.length > max;
}

// clientId 沒帶（舊前端、或外部呼叫者）就退回只看 IP，行為不會比以前更寬鬆。
function rateLimited(ip, clientId) {
  const overIp = bump('ip:' + ip, PER_IP_MAX);
  const overClient = clientId ? bump('c:' + clientId, PER_CLIENT_MAX) : false;
  return overIp || overClient;
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
  const startedAt = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 未設定' });

  const { messages, event_id, media_name, stream, client_id } = req.body || {};

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  // client_id 只拿來當限流的 key，不寫進任何資料表、也不跟媒體名稱綁在一起
  if (rateLimited(ip, String(client_id || '').slice(0, 64))) {
    return res.status(429).json({ error: '提問太頻繁，請稍候片刻再試。' });
  }

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

  // 串流途中出錯時，catch 要拿得到「已經送出去的那一段」與活動資訊來寫 qa_log
  let reply = '';
  let logCtx = null;
  let zh = null;
  try {
    // 先把 Google 的 access token 熱起來（不 await），讓它跟模型生成平行跑；
    // 等到最後要寫 qa_log 時 token 通常已經備妥，省下一趟 OAuth 往返。
    warmAuth();

    const rawEvent = await getEventConfig(event_id);
    // draft 是「後台先開好框架、內容還在填」的未發布狀態，跟 archived 一樣不讓記者問到——
    // 差別只在 archived 是「問過了、現在下架」，draft 是「根本還沒對外」。
    if (!rawEvent || rawEvent.status === 'archived' || rawEvent.status === 'draft') {
      return res.status(404).json({ error: '活動不存在或已結束' });
    }
    // 活動前只給媒體邀請函，不給正式新聞稿與照片（見 lib/prompt.js 的說明）。
    const event = resolveEventContent(rawEvent);

    const eventName = event.name;
    const systemPrompt = buildSystemPrompt(event);
    const basicsBlock = formatEventBasics(event);
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === 'user');
    const question = !lastUserMsg
      ? ''
      : (typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : (lastUserMsg.content?.[0]?.text || ''));

    logCtx = { event_id, eventName, media_name, question };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      // 涵蓋「等回應」與「讀串流」兩段：時間到，下面的 reader.read() 一樣會丟例外，
      // 走進 catch 送出說明，不會等到被 Vercel 砍掉。從請求一進來就起算——前面讀
      // Sheets 若卡在配額重試，花掉的時間也要扣掉（最少留 5 秒給模型）。
      signal: AbortSignal.timeout(Math.max(5_000, REQUEST_BUDGET_MS - (Date.now() - startedAt))),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        stream: !!stream,
        // 知識庫在 60 秒快取視窗內逐 byte 穩定，加 ephemeral cache 讓同場記者連續發問時
        // 讀取只收 0.1 倍價（記者會現場正是這種「同一份知識庫、多人連續提問」的場景）。
        // ZH_TW_RULE 是固定字串，放進這塊不影響快取。
        system: [
          { type: 'text', text: systemPrompt + '\n' + ZH_TW_RULE, cache_control: { type: 'ephemeral' } },
          // 活動基本資料＋現在時間：每分鐘在變，放在快取區塊之後，不打散上面那塊的快取
          ...(basicsBlock ? [{ type: 'text', text: basicsBlock }] : [])
        ],
        messages: trimmed
      })
    });

    // 錯誤一律在切換成 SSE 之前處理掉，這樣還能回乾淨的 JSON 錯誤碼給前端
    if (!response.ok) {
      let detail = '';
      try {
        const j = await response.json();
        detail = j.error?.message || '';
      } catch (e) { /* 回應不是 JSON 就沒有細節可記 */ }
      console.error('Anthropic API 錯誤:', response.status, detail);
      await reportAiFailure({ status: response.status, message: detail, where: '網頁版記者問答' }); // 批次 85
      return res.status(response.status).json({ error: friendlyApiError(response.status) });
    }

    if (!stream) {
      const data = await response.json();
      // 不能寫死 content[0]：第一塊不保證是文字（見 api/line.js askAnthropic() 的說明）
      const text = (data.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
      reply = toTraditionalTW(text) || '抱歉，無法取得回應。';
      await logQA({ ...logCtx, reply });
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
    // 繁體出口的串流版：模型的每一小段先進這裡，湊到標點才轉換、才送出（見 lib/zh-tw.js）
    zh = createTraditionalStream();
    const send = (t) => {
      if (!t) return;
      reply += t;
      res.write(`data: ${JSON.stringify({ t })}\n\n`);
      res.flush?.();
    };
    let buf = '';
    let brokenMidway = false;

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
          send(zh.push(evt.delta.text));
        } else if (evt.type === 'error') {
          // 串流途中模型那端出錯（例如 overloaded）：原文記 log，記者看中文
          console.error('Anthropic 串流錯誤:', evt.error?.type, evt.error?.message);
          brokenMidway = true;
        }
      }
    }
    send(zh.flush());

    if (brokenMidway) {
      res.write(`data: ${JSON.stringify({ error: reply ? STREAM_BROKEN_MSG : friendlyApiError(529) })}\n\n`);
    }
    if (!reply) reply = '抱歉，無法取得回應。';
    // 先告訴前端「講完了」，輸入框立刻解鎖；寫 Sheets 排在這之後，記者不必等它。
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.flush?.();

    await logQA({ ...logCtx, reply: brokenMidway ? reply + '\n' + STREAM_BROKEN_MSG : reply });
    return res.end();
  } catch (err) {
    console.error('chat 失敗:', err?.name, err?.message);
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    // 已經切成 SSE 就不能再改 status code，只能用事件把錯誤帶回去
    if (res.headersSent) {
      try {
        // 還囤在繁體轉換器裡、沒來得及送出的那幾個字，先送完再說明中斷
        const tail = zh ? zh.flush() : '';
        if (tail) { reply += tail; res.write(`data: ${JSON.stringify({ t: tail })}\n\n`); }
        res.write(`data: ${JSON.stringify({ error: reply ? STREAM_BROKEN_MSG : '伺服器錯誤，請稍後再試。' })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      } catch (e) {}
      // 已經答出來的那一段記者看得到，後台也要看得到（記者可能已經拿去引用了）
      if (logCtx && reply) await logQA({ ...logCtx, reply: reply + '\n' + STREAM_BROKEN_MSG });
      return res.end();
    }
    if (timedOut) return res.status(504).json({ error: '這一題想得比較久，還沒回來。請再問一次，或把問題問得更具體一點。' });
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試。' });
  }
}
