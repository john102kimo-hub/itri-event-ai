// 純函式測試：媒體訓練的「語音作答」。不碰網路、不碰麥克風——
// `node test/training-voice.test.mjs` 直接跑。
//
// 這份檔案存在的理由，跟 test-zhtw.mjs、test-guide-video.mjs 是同一個：語音這條路
// 上有幾件「錯了不會噴錯誤、只會安靜地把錯的東西送到主管眼前」的事。
//
//   ① STT 吐簡體字。Whisper 一族對中文預設就是簡體，給 language:'zh' 也一樣。
//      這不是模型偶爾沒照做，是每一次都這樣（CLAUDE.md 第 1、2 條）。
//   ② 靜音幻覺。Whisper 收到無聲時會吐訓練資料裡的 YouTube 字幕殘留
//      （「請不吝點贊 訂閱」），然後那句話會被當成主管的回答拿去評分。
//   ③ 前端的 element id 打錯。JS 照樣載入、照樣沒有紅字，只是按鈕按了沒反應——
//      跟「LINE 收下沒有聲音軌的 mp4 回 200 卻不顯示」同一種失敗：不會報錯的錯。
import fs from 'fs';
import {
  scrubTranscript, decodeAudioPayload, describeSpeech, pickTranscribeEngine,
  buildTranscriptionHint, buildEvaluatePrompt, buildReporterPrompt,
  formatSessionNote, parseVoiceCount, MAX_AUDIO_BASE64,
  speechZone, TARGET_MIN_SEC, TARGET_MAX_SEC, TOO_LONG_SEC,
} from '../api/training.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

console.log('[1] scrubTranscript — 逐字稿出口（簡轉繁 + 靜音幻覺）');
{
  ok(scrubTranscript('我们这次的研发成果') === '我們這次的研發成果',
    '簡體逐字稿強制轉繁體（Whisper 中文預設就是簡體，不是偶發）');
  ok(scrubTranscript('工研院投入三十億元。') === '工研院投入三十億元。', '本來就是繁體的不會被改壞');

  ok(scrubTranscript('請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目') === '',
    '整段都是 Whisper 靜音幻覺 → 清成空字串，呼叫端才能提示重錄');
  ok(scrubTranscript('字幕由Amara.org社群提供') === '', 'Amara 字幕殘留清掉');
  ok(scrubTranscript('请不吝点赞 订阅') === '', '簡體版的幻覺句也擋得住（先轉繁再比對）');
  ok(scrubTranscript('我們投入三十億元，请不吝点赞') === '我們投入三十億元',
    '真的講過的話要留著，只挖掉尾巴的幻覺（連同挖完剩下的孤逗號）');

  ok(scrubTranscript('。。。') === '', '只剩標點 → 視為沒有內容');
  ok(scrubTranscript('') === '' && scrubTranscript(null) === '', '空字串／null 不炸掉');
  ok(scrubTranscript('a'.repeat(9000)).length === 5000, '超長逐字稿截斷在 5000 字');

  // ⚠️ 這條是「不准誤刪」的防線：主管真的講了「我們會持續訂閱這份產業報告」，
  // 挖掉就等於 AI 在評一段他沒講過的話，比留一句雜訊嚴重得多。
  const real = '我們會持續訂閱這份產業報告，作為技術布局的依據。';
  ok(scrubTranscript(real) === real, '正常句子裡的「訂閱」不會被當成幻覺誤刪');
}

console.log('\n[2] decodeAudioPayload — 收音檔');
{
  const wav = Buffer.alloc(2048, 7).toString('base64');
  const r1 = decodeAudioPayload({ audio: wav, mime: 'audio/webm;codecs=opus' });
  ok(r1.ok && r1.mime === 'audio/webm' && r1.ext === 'webm',
    'MediaRecorder 給的 mime 帶 codecs 參數，要先切掉再比對');

  const r2 = decodeAudioPayload({ audio: `data:audio/mp4;base64,${wav}` });
  ok(r2.ok && r2.mime === 'audio/mp4' && r2.ext === 'mp4', 'data URL 形式（Safari／iOS 走這條）');

  ok(decodeAudioPayload({ audio: '' }).status === 400, '沒有音檔 → 400');
  ok(decodeAudioPayload({ audio: Buffer.alloc(100).toString('base64'), mime: 'audio/webm' }).status === 400,
    '小到不可能是音檔 → 400（麥克風沒錄到）');
  ok(decodeAudioPayload({ audio: wav, mime: 'video/mp4' }).status === 415, '不支援的格式 → 415');
  ok(decodeAudioPayload({ audio: 'A'.repeat(MAX_AUDIO_BASE64 + 10), mime: 'audio/webm' }).status === 413,
    '超過 Vercel 請求上限 → 413，而不是讓平台丟一個看不懂的錯');
}

