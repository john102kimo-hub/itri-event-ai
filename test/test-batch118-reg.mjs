// 批次 118（業發處第 0 步）的報名那一半：用「活動報名」辦企業說明會、技術媒合、客戶參訪。
//   一、報名對象（媒體／企業）存在第 15 欄；舊版後台頁送來的請求不會把企業場洗回媒體場
//   二、企業場沒有個資告知不能開放；報名者沒勾同意送不出去，同意的時間記在那一筆
//   三、文字型選填項目（想了解的技術⋯）：「;」「=」換成全形，存回去讀出來一字不差
//   四、企業場不比對記者名單、匯出寫「公司／單位」並附同意時間
// 跑的是真的 api/events.js 與 lib/registration*.js；Google Sheets 是假的（fakes-sheets82）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_BASIC_ID = '@mia123';

// 假時鐘：固定在 2026-10-08 中午（台灣時間），場次在 11 月——SHIFT_DAYS 怎麼撥都不會讓場次「辦完」
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
  const r = { statusCode: 200, headers: {}, body: undefined, text: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = (t) => { r.text = t; return r; };
  r.end = () => r;
  return r;
}
let ipSeq = 0;
async function post(body, { headers = {} } = {}) {
  const res = fakeRes();
  await events({ method: 'POST', headers: { 'x-forwarded-for': `10.1.0.${++ipSeq % 250}`, ...headers }, query: {}, body }, res);
  return res;
}
async function get(query, { headers = {} } = {}) {
  const res = fakeRes();
  await events({ method: 'GET', headers, query }, res);
  return res;
}
const admin = (b) => post({ password: 'pw', ...b });
const adminGet = (q) => get(q, { headers: { 'x-admin-password': 'pw' } });

const SESSIONS = 'A1｜2026-11-20｜09:30-12:00｜先進封裝技術說明｜201 廳\nA2｜2026-11-20｜13:30-16:00｜一對一技術媒合｜202 廳';
const OPTIONS = 'topic｜想了解的技術或合作主題｜｜text\ncontact_me｜希望業務窗口與我聯繫';
const base = { action: 'reg_admin_save_campaign', id: 'biz2026', title: '先進封裝企業說明會', sessions_text: SESSIONS, options_text: OPTIONS,
  intro: '歡迎企業報名', contact: '業務窗口 林小姐\nbd@example.com', closes_at: '2026-11-19' };
const submit = (b) => post({ action: 'reg_submit', c: 'biz2026', name: '陳大明', outlet: '某某精密股份有限公司', email: 'chen@example.com',
  phone: '0912345678', sessions: ['A1'], elapsed: 5000, ...b });

/* ───────── 一、報名對象 ───────── */
console.log('\n── 一、報名對象存在第 15 欄 ──');
reset(); API.resetRateLimit(); R.resetRegistrationState();
{
  const r = await admin({ ...base, audience: 'business', status: 'draft' });
  check('企業場可以先存成草稿（還沒有個資告知也可以，先自己測）', r.statusCode === 200, JSON.stringify(r.body));
  check('　 第 15 欄（O）存 business、表頭也補上 audience', book.reg_campaigns[1][14] === 'business' && book.reg_campaigns[0][14] === 'audience', JSON.stringify(book.reg_campaigns[1]));
  const old = await admin({ ...base, status: 'draft' }); // 舊版後台頁：請求裡沒有 audience 這個欄位
  check('★ 舊版後台頁存檔（沒帶 audience）→ 保留企業場，不會洗回媒體場', old.statusCode === 200 && book.reg_campaigns[1][14] === 'business', JSON.stringify(book.reg_campaigns[1]));
  const bad = await admin({ ...base, audience: 'vip', status: 'draft' });
  check('　 不認得的對象 → 400', bad.statusCode === 400, JSON.stringify(bad.body));
  const media = await admin({ ...base, id: 'media2026', title: '媒體場', status: 'open' });
  check('　 沒帶 audience 的新活動＝媒體場（舊行為）', media.statusCode === 200 && book.reg_campaigns.find((x) => x[0] === 'media2026')[14] === 'media');
}

