// 批次 132：記者端答案的「數字、網址、英文名詞」出口檢查（影子模式）。
//   lib/answer-grounding.js 的純函式單元測試，加上離線回測工具 tools/grounding-backtest/ 的驗收。
//
// 這支測試分兩半，第二半跟第一半一樣重要（跟 test-zhtw.mjs 同一個結構）：
//   ① 編造的數字、網址、英文名詞要被標出來
//   ② **正確的答案不能被標出來**——這種檢查最大的風險不是漏抓，是誤報：中文數字與阿拉伯數字互換、
//      千分位、全形、日期寫法不同、條列編號、警語，只要有一種誤報，記者每天都會看到「查不到」的提醒。
//   ③ 影子模式：不改任何回覆（note 一律空字串）、log 不含答案全文，檢查自己壞掉也不能害記者收不到答案。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkAnswerGrounding, findUngrounded, groundingMode, normalizeForGrounding, cnIntToDecimal,
  extractNumbers, extractUrls, extractTerms, stripDisclaimer, buildGroundingNote, SMALL_COUNT_MAX
} from '../lib/answer-grounding.js';
import { toTraditionalTW } from '../lib/zh-tw.js';
import { stripMarkdownForLine } from '../lib/line-format.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const J = (v) => JSON.stringify(v);

// 攔截 console.log：驗證「記了什麼」「沒記什麼」。跑完一定還原。
function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  try { return { value: fn(), logs }; } finally { console.log = orig; }
}
function withMode(mode, fn) {
  const prev = process.env.ANSWER_GROUNDING;
  if (mode === undefined) delete process.env.ANSWER_GROUNDING; else process.env.ANSWER_GROUNDING = mode;
  try { return fn(); } finally { if (prev === undefined) delete process.env.ANSWER_GROUNDING; else process.env.ANSWER_GROUNDING = prev; }
}
// 純比對（不看環境變數、不記 log）：來源 src 裡沒有的東西
const g = (answer, source) => findUngrounded(answer, source);
const nums = (answer, source) => g(answer, source).numbers;
const terms = (answer, source) => g(answer, source).terms;
const clean = (answer, source) => { const r = g(answer, source); return !r.numbers.length && !r.urls.length && !r.terms.length; };

// 那些在原始碼裡看不見的字元，用碼位組出來（不要把不可見字元寫進測試檔）
const ch = (...codes) => String.fromCodePoint(...codes);

/* ───────── 一、正規化 ───────── */
console.log('\n── 一、正規化：全形、千分位、破折號 ──');
check('全形數字、％、逗號轉半形，千分位逗號去掉', normalizeForGrounding('成長５０％，共３，０００人') === '成長50%,共3000人', normalizeForGrounding('成長５０％，共３，０００人'));
check('千分位只去「逗號後剛好三位數字」的：2024,2025 與 1,2,3 原樣', normalizeForGrounding('2024,2025 與 1,2,3 與 1,234,567') === '2024,2025 與 1,2,3 與 1234567');
check('各種破折號（en dash、em dash、減號、不斷行連字號）統一成 -',
  normalizeForGrounding(`2020${ch(0x2013)}2025 ${ch(0x2014)} ${ch(0x2212)}3 Wi${ch(0x2011)}Fi`) === '2020-2025 - -3 Wi-Fi');
check('波浪號與零寬字元', normalizeForGrounding(`3${ch(0x301C)}5${ch(0x200B)}倍`) === '3~5倍');
check('null／undefined 回空字串，非字串轉成字串', normalizeForGrounding(null) === '' && normalizeForGrounding(undefined) === '' && normalizeForGrounding(123) === '123');

/* ───────── 二、中文數字轉換 ───────── */
console.log('\n── 二、中文數字 → 阿拉伯數字 ──');
for (const [cn, want] of [
  ['三千', '3000'], ['十二', '12'], ['二〇二六', '2026'], ['一百零五', '105'], ['三萬五千', '35000'],
  ['一億兩千萬', '120000000'], ['十萬', '100000'], ['兩千', '2000'], ['一萬億', '1000000000000'], ['二十三', '23']
]) check(`${cn} → ${want}`, cnIntToDecimal(cn) === want, cnIntToDecimal(cn));
check('看不懂的回 null（不丟例外）', cnIntToDecimal('三a') === null);

