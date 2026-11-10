// 批次 195（工單 A）的網頁與後台那一半：
//   一、網頁問答（api/chat.js）寫 qa_log 也帶 J～Q 八格；第一次寫入會補表頭；A～I 欄一個字沒動
//   二、後台問答分析（api/analytics.js）：「疑似答不出來」先看 J 欄，舊資料才比對措辭；J 欄讀得到
//   三、匯出 CSV（api/export.js）：多八欄決策紀錄，舊資料是空的
//   （LINE 職員的助理 lib/assistant.js questions 也改走 isUnansweredRow，規則本身在 test-batch195-trace.mjs 驗）
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
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

const inDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const NO_DATA_REPLY = '這部分我沒有資料，建議洽現場新聞聯絡人。';
let replyText = '預計 2027 年第二季量產。';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: replyText }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const chat = (await import('../api/chat.js')).default;
let seq = 0;
const ask = async (q) => {
  seq++;
  const r = fakeRes();
  await chat({ method: 'POST', headers: { 'x-forwarded-for': `10.2.0.${seq}` }, socket: {}, body: { client_id: `w${seq}`, event_id: 'e1', media_name: '經濟日報', messages: [{ role: 'user', content: q }] } }, r);
  return r;
};
const ev = ['e1', '儲電新技術發表會', '#0F9E7A', '【新聞稿全文】儲電新技術：預計 2027 年第二季量產。', 'active', inDays(-1), '', '', '', '工研院', 'cc', '10:00', '中興院區 51 館', '記者會', '林小華 03-5912222', '', '', ''];
const QA_HEAD = ['timestamp', 'event_id', 'event_name', 'media_name', 'question', 'answer', 'deleted', 'source', 'reporter_name'];

// ═══ 一、網頁問答 ═════════════════════════════════════════════════════════════
console.log('\n── 一、網頁問答寫 qa_log ──');
reset();
book.events = [['id'], ev];
book.qa_log = [QA_HEAD];
{
  const r = await ask('何時量產？');
  check('（準備）網頁問答成功', r.statusCode === 200, r.statusCode);
  const rows = book.qa_log.slice(1);
  const row = rows[0] || [];
  check('★ 網頁問答 → qa_log 一列 17 格：A～I 照舊（來源 web），J～Q：answered、intent qa、scope 記 web',
    rows.length === 1 && row.length === 17 && row[7] === 'web' && row[3] === '經濟日報' && row[9] === 'answered' && row[10] === 'qa' && row[13] === 'web' && row[14] === 'kb', JSON.stringify(row));
  check('★ 第一次寫入順手補表頭（J1:Q1）', book.qa_log[0].slice(9, 17).join() === 'answer_status,intent,routed_event_ids,confidence,context_source,kb_source,no_data_keyword,grounding_flags', JSON.stringify(book.qa_log[0]));
  const before = JSON.stringify(book.qa_log[0]);
  await ask('再問一題');
  check('　 第二題：表頭沒被改動，資料多一列', JSON.stringify(book.qa_log[0]) === before && book.qa_log.length === 3);

  replyText = NO_DATA_REPLY;
  await ask('停車位在哪裡？');
  const nd = book.qa_log[3] || [];
  check('★ 網頁版回答「這部分我沒有資料」→ answer_status 是 no_data（跟後台以前比對措辭的結果一致）', nd[9] === 'no_data', JSON.stringify(nd));
  replyText = '預計 2027 年第二季量產。';
}

// ═══ 二、後台問答分析 ═════════════════════════════════════════════════════════
console.log('\n── 二、後台問答分析：疑似答不出來 ──');
const analytics = (await import('../api/analytics.js')).default;
const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const qaRow = (q, a, j) => { const r = [stamp, 'e1', '儲電新技術發表會', '經濟日報', q, a, '', 'line', '']; if (j !== undefined) r[9] = j; return r; };
reset();
book.events = [['id'], ev];
book.qa_log = [QA_HEAD,
  qaRow('甲：措辭換了、狀態是沒資料', '了解，這一點我不方便替院方多做解讀。', 'no_data'),
  qaRow('乙：舊資料、措辭是那句', NO_DATA_REPLY),
  qaRow('丙：有那句話、但狀態是 answered', NO_DATA_REPLY, 'answered'),
  qaRow('丁：一般回答', '預計 2027 年第二季量產。', 'answered'),
];
{
  const r = fakeRes();
  await analytics({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query: {}, socket: {} }, r);
  const byQ = Object.fromEntries((r.body?.recent || []).map((x) => [x.question.slice(0, 1), x.unanswered]));
  check('★ 後台逐筆標記：甲（J 欄 no_data）算、乙（舊資料比對措辭）算、丙（J 欄 answered）不算、丁不算',
    byQ['甲'] === true && byQ['乙'] === true && byQ['丙'] === false && byQ['丁'] === false, JSON.stringify(byQ));
  check('　 疑似答不出來的總數 = 2', r.body?.unanswered_count === 2, r.body?.unanswered_count);

  const one = fakeRes();
  await analytics({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query: { answer_row: '4' }, socket: {} }, one);
  check('　 點開單筆（第 4 列＝丙）：也走 J 欄，不算答不出來', one.body?.unanswered === false, JSON.stringify(one.body));
  const two = fakeRes();
  await analytics({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query: { answer_row: '2' }, socket: {} }, two);
  check('　 點開單筆（第 2 列＝甲）：算答不出來', two.body?.unanswered === true, JSON.stringify(two.body));
}

// ═══ 三、匯出 CSV ═════════════════════════════════════════════════════════════
console.log('\n── 三、匯出 CSV ──');
{
  book.qa_log[1][10] = 'qa'; book.qa_log[1][11] = 'e1'; book.qa_log[1][12] = 'high'; book.qa_log[1][13] = '1:1/route'; book.qa_log[1][14] = 'kb'; book.qa_log[1][15] = '停車'; book.qa_log[1][16] = 'n:3';
  const exp = (await import('../api/export.js')).default;
  const r = fakeRes();
  await exp({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query: {}, socket: {} }, r);
  const csv = r.chunks.join('');
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  check('★ 標題列：原本七欄不動，後面多八欄決策紀錄',
    lines[0].split(',').length === 15 && lines[0].startsWith('"時間","活動ID","活動名稱","媒體名稱","姓名","記者問題","AI回答","答題狀態","路由意圖"') && lines[0].endsWith('"沒資料關鍵詞","出口檢查標記"'), lines[0]);
  check('　 第一筆（甲）帶出八格；舊資料（乙）後面八格是空的',
    /"no_data","qa","e1","high","1:1\/route","kb","停車","n:3"/.test(lines[1] || '') && /,"","","","","","","",""$/.test(lines[2] || ''), `${lines[1]}\n${lines[2]}`);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 195（網頁與後台）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
