// 活動報名（批次 88 起；批次 112 由「媒體報名」改名）——資料層與規則。
//
// 改名原因：這套東西不只能收記者報名，之後的說明會、參訪、工作坊都用得上，名字不該綁死「媒體」。
// 只改畫面與 LINE 上的字；網址（/register、/registrations）、試算表分頁（reg_campaigns／registrations）
// 與程式內的名稱都不動——邀請函上已經發出去的連結不能失效。
// 場次「單位／媒體」欄位仍叫 outlet、記者名單比對仍在（沒匯入名單就自動隱藏），媒體場照舊能用。
//
// 背景：眺望系列研討會是多天多場（去年 9 天 17 場、今年 8 天 16 場），媒體邀請函要讓記者勾選
// 要採訪哪幾場。去年用 Google 表單：資料在後台之外、同一個人重複報名要人工合併、接不上 LINE
// 提醒與報到系統。這支把報名收進自己的試算表（兩個分頁 reg_campaigns／registrations），
// 網頁（public/register.html）、後台（public/registrations.html）、米亞（api/line.js）都走這裡。
//
// 設計上的取捨（每一條都是踩過或預想過的坑）：
//
// 1. **報名不綁 LINE。** 記者從邀請函點連結就能報，加不加米亞是報完之後才問的選用項目。
//    要先加好友才能報名，等於在報名前多一道關，也是「一頭霧水」的來源。
// 2. **寫入一律走程式，不經 AI。** 報名資料漏一筆就是漏一位記者（CLAUDE.md 第 2 條）。
// 3. **一個人一筆。** 以 Email 為鍵：同一個 Email 再送一次＝更新那一筆（沒帶編輯碼時場次取聯集，
//    不會因為換手機再報一次就把先前的場次弄丟；帶了編輯碼才是「照這次勾的為準」）。
// 4. **公開端點不回傳別人的個資。** 沒有編輯碼的重複送出只回「已更新」，不回舊資料。
// 5. **草稿活動可以先測。** status=draft 的報名活動只有拿到連結的人開得到，送出的報名自動標成
//    測試（source 尾巴 :test），不算進統計與匯出，後台一鍵清掉。
// 6. 米亞歡迎詞寫「不會蒐集您的個人資料」——那句是指問答，不是報名。報名頁預設**不放**個資告知
//    （朱朱 9/29 決定）；後台「個資告知」欄有填才會顯示，之後想放隨時貼。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { lineBasicId, lineAddFriendUrl } from './line-link.js';

// ── 試算表分頁 ────────────────────────────────────────────────────────
export const CAMPAIGN_HEADERS = ['id', 'title', 'status', 'intro', 'sessions', 'options', 'privacy', 'contact',
  'closes_at', 'line_pitch', 'created_at', 'updated_at', 'short_name', 'venue'];
export const REG_HEADERS = ['reg_id', 'campaign_id', 'created_at', 'updated_at', 'name', 'outlet', 'email', 'phone',
  'sessions', 'options', 'line_user_id', 'edit_token', 'status', 'source', 'note', 'bound_at'];
const CAMPAIGN_RANGE = 'reg_campaigns!A2:N';
const REG_RANGE = 'registrations!A2:P';
const SHEET_SPEC = { reg_campaigns: CAMPAIGN_HEADERS, registrations: REG_HEADERS };

export const CAMPAIGN_STATUSES = ['draft', 'open', 'closed'];
export const REG_STATUSES = ['active', 'cancelled', 'deleted'];
const SESSION_STATUS_MAP = {
  '開放': 'open', open: 'open', '': 'open',
  '截止': 'closed', closed: 'closed',
  '額滿': 'full', full: 'full',
  '取消': 'cancelled', cancelled: 'cancelled', canceled: 'cancelled'
};
const SESSION_STATUS_LABEL = { open: '開放', closed: '截止', full: '額滿', cancelled: '取消' };

const LIMITS = { name: 40, outlet: 60, email: 100, phone: 20, note: 300, title: 80, intro: 2000, sessions: 12000,
  options: 2000, privacy: 2000, contact: 600, pitch: 800, code: 8, venue: 60 };

export const DEFAULT_LINE_PITCH = [
  '議程、交通、報到時間，隨時問米亞',
  '活動當天的新聞稿與照片，直接跟米亞拿',
  '隨時查詢或修改您的報名'
].join('\n');

// ── 小工具 ────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const SPLIT_RE = /[|｜]/;

/** 台灣時間的 ISO 字串（台灣沒有夏令時間，固定 +08:00）。試算表裡看得懂、也排得出先後。 */
export function nowIso(ms = Date.now()) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
}
export function taipeiYear(ms = Date.now()) {
  return new Date(ms + 8 * 3600e3).getUTCFullYear();
}

/** 去掉控制字元、收斂空白、限長。表單欄位一律先過這支再存。 */
export function cleanText(s, max) {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ') // 換行、tab 一律當空白：姓名／媒體欄位不該有多行
    .replace(/ {2,}/g, ' ')
    .trim();
  return max ? t.slice(0, max) : t;
}
const cleanMultiline = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

export function normalizeEmail(s) { return cleanText(s, LIMITS.email).toLowerCase(); }
export function isValidEmail(s) { return /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+\.[^\s@,;:<>()[\]\\"]{2,}$/.test(String(s || '')); }

/** 手機：拿掉空白、破折號、括號；+886 開頭轉成 0 開頭。回傳純數字（外國號碼保留 +）；不合格回空字串。 */
export function normalizePhone(s) {
  let t = String(s ?? '').replace(/[\s\-().－（）]/g, '');
  if (!t) return '';
  if (/^\+?886/.test(t)) t = '0' + t.replace(/^\+?886/, '').replace(/^0+/, '');
  if (/^\+[1-9]\d{7,14}$/.test(t)) return t;
  if (/^0\d{8,10}$/.test(t)) return t;
  return '';
}
/** 給人看與匯出用：0912345678 → 0912-345-678（也避免 Excel 開 CSV 時吃掉開頭的 0）。 */
export function formatPhone(p) {
  const s = String(p || '');
  return /^09\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7)}` : s;
}

const nameKey = (s) => String(s || '').toLowerCase().replace(/[\s　·・.,，、()（）\-_]/g, '');

// ── 場次文字解析 ──────────────────────────────────────────────────────
// 後台用一個文字框整批貼（跟 events 的 contacts／chips 同一種做法，同仁常常是整批調整）。
// 每行：代碼｜日期｜時間｜名稱｜場地｜備註｜狀態｜詳細資料網址（後四項選填）
//   A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表｜201 廳
//   B1｜10/29(四)｜09:30-12:00｜全球AI競局｜｜｜額滿｜https://…
export function parseDateLoose(s, defaultYear) {
  const str = String(s || '').trim();
  let y, mo, d;
  let m = str.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = str.match(/(\d{1,2})\s*[/月.-]\s*(\d{1,2})/);
    if (!m) return null;
    y = defaultYear || taipeiYear(); mo = +m[1]; d = +m[2];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null; // 2/30 這類不存在的日子
  return { iso: `${y}-${pad(mo)}-${pad(d)}`, weekday: WEEKDAYS[dt.getUTCDay()], md: `${mo}/${d}` };
}

export function parseTimeRange(s) {
  const m = String(s || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[-~～–—至到]\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/);
  if (!m) return null;
  const h1 = +m[1], m1 = +m[2];
  if (h1 > 23 || m1 > 59) return null;
  const start = `${pad(h1)}:${pad(m1)}`;
  if (m[3] === undefined) return { start, end: '', label: start };
  const h2 = +m[3], m2 = +m[4];
  if (h2 > 23 || m2 > 59) return null;
  const end = `${pad(h2)}:${pad(m2)}`;
  return { start, end, label: `${start}-${end}` };
}

export function parseSessions(text, defaultYear) {
  const sessions = [];
  const errors = [];
  const seen = new Set();
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const f = line.split(SPLIT_RE).map((x) => x.trim());
    const at = `第 ${i + 1} 行`;
    const code = (f[0] || '').toUpperCase();
    if (!/^[A-Z0-9_-]{1,8}$/.test(code)) { errors.push(`${at}：場次代碼要是 1～8 個英數字（例如 A1）`); return; }
    if (seen.has(code)) { errors.push(`${at}：場次代碼 ${code} 重複了`); return; }
    const date = parseDateLoose(f[1], defaultYear);
    if (!date) { errors.push(`${at}（${code}）：看不懂日期「${f[1] || ''}」，請寫成 2026-10-28 或 10/28`); return; }
    const time = parseTimeRange(f[2]);
    if (!time) { errors.push(`${at}（${code}）：看不懂時間「${f[2] || ''}」，請寫成 09:30-12:00`); return; }
    const title = cleanText(f[3], LIMITS.title);
    if (!title) { errors.push(`${at}（${code}）：缺場次名稱`); return; }
    const statusKey = SESSION_STATUS_MAP[(f[6] || '').toLowerCase()] ?? SESSION_STATUS_MAP[f[6] || ''];
    if (statusKey === undefined) { errors.push(`${at}（${code}）：狀態「${f[6]}」不認得，請寫 開放／截止／額滿／取消，或留空`); return; }
    const url = (f[7] || '').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) { errors.push(`${at}（${code}）：詳細資料網址要以 http:// 或 https:// 開頭`); return; }
    seen.add(code);
    sessions.push({
      code, date: date.iso, weekday: date.weekday, md: date.md, dateLabel: `${date.md}（${date.weekday}）`,
      start: time.start, end: time.end, time: time.label,
      title, room: cleanText(f[4], 40), note: cleanText(f[5], 120), status: statusKey, url
    });
  });
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.code.localeCompare(b.code));
  return { sessions, errors };
}

