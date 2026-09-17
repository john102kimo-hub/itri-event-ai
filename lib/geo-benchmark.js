// GEO 基準線——把單一分數放進「跟誰比、跟什麼時候比」的脈絡裡。
//
// 為什麼需要這個：能見度指數 52 分是好是壞？沒有對照就沒有答案。這裡給兩種對照：
//   1) 同業基準線 buildPeerSeries()：同一批不指名的問題裡，AI 提到工研院的比例
//      vs 提到資策會／台大／中研院的比例，接成時間序列。
//   2) 跟自己的過去比 selfTrend()：本週均分相對近 30 天均分是上升／持平／下降。
//
// ── 同業資料是哪來的 ───────────────────────────────────────────────
// 不是另外去查的。geo_runs 的 competitors_found 欄位從第一天就在存：判官每判一題，
// 都會把「這段回答裡除了工研院之外還點名了哪些機構」記下來。所以同業資料跟自己的
// 資料是**同一題、同一天、同一個引擎、同一次回答**產生的——這比另外開一輪去查對照
// 機構還乾淨，因為那樣問題、時間、引擎三個變數會同時變，比出來的差距不知道是誰造成的。
//
// ── 誠實邊界：為什麼同業線是「提及率」不是「能見度指數」 ─────────────
// 能見度指數＝提及 45＋位置 20＋自家網域被引 20＋有具體內容 15。後面三項判官只對
// 工研院判（題目就是這樣設計的），對照機構只有「有沒有被點名」這一個事實。
// 硬要幫對照機構湊一個 0–100 分數，就是拿自己編的數字去跟自己比，看起來很專業，
// 實際上不能對外講。所以同業對照一律用兩邊都真的量到的那一件事：提及率。
// 這也代表這張圖跟能見度指數走勢**不能疊在同一組 Y 軸上**，單位不一樣。
//
// 純函式：不碰網路、不讀環境變數、不自己算「今天」（today 一律由呼叫端傳進來，
// 免得這裡跟 api/geo.js 的 todayTW() 對「今天是哪天」各有一套，日期軸就會對不齊）。

import { resolveOrg, BRAND_KEY, BRAND_DEFAULT } from './geo-orgs.js';

const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/**
 * 一筆 run 裡出現了哪些機構（含工研院自己），回傳正規化後的 key → 顯示名稱。
 * 同一列裡「資策會 MIC」和「資策會產業情報研究所」指同一家，只算一次。
 */
function orgsInRun(run) {
  const found = new Map();
  if (run.mentioned) found.set(BRAND_KEY, BRAND_DEFAULT);
  String(run.competitors || '').split(/[、,，;；|｜/／]/)
    .map((s) => s.trim()).filter(Boolean)
    .forEach((raw) => {
      const o = resolveOrg(raw);
      // 品牌自己不從對手欄進來：mentioned 才是判官對工研院的正式判定，
      // 兩邊都算會讓工研院的提及率在某些天莫名其妙變高。
      if (!o.key || o.key === BRAND_KEY) return;
      const prev = found.get(o.key);
      // 沒登記在 ORG_MAP 的單位用最短的寫法當代表，跟 tallyOrgs() 同一條規則
      if (!prev || (!o.known && o.name.length < prev.length)) found.set(o.key, o.name);
    });
  return found;
}

/**
 * 同業基準線：工研院與被提到最多次的幾家對照機構，各自的提及率時間序列。
 *
 * 用「滾動 N 日提及率」而不是「每日提及率再取移動平均」：一天可能只有 12 筆樣本，
 * 當日提及率的顆粒粗到 8.3% 一格，先算成百分比再平均會把小分母那幾天放大成雜訊。
 * 滾動窗直接用「窗內被提到幾次 ÷ 窗內問了幾次」，分母自己加總，小樣本不會被灌權重。
 *
 * @param {Array}  runs   parseRun() 出來的 run（要有 date / score / mentioned / competitors）
 * @param {number} days   往回看幾天
 * @param {string} today  YYYY-MM-DD，呼叫端的「今天」
 */
