// 「這場答不出來」→ 自動補查工研院官網新聞中心（批次 31～37、57）：[[NO_DATA:關鍵詞]] 標記的切除
// 與判讀、從問句猜關鍵詞、補查官網、把查到的結果讀成答案。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。
// api/line.js 照樣 re-export extractNoDataKeyword／guessNoDataKeyword。

import { fetchItriNews, formatNewsForPrompt } from './itri-news.js';
import { shortNewsUrl } from './short-link.js';
import { TONE_RULE, sanitize } from './line-format.js';
import { askAnthropic } from './line-runtime.js';

// ── 「這場答不出來」→ 自動補查工研院官網（批次 31）─────────────────────────
// 把 AI 加在結尾的 [[NO_DATA:關鍵詞]] 標記切下來（見 lineExtraRules() 的完整說明）。
// ⚠️ 不管有沒有要用這個關鍵詞，標記一定要切掉——那行是給程式看的，漏在回覆裡讓記者
// 看到一串 [[NO_DATA:院士]] 比什麼都沒做還糟。回傳 { text, keyword }。
// ⚠️ 批次 33：第一版把這條正則錨定在字串結尾（`$`），實際回報的截圖就是它漏掉的——
// 記者收到的訊息裡原封不動印著一行 `[[NO_DATA:院士]]`。
//
// 根因是**兩條規則搶同一個位置**：lib/prompt.js 的結尾規則要求「每則回答的最後，務必
// 另起一行加註警語」，我這條標記規則也寫「整則回覆的最後」。模型選了把警語放最後
// （那條更老、更強、講得更重），標記被擠到警語前面一行，`$` 就對不上了。
//
// 而且這一個 miss 同時造成兩個症狀：標記漏給記者看到，**而且**因為抽不到關鍵詞，
// 官網補查那條路根本沒跑——記者既看到亂碼、又沒拿到本來該給他的連結。
//
// 修法是不要跟位置賭：**整段裡任何地方出現都抓掉**（g 旗標，出現兩次也清乾淨）。
// 位置本來就不該由我們決定——規則要求模型把某段文字放在特定位置，本身就是脆弱的。
const NO_DATA_RE = /\[\[\s*NO_DATA\s*[:：]?\s*([^\]]*?)\s*\]\]/g;

