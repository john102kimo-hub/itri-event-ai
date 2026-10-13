// 記者端答案的出口檢查：數字、網址、英文名詞，「答案裡有、模型這次看到的文字裡沒有」（批次 132）。
//
// 為什麼要有這支：lib/audience.js 的 guardBusinessAnswer() 只有企業場會檢查「金額是否出現在背景資料」。
// 記者端（網頁 api/chat.js、LINE lib/line-runtime.js askAnthropic()）完全靠 prompt 那一句「資料中沒有的數字、
// 日期、規格、人名…不要推測或補完」。記者會直接引用答案，這是風險最高的缺口，而且正好是 CLAUDE.md 第 2 條
// 說的形狀——prompt 是請求，不是保證。
//
// ⚠️ 現在是「影子模式」：預設只記一行 log、完全不改任何回覆。原因很實際：這種檢查一定有誤報（見下面
// 「已知會誤報／漏報」），沒有真實問答的誤報率就直接開，等於拿記者當測試對象。先讓朱朱用
// tools/grounding-backtest/ 丟真實問答回測，看誤報率再決定要不要把 ANSWER_GROUNDING 改成 on。
//
//   ANSWER_GROUNDING 未設或 shadow：只記 log，note 一律空字串（預設）
//   ANSWER_GROUNDING=on            ：另外回傳 note（要附在答案後面的一行提醒）
//   ANSWER_GROUNDING=on:urls,terms ：同 on，但提醒只收網址與英文名詞（on:<numbers|urls|terms 擇一或逗號接多個>；
//                                    log 與回傳的三個陣列照舊是全部）。先開這個，數字類等回測過再加（見 parseGroundingEnv()）
//   ANSWER_GROUNDING=off           ：什麼都不做，回傳空結果、不記 log
//   其他任何值                       ：當作 shadow（寧可不改回覆，也不要因為打錯字就開啟）
// 模式在「呼叫時」才讀，測試與線上改環境變數不必重啟。
//
// 純函式加少量 log：不碰網路、不碰 Sheets。檢查自己壞掉不能害記者收不到答案——checkAnswerGrounding()
// 整段包在 try/catch 裡，壞了回空結果並記一行 log。
//
// ── 比對規則（「來源」＝shownText，模型這一次看到的全部文字）───────────────────────────
// 一、正規化：NFKC（全形數字／英文／標點轉半形，％→%）、各種破折號統一成 -、去千分位逗號。
// 二、數字：來源這邊**寬鬆地收**（每一個數字都進允許集合，中文數字也轉成數值一起收），答案這邊**挑著查**。
//   比對用「數值＋單位類別」：
//     · 數值把量級字展開：100 億元＝100億＝10000 萬＝10000000000；三千＝3,000；3.5 萬＝35000；
//       百分之三十＝三成＝30%（成＝×10 的百分比）。
//     · 單位只分類別（人／名／位／家…同屬 count，年月日天同屬 time，元同屬 money，%同屬 pct…），
//       類別不同才算對不上（來源是「30 年」、答案寫「30 家」會標出）；來源沒寫單位的數字（日期 10/28、
//       條列編號）什麼類別都對得上；答案沒寫單位則只比數值。同類別內的換字（3,000 人↔3,000 名）不誤報。
//       幣別（批次 132 品質審查）：美元、歐元、新台幣…各自一類，只寫「元」的兩邊都相容（800 億美元寫成 800 億歐元會標出，
//       寫成 800 億元不會）。
//     · 日期 2026年10月28日／2026-10-28／2026.10.28／10/28 拆成各自的數字，都在來源裡就算有；
//       範圍 3–5 拆開各自比（後面有單位／量級就一起繼承：30–50 億＝30 億、50 億）。
//     · 小數與版本號（5.5、1.2.3、802.11）整串比，不拆成 5 和 5。
//     · 複合量級合成一個數：「1 億 2,000 萬」＝1.2 億＝120,000,000，「2萬5千」＝25,000。
//     · 民國年與西元年互通（來源寫 115 年、答案寫 2026 年不誤報）；倍數與百分比互通（提升 2.4 倍＝增加 140%）。
//     · 季別獨立成一組（年份＋第幾季：2027 年第一季＝2027 Q1＝Q1 2027）：「第一季」前面有「第」，一般會被當序數不查，
//       但「預計 2027 年第二季量產」被改成第四季，年份 2027 在來源裡就過關了。
//     · 模型自己算的數字（合計、平均、相差、倍數、取整）：算式推得出來的不當成編造，見 derivableFrom() 的說明。
//   「值得查」的定義（答案這邊，太瑣碎的不查，免得狂誤報）：
//     查：有小數／版本號、3 位數以上的整數（含西元年、分機、電話區段）、帶量級字（萬億兆千百）、
//         帶金額前綴（$、NT$、USD）、1～2 位整數但帶單位——時間（年月日天週…）、金額（元）、百分比與倍數
//         （%、倍、成）、度量（公里、奈米、GHz…），以及超過 10 的計數（11 位、12 家、30 場…）。
//     不查：1～2 位整數沒有單位（條列編號 1. 2. 3.、時刻 14:30 的 14 和 30、Q3 的 3）；
//         序數與編號（第 3 項、前 5 名、No.1、Top 10）；黏在英文字母後面的（H100、HBM3E、GPT4 是名詞，
//         由英文名詞那一關看）；中文的「一」＋單位（一項、一年、一倍＝「某一個」，不是數量）；
//         中文數字沒有單位的（統一、四足、二氧化碳、三星都不是數量）；「數十家、幾千人、上百家」。
//     ⚠️ 整數 ≤ 10 的計數（位名人家間項件場款個…：三位講者、兩項重點、五家廠商）也不查（SMALL_COUNT_MAX），
//         11～20 的只有前面是「共／合計／分為」才不查：那多半是模型自己數清單數出來的，來源不會逐字寫，
//         查了只會誤報。代價是模型真的編了「5 家廠商」「共 8 位講者」也抓不到（見已知漏報）。
//         ⚠️ 這個門檻是刻意的，不要降到 5：品質審查補了一組「模型照清單數出來的 6～10 項計數」（公布了 6 項規格、點名了 7 家業者），
//         降到 5 以下會讓其中 5／8 誤報，而被多抓到的編造計數只有 3／4（見 tools/grounding-backtest/README.md）。
// 三、網址與 email：答案裡的 http(s):// 或 www. 開頭網址必須原樣出現在來源（忽略結尾標點與 `)`、
//   結尾斜線、大小寫）；找不到＝編造連結（經典幻覺）。email 同理。
//   例外只有一種：來源寫的是沒有協定的 www.itri.org.tw/qc，模型好心補成 https://www.itri.org.tw/qc，不算不同；
//   來源是 http://、答案改成 https://（或反過來）照舊算不同。
// 四、英文名詞：答案裡 3 個字母以上的英文詞／縮寫，不分大小寫必須出現在來源（單複數、有無連字號視為同一個）。
//   小白名單見 TERM_WHITELIST。答案本身是英文時（記者用英文問）只查縮寫、駝峰、帶數字、連字號大寫這幾種
//   「長得像專有名詞」的，普通英文單字不查——不然整則英文答案都會被標出。
//   放過兩種「來源的詞換了個寫法」（批次 132 品質審查）：括號裡的英文註解（邊緣運算（Edge Computing），見 glossRanges()）、
//   來源中文名的英文寫法（來源有「台積電」，答案寫 TSMC，見 NAME_ALIASES）。
// 五、最後那句警語（「內容僅供參考，以…為準」與英文版）不查。
//
// ── 已知會誤報（影子模式要量的就是這些）─────────────────────────────────────────
//   · 模型自己算、但要外部常數的數字：單位換算（公尺→公里要 3.6、匯率要 32）、「約佔總經費的五成」這種算式離得太遠的。
//   · 算式推得出來、但數字前面沒有推算用語的：「較去年成長約 25%」（500 ÷ 400 − 1）、「年增 30 億元」。故意不把「成長、年增、提升」
//     加進推算用語——編造的成長率正是長這個樣子，放寬等於替它們開門。
//   · 沒有中文錨點的英文註解：知識庫沒有「物聯網」這個詞，答案寫「物聯網（IoT）」；縮寫的英文全名（TFDA（Taiwan Food and
//     Drug Administration））。
//   · 中英名稱對照表（NAME_ALIASES）沒收的名字（例如 NTUH）。
//   · 三成五↔35%、降低一半↔50%、上半年↔1 月至 6 月、1,000 瓦↔1 kW、電話改寫成 (03) 573-2100 這類換寫。
//   · 來源本身排版造成的拆字（網址中間被換行切開）。
// ── 已知會漏報 ───────────────────────────────────────────────────────────────────
//   · 小整數：來源只要在任何地方出現過同樣的小數字（日期、編號），答案裡同數值同類別就過關。
//   · 時刻：14:30 的 14 和 30 不查，「下午 2 點半」這種換寫法更沒辦法比。
//   · 同類別換字：來源寫「5 家」、答案寫「5 人」，count 類別內視為同一種。
//   · 度量單位不分：28 奈米寫成 28 微米、1.5 瓦寫成 1.5 公斤，都在 phys 類，抓不到。
//   · 幣別含糊：答案只寫「元」，對任何幣別都算（120 萬元 → 120 萬美元 抓不到）。
//   · 張冠李戴：數字在來源裡，但屬於另一件事。這支只知道「有沒有出現」，不知道「說的是不是同一件事」。
//   · 人名、公司中文名、地名：不查（中文沒有可靠的切詞）。英文人名在中文答案裡會被當英文名詞查；英文答案裡
//     首字大寫的普通名字（Intel、Samsung）不查。
//   · 沒有 http 開頭也沒有 www. 的網域（itri.org.tw/news）不當網址查。
//   · 小數目的計數（≤ 10，以及「共 N 項」≤ 20）：見上，刻意放掉。
//   · 推算放行的代價：前面有推算用語（共、合計、平均、增加、減少、佔…）的編造數字，碰巧湊得出來的會被放過（百分比最多，見 derivableFrom()）。
//   · 括號英文註解的代價：括號左邊是來源裡的具體名詞時（感測節點（Bosch）、晶片（Intel）），括號裡編造的英文名會被放過；
//     「合作夥伴（Intel）」這類泛稱（GLOSS_GENERIC）與清單（Intel、AMD）照樣標出。
//   · 順著記者的問題說：記者問「聽說投資超過 500 億元，對嗎？」，模型回「是的，500 億元」，問題是 shownText 的一部分，
//     500 億元就「有出處」了。要擋得讓呼叫端把記者的話另外傳（opts.userText），目前沒做。