export function buildPeerSeries(runs, days, today, {
  maxPeers = 5, window = 7, minWindowSamples = 3, minMentions = 3,
} = {}) {
  const from = addDays(today, -days + 1);
  // 只看判官真的判完的：score 為 null 代表那次掃失敗（引擎逾時、判官沒回 JSON）。
  // 失敗的 run 算進分母，會讓所有機構的提及率一起被稀釋，看起來像大家同時變差了。
  const valid = runs.filter((r) => r.date >= from && r.date <= today && r.score !== null);

  const dates = [];
  for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);

  // 每天：問了幾次、各機構被提到幾次
  const byDate = new Map();
  const names = new Map();
  const totals = new Map();
  valid.forEach((run) => {
    const cell = byDate.get(run.date) || { samples: 0, hits: new Map() };
    cell.samples += 1;
    orgsInRun(run).forEach((name, key) => {
      cell.hits.set(key, (cell.hits.get(key) || 0) + 1);
      totals.set(key, (totals.get(key) || 0) + 1);
      const prev = names.get(key);
      if (!prev || name.length < prev.length) names.set(key, name);
    });
    byDate.set(run.date, cell);
  });

  // 滾動窗：第 i 天往回含自己共 window 天
  const rolling = dates.map((_, i) => {
    let samples = 0;
    const hits = new Map();
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const cell = byDate.get(dates[j]);
      if (!cell) continue;
      samples += cell.samples;
      cell.hits.forEach((n, key) => hits.set(key, (hits.get(key) || 0) + n));
    }
    return { samples, hits };
  });

  // 窗內樣本太少就給 null（斷線），不要硬畫一個 0% 或 100%——
  // 一天只掃到 1 題的那種點，畫出來會是整張圖最醒目的尖峰，而它什麼都不代表。
  const rateOf = (key) => rolling.map((w) =>
    (w.samples < minWindowSamples ? null : r1((w.hits.get(key) || 0) / w.samples * 100)));

  const peers = [...totals.entries()]
    .filter(([key, n]) => key !== BRAND_KEY && n >= minMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPeers)
    .map(([key, n]) => ({ key, name: names.get(key) || key, mentions: n, rate: rateOf(key) }));

  const self = {
    key: BRAND_KEY,
    name: BRAND_DEFAULT,
    mentions: totals.get(BRAND_KEY) || 0,
    rate: rateOf(BRAND_KEY),
  };

  return {
    dates,
    window,
    self,
    peers,
    // 每個點背後的窗內樣本數。給前端在游標提示裡照實寫出來——
    // 一條線在樣本 4 筆和 40 筆的地方長得一模一樣，不標出來就會被當成一樣可信。
    windowSamples: rolling.map((w) => w.samples),
    samples: valid.length,
    // 一條線都畫不出來時，前端要顯示「還在累積」而不是一張空白座標軸
    ready: self.rate.some((v) => v !== null),
  };
}

/* ────────────────────────────── 跟自己的過去比 ──────────────────────────────
 * 這個標記只有一個用途：讓人一眼知道「這週比平常好還是差」。
 * 它**不是統計檢定**——要宣稱「這一場活動真的把數字推上去了」，看一頁報告那邊的
 * bootstrap 信賴區間，那才是能寫進績效、經得起追問的算法。
 *
 * 兩個刻意的保守設計：
 *  1) 30 天基線「含」本週。窗重疊會讓差距被自己拉平，算出來的漲跌比實際小。
 *     這是故意的：寧可少報一次漲，不要多報一次——朱朱要拿這個數字對記者講話。
 *  2) 死區 ±2 分。單次查詢本來就有隨機性，1 分的差距講「上升」是在編故事。
 */
const DEAD_ZONE = 2;

/**
 * @param {Array}  runs   parseRun() 出來的 run
 * @param {string} today  YYYY-MM-DD，呼叫端的「今天」
 * @returns 樣本不夠時 current／baseline／delta 一律是 null——不是讓前端自己判斷要不要顯示，
 *          是根本不給它數字。這種「資料不夠卻畫了一個向上箭頭」的畫面只要出現一次，
 *          就會被截圖傳出去，而它是我們自己算錯的。
 */
export function selfTrend(runs, today, {
  recentDays = 7, baseDays = 30, minRecentDays = 3, minBaseDays = 10, deadZone = DEAD_ZONE,
} = {}) {
  const pick = (n) => runs.filter((r) =>
    r.score !== null && r.date >= addDays(today, -n + 1) && r.date <= today);
  const recent = pick(recentDays);
  const base = pick(baseDays);
  const scannedDays = (rs) => new Set(rs.map((r) => r.date)).size;

  const out = {
    recentDays,
    baseDays,
    recentScannedDays: scannedDays(recent),
    baseScannedDays: scannedDays(base),
    minBaseDays,
    samples: recent.length,
    current: null,
    baseline: null,
    delta: null,
    dir: null,
    label: null,
    reason: null,
  };

  if (out.recentScannedDays < minRecentDays || out.baseScannedDays < minBaseDays) {
    out.reason = `還在累積：近 ${baseDays} 天只掃到 ${out.baseScannedDays} 天，滿 ${minBaseDays} 天才算得出基準`;
    return out;
  }

  const current = avg(recent.map((r) => r.score));
  const baseline = avg(base.map((r) => r.score));
  const delta = current - baseline;

  out.current = r1(current);
  out.baseline = r1(baseline);
  out.delta = r1(delta);
  out.dir = delta > deadZone ? 'up' : delta < -deadZone ? 'down' : 'flat';
  out.label = out.dir === 'up' ? '上升' : out.dir === 'down' ? '下降' : '持平';
  return out;
}
