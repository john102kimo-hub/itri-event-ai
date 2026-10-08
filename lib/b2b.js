// 業發處的合作洽詢（批次 119，第 1 步）：資料層與規則。HTTP 入口在 lib/b2b-api.js，米亞那一端在 lib/b2b-line.js。
//
// 業發處要的是「接得住、分得出去、不會漏回」：企業從洽詢單（/inquiry）送進來 → 依技術領域自動分給業務窗口 →
// LINE 通知承辦人 → 期限內沒聯繫，每天早上提醒，逾期再通知管理員。這支是那條流水線的資料層。
//
// 跟記者會那套刻意分開的地方（給朱朱的報告第二部分：「放客戶資料之前，要先處理四件事」）：
//   ① 另一本試算表（B2B_SPREADSHEET_ID）。沒設定就整套停用（fail-closed），**絕不退回記者會那本**——
//      記者會那本分享給公關與各所同仁，客戶資料只能給業發處。
//   ② 每個人自己的連結，不是共用密碼。成員表只存連結代碼的雜湊；連結外流就「重發連結」，舊的立刻作廢。
//      每一個動作記在 b2b_audit：誰、什麼時候、對哪一筆、做了什麼（看過哪一筆也記）。
//   ③ LINE 通知只帶編號與期限，不帶公司名稱與需求內容：LINE 的訊息會留在手機與 LINE 的伺服器上。
//      而且有每月上限（預設 60 則）：通知走的是米亞同一個官方帳號，push 跟記者那邊共用每個月的訊息額度，
//      業發處的通知不能把米亞的額度用光（朱朱 10/8：「務必確保不要影響既有的功能與媒體之使用」）。
//   ④ 米亞只負責指路（lib/b2b-line.js），不在聊天室裡收任何企業資料。
//
// 「三天沒回比沒有這個功能更傷」（LINE-PLAN.md 第 4 節 interview、第 9 節第 3 條）：每一筆有期限（預設 2 個工作天），
// 排程每個工作天早上檢查，逾期就提醒承辦人、逾期超過一個工作天再通知管理員，直到有人處理為止。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sheetsFor } from './sheets.js';
import { pushMessage } from './line.js';
import { lineBasicId } from './line-link.js';
import { toTraditionalTW } from './zh-tw.js';
import { cleanText, normalizeEmail, isValidEmail, normalizePhone, nowIso, siteBase } from './registration.js';

export const B2B_HEADERS = {
  b2b_members: ['id', 'name', 'email', 'unit', 'role', 'topics', 'key_hash', 'line_user_id', 'status', 'created_at', 'updated_at'],
  b2b_inquiries: ['id', 'created_at', 'updated_at', 'status', 'company', 'name', 'title', 'email', 'phone', 'topic', 'need',
    'source', 'owner', 'due_at', 'first_contact_at', 'notes', 'consent_at', 'last_reminded'],
  b2b_audit: ['at', 'actor', 'action', 'target', 'detail'],
  b2b_settings: ['key', 'value', 'updated_at', 'updated_by']
};
const RANGE = { members: 'b2b_members!A2:K', inquiries: 'b2b_inquiries!A2:R', audit: 'b2b_audit!A2:E', settings: 'b2b_settings!A2:D' };

export const ROLES = { admin: '管理員', bd: '業務窗口' };
export const INQUIRY_STATUSES = { new: '待聯繫', contacted: '已聯繫', proposing: '提案中', won: '成案', closed: '結案', spam: '無效' };

// ── 設定（b2b_settings，一列一個 key）────────────────────────────────────
// privacy 沒填就不收件：洽詢單一定要有個資告知（個資法第 8 條），跟企業場報名同一條規則（批次 118）。
const DEFAULT_SETTINGS = { intake_open: '1', sla_days: '2', privacy: '', topics: '', default_owner: '', line_push_limit: '60' };
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
// ⚠️ 範本：正式對外前請院內法務確認文字。
export const INQUIRY_PRIVACY_TEMPLATE = [
  '【個人資料蒐集告知】',
  '工業技術研究院（以下簡稱本院）為回覆您的合作洽詢並進行後續技術合作洽談，蒐集您的姓名、服務單位、職稱、Email、電話及洽詢內容。',
  '上述資料僅於本院業務推廣與客戶服務之目的範圍內，以電子郵件、電話及書面方式於中華民國境內利用，利用期間至洽詢結案後三年。',
  '您可依個人資料保護法第 3 條，向本院請求查詢、閱覽、製給複製本、補充、更正、停止蒐集處理利用或刪除，請來信洽詢窗口。',
  '您可自由選擇是否提供；未提供將無法受理洽詢。'
].join('\n');

