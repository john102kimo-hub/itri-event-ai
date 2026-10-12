// 產業趨勢問答的資料來源——IEK 產業情報網（ieknet.iek.org.tw）「免費焦點」清單。
// 這是工研院自己的產業科技國際策略發展所（IEK）對外公開的產業趨勢速覽，不是外部
// 第三方網站；跟本專案其餘部分同一個「零依賴、只用內建 fetch()」原則，不裝 HTML
// 解析套件（cheerio 之類），用 regex 直接從原始 HTML 挖資料，比照 lib/line.js
// buildImageMessages() 那種「輕量字串處理」的既有寫法。
//
// ⚠️ 只抓「免費焦點」清單頁（DefaultFree.aspx），從頭到尾不會、也不能碰到登入後
// 才看得到的完整報告內容。這頁本身就是 IEK 自己公開作為免費導讀的摘要（實測約
// 100 字一段），這剛好符合「回答但不提供完整簡報」的原始需求——不是我們自己另外
// 加一層閹割邏輯，是來源網站本身的免費／付費分界線。真的要看完整分析或安排採訪，
// 導向 events!contacts_directory 裡「產業趨勢分析」這個既有主題的窗口（見
// lib/contacts-directory.js），不在這裡另外寫死聯絡資訊。
//
// 抓一次清單頁大約可以拿到最近 10 篇跨產業別的摘要，刻意不做 indu_idno／domain
// 參數的產業別篩選——這個清單頁本身就橫跨多個產業，IEK 站上 domain 參數對應哪個
// 產業別沒有公開文件可查，猜錯風險比乾脆不篩選、交給 AI 用標題＋摘要去匹配記者
// 的問題還高。v1 先只覆蓋「最近這 10 篇」，之後真的要擴大覆蓋範圍（分產業別分頁
// 抓、抓更多篇）再視情況加。
//
// 頁面結構是實測 IEK 網站目前的原始 HTML 得出的（不是官方文件記載），網站改版時
// parseDigestHtml() 會需要跟著調整——抓取或解析失敗一律回空陣列，不丟例外，呼叫端
// 看到空陣列就知道「這次抓不到資料」，見 fetchIndustryTrendDigest() 的說明。

import { decodeHtmlEntities } from './html-text.js';
import { shortenIekUrl } from './short-link.js';

const IEK_LIST_URL = 'https://ieknet.iek.org.tw/iekrpt/DefaultFree.aspx';
// 批次 130：清單有 253 頁（每頁 10 則、約一個月一頁）。只讀第 1 頁的話，記者問「材料」「能源」這種
// 領域時常常剛好沒有——所以「按關鍵字查」那條路一次抓前 6 頁（約近半年，60 則）。
// 6 頁平行抓，實測跟抓 1 頁一樣是 7～8 秒（慢的是 IEK 的伺服器，不是頁數）。
// ⚠️ 這個站的 domain／indu_idno 參數對這支清單頁**沒有篩選效果**（實測 domain=52 回的跟預設一模一樣），
// 別再試著靠它分領域；只有 currentPageIndex 換頁有用。
const POOL_PAGES = 6;

