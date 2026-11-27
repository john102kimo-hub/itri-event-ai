// 記者名單健檢 API
//
// 背景：記者主檔累積 1,470 筆，但 88% 沒有「路線」欄位，且不知道誰已經離職／轉線——
// 這份資料只有這個平台上大家都能連到，同仁才有辦法幫忙補。
//
// ── 同仁（用團隊共用連結的 code，不需管理員密碼）────────────────────────
// GET  ?action=list&code=xxx[&filter=pending|nobeat&outlet=&size=] → 待確認名單（看得到本人活動紀錄的自動算確認過，批次 212）
//      同一個回應裡的 suggestions＝跟活動報名、活動問答比對出來、建議修改名單的項目（批次 212；同仁看到的 mail／電話遮一半）
// POST {action:'sync_apply',code,keys}  → 批次套用建議（伺服器重算一次，只收 key，不收前端送來的值；同仁換 mail 仍要管理員核准）
// POST {action:'sync_dismiss',code,keys}→ 批次忽略建議
// POST {action:'batch',code,ids,op,beat?} → 批次確認在職／標離職／恢復在職／設路線（不含刪除，批次 212）
// GET  ?action=search&code=xxx&q=xxx   → 搜尋特定記者（辦活動前先查）
// POST {action:'update',code,id,...}   → 一鍵更新：補路線／標記離職／標記仍在職
// POST {action:'add',code,name,outlet,email,beat?,phone?,title?} → 新增一位記者（批次 137，不用編 id、不用貼 CSV）
// POST {action:'card_scan',code,image}  → 名片翻拍：AI 讀出姓名／媒體／mail／電話，並比對名單裡是不是已經有這個人（批次 140）
// POST card_match（不呼叫 AI）           → 同仁改過讀出來的欄位後，重新比對一次
// GET  ?action=watch_cron              → 排程（Vercel Cron，Bearer CRON_SECRET）：每月抽一批主流媒體記者查原媒體署名，查到的自動算確認（見 lib/media-tracker.js）
// POST {action:'update_contact',code,id,name?,outlet?,email?,phone?,title?,mark?} → 用名片上的新資料更新既有記者（批次 140）
//                                        同仁要「換掉」既有的 mail 不會直接生效，先排進 media_mail_requests 等管理員核准（批次 145）
//
// ── 管理員（需 ADMIN_PASSWORD）───────────────────────────────────────
// POST {action:'seed',password,csv}    → 貼上 CSV 一次性匯入／更新（用 id 對應，重覆貼不會炸掉）
// POST {action:'settings_save',password,revoke?,regenerate?} → 產生／收回同仁連結的 code
// GET  ?action=export                  → 匯出全部名單 CSV（管理員，header X-Admin-Password）
// GET  ?action=pick&beat=&outlet=&recent=1&size=50 → 挑收件人：照路線／媒體／最近受邀篩出有 mail 的在職記者，
//                                        mail 串成 Outlook 收件人欄的格式並分批（管理員，批次 137）
// GET  ?action=export_outlook&…(同 pick) → 挑出來的人匯成 Outlook 通訊錄／合併郵件用的 CSV（管理員，批次 137）
// GET  ?action=mail_requests             → 同仁送來、等核准的 mail 修改（管理員，批次 145）
// POST {action:'mail_request_decide',id,approve} → 核准（真的換 mail）或不核准（管理員，批次 145）
//
// 誠實邊界：這裡不猜記者現在跑什麼路線，也不推測誰離職了。看得到本人活動紀錄（報名、提問、原媒體署名）
// 或一年內受邀、確認過的不用管；剩下拿不準的才排進待確認讓人判斷。名單內容只有人按了才會改。

import { timingSafeEqual } from 'node:crypto';
import { readRange, appendRows, updateRange, updateRanges, ensureSheets } from '../lib/sheets.js';
import { buildSync, loadSyncSources, resetSyncCache, DISMISS_SHEET } from '../lib/media-sync.js';
import { adminAttempt, requireAdmin, passwordFrom, codeMatches, authFailed } from '../lib/auth.js';
import { generateShareCode } from '../lib/ids.js';
import { pickRecipients, toBatches, clampBatchSize, buildOutlookCsv, csvCell, normalizeEmail, nextRosterId, BEATS } from '../lib/media-pick.js';
import { parseImageInput, scanCard, matchRoster, diffCard, cleanPhone, maskEmail, maskPhone } from '../lib/card-scan.js';
import { createLimiter, clientIp } from '../lib/rate-limit.js';

const SHEETS = {
  media_roster: [
    'id', 'name', 'outlet', 'beat', 'email', 'phone',
    'invited_count', 'confirmed_count', 'declined_count', 'last_invited',
    'status', 'note', 'updated_at', 'updated_by',
  ],
  media_settings: ['key', 'value'],
  // 同仁送來、等管理員核准的 mail 修改（批次 145）。status：open／approved／rejected
  media_mail_requests: ['id', 'requested_at', 'roster_id', 'name', 'outlet', 'old_email', 'new_email', 'requested_by', 'status', 'decided_at'],
};
const MAIL_REQ_RANGE = 'media_mail_requests!A2:J';
const parseMailReq = (r, i) => ({
  rowNum: i + 2, id: r[0] || '', requested_at: r[1] || '', roster_id: r[2] || '', name: r[3] || '', outlet: r[4] || '',
  old_email: r[5] || '', new_email: r[6] || '', requested_by: r[7] || '', status: r[8] || 'open', decided_at: r[9] || '',
});

const STALE_DAYS = 365;
const BATCH_SIZE = 25;
const STAFF_BATCH_MAX = 200;

const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

async function safeRead(range) {
  try { return await readRange(range); } catch { return []; }
}

