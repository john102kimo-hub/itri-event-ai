// 在真的瀏覽器裡把活動報名後台（/registrations）跑一遍（批次 112）。
//
//   node tools/reg-ui-check/check.mjs          （要截圖：OUT=某個資料夾 node …）
//
// 後端是**真的 api/events.js → lib/registration-api.js**，只有 Google Sheets 換成 test/fakes-sheets82.mjs
// 的假試算表——驗到的是「真的後端回的資料，在真的瀏覽器裡長什麼樣子、按下去會怎樣」。不呼叫任何 AI、不碰網路。
// 跟 tools/geo-ui-check 一樣不進 npm test（需要 playwright 與 Chromium，不要加進 package.json）。
//
// 驗的是批次 112 改版後最容易壞、壞了不會報錯的事：清單首頁、單場分頁、設定表單的場次列編輯與錯誤對回哪一列、
// 複製成新活動、手機版名單卡片。靜態的結構檢查在 test/test-batch112.mjs。
import { register } from 'node:module';
register('../../test/loader-82.mjs', import.meta.url);
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';

process.env.ADMIN_PASSWORD = 'pw'; process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret'; process.env.LINE_BASIC_ID = '@mia123';
const ROOT = path.join(import.meta.dirname, '..', '..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire('/opt/node-tools/')('playwright')); }

const { book, reset } = await import(path.join(ROOT, 'test', 'fakes-sheets82.mjs'));
const events = (await import(path.join(ROOT, 'api', 'events.js'))).default;
const R = await import(path.join(ROOT, 'lib', 'registration.js'));

function fakeRes(res) {
  let code = 200;
  const out = { setHeader: (k, v) => res.setHeader(k, v), status(c) { code = c; return out; },
    json(o) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return out; },
    end(x) { res.statusCode = code; res.end(x); return out; }, send(x) { res.statusCode = code; res.end(x); return out; } };
  return out;
}
async function call(body, headers = {}) {
  let code = 200, json;
  const out = { setHeader() {}, status(c) { code = c; return out; }, json(o) { json = o; return out; }, end() { return out; }, send() { return out; } };
  await events({ method: 'POST', headers: { 'x-admin-password': 'pw', ...headers }, query: {}, body }, out);
  return { code, json };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/events') {
    let b = ''; for await (const c of req) b += c;
    const r = { query: Object.fromEntries(u.searchParams), method: req.method, headers: req.headers, body: b ? JSON.parse(b) : {} };
    try { await events(r, fakeRes(res)); } catch (e) { console.error(e); res.statusCode = 500; res.end('{}'); }
    return;
  }
  const name = { '/registrations': 'registrations.html', '/register': 'register.html' }[u.pathname] || u.pathname;
  const f = path.join(ROOT, 'public', name);
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// ── 假資料：三個活動（兩個進行中、一個已截止）＋幾筆報名 ───────────────────
reset(); R.resetRegistrationState();
const S1 = ['A1｜2099-10-28｜09:30-12:00｜開幕論壇｜201 廳｜09:00 報到', 'A2｜2099-10-28｜13:30-16:00｜通訊', 'B1｜2099-10-29｜09:30-12:00｜全球AI競局'].join('\n');
const S2 = ['W1｜2099-12-05｜14:00-16:00｜新手工作坊｜3 樓教室'].join('\n');
const must = async (b) => { const r = await call(b); if (r.code !== 200) throw new Error(JSON.stringify(r)); return r; };
await must({ action: 'reg_admin_save_campaign', id: 'tw2099', title: '眺望2099產業發展趨勢研討會', status: 'open', sessions_text: S1, options_text: 'meal｜需要餐盒｜A1\nparty｜同行人數｜｜number', closes_at: '2099-12-31', short_name: '眺望2099場次', venue: '臺大醫院國際會議中心', contact: '王小明 a@b.com' });
await must({ action: 'reg_admin_save_campaign', id: 'workshop', title: '新手工作坊', status: 'draft', sessions_text: S2, closes_at: '' });
await must({ action: 'reg_admin_save_campaign', id: 'old2020', title: '去年的說明會', status: 'closed', sessions_text: 'A1｜2020-05-01｜10:00-12:00｜說明會' });
for (const [i, [n, o, e, s]] of [['王小明', '經濟日報', 'a@x.com', ['A1', 'B1']], ['李小美', '聯合報', 'b@x.com', ['A1']], ['張大同', '自由時報', 'c@x.com', ['A2', 'B1']]].entries()) {
  const r = await call({ action: 'reg_submit', c: 'tw2099', name: n, outlet: o, email: e, phone: `0912-345-67${i}`, sessions: s, options: { meal: true } }, { 'x-forwarded-for': `10.0.0.${i + 1}` });
  if (r.code !== 200) throw new Error(JSON.stringify(r));
}
await call({ action: 'reg_submit', c: 'workshop', name: '測試者', outlet: '測試單位', email: 't@x.com', phone: '0911222333', sessions: ['W1'] }, { 'x-forwarded-for': '10.0.1.1' });

