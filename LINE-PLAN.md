# 活動行事曆 × LINE 媒體窗口 — 長期規格（給接手的 AI）

> **狀態：批次 1–111 已完成並上線（2026-10-02 核對）。這份只留長期有效的規格**：定位、資料模型、七個坑、
> 意圖、prompt 規則、不要做的事、人類待辦。每一批「改了什麼、為什麼、踩到什麼坑」的紀錄在
> [docs/batches/](docs/batches/README.md)（2026-10-02 從這份搬出去，內容原封不動）。
>
> 給誰讀：任何接手實作的 AI。**動工前把第 0～4 節與第 8 節讀完**——第 3 節那七個坑每一個都會讓你整支重寫。
> 下面的規格與「人類要先做的事」寫於動工之前，保留是因為它們解釋了當初的取捨；**現況以程式碼與 docs/batches/ 為準**，
> 行號一律不要照抄，自己 grep 現行程式碼。
>
> 專案入口與長期約定見 [README.md](README.md)、[CLAUDE.md](CLAUDE.md)；
> [FIX-PLAN.md](FIX-PLAN.md) 是已完成的改進工單紀錄，這份不是待辦清單。

---

## 0. 雙軌定位（先把「誰負責什麼」釘死）

| | 網頁 AI 問答（現有） | LINE 官方帳號（新增） |
|---|---|---|
| 場景 | **記者會現場與會後 72 小時** | **平時，沒有活動的日子** |
| 深度 | 深。整份新聞稿、技術資料、圖檔下載 | 淺。查得到、找得到人、問得出基本資料 |
| 入口 | 該場專屬連結／QR | 加一次好友，長期留著 |
| 主力問題 | 「這項技術的量產時程是什麼？」 | 「你們最近有什麼活動？」「我想採訪固態電池團隊」 |
| 不做 | 不處理邀訪 | 不取代網頁版的深度問答，答不動就給連結 |

**LINE 不是網頁版的行動版，是它的常設前廳。** 記者在 LINE 問到需要深入的東西，正確行為是給出該場的 `/event?id=` 連結，而不是在 LINE 裡把新聞稿全文倒出來。

---

## 1. 「深度同步」的正解：不要同步

使用者的原話是「兩邊要深度同步」。**做同步是錯的路**——兩份資料 + 一個對帳機制，最後一定會不一致，而且不一致的那天你不會知道。

**正解：只有一份資料。** 後台行事曆、網頁問答、LINE 回答，讀的是 Google Sheet 裡**同一張 `events` 表的同一批列**。沒有「兩邊」，所以沒有同步問題。

這也是為什麼行事曆必須先做（見第 5 節批次順序）：

> **行事曆不是新功能，是 `events` 表長出一個他每天都會用的介面。**

而它順帶解決了 LINE 最難的技術問題——上一版規格裡我設計了一個「AI 自動生成活動摘要卡」給跨場次路由當索引，那東西的問題是**沒人維護就會爛掉**。行事曆取代了它：使用者為了自己的工作會天天維護行事曆，路由索引因此永遠是新的。一件事解決兩個問題。

---

## 2. 資料模型（兩個正交維度，不要混在一起）

### 維度一：可見性 = `status`（三態，取代現有兩態）

| 值 | 意義 | 網頁 `/event?id=` | LINE 行事曆查詢 | LINE 深度問答 |
|---|---|---|---|---|
| `draft` | 已排定但**不對外** | **404** | **完全不可見** | 不可見 |
| `active` | 對外 | 正常 | 列得出來 | 看維度二 |
| `archived` | 已結束 | 存檔頁 | 列得出來（標「已結束」） | 看維度二，回答要加時間戳警語 |

- **新增活動的預設值是 `draft`**，使用者明確按「發布」才轉 `active`。行事曆一旦對記者可見，「這個月有幾場」就等於預告工研院的發布節奏，預設必須是不對外。
- **舊資料遷移**：現有只有 `active`/`archived`（空值視同 `active`）。遷移時**一律不要自動判成 `draft`**——寧可漏判成 `active`（現況本來就是如此，不是新風險），也不要把已上線場次誤關成 404。
- ⚠️ `api/chat.js`、`api/events.js`、`api/event-page.js`、`api/training.js`、`api/geo.js` 都有讀這欄，**要一起改並逐支確認**。漏掉 `event-page.js` 會讓 draft 場次的網頁還開得起來，等於防了 LINE 沒防網頁。

