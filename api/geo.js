// AI 搜尋能見度（GEO）追蹤 API
//
// 定位：量測「不指名工研院的問法下，AI 答案引擎會不會、以什麼位置、引哪個網域提到工研院」，
// 並把每天的分數接成時間序列，疊上記者會／發稿事件標記，算出半衰期與基線抬升。
//
// GET  ?action=prompts&password=            題庫
// GET  ?action=events&password=             事件標記（記者會／發稿）
// GET  ?action=status&password=             今日掃描進度＋可用引擎
// GET  ?action=series&password=&days=90     時間序列 + 事件 + 衍生指標
// GET  ?action=detail&password=&date=&prompt_id=  單題原始回答（人工複核用）
// GET  ?action=cron&secret=                 排程掃描（Vercel Cron，帶 CRON_SECRET）
// POST {action, password, ...}              seed / scan / prompt_save / prompt_delete
//                                           / event_save / event_delete
//
// 誠實邊界：這裡量到的是「可用 API 的 AI 答案引擎」，不是 ChatGPT／AI Overviews 的
// 消費端畫面。它是代理指標，趨勢有效、絕對值不可對外宣稱等同某產品。

import { readRange, appendRows, updateRange, ensureSheets } from './lib/sheets.js';

const SHEETS = {
  geo_prompts: ['id', 'topic', 'prompt', 'keyword', 'brand', 'competitors', 'active', 'created_at'],
  geo_runs: ['date', 'run_at', 'prompt_id', 'topic', 'keyword', 'engine', 'mentioned', 'rank',
    'cited', 'citations', 'specifics', 'score', 'competitors_found', 'excerpt', 'error'],
  geo_events: ['id', 'date', 'title', 'type', 'keywords', 'note'],
};

const PROBE_MODEL = process.env.GEO_MODEL || 'claude-opus-5';
// 3.6 是目前的 GA Flash。3.5-flash 有回報 generateContent 偶爾漏掉 groundingMetadata 的問題，
// 所以預設不用它。
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// 判官（打分的那顆）可以跟探測分開走。沒設 ANTHROPIC_API_KEY 就自動改用 Gemini，
// 整套可以只靠 Gemini 免費額度跑，不必開 Anthropic API 帳。
const JUDGE_ENGINE = process.env.GEO_JUDGE_ENGINE
  || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.GEMINI_API_KEY ? 'gemini' : null);
const JUDGE_MODEL = process.env.GEO_JUDGE_MODEL
  || (JUDGE_ENGINE === 'gemini' ? GEMINI_MODEL : PROBE_MODEL);

const BRAND_DEFAULT = '工研院';
const OWNED_DOMAINS = ['itri.org.tw', 'itritech.itri.org.tw'];

// Vercel function maxDuration 60s。一波（4 題）含搜尋約 15–20s，
// 所以超過 35s 就不再開新的一波，避免整批被砍掉。
const WAVE_CUTOFF_MS = 35_000;
const CONCURRENCY = 4;
const MAX_ATTEMPTS_PER_DAY = 2; // 同一題同一引擎當天最多重試幾次

const todayTW = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
const nowTW = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

async function safeRead(range) {
  try { return await readRange(range); } catch { return []; }
}

/* ────────────────────────────── 引擎註冊 ────────────────────────────── */
// 有設對應 API Key 的引擎才會被掃。只有 claude 是本平台既有金鑰，其餘為選配。

// grounded=true 代表「這個引擎一定要有搜尋來源才算數」。沒有來源就不是能見度量測，
// 而是在量模型的訓練記憶——那種數字每天都一樣，畫成曲線只會騙自己。
const ENGINES = [
  { id: 'claude', label: 'Claude（含網路搜尋）', env: 'ANTHROPIC_API_KEY', grounded: true, run: probeClaude },
  { id: 'gemini', label: 'Gemini（Google 搜尋接地）', env: 'GEMINI_API_KEY', grounded: true, run: probeGemini },
  { id: 'openai', label: 'OpenAI（含網路搜尋）', env: 'OPENAI_API_KEY', grounded: true, run: probeOpenAI },
  { id: 'perplexity', label: 'Perplexity', env: 'PERPLEXITY_API_KEY', grounded: true, run: probePerplexity },
];

