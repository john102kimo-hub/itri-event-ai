// 在 LINE 直接改活動資料（批次 78，職員模式第三批）。
//
// 朱朱的決定（LINE-PLAN.md 批次 76）：
//   ① LINE 上可以改的只有名稱、日期、時間、地點、新聞聯絡人
//   ② 可以在 LINE 發布（先過檢查清單、再按確認）
//   ⑤ 職員不分「可以改／只能看」→ 所以每次修改都要留紀錄、並通知 LINE_ADMIN_USER_ID
//
// ⚠️ 這是整個職員模式第一次**寫入記者看得到的資料**。CLAUDE.md 第 2 條：模型只負責
// 「聽懂要改哪一場的哪一欄、改成什麼」，能不能寫、寫什麼，全部由這支程式決定：
//   - 欄位白名單（模型說要改知識庫也沒有路可以走）
//   - 每一欄自己的格式檢查（日期一定是存在的 YYYY-MM-DD）
//   - 一定先給人看「改前 → 改後」、按確認才寫
//   - 寫之前再讀一次最新的值，跟提案時的「改前」不一樣就不寫（別人剛改過）

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { strictIsoDate, dateWithWeekday } from './staff.js';
import { eventDateOf } from './event-status.js';

// 欄位 → events 表的欄。status 不開放給同仁直接改，只給「發布」與「復原」內部使用。
export const EDIT_FIELDS = {
  name:          { col: 'B', idx: 1,  label: '名稱',       max: 100 },
  date:          { col: 'F', idx: 5,  label: '日期' },
  time:          { col: 'L', idx: 11, label: '時間',       max: 30 },
  venue:         { col: 'M', idx: 12, label: '地點',       max: 100 },
  press_contact: { col: 'O', idx: 14, label: '新聞聯絡人', max: 100 }
};
const STATUS_FIELD = { col: 'E', idx: 4, label: '狀態' };
export const USER_EDITABLE = Object.keys(EDIT_FIELDS);

const fieldMeta = key => EDIT_FIELDS[key] || (key === 'status' ? STATUS_FIELD : null);
export const fieldLabel = key => fieldMeta(key)?.label || key;

const STATUS_TEXT = { draft: '未發布', active: '進行中', ended: '已結束', archived: '已封存' };

// 給人看的值：日期帶星期幾、空的寫「（空白）」、狀態寫中文
export function displayValue(field, v) {
  const s = String(v ?? '').trim();
  if (field === 'date') return eventDateOf(s) ? dateWithWeekday(eventDateOf(s)) : '未定';
  if (field === 'status') return STATUS_TEXT[s] || s;
  return s || '（空白）';
}

// 把模型給的值整理成要寫進表的值。回傳 { ok, value } 或 { ok:false, reason }。
export function normalizeValue(field, raw) {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (field === 'status') {
    return ['draft', 'active'].includes(v) ? { ok: true, value: v } : { ok: false, reason: '狀態只能是未發布或進行中' };
  }
  const meta = EDIT_FIELDS[field];
  if (!meta) return { ok: false, reason: '這一欄不能在 LINE 上改' };
  if (field === 'date') {
    const d = strictIsoDate(v);
    return d ? { ok: true, value: d } : { ok: false, reason: '日期看不懂，請用「10/28」或「2026-10-28」這種寫法再說一次' };
  }
  if (!v) return { ok: false, reason: `${meta.label}不能是空的` };
  if (v.length > meta.max) return { ok: false, reason: `${meta.label}太長了（上限 ${meta.max} 字）` };
  return { ok: true, value: v };
}

// ── 修改紀錄（event_changes 分頁）─────────────────────────────────────
// 用 append-only 的一張表：誰、何時、哪一場、哪一欄、改前、改後。同時是
// 「復原上一個修改」的資料來源，密語外流被亂改時也查得到是哪個 LINE 帳號。
const CHANGES_HEADER = ['時間', 'LINE ID', '姓名', '活動 id', '活動名稱', '欄位', '改前', '改後', '來源'];
let changesEnsured = false;
async function ensureChangesSheet() {
  if (changesEnsured) return;
  try { await ensureSheets({ event_changes: CHANGES_HEADER }); changesEnsured = true; }
  catch (e) { console.error('ensureSheets(event_changes) 失敗:', e.message); }
}

async function logChange(entry) {
  await ensureChangesSheet();
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  try {
    await appendRows('event_changes!A:I', [[
      now, entry.userId, entry.userName || '', entry.eventId, entry.eventName,
      entry.field, entry.before, entry.after, entry.source || 'line'
    ]]);
  } catch (e) {
    // 紀錄寫不進去不能讓已經寫好的修改變成「失敗」——資料已經改了，回報失敗只會讓人再改一次
    console.error('寫入 event_changes 失敗:', e.message);
  }
}