/* ───────── 三、數字：不能誤報 ───────── */
console.log('\n── 三、數字：同一個數字換個寫法，不能誤報 ──');
check('來源「三千人」、答案「3,000 人」', clean('現場有 3,000 人', '預計三千人參加'));
check('反方向：來源「3,000 人」、答案「三千人」', clean('現場有三千人', '預計 3,000 人參加'));
check('千分位有無：3,000 ↔ 3000，單位換字（人 → 名）', clean('現場有 3,000 名', '預計 3000 人參加'));
check('全形：來源「３，０００人」', clean('3000 人', '預計３，０００人'));
check('百分比：30%、30％、百分之三十、三成互通', clean('成長 30%、約三成、百分之三十', '成長 30％') && clean('成長 30%', '成長百分之三十') && clean('成長 30%', '佔三成'));
check('億：100 億元、100億、100 億互通；10000 萬＝1 億', clean('產值 100 億', '產值 100億元') && clean('1 億元', '資本 10000萬') && clean('100 億元', '產值 100 億'));
check('1.2 億 ↔ 120,000,000（小數量級不走浮點數）', clean('120,000,000 元', '經費 1.2 億元') && clean('一億兩千萬元', '經費 1.2 億元'));
check('三萬五千 ↔ 35,000；兩千 ↔ 2,000', clean('三萬五千人', '35,000 人') && clean('2,000 家', '兩千家'));
check('兩倍 ↔ 2 倍', clean('2 倍', '兩倍') && clean('兩倍', '成長 2 倍'));
check('小數 3.50% ↔ 3.5%', clean('3.5%', '成長 3.50%'));
check('日期：來源「2026年10月28日」，答案「10/28」「28 日」', clean('10/28 與 28 日', '2026年10月28日'));
check('日期：來源「2026-10-28」，答案「2026 年 10 月 28 日」', clean('2026 年 10 月 28 日', '活動日期：2026-10-28'));
check('日期：來源「2026.10.28」拆成三個數字', clean('2026 年 10 月', '日期 2026.10.28'));
check('民國年與西元年互通', clean('2026 年', '民國 115 年') && clean('115 年', '2026 年'));
check('範圍 3–5 拆開各自比：來源「3~5 倍」', clean('3 至 5 倍', '效能 3~5 倍'));
check('範圍：來源分開寫 3 倍與 5 倍，答案「3-5 倍」', clean('3-5 倍', '成長 3 倍與 5 倍'));
check('範圍：後面的單位／量級一起繼承（30–50 億＝30 億、50 億）', clean('30–50 億', '30 億到 50 億'));
check('　 繼承讓前一個數字也被查：來源只有「30 家」，答案「20-30 家」→ 標出 20 家；來源只有「5 億」，答案「3-5 億」→ 標出 3 億',
  J(nums('20-30 家', '共 30 家')) === J(['20 家']) && J(nums('3-5 億', '預估 5 億')) === J(['3 億']), J([nums('20-30 家', '共 30 家'), nums('3-5 億', '預估 5 億')]));
check('　 來源的範圍也繼承：來源「30–50 億」，答案「30 億」「50 億」都對得上', clean('30 億', '成長 30–50 億') && clean('50 億', '成長 30–50 億'));
check('小數整串比：來源有「5.5」，答案「5.5」', clean('版本 5.5', '版本 5.5 發布'));
check('分機、電話：來源有就過', clean('分機 31234，電話 02-2777-3111', '聯絡 02-2777-3111 分機 31234'));
check('條列編號 1. 2. 3.、時刻 14:30、Q3 不查', clean('1. 甲\n2. 乙\n3. 丙\n14:30 開始，Q3 公布', '無數字'));
check('序數與編號：第 3 項、前 5 名、第 12 名、第 100 名、No.1、Top 10 不查', nums('第 3 項、前 5 名、第 12 名、第 100 名、No.1、Top 10', '無').length === 0);
check('中文裡「某一個」與慣用語不是數量：統一、四足、二氧化碳、一項、一家、第一、數十家、幾千人', clean('統一規格、四足機器人、二氧化碳、一項技術、一家公司、第一名、數十家、幾千人、三星', '無'));
check('黏在英文字母後面的是名詞不是數字：H100、HBM3E、GPT4、5G', clean('H100 與 HBM3E 與 GPT4 與 5G', 'H100 HBM3E GPT4 5G'));
check('　 型號裡的數字不另外當數字查（交給英文名詞那一關）：來源沒有 A100，只標出 A100 這個名詞', nums('採用 A100 與 HBM3E', '無').length === 0 && J(terms('採用 A100 與 HBM3E', '無')) === J(['A100', 'HBM3E']));
check('中文「一」開頭的不是數量：一年內、一倍、一天、一度', nums('一年內、一倍、一天、一度', '無').length === 0);
check('警語不查（中文）：警語裡的字不當疑點', clean('晶片已發表。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。', '晶片已發表'));
check('警語不查（簡體漏網也一樣）', clean('晶片已發表。\n\n内容仅供参考，以工研院官网新闻稿或发言为准。', '晶片已發表'));
check('警語不查（英文版）：中文答案後面接英文警語', clean('晶片已發表。\n\nFor reference only; please confirm with the official press release or spokesperson.', '晶片已發表'));
check('「共 N 位」這種自己數出來的小計不查（≤ 20）：共 5 位、共有 15 家、共十二項', clean('共 5 位講者、共有 15 家、共十二項', '無'));
check('整數 ≤ 10 的計數類不查（三位講者、五家廠商、3 位），邊界值 SMALL_COUNT_MAX = 10', SMALL_COUNT_MAX === 10 && clean('三位講者、五家廠商、3 位、10 家', '無'));

console.log('\n── 三之二、數字：編造的要標出來 ──');
check('編造的年份、金額、家數、電話都被標出', J(nums('預計 2028 年量產，年產值 500 億元，約 80 家廠商，專線 0800-123-456。', '預計 2027 年量產，產值 100 億元，超過 40 家廠商洽談。'))
  === J(['2028 年', '500 億元', '80 家', '0800-123-456']), J(nums('預計 2028 年量產，年產值 500 億元，約 80 家廠商，專線 0800-123-456。', '預計 2027 年量產，產值 100 億元，超過 40 家廠商洽談。')));
