// 批次 119（業發處第 1 步）：合作洽詢單、自動分派、期限提醒、個人連結與稽核、米亞只指路。
//   一、沒設定 B2B_SPREADSHEET_ID 就整套停用（fail-closed），而且絕不寫進記者會那本
//   二、成員：個人連結（只存雜湊）、角色、重發連結、停用
//   三、洽詢單：個資告知沒填不收件、要勾同意、蜜罐與限流；依技術領域分派、LINE 通知只帶編號與期限
//   四、收件匣：業務窗口只看自己的、看了記稽核、改狀態／改派／備註
//   五、期限提醒：過期才提醒、同一天不重複、逾期一個工作天再通知管理員
//   六、米亞：「#業務」綁定通知、「企業合作洽詢」只回洽詢單網址
//   七、企業場報名勾「希望業務窗口與我聯繫」→ 轉一筆洽詢
//   八、頁面與部署設定
//   九、業發處出狀況，不能拖累記者那邊：企業場的 AI 金鑰出事的通知、個人連結連錯的次數，都跟記者那邊分開算
// 跑的是真的 api/*.js 與 lib/*.js；Sheets（兩本）、LINE 是假的（loader-reg：fakes-sheets82 ＋ fakes.mjs 的 LINE）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
register('./loader-reg.mjs', import.meta.url);

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.LINE_BASIC_ID = '@mia123';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.CRON_SECRET = 'cron-secret';
process.env.EVENTS_TABLE_TTL_MS = '0';
delete process.env.B2B_SPREADSHEET_ID;

// 假時鐘：2026-10-07（週三）上午 10:00 台灣時間。期限、工作天都靠它
let clock = Date.UTC(2026, 9, 7, 2, 0, 0);
Date.now = () => clock;
const setTaipei = (y, mo, d, h) => { clock = Date.UTC(y, mo - 1, d, h - 8, 0, 0); };

