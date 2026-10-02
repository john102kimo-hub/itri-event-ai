// 「快速提問」按鈕的預設值（批次 104，B 批）。
//
// 緣起：活動沒有自訂快速提問時，網頁與 LINE 都退回同一組寫死的五題——「這項技術預計何時商業化？」
// 「有哪些合作廠商參與？」。那是技術發表會的問法：院士授證典禮、論壇、參訪點下去，AI 只能回
// 「這部分我沒有資料」，記者第一個互動就是失望。
//
// 現在改成**看知識庫實際寫了什麼**：
//   ① 【常見問答】裡同仁寫好的 Q（最準，那就是他預期會被問的）
//   ② 「這次活動的重點是什麼？」（有寫新聞稿才給）
//   ③ 有內容的小節各給一題（得獎名單、技術亮點、合作廠商、關鍵數字、受訪者、致詞、議程）
//   ④ 活動的時間和地點、新聞聯絡人（後台的正式欄位，AI 一定答得出來）
// 沒內容的小節不出題：院士授證典禮沒寫【合作廠商】，就不會出現「有哪些合作廠商？」。
// 純規則、不呼叫模型：按鈕要每次算出來都一樣（CLAUDE.md 第 2 條的精神——不靠模型的心情）。
import { kbHasContent, kbSections } from './kb-template.js';
import { resolveEventContent, isPreEventMode } from './prompt.js';

// 小節標題 → 問句。排列順序＝出題的優先順序。
const SECTION_QUESTIONS = [
  { re: /得獎|獲獎|名單/, q: '得獎名單有哪些？' },
  { re: /技術亮點|發表內容|亮點/, q: '有哪些技術亮點？' },
  { re: /合作廠商|合作夥伴|合作單位/, q: '有哪些合作廠商？' },
  { re: /關鍵數字|背景數據|數據/, q: '有哪些關鍵數字？' },
  { re: /受訪者|發言人|講者/, q: '有哪些受訪者或發言人？' },
  { re: /貴賓致詞|致詞/, q: '貴賓致詞的重點是什麼？' },
  { re: /議程|流程/, q: '活動議程是什麼？' }
];

export const Q_HIGHLIGHT = '這次活動的重點是什麼？';
export const Q_WHEN_WHERE = '活動的時間和地點？';
export const Q_CONTACT = '新聞聯絡人是誰？';

// 知識庫什麼都沒有時的保底：這三題不靠知識庫內容（時間地點與聯絡人是後台的正式欄位）
export const GENERIC_CHIPS = [Q_HIGHLIGHT, Q_WHEN_WHERE, Q_CONTACT];

// 活動前（邀請函模式）：AI 只讀得到邀請函，問「技術亮點」只會得到「沒有資料」
export const PRE_EVENT_CHIPS = ['邀請函的內容是什麼？', '採訪申請方式？', Q_WHEN_WHERE];

const MAX_CHIPS = 5;

function faqQuestions(kb) {
  const out = [];
  for (const sec of kbSections(kb)) {
    if (!/常見問答|Q\s*[&＆]\s*A|FAQ/i.test(sec.heading)) continue;
    for (const line of sec.content) {
      const m = line.match(/^Q[：:]\s*(.+)$/i);
      if (!m) continue;
      let q = m[1].trim();
      if (q.length < 3 || q.length > 40) continue;
      if (!/[?？]$/.test(q)) q += '？';
      out.push(q);
    }
  }
  return out;
}

/**
 * 從知識庫與基本資料算出預設快速提問。event：{ knowledge_base, press_contact, venue, event_time, event_date }
 * 傳進來的 knowledge_base 要是「答題實際用的那份」（邀請函模式的判斷在 effectiveChips()）。
 */
export function deriveChips(event = {}) {
  const kb = event.knowledge_base || '';
  const chips = [];
  const add = (q) => { if (q && !chips.includes(q)) chips.push(q); };

  const hasKb = kbHasContent(kb);
  if (hasKb) {
    faqQuestions(kb).slice(0, 2).forEach(add);
    add(Q_HIGHLIGHT);
    const withContent = kbSections(kb).filter(s => s.content.length);
    let picked = 0;
    for (const rule of SECTION_QUESTIONS) {
      if (picked >= 2) break;
      if (withContent.some(s => rule.re.test(s.heading))) { add(rule.q); picked++; }
    }
  }
  if (event.venue || event.event_time || event.event_date) add(Q_WHEN_WHERE);
  if (event.press_contact) add(Q_CONTACT);
  return chips.slice(0, MAX_CHIPS);
}

/**
 * 這場「現在該顯示哪幾顆快速提問」：
 *   同仁自訂的優先（活動前會換成活動前那組，見 lib/prompt.js resolveEventContent）→
 *   活動前沒自訂 → 邀請函那一組 → 其餘依知識庫算 → 算不出來用保底三題。
 * 網頁（api/events.js get_public）與 LINE（api/line.js eventContentChips）都走這一支，兩邊才會一致。
 */
export function effectiveChips(rawEvent) {
  const ev = resolveEventContent(rawEvent || {});
  const custom = String(ev.chips || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (custom.length) return custom;
  if (isPreEventMode(rawEvent || {})) return PRE_EVENT_CHIPS;
  const derived = deriveChips(ev);
  return derived.length ? derived : GENERIC_CHIPS;
}