### 維度二：回答深度 = `knowledge_base` 有沒有內容（不需要新欄位）

| 狀況 | LINE 能回什麼 |
|---|---|
| `knowledge_base` 有內容 | 深度問答（走現有 `api/chat.js` 那套 prompt） |
| `knowledge_base` 空 | 只回基本資料：日期、時間、地點、性質、新聞聯絡人，並說明「詳細資料將於活動當日提供」 |
| `event_date` 在未來 | **即使有 kb 也只回基本資料**——未辦的場次不得預先釋出內容 |

這兩個維度**正交**：`active` + 空 kb = 記者知道有這場但問不到內容，這是正常且正確的狀態。

### `events` 表要新增的欄位

> **批次 1 實作時發現規劃有誤，以下是實際上線的版本（已上線，2026-08-20 部署）：**
> `event_date` 不是新欄——F 欄雖然標題還叫 `created_at`，但 `api/events.js` 早就把它當活動日期在讀寫（`create`/`update` 的 `event_date` 參數就是寫這欄）。所以只新增了 **L–O 四欄**，不是五欄，`event_date` 沒有另外佔欄位。下面是真的欄位對應，之後接 LINE 就照這個：

| 欄 | 名稱 | 說明 |
|---|---|---|
| F | `event_date`（別名，實體欄名仍是 `created_at`） | 活動日期。API 回應裡 `event_date` 與 `created_at` 兩個 key 同時存在、值相同，新程式碼一律讀 `event_date` |
| L | `event_time` | 時間字串，如 `10:00`。空著就不顯示 |
| M | `venue` | 地點 |
| N | `event_type` | `記者會` / `發表會` / `論壇` / `參訪` 等，自由文字，給行事曆分色與 LINE 回答用 |
| O | `press_contact` | 該場新聞聯絡人姓名 + 分機。**答不出來時要給的就是這個**，比什麼都重要 |

- `event_date` 為空的舊資料：行事曆歸到「未排定日期」區，LINE 的月份查詢跳過它，**不要猜**。
- 不要新增「摘要」欄。行事曆的 `name` + `event_type` + `event_date` 已經足夠當路由索引，多一欄就多一個沒人維護的欄位。
- `api/events.js` 已有 `action=list_admin`（後台密碼）與預設列表（公開，不含 draft）兩個現成端點，兩者都已附上述欄位 + `has_kb` 布林值。**批次 2/3 直接讀這兩個既有 action，不要再開新的。**

---

## 3. 七個會害你重做的坑（必讀）

### 坑 1：raw body —— LINE 簽章驗證唯一的正解

LINE 的 `x-line-signature` 是對**原始 bytes** 做 HMAC-SHA256 再 Base64。

Vercel 的 `req.body` 是一個 **JavaScript getter，一旦存取就會把 stream 讀掉**，之後你再也拿不到原始 bytes。而 `JSON.stringify(req.body)` 產生的字串**不保證**與 LINE 送來的原文逐 byte 相同（空白、跳脫、欄位順序都可能不同），簽章會時好時壞——這種 bug 最難查，因為它平常會過。

**做法：整支 `api/line.js` 從頭到尾不要碰 `req.body`。** 自己讀 stream：

```js
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// handler 內：
const raw = await readRawBody(req);                    // Buffer，先驗簽章
const expected = createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
  .update(raw).digest('base64');
if (req.headers['x-line-signature'] !== expected) return res.status(401).end();
const payload = JSON.parse(raw.toString('utf8'));      // 驗完才自己 parse
```

簽章比對用 `crypto.timingSafeEqual`（長度先比對，避免 throw）。
**簽章沒過一律 401 並直接結束，不要做記 log 之外的任何動作**——這支是全公開端點，沒有這道就是開放的 LLM 代理。

### 坑 2：Function 額度只剩 2 格，全程只能用掉 1 格

Vercel Hobby 上限 12 支，`api/` 底下每個 `.js` 都算一支。**2026-10 核對：目前 11 支，只剩 1 格**（這節寫於動工前，當時是 10 支）。

- 行事曆**不准開新 API**——用現有 `api/events.js` 加參數就好。
- 邀訪收單**不准開新 API**——寫在 `api/line.js` 裡。
- 共用邏輯一律放根目錄 `lib/`（不佔額度）。

