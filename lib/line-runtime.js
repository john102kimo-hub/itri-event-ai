// 米亞（LINE）每一則回覆都會經過的地方：這次請求的死線、限流、答題模型（askAnthropic）、
// 按鈕與送出回覆（replyOrPush）。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。
//
// ⚠️ 死線與「這一則要引用的訊息」存在 requestCtx（AsyncLocalStorage）。api/line.js 的 handler
// 每個請求 requestCtx.run() 一次，這支裡的 msLeft()／takeQuoteToken() 才讀得到。

import { AsyncLocalStorage } from 'async_hooks';
import { toTraditionalTW, ZH_TW_RULE } from './zh-tw.js';
import { replyOrPush as replyOrPushRaw, pushMessage } from './line.js';
import { calendarQuickReplyItems } from './router.js';
import { STAFF_MENU } from './menu.js';
import { TECH_DOMAINS, techPickText } from './itri-tech.js';
import { logAiUsage } from './ai-usage.js';
import { effectiveChips } from './default-chips.js';
import { reportAiFailure, BUSINESS_KEY_NAME } from './ai-alert.js';
import { getMemories, formatStyleRules } from './bot-memory.js';
import { stripMarkdownForLine, tidyLineLayout } from './line-format.js';
import { setBindingNote } from './line-store.js';

// ── 陽春限流：同一 line_user_id 60 秒內最多 15 次問答 ───────────────────
// 跟 api/chat.js 的 ipHits 同一套邏輯，只是 key 換成 line_user_id——LINE 的 webhook
// 全部來自 LINE 自己的伺服器 IP，用 IP 當 key 會讓全部記者共用同一個額度、互相誤殺。
const hits = new Map();
export function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 60 * 1000);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 2000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > 60 * 1000) hits.delete(k);
    }
  }
  return arr.length > 15;
}
// ── 答題模型（批次 36）─────────────────────────────────────────────────────
// 回報的意見：「不是給新聞稿，而是會讀懂消化」——記者問「今年院士有誰」，答案就寫在
// 那場的新聞稿裡，它卻說沒有。
//
// 這裡原本用 Haiku 4.5。當初選它是為了成本，而它拿來做「這句話要路由到哪一條路」
// 很稱職——但要它讀完一整篇新聞稿、把埋在段落中間的名單抓出來就明顯吃力，那正是
// 回報的症狀。答題這條路換成 Sonnet 5：閱讀理解好很多，上下文 200K 變成 1M（跨場次
// 資料要塞得下也靠這個），成本約兩倍，但既有的 ephemeral 快取讓重複提問便宜十倍，
// 以記者會的問答量絕對划算。
//
// ⚠️ 路由（lib/router.js routeIntent）刻意不跟著換：那是分類題、每則訊息都要跑，
// Haiku 又快又便宜又夠準，換上去只是白花錢。貴的模型要花在真正需要理解力的地方。
//
// ⚠️ 延伸思考維持關掉：省略 thinking 參數會預設開啟 adaptive thinking，那會讓
// 每則回覆多等好幾秒——LINE 的 reply token 只有 60 秒，記者在等的是聊天速度的回應。
// 讀新聞稿找名單是閱讀題不是推理題，不開延伸思考就綽綽有餘。之後若發現答案深度不足，
// 這裡是第一個該調的旋鈕（拿掉 thinking 參數＝adaptive，或降 effort 而不是關掉）。
// 批次 98：Sonnet 5 → Sonnet 5.5（朱朱 9/30）。5.5 拒收 `thinking: {type:'disabled'}`（400），
// 「不做延伸思考」的寫法改成 `{type:'between_tools'}`，只能搭配 effort high 以下（預設 high）、
// 不能再帶 display／budget_tokens 等其他欄位；模型 ID 與價格不變（$2／$10 per MTok）。
// 路由與網頁版問答當時仍用 Haiku 4.5；批次 120 已一併升到 Haiku 5.5（見 docs/batches/10-batch-117.md）。
const ANSWER_MODEL = 'claude-sonnet-5-5';

// extraSystem（批次 36）：選填的第二個 system 區塊，放跨場次的相關資料。
// ⚠️ 刻意不併進第一個區塊：那一塊逐 byte 穩定才吃得到 ephemeral cache，而這一塊
// 因「這一題問了什麼」而異，混進去只會讓每題都重新建快取（跟 lib/router.js
// currentEventId 那段拆成兩塊是完全一樣的理由）。
// 第一層防線：明確要求繁體。整份 prompt 原本從頭到尾沒有任何一條規則講這件事——
// 警語那條只寫「內容等同於⋯⋯」，模型就照自己的習慣重打一次，偶爾打成簡體（回報的
// 截圖就是這樣：整則都是繁體，只有最後那句警語變簡體）。
// ⚠️ 這是「請求」，不是保證；真正的保證是出口的 toTraditionalTW()。兩層都要有：
// 規則讓模型一開始就寫對（大部分情況），出口負責兜住剩下的。
// 放在這支裡而不是各個呼叫端的 prompt：這裡是**所有**模型呼叫的唯一入口，寫一次
// 四條問答路線（活動、產業趨勢、技術查詢、官網補查）與兜底文案全部受惠，不會有人
// 新增一條路線時忘記加。
// 句子本身住在 lib/zh-tw.js（批次 82 搬過去，網頁版問答 api/chat.js 也要帶同一句）。

