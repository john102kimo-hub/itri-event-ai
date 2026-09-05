// 吃什麼地圖 — 中文口語指令解析（純函式，沒有任何瀏覽器或 Node 專屬 API）。
//
// 為什麼獨立成一個檔、而且放在 public/：
//   1. 放 public/ 才會被 Vercel 當靜態檔案送出，food.html 可以用 <script type="module"> 直接 import；
//      放根目錄 lib/ 的話瀏覽器抓不到（Vercel 只發佈 public/），放 api/ 又會白白吃掉一格
//      Serverless Function 額度（見 SETUP.md「12 支上限」那段，目前只剩 1 格）。
//   2. 指令解析是這個 App 唯一「會因為多一種說法就悄悄失效」的地方——使用者打「想吃鼎泰豐」
//      跟「鼎泰豐想吃」跟「加鼎泰豐」期待同一件事。抽成純函式才測得到，
//      test/test-food-parse.mjs 直接 import 這支跑，不用開瀏覽器。
//
// 全部解析都在使用者手機上跑，不呼叫任何 AI API：不用金鑰、不花錢、離線也能用、
// 而且反應是即時的。代價是只認得下面列出的說法，所以新增指令一定要同時補測試。

// ── 店家狀態 ────────────────────────────────────────────────────────────
// want 想吃還沒吃 / ok 平常可吃 / nope 踩雷不再去
// nope 是使用者沒要求但一定會用到的第三類：沒有它，踩過雷的店只能刪掉，
// 下次又會被朋友推薦、又加一次、又踩一次。
export const STATUS = {
  want: { key: 'want', label: '想吃還沒吃', short: '想吃', color: '#F59E0B', icon: '☆' },
  ok:   { key: 'ok',   label: '平常可吃',   short: '可吃', color: '#0F9E7A', icon: '●' },
  nope: { key: 'nope', label: '踩雷別去',   short: '踩雷', color: '#94A3B8', icon: '✕' }
};
export const STATUS_KEYS = ['want', 'ok', 'nope'];

// ── 標籤字典 ────────────────────────────────────────────────────────────
// 用途有兩個：(1) 從店名自動猜標籤，少打字；(2) 讓「晚上想吃日式」這種句子查得到。
// 只收台灣日常真的會講的詞；同義詞放 kw，正規化成同一個 tag，
// 避免同一類東西存成「拉麵/ラーメン/日本拉麵」三個標籤，之後怎麼查都少一半。
export const TAG_DICT = [
  { tag: '麵食', kw: ['麵', '麵館', '麵店', '陽春麵', '乾麵', '意麵', '麵線'] },
  { tag: '牛肉麵', kw: ['牛肉麵'] },
  { tag: '拉麵', kw: ['拉麵', '豚骨', 'ramen'] },
  { tag: '飯食', kw: ['飯', '便當', '飯館', '快餐', '自助餐', '簡餐'] },
  { tag: '滷肉飯', kw: ['滷肉飯', '魯肉飯', '爌肉飯'] },
  { tag: '丼飯', kw: ['丼', '丼飯', '親子丼'] },
  { tag: '火鍋', kw: ['火鍋', '鍋物', '涮涮鍋', '個人鍋', '麻辣鍋', '薑母鴨', '羊肉爐'] },
  { tag: '燒肉', kw: ['燒肉', '烤肉', '燒烤', '串燒', '串燒店'] },
  { tag: '日式', kw: ['日式', '日本料理', '和食', '居酒屋', '定食', '壽司', '生魚片', '天婦羅'] },
  { tag: '韓式', kw: ['韓式', '韓國料理', '韓式料理', '部隊鍋', '石鍋拌飯', '韓식'] },
  { tag: '泰式', kw: ['泰式', '泰國料理', '打拋'] },
  { tag: '越南', kw: ['越南', '河粉'] },
  { tag: '義式', kw: ['義式', '義大利', '義大利麵', '燉飯', '披薩', 'pizza', 'pasta'] },
  { tag: '美式', kw: ['美式', '漢堡', 'burger', '牛排', '早午餐店'] },
  { tag: '港式', kw: ['港式', '茶餐廳', '飲茶', '燒臘', '雲吞'] },
  { tag: '中式', kw: ['川菜', '江浙', '上海', '湘菜', '合菜', '桌菜'] },
  { tag: '台菜', kw: ['台菜', '熱炒', '快炒', '海產', '客家'] },
  { tag: '小吃', kw: ['小吃', '水餃', '鍋貼', '包子', '蔥油餅', '肉圓', '米糕', '碗粿', '粥', '羹', '臭豆腐'] },
  { tag: '早餐', kw: ['早餐', '豆漿', '吐司', '三明治', '蛋餅', '美而美'] },
  { tag: '早午餐', kw: ['早午餐', 'brunch'] },
  { tag: '宵夜', kw: ['宵夜', '鹹酥雞', '雞排', '滷味', '深夜'] },
  { tag: '咖啡', kw: ['咖啡', 'cafe', 'café', '咖啡廳'] },
  { tag: '甜點', kw: ['甜點', '蛋糕', '冰', '刨冰', '豆花', '鬆餅', '甜品', '布丁'] },
  { tag: '飲料', kw: ['飲料', '手搖', '茶飲', '果汁'] },
  { tag: '素食', kw: ['素食', '蔬食', '素'] },
  { tag: '咖哩', kw: ['咖哩'] },
  { tag: '速食', kw: ['麥當勞', '肯德基', '摩斯', '速食'] }
];

