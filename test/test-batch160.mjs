// 批次 160：LINE 綁定通知之後，傳「取消綁定」要能取消。
//   朱朱截圖：綁定成功（「綁定完成 ✅ 測試A 您好」）後傳「取消綁定」，米亞把它當成新聞題，回「我可以從兩個方向幫您找…」。
//   原因：批次 119 只做了綁定，沒做取消；唯一的取消方式是管理員「重發連結」。
//   一、本人在 LINE 傳「取消綁定」→ 解除自己的綁定、之後不再推通知；稽核有記
//   二、沒綁過的人（記者、一般使用者）傳同一句 → 照原本的路徑走，不被這裡吃掉
//   三、只認整句（不會誤吃「取消綁定的新聞」這種記者的題目）；只動自己，不影響別人的綁定
//   四、綁定成功的回覆告訴他怎麼取消，而且不再叫「業務後台」（已改名企業洽案管理）
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.LINE_BASIC_ID = '@mia123';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.SITE_URL = 'https://example.itri.test';
delete process.env.B2B_SPREADSHEET_ID;

let clock = Date.UTC(2026, 9, 7, 2, 0, 0); // 2026-10-07 週三 10:00（台灣）
Date.now = () => clock;

const S = await import('./fakes-sheets82.mjs');
const F = await import('./fakes.mjs');
const B = await import('../lib/b2b.js');
const BA = await import('../lib/b2b-api.js');
const Auth = await import('../lib/auth.js');
const R = await import('../lib/registration.js');
const A = await import('../lib/audience.js');
const { BUSINESS_KB_TEMPLATE, kbHasContent } = await import('../lib/kb-template.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.send = (t) => (r.text = t, r); r.end = () => r; return r; };
let n = 0;
const ip = () => `10.153.${Math.floor(++n / 200)}.${n % 200}`;
const get = async (action, query = {}, headers = {}) => { const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': ip(), ...headers }, query: { action, ...query }, socket: {} }, r); return r; };
const post = async (action, body = {}, headers = {}) => { const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': ip(), ...headers }, query: {}, body: { action, ...body }, socket: {} }, r); return r; };
const asPw = { 'x-admin-password': 'pw' };
const asKey = (link) => ({ 'x-b2b-key': decodeURIComponent(String(link).split('#k=')[1] || '') });
const inquiry = (over = {}) => ({ company: '某某精密股份有限公司', name: '陳經理', title: '研發處長', email: 'chen@example.com', phone: '03-5912345',
  topic: '先進封裝', need: '想導入先進封裝的散熱技術，目前產線遇到熱點問題，SECRET-NEED。', consent: true, elapsed: 5000, ...over });
const page = (id, create, headers) => post('b2b_customer_page', { id, create }, headers);
const mainEvents = () => (S.book.events || []).slice(1);
const nonRead = () => S.calls.filter((c) => c[0] !== 'read').length;


process.env.B2B_SPREADSHEET_ID = 'B2B';
const fresh = () => { S.reset(); F.sent.length = 0; B.resetB2BState(); BA.resetB2BRateLimit(); Auth.resetAuthLimiter(); R.resetRegistrationState(); S.book.events = [['id']]; };
fresh();
const L = await import('../lib/b2b-line.js');
let seq = 0;
const handler = async () => (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default;
const lineRes = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
const say = async (h, text, userId) => {
  const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', text } }] });
  const req = new EventEmitter(); req.method = 'POST';
  req.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  F.sent.length = 0; await h(req, lineRes);
  return F.sent.filter((s) => !s.push || s.to === userId).map((s) => s.text || '').join('\n');
};
const members = async () => B.loadMembers({ fresh: true });
const audits = () => (S.books.B2B.b2b_audit || []).slice(1);

let a, b, adminLink;
{
  let r = await post('b2b_member_save', { name: '王處長', unit: '企洽', role: 'admin', topics: '' }, asPw);
  adminLink = r.body.link; a = r.body.member;
  r = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝' }, asKey(adminLink)); b = r.body.member;
  B.resetB2BState();
}
const h = await handler();
console.log('\n── 一、取消綁定 ──');
{
  const m = (await members()).find((x) => x.id === b.id);
  let out = await say(h, `#業務 ${m.id}-${B.memberBindCheck(m)}`, 'U_lin');
  check('（前置）綁定完成，回覆告訴他怎麼取消、不再叫「業務後台」', /綁定完成/.test(out) && /取消綁定/.test(out) && /企業洽案管理/.test(out) && !/業務後台/.test(out), out);
  check('　 綁上了：成員的 LINE 帳號是這個人', (await members()).find((x) => x.id === b.id).line_user_id === 'U_lin');
  out = await say(h, '取消綁定', 'U_lin');
  check('★ 本人傳「取消綁定」→ 回「已取消綁定」，說明洽詢仍在收件匣、怎麼重新綁', /已取消綁定/.test(out) && /林業務/.test(out) && /收件匣/.test(out) && /重新綁定/.test(out) && !/整體產業趨勢|IEK/.test(out), out);
  check('★ 成員的 LINE 帳號被清掉（之後不再推通知）；其他欄位沒動', (await members()).find((x) => x.id === b.id).line_user_id === '' && (await members()).find((x) => x.id === b.id).name === '林業務' && (await members()).find((x) => x.id === b.id).status === 'active');
  check('　 稽核有記（誰、本人在 LINE 取消）', audits().some((x) => x[2] === 'line_unbind' && x[1] === b.id && /取消綁定/.test(x[4])), JSON.stringify(audits().slice(-2)));
  F.sent.length = 0;
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE }, asKey(adminLink));
  B.resetB2BState();
  const sub = await post('b2b_inquiry_submit', { company: '某某精密', name: '陳', email: 'a@b.co', need: '十個字以上的需求內容說明在這裡', topic: '先進封裝', consent: true, elapsed: 5000 });
  check('★ 取消之後新洽詢不再推給他（推播清單裡沒有 U_lin）', sub.statusCode === 200 && !F.sent.some((s) => s.to === 'U_lin'), JSON.stringify(F.sent.map((s) => s.to)));
  out = await say(h, '取消綁定', 'U_lin');
  check('　 再傳一次：已經沒綁了 → 照原本的路徑走（不是「已取消綁定」，也不會報錯）', !/已取消綁定/.test(out), out);
}

console.log('\n── 二、沒綁過的人不受影響 ──');
{
  const out = await say(h, '取消綁定', 'U_reporter');
  check('★ 記者／一般使用者傳「取消綁定」→ 不會被企業洽案管理吃掉（照原本的路徑走）', !/已取消綁定/.test(out) && (await members()).every((x) => x.line_user_id === ''), out);
  const m = (await members()).find((x) => x.id === b.id);
  await say(h, `#業務 ${m.id}-${B.memberBindCheck(m)}`, 'U_lin2');
  const mA = (await members()).find((x) => x.id === a.id);
  await say(h, `#業務 ${mA.id}-${B.memberBindCheck(mA)}`, 'U_wang');
  await say(h, '取消綁定', 'U_lin2');
  const ms = await members();
  check('★ 只動自己：林業務取消，王處長的綁定還在', ms.find((x) => x.id === b.id).line_user_id === '' && ms.find((x) => x.id === a.id).line_user_id === 'U_wang');
}

console.log('\n── 三、只認整句 ──');
{
  const yes = ['取消綁定', '解除綁定', ' 取消 綁定 ', '取消通知', '取消LINE通知', '取消綁定LINE通知', '我要取消綁定', '請取消綁定。', '停止通知', '解綁'];
  const no = ['取消綁定的新聞', '怎麼取消綁定', '台積電取消綁定', '取消', '綁定', '取消活動', '不要', '取消報名', '工研院取消通知書', '業務綁定'];
  check('認得這些講法：' + yes.map((x) => x.trim()).join('、'), yes.every((x) => L.isUnbindAsk(x)), yes.filter((x) => !L.isUnbindAsk(x)));
  check('★ 不認這些（整句不是取消綁定）：' + no.join('、'), no.every((x) => !L.isUnbindAsk(x)), no.filter((x) => L.isUnbindAsk(x)));
}

console.log('\n── 四、沒設定 ／ 結構 ──');
{
  delete process.env.B2B_SPREADSHEET_ID; B.resetB2BState();
  const out = await say(h, '取消綁定', 'U_lin');
  check('企業洽案管理沒設定：完全不攔，照原本的路徑走（沒有 503、沒有錯誤）', !/已取消綁定/.test(out) && !/還沒啟用/.test(out), out);
  process.env.B2B_SPREADSHEET_ID = 'B2B';
  const line = read('api/line.js');
  check('取消綁定排在「#業務 綁定」之後、職員模式之前（職員、管理員自己的 LINE 綁了成員也能取消）', /handleB2BBind\(replyToken, userId, b2bBind\);[\s\S]{0,200}isUnbindAsk\(text\) && await handleB2BUnbind\(replyToken, userId\)[\s\S]{0,200}isStaffAuthenticated\(userId\)/.test(line));
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（維持 10 個，批次 177、179 多了 cron_remind 三班）、rewrite（17 條）、Function（api/ 11 支）', vj.crons.length === 10 && vj.rewrites.length === 17 && fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
}
console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
