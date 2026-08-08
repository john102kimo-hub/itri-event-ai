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
  geo_events: ['id', 'date', 'title', 'type', 'keywords', 'note', 'itri_event_id'],
  geo_settings: ['key', 'value'],
};

const PROBE_MODEL = process.env.GEO_MODEL || 'claude-opus-5';
// 3.6 是目前的 GA Flash。3.5-flash 有回報 generateContent 偶爾漏掉 groundingMetadata 的問題，
// 所以預設不用它。
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';

const BRAND_DEFAULT = '工研院';

/**
 * 設定放在試算表，不放環境變數 —— Vercel 只需要填 API 金鑰，其餘都在網頁上點。
 * CFG 在每次請求開頭載入一次。
 */
const CFG = { engines: null, judge: null, loaded: false };

async function loadSettings() {
  if (CFG.loaded) return CFG;
  try {
    const rows = await readRange('geo_settings!A2:B');
    rows.forEach(([k, v]) => {
      if (k === 'engines') CFG.engines = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (k === 'judge') CFG.judge = String(v || '').trim() || null;
      if (k === 'staff_code') CFG.staffCode = String(v || '').trim() || null;
    });
  } catch { /* 分頁還沒建就用預設 */ }
  CFG.loaded = true;
  return CFG;
}

/** 設定分頁用 key 定位寫入，避免不同設定互相覆蓋 */
async function saveSetting(key, value) {
  await ensureSheets(SHEETS);
  const rows = await safeRead('geo_settings!A2:B');
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) await updateRange(`geo_settings!A${idx + 2}:B${idx + 2}`, [[key, value]]);
  else await appendRows('geo_settings!A:B', [[key, value]]);
}

/** 判官預設挑免費的那顆：有 Gemini 金鑰就用 Gemini，沒有才退回 Anthropic */
const judgeEngine = () =>
  CFG.judge || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);
const judgeModel = () => (judgeEngine() === 'gemini' ? GEMINI_MODEL : PROBE_MODEL);
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

/** 要掃哪些引擎：網頁上勾選的優先，沒設定過就是「有金鑰的全開」 */
const activeEngines = () => ENGINES.filter((e) =>
  process.env[e.env] && (!CFG.engines || !CFG.engines.length || CFG.engines.includes(e.id)));

/** 掃描前的前置檢查：至少要有一個探測引擎，加上一個能打分的判官 */
function readyCheck() {
  const withKey = ENGINES.filter((e) => process.env[e.env]);
  if (!withKey.length) {
    return '還沒有任何 API 金鑰。到 Vercel 環境變數填 GEMINI_API_KEY 或 OPENAI_API_KEY（ANTHROPIC_API_KEY 已經有了）。';
  }
  if (!activeEngines().length) return '所有引擎都被關掉了，到下方「設定」至少打開一個。';
  if (!judgeEngine()) return '沒有可用的判官模型。';
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
    signal: AbortSignal.timeout(15_000), // probeClaude 有 pause_turn 續跑迴圈，單次呼叫上限抓緊一點
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
  const citations = [];      // 模型「實際引用」的來源（text block 的 citations 欄位）
  const searchResults = [];  // 搜尋引擎回傳的候選結果清單，只用來確認接地有沒有生效，不算引用

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
      if (b.type === 'text') {
        answer += b.text;
        // text block 的 citations 才是模型「真的引用」的來源；web_search_tool_result
        // 只是搜尋引擎回傳的候選清單（每次搜尋最多約 10 筆）——把候選清單當成引用，
        // 會讓自家網域只要出現在搜尋結果裡就白拿分，跟其他引擎的真引用不是同一件事。
        (b.citations || []).forEach((c) => c?.url && citations.push(cite(c.url, c.title)));
      } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        // 錯誤時 content 是物件（{error_code}），只有成功才是陣列
        b.content.forEach((r) => r?.url && searchResults.push(cite(r.url)));
      }
    }

    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }

  return { answer: answer.trim(), citations, searchResults };
}

/* ── 其餘引擎（選配，依各家公開回應格式解析，缺欄位就當作沒有引用） ── */

async function gemini(body, model = GEMINI_MODEL) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }
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
    signal: AbortSignal.timeout(20_000),
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
    signal: AbortSignal.timeout(20_000),
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

【這個領域常見的相關單位（僅供參考，不是完整名單，且這份參考名單偏向法人／學研機構，
不代表只該找這一類——回答裡出現名單以外的機構、或民間企業，一樣要抓出來，不要被這份名單的味道帶偏）】
${competitors || '（未提供，靠你自己判斷回答裡點名了哪些機構）'}

【問題】
${question}

【回答全文】
${answer}

請判斷：
- mentioned：回答「正文」是否提到該品牌。只出現在參考來源清單、不在正文者，算 false。
- rank：若有提到，該品牌是回答中第幾個被提到的「機構／單位／公司」（從 1 起算）。未提到填 0。
- specifics：是否針對該品牌給出具體可查證內容（技術正式名稱、數字、年份、案例名、合作對象）。
  只是名字出現在並列名單裡、沒有任何具體內容，算 false。
- competitors_found：回答正文裡，除了${brand}之外，被明確點名的機構／單位／公司有哪些——
  政府法人／學研機構（如工研院、資策會、大學）與**民間企業**（不論台灣本地或跨國、不論大廠或新創）都算，
  不限於上面那份參考名單，名單外的一樣要列出來；只列被明確點名的，不要列「業界」「相關單位」這種泛稱（回傳名稱陣列，沒有就空陣列）。
  **同一家只列一次，而且要寫成母機構最常見的正式簡稱**：不要寫它底下的所／中心，也不要用英文縮寫
  （例：「資策會產業情報研究所」「資策會 MIC」「MIC」一律寫「資策會」；「工研院材化所」寫「工研院」）。
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

async function askAnthropic(prompt, schema, maxTokens, model = judgeModel()) {
  const base = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  let data;
  try {
    data = await anthropic({
      ...base,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
  } catch (err) {
    // 這個模型不吃結構化輸出就退回純文字，靠 parseJudge 救回來
    if (!/output_config|json_schema|format/i.test(err.message)) throw err;
    data = await anthropic({
      ...base,
      messages: [{ role: 'user', content: prompt + '\n\n只輸出 JSON 物件本身，不要加說明或程式碼框。' }],
    });
  }
  // 跟 askGemini 同一個坑：max_tokens 中途截斷時 API 仍回 200，
  // 內容看似有結構、實際欄位是空的或直接不是合法 JSON。明確擋下來讓上層重試，
  // 不要讓半殘的結果流到前端變成「有標籤沒內容」的空白卡片。
  if (data.stop_reason === 'max_tokens') {
    throw new Error('回應被 token 上限截斷，請再試一次');
  }
  return parseJudge((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

/**
 * Gemini 3.x 的思考 token 是算在 maxOutputTokens 裡的。實測一題 1,500 的預算，
 * 思考就吃掉 1,436，JSON 只寫到一半就 MAX_TOKENS 截斷 —— 表面症狀是「回傳不是 JSON」，
 * 而且會隨機發生。所以要壓低思考層級，同時把上限開大。
 */
async function askGemini(prompt, maxTokens, model = judgeModel()) {
  const budget = Math.max(maxTokens * 3, 6000);
  const base = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: budget },
  };

  let data;
  try {
    data = await gemini({
      ...base,
      generationConfig: { ...base.generationConfig, thinkingConfig: { thinkingLevel: 'low' } },
    }, model);
  } catch (err) {
    // 舊機型不吃 thinkingLevel，就純靠放大上限
    if (!/thinking|invalid argument/i.test(err.message)) throw err;
    data = await gemini(base, model);
  }

  const c = data.candidates?.[0] || {};
  const text = (c.content?.parts || []).map((p) => p.text || '').join('');
  if (c.finishReason === 'MAX_TOKENS') {
    throw new Error(`回應被 token 上限截斷（思考用了 ${data.usageMetadata?.thoughtsTokenCount ?? '?'} tokens），請再試一次`);
  }
  return parseJudge(text);
}

/** 這類錯誤換一家就有機會成功（額度用完、金鑰失效、服務暫時掛掉） */
const isSwitchable = (m) =>
  /RESOURCE_EXHAUSTED|quota|credit|429|401|403|UNAUTHENTICATED|permission|5\d\d/i.test(String(m));

/**
 * 要 JSON 的內部呼叫都走這裡。
 *
 * 會自動換一家的理由：判官掛掉會讓整批掃描全滅，而不是少一筆。
 * 實際踩過 —— Gemini 預付額度用完，連純文字都 429，如果不退回 Anthropic，
 * 那天的資料就整天都是空的。
 */
async function askJSON(prompt, schema, maxTokens = 1000) {
  const primary = judgeEngine();
  if (!primary) throw new Error('沒有可用的模型：請先在 Vercel 填一把 API 金鑰');

  const run = (eng) => (eng === 'gemini'
    ? askGemini(prompt, maxTokens, GEMINI_MODEL)
    : askAnthropic(prompt, schema, maxTokens, PROBE_MODEL));

  try {
    return await run(primary);
  } catch (err) {
    const alt = primary === 'gemini' ? 'anthropic' : 'gemini';
    const altKey = alt === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!process.env[altKey] || !isSwitchable(err.message)) throw err;

    try {
      return await run(alt);
    } catch (err2) {
      throw new Error(`${primary} 判官失敗（${String(err.message).slice(0, 90)}），`
        + `改用 ${alt} 也失敗（${String(err2.message).slice(0, 90)}）`);
    }
  }
}

const judge = (args) => askJSON(judgePrompt(args), JUDGE_SCHEMA);

/* ── 由關鍵字生題 ── */
// 四種問法直接來自 2026-08-02 那次 30 題實測：指名問幾乎滿分，
// 一旦不指名就掉到接近 0——而那才是新廠商、新記者、新人真正會問的那一層。

const ANGLES = [
  { id: 'who', label: '找單位', hint: '這個領域有哪些研發單位／誰做得比較前面' },
  { id: 'partner', label: '找合作', hint: '我想做這件事，可以找誰合作' },
  { id: 'bottleneck', label: '找解方', hint: '這個技術的瓶頸是什麼、誰在解' },
  { id: 'news', label: '找新聞', hint: '最近有什麼突破或進展' },
];

const GEN_SCHEMA = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { angle: { type: 'string' }, prompt: { type: 'string' } },
        required: ['angle', 'prompt'],
        additionalProperties: false,
      },
    },
    competitors: { type: 'array', items: { type: 'string' } },
  },
  required: ['prompts', 'competitors'],
  additionalProperties: false,
};

