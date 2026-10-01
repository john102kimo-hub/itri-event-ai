// 單位名稱正規化——把 AI 回答裡五花八門的機構寫法收斂成同一家。
//
// 從 api/geo.js 搬出來的，一個字沒改。搬的原因：現在有兩個地方要用同一套合併規則——
// 一頁報告的話語權排行（api/geo.js），以及同業基準線的時間序列（lib/geo-benchmark.js）。
// 兩邊如果各自實作，哪天 ORG_MAP 加了一列而另一邊沒跟上，兩張表會對同一批資料給出
// 不同的名次，而且是靜靜地不一樣——沒有人會發現，直到主管把兩張圖並排問「哪個才對」。
//
// 純函式，不碰網路、不讀環境變數，所以 test/test-geo-benchmark.mjs 直接 import 來測。

export const BRAND_DEFAULT = '工研院';

// ── 工研院的所有寫法（批次 82）與「相關用語」（批次 102）────────────────────────
// 批次 82 需求原話：「工研院關鍵字應涵蓋工業技術研究院、ITRI 等等」。AI 的回答、新聞稿、
// 記者的問句裡，同一個工研院會以好幾種樣子出現；只認「工研院」三個字的地方，遇到
// 「工業技術研究院」「ITRI」「Industrial Technology Research Institute」就當成沒提到。
// 以前這份清單散在四個地方、各寫各的（api/geo.js 的 BRAND_RE、判官 prompt、
// lib/geo-draft-check.js 只認「工研院」、public/geo.html 只認「工研院|ITRI」），
// 現在統一從這裡拿（public/geo.html 是靜態頁不能 import，鏡射一份，
// test/test-review82.mjs 會比對兩邊逐字相同）。
//
// 批次 102 需求原話：「工研院追蹤也要追蹤相關用語」。AI 指到工研院的方式還有一整層是
// 名稱之外的——只寫單位名（「電子與光電系統研究所」「材化所」），完全不出現「工研院」。
// 這一層分三級，因為「算不算提到工研院」是會被主管追問的判定，不能全部一視同仁：
//   名稱（BRAND_NAMES／BRAND_NAMES_EN／BRAND_ABBR）：工研院本身的各種寫法。出現就算。
//   單位正式名稱（BRAND_UNITS）：工研院官網組織架構頁上的研發與營運單位全名
//     （2026-10-01 核對：itri.org.tw 組織架構）。獨一無二，出現就是工研院，出現就算。
//   單位簡稱（BRAND_SHORT）：電光所、資通所、機械所……口語很常用，但「成大電光所」
//     「台大機械所」也叫這個名字。**只當相關用語記下來，不當成提到工研院**——
//     規則比對算進去的話，學校的所會被灌到工研院頭上，而且是靜靜地灌。
//     它們出現在回答裡還有另一層意思：AI 認得這個單位卻沒把它連到工研院（品牌斷鏈），
//     這是發稿時「單位簡稱前面要掛工研院」的直接證據，所以要單獨數出來，見 lib/geo-metrics.js。
// 要補新單位（改制、新成立、舊名）只改這裡，上面四個地方與判官的提示詞會一起跟上。
//
// ⚠️ 英文縮寫一定要有字詞邊界：舊的 /ITRI|ISTI/i 會吃到「nitride」（氮化物，GaN 相關
// 議題一定會出現）與「statistics」「logistics」——整句被當成「指名工研院」丟掉，
// 生題時會莫名其妙地回「題目不合格（可能都提到了工研院）」。
// 簡體「工业技术研究院」也收：部分 AI 引擎偶爾用簡體回答。
// IEK／ISTI（產科國際所）是工研院底下的單位，提到它們也算提到工研院（跟下面 ORG_MAP 一致）。
export const BRAND_NAMES = ['工研院', '工業技術研究院', '工业技术研究院'];
export const BRAND_NAMES_EN = ['Industrial Technology Research Institute'];
export const BRAND_ABBR = ['ITRI', 'IEK', 'ISTI'];
export const BRAND_UNITS = [
  '電子與光電系統研究所', '資訊與通訊研究所', '機械與機電系統研究所', '材料與化工研究所',
  '綠能與環境研究所', '生醫與醫材研究所', '產業科技國際策略發展所', '無人化創新科技研究所',
  '量測技術發展中心', '服務系統科技中心', '智慧感測與系統科技中心',
  // 簡稱裡唯一沒有第二個機構在用的一個，以及 IEK 的舊名
  '產科國際所', '產業經濟與趨勢研究中心',
];
// 官網組織架構頁上叫「產業學院」「南分院」「中分院」「產業服務中心」的單位也在這一級：
// 名字本身太通用（很多大學也有產業學院），單獨出現不能斷定是工研院。
export const BRAND_SHORT = [
  '電光所', '資通所', '機械所', '材化所', '綠能所', '生醫所', '量測中心', '服科中心', '感測中心',
  '產業服務中心', '產業學院', '南分院', '中分院',
];

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const enRe = (s) => reEsc(s).replace(/ /g, '\\s+');
const abbrRe = () => `\\b(?:${BRAND_ABBR.join('|')})\\b`;