const MAX_ANSWER_CHARS = 60_000;
const MAX_SOURCE_CHARS = 1_000_000;
const MAX_ITEMS_PER_KIND = 30;
const MAX_NOTE_ITEMS = 3;

// 提醒可以收的三類（批次 132 品質審查）。
const NOTE_KINDS = ['numbers', 'urls', 'terms'];

// ANSWER_GROUNDING 的完整寫法：off／shadow（預設）／on／on:urls,terms。
//   on:<類別> 只讓指定的類別進提醒（numbers、urls、terms 擇一，或用逗號接多個）；其他類別照樣記 log、照樣出現在回傳的陣列裡，
//   所以回測與 log 對照不受影響。
//   為什麼要有：三類的誤報率差很多。品質審查拿 310 則自擬的答案量（見 tools/grounding-backtest/README.md「規則調整之後的數字」）：
//   只看網址＋英文名詞，沒編造的答案被標出約 2%；數字那類約 6%，而且有一大塊是模型自己算的合計與換算（算式推得出來的已經放過，
//   但單位換算、匯率這類要外部常數的仍會標）。所以打開 on 的第一步可以只提醒網址與英文名詞（on:urls,terms），
//   數字等真實問答回測過再加進來（改成 on 或 on:numbers,urls,terms）。仍然只讀 ANSWER_GROUNDING 這一個環境變數（test-batch132 的紀律）。
//   寫錯的 on:…（類別名稱打錯、空的、用分號）一律當影子模式，跟「寧可不改回覆，也不要因為打錯字就開啟」同一個原則。
function parseGroundingEnv(env) {
  const v = String(env?.ANSWER_GROUNDING ?? '').trim().toLowerCase();
  if (v === 'off') return { mode: 'off', kinds: new Set(NOTE_KINDS) };
  if (v === 'on') return { mode: 'on', kinds: new Set(NOTE_KINDS) };
  const m = /^on:\s*([a-z]+(?:\s*,\s*[a-z]+)*)$/.exec(v);
  if (m) {
    const picked = m[1].split(/\s*,\s*/);
    if (picked.every((k) => NOTE_KINDS.includes(k))) return { mode: 'on', kinds: new Set(picked) };
  }
  return { mode: 'shadow', kinds: new Set(NOTE_KINDS) };
}

/** ANSWER_GROUNDING：on／off／shadow（預設）。每次呼叫才讀。on:<類別> 也是 on（挑哪幾類進提醒見 groundingNoteKinds()）。 */
export function groundingMode(env = process.env) {
  return parseGroundingEnv(env).mode;
}

/** =on 時，哪幾類被標出的項目要寫進提醒（見 parseGroundingEnv()）；沒指定就是三類都要。 */
export function groundingNoteKinds(env = process.env) {
  return parseGroundingEnv(env).kinds;
}

// ───────────────────────── 正規化 ─────────────────────────
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63]/g;   // ‐ ‑ ‒ – — ― − 統一成 ASCII 的 -
const TILDE_RE = /[\u301C\u223C\u2053]/g;                // 〜 ∼ ⁓ 統一成 ~
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;   // 軟連字號、零寬空白、BOM
// 千分位逗號：逗號前是數字、後面剛好三位數字且不再接數字（2024,2025 與 1,2,3 不是千分位）
const THOUSANDS_RE = /(?<=\d),(?=\d{3}(?!\d))/g;

/** NFKC＋統一破折號／波浪號＋去千分位逗號。null／undefined 回空字串。 */
export function normalizeForGrounding(text) {
  let s = text == null ? '' : String(text);
  s = s.normalize('NFKC');
  return s.replace(INVISIBLE_RE, '').replace(DASH_RE, '-').replace(TILDE_RE, '~').replace(THOUSANDS_RE, '');
}

// ───────────────────────── 警語 ─────────────────────────
const DISCLAIMER_TRIGGER_RE = /僅供參考|仅供参考|for reference only|for informational purposes only/gi;
const CLAUSE_BREAK_RE = /[\n。！？!?，,；;（(「]/;

/**
 * 把答案最後那句警語拿掉（規則 4）。只認「在結尾 200 字以內」的觸發詞，從觸發詞所在的那個子句開頭切到結尾——
 * 警語前面的正文（可能含數字）留著照查，所以只往前退到上一個逗號／句號／換行／左括號。
 */
export function stripDisclaimer(text) {
  const s = text == null ? '' : String(text);
  let last = -1;
  for (const m of s.matchAll(DISCLAIMER_TRIGGER_RE)) last = m.index;
  if (last < 0 || s.length - last > 200) return s;
  let start = last;
  while (start > 0 && !CLAUSE_BREAK_RE.test(s[start - 1])) start--;
  return s.slice(0, start);
}

// ───────────────────────── 網址與 email ─────────────────────────
// 在 NFKC 之前抽：NFKC 會把全形逗號、驚嘆號變成 ASCII，網址後面緊接全形標點再接英文時會被黏進網址裡。
// 字元集只收 ASCII 的網址字元，中文字與全形標點自然截斷；[ ] < > " ` { } | 不收（Markdown 連結 [x](url) 才抽得乾淨）。
const URL_RE = /(?:https?:\/\/|www\.)[A-Za-z0-9][A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]*/gi;
// 長度都設上限：沒有 @ 的超長英數字串不會讓比對退化成平方時間
const EMAIL_RE = /[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63}){1,4}/g;
// 網址結尾的標點（句點、逗號、右括號…）：從尾端逐字修剪，不用 /[…]+$/ 這種 regex。
// 批次 132 審查：那種「沒有對開頭定錨、只對結尾定錨」的 regex 遇到「一長串標點後面接一個英數字」
// （https://a........a）時，每個起點都往後掃到串尾才失敗，是平方時間——記者一則 8000 字的訊息就能讓每次回答
// 多卡約 0.8 秒（URL_RE 的字元集剛好包含這些標點，整串會被吃成一個網址）。逐字修剪是線性的，結果與原 regex 完全相同。
const URL_TRAIL_CHARS = new Set(Array.from(`.,;:!?'"*)]}>`));

function trimUrl(u) {
  let e = u.length;
  while (e > 0 && URL_TRAIL_CHARS.has(u[e - 1])) e--;
  return e === u.length ? u : u.slice(0, e);
}
function urlKey(raw) {
  const k = trimUrl(String(raw)).toLowerCase();
  let e = k.length;
  while (e > 0 && k[e - 1] === '/') e--;
  return e === k.length ? k : k.slice(0, e);
}

/** 抽出文字裡的網址與 email：[{ raw, key }]（raw 是去掉結尾標點後的原樣，key 是比對用）。 */
export function extractUrls(text) {
  const s = text == null ? '' : String(text);
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const key = urlKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ raw, key });
  };
  for (const m of s.matchAll(URL_RE)) push(trimUrl(m[0]));
  if (s.includes('@')) for (const m of s.replace(URL_RE, ' ').matchAll(EMAIL_RE)) push(m[0]);
  return out;
}

// 網址與 email 先挖掉再查數字與英文：網址裡的 2026、www、org 不該被當成答案裡的數字或英文名詞
function maskLinks(text) {
  let s = text == null ? '' : String(text);
  s = s.replace(URL_RE, ' ');
  if (s.includes('@')) s = s.replace(EMAIL_RE, ' ');
  return s;
}

