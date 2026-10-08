// 批次 116：整體再檢討——每一段都對應一個先用真的程式重現過的問題（見 docs/batches 批次 116）。
//   一、繁體防線把對的繁體改壞（中科后里園區 → 中科後裡園區、阿里山 → 阿裡山）
//   二、報名編號 5 碼就能把別人的報名綁到自己的 LINE，接著讀走 Email 與手機
//   三、同仁編輯碼 + copy_from 讀得到草稿與禁發期的正式新聞稿
//   四、網頁問答的 8000 字上限，content 改傳陣列就失效
//   五、上傳照片／記者名單／露出上傳三個入口，猜管理員密碼不受限流
//   六、收回共用連結只在按的那一台生效
//   七、活動前網頁的 og:image 帶出禁發期的正式照片
//   八、權杖用 Math.random()
//   九、記者名單匯出 CSV 沒有公式注入防護
// 跑的是真的 api/*.js 與 lib/*.js；Sheets、LINE 是假的（loader-116 → loader-reg）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
register('./loader-116.mjs', import.meta.url);

process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_BASIC_ID = '@mia123';
process.env.ADMIN_PASSWORD = 'correct-horse';
process.env.EVENTS_TABLE_TTL_MS = '0';

// 時鐘可以往前撥（設定快取的 60 秒）。限流、報名的「場次辦完了沒」都讀 Date.now()。
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const F = await import('./fakes.mjs');
const { sent, reset: resetLine } = F;
const S = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const A = await import('../lib/auth.js');
const { toTraditionalTW, createTraditionalStream } = await import('../lib/zh-tw.js');
const { generateEditCode, generateShareCode } = await import('../lib/ids.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const iso = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// 直接呼叫 api/*.js 用的假 req／res（同 test-batch110）
const mkRes = () => {
  const r = { statusCode: 200, headers: {} };
  r.setHeader = (k, v) => (r.headers[k] = v, r);
  r.status = (c) => (r.statusCode = c, r);
  r.json = (o) => (r.body = o, r);
  r.send = (b) => (r.body = b, r);
  r.write = () => r; r.end = () => r; r.flushHeaders = () => {};
  return r;
};
const call = async (handler, { ip = '10.0.0.1', headers = {}, ...rest }) => {
  const r = mkRes();
  await handler({ query: {}, socket: {}, ...rest, headers: { 'x-forwarded-for': ip, ...headers } }, r);
  return r;
};

/* ───────── 一、繁體防線 ───────── */
console.log('\n── 一、繁體防線：對的繁體一個字都不能改壞 ──');
for (const keep of ['中科后里園區', '台中市后里區', '阿里山', '阿里巴巴', '金馬影后', '天后蔡依林', '准考證', '准將', '允准',
  '里約奧運', '故里', '百里', '里斯本', '密蘇里州', '馬里蘭大學', '克里斯', '筑波大學', '本次活動在中科后里園區舉行']) {
  check(`不改壞：「${keep}」`, toTraditionalTW(keep) === keep, toTraditionalTW(keep));
}
for (const [input, want, why] of [
  ['中科后里園區的产线', '中科后里園區的產線', '繁體句子裡夾一兩個簡體字：只換那幾個字，后／里不動'],
  ['活动在中科后里园区举行', '活動在中科后里園區舉行', '整句簡體也認得「后里」'],
  ['会后将于官网公布', '會後將於官網公布', '整句簡體的「后」照樣轉'],
  ['里面的内容', '裡面的內容', '整句簡體的「里」照樣轉'],
  ['准考证', '准考證', '簡體的「准考证」也不是「準考證」'],
  ['理发', '理髮', '「发」的例外轉成「髮」，不再原封不動留著簡體'],
  ['短发很好看', '短髮很好看', '同上'],
  ['整理发给大家', '整理發給大家', '「发给」是發，不被「理」接走'],
  ['假发票', '假發票', '「发票」是發，不被「假」接走'],
  ['建筑师', '建築師', '「筑」改用詞組轉'],
]) {
  check(`${why}：「${input}」→「${want}」`, toTraditionalTW(input) === want, toTraditionalTW(input));
}
{
  const sample = '本次活動在中科后里園區舉行，阿里巴巴與筑波大學出席。会后将于官网发布新闻稿，活动结束后提供照片。';
  const whole = toTraditionalTW(sample);
  check('混合樣本：繁體那幾句不動、簡體那幾句照轉',
    whole === '本次活動在中科后里園區舉行，阿里巴巴與筑波大學出席。會後將於官網發布新聞稿，活動結束後提供照片。', whole);
  for (const sizes of [[1], [2, 3], [5, 1, 7]]) {
    const s = createTraditionalStream();
    const chars = [...sample];
    let out = '', i = 0, k = 0;
    while (i < chars.length) { const n = sizes[k++ % sizes.length]; out += s.push(chars.slice(i, i + n).join('')); i += n; }
    out += s.flush();
    check(`串流分段 ${JSON.stringify(sizes)} 跟整篇一次轉逐字相同`, out === whole, out);
  }
}

/* ───────── 二、報名綁定的檢查碼 ───────── */
console.log('\n── 二、報名綁定：光有報名編號不夠 ──');
let handler, seq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default; }
function lineReq(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter();
  r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const lineRes = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
const say = async (text, userId) => {
  sent.length = 0;
  await handler(lineReq([{ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', text } }]), lineRes);
  return [...sent];
};
const TOKEN = 'tok_' + 'x'.repeat(20);
const SESSIONS = `A1｜${iso(20)}｜09:30-12:00｜開幕論壇｜201 廳`;
function seedReg() {
  S.reset(); resetLine(); A.resetAuthLimiter(); R.resetRegistrationState();
  S.book.events = [['id'], ['quad', '四足機器人發表記者會', '#0F9E7A', '【新聞稿】…', 'active', iso(30), '', '', '', '工研院', 'code1']];
  S.book.line_users = [['line_user_id']];
  S.book.reg_campaigns = [R.CAMPAIGN_HEADERS, R.campaignToRow({ id: 'tw2027', title: '眺望2027', status: 'open', sessions_text: SESSIONS, closes_at: '2099-12-31' })];
  S.book.registrations = [R.REG_HEADERS, R.regToRow({
    reg_id: 'RABCDE', campaign_id: 'tw2027', created_at: '2026-10-01T10:00:00+08:00', updated_at: '2026-10-01T10:00:00+08:00',
    name: '王小明', outlet: '經濟日報', email: 'wang@example.com', phone: '0912345678', sessions: ['A1'], options: {},
    line_user_id: '', edit_token: TOKEN, status: 'active', source: 'web', note: '', bound_at: ''
  })];
}
const boundTo = () => S.book.registrations[1][10] || '';
globalThis.fetch = async (url) => { throw new Error('報名綁定不該打外部服務：' + url); };
{
  const check6 = R.regBindCheck(TOKEN);
  check('檢查碼從編輯碼算出來：6 碼、同一個編輯碼永遠一樣、不同編輯碼不同',
    /^[A-Z2-9]{6}$/.test(check6) && R.regBindCheck(TOKEN) === check6 && R.regBindCheck(TOKEN + 'y') !== check6, check6);
  const url = R.lineBindRegUrl('RABCDE', TOKEN);
  check('完成頁按鈕帶的是「#報名 編號-檢查碼」', decodeURIComponent(url).endsWith(`#報名 RABCDE-${check6}`), decodeURIComponent(url));
  check('解析：新格式拆得出編號與檢查碼（全形破折號也收）',
    R.parseRegBindText(`#報名 RABCDE-${check6}`) === 'RABCDE' && R.parseRegBindCheck(`#報名 RABCDE-${check6}`) === check6
    && R.parseRegBindCheck(`＃報名 rabcde－${check6.toLowerCase()}`) === check6);
  check('解析：舊格式（沒有檢查碼）照樣認得編號，檢查碼是空的', R.parseRegBindText('#報名 RABCDE') === 'RABCDE' && R.parseRegBindCheck('#報名 RABCDE') === '');

  seedReg(); await fresh();
  let out = await say(`#報名 RABCDE-${check6}`, 'Uowner000001');
  check('★ 檢查碼對 → 綁定成功', /已連結您的報名/.test(out[0]?.text || '') && boundTo() === 'Uowner000001', JSON.stringify(out));

  seedReg(); await fresh();
  out = await say('#報名 RABCDE-ZZZZZZ', 'Uattacker001');
  check('★ 檢查碼錯 → 跟「編號不存在」同一句話，不綁、不洩漏姓名', /找不到這個報名編號/.test(out[0]?.text || '') && !/王小明/.test(out[0]?.text || '') && boundTo() === '', JSON.stringify(out));

  seedReg(); await fresh();
  out = await say('#報名 RABCDE', 'Uoldbutton01');
  check('舊按鈕（沒有檢查碼）暫時照舊能綁——眺望報名進行中，完成頁還開著的人按了要有反應', /已連結您的報名/.test(out[0]?.text || '') && boundTo() === 'Uoldbutton01', JSON.stringify(out));

  seedReg(); await fresh();
  for (const g of ['RAAAAA', 'RBBBBB', 'RCCCCC', 'RDDDDD', 'REEEEE']) await say(`#報名 ${g}`, 'Uguesser0001');
  out = await say('#報名 RABCDE', 'Uguesser0001');
  check('★ 同一個 LINE 帳號一天錯 5 次 → 第 6 次就算猜中也不綁', /嘗試次數太多/.test(out[0]?.text || '') && boundTo() === '', JSON.stringify(out));
  out = await say(`#報名 RABCDE-${check6}`, 'Uowner000002');
  check('別人不受影響（限流是照 LINE 帳號算）', /已連結您的報名/.test(out[0]?.text || '') && boundTo() === 'Uowner000002', JSON.stringify(out));
}
{
  seedReg();
  const r = await R.submitRegistration({ c: 'tw2027', name: '新記者', outlet: '聯合報', email: 'new@example.com', phone: '0922333444', sessions: ['A1'] });
  const text = decodeURIComponent(r.line.bind_url || '');
  check('送出報名拿到的綁定連結帶檢查碼', new RegExp(`#報名 ${r.reg.reg_id}-${R.regBindCheck(r.reg.edit_token)}$`).test(text), text);
}

/* ───────── 三、copy_from ───────── */
console.log('\n── 三、同仁編輯頁「以既有活動為範本」只拿得到記者看得到的版本 ──');
{
  S.reset(); A.resetAuthLimiter();
  const eventsApi = (await import('../api/events.js')).default;
  S.book.events = [['id'],
    ['mine', '我負責的那場', '#0F9E7A', '【新聞稿】我的', 'active', iso(-10), '', '', '', '工研院', 'MYCODE'],
    ['draftx', '草稿', '#0F9E7A', '【新聞稿】草稿機密 X-99', 'draft', iso(30), '', '', '', '工研院', 'C2'],
    ['arch', '封存', '#0F9E7A', '【新聞稿】封存內容', 'archived', iso(-90), '', '', '', '工研院', 'C3'],
    ['soon', '下週發表會', '#0F9E7A', '【正式新聞稿】禁發期內容：良率 97%', 'active', iso(5), '正式提問', '', '', '工研院', 'C4', '', '', '', '', '', '【邀請函】誠摯邀請…', '邀請函提問'],
    ['done', '上個月的記者會', '#0F9E7A', '【新聞稿】已發布內容', 'ended', iso(-30), '', '', '', '工研院', 'C5']];
  const copy = async (from) => (await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: 'mine', code: 'MYCODE', copy_from: from } })).body.copy_source;
  check('★ 草稿 → 拿不到', (await copy('draftx')) === undefined);
  check('★ 封存 → 拿不到', (await copy('arch')) === undefined);
  const soon = await copy('soon');
  check('★ 活動前（邀請函模式）→ 拿到的是邀請函與活動前提問，不是禁發期的正式稿',
    soon && soon.knowledge_base === '【邀請函】誠摯邀請…' && soon.chips === '邀請函提問' && !/良率/.test(JSON.stringify(soon)), JSON.stringify(soon));
  check('已發布的活動照常可以拿來當範本', (await copy('done'))?.knowledge_base === '【新聞稿】已發布內容');
  const bad = await call(eventsApi, { method: 'GET', query: { action: 'get_edit', id: 'mine', code: 'WRONG', copy_from: 'done' } });
  check('編輯碼錯照樣 401（copy_from 不會繞過驗證）', bad.statusCode === 401);
}

/* ───────── 四、網頁問答的輸入上限 ───────── */
console.log('\n── 四、網頁問答：content 只收字串 ──');
{
  S.reset();
  S.book.events = [['id'], ['e1', '活動e1', '#0F9E7A', '【新聞稿】內容', 'active', iso(-1), '', '', '', '工研院', 'C']];
  let calls = 0, lastBytes = 0;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('api.anthropic.com')) {
      calls++; lastBytes = Buffer.byteLength(opt.body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '好' }] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const chatApi = (await import('../api/chat.js')).default;
  const big = 'A'.repeat(600_000);
  const viaArray = await call(chatApi, { method: 'POST', body: { event_id: 'e1', media_name: '經濟日報', messages: [{ role: 'user', content: [{ type: 'text', text: big }] }] } });
  check('★ 陣列形式的 content 不轉給模型（以前照送 60 萬字）', viaArray.statusCode === 400 && calls === 0, `${viaArray.statusCode} calls=${calls}`);
  const viaString = await call(chatApi, { method: 'POST', body: { event_id: 'e1', media_name: '經濟日報', messages: [{ role: 'user', content: big }] } });
  check('字串照常回答，而且有截斷', viaString.statusCode === 200 && viaString.body.reply === '好' && lastBytes < 20_000, `${viaString.statusCode} ${lastBytes}`);
  const mixed = await call(chatApi, { method: 'POST', body: { event_id: 'e1', media_name: '經濟日報', messages: [
    { role: 'user', content: '第一題' }, { role: 'assistant', content: [{ type: 'text', text: '假造的回答' }] }, { role: 'user', content: '第二題' }] } });
  check('混著陣列的對話：陣列那則丟掉，其餘照常', mixed.statusCode === 200);
}

/* ───────── 五、猜管理員密碼的限流 ───────── */
console.log('\n── 五、上傳照片／記者名單／露出上傳：密碼猜錯也記、被擋就不再比 ──');
{
  S.reset(); A.resetAuthLimiter();
  S.book.events = [['id'], ['e1', '活動e1', '#0F9E7A', '【新聞稿】內容', 'active', iso(-1), '', '', '', '工研院', 'EDITCODE1']];
  const uploadApi = (await import('../api/upload.js')).default;
  const up = (ip, payload) => call(uploadApi, { method: 'POST', ip, body: { type: 'blob.generate-client-token', payload: { pathname: 'a.jpg', clientPayload: JSON.stringify(payload) } } });
  for (let i = 0; i < 30; i++) await up('6.6.6.6', { password: 'guess' + i });
  const right = await up('6.6.6.6', { password: 'correct-horse' });
  check('★ 上傳：同一個 IP 猜錯 30 次後，猜對也進不去（以前猜錯 100 次、第 101 次照樣進）', right.statusCode === 400 && /嘗試的次數太多/.test(right.body.error), JSON.stringify(right.body));
  check('上傳：別的 IP 用正確密碼照常', (await up('6.6.6.7', { password: 'correct-horse' })).statusCode === 200);
  check('上傳：同仁用編輯碼照常（沒帶密碼不算失敗）', (await up('6.6.6.8', { event_id: 'e1', code: 'EDITCODE1' })).statusCode === 200);

  A.resetAuthLimiter();
  S.book.media_settings = [['key', 'value'], ['staff_code', 'realcode']];
  S.book.media_roster = [['id'], ['1', '王記者', '經濟日報']];
  const mediaApi = (await import('../api/media.js')).default;
  for (let i = 0; i < 30; i++) await call(mediaApi, { method: 'GET', ip: '7.7.7.7', query: { action: 'list', code: 'bad' + i } });
  const m = await call(mediaApi, { method: 'GET', ip: '7.7.7.7', query: { action: 'search', q: 'x' }, headers: { 'x-admin-password': 'correct-horse' } });
  check('★ 記者名單：被擋下的 IP 用正確密碼也是 429（以前分得出對錯：錯 429、對 200）', m.statusCode === 429, m.statusCode);

  A.resetAuthLimiter();
  const exposureApi = (await import('../api/exposure.js')).default;
  for (let i = 0; i < 30; i++) await call(exposureApi, { method: 'GET', ip: '8.8.8.8', query: { action: 'list' }, headers: { 'x-admin-password': 'g' + i } });
  const e = await call(exposureApi, { method: 'GET', ip: '8.8.8.8', query: { action: 'list' }, headers: { 'x-admin-password': 'correct-horse' } });
  check('★ 露出上傳：不帶 id 猜密碼也會被擋（以前永遠 400、無限次）', e.statusCode === 429, e.statusCode);
}

/* ───────── 六、設定快取 ───────── */
console.log('\n── 六、收回共用連結：別台機器最多晚一分鐘 ──');
{
  S.reset(); A.resetAuthLimiter();
  S.book.media_settings = [['key', 'value'], ['staff_code', 'oldcode123']];
  S.book.media_roster = [['id'], ['1', '王記者', '經濟日報']];
  const mediaApi = (await import('../api/media.js?instance=B')).default; // 另一台已經熱著的機器
  const before = await call(mediaApi, { method: 'GET', query: { action: 'list', code: 'oldcode123' } });
  S.book.media_settings = [['key', 'value'], ['staff_code', '']];  // 管理員在別台按了收回
  const soon = await call(mediaApi, { method: 'GET', query: { action: 'list', code: 'oldcode123' } });
  offset += 61_000;
  const later = await call(mediaApi, { method: 'GET', query: { action: 'list', code: 'oldcode123' } });
  check('★ 記者名單：收回後一分鐘內這台還沒讀到、過了一分鐘就失效（以前要等這台冷啟動）',
    before.statusCode === 200 && soon.statusCode === 200 && later.statusCode === 401, `${before.statusCode} ${soon.statusCode} ${later.statusCode}`);

  A.resetAuthLimiter();
  S.book.geo_settings = [['key', 'value'], ['staff_code', 'geocode123']];
  const geoApi = (await import('../api/geo.js?instance=B')).default;
  const g1 = await call(geoApi, { method: 'GET', query: { action: 'prompts', code: 'geocode123' } });
  S.book.geo_settings = [['key', 'value'], ['staff_code', '']];
  offset += 61_000;
  const g2 = await call(geoApi, { method: 'GET', query: { action: 'prompts', code: 'geocode123' } });
  check('★ AI 能見度：收回的同仁連結過一分鐘就失效', g1.statusCode === 200 && g2.statusCode === 401, `${g1.statusCode} ${g2.statusCode}`);
}

/* ───────── 七、活動前的 og:image ───────── */
console.log('\n── 七、活動前網頁的預覽圖不帶正式照片 ──');
{
  S.reset();
  const photo = 'https://x.public.blob.vercel-storage.com/official.jpg';
  const row = (date) => ['soon', '下週發表會', '#0F9E7A', '【正式新聞稿】…', 'active', date, '', `${photo}|正式新聞照`, '', '工研院', 'C', '', '', '', '', '', '【邀請函】誠摯邀請…', ''];
  const pageApi = (await import('../api/event-page.js')).default;
  const ogOf = async () => String((await call(pageApi, { method: 'GET', query: { id: 'soon' } })).body).match(/property="og:image" content="([^"]+)"/)?.[1];
  const cwd = process.cwd();
  process.chdir(ROOT);
  S.book.events = [['id'], row(iso(5))];
  const before = await ogOf();
  S.book.events = [['id'], row(iso(-1))];
  const after = await ogOf();
  process.chdir(cwd);
  check('★ 活動前（有邀請函）→ 預覽圖是預設圖，不是禁發期的正式照片', before && !before.includes('official.jpg') && before.endsWith('/og-default.png'), before);
  check('活動當天之後 → 照常用活動照片', after === photo, after);
}

