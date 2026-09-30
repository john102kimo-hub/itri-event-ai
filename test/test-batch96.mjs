// 批次 96：邀訪窗口按鈕從名單來（電光所、產業學院、中分院要看得到）、公關內部組別（技術傳播組）不對記者顯示。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
const C = await import('../lib/contacts-directory.js');
process.env.LINE_CHANNEL_SECRET = 'testsecret'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = '';
let handler, n = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b96=${++n}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events }); const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); }); return r;
}
let seq = 0;
async function dm(uid, text) { sent.length = 0; await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res); return sent.slice(); }
const qr = (out) => out.find((o) => o.kind === 'text')?.quickReply || [];
const labels = (out) => qr(out).map((i) => i.label);
const texts = (out) => out.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
let pass = 0, fail = 0;
function check(l, c, d) { if (c) { pass++; console.log(`✅ ${l}`); } else { fail++; console.log(`❌ ${l}${d !== undefined ? '\n   ' + String(d).slice(0, 500) : ''}`); } }

reset(); await fresh();
state.contactsDirectory = C.DEFAULT_CONTACTS_DIRECTORY; // 正式站那份種子：13 行＋其他，含「機器人｜技術傳播組」
{
  await dm('U1', '媒體邀訪需求');
  const p1 = await dm('U1', '邀訪：各單位');
  check('★ 單位選單第一頁不超過 13 顆，且有「更多單位」', qr(p1).length <= 13 && labels(p1).includes('➕ 更多單位'), JSON.stringify(labels(p1)));
  check('★ 技術傳播組不出現在按鈕', !JSON.stringify(labels(p1)).includes('技術傳播組'), JSON.stringify(labels(p1)));
  const p2 = await dm('U1', '邀訪：更多單位');
  const all = [...labels(p1), ...labels(p2)].join('|');
  check('★ 電光所、產業學院、中分院在第一或第二頁看得到', ['電光所', '產業學院', '中分院'].every((x) => all.includes(x)), all);
  check('第二頁不超過 13 顆、有「上一頁」與「找真人」', qr(p2).length <= 13 && labels(p2).includes('↩ 上一頁') && labels(p2).some((x) => /找真人/.test(x)), JSON.stringify(labels(p2)));
  check('第二頁「上一頁」回到單位選單、第一頁「回上一層」回到第一層', qr(p2).find((i) => i.label === '↩ 上一頁')?.text === '邀訪：各單位' && qr(p1).find((i) => i.label === '↩ 回上一層')?.text === '媒體邀訪需求');
  const dead = await dm('U1', '邀訪：電光');
  check('按「電光所」→ 給電光所的窗口', /電光所/.test(texts(dead)) && /郭建志/.test(texts(dead)), texts(dead));
  const robot = await dm('U1', '邀訪：機器人');
  check('★ 直接送「邀訪：機器人」也不會顯示技術傳播組的窗口', !/技術傳播組|譚宇哲/.test(texts(robot)), texts(robot));
}
{
  reset(); await fresh();
  state.contactsDirectory = ['生醫｜生醫所｜丁嘉琳｜03-1｜｜醫材', '機械｜機械所｜林潔玲｜03-3｜｜機械', '其他｜｜朱則瑋｜03-9｜｜綜合'].join('\n');
  await dm('U2', '媒體邀訪需求');
  const out = await dm('U2', '邀訪：各單位');
  check('單位不多時只有一頁、沒有「更多單位」', !labels(out).includes('➕ 更多單位') && labels(out).includes('生醫所') && labels(out).includes('機械所'), JSON.stringify(labels(out)));
}
{
  const dir = C.parseContactsDirectory('機器人｜技術傳播組｜譚宇哲｜03-3｜｜機器人\n其他｜｜朱則瑋｜｜｜綜合');
  check('比對不到公關內部組別（「拉麵機器人」不會對到技術傳播組）', C.matchGlobalContactByText('拉麵機器人', dir) === null);
}
console.log(`\n${fail ? '❌' : '✅'} 批次 96 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
