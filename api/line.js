// LINE 官方帳號 webhook — 記者問答（批次 2 單場綁定 + 批次 3 自然語言意圖路由）
// + 內部職員模式（批次 4）。LINE-PLAN.md 有完整規格。
//
// 記者端，兩種問法都支援：
//   1. 掃該場 QR（連結已預帶 #活動代碼，見 LINE-PLAN.md 第 7 節）→ 綁定 line_users →
//      之後直接發問。#代碼對不上時，當成一般文字重新路由一次，不會只回「找不到」。
//   2. 沒綁定、直接打活動名稱或問「最近有哪些活動」→ 過 lib/router.js 的意圖路由，
//      判斷是查活動列表、問特定一場（順手軟綁定，下一題不用再打名稱）、還是無關問題。
// 兩條路徑最後都走同一份「跟網頁版同一份」knowledge_base 回答，寫回 qa_log（source=line）。
//
// 職員端（同一個 LINE 帳號、同一支 webhook）：講對 LINE_STAFF_PASSCODE 這組密語，
// 該 userId 永久記為職員（存 line_staff 表，要收回權限就去 Sheet 刪那一列）。之後
// 用自然語言下指令，過 lib/staff.js 的 routeStaffIntent()：查活動列表／問特定活動內容
// （含 draft／archived，reporter 那套 isUsable() 限制不套用）／查某場後台數據／查 GEO
// 狀態／新增活動並直接拿到同仁編輯連結／要某場的媒體訓練連結。安全模型見 lib/staff.js
// 開頭註解。
//
// 批次 2/3/4 刻意不做的事（batch 5 才做，見 LINE-PLAN.md）：
//   - 群組模式、真人接手轉接標記、邀訪收單（記者端的 media_requests）
//
// 安全與坑，詳見 LINE-PLAN.md 第 3 節：
//   - 簽章驗證必須用原始 bytes，不能碰 req.body（見 lib/line.js 開頭註解）
//   - reply token 60 秒只能用一次，reply 失敗一律 fallback push（見 lib/line.js）
//   - 限流用 line_user_id 當 key，不能用 IP——webhook 全部來自 LINE 自己的伺服器，
//     用 IP 當 key 等於全部記者共用同一個額度，會互相誤殺
//   - 沒有有效綁定／路由結果就不能呼叫 Anthropic，跟 api/chat.js「無 event_id 不碰
//     Anthropic」同一條原則；draft／archived 場次一律不進行事曆清單、不會被路由到

import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';
import { buildSystemPrompt } from '../lib/prompt.js';
import { readRawBody, verifySignature, replyOrPush, startLoading } from '../lib/line.js';
import { buildCalendarCards, buildAllCalendarCards, routeIntent, formatCalendarReply } from '../lib/router.js';
import {
  isPasscodeMatch, isStaffAuthenticated, authenticateStaff, routeStaffIntent,
  createDraftEvent, editLink, trainingLink, getEventEditCode, getEventRawById,
  getEventAnalyticsSummary, formatEventAnalyticsReply, getGeoStatusSummary, formatGeoStatusReply
} from '../lib/staff.js';

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

