// 批次 167：LINE 的活動綁定 6 小時，從「最後一次在這場問答」起算，不是從掃 QR 那一刻。
//   10/28 眺望：早上 9:15 在報到處掃碼的記者，下午場（13:30–16:35）15:15 之後再問，綁定就突然沒了——
//   三分鐘前才問過，這一題卻掉到「這題我這邊查不到耶」。跑的是真的 api/line.js（Sheets／LINE／模型是假的）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 's'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = 'fake';

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 400) : ''))); };

let handler, seq = 0;
const fresh = async () => { handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 's').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const msg = (uid, text) => ({ type: 'message', replyToken: 'rt' + Math.random(), source: { type: 'user', userId: uid }, message: { type: 'text', text } });
// 每一句重新載入模組：清掉 60 秒快取與限流（真的隔了幾個小時，也不會在同一台機器的記憶體裡）
async function say(uid, text) { await fresh(); sent.length = 0; await handler(req([msg(uid, text)]), res); return sent.slice(); }
const answered = (out) => out.some((s) => s.kind === 'answer');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const H = 3600_000;

try {
  console.log('\n── 一、一直在問同一場：綁定不會在掃碼後 6 小時突然消失 ──');
  reset(); offset = 0;
  await say('U1', '#semi'); await say('U1', '略過');
  check('掃碼後馬上問：答', answered(await say('U1', '量產時程是什麼？')));
  offset = 5 * H + 50 * 60_000; // 5 小時 50 分（下午場）
  check('5 小時 50 分後再問：答', answered(await say('U1', '良率多少？')));
  offset = 6 * H + 10 * 60_000; // 掃碼後 6 小時 10 分，距離上一題 20 分鐘
  const out = await say('U1', '那成本呢？');
  check('★ 掃碼後 6 小時 10 分、上一題才 20 分鐘前：照常回答，不掉到「查不到」', answered(out) && !out.some((s) => s.kind === 'fallback'), out.map((s) => s.kind + ':' + s.text).join(' / '));

  console.log('\n── 二、TTL 本來要擋的事照樣擋 ──');
  offset = 6 * H + 10 * 60_000 + 6 * H + 60_000; // 上一題之後 6 小時 1 分
  const late = await say('U1', '良率多少？');
  check('最後一題之後超過 6 小時：綁定過期（不會被鎖在舊場次）', !answered(late), late.map((s) => s.kind).join());

  reset(); offset = 0;
  await say('U2', '#semi'); await say('U2', '略過');
  offset = 6 * H + 60_000;
  check('掃碼後一題都沒問、6 小時 1 分後才來：照舊過期', !answered(await say('U2', '良率多少？')));

  console.log('\n── 三、別的上一輪不能幫這場續命 ──');
  const { getBinding } = await import(new URL(`../lib/line-store.js?v=${++seq}`, import.meta.url).href);
  const now = Date.now();
  reset();
  const turn = (e, t) => JSON.stringify({ t, e, q: 'q', a: 'a' });
  state.bindings.set('U3', { event_id: 'semi', bound_at: now - 7 * H, lastTurn: turn('med', now - 60_000) });          // 上一輪是別場
  state.bindings.set('U4', { event_id: 'semi', bound_at: now - 7 * H, lastTurn: turn('#topic:industry_trend', now - 60_000) }); // 上一輪是產業趨勢
  state.bindings.set('U5', { event_id: 'semi', bound_at: now - 7 * H, lastTurn: turn('semi', now - 60_000) });         // 上一輪就是這場
  state.bindings.set('U6', { event_id: 'semi', bound_at: now - 7 * H, lastTurn: '{壞掉的儲存格' });
  state.bindings.set('U7', { event_id: 'semi', bound_at: 0, lastTurn: turn('semi', now - 60_000) });                   // 解除過綁定（回首頁）
  state.bindings.set('Cgrp', { event_id: 'semi', bound_at: now - 7 * H, groupTurns: JSON.stringify({ Ua: { t: now - 60_000, e: 'semi', q: 'q', a: 'a' } }) });
  state.bindings.set('Cgrp2', { event_id: 'semi', bound_at: now - 7 * H, groupTurns: JSON.stringify({ Ua: { t: now - 60_000, e: 'med', q: 'q', a: 'a' } }) });
  check('上一輪是別場：不續命', (await getBinding('U3')) === null);
  check('上一輪是產業趨勢（話題標記）：不續命', (await getBinding('U4')) === null);
  check('上一輪就是這場：續命', (await getBinding('U5'))?.event_id === 'semi');
  check('上一輪儲存格壞掉：當作沒有，照舊過期（不丟例外）', (await getBinding('U6')) === null);
  check('★ 解除過綁定（bound_at 清空）：上一輪再新也不會把綁定救回來', (await getBinding('U7')) === null);
  check('群組：有人剛在這場問過（J 欄）就續命；問的是別場不算', (await getBinding('Cgrp'))?.event_id === 'semi' && (await getBinding('Cgrp2')) === null);
} finally {
  Date.now = realNow;
}

console.log(`\n${fail ? '❌' : '✅'} 批次 167 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
