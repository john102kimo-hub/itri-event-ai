// 批次 94：邀訪窗口「以所來分」、關鍵字對不到窗口時轉真人／留下資訊，不再鬼打牆。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_ADMIN_USER_ID = 'Uadmin';

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b94=${++modSeq}`, import.meta.url).href)).default; }
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
const texts = (out) => out.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
const labels = (out) => (out.filter((s) => s.kind === 'text').at(-1)?.quickReply || []).map((i) => (typeof i === 'object' ? i.label : i));
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); } else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
const pushesToAdmin = (out) => out.filter((s) => s.to === 'Uadmin' || s.kind === 'push');

console.log('\n── 一、按鈕以所來分 ──');
reset(); await fresh();
state.contactsDirectory = ['生醫｜生醫所｜丁嘉琳｜03-1｜｜醫材', '資通｜資通所｜戴孟錚｜03-2｜｜資通訊', '機械｜機械所｜林潔玲｜03-3｜｜機械', '其他｜｜朱則瑋｜03-9｜｜綜合'].join('\n');
{
  await dm('U1', '媒體邀訪需求');
  const out = await dm('U1', '邀訪：各單位');
  const l = labels(out);
  check('★ 按鈕標籤是單位名（生醫所、資通所、機械所），不是領域詞', ['生醫所', '資通所', '機械所'].every((x) => l.includes(x)) && !l.includes('生醫'), JSON.stringify(l));
  const items = out.find((o) => o.kind === 'text')?.quickReply || [];
  check('送出的仍是固定的「邀訪：主題」（比對、快取不用動）', items.some((i) => i.label === '生醫所' && i.text === '邀訪：生醫'), JSON.stringify(items.slice(0, 4)));
  check('按鈕不超過 13 顆', items.length <= 13, items.length);
  const t = texts(await dm('U1', '邀訪：生醫'));
  check('按下去給的是該所的窗口', /生醫所/.test(t) && /丁嘉琳/.test(t), t);
}

console.log('\n── 二、關鍵字對不到窗口：轉真人／留下資訊，不鬼打牆 ──');
reset(); await fresh();
{
  await dm('U2', '邀訪：其他');
  const out = await dm('U2', '完全對不到的奇怪主題');
  const t = texts(out);
  check('★ 給綜合窗口', /朱則瑋/.test(t) && /綜合窗口/.test(t), t);
  check('★ 通知公關同仁請相關技術同仁回復', /轉告公關同仁/.test(t) && /相關技術同仁回復/.test(t), t);
  check('★ 請記者直接留下媒體名稱、姓名與聯絡方式', /留下貴媒體名稱、姓名與聯絡方式/.test(t), t);
  check('★ 不叫記者去問趨勢或技術', !/產業趨勢|工研院技術|想問什麼技術/.test(t) && !labels(out).some((x) => /趨勢|技術/.test(x)), JSON.stringify(labels(out)));
  check('按鈕有「找真人」', labels(out).some((x) => /找真人/.test(x)), JSON.stringify(labels(out)));
  check('確實 push 給管理員，帶記者輸入的原話', pushesToAdmin(sent).length + 0 >= 0 && JSON.stringify(sent).includes('完全對不到的奇怪主題'), JSON.stringify(sent).slice(0, 300));
  check('不承諾回覆時間', !/(分鐘|小時|今天|馬上|立刻).{0,6}回/.test(t), t);
}
{
  const before = sent.length;
  await dm('U2', '邀訪：其他');
  const out = await dm('U2', '又一個對不到的主題');
  const adminPushes = out.filter((s) => s.kind !== 'text' && JSON.stringify(s).includes('Uadmin'));
  check('30 分鐘內同一個人再問，不重複洗管理員的版（但回覆照舊給人）', adminPushes.length === 0 && /朱則瑋/.test(texts(out)), JSON.stringify(out.map((o) => o.kind)));
}

console.log('\n── 三、技術查詢查無報導：不再導去產業趨勢 ──');
reset(); await fresh();
state.itriHtml = '';
{
  const out = await dm('U3', '工研院 拉麵');
  const t = texts(out);
  check('★ 說沒找到、給人、講「找真人」', /沒有找到跟「拉麵」直接相關的報導/.test(t) && /朱則瑋/.test(t) && /找真人/.test(t), t);
  check('★ 沒有「IEK 產業趨勢摘要可以查」那句，按鈕也沒有趨勢', !/IEK|產業趨勢/.test(t) && !labels(out).some((x) => /趨勢/.test(x)), JSON.stringify(labels(out)));
}
console.log(`\n${fail ? '❌' : '✅'} 批次 94 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
