// 跑完 test/ 底下全部測試，最後彙整成一張表，有任何一支失敗就以非 0 結束。
//
//   npm test                         （等於 node test/run-all.mjs）
//   node test/run-all.mjs flow batch  只跑檔名含「flow」或「batch」的
//   SHIFT_DAYS=45 npm test           把「現在」往後推 45 天再跑一遍——專門抓日期炸彈
//
// 為什麼不再用 package.json 裡一長串 `a && b && c`（批次 103）：
//   ① `&&` 一支失敗，後面全部不跑。2026-10-02 測試資料裡一場活動寫死的日期過了，test-flow 紅了，
//      排在它後面的 20 支測試等於整批消失，沒人知道它們是綠是紅。
//   ② 清單是手寫的，新增的測試檔很容易忘了加（test-batch101 就這樣躺了好幾批沒進清單，
//      批次 101 留下的群組守門退步因此沒被任何測試擋下）。
// 現在是**掃資料夾**：檔名是 test-*.mjs 或 *.test.mjs 的都跑，新增測試不用再改清單。
// 每支各開一個 node 行程（模組層快取、環境變數互不污染），一次跑 4 支。
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const filters = process.argv.slice(2);

const files = readdirSync(dir)
  .filter(f => /^test-.*\.mjs$/.test(f) || /\.test\.mjs$/.test(f))
  .filter(f => !filters.length || filters.some(k => f.includes(k)))
  .sort();

if (!files.length) {
  console.error('找不到符合條件的測試檔');
  process.exit(2);
}

// SHIFT_DAYS：每支測試的「現在」往後推幾天（見 tools/time-travel/shift.mjs）
const shift = Number(process.env.SHIFT_DAYS || 0);
const nodeArgs = shift
  ? ['--import', path.join(root, 'tools', 'time-travel', 'shift.mjs')]
  : [];
if (shift) console.log(`⏩ 時間位移：現在 +${shift} 天\n`);

const JOBS = Math.max(1, Number(process.env.JOBS || 4));

function runOne(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, path.join('test', file)], { cwd: root, env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ file, code, out, ms: Date.now() - t0 }));
  });
}

// 從輸出裡抓最後一行「通過／失敗」之類的摘要，只是給人看的，判斷成敗一律看結束碼
function summaryOf(out) {
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  const hit = [...lines].reverse().find(l => /(通過|passed|全部通過|OK|失敗)/.test(l) && !/^\[line\]/.test(l));
  return (hit || '').slice(0, 70);
}

const queue = [...files];
const results = [];
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const r = await runOne(f);
    results.push(r);
    process.stdout.write(`${r.code === 0 ? '✅' : '❌'} ${f}\n`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));

results.sort((a, b) => a.file.localeCompare(b.file));
const failed = results.filter(r => r.code !== 0);

console.log('\n──────── 彙整 ────────');
for (const r of results) {
  console.log(`${r.code === 0 ? '✅' : '❌'} ${r.file.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${summaryOf(r.out)}`);
}
console.log(`\n共 ${results.length} 支，通過 ${results.length - failed.length}，失敗 ${failed.length}，總耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

if (failed.length) {
  console.log('\n──────── 失敗的輸出（只列 ❌ 與失敗行）────────');
  for (const r of failed) {
    console.log(`\n### ${r.file}（結束碼 ${r.code}）`);
    const lines = r.out.split('\n');
    const bad = lines.filter(l => /❌|✗|FAIL|AssertionError|Error:/.test(l) && !/^\[line\]/.test(l));
    console.log((bad.length ? bad : lines.slice(-15)).slice(0, 40).join('\n'));
  }
  process.exit(1);
}
