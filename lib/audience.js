// 企業場（批次 118，業發處的第 0 步）。
//
// 活動類型（events!N）是下面這幾種之一，就是「企業場」：對象是企業的工程師與主管，不是記者。
// 這一個判斷決定整條路怎麼走——
//   ① 不出現在記者看得到的地方：米亞的「最近有哪些活動」與路由、跨場次帶入別場的答案、公開活動列表、
//      搜尋引擎（noindex、不進 sitemap）。客戶參訪的活動名稱常常就是客戶的名字，知識庫裡也可能有
//      給客戶看、不給記者看的內容。要讓人問，就給活動頁網址或 #代碼。
//   ② 活動頁問「公司／單位」不問「媒體」，問答紀錄不算進媒體統計（服務媒體家數、媒體排行、成效報告）。
//   ③ AI 用企業版的規則回答（lib/prompt.js buildBusinessSystemPrompt()），出口再擋一次報價
//      （guardBusinessAnswer()）——「不報價、不承諾」寫在 prompt 裡只是請求（CLAUDE.md 第 2 條）。
//
// 用一份明確的清單，不用「活動類型含『企業』兩個字就算」這種猜法：猜錯的方向是把記者會從米亞的清單裡
// 藏起來，而且沒有人會發現。後台的活動類型下拉選單列的就是這幾個字。

export const BUSINESS_EVENT_TYPES = ['企業說明會', '技術媒合會', '客戶參訪', '技術交流會'];
const BUSINESS_SET = new Set(BUSINESS_EVENT_TYPES);

/** event 物件（看 event_type），或直接傳活動類型字串。 */
export function isBusinessEvent(eventOrType) {
  const t = typeof eventOrType === 'string' ? eventOrType : eventOrType?.event_type;
  return BUSINESS_SET.has(String(t || '').trim());
}

// ── 出口：不報價 ─────────────────────────────────────────────────────────
// 擋的是「背景資料裡沒有的金額」。資料裡寫明的公開數字（計畫總經費 3 億元、市場規模 50 億美元）
// 照引沒問題；資料裡沒有、卻出現在答案裡的金額，就是模型自己估的價——授權金、技轉費、開發費、
// 一台設備多少錢。客戶拿著截圖來談，那個數字就變成我們開的價。
//
// ⚠️ 只擋金額，不擋「三個月內可以完成」這種時程承諾：字面上分不出「新聞稿寫的時程」和「模型自己
// 答應的時程」，硬擋只會誤殺正常回答。時程與智財條件靠 prompt 的規則，加上每一則都有的免責句
// （withBusinessDisclaimer()，也是程式保證的）。
//
// ⚠️ 中文數字只認帶「十百千萬億」的（三百萬元、五千元）：「三元正極材料」「二元化合物半導體」是
// 技術名詞，不是錢。
const toHalf = (s) => String(s || '')
  .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
  .replace(/，/g, ',').replace(/．/g, '.').replace(/＄/g, '$');
const CUR = '(?:新台幣|新臺幣|台幣|臺幣|NT\\$|NTD|TWD|US\\$|USD|美金|美元|人民幣|RMB|日圓|日幣|歐元|EUR|\\$)';
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
const SCALE = '(?:兆|億|千萬|百萬|萬|千|million|billion|[kKmMbB](?![a-zA-Z]))?';
const UNIT = '(?:塊錢|塊|元(?![件素宇年月氣])|美元|美金|台幣|臺幣|歐元|日圓|日幣|人民幣)';
// 要以數字開頭、而且帶一個量級字：「十元」「三百萬元」算，「三元」「萬元」不算
const CN_NUM = '(?=[零〇一二兩三四五六七八九十百千萬億]*[十百千萬億])[零〇一二兩三四五六七八九十][零〇一二兩三四五六七八九十百千萬億]*';
const PRICE_WORD = '(?:授權金|權利金|技轉金|技術移轉費|報價|價格|價錢|售價|定價|費用|收費|預算|成本|開發費|單價)';
const MONEY_RES = [
  new RegExp(`${CUR}\\s*(${NUM})\\s*(${SCALE})\\s*${UNIT}?`, 'gi'),             // 新台幣 3,000 萬元、US$1.2M、$500
  new RegExp(`(${NUM})\\s*(${SCALE})\\s*${UNIT}`, 'gi'),                       // 500 萬元、3 億美元、120 元
  new RegExp(`(${CN_NUM})\\s*()${UNIT}`, 'g'),                                  // 三百萬元、五千元
  new RegExp(`${PRICE_WORD}[^。！？!?\\n]{0,12}?(${NUM})\\s*(${SCALE})`, 'gi')  // 授權金約 500 萬（沒寫「元」）
];
// 背景資料裡「有單位的大數字」也算公開數字（產值 3 億、50 萬片），只比數字＋單位
const KB_SCALED_RE = new RegExp(`(${NUM})\\s*(兆|億|千萬|百萬|萬)`, 'g');

