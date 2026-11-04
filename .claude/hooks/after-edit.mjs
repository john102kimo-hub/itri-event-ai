// PostToolUse（Edit／Write／MultiEdit）：改完一個檔案，立刻做兩件便宜的檢查。
//   ① .js／.mjs 語法檢查（node --check）——改壞語法的話，Claude 馬上看到，不是跑了 85 秒測試才發現。
//   ② 這次「新寫進去的字」有沒有簡體字（CLAUDE.md 第 1 條：只用台灣繁體中文，朱朱：「千萬不能出現簡體字好嗎」）。
//
// exit 2＝把 stderr 交給 Claude 去修（檔案已經寫了，這裡不能擋，只能要它改）；exit 0＝沒事。
// 設定在 .claude/settings.json；說明在 docs/dev-harness.md。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ZHTW_OK, inZhtwScope, readStdinJson, scanSimplified } from './lib.mjs';

async function main() {
  const input = readStdinJson();
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (!file) return 0;

  const root = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return 0; // 不在這個專案裡

  const problems = [];

  if (/\.(m?js)$/.test(rel) && fs.existsSync(abs)) {
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(`語法錯誤（node --check）：\n${(r.stderr || '').trim().split('\n').slice(0, 8).join('\n')}`);
  }

  if (inZhtwScope(rel)) {
    // 只看這次新寫的：Write 是整份 content，Edit 是 new_string，MultiEdit 是每一段 new_string
    const written = ti.content ?? ti.new_string ?? (Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string).join('\n') : '');
    const hits = await scanSimplified(written);
    if (hits.length) {
      const list = hits.slice(0, 5).map((h) => `  ・「${h.chars}」 ${h.text}`).join('\n');
      problems.push(`這次寫進 ${rel} 的文字有簡體字（CLAUDE.md 第 1 條只用台灣繁體中文）：\n${list}\n請改成台灣繁體。如果是刻意要保留的（偵測用的樣式、舉例），在同一行加上 ${ZHTW_OK} 標記。`);
    }
  }

  if (!problems.length) return 0;
  console.error(`⚠️ 剛才改的 ${rel} 有問題：\n\n${problems.join('\n\n')}`);
  return 2;
}

main().then((code) => process.exit(code), (err) => {
  // hook 自己壞了不擋工作
  console.error(`[after-edit hook] 自己出錯，略過：${err?.message || err}`);
  process.exit(0);
});