// 逐項解析「免費焦點」清單頁。每則報告在原始 HTML 裡長這樣（節錄自實測結果）：
//   <a href="./rpt_more.aspx?actiontype=rpt&amp;indu_idno=0&amp;domain=28&amp;rpt_idno=343831942"
//      title="IEK精華包：AI資料中心重塑電力與儲能競爭">IEK精華包：...</a></h2>
//   <small class="date">2026/08/10</small>
//   <p> AI 資料中心的高功率負載正改變電力設備與儲能市場。...（約 100 字摘要）</p>
export function parseDigestHtml(html) {
  const RE = /rpt_more\.aspx\?actiontype=rpt&amp;indu_idno=\d+&amp;domain=(\d+)&amp;rpt_idno=(\d+)"[^>]*title="([^"]*)"[^>]*>[\s\S]{0,300}?<\/a>\s*<\/h2>\s*<small class="date">([^<]*)<\/small>\s*<p>([\s\S]*?)<\/p>/g;
  const items = [];
  let m;
  while ((m = RE.exec(String(html || ''))) && items.length < 15) {
    const [, domain, rptIdno, rawTitle, rawDate, rawAbstract] = m;
    const title = decodeHtmlEntities(rawTitle);
    const abstract = decodeHtmlEntities(rawAbstract);
    const date = String(rawDate || '').trim();
    if (!title || !abstract) continue; // 缺標題或摘要的項目不收，不要餵給 AI 空資料
    items.push({
      title, date, abstract,
      url: `https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?actiontype=rpt&indu_idno=0&domain=${domain}&rpt_idno=${rptIdno}`
    });
  }
  return items;
}

// 抓一次「免費焦點」清單並解析成結構化資料。這支本身不做快取——快取跟這個專案
// 其餘外部資料（events／contacts_directory／line_users）同一個既有模式，統一放在
// api/line.js（見該檔 industryTrendCache 的說明），這支只管「抓＋解析」這一步。
// 抓取或解析失敗（網路問題、網站改版讓 0 筆解析成功…）一律吞掉例外回空陣列，不讓
// 外部網站的問題連累整支 LINE webhook handler 噴例外——記者連基本的「抓不到資料，
// 請洽窗口」都收不到才是真正的問題，呼叫端看到空陣列就知道要走那條退路。
export async function fetchIndustryTrendDigest() {
  try {
    // ⚠️ 逾時（批次 57）：IEKnet 是外部網站，卡住的代價是整支 LINE function 被 Vercel
    // 在 60 秒砍掉、記者連一句話都收不到（見 api/line.js ANSWER_TIMEOUT_MS 的說明）。
    // 逾時會走進下面的 catch → 回空陣列 → 呼叫端老實說「暫時抓不到產業趨勢資料」。
    // ⚠️ 批次 129：原本 10 秒，但 IEK 這頁實測就要 7～9 秒（TTFB 約 6 秒，是它自己慢，不是
    // 我們的問題），差一點點就逾時，記者問「產業趨勢分析」就收到「暫時抓不到」。放寬到 20 秒；
    // 再往上會跟後面問 AI 的 45 秒疊起來撞到 Vercel 的 60 秒上限，所以不再放大。
    const res = await fetch(IEK_LIST_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) throw new Error(`IEK 清單頁回應 ${res.status}`);
    const html = await res.text();
    const items = parseDigestHtml(html);
    if (!items.length) throw new Error('解析出 0 筆，網站結構可能已變更');
    return items;
  } catch (e) {
    console.error('抓取 IEK 產業趨勢清單失敗:', e.message);
    return [];
  }
}

// 組給 AI 看的精簡清單——格式跟 lib/router.js 行事曆清單同一招：一行一則，標題＋
// 日期＋摘要，不給網址（網址留給呼叫端自己組回覆用，AI 不需要知道網址本身）。
export function formatDigestForPrompt(items) {
  return (items || []).map((it, i) => `${i + 1}. [${it.date}] ${it.title}\n　${it.abstract}`).join('\n\n');
}

// 實際回報：問「最近趨勢」拿到回答後，記者要求「要提供相關網路連結」——AI 回覆裡
// 只有日期（而且還是「8月26日」這種轉述過的口語格式，不是原始的「2026/08/26」），
// 完全沒有原文連結，記者沒辦法點進去看完整報告。
//
// 根因：上面 formatDigestForPrompt() 本來就刻意不把網址交給 AI（見那段註解），
// 設計是「AI 只管挑最相關的幾則、用文字回答，網址由呼叫端事後對應回去附上」——
// 但呼叫端（api/line.js answerIndustryTrend()）從來沒把這後半段做完，AI 答完就直接
// 送出去了，於是「網址由呼叫端附上」這句話永遠不會發生。
//
// 補的做法：讓 AI 在回答最後另起一行，用固定格式標出這次引用了清單中第幾則（見
// api/line.js 的 systemPrompt 新增那條指示），這支負責解析、拿掉那一行不讓它外洩到
// 記者看到的文字。格式不符、AI 沒加這行、或那幾則都判成「沒有直接對應的資料」時，
// 一律回空陣列——沒有可信的編號就不附連結，比附錯連結安全（附錯連結記者會直接
// 點進一篇不相關的報告，比乾脆沒有連結更誤導人）。
export function extractSourceIndices(aiReply) {
  const text = String(aiReply || '');
  const m = text.match(/\n*來源編號[:：]?\s*([^\n]*)\s*$/);
  if (!m) return { text, indices: [] };
  const indices = (m[1].match(/\d+/g) || []).map(Number);
  return { text: text.slice(0, m.index).trim(), indices };
}

// 把上面解析到的編號換成清單裡對應項目的網址：編號從 1 開始（對應
// formatDigestForPrompt() 印給 AI 看的編號）、超出範圍或對不到項目的一律跳過、
// 同一則重複引用只留一次，最多 3 則——系統提示要求 AI「先講最相關的 1-2 則」，
// 3 則已經是留了一些餘裕，不會讓一則回答後面拖一長串連結。
export function resolveSourceUrls(indices, items) {
  const seen = new Set();
  const urls = [];
  for (const idx of (indices || [])) {
    const item = (items || [])[idx - 1];
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    urls.push(item.url);
    if (urls.length >= 3) break;
  }
  return urls;
}

// ── 按關鍵字查（批次 130）─────────────────────────────────────────────────────
// 朱朱的要求：按「產業趨勢分析」改成先問「想了解哪個領域？AI、半導體、材料、能源…」，記者打關鍵字，
// 而且**打這些字一定要得到正確答案**。
// 「一定要」不能靠請模型從清單挑（CLAUDE.md 第 2 條：prompt 是請求、不是保證）：模型會漏挑、會說沒有、
// 偶爾還會講到清單以外的東西。所以這條路**不經過模型**——程式用關鍵字在標題＋摘要裡篩，
// 篩到的原樣排出來（標題、日期、IEK 自己的摘要、短網址），篩不到就由程式老實說「這段期間沒有」。
// 答案裡每一個字都來自 IEK 原文，沒有任何「模型覺得」的成分。

// 同一個領域的各種講法 → 篩選用的正規式（比對標題＋摘要）。記者打的字（去空白、轉小寫後）完全等於其中
// 一個別名才算這個領域；對不上的字一律退回「原字串出現在標題或摘要裡」的字面比對，不亂猜。
export const TREND_TOPICS = [
  { name: 'AI', aliases: ['ai', '人工智慧', '生成式ai', 'aigc', 'physicalai'],
    re: /(?<![a-z])ai(?![a-z])|人工智慧|生成式|機器學習|大型語言|算力/i },
  { name: '半導體', aliases: ['半導體', '晶片', 'ic', '先進製程', '封裝', '先進封裝', '記憶體', '化合物半導體'],
    re: /半導體|晶片|晶圓|(?<![a-z])ic(?![a-z])|cpo|記憶體|封裝|製程|矽光|(?<![a-z])sic(?![a-z])|(?<![a-z])gan(?![a-z])/i },
  { name: '材料', aliases: ['材料', '新材料', '先進材料', '化學', '化工', '高分子'],
    re: /材料|化學|化工|銅箔|石化|基板|碳纖維|塑膠|高分子/ },
  { name: '能源', aliases: ['能源', '綠能', '新能源', '再生能源', '淨零', '儲能', '氫能', '減碳', '電力'],
    re: /能源|電力|儲能|氫|淨零|電池|綠電|減碳|太陽能|風電|電網|低碳|碳排|碳中和/ },
  { name: '機器人', aliases: ['機器人', '智慧機器人', '人形機器人', '自動化'],
    re: /機器人|自動化/ },
  { name: '生醫', aliases: ['生醫', '醫療', '醫材', '生技', '健康照護', '智慧醫療', '數位醫療'],
    re: /生醫|醫療|醫材|藥|健康照護|再生醫學|生技|神經調控/ },
  { name: '通訊', aliases: ['通訊', '5g', '6g', '衛星', '衛星通訊', '電信'],
    re: /通訊|(?<![a-z])[56]g(?![a-z])|衛星|ntn|電信/i }
];

const normTrendKw = (kw) => String(kw || '').toLowerCase().replace(/[\s　]+/g, '');

/** 記者打的字是不是上面某個領域的別名；不是回 null。 */
export function trendTopicFor(keyword) {
  const k = normTrendKw(keyword);
  return k ? TREND_TOPICS.find(t => t.aliases.includes(k)) || null : null;
}

/**
 * 在清單裡找跟關鍵字有關的項目。已知領域用正規式，其餘用字面比對。
 * 每個結果多一個 titleHit：標題本身就談到（真正在講這個主題）還是只有摘要順口提到。
 * 實測（真的 IEK 資料）：搜「材料」，歐盟晶片法案、機器人那幾篇只是摘要裡帶過「材料」兩個字，
 * 排在真正講材料的篇目前面就是答非所問——所以標題命中的排前面，各自內部維持新到舊。
 */
export function filterTrendItems(items, keyword) {
  const topic = trendTopicFor(keyword);
  const k = normTrendKw(keyword);
  if (!k) return [];
  const hit = (text) => topic ? topic.re.test(text) : text.toLowerCase().replace(/[\s　]+/g, '').includes(k);
  const out = [];
  for (const it of (items || [])) {
    const titleHit = hit(it.title);
    if (titleHit || hit(it.abstract)) out.push({ ...it, titleHit });
  }
  return [...out.filter(x => x.titleHit), ...out.filter(x => !x.titleHit)];
}

// 按鈕送出的固定句型（跟 itri-news.js newsPickText 同一招）：群組裡別人按也算數，不靠綁在某個人身上的旗標。
//   趨勢關鍵字：半導體      趨勢關鍵字：最新（＝不指定領域，給最新重點）
export const TREND_PICK_RE = /^趨勢關鍵字[:：][ 　]*(.+)$/;
export const TREND_LATEST_WORD = '最新';
export const trendPickText = (keyword) => `趨勢關鍵字：${String(keyword || TREND_LATEST_WORD).trim()}`;
/** 解析上面那種句型；不是回 null。回 { keyword }，keyword 為空字串代表「最新重點」。 */
export function parseTrendPick(text) {
  const m = String(text || '').trim().match(TREND_PICK_RE);
  if (!m) return null;
  const kw = m[1].trim().slice(0, 40);
  return { keyword: kw === TREND_LATEST_WORD ? '' : kw };
}

const MAX_TREND_SHOWN = 3;
const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);

/**
 * 抓前 POOL_PAGES 頁並合併。任何一頁失敗不影響其他頁（只要有一頁成功就回結果），全部失敗回空陣列。
 * 去重（同一篇只留一次）、並丟掉標題與摘要都沒有中文的項目——IEK 有些篇是英文版，
 * 照樣排進中文回覆裡，記者看到整段英文只會困惑；同一個主題通常另有中文版。
 */
export async function fetchIndustryTrendPool(pages = POOL_PAGES) {
  const one = async (n) => {
    try {
      const res = await fetch(`${IEK_LIST_URL}?currentPageIndex=${n}&domain=0&indu_idno=0&actiontype=rpt`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000)
      });
      if (!res.ok) throw new Error(`IEK 清單頁 ${n} 回應 ${res.status}`);
      return parseDigestHtml(await res.text());
    } catch (e) {
      console.error('抓取 IEK 產業趨勢清單失敗:', e.message);
      return [];
    }
  };
  const lists = await Promise.all(Array.from({ length: pages }, (_, i) => one(i + 1)));
  const seen = new Set();
  const out = [];
  for (const it of lists.flat()) {
    if (seen.has(it.url) || !hasCjk(`${it.title}${it.abstract}`)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * 篩到的結果排成回覆文字（純函式，不碰模型）。matched 為空時是誠實的「這段期間沒有」。
 * poolSize／since 只用來讓記者知道「查了多大範圍」，不是裝飾：說「沒有」的時候範圍就是證據。
 */
export function formatTrendReply({ keyword, matched, poolSize, since, contactLine = '' }) {
  if (!matched.length) {
    return `IEK 免費焦點最近的 ${poolSize} 篇（${since} 起）裡，沒有直接談到「${keyword}」的內容。\n\n` +
      '可以換個領域，或換個講法再問我；也可以問工研院自己在這個領域的技術。' + contactLine;
  }
  // 有標題直接談到的，就只列那些；一篇都沒有才退而列「摘要裡有提到」的，並且說清楚是哪一種
  const direct = matched.filter(it => it.titleHit);
  const shown = (direct.length ? direct : matched).slice(0, MAX_TREND_SHOWN);
  const lines = [direct.length
    ? `IEK 免費焦點裡，談到「${keyword}」的最新 ${shown.length} 則：`
    : `IEK 免費焦點裡沒有以「${keyword}」為題的文章，摘要裡有提到的最新 ${shown.length} 則：`];
  shown.forEach((it, i) => {
    lines.push('', `${i + 1}. ${it.title}（${it.date}）`, it.abstract.replace(/\s+/g, ' ').trim(), `🔗 ${shortenIekUrl(it.url)}`);
  });
  if (matched.length > shown.length) {
    lines.push('', direct.length > shown.length
      ? `標題談到的還有 ${direct.length - shown.length} 則，想看更細的話可以打更具體的關鍵字。`
      : `另外有 ${matched.length - shown.length} 則的摘要也有提到，想看更細的話可以打更具體的關鍵字。`);
  }
  lines.push('', '這是 IEK 公開的免費摘要，不是完整報告。');
  return lines.join('\n') + contactLine;
}
