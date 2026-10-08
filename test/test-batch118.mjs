// 批次 118（業發處第 0 步）的活動那一半：活動類型選「企業說明會／技術媒合會／客戶參訪／技術交流會」＝企業場。
//   一、判斷與清單（lib/audience.js 與後台頁面的清單一字不差）
//   二、出口擋報價：背景資料沒有的金額，整則換成固定回覆；沒問題的補免責句
//   三、企業版 prompt：記者版逐 byte 不變
//   四、LINE：企業場不在記者的活動清單、不被帶進別場的答案；接上企業場問公司、答案過出口檢查
//   五、網頁問答：企業場不串流（要先整則檢查），答案過出口檢查
//   六、公開出口：公開列表、copy_from、搜尋引擎（noindex、sitemap）都沒有企業場
//   七、統計：企業場的問答不算進服務媒體家數與媒體排行
// 跑的是真的 api/*.js 與 lib/*.js；Sheets、LINE、模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

register('./loader.mjs', import.meta.url);
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.ADMIN_PASSWORD = 'pw';

const F = await import('./fakes.mjs');
const { sent, state, reset, isoOffset, sheets } = F;
const A = await import('../lib/audience.js');
const P = await import('../lib/prompt.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 企業場：A id、B 名稱、D 知識庫、E 狀態、F 日期、K 代碼、N 活動類型、O 聯絡窗口
const BIZ = ['biz', '智慧製造產線技術說明會', '#0F9E7A', '【技術說明】產線熱管理模組XJ9：計畫總經費新台幣 3 億元，適用 CNC 與射出成型產線。',
  'active', isoOffset(5), '', '', '', '工研院', 'bizcode', '14:00', '工研院中興院區', '企業說明會', '業務窗口 林小姐 03-5912345', '', '', ''];
const seed = (over = {}) => { reset(); state.events.push(Object.assign([...BIZ], over)); };

/* ───────── 一、判斷與清單 ───────── */
console.log('\n── 一、哪些算企業場 ──');
check('四種活動類型＝企業場（前後空白不影響）', A.BUSINESS_EVENT_TYPES.every((t) => A.isBusinessEvent(t) && A.isBusinessEvent({ event_type: ` ${t} ` })));
check('　 記者會、發表會、參訪、空白都不是（猜錯的方向是把記者會藏起來，所以用明確清單）', !['記者會', '發表會', '參訪', '', '企業記者會'].some((t) => A.isBusinessEvent(t)));
{
  const idx = read('public/index.html');
  const inline = (idx.match(/const business = \[([^\]]*)\]\.includes/) || [])[1] || '';
  const list = [...inline.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('★ 後台活動卡的企業場清單跟 lib/audience.js 一字不差（瀏覽器端不能 import，兩份不准漂開）', JSON.stringify(list) === JSON.stringify(A.BUSINESS_EVENT_TYPES), JSON.stringify(list));
  for (const f of ['public/index.html', 'public/edit.html']) {
    const dl = (read(f).match(/<datalist id="type-list">([\s\S]*?)<\/datalist>/) || [])[1] || '';
    check(`　 ${f} 的活動類型下拉選單列了四種企業場，也寫了選了會怎樣`, A.BUSINESS_EVENT_TYPES.every((t) => dl.includes(`value="${t}"`)) && /不在米亞給記者的活動清單裡/.test(read(f)));
  }
}

/* ───────── 二、出口擋報價 ───────── */
console.log('\n── 二、出口擋報價 ──');
{
  const kb = BIZ[3];
  const f = (a) => A.findUnlistedAmounts(a, kb);
  check('★ 背景資料沒有的金額 → 抓出來（授權金、報價、中文數字、美金）',
    f('授權金大約 500 萬元').length === 1 && f('授權金約 500 萬，可以再談').length === 1 && f('每片報價 120 元').length === 1
    && f('設備一台約三百萬元').length === 1 && f('US$1.2M per license').length === 1 && f('技轉費用：新臺幣１，２００萬元').length === 1);
  check('　 背景資料寫明的公開數字照引不算（3 億元、新台幣3億元、3 億）', f('計畫總經費 3 億元').length === 0 && f('總經費新台幣3億元').length === 0 && f('總經費約 3 億').length === 0);
  check('　 技術名詞不是錢：「三元正極材料」「二元化合物」「元件」「2026年」', f('三元正極材料與二元化合物半導體的元件，2026年量產').length === 0);
  const ev = { id: 'biz', knowledge_base: kb, organizer: '工研院', press_contact: '業務窗口 林小姐 03-5912345' };
  const blocked = A.guardBusinessAnswer('這項技術的授權金大約 500 萬元，三個月內可以導入。', ev);
  check('★ 擋下來的整則換成固定回覆：講清楚不能報價、給活動窗口、不留原本的數字',
    blocked.blocked.length === 1 && /不能代為報價或承諾/.test(blocked.text) && /林小姐/.test(blocked.text) && !/500/.test(blocked.text), blocked.text);
  const okAns = A.guardBusinessAnswer('這套模組主要用在 CNC 產線的熱管理。', ev);
  check('　 沒問題的答案原文照給，最後補一行免責句', okAns.blocked.length === 0 && okAns.text.startsWith('這套模組主要用在 CNC') && /不構成報價或合作承諾/.test(okAns.text), okAns.text);
  check('　 模型自己寫了免責句就不重複', (A.withBusinessDisclaimer('重點如上。\n\n內容僅供參考，不構成報價或合作承諾。').match(/不構成報價/g) || []).length === 1);
  check('　 英文答案補英文的免責句、擋下來也回英文', /not a quotation/.test(A.withBusinessDisclaimer('It is used for thermal management.'))
    && /can't quote/.test(A.guardBusinessAnswer('The license fee is about US$50K.', ev).text));
}

/* ───────── 三、企業版 prompt ───────── */
console.log('\n── 三、企業版 prompt ──');
{
  const media = { name: '半導體發表會', knowledge_base: 'kb', organizer: '工研院', event_type: '記者會' };
  check('★ 記者場：systemPromptFor() 跟原本的 buildSystemPrompt() 逐 byte 相同（網頁版吃快取的那一塊不能走鐘）',
    P.systemPromptFor(media, ['規則X']) === P.buildSystemPrompt(media, ['規則X']) && P.systemPromptFor({ name: 'Y', knowledge_base: 'kb' }) === P.buildSystemPrompt({ name: 'Y', knowledge_base: 'kb' }));
  const biz = P.systemPromptFor({ name: '說明會', knowledge_base: 'kb', organizer: '工研院', event_type: '企業說明會' }, ['規則X']);
  check('　 企業場：技術說明助理、不報價不承諾、結尾免責句、頻道規則照樣插得進去',
    /AI 技術說明助理/.test(biz) && /不要報價/.test(biz) && /不構成報價或合作承諾/.test(biz) && biz.includes('- 規則X') && !/媒體記者/.test(biz) && biz.includes('<資料開始>\nkb'));
}

/* ───────── 四、LINE ───────── */
console.log('\n── 四、LINE ──');
let handler, seq = 0;
const fresh = async () => { handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
const lineRes = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function lineReq(text, userId) {
  const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', text } }] });
  const r = new EventEmitter();
  r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const say = async (text, userId) => { sent.length = 0; await handler(lineReq(text, userId), lineRes); return [...sent]; };
const shown = (out) => out.filter((s) => s.kind === 'text' || s.kind === 'flex').map((s) => s.text || JSON.stringify(s.messages || '')).join('\n');
{
  seed(); await fresh();
  const cal = shown(await say('最近有哪些活動', 'U_r1'));
  check('★ 記者問「最近有哪些活動」：清單裡沒有企業場（客戶參訪的活動名稱常常就是客戶的名字）',
    cal.includes('智慧醫療解決方案記者會') && !cal.includes(BIZ[1]), cal.slice(0, 400));

  const bind = shown(await say('#biz', 'U_b1'));
  check('★ 用 #代碼 接上企業場：問「哪家公司或單位」，不問媒體', /哪家公司或單位/.test(bind) && !/哪家媒體/.test(bind), bind);
  await say('略過', 'U_b1');
  state.answerText = '這項技術的授權金大約 500 萬元，三個月內可以導入。';
  let out = await say('授權金大概多少？', 'U_b1');
  const call = out.find((s) => s.kind === 'answer');
  check('　 答題用企業版的規則（技術說明助理），不是記者版', call && /AI 技術說明助理/.test(call.sys) && !/專門服務前來採訪的媒體記者/.test(call.sys), call && call.sys.slice(0, 120));
  check('★ 模型報了背景資料沒有的價 → 記者看到的是固定回覆，不是那個數字', /不能代為報價或承諾/.test(shown(out)) && !/500 萬/.test(shown(out)) && /林小姐/.test(shown(out)), shown(out));
  state.answerText = '這套模組主要用在 CNC 與射出成型產線的熱管理。';
  out = await say('這個模組用在哪裡？', 'U_b1');
  check('　 正常的答案照給，結尾補上免責句', /CNC 與射出成型/.test(shown(out)) && /不構成報價或合作承諾/.test(shown(out)), shown(out));
  {
    // 企業場的 LINE 問答也走另一把金鑰（有設的話）；記者場照舊
    const stub = globalThis.fetch;
    const keys = [];
    globalThis.fetch = async (u, o) => { if (String(u).includes('api.anthropic.com') && /【本次活動背景資料】/.test(o.body)) keys.push(o.headers['x-api-key']); return stub(u, o); };
    process.env.ANTHROPIC_API_KEY_BUSINESS = 'biz-key';
    await say('這個模組用在哪裡？', 'U_b1');
    globalThis.fetch = stub;
    delete process.env.ANTHROPIC_API_KEY_BUSINESS;
    check('　 LINE 企業場的答題也用 ANTHROPIC_API_KEY_BUSINESS', keys.length === 1 && keys[0] === 'biz-key', JSON.stringify(keys));
  }
  state.answerText = '本計畫總經費新台幣 3 億元。';
  out = await say('計畫經費多少？', 'U_b1');
  check('　 背景資料寫明的公開數字照常回答（不是報價）', /3 億元/.test(shown(out)) && !/不能代為報價/.test(shown(out)), shown(out));

  const pickOut = await say(`給我《${BIZ[1]}》的完整新聞稿`, 'U_r9');
  const leaked = pickOut.find((s) => s.kind === 'answer' && (s.sys || '').includes('熱管理模組XJ9'));
  check('　 照「給我《活動名稱》的完整新聞稿」的格式自己打企業場的名字 → 不拿企業場的資料回答', !leaked, shown(pickOut).slice(0, 200));

  // 跨場次：綁在記者場、問的東西只有企業場的知識庫有
  state.answerText = '';
  await say('#semi', 'U_r2'); await say('略過', 'U_r2');
  out = await say('熱管理模組XJ9 有哪些應用？', 'U_r2');
  const c1 = out.find((s) => s.kind === 'answer');
  check('★ 記者的問題不會把企業場的知識庫帶進答案（跨場次挑選不看企業場）', c1 && !(c1.sysAll || '').includes('XJ9'), c1 && (c1.sysAll || '').slice(-300));
  seed({ 13: '記者會' }); await fresh();
  await say('#semi', 'U_r3'); await say('略過', 'U_r3');
  out = await say('熱管理模組XJ9 有哪些應用？', 'U_r3');
  const c2 = out.find((s) => s.kind === 'answer');
  check('　 （對照）同一場改成記者會，同一題就會被帶進來——上一項不是因為根本挑不到', c2 && (c2.sysAll || '').includes('XJ9'), c2 && (c2.sysAll || '').slice(-300));
  state.answerText = '';
}
{
  const { formatEventAnalyticsReply } = await import('../lib/staff.js');
  const s = { eventId: 'biz', eventName: BIZ[1], total: 3, webCount: 2, lineCount: 1, mediaCount: 2, recentQuestions: [] };
  check('LINE 職員「數據」：企業場寫「服務單位」，記者場照舊「服務媒體」',
    /服務單位：2 家/.test(formatEventAnalyticsReply({ ...s, business: true })) && /服務媒體：2 家/.test(formatEventAnalyticsReply(s)));
}

/* ───────── 五、網頁問答 ───────── */
console.log('\n── 五、網頁問答 ──');
{
  seed();
  const stub = globalThis.fetch;
  let last = null, lastKey = '';
  globalThis.fetch = async (u, o) => { if (String(u).includes('api.anthropic.com')) { last = JSON.parse(o.body); lastKey = o.headers['x-api-key']; } return stub(u, o); };
  const chat = (await import('../api/chat.js')).default;
  const mkRes = () => {
    const r = { statusCode: 200, headers: {}, chunks: [] };
    r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r);
    r.status = (c) => (r.statusCode = c, r);
    r.json = (o) => (r.body = o, r);
    r.write = (c) => (r.chunks.push(c), true);
    r.end = () => r; r.flushHeaders = () => {};
    return r;
  };
  const ask = async (eventId, q, stream, ip) => {
    const res = mkRes();
    await chat({ method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {},
      body: { messages: [{ role: 'user', content: q }], event_id: eventId, media_name: '某某精密', stream, client_id: 'c' + ip } }, res);
    return res;
  };
  state.answerText = '授權金大約 500 萬元。';
  let r = await ask('biz', '授權金多少？', true, '10.9.0.1');
  check('★ 企業場：前台要串流也不串流（字一送出去就收不回來，要先整則過出口檢查）',
    last && last.stream === false && r.body && typeof r.body.reply === 'string' && !String(r.headers['content-type'] || '').includes('event-stream'), JSON.stringify({ stream: last && last.stream, body: r.body }));
  check('　 用企業版的規則，報價被換成固定回覆', /AI 技術說明助理/.test(last.system[0].text) && /不能代為報價或承諾/.test(r.body.reply) && !/500/.test(r.body.reply), r.body.reply);
  state.answerText = '主要用在 CNC 產線。';
  r = await ask('biz', '用在哪裡？', true, '10.9.0.2');
  check('　 正常答案補上免責句', /主要用在 CNC 產線/.test(r.body.reply) && /不構成報價或合作承諾/.test(r.body.reply), r.body.reply);
  r = await ask('semi', '重點是什麼？', false, '10.9.0.3');
  check('　 記者場不受影響：記者版規則、沒有企業場的免責句', /AI 新聞助理/.test(last.system[0].text) && !/不構成報價/.test(r.body.reply || ''), r.body && r.body.reply);
  process.env.ANTHROPIC_API_KEY_BUSINESS = 'biz-key';
  await ask('biz', '用在哪裡？', true, '10.9.0.4');
  const bizKey = lastKey;
  await ask('semi', '重點是什麼？', false, '10.9.0.5');
  check('★ 設了 ANTHROPIC_API_KEY_BUSINESS：企業場用那一把（費用與每月上限跟記者分開），記者場照舊用原本那把',
    bizKey === 'biz-key' && lastKey === 'test', `${bizKey} / ${lastKey}`);
  delete process.env.ANTHROPIC_API_KEY_BUSINESS;
  globalThis.fetch = stub;
  state.answerText = '';
}

/* ───────── 六、公開出口 ───────── */
console.log('\n── 六、公開出口沒有企業場 ──');
{
  seed();
  const events = (await import('../api/events.js')).default;
  const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.send = (b) => (r.body = b, r); r.end = () => r; return r; };
  const get = async (query) => { const r = res(); await events({ method: 'GET', headers: {}, query, socket: {} }, r); return r; };
  const list = await get({});
  check('★ 公開活動列表（免登入）沒有企業場', list.statusCode === 200 && list.body.events.some((e) => e.id === 'semi') && !list.body.events.some((e) => e.id === 'biz'));
  const gp = await get({ action: 'get_public', id: 'biz' });
  check('　 拿得到網址的人照樣打得開企業場的活動頁（audience=business，前台切成企業的字樣）', gp.statusCode === 200 && gp.body.event.audience === 'business' && (await get({ action: 'get_public', id: 'semi' })).body.event.audience === 'media');
  const semiCode = state.events.find((e) => e[0] === 'semi')[10];
  const cp = await get({ action: 'get_edit', id: 'semi', code: semiCode, copy_from: 'biz' });
  const cpOk = await get({ action: 'get_edit', id: 'semi', code: semiCode, copy_from: 'med' });
  check('★ 拿記者場的編輯連結 copy_from 企業場 → 不給（給客戶看的內容不能被別場的編輯連結拿走）', cp.statusCode === 200 && !cp.body.copy_source && cpOk.body.copy_source && cpOk.body.copy_source.id === 'med', JSON.stringify(cp.body.copy_source));

  seed({ 4: 'ended', 5: '2026-01-15' });
  const page = (await import('../api/event-page.js')).default;
  const ssr = async (query) => { const r = res(); await page({ method: 'GET', headers: {}, query }, r); return r; };
  const biz = await ssr({ id: 'biz' });
  const quad = await ssr({ id: 'quad' });
  check('★ 已結束的企業場：noindex、不出新聞稿全文與 NewsArticle（那是給與會企業看的資料，不是新聞稿）',
    /noindex/.test(String(biz.body)) && /noindex/.test(String(biz.headers['X-Robots-Tag'] || '')) && !/NewsArticle/.test(String(biz.body)) && !/熱管理模組XJ9/.test(String(biz.body)));
  check('　 （對照）已結束的記者會照樣給搜尋引擎收錄', /index, follow/.test(String(quad.body)) && /NewsArticle/.test(String(quad.body)));
  const map = await ssr({ _r: 'sitemap' });
  check('　 sitemap 沒有企業場', /id=quad/.test(String(map.body)) && !/id=biz/.test(String(map.body)), String(map.body).slice(0, 300));
}

/* ───────── 七、統計 ───────── */
console.log('\n── 七、統計：企業場不算進媒體數字 ──');
{
  seed();
  // qa_log：A 時間 B 活動 C 名稱 D 媒體 E 問題 F 回答 G 刪除 H 來源 I 姓名
  const QA = [
    ['t1', 'semi', '半導體', '經濟日報', '問題一', '答', '', 'web', ''],
    ['t2', 'semi', '半導體', '聯合報', '問題二', '答', '', 'line', ''],
    ['t3', 'biz', BIZ[1], '某某精密', '授權金多少', '答', '', 'web', ''],
    ['t4', 'biz', BIZ[1], '另一家科技', '應用場域', '答', '', 'web', '']
  ];
  const col = (c) => c.charCodeAt(0) - 65;
  const realRead = sheets.readRange;
  sheets.readRange = async (range) => {
    const m = range.match(/^qa_log!([A-I])2:([A-I])$/);
    if (m) return QA.map((r) => r.slice(col(m[1]), col(m[2]) + 1));
    return realRead(range);
  };
  const analytics = (await import('../api/analytics.js')).default;
  const call = async (query) => {
    const r = { statusCode: 200, headers: {} };
    r.setHeader = (k, v) => (r.headers[k] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r);
    await analytics({ method: 'GET', headers: { 'x-admin-password': 'pw' }, query, socket: {} }, r);
    return r;
  };
  const all = await call({ summary: '1' });
  const b = all.body || {};
  check('★ 服務媒體家數只算記者場（2 家，不是 4 家）；問答總數照算', all.statusCode === 200 && b.media_total === 2 && b.total === 4 && b.business_qa === 2, JSON.stringify(b).slice(0, 300));
  check('　 企業場那一筆標 audience=business（成效報告不列它）', b.by_event.find((e) => e.event_id === 'biz').audience === 'business' && b.by_event.find((e) => e.event_id === 'semi').audience === 'media');
  const full = await call({});
  check('　 媒體排行沒有企業', !(full.body.top_media || []).some((m) => /某某精密|另一家科技/.test(m.name)), JSON.stringify(full.body.top_media));
  const one = await call({ summary: '1', event_id: 'biz' });
  check('　 單看企業場：一樣數得出幾家單位（畫面上改叫「單位」）', one.body.audience === 'business' && one.body.media_total === 2, JSON.stringify(one.body).slice(0, 200));
  sheets.readRange = realRead;
  const report = read('public/report.html');
  check('　 成效報告濾掉企業場、註明有幾題沒算進來', /filter\(e => e\.audience !== 'business'\)/.test(report) && /business_qa/.test(report));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 118（企業場）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
