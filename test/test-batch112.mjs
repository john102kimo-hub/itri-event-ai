// 批次 112：活動報名（原「媒體報名」）——同時多個活動、改名、後台改版。
//   一、資料層：後台預設打開對的活動、清單用的每場人數與日期、總入口、記者端多場選單
//   二、改名：畫面與 LINE 上的字不再寫「媒體報名」「媒體聯絡人」；網址、分頁名稱、LINE 辨識詞不動
//   三、後台頁面的結構（靜態檢查；在真瀏覽器裡的互動見 tools/reg-ui-check/check.mjs）
// 跑的是真的程式，只有 Google Sheets 是假的（test/fakes-sheets82.mjs）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_BASIC_ID = '@mia123';

// 假時鐘（每次存檔往後走一分鐘，updated_at 才排得出先後）：固定在 2026-10-02 中午台灣時間
let clock = Date.UTC(2026, 9, 2, 4, 0, 0);
Date.now = () => clock;

const { book, reset } = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const API = await import('../lib/registration-api.js');
const events = (await import('../api/events.js')).default;

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}

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
async function post(body, headers = {}) {
  const res = fakeRes();
  await events({ method: 'POST', headers: { 'x-forwarded-for': `10.1.0.${++ipSeq % 250}`, 'x-admin-password': 'pw', ...headers }, query: {}, body }, res);
  return res;
}
async function get(query, admin = true) {
  const res = fakeRes();
  await events({ method: 'GET', headers: admin ? { 'x-admin-password': 'pw' } : {}, query }, res);
  return res;
}
const save = async (o) => { clock += 60_000; const r = await post({ action: 'reg_admin_save_campaign', ...o }); if (r.statusCode !== 200) throw new Error(JSON.stringify(r.body)); return r; };
const person = (c, n, email, sessions, over = {}) => post({ action: 'reg_submit', c, name: n, outlet: over.outlet || '某某單位', email, phone: '0912-345-678', sessions, ...over }, { 'x-admin-password': '' });

const S_OLD = 'A1｜2026-05-01｜10:00-12:00｜去年的說明會';
const S_LIVE = ['A1｜2099-10-28｜09:30-12:00｜開幕論壇｜201 廳', 'A2｜2099-10-28｜13:30-16:00｜通訊', 'B1｜2099-10-29｜09:30-12:00｜全球AI競局'].join('\n');
const S_WS = 'W1｜2099-12-05｜14:00-16:00｜新手工作坊';