// 用餐時段 → 優先推薦的標籤。中午問「吃什麼」不該把甜點店排在牛肉麵前面。
export const MEAL_TAGS = {
  早餐:   ['早餐', '早午餐', '小吃', '飯食', '麵食'],
  早午餐: ['早午餐', '早餐', '咖啡', '美式'],
  午餐:   ['飯食', '麵食', '便當', '日式', '小吃', '台菜', '牛肉麵', '滷肉飯', '丼飯'],
  晚餐:   ['火鍋', '燒肉', '台菜', '日式', '韓式', '飯食', '麵食', '義式'],
  宵夜:   ['宵夜', '小吃', '麵食', '燒肉', '台菜'],
  下午茶: ['咖啡', '甜點', '飲料', '早午餐']
};

const MEAL_WORDS = {
  早餐: ['早餐', '早飯', '早上'],
  早午餐: ['早午餐', 'brunch'],
  午餐: ['午餐', '中餐', '中午'],
  晚餐: ['晚餐', '晚飯', '晚上'],
  宵夜: ['宵夜', '消夜', '半夜', '深夜'],
  下午茶: ['下午茶', '下午']
};

// ── 各類指令的觸發詞 ────────────────────────────────────────────────────
const ADD_VERBS = ['新增', '加入', '記一下', '記下', '記錄', '收藏', '存起來', '存一下', '加一家', '加一間', '加'];
const WANT_WORDS = ['想吃', '想去', '要吃', '沒吃過', '還沒吃', '待吃', '必吃', '朋友推薦', '朋友說', '推薦', '口袋名單'];
const OK_WORDS = ['常吃', '常去', '平常吃', '平常可吃', '可吃', '吃過', '去過', '愛店', '老店', '安全牌'];
const NOPE_WORDS = ['踩雷', '雷店', '難吃', '不好吃', '不去了', '別再去', '不推'];
const HERE_WORDS = ['就在這', '在這裡', '在這', '這裡', '目前位置', '現在位置', '我在這'];
const NEAR_WORDS = ['附近', '這附近', '旁邊', '周邊', '周圍', '走路', '最近的'];
const RANDOM_WORDS = ['隨機', '隨便', '骰', '抽一', '抽個', '選一個', '選一家', '選一間', '幫我選', '幫我決定', '決定不了', '選擇障礙', '不知道吃什麼', '不知道要吃什麼'];
const LIST_WORDS = ['清單', '列表', '名單', '有哪些', '哪些', '全部', '所有', '我的店', '列出'];
const ASK_WORDS = ['吃什麼', '吃啥', '吃甚麼', '要吃什麼', '要吃啥', '吃哪', '有什麼', '有啥'];
const VISIT_WORDS = ['吃過了', '去過了', '打卡', '今天吃了', '剛吃了', '吃了'];
const DEL_WORDS = ['刪掉', '刪除', '移除', '拿掉', '刪'];
const HELP_WORDS = ['說明', '怎麼用', '幫助', 'help', '?', '？', '指令'];

const has = (s, words) => words.some(w => s.includes(w));

// 字典裡所有可辨識的詞（標籤本身＋同義詞），長的排前面。
// 扣字一定要從長的扣起：先扣「麵」的話，「拉麵」會只剩「拉」，
// 「想吃拉麵」就會被當成「新增一家叫拉麵的店」而不是「查我的拉麵口袋名單」。
const TAG_WORDS_SORTED = [...new Set(TAG_DICT.flatMap(t => [t.tag, ...t.kw]))]
  .map(w => w.toLowerCase()).sort((a, b) => b.length - a.length);
