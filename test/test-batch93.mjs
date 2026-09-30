// 批次 93 的回歸測試：同仁反饋「資料找不到」（附截圖：邀訪窗口、瀝青、拉麵機器人）。
// 三個環節：
//   ① 「其他」綜合窗口的回覆把給同仁看的備註（「其他選項用，不會出現在主題按鈕上」）原文送給記者
//   ② 查無官網報導時只說「請洽媒體邀訪窗口」，沒有任何一個人的名字（連「機器人」的專屬窗口都沒帶出來）
//   ③ 窗口比對只看主題與單位名稱，「矽光子」這種具體技術名稱一律落到綜合窗口
// 跑真的 api/line.js（Sheets／LINE／Anthropic／工研院官網用 test/fakes.mjs 的假版本）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
const C = await import('../lib/contacts-directory.js');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b93=${++modSeq}`, import.meta.url).href)).default; }
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

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}

// 正式站實際存在試算表裡的那份種子（其他那一行的簡介就是外洩的那句備註）
const LEAKY = C.DEFAULT_CONTACTS_DIRECTORY;
const INTERNAL = /其他選項用|不會出現在主題按鈕/;

// ── 一、純函式 ────────────────────────────────────────────────────────────────
console.log('\n── 一、contacts-directory ──');
{
  const dir = C.parseContactsDirectory(LEAKY);
  const other = dir.find((c) => c.topic === '其他');
  check('種子資料的「其他」那一行簡介確實寫著給同仁看的備註（這就是外洩的來源）', INTERNAL.test(other.intro), other.intro);
  const out = C.formatGlobalContact(other);
  check('★ 綜合窗口的輸出沒有備註、標題是「綜合窗口」而不是「【其他】邀訪窗口」', !INTERNAL.test(out) && out.startsWith('【綜合窗口】') && out.includes('朱則瑋'), out);

  const [row] = C.parseContactsDirectory('生醫｜生醫所｜丁嘉琳｜03-1111111｜｜智慧醫療、醫材（內部備註：不會出現在按鈕上）相關技術');
  const fmt = C.formatGlobalContact(row);
  check('一般窗口的簡介照常顯示，但括號裡的內部備註被拿掉', fmt.includes('智慧醫療、醫材') && fmt.includes('相關技術') && !/內部備註|按鈕/.test(fmt), fmt);
  const [normal] = C.parseContactsDirectory('生醫｜生醫所｜丁嘉琳｜03-1111111｜｜智慧醫療（含遠距照護）相關技術');
  check('一般括號（不含內部字眼）不會被誤刪', C.formatGlobalContact(normal).includes('（含遠距照護）'), C.formatGlobalContact(normal));
  check('publicIntro：沒有簡介、或 null 都不會噴例外', C.publicIntro({ topic: '生醫' }) === '' && C.publicIntro(null) === '');
}
{
  const dir = C.parseContactsDirectory([
    '電光｜電光所｜郭建志｜｜｜電子、光電相關技術｜矽光子、光通訊、雷射、光',
    '材料｜材化所｜李琦瑋｜｜｜材料、化工相關技術｜瀝青',
    '機器人｜機械所｜譚宇哲｜｜｜機器人相關技術議題',
    '其他｜｜朱則瑋｜｜｜綜合'
  ].join('\n'));
  check('第 7 欄關鍵字解析（用「、」分隔，單字的不收）', JSON.stringify(dir[0].keywords) === JSON.stringify(['矽光子', '光通訊', '雷射']), JSON.stringify(dir[0].keywords));
  check('沒有第 7 欄 → keywords 是空陣列（行為跟以前完全一樣）', dir[2].keywords.length === 0);
  check('★ 「矽光子」比對到電光所', C.matchGlobalContactByText('矽光子', dir)?.name === '郭建志');
  check('★ 一整句「我想問矽光子的進展」也比對得到', C.matchGlobalContactByText('我想問矽光子的進展', dir)?.name === '郭建志');
  check('「瀝青」比對到材化所', C.matchGlobalContactByText('瀝青', dir)?.name === '李琦瑋');
  check('主題名稱優先於關鍵字（「拉麵機器人」含「機器人」→ 機器人窗口）', C.matchGlobalContactByText('拉麵機器人', dir)?.name === '譚宇哲');
  check('單字關鍵字「光」不會讓一句不相干的話被比對走', C.matchGlobalContactByText('陽光普照', dir) === null);
  check('沒填關鍵字的詞照舊比對不到（落到綜合窗口那條路）', C.matchGlobalContactByText('拉麵', dir) === null);
  check('「其他」那一行不參與比對', C.matchGlobalContactByText('其他', dir) === null);
}

// ── 二、流程：截圖的三段 ─────────────────────────────────────────────────────────
console.log('\n── 二、截圖的流程（1 對 1）──');
reset(); await fresh();
state.contactsDirectory = LEAKY;
{
  let out = await dm('Ushot', '媒體邀訪需求');
  out = await dm('Ushot', '邀訪：其他');
  out = await dm('Ushot', '矽光子');
  const t = texts(out);
  check('★ 「矽光子」比對不到窗口 → 給綜合窗口，而且沒有把給同仁的備註原文送出去', /朱則瑋/.test(t) && !INTERNAL.test(t), t);
  check('回覆寫明是綜合窗口（不是「【其他】邀訪窗口」）', /綜合窗口/.test(t) && !/【其他】/.test(t), t);
}
{
  // 同仁在後台第 7 欄補了關鍵字之後：同一句話直接對到電光所
  reset(); await fresh();
  state.contactsDirectory = LEAKY + '\n電光｜電光所｜郭建志｜03-7777777｜｜電子、光電相關技術｜矽光子、光通訊';
  await dm('Ushot2', '邀訪：其他');
  const t = texts(await dm('Ushot2', '矽光子'));
  check('★ 後台補上關鍵字「矽光子」之後 → 直接給電光所的窗口', /郭建志/.test(t) && /03-7777777/.test(t) && !/綜合窗口/.test(t), t);
}

// ── 三、查無報導：一定要留一個人 ──────────────────────────────────────────────────
console.log('\n── 三、官網查無報導時要給人（批次 81 的原則）──');
reset(); await fresh();
state.itriHtml = ''; // 官網 200 但清單是空的：查無資料
{
  const t = texts(await dm('Uroot', '工研院 瀝青'));
  check('查無報導：老實說沒找到', /沒有找到跟「瀝青」直接相關的報導/.test(t), t);
  check('★ 比對不到技術領域 → 給綜合窗口（有名字、有電話），不再只有一句「請洽媒體邀訪窗口」', /朱則瑋/.test(t) && /03-9999999/.test(t), t);
  check('沒有把備註送出去、也沒有那句沒有人名的舊話', !INTERNAL.test(t) && !/專人協助確認/.test(t), t);
}
{
  const t = texts(await dm('Ubot1', '工研院 拉麵機器人'));
  check('★ 「拉麵機器人」查無報導，但「機器人」有專屬窗口 → 給譚宇哲（不是綜合窗口）', /譚宇哲/.test(t) && /03-3333333/.test(t) && !/綜合窗口/.test(t), t);
}
reset(); await fresh();
{
  // 查到了報導、但模型判斷關聯不大（AI 回答那一支）：結尾同樣要有人
  const out = await dm('Uai', '工研院 瀝青');
  const t = texts(out);
  check('有查到報導的那一支：結尾也給綜合窗口，不是「請洽媒體邀訪窗口」', out.some((o) => o.kind === 'answer') && /朱則瑋/.test(t) && !/請洽媒體邀訪窗口/.test(t), t);
}
reset(); await fresh();
state.itriHtml = '';
state.contactsDirectory = ''; // 後台一個窗口都沒設定
{
  const t = texts(await dm('Uempty', '工研院 瀝青'));
  check('後台完全沒設定窗口 → 退回不含人名的那句話，不會編一個人出來', /請洽媒體邀訪窗口/.test(t) && !/03-\d/.test(t), t);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 93 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
