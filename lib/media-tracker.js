// 記者「原媒體署名」查證（批次 188 起；批次 212 改成只做正面查證）。
//
// 做法：用 Google News RSS 搜 "記者姓名"；原媒體查不到足夠的署名，再補一次限定原媒體網站的查詢。
//   ・近 120 天在原媒體查得到署名 → ok（滿 CONFIRM_MIN_HITS 篇就自動算「確認過」，不用同仁點）
//   ・查不到                       → silent／unclear（**什麼結論都不下**，畫面不顯示任何指控）
//
// ⚠️ 批次 212 拿掉了「疑似換媒體／離職」：Google 新聞的搜尋結果只告訴我們「哪一家的某一頁符合關鍵字」，
// 不是「這個人署名寫的」。正式使用時兩個誤判：中央社記者的稿子被別家整批轉載（原媒體那幾篇反而沒排進結果）、
// 另一位記者查到的是別家、署名根本不是本人的報導。查不到不代表離職，查到別家也不代表換工作——
// 調門檻救不了，所以程式裡不再產生任何「換媒體」結論（CLAUDE.md 第 2 條）。
// 換媒體的線索改看平台自己的資料：本人活動報名填的單位（lib/media-sync.js）。
import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { parseNewsRss } from './newsjacking.js';

// 名單列 → 追蹤要用的欄位（api/media.js 的 parseRow 沒有匯出，這裡只取需要的幾欄）
export function parseRosterRow(r, i) {
  return {
    rowNum: i + 2, id: r[0] || '', name: r[1] || '', outlet: r[2] || '',
    invited_count: Number(r[6]) || 0, status: r[10] || 'active',
  };
}
async function loadRoster() { return (await readRange('media_roster!A2:N')).map(parseRosterRow); }

// 媒體名稱正規化：只去掉空白、括號與公司尾綴，不做更積極的合併（聯合報與聯合新聞網是否同一家，交給下面的別名表）
export function normOutlet(s) {
  return String(s || '').normalize('NFKC')
    .replace(/[\s（()）]/g, '')
    .replace(/(股份)?有限公司$/, '').replace(/(股份)?公司$/, '')
    .toLowerCase();
}

export const WATCH_SHEET = {
  media_watch: ['id', 'checked_at', 'verdict', 'same_count', 'other_source', 'other_count', 'latest_at', 'evidence', 'notified'],
};
export const WATCH_RANGE = 'media_watch!A2:I';
export const WINDOW_DAYS = 120;
export const RECHECK_DAYS = 28;       // 同一位 28 天內不重查（排程每月一次）
export const BATCH_SIZE = 25;         // 每次排程查幾位：逐位查、中間留空檔，超過 DEADLINE_MS 就收工
export const CONFIRM_MIN_HITS = 2;    // 原媒體至少幾篇署名才自動算「確認過」（只有 1 篇可能是搜尋雜訊）

// 預設的主流媒體。後台可在 media_settings 加一列 mainstream_outlets（用頓號或逗號分隔）覆寫。
export const DEFAULT_MAINSTREAM = [
  '中央社', '聯合報', '聯合新聞網', '經濟日報', '工商時報', '中國時報', '中時', '自由時報',
  'ETtoday', '東森', '三立', 'TVBS', '中天', '民視', '公視', '年代', '非凡', '鏡新聞', '鏡週刊',
  '風傳媒', '科技新報', '數位時報', 'DIGITIMES', '電子時報', '天下', '遠見', '商業周刊', '今周刊',
  '財訊', '鉅亨', '經理人', '工商',
];