console.log('\n[3] describeSpeech — 講了多久、多少字、多快');
{
  const d = describeSpeech('工研院這次投入三十億元，預計三年內量產。', 10);
  ok(d.chars === 18, '字數不算標點與空白（中文一字一個字元）');
  ok(d.seconds === 10 && d.cpm === 108, '秒數與語速（字／分）');
  ok(d.line.includes('10 秒') && d.line.includes('18 字'), '給評分看的描述帶得出秒數與字數');

  ok(describeSpeech('一'.repeat(240), 60).pace === '自然', '每分鐘 240 字 → 自然（中文口說的正常節奏）');
  ok(describeSpeech('一'.repeat(100), 60).pace.startsWith('偏慢'), '每分鐘 100 字 → 偏慢');
  ok(describeSpeech('一'.repeat(400), 60).pace.startsWith('偏快'), '每分鐘 400 字 → 偏快');

  ok(describeSpeech('嗯', 1).cpm === null, '不到 3 秒不算語速（樣本太短，算出來沒有意義）');
  ok(describeSpeech('測試', undefined).seconds === 0, '沒有秒數也不炸掉');
}

console.log('\n[3b] speechZone — 30 秒到 1 分鐘講完重點（本場的主要訓練目標）');
{
  ok(TARGET_MIN_SEC === 30 && TARGET_MAX_SEC === 60, '目標區間就是主管要求的 30 秒–1 分鐘');
  ok(speechZone(29) === 'short', '29 秒 → 比目標短');
  ok(speechZone(30) === 'target' && speechZone(60) === 'target', '30 與 60 秒都算達標（邊界含在內）');
  ok(speechZone(61) === 'long', '61 秒 → 超過目標');
  ok(speechZone(TOO_LONG_SEC) === 'long' && speechZone(TOO_LONG_SEC + 1) === 'toolong',
    `${TOO_LONG_SEC} 秒是「偏長」與「太長」的分界`);
  ok(speechZone(0) === '', '沒有秒數（打字作答）→ 不分區');

  const d45 = describeSpeech('一'.repeat(150), 45);
  ok(d45.zone === 'target' && d45.line.includes('落在目標'), '達標的那一題，描述裡講得出來');
  const d100 = describeSpeech('一'.repeat(350), 100);
  ok(d100.zone === 'toolong' && d100.line.includes('斷章取義'),
    '講太久要講明後果——「挑哪一段的人不是他」才是真正的風險');
  ok(describeSpeech('一'.repeat(40), 15).line.includes('若重點已經完整，這是好事'),
    '講得短不等於講得差，描述不能寫成扣分理由');
}

console.log('\n[4] pickTranscribeEngine — 哪一家來轉寫');
{
  ok(pickTranscribeEngine('audio/webm', { OPENAI_API_KEY: 'k' }) === 'openai', '有 OpenAI 就用 OpenAI（格式全吃）');
  ok(pickTranscribeEngine('audio/webm', { GEMINI_API_KEY: 'k' }) === null,
    'Gemini 吃不下 webm——Chrome 的預設格式就是 webm，不能硬送過去');
  ok(pickTranscribeEngine('audio/mp4', { GEMINI_API_KEY: 'k' }) === 'gemini', 'Safari 的 mp4 可以讓 Gemini 頂');
  ok(pickTranscribeEngine('audio/webm', {}) === null, '兩把鑰匙都沒有 → null，前端改用瀏覽器辨識');
}

console.log('\n[5] buildTranscriptionHint — 專有名詞提示');
{
  const hint = buildTranscriptionHint({ name: '淨零永續技術發表會', knowledge_base: '碳捕捉'.repeat(400) });
  ok(hint.includes('淨零永續技術發表會'), '活動名稱要進提示（單位名、計畫名最容易被聽錯）');
  ok(hint.length <= 500, '提示長度有上限，不會把整份知識庫灌進去');
  ok(buildTranscriptionHint(null).includes('工研院'), '沒有活動資料也給得出可用的提示');
}