const BRAND_RE = /工研院|工業技術研究院|ITRI/i;

function genPrompt(keyword) {
  return `你要為「AI 搜尋能見度追蹤」設計探測問句。

【關鍵字】${keyword}

請產生 4 個問句，模擬台灣的記者、廠商、想找合作對象的人，真的會拿去問 AI 的話。

四個問句各對應一種角度（angle 欄請填對應代號）：
${ANGLES.map((a) => `- ${a.id}（${a.label}）：${a.hint}`).join('\n')}

規則：
- **問句裡絕對不能出現「工研院」「工業技術研究院」「ITRI」**。指名就變成自問自答，量到的分數沒有意義。
- 也不要出現任何特定機構名稱，要讓 AI 自己決定講誰。
- 用繁體中文，口語、像真人在打字問問題，不要寫成考題或標題。
- 每句 15～45 字。
- 貼著台灣的產業情境問，不要問成國際泛論。

另外列出 competitors：在這個關鍵字領域，**台灣本地**最常和工研院被相提並論的
4～8 個單位（法人、大學研究中心、企業研究院都算）。要具體到會出現在報導裡的名稱，
例如「陽明交大」「成大晶體研究中心」「鴻海研究院」，不要寫「各大學」這種泛稱。
不要把工研院自己列進去。

輸出 JSON：{"prompts":[{"angle":"who","prompt":"…"}, …],"competitors":["…","…"]}`;
}

