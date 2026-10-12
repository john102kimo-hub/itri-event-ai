// 批次 127：報名狀況唯讀頁——把一場活動的報名狀況分享給同仁，但不給後台。
//   一、後台產生／重新產生／停用連結；連結碼存在 reg_campaigns 第 16 欄（P），儲存活動設定不會把它洗掉
//   二、公開的 reg_view：連結碼對才給；錯的、停用的、沒這場活動長得一模一樣；亂猜會被限流
//   三、★ 資料界線：回應裡不能有 Email／手機／備註／編輯碼／LINE 識別／報名編號（寫成白名單，不靠頁面不顯示）
//   四、人數口徑跟後台一致（取消、測試、重複送出不算），各場次人數、今日新增
//   五、頁面與設定：/reg-status 的轉址、noindex、robots、後台「分享連結」分頁的按鈕
// 跑的是真的 api/events.js 與 lib/registration*.js；Google Sheets 是假的（fakes-sheets82）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.SITE_URL = 'https://example.test';

// 假時鐘：2026-10-08 中午（台灣）。場次在 11 月，SHIFT_DAYS 不影響
let clock = Date.UTC(2026, 9, 8, 4, 0, 0);
Date.now = () => clock;

const { book, reset } = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const API = await import('../lib/registration-api.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = () => r; r.end = () => r;
  return r;
}
let ipSeq = 0;
async function post(body, ip) {
  const res = fakeRes();
  await events({ method: 'POST', headers: { 'x-forwarded-for': ip || `10.2.0.${++ipSeq % 250}` }, query: {}, body }, res);
  return res;
}
async function get(query, { headers = {}, ip } = {}) {
  const res = fakeRes();
  await events({ method: 'GET', headers: { 'x-forwarded-for': ip || `10.3.0.${++ipSeq % 250}`, ...headers }, query }, res);
  return res;
}
const admin = (b) => post({ password: 'pw', ...b });
const adminGet = (q) => get(q, { headers: { 'x-admin-password': 'pw' } });
const view = (c, k, opt) => get({ action: 'reg_view', c, k }, opt);

const SESSIONS = 'A1｜2026-11-20｜09:30-12:00｜開幕論壇｜201 廳\nA2｜2026-11-20｜13:30-16:00｜技術媒合｜202 廳\nB1｜2026-11-21｜09:30-12:00｜閉幕論壇｜201 廳';
const OPTIONS = 'meal｜需要餐盒\nparty｜同行人數｜｜number\ntopic｜想了解的主題｜｜text';
const camp = { action: 'reg_admin_save_campaign', id: 'tw2027', title: '眺望2027', status: 'open', sessions_text: SESSIONS, options_text: OPTIONS,
  intro: '歡迎', contact: '朱朱', closes_at: '2026-11-19', venue: '台大國際會議中心' };
const submit = (b) => post({ action: 'reg_submit', c: 'tw2027', name: '王小明', outlet: '經濟日報', email: 'wang@example.com',
  phone: '0912345678', sessions: ['A1'], elapsed: 5000, ...b });

reset(); API.resetRateLimit(); R.resetRegistrationState(); R.resetStatusViewCache();
await admin(camp);
const reg1 = await submit({ options: { meal: '1', party: '2', topic: '先進封裝' } });
await submit({ name: '李小華', outlet: '工商時報', email: 'lee@example.com', phone: '0922333444', sessions: ['A1', 'B1'] });
const reg3 = await submit({ name: '陳大明', outlet: '經濟日報', email: 'chen@example.com', phone: '0933444555', sessions: ['A2'], options: { meal: '1' } });
// 人工在後台加備註，確認備註不會從唯讀出口出去
await admin({ action: 'reg_admin_update', reg_id: reg1.body.reg.reg_id, note: '內部備註：VIP 不要亂寫' });