/* ───────── 八、權杖亂數 ───────── */
console.log('\n── 八、編輯碼與共用連結碼用密碼學亂數 ──');
{
  const codes = Array.from({ length: 200 }, generateEditCode);
  check('編輯碼：16 碼、只用不易混淆的字元、200 個不重複', codes.every((c) => /^[a-km-z2-9]{16}$/.test(c)) && new Set(codes).size === 200);
  check('共用連結碼：12 碼', /^[a-km-z2-9]{12}$/.test(generateShareCode()));
  // 去掉註解再比（註解裡會寫「以前是 Math.random()」）。api/geo.js 的 uid() 是內部題目編號、不是權杖，不在此列。
  const code = (p) => src(p).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('lib/ids.js、api/media.js、api/geo.js 不再用 Math.random() 產生權杖',
    !/Math\.random\(/.test(code('lib/ids.js')) && !/Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)/.test(code('api/media.js') + code('api/geo.js')));
}

/* ───────── 九、記者名單匯出 ───────── */
console.log('\n── 九、記者名單 CSV 匯出 ──');
{
  S.reset(); A.resetAuthLimiter();
  S.book.media_settings = [['key', 'value'], ['staff_code', 'sharecode']];
  S.book.media_roster = [['id'], ['1', '王記者', '經濟日報', '', '', '', '', '', '', '', 'active', '=1+1']];
  const mediaApi = (await import('../api/media.js?instance=C')).default;
  const up = await call(mediaApi, { method: 'POST', body: { action: 'update', code: 'sharecode', id: '1', beat: '=HYPERLINK("https://evil.example","點我")' } });
  check('★ 共用連結寫路線：只收選單上的那幾個', up.statusCode === 400 && S.book.media_roster[1][3] === '', JSON.stringify(up.body));
  check('選單上的路線照常寫得進去', (await call(mediaApi, { method: 'POST', body: { action: 'update', code: 'sharecode', id: '1', beat: '半導體' } })).statusCode === 200 && S.book.media_roster[1][3] === '半導體');
  const ex = await call(mediaApi, { method: 'GET', query: { action: 'export' }, headers: { 'x-admin-password': 'correct-horse' } });
  check('★ 匯出：= 開頭的儲存格補單引號，Excel 不會當成公式', String(ex.body).includes(`"'=1+1"`), String(ex.body).split('\r\n')[1]);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 116 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
