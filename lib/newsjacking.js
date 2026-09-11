// 「今日可借勢話題」— 用 Google News RSS（免費、不用金鑰、不用另外儲值）掃工研院
// 目前在 GEO 追蹤的議題關鍵字，抓過去 48 小時內的相關新聞，給同仁發稿／記者會企劃
// 前先看一眼「現在外面在談什麼」。跟 lib/industry-trends.js／lib/itri-news.js 同一個
// 「零依賴、只用內建 fetch()＋regex」原則——這支解析的是 RSS XML，不是 HTML 列表頁，
// 但前提一樣：抓到的欄位是「值裡不會有巢狀標籤」的單純文字節點，用 regex 逐項取代
// 裝一個 XML parser 套件划算。
//
// 定位刻意很窄，不做成完整版 Muck Rack Newsjacking：這支只吐「候選清單」（標題／
// 連結／來源／時間／符合哪個議題），角度要不要借、風險高不高，交給同仁自己判斷——
// 規則抓得到「這則新聞跟我們在追蹤的哪個關鍵字有關」，抓不到「值不值得借、會不會
// 惹議」，那一半永遠要人判斷，系統不下場猜。
//
// 關鍵字來源刻意不另外維護一份清單，呼叫端（api/geo.js action=newsjack）直接傳
// geo_prompts 目前在追蹤的 keyword 進來——這樣同仁在 GEO 開新議題追蹤時，借勢雷達
// 自動跟著涵蓋到那個議題，不必兩邊分別維護一份「工研院關注領域」清單。

import { decodeHtmlEntities } from './html-text.js';

const RSS_BASE = 'https://news.google.com/rss/search';
const DEFAULT_HOURS = 48;
const MAX_PER_KEYWORD = 8;

function buildUrl(keyword, hours) {
  // Google News 的 when: 語法只吃整數天，取 ceil 讓「48 小時」對到 when:2d
  // （寧可多抓一點點時間範圍，之後靠 publishedAt 精確過濾，好過用 when:1d 漏掉
  // 剛好卡在 24–48 小時之間的新聞）。
  const days = Math.max(1, Math.ceil(hours / 24));
  const q = `${keyword} when:${days}d`;
  const params = new URLSearchParams({ q, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  return `${RSS_BASE}?${params.toString()}`;
}

// 逐項解析 RSS。每則 <item> 節錄自實測結果：
//   <item>
//     <title>半導體業最強擴產潮來了 廠務工程5強訂單塞爆 - 財訊</title>
//     <link>https://news.google.com/rss/articles/....?oc=5</link>
//     <pubDate>Fri, 11 Sep 2026 01:00:00 GMT</pubDate>
//     <source url="https://www.wealth.com.tw">財訊</source>
//   </item>
// 標題習慣長成「標題 - 來源」，來源那段跟 <source> 標籤重複，比對得上就把尾巴
// 「 - 來源名」拿掉讓標題乾淨；比對不上（來源名稱跟標題裡的寫法不完全一樣）就
// 保留原樣，不要用更寬鬆的規則硬砍，砍錯比留著雜訊更誤導人。
export function parseNewsRss(xml) {
  const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
  const items = [];
  let m;
  while ((m = ITEM_RE.exec(String(xml || ''))) && items.length < 30) {
    const block = m[1];
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    const sourceMatch = block.match(/<source url="([^"]*)">([\s\S]*?)<\/source>/);
    if (!rawTitle || !link || !pubDate) continue; // 三個缺一不可，缺任一個這則不可信、寧可跳過

    let title = decodeHtmlEntities(rawTitle);
    const sourceName = sourceMatch ? decodeHtmlEntities(sourceMatch[2]) : '';
    if (sourceName && title.endsWith(` - ${sourceName}`)) {
      title = title.slice(0, -(sourceName.length + 3)).trim();
    }

    const publishedAt = new Date(pubDate);
    items.push({
      title,
      link,
      source: sourceName,
      publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt.toISOString(),
    });
  }
  return items;
}

// 打一次某個關鍵字的 RSS——失敗（非 2xx、fetch 丟例外）一律讓例外往外拋，交給
// fetchNewsjackCandidates() 用 Promise.allSettled 統一接住，單一關鍵字失敗不該
// 拖垮其他關鍵字都查得到的結果。
async function fetchNewsForKeywordOnce(keyword, hours) {
  const res = await fetch(buildUrl(keyword, hours), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Google News RSS 回應 ${res.status}`);
  const xml = await res.text();
  return parseNewsRss(xml);
}

/**
 * @param {string[]} keywords 通常是 geo_prompts 裡目前 active 的 distinct keyword。
 * @param {{ hours?: number, maxPerKeyword?: number }} opts
 * @returns {Promise<{ candidates: Array, failedKeywords: string[] }>}
 *   candidates：依發布時間新到舊排序，同一則新聞符合多個關鍵字時只出現一次，
 *   matchedKeywords 陣列列出全部符合的關鍵字。
 *   failedKeywords：這次查詢失敗的關鍵字（網路問題、Google 那端暫時擋掉），
 *   讓呼叫端可以老實告訴同仁「這幾個議題這次沒查到，不代表沒新聞」，
 *   不要跟「查了、真的沒有符合的新聞」混在一起講。
 */
export async function fetchNewsjackCandidates(keywords, opts = {}) {
  const hours = opts.hours ?? DEFAULT_HOURS;
  const maxPerKeyword = opts.maxPerKeyword ?? MAX_PER_KEYWORD;
  const list = [...new Set((keywords || []).map((k) => String(k || '').trim()).filter(Boolean))];
  if (!list.length) return { candidates: [], failedKeywords: [] };

  const cutoff = Date.now() - hours * 3600 * 1000;
  const settled = await Promise.allSettled(
    list.map((kw) => fetchNewsForKeywordOnce(kw, hours).then((items) => items.slice(0, maxPerKeyword).map((it) => ({ ...it, keyword: kw }))))
  );

  const failedKeywords = [];
  const byLink = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'rejected') { failedKeywords.push(list[i]); return; }
    r.value.forEach((it) => {
      if (!it.publishedAt || new Date(it.publishedAt).getTime() < cutoff) return; // when:Nd 抓得比較寬，這裡才是真正的 48 小時過濾
      const existing = byLink.get(it.link);
      if (existing) {
        if (!existing.matchedKeywords.includes(it.keyword)) existing.matchedKeywords.push(it.keyword);
        return;
      }
      byLink.set(it.link, {
        title: it.title, link: it.link, source: it.source, publishedAt: it.publishedAt,
        matchedKeywords: [it.keyword],
      });
    });
  });

  const candidates = [...byLink.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { candidates, failedKeywords };
}