/** 存檔時把場次改寫成一律帶完整年份的標準格式——之後不管哪一年讀，日期都不會漂。 */
export function sessionsToText(sessions) {
  return sessions.map((s) => [s.code, s.date, s.time, s.title, s.room, s.note,
    s.status === 'open' ? '' : SESSION_STATUS_LABEL[s.status], s.url].join('｜').replace(/｜+$/, '')).join('\n');
}

// 選填項目：每行「代碼｜顯示文字｜限定場次（逗號分隔，可空）｜類型（check／number，預設 check）」
//   interview｜參加 09:15 媒體聯訪｜A1
//   party｜同行人數（含攝影，不含本人）｜｜number
export function parseOptions(text, sessionCodes) {
  const options = [];
  const errors = [];
  const seen = new Set();
  const codes = sessionCodes ? new Set(sessionCodes) : null;
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const f = line.split(SPLIT_RE).map((x) => x.trim());
    const at = `選填項目第 ${i + 1} 行`;
    const key = (f[0] || '').toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(key)) { errors.push(`${at}：代碼要是英文小寫開頭、最多 16 字（例如 meal）`); return; }
    if (seen.has(key)) { errors.push(`${at}：代碼 ${key} 重複了`); return; }
    const label = cleanText(f[1], 60);
    if (!label) { errors.push(`${at}（${key}）：缺顯示文字`); return; }
    const only = (f[2] || '').split(/[,，、\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (codes) {
      const bad = only.filter((c) => !codes.has(c));
      if (bad.length) { errors.push(`${at}（${key}）：限定場次 ${bad.join('、')} 不在場次清單裡`); return; }
    }
    const type = (f[3] || 'check').toLowerCase();
    if (type !== 'check' && type !== 'number') { errors.push(`${at}（${key}）：類型只能是 check 或 number`); return; }
    seen.add(key);
    options.push({ key, label, sessions: only, type });
  });
  return { options, errors };
}
export function optionsToText(options) {
  return options.map((o) => [o.key, o.label, o.sessions.join(','), o.type === 'number' ? 'number' : ''].join('｜').replace(/｜+$/, '')).join('\n');
}

