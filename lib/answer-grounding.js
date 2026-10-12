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
//     · 日期 2026年10月28日／2026-10-28／2026.10.28／10/28 拆成各自的數字，都在來源裡就算有；
//       範圍 3–5 拆開各自比（後面有單位／量級就一起繼承：30–50 億＝30 億、50 億）。
//     · 小數與版本號（5.5、1.2.3、802.11）整串比，不拆成 5 和 5。
//     · 民國年與西元年互通（來源寫 115 年、答案寫 2026 年不誤報）。
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
// 三、網址與 email：答案裡的 http(s):// 或 www. 開頭網址必須原樣出現在來源（忽略結尾標點與 `)`、
//   結尾斜線、大小寫）；找不到＝編造連結（經典幻覺）。email 同理。
// 四、英文名詞：答案裡 3 個字母以上的英文詞／縮寫，不分大小寫必須出現在來源（單複數、有無連字號視為同一個）。
//   小白名單見 TERM_WHITELIST。答案本身是英文時（記者用英文問）只查縮寫、駝峰、帶數字、連字號大寫這幾種
//   「長得像專有名詞」的，普通英文單字不查——不然整則英文答案都會被標出。
// 五、最後那句警語（「內容僅供參考，以…為準」與英文版）不查。
//
// ── 已知會誤報（影子模式要量的就是這些）─────────────────────────────────────────
//   · 模型自己算出來的數字：加總、相減、四捨五入（來源寫 1,234,567、答案寫「約 123 萬」）、單位換算
//     （公里↔公尺）、「還有 16 天」以外的相對時間。
//   · 英文註解與中英名稱互譯：來源寫「台積電」、答案寫 TSMC；來源寫「邊緣運算」、答案補「(Edge Computing)」。
//   · 2萬5千 這種阿拉伯數字與中文量級混寫，會拆成 2萬 與 5千，湊不回 25000。
//   · 來源本身排版造成的拆字（網址中間被換行切開）。
// ── 已知會漏報 ───────────────────────────────────────────────────────────────────
//   · 小整數：來源只要在任何地方出現過同樣的小數字（日期、編號），答案裡同數值同類別就過關。
//   · 時刻：14:30 的 14 和 30 不查，「下午 2 點半」這種換寫法更沒辦法比。
//   · 同類別換字：來源寫「5 家」、答案寫「5 人」，count 類別內視為同一種。
//   · 張冠李戴：數字在來源裡，但屬於另一件事。這支只知道「有沒有出現」，不知道「說的是不是同一件事」。
//   · 人名、公司中文名、地名：不查（中文沒有可靠的切詞）。英文人名在中文答案裡會被當英文名詞查；英文答案裡
//     首字大寫的普通名字不查。
//   · 沒有 http 開頭也沒有 www. 的網域（itri.org.tw/news）不當網址查。
//   · 小數目的計數（≤ 10，以及「共 N 項」≤ 20）：見上，刻意放掉。

const MAX_ANSWER_CHARS = 60_000;
const MAX_SOURCE_CHARS = 1_000_000;
const MAX_ITEMS_PER_KIND = 30;
const MAX_NOTE_ITEMS = 3;

