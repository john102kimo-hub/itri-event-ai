// 批次紀錄的「記帳」小工具（批次 186）。內容（為什麼這樣改）要人寫，編號、檔案、索引、行數這些容易手誤的交給它。
//
//   node .claude/skills/batch-log/next-batch.mjs                    看下一個批次編號、該寫進哪個檔案、要不要開新檔
//   node .claude/skills/batch-log/next-batch.mjs --index "標題（日期）"   在 docs/batches/README.md 索引補一列（編號自動算＝你剛寫的那一章）
//   node .claude/skills/batch-log/next-batch.mjs --json              給程式讀
//
// 規則來自 CLAUDE.md 第 5 條與 docs/batches/README.md「新的一批怎麼記」；test/test-docs.mjs 會擋格式與漏列。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = path.join(ROOT, 'docs', 'batches');
const SOFT_LIMIT = 900; // 超過就開下一份（test-docs 的硬上限是 1,300）

export function batchState() {
  const files = fs.readdirSync(DIR).filter((f) => /^\d\d-batch-\d{3}\.md$/.test(f)).sort();
  const latest = files[files.length - 1];
  const latestText = fs.readFileSync(path.join(DIR, latest), 'utf8');
  let max = 0;
  for (const f of files) {
    let fence = false;
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (line.startsWith('```')) fence = !fence;
      if (fence) continue;
      const m = /^#{2,3} 批次 (\d+)：/.exec(line); // 4.5 這種小數編號不算（只取整數章節）
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  const lines = latestText.split('\n').length;
  const next = max + 1;
  const needNewFile = lines > SOFT_LIMIT;
  const newFile = `${String(files.length + 1).padStart(2, '0')}-batch-${String(next).padStart(3, '0')}.md`;
  return { lastBatch: max, nextBatch: next, latestFile: latest, latestFileLines: lines, needNewFile, newFile, writeTo: needNewFile ? newFile : latest };
}

function appendIndex(title) {
  const s = batchState();
  // 你剛寫的那一章：要已經在檔案裡了，編號才是 lastBatch（不是 nextBatch）
  const file = s.latestFile;
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const heading = `## 批次 ${s.lastBatch}：${title}`;
  if (!text.split('\n').includes(heading)) {
    console.error(`找不到章節標題「${heading}」在 ${file}。先把 \`${heading}\` 寫進去，再補索引（標題要跟索引逐字相同）。`);
    process.exit(1);
  }
  const readme = path.join(DIR, 'README.md');
  const idx = fs.readFileSync(readme, 'utf8');
  const row = `| ${s.lastBatch} | ${title} | [${file}](${file}) |`;
  if (idx.includes(row)) { console.log('索引已經有這一列了'); return; }
  fs.writeFileSync(readme, idx.replace(/\n*$/, '\n') + row + '\n');
  console.log(`已補索引：${row}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--index') {
    if (!args[1]) { console.error('用法：--index "標題（日期）"'); process.exit(2); }
    appendIndex(args[1]);
  } else {
    const s = batchState();
    if (args.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`最後一個批次：${s.lastBatch}　→　下一個：批次 ${s.nextBatch}`);
      console.log(`最新的批次檔：docs/batches/${s.latestFile}（${s.latestFileLines} 行）`);
      if (s.needNewFile) console.log(`⚠️ 超過 ${SOFT_LIMIT} 行，這一批要開新檔：docs/batches/${s.newFile}\n   開新檔要做三件事：①檔頭照前一份寫（# 施工批次紀錄：批次 N 起…，連回 LINE-PLAN.md 與 README.md、「自己 grep」那句）②LINE-PLAN.md 第 5 節的表補一行，並把上一列「（最新）」改成範圍 ③索引照常補`);
      else console.log(`→ 這一批接在 docs/batches/${s.latestFile} 後面`);
    }
  }
}