const amountKey = (num, scale) => `${String(num).replace(/,/g, '')}${String(scale || '').toLowerCase()}`;
function amountsIn(text) {
  const t = toHalf(text);
  const all = [];
  for (const re of MONEY_RES) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) all.push({ start: m.index, end: m.index + m[0].length, raw: m[0].trim(), key: amountKey(m[1], m[2]) });
  }
  // 幾條規則會抓到同一段（「授權金約 500 萬元」三條都中）：同一段只留最長的那個
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const a of all) if (!out.some((k) => a.start < k.end && k.start < a.end)) out.push(a);
  return out;
}

/** 答案裡出現、背景資料裡沒有的金額（原文）。空陣列＝沒問題。 */
export function findUnlistedAmounts(answer, knowledgeBase) {
  const kbText = toHalf(knowledgeBase);
  const known = new Set(amountsIn(kbText).map((a) => a.key));
  for (const m of kbText.matchAll(KB_SCALED_RE)) known.add(amountKey(m[1], m[2]));
  const bad = amountsIn(answer).filter((a) => a.key && !known.has(a.key)).map((a) => a.raw);
  return [...new Set(bad)];
}

const hasCJK = (s) => /[一-鿿]/.test(String(s || ''));
export function businessDisclaimer(organizer = '工研院', { english = false } = {}) {
  return english
    ? 'For reference only — not a quotation or commitment. Terms of any cooperation are subject to written confirmation by the organizer\'s business contact.'
    : `內容僅供參考，不構成報價或合作承諾；合作條件以${organizer}業務窗口的書面回覆為準。`;
}
const DISCLAIMER_SEEN_RE = /不構成報價|not (?:a )?(?:quotation|quote|commitment)/i;

/** 每一則企業場的回答都要有免責句：模型自己寫了就不重複，沒寫就補在最後。 */
export function withBusinessDisclaimer(answer, organizer = '工研院') {
  const text = String(answer || '').trim();
  if (!text || DISCLAIMER_SEEN_RE.test(text)) return text;
  return `${text}\n\n${businessDisclaimer(organizer, { english: !hasCJK(text) })}`;
}

/** 擋下來時給的固定回覆（不經過模型）。contact：活動聯絡窗口（events!O）。 */
export function businessBlockedReply(event, { english = false } = {}) {
  const organizer = event?.organizer || '工研院';
  const contact = String(event?.press_contact || '').trim();
  if (english) {
    return [
      'This question involves pricing, fees or terms of cooperation. Those have to be assessed by the organizer\'s business team based on your needs, so I can\'t quote or commit to anything here.',
      contact ? `Please contact: ${contact}` : 'Please reach out to the event contact.',
      '',
      businessDisclaimer(organizer, { english: true })
    ].join('\n');
  }
  return [
    `這一題牽涉到費用、報價或合作條件，需要由${organizer}業務窗口依您的需求評估後回覆，我這邊不能代為報價或承諾。`,
    contact ? `可以直接聯絡活動窗口：${contact}` : '可以洽活動聯絡窗口。',
    '',
    businessDisclaimer(organizer)
  ].join('\n');
}

/**
 * 企業場答案的出口檢查。回傳 { text, blocked }：blocked 有東西＝整則換成固定回覆（原因記 log，不給客戶看）。
 * 呼叫端：api/chat.js（網頁）、lib/line-reporter.js answerQuestion()（LINE）。
 */
export function guardBusinessAnswer(answer, event) {
  const blocked = findUnlistedAmounts(answer, event?.knowledge_base);
  if (blocked.length) {
    console.log(`[business-guard] event=${event?.id || '-'} 擋下背景資料沒有的金額：${blocked.join('、')}`);
    return { text: businessBlockedReply(event, { english: !hasCJK(answer) }), blocked };
  }
  return { text: withBusinessDisclaimer(answer, event?.organizer || '工研院'), blocked: [] };
}
