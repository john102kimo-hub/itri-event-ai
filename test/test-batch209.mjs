// 批次 209：① 後台承辦人代記者報名（reg_admin_add）② 同仁專屬連結（staff_list／staff_create，STAFF_LINK_KEY）。
// 跑真的 api/events.js，只有 Google Sheets 是假的（fakes-sheets82）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
const STAFF_KEY = 'staff-test-key-0123456789';
process.env.STAFF_LINK_KEY = STAFF_KEY;

// 場次 2026-10-28／29；時鐘放在 11-10，兩場都已經辦完——代報名要能補登
let clock = Date.UTC(2026, 10, 10, 4, 0, 0);
Date.now = () => clock;

const { book, reset } = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const API = await import('../lib/registration-api.js');
const Auth = await import('../lib/auth.js');
const SL = await import('../lib/staff-link.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = () => r; r.end = () => r;
  return r;
}
let ipSeq = 0;
const ipHdr = (ip) => ({ 'x-forwarded-for': ip || `10.9.0.${++ipSeq % 250}` });
async function post(body, headers = {}, ip) {
  const res = fakeRes();
  await events({ method: 'POST', headers: { ...ipHdr(ip), ...headers }, query: {}, body }, res);
  return res;
}
async function get(query, headers = {}, ip) {
  const res = fakeRes();
  await events({ method: 'GET', headers: { ...ipHdr(ip), ...headers }, query }, res);
  return res;
}
const admin = (b) => post(b, { 'x-admin-password': 'pw' });
const regRows = () => (book.registrations || []).slice(1);

const SESSIONS = 'A1｜2026-10-28｜09:30-12:00｜開幕論壇\nB1｜2026-10-29｜09:30-12:00｜全球AI競局\nX1｜2026-10-30｜09:00-10:00｜取消的場';
const OPTIONS = 'meal｜需要餐盒｜A1\nparty｜同行人數｜｜number';
async function seed(over = {}) {
  reset(); R.resetRegistrationState(); API.resetRateLimit(); Auth.resetAuthLimiter(); SL.resetStaffLinkLimiter();
  const res = await admin({
    action: 'reg_admin_save_campaign', id: 'tw', title: '眺望', status: 'open', sessions_text: SESSIONS, options_text: OPTIONS,
    closes_at: '2026-10-01 12:00', contact: '行銷傳播處', ...over
  });
  if (res.statusCode !== 200) throw new Error('seed 失敗 ' + JSON.stringify(res.body));
}
// 取消的場次要在存檔後才能設定（解析時 X1 先寫成開放，再用狀態欄改成取消）
const add = (over = {}) => admin({ action: 'reg_admin_add', c: 'tw', name: '陳小華', outlet: '聯合報', email: 'Chen@Example.com', phone: '', sessions: ['A1'], ...over });

