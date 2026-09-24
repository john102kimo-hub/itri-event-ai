// 批次 82「全面審視」的回歸測試：每一條都對應一個這次實際找到、而且修掉的問題。
// 跑的是真的 api/*.js 與 lib/*.js，只有 Google Sheets（test/fakes-sheets82.mjs）與
// 外部模型（下面的假 fetch）是假的。靜態頁（public/*.html）直接讀檔案、把要測的函式
// 抽出來執行——測到的是記者與同仁真的會拿到的東西。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_BASIC_ID = '@123abcde';

const { book, calls, ctl, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}
// 從靜態頁抽函式出來跑：抽不到（函式被改名、被刪掉）要算這一條失敗，不能讓整支測試
// 當場丟例外、後面每一條都沒跑到——那樣只會看到一條紅字，看不出到底壞了幾件事。
function extract(html, fromMarker, toMarker, ret, args = []) {
  const a = html.indexOf(fromMarker), b = html.indexOf(toMarker);
  if (a < 0 || b < 0 || b <= a) return null;
  try { return new Function(...args, html.slice(a, b) + `; return ${ret};`); } catch { return null; }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], body: undefined, headersSent: false, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.send = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.flushHeaders = () => { r.headersSent = true; };
  r.write = (x) => { r.headersSent = true; r.chunks.push(String(x)); return true; };
  r.end = (x) => { if (x !== undefined) r.chunks.push(String(x)); r.ended = true; return r; };
  return r;
}
const sseEvents = (res) => res.chunks.join('').split('\n')
  .filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

// ═══ 一、繁體出口的串流版（lib/zh-tw.js）══════════════════════════════════════
console.log('\n── 一、串流轉繁體：切成幾段轉，結果要跟整篇一次轉逐字相同 ──');
const { toTraditionalTW, createTraditionalStream, ZH_TW_RULE } = await import('../lib/zh-tw.js');
const SAMPLES = [
  '内容仅供参考，以工研院官网新闻稿或发言为准。',
  '头发与发型之后，皇后与太后；公里、里程碑、邻里；批准、不准、准许。为准的标准。',
  '云计算与云端，其余与剩余；关于采访，将于明天发布。',
  'This is English. 工研院表示，国产化比例达 85%，预计 2027 年量产。\n\n・关节模组\n・步态控制',
];
function streamed(text, sizes) {
  const s = createTraditionalStream();
  let out = '', i = 0, k = 0;
  const chars = [...text];
  while (i < chars.length) {
    const n = sizes[k++ % sizes.length];
    out += s.push(chars.slice(i, i + n).join(''));
    i += n;
  }
  return out + s.flush();
}
for (const t of SAMPLES) {
  const whole = toTraditionalTW(t);
  for (const sizes of [[1], [2, 3], [5, 1, 7], [1000]]) {
    check(`分段 ${JSON.stringify(sizes)}：「${t.slice(0, 14)}…」`, streamed(t, sizes) === whole, streamed(t, sizes) + ' ≠ ' + whole);
  }
}
{
  const s = createTraditionalStream();
  const out = s.push('这'.repeat(100));
  check('一長串沒有標點的字：不會一直囤著不送（畫面不能停住）', out.length > 0 && !/这/.test(out));
}
check('繁體規則句子放在 lib/zh-tw.js，LINE 與網頁共用', /繁體中文/.test(ZH_TW_RULE));

// ═══ 二、網頁版問答（api/chat.js）════════════════════════════════════════════
console.log('\n── 二、網頁版問答：簡體不能出現在記者畫面上 ──');
reset();
book.events = [
  ['id', 'name'],
  ['ev', '四足機器人發表會', '#0F9E7A', '【新聞稿】工研院發表四足機器人。', 'active', '2026-09-24', '', '', '', '工研院', 'c1'],
];
book.qa_log = [['timestamp']];
const realFetch = globalThis.fetch;
let lastReq = null;
let mode = { kind: 'stream', text: '', status: 200, midError: false };
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com')) return realFetch(url, opts);
  lastReq = { body: JSON.parse(opts.body), signal: opts.signal };
  if (mode.status !== 200) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: mode.status });
  }
  if (!lastReq.body.stream) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: mode.text }] }), { status: 200 });
  }
  const enc = new TextEncoder();
  const parts = mode.text.match(/[\s\S]{1,2}/g) || [];
  const body = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: p } })}\n\n`));
      if (mode.midError) c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`));
      c.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const chat = (await import('../api/chat.js')).default;
