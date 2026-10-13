// 答案出口檢查的離線回測（批次 132）。
//   node tools/grounding-backtest/backtest.mjs <輸入.json> [--answers-csv 後台匯出的問答.csv] [--top 20] [--max-detail 50]
//                                              [--with-prompt] [--json]
// 做什麼：拿真實的問答，用跟線上完全相同的規則（lib/answer-grounding.js）跑一遍「答案裡的數字、網址、英文名詞，
// 有沒有出現在模型當時看到的文字裡」，算出被標出的比例，再把每一則被標出的答案列出來讓人工判斷哪些是誤報。
// 用途：影子模式（ANSWER_GROUNDING 未設）上線前後，用誤報率決定要不要改成 on。
//
// ⚠️ 只讀檔，不呼叫任何 API、不連 Sheets、不寫任何檔案；`npm test` 不會跑它。
// ⚠️ 這裡組的 shownText 是「知識庫＋照片清單＋活動基本資料＋該題問題」（加 --with-prompt 再加整份 system prompt）。
//    線上實際組法見 README；差別只在 system prompt 的規則文字與對話歷史，會讓線上的標出數略少於這裡（更寬鬆）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUngrounded } from '../../lib/answer-grounding.js';
import { formatEventBasics, formatImages, systemPromptFor } from '../../lib/prompt.js';

const KINDS = [['numbers', '數字'], ['urls', '網址'], ['terms', '英文名詞']];
const USAGE = `用法：node tools/grounding-backtest/backtest.mjs <輸入.json> [選項]

輸入.json 的格式：
  { "events":  [{ "id", "name", "knowledge_base", "event_date", "event_time", "venue", "press_contact", "images" }],
    "answers": [{ "event_id", "question", "answer" }] }
  events 可選填 "images"（後台「圖片」欄的原文，每行「網址」或「網址|圖說」；線上模型看得到照片清單，回測才不會把照片網址當成編造）。
  answers 可選填 "asked_at"（問的時間，ISO 格式，讓「現在時間」那一行跟當時一樣）與
  "expect"（"ok"＝這則答案沒問題、"flag"＝這則答案有問題，人工標註用，最後會算誤報／漏報）。

選項：
  --answers-csv <檔>  從後台「匯出 CSV」讀問答（欄位：活動ID、記者問題、AI回答），輸入.json 只要有 events
  --top N             最常被標出的項目列前 N 名（預設 20）
  --max-detail N      最多列出 N 則被標出的答案（預設全部）
  --with-prompt       shownText 再加上整份 system prompt（更接近線上，標出數會略少）
  --json              輸出 JSON，不輸出文字報告`;

// ───────────────────────── CSV（後台匯出的格式：雙引號包住、"" 跳脫、CRLF、儲存格內可換行）─────────────────────────
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQuote = false; }
      else cell += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/**
 * 後台「時間」欄（試算表的建立時間戳記，台灣時間）→ ISO 字串，給 asked_at 用：「2026/6/18 下午11:06:04」、
 * 「2026-06-18 23:06」、「2026/6/18」。認不得就回空字串（回測改用執行當下的時間）。
 */
