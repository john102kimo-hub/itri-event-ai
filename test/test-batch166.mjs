// 批次 166：成效簡報裡「一眼就知道是假的」資料，以及每一場自己的互動簡報。
//   朱朱：「最多的使用的名稱是 hi，一看就知道是測試的，還有一些一眼看過去就知道是假的，麻煩也調整邏輯性」
//         「成效簡報除了整體外，每場活動也要有各自的」
//   一、測試名稱：正式資料裡漏網的（hi、XX、VVV、Teat、。。、亂碼、示範媒體、工研院…）；真媒體一個都不能誤殺
//   二、媒體家數：「經濟日報曾學仁」「EE Times, Megan」「今週刊」併回同一家
//   三、成效口徑（lib/report-scope.js）：活動前的準備測試、結束一週後的內部測試、已刪除／草稿／測試活動不算；用現在的活動名稱
//   四、api/analytics.js report=1 與 api/exposure.js：數字照口徑算；後台首頁（沒帶 report）照舊看全部
//   五、互動簡報：單場簡報、拿掉「媒體填寫率」、report.html 的入口
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
process.env.ADMIN_PASSWORD = 'pw'; process.env.GOOGLE_SPREADSHEET_ID = 's';
process.env.EVENTS_TABLE_TTL_MS = '0';
const S = await import('./fakes-sheets82.mjs');
const { isTestMedia, splitMedia, groupOutlets } = await import('../lib/media-name.js');
const R = await import('../lib/report-scope.js');
const analytics = (await import('../api/analytics.js')).default;
const exposure = (await import('../api/exposure.js')).default;
const Auth = await import('../lib/auth.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n── 一、測試名稱 ──');
{
  // 2026-10-26 對過正式 qa_log：這些都被當成媒體算進去，「hi」7 題排第一
  const junk = ['hi', 'Hi', 'XX', 'VVV', 'AAA', 'Teat', '。。', '��ٙȶܜ', '示範媒體', '愛台灣', '丁丁', '工研院', 'ITRI', '哈囉', 'ok', '...'];
  const bad = junk.filter((n) => !isTestMedia(n));
  check('★ 正式資料裡漏網的測試名稱都抓得到', !bad.length, bad.join('、'));
  // 真的媒體（含兩個字、英文縮寫、名稱裡本來就有「台」「報」）一個都不能誤殺
  const real = ['TVBS', '鏡報', '三立', '華視', '民視', '中天', 'AP', 'CNA', 'BBC', '中央社', '報導者', '公視台語台', '天下雜誌', '今周刊', 'Moneydj', 'EE Times', '自由時報', '壹蘋新聞網'];
  const killed = real.filter((n) => isTestMedia(n));
  check('★ 真媒體一個都沒被當成測試', !killed.length, killed.join('、'));
  check('原本就抓得到的照舊（測試、test、純數字、內部職員）', ['測試', 'TEST', '539049', '（內部職員）', '（速度測試請刪除）'].every(isTestMedia));
}

console.log('\n── 二、媒體家數 ──');
{
  const g = groupOutlets(['經濟日報曾學仁', '經濟日報曹松清', '經濟日報 王小明', '中央社張建中', '中央社', '鏡報新聞網謝承學', '鏡報', 'EE Times, Megan', 'EEtimes', '今週刊黃靖文', '今周刊']);
  const by = Object.fromEntries(g.map((x) => [x.key, x.count]));
  check('★ 媒體與人名黏在一起也併回同一家（經濟日報 3、中央社 2、鏡報 2）', by['經濟日報'] === 3 && by['中央社'] === 2 && by['鏡報'] === 2, JSON.stringify(g));
  check('「EE Times, Megan」＝「EEtimes」；今週刊＝今周刊', by['eetimes'] === 2 && by['今周刊'] === 2 && g.length === 5, JSON.stringify(g));
  check('拆出來的人名不會變成媒體名稱', splitMedia('經濟日報曾學仁').outlet === '經濟日報' && splitMedia('中央社記者張建中').outlet === '中央社' && splitMedia('聯合報記者').outlet === '聯合報');
  check('★ 不能亂拆：公視台語台、自由時報、報導者、Taipei Times 照原樣', ['公視台語台', '自由時報', '報導者', 'Taipei Times', '三立新聞網'].every((n) => splitMedia(n).outlet === n));
}