/* ───────── 二、個資告知與同意 ───────── */
console.log('\n── 二、企業場的個資告知與同意 ──');
{
  const open = await admin({ ...base, audience: 'business', status: 'open' });
  check('★ 企業場沒有個資告知 → 不能開放報名，錯誤訊息講得出為什麼', open.statusCode === 400 && /個資告知/.test(open.body.error) && /個資法/.test(open.body.error), JSON.stringify(open.body));
  const ok = await admin({ ...base, audience: 'business', status: 'open', privacy: R.BUSINESS_PRIVACY_TEMPLATE });
  check('　 填了個資告知 → 可以開放', ok.statusCode === 200 && book.reg_campaigns[1][2] === 'open', JSON.stringify(ok.body));

  R.invalidateCampaignCache();
  const cfg = await get({ action: 'reg_config', c: 'biz2026' });
  const c = cfg.body.campaign;
  check('報名頁拿到 audience=business、consent_required=true、個資告知全文',
    c.audience === 'business' && c.consent_required === true && c.privacy.includes('個人資料保護法第 3 條'), JSON.stringify(c).slice(0, 300));
  check('　 企業場完成頁的米亞說明不提新聞稿與照片（那是給記者的）', !c.line_pitch.join('').includes('新聞稿') && c.line_pitch.length >= 1, JSON.stringify(c.line_pitch));
  check('　 文字型選填項目照樣傳給報名頁', c.options.some((o) => o.key === 'topic' && o.type === 'text'), JSON.stringify(c.options));

  const no = await submit({});
  check('★ 沒勾同意 → 送不出去（伺服器端也擋，不是只有前台）', no.statusCode === 400 && no.body.errors.some((e) => e.field === 'consent'), JSON.stringify(no.body));
  check('　 而且什麼都沒寫進試算表', (book.registrations || []).length <= 1);
  const yes = await submit({ consent: true, options: { topic: '晶片散熱;導熱=材料\n第二行', contact_me: true } });
  const row = (book.registrations || [])[1] || [];
  const opts = R.parseOptionValues(row[9]);
  check('勾了同意 → 報名成功，同意的時間記在那一筆（_consent）', yes.statusCode === 200 && /^2026-10-08T12:00:00\+08:00$/.test(opts._consent || ''), JSON.stringify({ body: yes.body, row }));
  check('★ 文字答案的「;」「=」換成全形、換行收成空白——存回去讀出來一字不差，也沒有切壞其他選項',
    opts.topic === '晶片散熱；導熱＝材料 第二行' && opts.contact_me === '1', JSON.stringify(opts));
  const long = R.validateSubmission(R.campaignFromRow(book.reg_campaigns[1]), { name: '王小明', outlet: 'X 公司', email: 'a@b.co', phone: '0912345678', sessions: ['A1'], consent: true, options: { topic: '字'.repeat(260) } });
  check('　 文字答案最多 200 字', long.clean.options.topic.length === 200);
  const media = R.validateSubmission(R.campaignFromRow(book.reg_campaigns.find((x) => x[0] === 'media2026')), { name: '王小明', outlet: '經濟日報', email: 'a@b.co', phone: '0912345678', sessions: ['A1'] });
  check('　 媒體場不需要勾同意（朱朱 9/29 的決定不變）', !media.errors.some((e) => e.field === 'consent'), JSON.stringify(media.errors));
  const label = R.validateSubmission(R.campaignFromRow(book.reg_campaigns[1]), { name: '王小明', outlet: '', email: 'a@b.co', phone: '0912345678', sessions: ['A1'], consent: true });
  check('　 企業場沒填單位 → 「請填寫公司或單位名稱」', label.errors.some((e) => e.field === 'outlet' && e.message === '請填寫公司或單位名稱'), JSON.stringify(label.errors));
}

/* ───────── 三、文字型選填項目的設定 ───────── */
console.log('\n── 三、文字型選填項目 ──');
{
  const p = R.parseOptions('topic｜想了解的技術｜｜text\nmeal｜需要餐盒\nparty｜同行人數｜｜number', ['A1']);
  check('「代碼｜顯示文字｜限定場次｜text」解析成文字型', p.errors.length === 0 && p.options[0].type === 'text' && p.options[1].type === 'check' && p.options[2].type === 'number', JSON.stringify(p));
  check('　 存回文字時類型照樣寫出來（勾選型不寫）', R.optionsToText(p.options) === 'topic｜想了解的技術｜｜text\nmeal｜需要餐盒\nparty｜同行人數｜｜number', R.optionsToText(p.options));
  const bad = R.parseOptions('x｜某項｜｜textarea', []);
  check('　 不認得的類型 → 錯誤訊息列出三種', bad.errors.length === 1 && /check、number 或 text/.test(bad.errors[0]), JSON.stringify(bad.errors));
}

