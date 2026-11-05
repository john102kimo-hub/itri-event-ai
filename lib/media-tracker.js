// 主流媒體記者「疑似換媒體」追蹤（批次 87）。
//
// 做法：每月（1 號）輪流抽一批主流媒體的在職記者，用 Google News RSS 搜他們的署名
// （"記者姓名"）。實測：亂編的名字查不到任何東西，真實記者查得到署名文章。
//   ・近 120 天在原媒體還有署名       → ok（仍在原媒體的跡象）
//   ・原媒體查不到、另一家連續 2 篇以上 → moved（疑似換媒體，附證據連結）
//   ・完全查不到署名                   → silent（證據弱：可能只是 Google 沒收錄）
//
// 誠實邊界（跟 api/media.js 檔頭同一條）：這是推測，不是確定。同名同姓、通訊社稿件被
// 別家轉載、特約外稿都會誤判。所以**只提醒、不自動標離職**——結果寫進 media_watch，
// 在健檢頁掛在那位記者旁邊附證據，由同仁按「已離職／轉線」或「還在跑」。
//
// 為什麼只查主流媒體：使用者的決定。小媒體的署名 Google 新聞多半沒收錄，查不到
// 不代表離職，花額度也換不到可信的訊號。
import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { parseNewsRss } from './newsjacking.js';
import { pushMessage } from './line.js';
import { toTraditionalTW } from './zh-tw.js';

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

// 推播對象只有管理員（LINE_ADMIN_USER_ID，跟 lib/teach-queue.js 同一個對象）。LINE 輕用量方案每月只有 200 則 push，
// 額度用完後記者問答的 push 退路也會失效，所以不推給全部職員。出口過 toTraditionalTW()（CLAUDE.md 第 1 條）：
// 記者姓名是人輸入的，可能夾簡體字。
const sendToAdmin = (push, text) => {
  const to = process.env.LINE_ADMIN_USER_ID;
  if (!to) return Promise.reject(new Error('沒設定 LINE_ADMIN_USER_ID'));
  return push(to, toTraditionalTW(text, { terms: false }));
};

const SITE = 'https://itri-event-ai.vercel.app';
export const WATCH_SHEET = {
  media_watch: ['id', 'checked_at', 'verdict', 'same_count', 'other_source', 'other_count', 'latest_at', 'evidence', 'notified'],
};
export const WATCH_RANGE = 'media_watch!A2:I';
export const WINDOW_DAYS = 120;
export const RECHECK_DAYS = 28;       // 同一位 28 天內不重查（排程每月一次）
export const BATCH_SIZE = 25;         // 每次排程查幾位：逐位查、中間留空檔，25 位約 35 秒，在 60 秒上限內
export const MOVED_MIN_HITS = 2;      // 另一家至少連續幾篇署名才算「疑似換媒體」

// 預設的主流媒體。後台可在 media_settings 加一列 mainstream_outlets（用頓號或逗號分隔）覆寫。
export const DEFAULT_MAINSTREAM = [
  '中央社', '聯合報', '聯合新聞網', '經濟日報', '工商時報', '中國時報', '中時', '自由時報',
  'ETtoday', '東森', '三立', 'TVBS', '中天', '民視', '公視', '年代', '非凡', '鏡新聞', '鏡週刊',
  '風傳媒', '科技新報', '數位時報', 'DIGITIMES', '電子時報', '天下', '遠見', '商業周刊', '今周刊',
  '財訊', '鉅亨', '經理人', '工商',
];

// 轉載平台：署名文章出現在這裡不代表人在那裡上班，一律不算「另一家媒體」。
const AGGREGATORS = ['yahoo', 'line today', 'linetoday', 'msn', 'google', 'pocket', '新浪', 'hinet', 'pchome'];

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
];

