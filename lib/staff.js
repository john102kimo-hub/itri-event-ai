// LINE 職員模式——同仁／主管輸入密語後，同一個 LINE 帳號多出一套內部指令：
// 查活動列表／問特定活動內容（含 draft，一般記者問不到的也能問）、查某場後台數據、
// 查 GEO 掃描狀態、新增活動並直接拿到同仁編輯連結、要某場的媒體訓練連結。
//
// 安全模型（先講清楚，這不是隨便寫寫的密語）：
//   - 密語存在 LINE_STAFF_PASSCODE 環境變數，不寫死在程式碼裡。這是「一次性口令」，
//     不是帳密——任何人講對這個詞，這個 LINE 帳號就永久記住他是職員，直到你自己去
//     Google Sheet 的 line_staff 分頁刪掉那一列。
//   - 第一次成功用密語登入，會回傳這個人自己的 LINE userId，並提醒設定
//     LINE_ADMIN_USER_ID——設定之後，之後每一次「有新的人用密語登入」都會推播通知你，
//     密語外流被拿去亂用時你才有機會第一時間發現、去表刪掉那個 userId。
//   - 職員模式一旦啟用，proceeds 用自然語言下指令，不用記兩套語法；問得到 draft／
//     archived 場次的內容（reporter 那套 isUsable() 限制不套用在這裡）——這是刻意的，
//     同仁本來就該問得到「還沒發布」的活動在準備什麼。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { generateId, generateEditCode } from './ids.js';
import { getProfile, pushMessage } from './line.js';

const SITE = 'https://itri-event-ai.vercel.app';
const EVENTS_RANGE = 'events!A2:P'; // P 欄是 contacts（邀訪窗口分工），見 getEventRawById()
// line_user_id | display_name | authorized_at | note | pending
// E 欄（pending）是「上一則我問了他哪一場，還在等回答」的短暫狀態，見 getStaffPending()
const LINE_STAFF_RANGE = 'line_staff!A2:E';
const CACHE_TTL_MS = 60 * 1000;

const sanitize = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── 密語比對 ─────────────────────────────────────────────────────────
export function isPasscodeMatch(text) {
  const passcode = process.env.LINE_STAFF_PASSCODE;
  if (!passcode) return false; // 沒設定就整個功能停用，不會意外開放
  return String(text || '').trim().toLowerCase() === passcode.trim().toLowerCase();
}

// ── line_staff 表：讀取快取 60 秒 ────────────────────────────────────
let staffCache = { rows: null, expiry: 0 };
async function getAllStaffRows() {
  if (staffCache.rows && Date.now() < staffCache.expiry) return staffCache.rows;
  let rows = [];
  try { rows = await readRange(LINE_STAFF_RANGE); } catch { rows = []; } // 分頁還沒建立時不要整支掛掉
  staffCache = { rows, expiry: Date.now() + CACHE_TTL_MS };
  return rows;
}
function invalidateStaffCache() { staffCache = { rows: null, expiry: 0 }; }

// D 欄（note）標 'revoked' 代表已退出職員模式。用標記而不是刪列，是因為這是一份
// 權限授予紀錄：誰在什麼時候拿過內部權限、什麼時候交回來，出事時要查得到。
// 真的要徹底移除某個人，還是去 Google Sheet 把那一列刪掉（原本的做法沒有變）。
const REVOKED = 'revoked';

export async function isStaffAuthenticated(userId) {
  const rows = await getAllStaffRows();
  return rows.some(r => r[0] === userId && r[3] !== REVOKED);
}

// 退出職員模式的指令。這幾句一定要在 routeStaffIntent() 之前用字面比對攔下來——
// 交給 AI 判意圖的話會被歸到 'other'，使用者只會拿到一份能力清單、永遠退不出去
// （這是實際回報的狀況）。權限的開與關不該取決於模型當下判得準不準。
const EXIT_STAFF_RE = /^(退出|離開|結束|關閉|取消)\s*(職員|員工|內部|管理)?\s*(模式|身分|權限)?$|^(登出|logout|exit|quit)$/i;
export function isExitStaffCommand(text) {
  const s = String(text || '').trim();
  // 「退出」「離開」單獨一個詞太容易誤觸（記者也可能打），要求至少帶一個修飾詞
  if (/^(退出|離開|結束|關閉|取消)$/.test(s)) return false;
  return EXIT_STAFF_RE.test(s);
}

