// 批次 135：AI 用量紀錄補上網路搜尋（web_search）的費用。
// 背景：批次 126 把 AI 能見度掃描從 Opus 5 換成 Haiku 5.5（token 單價差 50 倍），以為大幅省錢；
// 但 web_search 是伺服器端工具、**另外按次數收費**（官方：每 1,000 次 10 美元，另加 token），
// 以前 lib/ai-usage.js 只算 token，搜尋費完全沒進帳，真正占大頭的很可能是搜尋、卻看不到。
//   一、searchCount()：從 usage.server_tool_use.web_search_requests 讀次數，拿不到一律 0、不丟例外
//   二、estimateUsd()：5 次搜尋 = 0.05 美元；沒有搜尋時跟以前一模一樣（連浮點數都相同）
//   三、logAiUsage()：有搜尋才多 ` searches=N`（接在行尾）；沒搜尋的行維持原樣——可能有人用 Vercel Logs 搜樣式
//   四、真的 api/geo.js 掃一題（假 fetch）：pause_turn 續跑每一回合各記一行、判官那行沒有 searches、掃描行為沒變
//   五、不能動的東西：max_uses 仍是 5、續跑迴圈仍是 3 回合（動了 GEO 的量尺就斷了，GEO-METHOD.md 第九節）
// 一～三只跑 lib/ai-usage.js；四掛 loader-82（假試算表），Anthropic 那端用假的 fetch。
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

register('./loader-82.mjs', import.meta.url);
process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
// 只留 Claude 一個探測引擎，判官也就走 Anthropic
for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEO_MODEL', 'CRON_SECRET']) delete process.env[k];

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const near = (a, b, eps = 1e-12) => typeof a === 'number' && Math.abs(a - b) < eps;

const attempt = (fn) => { try { return fn(); } catch (e) { return `例外：${e.message}`; } };
const AU = await import('../lib/ai-usage.js');
const { logAiUsage, WEB_SEARCH_USD_PER_1000 } = AU;
const searchCount = (u) => attempt(() => AU.searchCount(u));
const estimateUsd = (m, u) => attempt(() => AU.estimateUsd(m, u));

// 批次 135 以前的寫法，逐字抄來當對照：沒有搜尋的呼叫，新舊兩版要一字不差
// 批次 135 審查：快取讀取的倍率改成每個模型各自的單價（Sonnet 5.5 與 Opus 5.5 是 0.05x，見 lib/ai-usage.js PRICE 的說明），
// 所以對照用的舊公式也要帶「這個模型的讀取倍率」：只有 claude-sonnet-5-5 是 0.05，其餘是 0.1。
// 又因為單價改成直接的美元數（cacheRead／write5m），不再是「輸入單價 × 倍率」，浮點數的最後幾位可能跟舊公式不同——
// 所以估價用相對誤差 1e-12 比對（見 sameUsd），log 那行 toFixed(5) 之後仍要逐字相同。
const OLD_READ_MULT = { 'claude-sonnet-5-5': 0.05 };
const oldEstimate = (PRICE, model, usage) => {
  const p = PRICE[model];
  if (!p || !usage) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) * (OLD_READ_MULT[model] ?? 0.1) + (usage.cache_creation_input_tokens || 0) * 1.25;
  return (input * p.in + (usage.output_tokens || 0) * p.out) / 1e6;
};
const sameUsd = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= Math.abs(b) * 1e-12);
const OLD_PRICE = { 'claude-haiku-5-5': { in: 0.1, out: 0.5 }, 'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-sonnet-5-5': { in: 2, out: 10 }, 'claude-opus-5': { in: 5, out: 25 } };
const oldLine = (where, model, usage) => {
  if (!usage) return null;
  const usd = oldEstimate(OLD_PRICE, model, usage);
  return `[ai-usage] ${where} model=${model} in=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0} out=${usage.output_tokens || 0}${usd === null ? '' : ` usd≈${usd.toFixed(5)}`}`;
};