const norm = (s) => normOutlet(s);
const groupOf = (name) => {
  const n = norm(name);
  if (!n) return null;
  const i = ALIAS_GROUPS.findIndex((g) => g.some((a) => n.includes(norm(a)) || (norm(a).length >= 3 && norm(a).includes(n) && n.length >= 2)));
  return i === -1 ? null : i;
};

// 名單上的媒體跟新聞來源是不是同一家
export function sameOutlet(rosterOutlet, source) {
  const a = norm(rosterOutlet), b = norm(source);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ga = groupOf(rosterOutlet), gb = groupOf(source);
  return ga !== null && ga === gb;
}

export function isAggregator(source) {
  const s = String(source || '').toLowerCase();
  return AGGREGATORS.some((a) => a && s.includes(a));
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
  const others = recent.filter((h) => !sameOutlet(rec.outlet, h.source) && !isAggregator(h.source));

  const latest = (arr) => arr.map((h) => h.publishedAt).sort().at(-1) || '';
  if (same.length) {
    return { verdict: 'ok', same_count: same.length, other_source: '', other_count: 0, latest_at: latest(same), evidence: same.slice(0, 2) };
  }
  // 另一家媒體：取署名篇數最多的那家
  const bySource = new Map();
  others.forEach((h) => bySource.set(h.source, [...(bySource.get(h.source) || []), h]));
  const top = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (top && top[1].length >= MOVED_MIN_HITS) {
    return { verdict: 'moved', same_count: 0, other_source: top[0], other_count: top[1].length, latest_at: latest(top[1]), evidence: top[1].slice(0, 3) };
  }
  if (!recent.length) {
    return { verdict: 'silent', same_count: 0, other_source: '', other_count: 0, latest_at: '', evidence: [] };
  }
  return { verdict: 'unclear', same_count: 0, other_source: top?.[0] || '', other_count: top?.[1].length || 0, latest_at: latest(others), evidence: (top?.[1] || []).slice(0, 2) };
}

