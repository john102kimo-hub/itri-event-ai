// 批次 157：後台左欄整理（9 項→7 項）、企業場從「活動管理」分出去、「業發處」改名「企業洽案管理」。
//   一、左欄：分三區＋企業獨立；成效報告變成「問答與成效」頁的按鈕；邀訪窗口分工與記者名單健檢合成「記者與邀訪」
//   二、活動管理只留記者會與一般活動；企業場統一在企業洽案管理（有提示、新增企業場時說清楚去哪裡找）
//   三、b2b_pages（全部企業場）：只有管理員、帶編輯連結、記稽核；洽詢單一鍵建的與後台直接建的都在
//   四、畫面上不再叫「業發處」；手機選單；沒有新增 Function／排程／rewrite
// 畫面（桌機、手機、管理員／業務窗口）另用 Chromium 走過，見 docs/batches 批次 157。
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


const idx = read('public/index.html');
const b2bHtml = read('public/b2b.html');

console.log('\n── 一、左欄 ──');
{
  const side = idx.slice(idx.indexOf('<div id="sidebar">'), idx.indexOf('<!-- 手機才出現')).replace(/<!--[\s\S]*?-->/g, '');
  const items = [...side.matchAll(/<(?:button|a) class="nav-item[^"]*"[^>]*>\s*<i class="ti ti-([\w-]+)"><\/i>\s*([^<\n]+?)\s*<\/(?:button|a)>/g)].map((m) => m[2].trim());
  check('★ 左欄 6 項＋企業洽案管理 ＝ 7 項（原本 9 項）', items.join('|') === '活動管理|活動報名|彙整媒體訓練|記者與邀訪|問答與成效|AI 能見度|企業洽案管理', items.join('|'));
  const labels = [...side.matchAll(/<div class="nav-label[^"]*">([^<]+)<\/div>/g)].map((m) => m[1]);
  check('　 分四塊：活動／記者／數據／企業（企業有分隔線）', labels.join('|') === '活動|記者|數據|企業' && /<div class="nav-label sep">企業<\/div>/.test(side), labels.join('|'));
  check('★ 左欄不再有獨立的「成效報告」「記者名單健檢」「邀訪窗口分工」「業發處」', !/成效報告|記者名單健檢|邀訪窗口分工|業發處/.test(side), side.match(/成效報告|記者名單健檢|邀訪窗口分工|業發處/));
  check('　 企業洽案管理排在最下面、連到 /b2b、同分頁開', /<div class="nav-label sep">企業<\/div>\s*<a class="nav-item nav-secondary" href="\/b2b"[^>]*>\s*<i class="ti ti-briefcase"><\/i> 企業洽案管理/.test(side) && !/target=/.test(side));
  const ana = idx.slice(idx.indexOf('<div id="view-analytics"'), idx.indexOf('<div id="analytics-tabs"'));
  check('★ 成效報告變成「問答與成效」頁的按鈕（同分頁開 /report，帶得到登入狀態）', /<h1>[\s\S]*問答與成效<\/h1>/.test(ana) && /<a class="btn btn-outline" href="\/report"[^>]*>[\s\S]*成效報告（給主管）<\/a>/.test(ana) && !/target=/.test(ana));
  const con = idx.slice(idx.indexOf('<div id="view-contacts"'), idx.indexOf('全站技術主題聯絡窗口'));
  check('★ 「記者與邀訪」：邀訪窗口分工＋右上角「記者名單健檢」按鈕（同分頁開 /media.html）', /記者與邀訪<\/h1>/.test(con) && /<a class="btn btn-outline" href="\/media\.html"[^>]*>[\s\S]*記者名單健檢<\/a>/.test(con) && /data-view="contacts"/.test(side) && !/target=/.test(con));
  const more = (idx.match(/function openNavMore\(btn\) \{[\s\S]*?\n\}/) || [''])[0];
  check('手機「更多」：記者與邀訪、彙整媒體訓練、活動報名、成效報告、企業洽案管理、登出', ['記者與邀訪', '彙整媒體訓練', '活動報名', '成效報告', '企業洽案管理', '登出'].every((t) => more.includes(t)) && !/業發處/.test(more), more);
  check('　 手機底部導覽仍只有活動管理、問答與成效、AI 能見度＋更多（分區標題不佔位）', /#sidebar \.nav-item\.nav-secondary, #sidebar \.nav-label, #sidebar \.sidebar-bottom \{ display: none; \}/.test(idx) && (side.match(/<(?:button|a) class="nav-item(?![^"]*nav-secondary)[^"]*"/g) || []).length === 3);
}

console.log('\n── 二、活動管理不再有企業場 ──');
{
  check('★ 載入活動時分開：state.events 只留記者會與一般活動，企業場進 state.bizEvents（卡片、行事曆、進行中數字都只算前者）', /state\.events = all\.filter\(e => !isBusinessCard\(e\)\);\s*state\.bizEvents = all\.filter\(isBusinessCard\);/.test(idx));
  check('　 判斷沿用同一份企業場清單（isBusinessCard），沒另外猜', /function isBusinessCard\(ev\)[\s\S]{0,200}\['企業說明會', '技術媒合會', '客戶參訪', '技術交流會'\]/.test(idx));
  check('★ 活動管理上方提示「企業場共 N 場已移到企業洽案管理」，並連過去（找不到的人知道去哪）', /id=\\"biz-note\\"|id="biz-note"/.test(idx) && /已移到「<a href=\\?"\/b2b\\?">企業洽案管理<\/a>」→「客戶專屬頁」/.test(idx));
  check('　 問答分析的活動下拉仍然看得到企業場（它們的問答照常可以查）', /\.\.\.state\.events, \.\.\.bizEvents, \.\.\.archivedWithData/.test(idx));
  check('★ 在活動管理新增（或把類型改成）企業場：不再閃那張卡，並說清楚去「企業洽案管理」→「客戶專屬頁」', /const toBiz = isBusinessCard\(\{ event_type \}\);/.test(idx) && /已建立企業場（未發布）。它不在活動管理/.test(idx) && /if \(!id && data\.id && !toBiz\) flashCard\(data\.id\)/.test(idx));
}

/* ───────── 三、b2b_pages ───────── */
process.env.B2B_SPREADSHEET_ID = 'B2B';

/* ───────── 二、準備：成員與洽詢單 ───────── */
const fresh = () => { S.reset(); F.sent.length = 0; B.resetB2BState(); BA.resetB2BRateLimit(); Auth.resetAuthLimiter(); R.resetRegistrationState(); S.book.events = [['id']]; };
fresh();
let adminLink, bdLink, bd2Link, bd, bd2, admin, q1, q2, q3;
{
  let r = await post('b2b_member_save', { name: '王處長', email: 'wang@itri.example', unit: '業發處', role: 'admin', topics: '' }, asPw);
  adminLink = r.body.link; admin = r.body.member;
  r = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝' }, asKey(adminLink)); bdLink = r.body.link; bd = r.body.member;
  r = await post('b2b_member_save', { name: '張業務', unit: '材化所', role: 'bd', topics: '複合材料' }, asKey(adminLink)); bd2Link = r.body.link; bd2 = r.body.member;
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE, sla_days: '2' }, asKey(adminLink));
  B.resetB2BState();
  q1 = (await post('b2b_inquiry_submit', inquiry())).body.id;                                               // 分給林業務（先進封裝）
  q2 = (await post('b2b_inquiry_submit', inquiry({ company: '無人認領股份有限公司', topic: '', need: '想了解有沒有適合我們的技術可以合作，請與我們聯絡。', email: 'b@example.com' }))).body.id; // 沒對到領域 → 未分派
  q3 = (await post('b2b_inquiry_submit', inquiry({ company: '垃圾廣告公司', email: 'c@example.com' }))).body.id;
  await post('b2b_update', { id: q3, status: 'spam' }, asKey(adminLink));
  const owners = Object.fromEntries((S.books.B2B.b2b_inquiries || []).slice(1).map((r) => [r[0], r[12]]));
  console.log('   （洽詢單：' + JSON.stringify(owners) + '）');
}


console.log('\n── 三、b2b_pages：全部企業場（只有管理員）──');
{
  const made = await page(q1, true, asKey(bdLink)); // 洽詢單一鍵建的專屬頁
  // 後台直接建的企業場（客戶參訪）、一場記者會（不該出現）、一場已封存的企業場
  S.book.events.push(['cv1', '客戶參訪：某某集團', '#0F9E7A', '', 'active', '', '', '', '', '工研院', 'cvcode0123456789', '', '', '客戶參訪', '業務 林先生', '', '', '']);
  S.book.events.push(['m1', '某記者會', '#0F9E7A', '', 'active', '2026-12-01', '', '', '', '工研院', 'mcode0123456789ab', '', '台北', '記者會', '公關', '', '', '']);
  S.book.events.push(['old1', '舊企業說明會', '#0F9E7A', '', 'archived', '', '', '', '', '工研院', 'oldcode0123456789', '', '', '企業說明會', '', '', '', '']);
  const noAuth = await get('b2b_pages', {});
  const asBd = await get('b2b_pages', {}, asKey(bdLink));
  check('★ 沒登入 → 401；業務窗口（不是管理員）→ 403（每一列都帶編輯連結，等於一把鑰匙）', noAuth.statusCode === 401 && asBd.statusCode === 403, `${noAuth.statusCode}/${asBd.statusCode}`);
  const auditBefore = (S.books.B2B.b2b_audit || []).length;
  const r = await get('b2b_pages', {}, asKey(adminLink));
  const ids = (r.body.pages || []).map((p) => p.event_id);
  check('★ 管理員：只列企業場（專屬頁、客戶參訪、已封存的），記者會不在', r.statusCode === 200 && ids.length === 3 && ids.includes(made.body.event_id) && ids.includes('cv1') && ids.includes('old1') && !ids.includes('m1'), JSON.stringify(ids));
  check('　 已封存的排最後', ids[ids.length - 1] === 'old1', JSON.stringify(ids));
  const p1 = r.body.pages.find((p) => p.event_id === made.body.event_id), p2 = r.body.pages.find((p) => p.event_id === 'cv1');
  check('★ 洽詢單建的專屬頁帶回洽詢單與公司；後台直接建的沒有洽詢單', p1.inquiry_id === q1 && p1.company === '某某精密股份有限公司' && p2.inquiry_id === '' && p2.company === '', JSON.stringify([p1, p2]));
  check('　 每列有客戶頁面網址與編輯連結（編輯碼來自活動表）', /^https:\/\/example\.itri\.test\/event\?id=cv1$/.test(p2.page_url) && /\/edit\?id=cv1&code=cvcode0123456789$/.test(p2.edit_url), p2.edit_url);
  check('★ 列出全部編輯連結要留稽核（誰、列了幾場）', (S.books.B2B.b2b_audit || []).length === auditBefore + 1 && (S.books.B2B.b2b_audit || []).some((a) => a[2] === 'list_pages' && a[4] === '3'), JSON.stringify((S.books.B2B.b2b_audit || []).slice(-1)));
  check('　 沒有洩漏洽詢單的個資（聯絡人、Email、需求）', !/chen@example|SECRET-NEED|陳經理/.test(JSON.stringify(r.body)));
}

console.log('\n── 四、畫面與結構 ──');
{
  check('/b2b：標題、頁首都叫「企業洽案管理」，管理員多一個「客戶專屬頁」分頁', /<title>企業洽案管理<\/title>/.test(b2bHtml) && /<h1>企業洽案管理<\/h1>/.test(b2bHtml) && /ME\.admin \? \[\['pages', '客戶專屬頁'\]/.test(b2bHtml) && /call\('GET', 'b2b_pages'\)/.test(b2bHtml));
  check('　 「客戶專屬頁」分頁的編輯、開啟頁面開新分頁（編輯碼就是憑證，不靠後台登入）', /href="\$\{esc\(p\.edit_url\)\}" target="_blank"/.test(b2bHtml) && /href="\$\{esc\(p\.page_url\)\}" target="_blank"/.test(b2bHtml));
  const visible = ['public/index.html', 'public/b2b.html', 'public/edit.html', 'public/registrations.html', 'lib/b2b-api.js', 'lib/b2b-line.js'].map((f) => [f, read(f).replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => /業發處/.test(l) && !/^\s*(\/\/|\/\*|\*|<!--)/.test(l) && !/(\/\/|<!--).*業發處/.test(l))]).filter(([, ls]) => ls.length);
  check('★ 使用者看得到的文字不再叫「業發處」（註解與紀錄不算）', visible.length === 0, JSON.stringify(visible).slice(0, 400));
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（維持 10 個，批次 177、178 多了 cron_remind 三班）、rewrite（17 條）、Function（api/ 11 支）', vj.crons.length === 10 && vj.rewrites.length === 17 && fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
