// 記者問答 API — 動態讀取活動知識庫，並將問答寫入 Google Sheets
//
// 回應分兩種模式：
//   1. 前端帶 stream: true → SSE 逐字串流（現行前台走這條）
//   2. 沒帶 → 維持原本一次回傳 { reply } 的 JSON（舊前端／外部呼叫者不會被打斷）

import { appendRows, warmAuth } from '../lib/sheets.js';
import { systemPromptFor, resolveEventContent, formatEventBasics } from '../lib/prompt.js';
import { isBusinessEvent, guardBusinessAnswer } from '../lib/audience.js';
import { toTraditionalTW, createTraditionalStream, ZH_TW_RULE } from '../lib/zh-tw.js';
import { reportAiFailure, BUSINESS_KEY_NAME } from '../lib/ai-alert.js';
import { readEventRows } from '../lib/events-table.js';
import { logAiUsage } from '../lib/ai-usage.js';
import { isRefusal, logRefusal, refusalReply, postAnthropic, buildSonnetRetryBody, SONNET_RETRY_MODEL, dropRefusedTurns, looksEnglish, REFUSAL_MIDWAY_ZH, REFUSAL_MIDWAY_EN } from '../lib/ai-refusal.js';
import { checkAnswerGrounding, stripDisclaimer } from '../lib/answer-grounding.js';

// 批次 120：Haiku 4.5 → Haiku 5.5。5.5 預設會開 adaptive thinking（4.5 不會），記者要的是聊天速度的回應，
// 所以下面 body 明確送 thinking:{type:'disabled'}（5.5 在 effort medium 以下接受）。不送 temperature 等取樣參數（5.5 會 400）。
const CHAT_MODEL = 'claude-haiku-5-5';

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

// ── 批次 134：模型拒答（HTTP 200 ＋ stop_reason:"refusal"）──────────────────────────────
// 拒答不是錯誤：不是金鑰、額度出狀況，所以**不要** reportAiFailure()（那是給記者會現場掛掉時叫人用的警報）。
// 以前這支對拒答零處理：content 是空的，記者看到的是「抱歉，無法取得回應。」，qa_log 還把這句記成答案，
// 伺服器 log 完全乾淨。現在：記一行 [ai-refusal]、能重答就重答、重答不了就給一句固定句（不經模型）。
//
// 串流中的 refusal 事件形狀（官方文件 platform.claude.com/docs/en/build-with-claude/ 的 streaming、
// handling-stop-reasons、refusals-and-fallback 三頁，2026-10-12 讀原文）：
//   · 確認的：stop_reason 只出現在 message_delta 事件的 delta.stop_reason（message_start 裡是 null、其他事件都沒有）；
//     拒答可以在輸出前、也可以在輸出到一半發生，「一半的輸出視為不完整、丟掉」；一半的輸出照算錢。
//   · 文件沒寫清楚的：串流拒答時 stop_details 放在 message_delta 的哪一層（推測是 delta.stop_details，與非串流
//     回應 stop_details 跟 stop_reason 同層一致）、拒答前有沒有 content_block_stop、有沒有一個專屬的 SSE 事件類型
//     （文件只說 server-side fallback 的 fallback 區塊是一般的 content_block_start／stop，沒有特別的事件）。
//   所以這裡故意寫得寬鬆：delta.stop_reason、事件本身的 stop_reason、message_start 的 message.stop_reason，
//   任何一個是 'refusal' 都算；stop_details 同理三處都找，只拿來寫 log（category 找不到就是 null，不影響處理）。
function streamRefusalDetails(evt) {
  if (!evt || evt.type === 'error') return undefined;
  if (!(isRefusal(evt.delta) || isRefusal(evt) || isRefusal(evt.message))) return undefined;
  const d = evt.delta?.stop_details ?? evt.stop_details ?? evt.message?.stop_details ?? null;
  return { stop_reason: 'refusal', stop_details: d };
}

// 輸出到一半才被攔下：已經送出去的字收不回來，接著補一句說明，不讓記者把半截答案當成完整答案引用。
// （說明句本身 REFUSAL_MIDWAY_ZH／EN 住在 lib/ai-refusal.js：下一題要認得「這一輪被拒答過」，跟固定句放一起。）