// 設定快取 60 秒（批次 116）。以前是「這台機器讀過一次就永遠不再讀」：後台按「收回共用連結」
// 只改得到按的那一台，其他還熱著的機器照樣放行舊連結，直到它們自己冷啟動——收回等於沒收回。
// 跟活動表快取同一個尺度：別台最多晚一分鐘生效。讀不到時沿用手上的值，不要因為一次 Sheets 逾時把連結全關掉。
const SETTINGS_TTL_MS = 60_000;
const CFG = { staffCode: null, loadedAt: 0 };
async function loadSettings() {
  if (CFG.loadedAt && Date.now() - CFG.loadedAt < SETTINGS_TTL_MS) return CFG;
  try {
    const rows = await readRange('media_settings!A2:B');
    CFG.staffCode = null;
    rows.forEach(([k, v]) => { if (k === 'staff_code') CFG.staffCode = String(v || '').trim() || null; });
  } catch { /* 分頁還沒建、或暫時讀不到：沿用手上的 */ }
  CFG.loadedAt = Date.now();
  return CFG;
}
async function saveSetting(key, value) {
  await ensureSheets(SHEETS);
  const rows = await safeRead('media_settings!A2:B');
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) await updateRange(`media_settings!A${idx + 2}:B${idx + 2}`, [[key, value]]);
  else await appendRows('media_settings!A:B', [[key, value]]);
}

// 名片辨識每次都是一次付費的 AI 呼叫，而同仁共用連結是設計成會外流的（見 authorize()）。
// 跟其他限流一樣是 best-effort（單一 instance 的記憶體）；真正的上限是 Anthropic Console 的月花費上限。
const scanLimiter = createLimiter({ windowMs: 10 * 60_000, max: 40 });

// 名片比對結果。同仁（共用連結）看到的「名單裡已有的 mail／電話」遮一半：認得出是不是同一個人，但抄不走
// （批次 137：mail 是個資，連結外流不能撈走整份名單）。管理員看全部。
function describeMatches(rows, card, isAdmin) {
  return matchRoster(rows, card).map(({ rec, reason }) => {
    const m = (field, v) => (isAdmin ? v : field === 'email' ? maskEmail(v) : field === 'phone' ? maskPhone(v) : v);
    return {
      id: rec.id, reason, status: rec.status,
      name: rec.name, outlet: rec.outlet, beat: rec.beat,
      email: m('email', rec.email), phone: m('phone', rec.phone),
      changes: diffCard(rec, card).map((c) => ({ field: c.field, from: m(c.field, c.from), to: c.to })),
    };
  });
}

const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

function parseRow(r, i) {
  return {
    rowNum: i + 2,
    id: r[0] || '', name: r[1] || '', outlet: r[2] || '', beat: r[3] || '',
    email: r[4] || '', phone: r[5] || '',
    invited_count: Number(r[6]) || 0, confirmed_count: Number(r[7]) || 0, declined_count: Number(r[8]) || 0,
    last_invited: r[9] || '', status: r[10] || 'active', note: r[11] || '',
    updated_at: r[12] || '', updated_by: r[13] || '',
  };
}

