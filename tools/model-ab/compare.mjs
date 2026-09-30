// Sonnet 5 vs Sonnet 5.5 答題比較（批次 99）。同一份知識庫、同一批問題，用跟 api/line.js 相同的
// system prompt 組法與請求參數，並排列出答案、延遲、token。
//   ANTHROPIC_API_KEY=sk-ant-... node tools/model-ab/compare.mjs tools/model-ab/sample.json [--runs 2]
// ⚠️ 會花真的錢：每題 × 2 個模型 × runs 次，各一次呼叫（約幾分錢～幾毛錢；問題數乘上去）。
// 只有這支腳本會呼叫模型，`npm test` 不會跑它。
import fs from 'node:fs';
import { buildSystemPrompt } from '../../lib/prompt.js';
import { ZH_TW_RULE, toTraditionalTW } from '../../lib/zh-tw.js';

const [file, ...rest] = process.argv.slice(2);
const runs = Number(rest[rest.indexOf('--runs') + 1]) || 1;
if (!file || !process.env.ANTHROPIC_API_KEY) {
  console.error('用法：ANTHROPIC_API_KEY=... node tools/model-ab/compare.mjs <題目.json> [--runs N]\n題目檔格式見 tools/model-ab/sample.json');
  process.exit(1);
}
const { event, questions } = JSON.parse(fs.readFileSync(file, 'utf8'));
const system = [buildSystemPrompt({ organizer: '工研院', ...event }), ZH_TW_RULE].join('\n');

// thinking 寫法跟正式站一致：Sonnet 5 用 disabled，Sonnet 5.5 拒收它、改 between_tools
const MODELS = [
  { id: 'claude-sonnet-5', thinking: { type: 'disabled' } },
  { id: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } }
];
async function ask(model, q) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model.id, thinking: model.thinking, max_tokens: 4096,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: q }] })
  });
  const data = await res.json();
  if (!res.ok) return { ms: Date.now() - t0, text: `（錯誤 ${res.status}：${data.error?.message}）`, out: 0 };
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { ms: Date.now() - t0, text: toTraditionalTW(text), out: data.usage?.output_tokens ?? 0 };
}

const stat = Object.fromEntries(MODELS.map((m) => [m.id, { ms: [], out: [] }]));
for (const q of questions) {
  console.log(`\n## ${q}\n`);
  for (const m of MODELS) {
    for (let i = 0; i < runs; i++) {
      const r = await ask(m, q);
      stat[m.id].ms.push(r.ms); stat[m.id].out.push(r.out);
      console.log(`**${m.id}**（${(r.ms / 1000).toFixed(1)} 秒、輸出 ${r.out} tokens）\n\n${r.text}\n`);
    }
  }
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log('\n## 總結\n\n| 模型 | 平均延遲 | 最慢 | 平均輸出 tokens |\n|---|---|---|---|');
for (const m of MODELS) console.log(`| ${m.id} | ${(avg(stat[m.id].ms) / 1000).toFixed(1)} 秒 | ${(Math.max(...stat[m.id].ms) / 1000).toFixed(1)} 秒 | ${Math.round(avg(stat[m.id].out))} |`);
console.log('\n答案好不好要人看：重點看「有沒有編造資料裡沒有的內容」「名單類有沒有漏」「資料沒有時是否老實說沒有」。');