console.log('\n── 三、成效口徑 ──');
{
  check('qa_log 時間戳讀得出台灣日期', R.qaDateOf('2026/9/1 上午7:59:34') === '2026-09-01' && R.qaDateOf('2026/10/28 下午1:05:00') === '2026-10-28');
  const W = R.REPORT_WINDOW_DAYS;
  check('★ 活動前一天不算（準備測試）', !R.inReportWindow('2026-09-01', '2026/8/31 下午9:11:29'));
  check('活動當天、第 7 天（含當天）算；第 8 天起不算', W === 7 && R.inReportWindow('2026-09-01', '2026/9/1 上午7:59:34') && R.inReportWindow('2026-09-01', '2026/9/7 下午11:59:59') && !R.inReportWindow('2026-09-01', '2026/9/8 上午0:00:01'));
  check('活動沒有正式日期（只有建立時間戳）、時間戳讀不出日期 → 不限（判斷不了的不丟）', R.inReportWindow('2026/6/18 下午11:06:04', '2026/6/23 上午10:51:19') && R.inReportWindow('2026-09-01', 't1'));
  check('★ 測試活動名稱（正式資料裡的）', ['test', 'pwtest', '測試', '測試活動', '測試 技術洽談', '測試活動-請忽略可刪除-驗證用', '10/29測試', '晶鏈論壇_報名組測試'].every(R.isTestEventName));
  check('★ 真的活動名稱不誤判（Contest、Test Bed）', !['5G Test Bed 啟用記者會', 'AI Contest 頒獎典禮', '工研院創新日', '眺望~2027產業發展趨勢研討會'].some(R.isTestEventName));
  const sc = R.buildReportScope([['a', '新名稱', '', '', 'ended', '2026-09-01'], ['d', '草稿', '', '', 'draft', '2026-09-01'], ['t', '測試活動', '', '', 'active', '2026-09-01']]);
  check('已刪除（不在活動表）、草稿、測試活動都不算；用現在的名稱', sc.includesEvent('a') && !sc.includesEvent('gone') && !sc.includesEvent('d') && !sc.includesEvent('t') && sc.nameOf('a') === '新名稱');
  const empty = R.buildReportScope([]);
  check('活動表讀不到：不套活動規則（寧可多算，也不要整份報告變成空的）', empty.includesEvent('whatever') && empty.includesQa('whatever', '2026/1/1 上午1:00:00'));
}