// ── 版面規則（批次 59）──────────────────────────────────────────────────────
// 回報（附兩張截圖）：「文字排版很亂 能夠精進嗎 整體上」。兩張是不同的壞法：
//   ① 產業趨勢那則把「9/6 人型機器人」與「8/6 CPO」兩篇報告擠進同一段，手機上是
//      十幾個視覺行的一大坨字，記者要自己在裡面找哪句話屬於哪一篇
//   ② 活動問答那則（「演講者有誰」）其實**有**結構——開場暨引言／國際論壇／淨零
//      永續專題…每組一行——但沒有項目符號、組跟組之間沒有空行，一樣糊成一塊
//
// 三個根因，都不是模型不聽話，是規則本身有問題：
//
// **「N 行以內」在手機上不是一個有意義的單位。** 四條路線各自寫著 5 行／4 行／4 行／
// 3 行，而模型把「行」讀成「句」或「段」——截圖 ① 在它眼裡確實是「4 行以內」。手機
// 一行只放得下大約 16 個中文字，「行」這個詞在模型跟畫面之間根本對不起來。
//
// **兩條既有規則互相打架。** lineExtraRules() 說「需要條列就用『・』開頭」，
// TONE_RULE 說「不要用一長串條列把記者淹沒」。模型同時收到「該條列」與「不要條列」，
// 交出來的是最糟的組合：列了一長串、卻不用符號也不換行——截圖 ② 正是這個形狀。
//
// **沒有任何一條規則提過「空行」。** 手機可讀性最關鍵的一件事，四條路線一個字都沒寫。
//
// ⚠️ 這條放在 askAnthropic() 的共用 system 區塊（跟 ZH_TW_RULE 同一個位置），不是
// 各路線各寫一份——活動問答、產業趨勢、工研院技術、官網補查、智慧兜底五條路一次到位，
// 以後新增路線也不會漏掉。這正是批次 53「三個各說各話的字數上限」的教訓：同一件事
// 散在好幾個地方各寫一份，遲早會漂開。
//
// ⚠️ 這是 prompt、不是程式保證，而且刻意如此。CLAUDE.md 第 2 條的判準是「偶爾沒照做
// 會不會出事」——排版難看不會出事，而「怎樣算排得好」要看內容有幾則、每則多長，
// 沒有一條死規則做得到。程式那一半只做**零風險**的機械修整（見 tidyLineLayout()）。
const LAYOUT_RULE = [
  '版面：記者是在手機上看這則訊息，一行只放得下大約 16 個中文字。排得好不好讀，跟內容對不對一樣重要。',
  '① 段落之間一定空一行。不要把整則回覆寫成沒有換行的一大段。',
  '② 只要有兩則以上的資料、兩個以上的項目（多篇報告、多位講者、多個場次、多個時段），一定要條列：每一項用「・」開頭、自己獨立一行，不要用頓號或逗號把它們串在同一句話裡。',
  '③ 條列的每一項如果同時有「標題」和「說明」，標題放在「・」那一行，說明另起一行、開頭用一個全形空白縮排。不要把標題和兩三句說明擠成同一行。',
  '④ 開場那句話和結尾那句話各自獨立成段，跟中間的條列之間空一行，不要黏在第一項或最後一項上。',
  '⑤ 其他規則裡講的「幾行以內」指的是段落或條列項目的數量，不是手機上的視覺行數——不要為了湊行數把好幾件事擠進同一段。'
].join('\n');

// ── 這一次請求還剩多少時間（批次 57）────────────────────────────────────────
// 這支底下每一個 fetch() 原本都沒有 signal，也就是「上游不回應就等到天荒地老」。
// 那在 Vercel 上不是「慢一點」，是**整支被砍掉**：vercel.json 給 api/line.js 的
// maxDuration 是 60 秒，時間到 function 直接消失，沒有 catch 會跑到、沒有回覆會送出，
// 記者那邊就是已讀不回（跟 apologise() 那段是同一種傷害，只是原因不同——那邊是例外，
// 這邊是根本沒機會丟例外）。
//
// 逾時的價值不在「省時間」，在於**把沉默換成一句話**：AbortSignal.timeout() 觸發後
// fetch 會丟 AbortError，catch 就會回一句「目前無法取得回應」，記者至少知道要再問
// 一次或找聯絡人。
//
// ⚠️ 為什麼不是每支各自寫死一個秒數，而是共用一個「這次請求的死線」：這條路上會依序
// 打好幾次外部呼叫（路由 → 答題 → 補查官網最多 4 次 HTTP → 再一次模型），寫死的秒數
// 各自看起來都很合理，加起來卻會超過 60。死線是唯一算得準的東西——每一段都問「還剩
// 多少」，前面慢了後面就自動讓路，不會有人各自超支。
//
// 55 秒不是 60：留 5 秒給送出回覆、寫 qa_log 這些收尾動作。答案算得出來卻沒送出去，
// 跟沒算出來一樣糟（CLAUDE.md 第 4 條的同一個道理）。
//
// ⚠️ 死線存在 AsyncLocalStorage、不是模組層的一個變數：Vercel 的一個執行個體可能同時
// 處理多個請求，用共用變數的話，後到的請求會把先到的那個死線往後推——先到的那個就會
// 以為自己還很寬裕，然後在 60 秒被砍掉，正好是這整段要防的事。AsyncLocalStorage 是
// Node 內建，不違反這個專案「零 npm 依賴」的慣例。
export const REQUEST_BUDGET_MS = 55_000;
export const requestCtx = new AsyncLocalStorage();
export function msLeft() {
  const at = requestCtx.getStore()?.deadlineAt;
  return at ? Math.max(0, at - Date.now()) : REQUEST_BUDGET_MS;
}
// 給某一段外部呼叫的逾時：想要 want 毫秒，但不能吃掉「送出回覆」要留的 reserve。
// 回傳 0 代表「已經沒有時間了，這段不要做」——呼叫端要看得懂這個訊號。
export function budgetFor(want, reserve) {
  return Math.max(0, Math.min(want, msLeft() - reserve));
}