/** 台灣時間 'YYYY-MM-DD'、'YYYY-MM-DD HH:mm' → epoch ms；只有日期就算當天 23:59:59。看不懂回 NaN。 */
export function parseTaipeiTime(s) {
  const m = String(s || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m;
  const hasTime = h !== undefined;
  return Date.UTC(+y, +mo - 1, +d, hasTime ? +h : 23, hasTime ? +mi : 59, hasTime ? 0 : 59) - 8 * 3600e3;
}

/** 場次結束的時間點（台灣時間 epoch ms）：有結束時間用結束時間，只有開始時間就用開始時間。 */
export function sessionEndMs(s) {
  const t = s.end || s.start;
  return parseTaipeiTime(t ? `${s.date} ${t}` : s.date);
}
/** 這一場已經辦完了嗎（辦完的場次不能再報名，也從報名頁自動消失）。 */
export function isSessionEnded(s, now = Date.now()) {
  const e = sessionEndMs(s);
  return !Number.isNaN(e) && now > e;
}
/** 最後一場（不含取消的）的結束時間；沒有場次回 NaN。 */
export function lastSessionEnd(c) {
  const ends = (c.sessions || []).filter((s) => s.status !== 'cancelled').map(sessionEndMs).filter((n) => !Number.isNaN(n));
  return ends.length ? Math.max(...ends) : NaN;
}

// ── 列 ↔ 物件 ─────────────────────────────────────────────────────────
export function campaignFromRow(r) {
  const row = r || [];
  const closesAt = cleanText(row[8], 40);
  const year = Number.isNaN(parseTaipeiTime(closesAt)) ? taipeiYear() : new Date(parseTaipeiTime(closesAt) + 8 * 3600e3).getUTCFullYear();
  const { sessions } = parseSessions(row[4], year);
  const { options } = parseOptions(row[5], sessions.map((s) => s.code));
  return {
    id: String(row[0] || ''), title: String(row[1] || ''),
    status: CAMPAIGN_STATUSES.includes(row[2]) ? row[2] : 'closed',
    intro: String(row[3] || ''), sessions, options,
    sessions_text: String(row[4] || ''), options_text: String(row[5] || ''),
    privacy: String(row[6] || ''), contact: String(row[7] || ''),
    closes_at: closesAt, line_pitch: String(row[9] || ''),
    created_at: String(row[10] || ''), updated_at: String(row[11] || ''),
    short_name: cleanText(row[12], 16), venue: cleanText(row[13], LIMITS.venue)
  };
}
export function campaignToRow(c) {
  return [c.id, c.title, c.status, c.intro || '', c.sessions_text || '', c.options_text || '', c.privacy || '',
    c.contact || '', c.closes_at || '', c.line_pitch || '', c.created_at || '', c.updated_at || '', c.short_name || '', c.venue || ''];
}

export function parseOptionValues(s) {
  const out = {};
  String(s || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}
export function optionValuesToText(o) {
  return Object.entries(o || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${v}`).join(';');
}

export function regFromRow(r, idx) {
  const row = r || [];
  return {
    _row: idx + 2,
    reg_id: String(row[0] || ''), campaign_id: String(row[1] || ''),
    created_at: String(row[2] || ''), updated_at: String(row[3] || ''),
    name: String(row[4] || ''), outlet: String(row[5] || ''),
    email: String(row[6] || ''), phone: String(row[7] || ''),
    sessions: String(row[8] || '').split(',').map((x) => x.trim()).filter(Boolean),
    options: parseOptionValues(row[9]),
    line_user_id: String(row[10] || ''), edit_token: String(row[11] || ''),
    status: REG_STATUSES.includes(row[12]) ? row[12] : 'active',
    source: String(row[13] || ''), note: String(row[14] || ''), bound_at: String(row[15] || '')
  };
}
export function regToRow(g) {
  return [g.reg_id, g.campaign_id, g.created_at, g.updated_at, g.name, g.outlet, g.email, g.phone,
    (g.sessions || []).join(','), optionValuesToText(g.options), g.line_user_id || '', g.edit_token || '',
    g.status || 'active', g.source || '', g.note || '', g.bound_at || ''];
}
export const isTestReg = (g) => /:test$/.test(g.source || '');

// ── 代碼／權杖 ────────────────────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 I L O 0 1，口頭報、手打都不會混
export function makeRegId() {
  const b = randomBytes(5);
  let s = 'R';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}
export function makeToken() { return randomBytes(16).toString('base64url'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// 米亞聊天室裡的「填寫報名表」連結帶一個簽章過的身分：記者從 LINE 點進去填，送出時我們就知道
// 是哪個 LINE 帳號，不必再請他綁一次。用 LINE_CHANNEL_SECRET 衍生一把專用的鑰匙（不直接拿
// 原始密鑰簽），沒設 LINE_CHANNEL_SECRET 時整個功能安靜停用（簽不出來、驗不過）。
// 只放 userId 與到期時間，不放任何個資；7 天到期。
const LINE_TOKEN_TTL_MS = 7 * 24 * 3600e3;
function lineTokenKey() {
  const secret = process.env.LINE_CHANNEL_SECRET || '';
  return secret ? createHmac('sha256', secret).update('itri-reg-line-link-v1').digest() : null;
}
export function signLineToken(userId, now = Date.now()) {
  const key = lineTokenKey();
  if (!key || !userId) return '';
  const payload = Buffer.from(`${userId}|${Math.floor((now + LINE_TOKEN_TTL_MS) / 1000)}`).toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
export function verifyLineToken(token, now = Date.now()) {
  const key = lineTokenKey();
  if (!key || typeof token !== 'string' || token.length > 400) return '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return '';
  const want = createHmac('sha256', key).update(payload).digest('base64url');
  if (!safeEqual(sig, want)) return '';
  const [userId, exp] = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  if (!/^U\w{8,}$/.test(userId || '')) return '';
  if (!(Number(exp) * 1000 > now)) return '';
  return userId;
}

// ── 網址 ──────────────────────────────────────────────────────────────
export function siteBase() {
  return String(process.env.SITE_URL || 'https://itri-event-ai.vercel.app').replace(/\/+$/, '');
}
export function registerUrl(campaignId, { lineToken = '', editToken = '' } = {}) {
  const q = [`c=${encodeURIComponent(campaignId)}`];
  if (lineToken) q.push(`u=${encodeURIComponent(lineToken)}`);
  if (editToken) q.push(`t=${encodeURIComponent(editToken)}`);
  return `${siteBase()}/register?${q.join('&')}`;
}

// 綁定檢查碼（批次 116）。報名編號只有 5 碼，而且大大印在報名完成頁上——以前光憑編號傳一句
// 「#報名 R7K3M」就能把**別人還沒連結的那筆**綁到自己的 LINE，米亞會回出對方的姓名與單位，
// 接著「我要報名」卡片還會給出含編輯碼的修改連結，讀得到 Email 與手機（批次 89 補的是 Email 那條路，
// 這條沒補到）。完成頁的截圖一外流、或有人一個一個猜，就是這樣。
// 現在按鈕送出的是「#報名 R7K3M-K8PQ2X」：後半段從那一筆的編輯碼算出來，畫面上不顯示，猜不到。
// 不另開欄位、不靠環境變數——編輯碼本來就是每一筆自己的 128 位元祕密。
export function regBindCheck(editToken) {
  if (!editToken) return '';
  const b = createHash('sha256').update(`reg-bind:${editToken}`).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}

/** 報名完成頁上「用 LINE 連結我的報名」按鈕：打開米亞聊天室、輸入框已帶好「#報名 R7K3M-檢查碼」，按送出就綁定。 */
export function lineBindRegUrl(regId, editToken = '') {
  const id = lineBasicId();
  if (!id || !regId) return '';
  const check = regBindCheck(editToken);
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`#報名 ${regId}${check ? '-' + check : ''}`)}`;
}
const REG_BIND_RE = /^[#＃]\s*報名\s*[:：]?\s*([A-Za-z0-9]{4,10})(?:\s*[-－]\s*([A-Za-z0-9]{4,10}))?\s*$/;
/** 米亞收到的「#報名 R7K3M」（或帶檢查碼的「#報名 R7K3M-K8PQ2X」）→ 'R7K3M'，不是這種格式回空字串。必須排在一般「#活動代碼」之前判斷。 */
export function parseRegBindText(text) {
  const m = String(text || '').trim().match(REG_BIND_RE);
  return m ? m[1].toUpperCase() : '';
}
/** 同上那一句後半段的檢查碼；舊版完成頁的按鈕沒有這段，回空字串。 */
export function parseRegBindCheck(text) {
  const m = String(text || '').trim().match(REG_BIND_RE);
  return m && m[2] ? m[2].toUpperCase() : '';
}

// ── 試算表存取 ────────────────────────────────────────────────────────
let ensuredAt = 0;
async function ensureRegSheets() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60_000) throw new Error('報名資料表暫時無法建立，請稍後再試');
  try { await ensureSheets(SHEET_SPEC); }
  catch (e) { ensuredAt = Date.now(); throw e; }
  ensuredAt = Infinity;
  await patchCampaignHeader();
}
/**
 * ensureSheets 只會建「不存在」的分頁，不會補欄位：舊的 reg_campaigns 表頭比現在少欄位時補上。
 * 純屬方便人打開試算表看得懂——資料格本來就讀得到（沒填的欄位讀回來是空的），所以失敗只記 log、
 * 不能讓報名頁跟著不能用（公開讀取的路徑也會走到這裡）。
 */
async function patchCampaignHeader() {
  try {
    const head = (await readRange('reg_campaigns!A1:N1'))[0] || [];
    if (head.length < CAMPAIGN_HEADERS.length) await updateRange('reg_campaigns!A1:N1', [CAMPAIGN_HEADERS]);
  } catch (e) { console.error('補報名活動表頭失敗（不影響報名）:', e.message); }
}

const CAMPAIGN_TTL_MS = 20_000;
let campaignCache = { rows: null, expiry: 0 };
export function invalidateCampaignCache() { campaignCache = { rows: null, expiry: 0 }; }
/** 測試用：清掉快取與「分頁已確認」旗標（測試會把整本假試算表清空重來）。 */
export function resetRegistrationState() { campaignCache = { rows: null, expiry: 0 }; ensuredAt = 0; }

/** 全部報名活動（含草稿與已截止）。20 秒快取——記者開網頁的尖峰不會把 Sheets 讀取配額打光。 */
export async function loadCampaigns({ fresh = false } = {}) {
  if (!fresh && campaignCache.rows && Date.now() < campaignCache.expiry) return campaignCache.rows;
  await ensureRegSheets();
  const rows = (await readRange(CAMPAIGN_RANGE)).filter((r) => r[0]).map(campaignFromRow);
  campaignCache = { rows, expiry: Date.now() + CAMPAIGN_TTL_MS };
  return rows;
}
export async function getCampaign(id, opts) {
  const key = String(id || '').trim();
  return (await loadCampaigns(opts)).find((c) => c.id === key) || null;
}

/**
 * 這個活動現在收不收報名：狀態要是 open（或 draft 測試），沒過截止時間，而且還有場次沒辦完。
 * 「全部場次都辦完了就自動關」是朱朱要的「活動結束後，報名自己消失」：沒設截止時間、也忘了手動改成
 * 「已截止」的活動，最後一場結束後就不再收報名，米亞的卡片、歡迎卡按鈕、報名頁都會跟著收掉。
 */
export function campaignAcceptsSubmissions(c, now = Date.now()) {
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status === 'closed') return { ok: false, reason: 'closed' };
  const t = parseTaipeiTime(c.closes_at);
  if (!Number.isNaN(t) && now > t) return { ok: false, reason: 'closed' };
  const last = lastSessionEnd(c);
  if (!Number.isNaN(last) && now > last) return { ok: false, reason: 'ended' };
  return { ok: true };
}
/** 對外（LINE 卡片、預設報名頁）列出的活動：只有 open 而且沒過截止時間；草稿不公開列出。 */
export async function listOpenCampaigns(now = Date.now()) {
  try {
    return (await loadCampaigns()).filter((c) => c.status === 'open' && campaignAcceptsSubmissions(c, now).ok);
  } catch (e) {
    console.error('讀取報名活動失敗（當作沒有）:', e.message);
    return [];
  }
}

/**
 * 跟 listOpenCampaigns() 一樣，但**讀不到就丟例外**，不當作「沒有」。排程（Vercel Cron）要用這支：
 * 試算表暫時讀不到的時候，不能被誤判成「報名結束了」而把圖文選單換掉。
 */
export async function listOpenCampaignsStrict(now = Date.now()) {
  return (await loadCampaigns({ fresh: true })).filter((c) => c.status === 'open' && campaignAcceptsSubmissions(c, now).ok);
}

/**
 * 米亞的「我要報名」該不該攔（api/line.js resolveMetaIntent()）：
 *  - open   ：現在收報名的活動 → 給報名卡片
 *  - closed ：剛截止不久（最後一場之後 7 天內）的活動 → 回「已截止，請洽活動聯絡人」
 * 兩個都空＝這個帳號目前沒有報名可講，「報名」「怎麼報名」照原本的路徑處理（問答／兜底），
 * **上線後只要沒開任何報名活動，米亞的行為跟以前完全一樣**。草稿不算；活動辦完一週後也不再攔，
 * 不會因為一個早就結束的活動永遠回「已截止」。
 */
export async function listRegistrationTopics(now = Date.now()) {
  try {
    const all = await loadCampaigns();
    const open = all.filter((c) => c.status === 'open' && campaignAcceptsSubmissions(c, now).ok);
    const closed = all.filter((c) => {
      if (c.status === 'draft' || campaignAcceptsSubmissions(c, now).ok) return false;
      const last = lastSessionEnd(c);
      return Number.isNaN(last) ? false : now <= last + 7 * 24 * 3600e3;
    });
    return { open, closed };
  } catch (e) {
    console.error('讀取報名活動失敗（當作沒有）:', e.message);
    return { open: [], closed: [] };
  }
}

async function loadRegs() {
  await ensureRegSheets();
  return (await readRange(REG_RANGE)).map(regFromRow).filter((g) => g.reg_id);
}

// ── 驗證 ──────────────────────────────────────────────────────────────
/**
 * 檢查一份報名並整理成要存的樣子。prevSessions 是這個人先前已報的場次（更新時用）：
 *  - replace（帶了編輯碼）：以這次勾的為準，但已經截止的場次若原本就有勾，不能被動拿掉又補不回來
 *  - merge（沒帶編輯碼）：聯集，先前的都留著
 */
export function validateSubmission(campaign, body, { prevSessions = [], mode = 'create', now = Date.now() } = {}) {
  const errors = [];
  const name = cleanText(body.name, LIMITS.name);
  const outlet = cleanText(body.outlet, LIMITS.outlet);
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  if (!name) errors.push({ field: 'name', message: '請填寫姓名' });
  else if (name.length < 2) errors.push({ field: 'name', message: '姓名至少 2 個字' });
  if (!outlet) errors.push({ field: 'outlet', message: '請填寫服務單位或媒體名稱' });
  if (!email) errors.push({ field: 'email', message: '請填寫 Email' });
  else if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Email 格式好像不對，請再確認' });
  if (!String(body.phone ?? '').trim()) errors.push({ field: 'phone', message: '請填寫手機號碼' });
  else if (!phone) errors.push({ field: 'phone', message: '手機號碼格式好像不對（例如 0912-345-678）' });

  const byCode = new Map(campaign.sessions.map((s) => [s.code, s]));
  const asked = [...new Set((Array.isArray(body.sessions) ? body.sessions : []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, 60);
  const unknown = asked.filter((c) => !byCode.has(c));
  if (unknown.length) errors.push({ field: 'sessions', message: `找不到場次 ${unknown.join('、')}，請重新整理頁面再試` });
  const ended = (c) => isSessionEnded(byCode.get(c), now);
  const isOpen = (c) => byCode.get(c)?.status === 'open' && !ended(c);
  // 辦完的場次不能再報；還沒辦完但被關掉（截止／額滿）的，新報名不收、原本就報了的留著
  const endedNew = asked.filter((c) => byCode.has(c) && ended(c) && !prevSessions.includes(c));
  const stoppedNew = asked.filter((c) => byCode.has(c) && !ended(c) && !isOpen(c) && !prevSessions.includes(c));
  if (endedNew.length) errors.push({ field: 'sessions', message: `場次 ${endedNew.join('、')} 已經結束，無法報名` });
  if (stoppedNew.length) errors.push({ field: 'sessions', message: `場次 ${stoppedNew.join('、')} 已停止報名，請洽活動聯絡人` });
  // 原本報了、後來辦完的場次是紀錄，留在裡面：之後改別的欄位或別的場次，不會把它拿掉
  const keepEnded = prevSessions.filter((c) => byCode.has(c) && ended(c));
  let sessions;
  if (mode === 'replace') sessions = [...new Set([...asked.filter((c) => byCode.has(c) && (isOpen(c) || prevSessions.includes(c))), ...keepEnded])];
  else sessions = [...new Set([...prevSessions.filter((c) => byCode.has(c)), ...asked.filter((c) => byCode.has(c) && isOpen(c))])];
  if (!sessions.length && !unknown.length && !endedNew.length && !stoppedNew.length) errors.push({ field: 'sessions', message: '請至少勾選一個場次' });
  sessions.sort((a, b) => {
    const x = byCode.get(a), y = byCode.get(b);
    return x.date.localeCompare(y.date) || x.start.localeCompare(y.start) || a.localeCompare(b);
  });

  // 選填項目：只收活動有定義的、而且（若限定場次）那場真的有勾；其餘靜靜丟掉
  const options = {};
  const given = body.options && typeof body.options === 'object' ? body.options : {};
  for (const o of campaign.options) {
    if (o.sessions.length && !o.sessions.some((c) => sessions.includes(c))) continue;
    const v = given[o.key];
    if (o.type === 'number') {
      const n = Math.max(0, Math.min(9, parseInt(v, 10) || 0));
      if (n > 0) options[o.key] = String(n);
    } else if (v === true || v === '1' || v === 1 || v === 'true') options[o.key] = '1';
  }
  return { errors, clean: { name, outlet, email, phone, sessions, options } };
}

// ── 公開：送出報名 ────────────────────────────────────────────────────
/**
 * 新增或更新一筆報名。回傳 { ok, mode, reg, token?, line, sessions } 或 { ok:false, status, error, errors? }。
 * body：{ c, name, outlet, email, phone, sessions[], options{}, t?（編輯碼）, lu?（LINE 身分簽章） }
 */
export async function submitRegistration(body, { now = Date.now() } = {}) {
  const campaign = await getCampaign(body.c);
  if (!campaign) return { ok: false, status: 404, error: '找不到這個報名活動，請確認連結是否正確' };
  const accepts = campaignAcceptsSubmissions(campaign, now);
  if (!accepts.ok) return { ok: false, status: 409, error: '這個活動已停止報名，如需協助請洽活動聯絡人', closed: true };

  const regs = await loadRegs();
  // 同一個活動同一個 Email 可能有兩列（雙擊送出）：一律拿最新的那一列，跟後台 dedupeRegs() 同一個口徑
  const newest = (a, b) => (String(b.updated_at) > String(a.updated_at) || (String(b.updated_at) === String(a.updated_at) && b._row > a._row) ? b : a);
  const mine = regs.filter((g) => g.campaign_id === campaign.id && g.status !== 'deleted');
  const token = typeof body.t === 'string' ? body.t.trim() : '';
  const byToken = token ? mine.find((g) => safeEqual(g.edit_token, token)) : null;
  const emailNow = normalizeEmail(body.email);
  const emailMatches = mine.filter((g) => g.email === emailNow && g !== byToken);
  const byEmail = emailMatches.length ? emailMatches.reduce(newest) : null;
  const askedSet = new Set((Array.isArray(body.sessions) ? body.sessions : []).map((x) => String(x).trim().toUpperCase()));
  const target = byToken || byEmail || null;
  const mode = byToken ? 'replace' : 'merge';

  // 用編輯碼把 Email 改成另一個已經有人報的 Email：不能悄悄併過去
  if (byToken && byEmail) {
    return { ok: false, status: 409, error: '這個 Email 已經有另一筆報名了，請直接用該 Email 重新送出，或洽活動聯絡人', errors: [{ field: 'email', message: '這個 Email 已有另一筆報名' }] };
  }

  // 取消過的報名再送出＝重新報名：舊的場次與選填項目不帶過來（不然會把他取消掉的又復活）
  const fresh = !target || target.status !== 'active';
  const v = validateSubmission(campaign, body, { prevSessions: fresh ? [] : target.sessions, mode: fresh ? 'replace' : mode, now });
  if (v.errors.length) return { ok: false, status: 400, error: v.errors[0].message, errors: v.errors };
  const c = v.clean;

  const testSuffix = campaign.status === 'draft' ? ':test' : '';
  const stamp = nowIso(now);
  let reg;
  let created = false;
  // 「證明過身分」＝這一筆是這次才建立的，或帶了對的編輯碼。只靠 Email 對上既有報名的，任何知道那個
  // Email 的人都做得到，所以只能「加場次」，不能改聯絡資料、不能綁 LINE、也拿不到那筆的任何內容
  // （批次 89 補：之前這裡會直接覆寫姓名／媒體／手機，還能把自己的 LINE 綁上去、換到編輯碼讀走個資）。
  const proven = !target || !!byToken;
  if (target) {
    reg = { ...target, updated_at: stamp,
      name: proven ? c.name : target.name, outlet: proven ? c.outlet : target.outlet,
      email: c.email, phone: proven ? c.phone : target.phone,
      sessions: c.sessions, options: (fresh || mode === 'replace') ? c.options : { ...target.options, ...c.options },
      status: 'active' };
    // 沒帶編輯碼的「合併」不動舊的選填項目——沒勾不代表要取消
  } else {
    created = true;
    let regId = makeRegId();
    for (let i = 0; i < 5 && regs.some((g) => g.reg_id === regId); i++) regId = makeRegId();
    reg = { reg_id: regId, campaign_id: campaign.id, created_at: stamp, updated_at: stamp,
      name: c.name, outlet: c.outlet, email: c.email, phone: c.phone, sessions: c.sessions, options: c.options,
      line_user_id: '', edit_token: makeToken(), status: 'active',
      source: `web${testSuffix}`, note: '', bound_at: '' };
  }

  // 從米亞點進來填的：簽章驗過就直接連結 LINE，不必再請他按一次
  const lineUserId = verifyLineToken(body.lu, now);
  let lineBound = proven ? !!reg.line_user_id : (!!lineUserId && reg.line_user_id === lineUserId);
  let lineConflict = false;
  if (lineUserId && !reg.line_user_id && proven) {
    const taken = mine.find((g) => g !== target && g.line_user_id === lineUserId && g.status === 'active');
    if (taken) lineConflict = true; // 這個 LINE 帳號已經連結另一筆報名，不搶
    else { reg.line_user_id = lineUserId; reg.bound_at = stamp; lineBound = true; if (created) reg.source = `line${testSuffix}`; }
  } else if (lineUserId && reg.line_user_id === lineUserId) lineBound = true;

  if (created) await appendRows('registrations!A:P', [regToRow(reg)]);
  else await updateRange(`registrations!A${target._row}:P${target._row}`, [regToRow(reg)]);

  return {
    ok: true, mode: created ? 'created' : fresh ? 'reopened' : (mode === 'replace' ? 'edited' : 'merged'),
    reg, test: !!testSuffix,
    // 編輯碼只給「這台裝置剛建立」或「已經拿編輯碼證明過身分」的人；只靠 Email 對上的更新不回，
    // 不然任何人知道別人的 Email 就能拿到編輯碼、讀到那個人的資料
    token: created || byToken ? reg.edit_token : '',
    // 沒證明身分的更新：連報名編號與綁定連結都不給（編號＋米亞的「#報名」就能認領那一筆）
    line: { bound: lineBound, conflict: lineConflict, bind_url: (lineBound || !proven) ? '' : lineBindRegUrl(reg.reg_id, reg.edit_token), add_friend_url: lineAddFriendUrl() },
    proven,
    // 這次送出的人自己勾的場次（頁面完成畫面只能顯示這些，不能把那一筆先前報的場次一併回給只知道 Email 的人）
    asked: c.sessions.filter((code) => askedSet.has(code)),
    campaign
  };
}

// ── 公開：用編輯碼讀／取消自己的報名 ───────────────────────────────────
export async function getRegistrationByToken(campaignId, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const g = (await loadRegs()).find((x) => x.campaign_id === campaignId && x.status !== 'deleted' && safeEqual(x.edit_token, t));
  return g || null;
}
export async function cancelRegistration(campaignId, token, { now = Date.now() } = {}) {
  const g = await getRegistrationByToken(campaignId, token);
  if (!g) return { ok: false, status: 404, error: '找不到這筆報名，可能連結不完整' };
  const next = { ...g, status: 'cancelled', updated_at: nowIso(now) };
  await updateRange(`registrations!A${g._row}:P${g._row}`, [regToRow(next)]);
  return { ok: true, reg: next };
}

// ── LINE：綁定與查詢 ──────────────────────────────────────────────────
/**
 * 報名完成頁按「用 LINE 連結」→ 米亞收到「#報名 R7K3M-檢查碼」→ 這裡把 LINE 帳號寫進那一筆。
 * check：按鈕帶來的檢查碼（見 regBindCheck()）。帶了就一定要對，對不上跟「編號不存在」回一樣的話，
 * 不讓人分辨「編號猜中了、只差檢查碼」。沒帶＝批次 116 之前的舊按鈕，暫時照舊收（眺望報名進行中，
 * 完成頁還開著的人不能按了沒反應），猜編號的次數由 api/line.js 的失敗限流擋。
 */
export async function bindRegistrationToLine(regId, userId, { now = Date.now(), check = '' } = {}) {
  const id = String(regId || '').trim().toUpperCase();
  if (!id || !userId) return { ok: false, reason: 'not_found' };
  const regs = await loadRegs();
  const g = regs.find((x) => x.reg_id === id && x.status !== 'deleted');
  if (!g) return { ok: false, reason: 'not_found' };
  if (check && !safeEqual(String(check).toUpperCase(), regBindCheck(g.edit_token))) return { ok: false, reason: 'not_found' };
  if (g.status !== 'active') return { ok: false, reason: 'inactive', reg: g };
  if (g.line_user_id && g.line_user_id !== userId) return { ok: false, reason: 'taken' };
  const campaign = await getCampaign(g.campaign_id);
  if (g.line_user_id === userId) return { ok: true, already: true, reg: g, campaign };
  const other = regs.find((x) => x.campaign_id === g.campaign_id && x.line_user_id === userId && x.status === 'active' && x !== g);
  if (other) return { ok: false, reason: 'has_other', reg: other, campaign };
  const next = { ...g, line_user_id: userId, bound_at: nowIso(now), updated_at: nowIso(now) };
  await updateRange(`registrations!A${g._row}:P${g._row}`, [regToRow(next)]);
  return { ok: true, reg: next, campaign };
}

/** 這個 LINE 帳號連結的報名（每個活動最新一筆、還有效的）。給「我要報名」卡片顯示已報場次。 */
export async function findRegistrationsForLineUser(userId) {
  if (!userId) return [];
  try {
    return (await loadRegs()).filter((g) => g.line_user_id === userId && g.status === 'active').reverse();
  } catch (e) {
    console.error('查詢 LINE 帳號的報名失敗（當作沒有）:', e.message);
    return [];
  }
}

/**
 * LINE 上「報名」按鈕與卡片小標用的名稱：後台「LINE 簡稱」有填就是「簡稱＋報名」（例：眺望2027場次報名），
 * 沒填就是「活動報名」。只寫「活動報名」的話，記者看到按鈕不知道是報哪一場（朱朱 9/29 提醒）。
 */
export function registrationLabel(c) {
  const short = cleanText(c && c.short_name, 16);
  return short ? `${short}報名` : '活動報名';
}
/**
 * 記者在聊天室打「眺望2027場次報名」「眺望2027產業發展趨勢研討會報名」這類——就是卡片標題上看到的字，
 * 簡稱或活動名稱後面接「報名」。menu.js 的固定句型不可能認得每個活動的名字，所以由這裡拿目前（開放中、剛截止）的
 * 活動逐一比對：整句只有「簡稱／活動名稱＋報名（入口／連結／表）」才算，不吃「眺望報名費多少」這種真正的提問。
 */
export function isCampaignRegisterPhrase(text, c) {
  const norm = (s) => String(s || '').replace(/[\s　📝「」『』《》]/g, '').toLowerCase();
  const t = norm(text).replace(/[?？!！。呢嗎]+$/, '').replace(/(?:表單?|連結|網址|入口|頁面?)$/, '');
  if (!t.endsWith('報名')) return false;
  const stem = t.slice(0, -2);
  if (stem.length < 2) return false; // 只有「報名」本來就由 menu.js 處理
  return [c && c.short_name, c && c.title].map(norm).filter(Boolean).some((n) => n === stem);
}

/**
 * 歡迎卡最上面那顆按鈕的字。LINE 按鈕文字上限 20 字：放不下先拿掉「（1 分鐘）」，簡稱本身就太長
 * （16 字上限＋表情＋「報名」會到 21）就截簡稱——一定要留住結尾的「報名」，不能切成「…報」。
 * 用 UTF-16 長度算（比 LINE 可能用的字元數更嚴），寧可少一個字也不要被退件。
 */
export function welcomeButtonLabel(c) {
  const base = `📝 ${registrationLabel(c)}`;
  const full = `${base}（1 分鐘）`;
  if (full.length <= 20) return full;
  if (base.length <= 20) return base;
  let short = cleanText(c && c.short_name, 16);
  while (short && `📝 ${short}報名`.length > 20) short = [...short].slice(0, -1).join('');
  return `📝 ${short}報名`;
}

/** 一場一行：「A1 10/28（三）09:30-12:00 開幕論壇暨專刊發表」 */
export function describeSessions(campaign, codes) {
  const byCode = new Map(campaign.sessions.map((s) => [s.code, s]));
  return codes.map((c) => byCode.get(c)).filter(Boolean).map((s) => `${s.code} ${s.dateLabel}${s.time} ${s.title}`);
}

// ── LINE 卡片 ─────────────────────────────────────────────────────────
const BRAND = '#0F9E7A';
const dateRangeLabel = campaignDateRange;

/**
 * 「我要報名」的回覆卡片。每個開放中的活動一張（最多 5 張）：還沒報名 → 「填寫報名表」；已連結報名 →
 * 列出已報場次與「修改我的報名」。userId 有值（1 對 1）才會在連結帶簽章身分與編輯碼；群組傳空字串，
 * 拿到的是普通連結，不把任何人的身分放進群組裡。
 */
export function buildRegistrationFlex(campaigns, regs = [], { userId = '' } = {}) {
  const bubbles = campaigns.slice(0, 5).map((c) => {
    const mine = regs.find((g) => g.campaign_id === c.id);
    const lineToken = userId ? signLineToken(userId) : '';
    const url = registerUrl(c.id, { lineToken: mine ? '' : lineToken, editToken: mine?.edit_token || '' });
    const range = dateRangeLabel(c);
    const lines = mine ? describeSessions(c, mine.sessions) : [];
    const body = [];
    if (mine) {
      body.push({ type: 'text', text: `✅ 您已報名 ${mine.sessions.length} 場`, weight: 'bold', size: 'md', color: BRAND, wrap: true });
      lines.slice(0, 6).forEach((t) => body.push({ type: 'text', text: t, size: 'xs', color: '#374151', wrap: true, margin: 'sm' }));
      if (lines.length > 6) body.push({ type: 'text', text: `⋯另 ${lines.length - 6} 場`, size: 'xs', color: '#6B7280', margin: 'sm' });
    } else {
      body.push({ type: 'text', text: '勾選要參加的場次，約 1 分鐘就能完成。', size: 'sm', color: '#374151', wrap: true });
      const t = parseTaipeiTime(c.closes_at);
      if (!Number.isNaN(t)) body.push({ type: 'text', text: `報名截止：${c.closes_at}`, size: 'xs', color: '#6B7280', margin: 'md', wrap: true });
    }
    return {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px', spacing: 'xs',
        contents: [
          { type: 'text', text: `📝 ${registrationLabel(c)}`, size: 'xs', color: '#D8F3EA', wrap: true },
          { type: 'text', text: c.title, size: 'md', weight: 'bold', color: '#FFFFFF', wrap: true },
          ...(range ? [{ type: 'text', text: `${range}・共 ${c.sessions.filter((s) => s.status !== 'cancelled').length} 場`, size: 'xs', color: '#D8F3EA', wrap: true }] : []),
          ...(c.venue ? [{ type: 'text', text: `📍 ${c.venue}`, size: 'xs', color: '#D8F3EA', wrap: true }] : [])
        ]
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'none', contents: body },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{
          type: 'button', style: 'primary', color: BRAND, height: 'sm',
          action: { type: 'uri', label: mine ? '修改我的報名' : '填寫報名表', uri: url }
        }]
      }
    };
  });
  const first = campaigns[0];
  return {
    type: 'flex',
    altText: first ? `${first.title} 活動報名：點開填寫，約 1 分鐘` : '活動報名',
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles }
  };
}
/** 卡片送不出去時的純文字版（Flex 被 LINE 拒收或舊版 App 看不到）。 */
export function buildRegistrationText(campaigns, regs = [], { userId = '' } = {}) {
  return campaigns.map((c) => {
    const mine = regs.find((g) => g.campaign_id === c.id);
    const url = registerUrl(c.id, { lineToken: mine ? '' : (userId ? signLineToken(userId) : ''), editToken: mine?.edit_token || '' });
    const where = c.venue ? `\n📍 ${c.venue}` : '';
    return mine
      ? `${c.title}${where}\n✅ 您已報名 ${mine.sessions.length} 場\n${describeSessions(c, mine.sessions).join('\n')}\n\n要修改請開：\n${url}`
      : `${c.title}${where}\n勾選要參加的場次，約 1 分鐘：\n${url}`;
  }).join('\n\n');
}