做完全部四批應該是 **11/12**。如果你發現自己要開第 13 支，停下來重看 [SETUP.md](SETUP.md) 最後一節的合併 + rewrites 分流做法。

### 坑 3：reply token 只活 60 秒，而且只能用一次

- 主路徑：webhook → 驗簽 → `POST /v2/bot/chat/loading/start`（loadingSeconds 60，讓記者看到輸入中動畫）→ 呼叫 Anthropic → `POST /v2/bot/message/reply`。**reply 不計費、無則數上限。**
- 意圖路由會多一次 API 呼叫（+1～2 秒）。路由那段務必用 Haiku、`max_tokens` 壓在 200 以內。
- **一定要寫 fallback**：reply 回非 2xx（多半是 `Invalid reply token`）時改用 `POST /v2/bot/message/push`。push 會計費，但輕用量方案每月免費 200 則，記者量級用不完；重點是記者不會「問了沒下文」。
- `vercel.json` 幫 `api/line.js` 加 `"maxDuration": 60`（照 `api/chat.js` 的寫法）。

### 坑 4：Google Sheets 配額會被 LINE 放大

服務帳號限制是**每分鐘讀 60 / 寫 60，全平台共用**（含後台、GEO 排程、露出上傳）。

**做法**：`events` 全表與 `line_users` 在冷啟動時一次讀進記憶體，TTL 60 秒，比照 `api/chat.js` 現有的 `eventCache` 寫法。只有「綁定活動」「填寫媒體名稱」「邀訪收單」三個動作才寫 Sheets。

### 坑 5：未發布場次外洩

LINE 統一窗口會讀「所有場次」。**`events` 表裡一定會有草稿場次**（後台開好框架、同仁還在填）。`status` 三態（第 2 節）**必須在 LINE 路由上線之前完成**，這是硬性前置條件，不是「順便做」。

驗收要當成資安測試在做：拿 draft 場次的活動全名去問，必須答「沒有相關場次」。

### 坑 6：跨場次歸納會生出工研院沒說過的話

記者一定會問「工研院今年在半導體發表了幾項技術？」「這跟去年那場比如何？」。AI 一開始跨場總結，就是在替主辦單位發言。prompt 必須明文禁止（第 6 節），只能回「以下這幾場提到」+ 分場引述原文。

### 坑 7：不要用向量資料庫

看到「跨多場次檢索」就想裝 embedding + vector DB 是錯的路。場次是幾十到幾百不是幾萬；行事曆清單一次全塞進 prompt 就能選得準，而且更會處理「上個月那場醫療的」這種時間＋主題混合的模糊指涉。引入向量庫等於引入外部服務 + npm 依賴 + 一份會過期的索引，違反本專案「零依賴、單一資料來源」的核心約束。

---

## 4. LINE 的四類意圖（一次路由全部分完，不要串接多次呼叫）

第一段路由用 Haiku 做**一次**呼叫，同時完成「意圖分類」與「選場」，回 JSON：

```json
{ "intent": "calendar|qa|interview|other", "event_ids": ["..."], "confidence": "high|low" }
```

輸入只給**行事曆清單**（`id｜名稱｜日期｜性質｜有無詳細資料`，一場約 40 tokens，200 場也才 8000 tokens），不給知識庫全文。這份清單逐 byte 穩定，套 `cache_control: ephemeral` 後幾乎不花錢（`api/chat.js` 已在用這招，照抄）。

### intent: `calendar` —— 活動查詢

「這個月有哪些活動」「下週有沒有記者會」「你們今年辦過哪些發表會」

- 直接用行事曆資料組回覆，**不呼叫第二段**，快又零成本
- 格式：日期 + 名稱 + 性質 + 一個標記（`可線上問答` / `基本資料`），最多列 8 筆，超過就說「還有 N 場，可以縮小範圍再問」
- 未來場次與過去場次分開列，不要混在一起

### intent: `qa` —— 特定活動的問答

- 有 kb 且 `event_date` 已過 → 走第二段，跟網頁版同一套 prompt
- 沒有 kb 或活動還沒辦 → 回基本資料 + `press_contact`，並附該場 `/event?id=` 連結（若已發布）
- 路由選不出場次 → 列最近 5 場讓記者用 quick reply 挑，**不要呼叫第二段**

