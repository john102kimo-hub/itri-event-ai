// 批次 132：記者端答案的「數字、網址、英文名詞」出口檢查（影子模式）。
//   lib/answer-grounding.js 的純函式單元測試，加上離線回測工具 tools/grounding-backtest/ 的驗收。
//
// 這支測試分兩半，第二半跟第一半一樣重要（跟 test-zhtw.mjs 同一個結構）：
//   ① 編造的數字、網址、英文名詞要被標出來
//   ② **正確的答案不能被標出來**——這種檢查最大的風險不是漏抓，是誤報：中文數字與阿拉伯數字互換、
//      千分位、全形、日期寫法不同、條列編號、警語，只要有一種誤報，記者每天都會看到「查不到」的提醒。
//   ③ 影子模式：不改任何回覆（note 一律空字串）、log 不含答案全文，檢查自己壞掉也不能害記者收不到答案。
//   ④ 品質審查的調整（第十四節）：括號英文註解、模型自己算的數字、複合量級、幣別、季別、網址協定、on:urls,terms…
//      每一項都是「誤報的案例變綠」加「編造的案例照樣被標出」成對寫；標「已知代價」的是調整後仍抓不到的情形，斷言它抓不到。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkAnswerGrounding, findUngrounded, groundingMode, groundingNoteKinds, normalizeForGrounding, cnIntToDecimal,
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
check('分機、電話：來源有就過', clean('分機 1234，電話 02-1234-5678', '聯絡 02-1234-5678 分機 1234'));
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
check('分機錯一碼就標出', J(nums('分機 1235', '分機 1234')) === J(['1235']));
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
const urlSrc = '詳見 https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=18&SiteID=1 ，聯絡 press@example.org';
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
check('email：一樣要原樣出現；多一段前綴（ess@ 對 press@）不算', urls('press@example.org').length === 0 && J(urls('support@itri-ai.com')) === J(['support@itri-ai.com']) && J(urls('ess@example.org')) === J(['ess@example.org']));
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
  // 語言由呼叫端判斷、用 opts.english 傳進來（這支維持沒有 import 的純函式）；沒傳就是中文版，shadow 模式不受影響
  const en = captureLogs(() => withMode('on', () => checkAnswerGrounding(BAD, SRC, { english: true }))).value;
  const zh = captureLogs(() => withMode('on', () => checkAnswerGrounding(BAD, SRC, { english: false }))).value;
  const none = captureLogs(() => withMode('on', () => checkAnswerGrounding(BAD, SRC))).value;
  const shadow = captureLogs(() => withMode('shadow', () => checkAnswerGrounding(BAD, SRC, { english: true }))).value;
  check('★ on＋opts.english:true → 英文版 note；false 或沒傳 → 中文版；shadow 不管怎樣都沒有 note',
    /^⚠️ Some items above \(.+\) could not be found in the press release\. Please confirm with the press contact before citing\.$/.test(en.note)
      && zh.note.startsWith('⚠️ 以上內容有幾處') && none.note === zh.note && shadow.note === '', J({ en: en.note, zh: zh.note, shadow: shadow.note }));
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

  // 批次 132 審查（規範 F4）：英文答案不能接一句只有中文的提醒
  const en1 = buildGroundingNote(['2028'], { english: true });
  const en3 = buildGroundingNote(['14 nm', '25 TOPS', '2028'], { english: true });
  const en5 = buildGroundingNote(['2028', '500 billion', 'Intel', 'https://a.com/x', 'RISC-V'], { english: true });
  check('★ 英文版提醒：固定句、沒有中文字', en1 === '⚠️ Some items above (2028) could not be found in the press release. Please confirm with the press contact before citing.' && !/[一-鿿]/.test(en1), en1);
  check('　 三項以內全列；超過三項只列前三項再說還有幾項（"and N more"）', en3.includes('(14 nm, 25 TOPS, 2028)') && en5.includes('(2028, 500 billion, Intel, and 2 more)') && !en5.includes('RISC-V'), en3 + '\n' + en5);
  const enMd = buildGroundingNote(['https://example.com/a_b_c?x=*y*', '`code`', '# title', '[link](http://x)', '**bold**'], { english: true });
  check('　 英文版也不含 Markdown 的符號（項目清理方式跟中文版相同）', !/[*_`#\[\]<>|~\\]/.test(enMd.replace(/^⚠️/, '')), enMd);
  check('　 沒有項目、english 不是 true（沒傳、false、字串 "true"）→ 空字串／中文版，中文版一個字沒變',
    buildGroundingNote([], { english: true }) === '' && buildGroundingNote(['A']) === buildGroundingNote(['A'], { english: false }) && buildGroundingNote(['A'], { english: 'true' }).startsWith('⚠️ 以上內容有幾處')
      && buildGroundingNote(['2028 年', '500 億元', 'Intel', 'https://a.com/x', 'RISC-V']) === five);
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
  // 批次 132 審查（規範 F1）：網址結尾標點的 regex（/[.,;:!?'"*)\]}>]+$/ 與 /\/+$/）沒有對開頭定錨，遇到
  // 「一長串標點後面接一個英數字」時是平方時間：8000 字一則的訊息 × 6 則就能讓每次回答多卡約 0.8 秒；32000 字約 2 秒。
  // URL_RE 的字元集剛好包含這些標點，整串會被吃成一個網址。改成從尾端逐字修剪（線性）。
  // 門檻抓得很鬆（4 萬字 < 200 ms；平方版 4 萬字每個要約 3 秒、六個要十幾秒），只擋量級，不怕 CI 偶發變慢；
  // 刻意不用更大的輸入——壞掉的時候要幾秒內就紅，不是跑好幾分鐘。
  const patho = {
    '句點串': 'https://a' + '.'.repeat(40_000) + 'a',
    '斜線串': 'https://a' + '/'.repeat(40_000) + 'a',
    '右括號串': 'https://a' + ')'.repeat(40_000) + 'a',
    '混合標點串': 'https://a' + '!?.,;:'.repeat(7_000) + 'a',
    '結尾標點串': 'https://a.com/' + '.'.repeat(40_000),
    'www 開頭': 'www.a' + '.'.repeat(40_000) + 'a',
  };
  const slow = [];
  for (const [name, text] of Object.entries(patho)) {
    const t = performance.now();
    extractUrls(text);
    const ms = performance.now() - t;
    if (ms > 200) slow.push(`${name} ${ms.toFixed(0)}ms`);
  }
  check('★ 病態輸入（4 萬字的標點串夾在網址裡）extractUrls 都在 200 ms 內（平方版每個要約 3 秒）', slow.length === 0, slow.join(', '));
  const t3 = performance.now();
  const { value: whole } = captureLogs(() => checkAnswerGrounding(`詳見 ${patho['句點串']} 。`, `網址 https://www.itri.org.tw/ ${patho['斜線串']}`));
  const ms3 = performance.now() - t3;
  check(`★ 端到端：答案與來源都是病態網址，checkAnswerGrounding 也在 200 ms 內（${ms3.toFixed(0)} ms），不丟例外`, ms3 < 200 && Array.isArray(whole.numbers), ms3);
  // 逆向修剪的結果必須跟原本的 regex 完全一樣：隨機字串對照（舊寫法逐字抄來當對照）
  const OLD_TRAIL = /[.,;:!?'"*)\]}>]+$/;
  const oldKey = (raw) => String(raw).replace(OLD_TRAIL, '').toLowerCase().replace(/\/+$/, '');
  const alphabet = ['a', 'B', '.', ',', ';', ':', '!', '?', "'", '"', '*', ')', ']', '}', '>', '/', '(', '-', '_', '9', '#'];
  let seed = 20261013, diffs = [];
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 20000 && diffs.length < 3; i++) {
    let body = ''; const L = 1 + Math.floor(rnd() * 14);
    for (let j = 0; j < L; j++) body += alphabet[Math.floor(rnd() * alphabet.length)];
    const url = 'https://x.com/' + body;
    const got = extractUrls(`看 ${url} 吧`);
    const m = (`看 ${url} 吧`).match(/(?:https?:\/\/|www\.)[A-Za-z0-9][A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]*/i);
    const want = m ? oldKey(m[0]) : '';
    if ((got[0]?.key ?? '') !== want) diffs.push(`${url} → ${got[0]?.key} / 舊 ${want}`);
  }
  check('★ 逆向修剪與原本的 regex 結果完全相同（兩萬組隨機網址尾巴：key 逐字比對）', diffs.length === 0, diffs.join('\n'));
  check('　 結尾標點照舊被修掉、斜線照舊不影響：https://a.com/x.) → https://a.com/x；HTTPS://A.COM/X/ 與 https://a.com/x 同一個 key',
    extractUrls('(https://a.com/x.)')[0]?.raw === 'https://a.com/x' && extractUrls('HTTPS://A.COM/X/')[0]?.key === extractUrls('https://a.com/x')[0]?.key);
}
{
  // 知識庫上限 45,000 字（api/events.js KB_MAX_LEN）。一次檢查要在個位數毫秒～十幾毫秒；測試放寬到 80ms 免得 CI 偶發變慢就紅
  const para = '工研院今（28）日發表新一代 AI 邊緣運算晶片，採 TSMC 28 奈米製程，效能 12 TOPS，功耗 1.5 瓦，預計 2027 年第一季量產，首批 5,000 片，吸引超過 40 家廠商洽談，包含 NVIDIA 與聯發科。詳見 https://www.itri.org.tw/ListStyle.aspx?MGID=1 ，聯絡 02-1234-5678。\n';
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

/* ───────── 十三、回測資料含個資與未發布稿件：README 要講、.gitignore 要擋（批次 132 審查，規範 F2）───────── */
console.log('\n── 十三、真實問答含記者姓名、媒體、提問與未發布稿件：不能被 commit ──');
{
  const readme = src('tools/grounding-backtest/README.md');
  const head = readme.slice(0, readme.indexOf('## 一、準備資料'));
  check('★ README 在「準備資料」之前就有醒目的個資與未發布稿件提醒（記者姓名／媒體／提問、未發布新聞稿）',
    /^## ⚠️/m.test(head) && /個人資料/.test(head) && /記者姓名/.test(head) && /還沒發布|未發布/.test(head) && /不要 commit/.test(head), head.slice(0, 300));
  check('　 提醒講了三件事：資料檔放 repo 外或用 .local 命名、跑完刪掉、分享報告前遮掉提問原文', /\.local\.json/.test(head) && /跑完就刪/.test(head) && /遮掉提問原文/.test(head));
  check('　 README 的範例指令教人用 .local 命名（不再示範 my-qa.json／all-events-qa-….csv 這種會被 git add -A 帶走的檔名）',
    /backtest\.mjs my-qa\.local\.json/.test(readme) && /--answers-csv qa-2026-10-12\.local\.csv/.test(readme) && !/backtest\.mjs my-qa\.json/.test(readme) && !/--answers-csv all-events-qa/.test(readme));
  const gi = src('.gitignore');
  check('★ .gitignore 擋回測用資料的檔名樣式：*.local.json、*.real.json（CSV 同理）', /^tools\/grounding-backtest\/\*\.local\.json$/m.test(gi) && /^tools\/grounding-backtest\/\*\.real\.json$/m.test(gi)
    && /^tools\/grounding-backtest\/\*\.local\.csv$/m.test(gi) && /^tools\/grounding-backtest\/\*\.real\.csv$/m.test(gi), gi.slice(-600));
  // 用 git 自己判斷：真的被忽略；範例檔 sample.json 沒有被誤擋
  const ignored = (f) => spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status === 0;
  const gitOk = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT }).status === 0;
  if (gitOk) {
    check('★ git check-ignore：回測資料的檔名被忽略（my-qa.local.json、x.real.json、後台匯出的預設檔名 all-events-qa-日期.csv 與 <活動ID>-qa-日期.csv）',
      ['tools/grounding-backtest/my-qa.local.json', 'tools/grounding-backtest/x.real.json', 'tools/grounding-backtest/qa.local.csv', 'all-events-qa-2026-10-12.csv', 'ev123-qa-2026-10-12.csv', 'qa-2026-10-12.local.csv'].every(ignored),
      ['tools/grounding-backtest/my-qa.local.json', 'tools/grounding-backtest/x.real.json', 'tools/grounding-backtest/qa.local.csv', 'all-events-qa-2026-10-12.csv', 'ev123-qa-2026-10-12.csv', 'qa-2026-10-12.local.csv'].filter((f) => !ignored(f)).join(', '));
    check('　 範例 sample.json 與 README、backtest.mjs 沒被誤擋（它們要留在 repo 裡）', !ignored('tools/grounding-backtest/sample.json') && !ignored('tools/grounding-backtest/README.md') && !ignored('tools/grounding-backtest/backtest.mjs'));
  }
  // sample.json 與測試裡的聯絡資料必須是明顯的假值：README 敢說「人名、電話、信箱都是假的」，就不能夾真人的暱稱與電話。
  // 樣式用字串相加拼出來，這支測試檔自己才不會因為寫了樣式而掃到自己。
  const REAL = ['朱' + '朱', '2777' + '-3111', 'chu' + 'chu@', '312' + '34'];
  const fixtures = src('tools/grounding-backtest/sample.json') + src('test/test-batch132.mjs');
  const left = REAL.filter((x) => fixtures.includes(x));
  check('★ 範例與測試裡沒有真人的暱稱、電話、信箱：電話用 02-1234-5678、信箱用 example.org', left.length === 0, `還有殘留：${left.join('、')}`);
}


/* ───────── 十四、批次 132 品質審查：降低誤報的調整（每一項都附「不能放水」的對照）───────── */
// 品質審查拿 322 則自擬的模型答案量過（tools/grounding-backtest/README.md「規則調整之後的數字」）：沒編造的答案被標出 33.0% → 7.6%，
// 有編造的答案漏掉 39.5% → 31.4%。下面每一組都是「誤報的案例變綠」加「編造的案例照樣被標出」——只有前者沒有後者，
// 等於把檢查拆掉。標「已知代價」的是調整之後仍然抓不到的情形，測試斷言它抓不到，免得有人以為已經處理。
console.log('\n── 十四、品質審查的調整：誤報要降，編造照樣要抓 ──');
const urlsOf = (a, s) => g(a, s).urls;
{
  console.log('  ▸ 括號裡的英文註解（最大宗誤報：英文名詞誤報的 69%）');
  check('中文（English）：來源有「邊緣運算」，答案補「（Edge Computing）」不算編造', terms('邊緣運算（Edge Computing）是在裝置端處理資料。', '採用邊緣運算架構').length === 0);
  check('　 公司名與全形半形括號：矽品（SPIL）、艾克爾(Amkor)（來源只有中文名）', terms('合作的有矽品（SPIL）與艾克爾(Amkor)。', '合作夥伴：矽品、艾克爾').length === 0);
  check('　 縮寫（全名，中文）：RAG（Retrieval-Augmented Generation，檢索增強生成），來源有 RAG', terms('RAG（Retrieval-Augmented Generation，檢索增強生成）是先查再答。', '搭配 RAG 後幻覺率降低').length === 0);
  check('　 反過來：Edge Computing（邊緣運算），括號裡的中文在來源裡', terms('Edge Computing（邊緣運算）讓資料就近處理。', '採用邊緣運算架構').length === 0);
  check('　 小寫的概念註解：晶片（chip）、封裝（packaging）', terms('這顆晶片（chip）採先進封裝（packaging）。', '晶片採先進封裝').length === 0);
  check('★ 不能放水：來源沒有那個中文詞，括號英文照樣標出（矽品不在來源 → SPIL 標出）', J(terms('合作的有矽品（SPIL）。', '合作夥伴包括日月光')) === J(['SPIL']));
  check('★ 不能放水：括號裡是清單就不放過：（Intel、AMD）、（Intel, AMD）', terms('合作廠商（Intel、AMD）也來了。', '合作廠商包括日月光').length >= 2 && terms('合作對象（Intel, AMD）也來了。', '合作對象包括日月光').length >= 2);
  check('★ 不能放水：泛稱不能當錨點：「合作夥伴（Intel）」「國外廠商（Boston Dynamics）」照樣標出',
    J(terms('合作夥伴（Intel）也在洽談中。', '合作夥伴：日月光、欣興')) === J(['Intel']) && terms('國外廠商（Boston Dynamics）提供授權。', '國內廠商：研華').length >= 2);
  check('★ 不能放水：括號外面編造的英文名照樣標出', J(terms('目前洽談對象包含 NVIDIA、Intel（英特爾）。', 'NVIDIA 洽談中')) === J(['Intel']));
  check('★ 不能放水：括號裡的中文不在來源 → 左邊的英文照樣標出：Intel（英特爾）', J(terms('合作對象是 Intel（英特爾）。', '合作對象是 NVIDIA')) === J(['Intel']));
  check('　 沒有中文錨點的註解仍會標出（sample.json 第 9 則的誤報示範）：知識庫沒有「物聯網」，「物聯網（IoT）」標出 IoT', J(terms('適合物聯網（IoT）場景。', '採邊緣運算架構')) === J(['IoT']));
  check('　 [已知代價] 括號左邊是來源裡的具體名詞時，編造的括號英文名會被放過：「感測節點（Bosch）」', terms('感測節點（Bosch）由國外大廠供應。', '感測節點電池續航 3 年').length === 0);
  // 上限是故意的：括號最多看 100 個、整則答案最多在來源裡找 200 次字串，用完就當「找不到」（寧可多標出，不放過）。
  // 每個括號左邊 8 個來源沒有的字加「邊緣運算」，要找 10 次才找到錨點：5 個括號（50 次）全放過，25 個（250 次）超過上限的部分照樣標出。
  const filler = '填填填填填填填填';
  const manyParens = (n) => Array.from({ length: n }, () => `${filler}邊緣運算（Edge Computing）`).join('，');
  check('★ 括號註解有查找上限：5 個括號全放過；25 個括號超過上限的部分照樣標出 Edge、Computing（失敗的方向是多標出，不是放過）',
    terms(manyParens(5), '採用邊緣運算架構').length === 0 && J(terms(manyParens(25), '採用邊緣運算架構')) === J(['Edge', 'Computing']), J(terms(manyParens(25), '採用邊緣運算架構')));
  const t0 = performance.now();
  g('合作'.repeat(30_000) + '(Intel)', '合作夥伴'); g('a '.repeat(30_000) + '(邊緣運算)', '邊緣運算'); g('(a'.repeat(30_000), '無'); g('邊緣運算('.repeat(10_000), '邊緣運算');
  const glossMs = performance.now() - t0;
  check(`★ 病態輸入（6 萬字中文／英文後接「(」、3 萬個沒閉合的左括號）不退化成平方時間：${glossMs.toFixed(0)} ms（要 < 800）`, glossMs < 800, glossMs);
}
{
  console.log('  ▸ 中英名稱對照表（NAME_ALIASES）');
  check('來源有「台積電」、答案寫 TSMC 不標；英文答案也一樣', terms('採用 TSMC 製程。', '採用台積電製程').length === 0
    && terms('The chip is manufactured with the TSMC process and ships next year to partners in the industry.', '採用台積電製程').length === 0);
  check('★ 不能放水：來源沒有台積電，TSMC 照樣標出', J(terms('採用 TSMC 製程。', '採用日月光製程')) === J(['TSMC']));
  check('　 對照表只放過那一個名字：來源有台積電，答案的 Intel 照樣標出', J(terms('採用 TSMC 與 Intel 的製程。', '採用台積電製程')) === J(['Intel']));
}
{
  console.log('  ▸ 複合量級：1 億 2,000 萬 ⇄ 1.2 億、2萬5千 ⇄ 25,000');
  check('來源「1 億 2,000 萬元」、答案「1.2 億元」', nums('累計投入約 1.2 億元', '累計投入 1 億 2,000 萬元').length === 0);
  check('　 來源「12 萬 8,000 張」、答案「128,000 張」「12.8 萬張」；來源「2萬5千顆」、答案「25,000 顆」',
    nums('共 128,000 張', '使用 12 萬 8,000 張影像').length === 0 && nums('約 12.8 萬張', '使用 12 萬 8,000 張影像').length === 0 && nums('月產能 25,000 顆', '月產能 2萬5千顆').length === 0);
  check('　 反方向：來源「1.2 億元」、答案「1 億 2,000 萬元」；來源「1 兆 2,000 億元」、答案「1.2 兆元」',
    nums('投入 1 億 2,000 萬元', '投入 1.2 億元').length === 0 && nums('受影響產值約 1.2 兆元', '受影響產值約 1 兆 2,000 億元').length === 0);
  check('★ 不能放水：數值不同照樣標出（1 億 2,000 萬 vs 1.3 億）', nums('累計投入約 1.3 億元', '累計投入 1 億 2,000 萬元').length === 1);
  check('★ 不能放水：合成後的值要拿來判斷「值不值得查」——「3 萬 3,000 次」不能因為開頭的 3 被當成小整數而整個不查', nums('下載 3 萬 3,000 次', '下載 3 萬 2,000 次').length === 1 && nums('投入 1 億 3,000 萬元', '投入 1 億 2,000 萬元').length === 1);
  check('　 兩段原本各自的寫法來源仍收：來源「1 億 2,000 萬元」，答案「2,000 萬元」', nums('其中 2,000 萬元為補助', '累計投入 1 億 2,000 萬元').length === 0);
}
{
  console.log('  ▸ 幣別：美元 ≠ 歐元 ≠ 新台幣，只寫「元」的兩邊都相容');
  check('來源 800 億美元，答案寫「800 億元」不標；寫「新台幣 800 億元」「800 億歐元」標出',
    nums('市場規模 800 億元', '市場規模 800 億美元').length === 0 && nums('市場規模新台幣 800 億元', '市場規模 800 億美元').length === 1 && nums('市場規模 800 億歐元', '市場規模 800 億美元').length === 1);
  check('　 來源 1,800 萬歐元，答案 1,800 萬美元 → 標出', nums('預算 1,800 萬美元', '預算 1,800 萬歐元').length === 1);
  check('★ 不能放水（不誤報）：同幣別、新台幣↔元、美金↔美元', nums('預算 1,800 萬歐元', '預算 1,800 萬歐元').length === 0 && nums('售價新台幣 120 萬元', '售價 120 萬元').length === 0
    && nums('售價 120 萬元', '售價新台幣 120 萬元').length === 0 && nums('預算 500 萬美金', '預算 500 萬美元').length === 0);
  check('　 [已知代價] 答案只寫「元」、沒指幣別時對任何幣別都算：來源 120 萬美元、答案「120 萬元」抓不到', nums('售價 120 萬元', '售價 120 萬美元').length === 0);
}
{
  console.log('  ▸ 季別獨立成一組、單位詞彙補「戶」「量子位元」');
  const KQ = '預計 2027 年第一季量產';
  check('來源 2027 年第一季，答案 2027 年第四季、2027 Q3 → 標出（以前「第」被當序數、年份在來源裡就整個過關）', J(nums('預計 2027 年第四季量產', KQ)) === J(['2027 年第四季']) && nums('預計 2027 Q3 量產', KQ).length === 1);
  check('★ 不能放水（不誤報）：同一季不同寫法——2027 Q1、2027 年第 1 季、Q1 2027、民國 116 年第一季', ['2027 Q1', '2027 年第 1 季', 'Q1 2027', '民國 116 年第一季'].every((a) => nums(`預計 ${a} 量產`, KQ).length === 0));
  check('　 來源只寫「明年第一季」沒寫年份，答案寫 2027 年第一季（年份在來源裡）不標；年份不在來源裡才標', nums('預計 2027 年第一季量產', '預計明年第一季量產，2027 年啟動').length === 0 && nums('預計 2029 年第一季量產', '預計明年第一季量產，2027 年啟動').length >= 1);
  check('　 單獨的「Q3」「第三季」仍然不查；年份本身已被標出就不再重複提醒季別（只標 2028 年，不再多一筆 2028 年第一季）', nums('Q3 公布財報、第三季公布', '無數字').length === 0 && J(nums('預計 2028 年第一季量產', '預計 2027 年第一季量產')) === J(['2028 年']));
  check('「64 量子位元」「86 戶農民」要查（以前不在單位表，2 位整數沒單位不查）；一致時不標', nums('2028 年將達 64 量子位元', '目標 16 量子位元').length >= 1 && nums('共 86 戶農民參與', '共 12 戶農民參與').length >= 1 && nums('共 16 量子位元', '目標 16 量子位元').length === 0);
}
{
  console.log('  ▸ 倍數 ⇄ 百分比、民國年度、量詞 billion');
  check('來源「提升 2.4 倍」、答案「增加約 140%」不標；反向「成長 200%」↔「3 倍」；2.07 倍 ⇄ 107%（不能被浮點數吃掉）',
    nums('頻寬增加約 140%', '頻寬較傳統封裝提升約 2.4 倍').length === 0 && nums('效能是 3 倍', '效能成長 200%').length === 0 && nums('效能增加 107%', '效能提升 2.07 倍').length === 0 && nums('效能是 2.07 倍', '效能成長 107%').length === 0);
  check('★ 不能放水：數值不對照樣標出（來源 2.4 倍，答案「增加 150%」）', nums('頻寬增加約 150%', '頻寬較傳統封裝提升約 2.4 倍').length === 1);
  check('民國年度：來源「115 年度」、答案「2026 年度」不標；差一年標出', nums('2026 年度預算', '115 年度預算').length === 0 && nums('2027 年度預算', '115 年度預算').length === 1);
  check('中文答案裡夾「US$10 billion」，billion 不當英文名詞（數字仍照查）', terms('市場規模約 US$10 billion。', '市場規模約 100 億美元').length === 0 && nums('市場規模約 US$20 billion。', '市場規模約 100 億美元').length === 1);
}
{
  console.log('  ▸ 網址：來源沒寫協定，模型補上 https:// 不算不同');
  check('來源「www.itri.org.tw/qc」（沒寫協定），答案「https://www.itri.org.tw/qc」不標', urlsOf('可至 https://www.itri.org.tw/qc 申請', '試用申請：www.itri.org.tw/qc（免註冊）').length === 0);
  check('★ 不能放水：來源 http、答案 https（或反過來）照舊算不同——既有決定', urlsOf('下載：https://www.itri.org.tw/media/a', '下載：http://www.itri.org.tw/media/a').length === 1 && urlsOf('下載：http://www.itri.org.tw/media/a', '下載：https://www.itri.org.tw/media/a').length === 1);
  check('★ 不能放水：路徑不同、網域不同、前面多一段網域都照樣標出', urlsOf('下載：https://www.itri.org.tw/media/b', '下載：www.itri.org.tw/media/a').length === 1
    && urlsOf('下載：https://www.itri.com.tw/media/a', '下載：www.itri.org.tw/media/a').length === 1 && urlsOf('可至 https://evil-www.itri.org.tw/qc', '申請：www.itri.org.tw/qc').length === 1);
}
{
  console.log('  ▸ 模型自己算的數字（合計、平均、倍數、取整）');
  const KB = '三年內帶動產值逾 100 億元；政府投入 120 億元，帶動民間投資 600 億元；23 所大專院校、9 家企業申請。';
  check('「平均每年約 33 億元」（100 億÷三年）、「合計約 720 億元」（120＋600）、「共 32 個單位」（23＋9）不標',
    nums('三年內帶動產值逾 100 億元，平均每年約 33 億元。', KB).length === 0 && nums('合計約 720 億元', KB).length === 0 && nums('共 32 個單位', KB).length === 0);
  check('　 倍數與比例：「民間投資相當於政府投入的 5 倍」（600÷120）、「政府投入相當於民間投資的 20%」（120÷600）不標', nums('民間投資相當於政府投入的 5 倍', KB).length === 0 && nums('政府投入相當於民間投資的 20%', KB).length === 0);
  check('　 取整只在答案寫了「約」且是同一個單位類別時才算：來源 36 位講者，「講者共 40 位」標出、「約 40 位」不標；「約 40 公里」標出（類別不同）',
    nums('講者共 40 位', '共 36 位講者').length === 1 && nums('講者約 40 位', '共 36 位講者').length === 0 && nums('講者約 40 公里', '共 36 位講者').length === 1);
  check('　 答案自己寫的其他數字也能當運算元：來源只有「總經費 100 億元」，「共 5 家，平均每家 20 億元」不標；「平均每家 30 億元」標出',
    nums('共 5 家，平均每家 20 億元', '總經費 100 億元').length === 0 && J(nums('共 5 家，平均每家 30 億元', '總經費 100 億元')) === J(['30 億元']));
  check('　 [已知代價] 要外部常數的換算仍會標出：匯率（100 億美元 → 「以 1 美元兌 32 元計算，約 3,200 億元」）', nums('以 1 美元兌 32 元計算，約 3,200 億元', '市場規模 100 億美元').length >= 1);
  check('★ 不能放水：沒有推算用語的編造數字照樣標出：「產值逾 720 億元」', nums('產值逾 720 億元', KB).length === 1);
  check('★ 不能放水：有推算用語但湊不出來、或單位對不上的照樣標出：「合計約 730 億元」「共 720 個單位」', nums('合計約 730 億元', KB).length === 1 && nums('共 720 個單位', KB).length === 1);
  const KBT = '計畫從 2024 年開始，2026 年完成第一階段，2028 年達到量產規模。';
  check('★ 不能放水：時間類不做算術放行——年份兩兩相減什麼天數都湊得出來：「整個計畫共 4 年」「相差 6 年」照樣標出', nums('整個計畫共 4 年', KBT).length === 1 && nums('相差 6 年', KBT).length === 1);
  const FAR = '政府投入 100 億元推動淨零。' + '（中間隔了很多很多的字）'.repeat(40) + '民間投資 20 億元。';
  check('★ 不能放水：兩個運算元在來源裡相隔幾百字不算推算——「合計約 120 億元」標出；同一句的才不標', nums('合計約 120 億元', FAR).length === 1 && nums('合計約 120 億元', '政府投入 100 億元，民間投資 20 億元。').length === 0);
  {
    const kb = Array.from({ length: 160 }, (_, i) => `項目${i} 的值為 ${i * 3 + 2} 億元`).join('；');
    const ans = Array.from({ length: 3000 }, (_, i) => `共 ${1000 + i * 7} 家`).join('，');
    const t = performance.now(); g(ans, kb); const ms = performance.now() - t;
    check(`★ 效能保險：3,000 個「共 N 家」不超過 1.5 秒（每則答案最多試 12 個數字；沒設上限時實測 7～11 秒）：${ms.toFixed(0)} ms`, ms < 1500, ms);
  }
}
{
  console.log('  ▸ ANSWER_GROUNDING=on:urls,terms（只提醒網址與英文名詞，數字留在影子模式）');
  const ans = '預計 2028 年量產，詳見 https://fake.example.com/x ，合作對象是 Intel。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。';
  const src = '預計 2027 年量產，合作對象是 NVIDIA。';
  const run = (mode) => captureLogs(() => withMode(mode, () => checkAnswerGrounding(ans, src, {}))).value;
  const all = run('on'), ut = run('on:urls,terms'), only = run('on:numbers');
  check('★ =on 三類都進提醒（沒指定時跟以前一樣）；=on:urls,terms 提醒只有網址與英文名詞、沒有數字', /2028/.test(all.note) && /fake\.example/.test(all.note) && /Intel/.test(all.note)
    && ut.mode === 'on' && !/2028/.test(ut.note) && /fake\.example/.test(ut.note) && /Intel/.test(ut.note), J({ all: all.note, ut: ut.note }));
  check('　 只影響提醒：回傳的 numbers 陣列與 log 照舊有數字（回測與影子期的 log 不受影響）', ut.numbers.length === 1 && ut.urls.length === 1 && ut.terms.length === 1
    && /numbers=\["2028 年"\]/.test(captureLogs(() => withMode('on:urls,terms', () => checkAnswerGrounding(ans, src, {}))).logs[0] || ''));
  const termsOnly = run('on:terms'), urlsOnly = run('on:urls');
  check('　 =on:numbers 只有數字、=on:urls 只有網址、=on:terms 只有英文名詞；大小寫與空白不影響（" ON: URLS , Terms "）',
    /2028/.test(only.note) && !/Intel/.test(only.note) && !/fake\.example/.test(only.note)
    && /fake\.example/.test(urlsOnly.note) && !/2028/.test(urlsOnly.note) && !/Intel/.test(urlsOnly.note)
    && /Intel/.test(termsOnly.note) && !/2028/.test(termsOnly.note) && !/fake\.example/.test(termsOnly.note)
    && !/2028/.test(run(' ON: URLS , Terms ').note) && /Intel/.test(run(' ON: URLS , Terms ').note) && /fake\.example/.test(run(' ON: URLS , Terms ').note), J({ only: only.note, urlsOnly: urlsOnly.note, termsOnly: termsOnly.note }));
  check('★ 寫錯的 on:… 一律當影子模式（note 空字串）：on:url、on:、on:urls,、on:urls;terms、on:nope、on :urls、on:urls,nope',
    ['on:url', 'on:', 'on:urls,', 'on:urls;terms', 'on:nope', 'on :urls', 'on:urls,nope'].every((v) => run(v).mode === 'shadow' && run(v).note === ''));
  check('★ 舊寫法完全不變：未設／shadow／ON!／true／yes／1 → 影子；off → 什麼都不做', ['ON!', 'true', 'yes', '1', '', 'shadow'].every((v) => run(v).mode === 'shadow' && run(v).note === '') && run('off').mode === 'off' && run('off').numbers.length === 0 && run(undefined).mode === 'shadow' && run(undefined).note === '');
  const onlyNum = captureLogs(() => withMode('on:urls', () => checkAnswerGrounding('預計 2028 年量產。', src, {}))).value;
  check('　 只挑 urls、而被標出的只有數字：沒有提醒（note 空字串），numbers 陣列照有', onlyNum.note === '' && onlyNum.numbers.length === 1);
  check('　 groundingMode(env)／groundingNoteKinds(env) 直接傳物件也行', groundingMode({ ANSWER_GROUNDING: 'on:terms' }) === 'on' && groundingMode({ ANSWER_GROUNDING: 'on:x' }) === 'shadow'
    && J([...groundingNoteKinds({ ANSWER_GROUNDING: 'on:urls,terms' })]) === J(['urls', 'terms']) && J([...groundingNoteKinds({})]) === J(['numbers', 'urls', 'terms']));
}
{
  console.log('  ▸ 不改的決定：SMALL_COUNT_MAX 維持 10');
  check('★ 模型照清單數出來的 6～10 項計數（公布了 6 項規格、點名了 7 家業者）不能被標出——降到 5 會讓審查補的那組正確計數 5／8 誤報',
    nums('新聞稿公布了 6 項規格：甲、乙、丙、丁、戊、己。', '甲 乙 丙 丁 戊 己').length === 0 && nums('新聞稿點名了 7 家業者。', '甲 乙 丙 丁 戊 己 庚').length === 0 && nums('共列出 9 個重點。', '一二三四五六七八九').length === 0);
  check('　 [已知代價] 編造的小計數抓不到：「目前已有 7 家客戶下單」；11 以上照查：「已有 12 家客戶下單」', nums('目前已有 7 家客戶下單', '三年內帶動產值，吸引超過 40 家廠商').length === 0 && nums('目前已有 12 家客戶下單', '三年內帶動產值，吸引超過 40 家廠商').length === 1);
}

{
  console.log('  ▸ 回測工具：照片清單算模型看過的字、誤報率的分母是「標 ok 的答案」');
  const { runBacktest, renderReport } = await import('../tools/grounding-backtest/backtest.mjs');
  const photoEv = [{ id: 'p1', name: 'P', knowledge_base: '預計 2027 年量產。', event_date: '', event_time: '', venue: '', press_contact: '',
    images: 'https://www.itri.org.tw/media/p1/a.jpg|所長展示晶圓\nhttps://www.itri.org.tw/media/p1/b.jpg｜平台全景' }];
  const photoAns = [{ event_id: 'p1', question: '有照片嗎？', answer: '有 2 張照片：\n1. 所長展示晶圓：https://www.itri.org.tw/media/p1/a.jpg\n2. 平台全景：https://www.itri.org.tw/media/p1/b.jpg', expect: 'ok' },
    { event_id: 'p1', question: '有照片嗎？', answer: '照片在 https://www.itri.org.tw/media/p1/c.jpg', expect: 'flag' }];
  const withImages = runBacktest({ events: photoEv, answers: photoAns });
  const noImages = runBacktest({ events: photoEv.map(({ images, ...e }) => e), answers: photoAns });
  check('★ 活動有照片清單：答案列出照片網址不算編造（線上模型看得到【本次活動照片】；回測沒帶就會整批誤報）；清單外的網址照樣標出',
    withImages.flagged === 1 && withImages.details[0].index === 2 && noImages.flagged === 2, J({ w: withImages.flagged, n: noImages.flagged }));
  const withPrompt = runBacktest({ events: photoEv, answers: photoAns, withPrompt: true });
  check('　 --with-prompt 時（system prompt 已含照片清單）結果相同，不會重複計算', withPrompt.flagged === 1);
  const sampleJ = JSON.parse(src('tools/grounding-backtest/sample.json'));
  const rs = runBacktest({ events: sampleJ.events, answers: sampleJ.answers });
  const lb = rs.labeled;
  check('★ 誤報率＝誤報 ÷ 標 ok 的答案（不是 ÷ 被標出的答案）：sample.json 標 ok 7 則、標 flag 4 則，誤報 1 則＝1／7，漏報 0／4',
    lb.okTotal === 7 && lb.flagTotal === 4 && lb.falseAlarm === 1 && Math.abs(lb.falseAlarmRate - 1 / 7) < 1e-9 && lb.miss === 0 && lb.missRate === 0, J(lb));
  check('　 誤報也分類別，並單獨算「只看網址＋英文名詞」（第一步只打開 on:urls,terms 時的誤報率）；每 100 則的提醒數',
    lb.falseAlarmByKind.terms === 1 && lb.falseAlarmByKind.numbers === 0 && lb.falseAlarmByKind.urls === 0 && lb.falseAlarmUrlsTerms === 1 && rs.flaggedUrlsTerms === 3);
  const txt2 = renderReport(rs, { maxDetail: 0 });
  check('　 文字報告印出誤報率、漏報率、每 100 則的提醒數', ['誤報率（標 ok 的答案被標出的比例）：1／7＝14.3%', '漏報率（標 flag 的答案沒被標出的比例）：0／4＝0.0%', '每 100 則答案會多 45.5 則提醒', '只看網址＋英文名詞（on:urls,terms 會提醒的）：3 則（27.3%）'].every((t) => txt2.includes(t)), txt2.slice(0, 600));
  const noLabel = runBacktest({ events: sampleJ.events, answers: sampleJ.answers.map(({ expect, ...a }) => a) });
  check('　 沒標 expect：不算誤報率（null），報告不印人工標註那一段', noLabel.labeled.falseAlarmRate === null && noLabel.labeled.missRate === null && !renderReport(noLabel).includes('人工標註對照'));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 132（答案出口檢查：數字、網址、英文名詞，影子模式）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
