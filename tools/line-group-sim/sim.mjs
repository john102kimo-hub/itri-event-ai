// 群組對話情境模擬（批次 83）：一個真實的記者群組會出現的訊息，照時間順序丟進真的
// api/line.js，把米亞每一句的反應印出來。Sheets／LINE／Anthropic 用 test/fakes.mjs 的假版本。
// ⚠️ AI 回答與 AI 路由是假的（fakes.mjs 的簡化規則），這支看的是規則層：誰會被回、
// 誰會被安靜略過、回的時候有沒有引用、按鈕、推播。
//   node tools/line-group-sim/sim.mjs
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('../../test/loader.mjs', import.meta.url);
const { sent, state, reset } = await import('../../test/fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 's'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = '';

let handler, seq = 0;
const fresh = async () => { handler = (await import(new URL(`../../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 's').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const G = 'Cpressgroup';
let qn = 0;
function groupMsg(uid, text, { mention = false, mentionOther = false } = {}) {
  const message = { type: 'text', id: 'm' + (++qn), quoteToken: 'q' + qn, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  if (mentionOther) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Uother', isSelf: false }] };
  return { type: 'message', replyToken: 'rt' + qn, source: { type: 'group', groupId: G, userId: uid }, message, webhookEventId: 'w' + qn };
}
const chipText = (q) => (q || []).map(c => typeof c === 'object' ? (c.text || c.label) : c).join('｜');
async function say(uid, text, opts = {}) {
  sent.length = 0;
  const ev = opts.raw || groupMsg(uid, text, opts);
  await handler(req([ev]), res);
  console.log(`\n**${uid}：${text}**${opts.note ? `　_（${opts.note}）_` : ''}`);
  if (!sent.length) console.log('> （安靜）');
  for (const s of sent) {
    const body = s.text ?? (s.messages ? s.messages.map(x => x.altText || x.text || x.type).join(' / ') : '');
    console.log(`> ［${s.kind}${s.via ? '・' + s.via : ''}${s.quoteToken ? '・引用 ' + s.quoteToken : ''}］ ${String(body).replace(/\n+/g, '⏎').slice(0, 160)}`);
    if (s.quickReply?.length) console.log('>   按鈕：' + chipText(s.quickReply).slice(0, 160));
  }
  return sent.slice();
}

reset(); await fresh();
console.log('# 群組對話模擬\n');
sent.length = 0;
await handler(req([{ type: 'join', replyToken: 'rtjoin', source: { type: 'group', groupId: G } }]), res);
console.log('**（米亞被拉進群組）**'); for (const s of sent) console.log(`> ［${s.kind}］ ${String(s.text || '').replace(/\n+/g, '⏎').slice(0, 120)}…`);
await say('U王', '@米亞 最近有哪些活動', { mention: true });
await say('U王', '半導體先進封裝技術發表會', { note: '按清單按鈕' });
await say('U李', '這場的重點是什麼？', { note: '另一位記者接著問，沒 @' });
await say('U陳', '我晚點到喔', { note: '閒聊' });
await say('U王', '那良率呢？', { note: '王追問自己的上一題' });
await say('U陳', '你明天幾點到？', { note: '問群組裡另一個人' });
await say('U李', '@小明 你有拿到資料嗎', { mentionOther: true, note: '@ 別人' });
await say('U陳', '哈哈好喔');
await say('U李', '有照片可以用嗎？');
await say('U王', '給我完整新聞稿');
await say('U林', 'Is there an English press release?');
await say('U林', '米亞 謝謝', { note: '用喚醒詞' });
await say('U陳', '大家中午吃什麼？');
await say('U王', '找真人');
