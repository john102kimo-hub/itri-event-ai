// 繁體字出口防線（批次 45）。回報的截圖：一整則回覆都是繁體，只有最後那句警語跑出
// 簡體——「内容仅供参考，以工研院官网新闻稿或发言为准。」
//
// 這支測試分兩半，第二半比第一半重要：
//   ① 該轉的要轉得乾淨
//   ② **本來就正確的繁體，一個字都不可以被改壞**——繁簡轉換最常見的災難不是漏轉，
//      是把「公里」轉成「公裡」、「余先生」轉成「餘先生」這種把對的改成錯的。
import { toTraditionalTW } from '../api/line.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}
function eq(input, expect, why) {
  const got = toTraditionalTW(input);
  check(`${why}：「${input}」→「${expect}」`, got === expect, `實際：「${got}」`);
}

console.log('── 回報的那一句 ──');
eq('内容仅供参考，以工研院官网新闻稿或发言为准。',
   '內容僅供參考，以工研院官網新聞稿或發言為準。', '截圖裡的警語');

console.log('── 一般內文 ──');
eq('这场记者会发布了四足机器人的研发成果，关系到产业发展。',
   '這場記者會發布了四足機器人的研發成果，關係到產業發展。', '記者會內文');
eq('欢迎媒体采访，会后将于官网公布新闻稿。',
   '歡迎媒體採訪，會後將於官網公布新聞稿。', '採訪／會後／將於／官網');
eq('标准制程与规划，请于活动后联系窗口。',
   '標準製程與規劃，請於活動後聯繫窗口。', '標準／製程／請於／活動後／聯繫');
eq('半导体与人工智能的技术论坛，将在台北举办。',
   '半導體與人工智能的技術論壇，將在台北舉辦。', '半導體／論壇');
eq('这项技术已经进入量产验证阶段。',
   '這項技術已經進入量產驗證階段。', '量產驗證');

console.log('── ⚠️ 本來就正確的繁體，一個字都不可以被改壞 ──');
for (const keep of [
  '公里', '里程碑', '鄰里關係', '批准', '不准', '准許',
  '皇后', '太后', '頭髮', '髮型',
  '余先生', '于小姐', '范先生', '台灣', '臺北',
  '系統', '體系', '風采', '一面之緣', '三隻小豬',
  '內容僅供參考，以工研院官網新聞稿或發言為準。'
]) {
  check(`不改壞：「${keep}」`, toTraditionalTW(keep) === keep, `實際：「${toTraditionalTW(keep)}」`);
}

console.log('── 邊界 ──');
check('空字串不會噴例外', toTraditionalTW('') === '');
check('null 不會噴例外', toTraditionalTW(null) === '');
check('英文原樣通過', toTraditionalTW('For reference only.') === 'For reference only.');
check('數字與網址不受影響',
  toTraditionalTW('https://www.itri.org.tw/ListStyle.aspx?MGID=115090715475546032')
    === 'https://www.itri.org.tw/ListStyle.aspx?MGID=115090715475546032');

console.log('── 對照表本身的健康檢查 ──');
{
  // 表裡若有「簡體字對到自己」或格式錯誤的項目，等於白列一項卻沒人發現。
  // 這一項在載入 api/line.js 時就會 throw，跑得到這裡代表格式是好的。
  check('對照表格式檢查在載入時就跑過了（沒有 throw）', true);
  // 抽驗幾個高頻字真的在表裡——「网」就是第一次實測漏掉的那一個
  for (const [s, t] of [['网', '網'], ['点', '點'], ['无', '無'], ['万', '萬'], ['乐', '樂'], ['专', '專']]) {
    check(`高頻字有收：「${s}」→「${t}」`, toTraditionalTW(s) === t, `實際：「${toTraditionalTW(s)}」`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 繁體字防線測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
