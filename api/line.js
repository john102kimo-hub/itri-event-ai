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
// 群組／多人聊天（批次 5，仿美玉姨模式）：加進群組後預設完全安靜，只有被 @ 到
// 才回答，見 handleGroupEvent() 開頭的說明。密語／職員指令、#代碼綁定在群組裡
// 完全不接——同一群組可能同時有記者跟公關同仁，職員身分只能私訊取得。
//
// 批次 2/3/4 刻意不做、目前仍未做的事（見 LINE-PLAN.md）：
//   - 真人接手轉接標記、邀訪收單（記者端的 media_requests）
//
// 安全與坑，詳見 LINE-PLAN.md 第 3 節：
//   - 簽章驗證必須用原始 bytes，不能碰 req.body（見 lib/line.js 開頭註解）
//   - reply token 60 秒只能用一次，reply 失敗一律 fallback push（見 lib/line.js）
//   - 限流用 line_user_id 當 key，不能用 IP——webhook 全部來自 LINE 自己的伺服器，
//     用 IP 當 key 等於全部記者共用同一個額度，會互相誤殺
//   - 沒有有效綁定／路由結果就不能呼叫 Anthropic，跟 api/chat.js「無 event_id 不碰
//     Anthropic」同一條原則；draft／archived 場次一律不進行事曆清單、不會被路由到

import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';
import { buildSystemPrompt, resolveEventContent } from '../lib/prompt.js';
import {
  readRawBody, verifySignature, replyOrPush, replyOrPushMessages, startLoading, pushImages,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, listRichMenus, deleteRichMenu,
  linkRichMenuToUser, unlinkRichMenuFromUser,
  isBotMentioned, stripMentionText, pushMessage
} from '../lib/line.js';
import { buildCalendarCards, buildAllCalendarCards, routeIntent, formatCalendarReply, calendarQuickReplyItems } from '../lib/router.js';
import {
  detectMetaIntent, matchEventByName, HELP_TEXT, buildWelcomeFlex,
  buildRichMenuDefinition, ALL_MENUS, REPORTER_MENU, STAFF_MENU
} from '../lib/menu.js';
import {
  isPasscodeMatch, isStaffAuthenticated, authenticateStaff, routeStaffIntent,
  createDraftEvent, editLink, trainingLink, ensureEventEditCode, getEventRawById,
  getEventAnalyticsSummary, formatEventAnalyticsReply, getGeoStatusSummary, getGeoTrendSeries,
  isExitStaffCommand, revokeStaff, listActiveStaffIds, getStaffPending, setStaffPending
} from '../lib/staff.js';
import { buildGeoBriefFlex, formatGeoBriefText } from '../lib/geo-brief.js';
import {
  CONTACTS_DIR_RANGE, GLOBAL_CONTACT_TOPICS, ensureContactsDirectorySheet,
  parseContactsDirectory, formatGlobalContact, matchGlobalContactByText
} from '../lib/contacts-directory.js';

const EVENTS_RANGE = 'events!A2:R'; // P 欄是 contacts（邀訪窗口分工），Q 欄是 invite_letter（媒體邀請函），R 欄是 invite_letter_chips（活動前快速提問），見 rowToEvent()
// line_user_id | event_id | media_name | bound_at | last_active | note | group_session_until
// G 欄只有群組會用到（1 對 1 每則訊息本來就都是對我們講的，不需要這個概念），見
// getGroupSessionUntil()／touchGroupSession() 的說明。
const LINE_USERS_RANGE = 'line_users!A2:G';
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
    knowledge_base: row[3] || '', status: row[4] || 'active', event_date: row[5] || '',
    chips: row[6] || '', images: row[7] || '', organizer: row[9] || '工研院',
    press_contact: row[14] || '', contacts: row[15] || '', invite_letter: row[16] || '',
    invite_letter_chips: row[17] || ''
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

// 媒體名稱（C 欄）沒有 TTL 概念，是跟著這個人走的個人資料，不是「這次綁定」的一部分——
// 記者三個月後再回來問別場，名字還在，不用重問。跟 getBinding() 分開一支的原因：
// getBinding() 的 6 小時 TTL 過期就回 null，但過期只代表「不知道現在要問哪一場」，
// 不代表「不知道這個人是誰」，兩者不能混在一起判斷。
async function getStoredMediaName(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  return row ? (row[2] || '') : '';
}

// note（F 欄）的原始值，不管綁定是否過期——跟 getStoredMediaName() 同一個理由：
// getBinding() 過期就回 null，但「有沒有等待中的一次性旗標」跟「活動綁定還算不算數」
// 是兩件事，全域邀訪窗口的 await_contact_topic 旗標（見 setContactPending()）常常是
// 在完全沒有活動綁定的情況下設的，不能透過 getBinding() 去讀。
async function getStoredNote(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  return row ? (row[5] || '') : '';
}

