// 活動前後的提醒（批次 177 前一天、批次 178 其餘時間點；由 Vercel Cron 觸發，見 api/line.js 的 cron_remind）。
//
// 朱朱的需求：依時間點跟承辦人要資料。每一種提醒都是「那個時間點最該有的東西」：
//   前一週  先備好媒體邀請函（沒有邀請函才提醒）
//   前一天  新聞稿、議程、受訪者、貴賓、地點、聯絡人（缺什麼列什麼；還沒發布也提醒）
//   當天早上 新聞稿還沒貼（活動當天 00:00 起米亞改用新聞稿，lib/prompt.js isPreEventMode）
//   隔天   還沒有活動照片（直接傳給米亞）
//
// 排程一天跑兩個時段（slot）：早上（台灣約 08:30）做 前一週／當天／隔天；傍晚（17:00、17:30 兩班，第二班補第一班
// 推送失敗的）做 前一天。靠發送紀錄去重，同一場同一個活動日期每一種最多一次，所以一場活動最多收到 4 則。
//
// 界線（都是推播要算則數、又不能變成騷擾）：
//   ① 沒缺東西就不推（lib/event-guide.js reminderFor() 回 null）。
//   ② 同一場同一個活動日期同一種只推一次（event_reminders 分頁去重）。
//   ③ 每月上限 REMIND_MONTHLY_MAX（預設 60 筆）。提醒跟記者共用 LINE 每月推播額度，用完了記者問答
//      reply 失效時的 push 退路也會失敗。前一天與當天（真的會影響記者問到什麼）可以用到 100%；
//      前一週與隔天（錦上添花）只用到 70%，額度緊的時候先讓位。
//   ④ 只有「前一天」在沒有承辦人時推給管理員。既有活動大多沒有承辦人，其餘三種若也推給管理員，
//      朱朱每場活動會被多推三則，那是噪音。其餘三種只送給有承辦人（而且還在同仁／職員名單裡）的人。
//   ⑤ REMIND_OFF（逗號分隔，例如 week,after）可以單獨關掉某幾種。
//
// 收件人：這場的承辦人（lib/event-owner.js）；沒有承辦人、或已退出，「前一天」改推給管理員（LINE_ADMIN_USER_ID）
// 並說明原因——不能讓這場悄悄沒人提醒。

import { readRange, appendRows, ensureSheets } from './sheets.js';
import { pushMessage } from './line.js';
import { toTraditionalTW } from './zh-tw.js';
import { reminderFor, formatReminderOf, KIND_EVE, KIND_WEEK, KIND_DAY, KIND_AFTER } from './event-guide.js';
import { getOwnerMap } from './event-owner.js';
import { listActiveColleagueIds, listActiveStaffIds, invalidateStaffCache, ensureEventEditCode, editLink, todayTaipei } from './staff.js';

export { KIND_EVE, KIND_WEEK, KIND_DAY, KIND_AFTER };
export const REMIND_RANGE = 'event_reminders!A2:F';
const HEADER = ['發送時間', '活動 id', '活動日期', '種類', '收件人 LINE ID', '結果'];
export const DEFAULT_MONTHLY_MAX = 60;
// 額度緊的時候先讓位的種類，只能用到上限的這個比例
export const LOW_PRIORITY_RATIO = 0.7;
const LOW_PRIORITY = new Set([KIND_WEEK, KIND_AFTER]);
// 同一個時段裡的順序＝優先順序（額度不夠時，前面的先送）
export const SLOT_KINDS = { morning: [KIND_DAY, KIND_WEEK, KIND_AFTER], evening: [KIND_EVE] };

// 沒設、或不是數字就用預設值；明確設 0 ＝整個停掉提醒
const monthlyMax = () => {
  const raw = String(process.env.REMIND_MONTHLY_MAX ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_MAX;
};
// REMIND_OFF=week,after → 這兩種不送
const disabledKinds = () => new Set(String(process.env.REMIND_OFF ?? '').split(/[\s,，、]+/).map(s => s.trim().toLowerCase()).filter(Boolean));

let ensuredAt = 0;
async function ensureRemindSheet() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60 * 1000) return;
  try { await ensureSheets({ event_reminders: HEADER }); ensuredAt = Infinity; }
  catch (e) { console.error('ensureSheets(event_reminders) 失敗，60 秒後再試:', e.message); ensuredAt = Date.now(); }
}

const stamp = (now) => now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }); // 2026-10-27 17:00:12

/**
 * 現在是哪個時段：台灣時間 14 點以前算早上、其餘算傍晚。
 * Vercel Hobby 的排程可能晚到整點後一小時，早上那班（08:30）與傍晚那班（17:00）離 14 點都夠遠。
 */
export function slotOf(now = new Date()) {
  return Number(stamp(now).slice(11, 13)) < 14 ? 'morning' : 'evening';
}

/**
 * 跑一次。dry＝只算、不推、不寫紀錄（排程網址加 &dry=1 可以先看今天會推給誰）。
 * slot：'morning' 或 'evening'，沒給就看現在幾點（排程網址加 &slot=morning 可以手動指定）。
 * 回傳摘要給 Vercel 的 log／手動呼叫的人看。
 */