// ── 假資料：照正式資料的形狀（晶鏈 9/1、四足 7/8、眺望還沒辦、測試／草稿／已刪除的活動）──
const EVROW = (id, name, status, date, type = '論壇') => [id, name, '#0F9E7A', '新聞稿', status, date, '', '', '', '工研院', 'code', '', '', type, ''];
const QA_HEAD = ['timestamp', 'event_id', 'event_name', 'media_name', 'question', 'answer', 'deleted', 'source', 'reporter'];
const q = (ts, id, name, media, question = '量產時程？', src = 'web') => [ts, id, name, media, question, '答', '', src, ''];
function seed() {
  S.reset(); Auth.resetAuthLimiter();
  S.book.events = [['id'],
    EVROW('jl', '2026晶鏈高峰論壇', 'ended', '2026-09-01'),
    EVROW('quad', '經濟部四足機器人記者會', 'ended', '2026-07-08', '記者會'),
    EVROW('soon', '眺望研討會', 'active', '2099-10-28'),
    EVROW('tst', '測試活動', 'active', '2026-09-01'),
    EVROW('drf', '草稿場', 'draft', '2026-09-01'),
    EVROW('nodate', '工研菁英獎 AI 新聞資料中心', 'ended', '2026/6/18 下午11:06:04')];
  S.book.qa_log = [QA_HEAD,
    q('2026/8/30 下午8:26:50', 'jl', '晶鏈', 'hi'),                 // 活動前、而且是測試名稱
    q('2026/8/30 下午8:30:00', 'jl', '晶鏈', '（群組提問）'),         // 活動前的群組測試
    q('2026/8/31 下午2:36:32', 'jl', '晶鏈', '工商時報'),             // 活動前同仁隨手打的真媒體名
    q('2026/9/1 上午8:21:06', 'jl', '晶鏈', '經濟日報曾學仁', '量產時程？', 'line'),
    q('2026/9/1 上午8:22:09', 'jl', '晶鏈', '經濟日報曾學仁'),
    q('2026/9/1 上午7:59:34', 'jl', '晶鏈', '中央社張建中'),
    q('2026/9/1 上午9:25:27', 'jl', '晶鏈', 'XX'),                   // 活動當天，但名稱是測試
    q('2026/9/7 下午3:00:00', 'jl', '晶鏈', '自由時報'),             // 第 7 天：算
    q('2026/9/8 上午9:00:00', 'jl', '晶鏈', '三立'),                 // 第 8 天：不算
    q('2026/7/8 上午9:00:00', 'quad', '經濟部四足機器人國產研發平台發表記者會', 'TVBS'), // 舊名
    q('2026/8/24 下午2:36:44', 'quad', '經濟部四足機器人記者會', '天下雜誌'),           // 一個多月後的內部測試
    q('2026/10/20 上午9:00:00', 'soon', '眺望研討會', '（未填寫）'),                    // 還沒辦
    q('2026/9/1 上午9:00:00', 'tst', '測試活動', '聯合報'),
    q('2026/9/1 上午9:00:00', 'drf', '草稿場', '聯合報'),
    q('2026/9/1 上午9:00:00', 'gone', '已刪除的活動', '聯合報'),
    q('2026/6/23 上午10:51:19', 'nodate', '工研菁英獎 AI 新聞資料中心', 'SHEN'),
    q('2026/6/23 上午10:52:00', 'nodate', '工研菁英獎 AI 新聞資料中心', '愛台灣')];
  S.book.exposure = [['event_id', '則數', '日期', '類型', '媒體名稱', '版位', '標題', '上傳時間', '來源檔'],
    ['jl', 1, '2026-09-02', '平面', '經濟日報', '', 't', '', ''],
    ['jl', 2, '2026-09-02', '平面', '工商時報', '', 't', '', ''],
    ['jl', 3, '2026-09-02', '網路', '聯合新聞網', '', 't', '', '']];
}
const res = () => { const r = { statusCode: 200 }; r.setHeader = () => r; r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.end = () => r; return r; };
const getA = async (query) => { const r = res(); await analytics({ method: 'GET', query, headers: { 'x-admin-password': 'pw' }, socket: {} }, r); return r; };

console.log('\n── 四、API ──');
{
  seed();
  const r = await getA({ exclude_test: '1', report: '1' });
  const b = r.body || {};
  const ev = Object.fromEntries((b.by_event || []).map((e) => [e.event_id, e]));
  check('★ 只剩真的活動：晶鏈、四足、沒有日期的那場（眺望沒辦、測試／草稿／已刪除都不在）', Object.keys(ev).sort().join() === 'jl,nodate,quad', Object.keys(ev).join());
  check('★ 晶鏈只算活動當天到第 7 天、而且不含 XX：4 題', ev.jl?.count === 4, ev.jl?.count);
  check('晶鏈的媒體：經濟日報（2）、中央社、自由時報——活動前的「工商時報」與第 8 天的「三立」都不在', ev.jl?.media_count === 3 && ev.jl.media_top[0].name === '經濟日報' && ev.jl.media_top[0].count === 2 && !ev.jl.media_list.includes('工商時報') && !ev.jl.media_list.includes('三立'), JSON.stringify(ev.jl?.media_top));
  check('★ 用活動現在的名稱（qa_log 存的是舊名）', ev.quad?.event_name === '經濟部四足機器人記者會' && ev.quad.count === 1, JSON.stringify(ev.quad));
  check('沒有正式日期的活動照算，但「愛台灣」不算', ev.nodate?.count === 1 && ev.nodate.media_list.join() === 'SHEN', JSON.stringify(ev.nodate));
  check('總數、媒體家數、口徑天數', b.total === 6 && b.media_total === 5 && b.report_window_days === 7 && ev.jl.event_date === '2026-09-01', `${b.total}/${b.media_total}/${b.report_window_days}`);
  check('「hi」不會出現在媒體排行', !(b.top_media || []).some((m) => m.name === 'hi'), JSON.stringify(b.top_media));

  const d = (await getA({ summary: '1', exclude_test: '1' })).body || {};
  check('★ 後台首頁（沒帶 report）照舊看全部（17 筆扣掉 hi、XX、愛台灣）：活動前、還沒辦、測試活動的問答都還在', d.total === 14 && d.by_event.some((e) => e.event_id === 'soon') && !('report_window_days' in d), `${d.total}`);
}
{
  seed();
  const r = res();
  await exposure({ method: 'GET', query: { action: 'analysis_all' }, headers: { 'x-admin-password': 'pw' }, socket: {} }, r);
  const x = r.body?.byEvent?.jl;
  check('★ 露出交叉分析：提問媒體不含 hi／XX／活動前的「工商時報」，只算經濟日報、中央社、自由時報', x?.qa.mediaAsked === 3, JSON.stringify(x?.topAskers));
  check('　 所以「提問 → 發稿」是 1 / 3（經濟日報），不是被測試名稱灌大分母、也不是把同仁亂打的工商時報算成有發稿', x?.cross.askedAndPublished === 1 && x.cross.askedPublishRate === 33, JSON.stringify(x?.cross));
}

