# 米亞的聲音：把 Vidnoz 匯出的整段口白切成六句，逐句加工成「可愛活潑」版本。
# 這支腳本就是米亞聲音的配方——**以後任何要出聲的東西都走這裡**，不要另外挑語音。
#
# 使用者的原話：「還是有點AI感覺 幫我改得可愛活潑一點」。
# AI 感來自三件事，三件都在這裡處理：
#   ① 音色偏成人、偏平 → rubberband 往上移調（共振峰跟著移＝聽起來像個子小一點的人）
#   ② 16kHz 取樣、8kHz 以上全空 → 聽起來像講電話。aexciter 把高頻諧波補回來
#   ③ 每一句的音高、語速一模一樣＝在念稿 → 逐句給不同的移調與語速，最後一句最高最快
#
# ⚠️ 這裡刻意「不用」單次 loudnorm。loudnorm 是動態的，遇到句子頭尾那半秒的靜音
# 會把底噪一路推上來——第一版六句的尾巴全都是一模一樣的 -4.2 dB，那不是聲音，
# 是被放大的嘶聲。要對齊音量就用量完再套的固定增益（volume），不要用動態的。
import subprocess, os, re

SRC = os.environ.get('MIA_VOICE', 'mia-voice-ref.wav')

# 參考檔裡念的就是這六句（順序一樣）。要改台詞，就帶著新台詞回 Vidnoz 用同一個
# 語音再匯出一次，六句之間停 1 秒左右，然後把 SEG 重新量一遍（見 README）。
LINES = [
    '嗨！我是米亞，工研院的公關小特派～',
    '記者會的事，想問什麼直接打就好。',
    '這場沒有的，我會去別場跟官網幫你找。',
    '在群組裡，叫我一聲米亞就可以。',
    '每則回覆下面都有小按鈕，隨時都能按。',
    '想安排採訪也問我，找米亞就對了！',
]

# 參考檔（mia-voice-ref.wav）上量到的六段，句間空約 0.95 秒。換新的匯出檔時
# 不用手改這一份——下面的 detect_segments() 會自己重量一次，這裡只當對照。
REF_SEG = [
    (0.000,   3.4745),
    (4.44975, 8.19525),
    (9.18013, 13.0646),
    (14.0075, 17.3908),
    (18.3523, 22.3102),
    (23.2703, 26.5734),
]

def detect_segments(path, want):
    """用靜音偵測把整段切成一句一段。

    ⚠️ 一定要檢查段數對不對再往下做。段數不對代表匯出的檔跟預期不一樣（有人講太快
    沒停、或中間多了一段呼吸），這時候硬切下去會把兩句黏成一句、對齊全跑掉——
    寧可在這裡停下來重錄，也不要產出一支口白對不上畫面的影片。
    """
    out = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', path, '-af', 'silencedetect=noise=-40dB:d=0.35',
         '-f', 'null', '-'], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', out)]
    ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', out)]
    # 語音段＝靜音段之間。開頭若不是靜音，第一句就從 0 開始。
    heads = [0.0] + ends
    tails = starts + [probe_duration(path)]
    seg = [(a, b) for a, b in zip(heads, tails) if b - a > 0.3]
    if len(seg) != want:
        raise SystemExit(
            f'切出 {len(seg)} 段，但台詞有 {want} 句：{[(round(a,2), round(b,2)) for a, b in seg]}\n'
            f'請確認匯出的檔每句之間有停滿 1 秒左右，再跑一次。')
    return seg
# 逐句的（半音, 語速）。第 1 句打招呼、第 6 句收尾，這兩句最亮最快。
TONE = [(2.2, 1.03), (1.7, 1.01), (1.9, 1.02), (1.7, 1.00), (2.0, 1.03), (2.4, 1.05)]

TARGET_MEAN_DB = -20.0   # 六句對齊到同一個平均音量

def probe_duration(path):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                 '-of', 'csv=p=0', path], capture_output=True, text=True).stdout)

def measure(path):
    out = subprocess.run(['ffmpeg', '-v', 'info', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    mean = float(re.findall(r'mean_volume: (-?[\d.]+) dB', out)[-1])
    peak = float(re.findall(r'max_volume: (-?[\d.]+) dB', out)[-1])
    return mean, peak

SEG = detect_segments(SRC, len(LINES))

for i, ((a, b), (semi, tempo)) in enumerate(zip(SEG, TONE)):
    ss = max(0.0, a - 0.06)
    dur = b - ss + 0.08
    pitch = 2 ** (semi / 12)
    # 第一階段：音色加工。agate 壓住句子中間換氣的底噪（aexciter 會把嘶聲一起提亮）。
    # ⚠️ aresample 一定要排在 aexciter 前面。原檔是 16kHz（Nyquist 只有 8kHz），
    # 直接叫 aexciter 去合成 15kHz 的諧波會整段折返成鋸齒雜訊——症狀是峰值卡在
    # 0.0 dB、直方圖全擠在同一格，聽起來像方波。先升到 44.1k 再加高頻就正常了。
    stage1 = (
        f'aresample=44100:resampler=soxr,'
        f'highpass=f=90,'
        f'agate=threshold=0.008:ratio=4:attack=6:release=200:range=0.05,'
        f'rubberband=pitch={pitch:.4f}:tempo={tempo}:pitchq=quality,'
        f'aexciter=amount=3:drive=6:blend=0:freq=5500:ceil=16000,'
        f'treble=g=2.5:f=4200:width_type=h:width=3000,'
        f'acompressor=threshold=0.12:ratio=3:attack=12:release=180:makeup=1.7,'
        f'aecho=0.92:0.9:14:0.035'
    )
    tmp = f'_s1_{i}.wav'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{ss:.4f}', '-t', f'{dur:.4f}',
                    '-i', SRC, '-af', stage1, '-ar', '44100', '-ac', '1', tmp], check=True)

    # 第二階段：量完再套固定增益，並在頭尾各淡入淡出，把邊緣的雜訊徹底切掉。
    d = probe_duration(tmp)
    mean, _ = measure(tmp)
    gain = TARGET_MEAN_DB - mean
    stage2 = (f'volume={gain:.2f}dB,'
              f'afade=t=in:st=0:d=0.05,'
              f'afade=t=out:st={max(0, d - 0.09):.3f}:d=0.09,'
              f'alimiter=limit=0.95')
    out = f'cvo{i}.wav'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', tmp, '-af', stage2,
                    '-ar', '44100', '-ac', '1', out], check=True)
    os.remove(tmp)

    fd = probe_duration(out)
    fmean, fpeak = measure(out)
    warn = '  ← 超過 4.8 秒！' if fd > 4.8 else ''
    print(f'{i+1}. {out}  {fd:.2f}s  +{semi}半音/x{tempo}  '
          f'增益 {gain:+.1f}dB → 平均 {fmean:.1f} / 峰值 {fpeak:.1f} dB{warn}')