export async function runRemindCron({ now = new Date(), dry = false, slot } = {}) {
  const today = todayTaipei(now);
  const useSlot = SLOT_KINDS[slot] ? slot : slotOf(now);
  const off = disabledKinds();
  const kinds = SLOT_KINDS[useSlot].filter(k => !off.has(k));
  const summary = { today, slot: useSlot, kinds, candidates: 0, sent: 0, toAdmin: 0, byKind: {}, skipped: [], dry };
  if (!kinds.length) return summary;

  const events = (await readRange('events!A2:R')) || [];
  const candidates = {}; // kind → [item]
  for (const kind of kinds) {
    candidates[kind] = events.map(r => reminderFor(kind, r, today)).filter(Boolean);
    summary.candidates += candidates[kind].length;
  }
  if (!summary.candidates) return summary;

  let log = [];
  try { log = await readRange(REMIND_RANGE); } catch { log = []; }
  const sentKeys = new Set((log || []).filter(r => r[5] === 'sent').map(r => `${r[1]}|${r[2]}|${r[3]}`));
  const month = stamp(now).slice(0, 7);
  let usedThisMonth = (log || []).filter(r => r[5] === 'sent' && String(r[0] || '').startsWith(month)).length;

  // 退出的人不能還收到提醒：名單快取（60 秒）在暖著的 instance 上可能是退出前的樣子，排程一天才跑兩三次，直接讀最新的
  invalidateStaffCache();
  const [owners, colleagues, staff] = await Promise.all([getOwnerMap(), listActiveColleagueIds().catch(() => []), listActiveStaffIds().catch(() => [])]);
  const active = new Set([...colleagues, ...staff]);
  const adminId = process.env.LINE_ADMIN_USER_ID || '';
  const max = monthlyMax();

  for (const kind of kinds) {
    const todo = candidates[kind].filter(it => !sentKeys.has(`${it.eventId}|${it.date}|${kind}`));
    const already = candidates[kind].length - todo.length;
    if (already) summary.skipped.push(`${kind}：${already} 場已經提醒過`);
    if (!todo.length) continue;

    // 依收件人分組：同一人同一種提醒有好幾場合成一則
    const groups = new Map(); // userId → { unowned, entries: [{ item, link }] }
    let noOwner = 0;
    for (const item of todo) {
      const o = owners.get(item.eventId);
      const toOwner = !!(o && active.has(o.userId));
      // 只有「前一天」在沒有承辦人時推給管理員（理由見檔案開頭 ④）
      const to = toOwner ? o.userId : (kind === KIND_EVE ? adminId : '');
      if (!to) { noOwner++; continue; }
      const code = await ensureEventEditCode(item.eventId).catch(() => null);
      const g = groups.get(to) || { unowned: !toOwner, entries: [] };
      g.entries.push({ item, link: code ? editLink(item.eventId, code) : '' });
      groups.set(to, g);
    }
    if (noOwner) summary.skipped.push(`${kind}：${noOwner} 場沒有可以推的承辦人${kind === KIND_EVE ? '，也沒有設定 LINE_ADMIN_USER_ID' : '（這一種只送給承辦人）'}`);

    const cap = LOW_PRIORITY.has(kind) ? Math.floor(max * LOW_PRIORITY_RATIO) : max;
    for (const [to, g] of groups) {
      if (usedThisMonth + g.entries.length > cap) {
        summary.skipped.push(`${kind}：本月提醒已到上限 ${cap}${LOW_PRIORITY.has(kind) ? `（${kind} 只用到 REMIND_MONTHLY_MAX 的 ${LOW_PRIORITY_RATIO * 100}%）` : '（REMIND_MONTHLY_MAX）'}，沒有推給 ${g.entries.length} 場`);
        continue;
      }
      if (dry) { count(summary, kind, g); continue; }
      if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) { summary.skipped.push('沒有 LINE_CHANNEL_ACCESS_TOKEN'); continue; }
      // 名稱、地點是同仁打的，只轉字、不轉用語（理由見 lib/line-runtime.js twFlex()）
      const text = toTraditionalTW(formatReminderOf(kind, g.entries, { unowned: g.unowned }), { terms: false });
      // 前一週：承辦人是同仁，直接給「貼邀請函」的按鈕（同仁模式認得「邀請函：活動名稱」）；推給管理員的不放，他不一定是同仁
      const chips = kind === KIND_WEEK && !g.unowned
        ? g.entries.slice(0, 5).map(({ item }) => ({ label: `📨 ${item.name}`, text: `邀請函：${item.name}` })) : undefined;
      let ok = false;
      try {
        const res = await pushMessage(to, text, chips);
        ok = res === true || (res && res.ok !== false);
      } catch (e) {
        console.error(`${kind} 提醒推播失敗:`, e.message);
      }
      if (!ok) { summary.skipped.push(`${kind}：推給 ${g.entries.length} 場的提醒失敗${useSlot === 'evening' ? '（晚點的第二次排程會再試）' : ''}`); continue; }
      await ensureRemindSheet();
      try {
        await appendRows('event_reminders!A:F', g.entries.map(({ item }) => [stamp(now), item.eventId, item.date, kind, to, 'sent']));
      } catch (e) {
        // 推出去了卻沒記到：下一班排程會重複推。這裡能做的是把它大聲記下來
        console.error('寫入 event_reminders 失敗（可能重複提醒）:', e.message);
      }
      usedThisMonth += g.entries.length;
      count(summary, kind, g);
    }
  }
  return summary;
}

function count(summary, kind, g) {
  summary.sent += g.entries.length;
  summary.byKind[kind] = (summary.byKind[kind] || 0) + g.entries.length;
  if (g.unowned) summary.toAdmin += g.entries.length;
}
