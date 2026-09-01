// 「想問什麼技術」問答的資料來源——工研院官網新聞中心（www.itri.org.tw）「最新
// 新聞」清單，支援關鍵字搜尋。這是工研院自己的官網，不是外部第三方網站；跟
// lib/industry-trends.js 同一個「零依賴、只用內建 fetch()」原則，不裝 HTML 解析
// 套件，用 regex 直接從原始 HTML 挖資料。
//
// 動工前先查證網站（用 curl 抓原始 HTML，不是憑空猜規格）：
// - https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=06&SiteID=1&MmmID=1036276263153520257
//   是「新聞中心 > 最新新聞」清單頁，伺服器端直接渲染，無 JS、無防爬蟲機制，跟
//   IEK 那頁同一種「傳統 ASP.NET 頁面」性質。
// - ⚠️ 這頁本身就支援關鍵字搜尋：找到 ../js_page/DisplayStyle06.js 裡「搜尋」按鈕
//   的 click handler，組出來的是 `...&Page=1&keyword=<關鍵字>` 這個 query string
//   （純 GET、伺服器端渲染，不是 AJAX API）——這是實測證實的路徑，不是憑空猜的。
//   這也是「想問什麼技術」這個功能能不能真的答得出東西的關鍵：不能只抓「最新 10
//   篇」（工研院官網橫跨的技術領域太廣，最新 10 篇很難剛好蓋到記者問的那個技術），
//   要能用記者給的技術名稱去查，才有機會查到真的相關的報導。
// - 每頁固定 10 篇（頁尾 lblPageSize 標籤），沒有分頁的必要——跟 industry-trends.js
//   同一個「先求可用，不做深度分頁」的取捨，v1 只看第一頁。
// - 找不到符合關鍵字的新聞是很正常的結果（官網不是每個技術都報導過、也可能是記者
//   打的技術名稱太冷門或打錯字），不是網站壞了——這點刻意跟「抓取失敗」分開處理，
//   見 fetchItriNews() 的說明，呼叫端要能分辨「查無資料」（誠實回答查不到）跟
//   「網站真的連不上」（兩者給記者的話術不一樣）。

import { decodeHtmlEntities } from './html-text.js';

const ITRI_NEWS_BASE = 'https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=06&SiteID=1&MmmID=1036276263153520257';
const SITE_ROOT = 'https://www.itri.org.tw/';

// 逐項解析新聞清單頁——不管是「最新新聞」（不帶 keyword）或搜尋結果（帶 keyword），
// HTML 結構完全一樣，同一支解析。每則新聞在原始 HTML 裡長這樣（節錄自實測結果）：
//   <dd><a href='ListStyle.aspx?DisplayStyle=01_content&SiteID=1&MmmID=...&MGID=115090116333799036'
//          class='title'>晶鏈高峰論壇38國菁英齊聚　共築AI時代半導體新局...</a>
//       <div class='Lb'><p>日期：2026/09/01</p></div>
//       <p>AI重塑全球產業版圖，半導體成為經濟與國家安全關鍵。...（約 100-150 字摘要）</p>
//   </dd>
// href 是相對路徑（沒有 <base> 標籤，直接對頁面自己的網址解析），拼回絕對網址時
// 直接接在網站根目錄後面即可。
export function parseNewsListHtml(html) {
  const RE = /<a href='([^']+)'[^>]*class='title'>([\s\S]*?)<\/a>\s*<div class='Lb'><p>日期：([^<]*)<\/p><\/div>\s*<p>([\s\S]*?)<\/p>/g;
  const items = [];
  let m;
  while ((m = RE.exec(String(html || ''))) && items.length < 10) {
    const [, rawHref, rawTitle, rawDate, rawAbstract] = m;
    const title = decodeHtmlEntities(rawTitle);
    const abstract = decodeHtmlEntities(rawAbstract);
    const date = String(rawDate || '').trim();
    if (!title || !abstract) continue; // 缺標題或摘要的項目不收，不要餵給 AI 空資料
    items.push({ title, date, abstract, url: SITE_ROOT + decodeHtmlEntities(rawHref) });
  }
  return items;
}

// 用記者給的技術名稱當關鍵字查工研院官網新聞中心；不給關鍵字（或空字串）就退回
// 「最新新聞」不篩選——目前呼叫端（api/line.js answerTechQuery()）一定會有關鍵字，
// 這個分支是給之後萬一有「不指定技術、直接看工研院最新動態」需求時的退路，不強迫
// 呼叫端一定要有關鍵字才能用這支。
//
// 回傳 { ok, items }，兩個欄位分開的理由：ok:false（抓取失敗，例如網站連不上、
// 回應非 2xx）代表「這次真的查不到，不確定官網有沒有相關資料」，items 一定是空
// 陣列；ok:true 但 items 是空陣列，代表「網站有回應，就是沒有符合這個關鍵字的
// 報導」——兩種情況呼叫端要講不一樣的話（前者「暫時抓不到資料」，後者「目前沒有
// 直接對應的報導」），不能只看 items.length 混在一起判斷。
export async function fetchItriNews(keyword) {
  const kw = String(keyword || '').trim().slice(0, 60);
  const url = kw ? `${ITRI_NEWS_BASE}&Page=1&keyword=${encodeURIComponent(kw)}` : `${ITRI_NEWS_BASE}&Page=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`工研院官網新聞中心回應 ${res.status}`);
    const html = await res.text();
    return { ok: true, items: parseNewsListHtml(html) };
  } catch (e) {
    console.error('抓取工研院官網新聞失敗:', e.message);
    return { ok: false, items: [] };
  }
}

// 組給 AI 看的精簡清單——格式跟 lib/industry-trends.js formatDigestForPrompt()
// 同一招（兩邊的 items 形狀一樣：title／date／abstract／url），刻意各自維護一份
// 而不是抽出來共用：這支只有一行邏輯，抽成共用模組換來的重複風險比省下的幾行
// 程式碼還大，不像 decodeHtmlEntities() 那樣有多段解析規則值得共用一份。
export function formatNewsForPrompt(items) {
  return (items || []).map((it, i) => `${i + 1}. [${it.date}] ${it.title}\n　${it.abstract}`).join('\n\n');
}