// 第二道防線：整行以 NO_DATA 開頭（括號打壞、少一邊、或模型自己換了寫法）。
// 中文回覆裡不可能有正當內容以 NO_DATA 開頭，整行拿掉是安全的。
const NO_DATA_LINE_RE = /^[ \t]*\[{0,2}[ \t]*NO_DATA[ \t]*[:：].*$/gim;

export function extractNoDataKeyword(raw) {
  let keyword = '';
  const text = String(raw || '')
    .replace(NO_DATA_RE, (_m, kw) => {
      if (!keyword) keyword = String(kw || '').trim().slice(0, 20);
      return '';
    })
    .replace(NO_DATA_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, keyword };
}

// 這場的知識庫答不出來時，拿記者真正在問的關鍵詞去工研院官網新聞中心補查一次，
// 查到就把標題與連結接在答案後面。
//
// ⚠️ 只給「線索」，不重寫內容：這裡刻意不再叫一次 AI 去摘要那幾則報導。記者要的是
// 「哪裡找得到」，直接給標題＋日期＋原文連結最準也最快；多叫一次 AI 除了慢，還多一次
// 把官網原文講走鐘的機會——而這則回覆掛的是主辦單位名義（同 lineExtraRules() 的顧慮）。
//
// 查不到（或抓取失敗）就回空字串，原本那句誠實的「我沒有這項資料」照舊送出去，
// 不會因為補查失敗而讓記者收不到答案。
const NO_DATA_MAX_LINKS = 2;

// 補查這條路一次能花的時間上限，以及「低於這個數字就不要開始」的門檻。
// 12 秒的來源：一次官網清單頁實測一兩秒，最壞情況兩個候選詞各查兩次（見
// lib/itri-news.js 去語助詞重試那段）＝ 4 次，再加一次把結果讀成答案的模型呼叫。
// 4 秒以下連第一次 HTTP 都不一定回得來，與其開始了又中途放棄，不如直接把答案送出去。
export const LOOKUP_BUDGET_MS = 12_000;
export const LOOKUP_MIN_MS = 4_000;

// ── 不再只靠模型自己標記（批次 37）─────────────────────────────────────────
// 連續三批（31→33→34）都在修「標記為什麼沒出現」，最後一次實測仍然沒跑：回覆明明
// 就是「這題目前我手上沒有具體的名單資料」，補查那條路照樣沒動。
//
// 到這裡結論很清楚：**請模型在回答裡順手加一個機器讀的標記，本來就不是可靠的機制**。
// 它每次都要在「照規則加標記」跟「把回答寫好」之間分心，而規則再怎麼寫都只是請求。
// 標記留著（它抓到的關鍵詞語意最準，有加就用），但不能再是唯一的觸發條件——補上
// 一道純程式的判斷：回覆的內容看起來就是在說「我沒有這項資料」時，一樣去補查。
//
// ⚠️ 誤判的代價很小：多查一次官網，查到就多附兩個連結、查不到就什麼都不加。
// 漏判的代價才大（記者本來拿得到答案卻沒拿到），所以這裡刻意放寬。
export const NO_DATA_PHRASE_RE = /(沒有|未|查不到|找不到).{0,10}(資料|內容|資訊|名單|說明)|沒有提到|未提及|沒有這方面|手上沒有|不在.{0,6}資料/;

// 標記沒出現時，退而求其次從記者的問句猜一個關鍵詞。
// 「今年院士」→「院士」、「今年院士有誰」→「院士」、「得獎名單」→「得獎名單」。
// ⚠️ 刻意不共用 lib/itri-news.js 的 stripTechQueryFiller()：那支是給「想問什麼技術」
// 那條路用的，多拿掉「今年」「有誰」這些詞會影響到那邊的既有行為。這裡是不同的場景，
// 各自維護一份短清單比硬共用安全。
const NO_DATA_FILLER_RE = /今年|去年|明年|今天|昨天|明天|最近|最新|目前|現在|本屆|這次|本次|有誰|是誰|哪些|哪位|什麼|甚麼|請問|想問|想知道|一下|我們|你們|活動|的|嗎|呢|吧|了|喔|耶|[\s?？！!。，,、：:]/g;
// 拿掉語助詞之後常會在尾巴留下一個孤零零的動詞／繫詞（「得獎名單是」「合作廠商有」）。
// 只切尾巴、不全域切——「有機材料」「是非題」這種詞中間的字不能動。
const NO_DATA_TAIL_RE = /[是有為會在要能與和及]+$/;

// 「這個詞拿去查官網新聞中心根本沒有意義」的關鍵詞（批次 44）。
//
// 實際回報的截圖：記者在群組打「新聞稿」，本場正確地回了「這場狀態是稍晚提供，還沒有
// 完整新聞稿全文」＋大會手冊＋新聞聯絡人——到這裡都對。壞在後面自動接上的補查區塊：
// 拿「新聞稿」三個字去搜官網，撈回三篇只因為內文出現過「新聞稿」而中的無關報導
// （致茂論文競賽、管風琴演奏會），還一本正經地列出原文連結。
//
// 根因是這類詞講的是「資料本身」，不是主題。官網搜尋是字面比對，用這種詞去查，
// 命中的必然是雜訊——而雜訊附在一則本來很得體的回答後面，比什麼都不加傷害更大
// （記者會以為米亞在硬湊）。
//
// ⚠️ 只擋「整個關鍵詞剛好等於這些字」，不做包含比對：「得獎名單」「開幕照片」是有主題
// 的詞，查得到東西也該查；被擋掉的只有孤零零的「名單」「照片」。
const NO_DATA_GENERIC = new Set([
  '新聞稿', '新聞', '稿件', '全文', '新聞稿全文', '資料', '相關資料', '內容', '相關內容',
  '照片', '圖片', '相片', '影片', '簡報', '檔案', '名單', '清單', '說明', '資訊',
  'press release', 'photo', 'photos', 'material', 'materials', 'information'
]);
export function isGenericLookupKeyword(kw) {
  return NO_DATA_GENERIC.has(String(kw || '').trim().toLowerCase());
}

// ── 綁定中點「新聞稿」這類泛用詞的按鈕 → 不能被判去問工研院整體新聞（回報，2026-09）──
// 實際回報：記者在群組打「創新日」綁定到那一場之後，點了那一場自訂的快速提問按鈕
// 「新聞稿」，結果拿到的是「工研院官網新聞中心最近發布的新聞」清單（ICT TechDay、
// VAMAS 研討會…），沒有一則跟創新日有關——按鈕明明是問「這一場」的新聞稿，答案卻是
// 全站最新新聞。
//
// 根因在 routeIntent()：它的 systemPrompt 明講「工研院最近發了哪些新聞／新聞稿」這種
// 不指定主題的問題算 tech_query（這時候 tech_keyword 留空），這條規則的本意是給「工研院
// 最近有什麼新聞」這種完整句子用的，但同一份指示也讓模型看到孤零零的「新聞稿」三個字
// 時往同一個方向偏，蓋過了「目前綁定在這一場」那條 currentEvent 提示——這正是 CLAUDE.md
// 第 2 條講的「prompt 是請求，不是保證」：模型九成九會照 currentEvent 提示判成 qa，
// 剩下那一次就是這次記者截圖回報的那一次。
//
// 修法不是再去調 routeIntent() 的用詞（同一個坑踩過四次，見 CLAUDE.md 第 2 條）：
// 已經綁定某一場、而且訊息本身就是這種「講的是資料本身、不是主題」的泛用詞
// （isGenericLookupKeyword 是整字比對，跟 NO_DATA_GENERIC／批次 44 補查關鍵詞卡住雜訊
// 用的同一份判準）時，直接把結果釘回這一場的 qa，不再信任 routeIntent() 這次的分類。
//
// ⚠️ 只在 tech_keyword 是空字串時才覆蓋：訊息如果明確提到「工研院」或帶了具體技術／
// 主題（「工研院院士授證的新聞稿」「半導體最近有什麼新聞」），routeIntent() 會抽出
// 對應的 tech_keyword，這種才是記者真的在問公司整體動態或另一個主題，不能覆蓋，
// 否則反而會把「這場沒有的話題」硬答成這一場的內容。
export function pinGenericTechQueryToEvent(routed, text, eventId) {
  if (routed.intent === 'tech_query' && !routed.tech_keyword && isGenericLookupKeyword(text)) {
    return { ...routed, intent: 'qa', event_ids: [eventId], confidence: 'high' };
  }
  return routed;
}

export function guessNoDataKeyword(question) {
  const kw = String(question || '').replace(NO_DATA_FILLER_RE, '').replace(NO_DATA_TAIL_RE, '').trim();
  // 太短（剩一個字）沒有查詢價值，太長多半是沒抽乾淨的整句話，兩種都放棄——
  // 放棄就是不補查，回到原本那句誠實的回答，不會更糟。
  return /^[^\s]{2,20}$/.test(kw) ? kw : '';
}

// 這段引言是「我們自己加的」，不是模型寫的——所以 lib/prompt.js 那條「跟著記者的
// 提問語言回答」的規則管不到它，得自己判斷。不然英文記者會拿到一段英文答案、下面
// 突然接一句中文，看起來像壞掉（批次 34 補：那條語言規則存在就是為了服務英文提問，
// 我們自己接的字卻破功，等於白做）。
//
// 判斷只看「模型剛剛那段答案裡有沒有中文字」——這比重新猜記者用什麼語言可靠：答案
// 的語言已經是模型跟著提問語言決定好的結果，跟著它走就一定一致。
export function hasChinese(text) {
  return /[一-鿿]/.test(String(text || ''));
}

// keywords：候選關鍵詞，依序試到查得到為止。
//
// ⚠️ 批次 39：原本這裡只收「一個」關鍵詞，呼叫端用 `標記 || 猜的` 二選一——實測踩到
// 的正是這個：模型的標記吐成一整句（「今年受證院士的具體名單和人數」，官網查 0 筆），
// 而句型判斷猜出來的「院士」查得到 10 筆，卻因為標記優先、標記查不到就整個放棄，
// 從來沒被試過。
//
// 兩個來源各有各的長處——標記的語意最準、猜的最乾淨——不該二選一，該依序試。
// budgetMs（批次 57）：這條路總共能花多少時間，由呼叫端從「這次請求還剩多少」算出來
// （見 answerQuestion() 那段的說明）。時間用完就停在目前的結果上——補查是加分，
// 不能讓它把已經算好的答案一起拖下水。
function newsMentions(item, kw) {
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  const k = norm(kw);
  return !!k && norm(`${item?.title || ''}${item?.abstract || ''}`).includes(k);
}

export async function itriNewsHintBlock(keywords, { chinese = true, question = '', budgetMs = LOOKUP_BUDGET_MS } = {}) {
  const until = Date.now() + budgetMs;
  const list = [...new Set((Array.isArray(keywords) ? keywords : [keywords])
    .map(k => sanitize(k, 40)).filter(Boolean))]
    // 泛用詞查了只會撈到雜訊，見 NO_DATA_GENERIC 的說明
    .filter(k => {
      if (!isGenericLookupKeyword(k)) return true;
      console.log(`[line] 補查官網跳過泛用關鍵詞 kw="${k}"`);
      return false;
    });
  if (!list.length) return '';
  try {
    let kw = '', items = [];
    for (const candidate of list) {
      // 剩下的時間連一次 HTTP 都不夠（見 lib/itri-news.js 的 10 秒逾時）就不要再開始，
      // 已經查到的就用，沒查到就放棄補查——答案本身早就算好了，那才是要保住的東西。
      if (Date.now() > until - 2_000) {
        console.log(`[line] 補查官網：預算用完，不再試候選 kw="${candidate}"`);
        break;
      }
      const res = await fetchItriNews(candidate);
      // 批次 86：官網搜尋是全文比對，「天氣」撈得到內文順帶提過天氣的能源新聞。這裡附的是
      // 「這題的相關報導」，標題或摘要沒提到這個詞的就不算——寧可不附，也不要附一篇答非所問的。
      const relevant = res.ok ? res.items.filter(it => newsMentions(it, candidate)) : [];
      if (relevant.length) { kw = candidate; items = relevant; break; }
      if (res.ok && res.items.length) console.log(`[line] 補查官網 kw="${candidate}" 有 ${res.items.length} 筆，但標題／摘要都沒提到，不附`);
      else console.log(`[line] 補查官網 kw="${candidate}" 查無資料，試下一個候選`);
    }
    if (!items.length) return '';
    console.log(`[line] 補查官網命中 kw="${kw}" ${items.length} 筆`);

    const links = items.slice(0, NO_DATA_MAX_LINKS)
      .map(it => `・${it.title}${it.date ? `（${it.date}）` : ''}\n${shortNewsUrl(it.id) || it.url}`) // 批次 122：短網址；抓不到編號才退回官網原網址
      .join('\n');

    // ── 找到了就「讀懂它」，不是只丟連結（批次 38）─────────────────────────
    // 使用者確認：那場活動的知識庫是空的，內容只存在工研院官網新聞室。也就是說
    // 這條補查是這題**唯一**答得出來的路——那就不能只給連結。使用者兩輪前的原話
    // 是「不是給新聞稿，而是會讀懂消化」，丟兩個連結叫記者自己點進去看，正是那句
    // 話在講的問題。
    //
    // 搜尋結果本來就帶著標題／日期／摘要，再叫一次模型把它讀成答案即可。
    // ⚠️ 這是這條路上的第二次模型呼叫，但它**只發生在「本場答不出來」這條路**——
    // 正常答得出來的提問一次都不會多花。用這個代價換「記者真的拿到答案」很划算。
    // ⚠️ 摘要不是全文：規則明講只能根據摘要回答、不足的部分要請記者看原文，
    // 不可以把摘要沒寫的細節補完（跟活動問答同一條底線）。
    // 查到了，但剩下的時間不夠再叫一次模型把它讀成答案——那就只附連結（那本來就是
    // 批次 38 之前的行為，不是壞掉的狀態），記者一樣拿得到線索。
    const digestBudget = until - Date.now();
    const digest = digestBudget >= LOOKUP_MIN_MS
      ? await answerFromItriNews(kw, items, question, chinese, digestBudget)
      : '';
    if (digestBudget < LOOKUP_MIN_MS) console.log('[line] 補查官網：預算不夠讀成答案，只附連結');
    const lead = digest
      ? (chinese ? '這題本場的新聞資料裡沒有，不過我在工研院官網新聞中心找到了：'
                 : "This isn't in this event's material, but I found it in ITRI's official newsroom:")
      : (chinese ? '這題本場的新聞資料裡沒有，不過工研院官網新聞中心有相關報導，您可以直接看原文：'
                 : "This isn't in this event's material, but ITRI's official newsroom has related coverage — here are the originals:");
    const body = digest ? `${digest}\n\n${chinese ? '🔗 原文：' : '🔗 Sources:'}\n${links}` : links;
    return `\n\n———\n${lead}\n${body}`;
  } catch (e) {
    console.error('itriNewsHintBlock 失敗:', e.message);
    return '';
  }
}

// 把官網搜到的報導讀成一段答案。組不出來（沒 API key、呼叫失敗、模型說看不出來）
// 就回空字串，呼叫端自動退回「只給連結」——那是原本就有的行為，不會更糟。
async function answerFromItriNews(keyword, items, question, chinese, timeoutMs = LOOKUP_BUDGET_MS) {
  const q = sanitize(question, 300) || keyword;
  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」。',
    `記者問了一個問題，但這場活動的新聞資料裡沒有答案；下面是用「${keyword}」在工研院官網新聞中心查到的報導（標題／日期／摘要）。請根據這些報導直接回答記者的問題。`,
    '',
    '規則：',
    '- 只能根據下面的標題與摘要回答。這些是摘要不是全文，摘要沒寫的細節（完整名單、具體數字、人物職稱）一律不要補完、不要推測——那種內容請記者點原文連結看。',
    '- 摘要裡如果根本沒有記者要的答案，就直接回一個空字串，什麼都不要寫（呼叫端會改成只附連結）。不要寫「查不到」之類的句子，那句話呼叫端已經講過了。',
    '- 回答控制在 3 行以內，並且明確講出這是工研院官網新聞中心的報導、哪一天發布的。',
    '- 不要用 Markdown 語法。不要加結尾警語（呼叫端的回覆裡已經有了）。',
    '- 不要重複「這題本場資料裡沒有」這件事，呼叫端已經講過，直接講你找到什麼。',
    '- 不要反問記者、不要建議「換個關鍵字再查一次」、不要說明你查了什麼卻沒查到——這些都是呼叫端的事。你只有兩種輸出：找得到答案就直接講，找不到就回空字串。',
    chinese
      ? '- 用繁體中文回答。'
      : '- Answer in English (the reporter asked in English).',
    TONE_RULE,
    '',
    `【工研院官網新聞中心 搜尋「${keyword}」的結果，由新到舊】`,
    formatNewsForPrompt(items)
  ].join('\n');

  try {
    // ⚠️ 這一段也要過一次標記清理：這支的規則沒叫模型加 [[NO_DATA:…]]，但同一個
    // 帳號的其他 prompt 有，模型偶爾會把習慣帶過來。漏出去給記者看到的代價太大
    // （批次 33 已經踩過一次），統一清掉比賭它不會發生便宜。
    const raw = String(await askAnthropic(systemPrompt, q, [], { timeoutMs }) || '');
    const reply = extractNoDataKeyword(raw).text.trim();
    // 模型照規則回空字串（摘要裡真的沒有答案），或吐回 askAnthropic 自己的失敗訊息，
    // 兩種都當作「組不出答案」，退回只給連結。
    // 只認「空的」＝模型照規則說摘要裡沒有答案。刻意不設長度門檻——一個「幾個字
    // 以下就丟掉」的魔術數字，會把真的很短但正確的答案（「三位，分別是⋯」）誤殺。
    if (!reply) return '';
    if (/抱歉，目前無法取得回應|系統目前無法回答|無法取得回應/.test(reply)) return '';
    // ⚠️ 規則有叫模型「摘要裡沒答案就回空字串」，但規則是請求、不是保證。實測回報
    // 的截圖裡它改成用一整段話說「我手上資料沒有能直接回答的內容耶⋯⋯建議您換個更
    // 明確的關鍵字」——非空，於是被當成答案用掉，接在「我在工研院官網新聞中心找到
    // 了：」後面，變成前後文自相矛盾的一則回覆（說找到了，內文說沒找到）。
    // 這裡補一道程式面的判斷：這段話本身就是「答不出來」的話，一律當空的處理，
    // 退回只附連結。跟 stripMarkdownForLine() 同一個道理——出口再擋一次比賭它守規矩便宜。
    if (NO_DATA_PHRASE_RE.test(reply) ||
        /沒有.{0,8}(直接)?(回答|對應)|沒有直接相關|換個.{0,6}關鍵字|再幫您查|不太相關|沒有提及/.test(reply)) {
      console.log(`[line] 補查官網：模型自己說答不出來，退回只附連結 kw="${keyword}"`);
      return '';
    }
    return reply;
  } catch (e) {
    console.error('answerFromItriNews 失敗:', e.message);
    return '';
  }
}
