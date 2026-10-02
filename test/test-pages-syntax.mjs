// 語法檢查（批次 110）：public/*.html 的每一段內嵌 <script>，與 api/、lib/ 的每一支 .js。
//
// 為什麼要有：既有測試都是「把某個函式抽出來在假 DOM 上跑」，抽不到的地方語法壞了沒人知道，
// 一直到使用者的瀏覽器開起來整頁是白的。頁面是 3000 行的單檔，改一處就可能弄壞別處（批次 104 的坑）。
// 這支只做一件最便宜的事：每一段 script 都要能被解析。不執行、不需要瀏覽器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + d : ''))); };

console.log('── 頁面的內嵌 script ──');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-syntax-'));
let total = 0;
for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((x) => x.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  const bad = [];
  let n = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1], code = m[2];
    if (/\bsrc\s*=/.test(attrs) || !code.trim()) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;   // 例如 application/ld+json
    n++; total++;
    if (type === 'module') {
      const file = path.join(tmp, `${f}-${n}.mjs`);
      fs.writeFileSync(file, code);
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`第 ${n} 段（module）：${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || r.stderr}`);
    } else {
      try { new vm.Script(code, { filename: f }); } catch (e) { bad.push(`第 ${n} 段：${e.message}`); }
    }
  }
  check(`${f}：${n} 段內嵌 script 語法正確`, bad.length === 0, bad.join('\n   '));
}
check('至少掃到 12 段 script（防止正規表達式壞掉、什麼都沒掃卻顯示全綠）', total >= 12, `只掃到 ${total} 段`);

console.log('\n── api/、lib/ 的每一支 ──');
const files = ['api', 'lib'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.js')).map((x) => `${d}/${x}`));
const broken = files.filter((f) => spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' }).status !== 0);
check(`${files.length} 支 .js 全部能被解析`, broken.length === 0, broken.join(', '));

// 反向驗證用的樣本：這支測試自己要抓得到壞掉的 script
{
  let caught = false;
  try { new vm.Script('function ( {', { filename: 'x' }); } catch { caught = true; }
  check('（自我檢查）壞掉的 script 確實會被抓到', caught);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} 頁面與模組語法測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