/** 有沒有設定業發處的試算表。沒有就整套停用——洽詢單暫停收件、米亞不攔「合作洽詢」、後台回 503。 */
export function b2bConfigured() { return !!process.env.B2B_SPREADSHEET_ID; }
export class B2BNotConfigured extends Error {
  constructor() { super('業發處的試算表還沒設定（B2B_SPREADSHEET_ID）'); this.code = 'not_configured'; }
}
function db() {
  if (!b2bConfigured()) throw new B2BNotConfigured();
  return sheetsFor(process.env.B2B_SPREADSHEET_ID);
}

let ensuredAt = 0;
async function ensureB2BSheets() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60_000) throw new Error('業發處的資料表暫時無法建立，請稍後再試');
  try { await db().ensureSheets(B2B_HEADERS); }
  catch (e) { ensuredAt = Date.now(); throw e; }
  ensuredAt = Infinity;
}

// ── 小工具 ────────────────────────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 I L O 0 1，口頭報、手打都不會混
function code(prefix, n) {
  const b = randomBytes(n);
  let s = prefix;
  for (let i = 0; i < n; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}
export const makeMemberId = () => code('M', 5);
export const makeInquiryId = () => code('Q', 6);
/** 成員的個人連結代碼：144 位元，只在建立或重發的那一刻給出去，試算表只存雜湊。 */
export const makeMemberKey = () => randomBytes(18).toString('base64url');
export const hashKey = (key) => createHash('sha256').update(`b2b-member:${key}`).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
const cleanMultiline = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

/** 台灣時間往後算 n 個工作天（週一到週五）。國定假日不扣——遇到連假提醒會早一兩天，寧可早不要晚。 */
export function addBusinessDays(ms, days) {
  let t = ms;
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    t += 86400e3;
    const wd = new Date(t + 8 * 3600e3).getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return t;
}
/** from 到 to 之間隔了幾個工作天（to 在 from 之前回 0）。 */
export function businessDaysBetween(from, to) {
  let n = 0;
  for (let t = from + 86400e3; t <= to; t += 86400e3) {
    const wd = new Date(t + 8 * 3600e3).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
const isoMs = (s) => Date.parse(String(s || ''));
const taipeiDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const shortTime = (iso) => String(iso || '').replace('T', ' ').replace(/:\d{2}\+08:00$/, '');

// ── 列 ↔ 物件 ─────────────────────────────────────────────────────────
const fromRow = (headers) => (r, i) => {
  const o = { _row: i + 2 };
  headers.forEach((h, k) => { o[h] = String((r || [])[k] ?? ''); });
  return o;
};
const toRow = (headers) => (o) => headers.map((h) => String(o[h] ?? ''));
const memberFromRow = fromRow(B2B_HEADERS.b2b_members);
const memberToRow = toRow(B2B_HEADERS.b2b_members);
const inquiryFromRow = fromRow(B2B_HEADERS.b2b_inquiries);
const inquiryToRow = toRow(B2B_HEADERS.b2b_inquiries);

// ── 讀取（成員與設定有短快取：每一個後台請求都要驗身分，不能每次都打 Sheets）──────────
const CACHE_MS = 30_000;
let memberCache = { rows: null, expiry: 0 };
let settingsCache = { value: null, expiry: 0 };
/** 測試用：清掉快取與「分頁已確認」旗標。 */
export function resetB2BState() { memberCache = { rows: null, expiry: 0 }; settingsCache = { value: null, expiry: 0 }; ensuredAt = 0; }

export async function loadMembers({ fresh = false } = {}) {
  if (!fresh && memberCache.rows && Date.now() < memberCache.expiry) return memberCache.rows;
  await ensureB2BSheets();
  const rows = (await db().readRange(RANGE.members)).map(memberFromRow).filter((m) => m.id);
  memberCache = { rows, expiry: Date.now() + CACHE_MS };
  return rows;
}
export async function loadSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache.value && Date.now() < settingsCache.expiry) return settingsCache.value;
  await ensureB2BSheets();
  const value = { ...DEFAULT_SETTINGS, _push_used: '' };
  for (const r of await db().readRange(RANGE.settings)) {
    if (SETTING_KEYS.includes(r[0])) value[r[0]] = String(r[1] ?? '');
    if (r[0] === PUSH_USED_KEY) value._push_used = String(r[1] ?? ''); // 內部計數，不是後台可以改的設定
  }
  settingsCache = { value, expiry: Date.now() + CACHE_MS * 2 };
  return value;
}
export const slaDays = (cfg) => Math.min(10, Math.max(1, parseInt(cfg?.sla_days, 10) || 2));
/** 洽詢單收不收件：要有設定試算表、沒有被關掉、而且有個資告知。 */
export const intakeOpen = (cfg) => !!cfg && cfg.intake_open !== '0' && !!String(cfg.privacy || '').trim();
export const topicList = (cfg) => String(cfg?.topics || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30);

// ── LINE 推播額度 ──────────────────────────────────────────────────────
// 米亞的官方帳號每個月的推播（push）有額度，reply 不算、push 算；記者那邊的 push 是「回覆失敗才補送」與
// 給管理員的通知，量不大但不能沒有。業發處的通知全是 push，所以設一個每月上限（預設 60 則，後台可改，
// 0＝完全不用米亞推播）。用完就不推：洽詢照樣進收件匣、期限照樣算，後台會顯示「本月額度已用完」。
// 計數存在 b2b_settings 的 line_push_used（「2026-10:12」），跨月自動歸零。多台機器同時推播可能少算一兩則，
// 上限本來就抓得比總額度低很多，夠用。
const PUSH_USED_KEY = 'line_push_used';
export const pushLimit = (cfg) => Math.min(1000, Math.max(0, parseInt(cfg?.line_push_limit ?? '60', 10) || 0));
export function pushUsage(cfg, now = Date.now()) {
  const month = taipeiDate(now).slice(0, 7);
  const [m, n] = String(cfg?._push_used || '').split(':');
  const used = m === month ? (parseInt(n, 10) || 0) : 0;
  return { month, used, limit: pushLimit(cfg), exhausted: used >= pushLimit(cfg) };
}
/** 一次拿 n 則推播額度，回傳實際拿到幾則（0＝本月用完）。排程一次要推好幾個人，整批拿，Sheets 只讀寫各一次。 */
async function takePushQuota(now, n = 1) {
  if (n <= 0) return 0;
  const rows = await db().readRange(RANGE.settings); // 不吃快取：額度要看最新的
  const cfg = { line_push_limit: rows.find((r) => r[0] === 'line_push_limit')?.[1] ?? DEFAULT_SETTINGS.line_push_limit,
    _push_used: rows.find((r) => r[0] === PUSH_USED_KEY)?.[1] || '' };
  const u = pushUsage(cfg, now);
  const grant = Math.max(0, Math.min(n, u.limit - u.used));
  if (!grant) return 0;
  const idx = rows.findIndex((r) => r[0] === PUSH_USED_KEY);
  const row = [PUSH_USED_KEY, `${u.month}:${u.used + grant}`, nowIso(now), 'system'];
  if (idx === -1) await db().appendRows('b2b_settings!A:D', [row]);
  else await db().updateRange(`b2b_settings!A${idx + 2}:D${idx + 2}`, [row]);
  settingsCache = { value: null, expiry: 0 };
  return grant;
}

async function loadInquiries() {
  await ensureB2BSheets();
  return (await db().readRange(RANGE.inquiries)).map(inquiryFromRow).filter((q) => q.id);
}

/** 稽核紀錄。寫不進去只記 log、不擋住正事（但正事本身寫不進去時，呼叫端照樣會往外丟）。 */
export async function audit(actor, action, target = '', detail = '', now = Date.now()) {
  await auditMany([[actor, action, target, detail]], now);
}
/** 好幾筆稽核一次寫（一次 Sheets 呼叫）：[[actor, action, target, detail], …] */
async function auditMany(entries, now = Date.now()) {
  if (!entries.length) return;
  try {
    await db().appendRows('b2b_audit!A:E', entries.map(([actor, action, target = '', detail = '']) =>
      [nowIso(now), String(actor || ''), action, String(target || ''), String(detail || '').slice(0, 300)]));
  } catch (e) {
    console.error('[b2b] 稽核紀錄寫入失敗:', entries.map((x) => `${x[1]} ${x[2] || ''}`).join('、').slice(0, 200), e.message);
  }
}

// ── 身分 ──────────────────────────────────────────────────────────────
/** 個人連結代碼 → 成員（停用的不算）。比對雜湊，不比對原文。 */
export async function memberByKey(key) {
  const k = String(key || '').trim();
  if (k.length < 16 || k.length > 64) return null;
  const h = hashKey(k);
  const m = (await loadMembers()).find((x) => x.status === 'active' && safeEqual(x.key_hash, h));
  return m || null;
}
/** 綁定 LINE 通知用的檢查碼：從成員的連結雜湊算出來，重發連結之後舊的綁定按鈕跟著失效。 */
export function memberBindCheck(member) {
  if (!member?.key_hash) return '';
  const b = createHash('sha256').update(`b2b-line:${member.key_hash}`).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}
/** 成員在後台按「綁定 LINE 通知」：打開米亞聊天室、輸入框已帶好「#業務 M7K3Q-K8PQ2X」。 */
export function memberLineBindUrl(member) {
  const id = lineBasicId();
  if (!id || !member?.id) return '';
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`#業務 ${member.id}-${memberBindCheck(member)}`)}`;
}
// 個人連結與通知裡的連結都加 openExternalBrowser=1（LINE 官方的參數）：在 LINE 裡點開時改用手機的預設瀏覽器，
// 不用 LINE 內建的。內建瀏覽器的儲存空間跟手機瀏覽器是分開的——個人連結在哪一邊開過，那一邊才記得是誰；
// 兩種連結都固定開在預設瀏覽器，點通知才會直接打開那一筆，而不是停在登入頁。在 LINE 以外點開，這個參數沒有作用。
const B2B_PAGE = () => `${siteBase()}/b2b?openExternalBrowser=1`;
export function memberLink(key) { return `${B2B_PAGE()}#k=${encodeURIComponent(key)}`; }