// GEO_ENGINES 明確指定要掃哪幾個引擎（逗號分隔）。不設就是「有金鑰就掃」。
// 這個開關存在的理由：ANTHROPIC_API_KEY 是記者問答在用的，不能拿掉，
// 但你可能不想讓 GEO 也去燒 Anthropic 的 API 錢 —— 設 GEO_ENGINES=gemini 即可。
const ENGINE_ALLOW = (process.env.GEO_ENGINES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const activeEngines = () => ENGINES.filter((e) =>
  process.env[e.env] && (!ENGINE_ALLOW.length || ENGINE_ALLOW.includes(e.id)));

/** 掃描前的前置檢查：至少要有一個探測引擎，加上一個能打分的判官 */
function readyCheck() {
  if (!activeEngines().length) {
    return '沒有任何可用引擎：請至少設定 ANTHROPIC_API_KEY 或 GEMINI_API_KEY';
  }
  if (!JUDGE_ENGINE) return '沒有可用的判官：請設 ANTHROPIC_API_KEY 或 GEMINI_API_KEY';
  return null;
}

/**
 * 引用來源統一格式：{ url, domain }。
 * domain 是「真正的來源網域」，判斷有沒有引到自家網站一律看它。
 * 這件事非做不可的理由：Gemini 接地回來的 uri 是 vertexaisearch.cloud.google.com 的轉址，
 * 真實網域藏在 title 裡；直接拿 uri 去比對，工研院永遠不會被判定為「被引用」。
 */
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const OPAQUE_HOSTS = ['vertexaisearch.cloud.google.com', 'grounding-api-redirect'];
const isOpaque = (url) => OPAQUE_HOSTS.some((h) => (url || '').includes(h));

function cite(url, domainHint) {
  const hint = String(domainHint || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { url: url || '', domain: hint || hostOf(url) };
}
/** 寫進試算表的樣子：轉址網址沒有閱讀價值，改存網域 */
const citeLabel = (c) => (!c.url || isOpaque(c.url) ? (c.domain || c.url) : c.url);

const PROBE_SYSTEM =
  '你是一般使用者日常在用的 AI 助理。請先用網路搜尋查證，再用繁體中文回答，' +
  '像平常回答陌生使用者那樣自然作答，不要條列過長。全文控制在 400 字以內。';

/* ── Anthropic ── */

async function anthropic(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Anthropic ${res.status}`);
  return data;
}

// 新版搜尋工具（含動態過濾）只在 4.6 以後的機型上；舊機型退回基本版
const webSearchTool = (model) =>
  /opus-(5|4-[678])|sonnet-(5|4-6)|fable-5|mythos-5/.test(model)
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

async function probeClaude(question) {
  const messages = [{ role: 'user', content: question }];
  let answer = '';
  const citations = [];

  // 伺服端工具跑滿內部迴圈會回 pause_turn，把 assistant 回合接回去續跑
  for (let i = 0; i < 3; i++) {
    const data = await anthropic({
      model: PROBE_MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: PROBE_SYSTEM,
      tools: [webSearchTool(PROBE_MODEL)],
      messages,
    });

    for (const b of data.content || []) {
      if (b.type === 'text') answer += b.text;
      else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        // 錯誤時 content 是物件（{error_code}），只有成功才是陣列
        b.content.forEach((r) => r?.url && citations.push(cite(r.url)));
      }
    }

    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }

  return { answer: answer.trim(), citations };
}

/* ── 其餘引擎（選配，依各家公開回應格式解析，缺欄位就當作沒有引用） ── */

async function gemini(body, model = GEMINI_MODEL) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  return data;
}

async function probeGemini(question) {
  const data = await gemini({
    systemInstruction: { parts: [{ text: PROBE_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    tools: [{ google_search: {} }],
  });

  const cand = data.candidates?.[0] || {};
  const answer = (cand.content?.parts || []).map((p) => p.text || '').join('');

  // groundingChunks[].web = { uri: <轉址>, title: <真實網域，如 itri.org.tw> }
  const gm = cand.groundingMetadata || {};
  const citations = (gm.groundingChunks || [])
    .map((c) => c.web || c.retrievedContext)
    .filter(Boolean)
    .map((w) => cite(w.uri, w.domain || w.title));

  // 有些回應把來源放在 annotations（新版格式），一併撈，撈不到就算沒有引用
  (cand.content?.parts || []).forEach((p) => {
    (p.annotations || []).forEach((a) => {
      const u = a.url || a.url_citation?.url;
      if (u) citations.push(cite(u, a.url_citation?.title));
    });
  });

  return { answer: answer.trim(), citations };
}

async function probeOpenAI(question) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5',
      instructions: PROBE_SYSTEM,
      input: question,
      tools: [{ type: 'web_search' }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);

  let answer = '';
  const citations = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (c.text) answer += c.text;
      (c.annotations || []).forEach((a) => a.url && citations.push(cite(a.url, a.title)));
    }
  }
  return { answer: (data.output_text || answer).trim(), citations };
}

async function probePerplexity(question) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL || 'sonar',
      messages: [
        { role: 'system', content: PROBE_SYSTEM },
        { role: 'user', content: question },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Perplexity ${res.status}`);

  const answer = data.choices?.[0]?.message?.content || '';
  const raw = data.citations || data.search_results?.map((s) => s.url) || [];
  return { answer: answer.trim(), citations: raw.filter(Boolean).map((u) => cite(u)) };
}

/* ────────────────────────────── 評分 ────────────────────────────── */
// 判官只做「觀察」（有沒有提到、第幾個提到、有沒有具體內容），分數一律由程式算，
// 這樣同一段回答重跑不會因為模型心情不同而給不同分。

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    mentioned: { type: 'boolean' },
    rank: { type: 'integer' },
    specifics: { type: 'boolean' },
    competitors_found: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },
  },
  required: ['mentioned', 'rank', 'specifics', 'competitors_found', 'evidence'],
  additionalProperties: false,
};