check('11 位以上的計數要查；「共」開頭的小計也只放過 ≤ 20 的：11 位、共 25 家', J(nums('有 11 位講者，共 25 家', '無')) === J(['11 位', '25 家']), J(nums('有 11 位講者，共 25 家', '無')));
check('分機錯一碼就標出', J(nums('分機 31235', '分機 31234')) === J(['31235']));
check('小數、版本號整串比：來源只有「5 個」「5 月」，答案「5.5」要標出，不會拆成 5 就放過', J(nums('版本 5.5', '共有 5 個，5 月')) === J(['5.5']));
check('版本號 1.2.3 對 1.2.4 要標出', J(nums('版本 1.2.3', '版本 1.2.4')) === J(['1.2.3']));
check('範圍的上限編造：來源 3 倍與 5 倍，答案 3-9 倍 → 標出 9 倍', J(nums('3-9 倍', '成長 3 倍與 5 倍')) === J(['9 倍']));
check('單位類別不同要標出：來源「30 年」、答案「30 家」、「30%」', J(nums('30 家', '成長 30 年')) === J(['30 家']) && J(nums('30%', '共 30 人')) === J(['30%']));
check('單位類別相同、換個字不標：人↔名、元、年↔年', clean('30 名', '30 人') && clean('3000 元', '3,000 元'));
check('來源沒寫單位的數字什麼類別都對得上；答案沒寫單位只比數值', clean('2026 年', '日期 2026-10-28') && clean('3,000', '3,000 人'));
check('金額前綴一起顯示：NT$3,001 vs 來源 3000 元', J(nums('NT$3,001', '3000 元')) === J(['NT$3001']) && clean('NT$3,000', '3000 元'));
check('量級差一位也標出：來源 100 億，答案 10 億', J(nums('10 億元', '產值 100 億元')) === J(['10 億元']));
check('年份差一年標出：來源 2026 年，答案 2025 年', J(nums('2025 年', '2026 年')) === J(['2025 年']));
check('英文數字量級：1.2 billion ↔ 12 億，10 million ↔ 1,000 萬', nums('1.2 billion', '12 億元').length === 0 && nums('10 million', '1,000 萬人').length === 0);
check('問題裡的數字也算「模型看到的」：來源是陣列時合併', clean('預計 2028 年', ['知識庫', '記者問：2028 年會量產嗎？']));

/* ───────── 四、網址與 email ───────── */
console.log('\n── 四、網址與 email ──');
const urlSrc = '詳見 https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1 ，聯絡 chuchu@itri.org.tw';
const urls = (a, s = urlSrc) => g(a, s).urls;
check('原樣出現就過；結尾標點（句號、逗號、括號、全形）不影響', urls('請看 https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1。').length === 0
  && urls('(https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1)').length === 0
  && urls('網址：https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1，謝謝').length === 0
  && urls('網址https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1，and more').length === 0);
check('Markdown 連結 [文字](網址) 只抽網址', urls('[官網](https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1)').length === 0);
check('大小寫與結尾斜線不影響', urls('HTTPS://WWW.ITRI.ORG.TW/ListStyle.aspx?DisplayStyle=18&SiteID=1/').length === 0);
check('編造的網址被標出（連原文都不是 itri 的路徑）', J(urls('見 https://www.itri.org.tw/news/2026/ai-chip 。')) === J(['https://www.itri.org.tw/news/2026/ai-chip']));
check('只有 http／https 不同也算不同（原樣出現）', J(urls('http://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1')) === J(['http://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1']));
check('網址被截短不能靠「是來源網址的前綴」過關，但上層路徑（斜線處切齊）可以',
  J(g('https://x.com/ab', '網址 https://x.com/abc 。').urls) === J(['https://x.com/ab']) && g('https://x.com/a', '網址 https://x.com/a/b/c 。').urls.length === 0);
check('www. 開頭沒有 http 的網址也要查', J(g('見 www.fake-itri.com/x', '無').urls) === J(['www.fake-itri.com/x']) && g('見 www.itri.org.tw', '官網 https://www.itri.org.tw/ 。').urls.length === 0);
check('email：一樣要原樣出現；多一段前綴（chu@ 對 chuchu@）不算', urls('chuchu@itri.org.tw').length === 0 && J(urls('support@itri-ai.com')) === J(['support@itri-ai.com']) && J(urls('chu@itri.org.tw')) === J(['chu@itri.org.tw']));
check('extractUrls 單獨可用：去掉結尾標點、網址與 email 分開、重複只留一個', J(extractUrls('A https://a.com/x. B https://a.com/x, C a@b.co').map((u) => u.raw)) === J(['https://a.com/x', 'a@b.co']));
check('網址裡的英文不當英文名詞、數字不當數字查（只在網址那一關被標出一次）', J(extractTerms('見 https://www.itri.org.tw/news/2026').map((t) => t.raw)) === J([]) && extractNumbers('見 https://www.itri.org.tw/news/2026').length === 0
  && J(g('見 https://a.com/news/20261028/12345', '無').numbers) === J([]) && g('見 https://a.com/news/20261028/12345', '無').urls.length === 1);

