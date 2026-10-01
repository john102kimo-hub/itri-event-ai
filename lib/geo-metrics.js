// GEO 測量的「標準指標」層（批次 102）。
//
// 為什麼有這一層：能見度指數（提及 45＋位置 20＋自家網域被引 20＋有具體內容 15）是我們自己
// 定的，沒有任何標準規定這四項該配多少分。被主管問「這個 45 哪來的」，答不出標準。
// 2026 年 5–8 月 AMEC（國際傳播測量與評估協會）、PRCA、IAB 先後發布 GEO／AI 能見度測量準則，
// 它們共同的立場是：**單一綜合分數只是呈現層，要先把分項指標與分母、樣本、區間攤開**
// （IAB《Measuring Visibility in the AI Era》2026-08：「composite scores are a presentation
// layer」，用了就得揭露權重、正規化方式、各分項數值與限制；AMEC GEO Principles 2026-05：
// 「No single score, tool or prompt set can prove total AI visibility or communication impact」）。
// 所以這裡做的是：把對外要講的數字換成準則裡有定義的分項指標，每個都帶區間與分母；
// 綜合指數照舊算（歷史曲線不能斷），但它的權重、敏感度、限制一起講清楚。
// 引用文獻與逐項對照見 GEO-METHOD.md。
//
// 純函式：不碰網路、不讀環境變數、不自己算「今天」。api/geo.js 與測試共用同一份。

import { tallyOrgs, findBrandTerms } from './geo-orgs.js';

const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

/* ────────────────────────────── 綜合指數（自訂）────────────────────────────── */

// 單一來源：api/geo.js 的 scoreOf() 與下面的敏感度分析、GEO-METHOD.md 講的都是這一份。
// 改任何一個數字＝換了一套算法，歷史曲線就不能跟新資料接在一起看（IAB 要求趨勢資料在方法
// 改變時要重設基準、前後分開報告），所以改之前先看 GEO-METHOD.md「怎麼改權重」那一節。
export const COMPOSITE = Object.freeze({
  mention: 45,                          // 回答正文有提到工研院（沒提到＝0 分，其餘三項都不算）
  owned: 20,                            // 引用來源裡有自家網域
  specifics: 15,                        // 針對工研院給了可查證的具體內容
  rankPoints: Object.freeze([20, 14, 9, 5]), // 位置：第 1、2、3 名、第 4 名以後（含判官沒給名次）
});

const rankPts = (rank, pts) => (rank === 1 ? pts[0] : rank === 2 ? pts[1] : rank === 3 ? pts[2] : pts[3]);

/** 0–100。整數運算，跟舊的 scoreOf() 逐項一致（test-geo-method 有完整對照表）。 */
export function compositeScore({ mentioned, rank, cited, specifics }, c = COMPOSITE) {
  if (!mentioned) return 0;
  return c.mention + rankPts(rank, c.rankPoints) + (cited ? c.owned : 0) + (specifics ? c.specifics : 0);
}

// 敏感度分析用的幾套替代權重。OECD／歐盟 JRC《Handbook on Constructing Composite Indicators》
// （2008）Step 6：「Regardless of which method is used, weights are essentially value
// judgements」；Step 7（不確定性與敏感度分析）：權重、正規化、聚合方式都是主觀選擇，
// 要拿合理的替代方案重算，看結論會不會跟著翻。w＝[提及, 位置, 自家引用, 具體內容]。
// pos: 'table' 用現行的 20/14/9/5 比例；'rr' 改成倒數名次 1/名次（資訊檢索的標準做法）。
export const SCHEMES = Object.freeze([
  { id: 'ours', label: '現行（提及 45／位置 20／引用 20／內容 15）', w: [45, 20, 20, 15], pos: 'table' },
  { id: 'equal', label: '四項等權重（各 25）', w: [25, 25, 25, 25], pos: 'table' },
  { id: 'mention-heavy', label: '提及為主（70／10／10／10）', w: [70, 10, 10, 10], pos: 'table' },
  { id: 'cite-heavy', label: '加重自家引用（30／15／40／15）', w: [30, 15, 40, 15], pos: 'table' },
  { id: 'rr', label: '位置改用倒數名次 1/名次', w: [45, 20, 20, 15], pos: 'rr' },
  { id: 'mention-only', label: '只看提及率（100／0／0／0）', w: [100, 0, 0, 0], pos: 'table' },
]);

