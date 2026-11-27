// 記者名單與活動報名、活動問答、署名查證的同步（批次 212）。
//
// 朱朱的要求：名單健檢要跟報名、問答同步；「盤點過已經很確認的就不要丟到待確認」。
//
// 兩件事分開，界線刻意寫死：
//   ① **確認在職**——看得到本人最近的活動紀錄（報名、提問、原媒體署名）就自動算確認過，不進待確認。
//      這是讀取時當場算的，不寫試算表，所以永遠跟報名／問答同步，也沒有「同步失敗」這回事。
//   ② **要改名單的**——換媒體、新 mail、新電話、名單外的新記者——只列成建議，一鍵批次套用，
//      **絕不自動寫入**：報名表與問答是公開入口，任何人都能用別人的名字送出。
//
// 這支全是純函式（loadSyncSources 例外），api/media.js 讀資料、套用建議。
import { createHash } from 'node:crypto';
import { readRange } from './sheets.js';
import { loadRegs, loadCampaigns, isTestReg, audienceOf } from './registration.js';
import { readQaRowsWithoutAnswers } from './qa-log.js';
import { parseQaTime } from './teach-queue.js';
import { isTestMedia, isNotMedia, splitMedia } from './media-name.js';
import { normalizeEmail } from './media-pick.js';
import { cleanPhone } from './card-scan.js';
import { sameOutlet, normOutlet, isMainstream, CONFIRM_MIN_HITS } from './media-tracker.js';

export const VERIFY_DAYS = 365;
const DAY = 86400000;
export const DISMISS_SHEET = { media_sync_dismissed: ['key', 'dismissed_at', 'dismissed_by'] };

export const personKey = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// 試算表裡的日期有三種寫法（ISO、「2026/10/11 14:30:00」、「2026-10-11」），只取到「日」來比先後
function dayOf(s) {
  const text = String(s || '');
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const t = new Date(text).getTime();
    return Number.isNaN(t) ? 0 : Math.floor((t + 8 * 3600000) / DAY); // 換成台灣的日期
  }
  const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : 0;
}
const dateLabel = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

const keyOf = (type, who, value) => createHash('sha1').update(`${type}|${who}|${value}`).digest('hex').slice(0, 16);

/**
 * 讀同步要用的來源。任何一個讀不到就列進 failed——少了證據只會讓待確認變多，不會讓人被誤判成在職。
 * 快取 60 秒：名單頁每按一次都要重算，而試算表的每分鐘讀取額度跟米亞的記者問答是同一個。
 * 要寫名單之前傳 fresh（套用建議用最新的資料）；讀失敗的結果不快取。
 */
const SOURCE_TTL_MS = 60_000;
let cache = null;
export function resetSyncCache() { cache = null; }
export async function loadSyncSources({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < SOURCE_TTL_MS) return cache.value;
  const failed = [];
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.error(`名單同步讀不到${label}:`, e.message); failed.push(label); return []; } };
  const [regs, campaigns, qa, dismissedRows] = await Promise.all([
    safe('活動報名', loadRegs),
    safe('報名活動', () => loadCampaigns({ fresh })),
    safe('活動問答', readQaRowsWithoutAnswers),
    // 分頁還沒建＝還沒有人忽略過任何建議，不算失敗
    readRange('media_sync_dismissed!A2:A').catch(() => []),
  ]);
  const value = { regs, campaigns, qa, dismissed: new Set(dismissedRows.map((r) => r[0])), failed };
  cache = failed.length ? null : { at: Date.now(), value };
  return value;
}

/**
 * roster：api/media.js parseRow() 之後的整份名單。
 * 回 { verified: Map(rosterId → {source, at, label}), suggestions: [], duplicates: Set(rosterId) }
 */
