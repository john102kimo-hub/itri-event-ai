# 部署說明 — 工研院活動溝通 AI 平台

## 環境變數一覽

### 必填（5 個）

| 變數名 | 說明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API Key（sk-ant-...） |
| `ADMIN_PASSWORD` | 自訂後台密碼 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google 服務帳號 Email |
| `GOOGLE_PRIVATE_KEY` | Google 服務帳號私鑰（含換行） |
| `GOOGLE_SPREADSHEET_ID` | Google 試算表 ID |

### 選填 —— 給「AI 能見度追蹤」（/geo）用，不設定則該功能停用

| 變數名 | 說明 |
|---|---|
| `CRON_SECRET` | **強烈建議設定**（隨機長字串即可）。沒設的話排程端點只能靠容易被偽造的 User-Agent 驗證，等於任何人都能觸發全量重掃、燒光 API 額度。詳見 [GEO_SETUP.md](GEO_SETUP.md)。 |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `PERPLEXITY_API_KEY` | 想多掃哪家 AI 引擎就填哪把，缺的引擎會自動跳過，不影響其他功能 |
| `GEO_MODEL` / `GEMINI_MODEL` / `OPENAI_MODEL` / `PERPLEXITY_MODEL` | 想指定特定模型版本才需要填，留空用系統預設 |

### 選填 —— 給「LINE 官方帳號問答」（/api/line）用，不設定則該功能停用

完整申請步驟見 [LINE-PLAN.md](LINE-PLAN.md) 第 3 節。三個都要設定，缺一個 webhook 就無法運作（會回 500 或簽章一律驗證失敗）：

| 變數名 | 說明 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers Console → Messaging API channel 的 Channel secret。用來驗證每個 webhook 請求真的來自 LINE，**這把沒設對，任何人都能偽造 LINE 的名義打你的 webhook**。 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 同頁的 Channel access token（要選「長期」，不是那種會過期的短期權杖）。用來呼叫 LINE 的回覆／推播 API。 |
| `LINE_BASIC_ID` | 官方帳號的 LINE ID（`@` 開頭），用來組記者掃碼用的 QR 連結；`api/line.js` 本身不需要這個值，是給後台產生 QR 用（批次 3 才會用到）。 |

設完到 LINE Developers Console → Messaging API → Webhook URL 填 `https://itri-event-ai.vercel.app/api/line`，按 **Verify** 應顯示 Success。

---

## STEP 1：建立 Google 試算表

1. 開新試算表：https://sheets.new
2. 將試算表網址中的 ID 記下：
   `https://docs.google.com/spreadsheets/d/【這段就是ID】/edit`
3. 點右鍵 Sheet1 標籤 → **重新命名**為 `events`
4. 在 A1~O1 填入標題：`id` `name` `color` `knowledge_base` `status` `created_at` `chips` `images` `greeting` `organizer` `edit_code` `event_time` `venue` `event_type` `press_contact`
   - 其中 `edit_code`（K 欄）是「同仁編輯連結」用的每場專屬編輯碼，系統會自動產生、不用手動填。若是既有試算表，只要確保 K 欄留著給它用即可。
   - `created_at`（F 欄）欄名是舊的，實際存的是**活動日期**（後台的「活動行事曆」就是靠這欄畫的）——新增／編輯活動時填的「活動日期」寫的就是這一欄，欄名沒有跟著改是為了不動既有資料。
   - `status`（E 欄）合法值有四種：`draft` 未發布（僅後台看得到，新活動預設值）／`active` 進行中／`ended` 已結束／`archived` 已封存。
   - L～O 欄（`event_time` `venue` `event_type` `press_contact`）是活動時間、地點、類型、新聞聯絡人，全部選填，後台「活動行事曆」與卡片會顯示。若是既有試算表沒有這幾欄，不影響現有功能運作——程式是照欄位位置讀寫，不是照標題文字比對；只是你自己打開試算表看的時候，補上標題會比較好懂。
5. 點 ＋ 新增分頁，重新命名為 `qa_log`
6. 在 A1~F1 填入標題：`timestamp` `event_id` `event_name` `media_name` `question` `answer`
   - G 欄留給系統標記刪除用（後台按「刪除」時會在這欄寫 `1`，不用手動填、也不用管它）
7. 其餘分頁（`exposure`、`geo_prompts`、`geo_runs`、`geo_events`、`geo_settings`、`media_roster`、`media_settings`）
   不用手動建立——第一次用到「露出上傳」「AI 能見度」「記者名單健檢」等功能時，系統會自動建好並補上表頭。

---

## STEP 2：建立 Google 服務帳號

1. 開啟 https://console.cloud.google.com/
2. 左上「選取專案」→「建立新專案」（名稱隨意）
3. 左側選單 → **API 和服務** → **程式庫**
4. 搜尋 `Google Sheets API` → 啟用
5. 左側 → **憑證** → **建立憑證** → **服務帳號**
   - 名稱隨意（例：itri-event-ai）
   - 點「完成」
6. 點擊剛建立的服務帳號 → **金鑰** → **新增金鑰** → **建立新金鑰** → JSON
7. 下載 JSON 檔，記下其中的：
   - `client_email`（這是 GOOGLE_SERVICE_ACCOUNT_EMAIL）
   - `private_key`（這是 GOOGLE_PRIVATE_KEY）
8. **回到試算表**，點右上角「共用」，將 `client_email` 加入為「編輯者」

---

## STEP 3：上傳到 GitHub