const S = await import('./fakes-sheets82.mjs');
const F = await import('./fakes.mjs');
const B = await import('../lib/b2b.js');
const BA = await import('../lib/b2b-api.js');
const A = await import('../lib/auth.js');
const R = await import('../lib/registration.js');
const RA = await import('../lib/registration-api.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function res() {
  const r = { statusCode: 200, headers: {} };
  r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r);
  r.status = (c) => (r.statusCode = c, r);
  r.json = (o) => (r.body = o, r);
  r.send = (t) => (r.text = t, r);
  r.end = () => r;
  return r;
}
let ipSeq = 0;
const ip = () => `10.2.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;
async function get(action, query = {}, headers = {}) {
  const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': ip(), ...headers }, query: { action, ...query }, socket: {} }, r); return r;
}
async function post(action, body = {}, headers = {}, from = ip()) {
  const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': from, ...headers }, query: {}, body: { action, ...body }, socket: {} }, r); return r;
}
const asAdminPw = { 'x-admin-password': 'pw' };
const asKey = (link) => ({ 'x-b2b-key': decodeURIComponent(String(link).split('#k=')[1] || '') });
const pushesTo = (uid) => F.sent.filter((s) => s.push && s.to === uid).map((s) => s.text);
const freshAll = () => { S.reset(); F.sent.length = 0; B.resetB2BState(); BA.resetB2BRateLimit(); A.resetAuthLimiter(); R.resetRegistrationState(); RA.resetRateLimit(); };
const inquiry = (over = {}) => ({ company: '某某精密股份有限公司', name: '陳經理', title: '研發處長', email: 'chen@example.com', phone: '03-5912345',
  topic: '先進封裝', need: '想導入先進封裝的散熱技術，目前產線遇到熱點問題，希望了解技轉方式。', consent: true, elapsed: 5000, ...over });

/* ───────── 一、沒設定就整套停用 ───────── */
console.log('\n── 一、fail-closed：沒設定 B2B_SPREADSHEET_ID ──');
freshAll();
{
  const cfg = await get('b2b_public_config');
  check('洽詢單：顯示暫停收件（open=false）', cfg.statusCode === 200 && cfg.body.open === false);
  const sub = await post('b2b_inquiry_submit', inquiry());
  const anyB2bTab = [S.book, ...Object.values(S.books)].some((b) => Object.keys(b).some((t) => t.startsWith('b2b')));
  check('★ 送出 → 503，而且哪一本試算表都沒有 b2b 分頁（絕不退回寫進記者會那本）', sub.statusCode === 503 && !anyB2bTab, JSON.stringify({ s: sub.statusCode, main: Object.keys(S.book), books: Object.keys(S.books) }));
  const me = await get('b2b_me', {}, asAdminPw);
  check('　 後台 → 503 not_configured（不是 500）', me.statusCode === 503 && me.body.code === 'not_configured', JSON.stringify(me.body));
}

process.env.B2B_SPREADSHEET_ID = 'B2B';

/* ───────── 二、成員 ───────── */
console.log('\n── 二、成員與個人連結 ──');
freshAll();
let adminLink, bdLink, bd2Link, bd, bd2, admin;
{
  const r = await post('b2b_member_save', { name: '王處長', email: 'wang@itri.example', unit: '業發處', role: 'admin', topics: '' }, asAdminPw);
  adminLink = r.body.link; admin = r.body.member;
  check('後台管理員密碼可以建第一位成員（管理員），拿到個人連結（代碼放在 # 後面，不進伺服器紀錄）', r.statusCode === 200 && /\/b2b\?openExternalBrowser=1#k=/.test(adminLink) && admin.role === 'admin', JSON.stringify(r.body));
  const key = decodeURIComponent(adminLink.split('#k=')[1]);
  const row = S.books.B2B.b2b_members[1];
  check('★ 試算表只存連結的雜湊，任何一格都找不到連結原文', row && !row.some((c) => String(c).includes(key)) && row[6] === B.hashKey(key), JSON.stringify(row));
  check('　 成員資料在業發處那本，記者會那本沒有', !!S.books.B2B.b2b_members && !S.book.b2b_members);
  const me = await get('b2b_me', {}, asKey(adminLink));
  check('用個人連結登入：認得是誰、是管理員', me.statusCode === 200 && me.body.me.name === '王處長' && me.body.admin === true, JSON.stringify(me.body));
  let b = await post('b2b_member_save', { name: '林業務', unit: '電光所', role: 'bd', topics: '先進封裝, 晶片散熱\n半導體' }, asKey(adminLink));
  bdLink = b.body.link; bd = b.body.member;
  b = await post('b2b_member_save', { name: '張業務', unit: '材化所', role: 'bd', topics: '複合材料' }, asKey(adminLink));
  bd2Link = b.body.link; bd2 = b.body.member;
  check('管理員用自己的連結新增業務窗口', bd && bd2 && bd.role === 'bd' && /#k=/.test(bdLink));
  const forbidden = await get('b2b_members', {}, asKey(bdLink));
  check('★ 業務窗口不能看成員名單、不能改設定（403）', forbidden.statusCode === 403 && (await post('b2b_settings_save', { sla_days: '9' }, asKey(bdLink))).statusCode === 403);
  const bad = await get('b2b_me', {}, { 'x-b2b-key': 'x'.repeat(24) });
  check('　 錯的連結 → 401', bad.statusCode === 401);
  const reset = await post('b2b_member_reset', { id: bd2.id }, asKey(adminLink));
  const oldTry = await get('b2b_me', {}, asKey(bd2Link));
  const newTry = await get('b2b_me', {}, asKey(reset.body.link));
  check('★ 重發連結：舊的立刻失效、新的可以用', reset.statusCode === 200 && oldTry.statusCode === 401 && newTry.statusCode === 200, `${oldTry.statusCode} ${newTry.statusCode}`);
  bd2Link = reset.body.link;
  const self = await post('b2b_member_save', { id: admin.id, name: '王處長', role: 'bd' }, asKey(adminLink));
  check('　 不能把自己降級或停用（免得最後一位管理員把自己鎖在門外）', self.statusCode === 400, JSON.stringify(self.body));
}

/* ───────── 三、洽詢單 ───────── */
console.log('\n── 三、洽詢單與分派 ──');
let q1;
{
  const closed = await get('b2b_public_config');
  check('★ 還沒填個資告知 → 洽詢單不收件', closed.body.open === false && (await post('b2b_inquiry_submit', inquiry())).statusCode === 503);
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE, topics: '先進封裝\n複合材料\n智慧製造', sla_days: '2' }, asKey(adminLink));
  const cfg = await get('b2b_public_config');
  check('填了個資告知 → 收件中，洽詢單拿得到技術領域選項與回覆天數', cfg.body.open === true && cfg.body.topics.length === 3 && cfg.body.sla_days === 2 && /個人資料保護法/.test(cfg.body.privacy), JSON.stringify(cfg.body).slice(0, 200));

  // 先綁 LINE（第六節細測），才收得到通知
  await B.bindMemberLine(bd.id, B.memberBindCheck((await B.loadMembers({ fresh: true })).find((m) => m.id === bd.id)), 'U_bd1');
  await B.bindMemberLine(admin.id, B.memberBindCheck((await B.loadMembers({ fresh: true })).find((m) => m.id === admin.id)), 'U_admin1');
  F.sent.length = 0;

  const noConsent = await post('b2b_inquiry_submit', inquiry({ consent: false }));
  check('★ 沒勾同意 → 400（伺服器端擋，不是只有前台）', noConsent.statusCode === 400 && noConsent.body.errors.some((e) => e.field === 'consent'));
  const short = await post('b2b_inquiry_submit', inquiry({ need: '想合作' }));
  check('　 需求太短 → 400', short.statusCode === 400 && short.body.errors.some((e) => e.field === 'need'));
  const bot = await post('b2b_inquiry_submit', inquiry({ hp: 'http://spam' }));
  const fast = await post('b2b_inquiry_submit', inquiry({ elapsed: 300 }));
  check('　 蜜罐：假裝成功、什麼都沒寫；太快送出 → 400', bot.statusCode === 200 && fast.statusCode === 400 && !(S.books.B2B.b2b_inquiries || []).slice(1).length);

  const ok = await post('b2b_inquiry_submit', inquiry());
  q1 = ok.body.id;
  const row = S.books.B2B.b2b_inquiries.find((r) => r[0] === q1) || [];
  check('送出成功：編號 Q 開頭、兩個工作天內回覆', ok.statusCode === 200 && /^Q[A-Z0-9]{6}$/.test(q1) && ok.body.sla_days === 2, JSON.stringify(ok.body));
  check('★ 依技術領域自動分給負責「先進封裝」的林業務，期限是兩個工作天後（週三 → 週五）',
    row[12] === bd.id && row[13] === '2026-10-09T10:00:00+08:00' && row[3] === 'new', JSON.stringify(row));
  const msg = pushesTo('U_bd1');
  check('★ LINE 通知承辦人：只有編號、期限、後台連結，沒有公司名稱與需求內容',
    msg.length === 1 && msg[0].includes(q1) && msg[0].includes('2026-10-09') && /\/b2b\?openExternalBrowser=1#q=/.test(msg[0]) && !/某某精密|散熱|陳經理/.test(msg[0]), JSON.stringify(msg));
  check('　 洽詢資料在業發處那本，記者會那本沒有', !S.book.b2b_inquiries && !Object.values(S.book).flat().some((r) => (r || []).includes('chen@example.com')));

  F.sent.length = 0;
  const none = await post('b2b_inquiry_submit', inquiry({ topic: '其他', need: '想了解貴院在生醫檢測方面的合作可能，請與我聯繫。', email: 'x@y.co' }));
  const r2 = S.books.B2B.b2b_inquiries.find((r) => r[0] === none.body.id) || [];
  check('沒命中任何人的關鍵字、也沒設預設承辦人 → 不分派，通知管理員', r2[12] === '' && pushesTo('U_admin1').some((t) => t.includes(none.body.id) && /未分派/.test(t)), JSON.stringify(r2));
  await post('b2b_settings_save', { default_owner: bd2.id }, asKey(adminLink));
  const def = await post('b2b_inquiry_submit', inquiry({ topic: '', need: '想了解貴院在生醫檢測方面的合作可能，請與我聯繫。', email: 'z@y.co' }));
  check('　 設了預設承辦人 → 分給他', (S.books.B2B.b2b_inquiries.find((r) => r[0] === def.body.id) || [])[12] === bd2.id);

  const from = '10.9.9.9';
  let last;
  for (let i = 0; i < 6; i++) last = await post('b2b_inquiry_submit', inquiry({ email: `r${i}@y.co` }), {}, from);
  check('　 同一個 IP 十分鐘內最多 5 筆，第 6 筆 429', last.statusCode === 429);
}

/* ───────── 四、收件匣 ───────── */
console.log('\n── 四、收件匣、稽核、改派 ──');
{
  const mine = await get('b2b_list', {}, asKey(bdLink));
  const all = await get('b2b_list', {}, asKey(adminLink));
  check('★ 業務窗口只看得到分給自己的；管理員看全部', mine.body.inquiries.every((q) => q.owner === bd.id) && mine.body.inquiries.some((q) => q.id === q1)
    && all.body.inquiries.length > mine.body.inquiries.length, `${mine.body.inquiries.length} / ${all.body.inquiries.length}`);
  check('　 收件匣只回摘要（公司、領域、期限），沒有 Email、電話、需求內容', mine.body.inquiries.every((q) => !('email' in q) && !('need' in q) && !('phone' in q)));
  const other = all.body.inquiries.find((q) => q.owner !== bd.id);
  check('　 點開別人的那筆 → 404（不是 403，不讓人知道有這一筆）', (await get('b2b_get', { id: other.id }, asKey(bdLink))).statusCode === 404);
  const one = await get('b2b_get', { id: q1 }, asKey(bdLink));
  check('點開自己的：看得到聯絡方式與需求', one.statusCode === 200 && one.body.inquiry.email === 'chen@example.com' && /散熱/.test(one.body.inquiry.need));
  const auditRows = S.books.B2B.b2b_audit.slice(1);
  check('★ 看過哪一筆記在稽核紀錄（誰、哪一筆）', auditRows.some((r) => r[1] === bd.id && r[2] === 'view' && r[3] === q1));

  await B.bindMemberLine(bd2.id, B.memberBindCheck((await B.loadMembers({ fresh: true })).find((m) => m.id === bd2.id)), 'U_bd2');
  F.sent.length = 0;
  setTaipei(2026, 10, 8, 14);
  const up = await post('b2b_update', { id: q1, status: 'contacted', note: '已電話聯繫，下週安排拜訪' }, asKey(bdLink));
  const row = S.books.B2B.b2b_inquiries.find((r) => r[0] === q1);
  check('改成「已聯繫」：記下首次聯繫時間、備註帶時間與姓名', up.statusCode === 200 && row[3] === 'contacted' && row[14] === '2026-10-08T14:00:00+08:00' && /\[2026-10-08 14:00 林業務\] 已電話聯繫/.test(row[15]), JSON.stringify(row));
  const re = await post('b2b_update', { id: q1, owner: bd2.id }, asKey(bdLink));
  check('★ 業務窗口可以把自己的洽詢轉派給別人（跨所協調）；新的承辦人收到通知（一樣只有編號）', re.statusCode === 200
    && (S.books.B2B.b2b_inquiries.find((r) => r[0] === q1) || [])[12] === bd2.id
    && pushesTo('U_bd2').some((t) => t.includes(q1) && /林業務 轉派/.test(t) && !/某某精密/.test(t)), JSON.stringify({ body: re.body, push: pushesTo('U_bd2') }));
  check('　 轉派之後原承辦人就看不到了', (await get('b2b_get', { id: q1 }, asKey(bdLink))).statusCode === 404);
  const dis = await post('b2b_member_save', { id: bd2.id, name: '張業務', unit: '材化所', role: 'bd', topics: '複合材料', status: 'disabled' }, asKey(adminLink));
  check('　 停用的成員：連結立刻失效', dis.statusCode === 200 && (await get('b2b_me', {}, asKey(bd2Link))).statusCode === 401);
  const backToBd = await post('b2b_update', { id: q1, owner: bd.id }, asKey(adminLink));
  const toDisabled = await post('b2b_update', { id: q1, owner: bd2.id }, asKey(adminLink));
  check('　 管理員可以改派；不能派給停用的成員', backToBd.statusCode === 200 && toDisabled.statusCode === 400 && (S.books.B2B.b2b_inquiries.find((r) => r[0] === q1) || [])[12] === bd.id, `${backToBd.statusCode} ${toDisabled.statusCode}`);
  check('　 每一次修改都有稽核紀錄', S.books.B2B.b2b_audit.slice(1).filter((r) => r[2] === 'update' && r[3] === q1).length >= 2);
  const audit = await get('b2b_audit', {}, asKey(adminLink));
  check('　 管理員看得到稽核紀錄（新的在前）', audit.statusCode === 200 && audit.body.audit[0].at >= audit.body.audit[audit.body.audit.length - 1].at);
}

/* ───────── 五、期限提醒 ───────── */
console.log('\n── 五、期限提醒 ──');
{
  freshAll();
  setTaipei(2026, 10, 7, 10);
  let r = await post('b2b_member_save', { name: '王處長', role: 'admin' }, asAdminPw); adminLink = r.body.link; admin = r.body.member;
  r = await post('b2b_member_save', { name: '林業務', role: 'bd', topics: '先進封裝' }, asKey(adminLink)); bdLink = r.body.link; bd = r.body.member;
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE }, asKey(adminLink));
  const mem = await B.loadMembers({ fresh: true });
  await B.bindMemberLine(bd.id, B.memberBindCheck(mem.find((m) => m.id === bd.id)), 'U_bd1');
  await B.bindMemberLine(admin.id, B.memberBindCheck(mem.find((m) => m.id === admin.id)), 'U_admin1');
  const late = (await post('b2b_inquiry_submit', inquiry())).body.id;
  const done = (await post('b2b_inquiry_submit', inquiry({ email: 'd@y.co' }))).body.id;
  await post('b2b_update', { id: done, status: 'contacted' }, asKey(bdLink));

  const cron = async (auth = true) => { const x = res(); await events({ method: 'GET', headers: auth ? { authorization: 'Bearer cron-secret' } : {}, query: { action: 'b2b_cron' }, socket: {} }, x); return x; };
  check('排程沒帶 CRON_SECRET → 401', (await cron(false)).statusCode === 401);
  F.sent.length = 0;
  setTaipei(2026, 10, 9, 9);
  let c = await cron();
  check('還沒過期限（週五 10:00 之前）→ 不提醒', c.statusCode === 200 && c.body.reminded === 0 && !F.sent.length, JSON.stringify(c.body));
  setTaipei(2026, 10, 12, 9);
  c = await cron();
  check('★ 週一早上：過期沒聯繫的那一筆提醒承辦人；已聯繫的不提醒', c.body.reminded === 1 && pushesTo('U_bd1').some((t) => t.includes(late) && /過聯繫期限/.test(t)) && !F.sent.some((s) => s.text.includes(done)), JSON.stringify(c.body));
  check('　 只過了週末，還不算逾期一個工作天 → 不驚動管理員', c.body.escalated === 0 && !pushesTo('U_admin1').length);
  F.sent.length = 0;
  c = await cron();
  check('★ 同一天再跑一次（排程重跑、手動補跑）→ 不重複提醒', c.body.reminded === 0 && !F.sent.length);
  setTaipei(2026, 10, 13, 9);
  c = await cron();
  check('★ 逾期一個工作天以上 → 管理員也收到（寫明承辦是誰）', c.body.reminded === 1 && c.body.escalated === 1 && pushesTo('U_admin1').some((t) => t.includes(late) && /承辦：林業務/.test(t)), JSON.stringify(c.body));
  check('　 提醒記在稽核紀錄', S.books.B2B.b2b_audit.slice(1).some((r) => r[1] === 'system' && r[2] === 'sla_remind' && r[3] === late));

  // 業發處積了好幾筆沒處理：一筆一則的話，每天早上就是幾十則推播、上百次 Sheets 呼叫（推播額度與 Sheets 額度都跟記者那邊共用）
  const many = [];
  for (let i = 0; i < 6; i++) many.push((await post('b2b_inquiry_submit', inquiry({ email: `m${i}@y.co` }))).body.id);
  setTaipei(2026, 10, 19, 9); // 下週一：這 6 筆的期限是 10/15，加上前面那一筆，一共 7 筆逾期
  F.sent.length = 0;
  const callsBefore = S.calls.length;
  c = await cron();
  const writes = S.calls.slice(callsBefore).filter((x) => x[0] !== 'read').length;
  const bdMsgs = pushesTo('U_bd1'), adminMsgs = pushesTo('U_admin1');
  check('★ 好幾筆同時逾期：每個人只收到一則（編號全列在裡面），Sheets 寫入次數不隨筆數增加',
    c.body.reminded === 7 && bdMsgs.length === 1 && [late, ...many].every((id) => bdMsgs[0].includes(id)) && adminMsgs.length === 1 && writes <= 3,
    `reminded=${c.body.reminded} bd=${bdMsgs.length} admin=${adminMsgs.length} writes=${writes}`);
  check('　 彙整的那一則也只有編號與期限，沒有公司名稱與需求', !/某某精密|散熱|陳經理/.test(bdMsgs.join('\n') + adminMsgs.join('\n')));
  check('　 每一筆的提醒日期都寫回了（同一天再跑不會重複）', [late, ...many].every((id) => S.books.B2B.b2b_inquiries.find((r) => r[0] === id)?.[17] === '2026-10-19')
    && (await cron()).body.reminded === 0);
  check('　 工作天：週三＋2＝週五；週五＋1＝下週一', B.addBusinessDays(Date.UTC(2026, 9, 7, 2), 2) === Date.UTC(2026, 9, 9, 2) && B.addBusinessDays(Date.UTC(2026, 9, 9, 2), 1) === Date.UTC(2026, 9, 12, 2));
}

/* ───────── 五之二、LINE 推播額度（跟記者那邊共用，不能被業發處用光）───────── */
console.log('\n── 五之二、LINE 推播額度 ──');
{
  await post('b2b_settings_save', { line_push_limit: '2' }, asKey(adminLink));
  F.sent.length = 0;
  setTaipei(2026, 12, 1, 10); // 新的一個月（前面幾節已經用掉 10 月的額度）
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await post('b2b_inquiry_submit', inquiry({ email: `p${i}@y.co` }))).body.id);
  const pushed = F.sent.filter((s) => s.push).length;
  check('★ 每月上限 2 則：第 3 則洽詢照樣進收件匣，但不再用米亞推播', pushed === 2 && ids.every(Boolean) && ids.every((id) => S.books.B2B.b2b_inquiries.some((r) => r[0] === id)), `推了 ${pushed} 則`);
  check('　 沒推的那一次記在稽核紀錄（notify_skipped）', S.books.B2B.b2b_audit.slice(1).some((r) => r[2] === 'notify_skipped'));
  B.resetB2BState();
  const me = await get('b2b_me', {}, asKey(bdLink));
  check('　 後台看得到「本月額度已用完」', me.body.push && me.body.push.exhausted === true && me.body.push.used === 2 && me.body.push.limit === 2, JSON.stringify(me.body.push));
  setTaipei(2027, 1, 4, 10);
  F.sent.length = 0;
  await post('b2b_inquiry_submit', inquiry({ email: 'nextmonth@y.co' }));
  check('　 下個月自動歸零，又推得出去', F.sent.filter((s) => s.push).length === 1);
  await post('b2b_settings_save', { line_push_limit: '0' }, asKey(adminLink));
  F.sent.length = 0;
  await post('b2b_inquiry_submit', inquiry({ email: 'zero@y.co' }));
  check('　 設成 0＝完全不用米亞推播', F.sent.filter((s) => s.push).length === 0);
  await post('b2b_settings_save', { line_push_limit: '60' }, asKey(adminLink));
}

/* ───────── 六、米亞 ───────── */
console.log('\n── 六、米亞 ──');
{
  S.book.events = [['id'], ['semi', '半導體先進封裝技術發表會', '#0F9E7A', '【新聞稿】先進封裝', 'active', '2026-10-01', '', '', '', '工研院', 'code2']];
  S.book.line_users = [['line_user_id']];
  globalThis.fetch = async (u) => {
    if (String(u).includes('api.anthropic.com')) return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"intent":"other","event_ids":[],"confidence":"low"}' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('不該打外部服務：' + u);
  };
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
  let h = await handler();
  let out = await say(h, '企業合作洽詢', 'U_c1');
  check('★ 「企業合作洽詢」→ 只回洽詢單網址，說明不在聊天室收資料', /\/inquiry/.test(out) && /不收資料/.test(out) && /2 個工作天/.test(out), out);
  out = await say(h, '我想跟工研院合作', 'U_c2');
  check('　 「我想跟工研院合作」也認得', /\/inquiry/.test(out), out);
  out = await say(h, '工研院跟台積電的技術合作', 'U_c3');
  // 第二句裡面整段包含「跟工研院合作」——只看「有沒有這幾個字」就會攔錯，要整句比對才擋得住
  out += '\n' + await say(h, '台積電跟工研院合作的新技術是什麼？', 'U_c3');
  check('★ 記者問合作「新聞」不被攔走（只認整句在問怎麼洽談合作）', !/\/inquiry/.test(out), out);
  await post('b2b_settings_save', { intake_open: '0' }, asKey(adminLink));
  B.resetB2BState();
  h = await handler();
  out = await say(h, '企業合作洽詢', 'U_c4');
  check('　 暫停收件時不攔（米亞照原本的路徑回）', !/\/inquiry/.test(out), out);
  await post('b2b_settings_save', { intake_open: '1' }, asKey(adminLink));
  // 職員模式是既有功能：公關同仁怎麼講都照原本的職員模式走，不被業發處攔走
  process.env.LINE_STAFF_PASSCODE = '開門';
  B.resetB2BState();
  h = await handler();
  await say(h, '開門', 'U_staff1');
  out = await say(h, '企業合作洽詢', 'U_staff1');
  check('★ 職員模式的同仁說「企業合作洽詢」→ 照原本的職員模式走（不回洽詢單）', !/\/inquiry/.test(out) && out.length > 0, out);
  out = await say(h, '企業合作洽詢', 'U_c5');
  check('　 同一時間一般使用者照樣拿到洽詢單（業發處是開著的）', /\/inquiry/.test(out), out);
  delete process.env.LINE_STAFF_PASSCODE;

  // 綁定 LINE 通知
  const members = await B.loadMembers({ fresh: true });
  const m = members.find((x) => x.id === bd.id);
  const url = decodeURIComponent((await get('b2b_me', {}, asKey(bdLink))).body.me.line_bind_url);
  check('後台的「綁定 LINE 通知」按鈕帶好「#業務 成員代號-檢查碼」', url.endsWith(`#業務 ${m.id}-${B.memberBindCheck(m)}`), url);
  B.resetB2BState();
  h = await handler();
  out = await say(h, `#業務 ${m.id}-${B.memberBindCheck(m)}`, 'U_new_phone');
  check('★ 傳給米亞 → 綁定完成，之後的通知推到這個 LINE', /綁定完成|早就綁定/.test(out) && (await B.loadMembers({ fresh: true })).find((x) => x.id === bd.id).line_user_id === 'U_new_phone', out);
  let blocked = '';
  for (let i = 0; i < 6; i++) blocked = await say(h, `#業務 ${m.id}-AAAAAA`, 'U_guess');
  check('　 檢查碼錯 → 綁不上；一天錯 5 次就先停手', /嘗試次數太多/.test(blocked) && (await B.loadMembers({ fresh: true })).find((x) => x.id === bd.id).line_user_id === 'U_new_phone', blocked);
}

