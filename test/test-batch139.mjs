// 批次 139：待教清單——自動發現米亞可能沒答好的題目，推給朱朱，由朱朱在 LINE 一句話教會。
//   一、讀時間：qa_log 的「2026/10/15 下午2:30:00」要讀得回來（上午／中午／午夜／下午）
//   二、發現：沒有資料、換句話又問；測試／內部／已刪除／太舊的不算；同一題只算一筆
//   三、排程：CRON_SECRET、寫進 teach_queue、推給 LINE_ADMIN_USER_ID、一題只提一次、一次最多 5 題、清單滿了不再疊
//   四、LINE 指令：待教清單／教 N：…／略過 N；只有職員；記憶寫進那一場；太長不默默截斷
//   五、出口：推播裡的簡體字一律轉繁體
// 跑真的 api/line.js 與 lib/teach-queue.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_COLLEAGUE_PASSCODE = 'Jerry';
process.env.CRON_SECRET = 'cron-secret';
process.env.LINE_ADMIN_USER_ID = 'U_admin';

const TQ = await import('../lib/teach-queue.js');
const { parseMemoryRows, formatFactBlock, MEMORY_MAX_LEN } = await import('../lib/bot-memory.js');

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } });
function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
async function dm(uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res());
  return sent.slice();
}
async function cron(auth = true) {
  sent.length = 0;
  const r = res();
  await handler({ method: 'GET', query: { action: 'cron_teach' }, headers: auth ? { authorization: 'Bearer cron-secret' } : {}, socket: {} }, r);
  return r;
}
const textOf = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
const pushed = () => sent.filter((s) => s.to === 'U_admin' && s.push);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