/* ───────── 五、英文名詞 ───────── */
console.log('\n── 五、英文名詞 ──');
check('編造的英文名詞被標出：Intel、Qualcomm、RISC-V', J(terms('與 NVIDIA、Intel、Qualcomm 合作，採 RISC-V', 'NVIDIA 合作')) === J(['Intel', 'Qualcomm', 'RISC-V']));
check('不分大小寫', terms('nvidia 與 Tsmc', 'NVIDIA、TSMC').length === 0);
check('小白名單不查：LINE、PDF、URL、Email、ITRI、FAQ、CEO、USD、kWh', terms('請用 LINE 或 Email 索取 PDF，ITRI 的 FAQ、CEO、USD、kWh', '無').length === 0);
check('白名單不是萬用：Wi-Fi、GPU 這種技術名詞照查', J(terms('支援 Wi-Fi 與 GPU', '無')) === J(['Wi-Fi', 'GPU']));
check('2 個字母以下不查：AI、5G、Q&A、R&D', terms('AI、5G、Q&A、R&D、IC', '無').length === 0);
check('單複數視為同一個：chips ↔ chip', terms('chips', 'chip').length === 0 && terms('chip', 'chips').length === 0);
check('連字號有無視為同一個：Wi-Fi ↔ WiFi ↔ Wi‑Fi（不斷行連字號）', terms('Wi-Fi', 'WiFi').length === 0 && terms('WiFi', 'Wi-Fi').length === 0 && terms('Wi-Fi', `Wi${ch(0x2011)}Fi`).length === 0);
check('連字號詞：AI-driven 在來源有 AI 與 driven 各自出現就算有', terms('AI-driven', '由 AI 驅動 driven').length === 0 && J(terms('AI-powered', '由 AI 驅動 driven')) === J(['AI-powered']));
check('字母加數字的型號要查：H100 有、A100 沒有', J(terms('H100 與 A100', 'H100')) === J(['A100']));
check('數字後面黏的單位不當英文名詞：100kWh、5nm、15W', terms('100kWh、5nm、15W、2TOPS', '無').length === 0);
check('羅馬數字 III、VIII 不查', terms('第 III 代與 VIII 型', '無').length === 0);
check('中文答案裡夾的一串英文名稱仍算中文答案（不會誤判成英文答案而放掉）', J(terms('使用 TSMC 的 Wi-Fi 6E 與 NVIDIA H100，LINE 和 PDF、iPhone、Edge Computing', '無')) === J(['TSMC', 'Wi-Fi', 'NVIDIA', 'H100', 'iPhone', 'Edge', 'Computing']), J(terms('使用 TSMC 的 Wi-Fi 6E 與 NVIDIA H100，LINE 和 PDF、iPhone、Edge Computing', '無')));
const enAns = 'The speakers are Dr. Wang from the institute and Prof. Lee. The first batch is expected to be 5,000 chips, with mass production planned for the first quarter of 2027, and more than 40 companies are in talks with the team.';
check('英文答案：普通英文單字與首字大寫的人名不查', terms(enAns, '5,000 片 2027 年 40 家 NVIDIA').length === 0);
check('英文答案：縮寫、駝峰、帶數字、連字號大寫仍要查', J(terms(`${enAns} They use TSMC, OpenAI and the H100 over Wi-Fi.`, 'NVIDIA')) === J(['TSMC', 'OpenAI', 'H100', 'Wi-Fi']));
check('英文答案的數字照查：2029、US$400', J(nums('Mass production in 2029 and a price of US$400. The chip is described in the institute press release and the Q&A session with reporters.', '2027 年量產')) === J(['2029', 'US$400']));

/* ───────── 六、警語 ───────── */
console.log('\n── 六、警語 stripDisclaimer ──');
check('只切警語那個子句，前面的正文與數字留著', stripDisclaimer('價格 3,000 元，內容僅供參考，以工研院官網新聞稿或發言為準。') === '價格 3,000 元，');
check('警語被括號包住也只切括號裡面：首批 5,000 片（內容僅供參考，以工研院官網新聞稿或發言為準）', stripDisclaimer('首批 5,000 片（內容僅供參考，以工研院官網新聞稿或發言為準）') === '首批 5,000 片（');
check('英文警語整句拿掉', stripDisclaimer("Yes it is 5 nm.\n\nFor reference only; please confirm with ITRI's official press release.") === 'Yes it is 5 nm.\n\n');
check('警語不在結尾 200 字以內就不動（避免吃掉正文）', stripDisclaimer(`這個數字僅供參考。${'後面還有很多正文。'.repeat(40)}`).includes('後面還有很多正文'));
check('警語前面的數字照查：警語切掉後 3,000 元仍要比', J(nums('價格 3,001 元，內容僅供參考，以工研院官網新聞稿或發言為準。', '價格 3,000 元')) === J(['3001 元']));

/* ───────── 七、模式：shadow／on／off ───────── */
console.log('\n── 七、模式切換（呼叫時才讀環境變數）──');
const BAD = '預計 2028 年量產，約 80 家廠商，見 https://fake.example.com/x ，與 Intel 合作。';
const SRC = '預計 2027 年量產，超過 40 家廠商洽談。';
check('groundingMode：未設／shadow／空字串／亂打 → shadow；on／ON／ off → 各自', withMode(undefined, () => groundingMode()) === 'shadow'
  && groundingMode({ ANSWER_GROUNDING: 'shadow' }) === 'shadow' && groundingMode({ ANSWER_GROUNDING: '' }) === 'shadow'
  && groundingMode({ ANSWER_GROUNDING: 'onn' }) === 'shadow' && groundingMode({ ANSWER_GROUNDING: 'true' }) === 'shadow'
  && groundingMode({ ANSWER_GROUNDING: 'ON' }) === 'on' && groundingMode({ ANSWER_GROUNDING: ' on ' }) === 'on' && groundingMode({ ANSWER_GROUNDING: 'off' }) === 'off');
{
  const { value: r, logs } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(BAD, SRC, { where: 'web-chat', eventId: 'e1' })));
  check('★ 預設（未設）＝影子模式：標出東西、記一行 log，note 一律空字串', r.mode === 'shadow' && r.note === '' && r.numbers.length === 2 && r.urls.length === 1 && r.terms.length === 1 && logs.length === 1, J({ r, logs }));
}
{
  const { value: r, logs } = captureLogs(() => withMode('shadow', () => checkAnswerGrounding(BAD, SRC)));
  check('　 明寫 shadow 一樣：不回 note', r.mode === 'shadow' && r.note === '' && r.numbers.length === 2 && logs.length === 1);
}
{
  const { value: r, logs } = captureLogs(() => withMode('on', () => checkAnswerGrounding(BAD, SRC, { where: 'web-chat', eventId: 'e1' })));
  check('★ on：另外回 note（要附在答案後面的一行提醒），內容跟 shadow 抓到的一樣', r.mode === 'on' && /^⚠️ 以上內容有幾處（.+）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。$/.test(r.note)
    && r.numbers.length === 2 && r.urls.length === 1 && r.terms.length === 1 && logs.length === 1, J({ r, logs }));
}
{
  const { value: r, logs } = captureLogs(() => withMode('off', () => checkAnswerGrounding(BAD, SRC, { where: 'web-chat', eventId: 'e1' })));
  check('★ off：什麼都不做——空結果、不記 log', r.mode === 'off' && r.note === '' && !r.numbers.length && !r.urls.length && !r.terms.length && logs.length === 0, J({ r, logs }));
}
{
  const a = captureLogs(() => withMode('off', () => checkAnswerGrounding(BAD, SRC)));
  const b = captureLogs(() => withMode('on', () => checkAnswerGrounding(BAD, SRC)));
  const c = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(BAD, SRC)));
  check('　 模式在呼叫時才讀：同一個行程連續切 off → on → 未設，行為跟著變', a.value.mode === 'off' && b.value.mode === 'on' && b.value.note !== '' && c.value.mode === 'shadow' && c.value.note === '');
}
{
  const { value: r, logs } = captureLogs(() => withMode('on', () => checkAnswerGrounding('預計 2027 年量產。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。', SRC)));
  check('沒有東西被標出：on 模式也沒有 note、不記 log', !r.numbers.length && r.note === '' && logs.length === 0, J({ r, logs }));
}