// ═══ 一、資料層 ═══════════════════════════════════════════════════════
console.log('\n── 一、同時有多個活動：後台與記者端 ──');
reset(); R.resetRegistrationState(); API.resetRateLimit();
await save({ id: 'old2026', title: '去年的說明會', status: 'closed', sessions_text: S_OLD });   // 試算表第一列＝最舊的
await save({ id: 'live2099', title: '眺望2099', status: 'open', sessions_text: S_LIVE, closes_at: '2099-12-31', short_name: '眺望場次', venue: '○○會議中心' });
await save({ id: 'ws', title: '新手工作坊', status: 'draft', sessions_text: S_WS });
{
  const ov = (await get({ action: 'reg_admin_list' })).body;
  check('★ 後台沒指定活動時，打開的是進行中的那一場，不是試算表第一列（最舊的）', ov.current === 'live2099', ov.current);
  const ov2 = (await get({ action: 'reg_admin_list', c: 'nope' })).body;
  check('指定的活動不存在 → 同樣退回預設，不炸', ov2.current === 'live2099');
  check('預設挑選：收件中 > 草稿 > 已截止（同類取最近更新）',
    R.pickDefaultCampaign([{ id: 'c', status: 'closed', updated_at: '9' }, { id: 'd', status: 'draft', updated_at: '1' }, { id: 'o', status: 'open', closes_at: '2099-01-01', sessions: [], updated_at: '0' }])?.id === 'o'
    && R.pickDefaultCampaign([{ id: 'c', status: 'closed', updated_at: '9' }, { id: 'd', status: 'draft', updated_at: '1' }])?.id === 'd'
    && R.pickDefaultCampaign([{ id: 'x', status: 'open', closes_at: '2020-01-01', sessions: [], updated_at: '9' }, { id: 'd', status: 'draft', updated_at: '1' }])?.id === 'd'
    && R.pickDefaultCampaign([]) === null);
}
await person('live2099', '王小明', 'a@x.com', ['A1', 'B1'], { outlet: '經濟日報' });
await person('live2099', '李小美', 'b@x.com', ['A1'], { outlet: '聯合報' });
await person('live2099', '張大同', 'c@x.com', ['A2'], { outlet: '經濟日報' });
await person('live2099', '王小明', 'a@x.com', ['A2']);                 // 同一個 Email 再送＝更新，不是第四個人
await person('ws', '測試者', 't@x.com', ['W1']);                          // 草稿的報名＝測試
{
  const sum = (await get({ action: 'reg_admin_list', summary: '1' })).body;
  const by = Object.fromEntries(sum.campaigns.map((c) => [c.id, c]));
  check('★ summary：只回所有活動的清單，不帶單場的名單與各場人數（後台首頁用）', sum.current === '' && sum.regs.length === 0 && sum.per_session.length === 0 && sum.campaigns.length === 3);
  check('每場有自己的報名人數與單位家數（同 Email 只算一人、同媒體只算一家）', by.live2099.people === 3 && by.live2099.outlets === 2, JSON.stringify([by.live2099.people, by.live2099.outlets]));
  check('草稿的測試報名不算人數、另外標出幾筆', by.ws.people === 0 && by.ws.test === 1, JSON.stringify([by.ws.people, by.ws.test]));
  check('每場帶日期範圍與起始日（清單排序用）', by.live2099.date_range === '10/28（三） – 10/29（四）' && by.live2099.date_from === '2099-10-28' && by.ws.date_from === '2099-12-05', JSON.stringify([by.live2099.date_range, by.live2099.date_from]));
  check('進行中與已截止分得出來（accepting）', by.live2099.accepting === true && by.old2026.accepting === false);
  check('summary 帶總入口網址', /\/register$/.test(sum.links.all), JSON.stringify(sum.links));
  const one = (await get({ action: 'reg_admin_list', c: 'live2099' })).body;
  check('單場總覽跟 summary 的人數一致，且有這場自己的連結', one.stats.people === 3 && one.links.form.endsWith('/register?c=live2099') && one.links.all === sum.links.all);
  const noAuth = await get({ action: 'reg_admin_list', summary: '1' }, false);
  check('summary 一樣要管理員密碼', noAuth.statusCode === 401);
}
{
  // 記者端：兩場以上同時開放 → 總入口列清單；只有一場 → 直接進
  await save({ id: 'ws', title: '新手工作坊', status: 'open', sessions_text: S_WS, venue: '工研院 3 樓' });
  const two = (await get({ action: 'reg_config' }, false)).body;
  check('★ 兩場同時開放 → 總入口回清單，每一場帶日期與地點', Array.isArray(two.choices) && two.choices.length === 2
    && two.choices.find((c) => c.id === 'live2099').when === '10/28（三） – 10/29（四）' && two.choices.find((c) => c.id === 'ws').venue === '工研院 3 樓', JSON.stringify(two.choices));
  check('清單不外露後台欄位（只有 id、標題、日期、地點）', two.choices.every((c) => Object.keys(c).sort().join() === 'id,title,venue,when'));
  await save({ id: 'ws', title: '新手工作坊', status: 'closed', sessions_text: S_WS });
  const one = (await get({ action: 'reg_config' }, false)).body;
  check('只剩一場開放 → 總入口直接進那一場', one.campaign?.id === 'live2099' && !one.choices);
}
{
  const csv = await get({ action: 'reg_export', c: 'live2099' });
  check('匯出檔名是「活動報名_…」，欄位標題是「單位／媒體」', /^attachment; filename\*=UTF-8''%E6%B4%BB%E5%8B%95%E5%A0%B1%E5%90%8D_live2099_/.test(csv.headers['content-disposition'] || '') && csv.text.split('\r\n')[0].includes('單位／媒體') && !csv.text.includes('媒體／單位'), csv.headers['content-disposition']);
}