// 集合裡找不到時的最後一搏：在來源裡找「前後都剛好切齊」的出現——前面不能還黏著網址／email 字元
// （ess@x.com 不能靠 press@x.com 過關），後面不能再接網址字元（https://x.com/a 不能靠 https://x.com/ab 過關）。
// 後面的斜線例外：引用某個真實網址的上層路徑，不算編造。
function appearsAsUrl(lowerSource, key, bareOnly = false) {
  let from = 0;
  for (;;) {
    const i = lowerSource.indexOf(key, from);
    if (i < 0) return false;
    const prev = lowerSource[i - 1];
    const next = lowerSource[i + key.length];
    // bareOnly：來源裡這個出現處前面不能是「://」——否則是 http://… 被模型改成 https://…，那照舊算不同
    if ((!prev || !/[A-Za-z0-9._%+\-@]/.test(prev)) && (!next || !/[A-Za-z0-9._~%=&+#@?:\-]/.test(next)) && !(bareOnly && lowerSource.slice(Math.max(0, i - 3), i) === '://')) return true;
    from = i + 1;
  }
}

// ───────────────────────── 數字：十進位字串運算 ─────────────────────────
// 量級都是 10 的次方，用字串移小數點，不用浮點數（1.1 億 不會變成 110000000.00000001）。
const PLAIN_INT_RE = /^(?:[1-9]\d*|0)$/;
function canonDecimal(s) {
  if (PLAIN_INT_RE.test(s)) return s;                              // 絕大多數是乾淨的整數，走捷徑
  let [i, f = ''] = String(s).split('.');
  i = i.replace(/^0+(?=\d)/, '') || '0';
  f = f.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}
function shiftDecimal(s, n) {
  if (!n) return canonDecimal(s);
  const [i, f = ''] = String(s).split('.');
  const digits = i + f;
  const point = i.length + n;
  const out = point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return canonDecimal(out);
}

// ── 中文數字 → 十進位字串 ──
const CN_DIGIT = new Map(Object.entries({ 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }));
const CN_SMALL = new Map(Object.entries({ 十: 10, 百: 100, 千: 1000 }));
const CN_BIG = new Map(Object.entries({ 萬: 1e4, 億: 1e8, 兆: 1e12 }));
const CN_BIG_EXP = new Map(Object.entries({ 萬: 4, 億: 8, 兆: 12 }));

function cnPositional(s) {
  let out = '';
  for (const ch of s) {
    const d = CN_DIGIT.get(ch);
    if (d === undefined) return null;
    out += d;
  }
  return out;
}

/** 二〇二六→2026（逐位）；三千→3000、十二→12、一百零五→105、三萬五千→35000、一億兩千萬→120000000。看不懂回 null。 */
export function cnIntToDecimal(s) {
  if (!/[十百千萬億兆]/.test(s)) {
    const p = cnPositional(s);
    return p == null ? null : canonDecimal(p);
  }
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (CN_DIGIT.has(ch)) num = CN_DIGIT.get(ch);
    else if (CN_SMALL.has(ch)) { section += (num || 1) * CN_SMALL.get(ch); num = 0; } // 「十二」開頭沒有數字＝1×10
    else if (CN_BIG.has(ch)) {
      const sec = section + num;
      total = sec === 0 ? (total || 1) * CN_BIG.get(ch) : total + sec * CN_BIG.get(ch); // 萬億＝萬×億
      section = 0; num = 0;
    } else return null;
  }
  total += section + num;
  return total > 1e15 ? null : String(total);
}

function parseCnRun(run) {
  const dot = run.indexOf('點');
  if (dot < 0) {
    const face = cnIntToDecimal(run);
    return face == null ? null : { face, exp: 0 };
  }
  const left = cnIntToDecimal(run.slice(0, dot));
  const m = /^([零〇一二三四五六七八九]+)([萬億兆]*)$/.exec(run.slice(dot + 1));
  if (left == null || !m) return null;
  let exp = 0;
  for (const ch of m[2]) exp += CN_BIG_EXP.get(ch);
  return { face: canonDecimal(`${left}.${cnPositional(m[1])}`), exp };
}

// ── 量級字與單位 ──
const SCALE_EXP = { 兆: 12, 億: 8, 千萬: 7, 百萬: 6, 萬: 4, 千: 3, 百: 2, trillion: 12, billion: 9, million: 6, thousand: 3 };
// 千瓦、兆瓦、百分點是單位，不是「千」「兆」「百」加一個字
const SCALE_GUARD = { 千: '(?!瓦|位元|克|公)', 兆: '(?!瓦|赫|位元)', 百: '(?!分)' };

const UNITS = {
  pct: ['%', '‰', '個百分點', '百分點', 'percent'],
  mult: ['倍', '成'],
  money: ['元', '塊', '圓', 'dollar', 'dollars'],
  'money:usd': ['美元', '美金'],
  'money:twd': ['台幣', '臺幣', '新台幣', '新臺幣'],
  'money:jpy': ['日圓', '日幣'],
  'money:eur': ['歐元'],
  'money:cny': ['人民幣'],
  'money:krw': ['韓元'],
  'money:hkd': ['港幣'],
  'money:gbp': ['英鎊'],
  time: ['年', '月', '日', '天', '週', '周', '季', '秒', '世紀', '小時', '分鐘', '週年', '周年', '個月', '年度', '學年', '歲', '星期',
    'year', 'years', 'month', 'months', 'day', 'days', 'week', 'weeks', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'ms', 'ns'],
  count: ['位', '名', '人', '家', '間', '項', '件', '場', '款', '個', '隻', '台', '臺', '套', '組', '篇', '次', '座', '棟', '條', '張', '輛', '架', '艘', '顆', '片', '戶', '量子位元',
    '種', '類', '批', '則', '筆', '檔', '部', '所', '校', '院', '國', '縣', '市', '區', '樓', '號', '級', '期', '屆', '梯次', '人次', '家次', '場次',
    'people', 'companies', 'countries', 'partners', 'patents', 'units', 'firms', 'institutions', 'speakers', 'qubit', 'qubits', 'bit', 'bits'],
  phys: ['公里', '公尺', '公分', '公釐', '公噸', '公斤', '公克', '公升', '毫升', '毫米', '奈米', '微米', '英吋', '英尺', '英里', '吋', '坪', '公頃', '平方公尺',
    '平方公里', '噸', '瓦', '千瓦', '兆瓦', '吉瓦', '伏', '安培', '赫茲', '位元', '位元組', '馬力', '度', '攝氏度',
    'nm', 'μm', 'um', 'mm', 'cm', 'km', 'kg', 'mg', 'Hz', 'kHz', 'MHz', 'GHz', 'THz', 'GB', 'TB', 'PB', 'MB', 'KB', 'Gb', 'Tb', 'Mb',
    'Gbps', 'Mbps', 'Kbps', 'bps', 'fps', 'ppm', 'rpm', 'psi', 'dB', 'kV', 'mV', 'kW', 'MW', 'GW', 'TW', 'kWh', 'MWh', 'GWh', 'TWh',
    'Wh', 'mAh', 'Ah', 'TOPS', 'TFLOPS', 'GFLOPS', 'FLOPS', 'nits', 'nit', '°C', '°F']
};
// 只有「黏在數字後面」才算單位的單字母（15W、3m、5V）：隔一個空白的 5 A、3 m 太容易是別的意思
const GLUED_UNITS = ['m', 'g', 't', 'L', 'W', 'V', 'A'];

const UNIT_CLASS = new Map();
for (const [cls, list] of Object.entries(UNITS)) for (const u of list) UNIT_CLASS.set(u, cls);
for (const u of GLUED_UNITS) UNIT_CLASS.set(u, 'phys');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function altOf(list, guards = {}) {
  // 長的排前面：千瓦 要先於 千、個月 要先於 個
  return [...new Set(list)].sort((a, b) => b.length - a.length)
    .map((u) => esc(u) + (guards[u] || '') + (/[A-Za-z]$/.test(u) ? '(?![A-Za-z])' : ''))
    .join('|');
}
const SCALE_ALT = altOf(Object.keys(SCALE_EXP), SCALE_GUARD);
const UNIT_ALT = altOf(Object.values(UNITS).flat());
const GLUED_ALT = altOf(GLUED_UNITS);

const CN_START = '零〇一二兩三四五六七八九十百千';
const CN_BODY = '零〇一二兩三四五六七八九十百千萬億兆';
const CN_RUN = `[${CN_START}][${CN_BODY}]*(?:點[零〇一二三四五六七八九]+[萬億兆]*)?`;
const AR_NUM = '\\d+(?:\\.\\d+)*';

// 三條路線同一個位置只會走一條：百分之N → 阿拉伯數字（可接量級與單位）→ 中文數字（可接單位）。
// 沒有任何一段會回頭重試，所以不會有災難性回溯。
const NUMBER_RE = new RegExp(
  `百分之(?<pz>${CN_RUN}|${AR_NUM})` +
  `|(?<ar>${AR_NUM})(?: ?(?<arsc>${SCALE_ALT}))?(?:(?: ?(?<aru>${UNIT_ALT}))|(?<arg>${GLUED_ALT}))?` +
  `|(?<cn>${CN_RUN})(?:(?:多|餘)? ?(?<cnu>${UNIT_ALT}))?`,
  'g'
);

// 每個欄位都明寫（不用 {...預設, ...over}）：來源索引一次要建上千個 token，展開運算子是這裡最大的成本
function makeToken(o) {
  return {
    raw: o.raw, start: o.start, end: o.end, kind: o.kind || 'ar', face: o.face, exp: o.exp || 0, cls: o.cls || '-', mag: o.mag,
    decimal: !!o.decimal, unit: o.unit || '', suffix: o.suffix || '', extra: [], cnStrong: o.cnStrong, cnBig: o.cnBig
  };
}

/**
 * 掃出文字裡所有的數字（含中文數字），每一個都帶「數值＋單位類別」。不判斷值不值得查——來源那邊全收，
 * 答案那邊再用 isCheckworthy() 挑。text 要先 normalizeForGrounding()。
 */
export function scanNumbers(text) {
  let toks = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const g = m.groups;
    const start = m.index;
    const end = start + m[0].length;
    const raw = m[0].trim();

    if (g.pz !== undefined) {                                     // 百分之三十、百分之 30
      const face = /^\d/.test(g.pz) ? canonDecimal(g.pz) : parseCnRun(g.pz)?.face;
      if (face == null) continue;
      toks.push(makeToken({ raw, start, end, kind: 'pct', face, cls: 'pct', mag: face, unit: '%' }));
      continue;
    }

    if (g.ar !== undefined) {
      const segs = g.ar.split('.');
      if (segs.length >= 3) {                                     // 2026.10.28 是日期；其餘（1.2.3、192.168.0.1）整串當版本號
        if (/^(?:19|20)\d\d$/.test(segs[0]) && segs[1].length <= 2 && segs[2].length <= 2 && segs.length === 3) {
          let at = start;
          for (const seg of segs) {
            toks.push(makeToken({ raw: seg, start: at, end: at + seg.length, face: canonDecimal(seg), mag: canonDecimal(seg) }));
            at += seg.length + 1;
          }
        } else {
          toks.push(makeToken({ raw: g.ar, start, end: start + g.ar.length, kind: 'ver', face: g.ar, mag: `v:${g.ar}` }));
        }
        continue;
      }
      const unit = g.aru || g.arg || '';
      let exp = g.arsc ? SCALE_EXP[g.arsc] : 0;
      let cls = unit ? UNIT_CLASS.get(unit) || '-' : '-';
      if (unit === '成') { exp += 1; cls = 'pct'; }                  // 三成＝30%
      if (cls === 'money') cls = prefixMoneyCls(text, start) || cls;
      const face = canonDecimal(g.ar.slice(0, 40));
      toks.push(makeToken({
        raw, start, end, face, exp, cls, unit, decimal: segs.length === 2,
        suffix: raw.slice(g.ar.length).trim(), mag: shiftDecimal(g.ar.slice(0, 40), exp)
      }));
      continue;
    }

    const p = parseCnRun(g.cn);                                   // 三千、十二、二〇二六、兩億
    if (!p) continue;
    const unit = g.cnu || '';
    let exp = p.exp;
    let cls = unit ? UNIT_CLASS.get(unit) || '-' : '-';
    if (unit === '成') { exp += 1; cls = 'pct'; }
    toks.push(makeToken({
      raw, start, end, kind: 'cn', face: p.face, exp, cls, unit, mag: shiftDecimal(p.face, exp),
      // 這一串是不是「真的像一個數量」：開頭要是數字字（或十），並記下有沒有萬億兆
      cnStrong: /^[零〇一二兩三四五六七八九十]/.test(g.cn),
      cnBig: /[萬億兆]/.test(g.cn)
    }));
  }
  toks = mergeCompoundScales(toks, text);
  inheritRanges(toks, text);
  addDerivedKeys(toks);
  return toks;
}

// 批次 132 品質審查：複合量級。新聞稿常寫「1 億 2,000 萬元」「12 萬 8,000 張」「2萬5千顆」，模型改寫成「1.2 億元」「128,000 張」
// 「25,000 顆」（或反過來）；兩邊都是兩個 token，各自湊不回完整的值。相鄰、前面是萬／億／兆、後面量級比它小的兩段合成一個
// 數，原本兩段留在 extra（來源那邊兩種都收）。
function addDecimal(x, y) {
  const [xi, xf = ''] = String(x).split('.');
  const [yi, yf = ''] = String(y).split('.');
  const n = Math.max(xf.length, yf.length);
  const sum = BigInt(xi + xf.padEnd(n, '0')) + BigInt(yi + yf.padEnd(n, '0'));
  const s = sum.toString().padStart(n + 1, '0');
  return canonDecimal(n ? `${s.slice(0, s.length - n)}.${s.slice(s.length - n)}` : s);
}
function mergeCompoundScales(toks, text) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (b && a.kind === 'ar' && b.kind === 'ar' && a.exp >= 4 && !a.unit && b.exp < a.exp && b.cls !== 'pct'
      && text.slice(a.end, b.start).length <= 1 && !text.slice(a.end, b.start).trim() && (b.exp > 0 || b.face.length >= 3)) {
      const mag = addDecimal(a.mag, b.mag);   // face 也要用合成後的值：isCheckworthy／isSmallPlainCount 看的是 face，沿用 a.face（「3 萬 3,000 次」的 3）會被當成小整數計數而整個不查
      const m = makeToken({ raw: `${a.raw} ${b.raw}`, start: a.start, end: b.end, face: mag, exp: 0, cls: b.cls, unit: b.unit, mag });
      m.extra = [{ cls: a.cls, mag: a.mag }, { cls: b.cls, mag: b.mag }];
      out.push(m); i++;
    } else out.push(a);
  }
  return out;
}

