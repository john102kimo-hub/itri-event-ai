# 背景音樂：自己合成，不用任何現成音軌——授權乾淨，而且長度可以剛好切在 30 秒。
#
# 走向配合米亞的調性：輕快、可愛、不搶戲。用最基本的 I–V–vi–IV（C–G–Am–F），
# 音色做成音樂盒／馬林巴那種「打一下就衰減」的聲音（正弦波＋快速指數衰減＋一點
# 二次諧波），比純正弦悅耳得多，也不會像電子音那樣刺耳。
import numpy as np, wave, struct

SR = 44100
DUR = 30.0
BPM = 104
beat = 60.0 / BPM          # 一拍
bar = beat * 4

def note(freq, dur, amp=0.25, decay=7.0):
    """一顆音：基頻＋二次諧波，指數衰減。"""
    n = int(SR * max(dur, 0.02))   # 尾端剩不到一個音的長度時會算出 0，夾一個下限
    t = np.arange(n) / SR
    env = np.exp(-decay * t)
    # 前 5ms 淡入，避免每顆音開頭的爆音（click）
    atk = min(int(SR * 0.005), n)
    if atk > 0:
        env[:atk] *= np.linspace(0, 1, atk)
    wave_ = (np.sin(2*np.pi*freq*t) + 0.32*np.sin(4*np.pi*freq*t) + 0.12*np.sin(6*np.pi*freq*t))
    return amp * env * wave_

def pad(freqs, dur, amp=0.05):
    """底下墊的和聲，很輕，只是讓琶音不會孤零零的。"""
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.minimum(1.0, t / 0.4) * np.minimum(1.0, (dur - t) / 0.4)
    out = np.zeros(n)
    for f in freqs:
        out += np.sin(2*np.pi*f*t) + 0.2*np.sin(4*np.pi*f*t)
    return amp * env * out / len(freqs)

N = {'C4':261.63,'D4':293.66,'E4':329.63,'F4':349.23,'G4':392.00,'A4':440.00,'B4':493.88,
     'C5':523.25,'D5':587.33,'E5':659.25,'F5':698.46,'G5':783.99,'A5':880.00,
     'C3':130.81,'G3':196.00,'A3':220.00,'F3':174.61}

# 一組和弦兩小節；C – G – Am – F 循環
CHORDS = [
    (['C3','C4','E4','G4'], ['C5','E5','G5','E5','C5','G4','E4','G4']),
    (['G3','B4','D5','G4'], ['D5','G5','B4','G5','D5','B4','G4','B4']),
    (['A3','A4','C5','E5'], ['E5','A5','C5','A5','E5','C5','A4','C5']),
    (['F3','F4','A4','C5'], ['C5','F5','A4','F5','C5','A4','F4','A4']),
]

total = np.zeros(int(SR * DUR))
pos = 0.0
ci = 0
while pos < DUR:
    chord, arp = CHORDS[ci % len(CHORDS)]
    seg = bar * 2
    # 和聲墊
    p = pad([N[c] for c in chord], min(seg, DUR - pos))
    s = int(pos * SR)
    total[s:s+len(p)] += p[:len(total)-s]
    # 琶音：兩小節八顆八分音符 × 2 輪
    step = seg / len(arp)
    for k, nm in enumerate(arp):
        at = pos + k * step
        if at >= DUR: break
        nt = note(N[nm], min(step * 2.2, DUR - at), amp=0.22 if k % 2 == 0 else 0.15)
        s2 = int(at * SR)
        total[s2:s2+len(nt)] += nt[:len(total)-s2]
    pos += seg
    ci += 1

# 整體淡入淡出，接在影片頭尾才不會突然出現／突然斷掉
fi, fo = int(SR*1.2), int(SR*2.0)
total[:fi] *= np.linspace(0, 1, fi)
total[-fo:] *= np.linspace(1, 0, fo)

total = total / max(1e-9, np.abs(total).max()) * 0.72   # 正規化，留 headroom
stereo = np.stack([total, np.roll(total, int(SR*0.012))], axis=1)  # 右聲道微延遲＝一點空間感

with wave.open('bgm.wav', 'w') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(stereo, -1, 1) * 32767).astype('<i2').tobytes())
print('bgm.wav 完成', round(len(total)/SR, 2), '秒')
