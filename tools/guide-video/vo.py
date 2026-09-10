# 口白：每一格一句，各自產一個檔，之後照場次起點對齊放進去。
# 一句一檔（而不是整段一次念完）是刻意的：整段念完的長度不可能剛好落在每 5 秒的
# 切點上，畫面換了口白還在講上一格，比沒有口白更糟。
import asyncio, os, edge_tts

# ⚠️ 這個環境的對外 HTTPS 走 agent proxy，TLS 在那裡重新終結，所以必須信任
# /root/.ccr/ca-bundle.crt。edge_tts 讀的是 certifi 的 bundle、不是 SSL_CERT_FILE，
# 而且 aiohttp 預設不吃環境變數裡的 proxy——兩件都要自己補上。
# （照 /root/.ccr/README.md 的做法：把 CA 指過去，絕不關掉驗證。）
PROXY = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')

VOICE = 'zh-TW-HsiaoYuNeural'   # 三個台灣語音裡，這個標的是「Taiwanese Mandarin」
RATE = '+15%'                     # 稍微快一點，30 秒才塞得下
PITCH = '+12Hz'                  # 提高一點 → 比較可愛、有精神

# ⚠️ 每一句都要唸得完在 5 秒內（一格的長度），不然畫面換了口白還在講上一格。
# 第一版每句 5.5～7.7 秒、總長 37.9 秒，塞不下——句子砍短、語速加到 +15%。
LINES = [
    '嗨！我是米亞，工研院的公關小特派～',
    '記者會的事，想問什麼直接打就好。',
    '這場沒有的，我會去別場跟官網幫你找。',
    '在群組裡，叫我一聲米亞就可以。',
    '每則回覆下面都有小按鈕，隨時都能按。',
    '想安排採訪也問我，找米亞就對了！',
]

async def main():
    for i, text in enumerate(LINES):
        out = f'vo{i}.mp3'
        await edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH, proxy=PROXY).save(out)
        print(f'{i+1}. {out}  「{text}」')

asyncio.run(main())
