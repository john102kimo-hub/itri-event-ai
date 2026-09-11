// 「結構化稿」自動初檢——api/geo.js 的事件效應表會問「這則稿件是不是結構化稿」
// （見 GEO_SETUP.md「結構化稿標記」那段：有清楚標題／摘要／可查證數字、且有獨立
// 主題頁可連），目前完全靠同仁開始追蹤前自己勾選、憑印象判斷。這支把那個定義攤開
// 成幾條看得到理由的規則檢查，貼稿件文字進去就能先自動掃一次當參考。
//
// 不會、也不該直接覆寫同仁的勾選：規則抓得到「有沒有出現符合格式的數字／日期／
// 連結」，抓不到「這段寫得好不好、數字夠不夠有說服力」，那一半永遠要人判斷——
// 這支只負責把看得到、可重複驗證的那一半自動化。
//
// 純規則、不呼叫任何 AI，跟 api/geo.js diagnoseEvent() 同一個立場（見該檔案「判官
// 只做觀察，分數一律由程式算」的說明）：同一份稿子丟兩次要給同一個結果，才追得回
// 「為什麼這篇被判非結構化」，不能讓同一份稿子今天判過、明天模型心情不同又判別的。

// 涵蓋常見的新聞稿計量單位／貨幣／百分比寫法。抓不到不代表沒有數字（例如純中文
// 大寫數字「三十億」），寧可漏抓一些冷門寫法，也不要放寬到「任何數字」都算——
// 那樣連日期、頁碼都會被誤判成「可查證數字」，失去這條檢查原本要抓的東西。
const NUMBER_RE = /\d+(?:[.,]\d+)?\s*(?:%|％|個百分點|億|萬|千|兆|奈米|nm|kg|公斤|公噸|噸|GWh|MWh|kWh|MW|GW|瓦|坪|件|篇|項|倍|人|名|座|支|次|美元|新台幣|NT\$|USD|元)/;

// 西元／民國年都收，格式不要求到日——「2026年9月」「114年9月11日」「2026/09/11」都算。
const DATE_RE = /\d{2,4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\d{4}[/\-]\d{1,2}(?:[/\-]\d{1,2})?/;

const LINK_RE = /https?:\/\/[^\s)]+/;

const CHECKS = [
  { key: 'title', label: '有明確標題', test: ({ title }) => String(title || '').trim().length >= 6 },
  { key: 'number', label: '內文含至少一個可查證數字（含單位／百分比／金額）', test: ({ text }) => NUMBER_RE.test(String(text || '')) },
  { key: 'date', label: '稿頭或內文有明確日期', test: ({ title, text }) => DATE_RE.test(`${title || ''}\n${text || ''}`) },
  { key: 'link', label: '附有可連結的原始網址／獨立主題頁', test: ({ text }) => LINK_RE.test(String(text || '')) },
];

/**
 * @param {{ title?: string, text?: string }} input 標題另外傳，內文（摘要或全文皆可）貼進 text。
 * @returns {{ checks: Array<{key:string,label:string,pass:boolean}>, passed: number, total: number, structured: boolean|null }}
 *
 * structured 的判定刻意留一格「不確定」，不是只有 true/false 兩種：
 *   - true：4 項過 3 項以上，跟 GEO_SETUP.md 定義的「結構化稿」門檻一致
 *   - false：4 項只過 1 項以下，明顯不足
 *   - null：過 2 項，卡在中間——寧可讓同仁自己判斷，也不要用規則硬猜一個可能
 *     錯的答案汙染「結構化 vs 非結構化」的比較（這個比較是 GEO 事件效應表拿來
 *     回答「結構化稿是不是真的比較留得住記憶」的依據，見 api/geo.js diagnoseEvent()）
 *   - 標題與內文都是空的，判斷不了：也回 null，不能把「沒填」當「不結構化」算。
 */
export function checkStructuredContent(input) {
  const title = String(input?.title || '');
  const text = String(input?.text || '');
  if (!title.trim() && !text.trim()) {
    return { checks: [], passed: 0, total: CHECKS.length, structured: null };
  }
  const checks = CHECKS.map((c) => ({ key: c.key, label: c.label, pass: !!c.test({ title, text }) }));
  const passed = checks.filter((c) => c.pass).length;
  const structured = passed >= CHECKS.length - 1 ? true : passed <= 1 ? false : null;
  return { checks, passed, total: CHECKS.length, structured };
}