console.log('\n[6] buildEvaluatePrompt — 口說要用口說的標準評');
{
  const base = { eventName: '測試記者會', knowledgeBase: '背景資料' };
  const written = buildEvaluatePrompt(base);
  const spoken = buildEvaluatePrompt({ ...base, speech: describeSpeech('一'.repeat(30), 15) });

  // ⚠️ 前端靠這兩行分隔線切「評分」與「下一題」。語音模式多加了東西，最容易
  // 不小心改壞的就是它——改壞了不會報錯，只會讓訓練在第二題安靜地結束。
  for (const [name, p] of [['書面', written], ['語音', spoken]]) {
    ok(p.includes('---評分---') && p.includes('---下一題---'), `${name}模式：兩條分隔線都在`);
    ok(p.includes('整體分數：X / 10'), `${name}模式：分數格式沒被動到`);
  }
  // ⚠️ 真正要驗的是「模型照這份 prompt 產出的回覆，前端切不切得開」，不是 prompt
  // 字串本身——prompt 裡那句「分隔線請一字不差照抄（『---評分---』『---下一題---』）」
  // 本身就長得像分隔線，拿 prompt 去對只會量到這件事。所以這裡照格式模擬一則回覆，
  // 用 training.html 裡那條 regex 原封不動切一次。
  const splitRe = /[-—–─]{2,}[^\n]*下一[^\n]*[-—–─]{2,}/;
  const fakeReply = [
    '---評分---',
    '整體分數：7 / 10',
    '',
    '優點：',
    '• 有講到具體數字',
    '',
    '改進建議：',
    '• 前面鋪陳太久，記者聽到第 30 秒才聽到重點',
    '',
    '建議更好的答法：',
    '（示範）',
    '',
    '可直接引用的一句：',
    '我們三年內要把成本砍一半。',
    '',
    '---下一題---',
    '您說三年，這個時程的根據是什麼？',
  ].join('\n');
  const parts = fakeReply.split(splitRe);
  ok(parts.length === 2, '語音模式新增的「可直接引用的一句」不會讓前端多切一刀');
  ok(parts[0].includes('整體分數：7 / 10') && parts[0].includes('可直接引用的一句'),
    '評分段落完整留在前半，新欄位不會掉到下一題那邊');
  ok(parts[1].trim() === '您說三年，這個時程的根據是什麼？', '下一題切得乾淨');
  ok(Number(parts[0].match(/整體分數[：:]\s*(\d+(?:\.\d+)?)\s*\/\s*10/)[1]) === 7,
    '前端抓分數的 regex 在語音模式的回覆上照樣抓得到');

  ok(!written.includes('可引用性'), '書面模式不談口說的評分項目');
  ok(spoken.includes('可引用性') && spoken.includes('贅詞'), '語音模式加入可引用性與贅詞');
  ok(spoken.includes('8–15 秒'), '語音模式給出電視新聞受訪片段的實際長度基準');
  ok(spoken.includes('15 秒') && spoken.includes('30 字'), '把這一題實際講了多久、多少字交給訓練師');
  ok(spoken.includes('不因此扣分') || spoken.includes('一律不因此扣分'),
    '講明「同音錯字是機器聽錯、不是他講錯」——不寫清楚，主管會被扣一段莫名其妙的分');
  ok(spoken.includes('可直接引用的一句'), '語音模式要求挑出一句可以被記者直接剪出來用的話');

  // ── 主管要求的 30 秒–1 分鐘，要真的變成一個評分項，不是只寫在說明卡片上 ──
  ok(spoken.includes(`${TARGET_MIN_SEC} 秒到 ${TARGET_MAX_SEC} 秒內把重點講完`),
    '把「30 秒到 1 分鐘講完重點」寫成硬性要求');
  ok(spoken.includes('每一題都要講到'), '要求每一題的評語都要交代長度，不能有幾題漏掉');
  ok(spoken.includes('本題長度：') && spoken.includes(`目標 ${TARGET_MIN_SEC}–${TARGET_MAX_SEC} 秒`),
    '回覆格式裡有固定的一行講評長度，主管每題都看得到自己落在哪');
  ok(spoken.includes(`能在 ${TARGET_MAX_SEC} 秒內講完的版本`),
    '超時的時候，「更好的答法」要給一個真的講得完的版本，不是只說「請講短一點」');
  ok(spoken.includes('不要建議他把話拉長'),
    '⚠️ 要的是「60 秒內講完」不是「講滿 60 秒」——沒講清楚，訓練師會叫講太短的人多講一點');
  ok(spoken.includes('不要因為「講太短」扣分'), '短而完整是好答案，不該被扣分');
  ok(!written.includes('把重點講完'), '打字作答沒有秒數，不套這套時間標準');
}

console.log('\n[7] buildReporterPrompt — 語音場次的問題要能用聽的');
{
  const base = { eventName: '測試記者會', knowledgeBase: '背景資料' };
  const read = buildReporterPrompt(base);
  const heard = buildReporterPrompt({ ...base, spoken: true });
  ok(!read.includes('最多兩句話'), '書面模式不加口語限制');
  ok(heard.includes('最多兩句話') && heard.includes('不要條列'),
    '語音模式要求問題短、口語——問題一長，練到的是閱讀理解不是臨場反應');
  ok(heard.includes('新聞稿') && read.includes('新聞稿'), '兩種模式都保留「不准問索取素材」那段');
}

