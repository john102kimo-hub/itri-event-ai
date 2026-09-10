// 用對話教米亞（批次 46）。
//
// 使用者的原話：「我能設定，進入職員模式後可以透過跟他對話來改進他的能力或內容嗎？
// 如：『米亞 不要回簡體字』『米亞 你剛剛回這些很怪，不要這樣回』」。
//
// 分成兩種，因為這兩種的性質差很多：
//
//   fact （補資料）  「這場的地點改成南港展覽館」
//                    → 綁在某一場，接在該場新聞稿後面當「同仁後續更正」，優先於原文
//   style（改語氣）  「回答再短一點」「不要用表情符號」
//                    → 全站通用，接在每一次模型呼叫的規則後面
//
// ⚠️ 一條刻意的界線：**style 不拿來解決「絕對不能發生」的事。**
// 「不要回簡體字」這種要求，正確的做法是在程式出口強制轉（見 api/line.js 的
// toTraditionalTW()），不是加一條 prompt 規則——prompt 是請求、不是保證，這個專案
// 已經在同一個形狀上踩過四次（Markdown、NO_DATA 標記、補查、簡體字）。
// style 適合的是「偶爾沒照做也不會出事」的偏好：長度、語氣、要不要用表情符號。
// 同仁真的打了「不要回簡體字」，我們照樣記起來（記著沒壞處），但真正的保證在程式裡。
//
// ⚠️ 為什麼要有「確認」這一步：自然語句跟一般提問長得很像（「這場的地點改成南港
// 展覽館了嗎？」是提問，「這場的地點改成南港展覽館」是指示）。判斷錯的代價是把
// 同仁的問題寫進知識庫、然後每個記者都讀得到——所以自然語句一律先問一次再存。
// 打明確指令（「記住：⋯⋯」）的人已經表達得很清楚，就不用多問一次。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';

export const MEMORY_RANGE = 'bot_memory!A2:F';
const HEADER = ['建立時間', '範圍', '類型', '內容', '建立者', '狀態'];

// 狀態：on＝生效中；pending＝等同仁確認；off＝已被「忘記」
export const ON = 'on', PENDING = 'pending', OFF = 'off';

// 內容長度上限。這段文字會進到每一次的 system prompt，沒有上限的話，同仁貼一整篇
// 新聞稿進來就會讓之後每一題都變慢變貴——長內容本來就該貼到後台的知識庫欄位。
export const MEMORY_MAX_LEN = 200;
// 生效中的筆數上限。同樣是保護 prompt 長度；超過就請同仁先忘記幾條。
export const MEMORY_MAX_ACTIVE = 40;

let ensured = false;
export async function ensureMemorySheet() {
  if (ensured) return;
  try {
    await ensureSheets({ bot_memory: HEADER });
  } catch (e) {
    console.error('ensureSheets(bot_memory) 失敗:', e.message);
  }
  ensured = true;
}

// rows → 物件陣列。row 帶著自己在表上的列號（rowNumber），「忘記」要靠它回寫。
export function parseMemoryRows(rows) {
  return (rows || []).map((r, i) => ({
    rowNumber: i + 2,               // A2 起算
    at: r[0] || '',
    scope: (r[1] || '').trim(),     // event_id，或 'global'
    type: (r[2] || '').trim(),      // 'fact' | 'style'
    text: (r[3] || '').trim(),
    by: (r[4] || '').trim(),
    status: (r[5] || '').trim() || ON
  })).filter(m => m.text);
}

// ⚠️ 一定要有快取：這張表現在**每一次模型呼叫**都會讀（語氣偏好要接進 prompt）。
// 直讀等於每一則提問都燒掉一次 Sheets 配額，而那個配額是每分鐘 60 次、整個網站
// （含記者會現場的問答、qa_log 寫入）共用的——跟 line_users 那張表同一個理由。
let cache = { rows: null, expiry: 0 };
const CACHE_TTL_MS = 60 * 1000;
export function invalidateMemoryCache() { cache = { rows: null, expiry: 0 }; }

export async function getMemories() {
  if (cache.rows && Date.now() < cache.expiry) return cache.rows;
  try {
    const rows = parseMemoryRows(await readRange(MEMORY_RANGE));
    cache = { rows, expiry: Date.now() + CACHE_TTL_MS };
    return rows;
  } catch (e) {
    console.error('讀取 bot_memory 失敗:', e.message);
    return []; // 讀不到就當作沒有記憶——問答照常運作，不能因為這張表掛了就整支不能用
  }
}

export async function addMemory({ scope = 'global', type = 'style', text, by = '', status = ON }) {
  await ensureMemorySheet();
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    await appendRows('bot_memory!A:F', [[timestamp, scope, type, String(text).slice(0, MEMORY_MAX_LEN), by, status]]);
  } finally {
    invalidateMemoryCache(); // 同仁剛教完，下一題就要用得到
  }
}

// 把某一列的狀態改掉（確認、忘記都走這支）。
export async function setMemoryStatus(rowNumber, status) {
  try {
    await updateRange(`bot_memory!F${rowNumber}`, [[status]]);
  } finally {
    invalidateMemoryCache();
  }
}