### intent: `interview` —— 邀訪／聯絡（這是 LINE 平時最有價值的用途）

「我想採訪你們固態電池的團隊」「有沒有專家可以談 AI 晶片？」

**AI 只做收單，不做任何承諾與安排。** 流程：

1. 追問缺的欄位（媒體、記者姓名、採訪主題、期望時間、截稿時間），一次問一個，不要一口氣丟五個問題
2. 湊齊後寫進新分頁 `media_requests`
3. 回：「已收到您的採訪需求，新聞聯絡人會在**一個工作天內**與您聯繫。急件請直接來電 ○○○○。」
4. **同時 push 一則通知到使用者自己的 LINE**（把自己的 userId 存成環境變數 `LINE_ADMIN_USER_ID`），否則收了單沒人知道

> ⚠️ 這一項把 LINE 從「查資料」變成「業務入口」。有人問了就會期待回覆，**三天沒回比沒有這個功能更傷**。上線前使用者要先想清楚自己接不接得住，接不住就先不要開這個 intent。

### intent: `other` —— 其他

閒聊、立場評論、政治議題、與其他機構比較、未公開的財務或合作條件 → 婉拒 + 引導 + 提供新聞聯絡人，**不呼叫第二段**。

### 新增的 Sheets 分頁

用 `lib/sheets.js` 現成的 `ensureSheets()` 自動建立，不要叫使用者手動開。

**`media_requests`**：`timestamp｜line_user_id｜media_name｜reporter_name｜topic｜preferred_time｜deadline｜status｜note`
（`status` 預設 `new`，使用者在 Sheet 裡自己改成 `contacted` / `done`）

**`line_users`**：`line_user_id｜event_id｜media_name｜bound_at｜last_active｜note`

- `event_id` 是記者會現場掃 QR 綁的場次，**必須有 6 小時 TTL**——沒有這條，記者三個月後問別場會被鎖在當初掃碼那場，而且他不會知道為什麼，只覺得這 bot 壞了。用 `bound_at` 跟現在時間比對即可，不需要排程清理。
- 多輪對話**不要寫進 Sheets**。Function 記憶體保留最近 3 輪、TTL 10 分鐘，冷啟動掉了就退化成單輪。不值得為此引入 Redis／KV。

---

## 5. 施工批次（已搬到 docs/batches/）

批次紀錄不再放在這份文件裡——它長到 6,000 多行、單次讀不完，而且每一批只有在動到相關地方時才需要讀。

**怎麼找**：程式碼註解寫「LINE-PLAN.md 批次 N」時，用下表找到那一份；全部批次的逐筆索引（含標題）在 [docs/batches/README.md](docs/batches/README.md)；
也可以直接 `grep -rn "批次 N" docs/batches/`。

| 批次 | 檔案 |
|---|---|
| 1–15 | [01-batch-001.md](docs/batches/01-batch-001.md) |
| 16–27 | [02-batch-016.md](docs/batches/02-batch-016.md) |
| 28–44 | [03-batch-028.md](docs/batches/03-batch-028.md) |
| 45–56 | [04-batch-045.md](docs/batches/04-batch-045.md) |
| 57–65 | [05-batch-057.md](docs/batches/05-batch-057.md) |
| 66–72 | [06-batch-066.md](docs/batches/06-batch-066.md) |
| 73–82 | [07-batch-073.md](docs/batches/07-batch-073.md) |
| 83–91 | [08-batch-083.md](docs/batches/08-batch-083.md) |
| 92–116 | [09-batch-092.md](docs/batches/09-batch-092.md) |
| 117 起（最新） | [10-batch-117.md](docs/batches/10-batch-117.md) |

**新的一批怎麼記**：見 [CLAUDE.md](CLAUDE.md) 第 5 條——往 `docs/batches/` 最新那份後面接，並在 `docs/batches/README.md` 補一行索引；
最新那份超過約 900 行就開下一份。**這份文件不要再往下接批次紀錄**，否則兩個月後又是一份讀不完的文件（`test/test-docs.mjs` 會擋行數）。

## 6. system prompt 要加的規則

沿用 `api/chat.js` 那份（搬到 `lib/prompt.js` 共用），額外附加：

**LINE 通用**

