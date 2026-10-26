// 批次 164：整段擠成一行的回覆（「每場次的新聞參考資料」截圖）。
//   tidyLineLayout() 多一道 splitInlineLayout()：行內條列、網址、警語各自換行。
//   最重要的是第二節：只能加換行，不能刪字、不能切壞人名，已排好的內容不能再變。
import { tidyLineLayout } from '../lib/line-format.js';
import { toTraditionalTW } from '../lib/zh-tw.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}
const eq = (input, expect, why) => {
  const got = tidyLineLayout(input);
  check(why, got === expect, `實際：${JSON.stringify(got)}\n   期望：${JSON.stringify(expect)}`);
};
const flat = (s) => s.replace(/[\s　]+/g, '');

console.log('── 一、截圖那則 ──');
const URL1 = 'https://docs.google.com/document/d/1ifgQuanSWOkHYr3YeO5c4sZnoCxEMpKN/edit';
const blob = `目前離活動還有 2 天，最近的是 10/28 場次，之後場次的資料會依日期陸續提供。 ・10/28 早上：活動開幕暨專刊《啟自主：無人科技 百業新生》發表 這一場的新聞稿還沒好，稍晚會提供。 ・10/28 下午：通訊 新聞參考資料： ${URL1} 之後場次（10/29 起）等當天再提供，需要的話也可以洽新聞聯絡人 朱則瑋 0934267766 LINEID:rainchuchu。 內容僅供參考，以工研院官網新聞稿或發言為準。`;
eq(blob,
  `目前離活動還有 2 天，最近的是 10/28 場次，之後場次的資料會依日期陸續提供。\n\n` +
  `・10/28 早上：活動開幕暨專刊《啟自主：無人科技 百業新生》發表 這一場的新聞稿還沒好，稍晚會提供。\n` +
  `・10/28 下午：通訊 新聞參考資料：\n　${URL1}\n\n` +
  `之後場次（10/29 起）等當天再提供，需要的話也可以洽新聞聯絡人 朱則瑋 0934267766 LINEID:rainchuchu。\n\n` +
  `內容僅供參考，以工研院官網新聞稿或發言為準。`,
  '擠成一段的回覆：條列各自一行、網址獨立（縮排在那一項底下）、聯絡人與警語各自成段');
check('一個字都沒少（只多了換行與縮排）', flat(tidyLineLayout(blob)) === flat(blob));

console.log('── 二、不能動到的 ──');
eq('與會的還有史蒂夫・賈伯斯與馬丁・路德・金恩兩位。', '與會的還有史蒂夫・賈伯斯與馬丁・路德・金恩兩位。', '人名中間的「・」不拆');
eq('講者：史蒂夫・賈伯斯。馬丁・路德・金恩。', '講者：史蒂夫・賈伯斯。馬丁・路德・金恩。', '句號後面接的是人名中間的「・」位置，前面緊貼字 → 不拆');
const done = '第一段。\n\n・項目\n　說明文字。\n　https://a.com/x\n\n第二段。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。';
eq(done, done, '已經排好的內容（含縮排網址、警語自成一段）完全不變（冪等）');
check('再跑一次結果相同', tidyLineLayout(tidyLineLayout(blob)) === tidyLineLayout(blob));
eq('專線 0800-123-456。內容僅供參考，以工研院官網新聞稿或發言為準。', '專線 0800-123-456。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。', '警語黏在句子後面 → 自成一段');
eq('內容僅供參考，以工研院官網新聞稿或發言為準。', '內容僅供參考，以工研院官網新聞稿或發言為準。', '只有警語時不補空行');

console.log('── 三、網址 ──');
eq('・看 https://a.com/x。謝謝', '・看\n　https://a.com/x。\n\n謝謝', '條列裡的網址：後面緊貼的全形標點留在網址那一行，下一行不以標點開頭');
eq('・網址：https://a.com/x?a=1&b=2#top', '・網址：\n　https://a.com/x?a=1&b=2#top', '網址帶參數與錨點不被截斷');
eq('・看 https://a.com/x, 或 https://b.com/y.', '・看\n　https://a.com/x,\n\n或\n　https://b.com/y.', '網址結尾的半形標點留在網址那一行、不單獨起行');
eq('詳見 https://a.com/x。謝謝', '詳見 https://a.com/x。謝謝', '一般句子裡的網址原樣不動（沒有排版問題就逐字送出）');
eq('預計 2028 年量產，詳見\nhttps://fake.example.com/semi。', '預計 2028 年量產，詳見\nhttps://fake.example.com/semi。', '模型自己已經換好行的網址不動');

console.log('── 四、出口順序：繁體轉換在後面，簡體警語也要認得 ──');
check('簡體警語也被拆出來', tidyLineLayout('電話 0912。内容仅供参考，以工研院官网新闻稿或发言为准。').includes('\n\n内容仅供参考'));
check('轉繁體後仍是繁體', !/[内仅参网闻发]/.test(toTraditionalTW(tidyLineLayout(blob))));

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 164 測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
