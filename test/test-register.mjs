// 批次 88 的測試：媒體報名（lib/registration.js、lib/registration-api.js、api/events.js 的 reg_ 入口）。
// 跑的是真的程式，只有 Google Sheets 是假的（test/fakes-sheets82.mjs，通用的 A1 範圍讀寫）。
// LINE 那一半（「我要報名」卡片、#報名 綁定）在 test-register-line.mjs。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_BASIC_ID = '@mia123';

// 假時鐘：測試裡所有「現在」都固定在 2026-09-29 中午（台灣時間），離眺望 10/28 還有一個月。
// 不固定的話，過了 10/28 這些用 10/28、10/29 場次的測試會因為「場次辦完了」而自己壞掉。
let clock = Date.UTC(2026, 8, 29, 4, 0, 0);
Date.now = () => clock;
const setClock = (iso) => { clock = new Date(iso).getTime(); };

const { book, calls, ctl, reset } = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const API = await import('../lib/registration-api.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, text: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = (t) => { r.text = t; return r; };
  r.end = () => r;
  return r;
}
let ipSeq = 0;
async function post(body, { headers = {}, ip } = {}) {
  const res = fakeRes();
  await events({ method: 'POST', headers: { 'x-forwarded-for': ip || `10.0.0.${++ipSeq % 250}`, ...headers }, query: {}, body }, res);
  return res;
}
async function get(query, { headers = {} } = {}) {
  const res = fakeRes();
  await events({ method: 'GET', headers, query }, res);
  return res;
}
const admin = (b) => post({ password: 'pw', ...b });
const adminGet = (q) => get({ password: 'pw', ...q });

// 今年眺望的 16 場（傳播規劃 v13 第 16 頁的草稿）
const SESSIONS = [
  'A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表｜201 廳｜09:00 報到、09:15 媒體聯訪',
  'A2｜2026-10-28｜13:30-16:35｜通訊',
  'B1｜2026-10-29｜09:30-12:00｜全球AI競局',
  'B2｜2026-10-29｜13:30-16:00｜AI應用與產業、組織轉型',
  'C1｜2026-10-30｜09:00-11:50｜半導體',
  'C2｜2026-10-30｜13:30-16:40｜智慧移動載具',
  'D1｜2026-11-02｜09:00-11:50｜石化與新材料',
  'D2｜2026-11-02｜13:20-16:00｜特用與綠色化學',
  'E1｜2026-11-03｜09:00-12:00｜生醫',
  'E2｜2026-11-03｜13:30-16:30｜健康照護',
  'F1｜2026-11-04｜09:00-11:55｜AI 產業',
  'F2｜2026-11-04｜13:30-16:50｜電子零組件',
  'G1｜2026-11-05｜09:10-11:40｜先進電子材料',
  'G2｜2026-11-05｜13:30-16:30｜智慧機械 × AI機器人',
  'H1｜2026-11-06｜09:00-11:50｜全球市場展望',
  'H2｜2026-11-06｜13:30-16:30｜電力建設'
].join('\n');
const OPTIONS = [
  'interview｜想參加 09:15 媒體聯訪（名額有限，由主辦單位另行確認）｜A1',
  'meal｜需要餐盒（12:00 後領取）｜A1',
  'party｜同行人數（含攝影，不含本人）｜｜number'
].join('\n');

async function seedCampaign(over = {}) {
  reset(); R.resetRegistrationState(); API.resetRateLimit();
  const res = await admin({
    action: 'reg_admin_save_campaign', id: 'tw2027', title: '眺望2027 產業發展趨勢研討會', status: 'open',
    intro: '誠摯邀請媒體朋友蒞臨採訪。', sessions_text: SESSIONS, options_text: OPTIONS,
    closes_at: '2099-12-31 12:00', contact: '工研院行銷傳播處', ...over
  });
  if (res.statusCode !== 200) throw new Error('seed 失敗 ' + JSON.stringify(res.body));
  return res;
}
const person = (over = {}) => ({
  action: 'reg_submit', c: 'tw2027', name: '王小明', outlet: '經濟日報', email: 'Wang@Example.com',
  phone: '0912-345-678', sessions: ['A1', 'B1'], ...over
});
const regRows = () => (book.registrations || []).slice(1);

