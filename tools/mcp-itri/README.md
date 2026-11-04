# itri-event-ai MCP 伺服器

讓 Claude Code 直接「查」活動與記者問答，不用再手動從後台複製貼上。**唯讀**。

> MCP（Model Context Protocol）就是替 AI 接工具的標準做法：這支程式把「查活動、查問答」包成五個工具，Claude 要用時自己呼叫。

## 五個工具

| 工具 | 做什麼 | 典型用法 |
|---|---|---|
| `list_events` | 列活動：id、名稱、狀態、日期、地點、距今幾天、必填還缺什麼（不含新聞稿） | 「下週有哪些活動、哪幾場還沒填齊？」 |
| `get_event` | 一場活動的基本資料；新聞稿預設不附，要求才附 | 「這場的聯絡人是誰？」 |
| `event_checklist` | 能不能發布、缺什麼、發布有什麼後果（跟後台、LINE 用同一份規則） | 搭配 `new-event-checklist` skill |
| `qa_summary` | 問答統計：總數、各來源、答不出來的比例、最常被問的 | 「記者最常問什麼？米亞答不出來的有多少？」 |
| `search_qa` | 搜尋問答 | 「有沒有人問過量子電腦？米亞怎麼答的？」 |

## 先試用（不碰任何真資料）

專案根目錄的 `.mcp.json` 預設就指向虛構的範例資料（`fixture.sample.json`）。用 Claude Code 開這個專案，第一次會問你要不要信任這個 MCP 伺服器，同意後就能用。

```bash
claude mcp list          # 應該看到 itri-event-ai
```

範例資料裡的日期寫成 `{{today+7}}`，載入時換成真的日期，所以範例不會過期。

## 接真的試算表

**不要改 `.mcp.json`**（它會被提交，而且是公開 repo）。用只存在你自己電腦上的設定：

```bash
claude mcp add itri-real --scope local \
  -e GOOGLE_SERVICE_ACCOUNT_EMAIL=… \
  -e GOOGLE_PRIVATE_KEY=… \
  -e GOOGLE_SPREADSHEET_ID=… \
  -- node tools/mcp-itri/server.mjs
```

（三個值跟 Vercel 上設的一樣，見 `SETUP.md`。**建議另外建一個「唯讀」的服務帳號**，只分享試算表的檢視權限；這樣即使金鑰外流，也寫不了資料。）

## 設計上刻意的取捨

| 取捨 | 為什麼 |
|---|---|
| **唯讀** | 「讓 Claude 查」跟「讓 Claude 改正式資料」是兩回事。要寫入的功能（發布、改活動）請走後台，有發布閘門與確認視窗保護。 |
| **永不回傳編輯碼** | events 表 K 欄是同仁編輯頁的密碼。任何工具、任何參數都不會吐出來（`test/test-mcp-itri.mjs` 固定檢查）。 |
| **預設不含記者姓名與媒體** | 問答紀錄是個資。要看得自己設 `MCP_ITRI_ALLOW_PII=1`。⚠️ 問題原文本身仍可能含個資：查真資料請只在自己的電腦上，不要把輸出貼到別處或存進 repo。 |
| **新聞稿預設不附** | 可能是還沒解禁的稿。 |
| **愛惜 Sheets 額度** | 額度是每分鐘 60 次、**跟正式站共用**（`lib/events-table.js`）。活動表走既有的 30 秒快取，問答紀錄這裡快取 60 秒；Claude 連問十題不會打十次 Sheets。 |
| **零依賴** | 跟專案其餘部分一樣不需要 `npm install`。stdio 傳輸就是「一行一則 JSON-RPC」。 |

## 怎麼新增工具

在 `server.mjs` 的 `TOOLS` 陣列加一項（`name`、`description`、`inputSchema`、`run`），並在 `test/test-mcp-itri.mjs` 補測試。三條守則：
1. 只讀。
2. 回傳前想一想：這裡面有沒有編輯碼、個資、未解禁稿件？
3. 讀資料用 `lib/events-table.js` 的快取，不要自己 `readRange('events!…')`。
