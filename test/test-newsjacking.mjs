// lib/newsjacking.js 純函式測試——parseNewsRss() 的 fixture 是實測
// https://news.google.com/rss/search 抓回來的真實原始 XML 節錄（3 則，含中英文
// 標題、來源標籤、標題結尾帶「 - 來源」的 Google News 慣例格式）。
import { parseNewsRss, fetchNewsjackCandidates } from '../lib/newsjacking.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + detail : ''}`); }
}

// 節錄自實測結果（2026/09/11 抓取，關鍵字「半導體」）
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0"><channel><title>"半導體" - Google 新聞</title>
<item><title>半導體業最強擴產潮來了 廠務工程5強訂單塞爆 - 財訊</title><link>https://news.google.com/rss/articles/CBMie0FVX3lxTFBtd25ZbWZMVzUxZ2J0V0tQN1ZrYTNpeE1uWXpybUpkRGF1NjRRVnFFV2N4S1ZHYS0zQzZpNjRMcFk1Q1g5ZUlESlZwaVhGRDFZVm05c1YwZFMxN3NMYnQ5XzZJU0F6bGJUdWc0b3hITEIxR2hGUEtKcDQyYw?oc=5</link><guid isPermaLink="false">abc</guid><pubDate>Fri, 11 Sep 2026 01:00:00 GMT</pubDate><description>&lt;a href="x" target="_blank"&gt;半導體業最強擴產潮來了 廠務工程5強訂單塞爆&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;財訊&lt;/font&gt;</description><source url="https://www.wealth.com.tw">財訊</source></item>
<item><title>Semiconductor Export Curbs Reshape Asia Supply Chains - Reuters</title><link>https://news.google.com/rss/articles/DEF456?oc=5</link><guid isPermaLink="false">def</guid><pubDate>Thu, 10 Sep 2026 14:30:00 GMT</pubDate><description>desc</description><source url="https://www.reuters.com">Reuters</source></item>
<item><title>沒有來源標籤的這則保留原標題</title><link>https://news.google.com/rss/articles/GHI789?oc=5</link><guid isPermaLink="false">ghi</guid><pubDate>Wed, 09 Sep 2026 08:00:00 GMT</pubDate><description>desc</description></item>
</channel></rss>`;

console.log('── parseNewsRss：對著真實 RSS 結構節錄解析 ──');
const items = parseNewsRss(FIXTURE_XML);
check('解析出 3 則', items.length === 3, JSON.stringify(items.map((i) => i.title)));
check('第一則標題已去掉「 - 財訊」尾巴', items[0]?.title === '半導體業最強擴產潮來了 廠務工程5強訂單塞爆', items[0]?.title);
check('第一則來源正確', items[0]?.source === '財訊', items[0]?.source);
check('第一則發布時間轉成 ISO', items[0]?.publishedAt === new Date('Fri, 11 Sep 2026 01:00:00 GMT').toISOString(), items[0]?.publishedAt);
check('第二則英文標題正確去掉「 - Reuters」尾巴', items[1]?.title === 'Semiconductor Export Curbs Reshape Asia Supply Chains', items[1]?.title);
check('第三則沒有 <source> 標籤時來源是空字串、標題保留原樣', items[2]?.source === '' && items[2]?.title === '沒有來源標籤的這則保留原標題', JSON.stringify(items[2]));

console.log('── parseNewsRss：防呆 ──');
check('空字串 → 空陣列', parseNewsRss('').length === 0);
check('null → 空陣列（不丟例外）', parseNewsRss(null).length === 0);
check('完全不相關的 XML → 空陣列', parseNewsRss('<rss><channel></channel></rss>').length === 0);
{
  const noLink = FIXTURE_XML.replace('<link>https://news.google.com/rss/articles/CBMie0FVX3lxTFBtd25ZbWZMVzUxZ2J0V0tQN1ZrYTNpeE1uWXpybUpkRGF1NjRRVnFFV2N4S1ZHYS0zQzZpNjRMcFk1Q1g5ZUlESlZwaVhGRDFZVm05c1YwZFMxN3NMYnQ5XzZJU0F6bGJUdWc0b3hITEIxR2hGUEtKcDQyYw?oc=5</link>', '');
  check('缺 <link> 的項目被跳過', parseNewsRss(noLink).length === 2, JSON.stringify(parseNewsRss(noLink).map((i) => i.title)));
}
{
  const badDate = FIXTURE_XML.replace('Fri, 11 Sep 2026 01:00:00 GMT', '不是日期');
  check('pubDate 格式壞掉時 publishedAt 是 null、不丟例外', parseNewsRss(badDate)[0]?.publishedAt === null);
}

console.log('── fetchNewsjackCandidates：跨關鍵字合併／去重／時間過濾（fetch 打樁）──');
{
  const realFetch = global.fetch;
  const now = new Date('2026-09-11T02:00:00Z');
  // 兩個關鍵字都掃到同一則新聞（同一個 link）＋各自一則獨有的，外加一則超過 48
  // 小時的舊新聞應該被濾掉。
  const xmlFor = (kw) => {
    if (kw === '半導體') {
      return `<rss><channel>
        <item><title>共同新聞 A - 來源X</title><link>https://x/common</link><pubDate>${new Date(now.getTime() - 3600e3).toUTCString()}</pubDate><source url="https://x">來源X</source></item>
        <item><title>半導體獨有新聞 - 來源Y</title><link>https://x/semi-only</link><pubDate>${new Date(now.getTime() - 5 * 3600e3).toUTCString()}</pubDate><source url="https://x">來源Y</source></item>
        <item><title>過期新聞（超過48小時）- 來源Z</title><link>https://x/stale</link><pubDate>${new Date(now.getTime() - 72 * 3600e3).toUTCString()}</pubDate><source url="https://x">來源Z</source></item>
      </channel></rss>`;
    }
    if (kw === '淨零碳排') {
      return `<rss><channel>
        <item><title>共同新聞 A - 來源X</title><link>https://x/common</link><pubDate>${new Date(now.getTime() - 3600e3).toUTCString()}</pubDate><source url="https://x">來源X</source></item>
        <item><title>淨零獨有新聞 - 來源W</title><link>https://x/net-zero-only</link><pubDate>${new Date(now.getTime() - 2 * 3600e3).toUTCString()}</pubDate><source url="https://x">來源W</source></item>
      </channel></rss>`;
    }
    if (kw === '會查詢失敗的關鍵字') throw new Error('模擬網路失敗');
    return '<rss><channel></channel></rss>';
  };
  global.fetch = async (url) => {
    // URLSearchParams 用 '+' 編碼空白（不是 %20），decodeURIComponent 不會把 '+' 轉回
    // 空白（那是 application/x-www-form-urlencoded 的規則），這裡自己補這一步。
    const raw = decodeURIComponent(String(url).match(/q=([^&]+)/)[1]).replace(/\+/g, ' ');
    const kw = raw.split(' when:')[0];
    if (kw === '會查詢失敗的關鍵字') return { ok: false, status: 500 };
    return { ok: true, text: async () => xmlFor(kw) };
  };

  const realDateNow = Date.now;
  Date.now = () => now.getTime();
  const { candidates, failedKeywords } = await fetchNewsjackCandidates(
    ['半導體', '淨零碳排', '會查詢失敗的關鍵字', '半導體'], // 重複關鍵字也要能處理
    { hours: 48 }
  );
  Date.now = realDateNow;
  global.fetch = realFetch;

  check('查詢失敗的關鍵字被記在 failedKeywords，不影響其他關鍵字', JSON.stringify(failedKeywords) === JSON.stringify(['會查詢失敗的關鍵字']), JSON.stringify(failedKeywords));
  check('超過 48 小時的新聞被濾掉，剩 3 則不重複的', candidates.length === 3, JSON.stringify(candidates.map((c) => c.link)));
  check('依發布時間新到舊排序', candidates[0].link === 'https://x/common' && candidates[1].link === 'https://x/net-zero-only' && candidates[2].link === 'https://x/semi-only', JSON.stringify(candidates.map((c) => c.link)));
  const common = candidates.find((c) => c.link === 'https://x/common');
  check('同一則新聞符合兩個關鍵字時只出現一次，matchedKeywords 併起來', JSON.stringify(common?.matchedKeywords.sort()) === JSON.stringify(['半導體', '淨零碳排']), JSON.stringify(common));
}

check('關鍵字空陣列 → 空結果，不會噴例外或亂打 fetch', JSON.stringify(await fetchNewsjackCandidates([])) === JSON.stringify({ candidates: [], failedKeywords: [] }));
check('undefined → 空結果', JSON.stringify(await fetchNewsjackCandidates(undefined)) === JSON.stringify({ candidates: [], failedKeywords: [] }));

console.log(`\n${fail === 0 ? '✅' : '❌'} 今日可借勢話題測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