// ═══ 一、承辦人代記者報名 ═════════════════════════════════════════════
console.log('\n── 一、reg_admin_add ──');
await seed();
{
  const noPw = await post({ action: 'reg_admin_add', c: 'tw', name: '陳小華', outlet: '聯合報', email: 'a@b.com', sessions: ['A1'] });
  check('★ 沒密碼不能代報名（401），也沒寫進去', noPw.statusCode === 401 && regRows().length === 0);
  const staffOnly = await post({ action: 'reg_admin_add', c: 'tw', name: '陳小華', outlet: '聯合報', email: 'a@b.com', sessions: ['A1'] }, { 'x-staff-key': STAFF_KEY });
  check('★ 同仁連結的金鑰不能代報名（只認管理員密碼）', staffOnly.statusCode === 401 && regRows().length === 0);
}
{
  const r = await add();
  check('報名已截止、場次已辦完，承辦人照樣補登成功', r.statusCode === 200 && r.body.success && /^R/.test(r.body.reg_id), JSON.stringify(r.body));
  const row = regRows()[0];
  check('寫進一列：姓名、單位、Email 小寫、手機空白、狀態有效', row && row.includes('陳小華') && row.includes('chen@example.com') && row.includes('active'));
  check('來源記成 admin（名單上分得出是代報的），不是測試', row.includes('admin') && !row.some((x) => /:test$/.test(String(x))));
  const ov = await get({ action: 'reg_admin_list', c: 'tw' }, { 'x-admin-password': 'pw' });
  check('後台名單看得到這一筆、算進人數', ov.body.stats.people === 1 && ov.body.regs[0].source === 'admin');
}
{
  const r = await add({ name: '陳小華（重送）' });
  check('★ 同一個 Email 已有有效報名 → 409 並告知編號，不覆蓋、不多生一列', r.statusCode === 409 && /編號 R/.test(r.body.error) && regRows().length === 1, JSON.stringify(r.body));
}
{
  // 取消後再代報名：恢復同一列，不多生
  await admin({ action: 'reg_admin_update', reg_id: regRows()[0][0], status: 'cancelled' });
  const r = await add({ name: '陳小華', sessions: ['A1', 'B1'] });
  check('取消過的同 Email 再代報名 → 恢復那一列、場次換成新的', r.statusCode === 200 && r.body.reopened && regRows().length === 1 && regRows()[0].includes('active'));
}
{
  const bad = async (over, re, label) => { const r = await add({ email: `x${++ipSeq}@e.com`, ...over }); check(label, r.statusCode === 400 && re.test(r.body.error), JSON.stringify(r.body)); };
  await bad({ name: '' }, /姓名/, '沒填姓名 → 400');
  await bad({ outlet: '' }, /單位|媒體/, '沒填單位 → 400');
  await bad({ email: '' }, /Email/, 'Email 一定要填（名單用它去重）');
  await bad({ email: 'not-an-email' }, /Email/, 'Email 格式不對 → 400');
  await bad({ phone: 'abc' }, /手機/, '手機有填但亂打 → 400（空白才可以）');
  await bad({ sessions: [] }, /場次/, '一個場次都沒勾 → 400');
  await bad({ sessions: ['Z9'] }, /Z9/, '不存在的場次 → 400');
}
{
  const r = await add({ email: 'biz@e.com', name: '業務窗口', options: { meal: true, party: '3', 不存在: '1' } });
  const row = regRows().find((x) => x.includes('biz@e.com'));
  check('選填項目照活動定義收（餐盒、人數），沒定義的丟掉', r.statusCode === 200 && /meal/.test(row.join('|')) && /party/.test(row.join('|')) && !/不存在/.test(row.join('|')));
}
{
  // 公開表單的規則完全沒變：截止後公開送出仍然被擋、手機仍然必填
  const pub = await post({ action: 'reg_submit', c: 'tw', name: '路人甲', outlet: '某報', email: 'p@e.com', phone: '0912-345-678', sessions: ['A1'] });
  check('★ 公開表單不受影響：已截止仍回 409', pub.statusCode === 409);
  const v = R.validateSubmission(R.parseSessions ? await R.getCampaign('tw') : null, { name: '路人甲', outlet: '某報', email: 'p@e.com', phone: '', sessions: ['A1'] }, { now: Date.UTC(2026, 8, 1) });
  check('★ 公開驗證仍要求手機（admin 選項預設關）', v.errors.some((e) => e.field === 'phone'));
}
{
  // 草稿活動：代報名標成測試，跟公開測試報名一樣可以一鍵清掉
  await seed({ status: 'draft' });
  const r = await add();
  check('草稿活動的代報名標成測試（source 尾巴 :test）', r.statusCode === 200 && regRows()[0].includes('admin:test'));
}
{
  // 企業場不用個資同意（承辦人代填，同意由承辦人負責取得）
  await seed({ audience: 'business', privacy: '個資告知' });
  const r = await add();
  check('企業場代報名不用勾個資同意', r.statusCode === 200, JSON.stringify(r.body));
}

