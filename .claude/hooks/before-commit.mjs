// PreToolUse（Bash）：Claude 要執行 `git commit` 之前，最後一道關。不是 git commit 的指令一律立刻放行。
//   ① 不該進 repo 的檔案：.env、真實問答資料（*.local.json、後台匯出的 *-qa-日期.csv）、私鑰
//      ——.gitignore 已經擋了，這裡是防 `git add -f` 或 .gitignore 被改。
//   ② 疑似金鑰：新增的行裡有 sk-ant-…、AKIA…、私鑰標頭等。
//   ③ 簡體字：新增的行（CLAUDE.md 第 1 條）。刻意保留的在同一行加 zhtw-ok。
//   ④ 測試：這次動到 api／lib／public／test／tools／設定，就先跑 `node test/run-all.mjs`（約 1.5 分鐘），沒全過不給提交。
//      CI 還是會再跑一次（含 SHIFT_DAYS=90），這裡是不要等到 PR 才紅。
//
// exit 2＝擋下這次 commit，stderr 會交給 Claude；exit 0＝放行。
// 臨時跳過測試（只有測試，①②③照擋）：指令前面加 SKIP_COMMIT_TESTS=1，例如 `SKIP_COMMIT_TESTS=1 git commit -m …`。
// 說明在 docs/dev-harness.md。
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SENSITIVE_PATHS, ZHTW_OK, collectChanges, git, inZhtwScope, isGitCommit, readStdinJson,
  scanSecrets, scanSimplified, stagesFiles, touchesCode
} from './lib.mjs';

const TEST_TIMEOUT_MS = 280_000;

async function main() {
  const input = readStdinJson();
  const cmd = String(input.tool_input?.command || '');
  if (!isGitCommit(cmd)) return 0;

  const cwd = path.resolve(input.cwd || process.cwd());
  const { names, added } = collectChanges(cwd, stagesFiles(cmd), cmd);
  if (!names.length && !added.size) return 0;

  const problems = [];

  for (const f of names) {
    const hit = SENSITIVE_PATHS.find(([re]) => re.test(f));
    if (hit) problems.push(`不該進 repo 的檔案：${f}（${hit[1]}）`);
  }

  for (const [f, rows] of added) {
    const secrets = scanSecrets(rows.map((r) => r.text).join('\n'));
    for (const label of secrets) problems.push(`疑似金鑰：${f}（${label}）。金鑰只放環境變數，不進 repo。`);

    if (inZhtwScope(f)) {
      const hits = [];
      for (const r of rows) {
        if (r.text.includes(ZHTW_OK)) continue;
        for (const h of await scanSimplified(r.text, r.line)) hits.push(h);
      }
      if (hits.length) {
        const list = hits.slice(0, 4).map((h) => `    ${f}:${h.line}「${h.chars}」 ${h.text}`).join('\n');
        problems.push(`簡體字（CLAUDE.md 第 1 條）：\n${list}${hits.length > 4 ? `\n    …還有 ${hits.length - 4} 處` : ''}\n    刻意要保留的，在同一行加 ${ZHTW_OK}。`);
      }
    }
  }

  // 測試放最後：前面任何一項已經違規就不用再花 1.5 分鐘
  if (!problems.length && touchesCode(names) && process.env.HOOK_SKIP_TESTS !== '1' && !/\bSKIP_COMMIT_TESTS=1\b/.test(cmd)) {
    const top = git(cwd, ['rev-parse', '--show-toplevel']).trim() || cwd;
    const r = spawnSync(process.execPath, ['test/run-all.mjs'], { cwd: top, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) {
      const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-30).join('\n');
      problems.push(`npm test 沒有全過${r.error ? `（${r.error.message}）` : ''}：\n${tail}`);
    }
  }

  if (!problems.length) return 0;
  console.error(`🛑 提交前檢查沒過（.claude/hooks/before-commit.mjs）\n\n${problems.map((p) => `・${p}`).join('\n\n')}\n\n先處理再重新提交。`);
  return 2;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`[before-commit hook] 自己出錯，放行：${err?.message || err}`);
  process.exit(0);
});
