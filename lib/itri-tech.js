// 「問技術與洽案」的資料來源——工研院官網「產業服務 > 技術合作」（批次 121）。
//
//   https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=13&SiteID=1&MmmID=1036233405427625204
//
// 這頁是工研院自己放給記者與有興趣的廠商看的技術清單（上千項），官網上有「六大技術領域」下拉與關鍵字搜尋。
// 跟 lib/itri-news.js 同一個「零依賴、只用內建 fetch()、regex 挖原始 HTML」原則。動工前用 curl 對真的官網實測過：
// - 清單頁伺服器端直接渲染，每頁 10 項，只有技術名稱與編號（Trt_idx）；簡介與聯絡人要再打每一項自己的內容頁
//   （DisplayStyle=13_content&…&Trt_idx=編號）。所以一頁要 1 + N 次請求，N 項同時打、各自有逾時。
// - 領域與關鍵字都是純 GET：&keyword2=<領域代碼>&keyword=<關鍵字>&Page=<頁>（官網「搜尋」按鈕的 JS 就是這樣組的）。
//   領域代碼來自 /api/WebRoot005_DisplayStyle13_Select（B／C／D／E／F／N 六個）。
// - 總數在頁尾隱藏的 lblDataSum；沒有符合的是 0 筆、不是錯誤。
// - 內容頁的聯絡資訊長這樣：「聯絡人：曾謙順 低碳與儲能技術組」「電話：… 或 Email：xxx＠itri.org.tw」
//   ⚠️ 官網的 @ 是**全形＠**（U+FF20），直接貼出去記者複製下來寄不出信——一定要換成半形。
//   只給「名字＋信箱」（朱朱的要求）：電話、組別不放。
// - 簡介偶爾是 none（官網欄位沒填），要退到「技術特色」「應用範圍」，都沒有就老實不放，不能編。
//
// ⚠️ 官網自己的領域標記有些新上架的技術並不貼切（例如最新幾筆掛在「通訊與光電」下的是道路刨除料循環）。
// 我們照官網的篩選結果呈現，不自己重新分類——重分類就是在替工研院決定技術屬於哪個領域。

import { decodeHtmlEntities } from './html-text.js';
import { shortTechUrl, TECH_MMM_ID } from './short-link.js';
import { toTraditionalTW } from './zh-tw.js';

const LIST_BASE = `https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=13&SiteID=1&MmmID=${TECH_MMM_ID}`;
const DETAIL_BASE = `https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=13_content&SiteID=1&MmmID=${TECH_MMM_ID}&Trt_idx=`;
export const TECH_PAGE_SIZE = 5;       // 一則 LINE 訊息放幾項（官網一頁 10 項，我們切成兩則）
const SITE_PAGE_SIZE = 10;
const LIST_TIMEOUT_MS = 10_000;
const DETAIL_TIMEOUT_MS = 7_000;       // 每次嘗試；失敗再試一次
const DETAIL_DEADLINE_MS = 15_000;     // 一項的總時限：官網慢的時候不能讓整頁一起等，逾時那項只留名稱與連結
const CACHE_TTL_MS = 30 * 60_000;
const INTRO_MAX = 90;

// 六大技術領域。name 是按鈕與回覆上顯示的簡稱（官網全名見 full）；code 是官網篩選用的代碼。
export const TECH_DOMAINS = [
  { code: 'B', name: '通訊與光電', icon: '📡', full: '通訊與光電(資訊與通訊/電子與光電)' },
  { code: 'C', name: '機械與系統', icon: '⚙️', full: '機械與系統' },
  { code: 'D', name: '材料與化工', icon: '🧪', full: '材料化工與奈米-材料與化工' },
  { code: 'E', name: '生醫與醫材', icon: '🧬', full: '生醫與醫材' },
  { code: 'F', name: '綠能與環境', icon: '🌱', full: '綠能與環境' },
  { code: 'N', name: '奈米科技', icon: '🔬', full: '材料化工與奈米-奈米科技' }
];
export const domainByName = (name) => TECH_DOMAINS.find(d => d.name === String(name || '').trim()) || null;
/** 記者打的字剛好就是某個領域（「生醫與醫材」「綠能與環境」，或官網全名）→ 回那個領域，否則 null。 */
export function domainFromText(text) {
  const s = String(text || '').replace(/[\s　]/g, '');
  if (!s) return null;
  return TECH_DOMAINS.find(d => s === d.name || s === d.full.replace(/\s/g, '')) || null;
}