function findChromium() {
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  const b = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(b)) return undefined;
  for (const d of fs.readdirSync(b).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(b, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (c, m) => { if (!c) fails++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const browser = await chromium.launch({ executablePath: findChromium() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => d.dismiss());
await page.addInitScript(() => sessionStorage.setItem('itri_pwd', 'pw'));
const shot = async (n) => { if (OUT) await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); };

console.log('── 一、清單首頁 ──');
await page.goto(base + '/registrations'); await page.waitForSelector('.ccard');
{
  const n = await page.locator('#lists > .ccards .ccard').count(); // 已截止的在摺疊區裡，不算
  check(n === 2, `進行中的兩場各一張卡片（草稿也算進行中）${n === 2 ? '' : `——實際 ${n} 張：${(await page.locator('.ccard h3').allTextContents()).join('、')}`}`);
}
check((await page.textContent('#lists details summary')).includes('已截止／已結束的活動（1）'), '已截止的收進摺疊區，不佔版面');
const card = page.locator('.ccard', { hasText: '眺望2099' });
check((await card.textContent()).includes('3') && (await card.textContent()).includes('報名人數') && (await card.textContent()).includes('3 場'), '卡片寫出報名人數與場數');
check((await page.textContent('#entry-url')).endsWith('/register'), '有「總入口」連結');
check(!/媒體報名/.test(await page.textContent('body')), '畫面上沒有「媒體報名」');
const workshop = page.locator('.ccard', { hasText: '新手工作坊' });
check((await workshop.textContent()).includes('草稿'), '草稿標得出來');
await shot('1-list');

console.log('── 二、單場：總覽／名單／分享 ──');
await card.locator('a:text("管理")').click(); await page.waitForSelector('#kpis .kpi');
check(page.url().endsWith('#/c/tw2099'), '網址帶活動代碼（重新整理回得來）');
check((await page.textContent('#kpis')).includes('報名人數'), '總覽有 KPI');
check(await page.locator('#bars .bar-row').count() === 3, '各場人數三列');
await shot('2-over');
await page.click('#bars .bar-row >> nth=0'); await page.waitForSelector('#tb tr');
check(page.url().endsWith('/list') && await page.locator('#tb tr').count() === 2, '點一場 → 名單只看那一場（A1 有 2 人）');
check((await page.inputValue('#f-sess')) === 'A1', '場次篩選預先選好');
await page.fill('#q', '李小美');
check(await page.locator('#tb tr').count() === 1, '搜尋姓名');
check(await page.locator('#thead th').count() === 6, '名單欄位：姓名／聯絡／場次／選填／標記／操作');
await page.fill('#q', ''); await page.selectOption('#f-sess', '');
await shot('3-list');
await page.click('.tabs a:text("分享連結")'); await page.waitForSelector('#form-url');
check((await page.textContent('#form-url')).includes('?c=tw2099'), '分享頁有這一場的連結');
check(await page.locator('#qr-form').count() === 1, '有報名 QR');
await shot('4-share');

console.log('── 三、設定：場次一場一列、錯誤對回那一列 ──');
await page.click('.tabs a:text("設定")'); await page.waitForSelector('.srow');
check(await page.locator('.srow').count() === 3 && (await page.inputValue('.srow >> nth=0 >> [data-k=title]')) === '開幕論壇', '場次拆成三列，內容帶得出來');
check((await page.inputValue('.srow >> nth=0 >> [data-k=room]')) === '201 廳' && (await page.inputValue('.srow >> nth=0 >> [data-k=note]')) === '09:00 報到', '場地、備註也在');
check(await page.locator('.orow').count() === 2, '選填項目兩列');
check(await page.isDisabled('#e-id'), '編輯時活動代碼鎖住（建立後不能改）');
await shot('5-settings');
await page.fill('.srow >> nth=1 >> [data-k=date]', '下週三');
await page.click('#e-save'); await page.waitForSelector('#f-errs:not([hidden])');
check((await page.textContent('#f-errs')).includes('場次清單有地方要修正') && (await page.textContent('#f-errs')).includes('第 2 行'), '日期寫錯 → 退回並指出第 2 行');
check(await page.locator('.srow.bad').count() === 1 && (await page.locator('.srow').nth(1).getAttribute('class')).includes('bad'), '第 2 列標紅');
await shot('6-error');
await page.fill('.srow >> nth=1 >> [data-k=date]', '2099-10-28');
await page.click('button:text("＋ 加一場")');
check(await page.locator('.srow').count() === 4 && (await page.inputValue('.srow >> nth=3 >> [data-k=code]')) === 'B2' && (await page.inputValue('.srow >> nth=3 >> [data-k=date]')) === '2099-10-29', '「加一場」自動接下一個代碼、帶上一場的日期');
await page.fill('.srow >> nth=3 >> [data-k=time]', '13:30-16:00'); await page.fill('.srow >> nth=3 >> [data-k=title]', '產業轉型');
await page.fill('#e-title', '眺望2099（改名）');
await page.click('#e-save'); await page.waitForSelector('#toast.show');
check(book.reg_campaigns[1][1] === '眺望2099（改名）' && book.reg_campaigns[1][4].split('\n').length === 4 && book.reg_campaigns[1][4].includes('B2｜2099-10-29｜13:30-16:00｜產業轉型'), '存檔成功，試算表裡是標準格式的四行');
check(book.reg_campaigns[1][4].split('\n')[0] === 'A1｜2099-10-28｜09:30-12:00｜開幕論壇｜201 廳｜09:00 報到', '原本那一行一個字都沒變');
check(book.reg_campaigns[1][5] === 'meal｜需要餐盒｜A1\nparty｜同行人數｜｜number', '選填項目寫回去也沒變');
// 整批貼上模式
await page.click('#sess-mode-btn');
check(await page.isVisible('#e-sessions') && (await page.inputValue('#e-sessions')).split('\n').length === 4, '切到整批貼上：同樣四行');
await page.click('#sess-mode-btn');
check(await page.locator('.srow').count() === 4, '切回逐場編輯：四列');

console.log('── 四、新增與複製 ──');
await page.click('a:text("← 所有活動")'); await page.waitForSelector('.ccard');
await page.click('a.btn:text("＋ 新增活動")'); await page.waitForSelector('#e-id:not([disabled])');
check((await page.inputValue('#e-title')) === '' && (await page.inputValue('#e-id')) === '', '新增是空白的，不再預填眺望');
check(!/眺望/.test(await page.evaluate(() => document.querySelector('#form-card').innerText + [...document.querySelectorAll('#form-card input,#form-card textarea')].map((i) => i.value + i.placeholder).join(''))), '表單上沒有任何眺望的字');
check(await page.locator('.srow').count() === 1 && (await page.inputValue('.srow >> [data-k=code]')) === 'A1', '一開始一列空白場次（代碼 A1）');
await page.click('#e-save'); await page.waitForSelector('#f-errs:not([hidden])');
check((await page.textContent('#f-errs')).length > 0, '什麼都沒填就存 → 有訊息，不會壞掉');
await page.click('a:text("取消")'); await page.waitForSelector('.ccard');
await page.locator('.ccard', { hasText: '眺望2099' }).locator('a:text("複製成新活動")').click(); await page.waitForSelector('#f-copied:not([hidden])');
check((await page.inputValue('#e-id')) === '' && (await page.inputValue('#e-status')) === 'draft' && await page.locator('.srow').count() === 4, '複製：代碼清空、狀態草稿、場次帶過來');
await page.fill('#e-id', 'Tw2100'); check((await page.inputValue('#e-id')) === 'tw2100', '代碼自動轉小寫');
await page.fill('#e-title', '眺望2100'); await page.fill('#e-closes', '2100-01-01');
await page.click('#e-save'); await page.waitForSelector('#p-share:not([hidden])');
check(page.url().endsWith('#/c/tw2100/share') && book.reg_campaigns.length === 5, '建立後直接到「分享連結」（可以拿連結了）');
check(book.reg_campaigns[4][2] === 'draft', '新活動是草稿');

console.log('── 五、手機版 ──');
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(base + '/registrations#/c/tw2099/list'); await page.waitForSelector('#tb tr');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '名單頁沒有橫向捲動');
check(await page.isHidden('#thead'), '手機：表頭隱藏、一筆一張卡片');
await shot('7-mobile-list');
await page.goto(base + '/registrations#/c/tw2099/settings'.replace('settings', 'set')); await page.waitForSelector('.srow');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '設定頁沒有橫向捲動');
await shot('8-mobile-settings');
await page.goto(base + '/registrations'); await page.waitForSelector('.ccard');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '清單頁沒有橫向捲動');
await shot('9-mobile-list-home');

console.log('── 六、記者端：同時開放兩場 → 總入口列出每一場 ──');
await must({ action: 'reg_admin_save_campaign', id: 'workshop', title: '新手工作坊', status: 'open', sessions_text: S2, venue: '工研院 3 樓' });
await ctx.clearCookies(); await page.setViewportSize({ width: 390, height: 800 });
await page.goto(base + '/register'); await page.waitForSelector('.choices a');
check(await page.locator('.choices a').count() === 2, '總入口：兩場各一個選項');
check((await page.textContent('.choices')).includes('📍 工研院 3 樓') && /10\/28/.test(await page.textContent('.choices')), '每個選項帶日期與地點');
check(!/媒體報名/.test(await page.textContent('body')), '記者端也沒有「媒體報名」');
await shot('10-choices');
await page.click('.choices a >> nth=0'); await page.waitForSelector('form#f');
check(/服務單位／媒體/.test(await page.textContent('form#f')) && !/要採訪/.test(await page.textContent('#app')), '報名表單用通用的字');
await shot('11-form');

check(errs.length === 0, `瀏覽器沒有 JS 錯誤${errs.length ? '：' + errs.join(' | ') : ''}`);
await browser.close(); server.close();
console.log(fails ? `\n❌ ${fails} 項失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
