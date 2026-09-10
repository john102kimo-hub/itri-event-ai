# 使用說明影片怎麼重做（public/mia-guide.mp4）

記者在 LINE 打「使用說明」時，米亞會直接把這支 30 秒影片播在對話裡（見
`api/line.js` 的 `handleMetaIntent` `'help'` 分支）。畫面內容來自
`public/guide.html`，**改了那一頁就要重做影片**，不然兩邊會對不上。

整條流程都在這個資料夾裡，四步驟。

```bash
cd tools/guide-video

# ① 錄畫面（Playwright 開錄影模式跑一輪）
node rec.mjs                     # → vid/*.webm

# ② 口白（米亞的聲音，見 voice/README.md）
cd voice && python3 cute.py && cd ..   # → voice/cvo0.wav … voice/cvo5.wav

# ③ 背景音樂（自己合成，授權乾淨）
pip install numpy
python3 bgm.py                   # → bgm.wav

# ④ 剪接：切出 30 秒 → 混音 → 合成
#    指令見下面「④ 的完整指令」
```

## 三個一定會踩到的坑（都已經寫進腳本註解）

| 坑 | 症狀 | 解 |
| --- | --- | --- |
| viewport 開 720×1280 | 字級相對畫面縮成一半 | 版面是照 360 手機寬設計的，用 360×640 錄再放大 |
| `deviceScaleFactor: 2` ＋ `recordVideo: 720×1280` | 畫面只畫在**左上角 1/4**，其餘灰底 | viewport 與 recordVideo 尺寸要一致 |
| 起點靠猜 | 前段是空白的載入畫面 | **起點＝webm 總長 − 30.6**（結束時間固定是按下重播後 30.6 秒），跟瀏覽器啟動花多久無關 |

## ⚠️ 影片一定要有聲音軌

LINE 對「只有影像軌的 mp4」是**收下請求回 200、之後靜靜不顯示**，不會回報任何錯誤
（批次 47 就是這樣掉進去的，伺服器 log 乾乾淨淨）。所以就算不配口白，也要塞一條靜音
AAC。`test/test-guide-video.mjs` 會檢查 `mp4a` 盒子在不在。

## ⚠️ 口白只有一種聲音

米亞的聲音是 `voice/` 裡那一個，**以後任何要出聲的東西都用它**，不要再挑新的語音。
`vo.py`（edge-tts）是它之前的版本，聽起來像機器人念稿，留著只是備援，別再拿來出片。

## ⚠️ 口白每句要唸得完在 5 秒內

畫面是 6 格 × 5 秒。一句唸超過 5 秒，畫面換了口白還在講上一格，比沒有口白更糟。
`cute.py` 跑完會印出每句長度，超過 4.8 秒會直接標出來。這時候要把句子砍短（改
`LINES` 再回 Vidnoz 重念），不要只調語速——語速再快會變得不像人講話。

## 這個環境要多做一件事（只有備援的 `vo.py` 會用到）

對外 HTTPS 走 agent proxy，TLS 在那裡重新終結。`edge_tts` 讀的是 certifi 的 bundle、
不是 `SSL_CERT_FILE`，而且 aiohttp 預設不吃環境變數裡的 proxy——所以 `vo.py` 會自己把
`HTTPS_PROXY` 傳進 `Communicate(proxy=...)`。**絕對不要改成關掉 TLS 驗證**
（見 `/root/.ccr/README.md`）。`cute.py` 純本地跑，不碰網路。

## ④ 的完整指令

```bash
# 從 webm 切出對齊第 1 格的 30 秒，放大到 720×1280
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 vid/*.webm)
START=$(python3 -c "print(max(0,$DUR-30.6))")
ffmpeg -y -ss $START -i vid/*.webm -t 30 \
  -vf "scale=720:1280:flags=lanczos,fps=30,format=yuv420p" \
  -c:v libx264 -profile:v main -level 3.1 -preset slow -crf 25 \
  -movflags +faststart -an silent.mp4

# 混音：口白對齊每格起點，背景音樂用 sidechain 讓給口白
ffmpeg -y -i bgm.wav -i voice/cvo0.wav -i voice/cvo1.wav -i voice/cvo2.wav \
  -i voice/cvo3.wav -i voice/cvo4.wav -i voice/cvo5.wav \
  -filter_complex "\
[1:a]adelay=300|300,aresample=44100[a0];[2:a]adelay=5200|5200,aresample=44100[a1];\
[3:a]adelay=10200|10200,aresample=44100[a2];[4:a]adelay=15200|15200,aresample=44100[a3];\
[5:a]adelay=20200|20200,aresample=44100[a4];[6:a]adelay=25200|25200,aresample=44100[a5];\
[a0][a1][a2][a3][a4][a5]amix=inputs=6:normalize=0,apad[vo];\
[vo]volume=1.5,alimiter=limit=0.95,atrim=0:30[voL];\
[voL]asplit=2[voMix][voKey];[0:a]volume=0.34[bg];\
[bg][voKey]sidechaincompress=threshold=0.03:ratio=9:attack=8:release=420[bgDuck];\
[bgDuck][voMix]amix=inputs=2:normalize=0,alimiter=limit=0.97,aresample=44100[out]" \
  -map "[out]" -t 30 -c:a aac -b:a 96k -ar 44100 -ac 2 mia-audio.m4a

# 合成 ＋ 封面
ffmpeg -y -i silent.mp4 -i mia-audio.m4a -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a copy -movflags +faststart -shortest ../../public/mia-guide.mp4
ffmpeg -y -ss 1.5 -i ../../public/mia-guide.mp4 -frames:v 1 -q:v 3 ../../public/mia-guide-cover.jpg
```

## 只換聲音、畫面沒動的時候

不用重錄。直接從現在上線的那支把畫面軌抽出來，接上新的音軌就好——這樣畫面跟已經
在跑的版本一模一樣，不會因為重錄而多出肉眼看不到的差異：

```bash
ffmpeg -y -i ../../public/mia-guide.mp4 -map 0:v:0 -c copy -an silent.mp4
# 接著跑上面的混音與合成兩段（封面也不用重做，畫面沒變）
```

混完量一下整支的響度：

```bash
ffmpeg -v info -i mia-audio.m4a -af "loudnorm=I=-16:TP=-1.5:print_format=summary" -f null -
```

`Input Integrated` 落在 **−16 LUFS** 上下、`Input True Peak` 不超過 −1.5 dBTP 就對了。
太小聲手機外放聽不到，破表則會爆音。

做完跑一次 `npm test`——`test/test-guide-video.mjs` 會擋掉沒有聲音軌、沒有
faststart、封面不是 JPEG 這幾種會讓 LINE 靜靜不顯示的問題。