export function parseTaipeiTime(label) {
  const m = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(label ?? ''));
  if (!m) return '';
  let h = m[5] === undefined ? 0 : Number(m[5]);
  if (m[4] === '下午' && h < 12) h += 12;
  if (m[4] === '上午' && h === 12) h = 0;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(h)}:${m[6] ?? '00'}:${m[7] ?? '00'}+08:00`;
}

/** 後台匯出的問答 CSV → answers 陣列。api/export.js 的欄位：時間、活動ID、活動名稱、媒體名稱、姓名、記者問題、AI回答。 */
export function answersFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const [iId, iQ, iA, iT] = [col('活動ID'), col('記者問題'), col('AI回答'), col('時間')];
  if (iId < 0 || iQ < 0 || iA < 0) throw new Error('CSV 找不到「活動ID／記者問題／AI回答」欄位，請確認是後台匯出的問答紀錄');
  // 匯出時遇到 = + - @ 開頭的儲存格會在前面加一個單引號（防 Excel 公式注入），讀回來要拿掉
  const unquote = (s) => String(s ?? '').replace(/^'(?=[=+\-@\t\r])/, '');
  return rows.slice(1).map((r) => {
    const asked = iT >= 0 ? parseTaipeiTime(r[iT]) : ''; // 問的時間：活動基本資料裡「現在時間」那一行要跟當時一樣
    return { event_id: unquote(r[iId]), question: unquote(r[iQ]), answer: unquote(r[iA]), ...(asked ? { asked_at: asked } : {}) };
  });
}

// ───────────────────────── 回測 ─────────────────────────
const head80 = (s) => [...String(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, 80).join('');
const asDate = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : new Date(); };

/** 跑一遍回測，回傳統計與逐則明細（沒有任何輸出、沒有 log）。 */
export function runBacktest({ events = [], answers = [], withPrompt = false } = {}) {
  const byId = new Map((Array.isArray(events) ? events : []).map((e) => [String(e?.id ?? ''), e]));
  const out = {
    inputAnswers: 0, checked: 0, flagged: 0,
    skipped: { noEvent: 0, blankAnswer: 0, noSource: 0 }, missingEvents: [],
    kinds: Object.fromEntries(KINDS.map(([k]) => [k, { answers: 0, items: 0 }])),
    top: [], details: [],
    flaggedUrlsTerms: 0,
    labeled: {
      total: 0, okTotal: 0, flagTotal: 0, falseAlarm: 0, miss: 0, falseAlarmIndexes: [], missIndexes: [],
      falseAlarmByKind: Object.fromEntries(KINDS.map(([k]) => [k, 0])), falseAlarmUrlsTerms: 0, falseAlarmRate: null, missRate: null
    }
  };
  const tally = new Map();
  (Array.isArray(answers) ? answers : []).forEach((a, i) => {
    out.inputAnswers++;
    const event = byId.get(String(a?.event_id ?? ''));
    if (!event) {
      out.skipped.noEvent++;
      const id = String(a?.event_id ?? '');
      if (!out.missingEvents.includes(id)) out.missingEvents.push(id);
      return;
    }
    if (!String(a?.answer ?? '').trim()) { out.skipped.blankAnswer++; return; }
    const parts = [
      withPrompt ? systemPromptFor({ organizer: '工研院', ...event }) : '',
      event.knowledge_base,
      // 批次 132 品質審查：線上模型看得到【本次活動照片】清單（網址＋圖說，systemPromptFor() 會接在知識庫後面）。
      // --with-prompt 時上面那份 system prompt 已經含了；沒帶時要自己補，不然答案裡列出的照片網址與圖說會整批被標出。
      withPrompt ? '' : formatImages(event.images),
      formatEventBasics(event, asDate(a.asked_at)),
      a.question
    ];
    const r = findUngrounded(a.answer, parts);
    if (r.sourceEmpty) { out.skipped.noSource++; return; }
    out.checked++;
    const hit = KINDS.some(([k]) => r[k].length);
    for (const [k] of KINDS) {
      if (!r[k].length) continue;
      out.kinds[k].answers++;
      out.kinds[k].items += r[k].length;
      for (const item of r[k]) {
        const key = `${k}\t${item}`;
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
    const hitUrlsTerms = r.urls.length > 0 || r.terms.length > 0;
    if (hitUrlsTerms) out.flaggedUrlsTerms++;
    if (hit) {
      out.flagged++;
      out.details.push({
        index: i + 1, event_id: String(event.id), question: String(a.question ?? ''), answerHead: head80(a.answer),
        numbers: r.numbers, urls: r.urls, terms: r.terms, expect: a.expect || ''
      });
    }
    if (a.expect === 'ok' || a.expect === 'flag') {
      out.labeled.total++;
      if (a.expect === 'ok') {
        out.labeled.okTotal++;
        if (hit) {
          out.labeled.falseAlarm++; out.labeled.falseAlarmIndexes.push(i + 1);
          for (const [k] of KINDS) if (r[k].length) out.labeled.falseAlarmByKind[k]++;
          if (hitUrlsTerms) out.labeled.falseAlarmUrlsTerms++;
        }
      } else {
        out.labeled.flagTotal++;
        if (!hit) { out.labeled.miss++; out.labeled.missIndexes.push(i + 1); }
      }
    }
  });
  // 批次 132 品質審查：誤報率的分母是「標 ok 的答案」，不是「被標出的答案」。後者取決於編造答案占多少，真實流量裡編造一定很少，
  // 「被標出的答案多半是真的」這個判準在真實資料上不成立（見 README 第四節）。
  const lb = out.labeled;
  lb.falseAlarmRate = lb.okTotal ? lb.falseAlarm / lb.okTotal : null;
  lb.missRate = lb.flagTotal ? lb.miss / lb.flagTotal : null;
  out.top = [...tally.entries()]
    .map(([key, count]) => { const [kind, item] = key.split('\t'); return { kind, item, count }; })
    .sort((x, y) => y.count - x.count || x.item.localeCompare(y.item));
  return out;
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';
const per100 = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

export function renderReport(r, { top = 20, maxDetail = Infinity } = {}) {
  const label = Object.fromEntries(KINDS);
  const L = [];
  L.push('答案出口檢查回測（ANSWER_GROUNDING 影子模式的規則）', '');
  L.push(`輸入答案：${r.inputAnswers} 則；實際檢查：${r.checked} 則`);
  const sk = r.skipped;
  if (sk.noEvent || sk.blankAnswer || sk.noSource) {
    L.push(`略過：找不到活動 ${sk.noEvent} 則${r.missingEvents.length ? `（活動 ID：${r.missingEvents.slice(0, 10).join('、')}）` : ''}、答案是空的 ${sk.blankAnswer} 則、活動沒有知識庫 ${sk.noSource} 則`);
  }
  L.push('', `總則數：${r.checked}`, `被標出：${r.flagged} 則（${pct(r.flagged, r.checked)}）；打開 on 之後，每 100 則答案會多 ${per100(r.flagged, r.checked)} 則提醒`,
    `　其中只看網址＋英文名詞（on:urls,terms 會提醒的）：${r.flaggedUrlsTerms} 則（${pct(r.flaggedUrlsTerms, r.checked)}），每 100 則 ${per100(r.flaggedUrlsTerms, r.checked)} 則`,
    '', '各類別（被標出的則數／項目筆數）：');
  for (const [k, name] of KINDS) L.push(`  ${name}：${r.kinds[k].answers} 則／${r.kinds[k].items} 筆`);

  L.push('', `最常被標出的項目 Top ${top}：`);
  if (!r.top.length) L.push('  （沒有）');
  r.top.slice(0, top).forEach((t, i) => L.push(`  ${String(i + 1).padStart(2)}. [${label[t.kind]}] ${t.item}　×${t.count}`));

  if (r.labeled.total) {
    const lb = r.labeled;
    L.push('', `人工標註對照（共 ${lb.total} 則有 expect：標 ok ${lb.okTotal} 則、標 flag ${lb.flagTotal} 則）：`,
      `  誤報（標註沒問題、卻被標出）：${lb.falseAlarm} 則${lb.falseAlarmIndexes.length ? `（第 ${lb.falseAlarmIndexes.join('、')} 則）` : ''}`,
      `  漏報（標註有問題、卻沒被標出）：${lb.miss} 則${lb.missIndexes.length ? `（第 ${lb.missIndexes.join('、')} 則）` : ''}`);
    if (lb.okTotal) {
      L.push(`  ★ 誤報率（標 ok 的答案被標出的比例）：${lb.falseAlarm}／${lb.okTotal}＝${pct(lb.falseAlarm, lb.okTotal)}`
        + `（數字 ${lb.falseAlarmByKind.numbers}、網址 ${lb.falseAlarmByKind.urls}、英文名詞 ${lb.falseAlarmByKind.terms}；只看網址＋英文名詞 ${lb.falseAlarmUrlsTerms}／${lb.okTotal}＝${pct(lb.falseAlarmUrlsTerms, lb.okTotal)}）`);
    }
    if (lb.flagTotal) L.push(`  漏報率（標 flag 的答案沒被標出的比例）：${lb.miss}／${lb.flagTotal}＝${pct(lb.miss, lb.flagTotal)}`);
  }

  L.push('', `被標出的答案（供人工判斷是不是誤報${r.details.length > maxDetail ? `，只列前 ${maxDetail} 則` : ''}）：`);
  if (!r.details.length) L.push('  （沒有）');
  for (const d of r.details.slice(0, maxDetail)) {
    L.push('', `  第 ${d.index} 則　活動 ${d.event_id}${d.expect ? `　標註：${d.expect}` : ''}`, `    問題：${head80(d.question)}`);
    for (const [k, name] of KINDS) if (d[k].length) L.push(`    ${name}：${d[k].join('、')}`);
    L.push(`    答案前 80 字：${d.answerHead}`);
  }
  return L.join('\n');
}

// ───────────────────────── 命令列 ─────────────────────────
function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) { console.log(USAGE); return args.length ? 0 : 1; }
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const num = (name, dflt) => { const v = opt(name); const n = Number(v); return v !== undefined && Number.isFinite(n) && n >= 0 ? n : dflt; };
  const valueFlags = new Set(['--answers-csv', '--top', '--max-detail']);
  const file = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  if (!file) { console.error('少了輸入檔。\n\n' + USAGE); return 1; }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`讀不了輸入檔 ${file}：${e.message}`);
    return 1;
  }
  if (!input || !Array.isArray(input.events)) { console.error('輸入檔缺少 events 陣列（格式見 --help）'); return 1; }
  let answers = Array.isArray(input.answers) ? input.answers : [];
  const csvFile = opt('--answers-csv');
  if (csvFile) {
    try { answers = answers.concat(answersFromCsv(fs.readFileSync(csvFile, 'utf8'))); }
    catch (e) { console.error(`讀不了問答 CSV ${csvFile}：${e.message}`); return 1; }
  }
  if (!answers.length) { console.error('沒有任何答案可以檢查：輸入檔的 answers 是空的，也沒有給 --answers-csv'); return 1; }

  const result = runBacktest({ events: input.events, answers, withPrompt: args.includes('--with-prompt') });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReport(result, { top: Math.floor(num('--top', 20)), maxDetail: num('--max-detail', Infinity) }));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