// ── 後台 ──────────────────────────────────────────────────────────────
const rosterKey = (r) => `${nameKey(r.name)}|${nameKey(r.outlet)}`;

/** 記者名單（media_roster）對照：有就標名單內／外，沒匯入名單就標 unknown，不亂猜。 */
async function loadRoster() {
  try {
    const rows = await readRange('media_roster!A2:N');
    const emails = new Set(), pairs = new Set(), names = new Set();
    for (const r of rows) {
      if (!r[1]) continue;
      if (r[4]) emails.add(String(r[4]).trim().toLowerCase());
      pairs.add(rosterKey({ name: r[1], outlet: r[2] }));
      names.add(nameKey(r[1]));
    }
    return { size: rows.filter((r) => r[1]).length, emails, pairs, names };
  } catch {
    return { size: 0, emails: new Set(), pairs: new Set(), names: new Set() };
  }
}
function rosterStatus(roster, g) {
  if (!roster.size) return 'unknown';
  if (roster.emails.has(g.email) || roster.pairs.has(rosterKey(g))) return 'yes';
  return roster.names.has(nameKey(g.name)) ? 'maybe' : 'no';
}

/** 同一個活動同一個 Email 只算一筆（搶著雙擊送出可能造成兩列，取最新那筆）。 */
export function dedupeRegs(regs) {
  const latest = new Map();
  for (const g of regs) {
    const k = `${g.campaign_id}|${g.email}`;
    const cur = latest.get(k);
    if (!cur || String(g.updated_at) >= String(cur.updated_at)) latest.set(k, { ...g, dup: (cur?.dup || 0) + (cur ? 1 : 0) });
    else cur.dup = (cur.dup || 0) + 1;
  }
  return [...latest.values()];
}