// 批次 82 的 BRAND_ALIAS_RE 原樣（名稱＋英文縮寫＋英文全名）。稿件檢核（lib/geo-draft-check.js）
// 要看的是「稿子有沒有點名工研院」，只寫單位全名不算——AI 讀稿也一樣，單位名前面沒掛
// 工研院就連不回品牌——所以那邊用這一條，不跟著下面的 BRAND_ALIAS_RE 變寬。
export const BRAND_NAME_RE = new RegExp(
  [...BRAND_NAMES.map(reEsc), abbrRe(), ...BRAND_NAMES_EN.map(enRe)].join('|'), 'i');

// 「這句話有沒有指名工研院」的防呆（題目不能自問自答、AI 回答原文標粗）：名稱＋單位全名。
// ⚠️ 不放單位簡稱，也不用 lookbehind 去擋「成大電光所」——這條規則會原封不動鏡射進
// public/geo.html，iOS 16.4 以前的 Safari 看到 lookbehind 會整支 script 語法錯誤、整頁不能用。
// 簡稱的歧義交給下面的 findBrandTerms()（伺服器端、有前綴防呆）。
export const BRAND_ALIAS_RE = new RegExp(
  [...BRAND_NAMES.map(reEsc), ...BRAND_UNITS.map(reEsc), abbrRe(), ...BRAND_NAMES_EN.map(enRe)].join('|'), 'i');

// 簡稱前面緊貼著這些字，就是別的學校／機構的所（「成大電光所」「陽明交大電光所」「台灣大學機械所」）
const SHORT_NOT_ITRI_PREFIX = /(?:大學|學院|[台臺]大|成大|清大|交大|陽明|中央|中山|中興|中正|政大|師大|科大|北科|雲科|高科|屏科|海大|東華|逢甲|淡江|元智|中原|長庚|中研院|中科院)$/;

const TERM_RES = [
  ...BRAND_NAMES.map((t) => ({ term: t, tier: 'name', re: new RegExp(reEsc(t)) })),
  ...BRAND_ABBR.map((t) => ({ term: t, tier: 'name', re: new RegExp(`\\b${t}\\b`, 'i') })),
  ...BRAND_NAMES_EN.map((t) => ({ term: t, tier: 'name', re: new RegExp(enRe(t), 'i') })),
  ...BRAND_UNITS.map((t) => ({ term: t, tier: 'unit', re: new RegExp(reEsc(t)) })),
];

function hasUnguarded(s, term) {
  for (let i = s.indexOf(term); i >= 0; i = s.indexOf(term, i + 1)) {
    if (!SHORT_NOT_ITRI_PREFIX.test(s.slice(Math.max(0, i - 4), i))) return true;
  }
  return false;
}

/**
 * 一段文字裡出現了哪些工研院的相關用語。純規則、不呼叫任何模型，同一段文字永遠同一個結果——
 * 這是「判官（模型）說有沒有提到」之外，另一條不依賴判官的獨立判定。
 * @returns {{ names:string[], units:string[], short:string[], strong:boolean }}
 *   strong＝名稱或單位全名至少一個出現＝規則認定「提到工研院」。
 *   short＝單位簡稱（已擋掉「成大電光所」那類前綴），**不算** strong。
 */
export function findBrandTerms(text) {
  const s = String(text || '');
  const names = [], units = [];
  for (const { term, tier, re } of TERM_RES) {
    if (re.test(s)) (tier === 'name' ? names : units).push(term);
  }
  const short = BRAND_SHORT.filter((t) => hasUnguarded(s, t));
  return { names, units, short, strong: names.length + units.length > 0 };
}

// 判官提示詞的同義寫法那一段，由詞表產生（api/geo.js brandSynonyms）。以前手寫一行、
// 只舉了幾個例子，詞表一擴就會兩邊對不起來。
export const BRAND_JUDGE_HINT = `（同義寫法：工研院、工業技術研究院、ITRI、Industrial Technology Research Institute 都算同一個；`
  + `工研院底下的研究所／中心——${BRAND_UNITS.join('、')}，以及 IEK、ISTI——被點名時，也算提到工研院；`
  + `單位簡稱（${BRAND_SHORT.join('、')}）要看前面有沒有掛別的學校或機構：「成大電光所」「台大機械所」是學校的所，`
  + `不是工研院，只有單獨出現、或前面掛工研院時才算）`;