```
- 這是 LINE 對話，請控制在 5 行以內。記者要完整新聞稿時，給該場網址請他自行下載，不要在對話裡倒全文。
- 需要附連結時直接給網址純文字，不要用 Markdown 語法（LINE 不會渲染，記者會看到一堆星號與方括號）。
- 你的回覆會出現在掛著主辦單位名義的官方帳號裡，記者可能直接截圖引用。任何不確定的內容，寧可說「這部分我沒有資料，建議洽新聞聯絡人 ○○○」。
```

**跨場次模式專用（批次 3，這三條是新風險的防線）**

```
- 你手上是多場記者會的資料。回答時務必說明「這是哪一場、什麼時候」，不要讓記者以為是同一場。
- 絕對不要跨場次做歸納、統計、比較或趨勢推論（例如「工研院今年共發表 N 項技術」「這比去年進步」）。這類問題只能回「以下這幾場提到相關內容」並分場引述原文，剩下的請記者自行判斷。你做的任何跨場總結都會被當成主辦單位的官方說法。
- 若同一件事在不同場次有不同數字或說法，如實並列並標明各自出處與日期，不要自行挑一個或取平均。
- 尚未舉行的場次，只能提供日期、地點、性質與新聞聯絡人，不得透露任何內容細節。
```

**archived 場次的時間戳警語**（與現有結尾警語**並存，不是取代**）

```
（本場為 YYYY 年 MM 月資料，最新進展請洽新聞聯絡人。）
```

---

## 7. 人類要先做的事

### 批次 1 不需要任何前置，可直接開工

### 批次 2 之前要做的（LINE，約 20 分鐘，全部免費）

1. 用**個人 LINE 帳號**到 https://manager.line.biz 建立官方帳號
   - **前三批刻意用「未認證帳號」**：免審核、5 分鐘開好、搜尋不到（只能靠 QR／連結加入）
   - 名稱要**跨場次通用**（終局是常設窗口），但**先不要掛「工研院」**。例如「記者會新聞小幫手」
2. LINE Official Account Manager →「設定 → 回應設定」：Webhook 開啟、聊天也開啟（提示時選**同時啟用**）；**關掉「自動回應訊息」**否則會跟 webhook 搶著回；歡迎訊息改成引導語
3. https://developers.line.biz 建立 Provider → 選這個帳號的 Messaging API channel
4. 取得 **Channel secret**、**Channel access token（長期）**、**官方帳號 LINE ID（@開頭）**
5. Vercel → Settings → Environment Variables：

   | 變數 | 值 |
   |---|---|
   | `LINE_CHANNEL_SECRET` | Channel secret |
   | `LINE_CHANNEL_ACCESS_TOKEN` | 長期 access token |
   | `LINE_BASIC_ID` | `@` 開頭的官方帳號 ID |
   | `LINE_ADMIN_USER_ID` | 使用者自己的 LINE userId（批次 3 的邀訪通知用，可先留空） |

   設完要 **Redeploy**
6. LINE Developers Console → Messaging API → Webhook URL 填 `https://itri-event-ai.vercel.app/api/line`，按 **Verify** 要顯示 Success
7. 同頁把「Auto-reply messages」「Greeting messages」關掉（與步驟 2 重複，兩邊都要確認）
   - ⚠️ 歡迎訊息一定要在 LINE 後台**關掉**：批次 4.5 之後 `follow` 事件會由 webhook 送
     Flex 歡迎圖卡，後台那則若還開著，記者加好友會一次收到兩則歡迎詞
8. 部署完成後，用職員模式在 LINE 打一句「**設定圖文選單**」，把聊天室下方的常駐選單裝上去
   （只需做一次；之後只有改選單文案時才要再打一次）
9. 想開放群組模式（被 @ 才回答，見批次 6）：LINE Official Account Manager →「設定 →
   回應設定」把「允許加入群組/多人聊天」打開，才有辦法把官方帳號拉進既有的記者群。
   沒開這個，LINE 根本不會讓人邀請帳號進群組，跟程式碼無關

### 記者端的入口

- 記者會現場：該場專屬 QR，內容 `https://line.me/R/oaMessage/{LINE_BASIC_ID}/?%23{活動代碼}`
  （`%23` 是 `#` 的百分比編碼；`@` 與中文要 `encodeURIComponent`）
  掃碼後輸入框已預先帶好代碼，按送出即綁定該場
- 平時：一般加好友連結／QR，不帶參數，直接走意圖路由