export function buildSync({ roster = [], regs = [], campaigns = [], qa = [], watch = [], dismissed = new Set(), now = Date.now() }) {
  const cutoff = now - VERIFY_DAYS * DAY;
  const byEmail = new Map(), byName = new Map(), byId = new Map();
  const push = (map, k, v) => { if (k) map.set(k, [...(map.get(k) || []), v]); };
  for (const r of roster) {
    if (!r.id || !r.name) continue;
    byId.set(r.id, r);
    push(byEmail, normalizeEmail(r.email), r);
    push(byName, personKey(r.name), r);
  }

  const verified = new Map();
  const found = new Map(); // 同一個人同一類只留最新的一筆
  const slot = (s) => `${s.type.replace(/^outlet_maybe$/, 'outlet')}|${s.rosterId || `${personKey(s.name)}|${normOutlet(s.outlet)}`}`;
  const suggest = (s, value) => {
    const item = { rosterId: '', safe: false, ...s };
    item.key = keyOf(item.type, item.rosterId || `${personKey(item.name)}|${normOutlet(item.outlet)}`, value);
    found.set(slot(item), item);
  };
  const confirm = (id, source, at, label) => {
    const cur = verified.get(id);
    if (!cur || at >= cur.at) verified.set(id, { source, at, label });
  };

  // ── 活動報名（只看媒體場；企業場的與會者不是記者；測試報名不算）────────────
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const signals = regs
    .filter((g) => g.status !== 'deleted' && !isTestReg(g) && campaignById.has(g.campaign_id) && audienceOf(campaignById.get(g.campaign_id)) !== 'business')
    .map((g) => ({ ...g, at: new Date(g.created_at).getTime() }))
    .filter((g) => g.at >= cutoff && personKey(g.name) && g.outlet)
    .sort((a, b) => a.at - b.at); // 舊到新：同一個人以最新那次為準

  for (const g of signals) {
    const title = campaignById.get(g.campaign_id).title || '';
    const label = `${dateLabel(g.at)} 報名「${title}」`;
    const email = normalizeEmail(g.email);
    const phone = g.phone ? cleanPhone(g.phone) : '';
    const day = dayOf(g.created_at);
    const emailHits = byEmail.get(email) || [];
    let person = emailHits.find((r) => personKey(r.name) === personKey(g.name));
    let byMail = !!person;
    if (!person) {
      if (emailHits.length) continue; // 同一個 mail、不同姓名：多半是公用信箱，認不出是誰
      const named = byName.get(personKey(g.name)) || [];
      const same = named.filter((r) => sameOutlet(r.outlet, g.outlet));
      if (same.length === 1) person = same[0];
      else if (same.length > 1) continue; // 名單裡本來就重複，交給「重複」標記
      else if (named.length === 1) {
        const r = named[0];
        if (day >= dayOf(r.updated_at)) {
          suggest({ type: 'outlet_maybe', rosterId: r.id, name: r.name, outlet: r.outlet, from: r.outlet, to: g.outlet, toEmail: email, evidence: `${label}，同名但單位填「${g.outlet}」（也可能只是同名）` }, normOutlet(g.outlet));
        }
        continue;
      } else if (!named.length) {
        suggest({ type: 'new', safe: true, name: g.name, outlet: g.outlet, email, phone, evidence: label }, email || '');
        continue;
      } else continue;
    }

    if (!sameOutlet(person.outlet, g.outlet)) {
      // 只有 mail＋姓名都對上才走得到這裡。名單在這次報名之後有人改過，就以人改的為準
      if (byMail && day >= dayOf(person.updated_at)) {
        verified.delete(person.id);
        suggest({ type: 'outlet', safe: true, rosterId: person.id, name: person.name, outlet: person.outlet, from: person.outlet, to: g.outlet, evidence: `${label}，同一個 mail，單位填「${g.outlet}」` }, normOutlet(g.outlet));
      }
      continue;
    }
    found.delete(`outlet|${person.id}`); // 比較新的報名又填回名單上的媒體
    if (person.status === 'left') {
      if (day > dayOf(person.updated_at)) suggest({ type: 'restore', safe: true, rosterId: person.id, name: person.name, outlet: person.outlet, from: '已離職', to: '在職', evidence: label }, String(day));
      continue;
    }
    confirm(person.id, 'registration', g.at, label);
    if (!byMail && email && normalizeEmail(person.email) !== email) {
      const had = normalizeEmail(person.email);
      suggest({ type: 'email', safe: !had, rosterId: person.id, name: person.name, outlet: person.outlet, from: person.email, to: email, evidence: label }, email);
    }
    if (phone && !person.phone) suggest({ type: 'phone', safe: true, rosterId: person.id, name: person.name, outlet: person.outlet, from: '', to: phone, evidence: label }, phone);
  }

  // ── 活動問答（媒體與姓名是自由填寫的：只拿來確認在職與找新面孔，不拿來判斷換媒體）──
  for (const row of qa) {
    if (!row[1] || row[1] === '[deleted]' || row[6] === '1' || isNotMedia(row[3]) || isTestMedia(row[3])) continue;
    const at = parseQaTime(row[0]);
    if (!(at >= cutoff)) continue;
    const parts = splitMedia(row[3]);
    const name = String(row[8] || parts.person || '').replace(/(記者|先生|小姐)$/, '').trim();
    if (!parts.outlet || !name) continue;
    const named = byName.get(personKey(name)) || [];
    const same = named.filter((r) => sameOutlet(r.outlet, parts.outlet));
    const label = `${dateLabel(at)} 在活動問答提問`;
    if (same.length === 1 && same[0].status !== 'left') confirm(same[0].id, 'qa', at, label);
    else if (!named.length && /^[㐀-鿿]{2,4}$/u.test(name) && isMainstream(parts.outlet)) {
      const s = { type: 'new', name, outlet: parts.outlet };
      if (!found.has(slot(s))) suggest({ ...s, email: '', phone: '', evidence: `${label}（沒有留 mail）` }, '');
    }
  }

  // ── 原媒體署名查證（lib/media-tracker.js）──────────────────────────
  for (const w of watch) {
    const r = byId.get(w.id);
    if (!r) continue;
    if (r.status === 'left') {
      // 批次 212 之前的「疑似換媒體」是誤判來源：照它標成離職的，列出來讓人一次恢復
      if (w.verdict === 'moved' && !found.has(`restore|${r.id}`)) {
        suggest({ type: 'restore_news', rosterId: r.id, name: r.name, outlet: r.outlet, from: '已離職', to: '在職', evidence: '之前依新聞搜尋推測「疑似換媒體」後標成離職，那個推測方式已停用，請覆核' }, '');
      }
      continue;
    }
    const at = new Date(w.latest_at).getTime();
    const stillSame = (w.evidence || []).some((e) => sameOutlet(r.outlet, e.s || e.source));
    if (w.verdict === 'ok' && w.same_count >= CONFIRM_MIN_HITS && at >= cutoff && stillSame) confirm(r.id, 'news', at, `${dateLabel(at)} 在原媒體有署名報導`);
  }

  // ── 名單本身重複：同一個 mail，或同名又同一家 ───────────────────────
  const duplicates = new Set();
  for (const group of byEmail.values()) {
    const live = group.filter((r) => r.status !== 'left');
    if (live.length > 1) live.forEach((r) => duplicates.add(r.id));
  }
  for (const group of byName.values()) {
    const live = group.filter((r) => r.status !== 'left');
    for (const a of live) if (live.some((b) => b !== a && sameOutlet(a.outlet, b.outlet))) duplicates.add(a.id);
  }

  const order = { outlet: 0, restore: 1, restore_news: 2, email: 3, phone: 4, new: 5, outlet_maybe: 6 };
  const suggestions = [...found.values()].filter((s) => !dismissed.has(s.key))
    .sort((a, b) => order[a.type] - order[b.type] || Number(b.safe) - Number(a.safe));
  return { verified, suggestions, duplicates };
}
