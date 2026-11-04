// 批次 186：Claude Code hooks（.claude/hooks/）的測試。
// 用暫時的 git repo 模擬「Claude 要 commit／剛改完檔案」，確認該擋的擋、不該擋的不擋。
// 不呼叫任何 API；before-commit 的「跑全部測試」那一步用 HOOK_SKIP_TESTS=1 關掉（否則會遞迴跑自己）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEFORE = path.join(root, '.claude/hooks/before-commit.mjs');
const AFTER = path.join(root, '.claude/hooks/after-edit.mjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); } };

function run(script, input, env = {}) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOOK_SKIP_TESTS: '1', ...env } });
  return { code: r.status, err: r.stderr };
}
const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}：${r.stderr}`); };
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'README.md'), '# 測試\n'); sh(d, 'add', '.'); sh(d, 'commit', '-q', '-m', 'init');
  return d;
}
const put = (d, f, text) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); };
const commit = (cwd, command = 'git commit -m x') => run(BEFORE, { tool_name: 'Bash', cwd, tool_input: { command } });

// 簡體字測試資料：這支檔案在 test/ 底下，本來就不受 hook 檢查
const SIMP = '内容仅供参考，以官网新闻稿为准。';
const FAKE_KEY = 'sk-ant-' + 'a1B2c3D4'.repeat(4);

// ── before-commit ──
t('不是 git commit 的指令：立刻放行', () => {
  assert.equal(run(BEFORE, { tool_input: { command: 'ls -la' } }).code, 0);
  assert.equal(run(BEFORE, { tool_input: { command: 'git status' } }).code, 0);
});
t('git commit --dry-run 不攔', () => {
  const d = repo(); put(d, '.env', 'X=1'); sh(d, 'add', '-f', '.env');
  assert.equal(commit(d, 'git commit --dry-run').code, 0);
});
t('staged 有 .env → 擋', () => {
  const d = repo(); put(d, '.env', 'ANTHROPIC_API_KEY=x'); sh(d, 'add', '-f', '.env');
  const r = commit(d); assert.equal(r.code, 2); assert.match(r.err, /\.env/);
});
t('.env.example 可以進', () => {
  const d = repo(); put(d, '.env.example', 'ANTHROPIC_API_KEY='); sh(d, 'add', '.');
  assert.equal(commit(d).code, 0);
});
t('真實資料檔（*.local.json、後台匯出 CSV）→ 擋', () => {
  for (const f of ['tools/grounding-backtest/my.local.json', 'all-events-qa-2026-10-12.csv', 'x-qa-2026-10-12.csv']) {
    const d = repo(); put(d, f, '{}'); sh(d, 'add', '-f', f);
    assert.equal(commit(d).code, 2, f);
  }
});
t('疑似金鑰 → 擋', () => {
  const d = repo(); put(d, 'lib/x.js', `const k = '${FAKE_KEY}';\n`); sh(d, 'add', '.');
  const r = commit(d); assert.equal(r.code, 2); assert.match(r.err, /Anthropic/);
});
t('簡體字 → 擋；同一行有 zhtw-ok → 放行；繁體 → 放行', () => {
  let d = repo(); put(d, 'docs/a.md', `${SIMP}\n`); sh(d, 'add', '.');
  const r = commit(d); assert.equal(r.code, 2); assert.match(r.err, /簡體字/); assert.match(r.err, /docs\/a\.md:1/);
  d = repo(); put(d, 'docs/a.md', `${SIMP} <!-- zhtw-ok -->\n`); sh(d, 'add', '.');
  assert.equal(commit(d).code, 0);
  d = repo(); put(d, 'docs/a.md', '內容僅供參考，以官網新聞稿為準。\n'); sh(d, 'add', '.');
  assert.equal(commit(d).code, 0);
});
t('test/ 與 lib/zh-tw.js 豁免（本來就要放簡體字）', () => {
  const d = repo(); put(d, 'test/test-x.mjs', `// ${SIMP}\n`); put(d, 'lib/zh-tw.js', `// ${SIMP}\n`); sh(d, 'add', '.');
  assert.equal(commit(d).code, 0);
});
t('只檢查「新增的行」，既有檔案裡原有的簡體字不會被連坐', () => {
  const d = repo(); put(d, 'docs/old.md', `${SIMP}\n`); sh(d, 'add', '.'); sh(d, 'commit', '-q', '-m', 'old', '--no-verify');
  put(d, 'docs/old.md', `${SIMP}\n這一行是繁體。\n`); sh(d, 'add', '.');
  assert.equal(commit(d).code, 0);
});
t('git add -A && git commit：還沒 add 的新檔也要查', () => {
  const d = repo(); put(d, 'docs/new.md', `${SIMP}\n`);
  assert.equal(commit(d, 'git add -A && git commit -m x').code, 2);
  assert.equal(commit(d, 'git commit -m x').code, 0); // 沒有 add、也沒 staged：沒東西要提交，不攔
});
t('不在 repo 裡／沒有變更：放行', () => {
  assert.equal(commit(repo()).code, 0);
  assert.equal(commit(fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'))).code, 0);
});
t('壞掉的輸入不會讓 hook 擋工作', () => {
  const r = spawnSync(process.execPath, [BEFORE], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// ── after-edit ──
const edit = (cwd, file, extra) => run(AFTER, { tool_name: 'Edit', cwd, tool_input: { file_path: path.join(cwd, file), ...extra } });
t('改壞語法的 .mjs → 要 Claude 修（exit 2）；好的 → 0', () => {
  const d = repo(); put(d, 'lib/bad.mjs', 'export const = ;\n'); put(d, 'lib/ok.mjs', 'export const a = 1;\n');
  const bad = edit(d, 'lib/bad.mjs', { new_string: 'x' }); assert.equal(bad.code, 2); assert.match(bad.err, /語法錯誤/);
  assert.equal(edit(d, 'lib/ok.mjs', { new_string: 'x' }).code, 0);
});
t('新寫進去的簡體字 → 要 Claude 改；有標記或豁免路徑 → 0', () => {
  const d = repo(); put(d, 'docs/a.md', 'x\n'); put(d, 'test/a.mjs', 'x\n');
  const r = edit(d, 'docs/a.md', { new_string: SIMP }); assert.equal(r.code, 2); assert.match(r.err, /簡體字/);
  assert.equal(edit(d, 'docs/a.md', { new_string: `${SIMP} zhtw-ok` }).code, 0);
  assert.equal(edit(d, 'test/a.mjs', { new_string: SIMP }).code, 0);
  assert.equal(run(AFTER, { tool_name: 'Write', cwd: d, tool_input: { file_path: path.join(d, 'docs/a.md'), content: SIMP } }).code, 2);
  assert.equal(run(AFTER, { tool_name: 'MultiEdit', cwd: d, tool_input: { file_path: path.join(d, 'docs/a.md'), edits: [{ new_string: '繁體' }, { new_string: SIMP }] } }).code, 2);
});
t('專案外的檔案、沒有 file_path：不管', () => {
  assert.equal(run(AFTER, { cwd: repo(), tool_input: { file_path: '/etc/hosts', new_string: SIMP } }).code, 0);
  assert.equal(run(AFTER, { cwd: repo(), tool_input: {} }).code, 0);
});

// ── settings.json 自己要是合法的、而且指到真的檔案 ──
t('.claude/settings.json 合法，且 hook 指令指到存在的檔案', () => {
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.length >= 2);
  for (const c of cmds) {
    const rel = /\.claude\/hooks\/[\w.-]+\.mjs/.exec(c)?.[0];
    assert.ok(rel && fs.existsSync(path.join(root, rel)), `找不到 ${c}`);
  }
});

console.log(`批次 186 hooks 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
