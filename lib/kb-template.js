// 活動知識庫的固定範本，以及「這份知識庫到底有沒有真的寫東西」的判斷（批次 103）。
//
// 為什麼要有這支：後台「新增活動」會把範本整份帶進知識庫欄位（照格式填空即可，不會漏欄位）。
// 範本本身不是空字串，所以 `if (!knowledge_base)` 與檢查清單的「新聞稿有沒有填」都把它當成
// 「有填」——實測：只填了活動名稱、範本一個字沒動，照樣存得進去、發布得出去，記者問什麼米亞都只能
// 回「這部分我沒有資料」。LINE 職員模式的「發布」有擋必填，後台與同仁編輯頁沒有（見
// api/events.js 的發布閘門），而且就算有擋，範本不算空的話也擋不到這一種。
//
// ⚠️ public/index.html 與 public/edit.html 各鏡射一份 KB_TEMPLATE（靜態頁沒辦法 import 這裡）。
// 改範本要三個地方一起改，test/test-batch103-admin.mjs 會比對三份逐字相同。

export const KB_TEMPLATE = `【活動名稱】

【日期 / 地點】

【受訪者 / 發言人】
- 姓名（職稱）：

【貴賓致詞】
- 姓名（職稱）：

【活動議程】
- 時間　項目：

【新聞稿全文】


【技術亮點 / 發表內容】


【合作廠商】
- 廠商：分工

【背景數據 / 關鍵數字】
-

【常見問答 Q&A】
Q：
A：

【聯絡窗口】
- 公關姓名 / 電話：

【得獎名單】（頒獎場填，其餘留空）
-

【素材連結】
- 技術影片：
- 新聞稿電子檔：
- 記者會簡報：
- 照片：
`;

// 範本裡每一行（去掉頭尾空白）。使用者沒動過的行就是「範本」，不算內容。
const TEMPLATE_LINES = new Set(
  KB_TEMPLATE.split('\n').map(l => l.trim()).filter(Boolean)
);

// 就算同仁自己改過範本（刪了某個標題、多留一個空的項目符號），這幾種長相也不算內容：
//   ・只有項目符號的行            「-」「・」「*」
//   ・只有【標題】（可帶括號備註） 「【合作廠商】」「【得獎名單】（頒獎場填…）」
//   ・只有「標籤：」後面沒東西      「- 姓名（職稱）：」「Q：」
const EMPTY_SHAPES = [
  /^[-・•*]+$/,
  /^【[^】]*】(（[^）]*）|\([^)]*\))?$/,
  /^[-・•*]?\s*[^：:]{0,30}[：:]$/
];

/**
 * 知識庫有沒有真的寫東西。
 * 只有範本（或範本改過一點、但每一行都還是「標題／空項目／空標籤」）就是 false。
 * 只要有任何一行是範本裡沒有、也不是上面那幾種空殼，就是 true——不設字數門檻，
 * 判準是「範本有沒有被填過」，不是「寫得夠不夠長」。
 */
export function kbHasContent(kb) {
  const lines = String(kb || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.some(l => !TEMPLATE_LINES.has(l) && !EMPTY_SHAPES.some(re => re.test(l)));
}

// 在每一行裡找出「真的有內容」的行（不是範本、不是標題／空項目／空標籤）
const isContentLine = (l) => !TEMPLATE_LINES.has(l) && !EMPTY_SHAPES.some(re => re.test(l));

/**
 * 把知識庫依【標題】切成段，回傳 [{ heading, content: [有內容的行…] }]。
 * 標題那一行後面直接接的字（【活動名稱】工研院…）算內容；標題後面的括號備註（頒獎場填，其餘留空）不算。
 * 供「預設快速提問」判斷哪幾段真的有寫東西（lib/default-chips.js）。
 */
export function kbSections(kb) {
  const out = [];
  let cur = null;
  for (const raw of String(kb || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^【([^】]*)】/);
    if (m) {
      cur = { heading: m[1].trim(), content: [] };
      out.push(cur);
      const rest = line.slice(m[0].length).trim();
      if (rest && !/^[（(][^）)]*[）)]$/.test(rest) && isContentLine(rest)) cur.content.push(rest);
      continue;
    }
    if (cur && line && isContentLine(line)) cur.content.push(line);
  }
  return out;
}