function judgePrompt({ brand, competitors, question, answer }) {
  return `以下是一段 AI 助理針對某個問題的回答。請只做客觀觀察，不要評價好壞。

【要觀察的品牌】${brand}
（同義寫法：ITRI、工業技術研究院、Industrial Technology Research Institute 都算同一個）

【對照單位】${competitors || '（未指定）'}

【問題】
${question}

【回答全文】
${answer}

請判斷：
- mentioned：回答「正文」是否提到該品牌。只出現在參考來源清單、不在正文者，算 false。
- rank：若有提到，該品牌是回答中第幾個被提到的「機構／單位／公司」（從 1 起算）。未提到填 0。
- specifics：是否針對該品牌給出具體可查證內容（技術正式名稱、數字、年份、案例名、合作對象）。
  只是名字出現在並列名單裡、沒有任何具體內容，算 false。
- competitors_found：對照單位中，實際出現在回答正文裡的有哪些（回傳名稱陣列，沒有就空陣列）。
- evidence：40 字以內的一句話說明你的判斷依據。`;
}

function parseJudge(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* 落到下面 */ } }
    throw new Error('判官回傳不是 JSON');
  }
}

async function judgeAnthropic(prompt) {
  const base = { model: JUDGE_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] };
  let data;
  try {
    data = await anthropic({
      ...base,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
    });
  } catch (err) {
    // 這個模型不吃結構化輸出就退回純文字，靠 parseJudge 救回來
    if (!/output_config|json_schema|format/i.test(err.message)) throw err;
    data = await anthropic({
      ...base,
      messages: [{ role: 'user', content: prompt + '\n\n只輸出 JSON 物件本身，不要加說明或程式碼框。' }],
    });
  }
  return parseJudge((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

async function judgeGemini(prompt) {
  const data = await gemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  }, JUDGE_MODEL);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return parseJudge(text);
}

async function judge(args) {
  if (!JUDGE_ENGINE) throw new Error('沒有可用的判官：請設 ANTHROPIC_API_KEY 或 GEMINI_API_KEY');
  const prompt = judgePrompt(args);
  return JUDGE_ENGINE === 'gemini' ? judgeGemini(prompt) : judgeAnthropic(prompt);
}

/** 能見度指數 0–100：提及 45 ＋ 位置 20 ＋ 自家網域被引 20 ＋ 有具體內容 15 */
function scoreOf({ mentioned, rank, cited, specifics }) {
  if (!mentioned) return 0;
  const rankPts = rank === 1 ? 20 : rank === 2 ? 14 : rank === 3 ? 9 : 5;
  return 45 + rankPts + (cited ? 20 : 0) + (specifics ? 15 : 0);
}

