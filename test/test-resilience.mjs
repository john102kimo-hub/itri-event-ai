// 「記者永遠不該面對已讀不回」的回歸測試（批次 57）。
//
// 這份跟 test-flow.mjs 的差別：那份測「一切正常時答得對不對」，這份測「有東西壞掉
// 的時候，記者那邊看到什麼」。盤點時實測出來的答案是——**什麼都看不到**：
//
//   把 events 表的讀取換成會丟例外的版本（模擬 Sheets 配額用完，那是記者會開場後
//   十分鐘最容易發生的事），記者送出的問題連一個字的回應都沒有。api/line.js 的
//   handler 只 console.error 就繼續跑下一則事件，HTTP 照樣 200，Vercel Logs 很乾淨。
//
// 這是 CLAUDE.md 第 4 條「送出成功 ≠ 使用者看得到」的另一面：我們自己知道出事了，
// 但沒有人告訴記者。這份測試把「出口一定要有話講」釘住。
//
// ⚠️ 群組的方向是相反的：沒被叫到的訊息，就算處理過程出例外也**不能**開口——那是
// 插話，這個帳號最該避免的事（LINE-PLAN.md 第 8 節）。兩個方向都要測，只測一邊會
// 讓下一個人把它「修」壞。

import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

register('./loader.mjs', import.meta.url);

