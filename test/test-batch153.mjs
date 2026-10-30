// 批次 153：從洽詢單一鍵建立「客戶專屬頁」（企業場草稿＋同仁編輯連結）。
//   一、權限：沒登入、看不到那筆洽詢的業務窗口、無效洽詢都不能建；承辦人與管理員可以
//   二、建出來的活動：企業場草稿、帶公司名稱與承辦窗口、不帶任何客戶個資；洽詢單只記活動代碼
//   三、重複按不會重複建；只查不建；活動被刪了會重建；同時按兩次只建一場
//   四、寫失敗不留半套（預留的代碼會清掉）
//   五、同仁拿編輯連結就能補內容、發布，不用後台密碼；企業場不出現在記者看得到的地方
//   六、舊的 18 欄洽詢表照常用；改狀態不會洗掉專屬頁；頁面與結構
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

/* ───────── 一、沒設定 ───────── */
console.log('\n── 一、業發處沒設定 ──');
S.reset(); F.sent.length = 0;
{
  const r = await page('QAAAAAA', true, asPw);
  check('★ 沒設定 B2B_SPREADSHEET_ID → 503，活動表一個字都沒動', r.statusCode === 503 && !S.book.events, JSON.stringify(r.body));
}

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

/* ───────── 三、權限 ───────── */
console.log('\n── 二、權限 ──');
{
  const noAuth = await page(q1, true, {});
  check('★ 沒登入 → 401，沒建任何活動', noAuth.statusCode === 401 && mainEvents().length === 0);
  const other = await page(q1, true, asKey(bd2Link));
  check('★ 別的業務窗口（不是承辦人）→ 404，看不到也不能建（跟收件匣同一道牆）', other.statusCode === 404 && mainEvents().length === 0, JSON.stringify(other.body));
  const peek = await page(q1, false, asKey(bd2Link));
  check('　 只查也不行（編輯連結等於一把鑰匙）', peek.statusCode === 404);
  const nope = await page('QZZZZZZ', true, asKey(adminLink));
  check('　 不存在的洽詢單 → 404', nope.statusCode === 404);
  const spam = await page(q3, true, asKey(adminLink));
  check('　 標成「無效」的洽詢單不能建', spam.statusCode === 400 && /無效/.test(spam.body.error) && mainEvents().length === 0, JSON.stringify(spam.body));
}

/* ───────── 四、建出來的東西 ───────── */
console.log('\n── 三、建立：承辦窗口按下去 ──');
let ev1, links1;
{
  const r = await page(q1, true, asKey(bdLink));
  check('★ 承辦的業務窗口建立成功：拿到活動頁與編輯連結', r.statusCode === 200 && r.body.created === true && r.body.status === 'draft' && /^https:\/\/example\.itri\.test\/event\?id=/.test(r.body.page_url) && /\/edit\?id=.+&code=[a-z0-9]{16}$/.test(r.body.edit_url), JSON.stringify(r.body));
  links1 = r.body; ev1 = mainEvents()[0] || [];
  check('活動表多一列：草稿、技術媒合會（企業場）、名稱是「公司名稱 技術洽談」', mainEvents().length === 1 && ev1[4] === 'draft' && ev1[13] === '技術媒合會' && ev1[1] === '某某精密股份有限公司 技術洽談' && A.isBusinessEvent({ event_type: ev1[13] }), JSON.stringify(ev1));
  check('　 活動窗口＝承辦人（單位＋姓名）；主辦工研院；知識庫是企業場範本（三個小節標題、沒填內容，不能直接發布；批次 156）', ev1[14] === '電光所 林業務' && ev1[9] === '工研院' && ev1[3] === BUSINESS_KB_TEMPLATE && !kbHasContent(ev1[3]));
  check('　 編輯連結的碼就是活動表裡的編輯碼', links1.edit_url.endsWith('code=' + ev1[10]) && ev1[10].length === 16);
  const raw = JSON.stringify(ev1);
  const leaks = ['陳經理', 'chen@example.com', '03-5912345', 'SECRET-NEED', '研發處長', '先進封裝'].filter((x) => raw.includes(x));
  check('★ 資料界線：活動表那一列沒有聯絡人、Email、電話、職稱、需求內容、技術領域（只有公司名稱）', leaks.length === 0, leaks.join(','));
  check('　 記者會那本沒有任何 b2b 分頁；洽詢單那本只多記了活動代碼', !Object.keys(S.book).some((t) => t.startsWith('b2b')) && S.books.B2B.b2b_inquiries.find((x) => x[0] === q1)[18] === links1.event_id);
  check('　 稽核紀錄寫了誰建的', (S.books.B2B.b2b_audit || []).some((x) => x[2] === 'create_page' && x[1] === bd.id && x[3] === q1));
  const detail = await get('b2b_get', { id: q1 }, asKey(bdLink));
  check('　 洽詢單詳情帶得出 page_event_id（頁面用它決定顯示「建立」還是「連結」）', detail.body.inquiry.page_event_id === links1.event_id);
}