// ═══ 二、同仁專屬連結 ═════════════════════════════════════════════════
console.log('\n── 二、staff_list／staff_create ──');
const evRow = (id, name, status, date, code) => [id, name, '#0F9E7A', '超長知識庫內容不該出現', status, date, '', '', '', '工研院', code, '', '台北', '', '', '機密窗口分工', '', ''];
function seedEvents() {
  reset(); Auth.resetAuthLimiter(); SL.resetStaffLinkLimiter();
  book.events = [['id'], evRow('e1', '春季說明會', 'active', '2026-03-01', 'codeAAAA'), evRow('e2', '舊活動', 'archived', '2025-01-01', 'codeBBBB'), evRow('e3', '草稿活動', 'draft', '2026-12-01', 'codeCCCC')];
}
const sk = { 'x-staff-key': STAFF_KEY };
seedEvents();
{
  const none = await get({ action: 'staff_list' });
  check('★ 沒帶金鑰 → 401', none.statusCode === 401);
  const wrong = await get({ action: 'staff_list' }, { 'x-staff-key': STAFF_KEY + 'x' });
  check('★ 金鑰錯 → 401', wrong.statusCode === 401);
  const viaQuery = await get({ action: 'staff_list', key: STAFF_KEY, k: STAFF_KEY });
  check('★ 金鑰放網址參數不收（只收 header，不留在存取紀錄）', viaQuery.statusCode === 401);
  const adminPw = await get({ action: 'staff_list' }, { 'x-admin-password': 'pw' });
  check('管理員密碼不等於同仁金鑰（兩把各管各的）', adminPw.statusCode === 401);
}
{
  const ok = await get({ action: 'staff_list' }, sk);
  const ids = (ok.body.events || []).map((e) => e.id);
  check('金鑰對 → 200，列出未封存的活動（含草稿），不含封存', ok.statusCode === 200 && ids.includes('e1') && ids.includes('e3') && !ids.includes('e2'), JSON.stringify(ok.body));
  check('依活動日期新到舊', ids[0] === 'e3');
  const text = JSON.stringify(ok.body);
  check('★ 回應裡沒有知識庫全文、邀訪窗口分工', !/超長知識庫|機密窗口/.test(text));
  check('附各場的編輯連結（/edit?id=…&code=…）', ok.body.events.find((e) => e.id === 'e1').edit_url === '/edit?id=e1&code=codeAAAA');
  check('不被瀏覽器快取', ok.headers['cache-control'] === 'no-store');
}
{
  const c = await post({ action: 'staff_create', name: '  新活動\n名稱  ', event_date: '2026-12-25', venue: '南港' }, sk);
  check('staff_create → 200、草稿、回編輯連結', c.statusCode === 200 && c.body.status === 'draft' && /^\/edit\?id=.+&code=.{16}$/.test(c.body.edit_url), JSON.stringify(c.body));
  const row = book.events[book.events.length - 1];
  check('寫進 events：名稱整理過、狀態 draft、日期、地點、主辦、有編輯碼', row[1] === '新活動 名稱' && row[4] === 'draft' && row[5] === '2026-12-25' && row[12] === '南港' && row[9] === '工研院' && row[10].length === 16 && row.length === 18, JSON.stringify(row));
  const noName = await post({ action: 'staff_create', name: '   ' }, sk);
  check('沒填名稱 → 400', noName.statusCode === 400);
  const badDate = await post({ action: 'staff_create', name: '日期亂填', event_date: '2026-02-31' }, sk);
  check('不存在的日期不寫進日期欄（退回建立時間）', badDate.statusCode === 200 && !/^2026-02-31$/.test(book.events[book.events.length - 1][5]));
  const noKey = await post({ action: 'staff_create', name: '偷建' });
  check('★ 沒金鑰不能新增', noKey.statusCode === 401);
  const adminOnly = await post({ action: 'staff_create', name: '偷建' }, { 'x-admin-password': 'pw' });
  check('★ 用管理員密碼打 staff_create 也不行（走正常的 create）', adminOnly.statusCode === 401);
}
{
  // 同仁金鑰只開這兩支：其他管理員動作一律不認
  const probes = [
    ['GET', { action: 'list_admin' }], ['GET', { action: 'get', id: 'e1' }], ['GET', { action: 'org_kb' }], ['GET', { action: 'reg_admin_list' }],
    ['GET', { action: 'reg_export', c: 'tw' }], ['GET', { action: 'contacts_directory' }]
  ];
  let allBlocked = true;
  for (const [, q] of probes) { const r = await get(q, sk); if (r.statusCode !== 401) allBlocked = false; }
  for (const b of [{ action: 'create', name: 'x' }, { action: 'archive', id: 'e1' }, { action: 'delete', id: 'e1' }, { action: 'org_kb_save', content: 'x' }, { action: 'reg_admin_update', reg_id: 'R1', note: 'x' }, { action: 'assistant_chat', messages: [] }]) {
    const r = await post(b, sk); if (r.statusCode !== 401) allBlocked = false;
  }
  check('★ 同仁金鑰打不開任何管理員功能（清單、知識庫、報名名單、匯出、封存、刪除都 401）', allBlocked);
}
{
  // 猜錯限流：同一來源錯太多次先擋
  seedEvents();
  let last;
  for (let i = 0; i < 31; i++) last = await get({ action: 'staff_list' }, { 'x-staff-key': 'guess-' + i }, '9.9.9.9');
  const right = await get({ action: 'staff_list' }, sk, '9.9.9.9');
  check('★ 同一來源猜錯 30 次以上 → 429，之後連對的金鑰也先擋', last.statusCode === 429 && right.statusCode === 429);
  const other = await get({ action: 'staff_list' }, sk, '8.8.8.8');
  check('別的來源不受影響', other.statusCode === 200);
}
{
  // fail-closed：沒設定或太短一律拒絕
  seedEvents();
  const keep = process.env.STAFF_LINK_KEY;
  delete process.env.STAFF_LINK_KEY;
  const a = await get({ action: 'staff_list' }, { 'x-staff-key': 'undefined' });
  const b = await get({ action: 'staff_list' }, { 'x-staff-key': '' });
  check('★ STAFF_LINK_KEY 沒設定 → 一律拒絕（不是「沒設定就放行」）', a.statusCode === 401 && b.statusCode === 401);
  process.env.STAFF_LINK_KEY = 'short';
  const c = await get({ action: 'staff_list' }, { 'x-staff-key': 'short' });
  check('★ 金鑰短於 16 字 → 拒絕（不接受弱金鑰）', c.statusCode === 401);
  process.env.STAFF_LINK_KEY = keep;
}
{
  seedEvents();
  let last;
  for (let i = 0; i < 16; i++) last = await post({ action: 'staff_create', name: '灌水' + i }, sk, '7.7.7.7');
  check('新增有限流：同一來源 10 分鐘內第 16 筆起 → 429', last.statusCode === 429);
}
{
  check('strictDate：真日期收、假日期／亂格式不收', SL.strictDate('2026-12-25') === '2026-12-25' && SL.strictDate('2026-02-30') === '' && SL.strictDate('12/25') === '' && SL.strictDate(null) === '');
}

// ═══ 三、頁面與路由 ═══════════════════════════════════════════════════
console.log('\n── 三、頁面 ──');
{
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../public/staff.html', import.meta.url), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  check('/staff 有改寫到 staff.html', vercel.rewrites.some((r) => r.source === '/staff' && r.destination === '/staff.html'));
  check('/staff 不給搜尋引擎、不被快取（noindex＋no-store）', JSON.stringify(vercel.headers).includes('staff|staff\\\\.html') && /noindex/.test(page));
  check('頁面：金鑰讀自網址 # 後面、用 header 送出，不放網址參數', /location\.hash/.test(page) && /X-Staff-Key/.test(page) && !/\?k=|&k=/.test(page));
  check('頁面讀完就把金鑰從網址列清掉', /history\.replaceState/.test(page));
  check('Function 數量沒增加（沒有新的 api/*.js）', fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.js')).length === 11);
  const reg = fs.readFileSync(new URL('../public/registrations.html', import.meta.url), 'utf8');
  check('後台名單有「代記者報名」按鈕與對話框，打 reg_admin_add', /openAdd\(\)/.test(reg) && /id="m-add"/.test(reg) && /reg_admin_add/.test(reg));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 209 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
