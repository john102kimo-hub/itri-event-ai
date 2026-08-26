// LINE 官方帳號 webhook — 單場記者會問答（批次 2，LINE-PLAN.md 有完整規格）
//
// 記者掃該場 QR（連結已預帶 #活動代碼，見 LINE-PLAN.md 第 7 節）→ 這裡收到文字訊息開頭是
// #／＃ → 綁定 line_users → 之後直接發問，AI 依「跟網頁版同一份」knowledge_base 回答，
// 寫回 qa_log（source=line）。
//
// 批次 2 刻意不做的事（batch 3/4 才做，見 LINE-PLAN.md）：
//   - 沒有綁定就用自然語言問「這個月有哪些活動」之類的跨場次意圖路由
//   - 群組模式、真人接手轉接標記
//
// 安全與坑，詳見 LINE-PLAN.md 第 3 節：
//   - 簽章驗證必須用原始 bytes，不能碰 req.body（見 lib/line.js 開頭註解）
//   - reply token 60 秒只能用一次，reply 失敗一律 fallback push（見 lib/line.js）
//   - 限流用 line_user_id 當 key，不能用 IP——webhook 全部來自 LINE 自己的伺服器，
//     用 IP 當 key 等於全部記者共用同一個額度，會互相誤殺
//   - 沒有有效綁定就不能呼叫 Anthropic，跟 api/chat.js「無 event_id 不碰 Anthropic」同一條原則

import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';
import { buildSystemPrompt } from '../lib/prompt.js';
import { readRawBody, verifySignature, replyOrPush, startLoading } from '../lib/line.js';

const EVENTS_RANGE = 'events!A2:O';
const LINE_USERS_RANGE = 'line_users!A2:F';
const BIND_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時；沒有這個 TTL，記者三個月後問別場會被鎖在當初掃的那一場
const CACHE_TTL_MS = 60 * 1000; // 跟 api/chat.js 的 eventCache 同一套邏輯

// ── events 表快取：整張表一次讀進記憶體，60 秒 TTL ──────────────────────
let eventsCache = { rows: null, expiry: 0 };
async function getAllEventRows() {
  if (eventsCache.rows && Date.now() < eventsCache.expiry) return eventsCache.rows;
  const rows = await readRange(EVENTS_RANGE);
  eventsCache = { rows, expiry: Date.now() + CACHE_TTL_MS };
  return rows;
}
function rowToEvent(row) {
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active',
    images: row[7] || '', organizer: row[9] || '工研院',
    press_contact: row[14] || ''
  };
}
async function findEventByCode(code) {
  const norm = String(code || '').trim().toLowerCase();
  if (!norm) return null;
  const rows = await getAllEventRows();
  const row = rows.find(r => String(r[0] || '').trim().toLowerCase() === norm);
  return row ? rowToEvent(row) : null;
}
async function getEventById(id) {
  if (!id) return null;
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === id);
  return row ? rowToEvent(row) : null;
}
// draft／archived 一律當不存在，跟 api/chat.js、api/event-page.js 同一條規則
function isUsable(event) {
  return !!event && event.status !== 'archived' && event.status !== 'draft';
}

// ── line_users 表：讀取整表快取 60 秒；寫入（綁定）一律讀最新、不吃快取 ──────
let lineUsersCache = { rows: null, expiry: 0 };
async function getAllLineUserRows() {
  if (lineUsersCache.rows && Date.now() < lineUsersCache.expiry) return lineUsersCache.rows;
  let rows = [];
  try { rows = await readRange(LINE_USERS_RANGE); } catch { rows = []; } // 分頁還沒建立時不要整支掛掉
  lineUsersCache = { rows, expiry: Date.now() + CACHE_TTL_MS };
  return rows;
}
function invalidateLineUsersCache() { lineUsersCache = { rows: null, expiry: 0 }; }

// 綁定物件：{event_id, media_name} 或 null（沒綁定／已過期）。
// bound_at／last_active 存的是 epoch 毫秒字串，不是人看的日期字串——這欄要拿來做 TTL
// 數學比較，用「2026/8/20 下午2:30」這種在地化字串存，Node 的 Date 解析器不保證讀得回來，
// 6 小時的判斷就會整個失準。要看人看得懂的時間，qa_log 的 timestamp 欄本來就有。
async function getBinding(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  if (!row) return null;
  const boundAt = Number(row[3]) || 0;
  if (!boundAt || Date.now() - boundAt > BIND_TTL_MS) return null;
  return { event_id: row[1] || '', media_name: row[2] || '' };
}

