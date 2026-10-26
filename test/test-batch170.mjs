// 批次 170：後台米亞的「主管快看」——三顆大按鈕、程式算好的圖卡（不經過 AI）。
//   朱朱：「讓比較懶或看不懂的主管，可以快速了解後台狀況、效益、這套系統厲害之處，可透過圖表、圖示呈現，
//         並且可視狀況新增快捷按鈕，但務必確保不要太複雜」
//   一、圖卡的數字（純函式）：企業場與測試活動不算、跟成效報告同一個工時算法、0 題的活動不列
//   二、按下按鈕的整條流程（假瀏覽器）：打的是 report=1 那支、不打 AI、圖卡存進對話、給模型的那一句話
//   三、後台首頁的「記者問答」「服務媒體」跟成效報告同一個數字（批次 104 的原則）；「今日問答」照舊看全部
//   四、不要太複雜：按鈕固定三顆、常用問題三題；一律 textContent
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
process.env.ADMIN_PASSWORD = 'pw'; process.env.GOOGLE_SPREADSHEET_ID = 's'; process.env.EVENTS_TABLE_TTL_MS = '0';
const S = await import('./fakes-sheets82.mjs');
const analytics = (await import('../api/analytics.js')).default;
const Auth = await import('../lib/auth.js');
const { systemPrompt } = await import('../lib/assistant.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const JS = read('public/mia-assistant.js');

// 在假瀏覽器裡跑 mia-assistant.js（同 test-batch145 的做法），fetch 換成假的後台 API
function boot({ store = {}, api = {} } = {}) {
  store.itri_pwd ??= 'pw';
  const made = [], calls = [];
  const mkEl = (tag) => {
    const e = { tag, children: [], style: {}, className: '', textContent: '', title: '', classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, setAttribute() {}, focus() {}, scrollHeight: 0 };
    made.push(e);
    return e;
  };
  const win = { addEventListener() {}, matchMedia: () => ({ matches: false }), innerHeight: 800, innerWidth: 1280, dispatchEvent() {} };
  const sandbox = {
    window: win, location: { href: '' },
    document: { readyState: 'complete', head: mkEl('head'), body: mkEl('body'), createElement: mkEl, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 0, setTimeout: () => 0, getComputedStyle: () => ({ position: 'static' }), requestAnimationFrame: () => 0,
    JSON, Math, String, Array, Object, Number, Date, Promise, CustomEvent: function () {},
    fetch: async (url, opt = {}) => {
      calls.push({ url, method: opt.method || 'GET', headers: opt.headers || {} });
      const key = Object.keys(api).find((k) => url.startsWith(k));
      if (!key) return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
      const v = api[key];
      return { ok: v.status ? v.status < 400 : true, status: v.status || 200, json: async () => v.body };
    },
  };
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  vm.runInNewContext(JS, sandbox);
  return { made, calls, store, Brief: win.MiaBrief };
}

console.log('\n── 一、圖卡的數字 ──');
const { Brief } = boot();
{
  const A = {
    total: 90, business_qa: 9, media_total: 8, report_window_days: 14,
    by_event: [
      { event_id: 'quad', event_name: '四足', count: 38 }, { event_id: 'jl', event_name: '晶鏈', count: 26 },
      { event_id: 'inno', event_name: '創新日', count: 14 }, { event_id: 'biz', event_name: '企業說明會', audience: 'business', count: 9 },
      { event_id: 'a', event_name: 'A', count: 1 }, { event_id: 'b', event_name: 'B', count: 1 }, { event_id: 'c', event_name: 'C', count: 1 }],
    top_keywords: [{ word: 'AI', count: 17 }, { word: '晶片', count: 17 }, { word: '量產', count: 10 }, { word: '時程', count: 10 }, { word: '成本', count: 9 }, { word: '良率', count: 1 }]
  };
  const k = Brief.kpiData(A, { totalExposure: 34 });
  check('★ 題數不算企業場（38＋26＋14＋1＋1＋1＝81，不是 90）；媒體家數用後端去重的', k.total === 81 && k.media === 8 && k.events === 6, JSON.stringify(k));
  // 「同一個算法」直接拿互動簡報的函式來比（81 × 3 ÷ 60 ＝ 4.05，兩邊都是 toFixed(1)）
  const dctx = { globalThis: null }; dctx.globalThis = dctx; vm.createContext(dctx); vm.runInContext(read('public/report-deck.js'), dctx);
  const deckHours = (n) => dctx.ReportDeck.hoursStr(n * 3 / 60);
  check('★ 節省工時跟成效報告的互動簡報同一個算法（81、400、7、0 題逐一比對）', k.hours === deckHours(81) && [400, 7, 0].every((n) => Brief.kpiData({ total: n, by_event: [] }, null).hours === deckHours(n)) && k.days === (81 * 3 / 60 / 8).toFixed(1), k.hours + '/' + deckHours(81));
  check('長條圖：題數由多到少、最多 5 場；熱門主題最多 5 個；露出則數、口徑天數', k.top.map((t) => t.name).join() === '四足,晶鏈,創新日,A,B' && k.topics.length === 5 && k.exposure === 34 && k.window === 14);
  check('露出讀不到（null）→ 0，那一格不出現', Brief.kpiData(A, null).exposure === 0);
  const big = Brief.kpiData({ total: 400, media_total: 30, by_event: [{ event_id: 'x', event_name: 'x', count: 400 }] }, null);
  check('滿 10 小時取整數（400 題 → 20 小時）', big.hours === '20');

  const now = Date.parse('2026-10-26T04:00:00Z'); // 台灣 10/26（一）中午
  const L = { events: [
    { id: 't2027', name: '眺望研討會', status: 'active', event_date: '2026-10-28', missing: [] },
    { id: 'yuan', name: '原鄉成果發表會', status: 'draft', event_date: '2026-11-23', missing: ['地點', '新聞聯絡人', '新聞稿'] },
    { id: 'ip', name: '花東成果會', status: 'draft', event_date: '2026-12-03', missing: [] },
    { id: 'biz', name: '智慧製造技術說明會', status: 'active', event_date: '2026-11-04', event_type: '企業說明會', missing: [] },
    { id: 'more', name: '第五場', status: 'active', event_date: '2026-12-20', missing: [] },
    { id: 't1', name: '測試活動', status: 'draft', event_date: '2026-10-31', missing: ['地點'] },
    { id: 't2', name: 'pwtest', status: 'active', event_date: '2026-10-29', missing: [] },
    { id: 'old', name: '已封存的', status: 'archived', event_date: '2026-10-30', missing: [] },
    { id: 'nodate', name: '日期未定的', status: 'draft', event_date: '2026/10/22 上午8:59:17', missing: ['日期'] },
    { id: 'inno', name: '工研院創新日', status: 'ended', event_date: '2026-09-15', missing: [] },
    { id: 'jl', name: '晶鏈論壇', status: 'ended', event_date: '2026-09-01', missing: [] },
    { id: 'zero', name: '沒人問的', status: 'ended', event_date: '2026-10-20', missing: [] },
    { id: 'quad', name: '四足', status: 'ended', event_date: '2026-07-08', missing: [] }] };
  const e = Brief.eventsData(L, A, now);
  check('★ 測試活動、已封存、日期未定的不列給主管看', !JSON.stringify(e).match(/測試活動|pwtest|已封存的|日期未定的/), JSON.stringify(e));
  check('接下來：日期由近到遠、最多列 4 場，總數照實寫（5 場）', e.upcoming.map((x) => x.name).join() === '眺望研討會,智慧製造技術說明會,原鄉成果發表會,花東成果會' && e.upcomingTotal === 5, JSON.stringify(e.upcoming.map((x) => x.name)));
  check('每場帶日期（含星期）、還有幾天、狀態、還缺什麼、是不是企業場', e.upcoming[0].date === '10/28（三）' && e.upcoming[0].days === 2 && e.upcoming[2].missing.join() === '地點,新聞聯絡人,新聞稿' && e.upcoming[1].biz === true && e.today === '10/26（一）');
  check('★ 最近辦完：近 60 天、真的有人問過的才列（0 題不是成效；四足超過 60 天）', e.recent.map((x) => x.name + x.count).join() === '工研院創新日14,晶鏈論壇26', JSON.stringify(e.recent));

  const s0 = Brief.briefSummary('kpi', Brief.kpiData({ total: 0, by_event: [] }, null));
  const s1 = Brief.briefSummary('kpi', k);
  check('給模型的那句話：寫出數字與口徑，主管接著問「那哪一場最多」才接得上；0 題時不留半句', /81 題/.test(s1) && /8 家媒體/.test(s1) && /14 天內/.test(s1) && /四足 38 題/.test(s1) && s0 === '（我用圖卡顯示了成效：目前還沒有記者問答紀錄。）', s1);
  check('活動近況那句話：列出接下來的場次與還缺什麼', /還缺：地點、新聞聯絡人、新聞稿/.test(Brief.briefSummary('events', e)));
}

console.log('\n── 二、按下按鈕的整條流程 ──');
{
  const A = { total: 12, media_total: 3, report_window_days: 14, by_event: [{ event_id: 'jl', event_name: '晶鏈', count: 12 }], top_keywords: [] };
  const env = boot({ api: { '/api/analytics?summary=1&exclude_test=1&report=1': { body: A }, '/api/exposure?action=analysis_all': { body: { totalExposure: 5 } } } });
  const bigBtns = env.made.filter((x) => x.tag === 'button' && x.children.some((c) => c.className === 'ic'));
  check('★ 開場畫面三顆大按鈕：一分鐘看成效、活動近況、這套系統做了什麼', bigBtns.length === 3 && /一分鐘看成效/.test(JSON.stringify(bigBtns[0].children)) && /活動近況/.test(JSON.stringify(bigBtns[1].children)) && /這套系統做了什麼/.test(JSON.stringify(bigBtns[2].children)));
  await bigBtns[0].onclick();
  const log = JSON.parse(env.store.mia_assist_v1 || '[]');
  const card = log.find((m) => m.role === 'brief');
  check('★ 按「一分鐘看成效」→ 對話裡多一張成效圖卡，數字就是 API 回來的（12 題、3 家、露出 5 則）', card && card.kind === 'kpi' && card.data.total === 12 && card.data.media === 3 && card.data.exposure === 5, JSON.stringify(log));
  check('★ 打的是成效報告那一支（report=1）＋露出；不打 AI（沒有 assistant_chat）', env.calls.some((c) => c.url === '/api/analytics?summary=1&exclude_test=1&report=1') && !env.calls.some((c) => c.method === 'POST'), JSON.stringify(env.calls));
  check('　 帶管理員密碼的 header，不放在網址上', env.calls.every((c) => c.headers['X-Admin-Password'] === 'pw' && !/pw/.test(c.url.replace('report', ''))));
  check('使用者那一則寫成按鈕的名稱（對話裡看得出剛剛按了什麼）', log.some((m) => m.role === 'user' && m.text === '📊 一分鐘看成效'));

  const bad = boot({ api: { '/api/analytics': { status: 401, body: { error: 'unauthorized' } } } });
  await bad.made.filter((x) => x.tag === 'button' && x.children.some((c) => c.className === 'ic'))[0].onclick();
  check('密碼過期 → 紅字請他重新登入，不出空白圖卡', JSON.parse(bad.store.mia_assist_v1).some((m) => m.err && /重新登入/.test(m.text)) && !JSON.parse(bad.store.mia_assist_v1).some((m) => m.role === 'brief'));

  const hist = JS.slice(JS.indexOf('function history'), JS.indexOf('async function ask'));
  check('★ 圖卡轉成一句話放進對話紀錄送給模型（看完圖卡接著問才接得上）', /if \(m\.role === 'brief'\) m = \{ role: 'assistant', text: briefSummary\(m\.kind, m\.data \|\| \{\}\) \}/.test(hist));
}

console.log('\n── 三、後台首頁跟成效報告同一個數字 ──');
{
  S.reset(); Auth.resetAuthLimiter();
  const EV = (id, name, status, date, type = '記者會') => [id, name, '', 'kb', status, date, '', '', '', '工研院', 'c', '', '', type, ''];
  S.book.events = [['id'], EV('jl', '晶鏈', 'ended', '2026-09-01'), EV('biz', '企業場', 'active', '2026-09-01', '企業說明會')];
  const q = (ts, id, media) => [ts, id, 'n', media, '量產？', '答', '', 'web', ''];
  S.book.qa_log = [['t'], q('2026/8/30 下午8:00:00', 'jl', '工商時報'), q('2026/9/1 上午9:00:00', 'jl', '經濟日報'), q('2026/9/1 上午9:10:00', 'jl', '中央社'),
    q('2026/9/1 上午9:20:00', 'biz', '某公司'), q('2026/10/20 上午9:00:00', 'jl', '三立')];
  const get = async (query) => { const r = { statusCode: 200 }; r.setHeader = () => r; r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); await analytics({ method: 'GET', query, headers: { 'x-admin-password': 'pw' } }, r); return r.body; };
  const home = await get({ summary: '1', exclude_test: '1' });
  const rep = await get({ summary: '1', exclude_test: '1', report: '1' });
  const repTotal = rep.by_event.filter((e) => e.audience !== 'business').reduce((n, e) => n + e.count, 0);
  check('★ 首頁那一支多回 report_scope：題數與媒體家數＝成效報告（不含活動前的「工商時報」、第 50 天的「三立」、企業場）', home.report_scope && home.report_scope.total === repTotal && repTotal === 2 && home.report_scope.media_total === rep.media_total && rep.media_total === 2, JSON.stringify([home.report_scope, repTotal, rep.media_total]));
  check('　 其餘照舊看全部（total 5、各場題數照舊）——「今日問答」當天盯場要看到記者問舊活動的題目', home.total === 5 && home.by_event.find((e) => e.event_id === 'jl').count === 4);
  const idx = read('public/index.html');
  check('首頁的「記者問答」「服務媒體」用 report_scope，舊版後端沒有就照舊；「今日問答」不動', /const rs = data\.report_scope \|\| null;/.test(idx) && /\(rs \? rs\.total : data\.total\)/.test(idx) && /\(rs \? rs\.media_total : data\.media_total\)/.test(idx) && /stat-today'\)\.textContent = data\.today_count/.test(idx));
  check('成效口徑的熱門主題不算企業場的提問（跟互動簡報一致）', rep.top_keywords.find((t) => t.word === '量產')?.count === 2 && home.top_keywords.find((t) => t.word === '量產')?.count === 5, JSON.stringify([rep.top_keywords, home.top_keywords]));
}

console.log('\n── 四、不要太複雜 ──');
{
  const quick = JS.slice(JS.indexOf('var QUICK'), JS.indexOf('var MIN_PER_Q'));
  check('★ 快看按鈕固定三顆、常用問題三題（原本四題，「最近有哪些活動」由📅取代）', (quick.match(/key: '/g) || []).length === 3 && /var CHIPS = \['這幾天記者問了什麼？', '報名狀況怎麼樣？', 'AI 追蹤最近表現如何？'\];/.test(JS));
  check('對話開始之後，三顆縮成輸入框上方的一列；開場畫面不重複顯示', /quick\.style\.display = state\.log\.length \? 'flex' : 'none'/.test(JS));
  check('★ 整支沒有 innerHTML（活動名稱、媒體名稱一律 textContent）', !/innerHTML/.test(JS));
  check('成效卡附「打開完整互動簡報」', /打開完整互動簡報/.test(JS) && /location\.href = '\/report#deck'/.test(JS));
  check('模型被問到整體成效時，引導主管按按鈕看正式口徑的數字', /請他按對話框下方的「📊 成效」或「✨ 系統亮點」/.test(systemPrompt()));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 170 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