// 答題模型的上限。刻意給得寬（記者要「完整新聞稿」時模型會吐到 max_tokens 4096，
// 那本來就慢），真正的保護是上面的死線——實際用的是 budgetFor() 算出來的餘額。
const ANSWER_TIMEOUT_MS = 45_000;
// 送出回覆＋寫 qa_log 要留的時間。
export const REPLY_RESERVE_MS = 5_000;

// history：選填的上一輪對話（[{role:'user'},{role:'assistant'}]，見 buildTurnHistory()）。
// 沒帶就是原本「每次只送一則」的行為，所有既有呼叫端都不受影響。
// business（批次 118／119）：企業場的問答。有設 ANTHROPIC_API_KEY_BUSINESS 就用那一把（Anthropic Console 另開一個
// workspace、另設每月花費上限）——業發處的用量再大，也吃不到記者那邊的額度；沒設就照舊用同一把。
export async function askAnthropic(systemPrompt, userText, history = [], { extraSystem = '', timeoutMs = ANSWER_TIMEOUT_MS, business = false } = {}) {
  const businessKey = business && !!process.env.ANTHROPIC_API_KEY_BUSINESS;
  const apiKey = businessKey ? process.env.ANTHROPIC_API_KEY_BUSINESS : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '系統目前無法回答，請稍後再試或洽現場工作人員。';
  // 公關同仁用對話交代的回答偏好（批次 46）。放在這裡而不是各個呼叫端：這支是所有
  // 模型呼叫的唯一入口，四條問答路線一次到位，新增路線也不會忘記帶上。
  // ⚠️ 讀的是 60 秒快取（見 lib/bot-memory.js），不會每則提問都打一次 Sheets。
  const styleRules = formatStyleRules(await getMemories());
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      // 死線優先：前面（路由、補查）用掉多少，這裡就少多少，見 msLeft() 的說明。
      // 下限 2 秒——時間真的用完時與其不呼叫、什麼都不回，不如快速失敗走 catch，
      // 記者拿到的是一句「請稍後再試」而不是沉默。
      signal: AbortSignal.timeout(Math.max(2_000, budgetFor(timeoutMs, REPLY_RESERVE_MS))),
      body: JSON.stringify({
        model: ANSWER_MODEL,
        thinking: { type: 'between_tools' }, // 見 ANSWER_MODEL 的 ⚠️（5.5 不收 disabled）
        max_tokens: 4096,
        system: [
          { type: 'text', text: [systemPrompt, ZH_TW_RULE, LAYOUT_RULE, styleRules].filter(Boolean).join('\n'), cache_control: { type: 'ephemeral' } },
          ...(extraSystem ? [{ type: 'text', text: extraSystem }] : [])
        ],
        messages: [...history, { role: 'user', content: String(userText).slice(0, 8000) }]
      })
    });
    const data = await response.json();
    logAiUsage(business ? 'LINE 問答（企業場）' : 'LINE 問答', ANSWER_MODEL, data.usage); // 批次 117
    if (!response.ok) {
      console.error('Anthropic API 錯誤:', data.error?.message);
      // 批次 85：金鑰失效／額度用完這種不會自己好的錯誤，LINE 通知管理員（見 lib/ai-alert.js）
      // 企業場那一把出事，通知寫明只影響企業場、節流也分開算（批次 119）
      await reportAiFailure({ status: response.status, message: data.error?.message, where: business ? 'LINE 問答（企業場）' : 'LINE 問答', keyName: businessKey ? BUSINESS_KEY_NAME : undefined });
      return '抱歉，目前無法取得回應，請稍後再試或洽現場工作人員。';
    }
    // LINE 不渲染 Markdown，統一在這個出口清一次——見 stripMarkdownForLine() 的說明。
    // ⚠️ 不能寫死 content[0]：回應是一個 content block 陣列，第一塊不保證是文字
    // （thinking 一旦開啟，第一塊就是 thinking block，.text 會是 undefined，整支
    // 靜靜退化成「抱歉，無法取得回應」）。挑出所有 text 區塊接起來才穩，以後要開
    // thinking 也不必回來改這裡。
    const text = (data.content || [])
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n').trim();
    // ⚠️ 三道出口清理的順序：先清 Markdown、再整版面、最後轉繁體。順序不是隨便排的
    // ——tidyLineLayout() 認的是「・」開頭的條列行，而把 `- 項目` 換成「・」的正是
    // stripMarkdownForLine()，跑在它前面才看得到那些行（批次 59）。固定一個順序也才
    // 不會有人日後在中間插一段、結果只有一部分的文字被處理到。
    return toTraditionalTW(tidyLineLayout(stripMarkdownForLine(text))) || '抱歉，無法取得回應。';
  } catch (e) {
    console.error('Anthropic 呼叫失敗:', e.message);
    return '抱歉，目前無法取得回應，請稍後再試。';
  }
}
// ⚠️ 批次 104 起，這組已經**不再顯示給記者**（沒有自訂 chips 的活動改由 lib/default-chips.js 依知識庫
// 計算）。留著只有一個用途：LINE 的快速回覆按鈕會永遠留在對話紀錄裡，上線前送出去的舊按鈕
// （「這項技術預計何時商業化？」）記者隔天照樣會點——ownChipEventId() 的 ③ 靠這份認得它們，
// 按了不能沒反應。
// （以下是原本的說明）網頁版 public/event.html 沒有自訂 chips 時的預設建議問題（見該檔的 defaultChips）。
// ⚠️ 兩邊各自維護一份同樣的文字，不是共用模組：event.html 是純瀏覽器 <script>，
// 沒有打包流程可以匯入 lib/ 底下的 ESM 模組。這份只是「建議問題的預設文案」，跟
// LINE-PLAN.md 說的「不要做兩邊同步」講的是知識庫／答案內容那種一改就走鐘、記者
// 會拿到錯誤資訊的東西，性質不一樣——這裡頂多措辭跟網頁版不完全同步，不是功能壞掉。
export const DEFAULT_CHIPS = [
  '這次活動的主要發表內容是什麼？',
  '有哪些合作廠商參與？',
  '這項技術的應用場域為何？',
  '請問主要的技術突破點是什麼？',
  '這項技術預計何時商業化？'
];