let sheetsEnsured = false;
async function ensureLineUsersSheet() {
  if (sheetsEnsured) return;
  try {
    await ensureSheets({ line_users: ['line_user_id', 'event_id', 'media_name', 'bound_at', 'last_active', 'note'] });
  } catch (e) {
    console.error('ensureSheets(line_users) 失敗:', e.message);
  }
  sheetsEnsured = true; // 失敗也不重試，避免每個請求都多打一次 API；分頁真的沒建成的話，
                        // 後續讀寫會自然拿到空陣列或被 catch，不會讓整支掛掉
}

async function upsertBinding(userId, eventId) {
  await ensureLineUsersSheet();
  const now = String(Date.now());
  const rows = await readRange(LINE_USERS_RANGE); // 寫入路徑要讀最新，不吃快取，正確性優先
  const idx = rows.findIndex(r => r[0] === userId);
  try {
    if (idx === -1) {
      await appendRows('line_users!A:F', [[userId, eventId, '', now, now, '']]);
    } else {
      const existing = rows[idx];
      await updateRange(`line_users!A${idx + 2}:F${idx + 2}`, [[
        userId, eventId, existing[2] || '', now, now, existing[5] || ''
      ]]);
    }
  } finally {
    invalidateLineUsersCache();
  }
}

async function setMediaName(userId, name) {
  try {
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === userId);
    if (idx === -1) return;
    await updateRange(`line_users!C${idx + 2}`, [[name]]);
  } catch (e) {
    console.error('setMediaName 失敗:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// ── 陽春限流：同一 line_user_id 60 秒內最多 15 次問答 ───────────────────
// 跟 api/chat.js 的 ipHits 同一套邏輯，只是 key 換成 line_user_id——LINE 的 webhook
// 全部來自 LINE 自己的伺服器 IP，用 IP 當 key 會讓全部記者共用同一個額度、互相誤殺。
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 60 * 1000);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 2000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > 60 * 1000) hits.delete(k);
    }
  }
  return arr.length > 15;
}

const sanitize = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// 判斷一則短訊息「看起來像媒體名稱／略過」而不是提問——只在記者剛綁定、media_name
// 還沒填過時才會用到這個判斷。誤判也不會損毀資料，最多就是這句沒被當成問題回答，
// 記者再問一次就好，所以用簡單的啟發式即可，不需要另外呼叫 AI 判斷意圖。
function looksLikeNameOrSkip(text) {
  if (/^(略過|skip|跳過)$/i.test(text)) return true;
  if (text.length > 20) return false;
  if (/[?？]/.test(text)) return false;
  if (/^(請問|為什麼|什麼|怎麼|哪裡|哪一|何時|多少|是否|能不能|可以|會不會|有沒有)/.test(text)) return false;
  return true;
}

function lineExtraRules(event) {
  const contactHint = event.press_contact
    ? `寧可說「這部分我沒有資料，建議洽新聞聯絡人 ${event.press_contact}」`
    : '寧可說「這部分我沒有資料，建議洽現場新聞聯絡人」';
  return [
    '這是 LINE 對話，請控制在 5 行以內；記者要求完整新聞稿時才給全文，並提醒可到活動網頁下載。',
    '需要附連結時直接給網址純文字，不要用 Markdown 語法（LINE 不會渲染，記者會看到一堆星號與方括號）。',
    `你的回覆會出現在掛著主辦單位名義的官方帳號裡，記者可能直接截圖引用。任何不確定的內容，${contactHint}。`
  ];
}

async function askAnthropic(systemPrompt, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '系統目前無法回答，請稍後再試或洽現場工作人員。';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: String(userText).slice(0, 8000) }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API 錯誤:', data.error?.message);
      return '抱歉，目前無法取得回應，請稍後再試或洽現場工作人員。';
    }
    return data.content?.[0]?.text || '抱歉，無法取得回應。';
  } catch (e) {
    console.error('Anthropic 呼叫失敗:', e.message);
    return '抱歉，目前無法取得回應，請稍後再試。';
  }
}

async function logQa(event, mediaName, question, reply) {
  if (!process.env.GOOGLE_SPREADSHEET_ID) return;
  try {
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    // H 欄 source=line，G 欄（刪除旗標）補空字串佔位——跟 api/chat.js 用同一張表、
    // 同一個欄位順序，兩邊沒對齊的話後台會把資料判成已刪除。
    await appendRows('qa_log!A:H', [[
      timestamp, event.id, event.name, mediaName || '（未填寫）',
      sanitize(question, 2000), reply, '', 'line'
    ]]);
  } catch (e) {
    console.error('LINE qa_log 寫入失敗:', e.message);
  }
}

