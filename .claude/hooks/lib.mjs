// Claude Code hooks 共用的小工具（批次 186）。
//
// 為什麼有 hooks：CLAUDE.md 第 2 條說「絕對不能發生的事，擋在程式出口、不要寫在 prompt 裡」。
// 這條原則原本只管**產品**（米亞送給記者的每一段字）；hooks 把同一條原則用在**開發過程**——
// 「簡體字不能進 repo」「真實問答資料不能被 commit」「改完要跑測試」，不再靠 Claude（或人）記得。
//
// 兩個鐵則：
//   ① 只檢查「這次新寫進去的字」，不掃整個檔案。現有 32 個檔案本來就含簡體字（測試資料、偵測用的樣式、
//      批次紀錄裡的舉例），整檔掃會一直誤報，誤報多了大家就學會忽略——那比沒有檢查還糟。
//   ② hook 自己壞掉（例外、讀不到檔）一律放行並在 stderr 留一行，不擋工作。只有「確定違規」才擋。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 同一行（或這一小段文字）有這個標記，就不檢查簡體字。給「刻意要寫簡體字」的地方：偵測樣式、舉例、測試輸入。 */
export const ZHTW_OK = 'zhtw-ok';

// 簡體字只檢查這些副檔名；test/、字表本身、hook 自己、評測用的假答案不檢查（它們本來就要放簡體字）。
const SCOPE_EXT = /\.(js|mjs|html|md|css|json|ya?ml)$/;
const ZHTW_EXEMPT = [
  /^lib\/zh-tw\.js$/,
  /^test\//,
  /^\.claude\/hooks\//,
  /^tools\/eval\/mock-/,
  /^tools\/(grounding-backtest|model-ab)\/sample/
];

export const inZhtwScope = (rel) => SCOPE_EXT.test(rel) && !ZHTW_EXEMPT.some((re) => re.test(rel));

// 不該進 repo 的檔名。理由都來自這個專案自己踩過或寫過的：tools/grounding-backtest/README.md 的「先看這裡」、.gitignore。
export const SENSITIVE_PATHS = [
  [/(^|\/)\.env($|\.(?!example$))/, '環境變數檔（內含金鑰）'],
  [/\.(local|real)\.(json|csv)$/, '真實資料檔（*.local.* / *.real.*）'],
  [/-qa-\d{4}-\d{2}-\d{2}\.csv$/, '後台匯出的問答 CSV（含記者姓名與提問原文）'],
  [/(^|\/)qa-export-\d{4}-\d{2}-\d{2}\.csv$/, '後台匯出的問答 CSV'],
  [/\.(pem|p12|pfx)$/, '憑證／私鑰檔'],
  [/(^|\/)(service-account|credentials?)[^/]*\.json$/i, '服務帳號／憑證 JSON']
];

// 常見金鑰的樣子。寧可少報：只收格式很特別、幾乎不會誤中的。
export const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API 金鑰'],
  [/AKIA[0-9A-Z]{16}/, 'AWS 存取金鑰'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API 金鑰'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私鑰'],
  [/vercel_blob_rw_[A-Za-z0-9_]+/, 'Vercel Blob token']
];

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let zhtwMod = null;
/** 延遲載入：每個 Bash 指令都會經過 before-commit，不是 git commit 的指令不該為了字表多花時間。 */
export async function residualSimplified(text) {
  zhtwMod ||= await import(new URL('../../lib/zh-tw.js', import.meta.url).href);
  return zhtwMod.findResidualSimplified(text);
}

/** 掃「新寫進去的字」。回傳 [{ line, chars, text }]；有 zhtw-ok 標記的行不查。 */
export async function scanSimplified(text, startLine = 1) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(ZHTW_OK)) continue;
    const chars = await residualSimplified(lines[i]);
    if (chars.length) out.push({ line: startLine + i, chars: chars.join(''), text: lines[i].trim().slice(0, 60) });
  }
  return out;
}

export function scanSecrets(text) {
  const hits = [];
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}

