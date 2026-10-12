// 批次 124 的米亞那一半：記者打招呼時自報媒體（「你好，我是聯合報記者」），米亞記下來、招呼語帶上稱呼，
// 之後問第一題不再補問「方便留個貴媒體的名稱嗎」——以前一開口就講了，米亞照樣再問一次。
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
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

const { mediaFromGreeting } = await import('../lib/line-chitchat.js');

let handler, modSeq = 0;
// ?v=N 讓整個 lib/ 模組圖都重載（職員名單、line_users 等模組層快取一起清掉，見 test/loader.mjs）
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
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
async function g(gid, uid, text) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text, mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
const allText = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
const ASK_NAME_RE = /方便留個貴媒體的名稱嗎/;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}

// ═══ 一、從招呼裡抽媒體名稱 ═══════════════════════════════════════════════════
console.log('── 一、從招呼裡抽媒體名稱（只在有職稱時才認，寧可漏也不要記錯）──');
{
  const cases = [
    ['你好，我是聯合報記者', '聯合報'],
    ['哈囉，這邊是 TVBS 林記者', 'TVBS'],
    ['您好 我是經濟日報的王小明記者', '經濟日報'],
    ['我是自由時報記者！', '自由時報'],
    ['嗨～我是中央社編輯', '中央社'],
    ['你好，我是王小明', ''],                       // 人名，不是媒體
    ['你好，我是記者', ''],                         // 只有職稱
    ['嗨，我是一名記者', ''],
    ['你好', ''],
    ['你好，我是聯合報記者想問固態電池', ''],        // 後面還接著問題：不猜
    ['這邊是 TVBS 新聞部', '']                      // 沒有職稱：不猜
  ];
  const wrong = cases.filter(([t, want]) => mediaFromGreeting(t) !== want).map(([t, want]) => `${t} → ${JSON.stringify(mediaFromGreeting(t))}（應為 ${JSON.stringify(want)}）`);
  check(`★ ${cases.length} 種招呼：抽得出媒體的抽出來、人名／只有職稱／後面還有問題的一律不猜`, wrong.length === 0, wrong.join('\n   '));
}

// ═══ 二、1 對 1 走一輪 ════════════════════════════════════════════════════════
console.log('\n── 二、1 對 1：一開口就講了媒體，之後就不再補問 ──');
reset(); await fresh();
{
  let out = await dm('U_paper', '你好，我是聯合報記者');
  check('★ 招呼語帶上稱呼：「聯合報您好，我是米亞…」', /^聯合報您好，我是米亞/.test(out[0]?.text || ''), out[0]?.text);
  check('★ 媒體記下來了（加好友後第一句就講，沒有綁定也記得住）', state.bindings.get('U_paper')?.media_name === '聯合報', JSON.stringify(state.bindings.get('U_paper')));
  check('　 只記媒體，不會因此變成「綁定了某一場」', !state.bindings.get('U_paper')?.event_id && !state.bindings.get('U_paper')?.bound_at);
  out = await dm('U_paper', '奈米材料前瞻應用發表會幾點開始？');
  check('　 接著問活動：照常回答', out.length > 0 && !/我沒抓到/.test(allText(out)), allText(out));
  check('★ 不再補問「方便留個貴媒體的名稱嗎」（以前一開口講了，問完第一題又被問一次）', !ASK_NAME_RE.test(allText(out)), allText(out));
  check('　 媒體名稱還在（軟綁定沿用，不會被洗掉）', state.bindings.get('U_paper')?.media_name === '聯合報' && state.bindings.get('U_paper')?.event_id === 'soon', JSON.stringify(state.bindings.get('U_paper')));

  // 對照組：只說「你好」的人，問完第一題照舊會被問一次
  await dm('U_ctl', '你好');
  check('（對照）只說「你好」：照舊是原本的自我介紹，沒有記任何媒體', !state.bindings.get('U_ctl')?.media_name);
  out = await dm('U_ctl', '奈米材料前瞻應用發表會幾點開始？');
  check('（對照）問完第一題照舊補問一次媒體名稱——上面那條「不再補問」才有意義', ASK_NAME_RE.test(allText(out)), allText(out));

  out = await dm('U_name', '你好，我是王小明');
  check('★ 「你好，我是王小明」是人名：不記成媒體，招呼語照舊', /^您好，我是米亞/.test(out[0]?.text || '') && !state.bindings.get('U_name')?.media_name, out[0]?.text);

  // 之前按過「略過」的人，後來自我介紹了 → 改成他講的媒體
  state.bindings.set('U_skip', { event_id: '', media_name: '（未提供）', bound_at: 0, note: '' });
  await dm('U_skip', '哈囉，這邊是 TVBS 林記者');
  check('　 之前按過「略過」，後來自己講了 → 改成他講的（TVBS）', state.bindings.get('U_skip')?.media_name === 'TVBS', state.bindings.get('U_skip')?.media_name);

  // 綁定中（掃了 QR、問過某一場）打招呼自報媒體 → 一樣記下來
  state.bindings.set('U_bound', { event_id: 'semi', media_name: '', bound_at: Date.now(), note: '' });
  out = await dm('U_bound', '您好，我是經濟日報記者');
  check('★ 綁定中打招呼自報媒體：一樣記下來、招呼語帶稱呼，綁定不受影響', state.bindings.get('U_bound')?.media_name === '經濟日報' && state.bindings.get('U_bound')?.event_id === 'semi' && /^經濟日報您好/.test(out[0]?.text || ''), JSON.stringify([state.bindings.get('U_bound'), out[0]?.text]));
}

// ═══ 三、群組與職員不記 ═══════════════════════════════════════════════════════
console.log('\n── 三、群組與職員：不記 ──');
reset();
state.staff.push(['U_col', '小美', '2026-09-01', '']);   // 職員名單要在第一則訊息之前放好（lib/staff.js 會快取）
await fresh();
{
  await dm('U_col', '你好，我是聯合報記者');
  check('　 職員模式：不記（同仁自己測試時常這樣打）', !state.bindings.get('U_col')?.media_name, JSON.stringify(state.bindings.get('U_col')));

  await g('Cpress', 'U_g1', '你好，我是聯合報記者');
  const rows = [...state.bindings.entries()].filter(([, b]) => b.media_name);
  check('★ 群組裡講「我是聯合報記者」：不記（一個群組裡是好幾家媒體，記到群組或個人身上都不對）', rows.length === 0, JSON.stringify(rows));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 124（米亞・招呼記媒體）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
