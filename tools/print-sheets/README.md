# 現場印刷品（A4 報到立牌、新聞稿封面）

```
node tools/print-sheets/build.mjs                       # 預設那一場，輸出 assets/print/2027-trend-forum/
node tools/print-sheets/build.mjs --url "<QR 網址>" --title "活動名稱" --subtitle "副標" \
     --date "2026 年 10 月 28 日（三）" --short-date "10/28（三）" --contact "朱則瑋 0934267766" \
     --out assets/print/另一場
```

每張輸出 `.pdf`（印刷用，向量 QR、字型內嵌）、`.png`（預覽）、`.html`（來源，要微調版面改這個或改 `build.mjs`）。
需要 Chromium＋Playwright（雲端開發環境已內建）。

- **QR 網址**：活動網頁 `https://{網域}/event?id={活動代碼}`。掃了開的是網頁版 AI 問答，所以印刷品上的說明一律寫「AI 問答頁」、不提 LINE。要改成直接開 LINE 的 QR，把 `--url` 換成後台「LINE QR」彈窗的網址（`lib/line-link.js` 的 `lineBindUrl()`），步驟文字也要跟著改（`.steps`、`.how`）。
- **輸出不進 git**：`assets/print/` 在 `.gitignore`，PDF／PNG 印完或傳完就丟，要用再重跑。
- **工研院 logo**：`itrilogo.svg` 取自 https://www.itri.org.tw/images/itrilogo.svg 原檔，不要改色、不要拉伸。
- **印之前**：用手機掃一次螢幕上的 PNG 確認進到對的活動（印刷前一定要實掃，CLAUDE.md 第 4 條同一個道理：「產生成功」不等於「記者掃得到」）。
- 米亞頭像用 `public/mia-avatar.png`。