/* ───────── 七、企業場報名 → 洽詢 ───────── */
console.log('\n── 七、企業場報名勾「希望業務窗口與我聯繫」──');
{
  setTaipei(2026, 10, 8, 12); // 場次在 11/20，時鐘撥回報名期間
  const SESSIONS = 'A1｜2026-11-20｜09:30-12:00｜先進封裝技術說明｜201 廳';
  const base = { id: 'biz2026', title: '先進封裝企業說明會', sessions_text: SESSIONS, options_text: 'topic｜想了解的技術｜｜text\ncontact_me｜希望業務窗口與我聯繫',
    contact: '業務窗口 林小姐', closes_at: '2026-11-19', audience: 'business', privacy: R.BUSINESS_PRIVACY_TEMPLATE };
  await post('reg_admin_save_campaign', { ...base, status: 'open' }, asAdminPw);
  await post('reg_admin_save_campaign', { ...base, id: 'biztest', title: '測試場', status: 'draft' }, asAdminPw);
  R.invalidateCampaignCache();
  const before = S.books.B2B.b2b_inquiries.length;
  const reg = { name: '陳大明', outlet: '某某精密股份有限公司', email: 'reg@example.com', phone: '0912345678', sessions: ['A1'], elapsed: 5000, consent: true,
    options: { topic: '晶片散熱', contact_me: true } };
  const r1 = await post('reg_submit', { c: 'biz2026', ...reg });
  const rows = S.books.B2B.b2b_inquiries.slice(before);
  check('★ 報名成功，同時在業發處那本多一筆洽詢（來源寫明是哪一場報名）', r1.statusCode === 200 && rows.length === 1 && rows[0][11] === '報名 biz2026' && rows[0][4] === '某某精密股份有限公司', JSON.stringify(rows));
  const consent = R.parseOptionValues(S.book.registrations.find((r) => r[6] === 'reg@example.com')[9])._consent;
  check('　 洽詢的個資同意時間＝報名時勾同意的那一刻；想了解的技術一併帶過去', rows[0][16] === consent && /晶片散熱/.test(rows[0][10]) && rows[0][9] === '晶片散熱', JSON.stringify(rows[0]));
  await post('reg_submit', { c: 'biz2026', ...reg, sessions: ['A1'] });
  check('　 同一個人再送一次（更新報名）不會再生一筆洽詢', S.books.B2B.b2b_inquiries.length === before + 1);
  await post('reg_submit', { c: 'biztest', ...reg, email: 'test@example.com' });
  check('　 草稿（測試）報名不轉', S.books.B2B.b2b_inquiries.length === before + 1);
  await post('reg_submit', { c: 'biz2026', ...reg, email: 'no@example.com', options: { contact_me: false } });
  check('　 沒勾「希望業務窗口與我聯繫」就不轉', S.books.B2B.b2b_inquiries.length === before + 1);
}

