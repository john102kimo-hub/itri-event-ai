// GEO 狀態回覆的文字精簡，以及趨勢圖表 URL 的組法。
//
// 回報的意見：原本的回覆把「啟用引擎」「判官」「CRON_SECRET 未設定」這些內部除錯用
// 的資訊全部倒給同仁看，這支測純函式部分（不碰網路）：formatGeoStatusReply() 精簡後
// 的文字、buildGeoTrendChartUrl() 在各種資料形狀下該不該回傳一個網址。
import { formatGeoStatusReply, buildGeoTrendChartUrl } from '../lib/staff.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

console.log('── formatGeoStatusReply：文字精簡 ──');
const normal = {
  date: '2026-08-27', done: 8, total: 20, remaining: 12,
  engines: [{ id: 'gemini', label: 'Gemini（Google 搜尋接地）', enabled: true }],
  judge: 'gemini / gemini-3.6-flash',
  cronSecretSet: true,
  ready: null
};
const text = formatGeoStatusReply(normal);
check('保留日期與進度', /2026-08-27/.test(text) && /8 \/ 20/.test(text) && /剩 12 題/.test(text), text);
check('不再顯示啟用引擎', !text.includes('啟用引擎'), text);
check('不再顯示判官', !text.includes('判官'), text);
check('不再顯示 CRON_SECRET 這類內部設定', !text.includes('CRON_SECRET'), text);
check('附上 /geo 連結', /itri-event-ai\.vercel\.app\/geo/.test(text), text);

console.log('── formatGeoStatusReply：真的有警訊時要留著 ──');
const withWarning = { ...normal, ready: '尚未設定任何引擎的 API key' };
const warnText = formatGeoStatusReply(withWarning);
check('ready 警訊要顯示出來（這是唯一值得用 ⚠️ 標出來的內部狀態）',
  /⚠️.*尚未設定任何引擎的 API key/.test(warnText), warnText);

console.log('── formatGeoStatusReply：查不到資料時 ──');
const noneText = formatGeoStatusReply(null);
check('查不到資料仍給出可行動的連結，不是一片空白', /itri-event-ai\.vercel\.app\/geo/.test(noneText), noneText);

console.log('── buildGeoTrendChartUrl：正常資料 ──');
const series = {
  series: {
    dates: ['2026-08-14', '2026-08-15', '2026-08-16'],
    overall: { raw: [40, null, 45], ma: [40, 40, 42.5] }
  }
};
const url = buildGeoTrendChartUrl(series);
check('回傳一個 https 開頭的 quickchart.io 網址', /^https:\/\/quickchart\.io\/chart\?/.test(url), url);
check('網址裡帶了資料點（08/14 這種去掉年份的短日期標籤）', decodeURIComponent(url).includes('08/14'), url);
check('用的是 7 日移動平均線（ma），不是原始分數（raw）—— raw 有雜訊，ma 才是「趨勢」',
  decodeURIComponent(url).includes('42.5') && !decodeURIComponent(url).includes('"data":[40,null,45]'), url);
check('URL 沒有帶 ADMIN_PASSWORD 或任何密碼字樣——LINE 的伺服器會直接 GET 這個網址，' +
  '帶密碼等於把後台密碼寫進一個會被快取／轉傳的公開連結',
  !/password/i.test(url), url);

console.log('── buildGeoTrendChartUrl：資料不足時要回 null，不能硬送一張空圖 ──');
check('series 整包是 null', buildGeoTrendChartUrl(null) === null);
check('series.series 缺 dates', buildGeoTrendChartUrl({ series: {} }) === null);
check('dates 是空陣列（功能剛啟用，一次掃描都還沒跑過）',
  buildGeoTrendChartUrl({ series: { dates: [], overall: { ma: [] } } }) === null);
check('ma 全部是 null（有跑過但都失敗，沒有任何有效分數）',
  buildGeoTrendChartUrl({ series: { dates: ['2026-08-14'], overall: { ma: [null] } } }) === null);

console.log('── buildGeoTrendChartUrl：部分缺日也要畫得出來 ──');
const gappy = { series: { dates: ['2026-08-14', '2026-08-15'], overall: { ma: [null, 55] } } };
const gappyUrl = buildGeoTrendChartUrl(gappy);
check('只要有任何一天有分數，就回傳網址（不用整段連續才畫）', typeof gappyUrl === 'string', String(gappyUrl));
check('spanGaps 設定要打開，缺的那天用連線帶過而不是斷開', decodeURIComponent(gappyUrl).includes('"spanGaps":true'), gappyUrl);

console.log(`\n${fail === 0 ? '✅' : '❌'} GEO 圖表測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
