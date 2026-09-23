// 新聞稿「GEO 寫法檢核」（批次 74）——給「發稿建議」的呈核一頁用。
//
// 需求原話：「修改完後如果 OK，可否也能產出一頁簡報，讓新聞稿在呈核時，讓長官能夠知道
// 這篇稿子已符合 GEO 規範，能讓 AI 更容易抓到」。長官要的是一眼看懂「改前幾項、改後
// 幾項」，所以這裡要的是一個**可重複、講得出理由**的分數：
//
// ⚠️ 純規則、不呼叫 AI——跟 lib/structured-check.js 同一個立場。同一篇稿子檢查幾次都要
// 同分；分數要上呈給長官，被問「為什麼這項沒過」時要指得出是哪一句。AI 顧問的建議
// （runAdvise）是幫同仁改稿用的，這份檢核是改完之後的「驗收」，兩件事分開。
//
// ⚠️ 這份檢核證明的是「寫法符合 AI 容易正確引用的條件」，**不是**保證 AI 一定會引用。
// 呈核頁上的用字要守住這條線（見 public/geo.html draftBriefHtml()）——長官拿去跟
// 院長報告時，講得比證據多的那一句會先被戳破。
//
// 每一項都對應到這個專案實測過的失敗形狀（api/geo.js diagnose() 的診斷）：
// AI 摘要常只留第一段、引用時主詞會掉、沒有自家網頁就引別人的轉載。
import { NUMBER_RE, DATE_RE, LINK_RE } from './structured-check.js';

const BRAND = '工研院';
const MAX_PARA = 400;
const OWNED_LINK_RE = /https?:\/\/[^\s)]*(itri\.org\.tw|iek\.org\.tw)/i;

function splitDraft(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((s) => s.trim());
  const title = lines.find(Boolean) || '';
  const rest = lines.slice(lines.indexOf(title) + 1).join('\n');
  const paras = rest.split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean);
  const lead = paras[0] || '';
  const sentences = rest.split(/(?<=[。！？!?])|\n/).map((s) => s.trim()).filter(Boolean);
  return { title, lead, paras, sentences, rest };
}

/** 最適合被 AI 整句引用的一句：同時有「工研院」和一個可查證數字、長度剛好一口氣講得完。 */
export function bestQuotable(text) {
  const { sentences } = splitDraft(text);
  const ok = sentences.filter((s) => s.includes(BRAND) && NUMBER_RE.test(s) && s.length >= 15 && s.length <= 80);
  return ok.sort((a, b) => Math.abs(a.length - 45) - Math.abs(b.length - 45))[0] || '';
}

/**
 * @param {string} text 整篇稿子（第一行當標題）
 * @param {{ keyword?: string }} opt 這篇稿子的議題關鍵字；沒給就不檢查那一項
 * @returns {{ checks: Array<{key,label,plain,pass}>, passed:number, total:number, quote:string }}
 *   label 是給同仁看的檢查條件；plain 是給長官看的白話（「AI 一讀開頭就知道是工研院做的」）。
 */
export function checkGeoDraft(text, { keyword = '' } = {}) {
  const src = String(text || '');
  if (!src.trim()) return { checks: [], passed: 0, total: 0, quote: '' };
  const { title, lead, paras } = splitDraft(src);
  const kw = String(keyword || '').trim();
  const quote = bestQuotable(src);

  const checks = [
    { key: 'lead_brand', label: '第一段就寫出「工研院」（當主詞）',
      plain: 'AI 一讀開頭就知道是工研院做的',
      pass: lead.includes(BRAND) || (title.includes(BRAND) && lead.slice(0, 60).includes(BRAND)) },
    { key: 'lead_number', label: '第一段就有具體數字（含單位）',
      plain: '開頭就有數字，AI 摘要不會只剩空話',
      pass: NUMBER_RE.test(lead) },
    ...(kw ? [{ key: 'keyword', label: `標題與第一段都出現議題關鍵字「${kw}」`,
      plain: `有人問 AI「${kw}」時，對得上這篇`,
      pass: title.includes(kw) && lead.includes(kw) }] : []),
    { key: 'quotable', label: '有一句「工研院＋數字＋成果」的完整句子（15–80 字）',
      plain: '有一句話 AI 可以整句引用、主詞不會掉',
      pass: !!quote },
    { key: 'date', label: '有明確日期',
      plain: 'AI 知道這是最新的消息',
      pass: DATE_RE.test(src) },
    { key: 'owned_link', label: '附工研院自家網址（itri.org.tw 主題頁）',
      plain: 'AI 引用時會連回工研院自己的網頁，不是別人的轉載',
      pass: OWNED_LINK_RE.test(src) },
    // 原本是「每段 200 字以內」，朱朱指出新聞稿的導言、主管談話通常一段就超過 200 字，
    // 照實際寫法幾乎每篇都過不了——一項永遠過不了的檢核，長官只會看到「還差 1 項」，
    // 同仁也只會學到「這項不用理」。GEO 真正怕的是一段長到 AI 分段擷取時被切開、
    // 重點跟主詞分家；導言、談話正常的長度不在此列，所以只擋 400 字以上的超長段落。
    { key: 'short_paras', label: '沒有超長段落（每段 400 字以內）',
      plain: '沒有落落長的大段，AI 擷取時不會斷章取義',
      pass: paras.length > 0 && paras.every((p) => p.length <= MAX_PARA) },
  ];
  // LINK_RE 留著給「有網址但不是自家的」這種提示用
  checks.find((c) => c.key === 'owned_link').otherLink = !OWNED_LINK_RE.test(src) && LINK_RE.test(src);
  const passed = checks.filter((c) => c.pass).length;
  return { checks, passed, total: checks.length, quote };
}
