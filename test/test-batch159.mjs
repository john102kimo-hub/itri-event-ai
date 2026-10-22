// 批次 159：同仁自己新增洽案，以及業務窗口第一次進來的引導。
//   朱朱截圖：一般同仁進企業洽案管理看到空的收件匣，第一印象看不懂；問能不能讓他們自己新增洽案，不是只能等廠商填。
//   一、權限與歸屬：沒登入 401；業務窗口新增的一律自己承辦（塞別人無效）；管理員可指定或自動分派並通知對方
//   二、必填與不寫髒資料：公司、聯絡人、Email／電話至少一項、需求、勾「對方同意聯絡」——缺任何一項都不寫入
//   三、寫進去的東西：來源「業務新增」、個資同意時間、預設「已聯繫過」、稽核；不需要線上收件開著
//   四、頁面：「＋新增洽案」、空收件匣的使用說明（有洽詢就不佔位）、Email 空的不出壞連結；沒有新增 Function／排程／rewrite
import { register } from 'node:module';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
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
let adminLink, bdLink, bd2Link, bd, bd2, admin;
{
  let r = await post('b2b_member_save', { name: '王處長', unit: '企洽', role: 'admin', topics: '' }, asPw);
  adminLink = r.body.link; admin = r.body.member;
  r = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝' }, asKey(adminLink)); bdLink = r.body.link; bd = r.body.member;
  r = await post('b2b_member_save', { name: '張業務', unit: '材化所', role: 'bd', topics: '複合材料' }, asKey(adminLink)); bd2Link = r.body.link; bd2 = r.body.member;
  B.resetB2BState();
}
const rowsNow = () => (S.books.B2B.b2b_inquiries || []).slice(1);
const audits = () => (S.books.B2B.b2b_audit || []).slice(1);
const mk = (over = {}) => ({ company: '展場遇到的公司', name: '陳經理', title: '研發處長', email: 'chen@example.com', phone: '', topic: '先進封裝', need: '展場看了散熱模組，想導入產線，下週電話細談', contact_ok: true, ...over });

console.log('\n── 一、權限與歸屬 ──');
{
  const none = await post('b2b_inquiry_create', mk(), {});
  check('★ 沒登入 → 401，沒寫任何東西', none.statusCode === 401 && rowsNow().length === 0);
  const r = await post('b2b_inquiry_create', mk(), asKey(bdLink));
  const row = rowsNow()[0] || [];
  check('★ 業務窗口新增 → 成功，而且自己承辦', r.statusCode === 200 && r.body.ok === true && r.body.owner === bd.id && row[12] === bd.id, JSON.stringify(r.body));
  const sneaky = await post('b2b_inquiry_create', mk({ company: '想塞給別人', owner: bd2.id }), asKey(bdLink));
  const row2 = rowsNow().find((x) => x[1] === '想塞給別人' || x.includes('想塞給別人')) || [];
  check('★ 業務窗口想把洽案塞給別人 → 無效，還是自己承辦（指派是管理員的事）', sneaky.statusCode === 200 && sneaky.body.owner === bd.id && row2[12] === bd.id, JSON.stringify(sneaky.body));
  const mine = (await get('b2b_list', {}, asKey(bdLink))).body.inquiries.map((q) => q.company);
  const theirs = (await get('b2b_list', {}, asKey(bd2Link))).body.inquiries.map((q) => q.company);
  check('★ 自己的收件匣看得到；別的業務窗口看不到（跟廠商填的同一道牆）', mine.includes('展場遇到的公司') && !theirs.includes('展場遇到的公司'), JSON.stringify({ mine, theirs }));
  check('　 自己新增、自己承辦：不推 LINE 通知給自己', F.sent.length === 0, JSON.stringify(F.sent));
  const asAdmin = await post('b2b_inquiry_create', mk({ company: '管理員指定', owner: bd2.id }), asKey(adminLink));
  check('★ 管理員可以指定承辦人', asAdmin.statusCode === 200 && asAdmin.body.owner === bd2.id, JSON.stringify(asAdmin.body));
  const auto = await post('b2b_inquiry_create', mk({ company: '自動分派', topic: '複合材料', need: '想了解複合材料在車用的應用，已經約好下週拜訪' }), asKey(adminLink));
  check('　 管理員不指定 → 依技術領域自動分派（複合材料 → 張業務）', auto.body.owner === bd2.id, JSON.stringify(auto.body));
  const badOwner = await post('b2b_inquiry_create', mk({ company: '亂指派', owner: 'ZZZZZ' }), asKey(adminLink));
  check('　 指定一個不存在的承辦人 → 400，不寫入', badOwner.statusCode === 400 && !rowsNow().some((x) => x.includes('亂指派')), JSON.stringify(badOwner.body));
  const pwAdmin = await post('b2b_inquiry_create', mk({ company: '密碼進來的' }), asPw);
  check('　 用後台密碼進來的「系統管理員」也能新增（沒有承辦人時依領域自動分派）', pwAdmin.statusCode === 200 && pwAdmin.body.owner === bd.id, JSON.stringify(pwAdmin.body));
}

