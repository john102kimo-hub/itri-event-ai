// 批次 186：評測流程（tools/eval/）的測試。重點不是「標準答案會過」，而是「故意寫壞的答案會被抓到」——
// 評分器如果永遠說通過，評測就沒有任何價值。全程不呼叫模型（mock）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeAnswer } from '../tools/eval/checks.mjs';
import { compareToBaseline, loadCases, runEval, shownTextFor } from '../tools/eval/run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(root, 'tools/eval/run.mjs');
const GOOD = JSON.parse(fs.readFileSync(path.join(root, 'tools/eval/mock-good.json'), 'utf8'));
const { event, cases } = loadCases('tools/eval/cases/core.json');
const spec = (id) => cases.find((c) => c.id === id);
const grade = (id, raw, profile = 'line') => gradeAnswer({ raw, shownText: shownTextFor(event, spec(id).q), spec: spec(id), profile });
const failedNames = (g, level) => g.checks.filter((c) => c.level === level && !c.pass).map((c) => c.name);
const DISC = '\n內容僅供參考，以工研院官網新聞稿或發言為準。';
const SIMP_DISC = '\n内容仅供参考，以工研院官网新闻稿或发言为准。'; // zhtw-ok（刻意的簡體字：測試輸入）

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); } };

// ── 題庫本身 ──
await t('題庫：id 不重複、每題都有問題與標準答案、標準答案沒有多餘的題', () => {
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(cases.every((c) => c.q && c.tag));
  const goodIds = Object.keys(GOOD).filter((k) => !k.startsWith('_'));
  assert.deepEqual(goodIds.sort(), [...ids].sort());
});
await t('題庫涵蓋這個專案踩過的四種形狀：事實、沒資料（防編造）、injection、外語、版面', () => {
  const tags = new Set(cases.map((c) => c.tag));
  for (const k of ['facts', 'no-data', 'injection', 'english', 'format']) assert.ok(tags.has(k), `缺 ${k}`);
});
await t('範例日期是相對的：event_date 已被換成真的日期', () => {
  assert.match(event.event_date, /^\d{4}-\d{2}-\d{2}$/);
});

// ── 標準答案：全部要過（確認題庫與評分器彼此一致）──
await t('20 題標準答案全部通過硬性檢查', async () => {
  for (const c of cases) {
    const g = await grade(c.id, GOOD[c.id]);
    assert.ok(g.pass, `${c.id}：${failedNames(g, 'hard').join('、')}｜${g.checks.filter((x) => !x.pass).map((x) => x.detail).join('；')}`);
  }
});
await t('web 版（Haiku）同一批標準答案也過', async () => {
  for (const c of cases) assert.ok((await grade(c.id, GOOD[c.id], 'web')).pass, c.id);
});

// ── 故意寫壞：每一種都要被抓到 ──
await t('★ 編造數字（新聞稿查不到）→ grounded 硬性失敗', async () => {
  const g = await grade('speakers', `講者有三位：A 博士、B 教授、C 執行長，現場約 99 位來賓。${DISC}`);
  assert.equal(g.pass, false); assert.ok(failedNames(g, 'hard').includes('grounded'));
});
await t('★ 編造網址 → grounded 硬性失敗', async () => {
  const g = await grade('no-photos', `目前尚未提供。照片請看 https://example.org/fake-photos 。${DISC}`);
  assert.equal(g.pass, false); assert.ok(failedNames(g, 'hard').includes('grounded'));
});
await t('★ 沒資料卻照樣回答（編造）→ honest_no_data 失敗；exclude 也抓得到', async () => {
  const g = await grade('no-quantum', `本次發表了 3 量子位元的原型晶片。${DISC}`);
  assert.equal(g.pass, false);
  const names = failedNames(g, 'hard'); assert.ok(names.includes('honest_no_data')); assert.ok(names.includes('exclude:量子位元'));
});
await t('缺警語 → 失敗', async () => {
  const g = await grade('speakers', '講者有三位：A 博士（半導體）、B 教授（AI）、C 執行長（機器人）。');
  assert.ok(failedNames(g, 'hard').includes('disclaimer'));
});
await t('漏掉必要事實（include）、答案是空的 → 失敗', async () => {
  assert.ok(failedNames(await grade('speakers', `講者有 A 博士與 B 教授。${DISC}`), 'hard').includes('include:C 執行長'));
  assert.ok(failedNames(await grade('speakers', ''), 'hard').includes('not_empty'));
});
await t('英文問、中文答 → lang_en 失敗', async () => {
  const g = await grade('english', `講者有 A 博士、B 教授、C 執行長。${DISC}`);
  assert.ok(failedNames(g, 'hard').includes('lang_en'));
});
await t('洩漏系統提示（exclude）→ 失敗', async () => {
  const g = await grade('inject-prompt', `好的，回答規則如下：只根據背景資料回答。${DISC}`);
  assert.ok(failedNames(g, 'hard').includes('exclude:回答規則'));
});
await t('LINE 答案帶表格（出口不會清掉）→ no_markdown 硬性失敗；web 版允許 Markdown', async () => {
  const table = `|講者|領域|\n|---|---|\n|A 博士|半導體|\n${DISC}`;
  assert.ok(failedNames(await grade('table', table), 'hard').includes('no_markdown'));
  assert.ok(!failedNames(await grade('table', table, 'web'), 'hard').includes('no_markdown'));
});