const logs = [];
const realLog = console.log;
const captureLogs = () => { logs.length = 0; console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[ai-usage]')) logs.push(s); else realLog(...a); }; };
const releaseLogs = () => { console.log = realLog; };
// 丟例外也要變成「一條紅字」而不是整支測試當場中斷（後面的檢查才跑得到、看得出到底壞了幾件事）
const lineOf = (where, model, usage) => attempt(() => { captureLogs(); try { logAiUsage(where, model, usage); } finally { releaseLogs(); } return logs[0]; });

/* ───────── 一、searchCount ───────── */
console.log('\n── 一、searchCount：次數在 usage.server_tool_use.web_search_requests，拿不到一律 0 ──');
{
  check('★ 讀得到次數：{ server_tool_use: { web_search_requests: 5 } } → 5', searchCount({ server_tool_use: { web_search_requests: 5 } }) === 5);
  check('　 一般的 token 欄位旁邊帶著次數也讀得到', searchCount({ input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 3 } }) === 3);
  check('　 沒有 server_tool_use 這個欄位（網頁問答、LINE、判官都是這樣）→ 0', searchCount({ input_tokens: 10, output_tokens: 5 }) === 0);
  check('　 server_tool_use 是空物件 → 0', searchCount({ server_tool_use: {} }) === 0);
  check('　 server_tool_use 是 null → 0（不丟例外）', searchCount({ server_tool_use: null }) === 0);
  check('　 web_search_requests 是 0 → 0', searchCount({ server_tool_use: { web_search_requests: 0 } }) === 0);
  check('　 usage 是 null／undefined → 0', searchCount(null) === 0 && searchCount(undefined) === 0);
  check('　 usage 不是物件（字串、數字、陣列、布林）→ 0，不丟例外', ['garbage', 42, [], true].every((u) => searchCount(u) === 0));
  check('　 次數欄位怪值（字串、NaN、負數、Infinity、null、物件）一律當 0，不當真',
    ['5', NaN, -3, Infinity, null, {}, [2]].every((n) => searchCount({ server_tool_use: { web_search_requests: n } }) === 0));
  check('　 小數取整數（次數不可能有小數，寧可少報）', searchCount({ server_tool_use: { web_search_requests: 2.9 } }) === 2);
  check('★ web_fetch 的次數不算成搜尋（web_fetch 沒有額外費用）', searchCount({ server_tool_use: { web_fetch_requests: 4 } }) === 0
    && searchCount({ server_tool_use: { web_search_requests: 2, web_fetch_requests: 4 } }) === 2);
}