---

## 8. 明確不要做的事

1. **不要做「兩邊同步」。** 單一資料來源，見第 1 節。任何時候你想寫一個 sync function，就是走錯路了。
2. **不要用 LINE 內建的「AI 聊天機器人（β）」。** 知識庫綁在 LINE 後台、不能多活動切換、問答不會進 Google Sheet——後台分析、露出交叉、媒體訓練全部失效。而且醫療／金融／宗教／政治行政等業種可能被 LINE 擋，本平台場次常涉及智慧醫療。
3. **不要在前三批就申請「工研院」認證官方帳號。** 認證要用法人身分送件、先買專屬 ID（年費約 756 元），一旦掛上機構名義，改一句文案都要跑品牌／法務／資安／個資的流程。先把批次 3 做出來當可運作原型，用數據去談。
4. **不要做推播行銷。** `LINE_ADMIN_USER_ID` 的邀訪通知是推給使用者自己，不是推給記者。一旦開始群發，官方帳號被封鎖或靜音的機率大增，這條通道就毀了。
5. **不要引入向量資料庫／embedding／RAG 框架**（坑 7）。
6. **不要存記者的 LINE 顯示名稱與大頭貼。** 只存 `userId` 與自報的媒體名稱。歡迎訊息要有一句告知：「本帳號會記錄您的提問內容以改善新聞服務，不會蒐集您的個人資料。」
7. **不要把 `LINE_CHANNEL_ACCESS_TOKEN` 寫進任何前端檔案。** 只能待在 Vercel 環境變數與 `api/`／`lib/` 裡。
8. **不要讓企業場出現在記者看得到的地方。** 活動類型是企業說明會／技術媒合會／客戶參訪／技術交流會的場次（`lib/audience.js`）不進米亞的活動清單與路由、不被帶進別場的答案、不在公開列表與搜尋引擎；企業場的報名也不進米亞的「我要報名」、歡迎卡與圖文選單。客戶參訪的活動名稱常常就是客戶的名字。要讓人問、讓人報，一律發專屬連結或 #代碼（批次 118）。
9. **不要讓業發處的合作洽詢佔用米亞與記者會的資源。** 客戶資料只放業發處自己那本試算表（`B2B_SPREADSHEET_ID`），沒設定就整套停用，**絕不退回記者會那本**；米亞聽到「企業合作洽詢」只回洽詢單網址，不在聊天室收任何企業資料；業發處的 LINE 通知跟記者那邊共用推播額度，所以有每月上限、只寫編號與期限。朱朱 10/8：「務必確保不要影響既有的功能與媒體之使用」（批次 119）。

---

## 9. 人類的最後待辦

1. **Anthropic Console 的每月 spend limit 要先設好**（FIX-PLAN.md 最後一節第 1 項）。常設窗口不像單場記者會有天然的流量上限，程式端限流只是 best-effort。
2. `api/line.js` 的限流用 `line_user_id` 當 key，**不要用 IP**——LINE 的 webhook 全部來自 LINE 伺服器 IP，用 IP 當 key 等於全部記者共用一個額度，會誤殺。其餘比照 `api/chat.js` 的 `ipHits`，60 秒 15 次。
3. **邀訪功能上線前，先決定自己的回覆 SLA 並寫進文案。** 收了單沒回比沒有這個功能更傷。
4. **想辦法讓其他處室的記者會也進到 `events` 表。** 行事曆能不能撐起「工研院的媒體窗口」這個定位，全看這件事。現成機制是後台的「同仁編輯連結」（每場一組 `edit_code`，同仁不用密碼、只能改自己那場、問答數據仍全部回流），缺的是把它變成流程慣例。**這是唯一不能靠寫程式解決的一件。**
5. **驗證指標不是問答數，是回訪率。** 平時無活動的日子流量本來就低，一個月沒動靜是正常的，不要提早判死。要看的是同一個 `line_user_id` 有沒有在**不同場次**都出現過——那才證明「常設窗口」這個定位成立。
6. **業發處的合作洽詢正式對外前**：Vercel 升級 Pro（免費方案限非商業使用）、洽詢單與企業場報名的個資告知請院內法務確認、業發處自己決定回覆期限（預設 2 個工作天）並確定接得住——跟第 3 條同一個道理。步驟在 SETUP.md「業發處」一節。

---