// 回報的意見：網頁版問答介面一直都有同仁自訂的快速提問 chips（活動的「本場次提供
// 資料」欄位，見 events!G／public/event.html 的 chipList），記者不用自己想問題、
// 點一下就能問。LINE 這邊之前完全沒有——綁定後只能靠打字，公關同仁在後台特地設定
// 的關鍵字（新聞稿、新聞照片…）記者根本看不到，等於功能做了一半沒用到。
//
// 直接把同一組 chips 轉成 LINE 的 quick reply 按鈕，跟網頁版用同一個資料來源
// （event.chips），不需要另外維護一份「LINE 專用關鍵字」——同仁在後台改一次，
// 網頁跟 LINE 同步生效。沒設定自訂 chips 的活動退回 DEFAULT_CHIPS，跟網頁版行為
// 一致，不會讓記者看到空的按鈕列。
// 送出這句就是要看邀訪聯絡窗口的清單，見下面 handleMetaIntent() 的 'contacts' 分支跟
// lib/menu.js 的 detectMetaIntent()。固定加在每則答案的按鈕最後一格，記者不用先知道
// 要打這句話才找得到這個功能——跟內容 chips 放在一起才會被看到。
export const CONTACT_MENU_LABEL = '媒體邀訪需求';

// 導覽按鈕（批次 40 起）。群組與 1 對 1 都會用到——批次 48 之前只有群組用，見
// eventQuickChips() 裡的 🔄。
//
// 回報的問題：群組裡切到某一場活動之後「比較難切回來」——原因不是功能不見了
// （「回首頁」「最近有哪些活動」一直都認得，打字就會動），而是**群組看不到圖文
// 選單**。圖文選單是 LINE 的 1 對 1 專屬功能，群組聊天室不會顯示，所以 1 對 1 的
// 記者隨時有 🏠 可以按，群組裡的記者答完一題之後看到的按鈕列只剩「這場活動的
// 快速提問」，整排都是往裡面走的路，一條往外的路都沒有。
//
// 這件事在批次 18／28 其實已經認過一次（「群組裡沒有持續顯示的圖文選單，這則歡迎
// 訊息附的按鈕就是群組唯一一次看得到『還能問什麼』的機會」），但當時只補在**入群
// 自我介紹**跟**只 @ 沒接問題**這兩則上——那是記者「還沒開始問」的時候。真正會卡住
// 的時機是「已經問了幾題、想換個方向」，而那個時機的按鈕列正好是唯一沒補到的一排。
//
// 解法就是把圖文選單搬到群組的快速回覆列上：連 icon 都沿用 REPORTER_MENU 的同一組
// （📅🏠🔬📊📞），群組裡的記者看到的東西跟 1 對 1 的人一致，不用重新學。
//
// ⚠️ label 跟 text 刻意分開：顯示用短標＋icon（按鈕列寬度有限，「媒體邀訪需求」
// 五個字擠掉的是隔壁按鈕的能見度），送出的 text 維持原本那幾個字，這樣
// detectMetaIntent()／GROUP_FIXED_BUTTONS／isOwnButtonText() 三邊完全不用改——
// 改 text 才是會出事的那一種改動（按鈕送出的字沒人認得＝按了沒反應，批次 30 踩過）。
//
// ⚠️ 往外的兩顆（回首頁、其他活動）放在**最前面**，不是照舊接在最後：批次 29 已經
// 學過一次「按鈕列最後一格的『媒體邀訪需求』不夠明顯，滑一排按鈕容易漏看」，那次
// 的補救是把入口寫進文字裡。這排在群組裡是唯一的出口，藏在 8 顆自訂提問後面等於
// 沒有——手機一次只看得到兩三顆。
//
// ── 批次 84：按鈕只有一份來源 ─────────────────────────────────────────────
// 測試同仁回報：「可否下列小按鈕可以長駐？有時點進去最近活動，下面小按鈕就會變只有
// 幾個或是不見」。LINE 的快速回覆本來就不能常駐（只掛在最新一則訊息上，按下去或聊天室
// 有任何新訊息就收掉——官方文件寫明的行為），能做的是**每一則回覆都帶著同一套按鈕**。
// 盤點（tools/line-button-audit）抓到的是另一回事：同一個功能在不同回覆裡寫成不同的字
// （「最近有哪些活動」「📅 其他活動」）、有的四顆有的六顆、「找真人」只有兜底那則有——
// 每一處各寫一份清單，遲早漂開。所以全部收成下面這一份，各處只挑要哪幾顆。
//
// ⚠️ text（按下去送出的字）一個都沒改，只改顯示的 label：detectMetaIntent()／
// GROUP_FIXED_BUTTONS／isOwnButtonText() 認的都是 text，改 text 就是「按了沒反應」
// （批次 30／32 踩過）。
export const BTN = {
  home: { label: '🏠 回首頁', text: '回首頁' },            // 解除綁定＋列出全部活動與其他功能
  others: { label: '📅 其他活動', text: '最近有哪些活動' }, // 已在某一場：只列清單、不解除綁定
  events: { label: '📅 最近活動', text: '最近有哪些活動' }, // 還沒選場次時的同一顆
  trend: { label: '📊 產業趨勢', text: '產業趨勢分析' },
  tech: { label: '🔬 問技術與洽案', text: '問技術與洽案' }, // 批次 121：原「想問什麼技術」，改接官網「產業服務」的技術清單
  news: { label: '📰 近期新聞', text: '近期工研院新聞' },    // 批次 121：原「新聞稿全文」那一格，改成官網新聞中心的標題＋導言＋短網址
  contact: { label: '📞 邀訪窗口', text: CONTACT_MENU_LABEL },
  human: { label: '🙋 找真人', text: '找真人' },           // 批次 81：記者任何時候都找得到真人
  help: { label: '❓ 使用說明', text: '使用說明' }
};
export const NAV_HEAD = [BTN.home, BTN.others];
export const NAV_TAIL = [BTN.trend, BTN.tech, BTN.contact, BTN.human];
// 呼叫端沒給按鈕時的預設（群組與 1 對 1 記者都用這一排，見 replyOrPush()）。
const NAV_ALL = [...NAV_HEAD, ...NAV_TAIL];
// 還沒進任何一場時的起點：歡迎詞、只叫米亞、兜底、使用說明、收尾語。
export const HOME_MENU = [BTN.events, BTN.trend, BTN.tech, BTN.news, BTN.contact, BTN.human, BTN.help];

