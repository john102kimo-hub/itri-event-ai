// 批次 126：AI 能見度掃描用 Haiku 5.5（朱朱 10/12）。
// 以前 api/geo.js 預設 Opus 5，正式站沒設 GEO_MODEL，實際跑的就是 Opus 5。這支釘住三件事：
//   一、預設模型是 Haiku 5.5
//   二、Haiku 5.5 拿到的是基本版搜尋工具（web_search_20250305）——它不支援動態過濾版，送了會 400；
//       Opus／Sonnet 照舊拿動態過濾版
//   三、送給 Anthropic 的請求裡沒有 Haiku 5.5 會拒收的參數（budget_tokens）
import { readFileSync } from 'node:fs';

const GEO = readFileSync(new URL('../api/geo.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

console.log('── 一、預設模型 ──');
const line = (GEO.match(/^const PROBE_MODEL = .*$/m) || [''])[0];
check('★ 沒設 GEO_MODEL 時，AI 能見度掃描用 Haiku 5.5（以前是 Opus 5）', /process\.env\.GEO_MODEL \|\| 'claude-haiku-5-5'/.test(line), line);
check('　 GEO_MODEL 照樣可以蓋過預設（想換模型不用改程式）', /process\.env\.GEO_MODEL/.test(line), line);

console.log('\n── 二、搜尋工具的版本跟著模型走 ──');
const src = (GEO.match(/const webSearchTool = \(model\) =>[\s\S]*?;\n/) || [''])[0];
let webSearchTool = null;
try { webSearchTool = new Function(`${src}\nreturn webSearchTool;`)(); } catch { webSearchTool = null; }
check('抽得出 webSearchTool()', typeof webSearchTool === 'function', src);
if (webSearchTool) {
  check('★ Haiku 5.5 → 基本版 web_search_20250305（它不支援動態過濾版，送了會 400）',
    webSearchTool('claude-haiku-5-5').type === 'web_search_20250305', JSON.stringify(webSearchTool('claude-haiku-5-5')));
  check('　 Opus 5／Sonnet 5.5 照舊用動態過濾版 web_search_20260209（有人設 GEO_MODEL 換回去時不受影響）',
    webSearchTool('claude-opus-5').type === 'web_search_20260209' && webSearchTool('claude-sonnet-5-5').type === 'web_search_20260209');
}

console.log('\n── 三、Haiku 5.5 會拒收的參數 ──');
// 比對的是「當參數送出去」的寫法（budget_tokens:），註解裡提到這個字不算
check('★ 不送 budget_tokens（Haiku 5.5 只吃 adaptive thinking＋effort，收到 budget_tokens 回 400）', !/budget_tokens\s*:/.test(GEO));
const anthropicBodies = [...GEO.matchAll(/await anthropic\(\{[\s\S]*?\}\s*(?:,\s*timeoutMs)?\)/g)].map((m) => m[0]);
check('　 送給 Anthropic 的請求都沒有 temperature／top_p／top_k（Haiku 5.5 收到非預設值回 400）',
  anthropicBodies.length > 0 && anthropicBodies.every((b) => !/temperature|top_p|top_k/.test(b)), anthropicBodies.length);

console.log(`\n${fail ? '❌' : '✅'} 批次 126（AI 能見度掃描用 Haiku 5.5）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