const ask = async (q, extra = {}) => {
  const res = fakeRes();
  await chat({ method: 'POST', headers: {}, socket: {}, body: { event_id: 'ev', media_name: '中央社', client_id: 'c' + Math.random(), messages: [{ role: 'user', content: q }], ...extra } }, res);
  return res;
};
mode = { kind: 'stream', text: '工研院表示，国产化比例达 85%。\n内容仅供参考，以工研院官网新闻稿或发言为准。', status: 200 };
{
  const res = await ask('比例多少', { stream: true });
  const text = sseEvents(res).filter((e) => typeof e.t === 'string').map((e) => e.t).join('');
  check('★ 串流：記者畫面上的字全部是繁體（回報那句警語）', text === '工研院表示，國產化比例達 85%。\n內容僅供參考，以工研院官網新聞稿或發言為準。', text);
  const logged = book.qa_log[book.qa_log.length - 1];
  check('★ 串流：寫進 qa_log 的也是繁體（後台、匯出、媒體訓練都讀這份）', logged[5] === text, logged[5]);
  check('繁體規則有放進 system prompt（請求那一層）', lastReq.body.system[0].text.includes(ZH_TW_RULE));
  check('對模型的呼叫有逾時（不會等到 Vercel 60 秒砍掉）', !!lastReq.signal);
}
{
  const res = await ask('比例多少', { stream: false });
  check('★ 非串流（舊前端／外部呼叫）：回覆也是繁體', res.body.reply === toTraditionalTW(mode.text), res.body.reply);
}
mode = { kind: 'stream', text: '', status: 529 };
{
  const res = await ask('比例多少', { stream: true });
  check('模型那端超載：記者看到中文，不是「Overloaded」', res.statusCode === 529 && /稍候/.test(res.body.error) && !/Overloaded/.test(res.body.error), JSON.stringify(res.body));
}
mode = { kind: 'stream', text: '工研院表示，国产化比例', status: 200, midError: true };
{
  const res = await ask('比例多少', { stream: true });
  const ev = sseEvents(res);
  check('答到一半斷掉：已經出來的字照樣送（而且是繁體）', ev.filter((e) => e.t).map((e) => e.t).join('') === '工研院表示，國產化比例', JSON.stringify(ev));
  check('答到一半斷掉：補一句「沒有答完」，不讓記者以為那就是完整答案', ev.some((e) => e.error && /沒有答完/.test(e.error)), JSON.stringify(ev));
}
globalThis.fetch = realFetch;