export function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/** `git diff -U0` 的輸出 → Map<檔名, [{ line, text }]>（只收新增的行） */
export function parseAddedLines(diffText) {
  const files = new Map();
  let file = null;
  let n = 0;
  for (const row of String(diffText).split('\n')) {
    if (row.startsWith('+++ ')) {
      const p = row.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !files.has(file)) files.set(file, []);
    } else if (row.startsWith('@@')) {
      const m = /\+(\d+)/.exec(row);
      n = m ? Number(m[1]) : 0;
    } else if (file && row.startsWith('+') && !row.startsWith('+++')) {
      files.get(file).push({ line: n, text: row.slice(1) });
      n++;
    }
  }
  return files;
}

/**
 * 這次 commit 會帶走的變更。includeWorktree＝指令裡有 `git add` 或 `commit -a`：hook 在指令執行**之前**跑，
 * 那時還沒 add，光看 staged 會漏掉（`git add -A && git commit` 是最常見的寫法），所以把工作區的改動與新檔也算進來。
 */
export function collectChanges(cwd, includeWorktree, cmd = '') {
  const added = parseAddedLines(git(cwd, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']));
  const names = new Set(git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean));
  if (includeWorktree) {
    for (const [f, rows] of parseAddedLines(git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']))) {
      added.set(f, [...(added.get(f) || []), ...rows]);
    }
    for (const f of git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) names.add(f);
    for (const f of git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      names.add(f);
      readAsAdded(cwd, f, added);
    }
    // 批次 187：`git add -f` 會把被 .gitignore 忽略的檔案也加進去（.env 就是這樣被帶走的）。被忽略的檔案不在上面的「未追蹤」清單裡，
    // 所以要另外查。指名了路徑就查那幾個（連內容一起看，才抓得到裡面的金鑰）；`-A`／`.` 這種「全部」只看檔名（node_modules 之類不讀內容）。
    if (forceAdds(cmd)) {
      const specs = addPathspecs(cmd).filter((p) => p !== '.' && p !== './');
      const named = specs.length > 0;
      // 同一個指令裡才建立檔案（`printf x > .env && git add -f .env && git commit`）：hook 檢查的當下檔案還不存在，
      // 讀不到內容，但指令寫出來的路徑本身就能比對檔名規則。
      for (const sp of specs) names.add(sp.replace(/^\.\//, ''));
      const ignored = git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...(named ? ['--', ...specs] : ['--directory'])]).split('\0').filter(Boolean);
      for (const f of ignored) {
        names.add(f);
        if (named && !f.endsWith('/')) readAsAdded(cwd, f, added);
      }
    }
  }
  return { names: [...names], added };
}

/** 把整個檔案當成「新增的行」讀進來（給未追蹤、被強制加入的檔案用）。太大或二進位就略過。 */
function readAsAdded(cwd, f, added) {
  try {
    const abs = path.join(cwd, f);
    if (fs.statSync(abs).size > 1_000_000) return;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return; // 二進位檔
    added.set(f, buf.toString('utf8').split('\n').map((text, i) => ({ line: i + 1, text })));
  } catch { /* 讀不到就略過 */ }
}

/** 指令裡有 `git add -f`／`--force`／`-fA`（連被 .gitignore 忽略的檔案也加進去） */
export const forceAdds = (cmd) => /\bgit\s+(?:-[Cc]\s+\S+\s+)*add\b[^|;&\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/.test(String(cmd));

/** 從 `git add …` 抓出路徑參數（不含選項與引號）。只認得用空白隔開的簡單寫法；`-A`、`.` 這類「全部」會得到空陣列或 '.'。 */
export function addPathspecs(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(/\bgit\s+(?:-[Cc]\s+\S+\s+)*add\b([^|;&\n]*)/g)) {
    for (const tok of m[1].split(/\s+/).filter(Boolean)) {
      if (tok.startsWith('-')) continue;
      out.push(tok.replace(/^['"]|['"]$/g, ''));
    }
  }
  return out;
}

export const isGitCommit = (cmd) => /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/.test(cmd) && !/--dry-run/.test(cmd);
export const stagesFiles = (cmd) => /\bgit\s+add\b/.test(cmd) || /\bcommit\b[^|;&\n]*\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(cmd);

/** 需要跑測試的變更：碰到程式、頁面、設定（只改文件不用等 85 秒） */
export const touchesCode = (names) => names.some((f) => /^(api|lib|public|test|tools)\//.test(f) || /^(vercel\.json|package\.json)$/.test(f));
