// lib/geo-benchmark.js 的純函式測試——不碰網路，直接餵 parseRun() 形狀的假 run。
//
// 這支要擋的是同一件事的兩種版本：**在沒有資料支撐的情況下，畫面上長出一個看起來
// 像結論的東西**。不管是「樣本只有 4 天卻顯示向上箭頭」，還是「窗內只掃到 1 題
// 卻在同業對照圖上畫出一個 100% 的尖峰」，出事的方式都一樣——有人截圖傳給記者。
// 所以下面的斷言大部分不是在測「算得對不對」，是在測「資料不夠時有沒有閉嘴」。

import { buildPeerSeries, selfTrend } from '../lib/geo-benchmark.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

const TODAY = '2026-09-17';
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** 造一天份的 run。hit=工研院被提到幾筆，comps=每筆的對手欄 */
function day(date, { n = 4, hit = 0, comps = [], score = 60, error = '' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    date, prompt_id: `p${i}`, keyword: 'kw', engine: 'gemini',
    mentioned: i < hit, rank: i < hit ? 1 : 0, cited: false, specifics: false,
    competitors: comps[i] ?? comps[0] ?? '',
    score: error ? null : (i < hit ? score : 0), error,
  }));
}
const flat = (arr) => arr.flat();

console.log('── buildPeerSeries：同業資料從既有的 competitors 欄長出來，不用另外查 ──');
{
  // 20 天，每天 4 題，工研院被提到 2 題；資策會每天都被點名 3 次、台大 1 次
  const runs = flat(Array.from({ length: 20 }, (_, k) =>
    day(addDays(TODAY, -19 + k), { n: 4, hit: 2, comps: ['資策會', '資策會', '資策會、台大', ''] })));
  const p = buildPeerSeries(runs, 30, TODAY);

  check('日期軸長度＝天數', p.dates.length === 30, String(p.dates.length));
  check('日期軸最後一天是 today', p.dates[p.dates.length - 1] === TODAY, p.dates.at(-1));
  check('工研院自己有一條線', p.self.name === '工研院');
  check('工研院提及率＝2/4＝50%', p.self.rate[p.self.rate.length - 1] === 50, String(p.self.rate.at(-1)));
  check('資策會被挑成對照機構', p.peers.some((x) => x.name === '資策會'), JSON.stringify(p.peers.map((x) => x.name)));
  check('資策會提及率＝3/4＝75%',
    p.peers.find((x) => x.name === '資策會')?.rate.at(-1) === 75,
    JSON.stringify(p.peers.find((x) => x.name === '資策會')?.rate.slice(-3)));
  check('對照機構依被提到次數由多到少排', p.peers[0].mentions >= (p.peers[1]?.mentions ?? 0),
    JSON.stringify(p.peers.map((x) => [x.name, x.mentions])));
  check('ready=true', p.ready === true);
}

console.log('── buildPeerSeries：同一家的不同寫法要併成一列 ──');
{
  // 「資策會 MIC」「資策會產業情報研究所」「III」講的是同一家
  const runs = flat(Array.from({ length: 10 }, (_, k) =>
    day(addDays(TODAY, -9 + k), { n: 3, hit: 1, comps: ['資策會 MIC', '資策會產業情報研究所（MIC）', 'III'] })));
  const p = buildPeerSeries(runs, 14, TODAY);
  const iii = p.peers.filter((x) => x.name === '資策會');
  check('三種寫法併成同一列', iii.length === 1, JSON.stringify(p.peers.map((x) => x.name)));
  check('併完提及率是 100% 不是 33%', iii[0]?.rate.at(-1) === 100, String(iii[0]?.rate.at(-1)));
}

console.log('── buildPeerSeries：工研院自己絕對不能出現在對照機構那一排 ──');
{
  // 判官偶爾會把「工研院材化所」寫進 competitors_found
  const runs = flat(Array.from({ length: 10 }, (_, k) =>
    day(addDays(TODAY, -9 + k), { n: 3, hit: 2, comps: ['工研院材化所', '工業技術研究院', '台大'] })));
  const p = buildPeerSeries(runs, 14, TODAY);
  check('對照機構裡沒有工研院', !p.peers.some((x) => x.name.includes('工研院') || x.name.includes('工業技術研究院')),
    JSON.stringify(p.peers.map((x) => x.name)));
  check('工研院提及率仍以判官的 mentioned 為準（2/3≈66.7）',
    p.self.rate.at(-1) === 66.7, String(p.self.rate.at(-1)));
}