// qa_log 的列：A 時間 B 活動 id C 活動名稱 D 媒體 E 問題 F 回答 G 刪除旗標 H 來源 I 姓名。時間跟正式站寫的格式一樣。
const NO_DATA = '這部分我沒有資料，建議洽現場新聞聯絡人。';
const stamp = (minAgo) => new Date(Date.now() - minAgo * 60000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const qa = (minAgo, q, a = '好的，活動在南港。', { media = '經濟日報', who = '', del = '', event = 'med', name = '智慧醫療解決方案記者會' } = {}) =>
  [stamp(minAgo), event, name, media, q, a, del, 'line', who];
const staffRow = (uid) => [uid, '小美', '2026-08-27', '', ''];
const colleagueRow = (uid) => [uid, '小華', '2026-10-13', '', '', 'colleague'];

// ═══ 一、讀時間 ═══════════════════════════════════════════════════════════
console.log('── 一、qa_log 的時間欄讀得回來 ──');
{
  const taipei = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi);
  const rt = (y, mo, d, h, mi) => TQ.parseQaTime(new Date(taipei(y, mo, d, h, mi)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
  check('下午 2:30 → 14:30', rt(2026, 10, 15, 14, 30) === taipei(2026, 10, 15, 14, 30), new Date(taipei(2026, 10, 15, 14, 30)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
  check('上午 9:05 → 09:05', rt(2026, 10, 15, 9, 5) === taipei(2026, 10, 15, 9, 5));
  check('中午 12:10 不是午夜', rt(2026, 10, 15, 12, 10) === taipei(2026, 10, 15, 12, 10));
  check('午夜 00:20 不是中午', rt(2026, 10, 15, 0, 20) === taipei(2026, 10, 15, 0, 20));
  check('晚上 23:59 → 23:59', rt(2026, 1, 3, 23, 59) === taipei(2026, 1, 3, 23, 59));
  check('認不得的字串 → NaN（不會被當成很新的資料）', Number.isNaN(TQ.parseQaTime('')) && Number.isNaN(TQ.parseQaTime('昨天')));
  check('24 小時制「2026/10/15 14:30:00」也讀得回來', TQ.parseQaTime('2026/10/15 14:30:00') === taipei(2026, 10, 15, 14, 30));
}

// ═══ 二、發現 ═════════════════════════════════════════════════════════════
console.log('\n── 二、發現疑似沒答好的題目 ──');
{
  let s = TQ.findSuspects([qa(30, '這場有沒有提供停車位？', NO_DATA), qa(20, '誰是發言人？')]);
  check('★ 回答「這部分我沒有資料」→ 列入，訊號 unanswered', s.length === 1 && s[0].signals.includes('unanswered') && s[0].question === '這場有沒有提供停車位？', JSON.stringify(s));

  s = TQ.findSuspects([qa(30, '誰是發言人？', '發言人是王博士。')]);
  check('　 答得出來的 → 不列', s.length === 0);

  // 問 A 答 B：同一位記者九十秒後換句話又問
  s = TQ.findSuspects([
    qa(10, '智慧醫療的展示地點在哪裡', '活動的主題是智慧醫療。', { media: '聯合報', who: '王記者' }),
    qa(8.5, '智慧醫療展示的地點是哪裡？', '在南港展覽館 1 樓。', { media: '聯合報', who: '王記者' })
  ]);
  check('★ 同一位記者十分鐘內換句話又問 → 第一次那一題列入，訊號 rephrased', s.length === 1 && s[0].signals.includes('rephrased') && s[0].question === '智慧醫療的展示地點在哪裡', JSON.stringify(s));

  s = TQ.findSuspects([qa(10, '智慧醫療的展示地點在哪裡', 'x', { media: '聯合報', who: '王記者' }), qa(9, '智慧醫療展示的地點是哪裡？', 'y', { media: '聯合報', who: '李記者' })]);
  check('　 兩位不同的記者問類似的題目 → 不算「換句話又問」', s.length === 0, JSON.stringify(s));

  s = TQ.findSuspects([qa(10, '智慧醫療的展示地點在哪裡', 'x', { media: '（未填寫）' }), qa(9, '智慧醫療展示的地點是哪裡？', 'y', { media: '（未填寫）' })]);
  check('　 沒填媒體的分不出是不是同一個人 → 不判', s.length === 0, JSON.stringify(s));

  s = TQ.findSuspects([qa(60, '智慧醫療的展示地點在哪裡', 'x', { media: '聯合報' }), qa(20, '智慧醫療展示的地點是哪裡？', 'y', { media: '聯合報' })]);
  check('　 隔了四十分鐘才又問 → 不算', s.length === 0);

  s = TQ.findSuspects([qa(10, '智慧醫療的展示地點在哪裡', 'x', { media: '聯合報' }), qa(9, '智慧醫療的發言人是誰？', 'y', { media: '聯合報' })]);
  check('　 同一個主題、問的是不同的事 → 不算（門檻不能低到把這種也抓進來）', s.length === 0, JSON.stringify(s));

  s = TQ.findSuspects([qa(10, '停車位在哪', 'x', { media: '聯合報' }), qa(9, '今天天氣如何', 'y', { media: '聯合報' })]);
  check('　 連續兩題但是不相干 → 不算', s.length === 0);

  check('★ 測試與內部同仁問的不算', TQ.findSuspects([qa(5, 'a問題在哪', NO_DATA, { media: '測試' }), qa(5, 'b問題在哪', NO_DATA, { media: '（內部職員）' })]).length === 0);
  check('　 後台已刪除的不算', TQ.findSuspects([qa(5, '停車位在哪', NO_DATA, { del: '1' })]).length === 0);
  check('　 三天前的不算（只看最近兩天）', TQ.findSuspects([qa(3 * 24 * 60, '停車位在哪', NO_DATA)]).length === 0);
  check('　 時間欄壞掉的不算', TQ.findSuspects([['亂碼', 'med', 'x', '聯合報', '停車位在哪', NO_DATA]]).length === 0);

  s = TQ.findSuspects([qa(50, '停車位在哪裡？', NO_DATA, { media: 'A報' }), qa(40, '停車位 在哪裡', NO_DATA, { media: 'B報' }), qa(30, '停車位在哪裡!', NO_DATA, { media: 'C報' }), qa(20, '怎麼報名', NO_DATA)]);
  check('★ 同一場同一個問法（標點、空白不同）只算一筆，次數是 3；被問越多次越前面', s.length === 2 && s[0].count === 3 && s[0].question.startsWith('停車位'), JSON.stringify(s.map((x) => [x.question, x.count])));

  s = TQ.findSuspects([qa(5, '停車位在哪裡', NO_DATA, { event: 'a', name: 'A' }), qa(4, '停車位在哪裡', NO_DATA, { event: 'b', name: 'B' })]);
  check('　 不同場的同一句話是兩題（答案是各場自己的）', s.length === 2);

  check('★ 「疑似答不出來」只有一份規則：後台用的跟這裡是同一條', (await import('node:fs')).readFileSync(new URL('../api/analytics.js', import.meta.url), 'utf8').includes("import { UNANSWERED_RE } from '../lib/teach-queue.js'"));
}

// ═══ 三、排程 ═════════════════════════════════════════════════════════════
console.log('\n── 三、排程：寫進清單、推給朱朱、一題只提一次 ──');
reset(); await fresh();
{
  state.qaLog = [qa(30, '這場有沒有提供停車位？', NO_DATA), qa(25, '誰是發言人？'), qa(20, '怎麼報名？', NO_DATA, { media: '測試' })];
  let r = await cron(false);
  check('★ 沒帶 CRON_SECRET → 401，什麼都沒寫、沒推', r.statusCode === 401 && !state.teachQueue.length && !pushed().length);
  const keep = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  r = await cron(true);
  check('　 伺服器沒設 CRON_SECRET → 一律 401', r.statusCode === 401);
  process.env.CRON_SECRET = keep;

  r = await cron();
  check('★ 排程跑完：新題目進清單（編號 1）、推給管理員一則', r.statusCode === 200 && r.body.added === 1 && r.body.pushed === 1 && state.teachQueue.length === 1 && pushed().length === 1, JSON.stringify([r.body, state.teachQueue]));
  const row = state.teachQueue[0];
  check('　 清單那一列：編號、活動、問題、訊號、次數、狀態 open、已推送 Y', row[0] === 1 && row[2] === 'med' && row[4] === '這場有沒有提供停車位？' && row[5] === 'unanswered' && row[6] === 1 && row[8] === 'open' && row[9] === 'Y', JSON.stringify(row));
  const msg = pushed()[0]?.text || '';
  check('★ 推播的內容：題目、活動、米亞答了什麼、怎麼教、怎麼略過', /停車位/.test(msg) && /智慧醫療解決方案記者會/.test(msg) && /沒有資料/.test(msg) && /教 1：/.test(msg) && /略過 1/.test(msg), msg);
  check('　 推播不含測試與已答出來的題目', !/發言人|怎麼報名/.test(msg));

  r = await cron();
  check('★ 隔天再跑（同一題還在 qa_log 的兩天窗口裡）→ 不重複進清單、不重複推', r.body.added === 0 && r.body.pushed === 0 && state.teachQueue.length === 1 && !pushed().length, JSON.stringify(r.body));
}

reset(); await fresh();
{
  state.qaLog = Array.from({ length: 7 }, (_, i) => qa(40 - i, `第${i + 1}個很特別的問題在哪裡`, NO_DATA));
  let r = await cron();
  check('★ 一次最多推 5 題，其餘留著', r.body.added === 7 && r.body.pushed === 5 && state.teachQueue.filter((x) => x[9] === 'Y').length === 5, JSON.stringify(r.body));
  check('　 推播講明還有 2 題、怎麼看', /還有 2 題/.test(pushed()[0]?.text || '') && /待教清單/.test(pushed()[0]?.text || ''), pushed()[0]?.text);
  r = await cron();
  check('★ 隔天補推剩下的 2 題（沒推過的才推）', r.body.added === 0 && r.body.pushed === 2 && state.teachQueue.every((x) => x[9] === 'Y'), JSON.stringify(r.body));
}

reset(); await fresh();
{
  state.qaLog = [qa(30, '這場有沒有提供停車位？', NO_DATA)];
  delete process.env.LINE_ADMIN_USER_ID;
  let r = await cron();
  check('★ 沒設管理員 → 題目照樣進清單、不推、不報錯，也不標已推送', r.statusCode === 200 && r.body.added === 1 && r.body.pushed === 0 && !state.teachQueue[0][9] && !sent.length, JSON.stringify(r.body));
  process.env.LINE_ADMIN_USER_ID = 'U_admin';
  r = await cron();
  check('　 之後設好管理員 → 補推', r.body.pushed === 1 && pushed().length === 1);
}

reset(); await fresh();
{
  state.teachQueue = Array.from({ length: TQ.MAX_OPEN }, (_, i) => [i + 1, 't', 'med', '智慧醫療', `舊問題${i}在哪裡`, 'unanswered', 1, '', 'open', 'Y']);
  state.qaLog = [qa(30, '一個全新的問題在哪裡', NO_DATA)];
  const r = await cron();
  check('★ 清單上已經有 30 題沒人理 → 不再往上疊、也不推（不變成噪音）', r.body.added === 0 && state.teachQueue.length === TQ.MAX_OPEN && !pushed().length, JSON.stringify(r.body));
}

reset(); await fresh();
{
  state.qaLog = [qa(30, '这场有没有提供停车位？', NO_DATA, { media: '经济日报' })];
  await cron();
  const msg = pushed()[0]?.text || '';
  check('★ 出口：記者問題裡的簡體字，推播一律轉成繁體', /這場有沒有提供停車位/.test(msg) && !/这场|停车位/.test(msg), msg);
}

// ═══ 四、LINE 指令 ════════════════════════════════════════════════════════
console.log('\n── 四、在 LINE 教：待教清單／教 N：…／略過 N ──');
reset(); state.staff.push(staffRow('U_s'), colleagueRow('U_c')); await fresh();
{
  state.qaLog = [qa(30, '這場有沒有提供停車位？', NO_DATA), qa(29, '可以現場訪問誰？', NO_DATA), qa(28, '有沒有直播？', NO_DATA)];
  await cron();
  check('前置：三題都進了清單', state.teachQueue.length === 3);

  let out = await dm('U_s', '待教清單');
  check('★ 打「待教清單」→ 列出三題，每題有編號與怎麼教', /等著教的題目有 3 題/.test(textOf(out)) && /【1】/.test(textOf(out)) && /【3】/.test(textOf(out)) && /教 2：/.test(textOf(out)), textOf(out));

  const idOf = (q) => state.teachQueue.find((x) => x[4] === q)[0];
  const id1 = idOf('這場有沒有提供停車位？');
  out = await dm('U_s', `教 ${id1}：地下停車場有 200 個車位，記者憑採訪證免費。`);
  const mems = parseMemoryRows(state.memories);
  check('★ 「教 N：答案」→ 寫進 bot_memory：類型 fact、綁在那一場、生效中、建立者是教的人', mems.length === 1 && mems[0].type === 'fact' && mems[0].scope === 'med' && mems[0].status === 'on' && mems[0].by === 'U_s', JSON.stringify(state.memories));
  check('　 記的是「被問到什麼時，答案是什麼」，答案原文在裡面', /停車位/.test(mems[0].text) && /地下停車場有 200 個車位/.test(mems[0].text), mems[0].text);
  check('　 回覆：學會了，講明是哪一場', /學會了/.test(textOf(out)) && /智慧醫療解決方案記者會/.test(textOf(out)), textOf(out));
  check('　 清單那一題標成 taught', state.teachQueue.find((x) => x[0] === id1)[8] === 'taught');
  check('★ 下一次回答真的帶得到：這一場的「同仁後續更正」區塊有它，別場沒有', /地下停車場有 200 個車位/.test(formatFactBlock(mems, 'med')) && !formatFactBlock(mems, 'quad'));

  out = await dm('U_s', `教 ${id1}：再改一次`);
  check('　 同一題再教 → 「已經教過」，不再寫一條', /已經教過/.test(textOf(out)) && state.memories.length === 1, textOf(out));

  const id2 = idOf('可以現場訪問誰？');
  out = await dm('U_s', `略過 ${id2}`);
  check('★ 「略過 N」→ 標成 skipped、不寫記憶', state.teachQueue.find((x) => x[0] === id2)[8] === 'skipped' && state.memories.length === 1 && /之後不會再提/.test(textOf(out)), textOf(out));

  out = await dm('U_s', '教 99：隨便');
  check('　 不存在的編號 → 說沒有這題，不寫記憶', /沒有第 99 題/.test(textOf(out)) && state.memories.length === 1, textOf(out));

  const id3 = idOf('有沒有直播？');
  const long = '很長的答案'.repeat(60);
  out = await dm('U_s', `教 ${id3}：${long}`);
  check('★ 答案太長 → 請同仁濃縮，不默默截斷成半句（截一半的答案比沒有更糟）', /太長|有點長/.test(textOf(out)) && state.memories.length === 1 && state.teachQueue.find((x) => x[0] === id3)[8] === 'open', textOf(out));

  const long2 = '直播在官網與 YouTube 同步，現場有轉播車。'.repeat(1);
  out = await dm('U_s', `教 ${id3}：${long2}`);
  check('　 濃縮後再教 → 記得進去，且整條不超過上限', state.memories.length === 2 && parseMemoryRows(state.memories)[1].text.length <= MEMORY_MAX_LEN && /同步/.test(state.memories[1][3]), JSON.stringify(state.memories[1]));

  // 隔天排程：教過、略過的不再回到清單
  state.qaLog = [qa(20, '這場有沒有提供停車位？', NO_DATA, { media: '工商時報' }), qa(19, '可以現場訪問誰？', NO_DATA, { media: '工商時報' })];
  const before = state.teachQueue.length;
  const r = await cron();
  check('★ 教過的、略過的，之後同一題再被問、又答不出來 → 不會再進清單', r.body.added === 0 && state.teachQueue.length === before && !pushed().length, JSON.stringify(r.body));
}

// 全站的題目（qa_log 沒有活動 id）→ 記成全站
reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  state.qaLog = [qa(10, '工研院在哪裡成立的', NO_DATA, { event: '', name: '' })];
  await cron();
  await dm('U_s', '教 1：工研院 1973 年在新竹成立。');
  check('　 沒有指定活動的題目 → 記成全站（global）', parseMemoryRows(state.memories)[0]?.scope === 'global', JSON.stringify(state.memories));
}

// 記憶滿了
reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  state.qaLog = [qa(10, '停車位在哪裡', NO_DATA)];
  await cron();
  for (let i = 0; i < 40; i++) state.memories.push(['t', 'med', 'style', `規則${i}`, 'U_s', 'on']);
  const out = await dm('U_s', '教 1：地下一樓。');
  check('　 記憶已滿 40 條 → 提醒先忘記幾條，不寫、題目仍是 open', /上限/.test(textOf(out)) && state.memories.length === 40 && state.teachQueue[0][8] === 'open', textOf(out));
}

// 只有職員
reset(); state.staff.push(staffRow('U_s'), colleagueRow('U_c')); await fresh();
{
  state.qaLog = [qa(10, '停車位在哪裡', NO_DATA)];
  await cron();
  const bad = [];
  for (const uid of ['U_c', 'U_reporter']) {
    for (const t of ['教 1：地下一樓。', '略過 1', '待教清單']) {
      await fresh();
      await dm(uid, t);
      if (state.memories.length || state.teachQueue[0][8] !== 'open') bad.push(`${uid}:${t}`);
    }
  }
  check('★ 同仁、一般記者打「教 1：…」「略過 1」→ 什麼都不會被寫（只有職員能教米亞）', bad.length === 0, bad.join(', '));
}

// 分頁還沒建就先打「待教清單」
reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  const out = await dm('U_s', '待教清單');
  check('　 還沒有任何題目 → 友善地說沒有，不報錯', /目前沒有等著教的題目/.test(textOf(out)), textOf(out));
}

// 設定檔
{
  const fs = await import('node:fs');
  const v = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  check('★ vercel.json 有每天一次的排程指向 cron_teach', v.crons.some((c) => c.path === '/api/line?action=cron_teach' && /^\d+ \d+ \* \* \*$/.test(c.schedule)), JSON.stringify(v.crons));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 139（待教清單）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