console.log('\n── 一、後台產生／重新產生／停用 ──');
{
  const noPw = await post({ action: 'reg_admin_share', c: 'tw2027', mode: 'create' });
  check('沒有後台密碼不能產生連結（401）', noPw.statusCode === 401);
  check('　 沒有產生過連結時，後台總覽沒有狀況頁網址', !(await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body.links.status);
  const bad = await admin({ action: 'reg_admin_share', c: 'nope', mode: 'create' });
  check('活動不存在 → 404', bad.statusCode === 404);
  const badMode = await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'zzz' });
  check('不認得的操作 → 400', badMode.statusCode === 400);

  const r1 = await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'create' });
  const t1 = r1.body.token;
  check('產生連結：回連結碼與完整網址', r1.statusCode === 200 && t1.length >= 20 && r1.body.url === `https://example.test/reg-status?c=tw2027&k=${t1}`, JSON.stringify(r1.body));
  check('　 連結碼存在 reg_campaigns 第 16 欄（P），表頭也有 share_token', book.reg_campaigns[1][15] === t1 && book.reg_campaigns[0][15] === 'share_token', JSON.stringify(book.reg_campaigns));
  check('　 後台總覽帶出狀況頁網址', (await adminGet({ action: 'reg_admin_list', c: 'tw2027' })).body.links.status === r1.body.url);
  const again = await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'create' });
  check('已經有連結時再按「產生」→ 沿用，不會把同仁手上的連結弄壞', again.body.token === t1);

  const save = await admin({ ...camp, title: '眺望2027（改名）' });
  check('★ 儲存活動設定不會把連結碼洗掉（改設定後同仁的連結照常能開）', save.statusCode === 200 && book.reg_campaigns[1][15] === t1 && (await view('tw2027', t1)).statusCode === 200, JSON.stringify(book.reg_campaigns[1]));

  const rot = await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'rotate' });
  check('重新產生 → 換成新的連結碼', rot.body.token && rot.body.token !== t1 && book.reg_campaigns[1][15] === rot.body.token);
  R.resetStatusViewCache(); R.invalidateCampaignCache();
  check('★ 舊連結立刻失效（404），新連結可用', (await view('tw2027', t1)).statusCode === 404 && (await view('tw2027', rot.body.token)).statusCode === 200);

  const off = await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'off' });
  R.invalidateCampaignCache();
  check('停用 → 儲存格清空，連結 404', off.body.token === '' && book.reg_campaigns[1][15] === '' && (await view('tw2027', rot.body.token)).statusCode === 404);
  check('★ 停用後拿「空的連結碼」也打不開（空字串不會被當成對的）', (await view('tw2027', '')).statusCode === 404);
  await admin({ action: 'reg_admin_share', c: 'tw2027', mode: 'rotate' });
  R.invalidateCampaignCache();
}

const TOKEN = book.reg_campaigns[1][15];

console.log('\n── 二、公開讀取：連結碼對才給 ──');
{
  const ok = await view('tw2027', TOKEN);
  check('連結碼對 → 200，不被 CDN／瀏覽器記住（no-store）', ok.statusCode === 200 && ok.headers['cache-control'] === 'no-store');
  const wrong = await view('tw2027', TOKEN.slice(0, -1) + (TOKEN.endsWith('a') ? 'b' : 'a'));
  const nocamp = await view('nope', TOKEN);
  const empty = await view('tw2027', '');
  check('連結碼錯、沒這場活動、沒帶連結碼 → 全部同一種 404（猜的人分不出是哪一種）',
    [wrong, nocamp, empty].every((x) => x.statusCode === 404) && wrong.body.error === nocamp.body.error && nocamp.body.error === empty.body.error);
  check('　 用後台密碼當連結碼也不通（兩套憑證不互通）', (await view('tw2027', 'pw')).statusCode === 404);
  const other = await admin({ ...camp, id: 'other27', title: '別場活動' });
  check('　 A 場的連結碼打不開 B 場', (await view('other27', TOKEN)).statusCode === 404);

  // 限流：同一個來源猜太多次就擋（跟猜後台密碼共用 lib/auth.js 的失敗計數）
  const ip = '10.9.9.9';
  let blocked = 0;
  for (let i = 0; i < 40; i++) if ((await view('tw2027', 'guess' + i, { ip })).statusCode === 429) blocked++;
  check('亂猜連結碼：同一個來源失敗 30 次後被擋（429）', blocked >= 5, `被擋 ${blocked} 次`);
  check('　 被擋的來源連正確的連結碼也先擋（跟猜密碼同一套）', (await view('tw2027', TOKEN, { ip })).statusCode === 429);
  check('　 別的來源不受影響', (await view('tw2027', TOKEN, { ip: '10.9.9.10' })).statusCode === 200);
}