/** 後台預設打開哪一場：收件中 > 草稿（測試中）> 其餘；同一類取最近更新的。以前直接拿試算表第一列（最舊的）。 */
export function pickDefaultCampaign(campaigns, now = Date.now()) {
  const rank = (c) => (c.status === 'open' && campaignAcceptsSubmissions(c, now).ok ? 0 : c.status === 'draft' ? 1 : 2);
  return [...campaigns].sort((a, b) => rank(a) - rank(b) || String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
}

/** 清單卡片用：一場活動的日期範圍（不含取消的場次）。沒有場次回空字串。 */
export function campaignDateRange(c) {
  const live = (c.sessions || []).filter((s) => s.status !== 'cancelled');
  if (!live.length) return '';
  const a = live[0], z = live[live.length - 1];
  return a.date === z.date ? a.dateLabel : `${a.dateLabel} – ${z.dateLabel}`;
}

/**
 * 後台總覽。campaignId 對不到就用 pickDefaultCampaign()。
 * summary：只要「所有活動的清單與各自的人數」（後台首頁用），不算單場的名單與各場人數。
 */
export async function adminOverview(campaignId, { includeTest = false, summary = false } = {}) {
  const campaigns = await loadCampaigns({ fresh: true });
  const current = summary ? null : (campaigns.find((c) => c.id === campaignId) || pickDefaultCampaign(campaigns));
  const all = (await loadRegs()).filter((g) => g.status !== 'deleted');
  const roster = await loadRoster();
  // 每場活動的人數（不含測試與取消）：清單卡片用。同一個 Email 只算一筆，口徑跟單場統計一致
  const tally = (id) => {
    const act = dedupeRegs(all.filter((g) => g.campaign_id === id && !isTestReg(g))).filter((g) => g.status === 'active');
    return { people: act.length, outlets: new Set(act.map((g) => nameKey(g.outlet))).size };
  };
  const mineAll = current ? all.filter((g) => g.campaign_id === current.id) : [];
  const mine = dedupeRegs(mineAll).filter((g) => includeTest || !isTestReg(g));
  const active = mine.filter((g) => g.status === 'active');
  const regs = mine.map((g) => ({
    reg_id: g.reg_id, created_at: g.created_at, updated_at: g.updated_at, name: g.name, outlet: g.outlet,
    email: g.email, phone: g.phone, phone_label: formatPhone(g.phone), sessions: g.sessions, options: g.options,
    line_bound: !!g.line_user_id, status: g.status, source: g.source, test: isTestReg(g), note: g.note,
    roster: rosterStatus(roster, g), dup: g.dup || 0
  })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const perSession = (current?.sessions || []).map((s) => ({
    code: s.code, count: active.filter((g) => g.sessions.includes(s.code)).length,
    outlets: new Set(active.filter((g) => g.sessions.includes(s.code)).map((g) => nameKey(g.outlet))).size
  }));
  const optionTotals = {};
  for (const o of current?.options || []) {
    optionTotals[o.key] = active.reduce((n, g) => n + (o.type === 'number' ? (parseInt(g.options[o.key], 10) || 0) : (g.options[o.key] ? 1 : 0)), 0);
  }
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id, title: c.title, status: c.status, intro: c.intro, sessions_text: c.sessions_text, options_text: c.options_text,
      privacy: c.privacy, contact: c.contact, closes_at: c.closes_at, line_pitch: c.line_pitch, updated_at: c.updated_at,
      session_count: c.sessions.length, accepting: campaignAcceptsSubmissions(c).ok, short_name: c.short_name, venue: c.venue,
      date_range: campaignDateRange(c), date_from: (c.sessions.find((s) => s.status !== 'cancelled') || {}).date || '', ...tally(c.id),
      test: all.filter((g) => g.campaign_id === c.id && isTestReg(g)).length
    })),
    current: current ? current.id : '',
    sessions: (current?.sessions || []).map((s) => ({ ...s, ended: isSessionEnded(s) })), options: current?.options || [],
    regs, per_session: perSession, option_totals: optionTotals,
    stats: {
      people: active.length,
      outlets: new Set(active.map((g) => nameKey(g.outlet))).size,
      line_bound: active.filter((g) => g.line_user_id).length,
      out_of_roster: roster.size ? active.filter((g) => rosterStatus(roster, g) === 'no').length : null,
      cancelled: mine.filter((g) => g.status === 'cancelled').length,
      test: includeTest ? mine.filter(isTestReg).length : all.filter((g) => g.campaign_id === current?.id && isTestReg(g)).length
    },
    roster_size: roster.size,
    // all：所有開放中活動的總入口（只開一場就直接進那一場，開兩場以上讓記者自己挑）
    links: { ...(current ? { form: registerUrl(current.id) } : {}), all: `${siteBase()}/register` },
    line: { basic_id: lineBasicId(), add_friend_url: lineAddFriendUrl() }
  };
}

