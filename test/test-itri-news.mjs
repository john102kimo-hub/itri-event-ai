// lib/itri-news.js 純函式測試——fixture 是實測
// https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=06&SiteID=1&MmmID=1036276263153520257
// 抓回來的真實原始 HTML 節錄（只精簡到 2 則，結構完全比照原文，包含 <dt><img>
// 縮圖區塊等雜訊，確保 regex 真的是對著「頁面裡混著其他東西」的情況解析，不是對著
// 手工簡化過的乾淨片段——跟 test-industry-trends.mjs 對 IEK 那邊的做法同一套）。
import { parseNewsListHtml, formatNewsForPrompt } from '../lib/itri-news.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + detail : ''}`); }
}

const FIXTURE_HTML = `
<dl class="Bb_dotted pic_list sline" id="divContent">
    <dt><img src='../WebTools/Thumbnail.ashx?Siteid=1&MmmID=1036276263153520257&fd=NewsLetter_Pics&Pname=CEDC20D5-4EFD-40C8-9A65-D704E080F447_%E5%9C%961_20260901_01.webp' alt='&#26230;&#37832;&#39640;&#23792;&#35542;&#22727;38&#22283;&#33729;&#33521;&#40778;&#32858;'></dt>
                      <dd><a href='ListStyle.aspx?DisplayStyle=01_content&SiteID=1&MmmID=1036276263153520257&MGID=115090116333799036'
                             class='title'>&#26230;&#37832;&#39640;&#23792;&#35542;&#22727;38&#22283;&#33729;&#33521;&#40778;&#32858;&#12288;&#20849;&#31689;AI&#26178;&#20195;&#21322;&#23566;&#39636;&#26032;&#23616;</a>
                          <div class='Lb'><p>日期：2026/09/01</p></div>
                          <p>AI&#37325;&#22609;&#20840;&#29699;&#29986;&#26989;&#29256;&#22294;&#65292;&#21322;&#23566;&#39636;&#25104;&#28858;&#32147;&#28639;&#33287;&#22283;&#23478;&#23433;&#20840;&#38364;&#37749;&#12290;&#32317;&#32113;&#36084;&#28165;&#24503;&#35242;&#33258;&#33950;&#33256;&#35542;&#22727;...</p>
                      </dd>
<dt><img src='../WebTools/Thumbnail.ashx?Siteid=1&MmmID=1036276263153520257&fd=NewsLetter_Pics&Pname=1AA272A8-7A85-4FDF-8A33-AE5BA693DE5C_%E5%9C%96%E4%B8%80_20260827_01.webp' alt='&#31185;&#25216;&#25945;&#32946;'></dt>
                      <dd><a href='ListStyle.aspx?DisplayStyle=01_content&SiteID=1&MmmID=1036276263153520257&MGID=115082712141069729'
                             class='title'>&#31185;&#25216;&#25945;&#32946;&#12288;&#40670;&#20142;&#26410;&#20358;&#12288;&#24037;&#30740;&#38498;&#26234;&#24935;&#29983;&#27963;&#25361;&#25136;&#29151;</a>
                          <div class='Lb'><p>日期：2026/08/27</p></div>
                          <p>&#24037;&#30740;&#38498;&#38263;&#26399;&#25512;&#21205;&#31185;&#25216;&#21521;&#19979;&#26413;&#26681;&#65292;&#38364;&#25079;&#24369;&#21218;&#33287;&#20559;&#37129;&#23416;&#31461;&#65292;&#20170;&#65288;27&#65289;&#26085;&#22312;&#26032;&#31481;&#33289;&#36774;&#12300;2026&#26234;&#24935;&#29983;&#27963;&#25361;&#25136;&#29151;&#12301;...</p>
                      </dd>
</dl>
`;

console.log('── parseNewsListHtml：對著真實網站結構節錄解析 ──');
const items = parseNewsListHtml(FIXTURE_HTML);
check('解析出 2 則', items.length === 2, JSON.stringify(items.map(i => i.title)));
// decodeHtmlEntities() 最後會把連續空白（含全形空格）收成一個半形空格，跟
// lib/industry-trends.js 那邊的摘要解碼同一個行為，這裡不是漏解全形空格。
check('第一則標題正確（全形空格收成半形）', items[0]?.title === '晶鏈高峰論壇38國菁英齊聚 共築AI時代半導體新局', items[0]?.title);
check('第一則日期正確', items[0]?.date === '2026/09/01', items[0]?.date);
check('第一則摘要正確解出', items[0]?.abstract.startsWith('AI重塑全球產業版圖'), items[0]?.abstract);
check('第一則網址是絕對網址、帶對的 MGID', items[0]?.url === 'https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=01_content&SiteID=1&MmmID=1036276263153520257&MGID=115090116333799036', items[0]?.url);
check('第二則標題正確', items[1]?.title === '科技教育 點亮未來 工研院智慧生活挑戰營', items[1]?.title);
check('第二則網址帶對的 MGID', items[1]?.url.endsWith('MGID=115082712141069729'), items[1]?.url);
check('摘要前後空白已 trim 掉', items[0]?.abstract === items[0]?.abstract.trim(), JSON.stringify(items[0]?.abstract));

console.log('── parseNewsListHtml：防呆 ──');
check('空字串 → 空陣列', parseNewsListHtml('').length === 0);
check('null → 空陣列（不丟例外）', parseNewsListHtml(null).length === 0);
check('完全不相關的 HTML → 空陣列（無結果搜尋頁的真實情況，不是錯誤）', parseNewsListHtml('<html><body>搜尋找到: 0 筆資料</body></html>').length === 0);
{
  const noTitle = FIXTURE_HTML.replace("class='title'>&#26230;&#37832;&#39640;&#23792;&#35542;&#22727;38&#22283;&#33729;&#33521;&#40778;&#32858;&#12288;&#20849;&#31689;AI&#26178;&#20195;&#21322;&#23566;&#39636;&#26032;&#23616;</a>", "class='title'></a>");
  check('缺標題的項目被跳過，不會塞進空標題', parseNewsListHtml(noTitle).length === 1, JSON.stringify(parseNewsListHtml(noTitle)));
}
check('超過 10 則也只取前 10 則（避免一次塞太多給 AI）',
  parseNewsListHtml(FIXTURE_HTML.repeat(6)).length === 10, parseNewsListHtml(FIXTURE_HTML.repeat(6)).length);

console.log('── formatNewsForPrompt ──');
const prompt = formatNewsForPrompt(items);
check('每則都有編號、日期、標題、摘要', /^1\. \[2026\/09\/01\] 晶鏈高峰論壇/.test(prompt) && prompt.includes('2. [2026/08/27] 科技教育'), prompt);
check('空陣列不會噴例外，回空字串', formatNewsForPrompt([]) === '');
check('undefined 不會噴例外', formatNewsForPrompt(undefined) === '');

console.log(`\n${fail === 0 ? '✅' : '❌'} 工研院官網新聞解析測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
