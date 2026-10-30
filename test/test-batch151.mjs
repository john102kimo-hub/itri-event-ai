// 批次 151：計畫成效唯讀連結（政府端第一步）。每一場活動一條唯讀連結，給部會、計畫主管機關的承辦人看媒體露出與提問主題。
//   一、後台：產生／沿用／重新產生（舊的立刻失效）／停用；只有管理員；企業場、不存在的活動不能產生
//   二、公開檢視：連結碼對才給；錯誤、停用、沒產生過、別場的碼、企業場一律同一種 404；亂猜共用失敗限流
//   三、資料界線：只有白名單欄位——提問原文、提問者、聯絡方式、知識庫、編輯碼不在回應裡（CLAUDE.md 第 2 條）
//   四、數字口徑：跟後台「排除測試資料」一致（已刪除、測試媒體、同仁自己問的不算）；主題詞次數
//   五、快取：同一場一分鐘內不重讀 Sheets
//   六、頁面與部署：/impact 路由與安全標頭、textContent、後台入口；沒有新增 Function
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
process.env.ADMIN_PASSWORD = 'pw'; process.env.ANTHROPIC_API_KEY = 'x'; process.env.GOOGLE_SPREADSHEET_ID = 's';
process.env.EVENTS_TABLE_TTL_MS = '0';
const S = await import('./fakes-sheets82.mjs');
const events = (await import('../api/events.js')).default;
const I = await import('../lib/impact.js');
const Auth = await import('../lib/auth.js');
const { countTopics } = await import('../lib/qa-topics.js');
const { summarizeExposure } = await import('../lib/exposure-parse.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.end = () => r; return r; };
let n = 0;
const ip = () => `10.151.${Math.floor(++n / 200)}.${n % 200}`;
const get = async (query, headers = {}, from = ip()) => { const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': from, ...headers }, query, socket: {} }, r); return r; };
const post = async (body, headers = {}) => { const r = res(); await events({ method: 'POST', headers: { 'x-forwarded-for': ip(), ...headers }, query: {}, body, socket: {} }, r); return r; };
const asAdmin = { 'x-admin-password': 'pw' };

// 活動欄位：A id B 名稱 C 色 D 知識庫 E 狀態 F 日期 G chips H images I greeting J 主辦 K 編輯碼 L 時間 M 地點 N 類型 O 聯絡窗口
const EV = ['quad', '經濟部四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】SECRET-KB 四足機器人量產時程', 'active', '2026-08-08', '', '', '', '工研院', 'EDIT-SECRET', '14:00', '工研院中興院區', '記者會', '王小明 03-1111111'];
const BIZ = ['biz', '智慧製造技術說明會', '#0F9E7A', '企業場內容', 'active', '2026-08-09', '', '', '', '工研院', 'BIZ-EDIT', '14:00', '中興院區', '企業說明會', '林小姐'];
const EXP_HEAD = ['event_id', '則數', '日期', '類型', '媒體名稱', '版位', '標題', '上傳時間', '來源檔'];
const QA_HEAD = ['time', 'event_id', 'event', 'media', 'question', 'answer', 'deleted', 'source', 'name'];
const seed = () => {
  S.reset(); I.resetImpactState(); Auth.resetAuthLimiter();
  S.book.events = [['id'], [...EV], [...BIZ], ['other', '別場', '', 'x', 'active', '2026-09-01', '', '', '', '', 'O']];
  S.book.exposure = [EXP_HEAD,
    ['quad', 1, '2026-08-09', '電子媒體', '聯合新聞網', 'A1', '工研院發表四足機器人', 't', 'f'],
    ['quad', 2, '2026-08-09', '平面媒體', '經濟日報', 'A2', '機器人量產', 't', 'f'],
    ['quad', 3, '2026-08-10', '電子媒體', '聯合新聞網', 'A3', '四足機器人 2', 't', 'f'],
    ['other', 1, '2026-09-02', '電子媒體', '別場媒體', 'B1', '別場標題', 't', 'f']];
  S.book.qa_log = [QA_HEAD,
    ['t1', 'quad', 'n', '經濟日報 王大明', '量產時程和成本是多少？SECRET-Q1', '答', '', 'web', '王大明'],
    ['t2', 'quad', 'n', '聯合新聞網', '有哪些合作廠商？SECRET-Q2', '答', '', 'line', '林小美'],
    ['t3', 'quad', 'n', '經濟日報', '補助和 AI 技術突破？', '答', '', 'web', ''],
    ['t4', 'quad', 'n', '測試', '測試用的提問 量產', '答', '', 'web', ''],        // 測試媒體：不算
    ['t5', 'quad', 'n', '（內部職員）', '同仁自己問的 量產', '答', '', 'line', ''],  // 同仁：不算
    ['t6', 'quad', 'n', '中央社', '已刪除的 量產', '答', '1', 'web', ''],            // 已刪除：不算
    ['t7', 'other', 'n', '別家', '別場的問題 量產', '答', '', 'web', '']];
};
const share = (id, mode, h = asAdmin) => post({ action: 'impact_admin_share', id, mode }, h);
const view = (id, k, from) => get({ action: 'impact_view', id, k }, {}, from);

/* ───────── 一、後台 ───────── */
console.log('\n── 一、後台：產生連結 ──');
seed();
let url1, tok1;
{
  const noPw = await share('quad', 'create', {});
  const wrong = await share('quad', 'create', { 'x-admin-password': 'nope' });
  check('★ 沒帶密碼、密碼錯 → 401，什麼都沒寫', noPw.statusCode === 401 && wrong.statusCode === 401 && !S.book.impact_links);
  const r = await share('quad', 'create');
  tok1 = r.body.token; url1 = r.body.url;
  check('管理員產生連結：網址帶活動代碼與連結碼；寫進 impact_links', r.statusCode === 200 && /\/impact\?id=quad&k=/.test(url1) && tok1.length >= 20 && S.book.impact_links[1][0] === 'quad' && S.book.impact_links[1][1] === tok1, JSON.stringify(r.body));
  const again = await share('quad', 'create');
  check('★ 再按一次「產生」沿用同一條（不會把對方手上的連結弄壞），也不多寫一列', again.body.token === tok1 && S.book.impact_links.length === 2);
  const g = await get({ action: 'impact_admin_get', id: 'quad' }, asAdmin);
  check('　 後台讀得到目前的連結；沒密碼讀不到', g.body.url === url1 && (await get({ action: 'impact_admin_get', id: 'quad' })).statusCode === 401);
  const none = await get({ action: 'impact_admin_get', id: 'other' }, asAdmin);
  check('　 沒產生過的活動 → 空連結', none.statusCode === 200 && none.body.url === '' && none.body.token === '');
  const biz = await share('biz', 'create');
  check('★ 企業場不能產生（企業場的提問不算進媒體成效，也不該拿客戶的問題給政府單位看）', biz.statusCode === 400 && /企業場/.test(biz.body.error) && !S.book.impact_links.some((x) => x[0] === 'biz'), JSON.stringify(biz.body));
  check('　 不存在的活動 → 404；亂填 mode → 400', (await share('nope', 'create')).statusCode === 404 && (await share('quad', 'delete')).statusCode === 400);
}

/* ───────── 二、公開檢視與失效 ───────── */
console.log('\n── 二、公開檢視：連結碼 ──');
{
  const ok = await view('quad', tok1);
  check('連結碼對 → 200，不用登入', ok.statusCode === 200 && ok.body.event.id === 'quad', JSON.stringify(ok.body).slice(0, 200));
  check('　 不能被 CDN 或瀏覽器記住（no-store）', ok.headers['cache-control'] === 'no-store');
  const bad = await view('quad', 'x'.repeat(22));
  const empty = await view('quad', '');
  const none = await view('other', tok1);
  const noEv = await view('nope', tok1);
  check('★ 碼錯、沒帶、拿別場的碼、沒這場活動 → 同一種 404（猜的人分不出是哪一種）',
    [bad, empty, none, noEv].every((x) => x.statusCode === 404) && new Set([bad, empty, none, noEv].map((x) => JSON.stringify(x.body))).size === 1, JSON.stringify([bad.statusCode, empty.statusCode, none.statusCode, noEv.statusCode]));
  const rot = await share('quad', 'rotate');
  const tok2 = rot.body.token;
  check('★ 重新產生 → 舊連結立刻失效、新的可以用', rot.statusCode === 200 && tok2 !== tok1 && (await view('quad', tok1)).statusCode === 404 && (await view('quad', tok2)).statusCode === 200);
  const off = await share('quad', 'off');
  check('★ 停用 → 新舊連結都 404；後台顯示沒有連結', off.statusCode === 200 && off.body.url === '' && (await view('quad', tok2)).statusCode === 404 && (await get({ action: 'impact_admin_get', id: 'quad' }, asAdmin)).body.url === '');
  const back = await share('quad', 'create');
  check('　 停用後再產生 → 是一條全新的（不是舊的復活）', back.body.token && back.body.token !== tok1 && back.body.token !== tok2 && S.book.impact_links.filter((x) => x[0] === 'quad').length === 1);
  tok1 = back.body.token;

  // 活動後來被改成企業場：舊連結也不能再看
  S.book.events[1][13] = '企業說明會'; I.resetImpactState();
  const asBiz = await view('quad', tok1);
  S.book.events[1][13] = '記者會'; I.resetImpactState();
  check('★ 活動後來改成企業場 → 已經分享出去的連結也 404', asBiz.statusCode === 404);

  Auth.resetAuthLimiter();
  const from = '10.151.250.1';
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await view('quad', 'guess-' + i, from)).statusCode;
  const adminAfter = await get({ action: 'list_admin' }, asAdmin, from);
  check('★ 同一個來源亂猜 31 次 → 429（跟猜後台密碼共用失敗限流）', last === 429, String(last));
  check('　 被擋的來源連正確的碼也先擋下（猜的流量不會多得到一分資訊）', (await view('quad', tok1, from)).statusCode === 429);
  Auth.resetAuthLimiter();
  void adminAfter;
}

/* ───────── 三、資料界線 ───────── */
console.log('\n── 三、資料界線 ──');
seed();
{
  const tok = (await share('quad', 'create')).body.token;
  const r = await view('quad', tok);
  const v = r.body;
  check('頂層只有 event／exposure／qa／generated_at', Object.keys(v).sort().join() === 'event,exposure,generated_at,qa', Object.keys(v).join());
  check('　 event 只有 id／name／date／venue／organizer', Object.keys(v.event).sort().join() === 'date,id,name,organizer,venue' && v.event.date === '2026-08-08' && v.event.venue === '工研院中興院區' && v.event.organizer === '工研院');
  check('　 qa 只有 questions／media_asked／topics', Object.keys(v.qa).sort().join() === 'media_asked,questions,topics');
  const raw = JSON.stringify(v);
  const leaks = ['SECRET-Q1', 'SECRET-Q2', '王大明', '林小美', '王小明', '03-1111111', 'SECRET-KB', 'EDIT-SECRET', '量產時程和成本', '合作廠商？', '別場媒體', '中央社', '測試用的提問'].filter((x) => raw.includes(x));
  check('★ 回應裡找不到：提問原文、提問者姓名、聯絡窗口、知識庫、編輯碼、別場資料、被排除的提問', leaks.length === 0, leaks.join(','));
  check('　 露出清單裡的媒體名稱是公開報導，可以出現', v.exposure.topOutlets.some((o) => o.name === '聯合新聞網'));
}

/* ───────── 四、數字口徑 ───────── */
console.log('\n── 四、數字口徑 ──');
{
  const tok = (await share('quad', 'create')).body.token;
  const v = (await view('quad', tok)).body;
  check('露出：3 則、2 家媒體；聯合新聞網 2 則排第一；類型與日期分布', v.exposure.total === 3 && v.exposure.outlets === 2 && v.exposure.topOutlets[0].name === '聯合新聞網' && v.exposure.topOutlets[0].n === 2
    && v.exposure.byType['電子媒體'] === 2 && v.exposure.byType['平面媒體'] === 1 && v.exposure.dates.map((d) => `${d.date}:${d.n}`).join() === '2026-08-09:2,2026-08-10:1', JSON.stringify(v.exposure));
  check('★ 提問數 3：測試媒體、同仁自己問的、已刪除的、別場的都不算', v.qa.questions === 3, String(v.qa.questions));
  check('　 提問的媒體 2 家（經濟日報 王大明／經濟日報 併成一家）', v.qa.media_asked === 2, String(v.qa.media_asked));
  const t = Object.fromEntries(v.qa.topics.map((x) => [x.word, x.count]));
  check('　 主題詞：量產 1、成本 1、補助 1、AI 1、技術突破 1、合作廠商 1；依次數排序、最多 8 個', t['量產'] === 1 && t['成本'] === 1 && t['補助'] === 1 && t['AI'] === 1 && t['技術突破'] === 1 && t['合作廠商'] === 1 && v.qa.topics.length <= 8, JSON.stringify(v.qa.topics));
  S.book.exposure = [EXP_HEAD]; S.book.qa_log = [QA_HEAD]; I.resetImpactState();
  const tok2 = (await share('quad', 'create')).body.token;
  const empty = (await view('quad', tok2)).body;
  check('　 還沒上傳露出清單、也沒人問 → exposure 是 null、提問 0，不是錯誤', empty.exposure === null && empty.qa.questions === 0 && empty.qa.topics.length === 0);
  check('lib/qa-topics.js 與 lib/exposure-parse.js 的共用函式照舊算', countTopics(['量產和成本', '量產']).map((x) => `${x.word}${x.count}`).join() === '量產2,成本1' && summarizeExposure([{ outlet: 'a', type: 't', date: 'd' }]).total === 1);
}

/* ───────── 五、快取 ───────── */
console.log('\n── 五、快取：不放大 Sheets 讀取 ──');
seed();
{
  const tok = (await share('quad', 'create')).body.token;
  const t0 = Date.now();
  await I.impactView('quad', tok, { now: t0 });
  S.calls.length = 0;
  await I.impactView('quad', tok, { now: t0 + 30_000 });
  await I.impactView('quad', tok, { now: t0 + 59_000 });
  check('★ 同一場 1 分鐘內再看：不碰 exposure、qa_log（連結表也走 30 秒快取）', S.calls.filter((c) => c[0] === 'read' && /exposure|qa_log|events/.test(String(c[1]))).length === 0, JSON.stringify(S.calls));
  S.book.qa_log.push(['t8', 'quad', 'n', '新媒體', '新增的一題 補助', 'a', '', 'web', '']);
  const later = await I.impactView('quad', tok, { now: t0 + 61_000 });
  check('　 超過 1 分鐘 → 重新計算，看得到新增的提問', later.qa.questions === 4, String(later.qa.questions));
}

/* ───────── 六、頁面與部署 ───────── */
console.log('\n── 六、頁面與部署 ──');
{
  const vercel = JSON.parse(read('vercel.json'));
  check('/impact 有 rewrite 到 impact.html', vercel.rewrites.some((r) => r.source === '/impact' && r.destination === '/impact.html'));
  const hdr = (p) => { const o = {}; for (const rule of vercel.headers) if (new RegExp('^' + rule.source + '$').test(p)) for (const h of rule.headers) o[h.key] = h.value; return o; };
  check('★ /impact：不給搜尋引擎、不快取、不能被別的網站嵌進去', ['/impact', '/impact.html'].every((p) => /noindex/.test(hdr(p)['X-Robots-Tag'] || '') && hdr(p)['Cache-Control'] === 'no-store' && hdr(p)['X-Frame-Options'] === 'SAMEORIGIN'));
  const page = read('public/impact.html');
  check('頁面：noindex、no-referrer（連結碼在網址上）', /name="robots" content="noindex,nofollow"/.test(page) && /name="referrer" content="no-referrer"/.test(page));
  check('★ 頁面：伺服器給的字都用 textContent／createTextNode，不用 innerHTML', !/innerHTML/.test(page) && /textContent = v/.test(page) && /createTextNode/.test(page));
  check('　 頁面打的是 impact_view，帶 id 與 k', /action=impact_view&id=\$\{encodeURIComponent\(id\)\}&k=\$\{encodeURIComponent\(k\)\}/.test(page));
  const idx = read('public/index.html');
  check('★ 後台：計畫成效入口只在「已結束」的活動出現（結案才要交，進行中的選單不多一格）', /if \(ev\.status === 'ended'\) add\('presentation-analytics'/.test(idx));
  check('後台：活動「更多」選單有入口、有說明、連結用 textContent 放', /計畫成效唯讀連結/.test(idx) && /impact_admin_share/.test(idx) && /getElementById\('impact-url'\)\.textContent = url/.test(idx));
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 還是 11 支（Vercel Hobby 上限 12；impact_ 掛在 api/events.js）', fns.length === 11);
  check('　 沒有新增排程（crons 維持 9 個（批次 177 多了 cron_remind 一天兩班））', vercel.crons.length === 9);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 151 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