// LINE 的 id 前綴：使用者 U、群組 C、聊天室 R（官方文件的慣例，很穩定）。判斷錯的
// 代價也只是「群組少一排導覽」或「1 對 1 多一排」，不會壞掉。
export const isGroupTarget = id => /^[CR]/.test(String(id || ''));

// replyOrPushMessages() 收的是原始訊息物件，不像 replyOrPush() 會幫忙把字串陣列
// 轉成 quickReply。使用說明那則要自己組一份——格式跟 lib/line.js 的 buildQuickReply()
// 一樣（LINE 的 quick reply 物件），只是這裡只需要固定這幾顆。
export function toQuickReply(items) {
  return {
    items: items.map(i => {
      const label = typeof i === 'object' ? i.label : i;
      const text = typeof i === 'object' ? (i.text ?? i.label) : i;
      return { type: 'action', action: { type: 'message', label: toTraditionalTW(label).slice(0, 20), text } };
    })
  };
}
export function buildHelpQuickReply() {
  return toQuickReply(HOME_MENU.filter(b => b !== BTN.help));
}

// ⚠️ 這一層是「群組導覽不會漏掉」的結構性保證（批次 43），不是方便而已。
//
// 回報：在群組按「媒體邀訪需求」→「邀訪：綠能」，拿到窗口聯絡人之後**整則訊息一顆
// 按鈕都沒有**，問完就斷在那裡。使用者問的是「建議改成常駐嗎」——LINE 的快速回覆
// 本來就是綁在單一則訊息上的，沒有「常駐」這種選項；真正常駐的是圖文選單，而群組
// 不顯示圖文選單（批次 40）。所以群組裡「常駐」唯一的實作方式，就是**每一則回覆都
// 自己帶著那排導覽**。
//
// 為什麼包一層、而不是去每個呼叫點補第四個參數：api/line.js 有五十幾處 replyOrPush，
// 群組走得到的至少十幾處。手動補一輪就是又一次「漏掉的那一顆」——這條路上已經連續
// 四次（批次 30、32、40、41）敗在同一種錯。包起來之後，新增的回覆自動有導覽，不用
// 記得，也不會忘記。
//
// 只在「呼叫端沒有自己給按鈕」時才補：給了就代表那則訊息有更貼切的選項（活動清單、
// 邀訪主題、這場的快速提問…），不要覆蓋掉。
//
// 🔄 批次 84：1 對 1 的記者也補。原本只補群組，理由是 1 對 1 有圖文選單——但圖文選單
// 是收合的（批次 48 學過），而且 LINE 電腦版根本不顯示圖文選單（官方文件）。盤點抓到
// 1 對 1 換場確認、「想問什麼技術」的提問這幾則一顆按鈕都沒有，記者看到的就是「按鈕
// 不見了」。職員不補（見 markStaff()）：職員有自己那組 STAFF_QUICK_REPLIES，塞一排記者
// 按鈕只會讓人以為被踢出職員模式。
export async function replyOrPush(replyToken, targetId, text, quickReplyItems) {
  const store = requestCtx.getStore();
  const items = (quickReplyItems && quickReplyItems.length) ? quickReplyItems
    : (isGroupTarget(targetId) || !store?.staff) ? NAV_ALL : quickReplyItems;
  return replyOrPushRaw(replyToken, targetId, text, items, { quoteToken: takeQuoteToken(targetId) });
}

// 這一次請求是在服務職員（1 對 1 職員模式）——replyOrPush() 就不幫他補記者的按鈕列。
export function markStaff() {
  const store = requestCtx.getStore();
  if (store) store.staff = true;
}