// 拒答固定句裡的新聞聯絡人是同仁在後台打的單位、姓名與電話，是**名稱**，跟 LINE（lib/line-runtime.js askAnthropic()）一致：
// 只轉字（簡→繁）、不轉用語（{ terms:false }）。不然同一場活動、同一個聯絡人，網頁把「光伏事業部」顯示成「太陽光電事業部」，
// LINE 卻是原樣，記者拿網頁看到的單位名稱去找會對不上（批次 134 審查）。
const toTraditionalName = (s) => toTraditionalTW(s, { terms: false });

// 非串流從模型回應取文字。不能寫死 content[0]：第一塊不保證是文字（見 api/line.js askAnthropic() 的說明）
const textOf = (data) => (data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();

// Haiku 5.5 被攔下時改用 Sonnet 5.5 非串流重答一次（Haiku 沒有伺服器端備援，見 lib/ai-refusal.js）。
// 回傳重答的文字；逾時、非 2xx、重答也被攔、沒有文字，一律回空字串——呼叫端改給固定句。
// 永遠不丟例外：重答是「錦上添花」，它壞了不能讓這一題變成 500。
// 剩餘時間沿用整次請求的 55 秒上限（扣掉已經用掉的），最少給 5 秒。
async function retryRefusedOnSonnet({ requestBody, key, startedAt, usageWhere, eventId }) {
  try {
    const res = await postAnthropic({
      apiKey: key,
      body: buildSonnetRetryBody(requestBody),
      signal: AbortSignal.timeout(Math.max(5_000, REQUEST_BUDGET_MS - (Date.now() - startedAt))),
      fallbacks: true // Sonnet 5.5 有伺服器端備援（只替 cyber／frontier_llm 重試）；Haiku 沒有，所以才需要這一輪
    });
    if (!res.ok) {
      console.error('拒答改 Sonnet 重答失敗，Anthropic API 狀態:', res.status);
      return '';
    }
    const data = await res.json();
    // 備援真的發生時，top-level 的 usage 與 model 是實際回答的那個模型
    const served = typeof data.model === 'string' && data.model ? data.model : SONNET_RETRY_MODEL;
    logAiUsage(`${usageWhere}（拒答改 Sonnet）`, served, data.usage);
    if (isRefusal(data)) {
      logRefusal(`${usageWhere}（改 Sonnet 重答）`, served, data, { eventId });
      return '';
    }
    return textOf(data);
  } catch (e) {
    console.error('拒答改 Sonnet 重答失敗:', e?.name, e?.message);
    return '';
  }
}

// 批次 132：答案出口檢查（數字、網址、英文名詞「答案有、模型看到的文字沒有」）。預設影子模式：只記 log，note 是空字串，
// 這裡就什麼都不接；ANSWER_GROUNDING=on 才會有 note。checkAnswerGrounding() 自己不丟例外，這裡再包一層是因為
// 它只是附加的提醒，萬一它壞了，不能讓記者的答案跟著變成 500。
// shownText 傳「這次真的送給模型的字串」：system 區塊（含知識庫、活動基本資料）＋記者自己說的話。
// ⚠️ 只放 user 輪，不放 assistant 輪——assistant 輪是模型先前自己說的，放進來它編的數字就被洗白成「來源有」。
function groundingNoteFor(reply, requestBody, eventId, stream) {
  try {
    const shownText = [
      ...requestBody.system.map(b => b.text),
      ...requestBody.messages.filter(m => m.role === 'user').map(m => m.content)
    ];
    // 英文答案後面接英文版提醒（外國記者看不懂中文提醒）；先拿掉結尾警語再判斷語言，見 buildGroundingNote()
    const note = checkAnswerGrounding(reply, shownText, {
      where: stream ? 'web-chat-stream' : 'web-chat', eventId, english: looksEnglish(stripDisclaimer(reply))
    }).note;
    // 提醒文字是固定句，本來就是繁體；仍然過一次出口，「每一段送出去的字都經過 toTraditionalTW」不留例外
    return note ? toTraditionalTW(note) : '';
  } catch (e) {
    console.error('答案出口檢查失敗，略過這一則:', e?.name, e?.message);
    return '';
  }
}

// 活動設定快取（60 秒；記者會現場臨時改稿也能很快生效）
const eventCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

// 讀到 Q 欄（invite_letter，媒體邀請函）——原本只讀到 J 就夠，批次 9.1 加了「活動前
// 只給邀請函」（見 lib/prompt.js resolveEventContent()），這裡也要跟著讀，不然網頁版
// 問答永遠拿不到邀請函內容，活動前一樣把還沒定案的新聞稿端出去，等於 LINE 端擋了、
// 網頁端沒擋。
// 批次 109：讀整張活動表走 lib/events-table.js 的共用快取。以前這裡每次讀 Sheets，而且「找不到」的
// 結果不快取——亂填 event_id 的請求每個都多打一次讀取，單 IP 每分鐘 120 題的上限比 Sheets 的
// 每分鐘 60 次讀取額度還高。現在不存在的 id 是在快取過的整張表裡查不到，一次 Sheets 讀取都不用。
async function fetchEventConfig(eventId) {
  const rows = await readEventRows();
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active', event_date: row[5] || '',
    organizer: row[9] || '工研院', images: row[7] || '', invite_letter: row[16] || '',
    // 時間、地點、新聞聯絡人（批次 72）：記者問「幾點開始／在哪裡」時答得出來，見 formatEventBasics()
    event_time: row[11] || '', venue: row[12] || '', press_contact: row[14] || '',
    // 活動類型（批次 118）：企業場換一份 prompt、出口擋報價，見 lib/audience.js
    event_type: row[13] || ''
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
async function logQA({ event_id, eventName, media_name, reporter_name, question, reply }) {
  if (!process.env.GOOGLE_SPREADSHEET_ID || !question) return;
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    // H 欄（source）批次 2 新增，用來分辨這題是網頁問的還是 LINE 問的（見 api/line.js）。
    // G 欄是既有的刪除旗標欄，這裡一定要補空字串佔位，不然 source 會寫錯格、
    // 後台會把這筆資料當成已刪除。
    // I 欄（批次 105）：記者姓名。網頁彈窗拆成「媒體」「姓名」兩欄後，D 欄只放媒體，這樣
    // 後台的「服務媒體家數」才數得準（舊版一整串「媒體 人名」去重，同一家會被算成好幾家）。
    await appendRows('qa_log!A:I', [[
      timestamp, event_id, eventName,
      sanitize(media_name, 40) || '（未填寫）', sanitize(question, 2000), reply, '', 'web',
      sanitize(reporter_name, 40)
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

  const { messages, event_id, media_name, reporter_name, stream, client_id } = req.body || {};

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  // client_id 只拿來當限流的 key，不寫進任何資料表、也不跟媒體名稱綁在一起
  if (rateLimited(ip, String(client_id || '').slice(0, 64))) {
    return res.status(429).json({ error: '提問太頻繁，請稍候片刻再試。' });
  }

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '請求格式錯誤' });
  if (!event_id) return res.status(400).json({ error: '缺少活動 ID' });

  // 網頁問答一定要先留下媒體名稱（批次 105，朱朱的決定：先填名稱，後台才做得出統計）。
  // 前台的彈窗與輸入框鎖定是第一道，這裡是**程式出口**那一道（CLAUDE.md 第 2 條）：舊版頁面
  // 還開在記者手機上、或有人直接打這支 API，都不會多出一筆「（未填寫）」。
  // 用 code 讓前台認得是這一種錯、重新打開彈窗，而不是把這句話當成 AI 的回答印出來。
  if (!sanitize(media_name, 40)) {
    return res.status(400).json({ error: '請先填寫貴媒體名稱，再開始提問。', code: 'media_required' });
  }

  // 裁切輸入：只留最近 12 則、每則截 8000 字 —— 沒有這道限制，輸入成本完全由呼叫者決定
  // ⚠️ 批次 116：只收字串。以前 content 不是字串就原樣轉給模型——傳一個 [{type:'text', text:…}]
  // 陣列，8000 字的上限就整個失效（實測 60 萬字照送），還能夾帶圖片、PDF 區塊。前台本來就只送字串，
  // 跟 api/training.js normalizeMessages() 同一個做法。
  // 批次 134：被拒答的那一輪（問題＋我們的固定句）不再帶進下一題，見 dropRefusedTurns() 的說明；
  // 放在「第一則必須是 user」的整理之前，拿掉成對的兩則之後開頭若變成 assistant，下面那行會接著處理。
  // ⚠️ 要在截 8000 字**之前**判斷：輸出到一半被攔下的那一輪，結尾是補上去的說明句，半截答案夠長的話
  // 先截斷就會把說明句截掉、認不出它。
  const trimmed = dropRefusedTurns(messages
    .slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()))
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  // 模型 API 要求第一則一定是使用者的話。「只留最近 12 則」會把一輪問答從中間切開：前端每一題都是
  // 「問、答、問、答…最後一個是問」，總數是奇數，往回數 12 則剛好從 AI 的回答開始——
  // 同一場對話問到第 7 題起，每一題都會被模型 API 退件（記者看到「暫時無法取得回應」）。
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
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
    // 企業場（批次 118）：企業版的規則；答案要先整則過出口檢查（背景資料沒有的金額＝報價，整則換掉），
    // 所以不串流——串流的字一送出去就收不回來。企業場的流量小，慢幾秒換一個不會說錯價的保證。
    const business = isBusinessEvent(event);
    // 企業場（批次 119）：有設 ANTHROPIC_API_KEY_BUSINESS 就用那一把，費用與每月上限跟記者那邊分開（見 lib/line-runtime.js askAnthropic()）
    const businessKey = business && !!process.env.ANTHROPIC_API_KEY_BUSINESS;
    const systemPrompt = systemPromptFor(event);
    const basicsBlock = formatEventBasics(event);
    const question = [...trimmed].reverse().find(m => m.role === 'user')?.content || '';

    logCtx = { event_id, eventName, media_name, reporter_name, question };

    // 企業場那一把金鑰（批次 119）；拒答改 Sonnet 重答（批次 134）也要用同一把，費用與每月上限才不會混進記者那邊
    const key = businessKey ? process.env.ANTHROPIC_API_KEY_BUSINESS : apiKey;
    const usageWhere = business ? '網頁問答（企業場）' : '網頁問答';
    // 請求內容先組成物件：拒答時要拿它改成 Sonnet 版重送（buildSonnetRetryBody），答案出口檢查也要從它取
    // 「模型真的看到的字」。欄位順序與 JSON 位元組跟以前直接內嵌 JSON.stringify({…}) 完全相同。
    const requestBody = {
      model: CHAT_MODEL,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      stream: !!stream && !business,
      // 知識庫在 60 秒快取視窗內逐 byte 穩定，加 ephemeral cache 讓同場記者連續發問時
      // 讀取只收 0.1 倍價（記者會現場正是這種「同一份知識庫、多人連續提問」的場景）。
      // ZH_TW_RULE 是固定字串，放進這塊不影響快取。
      system: [
        { type: 'text', text: systemPrompt + '\n' + ZH_TW_RULE, cache_control: { type: 'ephemeral' } },
        // 活動基本資料＋現在時間：每分鐘在變，放在快取區塊之後，不打散上面那塊的快取
        ...(basicsBlock ? [{ type: 'text', text: basicsBlock }] : [])
      ],
      messages: trimmed
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      // 涵蓋「等回應」與「讀串流」兩段：時間到，下面的 reader.read() 一樣會丟例外，
      // 走進 catch 送出說明，不會等到被 Vercel 砍掉。從請求一進來就起算——前面讀
      // Sheets 若卡在配額重試，花掉的時間也要扣掉（最少留 5 秒給模型）。
      signal: AbortSignal.timeout(Math.max(5_000, REQUEST_BUDGET_MS - (Date.now() - startedAt))),
      body: JSON.stringify(requestBody)
    });

    // 錯誤一律在切換成 SSE 之前處理掉，這樣還能回乾淨的 JSON 錯誤碼給前端
    if (!response.ok) {
      let detail = '';
      try {
        const j = await response.json();
        detail = j.error?.message || '';
      } catch (e) { /* 回應不是 JSON 就沒有細節可記 */ }
      console.error('Anthropic API 錯誤:', response.status, detail);
      // 批次 85；企業場那一把出事，通知寫明只影響企業場、節流也分開算（批次 119，見 lib/ai-alert.js）
      await reportAiFailure({ status: response.status, message: detail, where: business ? '網頁版企業場問答' : '網頁版記者問答', keyName: businessKey ? BUSINESS_KEY_NAME : undefined });
      return res.status(response.status).json({ error: friendlyApiError(response.status) });
    }

    if (!stream || business) {
      const data = await response.json();
      logAiUsage(usageWhere, CHAT_MODEL, data.usage); // 批次 117
      let text = textOf(data);
      // 批次 134：拒答是 HTTP 200，content 是空的或只有一半（一半的視為不完整、丟掉）。Haiku 5.5 沒有伺服器端備援，
      // 改用 Sonnet 5.5 重答一次；重答不了（也被攔、逾時、非 2xx）就給固定句，不經模型、不會講錯話。
      let refusedFixed = false;
      if (isRefusal(data)) {
        logRefusal(usageWhere, CHAT_MODEL, data, { eventId: event_id });
        text = await retryRefusedOnSonnet({ requestBody, key, startedAt, usageWhere, eventId: event_id });
        refusedFixed = !text;
      }
      if (refusedFixed) {
        // 固定句不是答案：不補企業免責句（沒有答案時本來就不補，見下面 `business && text`）、也不做答案出口檢查。
        reply = toTraditionalName(refusalReply({ contact: event.press_contact, english: looksEnglish(question) }));
      } else {
        reply = toTraditionalTW(text) || '抱歉，無法取得回應。';
        if (business && text) reply = guardBusinessAnswer(reply, event).text;
        // 批次 132：企業場不跑（它有 guardBusinessAnswer）；note 排在警語之後。預設影子模式 note 是空字串，一個字都不加
        if (!business && text) {
          const note = groundingNoteFor(reply, requestBody, event_id, false);
          if (note) reply += '\n\n' + note;
        }
      }
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
    // 批次 134：串流中看到 stop_reason:"refusal"（形狀見檔案上方的說明）。不立刻處理，讀完整條串流（要拿用量）再決定
    let refusal = null;
    // 用量（批次 117）：串流的 token 數分兩次來——message_start 帶輸入與快取，message_delta 帶輸出
    const usage = {};

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
        } else if (evt.type === 'message_start') {
          Object.assign(usage, evt.message?.usage || {});
        } else if (evt.type === 'message_delta') {
          Object.assign(usage, evt.usage || {});
        } else if (evt.type === 'error') {
          // 串流途中模型那端出錯（例如 overloaded）：原文記 log，記者看中文
          console.error('Anthropic 串流錯誤:', evt.error?.type, evt.error?.message);
          brokenMidway = true;
        }
        if (!refusal) refusal = streamRefusalDetails(evt) || null;
      }
    }
    // 批次 134：被攔下的串流，囤在繁體轉換器裡還沒送出的那一小段也是「被攔下的一半輸出」，丟掉不送。
    // （連線中途出錯又被攔的極少見情況，維持原本的出錯路徑，照舊把囤的字送完。）
    const refused = !!refusal && !brokenMidway;
    if (!refused) send(zh.flush());
    if (Object.keys(usage).length) logAiUsage('網頁問答', CHAT_MODEL, usage);

    // 結尾是固定句／說明（不是模型寫的答案）→ 不做答案出口檢查
    let fixedTail = false;
    if (refused) {
      logRefusal('網頁問答', CHAT_MODEL, refusal, { eventId: event_id });
      const english = looksEnglish(question);
      if (!reply) {
        // 輸出前就被攔下：一個字都還沒送出去，可以換成 Sonnet 非串流重答，成功就照常用串流格式送出
        const redo = await retryRefusedOnSonnet({ requestBody, key, startedAt, usageWhere: '網頁問答', eventId: event_id });
        zh = createTraditionalStream(); // 舊的那條還囤著被攔下的半截字，換一條乾淨的
        if (redo) {
          send(zh.push(redo));
          send(zh.flush());
        } else {
          send(toTraditionalName(refusalReply({ contact: event.press_contact, english })));
          fixedTail = true;
        }
      } else {
        // 已經送出去一部分才被攔下：字收不回來，接著補一句說明，不讓記者把半截答案當成完整答案引用
        send(toTraditionalTW('\n\n' + (english ? REFUSAL_MIDWAY_EN : REFUSAL_MIDWAY_ZH)));
        fixedTail = true;
      }
    }

    if (brokenMidway) {
      res.write(`data: ${JSON.stringify({ error: reply ? STREAM_BROKEN_MSG : friendlyApiError(529) })}\n\n`);
    }
    const answered = !!reply;
    if (!reply) reply = '抱歉，無法取得回應。';
    // 批次 132：答案出口檢查。只查模型真的寫出來、而且完整的答案（固定句、半截答案、斷線的都不查）；
    // 影子模式 note 是空字串，一個位元組都不多送。on 才會在 {done:true} 之前多送一個 {t} 事件，並接進 reply（qa_log 一致）。
    if (answered && !fixedTail && !brokenMidway) {
      const note = groundingNoteFor(reply, requestBody, event_id, true);
      if (note) send('\n\n' + note);
    }
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
