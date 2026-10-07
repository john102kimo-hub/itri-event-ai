# 工研院活動溝通 AI 平台（itri-event-ai）

多活動共用的記者會 AI 問答平台。記者在**網頁**或 **LINE（米亞）** 問活動的新聞稿內容，承辦人在**後台**管活動與看數據；
另外還有 **AI 能見度追蹤（GEO）**、**媒體訓練**、**活動報名**（原名「媒體報名」，批次 112 改名）。純 Node serverless（Vercel）＋靜態 HTML＋Google Sheets 當資料庫，沒有前端框架。

## 有哪些入口

| 誰用 | 網址 | 主要檔案 |
|---|---|---|
| 記者（網頁問答） | `/event?id=…` | `public/event.html`、`api/chat.js`、`api/event-page.js`（SSR，給搜尋引擎與 AI 爬蟲讀） |
| 記者（LINE 米亞） | LINE 官方帳號 | `api/line.js`（webhook 入口）、`lib/line-*.js`（記者、群組、職員、報名各一支，對照表在 `api/line.js` 開頭）、`lib/router.js`、`lib/menu.js`、`lib/staff.js` |
| 承辦人（後台） | `/admin` | `public/index.html`、`api/events.js`、`api/analytics.js`、`api/export.js` |
| 同仁（改自己那一場） | `/edit?id=…&code=…` | `public/edit.html`、`api/events.js`（`get_edit`／`update_edit`） |
| 主管（成效報告） | `/report` | `public/report.html`、`api/exposure.js` |
| AI 能見度追蹤 | `/geo` | `public/geo.html`、`api/geo.js`、`lib/geo-*.js` |
| 主管（媒體訓練） | `/training` | `public/training.html`、`api/training.js` |
| 記者（活動報名）／後台：所有活動與名單 | `/register`／`/registrations` | `public/register.html`、`public/registrations.html`、`lib/registration*.js` |

## 先讀這幾份

1. **[CLAUDE.md](CLAUDE.md)**——朱朱交代過、每一次都適用的長期約定（只用台灣繁體中文、「絕對不能發生」的事擋在程式出口、米亞只有一種聲音、影片一定要有聲音軌、紀錄放哪裡）。
2. **[SETUP.md](SETUP.md)**——部署、環境變數、Google 試算表怎麼建、Vercel 免費方案的 12 支 Function 上限（現在 `api/` 用了 11 支）。
3. **[LINE-PLAN.md](LINE-PLAN.md)**——長期規格：定位、資料模型、七個會害你重做的坑、LINE 的意圖、prompt 規則、不要做的事。
4. **[docs/batches/README.md](docs/batches/README.md)**——每一批改動的來龍去脈（為什麼這樣改、踩到什麼坑）。程式碼註解寫「批次 N」就到這裡找。
5. AI 能見度：[GEO_SETUP.md](GEO_SETUP.md)（怎麼設定）、[GEO-METHOD.md](GEO-METHOD.md)（測量方法與依據）。[FIX-PLAN.md](FIX-PLAN.md) 是已完成的工單紀錄。

## 開發與驗證

```bash
npm test                    # 全部測試，約 35 秒。用假的 Google Sheets／LINE／模型，不需要金鑰、也不需要 npm install
npm test -- flow batch110   # 只跑檔名含這些字的測試
SHIFT_DAYS=90 npm test      # 把「現在」往後撥 90 天再跑，專門抓寫死日期的測試
```

GitHub Actions（`.github/workflows/test.yml`）每個 PR 與 main 推送都會跑上面第一種與第三種。
新增測試只要把 `test-*.mjs`／`*.test.mjs` 放進 `test/`，不用改清單。

不進 `npm test` 的檢查（需要 playwright 與 Chromium，前置 `npm i playwright --no-save`；或要花錢、要網路）：

| 工具 | 做什麼 |
|---|---|
| `tools/geo-ui-check`、`tools/reg-ui-check`、`tools/training-flow-check.mjs`、`tools/training-voice-check.mjs` | 在真的瀏覽器裡把 /geo、/registrations（活動報名後台）、媒體訓練的流程與語音跑一遍 |
| `tools/sri-check` | 驗證 CDN 資源的 SRI 雜湊（原檔通過、竄改過的被瀏覽器拒絕） |
| `tools/line-button-audit`、`tools/line-group-sim`、`tools/line-persona-sim` | 把 LINE 的每一步、群組對話、四種角色丟進真的 `api/line.js`，看按鈕與回應（AI 是假的，看的是規則層） |
| `tools/model-ab` | 同一批問題比兩個模型的答案（**會花真的錢**） |
| `tools/time-travel` | `SHIFT_DAYS` 用的時間位移 |
| `tools/guide-video` | 使用說明影片與米亞的聲音（見 CLAUDE.md 第 3、4 條） |

## 動手前先記住

- **會踩到 Google Sheets 的讀取額度**（每分鐘 60 次、全站共用）。公開入口讀活動表一律走 `lib/events-table.js` 的快取，不要各自 `readRange('events!…')`。
- **管理員與編輯碼的比對一律走 `lib/auth.js`**（`requireAdmin()`、`codeMatches()`），不要自己寫 `password !== …`——那樣在密碼沒設定時會放行。
- **「絕對不能發生」的事擋在程式出口**，不是寫在 prompt：繁體字（`lib/zh-tw.js` 的 `toTraditionalTW()`）、發布閘門（`lib/event-status.js`）、網頁問答一定要有媒體名稱（`api/chat.js`）、管理員驗證（`lib/auth.js`）。
- 新增後台頁面時，要把它加進 `vercel.json` 的安全標頭規則（`test/test-batch110.mjs` 會逐頁檢查）。
- **寫入 Sheets 不是每一種都能重送**：`appendRows()`（加一列）與 `batchUpdate()`（刪列、加分頁）逾時或 500 時不重試，免得多一列或刪錯列（批次 117，見 `lib/sheets.js`）。新增會呼叫模型的地方，記得接 `logAiUsage()`（`test-batch117` 會檢查）。
- 紀錄要寫：改了什麼、為什麼、踩到什麼坑——寫在 `docs/batches/`，不是 commit message（見 CLAUDE.md 第 5 條）。