async function generatePrompts(keyword) {
  const out = await askJSON(genPrompt(keyword), GEN_SCHEMA, 1500);
  const seen = new Set();
  const clean = (out.prompts || [])
    .map((p) => ({
      angle: ANGLES.find((a) => a.id === p.angle)?.label || '其他',
      prompt: String(p.prompt || '').trim(),
    }))
    // 保險：模型還是寫進品牌名的話直接丟掉，不要讓它污染題庫
    .filter((p) => p.prompt.length >= 8 && !BRAND_RE.test(p.prompt))
    .filter((p) => !seen.has(p.prompt) && seen.add(p.prompt));

  if (clean.length < 2) {
    throw new Error('生出來的題目不合格（可能都提到了工研院），請再按一次或換個關鍵字');
  }

  // 對照單位若沒生出來就退回通用名單，總比空的好。
  // 先過一次正規化：這份名單會原封不動送進判官當範例，寫法歪了它就跟著歪。
  const competitors = canonList((out.competitors || [])
    .map((s) => String(s || '').trim())
    .filter((s) => s && s.length <= 20 && !BRAND_RE.test(s)));

  return { prompts: clean, competitors: competitors.length ? competitors : COMPETITORS.split('、') };
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

/* ────────────────────────────── 單位名稱正規化 ──────────────────────────────
 * 同一家機構在 AI 回答裡會有一堆寫法：「資策會 MIC」「資策會產業情報研究所」
 * 「資策會產業情報研究所（MIC）」講的是同一家。不合併的話，話語權排行會把一家拆成三列，
 * 每一列都被低估、名次整個失真——這是這張表最容易被當場問倒的地方。
 *
 * 只在「讀出來算」的時候合併，geo_runs 一律照 AI 原話存。舊資料不必搬、規則改了重算就對，
 * 也還原得回 AI 究竟是怎麼寫的。
 *
 * 兩層，順序不能顛倒：
 *  1) normOrgKey()：全形轉半形、拿掉括號註記與「財團法人／股份有限公司」這類修飾詞、去空白標點。
 *     沒登記在表裡的單位也吃得到——寫法差異只要落在這一層就會自己併起來。
 *  2) ORG_MAP：把清洗後的字串收斂成對外要顯示的正式簡稱。中文用「包含核心詞」比對，
 *     所以底下的所／中心（資策會產業情報研究所、工研院產科國際所）會自動歸到母體；
 *     英文縮寫要求整串相等，免得 III、MIC 這種短字串誤傷別人。
 * 表裡沒有、清洗後也不同的，一律各自保留——寧可多一列，不要亂併。
 */

// [對外顯示的正式簡稱, 中文核心詞（包含即算）, 英文縮寫（整串相等才算）]
// 要加新單位就往這裡加一列，不必動任何邏輯。
const ORG_MAP = [
  ['工研院', ['工研院', '工業技術研究院'], ['itri']],
  ['資策會', ['資策會', '資訊工業策進會'], ['iii', 'mic']],
  ['國研院', ['國研院', '國家實驗研究院'], ['narlabs']],
  ['中科院', ['中科院', '中山科學研究院'], ['ncsist']],
  ['中研院', ['中研院', '中央研究院'], ['sinica', 'academiasinica']],
  ['金屬中心', ['金屬中心', '金屬工業研究發展中心'], ['mirdc']],
  ['紡織所', ['紡織所', '紡織產業綜合研究所'], ['ttri']],
  ['生技中心', ['生技中心', '生物技術開發中心'], ['dcb']],
  ['食品所', ['食品所', '食品工業發展研究所'], ['firdi']],
  ['精密機械中心', ['精密機械中心', '精密機械研究發展中心'], ['pmc']],
  ['塑膠中心', ['塑膠中心', '塑膠工業技術發展中心'], ['pidc']],
  ['車輛中心', ['車輛中心', '車輛研究測試中心'], ['artc']],
  ['台經院', ['台經院', '台灣經濟研究院'], ['tier']],
  ['中經院', ['中經院', '中華經濟研究院'], ['cier']],
  ['台大', ['台灣大學', '台大'], ['ntu']],
  ['清大', ['清華大學', '清大'], ['nthu']],
  ['陽明交大', ['陽明交通大學', '陽明交大', '交通大學'], ['nycu', 'nctu']],
  ['成大', ['成功大學', '成大'], ['ncku']],
  ['台科大', ['台灣科技大學', '台科大'], ['ntust']],
  ['中央大學', ['中央大學'], ['ncu']],
  ['中興大學', ['中興大學'], ['nchu']],
  ['中山大學', ['中山大學'], ['nsysu']],
  ['台積電', ['台積電', '台灣積體電路'], ['tsmc']],
  ['聯電', ['聯電', '聯華電子'], ['umc']],
  ['聯發科', ['聯發科'], ['mediatek']],
  ['鴻海', ['鴻海', '富士康'], ['foxconn']],
  ['日月光', ['日月光'], ['ase']],
  ['台達電', ['台達電'], ['delta', 'deltaelectronics']],
  ['廣達', ['廣達'], ['quanta']],
  ['緯創', ['緯創'], ['wistron']],
];

// 判官被交代過不要回泛稱，但偶爾還是會漏一兩個。這種東西進了排行榜就是雜訊。
const NOT_ORG = new Set(['業界', '產業界', '學界', '相關單位', '政府', '廠商', '企業', '法人',
  '研究單位', '學研機構', '產學研', '國內廠商', '國外廠商', '多家業者', '台灣', '其他']);

function normOrgKey(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  // 全形英數與標點 → 半形（（MIC）會在這一步變成 (mic)，下一步才吃得到）
  t = t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .toLowerCase();
  t = t.replace(/[(【[][^)】\]]*[)】\]]/g, '');       // 括號註記整段拿掉
  t = t.replace(/財團法人|社團法人|股份有限公司|有限公司|國立|私立/g, '');
  t = t.replace(/臺/g, '台');
  return t.replace(/[\s·・．.,，、。;；:：\-–—_/／\\|｜'"「」『』]/g, '');
}

// 展平成「核心詞 → 正式簡稱」，長的先比：短詞先命中會把「台灣科技大學」搶去對「台大」
const ORG_TOKENS = ORG_MAP
  .flatMap(([canon, cores]) => cores.map((t) => ({ canon, t: normOrgKey(t) })))
  .filter((x) => x.t).sort((a, b) => b.t.length - a.t.length);
const ORG_ABBR = new Map(ORG_MAP
  .flatMap(([canon, , abbrs = []]) => abbrs.map((a) => [a.toLowerCase(), canon])));

const _orgCache = new Map();
/** 一個單位名稱 →｛用來歸戶的 key、要顯示的名稱、有沒有登記在表裡｝ */
function resolveOrg(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (_orgCache.has(s)) return _orgCache.get(s);
  const k = normOrgKey(s);
  let out;
  if (!k || NOT_ORG.has(k)) out = { key: '', name: '', known: false };
  else {
    const canon = ORG_ABBR.get(k) || (ORG_TOKENS.find((x) => k.includes(x.t)) || {}).canon;
    out = canon ? { key: canon, name: canon, known: true } : { key: k, name: s, known: false };
  }
  _orgCache.set(s, out);
  return out;
}

const BRAND_KEY = resolveOrg(BRAND_DEFAULT).key;

/** 一串名稱 → 收斂過、去重過的正式名稱陣列。給題目的對照名單與自我測試用。 */
const canonList = (arr) => [...new Set((arr || [])
  .map((s) => resolveOrg(s).name).filter(Boolean))];

/**
 * 把一批 run 的 competitors 欄位收斂成 Map(key → { name, n, variants })。
 * 同一列裡多種寫法指到同一家只算一次——不先去重的話，合併反而會把那家灌水。
 */
function tallyOrgs(rows) {
  const acc = new Map();
  rows.forEach((r) => {
    const seen = new Set();
    String(r.competitors || '').split(/[、,，;；|｜/／]/)
      .map((s) => s.trim()).filter(Boolean)
      .forEach((raw) => {
        const o = resolveOrg(raw);
        // 品牌自己不能出現在對手列（「工研院材化所」也算工研院），
        // 否則同一家會被拆成「工研院」和它底下的所，兩列各自被低估。
        if (!o.key || o.key === BRAND_KEY) return;
        const e = acc.get(o.key) || { name: o.name, known: o.known, n: 0, variants: new Set() };
        // 出現過的寫法全部留著（合併說明要列給主管看），但同一列同一家只計 1 次——
        // 一列裡同時寫了「資策會 MIC」和「資策會產業情報研究所」還算兩次的話，合併反而變灌水。
        e.variants.add(raw.replace(/\s+/g, ''));
        if (!seen.has(o.key)) { seen.add(o.key); e.n += 1; }
        // 沒登記的單位就用最短的寫法當代表，通常那個最乾淨
        if (!e.known && o.name.length < e.name.length) e.name = o.name;
        acc.set(o.key, e);
      });
  });
  return acc;
}

/* ────────────────────────────── 掃描 ────────────────────────────── */

const parsePrompt = (r) => ({
  id: r[0], topic: r[1] || '未分類', prompt: r[2], keyword: r[3] || r[1] || '未分類',
  brand: r[4] || BRAND_DEFAULT, competitors: r[5] || '', active: String(r[6]).toUpperCase() !== 'FALSE',
  created_at: r[7] || '',
});

/**
 * 每個 cron 呼叫受 WAVE_CUTOFF_MS 限制，題庫大時一次呼叫掃不完全部組合
 * （例如只有一個引擎、30 題時，一次呼叫大約只能掃 8 題）。
 * 若每天都固定從第一題開始掃，後面掃不到的題目會永遠掃不到——
 * 不是隨機的，是同一批題目每天都輪空。
 * 這裡把起點依「今年第幾天」輪動，讓每天的起點不同，
 * 掃不完的缺口會在幾天內轉移、而不是固定卡死在同一批題目上。
 */
function rotateForToday(arr) {
  if (arr.length < 2) return arr;
  const d = new Date(todayTW() + 'T00:00:00Z');
  const startOfYear = new Date(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - startOfYear) / 86400000);
  const offset = dayOfYear % arr.length;
  return [...arr.slice(offset), ...arr.slice(0, offset)];
}

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

  const prompts = rotateForToday(promptRows.filter((r) => r[0]).map(parsePrompt).filter((p) => p.active));
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
  const { answer, citations, searchResults = [] } = await engine.run(p.prompt);
  if (!answer) throw new Error('引擎沒有回傳文字');

  // 沒有任何來源 = 搜尋沒生效（額度不足、接地未開通、或模型選擇不搜尋）。
  // 這種回答是模型憑記憶講的，不能當成能見度分數記進去，否則整條曲線是假的。
  // （searchResults 只有 Claude 會有值：就算這題沒有真引用，只要搜尋確實跑過，接地就算有生效。）
  if (engine.grounded && !citations.length && !searchResults.length) {
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

    const result = {
      ...ev, matchedKeyword: kw,
      baseline: round(baseline), peak: round(peak), peakDate,
      halfLifeDays: halfLife,
      lift: baseline !== null && after !== null ? round(after - baseline) : null,
      settled: after !== null,
    };

    // 這場活動窗期內的實際樣本 → 給診斷用
    const to = addDays(ev.date, 30);
    const windowRuns = runs.filter((r) =>
      r.score !== null && r.date >= ev.date && r.date <= to && (!kw || r.keyword === kw));

    result.findings = [...diagnoseEvent(result), ...diagnose(windowRuns)];
    result.windowSamples = windowRuns.length;
    return result;
  });
}

/* ────────────────────────────── 診斷與建議 ────────────────────────────── */
/**
 * 把觀察到的失分模式，對應到 2026-08-02 那次 30 題實測整理出的「發稿前八個勾」。
 * 全部用規則算，不叫模型寫建議：一來免費，二來不會每次講得不一樣，
 * 三來每條建議都能追回到是哪個數字觸發的。
 */