// ── 群組回答引用原問題（批次 83）──────────────────────────────────────────
// 群組裡常常好幾個人輪流問，答案又要等十幾秒才出來（群組沒有「輸入中」動畫，見批次
// 60）——中間別人已經又講了幾句，米亞的答案出現時，沒人看得出這段在回誰的哪一題，
// 體感就是「答非所問」。LINE 的 quoteToken 可以讓回覆「引用」原本那則訊息（跟使用者
// 自己長按訊息→回覆一樣的樣子），一眼看得出來。
//
// 跟批次 43 群組導覽同一招：包在 replyOrPush() 這一層，不去五十幾個呼叫點各補一個
// 參數——token 放在這一次請求的 context 裡（見 handler 的 requestCtx），第一則回覆
// 拿去用、用完就清掉，同一次處理後面再送的訊息不重複引用。1 對 1 不引用：只有兩個人，
// 看得出在回誰，引用只會多佔畫面。引用不了（token 過期等）時 lib/line.js 會拿掉引用
// 再送一次，不會因此漏掉答案。
export function takeQuoteToken(targetId) {
  const store = requestCtx.getStore();
  if (!store?.quoteToken || !isGroupTarget(targetId)) return undefined;
  const q = store.quoteToken;
  store.quoteToken = null;
  return q;
}

// LINE quick reply 上限 13 顆，扣掉固定的「媒體邀訪需求」那一格，內容 chips 最多留
// 12 格——同仁在後台放了 13 題以上的自訂問題不是常態，但真的放了也不能讓陣列超過
// LINE 的硬限制，寧可截斷內容 chips 也不能把邀訪窗口的入口擠掉。
//
// 內部先過一次 resolveEventContent()：活動前（見 lib/prompt.js 的說明）自訂 chips
// 若還是原本那組「問活動內容」的問句，記者點下去常常只會得到「這部分我沒有資料」——
// 不是壞掉，但沒有用。呼叫端不用先自己判斷是不是活動前、也不用先手動 resolve 一次，
// 這裡永遠拿到「當下該用哪組 chips」的正確答案；resolveEventContent() 對已經 resolve
// 過的 event 再呼叫一次是安全的（同一批欄位只會算出同樣的結果，不會疊加）。
// 只有「這場的內容提問」那幾顆，不含導覽（回首頁、媒體邀訪需求…）。
//
// ⚠️ 拆出來是因為兩邊要的東西不一樣，混在一起會出事（實測抓到）：按鈕列要「內容 ＋
// 導覽」全部一起送，但 ownChipEventId() 只能拿**內容**去回推場次——導覽那幾顆是跨場次
// 的功能入口，每一場的按鈕列都有，拿它們回推等於「按任何一顆導覽鈕都會把綁定接回上一
// 場」。實際症狀：在群組按「回首頁」（本來就是要解除綁定）之後再按「媒體邀訪需求」，
// 會被接回剛剛那場、拿到那場的窗口，而不是跨活動的全域窗口清單。
export function eventContentChips(rawEvent) {
  // 批次 104：沒有自訂 chips 時不再退回寫死的五題，改依知識庫實際有寫的小節算（lib/default-chips.js，
  // 網頁版 get_public 用同一支，兩邊一致）。活動前（邀請函模式）那一組也在裡面處理。
  return effectiveChips(rawEvent || {});
}

export function eventQuickChips(rawEvent, { reserve = 0 } = {}) { // 呼叫端傳的 group 已經不影響結果（批次 84）
  // ⚠️ LINE quick reply 硬上限 13 顆，超過的會被 buildQuickReply() 從尾巴截掉。
  //
  // 🔄 批次 48 修正了批次 40 的一個判斷錯誤。批次 40 只在群組加導覽，理由寫成
  // 「1 對 1 有圖文選單撐著，重複放進按鈕列只會排擠掉同仁自訂的提問」——聽起來合理，
  // 實際回報打臉：使用者在 **1 對 1** 切進某一場之後，「就不知如何回到首頁」。
  //
  // 為什麼那個理由不成立：圖文選單雖然常駐，但它是**收合**的（要先點輸入框上方那條
  // 「功能選單」才展開），而記者的視線在剛收到的那則答案上——按鈕列就貼在答案下面，
  // 圖文選單不在。「存在」跟「當下看得到」是兩件事，這一整條路上已經是第二次栽在
  // 同一個分辨上（批次 40 是群組沒有選單，這次是有選單但沒展開）。
  //
  // 所以兩邊都放往外的路，只是密度不同：
  //   群組   ：2 顆往外 ＋ 8 顆內容 ＋ 3 顆其他功能 ＝ 13
  //   1 對 1 ：2 顆往外 ＋ 10 顆內容 ＋ 邀訪窗口     ＝ 13
  // 1 對 1 少放「產業趨勢／問技術」那兩顆，是因為那兩條路不是用來「脫困」的，而且
  // 圖文選單展開後就有——真正被回報找不到的是「回首頁」。
  //
  // 🔄 批次 84：1 對 1 與群組改成同一排（2 顆往外 ＋ 最多 7 顆內容 ＋ 4 顆功能 ＝ 13）。
  // 測試同仁回報「按鈕有時只有幾個」，盤點看到的是兩個場景、兩種排法、兩種字——同一個
  // 記者在群組跟 1 對 1 之間切換，要重新認一次按鈕。一致比多擠三顆自訂提問重要：
  // 同仁設的自訂提問預設 5 題，7 顆放得下；「找真人」在每一則答案底下都要看得到（批次 81）。
  // reserve：呼叫端要在最前面多放幾顆自己的（例如補問媒體名稱的「略過」），從內容那段讓位，
  // 導覽的 6 顆永遠不被擠掉。
  const contentChips = eventContentChips(rawEvent).slice(0, Math.max(0, 7 - reserve));
  return [...NAV_HEAD, ...contentChips, ...NAV_TAIL];
}