/** ANSWER_GROUNDING：on／off／shadow（預設）。每次呼叫才讀。 */
export function groundingMode(env = process.env) {
  const v = String(env?.ANSWER_GROUNDING ?? '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'shadow';
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
const URL_TRAIL_RE = /[.,;:!?'"*)\]}>]+$/;

function trimUrl(u) { return u.replace(URL_TRAIL_RE, ''); }
function urlKey(raw) { return trimUrl(String(raw)).toLowerCase().replace(/\/+$/, ''); }

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
// （chu@x.com 不能靠 chuchu@x.com 過關），後面不能再接網址字元（https://x.com/a 不能靠 https://x.com/ab 過關）。
// 後面的斜線例外：引用某個真實網址的上層路徑，不算編造。
function appearsAsUrl(lowerSource, key) {
  let from = 0;
  for (;;) {
    const i = lowerSource.indexOf(key, from);
    if (i < 0) return false;
    const prev = lowerSource[i - 1];
    const next = lowerSource[i + key.length];
    if ((!prev || !/[A-Za-z0-9._%+\-@]/.test(prev)) && (!next || !/[A-Za-z0-9._~%=&+#@?:\-]/.test(next))) return true;
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
  money: ['元', '塊', '圓', '美元', '美金', '台幣', '臺幣', '新台幣', '新臺幣', '日圓', '日幣', '歐元', '人民幣', '韓元', '港幣', '英鎊', 'dollar', 'dollars'],
  time: ['年', '月', '日', '天', '週', '周', '季', '秒', '世紀', '小時', '分鐘', '週年', '周年', '個月', '年度', '學年', '歲', '星期',
    'year', 'years', 'month', 'months', 'day', 'days', 'week', 'weeks', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'ms', 'ns'],
  count: ['位', '名', '人', '家', '間', '項', '件', '場', '款', '個', '隻', '台', '臺', '套', '組', '篇', '次', '座', '棟', '條', '張', '輛', '架', '艘', '顆', '片',
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
  const toks = [];
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
  inheritRanges(toks, text);
  addDerivedKeys(toks);
  return toks;
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

// 民國年與西元年互通（來源「115 年」、答案「2026 年」不誤報）
function addDerivedKeys(toks) {
  for (const t of toks) {
    if (t.unit !== '年' || t.exp) continue;
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
  'usd', 'ntd', 'twd', 'rmb', 'cny', 'jpy', 'eur',
  'kwh', 'mwh', 'gwh', 'twh', 'khz', 'mhz', 'ghz', 'thz', 'kbps', 'mbps', 'gbps', 'tops', 'flops', 'tflops', 'gflops', 'mah'
]);
export const GROUNDING_TERM_WHITELIST = TERM_WHITELIST;

// 前面不能是英數字：100kWh 的 kWh、5nm 的 nm 是黏在數字後面的單位，不是獨立的英文詞
const LATIN_TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g;

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

/** 抽出答案裡值得查的英文名詞：[{ raw, key }]。 */
export function extractTerms(text) {
  const body = normalizeForGrounding(maskLinks(text));
  const english = isMostlyLatin(body);
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(LATIN_TOKEN_RE)) {
    const tok = m[0];
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
  for (const t of scanNumbers(norm)) {
    for (const k of keysOf(t)) { numAny.add(k.mag); numCls.add(`${k.cls}:${k.mag}`); }
  }
  const urls = new Set(extractUrls(raw).map((u) => u.key));
  const terms = new Set();
  for (const m of norm.matchAll(LATIN_TOKEN_RE)) addTermKeys(terms, m[0]);
  return { numAny, numCls, urls, terms, raw, empty: !norm.trim(), lower: null };
}

function numberGrounded(idx, it) {
  if (it.cls === '-') return idx.numAny.has(it.mag);
  return idx.numCls.has(`${it.cls}:${it.mag}`) || idx.numCls.has(`-:${it.mag}`);
}
function urlGrounded(idx, it) {
  if (idx.urls.has(it.key)) return true;
  if (idx.lower === null) idx.lower = idx.raw.toLowerCase();
  return appearsAsUrl(idx.lower, it.key);
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
  return {
    numbers: cap(mergeDashed(nums.items.filter((it) => !numberGrounded(idx, it)), nums.body)),
    urls: cap(extractUrls(body).filter((it) => !urlGrounded(idx, it)).map((it) => it.raw)),
    terms: cap(extractTerms(body).filter((it) => !termGrounded(idx, it.raw, it.key)).map((it) => it.raw))
  };
}

// ───────────────────────── 提醒文案 ─────────────────────────
// 項目是答案裡的片段，可能帶 Markdown 的符號（網址的底線、星號）：LINE 的 stripMarkdownForLine() 與網頁的
// renderMarkdown() 都會動它們，提醒文字要自己先清乾淨，讓這一行「不含 Markdown」是程式保證的。
function cleanNoteItem(x) {
  const s = String(x ?? '').replace(/[\s\u0000-\u001f]+/g, ' ').replace(/[*_`#\[\]<>|~\\]/g, '').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 影子模式轉成 on 之後附在答案後面的一行提醒。items＝被標出的項目（數字、網址、英文名詞混在一起）。沒有項目回空字串。 */
export function buildGroundingNote(items) {
  const list = [...new Set((Array.isArray(items) ? items : []).map(cleanNoteItem).filter(Boolean))];
  if (!list.length) return '';
  const more = list.length > MAX_NOTE_ITEMS ? ` 等 ${list.length} 處` : '';
  return `⚠️ 以上內容有幾處（${list.slice(0, MAX_NOTE_ITEMS).join('、')}${more}）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。`;
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
 *   shadow（預設）只記 log，note 一律 ''；on 另外給 note；off 什麼都不做。
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
    return { numbers: r.numbers, urls: r.urls, terms: r.terms, mode, note: mode === 'on' ? buildGroundingNote(flagged) : '' };
  } catch (e) {
    try { console.log(`[grounding] where=${where} event=${eventId} 檢查自己出錯，略過這一則：${String(e?.name || 'Error').slice(0, 40)} ${String(e?.message || '').slice(0, 80)}`); } catch { /* log 都壞了就算了 */ }
    return empty;
  }
}