console.log('\n── 五、互動簡報 ──');
{
  const src = read('public/report-deck.js');
  const ctx = { globalThis: null }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  const D = ctx.ReportDeck;
  const A = {
    total: 12, media_total: 4, report_window_days: 7, top_media: [{ name: '經濟日報', count: 5 }],
    by_event: [
      { event_id: 'jl', event_name: '2026晶鏈高峰論壇（Semicon Network Summit）', event_date: '2026-09-01', count: 9, line_count: 3, media_count: 3, media_list: ['經濟日報', '中央社', '自由時報'],
        media_top: [{ name: '經濟日報', count: 5 }, { name: '中央社', count: 2 }, { name: '自由時報', count: 1 }], questions: [{ question: '量產時程？', media: '經濟日報' }] },
      { event_id: 'quad', event_name: '四足', count: 3, line_count: 0, media_count: 1, media_list: ['TVBS'], media_top: [{ name: 'TVBS', count: 3 }], questions: [] },
      { event_id: 'biz', event_name: '企業說明會', audience: 'business', count: 2, media_list: [], questions: [] }]
  };
  const X = { totalExposure: 10, totalOutlets: 6, eventsWithExposure: 2, caveat: 'c',
    byEvent: { jl: { exposure: { total: 7, outlets: 4, topOutlets: [{ name: '經濟日報', n: 3 }] }, qa: { mediaAsked: 3 }, cross: { askedAndPublished: 1, publishedNotAsked: 3, askedPublishRate: 33 } } } };
  const T = { overall: { sessions: 5, avg_score: 7 }, by_event: [{ event_id: 'jl', event_name: '晶鏈', sessions: 2, voice_sessions: 1, avg_score: 8.5 }] };
  const base = { analytics: A, exposure: X, training: T, terms: ['量產'], minPerQ: 3, today: '2026年10月26日' };
  const one = D.buildModel({ ...base, eventId: 'jl' });
  const ids = one.slides.map((s) => s.id).join();
  check('★ 單場簡報：只有這一場的數字（9 題、3 家、LINE 3 題）', one.total === 9 && one.mediaTotal === 3 && one.lineCount === 3 && one.events.length === 1 && one.single.id === 'jl');
  check('單場的頁面：封面、總覽、議題、媒體、露出、訓練、算法、口徑——沒有「各場」表格', ids === 'cover,kpi,topics,media,exposure,training,calc,defs' && one.slides.find((s) => s.id === 'exposure').kind === 'exposureOne', ids);
  check('單場的標題寫這一場的名字（太長截短）與數字', /^《2026晶鏈高峰論壇（Sem…》記者問了 9 題、服務 3 家媒體/.test(one.slides[1].title) && one.slides[0].title.startsWith('2026晶鏈高峰論壇'), one.slides[1].title);
  check('單場的媒體排行用這一場自己的（經濟日報 5 題）', one.topMedia[0].name === '經濟日報' && one.topMedia[0].count === 5 && /最常使用的是經濟日報（5 題）/.test(one.slides.find((s) => s.id === 'media').title));
  check('單場的露出與訓練只看這一場（7 則、發稿率 33%；2 場、8.5 分）', one.exposure.total === 7 && one.exposure.rate === 33 && one.training.sessions === 2 && one.training.avg === 8.5);
  const quad = D.buildModel({ ...base, eventId: 'quad' });
  check('這一場沒有露出、沒有訓練：那兩頁不出現', !quad.slides.some((s) => s.id === 'exposure' || s.id === 'training') && quad.lineCount === 0);
  check('企業場、不存在的活動開不出單場簡報（退回空的，不會把別場的數字拿來用）', D.buildModel({ ...base, eventId: 'biz' }).total === 0 && D.buildModel({ ...base, eventId: 'nope' }).total === 0);
  const zero = D.buildModel({ ...base, analytics: { by_event: [{ event_id: 'acad', event_name: '院士授證', count: 13, line_count: 13, media_count: 0, media_list: [], media_top: [], questions: [] }] }, eventId: 'acad' });
  check('★ 一家媒體都沒有：標題不寫「服務 0 家媒體」、沒有媒體頁；全部來自 LINE 時說明寫對', !/0 家媒體/.test(zero.slides[1].title) && !zero.slides.some((s) => s.id === 'media') && /m\.mediaTotal \? \{ c: 't3'/.test(src) && /全部透過 LINE 問米亞/.test(src), zero.slides[1].title);
  check('各場表格：沒有媒體名稱顯示「—」，不寫「0 家」', /\(e\.mediaCount \? fmt\(e\.mediaCount\) \+ '<small>家<\/small>' : '—'\)/.test(src));
  const all = D.buildModel(base);
  check('整體簡報照舊（排除企業場、有各場表格）', all.total === 12 && all.events.length === 2 && all.slides.some((s) => s.id === 'events') && !all.single);
  const render = src.slice(src.indexOf('var RENDER'), src.indexOf('// ───────────────────────── 互動'));
  check('★ 簡報畫面不再出現「媒體填寫率」（資料完整度不是成效；文件版報告照舊有）', !/填寫率/.test(render) && !/data-sort="fill"/.test(src) && /填寫率/.test(read('public/report.html')));
  check('側欄沒有媒體名稱時整段不放，不寫「記者多未填寫」', !/記者多未填寫媒體名稱<\/p>/.test(src));
  check('單場 KPI：LINE 一題都沒有就不放那張卡（0 不是成效）', /m\.lineCount \? \{ c: 't1', lab: '來自 LINE 的提問'/.test(src) && /cards\.filter\(Boolean\)/.test(src));
  check('口徑頁寫出「每場只算活動當天起 N 天內」', /每場只算活動當天起 ' \+ m\.windowDays \+ ' 天內/.test(src));
  check('★ 各場側欄可以打開那一場的簡報；網址寫成 #deck=代碼/頁碼', /rd-open-ev/.test(src) && /eventId: id/.test(src) && /'#deck=' \+ encodeURIComponent\(one\.id\) \+ '\/'/.test(src));
  const html = read('public/report.html');
  check('★ report.html：用成效口徑（report=1）、每場卡片有「這場的互動簡報」、#deck=代碼 直接開那一場', /\/api\/analytics\?exclude_test=1&report=1/.test(html) && /data-deck-ev="\$\{escHtml\(e\.event_id\)\}"/.test(html) && /#deck=\(\[\^\/\]\+\)/.test(html) && /eventId: typeof eventId === 'string' \? eventId : ''/.test(html));
  check('部會唯讀頁也只算活動當天起的那幾天（口徑文字同步）', /inReportWindow\(ev\[5\], r\[0\]\)/.test(read('lib/impact.js')) && /只計活動當天起 7 天內/.test(read('public/impact.html')));
  check('沒有新增 Function（api/ 仍是 11 支）', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 166 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