/* ───────── 五、重複、只查、被刪 ───────── */
console.log('\n── 四、重複按、只查、活動被刪、同時按 ──');
{
  const again = await page(q1, true, asKey(bdLink));
  check('★ 再按一次 → 回原本那一場，不重複建', again.statusCode === 200 && again.body.created === false && again.body.event_id === links1.event_id && mainEvents().length === 1);
  const peek = await page(q1, false, asKey(bdLink));
  check('　 只查：連結都在，狀態是草稿；並記一筆稽核（看過編輯連結）', peek.body.exists === true && peek.body.edit_url === links1.edit_url && peek.body.status === 'draft' && S.books.B2B.b2b_audit.some((x) => x[2] === 'view_page'));
  const adminPeek = await page(q1, false, asKey(adminLink));
  check('　 管理員也看得到（管理員看全部）', adminPeek.body.exists === true && adminPeek.body.event_id === links1.event_id);
  const none = await page(q2, false, asKey(adminLink));
  check('　 沒建過 → exists=false，什麼都不寫', none.body.exists === false && mainEvents().length === 1);

  // 系統管理員（後台密碼）建未分派的那筆
  const un = await page(q2, true, asPw);
  const evU = mainEvents().find((r) => r[1].startsWith('無人認領'));
  check('★ 後台密碼（系統管理員）可以建未分派的洽詢單；活動窗口留空，不寫「系統管理員」', un.statusCode === 200 && evU && evU[14] === '', JSON.stringify(evU));

  // 活動被刪掉
  const gone = mainEvents().findIndex((r) => r[0] === links1.event_id);
  S.book.events.splice(gone + 1, 1);
  const peekGone = await page(q1, false, asKey(bdLink));
  check('★ 專屬頁的活動被後台刪掉 → 只查回 exists=false（頁面會顯示「建立」按鈕），不報錯', peekGone.statusCode === 200 && peekGone.body.exists === false);
  clock += 5000; // 時鐘往前走（活動代碼含時間戳；真實世界不會同一毫秒建兩場）
  const rebuilt = await page(q1, true, asKey(bdLink));
  check('　 再按「建立」→ 重建一場新的，洽詢單改指向新的', rebuilt.body.created === true && rebuilt.body.event_id !== links1.event_id && S.books.B2B.b2b_inquiries.find((x) => x[0] === q1)[18] === rebuilt.body.event_id);
  links1 = rebuilt.body;

  // 同時按兩次
  fresh2: {
    const before = mainEvents().length;
    const qx = (await post('b2b_inquiry_submit', inquiry({ company: '雙擊股份有限公司', email: 'd@example.com' }))).body.id;
    const [a, b] = await Promise.all([page(qx, true, asKey(adminLink)), page(qx, true, asKey(adminLink))]);
    const codes = [a.statusCode, b.statusCode].sort().join();
    check('★ 同時按兩次（連點）→ 只建一場；另一個請它稍候', mainEvents().length === before + 1 && (codes === '200,409' || codes === '200,200'), `${codes} ${mainEvents().length - before}`);
  }
}

/* ───────── 六、寫失敗 ───────── */
console.log('\n── 五、活動表寫失敗，不留半套 ──');
{
  const q = (await post('b2b_inquiry_submit', inquiry({ company: '會失敗股份有限公司', email: 'e@example.com' }))).body.id;
  const before = mainEvents().length;
  S.calls.length = 0; S.ctl.failWrites = 2; // 第 1 次寫入＝預留代碼，第 2 次＝寫活動表（失敗）
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  const r = await page(q, true, asKey(adminLink));
  console.error = orig; S.ctl.failWrites = 0;
  check('★ 活動表寫不進去 → 回錯誤（不是假成功），沒有多出活動', r.statusCode === 500 && mainEvents().length === before, JSON.stringify(r.body));
  check('　 預留的活動代碼已清掉（洽詢單沒有指向不存在的活動）', S.books.B2B.b2b_inquiries.find((x) => x[0] === q)[18] === '');
  const retry = await page(q, true, asKey(adminLink));
  check('　 重試成功，只建一場', retry.statusCode === 200 && retry.body.created === true && mainEvents().length === before + 1);
}