/** 後台儲存報名活動。文字欄位驗證有錯就整批退回，不默默吞掉任何一行。 */
export async function adminSaveCampaign(input, { now = Date.now() } = {}) {
  const id = cleanText(input.id, 30).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(id)) return { ok: false, error: '活動代碼要是 2～30 個英文小寫、數字或連字號（例如 tw2027）' };
  const title = cleanText(input.title, LIMITS.title);
  if (!title) return { ok: false, error: '請填活動名稱' };
  const status = CAMPAIGN_STATUSES.includes(input.status) ? input.status : 'draft';
  const closesAt = cleanText(input.closes_at, 40);
  if (closesAt && Number.isNaN(parseTaipeiTime(closesAt))) return { ok: false, error: '截止時間請寫成 2026-10-27 12:00（或只寫日期）' };
  const year = closesAt ? new Date(parseTaipeiTime(closesAt) + 8 * 3600e3).getUTCFullYear() : taipeiYear(now);
  const sessionsText = cleanMultiline(input.sessions_text, LIMITS.sessions);
  const ps = parseSessions(sessionsText, year);
  if (ps.errors.length) return { ok: false, error: '場次清單有地方要修正', details: ps.errors };
  if (!ps.sessions.length) return { ok: false, error: '至少要有一個場次' };
  const optionsText = cleanMultiline(input.options_text, LIMITS.options);
  const po = parseOptions(optionsText, ps.sessions.map((s) => s.code));
  if (po.errors.length) return { ok: false, error: '選填項目有地方要修正', details: po.errors };

  await ensureRegSheets();
  const rows = await readRange(CAMPAIGN_RANGE);
  const idx = rows.findIndex((r) => r[0] === id);
  const stamp = nowIso(now);
  // 活動地點：請求裡「沒有這個欄位」（瀏覽器還開著舊版後台頁、還沒有地點欄）時保留原值，不能把已填的洗成空白；
  // 明確傳空字串才是清掉。批次 95：正式站那筆活動的地點填了卻是空的，其中一個嫌疑就是這條路。
  const venue = input.venue === undefined && idx !== -1 ? cleanText(rows[idx][13], LIMITS.venue) : cleanText(input.venue, LIMITS.venue);
  const row = campaignToRow({
    id, title, status,
    intro: cleanMultiline(input.intro, LIMITS.intro),
    sessions_text: sessionsToText(ps.sessions), options_text: optionsToText(po.options),
    privacy: cleanMultiline(input.privacy, LIMITS.privacy), contact: cleanMultiline(input.contact, LIMITS.contact),
    closes_at: closesAt, line_pitch: cleanMultiline(input.line_pitch, LIMITS.pitch), short_name: cleanText(input.short_name, 16), venue,
    created_at: idx === -1 ? stamp : (rows[idx][10] || stamp), updated_at: stamp
  });
  if (idx === -1) await appendRows('reg_campaigns!A:N', [row]);
  else await updateRange(`reg_campaigns!A${idx + 2}:N${idx + 2}`, [row]);
  invalidateCampaignCache();
  return { ok: true, id, created: idx === -1 };
}

