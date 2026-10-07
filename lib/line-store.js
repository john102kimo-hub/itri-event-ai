// 米亞（LINE）的資料層：活動列快取、line_users 綁定、群組免 @ 視窗、話題與上一輪對話記憶。
//
// 批次 117 從 api/line.js 搬出來（那支當時五千行，改一個地方要先翻過幾千行無關的程式）。
// 程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。要找某一段的來龍去脈，拿註解裡的批次號碼去 docs/batches/ 找。
//
// ⚠️ 兩份模組層快取（eventsCache、lineUsersCache）只在這支裡讀寫。別的檔案改了試算表要清快取，
// 呼叫 invalidateEventsCache()／invalidateLineUsersCache()，不要自己另外存一份。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { sanitize } from './line-format.js';

const EVENTS_RANGE = 'events!A2:R'; // P 欄是 contacts（邀訪窗口分工），Q 欄是 invite_letter（媒體邀請函），R 欄是 invite_letter_chips（活動前快速提問），見 rowToEvent()
// line_user_id | event_id | media_name | bound_at | last_active | note | group_session_until | last_topic
// G 欄只有群組會用到（1 對 1 每則訊息本來就都是對我們講的，不需要這個概念），見
// getGroupSessionUntil()／touchGroupSession() 的說明。
// H 欄是「上一則剛回答完的是哪一類非活動題」，1 對 1 與群組都會用到，見
// getRecentTopic()／setRecentTopic() 的說明。
export const LINE_USERS_RANGE = 'line_users!A2:J'; // I 欄是 last_turn（上一輪對話記憶），見 getRecentTurn()；J 欄是群組裡每個人各自的上一輪，見 setGroupTurn()
const BIND_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時；沒有這個 TTL，記者三個月後問別場會被鎖在當初掃的那一場
export const CACHE_TTL_MS = 60 * 1000; // 跟 api/chat.js 的 eventCache 同一套邏輯