/* ───────── 八、頁面與部署設定 ───────── */
console.log('\n── 八、頁面與部署設定 ──');
{
  const v = JSON.parse(read('vercel.json'));
  check('/inquiry、/b2b 有網址；期限提醒排程只在工作天跑', v.rewrites.some((r) => r.source === '/inquiry') && v.rewrites.some((r) => r.source === '/b2b')
    && v.crons.some((c) => c.path === '/api/events?action=b2b_cron' && / 1-5$/.test(c.schedule)));
  const b2b = read('public/b2b.html');
  check('★ 後台頁：個人連結從 # 後面讀、讀完馬上從網址列拿掉；外部填的字一律跳脫', /location\.hash/.test(b2b) && /history\.replaceState/.test(b2b) && /const esc = /.test(b2b)
    && !/\$\{q\.(company|need|name|email|title|topic|notes)\}/.test(b2b), '');
  // LINE 通知的連結每點一次都是新的頁面：個人連結的代碼要記在裝置上（localStorage），點通知才不會每次都停在登入頁；
  // 管理員密碼照其他後台頁的規矩只放分頁（sessionStorage）
  check('　 後台頁：個人連結記在這台裝置、管理員密碼只放分頁', /const KEY = 'itri_b2b_key'/.test(b2b) && /k === KEY \? localStorage : sessionStorage/.test(b2b));
  const inq = read('public/inquiry.html');
  check('　 洽詢單：有同意勾選、不載入任何外部資源', /id: 'f-consent'/.test(inq) && !/<(script|link)[^>]+(src|href)="https?:/.test(inq));
  // 報名後台的「企業場常用項目」按鈕加的代碼，要跟轉洽詢那一端認的代碼一樣（約定的代碼漂開，勾了也不會轉）
  const regs = read('public/registrations.html');
  check('報名後台「企業場常用項目」的代碼（topic、contact_me）跟轉洽詢那一端一致',
    /key: 'topic'/.test(regs) && /key: 'contact_me'/.test(regs)
    && /options\?\.contact_me/.test(read('lib/registration-api.js')) && /options\?\.topic/.test(read('lib/b2b.js')));
}

/* ───────── 九、業發處出狀況，不能拖累記者那邊 ───────── */
console.log('\n── 九、業發處出狀況，不能拖累記者那邊 ──');
{
  const { reportAiFailure, resetAiAlertThrottle, BUSINESS_KEY_NAME } = await import('../lib/ai-alert.js');
  process.env.LINE_ADMIN_USER_ID = 'U_pr_admin';
  resetAiAlertThrottle();
  F.sent.length = 0;
  await reportAiFailure({ status: 400, message: 'Your credit balance is too low to access the Anthropic API.', where: 'LINE 問答（企業場）', keyName: BUSINESS_KEY_NAME });
  const biz = pushesTo('U_pr_admin').join('\n');
  check('企業場那一把出事：通知寫明只影響企業場、要換的是 ANTHROPIC_API_KEY_BUSINESS（不是記者那一把）',
    /企業場的 AI/.test(biz) && /記者那邊用的是另一把，不受影響/.test(biz) && /更新 ANTHROPIC_API_KEY_BUSINESS/.test(biz) && !/米亞的 AI/.test(biz), biz);
  F.sent.length = 0;
  await reportAiFailure({ status: 401, message: 'API key is invalid.', where: 'LINE 問答' });
  const media = pushesTo('U_pr_admin').join('\n');
  check('★ 同一小時內記者那一把也壞了 → 照樣通知（節流各算各的，業發處的事不能蓋掉記者那邊的警報）', /米亞的 AI 現在叫不動/.test(media), media);
  F.sent.length = 0;
  await reportAiFailure({ status: 401, message: 'API key is invalid.', where: 'LINE 問答' });
  check('　 記者那一把一小時內不重複通知（原本的節流照舊）', pushesTo('U_pr_admin').length === 0);
  delete process.env.LINE_ADMIN_USER_ID;
  resetAiAlertThrottle();

  // 院內辦公室共用一個對外 IP：業務同仁拿已經重發過的舊連結一直開，業發處後台擋下就好，不能連公關的 /admin 一起鎖
  process.env.B2B_SPREADSHEET_ID = 'B2B';
  BA.resetB2BRateLimit(); A.resetAuthLimiter();
  const office = { 'x-forwarded-for': '10.250.0.1' };
  const adminBefore = (await get('list_admin', {}, { ...office, ...asAdminPw })).statusCode;
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await get('b2b_me', {}, { ...office, 'x-b2b-key': 'stale-link-key-0000000000' })).statusCode;
  const adminAfter = (await get('list_admin', {}, { ...office, ...asAdminPw })).statusCode;
  check('★ 同一個 IP 舊連結連錯 31 次：業發處後台擋下（429），公關後台照樣登得進去',
    last === 429 && adminBefore === 200 && adminAfter === 200, `b2b=${last} admin 前=${adminBefore} 後=${adminAfter}`);
  BA.resetB2BRateLimit(); A.resetAuthLimiter();
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 119 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