// 交回職員權限。找不到那個人也回 true——呼叫端只在確認過 isStaffAuthenticated()
// 之後才會叫這支，真的找不到列代表狀態本來就不是職員，對使用者而言結果一樣。
export async function revokeStaff(userId) {
  try {
    const rows = await readRange(LINE_STAFF_RANGE);
    const idx = rows.findIndex(r => r[0] === userId && r[3] !== REVOKED);
    if (idx === -1) return true;
    await updateRange(`line_staff!D${idx + 2}`, [[REVOKED]]);
    return true;
  } catch (e) {
    console.error('revokeStaff 失敗:', e.message);
    return false;
  } finally {
    invalidateStaffCache();
  }
}

// ── 追問狀態（pending）────────────────────────────────────────────────
// ⚠️ 這是實際回報的 bug：同仁打「查活動後台數據」→ 系統回「請問是想查哪一場？」→
// 同仁打「四足」→ 卻跑去回答四足那場的活動內容。
//
// 根因是職員模式完全無狀態：每一則訊息都各自重新丟給 routeStaffIntent() 判一次。
// 「四足」單獨看就是一個活動名稱，模型判成 qa（問這場的內容）完全合理——問題不在
// 模型判錯，而在於沒有人告訴它「上一句我問的是哪一場後台數據」。
//
// 所以把「我正在等他回答哪一場」存進 line_staff 的 E 欄。這一欄的讀取是免費的：
// isStaffAuthenticated() 本來就要讀同一批列。寫入只發生在真的要追問的時候。
//
// 存試算表而不是放記憶體 Map：Vercel 的 serverless instance 不保證同一個人的下一則
// 訊息會落在同一個 instance 上。用記憶體會變成「有時候可以有時候不行」，那比穩定
// 壞掉更難查。
const PENDING_TTL_MS = 10 * 60 * 1000; // 追問超過 10 分鐘就當作沒這回事，避免很久以後的一句話被誤接

// 回傳還在有效期內的追問意圖字串，否則 null。格式：'意圖:毫秒時戳'
export async function getStaffPending(userId) {
  const rows = await getAllStaffRows();
  const row = rows.find(r => r[0] === userId && r[3] !== REVOKED);
  const raw = row?.[4] || '';
  if (!raw) return null;
  const [intent, at] = String(raw).split(':');
  if (!intent || !at) return null;
  if (Date.now() - Number(at) > PENDING_TTL_MS) return null;
  return intent;
}

// intent 傳空字串就是清掉。呼叫端只在「本來就有 pending」時才清，避免每一則職員
// 訊息都多一次試算表寫入。
export async function setStaffPending(userId, intent) {
  try {
    const rows = await readRange(LINE_STAFF_RANGE);
    const idx = rows.findIndex(r => r[0] === userId && r[3] !== REVOKED);
    if (idx === -1) return;
    await updateRange(`line_staff!E${idx + 2}`, [[intent ? `${intent}:${Date.now()}` : '']]);
  } catch (e) {
    console.error('setStaffPending 失敗:', e.message);
  } finally {
    invalidateStaffCache();
  }
}

// 目前仍具職員身分的 userId。設定圖文選單時要把這些人換成職員選單，
// 不然既有職員得先退出再登入一次才看得到自己那套。
export async function listActiveStaffIds() {
  const rows = await getAllStaffRows();
  return rows.filter(r => r[0] && r[3] !== REVOKED).map(r => r[0]);
}

// 成功才記住，失敗 60 秒後再試——理由同 api/line.js 的 ensureLineUsersSheet()：
// 失敗也記成「已完成」的話，冷啟動第一次剛好撞到 Sheets 暫時性錯誤，這個 instance
// 就永遠不會建立 line_staff 分頁，職員登入從此靜靜地寫不進去。
let staffSheetEnsuredAt = 0;
async function ensureStaffSheet() {
  if (staffSheetEnsuredAt === Infinity) return;
  if (Date.now() - staffSheetEnsuredAt < 60 * 1000) return;
  try {
    await ensureSheets({ line_staff: ['line_user_id', 'display_name', 'authorized_at', 'note', 'pending'] });
    staffSheetEnsuredAt = Infinity;
  } catch (e) {
    console.error('ensureSheets(line_staff) 失敗，60 秒後再試:', e.message);
    staffSheetEnsuredAt = Date.now();
  }
}

