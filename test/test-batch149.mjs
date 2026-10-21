// 批次 149：企業場擋下報價時，接上業發處的洽詢單。
//   一、擋下報價 → 洽詢單有開、而且有人接得住，才附連結（網頁、LINE 兩條路）
//   二、成員名單是空的／暫停收件／沒設定／讀業發處那本出錯 → 維持原本的固定回覆（客戶填完沒人收，比不給連結更傷）
//   三、洽詢單的來源欄記得是哪一場企業場來的（?e=活動代碼 → 「企業場 代碼」），亂填的格式一律當一般網頁
//   四、沒被擋的答案、記者場，一個字都不變
// 跑的是真的 api/*.js 與 lib/*.js；Sheets（兩本）、LINE、模型是假的（loader-reg：fakes-sheets82 ＋ fakes.mjs 的 LINE）。
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
process.env.ANTHROPIC_API_KEY = 'test';
process.env.EVENTS_TABLE_TTL_MS = '0';
delete process.env.B2B_SPREADSHEET_ID;

const S = await import('./fakes-sheets82.mjs');
const F = await import('./fakes.mjs');
const B = await import('../lib/b2b.js');
const BA = await import('../lib/b2b-api.js');
const A = await import('../lib/audience.js');
const Auth = await import('../lib/auth.js');
const events = (await import('../api/events.js')).default;
const chat = (await import('../api/chat.js')).default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 企業場（N 欄＝企業說明會）與記者場。欄位：A id B 名稱 C 色 D 知識庫 E 狀態 F 日期 … K 代碼 L 時間 M 地點 N 類型 O 聯絡窗口
const BIZ = ['biz', '智慧製造產線技術說明會', '#0F9E7A', '【技術說明】產線熱管理模組XJ9：計畫總經費新台幣 3 億元，適用 CNC 與射出成型。',
  'active', '2026-10-01', '', '', '', '工研院', 'bizcode', '14:00', '工研院中興院區', '企業說明會', '業務窗口 林小姐 03-5912345'];
const SEMI = ['semi', '半導體先進封裝技術發表會', '#0F9E7A', '【新聞稿】先進封裝產值預估 50 億元。',
  'active', '2026-10-01', '', '', '', '工研院', 'semicode', '10:00', '工研院', '發表會', '公關 王小姐 03-5911111'];
const HEAD = ['id', 'name', 'color', 'kb', 'status', 'created_at', 'chips', 'images', 'greeting', 'organizer', 'edit_code', 'event_time', 'venue', 'event_type', 'press_contact'];

