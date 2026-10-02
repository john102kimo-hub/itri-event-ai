// 批次 105（C 批）記者網頁與媒體統計的回歸測試。跑真的 api/chat.js、api/analytics.js、api/export.js 與
// lib/media-name.js，只有 Google Sheets 與模型是假的；記者頁（public/event.html）用「抽函式出來在假 DOM 上跑」。
//   一、媒體名稱整理：同一家併在一起、不是媒體的（沒填／略過／員工／問句）不算
//   二、網頁問答 API：先留媒體才能問（程式出口）、媒體與姓名分欄寫入、已結束的活動照樣答、歷史不以 AI 開頭
//   三、後台統計與匯出：服務媒體家數、填寫率、姓名欄、員工試問不進結案報告
//   四、記者頁：兩欄彈窗、舊資料遷移、出錯的不進對話紀錄、再問一次、找真人、對話還原
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], body: undefined, headersSent: false, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.send = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (x) => { r.headersSent = true; r.chunks.push(String(x)); return true; };
  r.flush = () => {};
  r.end = (x) => { if (x !== undefined) r.chunks.push(String(x)); r.ended = true; return r; };
  return r;
}

// ═══ 一、媒體名稱整理 ═════════════════════════════════════════════════════════
console.log('\n── 一、媒體名稱整理（lib/media-name.js）──');
const M = await import('../lib/media-name.js');
{
  const s = (x) => JSON.stringify(M.splitMedia(x));
  check('「經濟日報 王小明」拆成媒體＋姓名', s('經濟日報 王小明') === JSON.stringify({ outlet: '經濟日報', person: '王小明' }), s('經濟日報 王小明'));
  check('只有媒體 → 姓名空白', M.splitMedia('聯合報').person === '' && M.splitMedia('聯合報').outlet === '聯合報');
  check('句尾的「記者」不算媒體名稱的一部分：「聯合報記者」→「聯合報」', M.splitMedia('聯合報記者').outlet === '聯合報');
  check('★ 英文媒體名稱本身有空白，不能拆成「Taipei」＋「Times」（會把 Times 與 Post 併成同一家）', M.splitMedia('Taipei Times').outlet === 'Taipei Times' && M.splitMedia('Taipei Post').outlet === 'Taipei Post');
  for (const x of ['（未填寫）', '（未提供）', '（內部職員）', '（群組提問）', '', '   ']) {
    check(`不是媒體：${JSON.stringify(x)} → 不算任何一家`, M.isNotMedia(x) && M.outletKey(x) === '');
  }
  check('★ 整句問題（誤存進媒體欄的）不算任何一家', M.outletKey('請問何時量產？') === '' && M.outletKey('給我完整新聞稿') === '' && M.outletKey('麻煩提供技術規格') === '' && M.looksLikeQuestion('價格多少?'));
  const groups = M.groupOutlets(['經濟日報 王小明', '經濟日報 林小美', '經濟日報', '聯合報記者', '聯合報', '（未填寫）', '（未提供）', '（內部職員）', '（群組提問）', '請問何時量產？', '', 'Taipei Times', 'Taipei Post']);
  check('★ 同一家的不同記者、不同寫法併成一家；沒填、略過、員工、群組、問句都不算', groups.length === 4 && groups[0].name === '經濟日報' && groups[0].count === 3 && groups.find((g) => g.name === '聯合報').count === 2, JSON.stringify(groups));
  check('員工自己問的算測試資料（結案報告與統計都不該算）', M.isStaffMedia('（內部職員）') && M.isTestMedia('（內部職員）'));
  check('測試資料：test／測試／純數字／亂打', ['test', '測試用', '123', 'asdf', 'demo'].every((x) => M.isTestMedia(x)) && !M.isTestMedia('經濟日報'));
}