// 寫入 line_staff、盡量取得顯示名稱、通知既有的 owner（若已設定 LINE_ADMIN_USER_ID）。
// 呼叫端要先自己確認這個 userId 還不是職員，避免重複寫入同一個人。
export async function authenticateStaff(userId) {
  await ensureStaffSheet();
  const displayName = await getProfile(userId);
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    // 退出過又用密語登入回來的人，把原本那列的 revoked 標記清掉就好，不要再 append
    // 一列——同一個 userId 出現兩列會讓「這個人到底還是不是職員」變成要看順序，
    // 也讓稽核紀錄愈滾愈亂。
    const rows = await readRange(LINE_STAFF_RANGE);
    const revokedIdx = rows.findIndex(r => r[0] === userId && r[3] === REVOKED);
    if (revokedIdx !== -1) {
      await updateRange(`line_staff!B${revokedIdx + 2}:D${revokedIdx + 2}`, [[displayName || rows[revokedIdx][1] || '', now, '']]);
    } else {
      await appendRows('line_staff!A:D', [[userId, displayName || '', now, '']]);
    }
  } catch (e) {
    console.error('寫入 line_staff 失敗:', e.message);
  }
  invalidateStaffCache();

  const ownerId = process.env.LINE_ADMIN_USER_ID;
  if (ownerId && ownerId !== userId) {
    pushMessage(ownerId,
      `🔓 新的職員模式登入\n姓名：${displayName || '（無法取得名稱）'}\nLINE ID：${userId}\n時間：${now}\n\n不是你認識的人的話，請立刻到 Google Sheet 的 line_staff 分頁刪掉這一列，並更換 LINE_STAFF_PASSCODE。`
    ).catch(() => {});
  }
  return { displayName };
}

// ── events 表直接讀（職員指令用量低，不特別另外維護一份快取）────────────
async function getAllEventRowsForStaff() {
  try { return await readRange(EVENTS_RANGE); } catch { return []; }
}
// 沒有編輯碼就當場補一個，跟 api/events.js 的 ensure_edit_code 同一套邏輯
// （舊活動建立時還沒有這個欄位）。原本查無編輯碼是回一句「請先到後台開啟一次該活動
// 的編輯連結」——同仁在手機上收到這句話等於這個功能沒用，還得先開電腦做一件他不會
// 知道怎麼做的事。補碼本來就是冪等的，直接補完把連結給他。
export async function ensureEventEditCode(eventId) {
  const rows = await getAllEventRowsForStaff();
  const idx = rows.findIndex(r => r[0] === eventId);
  if (idx === -1) return null;
  const existing = rows[idx][10];
  if (existing) return existing;
  const editCode = generateEditCode();
  try {
    await updateRange(`events!K${idx + 2}`, [[editCode]]);
  } catch (e) {
    console.error('補編輯碼失敗:', e.message);
    return null;
  }
  return editCode;
}

export async function getEventRawById(eventId) {
  const rows = await getAllEventRowsForStaff();
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active',
    chips: row[6] || '', images: row[7] || '', organizer: row[9] || '工研院',
    press_contact: row[14] || '', contacts: row[15] || ''
  };
}

export function editLink(id, editCode) {
  return `${SITE}/edit?id=${encodeURIComponent(id)}&code=${encodeURIComponent(editCode)}`;
}
export function trainingLink(id, editCode) {
  return `${SITE}/training?id=${encodeURIComponent(id)}&code=${encodeURIComponent(editCode)}`;
}

