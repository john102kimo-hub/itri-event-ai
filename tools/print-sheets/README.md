# 現場印刷品（A4 報到立牌、新聞稿封面）

```
node tools/print-sheets/build.mjs                       # 預設那一場，輸出 assets/print/2027-trend-forum/
node tools/print-sheets/build.mjs --url "<QR 網址>" --title "活動名稱" --subtitle "副標" \
     --date "2026 年 10 月 28 日（三）" --short-date "10/28（三）" --contact "朱則瑋 0934267766" \
     --out assets/print/另一場
```

每張輸出 `.pdf`（印刷用，向量 QR、字型內嵌）、`.png`（預覽）、`.html`（來源，要微調版面改這個或改 `build.mjs`）。
需要 Chromium＋Playwright（雲端開發環境已內建）。

- **QR 網址**：`https://line.me/R/oaMessage/{LINE_BASIC_ID}/?%23{活動代碼}`（`lib/line-link.js` 的 `lineBindUrl()`），後台「LINE QR」彈窗給的網址直接貼進 `--url`。記者掃了打開米亞、輸入框已帶好「#活動代碼」，按傳送就接上這一場。
- **工研院 logo**：`itrilogo.svg` 取自 https://www.itri.org.tw/images/itrilogo.svg 原檔，不要改色、不要拉伸。
- **印之前**：用手機掃一次螢幕上的 PNG 確認進到對的活動（印刷前一定要實掃，CLAUDE.md 第 4 條同一個道理：「產生成功」不等於「記者掃得到」）。
- 米亞頭像用 `public/mia-avatar.png`。
