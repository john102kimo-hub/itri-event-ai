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

const IEK_LIST_URL = 'https://ieknet.iek.org.tw/iekrpt/DefaultFree.aspx';

// 輕量 HTML 實體解碼＋去標籤，只處理摘要／標題欄位實際會出現的幾種。不用正規的
// HTML parser——這兩個欄位是純文字內容，不會有巢狀結構，簡單字串取代就夠用。
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ') // 防呆：摘要段落理論上不會有巢狀標籤，萬一有就拿掉不要整段解析壞掉
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

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
    const res = await fetch(IEK_LIST_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