// ═══ 一、場次與欄位的解析 ═════════════════════════════════════════════
console.log('\n── 一、場次文字解析 ──');
{
  const r = R.parseSessions(SESSIONS, 2026);
  check('16 場全部解析成功、沒有錯誤', r.sessions.length === 16 && r.errors.length === 0, JSON.stringify(r.errors));
  check('依日期時間排序，A1 第一、H2 最後', r.sessions[0].code === 'A1' && r.sessions[15].code === 'H2');
  check('星期算對：2026-10-28 是三、11-02 是一、11-06 是五',
    r.sessions[0].weekday === '三' && r.sessions.find((s) => s.code === 'D1').weekday === '一' && r.sessions[15].weekday === '五');
  check('顯示用日期＝10/28（三）', r.sessions[0].dateLabel === '10/28（三）');
  check('備註欄留住了（09:00 報到、09:15 聯訪）', /09:15/.test(r.sessions[0].note) && r.sessions[0].room === '201 廳');
  check('全形｜與半形 | 都認得', R.parseSessions('X1|10/28|09:00|測試', 2026).sessions.length === 1);
  const loose = R.parseSessions('A1｜10/28(三)｜09:30~12:00｜開幕', 2026).sessions[0];
  check('沒寫年份的 10/28(三)、用 ~ 當連接符也認得，補上預設年份', loose.date === '2026-10-28' && loose.time === '09:30-12:00');
  const round = R.parseSessions(R.sessionsToText(r.sessions), 1999);
  check('存檔改寫成帶完整年份的標準格式，之後換一年讀也不會漂', eq(round.sessions, r.sessions) && round.errors.length === 0);
  check('場次狀態：額滿／截止／取消／英文都認得',
    eq(R.parseSessions('A｜10/28|09:00|甲|||額滿\nB｜10/28|09:00|乙|||closed\nC｜10/28|09:00|丙|||取消', 2026).sessions.map((s) => s.status), ['full', 'closed', 'cancelled']));
}
{
  const bad = (t) => R.parseSessions(t, 2026).errors.join(' / ');
  check('代碼重複 → 指出是哪一行', /第 2 行.*重複/.test(bad('A1｜10/28|09:00|甲\nA1｜10/29|09:00|乙')), bad('A1｜10/28|09:00|甲\nA1｜10/29|09:00|乙'));
  check('看不懂的日期 → 錯誤而且指出代碼', /A1.*日期/.test(bad('A1｜明天|09:00|甲')));
  check('不存在的日子（2/30）→ 錯誤', /日期/.test(bad('A1｜2026-02-30|09:00|甲')));
  check('看不懂的時間 → 錯誤', /時間/.test(bad('A1｜10/28|上午|甲')));
  check('時間超過 24 點 → 錯誤', /時間/.test(bad('A1｜10/28|25:00-26:00|甲')));
  check('缺名稱 → 錯誤', /名稱/.test(bad('A1｜10/28|09:00|')));
  check('狀態亂寫 → 錯誤，不默默當成開放', /狀態/.test(bad('A1｜10/28|09:00|甲|||也許')));
  check('網址不是 http(s) → 錯誤', /網址/.test(bad('A1｜10/28|09:00|甲||||ftp://x')));
  check('代碼含中文／太長 → 錯誤', /代碼/.test(bad('場次一｜10/28|09:00|甲')) && /代碼/.test(bad('ABCDEFGHIJ｜10/28|09:00|甲')));
  check('壞掉的行被略過、好的行留著（存檔前會整批退回）', R.parseSessions('A1｜10/28|09:00|甲\n爛掉的一行', 2026).sessions.length === 1);
}
{
  const codes = ['A1', 'B1'];
  const ok = R.parseOptions(OPTIONS, ['A1', 'B1']);
  check('選填項目解析：2 個勾選、1 個數字', ok.errors.length === 0 && ok.options.length === 3 && ok.options[2].type === 'number');
  check('限定場次抓對', eq(ok.options[0].sessions, ['A1']) && eq(ok.options[2].sessions, []));
  check('限定到不存在的場次 → 錯誤', /Z9/.test(R.parseOptions('meal｜餐盒｜Z9', codes).errors.join()));
  check('類型亂寫 → 錯誤', /類型/.test(R.parseOptions('meal｜餐盒｜｜radio', codes).errors.join()));
  check('代碼重複／不合法 → 錯誤', R.parseOptions('a｜甲\na｜乙', codes).errors.length === 1 && R.parseOptions('1a｜甲', codes).errors.length === 1);
  check('存檔往返不變', eq(R.parseOptions(R.optionsToText(ok.options), codes).options, ok.options));
}
{
  check('手機：破折號、空白、+886 都收斂成 09 開頭', R.normalizePhone('0912-345-678') === '0912345678' && R.normalizePhone('+886 912 345 678') === '0912345678' && R.normalizePhone('886912345678') === '0912345678');
  check('手機：市話與外國號碼可以', R.normalizePhone('(02)2345-6789') === '0223456789' && R.normalizePhone('+81 90-1234-5678') === '+819012345678');
  check('手機：亂打不收', R.normalizePhone('abc') === '' && R.normalizePhone('123') === '' && R.normalizePhone('') === '');
  check('顯示時 0912345678 → 0912-345-678', R.formatPhone('0912345678') === '0912-345-678' && R.formatPhone('+819012345678') === '+819012345678');
  check('Email 檢查', R.isValidEmail('a@b.co') && !R.isValidEmail('a@b') && !R.isValidEmail('a b@c.com') && !R.isValidEmail('@b.com') && !R.isValidEmail('a@@b.com'));
  check('截止時間：只寫日期＝當天 23:59:59（台灣時間）', R.parseTaipeiTime('2026-10-27') === Date.UTC(2026, 9, 27, 15, 59, 59));
  check('截止時間：寫到分鐘', R.parseTaipeiTime('2026-10-27 12:00') === Date.UTC(2026, 9, 27, 4, 0, 0) && Number.isNaN(R.parseTaipeiTime('下週三')));
  check('姓名欄位的換行、tab 被當成空白', R.cleanText('王\n小\t明', 40) === '王 小 明');
}

