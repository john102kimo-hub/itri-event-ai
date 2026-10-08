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

// 美元／每百萬 tokens（官方價目，2026-09 核對）。快取寫入以 5 分鐘那種計（1.25 倍）、讀取 0.1 倍。
const PRICE = {
  // Haiku 5.5 分兩段價：prompt 100K tokens 以內 $0.10／$0.50，超過 $0.50／$2.50。這裡只放前者——
  // 本專案的 Haiku 呼叫（網頁問答、兩支路由）prompt 都遠小於 100K，超過時估價會偏低。
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-5-5': { in: 4, out: 20 },
};

export function estimateUsd(model, usage) {
  const p = PRICE[model];
  if (!p || !usage) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) * 0.1 + (usage.cache_creation_input_tokens || 0) * 1.25;
  return (input * p.in + (usage.output_tokens || 0) * p.out) / 1e6;
}

export function logAiUsage(where, model, usage) {
  if (!usage) return;
  const usd = estimateUsd(model, usage);
  console.log(`[ai-usage] ${where} model=${model} in=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0} out=${usage.output_tokens || 0}${usd === null ? '' : ` usd≈${usd.toFixed(5)}`}`);
}