// 同一家媒體的不同寫法（Google 新聞的來源名稱常跟名單上寫的不一樣）。
const ALIAS_GROUPS = [
  ['中央社', 'cna', '中央通訊社'],
  ['聯合報', '聯合新聞網', 'udn', '聯合晚報'],
  ['中國時報', '中時', '中時新聞網', '中時電子報', '旺報'],
  ['自由時報', '自由時報電子報', '自由財經', 'ltn'],
  ['ettoday', '東森新聞', '東森'],
  ['三立', 'setn'],
  ['tvbs'],
  ['經濟日報'],
  ['工商時報', '工商'],
  ['數位時報', 'bnext'],
  ['digitimes', '電子時報'],
  ['科技新報', 'technews'],
  ['鏡新聞', '鏡週刊', '鏡傳媒'],
  ['商業周刊', 'businessweekly'],
  ['天下', 'cw.com.tw'],
  ['遠見', 'gvm'],
  ['yahoo', '雅虎'],
];

// 光是這些字認不出是哪一家（問答欄是自由填寫的，有人只打「新聞」「日報」）
const GENERIC_OUTLETS = ['新聞', '日報', '時報', '媒體', '記者', '雜誌', '週刊', '周刊', '電視', '電子報', '財經'];

// 原媒體網站：第一輪查不到足夠署名時，限定網站再查一次（別家轉載太多時，原媒體的稿會被擠掉）
const OUTLET_DOMAINS = [
  ['中央社', 'cna.com.tw'], ['經濟日報', 'money.udn.com'], ['聯合報', 'udn.com'], ['工商時報', 'ctee.com.tw'],
  ['中國時報', 'chinatimes.com'], ['自由時報', 'ltn.com.tw'], ['ettoday', 'ettoday.net'], ['三立', 'setn.com'],
  ['tvbs', 'tvbs.com.tw'], ['數位時報', 'bnext.com.tw'], ['digitimes', 'digitimes.com.tw'], ['科技新報', 'technews.tw'],
  ['公視', 'pts.org.tw'], ['民視', 'ftvnews.com.tw'], ['中天', 'ctinews.com'], ['鏡新聞', 'mnews.tw'],
  ['鏡週刊', 'mirrormedia.mg'], ['風傳媒', 'storm.mg'], ['天下', 'cw.com.tw'], ['遠見', 'gvm.com.tw'],
  ['商業周刊', 'businessweekly.com.tw'], ['今周刊', 'businesstoday.com.tw'], ['鉅亨', 'cnyes.com'],
  ['財訊', 'wealth.com.tw'], ['yahoo', 'yahoo.com'],
];

const norm = (s) => normOutlet(s);
const groupOf = (name) => {
  const n = norm(name);
  if (!n) return null;
  const i = ALIAS_GROUPS.findIndex((g) => g.some((a) => n.includes(norm(a)) || (norm(a).length >= 3 && norm(a).includes(n) && n.length >= 2)));
  return i === -1 ? null : i;
};

// 名單上的媒體跟新聞來源（或報名時填的單位）是不是同一家
export function sameOutlet(rosterOutlet, source) {
  const a = norm(rosterOutlet), b = norm(source);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  if (short.length < 2 || GENERIC_OUTLETS.includes(short)) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ga = groupOf(rosterOutlet), gb = groupOf(source);
  return ga !== null && ga === gb;
}

export function outletDomain(outlet) {
  const o = norm(outlet);
  if (!o) return '';
  // 先比名稱本身（鏡新聞、鏡週刊在同一個別名群組，網站卻不同），再比別名
  const hit = OUTLET_DOMAINS.find(([k]) => o.includes(norm(k))) || OUTLET_DOMAINS.find(([k]) => sameOutlet(outlet, k));
  return hit ? hit[1] : '';
}

export function isMainstream(outlet, list = DEFAULT_MAINSTREAM) {
  const o = norm(outlet);
  if (!o) return false;
  return list.some((k) => { const n = norm(k); return n && (o.includes(n) || (n.includes(o) && o.length >= 3)); });
}

export function parseOutletList(raw) {
  return String(raw || '').split(/[、,，;；\n]/).map((s) => s.trim()).filter(Boolean);
}