// 正式問答：開輸入中動畫 → 呼叫 Anthropic → reply（失敗 fallback push）→ 寫 qa_log。
// 綁定路徑（#代碼）跟路由命中路徑（自然語言直接命中某一場）最後都走這支，避免兩邊各自
// 維護一份幾乎一樣的邏輯、之後改一邊忘了改另一邊。
async function answerQuestion(replyToken, userId, event, mediaName, text) {
  await startLoading(userId, 55);
  const systemPrompt = buildSystemPrompt(event, lineExtraRules(event));
  const reply = await askAnthropic(systemPrompt, text);
  // 診斷用途，不是必要邏輯：路由判斷得準不準、AI 答得順不順，靠這行在 Vercel Logs
  // 裡直接看得到，不用另外接工具。刻意截斷長度，避免整份新聞稿灌爆單行 log。
  console.log(`[line] answer event=${event.id} status=${event.status} q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, userId, reply);
  await logQa(event, mediaName, text, reply);
}

// 職員模式指令分派（批次 4）。跟 handleUnbound 的差異：
//   - qa 意圖不套用 isUsable()——同仁本來就該問得到 draft／archived 場次的內容
//   - 不做軟綁定：職員一次對話常常在不同活動之間跳來跳去（查完 A 場數據又問 B 場
//     內容），鎖定單一活動反而綁手綁腳
//   - 多了 geo_status／event_analytics／create_event／training_link 四種指令
async function handleStaffMessage(replyToken, userId, text) {
  const rows = await getAllEventRows();
  // 職員要用「全部場次」的候選清單，不能用記者版的 buildCalendarCards()——
  // 那支會濾掉 draft／archived，職員問得到的場次卻不在候選清單裡，路由回傳的
  // event_id 會被 routeStaffIntent() 自己的白名單過濾掉，變成「查得到內容、卻永遠
  // 比對不到活動」。見 lib/router.js 的註解。
  const cards = buildAllCalendarCards(rows);
  const routed = await routeStaffIntent(text, cards);
  console.log(`[line] staff route user=${userId} q="${text.slice(0, 60)}" → ${JSON.stringify(routed)}`);
  const cardName = id => cards.find(c => c.id === id)?.name || id;

  if (routed.intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards));
    return;
  }

  if (routed.intent === 'geo_status') {
    await replyOrPush(replyToken, userId, formatGeoStatusReply(await getGeoStatusSummary()));
    return;
  }

  if (routed.intent === 'create_event') {
    if (!routed.new_event_name) {
      await replyOrPush(replyToken, userId, '請告訴我新活動的名稱，例如：「新增活動 半導體技術發表會」。');
      return;
    }
    const created = await createDraftEvent(routed.new_event_name, routed.new_event_date);
    console.log(`[line] 職員新增活動 id=${created.id} name="${created.name}"`);
    await replyOrPush(replyToken, userId,
      `已建立《${created.name}》（狀態：未發布，僅後台看得到）\n\n同仁編輯連結（給負責的同仁，他不需要後台密碼）：\n${editLink(created.id, created.editCode)}\n\n內容填好、確認沒問題後，要到後台按「發布」才會對記者公開。`);
    return;
  }

  if (routed.intent === 'event_analytics' || routed.intent === 'training_link') {
    if (routed.event_ids.length === 0) {
      await replyOrPush(replyToken, userId, '請問是想查哪一場活動？直接打活動名稱即可。');
      return;
    }
    if (routed.event_ids.length > 1) {
      await replyOrPush(replyToken, userId,
        `是想查這幾場的哪一場？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`);
      return;
    }
    const eventId = routed.event_ids[0];
    if (routed.intent === 'event_analytics') {
      const summary = await getEventAnalyticsSummary(eventId, cardName(eventId));
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary));
    } else {
      const editCode = await getEventEditCode(eventId);
      if (!editCode) {
        await replyOrPush(replyToken, userId, '這場活動還沒有編輯碼，請先到後台開啟一次該活動的編輯連結。');
        return;
      }
      await replyOrPush(replyToken, userId, `《${cardName(eventId)}》媒體訓練連結：\n${trainingLink(eventId, editCode)}`);
    }
    return;
  }

  if (routed.intent === 'qa' && routed.event_ids.length === 1 && routed.confidence === 'high') {
    const event = await getEventRawById(routed.event_ids[0]);
    if (event) {
      // 職員模式刻意不呼叫 isUsable()：draft／archived 場次的內容同仁都問得到
      await answerQuestion(replyToken, userId, event, '（內部職員）', text);
      return;
    }
  }
  if (routed.intent === 'qa' && routed.event_ids.length > 1) {
    await replyOrPush(replyToken, userId,
      `是想問這幾場的哪一場？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`);
    return;
  }

  await replyOrPush(replyToken, userId,
    '職員模式可以問：活動列表／某場活動內容／某場後台數據／GEO 狀態／新增活動（會給編輯連結）／某場媒體訓練連結。直接打活動名稱或說明需求即可。');
}

// 沒有有效綁定時的自然語言處理（批次 3）：讓路由判斷這是查活動列表、問特定一場、
// 還是無關問題。路由失敗或判不出來，一律退回批次 2 原本的引導文案，不會卡住、
// 也不會誤觸問答。
async function handleUnbound(replyToken, userId, text) {
  const rows = await getAllEventRows();
  const cards = buildCalendarCards(rows);
  const { intent, event_ids, confidence } = await routeIntent(text, cards);
  console.log(`[line] reporter route q="${text.slice(0, 60)}" → intent=${intent} event_ids=${JSON.stringify(event_ids)} confidence=${confidence}`);

  if (intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards));
    return;
  }

  if (intent === 'qa' && event_ids.length === 1 && confidence === 'high') {
    const event = await getEventById(event_ids[0]);
    if (isUsable(event)) {
      // 路由命中就順手軟綁定——下一題不用再重打一次活動名稱，也能重複利用
      // 6 小時 TTL 那套過期機制，不用另外維護一套「路由記憶」。
      await upsertBinding(userId, event.id);
      await answerQuestion(replyToken, userId, event, '', text);
      return;
    }
  }

  if (intent === 'qa' && event_ids.length > 0) {
    const names = event_ids.map(id => cards.find(c => c.id === id)?.name).filter(Boolean).slice(0, 3);
    if (names.length) {
      await replyOrPush(replyToken, userId,
        `您是想問這幾場的哪一場呢？\n${names.map(n => '・' + n).join('\n')}\n\n請直接打完整或部分活動名稱。`);
      return;
    }
  }

  // intent === 'other'，或 qa 但完全比對不到、或路由本身失敗 → 統一導引，
  // 跟批次 2 原本沒綁定時的文案一致，只是多給「或直接打活動名稱」這條路。
  await replyOrPush(replyToken, userId,
    '不確定您想問哪一場活動——可以直接輸入活動名稱、或問「最近有哪些活動」查看清單，也可以掃描現場 QR code 綁定。');
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
    console.log(`[line] qa_log 寫入成功 event=${event.id}`);
  } catch (e) {
    console.error('LINE qa_log 寫入失敗:', e.message);
  }
}

// ── 逐一事件處理 ─────────────────────────────────────────────────────
async function handleEvent(ev) {
  console.log(`[line] 收到事件 type=${ev.type} msgType=${ev.message?.type || '-'} user=${ev.source?.userId || '-'}`);
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

  // 職員模式（批次 4）：密語比對與已登入狀態一律最優先判斷，整段接管、不再往下走
  // #代碼／reporter 流程——職員用自然語言下所有指令，不用記兩套語法。
  if (isPasscodeMatch(text)) {
    if (await isStaffAuthenticated(userId)) {
      await replyOrPush(replyToken, userId, '您已經是職員模式了，直接問我就可以，不用再輸入一次密語。');
      return;
    }
    const { displayName } = await authenticateStaff(userId);
    console.log(`[line] 新職員登入 user=${userId} name=${displayName || '(無)'}`);
    await replyOrPush(replyToken, userId,
      `職員模式已啟用${displayName ? `，${displayName} 您好` : ''}！\n\n可以問我：活動列表／某場活動內容／某場後台數據／GEO 狀態／新增活動（直接給您同仁編輯連結）／某場媒體訓練連結。\n\n您的 LINE ID：${userId}\n（想在「有新的人用密語登入」時收到通知，把這組 ID 設成 LINE_ADMIN_USER_ID 環境變數即可）`);
    return;
  }
  if (await isStaffAuthenticated(userId)) {
    await handleStaffMessage(replyToken, userId, text);
    return;
  }

  // #代碼 綁定（半形／全形井號都收，同仁貼連結時中文輸入法常會打成全形）
  if (text.startsWith('#') || text.startsWith('＃')) {
    const code = text.slice(1).trim();
    const event = await findEventByCode(code);
    if (isUsable(event)) {
      await upsertBinding(userId, event.id);
      await replyOrPush(replyToken, userId,
        `已為您接上《${event.name}》✅\n\n請問您是哪家媒體？（方便新聞聯絡人後續服務，打媒體名稱即可，或回「略過」）\n\n之後就可以直接問問題了。`);
      return;
    }
    // 代碼對不上——很可能是把活動「代碼」跟活動「名稱」搞混了，把 # 拿掉當一般
    // 文字重新路由一次，不要只回「找不到」就結束，記者不會知道代碼跟名稱是兩回事。
    await handleUnbound(replyToken, userId, code || text);
    return;
  }

  const binding = await getBinding(userId);
  if (!binding) {
    await handleUnbound(replyToken, userId, text);
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

  await answerQuestion(replyToken, userId, event, binding.media_name, text);
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
