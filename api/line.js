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
import {
  readRawBody, verifySignature, replyOrPush, replyOrPushMessages, startLoading, pushImages,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, listRichMenus, deleteRichMenu
} from '../lib/line.js';
import { buildCalendarCards, buildAllCalendarCards, routeIntent, formatCalendarReply, calendarQuickReplyItems } from '../lib/router.js';
import {
  detectMetaIntent, matchEventByName, HELP_TEXT, buildWelcomeFlex,
  buildRichMenuDefinition, RICH_MENU_BUTTONS
} from '../lib/menu.js';
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
  return { event_id: row[1] || '', media_name: row[2] || '', note: row[5] || '' };
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

// noteOverride 沒帶時，既有列會保留原本的 note（F 欄）不動；帶了（包含空字串）
// 就直接覆蓋。#代碼綁定會傳 'ask_name' 標記「下一則要試著擷取媒體名稱」，
// 自然語言軟綁定（handleUnbound）不傳，維持原本「這位記者沒被問過名稱」的狀態，
// 不會被誤標成「等待輸入名稱」。見下面 note==='ask_name' 那段的說明。
async function upsertBinding(userId, eventId, noteOverride) {
  await ensureLineUsersSheet();
  const now = String(Date.now());
  const rows = await readRange(LINE_USERS_RANGE); // 寫入路徑要讀最新，不吃快取，正確性優先
  const idx = rows.findIndex(r => r[0] === userId);
  try {
    if (idx === -1) {
      await appendRows('line_users!A:F', [[userId, eventId, '', now, now, noteOverride ?? '']]);
    } else {
      const existing = rows[idx];
      await updateRange(`line_users!A${idx + 2}:F${idx + 2}`, [[
        userId, eventId, existing[2] || '', now, now,
        noteOverride !== undefined ? noteOverride : (existing[5] || '')
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

// 只清 F 欄（note）的一次性旗標，跟 setMediaName 對稱、各自只動自己的欄位。
async function setBindingNote(userId, note) {
  try {
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === userId);
    if (idx === -1) return;
    await updateRange(`line_users!F${idx + 2}`, [[note]]);
  } catch (e) {
    console.error('setBindingNote 失敗:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// 解除綁定：把 bound_at（D 欄）清空，getBinding() 讀到 0 就會當作沒綁定。
// 不刪整列——line_users 的媒體名稱是記者自報的，下次他綁別場時還用得到，
// 刪掉等於每換一場就要重問一次「請問哪家媒體」。
async function clearBinding(userId) {
  try {
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === userId);
    if (idx === -1) return;
    await updateRange(`line_users!D${idx + 2}:F${idx + 2}`, [['', String(Date.now()), '']]);
  } catch (e) {
    console.error('clearBinding 失敗:', e.message);
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

// 判斷一則短訊息「看起來像媒體名稱／略過」而不是提問——只在 note==='ask_name'
// 那一次性視窗內才會用到（見下面 handleEvent 裡的說明）。誤判的代價很小：最壞
// 情況是這一則被錯記成媒體名稱，記者的問題就再多打一次，之後也不會再被攔——
// 所以用簡單的啟發式即可，不需要另外呼叫 AI 判斷意圖。
function looksLikeNameOrSkip(text) {
  if (/^(略過|skip|跳過)$/i.test(text)) return true;
  if (text.length > 20) return false;
  if (/[?？]/.test(text)) return false;
  if (/^(請問|為什麼|什麼|怎麼|哪裡|哪一|何時|多少|是否|能不能|可以|會不會|有沒有|給我|請給|麻煩|幫我|提供|傳給我|傳送|寄送|附上|想問|想要|需要|來一份|給一份)/.test(text)) return false;
  return true;
}

// 判斷這句問題是不是在要照片——命中就在文字答案之後追加真正的圖片訊息（不是塞
// 進同一則，見 answerQuestion() 跟 lib/line.js pushImages() 的註解）。誤判的兩種
// 結果都沒有使用者感受得到的壞處：多附幾張用不到的照片，或沒附但文字答案裡本來
// 就有網址可以點開，所以用關鍵字比對就夠，不必為此多打一次 AI。
function looksLikePhotoRequest(text) {
  return /(照片|圖片|相片|圖檔|新聞照|相關圖|image|photo)/i.test(text);
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
  if (event.images && looksLikePhotoRequest(text)) {
    // 附圖是錦上添花、獨立一次 push：reply token 已經被上面那則文字答案用掉了，
    // 這裡本來就只能用 push；就算某張照片網址被 LINE 拒絕，也只記 log，不能讓
    // 附圖失敗連累記者根本沒收到文字答案（文字答案早在上一行就已經送出去了）。
    try {
      const res = await pushImages(userId, event.images);
      if (!res.ok && !res.skipped) console.error('LINE 附圖 push 失敗:', res.status);
    } catch (e) {
      console.error('LINE 附圖 push 例外:', e.message);
    }
  }
  await logQa(event, mediaName, text, reply);
}

// ── 安裝圖文選單（職員指令）─────────────────────────────────────────
// 做成職員模式的一句話指令、而不是新開一支 API：Vercel Hobby 的 12 支 Function
// 上限目前已經用掉 11 支，這個功能一輩子大概只會執行個位數次，不值得占掉最後一格
// （見 api/event-page.js 開頭那段三合一的同一個理由）。
//
// 底圖是去自己網站抓 /richmenu.png，不用 includeFiles 把檔案打包進 Function——
// 這是一次性動作，多一次 HTTP 往返完全無所謂，換來的是不必動 vercel.json，
// 也不會讓每次 webhook 的冷啟動多背一個 73KB 的檔案。
const SITE = 'https://itri-event-ai.vercel.app';

async function handleSetupRichMenu(replyToken, userId) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    await replyOrPush(replyToken, userId, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法建立圖文選單。');
    return;
  }
  await startLoading(userId, 30);

  try {
    const imgRes = await fetch(`${SITE}/richmenu.png`);
    if (!imgRes.ok) throw new Error(`抓取底圖失敗 ${imgRes.status}`);
    const image = Buffer.from(await imgRes.arrayBuffer());

    // 先記下現有的，等新選單確定上線後才刪——順序反過來的話，中間只要有一步失敗，
    // 記者就會看到一個完全沒有選單的帳號。
    const before = await listRichMenus();

    const richMenuId = await createRichMenu(buildRichMenuDefinition());
    await uploadRichMenuImage(richMenuId, image, 'image/png');
    await setDefaultRichMenu(richMenuId);

    for (const old of before) {
      if (old.richMenuId && old.richMenuId !== richMenuId) await deleteRichMenu(old.richMenuId);
    }

    console.log(`[line] 圖文選單已設定 id=${richMenuId} 清掉舊的 ${before.length} 個`);
    await replyOrPush(replyToken, userId,
      `圖文選單已設定完成 ✅\n\n記者的聊天室下方現在會出現三顆按鈕：\n${RICH_MENU_BUTTONS.map(b => `・${b.label}（${b.sub}）`).join('\n')}\n\n已經加過好友的人可能要把對話關掉重開才會看到。`);
  } catch (e) {
    console.error('設定圖文選單失敗:', e.message);
    await replyOrPush(replyToken, userId, `設定圖文選單失敗：${e.message}\n\n請確認 LINE_CHANNEL_ACCESS_TOKEN 有效，且網站已部署最新版本。`);
  }
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
    await replyOrPush(replyToken, userId, formatCalendarReply(cards), calendarQuickReplyItems(cards));
    return;
  }

  if (routed.intent === 'geo_status') {
    await replyOrPush(replyToken, userId, formatGeoStatusReply(await getGeoStatusSummary()));
    return;
  }

  if (routed.intent === 'setup_richmenu') {
    await handleSetupRichMenu(replyToken, userId);
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
        `是想查這幾場的哪一場？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`,
        routed.event_ids.map(cardName));
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
      `是想問這幾場的哪一場？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`,
      routed.event_ids.map(cardName));
    return;
  }

  await replyOrPush(replyToken, userId,
    '職員模式可以問：活動列表／某場活動內容／某場後台數據／GEO 狀態／新增活動（會給編輯連結）／某場媒體訓練連結／設定圖文選單。直接打活動名稱或說明需求即可。',
    ['最近有哪些活動', 'GEO現在狀況', '設定圖文選單']);
}

// ── 「跳出本場」意圖（活動列表／換一場／使用說明）─────────────────────
// ⚠️ 這是實際回報的問題：原本只要 line_users 有有效綁定，handleEvent 就把每一則
// 訊息無條件送進 answerQuestion()，記者打「最近活動」會被當成「請那一場的 AI 回答
// 『最近活動』」——AI 手上只有那一場的知識庫，只能再自我介紹一次，記者等於被鎖死在
// 掃到的那場，沒有任何出口。
//
// 解法是在進問答之前先攔三種「這句話不是在問某一場內容」的意圖。判斷放在
// lib/menu.js、純關鍵字不呼叫 AI（理由見該檔開頭），所以綁定中的正常提問一個字節
// 都沒變慢，也不會多一分錢。
//
// 放在綁定判斷「之前」是刻意的：沒綁定的記者問「使用說明」一樣要拿到說明，而不是
// 掉進 routeIntent() 被判成 other、只拿到「不確定您想問哪一場」。
async function handleMetaIntent(replyToken, userId, text, metaIntent, binding) {
  // ask_name 是「#代碼綁定後問了媒體名稱，下一則要試著擷取」的一次性旗標。
  // 記者在那個視窗裡改按了選單按鈕，代表他跳過了報名字這件事，旗標要當場作廢——
  // 不清掉的話，等他選完活動再回來打的第一句真正的問題，會被 looksLikeNameOrSkip()
  // 誤判成媒體名稱吃掉（就是上面 handleEvent 註解裡已經修過一次的那個坑）。
  if (binding?.note === 'ask_name') await setBindingNote(userId, '');

  if (metaIntent === 'help') {
    await replyOrPush(replyToken, userId, HELP_TEXT, ['最近有哪些活動']);
    return;
  }

  const cards = buildCalendarCards(await getAllEventRows());

  if (metaIntent === 'switch') {
    // 真的解除綁定，不只是回一句提示：記者說「換一場」之後打的下一句多半是新場次
    // 的名稱，留著舊綁定的話那句會先被當成對舊場次的提問。
    if (binding) await clearBinding(userId);
    await replyOrPush(replyToken, userId,
      `好的，已經離開原本那一場。\n\n請直接輸入想問的活動名稱，或從下面挑一場。\n\n${formatCalendarReply(cards)}`,
      calendarQuickReplyItems(cards));
    return;
  }

  // calendar：只列清單，不解除綁定——記者多半只是想看看有什麼，看完還會繼續問
  // 原本那場。真的要換，按下清單的按鈕（送出的就是完整活動名稱）會走
  // matchEventByName() 自動切過去，不需要他先「離開」再「進入」。
  const current = binding ? await getEventById(binding.event_id) : null;
  const suffix = isUsable(current)
    ? `\n\n（您目前在問的是《${current.name}》，直接發問就會回答這一場；想換場點下面的按鈕即可。）`
    : '';
  await replyOrPush(replyToken, userId, formatCalendarReply(cards) + suffix, calendarQuickReplyItems(cards));
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
    await replyOrPush(replyToken, userId, formatCalendarReply(cards), calendarQuickReplyItems(cards));
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
        `您是想問這幾場的哪一場呢？\n${names.map(n => '・' + n).join('\n')}\n\n請直接打完整或部分活動名稱。`,
        names);
      return;
    }
  }

  // intent === 'other'，或 qa 但完全比對不到、或路由本身失敗 → 統一導引，
  // 跟批次 2 原本沒綁定時的文案一致，只是多給「或直接打活動名稱」這條路。
  await replyOrPush(replyToken, userId,
    '不確定您想問哪一場活動——可以直接輸入活動名稱、或問「最近有哪些活動」查看清單，也可以掃描現場 QR code 綁定。',
    ['最近有哪些活動', '使用說明']);
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
    // 加好友只有這一次機會講清楚「這是什麼、怎麼開始」。純文字會被滑過去，改送
    // 有三步驟與按鈕的 Flex 圖卡（見 lib/menu.js buildWelcomeFlex）。
    // Flex 送失敗（欄位打錯、LINE 版本太舊）不能讓新記者收到一片空白，
    // 所以退回原本那則純文字歡迎詞——文案本身仍然是完整可用的引導。
    const ok = await replyOrPushMessages(ev.replyToken, userId, [buildWelcomeFlex()]);
    if (!ok) {
      await replyOrPush(ev.replyToken, userId,
        '感謝加入好友！\n\n請掃描活動現場的 QR code，或直接輸入「#活動代碼」開始問答；也可以直接打活動名稱，或點下面的按鈕看看目前有哪些活動。\n\n本帳號會記錄您的提問內容以改善新聞服務，不會蒐集您的個人資料。',
        ['最近有哪些活動', '使用說明']);
    }
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
      `職員模式已啟用${displayName ? `，${displayName} 您好` : ''}！\n\n可以問我：活動列表／某場活動內容／某場後台數據／GEO 狀態／新增活動（直接給您同仁編輯連結）／某場媒體訓練連結／設定圖文選單。\n\n您的 LINE ID：${userId}\n（想在「有新的人用密語登入」時收到通知，把這組 ID 設成 LINE_ADMIN_USER_ID 環境變數即可）`,
      ['最近有哪些活動', 'GEO現在狀況', '設定圖文選單']);
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
      await upsertBinding(userId, event.id, 'ask_name');
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

  // 活動列表／換一場／使用說明——不管有沒有綁定都要先攔，見 handleMetaIntent() 的說明
  const metaIntent = detectMetaIntent(text);
  if (metaIntent) {
    console.log(`[line] meta intent=${metaIntent} user=${userId} q="${text.slice(0, 40)}"`);
    await handleMetaIntent(replyToken, userId, text, metaIntent, binding);
    return;
  }

  if (!binding) {
    await handleUnbound(replyToken, userId, text);
    return;
  }

  // 綁定中但整句就是「另一場活動的名稱」（多半是剛按了活動清單的按鈕）→ 直接換過去。
  // 不做這件事的話，按了按鈕只會讓舊那場的 AI 去回答「某某記者會」這句話。
  const switchTo = matchEventByName(text, buildCalendarCards(await getAllEventRows()), binding.event_id);
  if (switchTo) {
    const target = await getEventById(switchTo.id);
    if (isUsable(target)) {
      console.log(`[line] 換場 ${binding.event_id} → ${target.id} user=${userId}`);
      // 第三個參數傳空字串是要「清掉」note，不是省略。記者掃 QR 綁定後被問了媒體
      // 名稱（note='ask_name'），卻改打另一場的名稱換過去——這代表他跳過了報名字。
      // 不在這裡清掉的話旗標會跟著新綁定留下來，他換場後打的第一句真正的問題會被
      // 下面 looksLikeNameOrSkip() 誤判成媒體名稱吃掉（同下方 ⚠️ 那個已修過的坑）。
      await upsertBinding(userId, target.id, '');
      await answerQuestion(replyToken, userId, target, binding.media_name, text);
      return;
    }
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    await replyOrPush(replyToken, userId, '這場活動目前無法問答，請洽現場工作人員。');
    return;
  }

  // 媒體名稱擷取：只在 #代碼綁定當下明確問過一次（note==='ask_name'）的「下一則」
  // 才嘗試擷取，而且無論這則判斷結果是不是像名稱，用掉這一次後就立刻清掉旗標，
  // 之後永遠不會再被攔截。
  //
  // ⚠️ 這是實際在正式環境發生過的 bug 修正：舊版判斷式只看「media_name 還沒填」，
  // 不管有沒有真的被問過名稱——軟綁定（自然語言命中，見 handleUnbound）的記者
  // 從頭到尾沒被問過名稱，media_name 永遠是空字串，於是只要問題剛好不含「？」
  // 也沒用疑問詞開頭（例如「給我完整新聞稿」），就會被 looksLikeNameOrSkip 誤判成
  // 「像名稱」，永遠卡在「已記錄，謝謝」、問幾次都一樣，真正的問題從沒被回答過。
  // ⚠️ note 欄位（line_users F 欄）批次 5 規劃另外要用來標 pending（真人接手），
  // 兩者目前不會同時發生，但要做批次 5 時請先看 LINE-PLAN.md 這段的完整說明。
  if (binding.note === 'ask_name') {
    await setBindingNote(userId, ''); // 一次性：不管這則判斷結果如何，用掉就清掉
    if (looksLikeNameOrSkip(text)) {
      const isSkip = /^(略過|skip|跳過)$/i.test(text);
      await setMediaName(userId, isSkip ? '（未提供）' : sanitize(text, 40));
      await replyOrPush(replyToken, userId, '已記錄，謝謝！請直接輸入您的問題即可。');
      return;
    }
    // 不像名稱、比較像直接問問題 → 不回「已記錄」，直接當問題往下走，
    // 記者不會因為系統誤判而被迫多問一次。
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