// 新增活動（永遠是 draft）：跟 api/events.js 的 create 邏輯一致——只給名稱與可選日期，
// 其餘留白讓同仁自己到編輯連結補。不透過 HTTP 打 api/events.js，直接寫表，
// 少一趟自我呼叫的網路往返與密碼傳遞。
export async function createDraftEvent(name, dateStr) {
  const cleanName = sanitize(name, 100);
  const newId = generateId(cleanName);
  const editCode = generateEditCode();
  const created_at = dateStr || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  await appendRows('events!A:O', [[
    newId, cleanName, '#0F9E7A', '', 'draft', created_at,
    '', '', '', '工研院', editCode, '', '', '', ''
  ]]);
  return { id: newId, name: cleanName, editCode };
}

// ── 後台數據（輕量版，只給 LINE 短訊息用；完整版看網頁後台的「問答分析」）──
export async function getEventAnalyticsSummary(eventId, eventName) {
  let rows = [];
  try { rows = await readRange('qa_log!A2:H'); } catch { rows = []; }
  const valid = rows.filter(r => r[1] === eventId && r[1] && r[1] !== '[deleted]' && r[6] !== '1');
  const mediaSet = new Set(valid.map(r => r[3]).filter(m => m && m !== '（未填寫）'));
  const lineCount = valid.filter(r => (r[7] || 'web') === 'line').length;
  return {
    eventId,
    eventName,
    total: valid.length,
    mediaCount: mediaSet.size,
    lineCount,
    webCount: valid.length - lineCount,
    recentQuestions: valid.slice(-3).map(r => r[4]).filter(Boolean)
  };
}
export function formatEventAnalyticsReply(s) {
  const lines = [`【${s.eventName}】後台數據`];
  lines.push(`累積問答：${s.total} 則（網頁 ${s.webCount}・LINE ${s.lineCount}）`);
  lines.push(`服務媒體：${s.mediaCount} 家`);
  if (s.recentQuestions.length) {
    lines.push('最近提問：');
    s.recentQuestions.forEach(q => lines.push('・' + String(q).slice(0, 40)));
  }
  if (s.total === 0) lines.push('（這場還沒有任何問答紀錄）');
  // 連結直接給出來，不要只寫「請到後台看」——同仁在手機上看到那句話還要自己想辦法
  // 找網址，等於這個回覆只講了一半。LINE 會把純文字網址自動變成可點的連結。
  lines.push('');
  lines.push(`完整問答分析（需後台密碼）：\n${SITE}/admin`);
  if (s.eventId) lines.push(`這場的記者問答頁：\n${SITE}/event?id=${encodeURIComponent(s.eventId)}`);
  return lines.join('\n');
}