/* ───────── 七、同仁拿編輯連結補內容、發布 ───────── */
console.log('\n── 六、同仁不進後台，用編輯連結補內容並發布 ──');
{
  const id = links1.event_id, code = links1.edit_url.split('code=')[1];
  const listBefore = await get('list', {});
  check('★ 草稿狀態：客戶（沒有登入）打開活動頁 → 404；公開列表也沒有', (await get('get_public', { id })).statusCode === 404 && !(listBefore.body.events || []).some((e) => e.id === id));
  const early = await post('update_edit', { id, code, status: 'active' });
  check('　 內容還沒填就想發布 → 被必填檢查擋下（跟一般活動同一道閘門）', early.statusCode >= 400, JSON.stringify(early.body));
  const kb = BUSINESS_KB_TEMPLATE.replace('【技術介紹】', '【技術介紹】\n- 先進封裝散熱模組，熱阻降低 30%');
  const ok = await post('update_edit', { id, code, press_contact: '電光所 林業務 03-5912345 轉 100', knowledge_base: kb, status: 'active' });
  check('★ 補完窗口與內容就能發布（企業場不要求日期、地點），全程沒有後台密碼', ok.statusCode === 200, JSON.stringify(ok.body));
  const pub = await get('get_public', { id });
  check('　 客戶打得開活動頁：是企業場（問公司／單位，用企業版）', pub.statusCode === 200 && pub.body.event.audience === 'business' && pub.body.event.name === '某某精密股份有限公司 技術洽談', JSON.stringify(pub.body).slice(0, 200));
  const list = await get('list', {});
  check('★ 企業場不出現在公開活動列表（記者看不到）', !(list.body.events || []).some((e) => e.id === id));
  const wrong = await post('update_edit', { id, code: 'wrong-code-0000000', status: 'draft' });
  check('　 編輯碼錯 → 401', wrong.statusCode === 401);
  const detail = await page(q1, false, asKey(bdLink));
  check('　 洽詢單這邊再看：狀態變成已發布', detail.body.status === 'active');
}

/* ───────── 八、舊表與資料不被洗掉 ───────── */
console.log('\n── 七、舊的 18 欄洽詢表、改狀態不洗掉專屬頁 ──');
{
  const upd = await post('b2b_update', { id: q1, status: 'proposing', note: '客戶要求下週簡報' }, asKey(bdLink));
  const row = S.books.B2B.b2b_inquiries.find((x) => x[0] === q1);
  check('★ 改狀態、加備註之後，專屬頁的活動代碼還在（整列寫回時沒被截掉）', upd.statusCode === 200 && row.length >= 19 && row[18] === links1.event_id && row[3] === 'proposing');

  fresh();
  const old = ['QOLD001', '2026-10-01T10:00:00+08:00', '2026-10-01T10:00:00+08:00', 'new', '舊客戶公司', '舊聯絡人', '', 'old@example.com', '', '', '舊需求內容寫在這裡超過十個字', 'web', '', '2026-10-05T10:00:00+08:00', '', '', '2026-10-01T10:00:00+08:00', ''];
  S.books.B2B = { b2b_inquiries: [B.B2B_HEADERS.b2b_inquiries.slice(0, 18), old], b2b_members: [B.B2B_HEADERS.b2b_members], b2b_audit: [B.B2B_HEADERS.b2b_audit], b2b_settings: [B.B2B_HEADERS.b2b_settings] };
  S.book.events = [['id']];
  const one = await get('b2b_get', { id: 'QOLD001' }, asPw);
  console.log('   （舊表讀取：' + one.statusCode + ' ' + JSON.stringify(one.body).slice(0, 160) + ' 表頭欄數 ' + (S.books.B2B.b2b_inquiries[0] || []).length + '）');
  check('舊表（只有 18 欄）照常讀；表頭自動補成 19 欄', one.statusCode === 200 && one.body.inquiry.page_event_id === '' && S.books.B2B.b2b_inquiries[0].length === 19 && S.books.B2B.b2b_inquiries[0][18] === 'page_event_id');
  const made = await page('QOLD001', true, asPw);
  check('　 舊的洽詢單也能建專屬頁；舊欄位一格不動', made.statusCode === 200 && S.books.B2B.b2b_inquiries[1][4] === '舊客戶公司' && S.books.B2B.b2b_inquiries[1][10].startsWith('舊需求') && S.books.B2B.b2b_inquiries[1][18] === made.body.event_id);
}

/* ───────── 九、頁面與結構 ───────── */
console.log('\n── 八、頁面與結構 ──');
{
  const pg = read('public/b2b.html');
  check('洽詢單詳情頁：有「建立客戶專屬頁」按鈕；有了就顯示活動頁與編輯連結、可複製', /建立客戶專屬頁/.test(pg) && /b2b_customer_page/.test(pg) && /編輯連結（給同仁，不用密碼）/.test(pg) && /copyText\(url\)/.test(pg));
  check('★ 說清楚只會帶公司名稱、草稿客戶打不開、要發布', /只會帶公司名稱/.test(pg) && /客戶現在還打不開/.test(pg));
  check('★ 連結用 textContent 放（不經過 innerHTML）', /code\.textContent = url/.test(pg));
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 還是 11 支（Vercel Hobby 上限 12）；沒有新增排程', fns.length === 11 && JSON.parse(read('vercel.json')).crons.length === 9);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 153 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