console.log('\n── 三、★ 資料界線：沒有聯絡方式 ──');
{
  R.resetStatusViewCache();
  const v = (await view('tw2027', TOKEN)).body;
  const raw = JSON.stringify(v);
  const leaks = ['wang@example.com', 'lee@example.com', 'chen@example.com', '0912345678', '0912-345-678', '0922333444', '0933444555', '內部備註',
    reg1.body.reg.reg_id, reg3.body.reg.reg_id, '"email"', '"phone"', '"note"', 'edit_token', 'line_user_id', '先進封裝' /* 文字題答案 */]
    .filter((x) => raw.includes(x));
  check('★ 回應裡沒有 Email／手機／備註／報名編號／編輯碼／LINE 識別／文字題答案', leaks.length === 0, `洩漏：${leaks.join('、')}`);
  check('　 每位報名者只有姓名、單位、場次、報名時間四個欄位（白名單）', v.people.length === 3 && v.people.every((p) => Object.keys(p).sort().join() === 'at,name,outlet,sessions'), JSON.stringify(v.people[0]));
  check('　 頂層欄位也是白名單（之後誰加欄位會被這條攔下來提醒）', Object.keys(v).sort().join() === 'business,campaign,links,now,options,people,sessions,stats', Object.keys(v).join());
  const src = read('lib/registration.js');
  const body = src.slice(src.indexOf('export async function statusView'), src.indexOf('/** 後台儲存報名活動'));
  check('　 原始碼：statusView 沒有把整個報名物件展開（沒有 ...g）', !/\.\.\.g\b/.test(body) && !/people: regs\b[^.]/.test(body));
}

console.log('\n── 四、人數口徑 ──');
{
  R.resetStatusViewCache();
  const v = (await view('tw2027', TOKEN)).body;
  check('標題、地點、日期範圍', v.campaign.title === '眺望2027（改名）' || v.campaign.title === '眺望2027', v.campaign.title);
  check('　 地點與日期範圍', v.campaign.venue === '台大國際會議中心' && /11\/20/.test(v.campaign.date_range));
  check('報名人數 3、單位數 2（經濟日報兩位算一個）', v.stats.people === 3 && v.stats.outlets === 2, JSON.stringify(v.stats));
  const by = Object.fromEntries(v.sessions.map((s) => [s.code, s.count]));
  check('各場次人數：A1=2、A2=1、B1=1', by.A1 === 2 && by.A2 === 1 && by.B1 === 1, JSON.stringify(by));
  check('今天新增 3（假時鐘就是報名當天）', v.stats.today === 3 && v.stats.week === 3, JSON.stringify(v.stats));
  const meal = v.options.find((o) => o.key === 'meal'), party = v.options.find((o) => o.key === 'party');
  check('選填項目加總：餐盒 2 人、同行人數 2；文字題不在清單', meal.total === 2 && party.total === 2 && !v.options.some((o) => o.key === 'topic'), JSON.stringify(v.options));

  // 取消一位 → 人數與名單都不算
  const bound = book.registrations.find((r) => r[0] === reg3.body.reg.reg_id);
  await admin({ action: 'reg_admin_update', reg_id: reg3.body.reg.reg_id, status: 'cancelled' });
  R.resetStatusViewCache();
  const v2 = (await view('tw2027', TOKEN)).body;
  check('★ 取消的報名不算人數、不在名單、場次人數跟著降', bound && v2.stats.people === 2 && v2.sessions.find((s) => s.code === 'A2').count === 0 && !v2.people.some((p) => p.name === '陳大明'), JSON.stringify(v2.stats));

  // 15 秒內的重複讀取不會再打 Sheets（同仁一起重新整理不會把全站共用的讀取配額用完）
  const reads0 = book.__reads || null;
  R.resetStatusViewCache();
  await view('tw2027', TOKEN);
  const probe = book.registrations; // 改假試算表，不清快取 → 還是舊資料；清了才看得到
  const before = (await view('tw2027', TOKEN)).body.stats.people;
  await admin({ action: 'reg_admin_update', reg_id: reg1.body.reg.reg_id, status: 'cancelled' });
  const cached = (await view('tw2027', TOKEN)).body.stats.people;
  check('短時間內的重複讀取走快取（15 秒內不重讀試算表）', before === 2 && cached === 2 && probe, `${before} → ${cached}`);
  clock += 20_000;
  check('　 過了 15 秒就看到最新的', (await view('tw2027', TOKEN)).body.stats.people === 1);

  // 測試報名（草稿活動）不算
  await admin({ ...camp, id: 'draft27', title: '草稿活動', status: 'draft' });
  const sh = await admin({ action: 'reg_admin_share', c: 'draft27', mode: 'create' });
  await post({ action: 'reg_submit', c: 'draft27', name: '測試員', outlet: '測試社', email: 't@example.com', phone: '0911111111', sessions: ['A1'], elapsed: 5000 });
  const dv = (await view('draft27', sh.body.token)).body;
  check('★ 草稿活動送出的測試報名不算人數、不在名單', dv.stats.people === 0 && dv.people.length === 0 && dv.campaign.status === 'draft', JSON.stringify(dv.stats));
}