function schemeScore(run, s) {
  if (!run.mentioned) return 0;
  const posTerm = s.pos === 'rr'
    ? s.w[1] * (run.rank >= 1 ? 1 / run.rank : 0.25)
    : (s.w[1] * rankPts(run.rank, COMPOSITE.rankPoints)) / COMPOSITE.rankPoints[0];
  return s.w[0] + posTerm + (run.cited ? s.w[2] : 0) + (run.specifics ? s.w[3] : 0);
}

const pearson = (a, b) => {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; // 其中一條是水平線就沒有相關可言
};
// 名次相關（Spearman）：先轉成平均名次再算皮爾森，同分不會亂排
const ranks = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
};
const spearman = (a, b) => (a.length < 3 ? null : pearson(ranks(a), ranks(b)));

const groupBy = (xs, f) => {
  const m = new Map();
  xs.forEach((x) => { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); });
  return m;
};
const byDay = (runs) => [...groupBy(runs, (r) => r.date).entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, rs]) => ({ date, rs }));

/**
 * 綜合指數的敏感度分析：把同一批 run 用幾套不同權重重算，看
 *   (1) 每日均分曲線的走勢（跟現行那套的相關係數）、
 *   (2) 各議題的名次（跟現行那套的名次相關），
 * 會不會因為換了權重就變。相關高＝「45／20／20／15 是不是剛好最好」不影響結論；
 * 相關低＝綜合指數的結論有一部分是權重決定的，對外講的時候就不能只講綜合指數。
 * 不設「及格線」：相關係數幾以上算穩，沒有標準可援引，硬訂一條線就是又一個自己編的數字。
 * @param {Array} runs  已評分的 run（score !== null）：date / keyword / mentioned / rank / cited / specifics
 */
export function compositeSensitivity(runs, { minDays = 8, minTopics = 3 } = {}) {
  const days = byDay(runs);
  const topics = [...groupBy(runs, (r) => r.keyword || '未分類').entries()];
  const out = {
    days: days.length, topics: topics.length, samples: runs.length,
    needDays: minDays, needTopics: minTopics, schemes: [],
  };
  if (!runs.length) return out;

  const dailyOf = (s) => days.map((d) => mean(d.rs.map((r) => schemeScore(r, s))));
  const topicOf = (s) => topics.map(([, rs]) => mean(rs.map((r) => schemeScore(r, s))));
  const base = { daily: dailyOf(SCHEMES[0]), topic: topicOf(SCHEMES[0]) };

  // 算不出相關有兩種原因，講法不同：資料不夠（要等），或曲線是水平線（資料夠了，但沒有起伏可比）
  const corrOf = (enough, need, c) => {
    if (!enough) return { v: null, why: need };
    if (c === null) return { v: null, why: '曲線是水平的，算不出相關' };
    return { v: Math.round(c * 100) / 100, why: null };
  };
  out.schemes = SCHEMES.map((s) => {
    const daily = s.id === 'ours' ? base.daily : dailyOf(s);
    const topic = s.id === 'ours' ? base.topic : topicOf(s);
    const d = corrOf(days.length >= minDays, `不足 ${minDays} 天`, pearson(base.daily, daily));
    const t = corrOf(topics.length >= minTopics, `不足 ${minTopics} 個議題`, spearman(base.topic, topic));
    return {
      id: s.id, label: s.label, weights: s.w, pos: s.pos,
      mean: r1(mean(runs.map((r) => schemeScore(r, s)))),
      dailyCorr: d.v, dailyWhy: d.why, topicCorr: t.v, topicWhy: t.why,
    };
  });
  return out;
}

/* ────────────────────────────── 以「天」為群集的 bootstrap ────────────────────────────── */
// 同一天問的是同一批題目，彼此高度相關，每筆當獨立樣本會嚴重低估不確定性
// （api/geo.js 績效區塊用的是同一個道理；Martinez 2026 §11.3 也建議以 query／日期為群集）。
// 這裡估的是「同一組題庫、不同天重測」的變異範圍——AMEC 說題庫沒有已知母體，25／50／100 題
// 只是診斷用樣本，所以我們不宣稱「推到所有問法」，只報這組題目的重測區間。
// 固定種子：同一份資料每次算出同樣的區間，報告不能一重整就換數字。

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_CI_DAYS = 7; // 跟績效區塊的 INSUFFICIENT_N 同一條線：不到 7 天不給區間

