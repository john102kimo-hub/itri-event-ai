// 固定評測流程（批次 186）：同一批題目、同一組程式評分，改 prompt 或換模型前後各跑一次，比較。
//
//   # 不花錢：用現成的「標準答案」確認題庫與評分器沒壞（npm test 跑的就是這個）
//   node tools/eval/run.mjs --provider mock --mock tools/eval/mock-good.json
//
//   # 花錢（每題一次呼叫；20 題 × --runs 1 ≈ 幾毛錢，Sonnet 5.5 約 $2／$10 per MTok）：打真的模型
//   ANTHROPIC_API_KEY=sk-ant-… node tools/eval/run.mjs --save tools/eval/results/before.json
//   …改 prompt 或換模型…
//   ANTHROPIC_API_KEY=sk-ant-… node tools/eval/run.mjs --baseline tools/eval/results/before.json --fail-on regress
//
// 選項：
//   --cases <檔>          題庫，預設 tools/eval/cases/core.json
//   --profile line|web    line＝米亞（Sonnet 5.5、有 LINE 版面規則、會過 Markdown 清理）；web＝網頁問答（Haiku 5.5）。預設 line
//   --model <id>          覆蓋模型；--thinking disabled|between_tools|omit 覆蓋思考設定（Sonnet 5.5 不收 disabled，見 lib/line-runtime.js）
//   --runs N              每題跑 N 次（模型有隨機性；N>1 時一題「全部通過」才算通過）
//   --only <id,id,…>      只跑這幾題；--tag <tag> 只跑某一類
//   --save <檔>           存結果（tools/eval/results/ 已被 .gitignore；結果含模型輸出，別放進 repo 以外的地方分享前先看過）
//   --baseline <檔>       跟之前存的結果比：列出退步（以前過、現在不過）與進步
//   --fail-on any|regress 結束碼：any＝任何硬性失敗就 1（預設）；regress＝只有退步才 1
//   --json                輸出 JSON
//
// ⚠️ 這是「近似」正式站：system prompt 用同一支 lib/prompt.js 組，但沒有 bot_memory、對話歷史、跨場次資料、LAYOUT_RULE（版面）。
//    拿來比較「前後差異」很準；拿來宣稱「正式站一定是這個分數」不行。
// ⚠️ 只有這支會呼叫模型；`npm test` 只跑 mock。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEventBasics, formatImages, systemPromptFor } from '../../lib/prompt.js';
import { lineExtraRules, LINE_NO_DATA_RULE } from '../../lib/line-format.js';
import { REPEAT_NO_DATA_HINT } from '../../lib/no-data-handoff.js';
import { ZH_TW_RULE } from '../../lib/zh-tw.js';
import { resolveRelativeDates } from '../mcp-itri/server.mjs';
import { gradeAnswer } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// 跟正式站一致（lib/line-runtime.js ANSWER_MODEL、api/chat.js CHAT_MODEL 與各自的 thinking 寫法）
export const PROFILES = {
  line: { model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } },
  web: { model: 'claude-haiku-5-5', thinking: { type: 'disabled' } }
};

export function loadCases(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  const event = resolveRelativeDates(raw.event);
  return { event, cases: raw.cases };
}

/** 跟 tools/grounding-backtest 同一個組法：模型「看得到的字」＝知識庫＋照片清單＋活動基本資料＋問題 */
export const shownTextFor = (event, q) => [`${event.knowledge_base}${formatImages(event.images)}`, formatEventBasics(event), q].join('\n');

export function buildSystem(event, profile) {
  const extra = profile === 'line' ? lineExtraRules(event) : [];
  // 跟正式站一致：LINE 的活動問答傳自己的「答不出來」講法（lib/line-reporter.js answerQuestion()）；網頁版不傳
  return [systemPromptFor(event, extra, profile === 'line' ? { noDataRule: LINE_NO_DATA_RULE } : {}), ZH_TW_RULE, formatEventBasics(event)].filter(Boolean).join('\n');
}