// 這個人最近一筆修改（復原用）。只找自己改的，不能復原別人的。
export async function findLastChangeBy(userId) {
  let rows = [];
  try { rows = await readRange('event_changes!A2:I'); } catch { return null; }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r[1] === userId && fieldMeta(r[5])) {
      return { eventId: r[3], eventName: r[4], field: r[5], before: r[6] ?? '', after: r[7] ?? '' };
    }
  }
  return null;
}

// ── 提案與套用 ─────────────────────────────────────────────────────────
// 讀最新的一列（不吃任何快取）——提案跟套用都要看到當下真正的值。
async function freshRow(eventId) {
  const rows = await readRange('events!A2:R');
  const idx = rows.findIndex(r => r[0] === eventId);
  return idx === -1 ? null : { row: rows[idx], rowNumber: idx + 2, rows };
}

// 檢查能不能改、算出改前改後。回傳 { ok, proposal } 或 { ok:false, reason }。
// proposal = { eventId, eventName, field, before, after }
// raw：復原用——改回「原本存的那個值」，不再做格式整理（原本可能就是空白或舊格式）。
export async function proposeChange(eventId, field, rawValue, { raw = false } = {}) {
  const meta = fieldMeta(field);
  if (!meta) return { ok: false, reason: '這一欄不能在 LINE 上改。新聞稿、邀請函、照片請到編輯頁改。' };
  const norm = raw ? { ok: true, value: String(rawValue ?? '') } : normalizeValue(field, rawValue);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  const found = await freshRow(eventId);
  if (!found) return { ok: false, reason: '找不到這場活動，可能剛被改名或刪掉了。' };
  const { row, rows } = found;
  if (row[4] === 'archived') return { ok: false, reason: '這場已經封存了，要改請到後台。' };
  const before = String(row[meta.idx] ?? '');
  const same = raw ? before === norm.value
    : field === 'date' ? eventDateOf(before) === norm.value : before.trim() === norm.value;
  if (same) return { ok: false, reason: `《${row[1]}》的${meta.label}本來就是「${displayValue(field, norm.value)}」，不用改。` };
  if (field === 'name' && rows.some(r => r[0] !== eventId && String(r[1] || '').trim() === norm.value)) {
    return { ok: false, reason: `已經有另一場叫「${norm.value}」了，換個名字才分得出來。` };
  }
  return { ok: true, proposal: { eventId, eventName: row[1] || '', field, before, after: norm.value } };
}

// 按了確認之後真的寫進去。寫之前再讀一次：值跟提案時不一樣，代表這段時間有人改過，
// 不能拿舊的提案蓋掉別人的修改。
export async function applyChange(proposal, { userId, userName, source = 'line' } = {}) {
  const meta = fieldMeta(proposal.field);
  if (!meta) return { ok: false, reason: '這一欄不能在 LINE 上改。' };
  const found = await freshRow(proposal.eventId);
  if (!found) return { ok: false, reason: '找不到這場活動，可能剛被改名或刪掉了。' };
  const current = String(found.row[meta.idx] ?? '');
  if (current !== proposal.before) {
    return { ok: false, reason: `《${found.row[1]}》的${meta.label}剛剛被改成「${displayValue(proposal.field, current)}」了，我沒有動它。要改的話請再說一次。` };
  }
  await updateRange(`events!${meta.col}${found.rowNumber}`, [[proposal.after]]);
  await logChange({
    userId, userName, eventId: proposal.eventId,
    eventName: proposal.field === 'name' ? proposal.after : proposal.eventName,
    field: proposal.field, before: proposal.before, after: proposal.after, source
  });
  return { ok: true };
}

// ── 從 LINE 傳來的照片，接在 H 欄（images）後面（批次 79）──────────────────
// 不經過 proposeChange()：照片是「加」不是「改」，不會蓋掉任何既有內容；要拿掉請到編輯頁。
// 一樣留修改紀錄（欄位記成 images_add，「復原上一個修改」刻意不處理它——復原照片等於
// 刪檔，那是編輯頁的事）。回傳 { ok, total, eventName } 或 { ok:false, reason }。
export async function appendEventPhotos(eventId, urls, { userId, userName } = {}) {
  if (!urls.length) return { ok: false, reason: '沒有照片可以加。' };
  const found = await freshRow(eventId);
  if (!found) return { ok: false, reason: '找不到這場活動，可能剛被改名或刪掉了。' };
  if (found.row[4] === 'archived') return { ok: false, reason: '這場已經封存了，不能再加照片。' };
  const before = String(found.row[7] || '').trim();
  const after = [before, ...urls].filter(Boolean).join('\n');
  await updateRange(`events!H${found.rowNumber}`, [[after]]);
  await logChange({
    userId, userName, eventId, eventName: found.row[1] || '',
    field: 'images_add', before: '', after: urls.join('\n')
  });
  return { ok: true, total: after.split('\n').filter(Boolean).length, eventName: found.row[1] || '' };
}