function dayBootstrap(cells, stat, { B = 1000, seed = 20261001, minDays = MIN_CI_DAYS } = {}) {
  if (cells.length < minDays) return null;
  const rnd = mulberry32(seed);
  const vals = [];
  for (let b = 0; b < B; b++) {
    const pick = Array.from({ length: cells.length }, () => cells[Math.floor(rnd() * cells.length)]);
    const v = stat(pick);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < B / 2) return null;
  vals.sort((a, b) => a - b);
  const at = (f) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(f * vals.length)))];
  return [at(0.025), at(0.975)]; // 原值回傳，進位交給各指標（比例取 1 位、倒數名次取 2 位）
}

/* ────────────────────────────── 分項指標（IAB 定義）────────────────────────────── */

/**
 * 比例型指標：符合條件的回答數 ÷ 總回答數（IAB 的 Mention Rate／Citation Rate 都是這個形狀）。
 * @returns {{k,n,pct,ci,days}} ci 是 95% 區間（百分點）；不到 7 天為 null。
 */
export function rateWithCI(runs, pred, opts) {
  if (!runs.length) return { k: 0, n: 0, pct: null, ci: null, days: 0 };
  const k = runs.filter(pred).length;
  const cells = byDay(runs).map((d) => ({ n: d.rs.length, k: d.rs.filter(pred).length }));
  const ci = dayBootstrap(cells, (cs) => { const n = sum(cs.map((c) => c.n)); return n ? (sum(cs.map((c) => c.k)) / n) * 100 : null; }, opts);
  return { k, n: runs.length, pct: r1((k / runs.length) * 100), ci: ci && ci.map(r1), days: cells.length };
}

/**
 * Share of Voice：工研院被點名的次數 ÷（工研院＋所有其他機構被點名的次數）。
 * IAB：「Brand mentions as a proportion of all brand mentions within a defined competitive
 * category」，並要求揭露兩件事——競爭集合怎麼定、分母怎麼算——所以 universe 一併回傳：
 * 競爭集合＝這批回答裡判官實際點名的機構，不是事先指定的名單；每則回答每家機構只計一次。
 * （同一家的不同寫法先經 lib/geo-orgs.js 併起來，跟話語權排行同一套規則。）
 */
export function shareOfVoice(runs, opts) {
  if (!runs.length) return { self: 0, others: 0, total: 0, pct: null, ci: null, orgs: 0, days: 0 };
  const cell = (rs) => {
    const tally = tallyOrgs(rs);
    return { self: rs.filter((r) => r.mentioned).length, others: sum([...tally.values()].map((e) => e.n)) };
  };
  const cells = byDay(runs).map((d) => cell(d.rs));
  const tot = cell(runs);
  const total = tot.self + tot.others;
  const ci = dayBootstrap(cells, (cs) => {
    const s = sum(cs.map((c) => c.self)), o = sum(cs.map((c) => c.others));
    return s + o ? (s / (s + o)) * 100 : null;
  }, opts);
  return {
    self: tot.self, others: tot.others, total,
    pct: total ? r1((tot.self / total) * 100) : null, ci: ci && ci.map(r1),
    orgs: tallyOrgs(runs).size + (tot.self ? 1 : 0), days: cells.length,
  };
}

/**
 * Position：倒數名次的平均（Mean Reciprocal Rank，Voorhees 1999，TREC-8 問答評測的標準指標）。
 * 工研院是回答裡第 1 個被提到的機構＝1、第 2 個＝0.5、第 3 個＝0.33……沒被提到＝0。
 * IAB 對 Position 的要求是「敘述型回答沒有通用算法，要揭露怎麼定」——我們的定義：
 * 由判官依回答正文的出現順序判定（機構／單位／公司都算，來源清單不算）。
 * 判官沒給名次（rank 0）的不計入分子，數量另外回傳，不默默當 1 也不默默丟掉。
 */