// ── 通知（LINE push，只帶編號與期限；每月有上限，見 takePushQuota()）────────────
const reachable = (member) => !!member?.line_user_id && !!process.env.LINE_CHANNEL_ACCESS_TOKEN;
async function pushTo(member, text) {
  try {
    const r = await pushMessage(member.line_user_id, toTraditionalTW(text));
    return r?.ok !== false;
  } catch (e) {
    console.error('[b2b] LINE 通知失敗:', member.id, e.message);
    return false;
  }
}
async function notify(member, text, now = Date.now()) {
  if (!reachable(member)) return false;
  try {
    if (!await takePushQuota(now, 1)) {
      await audit('system', 'notify_skipped', member.id, '本月 LINE 推播額度已用完', now);
      return false;
    }
  } catch (e) {
    console.error('[b2b] 推播額度讀不到，這一則先不推:', member.id, e.message);
    return false;
  }
  return pushTo(member, text);
}
const inquiryLink = (id) => `${B2B_PAGE()}#q=${encodeURIComponent(id)}`;

// ── 分派 ──────────────────────────────────────────────────────────────
/**
 * 依「負責的技術領域關鍵字」挑承辦人：洽詢的技術領域＋需求內容命中最多關鍵字的那位；都沒命中就給
 * 設定裡的預設承辦人；再沒有就不分派（管理員收件匣裡看得到「未分派」，並收到通知）。
 * 純字面比對、不呼叫模型：分錯了承辦人會在後台改派，模型分錯卻沒人知道為什麼。
 */
