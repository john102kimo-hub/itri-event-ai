# 部署說明 — 工研院活動溝通 AI 平台

## 環境變數一覽（共 5 個）

| 變數名 | 說明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API Key（sk-ant-...） |
| `ADMIN_PASSWORD` | 自訂後台密碼 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google 服務帳號 Email |
| `GOOGLE_PRIVATE_KEY` | Google 服務帳號私鑰（含換行） |
| `GOOGLE_SPREADSHEET_ID` | Google 試算表 ID |

---

## STEP 1：建立 Google 試算表

1. 開新試算表：https://sheets.new
2. 將試算表網址中的 ID 記下：
   `https://docs.google.com/spreadsheets/d/【這段就是ID】/edit`
3. 點右鍵 Sheet1 標籤 → **重新命名**為 `events`
4. 在 A1~K1 填入標題：`id` `name` `color` `knowledge_base` `status` `created_at` `chips` `images` `greeting` `organizer` `edit_code`
   - 其中 `edit_code`（K 欄）是「同仁編輯連結」用的每場專屬編輯碼，系統會自動產生、不用手動填。若是既有試算表，只要確保 K 欄留著給它用即可。
5. 點 ＋ 新增分頁，重新命名為 `qa_log`
6. 在 A1~F1 填入標題：`timestamp` `event_id` `event_name` `media_name` `question` `answer`

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
| 媒體訓練 | `https://itri-event-ai.vercel.app/training?id=活動ID` | 主管 |

---

## 日常使用流程（你自己辦一場）

1. 登入後台 → **新增活動** → 貼入新聞稿 → 儲存
2. 複製「記者連結」 → 傳給媒體
3. 活動結束後 → **分析** 看問題熱點 → **匯出 CSV** 製作結案報告
4. 下次記者會 → 再新增一個活動，同一個平台管理

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