// ── 查一位 ──────────────────────────────────────────────────────────
function buildUrl(name) {
  const q = `"記者${name}" OR "文／${name}" when:${WINDOW_DAYS}d`;
  return `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' })}`;
}
export async function searchBylines(name, fetchImpl = fetch) {
  const res = await fetchImpl(buildUrl(name), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Google News RSS 回應 ${res.status}`);
  return parseNewsRss(await res.text());
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

// 排程入口。deps 給測試注入。回傳統計，不吐內容。
export const DEADLINE_MS = 38_000; // Vercel 函式上限 60 秒：超過這個時間就收工，已查的照樣寫回

export async function runWatchCron({ now = Date.now(), roster, watch, list, search = searchBylines, push = pushMessage, store, gapMs = 400, deadlineMs = DEADLINE_MS } = {}) {
  const startedAt = Date.now();
  const rosterRows = roster || (await loadRoster());
  const watchRows = watch || (await loadWatch());
  const outletList = list || await loadMainstreamList();
  const batch = pickBatch(rosterRows, watchRows, { list: outletList, now });

  const results = [];
  let failed = 0;
  for (const rec of batch) {
    if (Date.now() - startedAt > deadlineMs) break; // 沒查到的下次還在「沒查過」的最前面
    try {
      const hits = await search(rec.name);
      results.push({ rec, ...judge(rec, hits, now) });
    } catch (e) {
      failed++; console.error(`查署名失敗 ${rec.name}:`, e.message);
    }
    if (gapMs) await sleep(gapMs); // 對 Google 客氣一點
  }

  // 寫回 media_watch（已有的更新那列，沒有的一次 append）
  const byId = new Map(watchRows.map((w) => [w.id, w]));
  const toAppend = [];
  const writer = store || { update: (n, row) => updateRange(`media_watch!A${n}:I${n}`, [row]), append: async (rows) => { await ensureSheets(WATCH_SHEET); await appendRows('media_watch!A:I', rows); } };
  const stamp = new Date(now).toISOString();
  for (const r of results) {
    const prev = byId.get(r.rec.id);
    // 人已經按過「還在跑」，而且這次疑似的還是同一家 → 維持 dismissed，不再提醒、不再通知
    if (prev?.verdict === 'dismissed' && r.verdict === 'moved' && prev.other_source === r.other_source) {
      r.verdict = 'dismissed'; r.watch = { ...prev, checked_at: stamp };
      await writer.update(prev.rowNum, watchRow(r.watch));
      continue;
    }
    // 同一個結論已經通知過就不再通知；結論變了（例如 moved 變 ok 再變 moved）才重新通知
    const notified = prev && prev.verdict === r.verdict ? prev.notified : '';
    const w = { id: r.rec.id, checked_at: stamp, verdict: r.verdict, same_count: r.same_count, other_source: r.other_source, other_count: r.other_count, latest_at: r.latest_at, evidence: r.evidence, notified };
    r.watch = w;
    if (prev) await writer.update(prev.rowNum, watchRow(w)); else toAppend.push(watchRow(w));
  }
  if (toAppend.length) await writer.append(toAppend);

  // 有「新的」疑似換媒體才推給職員，沒有就安靜（主動但不吵）
  const fresh = results.filter((r) => r.verdict === 'moved' && !r.watch.notified);
  let pushed = 0;
  if (fresh.length) {
    try { await sendToAdmin(push, formatWatchDigest(fresh)); pushed = 1; } catch (e) { console.error('離職追蹤推送失敗:', e.message); }
    if (pushed) {
      for (const r of fresh) {
        const prev = byId.get(r.rec.id);
        const rowNum = prev?.rowNum ?? null;
        r.watch.notified = '1';
        if (rowNum) await writer.update(rowNum, watchRow(r.watch));
        else await markNotifiedByAppend(r, writer);
      }
    }
  }
  return {
    candidates: batch.length, checked: results.length, failed, pushed,
    ok: results.filter((r) => r.verdict === 'ok').length,
    moved: results.filter((r) => r.verdict === 'moved').length,
    silent: results.filter((r) => r.verdict === 'silent').length,
  };
}

// 新 append 的那列不知道列號：重讀一次找到它再標記（只在剛好有新 moved 又是第一次查時發生）
async function markNotifiedByAppend(r, writer) {
  try {
    const rows = await loadWatch();
    const hit = rows.find((w) => w.id === r.rec.id);
    if (hit) await writer.update(hit.rowNum, watchRow({ ...r.watch, notified: '1' }));
  } catch (e) { console.error('標記已通知失敗:', e.message); }
}

async function loadMainstreamList() {
  try {
    const rows = await readRange('media_settings!A2:B');
    const v = rows.find((r) => r[0] === 'mainstream_outlets')?.[1];
    const parsed = parseOutletList(v);
    return parsed.length ? parsed : DEFAULT_MAINSTREAM;
  } catch { return DEFAULT_MAINSTREAM; }
}

export function formatWatchDigest(items) {
  const lines = [`🔎 記者名單健檢：${items.length} 位主流媒體記者疑似換了媒體`];
  items.slice(0, 8).forEach((r) => {
    const ev = r.evidence[0];
    lines.push(`・${r.rec.name}（名單：${r.rec.outlet}）→ 近期署名在「${r.other_source}」${r.other_count} 篇，原媒體 ${WINDOW_DAYS} 天內查不到${ev?.link ? `\n  ${ev.link}` : ''}`);
  });
  if (items.length > 8) lines.push(`…另外還有 ${items.length - 8} 位`);
  lines.push('', '這是用新聞署名推測的，不是確定：同名同姓、通訊社稿件被轉載、特約外稿都會誤判。', `請到記者名單健檢頁逐筆確認（用團隊連結）：${SITE}/media.html`);
  return lines.join('\n');
}

// 同仁按了「還在跑」：把 moved 改成 dismissed（保留 other_source，之後同一家不再提醒）
export async function dismissWatch(id) {
  const hit = (await loadWatch()).find((w) => w.id === id && w.verdict === 'moved');
  if (!hit) return false;
  await updateRange(`media_watch!A${hit.rowNum}:I${hit.rowNum}`, [watchRow({ ...hit, verdict: 'dismissed' })]);
  return true;
}

// ── 批次 191：匯入後自動盤查 ────────────────────────────────────────────
// 朱朱的要求：匯入名單後自動查每位記者近期的署名報導，只有「建議刪除」的才拿出來給人看，其餘直接留在名單，
// 不要一位一位確認。跟每月排程同一套判斷（judge），差別：
//   ・只查這次匯入的那幾位（ids），不限主流媒體、不看 28 天內查過沒有——人剛匯進來，就是要現在查
//   ・不推 LINE（人就在畫面前）
//   ・「建議刪除」只有 verdict=moved（另一家連續署名、原媒體查不到）。silent（完全查不到）證據太弱，
//     Google 沒收錄小媒體很常見，**不建議刪除**，只回報數量，名單照樣留著。
// 一次只做一小批（DEADLINE_MS 內），回 remaining 讓畫面接著呼叫，避免撞到 Vercel 60 秒上限。
export async function checkImported({ ids = [], now = Date.now(), roster, watch, search = searchBylines, store, gapMs = 400, deadlineMs = DEADLINE_MS } = {}) {
  const startedAt = Date.now();
  const rosterRows = roster || (await loadRoster());
  const watchRows = watch || (await loadWatch());
  const want = new Set(ids.map(String));
  const byId = new Map(watchRows.map((w) => [w.id, w]));
  const people = rosterRows.filter((r) => want.has(r.id));
  const skipped = people.filter((r) => r.status === 'left' || r.name.length < 2 || r.name.length > 5).map((r) => r.id);
  const todo = people.filter((r) => !skipped.includes(r.id));

  const results = []; const remaining = []; let failed = 0;
  for (const rec of todo) {
    if (Date.now() - startedAt > deadlineMs) { remaining.push(rec.id); continue; }
    try { results.push({ rec, ...judge(rec, await search(rec.name), now) }); }
    catch (e) { failed++; remaining.push(rec.id); console.error(`查署名失敗 ${rec.name}:`, e.message); }
    if (gapMs) await sleep(gapMs);
  }

  const writer = store || { update: (n, row) => updateRange(`media_watch!A${n}:I${n}`, [row]), append: async (rows) => { await ensureSheets(WATCH_SHEET); await appendRows('media_watch!A:I', rows); } };
  const stamp = new Date(now).toISOString(); const toAppend = [];
  for (const r of results) {
    const prev = byId.get(r.rec.id);
    if (prev?.verdict === 'dismissed' && r.verdict === 'moved' && prev.other_source === r.other_source) r.verdict = 'dismissed';
    const w = { id: r.rec.id, checked_at: stamp, verdict: r.verdict, same_count: r.same_count, other_source: r.other_source, other_count: r.other_count, latest_at: r.latest_at, evidence: r.evidence, notified: '1' };
    r.watch = w;
    if (prev) await writer.update(prev.rowNum, watchRow(w)); else toAppend.push(watchRow(w));
  }
  if (toAppend.length) await writer.append(toAppend);

  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    checked: results.length, failed, skipped: skipped.length, remaining,
    ok: count('ok'), silent: count('silent'), unclear: count('unclear'),
    suggest_delete: results.filter((r) => r.verdict === 'moved').map((r) => ({
      id: r.rec.id, name: r.rec.name, outlet: r.rec.outlet, other_source: r.other_source, other_count: r.other_count,
      latest_at: r.latest_at, link: r.evidence[0]?.link || '', title: r.evidence[0]?.title || '',
    })),
  };
}