/* ───────── 四、後台與匯出 ───────── */
console.log('\n── 四、後台與匯出 ──');
{
  book.media_roster = [['h'], ['', '王記者', '經濟日報', '', 'wang@example.com']];
  const ov = await adminGet({ action: 'reg_admin_list', c: 'biz2026' });
  const g = ov.body.regs.find((x) => x.email === 'chen@example.com');
  check('★ 企業場不比對記者名單（與會者本來就不是記者，比了只會滿版「名單外」）',
    ov.statusCode === 200 && g && g.roster === 'unknown' && ov.body.stats.out_of_roster === null && ov.body.roster_size === 0, JSON.stringify({ g, stats: ov.body.stats }));
  check('　 文字型選填項目在統計裡數「有幾筆填了」', ov.body.option_totals.topic === 1 && ov.body.option_totals.contact_me === 1, JSON.stringify(ov.body.option_totals));
  check('　 活動清單帶 audience（後台卡片標「企業」）', ov.body.campaigns.find((x) => x.id === 'biz2026').audience === 'business');
  const csv = await adminGet({ action: 'reg_export', c: 'biz2026' });
  const lines = String(csv.text || '').replace(/^﻿/, '').split('\r\n');
  check('匯出：企業場寫「公司／單位」、最後一欄是個資同意時間', /公司／單位/.test(lines[0]) && /個資同意時間$/.test(lines[0]), lines[0]);
  check('　 文字答案原樣匯出、同意時間是好讀的格式', lines[1].includes('晶片散熱；導熱＝材料 第二行') && lines[1].includes('2026-10-08 12:00:00'), lines[1]);
  const mediaCsv = await adminGet({ action: 'reg_export', c: 'media2026' });
  check('　 媒體場的匯出不變（單位／媒體、沒有同意時間）', /單位／媒體/.test(mediaCsv.text) && !/個資同意時間/.test(mediaCsv.text));
}

/* ───────── 五、記者看得到的入口不列企業場 ───────── */
console.log('\n── 五、記者看得到的入口不列企業場 ──');
{
  R.invalidateCampaignCache();
  const open = await R.listOpenCampaigns();
  check('★ 米亞的「我要報名」、歡迎卡、圖文選單用的開放清單：只有媒體場', open.some((c) => c.id === 'media2026') && !open.some((c) => c.id === 'biz2026'), open.map((c) => c.id).join(','));
  const topics = await R.listRegistrationTopics();
  check('　 米亞判斷「報名」要不要攔，也不看企業場', !topics.open.some((c) => c.id === 'biz2026'));
  const landing = await get({ action: 'reg_config' });
  check('　 不帶活動代碼的 /register 總入口不列企業場；帶代碼的專屬連結照樣打得開',
    landing.statusCode === 200 && landing.body.campaign && landing.body.campaign.id === 'media2026' && (await get({ action: 'reg_config', c: 'biz2026' })).body.campaign.id === 'biz2026', JSON.stringify(landing.body).slice(0, 200));
  const menu = await admin({ action: 'reg_admin_menu_sync', c: 'biz2026' });
  check('　 企業場不能放進米亞的圖文選單', menu.statusCode === 400 && /企業場/.test(menu.body.error), JSON.stringify(menu.body));
}

/* ───────── 六、頁面 ───────── */
console.log('\n── 六、頁面 ──');
{
  const page = read('public/registrations.html');
  const m = page.match(/const PRIVACY_TEMPLATE = \[([\s\S]*?)\]\.join/);
  const lines = m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
  check('後台「套用範本」的文字跟 lib/registration.js 的 BUSINESS_PRIVACY_TEMPLATE 一字不差', lines.join('\n') === R.BUSINESS_PRIVACY_TEMPLATE, lines.join('\n'));
  check('　 後台有報名對象的選單、選填項目多了「文字」', /id="e-audience"/.test(page) && /<option value="text"/.test(page) && /audience: \$\('e-audience'\)\.value/.test(page));
  const reg = read('public/register.html');
  check('報名頁：企業場寫「公司／單位」、有同意勾選、文字型選填項目', /c\.audience === 'business'/.test(reg) && /id: 'f-consent'/.test(reg) && /consent_required/.test(reg) && /o\.type === 'text'/.test(reg));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 118（報名）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