export function pickOwner(clean, members, cfg) {
  const text = `${clean.topic || ''} ${clean.need || ''}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const m of members) {
    if (m.status !== 'active') continue;
    const kws = String(m.topics || '').split(/[,，、;；\n]+/).map((s) => s.trim().toLowerCase()).filter((k) => k.length >= 2);
    const score = kws.filter((k) => text.includes(k)).length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  if (best) return { owner: best, reason: '技術領域' };
  const def = members.find((m) => m.id === cfg?.default_owner && m.status === 'active');
  return def ? { owner: def, reason: '預設承辦人' } : { owner: null, reason: '未分派' };
}

// ── 公開：送出洽詢 ────────────────────────────────────────────────────
export function validateInquiry(body) {
  const errors = [];
  const company = cleanText(body.company, 60);
  const name = cleanText(body.name, 40);
  const title = cleanText(body.title, 40);
  const email = normalizeEmail(body.email);
  const phoneRaw = String(body.phone ?? '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  const topic = cleanText(body.topic, 40);
  const need = cleanMultiline(body.need, 2000);
  if (!company) errors.push({ field: 'company', message: '請填寫公司或單位名稱' });
  if (!name) errors.push({ field: 'name', message: '請填寫姓名' });
  if (!email) errors.push({ field: 'email', message: '請填寫 Email' });
  else if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Email 格式好像不對，請再確認' });
  if (phoneRaw && !phone) errors.push({ field: 'phone', message: '電話格式好像不對（例如 03-591-1234 或 0912-345-678）' });
  if (need.length < 10) errors.push({ field: 'need', message: '請簡單說明您的需求（至少 10 個字）' });
  if (body.consent !== true) errors.push({ field: 'consent', message: '請先閱讀並勾選同意「個人資料蒐集告知」' });
  return { errors, clean: { company, name, title, email, phone, topic, need } };
}

/**
 * 新增一筆洽詢並分派、通知。回傳 { ok, id, due_at, sla_days } 或 { ok:false, status, error, errors? }。
 * fromRegistration：企業場報名時勾了「希望業務窗口與我聯繫」轉過來的（同意已在報名時給過，不看收件開關）。
 */
export async function submitInquiry(body, { source = 'web', now = Date.now(), consentAt = '', fromRegistration = false } = {}) {
  const cfg = await loadSettings();
  if (!fromRegistration && !intakeOpen(cfg)) return { ok: false, status: 503, error: '目前暫停線上收件，請直接聯絡活動或業務窗口' };
  const v = validateInquiry(fromRegistration ? { ...body, consent: true } : body);
  if (v.errors.length) return { ok: false, status: 400, error: v.errors[0].message, errors: v.errors };
  const members = await loadMembers();
  const { owner, reason } = pickOwner(v.clean, members, cfg);
  const days = slaDays(cfg);
  const stamp = nowIso(now);
  const inquiry = {
    id: makeInquiryId(), created_at: stamp, updated_at: stamp, status: 'new', ...v.clean,
    source: String(source).slice(0, 60), owner: owner ? owner.id : '', due_at: nowIso(addBusinessDays(now, days)),
    first_contact_at: '', notes: '', consent_at: consentAt || stamp, last_reminded: ''
  };
  await db().appendRows('b2b_inquiries!A:R', [inquiryToRow(inquiry)]);
  await audit('public', 'submit', inquiry.id, `來源 ${inquiry.source}；分派 ${owner ? owner.id : '—'}（${reason}）`, now);
  const targets = owner ? [owner] : members.filter((m) => m.role === 'admin' && m.status === 'active');
  const text = `📥 新的合作洽詢 ${inquiry.id}${owner ? '' : '（未分派，請指派承辦人）'}\n請在 ${shortTime(inquiry.due_at).slice(0, 10)} 前聯繫（${days} 個工作天）。\n${inquiryLink(inquiry.id)}`;
  for (const m of targets) await notify(m, text, now);
  return { ok: true, id: inquiry.id, due_at: inquiry.due_at, sla_days: days, owner: owner ? owner.id : '' };
}

/** 企業場報名（批次 118）勾了「希望業務窗口與我聯繫」：轉一筆洽詢，同意時間沿用報名那一次。沒設定就安靜跳過。 */
export async function inquiryFromRegistration(reg, campaign, { now = Date.now() } = {}) {
  if (!b2bConfigured()) return { ok: false, skipped: 'not_configured' };
  const topicAnswer = String(reg.options?.topic || '').trim();
  return submitInquiry({
    company: reg.outlet, name: reg.name, email: reg.email, phone: reg.phone, topic: topicAnswer.slice(0, 40),
    need: `報名《${campaign.title}》時勾選「希望業務窗口與我聯繫」。${topicAnswer ? `\n想了解：${topicAnswer}` : ''}`
  }, { source: `報名 ${campaign.id}`, now, consentAt: reg.options?._consent || '', fromRegistration: true });
}

// ── 後台：收件匣 ──────────────────────────────────────────────────────
const canSee = (actor, q) => actor.admin || q.owner === actor.member.id;
const summary = (q, members, now) => ({
  id: q.id, created_at: q.created_at, status: q.status, company: q.company, topic: q.topic, source: q.source,
  owner: q.owner, owner_name: members.find((m) => m.id === q.owner)?.name || '', due_at: q.due_at,
  overdue: q.status === 'new' && now > isoMs(q.due_at)
});

/** 收件匣：管理員看全部，業務窗口只看分給自己的。只回摘要（公司、領域、期限）——個資要點開單筆才看得到，看了會記稽核。 */
export async function listInquiriesFor(actor, { now = Date.now() } = {}) {
  const [all, members] = await Promise.all([loadInquiries(), loadMembers()]);
  return all.filter((q) => canSee(actor, q)).map((q) => summary(q, members, now))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(b.created_at).localeCompare(String(a.created_at)));
}

/** 單筆（含聯絡方式與需求）。看過就記一筆稽核：客戶資料誰看過，要查得出來。 */
export async function getInquiryFor(actor, id, { now = Date.now() } = {}) {
  const [all, members] = await Promise.all([loadInquiries(), loadMembers()]);
  const q = all.find((x) => x.id === String(id || '').toUpperCase());
  if (!q || !canSee(actor, q)) return null;
  await audit(actor.member.id, 'view', q.id, '', now);
  const out = { ...q, ...summary(q, members, now) };
  delete out._row; delete out.last_reminded; // 列號與提醒日期是內部用的
  return out;
}

/** 改狀態、改派、加備註。業務窗口只能動分給自己的；改派之後新的承辦人會收到通知。 */
export async function updateInquiry(actor, id, patch, { now = Date.now() } = {}) {
  const all = await loadInquiries();
  const q = all.find((x) => x.id === String(id || '').toUpperCase());
  if (!q || !canSee(actor, q)) return { ok: false, status: 404, error: '找不到這筆洽詢' };
  const next = { ...q };
  const changes = [];
  if (patch.status !== undefined && patch.status !== q.status) {
    if (!INQUIRY_STATUSES[patch.status]) return { ok: false, status: 400, error: '狀態值不正確' };
    next.status = patch.status;
    if (q.status === 'new' && !q.first_contact_at) next.first_contact_at = nowIso(now);
    changes.push(`狀態 ${q.status}→${patch.status}`);
  }
  let newOwner = null;
  if (patch.owner !== undefined && patch.owner !== q.owner) {
    const members = await loadMembers({ fresh: true });
    newOwner = members.find((m) => m.id === patch.owner && m.status === 'active');
    if (patch.owner && !newOwner) return { ok: false, status: 400, error: '找不到這位成員，或已停用' };
    next.owner = newOwner ? newOwner.id : '';
    changes.push(`承辦 ${q.owner || '—'}→${next.owner || '—'}`);
  }
  const note = cleanMultiline(patch.note, 1000);
  if (note) {
    next.notes = `${q.notes ? q.notes + '\n' : ''}[${shortTime(nowIso(now))} ${actor.member.name}] ${note}`.slice(-8000);
    changes.push('加備註');
  }
  if (!changes.length) return { ok: true, unchanged: true };
  next.updated_at = nowIso(now);
  await db().updateRange(`b2b_inquiries!A${q._row}:R${q._row}`, [inquiryToRow(next)]);
  await audit(actor.member.id, 'update', q.id, changes.join('；'), now);
  if (newOwner && newOwner.id !== actor.member.id) {
    await notify(newOwner, `📥 合作洽詢 ${q.id} 改由您承辦（${actor.member.name} 轉派）。\n請在 ${shortTime(q.due_at).slice(0, 10)} 前聯繫。\n${inquiryLink(q.id)}`, now);
  }
  return { ok: true };
}

// ── 後台：成員（只有管理員）──────────────────────────────────────────
const publicMember = (m) => ({
  id: m.id, name: m.name, email: m.email, unit: m.unit, role: m.role, topics: m.topics, status: m.status,
  line_bound: !!m.line_user_id, created_at: m.created_at, updated_at: m.updated_at
});
export async function listMembers() { return (await loadMembers({ fresh: true })).map(publicMember); }

/** 新增或修改成員。新增時回傳個人連結（只有這一次看得到原文）。 */
export async function saveMember(actor, input, { now = Date.now() } = {}) {
  const name = cleanText(input.name, 40);
  const email = normalizeEmail(input.email);
  const unit = cleanText(input.unit, 40);
  const role = input.role === 'admin' ? 'admin' : 'bd';
  const topics = cleanMultiline(input.topics, 500);
  const status = input.status === 'disabled' ? 'disabled' : 'active';
  if (!name) return { ok: false, status: 400, error: '請填姓名' };
  if (email && !isValidEmail(email)) return { ok: false, status: 400, error: 'Email 格式不對' };
  const rows = await loadMembers({ fresh: true });
  const stamp = nowIso(now);
  if (input.id) {
    const m = rows.find((x) => x.id === input.id);
    if (!m) return { ok: false, status: 404, error: '找不到這位成員' };
    // 不能把自己降級或停用，免得最後一位管理員把自己鎖在門外
    if (m.id === actor.member.id && (role !== 'admin' || status !== 'active')) return { ok: false, status: 400, error: '不能把自己降級或停用' };
    const next = { ...m, name, email, unit, role, topics, status, updated_at: stamp };
    await db().updateRange(`b2b_members!A${m._row}:K${m._row}`, [memberToRow(next)]);
    memberCache = { rows: null, expiry: 0 };
    await audit(actor.member.id, 'member_update', m.id, `${role}/${status}`, now);
    return { ok: true, member: publicMember(next) };
  }
  const key = makeMemberKey();
  let id = makeMemberId();
  for (let i = 0; i < 5 && rows.some((x) => x.id === id); i++) id = makeMemberId();
  const m = { id, name, email, unit, role, topics, key_hash: hashKey(key), line_user_id: '', status, created_at: stamp, updated_at: stamp };
  await db().appendRows('b2b_members!A:K', [memberToRow(m)]);
  memberCache = { rows: null, expiry: 0 };
  await audit(actor.member.id, 'member_create', id, role, now);
  return { ok: true, member: publicMember(m), link: memberLink(key) };
}

/** 重發個人連結：舊連結立刻失效（連結外流、換人時用），LINE 綁定也要重綁。 */
export async function resetMemberKey(actor, id, { now = Date.now() } = {}) {
  const m = (await loadMembers({ fresh: true })).find((x) => x.id === id);
  if (!m) return { ok: false, status: 404, error: '找不到這位成員' };
  const key = makeMemberKey();
  const next = { ...m, key_hash: hashKey(key), line_user_id: '', updated_at: nowIso(now) };
  await db().updateRange(`b2b_members!A${m._row}:K${m._row}`, [memberToRow(next)]);
  memberCache = { rows: null, expiry: 0 };
  await audit(actor.member.id, 'member_reset_link', m.id, '', now);
  return { ok: true, link: memberLink(key) };
}

/** 米亞收到「#業務 M7K3Q-檢查碼」：把這個 LINE 帳號記成那位成員的通知對象。 */
export async function bindMemberLine(memberId, check, lineUserId, { now = Date.now() } = {}) {
  const m = (await loadMembers({ fresh: true })).find((x) => x.id === String(memberId || '').toUpperCase() && x.status === 'active');
  if (!m || !safeEqual(String(check || '').toUpperCase(), memberBindCheck(m))) return { ok: false };
  if (m.line_user_id === lineUserId) return { ok: true, already: true, member: m };
  const next = { ...m, line_user_id: lineUserId, updated_at: nowIso(now) };
  await db().updateRange(`b2b_members!A${m._row}:K${m._row}`, [memberToRow(next)]);
  memberCache = { rows: null, expiry: 0 };
  await audit(m.id, 'line_bind', m.id, '', now);
  return { ok: true, member: next };
}

// ── 後台：設定與稽核（只有管理員）────────────────────────────────────
export async function saveSettings(actor, patch, { now = Date.now() } = {}) {
  const cur = await loadSettings({ fresh: true });
  const rows = await db().readRange(RANGE.settings);
  const changed = [];
  for (const key of SETTING_KEYS) {
    if (patch[key] === undefined) continue;
    let value = key === 'privacy' || key === 'topics' ? cleanMultiline(patch[key], 3000) : cleanText(patch[key], 40);
    if (key === 'sla_days') value = String(slaDays({ sla_days: value }));
    if (key === 'line_push_limit') value = String(pushLimit({ line_push_limit: value }));
    if (key === 'intake_open') value = value === '0' ? '0' : '1';
    if (value === cur[key]) continue;
    const idx = rows.findIndex((r) => r[0] === key);
    const row = [key, value, nowIso(now), actor.member.id];
    if (idx === -1) { await db().appendRows('b2b_settings!A:D', [row]); rows.push(row); }
    else await db().updateRange(`b2b_settings!A${idx + 2}:D${idx + 2}`, [row]);
    changed.push(key);
  }
  settingsCache = { value: null, expiry: 0 };
  if (changed.length) await audit(actor.member.id, 'settings', '', changed.join('、'), now);
  return { ok: true, changed };
}
export async function listAudit(limit = 300) {
  await ensureB2BSheets();
  return (await db().readRange(RANGE.audit)).slice(-limit).reverse()
    .map((r) => ({ at: r[0] || '', actor: r[1] || '', action: r[2] || '', target: r[3] || '', detail: r[4] || '' }));
}

// ── 排程：期限提醒（每個工作天早上一次，Vercel Cron → lib/b2b-api.js b2b_cron）──────────
const SLA_LIST_MAX = 15; // 一則訊息最多列幾個編號，其餘寫「還有 N 筆」
function slaMessage(slot, today) {
  const date = (q) => shortTime(q.due_at).slice(0, 10);
  const list = (items, fmt) => [...items.slice(0, SLA_LIST_MAX).map(fmt), ...(items.length > SLA_LIST_MAX ? [`…還有 ${items.length - SLA_LIST_MAX} 筆，請看收件匣`] : [])];
  const lines = [`⏰ 合作洽詢已過聯繫期限（${today}）`];
  if (slot.own.length) lines.push('', `您承辦的 ${slot.own.length} 筆：`, ...list(slot.own, ({ q }) => `・${q.id}（期限 ${date(q)}）`));
  if (slot.watch.length) lines.push('', `請管理員留意的 ${slot.watch.length} 筆：`, ...list(slot.watch, ({ q, owner }) => `・${q.id}（承辦：${owner ? owner.name : '未分派'}，期限 ${date(q)}）`));
  const all = [...slot.own, ...slot.watch];
  lines.push('', all.length === 1 ? inquiryLink(all[0].q.id) : B2B_PAGE());
  return lines.join('\n');
}

/**
 * 待聯繫、已過期限的每一筆：提醒承辦人（沒有承辦人就提醒管理員）；過期超過一個工作天，管理員也收到。
 * 同一筆同一天只提醒一次（last_reminded），排程重跑、手動補跑都不會洗版。
 *
 * **每個人一天只收一則**（這次要提醒的編號全部列在同一則），Sheets 也整批寫（提醒日期一次寫回、稽核一次加多列、
 * 推播額度一次拿）：業發處積了 30 筆沒處理的時候，一筆一則就是每天早上幾十則推播、上百次 Sheets 呼叫——
 * 推播額度跟記者那邊共用、Sheets 每分鐘的額度也是同一個服務帳號（朱朱 10/8：不要影響既有的功能與媒體之使用）。
 */
export async function runSlaCheck({ now = Date.now() } = {}) {
  if (!b2bConfigured()) return { skipped: 'not_configured' };
  await ensureB2BSheets();
  const [raw, members] = await Promise.all([db().readRange(RANGE.inquiries), loadMembers({ fresh: true })]);
  const today = taipeiDate(now);
  const admins = members.filter((m) => m.role === 'admin' && m.status === 'active');
  const slots = new Map(); // 成員 id → { member, own: [{q}], watch: [{q, owner}] }
  const slotOf = (m) => { if (!slots.has(m.id)) slots.set(m.id, { member: m, own: [], watch: [] }); return slots.get(m.id); };
  const remindedRows = new Set();
  const auditRows = [];
  let escalated = 0;
  raw.forEach((r, i) => {
    const q = inquiryFromRow(r, i);
    if (!q.id || q.status !== 'new' || q.last_reminded === today) return;
    const due = isoMs(q.due_at);
    if (Number.isNaN(due) || now <= due) return;
    const owner = members.find((m) => m.id === q.owner && m.status === 'active');
    const late = businessDaysBetween(due, now);
    const notified = [];
    if (owner) { slotOf(owner).own.push({ q }); notified.push(owner.id); }
    if (!owner || late >= 1) {
      for (const a of admins) if (a !== owner) { slotOf(a).watch.push({ q, owner }); notified.push(a.id); }
      if (owner) escalated++;
    }
    remindedRows.add(q._row);
    auditRows.push(['system', 'sla_remind', q.id, `逾期 ${late} 個工作天；通知 ${notified.join(',') || '—'}`]);
  });
  if (!remindedRows.size) return { reminded: 0, escalated: 0, notified: 0 };

  // 提醒日期一次寫回：只寫 R 欄、從第一筆到最後一筆那一段，中間沒提醒的照讀到的值寫回。R 欄的值只有排程會改
  // （後台改單筆時整列寫回，R 欄是原值照抄），所以寫回讀到的值不會蓋掉別人剛改的東西。
  const rows = [...remindedRows].sort((a, b) => a - b);
  const first = rows[0], last = rows[rows.length - 1];
  const col = [];
  for (let row = first; row <= last; row++) col.push([remindedRows.has(row) ? today : String((raw[row - 2] || [])[17] ?? '')]);
  await db().updateRange(`b2b_inquiries!R${first}:R${last}`, col);

  // 推播：每人一則。額度一次拿，不夠的話承辦人優先（要動手的是他們），沒推到的記稽核
  const targets = [...slots.values()].filter((x) => reachable(x.member)).sort((a, b) => Number(!a.own.length) - Number(!b.own.length));
  let grant = 0;
  try { grant = await takePushQuota(now, targets.length); }
  catch (e) { console.error('[b2b] 推播額度讀不到，今天的提醒先不推:', e.message); }
  let notified = 0;
  for (const [k, x] of targets.entries()) {
    if (k < grant) { if (await pushTo(x.member, slaMessage(x, today))) notified++; }
    else auditRows.push(['system', 'notify_skipped', x.member.id, '本月 LINE 推播額度已用完（期限提醒）']);
  }
  await auditMany(auditRows, now);
  return { reminded: remindedRows.size, escalated, notified };
}
