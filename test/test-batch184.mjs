// 批次 184：路由只剩一個候選、只是沒把握時，不要反問「這幾場的哪一場」（只列一個選項）——直接用那一場答。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
delete process.env.LINE_ADMIN_USER_ID;

const handler = (await import('../api/line.js')).default;
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
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
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res);
  return sent.slice();
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

const KB = '【新聞稿全文】儲電新技術發表會：工研院今日發表新一代儲電技術，預計 2027 年第二季量產。\n新聞聯絡人：王小明';
reset();
state.events.length = 0;
state.events.push(['semi', '半導體記者會', '#0F9E7A', KB, 'active', isoOffset(3), '', '', '', '工研院', 'code_semi', '10:00', '南港展覽館', '記者會', '王小明 0912-345-678', '', '', '']);

const out = await dm('Ureporter1', '低信心單一候選 半導體的場次');
const all = JSON.stringify(out);
check('只有一個候選、沒把握：不再反問「這幾場的哪一場」', !all.includes('這幾場的哪一場'), all);
check('直接回答那一場', out.some(s => s.kind === 'answer'), all);

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