const PREFIX_MONEY = [[/(?:新台幣|新臺幣|台幣|臺幣|NT\$|NTD|TWD) ?$/, 'money:twd'], [/(?:美金|美元|US\$|USD) ?$/, 'money:usd'], [/(?:歐元|EUR|€) ?$/, 'money:eur'], [/(?:日圓|日幣|JPY|¥) ?$/, 'money:jpy'], [/(?:人民幣|RMB|CNY) ?$/, 'money:cny']];
function prefixMoneyCls(text, at) {
  const before = text.slice(Math.max(0, at - 6), at);
  for (const [re, cls] of PREFIX_MONEY) if (re.test(before)) return cls;
  return '';
}

// 3–5 億、30 至 50 家、1-2 週：前面那個沒有單位，就繼承後面的量級與單位
const RANGE_GAP_RE = /^ ?(?:-|~|至|到) ?$/;
function inheritRanges(toks, text) {
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (a.kind !== 'ar' || b.kind !== 'ar') continue;
    if (a.cls !== '-' || a.exp || (b.cls === '-' && !b.exp)) continue;
    if (!RANGE_GAP_RE.test(text.slice(a.end, b.start))) continue;
    a.extra.push({ cls: '-', mag: a.mag });                        // 來源那邊：繼承是猜的，原本的裸數字也留著
    a.cls = b.cls; a.exp = b.exp; a.unit = b.unit;
    a.mag = shiftDecimal(a.face, b.exp);
    a.suffix = b.suffix;
    a.raw = `${a.raw} ${b.suffix}`.trim();
    a.inherited = true;
  }
}

// 同一個數量的另一種寫法，多收一把鑰匙：
//   · 民國年與西元年互通（來源「115 年」、答案「2026 年」不誤報；「115 年度」＝「2026 年度」，批次 132 品質審查）。
//   · 倍數與百分比互通（批次 132 品質審查）：「提升 2.4 倍」與「增加約 140%」是同一件事（「提升三倍」有時指 3 倍、有時指 +300%，
//     兩種都收）；百分比 ≥ 100 的反向也收。代價：來源寫 3 倍，答案寫 200% 或 300% 也過關——測不出來的編造，實測有編造的答案漏報數沒變。
function addDerivedKeys(toks) {
  for (const t of toks) {
    if (t.exp) continue;
    if (t.cls === 'mult' && t.unit === '倍') {
      const n = Number(t.face);
      if (n >= 1 && n <= 1000) {
        t.extra.push({ cls: 'pct', mag: canonDecimal(String(Math.round((n - 1) * 1e6) / 1e4)) });
        t.extra.push({ cls: 'pct', mag: canonDecimal(String(Math.round(n * 1e6) / 1e4)) });
      }
    } else if (t.cls === 'pct' && t.unit === '%') {
      const n = Number(t.face);
      if (n >= 100 && n <= 10000) {                                   // 用整數運算，免得 1.07 + 1 變成 2.0700000000000003
        t.extra.push({ cls: 'mult', mag: shiftDecimal(t.face, -2) });
        t.extra.push({ cls: 'mult', mag: canonDecimal(String(Math.round(n * 1e4 + 1e6) / 1e6)) });
      }
    }
    if (t.unit !== '年' && t.unit !== '年度') continue;
    const y = Number(t.face);
    if (!Number.isInteger(y)) continue;
    if (y >= 1912 && y <= 2100) t.extra.push({ cls: 'time', mag: String(y - 1911) });
    else if (y >= 1 && y <= 200) t.extra.push({ cls: 'time', mag: String(y + 1911) });
  }
}

const keysOf = (t) => [{ cls: t.cls, mag: t.mag }, ...t.extra];