// ── events 表快取：整張表一次讀進記憶體，60 秒 TTL ──────────────────────
let eventsCache = { rows: null, expiry: 0 };
export async function getAllEventRows() {
  if (eventsCache.rows && Date.now() < eventsCache.expiry) return eventsCache.rows;
  const rows = await readRange(EVENTS_RANGE);
  eventsCache = { rows, expiry: Date.now() + CACHE_TTL_MS };
  return rows;
}
// 職員從 LINE 寫進 events 表之後要清掉（批次 76）：不清的話，剛建好的活動在同一個
// instance 上最多 60 秒查不到——清單上沒有、問「哪一場」的按鈕也沒有。
export function invalidateEventsCache() { eventsCache = { rows: null, expiry: 0 }; }
export function rowToEvent(row) {
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
export async function findEventByCode(code) {
  const norm = String(code || '').trim().toLowerCase();
  if (!norm) return null;
  const rows = await getAllEventRows();
  const row = rows.find(r => String(r[0] || '').trim().toLowerCase() === norm);
  return row ? rowToEvent(row) : null;
}
export async function getEventById(id) {
  if (!id) return null;
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === id);
  return row ? rowToEvent(row) : null;
}
// draft／archived 一律當不存在，跟 api/chat.js、api/event-page.js 同一條規則
export function isUsable(event) {
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
export function invalidateLineUsersCache() { lineUsersCache = { rows: null, expiry: 0 }; }

// 綁定物件：{event_id, media_name} 或 null（沒綁定／已過期）。
// bound_at／last_active 存的是 epoch 毫秒字串，不是人看的日期字串——這欄要拿來做 TTL
// 數學比較，用「2026/8/20 下午2:30」這種在地化字串存，Node 的 Date 解析器不保證讀得回來，
// 6 小時的判斷就會整個失準。要看人看得懂的時間，qa_log 的 timestamp 欄本來就有。
export async function getBinding(userId) {
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
export async function getStoredEventId(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  return row ? (row[1] || '') : '';
}

export async function getStoredMediaName(userId) {
  const rows = await getAllLineUserRows();
  const row = rows.find(r => r[0] === userId);
  return row ? (row[2] || '') : '';
}

// note（F 欄）的原始值，不管綁定是否過期——跟 getStoredMediaName() 同一個理由：
// getBinding() 過期就回 null，但「有沒有等待中的一次性旗標」跟「活動綁定還算不算數」
// 是兩件事，全域邀訪窗口的 await_contact_topic 旗標（見 setContactPending()）常常是
// 在完全沒有活動綁定的情況下設的，不能透過 getBinding() 去讀。
export async function getStoredNote(userId) {
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
export async function ensureLineUsersSheet() {
  if (sheetsEnsuredAt === Infinity) return;
  if (Date.now() - sheetsEnsuredAt < ENSURE_RETRY_MS) return;
  try {
    await ensureSheets({ line_users: ['line_user_id', 'event_id', 'media_name', 'bound_at', 'last_active', 'note', 'group_session_until', 'last_topic', 'last_turn', 'group_turns'] });
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
export async function upsertBinding(userId, eventId, noteOverride) {
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

export async function setMediaName(userId, name) {
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
export async function setBindingNote(userId, note) {
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
export async function setContactPending(targetId, note) {
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
export async function clearBinding(userId) {
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
export async function getGroupSessionUntil(groupId) {
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
// 'calendar'（批次 101）：剛剛送出過「近期活動」清單。routeIntent() 的 TOPIC_HINTS 沒有
// 這一項，所以不會影響路由；只給 matchShownEvents() 那條規則判斷「這句是不是在點清單上的名稱」。
const VALID_TOPICS = ['industry_trend', 'tech_query', 'calendar'];

export async function getRecentTopic(targetId) {
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

export async function setRecentTopic(targetId, topic, { question = '', answer = '', keepTurn = false } = {}) {
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
    } else if (keepTurn) {
      // 只動 H：清單不是一輪問答，不能把綁定中那場的上一輪（I 欄）蓋掉
      await updateRange(`line_users!H${idx + 2}`, [[value]]);
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
export async function recentTopicContext(targetId) {
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
// ⚠️ 群組不用這一格（呼叫端傳 memory:false）——群組裡多個人交錯提問，整個群組共用
// 一份「上一輪」，很可能是別人的問題，回放進去製造的正是「答非所問」。批次 83 起群組
// 改成**照發問的人**各記各的，存在 J 欄，見 setGroupTurn()。
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

export async function setRecentTurn(targetId, eventId, question, answer) {
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
export async function buildTurnHistory(targetId, eventId) {
  const turn = await getRecentTurn(targetId);
  if (!turn || turn.event_id !== String(eventId || '')) return [];
  return [{ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a }];
}

// ── 群組：每個人各記各的上一題（J 欄，批次 83）────────────────────────────
// 批次 28 決定群組不開對話記憶，理由是「群組多人交錯提問，上一輪多半是別人的問題」——
// 那個顧慮是對的，要改的是記憶的單位：跟著**發問的那個人**記，不是跟著整個群組記。
// 於是群組裡也接得住「那良率呢？」這種省略式追問，而且只會接上**同一個人**的上一題，
// 別人剛問的不會混進來。
//
// ⚠️ 用獨立的 J 欄，不能借 I 欄：群組那一列的 I 欄已經被產業趨勢／技術題的話題記憶
// 用掉了（見 setRecentTopic()，那份節錄是路由判「追問」的依據），兩邊搶同一格會互相
// 蓋掉。
// 格式：{ "<LINE userId>": { t, e, q, a }, … }，只留 TURN_TTL_MS 內、最近
// GROUP_TURN_MAX_SPEAKERS 位（控制儲存格大小；一段時間內會連續追問的人不會太多）。
// 拿不到發問者的 userId（LINE 在使用者沒同意時可能不給）就不記——寧可沒記憶，也不要
// 把別人的上一題當成他的。同一群組兩人同時發問、剛好落在不同執行個體時，後寫的會蓋掉
// 先寫的那一位——頂多是那一位的下一題沒有脈絡，退回原本「不記」的行為，可以接受。
const GROUP_TURN_MAX_SPEAKERS = 6;
function parseGroupTurns(raw) {
  try {
    const o = raw ? JSON.parse(raw) : null;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
export async function buildGroupTurnHistory(groupId, speakerId, eventId) {
  if (!speakerId) return [];
  const rows = await getAllLineUserRows();
  const t = parseGroupTurns(rows.find(r => r[0] === groupId)?.[9])[speakerId];
  if (!t || !t.q || !t.a || String(t.e || '') !== String(eventId || '')) return [];
  if (Date.now() - (Number(t.t) || 0) > TURN_TTL_MS) return [];
  return [{ role: 'user', content: String(t.q) }, { role: 'assistant', content: String(t.a) }];
}
export async function setGroupTurn(groupId, speakerId, eventId, question, answer) {
  if (!speakerId) return;
  try {
    await ensureLineUsersSheet();
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === groupId);
    if (idx === -1) return; // 走到這裡群組一定已經有綁定那一列，理論上不會發生
    const now = Date.now();
    const all = parseGroupTurns(rows[idx][9]);
    all[speakerId] = { t: now, e: String(eventId || ''), q: sanitize(question, TURN_Q_MAX), a: sanitize(answer, TURN_A_MAX) };
    const kept = Object.entries(all)
      .filter(([, v]) => v && now - (Number(v.t) || 0) <= TURN_TTL_MS)
      .sort((a, b) => (Number(b[1].t) || 0) - (Number(a[1].t) || 0))
      .slice(0, GROUP_TURN_MAX_SPEAKERS);
    await updateRange(`line_users!J${idx + 2}`, [[JSON.stringify(Object.fromEntries(kept))]]);
  } catch (e) {
    console.error('setGroupTurn 失敗:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// 每次我們真的在群組裡回答了什麼，就呼叫這支幫時間窗續命。跟 upsertBinding() 分開
// 寫，是因為呼叫時機不一樣：這支要在「所有」有回答的路徑後面都呼叫一次（活動列表、
// 換場提示、真正的問答…），upsertBinding() 只在換場／軟綁定那幾個特定時機才呼叫。
export async function touchGroupSession(groupId) {
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