async function askAnthropic({ system, q, history = [], model, thinking }) {
  const body = { model, max_tokens: 2048, system: [{ type: 'text', text: system }], messages: [...history, { role: 'user', content: q }], ...(thinking ? { thinking } : {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90_000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status === 529) && attempt === 0) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (!res.ok) throw new Error(`API ${res.status}：${data.error?.message || '未知錯誤'}`);
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  throw new Error('API 重試後仍失敗');
}

export async function runEval({ casesFile = 'tools/eval/cases/core.json', provider = 'anthropic', mock, profile = 'line', model, thinking, runs = 1, only, tag } = {}) {
  const { event, cases } = loadCases(casesFile);
  const prof = PROFILES[profile];
  if (!prof) throw new Error(`profile 只能是 ${Object.keys(PROFILES).join('／')}`);
  const useModel = model || prof.model;
  const useThinking = thinking === 'omit' ? undefined : thinking ? { type: thinking } : prof.thinking;
  const mocks = provider === 'mock' ? JSON.parse(fs.readFileSync(path.resolve(ROOT, mock), 'utf8')) : null;
  const system = buildSystem(event, profile);
  const picked = cases.filter((c) => (!only || only.includes(c.id)) && (!tag || c.tag === tag));
  if (!picked.length) throw new Error('沒有符合條件的題目');

  const out = [];
  for (const spec of picked) {
    const results = [];
    for (let i = 0; i < runs; i++) {
      let raw, error = null;
      try {
        raw = provider === 'mock' ? (mocks[spec.id] ?? '') : await askAnthropic({ system: spec.prev_no_data ? `${system}\n${REPEAT_NO_DATA_HINT}` : system, q: spec.q, history: spec.history || [], model: useModel, thinking: useThinking });
      } catch (e) { error = e.message; }
      if (error) { results.push({ pass: false, error, final: '', failed: ['api_error'], softFailed: [], details: { api_error: error } }); continue; }
      const g = await gradeAnswer({ raw, shownText: shownTextFor(event, spec.q), spec, profile });
      results.push({
        pass: g.pass, raw, final: g.final,
        failed: g.checks.filter((c) => c.level === 'hard' && !c.pass).map((c) => c.name),
        softFailed: g.checks.filter((c) => c.level === 'soft' && !c.pass).map((c) => c.name),
        details: Object.fromEntries(g.checks.filter((c) => !c.pass).map((c) => [c.name, c.detail]))
      });
    }
    out.push({ id: spec.id, tag: spec.tag, q: spec.q, pass: results.every((r) => r.pass), passRate: results.filter((r) => r.pass).length / results.length, runs: results });
  }
  const tally = (key) => out.flatMap((c) => c.runs.flatMap((r) => r[key])).reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  return {
    meta: { date: new Date().toISOString(), provider, profile, model: provider === 'mock' ? '(mock)' : useModel, runs, cases: out.length },
    cases: out,
    summary: { passed: out.filter((c) => c.pass).length, total: out.length, hardFails: tally('failed'), softFails: tally('softFailed') }
  };
}

export function compareToBaseline(current, baseline) {
  const base = new Map(baseline.cases.map((c) => [c.id, c]));
  const regressions = [], fixed = [], added = [];
  for (const c of current.cases) {
    const b = base.get(c.id);
    if (!b) { added.push(c.id); continue; }
    if (b.pass && !c.pass) regressions.push(c.id);
    if (!b.pass && c.pass) fixed.push(c.id);
  }
  const softNow = Object.values(current.summary.softFails).reduce((a, b) => a + b, 0);
  const softBefore = Object.values(baseline.summary?.softFails || {}).reduce((a, b) => a + b, 0);
  return { regressions, fixed, added, softDelta: softNow - softBefore, baselineModel: baseline.meta?.model, baselineDate: baseline.meta?.date };
}

export function formatReport(res, cmp) {
  const L = [];
  const m = res.meta;
  L.push(`評測：profile=${m.profile}　模型=${m.model}　每題 ${m.runs} 次　共 ${m.cases} 題`, '');
  for (const c of res.cases) {
    const fails = [...new Set(c.runs.flatMap((r) => r.failed))];
    L.push(`${c.pass ? '✅' : '❌'} ${c.id.padEnd(14)} ${c.tag.padEnd(10)} ${c.runs.length > 1 ? `${Math.round(c.passRate * 100)}%　` : ''}${fails.length ? `← ${fails.join('、')}` : ''}`);
    if (!c.pass) {
      const r = c.runs.find((x) => !x.pass);
      for (const [k, v] of Object.entries(r.details).filter(([k]) => !k.startsWith('raw_'))) L.push(`     ${k}：${v}`);
      L.push(`     問：${c.q}`, `     答：${String(r.final).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  const s = res.summary;
  L.push('', `結果：通過 ${s.passed}／${s.total}（${Math.round((s.passed / s.total) * 100)}%）`);
  const hf = Object.entries(s.hardFails);
  if (hf.length) L.push(`硬性失敗（使用者實際會看到）：${hf.map(([k, v]) => `${k} ×${v}`).join('、')}`);
  const sf = Object.entries(s.softFails);
  L.push(sf.length ? `軟性（模型原始輸出沒守規矩，出口已修正）：${sf.map(([k, v]) => `${k} ×${v}`).join('、')}` : '軟性：模型原始輸出全都守規矩');
  if (cmp) {
    L.push('', `── 跟基準比（${cmp.baselineModel || '?'}，${String(cmp.baselineDate || '').slice(0, 10)}）──`);
    L.push(cmp.regressions.length ? `🔻 退步 ${cmp.regressions.length} 題：${cmp.regressions.join('、')}` : '🔻 沒有退步');
    if (cmp.fixed.length) L.push(`🔺 進步 ${cmp.fixed.length} 題：${cmp.fixed.join('、')}`);
    if (cmp.added.length) L.push(`➕ 新增題目（基準沒有）：${cmp.added.join('、')}`);
    L.push(`模型原始輸出的軟性失敗次數：${cmp.softDelta > 0 ? '+' : ''}${cmp.softDelta}`);
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { runs: 1, failOn: 'any' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--cases') o.casesFile = next(); else if (a === '--provider') o.provider = next(); else if (a === '--mock') o.mock = next();
    else if (a === '--profile') o.profile = next(); else if (a === '--model') o.model = next(); else if (a === '--thinking') o.thinking = next();
    else if (a === '--runs') o.runs = Math.max(1, Number(next()) || 1); else if (a === '--only') o.only = next().split(',');
    else if (a === '--tag') o.tag = next(); else if (a === '--save') o.save = next(); else if (a === '--baseline') o.baseline = next();
    else if (a === '--fail-on') o.failOn = next(); else if (a === '--json') o.json = true;
    else { console.error(`不認得的選項：${a}\n（用法見這支檔案開頭的註解）`); process.exit(2); }
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  o.provider ||= 'anthropic';
  if (o.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) { console.error('要打真的模型需要 ANTHROPIC_API_KEY。只想確認題庫沒壞：--provider mock --mock tools/eval/mock-good.json'); process.exit(2); }
  if (o.provider === 'mock' && !o.mock) { console.error('--provider mock 需要 --mock <答案檔>'); process.exit(2); }
  if (o.provider === 'anthropic') console.error(`⚠️ 會呼叫真的模型：約 ${(o.only?.length || 20) * o.runs} 次（每次約幾分錢以內）。`);
  const res = await runEval(o);
  let cmp = null;
  if (o.baseline) cmp = compareToBaseline(res, JSON.parse(fs.readFileSync(path.resolve(ROOT, o.baseline), 'utf8')));
  if (o.save) { fs.mkdirSync(path.dirname(path.resolve(ROOT, o.save)), { recursive: true }); fs.writeFileSync(path.resolve(ROOT, o.save), JSON.stringify(res, null, 2)); }
  console.log(o.json ? JSON.stringify({ ...res, comparison: cmp }, null, 2) : formatReport(res, cmp));
  const failed = o.failOn === 'regress' && cmp ? cmp.regressions.length > 0 : res.summary.passed < res.summary.total;
  process.exit(failed ? 1 : 0);
}