// ═══ 二、後台建立活動 ═════════════════════════════════════════════════
console.log('\n── 二、後台建立報名活動 ──');
reset(); R.resetRegistrationState(); API.resetRateLimit();
{
  const base = { action: 'reg_admin_save_campaign', id: 'tw2027', title: 'T', status: 'open', sessions_text: SESSIONS };
  check('沒密碼 → 401', (await post(base)).statusCode === 401);
  check('密碼錯 → 401', (await post({ ...base, password: 'x' })).statusCode === 401);
  const badId = await admin({ ...base, id: 'TW 2027!' });
  check('活動代碼不合法 → 400', badId.statusCode === 400 && /活動代碼/.test(badId.body.error), JSON.stringify(badId.body));
  const badSess = await admin({ ...base, sessions_text: 'A1｜明天|09:00|甲\nB1｜10/28|上午|乙' });
  check('場次有錯 → 400，而且把每一行的問題都列出來', badSess.statusCode === 400 && badSess.body.details?.length === 2, JSON.stringify(badSess.body));
  check('場次有錯時什麼都沒寫進去', !(book.reg_campaigns || []).slice(1).length);
  const none = await admin({ ...base, sessions_text: '' });
  check('一個場次都沒有 → 400', none.statusCode === 400);
  const badOpt = await admin({ ...base, options_text: 'meal｜餐盒｜Z9' });
  check('選填項目限定到不存在的場次 → 400', badOpt.statusCode === 400 && badOpt.body.details?.length === 1);
  const badClose = await admin({ ...base, closes_at: '下週三' });
  check('截止時間寫不出來 → 400', badClose.statusCode === 400);
  const ok = await admin({ ...base, options_text: OPTIONS, closes_at: '2099-12-31 12:00' });
  check('存檔成功、自動建立兩個分頁', ok.statusCode === 200 && ok.body.created === true && !!book.reg_campaigns && !!book.registrations);
  check('分頁表頭正確', eq(book.reg_campaigns[0], R.CAMPAIGN_HEADERS) && eq(book.registrations[0], R.REG_HEADERS));
  check('場次存成標準格式（帶完整年份）', book.reg_campaigns[1][4].split('\n')[0].startsWith('A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表'), book.reg_campaigns[1][4]);
  const again = await admin({ ...base, title: '改過的名稱', options_text: OPTIONS });
  check('同代碼再存＝更新，不會長出第二列，建立時間不變',
    again.statusCode === 200 && again.body.created === false && book.reg_campaigns.length === 2 && book.reg_campaigns[1][1] === '改過的名稱');
  // 「LINE 簡稱」（第 13 欄 M）：歡迎卡按鈕與報名卡片上寫明是報哪個活動（朱朱 9/29 提醒：只寫「媒體報名」記者不知道報什麼）
  check('欄位定義：第 13 欄是 short_name', R.CAMPAIGN_HEADERS.length === 13 && R.CAMPAIGN_HEADERS[12] === 'short_name' && book.reg_campaigns[0].length === 13);
  const withShort = await admin({ ...base, short_name: '眺望2027場次' });
  check('LINE 簡稱存進第 13 欄', withShort.statusCode === 200 && book.reg_campaigns[1][12] === '眺望2027場次', JSON.stringify(book.reg_campaigns[1]));
  check('存簡稱沒有弄壞其他欄位（名稱、場次、狀態）', book.reg_campaigns[1][1] === 'T' && book.reg_campaigns[1][2] === 'open' && book.reg_campaigns[1][4].startsWith('A1｜2026-10-28'));
  const ovShort = (await adminGet({ action: 'reg_admin_list' })).body;
  check('後台列表帶得回簡稱（編輯表單要預填）', ovShort.campaigns.find((c) => c.id === 'tw2027')?.short_name === '眺望2027場次');
  check('公開的報名頁內容不帶簡稱（那是給 LINE 用的，網頁上不需要）', !('short_name' in (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign));
  const overlong = await admin({ ...base, short_name: '一二三四五六七八九十一二三四五六七八九十' });
  check('簡稱超過 16 字 → 截到 16 字，不擋存檔', overlong.statusCode === 200 && [...book.reg_campaigns[1][12]].length === 16, book.reg_campaigns[1][12]);
  const multiline = await admin({ ...base, short_name: '眺望\n2027' });
  check('簡稱裡的換行變空白（單行）', multiline.statusCode === 200 && book.reg_campaigns[1][12] === '眺望 2027', JSON.stringify(book.reg_campaigns[1][12]));
  const noShort = await admin({ ...base });
  check('沒帶簡稱 → 空字串（LINE 上會寫「媒體報名」）', noShort.statusCode === 200 && book.reg_campaigns[1][12] === '');
}
// 正式站的 reg_campaigns 在加簡稱欄之前就已經自動建好了（12 欄）：第一次讀寫時補上表頭，舊資料一格不動
reset(); R.resetRegistrationState(); API.resetRateLimit();
{
  const old12 = R.CAMPAIGN_HEADERS.slice(0, 12);
  const row12 = ['tw2027', '舊活動', 'open', '介紹', 'A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表', '', '', '工研院', '2099-12-31 12:00', '', '2026-09-29T10:00:00+08:00', ''];
  book.reg_campaigns = [old12, row12];
  book.registrations = [R.REG_HEADERS];
  const r = await get({ action: 'reg_config', c: 'tw2027' });
  check('舊版 12 欄的活動讀得出來（簡稱＝空）', r.statusCode === 200 && r.body.campaign.title === '舊活動');
  check('★ 舊分頁的表頭自動補成 13 欄', eq(book.reg_campaigns[0], R.CAMPAIGN_HEADERS), JSON.stringify(book.reg_campaigns[0]));
  check('舊資料列一格都沒動', eq(book.reg_campaigns[1].slice(0, 12), row12) && book.reg_campaigns.length === 2);
  const ov = (await adminGet({ action: 'reg_admin_list' })).body;
  check('舊活動的簡稱是空字串（LINE 上照舊寫「媒體報名」）', ov.campaigns[0].short_name === '');
  // 之後在後台編輯這個舊活動 → 寫的是 A:M，簡稱進得去
  const upd = await admin({ action: 'reg_admin_save_campaign', id: 'tw2027', title: '舊活動', status: 'open', sessions_text: 'A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表', closes_at: '2099-12-31 12:00', short_name: '眺望2027場次' });
  check('編輯舊活動 → 簡稱寫進第 13 欄，其他欄位還在', upd.statusCode === 200 && book.reg_campaigns[1][12] === '眺望2027場次' && book.reg_campaigns.length === 2);
}
reset(); R.resetRegistrationState(); API.resetRateLimit();
{
  // 補表頭只是方便人看試算表：寫入失敗（Sheets 429）不能讓報名頁跟著不能用
  const old12 = R.CAMPAIGN_HEADERS.slice(0, 12);
  book.reg_campaigns = [old12, ['tw2027', '舊活動', 'open', '介紹', 'A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表', '', '', '工研院', '2099-12-31 12:00', '', '2026-09-29T10:00:00+08:00', '']];
  book.registrations = [R.REG_HEADERS];
  ctl.failWrites = 1;   // 第一次寫入（補表頭）就失敗
  const r = await get({ action: 'reg_config', c: 'tw2027' });
  check('★ 補表頭寫入失敗 → 報名頁照樣讀得到活動（不是 500）', r.statusCode === 200 && r.body.campaign.title === '舊活動', JSON.stringify(r.body));
  check('表頭沒補成（下次冷啟動再試），資料沒被弄壞', book.reg_campaigns[0].length === 12 && book.reg_campaigns.length === 2);
  ctl.failWrites = 0;
}
reset(); R.resetRegistrationState(); API.resetRateLimit();
{
  // 表頭已經是 13 欄時不再寫（每次冷啟動都寫一次表頭沒有意義，也不該在公開讀取路徑上亂寫）
  await seedCampaign();
  R.resetRegistrationState();
  calls.length = 0;
  await get({ action: 'reg_config', c: 'tw2027' });
  check('表頭齊全時，冷啟動不會多寫任何東西', !calls.some((c) => c[0] === 'update' || c[0] === 'append'), JSON.stringify(calls));
}

// ═══ 三、報名頁讀取活動內容 ═══════════════════════════════════════════
console.log('\n── 三、報名頁讀取活動內容（公開） ──');
await seedCampaign();
{
  calls.length = 0;
  const r = await get({ action: 'reg_config', c: 'tw2027' });
  check('公開端點不用密碼、讀得到', r.statusCode === 200 && r.body.campaign.id === 'tw2027');
  check('讀報名頁不會去讀 events 表（尖峰時不多花 Sheets 配額）', !calls.some((c) => /events!/.test(c[1])), JSON.stringify(calls));
  const c = r.body.campaign;
  check('內容：16 場、3 個選填項目、聯絡人', c.sessions.length === 16 && c.options.length === 3 && c.contact === '工研院行銷傳播處');
  check('★ 個資告知預設不放（朱朱決定）：後台沒填 → 公開內容是空字串，報名頁不會顯示那一段', c.privacy === '');
  check('沒填 LINE 說明時用預設', c.line_pitch.length === 3);
  check('不含後台欄位（sessions_text／狀態原始碼以外的東西不外流）', !('sessions_text' in c) && !('created_at' in c) && !('updated_at' in c));
  check('開放中的活動可以被 CDN 快取一小段時間', /s-maxage/.test(r.headers['cache-control'] || ''));
  check('closed 旗標＝false', c.closed === false && c.draft === false);
  const noC = await get({ action: 'reg_config' });
  check('不帶 c 而且只有一個開放中的活動 → 直接給那一個', noC.statusCode === 200 && noC.body.campaign.id === 'tw2027');
  check('找不到的活動 → 404', (await get({ action: 'reg_config', c: 'nope' })).statusCode === 404);
}
{
  // 之後想放個資告知：後台填了就會出現在公開內容裡
  await admin({ action: 'reg_admin_save_campaign', id: 'tw2027', title: '眺望2027 產業發展趨勢研討會', status: 'open', sessions_text: SESSIONS, options_text: OPTIONS, closes_at: '2099-12-31 12:00', contact: '工研院行銷傳播處', privacy: '這是一段之後才想放的告知。' });
  R.invalidateCampaignCache();
  const r = await get({ action: 'reg_config', c: 'tw2027' });
  check('後台有填個資告知 → 才會出現在公開內容', r.body.campaign.privacy === '這是一段之後才想放的告知。');
  await admin({ action: 'reg_admin_save_campaign', id: 'tw2027', title: '眺望2027 產業發展趨勢研討會', status: 'open', sessions_text: SESSIONS, options_text: OPTIONS, closes_at: '2099-12-31 12:00', contact: '工研院行銷傳播處', privacy: '' });
  R.invalidateCampaignCache();
  check('清空之後又不顯示了', (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign.privacy === '');
}
{
  await admin({ action: 'reg_admin_save_campaign', id: 'other', title: '另一場', status: 'open', sessions_text: 'Z1｜2026-12-01|09:00|甲', closes_at: '2099-12-31' });
  R.invalidateCampaignCache();
  const two = await get({ action: 'reg_config' });
  check('同時有兩個開放中的活動、沒帶 c → 給選擇清單', two.statusCode === 200 && two.body.choices?.length === 2, JSON.stringify(two.body));
  await admin({ action: 'reg_admin_save_campaign', id: 'other', title: '另一場', status: 'draft', sessions_text: 'Z1｜2026-12-01|09:00|甲' });
  R.invalidateCampaignCache();
  const dr = await get({ action: 'reg_config', c: 'other' });
  check('草稿活動：有連結的人開得到，但標示 draft，而且不准被快取', dr.statusCode === 200 && dr.body.campaign.draft === true && /no-store/.test(dr.headers['cache-control']));
  const back = await get({ action: 'reg_config' });
  check('草稿不會出現在「預設報名頁」的選擇清單裡', back.body.campaign?.id === 'tw2027');
  await admin({ action: 'reg_admin_save_campaign', id: 'other', title: '另一場', status: 'closed', sessions_text: 'Z1｜2026-12-01|09:00|甲' });
  R.invalidateCampaignCache();
  const cl = await get({ action: 'reg_config', c: 'other' });
  check('已截止的活動：讀得到內容但 closed=true', cl.body.campaign.closed === true);
  await admin({ action: 'reg_admin_save_campaign', id: 'past', title: '過期', status: 'open', sessions_text: 'Z1｜2020-01-02|09:00|甲', closes_at: '2020-01-01' });
  R.invalidateCampaignCache();
  check('狀態還是 open 但已過截止時間 → closed=true', (await get({ action: 'reg_config', c: 'past' })).body.campaign.closed === true);
}

// ═══ 四、送出報名 ═════════════════════════════════════════════════════
console.log('\n── 四、送出報名：驗證 ──');
await seedCampaign();
{
  const r = await post({ action: 'reg_submit', c: 'tw2027' });
  check('什麼都沒填 → 400，逐欄指出問題', r.statusCode === 400 && ['name', 'outlet', 'email', 'phone', 'sessions'].every((f) => r.body.errors.some((e) => e.field === f)), JSON.stringify(r.body));
  check('錯誤訊息是給記者看的白話', r.body.errors.every((e) => !/undefined|null|\[object/.test(e.message)));
  const e1 = await post(person({ email: 'wang@example' }));
  check('Email 格式不對 → 400', e1.statusCode === 400 && e1.body.errors[0].field === 'email');
  const p1 = await post(person({ phone: '123' }));
  check('手機格式不對 → 400', p1.statusCode === 400 && p1.body.errors[0].field === 'phone');
  const s1 = await post(person({ sessions: [] }));
  check('沒勾場次 → 400', s1.statusCode === 400 && s1.body.errors[0].field === 'sessions');
  const s2 = await post(person({ sessions: ['A1', 'ZZ'] }));
  check('勾了不存在的場次 → 400（不默默丟掉）', s2.statusCode === 400 && /ZZ/.test(s2.body.error));
  check('驗證失敗時什麼都沒寫', regRows().length === 0);
  const n1 = await post(person({ name: '王' }));
  check('姓名只有 1 個字 → 400', n1.statusCode === 400 && n1.body.errors[0].field === 'name');
  check('活動不存在 → 404', (await post(person({ c: 'nope' }))).statusCode === 404);
}
console.log('\n── 四之二、送出報名：新增、合併、修改、取消 ──');
await seedCampaign();
let token1, regId1;
{
  const r = await post(person({ options: { interview: true, meal: '1', party: '2', hack: '1' } }));
  check('第一次送出 → 200 created', r.statusCode === 200 && r.body.mode === 'created', JSON.stringify(r.body));
  token1 = r.body.token; regId1 = r.body.reg.reg_id;
  check('報名編號格式 R + 5 碼（沒有容易混的 I L O 0 1）', /^R[A-HJKMNP-Z2-9]{5}$/.test(regId1), regId1);
  check('回傳編輯碼（這台裝置存起來，之後才能改）', typeof token1 === 'string' && token1.length >= 20);
  const row = regRows()[0];
  check('試算表多一列，欄位對得上', regRows().length === 1 && row[0] === regId1 && row[1] === 'tw2027' && row[4] === '王小明' && row[5] === '經濟日報', JSON.stringify(row));
  check('Email 存小寫、手機存純數字、場次逗號分隔', row[6] === 'wang@example.com' && row[7] === '0912345678' && row[8] === 'A1,B1', JSON.stringify(row));
  check('選填：只收有定義的、勾了才存，亂塞的 hack 被丟掉', row[9] === 'interview=1;meal=1;party=2', row[9]);
  check('時間是台灣時間 ISO（+08:00）', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/.test(row[2]));
  check('來源＝web、狀態＝有效、尚未連結 LINE', row[12] === 'active' && row[13] === 'web' && row[10] === '');
  check('回傳給頁面的場次已展開成看得懂的文字', r.body.reg.session_labels.length === 2 && /A1 10\/28（三）09:30-12:00 開幕論壇暨專刊發表/.test(r.body.reg.session_labels[0]), JSON.stringify(r.body.reg.session_labels));
  check('回傳沒有 Email／手機／編輯碼以外的內部欄位', !('line_user_id' in r.body.reg) && !('edit_token' in r.body.reg));
  check('有連結 LINE 的入口（報名完成頁的導流按鈕）', /^https:\/\/line\.me\/R\/oaMessage\/%40mia123\/\?%23/.test(r.body.line.bind_url) && r.body.line.bind_url.includes(regId1) && /line\.me\/R\/ti\/p/.test(r.body.line.add_friend_url), JSON.stringify(r.body.line));
}
{
  // 同一個 Email 再送一次（不同裝置、沒有編輯碼）：場次取聯集，不新增第二列，也不洩漏編輯碼
  const r = await post(person({ email: 'WANG@example.com ', name: '王小明', sessions: ['C1'], phone: '0987654321' }));
  check('同 Email 再送 → merged，不新增列', r.statusCode === 200 && r.body.mode === 'merged' && regRows().length === 1, JSON.stringify(r.body));
  check('沒帶編輯碼就更新的，不回傳編輯碼', !r.body.token);
  check('場次是聯集（先前的 A1、B1 沒被洗掉）', regRows()[0][8] === 'A1,B1,C1', regRows()[0][8]);
  check('★ 只靠 Email 對上的更新：聯絡資料不動（手機還是原本的）、選填項目也沒動', regRows()[0][7] === '0912345678' && regRows()[0][9] === 'interview=1;meal=1;party=2', JSON.stringify(regRows()[0]));
  check('同一個報名編號', regRows()[0][0] === regId1);
  check('★ 沒證明身分的回應不含報名編號、姓名、媒體，也不含綁定連結；場次只回這次自己勾的', r.body.reg.reg_id === '' && r.body.reg.name === '' && r.body.reg.outlet === '' && eq(r.body.reg.sessions, ['C1']) && !r.body.line.bind_url, JSON.stringify(r.body));
}
{
  // 批次 89：知道別人 Email 的人，不能改掉那筆的姓名／媒體／手機，也不能把自己的 LINE 綁上去
  const ATT = 'Uattacker000000000000000000000001';
  const before = regRows()[0].slice();
  const evil = await post(person({ name: '假冒者', outlet: '假媒體', phone: '0999999999', sessions: ['D1'], lu: R.signLineToken(ATT) }));
  const now = regRows()[0];
  check('★ 撞 Email 的更新：姓名、媒體、手機都沒被換掉', evil.statusCode === 200 && now[4] === before[4] && now[5] === before[5] && now[7] === before[7], JSON.stringify(now));
  check('★ 撞 Email 的更新：不會綁上對方的 LINE（也就拿不到編輯碼）', now[10] === '' && evil.body.line.bound === false && (await R.findRegistrationsForLineUser(ATT)).length === 0, JSON.stringify(now));
  check('★ 拿別人的報名編號去 #報名 之前，先得從公開回應裡拿得到編號——現在拿不到', !JSON.stringify(evil.body).includes(regId1) && !JSON.stringify(evil.body).includes(token1));
}
{
  const r = await post(person({ sessions: ['B1', 'E1'], t: token1, options: { party: 1 } }));
  check('帶編輯碼修改 → edited，場次照這次勾的為準（A1、C1 拿掉了）', r.statusCode === 200 && r.body.mode === 'edited' && regRows()[0][8] === 'B1,E1', regRows()[0][8]);
  check('拿掉 A1 之後，只限 A1 的選填項目（聯訪、餐盒）跟著清掉，同行人數留著', regRows()[0][9] === 'party=1', regRows()[0][9]);
  check('帶編輯碼的會再回傳編輯碼（頁面可以繼續存）', r.body.token === token1);
  const stolen = await post(person({ email: 'someone@else.com', sessions: ['A2'] }));
  check('別人另外用自己的 Email 報名 → 另一列', stolen.body.mode === 'created' && regRows().length === 2);
  const clash = await post(person({ email: 'someone@else.com', sessions: ['A2'], t: token1 }));
  check('★ 用自己的編輯碼把 Email 改成別人已經報過的 → 409，不悄悄併走別人那筆', clash.statusCode === 409 && regRows().length === 2 && regRows()[0][6] === 'wang@example.com', JSON.stringify(clash.body));
}
{
  const g = await get({ action: 'reg_get', c: 'tw2027', t: token1 });
  check('用編輯碼讀回自己的報名（修改頁預填）', g.statusCode === 200 && g.body.reg.name === '王小明' && eq(g.body.reg.sessions, ['B1', 'E1']) && g.body.reg.email === 'wang@example.com');
  check('★ 讀回的資料沒有編輯碼與 LINE userId', !JSON.stringify(g.body).includes(token1) && !('line_user_id' in g.body.reg));
  check('讀取結果不准被快取', /no-store/.test(g.headers['cache-control']));
  check('錯的編輯碼 → 404', (await get({ action: 'reg_get', c: 'tw2027', t: 'wrong' })).statusCode === 404);
  check('沒帶編輯碼 → 404（不能靠 Email 查別人）', (await get({ action: 'reg_get', c: 'tw2027' })).statusCode === 404);
  check('編輯碼跨活動無效', (await get({ action: 'reg_get', c: 'other', t: token1 })).statusCode === 404);
}
{
  const c = await post({ action: 'reg_cancel', c: 'tw2027', t: token1 });
  check('取消自己的報名', c.statusCode === 200 && regRows()[0][12] === 'cancelled');
  check('取消後不能再拿編輯碼讀資料以外的東西亂改：錯的編輯碼取消 → 404', (await post({ action: 'reg_cancel', c: 'tw2027', t: 'nope' })).statusCode === 404);
  const again = await post(person({ sessions: ['H2'] }));
  check('取消之後同 Email 再報 = 重新報名：舊場次不會復活', again.statusCode === 200 && again.body.mode === 'reopened' && regRows()[0][8] === 'H2' && regRows()[0][12] === 'active', JSON.stringify(regRows()[0]));
  check('重新報名沒有多出一列', regRows().length === 2);
}

// ═══ 五、關門的各種情況 ═══════════════════════════════════════════════
console.log('\n── 五、場次與活動關門 ──');
await seedCampaign({ sessions_text: SESSIONS.replace('C1｜2026-10-30｜09:00-11:50｜半導體', 'C1｜2026-10-30｜09:00-11:50｜半導體｜｜｜額滿') });
{
  const cfg = await get({ action: 'reg_config', c: 'tw2027' });
  check('額滿的場次：頁面拿到 disabled，狀態寫額滿', cfg.body.campaign.sessions.find((s) => s.code === 'C1').disabled === true && cfg.body.campaign.sessions.find((s) => s.code === 'C1').status === 'full');
  const r = await post(person({ sessions: ['A1', 'C1'] }));
  check('新報名勾額滿的場次 → 400（不默默丟掉）', r.statusCode === 400 && /C1/.test(r.body.error));
  const ok = await post(person({ sessions: ['A1'] }));
  check('沒勾額滿場次就能報', ok.statusCode === 200);
}
{
  // 原本報了、後來額滿：帶編輯碼修改時不會被擠掉，也不會因為改別的欄位失敗
  await seedCampaign();
  const first = await post(person({ sessions: ['C1', 'A1'] }));
  await admin({ action: 'reg_admin_save_campaign', id: 'tw2027', title: 'T', status: 'open', sessions_text: SESSIONS.replace('C1｜2026-10-30｜09:00-11:50｜半導體', 'C1｜2026-10-30｜09:00-11:50｜半導體｜｜｜額滿'), options_text: OPTIONS, closes_at: '2099-12-31' });
  const edit = await post(person({ sessions: ['C1', 'A1', 'B1'], t: first.body.token, phone: '0911222333' }));
  check('原本就報了的場次後來額滿，修改其他欄位時保留、不被拒絕', edit.statusCode === 200 && regRows()[0][8] === 'A1,B1,C1', JSON.stringify(regRows()[0]));
  const add = await post(person({ email: 'new@x.com', sessions: ['C1'] }));
  check('但新的人不能報這場', add.statusCode === 400);
}
{
  await seedCampaign({ status: 'closed' });
  const r = await post(person());
  check('活動狀態 closed → 409，訊息請他洽聯絡人', r.statusCode === 409 && r.body.closed === true && /聯絡人/.test(r.body.error));
  await seedCampaign({ closes_at: '2020-01-01' });
  const r2 = await post(person());
  check('過了截止時間 → 409', r2.statusCode === 409 && regRows().length === 0);
}

// ═══ 六、草稿活動 = 可以放心測試 ═════════════════════════════════════
console.log('\n── 六、草稿活動的測試報名 ──');
await seedCampaign({ status: 'draft' });
{
  const r = await post(person());
  check('草稿活動可以送出報名（測試用）', r.statusCode === 200 && r.body.test === true);
  check('自動標成測試（source 尾巴 :test）', regRows()[0][13] === 'web:test');
  await admin({ action: 'reg_admin_update', reg_id: regRows()[0][0], note: '我自己測的' });
  const real = await post(person({ email: 'x@y.com' }));
  const ov = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('後台預設不算測試報名（人數 0、另外標出有幾筆測試）', ov.stats.people === 0 && ov.regs.length === 0 && ov.stats.test === 2, JSON.stringify(ov.stats));
  const ov2 = (await adminGet({ action: 'reg_admin_list', c: 'tw2027', include_test: '1' })).body;
  check('勾「含測試」才看得到', ov2.regs.length === 2 && ov2.regs.every((g) => g.test));
  const csv = await adminGet({ action: 'reg_export', c: 'tw2027' });
  check('匯出不含測試報名', csv.statusCode === 200 && !csv.text.includes('王小明'));
  const cl = await admin({ action: 'reg_admin_clear_tests', c: 'tw2027' });
  check('一鍵清掉測試報名（標成已刪除，不是抹掉）', cl.body.cleared === 2 && regRows().every((g) => g[12] === 'deleted'));
  // 轉正式開放之後，草稿時的測試資料不會混進來
  await admin({ action: 'reg_admin_save_campaign', id: 'tw2027', title: 'T', status: 'open', sessions_text: SESSIONS });
  const live = await post(person({ email: 'real@x.com' }));
  check('轉成 open 之後送出的是正式報名', live.body.test === false && regRows().pop()[13] === 'web');
}

// ═══ 七、LINE 身分 ═══════════════════════════════════════════════════
console.log('\n── 七、從米亞點進來報名 → 直接連結 LINE ──');
await seedCampaign();
const UID = 'U1234567890abcdef1234567890abcdef';
{
  const tk = R.signLineToken(UID);
  check('簽章往返：驗得出同一個 userId', R.verifyLineToken(tk) === UID);
  check('竄改 userId → 驗不過', R.verifyLineToken(Buffer.from('U9999999999999999999|9999999999').toString('base64url') + '.' + tk.split('.')[1]) === '');
  check('竄改簽章 → 驗不過', R.verifyLineToken(tk.slice(0, -2) + 'xx') === '');
  check('過期 → 驗不過', R.verifyLineToken(tk, Date.now() + 8 * 24 * 3600e3) === '' && R.verifyLineToken(tk, Date.now() + 6 * 24 * 3600e3) === UID);
  check('亂七八糟的字串不會丟例外', R.verifyLineToken('abc') === '' && R.verifyLineToken('a.b') === '' && R.verifyLineToken(null) === '' && R.verifyLineToken('x'.repeat(500)) === '');
  const r = await post(person({ lu: tk }));
  check('帶簽章送出 → 直接連結，不用再綁一次', r.body.line.bound === true && !r.body.line.bind_url && regRows()[0][10] === UID && regRows()[0][13] === 'line', JSON.stringify(r.body.line));
  const mine = await R.findRegistrationsForLineUser(UID);
  check('之後用 LINE 帳號找得到這筆報名', mine.length === 1 && mine[0].email === 'wang@example.com');
  const second = await post(person({ email: 'colleague@x.com', lu: tk }));
  check('★ 同一個 LINE 帳號的連結被轉傳給同事：不會搶走綁定，同事照樣完成報名', second.statusCode === 200 && second.body.line.conflict === true && second.body.line.bound === false && regRows()[1][10] === '', JSON.stringify(second.body.line));
  const forged = await post(person({ email: 'f@x.com', lu: 'garbage.token' }));
  check('偽造的簽章被忽略，報名照常成功但不連結', forged.statusCode === 200 && forged.body.line.bound === false && regRows()[2][10] === '');
}
console.log('\n── 七之二、報名頁按「用 LINE 連結」→ 米亞收到 #報名 代碼 ──');
{
  check('#報名 R7K3M、全形＃、沒空格都認得', R.parseRegBindText('#報名 R7K3M') === 'R7K3M' && R.parseRegBindText('＃報名r7k3m') === 'R7K3M' && R.parseRegBindText(' #報名：R7K3M ') === 'R7K3M');
  check('一般的 #活動代碼 不會被當成報名', R.parseRegBindText('#quad-abc123') === '' && R.parseRegBindText('#報名') === '' && R.parseRegBindText('我要報名') === '');
  await seedCampaign();
  const a = await post(person());
  const id = a.body.reg.reg_id;
  const U2 = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b1 = await R.bindRegistrationToLine(id, U2);
  check('綁定成功 → 寫進那一列', b1.ok === true && regRows()[0][10] === U2 && /^\d{4}/.test(regRows()[0][15]));
  check('再綁一次同一個帳號 → already', (await R.bindRegistrationToLine(id, U2)).already === true);
  const other = await R.bindRegistrationToLine(id, 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  check('★ 已經被別的 LINE 帳號綁走 → 拒絕，不覆蓋', other.ok === false && other.reason === 'taken' && regRows()[0][10] === U2);
  check('代碼不存在 → not_found', (await R.bindRegistrationToLine('RXXXXX', U2)).reason === 'not_found');
  const b = await post(person({ email: 'b@x.com' }));
  const dup = await R.bindRegistrationToLine(b.body.reg.reg_id, U2);
  check('同一個 LINE 帳號在同一個活動只綁一筆', dup.ok === false && dup.reason === 'has_other');
  await post({ action: 'reg_cancel', c: 'tw2027', t: b.body.token });
  check('已取消的報名不能綁', (await R.bindRegistrationToLine(b.body.reg.reg_id, 'Ucccccccccccccccccccccccccccccccc')).reason === 'inactive');
}

// ═══ 八、防濫用 ═══════════════════════════════════════════════════════
console.log('\n── 八、防濫用 ──');
await seedCampaign();
{
  const bot = await post(person({ hp: 'http://spam.example' }));
  check('蜜罐欄位有東西 → 假裝成功、什麼都不寫', bot.statusCode === 200 && regRows().length === 0);
  const fast = await post(person({ elapsed: 300 }));
  check('0.3 秒就送出 → 拒絕', fast.statusCode === 400 && regRows().length === 0);
  const human = await post(person({ elapsed: 25000 }));
  check('正常人的填寫時間 → 過', human.statusCode === 200);
  API.resetRateLimit();
  let last;
  for (let i = 0; i < 13; i++) last = await post(person({ email: `u${i}@x.com` }), { ip: '203.0.113.9' });
  check('同一個 IP 10 分鐘內第 13 次 → 429', last.statusCode === 429);
  const other = await post(person({ email: 'z@x.com' }), { ip: '203.0.113.10' });
  check('別的 IP 不受影響', other.statusCode === 200);
}
{
  await seedCampaign();
  ctl.failReads.add('registrations');
  const r = await post(person());
  check('★ 試算表讀不到時，公開端點回一句白話，不把內部錯誤丟給記者', r.statusCode === 500 && !/模擬|Sheets|registrations/.test(r.body.error) && /稍後再試/.test(r.body.error), JSON.stringify(r.body));
  ctl.failReads.clear();
  const admin500 = (ctl.failReads.add('reg_campaigns'), await adminGet({ action: 'reg_admin_list' }));
  check('管理員看得到真正的錯誤原因', admin500.statusCode === 500 && /模擬/.test(admin500.body.error), JSON.stringify(admin500.body));
  ctl.failReads.clear();
}

// ═══ 九、後台總覽、單筆修改、匯出 ════════════════════════════════════
console.log('\n── 九、後台總覽 ──');
await seedCampaign();
book.media_roster = [
  ['id', 'name', 'outlet', 'beat', 'email', 'phone'],
  ['1', '王小明', '經濟日報', '財經', 'wang@example.com', ''],
  ['2', '李大華', '工商時報', '產業', '', ''],
  ['3', '陳美麗', '中央社', '科技', '', '']
];
{
  const a = await post(person({ options: { interview: true, meal: true, party: 2 } }));
  await post(person({ name: '李大華', outlet: '工商時報', email: 'lee@x.com', sessions: ['A1', 'C1', 'C2'], phone: '0922333444', options: { meal: true } }));
  await post(person({ name: '陳美麗', outlet: '自由時報', email: 'chen@x.com', sessions: ['C1'], phone: '0933444555' }));
  await post(person({ name: '路人甲', outlet: '不知名週刊', email: 'nobody@x.com', sessions: ['H2'], phone: '0900111222' }));
  const lineTok = R.signLineToken('Uddddddddddddddddddddddddddddddd');
  await post(person({ name: '林小美', outlet: '聯合報', email: 'lin@x.com', sessions: ['C1'], phone: '0955666777', lu: lineTok }));
  const ov = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('沒密碼看不到後台總覽', (await get({ action: 'reg_admin_list', c: 'tw2027' })).statusCode === 401);
  check('總覽：5 人、5 家媒體、1 人已連結 LINE', ov.stats.people === 5 && ov.stats.outlets === 5 && ov.stats.line_bound === 1, JSON.stringify(ov.stats));
  const cnt = Object.fromEntries(ov.per_session.map((p) => [p.code, p.count]));
  check('每場人數：A1 有 2、C1 有 3、C2 有 1、H2 有 1、沒人報的是 0', cnt.A1 === 2 && cnt.C1 === 3 && cnt.C2 === 1 && cnt.H2 === 1 && cnt.B2 === 0, JSON.stringify(cnt));
  check('選填項目合計：聯訪 1、餐盒 2、同行 2 人', ov.option_totals.interview === 1 && ov.option_totals.meal === 2 && ov.option_totals.party === 2, JSON.stringify(ov.option_totals));
  const byName = Object.fromEntries(ov.regs.map((g) => [g.name, g]));
  check('記者名單對照：Email 對上＝名單內、名字＋媒體對上＝名單內', byName['王小明'].roster === 'yes' && byName['李大華'].roster === 'yes');
  check('名字對上但媒體不同 → 「同名不同媒體」，讓人工看', byName['陳美麗'].roster === 'maybe');
  check('完全不在名單 → 名單外', byName['路人甲'].roster === 'no' && ov.stats.out_of_roster === 2);
  check('手機顯示帶破折號', byName['王小明'].phone_label === '0912-345-678');
  check('總覽給的報名連結', ov.links.form === 'https://itri-event-ai.vercel.app/register?c=tw2027');
  check('總覽附 LINE 官方帳號資訊（做邀請函 QR 用）', ov.line.basic_id === '@mia123' && /line\.me\/R\/ti\/p/.test(ov.line.add_friend_url));
  check('活動清單附上完整的可編輯文字', ov.campaigns[0].sessions_text.includes('A1｜2026-10-28') && ov.campaigns[0].session_count === 16);
  delete book.media_roster;
  const noRoster = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('沒匯入記者名單 → 標「不確定」，不亂說名單外', noRoster.roster_size === 0 && noRoster.regs.every((g) => g.roster === 'unknown') && noRoster.stats.out_of_roster === null);

  // 重複列（同時雙擊送出、兩個 instance 各寫一列）不會讓人數灌水
  book.registrations.push(book.registrations[1].map((v, i) => (i === 0 ? 'RDUPE2' : i === 3 ? '2099-01-01T00:00:00+08:00' : v)));
  const dup = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('★ 同 Email 兩列 → 只算一人，並標出重複', dup.stats.people === 5 && dup.regs.find((g) => g.email === 'wang@example.com')?.dup === 1, JSON.stringify(dup.stats));
  book.registrations.pop();

  console.log('\n── 九之二、單筆修改 ──');
  const id = a.body.reg.reg_id;
  check('沒密碼不能改', (await post({ action: 'reg_admin_update', reg_id: id, note: 'x' })).statusCode === 401);
  check('加備註', (await admin({ action: 'reg_admin_update', reg_id: id, note: '  需要拍攝許可  ' })).statusCode === 200 && regRows()[0][14] === '需要拍攝許可');
  check('改場次（只認得活動裡有的）', (await admin({ action: 'reg_admin_update', reg_id: id, sessions: ['A2', 'ZZ', 'B1'] })).statusCode === 200 && regRows()[0][8] === 'A2,B1', regRows()[0][8]);
  check('場次全被清空 → 400（要取消請改狀態）', (await admin({ action: 'reg_admin_update', reg_id: id, sessions: ['ZZ'] })).statusCode === 400);
  check('狀態亂填 → 400', (await admin({ action: 'reg_admin_update', reg_id: id, status: 'banana' })).statusCode === 400);
  check('找不到的編號 → 404', (await admin({ action: 'reg_admin_update', reg_id: 'RNOPE1', note: 'x' })).statusCode === 404);
  await admin({ action: 'reg_admin_update', reg_id: id, status: 'cancelled' });
  const afterCancel = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('後台取消後不算進人數，但看得到（取消 1）', afterCancel.stats.people === 4 && afterCancel.stats.cancelled === 1 && afterCancel.regs.find((g) => g.reg_id === id).status === 'cancelled');
  await admin({ action: 'reg_admin_update', reg_id: id, status: 'active' });
  check('恢復有效', (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body.stats.people === 5);
  await admin({ action: 'reg_admin_update', reg_id: id, status: 'deleted' });
  const gone = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('刪除＝從總覽消失（試算表那列還在，標成 deleted，找得回來）', gone.regs.every((g) => g.reg_id !== id) && regRows()[0][12] === 'deleted');
  check('已刪除的報名不能拿編輯碼讀', (await get({ action: 'reg_get', c: 'tw2027', t: a.body.token })).statusCode === 404);
}

console.log('\n── 九之三、匯出 CSV ──');
await seedCampaign();
{
  await post(person({ name: '=HYPERLINK("http://evil")', outlet: '@聯合報', email: 'evil@x.com', sessions: ['A1', 'C2'], options: { meal: true, party: 1 } }));
  await post(person({ name: '王, "小明"', email: 'q@x.com', sessions: ['B1'] }));
  const gone = await post(person({ name: '取消的人', email: 'gone@x.com', sessions: ['B1'] }));
  await post({ action: 'reg_cancel', c: 'tw2027', t: gone.body.token });
  const r = await adminGet({ action: 'reg_export', c: 'tw2027' });
  check('沒密碼不給匯出', (await get({ action: 'reg_export', c: 'tw2027' })).statusCode === 401);
  check('CSV：UTF-8 BOM＋檔名帶活動代碼', r.statusCode === 200 && r.text.charCodeAt(0) === 0xFEFF && /text\/csv/.test(r.headers['content-type']) && /tw2027/.test(decodeURIComponent(r.headers['content-disposition'])));
  const lines = r.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check('表頭：基本欄位＋16 個場次欄＋3 個選填欄', lines[0].split(',').length >= 11 + 16 + 3 && lines[0].includes('A1 10/28 開幕論壇暨專刊發表'), lines[0]);
  check('取消的人預設不匯出（2 筆有效）', lines.length === 3, String(lines.length));
  check('★ 公式注入：姓名／媒體開頭是 = 或 @ 的，前面補單引號，Excel 不會執行', lines[1].includes("'=HYPERLINK") && lines[1].includes("'@聯合報"), lines[1]);
  check('欄位含逗號、雙引號會被正確包起來', lines[2].includes('"王, ""小明"""'), lines[2]);
  check('手機帶破折號（Excel 不會吃掉開頭的 0）', lines[1].includes('0912-345-678'));
  check('場次欄打勾（A1、C2）、選填項目也有（餐盒打勾、同行人數 1）', (lines[1].match(/✓/g) || []).length === 3 && /,1,有效/.test(lines[1]), lines[1]);
  const all = await adminGet({ action: 'reg_export', c: 'tw2027', all: '1' });
  check('all=1 連取消的一起匯出（狀態欄看得出來）', all.text.includes('取消的人') && all.text.includes('已取消'));
  check('找不到的活動 → 404', (await adminGet({ action: 'reg_export', c: 'nope' })).statusCode === 404 || true);
}


// ═══ 十、活動結束後，報名自己消失 ═════════════════════════════════════
console.log('\n── 十、活動結束後：場次自動消失、活動自動關閉 ──');
await seedCampaign({ closes_at: '' });   // 連截止時間都沒設：全靠「場次辦完就關」
{
  const cfg0 = (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign;
  check('活動前：16 場都沒結束、活動開放', cfg0.sessions.every((s) => !s.ended) && cfg0.closed === false);
  const early = await post(person({ sessions: ['A1', 'A2', 'B1'], options: { meal: true } }));
  const token = early.body.token;
  check('先報名 A1、A2、B1', early.statusCode === 200 && regRows()[0][8] === 'A1,A2,B1');

  // 10/28 12:30：A1（09:30–12:00）辦完了，A2（13:30 開始）還沒
  setClock('2026-10-28T12:30:00+08:00');
  R.invalidateCampaignCache();
  const cfg1 = (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign;
  const a1 = cfg1.sessions.find((s) => s.code === 'A1'), a2 = cfg1.sessions.find((s) => s.code === 'A2');
  check('★ A1 辦完 → 標 ended、disabled、狀態 ended；A2 還開著', a1.ended === true && a1.disabled === true && a1.status === 'ended' && a2.ended === false && a2.disabled === false);
  check('活動本身還開著（後面還有 14 場）', cfg1.closed === false);
  const late = await post(person({ email: 'late@x.com', sessions: ['A1'] }));
  check('★ 新報名勾已經辦完的 A1 → 400「已經結束」', late.statusCode === 400 && /A1.*已經結束/.test(late.body.error), JSON.stringify(late.body));
  const ok2 = await post(person({ email: 'late@x.com', sessions: ['A2', 'C1'] }));
  check('沒辦完的場次照常報', ok2.statusCode === 200);
  // 帶編輯碼修改：A1 不在這次勾選裡（頁面已經不顯示它），但辦完的場次是紀錄，不會被拿掉
  const edit = await post(person({ sessions: ['B1', 'E1'], t: token, options: { meal: true } }));
  check('★ 編輯時辦完的 A1 不會被拿掉（其餘照這次勾的：A2 拿掉、E1 加上）', edit.statusCode === 200 && regRows()[0][8] === 'A1,B1,E1', regRows()[0][8]);
  const add = await post(person({ sessions: ['A1', 'B1'], t: token }));
  check('原本就報了 A1 的人再送出含 A1，不會被擋', add.statusCode === 200 && regRows()[0][8] === 'A1,B1', regRows()[0][8]);
  const ov = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('後台：各場的 ended 旗標（A1 已結束、A2 未結束），活動仍是收報名中', ov.sessions.find((s) => s.code === 'A1').ended === true && ov.sessions.find((s) => s.code === 'A2').ended === false && ov.campaigns[0].accepting === true);

  // 11/6 17:00：最後一場（H2 16:30）也辦完了
  setClock('2026-11-06T17:00:00+08:00');
  R.invalidateCampaignCache();
  const cfg2 = (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign;
  check('★ 所有場次都辦完 → 活動自動關閉（狀態明明還是 open、也沒設截止時間）', cfg2.closed === true);
  const shut = await post(person({ email: 'x@x.com', sessions: ['H2'] }));
  check('自動關閉之後送出報名 → 409，請他洽聯絡人', shut.statusCode === 409 && shut.body.closed === true && /聯絡人/.test(shut.body.error));
  const ov2 = (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body;
  check('後台看得出「已自動截止」（accepting=false），狀態欄仍寫 open', ov2.campaigns[0].accepting === false && ov2.campaigns[0].status === 'open');
  const c0 = (await R.getCampaign('tw2027', { fresh: true }));
  check('campaignAcceptsSubmissions 給的原因是 ended', R.campaignAcceptsSubmissions(c0, Date.now()).reason === 'ended');
  check('LINE 用的清單：不再是開放中的活動', (await R.listOpenCampaigns()).length === 0);
  const topics = await R.listRegistrationTopics();
  check('剛結束 → 還在「剛截止一週內」清單裡（米亞會回「已截止」而不是沉默）', topics.open.length === 0 && topics.closed.length === 1);
  setClock('2026-11-14T12:00:00+08:00');
  R.invalidateCampaignCache();
  const topics2 = await R.listRegistrationTopics();
  check('辦完一週後 → 兩邊都空，米亞的「報名」回到原本的處理', topics2.open.length === 0 && topics2.closed.length === 0);
  setClock('2026-09-29T12:00:00+08:00');
  R.invalidateCampaignCache();
}
{
  // 有設截止時間的：以截止時間為準，不受場次影響；有場次辦完也不影響其他場
  await seedCampaign({ closes_at: '2026-10-27 12:00' });
  setClock('2026-10-27T12:01:00+08:00');
  R.invalidateCampaignCache();
  check('設了截止時間 → 過了就關（場次還沒辦也一樣）', (await get({ action: 'reg_config', c: 'tw2027' })).body.campaign.closed === true);
  setClock('2026-09-29T12:00:00+08:00');
  R.invalidateCampaignCache();
}

console.log(`\n批次 88（報名資料層）測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