const { sent, state, reset, sheets } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}`); }
}

let modSeq = 0;
async function freshModule() {
  return (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default;
}

const res = { status() { return this; }, json() { return this; }, end() { return this; } };

function makeReq(events) {
  const body = JSON.stringify({ events });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
const userEvent = (text, userId = 'U_reporter') => ({
  type: 'message', replyToken: 'rt_' + Math.random(),
  source: { type: 'user', userId }, message: { type: 'text', text }
});
const groupEvent = (text, { mentionSelf = false, groupId = 'Cgroup1' } = {}) => ({
  type: 'message', replyToken: 'rt_' + Math.random(),
  source: { type: 'group', groupId, userId: 'U_member' },
  message: {
    type: 'text', text,
    ...(mentionSelf ? { mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } } : {})
  }
});

// 把 events 表的讀取換成會丟例外的版本，跑完自動還原。
// 為什麼挑 events 表：它是 1 對 1、群組每一條路都會經過的那一張（活動清單、換場
// 判斷、按鈕辨識都要讀），而且 api/line.js 的 getAllEventRows() 沒有 try——
// 它就是「一張表出事、整支靜音」那條路的入口。
async function withBrokenSheets(fn) {
  const orig = sheets.readRange;
  sheets.readRange = async (range) => {
    if (range.startsWith('events!')) throw new Error('Quota exceeded for quota metric read requests');
    return orig(range);
  };
  try { return await fn(); } finally { sheets.readRange = orig; }
}

const isApology = t => /卡住|再問我一次/.test(String(t || ''));

console.log('── Sheets 出狀況時，1 對 1 的記者要收到一句人話 ──');
{
  reset();
  const handler = await freshModule();
  await withBrokenSheets(async () => {
    sent.length = 0;
    await handler(makeReq([userEvent('這場活動的重點是什麼？')]), res);
  });
  ok(sent.length > 0, '★ 不再是已讀不回（本次盤點實測到的 bug）');
  ok(sent.some(m => isApology(m.text)), '　 而且講得出「我卡住了，麻煩再問一次」');
  ok(sent.some(m => /新聞聯絡人/.test(m.text || '')), '　 並且給得出下一步（洽新聞聯絡人），不要讓記者乾等');
}

console.log('── 寫入失敗（綁定存不進去）一樣要有回應 ──');
{
  reset();
  const handler = await freshModule();
  const origAppend = sheets.appendRows;
  sheets.appendRows = async (range, rows) => {
    if (range.startsWith('line_users!')) throw new Error('Sheets 寫入失敗');
    return origAppend(range, rows);
  };
  try {
    sent.length = 0;
    await handler(makeReq([userEvent('#semi')]), res);
    ok(sent.some(m => isApology(m.text)), '★ 掃 QR 綁定寫不進去時，記者也收得到道歉，不是沉默');
  } finally { sheets.appendRows = origAppend; }
}

console.log('── 群組：沒被叫到就算出例外也不能插話 ──');
{
  reset();
  // 先讓續問視窗是開的——這是最容易誤觸的狀態：視窗開著、有人在聊自己的事。
  state.bindings.set('Cgroup1', { event_id: 'semi', bound_at: Date.now(), groupSessionUntil: Date.now() + 60_000 });
  const handler = await freshModule();
  await withBrokenSheets(async () => {
    sent.length = 0;
    await handler(makeReq([groupEvent('那個案子後來怎麼樣了')]), res);
  });
  ok(sent.length === 0, '★ 群組裡沒 @ 也沒喚醒詞：出錯照樣完全安靜，不會冒出一句道歉來插話');
}

console.log('── 群組：真的被叫到，出例外就要道歉 ──');
{
  reset();
  const handler = await freshModule();
  await withBrokenSheets(async () => {
    sent.length = 0;
    await handler(makeReq([groupEvent('@我 這場的重點是什麼', { mentionSelf: true })]), res);
  });
  ok(sent.some(m => isApology(m.text)), '被 @ 到卻出錯 → 要講一句話，不能讓群組以為機器人壞了');
}
{
  reset();
  const handler = await freshModule();
  await withBrokenSheets(async () => {
    sent.length = 0;
    await handler(makeReq([groupEvent('米亞 這場的重點是什麼')]), res);
  });
  ok(sent.some(m => isApology(m.text)), '用喚醒詞「米亞」叫的也算被叫到（有些人的 @ 選單裡找不到這個帳號）');
}

console.log('── 一則事件出錯，不能連累同一批的其他事件 ──');
{
  reset();
  const handler = await freshModule();
  let n = 0;
  const orig = sheets.readRange;
  sheets.readRange = async (range) => {
    // 只讓第一次讀 events 失敗，後面恢復正常
    if (range.startsWith('events!') && n++ === 0) throw new Error('暫時性錯誤');
    return orig(range);
  };
  try {
    sent.length = 0;
    await handler(makeReq([userEvent('這場活動的重點是什麼？'), userEvent('最近有哪些活動')]), res);
    ok(sent.some(m => isApology(m.text)), '第一則出錯 → 道歉');
    ok(sent.some(m => /近期活動/.test(m.text || '')), '第二則照樣答得出來，沒有被前一則的例外帶走');
  } finally { sheets.readRange = orig; }
}

console.log('── 道歉本身送不出去，也不能把例外往外丟（LINE 收到非 2xx 會重送整批）──');
{
  reset();
  const { line } = await import('./fakes.mjs');
  const handler = await freshModule();
  const origReply = line.replyOrPush;
  line.replyOrPush = async () => { throw new Error('LINE API 也掛了'); };
  try {
    let threw = false;
    await withBrokenSheets(async () => {
      try { await handler(makeReq([userEvent('這場活動的重點是什麼？')]), res); }
      catch { threw = true; }
    });
    ok(!threw, 'handler 仍然正常結束（回 200），不會觸發 LINE 的重送風暴');
  } finally { line.replyOrPush = origReply; }
}

// ── 逾時：靠讀原始碼確認，不是靠跑（批次 57）──────────────────────────────
// 為什麼用讀檔而不是模擬一個永不回應的 fetch：這幾條路的逾時真的觸發要等 10～45 秒，
// 測試不該真的等；而「有沒有帶 signal」是一個二元事實，看得出來就夠。跟
// test/kb-limit.test.mjs 用同一招（那支也是讀三個檔比對上限常數）。
//
// 沒有逾時的後果不是「慢」，是 Vercel 在 60 秒把整支 function 砍掉——沒有 catch 會
// 跑到、沒有回覆會送出，記者那邊就是已讀不回，跟上面那些情境是同一種傷害。
console.log('── 每一個對外呼叫都要有逾時 ──');
const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
for (const [file, label] of [
  ['api/line.js', '答題模型（Anthropic）'],
  ['lib/router.js', '意圖路由（Anthropic）'],
  ['lib/itri-news.js', '工研院官網新聞中心'],
  ['lib/industry-trends.js', 'IEK 產業情報網'],
  ['lib/sheets.js', 'Google Sheets']
]) {
  const text = src(file);
  const fetches = (text.match(/\bfetch\(/g) || []).length;
  ok(fetches > 0 && /AbortSignal\.timeout\(/.test(text), `${label}（${file}）有帶 AbortSignal.timeout`);
}
// 死線是共用的，不是每支各自寫死一個秒數——加起來超過 60 秒的話，寫得再合理也沒用。
{
  const text = src('api/line.js');
  ok(/REQUEST_BUDGET_MS\s*=\s*55_000/.test(text), '請求死線是 55 秒（留 5 秒給送出回覆與寫 qa_log）');
  // 死線放在 AsyncLocalStorage、不是模組層變數：同一個執行個體同時處理兩個請求時，
  // 共用變數會讓後到的把先到的死線往後推，先到的那個就會以為還很寬裕然後被砍掉。
  ok(/AsyncLocalStorage/.test(text) && /requestCtx\.run\(/.test(text),
     '死線是每個請求各自一份（AsyncLocalStorage），不是共用變數');
  ok(/function msLeft\(/.test(text) && /function budgetFor\(/.test(text), '每一段外部呼叫都問「這次請求還剩多少」，不是各自寫死');
  ok(/budgetFor\(LOOKUP_BUDGET_MS/.test(text), '★ 補查官網吃的是剩餘預算——不能讓它把已經算好的答案一起拖到被砍掉');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
