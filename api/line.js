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

import { AsyncLocalStorage } from 'async_hooks';
import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';
import { toTraditionalTW } from '../lib/zh-tw.js';
import { buildSystemPrompt, resolveEventContent, formatEventBasics } from '../lib/prompt.js';
import {
  readRawBody, verifySignature, replyOrPush as replyOrPushRaw, replyOrPushMessages, startLoading, pushImages,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, listRichMenus, deleteRichMenu,
  linkRichMenuToUser, unlinkRichMenuFromUser,
  isBotMentioned, stripMentionText, pushMessage
} from '../lib/line.js';
import { buildCalendarCards, buildAllCalendarCards, routeIntent, formatCalendarReply, calendarQuickReplyItems } from '../lib/router.js';
import {
  detectMetaIntent, detectCourtesy, isOrgWideNewsAsk, matchEventByName, HELP_TEXT, ORG_INTRO_TEXT, buildWelcomeFlex,
  buildRichMenuDefinition, ALL_MENUS, REPORTER_MENU, STAFF_MENU, findEventMentioned
} from '../lib/menu.js';
import {
  isPasscodeMatch, isStaffAuthenticated, authenticateStaff, routeStaffIntent,
  createDraftEvent, editLink, trainingLink, ensureEventEditCode, getEventRawById,
  getEventAnalyticsSummary, formatEventAnalyticsReply, getGeoStatusSummary, getGeoTrendSeries,
  isExitStaffCommand, revokeStaff, listActiveStaffIds, getStaffPending, setStaffPending,
  isCancelReply, staffPickList, dateWithWeekday, todayTaipei, getEventStats,
  getStaffPendingData, getStaffName
} from '../lib/staff.js';
import { proposeChange, applyChange, findLastChangeBy, fieldLabel, displayValue, appendEventPhotos } from '../lib/event-edit.js';
import { saveEventPhoto } from '../lib/photo-upload.js';
import { addPhoto, pendingPhotos, consumePhotos } from '../lib/photo-inbox.js';
import { isPreEventMode } from '../lib/prompt.js';
import {
  eventChecklist, formatProgressOverview, buildEventCardFlex, formatEventCardText,
  formatNudgeMessage, previewLink
} from '../lib/event-status.js';
import { buildGeoBriefFlex, formatGeoBriefText } from '../lib/geo-brief.js';
import {
  getMemories, addMemory, setMemoryStatus, parseMemoryCommand,
  formatFactBlock, formatStyleRules, formatMemoryList,
  ON as MEM_ON, PENDING as MEM_PENDING, OFF as MEM_OFF, MEMORY_MAX_ACTIVE
} from '../lib/bot-memory.js';
import {
  CONTACTS_DIR_RANGE, GLOBAL_CONTACT_TOPICS, ensureContactsDirectorySheet,
  parseContactsDirectory, formatGlobalContact, matchGlobalContactByText
} from '../lib/contacts-directory.js';
import {
  fetchIndustryTrendDigest, formatDigestForPrompt, extractSourceIndices, resolveSourceUrls
} from '../lib/industry-trends.js';
import { fetchItriNews, formatNewsForPrompt, stripTechQueryFiller } from '../lib/itri-news.js';
import { selectRelatedEvents, formatRelatedEventsBlock } from '../lib/related-events.js';