/* ────────────────────────────── 單位名稱正規化 ──────────────────────────────
 * 同一家機構在 AI 回答裡會有一堆寫法：「資策會 MIC」「資策會產業情報研究所」
 * 「資策會產業情報研究所（MIC）」講的是同一家。不合併的話，話語權排行會把一家拆成三列，
 * 每一列都被低估、名次整個失真——這是這張表最容易被當場問倒的地方。
 *
 * 只在「讀出來算」的時候合併，geo_runs 一律照 AI 原話存。舊資料不必搬、規則改了重算就對，
 * 也還原得回 AI 究竟是怎麼寫的。
 *
 * 兩層，順序不能顛倒：
 *  1) normOrgKey()：全形轉半形、拿掉括號註記與「財團法人／股份有限公司」這類修飾詞、去空白標點。
 *     沒登記在表裡的單位也吃得到——寫法差異只要落在這一層就會自己併起來。
 *  2) ORG_MAP：把清洗後的字串收斂成對外要顯示的正式簡稱。中文用「包含核心詞」比對，
 *     所以底下的所／中心（資策會產業情報研究所、工研院產科國際所）會自動歸到母體；
 *     英文縮寫要求整串相等，免得 III、MIC 這種短字串誤傷別人。
 * 表裡沒有、清洗後也不同的，一律各自保留——寧可多一列，不要亂併。
 */

// [對外顯示的正式簡稱, 中文核心詞（包含即算）, 英文縮寫（整串相等才算）]
// 要加新單位就往這裡加一列，不必動任何邏輯。
const ORG_MAP = [
  // 英文全名與簡體全名（批次 82）：英文回答裡判官會寫「Industrial Technology Research
  // Institute」，沒登記的話它會變成排行榜上跟工研院並列的「另一家機構」。
  // 批次 102：核心詞改由上面的詞表展開（名稱＋英文全名＋單位全名）。單位**簡稱**刻意不進來——
  // 這裡是「包含核心詞即歸戶」，「台大機械所」會因為包含「機械所」被併進工研院。
  ['工研院', [...BRAND_NAMES, ...BRAND_NAMES_EN, ...BRAND_UNITS], ['itri', 'iek', 'isti']],
  ['資策會', ['資策會', '資訊工業策進會'], ['iii', 'mic']],
  ['國研院', ['國研院', '國家實驗研究院'], ['narlabs']],
  ['中科院', ['中科院', '中山科學研究院'], ['ncsist']],
  ['中研院', ['中研院', '中央研究院'], ['sinica', 'academiasinica']],
  ['金屬中心', ['金屬中心', '金屬工業研究發展中心'], ['mirdc']],
  ['紡織所', ['紡織所', '紡織產業綜合研究所'], ['ttri']],
  ['生技中心', ['生技中心', '生物技術開發中心'], ['dcb']],
  ['食品所', ['食品所', '食品工業發展研究所'], ['firdi']],
  ['精密機械中心', ['精密機械中心', '精密機械研究發展中心'], ['pmc']],
  ['塑膠中心', ['塑膠中心', '塑膠工業技術發展中心'], ['pidc']],
  ['車輛中心', ['車輛中心', '車輛研究測試中心'], ['artc']],
  ['台經院', ['台經院', '台灣經濟研究院'], ['tier']],
  ['中經院', ['中經院', '中華經濟研究院'], ['cier']],
  ['商研院', ['商研院', '商業發展研究院'], ['cdri']],
  ['台大', ['台灣大學', '台大'], ['ntu']],
  ['清大', ['清華大學', '清大'], ['nthu']],
  ['陽明交大', ['陽明交通大學', '陽明交大', '交通大學'], ['nycu', 'nctu']],
  ['成大', ['成功大學', '成大'], ['ncku']],
  ['台科大', ['台灣科技大學', '台科大'], ['ntust']],
  ['中央大學', ['中央大學'], ['ncu']],
  ['中興大學', ['中興大學'], ['nchu']],
  ['中山大學', ['中山大學'], ['nsysu']],
  ['台積電', ['台積電', '台灣積體電路'], ['tsmc']],
  ['聯電', ['聯電', '聯華電子'], ['umc']],
  ['聯發科', ['聯發科'], ['mediatek']],
  ['鴻海', ['鴻海', '富士康'], ['foxconn']],
  ['日月光', ['日月光'], ['ase']],
  ['台達電', ['台達電'], ['delta', 'deltaelectronics']],
  ['廣達', ['廣達'], ['quanta']],
  ['緯創', ['緯創'], ['wistron']],
];

