// AI 用量紀錄（批次 117）。
//
// 每一次呼叫模型，在 Vercel Logs 留一行：哪一條路、哪個模型、輸入／快取讀取／快取寫入／輸出各幾個
// token，以及照官方價目估的美元。
//
// 為什麼要有：程式裡好幾處寫著「這段吃 prompt cache，幾乎不花錢」，但從來沒有人看過到底有沒有吃到。
// 官方文件寫明 Haiku 4.5 的快取至少要 4,096 tokens（批次 120 換成 Haiku 5.5 後降到 512，短 prompt 反而吃得到）——
// 網頁問答、LINE 判斷問題類型用的都是 Haiku，新聞稿短的場次、活動清單短的時候，快取可能不會生效（不會出錯，只是沒省到）。這一行就是用來確認的：
// 在 Vercel Logs 搜「[ai-usage]」，cache_read 一直是 0 的那一條路就是沒吃到快取。
// 月底的總帳仍以 Anthropic Console 的 Usage 頁為準；這裡只是看得到「哪一條路」花的。
//
// 純粹記 log：不寫試算表（每一題多一次 Sheets 寫入會吃掉全站共用的配額），也不影響回答。
//
// ── 批次 135：網路搜尋另外計費，以前這裡完全沒算 ──────────────────────────────────────
// 起因：批次 126 把 AI 能見度掃描從 Opus 5 換成 Haiku 5.5（token 單價差 50 倍），以為大幅省錢；
// 但掃描用的伺服器端工具 web_search 是**另外按次數收費**的，跟 token 單價無關，換模型省不到這一塊。
// 以前 estimateUsd() 只算 token，搜尋費根本不在帳裡，真正占大頭的可能是搜尋、卻完全看不到。
//
// 官方文件查證（2026-10-12，WebFetch 讀原文，不是憑記憶）：
//   · 計價：每 1,000 次搜尋 10 美元（= 每次 0.01 美元），「plus standard token costs」——搜尋費與 token 費是兩筆、
//     相加；搜尋結果進到上下文的那些 token 照一般輸入計價（已經在 usage.input_tokens 裡，不會重複算）。
//   · 次數欄位：回應的 usage.server_tool_use.web_search_requests（整數）。沒用搜尋工具的呼叫（網頁問答、LINE、判官）
//     不保證有 server_tool_use 這個欄位，所以讀取一律要容許它不存在、是 null、或不是數字（見 searchCount）。
//   · 搜尋出錯（回的是 web_search_tool_result_error，例如 max_uses_exceeded）不計費：
//     "If an error occurs during web search, the web search will not be billed."
//   · web_fetch 沒有額外費用（只算抓回來的 token），次數在 server_tool_use.web_fetch_requests；本專案沒用到 web_fetch，
//     所以這裡不算、也不記。
//   · 動態過濾版（web_search_20260209 以後）用到的 code execution，搭配 web_search 時不另收費。
//   · max_uses 的說明是「per request」。pause_turn 續跑是**新的一次請求**（api/geo.js probeClaude 最多續跑 3 回合），
//     所以一次探測的搜尋次數上限理論上是 3 × 5 = 15 次（0.15 美元），不是 5 次。
//   來源：
//     https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool （Usage and pricing 一節）
//     https://platform.claude.com/docs/en/about-claude/pricing （Web search tool 一節；Web fetch tool 一節）
//     https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool （Usage and pricing 一節）
//     https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools （pause_turn 一節）
//
// 【待核對】官方文件沒有明講下面兩件事，這裡是照「每一次請求各自計費」的合理推論處理，要看過真實的 Vercel Logs 才能確定：
//   ① pause_turn 續跑時，每一回合回應的 web_search_requests 是不是「只含該回合」的次數（而不是累計）。
//      我們照「只含該回合」處理，每一回合各記一行；若真實 log 顯示第二、三行的 searches 比前一行大且像累計值，
//      代表加總會重複算，要改成記差額。
//   ② 出錯的搜尋有沒有被算進 web_search_requests。文件只說出錯不計費，沒說出錯那次會不會出現在次數裡；
//      若會，這裡的估價會略偏高（偏保守，不會漏報）。
// 另一個看不到的洞：呼叫逾時被我們這端中斷（geo.js 預設 15 秒）時，伺服器端可能已經搜尋並計費，
// 但拿不到 usage，這一次不會出現在 log 裡。月底的總帳仍以 Anthropic Console 的 Usage 頁為準。