// ── 按鈕送出的固定句型（跟「邀訪：ＸＸ」同一招）────────────────────────────────
// 要能被規則認出來、群組裡別人按也算數、記者自己照格式打也一樣，所以是固定格式。
//   技術領域：綠能與環境        技術領域：綠能與環境 第2頁
//   技術關鍵字：電池            技術關鍵字：電池 第2頁
export const TECH_PICK_RE = /^技術(領域|關鍵字)[:：][ 　]*(.+?)(?:[ 　]+第[ 　]*(\d{1,3})[ 　]*頁)?$/;
export function techPickText({ domain, keyword, page = 1 } = {}) {
  const base = domain ? `技術領域：${domain.name}` : `技術關鍵字：${String(keyword || '').trim()}`;
  return page > 1 ? `${base} 第${page}頁` : base;
}
/** 解析上面那種句型；不是回 null。領域名稱對不上六個之一時，當成關鍵字查（不會因為多打一個字就整個沒反應）。 */
export function parseTechPick(text) {
  const m = String(text || '').trim().match(TECH_PICK_RE);
  if (!m) return null;
  const page = Math.min(Math.max(Number(m[3] || 1), 1), 200);
  const value = m[2].trim();
  if (m[1] === '領域') {
    const domain = domainByName(value) || domainFromText(value);
    if (domain) return { domain, keyword: '', page };
  }
  return { domain: null, keyword: value.slice(0, 40), page };
}

// ── 解析 ────────────────────────────────────────────────────────────────────
export function parseTechListHtml(html) {
  const s = String(html || '');
  const items = [];
  const RE = /<li><a href='[^']*Trt_idx=(\d+)'>([\s\S]*?)<\/a><\/li>/g;
  let m;
  while ((m = RE.exec(s)) && items.length < SITE_PAGE_SIZE) {
    const title = decodeHtmlEntities(m[2]);
    if (title) items.push({ id: m[1], title });
  }
  const total = Number((s.match(/id="lblDataSum"[^>]*>\s*(\d+)/) || [])[1] || 0);
  return { items, total };
}

const NO_VALUE_RE = /^(none|null|n\/a|無|—|-)?$/i;
function sectionText(html, heading) {
  const re = new RegExp(`<h4>\\s*${heading}\\s*</h4>\\s*<p>([\\s\\S]*?)</p>`, 'i');
  const t = decodeHtmlEntities((String(html).match(re) || [])[1] || '');
  return NO_VALUE_RE.test(t) ? '' : t;
}
/** 簡介太長就在句子結尾附近收掉，不要硬砍在字中間。 */
export function shortenIntro(text, max = INTRO_MAX) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'));
  return (stop >= max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/[，、,\s]+$/, '') + '…');
}

export function parseTechDetailHtml(html) {
  const s = String(html || '');
  const title = decodeHtmlEntities((s.match(/id="spanTitle">([\s\S]*?)<\/span>/) || [])[1] || '');
  const intro = sectionText(s, '技術簡介') || sectionText(s, '技術特色') || sectionText(s, '應用範圍');
  const block = (s.match(/<h4>\s*聯絡資訊\s*<\/h4>([\s\S]*?)(?:<\/div>|$)/) || [])[1] || '';
  // 名字只取「聯絡人：」後面第一段（後面接的是組別，不要）
  const nameLine = (block.match(/聯絡人[:：]([^<]*)/) || [])[1] || '';
  const contactName = decodeHtmlEntities(nameLine).split(/\s+/)[0] || '';
  // 信箱：官網寫全形＠，換成半形；只收長得像信箱的，其餘寧可不放
  const mail = (decodeHtmlEntities((block.match(/Email[:：]([^<]*)/i) || [])[1] || '')
    .replace(/[＠@]/g, '@').replace(/[\s　]/g, '')).replace(/[。，,;；]+$/, '');
  const email = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(mail) ? mail : '';
  return { title, intro: shortenIntro(intro), contactName, email };
}

// ── 抓取 ────────────────────────────────────────────────────────────────────
const cache = new Map();
async function fetchText(url, timeoutMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.html;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`工研院官網產業服務回應 ${res.status}`);
  const html = await res.text();
  if (cache.size > 300) cache.clear();
  cache.set(url, { html, at: Date.now() });
  return html;
}
export function __clearTechCache() { cache.clear(); }

