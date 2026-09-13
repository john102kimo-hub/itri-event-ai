// 版面出口防線（批次 59）。回報：「文字排版很亂 能夠精進嗎 整體上」，附兩張截圖——
// 產業趨勢那則把兩篇報告擠成一大段，活動問答那則有結構卻沒有符號也沒有空行。
//
// 修法分兩半：LAYOUT_RULE（prompt，講手機上該排成什麼樣）＋ tidyLineLayout()（程式，
// 就算模型沒照做也一定成立的那幾件事）。這支測的是後者。
//
// ⚠️ 這支測試最重要的不是「有沒有補上空行」，是**第二節**：這支只加空行、只刪行尾
// 空白，永遠不切開、不搬動、不刪除任何一個字。繁簡轉換那支（test-zhtw.mjs）學到的
// 教訓一模一樣——出口守門最大的災難不是漏做，是把本來對的東西改壞。
import { tidyLineLayout } from '../api/line.js';
import { extractSourceIndices } from '../lib/industry-trends.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}
function eq(input, expect, why) {
  const got = tidyLineLayout(input);
  check(`${why}`, got === expect, `實際：\n${JSON.stringify(got)}\n   期望：\n${JSON.stringify(expect)}`);
}

console.log('── 一、該補的空行有補上 ──');

// 截圖 ② 的形狀：開場一句，接著一組一組的講者，全部黏在一起。
eq('今天的講者陣容蠻多元的，我幫你列重點：\n・開場暨引言：張培仁（工研院院長）\n・國際論壇：Frank Bonafilia（愛迪生獎執行長）',
   '今天的講者陣容蠻多元的，我幫你列重點：\n\n・開場暨引言：張培仁（工研院院長）\n・國際論壇：Frank Bonafilia（愛迪生獎執行長）',
   '條列區塊開始前補一個空行（開場句不再黏在第一項上）');

eq('・9/6《人型機器人走向模組化》\n・8/6《CPO 加速 AI 光互連》\n這些都是 IEK 的免費摘要。',
   '・9/6《人型機器人走向模組化》\n・8/6《CPO 加速 AI 光互連》\n\n這些都是 IEK 的免費摘要。',
   '條列區塊結束後補一個空行（收尾句不再黏在最後一項上）');

eq('開場。\n・第一項\n・第二項\n收尾。',
   '開場。\n\n・第一項\n・第二項\n\n收尾。',
   '開場與收尾同時存在時兩邊都補');

console.log('── 二、不可以動到內容（比第一節重要）──');

// ⚠️ 這是刻意「不做」的那件事的守門：「・」是日文中黑點，中文譯名本來就用它當分隔。
// 哪天有人「順手」把同一行的多個「・」拆成多行，這幾條就會紅。
eq('與會的還有史蒂夫・賈伯斯與馬丁・路德・金恩兩位。',
   '與會的還有史蒂夫・賈伯斯與馬丁・路德・金恩兩位。',
   '句子中間當名字分隔用的「・」不可以被拆行（拆了就變成兩個人）');

eq('講者：史蒂夫・賈伯斯\n・場次一：上午\n・場次二：下午',
   '講者：史蒂夫・賈伯斯\n\n・場次一：上午\n・場次二：下午',
   '同一則裡名字的「・」與條列的「・」並存時，只有條列那邊受影響');

const rich = '第一段。\n\n・項目\n　說明文字。\n\n第二段。';
eq(rich, rich, '已經排好的內容完全不變（冪等）');

check('沒有任何字元被刪掉（只增加空白行）',
  tidyLineLayout('開場。\n・甲\n・乙\n收尾。').replace(/\n/g, '') === '開場。・甲・乙收尾。',
  JSON.stringify(tidyLineLayout('開場。\n・甲\n・乙\n收尾。')));

console.log('── 三、縮排續行要認得出來 ──');

// LAYOUT_RULE ③：標題一行、說明另起一行用全形空白縮排。認不出來的話會在「項目」和
// 「它自己的說明」中間插一個空行，比原本更亂。
eq('・9/6《人型機器人走向模組化》\n　硬體要處理高扭矩與輕量化。\n・8/6《CPO 加速 AI 光互連》\n　AI 伺服器叢集擴大。',
   '・9/6《人型機器人走向模組化》\n　硬體要處理高扭矩與輕量化。\n・8/6《CPO 加速 AI 光互連》\n　AI 伺服器叢集擴大。',
   '條列項目與它的縮排說明之間不插空行');

eq('・項目\n　說明。\n這是收尾。',
   '・項目\n　說明。\n\n這是收尾。',
   '縮排說明之後回到正文，仍然要補空行');

console.log('── 四、既有的清理行為保留 ──');

eq('第一行   \n・項目\t\n', '第一行\n\n・項目', '行尾的半形空白與 tab 清掉');
eq('甲　\n・項目', '甲\n\n・項目', '行尾的全形空白也清掉');
eq('開場。\n\n\n\n・項目', '開場。\n\n・項目', '三個以上連續換行壓成兩個');
eq('\n\n  開場。  \n\n', '開場。', '整段前後的空白 trim 掉');

check('空字串不會爆', tidyLineLayout('') === '');
check('null／undefined 不會爆', tidyLineLayout(null) === '' && tidyLineLayout(undefined) === '');

console.log('── 五、不能弄壞給程式判讀的那幾行 ──');

// 「來源編號：」是產業趨勢／技術問答用來對連結的機器可讀行（見 lib/industry-trends.js）。
// 它排在條列後面時會被這支補一個空行——正則吃不吃得下，這裡直接驗到底。
const withMarker = tidyLineLayout('・9/6《人型機器人》\n・8/6《CPO》\n來源編號：1,2');
check('條列後面的「來源編號：」被補了空行，但仍然抓得到編號',
  JSON.stringify(extractSourceIndices(withMarker).indices) === '[1,2]',
  JSON.stringify(withMarker) + ' → ' + JSON.stringify(extractSourceIndices(withMarker)));
check('抽掉「來源編號：」之後，留給記者看的正文不含那一行',
  !extractSourceIndices(withMarker).text.includes('來源編號'),
  JSON.stringify(extractSourceIndices(withMarker).text));

console.log(`\n${fail === 0 ? '✅' : '❌'} 版面出口測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