/* ───────── 八、log：只記被標出的項目 ───────── */
console.log('\n── 八、log 格式與內容 ──');
{
  const secret = '王小明的手機號碼是祕密句子，他住在天龍國的某條路上';
  const answer = `${secret}。預計 2028 年量產。`;
  const question = '這是記者的問題QQQ，請問量產時間';
  const { logs } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(answer, [SRC, question], { where: 'line-qa', eventId: 'ev-7' })));
  const line = logs[0] || '';
  check('★ log 一行：[grounding] where=… event=… numbers=… urls=… terms=…', logs.length === 1 && /^\[grounding\] where=line-qa event=ev-7 numbers=\[.*\] urls=\[.*\] terms=\[.*\]$/.test(line), line);
  check('★ log 只有被標出的項目本身：沒有答案全文、問題、使用者資料', line.includes('2028 年') && !line.includes('祕密句子') && !line.includes('王小明') && !line.includes('QQQ') && !line.includes('量產時間'), line);
  check('　 數字、網址、英文名詞各自成欄（JSON 陣列，可以 grep 也可以解析）', (() => {
    const m = /numbers=(\[.*\]) urls=(\[.*\]) terms=(\[.*\])$/.exec(line);
    return !!m && J(JSON.parse(m[1])) === J(['2028 年']) && J(JSON.parse(m[2])) === J([]) && J(JSON.parse(m[3])) === J([]);
  })(), line);
}
{
  const { logs } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(BAD, SRC)));
  check('沒給 where／eventId：記成 -', /^\[grounding\] where=- event=- /.test(logs[0] || ''), logs[0]);
}
{
  const { logs } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(BAD, SRC, { where: 'web chat\n偽造一行', eventId: 'x'.repeat(200) })));
  check('where 的空白與換行被換掉、過長被截斷（log 永遠只有一行）', logs.length === 1 && !logs[0].includes('\n') && !/where=web chat/.test(logs[0]) && logs[0].length < 600, logs[0]);
}
{
  const many = Array.from({ length: 40 }, (_, i) => `${1000 + i * 7} 年`).join('、');
  const { value: r, logs } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(many, '無')));
  check('標出很多筆：每類最多 30 筆、log 只列 10 筆再寫 +N，不會洗版', r.numbers.length === 30 && /\+20"\]/.test(logs[0] || '') && logs[0].length < 700, `${r.numbers.length} ${logs[0]?.length}`);
}

