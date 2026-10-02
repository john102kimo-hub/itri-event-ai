// 記者填的「媒體」與「姓名」（批次 105：C 批決定 3——媒體欄拆成兩欄）。
//
// 緣起：網頁問答的彈窗原本只有一欄「媒體/貴賓 職稱與人名」，記者想怎麼填就怎麼填，後台的
// 「服務媒體家數」是把整串文字拿去去重——「經濟日報 王小明」與「經濟日報 林小美」算兩家，
// 「請問何時量產？」這種問句也進了媒體排行。這個數字是朱朱要報給長官的，不能靠運氣。
//
// 做法有兩層：
//   ① 以後網頁彈窗拆成兩欄，qa_log 的 D 欄只放「媒體」、新增的 I 欄放「姓名」（見 api/chat.js）；
//   ② 舊資料（D 欄裡是「媒體 人名」整串）與 LINE 的自由輸入，用這裡的 splitMedia()／outletKey()
//      盡量整理成同一家——只用在「統計」，不改動試算表裡的原始內容。
//
// ⚠️ 這些函式只服務統計與顯示。要不要把某筆資料算進去（測試資料、員工自己問的）一律在這裡判斷，
// analytics、成效報告、LINE 職員的「後台數據」共用同一份，三個地方的數字才會一致。

import { normalizeOutlet } from './exposure-parse.js';

export const MEDIA_UNFILLED = '（未填寫）';   // 網頁沒填、或 LINE 沒問到
export const MEDIA_SKIPPED = '（未提供）';    // LINE 上記者按了「略過」
export const MEDIA_STAFF = '（內部職員）';    // 同仁在 LINE 職員模式自己問的（api/line.js）
export const MEDIA_GROUP = '（群組提問）';    // LINE 群組裡的提問（群組裡沒辦法問「貴媒體」，見 api/line.js）

const norm = (s) => String(s ?? '').trim();

/** 這個值不是真的媒體（沒填、略過、員工自己問）。 */
export function isNotMedia(raw) {
  const s = norm(raw);
  return !s || s === MEDIA_UNFILLED || s === MEDIA_SKIPPED || s === MEDIA_STAFF || s === MEDIA_GROUP;
}

/** 同仁在 LINE 職員模式自己問的（不是記者，結案報告與統計都不該算）。 */
export function isStaffMedia(raw) {
  return norm(raw) === MEDIA_STAFF;
}

/** 測試資料：媒體名稱是測試、純數字、亂打，或是員工自己問的。 */
export function isTestMedia(raw) {
  const s = norm(raw).toLowerCase();
  if (!s) return false;
  if (isStaffMedia(raw)) return true;
  if (/測試|test|demo|範例|sample|練習/.test(s)) return true;
  if (/^[0-9]+$/.test(s)) return true;
  if (/^(abc|xxx|aaa|ttt|qqq|asdf|qwer|zzz|123)$/.test(s)) return true;
  return false;
}

// 明顯是一句問題、不是媒體名稱：LINE 的一次性擷取視窗誤判時，記者的問題會被記成媒體名稱
// （見 api/analytics.js 的 isDirtyMediaName 與 lib/line.js looksLikeNameOrSkip 的說明）。
// 這裡只在「算家數」時把它們略過——判準比清理工具更窄（不看字數），因為這支是自動套用的。
const QUESTION_LEAD_RE = /^(請問|為什麼|為何|什麼|怎麼|如何|哪裡|哪一|何時|多少|是否|能不能|可不可以|會不會|有沒有|給我|請給|麻煩|幫我|提供|傳給我|傳送|寄送|附上|想問|想要|想知道|需要|來一份|給一份)/;
export function looksLikeQuestion(raw) {
  const s = norm(raw);
  return /[?？]/.test(s) || QUESTION_LEAD_RE.test(s);
}

// 句尾的「人的稱呼」：只在「媒體後面直接黏著稱呼」時拿掉（聯合報記者 → 聯合報）。
const ROLE_TAIL_RE = /(特派員|攝影記者|記者|編輯|主播|攝影|採訪組|採訪中心|新聞部|同仁|先生|小姐)$/;

/**
 * 把一個舊式／自由輸入的值拆成 { outlet, person }。
 * 新資料（網頁兩欄）D 欄本來就只有媒體，這裡原樣回傳；舊資料常寫成「經濟日報 王小明」。
 * 判準很保守：只有「空白分隔、至少兩段、第一段 2 個字以上」才當成「媒體 + 人名」。
 */
export function splitMedia(raw) {
  const s = norm(raw).replace(/[\s　]+/g, ' ');
  if (isNotMedia(s) || looksLikeQuestion(s)) return { outlet: '', person: '' };
  const parts = s.split(' ');
  const rest = parts.slice(1).join(' ');
  // 後面那段要有中文字才當成「人名」：英文媒體名稱本身就有空白（Taipei Times），照樣拆會把
  // 「Taipei Times」與「Taipei Post」併成同一家「Taipei」。
  if (parts.length >= 2 && [...parts[0]].length >= 2 && /[㐀-鿿]/.test(rest)) {
    return { outlet: parts[0], person: rest };
  }
  const stripped = s.replace(ROLE_TAIL_RE, '');
  return { outlet: [...stripped].length >= 2 ? stripped : s, person: '' };
}

/** 統計用的「同一家」鍵。空字串＝不算任何一家。 */
export function outletKey(raw) {
  const { outlet } = splitMedia(raw);
  return outlet ? normalizeOutlet(outlet) : '';
}

/**
 * 把一批媒體名稱（每筆一個）整理成「家」：
 *   [{ key, name, count }]，name 取該家最常出現的寫法，依 count 由多到少。
 * 空的、沒填、略過、員工自己問的不算。
 */
export function groupOutlets(rawNames) {
  const groups = new Map();   // key -> { variants: Map(name -> n), count }
  for (const raw of rawNames) {
    const { outlet } = splitMedia(raw);
    const key = outlet ? normalizeOutlet(outlet) : '';
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { variants: new Map(), count: 0 }; groups.set(key, g); }
    g.count++;
    g.variants.set(outlet, (g.variants.get(outlet) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      name: [...g.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0],
      count: g.count
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
}
