// lib/industry-trends.js 純函式測試——parseDigestHtml() 用的 fixture 是實測
// https://ieknet.iek.org.tw/iekrpt/DefaultFree.aspx 抓回來的真實原始 HTML 節錄
// （只精簡到 2 則，結構完全比照原文，包含 script/圖片區塊等雜訊，確保 regex
// 真的是對著「頁面裡混著其他東西」的情況解析，不是對著手工簡化過的乾淨片段）。
import {
  parseDigestHtml, formatDigestForPrompt, extractSourceIndices, resolveSourceUrls
} from '../lib/industry-trends.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + detail : ''}`); }
}

// 節錄自實測結果，兩則報告中間夾著跟 buildImageMessages()／parseEventContacts()
// 那種「頁面裡混著其他不相關內容」同樣性質的雜訊（script 區塊、圖片 div）。
const FIXTURE_HTML = `
<div class="listItem row no-gutters">
  <div id="DefaultRandomImg1" class="col-md-1 listImg" data-bg-img-src="https://ieknet.iek.org.tw/assets/img/Z_V.jpg">
    <script type="text/javascript">
      var imageUrlPath ='https://ieknet.iek.org.tw/images/domain/51_';
      var randomImg = '0'+Math.ceil(Math.random()*10)+'.jpg';
    </script>
    <figcaption><span>1</span><hr><small>Free</small></figcaption>
  </div>
  <article class="col-md-11 listText">
    <h2 class="g-font-weight-600"><a href="./rpt_more.aspx?actiontype=rpt&amp;indu_idno=0&amp;domain=51&amp;rpt_idno=720472969" title="IEKView: Supply Chain Restructuring Accelerates">IEKView: Supply Chain Restructuring Accelerates</a></h2><small class="date">2026/08/26</small><p>
      The global machine tool market has undergone a period of adjustment &amp; transformation in recent years.
                          </p>
    <div class="author row"><label class="col-12 jquerySelectorAuthorToLink  text-truncate2">陳佳盟</label></div>
  </article>
</div>
<div class="listItem row no-gutters">
  <div id="DefaultRandomImg2" class="col-md-1 listImg" data-bg-img-src="https://ieknet.iek.org.tw/assets/img/Z_V.jpg">
    <script type="text/javascript">
      var imageUrlPath ='https://ieknet.iek.org.tw/images/domain/28_';
    </script>
    <figcaption><span>2</span><hr><small>Free</small></figcaption>
  </div>
  <article class="col-md-11 listText">
    <h2 class="g-font-weight-600"><a href="./rpt_more.aspx?actiontype=rpt&amp;indu_idno=0&amp;domain=28&amp;rpt_idno=343831942" title="IEK精華包：AI資料中心重塑電力與儲能競爭">IEK精華包：AI資料中心重塑電力與儲能競爭</a></h2><small class="date">2026/08/10</small><p> AI 資料中心的高功率負載正改變電力設備與儲能市場。高耐壓 SiC 推動固態變壓器向更高電壓發展。 </p>
    <div class="author row"><label class="col-12 jquerySelectorAuthorToLink  text-truncate2">IEK產業情報網</label></div>
  </article>
</div>
`;

console.log('── parseDigestHtml：對著真實網站結構節錄解析 ──');
const items = parseDigestHtml(FIXTURE_HTML);
check('解析出 2 則', items.length === 2, JSON.stringify(items.map(i => i.title)));
check('第一則標題正確（英文標題，含冒號）', items[0]?.title === 'IEKView: Supply Chain Restructuring Accelerates', items[0]?.title);
check('第一則日期正確', items[0]?.date === '2026/08/26', items[0]?.date);
check('第一則摘要正確解出、HTML 實體 &amp; 已解碼', items[0]?.abstract.includes('adjustment & transformation'), items[0]?.abstract);
check('第一則網址帶對的 domain／rpt_idno', items[0]?.url === 'https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?actiontype=rpt&indu_idno=0&domain=51&rpt_idno=720472969', items[0]?.url);
check('第二則中文標題正確', items[1]?.title === 'IEK精華包：AI資料中心重塑電力與儲能競爭', items[1]?.title);
check('第二則摘要正確（中文全形標點保留）', items[1]?.abstract.startsWith('AI 資料中心的高功率負載正改變電力設備與儲能市場'), items[1]?.abstract);
check('摘要前後空白已 trim 掉', items[0]?.abstract === items[0]?.abstract.trim(), JSON.stringify(items[0]?.abstract));