// ── 給 prompt 用的兩段文字 ─────────────────────────────────────────────

// 這一場的補充事實。⚠️ 措辭刻意寫成「以這裡為準」：同仁會用它更正新聞稿裡已經過時
// 的內容（改地點、改時間），如果只寫「補充資料」，模型看到兩個互相矛盾的說法時
// 不知道該信哪一個。
export function formatFactBlock(memories, eventId) {
  const list = (memories || []).filter(m =>
    m.status === ON && m.type === 'fact' && (m.scope === 'global' || m.scope === eventId));
  if (!list.length) return '';
  return `
【同仁後續補充／更正（以這裡為準）】
以下是公關同仁在新聞稿之後補充或更正的內容。跟上面的資料衝突時，**一律以這裡為準**。
${list.map(m => `・${m.text}`).join('\n')}`;
}

// 全站語氣偏好。回傳一行字串接在規則後面；沒有就回空字串。
export function formatStyleRules(memories) {
  const list = (memories || []).filter(m => m.status === ON && m.type === 'style');
  if (!list.length) return '';
  return `公關同仁交代的回答偏好（請遵守）：\n${list.map(m => `- ${m.text}`).join('\n')}`;
}

// ── 同仁下的指令 ───────────────────────────────────────────────────────

// 明確指令：打了這幾種開頭就是要教它，不用再問一次。
// ⚠️ 用字面比對，不交給模型判——跟 isExitStaffCommand() 同一個理由：會不會把同仁的
// 話寫進知識庫，不該取決於模型當下判得準不準。
const CMD_FACT_EVENT = /^(記住|記下|補充)\s*[:：]?\s*/;
const CMD_FACT_GLOBAL = /^(全站記住|全域記住|所有場次記住)\s*[:：]?\s*/;
const CMD_STYLE = /^(語氣|口氣|以後回答|回答時|說話)\s*[:：]\s*/;
const CMD_LIST = /^(記憶清單|看記憶|記得什麼|記憶列表)[?？。]?$/;
const CMD_FORGET = /^忘記\s*(\d{1,3})$/;

// 自然語句：看起來是在交代「以後要怎麼做」，但沒有用明確指令。這種一律先問一次。
// ⚠️ 條件寫得嚴一點（要有明確的指示詞開頭，而且不能是問句）：判斷錯的代價是把同仁
// 的提問寫進知識庫、每個記者都讀得到。寧可漏判（同仁改用「記住：」再講一次），
// 也不要誤判。
const NATURAL_STYLE = /^(不要|別再|以後|下次|之後|請改|改成|記得)\s*\S/;

export function parseMemoryCommand(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  if (CMD_LIST.test(s)) return { kind: 'list' };
  const forget = s.match(CMD_FORGET);
  if (forget) return { kind: 'forget', index: Number(forget[1]) };

  // ⚠️ 全站的規則要先比對：「全站記住」也含有「記住」兩個字，順序反過來會被
  // CMD_FACT_EVENT 先吃掉，變成只記在當前這一場。
  if (CMD_FACT_GLOBAL.test(s)) {
    const body = s.replace(CMD_FACT_GLOBAL, '').trim();
    return body ? { kind: 'save', type: 'fact', scope: 'global', text: body, confirm: false } : null;
  }
  if (CMD_STYLE.test(s)) {
    const body = s.replace(CMD_STYLE, '').trim();
    return body ? { kind: 'save', type: 'style', scope: 'global', text: body, confirm: false } : null;
  }
  if (CMD_FACT_EVENT.test(s)) {
    const body = s.replace(CMD_FACT_EVENT, '').trim();
    return body ? { kind: 'save', type: 'fact', scope: 'event', text: body, confirm: false } : null;
  }

  // 問句不算指示（「以後會開放報名嗎？」是在問，不是在交代）
  if (/[?？]$/.test(s)) return null;
  if (NATURAL_STYLE.test(s) && s.length <= MEMORY_MAX_LEN) {
    return { kind: 'save', type: 'style', scope: 'global', text: s, confirm: true };
  }
  return null;
}

// 記憶清單的文字。編號就是「忘記 N」要打的那個 N，所以編號必須跟著這份清單走、
// 不能用表上的列號（同仁看不到列號）。
export function formatMemoryList(memories) {
  const list = (memories || []).filter(m => m.status === ON);
  if (!list.length) return '目前沒有記住任何東西。\n\n可以這樣教我：\n・「記住：這場地點改到南港展覽館」（只記這一場）\n・「語氣：回答再短一點」（全站通用）';
  const lines = list.map((m, i) => {
    const tag = m.type === 'fact' ? (m.scope === 'global' ? '全站資料' : '本場資料') : '語氣';
    return `${i + 1}. 〔${tag}〕${m.text}`;
  });
  return `我目前記住這些：\n${lines.join('\n')}\n\n要我忘記哪一條，打「忘記 ${list.length}」這樣就可以。`;
}