// 「某某 N 位／項／家／場／件」這種小數量，多半是模型自己數清單數出來的（三位講者、兩項重點、五家廠商），
// 來源不會逐字寫出來。整數 ≤ 10 的計數類不查；11～20 只有前面有「共／合計」才不查（見 DERIVED_COUNT_BEFORE_RE）。
// 代價：模型真的編了「5 家廠商」也抓不到（已知漏報）。門檻放在這裡，回測後覺得太鬆或太緊就改這一個數字。
export const SMALL_COUNT_MAX = 10;
const isSmallPlainCount = (t) => t.cls === 'count' && !t.exp && !t.decimal && Number(t.face) <= SMALL_COUNT_MAX;
const isDerivedCount = (t, before) => t.cls === 'count' && !t.exp && !t.decimal && Number(t.face) <= 20 && DERIVED_COUNT_BEFORE_RE.test(before);

const ORDINAL_BEFORE_RE = /(?:第|前|[Nn]o\.?|[Tt]op|#) ?$/;
const CN_NOT_QUANTITY_BEFORE_RE = /[第前幾數上好]$/;
const DERIVED_COUNT_BEFORE_RE = /(?:共有|總共|一共|共計|合計|總計|分為|分成|共) ?$/;
const CURRENCY_BEFORE_RE = /(?:NT\$|US\$|HK\$|\$|USD|NTD|TWD|RMB|CNY|JPY|EUR|€|£|¥) ?$/;

/** 答案裡的這個數字值不值得查（定義見檔頭「值得查」）。text 是 scanNumbers() 掃的那份。 */
export function isCheckworthy(t, text) {
  const before = text.slice(Math.max(0, t.start - 6), t.start);
  if (ORDINAL_BEFORE_RE.test(before)) return false;

  if (t.kind === 'cn') {
    if (CN_NOT_QUANTITY_BEFORE_RE.test(before)) return false;      // 數十、幾千、好幾百、上百
    if (!t.cnStrong) return false;                                 // 百姓、千里：不是數字開頭
    // 一項、一位、一家、一年＝「某一個」，不是數量；「一成」是真的 10%，留著查
    if ((t.face === '1' || t.face === '0') && t.unit !== '成') return false;
    if (isSmallPlainCount(t) || isDerivedCount(t, before)) return false;
    return t.cls !== '-' || t.cnBig;                               // 沒有單位的中文數字不查
  }

  if (t.kind === 'pct') return t.face !== '100';                   // 百分之百是慣用語（完全、全部）
  if (t.kind === 'ver') return true;

  const currency = CURRENCY_BEFORE_RE.test(before);
  if (!currency && /[A-Za-z]$/.test(before)) return false;         // H100、HBM3E、GPT4：交給英文名詞那一關
  if (isSmallPlainCount(t) || isDerivedCount(t, before)) return false;
  if (t.decimal) return true;
  if (t.cls !== '-' || t.exp > 0 || currency) return true;
  return t.face.split('.')[0].length >= 3;
}

// 批次 132 品質審查：季別。「第一季」前面有「第」，被當成序數整個不查；「預計 2027 年第二季量產」編成第四季，年份 2027 在來源裡就過關了。
// 季別獨立成一組：年份＋第幾季（2027 年第一季、2027 Q1、Q1 2027、民國 116 年第一季 都是同一把鑰匙）。
const Q_NUM = { 一: 1, 二: 2, 三: 3, 四: 4 };
const qn = (s) => Q_NUM[s] || Number(s);
const QUARTER_YEAR_RES = [
  [/(\d{4}) ?年(?:度)? ?第 ?([1-4一二三四]) ?季/g, 1, 2],
  [/(\d{4}) ?年? ?[Qq] ?([1-4])(?![0-9A-Za-z])/g, 1, 2],
  [/(?<![A-Za-z0-9])[Qq] ?([1-4]),? ?(?:of )?(\d{4})(?!\d)/g, 2, 1],
  [/民國 ?(\d{2,3}) ?年(?:度)? ?第 ?([1-4一二三四]) ?季/g, -1, 2]
];
export function scanQuarters(text) {
  const out = [];
  for (const [re, yi, qi] of QUARTER_YEAR_RES) {
    for (const m of text.matchAll(re)) {
      const year = yi === -1 ? String(Number(m[1]) + 1911) : m[yi];
      out.push({ raw: m[0], year, q: qn(m[qi]) });
    }
  }
  return out;
}
function quarterMisses(body, idx) {
  const out = [];
  for (const q of scanQuarters(body)) {
    const ok = idx.quarters.has(`${q.year}-${q.q}`) || (idx.quarters.has(`q${q.q}`) && idx.numAny.has(q.year));   // 來源只寫「第一季」沒寫年份時，年份在來源裡也算
    if (!ok && !out.includes(q.raw)) out.push(q.raw);
  }
  return out;
}

// 回傳每個值得查的數字（不去重，帶位置），以及它們所在的那份正規化文字
function numberItems(text) {
  const body = normalizeForGrounding(maskLinks(text));
  const items = [];
  for (const t of scanNumbers(body)) {
    if (!isCheckworthy(t, body)) continue;
    // 金額前綴（NT$、US$）一起顯示，不然提醒裡只剩一個「5000」看不出是錢
    const cur = CURRENCY_BEFORE_RE.exec(body.slice(Math.max(0, t.start - 6), t.start));
    items.push({ raw: cur ? `${cur[0].trim()}${t.raw}` : t.raw, cls: t.cls, mag: t.mag, start: t.start, end: t.end });
  }
  return { items, body };
}

/** 抽出答案裡值得查的數字：[{ raw, cls, mag }]（raw 是正規化後的原樣，例如「3000 人」），同樣的 raw 只留一筆。 */
export function extractNumbers(text) {
  const seen = new Set();
  return numberItems(text).items
    .filter((it) => !seen.has(it.raw) && seen.add(it.raw))
    .map(({ raw, cls, mag }) => ({ raw, cls, mag }));
}

// 電話 0800-123-456 會被拆成 0800、123、456 三個數字各自比；標出來時合回一筆，提醒才看得懂
function mergeDashed(bad, body) {
  const out = [];
  for (const it of bad) {
    const prev = out[out.length - 1];
    if (prev && prev.end + 1 === it.start && body[prev.end] === '-') {
      prev.raw = body.slice(prev.start, it.end);
      prev.end = it.end;
    } else out.push({ ...it });
  }
  return [...new Set(out.map((x) => x.raw))];
}

// ───────────────────────── 英文名詞 ─────────────────────────
// 小白名單（小寫、去連字號）：這些詞答案裡出現不代表編造——
//   · 機器人與平台自己的名字與通用縮寫：LINE、PDF、URL、Email、ITRI、FAQ、App、Web
//   · 網址片段與格式名：www、http、https、com、org、net、html、json、mailto
//   · 職稱縮寫：CEO、CTO…、Dr、Prof（中文職稱的英文寫法，不是新的事實）
//   · 貨幣代碼與單位字：USD、NTD、kWh、GHz、TOPS…（單位已由數字那一關管；這裡只擋單位字本身被當英文名詞）
//   · 中文答案裡夾的虛字：etc、vs、via、per、the、and、for、with、not、okay
// 刻意不放：Wi-Fi、5G、GPU、NVIDIA、TSMC 這類技術與公司名——那正是要查的東西。
const TERM_WHITELIST = new Set([
  'line', 'pdf', 'url', 'urls', 'email', 'mail', 'mailto', 'itri', 'faq', 'app', 'apps', 'web', 'www', 'http', 'https',
  'com', 'org', 'net', 'html', 'json', 'ok', 'okay', 'etc', 'vs', 'via', 'per', 'the', 'and', 'for', 'with', 'not',
  'ceo', 'cto', 'cfo', 'coo', 'dr', 'prof', 'mr', 'mrs', 'ms',
  'billion', 'million', 'trillion', 'thousand', 'percent', 'dollars', 'dollar',   // 批次 132 品質審查：量詞（中文答案裡夾「US$10 billion」）
  'usd', 'ntd', 'twd', 'rmb', 'cny', 'jpy', 'eur',
  'kwh', 'mwh', 'gwh', 'twh', 'khz', 'mhz', 'ghz', 'thz', 'kbps', 'mbps', 'gbps', 'tops', 'flops', 'tflops', 'gflops', 'mah'
]);
export const GROUNDING_TERM_WHITELIST = TERM_WHITELIST;

// 前面不能是英數字：100kWh 的 kWh、5nm 的 nm 是黏在數字後面的單位，不是獨立的英文詞
const LATIN_TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g;

// 常見機構／公司的中英對照（批次 132 品質審查）。來源寫「台積電」、答案寫 TSMC，或英文答案裡把「聯發科」寫成 MediaTek，
// 是同一個名字的另一種寫法，不是編造（量過：沒編造的答案被標出 9.4% → 7.6%；記者用英文問時最明顯，11 則沒編造的英文答案
// 有 6 則因為這個被標出）。只收新聞稿常出現、英文寫法固定的；來源裡出現中文名，答案才能用英文名——來源沒有「台積電」，
// TSMC 照樣標出。故意不收「Delta」這種普通英文字（來源有台達電，整篇答案的 delta 都放行）。
// 表要隨用隨補：朱朱回測真實問答後，把 Top 20 被標出的英文名詞裡「其實是來源中文名的英文寫法」加進來，不要憑空擴充。
const NAME_ALIASES = [
  ['台積電', 'TSMC'], ['聯發科', 'MediaTek'], ['鴻海', 'Foxconn', 'Hon Hai'], ['日月光', 'ASE'], ['欣興', 'Unimicron'], ['力成', 'PTI', 'Powertech'],
  ['研華', 'Advantech'], ['盟立', 'Mirle'], ['上銀', 'HIWIN'], ['華碩', 'ASUS'], ['宏碁', 'Acer'], ['廣達', 'Quanta'], ['緯創', 'Wistron'],
  ['聯電', 'UMC'], ['旺宏', 'Macronix'], ['南亞科', 'Nanya'], ['群聯', 'Phison'], ['瑞昱', 'Realtek'], ['聯詠', 'Novatek'], ['輝達', 'NVIDIA'],
  ['中研院', 'Academia Sinica'], ['經濟部', 'MOEA'], ['國科會', 'NSTC'], ['衛福部', 'MOHW'], ['農業部', 'MOA'], ['環境部', 'MOENV'],
  ['臺大', 'NTU'], ['台大', 'NTU'], ['清大', 'NTHU'], ['陽明交大', 'NYCU'], ['成大', 'NCKU'], ['榮總', 'VGH'], ['食藥署', 'TFDA'],
  ['西門子', 'Siemens'], ['弗勞恩霍夫', 'Fraunhofer']
];
const stemOf = (k) => (k.length > 3 && k.endsWith('s') && !k.endsWith('ss') ? k.slice(0, -1) : k);
const termKeyOf = (tok) => stemOf(tok.toLowerCase().replace(/-/g, ''));

function addTermKeys(set, tok) {
  set.add(termKeyOf(tok));
  if (tok.includes('-')) for (const part of tok.split('-')) set.add(stemOf(part.toLowerCase()));
}

// 答案是英文（記者用英文問）：中日韓字佔比很低（不到一成）。中文答案裡夾一串英文名稱不算——
// 中文句子本身的字數一定比那串名稱多，而英文答案頂多夾一兩個中文名字。
function isMostlyLatin(text) {
  let cjk = 0, latin = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
  }
  return latin >= 30 && cjk * 9 <= latin;
}
// 英文答案裡只查「長得像專有名詞」的：全大寫縮寫（TSMC）、駝峰（OpenAI）、連字號後大寫（Wi-Fi）、帶數字（H100）
const PROPER_SHAPE_RE = /^[A-Z][A-Z0-9]{2,}$|[a-z][A-Z]|-[A-Z]|\d/;

