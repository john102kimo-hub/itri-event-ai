# 開發護欄（批次 186）

這個專案的長期原則是 CLAUDE.md 第 2 條：**「絕對不能發生」的事，擋在程式出口，不要寫在 prompt 裡**。原本只管產品（米亞送給記者的每一段字）。這一批把同一條原則用到**開發過程**：

| 做什麼 | 位置 | 一句話 |
|---|---|---|
| **Hooks** | `.claude/settings.json`、`.claude/hooks/` | 簡體字、金鑰、真實資料、沒跑測試，不靠 Claude（或人）記得，由程式擋 |
| **Skills** | `.claude/skills/` | 把重複的流程寫成固定步驟：寫批次紀錄、上線前盤點、新增活動檢查 |
| **MCP 伺服器** | `tools/mcp-itri/`、`.mcp.json` | Claude 直接查活動與問答（唯讀），不用手動貼資料 |
| **評測** | `tools/eval/` | 改 prompt／換模型前後各跑一次，比較有沒有退步 |

## 1. Hooks

在 Claude Code 裡工作時自動執行（設定檔 `.claude/settings.json`）：

- **改完檔案**（`after-edit.mjs`）：`.js`／`.mjs` 語法檢查；**這次新寫進去的字**有簡體字就請 Claude 改。
- **要 `git commit` 之前**（`before-commit.mjs`）：
  1. 不該進 repo 的檔案（`.env`、`*.local.json`、後台匯出的 `*-qa-日期.csv`、私鑰）→ 擋
  2. 新增的行有疑似金鑰（`sk-ant-…`、`AKIA…`、私鑰標頭）→ 擋
  3. 新增的行有簡體字 → 擋
  4. 動到 `api／lib／public／test／tools` 或設定 → 先跑 `node test/run-all.mjs`（約 1.5 分鐘），沒全過不給提交

**設計：只檢查「這次新寫的字」，不掃整個檔案。** 實測現有 32 個檔案本來就含簡體字（測試資料、偵測用的樣式、批次紀錄的舉例），整檔掃會一直誤報，誤報多了大家就學會忽略。

**刻意要寫簡體字時**（偵測樣式、舉例）：在同一行加上 `zhtw-ok`。`test/`、`lib/zh-tw.js`、hook 自己、評測的假答案本來就豁免。

**臨時跳過測試**（只跳測試，其餘照擋）：`SKIP_COMMIT_TESTS=1 git commit -m …`。

**hook 自己壞掉**：一律放行並在 stderr 留一行，不擋工作；只有「確定違規」才擋。

**完全關掉**：刪掉 `.claude/settings.json` 的 `hooks` 區塊，或在 `.claude/settings.local.json`（不進 repo）覆蓋。

## 2. Skills

在 Claude Code 輸入 `/batch-log`、`/pre-release-audit`、`/new-event-checklist`，或直接說「寫批次紀錄」「上線前盤點」「這場能發布嗎」。

| Skill | 做什麼 | 機器能算的部分 |
|---|---|---|
| `batch-log` | 依 CLAUDE.md 第 5 條寫批次紀錄 | `next-batch.mjs` 算下一個編號、判斷要不要開新檔、補索引 |
| `pre-release-audit` | 上線前盤點 | `audit.mjs` 查 Function 數、環境變數有沒有寫進文件、敏感檔、批次紀錄；`--tests` 跑 CI 三輪 |
| `new-event-checklist` | 活動填夠了嗎、能發布嗎、有什麼後果要先講 | 有接 MCP 就直接查（`event_checklist`） |

原則：**機器能算的交給程式，需要人判斷的才問人。**

## 3. MCP 伺服器

見 [tools/mcp-itri/README.md](../tools/mcp-itri/README.md)。要點：**唯讀**、**永不回傳編輯碼**、**預設不含記者個資**、**走既有快取愛惜 Sheets 額度**。專案根目錄的 `.mcp.json` 預設只指向虛構的範例資料；接真的試算表用 `claude mcp add --scope local`，不要改 `.mcp.json`。

## 4. 評測

見 [tools/eval/README.md](../tools/eval/README.md)。兩層評分：**硬性**（使用者實際看到的）與**軟性**（模型原始輸出）。評分器本身有測試——故意寫壞的答案必須被抓到，否則評測沒有價值。

## 刻意沒做

- **沒有讓 hook 自動修檔**：只擋、只報，改不改由人與 Claude 決定。
- **沒有用第二個模型當評分裁判**：同一個答案要永遠得到同一個分數。
- **MCP 沒有寫入工具**：發布、改活動走後台，那裡有發布閘門與確認視窗。
- **沒有動任何正式站程式碼**（`api/`、`lib/` 一個字都沒改）。

## 驗證

`test/test-hooks.mjs`（16 項）、`test/test-mcp-itri.mjs`（15 項）、`test/test-eval-harness.mjs`（23 項），都在 `npm test` 裡、不需要金鑰。評分器另外做過破壞性驗證：把檢查弄壞，對應的測試會變紅。