function listUrl({ domain, keyword, sitePage }) {
  let u = LIST_BASE;
  if (keyword) u += `&keyword=${encodeURIComponent(keyword)}`;
  if (domain) u += `&keyword2=${domain.code}`;
  return `${u}&Page=${sitePage}`;
}


// 一項技術的簡介與聯絡人。單一項失敗（或超過總時限）不影響其他項：那一項只留名稱與連結，點進去官網自己看得到全部。
async function fetchTechItem(it) {
  const bare = { id: it.id, title: it.title, intro: '', contactName: '', email: '', url: shortTechUrl(it.id) };
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(bare), DETAIL_DEADLINE_MS); });
  const work = (async () => {
    try {
      // 同時 5 個請求偶爾有一個卡住（實測過）：失敗就再試一次，兩次都失敗才只留名稱與連結
      const html = await fetchText(DETAIL_BASE + it.id, DETAIL_TIMEOUT_MS).catch(() => fetchText(DETAIL_BASE + it.id, DETAIL_TIMEOUT_MS));
      const d = parseTechDetailHtml(html);
      return { ...bare, intro: d.intro, contactName: d.contactName, email: d.email };
    } catch (e) {
      console.error(`抓取技術 ${it.id} 內容頁失敗:`, e.message);
      return bare;
    }
  })();
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

/**
 * 取一頁（5 項）技術，附簡介與聯絡人。
 * 回 { ok, total, items:[{id,title,intro,contactName,email,url}], page, hasMore }。
 * ok:false＝官網連不上（呼叫端要說「暫時抓不到」）；ok:true 而 items 空＝官網有回應、只是沒有符合的。
 * 單一項目的內容頁抓失敗不影響其他項：那一項只留名稱與連結（連結點進去官網自己看得到全部）。
 */
export async function fetchTechPage({ domain = null, keyword = '', page = 1 } = {}) {
  const kw = String(keyword || '').trim().slice(0, 40);
  const pageNo = Math.max(1, Math.floor(page) || 1);
  const sitePage = Math.ceil(pageNo / 2);
  const offset = ((pageNo - 1) % 2) * TECH_PAGE_SIZE;
  try {
    // 清單頁偶爾第一次連不上（實測過一次 10 秒逾時、馬上再打就 3 秒回來）：失敗再試一次，兩次都失敗才算官網連不上
    const url = listUrl({ domain, keyword: kw, sitePage });
    const { items: all, total } = parseTechListHtml(await fetchText(url, LIST_TIMEOUT_MS).catch(() => fetchText(url, LIST_TIMEOUT_MS)));
    const slice = all.slice(offset, offset + TECH_PAGE_SIZE);
    const items = await Promise.all(slice.map((it) => fetchTechItem(it)));
    return { ok: true, total, items, page: pageNo, hasMore: pageNo * TECH_PAGE_SIZE < total };
  } catch (e) {
    console.error('抓取工研院官網產業服務失敗:', e.message);
    return { ok: false, total: 0, items: [], page: pageNo, hasMore: false };
  }
}

// ── 回覆文字（程式組，不經過模型）──────────────────────────────────────────
// 技術名稱、簡介、聯絡人、連結一個字都不能錯（尤其信箱與網址），所以全部是程式照官網的字排出來，模型不碰。
// 出口照 CLAUDE.md 第 1 條接上繁體防線——官網的字本來就是繁體，這裡擋的是萬一哪天官網混進簡體。
export function formatTechReply({ items, total, page, label }) {
  const from = (page - 1) * TECH_PAGE_SIZE + 1;
  const to = from + items.length - 1;
  const lines = [`🔬 工研院技術｜${label}（共 ${total} 項，第 ${from}–${to} 項）`];
  items.forEach((it, i) => {
    lines.push('', `${from + i}. ${it.title}`);
    if (it.intro) lines.push(`簡介：${it.intro}`);
    if (it.contactName || it.email) lines.push(`聯絡人：${[it.contactName, it.email].filter(Boolean).join('　')}`);
    lines.push(`🔗 ${it.url}`);
  });
  lines.push('', '想洽談合作或技術授權，直接寫信給上面的聯絡人就可以；找不到合適的，打「找真人」。');
  return toTraditionalTW(lines.join('\n'));
}