// 美元／每百萬 tokens。每個模型各自一組單價，欄位跟官方定價頁（platform.claude.com/docs/en/about-claude/pricing）
// 的表格一一對應，方便逐格核對：in＝Base input、out＝Output、cacheRead＝Cache hits and refreshes、
// write5m＝5m cache writes、write1h＝1h cache writes。
//
// ⚠️ 批次 135 審查：以前讀取一律 ×0.1、寫入一律 ×1.25（共用倍率）。官方定價頁的註腳 2 寫明
// 「Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price」，
// 其餘模型才是標準的 0.1x。Sonnet 5.5 是主力（LINE 問答、媒體訓練，知識庫幾乎全走快取讀取），用 0.1x 估會讓 log 的 usd≈ 虛高約 4 成到 6 成。
// 核對日期 2026-10-13（WebFetch 讀定價頁與 prompt-caching 頁，兩頁一致）：Sonnet 5.5 讀取 $0.10、Opus 5.5 讀取 $0.20。
// 【待核對】claude-api 技能附的 shared/model-migration.md、models.md 寫 Sonnet 5.5「cache reads $0.20」，跟即時定價頁不一樣
// （文件快照可能比定價頁舊）。這裡以定價頁為準；要確定就對一次 Anthropic Console 的實際帳單。
const PRICE = {
  // Haiku 5.5 分兩段價：prompt 100K tokens 以內 $0.10／$0.50，超過 $0.50／$2.50（讀 $0.05、寫 $0.625／$1）。這裡只放前者——
  // 本專案的 Haiku 呼叫（網頁問答、兩支路由）prompt 都遠小於 100K，超過時估價會偏低。
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 },   // 讀取 0.05x
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, write5m: 2.5, write1h: 4 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, write5m: 5, write1h: 8 },        // 讀取 0.05x
  // 批次 134：伺服器端備援（fallbacks:"default"，見 lib/ai-refusal.js）真的發生時，回應的 model 是實際回答的那個模型，
  // 不是我們送出去的 Sonnet 5.5。改哪個模型由 Anthropic 依「被拒的分類」決定，官方沒有公布各模型的對照
  // （refusals-and-fallback 頁：routing is not published per model），所以不猜，看回應的 model 欄位。
  // 這裡預先放兩個可能的：Claude Sonnet 5、Claude Opus 4.8；不在表裡的模型估價會變成 null（log 看不到 usd≈，但 model= 看得到）。
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10 },
};

// 美元／每 1,000 次網路搜尋（官方價目，2026-10-12 核對，來源見檔案開頭）。跟模型無關，每個模型都是這個價。
export const WEB_SEARCH_USD_PER_1000 = 10;

/**
 * 這一次回應做了幾次網路搜尋（usage.server_tool_use.web_search_requests）。
 * 拿不到一律回 0：usage 是 null／不是物件、沒有 server_tool_use、server_tool_use 是 null、
 * 欄位不是有限的正數（字串、NaN、負數、Infinity）都當沒有搜尋——這裡是「看得到」用的，
 * 寧可少報成 0，也不能因為一個怪值讓 logAiUsage 丟例外、把回答拖垮。
 */