const matchesOwned = (host) =>
  !!host && OWNED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));

/** 引用來源是不是自家網域。domain 優先（Gemini 的真實網域只在這裡），再退回 url 的 host。 */
const isOwned = (c) => matchesOwned(c.domain) || matchesOwned(hostOf(c.url));

/* ────────────────────────────── 掃描 ────────────────────────────── */

const parsePrompt = (r) => ({
  id: r[0], topic: r[1] || '未分類', prompt: r[2], keyword: r[3] || r[1] || '未分類',
  brand: r[4] || BRAND_DEFAULT, competitors: r[5] || '', active: String(r[6]).toUpperCase() !== 'FALSE',
  created_at: r[7] || '',
});

/**
 * 找出今天還沒跑的 (題目 × 引擎) 組合。
 * 成功過就不再跑；失敗過但未達每日重試上限的會排回去，
 * 這樣暫時性的 API 錯誤有機會補救，壞掉的題目也不會把預算吃光。
 */
async function pendingPairs(force) {
  const [promptRows, runRows] = await Promise.all([
    safeRead('geo_prompts!A2:H'), safeRead('geo_runs!A2:O'),
  ]);
  const date = todayTW();
  const succeeded = new Set();
  const attempts = {};
  runRows.filter((r) => r[0] === date).forEach((r) => {
    const key = `${r[2]}|${r[5]}`;
    attempts[key] = (attempts[key] || 0) + 1;
    if (!r[14]) succeeded.add(key);
  });

  const prompts = promptRows.filter((r) => r[0]).map(parsePrompt).filter((p) => p.active);
  const engines = activeEngines();

  const pairs = [];
  for (const p of prompts) {
    for (const e of engines) {
      const key = `${p.id}|${e.id}`;
      const skip = succeeded.has(key) || (attempts[key] || 0) >= MAX_ATTEMPTS_PER_DAY;
      if (force || !skip) pairs.push({ prompt: p, engine: e });
    }
  }
  return { pairs, total: prompts.length * engines.length, date };
}

/** 跑一題一引擎，回傳觀察結果（不寫檔）。給 runOne 與 selftest 共用。 */
async function probeAndScore(p, engine) {
  const { answer, citations } = await engine.run(p.prompt);
  if (!answer) throw new Error('引擎沒有回傳文字');

  // 沒有任何來源 = 搜尋沒生效（額度不足、接地未開通、或模型選擇不搜尋）。
  // 這種回答是模型憑記憶講的，不能當成能見度分數記進去，否則整條曲線是假的。
  if (engine.grounded && !citations.length) {
    throw new Error('接地未生效：回應沒有任何搜尋來源，此筆不計分（請確認搜尋額度是否開通）');
  }

  const obs = await judge({
    brand: p.brand, competitors: p.competitors, question: p.prompt, answer,
  });
  const cited = citations.some(isOwned);
  const mentioned = !!obs.mentioned;
  const rank = mentioned ? Number(obs.rank) || 0 : 0;
  const specifics = mentioned && !!obs.specifics;

  return {
    answer, citations, obs, cited, mentioned, rank, specifics,
    score: scoreOf({ mentioned, rank, cited, specifics }),
  };
}

async function runOne({ prompt: p, engine }) {
  const stamp = nowTW();
  const base = [todayTW(), stamp, p.id, p.topic, p.keyword, engine.id];
  try {
    const r = await probeAndScore(p, engine);
    return [
      ...base, r.mentioned ? 'TRUE' : 'FALSE', r.rank, r.cited ? 'TRUE' : 'FALSE',
      r.citations.slice(0, 8).map(citeLabel).join(' | '),
      r.specifics ? 'TRUE' : 'FALSE', r.score,
      (r.obs.competitors_found || []).join('、'),
      r.answer.replace(/\s+/g, ' ').slice(0, 500), '',
    ];
  } catch (err) {
    return [...base, '', '', '', '', '', '', '', '', String(err.message).slice(0, 200)];
  }
}

