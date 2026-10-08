// 批次 117：上一輪檢討列為「建議調整」、朱朱說「也幫我改」的幾件事。
//   一、Sheets 重送：讀取與整格覆寫照舊重試；加一列、刪列／加分頁只在「確定沒寫進去」時重試
//   二、qa_log 只讀需要的欄位：一次 batchGet 讀 A:E 與 G:I，跳過 AI 回答全文（F 欄）
//   三、只有範本的知識庫不算「有資料」（行事曆清單、活動列表的 has_kb）
//   四、AI 用量紀錄：每一次呼叫模型留一行 [ai-usage]，看得出哪一條路沒吃到快取
//   五、LINE 同一則事件（webhookEventId）不回兩次
//   六、api/line.js 拆檔：入口留在原處，各條路搬進 lib/line-*.js，依賴只往一個方向走
// 一、二跑真的 lib/sheets.js（Google 那端換成假的 fetch）；三之後掛 loader-reg（假試算表＋假 LINE）。
import { register } from 'node:module';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const iso = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

/* ───────── 一、Sheets 重送規則 ───────── */
console.log('\n── 一、Sheets 重送：不是每一種請求都能重送 ──');
process.env.GOOGLE_SPREADSHEET_ID = 'MAINSHEET';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'bot@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey;

const net = { calls: [], script: [] };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failWith = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) return jsonRes(200, { access_token: 'AT', expires_in: 3600 });
  net.calls.push({ url: u, method: opts.method || 'GET' });
  const step = net.script.shift();
  if (step === undefined) return jsonRes(200, {});
  if (step instanceof Error || step instanceof DOMException) throw step;
  return jsonRes(step.status, step.body ?? (step.status >= 400 ? { error: { message: `HTTP ${step.status}` } } : {}));
};
// 重試的間隔（0.5／1.5／3 秒）在測試裡不用真的等
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, 0, ...a);

const SH = await import('../lib/sheets.js');
const QA = await import('../lib/qa-log.js');
async function attempt(fn, script) {
  net.calls.length = 0;
  net.script = [...script];
  try { return { ok: true, value: await fn(), n: net.calls.length }; } catch (e) { return { ok: false, err: e, n: net.calls.length }; }
}