export function reciprocalRank(runs, opts) {
  if (!runs.length) return { mrr: null, ci: null, n: 0, unranked: 0, firstPct: null, mentioned: 0, days: 0 };
  const rr = (r) => (r.mentioned && r.rank >= 1 ? 1 / r.rank : 0);
  const cells = byDay(runs).map((d) => ({ n: d.rs.length, s: sum(d.rs.map(rr)) }));
  const ci = dayBootstrap(cells, (cs) => { const n = sum(cs.map((c) => c.n)); return n ? sum(cs.map((c) => c.s)) / n : null; }, opts);
  const hit = runs.filter((r) => r.mentioned);
  const to2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    mrr: to2(sum(runs.map(rr)) / runs.length),
    ci: ci && ci.map((v) => to2(v)),
    n: runs.length, mentioned: hit.length,
    unranked: hit.filter((r) => !(r.rank >= 1)).length,
    // 被提到時是第一個被講到的比例（IAB Position 列的「first entity mentioned」）
    firstPct: hit.length ? r1((hit.filter((r) => r.rank === 1).length / hit.length) * 100) : null,
    days: cells.length,
  };
}

/* ────────────────────────────── 分母與樣本 ────────────────────────────── */

/**
 * 嘗試了幾次、有幾次有效。AMEC／IAB／Martinez 都強調分母要攤開：
 * 「沒搜尋、沒引用、出錯的輸出是結果，不是該默默丟掉的資料」（Martinez 2026 §11.2）。
 * 我們的掃描遇到「接地未生效」（引擎沒有真的去搜尋）會整筆不計分，這是刻意的——
 * 那是模型憑記憶講的，不是能見度量測——但被丟掉了幾筆必須讓人看得到。
 * @param {Array} all 這個範圍內所有 run（含失敗的）
 */
export function denominators(all) {
  const attempted = all.length;
  const scored = all.filter((r) => r.score !== null).length;
  const failed = attempted - scored;
  const noGround = all.filter((r) => r.score === null && /接地未生效/.test(r.error || '')).length;
  return {
    attempted, scored, failed, noGround, otherFailed: failed - noGround,
    pct: attempted ? r1((scored / attempted) * 100) : null,
  };
}

/* ────────────────────────────── 測量等級 ────────────────────────────── */

// IAB：「fewer than 50 queries per measurement program as exploratory rather than directional」。
// AMEC 對題數比較寬（25／50／100 題在說明建構方式與限制的前提下可當診斷樣本），兩份都列，
// 不挑對自己有利的那份。
export const IAB_MIN_QUERIES = 50;

/**
 * 這份數據在 IAB 的兩級（Directional／Decision-Grade）裡落在哪。我們從不宣稱決策等級：
 * 少了題數、同題重問變異、人工抽樣驗證、四種意圖分段、消費端平台覆蓋，任何一項都夠擋下它。
 */
export function measurementTier({ prompts = 0, engines = 0, totalPrompts = prompts, topics = 1 } = {}) {
  // prompts＝同一個議題（IAB 說的 category）裡不同的題目數，不是總發問次數：
  // 「題組要能涵蓋一個類別」才是門檻的本意，同一題問一百遍不會讓題組變大。
  // 多個議題混在一起報告時看最多題的那個議題，不拿加總去灌水。
  const level = prompts >= IAB_MIN_QUERIES ? 'directional' : 'exploratory';
  const gaps = [];
  if (prompts < IAB_MIN_QUERIES) {
    const scope = topics > 1
      ? `每個議題最多只有 ${prompts} 題（全部 ${totalPrompts} 題分散在 ${topics} 個議題）`
      : `題庫只有 ${prompts} 題`;
    gaps.push(`${scope}。IAB 指引把少於 ${IAB_MIN_QUERIES} 題的測量方案歸為「探索性」，連「方向性」都還不到；`
      + 'AMEC 認為 25／50／100 題可以當診斷樣本，但要說清楚題目怎麼來、限制在哪。');
  }
  gaps.push('每題每天通常只問 1 次（每月 1 日加跑 2 輪校準，那天有同日重複樣本），但「同一題重問」的變異還沒有單獨算出來報告，'
    + '現以逐日重抽的區間代替；決策等級要求在 7 天窗內定義可接受的變異範圍並回報信賴水準。');
  gaps.push('判官是 AI，沒有做過人工抽樣驗證；現以詞表規則做獨立的交叉檢查（見「兩套判定的一致率」）。');
  gaps.push('題目沒有依 IAB 的四種意圖（資訊／比較／推薦／交易）分段回報。');
  gaps.push(engines < 2
    ? `只涵蓋 ${engines} 個引擎，且是可用 API 的答案引擎，不是消費端畫面；決策等級要求涵蓋絕大多數 AI 流量並逐平台回報。`
    : '量到的是可用 API 的答案引擎，不是 ChatGPT／Google AI Overviews 的消費端畫面。');
  return {
    level, label: level === 'directional' ? '方向性（Directional）' : '探索性（Exploratory）',
    prompts, totalPrompts, topics, minPrompts: IAB_MIN_QUERIES, engines, decisionGrade: false, gaps,
  };
}