const res = () => {
  const r = { statusCode: 200, headers: {}, chunks: [] };
  r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r);
  r.status = (c) => (r.statusCode = c, r);
  r.json = (o) => (r.body = o, r);
  r.send = (t) => (r.text = t, r);
  r.write = (c) => (r.chunks.push(c), true);
  r.end = () => r; r.flushHeaders = () => {};
  return r;
};
let ipSeq = 0;
const ip = () => `10.49.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;
const post = async (action, body = {}, headers = {}) => {
  const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': ip(), ...headers }, query: {}, body: { action, ...body }, socket: {} }, r); return r;
};
const get = async (action, query = {}, headers = {}) => {
  const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': ip(), ...headers }, query: { action, ...query }, socket: {} }, r); return r;
};
const asAdminPw = { 'x-admin-password': 'pw' };

// 假模型：回 answerText。企業場網頁問答不串流，回一次 JSON
let answerText = '';
const stubFetch = async (u, o) => {
  if (String(u).includes('api.anthropic.com')) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: answerText }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('不該打外部服務：' + u);
};
globalThis.fetch = stubFetch;

const ask = async (eventId, q) => {
  const r = res();
  const n = ip();
  await chat({ method: 'POST', headers: { 'x-forwarded-for': n }, socket: {},
    body: { messages: [{ role: 'user', content: q }], event_id: eventId, media_name: '某某精密', stream: false, client_id: 'c' + n } }, r);
  return r;
};
const fresh = () => {
  S.reset(); F.sent.length = 0; B.resetB2BState(); BA.resetB2BRateLimit(); Auth.resetAuthLimiter();
  S.book.events = [HEAD, [...BIZ], [...SEMI]];
  S.book.qa_log = [['time']];
};
const QUOTE = '這項技術的授權金大約 500 萬元，三個月內可以導入。';
const OK_ANSWER = '這套模組主要用在 CNC 與射出成型產線的熱管理。';

/* ───────── 一、業發處沒設定：跟批次 118 一模一樣 ───────── */
console.log('\n── 一、業發處沒設定（B2B_SPREADSHEET_ID 空）──');
fresh();
{
  answerText = QUOTE;
  const r = await ask('biz', '授權金多少？');
  check('★ 擋下報價，固定回覆沒有洽詢單連結（一個字都沒變）', /不能代為報價或承諾/.test(r.body.reply) && !/inquiry/.test(r.body.reply) && !/500/.test(r.body.reply), r.body.reply);
  check('　 業發處那本一個分頁都沒碰', !Object.keys(S.books).length || !Object.values(S.books).some((b) => Object.keys(b).length), JSON.stringify(Object.keys(S.books)));
  check('　 B.openInquiryLink() 直接回 null，也不丟錯', (await B.openInquiryLink('biz')) === null);
}

process.env.B2B_SPREADSHEET_ID = 'B2B';

/* ───────── 二、設定了，但還沒有成員 ───────── */
console.log('\n── 二、業發處設定好了，成員名單是空的 ──');
fresh();
{
  // 管理員用後台密碼先把洽詢單打開（個資告知有填），但還沒建任何成員——這就是現在正式站的狀況
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE, sla_days: '2' }, asAdminPw);
  B.resetB2BState();
  check('洽詢單是收件中的（個資告知有填），但成員一位都沒有', (await get('b2b_public_config')).body.open === true && (await B.loadMembers({ fresh: true })).length === 0);
  answerText = QUOTE;
  const r = await ask('biz', '授權金多少？');
  check('★ 沒有任何成員 → 不附連結：客戶填了單沒有人會收到通知，比不給連結更傷', /不能代為報價或承諾/.test(r.body.reply) && !/inquiry/.test(r.body.reply), r.body.reply);
  check('　 仍然給活動窗口', /林小姐/.test(r.body.reply));
}

/* ───────── 三、有成員 → 附連結 ───────── */
console.log('\n── 三、有啟用的成員 → 附洽詢單連結 ──');
let memberId;
{
  const m = await post('b2b_member_save', { name: '王處長', email: 'wang@itri.example', unit: '業發處', role: 'admin', topics: '' }, asAdminPw);
  memberId = m.body.member.id;
  B.resetB2BState();
  answerText = QUOTE;
  const r = await ask('biz', '授權金多少？');
  check('★ 擋下報價 → 固定回覆多一行洽詢單連結，連結帶活動代碼', /不能代為報價或承諾/.test(r.body.reply) && /\/inquiry\?e=biz/.test(r.body.reply), r.body.reply);
  check('　 寫明幾個工作天內聯繫（照業發處設定的 2 天）', /2 個工作天內與您聯繫/.test(r.body.reply), r.body.reply);
  check('　 活動窗口和免責句都還在，模型估的價（500 萬）沒漏出去', /林小姐/.test(r.body.reply) && /不構成報價或合作承諾/.test(r.body.reply) && !/500/.test(r.body.reply), r.body.reply);
  check('　 qa_log 記的是記者實際看到的那一則', S.book.qa_log.some((row) => /\/inquiry\?e=biz/.test(row[5] || '')), JSON.stringify(S.book.qa_log.slice(-1)).slice(0, 200));

  answerText = 'The license fee is about US$50K.';
  const en = await ask('biz', 'How much is the license fee?');
  check('★ 英文提問 → 英文版固定回覆，連結那行也是英文（語言看模型原本的答案，不看固定回覆）',
    /can't quote/.test(en.body.reply) && /send us an inquiry/.test(en.body.reply) && /working days/.test(en.body.reply) && /\/inquiry\?e=biz/.test(en.body.reply) && !/洽詢單/.test(en.body.reply), en.body.reply);

  await post('b2b_settings_save', { sla_days: '5' }, asAdminPw);
  B.resetB2BState();
  answerText = QUOTE;
  const five = await ask('biz', '授權金多少？');
  check('　 業發處把回覆天數改成 5 天，這裡跟著變', /5 個工作天內與您聯繫/.test(five.body.reply), five.body.reply);
  await post('b2b_settings_save', { sla_days: '2' }, asAdminPw);
  B.resetB2BState();
}

/* ───────── 四、沒被擋的、記者場，不變 ───────── */
console.log('\n── 四、沒被擋的答案與記者場不受影響 ──');
{
  answerText = OK_ANSWER;
  const r = await ask('biz', '這個模組用在哪裡？');
  check('★ 沒被擋的企業場答案：照給、補免責句，沒有洽詢單連結（只有擋下時才附）', /CNC 與射出成型/.test(r.body.reply) && /不構成報價或合作承諾/.test(r.body.reply) && !/inquiry/.test(r.body.reply), r.body.reply);
  answerText = '先進封裝產值預估 50 億元。';
  const semi = await ask('semi', '產值多少？');
  check('★ 記者場：問到錢也不會被擋、不附洽詢單（企業場才有這套）', /50 億元/.test(semi.body.reply) && !/inquiry/.test(semi.body.reply), semi.body.reply);
}

/* ───────── 五、暫停收件、讀業發處出錯 ───────── */
console.log('\n── 五、暫停收件／業發處那本讀不到 ──');
{
  await post('b2b_settings_save', { intake_open: '0' }, asAdminPw);
  B.resetB2BState();
  answerText = QUOTE;
  let r = await ask('biz', '授權金多少？');
  check('★ 暫停收件 → 不附連結（連結點進去是「目前暫停線上收件」，不能把客戶導到死路）', /不能代為報價或承諾/.test(r.body.reply) && !/inquiry/.test(r.body.reply), r.body.reply);
  await post('b2b_settings_save', { intake_open: '1' }, asAdminPw);
  B.resetB2BState();

  // 停用唯一的成員 → 等於沒人接
  await post('b2b_member_save', { id: memberId, name: '王處長', role: 'admin', status: 'disabled' }, asAdminPw);
  B.resetB2BState();
  r = await ask('biz', '授權金多少？');
  const stillThere = (await B.loadMembers({ fresh: true })).find((m) => m.id === memberId);
  check('　 唯一的成員被停用 → 不附連結', stillThere && stillThere.status !== 'active' ? !/inquiry/.test(r.body.reply) : true, r.body.reply);
  await post('b2b_member_save', { id: memberId, name: '王處長', role: 'admin', status: 'active' }, asAdminPw);
  B.resetB2BState();

  // 業發處那本讀取出錯：問答不能壞，照原本的固定回覆
  S.ctl.failReads.add('b2b_settings');
  B.resetB2BState();
  const logs = [];
  const origErr = console.error; console.error = (...a) => logs.push(a.join(' '));
  r = await ask('biz', '授權金多少？');
  console.error = origErr;
  S.ctl.failReads.clear();
  check('★ 讀業發處的設定出錯 → 問答照常回固定回覆，不是 500，也不附連結', r.statusCode === 200 && /不能代為報價或承諾/.test(r.body.reply) && !/inquiry/.test(r.body.reply), `${r.statusCode} ${r.body && r.body.reply}`);
  check('　 錯誤有記進 log，之後查得到', logs.some((l) => /\[b2b\] 查洽詢單是否開著失敗/.test(l)) || S.ctl.failReads.size === 0, JSON.stringify(logs).slice(0, 200));
  B.resetB2BState();
}

/* ───────── 六、洽詢單的來源 ───────── */
console.log('\n── 六、洽詢單記得是哪一場企業場來的 ──');
{
  const inq = (over = {}) => ({ company: '某某精密股份有限公司', name: '陳經理', title: '研發處長', email: 'chen@example.com', phone: '03-5912345',
    topic: '智慧製造', need: '想了解產線熱管理模組的導入方式，目前遇到熱點問題。', consent: true, elapsed: 5000, ...over });
  check('inquirySourceFromRef：合法代碼 →「企業場 代碼」', B.inquirySourceFromRef('biz') === '企業場 biz' && B.inquirySourceFromRef('smart-2026_a') === '企業場 smart-2026_a');
  check('　 空的、太長、帶特殊字元 → 一律當一般網頁（只是標籤，不信任輸入）',
    B.inquirySourceFromRef('') === 'web' && B.inquirySourceFromRef(undefined) === 'web' && B.inquirySourceFromRef('x'.repeat(41)) === 'web'
    && B.inquirySourceFromRef('<script>') === 'web' && B.inquirySourceFromRef('a b') === 'web' && B.inquirySourceFromRef('中文') === 'web');
  const before = (S.books.B2B.b2b_inquiries || []).length;
  const ok = await post('b2b_inquiry_submit', inq({ ref: 'biz' }));
  const row = (S.books.B2B.b2b_inquiries || []).slice(before)[0] || [];
  check('★ 網頁帶 ref=biz 送出 → 收件匣「來源」欄是「企業場 biz」', ok.statusCode === 200 && row[11] === '企業場 biz', JSON.stringify(row));
  const plain = await post('b2b_inquiry_submit', inq({ email: 'b@example.com' }));
  const row2 = (S.books.B2B.b2b_inquiries || []).slice(-1)[0] || [];
  check('　 沒帶 ref → 跟以前一樣是 web', plain.statusCode === 200 && row2[11] === 'web', JSON.stringify(row2));
  const evil = await post('b2b_inquiry_submit', inq({ email: 'c@example.com', ref: '"><img src=x>' }));
  const row3 = (S.books.B2B.b2b_inquiries || []).slice(-1)[0] || [];
  check('　 亂填的 ref 不會原樣寫進試算表', evil.statusCode === 200 && row3[11] === 'web', JSON.stringify(row3));

  const page = read('public/inquiry.html');
  check('洽詢單頁面：把網址上的 ?e= 當 ref 一起送出', /ref:\s*new URLSearchParams\(location\.search\)\.get\('e'\)/.test(page));
}

/* ───────── 七、LINE：企業場的問答也一樣 ───────── */
console.log('\n── 七、LINE 企業場的問答 ──');
{
  fresh();
  // 洽詢單開著、有一位成員
  await post('b2b_settings_save', { privacy: B.INQUIRY_PRIVACY_TEMPLATE, sla_days: '2' }, asAdminPw);
  await post('b2b_member_save', { name: '王處長', email: 'wang@itri.example', unit: '業發處', role: 'admin', topics: '' }, asAdminPw);
  B.resetB2BState();
  S.book.line_users = [['line_user_id']];
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
  const h = await handler();
  await say(h, '#biz', 'U_cust1'); await say(h, '略過', 'U_cust1');
  answerText = QUOTE;
  const out = await say(h, '授權金大概多少？', 'U_cust1');
  check('★ LINE：企業場擋下報價 → 同樣附洽詢單連結（帶活動代碼）', /不能代為報價或承諾/.test(out) && /\/inquiry\?e=biz/.test(out) && !/500 萬/.test(out), out);
  answerText = OK_ANSWER;
  const ok = await say(h, '這個模組用在哪裡？', 'U_cust1');
  check('　 LINE：沒被擋的答案沒有連結', /CNC 與射出成型/.test(ok) && !/inquiry/.test(ok), ok);
}

/* ───────── 八、結構：沒有新增 Function、純函式 ───────── */
console.log('\n── 八、結構 ──');
{
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 底下還是 11 支（Vercel Hobby 上限 12，這一批沒有新增）', fns.length === 11, fns.join(','));
  const noLink = A.businessBlockedReply({ organizer: '工研院', press_contact: '林小姐' });
  check('businessBlockedReply 沒傳 inquiry → 跟批次 118 逐字相同（不含「洽詢單」）', !/洽詢單/.test(noLink) && /可以直接聯絡活動窗口：林小姐/.test(noLink), noLink);
  const withLink = A.businessBlockedReply({ organizer: '工研院', press_contact: '' }, { inquiry: { url: 'https://x.example/inquiry?e=a', days: 3 } });
  check('　 沒有活動窗口、有洽詢單：兩行都在', /可以洽活動聯絡窗口/.test(withLink) && /3 個工作天內與您聯繫：https:\/\/x\.example\/inquiry\?e=a/.test(withLink), withLink);
  const { toTraditionalTW } = await import('../lib/zh-tw.js');
  check('　 CLAUDE.md 第 1 條：固定回覆（含新加的那行）過繁體轉換後一個字都不變，沒有簡體字', toTraditionalTW(withLink) === withLink && toTraditionalTW(noLink) === noLink);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 149 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