// 「問技術與洽案」那則的按鈕（批次 84 起有範例按鈕；批次 121 改成六大技術領域＋範例關鍵字）。
// 送出的都是固定句型（見 lib/itri-tech.js TECH_PICK_RE）：群組裡任何人按都算數，不會因為「等待中的旗標」
// 綁在按第一下的人身上，別人按了就沒反應（批次 28 的坑）。
export const TECH_DOMAIN_BUTTONS = TECH_DOMAINS.map(d => ({ label: `${d.icon} ${d.name}`, text: techPickText({ domain: d }) }));
export const TECH_EXAMPLE_BUTTONS = [
  { label: '電池', text: '技術關鍵字：電池' },
  { label: '機器人', text: '技術關鍵字：機器人' },
  { label: 'AI 晶片', text: '技術關鍵字：AI晶片' }
];
// 「近期工研院新聞」那則的範例關鍵字（同上，固定句型見 lib/itri-news.js NEWS_PICK_RE）
export const NEWS_EXAMPLE_BUTTONS = [
  { label: '半導體', text: '新聞關鍵字：半導體' },
  { label: '機器人', text: '新聞關鍵字：機器人' },
  { label: 'AI', text: '新聞關鍵字：AI' }
];

// 補問媒體名稱時的按鈕：最前面一顆「略過」，後面照樣是這場的整排按鈕（批次 84）。
export function mediaNameChips(event) {
  return [{ label: '略過', text: '略過' }, ...eventQuickChips(event, { reserve: 1 })];
}

// 答完第一題之後補問媒體名稱（push）。
// ⚠️ 批次 84 的主因之一：測試同仁回報「點進去最近活動，下面小按鈕就不見了」。1 對 1
// 第一次點活動 → 答案（帶一整排按鈕）→ 緊接著這則補問。LINE 只顯示**最新一則**訊息的
// 按鈕，而這則以前一顆都沒帶——答案底下那排剛出現就被收掉。所以這則要帶著同一排。
export async function askMediaNameLater(userId, event) {
  await setBindingNote(userId, 'ask_name');
  await pushMessage(userId, '對了，方便留個貴媒體的名稱嗎？（打名稱即可，或點「略過」——之後就不會再問了）',
    mediaNameChips(event));
}

// 回報的意見：記者被引導「請直接輸入想問的活動名稱，或從下面挑一場」（換場、或
// 查活動列表時）只看得到活動名稱按鈕，找不到入口問「媒體邀訪需求」——這件事本來
// 就不是針對某一場活動，是跨活動的議題／窗口詢問（見 sendGlobalContactMenu()），
// 塞在「先選一場」的清單裡反而是選錯位置，記者只能自己打字才問得到。
//
// 跟 eventQuickChips() 同一招：固定加在清單最後一格，記者不用先知道要打這句話。
// 只給記者端的活動清單用（handleMetaIntent／handleUnbound）——handleStaffMessage()
// 自己的 'calendar' 分支刻意不套用，同仁已經有整套 STAFF_QUICK_REPLIES，「媒體
// 邀訪需求」是講給記者聽的措辭，職員這裡看到只會多一顆用不到的按鈕。
//
// 回報的截圖（批次 29）：正式站問「最近有哪些活動」，按鈕列只有孤零零兩顆
// 「工研院創新日」「媒體邀訪需求」，看起來很空。原因不是壞掉——這排刻意只列
// **有資料的活動**（calendarQuickReplyItems() 會濾掉沒有 kb 的場次，點了也問不出
// 東西），而正式站當下只有一場符合。但真正的問題是：這個帳號有四條路，這排卻只
// 放了「活動」跟「邀訪窗口」兩條，另外兩條（產業趨勢、工研院技術）從來沒出現在
// 這裡，記者要嘛自己打字、要嘛得先去點圖文選單才知道有這些功能。
//
// 活動少的時候按鈕列空蕩蕩，活動多的時候另外兩條路又被埋掉——兩種情況都該把四條路
// 一起放上來，跟群組自我介紹、兜底文案、join 歡迎詞同一份口徑（那三處早就是四條路
// 一次列完）。
//
// ⚠️ LINE quick reply 硬上限 13 顆。活動最多 8 顆（calendarQuickReplyItems 的預設
// limit）＋ 下面 4 顆固定 ＝ 12，永遠塞得下；就算哪天把活動上限調大，也要先確認
// 加起來不超過 13，不然會被 buildQuickReply() 從尾巴截掉——被截掉的正好是這四顆
// 固定入口，等於白加。
// 🔄 批次 84：固定那幾顆改用 BTN（跟其他回覆同一套字與圖示），並補上「🙋 找真人」。
// 活動 8 顆 ＋ 功能 5 顆 ＝ 13，剛好是上限。
export function calendarQuickRepliesForReporter(cards) {
  return [
    ...calendarQuickReplyItems(cards),
    BTN.trend, BTN.tech, BTN.contact, BTN.human, BTN.help
  ];
}