/* ───────── 二、estimateUsd ───────── */
console.log('\n── 二、estimateUsd：搜尋費與 token 費相加；沒有搜尋時跟以前完全一樣 ──');
{
  const S = (n, extra = {}) => ({ ...extra, server_tool_use: { web_search_requests: n } });
  check('單價常數：每 1,000 次搜尋 10 美元', WEB_SEARCH_USD_PER_1000 === 10);
  check('★ 5 次搜尋、沒有 token = 0.05 美元（5 × 10／1000）', near(estimateUsd('claude-haiku-5-5', S(5)), 0.05), estimateUsd('claude-haiku-5-5', S(5)));
  check('　 1 次搜尋 = 0.01 美元', near(estimateUsd('claude-haiku-5-5', S(1)), 0.01));
  check('★ 搜尋費與 token 費相加：Haiku 5.5 輸入 10 萬＋輸出 1 萬＋5 次搜尋 = 0.01 + 0.005 + 0.05 = 0.065',
    near(estimateUsd('claude-haiku-5-5', S(5, { input_tokens: 100000, output_tokens: 10000 })), 0.065, 1e-9),
    estimateUsd('claude-haiku-5-5', S(5, { input_tokens: 100000, output_tokens: 10000 })));
  check('★ 搜尋費跟模型的 token 單價無關：Opus 5、Haiku 4.5、Haiku 5.5 五次搜尋都是 0.05（換便宜模型省不到這一塊）',
    ['claude-opus-5', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'].every((m) => near(estimateUsd(m, S(5)), 0.05)));
  check('　 快取讀取／寫入照常算，再加搜尋費（Sonnet 5.5：讀取 100 萬 = 0.10、5 次搜尋 = 0.05 → 0.15；讀取單價見批次 135 審查）',
    near(estimateUsd('claude-sonnet-5-5', S(5, { cache_read_input_tokens: 1e6 })), 0.15, 1e-9));
  check('　 不認得的模型不亂估：有搜尋也回 null（少了 token 那一半的總額是假數字）', estimateUsd('claude-unknown', S(5, { input_tokens: 10 })) === null);
  check('　 沒有 usage → null', estimateUsd('claude-haiku-5-5', null) === null && estimateUsd('claude-haiku-5-5', undefined) === null);

  // 舊行為對照：沒有搜尋（沒欄位／null／0）時要跟逐字抄來的舊公式「嚴格相等」，不是差不多
  const samples = [
    {}, { input_tokens: 1000 }, { output_tokens: 200 },
    { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 },
    { input_tokens: 300, cache_creation_input_tokens: 4500, output_tokens: 40 },
    { input_tokens: 123456, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 99999 },
  ];
  const withoutSearch = [(u) => u, (u) => ({ ...u, server_tool_use: null }), (u) => ({ ...u, server_tool_use: {} }), (u) => ({ ...u, server_tool_use: { web_search_requests: 0 } })];
  let same = true, detail = '';
  for (const m of Object.keys(OLD_PRICE)) for (const s of samples) for (const [i, f] of withoutSearch.entries()) {
    const a = estimateUsd(m, f(s)), b = oldEstimate(OLD_PRICE, m, s);
    if (!sameUsd(a, b)) { same = false; detail = `${m} ${JSON.stringify(f(s))} 變體${i}：新 ${a} 舊 ${b}`; }
  }
  check(`★ 沒有搜尋時估價與批次 135 以前相同（相對誤差 1e-12 內；Sonnet 5.5 的快取讀取倍率已更正為 0.05）（${Object.keys(OLD_PRICE).length} 個模型 × ${samples.length} 種 usage × ${withoutSearch.length} 種寫法）`, same, detail);
}

/* ───────── 三、logAiUsage 的格式 ───────── */
console.log('\n── 三、logAiUsage：有搜尋才多 searches=N（接在行尾），沒搜尋的行維持原樣 ──');
{
  const base = { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 };
  const noSearchLine = lineOf('測試', 'claude-opus-5', base);
  check('★ 沒有搜尋：整行跟批次 135 以前一字不差（用 Vercel Logs 搜樣式的人不受影響）',
    noSearchLine === '[ai-usage] 測試 model=claude-opus-5 in=1000 cache_read=9000 cache_write=0 out=200 usd≈0.01450', noSearchLine);
  check('　 沒有搜尋也沒有 searches=（連 searches=0 都不印）', !/searches/.test(noSearchLine));
  check('　 server_tool_use 是 null／空物件／次數 0：同樣維持原樣',
    [{ ...base, server_tool_use: null }, { ...base, server_tool_use: {} }, { ...base, server_tool_use: { web_search_requests: 0 } }].every((u) => lineOf('測試', 'claude-opus-5', u) === noSearchLine));
  check('　 web_fetch 的次數不會出現在 log（免費、本專案也沒用）', lineOf('測試', 'claude-opus-5', { ...base, server_tool_use: { web_fetch_requests: 3 } }) === noSearchLine);

  const withSearch = lineOf('AI 能見度', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 5 } });
  check('★ 有搜尋：usd≈ 含搜尋費（0.0002 + 0.05 = 0.05020），行尾多 searches=5',
    withSearch === '[ai-usage] AI 能見度 model=claude-haiku-5-5 in=1000 cache_read=0 cache_write=0 out=200 usd≈0.05020 searches=5', withSearch);
  const same = lineOf('AI 能見度', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 200 });
  check('　 有搜尋的行，searches= 前面那一段跟沒搜尋的行格式相同（只有 usd 數字不同）',
    withSearch.replace(/ searches=\d+$/, '').replace(/usd≈[\d.]+/, 'usd≈X') === same.replace(/usd≈[\d.]+/, 'usd≈X'), `${withSearch}\n${same}`);
  check('　 Vercel Logs 搜「[ai-usage] AI 能見度」與「searches=」都找得到', /^\[ai-usage\] AI 能見度 /.test(withSearch) && /searches=5$/.test(withSearch));
  const unknown = lineOf('AI 能見度', 'claude-unknown', { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 2 } });
  check('　 不認得的模型＋有搜尋：沒有 usd≈（不亂估），但 searches=2 還是看得到',
    unknown === '[ai-usage] AI 能見度 model=claude-unknown in=10 cache_read=0 cache_write=0 out=20 searches=2', unknown);
  check('　 沒有 usage → 不記（跟以前一樣）', lineOf('測試', 'claude-opus-5', undefined) === undefined && lineOf('測試', 'claude-opus-5', null) === undefined);

  // 一次對過去的寫法：各種舊格式的 usage，新舊兩版的 log 嚴格相同
  const olds = [{}, { input_tokens: 5000, cache_read_input_tokens: 4200, output_tokens: 120 }, { input_tokens: 300, cache_creation_input_tokens: 4500, output_tokens: 40 }];
  check('★ 舊格式的 usage（沒有 server_tool_use）：各模型的 log 整行與舊版逐字相同',
    ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-unknown'].every((m) => olds.every((u) => lineOf('網頁問答', m, u) === oldLine('網頁問答', m, u))));

  const weird = ['garbage', 42, [], true, { server_tool_use: 'abc' }, { server_tool_use: { web_search_requests: 'x' } }, { server_tool_use: null }]
    .map((u) => lineOf('測試', 'claude-haiku-5-5', u));
  check('★ usage 是怪東西（字串、數字、陣列、server_tool_use 是字串或 null）：不丟例外——記 log 不能把回答拖垮',
    weird.every((l) => typeof l === 'string' && l.startsWith('[ai-usage] ')), weird.join('\n'));
  check('　 usage 是字串時行為跟以前一樣（印一行全 0 的）', lineOf('測試', 'claude-haiku-5-5', 'garbage') === oldLine('測試', 'claude-haiku-5-5', 'garbage'));
}