// ═══ 三、活動 API（api/events.js）════════════════════════════════════════════
console.log('\n── 三、公開端點不外洩同仁電話；LINE 入口 ──');
reset();
const future = new Date(Date.now() + 5 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
book.events = [
  ['id'],
  ['ev', '發表會', '#0F9E7A', 'kb', 'active', '2026-09-01', '題目一', 'https://x/a.jpg', '', '工研院', 'c1', '14:00', '51館', '', '王小明 03-1',
    '技術規格｜陳美玲｜03-5911111｜amy_private_line', '', ''],
  ['pre', '還沒辦的論壇', '#0F9E7A', 'kb', 'active', future, '正式題目', 'https://x/official.jpg', '', '工研院', 'c2', '', '', '', '',
    '', '【邀請函】歡迎採訪', '邀請函題目'],
  ['dr', '籌備中', '#0F9E7A', '', 'draft', future, '', '', '', '工研院', 'c3'],
];
const events = (await import('../api/events.js')).default;
const get = async (query, headers = {}) => { const r = fakeRes(); await events({ method: 'GET', query, headers }, r); return r; };
{
  const r = await get({ action: 'get_public', id: 'ev' });
  check('★ get_public（免登入）不再回傳邀訪窗口分工（同仁姓名／電話／私人 LINE ID）', !('contacts' in r.body.event) && !JSON.stringify(r.body).includes('amy_private_line'), JSON.stringify(r.body));
  check('get_public 帶「用 LINE 問」的連結，格式是 oaMessage＋%23代碼', r.body.event.line_url === 'https://line.me/R/oaMessage/%40123abcde/?%23ev', r.body.event.line_url);
}
{
  const r = await get({});
  check('★ 公開列表也不含邀訪窗口分工', !JSON.stringify(r.body).includes('amy_private_line') && r.body.events.every((e) => !('contacts' in e)));
  const pre = r.body.events.find((e) => e.id === 'pre');
  check('★ 公開列表：活動前（邀請函模式）不給正式照片（以前只有 get_public 擋）', pre && pre.images === '' && pre.chips === '邀請函題目', JSON.stringify(pre));
  check('公開列表照舊不含未發布場次', !r.body.events.some((e) => e.id === 'dr'));
}
{
  const r = await get({ action: 'list_admin' }, { 'x-admin-password': 'pw' });
  check('後台列表帶 LINE 官方帳號資訊（給 LINE QR 按鈕）', r.body.line && r.body.line.basic_id === '@123abcde' && r.body.line.add_friend_url === 'https://line.me/R/ti/p/%40123abcde', JSON.stringify(r.body.line));
  check('後台列表（要密碼）照樣看得到窗口分工', r.body.events.find((e) => e.id === 'ev').contacts.includes('陳美玲'));
}
{
  delete process.env.LINE_BASIC_ID;
  const r = await get({ action: 'get_public', id: 'ev' });
  check('沒設定 LINE_BASIC_ID：不給 LINE 連結（前台就不顯示入口）', r.body.event.line_url === '');
  process.env.LINE_BASIC_ID = '@123abcde';
}
{
  const { lineBindUrl } = await import('../lib/line-link.js');
  process.env.LINE_BASIC_ID = '123abcde';
  check('LINE_BASIC_ID 忘了加 @ 也組得對', lineBindUrl('ev') === 'https://line.me/R/oaMessage/%40123abcde/?%23ev', lineBindUrl('ev'));
  process.env.LINE_BASIC_ID = '@123abcde';
  // 後台 index.html 自己也組一次同樣的連結（畫 QR 用），兩邊必須一模一樣
  const html = read('public/index.html');
  const make = extract(html, 'function lineBindUrlFor', 'function loadQrLib', 'lineBindUrlFor', ['state']);
  const lineBindUrlFor = make ? make({ line: { basic_id: '@123abcde' } }) : () => '(後台頁沒有 lineBindUrlFor)';
  check('★ 後台畫 QR 用的連結 = 後端 lib/line-link.js 組的連結', lineBindUrlFor('robot-m1x') === lineBindUrl('robot-m1x'), lineBindUrlFor('robot-m1x'));
  const code = read('public/vendor/qrcode.js');
  const qrcode = new Function(code + ';return qrcode;')();
  const q = qrcode(0, 'M'); q.addData(lineBindUrl('robot-m1x')); q.make();
  check('QR 產生器（public/vendor/qrcode.js）產得出 QR', q.getModuleCount() >= 21);
}

// ═══ 四、刪除不能「先清空、再寫回」═══════════════════════════════════════════
console.log('\n── 四、刪一筆只寫一次；寫入失敗時整張表不會歸零 ──');
const geo = (await import('../api/geo.js')).default;
const post = async (handler, body) => { const r = fakeRes(); await handler({ method: 'POST', headers: {}, query: {}, body }, r); return r; };
function seedGeo() {
  reset();
  book.geo_settings = [['key', 'value']];
  book.geo_prompts = [['id'],
    ['p1', '電池', '問句一', '電池', '工研院', '', 'TRUE', '2026-09-01', '舊的第九欄'],
    ['p2', '電池', '問句二', '電池', '工研院', '', 'TRUE', '2026-09-01'],
    ['p3', '無人機', '問句三', '無人機', '工研院', '', 'TRUE']];
  book.geo_events = [['id'],
    ['e1', '2026-09-01', '活動一', '記者會', '電池', 'prompts=p1', '', 'TRUE'],
    ['e2', '2026-09-02', '活動二', '記者會', '無人機', 'prompts=', 'itri-2', ''],
    ['e3', '2026-09-03', '活動三', '記者會', '電池', '', '', '']];
}
{
  seedGeo();
  const r = await post(geo, { action: 'prompt_delete', id: 'p1', password: 'pw' });
  const writes = calls.filter((c) => c[0] !== 'read');
  check('★ 刪題目：只寫一次（以前是先整張清空、再寫回，兩次）', r.body?.success && writes.length === 1, JSON.stringify(writes));
  const ids = book.geo_prompts.slice(1).map((x) => x[0]);
  check('刪題目：其他題目原封不動、往上補齊、最後一列清空', JSON.stringify(ids) === JSON.stringify(['p2', 'p3', '']), JSON.stringify(book.geo_prompts));
  check('往上搬的那一列，右邊不會殘留被刪那一列的舊資料', (book.geo_prompts[1][7] || '') === '2026-09-01' && (book.geo_prompts[2][7] || '') === '');
}
{
  seedGeo();
  ctl.failWrites = 1;
  const r = await post(geo, { action: 'prompt_delete', id: 'p1', password: 'pw' });
  const ids = book.geo_prompts.slice(1).map((x) => x[0]);
  check('★ 刪題目時 Sheets 寫入失敗：所有題目都還在（以前會整張歸零）', JSON.stringify(ids) === JSON.stringify(['p1', 'p2', 'p3']) && r.statusCode >= 400, JSON.stringify(ids));
}
{
  seedGeo();
  ctl.failWrites = 1;
  await post(geo, { action: 'event_delete', id: 'e2', password: 'pw' });
  check('★ 刪活動標記時寫入失敗：所有標記都還在', book.geo_events.slice(1).map((x) => x[0]).join() === 'e1,e2,e3');
  ctl.failWrites = 0; calls.length = 0;
  await post(geo, { action: 'event_delete', id: 'e2', password: 'pw' });
  check('刪活動標記：只寫一次、其餘照舊', calls.filter((c) => c[0] !== 'read').length === 1 && book.geo_events.slice(1).map((x) => x[0]).join() === 'e1,e3,');
}
{
  seedGeo();
  const r = await post(geo, { action: 'track_stop', id: 'e1', password: 'pw' });
  check('停止追蹤：只停這場自己的題目、只移掉這場的標記', r.body?.success && book.geo_prompts[1][6] === 'FALSE' && book.geo_prompts[2][6] === 'TRUE'
    && book.geo_events.slice(1).map((x) => x[0]).join() === 'e2,e3,', JSON.stringify(book.geo_events));
  check('停止追蹤：往上搬的標記保留 G、H 欄（活動 ID、結構化）', book.geo_events[1][6] === 'itri-2' && (book.geo_events[1][7] || '') === '');
}
{
  const media = (await import('../api/media.js')).default;
  reset();
  book.media_settings = [['key', 'value']];
  book.media_roster = [['id'],
    ['m1', '王記者', '經濟日報', '科技', '', '', '3', '1', '0', '', 'left', '已轉線', '', ''],
    ['m2', '李記者', '中央社', '', '', '', '1', '0', '0', '', 'active', '', '', '']];
  const csv = 'id,name,outlet\nm2,李記者,中央社\nm3,陳記者,聯合報';
  const r = await post(media, { action: 'seed', password: 'pw', csv });
  const writes = calls.filter((c) => c[0] !== 'read');
  check('記者名單匯入：只寫一次', r.body?.success && writes.length === 1, JSON.stringify(writes));
  check('記者名單匯入：既有記者的離職標記與備註保留、新記者加在後面', book.media_roster[1][10] === 'left' && book.media_roster[1][11] === '已轉線' && book.media_roster[3][0] === 'm3', JSON.stringify(book.media_roster));
  reset();
  book.media_settings = [['key', 'value']];
  book.media_roster = [['id'], ['m1', '王記者', '經濟日報', '科技', '', '', '3', '1', '0', '', 'left', '已轉線', '', '']];
  ctl.failReads.add('media_roster');
  const r2 = await post(media, { action: 'seed', password: 'pw', csv });
  check('★ 讀不到現有名單時停下來，不會把新名單整片蓋在舊資料上', r2.statusCode >= 500 && calls.filter((c) => c[0] !== 'read').length === 0 && book.media_roster[1][11] === '已轉線', JSON.stringify(r2.body));
}

// ═══ 五、GEO：工研院的每一種寫法都認得 ═══════════════════════════════════════
console.log('\n── 五、GEO 品牌別名：工研院／工業技術研究院／ITRI ──');
{
  const orgs = await import('../lib/geo-orgs.js');
  const { resolveOrg, BRAND_KEY } = orgs;
  check('lib/geo-orgs.js 有一份共用的工研院別名規則（BRAND_ALIAS_RE）', orgs.BRAND_ALIAS_RE instanceof RegExp);
  const BRAND_ALIAS_RE = orgs.BRAND_ALIAS_RE || { test: () => false };
  for (const s of ['工研院材化所', '工業技術研究院今天發表', '工业技术研究院', 'ITRI announced', "ITRI's battery", 'Industrial Technology Research Institute', 'IEK 分析師'])
    check(`認得出「${s}」`, BRAND_ALIAS_RE.test(s));
  for (const s of ['氮化鎵 gallium nitride 元件', 'statistics 顯示', 'logistics 物流', '資策會 MIC'])
    check(`★ 不會把「${s}」誤認成工研院（舊規則沒有字詞邊界）`, !BRAND_ALIAS_RE.test(s));
  for (const s of ['Industrial Technology Research Institute (ITRI)', '工业技术研究院', 'ITRI 材化所', '台灣工研院產科國際所'])
    check(`排行把「${s}」併進工研院`, resolveOrg(s).key === BRAND_KEY, resolveOrg(s).key);
  check('「Micron 美光」不會因為開頭像 MIC 被併進資策會', resolveOrg('Micron 美光').key !== '資策會');
  const html = read('public/geo.html');
  const m = html.match(/const BRAND_ALIAS_RE = (\/.*\/i);/);
  check('GEO 頁（靜態頁）鏡射的別名規則 = lib/geo-orgs.js 那一份', m && m[1] === String(BRAND_ALIAS_RE), m && m[1]);
  check('GEO 頁不再只認「工研院|ITRI」', !/\/工研院\|ITRI\/i/.test(html));
}
{
  const { checkGeoDraft } = await import('../lib/geo-draft-check.js');
  const lead = (t) => checkGeoDraft(t).checks.find((c) => c.key === 'lead_brand').pass;
  check('★ 新聞稿開頭寫「工業技術研究院」：檢核算有寫到工研院', lead('新技術發表\n工業技術研究院今（24）日發表固態電池，能量密度提升 30%。'));
  check('★ 英文稿開頭寫「ITRI」：也算', lead('New battery\nITRI unveiled a solid-state battery with 30% higher density.'));
  check('開頭完全沒提到：照樣不過', !lead('新技術發表\n本院今日發表固態電池。'));
  const q = checkGeoDraft('標題\n工業技術研究院今日宣布，固態電池能量密度提升 30%。').quote;
  check('可引用金句也認全名', q.includes('工業技術研究院'), q);
}
{
  // 記者頁 SSR 的結構化資料
  reset();
  book.events = [['id'],
    ['itri', '固態電池發表會', '#0F9E7A', '【新聞稿】\n工研院發表固態電池。', 'ended', '2026-09-01', '', '', '', '工研院', 'c', '14:00', '工研院中興院區 51 館'],
    ['other', '合辦論壇', '#0F9E7A', '【新聞稿】\n內容。', 'ended', '2026-09-01', '', '', '', '台灣半導體協會', 'c']];
  const page = (await import('../api/event-page.js')).default;
  const render = async (id) => { let html = ''; await page({ query: { id } }, { setHeader() { return this; }, status() { return this; }, send(b) { html = b; return this; } }); return html; };
  const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const g = ld(await render('itri'))['@graph'];
  const org = g.find((n) => /Organization/.test(n['@type']));
  check('★ 結構化資料不再把工研院標成「新聞媒體」（NewsMediaOrganization）', !JSON.stringify(g).includes('NewsMediaOrganization'));
  check('★ 工研院的結構化資料列出所有名字（工研院、ITRI、英文全名）', org.name === '工業技術研究院' && ['工研院', 'ITRI', 'Industrial Technology Research Institute'].every((a) => org.alternateName.includes(a)), JSON.stringify(org));
  check('工研院的官網網址是 itri.org.tw，不是這個網站', org.url === 'https://www.itri.org.tw');
  const evNode = g.find((n) => n['@type'] === 'Event');
  check('活動有地點（Event.location）', evNode.location && evNode.location.name === '工研院中興院區 51 館', JSON.stringify(evNode));
  const html = await render('itri');
  check('存檔頁看得到的文字寫出全名與簡稱（給 AI 爬蟲讀）', html.includes('工業技術研究院（工研院／ITRI）'));
  const g2 = ld(await render('other'))['@graph'];
  check('主辦不是工研院的場次：照實寫主辦單位，不套工研院', g2[0].name === '台灣半導體協會' && g2[0]['@type'] === 'Organization');
}

// ═══ 六、前端靜態檢查 ═════════════════════════════════════════════════════════
console.log('\n── 六、前端 ──');
{
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const bad = pages.filter((f) => /icons-webfont@[\d.]+\/tabler-icons/.test(read('public/' + f)));
  check('★ 圖示字型走 /dist/ 路徑（3.x 版根目錄那個網址是 404，全站圖示都不見）', bad.length === 0, bad.join(', '));
}
{
  const html = read('public/event.html');
  const make = extract(html, 'const URL_RE =', '// 圖片燈筱', 'renderMarkdown');
  const renderMarkdown = make ? make() : () => '(記者頁的網址規則沒抽到)';
  const out = renderMarkdown('詳見 https://www.itri.org.tw/robot，歡迎洽詢。');
  check('★ 網址後面緊接的中文不會被吃進連結', out.includes('href="https://www.itri.org.tw/robot"') && out.includes('</a>，歡迎洽詢。'), out);
  check('網址裡的 & 不會被切斷', renderMarkdown('看 https://x.tw/a?b=1&c=2 喔').includes('href="https://x.tw/a?b=1&amp;c=2"'));
  check('HTML 照樣被跳脫（不能塞腳本進記者畫面）', !renderMarkdown('<img src=x onerror=alert(1)> https://x.tw/"onmouseover=1').includes('<img'));
  check('粗體照舊', renderMarkdown('**重點** https://x.tw').startsWith('<strong>重點</strong>'));
  check('★ 快速提問與照片在對話捲動區裡面（不再釘在上方吃掉手機畫面）', /<div id="messages">[\s\S]*id="chips"[\s\S]*id="image-gallery"[\s\S]*<\/div>\s*<div id="chip-dock"/.test(html));
  check('複製鈕在拿不到剪貼簿時有備援（LINE 內建瀏覽器）', /execCommand\('copy'\)/.test(html));
  check('存檔模式不再把照片區藏起來', !/archive-mode #image-gallery/.test(read('api/event-page.js')));
}
{
  const html = read('public/index.html');
  check('★ 行事曆七欄等寬（minmax(0, 1fr)）——手機上星期五、六不會被擠出畫面', /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/.test(html));
  const mobile = html.slice(html.indexOf('/* 響應式 */'), html.indexOf('/* 響應式 */') + 3000);
  check('★ 手機上側邊選單不是直接藏掉（改成底部選單列）', !/#sidebar\s*\{\s*display:\s*none/.test(mobile) && /flex-direction: row/.test(mobile));
  for (const p of ['public/index.html', 'public/geo.html', 'public/report.html', 'public/media.html']) {
    check(`${p}：手機上輸入框 16px（iPhone 點了不會整頁放大）`, /\(pointer: coarse\)[\s\S]{0,400}font-size: 16px !important/.test(read(p)));
  }
}
{
  const html = read('public/training.html');
  check('媒體訓練：後台登入時用後台列表（含未發布場次），拿編輯碼進來時用編輯碼讀名稱', /action=list_admin/.test(html) && /action=get_edit/.test(html));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 82 回歸測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