// 回報的意見：按鈕列最後一格的「媒體邀訪需求」不夠明顯，滑一排按鈕容易漏看——
// 直接把入口寫進文字裡，不能只靠按鈕。跟 calendarQuickRepliesForReporter() 同一組、
// 同樣只給記者端的活動清單用，固定接在 formatCalendarReply() 的結果後面。
//
// ⚠️ 措辭刻意不寫「跨活動」——這裡送出的字串跟 eventQuickChips() 的按鈕、記者
// 自己打字問，最後都走同一支 handleMetaIntent() 的 'contacts' 分支：目前綁定的
// 這場如果自己有設定聯絡窗口（events!P 或 press_contact），會先給那組最精準的
// 資訊，只有這場完全沒設定時才退到全域清單（批次 8/9 就是這樣設計，這裡沒有改
// 這個優先順序）。曾經寫成「如果是跨活動的採訪需求」，結果記者綁定的那場剛好
// 設定過聯絡人，點下去還是拿到那場的窗口，跟文字說的對不上——這裡只承諾「有
// 這個入口」，不承諾「一定給你全域清單」。
export const CONTACT_MENU_TEXT_HINT = '\n\n（有採訪窗口相關的需求，直接打「媒體邀訪需求」或點下面的按鈕即可。）';
// ── 安裝圖文選單（職員指令）─────────────────────────────────────────
// 做成職員模式的一句話指令、而不是新開一支 API：Vercel Hobby 的 12 支 Function
// 上限目前已經用掉 11 支，這個功能一輩子大概只會執行個位數次，不值得占掉最後一格
// （見 api/event-page.js 開頭那段三合一的同一個理由）。
//
// 底圖是去自己網站抓 /richmenu.png，不用 includeFiles 把檔案打包進 Function——
// 這是一次性動作，多一次 HTTP 往返完全無所謂，換來的是不必動 vercel.json，
// 也不會讓每次 webhook 的冷啟動多背一個 73KB 的檔案。
export const SITE = 'https://itri-event-ai.vercel.app';

// 職員的快速回覆按鈕。LINE 上限 13 顆，這裡用 9 顆——圖文選單那六格全部列出來
// （選單被收起來時仍然點得到），再加「設定圖文選單」這顆選單本身放不進去的。
// 原本只給兩顆（活動列表／GEO 狀態），其餘功能同仁得自己知道要打什麼才用得到，
// 等於功能做了卻沒人找得到。
//
// 「最近有哪些新聞」「記憶清單」是回報「職員模式不好用」之後補的：前者是官網最新
// 新聞稿（同仁問得最多的東西之一，原本職員模式完全叫不到），後者是「用對話教米亞」
// 那套（批次 46 做好了，但除了 LINE-PLAN.md 之外沒有任何入口寫著怎麼叫它）。
// 這兩個補的都不是新功能，是**入口**——見 LINE-PLAN.md 批次 51 的教訓。
//
// 「使用說明」也在這裡：sendFallbackGuide() 的職員版尾巴一直叫同仁「打『使用說明』
// 可以看內部功能」，卻沒有任何一顆按鈕點得到——功能有、入口沒有，又是同一個形狀。
// 批次 77：選單重排後「要媒體訓練連結」「退出職員模式」不在六格裡了，補回按鈕列——
// 換掉的入口不會真的消失，只是不再佔選單的一格（批次 21 的原則）。
export const STAFF_QUICK_REPLIES = [...new Set([
  ...STAFF_MENU.buttons.map(b => b.text), '要媒體訓練連結', '設定圖文選單',
  '最近有哪些新聞', '記憶清單', '使用說明', '退出職員模式'
])];

// 職員的按鈕列：把當下最相關的幾顆排到最前面，後面一律接上整套入口。
//
// 回報：職員模式裡按「記憶清單」，回覆底下只剩孤零零一顆「最近有哪些活動」。
// 兩個問題疊在一起——
//   ① 那顆跟「記憶」完全無關，是記者端的按鈕；
//   ② 更要命的是**按了一顆按鈕，其他八個入口就消失了**。
// 同仁是從九顆按鈕裡點進來的，回來只剩一顆，看起來像被降級了。
//
// 這跟批次 52（職員模式取代記者模式、能力整批不見）是同一個形狀，只是這次縮水的
// 是入口不是能力。所以規則定死：**職員模式的每一則回覆都帶著整套入口**，情境按鈕
// 只是排在前面，不是拿來取代它。去重後砍到 LINE 的 13 顆上限。
export function staffChips(...front) {
  return [...new Set([...front.filter(Boolean), ...STAFF_QUICK_REPLIES])].slice(0, 13);
}
// Flex 訊息要自己帶快速回覆（replyOrPushMessages 收的是原始物件，不會幫忙轉）。
// 格式跟 lib/line.js buildQuickReply() 一樣：最多 13 顆、label 最長 20 字。
export function quickReplyOf(items) {
  const list = (items || []).filter(Boolean).slice(0, 13);
  if (!list.length) return undefined;
  return {
    items: list.map(item => {
      const label = String(typeof item === 'object' ? item.label : item);
      const text = String(typeof item === 'object' ? (item.text ?? item.label) : item);
      return { type: 'action', action: { type: 'message', label: label.length > 20 ? label.slice(0, 19) + '…' : label, text: text.slice(0, 300) } };
    })
  };
}
// 卡片上的字有一部分是同仁在後台打的（活動名稱、地點）。新的出口一律接上繁體防線
// （CLAUDE.md 第 1 條）——只轉顯示用的 text／altText／label，不動網址與送出的指令字串。
export function twFlex(node) {
  if (Array.isArray(node)) return node.map(twFlex);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = (k === 'text' && node.type !== 'message') || k === 'altText' || k === 'label'
      ? (typeof v === 'string' ? toTraditionalTW(v) : v)
      : twFlex(v);
  }
  return out;
}
