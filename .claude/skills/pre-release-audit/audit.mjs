// 上線前盤點的「機器能算的部分」（批次 186）。人才判斷得了的部分（LINE 帳號、解禁時間、同仁實測）在 SKILL.md。
//
//   node .claude/skills/pre-release-audit/audit.mjs           只看、不跑測試（幾秒）
//   node .claude/skills/pre-release-audit/audit.mjs --tests   連 CI 的三輪測試一起跑（約 5 分鐘）
//   node .claude/skills/pre-release-audit/audit.mjs --json
//
// 檢查項目都是這個專案自己踩過、或自己寫下來的規則：
//   ① api/ 的 Function 數（Vercel 免費方案上限 12，SETUP.md；一支都不能多）
//   ② 程式讀了、但 SETUP.md／GEO_SETUP.md／README 都沒寫的環境變數（上線後才發現沒設，是最常見的「部署成功但功能沒開」）
//   ③ 被 git 追蹤的敏感檔（.env、真實問答資料、私鑰）
//   ④ 最新批次紀錄有沒有寫（CLAUDE.md 第 5 條）：最後一批的日期距今多久
//   ⑤（--tests）CI 的三輪：npm test／SHIFT_DAYS=90 npm test／業發處開著再跑一輪（.github/workflows/test.yml）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SENSITIVE_PATHS } from '../../hooks/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FUNCTION_LIMIT = 12;
// 這些環境變數是測試／平台自己用的，不需要寫進部署說明
const ENV_IGNORE = new Set([
  'NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA', 'CI', 'TZ', 'HOME', 'PATH',
  'EVENTS_TABLE_TTL_MS', 'SHIFT_DAYS', 'JOBS', 'LOCAL_STORE_DIR'
]);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(m?js)$/.test(e.name) ? [path.join(dir, e.name)] : []);

export function audit() {
  const results = [];
  const add = (name, ok, detail = '') => results.push({ name, ok, detail });

  // ① Function 數
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => /\.m?js$/.test(f));
  add(`api/ 的 Function 數 ≤ ${FUNCTION_LIMIT}`, fns.length <= FUNCTION_LIMIT, `${fns.length} 支（${FUNCTION_LIMIT - fns.length} 個空位）`);

  // ② 環境變數有沒有寫進文件
  const used = new Map();
  for (const f of [...walk('api'), ...walk('lib')]) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], f);
    }
  }
  const docs = ['SETUP.md', 'GEO_SETUP.md', 'README.md', 'LINE-PLAN.md'].map((f) => fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '').join('\n');
  const undocumented = [...used].filter(([k]) => !ENV_IGNORE.has(k) && !docs.includes(k));
  add('程式用到的環境變數都有寫進 SETUP／GEO_SETUP／README', undocumented.length === 0,
    undocumented.length ? undocumented.map(([k, f]) => `${k}（${f}）`).join('、') : `${used.size} 個，全有文件`);

  // ③ 追蹤中的敏感檔
  const tracked = sh('git', ['ls-files']).stdout.split('\n').filter(Boolean);
  const bad = tracked.filter((f) => SENSITIVE_PATHS.some(([re]) => re.test(f)));
  add('沒有敏感檔被 git 追蹤（.env、真實問答、私鑰）', bad.length === 0, bad.join('、'));

  // ④ 批次紀錄
  const dir = path.join(ROOT, 'docs', 'batches');
  const latest = fs.readdirSync(dir).filter((f) => /^\d\d-batch-\d{3}\.md$/.test(f)).sort().pop();
  const dates = [...fs.readFileSync(path.join(dir, latest), 'utf8').matchAll(/^## 批次 \d+：.*（(\d{4}-\d{2}-\d{2})）\s*$/gm)].map((m) => m[1]);
  const lastDate = dates.sort().pop();
  const days = lastDate ? Math.floor((Date.now() - Date.parse(lastDate + "T00:00:00Z")) / 86400000) : null;
  add('最新批次紀錄有寫日期、且不是太久以前', days !== null && days <= 14, lastDate ? `最後一批 ${lastDate}（${days} 天前）；改了東西卻沒記？見 batch-log skill` : '找不到日期');

  return results;
}

export function runTests() {
  const rounds = [
    ['npm test', {}],
    ['SHIFT_DAYS=90 npm test（抓寫死的日期）', { SHIFT_DAYS: '90' }],
    ['業發處開著再跑一輪', { B2B_SPREADSHEET_ID: 'ci-b2b-should-stay-untouched', ANTHROPIC_API_KEY_BUSINESS: 'ci-business-key' }]
  ];
  return rounds.map(([name, env]) => {
    const r = sh(process.execPath, ['test/run-all.mjs'], { env: { ...process.env, ...env }, timeout: 600_000 });
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').pop();
    return { name: `測試：${name}`, ok: r.status === 0, detail: tail };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = audit();
  if (process.argv.includes('--tests')) results.push(...runTests());
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `\n     ${r.detail}` : ''}`);
    console.log(results.every((r) => r.ok) ? '\n機器能查的部分都過了。接著照 SKILL.md 做人工確認。' : '\n有項目沒過，先處理再上線。');
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
