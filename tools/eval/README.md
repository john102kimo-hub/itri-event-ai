# 固定評測流程

**改 prompt、換模型之前與之後，各跑一次，比較結果。** 同一批題目、同一組程式評分（不靠人眼、不呼叫第二個模型當裁判），所以同一個答案永遠得到同一個分數。

## 為什麼是這幾題

CLAUDE.md 第 2 條說這個專案在同一個形狀上踩過四次：Markdown 符號、`[[NO_DATA]]` 標記、亂補資料、簡體字。題庫與評分器就是針對這四種：

| 類別 | 防什麼 |
|---|---|
| `facts` 事實題 | 該答的有答對（講者、時間、地點、數字） |
| `no-data` 資料裡沒有 | **最容易編造**：問新聞稿沒寫的事（量子電腦、售價、專利），要老實說沒有，不能編數字或網址 |
| `injection` | 要它洩漏系統提示、換角色、評論競爭對手、離題 |
| `english` | 記者用英文問，要用英文答（含警語） |
| `format` | 要求表格時，LINE 上不能出現 `\|---\|` |

## 兩層評分

| 層 | 看什麼 | 沒過的意義 |
|---|---|---|
| **硬性**（使用者實際看到的） | 模型輸出**經過正式站的出口處理後**：繁體、沒有 Markdown、沒有標記殘留、有警語、數字與網址與英文名詞查得到來源、該有的事實有、不該有的沒有、沒資料時老實說 | 記者會看到的錯，必須修 |
| **軟性**（模型原始輸出） | 模型自己有沒有守規矩（原始輸出有沒有簡體字、Markdown、多餘標記） | 出口兜得住，所以不算失敗；但比例變高，代表換模型時出口得接更多球，是早期警訊 |

## 怎麼用

```bash
# 不花錢：確認題庫與評分器沒壞（npm test 跑的就是這個）
node tools/eval/run.mjs --provider mock --mock tools/eval/mock-good.json

# ① 改之前，存基準（會呼叫真的模型，20 題約幾毛錢）
ANTHROPIC_API_KEY=… node tools/eval/run.mjs --save tools/eval/results/before.json

# ② 改完 prompt／換模型之後，跟基準比
ANTHROPIC_API_KEY=… node tools/eval/run.mjs --baseline tools/eval/results/before.json --fail-on regress
```

報告會列出：哪幾題**退步**（以前過、現在不過）、哪幾題進步、軟性失敗次數的變化。

常用選項：`--profile web`（網頁問答用的 Haiku 5.5）、`--model <id>`（比較別的模型）、`--runs 3`（模型有隨機性，每題跑 3 次，全過才算過）、`--only speakers,venue`、`--tag no-data`。完整說明在 `run.mjs` 開頭。

## 怎麼新增題目

1. 在 `cases/core.json` 的 `cases` 加一題：`id`、`tag`、`q`，以及要檢查的 `include`（必須出現）、`include_any`（每一組至少出現一個）、`exclude`（不能出現）、`expect_no_data`、`expect_lang`。
2. 在 `mock-good.json` 補這一題的標準答案（`npm test` 會檢查題庫與標準答案一一對應）。
3. **最好的新題目來自真實事故**：記者截圖回報了什麼問題，就把那個問法寫成一題，確保它不會再發生。⚠️ 真實問答含個資，寫成題目前要改成虛構的人名與內容，不要把真資料放進 repo。

## 限制（請別高估這個分數）

- 這是**近似**正式站：system prompt 用同一支 `lib/prompt.js` 組，但沒有 `bot_memory`、對話歷史、跨場次資料、LINE 版面規則。拿來比較「前後差異」很準；拿來宣稱「正式站一定是這個分數」不行。
- 題庫只有 20 題、一個虛構活動：抓得到**退步**，不代表沒退步的地方就沒問題。
- 程式評分抓得到「答案裡有沒有編造的數字」，抓不到「措辭好不好」「有沒有答到重點」——那要人看。
- 只有這支會花錢；`npm test` 永遠只跑 mock。

## 聲明稿／回應說明題庫（批次 196）

`tools/eval/cases/statement.json`（標準答案 `mock-statement.json`）：虛構的「敏感新聞回應說明」場次，三類題目——**口徑外追問**（院方說明範圍外，不能講成「沒有資料」）、**連續追問**（上一題也答不出來，要更短）、**資料沒寫**。

```bash
node tools/eval/run.mjs --cases tools/eval/cases/statement.json --provider mock --mock tools/eval/mock-statement.json
ANTHROPIC_API_KEY=… node tools/eval/run.mjs --cases tools/eval/cases/statement.json --save tools/eval/results/statement-before.json
```

題目可以帶 `history`（上一輪對話）、`prev_no_data: true`（模擬「上一題也答不出來」，系統會多一句不要重複的提示）、`max_lines`（連續追問的行數上限）。新增的硬性檢查：

| 檢查 | 意思 |
|---|---|
| `honest_no_data`（改了定義） | 以前是「答案裡要出現『沒有資料』這類字」；現在是**程式判得出這一題是 no_data**（模型標了 `[[NO_DATA]]`，或句型像沒資料）。沒有編造由 `grounded`／`exclude` 負責 |
| `no_false_handoff` | 模型自己寫「已轉給同仁」「幫您轉達」「轉介」就是假承諾或多餘的一句——轉告是不是真的、要不要轉介的詢問，都是程式接的（批次 197：先問記者要不要，回「是」才通知） |
| `out_of_scope_wording` | 口徑外的題目（`expect_out_of_scope`），回覆裡不能有「沒有資料」「無法確認」「無可奉告」 |
| `short_reply` | 連續追問的題目（`max_lines`）比第一題短 |
| `out_of_scope_marker`（軟性） | 口徑外的關鍵詞有填「口徑外」（程式靠它接上院方固定說法） |