/* ───────── 四、真的 api/geo.js 掃一題 ───────── */
console.log('\n── 四、api/geo.js 掃一題：搜尋次數自然帶出，pause_turn 續跑每一回合都有記 ──');
const S = await import('./fakes-sheets82.mjs');
const geo = (await import('../api/geo.js')).default;
const fakeRes = () => {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
};
const post = async (body) => { const r = fakeRes(); await geo({ method: 'POST', headers: {}, query: {}, body: { password: 'pw', ...body } }, r); return r; };
const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const seedScan = () => {
  S.reset();
  S.book.geo_settings = [['key', 'value']];
  S.book.geo_prompts = [['id'], ['p1', '電池', '固態電池台灣有哪些研發單位？', '電池', '工研院', '', 'TRUE', '2026-09-01']];
  S.book.geo_runs = [['date']];
};
const searchBlocks = (id) => [
  { type: 'server_tool_use', id, name: 'web_search', input: { query: '固態電池 台灣' } },
  { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A' }] },
];
// 探測請求（帶 tools）依序回 script 裡的回應；判官請求（帶結構化輸出）回固定 JSON
const JUDGE = { mentioned: true, rank: 1, specifics: true, competitors_found: ['資策會'], evidence: '第一個提到' };
const setupFetch = (probeScript) => {
  const seen = { probes: [], judges: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api.anthropic.com')) throw new Error('不該打外部服務：' + url);
    const body = JSON.parse(opts.body);
    if (body.tools) {
      seen.probes.push(body);
      const step = probeScript[Math.min(seen.probes.length - 1, probeScript.length - 1)];
      return jsonRes(step);
    }
    seen.judges++;
    return jsonRes({ content: [{ type: 'text', text: JSON.stringify(JUDGE) }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 60 } });
  };
  return seen;
};
const cited = (text) => ({ type: 'text', text, citations: [{ type: 'web_search_result_location', url: 'https://www.itri.org.tw/news', title: 'itri.org.tw' }] });
const usd5 = (inTok, outTok, searches) => ((inTok * 0.1 + outTok * 0.5) / 1e6 + (searches * 10) / 1000).toFixed(5);
{
  seedScan();
  const seen = setupFetch([
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: '先查一下。' }, ...searchBlocks('srvtoolu_1')],
      usage: { input_tokens: 12000, output_tokens: 300, server_tool_use: { web_search_requests: 3 } } },
    { stop_reason: 'end_turn', content: [cited('工研院在固態電池有成果。')],
      usage: { input_tokens: 16000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } } },
  ]);
  captureLogs();
  let r;
  try { r = await post({ action: 'scan' }); } finally { releaseLogs(); }
  check('掃描照常完成：1 筆成功、0 筆失敗（記搜尋費沒有動到掃描本身）', r.statusCode === 200 && r.body?.processed === 1 && r.body?.failed === 0, JSON.stringify(r.body));
  check('★ pause_turn 續跑：探測呼叫了 2 回合、判官 1 次，總共 3 行 [ai-usage]', seen.probes.length === 2 && seen.judges === 1 && logs.length === 3, `${seen.probes.length} ${seen.judges} ${logs.length}\n${logs.join('\n')}`);
  check('★ 第 1 回合那行帶 searches=3，usd≈ 含搜尋費',
    logs[0] === `[ai-usage] AI 能見度 model=claude-haiku-5-5 in=12000 cache_read=0 cache_write=0 out=300 usd≈${usd5(12000, 300, 3)} searches=3`, logs[0]);
  check('★ 第 2 回合（續跑）那行帶 searches=2——每一回合各記各的，不是只記最後一回合',
    logs[1] === `[ai-usage] AI 能見度 model=claude-haiku-5-5 in=16000 cache_read=0 cache_write=0 out=500 usd≈${usd5(16000, 500, 2)} searches=2`, logs[1]);
  check('★ 判官那行沒有 searches（沒用搜尋工具），格式跟批次 135 以前相同',
    logs[2] === `[ai-usage] AI 能見度 model=claude-haiku-5-5 in=800 cache_read=0 cache_write=0 out=60 usd≈${((800 * 0.1 + 60 * 0.5) / 1e6).toFixed(5)}`, logs[2]);
  const total = logs.slice(0, 2).map((l) => Number(l?.match(/searches=(\d+)/)?.[1] || 0)).reduce((a, b) => a + b, 0);
  check('　 一次探測的搜尋總次數 = 各回合相加 = 5（可以在 Vercel Logs 用 searches= 加總）', total === 5, total);
  const row = (S.book.geo_runs[1] || []);
  check('　 掃描結果照常寫進 geo_runs（提到、被引用，沒有錯誤）', row[6] === 'TRUE' && row[8] === 'TRUE' && !row[14], JSON.stringify(row));
  check('★ 送給 Anthropic 的探測請求沒變：Haiku 5.5 用基本版搜尋工具、max_uses 5、effort low',
    seen.probes.every((b) => b.model === 'claude-haiku-5-5' && b.tools[0].type === 'web_search_20250305' && b.tools[0].max_uses === 5 && b.output_config?.effort === 'low'),
    JSON.stringify(seen.probes[0]?.tools));
  check('　 續跑時把上一回合 assistant 的內容原樣接回去', seen.probes[1]?.messages?.length === 2 && seen.probes[1].messages[1].role === 'assistant'
    && seen.probes[1].messages[1].content.some((b) => b.type === 'web_search_tool_result'));
}
{
  // 連續三次 pause_turn：續跑上限仍是 3 回合（不能因為想多看幾行 log 而改迴圈），而且三回合都有記
  seedScan();
  const pause = (n) => ({ stop_reason: 'pause_turn', content: [{ type: 'text', text: '再查。' }, ...searchBlocks('srvtoolu_x')],
    usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: n } } });
  const seen = setupFetch([pause(5), pause(4), pause(1)]);
  captureLogs();
  try { await post({ action: 'scan' }); } finally { releaseLogs(); }
  const probeLines = logs.filter((l) => /searches=/.test(l));
  check('★ 連續 pause_turn：探測只呼叫 3 次（迴圈上限沒動），3 回合各一行，searches=5／4／1',
    seen.probes.length === 3 && probeLines.length === 3 && probeLines.map((l) => l.match(/searches=(\d+)/)?.[1]).join() === '5,4,1', `${seen.probes.length}\n${logs.join('\n')}`);
}
{
  // 沒有搜尋的探測（例如模型自己決定不搜尋）：usage 沒有 server_tool_use，log 維持原樣
  seedScan();
  setupFetch([{ stop_reason: 'end_turn', content: [cited('工研院有成果。')], usage: { input_tokens: 2000, output_tokens: 100 } }]);
  captureLogs();
  try { await post({ action: 'scan' }); } finally { releaseLogs(); }
  check('探測沒有 server_tool_use 欄位：log 沒有 searches=，也不出錯', logs.length === 2 && logs.every((l) => !/searches=/.test(l)), logs.join('\n'));
}
{
  // usage 欄位是 null（API 出錯時）：logAiUsage 不記、掃描照常走錯誤路徑
  seedScan();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 529 });
  captureLogs();
  let r;
  try { r = await post({ action: 'scan' }); } finally { releaseLogs(); }
  check('API 回錯誤（沒有 usage）：不記 log、掃描把錯誤寫進該筆，整批不炸', logs.length === 0 && r.statusCode === 200 && r.body?.failed === 1, `${logs.length} ${JSON.stringify(r.body)}`);
}