console.log('\n── 四之二、前台報名連結（批次 128）──');
{
  R.resetStatusViewCache(); R.invalidateCampaignCache();
  const open = (await view('tw2027', TOKEN)).body;
  check('收報名中的活動：附前台報名連結（公開的那條，不含連結碼與後台資訊）', open.links.register === 'https://example.test/register?c=tw2027' && !open.links.register.includes(TOKEN), open.links.register);
  const dTok = book.reg_campaigns.find((r) => r[0] === 'draft27')[15];
  check('草稿活動不附（轉出去的人點進去只會看到測試頁）', (await view('draft27', dTok)).body.links.register === '');
  await admin({ ...camp, id: 'old27', title: '已截止', status: 'closed' });
  const oTok = (await admin({ action: 'reg_admin_share', c: 'old27', mode: 'create' })).body.token;
  check('已截止的活動不附', (await view('old27', oTok)).body.links.register === '');
}

console.log('\n── 五、頁面與設定 ──');
{
  const page = read('public/reg-status.html'), vercel = JSON.parse(read('vercel.json')), adminPage = read('public/registrations.html');
  check('/reg-status 有轉址到 reg-status.html', vercel.rewrites.some((r) => r.source === '/reg-status' && r.destination === '/reg-status.html'));
  check('　 不給搜尋引擎（meta noindex、X-Robots-Tag）、不帶 referrer（連結碼在網址上，用頁面的 meta）', /name="robots" content="noindex,nofollow"/.test(page) && JSON.stringify(vercel.headers).includes('X-Robots-Tag') && /name="referrer" content="no-referrer"/.test(page));
  check('　 robots.txt 也寫 Disallow: /reg-status', /Disallow: \/reg-status/.test(read('api/event-page.js')));
  check('頁面打的是公開的 reg_view，不碰任何 reg_admin_*、也沒有密碼輸入', page.includes('reg_view') && !/reg_admin_|X-Admin-Password|type="password"/.test(page));
  // 只看會變成 HTML 的那幾行（document.title、搜尋比對用的字串不是 HTML）
  const interp = page.split('\n').filter((l) => !/document\.title|toLowerCase/.test(l)).flatMap((l) => [...l.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]))
    .filter((x) => /\b(p|s|x|c|D)\.(name|outlet|title|room|time|label|dateLabel|venue|date_range|code)\b/.test(x) && !/esc\(/.test(x) && !/\?/.test(x));
  check('頁面上插進 HTML 的姓名／單位／場次文字都過 esc()（報名者自己填的字不能執行）', interp.length === 0, interp.join(' | '));
  check('頁面有「報名連結」卡片：複製、系統分享、開啟報名頁，沒有連結時整張隱藏', ['id="share"', 'copyUrl()', 'shareUrl()', 'id="reg-open"'].every((x) => page.includes(x)) && /\$\('share'\)\.hidden = !reg/.test(page));
  check('後台「分享連結」分頁有產生／重新產生／停用', ['reg_admin_share', "shareLink('create')", "shareLink('rotate')", "shareLink('off')"].every((x) => adminPage.includes(x)));
  check('文件：批次 127 已記錄', /## 批次 127：/.test(read('docs/batches/10-batch-117.md')) && /\| 127 \|/.test(read('docs/batches/README.md')));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 127 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