function diagnose(rs) {
  const n = rs.length;
  if (n < 3) return [{ level: 'info', title: '樣本還不夠', why: `目前只有 ${n} 筆，至少累積 3 筆再看結論。`, todo: '再掃幾天。' }];

  const pct = (f) => Math.round((rs.filter(f).length / n) * 100);
  const mention = pct((r) => r.mentioned);
  const cited = pct((r) => r.cited);
  const mentionedRuns = rs.filter((r) => r.mentioned);
  const specifics = mentionedRuns.length
    ? Math.round((mentionedRuns.filter((r) => r.specifics).length / mentionedRuns.length) * 100) : null;
  const ranks = mentionedRuns.map((r) => r.rank).filter((x) => x > 0);
  const avgRank = ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;

  const out = [];

  if (mention < 30) {
    out.push({
      level: 'bad', title: `不指名就幾乎不存在（提及率 ${mention}%）`,
      why: '這一層正是新廠商、新記者、新人才會問的問法。指名問答得很好，不代表這裡拿得到分。',
      todo: '下次發稿把工研院寫成**主詞**，不要被「攜手」成受詞；動詞用開發／建立／技轉／量產，不要用「共同推動」。',
    });
  } else if (mention < 60) {
    out.push({
      level: 'warn', title: `提及率偏低（${mention}%）`,
      why: '一半以上的問法答不到工研院。',
      todo: '檢查這個主題的新聞稿，關鍵那句話拿掉上下文還看不看得懂。',
    });
  }

  if (specifics !== null && specifics < 40 && mention >= 30) {
    out.push({
      level: 'bad', title: `名字進去了，內容沒進去（具體度 ${specifics}%）`,
      why: '被寫成「工研院、A、B、C」的並列名單，AI 複述得出名字卻講不出你做了什麼。這是最常見的失分。',
      todo: '每則稿至少放一個**可查證的數字**（成本、功耗、良率、時程），技術寫正式名稱，並在並列句後補一句區辨語。',
    });
  }

  if (cited < 20) {
    out.push({
      level: 'bad', title: `自家網域幾乎沒被引用（${cited}%）`,
      why: 'AI 引的是別人的頁面在講你，主體很容易被寫成「台灣研發團隊」，名字就掉了。',
      todo: '這個主題要有一個**獨立單一主題頁**可以連，乾淨語意化網址，優先投 i創（itritech.itri.org.tw）。',
    });
  } else if (cited < 50) {
    out.push({
      level: 'warn', title: `自家網域引用率 ${cited}%`,
      why: '有被引到，但不穩定。',
      todo: '確認那頁有一句可以整句抄走的話。',
    });
  }

  if (avgRank !== null && avgRank > 2.5) {
    out.push({
      level: 'warn', title: `被排在別人後面（平均第 ${avgRank.toFixed(1)} 個提到）`,
      why: '排序反映的是 AI 覺得誰比較是這題的答案。',
      todo: '把工研院的角色寫得比同框單位更具體，不要只掛名。',
    });
  }

  if (!out.length) {
    out.push({
      level: 'good', title: '這個主題目前守得住',
      why: `提及率 ${mention}%、自家網域引用率 ${cited}%${specifics !== null ? `、具體度 ${specifics}%` : ''}。`,
      todo: '維持現況，把這個主題的寫法當範本套到其他主題。',
    });
  }
  return out;
}

