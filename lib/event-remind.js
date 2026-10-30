// 活動前一天提醒（批次 177，每天傍晚由 Vercel Cron 觸發，見 api/line.js 的 cron_remind）。
//
// 朱朱的需求：依時間點跟主辦人要資料。第一階段只做最關鍵的那一則——**活動前一天傍晚**：
// 活動當天 00:00 起米亞自動從邀請函改用新聞稿（lib/prompt.js isPreEventMode），前一天晚上沒貼好，
// 當天一早記者問到的就只有邀請函。
//
// 三條界線（都是推播要算則數、又不能變成騷擾）：
//   ① 沒缺東西就不推（reminderItem() 回 null）。
//   ② 同一場同一個日期只推一次（event_reminders 分頁去重）；一天排兩次 cron，第一次推送失敗第二次補。
//   ③ 每月上限（REMIND_MONTHLY_MAX，預設 60 筆）：提醒跟記者共用 LINE 每月推播額度，用完了記者問答的 push 退路也會失敗。
//
// 收件人：這場的負責人（lib/event-owner.js），而且他現在還是同仁或職員；沒有負責人、或負責人已退出，
// 改推給管理員（LINE_ADMIN_USER_ID）並說明原因——不能讓這場悄悄沒人提醒。

import { readRange, appendRows, ensureSheets } from './sheets.js';
import { pushMessage } from './line.js';
import { toTraditionalTW } from './zh-tw.js';
import { reminderItem, formatReminder } from './event-guide.js';
import { getOwnerMap } from './event-owner.js';
import { listActiveColleagueIds, listActiveStaffIds, invalidateStaffCache, ensureEventEditCode, editLink, todayTaipei } from './staff.js';

export const REMIND_RANGE = 'event_reminders!A2:F';
const HEADER = ['發送時間', '活動 id', '活動日期', '種類', '收件人 LINE ID', '結果'];
export const KIND_EVE = 'eve';          // 活動前一天
export const DEFAULT_MONTHLY_MAX = 60;

// 沒設、或不是數字就用預設值；明確設 0 ＝整個停掉提醒
const monthlyMax = () => {
  const raw = String(process.env.REMIND_MONTHLY_MAX ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_MAX;
};

let ensuredAt = 0;
async function ensureRemindSheet() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60 * 1000) return;
  try { await ensureSheets({ event_reminders: HEADER }); ensuredAt = Infinity; }
  catch (e) { console.error('ensureSheets(event_reminders) 失敗，60 秒後再試:', e.message); ensuredAt = Date.now(); }
}

const stamp = (now) => now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }); // 2026-10-27 17:00:12

/**
 * 跑一次。dry＝只算、不推、不寫紀錄（排程網址加 &dry=1 可以先看今天會推給誰）。
 * 回傳摘要給 Vercel 的 log／手動呼叫的人看。
 */
export async function runRemindCron({ now = new Date(), dry = false } = {}) {
  const today = todayTaipei(now);
  const summary = { today, candidates: 0, sent: 0, toAdmin: 0, skipped: [], dry };

  const events = await readRange('events!A2:R');
  const items = (events || []).map(r => reminderItem(r, today)).filter(Boolean);
  summary.candidates = items.length;
  if (!items.length) return summary;

  let log = [];
  try { log = await readRange(REMIND_RANGE); } catch { log = []; }
  const sentKeys = new Set((log || []).filter(r => r[5] === 'sent').map(r => `${r[1]}|${r[2]}|${r[3]}`));
  const month = stamp(now).slice(0, 7);
  let usedThisMonth = (log || []).filter(r => r[5] === 'sent' && String(r[0] || '').startsWith(month)).length;

  const todo = items.filter(it => !sentKeys.has(`${it.eventId}|${it.date}|${KIND_EVE}`));
  if (todo.length < items.length) summary.skipped.push(`${items.length - todo.length} 場今天已經提醒過`);
  if (!todo.length) return summary;

  // 退出的人不能還收到提醒：名單快取（60 秒）在暖著的 instance 上可能是退出前的樣子，排程一天才跑一次，直接讀最新的
  invalidateStaffCache();
  const [owners, colleagues, staff] = await Promise.all([getOwnerMap(), listActiveColleagueIds().catch(() => []), listActiveStaffIds().catch(() => [])]);
  const active = new Set([...colleagues, ...staff]);
  const adminId = process.env.LINE_ADMIN_USER_ID || '';

  // 依收件人分組：同一人明天有好幾場合成一則
  const groups = new Map(); // userId → { unowned, entries: [{ item, link }] }
  for (const item of todo) {
    const o = owners.get(item.eventId);
    const toOwner = o && active.has(o.userId);
    const to = toOwner ? o.userId : adminId;
    if (!to) { summary.skipped.push(`《${item.name}》沒有負責人，也沒有設定 LINE_ADMIN_USER_ID`); continue; }
    const code = await ensureEventEditCode(item.eventId).catch(() => null);
    const g = groups.get(to) || { unowned: !toOwner, entries: [] };
    g.entries.push({ item, link: code ? editLink(item.eventId, code) : '' });
    groups.set(to, g);
  }

  const max = monthlyMax();
  for (const [to, g] of groups) {
    if (usedThisMonth + g.entries.length > max) {
      summary.skipped.push(`本月提醒已到上限 ${max}（REMIND_MONTHLY_MAX），沒有推給 ${g.entries.length} 場`);
      continue;
    }
    if (dry) { summary.sent += g.entries.length; if (g.unowned) summary.toAdmin += g.entries.length; continue; }
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) { summary.skipped.push('沒有 LINE_CHANNEL_ACCESS_TOKEN'); continue; }
    // 名稱、地點是同仁打的，只轉字、不轉用語（理由見 lib/line-runtime.js twFlex()）
    const text = toTraditionalTW(formatReminder(g.entries, { unowned: g.unowned }), { terms: false });
    let ok = false;
    try {
      const res = await pushMessage(to, text);
      ok = res === true || (res && res.ok !== false);
    } catch (e) {
      console.error('活動前一天提醒推播失敗:', e.message);
    }
    if (!ok) { summary.skipped.push(`推給 ${g.entries.length} 場的提醒失敗（晚點的第二次排程會再試）`); continue; }
    await ensureRemindSheet();
    try {
      await appendRows('event_reminders!A:F', g.entries.map(({ item }) => [stamp(now), item.eventId, item.date, KIND_EVE, to, 'sent']));
    } catch (e) {
      // 推出去了卻沒記到：第二次排程會重複推。這裡能做的是把它大聲記下來
      console.error('寫入 event_reminders 失敗（可能重複提醒）:', e.message);
    }
    usedThisMonth += g.entries.length;
    summary.sent += g.entries.length;
    if (g.unowned) summary.toAdmin += g.entries.length;
  }
  return summary;
}