/* ────────────────────────────── 判官 vs 詞表規則 ────────────────────────────── */

/**
 * 兩套獨立的「有沒有提到工研院」判定放在一起看：
 *   判官＝模型讀回答下的判斷（run.mentioned，掃描當下存的）；
 *   規則＝程式拿詞表（lib/geo-orgs.js）比對回答原文，名稱或單位全名出現就算。
 * Martinez 2026 §6.4：判官「是被量測的儀器，不是不容質疑的真相」，要保留一個不靠判官的
 * 可觀察指標，並回報一致率與不一致的樣態。這裡不拿規則去改判官的分數（歷史曲線不能斷），
 * 只把兩邊對不上的攤出來給人複核。
 * ⚠️ 規則看的是 excerpt（存檔時只留回答前 500 字；回答上限約 400 字，絕大多數涵蓋全文）。
 * 單位簡稱（電光所…）不算規則命中，所以「判官有、規則沒有」裡會有一部分是只寫簡稱的回答——
 * 那正是「AI 認得單位、沒連到工研院」，單獨數在 shortOnly。
 */
export function judgeVsRule(scored, { maxExamples = 4 } = {}) {
  const n = scored.length;
  const o = { n, both: 0, neither: 0, judgeOnly: 0, ruleOnly: 0, shortOnly: 0, agreePct: null, terms: [], examples: [] };
  const counts = new Map();
  const bump = (tier, term) => { const k = `${tier}|${term}`; counts.set(k, (counts.get(k) || 0) + 1); };
  const judgeOnlyEx = [], ruleOnlyEx = [];
  scored.forEach((r) => {
    const t = findBrandTerms(r.excerpt);
    t.names.forEach((x) => bump('name', x));
    t.units.forEach((x) => bump('unit', x));
    t.short.forEach((x) => bump('short', x));
    if (!t.strong && t.short.length) o.shortOnly += 1;
    const ex = (kind) => ({ kind, engine: r.engine, date: r.date, text: String(r.excerpt || '').slice(0, 140) });
    if (r.mentioned && t.strong) o.both += 1;
    else if (!r.mentioned && !t.strong) o.neither += 1;
    else if (r.mentioned) { o.judgeOnly += 1; judgeOnlyEx.push(ex('judge_only')); }
    else { o.ruleOnly += 1; ruleOnlyEx.push(ex('rule_only')); }
  });
  o.agreePct = n ? r1(((o.both + o.neither) / n) * 100) : null;
  o.terms = [...counts.entries()]
    .map(([k, c]) => { const [tier, term] = k.split('|'); return { tier, term, n: c }; })
    .sort((a, b) => b.n - a.n || (a.term < b.term ? -1 : 1));
  // 規則有、判官沒有，比判官有、規則沒有更值得先看：前者可能是判官漏判，後者多半是只寫簡稱
  o.examples = [...ruleOnlyEx, ...judgeOnlyEx].slice(0, maxExamples);
  return o;
}

/* ────────────────────────────── 宣稱等級 ────────────────────────────── */

// AMEC（Crawford，2026-07）的四級：Observed／Associated／Contributed／Caused，
// 「Make the claim fit the evidence」；同一篇的結論：「Visibility is not an outcome. Report it as
// an observed output, and reserve outcome language for evidence about people and organisations.」
// 我們只有「發稿前 vs 發稿後」的前後比較、沒有對照組，最多到 Associated。
export const CLAIMS = Object.freeze({
  observed: { level: 'observed', label: '觀察（Observed）',
    text: '本報告只陳述在這批問答裡看到什麼，不推論原因，也不代表對記者、民眾的實際影響。' },
  associated: { level: 'associated', label: '相關（Associated）',
    text: '發稿前後的差異是觀察到的事實，但沒有對照組，只能說兩件事同時發生，'
      + '不能說是這場活動「造成」的；能見度是輸出面的觀察，不等於對人的成效。' },
});

export const claimFor = ({ hasComparison } = {}) => (hasComparison ? CLAIMS.associated : CLAIMS.observed);
