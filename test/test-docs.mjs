// 文件結構測試（批次 111）：LINE-PLAN.md 只放長期規格、批次紀錄在 docs/batches/，而且互相找得到。
//
// 為什麼要有：LINE-PLAN.md 曾經長到 6,700 行／513 KB（CLAUDE.md 要求每一批都往後接），單次讀不完。
// 拆開之後，最容易發生的退步有三種：① 又有人把批次紀錄接回 LINE-PLAN.md；② 新增批次忘了補索引；
// ③ 程式碼註解寫的「LINE-PLAN.md 批次 N／第 N 節／坑 N」其實找不到。這支把這三種都擋下來。
//（「搬家有沒有漏字」是一次性的事，已在批次 111 用整檔重組比對驗過——見 docs/batches 批次 111。）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + d : ''))); };

const plan = read('LINE-PLAN.md');
const planLines = plan.split('\n');
const BATCH_DIR = 'docs/batches';
const batchFiles = fs.readdirSync(path.join(ROOT, BATCH_DIR)).filter((f) => /^\d\d-batch-\d{3}\.md$/.test(f)).sort();
const index = read(`${BATCH_DIR}/README.md`);

/* ───────── 一、LINE-PLAN.md 只放長期規格 ───────── */
console.log('\n── 一、LINE-PLAN.md ──');
check('★ LINE-PLAN.md 不超過 600 行（現在約 325 行；超過代表又有人把批次紀錄接回來了——請改接在 docs/batches/ 最新那份）', planLines.length <= 600, `${planLines.length} 行`);
// 第 7 節有兩個「### 批次 1 不需要任何前置」「### 批次 2 之前要做的」，那是人類待辦（規格），不是批次紀錄；批次紀錄的標題一律是「批次 N：」（全形冒號）
check('　 裡面沒有批次紀錄章節（沒有「### 批次 N：標題」「## 批次 N：標題」）', !planLines.some((l) => /^#{2,3} 批次 \d+(?:\.\d+)?：/.test(l)));
check('　 長期規格的章節都在：第 0～9 節', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => planLines.some((l) => l.startsWith(`## ${n}. `))));
check('　 「七個坑」都在（第 3 節，程式碼註解常引用「坑 N」）', [1, 2, 3, 4, 5, 6, 7].every((n) => planLines.some((l) => l.startsWith(`### 坑 ${n}：`))));

/* ───────── 二、批次檔案與索引 ───────── */
console.log('\n── 二、docs/batches/ ──');
check('批次檔案命名一致（NN-batch-AAA.md，NN 連號、AAA 是那份第一個批次）', batchFiles.length >= 9 && batchFiles.every((f, i) => f.startsWith(String(i + 1).padStart(2, '0') + '-')), batchFiles.join(', '));
const startOf = (f) => Number(f.match(/-batch-(\d{3})\.md$/)[1]);
check('　 每份第一個批次編號遞增', batchFiles.every((f, i) => i === 0 || startOf(f) > startOf(batchFiles[i - 1])));
check('　 每份都有「搬來的／行號是當時狀態」開頭說明，並連回 LINE-PLAN.md 與索引',
  batchFiles.every((f) => { const t = read(`${BATCH_DIR}/${f}`).split('\n').slice(0, 8).join('\n'); return /^# 施工批次紀錄：批次 \d+/.test(t) && /\.\.\/\.\.\/LINE-PLAN\.md/.test(t) && /README\.md/.test(t) && /自己 grep/.test(t); }));
const latest = batchFiles[batchFiles.length - 1];
const latestLines = read(`${BATCH_DIR}/${latest}`).split('\n').length;
check(`　 最新那份（${latest}）不超過 1,300 行（約 900 行就該開下一份：10-batch-NNN.md，並補 LINE-PLAN.md 第 5 節的表與索引）`, latestLines <= 1300, `${latestLines} 行`);
check('　 其他每份都不超過 1,300 行（沒有又長成讀不完的檔案）', batchFiles.every((f) => read(`${BATCH_DIR}/${f}`).split('\n').length <= 1300));
check('LINE-PLAN.md 第 5 節的表列出每一份批次檔案', batchFiles.every((f) => plan.includes(`(docs/batches/${f})`)), batchFiles.filter((f) => !plan.includes(`(docs/batches/${f})`)).join(', '));

// 批次標題：照 docs/batches/README.md 規定的格式（## 或 ### ＋「批次 N：」），略過 ``` 圍欄裡的內容
const headings = [];
for (const f of batchFiles) {
  let fence = false;
  for (const line of read(`${BATCH_DIR}/${f}`).split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (fence) continue;
    const m = /^(?:###|##) (.+)$/.exec(line);
    if (!m) continue;
    const mm = /^批次 (\d+(?:\.\d+)?)：(.*)$/.exec(m[1]);
    headings.push({ file: f, num: mm ? mm[1] : null, title: (mm ? mm[2] : m[1]).trim() });
  }
}
const rows = [...index.matchAll(/^\| (\S+) \| (.+) \| \[([^\]]+)\]\(([^)]+)\) \|$/gm)].map((m) => ({ num: m[1] === '—' ? null : m[1], title: m[2].replace(/\\\|/g, '|').trim(), file: m[3], link: m[4] }));
check('★ 索引的每一列都對得上一個批次標題（標題與所在檔案一致），反過來每個批次標題都在索引裡',
  rows.length === headings.length && headings.every((h, i) => rows[i] && rows[i].num === h.num && rows[i].title === h.title && rows[i].file === h.file),
  `索引 ${rows.length} 列、標題 ${headings.length} 個；第一個不一致：` + JSON.stringify(headings.find((h, i) => !rows[i] || rows[i].num !== h.num || rows[i].title !== h.title || rows[i].file !== h.file)));
check('　 索引裡的連結都指到真的批次檔案', rows.every((r) => r.link === r.file && batchFiles.includes(r.file)));
const nums = headings.filter((h) => h.num).map((h) => h.num);
check('　 批次編號不重複', new Set(nums).size === nums.length, nums.filter((n, i) => nums.indexOf(n) !== i).join(', '));
check('　 最新的批次編號 ≥ 111（本批次自己有被記下來）', Math.max(...nums.map(Number)) >= 111);

/* ───────── 三、連結都指得到 ───────── */
console.log('\n── 三、文件裡的相對連結 ──');
const docs = ['README.md', 'CLAUDE.md', 'SETUP.md', 'LINE-PLAN.md', 'GEO_SETUP.md', 'GEO-METHOD.md', 'FIX-PLAN.md', `${BATCH_DIR}/README.md`, ...batchFiles.map((f) => `${BATCH_DIR}/${f}`)];
const broken = [];
for (const d of docs) {
  let fence = false;
  for (const line of read(d).split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (fence) continue;
    // 行內程式碼（`...`）裡的 [文字](網址) 是在舉例，不是連結
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = decodeURIComponent(target.split('#')[0]);
      if (!file) continue;
      if (!fs.existsSync(path.join(ROOT, path.dirname(d), file))) broken.push(`${d} → ${target}`);
    }
  }
}
check('★ README／CLAUDE／SETUP／LINE-PLAN／索引／每份批次檔案裡的相對連結全部指得到檔案', broken.length === 0, broken.slice(0, 8).join('\n   '));

/* ───────── 四、程式碼註解的引用找得到 ───────── */
console.log('\n── 四、程式碼註解的引用 ──');
const srcFiles = [];
for (const d of ['api', 'lib', 'public', 'test', 'tools', 'assets']) {
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(js|mjs|html|py)$/.test(e.name)) srcFiles.push(p); } };
  walk(d);
}
const batchNums = new Set(nums);
const badBatch = [], badSection = [], badPit = [];
for (const f of srcFiles) {
  const t = read(f);
  for (const m of t.matchAll(/LINE-PLAN(?:\.md)?\s*[「（(]?\s*批次\s*(\d+(?:\.\d+)?)/g)) if (!batchNums.has(m[1])) badBatch.push(`${f}: 批次 ${m[1]}`);
  for (const m of t.matchAll(/LINE-PLAN(?:\.md)?\s*[「（(]?\s*第\s*(\d+)\s*節/g)) if (!planLines.some((l) => l.startsWith(`## ${m[1]}. `))) badSection.push(`${f}: 第 ${m[1]} 節`);
  for (const m of t.matchAll(/LINE-PLAN(?:\.md)?\s*[「（(]?\s*坑\s*(\d+)/g)) if (!planLines.some((l) => l.startsWith(`### 坑 ${m[1]}：`))) badPit.push(`${f}: 坑 ${m[1]}`);
}
check('★ 註解寫「LINE-PLAN.md 批次 N」的，N 都在索引裡', badBatch.length === 0, [...new Set(badBatch)].slice(0, 10).join('\n   '));
check('　 註解寫「LINE-PLAN.md 第 N 節」的，那一節都還在 LINE-PLAN.md', badSection.length === 0, [...new Set(badSection)].slice(0, 10).join('\n   '));
check('　 註解寫「LINE-PLAN.md 坑 N」的，那個坑都還在', badPit.length === 0, [...new Set(badPit)].slice(0, 10).join('\n   '));
const refCount = srcFiles.reduce((n, f) => n + (read(f).match(/LINE-PLAN(?:\.md)?\s*[「（(]?\s*(?:批次|第\s*\d+\s*節|坑)\s*\d/g) || []).length, 0);
check('（自我檢查）真的掃到不少引用，不是正規表達式壞了所以全綠', refCount >= 12, `只掃到 ${refCount} 處`);

/* ───────── 五、CLAUDE.md 第 5 條與 README ───────── */
console.log('\n── 五、約定與入口 ──');
const claude = read('CLAUDE.md');
const rule5 = claude.slice(claude.indexOf('## 5.'));
check('★ CLAUDE.md 第 5 條指向 docs/batches/（不再叫人把紀錄接在 LINE-PLAN.md 後面）', /docs\/batches/.test(rule5) && !/往那份文件後面接/.test(rule5) && /不要再往它後面接/.test(rule5));
const readme = read('README.md');
check('README.md 是真的入口：有入口對照、先讀哪幾份、怎麼跑測試、動手前先記住', ['## 有哪些入口', '## 先讀這幾份', '## 開發與驗證', '## 動手前先記住'].every((h) => readme.includes(h)) && /npm test/.test(readme) && readme.split('\n').length > 30);
check('SETUP.md 的 Function 用量與實際相符（api/ 底下的 .js 數量）', (() => {
  const n = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length;
  const setup = read('SETUP.md');
  return setup.includes(`${n} 支真正的 API`) && setup.includes(`**${n} / 12（剩 ${12 - n} 格）**`);
})(), `api/ 實際 ${fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length} 支`);

console.log(`\n${fail ? '❌' : '✅'} 文件結構測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