export function searchCount(usage) {
  const n = usage?.server_tool_use?.web_search_requests;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 快取寫入費：usage.cache_creation 有分 5 分鐘（ephemeral_5m_input_tokens）與 1 小時（ephemeral_1h_input_tokens）時，
// 1 小時那一塊照 write1h 算，其餘照 write5m；沒有這個欄位（本專案目前只用預設的 5 分鐘快取）就全部照 write5m。
// 官方：cache_creation_input_tokens 等於 cache_creation 裡各項的總和。
function cacheWriteUsdPerM(p, usage) {
  const total = usage.cache_creation_input_tokens || 0;
  const h1raw = usage.cache_creation?.ephemeral_1h_input_tokens;
  const h1 = typeof h1raw === 'number' && Number.isFinite(h1raw) && h1raw > 0 ? Math.min(h1raw, total) : 0;
  return (total - h1) * p.write5m + h1 * p.write1h;
}

// 只算「回傳這則訊息的那一個回合」（頂層 usage 的範圍）；備援時被拒的回合見 declinedAttempts()。
export function estimateUsd(model, usage) {
  const p = PRICE[model];
  if (!p || !usage) return null;
  const tokensUsd = ((usage.input_tokens || 0) * p.in + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + cacheWriteUsdPerM(p, usage) + (usage.output_tokens || 0) * p.out) / 1e6;
  // 批次 135：搜尋費另外相加。沒有搜尋時直接回 token 費。
  // 不認得的模型照舊回 null（上面已經 return）：搜尋費雖然與模型無關，但總額少了 token 那一半就是假數字，
  // 此時 log 仍然會帶 searches=N，看得到次數。
  const searches = searchCount(usage);
  return searches ? tokensUsd + (searches * WEB_SEARCH_USD_PER_1000) / 1000 : tokensUsd;
}

/**
 * 伺服器端備援真的發生時，被拒的那幾個回合（批次 135 審查）。
 *
 * 官方（refusals-and-fallback 頁 Billing and rate limits）：每個跑過的回合分開計費，usage.iterations 是「每個回合」的紀錄，
 * 頂層 usage 只描述產生回傳訊息的那一個回合，不同模型的 token 不會加成同一個欄位。形狀（同頁的範例回應）：
 *   iterations: [{ type:'message', model:'<被拒的>', input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
 *                { type:'fallback_message', model:'<實際回答的>', … }]
 * 被拒的回合是 type:'message'，答的那個是 'fallback_message'（沒有 fallback_message 就不是備援，這裡一律當沒有）。
 * 以前 logAiUsage 只看頂層，被拒的回合完全不在帳裡——頻繁備援時 log 加總會系統性低於 Console。
 *
 * 回傳 { count, usd }：count＝被拒的回合數；usd＝它們的估價合計，其中任何一個模型不在 PRICE 表裡就是 null（不亂湊總額）。
 * 偏高的一側（不會漏報）：官方說輸出前就被拒的回合，只有 bio、frontier_llm、reasoning_extraction 三類才計費，
 * cyber、general_harms 或沒有分類的不計費；但備援成功的回應頂層 stop_details 是 null，看不到被拒的分類，
 * 所以輸出前被拒（output_tokens 為 0）的回合一律算進來。中途被拒（有輸出）的一定計費，沒有疑問。
 */
export function declinedAttempts(usage) {
  const its = usage?.iterations;
  if (!Array.isArray(its) || !its.some((e) => e?.type === 'fallback_message')) return { count: 0, usd: 0 };
  let count = 0, usd = 0;
  for (const e of its) {
    if (e?.type !== 'message') continue;
    count++;
    const u = estimateUsd(e.model, e);
    usd = usd === null || u === null ? null : usd + u;
  }
  return { count, usd };
}

export function logAiUsage(where, model, usage) {
  if (!usage) return;
  let usd = estimateUsd(model, usage);
  const searches = searchCount(usage);
  // 備援發生時把被拒的回合也算進來（見 declinedAttempts()）：usd≈ 是所有回合的合計，行尾 attempts=N 是總回合數（含答的那個）
  const declined = declinedAttempts(usage);
  if (declined.count) usd = usd === null || declined.usd === null ? null : usd + declined.usd;
  // 批次 135：searches=N 接在行尾、而且只在有搜尋時才出現。沒有搜尋的呼叫（網頁問答、LINE、判官）整行跟以前一字不差，
  // 有人拿「out=… usd≈」之類的樣式在 Vercel Logs 搜尋也不會失效；有搜尋的行，前面那一段也照舊。attempts=N 同理，只在備援時才有。
  console.log(`[ai-usage] ${where} model=${model} in=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0} out=${usage.output_tokens || 0}${usd === null ? '' : ` usd≈${usd.toFixed(5)}`}${searches ? ` searches=${searches}` : ''}${declined.count ? ` attempts=${declined.count + 1}` : ''}`);
}