console.log('── buildPeerSeries：樣本太少的那幾天要斷線，不能畫出尖峰 ──');
{
  // 只有最後一天有資料，而且只有 1 題、還剛好被提到 → 天真的算法會畫出 100% 的尖峰
  const runs = day(TODAY, { n: 1, hit: 1, comps: ['台大'] });
  const p = buildPeerSeries(runs, 30, TODAY);
  check('窗內樣本 < 3 → 提及率是 null（斷線）', p.self.rate.at(-1) === null, String(p.self.rate.at(-1)));
  check('整條線都是 null 時 ready=false', p.ready === false);
  check('被提到 1 次的機構不會被拱成「對照基準」', p.peers.length === 0,
    JSON.stringify(p.peers.map((x) => [x.name, x.mentions])));
}

console.log('── buildPeerSeries：掃失敗的 run 不能算進分母 ──');
{
  // 前 10 天正常（-16～-7），接著 7 天引擎全掛（-6～今天，score=null）。
  // 失敗的算進分母的話，所有人的提及率會一起往下掉，看起來像大家同時變差——
  // 那是我們的爬蟲壞了，不是能見度變差，而這種誤會沒有人查得出來。
  const good = flat(Array.from({ length: 10 }, (_, k) =>
    day(addDays(TODAY, -16 + k), { n: 4, hit: 4, comps: ['台大'] })));
  const broken = flat(Array.from({ length: 7 }, (_, k) =>
    day(addDays(TODAY, -6 + k), { n: 4, hit: 0, comps: [''], error: 'timeout' })));
  const p = buildPeerSeries([...good, ...broken], 30, TODAY);

  const lastReal = p.dates.indexOf(addDays(TODAY, -7));
  check('全部掃成功的那幾天是 100%', p.self.rate[lastReal] === 100, String(p.self.rate[lastReal]));
  // 壞掉第 3 天：滾動窗裡還留著前面幾天的有效樣本，線要靠那些樣本撐住，不是掉到 0
  const mid = p.dates.indexOf(addDays(TODAY, -4));
  check('剛開始壞的那幾天靠窗內殘存樣本撐住，不是 0%', p.self.rate[mid] === 100, String(p.self.rate[mid]));
  check('整個窗都壞掉之後才斷線（null，不是 0%）', p.self.rate.at(-1) === null, String(p.self.rate.at(-1)));
}

console.log('── selfTrend：資料不夠時，連數字都不給前端 ──');
{
  const runs = flat(Array.from({ length: 4 }, (_, k) =>
    day(addDays(TODAY, -3 + k), { n: 4, hit: 4, score: 70 })));
  const t = selfTrend(runs, TODAY);
  check('label 是 null', t.label === null, String(t.label));
  check('dir 是 null', t.dir === null, String(t.dir));
  check('current／baseline／delta 全是 null——前端想畫也沒得畫',
    t.current === null && t.baseline === null && t.delta === null,
    JSON.stringify({ current: t.current, baseline: t.baseline, delta: t.delta }));
  check('有講清楚還差多少天', /還在累積/.test(t.reason || '') && /4 天/.test(t.reason || ''), t.reason);
  check('回報已掃到幾天，讓畫面能顯示進度', t.baseScannedDays === 4, String(t.baseScannedDays));
}

console.log('── selfTrend：本週明顯比過去好 → 上升 ──');
{
  // 前 23 天 40 分，最近 7 天 80 分
  const old = flat(Array.from({ length: 23 }, (_, k) =>
    day(addDays(TODAY, -29 + k), { n: 4, hit: 4, score: 40 })));
  const now = flat(Array.from({ length: 7 }, (_, k) =>
    day(addDays(TODAY, -6 + k), { n: 4, hit: 4, score: 80 })));
  const t = selfTrend([...old, ...now], TODAY);
  check('label＝上升', t.label === '上升', JSON.stringify(t));
  check('dir＝up', t.dir === 'up');
  check('本週均分＝80', t.current === 80, String(t.current));
  check('30 天基線含本週，所以基線被拉高到 40 與 80 之間',
    t.baseline > 40 && t.baseline < 80, String(t.baseline));
  check('delta＝本週 − 基線，且為正', t.delta > 0 && Math.abs(t.delta - (t.current - t.baseline)) < 0.11,
    JSON.stringify({ current: t.current, baseline: t.baseline, delta: t.delta }));
}

console.log('── selfTrend：本週明顯比過去差 → 下降 ──');
{
  const old = flat(Array.from({ length: 23 }, (_, k) =>
    day(addDays(TODAY, -29 + k), { n: 4, hit: 4, score: 80 })));
  const now = flat(Array.from({ length: 7 }, (_, k) =>
    day(addDays(TODAY, -6 + k), { n: 4, hit: 4, score: 30 })));
  const t = selfTrend([...old, ...now], TODAY);
  check('label＝下降', t.label === '下降', JSON.stringify(t));
  check('delta 是負的', t.delta < 0, String(t.delta));
}

