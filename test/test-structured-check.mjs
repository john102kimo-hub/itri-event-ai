// lib/structured-check.js 純函式測試——四條規則各自獨立驗證，再驗證 true／false／null
// 三種門檻的邊界（3 過＝true，1 過＝false，2 過＝null，都空＝null）。
import { checkStructuredContent } from '../lib/structured-check.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + detail : ''}`); }
}

console.log('── 四項全過：structured=true ──');
{
  const r = checkStructuredContent({
    title: '工研院發表新一代固態電池技術',
    text: '2026年9月11日，工研院宣布最新固態電池能量密度提升 30%，詳見 https://www.itri.org.tw/news/123 。',
  });
  check('4 項都過', r.passed === 4, JSON.stringify(r));
  check('structured=true', r.structured === true);
}

console.log('── 只過 3 項（缺連結）：structured 仍為 true（門檻是「3 項以上」）──');
{
  const r = checkStructuredContent({
    title: '工研院發表新一代固態電池技術',
    text: '2026年9月11日，工研院宣布最新固態電池能量密度提升 30%。',
  });
  check('過 3 項', r.passed === 3, JSON.stringify(r));
  check('structured=true', r.structured === true);
}

console.log('── 只過 2 項：structured=null（不確定，不硬猜）──');
{
  const r = checkStructuredContent({
    title: '工研院發表新一代固態電池技術',
    text: '這項技術預期將改變產業，詳見 https://www.itri.org.tw/news/123 。', // 有標題、有連結，沒數字沒日期
  });
  check('過 2 項', r.passed === 2, JSON.stringify(r));
  check('structured=null', r.structured === null);
}

console.log('── 只過 1 項或 0 項：structured=false ──');
{
  const r = checkStructuredContent({ title: '工研院發表新技術', text: '這項技術很重要。' });
  check('只過標題這 1 項', r.passed === 1, JSON.stringify(r));
  check('structured=false', r.structured === false);
}
{
  const r = checkStructuredContent({ title: '短', text: '無內容' });
  check('0 項都過（標題太短）', r.passed === 0, JSON.stringify(r));
  check('structured=false', r.structured === false);
}

console.log('── 標題與內文都空：structured=null，不是 false ──');
{
  const r = checkStructuredContent({ title: '', text: '' });
  check('checks 是空陣列', r.checks.length === 0);
  check('structured=null（不能把「沒填」當「不結構化」算）', r.structured === null);
}
{
  const r = checkStructuredContent({});
  check('完全沒給 input 也不噴例外，structured=null', r.structured === null);
}
{
  const r = checkStructuredContent(undefined);
  check('undefined 也不噴例外', r.structured === null);
}

console.log('── 數字規則：抓得到常見單位，不誤判成任意數字 ──');
{
  const withTitle = (text) => checkStructuredContent({ title: '工研院發布新技術成果', text });
  check('百分比算數字', withTitle('提升 30%').checks.find((c) => c.key === 'number').pass);
  check('億元算數字', withTitle('投資 5 億元').checks.find((c) => c.key === 'number').pass);
  check('奈米算數字', withTitle('製程進入 3 奈米').checks.find((c) => c.key === 'number').pass);
  check('公噸算數字', withTitle('減碳 10 萬公噸').checks.find((c) => c.key === 'number').pass);
  check('純日期不算數字（避免日期跟數字兩條規則互相污染）',
    !withTitle('本次發布時間為2026年9月11日').checks.find((c) => c.key === 'number').pass);
}

console.log('── 日期規則：西元／民國、含日不含日都收 ──');
{
  const withTitle = (text) => checkStructuredContent({ title: '工研院發布新技術成果', text });
  check('西元年月日', withTitle('2026年9月11日發布').checks.find((c) => c.key === 'date').pass);
  check('西元年月（不含日）', withTitle('2026年9月發布').checks.find((c) => c.key === 'date').pass);
  check('斜線格式', withTitle('於 2026/09/11 發布').checks.find((c) => c.key === 'date').pass);
  check('民國年', withTitle('114年9月11日發布').checks.find((c) => c.key === 'date').pass);
  check('完全沒日期', !withTitle('本技術非常重要').checks.find((c) => c.key === 'date').pass);
}

console.log('── 連結規則 ──');
{
  const withTitle = (text) => checkStructuredContent({ title: '工研院發布新技術成果', text });
  check('http 連結算過', withTitle('詳見 http://itri.org.tw/x').checks.find((c) => c.key === 'link').pass);
  check('https 連結算過', withTitle('詳見 https://itri.org.tw/x').checks.find((c) => c.key === 'link').pass);
  check('沒有連結不算過', !withTitle('沒有任何網址').checks.find((c) => c.key === 'link').pass);
}

// ── ⚠️ 前端不准回頭去改那個勾選框 ──────────────────────────────────────────
// lib/structured-check.js 開頭、api/geo.js 的 check-structured、GEO_SETUP.md 三個地方
// 都寫著「不會、也不該覆寫同仁的勾選」，第一版的 public/geo.html 卻真的去改它——而且
// structured=false 時會把同仁已經勾好的取消掉。
//
// 為什麼這件事比看起來嚴重：同仁貼進來的常常只是摘要（沒附網址、用「三十億」這種中文
// 大寫數字），規則看不到就判 false，勾勾被靜靜取消，按下追蹤就存成 structured:false。
// 那個值正是事件效應表拿來回答「結構化稿是不是真的比較留得住記憶」的依據——也就是
// 這支檔案自己警告的「不要用規則硬猜一個可能錯的答案汙染那個比較」。
//
// 這條是靜態檢查：把 runStructCheck() 的函式本體抓出來，斷言它沒有碰 s-structured。
import { readFileSync } from 'node:fs';
{
  const html = readFileSync(new URL('../public/geo.html', import.meta.url), 'utf8');
  const start = html.indexOf('async function runStructCheck(');
  check('public/geo.html 裡找得到 runStructCheck()', start !== -1);
  if (start !== -1) {
    const end = html.indexOf('\n}', start);
    const body = html.slice(start, end);
    check('★ 檢查結果不准回頭去寫「結構化稿」那個勾選框（同仁的判斷不可以被規則靜靜覆寫）',
      !/getElementById\(['"]s-structured['"]\)\s*\.checked\s*=/.test(body),
      body.split('\n').filter((l) => l.includes('s-structured')).join('\n'));
    check('　 初判文字仍然在（要告訴人結論，只是不幫他勾）',
      /初判/.test(body), body.slice(-200));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 結構化稿自動初檢測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
