// 批次 158：企業洽案管理的「綁定 LINE 通知」。
//   朱朱截圖：在電腦上點「綁定 LINE 通知」，跳到 LINE 官網首頁。原因：連結是 LINE App 的深層連結（line.me/R/oaMessage），
//   只有手機（裝了 LINE）打得開，電腦瀏覽器會被丟到官網。
//   修：後台改成開一個綁定視窗，三種做法——手機 LINE 掃 QR、手機上直接點、電腦上加好友後複製那句話手動傳。
//   一、b2b_me 多給「那句話」與加好友連結，而且那句話就是綁定程式接受的格式
//   二、頁面：按鈕開視窗（不再是直接跳走的連結）、有 QR、有可複製的那句話、不洩漏給別人
import { register } from 'node:module';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.SITE_URL = 'https://example.itri.test';
delete process.env.B2B_SPREADSHEET_ID;
process.env.LINE_BASIC_ID = '@miatest';

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
console.log('\n── 一、b2b_me ──');
{
  let r = await post('b2b_member_save', { name: '王處長', unit: '企洽', role: 'admin', topics: '' }, asPw);
  const adminLink = r.body.link;
  r = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝' }, asKey(adminLink));
  const bdLink = r.body.link, bd = r.body.member;
  B.resetB2BState();
  const me = (await get('b2b_me', {}, asKey(bdLink))).body.me;
  const m = (await B.loadMembers({ fresh: true })).find((x) => x.id === bd.id);
  check('★ 給的那句話＝「#業務 成員代號-檢查碼」（跟綁定程式認的格式一樣）', me.line_bind_text === `#業務 ${m.id}-${B.memberBindCheck(m)}` && /^#業務 [A-Z0-9]+-[A-Z0-9]{6}$/.test(me.line_bind_text), me.line_bind_text);
  check('　 手機連結就是帶著同一句話（解碼後結尾相同）', decodeURIComponent(me.line_bind_url).endsWith(me.line_bind_text) && /^https:\/\/line\.me\/R\/oaMessage\/%40miatest\//.test(me.line_bind_url), me.line_bind_url);
  check('　 加好友連結給了（電腦上先加好友才能傳那句話）', me.line_add_url === 'https://line.me/R/ti/p/%40miatest', me.line_add_url);
  const pw = (await get('b2b_me', {}, asPw)).body.me;
  check('　 用後台密碼進來的「系統管理員」不是一個人，沒有綁定資料', pw.line_bind_url === '' && pw.line_bind_text === '' && pw.line_add_url === '');
  const other = (await get('b2b_me', {}, asKey(adminLink))).body.me;
  check('★ 每個人的那句話只有自己的（不會拿到別人的）', other.line_bind_text !== me.line_bind_text && other.line_bind_text.includes(other.id), other.line_bind_text);
  delete process.env.LINE_BASIC_ID; B.resetB2BState();
  const none = (await get('b2b_me', {}, asKey(bdLink))).body.me;
  check('　 沒設定 LINE_BASIC_ID：不給連結（按鈕就不顯示），行為跟以前一樣', none.line_bind_url === '' && none.line_add_url === '');
}

console.log('\n── 二、頁面 ──');
{
  const html = read('public/b2b.html');
  check('★ 「綁定 LINE 通知」是按鈕、開視窗，不再是直接跳走的連結（電腦上跳去 LINE 官網就是這樣來的）', /<button id="line-bind"[^>]*>綁定 LINE 通知<\/button>/.test(html) && !/<a id="line-bind"/.test(html) && /lb\.onclick = openLineBind/.test(html));
  check('　 視窗有三種做法：手機 LINE 掃 QR、手機上直接點、電腦上加好友後複製那句話', /用手機 LINE 掃這個 QR/.test(html) && /已經在手機上/.test(html) && /在電腦上或點不開/.test(html) && /id="lb-copy"/.test(html));
  check('　 QR 用站內的 /vendor/qrcode.js 畫（不靠外部服務，那句話含個人綁定碼，不能送去第三方）', /s\.src = '\/vendor\/qrcode\.js'/.test(html) && !/api\.qrserver|chart\.googleapis/.test(html));
  check('　 QR 載入失敗有退路（改用第 3 種做法），不是空白', /QR 沒載入出來，請用下面第 3 種做法/.test(html));
  check('　 提醒綁定碼只有自己能用；說明要看到「綁定完成」（跟米亞實際的回覆一致）', /請不要轉貼給別人/.test(html) && /米亞回覆「綁定完成」/.test(html) && /綁定完成/.test(read('lib/b2b-line.js')));
  check('　 伺服器給的文字都過 esc()（連結、那句話）', /href="\$\{esc\(url\)\}"/.test(html) && /\$\{esc\(text\)\}/.test(html) && /href="\$\{esc\(add\)\}"/.test(html));
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（維持 9 個，批次 177 多了 cron_remind 一天兩班）、rewrite（17 條）、Function（api/ 11 支）', vj.crons.length === 9 && vj.rewrites.length === 17 && fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
}
console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