// ── GEO 狀態：不重新實作 api/geo.js 的邏輯（那份還在另一批工作持續變動），
// 內部打它既有的 action=status／action=series，重用已經測過的邏輯，兩邊資料
// 不會兜不起來。
export async function getGeoStatusSummary() {
  const admin = process.env.ADMIN_PASSWORD;
  if (!admin) return null;
  try {
    const res = await fetch(`${SITE}/api/geo?action=status&password=${encodeURIComponent(admin)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('查詢 GEO 狀態失敗:', e.message);
    return null;
  }
}
export const geoLink = () => `${SITE}/geo`;

// 回報的意見：原本的回覆把「啟用引擎」「判官」「CRON_SECRET 未設定」這些內部設定
// 細節全部倒給同仁看，這些是工程除錯用的資訊，不是公關人員想知道的「現在狀況」。
// 改成只留：今天的日期、進度、剩幾題、以及唯一真的算「警訊」的 ready 檢查（那代表
// 環境變數少設了什麼，掃描可能根本沒在跑，這種才值得用 ⚠️ 標出來）。
export function formatGeoStatusReply(data) {
  if (!data) {
    return `GEO 狀態目前查詢不到，可能是這個功能還沒啟用，或內部查詢暫時失敗。\n\n直接看儀表板：\n${geoLink()}`;
  }
  const lines = [`【GEO 掃描狀態】${data.date || ''}`];
  lines.push(`今日進度：${data.done ?? '—'} / ${data.total ?? '—'}（剩 ${data.remaining ?? '—'} 題）`);
  if (data.ready) lines.push(`⚠️ ${data.ready}`);
  lines.push('');
  lines.push(`完整趨勢圖表：\n${geoLink()}`);
  return lines.join('\n');
}

// ── GEO 趨勢資料：給 lib/geo-brief.js 組職員簡報用 ──────────────────────
// ⚠️ 原本這裡還有一支 buildGeoTrendChartUrl()，把 series 資料組成 QuickChart.io
// 的圖表網址、直接當 LINE image 訊息送出去。使用者回報圖片一直是壞掉的圖示，
// 查證後：14 天資料量的網址實測長度落在 1200+ 字元，超過 LINE image 訊息
// originalContentUrl 官方文件記載的 1000 字元上限——不是偶發故障，是這個做法
// 資料量到一定規模後注定會壞。改用 LINE 原生 Flex Message 畫長條圖（見
// lib/geo-brief.js），不靠外部服務組網址，沒有網址長度這個天花板。
// test/test-geo-chart.mjs 原本測的就是這支被移除的函式，已經改測 lib/geo-brief.js。
export async function getGeoTrendSeries(days = 14) {
  const admin = process.env.ADMIN_PASSWORD;
  if (!admin) return null;
  try {
    const res = await fetch(`${SITE}/api/geo?action=series&password=${encodeURIComponent(admin)}&days=${days}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('查詢 GEO 趨勢失敗:', e.message);
    return null;
  }
}

// ── 職員意圖路由：跟 lib/router.js 的 routeIntent() 同一套手法，意圖集合擴充成
// 職員專用的七種，多一組 new_event_name／new_event_date 給 create_event 用。──
const VALID_STAFF_INTENTS = ['calendar', 'qa', 'geo_status', 'event_analytics', 'create_event', 'training_link', 'setup_richmenu', 'other'];

export async function routeStaffIntent(userText, cards) {
  const fallback = { intent: 'other', event_ids: [], new_event_name: '', new_event_date: '', confidence: 'low' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const list = cards
    .slice()
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, 200)
    .map(c => `${c.id}｜${c.name}｜${c.date ? isoDate(c.date) : '未排定'}｜${c.status}｜${c.has_kb ? '有資料' : '僅基本資料'}`)
    .join('\n');

  const systemPrompt = `你是記者會系統的內部職員助理，服務對象是工研院同仁與主管（不是記者），根據訊息判斷意圖，只回傳 JSON，不要有其他文字。

意圖七選一：
- "calendar"：問活動列表、時程
- "qa"：問某一場活動的內容細節（跟記者會問的問題類似）
- "geo_status"：問 GEO／AI 能見度掃描狀態、判官設定、掃描進度
- "event_analytics"：問某一場活動的後台數據、問答統計、成效、媒體家數
- "create_event"：要新增一場活動（訊息通常會有新活動名稱，也可能提到日期）
- "training_link"：要某一場活動的媒體訓練連結
- "setup_richmenu"：要安裝／更新／重設 LINE 聊天室下方的圖文選單（主選單、功能選單）
- "other"：其他、閒聊、意圖不明

以下是目前活動清單（id｜名稱｜日期｜狀態｜資料狀態，狀態含 draft／active／ended／archived，職員可以查全部）：
${list}

只回傳這個格式的 JSON：
{"intent":"calendar|qa|geo_status|event_analytics|create_event|training_link|setup_richmenu|other","event_ids":["qa/event_analytics/training_link 用，從清單挑 id，最多3個"],"new_event_name":"create_event 才有，新活動名稱","new_event_date":"create_event 才有，YYYY-MM-DD，訊息沒提到就留空字串","confidence":"high|low"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: String(userText || '').slice(0, 500) }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'staff router API 錯誤');

    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);

    const intent = VALID_STAFF_INTENTS.includes(parsed.intent) ? parsed.intent : 'other';
    const validIds = new Set(cards.map(c => c.id));
    const event_ids = Array.isArray(parsed.event_ids) ? parsed.event_ids.filter(id => validIds.has(id)).slice(0, 3) : [];
    return {
      intent, event_ids,
      new_event_name: sanitize(parsed.new_event_name, 100),
      new_event_date: typeof parsed.new_event_date === 'string' ? parsed.new_event_date.trim() : '',
      confidence: parsed.confidence === 'high' ? 'high' : 'low'
    };
  } catch (e) {
    console.error('職員意圖路由失敗:', e.message);
    return fallback;
  }
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