const MEAL_WORDS_SORTED = [...new Set(Object.values(MEAL_WORDS).flat())]
  .sort((a, b) => b.length - a.length);
const stripAll = (s, words) => words.reduce((acc, w) => acc.split(w).join(' '), s);

// 全形標點與多餘空白正規化。使用者用注音打字很容易混進全形逗號跟空白，
// 不先正規化的話「加，鼎泰豐」會被當成店名的一部分。
function normalize(text) {
  return String(text || '')
    .replace(/[　﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 從店名猜標籤，例如「一蘭拉麵」→ ['拉麵','日式']。回傳最多 3 個。 */
export function guessTags(name) {
  const s = String(name || '').toLowerCase();
  const out = [];
  for (const { tag, kw } of TAG_DICT) {
    if (kw.some(k => s.includes(k.toLowerCase())) && !out.includes(tag)) out.push(tag);
  }
  // 「拉麵」同時命中麵食與拉麵時，保留比較specific的：把單字最長的排前面
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 3);
}

/** 句子裡出現的標籤（含字典同義詞）。給查詢用。 */
export function extractTags(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  // 先收 #標籤，使用者自訂的字典裡不會有
  for (const m of s.matchAll(/#([^\s#,，、]+)/g)) if (!out.includes(m[1])) out.push(m[1]);
  for (const { tag, kw } of TAG_DICT) {
    if (kw.some(k => s.includes(k.toLowerCase())) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// 「500公尺內」「1公里」「走路8分鐘」→ 公尺數。走路一分鐘抓 80 公尺（一般成人平地速度）。
function extractRadius(s) {
  let m = s.match(/(\d+(?:\.\d+)?)\s*(公里|千米|km)/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = s.match(/(\d+)\s*(?:公尺|米(?!其林)|m\b)/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/走路?\s*(\d+)\s*分/);
  if (m) return parseInt(m[1], 10) * 80;
  return null;
}

function extractMeal(s) {
  for (const [meal, words] of Object.entries(MEAL_WORDS)) if (has(s, words)) return meal;
  return null;
}

// 狀態關鍵字。回傳 null 代表句子沒指定，由呼叫端決定預設值。
function extractStatus(s) {
  if (has(s, NOPE_WORDS)) return 'nope';
  if (has(s, OK_WORDS)) return 'ok';
  if (has(s, WANT_WORDS)) return 'want';
  return null;
}

// 新增指令的剩餘文字 → 店名／地址／備註。
// 規則刻意簡單：明確分隔符（逗號、頓號、直線）優先，沒有才退回空白切。
// 第一段當店名，看起來像地址的那段當地址，其他併成備註。
// 解析錯了也不會怎樣——food.html 會先把結果攤成一張可改的卡片再存，不是直接寫進去。
const ADDR_RE = /[市縣區鄉鎮村里路街巷弄號段]|大道/;
function splitFields(rest) {
  let chunks = rest.split(/[,，、|｜]+/).map(t => t.trim()).filter(Boolean);
  if (chunks.length === 1) chunks = chunks[0].split(/\s+/).filter(Boolean);

  let name = '', addr = '', price = 0, rating = 0;
  const notes = [];
  for (const c of chunks) {
    if (/^\$+$/.test(c)) { price = Math.min(c.length, 4); continue; }
    let m = c.match(/^(?:均消|人均|大約|約)?(\d{2,4})\s*(?:元|塊)?$/);
    if (m && name) { price = priceLevelOf(parseInt(m[1], 10)); notes.push(c); continue; }
    m = c.match(/^(\d)\s*[星分]$/);
    if (m) { rating = parseInt(m[1], 10); continue; }
    if (!name) { name = c; continue; }
    if (!addr && ADDR_RE.test(c) && c.length >= 3) { addr = c; continue; }
    notes.push(c);
  }
  return { name, addr, note: notes.join(' '), price, rating };
}

/** 人均金額 → $ 級距。台灣的實際感受：150 以下便宜、150–350 中等、350–800 稍貴、800 以上高價。 */
export function priceLevelOf(amount) {
  if (!amount) return 0;
  if (amount < 150) return 1;
  if (amount < 350) return 2;
  if (amount < 800) return 3;
  return 4;
}

// 一段文字拿掉時段詞、標籤詞、助詞之後還剩不剩東西。
// 「想吃日式」剩下空的 → 是「我想吃日式料理，我有哪些選擇」；
// 「想吃一蘭拉麵」剩下「一蘭」 → 是要新增一家叫一蘭拉麵的店。
// 這條分界線就是「打字新增」跟「打字查詢」共用同一個輸入框還不會打架的原因。
function isPureFilterWords(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/\d+(?:\.\d+)?\s*(?:公里|千米|km|公尺|米|m)/gi, ' ')
       .replace(/走路?\s*\d+\s*分鐘?/g, ' ')
       .replace(/#[^\s#,，、]+/g, ' ');
  s = stripAll(s, MEAL_WORDS_SORTED);
  s = stripAll(s, TAG_WORDS_SORTED);
  return /^[的了嗎呢吧我要好耶內以下上還沒？?！!。,，、\s]*$/.test(s);
}

/**
 * 解析一句話。回傳 { type, ... }，type 是 add / find / mark / visit / remove / help / search。
 * 解析不出明確指令時一律回 search（當成關鍵字搜尋），不會誤新增——
 * 「打錯字就被靜靜加了一家不存在的店」比「查不到」難發現得多。
 */
export function parseCommand(input) {
  const raw = normalize(input);
  if (!raw) return null;
  const low = raw.toLowerCase();

  // 1) 說明
  if (HELP_WORDS.some(w => low === w || low === w + '?' || low.startsWith(w))) return { type: 'help', raw };

  // 2) 刪除：「刪掉鼎泰豐」
  for (const w of DEL_WORDS) {
    if (raw.startsWith(w)) {
      const target = raw.slice(w.length).replace(/^[這那個家間的\s]+/, '').trim();
      if (target) return { type: 'remove', target, raw };
    }
  }

  // 3) 標成踩雷 / 標成吃過：「鼎泰豐踩雷」「鼎泰豐吃過了」
  //    先於新增判斷，否則「鼎泰豐吃過了」會被 OK_WORDS 當成「新增一家平常可吃的店」。
  for (const w of NOPE_WORDS) {
    const i = raw.indexOf(w);
    if (i > 0) return { type: 'mark', target: raw.slice(0, i).trim(), status: 'nope', raw };
  }
  for (const w of VISIT_WORDS) {
    const i = raw.indexOf(w);
    // i>0 才算：「吃過了」單獨一句沒指名任何店，什麼都不該動
    if (i > 0) return { type: 'visit', target: raw.slice(0, i).trim(), raw };
  }

  // 4) 查詢：附近／吃什麼／隨機／清單／某個狀態的清單
  const wantsRandom = has(low, RANDOM_WORDS);
  const wantsNear = has(low, NEAR_WORDS);
  const wantsAsk = has(low, ASK_WORDS);
  const wantsList = has(low, LIST_WORDS);
  const meal = extractMeal(low);
  const radius = extractRadius(low);
  const statusWord = extractStatus(low);

  // 「想吃」後面還接著別的字 → 是新增（想吃鼎泰豐），不是查清單（想吃的清單）
  const afterStatusWord = statusWord
    ? normalize(stripAll(raw, [...WANT_WORDS, ...OK_WORDS, ...NOPE_WORDS])).replace(/^的/, '').trim()
    : raw;
  const statusWordIsFilter = !afterStatusWord || wantsList || wantsAsk || wantsNear || wantsRandom
    || isPureFilterWords(afterStatusWord);

  if (wantsRandom || wantsNear || wantsAsk || wantsList || (statusWord && statusWordIsFilter)) {
    const tags = extractTags(low).filter(t => !LIST_WORDS.includes(t));
    return {
      type: 'find',
      random: wantsRandom,
      filters: {
        // 沒特別講就是「能吃的」——踩雷的店不該出現在「附近吃什麼」裡
        status: statusWord ? [statusWord] : ['ok', 'want'],
        tags,
        meal,
        radius,
        near: wantsNear || !wantsList
      },
      raw
    };
  }

  // 5) 新增：開頭是新增動詞，或句中有想吃／常吃之類的狀態詞而且還有剩下的店名
  let body = null, status = null;
  for (const w of ADD_VERBS) {
    if (raw.startsWith(w)) { body = raw.slice(w.length).trim(); break; }
  }
  if (body === null && statusWord && afterStatusWord) { body = afterStatusWord; status = statusWord; }
  if (body !== null && body) {
    if (!status) status = extractStatus(body) || 'want'; // 沒講狀態一律當「想吃還沒吃」
    let rest = normalize(stripAll(body, [...WANT_WORDS, ...OK_WORDS, ...NOPE_WORDS]));
    const useHere = has(rest, HERE_WORDS);
    if (useHere) rest = normalize(stripAll(rest, HERE_WORDS));
    const hashTags = [...rest.matchAll(/#([^\s#,，、]+)/g)].map(m => m[1]);
    rest = normalize(rest.replace(/#[^\s#,，、]+/g, ''));
    const f = splitFields(rest);
    if (f.name) {
      const tags = [...new Set([...hashTags, ...guessTags(f.name + ' ' + f.note)])];
      return { type: 'add', name: f.name, status, tags, addr: f.addr, note: f.note,
               price: f.price, rating: f.rating, useHere, raw };
    }
  }

  // 6) 整句只有類別或時段詞（「火鍋」「宵夜」「日式」）→ 當成「我想吃這類，有哪些」
  const bareTags = extractTags(low);
  if (isPureFilterWords(raw) && (bareTags.length || meal)) {
    return {
      type: 'find', random: false,
      filters: { status: ['ok', 'want'], tags: bareTags, meal, radius, near: true },
      raw
    };
  }

  // 7) 其他一律當關鍵字搜尋（店名、備註都會比對）
  return { type: 'search', q: raw, raw };
}

// ── 距離與篩選（純計算，給地圖跟清單共用）────────────────────────────
const R = 6371000;
const rad = d => d * Math.PI / 180;

/** 兩點球面距離（公尺）。任一點缺座標回 null，呼叫端要自己處理「還沒定位的店」。 */
export function distance(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

export function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return `${m} 公尺`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} 公里`;
}

/** 今天是不是公休。closed 存的是星期幾陣列（0=日 … 6=六）。 */
export function isClosedOn(place, date = new Date()) {
  return Array.isArray(place.closed) && place.closed.includes(date.getDay());
}

/** 現在時間 → 用餐時段。給「吃什麼」在沒指定時段時自動判斷。 */
export function mealOfHour(hour) {
  if (hour < 4) return '宵夜';
  if (hour < 10.5) return '早餐';
  if (hour < 14) return '午餐';
  if (hour < 17) return '下午茶';
  if (hour < 21) return '晚餐';
  return '宵夜';
}

/**
 * 依條件挑店並排序。origin 是目前位置（可為 null）。
 * 排序邏輯：先照條件過濾，再用「距離為主、時段吻合度為輔」排。
 * 沒有定位時退回用評分與新增時間排，不會整個壞掉。
 */
export function selectPlaces(places, filters = {}, ctx = {}) {
  const { origin = null, now = new Date() } = ctx;
  const st = filters.status && filters.status.length ? filters.status : ['ok', 'want'];
  const tags = (filters.tags || []).map(t => t.toLowerCase());
  const mealTags = filters.meal ? (MEAL_TAGS[filters.meal] || []) : [];

  let out = places.filter(p => {
    if (!st.includes(p.status)) return false;
    if (tags.length && !tags.every(t =>
      (p.tags || []).some(pt => pt.toLowerCase().includes(t)) ||
      (p.name || '').toLowerCase().includes(t))) return false;
    if (filters.openToday && isClosedOn(p, now)) return false;
    return true;
  }).map(p => ({ ...p, _dist: distance(origin, p) }));

  if (filters.radius && origin) out = out.filter(p => p._dist != null && p._dist <= filters.radius);

  out.sort((a, b) => {
    // 有座標的永遠排在沒座標的前面：清單最上面就該是現在走得到的店
    const ad = a._dist, bd = b._dist;
    if (origin) {
      if (ad == null && bd != null) return 1;
      if (bd == null && ad != null) return -1;
      if (ad != null && bd != null && ad !== bd) return ad - bd;
    }
    if (mealTags.length) {
      const score = p => (p.tags || []).some(t => mealTags.includes(t)) ? 0 : 1;
      const d = score(a) - score(b);
      if (d) return d;
    }
    if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
    return String(a.name).localeCompare(String(b.name), 'zh-Hant');
  });
  return out;
}

/** 用店名找店：完全相同 > 開頭相同 > 包含。找不到回 null。 */
export function findPlace(places, target) {
  const t = normalize(target).toLowerCase();
  if (!t) return null;
  const names = places.map(p => ({ p, n: String(p.name || '').toLowerCase() }));
  return (names.find(x => x.n === t)
    || names.find(x => x.n.startsWith(t))
    || names.find(x => x.n.includes(t))
    || names.find(x => t.includes(x.n) && x.n.length >= 2)
    || {}).p || null;
}