/** 針對單一事件的額外建議：看的是留存，不是當下聲量 */
function diagnoseEvent(ev) {
  const out = [];
  if (ev.halfLifeDays !== null && ev.halfLifeDays <= 7) {
    out.push({
      level: 'warn', title: `聲量掉得快（半衰期 ${ev.halfLifeDays} 天）`,
      why: '衝上去又掉回來，通常代表只有活動當天的即時新聞，沒有留下可被反覆引用的頁面。',
      todo: '活動後 3 天內補一頁獨立技術頁，並回頭確認關鍵那句話有沒有被寫進報導。',
    });
  }
  if (ev.settled && ev.lift !== null && ev.lift <= 0) {
    out.push({
      level: 'bad', title: '這場沒有留下基線抬升',
      why: '30 天後回到原點，等於這場記者會對 AI 的長期記憶沒有貢獻。',
      todo: '下一場改變作法：發稿當天同步上線一個獨立主題頁，不要只靠媒體轉載。',
    });
  }
  if (ev.settled && ev.lift !== null && ev.lift > 5) {
    out.push({
      level: 'good', title: `基線被抬升了 +${ev.lift}`,
      why: '這場真的改變了 AI 對這個主題的長期認知，不只是當天熱度。',
      todo: '把這場的發稿與落地頁作法記錄下來，當成之後的範本。',
    });
  }
  return out;
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
      findings: diagnose(recent.length >= 3 ? recent : rs),
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

const parseEvent = (r) => ({
  id: r[0], date: r[1], title: r[2], type: r[3] || '記者會',
  keywords: r[4] || '', note: r[5] || '', itri_event_id: r[6] || '',
});

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = process.env.ADMIN_PASSWORD;

  try {
    await loadSettings();

    /* ── 排程 ──
     * 有設 CRON_SECRET 就照它驗（最嚴謹）。沒設的話，認 Vercel 排程自己帶的
     * user-agent —— 這樣使用者不必為了讓排程能動而多填一個環境變數。
     * 這個端點只會回傳掃描筆數，不吐任何資料。 */
    const secret = process.env.CRON_SECRET;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const fromVercelCron = /vercel-cron/i.test(req.headers['user-agent'] || '');
    const cronCall = req.query.action === 'cron' || (!!secret && bearer === secret);

    if (cronCall) {
      // calibrate=1：每月固定日子多跑幾輪，force 略過「今天已成功」的略過邏輯，
      // 跟當天正常那一輪一起被 buildSeries 平均起來，當天的分數等於多次取樣的平均，
      // 用來對照單次取樣的雜訊有多大（不改變其餘日子的每日一次取樣，成本不變）。
      const calibrate = req.query.calibrate === '1';
      const strongAuth = secret
        ? (bearer === secret || req.query.secret === secret)
        : (!!admin && req.query.password === admin);
      // User-Agent 是任何人都能偽造的標頭，只用它放行「一般批次」；
      // calibrate（force 全量重掃、會跳過當天去重）一律要求 CRON_SECRET 或管理員密碼，
      // 否則一行偽造 UA 的 curl 就能無限重跑、燒光探測用的 API 額度。
      const passed = strongAuth || (!calibrate && fromVercelCron);
      if (!passed) return res.status(401).json({ error: '未授權' });
      const gap = readyCheck();
      if (gap) return res.status(500).json({ error: gap });
      return ok(res, await runBatch({ force: calibrate }));
    }

    /* ── 身分：管理員（密碼）或同仁（專用連結的 code）──
     * 同仁能開追蹤、能掃、能看結果與建議；不能改設定、不能刪東西、
     * 也拿不到後台密碼。 */
    const q = req.method === 'GET' ? req.query : (req.body || {});
    // 管理員密碼優先讀 header（GET 用這個，避免留在網址列／瀏覽器歷史裡）；
    // code 是同仁的專屬連結碼，設計上本來就要能放在網址裡分享，維持走 query/body。
    const password = req.method === 'GET' ? (req.headers['x-admin-password'] || q.password) : q.password;
    const code = String(q.code || '').trim();

    let role = null;
    if (admin && password === admin) role = 'admin';
    else if (code && CFG.staffCode && code === CFG.staffCode) role = 'staff';
    if (!role) return res.status(401).json({ error: code ? '這條連結已失效，請向承辦人索取新的' : '密碼錯誤' });

    const ADMIN_ONLY = new Set([
      'settings_save', 'staff_link', 'prompt_delete', 'event_delete', 'seed', 'detail', 'keycheck',
    ]);
    const wanted = req.method === 'GET' ? q.action : q.action;
    if (role !== 'admin' && ADMIN_ONLY.has(wanted)) {
      return res.status(403).json({ error: '這個動作只有承辦人可以做' });
    }

    if (req.method === 'GET') {
      const { action, days = '90' } = req.query;

      if (action === 'prompts') {
        const rows = await safeRead('geo_prompts!A2:H');
        return ok(res, { prompts: rows.filter((r) => r[0]).map(parsePrompt) });
      }

      if (action === 'events') {
        const rows = await safeRead('geo_events!A2:G');
        return ok(res, { events: rows.filter((r) => r[0]).map(parseEvent) });
      }

      /**
       * 現況快照：今天這個議題各家 AI 怎麼回答。
       * 存在的理由 —— 趨勢圖沒辦法回溯（沒有人保存「上個月 AI 怎麼講」的歷史），
       * 但「現在的狀況＋該改什麼」掃一次就有，不必等好幾天。
       */
      if (action === 'snapshot') {
        const kw = String(req.query.keyword || '').trim();
        const rows = (await safeRead('geo_runs!A2:O')).filter((r) => r[0]).map(parseRun)
          .filter((r) => !kw || r.keyword === kw);
        if (!rows.length) return ok(res, { keyword: kw, engines: [], findings: [], scored: 0 });

        const latestDate = rows[rows.length - 1].date;
        const today = rows.filter((r) => r.date === latestDate);
        const scored = today.filter((r) => r.score !== null);

        const byEngine = {};
        today.forEach((r) => { (byEngine[r.engine] ||= []).push(r); });

        return ok(res, {
          keyword: kw, date: latestDate, scored: scored.length,
          engines: Object.entries(byEngine).map(([engine, list]) => {
            const good = list.filter((r) => r.score !== null);
            return {
              engine,
              score: good.length ? Math.round(avg(good.map((r) => r.score))) : null,
              mentioned: good.filter((r) => r.mentioned).length,
              cited: good.filter((r) => r.cited).length,
              total: list.length,
              failed: list.filter((r) => r.error).length,
              sampleError: list.find((r) => r.error)?.error || '',
            };
          }),
          findings: diagnose(scored),
        });
      }

      /**
       * 金鑰健檢：每個有金鑰的引擎各打一次最便宜的呼叫，把「金鑰有沒有效」和
       * 「搜尋接地有沒有開通」分開講清楚。
       * 這兩件事的症狀都是「不能用」，但一個要換金鑰、一個要去綁帳單，
       * 沒分開就只能瞎猜。
       */
      if (action === 'keycheck') {
        const results = await Promise.all(ENGINES.map(async (e) => {
          if (!process.env[e.env]) {
            return { engine: e.id, label: e.label, env: e.env, state: 'nokey',
              msg: '還沒填金鑰' };
          }
          try {
            const r = await e.run('台灣有哪些研發單位？一句話就好。');
            if (!r.citations.length) {
              return { engine: e.id, label: e.label, env: e.env, state: 'nosearch',
                msg: '金鑰有效，但這次回應沒有帶任何搜尋來源' };
            }
            return { engine: e.id, label: e.label, env: e.env, state: 'ok',
              msg: `正常，取得 ${r.citations.length} 筆來源` };
          } catch (err) {
            const m = String(err.message || '');
            let state = 'error', msg = m.slice(0, 220);

            if (/RESOURCE_EXHAUSTED|quota|429|prepay|credit/i.test(m)) {
              state = 'noquota';
              msg = e.id === 'gemini'
                ? '金鑰有效，但「Google 搜尋接地」沒有額度可用。兩種可能：'
                  + '(1) 專案還在免費層——免費層不含搜尋接地；'
                  + '(2) 已經是付費層但預付額度用完了。'
                  + '兩種都是到 ai.studio/projects 的 Billing 處理（儲值或啟用付費）。'
                  + '開通後每月前 5,000 次接地免費，本工具每月約用 360 次。'
                : '這個引擎的額度用完了，或帳戶尚未開通付費。';
            } else if (/401|403|API key|invalid|UNAUTHENTICATED|permission/i.test(m)) {
              state = 'badkey';
              msg = '金鑰無效或權限不足，請重新產生一把再貼一次。';
            } else if (/not found|404|模型/i.test(m)) {
              state = 'badmodel';
              msg = `找不到模型，可能是模型名稱過期。${m.slice(0, 120)}`;
            }
            return { engine: e.id, label: e.label, env: e.env, state, msg };
          }
        }));
        return ok(res, { results, judge: `${judgeEngine()} / ${judgeModel()}` });
      }

      /**
       * 一頁報告：給同仁與主管看的。
       *
       * 刻意不出現「能見度指數」「半衰期」這類詞 —— 主管不需要學我們的計分法，
       * 他需要的是「AI 現在怎麼講工研院」「它引誰的網頁」「所以我們要改什麼」。
       * 最有說服力的是 AI 的原話，所以原話一定要在裡面。
       */
      if (action === 'report') {
        const kw = String(req.query.keyword || '').trim();
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
        const from = addDays(todayTW(), -days + 1);

        const all = (await safeRead('geo_runs!A2:O')).filter((r) => r[0]).map(parseRun)
          .filter((r) => r.date >= from && (!kw || r.keyword === kw));
        const scored = all.filter((r) => r.score !== null);

        if (scored.length < 1) {
          return ok(res, { keyword: kw, days, ready: false,
            msg: '這個議題還沒有掃描結果，先按「立即掃描」。' });
        }

        const hit = scored.filter((r) => r.mentioned);
        const mentionRate = Math.round((hit.length / scored.length) * 100);
        const citedRate = Math.round((scored.filter((r) => r.cited).length / scored.length) * 100);
        const ranks = hit.map((r) => r.rank).filter((x) => x > 0);
        const avgRank = ranks.length ? Math.round(avg(ranks) * 10) / 10 : null;

        // 同框單位出現次數（同一家的不同寫法先併起來，見「單位名稱正規化」）
        const compCount = tallyOrgs(scored);

        // 被引用的網域，分成自家與別人
        const owned = {}, others = {};
        scored.forEach((r) => String(r.citations || '').split('|').map((s) => s.trim()).filter(Boolean)
          .forEach((c) => {
            const host = c.includes('://') ? hostOf(c) : c.toLowerCase();
            const bucket = matchesOwned(host) ? owned : others;
            bucket[host] = (bucket[host] || 0) + 1;
          }));

        const latest = [...scored].reverse();
        const quote = latest.find((r) => r.mentioned && r.excerpt);
        const missed = latest.find((r) => !r.mentioned && r.excerpt);

        const pRows = (await safeRead('geo_prompts!A2:H')).filter((r) => r[0]).map(parsePrompt);
        const qOf = (id) => pRows.find((p) => p.id === id)?.prompt || '';

        /* ── 話語權排行 ──
         * 主管真正要看的是「這個議題被問到時，AI 認為誰是答案」，
         * 不是我們的技術衛生指標。工研院和對手放同一張表比次數，位次自然浮出來。 */
        const board = [
          { name: BRAND_DEFAULT, n: hit.length, self: true, variants: [] },
          ...[...compCount.values()].map((e) => ({
            name: e.name, n: e.n, self: false,
            // 合併了哪些寫法要攤在報告上。不寫出來的話，「資策會 12 次」會被當成算錯。
            variants: e.variants.size > 1 ? [...e.variants] : [],
          })),
        ].sort((a, b) => b.n - a.n || (b.self ? 1 : -1));

        const myRank = board.findIndex((x) => x.self) + 1;
        const top = board[0];
        const rival = board.find((x) => !x.self) || null;
        const gap = rival ? hit.length - rival.n : null;
        const firstRate = hit.length
          ? Math.round((hit.filter((r) => r.rank === 1).length / hit.length) * 100) : 0;

        // 一句話結論：先講地位，再講差距
        const topic = kw || '這些議題';
        let headline;
        if (!hit.length) {
          headline = `問「${topic}」時，AI ${scored.length} 次全部沒有提到工研院。`
            + (rival ? `它提到的是${board.filter((x) => !x.self).slice(0, 3).map((x) => x.name).join('、')}。` : '');
        } else if (myRank === 1 && gap !== null && gap <= 1) {
          headline = `「${topic}」上工研院目前排第一，但只領先${rival.name} ${gap} 次，隨時會被追過。`;
        } else if (myRank === 1) {
          headline = `「${topic}」上工研院是 AI 的首選答案：${scored.length} 次問答裡被提到 ${hit.length} 次，`
            + (rival ? `第二名的${rival.name}是 ${rival.n} 次。` : '沒有其他單位被穩定提到。');
        } else {
          headline = `「${topic}」上工研院排第 ${myRank}，被提到 ${hit.length} 次，`
            + `排在前面的是${board.slice(0, myRank - 1).map((x) => x.name).join('、')}（${top.n} 次）。`;
        }

        /* ── 績效區塊：發稿前 vs 發稿後 ──
         * 沒有這一段就不是績效報告，只是現況盤點。
         * 績效的定義是「我做了什麼，數字從 A 變成 B」，所以一定要有事前對照。 */
        const evAll = (await safeRead('geo_events!A2:G')).filter((r) => r[0]).map(parseEvent);
        const ev = evAll.filter((e) => !kw || (e.keywords || '').includes(kw))
          .sort((a, b) => b.date.localeCompare(a.date))[0] || null;

        let performance = null;
        if (ev) {
          const allRuns = (await safeRead('geo_runs!A2:O')).filter((r) => r[0]).map(parseRun)
            .filter((r) => r.score !== null && (!kw || r.keyword === kw));

          /* ── 時間窗 ──
           * D+15~30 還在搜尋索引新鮮度衰減期內，是「下降中的一點」，不是平台期。
           * 把它當新基線是方法學錯誤 —— 所以它只叫「餘波期」，
           * 真正能宣稱基線的窗是 D+31 之後。 */
          const slice = (f, t) => allRuns.filter((r) => r.date >= f && r.date <= t);
          const WINDOWS = {
            before: [addDays(ev.date, -14), addDays(ev.date, -1)],
            during: [ev.date, addDays(ev.date, 13)],
            echo: [addDays(ev.date, 14), addDays(ev.date, 30)],
            base1: [addDays(ev.date, 31), addDays(ev.date, 60)],
            base2: [addDays(ev.date, 61), addDays(ev.date, 90)],
          };
          const before = slice(...WINDOWS.before);
          const during = slice(...WINDOWS.during);
          const after = slice(...WINDOWS.echo);
          const base1 = slice(...WINDOWS.base1);
          const base2 = slice(...WINDOWS.base2);

          /* 只拿「兩個窗都存在」的題目來比。
           * 題庫隨時可以增刪，如果不做這件事，新增一題就會讓前後不可比，
           * 而且是靜靜地錯 —— 數字照樣算得出來，只是沒有意義。 */
          const idsIn = (rs) => new Set(rs.map((r) => r.prompt_id));
          const comparable = (x, y) => {
            const ix = idsIn(x), iy = idsIn(y);
            const both = [...ix].filter((id) => iy.has(id));
            return { both: new Set(both), changed: both.length !== ix.size || both.length !== iy.size };
          };

          const profile = (rs, keep) => {
            const use = keep ? rs.filter((r) => keep.has(r.prompt_id)) : rs;
            if (!use.length) return null;
            const h = use.filter((r) => r.mentioned);
            // 前後期的名次要可比，兩邊就得用同一套合併規則
            const bd = [{ name: BRAND_DEFAULT, n: h.length, self: true },
              ...[...tallyOrgs(use).values()].map((e) => ({ name: e.name, n: e.n, self: false }))]
              .sort((a, b) => b.n - a.n || (b.self ? 1 : -1));
            return {
              samples: use.length,
              days: new Set(use.map((r) => r.date)).size,
              prompts: idsIn(use).size,
              mentionRate: Math.round((h.length / use.length) * 100),
              // 分母用「總問答數」而非「被提及數」：後者會隨主指標一起動，
              // 而且被提及次數少的時候一兩筆就跳很大，站不住。
              firstRate: Math.round((use.filter((r) => r.rank === 1).length / use.length) * 100),
              rank: bd.findIndex((x) => x.self) + 1,
              topRival: (bd.find((x) => !x.self) || {}).name || null,
            };
          };

          /* ── 差距大到可以宣稱嗎 ──
           * 同一天問的是同一批題目，彼此高度相關，每筆當獨立樣本會嚴重高估精確度。
           * 以「天」為群集做 bootstrap：每次重抽整天，抽 1200 次取 2.5%/97.5% 分位。
           * 信賴區間跨過 0 就不宣稱。 */
          const byDayList = (rs, keep) => {
            const use = keep ? rs.filter((r) => keep.has(r.prompt_id)) : rs;
            const m = {};
            use.forEach((r) => { (m[r.date] ||= []).push(r); });
            return Object.values(m);
          };
          const rateOf = (days) => {
            const flat = days.flat();
            return flat.length ? (flat.filter((r) => r.mentioned).length / flat.length) * 100 : null;
          };
          // 固定種子，同一份資料每次算出同樣的區間 —— 報告不能每次重整就換數字
          let _seed = 20260803;
          const rnd = () => (_seed = (_seed * 1103515245 + 12345) % 2147483648) / 2147483648;
          const resample = (xs) => xs.map(() => xs[Math.floor(rnd() * xs.length)]);

          const bootCI = (dx, dy) => {
            const out = [];
            for (let i = 0; i < 1200; i++) {
              const a1 = rateOf(resample(dx)), b1 = rateOf(resample(dy));
              if (a1 !== null && b1 !== null) out.push(b1 - a1);
            }
            if (!out.length) return null;
            out.sort((p, q) => p - q);
            const at = (f) => out[Math.min(out.length - 1, Math.max(0, Math.floor(f * out.length)))];
            return [Math.round(at(0.025) * 10) / 10, Math.round(at(0.975) * 10) / 10];
          };

          /**
           * 判定階梯。順序有意義：先擋不可比，再擋樣本不足，
           * 再擋差距太小，最後才看「這個窗有沒有資格叫基線」。
           */
          const judge2 = (post, label) => {
            if (!post || !before.length) return { call: 'INSUFFICIENT_N' };
            const { both, changed } = comparable(before, post);
            if (changed) return { call: 'NOT_COMPARABLE' };

            const dPre = byDayList(before, both), dPost = byDayList(post, both);
            if (dPre.length < 7 || dPost.length < 7) {
              return { call: 'INSUFFICIENT_N', days: [dPre.length, dPost.length] };
            }
            const pPre = rateOf(dPre), pPost = rateOf(dPost);
            const diff = Math.round((pPost - pPre) * 10) / 10;
            const ci = bootCI(dPre, dPost);
            const base = { diff, ci, days: [dPre.length, dPost.length], window: label };

            if (Math.abs(diff) < 10) return { ...base, call: 'NO_MATERIAL_DIFF' };
            if (!ci || (ci[0] <= 0 && ci[1] >= 0)) return { ...base, call: 'NO_DETECTABLE_DIFF' };
            if (diff < 0) return { ...base, call: 'DROPPED' };
            return { ...base, call: 'LIFTED' };
          };

          const b = profile(before), dur = profile(during), a = profile(after);
          const p1 = profile(base1), p2 = profile(base2);
          const daysSince = dayDiff(ev.date, todayTW());

          const vEcho = judge2(after, 'echo');
          const vBase1 = base1.length ? judge2(base1, 'base1') : null;
          const vBase2 = base2.length ? judge2(base2, 'base2') : null;

          /* 「基線墊高」只有 D+31 以後的窗才有資格宣稱。
           * D+15~30 還在新鮮度衰減期，那裡的高點是餘波，不是新水位。 */
          let stage;
          if (vBase1?.call === 'LIFTED' && vBase2?.call === 'LIFTED') stage = 'BASELINE_RAISED';
          else if (vBase1?.call === 'LIFTED') stage = 'BASELINE_PROVISIONAL';
          else if (vBase1 && ['NO_MATERIAL_DIFF', 'NO_DETECTABLE_DIFF'].includes(vBase1.call)) stage = 'RETURNED';
          else if (vBase1?.call === 'DROPPED') stage = 'DROPPED';
          else if (vEcho.call === 'LIFTED') stage = 'ECHO_HIGH_NOT_BASELINE';
          else stage = vEcho.call;

          // 掉了多少 vs 留下多少 —— 兩件事，別混成一個數字
          let decay = null;
          if (b && dur && a) {
            const held = dur.mentionRate - b.mentionRate;   // 活動期比基準期高幾個百分點
            const kept = a.mentionRate - b.mentionRate;     // 餘波期還高幾個百分點
            decay = {
              held, kept,
              keptPct: held > 0 ? Math.round((kept / held) * 100) : null,
            };
          }

          performance = {
            event: { title: ev.title, date: ev.date, keyword: ev.keywords },
            before: b, during: dur, after: a, base1: p1, base2: p2,
            decay, daysSince,
            stage, vEcho, vBase1, vBase2,
            // 事件前 14 天到事件後 30 天的逐日提及率，給「墊高」那張圖用。
            // 沒有圖的話，基線墊高只是表格裡的一個數字，看不出來。
            dailySeries: (() => {
              const byDay = {};
              slice(addDays(ev.date, -14), addDays(ev.date, 90))
                .forEach((r) => { (byDay[r.date] ||= []).push(r); });
              const out = [];
              for (let i = -14; i <= 90; i++) {
                const d = addDays(ev.date, i);
                if (d > todayTW()) break;
                const list = byDay[d];
                out.push({
                  offset: i,
                  rate: list ? Math.round((list.filter((r) => r.mentioned).length / list.length) * 100) : null,
                });
              }
              return out;
            })(),
            ready: !!(b && a),
            waitingFor: !b ? '事件前 14 天沒有資料——追蹤是活動之後才開始的，這一場算不出前後對比'
              : !a ? `還要等 ${Math.max(0, 30 - daysSince)} 天（活動後滿 30 天才有餘波期資料）` : null,
            // 淨變化一律用「百分點（pp）」，不是「%」——30%→60% 是 +30pp，不是 +30%
            delta: (b && a) ? {
              mentionRatePP: a.mentionRate - b.mentionRate,
              firstRatePP: a.firstRate - b.firstRate,
              rank: b.rank - a.rank,
            } : null,
          };
        }

        return ok(res, {
          performance,
          ready: true, keyword: kw, days, samples: scored.length,
          dateRange: [scored[0].date, scored[scored.length - 1].date],
          engines: [...new Set(scored.map((r) => r.engine))],
          headline,
          voiceBoard: board, // 有出現就都列，不砍——board 本來就只含實際被偵測到的機構
          myRank,
          stats: [
            { label: '問到這個議題時，AI 提到工研院的比例',
              value: `${scored.length} 次裡 ${hit.length} 次`, pct: mentionRate,
              hint: '這是話語權的基本盤：不提到，後面都不用談' },
            { label: '被提到時，工研院是第一個被講到的比例',
              value: hit.length ? `${hit.filter((r) => r.rank === 1).length} / ${hit.length} 次` : '沒被提到過',
              pct: hit.length ? firstRate : null,
              hint: '排第一代表 AI 把我們當成這題的代表答案' },
            { label: '和最強對手的差距',
              value: rival ? `${gap > 0 ? '領先' : gap < 0 ? '落後' : '打平'} ${Math.abs(gap)} 次（${rival.name}）` : '沒有對手被穩定提到',
              pct: null, hint: '同一批問題裡，誰被提到的次數多' },
          ],
          quote: quote ? { question: qOf(quote.prompt_id), engine: quote.engine, date: quote.date, text: quote.excerpt } : null,
          missed: missed ? { question: qOf(missed.prompt_id), engine: missed.engine, date: missed.date, text: missed.excerpt } : null,
          citedRate,
          ownedDomains: Object.entries(owned).sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ d, n })),
          otherDomains: Object.entries(others).sort((a, b) => b[1] - a[1]).slice(0, 8)
            .map(([d, n]) => ({ d, n })),
          actions: diagnose(scored).filter((f) => f.level !== 'info').slice(0, 3),
        });
      }

      // ITRI EVENT AI 的活動清單，給「選一場活動」下拉用
      if (action === 'itri_events') {
        const rows = await safeRead('events!A2:K');
        return ok(res, {
          events: rows.filter((r) => r[0] && r[4] !== 'archived')
            .map((r) => ({ id: r[0], name: r[1] || r[0], created_at: (r[5] || '').slice(0, 10) }))
            .reverse().slice(0, 60),
        });
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
          judge: judgeEngine() ? `${judgeEngine()} / ${judgeModel()}` : '（未設定）',
          judgeEngine: judgeEngine(),
          cronSecretSet: !!process.env.CRON_SECRET,
          ready: readyCheck(),
        });
      }

      if (action === 'series') {
        const n = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365);
        const [runRows, evRows] = await Promise.all([
          safeRead('geo_runs!A2:O'), safeRead('geo_events!A2:G'),
        ]);
        const runs = runRows.filter((r) => r[0]).map(parseRun);
        // 「持續關注」是長官在意的議題但沒有特定發稿日，不是一次性活動——
        // 半衰期／基線抬升這兩個數字算的是「衝上去又掉下來」，continuous 監測
        // 從第一天就沒有基線可比，硬算只會產生看起來像結論的雜訊，所以排除在事件效應之外。
        // 議題排行不受影響，持續關注的議題一樣會出現在那張表。
        const events = evRows.filter((r) => r[0]).map(parseEvent)
          .filter((e) => e.date >= addDays(todayTW(), -n + 1) && e.type !== '持續關注')
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
              evidence: r.obs.evidence || '', competitors: canonList(r.obs.competitors_found),
              citations: r.citations.slice(0, 10).map((c) => ({ domain: c.domain, url: c.url })),
              answer: r.answer.slice(0, 1200),
            };
          } catch (err) {
            return { engine: e.id, ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 300) };
          }
        }));

        return ok(res, {
          prompt: { id: p.id, topic: p.topic, prompt: p.prompt, keyword: p.keyword },
          judge: `${judgeEngine()} / ${judgeModel()}`, results,
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

    /**
     * 一鍵開始追蹤一場活動：把選好的題目寫進題庫，同時建立一筆事件標記，
     * 並綁定 ITRI EVENT AI 的活動 ID（有選的話）。同仁只要做這一步。
     */
    if (body.action === 'track_start') {
      await ensureSheets(SHEETS);
      const keyword = String(body.keyword || '').trim();
      if (!keyword) return res.status(400).json({ error: '請填這場活動的關鍵字' });

      const list = (body.prompts || []).map((s) => String(s || '').trim()).filter((s) => s.length >= 8);
      if (!list.length) return res.status(400).json({ error: '至少要留一題' });
      const bad = list.filter((s) => BRAND_RE.test(s));
      if (bad.length) return res.status(400).json({ error: `有 ${bad.length} 題出現「工研院」，那會變成自問自答，請先改掉。` });

      // 綁定活動：日期與名稱直接沿用 ITRI EVENT AI 那筆，不用重打
      let title = String(body.title || '').trim();
      let date = String(body.date || '').trim();
      const refId = String(body.itri_event_id || '').trim();
      if (refId) {
        const evRow = (await safeRead('events!A2:K')).find((r) => r[0] === refId);
        if (!evRow) return res.status(404).json({ error: '找不到這場活動，請重新選一次' });
        title = title || evRow[1] || refId;
        // events 分頁沒有「活動日期」欄，只有建立日期；畫面上填的優先，這裡只是保底
        date = date || (evRow[5] || '').slice(0, 10);
      }
      if (!title) title = keyword;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayTW();

      // 對照單位隨題目一起存：通用名單對不上題目領域的話，那一欄永遠是空的。
      // 同樣先收斂寫法——這是新開追蹤的入口，歪在這裡之後每天都跟著歪。
      const comps = canonList((body.competitors || []).map((s) => String(s || '').trim()));
      const compStr = comps.length ? comps.join('、') : COMPETITORS;

      const stamp = nowTW();
      await appendRows('geo_prompts!A:H', list.map((p) => [
        uid('gp'), keyword, p, keyword, BRAND_DEFAULT, compStr, 'TRUE', stamp,
      ]));

      const evId = uid('ge');
      await appendRows('geo_events!A:G', [[
        evId, date, title, body.type || '記者會', keyword, '', refId,
      ]]);

      return ok(res, { success: true, added: list.length, event: { id: evId, date, title, keyword } });
    }

    if (body.action === 'settings_save') {
      const engines = (body.engines || []).map((s) => String(s).trim()).filter(Boolean);
      await saveSetting('engines', engines.join(','));
      if (body.judge !== undefined) {
        await saveSetting('judge', String(body.judge || '').trim());
        CFG.judge = String(body.judge || '').trim() || null;
      }
      CFG.engines = engines;
      return ok(res, { success: true });
    }

    /** 同仁專用連結：產生／重新產生一組 code。舊連結會立刻失效。 */
    if (body.action === 'staff_link') {
      if (body.revoke) {
        await saveSetting('staff_code', '');
        CFG.staffCode = null;
        return ok(res, { success: true, code: null });
      }
      let c = CFG.staffCode;
      if (!c || body.regenerate) {
        c = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
        await saveSetting('staff_code', c);
        CFG.staffCode = c;
      }
      return ok(res, { success: true, code: c });
    }

    /**
     * 停止追蹤一場活動：把該議題的題目「停用」（active 設 FALSE），並移除活動標記。
     *
     * 之前是直接把題目整列刪除，但題目一刪，歷史報告靠 prompt_id 回查問句文字
     * 就會變空白（只剩答案沒有問題），而且無法重新啟用追蹤、只能重生一批新題
     * （prompt_id 不同，前後不可比）。改成停用：不掃描、不計費（pendingPairs 只挑
     * active 的題目），但題目本身與歷史資料都還在，之後可以重新啟用。
     *
     * geo_runs 完全不動 —— 曲線、事件效應、議題排行全部是從 geo_runs 算出來的，
     * 那是花錢換來的歷史資料，不受這個動作影響。
     */
    if (body.action === 'track_stop') {
      const evRows = await safeRead('geo_events!A2:G');
      const target = evRows.find((r) => r[0] === body.id);
      if (!target) return res.status(404).json({ error: '找不到這場追蹤' });
      const keyword = target[4] || '';

      // 停用同議題的題目（逐列更新 G 欄，不影響其他欄位與其他議題的題目）
      let stopped = 0;
      if (keyword) {
        const pRows = await safeRead('geo_prompts!A2:H');
        for (let i = 0; i < pRows.length; i++) {
          const r = pRows[i];
          if (r[0] && r[3] === keyword && String(r[6]).toUpperCase() !== 'FALSE') {
            await updateRange(`geo_prompts!G${i + 2}`, [['FALSE']]);
            stopped++;
          }
        }
      }

      const kept = evRows.filter((r) => r[0] && r[0] !== body.id);
      if (evRows.length) {
        await updateRange(`geo_events!A2:G${evRows.length + 1}`, evRows.map(() => new Array(7).fill('')));
      }
      if (kept.length) await updateRange(`geo_events!A2:G${kept.length + 1}`, kept);

      return ok(res, { success: true, removed: stopped, keyword });
    }

    if (body.action === 'prompt_generate') {
      const keyword = String(body.keyword || '').trim();
      if (!keyword) return res.status(400).json({ error: '請先輸入一個關鍵字' });
      if (keyword.length > 40) return res.status(400).json({ error: '關鍵字太長了，給一個技術或主題名稱就好' });
      const gen = await generatePrompts(keyword);
      return ok(res, { keyword, candidates: gen.prompts, competitors: gen.competitors });
    }

    // 一次存多題（生完題目勾選後送出）
    if (body.action === 'prompt_save_many') {
      await ensureSheets(SHEETS);
      const keyword = String(body.keyword || '').trim() || '未分類';
      const list = (body.prompts || [])
        .map((s) => String(s || '').trim())
        .filter((s) => s.length >= 8);
      if (!list.length) return res.status(400).json({ error: '沒有選到任何題目' });

      const bad = list.filter((s) => BRAND_RE.test(s));
      if (bad.length) {
        return res.status(400).json({ error: `有 ${bad.length} 題出現「工研院」，那會變成自問自答。請先改掉。` });
      }

      const stamp = nowTW();
      await appendRows('geo_prompts!A:H', list.map((p) => [
        uid('gp'), keyword, p, keyword, BRAND_DEFAULT, COMPETITORS, 'TRUE', stamp,
      ]));
      return ok(res, { success: true, added: list.length });
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
      const rows = await safeRead('geo_events!A2:G');
      const idx = rows.findIndex((r) => r[0] === e.id);
      const row = [e.id || uid('ge'), e.date, e.title, e.type || '記者會', e.keywords || '', e.note || ''];
      if (idx >= 0) await updateRange(`geo_events!A${idx + 2}:F${idx + 2}`, [row]);
      else await appendRows('geo_events!A:G', [row]);
      return ok(res, { success: true, id: row[0] });
    }

    if (body.action === 'event_delete') {
      const rows = await safeRead('geo_events!A2:G');
      const kept = rows.filter((r) => r[0] && r[0] !== body.id);
      if (rows.length) await updateRange(`geo_events!A2:G${rows.length + 1}`, rows.map(() => new Array(7).fill('')));
      if (kept.length) await updateRange(`geo_events!A2:G${kept.length + 1}`, kept);
      return ok(res, { success: true });
    }

    /**
     * 發稿建議：把累積的 GEO 掃描資料變成能直接用的東西，不然只是量測、沒有用在下一次發稿上。
     *
     * 只吃文字（新聞稿全文、影片腳本或文案）——影片本身的畫面不會被 LLM 讀進去，
     * 真正決定會不會被引用的是文字，所以刻意不做檔案上傳。
     * 資料不夠就老實說資料不夠，不硬生出建議；證據都附著出處，不是泛用 SEO 建議。
     */
    if (body.action === 'advise') {
      const draft = String(body.draft || '').trim();
      if (draft.length < 30) return res.status(400).json({ error: '請貼上完整的新聞稿或文案內容（至少 30 字）' });
      const kw = String(body.keyword || '').trim();
      const days = 90;
      const from = addDays(todayTW(), -days + 1);
      const MIN_SAMPLES = 5;

      const allInWindow = (await safeRead('geo_runs!A2:O')).filter((r) => r[0]).map(parseRun)
        .filter((r) => r.date >= from && r.score !== null);
      const kwRs = kw ? allInWindow.filter((r) => r.keyword === kw) : allInWindow;

      // 新議題常常是活動前一個月才知道，90 天內這個關鍵字本來就不可能累積很多筆。
      // 資料不夠時不要整個擋掉——退而求其次用「全部主題」的既有模式當證據基礎，
      // 只是要老實標明這不是這個議題專屬的資料，是跨議題的一般模式。
      let rs = kwRs, scope = 'keyword';
      if (kw && kwRs.length < MIN_SAMPLES) {
        if (allInWindow.length >= MIN_SAMPLES) { rs = allInWindow; scope = 'overall_fallback'; }
        else { rs = []; scope = 'insufficient'; }
      }

      if (rs.length < MIN_SAMPLES) {
        return ok(res, {
          ready: false,
          msg: kw
            ? `「${kw}」這個主題近 90 天只有 ${kwRs.length} 次掃描，整體資料也只有 ${allInWindow.length} 次，還太少。建議：現在就去題庫幫這個議題「產生題目」開始追蹤——就算新聞稿還沒寫，先掃著，等你回來看建議時就有基礎了。`
            : `近 90 天累積的掃描只有 ${allInWindow.length} 次，資料還太少，建議先讓它跑 2-3 週再回來看建議。`,
        });
      }

      const mentionedRuns = rs.filter((r) => r.mentioned);
      const owned = {}, others = {};
      rs.forEach((r) => String(r.citations || '').split('|').map((s) => s.trim()).filter(Boolean)
        .forEach((c) => {
          const host = c.includes('://') ? hostOf(c) : c.toLowerCase();
          (matchesOwned(host) ? owned : others)[host] = ((matchesOwned(host) ? owned : others)[host] || 0) + 1;
        }));
      const topOwned = Object.entries(owned).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d);
      const topOthers = Object.entries(others).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d);
      const goodQuote = [...rs].reverse().find((r) => r.mentioned && r.specifics && r.excerpt)?.excerpt || '';
      const missedQuote = [...rs].reverse().find((r) => !r.mentioned && r.excerpt)?.excerpt || '';
      const findings = diagnose(rs);

      const scopeLabel = scope === 'keyword' ? `「${kw}」這個主題`
        : scope === 'overall_fallback' ? `全部議題（「${kw}」這個主題目前只有 ${kwRs.length} 筆，還不夠單獨看，先借用其他議題累積出來的一般模式）`
        : '整體';

      const evidence = `
近 90 天${scopeLabel}的 GEO 掃描結果（${rs.length} 次觀察）：
- 提及率 ${Math.round(mentionedRuns.length / rs.length * 100)}%，其中講到具體內容（不是只有名字）的佔 ${mentionedRuns.length ? Math.round(mentionedRuns.filter(r=>r.specifics).length / mentionedRuns.length * 100) : 0}%
- AI 引用來源時，引到工研院自己網域的次數分布：${topOwned.join('、') || '（幾乎沒有）'}
- AI 引用來源時，引到別人網域的次數分布：${topOthers.join('、') || '（無資料）'}
- 系統既有診斷：${findings.map((f) => `${f.title}——${f.todo}`).join('；') || '（尚無明顯模式）'}
${goodQuote ? `- AI 曾經講對、講具體的一段話（值得延續這種寫法）：「${goodQuote}」` : ''}
${missedQuote ? `- AI 沒提到工研院時，答案實際引用/描述的是：「${missedQuote}」` : ''}
`.trim();

      const prompt = `你是工研院的 GEO（生成式引擎優化）內容顧問。你的建議必須每一條都能指回下面這份實測證據，不可以講泛用的 SEO 建議。
${scope === 'overall_fallback' ? '\n重要：下面這份證據是跨議題的一般模式，不是這個主題專屬的實測結果——這個主題本身資料還太少。你的建議可以引用這些一般模式，但不要講得好像這是這個主題已經被實測驗證過的結論，要誠實反映「這是通用模式，這個主題還沒有自己的實測數據」。\n' : ''}
【實測證據】
${evidence}

【要檢查的新聞稿／文案初稿】
${draft.slice(0, 6000)}

請針對這份初稿，給出具體、可直接照做的修改建議，每一條都要講清楚「改哪一句、怎麼改、為什麼」（為什麼要對應到上面的實測證據，不要空講「增加曝光度」這種話）。最多 6 條，依重要性排序。同時給一句話總評（這份初稿現在的 AI 能見度體質如何）。`;

      const schema = {
        type: 'object',
        properties: {
          verdict: { type: 'string', description: '一句話總評' },
          suggestions: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                issue: { type: 'string', description: '初稿裡的哪個地方有問題，引用原句' },
                why: { type: 'string', description: '為什麼是問題，要對應到實測證據' },
                fix: { type: 'string', description: '具體怎麼改，可直接照做' },
              },
              required: ['issue', 'why', 'fix'],
              additionalProperties: false,
            },
          },
        },
        required: ['verdict', 'suggestions'],
        additionalProperties: false,
      };

      const advice = await askJSON(prompt, schema, 3000);
      return ok(res, {
        ready: true,
        basis: { samples: rs.length, keyword: kw || null, scope, topOwned, topOthers },
        advice,
      });
    }

    return res.status(400).json({ error: `不支援的操作: ${body.action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