/** 後台改單筆報名：狀態（有效／取消／刪除）、備註、場次。刪除是標記，不是真的抹掉那一列。 */
export async function adminUpdateRegistration(regId, patch, { now = Date.now() } = {}) {
  const regs = await loadRegs();
  const g = regs.filter((x) => x.reg_id === String(regId || '').toUpperCase()).pop();
  if (!g) return { ok: false, status: 404, error: '找不到這筆報名' };
  const next = { ...g, updated_at: nowIso(now) };
  if (patch.status !== undefined) {
    if (!REG_STATUSES.includes(patch.status)) return { ok: false, status: 400, error: '狀態值不正確' };
    next.status = patch.status;
  }
  if (patch.note !== undefined) next.note = cleanText(patch.note, LIMITS.note);
  if (patch.sessions !== undefined) {
    const campaign = await getCampaign(g.campaign_id, { fresh: true });
    const known = new Set((campaign?.sessions || []).map((s) => s.code));
    const wanted = [...new Set((Array.isArray(patch.sessions) ? patch.sessions : []).map((c) => String(c).toUpperCase()))].filter((c) => known.has(c));
    if (!wanted.length) return { ok: false, status: 400, error: '至少要留一個場次；要整筆取消請改狀態' };
    next.sessions = wanted;
  }
  await updateRange(`registrations!A${g._row}:P${g._row}`, [regToRow(next)]);
  return { ok: true, reg: next };
}