console.log('── selfTrend：差一點點不算漲跌（死區），不然每天都在報假消息 ──');
{
  // 前 23 天 60 分，最近 7 天 61 分：差 1 分，且被 30 天窗重疊再拉平
  const old = flat(Array.from({ length: 23 }, (_, k) =>
    day(addDays(TODAY, -29 + k), { n: 4, hit: 4, score: 60 })));
  const now = flat(Array.from({ length: 7 }, (_, k) =>
    day(addDays(TODAY, -6 + k), { n: 4, hit: 4, score: 61 })));
  const t = selfTrend([...old, ...now], TODAY);
  check('label＝持平', t.label === '持平', JSON.stringify(t));
  check('dir＝flat', t.dir === 'flat');
  check('持平時 delta 還是照實給（不是 0）', t.delta !== null, String(t.delta));
}

console.log('── selfTrend：掃失敗的 run 不列入計算 ──');
{
  const good = flat(Array.from({ length: 30 }, (_, k) =>
    day(addDays(TODAY, -29 + k), { n: 4, hit: 4, score: 55 })));
  const broken = flat(Array.from({ length: 30 }, (_, k) =>
    day(addDays(TODAY, -29 + k), { n: 2, hit: 0, error: 'timeout' })));
  const t = selfTrend([...good, ...broken], TODAY);
  check('均分不被失敗的 run 拉成 0', t.current === 55 && t.baseline === 55,
    JSON.stringify({ current: t.current, baseline: t.baseline }));
}