// ═══ 二、改名 ═════════════════════════════════════════════════════════
console.log('\n── 二、「媒體報名」改成「活動報名」：畫面與 LINE 的字，網址與資料不動 ──');
const noComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const LABELS = ['媒體報名', '媒體聯絡人', '要採訪'];
for (const f of ['public/register.html', 'public/registrations.html', 'lib/registration.js', 'lib/menu.js']) {
  const src = noComments(read(f));
  // menu.js 的辨識詞（REGISTER_EXACT_RE）刻意仍接受「媒體報名」——記者打了要認得；那一行是正規表示式、不是顯示文字
  const bad = LABELS.filter((w) => src.split('\n').some((l) => l.includes(w) && !/REGISTER_EXACT_RE|\(\?:媒體\|活動/.test(l)));
  check(`${f}：顯示文字沒有「${LABELS.join('」「')}」`, bad.length === 0, bad.join('、'));
}
{
  const line = noComments(read('api/line.js'));
  const hit = line.split('\n').filter((l) => /媒體報名|媒體聯絡人/.test(l));
  check('api/line.js：米亞的回覆沒有「媒體報名」「媒體聯絡人」', hit.length === 0, hit.join('\n'));
}
check('registrationLabel 預設「活動報名」、歡迎卡按鈕與卡片小標跟著', R.registrationLabel({}) === '活動報名' && R.welcomeButtonLabel({}) === '📝 活動報名（1 分鐘）');
check('LINE 卡片的 altText 與純文字備援都用新名稱', /活動報名/.test(R.buildRegistrationFlex([{ id: 'x', title: 'T', sessions: [], closes_at: '' }]).altText) && !/採訪/.test(R.buildRegistrationText([{ id: 'x', title: 'T', sessions: [], closes_at: '' }])));
check('表單欄位改成通用的字，驗證訊息也是', /服務單位／媒體/.test(read('public/register.html'))
  && R.validateSubmission({ sessions: [], options: [] }, { name: '王小明', outlet: '', email: 'a@b.co', phone: '0912345678', sessions: [] }).errors.some((e) => e.field === 'outlet' && e.message === '請填寫服務單位或媒體名稱'));
{
  const v = JSON.parse(read('vercel.json'));
  check('★ 網址沒變：/register、/registrations 仍在（邀請函上已經發出去的連結不能失效）', v.rewrites.some((r) => r.source === '/register' && r.destination === '/register.html') && v.rewrites.some((r) => r.source === '/registrations' && r.destination === '/registrations.html'));
  check('★ 試算表分頁名稱沒變（正式站的資料還在原處）', R.CAMPAIGN_HEADERS.length === 14 && /reg_campaigns!/.test(read('lib/registration.js')) && /registrations!/.test(read('lib/registration.js')));
  const menu = await import('../lib/menu.js');
  check('米亞仍認得舊的講法「媒體報名」與新的「活動報名」', menu.detectMetaIntent('媒體報名') === 'register' && menu.detectMetaIntent('活動報名') === 'register');
}
{
  const idx = read('public/index.html');
  check('主後台的側邊欄與「更多」面板都改成「活動報名」', (idx.match(/活動報名/g) || []).length >= 2 && !/>\s*媒體報名\s*</.test(idx) && !/label: '媒體報名'/.test(idx));
}

// ═══ 三、後台頁面結構 ═════════════════════════════════════════════════
console.log('\n── 三、後台頁面：清單 → 單場（總覽／名單／分享／設定）→ 設定表單 ──');
{
  const html = read('public/registrations.html');
  const script = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
  check('標題與標頭是「活動報名」', /<title>活動報名/.test(html) && /<h1><a href="#\/">📝 活動報名<\/a><\/h1>/.test(html));
  check('★ 首頁是所有活動的清單（summary），不是只看一場', /id="v-list"/.test(html) && /summary: '1'/.test(script) && /function campCard\(/.test(script));
  check('★ 單場有四個分頁，網址用 hash 路由（重新整理、上一頁都回得來）', /const TABS = \['over', 'list', 'share', 'set'\]/.test(script) && /#\/c\//.test(script) && /hashchange/.test(script));
  check('新增活動不再預填眺望：沒有範例場次、沒有 IEK 網址、沒有寫死的活動代碼', !/iekweb2|SAMPLE|tw2027|眺望～/.test(script) && /function blankCampaign\(/.test(script));
  check('可以複製既有活動當範本（#/new?copy=）', /#\/new\?copy=/.test(html) && /copyId/.test(script));
  check('★ 設定表單的參照在載入時就抓住（被搬走後不能再用 id 去找）', /const FORM_CARD = \$\('form-card'\)/.test(script) && !/\$\('form-card'\)/.test(script.replace("const FORM_CARD = $('form-card')", '')));
  check('設定表單分成幾張卡片，場次一場一列、儲存鈕固定在底部', ['基本資料', '場次', '報名頁上的文字', '進階設定'].every((t) => html.includes(`<h2>${t}`)) && /class="savebar"/.test(html) && /function sessRowEl\(/.test(script));
  check('場次仍存成原本的「｜」分隔文字（試算表與 LINE 端不用跟著改）', /\.join\('｜'\)/.test(script) && /sessions_text: sessionsText\(\)/.test(script));
  check('伺服器退回「第 N 行」時，對回那一列標紅', /第 \(\\d\+\) 行/.test(script) && /classList\.add\('bad'\)/.test(script));
  check('整批貼上（Excel／Word）的模式還在', /toggleSessMode/.test(script) && /id="e-sessions"/.test(html));
  check('只是切分頁不重讀試算表（force 才重讀）', /async function route\(force\)/.test(script) && /force \|\| LOADED_ID !== r\.id/.test(script));
  check('手機版名單卡片的樣式保留（批次 108）', /thead \{ display: none; \}/.test(html) && /td:empty \{ display: none; \}/.test(html));
  check('名單欄位精簡：沒有選填項目就不出現「選填」欄；沒匯入記者名單就不出現「名單外」', /hasOpts \? '<th>選填<\/th>'/.test(script) && /s\.out_of_roster == null \? ''/.test(script));
  check('匯出檔名跟後端一致（活動報名_）', /活動報名_\$\{CUR\}/.test(script));
}
check('範例資料不再放在前端：眺望的場次表只剩在 git 歷史裡', !/IEKConf/.test(read('public/registrations.html')));
check('batch 108 的 SETUP／README 說明已跟著改名（文件不能還叫媒體報名）', !/「媒體報名」（`\/registrations`）/.test(read('SETUP.md')) && /活動報名/.test(read('README.md')));

console.log(`\n${fail ? '❌' : '✅'} 批次 112 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
