// 答案評分器（批次 186）。全部是**程式判斷、不呼叫模型**：同一個答案永遠得到同一個分數，才能拿來比較「改 prompt／換模型」前後。
//
// 分兩層，對應這個專案「prompt 是請求、不是保證」的原則（CLAUDE.md 第 2 條）：
//   ● 使用者實際看到的（final）：模型原始輸出經過正式站的出口處理後的文字。**硬性**，沒過就是會被記者看到的錯。
//   ○ 模型原始輸出（raw）：**軟性**，只統計不當成失敗。它回答的是「模型這次有沒有守規矩」——出口會兜住，但守規矩的比例
//     掉了，代表下次換模型或改 prompt 時，出口得接更多球，是早期警訊。
import { findResidualSimplified, toTraditionalTW } from '../../lib/zh-tw.js';
import { findUngrounded, stripDisclaimer } from '../../lib/answer-grounding.js';
import { stripMarkdownForLine } from '../../lib/line-format.js';

// 這幾個跟正式站的判斷一致，直接重用（lib/line-nodata.js 會連帶載入 LINE 執行環境，所以延遲到真的要評分才載入）
let nodata = null;
async function loadNoData() {
  if (!nodata) {
    try { nodata = await import('../../lib/line-nodata.js'); } catch { nodata = {}; }
  }
  return nodata;
}
const FALLBACK_NO_DATA_RE = /(沒有|未|查不到|找不到).{0,10}(資料|內容|資訊|名單|說明)|沒有提到|未提及|沒有這方面|手上沒有|不在.{0,6}資料/;

const MARKDOWN_RES = [/\*\*[^*\n]+\*\*/, /^\s{0,3}#{1,6}\s+\S/m, /```/, /^\s*\|.+\|\s*$/m, /^\s*\|?\s*:?-{3,}:?\s*\|/m, /\[[^\]\n]+\]\([^)\n]+\)/];
const MARKER_RE = /\[\[\s*NO_DATA|^\s*NO_DATA\s*[:：]/im;
const DISCLAIMER_RE = /僅供參考|for reference only|reference only/i;
const cjkRatio = (s) => { const t = String(s).replace(/\s/g, ''); return t ? (t.match(/[一-鿿]/g) || []).length / t.length : 0; };
export const hasMarkdown = (s) => MARKDOWN_RES.some((re) => re.test(s));

/** 模擬正式站「送出去之前」的處理，得到使用者實際看到的文字。 */
export async function finalizeAnswer(raw, profile = 'line') {
  let text = String(raw ?? '');
  if (profile === 'line') {
    const m = await loadNoData();
    if (m.extractNoDataKeyword) text = m.extractNoDataKeyword(text)?.text ?? text; // 標記一律切掉
    text = stripMarkdownForLine(text);
  }
  return toTraditionalTW(text);
}

/**
 * 對一個答案評分。
 * @param {object} p  { raw, shownText, spec, profile }  spec 是題庫裡那一題（include／include_any／exclude／expect_no_data／expect_lang／ground）
 * @returns {Promise<{ pass: boolean, final: string, checks: Array<{name, level, pass, detail}> }>}
 */
export async function gradeAnswer({ raw, shownText, spec = {}, profile = 'line' }) {
  const final = await finalizeAnswer(raw, profile);
  const body = stripDisclaimer(final);
  const checks = [];
  const add = (name, level, pass, detail = '') => checks.push({ name, level, pass: !!pass, detail: pass ? '' : detail });

  // ── 硬性：使用者實際看到的 ──
  add('not_empty', 'hard', body.trim().length > 0, '答案是空的');
  add('traditional', 'hard', findResidualSimplified(final).length === 0, `殘留簡體字：${findResidualSimplified(final).join('')}`);
  if (profile === 'line') add('no_markdown', 'hard', !hasMarkdown(final), 'LINE 看得到 Markdown 符號（**、#、表格、連結語法）');
  add('no_marker', 'hard', !MARKER_RE.test(final), '殘留 [[NO_DATA 標記');
  add('disclaimer', 'hard', DISCLAIMER_RE.test(final), '結尾缺少「僅供參考」警語');
  if (spec.ground !== false && shownText) {
    const g = findUngrounded(final, shownText);
    const bad = [...(g.numbers || []), ...(g.urls || []), ...(g.terms || [])];
    add('grounded', 'hard', bad.length === 0, `新聞稿裡查不到：${bad.slice(0, 6).join('、')}`);
  }
  for (const s of spec.include || []) add(`include:${s}`, 'hard', final.includes(s), `答案沒有「${s}」`);
  for (const group of spec.include_any || []) add(`include_any:${group[0]}…`, 'hard', group.some((s) => final.includes(s)), `答案沒有其中任何一個：${group.join(' / ')}`);
  for (const s of spec.exclude || []) add(`exclude:${s}`, 'hard', !final.includes(s), `答案不該出現「${s}」`);
  if (spec.expect_no_data) {
    const re = (await loadNoData()).NO_DATA_PHRASE_RE || FALLBACK_NO_DATA_RE;
    add('honest_no_data', 'hard', re.test(body), '資料裡沒有的東西，答案沒有老實說「沒有資料」（可能在編造）');
  }
  if (spec.expect_lang === 'en') add('lang_en', 'hard', cjkRatio(body) < 0.1, '記者用英文問，答案卻是中文');
  if (spec.expect_lang === 'zh') add('lang_zh', 'hard', cjkRatio(body) > 0.3, '記者用中文問，答案卻不是中文');

  // ── 軟性：模型原始輸出（出口會修正，只統計）──
  const rawText = String(raw ?? '');
  add('raw_traditional', 'soft', findResidualSimplified(rawText).length === 0, `模型原始輸出有簡體字：${findResidualSimplified(rawText).join('')}`);
  if (profile === 'line') add('raw_markdown', 'soft', !hasMarkdown(rawText), '模型原始輸出有 Markdown');
  add('raw_marker', 'soft', !MARKER_RE.test(rawText) || !!spec.expect_no_data, '模型原始輸出帶了 [[NO_DATA 標記');

  return { pass: checks.filter((c) => c.level === 'hard').every((c) => c.pass), final, checks };
}