1. 前往 https://github.com → 右上「+」→「New repository」
2. Repository name 填 `itri-event-ai`，選 **Public** → Create
3. 點「uploading an existing file」
4. 將 `itri-event-ai/` 資料夾內所有檔案與子目錄一起拖入（保持目錄結構）
5. Commit changes

---

## STEP 4：部署到 Vercel

1. 前往 https://vercel.com，用 GitHub 帳號登入
2. **Add New Project** → 選 `itri-event-ai` → Framework Preset 選 **Other** → **Deploy**
3. 等待部署完成（約 1 分鐘）

---

## STEP 5：設定環境變數

**Vercel 專案 → Settings → Environment Variables**，逐一新增：

| 變數 | 值 |
|---|---|
| `ANTHROPIC_API_KEY` | 你的 Anthropic API Key |
| `ADMIN_PASSWORD` | 自訂一組後台密碼 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON 檔中的 client_email |
| `GOOGLE_PRIVATE_KEY` | JSON 檔中的 private_key（完整複製，含 -----BEGIN... 到 ...END----- 和換行） |
| `GOOGLE_SPREADSHEET_ID` | 試算表 ID（Step 1 記下的那段） |

設完後點 **Deployments** → 最新一筆 **⋯** → **Redeploy**

---

## 完成後的網址

| 頁面 | 網址 | 誰用 |
|---|---|---|
| 後台儀表板 | `https://itri-event-ai.vercel.app/` | **只有你**（需後台密碼） |
| 記者前台 | `https://itri-event-ai.vercel.app/event?id=活動ID` | 記者（免登入） |
| 同仁編輯頁 | `https://itri-event-ai.vercel.app/edit?id=活動ID&code=編輯碼` | 負責該場的同仁（免後台密碼） |
| 媒體訓練 | `https://itri-event-ai.vercel.app/training?id=活動ID` | 主管（要先從後台登入過，或用同仁編輯碼；直接開網址無法使用） |
| 成效報告 | `https://itri-event-ai.vercel.app/report` | **只有你**（需後台密碼，一頁印給主管看） |
| AI 能見度追蹤 | `https://itri-event-ai.vercel.app/geo` | **只有你**（需後台密碼），選配功能見上方 GEO 環境變數 |
| 記者名單健檢 | 從後台或同仁共用連結進入 | 你與獲授權同仁 |

---

## ⚠️ 要加新功能前，先看這段（Vercel 免費方案的 12 支上限）

Vercel Hobby（免費）方案規定：**一次部署最多 12 個 Serverless Function**，超過就整包部署失敗，
畫面會出現這行紅字：

> No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan.

判斷方式很簡單——**`api/` 資料夾底下每一個 `.js` 檔就是一支 Function，包含子資料夾裡的檔案**。
不是只算「看得出來是 API 的那幾支」。

以前 `api/lib/sheets.js`、`api/lib/exposure-parse.js` 這兩個「共用工具檔」放在 `api/` 底下，
它們根本不是 API、沒有人會去呼叫，卻照樣各佔一格，等於白白吃掉 2 格額度。
現在已經搬到根目錄的 `lib/`，額度回來了：

| | 位置 | 佔用格數 |
|---|---|---|
| 10 支真正的 API | `api/*.js` | 10 |
| 2 個共用工具檔 | `lib/*.js`（根目錄，**不佔額度**） | 0 |
| **合計** | | **10 / 12（剩 2 格）** |

**所以之後：**

- 要加新的 API → 直接在 `api/` 新增 `.js`，還有 2 格可以用。
- 要加「共用工具檔」（不是 API、只是給別的檔 import 的） → **一定要放根目錄 `lib/`，不要放 `api/`**。
- 又滿了怎麼辦 → 不必升級付費方案。把功能相近的幾支合併成一支，
  再用 `vercel.json` 的 `rewrites` 帶一個參數進去分流即可。
  現成範例：`api/event-page.js` 一支同時供應 `/event`、`/robots.txt`、`/sitemap.xml` 三個網址。

---

## 日常使用流程（你自己辦一場）

1. 登入後台 → **新增活動** → 貼入新聞稿 → 儲存
2. 複製「記者連結」 → 傳給媒體
3. 活動結束後 → 同仁在編輯頁上傳監測公司給的「OO露出清單.doc」→ 後台看「提問 × 露出」交叉分析
4. **分析** 看問題熱點 → **匯出 CSV** 製作結案報告，或直接開「成效報告」頁印給主管
5. 下次記者會 → 再新增一個活動，同一個平台管理

---

## 讓同仁自己更新內容（你仍掌握後台與數據）

適用情境：你幫同仁開好活動框架，內容細節請他自己填、之後也自己維護。

1. 登入後台 → **新增活動**（先開好、填基本資料即可）
2. 在該活動卡片點 **「同仁編輯連結」** → 連結自動複製
3. 把這條連結（含 `?id=...&code=...`）貼給負責的同仁
4. 同仁打開連結 → 直接編輯**這一場**的新聞稿、快速問題、開場白、圖片 → 按「儲存內容」

**權限邊界（重點）**：

- 同仁只需要那條連結，**不需要、也拿不到後台密碼**
- 同仁只能改**自己那一場**，看不到後台、看不到問答分析數據、看不到其他活動、不能封存
- 記者在同仁那場問的**每一題，全部照樣寫進你這張 Google Sheet**，分析與匯出仍只有你能看
- 若連結外流要作廢：到試算表把該列 **K 欄（edit_code）清空或改字**，舊連結立即失效；下次在後台再點一次「同仁編輯連結」會產生新的碼