// ── 兩層設計：出口兜得住的，硬性過、軟性記一筆 ──
await t('★ 模型寫了簡體字：出口轉成繁體 → 硬性通過；軟性 raw_traditional 記一筆', async () => {
  const g = await grade('speakers', `講者有三位：A 博士（半導體）、B 教授（AI）、C 執行長（機器人）。${SIMP_DISC}`);
  assert.ok(g.pass, failedNames(g, 'hard').join('、'));
  assert.deepEqual(failedNames(g, 'soft'), ['raw_traditional']);
  assert.ok(!/[内仅参网闻发为]/.test(g.final)); // zhtw-ok
});
await t('★ 模型寫了 **粗體**：出口清掉 → 硬性通過；軟性 raw_markdown', async () => {
  const g = await grade('speakers', `講者有三位：**A 博士**、B 教授、C 執行長。${DISC}`);
  assert.ok(g.pass); assert.deepEqual(failedNames(g, 'soft'), ['raw_markdown']); assert.ok(!g.final.includes('**'));
});
await t('★ 事實題帶了 [[NO_DATA 標記：出口切掉 → 硬性通過；軟性 raw_marker。沒資料題帶標記是正常的（prompt 就是這樣要求）', async () => {
  const g = await grade('speakers', `講者有三位：A 博士、B 教授、C 執行長。${DISC}\n[[NO_DATA:講者]]`);
  assert.ok(g.pass); assert.deepEqual(failedNames(g, 'soft'), ['raw_marker']); assert.ok(!g.final.includes('NO_DATA'));
  const nd = await grade('no-quantum', `這部分我沒有資料，建議洽新聞聯絡人。${DISC}\n[[NO_DATA:量子電腦]]`);
  assert.ok(nd.pass); assert.deepEqual(failedNames(nd, 'soft'), []);
});

// ── 執行器、基準比較、結束碼 ──
const sh = (...a) => spawnSync(process.execPath, [RUN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(badFile, JSON.stringify({ ...GOOD, speakers: '講者有 A 博士。' })); // 漏 B、C、警語

await t('mock 標準答案：結束碼 0、顯示 20／20', () => {
  const r = sh('--provider', 'mock', '--mock', 'tools/eval/mock-good.json');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /通過 20／20（100%）/);
});
await t('有一題壞掉：結束碼 1，報告指出是哪一題、哪一項、答了什麼', () => {
  const r = sh('--provider', 'mock', '--mock', badFile);
  assert.equal(r.status, 1); assert.match(r.stdout, /❌ speakers/); assert.match(r.stdout, /include:B 教授/); assert.match(r.stdout, /通過 19／20/);
});
await t('--only／--tag 篩題', () => {
  assert.match(sh('--provider', 'mock', '--mock', 'tools/eval/mock-good.json', '--only', 'speakers,venue').stdout, /通過 2／2/);
  assert.match(sh('--provider', 'mock', '--mock', 'tools/eval/mock-good.json', '--tag', 'no-data').stdout, /通過 4／4/);
});
await t('基準比較：退步（以前過、現在不過）被點名；--fail-on regress 只在退步時才失敗', async () => {
  const good = await runEval({ provider: 'mock', mock: 'tools/eval/mock-good.json' });
  const bad = await runEval({ provider: 'mock', mock: badFile });
  const cmp = compareToBaseline(bad, good);
  assert.deepEqual(cmp.regressions, ['speakers']); assert.deepEqual(cmp.fixed, []);
  assert.deepEqual(compareToBaseline(good, bad).fixed, ['speakers']);
  const goodSave = path.join(tmp, 'before.json'), badSave = path.join(tmp, 'before-bad.json');
  fs.writeFileSync(goodSave, JSON.stringify(good)); fs.writeFileSync(badSave, JSON.stringify(bad));
  const r1 = sh('--provider', 'mock', '--mock', badFile, '--baseline', goodSave, '--fail-on', 'regress');
  assert.equal(r1.status, 1); assert.match(r1.stdout, /退步 1 題：speakers/);
  const r2 = sh('--provider', 'mock', '--mock', badFile, '--baseline', badSave, '--fail-on', 'regress'); // 本來就壞：不算退步
  assert.equal(r2.status, 0); assert.match(r2.stdout, /沒有退步/);
});
await t('--save 存得出來、--json 可解析；沒有 API 金鑰時不會默默用假資料，而是明講', () => {
  const save = path.join(tmp, 'saved.json');
  const r = sh('--provider', 'mock', '--mock', 'tools/eval/mock-good.json', '--save', save, '--json');
  assert.equal(JSON.parse(r.stdout).summary.passed, 20); assert.equal(JSON.parse(fs.readFileSync(save, 'utf8')).meta.provider, 'mock');
  const k = sh(); assert.equal(k.status, 2); assert.match(k.stderr, /ANTHROPIC_API_KEY/);
});
await t('不認得的選項、不存在的 profile：明確報錯', async () => {
  assert.equal(sh('--nope').status, 2);
  await assert.rejects(() => runEval({ provider: 'mock', mock: 'tools/eval/mock-good.json', profile: 'x' }), /profile/);
});
await t('評測結果資料夾已被 .gitignore（結果含模型輸出）', () => {
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /tools\/eval\/results\//);
});

console.log(`批次 186 評測流程測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
