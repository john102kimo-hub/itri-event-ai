// 批次 98：LINE 問答由 Sonnet 5 升級到 Sonnet 5.5；路由維持 Haiku。
// 5.5 拒收 thinking:{type:'disabled'}（400），一旦又送出去，記者會全部收到「無法取得回應」——假的 Anthropic
// 不會回 400，所以這裡直接檢查送出去的請求內容。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = '';

const bodies = [];
const stub = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.anthropic.com')) bodies.push(JSON.parse(opts.body));
  return stub(url, opts);
};
let handler, n = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b98=${++n}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events }); const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); }); return r;
}
let seq = 0;
async function dm(uid, text) { sent.length = 0; bodies.length = 0; await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res); return sent.slice(); }
let pass = 0, fail = 0;
function check(l, c, d) { if (c) { pass++; console.log(`✅ ${l}`); } else { fail++; console.log(`❌ ${l}${d !== undefined ? '\n   ' + String(d).slice(0, 400) : ''}`); } }

reset(); await fresh();
state.bindings.set('Ubound', { event_id: 'quad', media_name: '中央社', note: '', bound_at: Date.now() });
const out = await dm('Ubound', '這場的重點是什麼？');
const answer = bodies.find((b) => (b.system?.[0]?.text || '').includes('【本次活動背景資料】'));
check('回答有送出（活動問答）', out.some((o) => o.kind === 'answer'), JSON.stringify(out.map((o) => o.kind)));
check('★ 活動問答用 claude-sonnet-5-5', answer?.model === 'claude-sonnet-5-5', answer?.model);
check('★ 沒有送 thinking:{type:"disabled"}（5.5 會 400）', answer?.thinking?.type !== 'disabled', JSON.stringify(answer?.thinking));
check('延伸思考關掉的寫法是 between_tools，且沒帶其他欄位', JSON.stringify(answer?.thinking) === '{"type":"between_tools"}', JSON.stringify(answer?.thinking));
check('沒送 temperature／top_p／top_k（5.5 不收非預設值）', !('temperature' in answer) && !('top_p' in answer) && !('top_k' in answer));
check('沒有 tool_choice（5.5 不收強制工具）', !('tool_choice' in answer));
const route = bodies.find((b) => (b.system?.[0]?.text || '').includes('意圖判斷器'));
check('路由用 Haiku 5.5（批次 120 起），且明確關掉 thinking', !route || (route.model === 'claude-haiku-5-5' && route.thinking?.type === 'disabled'), JSON.stringify([route?.model, route?.thinking]));
console.log(`\n${fail ? '❌' : '✅'} 批次 98 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
