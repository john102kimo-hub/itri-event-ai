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

import { readRange, appendRows, ensureSheets } from './sheets.js';
import { generateId, generateEditCode } from './ids.js';
import { getProfile, pushMessage } from './line.js';

const SITE = 'https://itri-event-ai.vercel.app';
const EVENTS_RANGE = 'events!A2:O';
const LINE_STAFF_RANGE = 'line_staff!A2:D'; // line_user_id | display_name | authorized_at | note
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

export async function isStaffAuthenticated(userId) {
  const rows = await getAllStaffRows();
  return rows.some(r => r[0] === userId);
}

let staffSheetEnsured = false;
async function ensureStaffSheet() {
  if (staffSheetEnsured) return;
  try {
    await ensureSheets({ line_staff: ['line_user_id', 'display_name', 'authorized_at', 'note'] });
  } catch (e) {
    console.error('ensureSheets(line_staff) 失敗:', e.message);
  }
  staffSheetEnsured = true;
}

// 寫入 line_staff、盡量取得顯示名稱、通知既有的 owner（若已設定 LINE_ADMIN_USER_ID）。
// 呼叫端要先自己確認這個 userId 還不是職員，避免重複寫入同一個人。
export async function authenticateStaff(userId) {
  await ensureStaffSheet();
  const displayName = await getProfile(userId);
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    await appendRows('line_staff!A:D', [[userId, displayName || '', now, '']]);
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
export async function getEventEditCode(eventId) {
  const rows = await getAllEventRowsForStaff();
  const row = rows.find(r => r[0] === eventId);
  return row ? (row[10] || '') : null;
}
export async function getEventRawById(eventId) {
  const rows = await getAllEventRowsForStaff();
  const row = rows.find(r => r[0] === eventId);
  if (!row) return null;
  return {
    id: row[0], name: row[1], color: row[2] || '#0F9E7A',
    knowledge_base: row[3] || '', status: row[4] || 'active',
    images: row[7] || '', organizer: row[9] || '工研院',
    press_contact: row[14] || ''
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
  lines.push('\n完整分析請到後台「問答分析」頁。');
  return lines.join('\n');
}

// ── GEO 狀態：不重新實作 api/geo.js 的邏輯（那份還在另一批工作持續變動），
// 內部打它既有的 action=status，重用已經測過的邏輯，兩邊資料不會兜不起來。
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
export function formatGeoStatusReply(data) {
  if (!data) return 'GEO 狀態目前查詢不到，可能是這個功能還沒啟用，或內部查詢暫時失敗，請到後台 /geo 頁面直接看。';
  const lines = [`【GEO 掃描狀態】${data.date || ''}`];
  lines.push(`今日進度：${data.done ?? '—'} / ${data.total ?? '—'}（剩 ${data.remaining ?? '—'} 題）`);
  const engines = (data.engines || []).filter(e => e.enabled).map(e => e.label).join('、');
  lines.push(`啟用引擎：${engines || '（無）'}`);
  lines.push(`判官：${data.judge || '（未設定）'}`);
  if (data.ready) lines.push(`⚠️ ${data.ready}`);
  if (!data.cronSecretSet) lines.push('⚠️ CRON_SECRET 未設定，排程端點目前不夠安全');
  lines.push('\n完整趨勢圖表請到後台 /geo 頁面看。');
  return lines.join('\n');
}

// ── 職員意圖路由：跟 lib/router.js 的 routeIntent() 同一套手法，意圖集合擴充成
// 職員專用的七種，多一組 new_event_name／new_event_date 給 create_event 用。──
const VALID_STAFF_INTENTS = ['calendar', 'qa', 'geo_status', 'event_analytics', 'create_event', 'training_link', 'other'];

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
- "other"：其他、閒聊、意圖不明

以下是目前活動清單（id｜名稱｜日期｜狀態｜資料狀態，狀態含 draft／active／ended／archived，職員可以查全部）：
${list}

只回傳這個格式的 JSON：
{"intent":"calendar|qa|geo_status|event_analytics|create_event|training_link|other","event_ids":["qa/event_analytics/training_link 用，從清單挑 id，最多3個"],"new_event_name":"create_event 才有，新活動名稱","new_event_date":"create_event 才有，YYYY-MM-DD，訊息沒提到就留空字串","confidence":"high|low"}`;

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