/** 跑一批，受時間預算限制。每一波跑完就先寫回去，函式被砍也不會整批白跑。 */
async function runBatch({ force = false } = {}) {
  await ensureSheets(SHEETS);
  const started = Date.now();
  const { pairs, total, date } = await pendingPairs(force);

  let processed = 0, failed = 0, i = 0;
  while (i < pairs.length && Date.now() - started < WAVE_CUTOFF_MS) {
    const slice = pairs.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(slice.map(runOne));
    await appendRows('geo_runs!A:O', rows);
    processed += rows.length;
    failed += rows.filter((r) => r[14]).length;
    i += slice.length;
  }

  return { date, total, processed, failed, remaining: pairs.length - i };
}

/* ────────────────────────────── 時間序列與衍生指標 ────────────────────────────── */

const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 每日平均分（整體與各關鍵字），缺日補 null，另附 7 日移動平均 */
function buildSeries(runs, days) {
  const from = addDays(todayTW(), -days + 1);
  const valid = runs.filter((r) => r.date >= from && r.score !== null);

  const dates = [];
  for (let d = from; d <= todayTW(); d = addDays(d, 1)) dates.push(d);

  const keywords = [...new Set(valid.map((r) => r.keyword))].sort();
  const bucket = {};
  valid.forEach((r) => {
    (bucket[`${r.keyword}|${r.date}`] ||= []).push(r.score);
    (bucket[`__all__|${r.date}`] ||= []).push(r.score);
  });

  const lineFor = (key) => {
    const raw = dates.map((d) => {
      const b = bucket[`${key}|${d}`];
      return b ? Math.round(avg(b) * 10) / 10 : null;
    });
    // 7 日移動平均：單模型單次查詢本來就有雜訊，趨勢要看這條
    const ma = raw.map((_, i) => {
      const win = raw.slice(Math.max(0, i - 6), i + 1).filter((v) => v !== null);
      return win.length ? Math.round(avg(win) * 10) / 10 : null;
    });
    return { raw, ma };
  };

  return {
    dates,
    overall: lineFor('__all__'),
    keywords: keywords.map((k) => ({ keyword: k, ...lineFor(k) })),
  };
}

/**
 * 事件效應：基線（前 14 天）、峰值（事件日起 7 天內最高）、
 * 半衰期（峰值後掉回 (峰值+基線)/2 要幾天）、基線抬升（事件後 15–30 天 − 基線）。
 * 這四個數字就是「潤利艾克曼給不了」的部分：AI 記憶留存天數。
 */
function eventEffects(events, runs) {
  const byDate = {};
  runs.filter((r) => r.score !== null).forEach((r) => {
    (byDate[r.date] ||= []).push(r.score);
    if (r.keyword) (byDate[`${r.keyword}@${r.date}`] ||= []).push(r.score);
  });

  const dayAvg = (date, kw) => {
    const b = byDate[kw ? `${kw}@${date}` : date];
    return b ? avg(b) : null;
  };
  const rangeAvg = (from, to, kw) => {
    const vals = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = dayAvg(d, kw);
      if (v !== null) vals.push(v);
    }
    return avg(vals);
  };

  return events.map((ev) => {
    const kw = (ev.keywords || '').split(/[,，、|]/).map((s) => s.trim()).filter(Boolean)[0] || null;
    const baseline = rangeAvg(addDays(ev.date, -14), addDays(ev.date, -1), kw);

    let peak = null, peakDate = null;
    for (let i = 0; i <= 7; i++) {
      const d = addDays(ev.date, i);
      const v = dayAvg(d, kw);
      if (v !== null && (peak === null || v > peak)) { peak = v; peakDate = d; }
    }

    let halfLife = null;
    if (peak !== null && baseline !== null && peak > baseline) {
      const half = (peak + baseline) / 2;
      for (let i = 1; i <= 60; i++) {
        const d = addDays(peakDate, i);
        if (d > todayTW()) break;
        const v = dayAvg(d, kw);
        if (v !== null && v <= half) { halfLife = i; break; }
      }
    }

    const after = rangeAvg(addDays(ev.date, 15), addDays(ev.date, 30), kw);
    const round = (v) => (v === null ? null : Math.round(v * 10) / 10);

    return {
      ...ev, matchedKeyword: kw,
      baseline: round(baseline), peak: round(peak), peakDate,
      halfLifeDays: halfLife,
      lift: baseline !== null && after !== null ? round(after - baseline) : null,
      settled: after !== null,
    };
  });
}

