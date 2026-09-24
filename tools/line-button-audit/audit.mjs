// 按鈕盤點（批次 84）：把記者在 1 對 1 與群組會走的每一步丟進真的 api/line.js（Sheets／LINE／
// Anthropic 用 test/fakes.mjs 的假版本），印出每一則回覆最後掛了哪些快速回覆按鈕。
//   node tools/line-button-audit/audit.mjs
// 看的是「這一步之後，記者眼前剩哪些按鈕」——LINE 只顯示最後一則訊息的按鈕。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('../../test/loader.mjs', import.meta.url);
const { sent, reset } = await import('../../test/fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = process.env.LINE_BASIC_ID || '@123abcde';
const handler = (await import(new URL('../../api/line.js?audit', import.meta.url).href)).default;
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
// 1 對 1 每分鐘限 15 則（見 api/line.js rateLimited()），走一輪會超過——後半段換一個人。
let dmUser = 'Uaudit';
let groupId = 'Caudit'; // 群組同樣每分鐘限 15 則，後半段換一個群組
async function say(where, text, { mention = false } = {}) {
  const source = where === 'group' ? { type: 'group', groupId, userId: 'Ureporter' } : { type: 'user', userId: dmUser };
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source, message }]), res);
  return sent.slice();
}
async function lifecycle(where, type) {
  const source = where === 'group' ? { type: 'group', groupId } : { type: 'user', userId: dmUser };
  sent.length = 0;
  await handler(post([{ type, replyToken: 'rt' + (++seq), source }]), res);
  return sent.slice();
}
const label = (i) => (typeof i === 'object' && i ? (i.label ?? i.text) : i);
function lastButtons(out) {
  const visible = out.filter(s => s.kind === 'text' || s.kind === 'flex');
  const last = visible[visible.length - 1];
  if (!last) return null;
  if (last.kind === 'text') return (last.quickReply || []).map(label);
  const m = (last.messages || [])[last.messages.length - 1];
  return (m?.quickReply?.items || []).map(i => i.action?.label);
}
export const rows = [];
async function step(where, name, out) {
  const b = lastButtons(out);
  const visible = out.filter(s => s.kind === 'text' || s.kind === 'flex');
  const first = (visible[0]?.text || '').replace(/\s+/g, ' ').slice(0, 34);
  rows.push({ where, name, n: b ? b.length : 0, buttons: b || [], first });
  console.log(`${where === 'group' ? '群組' : '1對1'}｜${name.padEnd(14, '　')}｜${b === null ? '（沒有回覆）' : b.length ? `${b.length} 顆：${b.join('、')}` : '⚠️ 0 顆'}\n      └ ${first}`);
}

for (const where of ['dm', 'group']) {
  reset();
  console.log(`\n════ ${where === 'group' ? '群組' : '1 對 1'} ════`);
  const m = where === 'group';
  const w = (t) => (m ? '米亞 ' + t : t);
  if (m) await step(where, '入群自我介紹', await lifecycle(where, 'join'));
  else await step(where, '加好友', await lifecycle(where, 'follow'));
  if (m) await step(where, '只叫米亞', await say(where, '米亞'));
  await step(where, '最近有哪些活動', await say(where, w('最近有哪些活動')));
  await step(where, '點一場（過去的）', await say(where, '半導體先進封裝技術發表會'));
  await step(where, '問一題', await say(where, w('重點是什麼？')));
  await step(where, '其他活動', await say(where, '最近有哪些活動'));
  await step(where, '換一場', await say(where, '智慧醫療解決方案記者會'));
  await step(where, '媒體邀訪需求', await say(where, '媒體邀訪需求'));
  await step(where, '產業趨勢分析', await say(where, '產業趨勢分析'));
  await step(where, '想問什麼技術', await say(where, '想問什麼技術'));
  await step(where, '（技術名稱）', await say(where, '機器人'));
  await step(where, '使用說明', await say(where, '使用說明'));
  if (!m) dmUser = 'Uaudit2'; else groupId = 'Caudit2';
  await step(where, '找真人', await say(where, '找真人'));
  await step(where, '謝謝', await say(where, w('謝謝')));
  await step(where, '回首頁', await say(where, '回首頁'));
  await step(where, '聽不懂的話', await say(where, w('今天天氣如何')));
  await step(where, '給我完整新聞稿', await say(where, w('給我完整新聞稿')));
  await step(where, '選單（叫回按鈕）', await say(where, '選單'));
  await step(where, '在某一場時叫選單', (await say(where, '半導體先進封裝技術發表會'), await say(where, '選單')));
  if (!m) {
    dmUser = 'Uaudit3';
    await step(where, '#代碼接上', await say(where, '#semi'));
    await step(where, '按快速提問', await say(where, '這次活動的主要發表內容是什麼？'));
    dmUser = 'Uaudit4';
    await step(where, '米亞（1 對 1）', await say(where, '米亞'));
  }
}
