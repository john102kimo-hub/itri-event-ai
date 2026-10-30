// 批次 152：報名關聯到活動——活動頁出現「我要報名」、後台「用這場活動建立報名」。
//   一、reg_campaigns 第 17 欄 event_id：舊資料（16 欄）照常讀；存檔保留／解除／驗證；一場活動只能關聯一個報名
//   二、活動頁的報名連結（reg_event_link）：關聯的報名現在收件才給；草稿、截止、辦完、沒關聯都是空；出錯也不壞活動頁
//   三、用這場活動建立報名：帶名稱、日期、時間、地點、聯絡人；草稿；已關聯就回原本那筆；企業場建成企業報名；缺日期／時間說清楚
//   四、頁面與結構：活動頁按鈕、後台入口、報名編輯頁欄位；api/ 仍 11 支
import { register } from 'node:module';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.SITE_URL = 'https://example.itri.test';
delete process.env.B2B_SPREADSHEET_ID;

// 假時鐘：2026-10-07（週三）上午 10:00 台灣時間
let clock = Date.UTC(2026, 9, 7, 2, 0, 0);
Date.now = () => clock;

const S = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const RA = await import('../lib/registration-api.js');
const Auth = await import('../lib/auth.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.send = (t) => (r.text = t, r); r.end = () => r; return r; };
let n = 0;
const ip = () => `10.152.${Math.floor(++n / 200)}.${n % 200}`;
const get = async (action, query = {}, headers = {}) => { const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': ip(), ...headers }, query: { action, ...query }, socket: {} }, r); return r; };
const post = async (action, body = {}, headers = {}) => { const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': ip(), ...headers }, query: {}, body: { action, ...body }, socket: {} }, r); return r; };
const asAdmin = { 'x-admin-password': 'pw' };

// 活動欄位：A id B 名稱 C 色 D 知識庫 E 狀態 F 日期 … J 主辦 K 編輯碼 L 時間 M 地點 N 類型 O 聯絡窗口
const PRESS = ['quad', '四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】內容', 'active', '2026-11-20', '', '', '', '工研院', 'c1', '14:00', '工研院中興院區', '記者會', '王小明 03-1111111'];
const BIZ = ['biz', '智慧製造技術說明會', '#0F9E7A', '企業場內容', 'active', '2026-11-21', '', '', '', '工研院', 'c2', '10:00', '中興院區', '企業說明會', '林小姐'];
const NODATE = ['nodate', '還沒訂日期的活動', '#0F9E7A', 'x', 'draft', '', '', '', '', '工研院', 'c3', '14:00', '', '記者會', ''];
const NOTIME = ['notime', '還沒訂時間的活動', '#0F9E7A', 'x', 'draft', '2026-11-22', '', '', '', '工研院', 'c4', '', '', '記者會', ''];
const WEIRD = ['Odd_ID.1', '名稱｜有直線|的活動', '#0F9E7A', 'x', 'active', '2026-11-23', '', '', '', '工研院', 'c5', '09:30', '會議室｜A', '記者會', ''];
const SESS = 'A1｜2026-11-20｜14:00-16:00｜記者會｜201 廳';
const fresh = () => {
  S.reset(); R.resetRegistrationState(); RA.resetRateLimit?.(); Auth.resetAuthLimiter();
  S.book.events = [['id'], [...PRESS], [...BIZ], [...NODATE], [...NOTIME], [...WEIRD]];
};
const save = (over = {}) => post('reg_admin_save_campaign', { id: 'c-quad', title: '記者會報名', status: 'open', sessions_text: SESS, intro: '歡迎', ...over }, asAdmin);
const link = (id) => get('reg_event_link', { id });

/* ───────── 一、event_id 欄位 ───────── */
console.log('\n── 一、第 17 欄 event_id ──');
fresh();
{
  const old16 = ['c-old', '舊的報名', 'open', '', SESS, '', '', '', '', '', '2026-10-01T10:00:00+08:00', '2026-10-01T10:00:00+08:00', '', '', 'media', 'TOKEN123'];
  S.book.reg_campaigns = [R.CAMPAIGN_HEADERS.slice(0, 16), old16];
  S.book.registrations = [R.REG_HEADERS];
  const c = (await R.loadCampaigns({ fresh: true })).find((x) => x.id === 'c-old');
  check('★ 舊資料（只有 16 欄）照常讀：event_id 是空的、其他欄位不動', c && c.event_id === '' && c.share_token === 'TOKEN123' && c.title === '舊的報名');
  check('　 表頭自動補成 17 欄，舊資料一格不動', S.book.reg_campaigns[0].length === 17 && S.book.reg_campaigns[0][16] === 'event_id' && S.book.reg_campaigns[1].join() === old16.join());
}
fresh();
{
  check('新增報名時不帶 event_id → 跟以前一樣，沒關聯', (await save()).statusCode === 200 && S.book.reg_campaigns[1][16] === '');
  const linked = await save({ event_id: 'quad' });
  check('★ 帶 event_id → 存進第 17 欄', linked.statusCode === 200 && S.book.reg_campaigns[1][16] === 'quad', JSON.stringify(S.book.reg_campaigns[1]));
  await save({ intro: '改過的說明' }); // 舊版後台頁：沒有 event_id 這個欄位
  check('★ 請求沒帶 event_id（瀏覽器還開著舊版後台頁）→ 保留原本的關聯，不洗掉', S.book.reg_campaigns[1][16] === 'quad' && S.book.reg_campaigns[1][3] === '改過的說明');
  check('　 儲存分享連結碼（第 16 欄）也沒被擠掉', (await post('reg_admin_share', { c: 'c-quad', mode: 'create' }, asAdmin)).statusCode === 200 && (await save({ intro: '再改' })).statusCode === 200 && S.book.reg_campaigns[1][15].length > 10 && S.book.reg_campaigns[1][16] === 'quad');
  const bad = await save({ event_id: 'no-such-event' });
  check('★ 活動代碼不存在 → 擋下，原本的關聯不變', bad.statusCode === 400 && /找不到活動/.test(bad.body.error) && S.book.reg_campaigns[1][16] === 'quad', JSON.stringify(bad.body));
  const fmt = await save({ event_id: '<script>' });
  check('　 格式不對 → 擋下', fmt.statusCode === 400 && /格式/.test(fmt.body.error));
  const dup = await save({ id: 'c-other', title: '另一個報名', event_id: 'quad' });
  check('★ 一場活動只能關聯一個報名：另一個報名想關聯同一場 → 擋下，說明被誰佔了', dup.statusCode === 400 && /記者會報名/.test(dup.body.error) && !S.book.reg_campaigns.some((r) => r[0] === 'c-other'), JSON.stringify(dup.body));
  const same = await save({ event_id: 'quad', intro: '自己再存一次' });
  check('　 自己再存一次同一個關聯 → 可以', same.statusCode === 200);
  const clear = await save({ event_id: '' });
  check('★ 明確傳空字串 → 解除關聯', clear.statusCode === 200 && S.book.reg_campaigns[1][16] === '');
  const other = await save({ id: 'c-other', title: '另一個報名', event_id: 'quad' });
  check('　 解除之後，別的報名就可以關聯這一場', other.statusCode === 200 && S.book.reg_campaigns.find((r) => r[0] === 'c-other')[16] === 'quad');
  const view = await get('reg_admin_list', {}, asAdmin);
  check('後台列表帶得出每個報名關聯的活動（編輯頁要顯示）', view.statusCode === 200 && view.body.campaigns.find((x) => x.id === 'c-other').event_id === 'quad', JSON.stringify(view.body).slice(0, 200));
}

/* ───────── 二、活動頁的報名連結 ───────── */
console.log('\n── 二、reg_event_link ──');
fresh();
{
  await save({ event_id: 'quad' });
  const r = await link('quad');
  check('★ 關聯的報名開放中 → 給連結（免登入）；連結指向 /register?c=', r.statusCode === 200 && /\/register\?c=c-quad$/.test(r.body.url) && r.body.title === '記者會報名', JSON.stringify(r.body));
  check('　 可以被 CDN 快取 30 秒（活動頁流量大，不放大 Sheets 讀取）', /s-maxage=30/.test(r.headers['cache-control'] || ''));
  check('　 沒有關聯的活動、不存在的活動、沒帶代碼 → 空，不是錯誤', ['biz', 'nope', ''].every(async () => true) && (await link('biz')).body.url === '' && (await link('nope')).body.url === '' && (await link('')).body.url === '');
  await save({ event_id: 'quad', status: 'draft' });
  check('★ 報名還是草稿 → 不給（草稿只有拿到連結的人看得到，不能從活動頁洩出去）', (await link('quad')).body.url === '');
  await save({ event_id: 'quad', status: 'closed' });
  check('　 已截止 → 不給', (await link('quad')).body.url === '');
  await save({ event_id: 'quad', status: 'open', closes_at: '2026-10-06 12:00' });
  check('　 過了截止時間 → 不給', (await link('quad')).body.url === '');
  await save({ event_id: 'quad', status: 'open', closes_at: '' });
  check('　 重新開放 → 又給了', /c-quad/.test((await link('quad')).body.url));
  clock = Date.UTC(2026, 10, 21, 2, 0, 0); // 場次（11/20 14:00–16:00）已經辦完
  R.resetRegistrationState();
  check('★ 場次全部辦完 → 不給（報名自己消失，跟米亞的卡片一致）', (await link('quad')).body.url === '');
  clock = Date.UTC(2026, 9, 7, 2, 0, 0); R.resetRegistrationState();

  S.ctl.failReads.add('reg_campaigns'); R.resetRegistrationState();
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  const bad = await link('quad');
  console.error = orig; S.ctl.failReads.clear(); R.resetRegistrationState();
  check('★ 報名資料讀不到 → 回空連結（活動頁照常能問），不是 500', bad.statusCode === 200 && bad.body.url === '');
  check('　 錯誤有記進 log', logs.some((l) => /查活動關聯的報名失敗/.test(l)), JSON.stringify(logs).slice(0, 200));
}

/* ───────── 三、用這場活動建立報名 ───────── */
console.log('\n── 三、用這場活動建立報名 ──');
fresh();
{
  const none = await post('reg_admin_from_event', { event_id: 'quad' });
  check('★ 要管理員密碼', none.statusCode === 401 && !S.book.reg_campaigns);
  const r = await post('reg_admin_from_event', { event_id: 'quad' }, asAdmin);
  const row = (S.book.reg_campaigns || [])[1] || [];
  check('建立成功：草稿、關聯這場活動、代碼 reg-活動代碼', r.statusCode === 200 && r.body.created === true && r.body.id === 'reg-quad' && row[0] === 'reg-quad' && row[2] === 'draft' && row[16] === 'quad', JSON.stringify([r.body, row]));
  check('　 名稱、地點、聯絡人從活動帶過來', row[1] === PRESS[1] && row[13] === '工研院中興院區' && row[7] === '王小明 03-1111111');
  check('★ 場次：A1、活動日期、活動時間、活動名稱、地點（報名頁看得到的就是這一行）', row[4] === 'A1｜2026-11-20｜14:00｜' + PRESS[1] + '｜工研院中興院區', row[4]);
  check('　 一般活動 → 媒體報名；報名對象沒被洗成企業', row[14] === 'media');
  check('　 報名還是草稿：活動頁不會出現按鈕，要到報名頁確認後才開放', (await link('quad')).body.url === '');
  const again = await post('reg_admin_from_event', { event_id: 'quad' }, asAdmin);
  check('★ 已經關聯過 → 回原本那一筆，不重複建', again.statusCode === 200 && again.body.created === false && again.body.id === 'reg-quad' && S.book.reg_campaigns.length === 2);
  await save({ id: 'reg-quad', title: '改過', event_id: 'quad', sessions_text: row[4], status: 'open' });
  check('　 開放之後，活動頁就有報名按鈕', /reg-quad/.test((await link('quad')).body.url));

  const biz = await post('reg_admin_from_event', { event_id: 'biz' }, asAdmin);
  const brow = S.book.reg_campaigns.find((x) => x[0] === 'reg-biz') || [];
  check('★ 企業場的活動 → 建成企業報名（audience=business），米亞的報名入口照樣看不到', biz.statusCode === 200 && brow[14] === 'business' && !(await R.listOpenCampaigns()).some((c) => c.id === 'reg-biz'));
  const open = await save({ id: 'reg-biz', title: '企業報名', event_id: 'biz', audience: 'business', sessions_text: brow[4], status: 'open' });
  check('　 企業報名沒填個資告知 → 不能開放（批次 118 的閘門照舊）', open.statusCode === 400 && /個資告知/.test(open.body.error), JSON.stringify(open.body));

  const nd = await post('reg_admin_from_event', { event_id: 'nodate' }, asAdmin);
  check('★ 活動還沒填日期 → 說清楚缺什麼，不建半套', nd.statusCode === 400 && /日期/.test(nd.body.error) && !S.book.reg_campaigns.some((x) => x[0] === 'reg-nodate'), JSON.stringify(nd.body));
  const nt = await post('reg_admin_from_event', { event_id: 'notime' }, asAdmin);
  check('　 活動還沒填時間 → 同上', nt.statusCode === 400 && /時間/.test(nt.body.error) && !S.book.reg_campaigns.some((x) => x[0] === 'reg-notime'));
  check('　 不存在的活動 → 404；格式不對 → 400', (await post('reg_admin_from_event', { event_id: 'nope' }, asAdmin)).statusCode === 404 && (await post('reg_admin_from_event', { event_id: '../x' }, asAdmin)).statusCode === 400);

  const w = await post('reg_admin_from_event', { event_id: 'Odd_ID.1' }, asAdmin);
  check('活動代碼有大寫、底線、句點 → 報名代碼合法（小寫、連字號）；名稱裡的「｜」不會把場次欄位切壞', w.statusCode === 400 || (/^[a-z0-9][a-z0-9-]{1,29}$/.test(w.body.id || '') && (S.book.reg_campaigns.find((x) => x[0] === w.body.id) || [])[4].split('｜').length === 5), JSON.stringify(w.body));
}

/* ───────── 四、頁面與結構 ───────── */
console.log('\n── 四、頁面與結構 ──');
{
  const ev = read('public/event.html');
  check('活動頁：向 reg_event_link 要連結，不等它（報名壞了活動頁照常能問）', /reg_event_link/.test(ev) && /addRegisterLink\(welcomeEl, event\.id\);/.test(ev) && !/await addRegisterLink/.test(ev));
  check('★ 活動頁：只接受 /register 的連結，而且用目前的網域組；文字用 textContent', /u\.pathname !== '\/register'/.test(ev) && /a\.href = '\/register' \+ u\.search/.test(ev) && /querySelector\('span'\)\.textContent/.test(ev));
  check('　 報名按鈕排在「用 LINE 問」前面（活動前最重要的動作）', /parent\.insertBefore\(a, parent\.querySelector\('\.line-link, \.line-qr'\)\)/.test(ev));
  const idx = read('public/index.html');
  check('後台：活動「更多」選單只有一個報名入口「這場的活動報名」（沒有就建、有就前往），建完帶去報名設定頁', /這場的活動報名/.test(idx) && !/用這場活動建立報名/.test(idx) && /reg_admin_from_event/.test(idx) && /\/registrations#\/c\/' \+ encodeURIComponent\(data\.id\) \+ '\/set/.test(idx));
  const rg = read('public/registrations.html');
  check('報名編輯頁：有「關聯活動」欄位，存檔帶 event_id（空字串＝解除）', /id="e-event"/.test(rg) && /event_id: \$\('e-event'\)\.value\.trim\(\)/.test(rg));
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 還是 11 支（Vercel Hobby 上限 12）；沒有新增排程', fns.length === 11 && JSON.parse(read('vercel.json')).crons.length === 10);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 152 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