// ── 英文註解（批次 132 品質審查）──
// 模型最愛在中文後面補括號英文：「邊緣運算（Edge Computing）」「台積電（TSMC）」「RAG（Retrieval-Augmented Generation，檢索增強生成）」，
// 反過來「Edge Computing（邊緣運算）」也有。括號左（或右）邊那個詞本來就在來源裡，括號裡只是它的翻譯或全名，不是新的事實。
// 只放過「單一個英文詞組」的括號（後面可以接「，中文」）；「合作夥伴（Intel、AMD）」這種清單不放過，也不拿
// 「合作夥伴」「廠商」這類泛稱當錨點——那正是編造合作對象的樣子。已知代價：錨點是來源裡的具體名詞時
// （「感測節點（Bosch）」）編造的括號英文會被放過。
const GLOSS_GENERIC = new Set(['夥伴', '合作夥伴', '廠商', '公司', '業者', '單位', '機構', '客戶', '企業', '平台', '系統', '技術', '產品', '團隊',
  '醫院', '學校', '大學', '方案', '模型', '服務', '工具', '設備', '裝置', '產業', '市場', '國家', '國際', '國內', '國外', '政府', '部門', '專家', '講者', '貴賓']);
// 不用「中文＋(英文)」那種一條 regex 掃全文：長串中文或長串英文接著一個「(」時每個起點都往後試，是平方時間
// （回測實測 6 萬字 3 秒，跟批次 132 審查抓到的網址 regex 同一個形狀）。改成先找「(」，只看它左右各 40～90 字，線性。
const GLOSS_INNER_RE = /^[A-Za-z][A-Za-z0-9 .&'/-]{1,60}(?:, ?[一-鿿].{0,40})?$/;
const isCjk = (c) => c >= '一' && c <= '鿿';
const isLatinPhraseChar = (c) => /[A-Za-z0-9 .&'\/-]/.test(c);
const isGeneric = (s) => [...GLOSS_GENERIC].some((g) => g.endsWith(s));   // 泛稱本身，以及泛稱的尾巴（「作夥伴」是「合作夥伴」的尾巴）都不能當錨點
// 每個括號要在來源（最多 100 萬字）裡找幾次字串：一則答案頂多看 MAX_GLOSS_PARENS 個括號、整則答案頂多在來源裡找 MAX_GLOSS_LOOKUPS 次，
// 用完就當「找不到」——寧可多標出（誤報），不能因為病態輸入讓每次回答多卡好幾百毫秒，也不能反過來漏掉。
const MAX_GLOSS_PARENS = 100;
const MAX_GLOSS_LOOKUPS = 200;
function glossRanges(body, idx) {
  const ranges = [];
  let lookups = 0;
  const inSource = (s) => lookups < MAX_GLOSS_LOOKUPS && (lookups++, idx.norm.includes(s));
  // 括號左邊那串中文，尾巴（≥ 2 字，最長 12 字）有一段在來源裡且不是泛稱，才算有錨點
  const zhAnchored = (left) => {
    if (left.length < 2 || !inSource(left.slice(-2))) return false;   // 更長的尾巴一定也含最後這兩個字：這兩個字都不在來源，就不用再一段一段找
    for (let k = Math.min(left.length, 12); k >= 2; k--) {
      const suffix = left.slice(left.length - k);
      if (!isGeneric(suffix) && inSource(suffix)) return true;
    }
    return false;
  };
  let close = -1, parens = MAX_GLOSS_PARENS;
  for (let open = body.indexOf('('); open >= 0 && parens > 0; open = body.indexOf('(', open + 1)) {
    if (close < open) { close = body.indexOf(')', open + 1); if (close < 0) break; }   // close 只會往後走，整體線性
    if (close - open > 100) continue;
    parens--;
    const inner = body.slice(open + 1, close).trim();
    // 括號左邊：緊貼著的中文詞或英文詞
    let l = open;
    while (l > 0 && body[l - 1] === ' ') l--;
    if (inner && GLOSS_INNER_RE.test(inner)) {                                   // 中文（英文）、RAG（英文全名）
      let s0 = l;
      if (l > 0 && isCjk(body[l - 1])) {
        while (s0 > 0 && isCjk(body[s0 - 1]) && l - s0 < 12) s0--;
        if (zhAnchored(body.slice(s0, l))) ranges.push([open, close + 1]);
      } else {
        while (s0 > 0 && /[A-Za-z0-9-]/.test(body[s0 - 1]) && l - s0 < 40) s0--;
        const left = body.slice(s0, l);
        if (s0 < l && /^[A-Za-z]/.test(left) && idx.terms.has(termKeyOf(left))) ranges.push([open, close + 1]);
      }
    } else if (/^[一-鿿]{2,12}$/.test(inner) && !isGeneric(inner) && inSource(inner)) {   // 英文（中文）
      let s0 = l;
      while (s0 > 0 && isLatinPhraseChar(body[s0 - 1]) && l - s0 < 60) s0--;
      const at = body.slice(s0, l).search(/[A-Za-z]/);
      if (at >= 0) ranges.push([s0 + at, l]);
    }
  }
  return ranges;
}

/** 抽出答案裡值得查的英文名詞：[{ raw, key }]。idx（選填）：給了就會放過「來源裡有的詞」旁邊的括號註解。 */
export function extractTerms(text, idx) {
  const body = normalizeForGrounding(maskLinks(text));
  const english = isMostlyLatin(body);
  const out = [];
  const seen = new Set();
  const gloss = idx ? glossRanges(body, idx) : [];
  for (const m of body.matchAll(LATIN_TOKEN_RE)) {
    const tok = m[0];
    if (gloss.length && gloss.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const letters = tok.replace(/[^A-Za-z]/g, '').length;
    if (!(letters >= 3 || (letters >= 1 && tok.length >= 4))) continue;   // AI、5G、Q3 不查；H100、A100 要查
    if (/^[IVX]{3,}$/.test(tok)) continue;                                  // 羅馬數字 III、VIII
    const key = termKeyOf(tok);
    if (TERM_WHITELIST.has(key) || TERM_WHITELIST.has(tok.toLowerCase().replace(/-/g, ''))) continue;
    if (english && !PROPER_SHAPE_RE.test(tok)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: tok, key });
  }
  return out;
}

function termGrounded(idx, tok, key) {
  if (idx.terms.has(key)) return true;
  // AI-driven 這種連字號詞：來源有 AI 與 driven 各自出現也算（至少一段要有 3 個字母以上，純字母才這樣放行）
  if (tok.includes('-')) {
    const parts = tok.split('-');
    if (parts.every((p) => /^[A-Za-z]+$/.test(p)) && parts.some((p) => p.length >= 3)) {
      return parts.every((p) => p.length < 3 || idx.terms.has(stemOf(p.toLowerCase())));
    }
  }
  return false;
}

// ───────────────────────── 來源索引與比對 ─────────────────────────
function joinParts(shownText) {
  if (Array.isArray(shownText)) return shownText.map((x) => (x == null ? '' : String(x))).join('\n');
  return shownText == null ? '' : String(shownText);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** 把「模型這一次看到的全部文字」建成索引（只建一次；之後每個項目都是 Set 查表，不再掃全文）。 */
export function buildSourceIndex(shownText) {
  const raw = clip(joinParts(shownText), MAX_SOURCE_CHARS);
  const norm = normalizeForGrounding(raw);
  const numAny = new Set();
  const numCls = new Set();
  // 推算用的運算元（見下面「模型自己算的數字」）：來源裡有單位的數字，最多 150 個不同的（類別＋值），帶位置（兩個運算元要相鄰才算推算）。
  // 跟允許集合同一趟掃出來，不另外再掃一次全文。
  const ops = [];
  const seenOps = new Set();
  for (const t of scanNumbers(norm)) {
    for (const k of keysOf(t)) { numAny.add(k.mag); numCls.add(`${k.cls}:${k.mag}`); }
    if (t.kind === 'ver' || t.cls === '-' || ops.length >= 150) continue;
    const v = Number(t.mag);
    const key = `${t.cls}:${t.mag}`;
    if (!Number.isFinite(v) || v <= 0 || v > 1e15 || seenOps.has(key)) continue;
    seenOps.add(key);
    ops.push({ cls: t.cls, v, at: t.start });
  }
  const urls = new Set(extractUrls(raw).map((u) => u.key));
  const terms = new Set();
  for (const m of norm.matchAll(LATIN_TOKEN_RE)) addTermKeys(terms, m[0]);
  for (const [zh, ...ens] of NAME_ALIASES) if (norm.includes(zh)) for (const en of ens) for (const w of en.split(' ')) addTermKeys(terms, w);
  // 季別：年份＋第幾季；來源只寫「明年第一季」沒寫年份時，也留一把只有季的鑰匙（`q1`），答案寫 2027 年第一季、年份在來源裡就算
  const quarters = new Set();
  for (const q of scanQuarters(norm)) quarters.add(`${q.year}-${q.q}`);
  for (const m of norm.matchAll(/第 ?([1-4一二三四]) ?季|(?<![A-Za-z0-9])Q ?([1-4])(?![0-9A-Za-z])/g)) quarters.add(`q${qn(m[1] || m[2])}`);
  // 來源任何幣別的金額數值（答案只寫「元」、沒指明幣別時，只比數值）
  const moneyMags = new Set();
  for (const k of numCls) if (k.startsWith('money')) moneyMags.add(k.slice(k.lastIndexOf(':') + 1));
  return { numAny, numCls, urls, terms, raw, norm, empty: !norm.trim(), lower: null, ops, quarters, moneyMags };
}

// ── 模型自己算的數字（批次 132 品質審查：誤報最大宗之一）──────────────────────────────────
// 模型常把來源的數字加總、相減、取整、算平均或倍數再寫進答案（「共 140 位」「平均每家 1.8 億元」「約 123 萬」），
// 來源不會逐字寫出這些值，直接比對一定標出。來源兩個數字做一次加減乘除、或把某個來源數字取整到答案寫的有效位數，湊得出
// 答案的值，就當作「推算」而不是編造。回測（310 則自擬答案，見 tools/grounding-backtest/README.md）：沒編造的答案被標出
// 14.3% → 7.6%，有編造的答案漏掉的數量不變。
// ⚠️ 代價（已量過，不是沒有）：碰巧湊得出來的編造數字也會被放過。所以收得很窄：
//   · 只對「直接比對失敗」的數字才試；
//   · 算術只在數字前面 14 字內有推算用語（共、合計、平均、相差、約為、佔…）時才做；取整只在答案自己寫了「約／近／逾…」時才算，
//     而且被取整的來源數字要是同一個單位類別（不然「約 40 位」會拿別的東西的 36 當出處）；
//   · 時間類（年月日小時）不做算術：年份兩兩相減什麼天數都湊得出來；
//   · 兩個運算元在來源裡要相距 150 字以內（比例類 80 字）才配對——不相干的兩個數字相加不叫推算；
//   · 運算要「講得通」：和、差＝同類別；積與商＝跟個數或時間相乘除；同類別相除才是倍數或百分比；
//   · 每則答案最多試 MAX_DERIVE_TRIES 個數字：每次要掃 150×150 個運算元配對，3,000 個數字沒設上限時實測 7～11 秒。
// 實測（對 10 場活動的知識庫，把「合計約 N 單位」的 N 從一個範圍掃過去，沒被標出的比例，推算前 → 後；推算前的比例是 N 本來就在
// 來源裡）：計數 1.7% → 6.4%、上萬人 1.1% → 7.9%、百分比 10.5% → 22.2%、倍數 14.1% → 18.3%、金額（億元）0.1% → 0.5%、
// 時間 24.9% → 26.2%。百分比最多（可以拿來配的比例太多），所以提醒裡的百分比比其他數字更要人工看。
// 另一個角度：把 160 則忠實答案裡的 635 個數字各改掉一點，仍抓到 628 個（98.9%）；放掉的 7 個裡 2 個是量測工具的巧合（小計數本來就不查），其餘 5 個都是前面寫了「約」的百分比或平均值。
// 單位換算與匯率要外部常數（公尺/秒→公里/小時要 3.6、匯率要 32）、「約佔總經費的五成」算式離得太遠這類仍會標出。
const sigOf = (mag) => { const d = String(mag).replace('.', '').replace(/^0+/, '').replace(/0+$/, ''); return Math.max(1, d.length); };
const roundSig = (v, sig) => Number(Number(v).toPrecision(Math.min(sig, 15)));
const MAX_DERIVE_TRIES = 12;
const DERIVE_CUE_RE = /(?:合計|總計|共計|總共|共|平均|相差|差距|增加|減少|多出|少了|約為|約是|相當於|等於|也就是|換算|折合|估算|計算|大約|相對|佔|占)[^，。；\n]{0,10}$/;
const APPROX_BEFORE_RE = /(?:約|近|逾|超過|大約|將近|多達|高達) ?(?:NT\$|US\$)?$/;

// 答案自己寫的其他數字也能當運算元（「共 5 家，平均每家 20 億元」的 5 家）；沒有位置，可以跟任何來源數字配對
function answerOperands(body, idx) {
  const seen = new Set(idx.ops.map((o) => `${o.cls}:${o.v}`));
  const out = [];
  for (const t of scanNumbers(body)) {
    const v = Number(t.mag);
    if (t.kind === 'ver' || t.cls === '-' || !Number.isFinite(v) || v <= 0 || v >= 1e15 || seen.has(`${t.cls}:${v}`) || out.length >= 30) continue;
    seen.add(`${t.cls}:${v}`);
    out.push({ cls: t.cls, v });
  }
  return out;
}
function derivableFrom(ops, it, approx, allowArith) {
  const v = Number(it.mag);
  if (!Number.isFinite(v) || v <= 0) return false;
  const sig = sigOf(it.mag);
  const hit = (c) => Number.isFinite(c) && c > 0 && (sig >= 2 ? roundSig(c, sig) === v : Math.abs(c - v) <= v * 1e-9);
  const sameCls = (a, b) => a.cls === b.cls || a.cls === '-' || b.cls === '-';
  ops = ops.filter((o) => o.v !== v && o.v !== 1);   // 答案自己（a÷1＝a）與 1 不當運算元，不然什麼數字都「推得出來」
  if (approx) for (const a of ops) if (roundSig(a.v, sig) === v && sameCls(a, it)) return true;   // 取整：答案自己寫了「約／近／逾」才算
  if (!allowArith || it.cls === 'time') return false;
  const mult = (c) => c === 'count' || c === 'time';
  const near = (a, b, w) => a.at == null || b.at == null || Math.abs(a.at - b.at) <= w;
  for (let i = 0; i < ops.length; i++) for (let j = 0; j < ops.length; j++) {
    const a = ops[i], b = ops[j];
    if (!near(a, b, 150)) continue;
    if (i < j && sameCls(a, b) && (a.cls === it.cls || b.cls === it.cls) && (hit(a.v + b.v) || hit(Math.abs(a.v - b.v)))) return true;   // 合計、相差
    if (i < j && ((a.cls === it.cls && mult(b.cls)) || (b.cls === it.cls && mult(a.cls))) && hit(a.v * b.v)) return true;                  // 單價 × 數量
    if (i !== j && b.v !== 0) {
      if (a.cls === it.cls && mult(b.cls) && hit(a.v / b.v)) return true;                                                                  // 平均每家、每年
      if (a.cls === b.cls && it.cls === 'mult' && near(a, b, 80) && hit(a.v / b.v)) return true;                                          // 幾倍
      if (a.cls === b.cls && it.cls === 'pct' && near(a, b, 80) && (hit((a.v / b.v) * 100) || hit(((a.v - b.v) / b.v) * 100))) return true; // 佔幾成、增加幾%
    }
  }
  return false;
}

// 幣別（批次 132 品質審查）：「800 億美元」寫成「800 億元」、「1,800 萬歐元」寫成「1,800 萬美元」，數值對、幣別錯，
// 以前整個 money 類混在一起查不出來。只寫「元」的（沒指明幣別）兩邊都相容；指明幣別的必須跟來源同幣別，或來源只寫「元」。
function numberGrounded(idx, it) {
  if (it.cls === '-') return idx.numAny.has(it.mag);
  if (idx.numCls.has(`${it.cls}:${it.mag}`) || idx.numCls.has(`-:${it.mag}`)) return true;
  if (it.cls.startsWith('money')) {
    if (it.cls === 'money') return idx.moneyMags.has(it.mag);          // 答案只寫「元」：來源任何幣別都算
    return idx.numCls.has(`money:${it.mag}`);                          // 答案指明幣別：來源同幣別（上面已比）或只寫「元」
  }
  return false;
}
function urlGrounded(idx, it) {
  if (idx.urls.has(it.key)) return true;
  if (idx.lower === null) idx.lower = idx.raw.toLowerCase();
  if (appearsAsUrl(idx.lower, it.key)) return true;
  // 批次 132 品質審查：來源寫 www.itri.org.tw/qc（沒有協定），模型好心補成 https://www.itri.org.tw/qc
  const bare = it.key.replace(/^https?:\/\//, '');
  return bare !== it.key && appearsAsUrl(idx.lower, bare, true);
}

/**
 * 核心：答案裡有、來源沒有的東西。回傳 { numbers, urls, terms }（字串陣列，各類最多 30 筆）。
 * 不看環境變數、不記 log——回測工具與測試直接用這支。會丟例外（checkAnswerGrounding() 負責接住）。
 */
export function findUngrounded(answer, shownText) {
  const ans = clip(answer == null ? '' : String(answer), MAX_ANSWER_CHARS);
  const body = stripDisclaimer(ans);
  const idx = buildSourceIndex(shownText);
  if (idx.empty) return { numbers: [], urls: [], terms: [], sourceEmpty: true };
  const cap = (arr) => arr.slice(0, MAX_ITEMS_PER_KIND);
  const nums = numberItems(body);
  // 模型自己算的數字（合計、平均、相差、倍數、取整）不當成編造，見 derivableFrom()。
  // 運算元＝來源的數字（idx.ops）＋答案自己寫的其他數字（「共 5 家，平均每家 20 億元」的 5 家：來源只有總經費 100 億元；
  // 答案自己寫的沒有位置，可以跟任何來源數字配對）。
  const ops = idx.ops.concat(answerOperands(nums.body, idx));
  let deriveBudget = MAX_DERIVE_TRIES;
  const isDerived = (it) => {
    if (deriveBudget-- <= 0) return false;
    const approx = APPROX_BEFORE_RE.test(nums.body.slice(Math.max(0, it.start - 8), it.start));
    const cue = DERIVE_CUE_RE.test(nums.body.slice(Math.max(0, it.start - 14), it.start));
    return derivableFrom(ops, it, approx, cue);
  };
  const numberFlags = mergeDashed(nums.items.filter((it) => !(numberGrounded(idx, it) || isDerived(it))), nums.body);
  // 季別另外查：同一年份已經被標出的就不重複提醒
  const flaggedYears = new Set(numberFlags.map((f) => /^\d{4}/.exec(f)?.[0]).filter(Boolean));
  for (const q of quarterMisses(nums.body, idx)) if (!flaggedYears.has(/^\d{4}/.exec(q)?.[0])) numberFlags.push(q);
  return {
    numbers: cap(numberFlags),
    urls: cap(extractUrls(body).filter((it) => !urlGrounded(idx, it)).map((it) => it.raw)),
    terms: cap(extractTerms(body, idx).filter((it) => !termGrounded(idx, it.raw, it.key)).map((it) => it.raw))
  };
}

// ───────────────────────── 提醒文案 ─────────────────────────
// 項目是答案裡的片段，可能帶 Markdown 的符號（網址的底線、星號）：LINE 的 stripMarkdownForLine() 與網頁的
// renderMarkdown() 都會動它們，提醒文字要自己先清乾淨，讓這一行「不含 Markdown」是程式保證的。
function cleanNoteItem(x) {
  const s = String(x ?? '').replace(/[\s\u0000-\u001f]+/g, ' ').replace(/[*_`#\[\]<>|~\\]/g, '').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 影子模式轉成 on 之後附在答案後面的一行提醒。items＝被標出的項目（數字、網址、英文名詞混在一起）。沒有項目回空字串。
 * opts.english（批次 132 審查）：true 給英文版。ZH_TW_RULE 要求記者用英文問就用英文答，英文答案後面卻接一句只有中文的提醒，
 * 外國記者看不懂為什麼被標。兩個版本都是固定句、不含 Markdown，項目本身的清理方式相同。
 * 這支維持「沒有 import 的純函式」（test-batch132 的紀律），所以語言由呼叫端判斷、用這個選項傳進來：
 * `english: looksEnglish(stripDisclaimer(答案))`（looksEnglish 在 lib/ai-refusal.js，與拒答固定句共用同一個判斷；
 * 先 stripDisclaimer 是因為模型寫英文答案時，結尾那句警語仍可能是中文，帶著它判斷會把整則英文答案當成中文）。沒傳就是中文版。
 */
export function buildGroundingNote(items, opts) {
  const list = [...new Set((Array.isArray(items) ? items : []).map(cleanNoteItem).filter(Boolean))];
  if (!list.length) return '';
  const shown = list.slice(0, MAX_NOTE_ITEMS);
  if (opts?.english === true) {
    const more = list.length > MAX_NOTE_ITEMS ? `, and ${list.length - MAX_NOTE_ITEMS} more` : '';
    return `⚠️ Some items above (${shown.join(', ')}${more}) could not be found in the press release. Please confirm with the press contact before citing.`;
  }
  const more = list.length > MAX_NOTE_ITEMS ? ` 等 ${list.length} 處` : '';
  return `⚠️ 以上內容有幾處（${shown.join('、')}${more}）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。`;
}

// ───────────────────────── 出口 ─────────────────────────
function logLabel(v, fallback) {
  try { return String(v == null || v === '' ? fallback : v).replace(/\s+/g, '_').slice(0, 40); } catch { return fallback; }
}
const logList = (arr) => {
  const shown = arr.slice(0, 10).map((s) => String(s).replace(/\s+/g, ' ').slice(0, 60));
  if (arr.length > shown.length) shown.push(`+${arr.length - shown.length}`);
  return JSON.stringify(shown);
};

/**
 * 記者端答案的出口檢查。answer＝要送出去的答案；shownText＝模型這一次看到的全部文字（字串，或字串陣列）。
 * 回傳 { numbers, urls, terms, mode, note }：
 *   shadow（預設）只記 log，note 一律 ''；on 另外給 note（opts.english 為 true 給英文版，見 buildGroundingNote()）；off 什麼都不做。
 * 絕對不丟例外：自己壞了就回空結果並記一行 log，記者照樣收到答案。
 * log 只記被標出的項目本身，不記答案全文、問題、使用者資料。
 */
export function checkAnswerGrounding(answer, shownText, opts) {
  let mode = 'shadow';
  try { mode = groundingMode(); } catch { /* 讀環境變數不會壞；真壞了就當影子模式 */ }
  const empty = { numbers: [], urls: [], terms: [], mode, note: '' };
  if (mode === 'off') return empty;
  const where = logLabel(opts?.where, '-');
  const eventId = logLabel(opts?.eventId, '-');
  try {
    const r = findUngrounded(answer, shownText);
    if (r.sourceEmpty) {
      // 來源是空的代表呼叫端沒把東西傳進來：全部標出只會洗版，改成記一行讓人發現
      console.log(`[grounding] where=${where} event=${eventId} shownText 是空的，略過這一則`);
      return empty;
    }
    const flagged = [...r.numbers, ...r.urls, ...r.terms];
    if (!flagged.length) return empty;
    console.log(`[grounding] where=${where} event=${eventId} numbers=${logList(r.numbers)} urls=${logList(r.urls)} terms=${logList(r.terms)}`);
    // 提醒只收 on:<類別> 挑的那幾類（見 parseGroundingEnv()）；log 與回傳的三個陣列照舊是全部
    const kinds = groundingNoteKinds();
    const noted = [...(kinds.has('numbers') ? r.numbers : []), ...(kinds.has('urls') ? r.urls : []), ...(kinds.has('terms') ? r.terms : [])];
    return { numbers: r.numbers, urls: r.urls, terms: r.terms, mode, note: mode === 'on' ? buildGroundingNote(noted, { english: opts?.english === true }) : '' };
  } catch (e) {
    try { console.log(`[grounding] where=${where} event=${eventId} 檢查自己出錯，略過這一則：${String(e?.name || 'Error').slice(0, 40)} ${String(e?.message || '').slice(0, 80)}`); } catch { /* log 都壞了就算了 */ }
    return empty;
  }
}