/** 清掉草稿活動送出的測試報名（標成 deleted）。回傳清掉幾筆。 */
export async function adminClearTests(campaignId) {
  const regs = (await loadRegs()).filter((g) => g.campaign_id === campaignId && isTestReg(g) && g.status !== 'deleted');
  const stamp = nowIso();
  for (const g of regs) await updateRange(`registrations!A${g._row}:P${g._row}`, [regToRow({ ...g, status: 'deleted', updated_at: stamp })]);
  return { ok: true, cleared: regs.length };
}

// ── 匯出 ──────────────────────────────────────────────────────────────
// 公開表單的內容會被承辦人用 Excel 打開：開頭是 = + - @ 的欄位加一個單引號，
// 不讓報名者的姓名／媒體欄位變成公式。
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export async function adminExportCsv(campaignId, { includeCancelled = false } = {}) {
  const ov = await adminOverview(campaignId);
  const c = ov.campaigns.find((x) => x.id === ov.current);
  if (!c) return { ok: false, status: 404, error: '找不到這個報名活動' };
  const campaign = await getCampaign(c.id, { fresh: true });
  const rows = ov.regs.filter((g) => (includeCancelled || g.status === 'active'));
  const head = ['報名編號', '報名時間', '更新時間', '姓名', '單位／媒體', 'Email', '手機', '記者名單', '已連結LINE', '場次數', '場次',
    ...campaign.sessions.map((s) => `${s.code} ${s.md} ${s.title}`),
    ...campaign.options.map((o) => o.label), '狀態', '備註'];
  const roster = { yes: '名單內', maybe: '同名不同媒體', no: '名單外', unknown: '' };
  const lines = [head.map(csvCell).join(',')];
  for (const g of rows) {
    lines.push([g.reg_id, g.created_at.replace('T', ' ').replace('+08:00', ''), g.updated_at.replace('T', ' ').replace('+08:00', ''),
      g.name, g.outlet, g.email, g.phone_label, roster[g.roster] || '', g.line_bound ? '是' : '', g.sessions.length, g.sessions.join(' '),
      ...campaign.sessions.map((s) => (g.sessions.includes(s.code) ? '✓' : '')),
      ...campaign.options.map((o) => (o.type === 'number' ? (g.options[o.key] || '') : (g.options[o.key] ? '✓' : ''))),
      g.status === 'active' ? '有效' : '已取消', g.note].map(csvCell).join(','));
  }
  return { ok: true, csv: '﻿' + lines.join('\r\n') + '\r\n', filename: `活動報名_${c.id}_${nowIso().slice(0, 10)}.csv`, count: rows.length };
}