console.log('── parseDigestHtml：防呆 ──');
check('空字串 → 空陣列', parseDigestHtml('').length === 0);
check('null → 空陣列（不丟例外）', parseDigestHtml(null).length === 0);
check('完全不相關的 HTML → 空陣列', parseDigestHtml('<html><body>hello</body></html>').length === 0);
{
  const noTitle = FIXTURE_HTML.replace('title="IEKView: Supply Chain Restructuring Accelerates"', 'title=""');
  check('缺標題的項目被跳過，不會塞進空標題', parseDigestHtml(noTitle).length === 1, JSON.stringify(parseDigestHtml(noTitle)));
}

console.log('── formatDigestForPrompt ──');
const prompt = formatDigestForPrompt(items);
check('每則都有編號、日期、標題、摘要', /^1\. \[2026\/08\/26\] IEKView/.test(prompt) && prompt.includes('2. [2026/08/10] IEK精華包'), prompt);
check('空陣列不會噴例外，回空字串', formatDigestForPrompt([]) === '');
check('undefined 不會噴例外', formatDigestForPrompt(undefined) === '');

console.log('── extractSourceIndices：切掉「來源編號」那行，不外洩給記者 ──');
{
  const r = extractSourceIndices('半導體供應鏈正在重組。\n\n來源編號：1');
  check('切掉標記行後的文字正確', r.text === '半導體供應鏈正在重組。', JSON.stringify(r.text));
  check('編號解析正確', JSON.stringify(r.indices) === JSON.stringify([1]), JSON.stringify(r.indices));
}
{
  // 實際回報：記者要求「要提供相關網路連結」——多則、全形冒號、逗號中間有空白都要接得住。
  const r = extractSourceIndices('AI 資料中心正帶動電力設備轉型（8月10日），機械工具市場也在重組（8月26日）。\n來源編號：2, 1');
  check('多則情況：文字正確', r.text === 'AI 資料中心正帶動電力設備轉型（8月10日），機械工具市場也在重組（8月26日）。', r.text);
  check('多則情況：編號依序解析', JSON.stringify(r.indices) === JSON.stringify([2, 1]), JSON.stringify(r.indices));
}
check('沒有指定冒號也接得住（半形/全形都可能出現）',
  JSON.stringify(extractSourceIndices('內容\n來源編號 3').indices) === JSON.stringify([3]));
check('「沒有直接對應的資料」時 AI 不會加這行 → 原樣回傳，不誤判出編號',
  JSON.stringify(extractSourceIndices('目前免費焦點清單裡沒有直接對應的資料。')) ===
  JSON.stringify({ text: '目前免費焦點清單裡沒有直接對應的資料。', indices: [] }));
check('格式不符（AI 沒照格式加，例如漏了「編號」兩字）不會誤切內容',
  extractSourceIndices('這句話剛好提到來源：本週共有 5 篇。').text === '這句話剛好提到來源：本週共有 5 篇。');
check('空字串、undefined 不會噴例外', JSON.stringify(extractSourceIndices(undefined)) === JSON.stringify({ text: '', indices: [] }));

console.log('── resolveSourceUrls：編號換回網址 ──');
const trendItems = [
  { url: 'https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?rpt_idno=1' },
  { url: 'https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?rpt_idno=2' },
  { url: 'https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?rpt_idno=3' }
];
check('單一編號換到對的網址', JSON.stringify(resolveSourceUrls([2], trendItems)) === JSON.stringify([trendItems[1].url]));
check('多個編號依序換好', JSON.stringify(resolveSourceUrls([1, 3], trendItems)) === JSON.stringify([trendItems[0].url, trendItems[2].url]));
check('超出範圍的編號跳過，不會噴例外或塞 undefined', JSON.stringify(resolveSourceUrls([1, 99, 0], trendItems)) === JSON.stringify([trendItems[0].url]));
check('重複編號只留一次', JSON.stringify(resolveSourceUrls([1, 1, 1], trendItems)) === JSON.stringify([trendItems[0].url]));
check('最多附 3 則，不會讓回答後面拖一長串連結', resolveSourceUrls([1, 2, 3, 1, 2], [...trendItems, { url: 'x4' }, { url: 'x5' }]).length === 3);
check('空陣列 → 空陣列', JSON.stringify(resolveSourceUrls([], trendItems)) === JSON.stringify([]));
check('items 是空陣列時不會噴例外', JSON.stringify(resolveSourceUrls([1], [])) === JSON.stringify([]));
check('indices／items 是 undefined 都不會噴例外', JSON.stringify(resolveSourceUrls(undefined, undefined)) === JSON.stringify([]));

console.log(`\n${fail === 0 ? '✅' : '❌'} 產業趨勢清單解析測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