/** 關鍵字排行：近期均分、提及率、自家網域引用率、與前一期相比的變化 */
function keywordBoard(runs, days) {
  const cut = addDays(todayTW(), -Math.floor(days / 2));
  const from = addDays(todayTW(), -days + 1);
  const valid = runs.filter((r) => r.date >= from && r.score !== null);

  const groups = {};
  valid.forEach((r) => { (groups[r.keyword] ||= []).push(r); });

  return Object.entries(groups).map(([keyword, rs]) => {
    const recent = rs.filter((r) => r.date >= cut);
    const earlier = rs.filter((r) => r.date < cut);
    const a = avg(recent.map((r) => r.score));
    const b = avg(earlier.map((r) => r.score));
    return {
      keyword,
      score: a === null ? null : Math.round(a * 10) / 10,
      delta: a === null || b === null ? null : Math.round((a - b) * 10) / 10,
      mentionRate: recent.length
        ? Math.round((recent.filter((r) => r.mentioned).length / recent.length) * 100) : null,
      citedRate: recent.length
        ? Math.round((recent.filter((r) => r.cited).length / recent.length) * 100) : null,
      samples: rs.length,
    };
  }).sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
}

const parseRun = (r) => ({
  date: r[0], run_at: r[1], prompt_id: r[2], topic: r[3], keyword: r[4], engine: r[5],
  mentioned: r[6] === 'TRUE', rank: Number(r[7]) || 0, cited: r[8] === 'TRUE',
  citations: r[9] || '', specifics: r[10] === 'TRUE',
  score: r[11] === '' || r[11] == null ? null : Number(r[11]),
  competitors: r[12] || '', excerpt: r[13] || '', error: r[14] || '',
});

const parseEvent = (r) => ({ id: r[0], date: r[1], title: r[2], type: r[3] || '記者會', keywords: r[4] || '', note: r[5] || '' });

/* ────────────────────────────── 預設題庫 ────────────────────────────── */
// 依 2026-08-02 那次 30 題實測的結論設計：真正會掉分的是「不指名」那一層，
// 所以題庫刻意不出現「工研院」三個字，只留一題指名題當對照組。

const SEED = [
  ['化合物半導體', '台灣在化合物半導體（GaN、SiC）的研發，有哪些單位走得比較前面？', '化合物半導體'],
  ['化合物半導體', '氮化鎵功率元件目前最大的技術瓶頸是什麼？誰在解？', '化合物半導體'],
  ['邊緣AI', '想在醫療影像做邊緣端 AI 推論，台灣有哪些法人或研究單位可以合作？', '邊緣AI'],
  ['邊緣AI', '最近邊緣 AI 晶片有什麼比較關鍵的突破？', '邊緣AI'],
  ['智慧醫療', '台灣的智慧醫療大平台是誰在做的？做到什麼程度？', '智慧醫療'],
  ['智慧醫療', '醫院想導入 AI 輔助診斷，第一步該找誰談？', '智慧醫療'],
  ['淨零碳排', '企業要做碳盤查與碳管理，台灣有哪些單位提供服務？', '淨零'],
  ['淨零碳排', '台灣在氫能與碳捕捉的技術進展如何？主要由誰推動？', '淨零'],
  ['機器人', '四足機器人在台灣有哪些實際落地的案例？', '機器人'],
  ['半導體先進封裝', '先進封裝的散熱問題，台灣有哪些研發成果？', '先進封裝'],
  ['產業趨勢', '今年台灣科技產業最值得注意的技術趨勢有哪些？', '產業趨勢'],
  ['對照組（指名）', '工研院在化合物半導體有哪些技術成果？', '化合物半導體'],
];

const COMPETITORS = '資策會、金屬中心、紡織所、國研院、台大、清大、成大、中科院';

/* ────────────────────────────── Handler ────────────────────────────── */

