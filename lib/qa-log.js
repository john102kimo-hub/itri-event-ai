// qa_log 的讀取（批次 117）。
//
// qa_log 的 F 欄是 AI 回答全文，一列動輒上千字（中文 UTF-8 一個字三個 bytes），問答累積到兩千筆，
// 整張讀一次就是好幾 MB。後台首頁的數字、LINE 職員的「數據」與活動卡、媒體訓練撈「記者真的問過的
// 題目」、露出交叉分析，每一次都整張讀——卻沒有一支用到 F 欄，只用時間、活動、媒體、問題、刪除旗標、
// 來源、姓名。資料只會越來越多，這幾個入口只會越來越慢。
//
// 這支改用一次 batchGet 讀 A:E 與 G:I 兩段（Sheets 只算一次讀取），F 欄放空字串佔位：
// 呼叫端照原本的欄位位置（r[1]、r[3]、r[6]…）讀，一個索引都不用改。
// 要 AI 回答全文的地方（匯出 CSV、後台逐筆問答、「疑似沒答到」的判斷）照舊讀整張。
//
// 欄位：A 時間 B 活動 id C 活動名稱 D 媒體 E 問題 F 回答 G 刪除旗標 H 來源 I 姓名
import { readRanges } from './sheets.js';

/** qa_log 第 2 列起每一列（A～I，F 欄一律是空字串）。 */
export async function readQaRowsWithoutAnswers() {
  const [ae, gi] = await readRanges(['qa_log!A2:E', 'qa_log!G2:I']);
  const n = Math.max(ae.length, gi.length);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ae[i] || [];
    const g = gi[i] || [];
    rows[i] = [a[0] ?? '', a[1] ?? '', a[2] ?? '', a[3] ?? '', a[4] ?? '', '', g[0] ?? '', g[1] ?? '', g[2] ?? ''];
  }
  return rows;
}