// ── 判斷：純函式，給一位記者與他的署名搜尋結果，回傳結論 ─────────────────────
// hits：parseNewsRss() 的結果（{title, link, source, publishedAt}）
export function judge(rec, hits, now = Date.now()) {
  const cutoff = now - WINDOW_DAYS * 86400000;
  const recent = (hits || []).filter((h) => h.publishedAt && new Date(h.publishedAt).getTime() >= cutoff);
  const same = recent.filter((h) => sameOutlet(rec.outlet, h.source));
  return {
    verdict: same.length ? 'ok' : recent.length ? 'unclear' : 'silent',
    same_count: same.length, other_source: '', other_count: 0,
    latest_at: same.map((h) => h.publishedAt).sort().at(-1) || '', evidence: same.slice(0, 2),
  };
}

// ── 查一位 ──────────────────────────────────────────────────────────
function buildUrl(q) {
  return `https://news.google.com/rss/search?${new URLSearchParams({ q: `${q} when:${WINDOW_DAYS}d`, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' })}`;
}
// 兩段查詢。不要用 OR 把「記者X」「文／X」串在一起——實測會讓原媒體的結果整批消失
export async function searchBylines(rec, fetchImpl = fetch) {
  const run = async (q) => {
    const res = await fetchImpl(buildUrl(q), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Google News RSS 回應 ${res.status}`);
    return parseNewsRss(await res.text());
  };
  const clean = (s) => String(s || '').replace(/["“”]/g, ' ').trim();
  const base = `"記者${clean(rec.name)}"`;
  const first = await run(base);
  if (judge(rec, first).same_count >= CONFIRM_MIN_HITS) return first;
  const domain = outletDomain(rec.outlet);
  const second = await run(domain ? `${base} site:${domain}` : `${base} "${clean(rec.outlet)}"`);
  const seen = new Set(first.map((h) => h.link));
  return [...first, ...second.filter((h) => !seen.has(h.link))];
}

// ── 挑這一輪要查的人 ─────────────────────────────────────────────────
export function pickBatch(roster, watchRows, { size = BATCH_SIZE, list = DEFAULT_MAINSTREAM, now = Date.now() } = {}) {
  const checkedAt = new Map(watchRows.map((w) => [w.id, w.checked_at ? new Date(w.checked_at).getTime() : 0]));
  return roster
    .filter((r) => r.status !== 'left' && r.name && r.name.length >= 2 && r.name.length <= 5 && isMainstream(r.outlet, list))
    .filter((r) => now - (checkedAt.get(r.id) || 0) >= RECHECK_DAYS * 86400000)
    .sort((a, b) => (checkedAt.get(a.id) || 0) - (checkedAt.get(b.id) || 0) || b.invited_count - a.invited_count)
    .slice(0, size);
}

// ── media_watch 讀寫 ─────────────────────────────────────────────────
export function parseWatchRow(r, i) {
  let evidence = [];
  try { evidence = JSON.parse(r[7] || '[]'); } catch { evidence = []; }
  return {
    rowNum: i + 2, id: r[0] || '', checked_at: r[1] || '', verdict: r[2] || '',
    same_count: Number(r[3]) || 0, other_source: r[4] || '', other_count: Number(r[5]) || 0,
    latest_at: r[6] || '', evidence, notified: r[8] || '',
  };
}
export async function loadWatch() {
  try { return (await readRange(WATCH_RANGE)).map(parseWatchRow); } catch { return []; }
}
const watchRow = (w) => [w.id, w.checked_at, w.verdict, w.same_count, w.other_source, w.other_count, w.latest_at,
  JSON.stringify((w.evidence || []).map((e) => ({ t: String(e.title || e.t || '').slice(0, 60), l: e.link || e.l || '', s: e.source || e.s || '', d: (e.publishedAt || e.d || '').slice(0, 10) }))),
  w.notified || ''];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEADLINE_MS = 38_000; // Vercel 函式上限 60 秒：超過這個時間就收工，已查的照樣寫回

const defaultWriter = () => ({
  update: (n, row) => updateRange(`media_watch!A${n}:I${n}`, [row]),
  append: async (rows) => { await ensureSheets(WATCH_SHEET); await appendRows('media_watch!A:I', rows); },
});

// 逐位查、寫回 media_watch。回傳統計與沒查完的 id。
async function checkPeople(people, { now, watchRows, search, store, gapMs, deadlineMs }) {
  const startedAt = Date.now();
  const results = []; const remaining = []; let failed = 0;
  for (const rec of people) {
    if (Date.now() - startedAt > deadlineMs) { remaining.push(rec.id); continue; } // 沒查到的下次還在「沒查過」的最前面
    try { results.push({ rec, ...judge(rec, await search(rec), now) }); }
    catch (e) { failed++; remaining.push(rec.id); console.error(`查署名失敗（${rec.id}）:`, e.message); }
    if (gapMs) await sleep(gapMs); // 對 Google 客氣一點
  }
  // 寫回 media_watch（已有的更新那列，沒有的一次 append）
  const byId = new Map(watchRows.map((w) => [w.id, w]));
  const writer = store || defaultWriter();
  const stamp = new Date(now).toISOString(); const toAppend = [];
  for (const r of results) {
    const prev = byId.get(r.rec.id);
    const w = { id: r.rec.id, checked_at: stamp, verdict: r.verdict, same_count: r.same_count, other_source: '', other_count: 0, latest_at: r.latest_at, evidence: r.evidence, notified: '' };
    if (prev) await writer.update(prev.rowNum, watchRow(w)); else toAppend.push(watchRow(w));
  }
  if (toAppend.length) await writer.append(toAppend);
  const confirmed = results.filter((r) => r.same_count >= CONFIRM_MIN_HITS).length;
  return { checked: results.length, failed, remaining, confirmed, notfound: results.length - confirmed };
}

// 排程入口。deps 給測試注入。回傳統計，不吐內容。
export async function runWatchCron({ now = Date.now(), roster, watch, list, search = searchBylines, store, gapMs = 400, deadlineMs = DEADLINE_MS } = {}) {
  const rosterRows = roster || (await loadRoster());
  const watchRows = watch || (await loadWatch());
  const outletList = list || await loadMainstreamList();
  const batch = pickBatch(rosterRows, watchRows, { list: outletList, now });
  const { remaining, ...stats } = await checkPeople(batch, { now, watchRows, search, store, gapMs, deadlineMs });
  return { candidates: batch.length, ...stats };
}

async function loadMainstreamList() {
  try {
    const rows = await readRange('media_settings!A2:B');
    const v = rows.find((r) => r[0] === 'mainstream_outlets')?.[1];
    const parsed = parseOutletList(v);
    return parsed.length ? parsed : DEFAULT_MAINSTREAM;
  } catch { return DEFAULT_MAINSTREAM; }
}

// ── 指定一批人查證（匯入後、或「一鍵盤查待確認」）──────────────────────────
// 跟每月排程同一套判斷（judge），差別：只查指定的人、不限主流媒體、不看 28 天內查過沒有。
// 一次只做一小批（DEADLINE_MS 內），回 remaining 讓畫面接著呼叫，避免撞到 Vercel 60 秒上限。
// 批次 212：只回「查到原媒體署名幾位／沒查到幾位」，不再回任何建議刪除名單。
export async function checkImported({ ids = [], now = Date.now(), roster, watch, search = searchBylines, store, gapMs = 400, deadlineMs = DEADLINE_MS } = {}) {
  const rosterRows = roster || (await loadRoster());
  const watchRows = watch || (await loadWatch());
  const want = new Set(ids.map(String));
  const people = rosterRows.filter((r) => want.has(r.id));
  const skipped = people.filter((r) => r.status === 'left' || r.name.length < 2 || r.name.length > 5).map((r) => r.id);
  const todo = people.filter((r) => !skipped.includes(r.id));
  const out = await checkPeople(todo, { now, watchRows, search, store, gapMs, deadlineMs });
  return { ...out, skipped: skipped.length };
}