// 最近一次有人確認（按「還在跑，資料正確」、恢復在職）是幾天前。updated_at 是 now() 寫的
// 「2026/10/11 14:30:00」；讀不出來就當作沒確認過。
function confirmedDaysAgo(rec) {
  const m = String(rec.updated_at || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
}

/** 需要人工確認「還在不在職」：拿得到本人活動紀錄的、一年內確認過或受邀過的，都不列 */
// 批次 124：一年內有人確認過的不再列進來（不然確認了等於白做）。
// 批次 212：①看得到本人最近的活動紀錄（verified，lib/media-sync.js）就算確認過，不丟給人點；
//   ②「沒有路線」不再算待確認——88% 的名單沒填路線，混在一起待確認永遠清不完。缺路線另外一個篩選、批次設定。
function needsReview(rec, verified = new Map()) {
  if (rec.status === 'left') return false;
  if (verified.has(rec.id)) return false;
  const c = confirmedDaysAgo(rec);
  if (c !== null && c <= STALE_DAYS) return false;
  const d = daysSince(rec.last_invited);
  if (d === null) return true;
  return d > STALE_DAYS;
}

/** 名單＋同步來源 → 待確認、自動確認、建議修改。名單頁與盤查共用同一套，兩邊的數字才會一致。 */
async function syncState(rows, { fresh = false } = {}) {
  const { loadWatch } = await import('../lib/media-tracker.js');
  const [watch, sources] = await Promise.all([loadWatch(), loadSyncSources({ fresh })]);
  const sync = buildSync({ roster: rows, watch, ...sources });
  // 換媒體的建議排在同步區處理，同一個人不要在待確認又出現一次
  const moving = new Set(sync.suggestions.filter((s) => s.type === 'outlet').map((s) => s.rosterId));
  const pending = rows.filter((r) => needsReview(r, sync.verified) && !moving.has(r.id)).sort((a, b) => priority(b) - priority(a));
  return { ...sync, watch, pending, failed: sources.failed };
}

const rowOf = (r) => [r.id, r.name, r.outlet, r.beat, r.email, r.phone, r.invited_count, r.confirmed_count, r.declined_count, r.last_invited, r.status, r.note, r.updated_at, r.updated_by];
// 只寫有改到的那幾列，一次送出
const writeRows = (recs) => (recs.length ? updateRanges(recs.map((r) => ({ range: `media_roster!A${r.rowNum}:N${r.rowNum}`, values: [rowOf(r)] }))) : null);
const newMailReqId = (reqs, offset) => 'M' + String(reqs.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1 + offset).padStart(4, '0');

// 建議項目給畫面用的樣子。同仁（共用連結）看到的 mail／電話遮一半，跟名片比對同一條規矩（批次 137）
function publicSuggestion(s, isAdmin) {
  const mask = (v) => (isAdmin || !v ? v : String(v).includes('@') ? maskEmail(v) : maskPhone(v));
  const contact = s.type === 'email' || s.type === 'phone';
  return {
    key: s.key, type: s.type, safe: s.safe, id: s.rosterId, name: s.name, outlet: s.outlet,
    from: contact ? mask(s.from) : s.from || '', to: contact ? mask(s.to) : s.to || '',
    email: mask(s.email || ''), phone: mask(s.phone || ''), evidence: s.evidence,
    needsAdmin: !isAdmin && s.type === 'email' && !!s.from,
  };
}

/** 套用勾選的建議。值一律用伺服器剛算出來的，不收前端送來的內容。 */
async function applySuggestions(keys, { isAdmin, by }) {
  await ensureSheets(SHEETS);
  const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗就停，不能拿空名單去比對、編 id
  const { suggestions, failed } = await syncState(rows, { fresh: true });
  if (failed.length) throw new Error(`暫時讀不到${failed.join('、')}，請稍後再試`);
  const want = new Set(keys);
  const picked = suggestions.filter((s) => want.has(s.key));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const emails = new Map(rows.filter((r) => normalizeEmail(r.email)).map((r) => [normalizeEmail(r.email), r]));
  const ids = rows.map((r) => r.id);
  const changed = new Set(), added = [], requests = [], skipped = [];
  let reqs = null, applied = 0;
  const stamp = now();
  const touch = (rec) => { rec.updated_at = stamp; rec.updated_by = by; changed.add(rec); };
  for (const s of picked) {
    if (s.type === 'new') {
      if (s.email && emails.has(s.email)) { skipped.push(`${s.name}：這個 mail 已經在名單裡`); continue; }
      const id = nextRosterId(ids);
      ids.push(id);
      const row = [id, s.name.slice(0, 40), s.outlet.slice(0, 60), '', s.email || '', s.phone || '', 0, 0, 0, '', 'active', '', stamp, by];
      added.push(row);
      if (s.email) emails.set(s.email, { id });
      applied++;
      continue;
    }
    const rec = byId.get(s.rosterId);
    if (!rec) { skipped.push(`${s.name}：名單裡找不到了`); continue; }
    if (s.type === 'outlet' || s.type === 'outlet_maybe') {
      if (!rec.note) rec.note = `原媒體：${rec.outlet}`;
      rec.outlet = s.to.slice(0, 60);
      rec.status = 'active';
      // 同名不同單位那一類：換媒體通常連 mail 一起換，但 mail 另有核准規矩，這裡只改媒體
      touch(rec);
    } else if (s.type === 'restore' || s.type === 'restore_news') {
      rec.status = 'active';
      touch(rec);
    } else if (s.type === 'phone') {
      if (rec.phone) continue;
      rec.phone = s.to;
      touch(rec);
    } else if (s.type === 'email') {
      const dup = emails.get(s.to);
      if (dup && dup.id !== rec.id) { skipped.push(`${s.name}：這個 mail 已經是另一位的了`); continue; }
      if (!isAdmin && normalizeEmail(rec.email)) {
        // 批次 145：同仁要換掉既有的 mail 一律排進核准清單
        if (!reqs) reqs = (await readRange(MAIL_REQ_RANGE)).map(parseMailReq);
        if (!reqs.some((x) => x.status === 'open' && x.roster_id === rec.id && normalizeEmail(x.new_email) === s.to)) {
          requests.push([newMailReqId(reqs, requests.length), stamp, rec.id, rec.name, rec.outlet, rec.email, s.to, by, 'open', '']);
        }
        continue;
      }
      rec.email = s.to;
      emails.set(s.to, rec);
      touch(rec);
    }
    applied++;
  }
  await writeRows([...changed]);
  if (added.length) await appendRows('media_roster!A:N', added);
  if (requests.length) await appendRows('media_mail_requests!A:J', requests);
  return { success: true, applied, pending_email: requests.length, skipped, missing: want.size - picked.length };
}

function priority(rec) {
  // 受邀次數愈多、代表這筆資料愈重要（該優先花時間確認）
  let score = rec.invited_count * 10;
  if (!rec.beat) score += 5;
  const d = daysSince(rec.last_invited);
  if (d !== null) score += Math.min(d / 30, 24); // 愈久沒受邀分數愈高，封頂 24 個月
  return score;
}

async function authorize({ code, password }, req) {
  // 批次 116：先看限流、密碼帶錯也記失敗（見 lib/auth.js adminAttempt()）
  const who = adminAttempt(req, password);
  if (who === 'blocked') return { ok: false, status: 429, msg: '嘗試的次數太多了，請 10 分鐘後再試。' };
  if (who === 'admin') return { ok: true, who: 'admin' };
  await loadSettings();
  if (!CFG.staffCode) {
    if (code) authFailed(req);
    return { ok: false, status: 401, msg: '這個功能還沒開放共用連結，請向承辦人索取' };
  }
  if (!codeMatches(code, CFG.staffCode)) {
    authFailed(req);
    return { ok: false, status: 401, msg: '這條連結已失效，請向承辦人索取新的' };
  }
  return { ok: true, who: 'staff' };
}

// CSV 公式注入防護（批次 116）住在 lib/media-pick.js 的 csvCell()（批次 137 搬過去，匯出名單與 Outlook CSV 共用同一支）。

/** 極簡 CSV 解析：逗號分隔、雙引號括住可含逗號的欄位。給管理員一次性貼資料用，不追求處理所有 Excel 怪狀況。 */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 排程：主流媒體記者署名查證。跟 api/line.js 的排程入口同一條規矩：一定要帶 CRON_SECRET，
    // 沒設定就一律拒絕（這個入口會打外部網站、寫試算表）。
    if (req.method === 'GET' && req.query?.action === 'watch_cron') {
      const secret = process.env.CRON_SECRET;
      const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(bearer), b = Buffer.from(secret || '');
      if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
      const { runWatchCron } = await import('../lib/media-tracker.js');
      return res.status(200).json(await runWatchCron());
    }

    await loadSettings();

    if (req.method === 'GET') {
      const { action, code, q } = req.query;
      // 管理員密碼只收 header（批次 110 起不再讀網址）。code 是同仁的共用連結碼，
      // 設計上本來就要能放在網址裡分享，維持走 query。
      const password = passwordFrom(req);

      if (action === 'list') {
        const auth = await authorize({ code, password }, req);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const state = await syncState(rows);
        const active = rows.filter((r) => r.status !== 'left');
        const filter = req.query.filter === 'nobeat' ? 'nobeat' : 'pending';
        const kw = String(req.query.outlet || '').trim().toLowerCase().slice(0, 30);
        const size = Math.min(STAFF_BATCH_MAX, Math.max(BATCH_SIZE, Number(req.query.size) || BATCH_SIZE));
        const noBeat = active.filter((r) => !r.beat).sort((a, b) => priority(b) - priority(a));
        const matched = (filter === 'nobeat' ? noBeat : state.pending)
          .filter((r) => !kw || r.outlet.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw));
        const verified = { total: 0, registration: 0, qa: 0, news: 0 };
        for (const r of active) {
          const v = state.verified.get(r.id);
          if (v) { verified.total++; verified[v.source]++; }
        }

        return res.status(200).json({
          totalActive: active.length,
          totalNeedsReview: state.pending.length,
          totalWithBeat: active.filter((r) => r.beat).length,
          totalNoBeat: noBeat.length,
          verified, unavailable: state.failed,
          // 同步建議跟清單同一次回（批次 212）：分兩支打會把試算表讀兩遍
          suggestionTotal: state.suggestions.length,
          suggestions: state.suggestions.slice(0, 300).map((s) => publicSuggestion(s, auth.who === 'admin')),
          filter, matched: matched.length,
          beats: BEATS,
          showing: Math.min(size, matched.length),
          needsReview: matched.slice(0, size).map((r) => ({
            id: r.id, name: r.name, outlet: r.outlet, beat: r.beat,
            invited_count: r.invited_count, last_invited: r.last_invited,
            daysSince: daysSince(r.last_invited),
            verified: state.verified.get(r.id)?.label || '',
            duplicate: state.duplicates.has(r.id), noEmail: !normalizeEmail(r.email),
          })),
        });
      }

      // 一鍵盤查待確認的記者（批次 192）：回傳要查的 id。管理員專用（查詢會對外查新聞）。
      // 排除：已經自動確認的（不在待確認裡）、姓名不像個人、28 天內查過的。
      if (action === 'pending_ids') {
        if (!requireAdmin(req, res, password)) return;
        const { RECHECK_DAYS } = await import('../lib/media-tracker.js');
        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const state = await syncState(rows);
        const watch = new Map(state.watch.map((w) => [w.id, w]));
        const recent = (id) => {
          const w = watch.get(id);
          // 舊版判出來的 moved 不算「查過」：那個判法有誤，要能重查
          return w?.checked_at && w.verdict !== 'moved' && Date.now() - new Date(w.checked_at).getTime() < RECHECK_DAYS * 86400000;
        };
        const ids = state.pending.filter((r) => r.id && r.name.length >= 2 && r.name.length <= 5 && !recent(r.id)).map((r) => r.id);
        return res.status(200).json({ ids, total: ids.length });
      }

      // 全部名單管理（批次 193）：管理員看得到全部記者（含 mail、電話），可搜尋、篩選、分頁。
      if (action === 'all') {
        if (!requireAdmin(req, res, password)) return;
        const kw = String(q || '').trim().toLowerCase();
        const beat = String(req.query.beat || ''), status = String(req.query.status || 'active');
        const issue = String(req.query.issue || '');
        const size = Math.min(200, Math.max(10, Number(req.query.size) || 50));
        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const dups = issue === 'dup' ? buildSync({ roster: rows }).duplicates : null;
        const hit = rows.filter((r) => (!dups || dups.has(r.id)) && (issue !== 'noemail' || !normalizeEmail(r.email))
          && (!kw || [r.name, r.outlet, r.email, r.phone].some((v) => String(v).toLowerCase().includes(kw)))
          && (!beat || (beat === '__none' ? !r.beat : r.beat === beat))
          && (status === 'all' || (status === 'left' ? r.status === 'left' : r.status !== 'left')));
        if (dups) hit.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')); // 重複的排在一起才看得出來
        const pages = Math.max(1, Math.ceil(hit.length / size));
        const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
        const beatCounts = {};
        rows.filter((r) => r.status !== 'left').forEach((r) => { const k = r.beat || '__none'; beatCounts[k] = (beatCounts[k] || 0) + 1; });
        return res.status(200).json({
          total: hit.length, page, pages, size, all: rows.length, active: rows.filter((r) => r.status !== 'left').length,
          beats: BEATS, beatCounts,
          rows: hit.slice((page - 1) * size, page * size).map((r) => ({
            id: r.id, name: r.name, outlet: r.outlet, beat: r.beat, email: r.email, phone: r.phone,
            status: r.status, invited_count: r.invited_count, last_invited: r.last_invited, note: r.note,
          })),
        });
      }

      if (action === 'search') {
        const auth = await authorize({ code, password }, req);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });
        const kw = String(q || '').trim();
        if (kw.length < 1) return res.status(200).json({ results: [] });
        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const results = rows.filter((r) => r.name.includes(kw) || r.outlet.includes(kw)).slice(0, 20)
          .map((r) => ({
            id: r.id, name: r.name, outlet: r.outlet, beat: r.beat, status: r.status,
            invited_count: r.invited_count, last_invited: r.last_invited,
          }));
        return res.status(200).json({ results });
      }

      if (action === 'export') {
        if (!requireAdmin(req, res, password)) return;
        const rows = await safeRead('media_roster!A2:N');
        const header = SHEETS.media_roster;
        const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="media_roster_${today()}.csv"`);
        return res.status(200).send('﻿' + csv);
      }

      // 挑收件人（批次 137）：mail 是個資，只給管理員；同仁共用連結看不到（連結外流也撈不走整份 mail）。
      if (action === 'pick' || action === 'export_outlook') {
        if (!requireAdmin(req, res, password)) return;
        const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗要報錯，不能當成「沒有人」
        const picked = pickRecipients(rows, {
          beat: String(req.query.beat || ''), outlet: String(req.query.outlet || '').slice(0, 30),
          recentOnly: req.query.recent === '1',
        });
        if (action === 'export_outlook') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="outlook_contacts_${today()}.csv"`);
          return res.status(200).send(buildOutlookCsv(picked.people));
        }
        const size = clampBatchSize(req.query.size);
        return res.status(200).json({
          matched: picked.matched, withoutEmail: picked.withoutEmail, duplicates: picked.duplicates,
          total: picked.people.length, batchSize: size,
          batches: toBatches(picked.people.map((p) => p.email), size),
          people: picked.people,
        });
      }

      // 同仁送來、等核准的 mail 修改（批次 145）：只給管理員（裡面是 mail，個資）
      if (action === 'mail_requests') {
        if (!requireAdmin(req, res, password)) return;
        const reqs = (await safeRead(MAIL_REQ_RANGE)).map(parseMailReq).filter((x) => x.id && x.status === 'open');
        return res.status(200).json({ requests: reqs.map(({ rowNum, ...x }) => x) });
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, code } = body;
      const password = passwordFrom(req);

      if (action === 'settings_save') {
        if (!requireAdmin(req, res, password)) return;
        await ensureSheets(SHEETS);
        if (body.revoke) {
          await saveSetting('staff_code', '');
          CFG.staffCode = null;
          CFG.loadedAt = Date.now();
          return res.status(200).json({ success: true, code: null });
        }
        let c = CFG.staffCode;
        if (!c || body.regenerate) {
          c = generateShareCode(); // 批次 116：密碼學亂數，不用 Math.random()
          await saveSetting('staff_code', c);
          CFG.staffCode = c;
          CFG.loadedAt = Date.now();
        }
        return res.status(200).json({ success: true, code: c });
      }

      if (action === 'seed') {
        if (!requireAdmin(req, res, password)) return;
        const { csv } = body;
        if (!csv || !csv.trim()) return res.status(400).json({ error: '沒有收到 CSV 內容' });
        // 這一批統一的路線（可選）：CSV 沒有 beat 欄、或那一格是空的，就套這個。已經有路線的人不會被改
        // （既有的人工填寫優先，CSV 自己寫的 beat 也優先）。只收選單上那幾個，跟 update 同一條規矩。
        const defaultBeat = String(body.default_beat || '').trim();
        if (defaultBeat && !BEATS.includes(defaultBeat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        await ensureSheets(SHEETS);

        const parsed = parseCsv(csv);
        if (parsed.length < 2) return res.status(422).json({ error: 'CSV 至少要有標題列加一列資料' });
        const header = parsed[0].map((h) => h.trim());
        const idx = (name) => header.indexOf(name);
        const need = ['id', 'name', 'outlet'];
        for (const n of need) {
          if (idx(n) < 0) return res.status(422).json({ error: `CSV 缺少必要欄位：${n}` });
        }

        // ⚠️ 這裡用 readRange，不用 safeRead（批次 82）：safeRead 讀失敗會回空陣列，匯入就會
        // 以為「目前一個記者都沒有」，接著把新名單從第 2 列起整片蓋上去——既有記者的
        // 路線、離職標記、備註全部被別人的資料覆蓋。讀不到就停下來請他再試一次。
        const existing = (await readRange('media_roster!A2:N')).map(parseRow);
        const byId = new Map(existing.map((r) => [r.id, r]));
        let created = 0, updated = 0, defaulted = 0;
        const importedIds = []; // 這一批 CSV 裡的 id，給畫面做匯入後自動盤查

        for (const cells of parsed.slice(1)) {
          const id = cells[idx('id')] || '';
          if (!id) continue;
          importedIds.push(id);
          const incoming = {
            id, name: cells[idx('name')] || '', outlet: cells[idx('outlet')] || '',
            beat: (idx('beat') >= 0 ? cells[idx('beat')] || '' : '') || defaultBeat,
            email: idx('email') >= 0 ? cells[idx('email')] || '' : '',
            phone: idx('phone') >= 0 ? cells[idx('phone')] || '' : '',
            invited_count: idx('invited_count') >= 0 ? Number(cells[idx('invited_count')]) || 0 : 0,
            confirmed_count: idx('confirmed_count') >= 0 ? Number(cells[idx('confirmed_count')]) || 0 : 0,
            declined_count: idx('declined_count') >= 0 ? Number(cells[idx('declined_count')]) || 0 : 0,
            last_invited: idx('last_invited') >= 0 ? cells[idx('last_invited')] || '' : '',
          };
          const prior = byId.get(id);
          // 這一筆最後真的用到「統一路線」（CSV 自己沒寫、名單裡也還沒有路線）才算，回報給畫面
          if (defaultBeat && incoming.beat === defaultBeat && !(prior && prior.beat)) defaulted++;
          if (prior) {
            // 既有的路線／狀態／備註是人工填的，匯入不覆蓋；只補資料本身（受邀次數等）
            byId.set(id, {
              ...prior, ...incoming,
              beat: prior.beat || incoming.beat, status: prior.status, note: prior.note,
            });
            updated++;
          } else {
            byId.set(id, { ...incoming, status: 'active', note: '', updated_at: '', updated_by: '' });
            created++;
          }
        }

        const all = [...byId.values()];
        const rowsOut = all.map((r) => [
          r.id, r.name, r.outlet, r.beat, r.email, r.phone,
          r.invited_count, r.confirmed_count, r.declined_count, r.last_invited,
          r.status, r.note, r.updated_at, r.updated_by,
        ]);
        // 整批覆寫（不用 append，避免同一 id 重複列）。⚠️ 一次寫完，不要「先清空再寫」
        // （批次 82）：兩步寫法在第二步失敗時整份記者名單歸零。現在是新名單補滿、比舊名單
        // 短的部分補空白，同一個 values.update 一起送出，要嘛全部換成新的、要嘛完全沒動。
        const old = await readRange('media_roster!A2:N');
        const height = Math.max(old.length, rowsOut.length);
        const blank = () => new Array(14).fill('');
        const full = [...rowsOut.map((r) => [...r, ...blank()].slice(0, 14)),
          ...Array.from({ length: height - rowsOut.length }, blank)];
        if (height) await updateRange(`media_roster!A2:N${height + 1}`, full);

        return res.status(200).json({ success: true, created, updated, total: all.length, ids: importedIds, ...(defaultBeat ? { default_beat: defaultBeat, defaulted } : {}) });
      }

      // 批次處理（批次 193）：標離職／恢復在職／改路線／刪除。管理員專用。整份一次寫回（跟 seed 同一個理由：
      // 不要「先清空再寫」，兩步寫法在第二步失敗時整份名單歸零）。刪除是真的刪掉那幾列；要保留紀錄請用「標離職」。
      if (action === 'bulk') {
        if (!requireAdmin(req, res, password)) return;
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).slice(0, 1000));
        const op = String(body.op || '');
        if (!ids.size) return res.status(400).json({ error: '沒有選任何記者' });
        if (!['left', 'active', 'beat', 'delete'].includes(op)) return res.status(400).json({ error: '不認得的操作' });
        const beat = String(body.beat || '').trim();
        if (op === 'beat' && beat && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗就停，不要拿空名單去覆蓋
        let n = 0;
        const kept = [];
        for (const r of rows) {
          if (!ids.has(r.id)) { kept.push(r); continue; }
          n++;
          if (op === 'delete') continue;
          if (op === 'left') r.status = 'left'; else if (op === 'active') r.status = 'active'; else r.beat = beat;
          // 批量改路線不算「確認過在職」，不蓋確認時間（批次 212）
          if (op !== 'beat') { r.updated_at = now(); r.updated_by = String(body.updated_by || '').slice(0, 20); }
          kept.push(r);
        }
        const out = kept.map((r) => [r.id, r.name, r.outlet, r.beat, r.email, r.phone, r.invited_count, r.confirmed_count, r.declined_count, r.last_invited, r.status, r.note, r.updated_at, r.updated_by]);
        const height = Math.max(rows.length, out.length), blank = () => new Array(14).fill('');
        if (height) await updateRange(`media_roster!A2:N${height + 1}`, [...out, ...Array.from({ length: height - out.length }, blank)]);
        return res.status(200).json({ success: true, affected: n, total: kept.length });
      }

      // 匯入後自動盤查（批次 191）：管理員，會對外查新聞，所以不開放給同仁連結。一次只做一小批，回 remaining 讓畫面接著打。
      if (action === 'import_check') {
        if (!requireAdmin(req, res, password)) return;
        const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).slice(0, 30)).slice(0, 500) : [];
        if (!ids.length) return res.status(400).json({ error: '沒有要盤查的記者' });
        const { checkImported } = await import('../lib/media-tracker.js');
        return res.status(200).json({ success: true, ...(await checkImported({ ids })) });
      }

      // 核准／不核准同仁送來的 mail 修改（批次 145）
      if (action === 'mail_request_decide') {
        if (!requireAdmin(req, res, password)) return;
        const reqs = (await safeRead(MAIL_REQ_RANGE)).map(parseMailReq); // 分頁還沒建＝沒有這筆
        const q = reqs.find((x) => x.id && x.id === String(body.id || ''));
        if (!q) return res.status(404).json({ error: '找不到這筆申請' });
        if (q.status !== 'open') return res.status(409).json({ error: '這筆已經處理過了' });
        const decide = (status) => updateRange(`media_mail_requests!I${q.rowNum}:J${q.rowNum}`, [[status, now()]]);
        if (!body.approve) { await decide('rejected'); return res.status(200).json({ success: true, status: 'rejected' }); }
        const rows = (await readRange('media_roster!A2:N')).map(parseRow);
        const rec = rows.find((r) => r.id === q.roster_id);
        if (!rec) return res.status(404).json({ error: '名單裡已經找不到這位記者' });
        const email = normalizeEmail(q.new_email);
        const dup = rows.find((r) => r.id !== rec.id && normalizeEmail(r.email) === email);
        if (dup) return res.status(409).json({ error: `這個 mail 已經是另一位的了：${dup.name}（${dup.outlet}）` });
        rec.email = email;
        rec.updated_at = now();
        rec.updated_by = '管理員核准';
        await updateRange(`media_roster!A${rec.rowNum}:N${rec.rowNum}`, [[
          rec.id, rec.name, rec.outlet, rec.beat, rec.email, rec.phone,
          rec.invited_count, rec.confirmed_count, rec.declined_count, rec.last_invited,
          rec.status, rec.note, rec.updated_at, rec.updated_by,
        ]]);
        await decide('approved');
        return res.status(200).json({ success: true, status: 'approved' });
      }

      // ── 以下需要同仁 code 或管理員密碼 ──
      const auth = await authorize({ code, password }, req);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

      // 批次套用／忽略同步建議（批次 212）
      if (action === 'sync_apply' || action === 'sync_dismiss') {
        const keys = (Array.isArray(body.keys) ? body.keys : []).map((k) => String(k)).filter((k) => /^[0-9a-f]{16}$/.test(k)).slice(0, 300);
        if (!keys.length) return res.status(400).json({ error: '沒有勾選任何項目' });
        const isAdmin = auth.who === 'admin';
        const by = String(body.updated_by || '').slice(0, 20) || (isAdmin ? '管理員' : '同仁連結');
        if (action === 'sync_dismiss') {
          await ensureSheets(DISMISS_SHEET);
          await appendRows('media_sync_dismissed!A:C', keys.map((k) => [k, now(), by]));
          resetSyncCache();
          return res.status(200).json({ success: true, dismissed: keys.length });
        }
        return res.status(200).json(await applySuggestions(keys, { isAdmin, by }));
      }

      // 待確認名單的批次處理（批次 212）。同仁本來就能一筆一筆做這幾件事；刪除不在這裡（管理員的 bulk 才有）
      if (action === 'batch') {
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).filter(Boolean));
        const op = String(body.op || '');
        const beat = String(body.beat || '').trim();
        if (!ids.size) return res.status(400).json({ error: '沒有選任何記者' });
        if (ids.size > STAFF_BATCH_MAX) return res.status(400).json({ error: `一次最多 ${STAFF_BATCH_MAX} 位` });
        if (!['confirm', 'left', 'active', 'beat'].includes(op)) return res.status(400).json({ error: '不認得的操作' });
        if (beat && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        if (op === 'beat' && !beat) return res.status(400).json({ error: '請先選路線' });
        const rows = (await readRange('media_roster!A2:N')).map(parseRow);
        const changed = [];
        for (const r of rows) {
          if (!r.id || !ids.has(r.id)) continue;
          if (op === 'confirm' && r.status === 'left') continue; // 確認不能順手把離職的人復活
          if (op === 'beat') r.beat = beat;
          else {
            if (op === 'left') r.status = 'left'; else r.status = 'active';
            if (beat) r.beat = beat;
            r.updated_at = now();
            r.updated_by = String(body.updated_by || '').slice(0, 20);
          }
          changed.push(r);
        }
        await writeRows(changed);
        return res.status(200).json({ success: true, affected: changed.length });
      }

      // 新增一位記者（批次 137）：姓名、媒體、mail 必填，路線選填。id 由系統編（N0001…），不用自己想。
      if (action === 'add') {
        const name = String(body.name || '').trim().slice(0, 40);
        const outlet = String(body.outlet || '').trim().slice(0, 60);
        const beat = String(body.beat || '').trim();
        const rawEmail = String(body.email || '').trim();
        const rawPhone = String(body.phone || '').trim();
        const phone = rawPhone ? cleanPhone(rawPhone) : '';
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (rawPhone && !phone) return res.status(400).json({ error: '電話格式看起來不對，請再確認（至少要有 6 碼數字）' });
        if (!name) return res.status(400).json({ error: '請填記者姓名' });
        if (!outlet) return res.status(400).json({ error: '請填媒體名稱' });
        const email = normalizeEmail(rawEmail);
        if (!email) return res.status(400).json({ error: 'mail 格式看起來不對，請再確認（例如 name@example.com）' });
        if (beat && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        await ensureSheets(SHEETS);
        // 用 readRange、不用 safeRead：讀失敗時 safeRead 回空陣列，會以為名單是空的而編出重複的 id、也查不到重複的 mail
        const existing = (await readRange('media_roster!A2:N')).map(parseRow);
        const dup = existing.find((r) => normalizeEmail(r.email) === email);
        if (dup) {
          return res.status(409).json({
            error: `這個 mail 已經在名單裡了：${dup.name}（${dup.outlet}）${dup.status === 'left' ? '，目前標記為已離職，可以用上面的搜尋找到他再按「恢復在職」' : ''}`,
            duplicate: { id: dup.id, name: dup.name, outlet: dup.outlet, status: dup.status },
          });
        }
        const id = nextRosterId(existing.map((r) => r.id));
        await appendRows('media_roster!A:N', [[
          id, name, outlet, beat, email, phone, 0, 0, 0, '', 'active', title ? `職稱：${title}` : '', now(), String(body.updated_by || '').slice(0, 20),
        ]]);
        return res.status(200).json({ success: true, id });
      }

      // 名片翻拍（批次 140）：照片 → AI 讀出欄位 → 比對名單。這一步**不寫任何東西**，讀出來的只是草稿，
      // 人看過、按了「新增」或「更新」才會走 add／update_contact（那兩條有自己的格式與重複檢查）。
      if (action === 'card_scan') {
        if (scanLimiter.hit(clientIp(req))) return res.status(429).json({ error: '短時間內辨識太多張了，請 10 分鐘後再試，或先手動填寫' });
        const img = parseImageInput(body.image);
        if (img.error) return res.status(400).json({ error: img.error });
        const r = await scanCard(img);
        if (r.error) return res.status(r.status || 422).json({ error: r.error });
        // 比對失敗（Sheets 讀不到）不該讓辨識結果跟著報廢：照片已經花了一次 AI 呼叫，先把草稿給人，比對標成沒做
        let matches = [], matchError = '';
        try { matches = describeMatches((await readRange('media_roster!A2:N')).map(parseRow), r.card, auth.who === 'admin'); }
        catch { matchError = '暫時查不到名單，無法比對是否已經有這位，請稍後按「重新比對」'; }
        return res.status(200).json({ card: r.card, matches, matchError });
      }

      if (action === 'card_match') {
        const card = {
          name: String(body.name || '').trim().slice(0, 40), outlet: String(body.outlet || '').trim().slice(0, 60),
          email: normalizeEmail(body.email), phone: cleanPhone(body.phone),
        };
        const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗要報錯，不能當成「名單裡沒有這個人」
        return res.status(200).json({ matches: describeMatches(rows, card, auth.who === 'admin') });
      }

      // 用名片上的新資料更新既有記者。只動有帶值的欄位（名片上沒有的欄位不會把名單原有的值洗掉）。
      if (action === 'update_contact') {
        const { id, mark } = body;
        if (!id) return res.status(400).json({ error: '缺少記者 ID' });
        const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const outlet = String(body.outlet || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const rawEmail = String(body.email || '').trim();
        const rawPhone = String(body.phone || '').trim();
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const email = rawEmail ? normalizeEmail(rawEmail) : '';
        const phone = rawPhone ? cleanPhone(rawPhone) : '';
        if (rawEmail && !email) return res.status(400).json({ error: 'mail 格式看起來不對，請再確認（例如 name@example.com）' });
        if (rawPhone && !phone) return res.status(400).json({ error: '電話格式看起來不對，請再確認（至少要有 6 碼數字）' });
        if (!name && !outlet && !email && !phone && !title && mark !== 'active') return res.status(400).json({ error: '沒有要更新的內容' });
        await ensureSheets(SHEETS);
        // 用 readRange、不用 safeRead：讀失敗時 safeRead 回空陣列，會變成「找不到這筆」或查不到別人已經用了這個 mail
        const rows = (await readRange('media_roster!A2:N')).map(parseRow);
        const rec = rows.find((r) => r.id === id);
        if (!rec) return res.status(404).json({ error: '找不到這筆記者資料' });
        if (email) {
          const dup = rows.find((r) => r.id !== id && normalizeEmail(r.email) === email);
          if (dup) return res.status(409).json({ error: `這個 mail 已經是另一位的了：${dup.name}（${dup.outlet}），請先確認是不是重複建了兩筆`, duplicate: { id: dup.id, name: dup.name, outlet: dup.outlet, status: dup.status } });
        }
        // 同仁（共用連結）要「換掉」名單裡已經有的 mail：不直接換，排進 media_mail_requests 等管理員核准（批次 145）。
        // 理由：共用連結是設計成會外流的；拿到連結的人若能直接改 mail，邀請函就會被改寄到別人信箱，而且沒人發現。
        // 原本沒有 mail 的，補上就直接生效（之前根本寄不到，沒有可以被搶走的收件人）。
        let pendingEmail = false;
        if (email && auth.who !== 'admin' && normalizeEmail(rec.email) && normalizeEmail(rec.email) !== email) {
          // 用 readRange、不用 safeRead：讀失敗當成「還沒有申請」會編出重複的編號，核准時就可能動到別人那一筆（分頁上面 ensureSheets 已經建好）
          const reqs = (await readRange(MAIL_REQ_RANGE)).map(parseMailReq);
          const already = reqs.some((x) => x.status === 'open' && x.roster_id === rec.id && normalizeEmail(x.new_email) === email);
          if (!already) {
            const nextId = 'M' + String(reqs.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1).padStart(4, '0');
            await appendRows('media_mail_requests!A:J', [[nextId, now(), rec.id, rec.name, rec.outlet, rec.email, email, String(body.updated_by || '').slice(0, 20), 'open', '']]);
          }
          pendingEmail = true;
        }
        if (name) rec.name = name;
        if (outlet) rec.outlet = outlet;
        if (email && !pendingEmail) rec.email = email;
        if (phone) rec.phone = phone;
        if (title && !rec.note) rec.note = `職稱：${title}`; // note 是人工填的，已經有內容就不蓋
        if (mark === 'active') rec.status = 'active';
        rec.updated_at = now();
        rec.updated_by = String(body.updated_by || '').slice(0, 20);
        await updateRange(`media_roster!A${rec.rowNum}:N${rec.rowNum}`, [[
          rec.id, rec.name, rec.outlet, rec.beat, rec.email, rec.phone,
          rec.invited_count, rec.confirmed_count, rec.declined_count, rec.last_invited,
          rec.status, rec.note, rec.updated_at, rec.updated_by,
        ]]);
        return res.status(200).json({ success: true, ...(pendingEmail ? { pending_email: true } : {}) });
      }

      if (action === 'update') {
        const { id, beat, mark, updated_by } = body;
        if (!id) return res.status(400).json({ error: '缺少記者 ID' });
        // 路線只收選單上那幾個（批次 116）：頁面只給這幾顆按鈕，其他值只會是有人直接打 API
        if (beat !== undefined && beat !== '' && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        const rows = await safeRead('media_roster!A2:N');
        const i = rows.findIndex((r) => r[0] === id);
        if (i < 0) return res.status(404).json({ error: '找不到這筆記者資料' });

        const rec = parseRow(rows[i], i);
        if (beat !== undefined) rec.beat = beat;
        if (mark === 'left') rec.status = 'left';
        else if (mark === 'active') rec.status = 'active';
        rec.updated_at = now();
        rec.updated_by = String(updated_by || '').slice(0, 20);

        await updateRange(`media_roster!A${rec.rowNum}:N${rec.rowNum}`, [[
          rec.id, rec.name, rec.outlet, rec.beat, rec.email, rec.phone,
          rec.invited_count, rec.confirmed_count, rec.declined_count, rec.last_invited,
          rec.status, rec.note, rec.updated_at, rec.updated_by,
        ]]);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