/* ────────────────────────────────────────────────────────────────────────────
 * 畫面層：把 public/geo.html 的 <script> 抓出來，配一個最小的假 DOM 真的跑。
 *
 * 上面測的是「後端算完之後不給數字」，這裡測的是「就算給了，畫面也不會自己生一個」。
 * 兩層都要測：這個專案在同一個形狀上踩過四次——prompt 照做九成九，剩下那一次就是
 * 被截圖傳出去的那一次。畫面也一樣，差別只在它壞得更安靜。
 * ──────────────────────────────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/geo.html', import.meta.url), 'utf8');
const code = [...html.matchAll(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/module/.test(m[1])).map((m) => m[2])
  .sort((a, b) => b.length - a.length)[0];

const els = new Map();
const makeEl = (id) => ({
  id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {},
  addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 920, height: 300 }),
  setAttribute() {}, getAttribute: () => null,
  querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {},
});
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { reload() {}, href: '', search: '' },
  confirm: () => true, alert() {}, addEventListener() {}, removeEventListener() {},
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  document: {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: makeEl,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// 頂層的 let／const 不會掛到 global 上（只有函式宣告會），補一小段尾巴把狀態接出來——
// 跑的還是 public/geo.html 裡那段原程式，沒有另外抄一份。
runInNewContext(code + `
;globalThis.__S = () => S;
;globalThis.__PEER_PALETTE = PEER_PALETTE;
`, sandbox);

const $ = (id) => sandbox.document.getElementById(id);

console.log('── 畫面：樣本不夠時，KPI 卡片上不能長出箭頭或數字 ──');
{
  const thin = { current: null, baseline: null, delta: null, dir: null, label: null,
    baseDays: 30, baseScannedDays: 4, minBaseDays: 10, reason: '還在累積：近 30 天只掃到 4 天，滿 10 天才算得出基準' };
  const out = sandbox.trendBadge(thin);
  check('沒有向上／向下箭頭的 class', !/trend (up|down)/.test(out), out);
  check('沒有箭頭圖示', !/arrow-(up|down)/.test(out), out);
  check('把「還在累積」原話寫出來，讓人知道要等什麼', /還在累積/.test(out) && /只掃到 4 天/.test(out), out);
  check('trend 為 undefined（舊版後端）時回空字串，不是壞掉的畫面', sandbox.trendBadge(undefined) === '');
}

console.log('── 畫面：真的上升時才畫上升 ──');
{
  const up = sandbox.trendBadge({ current: 62.4, baseline: 55.1, delta: 7.3, dir: 'up', label: '上升', baseDays: 30 });
  check('class＝trend up', /class="trend up"/.test(up), up);
  check('有 + 號，不會看成下降', /\+7\.3/.test(up), up);
  check('有把基準寫出來，不是只丟一個箭頭', /近 30 天/.test(up) && /55\.1/.test(up), up);
  const down = sandbox.trendBadge({ current: 40, baseline: 55, delta: -15, dir: 'down', label: '下降', baseDays: 30 });
  check('下降用 down 的樣式', /class="trend down"/.test(down), down);
  const flatB = sandbox.trendBadge({ current: 55.6, baseline: 55, delta: 0.6, dir: 'flat', label: '持平', baseDays: 30 });
  check('持平不用漲跌顏色', /class="trend flat"/.test(flatB), flatB);
}

console.log('── 畫面：同業圖在資料不足時，一條線都不能畫 ──');
{
  Object.assign(sandbox.__S(), {
    data: { peers: { ready: false, samples: 2, dates: [], self: {}, peers: [] }, events: [] },
    peerOn: null,
  });
  sandbox.renderPeerChips();
  sandbox.renderPeerChart();
  check('SVG 裡沒有任何線', !/<path/.test($('peer-chart').innerHTML), $('peer-chart').innerHTML.slice(0, 120));
  check('chip 也不要出現', $('peer-chips').innerHTML === '', $('peer-chips').innerHTML);
  check('說明講清楚在等什麼', /還在累積/.test($('peer-note').innerHTML), $('peer-note').innerHTML);
}

console.log('── 畫面：有資料時，預設只畫自己＋前三名，其餘留在 chip 上 ──');
{
  const dates = Array.from({ length: 10 }, (_, i) => addDays(TODAY, -9 + i));
  const line = (v) => dates.map(() => v);
  Object.assign(sandbox.__S(), { peerOn: null, data: {
    events: [],
    peers: {
      ready: true, samples: 120, window: 7, dates, windowSamples: dates.map(() => 28),
      self: { key: '工研院', name: '工研院', mentions: 60, rate: line(50) },
      peers: [
        { key: '資策會', name: '資策會', mentions: 40, rate: line(40) },
        { key: '台大', name: '台大', mentions: 30, rate: line(30) },
        { key: '中研院', name: '中研院', mentions: 20, rate: line(20) },
        { key: '成大', name: '成大', mentions: 10, rate: line(10) },
      ],
    },
  } });
  sandbox.renderPeerChips();
  sandbox.renderPeerChart();
  const svg = $('peer-chart').innerHTML;
  check('畫出四條線（自己＋前三名）', (svg.match(/<path/g) || []).length === 4, String((svg.match(/<path/g) || []).length));
  check('第五家（成大）的顏色沒出現在圖上', !svg.includes(sandbox.__PEER_PALETTE[3]), sandbox.__PEER_PALETTE[3]);
  check('五家都有 chip 可以自己開', (($('peer-chips').innerHTML.match(/<button/g) || []).length) === 5,
    $('peer-chips').innerHTML);
  check('工研院那條是實線，對照機構是虛線',
    /stroke-width="2.8"/.test(svg) && /stroke-dasharray="6 4"/.test(svg), svg.slice(0, 200));
  check('縱軸標成 %，不會被當成能見度指數', /100%<\/text>/.test(svg), svg.slice(0, 300));
  check('說明有講對照機構是自動挑的', /自動挑/.test($('peer-note').innerHTML), $('peer-note').innerHTML);

  sandbox.togglePeer(4);
  check('點第五家之後畫出五條線', (($('peer-chart').innerHTML.match(/<path/g) || []).length) === 5);
  sandbox.togglePeer(0);
  check('自己也可以關掉（要比兩家對手時）', (($('peer-chart').innerHTML.match(/<path/g) || []).length) === 4);
}

console.log('── 畫面：未登記機構的名稱是 AI 寫什麼存什麼，不能直接進 HTML ──');
{
  const dates = Array.from({ length: 10 }, (_, i) => addDays(TODAY, -9 + i));
  const nasty = '<img src=x onerror=alert(1)>';
  Object.assign(sandbox.__S(), { peerOn: null, data: {
    events: [],
    peers: {
      ready: true, samples: 50, window: 7, dates, windowSamples: dates.map(() => 20),
      self: { key: '工研院', name: '工研院', mentions: 30, rate: dates.map(() => 50) },
      peers: [{ key: nasty, name: nasty, mentions: 9, rate: dates.map(() => 20) }],
    },
  } });
  sandbox.renderPeerChips();
  const chips = $('peer-chips').innerHTML;
  check('機構名稱有跳脫，沒有原封不動的標籤', !chips.includes('<img'), chips);
  check('onclick 只帶索引，名稱不進屬性', /onclick="togglePeer\(\d+\)"/.test(chips) && !/onclick="[^"]*img/.test(chips), chips);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} GEO 基準線測試（含畫面）通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