console.log('\n── 二、必填：缺一項都不寫入 ──');
{
  const before = rowsNow().length;
  const bad = async (over, re, label) => {
    const r = await post('b2b_inquiry_create', mk(over), asKey(bdLink));
    check(label, r.statusCode === 400 && re.test(r.body.error) && rowsNow().length === before, JSON.stringify(r.body));
  };
  await bad({ company: ' ' }, /公司/, '沒填公司 → 400');
  await bad({ name: '' }, /聯絡人/, '沒填聯絡人 → 400');
  await bad({ email: '', phone: '' }, /至少填一項/, '★ Email 與電話都沒有 → 400（之後聯絡不到對方）');
  await bad({ email: 'not-an-email' }, /Email/, 'Email 格式錯 → 400');
  await bad({ email: '', phone: 'abc' }, /電話/, '電話格式錯 → 400');
  await bad({ need: '嗯' }, /需求/, '需求只寫一個字 → 400');
  await bad({ contact_ok: false }, /同意/, '★ 沒勾「對方知道並同意工研院聯絡」→ 400');
  await bad({ contact_ok: 'true' }, /同意/, '　 勾選值一定要是真正的 true（字串不算）');
  const phoneOnly = await post('b2b_inquiry_create', mk({ company: '只有電話', email: '', phone: '0912-345-678' }), asKey(bdLink));
  check('★ 名片上只有電話也行（Email 與電話擇一）', phoneOnly.statusCode === 200, JSON.stringify(phoneOnly.body));
}

console.log('\n── 三、寫進去的東西 ──');
{
  fresh();
  const mem = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝' }, asPw);
  const link = mem.body.link;
  // 線上收件關著、個資告知沒填：廠商填的表單會擋，同仁自己新增不受影響
  const pub = await post('b2b_inquiry_submit', { company: 'x', name: 'y', email: 'a@b.co', need: '十個字以上的需求內容在這裡', consent: true, elapsed: 5000 });
  check('（對照）沒填個資告知時，廠商那一邊送不出去', pub.statusCode === 503, JSON.stringify(pub.body));
  const now0 = Date.now();
  const r = await post('b2b_inquiry_create', mk(), asKey(link));
  const row = rowsNow()[0] || [];
  const q = (await get('b2b_get', { id: r.body.id }, asKey(link))).body.inquiry;
  check('★ 線上收件沒開也能新增（同仁自己新增不靠那個開關）', r.statusCode === 200 && rowsNow().length === 1, JSON.stringify(r.body));
  check('　 來源「業務新增」、個資同意時間有記、預設「已聯繫過」且首次聯繫時間＝現在', q.source === '業務新增' && !!q.consent_at && q.status === 'contacted' && !!q.first_contact_at, JSON.stringify(q));
  check('　 有聯繫期限（跟一般洽詢同一套天數）', !!q.due_at && q.overdue === false);
  const waiting = await post('b2b_inquiry_create', mk({ company: '之後再聯絡', status: 'new' }), asKey(link));
  const q2 = (await get('b2b_get', { id: waiting.body.id }, asKey(link))).body.inquiry;
  check('　 選「待聯繫」→ 狀態 new、沒有首次聯繫時間（會依期限提醒）', q2.status === 'new' && !q2.first_contact_at, JSON.stringify(q2));
  const a = audits().filter((x) => x[2] === 'create');
  check('★ 稽核：誰新增、已確認對方同意、承辦人', a.length === 2 && /已確認對方同意聯絡/.test(a[0][4]) && a[0][1] === mem.body.member.id, JSON.stringify(a));
  check('　 只寫洽詢那本（B2B 那本的 b2b_ 分頁），記者會那本的活動表一個字沒動', S.calls.filter((c) => c[0] !== 'read').every((c) => /^B2B\/b2b_/.test(String(c[1]))) && (S.book.events || []).length === 1, JSON.stringify(S.calls.filter((c) => c[0] !== 'read').map((c) => c[1]).filter((r) => !/^B2B\/b2b_/.test(String(r)))));
}

console.log('\n── 四、頁面與結構 ──');
{
  const html = read('public/b2b.html');
  check('★ 收件匣有「＋ 新增洽案」，業務窗口與管理員都看得到（不限管理員）', /id="new-q"[^>]*>＋ 新增洽案</.test(html) && /\$\('new-q'\)\.onclick = \(\) => openNewInquiry\(\)/.test(html) && !/ME\.admin[^\n]{0,80}new-q/.test(html));
  check('　 表單：公司、聯絡人、職稱、技術領域、Email、電話、需求、狀態；管理員多「承辦人」；一定要勾對方同意', ['nq-company', 'nq-name', 'nq-title', 'nq-topic', 'nq-email', 'nq-phone', 'nq-need', 'nq-status', 'nq-ok'].every((i) => html.includes(`id="${i}"`)) && /\$\{ME\.admin \? `<div><label class="f" for="nq-owner">/.test(html) && /contact_ok: \$\('nq-ok'\)\.checked/.test(html));
  check('★ 空收件匣的使用說明：兩個來源（廠商填、自己新增）、回覆期限、綁定 LINE、建專屬頁；有洽詢就不佔位', /function startGuide\(\)/.test(html) && /廠商自己填洽詢單/.test(html) && /您自己新增/.test(html) && /回覆期限/.test(html) && /\$\{INBOX\.length \? '' : startGuide\(\)\}/.test(html));
  check('　 空收件匣的那行字不再只丟一個網址，改成指路', !/還沒有洽詢。廠商的洽詢單網址/.test(html) && /看下面的說明，或直接按右上角「＋ 新增洽案」/.test(html));
  check('　 Email 是空的（只有電話的洽案）不產生壞掉的 mailto 連結', /\$\{q\.email \? `<a href="mailto:/.test(html));
  check('　 表單裡伺服器給的文字（技術領域選項、承辦人名）都過 esc()', /<option value="\$\{esc\(t\)\}">/.test(html) && /<option value="\$\{esc\(m\.id\)\}">\$\{esc\(m\.name\)\}/.test(html));
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（7 個）、rewrite（17 條）、Function（api/ 11 支）', vj.crons.length === 7 && vj.rewrites.length === 17 && fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
}
console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
