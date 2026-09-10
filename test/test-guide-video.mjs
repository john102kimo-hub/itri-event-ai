// 使用說明影片的檔案本身要合格（批次 47）。
//
// 回報：按「使用說明」只出現文字，影片沒跳出來。查正式站的 runtime log——**沒有任何
// 錯誤**：LINE 收下請求回了 200，之後才自己去抓媒體檔，抓失敗它不會回頭通知我們。
// 所以這個洞在伺服器端完全看不見，只有使用者看得到。
//
// 根因：那支 MP4 只有影像軌、沒有聲音軌（錄螢幕本來就沒有聲音，當時用 -an 直接不做
// 音訊）。一般播放器對「沒有聲音軌的 mp4」接受度不一，LINE 就是不吃。修法是補一條
// 靜音的 AAC 軌，讓檔案長得跟手機錄出來的影片一樣。
//
// ⚠️ 這支測試刻意不依賴 ffprobe（CI 不一定有）：直接在檔案裡找 MP4 的 sample entry
// 盒子名稱。`avc1` 代表 H.264 影像軌、`mp4a` 代表 AAC 聲音軌——兩個都在，才是完整的
// 一支影片。
import { readFileSync, existsSync, statSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

const MP4 = new URL('../public/mia-guide.mp4', import.meta.url);
const COVER = new URL('../public/mia-guide-cover.jpg', import.meta.url);

check('影片檔存在（HELP_TEXT 會叫 LINE 去抓它）', existsSync(MP4));
check('封面檔存在', existsSync(COVER));

if (existsSync(MP4)) {
  const buf = readFileSync(MP4);
  const head = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024)).toString('latin1');

  check('是 MP4（有 ftyp 盒子）', head.includes('ftyp'), head.slice(0, 32));
  check('有 H.264 影像軌（avc1）', head.includes('avc1'));
  // ⚠️ 這一條就是回報的那個 bug。沒有聲音軌時 LINE 收下請求回 200，之後靜靜不顯示。
  check('⚠️ 有聲音軌（mp4a）——沒有的話 LINE 收下了也不會顯示，而且不會報錯',
    head.includes('mp4a'), '只有影像軌的 mp4 正是回報「影片沒跳出來」的原因');
  // moov 要在檔案前面，播放器才不用整支下載完才能開始播
  const moov = head.indexOf('moov'), mdat = head.indexOf('mdat');
  check('moov 在 mdat 前面（faststart，邊載邊播）', moov !== -1 && (mdat === -1 || moov < mdat),
    `moov=${moov} mdat=${mdat}`);

  const mb = statSync(MP4).size / 1024 / 1024;
  check(`檔案大小在 LINE 的 200 MB 上限內（目前 ${mb.toFixed(2)} MB）`, mb < 200);
  check('檔案不是空的／不是壞的（至少 100 KB）', mb > 0.1, `${mb.toFixed(3)} MB`);
}

if (existsSync(COVER)) {
  const cover = readFileSync(COVER);
  check('封面是 JPEG（LINE 只收 jpg／png）', cover[0] === 0xFF && cover[1] === 0xD8, cover.subarray(0, 4).toString('hex'));
  check('封面在 1 MB 內', statSync(COVER).size < 1024 * 1024, `${(statSync(COVER).size / 1024).toFixed(0)} KB`);
}

// ── 米亞的聲音（批次 50）─────────────────────────────────────────────
// 朱朱要的不只是這一支影片好聽，是「以後都用這個聲音」。那個聲音沒辦法在這裡合成
// （是她在 Vidnoz 上挑的），所以參考檔本身就是資產——刪掉就再也回不去同一個聲音了。
// 這幾條擋的是「有人整理 tools/ 的時候順手清掉」。
const VOICE_REF = new URL('../tools/guide-video/voice/mia-voice-ref.wav', import.meta.url);
const VOICE_RECIPE = new URL('../tools/guide-video/voice/cute.py', import.meta.url);

check('⚠️ 米亞的原始聲音檔還在（刪了就回不去同一個聲音）', existsSync(VOICE_REF),
  'tools/guide-video/voice/mia-voice-ref.wav');
check('聲音的加工配方還在', existsSync(VOICE_RECIPE));
if (existsSync(VOICE_REF)) {
  const wav = readFileSync(VOICE_REF).subarray(0, 12).toString('latin1');
  check('聲音檔是 WAV（RIFF/WAVE）', wav.startsWith('RIFF') && wav.includes('WAVE'), wav);
  check('聲音檔不是空的（至少 100 KB）', statSync(VOICE_REF).size > 100 * 1024,
    `${(statSync(VOICE_REF).size / 1024).toFixed(0)} KB`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 使用說明影片檔測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