// 成功才記住，失敗就等 60 秒再試一次。
// 舊版是「失敗也記成已完成」，理由是避免每個請求都多打一次 API——但那代表冷啟動後
// 第一次呼叫剛好撞到 Sheets 暫時性錯誤（配額、503）時，這個 instance 從此再也不會
// 建立 line_users 分頁，之後每一次綁定都靜靜寫不進去，而且不會有人發現。60 秒的
// 冷卻時間同樣達成「不要每個請求都多打一次」，但錯誤是暫時的就會自己好。
let sheetsEnsuredAt = 0;
const ENSURE_RETRY_MS = 60 * 1000;
async function ensureLineUsersSheet() {
  if (sheetsEnsuredAt === Infinity) return;
  if (Date.now() - sheetsEnsuredAt < ENSURE_RETRY_MS) return;
  try {
    await ensureSheets({ line_users: ['line_user_id', 'event_id', 'media_name', 'bound_at', 'last_active', 'note', 'group_session_until'] });
    sheetsEnsuredAt = Infinity; // 建好了就永遠不用再確認
  } catch (e) {
    console.error('ensureSheets(line_users) 失敗，60 秒後再試:', e.message);
    sheetsEnsuredAt = Date.now();
  }
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

// 跟 setBindingNote() 的差異：這支在完全沒有 line_users 列的情況下也要能標記——
// 全域邀訪窗口的「其他」選項是常見的第一次互動（記者可能從沒綁定過任何活動就直接
// 問邀訪窗口），這時候 setBindingNote() 會因為 idx===-1 直接放棄，旗標永遠標不上，
// 記者打了主題文字也不會被接住。這裡改成「沒有列就新增一列」，event_id／bound_at
// 都留空——getBinding() 讀到 bound_at=0 一樣會判定成沒有活動綁定，不會誤觸發任何
// 跟活動有關的邏輯。
async function setContactPending(targetId, note) {
  try {
    await ensureLineUsersSheet();
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === targetId);
    if (idx === -1) {
      if (!note) return; // 沒有列可清，本來就沒有 pending
      await appendRows('line_users!A:F', [[targetId, '', '', '', String(Date.now()), note]]);
    } else {
      await updateRange(`line_users!F${idx + 2}`, [[note]]);
    }
  } catch (e) {
    console.error('setContactPending 失敗:', e.message);
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

// ── 群組的「還算不算在跟我們對話」──────────────────────────────────────
// 實際回報的情況：在群組裡 @ 了我們一次、拿到活動清單之後，接著（沒有再 @）打了
// 清單裡某場的名稱，完全沒反應——因為當時的規則是「每一則都要 @」，這則沒 @ 到
// 就被 handleGroupEvent 安靜擋掉了。規則本身沒有邏輯錯誤，但體感是「剛剛不是才
// 理我嗎，怎麼問下去就不理了」。
//
// 解法是給一個很短的「對話還算活著」的時間窗：被 @ 到並且我們真的回答了之後，
// 接下來 GROUP_SESSION_MS 之內，同一個群組不用 @ 也會被當作還在跟我們講話；
// 超過時間窗，或這段期間都沒人開口，就退回「一定要 @」的預設安全模式。
//
// ⚠️ 這個「session」刻意跟活動綁定（bound_at／event_id，TTL 6 小時）分開存在
// 獨立的 G 欄，不能共用同一個時間戳：
//   - 活動綁定管的是「這個群組現在問的是哪一場」，就算沒人 @、只要在 6 小時內
//     持續問同一場都有效，日期抓比較長
//   - session 管的是「剛剛是不是才被 @ 過」，只有幾分鐘，用來讓使用者不用每一句
//     都重新 @——沒有活動綁定時 getBinding() 會回傳 { event_id: '' }，把兩者混在
//     同一欄會讓「還沒問過任何一場」的群組被誤判成「綁定了一個空字串的活動」，
//     answerQuestion() 拿到空 event_id 直接找不到活動、整個掛掉。
const GROUP_SESSION_MS = 5 * 60 * 1000; // 5 分鐘：夠讀完清單、想一下、再打字問下一句

async function getGroupSessionUntil(groupId) {
  try {
    const rows = await readRange(LINE_USERS_RANGE);
    const row = rows.find(r => r[0] === groupId);
    return row ? Number(row[6]) || 0 : 0;
  } catch (e) {
    console.error('getGroupSessionUntil 失敗:', e.message);
    return 0; // 查詢失敗就當作沒有活躍中的對話——安全方向是要求重新 @，不是誤觸插話
  }
}

// 每次我們真的在群組裡回答了什麼，就呼叫這支幫時間窗續命。跟 upsertBinding() 分開
// 寫，是因為呼叫時機不一樣：這支要在「所有」有回答的路徑後面都呼叫一次（活動列表、
// 換場提示、真正的問答…），upsertBinding() 只在換場／軟綁定那幾個特定時機才呼叫。
async function touchGroupSession(groupId) {
  try {
    await ensureLineUsersSheet();
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === groupId);
    const until = String(Date.now() + GROUP_SESSION_MS);
    if (idx === -1) {
      await appendRows('line_users!A:G', [[groupId, '', '', '', String(Date.now()), '', until]]);
    } else {
      // 只動 G 欄，A:F（活動綁定那幾欄）完全不碰——這支不該影響綁定狀態。
      await updateRange(`line_users!G${idx + 2}`, [[until]]);
    }
  } catch (e) {
    console.error('touchGroupSession 失敗:', e.message);
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

// 網頁版 public/event.html 沒有自訂 chips 時的預設建議問題（見該檔的 defaultChips）。
// ⚠️ 兩邊各自維護一份同樣的文字，不是共用模組：event.html 是純瀏覽器 <script>，
// 沒有打包流程可以匯入 lib/ 底下的 ESM 模組。這份只是「建議問題的預設文案」，跟
// LINE-PLAN.md 說的「不要做兩邊同步」講的是知識庫／答案內容那種一改就走鐘、記者
// 會拿到錯誤資訊的東西，性質不一樣——這裡頂多措辭跟網頁版不完全同步，不是功能壞掉。
const DEFAULT_CHIPS = [
  '這次活動的主要發表內容是什麼？',
  '有哪些合作廠商參與？',
  '這項技術的應用場域為何？',
  '請問主要的技術突破點是什麼？',
  '這項技術預計何時商業化？'
];

// 回報的意見：網頁版問答介面一直都有同仁自訂的快速提問 chips（活動的「本場次提供
// 資料」欄位，見 events!G／public/event.html 的 chipList），記者不用自己想問題、
// 點一下就能問。LINE 這邊之前完全沒有——綁定後只能靠打字，公關同仁在後台特地設定
// 的關鍵字（新聞稿、新聞照片…）記者根本看不到，等於功能做了一半沒用到。
//
// 直接把同一組 chips 轉成 LINE 的 quick reply 按鈕，跟網頁版用同一個資料來源
// （event.chips），不需要另外維護一份「LINE 專用關鍵字」——同仁在後台改一次，
// 網頁跟 LINE 同步生效。沒設定自訂 chips 的活動退回 DEFAULT_CHIPS，跟網頁版行為
// 一致，不會讓記者看到空的按鈕列。
// 送出這句就是要看邀訪聯絡窗口的清單，見下面 handleMetaIntent() 的 'contacts' 分支跟
// lib/menu.js 的 detectMetaIntent()。固定加在每則答案的按鈕最後一格，記者不用先知道
// 要打這句話才找得到這個功能——跟內容 chips 放在一起才會被看到。
const CONTACT_MENU_LABEL = '媒體邀訪需求';

// LINE quick reply 上限 13 顆，扣掉固定的「媒體邀訪需求」那一格，內容 chips 最多留
// 12 格——同仁在後台放了 13 題以上的自訂問題不是常態，但真的放了也不能讓陣列超過
// LINE 的硬限制，寧可截斷內容 chips 也不能把邀訪窗口的入口擠掉。
//
// 內部先過一次 resolveEventContent()：活動前（見 lib/prompt.js 的說明）自訂 chips
// 若還是原本那組「問活動內容」的問句，記者點下去常常只會得到「這部分我沒有資料」——
// 不是壞掉，但沒有用。呼叫端不用先自己判斷是不是活動前、也不用先手動 resolve 一次，
// 這裡永遠拿到「當下該用哪組 chips」的正確答案；resolveEventContent() 對已經 resolve
// 過的 event 再呼叫一次是安全的（同一批欄位只會算出同樣的結果，不會疊加）。
function eventQuickChips(rawEvent) {
  const event = resolveEventContent(rawEvent || {});
  const custom = String(event?.chips || '').split('\n').map(s => s.trim()).filter(Boolean);
  const contentChips = (custom.length ? custom : DEFAULT_CHIPS).slice(0, 12);
  return [...contentChips, CONTACT_MENU_LABEL];
}

// 回報的意見：記者被引導「請直接輸入想問的活動名稱，或從下面挑一場」（換場、或
// 查活動列表時）只看得到活動名稱按鈕，找不到入口問「媒體邀訪需求」——這件事本來
// 就不是針對某一場活動，是跨活動的議題／窗口詢問（見 sendGlobalContactMenu()），
// 塞在「先選一場」的清單裡反而是選錯位置，記者只能自己打字才問得到。
//
// 跟 eventQuickChips() 同一招：固定加在清單最後一格，記者不用先知道要打這句話。
// 只給記者端的活動清單用（handleMetaIntent／handleUnbound）——handleStaffMessage()
// 自己的 'calendar' 分支刻意不套用，同仁已經有整套 STAFF_QUICK_REPLIES，「媒體
// 邀訪需求」是講給記者聽的措辭，職員這裡看到只會多一顆用不到的按鈕。
function calendarQuickRepliesForReporter(cards) {
  return [...calendarQuickReplyItems(cards), CONTACT_MENU_LABEL];
}

// 回報的意見：按鈕列最後一格的「媒體邀訪需求」不夠明顯，滑一排按鈕容易漏看——
// 直接把入口寫進文字裡，不能只靠按鈕。跟 calendarQuickRepliesForReporter() 同一組、
// 同樣只給記者端的活動清單用，固定接在 formatCalendarReply() 的結果後面。
//
// ⚠️ 措辭刻意不寫「跨活動」——這裡送出的字串跟 eventQuickChips() 的按鈕、記者
// 自己打字問，最後都走同一支 handleMetaIntent() 的 'contacts' 分支：目前綁定的
// 這場如果自己有設定聯絡窗口（events!P 或 press_contact），會先給那組最精準的
// 資訊，只有這場完全沒設定時才退到全域清單（批次 8/9 就是這樣設計，這裡沒有改
// 這個優先順序）。曾經寫成「如果是跨活動的採訪需求」，結果記者綁定的那場剛好
// 設定過聯絡人，點下去還是拿到那場的窗口，跟文字說的對不上——這裡只承諾「有
// 這個入口」，不承諾「一定給你全域清單」。
const CONTACT_MENU_TEXT_HINT = '\n\n（有採訪窗口相關的需求，直接打「媒體邀訪需求」或點下面的按鈕即可。）';

// ── 邀訪聯絡窗口分工（events!P，同仁在後台設定）───────────────────────
// 回報的意見：不同議題該找誰，記者常常猜不到，只能一律洽詢單一的「新聞聯絡人」。
// 同仁在後台可以設定多組「關鍵字｜姓名｜電話｜LINE ID」，記者點對應關鍵字就能拿到
// 精準的窗口，而不是每次都轉一手。
//
// 每行一組，用跟 images／chips 同一套「半形｜全形都收」的分隔規則：
//   關鍵字｜姓名｜電話｜LINE ID(選填)
function parseEventContacts(event) {
  return String(event?.contacts || '')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const [keyword, name, phone, lineId] = line.split(/[|｜]/).map(s => (s || '').trim());
      return { keyword, name, phone, lineId };
    })
    .filter(c => c.keyword && c.name); // 缺關鍵字或姓名的行直接略過，不要讓半填的資料跑出去
}

// 訊息文字精準命中某個窗口的關鍵字才回覆聯絡資訊——只認完全比對（去空白、忽略大小寫），
// 不做模糊比對：這類回覆是「精準的聯絡方式」，寧可命中不了、讓記者換句話問一次，也不要
// 把「技術規格」跟「技術突破」這種相近但不同的關鍵字搞混、給錯聯絡人。
function matchContact(text, contactsField) {
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const t = norm(text);
  if (!t) return null;
  return parseEventContacts({ contacts: contactsField }).find(c => norm(c.keyword) === t) || null;
}

function formatContactReply(contact) {
  const lines = [`【${contact.keyword}】邀訪聯絡窗口`, contact.name];
  if (contact.phone) lines.push(`📞 ${contact.phone}`);
  if (contact.lineId) lines.push(`LINE：${contact.lineId}`);
  return lines.join('\n');
}

// ── 全域技術窗口分工（跨活動，同仁在後台維護，不綁定特定場次）───────────
// 資料格式、預設種子、比對邏輯都在 lib/contacts-directory.js——api/events.js 的
// 後台編輯 API 也要讀寫同一份資料，兩邊共用一份定義才不會格式或種子內容兜不起來。
const CONTACT_TOPIC_RE = /^邀訪[:：](.+)$/; // 主題按鈕送出的固定格式，見 sendGlobalContactMenu()
const CONTACT_PENDING_NOTE = 'await_contact_topic'; // 按了「其他」，等記者自己打主題的一次性旗標

let contactsDirCache = { list: null, expiry: 0 };
async function getContactsDirectory() {
  if (contactsDirCache.list && Date.now() < contactsDirCache.expiry) return contactsDirCache.list;
  await ensureContactsDirectorySheet(ensureSheets, updateRange);
  let raw = '';
  try {
    const rows = await readRange(CONTACTS_DIR_RANGE);
    raw = rows[0]?.[0] || '';
  } catch { raw = ''; }
  const list = parseContactsDirectory(raw);
  contactsDirCache = { list, expiry: Date.now() + CACHE_TTL_MS };
  return list;
}

// metaIntent==='contacts' 且沒有活動專屬窗口可用時的入口（見 handleMetaIntent()）。
// 主題按鈕文字刻意用「邀訪：主題」而不是主題本身：LINE quick reply 現在支援
// {label,text} 分開（見 lib/line.js buildQuickReply()），按鈕上看到的字很短
// （例如「生醫」），但送出的文字帶固定前綴，才不會跟記者自己打的真正問題撞在一起
// （萬一剛好在問某場跟「生醫」有關的活動內容，不會被誤判成在找邀訪窗口）。
async function sendGlobalContactMenu(replyToken, userId) {
  const items = [
    { label: '活動名稱', text: '最近有哪些活動' },
    ...GLOBAL_CONTACT_TOPICS.map(t => ({ label: t, text: `邀訪：${t}` })),
    { label: '其他', text: '邀訪：其他' }
  ];
  await replyOrPush(replyToken, userId,
    '請問想了解哪個技術領域，或想找哪一場活動的邀訪窗口？可以直接點下面按鈕，或輸入活動名稱。',
    items);
}

// 攔截「邀訪：主題」按鈕點擊，以及按過「其他」之後的下一則自由輸入——不管目前有沒有
// 活動綁定、綁定的是哪一場，這兩種情況都要優先攔下來，不能被送進當前那場活動的問答
// （記者按「邀訪：生醫」不是在問「生醫」這兩個字，是要查聯絡窗口）。命中就處理完並
// 回傳 true，呼叫端據此判斷要不要繼續往下走原本的流程；沒命中回傳 false。
async function handleContactTopicMessage(replyToken, targetId, text) {
  const m = String(text || '').match(CONTACT_TOPIC_RE);
  if (m) {
    const topic = m[1].trim();
    if (topic === '其他') {
      await setContactPending(targetId, CONTACT_PENDING_NOTE);
      await replyOrPush(replyToken, targetId, '請直接輸入想了解的技術主題，或想邀訪的議題，我幫您媒合對應窗口。');
      return true;
    }
    // 按了別的主題按鈕，代表放棄了「其他」那個等待輸入的視窗（如果有的話）——不清掉
    // 的話，記者接下來打的第一句真正的問題會被誤當成在找邀訪窗口的自由輸入。
    await setContactPending(targetId, '');
    const directory = await getContactsDirectory();
    const contact = directory.find(c => c.topic === topic);
    await replyOrPush(replyToken, targetId,
      contact ? formatGlobalContact(contact) : '這個主題目前還沒有設定聯絡窗口，請洽現場工作人員。');
    return true;
  }

  const pendingNote = await getStoredNote(targetId);
  if (pendingNote === CONTACT_PENDING_NOTE) {
    await setContactPending(targetId, ''); // 一次性：不管這則有沒有比對到，用掉就清掉
    const directory = await getContactsDirectory();
    const hit = matchGlobalContactByText(text, directory);
    const fallback = directory.find(c => c.topic === '其他');
    if (hit) {
      await replyOrPush(replyToken, targetId, formatGlobalContact(hit));
    } else if (fallback) {
      await replyOrPush(replyToken, targetId, `目前沒有抓到明確對應的窗口，${formatGlobalContact(fallback)}`);
    } else {
      await replyOrPush(replyToken, targetId, '目前還沒有設定綜合聯絡窗口，請洽現場工作人員。');
    }
    return true;
  }

  return false;
}

// 正式問答：開輸入中動畫 → 呼叫 Anthropic → reply（失敗 fallback push）→ 寫 qa_log。
// 綁定路徑（#代碼）跟路由命中路徑（自然語言直接命中某一場）最後都走這支，避免兩邊各自
// 維護一份幾乎一樣的邏輯、之後改一邊忘了改另一邊。
async function answerQuestion(replyToken, userId, rawEvent, mediaName, text, { loading = true, allowPreEventSubstitution = true, switchNotice = '' } = {}) {
  // 活動前只給媒體邀請函、不給正式新聞稿與照片（見 lib/prompt.js resolveEventContent()
  // 的說明）。放在這裡而不是呼叫端各自判斷，理由跟下面的邀訪窗口比對一樣：1 對 1、
  // 群組最後都走這支，寫一次兩邊都受惠。
  //
  // ⚠️ 職員模式呼叫這支時會傳 allowPreEventSubstitution:false——同仁需要看到真正的
  // 新聞稿內容準備活動，不能被自己設的「活動前」邏輯反過來卡住自己。
  const event = allowPreEventSubstitution ? resolveEventContent(rawEvent) : rawEvent;

  // 「輸入中」動畫（/chat/loading/start）只支援一對一聊天，LINE 官方文件明講
  // group／room 不能傳這個端點；group 訊息呼叫它每次都是穩定失敗，只會在
  // Vercel Logs 裡累積一堆沒意義的錯誤。startLoading() 內部已經吞掉例外不影響
  // 主流程，但既然知道一定會失敗，group 呼叫端直接傳 loading:false 跳過，
  // 而不是每一則群組提問都送一次注定失敗的 API 呼叫。
  if (loading) await startLoading(userId, 55);

  // 命中同仁設定的邀訪窗口關鍵字就直接回聯絡資訊，不呼叫 AI——這類回覆要求精準，
  // 電話號碼、LINE ID 這種資訊不該讓 AI 用自然語言重新生成一次（打錯一碼就是
  // 記者聯絡不到人）。放在 answerQuestion() 裡而不是呼叫端各自檢查，是因為
  // 1 對 1、群組、職員模式最後都走這支，寫一次三邊都受惠。
  // switchNotice：批次 13「綁定改成預設值」加的提示字首（見 handleEvent／
  // handleGroupMessage 裡呼叫端判斷這題其實在問別場時傳進來的「🔄 已切換到《X》：」）。
  // 兩個分支（命中邀訪關鍵字／走 AI 問答）都要接上，記者才看得出這題是被自動切去
  // 別場回答的——悄悄換掉答案卻不說一聲，比根本不能換更危險（LINE-PLAN.md 坑 6）。
  const contact = matchContact(text, event.contacts);
  if (contact) {
    const reply = switchNotice + formatContactReply(contact);
    console.log(`[line] contact match event=${event.id} keyword="${contact.keyword}"`);
    await replyOrPush(replyToken, userId, reply, eventQuickChips(event));
    await logQa(event, mediaName, text, reply);
    return;
  }

  const systemPrompt = buildSystemPrompt(event, lineExtraRules(event));
  const aiReply = await askAnthropic(systemPrompt, text);
  const reply = switchNotice + aiReply;
  // 診斷用途，不是必要邏輯：路由判斷得準不準、AI 答得順不順，靠這行在 Vercel Logs
  // 裡直接看得到，不用另外接工具。刻意截斷長度，避免整份新聞稿灌爆單行 log。
  console.log(`[line] answer event=${event.id} status=${event.status} q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  // 每則答案都附上這場的快速提問按鈕（同仁自訂的 chips，或沒設定時的預設問題）——
  // 跟網頁版一樣，chips 不是「選過一次就收起來」的一次性選單，而是隨時都在，記者
  // 問完一題還想繼續問別的方向，點一下就好，不用自己想下一句要打什麼。
  await replyOrPush(replyToken, userId, reply, eventQuickChips(event));
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

// 職員的快速回覆按鈕。LINE 上限 13 顆，這裡用 7 顆——圖文選單那六格全部列出來
// （選單被收起來時仍然點得到），再加「設定圖文選單」這顆選單本身放不進去的。
// 原本只給兩顆（活動列表／GEO 狀態），其餘功能同仁得自己知道要打什麼才用得到，
// 等於功能做了卻沒人找得到。
const STAFF_QUICK_REPLIES = [...STAFF_MENU.buttons.map(b => b.text), '設定圖文選單'];

// 職員登入／設定選單時要拿到職員選單的 id。不另外存一份到試算表——選單本來就有
// name 欄位，用它反查即可，少一個會跟 LINE 那邊不同步的狀態。
async function findRichMenuIdByName(name) {
  const menus = await listRichMenus();
  return menus.find(m => m.name === name)?.richMenuId || null;
}

// 把某個 userId 換成職員選單。整段包在 try 裡：選單是體驗加分，綁失敗不能讓
// 「密語登入」這件事本身失敗——他仍然是職員，只是先看到記者選單而已。
async function applyStaffMenu(userId) {
  try {
    const id = await findRichMenuIdByName(STAFF_MENU.name);
    if (!id) return; // 還沒跑過「設定圖文選單」，正常情況，不用吵
    await linkRichMenuToUser(userId, id);
  } catch (e) {
    console.error('綁定職員選單失敗（不影響職員身分）:', e.message);
  }
}

async function handleSetupRichMenu(replyToken, userId) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    await replyOrPush(replyToken, userId, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法建立圖文選單。');
    return;
  }
  await startLoading(userId, 45);

  try {
    // 先記下現有的，等新選單全部確定上線後才刪——順序反過來的話，中間只要有一步
    // 失敗，記者就會看到一個完全沒有選單的帳號。
    const before = await listRichMenus();

    const created = {};
    for (const menu of ALL_MENUS) {
      const imgRes = await fetch(`${SITE}/richmenu-${menu.key}.png`);
      if (!imgRes.ok) throw new Error(`抓取 ${menu.name} 底圖失敗 ${imgRes.status}`);
      const id = await createRichMenu(buildRichMenuDefinition(menu));
      await uploadRichMenuImage(id, Buffer.from(await imgRes.arrayBuffer()), 'image/png');
      created[menu.key] = id;
    }

    // 記者選單設為預設（所有人），職員再逐一覆蓋成職員選單。
    // per-user 連結的優先度高於預設，所以記者永遠看不到「新增活動」「後台數據」
    // 這些內部功能的入口。
    await setDefaultRichMenu(created[REPORTER_MENU.key]);

    const staffIds = await listActiveStaffIds();
    let linked = 0;
    for (const sid of staffIds) {
      try { await linkRichMenuToUser(sid, created[STAFF_MENU.key]); linked++; }
      catch (e) { console.error(`綁定職員選單失敗 user=${sid}:`, e.message); }
    }

    const keep = new Set(Object.values(created));
    for (const old of before) {
      if (old.richMenuId && !keep.has(old.richMenuId)) await deleteRichMenu(old.richMenuId);
    }

    console.log(`[line] 圖文選單已設定 ${JSON.stringify(created)} 職員綁定 ${linked}/${staffIds.length} 清掉舊的 ${before.length} 個`);
    await replyOrPush(replyToken, userId,
      '圖文選單已設定完成 ✅\n\n' +
      `【記者看到的】\n${REPORTER_MENU.buttons.map(b => `・${b.label}`).join('\n')}\n\n` +
      `【職員看到的】（已套用到 ${linked} 位職員）\n${STAFF_MENU.buttons.map(b => `・${b.label}`).join('\n')}\n\n` +
      '記者不會看到職員那一套。已經加過好友的人可能要把對話關掉重開才會看到。');
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
  // ⚠️ 退出一定要在 routeStaffIntent() 之前用字面比對攔下來。交給 AI 判意圖會被歸到
  // 'other'，使用者只會拿到一份能力清單、永遠退不出去（實際回報過的狀況）。
  // 權限的關閉不該取決於模型當下判得準不準。
  if (isExitStaffCommand(text)) {
    await revokeStaff(userId);
    await unlinkRichMenuFromUser(userId); // 解除個人連結 → 自動落回記者選單
    console.log(`[line] 職員退出 user=${userId}`);
    await replyOrPush(replyToken, userId,
      '已退出職員模式 ✅\n\n您現在跟一般記者看到的一樣，下方選單也換回記者版。\n要再進來，重新輸入一次密語即可。',
      ['最近有哪些活動', '使用說明']);
    return;
  }

  const rows = await getAllEventRows();
  // 職員要用「全部場次」的候選清單，不能用記者版的 buildCalendarCards()——
  // 那支會濾掉 draft／archived，職員問得到的場次卻不在候選清單裡，路由回傳的
  // event_id 會被 routeStaffIntent() 自己的白名單過濾掉，變成「查得到內容、卻永遠
  // 比對不到活動」。見 lib/router.js 的註解。
  const cards = buildAllCalendarCards(rows);

  // ⚠️ 承接上一則的追問。實際回報的 bug：打「查活動後台數據」→ 系統問「哪一場？」→
  // 打「四足」→ 卻跑去回答四足那場的活動內容。
  //
  // 職員模式原本每一則訊息都各自重新路由一次，完全沒有記憶。「四足」單獨看就是一個
  // 活動名稱，模型判成 qa 完全合理——問題不在模型判錯，而在沒有人告訴它「上一句我問
  // 的是哪一場的後台數據」。所以這裡先把 pending 讀回來（讀取免費，isStaffAuthenticated
  // 本來就要讀同一批列），再用它覆寫這次的意圖。
  const pending = await getStaffPending(userId);
  if (pending) await setStaffPending(userId, ''); // 一次性，用掉就清

  const routed = await routeStaffIntent(text, cards);

  if (pending) {
    if (pending === 'create_event' && routed.intent !== 'create_event') {
      // 上一則問的是「新活動叫什麼名字」，這一則整句就是答案。不能交給模型重判——
      // 「半導體技術發表會」這種輸入看起來就像在問某場活動的內容。
      routed.intent = 'create_event';
      routed.new_event_name = text;
    } else if ((pending === 'event_analytics' || pending === 'training_link') && routed.event_ids.length > 0) {
      // 上一則問的是「哪一場」，這一則模型已經比對出場次了，只要把意圖換回來
      routed.intent = pending;
    }
    console.log(`[line] staff 承接追問 pending=${pending} → intent=${routed.intent}`);
  }

  console.log(`[line] staff route user=${userId} q="${text.slice(0, 60)}" → ${JSON.stringify(routed)}`);
  const cardName = id => cards.find(c => c.id === id)?.name || id;

  // 追問時附上活動名稱按鈕：點按鈕送出的是完整活動名稱，模型比對得到、pending 也
  // 還在，兩條路都通。只列有意義的前幾場，LINE 上限 13 顆。
  const eventQuickReplies = (ids) =>
    (ids && ids.length ? ids.map(cardName) : cards.slice(0, 8).map(c => c.name)).slice(0, 13);

  if (routed.intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards), calendarQuickReplyItems(cards));
    return;
  }

  if (routed.intent === 'geo_status') {
    // 一則 Flex 訊息把「今日掃描進度」「近 14 天總覽」「監視中的議題」「追蹤中的
    // 活動」全部帶齊，不再分兩次送（舊版文字+另外 push 一張圖）。長條圖用 LINE
    // 原生 Flex box 畫（見 lib/geo-brief.js 開頭的說明），不靠外部服務組圖表網址，
    // 沒有網址長度上限這個天花板——這正是舊版圖片常態性顯示壞掉圖示的根因。
    const [statusData, seriesData] = await Promise.all([getGeoStatusSummary(), getGeoTrendSeries()]);
    const flex = buildGeoBriefFlex(statusData, seriesData, SITE);
    const ok = flex ? await replyOrPushMessages(replyToken, userId, [flex]) : false;
    if (!ok) {
      // Flex 送失敗（舊版 LINE App、格式被拒、或兩邊資料都查不到）不能讓同仁收到
      // 一片空白，退回純文字版——跟 lib/menu.js buildWelcomeFlex 同一套降級模式。
      await replyOrPush(replyToken, userId, formatGeoBriefText(statusData, seriesData, SITE));
    }
    return;
  }

  if (routed.intent === 'setup_richmenu') {
    await handleSetupRichMenu(replyToken, userId);
    return;
  }

  if (routed.intent === 'create_event') {
    if (!routed.new_event_name) {
      // 記下「我正在等新活動名稱」，下一則整句就會被當成名稱（見上面承接追問那段）
      await setStaffPending(userId, 'create_event');
      await replyOrPush(replyToken, userId, '請告訴我新活動的名稱，直接打名稱就好，例如：\n半導體先進封裝技術發表會');
      return;
    }
    const created = await createDraftEvent(routed.new_event_name, routed.new_event_date);
    console.log(`[line] 職員新增活動 id=${created.id} name="${created.name}"`);
    await replyOrPush(replyToken, userId,
      `已建立《${created.name}》（狀態：未發布，僅後台看得到）\n\n同仁編輯連結（給負責的同仁，他不需要後台密碼）：\n${editLink(created.id, created.editCode)}\n\n內容填好、確認沒問題後，要到後台按「發布」才會對記者公開。`);
    return;
  }

  if (routed.intent === 'event_analytics' || routed.intent === 'training_link') {
    const what = routed.intent === 'event_analytics' ? '後台數據' : '媒體訓練連結';
    if (routed.event_ids.length === 0) {
      // 記下「我正在等他回答哪一場」，否則他打「四足」會被重新判成問活動內容
      await setStaffPending(userId, routed.intent);
      await replyOrPush(replyToken, userId,
        `請問是想查哪一場的${what}？直接打活動名稱，或點下面的按鈕。`,
        eventQuickReplies());
      return;
    }
    if (routed.event_ids.length > 1) {
      await setStaffPending(userId, routed.intent);
      await replyOrPush(replyToken, userId,
        `是想查這幾場的哪一場的${what}？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`,
        eventQuickReplies(routed.event_ids));
      return;
    }
    const eventId = routed.event_ids[0];
    if (routed.intent === 'event_analytics') {
      const summary = await getEventAnalyticsSummary(eventId, cardName(eventId));
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary));
    } else {
      // 舊活動可能還沒有編輯碼，當場補一個（冪等），不要把同仁踢回後台自己弄一次
      const editCode = await ensureEventEditCode(eventId);
      if (!editCode) {
        await replyOrPush(replyToken, userId, '這場活動的編輯碼產生失敗，請稍後再試，或到後台開啟一次該活動的編輯連結。');
        return;
      }
      await replyOrPush(replyToken, userId,
        `《${cardName(eventId)}》\n\n媒體訓練（發言練習）：\n${trainingLink(eventId, editCode)}\n\n同仁編輯連結（改內容用，不需後台密碼）：\n${editLink(eventId, editCode)}`);
    }
    return;
  }

  if (routed.intent === 'qa' && routed.event_ids.length === 1 && routed.confidence === 'high') {
    const event = await getEventRawById(routed.event_ids[0]);
    if (event) {
      // 職員模式刻意不呼叫 isUsable()：draft／archived 場次的內容同仁都問得到。
      // allowPreEventSubstitution:false——同仁自己要看真正的新聞稿內容準備活動，
      // 不能被「活動前只給邀請函」這條規則反過來卡住自己人。
      await answerQuestion(replyToken, userId, event, '（內部職員）', text, { allowPreEventSubstitution: false });
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
    '職員模式可以做這些事（下面按鈕直接點，或用講的也可以）：\n' +
    STAFF_MENU.buttons.map(b => `・${b.label}——${b.sub}`).join('\n') +
    '\n・某場活動內容——直接打活動名稱\n・設定圖文選單——重設下方選單',
    STAFF_QUICK_REPLIES);
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
  // await_contact_topic 是「按了『其他』，等記者自己打技術主題」的一次性旗標——
  // 記者這時候改按了別的選單按鈕（不管是不是邀訪相關），代表他放棄了那個自由輸入，
  // 旗標要當場作廢，不然他接下來打的第一句真正的問題會被誤判成在找邀訪窗口
  // （這裡沒辦法只看 binding?.note，因為這個旗標常常是在完全沒有活動綁定時設的）。
  if ((await getStoredNote(userId)) === CONTACT_PENDING_NOTE) await setContactPending(userId, '');

  if (metaIntent === 'help') {
    await replyOrPush(replyToken, userId, HELP_TEXT, ['最近有哪些活動']);
    return;
  }

  if (metaIntent === 'contacts') {
    // 邀訪窗口分兩層：先看這場活動自己有沒有設定專屬窗口（events!P，同仁在後台
    // 針對這一場填的），有就照舊給精準的那組；這場沒設定（或根本還沒綁定任何
    // 活動）就退到跨活動的全域技術窗口清單（見 sendGlobalContactMenu()）——
    // 不管有沒有綁定活動都拿得到，不會再卡在「請先告訴我您想問哪一場」。
    const current = binding ? await getEventById(binding.event_id) : null;
    if (isUsable(current)) {
      const contacts = parseEventContacts(current);
      if (contacts.length) {
        await replyOrPush(replyToken, userId,
          `《${current.name}》的邀訪聯絡窗口：\n請選擇想聯絡的主題，或直接打關鍵字。`,
          contacts.map(c => c.keyword));
        return;
      }
      if (current.press_contact) {
        await replyOrPush(replyToken, userId,
          `《${current.name}》的新聞聯絡人：\n${current.press_contact}`, eventQuickChips(current));
        return;
      }
      // 這場活動兩個都沒設定 → 往下退到全域技術窗口清單，比什麼都拿不到好。
    }
    await sendGlobalContactMenu(replyToken, userId);
    return;
  }

  const cards = buildCalendarCards(await getAllEventRows());

  if (metaIntent === 'switch') {
    // 真的解除綁定，不只是回一句提示：記者說「換一場」之後打的下一句多半是新場次
    // 的名稱，留著舊綁定的話那句會先被當成對舊場次的提問。
    if (binding) await clearBinding(userId);
    await replyOrPush(replyToken, userId,
      `好的，已經離開原本那一場。\n\n請直接輸入想問的活動名稱，或從下面挑一場。\n\n${formatCalendarReply(cards)}${CONTACT_MENU_TEXT_HINT}`,
      calendarQuickRepliesForReporter(cards));
    return;
  }

  // calendar：只列清單，不解除綁定——記者多半只是想看看有什麼，看完還會繼續問
  // 原本那場。真的要換，按下清單的按鈕（送出的就是完整活動名稱）會走
  // matchEventByName() 自動切過去，不需要他先「離開」再「進入」。
  const current = binding ? await getEventById(binding.event_id) : null;
  const suffix = isUsable(current)
    ? `\n\n（您目前在問的是《${current.name}》，直接發問就會回答這一場；想換場點下面的按鈕即可。）`
    : '';
  await replyOrPush(replyToken, userId, formatCalendarReply(cards) + suffix + CONTACT_MENU_TEXT_HINT, calendarQuickRepliesForReporter(cards));
}

// 沒有有效綁定時的自然語言處理（批次 3）：讓路由判斷這是查活動列表、問特定一場、
// 還是無關問題。路由失敗或判不出來，一律退回批次 2 原本的引導文案，不會卡住、
// 也不會誤觸問答。
//
// silentOnOther：群組的「免 @ 續問視窗」（見 handleGroupEvent）在用，判不出來要
// 問哪一場時，1 對 1 給引導文案是體貼，群組裡沒被直接 @ 又給同一句引導文案就是
// 插話——這種情況安靜比較安全，等真的被 @ 到再回。1 對 1 呼叫端不傳這個參數，
// 維持原本一定會給引導文案的行為。
//
// askMediaName：回報的意見——用打活動名稱軟綁定（這支）的記者從頭到尾沒被問過
// 媒體名稱，跟 #代碼 QR 掃碼綁定（有 ask_name 一次性擷取視窗）不一樣，後台的問答
// 分析永遠看到「（未填寫）」，沒辦法統計哪些媒體來過。群組不能問——一個群組裡有
// 多個不同媒體的人，「貴媒體名稱」這句話對群組沒有意義，group 呼叫端傳 false。
async function handleUnbound(replyToken, userId, text, { silentOnOther = false, askMediaName = true } = {}) {
  const rows = await getAllEventRows();
  const cards = buildCalendarCards(rows);
  const { intent, event_ids, confidence } = await routeIntent(text, cards);
  console.log(`[line] reporter route q="${text.slice(0, 60)}" → intent=${intent} event_ids=${JSON.stringify(event_ids)} confidence=${confidence}`);

  if (intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards) + CONTACT_MENU_TEXT_HINT, calendarQuickRepliesForReporter(cards));
    return;
  }

  if (intent === 'qa' && event_ids.length === 1 && confidence === 'high') {
    const event = await getEventById(event_ids[0]);
    if (isUsable(event)) {
      // 路由命中就順手軟綁定——下一題不用再重打一次活動名稱，也能重複利用
      // 6 小時 TTL 那套過期機制，不用另外維護一套「路由記憶」。
      await upsertBinding(userId, event.id);
      // 媒體名稱是跟著這個人走的（見 getStoredMediaName 的說明），不是這場才有——
      // 之前來問過別場、報過名字或按過略過的人，這裡沿用，不用再問一次。
      const existingName = askMediaName ? await getStoredMediaName(userId) : '';
      await answerQuestion(replyToken, userId, event, existingName, text);
      // 只在「這個人從沒被問過」時才順手問一次，而且不擋住剛剛的答案——用 push
      // 補問，記者不用先回答完媒體名稱才拿得到他真正想要的內容。
      if (askMediaName && !existingName) {
        await setBindingNote(userId, 'ask_name');
        await pushMessage(userId, '對了，方便留個貴媒體的名稱嗎？（打名稱即可，或回「略過」——之後就不會再問了）');
      }
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

  // intent === 'other'，或 qa 但完全比對不到、或路由本身失敗。
  if (silentOnOther) return; // 群組裡沒被直接 @、又猜不到問題在問什麼 → 安靜，不要沒事跳出來說「不確定」

  // 統一導引，跟批次 2 原本沒綁定時的文案一致，只是多給「或直接打活動名稱」這條路。
  // 回報的意見：舊文案「不確定您想問哪一場活動」讀起來像制式錯誤訊息，語氣冷、
  // 也不符合米亞的人設；語氣改軟一點，並補上「媒體邀訪需求」這個入口——這句其實
  // 是萬用的兜底文案，不只在「真的問到別場」時出現，任何 routeIntent() 判不出來
  // 的話都會走到這裡，讓記者順手看到三個核心入口比較好。
  await replyOrPush(replyToken, userId,
    '嗯～我沒抓到您想問哪一場活動耶 🤔\n可以直接輸入活動名稱、問我「最近有哪些活動」看清單，或掃描現場 QR code 綁定；想找邀訪窗口就打「媒體邀訪需求」。',
    ['最近有哪些活動', CONTACT_MENU_LABEL, '使用說明']);
}

// ── 群組／多人聊天（批次 5/6，仿美玉姨：被 @ 到才開口，短暫續問視窗）──────
// 前置作業（人類要做的事，程式碼管不到）：LINE Official Account Manager →
// 「設定 → 回應設定」把「允許加入群組/多人聊天」打開，官方帳號才有辦法被邀進群組；
// 沒開這個，LINE 根本不會讓人把帳號拉進群組，這支永遠不會被觸發。
//
// 核心規矩：沒被 @ 到、也不在剛互動過的短暫視窗內，就完全安靜——不回覆、不留任何
// 痕跡。這支帳號要是每則群組訊息都插話，很快就會被關靜音或直接被踢出群組，這個
// 通道就毀了（跟 LINE-PLAN.md 第 8 節「不要做推播行銷」同一種風險：一旦刷了存在
// 感，就再也回不去了）。isBotMentioned() 判斷用的是 LINE 官方為此加的
// mentionee.isSelf 欄位，見 lib/line.js 開頭的說明；這個欄位不存在或不是 true，
// 一律當作沒被叫到。
//
// ⚠️ 實際回報的體感落差：@ 一次拿到活動清單之後，接著（沒有再 @）打清單裡的活動
// 名稱，完全沒反應——每則都要 @ 的規則本身沒有邏輯錯誤，但使用者會覺得「剛剛不是
// 才理我嗎」。解法是 GROUP_SESSION_MS 那段續問視窗（見上面 touchGroupSession() 的
// 說明）：被 @ 到並回答之後，接下來幾分鐘內同一個群組不用重新 @ 也算在跟我們對話；
// 這段期間如果猜不出問題在問什麼，安靜略過（silentOnOther）而不是跳出來說「不確定
// 您想問哪一場」——那句話對一個直接 @ 我們的人是體貼，對群組裡剛好聊到別的事的人
// 就是插話。
async function handleGroupEvent(replyToken, ev) {
  const groupId = ev.source?.groupId || ev.source?.roomId || null;
  if (!groupId) return; // 不明來源，安全起見不回覆

  const mentioned = isBotMentioned(ev.message?.mention);
  if (!mentioned) {
    const sessionUntil = await getGroupSessionUntil(groupId);
    if (!sessionUntil || Date.now() > sessionUntil) return; // 沒被 @、也不在續問視窗內 → 安靜
    if (ev.message?.type !== 'text') return; // 續問視窗內的非文字訊息（貼圖…）安靜略過，不用來亂回

    // 回報的意見：續問視窗內只要有人講話就會回，即使明顯是在跟另一個人講話
    // （例如「我再跟＠小明說話」）——機器人還是煞有其事答一段內容，感覺像亂回。
    //
    // 這裡沒被 @ 到、但訊息本身明確 @ 了「別人」（有 mentionee，且沒有一個是我們
    // 自己）——這是最乾脆的「不是在跟我講話」訊號，比事後用 AI 判斷「這是不是
    // 閒聊」更準也更省一次呼叫：routeIntent() 沒有對話記憶，看不出「那合作廠商
    // 有哪些」這種依賴上一句才聽得懂的續問跟純聊天的差別，用它來擋這種情況風險
    // 太高，會連正常續問一起擋掉；但「@ 了別人」這件事本身就已經很明確，不需要
    // 靠 AI 猜。
    //
    // 安靜（不呼叫 touchGroupSession()）還有第二層效果：目前的雪球是「亂回一次
    // → 視窗又續命 5 分鐘 → 群組只要持續有人講話，視窗永遠不會真的過期」。不幫
    // 這種訊息續命，視窗才有機會真的到期。
    if ((ev.message.mention?.mentionees || []).some(m => m?.isSelf !== true)) return;
  } else if (ev.message?.type !== 'text') {
    await replyOrPush(replyToken, groupId, '目前群組內僅支援文字訊息提問，請直接輸入您的問題。');
    return;
  }

  // 把 @ 的那段文字拿掉，只留真正的問題；沒被 @ 到（續問視窗內）時 mention 是
  // undefined，stripMentionText 會原樣回傳（trim 過）。
  const text = stripMentionText(ev.message?.text, ev.message?.mention);
  if (!text) {
    // 只 @ 沒接問題——這句提示只在「真的被 @ 到」時才有意義；續問視窗內若剛好
    // 出現空文字（理論上不會發生，防呆而已）不用多嘴。
    //
    // 回報的意見：舊文案只教「怎麼問」（例句只有「最近有哪些活動」），沒講「可以
    // 問什麼」——群組裡第一次 @ 我們的人常常就是只打個 @ 試探，看到的卻只有一句
    // 操作說明，猜不到「媒體邀訪需求」這條路也走得通。改成先簡短自我介紹，同時
    // 把記者最常問的兩個方向（活動查詢／邀訪窗口）都講出來，再附快速回覆按鈕讓
    // 對方不用自己打字。
    if (mentioned) {
      await replyOrPush(replyToken, groupId,
        '你好，我是工研院 AI 助手米亞 🙂\n想了解最近有哪些活動、或是媒體邀訪需求，都歡迎直接問我！\n請在 @ 我的後面接著打問題，或點下面的按鈕：',
        ['最近有哪些活動', CONTACT_MENU_LABEL, '使用說明']);
      // 這則回覆本身也附了按鈕，記者點下去送出的是沒有 @ 的純文字——續問視窗沒開
      // 的話會被 handleGroupEvent() 開頭那段「沒被 @ 又不在視窗內 → 安靜」擋掉，
      // 按鈕就變成「按了沒反應」。跟其餘所有「有回答」的路徑一樣，這裡也要續命。
      await touchGroupSession(groupId);
    }
    return;
  }

  // 用 groupId 當限流 key，跟 1 對 1 用 line_user_id 同一個理由：LINE webhook
  // 全部來自 LINE 自己的伺服器，用單一額度保護的是「這個群組」，不會因為某個人
  // 連環發問就把同一群組其他人也一起鎖住（額度本來就是共用的，這是刻意的）。
  if (rateLimited(groupId)) {
    await replyOrPush(replyToken, groupId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // ⚠️ 群組裡刻意不接職員模式：密語比對／#代碼綁定完全跳過，一律走記者端的自然
  // 語言路由。同一群組裡可能同時有記者、公關同仁、甚至長官，密語一旦在群組裡打
  // 出來，所有在場的人都看得到——職員身分只能在私訊裡取得，這裡沒有例外。
  await handleGroupMessage(replyToken, groupId, text, { mentioned });
}

// 跟 1 對 1（handleUnbound／handleMetaIntent／答題）共用整套邏輯，差異只有：
//   - 沒有 #代碼／ask_name 媒體名稱擷取——群組裡不會有人主動報媒體名稱，qa_log
//     統一記成「（群組提問）」
//   - answerQuestion() 傳 loading:false——「輸入中」動畫不支援 group/room，見
//     answerQuestion() 開頭的註解
//   - mentioned 決定猜不出問題時要不要出聲（見 handleGroupEvent 開頭的說明）
// 其餘（跳出本場意圖、換場、軟綁定）完全沿用 1 對 1 那一套，用 groupId 當
// line_users 表的 key——等於「這個群組」自己有一份軟綁定狀態，直接複用整套 TTL／
// 換場機制，不必為群組另外維護一份幾乎一樣的邏輯。
async function handleGroupMessage(replyToken, groupId, text, { mentioned }) {
  const binding = await getBinding(groupId);

  const metaIntent = detectMetaIntent(text);
  if (metaIntent) {
    await handleMetaIntent(replyToken, groupId, text, metaIntent, binding);
    await touchGroupSession(groupId); // 這一輪有回答 → 續問視窗重新計時
    return;
  }

  // 全域邀訪窗口的主題按鈕／自由輸入（見 handleContactTopicMessage() 的說明）——
  // 跟 metaIntent 同一優先順序，命中就直接處理，不會被送進當前綁定活動的問答。
  if (await handleContactTopicMessage(replyToken, groupId, text)) {
    await touchGroupSession(groupId);
    return;
  }

  if (!binding) {
    await handleUnbound(replyToken, groupId, text, { silentOnOther: !mentioned, askMediaName: false });
    await touchGroupSession(groupId); // 不管有沒有真的答上，只要走到這裡就算還在互動，續命
    return;
  }

  const switchTo = matchEventByName(text, buildCalendarCards(await getAllEventRows()), binding.event_id);
  if (switchTo) {
    const target = await getEventById(switchTo.id);
    if (isUsable(target)) {
      await upsertBinding(groupId, target.id, '');
      // 純粹選台，不是問題——理由跟 1:1 那段同一套（見上方那段的完整說明），
      // 不呼叫 AI、不寫 qa_log，避免灌水「累積回答題數」。
      await replyOrPush(replyToken, groupId, `已為您換到《${target.name}》✅ 請直接問問題即可。`);
      await touchGroupSession(groupId);
      return;
    }
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    // 綁定指向的活動變成不可問答（例如被下架）——這種邊界情況比照 silentOnOther
    // 的邏輯：真的被 @ 到才值得說明，續問視窗內安靜跳過就好。
    if (mentioned) await replyOrPush(replyToken, groupId, '這場活動目前無法問答，請洽現場工作人員。');
    return;
  }

  // 跟 1:1 那段同一套邏輯（完整說明見 handleEvent()）：綁定是預設值不是鎖，問句
  // 明確指向別場才自動換，其餘留在原場。群組共用一份綁定，換場會影響整個群組
  // 接下來的預設場次——跟現有「打整句活動名稱換台」本來就是同一種風險，不是
  // 這裡新增的。currentEventId 帶目前這場給 routeIntent()，讓它分得出「延續這場
  // 的討論」跟「真的無關」（見 lib/router.js 的說明），下面的安靜門檻才靠得住。
  const routed = await routeIntent(text, buildCalendarCards(await getAllEventRows()), { currentEventId: event.id });

  // 回報的意見：批次 14 只擋得住「明確 @ 別人」這種訊號很強的情況，續問視窗內
  // 純聊天、答非所問的訊息（例如「友信你覺得呢」）當時沒有安全的判斷依據——
  // routeIntent() 沒有對話記憶，分不出這種話跟「那合作廠商有哪些」這種合法續問
  // 的差別，一律判成 other。現在多了 currentEventId 提示，other 已經是「連目前
  // 這場都接不上」的結果，才能放心拿來當安靜門檻，不會連續問視窗本身要保護的
  // 案例一起擋掉。
  //
  // 真的被 @ 到時不受影響——跟 1 對 1、跟 handleUnbound() 的 silentOnOther:false
  // 同一個原則，明確叫了機器人就不能不理人。
  if (!mentioned && routed.intent === 'other') return;

  let answerEvent = event;
  let switchNotice = '';
  if (routed.intent === 'qa' && routed.confidence === 'high' &&
      routed.event_ids.length === 1 && routed.event_ids[0] !== event.id) {
    const target = await getEventById(routed.event_ids[0]);
    if (isUsable(target)) {
      await upsertBinding(groupId, target.id, '');
      answerEvent = target;
      switchNotice = `🔄 已切換到《${target.name}》：\n`;
    }
  }

  await answerQuestion(replyToken, groupId, answerEvent, '（群組提問）', text, { loading: false, switchNotice });
  await touchGroupSession(groupId);
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

  const replyToken = ev.replyToken;
  if (!replyToken) return;

  // 群組／多人聊天：被 @ 到才回答（見 handleGroupEvent() 開頭的說明），跟下面
  // 1 對 1 的流程分開走，不共用職員模式／#代碼綁定那一段。
  if (ev.source?.type !== 'user') {
    await handleGroupEvent(replyToken, ev);
    return;
  }

  const userId = ev.source?.userId;
  if (!userId) return;

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
    await applyStaffMenu(userId); // 下方選單換成職員版
    console.log(`[line] 新職員登入 user=${userId} name=${displayName || '(無)'}`);
    await replyOrPush(replyToken, userId,
      `職員模式已啟用${displayName ? `，${displayName} 您好` : ''}！\n\n下方選單已換成職員版，也可以直接用講的。\n\n您的 LINE ID：${userId}\n（想在「有新的人用密語登入」時收到通知，把這組 ID 設成 LINE_ADMIN_USER_ID 環境變數即可）`,
      STAFF_QUICK_REPLIES);
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

  // 全域邀訪窗口的主題按鈕／自由輸入（見 handleContactTopicMessage() 的說明）——
  // 跟 metaIntent 同一優先順序，命中就直接處理，不會被送進當前綁定活動的問答。
  if (await handleContactTopicMessage(replyToken, userId, text)) return;

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
      // ⚠️ 這是純粹「選台」，不是問題——不能走 answerQuestion()。之前這裡直接把
      // 「某某記者會」這句話當成問題送進 Anthropic、寫進 qa_log，後台的「累積回答
      // 題數」跟「今日問答」就被按活動清單按鈕的動作灌水，跟記者真的發問混在一起，
      // report.html 給長官看的數字失真。改成單純回一句換場確認，不呼叫 AI、不寫
      // qa_log——跟 #代碼綁定拿到的「已為您接上」同一種純確認訊息。
      await replyOrPush(replyToken, userId, `已為您換到《${target.name}》✅ 請直接問問題即可。`);
      // ⚠️ 實際回報的坑：換場這條路一直都不會問媒體名稱——不管換過去之前有沒有
      // 被問過。原本只有「掃 QR／#代碼」跟「自然語言軟綁定」兩條路會問，這位記者
      // 從頭到尾都是靠打活動名稱換場，於是永遠沒被問過，後台分析永遠看到
      // 「（未填寫）」。補問邏輯跟 handleUnbound() 的軟綁定分支同一套：只在「這個人
      // 從沒被問過」才問（media_name 已有值就不重問），而且用 push 補問，不擋住
      // 剛剛送出的換場確認。
      if (!binding.media_name) {
        await setBindingNote(userId, 'ask_name');
        await pushMessage(userId, '對了，方便留個貴媒體的名稱嗎？（打名稱即可，或回「略過」——之後就不會再問了）');
      }
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
      // 這裡就是記者準備開始問問題的第一個時間點，順手把快速提問按鈕帶上——
      // 不用等他問完第一題、answerQuestion() 自己送出來的答案才第一次看到。
      await replyOrPush(replyToken, userId, '已記錄，謝謝！請直接輸入您的問題即可。', eventQuickChips(event));
      return;
    }
    // 不像名稱、比較像直接問問題 → 不回「已記錄」，直接當問題往下走，
    // 記者不會因為系統誤判而被迫多問一次。
  }

  // 綁定不再是鎖，是預設值：每則問題都用同一支 routeIntent()（跟未綁定時
  // handleUnbound() 用的是同一套）檢查一次「這其實是在問別場」——回報的意見：
  // 換一場活動，記者就再也問不到其他場。matchEventByName() 只認得出「整句就是
  // 活動名稱」的選台動作，一句夾著別場線索的完整問題（多半帶著問號）認不出來，
  // 前面才會掉到這裡。
  //
  // 只有 confidence high、剛好指到一場、而且不是目前這場，才自動換；其餘一律
  // 留在原場繼續回答——寧可誤判成「留在原場」也不要誤判成「換去別場」，換錯場
  // 比換不了場更糟：記者不會發現答案其實來自另一場，還可能直接截圖引用
  // （同一種風險見 LINE-PLAN.md 坑 6）。currentEventId 帶目前這場給 routeIntent()，
  // 讓它分得出「延續這場的討論」跟「真的指向別場」（見 lib/router.js 的說明），
  // 減少沒有明確線索時被誤判成 other、進而誤觸換場判斷的機會。
  const routed = await routeIntent(text, buildCalendarCards(await getAllEventRows()), { currentEventId: event.id });
  let answerEvent = event;
  let switchNotice = '';
  if (routed.intent === 'qa' && routed.confidence === 'high' &&
      routed.event_ids.length === 1 && routed.event_ids[0] !== event.id) {
    const target = await getEventById(routed.event_ids[0]);
    if (isUsable(target)) {
      console.log(`[line] 問答中自動換場 ${event.id} → ${target.id} user=${userId} q="${text.slice(0, 40)}"`);
      await upsertBinding(userId, target.id, '');
      answerEvent = target;
      switchNotice = `🔄 已切換到《${target.name}》：\n`;
    }
  }

  await answerQuestion(replyToken, userId, answerEvent, binding.media_name, text, { switchNotice });
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