// ── 逐一事件處理 ─────────────────────────────────────────────────────
async function handleEvent(ev) {
  if (ev.type === 'follow') {
    const userId = ev.source?.userId;
    if (!userId || !ev.replyToken) return;
    await replyOrPush(ev.replyToken, userId,
      '感謝加入好友！\n\n請掃描活動現場的 QR code，或直接輸入「#活動代碼」開始問答。\n\n本帳號會記錄您的提問內容以改善新聞服務，不會蒐集您的個人資料。');
    return;
  }

  if (ev.type !== 'message') return; // unfollow／join／postback 等批次 2 不處理，也沒有可用的 replyToken

  const userId = ev.source?.userId;
  const replyToken = ev.replyToken;
  if (!userId || !replyToken) return;

  if (ev.source?.type !== 'user') {
    await replyOrPush(replyToken, userId, '目前僅支援一對一聊天使用，請直接加官方帳號好友後私訊提問。');
    return;
  }

  if (ev.message?.type !== 'text') {
    await replyOrPush(replyToken, userId, '目前僅支援文字訊息提問，請直接輸入您的問題。');
    return;
  }

  const text = String(ev.message.text || '').trim();
  if (!text) return;

  if (rateLimited(userId)) {
    await replyOrPush(replyToken, userId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // #代碼 綁定（半形／全形井號都收，同仁貼連結時中文輸入法常會打成全形）
  if (text.startsWith('#') || text.startsWith('＃')) {
    const code = text.slice(1).trim();
    const event = await findEventByCode(code);
    if (!isUsable(event)) {
      await replyOrPush(replyToken, userId, '找不到這個活動代碼，請確認代碼是否正確，或洽現場工作人員。');
      return;
    }
    await upsertBinding(userId, event.id);
    await replyOrPush(replyToken, userId,
      `已為您接上《${event.name}》✅\n\n請問您是哪家媒體？（方便新聞聯絡人後續服務，打媒體名稱即可，或回「略過」）\n\n之後就可以直接問問題了。`);
    return;
  }

  const binding = await getBinding(userId);
  if (!binding) {
    await replyOrPush(replyToken, userId, '請先掃描活動現場的 QR code，或輸入「#活動代碼」綁定場次後再提問。');
    return;
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    await replyOrPush(replyToken, userId, '這場活動目前無法問答，請洽現場工作人員。');
    return;
  }

  // 媒體名稱擷取：只在還沒填過、且這則訊息「看起來像名稱／略過」時才擷取，
  // 誤判也不會損毀資料，記者正常提問一樣會被正確送進問答流程。
  if (!binding.media_name && looksLikeNameOrSkip(text)) {
    const isSkip = /^(略過|skip|跳過)$/i.test(text);
    await setMediaName(userId, isSkip ? '（未提供）' : sanitize(text, 40));
    await replyOrPush(replyToken, userId, '已記錄，謝謝！請直接輸入您的問題即可。');
    return;
  }

  // 正式問答：先開輸入中動畫，再呼叫 Anthropic
  await startLoading(userId, 55);
  const systemPrompt = buildSystemPrompt(event, lineExtraRules(event));
  const reply = await askAnthropic(systemPrompt, text);
  await replyOrPush(replyToken, userId, reply);
  await logQa(event, binding.media_name, text, reply);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error('LINE_CHANNEL_SECRET 未設定');
    return res.status(500).end();
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(400).end();
  }

  // 簽章沒過一律 401 並直接結束，不做記 log 之外的任何動作——這支是全公開端點，
  // 沒有這道就是開放的 LLM 代理。
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(raw, signature, channelSecret)) {
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).end();
  }

  const events = Array.isArray(payload.events) ? payload.events : [];

  // 依序處理、不平行——記者會現場的量級不需要平行處理，依序執行也不會讓同一批
  // webhook 裡的多個事件互搶 Anthropic／Sheets 配額。
  for (const ev of events) {
    try {
      await handleEvent(ev);
    } catch (e) {
      // 單一事件出錯不能讓整支回 500——LINE 收到非 2xx 會重送整批 webhook，
      // 容易在配額耗盡或 Anthropic 暫時出狀況時觸發重試風暴、雪上加霜。
      console.error('LINE 事件處理失敗:', e.message, ev?.type);
    }
  }

  return res.status(200).json({ ok: true });
}