/* ───────── 四之二、備援發生時，被拒的那幾個回合也要算進帳（批次 135 審查 API-2）───────── */
console.log('\n── 四之二、usage.iterations：伺服器端備援時，被拒的回合另外計費，頂層 usage 只含答的那一回合 ──');
{
  // 形狀照官方 refusals-and-fallback 頁（Billing and rate limits 一節）的範例：被拒的是 type:'message'，答的是 type:'fallback_message'
  const served = { input_tokens: 412, output_tokens: 264, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const withIt = (iterations) => ({ ...served, iterations });
  const declinedBig = { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 5000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const servedIt = { type: 'fallback_message', model: 'claude-sonnet-5', ...served };
  const U = AU;
  const d1 = U.declinedAttempts(withIt([declinedBig, servedIt]));
  check('★ declinedAttempts：被拒的 message 回合算進來（5000 輸入 × $2／百萬 = 0.01），答的 fallback_message 不重複算', d1.count === 1 && near(d1.usd, 0.01, 1e-12), JSON.stringify(d1));
  check('★ logAiUsage：備援時 usd≈ 是所有回合合計（答的 Sonnet 5：412×2＋264×10 → 0.003464；加被拒的 0.01 → 0.01346），行尾多 attempts=2',
    lineOf('LINE 問答', 'claude-sonnet-5', withIt([declinedBig, servedIt])) === '[ai-usage] LINE 問答 model=claude-sonnet-5 in=412 cache_read=0 cache_write=0 out=264 usd≈0.01346 attempts=2',
    lineOf('LINE 問答', 'claude-sonnet-5', withIt([declinedBig, servedIt])));
  check('　 estimateUsd 本身仍只算頂層（答的那一回合），不偷偷變成合計——兩個數字各有各的意思', near(estimateUsd('claude-sonnet-5', withIt([declinedBig, servedIt])), 0.003464, 1e-9), estimateUsd('claude-sonnet-5', withIt([declinedBig, servedIt])));
  check('★ 中途被拒（有輸出）的回合一定計費：輸出 800 × $10／百萬 = 0.008 也算進來',
    near(U.declinedAttempts(withIt([{ ...declinedBig, output_tokens: 800 }, servedIt])).usd, 0.01 + 0.008, 1e-12));
  check('★ 沒有 fallback_message 就不是備援：iterations 只有一個 message（一般回應）→ 不加、不出 attempts=',
    U.declinedAttempts(withIt([{ ...declinedBig, model: 'claude-sonnet-5' }])).count === 0
      && lineOf('LINE 問答', 'claude-sonnet-5', withIt([{ ...declinedBig, model: 'claude-sonnet-5' }])) === lineOf('LINE 問答', 'claude-sonnet-5', served));
  check('　 黏著路由（sticky）：只有 fallback_message、沒有被拒的回合 → 不加、不出 attempts=',
    lineOf('LINE 問答', 'claude-sonnet-5', withIt([servedIt])) === lineOf('LINE 問答', 'claude-sonnet-5', served));
  check('　 被拒的回合用它自己的模型估價（Haiku 5.5 的 5000 輸入 = 0.0005，不是 Sonnet 的 0.01）', near(U.declinedAttempts(withIt([{ ...declinedBig, model: 'claude-haiku-5-5' }, servedIt])).usd, 0.0005, 1e-12));
  check('★ 被拒的模型不在價目表：usd≈ 整個拿掉（不湊一個少了一塊的假總額），attempts=2 與 token 數仍看得到',
    lineOf('LINE 問答', 'claude-sonnet-5', withIt([{ ...declinedBig, model: 'claude-mystery-9' }, servedIt])) === '[ai-usage] LINE 問答 model=claude-sonnet-5 in=412 cache_read=0 cache_write=0 out=264 attempts=2',
    lineOf('LINE 問答', 'claude-sonnet-5', withIt([{ ...declinedBig, model: 'claude-mystery-9' }, servedIt])));
  check('　 iterations 是怪東西（null、字串、物件、裡面有 null 或沒有 type）：不丟例外、當作沒有',
    [null, 'x', {}, [null], [{}], [{ type: 'fallback_message' }, null, 5]].every((it) => { const l = lineOf('測試', 'claude-sonnet-5', withIt(it)); return typeof l === 'string' && l.startsWith('[ai-usage] '); }));
  check('　 沒有 iterations 的一般回應：整行跟以前一字不差（沒有 attempts=）', !/attempts=/.test(lineOf('LINE 問答', 'claude-sonnet-5-5', { input_tokens: 300, cache_read_input_tokens: 30000, output_tokens: 400 })));
}

/* ───────── 五、不能動的東西 ───────── */
console.log('\n── 五、「只做看得到」：掃描行為的旋鈕沒有被動到 ──');
{
  const GEO = src('api/geo.js');
  const code = GEO.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // 去掉註解再比
  check('★ max_uses 仍是 5，兩個版本的搜尋工具都是（改了 GEO 的量尺就斷了，GEO-METHOD.md 第九節）',
    (code.match(/max_uses:\s*5\b/g) || []).length === 2 && (code.match(/max_uses/g) || []).length === 2);
  check('★ pause_turn 續跑迴圈仍是最多 3 回合', /for \(let i = 0; i < 3; i\+\+\) \{\s*const data = await anthropic\(\{\s*model: PROBE_MODEL/.test(code));
  check('★ anthropic() 把整包 data.usage 交給 logAiUsage（不是挑幾個欄位——挑了就帶不出 server_tool_use）',
    /logAiUsage\('AI 能見度', body\.model, data\.usage\)/.test(code));
  check('　 api/geo.js 沒有自己另外算搜尋費或 log（單價與格式只住在 lib/ai-usage.js）', !/web_search_requests|searches=|WEB_SEARCH_USD/.test(code));
  const usage = src('lib/ai-usage.js');
  check('　 lib/ai-usage.js 檔頭寫了官方來源網址與「待核對」的兩件事',
    /platform\.claude\.com\/docs\/en\/agents-and-tools\/tool-use\/web-search-tool/.test(usage) && /【待核對】/.test(usage) && /pause_turn/.test(usage));
}

/* ───────── 五之二、api/geo.js：模型拒答不是「沒被提到」（批次 134 審查 API-3）───────── */
console.log('\n── 五之二、api/geo.js 遇到 stop_reason:"refusal"：記成錯誤列、不計分（以前被當成正常的「沒被提到」）──');
{
  process.env.LINE_ADMIN_USER_ID = 'Uadmin';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
  const U0 = { input_tokens: 1000, output_tokens: 50 };
  const REF = (category = 'general_harms', content = []) => ({ stop_reason: 'refusal', stop_details: category === null ? null : { type: 'refusal', category, explanation: '測試' }, content, usage: U0 });
  const linePushes = [];
  // 判官請求（沒帶 tools）固定回「沒被提到」，若真的被呼叫就能從 judges 看出來（拒答時不該呼叫）
  const run = async (probeScript, { judgeRes } = {}) => {
    seedScan();
    linePushes.length = 0;
    const seen = { probes: 0, judges: 0, gemini: 0 };
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('https://api.line.me/')) { linePushes.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); }
      if (u.startsWith('https://generativelanguage.googleapis.com/')) {
        seen.gemini++;
        return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify(JUDGE) }] }, finishReason: 'STOP' }] });
      }
      if (!u.startsWith('https://api.anthropic.com')) throw new Error('不該打外部服務：' + u);
      const body = JSON.parse(opts.body);
      if (body.tools) return jsonRes(probeScript[Math.min(seen.probes++, probeScript.length - 1)]);
      seen.judges++;
      return jsonRes(judgeRes || { content: [{ type: 'text', text: JSON.stringify({ mentioned: false, rank: 0, specifics: false, competitors_found: [], evidence: '' }) }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 60 } });
    };
    captureLogs();
    const origWarn = console.warn; const warns = [];
    console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
    let r;
    try { r = await post({ action: 'scan' }); } finally { releaseLogs(); console.warn = origWarn; }
    return { r, seen, row: S.book.geo_runs[1] || [], warns };
  };
  const isErrorRow = (row) => !!row[14] && row[6] === '' && row[11] === '';

  const g1 = await run([REF('frontier_llm')]);
  check('★ 輸出前被攔下（content 是空的）：寫成錯誤列、不計分，錯誤訊息講明是拒答（refusal）', g1.r.body?.failed === 1 && isErrorRow(g1.row) && /refusal/.test(g1.row[14]) && /拒答/.test(g1.row[14]), JSON.stringify(g1.row));
  check('　 沒有呼叫判官（拒答的探測不該再花一次判官的錢）', g1.seen.judges === 0, g1.seen.judges);
  check('★ 記一行 [ai-refusal]：哪一條路、哪個模型、分類、（沒有場次）', g1.warns.some((l) => l === '[ai-refusal] where=AI 能見度 model=claude-haiku-5-5 category=frontier_llm event=-'), g1.warns.join('|'));
  check('★ 拒答不是金鑰／額度問題：沒有 LINE 通知給管理員', linePushes.length === 0, JSON.stringify(linePushes));

  const g2 = await run([REF('general_harms', [{ type: 'text', text: '我先查一下。' }, ...searchBlocks('s1'), { type: 'text', text: '根據搜尋結果，台灣的固態電池研發單位' }])]);
  check('★ 搜尋之後、帶著半截文字被攔下：整題作廢，不是「mentioned=FALSE、score=0」的正常觀察（審查重現過：processed=1 failed=0）',
    g2.r.body?.failed === 1 && isErrorRow(g2.row) && g2.row[13] === '' && g2.seen.judges === 0, JSON.stringify(g2.row));

  const g3 = await run([
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: '先查一下。' }, ...searchBlocks('s1')], usage: U0 },
    REF(null)
  ]);
  check('★ pause_turn 續跑到第二回合才被攔（category 是 null 也一樣）：前面累積的前導句不能拿來當答案，整題作廢',
    g3.seen.probes === 2 && g3.r.body?.failed === 1 && isErrorRow(g3.row) && g3.row[13] === '' && g3.seen.judges === 0, `${g3.seen.probes} ${JSON.stringify(g3.row)}`);
  check('　 category 是 null 照樣記 log（category=null）', g3.warns.some((l) => /^\[ai-refusal\] where=AI 能見度 .*category=null/.test(l)), g3.warns.join('|'));

  const ctl = await run([{ stop_reason: 'end_turn', content: [cited('工研院有成果。')], usage: U0 }]);
  check('　 （對照）沒被攔的探測照常計分、沒有錯誤、沒有 [ai-refusal]', ctl.r.body?.failed === 0 && !ctl.row[14] && ctl.warns.every((l) => !l.startsWith('[ai-refusal]')), JSON.stringify(ctl.row));

  // 判官被攔：只有 Anthropic 一家 → 錯誤列（訊息含 refusal）；另一家判官（Gemini）有金鑰 → isSwitchable 認得，換 Gemini 判
  const judgeRef = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: '測試' }, content: [], usage: { input_tokens: 800, output_tokens: 0 } };
  const okProbe = [{ stop_reason: 'end_turn', content: [cited('工研院有成果。')], usage: U0 }];
  const j1 = await run(okProbe, { judgeRes: judgeRef });
  check('★ 判官被攔下、沒有別家可換：這一題記成錯誤列（訊息含 refusal），不是算出一個分數', j1.r.body?.failed === 1 && isErrorRow(j1.row) && /refusal/.test(j1.row[14]), JSON.stringify(j1.row));
  check('　 判官被攔也記 [ai-refusal]', j1.warns.some((l) => /^\[ai-refusal\] where=AI 能見度 model=claude-haiku-5-5 category=general_harms/.test(l)), j1.warns.join('|'));

  process.env.GEMINI_API_KEY = 'g-key';
  seedScan();
  await post({ action: 'settings_save', engines: ['claude'], judge: 'anthropic' });   // 只掃 Claude，判官指定 Anthropic，Gemini 金鑰只當替補判官
  const j2 = await run(okProbe, { judgeRes: judgeRef });
  check('★ isSwitchable 認得拒答：Anthropic 判官被攔 → 換 Gemini 判官，這一題照常計分（提到、排第 1）',
    j2.seen.gemini === 1 && j2.r.body?.failed === 0 && j2.row[6] === 'TRUE' && Number(j2.row[7]) === 1 && !j2.row[14], `${j2.seen.gemini} ${JSON.stringify(j2.row)}`);
  await post({ action: 'settings_save', engines: [], judge: '' });
  delete process.env.GEMINI_API_KEY;
  delete process.env.LINE_ADMIN_USER_ID;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const src134 = src('api/geo.js');
  check('　 isSwitchable 的比對式寫明 refusal；anthropic() 在 !res.ok 之後才看拒答（金鑰警報不被吃掉）',
    /const isSwitchable[\s\S]{0,200}refusal/.test(src134) && src134.indexOf('reportAiFailure({ status: res.status') < src134.indexOf('if (isRefusal(data))'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 135 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
