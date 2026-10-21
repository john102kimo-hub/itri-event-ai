// 計畫成效唯讀連結（批次 151，政府端第一步）。
//
// 部會、計畫主管機關的承辦人最需要的通常不是跟 AI 聊天，而是結案時能交出去的「媒體露出成效」。
// 這些資料系統裡早就有（露出清單、AI 提問），只是以前只有管理員看得到。這支給每一場活動一條唯讀連結：
// 傳給誰都行，外流了按「重新產生」舊的立刻失效——跟報名狀況唯讀頁（批次 127，lib/registration.js statusView()）同一個做法。
//
// 資料界線寫成程式（CLAUDE.md 第 2 條）：impactView() 只組白名單欄位——數字、媒體名稱（露出清單裡的，本來就是公開報導）、
// 提問的主題詞與次數。提問原文、提問者的媒體與姓名、聯絡方式、AI 回答、知識庫一律不出這個出口：
// 連結轉傳到哪裡、網路上抓得到的回應裡都不該有那些東西。
//
// 企業場不提供：企業場的提問不算進媒體成效（批次 118），也不該把客戶的問題拿去當計畫成果給政府單位看。
import { randomBytes } from 'node:crypto';
import { readRange, updateRange, appendRows, ensureSheets } from './sheets.js';
import { safeEqual } from './auth.js';
import { readEventRows } from './events-table.js';
import { readQaRowsWithoutAnswers } from './qa-log.js';
import { isBusinessEvent } from './audience.js';
import { isTestMedia, groupOutlets } from './media-name.js';
import { eventDateOf } from './event-status.js';
import { summarizeExposure } from './exposure-parse.js';
import { countTopics } from './qa-topics.js';
import { nowIso, siteBase } from './registration.js';

const SHEET = { impact_links: ['event_id', 'token', 'created_at', 'updated_at'] };
const LINKS_TTL_MS = 30_000;
const VIEW_TTL_MS = 60_000;
export const TOP_TOPICS = 8;

let ensuredAt = 0;
async function ensureSheet() {
  if (ensuredAt === Infinity) return;
  if (Date.now() - ensuredAt < 60_000) return;
  try { await ensureSheets(SHEET); ensuredAt = Infinity; }
  catch (e) { console.error('ensureSheets(impact_links) 失敗，60 秒後再試:', e.message); ensuredAt = Date.now(); }
}

let linksCache = { rows: null, expiry: 0 };
const viewCache = new Map();
export function resetImpactState() { linksCache = { rows: null, expiry: 0 }; viewCache.clear(); ensuredAt = 0; }

async function readLinks({ fresh = false } = {}) {
  if (!fresh && linksCache.rows && Date.now() < linksCache.expiry) return linksCache.rows;
  let rows = [];
  try { rows = await readRange('impact_links!A2:D'); } catch { rows = []; } // 表還沒建過＝還沒有人產生過連結
  linksCache = { rows, expiry: Date.now() + LINKS_TTL_MS };
  return rows;
}

export const impactUrl = (eventId, token) => `${siteBase()}/impact?id=${encodeURIComponent(eventId)}&k=${encodeURIComponent(token)}`;
const makeToken = () => randomBytes(16).toString('base64url');

async function findEvent(eventId) {
  const row = (await readEventRows()).find((r) => r[0] === eventId);
  return row || null;
}

/** 後台：這一場現在有沒有連結。 */
export async function getShare(eventId) {
  const row = (await readLinks({ fresh: true })).find((r) => r[0] === eventId);
  const token = String(row?.[1] || '').trim();
  return { ok: true, token, url: token ? impactUrl(eventId, token) : '' };
}

/** 後台：產生（已有就沿用）／重新產生（舊連結立刻失效）／停用。 */
export async function adminSetShare(eventId, mode) {
  if (!['create', 'rotate', 'off'].includes(mode)) return { ok: false, status: 400, error: '不支援的操作' };
  const ev = await findEvent(eventId);
  if (!ev) return { ok: false, status: 404, error: '找不到這場活動' };
  if (isBusinessEvent({ event_type: ev[13] })) return { ok: false, status: 400, error: '企業場不提供計畫成效連結（企業場的提問不算進媒體成效）' };
  await ensureSheet();
  const rows = await readLinks({ fresh: true });
  const idx = rows.findIndex((r) => r[0] === eventId);
  const cur = String(rows[idx]?.[1] || '').trim();
  // create：已經有就沿用（按兩次不會把對方手上的連結弄壞）；rotate：一定換新的
  const token = mode === 'off' ? '' : (mode === 'create' && cur ? cur : makeToken());
  if (token !== cur || idx === -1) {
    const stamp = nowIso();
    if (idx === -1) await appendRows('impact_links!A:D', [[eventId, token, stamp, stamp]]);
    else await updateRange(`impact_links!B${idx + 2}:D${idx + 2}`, [[token, rows[idx][2] || stamp, stamp]]);
  }
  linksCache = { rows: null, expiry: 0 };
  viewCache.clear();
  return { ok: true, token, url: token ? impactUrl(eventId, token) : '' };
}

/**
 * 公開的唯讀檢視。連結碼不對、沒產生過、已停用、活動不存在、企業場一律回 null（呼叫端回同一種 404，猜的人分不出是哪一種）。
 */
export async function impactView(eventId, token, { now = Date.now() } = {}) {
  const id = String(eventId || '').trim();
  const link = (await readLinks()).find((r) => r[0] === id);
  const saved = String(link?.[1] || '').trim();
  if (!id || !saved || !safeEqual(saved, String(token || ''))) return null;
  const hit = viewCache.get(id);
  if (hit && hit.expiry > now && hit.token === saved) return hit.view;

  const ev = await findEvent(id);
  if (!ev || isBusinessEvent({ event_type: ev[13] })) return null;

  const [expRows, qaRows] = await Promise.all([
    readRange('exposure!A2:I').catch(() => []),
    readQaRowsWithoutAnswers().catch(() => [])
  ]);
  const records = expRows.filter((r) => r[0] === id).map((r) => ({ outlet: r[4], date: r[2], type: r[3] }));
  // 跟後台「排除測試資料」同一個口徑：已刪除、測試媒體、同仁自己問的（內部職員）都不算
  const qs = qaRows.filter((r) => r[1] === id && r[6] !== '1' && !isTestMedia(r[3]));

  const view = {
    event: { id, name: ev[1] || id, date: eventDateOf(ev[5]), venue: ev[12] || '', organizer: ev[9] || '工研院' },
    exposure: records.length ? summarizeExposure(records) : null,
    qa: {
      questions: qs.length,
      media_asked: groupOutlets(qs.map((r) => r[3])).length,
      topics: countTopics(qs.map((r) => r[4]), { limit: TOP_TOPICS })
    },
    generated_at: nowIso(now)
  };
  viewCache.set(id, { expiry: now + VIEW_TTL_MS, token: saved, view });
  if (viewCache.size > 50) for (const [k, v] of viewCache) if (v.expiry < now) viewCache.delete(k);
  return view;
}