const EVENTS_RANGE = 'events!A2:R'; // P 欄是 contacts（邀訪窗口分工），Q 欄是 invite_letter（媒體邀請函），R 欄是 invite_letter_chips（活動前快速提問），見 rowToEvent()
// line_user_id | event_id | media_name | bound_at | last_active | note | group_session_until | last_topic
// G 欄只有群組會用到（1 對 1 每則訊息本來就都是對我們講的，不需要這個概念），見
// getGroupSessionUntil()／touchGroupSession() 的說明。
// H 欄是「上一則剛回答完的是哪一類非活動題」，1 對 1 與群組都會用到，見
// getRecentTopic()／setRecentTopic() 的說明。
const LINE_USERS_RANGE = 'line_users!A2:I'; // I 欄是 last_turn（上一輪對話記憶），見 getRecentTurn()
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
// 職員從 LINE 寫進 events 表之後要清掉（批次 76）：不清的話，剛建好的活動在同一個
// instance 上最多 60 秒查不到——清單上沒有、問「哪一場」的按鈕也沒有。
function invalidateEventsCache() { eventsCache = { rows: null, expiry: 0 }; }
function rowToEvent(row) {
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active', event_date: row[5] || '',
    chips: row[6] || '', images: row[7] || '', organizer: row[9] || '工研院',
    // L／M 欄（時間、地點）批次 72 之前沒讀——後台填了，答題的模型卻從來看不到，
    // 記者問「幾點開始／在哪裡」只能拿到「這部分我沒有資料」。見 lib/prompt.js formatEventBasics()。
    event_time: row[11] || '', venue: row[12] || '',
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
// 綁定的活動 id，**不看 6 小時 TTL**——跟 getStoredMediaName() 同一個道理：TTL 過期
// 只代表「不知道現在該問哪一場」，不代表「這個群組從來沒綁過場次」。按鈕辨識要用這支，
// 不能用 getBinding()（見 ownChipEventId() 的 ⚠️，那是實測回報的沉默來源）。
async function getStoredEventId(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  return row ? (row[1] || '') : '';
}

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
    await ensureSheets({ line_users: ['line_user_id', 'event_id', 'media_name', 'bound_at', 'last_active', 'note', 'group_session_until', 'last_topic', 'last_turn'] });
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
// H 欄（話題記憶）與 I 欄（上一輪對話記憶）一併清掉：「回首頁」是記者明確說「這一輪
// 聊完了」，留著上一輪的話題／對話只會讓他回首頁之後打的第一句被接回舊脈絡。
// G 欄（群組續問視窗）要原值寫回、
// 不能跟著清——這支群組也會走到（handleMetaIntent 的 switch 分支帶的是 groupId），
// 清掉等於記者按了「回首頁」就把整個群組的免 @ 視窗一起關掉，那是兩件不相干的事。
async function clearBinding(userId) {
  try {
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === userId);
    if (idx === -1) return;
    await updateRange(`line_users!D${idx + 2}:I${idx + 2}`, [['', String(Date.now()), '', rows[idx][6] || '', '', '']]);
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
// 批次 30 從 5 分鐘拉長到 15 分鐘。5 分鐘是「視窗內任何訊息都會被硬答」那個年代訂的
// ——窗開越久越危險，所以只敢開一下下。批次 28 的 looksAddressedToBot() 守門補上之後，
// 視窗內也只接「看起來真的在跟我們講話」的訊息，窗本身不再是風險來源，就可以放長到
// 真實對話的節奏。實測回報：同事在群組裡按按鈕，距離上一則回覆約 9 分鐘，視窗早就
// 過期，按鈕按了完全沒反應——5 分鐘對「開會中偶爾看一下手機」這種真實使用情境太短。
const GROUP_SESSION_MS = 15 * 60 * 1000;

// ⚠️ 這支要吃 60 秒快取（getAllLineUserRows()），不能像原本那樣直接 readRange()：
// 群組裡「每一則」訊息都會先過這支（handleGroupEvent 開頭就要判斷「沒被 @ 到的話
// 還算不算在跟我們對話」），包含那些我們最後根本不會回的閒聊。直讀等於群組每有人
// 講一句話就燒掉一次 Sheets 讀取配額——那個配額是每分鐘 60 次、整個網站（含記者會
// 現場的問答、qa_log 寫入）共用的，一個熱鬧的群組就足以把現場的額度吃光。
// 讀快取不會讀到過期資料：touchGroupSession() 寫完一定會 invalidateLineUsersCache()，
// 其餘會動到這張表的路徑（upsertBinding／setMediaName／setBindingNote…）也都有，
// 跟 getStoredNote()／getStoredMediaName() 本來就吃快取是同一套規則。
async function getGroupSessionUntil(groupId) {
  try {
    const rows = await getAllLineUserRows();
    const row = rows.find(r => r[0] === groupId);
    return row ? Number(row[6]) || 0 : 0;
  } catch (e) {
    console.error('getGroupSessionUntil 失敗:', e.message);
    return 0; // 查詢失敗就當作沒有活躍中的對話——安全方向是要求重新 @，不是誤觸插話
  }
}

// ── 話題記憶：上一則剛回答完的是哪一類「跟活動無關」的問題（H 欄）──────────
// 實際回報（附截圖）：記者問產業趨勢，拿到 IEK 免費焦點的摘要，答案結尾還主動寫著
// 「如果您對清單裡的其他產業趨勢感興趣，或有更具體的技術領域（如衛星通訊、太空
// 科技等），歡迎再提問」——記者照著打了「太空」兩個字，收到的卻是「嗯～我沒抓到
// 您想問哪一場活動耶 🤔」。他從頭到尾沒有在問活動，這句兜底本身就是答非所問，而且
// 是我們自己邀請他再問一次的。
//
// 根因：answerIndustryTrend()／answerTechQuery() 答完什麼狀態都不留。下一則訊息
// 進 routeIntent() 時，那支只拿得到「目前綁定哪一場活動」（currentEventId），完全
// 不知道「上一則剛聊完產業趨勢」——「太空」是個沒有任何活動線索的裸名詞，判成
// other 完全合理，錯的是沒有人記得上一句在聊什麼（跟 lib/staff.js 那個「追問哪一場」
// 的坑是同一種病）。
//
// ⚠️ 存 Sheets 而不是行程內的 Map：這個記憶要跨「兩則 webhook 請求」才有意義，
// 而 Vercel 的 Function 執行個體隨時可能因為閒置被回收——記者讀完一段五行的回答再
// 打字，中間隔個十幾秒到一兩分鐘很正常，剛好撞到冷啟動就整個失憶，那這個修法對
// 真正會發生的情境等於沒修。多出來的成本只有「答完趨勢／技術題時多寫一格」，這兩條
// 路本來就不是熱路徑（不像每則活動問答都會走的 answerQuestion()）；讀取則完全免費，
// 走的是 getBinding() 早就載入好的那份 60 秒快取。
//
// 格式 `industry_trend@1730000000000`：值跟時間戳存在同一格，不再多開一欄——H 欄
// 是這次新增的欄位，舊的 line_users 分頁不會自動長出表頭（ensureSheets 只補「整個
// 分頁不存在」的情況），能少開一欄就少一欄要解釋的空白表頭。
const TOPIC_TTL_MS = 10 * 60 * 1000; // 10 分鐘：夠讀完一段回答、想一下、再打一個追問的詞
const VALID_TOPICS = ['industry_trend', 'tech_query'];

async function getRecentTopic(targetId) {
  try {
    const rows = await getAllLineUserRows();
    const raw = rows.find(r => r[0] === targetId)?.[7] || '';
    const [topic, ts] = String(raw).split('@');
    if (!VALID_TOPICS.includes(topic)) return '';
    return Date.now() - (Number(ts) || 0) > TOPIC_TTL_MS ? '' : topic;
  } catch (e) {
    console.error('getRecentTopic 失敗:', e.message);
    return ''; // 讀不到就當作沒有話題記憶，退回原本的行為，不要讓這個加分功能擋住主流程
  }
}

// 沒有 line_users 列時要能新增一列（記者可能從沒綁定過任何活動就直接問產業趨勢），
// 理由與寫法比照 setContactPending()——只是寫的是 H 欄。整支包在 try 裡：話題記憶
// 是體驗加分，寫失敗不能連累記者剛剛問的那題（答案在呼叫這支之前就已經送出去了）。
//
// question／answer（批次 58）：連「這一輪實際問了什麼、答了什麼」一起記進 I 欄。
// H 欄的分類標籤只解決得了「裸名詞追問」——批次 24 當時假設記者的追問長得像「太空」
// 這種光禿禿的詞，回報的新截圖打破了它：記者打的是「有談機器人發展的嗎」，一句完整
// 問句，路由只拿得到「上一則在聊趨勢」這個標籤，沒有任何依據判斷「機器人」指的是
// 剛剛那則人型機器人的摘要，於是被「目前綁定哪一場」拉走，回了那場的議程表。
// 記下答案節錄之後，路由的判斷就從「猜這句話的語氣」變成「比對這句話問的東西在不在
// 我剛剛的答案裡」（見 lib/router.js recentAnswerHint()）。
//
// ⚠️ 借用 I 欄（last_turn）而不是再開一欄 J：那一欄本來就是「上一輪對話」，趨勢題
// 答完之後，上一輪本來就是這一題，不是更早以前那場活動的問答。e 欄位填
// `#topic:產業趨勢` 這種前綴（TOPIC_TURN_MARK），永遠不會等於任何真實的活動 id——
// buildTurnHistory() 比對的是「上一輪答的是不是同一場」，比不中就不回放，所以這些
// 列絕對不會被當成某一場活動的脈絡餵進問答（那正是 getRecentTurn() 開頭第三個 ⚠️
// 在防的事）。
//
// ⚠️ H、I 兩格一起寫（一次 updateRange，不是兩次）。沒有 answer 時 I 欄照樣寫成
// 空字串、不是跳過：這支被呼叫就代表「上一輪是一題趨勢／技術題」，把更早以前那場
// 活動的問答留在 I 欄才是錯的——那份脈絡已經過期了。
const TOPIC_TURN_MARK = '#topic:';

async function setRecentTopic(targetId, topic, { question = '', answer = '' } = {}) {
  try {
    await ensureLineUsersSheet();
    const value = topic ? `${topic}@${Date.now()}` : '';
    const turn = topic && answer
      ? JSON.stringify({
          t: Date.now(), e: TOPIC_TURN_MARK + topic,
          q: sanitize(question, TURN_Q_MAX), a: sanitize(answer, TURN_A_MAX)
        })
      : '';
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === targetId);
    if (idx === -1) {
      if (!value) return; // 沒有列可清，本來就沒有話題記憶
      await appendRows('line_users!A:I', [[targetId, '', '', '', String(Date.now()), '', '', value, turn]]);
    } else {
      await updateRange(`line_users!H${idx + 2}:I${idx + 2}`, [[value, turn]]);
    }
  } catch (e) {
    console.error('setRecentTopic 失敗:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// 上一則趨勢／技術題實際答出去的內容（節錄），給 routeIntent() 當比對依據用。
// 只在「I 欄記的那一輪真的屬於這個話題」時才回傳——中間要是又問了一題活動問答，
// I 欄早就被 setRecentTurn() 換成那場的內容，那份脈絡不該拿來判趨勢追問。
//
// 讀的是 getAllLineUserRows() 那份 60 秒快取（跟 getRecentTopic() 同一份），
// 兩支一起呼叫也只打一次 Sheets。
async function getRecentTopicAnswer(targetId, topic) {
  if (!topic) return '';
  const turn = await getRecentTurn(targetId);
  return turn && turn.event_id === TOPIC_TURN_MARK + topic ? turn.a : '';
}

// routeIntent() 的兩個話題參數一次備齊——三個呼叫端（未綁定、1 對 1 綁定中、群組）
// 都要同一組東西，分開寫三次遲早會有人只補其中一個。
async function recentTopicContext(targetId) {
  const currentTopic = await getRecentTopic(targetId);
  return { currentTopic, recentTopicAnswer: await getRecentTopicAnswer(targetId, currentTopic) };
}

// ── 上一輪對話記憶（I 欄，批次 28）────────────────────────────────────────
// 回報的意見：「對答要更如真人般」。人味最大的缺口不是語氣，是**這個帳號完全沒有
// 對話記憶**——askAnthropic() 每次只送一則 user message，前面問過什麼、我們答過
// 什麼，模型一個字都看不到。實際後果就是最不像人的那種對話：
//   記者：這項技術預計何時商業化？   → 米亞：預計 2027 年進入試量產⋯⋯
//   記者：那成本呢？                 → 米亞：（完全不知道「那」是指什麼）
// 批次 26 的話題記憶（H 欄）只記「上一則是哪一類問題」，解決的是「路由判不判得出
// 意圖」；這一欄記的是「上一輪實際講了什麼」，解決的是「答得出不出續問」，兩件事。
//
// ⚠️ 只記「一輪」（上一問＋上一答），不是完整對話串。理由是這個帳號的答案會被記者
// 直接截圖引用：對話帶得越長，模型把好幾輪前的內容混進這一題答案的機會就越大，而
// 那種錯誤在官方帳號上是最貴的（LINE-PLAN.md 坑 6 是同一種顧慮）。一輪就足以接住
// 「那ＸＸ呢」這種真正常見的省略式續問。
//
// ⚠️ 一併記下這一輪是「哪一場活動」的答案（e 欄位），只有下一題還在問同一場時才
// 回放。換場之後回放上一場的問答，等於把另一場的內容當成這一場的脈絡餵給模型，
// 那正是換錯場那種「記者不會發現答案來自別場」的風險。
//
// ⚠️ 群組刻意不開這個記憶（呼叫端傳 memory:false）——群組裡多個人交錯提問，
// 「上一輪」很可能是別人的問題，把它當成這個人的脈絡回放進去，製造出來的正是這次
// 要修的「答非所問」。1 對 1 才有「上一輪就是同一個人講的」這個前提。
//
// 存 Sheets 而不是行程內的 Map，理由跟 getRecentTopic() 完全一樣（Vercel 執行個體
// 隨時可能被回收，記者讀完答案再打字中間隔幾十秒很正常）。格式用 JSON 存一格：
// 內容是記者的原話與 AI 的回答，任何自訂分隔符都可能剛好出現在裡面。
const TURN_TTL_MS = 10 * 60 * 1000; // 跟話題記憶同一個尺度：夠讀完一段回答再打一句追問
const TURN_Q_MAX = 200;   // 記者的問題通常很短，200 字綽綽有餘
const TURN_A_MAX = 700;   // 答案只留開頭：續問要的是「剛剛在講什麼」，不是完整重述

async function getRecentTurn(targetId) {
  try {
    const rows = await getAllLineUserRows();
    const raw = rows.find(r => r[0] === targetId)?.[8] || '';
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t || !t.q || !t.a) return null;
    if (Date.now() - (Number(t.t) || 0) > TURN_TTL_MS) return null;
    return { q: String(t.q), a: String(t.a), event_id: String(t.e || '') };
  } catch (e) {
    // 解析失敗（舊資料、手動改過的儲存格）就當作沒有記憶，退回單則問答的舊行為——
    // 這是體驗加分，不能因為一格壞資料就讓記者問不到東西。
    return null;
  }
}

async function setRecentTurn(targetId, eventId, question, answer) {
  try {
    await ensureLineUsersSheet();
    const value = JSON.stringify({
      t: Date.now(), e: String(eventId || ''),
      q: sanitize(question, TURN_Q_MAX), a: sanitize(answer, TURN_A_MAX)
    });
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === targetId);
    if (idx === -1) return; // 沒有列就算了：走到這裡一定已經有綁定，理論上列一定在
    await updateRange(`line_users!I${idx + 2}`, [[value]]);
  } catch (e) {
    console.error('setRecentTurn 失敗:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// 把上一輪組成 Anthropic messages 陣列的前兩則（user／assistant）。只在「上一輪答的
// 就是這一場」時才回放，理由見上面第三個 ⚠️。
async function buildTurnHistory(targetId, eventId) {
  const turn = await getRecentTurn(targetId);
  if (!turn || turn.event_id !== String(eventId || '')) return [];
  return [{ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a }];
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
// 「我是聯合報記者」「TVBS 林記者」→ 只留媒體名稱本身；抽不出來就原樣留。
function mediaNameOf(text) {
  const s = String(text || '').trim()
    .replace(/^(你好|您好|哈囉|嗨)?[，,\s]*(我是|我們是|這邊是|這裡是)\s*/, '')
    .replace(/\s*(的)?(記者|編輯|攝影|主播|製作人|特派員)[\u4e00-\u9fff]{0,3}$/, '')
    .replace(/\s+[\u4e00-\u9fff]$/, '') // 「TVBS 林記者」拿掉記者後剩的姓
    .trim();
  return s || String(text || '').trim();
}

function looksLikeNameOrSkip(text) {
  if (/^(略過|skip|跳過)$/i.test(text)) return true;
  if (text.length > 20) return false;
  if (/[?？]/.test(text)) return false;
  if (/^(請問|為什麼|什麼|怎麼|哪裡|哪一|何時|多少|是否|能不能|可以|會不會|有沒有|給我|請給|麻煩|幫我|提供|傳給我|傳送|寄送|附上|想問|想要|需要|來一份|給一份)/.test(text)) return false;
  // 批次 75（四角色模擬）：記者沒理會「方便留個媒體名稱嗎」，直接打「這場的重點是什麼」
  // 或按了活動清單的按鈕（送出的是完整活動名稱）——舊規則只看開頭詞跟問號，這兩句都被
  // 存成媒體名稱、回「已記錄，謝謝」，問題本身就這樣消失了。媒體名稱裡不會出現句中的
  // 疑問詞，也不會出現「這場」「記者會」「發表會」這種指活動的字。
  if (/(嗎|呢|什麼|甚麼|幾點|幾號|幾時|哪|怎麼|如何|為何|是否|多少|重點|這場|這次|本場|活動|記者會|發表會|研討會|論壇|說明會)/.test(text)) return false;
  return true;
}

// 判斷這句問題是不是在要照片——命中就在文字答案之後追加真正的圖片訊息（不是塞
// 進同一則，見 answerQuestion() 跟 lib/line.js pushImages() 的註解）。誤判的兩種
// 結果都沒有使用者感受得到的壞處：多附幾張用不到的照片，或沒附但文字答案裡本來
// 就有網址可以點開，所以用關鍵字比對就夠，不必為此多打一次 AI。
function looksLikePhotoRequest(text) {
  return /(照片|圖片|相片|圖檔|新聞照|相關圖|image|photo)/i.test(text);
}

// 收到非文字訊息時要講的話（批次 28）。原本兩邊都是同一句「目前僅支援文字訊息提問，
// 請直接輸入您的問題。」——意思沒錯，但那是系統公告的口氣，不是米亞會講的話，而且
// 對貼圖、對照片講同一句也顯得沒在看對方傳了什麼。回報的意見是「對答要更如真人般」，
// 這種一眼就看得出是罐頭訊息的地方最傷。
//
// ⚠️ 只換語氣，能力沒有變：我們仍然讀不到圖片與貼圖的內容，這幾句話都沒有暗示
// 讀得到，也沒有承諾之後會處理——講清楚「我看不到」再給下一步，比含糊帶過誠實。
function nonTextReply(messageType) {
  if (messageType === 'sticker') return '收到您的貼圖了 🙂 不過我只看得懂文字，想問什麼直接打給我就可以～';
  if (messageType === 'image') return '這張圖我這邊看不到內容耶 🙂 如果是想問某一場活動或某項技術，直接把問題打成文字給我，我再幫您查。';
  // 批次 75：電視台記者在車上最常直接傳語音。聽不到是事實，但可以教一個馬上能用的替代：
  // 手機鍵盤上的麥克風（語音輸入）講完會直接變成文字，不必真的用打的。
  if (messageType === 'audio') return '語音訊息我這邊聽不到 🙏 不方便打字的話，可以按手機鍵盤上的麥克風（語音輸入）直接講，會自動變成文字送出，我就能馬上幫您查 🙂';
  if (messageType === 'video') return '影片我這邊看不了，麻煩直接把想問的打成文字給我（或用鍵盤上的麥克風講），我馬上幫您查 🙂';
  if (messageType === 'file') return '檔案我這邊打不開耶 🙂 想問的內容直接打成文字給我就可以。';
  if (messageType === 'location') return '收到您傳的位置了，不過我這邊只處理文字提問 🙂 想找某一場活動或採訪窗口，直接打字問我就可以。';
  return '我這邊只看得懂文字訊息 🙂 想問什麼直接打給我就可以。';
}

function lineExtraRules(event) {
  const contactHint = event.press_contact
    ? `寧可說「這部分我沒有資料，建議洽新聞聯絡人 ${event.press_contact}」`
    : '寧可說「這部分我沒有資料，建議洽現場新聞聯絡人」';
  return [
    '這是 LINE 對話，請控制在 5 行以內；記者要求完整新聞稿時才給全文，並提醒可到活動網頁下載。',
    // ⚠️ 這條原本寫成「需要附連結時⋯⋯不要用 Markdown」，範圍只有連結——實際回報的
    // 截圖裡模型拿它去加粗人名（`**徐喬涵**`），星號原封不動印在記者畫面上。範圍要
    // 涵蓋整則回覆，而且把最常見的幾種語法直接點名，不要只講「Markdown」這個詞。
    '整則回覆都不要使用任何 Markdown 語法——LINE 不會渲染，記者會直接看到符號本身。不要用 **粗體**、*斜體*、`程式碼`、# 標題、- 項目符號、[文字](網址) 這種連結寫法，也不要用 --- 當分隔線。需要強調就直接寫出來，需要附連結就把網址原樣貼上，需要條列就用「・」開頭。',
    `你的回覆會出現在掛著主辦單位名義的官方帳號裡，記者可能直接截圖引用。任何不確定的內容，${contactHint}。`,
    // ── 查無資料時的機器可讀標記（批次 31）─────────────────────────────
    // 實際回報（附截圖）：記者在群組問「今年院士有誰」，機器人照實說「我這邊目前沒有
    // 得獎名單的資料」——答得沒錯，但**工研院官網新聞中心第一筆就是那篇授證新聞**。
    // 根因是路由：routeIntent() 判 tech_query 要求問句裡明確出現「工研院」（批次 21
    // 為了避免誤觸刻意訂的），「今年院士有誰」沒提到，加上當時綁著一場活動，就被判成
    // qa、只拿那場的知識庫回答。我們手上另一個有答案的來源從頭到尾沒被問過。
    //
    // 與其放寬路由（那會讓「這場的重點是什麼」這種正常提問也被送去官網，換來更糟的
    // 誤判），不如在「已經確定這場答不出來」之後才去補查一次——只在真的失敗時才多花
    // 一次查詢，正常提問一個字節都沒變慢。
    //
    // 用標記而不是事後用正則去猜「這句話是不是在說沒有資料」：模型每次的措辭都不一樣
    // （這次是「我這邊目前沒有得獎名單的資料」，不是規則裡寫的那句），猜錯的兩個方向
    // 都很糟。這招跟產業趨勢／技術問答的「來源編號：」是同一個既有作法。
    // ⚠️ 措辭刻意**不**寫「放在整則回覆的最後」——結尾那條警語規則已經佔住「最後一行」，
    // 兩條規則搶同一個位置的結果就是批次 33 那個回報（標記被擠到警語前面）。程式端改成
    // 「整段任何位置都抓得掉」之後，這裡也不必再指定位置，只要求「自己獨立一行」。
    // ⚠️ 判準刻意是「記者問的**那一項**，你有沒有給出來」，不是「背景資料有沒有相關內容」。
    // 批次 34 的回報：記者問「今年院士有誰」，回覆開頭就說「這部分我沒有資料」，但接著
    // 提供了旁邊的相關資訊（出席的 38 國代表、獲頒經濟部專業獎章的人）——第一版寫成
    // 「背景資料裡**完全沒有**可以回答這一題的內容」，模型很可能判斷成「我有部分答到」
    // 而不加標記，於是補查那條路又沒跑。記者要的是院士名單，旁邊的資訊再多也不是那個。
    '判斷你「答不答得出這一題」時，看的是記者問的**那一項具體內容**你有沒有真的給出來，不是背景資料裡有沒有沾邊的東西。只要你這則回覆裡出現「這部分我沒有資料」「背景資料中沒有提到ＸＸ」這類說法——**即使你同時提供了其他相關或鄰近的資訊、即使你已經給了聯絡人**——都要加上標記。請在回覆中另起獨立的一行，只放這個格式的標記：[[NO_DATA:關鍵詞]]，關鍵詞是記者這題真正想問、而你答不出來的那個主題，2-6 個字的名詞（例如問「今年院士有誰」就填「院士」，問「得獎名單」就填「得獎名單」），不要填整句問句、不要填「沒有資料」這種描述。這行是給程式判讀用的、不會顯示給記者，放在哪一行都可以，不算進上面的行數限制；只有當你真的把記者問的那一項答出來時，才完全不要加這一行。',
    // 米亞人設（批次 28）。回報的意見：「對答要更如真人般、符合人設」。
    // ⚠️ 這條走的是 extraRules 這個「頻道專屬規則」的管道，只有 LINE 會拿到——
    // 網頁版 api/chat.js 呼叫的是不帶 extraRules 的 buildSystemPrompt(event)，
    // 輸出逐 byte 不變（見 lib/prompt.js 開頭的 ⚠️），語氣不受影響。
    // 之前這條只套在產業趨勢／工研院技術兩支，偏偏「活動問答」才是記者用最多的
    // 那一條路，等於人設只活在比較少人走到的支線上，兩邊語氣對不起來。
    TONE_RULE
  ];
}

// 米亞的語氣規則。使用者的要求是「對答更有人味、符合人設」——人設名字「米亞」原本
// 只出現在歡迎圖卡與使用說明（見 lib/menu.js），真正在對話的產業趨勢／工研院技術
// 兩支問答反而是「你是負責回答ＸＸ問題的助理」這種公文語氣，兩邊對不起來。
//
// ⚠️ 這條只調語氣，不放寬任何一條「只能照資料回答」的規則，而且刻意寫成「親切但
// 精準」而不是單純「可愛一點」：這個帳號的回答掛著主辦單位名義、記者可能直接截圖
// 引用（見 lineExtraRules() 同一個顧慮），語氣軟化不能連帶讓「我沒有這項資料」變得
// 含糊——講不知道的時候要更清楚、更快給出下一步，不是更委婉。
//
// 活動問答（answerQuestion → lib/prompt.js buildSystemPrompt）批次 28 起也套這條，
// 但是走 lineExtraRules() 那個「頻道專屬規則」的管道，不是去改 buildSystemPrompt()
// 本身——網頁版呼叫的是不帶 extraRules 的版本，輸出逐 byte 不變（見 lib/prompt.js
// 開頭的 ⚠️），網頁版記者看到的語氣完全不受影響。
// 曾經因為「動不了那份共用 prompt」而整條跳過，結果是人設只活在產業趨勢／工研院
// 技術兩支支線上，記者用最多的活動問答反而還是公文語氣。
const TONE_RULE = '語氣：你是「米亞」，講話像一位熟悉這些題目、講話簡潔的公關同事，不是查詢系統。用「我」自稱，可以用一兩個口語的連接詞（例如「這題」「目前看到的是」），最多一個表情符號，不要每句都加。不要用「根據您的提問」「經查詢」「以下為您說明」這種公文開場。條列該用就用（見版面規則），但不要把每一句話都拆成一項，也不要一次列十幾項把記者淹沒——列最相關的幾項，其餘讓記者自己再問。查不到、沒有資料的時候，直接、明確地說沒有，再給下一步該怎麼問——不要道歉三次，也不要用模糊的說法混過去。';

// history：選填的上一輪對話（[{role:'user'},{role:'assistant'}]，見 buildTurnHistory()）。
// 沒帶就是原本「每次只送一則」的行為，所有既有呼叫端都不受影響。
// ── LINE 不會渲染 Markdown（批次 32）──────────────────────────────────────
// 實際回報（附截圖）：記者收到的聯絡人那行長這樣——「**徐喬涵** | 03-5915128」，
// 星號原封不動印在畫面上；分隔線也是三個裸露的 `---`。
//
// lineExtraRules() 早就有一條「不要用 Markdown」，但它寫成「需要附連結時⋯⋯」，
// 範圍只涵蓋連結，模型拿它去加粗人名時完全不覺得違規。規則本身要放寬到整則回覆
// （見那條規則），但**規則是請求、不是保證**：同一個模型下一次還是可能加粗。
//
// 這支是程式面的最後一道防線，放在 askAnthropic() 的出口——四條問答路線（活動、
// 產業趨勢、工研院技術、智慧兜底）全部經過這裡，寫一次四邊都受惠，不必每個呼叫端
// 各自記得清一次。
//
// ⚠️ 只拆掉「LINE 顯示不出來的語法符號」，不改動任何文字內容：粗體只拿掉星號、
// 連結攤成「文字 網址」（網址要留著，記者要點）、項目符號換成 LINE 上讀得順的「・」。
// 這是格式清理，不是重寫答案——答案的內容一個字都不能動（同 lineExtraRules() 的
// 顧慮：這則回覆掛的是主辦單位名義）。
// ⚠️ 我們自己接在答案後面的區塊用的是全形破折號「———」（U+2014），不在下面水平線
// 規則的 [-*_] 裡，不會被誤刪。
// ── 簡體字防線（批次 45）─────────────────────────────────────────────────
// 回報的截圖：一整則回覆都是繁體，只有最後那句警語跑出簡體——
// 「内容仅供参考，以工研院官网新闻稿或发言为准。」
//
// 兩層一起做，跟 Markdown 那次同一個結構：
//   ① prompt 加一條明確規則（見 askAnthropic() 的 ZH_TW_RULE）
//   ② **出口再轉一次**——規則是請求、不是保證。這一層才是真正的保證。
//
// 轉換表與函式本體現在住在 lib/zh-tw.js——媒體訓練的語音轉寫是第二個出口，也要用
// 同一份表，與其兩邊各維護一份（遲早長歪），不如搬出去共用。這裡照樣 re-export，
// 外面既有的 `import { toTraditionalTW } from '../api/line.js'` 一行都不用改。
export { toTraditionalTW };

export function stripMarkdownForLine(input) {
  return String(input || '')
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1')                 // 圍欄程式碼區塊
    .replace(/`([^`\n]+)`/g, '$1')                                      // 行內程式碼
    .replace(/!?\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g,                  // [文字](網址)／圖片
             (_m, label, url) => (label ? `${label} ${url}` : url))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')                   // **粗體** __粗體__
    .replace(/(^|[\s(（「【])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s)）」】,，.。、!！?？:：;；])/g, '$1$2') // *斜體*
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                                // # 標題
    .replace(/^\s{0,3}>\s?/gm, '')                                     // > 引用
    .replace(/^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '')            // --- *** ___ 水平線
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1・')                          // - 項目符號
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 版面的機械修整（批次 59）────────────────────────────────────────────────
// LAYOUT_RULE 是請求，這支是那一半「就算模型沒照做也一定成立」的保證——但**只做
// 零風險的事**。判斷哪些事零風險的標準很嚴：這支只**加空行、刪行尾空白**，永遠不
// 切開、不搬動、不刪除任何一個字。
//
// ⚠️ 刻意**不**做的一件事，值得寫下來免得下一個人「順手補上」：把同一行裡的多個
// 「・」拆成多行。看起來是這支最該做的事，實際上會切壞人名——「・」是日文中黑點
// （U+30FB），中文譯名本來就用它當分隔（「史蒂夫・賈伯斯」「馬丁・路德・金恩」），
// 拆行就變成兩個人。而記者會直接截圖引用這則回覆，把人名切成兩半的代價，遠高於
// 「條列擠在同一行」這個純粹難看的問題。真要修那個形狀，該修的是 prompt。
//
// ⚠️ 縮排續行（LAYOUT_RULE ③ 的「說明另起一行、全形空白開頭」）要認得出來，不然
// 會被當成「條列結束了」而在項目和它自己的說明中間插一個空行，比原本更亂。
const BULLET_RE = /^[ \t　]*・/;
const INDENT_CONT_RE = /^[ \t　]+\S/;

export function tidyLineLayout(input) {
  const lines = String(input || '').split('\n').map(l => l.replace(/[ \t　]+$/, ''));
  const isBullet = l => BULLET_RE.test(l);
  const isCont = l => !isBullet(l) && INDENT_CONT_RE.test(l);
  const out = [];
  for (const cur of lines) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.trim()) {
      // 條列區塊「開始」：前一行還是正文 → 中間空一行
      const starts = isBullet(cur) && !isBullet(prev) && !isCont(prev);
      // 條列區塊「結束」：這一行回到正文（含「來源編號：」那種機器讀的行）→ 空一行
      const ends = cur.trim() && !isBullet(cur) && !isCont(cur) && (isBullet(prev) || isCont(prev));
      if (starts || ends) out.push('');
    }
    out.push(cur);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 答題模型（批次 36）─────────────────────────────────────────────────────
// 回報的意見：「不是給新聞稿，而是會讀懂消化」——記者問「今年院士有誰」，答案就寫在
// 那場的新聞稿裡，它卻說沒有。
//
// 這裡原本用 Haiku 4.5。當初選它是為了成本，而它拿來做「這句話要路由到哪一條路」
// 很稱職——但要它讀完一整篇新聞稿、把埋在段落中間的名單抓出來就明顯吃力，那正是
// 回報的症狀。答題這條路換成 Sonnet 5：閱讀理解好很多，上下文 200K 變成 1M（跨場次
// 資料要塞得下也靠這個），成本約兩倍，但既有的 ephemeral 快取讓重複提問便宜十倍，
// 以記者會的問答量絕對划算。
//
// ⚠️ 路由（lib/router.js routeIntent）刻意不跟著換：那是分類題、每則訊息都要跑，
// Haiku 又快又便宜又夠準，換上去只是白花錢。貴的模型要花在真正需要理解力的地方。
//
// ⚠️ thinking 明確關掉：Sonnet 5 省略這個參數會預設開啟 adaptive thinking，那會讓
// 每則回覆多等好幾秒——LINE 的 reply token 只有 60 秒，記者在等的是聊天速度的回應。
// 讀新聞稿找名單是閱讀題不是推理題，Sonnet 5 不開 thinking 就綽綽有餘。之後若發現
// 答案深度不足，這裡是第一個該調的旋鈕（改成 { type: 'adaptive' }）。
const ANSWER_MODEL = 'claude-sonnet-5';

// extraSystem（批次 36）：選填的第二個 system 區塊，放跨場次的相關資料。
// ⚠️ 刻意不併進第一個區塊：那一塊逐 byte 穩定才吃得到 ephemeral cache，而這一塊
// 因「這一題問了什麼」而異，混進去只會讓每題都重新建快取（跟 lib/router.js
// currentEventId 那段拆成兩塊是完全一樣的理由）。
// 第一層防線：明確要求繁體。整份 prompt 原本從頭到尾沒有任何一條規則講這件事——
// 警語那條只寫「內容等同於⋯⋯」，模型就照自己的習慣重打一次，偶爾打成簡體（回報的
// 截圖就是這樣：整則都是繁體，只有最後那句警語變簡體）。
// ⚠️ 這是「請求」，不是保證；真正的保證是出口的 toTraditionalTW()。兩層都要有：
// 規則讓模型一開始就寫對（大部分情況），出口負責兜住剩下的。
// 放在這支裡而不是各個呼叫端的 prompt：這裡是**所有**模型呼叫的唯一入口，寫一次
// 四條問答路線（活動、產業趨勢、技術查詢、官網補查）與兜底文案全部受惠，不會有人
// 新增一條路線時忘記加。
const ZH_TW_RULE = '用字：一律使用台灣慣用的繁體中文與台灣用語，絕對不可以出現簡體字（包含最後那句警語）。記者用英文或其他語言提問時才跟著改用該語言。';

// ── 版面規則（批次 59）──────────────────────────────────────────────────────
// 回報（附兩張截圖）：「文字排版很亂 能夠精進嗎 整體上」。兩張是不同的壞法：
//   ① 產業趨勢那則把「9/6 人型機器人」與「8/6 CPO」兩篇報告擠進同一段，手機上是
//      十幾個視覺行的一大坨字，記者要自己在裡面找哪句話屬於哪一篇
//   ② 活動問答那則（「演講者有誰」）其實**有**結構——開場暨引言／國際論壇／淨零
//      永續專題…每組一行——但沒有項目符號、組跟組之間沒有空行，一樣糊成一塊
//
// 三個根因，都不是模型不聽話，是規則本身有問題：
//
// **「N 行以內」在手機上不是一個有意義的單位。** 四條路線各自寫著 5 行／4 行／4 行／
// 3 行，而模型把「行」讀成「句」或「段」——截圖 ① 在它眼裡確實是「4 行以內」。手機
// 一行只放得下大約 16 個中文字，「行」這個詞在模型跟畫面之間根本對不起來。
//
// **兩條既有規則互相打架。** lineExtraRules() 說「需要條列就用『・』開頭」，
// TONE_RULE 說「不要用一長串條列把記者淹沒」。模型同時收到「該條列」與「不要條列」，
// 交出來的是最糟的組合：列了一長串、卻不用符號也不換行——截圖 ② 正是這個形狀。
//
// **沒有任何一條規則提過「空行」。** 手機可讀性最關鍵的一件事，四條路線一個字都沒寫。
//
// ⚠️ 這條放在 askAnthropic() 的共用 system 區塊（跟 ZH_TW_RULE 同一個位置），不是
// 各路線各寫一份——活動問答、產業趨勢、工研院技術、官網補查、智慧兜底五條路一次到位，
// 以後新增路線也不會漏掉。這正是批次 53「三個各說各話的字數上限」的教訓：同一件事
// 散在好幾個地方各寫一份，遲早會漂開。
//
// ⚠️ 這是 prompt、不是程式保證，而且刻意如此。CLAUDE.md 第 2 條的判準是「偶爾沒照做
// 會不會出事」——排版難看不會出事，而「怎樣算排得好」要看內容有幾則、每則多長，
// 沒有一條死規則做得到。程式那一半只做**零風險**的機械修整（見 tidyLineLayout()）。
const LAYOUT_RULE = [
  '版面：記者是在手機上看這則訊息，一行只放得下大約 16 個中文字。排得好不好讀，跟內容對不對一樣重要。',
  '① 段落之間一定空一行。不要把整則回覆寫成沒有換行的一大段。',
  '② 只要有兩則以上的資料、兩個以上的項目（多篇報告、多位講者、多個場次、多個時段），一定要條列：每一項用「・」開頭、自己獨立一行，不要用頓號或逗號把它們串在同一句話裡。',
  '③ 條列的每一項如果同時有「標題」和「說明」，標題放在「・」那一行，說明另起一行、開頭用一個全形空白縮排。不要把標題和兩三句說明擠成同一行。',
  '④ 開場那句話和結尾那句話各自獨立成段，跟中間的條列之間空一行，不要黏在第一項或最後一項上。',
  '⑤ 其他規則裡講的「幾行以內」指的是段落或條列項目的數量，不是手機上的視覺行數——不要為了湊行數把好幾件事擠進同一段。'
].join('\n');

// ── 這一次請求還剩多少時間（批次 57）────────────────────────────────────────
// 這支底下每一個 fetch() 原本都沒有 signal，也就是「上游不回應就等到天荒地老」。
// 那在 Vercel 上不是「慢一點」，是**整支被砍掉**：vercel.json 給 api/line.js 的
// maxDuration 是 60 秒，時間到 function 直接消失，沒有 catch 會跑到、沒有回覆會送出，
// 記者那邊就是已讀不回（跟 apologise() 那段是同一種傷害，只是原因不同——那邊是例外，
// 這邊是根本沒機會丟例外）。
//
// 逾時的價值不在「省時間」，在於**把沉默換成一句話**：AbortSignal.timeout() 觸發後
// fetch 會丟 AbortError，catch 就會回一句「目前無法取得回應」，記者至少知道要再問
// 一次或找聯絡人。
//
// ⚠️ 為什麼不是每支各自寫死一個秒數，而是共用一個「這次請求的死線」：這條路上會依序
// 打好幾次外部呼叫（路由 → 答題 → 補查官網最多 4 次 HTTP → 再一次模型），寫死的秒數
// 各自看起來都很合理，加起來卻會超過 60。死線是唯一算得準的東西——每一段都問「還剩
// 多少」，前面慢了後面就自動讓路，不會有人各自超支。
//
// 55 秒不是 60：留 5 秒給送出回覆、寫 qa_log 這些收尾動作。答案算得出來卻沒送出去，
// 跟沒算出來一樣糟（CLAUDE.md 第 4 條的同一個道理）。
//
// ⚠️ 死線存在 AsyncLocalStorage、不是模組層的一個變數：Vercel 的一個執行個體可能同時
// 處理多個請求，用共用變數的話，後到的請求會把先到的那個死線往後推——先到的那個就會
// 以為自己還很寬裕，然後在 60 秒被砍掉，正好是這整段要防的事。AsyncLocalStorage 是
// Node 內建，不違反這個專案「零 npm 依賴」的慣例。
const REQUEST_BUDGET_MS = 55_000;
const requestCtx = new AsyncLocalStorage();
function msLeft() {
  const at = requestCtx.getStore()?.deadlineAt;
  return at ? Math.max(0, at - Date.now()) : REQUEST_BUDGET_MS;
}
// 給某一段外部呼叫的逾時：想要 want 毫秒，但不能吃掉「送出回覆」要留的 reserve。
// 回傳 0 代表「已經沒有時間了，這段不要做」——呼叫端要看得懂這個訊號。
function budgetFor(want, reserve) {
  return Math.max(0, Math.min(want, msLeft() - reserve));
}

// 答題模型的上限。刻意給得寬（記者要「完整新聞稿」時模型會吐到 max_tokens 4096，
// 那本來就慢），真正的保護是上面的死線——實際用的是 budgetFor() 算出來的餘額。
const ANSWER_TIMEOUT_MS = 45_000;
// 送出回覆＋寫 qa_log 要留的時間。
const REPLY_RESERVE_MS = 5_000;

async function askAnthropic(systemPrompt, userText, history = [], { extraSystem = '', timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '系統目前無法回答，請稍後再試或洽現場工作人員。';
  // 公關同仁用對話交代的回答偏好（批次 46）。放在這裡而不是各個呼叫端：這支是所有
  // 模型呼叫的唯一入口，四條問答路線一次到位，新增路線也不會忘記帶上。
  // ⚠️ 讀的是 60 秒快取（見 lib/bot-memory.js），不會每則提問都打一次 Sheets。
  const styleRules = formatStyleRules(await getMemories());
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      // 死線優先：前面（路由、補查）用掉多少，這裡就少多少，見 msLeft() 的說明。
      // 下限 2 秒——時間真的用完時與其不呼叫、什麼都不回，不如快速失敗走 catch，
      // 記者拿到的是一句「請稍後再試」而不是沉默。
      signal: AbortSignal.timeout(Math.max(2_000, budgetFor(timeoutMs, REPLY_RESERVE_MS))),
      body: JSON.stringify({
        model: ANSWER_MODEL,
        thinking: { type: 'disabled' }, // 見 ANSWER_MODEL 的 ⚠️
        max_tokens: 4096,
        system: [
          { type: 'text', text: [systemPrompt, ZH_TW_RULE, LAYOUT_RULE, styleRules].filter(Boolean).join('\n'), cache_control: { type: 'ephemeral' } },
          ...(extraSystem ? [{ type: 'text', text: extraSystem }] : [])
        ],
        messages: [...history, { role: 'user', content: String(userText).slice(0, 8000) }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API 錯誤:', data.error?.message);
      return '抱歉，目前無法取得回應，請稍後再試或洽現場工作人員。';
    }
    // LINE 不渲染 Markdown，統一在這個出口清一次——見 stripMarkdownForLine() 的說明。
    // ⚠️ 不能寫死 content[0]：回應是一個 content block 陣列，第一塊不保證是文字
    // （thinking 一旦開啟，第一塊就是 thinking block，.text 會是 undefined，整支
    // 靜靜退化成「抱歉，無法取得回應」）。挑出所有 text 區塊接起來才穩，以後要開
    // thinking 也不必回來改這裡。
    const text = (data.content || [])
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n').trim();
    // ⚠️ 三道出口清理的順序：先清 Markdown、再整版面、最後轉繁體。順序不是隨便排的
    // ——tidyLineLayout() 認的是「・」開頭的條列行，而把 `- 項目` 換成「・」的正是
    // stripMarkdownForLine()，跑在它前面才看得到那些行（批次 59）。固定一個順序也才
    // 不會有人日後在中間插一段、結果只有一部分的文字被處理到。
    return toTraditionalTW(tidyLineLayout(stripMarkdownForLine(text))) || '抱歉，無法取得回應。';
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

// 導覽按鈕（批次 40 起）。群組與 1 對 1 都會用到——批次 48 之前只有群組用，見
// eventQuickChips() 裡的 🔄。
//
// 回報的問題：群組裡切到某一場活動之後「比較難切回來」——原因不是功能不見了
// （「回首頁」「最近有哪些活動」一直都認得，打字就會動），而是**群組看不到圖文
// 選單**。圖文選單是 LINE 的 1 對 1 專屬功能，群組聊天室不會顯示，所以 1 對 1 的
// 記者隨時有 🏠 可以按，群組裡的記者答完一題之後看到的按鈕列只剩「這場活動的
// 快速提問」，整排都是往裡面走的路，一條往外的路都沒有。
//
// 這件事在批次 18／28 其實已經認過一次（「群組裡沒有持續顯示的圖文選單，這則歡迎
// 訊息附的按鈕就是群組唯一一次看得到『還能問什麼』的機會」），但當時只補在**入群
// 自我介紹**跟**只 @ 沒接問題**這兩則上——那是記者「還沒開始問」的時候。真正會卡住
// 的時機是「已經問了幾題、想換個方向」，而那個時機的按鈕列正好是唯一沒補到的一排。
//
// 解法就是把圖文選單搬到群組的快速回覆列上：連 icon 都沿用 REPORTER_MENU 的同一組
// （📅🏠🔬📊📞），群組裡的記者看到的東西跟 1 對 1 的人一致，不用重新學。
//
// ⚠️ label 跟 text 刻意分開：顯示用短標＋icon（按鈕列寬度有限，「媒體邀訪需求」
// 五個字擠掉的是隔壁按鈕的能見度），送出的 text 維持原本那幾個字，這樣
// detectMetaIntent()／GROUP_FIXED_BUTTONS／isOwnButtonText() 三邊完全不用改——
// 改 text 才是會出事的那一種改動（按鈕送出的字沒人認得＝按了沒反應，批次 30 踩過）。
//
// ⚠️ 往外的兩顆（回首頁、其他活動）放在**最前面**，不是照舊接在最後：批次 29 已經
// 學過一次「按鈕列最後一格的『媒體邀訪需求』不夠明顯，滑一排按鈕容易漏看」，那次
// 的補救是把入口寫進文字裡。這排在群組裡是唯一的出口，藏在 8 顆自訂提問後面等於
// 沒有——手機一次只看得到兩三顆。
const NAV_HEAD = [
  { label: '🏠 回首頁', text: '回首頁' },            // 解除綁定＋列出全部活動與其他功能
  { label: '📅 其他活動', text: '最近有哪些活動' }    // 只列清單、不解除綁定，點活動名稱直接換過去
];
const NAV_TAIL = [
  { label: '📊 產業趨勢', text: '產業趨勢分析' },
  { label: '🔬 問技術', text: '想問什麼技術' },
  { label: '📞 邀訪窗口', text: CONTACT_MENU_LABEL }
];
const NAV_ALL = [...NAV_HEAD, ...NAV_TAIL];

// LINE 的 id 前綴：使用者 U、群組 C、聊天室 R（官方文件的慣例，很穩定）。判斷錯的
// 代價也只是「群組少一排導覽」或「1 對 1 多一排」，不會壞掉。
const isGroupTarget = id => /^[CR]/.test(String(id || ''));

// replyOrPushMessages() 收的是原始訊息物件，不像 replyOrPush() 會幫忙把字串陣列
// 轉成 quickReply。使用說明那則要自己組一份——格式跟 lib/line.js 的 buildQuickReply()
// 一樣（LINE 的 quick reply 物件），只是這裡只需要固定這幾顆。
function buildHelpQuickReply() {
  const items = ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL];
  return {
    items: items.map(text => ({ type: 'action', action: { type: 'message', label: text, text } }))
  };
}

// ⚠️ 這一層是「群組導覽不會漏掉」的結構性保證（批次 43），不是方便而已。
//
// 回報：在群組按「媒體邀訪需求」→「邀訪：綠能」，拿到窗口聯絡人之後**整則訊息一顆
// 按鈕都沒有**，問完就斷在那裡。使用者問的是「建議改成常駐嗎」——LINE 的快速回覆
// 本來就是綁在單一則訊息上的，沒有「常駐」這種選項；真正常駐的是圖文選單，而群組
// 不顯示圖文選單（批次 40）。所以群組裡「常駐」唯一的實作方式，就是**每一則回覆都
// 自己帶著那排導覽**。
//
// 為什麼包一層、而不是去每個呼叫點補第四個參數：api/line.js 有五十幾處 replyOrPush，
// 群組走得到的至少十幾處。手動補一輪就是又一次「漏掉的那一顆」——這條路上已經連續
// 四次（批次 30、32、40、41）敗在同一種錯。包起來之後，新增的回覆自動有導覽，不用
// 記得，也不會忘記。
//
// 只在「呼叫端沒有自己給按鈕」時才補：給了就代表那則訊息有更貼切的選項（活動清單、
// 邀訪主題、這場的快速提問…），不要覆蓋掉。
async function replyOrPush(replyToken, targetId, text, quickReplyItems) {
  const items = (quickReplyItems && quickReplyItems.length) ? quickReplyItems
    : (isGroupTarget(targetId) ? NAV_ALL : quickReplyItems);
  return replyOrPushRaw(replyToken, targetId, text, items);
}

// LINE quick reply 上限 13 顆，扣掉固定的「媒體邀訪需求」那一格，內容 chips 最多留
// 12 格——同仁在後台放了 13 題以上的自訂問題不是常態，但真的放了也不能讓陣列超過
// LINE 的硬限制，寧可截斷內容 chips 也不能把邀訪窗口的入口擠掉。
//
// 內部先過一次 resolveEventContent()：活動前（見 lib/prompt.js 的說明）自訂 chips
// 若還是原本那組「問活動內容」的問句，記者點下去常常只會得到「這部分我沒有資料」——
// 不是壞掉，但沒有用。呼叫端不用先自己判斷是不是活動前、也不用先手動 resolve 一次，
// 這裡永遠拿到「當下該用哪組 chips」的正確答案；resolveEventContent() 對已經 resolve
// 過的 event 再呼叫一次是安全的（同一批欄位只會算出同樣的結果，不會疊加）。
// 只有「這場的內容提問」那幾顆，不含導覽（回首頁、媒體邀訪需求…）。
//
// ⚠️ 拆出來是因為兩邊要的東西不一樣，混在一起會出事（實測抓到）：按鈕列要「內容 ＋
// 導覽」全部一起送，但 ownChipEventId() 只能拿**內容**去回推場次——導覽那幾顆是跨場次
// 的功能入口，每一場的按鈕列都有，拿它們回推等於「按任何一顆導覽鈕都會把綁定接回上一
// 場」。實際症狀：在群組按「回首頁」（本來就是要解除綁定）之後再按「媒體邀訪需求」，
// 會被接回剛剛那場、拿到那場的窗口，而不是跨活動的全域窗口清單。
function eventContentChips(rawEvent) {
  const event = resolveEventContent(rawEvent || {});
  const custom = String(event?.chips || '').split('\n').map(s => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_CHIPS;
}

function eventQuickChips(rawEvent, { group = false } = {}) {
  // ⚠️ LINE quick reply 硬上限 13 顆，超過的會被 buildQuickReply() 從尾巴截掉。
  //
  // 🔄 批次 48 修正了批次 40 的一個判斷錯誤。批次 40 只在群組加導覽，理由寫成
  // 「1 對 1 有圖文選單撐著，重複放進按鈕列只會排擠掉同仁自訂的提問」——聽起來合理，
  // 實際回報打臉：使用者在 **1 對 1** 切進某一場之後，「就不知如何回到首頁」。
  //
  // 為什麼那個理由不成立：圖文選單雖然常駐，但它是**收合**的（要先點輸入框上方那條
  // 「功能選單」才展開），而記者的視線在剛收到的那則答案上——按鈕列就貼在答案下面，
  // 圖文選單不在。「存在」跟「當下看得到」是兩件事，這一整條路上已經是第二次栽在
  // 同一個分辨上（批次 40 是群組沒有選單，這次是有選單但沒展開）。
  //
  // 所以兩邊都放往外的路，只是密度不同：
  //   群組   ：2 顆往外 ＋ 8 顆內容 ＋ 3 顆其他功能 ＝ 13
  //   1 對 1 ：2 顆往外 ＋ 10 顆內容 ＋ 邀訪窗口     ＝ 13
  // 1 對 1 少放「產業趨勢／問技術」那兩顆，是因為那兩條路不是用來「脫困」的，而且
  // 圖文選單展開後就有——真正被回報找不到的是「回首頁」。
  const contentChips = eventContentChips(rawEvent).slice(0, group ? 8 : 10);
  if (!group) return [...NAV_HEAD, ...contentChips, CONTACT_MENU_LABEL];
  return [...NAV_HEAD, ...contentChips, ...NAV_TAIL];
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
//
// 回報的截圖（批次 29）：正式站問「最近有哪些活動」，按鈕列只有孤零零兩顆
// 「工研院創新日」「媒體邀訪需求」，看起來很空。原因不是壞掉——這排刻意只列
// **有資料的活動**（calendarQuickReplyItems() 會濾掉沒有 kb 的場次，點了也問不出
// 東西），而正式站當下只有一場符合。但真正的問題是：這個帳號有四條路，這排卻只
// 放了「活動」跟「邀訪窗口」兩條，另外兩條（產業趨勢、工研院技術）從來沒出現在
// 這裡，記者要嘛自己打字、要嘛得先去點圖文選單才知道有這些功能。
//
// 活動少的時候按鈕列空蕩蕩，活動多的時候另外兩條路又被埋掉——兩種情況都該把四條路
// 一起放上來，跟群組自我介紹、兜底文案、join 歡迎詞同一份口徑（那三處早就是四條路
// 一次列完）。
//
// ⚠️ LINE quick reply 硬上限 13 顆。活動最多 8 顆（calendarQuickReplyItems 的預設
// limit）＋ 下面 4 顆固定 ＝ 12，永遠塞得下；就算哪天把活動上限調大，也要先確認
// 加起來不超過 13，不然會被 buildQuickReply() 從尾巴截掉——被截掉的正好是這四顆
// 固定入口，等於白加。
function calendarQuickRepliesForReporter(cards) {
  return [
    ...calendarQuickReplyItems(cards),
    '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明'
  ];
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
// 按了「想問什麼技術」，等記者自己打技術名稱的一次性旗標——跟 CONTACT_PENDING_NOTE
// 同一欄（line_users F 欄）、同一支 setContactPending() 讀寫，只是存的字串不同。
// 沒有另外寫一支 setTechQueryPending()：setContactPending() 內部本來就是「不管值是
// 什麼，寫進 F 欄」的通用寫法，名字雖然掛著 contact，邏輯跟這裡要的完全一樣，見
// handleTechQueryMessage() 的說明。
const TECH_QUERY_PENDING_NOTE = 'await_tech_query';

// ── 一次性旗標的「這是誰按的」後綴（批次 28）─────────────────────────────
// 回報的意見：群組裡「答非所問、亂回」。其中最尖銳的一種是這兩個一次性旗標——
// 它們存在 line_users 的 F 欄，而群組是用 groupId 當 key，也就是整個群組共用一格：
// A 按了「想問什麼技術」之後，群組裡「任何人」講的「任何一句話」都會被當成技術
// 名稱直接送去查工研院官網，那個人根本沒在跟機器人講話，卻收到一段莫名其妙的
// 技術報導摘要。「邀訪：其他」的自由輸入視窗有一模一樣的問題。
//
// 修法是把「是誰按的」一起寫進旗標（`await_tech_query#U123...`），只有同一個人的
// 下一則才算數。別人插話不會被吃掉，按按鈕的人自己回來打字仍然接得住。
//
// 1 對 1 刻意不加後綴：targetId 本來就是發話者本人，多存一份只是雜訊，而且舊資料
// （沒有後綴的旗標）在 1 對 1 要照舊生效，不能因為這次改動就失效。
// ⚠️ 分隔符用 '#'——LINE 的 userId 是 `U` 開頭的 32 位十六進位字串，不會含 '#'，
// 旗標本身的值（await_xxx）也不會，切一刀就能還原，不需要 JSON。
const PENDING_SPEAKER_SEP = '#';

// speakerId 沒帶（1 對 1）或跟 targetId 相同時不加後綴，維持舊格式。
function pendingNoteFor(note, targetId, speakerId) {
  if (!note || !speakerId || speakerId === targetId) return note;
  return `${note}${PENDING_SPEAKER_SEP}${speakerId}`;
}

// 回傳 { note, speakerId }；沒有後綴時 speakerId 是空字串（＝「誰都算數」，舊行為）。
function parsePendingNote(raw) {
  const s = String(raw || '');
  const i = s.indexOf(PENDING_SPEAKER_SEP);
  return i === -1 ? { note: s, speakerId: '' } : { note: s.slice(0, i), speakerId: s.slice(i + 1) };
}

// 這則訊息的發話者，有沒有資格用掉這個等待中的旗標。
// 旗標沒記發話者（1 對 1、或舊資料）→ 誰都算數；記了就只認同一個人。
// ⚠️ speakerId 讀不到時（LINE 群組事件在使用者沒同意提供 userId 時可能缺這個欄位）
// 一律當作「不是同一個人」→ 旗標不生效，退回一般路由。安全方向是「不要亂接」，
// 不是「寧可錯接也要接住」——這正是這次要修的問題本身。
function pendingBelongsTo(rawNote, speakerId) {
  const { speakerId: owner } = parsePendingNote(rawNote);
  return !owner || owner === speakerId;
}

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

// 產業趨勢清單（lib/industry-trends.js）快取——跟 contactsDirCache 同一個模式，
// 差別只在 TTL 拉長到 6 小時：這不是 Google Sheets 配額考量（IEKnet 是外部網站，
// 沒有配額問題），是「沒必要每次提問都重抓一次外部網站」——IEK 免費焦點實測更新
// 頻率約每週幾篇，6 小時內反覆問同一個話題不需要每次都真的打一次 fetch。
let industryTrendCache = { items: null, expiry: 0 };
const INDUSTRY_TREND_CACHE_MS = 6 * 60 * 60 * 1000;
async function getIndustryTrendDigest() {
  if (industryTrendCache.items && Date.now() < industryTrendCache.expiry) return industryTrendCache.items;
  const items = await fetchIndustryTrendDigest();
  // 抓失敗／解析出 0 筆時 fetchIndustryTrendDigest() 回空陣列——刻意不快取這個
  // 空結果（TTL 設 0），下一次請求會立刻再試一次，不會被 6 小時的快取卡住連續
  // 失敗；抓成功才真的快取 6 小時。
  industryTrendCache = { items, expiry: items.length ? Date.now() + INDUSTRY_TREND_CACHE_MS : 0 };
  return items;
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
//
// speakerId（批次 28）：群組裡是「誰」在講這句話。等待中的旗標會記下按按鈕的人，
// 只有同一個人的下一則才用得掉——見 pendingNoteFor() 的完整說明。
async function handleContactTopicMessage(replyToken, targetId, text, { speakerId = '' } = {}) {
  const m = String(text || '').match(CONTACT_TOPIC_RE);
  if (m) {
    const topic = m[1].trim();
    if (topic === '其他') {
      await setContactPending(targetId, pendingNoteFor(CONTACT_PENDING_NOTE, targetId, speakerId));
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

  const rawPending = await getStoredNote(targetId);
  if (parsePendingNote(rawPending).note === CONTACT_PENDING_NOTE && pendingBelongsTo(rawPending, speakerId)) {
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

// ── 產業趨勢問答（批次 20，資料來源見 lib/industry-trends.js）─────────────────
// 記者問的不是某一場記者會的內容，是整體產業趨勢／市場現況（例如「半導體最近有
// 什麼趨勢」）——routeIntent() 判成 industry_trend 時走這支，跟現有的 qa／calendar
// 走同一套自然語言路由，1 對 1、群組都適用，不管有沒有綁定活動都答得到（見三個
// 呼叫端：handleUnbound()、handleEvent() 綁定中的判斷、handleGroupMessage() 綁定
// 中的判斷）。
//
// 只用 IEK 免費焦點清單本身就有的標題＋日期＋摘要回答，不呼叫網頁版那套帶知識庫
// 全文的 buildSystemPrompt()——這裡的資料來源、規則完全不同，硬塞進同一支反而
// 要多加一堆「這不是活動內容」的例外判斷。回答結尾一律附上警語＋公關窗口聯絡
// 資訊（使用者原話：「僅供參考，正式媒體報導引用請聯繫 公關窗口 朱則瑋」）——
// 這是 IEK 的免費摘要，不是正式新聞稿，記者可能直接截圖引用，跟
// lib/prompt.js buildSystemPrompt() 既有的「內容僅供參考，以工研院官網新聞稿
// 或發言為準」警語同一種目的。
//
// 優先讀 events!contacts_directory 裡「產業趨勢分析」這個既有主題的窗口
// （批次 9 就有，同仁可在後台「邀訪窗口分工」改名字或補電話，這裡自動跟著
// 更新，不需要改程式碼）；那個主題目前還沒填電話，name／phone 個別退回使用者
// 確認過的號碼當預設值，讓這個功能一上線就能用，不用等同仁先去後台補資料——
// 之後同仁在後台把任一欄填了，這裡就自動改用後台那組，不是永遠鎖死這組預設值。
const FALLBACK_INDUSTRY_TREND_CONTACT = { name: '朱則瑋', phone: '0934-267-766' };

async function industryTrendContactLine() {
  const directory = await getContactsDirectory();
  const configured = directory.find(c => c.topic === '產業趨勢分析');
  const name = configured?.name || FALLBACK_INDUSTRY_TREND_CONTACT.name;
  const phone = configured?.phone || FALLBACK_INDUSTRY_TREND_CONTACT.phone;
  return `\n\n僅供參考，正式媒體報導引用請聯繫 公關窗口 ${name}　📞 ${phone}`;
}

// 「這題問的是產業趨勢，那同一個題目問工研院自己的技術呢」——兩條路互相導流時要
// 用的簡短關鍵字。抽不乾淨（抽完太長、太短、或整句都是泛稱被抽成空的）就回空字串，
// 呼叫端拿到空字串就不放那顆按鈕：這是錦上添花的入口，寧可沒有也不要放一顆
// 「工研院的哪些產業趨勢重點技術」這種讀起來像亂碼的按鈕。
//
// 語助詞的部分直接沿用 lib/itri-news.js 已經在用的那份（stripTechQueryFiller），
// 不另外維護第二份清單；這裡只多去掉「產業／趨勢／市場／現況…」這類**產業趨勢題
// 專屬**的泛稱——那些字在 stripTechQueryFiller() 裡不能去掉（那支是給工研院官網
// 搜尋用的，「產業」本身可能就是要查的詞的一部分），只有在這個「把趨勢題轉成技術
// 題」的場景才該拿掉。
function crossTopicKeyword(text) {
  const kw = stripTechQueryFiller(text)
    .replace(/產業|趨勢|市場|現況|分析|重點|方面|領域|相關|如何|怎樣|怎麼樣|現在|目前|未來|今年/g, '')
    .trim();
  return /^[^\s]{2,8}$/.test(kw) ? kw : '';
}

async function answerIndustryTrend(replyToken, targetId, text) {
  const items = await getIndustryTrendDigest();
  const contactLine = await industryTrendContactLine();
  // 導到另一條路（工研院自己的技術）的按鈕——實際回報的截圖裡，AI 老實說了「清單
  // 裡沒有航太專項的分析」之後就沒有下文了，記者只能自己猜下一步該打什麼，猜出來
  // 的「太空」又剛好掉進兜底文案。IEK 免費焦點只有十來則、覆蓋不到的領域是常態，
  // 「這裡沒有，可以改從工研院自己的技術報導找」本來就該是預設出口。
  const kw = crossTopicKeyword(text);
  const crossItem = kw ? [{ label: `工研院的${kw}技術`, text: `工研院 ${kw}` }] : [];

  if (!items.length) {
    // 抓取失敗（網路問題、IEK 網站改版）——誠實說抓不到，不要硬答或裝死。
    await replyOrPush(replyToken, targetId,
      `這部分我暫時抓不到最新的產業趨勢資料，真不好意思 🙏${contactLine}`,
      [...crossItem, '最近有哪些活動', CONTACT_MENU_LABEL]);
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者的產業趨勢問題。下面是「IEK 產業情報網」免費焦點清單（標題／日期／摘要），這是 IEK 自己公開的免費導讀摘要，不是完整報告。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整報告裡才有但摘要沒寫的細節。',
    '如果清單裡沒有明顯對應記者問題的項目，就誠實說「目前免費焦點清單裡沒有直接對應的資料」，不要硬答或東拼西湊。',
    // 實際回報的截圖：AI 老實說了「但沒有航太專項的分析」，然後就沒有下文——記者
    // 只能自己猜下一步該打什麼。誠實不夠，還要給得出出口，不然記者就卡在那裡。
    // ⚠️ 只能建議「換個領域問趨勢」或「改問工研院的技術」這兩條真的存在的路，不要
    // 自己發明「我幫您轉給某某」「請稍等我查一下」這種這個帳號做不到的事。
    '清單裡沒有直接對應的資料時，除了老實講，還要順帶給記者一條明確的下一步：可以換個領域再問我產業趨勢，或是直接問我工研院自己在這個領域的技術（打「工研院＋技術名稱」就可以）。不要只丟一句「沒有資料」就結束，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。',
    '記者的問題如果很籠統、沒有指定特定技術或產業領域（例如只是問「產業趨勢」「最近有什麼趨勢」這種泛稱，不是問特定的半導體、AI 之類），不要反問記者想了解哪個領域——直接摘要清單裡最新的 1-2 則重點回答即可，這正是這份清單存在的目的（讓記者一次掃到最新的幾則重點）；只有記者的問題明確指定了某個領域、清單裡卻完全沒有相關項目時，才適用上一條「沒有直接對應資料」的規則。',
    '回答控制在 4 行以內，先講最相關的 1-2 則的重點，並標明是哪一篇、什麼時候發布的。不要用 Markdown 語法（LINE 不會渲染）。',
    '明確讓記者知道這是 IEK 的免費摘要，不是完整報告——不要講得像這就是 IEK 的完整分析或工研院的正式研究結論。',
    // 人設：使用者要求「對答更有人味、符合米亞的人設」。米亞原本只活在歡迎圖卡與
    // 使用說明裡（見 lib/menu.js buildWelcomeFlex／HELP_TEXT），真正在對話的這幾支
    // 反而是公文語氣。這條只調語氣、不放寬任何一條「只能照資料回答」的規則——記者
    // 會直接截圖引用，親切不能換成含糊，講不知道的時候要更清楚，不是更委婉。
    TONE_RULE,
    '回答最後另起一行，只用這個格式標出這次引用了清單中第幾則（從 1 開始的編號，可能不只一則，用逗號分隔），例如「來源編號：2,5」；這行只給程式判讀連結用，不算進上面「4 行以內」的限制。如果清單裡沒有直接對應的資料，就不要加這一行。',
    '',
    '【IEK 產業情報網 免費焦點清單，由新到舊】',
    formatDigestForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, text);
  // 「來源編號」那行是給程式看的，不能讓記者在 LINE 上看到——extractSourceIndices()
  // 負責切掉它，回報的意見裡記者要的是接下來附的連結，不是這行原始標記。
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  // 沒解析到可信編號（AI 沒加這行、格式不符、或判成「沒有直接對應的資料」）就不附
  // 連結——見 lib/industry-trends.js resolveSourceUrls() 的說明，寧可沒有也不要附錯。
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';
  const reply = `${aiReply}${linksBlock}${contactLine}`;
  console.log(`[line] industry_trend q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply, [...crossItem, '最近有哪些活動', CONTACT_MENU_LABEL]);
  // 記住這一輪聊的是產業趨勢——下一則如果只是個裸名詞（截圖裡的「太空」），
  // routeIntent() 才接得回這個話題，不會掉進「我沒抓到您想問哪一場活動」。
  // 放在送出回覆之後：這是加分功能，寫失敗（setRecentTopic 自己吞例外）也絕對不能
  // 讓記者收不到剛剛那則答案。
  // ⚠️ 一併記下問句與答案節錄（批次 58）：追問常常不是裸名詞，而是一句指著這段
  // 答案的完整問句（「有談機器人發展的嗎」），路由要看得到這段才判得出來。
  // 存的是 aiReply 不是 reply——連結區塊與窗口警語是我們自己加的裝飾，不是內容，
  // 留在脈絡裡只會讓模型把那幾行也當成「剛剛講過的東西」。
  await setRecentTopic(targetId, 'industry_trend', { question: text, answer: aiReply });
}

// ── 「想問什麼技術」問答（回報的意見，跟產業趨勢問答平行的另一套）──────────
// 記者想直接問工研院「自己」在某項技術上的研發成果，不是在問某一場記者會、也不是
// 在問整體產業趨勢（那是 answerIndustryTrend() 的事）——資料來源是工研院官網新聞
// 中心自己的報導，用記者給的技術名稱當關鍵字去查（見 lib/itri-news.js
// fetchItriNews() 的說明）。兩支故意不共用同一支：資料源不同、查詢方式不同（這支
// 要帶關鍵字去查，answerIndustryTrend() 是固定抓最新清單）、結尾的窗口導引邏輯也
// 不同（這支盡量比對出對應技術領域的窗口，answerIndustryTrend() 固定導向「產業
// 趨勢分析」那個窗口）——硬併成一支只會讓兩邊互相牽制對方的邏輯。
//
// keywordText 兩種來源：①「想問什麼技術」按鈕之後記者自己打的技術名稱（見下面
// handleTechQueryMessage()）；②記者直接自然語言問「工研院在ＸＸ技術上有什麼
// 進展」，routeIntent() 判成 tech_query 時會順手抽一個關鍵字（見 lib/router.js），
// 呼叫端優先用抽出來的關鍵字，沒抽到才退回整句原話。
// ⚠️ 這兩種來源都可能是一整句話而不是乾淨的技術名稱——工研院官網的關鍵字搜尋是
// 接近精準比對，不是全文檢索，整句話（含語助詞）常常查不到（這裡曾經誤判成「全文
// 檢索，整句拿去查更可靠」，實測是錯的，見下方 fetchItriNews() 呼叫）。查無資料時
// 去語助詞再試一次的保底邏輯統一放在 lib/itri-news.js fetchItriNews() 裡面，這支
// 不用自己重試——不管 keywordText 乾不乾淨，這支都不用假設它已經是乾淨關鍵字。
async function answerTechQuery(replyToken, targetId, keywordText) {
  const keyword = sanitize(keywordText, 60);
  // ⚠️ 沒有關鍵字、或關鍵字只是「新聞」「新聞稿」這種泛稱時，改走「最新新聞清單」
  // 那條路。這是 lib/menu.js isLatestNewsQuestion() 那條死板規則之外的第二層：
  // 記者的講法千變萬化，規則接不住的（「工研院這陣子在忙什麼新聞」）會掉到
  // routeIntent()，AI 判成 tech_query 但抽不出技術關鍵字——這時候拿泛稱去查官網
  // 只會撈到雜訊（見 NO_DATA_GENERIC 的說明），列最新清單才是記者真正想要的。
  // 兩層都要有，理由見 CLAUDE.md 第 2 條：規則是保證，AI 是涵蓋率。
  if (!keyword || isGenericLookupKeyword(keyword)) {
    await answerLatestNews(replyToken, targetId, keywordText || '最近有哪些新聞');
    return;
  }
  const { ok, items } = await fetchItriNews(keyword);
  // 導到另一條路（整體產業趨勢）的按鈕，跟 answerIndustryTrend() 的 crossItem 對稱：
  // 工研院官網沒報導過某個題目是常態（尤其比較新的領域），但那不代表「這個題目在
  // 這個帳號問不到東西」——IEK 免費焦點可能剛好有。查不到就只丟一句「請洽窗口」，
  // 等於把還走得通的另一條路藏起來。
  const kw = crossTopicKeyword(keyword);
  const crossItem = kw ? [{ label: `${kw}的產業趨勢`, text: `${kw}產業趨勢` }] : [];

  if (!ok) {
    // 抓取失敗（網路問題、官網改版）——誠實說抓不到，不要硬答或裝死，跟
    // answerIndustryTrend() 抓取失敗那條路同一個原則。
    await replyOrPush(replyToken, targetId,
      '這部分我暫時抓不到工研院官網的最新資料，真不好意思 🙏 建議直接洽媒體邀訪窗口。',
      [...crossItem, CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }
  if (!items.length) {
    // 查無資料是很正常的結果（工研院官網不是每個技術都報導過，或記者打的詞比較
    // 冷門）——不是網站掛了，見 fetchItriNews() 的說明。老實說查不到，直接給邀訪
    // 窗口讓記者換個管道問，不要硬答或東拼西湊。
    await replyOrPush(replyToken, targetId,
      `工研院官網新聞中心目前沒有找到跟「${keyword}」直接相關的報導。想從產業面切入的話我這邊還有 IEK 的產業趨勢摘要可以查；要找人談，直接洽媒體邀訪窗口會有專人協助確認。`,
      [...crossItem, CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者關於工研院自己技術的問題。下面是用記者提供的關鍵字，在「工研院官網新聞中心」查到的相關報導（標題／日期／摘要），這是工研院自己發布的新聞稿摘要，不是完整報告全文。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整報導裡才有但摘要沒寫的細節。',
    '如果清單裡的項目其實跟記者問的技術關聯不大，就誠實說「目前工研院官網新聞中心沒有找到直接對應的報導」，並順帶給記者一條明確的下一步：可以改問我這個題目的整體產業趨勢，或換個技術名稱再問一次。不要硬答或東拼西湊，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。',
    '回答控制在 4 行以內，先講最相關的 1-2 則的重點，並標明是哪一篇、什麼時候發布的。不要用 Markdown 語法（LINE 不會渲染）。',
    TONE_RULE, // 見上面 TONE_RULE 的說明：只調語氣，不放寬「只能照資料回答」的規則
    '回答最後另起一行，只用這個格式標出這次引用了清單中第幾則（從 1 開始的編號，可能不只一則，用逗號分隔），例如「來源編號：2,5」；這行只給程式判讀連結用，不算進上面「4 行以內」的限制。如果清單裡沒有直接對應的報導，就不要加這一行。',
    '',
    `【工研院官網新聞中心 搜尋「${keyword}」的結果，由新到舊】`,
    formatNewsForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, keywordText);
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';

  // 導引窗口：優先用記者的關鍵字比對出對應技術領域的專屬窗口（跟「媒體邀訪需求」
  // 按鈕裡「其他」自由輸入同一支比對邏輯，見 lib/contacts-directory.js
  // matchGlobalContactByText() 的說明），比對不到才退回一般性的邀訪窗口指引——
  // 給得出精準窗口就不要只給一句「請洽邀訪窗口」，記者還要再點一次按鈕才找得到人。
  const directory = await getContactsDirectory();
  const contact = matchGlobalContactByText(keyword, directory);
  const contactLine = contact
    ? `\n\n想安排採訪或進一步了解，可直接聯繫：\n${formatGlobalContact(contact)}`
    : '\n\n想安排採訪或進一步了解，請洽媒體邀訪窗口。';

  const reply = `${aiReply}${linksBlock}${contactLine}`;
  console.log(`[line] tech_query kw="${keyword}" reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply, [...crossItem, CONTACT_MENU_LABEL, '最近有哪些活動']);
  // 跟 answerIndustryTrend() 同一個道理：記住這一輪聊的是工研院技術，下一則只打一個
  // 技術名詞（「那光通訊呢」的省略講法）才接得回來，見 getRecentTopic() 的說明。
  // 問句與答案節錄一併記下，理由同 answerIndustryTrend() 那段（批次 58）。
  await setRecentTopic(targetId, 'tech_query', { question: keyword, answer: aiReply });
}

// ── 「最近工研院有哪些新聞」（回報，附截圖）─────────────────────────────
// 記者在群組打「米亞 最近工研院有哪些新聞」，米亞回的是【近期活動】行事曆，記者
// 只好再追問一次「最近發的新聞稿麼」。問的是新聞稿，回的是記者會場次表——在這個
// 帳號裡這是兩個不同的資料來源（新聞稿在工研院官網新聞中心，場次在 events 表）。
//
// 這支跟 answerTechQuery() 的差別只有一個：**不帶關鍵字**，直接抓官網新聞中心的
// 「最新新聞」第一頁。lib/itri-news.js 的 fetchItriNews() 早就備好這條路（那支的
// 註解寫著「這個分支是給之後萬一有『不指定技術、直接看工研院最新動態』需求時的
// 退路」），這裡才第一次真的用到。
//
// ⚠️ 為什麼不共用 answerTechQuery()：那支的每一句話都繞著「記者給的那個關鍵字」
// 打轉——查無資料的文案（「沒有找到跟『ＸＸ』相關的報導」）、導到 IEK 的按鈕
// （crossTopicKeyword）、比對技術領域窗口（matchGlobalContactByText）三處都要
// 關鍵字。沒有關鍵字時那三處全部沒有意義，硬併只會讓兩邊互相牽制。
async function answerLatestNews(replyToken, targetId, question) {
  const { ok, items } = await fetchItriNews('');
  if (!ok) {
    await replyOrPush(replyToken, targetId,
      '這部分我暫時抓不到工研院官網的最新資料，真不好意思 🙏 建議直接洽媒體邀訪窗口。',
      ['產業趨勢分析', CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }
  if (!items.length) {
    // 官網連得上、清單卻是空的——多半是官網改版讓 parseNewsListHtml() 解析不到
    // （見 lib/itri-news.js）。誠實說抓不到，不要硬掰。
    await replyOrPush(replyToken, targetId,
      '我這邊暫時讀不到工研院官網新聞中心的清單，真不好意思 🙏 可以直接看官網：\nhttps://www.itri.org.tw/ListStyle.aspx?DisplayStyle=06&SiteID=1&MmmID=1036276263153520257',
      ['產業趨勢分析', CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者「工研院最近發了哪些新聞」這個問題。下面是「工研院官網新聞中心」最新一頁的新聞稿（標題／日期／摘要），由新到舊。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整新聞稿裡才有但摘要沒寫的細節。',
    // ⚠️ 這裡刻意要求「條列最新的幾則」而不是「摘要重點」：記者問的是「有哪些」，
    // 要的是一份可以掃過去的清單，不是一段濃縮成兩句話的綜述。答成綜述等於把他
    // 真正想要的東西（哪幾則、什麼時候發的）藏起來。
    '用條列的方式列出最新的 5 則，一則一行，格式是「日期　標題」（標題太長就精簡到 30 字內，但不要改變原意）。開頭先用一句話說明這是工研院官網新聞中心最近發布的新聞稿。',
    '不要加上你自己的評論或推薦，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。不要用 Markdown 語法（LINE 不會渲染）。',
    TONE_RULE, // 見上面 TONE_RULE 的說明：只調語氣，不放寬「只能照資料回答」的規則
    '回答最後另起一行，只用這個格式標出你列出來的是清單中第幾則（從 1 開始的編號，用逗號分隔），例如「來源編號：1,2,3,4,5」；這行只給程式判讀連結用，不算進上面的行數限制。',
    '',
    '【工研院官網新聞中心 最新新聞，由新到舊】',
    formatNewsForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, question);
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';

  const reply = `${aiReply}${linksBlock}\n\n想看某一則的細節，直接打標題裡的關鍵字就可以；要安排採訪請洽媒體邀訪窗口。`;
  console.log(`[line] latest_news items=${items.length} reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply,
    ['產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '最近有哪些活動']);
  // 記住這一輪聊的是工研院自己的新聞：下一則只打一個技術名詞（「那半導體呢」的省略
  // 講法）才接得回 tech_query，見 getRecentTopic() 的說明。
  // 問句與答案節錄一併記下，理由同 answerIndustryTrend() 那段（批次 58）——這條路
  // 的答案是一份新聞標題清單，記者的追問（「有談機器人的嗎」）幾乎一定是指著清單裡
  // 的某一則，更需要這段脈絡。
  await setRecentTopic(targetId, 'tech_query', { question, answer: aiReply });
}

// 「想問什麼技術」按鈕之後記者自己打的技術名稱——跟 handleContactTopicMessage()
// 「其他」自由輸入同一個模式：先記一個一次性旗標，下一則不管長什麼樣都當成技術
// 名稱直接去查，不逼記者用特定句型（「我想問」「請問」之類），也不用 AI 再判斷
// 一次「這是不是技術名稱」——反正查不到 answerTechQuery() 自己會老實說查不到。
//
// speakerId（批次 28）：理由同 handleContactTopicMessage()，見 pendingNoteFor()。
async function handleTechQueryMessage(replyToken, targetId, text, { speakerId = '' } = {}) {
  const rawPending = await getStoredNote(targetId);
  if (parsePendingNote(rawPending).note !== TECH_QUERY_PENDING_NOTE) return false;
  if (!pendingBelongsTo(rawPending, speakerId)) return false; // 群組裡別人插的話，不是他要查的技術名稱
  await setContactPending(targetId, ''); // 一次性：不管查不查得到，用掉這一次就清掉
  await answerTechQuery(replyToken, targetId, text);
  return true;
}

// 正式問答：開輸入中動畫 → 呼叫 Anthropic → reply（失敗 fallback push）→ 寫 qa_log。
// 綁定路徑（#代碼）跟路由命中路徑（自然語言直接命中某一場）最後都走這支，避免兩邊各自
// 維護一份幾乎一樣的邏輯、之後改一邊忘了改另一邊。
//
// memory（批次 28）：要不要帶上「上一輪對話」給模型，並在答完之後記下這一輪。
// 只有 1 對 1 的記者問答會傳 true——群組多人交錯提問、職員模式問的是後台資料，
// 兩者回放上一輪只會製造答非所問，見 getRecentTurn() 的說明。
// ── 「這場答不出來」→ 自動補查工研院官網（批次 31）─────────────────────────
// 把 AI 加在結尾的 [[NO_DATA:關鍵詞]] 標記切下來（見 lineExtraRules() 的完整說明）。
// ⚠️ 不管有沒有要用這個關鍵詞，標記一定要切掉——那行是給程式看的，漏在回覆裡讓記者
// 看到一串 [[NO_DATA:院士]] 比什麼都沒做還糟。回傳 { text, keyword }。
// ⚠️ 批次 33：第一版把這條正則錨定在字串結尾（`$`），實際回報的截圖就是它漏掉的——
// 記者收到的訊息裡原封不動印著一行 `[[NO_DATA:院士]]`。
//
// 根因是**兩條規則搶同一個位置**：lib/prompt.js 的結尾規則要求「每則回答的最後，務必
// 另起一行加註警語」，我這條標記規則也寫「整則回覆的最後」。模型選了把警語放最後
// （那條更老、更強、講得更重），標記被擠到警語前面一行，`$` 就對不上了。
//
// 而且這一個 miss 同時造成兩個症狀：標記漏給記者看到，**而且**因為抽不到關鍵詞，
// 官網補查那條路根本沒跑——記者既看到亂碼、又沒拿到本來該給他的連結。
//
// 修法是不要跟位置賭：**整段裡任何地方出現都抓掉**（g 旗標，出現兩次也清乾淨）。
// 位置本來就不該由我們決定——規則要求模型把某段文字放在特定位置，本身就是脆弱的。
const NO_DATA_RE = /\[\[\s*NO_DATA\s*[:：]?\s*([^\]]*?)\s*\]\]/g;

// 第二道防線：整行以 NO_DATA 開頭（括號打壞、少一邊、或模型自己換了寫法）。
// 中文回覆裡不可能有正當內容以 NO_DATA 開頭，整行拿掉是安全的。
const NO_DATA_LINE_RE = /^[ \t]*\[{0,2}[ \t]*NO_DATA[ \t]*[:：].*$/gim;

export function extractNoDataKeyword(raw) {
  let keyword = '';
  const text = String(raw || '')
    .replace(NO_DATA_RE, (_m, kw) => {
      if (!keyword) keyword = String(kw || '').trim().slice(0, 20);
      return '';
    })
    .replace(NO_DATA_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, keyword };
}

// 這場的知識庫答不出來時，拿記者真正在問的關鍵詞去工研院官網新聞中心補查一次，
// 查到就把標題與連結接在答案後面。
//
// ⚠️ 只給「線索」，不重寫內容：這裡刻意不再叫一次 AI 去摘要那幾則報導。記者要的是
// 「哪裡找得到」，直接給標題＋日期＋原文連結最準也最快；多叫一次 AI 除了慢，還多一次
// 把官網原文講走鐘的機會——而這則回覆掛的是主辦單位名義（同 lineExtraRules() 的顧慮）。
//
// 查不到（或抓取失敗）就回空字串，原本那句誠實的「我沒有這項資料」照舊送出去，
// 不會因為補查失敗而讓記者收不到答案。
const NO_DATA_MAX_LINKS = 2;

// 補查這條路一次能花的時間上限，以及「低於這個數字就不要開始」的門檻。
// 12 秒的來源：一次官網清單頁實測一兩秒，最壞情況兩個候選詞各查兩次（見
// lib/itri-news.js 去語助詞重試那段）＝ 4 次，再加一次把結果讀成答案的模型呼叫。
// 4 秒以下連第一次 HTTP 都不一定回得來，與其開始了又中途放棄，不如直接把答案送出去。
const LOOKUP_BUDGET_MS = 12_000;
const LOOKUP_MIN_MS = 4_000;

// ── 不再只靠模型自己標記（批次 37）─────────────────────────────────────────
// 連續三批（31→33→34）都在修「標記為什麼沒出現」，最後一次實測仍然沒跑：回覆明明
// 就是「這題目前我手上沒有具體的名單資料」，補查那條路照樣沒動。
//
// 到這裡結論很清楚：**請模型在回答裡順手加一個機器讀的標記，本來就不是可靠的機制**。
// 它每次都要在「照規則加標記」跟「把回答寫好」之間分心，而規則再怎麼寫都只是請求。
// 標記留著（它抓到的關鍵詞語意最準，有加就用），但不能再是唯一的觸發條件——補上
// 一道純程式的判斷：回覆的內容看起來就是在說「我沒有這項資料」時，一樣去補查。
//
// ⚠️ 誤判的代價很小：多查一次官網，查到就多附兩個連結、查不到就什麼都不加。
// 漏判的代價才大（記者本來拿得到答案卻沒拿到），所以這裡刻意放寬。
const NO_DATA_PHRASE_RE = /(沒有|未|查不到|找不到).{0,10}(資料|內容|資訊|名單|說明)|沒有提到|未提及|沒有這方面|手上沒有|不在.{0,6}資料/;

// 標記沒出現時，退而求其次從記者的問句猜一個關鍵詞。
// 「今年院士」→「院士」、「今年院士有誰」→「院士」、「得獎名單」→「得獎名單」。
// ⚠️ 刻意不共用 lib/itri-news.js 的 stripTechQueryFiller()：那支是給「想問什麼技術」
// 那條路用的，多拿掉「今年」「有誰」這些詞會影響到那邊的既有行為。這裡是不同的場景，
// 各自維護一份短清單比硬共用安全。
const NO_DATA_FILLER_RE = /今年|去年|明年|今天|昨天|明天|最近|最新|目前|現在|本屆|這次|本次|有誰|是誰|哪些|哪位|什麼|甚麼|請問|想問|想知道|一下|我們|你們|活動|的|嗎|呢|吧|了|喔|耶|[\s?？！!。，,、：:]/g;
// 拿掉語助詞之後常會在尾巴留下一個孤零零的動詞／繫詞（「得獎名單是」「合作廠商有」）。
// 只切尾巴、不全域切——「有機材料」「是非題」這種詞中間的字不能動。
const NO_DATA_TAIL_RE = /[是有為會在要能與和及]+$/;

// 「這個詞拿去查官網新聞中心根本沒有意義」的關鍵詞（批次 44）。
//
// 實際回報的截圖：記者在群組打「新聞稿」，本場正確地回了「這場狀態是稍晚提供，還沒有
// 完整新聞稿全文」＋大會手冊＋新聞聯絡人——到這裡都對。壞在後面自動接上的補查區塊：
// 拿「新聞稿」三個字去搜官網，撈回三篇只因為內文出現過「新聞稿」而中的無關報導
// （致茂論文競賽、管風琴演奏會），還一本正經地列出原文連結。
//
// 根因是這類詞講的是「資料本身」，不是主題。官網搜尋是字面比對，用這種詞去查，
// 命中的必然是雜訊——而雜訊附在一則本來很得體的回答後面，比什麼都不加傷害更大
// （記者會以為米亞在硬湊）。
//
// ⚠️ 只擋「整個關鍵詞剛好等於這些字」，不做包含比對：「得獎名單」「開幕照片」是有主題
// 的詞，查得到東西也該查；被擋掉的只有孤零零的「名單」「照片」。
const NO_DATA_GENERIC = new Set([
  '新聞稿', '新聞', '稿件', '全文', '新聞稿全文', '資料', '相關資料', '內容', '相關內容',
  '照片', '圖片', '相片', '影片', '簡報', '檔案', '名單', '清單', '說明', '資訊',
  'press release', 'photo', 'photos', 'material', 'materials', 'information'
]);
function isGenericLookupKeyword(kw) {
  return NO_DATA_GENERIC.has(String(kw || '').trim().toLowerCase());
}

// ── 綁定中點「新聞稿」這類泛用詞的按鈕 → 不能被判去問工研院整體新聞（回報，2026-09）──
// 實際回報：記者在群組打「創新日」綁定到那一場之後，點了那一場自訂的快速提問按鈕
// 「新聞稿」，結果拿到的是「工研院官網新聞中心最近發布的新聞」清單（ICT TechDay、
// VAMAS 研討會…），沒有一則跟創新日有關——按鈕明明是問「這一場」的新聞稿，答案卻是
// 全站最新新聞。
//
// 根因在 routeIntent()：它的 systemPrompt 明講「工研院最近發了哪些新聞／新聞稿」這種
// 不指定主題的問題算 tech_query（這時候 tech_keyword 留空），這條規則的本意是給「工研院
// 最近有什麼新聞」這種完整句子用的，但同一份指示也讓模型看到孤零零的「新聞稿」三個字
// 時往同一個方向偏，蓋過了「目前綁定在這一場」那條 currentEvent 提示——這正是 CLAUDE.md
// 第 2 條講的「prompt 是請求，不是保證」：模型九成九會照 currentEvent 提示判成 qa，
// 剩下那一次就是這次記者截圖回報的那一次。
//
// 修法不是再去調 routeIntent() 的用詞（同一個坑踩過四次，見 CLAUDE.md 第 2 條）：
// 已經綁定某一場、而且訊息本身就是這種「講的是資料本身、不是主題」的泛用詞
// （isGenericLookupKeyword 是整字比對，跟 NO_DATA_GENERIC／批次 44 補查關鍵詞卡住雜訊
// 用的同一份判準）時，直接把結果釘回這一場的 qa，不再信任 routeIntent() 這次的分類。
//
// ⚠️ 只在 tech_keyword 是空字串時才覆蓋：訊息如果明確提到「工研院」或帶了具體技術／
// 主題（「工研院院士授證的新聞稿」「半導體最近有什麼新聞」），routeIntent() 會抽出
// 對應的 tech_keyword，這種才是記者真的在問公司整體動態或另一個主題，不能覆蓋，
// 否則反而會把「這場沒有的話題」硬答成這一場的內容。
function pinGenericTechQueryToEvent(routed, text, eventId) {
  if (routed.intent === 'tech_query' && !routed.tech_keyword && isGenericLookupKeyword(text)) {
    return { ...routed, intent: 'qa', event_ids: [eventId], confidence: 'high' };
  }
  return routed;
}

export function guessNoDataKeyword(question) {
  const kw = String(question || '').replace(NO_DATA_FILLER_RE, '').replace(NO_DATA_TAIL_RE, '').trim();
  // 太短（剩一個字）沒有查詢價值，太長多半是沒抽乾淨的整句話，兩種都放棄——
  // 放棄就是不補查，回到原本那句誠實的回答，不會更糟。
  return /^[^\s]{2,20}$/.test(kw) ? kw : '';
}


// 這段引言是「我們自己加的」，不是模型寫的——所以 lib/prompt.js 那條「跟著記者的
// 提問語言回答」的規則管不到它，得自己判斷。不然英文記者會拿到一段英文答案、下面
// 突然接一句中文，看起來像壞掉（批次 34 補：那條語言規則存在就是為了服務英文提問，
// 我們自己接的字卻破功，等於白做）。
//
// 判斷只看「模型剛剛那段答案裡有沒有中文字」——這比重新猜記者用什麼語言可靠：答案
// 的語言已經是模型跟著提問語言決定好的結果，跟著它走就一定一致。
function hasChinese(text) {
  return /[一-鿿]/.test(String(text || ''));
}

// keywords：候選關鍵詞，依序試到查得到為止。
//
// ⚠️ 批次 39：原本這裡只收「一個」關鍵詞，呼叫端用 `標記 || 猜的` 二選一——實測踩到
// 的正是這個：模型的標記吐成一整句（「今年受證院士的具體名單和人數」，官網查 0 筆），
// 而句型判斷猜出來的「院士」查得到 10 筆，卻因為標記優先、標記查不到就整個放棄，
// 從來沒被試過。
//
// 兩個來源各有各的長處——標記的語意最準、猜的最乾淨——不該二選一，該依序試。
// budgetMs（批次 57）：這條路總共能花多少時間，由呼叫端從「這次請求還剩多少」算出來
// （見 answerQuestion() 那段的說明）。時間用完就停在目前的結果上——補查是加分，
// 不能讓它把已經算好的答案一起拖下水。
async function itriNewsHintBlock(keywords, { chinese = true, question = '', budgetMs = LOOKUP_BUDGET_MS } = {}) {
  const until = Date.now() + budgetMs;
  const list = [...new Set((Array.isArray(keywords) ? keywords : [keywords])
    .map(k => sanitize(k, 40)).filter(Boolean))]
    // 泛用詞查了只會撈到雜訊，見 NO_DATA_GENERIC 的說明
    .filter(k => {
      if (!isGenericLookupKeyword(k)) return true;
      console.log(`[line] 補查官網跳過泛用關鍵詞 kw="${k}"`);
      return false;
    });
  if (!list.length) return '';
  try {
    let kw = '', items = [];
    for (const candidate of list) {
      // 剩下的時間連一次 HTTP 都不夠（見 lib/itri-news.js 的 10 秒逾時）就不要再開始，
      // 已經查到的就用，沒查到就放棄補查——答案本身早就算好了，那才是要保住的東西。
      if (Date.now() > until - 2_000) {
        console.log(`[line] 補查官網：預算用完，不再試候選 kw="${candidate}"`);
        break;
      }
      const res = await fetchItriNews(candidate);
      if (res.ok && res.items.length) { kw = candidate; items = res.items; break; }
      console.log(`[line] 補查官網 kw="${candidate}" 查無資料，試下一個候選`);
    }
    if (!items.length) return '';
    console.log(`[line] 補查官網命中 kw="${kw}" ${items.length} 筆`);

    const links = items.slice(0, NO_DATA_MAX_LINKS)
      .map(it => `・${it.title}${it.date ? `（${it.date}）` : ''}\n${it.url}`)
      .join('\n');

    // ── 找到了就「讀懂它」，不是只丟連結（批次 38）─────────────────────────
    // 使用者確認：那場活動的知識庫是空的，內容只存在工研院官網新聞室。也就是說
    // 這條補查是這題**唯一**答得出來的路——那就不能只給連結。使用者兩輪前的原話
    // 是「不是給新聞稿，而是會讀懂消化」，丟兩個連結叫記者自己點進去看，正是那句
    // 話在講的問題。
    //
    // 搜尋結果本來就帶著標題／日期／摘要，再叫一次模型把它讀成答案即可。
    // ⚠️ 這是這條路上的第二次模型呼叫，但它**只發生在「本場答不出來」這條路**——
    // 正常答得出來的提問一次都不會多花。用這個代價換「記者真的拿到答案」很划算。
    // ⚠️ 摘要不是全文：規則明講只能根據摘要回答、不足的部分要請記者看原文，
    // 不可以把摘要沒寫的細節補完（跟活動問答同一條底線）。
    // 查到了，但剩下的時間不夠再叫一次模型把它讀成答案——那就只附連結（那本來就是
    // 批次 38 之前的行為，不是壞掉的狀態），記者一樣拿得到線索。
    const digestBudget = until - Date.now();
    const digest = digestBudget >= LOOKUP_MIN_MS
      ? await answerFromItriNews(kw, items, question, chinese, digestBudget)
      : '';
    if (digestBudget < LOOKUP_MIN_MS) console.log('[line] 補查官網：預算不夠讀成答案，只附連結');
    const lead = digest
      ? (chinese ? '這題本場的新聞資料裡沒有，不過我在工研院官網新聞中心找到了：'
                 : "This isn't in this event's material, but I found it in ITRI's official newsroom:")
      : (chinese ? '這題本場的新聞資料裡沒有，不過工研院官網新聞中心有相關報導，您可以直接看原文：'
                 : "This isn't in this event's material, but ITRI's official newsroom has related coverage — here are the originals:");
    const body = digest ? `${digest}\n\n${chinese ? '🔗 原文：' : '🔗 Sources:'}\n${links}` : links;
    return `\n\n———\n${lead}\n${body}`;
  } catch (e) {
    console.error('itriNewsHintBlock 失敗:', e.message);
    return '';
  }
}

// 把官網搜到的報導讀成一段答案。組不出來（沒 API key、呼叫失敗、模型說看不出來）
// 就回空字串，呼叫端自動退回「只給連結」——那是原本就有的行為，不會更糟。
async function answerFromItriNews(keyword, items, question, chinese, timeoutMs = LOOKUP_BUDGET_MS) {
  const q = sanitize(question, 300) || keyword;
  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」。',
    `記者問了一個問題，但這場活動的新聞資料裡沒有答案；下面是用「${keyword}」在工研院官網新聞中心查到的報導（標題／日期／摘要）。請根據這些報導直接回答記者的問題。`,
    '',
    '規則：',
    '- 只能根據下面的標題與摘要回答。這些是摘要不是全文，摘要沒寫的細節（完整名單、具體數字、人物職稱）一律不要補完、不要推測——那種內容請記者點原文連結看。',
    '- 摘要裡如果根本沒有記者要的答案，就直接回一個空字串，什麼都不要寫（呼叫端會改成只附連結）。不要寫「查不到」之類的句子，那句話呼叫端已經講過了。',
    '- 回答控制在 3 行以內，並且明確講出這是工研院官網新聞中心的報導、哪一天發布的。',
    '- 不要用 Markdown 語法。不要加結尾警語（呼叫端的回覆裡已經有了）。',
    '- 不要重複「這題本場資料裡沒有」這件事，呼叫端已經講過，直接講你找到什麼。',
    '- 不要反問記者、不要建議「換個關鍵字再查一次」、不要說明你查了什麼卻沒查到——這些都是呼叫端的事。你只有兩種輸出：找得到答案就直接講，找不到就回空字串。',
    chinese
      ? '- 用繁體中文回答。'
      : '- Answer in English (the reporter asked in English).',
    TONE_RULE,
    '',
    `【工研院官網新聞中心 搜尋「${keyword}」的結果，由新到舊】`,
    formatNewsForPrompt(items)
  ].join('\n');

  try {
    // ⚠️ 這一段也要過一次標記清理：這支的規則沒叫模型加 [[NO_DATA:…]]，但同一個
    // 帳號的其他 prompt 有，模型偶爾會把習慣帶過來。漏出去給記者看到的代價太大
    // （批次 33 已經踩過一次），統一清掉比賭它不會發生便宜。
    const raw = String(await askAnthropic(systemPrompt, q, [], { timeoutMs }) || '');
    const reply = extractNoDataKeyword(raw).text.trim();
    // 模型照規則回空字串（摘要裡真的沒有答案），或吐回 askAnthropic 自己的失敗訊息，
    // 兩種都當作「組不出答案」，退回只給連結。
    // 只認「空的」＝模型照規則說摘要裡沒有答案。刻意不設長度門檻——一個「幾個字
    // 以下就丟掉」的魔術數字，會把真的很短但正確的答案（「三位，分別是⋯」）誤殺。
    if (!reply) return '';
    if (/抱歉，目前無法取得回應|系統目前無法回答|無法取得回應/.test(reply)) return '';
    // ⚠️ 規則有叫模型「摘要裡沒答案就回空字串」，但規則是請求、不是保證。實測回報
    // 的截圖裡它改成用一整段話說「我手上資料沒有能直接回答的內容耶⋯⋯建議您換個更
    // 明確的關鍵字」——非空，於是被當成答案用掉，接在「我在工研院官網新聞中心找到
    // 了：」後面，變成前後文自相矛盾的一則回覆（說找到了，內文說沒找到）。
    // 這裡補一道程式面的判斷：這段話本身就是「答不出來」的話，一律當空的處理，
    // 退回只附連結。跟 stripMarkdownForLine() 同一個道理——出口再擋一次比賭它守規矩便宜。
    if (NO_DATA_PHRASE_RE.test(reply) ||
        /沒有.{0,8}(直接)?(回答|對應)|沒有直接相關|換個.{0,6}關鍵字|再幫您查|不太相關|沒有提及/.test(reply)) {
      console.log(`[line] 補查官網：模型自己說答不出來，退回只附連結 kw="${keyword}"`);
      return '';
    }
    return reply;
  } catch (e) {
    console.error('answerFromItriNews 失敗:', e.message);
    return '';
  }
}

async function answerQuestion(replyToken, userId, rawEvent, mediaName, text, { allowPreEventSubstitution = true, switchNotice = '', memory = false, group = false } = {}) {
  // 活動前只給媒體邀請函、不給正式新聞稿與照片（見 lib/prompt.js resolveEventContent()
  // 的說明）。放在這裡而不是呼叫端各自判斷，理由跟下面的邀訪窗口比對一樣：1 對 1、
  // 群組最後都走這支，寫一次兩邊都受惠。
  //
  // ⚠️ 職員模式呼叫這支時會傳 allowPreEventSubstitution:false——同仁需要看到真正的
  // 新聞稿內容準備活動，不能被自己設的「活動前」邏輯反過來卡住自己。
  const event = allowPreEventSubstitution ? resolveEventContent(rawEvent) : rawEvent;

  // ⚠️ 「輸入中」動畫以前在這裡（只有這條路有），批次 60 移到 handleEvent() 的 1 對 1
  // 咽喉點——回報是「動畫只有時候才出現」，而原因就是它只掛在這一支上，產業趨勢、
  // 工研院技術、智慧兜底那幾條（剛好是比較慢的）完全沒有。理由與取捨見那邊的說明。
  // 群組走到這支時本來就不該有動畫（LINE 只支援一對一），移上去之後自然成立，不必再
  // 靠呼叫端記得傳 loading:false。

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
    await replyOrPush(replyToken, userId, reply, eventQuickChips(event, { group }));
    await logQa(event, mediaName, text, reply);
    return;
  }

  // 同仁後續補充／更正（批次 46）。接在新聞稿之後、標明「以這裡為準」——同仁最常用
  // 它更正已經過時的內容（改地點、改時間），只寫「補充資料」的話，模型看到兩個互相
  // 矛盾的說法時不知道該信哪一個。
  const factBlock = formatFactBlock(await getMemories(), event.id);
  const systemPrompt = buildSystemPrompt(event, lineExtraRules(event)) + factBlock;
  // 上一輪對話（只在 1 對 1、且上一輪答的就是這一場時才有東西）——「那成本呢」這種
  // 省略式續問要接得住，靠的就是這兩則；見 buildTurnHistory() 的說明。
  const history = memory ? await buildTurnHistory(userId, event.id) : [];

  // ── 跨場次（批次 36）──────────────────────────────────────────────────
  // 回報的意見：「這一定要切來切去特定活動專屬回答系統嗎？不能一體適用？」
  // 記者問「今年院士有誰」，答案就寫在《工研院院士授證典禮》那場的新聞稿裡——但問答
  // 只讀「目前綁定的這一場」，於是不是答不出來、就是要先切過去。記者根本不該需要知道
  // 「這個問題屬於哪一場」。
  //
  // 主場次照舊完整帶進第一個（吃快取的）system 區塊，另外自動挑幾場真的跟這題有關的
  // 接在第二個區塊——挑選是純字面比對、不呼叫 AI（見 lib/related-events.js 的說明）。
  // 挑不到就是空字串，行為跟改動前完全一樣。
  //
  // ⚠️ 用 allEvents 而不是 buildCalendarCards()：卡片只有 id／名稱／日期，沒有知識庫
  // 全文，比不出「哪一場的內容跟這題有關」。這裡要的就是全文。
  // ⚠️ 一樣過 resolveEventContent()：活動前的場次只能拿邀請函出來，不能因為它是「別
  // 場」就繞過那道限制（見 lib/prompt.js 的說明）。
  let relatedBlock = '';
  try {
    const others = (await getAllEventRows()).map(rowToEvent)
      .filter(isUsable)
      .map(e => resolveEventContent(e));
    const related = selectRelatedEvents(text, others, { exclude: event.id });
    relatedBlock = formatRelatedEventsBlock(related, event.name);
    if (related.length) {
      console.log(`[line] 跨場次帶入 ${related.map(e => e.id).join(',')} q="${text.slice(0, 40)}"`);
    }
  } catch (e) {
    // 跨場次是加分功能，挑選出錯絕對不能讓記者連本場的答案都拿不到。
    console.error('selectRelatedEvents 失敗:', e.message);
  }

  // 活動基本資料（日期／時間／地點／聯絡人＋現在時間）放在第二個、不吃快取的 system
  // 區塊：現在時間每分鐘在變，放進第一塊會讓每一題都重建快取（見 formatEventBasics()）。
  const basicsBlock = formatEventBasics(event);
  const extraSystem = [basicsBlock, relatedBlock].filter(Boolean).join('\n\n');
  const rawReply = await askAnthropic(systemPrompt, text, history, { extraSystem });
  // 標記一定要切掉（不管後面用不用得到那個關鍵詞），見 extractNoDataKeyword() 的 ⚠️。
  const { text: aiReply, keyword: noDataKeyword } = extractNoDataKeyword(rawReply);
  // 這場答不出來時，補查一次工研院官網新聞中心——回報的截圖就是這個洞（見
  // lineExtraRules() 那條規則的說明）。查不到就是空字串，原本的答案照舊。
  // 標記優先（模型抓的關鍵詞語意最準），沒有標記就看回覆內容像不像「我沒有這項資料」，
  // 像的話從問句猜一個關鍵詞——見 NO_DATA_PHRASE_RE 的說明（批次 37）。
  // 兩個來源都算數，依序試（見 itriNewsHintBlock() 的 ⚠️）：標記的語意最準，但模型
  // 常常把整句話塞進去、官網那種接近精準比對的搜尋查不到；猜的比較乾淨、命中率高。
  // 只要其中一個查得到就算數。
  const phraseHit = NO_DATA_PHRASE_RE.test(aiReply);
  const guessed = (noDataKeyword || phraseHit) ? guessNoDataKeyword(text) : '';
  const lookupKeywords = [...new Set([noDataKeyword, guessed].filter(Boolean))];
  if (lookupKeywords.length) {
    console.log(`[line] 補查官網 候選=${JSON.stringify(lookupKeywords)} 標記=${noDataKeyword || '-'} 句型=${phraseHit}`);
  }
  // ⚠️ 補查是**加分**，不能拿已經算出來的答案去賭它（批次 57）。
  // 這條路最壞情況是：官網 HTTP 最多 4 次（2 個候選詞 × 每個查無資料會去語助詞再試
  // 一次，見 lib/itri-news.js）＋ 再一次 Sonnet 把結果讀成答案。答題那段已經花掉的
  // 時間再加上這一串，整支很容易撞到 Vercel 的 60 秒被砍——而被砍掉的那一刻，
  // 上面那句誠實的「這部分我沒有資料」也跟著消失，記者連本來拿得到的答案都沒了。
  // 用剩餘時間當預算：不夠就直接跳過補查，把答案先送出去。
  const lookupBudget = budgetFor(LOOKUP_BUDGET_MS, REPLY_RESERVE_MS);
  const newsHint = (lookupKeywords.length && lookupBudget >= LOOKUP_MIN_MS)
    ? await itriNewsHintBlock(lookupKeywords, { chinese: hasChinese(aiReply), question: text, budgetMs: lookupBudget })
    : '';
  if (lookupKeywords.length && lookupBudget < LOOKUP_MIN_MS) {
    console.log(`[line] 補查官網跳過：這次請求只剩 ${msLeft()}ms，先把答案送出去`);
  }
  const reply = switchNotice + aiReply + newsHint;
  // 診斷用途，不是必要邏輯：路由判斷得準不準、AI 答得順不順，靠這行在 Vercel Logs
  // 裡直接看得到，不用另外接工具。刻意截斷長度，避免整份新聞稿灌爆單行 log。
  console.log(`[line] answer event=${event.id} status=${event.status} q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  // 每則答案都附上這場的快速提問按鈕（同仁自訂的 chips，或沒設定時的預設問題）——
  // 跟網頁版一樣，chips 不是「選過一次就收起來」的一次性選單，而是隨時都在，記者
  // 問完一題還想繼續問別的方向，點一下就好，不用自己想下一句要打什麼。
  await replyOrPush(replyToken, userId, reply, eventQuickChips(event, { group }));
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
  // 記下這一輪，讓下一則的省略式續問接得回來。放在最後（答案早就送出去了）而且
  // setRecentTurn() 自己吞例外——這是體驗加分，寫失敗絕對不能連累剛剛那則答案。
  // 記的是 aiReply 而不是 reply：switchNotice（「已切換到《X》：」）是講給人看的
  // 系統提示，不是對話內容，回放給模型只會變成雜訊。
  // 存 aiReply（已切掉標記、不含補查來的連結區塊）——那些連結是給人點的線索，
  // 回放給模型當對話脈絡只會變成雜訊。
  if (memory) await setRecentTurn(userId, event.id, text, aiReply);
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

// 職員的快速回覆按鈕。LINE 上限 13 顆，這裡用 9 顆——圖文選單那六格全部列出來
// （選單被收起來時仍然點得到），再加「設定圖文選單」這顆選單本身放不進去的。
// 原本只給兩顆（活動列表／GEO 狀態），其餘功能同仁得自己知道要打什麼才用得到，
// 等於功能做了卻沒人找得到。
//
// 「最近有哪些新聞」「記憶清單」是回報「職員模式不好用」之後補的：前者是官網最新
// 新聞稿（同仁問得最多的東西之一，原本職員模式完全叫不到），後者是「用對話教米亞」
// 那套（批次 46 做好了，但除了 LINE-PLAN.md 之外沒有任何入口寫著怎麼叫它）。
// 這兩個補的都不是新功能，是**入口**——見 LINE-PLAN.md 批次 51 的教訓。
//
// 「使用說明」也在這裡：sendFallbackGuide() 的職員版尾巴一直叫同仁「打『使用說明』
// 可以看內部功能」，卻沒有任何一顆按鈕點得到——功能有、入口沒有，又是同一個形狀。
// 批次 77：選單重排後「要媒體訓練連結」「退出職員模式」不在六格裡了，補回按鈕列——
// 換掉的入口不會真的消失，只是不再佔選單的一格（批次 21 的原則）。
const STAFF_QUICK_REPLIES = [...new Set([
  ...STAFF_MENU.buttons.map(b => b.text), '要媒體訓練連結', '設定圖文選單',
  '最近有哪些新聞', '記憶清單', '使用說明', '退出職員模式'
])];

// 職員的按鈕列：把當下最相關的幾顆排到最前面，後面一律接上整套入口。
//
// 回報：職員模式裡按「記憶清單」，回覆底下只剩孤零零一顆「最近有哪些活動」。
// 兩個問題疊在一起——
//   ① 那顆跟「記憶」完全無關，是記者端的按鈕；
//   ② 更要命的是**按了一顆按鈕，其他八個入口就消失了**。
// 同仁是從九顆按鈕裡點進來的，回來只剩一顆，看起來像被降級了。
//
// 這跟批次 52（職員模式取代記者模式、能力整批不見）是同一個形狀，只是這次縮水的
// 是入口不是能力。所以規則定死：**職員模式的每一則回覆都帶著整套入口**，情境按鈕
// 只是排在前面，不是拿來取代它。去重後砍到 LINE 的 13 顆上限。
function staffChips(...front) {
  return [...new Set([...front.filter(Boolean), ...STAFF_QUICK_REPLIES])].slice(0, 13);
}

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
    await replyOrPush(replyToken, userId, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法建立圖文選單。', staffChips());
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
      '記者不會看到職員那一套。已經加過好友的人可能要把對話關掉重開才會看到。',
      staffChips());
  } catch (e) {
    console.error('設定圖文選單失敗:', e.message);
    await replyOrPush(replyToken, userId, `設定圖文選單失敗：${e.message}\n\n請確認 LINE_CHANNEL_ACCESS_TOKEN 有效，且網站已部署最新版本。`, staffChips());
  }
}

// 職員模式指令分派（批次 4）。跟 handleUnbound 的差異：
//   - qa 意圖不套用 isUsable()——同仁本來就該問得到 draft／archived 場次的內容
//   - 不做軟綁定：職員一次對話常常在不同活動之間跳來跳去（查完 A 場數據又問 B 場
//     內容），鎖定單一活動反而綁手綁腳
//   - 多了 geo_status／event_analytics／create_event／training_link 四種指令
// 同仁按下的確認鈕送出的字串。用完整句子而不是「是／否」——這兩顆按鈕會留在對話
// 紀錄裡，隔天滑回去按到「是」卻不記得在確認什麼，比按不到更糟。
const TEACH_YES = '✅ 記起來';
const TEACH_NO = '✖ 不用記';

// 回傳 true 代表這則訊息已經被當成「教學指令」處理完了，呼叫端不要再往下走。
async function handleTeachMessage(replyToken, userId, text) {
  const s = String(text || '').trim();
  const mems = await getMemories();

  // 確認／取消：把最近一筆 pending 收掉。只收「這個人自己」剛剛留下的那一筆——
  // 兩位同仁同時在教的時候，不能互相確認到對方的內容。
  if (s === TEACH_YES || s === TEACH_NO) {
    const mine = mems.filter(m => m.status === MEM_PENDING && m.by === userId);
    const last = mine[mine.length - 1];
    if (!last) {
      await replyOrPush(replyToken, userId, '沒有等著確認的內容喔。', staffChips('記憶清單'));
      return true;
    }
    await setMemoryStatus(last.rowNumber, s === TEACH_YES ? MEM_ON : MEM_OFF);
    await replyOrPush(replyToken, userId,
      s === TEACH_YES ? `好，我記起來了 ✅\n「${last.text}」\n\n以後回答都會照這個來。要查或取消，打「記憶清單」。`
                      : '好，那就當作沒這回事 👌',
      staffChips('記憶清單'));
    return true;
  }

  const cmd = parseMemoryCommand(s);
  if (!cmd) return false;

  // 批次 76：「改成下午兩點開始」「請改一下這場的地點」是在改活動資料，不是在教米亞
  // 說話方式。舊版會把它記成全站語氣規則，套用到每一場（見 lib/bot-memory.js
  // looksLikeFieldChange() 的說明）。這裡不存任何東西，只指路。
  // 批次 78 起不在這裡回覆，交回呼叫端：這句話多半是「改資料」，交給職員路由的
  // update_event 走確認流程；路由也接不住時，呼叫端再送下面那段 FIELD_HINT_TEXT。
  if (cmd.kind === 'field_hint') return 'field_hint';

  if (cmd.kind === 'list') {
    // 清單是空的時候，下一步是「怎麼教」——職員版的「使用說明」裡有【教米亞】那段。
    // 刻意不做「記住：⋯⋯」按鈕：快速回覆是把固定字串直接送出去，送一句沒有內容的
    // 「記住：」只會換來一次聽不懂。
    const empty = !(mems || []).some(m => m.status === MEM_ON);
    await replyOrPush(replyToken, userId, formatMemoryList(mems),
      empty ? staffChips('使用說明') : staffChips());
    return true;
  }

  if (cmd.kind === 'forget') {
    const active = mems.filter(m => m.status === MEM_ON);
    const target = active[cmd.index - 1];
    if (!target) {
      await replyOrPush(replyToken, userId, `沒有第 ${cmd.index} 條喔，先打「記憶清單」看一下編號。`, staffChips('記憶清單'));
      return true;
    }
    await setMemoryStatus(target.rowNumber, MEM_OFF);
    await replyOrPush(replyToken, userId, `已經忘記這條 🗑\n「${target.text}」`, staffChips('記憶清單'));
    return true;
  }

  // cmd.kind === 'save'
  if (mems.filter(m => m.status === MEM_ON).length >= MEMORY_MAX_ACTIVE) {
    await replyOrPush(replyToken, userId,
      `我記的東西已經到上限（${MEMORY_MAX_ACTIVE} 條）了。這些內容每一題都會帶進去，太多會讓我變慢也變貴——請先打「記憶清單」忘記幾條再教我。`,
      staffChips('記憶清單'));
    return true;
  }

  // scope 'event' 代表「記在同仁現在綁定的那一場」。沒綁定就問一下是哪一場，
  // 不要默默記成全站——那是兩件完全不同的事。
  let scope = cmd.scope;
  let scopeName = '';
  if (scope === 'event') {
    const binding = await getBinding(userId);
    let current = binding?.event_id ? await getEventById(binding.event_id) : null;
    // 批次 75（四角色模擬）：同事打「記住：眺望研討會的新聞聯絡人是⋯⋯」，句子裡已經講了
    // 是哪一場，卻還被要求「先切到那一場再講一次」。沒綁定時先看句子點名了哪一場，
    // 只認得出唯一一場才用；認不出、或同時像好幾場，照舊問。
    if (!isUsable(current)) {
      const named = findEventMentioned(cmd.text, buildAllCalendarCards(await getAllEventRows()));
      if (named) current = await getEventById(named.id);
    }
    if (!isUsable(current)) {
      await replyOrPush(replyToken, userId,
        '要記在哪一場呢？請先打活動名稱切到那一場，再跟我說一次。\n\n（如果這件事是所有場次都適用的，改打「全站記住：⋯⋯」）',
        staffChips('最近有哪些活動'));
      return true;
    }
    scope = current.id;
    scopeName = current.name || '';
  }

  await addMemory({
    scope, type: cmd.type, text: cmd.text, by: userId,
    status: cmd.confirm ? MEM_PENDING : MEM_ON
  });

  if (cmd.confirm) {
    // 自然語句：先問一次再生效。理由見 lib/bot-memory.js 開頭的 ⚠️。
    // ⚠️ 這是整個職員模式**唯一**刻意不帶整套入口的一則：這一刻只有「記／不記」兩條路，
    // 旁邊擺一排別的出口只會讓人點走、留下一筆永遠 pending 的內容。不要順手統一掉。
    await replyOrPush(replyToken, userId,
      `這句話要我以後都照做嗎？\n「${cmd.text}」\n\n（會套用到所有場次的每一個回答）`, [TEACH_YES, TEACH_NO]);
  } else {
    const where = cmd.type === 'style' ? '所有回答' : (scope === 'global' ? '所有場次' : (scopeName ? `《${scopeName}》這一場` : '這一場'));
    await replyOrPush(replyToken, userId,
      `記起來了 ✅\n「${cmd.text}」\n\n之後${where}都會照這個來。要查或取消，打「記憶清單」。`,
      staffChips('記憶清單'));
  }
  console.log(`[line] 教學 user=${userId} type=${cmd.type} scope=${scope} confirm=${cmd.confirm} text="${cmd.text.slice(0, 40)}"`);
  return true;
}

// ── 活動卡／填寫進度／催填（批次 77）──────────────────────────────────────
// 按鈕與卡片送出的固定句型。用字面比對、不交給模型：這些字串都是我們自己按鈕送出的，
// 100% 認得出來，還省一次模型呼叫（lib/menu.js 開頭同一個道理）。
const PROGRESS_RE = /^(活動與進度|活動進度|填寫進度|看填寫進度|查填寫進度|填寫狀況|活動填寫狀況|哪幾場還沒填完)[?？。!！]?$/;
const UPDATE_ENTRY_RE = /^(更新活動|修改活動|更新活動資訊|修改活動資訊|改活動資料)[?？。!！]?$/;
const CARD_CMD_RE = /^(催填|數據|活動卡|發布)\s*[:：]\s*(.+)$/;

// Flex 訊息要自己帶快速回覆（replyOrPushMessages 收的是原始物件，不會幫忙轉）。
// 格式跟 lib/line.js buildQuickReply() 一樣：最多 13 顆、label 最長 20 字。
function quickReplyOf(items) {
  const list = (items || []).filter(Boolean).slice(0, 13);
  if (!list.length) return undefined;
  return {
    items: list.map(item => {
      const label = String(typeof item === 'object' ? item.label : item);
      const text = String(typeof item === 'object' ? (item.text ?? item.label) : item);
      return { type: 'action', action: { type: 'message', label: label.length > 20 ? label.slice(0, 19) + '…' : label, text: text.slice(0, 300) } };
    })
  };
}

// 卡片上的字有一部分是同仁在後台打的（活動名稱、地點）。新的出口一律接上繁體防線
// （CLAUDE.md 第 1 條）——只轉顯示用的 text／altText／label，不動網址與送出的指令字串。
function twFlex(node) {
  if (Array.isArray(node)) return node.map(twFlex);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = (k === 'text' && node.type !== 'message') || k === 'altText' || k === 'label'
      ? (typeof v === 'string' ? toTraditionalTW(v) : v)
      : twFlex(v);
  }
  return out;
}

async function sendProgressOverview(replyToken, userId) {
  const { text, names } = formatProgressOverview(await getAllEventRows(), todayTaipei());
  await replyOrPush(replyToken, userId, text, staffChips(...names));
}

// 活動卡：同仁點了活動名稱、或卡片上的按鈕指回這一場時看到的那張。
async function sendEventCard(replyToken, userId, eventId) {
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  const [editCode, stats] = await Promise.all([ensureEventEditCode(eventId), getEventStats(eventId)]);
  const links = {
    edit: editCode ? editLink(eventId, editCode) : '',
    training: editCode ? trainingLink(eventId, editCode) : '',
    preview: previewLink(eventId)
  };
  const chips = staffChips({ label: '問米亞這場', text: `${c.name}的重點是什麼` }, '活動與進度');
  const flex = twFlex(buildEventCardFlex(c, stats, links));
  flex.quickReply = quickReplyOf(chips);
  const ok = await replyOrPushMessages(replyToken, userId, [flex]);
  // Flex 送不出去（舊版 LINE、格式被拒）退回純文字，跟 GEO 簡報卡同一套降級
  if (!ok) await replyOrPush(replyToken, userId, formatEventCardText(c, stats, links), chips);
}

// 催填訊息：兩則。第二則單獨成一個泡泡，同仁長按「轉傳」只會轉那一則。
async function sendNudge(replyToken, userId, eventId) {
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === eventId);
  const editCode = row ? await ensureEventEditCode(eventId) : null;
  if (!row || !editCode) {
    await replyOrPush(replyToken, userId, '這場活動的編輯連結產生失敗，請稍後再試。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  const nudge = { type: 'text', text: toTraditionalTW(formatNudgeMessage(c, editLink(eventId, editCode))) };
  nudge.quickReply = quickReplyOf(staffChips('活動與進度'));
  const ok = await replyOrPushMessages(replyToken, userId, [
    { type: 'text', text: '下面這則可以直接長按「轉傳」給負責填寫的同仁 👇' },
    nudge
  ]);
  if (!ok) await replyOrPush(replyToken, userId, nudge.text, staffChips('活動與進度'));
}

// 卡片按鈕送出的「催填：活動名稱」要找回是哪一場。只收名稱完全相同（正規化後）的
// 那一場——那是我們自己的按鈕送出來的，對不上就代表活動剛被改名，不猜。
function findCardByExactName(name, cards) {
  const norm = s => String(s || '').replace(/[\s　《》「」]/g, '');
  const hits = cards.filter(c => norm(c.name) === norm(name));
  return hits.length === 1 ? hits[0] : null;
}

// ── 在 LINE 改資料、發布、復原（批次 78）────────────────────────────────────
// 確認鈕用完整句子，不用「是／否」：這兩顆按鈕會留在對話紀錄裡，隔天滑回去按到，
// 也要看得出是在確認什麼（跟 TEACH_YES 同一個理由）。過了 10 分鐘，按了只會得到
// 「沒有等著確認的修改」，不會改到任何東西。
const CONFIRM_UPDATE = '✅ 確認修改';
const CANCEL_UPDATE = '✖ 取消修改';
const CONFIRM_PUBLISH = '🚀 確認發布';
const CANCEL_PUBLISH = '✖ 先不發布';
const UNDO_RE = /^(復原上一個修改|復原|還原上一個修改|取消上一個修改|改回來|改回去)[。!！]?$/;

const FIELD_HINT_TEXT =
  '這句看起來是要改活動資料，我沒有把它記成規則，不然會套用到所有場次 🙏\n\n' +
  '要改的話請說是哪一場，例如「智慧醫療那場改到下午兩點」，我會先跟你確認再改。\n' +
  '只想讓米亞知道、不改資料：打「記住：」加上活動名稱和內容。';

// 有人在 LINE 改了記者看得到的資料 → 通知管理員（批次 76 決定 5：職員不分權限，
// 所以每次修改都要讓管理員知道，密語外流被亂改時才來得及發現）。
async function notifyAdminOfChange(userId, text) {
  const ownerId = process.env.LINE_ADMIN_USER_ID;
  if (!ownerId || ownerId === userId) return;
  try { await pushMessage(ownerId, text); } catch (e) { console.error('通知管理員失敗:', e.message); }
}

async function proposeUpdate(replyToken, userId, eventId, field, value, { raw = false, undo = false } = {}) {
  const r = await proposeChange(eventId, field, value, { raw });
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  const p = r.proposal;
  await setStaffPending(userId, 'update_confirm', p);
  // ⚠️ 跟教米亞的確認句一樣，這一則刻意**只有兩顆按鈕**：這一刻只有改／不改兩條路，
  // 旁邊擺一排別的出口只會讓人點走、留下一筆懸著的修改。
  // 批次 80：改到今天以前的日期多半是打錯（或年份猜錯），確認句先講清楚
  const pastWarn = field === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(p.after) && p.after < todayTaipei()
    ? '\n\n⚠️ 這個日期已經過了，確定沒打錯嗎？' : '';
  await replyOrPush(replyToken, userId,
    `${undo ? '復原上一個修改：\n' : ''}要把《${p.eventName}》的${fieldLabel(field)}\n從「${displayValue(field, p.before)}」\n改成「${displayValue(field, p.after)}」嗎？${pastWarn}\n\n改了以後，記者問米亞、活動網頁都會跟著更新。`,
    [CONFIRM_UPDATE, CANCEL_UPDATE]);
}

async function proposePublish(replyToken, userId, eventId) {
  const row = (await getAllEventRows()).find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名了。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  if (c.status !== 'draft') {
    await replyOrPush(replyToken, userId, `《${c.name}》已經是${displayValue('status', c.status)}，記者本來就問得到。`, staffChips({ label: '看這場的活動卡', text: c.name }));
    return;
  }
  // 朱朱的決定（批次 76 決定 2）：先過檢查清單。必填沒齊就不給發布——記者問得到卻什麼
  // 都答不出來，比晚一點發布更糟。
  if (c.missingRequired.length) {
    await replyOrPush(replyToken, userId,
      `《${c.name}》還不能發布，必填還缺：${c.missingRequired.join('、')}。\n\n補齊之後再按一次「發布」就可以。`,
      staffChips({ label: '產生催填訊息', text: `催填：${c.name}` }, { label: '看這場的活動卡', text: c.name }));
    return;
  }
  const r = await proposeChange(eventId, 'status', 'active');
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  await setStaffPending(userId, 'publish_confirm', r.proposal);
  await replyOrPush(replyToken, userId,
    `要發布《${c.name}》嗎？\n${c.date ? `活動日期：${dateWithWeekday(c.date)}\n` : ''}\n發布後記者在 LINE 和活動網頁都問得到這一場。`,
    [CONFIRM_PUBLISH, CANCEL_PUBLISH]);
}

// ── 傳照片給米亞（批次 79）─────────────────────────────────────────────
// 活動現場拍完，直接在 LINE 傳給米亞，不用回電腦開編輯頁上傳。只有職員可以。
// 一次傳好幾張時，LINE 會一張一張送 webhook：每一張都接進同一個「等著選場次」的清單，
// 選一次就全部加進去。
// 批次 80：照片清單改存 lib/photo-inbox.js（每張一列），理由見那支檔案開頭。
async function handleStaffImage(replyToken, userId, messageId) {
  const count = await addPhoto(userId, messageId);
  await setStaffPending(userId, 'photo_pick');
  const cards = buildAllCalendarCards(await getAllEventRows());
  await replyOrPush(replyToken, userId,
    `收到 ${count} 張照片 📷 要加到哪一場？點下面的活動。\n（還有照片的話可以繼續傳，選一次就一起加；不加了就回「不用了」）`,
    // 補照片常常是活動隔天的事：辦完兩週內的場次也列
    staffChips(...staffPickList(cards, 8, { includePast: true, pastDays: 14 }).map(c => c.name)));
}

async function addPhotosToEvent(replyToken, userId, eventId, messageIds) {
  await startLoading(userId, 45);
  const urls = [];
  let failed = 0;
  for (const id of messageIds) {
    try { urls.push(await saveEventPhoto(eventId, id)); }
    catch (e) { failed++; console.error(`存照片失敗 msg=${id}:`, e.message); }
  }
  if (!urls.length) {
    await replyOrPush(replyToken, userId,
      '照片沒能存起來 🙏 可能是 LINE 的檔案已經過期，或暫時連不上。請再傳一次，或到編輯頁用「上傳照片檔案」。',
      staffChips('活動與進度'));
    return;
  }
  const userName = await getStaffName(userId);
  const r = await appendEventPhotos(eventId, urls, { userId, userName });
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  invalidateEventsCache();
  const ev = await getEventById(eventId);
  // 活動前（有邀請函）記者拿不到照片，是設計好的（lib/prompt.js resolveEventContent），
  // 先講清楚，不然同仁會以為沒加成功
  const preEvent = ev && isPreEventMode(ev) ? '\n\n（這場還在活動前，記者要到活動當天才拿得到照片）' : '';
  await replyOrPush(replyToken, userId,
    `已把 ${urls.length} 張照片加進《${r.eventName}》✅ 現在共 ${r.total} 張。${failed ? `\n另外 ${failed} 張沒存成功，要的話請再傳一次。` : ''}${preEvent}\n\n要拿掉或加圖說，請到編輯頁的「圖片資源」。`,
    staffChips({ label: '看這場的活動卡', text: r.eventName }, '活動與進度'));
  await notifyAdminOfChange(userId,
    `📷 活動照片被新增\n《${r.eventName}》加了 ${urls.length} 張\n加的人：${userName || '（沒有名字）'}\nLINE ID：${userId}`);
}

// 回傳 true＝這則訊息已經處理完。
async function handleEditFlow(replyToken, userId, text, pendingData, cards) {
  const pending = pendingData?.intent || null;
  const payload = pendingData?.payload || null;
  const s = String(text || '').trim();

  if (s === CONFIRM_UPDATE || s === CONFIRM_PUBLISH) {
    const want = s === CONFIRM_UPDATE ? 'update_confirm' : 'publish_confirm';
    if (pending !== want || !payload) {
      await replyOrPush(replyToken, userId, '沒有等著確認的修改喔（超過 10 分鐘會自動取消）。要改的話再說一次就好。', staffChips('活動與進度'));
      return true;
    }
    const userName = await getStaffName(userId);
    const r = await applyChange(payload, { userId, userName });
    if (!r.ok) {
      await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
      return true;
    }
    invalidateEventsCache();
    const name = payload.field === 'name' ? payload.after : payload.eventName;
    const change = `${fieldLabel(payload.field)}：「${displayValue(payload.field, payload.before)}」→「${displayValue(payload.field, payload.after)}」`;
    console.log(`[line] 職員修改 user=${userId} event=${payload.eventId} field=${payload.field}`);
    await replyOrPush(replyToken, userId,
      payload.field === 'status' && payload.after === 'active'
        ? `已發布 ✅《${name}》\n記者現在問得到這一場了。`
        : `已更新 ✅《${name}》\n${change}`,
      staffChips({ label: '看這場的活動卡', text: name }, '復原上一個修改'));
    await notifyAdminOfChange(userId,
      `✏️ 活動資料被修改\n《${name}》\n${change}\n改的人：${userName || '（沒有名字）'}\nLINE ID：${userId}\n\n不是你認識的人改的，可以到試算表 event_changes 分頁查紀錄。`);
    return true;
  }
  if (s === CANCEL_UPDATE || s === CANCEL_PUBLISH) {
    await replyOrPush(replyToken, userId, s === CANCEL_PUBLISH ? '好，先不發布 👌' : '好，沒有改 👌', staffChips('活動與進度'));
    return true;
  }

  if (UNDO_RE.test(s)) {
    const last = await findLastChangeBy(userId);
    if (!last) {
      await replyOrPush(replyToken, userId, '你最近沒有在 LINE 上改過活動資料，沒有東西可以復原。', staffChips('活動與進度'));
      return true;
    }
    await proposeUpdate(replyToken, userId, last.eventId, last.field, last.before, { raw: true, undo: true });
    return true;
  }

  // 批次 79：同仁剛傳了照片，這一則是「要加到哪一場」
  if (pending === 'photo_pick') {
    const photos = await pendingPhotos(userId);
    if (photos.length && isCancelReply(s)) {
      await consumePhotos(photos);
      await replyOrPush(replyToken, userId, '好，照片沒有加 👌', staffChips('活動與進度'));
      return true;
    }
    const target = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (photos.length && target) {
      await consumePhotos(photos); // 先標記用掉：就算下面上傳失敗，也不會下次選場次時又被加一次
      await addPhotosToEvent(replyToken, userId, target.id, photos.map(p => p.messageId));
      return true;
    }
  }

  // 上一則問了「要改／發布哪一場」，這一則是場次名稱
  if ((pending === 'update_pick' && payload) || pending === 'publish_pick') {
    if (isCancelReply(s)) {
      await replyOrPush(replyToken, userId, '好，沒有改 👌', staffChips('活動與進度'));
      return true;
    }
    const target = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (target) {
      if (pending === 'publish_pick') await proposePublish(replyToken, userId, target.id);
      else await proposeUpdate(replyToken, userId, target.id, payload.field, payload.value);
      return true;
    }
  }
  return false;
}

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

  // ── 用對話教米亞（批次 46）────────────────────────────────────────────
  // ⚠️ 一定要排在 routeStaffIntent() 之前，而且用字面比對——跟 isExitStaffCommand()
  // 同一個理由：「這句話會不會被寫進知識庫、讓每個記者都讀到」，不該取決於模型當下
  // 判得準不準。
  const teach = await handleTeachMessage(replyToken, userId, text);
  if (teach === true) return;
  const fieldHint = teach === 'field_hint';

  // ── 職員 ＝ 記者 ＋ 管理，不是「另一個世界」（回報：「職員模式要重新思考改進，
  // 不好用」）────────────────────────────────────────────────────────────
  // 回報的截圖：在職員模式問「最近有發什麼新聞稿」，拿回來的是一份職員功能清單。
  //
  // 根因是結構性的：職員模式**取代**了記者模式，而不是疊在它上面。走到這支之後，
  // 每一則訊息都只過 routeStaffIntent() 那七個管理意圖，記者端有的東西——最新
  // 新聞稿、產業趨勢、工研院技術、邀訪窗口——一個都叫不到，全部落進 'other'，
  // 換來一面功能清單的牆。公關同仁本來就是這個帳號用得最兇的人，卻是能力最少的人。
  //
  // 修法：記者端有、管理端沒有的那幾種意圖，直接共用記者端整套處理。用
  // detectMetaIntent() 的字面比對先攔，不進 routeStaffIntent()——順便省一次模型呼叫。
  //
  // ⚠️ 'calendar' 刻意**不**在這裡短路。職員的「所有場次的後台數據」也會命中
  // CALENDAR_RE（「所有…場次」），短路掉就再也查不到後台數據了——那條要留給
  // routeStaffIntent() 用語意判。六顆職員按鈕會不會被這裡誤攔，測試有釘住。
  const metaIntent = detectMetaIntent(text);
  if (metaIntent === 'news' || metaIntent === 'industry_trend'
      || metaIntent === 'tech_query' || metaIntent === 'contacts' || metaIntent === 'org_intro') {
    console.log(`[line] staff 借用記者端意圖 intent=${metaIntent} q="${text.slice(0, 40)}"`);
    await handleMetaIntent(replyToken, userId, text, metaIntent, null, {});
    return;
  }
  if (metaIntent === 'help' || metaIntent === 'switch') {
    // 職員的「使用說明／回首頁」＝職員功能表，不是記者那份說明影片。
    await sendStaffMenu(replyToken, userId);
    return;
  }

  const rows = await getAllEventRows();
  // 職員要用「全部場次」的候選清單，不能用記者版的 buildCalendarCards()——
  // 那支會濾掉 draft／archived，職員問得到的場次卻不在候選清單裡，路由回傳的
  // event_id 會被 routeStaffIntent() 自己的白名單過濾掉，變成「查得到內容、卻永遠
  // 比對不到活動」。見 lib/router.js 的註解。
  const cards = buildAllCalendarCards(rows);
  const cardName = id => cards.find(c => c.id === id)?.name || id;
  // 批次 76：沒指定候選時用 staffPickList()（接下來要辦的在前、封存的不列）。舊版拿
  // 試算表前 8 列＝最舊的 8 場。後面一律接上整套職員入口（批次 54 的規則）。
  // 批次 80：預設只列還沒過期的——改資料、發布、要訓練連結都用不到辦完的場次。
  // 查成效（活動後才看）另外傳 { includePast: true }。
  const eventQuickReplies = (ids, pickOpts = { includePast: false }) =>
    staffChips(...(ids && ids.length ? ids.map(cardName) : staffPickList(cards, 8, pickOpts).map(c => c.name)));

  // ⚠️ 承接上一則的追問。實際回報的 bug：打「查活動後台數據」→ 系統問「哪一場？」→
  // 打「四足」→ 卻跑去回答四足那場的活動內容。
  //
  // 職員模式原本每一則訊息都各自重新路由一次，完全沒有記憶。「四足」單獨看就是一個
  // 活動名稱，模型判成 qa 完全合理——問題不在模型判錯，而在沒有人告訴它「上一句我問
  // 的是哪一場的後台數據」。所以這裡先把 pending 讀回來（讀取免費，isStaffAuthenticated
  // 本來就要讀同一批列），再用它覆寫這次的意圖。
  // 批次 78：追問可能帶著資料（等確認的那筆修改），要在清掉之前讀出來
  const pendingData = await getStaffPendingData(userId);
  const pending = pendingData?.intent || null;
  if (pending) await setStaffPending(userId, ''); // 一次性，用掉就清

  // ── 批次 78：修改／發布的確認、復原、選場次 ────────────────────────────────
  if (await handleEditFlow(replyToken, userId, text, pendingData, cards)) return;

  // ── 批次 77：選單與活動卡按鈕送出的固定句型，字面比對直接處理 ─────────────
  if (PROGRESS_RE.test(text)) {
    await sendProgressOverview(replyToken, userId);
    return;
  }
  if (UPDATE_ENTRY_RE.test(text)) {
    await replyOrPush(replyToken, userId,
      '名稱、日期、時間、地點、新聞聯絡人可以直接跟我說，例如「智慧醫療那場地點改成南港展覽館」，我會先跟你確認再改。\n\n' +
      '新聞稿、邀請函、照片：點下面的活動，在活動卡上按「✏️ 開啟編輯頁」；要請別人填，按「📨 催填訊息」。',
      eventQuickReplies());
    return;
  }
  const cardCmd = text.match(CARD_CMD_RE);
  if (cardCmd) {
    const target = findCardByExactName(cardCmd[2], cards);
    if (!target) {
      await replyOrPush(replyToken, userId, `找不到《${cardCmd[2].slice(0, 40)}》這場，可能剛被改名了。從清單再點一次：`, eventQuickReplies());
      return;
    }
    if (cardCmd[1] === '催填') return sendNudge(replyToken, userId, target.id);
    if (cardCmd[1] === '發布') return proposePublish(replyToken, userId, target.id);
    if (cardCmd[1] === '數據') {
      const summary = await getEventAnalyticsSummary(target.id, target.name);
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary), staffChips('活動與進度'));
      return;
    }
    return sendEventCard(replyToken, userId, target.id);
  }
  // 點了清單上的活動名稱（整句就是某一場的名稱）→ 活動卡。帶著問題的（「某某那場的
  // 重點」）不會命中 matchEventByName()，照舊交給下面的路由讓米亞回答。
  // ⚠️ 等「哪一場」答案的時候（pending 查數據／要訓練連結）不攔：那時候點名稱是在回答問題。
  if (!['event_analytics', 'training_link', 'create_event', 'update_pick', 'publish_pick', 'photo_pick'].includes(pending)) {
    // 批次 80：先比「名稱完全相同」。matchEventByName() 要求至少 6 個字，「眺望研討會」
    // 這種短名稱點了清單按鈕會對不上，被當成主題詞問「要查產業趨勢還是技術」。
    const tapped = findCardByExactName(text, cards) || matchEventByName(text, cards);
    if (tapped) {
      await sendEventCard(replyToken, userId, tapped.id);
      return;
    }
  }

  const routed = await routeStaffIntent(text, cards);

  // 批次 76：米亞剛問「新活動叫什麼名字」，同仁回的是「算了／不用了／取消」。舊版把這句
  // 當成名稱，建出一場叫「算了」的草稿。取消用字面比對攔下（不交給模型判）。
  if (pending === 'create_event' && (isCancelReply(text) || detectCourtesy(text))) {
    console.log(`[line] staff 取消新增活動 q="${text.slice(0, 40)}"`);
    await replyOrPush(replyToken, userId, '好，先不建立 👌 要建的時候再按「新增活動」就可以。', staffChips());
    return;
  }

  if (pending) {
    // 批次 75（四角色模擬）：舊版不管這一則是什麼都當成新活動名稱。同事被問「新活動叫
    // 什麼」之後改口要「智慧醫療那場的媒體訓練連結」，結果建出一場叫這個名字的活動。
    // 模型已經明確判成別的管理指令（查數據、要連結、看 GEO、查清單）時，就照那個指令做。
    const CLEAR_STAFF_INTENTS = ['calendar', 'event_analytics', 'training_link', 'geo_status', 'setup_richmenu'];
    if (pending === 'create_event' && routed.intent !== 'create_event' && !CLEAR_STAFF_INTENTS.includes(routed.intent)) {
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

  // 追問時附上活動名稱按鈕：點按鈕送出的是完整活動名稱，模型比對得到、pending 也
  // 還在，兩條路都通。只列有意義的前幾場，LINE 上限 13 顆。

  // 批次 77：職員的「活動列表」就是「活動與進度」——同一份清單，每場多寫一行還缺什麼。
  // 同仁看清單本來就是為了知道「接下來要處理哪一場」。
  if (routed.intent === 'calendar' || routed.intent === 'progress') {
    await sendProgressOverview(replyToken, userId);
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

  // 批次 78：在 LINE 直接改資料。模型只負責聽懂「哪一場、哪一欄、改成什麼」；能不能改、
  // 格式對不對、改前是什麼，全部由 lib/event-edit.js 決定，而且一定先給人按確認。
  if (routed.intent === 'update_event') {
    if (!routed.update_field || !routed.update_value) {
      await replyOrPush(replyToken, userId,
        '要改哪一場的什麼？直接說就好，例如：\n・智慧醫療那場地點改成南港展覽館\n・眺望研討會改到 10/30\n・奈米那場的新聞聯絡人換成王小明 0912-345-678\n\n在 LINE 可以改：名稱、日期、時間、地點、新聞聯絡人。新聞稿、邀請函、照片請按活動卡上的「開啟編輯頁」。',
        eventQuickReplies());
      return;
    }
    if (routed.event_ids.length === 1) {
      await proposeUpdate(replyToken, userId, routed.event_ids[0], routed.update_field, routed.update_value);
      return;
    }
    await setStaffPending(userId, 'update_pick', { field: routed.update_field, value: routed.update_value });
    await replyOrPush(replyToken, userId,
      `要改哪一場的${fieldLabel(routed.update_field)}（改成「${routed.update_value}」）？點下面的活動，或打活動名稱。`,
      eventQuickReplies(routed.event_ids));
    return;
  }

  if (routed.intent === 'publish') {
    if (routed.event_ids.length === 1) {
      await proposePublish(replyToken, userId, routed.event_ids[0]);
      return;
    }
    await setStaffPending(userId, 'publish_pick');
    await replyOrPush(replyToken, userId, '要發布哪一場？點下面的活動，或打活動名稱。', eventQuickReplies(routed.event_ids));
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
      await replyOrPush(replyToken, userId,
        '請告訴我新活動的名稱，直接打名稱就好，例如：\n半導體先進封裝技術發表會\n\n（可以順便帶日期，例如「眺望研討會 10/28」；不建了就回「算了」）',
        staffChips());
      return;
    }
    const created = await createDraftEvent(routed.new_event_name, routed.new_event_date);
    invalidateEventsCache();
    console.log(`[line] 職員新增活動 id=${created.id} name="${created.name}"`);
    const dateLine = dateWithWeekday(routed.new_event_date);
    // 批次 76：舊版寫「要到後台按『發布』」——後台要密碼，而同仁編輯頁本來就能發布。
    await replyOrPush(replyToken, userId,
      `已建立《${created.name}》✅\n日期：${dateLine || '未定（在編輯頁補上）'}\n狀態：未發布，記者還看不到\n\n` +
      `同仁編輯連結（轉給負責的同仁，不需要後台密碼）：\n${editLink(created.id, created.editCode)}\n\n` +
      '內容填好後，在編輯頁把「活動狀態」改成「進行中」，記者就問得到了。',
      staffChips({ label: '看這場的活動卡', text: created.name }, '活動與進度'));
    return;
  }

  if (routed.intent === 'event_analytics' || routed.intent === 'training_link') {
    const what = routed.intent === 'event_analytics' ? '後台數據' : '媒體訓練連結';
    if (routed.event_ids.length === 0) {
      // 記下「我正在等他回答哪一場」，否則他打「四足」會被重新判成問活動內容
      await setStaffPending(userId, routed.intent);
      await replyOrPush(replyToken, userId,
        `請問是想查哪一場的${what}？直接打活動名稱，或點下面的按鈕。`,
        eventQuickReplies(null, { includePast: routed.intent === 'event_analytics' }));
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
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary), staffChips());
    } else {
      // 舊活動可能還沒有編輯碼，當場補一個（冪等），不要把同仁踢回後台自己弄一次
      const editCode = await ensureEventEditCode(eventId);
      if (!editCode) {
        await replyOrPush(replyToken, userId, '這場活動的編輯碼產生失敗，請稍後再試，或到後台開啟一次該活動的編輯連結。', staffChips());
        return;
      }
      await replyOrPush(replyToken, userId,
        `《${cardName(eventId)}》\n\n媒體訓練（發言練習）：\n${trainingLink(eventId, editCode)}\n\n同仁編輯連結（改內容用，不需後台密碼）：\n${editLink(eventId, editCode)}`,
        staffChips());
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
      staffChips(...routed.event_ids.map(cardName)));
    return;
  }

  // 走到這裡代表 routeStaffIntent() 判成 'other'。但 'other' 在職員這邊涵蓋得太寬：
  // 那份 prompt 裡根本沒有新聞稿、產業趨勢、技術報導、邀訪窗口這幾種意圖，同仁只要
  // 問了其中任何一種、講法又剛好沒被上面的字面比對接住，就會掉到這裡。原本這裡直接
  // 丟一面功能清單的牆——那就是回報截圖裡的那一則。
  //
  // 改成交給記者端那條自然語言路由：它認得產業趨勢、工研院技術、活動問答，而且它的
  // 兜底（sendFallbackGuide）會針對同仁這一句講一段貼題的話，不是列清單。
  //
  // ⚠️ 這條路會多花一次模型呼叫（職員路由一次、記者路由一次）。可以接受：走到這裡
  // 的本來就是「兩邊都沒對上」的少數訊息，而同仁的訊息量遠小於記者。
  // askMediaName／remember 都關掉：同仁不是記者，不要問他貴媒體的名稱，內部對話也
  // 不該混進記者的對話記憶。staff:true 讓兜底那則帶職員的按鈕，不是記者的。
  // 批次 76／78：「改成下午兩點開始」這種句子，模型也沒聽出是哪一欄、哪一場。不能交給
  // 兜底——那條路可能把它當閒聊回。明確告訴同仁怎麼講才改得動。
  if (fieldHint) {
    await replyOrPush(replyToken, userId, FIELD_HINT_TEXT, eventQuickReplies());
    return;
  }
  await handleUnbound(replyToken, userId, text, { askMediaName: false, remember: false, staff: true });
}

// 職員功能表。同仁打「使用說明」「回首頁」，或按下方選單時看到的就是這一則。
//
// ⚠️ 這則**不再**當「聽不懂」的兜底用（見 handleStaffMessage 結尾）。一份清單當答案
// 是很糟的體驗：同仁問的是一個具體問題，拿回來的是「這裡有八個功能」。
//
// 分成兩段，因為回報的「不好用」有一半是**看不出自己能做什麼**：原本這份清單只列了
// 管理功能，同仁不知道可以用對話教米亞（批次 46 做好了，但除了 LINE-PLAN.md 之外
// 沒有任何地方寫著怎麼叫它——跟批次 51「最新新聞清單沒有入口」是同一個形狀）。
//
// ⚠️ 批次 52 曾經在這裡加過第三段【記者問得到的，您一樣問得到】，批次 55 拿掉了。
// 原話：「職員模式應該重點是調整、設定？要問趨勢什麼的去跟記者一樣地方就好，
// 不用進入職員模式吧。」——這份清單要回答的是「**在這個模式裡**我能做什麼」，
// 列一串「其實你不用進來也做得到」的東西只是把它撐長。
//
// ⚠️⚠️ 但那是**文案**的取捨，不是能力的取捨。職員問趨勢／技術／新聞／邀訪窗口
// 照樣答得出來（批次 52 修的是 handleStaffMessage() 的路由，不是這段文字）——
// 那條路被拿掉的話，回報過的「問新聞稿拿到一面功能清單的牆」就會整個回來。
// 測試釘住了這一條。
async function sendStaffMenu(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '職員模式 🔧 下面按鈕直接點，或用講的都可以。\n\n' +
    '【管理】\n' +
    // 「更多功能」這一格送出的就是「使用說明」＝這一則本身，不列自己
    STAFF_MENU.buttons.filter(b => b.text !== '退出職員模式' && b.text !== '使用說明').map(b => `・${b.label}——${b.sub}`).join('\n') +
    '\n・要媒體訓練連結——發言練習（每張活動卡上也有）' +
    '\n・設定圖文選單——重設下方選單\n' +
    '・點活動名稱——看那一場的活動卡：填寫進度、編輯頁、催填訊息、媒體訓練\n' +
    '・帶著問題問（「某某那場的重點是什麼」）——米亞照那場的內容回答（含未發布）\n\n' +
    '【直接改資料】\n' +
    '・「智慧醫療那場地點改成南港展覽館」——名稱、日期、時間、地點、新聞聯絡人都可以，會先跟你確認\n' +
    '・「發布 某某那場」——必填都齊了才能發布\n' +
    '・打「復原上一個修改」改回去\n' +
    '・直接傳照片——選一場，照片就加進那一場的活動照片\n\n' +
    '【教米亞】\n' +
    '・「記住：這場的技術還在實驗階段，不要說已經量產」——只記這一場\n' +
    '・「語氣：回答再短一點」——全站通用\n' +
    '・打「記憶清單」看目前記得什麼\n\n' +
    '【離開】打「退出職員模式」回到記者身分。',
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
// ── 找真人（批次 81）──────────────────────────────────────────────────────
// 世新大學事件的教訓：AI 最傷人的不是答錯，是「答不出來、又找不到人」。所以這一則：
//   ① 一定給得出真人：目前這場的新聞聯絡人 → 全站綜合窗口（contacts_directory 的「其他」）
//      → 都沒有時，退到程式裡寫死的綜合聯絡人（跟產業趨勢那條同一位）
//   ② 通知公關同仁（LINE_ADMIN_USER_ID）：記者可以在 LINE 官方帳號後台的聊天室被真人直接回覆
//   ③ 不承諾回覆時間（LINE-PLAN.md 第 9 節：收了單沒回，比沒有這個功能更傷）
// 全部寫死、不經過模型：聯絡方式不能是模型生出來的。
const HUMAN_NOTIFY_GAP_MS = 30 * 60 * 1000; // 同一個對話 30 分鐘內只通知一次，避免記者連打幾次就洗管理員的版
const humanNotified = new Map();

async function sendHumanContact(replyToken, targetId, text, binding, { speakerId = '', group = false } = {}) {
  const lines = ['我是米亞，工研院的 AI 小幫手 🙂 想直接找人的話：'];
  const event = binding?.event_id ? await getEventById(binding.event_id) : null;
  if (isUsable(event) && event.press_contact) {
    lines.push(`・《${event.name}》新聞聯絡人：${event.press_contact}`);
  }
  let dir = [];
  try { dir = await getContactsDirectory(); } catch { dir = []; }
  const general = dir.find(c => c.topic === '其他');
  const g = general?.name ? { ...general } : { ...FALLBACK_INDUSTRY_TREND_CONTACT };
  // 預設名單的「其他」那行沒填電話（同一個人在「產業趨勢分析」那行有）。只給名字等於沒給，
  // 從名單裡找同一個人的電話補上；再沒有就用程式裡寫死的那支。
  if (!g.phone) {
    g.phone = dir.find(c => c.name === g.name && c.phone)?.phone
      || (g.name === FALLBACK_INDUSTRY_TREND_CONTACT.name ? FALLBACK_INDUSTRY_TREND_CONTACT.phone : '');
  }
  lines.push(`・工研院新聞綜合窗口：${g.name}${g.phone ? ` ${g.phone}` : ''}${g.lineId ? `（LINE：${g.lineId}）` : ''}`);
  lines.push('・各技術領域的窗口：打「媒體邀訪需求」');

  const ownerId = process.env.LINE_ADMIN_USER_ID;
  const key = group ? `${targetId}` : targetId;
  const last = humanNotified.get(key) || 0;
  let notified = false;
  if (ownerId && ownerId !== (speakerId || targetId) && Date.now() - last > HUMAN_NOTIFY_GAP_MS) {
    try {
      const res = await pushMessage(ownerId,
        `🙋 有人在 LINE 要找真人\n${group ? '（在群組裡）' : ''}${isUsable(event) ? `目前在問：《${event.name}》\n` : ''}原話：「${sanitize(text, 100)}」\n\n` +
        '可以到 LINE 官方帳號管理後台的「聊天」直接回覆他。');
      notified = !res || res.ok !== false;
      if (notified) humanNotified.set(key, Date.now());
    } catch (e) { console.error('找真人通知失敗:', e.message); }
  } else if (ownerId && Date.now() - last <= HUMAN_NOTIFY_GAP_MS) {
    notified = true; // 剛剛已經通知過了
  }
  if (notified) lines.push('\n我也轉告公關同仁了，他們看到會在這個對話直接回你；急的話直接打電話比較快。');
  console.log(`[line] 找真人 target=${targetId} group=${group} notified=${notified}`);
  await replyOrPush(replyToken, targetId, lines.join('\n'),
    group ? undefined : ['媒體邀訪需求', '最近有哪些活動', '使用說明']);
}

async function handleMetaIntent(replyToken, userId, text, metaIntent, binding, { speakerId = '', group = false } = {}) {
  // ask_name 是「#代碼綁定後問了媒體名稱，下一則要試著擷取」的一次性旗標。
  // 記者在那個視窗裡改按了選單按鈕，代表他跳過了報名字這件事，旗標要當場作廢——
  // 不清掉的話，等他選完活動再回來打的第一句真正的問題，會被 looksLikeNameOrSkip()
  // 誤判成媒體名稱吃掉（就是上面 handleEvent 註解裡已經修過一次的那個坑）。
  if (binding?.note === 'ask_name') await setBindingNote(userId, '');
  // await_contact_topic（按了「其他」，等記者自己打技術主題）與 await_tech_query
  // （按了「想問什麼技術」，等記者自己打技術名稱）這兩個一次性旗標，記者這時候改按
  // 了別的選單按鈕就代表他放棄了那次自由輸入，旗標要當場作廢——不清掉的話，他接下來
  // 打的第一句真正的問題會被誤判成在找邀訪窗口／在報技術名稱。
  // （這裡沒辦法只看 binding?.note，因為這兩個旗標常常是在完全沒有活動綁定時設的。）
  // ⚠️ 兩個旗標存在同一欄、用同一支讀寫，所以只讀一次就夠：原本寫成連續兩個
  // `await getStoredNote()`，第一個若命中會 setContactPending() → 快取失效 →
  // 第二個必定真的再打一次 Sheets 讀取，白花一次全站共用的配額。
  // ⚠️ 旗標可能帶著「這是誰按的」後綴（群組，見 pendingNoteFor()），比對前要先切掉；
  // 這裡刻意「不」檢查是不是同一個人——按了別的選單按鈕就是放棄那次自由輸入，不管
  // 是誰按的，那個等待中的視窗都該當場作廢，留著只會讓下一句真正的問題被誤判。
  const { note: pendingNote } = parsePendingNote(await getStoredNote(userId));
  if (pendingNote === CONTACT_PENDING_NOTE || pendingNote === TECH_QUERY_PENDING_NOTE) {
    await setContactPending(userId, '');
  }

  if (metaIntent === 'thanks' || metaIntent === 'ack') {
    // 收尾語（批次 72，見 lib/menu.js detectCourtesy()）。寫死一句、不呼叫模型：
    // 以前綁定中說「謝謝」會送進 answerQuestion()，花一次 Sonnet、回一句「不客氣」再加
    // 一行「內容僅供參考，以工研院官網新聞稿為準」，還被記進 qa_log 算成一題提問；
    // 沒綁定時更糟，會被當成主題詞複誦（「『謝謝米亞』我可以從兩個方向幫您找」）。
    // 按鈕照樣給：綁定中是這場的快速提問（他可能還想問），沒綁定是四條路。
    const current = binding?.event_id ? await getEventById(binding.event_id) : null;
    const chips = isUsable(current) ? eventQuickChips(current, { group })
      : (group ? undefined : ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL]);
    await replyOrPush(replyToken, userId, COURTESY_REPLIES[metaIntent], chips);
    return;
  }

  if (metaIntent === 'help') {
    // ⚠️ 直接把影片送進對話裡播，不是丟一條連結（批次 46）。
    // 回報的原話：「影片現在是跳連結，有可能直接在對話傳或播影片嗎？不會有人特別
    // 還會去點連結的」——完全正確。使用說明的目的是「讓人真的看」，一條連結把
    // 「看」變成一個要主動決定的動作，多數人就滑過去了；LINE 的 video 訊息會直接
    // 在對話裡顯示成可播放的畫面，門檻是零。
    //
    // 影片是 public/mia-guide.mp4（30 秒、720×1280、約 1.3 MB，遠低於 LINE 的
    // 200 MB 上限），封面是第一格的截圖。兩個都必須是 https 直連網址，所以放在自家
    // 站台的 public/ 底下跟著部署走——不依賴任何外部服務，也不會有連結過期的問題。
    //
    // 影片送失敗（網路、LINE 端拒絕）時不能連文字說明都沒了：兩則是同一次
    // replyOrPushMessages，LINE 會整批處理；真的整批失敗，下面那行還會用 push 補一次
    // 純文字，記者至少拿得到說明。
    // ⚠️ 順序是「文字在前、影片在後」（批次 49）。回報：「先放文字再放影片，不然文字
    // 這麼多，影片早就被淹沒看不到」——完全正確。聊天室是由上往下長的，最後一則才停
    // 在畫面最下方、緊貼輸入框；影片放前面，後面那串文字會把它整個推出畫面。
    // HELP_TEXT 也同時精簡到 18 行（原本 33 行）——影片負責講完整流程，文字只留速查。
    //
    // ⚠️ quickReply 掛在**最後一則**：LINE 只顯示最後一則訊息的快速回覆，掛在文字那則
    // 會整排消失。
    const ok = await replyOrPushMessages(replyToken, userId, [
      { type: 'text', text: HELP_TEXT },
      {
        type: 'video',
        originalContentUrl: `${SITE}/mia-guide.mp4`,
        previewImageUrl: `${SITE}/mia-guide-cover.jpg`,
        quickReply: buildHelpQuickReply()
      }
    ]);
    if (!ok) await replyOrPush(replyToken, userId, HELP_TEXT, ['最近有哪些活動']);
    return;
  }

  if (metaIntent === 'industry_trend') {
    // 直接答，不用像 tech_query 那樣先問一次——這四個固定觸發詞（見 lib/menu.js
    // INDUSTRY_TREND_EXACT_RE）本身就夠明確，answerIndustryTrend() 固定抓最新
    // 清單，不需要記者再給關鍵字。
    //
    // ⚠️ 實際回報的問題：點「產業趨勢分析」這顆按鈕，AI 沒有直接摘要最新幾則，
    // 反而列了一串範例主題反問「請問您想了解哪個產業或技術領域」——跟打「最近
    // 趨勢」拿到的乾淨摘要體驗不一致。根因是原本這裡把按鈕送出的原始文字（例如
    // 「產業趨勢分析」這種比較像分類標籤、不像一句請求的名詞短語）直接當「記者的
    // 問題」丟給 AI，AI 有時會把它讀成「範圍不夠明確」而反問，不是每次都直接摘要。
    // 這四個觸發詞代表的都是同一個意圖「給我最新的產業趨勢摘要」，不像自然語言
    // 路由（routeIntent 判成 industry_trend）那條路需要保留記者原話（那邊記者可能
    // 真的在問某個特定領域）——這裡固定換成一句明確的請求句，不看按的是哪一個
    // 觸發詞，確保每次都拿到一樣乾淨的摘要，不受 AI 對「名詞短語 vs. 請求句」
    // 解讀不穩定的影響。
    await answerIndustryTrend(replyToken, userId, '最近有哪些產業趨勢重點');
    return;
  }

  if (metaIntent === 'news') {
    // ⚠️ 綁定中、而且句子沒有指向全院（「有新聞稿嗎」「給我新聞稿」「新聞稿呢」）——
    // 問的是**這一場**的新聞稿，交給這一場回答（批次 72，見 lib/menu.js
    // isOrgWideNewsAsk()）。這場答不出來時 answerQuestion() 自己會老實說還沒有、給
    // 新聞聯絡人；活動前會說正式新聞稿當天發布（邀請函模式）——都比丟一份工研院
    // 最新五則正確。批次 61 在 routeIntent() 那條路修過同一個症狀，這裡是規則層那條。
    if (binding?.event_id && !isOrgWideNewsAsk(text)) {
      const current = await getEventById(binding.event_id);
      if (isUsable(current)) {
        console.log(`[line] 綁定中問新聞稿 → 答這一場 event=${current.id} q="${text.slice(0, 40)}"`);
        await answerQuestion(replyToken, userId, current, group ? '（群組提問）' : (binding.media_name || ''), text,
          { group, memory: !group });
        return;
      }
    }
    // 直接答，不用像 tech_query 那樣先問一次要哪個技術——記者問的就是「最近有哪些
    // 新聞」，答案是官網新聞中心的最新清單，本來就不需要關鍵字（見 answerLatestNews）。
    // 原話刻意照傳給模型（不像 industry_trend 那樣固定換成一句請求句）：這條規則接得
    // 住的句子本來就是自然語言（「最近發的新聞稿麼」），原話比替換過的句子更貼近
    // 記者實際想問的。
    await answerLatestNews(replyToken, userId, text);
    return;
  }

  if (metaIntent === 'tech_query') {
    // 跟「產業趨勢分析」不同，這裡不能直接答——「想問什麼技術」本身不是一個技術
    // 名稱，answerTechQuery() 需要記者給關鍵字才查得到東西。先問一次、記一個
    // 一次性旗標，下一則不管記者打什麼都當成技術名稱去查，見 handleTechQueryMessage()。
    await setContactPending(userId, pendingNoteFor(TECH_QUERY_PENDING_NOTE, userId, speakerId));
    await replyOrPush(replyToken, userId,
      '請問您想了解工研院哪一項技術呢？直接輸入技術名稱即可，例如：機器人、半導體封裝、AI 晶片。');
    return;
  }

  if (metaIntent === 'org_intro') {
    // 直接答，不呼叫模型——院長／董事長姓名寫錯是「絕對不能發生」等級的事（跟批次 3
    // 的一整套坑同一個形狀），見 lib/menu.js ORG_INTRO_TEXT 的說明。附上整套入口
    // 按鈕，記者問完機構簡介不會卡在死巷子裡，跟 sendFallbackGuide() 同一個道理。
    await replyOrPush(replyToken, userId, ORG_INTRO_TEXT,
      ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明']);
    return;
  }

  // ── 批次 81：「我要找真人」——米亞是幫手，不是取代真人（見 lib/menu.js isHumanRequest()）──
  if (metaIntent === 'human') {
    await sendHumanContact(replyToken, userId, text, binding, { speakerId, group });
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
          `《${current.name}》的新聞聯絡人：\n${current.press_contact}`, eventQuickChips(current, { group }));
        return;
      }
      // 這場活動兩個都沒設定 → 往下退到全域技術窗口清單，比什麼都拿不到好。
    }
    await sendGlobalContactMenu(replyToken, userId);
    return;
  }

  const cards = buildCalendarCards(await getAllEventRows());

  if (metaIntent === 'switch') {
    // 真的解除綁定，不只是回一句提示：記者說「回首頁」之後打的下一句多半是新場次
    // 的名稱，留著舊綁定的話那句會先被當成對舊場次的提問。
    if (binding) await clearBinding(userId);
    // 回報的意見：這顆按鈕原本叫「換一場活動」，回覆也只提活動——但這個帳號能問的
    // 不只活動，也能問產業趨勢、工研院技術。回覆順手點出這兩個入口，不是只列活動
    // 清單，記者才看得出來「回首頁」是回到全部功能，不是單純換一場活動。
    await replyOrPush(replyToken, userId,
      `好的，已經回到首頁。\n\n請直接輸入想問的活動名稱，或從下面挑一場；也可以打「產業趨勢分析」「想問什麼技術」問其他問題。\n\n${formatCalendarReply(cards)}${CONTACT_MENU_TEXT_HINT}`,
      calendarQuickRepliesForReporter(cards));
    return;
  }

  // calendar：只列清單，不解除綁定——記者多半只是想看看有什麼，看完還會繼續問
  // 原本那場。真的要換，按下清單的按鈕（送出的就是完整活動名稱）會走
  // matchEventByName() 自動切過去，不需要他先「離開」再「進入」。
  await sendCalendarReply(replyToken, userId, cards, binding ? await getEventById(binding.event_id) : null);
}

// 「近期活動」那則回覆的唯一出口（批次 57）。原本只有 handleMetaIntent() 的 calendar
// 分支長這樣；抽出來是因為現在有三個呼叫端（固定規則命中、1 對 1 綁定中被 AI 判成
// calendar、群組綁定中被 AI 判成 calendar），三邊必須長得一模一樣——記者不該從
// 「怎麼問到的」看得出差別。
async function sendCalendarReply(replyToken, targetId, cards, currentEvent) {
  const suffix = isUsable(currentEvent)
    ? `\n\n（您目前在問的是《${currentEvent.name}》，直接發問就會回答這一場；想換場點下面的按鈕即可。）`
    : '';
  await replyOrPush(replyToken, targetId,
    formatCalendarReply(cards) + suffix + CONTACT_MENU_TEXT_HINT,
    calendarQuickRepliesForReporter(cards));
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
//
// remember（批次 28）：軟綁定命中、直接答一題時要不要開對話記憶。1 對 1 開、群組
// 不開，理由見 getRecentTurn() 的說明（群組多人交錯，上一輪多半是別人的問題）。
async function handleUnbound(replyToken, userId, text, { silentOnOther = false, askMediaName = true, remember = true, staff = false } = {}) {
  const rows = await getAllEventRows();
  const cards = buildCalendarCards(rows);
  // 上一則剛回答完的是不是產業趨勢／工研院技術題——沒有這個提示，記者接著打的
  // 追問（尤其是「太空」這種裸名詞）在 routeIntent() 眼裡跟純聊天沒兩樣，見
  // getRecentTopic() 開頭那段回報的截圖。讀的是 getBinding() 早就載入的那份 60 秒
  // 快取，不會多打一次 Sheets。
  const topicCtx = await recentTopicContext(userId);
  const { intent, event_ids, confidence, tech_keyword } = await routeIntent(text, cards, topicCtx);
  console.log(`[line] reporter route q="${text.slice(0, 60)}" → intent=${intent} event_ids=${JSON.stringify(event_ids)} confidence=${confidence} topic=${topicCtx.currentTopic || '-'}`);

  if (intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards) + CONTACT_MENU_TEXT_HINT, calendarQuickRepliesForReporter(cards));
    return;
  }

  if (intent === 'industry_trend') {
    // 不做軟綁定——這題跟任何一場活動都無關，沒有「場次」可以綁。
    await answerIndustryTrend(replyToken, userId, text);
    return;
  }

  if (intent === 'tech_query') {
    // 記者直接問「工研院在ＸＸ技術上有什麼進展」這種完整句子，不用先問一次要查
    // 什麼——但不能把整句原話直接丟給工研院官網的關鍵字搜尋：實測那邊接近精準
    // 比對，整句話（含「最近」「有什麼新聞」「嗎」這類語助詞）常常查不到任何
    // 結果，只有抽出來的核心關鍵字查得到（見 LINE-PLAN.md 批次 22 的說明）。
    // routeIntent() 判成 tech_query 時會順手抽一個關鍵字，優先用那個；抽不出來
    // （空字串）才退回整句原話，總比完全不查好。
    await answerTechQuery(replyToken, userId, tech_keyword || text);
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
      await answerQuestion(replyToken, userId, event, existingName, text, { memory: remember });
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

  await sendFallbackGuide(replyToken, userId, text, { staff });
}

// 記者剛剛打的是不是「一個光禿禿的主題詞」（截圖裡的「太空」）——是的話，兜底時
// 不要泛泛地列四條路，直接把那個詞複誦回去，讓他一鍵選要走哪一條。
//
// ⚠️ 判斷刻意收得很緊，寧可漏判、退回下面那份泛用文案：把「你好」「謝謝」「哈哈」
// 這種招呼語當成主題詞複誦回去（「『你好』這個題目我可以從兩個方向幫您找」）比不
// 複誦難看得多。走到這裡時 routeIntent() 已經判成 other，代表這個詞跟清單裡任何一場
// 活動都對不上，不需要再擔心它其實是某場活動名稱的一部分（活動名稱的比對還有
// matchEventByName() 那道「正規化後至少 6 個字」的門檻擋著）。
//
// ⚠️ 回報的截圖（批次 27）：記者打「天氣如何」，收到的是「『天氣如何』我可以從兩個
// 方向幫您找」，底下還掛著「天氣如何的產業趨勢」「工研院的天氣如何技術」兩顆按鈕
// ——正是上面那段警告在講的難看，只是漏判的不是招呼語。原本的守門只有一份寫死的
// 招呼語名單，擋得住「你好」，擋不住任何一句**沒有標點的短問句**：「天氣如何」
// 「怎麼辦」「吃飽沒」「現在幾點」通通是 2～8 個字、不含空白與標點，全部通過。
// 而且那兩顆按鈕不只是文案難看，按下去真的會把「天氣如何產業趨勢」送去查。
//
// 修法不是把「天氣」加進黑名單——閒聊的題目列不完，列了也一定會過時。改成看
// **句子的字面結構**：主題詞是一個名詞（太空、半導體、光通訊），閒聊與問句一定會
// 帶到疑問詞、句尾語助詞或人稱代名詞，而這些字不會出現在主題詞裡。三道門檻：
//   ① 只由中文字、英數組成（順便擋掉純表情符號、顏文字，標點也不用另外列）
//   ② 2～8 個字，且不是常見招呼／應答語（原本就有）
//   ③ 不含任何「這是一句話，不是一個主題詞」的字面特徵（SENTENCE_RE）
const GREETING_RE = /^(你好|妳好|您好|哈囉|哈嘍|嗨|hi|hello|hey|早安|午安|晚安|謝謝|感謝|thanks|thx|ok|okay|好的|好喔|收到|嗯|嗯嗯|喔|哦|哈哈|呵呵|再見|掰掰|bye|測試|test)$/i;

// 疑問詞、句尾語助詞、人稱代名詞——出現任何一個就當成「一句話」，不複誦。
//
// ⚠️ 挑字的原則是「這個字不可能出現在記者真的想查的主題詞裡」，不是「這個字常出現在
// 問句裡」。所以刻意**不收**單字的「幾」「能」「多」「是」——「幾何」「能源」「太陽能」
// 「儲能」「多媒體」都是真的會被問到的題目，為了多擋一句閒聊而擋掉它們並不划算
// （誤擋的代價是記者拿不到複誦，誤放的代價只是多一句難看的話）。要擋這幾種句型就
// 寫成「幾點」「能不能」這種擋得住又不會誤傷的多字組合。
// 反過來說，漏掉的句型會退回下面那份泛用兜底文案——那份文案把四條路一次講清楚，
// 對一句閒聊本來就是誠實且夠用的答案，不是壞掉的狀態。
// 「ＸＸ不ＸＸ」「有沒有」這種正反問句用一條疊字規則收掉（`(.)[不沒]\1`），比一句
// 一句列（是不是／要不要／能不能／好不好／知不知道…）短、也不會有漏掉的句型。
// 主題詞裡出現「不」的例子（不鏽鋼、不織布）都是「不」開頭，前面沒有字可以疊，
// 不會誤中這條規則。
const SENTENCE_RE = /(?:如何|怎麼|怎麽|怎么|怎樣|什麼|甚麼|什么|為何|為什麼|哪|誰|嗎|呢|吧|嘛|多少|幾點|幾號|幾天|幾歲|(.)[不沒]\1|你|妳|您|我|他|她|它|沒$|否$)/;

function looksLikeBareTopic(text) {
  const s = String(text || '').trim();
  // 一-鿿 是中日韓統一表意文字（常用中文字）；連同英數之外的字元一律不算
  // 主題詞——全形／半形標點、空白、表情符號都落在這個白名單外面，不用另外列。
  // ⚠️ 批次 72：收尾語（「好的謝謝」「了解」）、閒聊（天氣、「答錯了」「測試一下」）、
  // 帶著名字的招呼（「哈囉米亞」「早安米亞」）也都是 2～8 個字、沒有疑問詞——之前全部
  // 被當成主題詞複誦。群組守門那邊也靠這支判斷「剛答完趨勢後的裸名詞追問」，放行了
  // 「好的謝謝」就等於在別人的群組裡插一句「不客氣」。
  const core = s.replace(/米亞/g, '');
  return /^[一-鿿A-Za-z0-9]{2,8}$/.test(s) && !!core && !GREETING_RE.test(core) && !SENTENCE_RE.test(s)
    && !detectCourtesy(s) && !detectChitchat(s);
}

// ── 風趣兜底：天氣／告白這種「連四條路都不用比」的閒聊（批次 62）───────────────
// 回報：「有可能加入一些有趣風趣回答，讓他更有生命力嗎，不適合會造成混淆就算了」，
// 附的兩張截圖是「天氣如何」「我喜歡你」——這兩句現在都會走到 composeFallbackReply()，
// 讓 Haiku 現場生成一句貼題的話。
//
// 這支刻意**不**是去放寬 composeFallbackReply() 的 system prompt、讓模型自己抓「風趣」
// 的分寸：那支的鐵規則（不能提供事實內容、不能假裝查過）是這個帳號敢用 AI 兜底的
// 前提，放寬語氣限制等於同一個模型下一次可能抓錯分寸講出一句尷尬或失禮的話——跟
// Markdown、簡體字踩過的坑同一個形狀（CLAUDE.md 第 2 節：這件事不能只靠 prompt）。
//
// 改成反過來：認得出「這句根本不是在問事情，是天氣／告白這種閒聊」的話，直接送出
// 我們自己寫死、審過的一句俏皮話，連 Haiku 都不呼叫——風趣的部分完全在我們手上，
// 不會有「這次生成得比較尷尬」的變數。認不出來的（絕大多數）維持原本流程，退回
// composeFallbackReply()。
//
// ⚠️ 判準刻意收得很窄，只收「不可能是真的在問工研院四條路任何一條」的幾類：天氣、
// 告白／搭訕、問米亞的個性／自我介紹。範圍不能寫寬——寫寬了會有把真的技術題誤判成
// 閒聊的風險，例如「溫度感測技術」不能被關鍵字誤中，所以這裡只收「天氣」本身，不收
// 單獨的「溫度」。跟 looksLikeBareTopic() 同一個原則：寧可漏判、退回下面的智慧兜底，
// 也不要誤判。
const CHITCHAT_WEATHER_RE = /(天氣|會不會下雨|會下雨嗎|放晴|颱風|會冷嗎|會熱嗎|會不會冷|會不會熱)/;
const CHITCHAT_FLIRT_RE = /(我喜歡你|我喜歡妳|喜歡你|喜歡妳|愛你|愛妳|妳好可愛|你好可愛|妳好正|妳好漂亮|妳好美|嫁給我|娶我|妳單身嗎|你單身嗎|要不要交往|當我女朋友|當我男朋友)/;
// 批次 63 新增：問個性／自我介紹。跟天氣、告白同一個道理——這種問題現在會被丟給
// composeFallbackReply()，實測答出來的是「這題我沒有設定資料可以查」，把自己講成
// 資料庫查詢系統，問個性、答成查無資料，比戲謔還尷尬。CLAUDE.md 第 3 節「米亞只有
// 一種聲音」對語音講的道理，個性介紹也適用：不該每次現場生成、每次講法都不一樣，
// 應該寫死一份、審過、固定下來。
//
// ⚠️ 刻意不收「你是誰」「妳是誰」：`lib/menu.js` 的 `HELP_WHOAMI_RE` 早就把這句
// （整則訊息就是「你是誰／你是什麼」這種問法）接去 `detectMetaIntent()` 回使用說明，
// 走在 routeIntent() 之前，這支根本輪不到。兩邊刻意分工：問「你是誰」是在問這個帳號
// 是什麼、該怎麼用，回使用說明是對的；問「你的個性」「介紹一下你自己」是在問米亞這個
// 角色本身，才是這次回報真正要接住的問題。
const CHITCHAT_PERSONA_RE = /(你的個性|妳的個性|你是什麼個性|妳是什麼個性|自我介紹|介紹.{0,4}你自己|介紹.{0,4}妳自己)/;

// 批次 65 新增：稱讚／誇獎、問是不是 AI、關心用語——回報：「除了天氣告白問個性，
// 也加入其他記者也可能問的場景」。三類都跟天氣／告白／問個性同一個判準：句子本身
// 不可能對到工研院四條路任何一條，才收進來；範圍一樣收得很窄，避免誤傷真的提問。
const CHITCHAT_COMPLIMENT_RE = /(你好聰明|妳好聰明|你好棒|妳好棒|你好厲害|妳好厲害|你真厲害|妳真厲害|你太厲害了|妳太厲害了|你好優秀|妳好優秀|你好可靠|妳好可靠)/;
// 「你是AI嗎」不會跟 lib/menu.js 的 HELP_WHOAMI_RE 打架——那條錨定的是「你是誰／
// 你是什麼」這種問法，不含「AI」「機器人」這幾個字，兩邊不會對同一句話有不同答案。
const CHITCHAT_AI_IDENTITY_RE = /(你是不是ai|妳是不是ai|你是ai嗎|妳是ai嗎|你是不是機器人|妳是不是機器人|你是機器人嗎|妳是機器人嗎|你會不會被取代|妳會不會被取代|你會不會失業|妳會不會失業|你是真人嗎|妳是真人嗎)/i;
const CHITCHAT_CARE_RE = /(辛苦了|你會累嗎|妳會累嗎|你累不累|妳累不累|你不用休息嗎|妳不用休息嗎|你要不要休息|妳要不要休息)/;
// 批次 72 新增：「答錯了／看不懂／再說一次／太長了」這種**對上一則答案的反應**，以及
// 「測試一下」。盤點時整批丟進規則層，沒綁定時全部被 looksLikeBareTopic() 當成主題詞
// 複誦（「『答錯了』我可以從兩個方向幫您找」）。綁定中不會走到這裡——那時它們會連同
// 上一輪對話一起交給 answerQuestion()，模型可以真的重答、縮短；只有「沒有上一輪可以
// 改」的時候才需要這一句。整句錨定，後面還接著問題的（「不對，我是問成本」）不算。
const CHITCHAT_REPAIR_RE = /^(米亞)?[\s，,]*(你|妳)?(答錯了|回答錯了|講錯了|說錯了|不對|不是這個|不是這樣|我不是問這個|不是問這個|看不懂|聽不懂|什麼意思|甚麼意思|啥意思|再說一次|再講一次|講清楚一點|說清楚一點|太長了|太長|簡短一點|短一點|講重點|說重點)(啦|喔|吧|耶|欸)?[\s\p{P}\p{S}]*$/u;
// 批次 75（四角色模擬）：記者加好友後第一句多半是「哈囉」「你好，我是聯合報記者」，
// 原本一路送到 AI 兜底。招呼每次都該得到同一個、把入口講清楚的回覆，不用花一次模型。
const CHITCHAT_GREET_RE = /^(米亞)?[\s，,]*(哈囉|哈啰|嗨|hi|hello|hey|你好|您好|妳好|大家好|安安|早安|午安|晚安|早|在嗎|有人在嗎)(米亞)?[\s，,]*((我是|這邊是|這裡是)[^?？]{1,16})?[\s\p{P}\p{S}]*$|^(我是|這邊是|這裡是)[^?？]{1,12}(記者|編輯|攝影|主播|製作人)[^?？]{0,3}[\s\p{P}\p{S}]*$/iu;
const CHITCHAT_TEST_RE = /^(米亞)?[\s，,]*(測試|test|testing)(一下|測試|中|看看|\d+)*[\s\p{P}\p{S}]*$/iu;

function detectChitchat(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (CHITCHAT_FLIRT_RE.test(s)) return 'flirt';
  if (CHITCHAT_PERSONA_RE.test(s)) return 'persona';
  if (CHITCHAT_COMPLIMENT_RE.test(s)) return 'compliment';
  if (CHITCHAT_AI_IDENTITY_RE.test(s)) return 'ai_identity';
  if (CHITCHAT_CARE_RE.test(s)) return 'care';
  if (CHITCHAT_REPAIR_RE.test(s)) return 'repair';
  if (CHITCHAT_TEST_RE.test(s)) return 'test';
  if (CHITCHAT_GREET_RE.test(s)) return 'greet';
  if (CHITCHAT_WEATHER_RE.test(s)) return 'weather';
  return null;
}

// 三句都經過人審——風趣但不離題，收尾都帶回這個帳號真的能幫上忙的事。這份文案就是
// 「風趣」這件事唯一被允許存在的地方，不留給模型現場發揮（理由見上）。
//
// 批次 63：天氣／告白這兩句原本用了「槓龜」「問對棚的人」這類俚語，主管實測回饋
// 「有點太戲謔」——這個帳號掛工研院名義，記者可能截圖引用，俚語的分寸比一般聊天
// 帳號更緊。改成拿掉賭博／演藝圈黑話。
//
// 批次 64：批次 63 那版改完，主管又回饋反過來太硬了——「可以回答莊重有點溫度，但
// 不要太死板太 AI，可以可愛點沒關係」，「守備範圍」「厚愛」這種用字讀起來像公文，
// 反而沒有人味。這支要找的不是「俚語 vs. 公文腔」這兩個極端，是中間那條線：不動用
// 賭博／演藝圈黑話，但可以用「考考我」「不好意思」這種帶點表情、帶點溫度的日常口語，
// 讓米亞聽起來像一個有個性的人，不是一支照規則寫死的罐頭訊息。
//
// 批次 65：新增稱讚、問是不是 AI、關心用語三類；問個性那句的收尾也再調一次——原本
// 「其他的可能要麻煩你問別人囉」聽起來像在打發人，改成先致歉再指路，語氣更軟。
const CHITCHAT_FIXED_REPLIES = {
  weather: '天氣預報我真的答不出來 🌤️ 不過換成記者會、產業趨勢、工研院技術，這幾個換我出馬就對了，你可以考考我！',
  flirt: '謝謝你這麼說，我有點不好意思 😳 不過把記者會、產業趨勢跟工研院技術這幾件事顧好，就是我最大的浪漫了——這幾類的問題儘管來問我。',
  persona: '我是米亞，工研院的公關小特派 🙂 個性走直球型，想到什麼就講什麼，不拐彎抹角。平常最愛做的事就是幫記者把記者會內容、產業趨勢、工研院技術、媒體邀訪窗口這幾件事搞定。如果超出我理解的問題，請見諒QQ，或是可以聯絡我的同事們為您解答:)',
  compliment: '謝謝誇獎，我會繼續加油 💪 不過真正厲害的是工研院這些技術跟記者會內容，我只是負責幫你講清楚——這幾類的問題我最樂意接。',
  ai_identity: '是啊，我是 AI 沒錯 😄 不過我這個 AI 比較專一，只認真做記者會、產業趨勢跟工研院技術這幾件事，這幾類的問題我最拿手。',
  care: '謝謝你這麼貼心 😊 我是 AI 不會累，隨時都能幫你查記者會、產業趨勢跟工研院技術這幾件事，有需要儘管找我。',
  // 批次 72 新增的兩句，同樣請朱朱審過語氣再定稿（見 LINE-PLAN.md 批次 72）
  repair: '不好意思，剛剛可能沒答到你要的 🙏 麻煩換個說法再問我一次；想問某一場記者會，直接打活動名稱最準，我會照那一場的資料重新回答。',
  // 批次 75 新增，同樣請朱朱審語氣
  greet: '您好，我是米亞 🙂 工研院的公關小特派。想問記者會，直接打活動名稱或點「最近有哪些活動」；也可以問產業趨勢、工研院技術，或找採訪窗口。',
  test: '收到，我在線上 🙂 想問記者會、產業趨勢、工研院技術，或要找採訪窗口，直接打給我就可以。'
};

// 收尾語的固定回覆（批次 72，見 lib/menu.js detectCourtesy()）。不呼叫模型——
// 一句「不客氣」不值得一次 Sonnet，更不該掛上「內容僅供參考」的警語。
const COURTESY_REPLIES = {
  thanks: '不客氣 🙂 之後想到什麼，直接打給我就好。',
  ack: '好的 🙂 還有想問的，隨時打給我。'
};

// 任何 routeIntent() 判不出來的訊息最後都會走到這裡（1 對 1 的 handleUnbound()、
// 以及綁定中但連目前這場都接不上的情況）。
//
// ⚠️ 回報的截圖就是這句話造成的：記者問完產業趨勢、照著我們自己回覆裡的邀請打了
// 「太空」，收到的是「嗯～我沒抓到您想問哪一場活動耶」——他從頭到尾沒有在問活動。
// 舊文案把「猜不出來」一律講成「猜不出是哪一場活動」，等於每次猜錯都額外多答非所問
// 一次。這裡改成兩件事：
//   ① 措辭不再假設記者一定是在問活動（這個帳號有四條路，活動只是其中一條）
//   ② 看起來像主題詞的訊息，直接複誦回去給兩條真的走得通的路，不要叫記者自己猜
// 話題記憶（getRecentTopic）是第一道防線，但它有 10 分鐘 TTL、也可能是記者一進來
// 就直接打一個詞——這支是那道防線之外的第二層，兩層都不依賴對方。
// 固定兜底文案——智慧兜底（composeFallbackReply）組不出來時的保底。這份永遠不會
// 出錯、也永遠不會講錯話，是這條路徑的安全底線，不要因為有了智慧兜底就拿掉。
const FALLBACK_GUIDE_TEXT = [
  '嗯～這句我不太確定該從哪邊幫您找答案 🤔 這幾件事我都能查：',
  '・某一場記者會的內容 → 直接打活動名稱，或問我「最近有哪些活動」',
  '・產業趨勢 → 打「產業趨勢分析」，或直接問我某個領域的趨勢',
  '・工研院的技術 → 打「工研院」加技術名稱，例如「工研院 太空」',
  '・想找採訪窗口 → 打「媒體邀訪需求」'
].join('\n');

// ── 智慧兜底（批次 28）───────────────────────────────────────────────────
// 回報的意見：「回答不要答非所問」「希望能回答各種問題」。批次 26／27 兩次回報其實
// 都指向同一件事——記者問了一句我們四條資料來源都對不上的話，收到的是一份**跟他
// 那句話完全無關的功能選單**。選單本身沒寫錯，但對「請問可以申請採訪證嗎」「你們
// 上次那個發表會在哪裡辦」這種問句來說，貼一份四條路的清單就是答非所問：它沒有
// 表現出「我聽懂你在問什麼」，只是把說明書再念一次。
//
// 這支用一次 Haiku 呼叫，讓米亞針對「記者這一句」講一段真的貼題的話：先讓他知道
// 我聽懂了、老實說這個我這邊查不到，再指到真的走得通的那一條路。
//
// ⚠️ 這支**不回答問題本身**，這是它跟「讓 AI 自由發揮」的根本差別，也是它敢上線的
// 唯一理由：這個帳號掛著主辦單位名義、記者可能直接截圖引用，沒有資料來源就生成
// 事實內容是這整份規格從第一天就禁止的事（LINE-PLAN.md 第 3 節）。system prompt
// 把「不要提供任何事實內容」寫成最硬的一條，輸出再過一次長度／格式守門，出任何
// 差錯都退回上面那份固定文案。
//
// 成本只發生在兜底這條路（四條路都對不上才會走到），不是每則提問都多一次呼叫。
const FALLBACK_MAX_LEN = 300;

async function composeFallbackReply(text) {
  const question = sanitize(text, 300);
  if (!question) return '';
  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，現在的角色是「兜底引導員」。',
    '記者剛剛傳來一句話，我們四種資料來源（某一場記者會的內容、IEK 產業情報網的產業趨勢、工研院官網新聞中心的技術報導、媒體邀訪窗口名單）都比對不到可以回答它的資料。',
    '',
    '你這次的任務**不是回答那個問題**，而是：',
    '① 用一句話讓記者知道你聽懂了他想問什麼（用他自己的話複述，不要照抄整句）。',
    '② 老實說這個我這邊查不到，或這不是這個帳號查得到的東西。',
    '③ 從上面四條路裡挑出**最接近**他這個問題的一到兩條，具體告訴他該打什麼字。真的一條都不沾邊（例如問天氣、閒聊、數學題），就直接說這裡只服務工研院的活動與技術採訪需求，並簡短點出這四條路，不要硬拗成某一條。',
    '',
    '絕對禁止（這幾條比上面的任務更優先）：',
    '- 不要提供任何事實內容：不要講數字、日期、人名、地點、技術細節、活動內容、聯絡方式，一個字都不要。你手上沒有任何資料，講出來的都是編的。',
    '- 不要假裝查過、不要說「根據我查到的」。',
    '- 不要承諾你做不到的事：不能說幫忙轉接、稍後回覆、代為查詢、幫他問同事。',
    '- 不要重複貼整份功能選單當作回答（那正是這次要修掉的答非所問）。',
    '- 不要用 Markdown 語法（LINE 不會渲染）。',
    '',
    '格式：3 行以內，總長度不超過 120 個字。不要加結尾警語（這則沒有引用任何資料，不需要）。',
    TONE_RULE
  ].join('\n');

  const reply = String(await askAnthropic(systemPrompt, question) || '').trim();
  // 守門：askAnthropic() 失敗時回的是它自己那幾句「抱歉，目前無法取得回應」，那句話
  // 拿來當兜底比固定文案還糟（記者會以為系統壞了，其實只是沒對上資料）；太長、或
  // 混進 Markdown 的輸出也一律不要，退回固定文案。
  if (!reply) return '';
  if (reply.length > FALLBACK_MAX_LEN) return '';
  if (/抱歉，目前無法取得回應|系統目前無法回答|無法取得回應/.test(reply)) return '';
  // 批次 32 起不用在這裡擋 Markdown：askAnthropic() 的出口已經統一清過一次
  // （見 stripMarkdownForLine()），四條問答路線都受惠，不需要兜底自己再擋一次。
  return reply;
}

// staff（職員模式借道這條路時，見 handleStaffMessage 結尾）：底下的按鈕要換成職員
// 那組，並且補一句「這裡是職員模式」——同仁在職員模式裡拿到一整排記者按鈕會以為
// 自己被踢出去了。
async function sendFallbackGuide(replyToken, targetId, text, { staff = false } = {}) {
  const chips = staff ? STAFF_QUICK_REPLIES : ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '找真人', '使用說明'];
  // 批次 81：每一條兜底都要留一條通往真人的路（世新事件的教訓：AI 答不出來又找不到人）。
  // 寫死在程式裡接在最後，不交給模型——兜底那支本來就禁止模型講聯絡方式。
  const staffTail = staff ? '\n\n（您在職員模式，打「使用說明」可以看內部功能。）' : '';
  const deadEndTail = staff ? staffTail : '\n\n（想直接找人，打「找真人」。）';

  // 天氣／告白／問個性這種閒聊：不呼叫 Haiku，直接送寫死的俏皮話（見上方
  // CHITCHAT_FIXED_REPLIES 的說明）。放在 looksLikeBareTopic 之前，因為裸主題詞判斷
  // 同樣會誤收「天氣」兩個字。
  // 收尾語：記者端早在 detectMetaIntent() 就攔下了，會走到這裡的是職員模式借道
  // （職員那邊不經過 handleMetaIntent() 的這個分支）。
  const courtesy = detectCourtesy(text);
  if (courtesy) {
    await replyOrPush(replyToken, targetId, COURTESY_REPLIES[courtesy] + staffTail, chips);
    return;
  }
  const chitchat = detectChitchat(text);
  if (chitchat) {
    await replyOrPush(replyToken, targetId, CHITCHAT_FIXED_REPLIES[chitchat] + staffTail, chips);
    return;
  }

  if (looksLikeBareTopic(text)) {
    const kw = String(text).trim();
    await replyOrPush(replyToken, targetId,
      `「${kw}」我可以從兩個方向幫您找 🙂\n・整體產業趨勢（IEK 產業情報網的免費焦點）\n・工研院自己在這方面的技術與發表\n想看哪一種？點下面的按鈕就可以。`,
      [
        { label: `${kw}的產業趨勢`, text: `${kw}產業趨勢` },
        { label: `工研院的${kw}技術`, text: `工研院 ${kw}` },
        ...(staff ? ['最近有哪些新聞', '使用說明'] : ['最近有哪些活動', CONTACT_MENU_LABEL])
      ]);
    return;
  }

  // 先試著用米亞的口吻，針對記者「這一句」講一段真的貼題的話（見
  // composeFallbackReply()）；組不出來就退回下面這份固定文案。
  const smart = await composeFallbackReply(text);
  await replyOrPush(replyToken, targetId, (smart || FALLBACK_GUIDE_TEXT) + deadEndTail, chips);
}

// ── 群組續問視窗的「這句話是在跟我講嗎」守門（批次 28）─────────────────────
// 回報的意見：「被拉進群組時，回答不要答非所問，而且不會亂回」。
//
// 現況的破口不是「被 @ 到之後答錯」，是**免 @ 續問視窗那 5 分鐘之內**：只要視窗還
// 開著，群組裡任何人講的任何一句話都會被送進整條處理鏈，而鏈上前面幾段（固定選單
// 意圖 detectMetaIntent、邀訪主題旗標、技術名稱旗標）根本不看「有沒有被 @」，後面
// 的路由也只有 intent==='other' 這一道安靜門檻。實際後果：
//   - 群組在聊「那個案子還有什麼活動要辦」→ 命中 CALENDAR_RE → 機器人跳出來貼一份
//     活動清單，沒有人在問它
//   - 群組在聊「台積電最近怎樣」→ 路由判成 industry_trend → 機器人開始講 IEK 趨勢
//   - 有人講「換一場」（在講別的事）→ 命中 SWITCH_RE → 機器人把整個群組的綁定清掉
// 這幾種都不是 other，現有的安靜門檻完全擋不住。
//
// 這支是視窗內「先問一句：這像是在跟我講話嗎」的統一守門，放在所有分支之前，
// 只在**沒有被 @** 時生效（真的 @ 到就一定要理人，跟批次 14／16 同一個原則）。
// 判準刻意全部是字面特徵、不呼叫 AI：群組裡「每一則」訊息都會過這支（包含我們最後
// 根本不會回的閒聊），花錢或多打一次 API 都不划算，理由跟 getGroupSessionUntil()
// 那段「不能直讀 Sheets」完全一樣。
//
// 放行的幾類，每一類都對應一個「不放行就會壞掉」的真實路徑：
//   ⓪ 我們剛問完一句、正在等這個人回答（一次性旗標還開著）——那則答案本身多半是
//      一個沒有問號的名詞，擋掉等於自己問了又不聽
//   ① 我們自己送出的按鈕文字（固定選單詞、邀訪主題、活動名稱、「工研院 ＸＸ」）——
//      群組裡按鈕送出的是不帶 @ 的純文字，擋掉就等於按鈕按了沒反應
//   ② 看起來就是一句提問（問號、疑問詞、句尾語助詞）——記者真的在問我們
//   ③ 剛回答完趨勢／技術題（話題記憶還在）時的裸名詞追問——那是我們自己邀請他打的
//   ④ 其餘一律安靜。陳述句、閒聊、跟別人的對話都落在這裡
//
// ⚠️ 這道守門是「加」在既有門檻之前，不是取代：放行之後，原本的「@ 到別人」否決、
// routeIntent() 判成 other 就安靜，全部照舊生效。寧可漏放（記者多打一個問號或重新
// @ 一次）也不要誤放——誤放一次就是在別人的群組裡插一段沒人要的話。
const GROUP_QUESTION_RE = /[?？]|如何|怎麼|怎麽|怎么|怎樣|什麼|甚麼|什么|為何|為什麼|哪些|哪一|哪裡|哪邊|誰|嗎|多少|幾點|幾號|有沒有|請問|想問|想知道|想了解|介紹一下|說明一下|給我|請給|麻煩|幫我|提供|可以嗎|(呢|吧)[?？!！～~。]?$/;

// ⚠️ 上面那條**整條都是中文**——這個帳號本來就支援英文提問（lib/prompt.js 有一條很強
// 的「跟著記者這一則提問的語言回答」規則），但群組守門完全沒有英文的判斷，結果是
// 英文訊息只要沒有 @ 就一律被安靜擋掉。實測回報：群組裡打
// 「Please reply in English.」完全沒反應——句號結尾、沒有問號、沒有任何中文疑問詞，
// 三道規則全部落空。外籍記者在群組裡等於完全問不到東西。
//
// 收的範圍跟中文那條對齊（同樣偏寬鬆）：疑問詞／助動詞開頭，或句子裡有 please。
// 過寬不是問題——守門只是第一層，後面 routeIntent() 判成 other 一樣會安靜。
const GROUP_QUESTION_EN_RE = /^\s*(what|when|where|who|whom|whose|why|how|which|can|could|would|will|shall|should|do|does|did|is|are|was|were|any|tell|show|give|send|need|want|may|might|let|help|hi|hello|hey)\b|\bplease\b/i;

// 我們自己在群組裡送出過的固定按鈕文字，這裡沒辦法用 detectMetaIntent() 涵蓋的那幾顆。
// 「工研院 ＸＸ」是 sendFallbackGuide()／answerIndustryTrend() 的導流按鈕送出的格式。
// 兩顆「導流按鈕」的精確形狀。批次 32 把它們排除在視窗外的放行之外，理由是「只能靠
// 前綴比對、日常對話會誤中」——但那等於我自己違反了同一批訂下的規則（**只要是我們
// 自己放到按鈕上的字，就一定按得動**），而回報又來了一次「點下面小按鈕沒有反應」。
//
// 改成比對**完整形狀**而不是前綴，就不必再破例：
//   `工研院 ＸＸ`   → 產生處見 answerIndustryTrend()／sendFallbackGuide() 的 crossItem
//   `ＸＸ產業趨勢`  → 產生處見 answerTechQuery()／sendFallbackGuide() 的 crossItem
// ⚠️ 那個**空白**是關鍵的辨別點：中文使用者自然書寫時不會在「工研院」後面空一格
// （會寫「工研院那邊怎麼說」），而我們的按鈕一定有。加上「後面只能是 2-8 個乾淨的
// 字、而且到此為止」，誤中的機會很低；真的誤中，結果也只是查一次官網回「沒找到」，
// 不是什麼危險的事。
const CROSS_TOPIC_TECH_RE = /^工研院[ 　][一-鿿A-Za-z0-9]{2,8}$/;
const CROSS_TOPIC_TREND_RE = /^[一-鿿A-Za-z0-9]{2,8}產業趨勢$/;
const GROUP_OWN_BUTTON_RE = /^工研院[\s　]|^邀訪[:：]/;

// ⚠️ 這裡刻意**不**用 detectMetaIntent() 當放行條件，即使它就是「這是不是固定選單
// 意圖」的權威判斷：那支裡面的 CALENDAR_RE／SWITCH_RE 是寬鬆的**片語**比對（不是
// 整句完全相同），本來就設計成「記者怎麼講都接得住」——在 1 對 1 那是體貼，在群組
// 就是誤判來源。實測會中的日常對話：
//   「那個案子後面還有活動要辦」→ 命中 CALENDAR_RE → 機器人貼一份活動清單
//   「這邊先換一場再說」        → 命中 SWITCH_RE   → 機器人把整個群組的綁定清掉
// 兩句都沒有人在跟機器人講話。所以這裡只認**整句完全等於**我們自己送出過的按鈕
// 文字；記者真的想問活動清單時講的「最近有哪些活動」「有什麼活動嗎」本來就帶疑問詞，
// 會走下面 GROUP_QUESTION_RE 那條，不需要靠這一條放行。
// ── 喚醒詞：叫得動機器人的第二種方式（批次 30）────────────────────────────
// 實測回報（附截圖）：同事在群組裡想 @ 這個帳號，**LINE 的 @ 選單裡根本找不到它**
// ——選單只列出真人成員。對他來說「只有被 @ 到才會說話」這條規矩不是有點麻煩，
// 是完全叫不動：他沒有任何辦法把訊息送到機器人面前。
//
// 官方帳號會不會出現在 @ 選單，是 LINE 那邊決定的（跟 app 版本、帳號設定有關），
// 我們的程式改不了。與其賭它會不會出現，不如**多給一條不依賴 @ 的呼叫方式**：
// 訊息開頭打「米亞」就等同 @ 到我們。
//
// ⚠️ 只認**開頭**，不是整句話裡出現「米亞」就算。群組裡談論這個帳號（「米亞剛剛
// 說的那個」「等等問米亞」）跟呼叫它是兩回事，中間出現不該觸發——這條界線就是
// 「亂回」與「叫得動」之間的平衡點。
// 後面允許接標點或空白（「米亞，最近有哪些活動」「米亞 你好」），也允許有人手打
// 一個 @（打了 @ 但選單裡選不到，最後送出的是純文字，正是回報的那個情境）。
const WAKE_WORD_RE = /^\s*[@＠]?\s*米亞\s*[，,、。：:！!？?～~\-—]*\s*/;

// 把開頭的喚醒詞切掉，只留真正的問題。沒有喚醒詞就原樣回傳。
function stripWakeWord(text) {
  return String(text || '').replace(WAKE_WORD_RE, '').trim();
}

// 整句話是不是「我們自己送出去的那顆按鈕」——或者我們正在等這個人回答。
//
// ⚠️ 批次 30 第一版只認固定選單詞與「邀訪：ＸＸ」，實測回報又踩到同一個坑：同事按了
// 「半導體相關乾淨帶畫面提供」完全沒反應——那是**邀訪窗口關鍵字**按鈕，而那種按鈕送出
// 的是**原始關鍵字**（見 handleMetaIntent() 的 contacts 分支：`contacts.map(c => c.keyword)`，
// 沒有「邀訪：」前綴），同仁在後台自訂的快速提問 chips 也一樣是原始文字。兩種都沒被
// 涵蓋到，於是「按鈕按了沒反應」換個按鈕又發生一次。
//
// 規則收斂成一句話：**只要是我們自己放到按鈕上的字，就一定按得動**，不分視窗內外。
// 這比「哪幾種按鈕算數」的清單好記，也不會再有下一顆漏掉的按鈕。
//
// 唯二不放進來的是 `工研院 ＸＸ` 與 `ＸＸ產業趨勢` 這兩顆導流按鈕：它們是用關鍵字
// 拼出來的，比對只能靠前綴／後綴而不是完全相同，「工研院 那邊怎麼說」這種日常對話會
// 誤中。它們永遠出現在一則剛送出的答案底下，視窗本來就是開的，不需要靠這條放行。
async function isOwnButtonText(groupId, text, speakerId) {
  const s = String(text || '').trim();
  if (!s) return false;

  // 我們剛問完一句、正在等這個人回答（「請問您想了解工研院哪一項技術呢？」）——
  // 那則答案本身多半是個沒有問號的名詞，跟按鈕同一種性質：問了就要聽。
  const rawPending = await getStoredNote(groupId);
  const { note: pendingNote } = parsePendingNote(rawPending);
  if ((pendingNote === TECH_QUERY_PENDING_NOTE || pendingNote === CONTACT_PENDING_NOTE) &&
      pendingBelongsTo(rawPending, speakerId)) return true;

  if (GROUP_FIXED_BUTTONS.has(s)) return true;      // 固定選單詞
  if (/^邀訪[:：]/.test(s)) return true;             // 全域邀訪主題（機器產生的格式）
  // 兩顆導流按鈕——見 CROSS_TOPIC_*_RE 的說明。批次 34 補上，不再破例。
  if (CROSS_TOPIC_TECH_RE.test(s) || CROSS_TOPIC_TREND_RE.test(s)) return true;

  // 活動清單按鈕送出的是活動全名（matchEventByName 自己有「正規化後至少 6 個字、
  // 要唯一命中」的門檻，見 lib/menu.js，不會被一個短詞誤中）。
  if (matchEventByName(s, buildCalendarCards(await getAllEventRows()))) return true;

  // 同仁在後台設定的快速提問 chips 與邀訪窗口關鍵字（或沒設定時的 DEFAULT_CHIPS）——
  // 內容是同仁自由填的，沒辦法寫死在上面那個集合裡，但它們確確實實是我們送出去的按鈕。
  return !!(await ownChipEventId(groupId, s));
}

// 這則訊息是不是「某一場的快速提問按鈕／邀訪窗口關鍵字」；是的話回傳
// { eventId }（eventId 可能是空字串＝認得這顆按鈕，但推不出是哪一場），不是回 null。
//
// ⚠️ 這支刻意「不」呼叫 getBinding()。實測回報：群組裡的按鈕列停在下午 6:55 那則
// 訊息上，同事晚上 8:58 才滑回去點「這次活動的主要發表內容是什麼？」——完全沒反應。
// 原本的寫法是「拿目前綁定的那場，比對它的 chips」，兩個地方會落空：
//   ① 活動綁定有 6 小時 TTL，過了就 getBinding() → null，於是連比對都沒得比。
//      但 TTL 過期只代表「不知道現在該問哪一場」，不代表「這句話從來不是我們的
//      按鈕」——跟 getStoredMediaName()／getStoredNote() 不吃 TTL 是同一個道理。
//   ② 就算綁定還在，中途換過場的話，舊訊息上的按鈕屬於**上一場**，跟現在綁的那場
//      對不起來，一樣會被判成「不是我們的按鈕」。
// LINE 的快速回覆按鈕會永遠留在對話紀錄裡，「隔幾小時往上滑再點」是常態不是例外，
// 所以比對範圍要放大到「所有我們可能送出去的 chips」，再回推是哪一場。
async function ownChipEventId(groupId, text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const storedId = await getStoredEventId(groupId);

  // ① 這個群組上次綁的那場（不看 TTL）有這顆 → 就是那場，最準；DEFAULT_CHIPS 這種
  //    每場共用的按鈕也靠這一步分辨得出來。
  const stored = storedId ? await getEventById(storedId) : null;
  if (isUsable(stored) &&
      (eventContentChips(stored).includes(s) || parseEventContacts(stored).some(c => c.keyword === s))) {
    return { eventId: storedId };
  }

  // ② 同仁自己填的字（自訂 chips／活動前 chips／邀訪關鍵字）幾乎不會跟別場撞在一起，
  //    唯一命中就當作是那一場——這條讓「換過場之後點舊按鈕」也能回到正確的場次。
  //
  //    ⚠️ 這條是刻意選的取捨，不是沒想到：它同時把「別場的短 chip」（quad 的
  //    「重點」「應用」）也放進守門，於是群組裡有人單獨打一句「重點」也會被當成
  //    按鈕。判斷是整句**完全相同**才算，而且要剛好等於某場設定過的字，誤觸機率
  //    不高；反過來若限制成「只認目前這場的」，換過場之後點舊按鈕就會再度沉默——
  //    那正是回報的問題本身。按鈕不動的代價比偶爾多答一句大得多，所以往這邊靠。
  const customOf = ev => [
    ...String(ev.chips || '').split('\n'),
    ...String(ev.invite_letter_chips || '').split('\n')
  ].map(x => x.trim()).filter(Boolean);
  const owners = (await getAllEventRows()).map(rowToEvent).filter(isUsable)
    .filter(ev => customOf(ev).includes(s) || parseEventContacts(ev).some(c => c.keyword === s));
  if (owners.length === 1) return { eventId: owners[0].id };
  if (owners.length > 1) return { eventId: storedId };

  // ③ 每一場共用的預設 chips，而且上次綁的那場也對不上（多半是綁定被清掉了）——
  //    仍然認得這是我們的按鈕，場次交給呼叫端去問。重點是**不要沉默**：按鈕按了
  //    沒反應，比多問一句「您想問哪一場」糟糕得多。
  if (DEFAULT_CHIPS.includes(s)) return { eventId: storedId };
  return null;
}

const GROUP_FIXED_BUTTONS = new Set([
  '最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明', '回首頁'
]);

async function looksAddressedToBot(groupId, text, speakerId) {
  const s = String(text || '').trim();
  if (!s) return false;

  // ⓪① 我們自己送出去的按鈕，或我們正在等這個人回答——跟視窗外用的是同一支，
  // 兩邊共用一份清單才不會像批次 30 那樣「補了一種按鈕、漏掉另一種」。
  if (await isOwnButtonText(groupId, s, speakerId)) return true;

  // ①（續）導流按鈕「工研院 ＸＸ」「ＸＸ產業趨勢」——只在視窗內放行，理由見
  // isOwnButtonText() 最後一段。
  if (GROUP_OWN_BUTTON_RE.test(s)) return true;

  // ②-前 批次 75（四角色模擬）：同事在工作群組 @ 過米亞之後的續問視窗裡，接著問「大家
  // 晚上吃什麼」——有「什麼」，會被 ② 當成提問放行，接下來全看模型判不判得出是閒聊。
  // 句子明講在問「大家／各位／你們」，對象就不是米亞；沒提到米亞就安靜。
  if (/大家|各位|你們|妳們|誰要|有人要|有沒有人/.test(s) && !/米亞/.test(s)) return false;

  // ② 一句提問（中文或英文，見 GROUP_QUESTION_EN_RE 的說明）
  if (GROUP_QUESTION_RE.test(s) || GROUP_QUESTION_EN_RE.test(s)) return true;

  // ③ 剛回答完趨勢／技術題時的裸名詞追問（「太空」）——那是我們自己在上一則答案
  // 結尾邀請他打的。沒有話題記憶時**不**放行：一個沒頭沒尾的名詞在群組裡多半是
  // 別人在聊自己的事（「半導體」），不是在問我們。
  if (looksLikeBareTopic(s) && await getRecentTopic(groupId)) return true;

  return false;
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

  const rawText = ev.message?.type === 'text' ? String(ev.message.text || '') : '';

  // speakerId：群組裡「這句話是誰講的」。一次性旗標要記住是誰按的按鈕（見
  // pendingNoteFor()），守門也要靠它判斷「正在等回答的那個人是不是他」。LINE 在
  // 使用者沒同意提供 userId 時可能沒有這個欄位，拿不到就傳空字串。
  const speakerId = ev.source?.userId || '';


  // 被 @ 到，或用喚醒詞「米亞」叫我們——兩種都算「明確在叫機器人」，一律要理人。
  // 喚醒詞的理由見 WAKE_WORD_RE 的說明（實測回報：有人的 LINE @ 選單裡根本找不到
  // 這個官方帳號，對他來說「只有被 @ 才說話」等於完全叫不動）。
  const mentioned = isBotMentioned(ev.message?.mention) || WAKE_WORD_RE.test(rawText);
  if (!mentioned) {
    if (ev.message?.type !== 'text') return; // 非文字訊息（貼圖…）沒被 @ 就安靜略過，不用來亂回

    const sessionUntil = await getGroupSessionUntil(groupId);
    const inWindow = !!sessionUntil && Date.now() <= sessionUntil;
    // 視窗外原本一律安靜，實測回報這會讓「按鈕按了沒反應」：LINE 的快速回覆按鈕會
    // 一直留在對話紀錄裡，同事往上滑、或隔了十幾分鐘才按，送出的是不帶 @ 的純文字，
    // 視窗早就過期 → 完全沒反應，體感就是壞掉。
    // 這種訊息其實是最不可能誤判的一種：整句話「完全等於」我們自己送出去的按鈕文字
    // （見 isOwnButtonText()），沒有人會在群組閒聊裡剛好打出「媒體邀訪需求」這五個字。
    // 所以視窗外也接這一種，其餘維持安靜。
    if (!inWindow && !(await isOwnButtonText(groupId, rawText, speakerId))) return;

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
    await replyOrPush(replyToken, groupId, nonTextReply(ev.message?.type));
    return;
  }

  // 把 @ 的那段文字拿掉，只留真正的問題；沒被 @ 到（續問視窗內）時 mention 是
  // undefined，stripMentionText 會原樣回傳（trim 過）。
  const text = stripWakeWord(stripMentionText(ev.message?.text, ev.message?.mention));
  if (!text) {
    // 只 @ 沒接問題——這句提示只在「真的被 @ 到」時才有意義；續問視窗內若剛好
    // 出現空文字（理論上不會發生，防呆而已）不用多嘴。
    //
    // 回報的意見：舊文案只教「怎麼問」（例句只有「最近有哪些活動」），沒講「可以
    // 問什麼」——群組裡第一次 @ 我們的人常常就是只打個 @ 試探，看到的卻只有一句
    // 操作說明，猜不到「媒體邀訪需求」這條路也走得通。改成先簡短自我介紹，同時
    // 把記者最常問的方向都講出來，再附快速回覆按鈕讓對方不用自己打字。
    //
    // 回報的意見（第二次）：群組快速回覆也要加上「產業趨勢分析」「想問什麼技術」
    // 這兩個新入口，跟 1 對 1 圖文選單同步——群組裡沒有持續顯示的圖文選單，這則
    // 歡迎訊息附的按鈕就是群組唯一一次看得到「還能問什麼」的機會，兩個新能力沒
    // 放進來的話，群組裡的記者根本不會知道可以這樣問。
    if (mentioned) {
      await replyOrPush(replyToken, groupId,
        '你好，我是工研院 AI 助手米亞 🙂\n想了解最近有哪些活動、產業趨勢、工研院技術，或是媒體邀訪需求，都歡迎直接問我！\n請在 @ 我的後面接著打問題（或用「米亞」開頭，例如「米亞 最近有哪些活動」），也可以點下面的按鈕：',
        ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明']);
      // 這則回覆本身也附了按鈕，記者點下去送出的是沒有 @ 的純文字——續問視窗沒開
      // 的話會被 handleGroupEvent() 開頭那段「沒被 @ 又不在視窗內 → 安靜」擋掉，
      // 按鈕就變成「按了沒反應」。跟其餘所有「有回答」的路徑一樣，這裡也要續命。
      await touchGroupSession(groupId);
    }
    return;
  }

  // 免 @ 續問視窗內的統一守門（批次 28）——這句話看起來不是在跟我們講，就完全安靜。
  //
  // ⚠️ 一定要放在下面那道限流「之前」。上線後實測到的兩個症狀都是這個順序造成的：
  //   ① 群組裡連續聊了十幾句自己的事（我們全程安靜、一句都沒回），第 16 句時機器人
  //      突然冒出一句「提問太頻繁，請稍候片刻再試。」——沒有人在跟它講話，這正是
  //      「亂回」本身，而且比答錯內容更莫名其妙
  //   ② 那些我們根本不會回的閒聊照樣吃掉配額，等到真的有人 @ 我們問問題時，額度
  //      早就被閒聊燒光，真正的提問反而被擋下來
  // 限流保護的是 Anthropic／Sheets 的呼叫額度，而被守門擋掉的訊息從頭到尾不會走到
  // 那些呼叫，本來就不該計入。守門在前面，計數才對得上「我們真的做了幾次事」。
  if (!mentioned && !(await looksAddressedToBot(groupId, text, speakerId))) return;

  // 用 groupId 當限流 key，跟 1 對 1 用 line_user_id 同一個理由：LINE webhook
  // 全部來自 LINE 自己的伺服器，用單一額度保護的是「這個群組」，不會因為某個人
  // 連環發問就把同一群組其他人也一起鎖住（額度本來就是共用的，這是刻意的）。
  // 走到這裡的訊息都已經通過守門（或本來就被 @ 到），也就是真的在跟我們講話——
  // 這時候回一句「提問太頻繁」是對的，不是插話。
  if (rateLimited(groupId)) {
    await replyOrPush(replyToken, groupId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // ⚠️ 群組裡刻意不接職員模式：密語比對／#代碼綁定完全跳過，一律走記者端的自然
  // 語言路由。同一群組裡可能同時有記者、公關同仁、甚至長官，密語一旦在群組裡打
  // 出來，所有在場的人都看得到——職員身分只能在私訊裡取得，這裡沒有例外。
  await handleGroupMessage(replyToken, groupId, text, { mentioned, speakerId });
}

// 被拉進群組的那一刻（批次 28）。LINE 會送一個 `join` 事件、附 replyToken——
// 在這之前這支完全沒處理，效果是被拉進群組後**什麼都不說**，然後從此只在被 @ 到時
// 才開口。對群組裡的人來說，那是一個突然出現、不講話也不知道能幹嘛的帳號，第一次
// 有人想用它時只能亂猜（回報的意見就是從這裡開始的：「被拉進群組時也要能回答，
// 不要答非所問、不會亂回」——期待要先講清楚，才不會被當成壞掉或亂回）。
//
// 這則自我介紹刻意做三件事，順序就是重要性：
//   ① 先講規矩：「我只有被 @ 到才會說話」。這是「不會亂回」最有效的一句話——
//      它同時是承諾（我不會洗版）跟操作說明（要問我就 @ 我），而且講在最前面，
//      群組成員第一眼看到的就是這個，不是功能列表。
//   ② 再講能問什麼：四條路一次講完，不要讓人自己猜（跟 sendFallbackGuide()、
//      群組「只 @ 沒接問題」那則自我介紹同一份口徑）。
//   ③ 附快速回覆按鈕，讓第一個想試的人不用先學會怎麼 @。
//
// ⚠️ 這裡呼叫 touchGroupSession()：按鈕送出的是不帶 @ 的純文字，沒有續問視窗就會被
// 「沒被 @ 又不在視窗內 → 安靜」擋掉，按鈕變成按了沒反應（跟批次 18「只 @ 沒接問題」
// 那則踩過的坑一模一樣）。開這 5 分鐘的視窗在批次 28 之前是有風險的（視窗內什麼話
// 都會被硬答），但 looksAddressedToBot() 這道守門補上之後，視窗內也只接「看起來
// 真的在跟我們講話」的訊息，開窗讓按鈕能用的代價已經降到可以接受。
async function handleGroupJoin(replyToken, ev) {
  const groupId = ev.source?.groupId || ev.source?.roomId || null;
  if (!groupId || !replyToken) return;
  console.log(`[line] 被加入群組 group=${groupId}`);
  await replyOrPush(replyToken, groupId,
    [
      '大家好，我是工研院的 AI 新聞助理米亞 🙂',
      '',
      '先說一下我的規矩：我只有被叫到的時候才會說話，平常的聊天我不會插話，也不會主動推播。',
      '',
      '要問我事情，兩種都可以：',
      '・@ 我一下，後面接著打問題',
      '・或直接用「米亞」開頭，例如「米亞 最近有哪些活動」',
      '',
      '（有些人的 @ 選單裡找不到我，那就用「米亞」開頭叫我就好。）',
      '',
      '這幾件事我都查得到：',
      '・某一場記者會的內容（直接打活動名稱，或問我「最近有哪些活動」）',
      '・整體產業趨勢（IEK 產業情報網的免費焦點）',
      '・工研院自己的技術與發表（打「工研院」加技術名稱）',
      '・想找採訪窗口（打「媒體邀訪需求」）',
      '',
      '要不要先看看目前有哪些活動？點下面的按鈕就可以。'
    ].join('\n'),
    ['最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明']);
  // 上面那排按鈕送出的是沒有 @ 的純文字，要靠續問視窗才接得住——見這支開頭的 ⚠️。
  await touchGroupSession(groupId);
}

// 跟 1 對 1（handleUnbound／handleMetaIntent／答題）共用整套邏輯，差異只有：
//   - 沒有 #代碼／ask_name 媒體名稱擷取——群組裡不會有人主動報媒體名稱，qa_log
//     統一記成「（群組提問）」
//   - 沒有「輸入中」動畫——LINE 的 /chat/loading/start 只支援一對一。批次 60 把它移到
//     handleEvent() 的 1 對 1 咽喉點之後，群組自然走不到，不必再靠呼叫端記得關掉
//   - mentioned 決定猜不出問題時要不要出聲（見 handleGroupEvent 開頭的說明）
// 其餘（跳出本場意圖、換場、軟綁定）完全沿用 1 對 1 那一套，用 groupId 當
// line_users 表的 key——等於「這個群組」自己有一份軟綁定狀態，直接複用整套 TTL／
// 換場機制，不必為群組另外維護一份幾乎一樣的邏輯。
async function handleGroupMessage(replyToken, groupId, text, { mentioned, speakerId = '' }) {
  // ⚠️ 免 @ 續問視窗的守門（looksAddressedToBot）不在這支，在呼叫端 handleGroupEvent()
  // 裡、而且刻意排在限流「之前」——走到這支的訊息都已經確定是在跟我們講話。理由見
  // 那裡的說明（被守門擋掉的訊息不該吃掉限流額度，更不該讓機器人冒出一句
  // 「提問太頻繁」插話）。守門擋掉時也不會呼叫 touchGroupSession()，理由跟批次 14
  // 「@ 到別人時安靜」一樣：不幫這種訊息續命，視窗才有機會真的到期。
  let binding = await getBinding(groupId);

  // 綁定過期（6 小時 TTL）或指向別場，但這則訊息是某一場的快速提問按鈕——把綁定接
  // 回那一場再往下走（批次 41）。
  //
  // ⚠️ 只補「守門放行了、卻沒有場次可以回答」這個洞，不是新的換場機制：
  // isOwnButtonText() 現在認得舊訊息上的按鈕（見 ownChipEventId() 的 ⚠️），但如果
  // 這裡的 getBinding() 照樣回 null，訊息會掉進 handleUnbound()，而群組沒被 @ 到時
  // 那支是 silentOnOther——結果還是「按了沒反應」，只是沉默的位置往後挪了一段。
  // 守門放行跟真的答得出來，是兩道各自獨立的門，兩道都要開。
  // 這則訊息是不是我們自己送出去的按鈕（很可能是好幾小時前那則訊息上的）。下面兩個
  // 地方都要用：接回綁定，以及最後那道「按鈕永遠不沉默」。讀的都是 60 秒快取，
  // 不會多打 Sheets。
  const ownButton = await isOwnButtonText(groupId, text, speakerId);

  if (!binding?.event_id) {
    const owned = await ownChipEventId(groupId, text);
    if (owned?.eventId && isUsable(await getEventById(owned.eventId))) {
      await upsertBinding(groupId, owned.eventId, '');
      binding = await getBinding(groupId);
      console.log(`[line] 群組點了舊按鈕，綁定接回 event=${owned.eventId} text="${text.slice(0, 40)}"`);
    }
  }

  const metaIntent = detectMetaIntent(text);
  if (metaIntent) {
    await handleMetaIntent(replyToken, groupId, text, metaIntent, binding, { speakerId, group: true });
    await touchGroupSession(groupId); // 這一輪有回答 → 續問視窗重新計時
    return;
  }

  // 全域邀訪窗口的主題按鈕／自由輸入（見 handleContactTopicMessage() 的說明）——
  // 跟 metaIntent 同一優先順序，命中就直接處理，不會被送進當前綁定活動的問答。
  if (await handleContactTopicMessage(replyToken, groupId, text, { speakerId })) {
    await touchGroupSession(groupId);
    return;
  }

  // 「想問什麼技術」按鈕之後記者打的技術名稱（見 handleTechQueryMessage() 的說明）——
  // 同一優先順序，命中就直接查、不會被送進當前綁定活動的問答。
  if (await handleTechQueryMessage(replyToken, groupId, text, { speakerId })) {
    await touchGroupSession(groupId);
    return;
  }

  if (!binding) {
    // ⚠️ silentOnOther 對「我們自己的按鈕」一律關掉（批次 41）：安靜是為了不要在群組
    // 裡對著別人的閒聊插話，但按鈕是**我們自己請對方按的**，按了沒反應永遠是 bug，
    // 不是體貼。推不出場次時 handleUnbound() 會反問「您想問哪一場」並附上清單——
    // 多問一句，比裝作沒看到好得多。
    await handleUnbound(replyToken, groupId, text, { silentOnOther: !mentioned && !ownButton, askMediaName: false, remember: false });
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
      // ⚠️ 這則原本完全沒附按鈕（1 對 1 有圖文選單頂著，看不出問題）。群組裡剛換完
      // 場正是最需要導覽的一刻：換錯了要能馬上換回去，換對了要能看到這場能問什麼。
      await replyOrPush(replyToken, groupId, `已為您換到《${target.name}》✅ 請直接問問題即可。`,
        eventQuickChips(target, { group: true }));
      await touchGroupSession(groupId);
      return;
    }
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    // 綁定指向的活動變成不可問答（例如被下架）——這種邊界情況比照 silentOnOther
    // 的邏輯：真的被 @ 到才值得說明，續問視窗內安靜跳過就好。
    if (mentioned) {
      // 一樣附上導覽：這場問不了，記者需要的是「那還能問什麼」，不是一句句點。
      await replyOrPush(replyToken, groupId, '這場活動目前無法問答，請洽現場工作人員。',
        [...NAV_HEAD, ...NAV_TAIL]);
    }
    return;
  }

  // 跟 1:1 那段同一套邏輯（完整說明見 handleEvent()）：綁定是預設值不是鎖，問句
  // 明確指向別場才自動換，其餘留在原場。群組共用一份綁定，換場會影響整個群組
  // 接下來的預設場次——跟現有「打整句活動名稱換台」本來就是同一種風險，不是
  // 這裡新增的。currentEventId 帶目前這場給 routeIntent()，讓它分得出「延續這場
  // 的討論」跟「真的無關」（見 lib/router.js 的說明），下面的安靜門檻才靠得住。
  // currentTopic 的理由跟 1 對 1 那段完全一樣（見 handleEvent() 同一行的說明）。
  const routed = pinGenericTechQueryToEvent(
    await routeIntent(text, buildCalendarCards(await getAllEventRows()),
      { currentEventId: event.id, ...(await recentTopicContext(groupId)) }),
    text, event.id);

  // 回報的意見：批次 14 只擋得住「明確 @ 別人」這種訊號很強的情況，續問視窗內
  // 純聊天、答非所問的訊息（例如「友信你覺得呢」）當時沒有安全的判斷依據——
  // routeIntent() 沒有對話記憶，分不出這種話跟「那合作廠商有哪些」這種合法續問
  // 的差別，一律判成 other。現在多了 currentEventId 提示，other 已經是「連目前
  // 這場都接不上」的結果，才能放心拿來當安靜門檻，不會連續問視窗本身要保護的
  // 案例一起擋掉。
  //
  // 真的被 @ 到時不受影響——跟 1 對 1、跟 handleUnbound() 的 silentOnOther:false
  // 同一個原則，明確叫了機器人就不能不理人。
  // 同上：按鈕不受這道安靜門檻約束。綁定中點到「這場沒有的內容」時 routeIntent()
  // 有可能判成 other，那也該老實回一句，不能讓按鈕變成按了沒反應。
  if (!mentioned && !ownButton && routed.intent === 'other') return;

  // 綁定中，但這題其實是在問「有哪些場次」——理由與 1 對 1 那段完全相同（見
  // handleEvent() 同一個分支的完整說明）。
  if (routed.intent === 'calendar') {
    await sendCalendarReply(replyToken, groupId, buildCalendarCards(await getAllEventRows()), event);
    await touchGroupSession(groupId);
    return;
  }

  // 綁定中，但這題其實在問整體產業趨勢、不是這場活動的內容——不動原本的活動
  // 綁定（跟「延續這場討論」是兩件事，換場判斷只在下面 qa 分支才做），答完照樣
  // 續問視窗續命。
  if (routed.intent === 'industry_trend') {
    await answerIndustryTrend(replyToken, groupId, text);
    await touchGroupSession(groupId);
    return;
  }

  // 同上，只是問的是工研院自己的技術，不是整體產業趨勢——一樣不動活動綁定。
  // 優先用 routeIntent() 抽出來的關鍵字，不要整句原話去查——見上面 handleUnbound()
  // 那條同樣的說明（LINE-PLAN.md 批次 22）。
  if (routed.intent === 'tech_query') {
    await answerTechQuery(replyToken, groupId, routed.tech_keyword || text);
    await touchGroupSession(groupId);
    return;
  }

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

  await answerQuestion(replyToken, groupId, answerEvent, '（群組提問）', text, { switchNotice, group: true });
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

  // 被拉進群組／多人聊天：自我介紹一次並講清楚「只有被 @ 才會說話」，見
  // handleGroupJoin() 的完整說明。這是唯一一次可以不請自來講話的時機，錯過就沒有了。
  if (ev.type === 'join') {
    await handleGroupJoin(ev.replyToken, ev);
    return;
  }

  // ⚠️ memberJoined（有「別人」加入我們所在的群組）刻意不處理：那不是在跟我們打招呼，
  // 每次有人進群就跳出來自我介紹一次，正是這個帳號最該避免的洗版行為（LINE-PLAN.md
  // 第 8 節「不要做推播行銷」）。leave／unfollow 也沒有可用的 replyToken，沒有事情
  // 可做——真的要清資料的話那是另一件事，不在這支的責任範圍。
  if (ev.type !== 'message') return; // unfollow／leave／memberJoined／postback 都不處理

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
    // 批次 79：職員傳照片 → 問要加到哪一場。記者傳照片照舊回「看不到」。
    // 限流照樣算：一次傳十張照片不能變成十次沒上限的處理。
    if ((ev.message?.type === 'image' || ev.message?.type === 'file') && await isStaffAuthenticated(userId)) {
      if (rateLimited(userId)) {
        await replyOrPush(replyToken, userId, '傳得太快了，請稍候片刻再傳。');
        return;
      }
      if (ev.message.type === 'image') {
        await handleStaffImage(replyToken, userId, ev.message.id);
      } else {
        await replyOrPush(replyToken, userId,
          '檔案我這邊還不能直接讀 🙏 新聞稿的 Word 檔，請到那場的編輯頁，用知識庫上方的「從 Word 檔匯入」。',
          staffChips('更新活動'));
      }
      return;
    }
    await replyOrPush(replyToken, userId, nonTextReply(ev.message?.type));
    return;
  }

  const text = String(ev.message.text || '').trim();
  if (!text) return;

  if (rateLimited(userId)) {
    await replyOrPush(replyToken, userId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // ── 「輸入中」動畫：每一則 1 對 1 訊息都要跑（批次 60）──────────────────────
  // 回報（附截圖）：「有時候思考會很久 有可能固定出現像截圖這種… 讓大家知道其實有在
  // 思考」。關鍵字是**「有時候」**——動畫本身早就做好了，但呼叫它的地方只有一個：
  // answerQuestion()，也就是「活動問答」那一條路。
  //
  // 於是記者的體感是這樣的：問某一場活動的內容 → 看得到動畫；問產業趨勢、工研院技術、
  // 最新新聞，或是任何掉進智慧兜底的問題 → 送出後畫面完全沒有反應。而那幾條路**恰好
  // 是比較慢的**（產業趨勢要先抓 IEK 清單、技術要先查官網，都是外部網站，再接模型），
  // 正是最需要讓人知道「我在處理」的那幾條。會動的那條反而是最快的。
  //
  // 所以這支不放在各條答題路線裡面，改放在這裡——1 對 1 的唯一咽喉點，在路由、Sheets
  // 讀取、模型呼叫**全部之前**。三個理由：
  //   ① 五條答題路線一次到位，以後新增第六條也不會漏掉（同 LAYOUT_RULE 的道理，
  //      批次 59；也是批次 53「同一件事散在好幾個地方各寫一份，遲早漂開」的教訓）
  //   ② 慢的不只是模型——routeIntent() 自己就有 15 秒逾時、Sheets 也可能卡在配額重試。
  //      放在答題函式裡的話，這段等待時間畫面上仍然是死的
  //   ③ 連職員模式、使用說明、活動清單這種快路徑也一起蓋到。它們一兩秒就回覆，動畫
  //      只會閃一下就被訊息蓋掉（LINE 收到訊息會自動收掉動畫），沒有副作用——而
  //      「固定會出現」本來就是這次回報要的東西
  //
  // ⚠️ 要 await。不 await 的話有機會「訊息先送到、loading 才送到」，那會變成答案底下
  // 掛著一個沒人收得掉的動畫，整整轉 55 秒——比沒有動畫更糟。這支自己有 3 秒逾時、
  // 也自己吞例外（見 lib/line.js startLoading），拖不住後面的答案。
  //
  // ⚠️ 群組拿不到這個。LINE 的 /chat/loading/start 官方文件明講只支援一對一，group／
  // room 傳了穩定失敗。這段在 handleGroupEvent() 分流「之後」，所以群組本來就走不到
  // 這裡。群組要有同樣的體感只能改成先送一則「稍等一下」的訊息，那等於每一題都洗兩則
  // 版——這個帳號最該避免的事（LINE-PLAN.md 第 8 節），刻意不做。
  await startLoading(userId, 55);

  // 職員模式（批次 4）：密語比對與已登入狀態一律最優先判斷，整段接管、不再往下走
  // #代碼／reporter 流程——職員用自然語言下所有指令，不用記兩套語法。
  if (isPasscodeMatch(text)) {
    if (await isStaffAuthenticated(userId)) {
      await replyOrPush(replyToken, userId, '您已經是職員模式了，直接問我就可以，不用再輸入一次密語。', staffChips());
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

  // 「想問什麼技術」按鈕之後記者打的技術名稱（見 handleTechQueryMessage() 的說明）。
  if (await handleTechQueryMessage(replyToken, userId, text)) return;

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
      await setMediaName(userId, isSkip ? '（未提供）' : sanitize(mediaNameOf(text), 40));
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
  // currentTopic 一併帶上：綁定中一樣可能剛問完產業趨勢（那條路不動活動綁定，見
  // 下面 industry_trend 分支），接著打一個裸名詞追問——沒有這個提示，那句話會被
  // currentEventId 的提示硬拉回「延續這場活動」，記者拿到的是那場的 AI 說「這部分
  // 我沒有資料」，一樣是答非所問，只是換了一種形式。見 getRecentTopic() 的說明。
  // ⚠️ 批次 58：只帶話題標籤不夠——記者的追問常常是一句完整問句（回報的截圖：
  // 「有談機器人發展的嗎」），標籤給不出任何依據，那句話照樣被 currentEventId 拉回
  // 這一場。recentTopicContext() 會連「上一則實際答了什麼」一起帶上去。
  const routed = pinGenericTechQueryToEvent(
    await routeIntent(text, buildCalendarCards(await getAllEventRows()),
      { currentEventId: event.id, ...(await recentTopicContext(userId)) }),
    text, event.id);

  // 綁定中，但這題其實是在問「有哪些場次」——不動原本的活動綁定，只列清單（跟
  // handleMetaIntent() 的 calendar 分支同一支，見 sendCalendarReply()）。
  //
  // ⚠️ 這個分支批次 57 之前**不存在**：綁定中只認 industry_trend／tech_query 兩種
  // 「跳出本場」的意圖，routeIntent() 判成 calendar 時直接掉到下面的 answerQuestion()，
  // 由那一場的 AI 拿它的知識庫回答「最近有哪些活動」——正是 handleMetaIntent() 開頭
  // 那段註解在講的原始 bug，只是換了一條路徑重演。以前沒被發現，是因為 CALENDAR_RE
  // 幾乎什麼都吃得下來；這一批把那條規則收緊（見 lib/menu.js EVENT_LOCAL_RE）之後，
  // 沒有這個分支就會變成真的漏判。規則保證、AI 涵蓋，兩層都要有（CLAUDE.md 第 2 條）。
  if (routed.intent === 'calendar') {
    console.log(`[line] 綁定中被判成 calendar，改列清單 q="${text.slice(0, 40)}"`);
    await sendCalendarReply(replyToken, userId, buildCalendarCards(await getAllEventRows()), event);
    return;
  }

  // 綁定中，但這題其實在問整體產業趨勢、不是這場活動的內容——不動原本的活動綁定
  // （跟「延續這場討論」是兩件事，換場判斷只在下面才做），記者下一題還是繼續問
  // 原本那場。
  if (routed.intent === 'industry_trend') {
    await answerIndustryTrend(replyToken, userId, text);
    return;
  }

  // 同上，只是問的是工研院自己的技術，不是整體產業趨勢——一樣不動活動綁定。
  // 優先用 routeIntent() 抽出來的關鍵字，不要整句原話去查——見 handleUnbound()
  // 那條同樣的說明（LINE-PLAN.md 批次 22）。
  if (routed.intent === 'tech_query') {
    await answerTechQuery(replyToken, userId, routed.tech_keyword || text);
    return;
  }

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

  await answerQuestion(replyToken, userId, answerEvent, binding.media_name, text, { switchNotice, memory: true });
}

// ── 例外的出口：記者永遠不該面對「已讀不回」（批次 57）────────────────────
// 實測（test/test-resilience.mjs 把 events 表的讀取換成會丟例外的版本）：Sheets 一
// 出狀況，記者送出的那一則問題**一個字都不會有回應**——handler 的 catch 只 console.error，
// Vercel Logs 上很乾淨，記者那邊就是已讀不回。
//
// 這是 CLAUDE.md 第 4 條「送出成功 ≠ 使用者看得到」的另一面：**我們自己知道出事了，
// 但沒有人告訴記者**。而且它最容易發生的時機正好是最不能出事的時機——記者會開場後
// 十分鐘，幾十位記者同時發問，Sheets 那個「每分鐘 60 次、全站共用」的配額最緊繃
// （見 lib/sheets.js fetchWithRetry() 的說明）。
//
// 為什麼補在這裡、而不是在每一支可能丟例外的函式裡各自 try：這是**結構性保證**，
// 跟 replyOrPush() 包一層補群組導覽、跟 toTraditionalTW() 擋在出口是同一招（CLAUDE.md
// 第 2 條）。往後任何人新增一條問答路線、忘了自己接例外，記者一樣拿得到一句人話。
//
// ⚠️ 群組只有「真的被叫到」才道歉。沒被 @ 到、也沒用喚醒詞的訊息，我們本來就不該
// 開口——如果因為處理它的過程中出了例外就跳出來講話，那正是這個帳號最該避免的插話
// （而且看起來像莫名其妙的鬼打牆）。判斷只看事件本身（mention／喚醒詞），不再碰任何
// 會再丟一次例外的 I/O。
// ⚠️ 整支包在 try 裡：道歉本身失敗（LINE API 也掛了）不能再往外丟，那會讓 handler
// 回 500，LINE 就會重送整批 webhook，變成雪上加霜的重試風暴。
async function apologise(ev, cause) {
  try {
    if (ev?.type !== 'message' || !ev.replyToken) return;
    const isDirect = ev.source?.type === 'user';
    const targetId = isDirect ? ev.source?.userId : (ev.source?.groupId || ev.source?.roomId);
    if (!targetId) return;
    if (!isDirect) {
      const rawText = ev.message?.type === 'text' ? String(ev.message.text || '') : '';
      const addressed = isBotMentioned(ev.message?.mention) || WAKE_WORD_RE.test(rawText);
      if (!addressed) return; // 沒在跟我們講話，出錯也不要插話
    }
    console.error(`[line] 回覆道歉訊息 target=${targetId} cause=${cause?.message || '-'}`);
    // reply token 60 秒只能用一次，走到這裡多半還沒被用掉（例外通常發生在送出回覆
    // 之前）；真的用掉了 replyOrPush() 會自動退回 push，記者一樣收得到。
    await replyOrPush(ev.replyToken, targetId,
      '不好意思，我這邊剛剛卡住了，這一題沒能查出來 🙏\n麻煩再問我一次；如果連續幾次都這樣，打「找真人」或直接洽現場新聞聯絡人，不要等我。');
  } catch (e) {
    console.error('道歉訊息也送不出去:', e.message);
  }
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

  // 這一次 function 呼叫的死線（見 msLeft() 的說明）。從這裡起算——LINE 那邊的
  // reply token 也是 60 秒，兩個時鐘一起起跑最貼近實情。
  await requestCtx.run({ deadlineAt: Date.now() + REQUEST_BUDGET_MS }, async () => {
    // 依序處理、不平行——記者會現場的量級不需要平行處理，依序執行也不會讓同一批
    // webhook 裡的多個事件互搶 Anthropic／Sheets 配額。
    for (const ev of events) {
      try {
        await handleEvent(ev);
      } catch (e) {
        // 單一事件出錯不能讓整支回 500——LINE 收到非 2xx 會重送整批 webhook，
        // 容易在配額耗盡或 Anthropic 暫時出狀況時觸發重試風暴、雪上加霜。
        console.error('LINE 事件處理失敗:', e.message, ev?.type);
        await apologise(ev, e); // ⚠️ 記 log 不夠，記者那邊看到的是「已讀不回」，見該支的說明
      }
    }
  });

  return res.status(200).json({ ok: true });
}