console.log('\n[8] formatSessionNote／parseVoiceCount — 作答方式寫進 note 欄');
{
  ok(formatSessionNote(4, 5) === '語音作答 4/5 題', '格式同時給人看也給程式讀');
  ok(formatSessionNote(0, 5) === '', '全程打字 → 空字串（跟舊資料長得一樣，不用回填）');
  ok(formatSessionNote(undefined, 5) === '', '舊版前端沒傳這個欄位也不會寫出奇怪的字');
  ok(formatSessionNote(9, 5) === '語音作答 5/5 題', '語音題數不會超過總題數');
  ok(parseVoiceCount(formatSessionNote(3, 5)) === 3, '寫進去再讀出來要對得起來');
  ok(parseVoiceCount('') === 0 && parseVoiceCount(undefined) === 0, '舊資料（空 note）算成打字場次');
}

console.log('\n[9] training.html — 前端結構（不會報錯的那種錯）');
{
  const html = fs.readFileSync(new URL('../public/training.html', import.meta.url), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];

  // getElementById 打錯字不會有任何紅字，只會讓按鈕按了沒反應。
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  declared.add('typing'); // showTyping() 自己 new 出來的
  const used = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !declared.has(id));
  ok(missing.length === 0, `JS 用到的 ${used.length} 個 element id 在 HTML 裡都有（缺：${missing.join('、') || '無'}）`);

  // 三條退路都還在：後端轉寫、瀏覽器即時辨識、打字
  ok(js.includes("mode: 'transcribe'"), '會呼叫後端轉寫');
  ok(js.includes('webkitSpeechRecognition'), '瀏覽器即時辨識（後端沒設定時的備胎）還在');
  ok(js.includes("setAnswerMode('type')"), '打字這條退路還在——麥克風壞掉也要練得完這一場');
  ok(js.includes('transcript-box'), '逐字稿送出前可以自己改（辨識一定會有錯字）');
  ok(js.includes('getTracks') && js.includes('pagehide'),
    '離開頁面要把麥克風關掉，不然分頁的錄音紅點會一直亮著');
  ok(js.includes('peakLevel') && js.includes('幾乎沒收到聲音'),
    '有量音量並在沒聲音時當場提示——「按了錄音但沒收到聲音」不會自己報錯');
  ok(js.includes('spoken:') && js.includes('duration:'), '評分請求要帶上「這題是用講的、講了幾秒」');

  // ⚠️ 畫面上催他收尾的秒數，跟評分時用的標準必須是同一個數字。不一致的話，
  // 主管會看到自己「照著畫面準時收尾，卻被評語說超時」——而且兩邊都不會報錯。
  // 同 test/kb-limit.test.mjs 對前後台上限做的事。
  const feMin = Number(js.match(/const TARGET_MIN_SEC = (\d+)/)?.[1]);
  const feMax = Number(js.match(/const TARGET_MAX_SEC = (\d+)/)?.[1]);
  const feTooLong = Number(js.match(/const TOO_LONG_SEC = (\d+)/)?.[1]);
  ok(feMin === TARGET_MIN_SEC, `前端的目標下限 ${feMin} = 後端的 ${TARGET_MIN_SEC}`);
  ok(feMax === TARGET_MAX_SEC, `前端的目標上限 ${feMax} = 後端的 ${TARGET_MAX_SEC}`);
  ok(feTooLong === TOO_LONG_SEC, `前端的「太長」門檻 ${feTooLong} = 後端的 ${TOO_LONG_SEC}`);

  const feMaxRec = Number(js.match(/const MAX_REC_SECONDS = (\d+)/)?.[1]);
  ok(feMaxRec > TARGET_MAX_SEC,
    '錄音硬上限要留在目標之上——一到 60 秒就切掉，主管就練不到「自己收尾」這件事');

  // 講完才被告知「你講太久」已經來不及了，要在講到 60 秒的當下就看得到
  ok(js.includes('updateTimeZone') && js.includes('重點時間，可以準備收尾'),
    '錄音中會依秒數換提示語（訓練師在旁邊比手勢的那個動作）');
  ok(js.includes('zone-toolong') && js.includes('太長了，記者會抓不到重點'),
    '講超過門檻時，計時器會變色並明講後果');
  ok(js.includes("!status.classList.contains('silent')"),
    '沒收到聲音的警告要壓過時間提示——麥克風沒開比講太久嚴重');
  // 說明卡片在 body，不在 script 裡——這條要對整份 html 檢查
  ok(html.includes('30 秒到 1 分鐘內把重點講完'), '說明卡片一開始就講清楚這場在練什麼');
}

console.log(fails === 0 ? '\n全部通過 ✅' : `\n失敗 ${fails} 項 ❌`);
process.exit(fails === 0 ? 0 : 1);