const ok = (res, data) => res.status(200).json(data);
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = process.env.ADMIN_PASSWORD;

  try {
    /* ── 排程：Vercel Cron 會帶 Authorization: Bearer $CRON_SECRET ── */
    const secret = process.env.CRON_SECRET;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const cronCall = req.query.action === 'cron' || (!!secret && bearer === secret);

    if (cronCall) {
      const passed = secret ? (bearer === secret || req.query.secret === secret)
        : req.query.password === admin;
      if (!passed) return res.status(401).json({ error: '未授權' });
      const gap = readyCheck();
      if (gap) return res.status(500).json({ error: gap });
      return ok(res, await runBatch());
    }

    /* ── 其餘一律要管理員密碼 ── */
    const password = req.method === 'GET' ? req.query.password : (req.body || {}).password;
    if (!admin || password !== admin) return res.status(401).json({ error: '密碼錯誤' });

    if (req.method === 'GET') {
      const { action, days = '90' } = req.query;

      if (action === 'prompts') {
        const rows = await safeRead('geo_prompts!A2:H');
        return ok(res, { prompts: rows.filter((r) => r[0]).map(parsePrompt) });
      }

      if (action === 'events') {
        const rows = await safeRead('geo_events!A2:F');
        return ok(res, { events: rows.filter((r) => r[0]).map(parseEvent) });
      }

      if (action === 'status') {
        const { pairs, total, date } = await pendingPairs(false);
        return ok(res, {
          date, total, remaining: pairs.length, done: total - pairs.length,
          engines: ENGINES.map((e) => ({
            id: e.id, label: e.label, env: e.env,
            enabled: activeEngines().some((a) => a.id === e.id),
            hasKey: !!process.env[e.env],
          })),
          model: activeEngines().some((e) => e.id === 'claude') ? PROBE_MODEL : GEMINI_MODEL,
          judge: JUDGE_ENGINE ? `${JUDGE_ENGINE} / ${JUDGE_MODEL}` : '（未設定）',
          ready: readyCheck(),
        });
      }

      if (action === 'series') {
        const n = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365);
        const [runRows, evRows] = await Promise.all([
          safeRead('geo_runs!A2:O'), safeRead('geo_events!A2:F'),
        ]);
        const runs = runRows.filter((r) => r[0]).map(parseRun);
        const events = evRows.filter((r) => r[0]).map(parseEvent)
          .filter((e) => e.date >= addDays(todayTW(), -n + 1))
          .sort((a, b) => a.date.localeCompare(b.date));

        const since14 = addDays(todayTW(), -13);
        const scored = runs.filter((r) => r.score !== null);
        const recent = scored.filter((r) => r.date >= since14);
        const failed14 = runs.filter((r) => r.date >= since14 && r.error).length;

        return ok(res, {
          series: buildSeries(runs, n),
          events: eventEffects(events, runs),
          board: keywordBoard(runs, n),
          summary: {
            samples: scored.length,
            lastScan: runs.length ? runs[runs.length - 1].date : null,
            score14: recent.length ? Math.round(avg(recent.map((r) => r.score)) * 10) / 10 : null,
            mentionRate14: recent.length
              ? Math.round((recent.filter((r) => r.mentioned).length / recent.length) * 100) : null,
            citedRate14: recent.length
              ? Math.round((recent.filter((r) => r.cited).length / recent.length) * 100) : null,
            failed14,
          },
        });
      }

      // 上線後先按這個：拿一題實跑到底，把原始回答、來源網域、判官觀察、算出來的分數
      // 全部攤開，但不寫進資料庫。用來確認引擎與判官真的通了、判分合理。
      if (action === 'selftest') {
        const gap = readyCheck();
        if (gap) return res.status(500).json({ error: gap });

        const rows = (await safeRead('geo_prompts!A2:H')).filter((r) => r[0]).map(parsePrompt);
        const p = rows.find((x) => x.id === req.query.prompt_id) || rows.find((x) => x.active) || rows[0];
        if (!p) return res.status(400).json({ error: '題庫是空的，請先帶入預設題目' });

        const results = await Promise.all(activeEngines().map(async (e) => {
          const t0 = Date.now();
          try {
            const r = await probeAndScore(p, e);
            return {
              engine: e.id, ok: true, ms: Date.now() - t0, score: r.score,
              mentioned: r.mentioned, rank: r.rank, cited: r.cited, specifics: r.specifics,
              evidence: r.obs.evidence || '', competitors: r.obs.competitors_found || [],
              citations: r.citations.slice(0, 10).map((c) => ({ domain: c.domain, url: c.url })),
              answer: r.answer.slice(0, 1200),
            };
          } catch (err) {
            return { engine: e.id, ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 300) };
          }
        }));

        return ok(res, {
          prompt: { id: p.id, topic: p.topic, prompt: p.prompt, keyword: p.keyword },
          judge: `${JUDGE_ENGINE} / ${JUDGE_MODEL}`, results,
        });
      }

      if (action === 'detail') {
        const { date, prompt_id } = req.query;
        const rows = await safeRead('geo_runs!A2:O');
        return ok(res, {
          runs: rows.filter((r) => r[0]).map(parseRun)
            .filter((r) => (!date || r.date === date) && (!prompt_id || r.prompt_id === prompt_id))
            .slice(-60).reverse(),
        });
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    /* ── POST ── */
    const body = req.body || {};

    if (body.action === 'seed') {
      await ensureSheets(SHEETS);
      const existing = await safeRead('geo_prompts!A2:H');
      if (existing.filter((r) => r[0]).length) {
        return res.status(409).json({ error: '題庫已有資料，請直接編輯或先刪除' });
      }
      const stamp = nowTW();
      await appendRows('geo_prompts!A:H', SEED.map(([topic, prompt, keyword]) => [
        uid('gp'), topic, prompt, keyword, BRAND_DEFAULT, COMPETITORS, 'TRUE', stamp,
      ]));
      return ok(res, { success: true, added: SEED.length });
    }

    if (body.action === 'scan') {
      const gap = readyCheck();
      if (gap) return res.status(500).json({ error: gap });
      return ok(res, await runBatch({ force: !!body.force }));
    }

    if (body.action === 'prompt_save') {
      await ensureSheets(SHEETS);
      const p = body.prompt || {};
      if (!p.prompt) return res.status(400).json({ error: '問句不能空白' });
      const rows = await safeRead('geo_prompts!A2:H');
      const idx = rows.findIndex((r) => r[0] === p.id);
      const row = [
        p.id || uid('gp'), p.topic || '未分類', p.prompt, p.keyword || p.topic || '未分類',
        p.brand || BRAND_DEFAULT, p.competitors || COMPETITORS,
        p.active === false ? 'FALSE' : 'TRUE', rows[idx]?.[7] || nowTW(),
      ];
      if (idx >= 0) await updateRange(`geo_prompts!A${idx + 2}:H${idx + 2}`, [row]);
      else await appendRows('geo_prompts!A:H', [row]);
      return ok(res, { success: true, id: row[0] });
    }

    if (body.action === 'prompt_delete') {
      const rows = await safeRead('geo_prompts!A2:H');
      const kept = rows.filter((r) => r[0] && r[0] !== body.id);
      if (rows.length) await updateRange(`geo_prompts!A2:H${rows.length + 1}`, rows.map(() => new Array(8).fill('')));
      if (kept.length) await updateRange(`geo_prompts!A2:H${kept.length + 1}`, kept);
      return ok(res, { success: true });
    }

    if (body.action === 'event_save') {
      await ensureSheets(SHEETS);
      const e = body.event || {};
      if (!e.date || !e.title) return res.status(400).json({ error: '日期與名稱為必填' });
      const rows = await safeRead('geo_events!A2:F');
      const idx = rows.findIndex((r) => r[0] === e.id);
      const row = [e.id || uid('ge'), e.date, e.title, e.type || '記者會', e.keywords || '', e.note || ''];
      if (idx >= 0) await updateRange(`geo_events!A${idx + 2}:F${idx + 2}`, [row]);
      else await appendRows('geo_events!A:F', [row]);
      return ok(res, { success: true, id: row[0] });
    }

    if (body.action === 'event_delete') {
      const rows = await safeRead('geo_events!A2:F');
      const kept = rows.filter((r) => r[0] && r[0] !== body.id);
      if (rows.length) await updateRange(`geo_events!A2:F${rows.length + 1}`, rows.map(() => new Array(6).fill('')));
      if (kept.length) await updateRange(`geo_events!A2:F${kept.length + 1}`, kept);
      return ok(res, { success: true });
    }

    return res.status(400).json({ error: `不支援的操作: ${body.action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
