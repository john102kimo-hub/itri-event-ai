// 提問的主題統計（字典比對）。後台「問答分析」的熱門關鍵字（api/analytics.js）與計畫成效唯讀頁（lib/impact.js，批次 151）共用。
//
// 用字典比對、不用「連續中文 2–8 字」貪婪切詞：貪婪切詞切出的是斷句碎片，兩位記者問同一件事只要措辭差一個字
// 就會被算成兩個不同關鍵字，熱點永遠浮不出來。
// public/report.html 瀏覽器端有一份同樣的詞表（不能 import），兩份要一起改。
export const GENERIC_TERMS = [
  'AI', '人工智慧', '量產', '技轉', '時程', '成本', '合作廠商', '合作對象', '應用場域',
  '技術突破', '商業化', '專利', '產能', '良率', '補助', '投資', '國際', '出貨', '市場',
  '規格', '效能', '安全', '法規', '永續', '碳排', '淨零', '智慧製造', '半導體', '晶片',
  '醫療', '機器人', '能源', '資安', '雲端', '合作備忘錄', 'MOU', '授權', '團隊', '成果'
];

/** questions：問題文字的陣列。回傳依次數排序的 [{ word, count }]，最多 limit 個。 */
export function countTopics(questions, { limit = 20 } = {}) {
  const counts = {};
  for (const q of questions || []) {
    const text = String(q || '');
    for (const word of GENERIC_TERMS) if (text.includes(word)) counts[word] = (counts[word] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word, count]) => ({ word, count }));
}