// ═══ 二、網頁問答 API（api/chat.js）═══════════════════════════════════════════
console.log('\n── 二、網頁問答 API：先留媒體才能問；媒體與姓名分欄；已結束的活動照樣答 ──');
const modelCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(opts.body);
    modelCalls.push(body);
    const text = '根據新聞稿，預計 2027 年第二季量產。';
    if (!body.stream) return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const enc = new TextEncoder();
    const evt = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify(evt)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(url, opts);
};
const chat = (await import('../api/chat.js')).default;
let seq = 0;
const ask = async (body, { stream = false } = {}) => {
  seq++;
  const r = fakeRes();
  await chat({ method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${seq}` }, socket: {}, body: { client_id: `c${seq}`, stream, ...body } }, r);
  return r;
};
const evRow = (id, status, extra = {}) => [id, `活動 ${id}`, '#0F9E7A', '【新聞稿全文】\n工研院發表新技術，預計 2027 年第二季量產。', status, '2026-09-20', '', '', '', '工研院', 'cc', '', '', '', '王小明 03-5911234', '', '', ''];
const QA_HEAD = ['timestamp', 'event_id', 'event_name', 'media_name', 'question', 'answer', 'deleted', 'source', 'reporter_name'];
const resetBook = () => {
  reset();
  book.events = [['id'], evRow('ev-active', 'active'), evRow('ev-ended', 'ended'), evRow('ev-draft', 'draft'), evRow('ev-arch', 'archived')];
  book.qa_log = [QA_HEAD];
  modelCalls.length = 0;
};
const qaRows = () => book.qa_log.slice(1);
const Q = [{ role: 'user', content: '什麼時候量產？' }];
{
  resetBook();
  const r1 = await ask({ event_id: 'ev-active', messages: Q });
  check('★ 沒帶媒體名稱 → 400 ＋ code=media_required（程式出口擋，不是只靠畫面上的彈窗）', r1.statusCode === 400 && r1.body.code === 'media_required' && /媒體/.test(r1.body.error), JSON.stringify(r1.body));
  const r2 = await ask({ event_id: 'ev-active', messages: Q, media_name: '   ' });
  check('　 只有空白也算沒填', r2.statusCode === 400 && r2.body.code === 'media_required');
  check('　 被擋下來的不會呼叫模型、也不會多出一筆「（未填寫）」', modelCalls.length === 0 && qaRows().length === 0, JSON.stringify([modelCalls.length, qaRows().length]));

  const r3 = await ask({ event_id: 'ev-active', messages: Q, media_name: '經濟日報', reporter_name: '王小明' });
  check('有媒體 → 正常回答', r3.statusCode === 200 && /2027/.test(r3.body.reply), JSON.stringify(r3.body));
  const row = qaRows()[0] || [];
  check('★ qa_log：D 欄只放媒體、I 欄放姓名（媒體與姓名分開存，統計才數得準）', row[3] === '經濟日報' && row[8] === '王小明' && row[7] === 'web' && row[6] === '', JSON.stringify(row));

  const r4 = await ask({ event_id: 'ev-active', messages: Q, media_name: '聯合報' });
  check('姓名選填：沒帶 → I 欄空白，不影響記錄', r4.statusCode === 200 && qaRows()[1][3] === '聯合報' && (qaRows()[1][8] || '') === '', JSON.stringify(qaRows()[1]));

  const long = '王'.repeat(60) + '\n換行';
  await ask({ event_id: 'ev-active', messages: Q, media_name: '中央社\n  分社', reporter_name: long });
  const r5 = qaRows()[2];
  check('媒體與姓名寫入前淨化：換行壓成一行、各限 40 字（不會把試算表一格撐爆、也不會污染統計）', !/\n/.test(r5[3]) && !/\n/.test(r5[8]) && r5[8].length <= 40 && r5[3] === '中央社 分社', JSON.stringify(r5));

  // 已結束（C 批決定 2）：跟 LINE 一樣會後還能問
  const rEnded = await ask({ event_id: 'ev-ended', messages: Q, media_name: '中央社' });
  check('★ 已結束的活動：網頁問答照樣回答（會後才來補問的記者）', rEnded.statusCode === 200 && /2027/.test(rEnded.body.reply), JSON.stringify(rEnded.body));
  check('　 未發布、已封存的仍然問不到（404）', (await ask({ event_id: 'ev-draft', messages: Q, media_name: 'x' })).statusCode === 404 && (await ask({ event_id: 'ev-arch', messages: Q, media_name: 'x' })).statusCode === 404);
}
{
  // 對話歷史：前端每一題都是「問、答、問、答…最後是問」，總數是奇數；只留最近 12 則會剛好從 AI 的回答開始
  resetBook();
  const hist = [];
  for (let i = 1; i <= 7; i++) { hist.push({ role: 'user', content: `第 ${i} 題` }); if (i < 7) hist.push({ role: 'assistant', content: `第 ${i} 答` }); }
  check('（前置）第 7 題送出時歷史共 13 則、最後一則是記者的問題', hist.length === 13 && hist[12].role === 'user');
  const r = await ask({ event_id: 'ev-active', messages: hist, media_name: '經濟日報' });
  const sent = modelCalls[0]?.messages || [];
  check('★ 送給模型的第一則一定是記者的問題（模型 API 要求；以前第 7 題起每一題都被退件）', r.statusCode === 200 && sent[0]?.role === 'user' && sent.length <= 12 && sent[sent.length - 1].content === '第 7 題', JSON.stringify(sent.map((m) => m.role + ':' + m.content)));
  const rs = await ask({ event_id: 'ev-active', messages: hist, media_name: '經濟日報' }, { stream: true });
  check('　 串流模式也一樣', modelCalls[1]?.messages[0]?.role === 'user' && rs.chunks.join('').includes('"t"'), JSON.stringify(modelCalls[1]?.messages?.map((m) => m.role)));
  const onlyAssistant = await ask({ event_id: 'ev-active', messages: [{ role: 'assistant', content: '哈囉' }], media_name: '經濟日報' });
  check('　 整串都沒有記者的問題 → 當成格式錯誤，不去問模型', onlyAssistant.statusCode === 400, JSON.stringify(onlyAssistant.body));
}

// ═══ 三、後台統計與匯出 ═══════════════════════════════════════════════════════
console.log('\n── 三、後台統計：服務媒體家數、填寫率、姓名欄、員工試問不進結案報告 ──');
const analytics = (await import('../api/analytics.js')).default;
const exporter = (await import('../api/export.js')).default;
const T = (m) => `2026/9/23 上午11:${String(m).padStart(2, '0')}:00`;
const LONG = '根據新聞稿，這項技術預計 2027 年第二季量產，已與三家國內廠商完成技轉。'.repeat(8);
const seed = () => {
  reset();
  book.events = [['id'], evRow('e1', 'active'), evRow('e2', 'active')];
  book.qa_log = [QA_HEAD,
    /* 2 */ [T(1), 'e1', '活動一', '經濟日報', '價格多少？', LONG, '', 'web', '王小明'],
    /* 3 */ [T(2), 'e1', '活動一', '經濟日報', '何時量產？', '這部分我沒有資料，建議洽現場新聞聯絡人。', '', 'web', '林小美'],
    /* 4 */ [T(3), 'e1', '活動一', '經濟日報 陳記者', '成本？', '約 100 萬。', '', 'web', ''],      // 舊資料：媒體與人名在同一欄
    /* 5 */ [T(4), 'e1', '活動一', '聯合報記者', '怎麼合作？', '請洽窗口。', '', 'line', ''],
    /* 6 */ [T(5), 'e1', '活動一', '（未填寫）', 'q6', 'a', '', 'line', ''],
    /* 7 */ [T(6), 'e1', '活動一', '（未提供）', 'q7', 'a', '', 'line', ''],
    /* 8 */ [T(7), 'e1', '活動一', '（內部職員）', 'q8', 'a', '', 'line', ''],                      // 同仁在 LINE 職員模式自己問的（source 是 line，不是 staff）
    /* 9 */ [T(8), 'e1', '活動一', '（群組提問）', 'q9', 'a', '', 'line', ''],
    /* 10 */ [T(9), 'e1', '活動一', '請問何時量產？', 'q10', 'a', '', 'line', ''],                     // 髒資料：問句被記成媒體
    /* 11 */ [T(10), 'e2', '活動二', 'test', 'q11', 'a', '', 'web', ''],                              // 測試資料
    /* 12 */ [T(11), 'e2', '活動二', '數位時代', 'q12', 'a', '1', 'web', '']                          // 已刪除
  ];
};
const getAnalytics = async (query = {}) => { const r = fakeRes(); await analytics({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query }, r); return r; };
{
  seed();
  const r = (await getAnalytics({ exclude_test: '1' })).body;
  check('★ 服務媒體家數：同一家的不同記者併成一家；沒填、略過、群組、問句不算 → 經濟日報、聯合報 = 2 家', r.media_total === 2, `media_total=${r.media_total}`);
  check('　 排除測試資料與員工試問後，總題數 = 8（扣掉 test、內部職員、已刪除）', r.total === 8, `total=${r.total}`);
  check('　 媒體排行：經濟日報 3、聯合報 1（「經濟日報 陳記者」併進經濟日報）', JSON.stringify(r.top_media) === JSON.stringify([{ name: '經濟日報', count: 3 }, { name: '聯合報', count: 1 }]), JSON.stringify(r.top_media));
  const e1 = r.by_event.find((e) => e.event_id === 'e1');
  check('★ 各場：服務媒體家數 2、真的填了媒體的有 4 題（媒體填寫率的分子；「（未提供）」「（群組提問）」不算填了）', e1.media_count === 2 && e1.media_filled === 4 && e1.count === 8, JSON.stringify({ c: e1.media_count, f: e1.media_filled, n: e1.count }));
  check('　 成效報告的「到訪媒體」名單 = 經濟日報、聯合報', JSON.stringify(e1.media_list) === JSON.stringify(['經濟日報', '聯合報']), JSON.stringify(e1.media_list));
  check('　 疑似答不出來的題數 = 1（AI 說「這部分我沒有資料」）', r.unanswered_count === 1, `unanswered=${r.unanswered_count}`);

  const all = (await getAnalytics()).body;
  check('不排除測試資料時，員工試問與 test 都還在（總題數 10）；員工試問不是媒體、test 算一家 → 3 家', all.total === 10 && all.media_total === 3, `total=${all.total} media_total=${all.media_total}`);

  const rec = r.recent.find((x) => x.question === '何時量產？');
  check('★ 最新問答：帶姓名（I 欄）、AI 回答只帶預覽、標出疑似答不出來；整段回答不在列表裡', rec && rec.reporter === '林小美' && rec.unanswered === true && !('answer' in rec) && rec.answer_preview.includes('這部分我沒有資料'), JSON.stringify(rec));
  const longRow = r.recent.find((x) => x.question === '價格多少？');
  check('　 預覽最多 140 字（一筆回答動輒上千字，200 筆全帶是好幾百 KB）', longRow.answer_preview.length <= 140 && JSON.stringify(r).length < JSON.stringify(all).length + 5000, String(longRow.answer_preview.length));

  const sum = (await getAnalytics({ summary: '1', exclude_test: '1' })).body;
  check('★ 摘要模式（後台首頁用）：只有數字，沒有逐筆問答、也沒有各場的問題清單', sum.total === 8 && sum.media_total === 2 && !('recent' in sum) && sum.by_event.every((e) => !('questions' in e)) && JSON.stringify(sum).length < 2000, JSON.stringify(sum).length);

  const one = await getAnalytics({ answer_row: '2' });
  check('按需取得整段回答（answer_row）：回完整內容', one.statusCode === 200 && one.body.answer === LONG, JSON.stringify(one.body).slice(0, 120));
  check('　 已刪除的那一筆、不存在的列、亂填的列號 → 404／404／400', (await getAnalytics({ answer_row: '12' })).statusCode === 404 && (await getAnalytics({ answer_row: '99' })).statusCode === 404 && (await getAnalytics({ answer_row: 'abc' })).statusCode === 400);

  // 手動改媒體與姓名
  const post = async (body) => { const rr = fakeRes(); await analytics({ method: 'POST', headers: {}, query: {}, body: { password: 'pw', ...body } }, rr); return rr; };
  const up = await post({ action: 'update_media', row_num: 4, media_name: '經濟日報', reporter_name: '陳小華' });
  check('★ 後台改媒體：D 欄與 I 欄各寫各的（把「經濟日報 陳記者」整理成媒體＋姓名）', up.statusCode === 200 && book.qa_log[3][3] === '經濟日報' && book.qa_log[3][8] === '陳小華', JSON.stringify(book.qa_log[3]));
  const up2 = await post({ action: 'update_media', row_num: 5, media_name: '聯合報' });
  check('　 沒帶姓名就只改媒體，不會把原本的姓名清掉', up2.statusCode === 200 && book.qa_log[4][3] === '聯合報');
  const up3 = await post({ action: 'update_media', row_num: 2, media_name: '經濟日報', reporter_name: '王\n小明' });
  check('　 姓名也會壓成一行', book.qa_log[1][8] === '王 小明', JSON.stringify(book.qa_log[1]));
}
{
  seed();
  const r = fakeRes();
  await exporter({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query: {} }, r);
  const csv = r.chunks.join('');
  const lines = csv.split('\r\n');
  check('匯出：表頭多一欄「姓名」，順序＝時間、活動ID、活動名稱、媒體名稱、姓名、記者問題、AI回答', /"時間","活動ID","活動名稱","媒體名稱","姓名","記者問題","AI回答"/.test(lines[0]), lines[0]);
  check('★ 匯出：員工在 LINE 職員模式的試問不進結案報告附件（以前濾網看錯欄位，從來沒擋到）', !/內部職員/.test(csv) && !/q8/.test(csv), csv.slice(0, 300));
  check('　 已刪除的不匯出；姓名欄有值', !/q12/.test(csv) && /"經濟日報","王小明","價格多少？"/.test(csv));
  check('　 檔名日期用台灣時間（不是 UTC）', /all-events-qa-\d{4}-\d{2}-\d{2}\.csv/.test(r.headers['content-disposition'] || ''), r.headers['content-disposition']);
}

// ═══ 四、記者頁（public/event.html）═══════════════════════════════════════════
console.log('\n── 四、記者頁：兩欄彈窗、舊資料遷移、出錯的不進對話紀錄、再問一次、找真人、對話還原 ──');
const EV = read('public/event.html');
function fnSource(html, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (!m) throw new Error('找不到函式 ' + name);
  // 一行寫完的函式（`function f() { ... }`）整行就是它；多行的到下一個頂格的 `}` 為止
  const eol = html.indexOf('\n', m.index);
  const first = html.slice(m.index, eol);
  if (/\}\s*$/.test(first) && first.split('{').length === first.split('}').length) return first + '\n';
  return html.slice(m.index, html.indexOf('\n}\n', m.index) + 2);
}
const lineOf = (html, re) => { const m = re.exec(html); if (!m) throw new Error('找不到 ' + re); return m[0]; };

{
  // 結構
  check('★ 彈窗：「媒體／單位」必填、「姓名」選填，各一個輸入框', /id="media-modal-input"/.test(EV) && /id="media-modal-person"/.test(EV) && /媒體／單位<em>必填<\/em>/.test(EV) && /姓名<em class="opt">選填<\/em>/.test(EV));
  check('★ 上方欄位：媒體（必填）與姓名（選填）兩欄；不再寫「媒體/貴賓 職稱與人名（選填）」——那一欄實際上是鎖住輸入框的必填', /id="media-input"[^>]*placeholder="媒體／單位（必填）"/.test(EV) && /id="person-input"[^>]*placeholder="姓名（選填）"/.test(EV) && !/媒體\/貴賓 職稱與人名（選填）/.test(EV));
  check('送出請求帶 media_name 與 reporter_name', /media_name: mediaName,\s*reporter_name: personName/.test(EV));
  check('送出鈕是內嵌 SVG（圖示字型載不到時整顆按鈕不會變空白）', /id="send-btn"[^>]*><svg/.test(EV));
  check('對話區標成 log（螢幕閱讀器念新訊息）', /<div id="messages" role="log" aria-live="polite">/.test(EV));
  check('★ 已結束的活動：不再鎖起來（沒有「提問功能已關閉」，也不再加 archive-mode）', !/提問功能已關閉/.test(EV) && !/classList\.add\('archive-mode'\)/.test(EV) && /function setupArchive\(/.test(EV) && /id="archive-btn"/.test(EV));
  check('　 伺服器渲染的存檔文章不再把聊天介面藏起來（爬蟲照樣讀得到整篇）', !/body\.archive-mode/.test(read('api/event-page.js')));
}
{
  // 舊資料遷移：同一批樣本，記者頁與 lib/media-name.js 的 splitMedia 結果一致
  const src = [lineOf(EV, /const ROLE_TAIL_RE = .*;/), fnSource(EV, 'splitLegacyMedia')].join('\n');
  const splitLegacy = new Function(`${src}; return splitLegacyMedia;`)();
  const samples = ['經濟日報 王小明', '經濟日報　王小明', '聯合報記者', '工研院 劉院長', 'Taipei Times', '中央社', '自由時報 林記者 小美', 'A', '工商時報攝影記者', '數位時代 James Wang'];
  const diffs = samples.map((x) => [x, M.splitMedia(x), splitLegacy(x)]).filter(([, a, b]) => a.outlet !== b.outlet || a.person !== b.person);
  check(`★ ${samples.length} 個舊式輸入：記者頁拆「媒體／姓名」與後台統計的 splitMedia 結果一致（鏡射不准漂開）`, diffs.length === 0, JSON.stringify(diffs));

  // 舊 key 遷移：只有舊的一整串 → 拆開帶出；新 key 一旦有了就以新的為準
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const mk = () => new Function('localStorage', [
    "const MEDIA_LS_KEY = 'itri_media_name'; const OUTLET_LS_KEY = 'itri_media_outlet'; const PERSON_LS_KEY = 'itri_media_person';",
    fnSource(EV, 'lsGet'), fnSource(EV, 'lsSet'), src, fnSource(EV, 'rememberedMedia'), fnSource(EV, 'rememberMedia'),
    'return { rememberedMedia, rememberMedia };'
  ].join('\n'))(ls);
  const f = mk();
  store.itri_media_name = '經濟日報 王小明';
  check('舊版只存一整串「經濟日報 王小明」→ 第一次進來拆成媒體「經濟日報」、姓名「王小明」帶出來', JSON.stringify(f.rememberedMedia()) === JSON.stringify({ outlet: '經濟日報', person: '王小明' }), JSON.stringify(f.rememberedMedia()));
  f.rememberMedia('聯合報', '');
  check('記下新的之後以新的為準（舊的不會再蓋回來）', JSON.stringify(f.rememberedMedia()) === JSON.stringify({ outlet: '聯合報', person: '' }), JSON.stringify(f.rememberedMedia()));
  const broken = new Function('localStorage', "const MEDIA_LS_KEY = 'a'; const OUTLET_LS_KEY = 'b'; const PERSON_LS_KEY = 'c';" + fnSource(EV, 'lsGet') + fnSource(EV, 'lsSet') + src + fnSource(EV, 'rememberedMedia') + fnSource(EV, 'rememberMedia') + 'return { rememberedMedia, rememberMedia };')({ getItem() { throw new Error('擋掉了'); }, setItem() { throw new Error('擋掉了'); } });
  check('瀏覽器擋 localStorage（無痕、第三方資料）→ 當作沒填過，不丟例外', JSON.stringify(broken.rememberedMedia()) === JSON.stringify({ outlet: '', person: '' }) && (broken.rememberMedia('x', 'y'), true));

  // 「找真人」那句判斷與後台標「疑似答不出來」同一條規則
  const evRe = lineOf(EV, /const UNANSWERED_RE = .*;/).replace(/^const UNANSWERED_RE = /, '').replace(/;$/, '');
  const anRe = lineOf(read('api/analytics.js'), /const UNANSWERED_RE = .*;/).replace(/^const UNANSWERED_RE = /, '').replace(/;$/, '');
  check('★ UNANSWERED_RE：記者頁（找真人）與後台（疑似答不出來）逐字相同', evRe === anRe, evRe + '\n' + anRe);
}
{
  // 對話紀錄的存取
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const pre = ["const CHAT_LS_PREFIX = 'itri_chat_'; const CHAT_TTL_MS = 12 * 3600 * 1000; const CHAT_KEEP = 40;", 'let hist = []; const eventId = "ev1";', fnSource(EV, 'lsGet'), fnSource(EV, 'lsSet'), fnSource(EV, 'saveChat'), fnSource(EV, 'clearChat'), fnSource(EV, 'loadChat')].join('\n');
  const mk = (now) => new Function('localStorage', 'Date', `${pre}; return { saveChat, loadChat, clearChat, setHist: (h) => { hist = h; } };`)(ls, now ? class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } } : Date);
  const f = mk();
  const big = []; for (let i = 1; i <= 30; i++) { big.push({ role: 'user', content: `問${i}` }, { role: 'assistant', content: `答${i}` }); }
  f.setHist(big); f.saveChat();
  check('對話最多留 40 則；對話記在「這一場」自己的 key（換一場不會串）', JSON.parse(store.itri_chat_ev1).hist.length === 40 && !('itri_chat_ev2' in store));
  const back = f.loadChat();
  check('★ 還原時開頭一定是記者的問題（只留最近 40 則可能從 AI 的回答切起），且內容照舊', back[0].role === 'user' && back[back.length - 1].content === '答30', JSON.stringify(back.slice(0, 2)));
  store.itri_chat_ev1 = JSON.stringify({ t: Date.now(), hist: [{ role: 'assistant', content: '被截掉前面的答' }, { role: 'user', content: '問2' }, { role: 'assistant', content: '答2' }, { role: 'assistant', content: '' }, { role: 'system', content: 'x' }] });
  const odd = f.loadChat();
  check('★ 紀錄若從 AI 的回答開頭 → 丟掉開頭那則；空內容、不認得的角色也濾掉（還原出來的對話要能直接當歷史送出）', JSON.stringify(odd.map((m) => m.role + ':' + m.content)) === '["user:問2","assistant:答2"]', JSON.stringify(odd));
  store.itri_chat_ev1 = JSON.stringify({ t: Date.now(), hist: back });
  const later = mk(Date.now() + 13 * 3600 * 1000);
  check('★ 超過 12 小時就不還原（隔天再開同一個連結是新的一輪）', later.loadChat().length === 0);
  store.itri_chat_ev1 = '{壞掉的 json';
  check('紀錄壞了 → 當作沒有，不丟例外', f.loadChat().length === 0);
  f.setHist([{ role: 'user', content: 'q' }]); f.saveChat(); f.clearChat();
  check('「重新開始」會清掉紀錄', !('itri_chat_ev1' in store));
}
{
  // sendMessage：用最小的假 DOM 跑真的 sendMessage／failTurn／addRetry
  const mkEl = (tag = 'div') => {
    const el = { tag, className: '', textContent: '', value: '', style: {}, children: [], removed: false, disabled: false, onclick: null,
      appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; }, setAttribute() {}, querySelector() { return null; } };
    return el;
  };
  const dom = new Map();
  const get = (id) => { if (!dom.has(id)) dom.set(id, mkEl()); return dom.get(id); };
  const document = { getElementById: get, createElement: (t) => mkEl(t), createTextNode: (t) => ({ text: t }), createDocumentFragment: () => mkEl('frag') };
  const run = async ({ fetchImpl, mediaName = '經濟日報', personName = '王小明', contact = '王小明 03-5911234 分機 8888', preHist = [] }) => {
    const log = { shown: [], fetches: [], modal: 0, locked: 0, saved: 0, human: 0 };
    const wrapOf = () => ({ children: [], appendChild(c) { this.children.push(c); } });
    const src = [fnSource(EV, 'addRetry'), fnSource(EV, 'failTurn'), fnSource(EV, 'sendMessage')].join('\n');
    const factory = new Function('document', 'fetch', 'addMessage', 'showTyping', 'dockChips', 'lockUntilMedia', 'showMediaModal', 'saveChat', 'addHumanHelp', 'clientId', 'streamReply', 'UNANSWERED_RE', 'eventId',
      `let hist = ${JSON.stringify(preHist)}; let isWaiting = false; let mediaName = ${JSON.stringify(mediaName)}; let personName = ${JSON.stringify(personName)};
       ${src}
       return { sendMessage, get hist() { return hist; }, set mediaName(v) { mediaName = v; } };`);
    const api = factory(document,
      async (url, opts) => { log.fetches.push(JSON.parse(opts.body)); return fetchImpl(log.fetches.length); },
      (role, text, opts = {}) => { const wrap = wrapOf(); const el = { role, text, opts, wrap, removed: false, remove() { this.removed = true; }, querySelector: (s) => (s === '.bubble-wrap' ? wrap : null) }; log.shown.push(el); return el; },
      () => {}, () => {}, () => { log.locked++; }, () => { log.modal++; }, () => { log.saved++; }, () => { log.human++; }, () => 'cid', async () => ({}), /這部分我沒有資料/, 'ev1');
    return { api, log };
  };
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });

  let t = await run({ fetchImpl: () => json(429, { error: '提問太頻繁，請稍候片刻再試。' }) });
  document.getElementById('user-input').value = '';
  await t.api.sendMessage('第一個問題');
  check('★ 限流（429）：這一題收回來，對話紀錄是空的（錯誤訊息不會被當成 AI 說過的話送去下一題）', t.api.hist.length === 0, JSON.stringify(t.api.hist));
  const err = t.log.shown.find((m) => m.opts.error);
  check('　 畫面上留一則錯誤說明，底下附「再問一次」', err && /太頻繁/.test(err.text) && err.wrap.children.some((c) => c.className === 'retry-btn' && c.textContent === '再問一次'), JSON.stringify(err && err.text));
  check('　 請求本文帶了 media_name 與 reporter_name', t.log.fetches[0].media_name === '經濟日報' && t.log.fetches[0].reporter_name === '王小明');
  const retry = err.wrap.children.find((c) => c.className === 'retry-btn');
  let second = 0;
  t = await run({ fetchImpl: () => (++second, json(429, { error: '提問太頻繁' })) });
  await t.api.sendMessage('第一個問題');
  const e2 = t.log.shown.find((m) => m.opts.error);
  const before = t.log.fetches.length;
  e2.wrap.children[0].onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('★ 按「再問一次」：拿掉出錯的那一組畫面、用同一題重送', e2.removed === true && t.log.shown[0].removed === true && t.log.fetches.length === before + 1 && t.log.fetches[before].messages.at(-1).content === '第一個問題' && t.log.fetches[before].messages.length === 1, JSON.stringify(t.log.fetches.map((b) => b.messages.length)));

  t = await run({ fetchImpl: () => { throw new Error('Failed to fetch'); } });
  await t.api.sendMessage('網路斷了的問題');
  check('斷線：同樣收回、不進紀錄，並附「再問一次」', t.api.hist.length === 0 && t.log.shown.some((m) => m.opts.error && /連線錯誤/.test(m.text)));

  t = await run({ fetchImpl: () => json(400, { error: '請先填寫貴媒體名稱，再開始提問。', code: 'media_required' }) });
  await t.api.sendMessage('舊版頁面送出的問題');
  check('★ 後端說「要先留媒體」（舊版頁面還開著）：收回這題、鎖住輸入框、重新打開彈窗——不把這句話印成 AI 的回答', t.api.hist.length === 0 && t.log.modal === 1 && t.log.locked === 1 && !t.log.shown.some((m) => m.role === 'ai'), JSON.stringify([t.api.hist, t.log.modal, t.log.locked]));

  t = await run({ fetchImpl: () => json(200, { reply: '預計 2027 年量產。' }) });
  await t.api.sendMessage('什麼時候量產？');
  check('成功：問與答都進對話紀錄，並存到這台瀏覽器', JSON.stringify(t.api.hist.map((m) => m.role)) === '["user","assistant"]' && t.log.saved === 1 && t.log.human === 0);
  t = await run({ fetchImpl: () => json(200, { reply: '這部分我沒有資料，建議洽現場新聞聯絡人。' }) });
  await t.api.sendMessage('某個新聞稿沒寫的問題');
  check('★ AI 說「沒有資料」：那一則底下附上真人的聯絡方式', t.log.human === 1 && t.api.hist.length === 2);

  t = await run({ fetchImpl: () => json(200, { reply: 'x' }), mediaName: '' });
  await t.api.sendMessage('還沒填媒體就想問');
  check('★ 媒體欄是空的 → 不送出，改為打開彈窗（輸入框鎖定與送出一致）', t.log.fetches.length === 0 && t.log.modal === 1 && t.api.hist.length === 0);
}
{
  // 新聞聯絡人 → 電話連結
  const mkEl = (tag) => ({ tag, children: [], href: '', textContent: '', appendChild(c) { this.children.push(c); return c; } });
  const document = { createDocumentFragment: () => mkEl('frag'), createTextNode: (t) => ({ text: t }), createElement: (t) => mkEl(t) };
  const src = [lineOf(EV, /const PHONE_RE = .*;/), fnSource(EV, 'contactNode')].join('\n');
  const contactNode = new Function('document', `${src}; return contactNode;`)(document);
  const a = contactNode('王小明 03-5911234 分機 8888');
  const link = a.children.find((c) => c.tag === 'a');
  check('新聞聯絡人「王小明 03-5911234 分機 8888」→ 電話那段是 tel: 連結（手機一點就撥），前後文字照舊', link && link.href === 'tel:035911234' && link.textContent === '03-5911234' && a.children[0].text === '王小明 ' && a.children[2].text === ' 分機 8888', JSON.stringify(a.children));
  check('手機號碼 0912-345-678 也認得', contactNode('林小美 0912-345-678').children.find((c) => c.tag === 'a')?.href === 'tel:0912345678');
  check('沒有電話的聯絡資訊 → 只有文字、沒有連結', !contactNode('請洽現場服務台').children.some((c) => c.tag === 'a'));
}

// 成效報告頁
{
  const rp = read('public/report.html');
  check('★ 成效報告的「服務媒體家數」用後端算好的 media_total（同一家併在一起），不再自己拿各場名單去重', /ANALYTICS\.media_total != null \? ANALYTICS\.media_total : mediaUnion\.size/.test(rp) && /\$\{mediaTotal\}<\/div><div class="lab">服務媒體家數/.test(rp));
  check('　 媒體填寫率用後端的 media_filled（「（未提供）」「（群組提問）」不算填了）', /e\.media_filled != null \? e\.media_filled/.test(rp));
}

globalThis.fetch = realFetch;
console.log(`\n${fail ? '❌' : '✅'} 批次 105（C 批・媒體與記者網頁）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
