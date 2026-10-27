// 批次 174：10/28 前一天再盤點——從正式資料找出來的三件事。
//   一、按鈕預覽說錯了是哪一組：活動前、沒填「活動前快速提問」時，預覽寫「用你填的『活動前快速提問』」，
//       其實是一般那組，而且活動前米亞只用邀請函回答，邀請函沒寫到的題目會答不出來（眺望 10/27 就是這樣）
//   二、知識庫、邀請函裡的報名連結帶著同仁自己的 LINE 簽章（u=…）：存檔時清掉
//   三、後台「這場的活動報名」：「活動報名」裡已經有同一天、還沒關聯的報名 → 先問是不是同一場，不直接再建一筆
import { register } from 'node:module';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.SITE_URL = 'https://example.itri.test';
delete process.env.B2B_SPREADSHEET_ID;

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
const ip = () => `10.174.${Math.floor(++n / 200)}.${n % 200}`;
const post = async (action, body = {}, headers = {}) => { const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': ip(), ...headers }, query: {}, body: { action, ...body }, socket: {} }, r); return r; };
const get = async (action, query = {}) => { const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': ip() }, query: { action, ...query }, socket: {} }, r); return r; };
const asAdmin = { 'x-admin-password': 'pw' };
const inDays = (k) => new Date(Date.now() + k * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// ═══ 一、按鈕預覽 ═══════════════════════════════════════════════════════════════
console.log('\n── 一、按鈕預覽：活動前用的是哪一組，講清楚 ──');
{
  const base = { knowledge_base: '【新聞稿】內容', invite_letter: '親愛的媒體朋友：誠摯邀請', event_date: inDays(1) };
  let r = await post('chips_preview', { ...base, chips: '研討會每天的主題場次\n我要報名' });
  check('★ 活動前、沒填「活動前快速提問」、有一般快速問題 → source=custom_in_pre（記者看到一般那組）',
    r.body.source === 'custom_in_pre' && r.body.pre_event === true && JSON.stringify(r.body.chips) === JSON.stringify(['研討會每天的主題場次', '我要報名']), JSON.stringify(r.body));
  r = await post('chips_preview', { ...base, chips: '研討會每天的主題場次', invite_letter_chips: '邀請函內容？' });
  check('　 有填「活動前快速提問」→ source=pre_custom、用那一組', r.body.source === 'pre_custom' && JSON.stringify(r.body.chips) === JSON.stringify(['邀請函內容？']));
  r = await post('chips_preview', { ...base });
  check('　 兩組都沒填 → pre_default（系統的活動前預設）', r.body.source === 'pre_default');
  r = await post('chips_preview', { knowledge_base: '【新聞稿】內容', chips: '重點？', event_date: inDays(1) });
  check('　 沒有邀請函（不是活動前模式）→ custom；都沒填 → auto', r.body.source === 'custom' && (await post('chips_preview', { knowledge_base: '【新聞稿】內容' })).body.source === 'auto');
  check('　 舊欄位 custom、pre_event 照舊（舊版頁面看得懂）', (await post('chips_preview', { ...base, chips: 'x' })).body.custom === true);
  const js = read('public/chips-preview.js');
  check('★ 預覽畫面：不再把一般那組說成「活動前快速提問」，並警告邀請函沒寫到的題目會答不出來',
    /custom_in_pre: '記者現在看到的（活動前：沒填「活動前快速提問」，先用上面這組）：'/.test(js)
    && /活動前米亞只用媒體邀請函回答：這幾題邀請函裡沒寫到的，記者按了會得到「沒有資料」/.test(js) && /\(d && d\.source\) \|\|/.test(js));
  check('　 仍然只用 textContent（問句不當 HTML）', !/innerHTML/.test(js));
}

// ═══ 二、報名連結的 LINE 簽章 ═══════════════════════════════════════════════════════
console.log('\n── 二、知識庫與邀請函裡報名連結的 LINE 簽章，存檔時清掉 ──');
{
  const strip = R.stripRegisterLineTokens;
  check('★ 拿掉 u=…、留下 c=…（眺望知識庫裡那一條的樣子）',
    strip('請上報名網頁報名(https://x.vercel.app/register?c=iek20261028&u=VTRhZjcx.HMnE-WB)，以利') === '請上報名網頁報名(https://x.vercel.app/register?c=iek20261028)，以利');
  check('　 u 在前面也拿得掉；其他參數順序不變', strip('https://x/register?u=a.b&c=k&t=z') === 'https://x/register?c=k&t=z');
  check('　 只有 u → 連問號一起拿掉', strip('https://x/register?u=a.b 後面') === 'https://x/register 後面');
  check('　 不是報名連結的 u= 不碰；沒有連結的文字不變', strip('https://x.com/a?u=1 與文字') === 'https://x.com/a?u=1 與文字' && strip('') === '' && strip(null) === '');

  S.reset(); R.resetRegistrationState(); Auth.resetAuthLimiter();
  const KB = '【報名】https://itri-event-ai.vercel.app/register?c=iek20261028&u=VTRh.SIG';
  S.book.events = [['id'], ['e1', '測試活動甲', '#0F9E7A', KB, 'active', inDays(-1), '', '', '', '工研院', 'code1', '10:00', '201 廳', '論壇', '王小明', '', '邀請函 https://itri-event-ai.vercel.app/register?u=X.Y&c=iek20261028', '']];
  let r = await post('update', { id: 'e1', name: '測試活動甲（改名）' }, asAdmin);
  const row = S.book.events[1];
  check('★ 後台存檔（就算只改名）→ 知識庫與邀請函裡的簽章都清掉', r.statusCode === 200 && row[3] === '【報名】https://itri-event-ai.vercel.app/register?c=iek20261028' && row[16] === '邀請函 https://itri-event-ai.vercel.app/register?c=iek20261028', JSON.stringify([row[3], row[16]]));
  r = await post('update_edit', { id: 'e1', code: 'code1', knowledge_base: '新的 https://itri-event-ai.vercel.app/register?c=a&u=Q.W' });
  check('　 同仁編輯頁存檔也一樣', r.statusCode === 200 && S.book.events[1][3] === '新的 https://itri-event-ai.vercel.app/register?c=a', S.book.events[1][3]);
  r = await post('create', { name: '新活動', knowledge_base: '連結 https://itri-event-ai.vercel.app/register?c=b&u=Z.Z' }, asAdmin);
  check('　 新增活動也一樣', r.statusCode === 200 && S.book.events.at(-1)[3] === '連結 https://itri-event-ai.vercel.app/register?c=b', S.book.events.at(-1)[3]);
}

// ═══ 三、這場的活動報名 ═════════════════════════════════════════════════════════
console.log('\n── 三、「這場的活動報名」：已經有同一天、還沒關聯的報名 → 先問 ──');
{
  S.reset(); R.resetRegistrationState(); RA.resetRateLimit?.(); Auth.resetAuthLimiter();
  // 日期相對今天算（SHIFT_DAYS=90 跑的時候，寫死的日期會變成已經辦完、報名不收件）
  const D1 = inDays(30), D2 = inDays(31);
  S.book.events = [['id'],
    ['tw', '眺望研討會開幕', '#0F9E7A', '【新聞稿】x', 'active', D1, '', '', '', '工研院', 'c1', '09:00~11:50', '臺大醫院國際會議中心', '論壇', '朱則瑋'],
    ['other', '同一天另一場記者會', '#0F9E7A', '【新聞稿】y', 'active', D1, '', '', '', '工研院', 'c2', '14:00', '中興院區', '記者會', '王小明'],
  ];
  await post('reg_admin_save_campaign', { id: 'iek', title: '眺望～研討會', status: 'open', intro: '歡迎', contact: '朱則瑋', venue: '臺大醫院',
    sessions_text: `A1｜${D1}｜09:00-11:50｜開幕｜201 廳\nA2｜${D2}｜13:30-16:00｜通訊` }, asAdmin);
  await post('reg_admin_save_campaign', { id: 'old', title: '去年的', status: 'closed', sessions_text: `A1｜${D1}｜10:00-12:00｜x` }, asAdmin);
  const before = S.book.reg_campaigns.length;
  let r = await post('reg_admin_from_event', { event_id: 'tw' }, asAdmin);
  check('★ 有一筆同一天、還沒關聯的報名 → 回 candidates，不建新的', r.statusCode === 200 && JSON.stringify(r.body.candidates) === JSON.stringify([{ id: 'iek', title: '眺望～研討會' }]) && S.book.reg_campaigns.length === before, JSON.stringify(r.body));
  check('　 已截止的報名不列（那是舊的）', !r.body.candidates.some((c) => c.id === 'old'));
  r = await post('reg_admin_from_event', { event_id: 'tw', link_to: 'iek' }, asAdmin);
  const iek = S.book.reg_campaigns.find((x) => x[0] === 'iek');
  check('★ 選「就是這一筆」→ 只填上關聯活動，其他設定一個字都沒動', r.statusCode === 200 && r.body.id === 'iek' && r.body.linked === true && iek[16] === 'tw' && iek[3] === '歡迎' && iek[7] === '朱則瑋' && iek[4].includes(`A2｜${D2}`), JSON.stringify(iek));
  check('　 活動頁現在有「我要報名」', /iek/.test((await get('reg_event_link', { id: 'tw' })).body.url || ''));
  r = await post('reg_admin_from_event', { event_id: 'tw' }, asAdmin);
  check('　 之後再按 → 直接帶到那一筆（已關聯）', r.body.id === 'iek' && r.body.created === false && !r.body.candidates);
  r = await post('reg_admin_from_event', { event_id: 'other', link_to: 'iek' }, asAdmin);
  check('★ 那筆已經關聯別場 → 不搶（409）', r.statusCode === 409 && S.book.reg_campaigns.find((x) => x[0] === 'iek')[16] === 'tw', JSON.stringify(r.body));
  r = await post('reg_admin_from_event', { event_id: 'other' }, asAdmin);
  check('　 同一天另一場：那筆已經關聯了，不再列為候選 → 照舊建一筆新的草稿', r.body.created === true && r.body.id === 'reg-other', JSON.stringify(r.body));
  S.book.reg_campaigns.push(['loose', '沒關聯的', 'open', '', `A1｜${D1}｜10:00｜x`, '', '', '', '', '', '', '', '', '', 'media', '', '']);
  S.book.events.push(['third', '第三場', '#0F9E7A', 'z', 'active', D1, '', '', '', '工研院', 'c3', '15:00', 'A', '記者會', 'B']);
  R.resetRegistrationState();
  r = await post('reg_admin_from_event', { event_id: 'third', create_new: true }, asAdmin);
  check('★ 選「另外建一筆」（create_new）→ 照舊建草稿', r.body.created === true && r.body.id === 'reg-third', JSON.stringify(r.body));
  const idx = read('public/index.html');
  check('　 後台：收到 candidates 先問「這就是這場的報名嗎？」，取消再問要不要另外建', /data\.candidates/.test(idx) && /這就是「\$\{ev \? ev\.name : eventId\}」的報名嗎？/.test(idx) && /createRegFromEvent\(eventId, \{ link_to: c\.id \}\)/.test(idx) && /createRegFromEvent\(eventId, \{ create_new: true \}\)/.test(idx));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 174 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