// 判官被交代過不要回泛稱，但偶爾還是會漏一兩個。這種東西進了排行榜就是雜訊。
const NOT_ORG = new Set(['業界', '產業界', '學界', '相關單位', '政府', '廠商', '企業', '法人',
  '研究單位', '學研機構', '產學研', '國內廠商', '國外廠商', '多家業者', '台灣', '其他']);

export function normOrgKey(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  // 全形英數與標點 → 半形（（MIC）會在這一步變成 (mic)，下一步才吃得到）
  t = t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .toLowerCase();
  t = t.replace(/[(【[][^)】\]]*[)】\]]/g, '');       // 括號註記整段拿掉
  t = t.replace(/財團法人|社團法人|股份有限公司|有限公司|國立|私立/g, '');
  t = t.replace(/臺/g, '台');
  return t.replace(/[\s·・．.,，、。;；:：\-–—_/／\\|｜'"「」『』]/g, '');
}

// 展平成「核心詞 → 正式簡稱」，長的先比：短詞先命中會把「台灣科技大學」搶去對「台大」
const ORG_TOKENS = ORG_MAP
  .flatMap(([canon, cores]) => cores.map((t) => ({ canon, t: normOrgKey(t) })))
  .filter((x) => x.t).sort((a, b) => b.t.length - a.t.length);
const ORG_ABBR = new Map(ORG_MAP
  .flatMap(([canon, , abbrs = []]) => abbrs.map((a) => [a.toLowerCase(), canon])));

// 「ITRI 材化所」「TSMC 南科廠」這種「英文縮寫＋中文單位名」（批次 82）：縮寫後面直接接
// 中文時，縮寫就是母機構。只在後面接的是非 ASCII 字元時才認——「micron」開頭雖然是 mic，
// 後面接的是英文字母，不會被誤併成資策會。
function abbrPrefix(k) {
  const m = k.match(/^([a-z]+)[^\x00-\x7f]/);
  return m ? ORG_ABBR.get(m[1]) : undefined;
}

const _orgCache = new Map();
/** 一個單位名稱 →｛用來歸戶的 key、要顯示的名稱、有沒有登記在表裡｝ */
export function resolveOrg(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (_orgCache.has(s)) return _orgCache.get(s);
  const k = normOrgKey(s);
  let out;
  if (!k || NOT_ORG.has(k)) out = { key: '', name: '', known: false };
  else {
    const canon = ORG_ABBR.get(k) || (ORG_TOKENS.find((x) => k.includes(x.t)) || {}).canon || abbrPrefix(k);
    out = canon ? { key: canon, name: canon, known: true } : { key: k, name: s, known: false };
  }
  _orgCache.set(s, out);
  return out;
}

export const BRAND_KEY = resolveOrg(BRAND_DEFAULT).key;

/** 一串名稱 → 收斂過、去重過的正式名稱陣列。給題目的對照名單與自我測試用。 */
export const canonList = (arr) => [...new Set((arr || [])
  .map((s) => resolveOrg(s).name).filter(Boolean))];

/**
 * 把一批 run 的 competitors 欄位收斂成 Map(key → { name, n, variants })。
 * 同一列裡多種寫法指到同一家只算一次——不先去重的話，合併反而會把那家灌水。
 */
export function tallyOrgs(rows) {
  const acc = new Map();
  rows.forEach((r) => {
    const seen = new Set();
    String(r.competitors || '').split(/[、,，;；|｜/／]/)
      .map((s) => s.trim()).filter(Boolean)
      .forEach((raw) => {
        const o = resolveOrg(raw);
        // 品牌自己不能出現在對手列（「工研院材化所」也算工研院），
        // 否則同一家會被拆成「工研院」和它底下的所，兩列各自被低估。
        if (!o.key || o.key === BRAND_KEY) return;
        const e = acc.get(o.key) || { name: o.name, known: o.known, n: 0, variants: new Set() };
        // 出現過的寫法全部留著（合併說明要列給主管看），但同一列同一家只計 1 次——
        // 一列裡同時寫了「資策會 MIC」和「資策會產業情報研究所」還算兩次的話，合併反而變灌水。
        e.variants.add(raw.replace(/\s+/g, ''));
        if (!seen.has(o.key)) { seen.add(o.key); e.n += 1; }
        // 沒登記的單位就用最短的寫法當代表，通常那個最乾淨
        if (!e.known && o.name.length < e.name.length) e.name = o.name;
        acc.set(o.key, e);
      });
  });
  return acc;
}
