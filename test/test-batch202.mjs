// 批次 202：答案裡「只差大小寫」的網址，出口直接改回來源的寫法（lib/answer-grounding.js repairUrlCase()）。
//
// 來由是 qa_log 裡的一則真實回答（2026-11-05，LINE）：知識庫的 Google 文件連結 ID 裡有一個小寫 r，
// 米亞回給記者的那一則寫成了大寫 R。Google 文件 ID 分大小寫，那條連結點開是「找不到檔案」；
// 批次 132 的出口檢查不分大小寫，所以沒有標出來。下面的網址是照那則的形狀寫的虛構 ID。
//
// 跟 test-batch132 同一個結構：① 抄錯的要修好 ② 沒錯的一個字都不能動。
import fs from 'node:fs';
import path from 'node:path';
import { repairUrlCase, findUngrounded } from '../lib/answer-grounding.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const J = (v) => JSON.stringify(v);

const GOOD = 'https://docs.google.com/document/d/1abcDefgrHOB6y5xyzExampleId-w/edit';
const BAD = 'https://docs.google.com/document/d/1abcDefgRHOB6y5xyzExampleId-w/edit';
const KB = `【各場次新聞參考資料】\n11/5 早上：先進電子材料\n${GOOD}\n活動網站：https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1`;

{
  console.log('  ▸ 抄錯大小寫的網址改回來源的寫法');
  const r = repairUrlCase(`新聞參考資料：${BAD}\n\n這場沒有提供新聞參考資料。`, [KB, '11/5的研討會新聞資料']);
  check('★ ID 裡一個字母大小寫不同：換回知識庫的寫法，其餘文字一個字不動',
    r.text === `新聞參考資料：${GOOD}\n\n這場沒有提供新聞參考資料。` && r.fixed.length === 1 && r.fixed[0].from === BAD && r.fixed[0].to === GOOD, J(r));
  check('　 這種錯批次 132 的檢查抓不到（它不分大小寫）——所以才需要這一道', findUngrounded(`資料：${BAD}`, KB).urls.length === 0);
  const twice = repairUrlCase(`上午 ${BAD} ，下午也是 ${BAD}。`, KB);
  check('　 同一則出現兩次：兩處都改，結尾的標點留著', twice.text === `上午 ${GOOD} ，下午也是 ${GOOD}。` && twice.fixed.length === 2, J(twice));
  const paren = repairUrlCase(`（${BAD}）`, KB);
  check('　 包在全形括號裡、後面緊接標點：只換網址本身', paren.text === `（${GOOD}）`, paren.text);
  const slash = repairUrlCase(`${BAD}/`, KB);
  check('　 答案多打的結尾斜線照留', slash.text === `${GOOD}/`, slash.text);
  const host = repairUrlCase('官網 HTTPS://WWW.ITRI.ORG.TW/ListStyle.aspx?DisplayStyle=18&SiteID=1', KB);
  check('　 只有協定與網域大小寫不同：也換回來源寫法（無害）', host.text === '官網 https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1', host.text);
}

{
  console.log('  ▸ 沒錯的不能動');
  const same = `資料在 ${GOOD} ，請參考。`;
  const r = repairUrlCase(same, KB);
  check('★ 一模一樣的網址：原樣回傳、fixed 是空的', r.text === same && r.fixed.length === 0);
  check('　 來源多一條結尾斜線、答案沒有（或反過來）：不算不同', repairUrlCase(`${GOOD}`, `${GOOD}/`).fixed.length === 0 && repairUrlCase(`${GOOD}/`, GOOD).fixed.length === 0);
  const madeUp = '請看 https://docs.google.com/document/d/totallyMadeUp/edit';
  check('　 來源根本沒有的網址：不是這支的事，原樣放行（留給批次 132 的檢查去標）', repairUrlCase(madeUp, KB).text === madeUp && findUngrounded(madeUp, KB).urls.length === 1);
  const twoVariants = `${GOOD}\n${BAD}`;
  check('★ 來源自己就有只差大小寫的兩種寫法：不猜，原樣放行',
    repairUrlCase('看 https://docs.google.com/document/d/1ABCDEFGRHOB6Y5XYZEXAMPLEID-W/edit', twoVariants).fixed.length === 0);
  check('　 來源兩種寫法、答案用的是其中一種：不動', repairUrlCase(`看 ${BAD}`, twoVariants).fixed.length === 0);
  check('　 沒有網址的答案、空字串、null、來源是空的：不丟例外',
    repairUrlCase('沒有連結的回答', KB).text === '沒有連結的回答' && repairUrlCase('', KB).text === '' && repairUrlCase(null, KB).text === '' && repairUrlCase(`看 ${BAD}`, null).text === `看 ${BAD}`);
  check('　 email 不處理（信箱不分大小寫，不該被改寫）', repairUrlCase('請寄 Press@ITRI.org.tw', '聯絡：press@itri.org.tw').fixed.length === 0);
  check('　 沒有協定的網域補上 https:// 不算只差大小寫：不動', repairUrlCase('https://www.itri.org.tw/QC', 'www.itri.org.tw/qc').fixed.length === 0);
}

{
  console.log('  ▸ 接線：LINE 活動問答在出口檢查之前先修');
  const code = fs.readFileSync(path.join(ROOT, 'lib/line-reporter.js'), 'utf8');
  const iRepair = code.indexOf('repairUrlCase(aiReply, shownToModel)');
  const iCheck = code.indexOf('checkAnswerGrounding(aiReply, shownToModel');
  check('★ answerQuestion() 先 repairUrlCase() 再 checkAnswerGrounding()，兩邊看的是同一份「模型這次看到的字」', iRepair > 0 && iCheck > iRepair);
  check('　 修正有留 log（[grounding] 網址大小寫已修正），事後查得到發生過幾次', code.includes('[grounding] 網址大小寫已修正'));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 202（網址只差大小寫，出口改回來源寫法）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