/* ───────── 九、提醒文案 ───────── */
console.log('\n── 九、提醒文案 buildGroundingNote ──');
{
  const one = buildGroundingNote(['2028 年']);
  const three = buildGroundingNote(['2028 年', '500 億元', 'Intel']);
  const five = buildGroundingNote(['2028 年', '500 億元', 'Intel', 'https://a.com/x', 'RISC-V']);
  check('項目 ≤ 3：全列，頓號分隔', one === '⚠️ 以上內容有幾處（2028 年）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。'
    && three === '⚠️ 以上內容有幾處（2028 年、500 億元、Intel）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。', three);
  check('項目 > 3：只列 3 個，其餘寫「等 N 處」（N＝全部處數）', five === '⚠️ 以上內容有幾處（2028 年、500 億元、Intel 等 5 處）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。', five);
  check('重複的項目只算一處', buildGroundingNote(['A', 'A', 'A']) === '⚠️ 以上內容有幾處（A）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。');
  check('沒有項目、非陣列、全是空字串 → 空字串', buildGroundingNote([]) === '' && buildGroundingNote(null) === '' && buildGroundingNote(['', '  ']) === '');
  check('★ 通過 toTraditionalTW() 不被改動（台灣繁體，不含簡體字）', [one, three, five].every((n) => toTraditionalTW(n) === n));
  const md = buildGroundingNote(['https://example.com/a_b_c?x=*y*', '`code`', '# 標題', '[連結](http://x)', '**粗**']);
  check('★ 不含 Markdown：項目裡的 * _ ` # [ ] 都清掉，過 stripMarkdownForLine() 不變', !/[*_`#\[\]]/.test(md) && stripMarkdownForLine(md) === md && !/\n/.test(md), md);
  check('過長的項目截斷成 40 字加「…」', buildGroundingNote(['x'.repeat(100)]).includes(`${'x'.repeat(40)}…`));
}

/* ───────── 十、強健性：檢查自己壞了，記者照樣收到答案 ───────── */
console.log('\n── 十、強健性：null、空字串、超長、自己出錯 ──');
{
  const isEmpty = (r) => !r.numbers.length && !r.urls.length && !r.terms.length && r.note === '';
  const answersIn = [null, undefined, '', '   ', 0, 123, {}, [], ['2028 年']];
  const sourcesIn = [null, undefined, '', 0, {}, '無'];
  let threw = false;
  const all = [];
  const { logs } = captureLogs(() => {
    try {
      for (const a of answersIn) for (const sx of sourcesIn) all.push({ a, sx, r: withMode('on', () => checkAnswerGrounding(a, sx)) });
    } catch { threw = true; }
  });
  check('答案與來源的各種怪輸入（null、undefined、空字串、數字、物件、陣列）都不丟例外', !threw && all.length === answersIn.length * sourcesIn.length);
  check('　 答案是 null／undefined／空字串／全空白 → 一律空結果', all.filter((x) => [null, undefined, '', '   '].includes(x.a)).every((x) => isEmpty(x.r)) && logs.length > 0);
  check('　 來源是 null／undefined／空字串（呼叫端沒傳）→ 空結果，不會把答案裡的東西全部標出', all.filter((x) => [null, undefined, ''].includes(x.sx)).every((x) => isEmpty(x.r)));
  check('　 來源是空的時記一行讓人發現，而不是靜靜吞掉', captureLogs(() => checkAnswerGrounding('預計 2028 年量產', '')).logs.some((l) => /shownText 是空的/.test(l)));
}
{
  const nasty = { toString() { throw new Error('toString 炸了'); } };
  // 檢查若把例外往外丟，這幾項要變成一條條紅的 ❌，而不是整支測試當掉
  const safely = (fn) => { try { return fn(); } catch (e) { return { value: { numbers: [], note: `THREW ${e.message}` }, logs: [] }; } };
  const { value: r, logs } = safely(() => captureLogs(() => withMode('on', () => checkAnswerGrounding(nasty, '資料', { where: 'web-chat', eventId: 'e1' }))));
  check('★ 答案物件的 toString 丟例外 → 回空結果、記一行 log（不往外丟）', !r.numbers.length && r.note === '' && logs.length === 1 && /檢查自己出錯/.test(logs[0]) && !/numbers=/.test(logs[0]), J({ r, logs }));
  const r2 = safely(() => captureLogs(() => checkAnswerGrounding('預計 2028 年', nasty)));
  check('　 來源物件的 toString 丟例外一樣', !r2.value.numbers.length && r2.logs.length === 1 && /檢查自己出錯/.test(r2.logs[0]), J(r2));
  const r3 = safely(() => captureLogs(() => checkAnswerGrounding('預計 2028 年', '無', null)));
  check('　 opts 傳 null 也不丟例外', r3.value.numbers.length === 1);
  const evil = { toString() { throw new Error('x'); } };
  const r4 = safely(() => captureLogs(() => checkAnswerGrounding('預計 2028 年', '無', { where: evil, eventId: evil })));
  check('　 where／eventId 是會炸的物件也不丟例外', r4.value.numbers.length === 1 && /where=- event=-/.test(r4.logs[0] || ''), J(r4));
}
{
  const hugeAnswer = '預計 2028 年量產，約 80 家。'.repeat(100_000);        // 約 130 萬字
  const hugeSource = '知識庫段落 2027 年 100 億元 NVIDIA。'.repeat(150_000); // 約 330 萬字
  const t0 = performance.now();
  const { value: r } = captureLogs(() => withMode(undefined, () => checkAnswerGrounding(hugeAnswer, hugeSource)));
  const ms = performance.now() - t0;
  check(`超長輸入（答案 ${hugeAnswer.length} 字、來源 ${hugeSource.length} 字）不丟例外、會被截斷、幾百毫秒內做完（實測 ${ms.toFixed(0)} ms）`, Array.isArray(r.numbers) && ms < 3000, ms);
  const digits = '9'.repeat(2_000_000);
  const t1 = performance.now();
  const r5 = captureLogs(() => checkAnswerGrounding(`${digits} 年`, `${'1,'.repeat(50_000)}${'一'.repeat(50_000)}`)).value;
  check(`兩百萬位的數字、十萬個「一」不會讓比對卡住（${(performance.now() - t1).toFixed(0)} ms）`, Array.isArray(r5.numbers) && performance.now() - t1 < 3000);
  const t2 = performance.now();
  captureLogs(() => checkAnswerGrounding(`${'a'.repeat(30_000)}@${'b'.repeat(29_000)}`, `${'-'.repeat(300_000)}`));
  check(`超長英數字串的 email／網址比對不會退化成平方時間（${(performance.now() - t2).toFixed(0)} ms）`, performance.now() - t2 < 3000);
}
{
  // 知識庫上限 45,000 字（api/events.js KB_MAX_LEN）。一次檢查要在個位數毫秒～十幾毫秒；測試放寬到 80ms 免得 CI 偶發變慢就紅
  const para = '工研院今（28）日發表新一代 AI 邊緣運算晶片，採 TSMC 28 奈米製程，效能 12 TOPS，功耗 1.5 瓦，預計 2027 年第一季量產，首批 5,000 片，吸引超過 40 家廠商洽談，包含 NVIDIA 與聯發科。詳見 https://www.itri.org.tw/ListStyle.aspx?MGID=1 ，聯絡 02-2777-3111。\n';
  const kb = para.repeat(Math.ceil(45_000 / para.length)).slice(0, 45_000);
  const answer = '採 28 奈米製程，效能 12 TOPS，功耗 1.5 瓦；預計 2027 年第一季量產，首批 5,000 片。與 NVIDIA 合作。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。';
  const times = [];
  for (let i = 0; i < 15; i++) { const t = performance.now(); findUngrounded(answer, [kb, '基本資料', '問題']); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  const median = times[7];
  check(`效能：45,000 字知識庫一次檢查的中位數 ${median.toFixed(1)} ms（要 < 80 ms）`, median < 80, times.map((t) => t.toFixed(1)).join(','));
  check('　 且 45,000 字知識庫裡有的東西全部對得上（沒有誤報）', clean(answer, [kb, '基本資料', '問題']));
}

/* ───────── 十一、離線回測工具 ───────── */
console.log('\n── 十一、tools/grounding-backtest ──');
const TOOL = path.join(ROOT, 'tools/grounding-backtest/backtest.mjs');
const SAMPLE = path.join(ROOT, 'tools/grounding-backtest/sample.json');
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: ROOT });
{
  const sample = JSON.parse(src('tools/grounding-backtest/sample.json'));
  check('sample.json：至少 8 則答案、2 場活動，每則有問題與答案', sample.answers.length >= 8 && sample.events.length >= 2 && sample.answers.every((a) => a.question && a.answer && a.event_id));
  const r = run([SAMPLE, '--json']);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 下面的 check 會失敗並顯示 stdout */ }
  check('★ 對 sample.json 跑 --json：結束碼 0、輸出可解析', r.status === 0 && j, `${r.status} ${r.stderr}${r.stdout.slice(0, 300)}`);
  if (j) {
    check('　 總則數 11、被標出 5 則；數字 2 則、網址 1 則、英文名詞 2 則（編造的與誤報示範各自出現）',
      j.checked === 11 && j.flagged === 5 && j.kinds.numbers.answers === 2 && j.kinds.urls.answers === 1 && j.kinds.terms.answers === 2, J({ checked: j.checked, flagged: j.flagged, kinds: j.kinds }));
    check('　 被標出的是第 4、5、6、9、11 則；正常的（含中文數字互換、序數、英文答案）沒有被標出',
      J(j.details.map((d) => d.index)) === J([4, 5, 6, 9, 11]), J(j.details.map((d) => d.index)));
    check('　 expect 對照：誤報 1 則（第 9 則，英文註解）、漏報 0 則', j.labeled.total === 11 && j.labeled.falseAlarm === 1 && J(j.labeled.falseAlarmIndexes) === J([9]) && j.labeled.miss === 0);
    check('　 張冠李戴（另一場的 28 奈米、12 TOPS 出現在這場的答案裡）被標出：用各自活動的知識庫比對', j.details.find((d) => d.index === 11)?.numbers.includes('28 奈米') && j.details.find((d) => d.index === 11)?.numbers.includes('12 TOPS'));
    const head80 = (a) => [...a.replace(/\s+/g, ' ').trim()].slice(0, 80).join('');
    check('　 Top 清單有編造的項目；每筆明細有問題與「答案前 80 字」（長答案正好取 80 字、短的全取，換行壓成空白）',
      j.top.some((t) => t.item === '2028 年') && j.details.every((d) => d.question && d.answerHead === head80(JSON.parse(src('tools/grounding-backtest/sample.json')).answers[d.index - 1].answer))
      && j.details.some((d) => [...d.answerHead].length === 80), J(j.details.map((d) => [...d.answerHead].length)));
  }
  const txt = run([SAMPLE]);
  check('文字報告：有總則數、被標出比例、各類別、Top 20、逐則明細', txt.status === 0 && ['總則數：11', '被標出：5 則（45.5%）', '各類別', '最常被標出的項目 Top 20', '答案前 80 字', '誤報（標註沒問題、卻被標出）：1 則'].every((s) => txt.stdout.includes(s)), txt.stdout.slice(0, 400));
  const limited = run([SAMPLE, '--top', '3', '--max-detail', '1']);
  check('　 --top 3、--max-detail 1 有效', limited.stdout.includes('Top 3') && (limited.stdout.match(/答案前 80 字/g) || []).length === 1);
  const bad1 = run([path.join(ROOT, 'tools/grounding-backtest/不存在.json')]);
  const noArgs = run([]);
  check('輸入檔不存在、沒給參數：結束碼非 0，並說明原因', bad1.status === 1 && /讀不了輸入檔/.test(bad1.stderr) && noArgs.status === 1 && /用法/.test(noArgs.stdout));
}
{
  const { parseCsv, answersFromCsv, runBacktest, parseTaipeiTime } = await import('../tools/grounding-backtest/backtest.mjs');
  const bom = ch(0xFEFF);
  const csv = `${bom}時間,活動ID,活動名稱,媒體名稱,姓名,記者問題,AI回答\r\n"2026/9/30 10:00","sample-chip","晶片","某報","","量產時間?","預計 2028 年量產,\n換行也在儲存格內, ""引號""\n\n內容僅供參考"\r\n"2026/9/30 10:01","sample-chip","晶片","某報","","公式?","'+開頭的答案"\r\n`;
  const rows = parseCsv(csv);
  check('CSV 解析：BOM、CRLF、雙引號跳脫、儲存格內逗號與換行', rows.length === 3 && rows[0][1] === '活動ID' && rows[1][6].includes('換行也在儲存格內, "引號"') && rows[1][6].includes(',') , J(rows[1]));
  const answers = answersFromCsv(csv);
  check('answersFromCsv：對應「活動ID／記者問題／AI回答」欄位，拿掉防公式注入的單引號', answers.length === 2 && answers[0].event_id === 'sample-chip' && answers[0].question === '量產時間?' && answers[1].answer === '+開頭的答案', J(answers));
  check('　 「時間」欄轉成 asked_at（台灣時間）：「2026/9/30 10:00」', answers[0].asked_at === '2026-09-30T10:00:00+08:00', answers[0].asked_at);
  check('　 時間格式：下午11:06:04、上午12:05、只有日期、亂寫',
    parseTaipeiTime('2026/6/18 下午11:06:04') === '2026-06-18T23:06:04+08:00' && parseTaipeiTime('2026/6/18 上午12:05') === '2026-06-18T00:05:00+08:00'
    && parseTaipeiTime('2026-06-18') === '2026-06-18T00:00:00+08:00' && parseTaipeiTime('昨天') === '' && parseTaipeiTime(null) === '');
  let msg = '';
  try { answersFromCsv('a,b\n1,2'); } catch (e) { msg = e.message; }
  check('　 不是後台匯出的 CSV（找不到欄位）→ 明確報錯', /找不到/.test(msg), msg);
  const sample = JSON.parse(src('tools/grounding-backtest/sample.json'));
  const res = runBacktest({
    events: sample.events,
    answers: [{ event_id: '不存在', question: 'q', answer: '預計 2028 年' }, { event_id: 'sample-chip', question: 'q', answer: '   ' }, ...answers]
  });
  check('runBacktest：找不到活動、空答案會略過並列在報告；其餘照跑', res.skipped.noEvent === 1 && res.missingEvents[0] === '不存在' && res.skipped.blankAnswer === 1 && res.checked === 2 && res.flagged === 1, J(res.skipped));
  const qEv = [{ id: 'q1', name: 'Q', knowledge_base: '預計 2027 年量產。', event_date: '', event_time: '', venue: '', press_contact: '' }];
  const withQ = runBacktest({ events: qEv, answers: [{ event_id: 'q1', question: '2028 年會量產嗎？', answer: '資料裡只有 2027 年，沒有提到 2028 年。' }, { event_id: 'q1', question: '會量產嗎？', answer: '預計 2028 年。' }] });
  check('shownText 含記者的問題：問題裡出現過的數字不算編造（跟線上一樣）；沒出現過的才標出', withQ.flagged === 1 && withQ.details[0].index === 2, J(withQ.details));
  const printed = captureLogs(() => runBacktest({ events: sample.events, answers: sample.answers }));
  check('runBacktest 本身沒有 console 輸出、也不記 [grounding]（回測不污染線上 log 的格式）', printed.logs.length === 0);
}

/* ───────── 十二、這支檔案本身的紀律 ───────── */
console.log('\n── 十二、紀律：純函式、不碰網路、不碰 Sheets ──');
{
  const lib = src('lib/answer-grounding.js');
  const code = lib.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check('lib/answer-grounding.js 沒有 import、沒有 fetch、沒有 Sheets／網路相關字眼', !/^\s*import\s/m.test(code) && !/\bfetch\s*\(/.test(code) && !/sheets|googleapis|https\.request|XMLHttpRequest/i.test(code));
  check('　 只讀 ANSWER_GROUNDING 一個環境變數', /process\.env/.test(code) && /ANSWER_GROUNDING/.test(code) && [...code.matchAll(/\benv\??\.(\w+)/g)].every((m) => m[1] === 'ANSWER_GROUNDING') && [...code.matchAll(/process\.env\.(\w+)/g)].every((m) => m[1] === 'ANSWER_GROUNDING'));
  check('　 log 只有 [grounding] 開頭的三種：標出、來源空、自己出錯', (code.match(/console\.log\(/g) || []).length === 3 && (code.match(/console\.log\(`\[grounding\]/g) || []).length === 3);
  check('　 檢查自己的 try/catch 在（壞了回空結果）', /try \{\s*const r = findUngrounded/.test(code) && /catch \(e\)/.test(code));
  const tool = src('tools/grounding-backtest/backtest.mjs');
  check('回測工具只讀檔：沒有 fetch、沒有寫檔、沒有環境變數金鑰', !/\bfetch\s*\(/.test(tool) && !/writeFile|appendFile|createWriteStream|unlink/.test(tool) && !/ANTHROPIC|process\.env/.test(tool));
  // 故意寫簡體字的只有兩種：警語的偵測詞（仅供参考）與測試「簡體警語也不查」的那句；拿掉再用專案自己的簡繁轉換驗證
  const scrub = (t) => t.replaceAll('内容仅供参考，以工研院官网新闻稿或发言为准。', '').replaceAll('仅供参考', '');
  const noSimplified = (t) => captureLogs(() => toTraditionalTW(scrub(t))).value === scrub(t);
  check('回測工具、README、lib、測試都沒有簡體字（CLAUDE.md 第 1 條；用 toTraditionalTW() 驗證）',
    [tool, src('tools/grounding-backtest/README.md'), lib, src('test/test-batch132.mjs'), src('tools/grounding-backtest/sample.json')].every(noSimplified));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 132（答案出口檢查：數字、網址、英文名詞，影子模式）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