{
  let r = await attempt(() => SH.readRange('events!A2:R'), [{ status: 500 }, { status: 200, body: { values: [['e1']] } }]);
  check('讀取：Google 回 500 → 重試一次就拿到資料（讀幾次都一樣，照舊重試）', r.ok && r.n === 2 && r.value[0][0] === 'e1', JSON.stringify(r));
  r = await attempt(() => SH.readRange('events!A2:R'), [failWith('ECONNRESET'), { status: 200, body: { values: [] } }]);
  check('　 讀取：連線中途斷掉 → 照樣重試', r.ok && r.n === 2, JSON.stringify(r));
  r = await attempt(() => SH.updateRange('events!D2', [['x']]), [{ status: 500 }, { status: 200 }]);
  check('　 整格覆寫（updateRange）：500 → 重試（寫兩次結果一樣）', r.ok && r.n === 2 && net.calls.every((c) => c.method === 'PUT'), JSON.stringify(r));

  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t', 'e1']]), [{ status: 500 }, { status: 200 }]);
  check('★ 加一列（appendRows）：500 → 不重送，直接往外拋（第一次可能已經寫進去，重送就多一列重複的問答）',
    !r.ok && r.n === 1, JSON.stringify({ n: r.n, err: r.err?.message }));
  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t']]), [timeoutErr(), { status: 200 }]);
  check('★ 加一列：逾時 → 不重送（Google 可能只是回得慢，資料已經寫進去了）', !r.ok && r.n === 1, JSON.stringify({ n: r.n, err: r.err?.name }));
  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t']]), [failWith('ECONNRESET'), { status: 200 }]);
  check('　 加一列：連線中途斷掉 → 不重送', !r.ok && r.n === 1, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t']]), [{ status: 429 }, { status: 200 }]);
  check('　 加一列：429（配額用完，Google 根本沒處理）→ 重試', r.ok && r.n === 2, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t']]), [{ status: 503 }, { status: 200 }]);
  check('　 加一列：503（服務暫時不可用）→ 重試', r.ok && r.n === 2, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.appendRows('qa_log!A:H', [['t']]), [failWith('ENOTFOUND'), { status: 200 }]);
  check('　 加一列：連線根本沒建立（DNS 失敗）→ 重試', r.ok && r.n === 2, JSON.stringify({ n: r.n }));

  r = await attempt(() => SH.batchUpdate([{ deleteDimension: {} }]), [{ status: 503 }, { status: 200 }]);
  check('★ 刪列／加分頁（batchUpdate）：503 → 不重送（同一個列號再刪一次，刪掉的是下一列）', !r.ok && r.n === 1, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.batchUpdate([{ deleteDimension: {} }]), [timeoutErr(), { status: 200 }]);
  check('　 刪列：逾時 → 不重送', !r.ok && r.n === 1, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.batchUpdate([{ deleteDimension: {} }]), [{ status: 429 }, { status: 200 }]);
  check('　 刪列：429 → 重試', r.ok && r.n === 2, JSON.stringify({ n: r.n }));
  r = await attempt(() => SH.readRange('events!A2:R'), [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }]);
  check('　 重試有上限：連續 4 次 500 就放棄（不會無限重送）', !r.ok && r.n === 4, JSON.stringify({ n: r.n }));

  r = await attempt(() => SH.readRanges(['qa_log!A2:E', 'qa_log!G2:I']), [{ status: 200, body: { valueRanges: [{ values: [['a']] }, {}] } }]);
  const u = net.calls[0]?.url || '';
  check('一次讀好幾段：一個 values:batchGet 請求，回傳順序跟傳入的一樣（空的那段是 []）',
    r.ok && r.n === 1 && /\/spreadsheets\/MAINSHEET\/values:batchGet\?/.test(u)
    && u.includes(`ranges=${encodeURIComponent('qa_log!A2:E')}`) && u.includes(`ranges=${encodeURIComponent('qa_log!G2:I')}`)
    && JSON.stringify(r.value) === '[[["a"]],[]]', u + ' ' + JSON.stringify(r.value));

  r = await attempt(() => SH.sheetsFor('B2BSHEET').readRange('b2b_leads!A2:Z'), [{ status: 200, body: { values: [] } }]);
  check('sheetsFor(id)：同一組工具綁另一本試算表', r.ok && /\/spreadsheets\/B2BSHEET\/values\//.test(net.calls[0]?.url || ''), net.calls[0]?.url);
  let threw = false;
  try { SH.sheetsFor(''); } catch { threw = true; }
  check('　 沒給試算表 ID 就直接報錯（不會默默寫回記者會那本）', threw);
}

/* ───────── 二、qa_log 跳過 AI 回答全文 ───────── */
console.log('\n── 二、qa_log 只讀需要的欄位 ──');
{
  const r = await attempt(() => QA.readQaRowsWithoutAnswers(), [{
    status: 200,
    body: {
      valueRanges: [
        { values: [['t1', 'e1', '活動一', '經濟日報', '問題一'], ['t2', 'e1', '活動一', '聯合報', '問題二'], ['t3', 'e2', '活動二']] },
        { values: [['', 'line', '王小明'], ['1', 'web']] }
      ]
    }
  }]);
  const rows = r.value || [];
  const u = net.calls[0]?.url || '';
  check('★ 一個請求讀 A:E 與 G:I 兩段，沒有讀 F 欄（AI 回答全文）',
    r.ok && r.n === 1 && u.includes(encodeURIComponent('qa_log!A2:E')) && u.includes(encodeURIComponent('qa_log!G2:I')) && !/F2|A2%3AI|A2%3AH|A2%3AG/.test(u), u);
  check('　 欄位位置不變：r[3] 媒體、r[4] 問題、r[5] 空字串、r[6] 刪除旗標、r[7] 來源、r[8] 姓名',
    rows.length === 3 && rows[0][3] === '經濟日報' && rows[0][4] === '問題一' && rows[0][5] === '' && rows[0][7] === 'line' && rows[0][8] === '王小明'
    && rows[1][6] === '1' && rows[1][7] === 'web' && rows[1][8] === '', JSON.stringify(rows));
  check('　 後面幾欄是空的列也補齊 9 欄（呼叫端照舊用 r[7] || \'web\'）', rows[2].length === 9 && rows[2][2] === '活動二' && rows[2][7] === '', JSON.stringify(rows[2]));
}
for (const [f, re] of [
  ['lib/staff.js', /qa_log!A2:[GHI]'/], ['api/training.js', /qa_log!A2:[GHI]'/], ['api/exposure.js', /qa_log!A2:[GHI]'/]
]) {
  const t = src(f);
  check(`${f}：改用 readQaRowsWithoutAnswers()，不再整張讀 qa_log`, /readQaRowsWithoutAnswers\(\)/.test(t) && !re.test(t));
}
check('api/analytics.js：儀表板摘要版跳過 F 欄；完整版（要算「疑似沒答到」）照舊整張讀',
  /summaryOnly \? await readQaRowsWithoutAnswers\(\) : await readRange\('qa_log!A2:I'\)/.test(src('api/analytics.js')));
globalThis.setTimeout = realSetTimeout;

/* ───────── 三之後：假試算表＋假 LINE ───────── */
register('./loader-reg.mjs', import.meta.url);
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.LINE_BASIC_ID = '@mia123';
process.env.EVENTS_TABLE_TTL_MS = '0';
const S = await import('./fakes-sheets82.mjs');
const F = await import('./fakes.mjs');

/* ───────── 三、範本不算有資料 ───────── */
console.log('\n── 三、只有範本的知識庫不算「有資料」 ──');
{
  const { KB_TEMPLATE } = await import('../lib/kb-template.js');
  const { buildAllCalendarCards } = await import('../lib/router.js');
  const row = (id, kb) => [id, '活動' + id, '#0F9E7A', kb, 'active', iso(3)];
  const cards = buildAllCalendarCards([row('tpl', KB_TEMPLATE), row('real', KB_TEMPLATE + '\n【新聞稿】四足機器人今天發表'), row('empty', '')]);
  const by = Object.fromEntries(cards.map((c) => [c.id, c.has_kb]));
  check('★ 新增活動時沒改過的範本 → has_kb=false（以前「有字就算」，清單標可問答、點了只會說沒有資料）', by.tpl === false, JSON.stringify(by));
  check('　 範本裡真的寫了內容 → true；空白 → false', by.real === true && by.empty === false, JSON.stringify(by));
  const ev = src('api/events.js');
  check('　 活動列表（後台與公開）同一套判斷，沒有殘留「有字就算」的寫法',
    (ev.match(/has_kb: kbHasContent\(r\[3\]\)/g) || []).length === 2 && !/has_kb: !!\(/.test(ev + src('lib/router.js')));
}

/* ───────── 四、AI 用量紀錄 ───────── */
console.log('\n── 四、AI 用量紀錄 ──');
const { estimateUsd, logAiUsage } = await import('../lib/ai-usage.js');
const logs = [];
const realLog = console.log;
const captureLogs = () => { logs.length = 0; console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[ai-usage]')) logs.push(s); else realLog(...a); }; };
const releaseLogs = () => { console.log = realLog; };
{
  const M = 1e6;
  check('價目：Haiku 4.5 輸入 1 百萬 = $1、輸出 1 百萬 = $5',
    estimateUsd('claude-haiku-4-5-20251001', { input_tokens: M }) === 1 && estimateUsd('claude-haiku-4-5-20251001', { output_tokens: M }) === 5);
  check('價目：Haiku 5.5 輸入 1 百萬 = $0.10、輸出 1 百萬 = $0.50（100K 以內那一檔）',
    Math.abs(estimateUsd('claude-haiku-5-5', { input_tokens: M }) - 0.1) < 1e-9 && Math.abs(estimateUsd('claude-haiku-5-5', { output_tokens: M }) - 0.5) < 1e-9);
  check('　 快取讀取打一折、快取寫入 1.25 倍（Sonnet 5.5：$2／百萬）',
    Math.abs(estimateUsd('claude-sonnet-5-5', { cache_read_input_tokens: M }) - 0.2) < 1e-9 && Math.abs(estimateUsd('claude-sonnet-5-5', { cache_creation_input_tokens: M }) - 2.5) < 1e-9);
  check('　 不認得的模型不亂估（回 null，log 照記 token 數）', estimateUsd('claude-unknown', { input_tokens: 10 }) === null);
  captureLogs();
  logAiUsage('測試', 'claude-opus-5', { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 });
  logAiUsage('測試', 'claude-opus-5', undefined);
  releaseLogs();
  check('　 一次呼叫一行，Vercel Logs 搜「[ai-usage]」就找得到；沒有 usage 不記',
    logs.length === 1 && /^\[ai-usage\] 測試 model=claude-opus-5 in=1000 cache_read=9000 cache_write=0 out=200 usd≈0\.01/.test(logs[0]), logs.join('\n'));
}
{
  const files = ['api', 'lib'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));
  const callers = files.filter((f) => src(f).includes('api.anthropic.com'));
  const missing = callers.filter((f) => !/logAiUsage\(/.test(src(f)));
  check(`★ 每一支會呼叫模型的檔案都有記用量（${callers.length} 支）`, callers.length >= 6 && missing.length === 0, missing.join('、'));
}
// 網頁問答的串流：token 數分兩次來（message_start 帶輸入與快取、message_delta 帶輸出），要合起來記
{
  S.reset();
  S.book.events = [['id'], ['e1', '四足機器人發表記者會', '#0F9E7A', '【新聞稿】四足機器人今天發表', 'active', iso(-1), '', '', '', '工研院', 'code1']];
  S.book.qa_log = [['ts']];
  const sse = [
    { type: 'message_start', message: { usage: { input_tokens: 5000, cache_read_input_tokens: 4200, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '這場的重點是四足機器人。' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } },
    { type: 'message_stop' }
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.anthropic.com')) throw new Error('不該打外部服務：' + url);
    const body = JSON.parse(opts.body);
    return body.stream
      ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : jsonRes(200, { content: [{ type: 'text', text: '這場的重點是四足機器人。' }], usage: { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 4500, output_tokens: 40 } });
  };
  const chat = (await import('../api/chat.js')).default;
  const mkRes = () => {
    const r = { statusCode: 200, headers: {}, chunks: [] };
    r.setHeader = (k, v) => (r.headers[k] = v, r);
    r.status = (c) => (r.statusCode = c, r);
    r.json = (o) => (r.body = o, r);
    r.write = (c) => (r.chunks.push(c), true);
    r.end = () => r; r.flushHeaders = () => {};
    return r;
  };
  const ask = async (stream, ip) => {
    const res = mkRes();
    await chat({ method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {},
      body: { messages: [{ role: 'user', content: '這場的重點是什麼？' }], event_id: 'e1', media_name: '經濟日報', stream, client_id: 'c-' + ip } }, res);
    return res;
  };
  captureLogs();
  const sres = await ask(true, '10.1.1.1');
  releaseLogs();
  check('★ 串流：輸入（含快取讀取）與輸出合成一行——in=5000 cache_read=4200 out=120',
    logs.length === 1 && /網頁問答 model=claude-haiku-5-5 in=5000 cache_read=4200 cache_write=0 out=120 usd≈/.test(logs[0]), logs.join('\n'));
  check('　 記用量不影響回答：記者照樣收到內容與結束訊號', sres.chunks.join('').includes('四足機器人') && sres.chunks.join('').includes('"done":true'));
  captureLogs();
  const nres = await ask(false, '10.1.1.2');
  releaseLogs();
  check('　 非串流：同樣記一行（這次是建快取 cache_write=4500）',
    nres.statusCode === 200 && logs.length === 1 && /網頁問答 .* in=300 cache_read=0 cache_write=4500 out=40/.test(logs[0]), logs.join('\n'));
}

/* ───────── 五、同一則 LINE 事件不回兩次 ───────── */
console.log('\n── 五、LINE 同一則事件不回兩次 ──');
{
  S.reset();
  S.book.events = [['id'], ['e1', '四足機器人發表記者會', '#0F9E7A', '【新聞稿】四足機器人今天發表', 'active', iso(-1), '', '', '', '工研院', 'code1']];
  S.book.line_users = [['line_user_id']];
  globalThis.fetch = async (url) => { throw new Error('「使用說明」是固定回覆，不該打外部服務：' + url); };
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const handler = (await import(new URL('../api/line.js?v=1', import.meta.url).href)).default;
  const lineReq = (events) => {
    const body = JSON.stringify({ events });
    const r = new EventEmitter();
    r.method = 'POST';
    r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
    setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
    return r;
  };
  const lineRes = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
  const ev = (id, userId, extra = {}) => ({ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId },
    message: { type: 'text', text: '使用說明' }, ...(id ? { webhookEventId: id } : {}), ...extra });
  const replies = async (events) => { F.sent.length = 0; await handler(lineReq(events), lineRes); return F.sent.length; };

  const first = await replies([ev('01HDUPE', 'U_a')]);
  const again = await replies([ev('01HDUPE', 'U_a', { deliveryContext: { isRedelivery: true } })]);
  check('★ LINE 重送同一則事件（同一個 webhookEventId）→ 只回第一次', first === 1 && again === 0, `第一次 ${first} 則、重送 ${again} 則`);
  check('　 不同事件照常回答', await replies([ev('01HOTHER', 'U_a')]) === 1);
  check('　 同一批裡重複出現也只回一次', await replies([ev('01HBATCH', 'U_b'), ev('01HBATCH', 'U_b')]) === 1);
  check('　 沒有 webhookEventId 的舊格式照常處理（不會因為比不出來就全部擋掉）', await replies([ev('', 'U_c'), ev('', 'U_c')]) === 2);
  offset += 11 * 60_000;
  check('　 只記 10 分鐘：之後同一個 id 再來就當新的（記憶體不會一直長）', await replies([ev('01HDUPE', 'U_d')]) === 1);
  Date.now = realNow;
}

/* ───────── 六、api/line.js 拆檔 ───────── */
console.log('\n── 六、api/line.js 拆檔 ──');
{
  const mods = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /^line-.+\.js$/.test(f) && f !== 'line-link.js');
  const expected = ['line-store.js', 'line-runtime.js', 'line-format.js', 'line-chitchat.js', 'line-nodata.js', 'line-reporter.js', 'line-register.js', 'line-staff-mode.js', 'line-group.js'];
  const lines = src('api/line.js').split('\n').length;
  check(`api/line.js 只剩入口（${lines} 行，拆檔前 5,071 行）`, lines < 800 && expected.every((f) => mods.includes(f)), mods.join(' '));
  // 依賴只能往一個方向走：繞成循環的話，某支在載入時讀到另一支還沒初始化的常數，就是一個只在正式站才炸的錯
  const deps = Object.fromEntries(mods.map((f) => [f, [...src(`lib/${f}`).matchAll(/from '\.\/(line-[a-z-]+\.js)'/g)].map((m) => m[1]).filter((d) => d !== 'line-link.js')]));
  const cyc = [];
  const visit = (f, stack) => {
    if (stack.includes(f)) { cyc.push([...stack, f].join(' → ')); return; }
    for (const d of deps[f] || []) visit(d, [...stack, f]);
  };
  mods.forEach((f) => visit(f, []));
  check('★ lib/line-*.js 之間沒有循環 import', cyc.length === 0, cyc.slice(0, 3).join('\n'));
  check('　 記者端不 import 職員模式與群組（反過來借用可以）',
    !deps['line-reporter.js'].some((d) => d === 'line-staff-mode.js' || d === 'line-group.js'));
  check('　 每一支開頭都寫了是從哪裡搬來、裝的是什麼', mods.every((f) => /批次 117 從 api\/line\.js 搬出來/.test(src(`lib/${f}`).split('\n').slice(0, 12).join('\n'))));
  const L = await import(new URL('../api/line.js?v=99', import.meta.url).href);
  check('　 既有的 import 不用改：api/line.js 照樣匯出 handler 與五個工具函式',
    typeof L.default === 'function' && ['toTraditionalTW', 'stripMarkdownForLine', 'tidyLineLayout', 'extractNoDataKeyword', 'guessNoDataKeyword'].every((n) => typeof L[n] === 'function'));
  const store = src('lib/line-store.js');
  check('　 模組層的快取只住在一個地方（lib/line-store.js），別的檔案沒有自己的一份',
    /let eventsCache/.test(store) && /let lineUsersCache/.test(store)
    && mods.filter((f) => f !== 'line-store.js').every((f) => !/let (eventsCache|lineUsersCache)\b/.test(src(`lib/${f}`))) && !/let (eventsCache|lineUsersCache)\b/.test(src('api/line.js')));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 117 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
