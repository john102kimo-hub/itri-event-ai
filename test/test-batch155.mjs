// 批次 155：成效報告「互動簡報」。
//   朱朱：「數據成效還是要清楚明瞭，不要單純動畫好看」——所以這支測的是「數字對不對、標題寫不寫結論、口徑有沒有交代」，
//   不是動畫。簡報的資料模型 buildModel() 是純函式，在 node 直接跑。
//   一、數字與報告一致（排除企業場、題數／媒體家數／節省工時）
//   二、每一頁標題直接寫結論；並列不能寫成「其次」；場名太長會截短
//   三、沒有資料、缺資料的頁面不出現（不編數字）
//   四、數字是靜態文字，動畫只是從 0 跳過去；HTML 一律跳脫
//   五、結構：report.html 引入、列印時不印簡報、沒有新增 Function／排程／rewrite
// 畫面（桌機、手機、減少動態）另用 Chromium 逐頁看過，見 docs/batches 批次 155。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 400) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('public/report-deck.js');
const ctx = { globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const D = ctx.ReportDeck;

const qs = (n, media, topic) => Array.from({ length: n }, (_, i) => ({ question: '請問' + topic + '的狀況？' + i, media: media[i % media.length] }));
const A = {
  total: 130, business_qa: 9, media_total: 5, top_media: [{ name: '經濟日報', count: 21 }, { name: '工商時報', count: 9 }],
  by_event: [
    { event_id: 'a', event_name: '甲場記者會', count: 58, media_count: 3, media_list: ['經濟日報', '工商時報', '聯合報'], questions: qs(58, ['經濟日報', '工商時報', '（未填寫）'], '量產') },
    { event_id: 'b', event_name: '乙場記者會', count: 30, media_count: 2, media_list: ['中央社', '聯合報'], questions: qs(30, ['中央社'], '良率') },
    { event_id: 'biz', event_name: '企業說明會', audience: 'business', count: 9, media_count: 1, media_list: ['某公司'], questions: qs(9, ['某公司'], '量產') }
  ]
};
const base = { analytics: A, terms: ['量產', '良率', '成本'], minPerQ: 3, today: '2026年10月21日' };
const M = D.buildModel(base);

console.log('\n── 一、數字與報告一致 ──');
{
  check('★ 企業場不列入：場次 2 場、不含「企業說明會」', M.events.length === 2 && !M.events.some(e => e.id === 'biz'));
  check('題數＝各場題數加總（58＋30＝88，不含企業場的 9）', M.total === 88, M.total);
  check('媒體家數沿用後端算好的去重數', M.mediaTotal === 5);
  check('估算節省工時＝題數 × 每題分鐘 ÷ 60（88×3÷60＝4.4）', Math.abs(M.hoursFor(3) - 4.4) < 1e-9 && D.hoursStr(M.hoursFor(3)) === '4.4');
  check('滿 10 小時取整數、不到 10 小時留一位小數（跟報告頁同規則）', D.hoursStr(12.34) === '12' && D.hoursStr(9.96) === '10.0' && D.hoursStr(4.4) === '4.4');
  check('每題分鐘數夾在 1–30（亂填也不會算出荒謬的工時）', Math.abs(M.hoursFor(0) - 88 / 60) < 1e-9 && Math.abs(M.hoursFor(999) - 88 * 30 / 60) < 1e-9);
  check('場次依題數由多到少', M.events[0].id === 'a' && M.events[1].id === 'b');
  check('「（未填寫）」不算有填媒體：甲場填寫率＝2/3 約 67%', M.events[0].fillRate >= 66 && M.events[0].fillRate <= 67, M.events[0].fillRate);
  check('議題比對的範圍不含企業場（量產只算甲場 58 題）', M.topics.find(t => t.w === '量產').c === 58 && M.topics.find(t => t.w === '良率').c === 30);
}

console.log('\n── 二、標題直接寫結論 ──');
{
  const by = Object.fromEntries(M.slides.map(s => [s.id, s]));
  check('KPI 頁標題含題數、媒體家數、工時', /88 題/.test(by.kpi.title) && /5 家媒體/.test(by.kpi.title) && /4\.4 小時/.test(by.kpi.title), by.kpi.title);
  check('議題頁標題寫出最常問的主題與題數', /「量產」（58 題）/.test(by.topics.title), by.topics.title);
  check('各場頁標題寫場次數與題數最多的一場', /共 2 場/.test(by.events.title) && /58 題/.test(by.events.title), by.events.title);
  check('算法頁標題隨每題分鐘數變（5 分鐘→7.3 小時）', /5 分鐘/.test(M.titles.calc(5)) && /7\.3 小時/.test(M.titles.calc(5)), M.titles.calc(5));
  check('每一頁都有章節；除封面外都有標題', M.slides.every(s => s.chapter && s.title));

  const tie = D.buildModel({ ...base, analytics: { ...A, by_event: [{ event_id: 'a', event_name: '甲', count: 32, media_list: [], questions: [...qs(16, ['x'], '量產'), ...qs(16, ['x'], '良率'), ...qs(15, ['x'], '成本')] }] } });
  const tt = tie.slides.find(s => s.id === 'topics').title;
  check('★ 並列第一要寫成並列（各 16 題），不能硬分出「其次」', /「量產」「良率」（各 16 題）/.test(tt) && !/其次是「良率」/.test(tt), tt);
  check('　 並列之後才有「其次」，而且寫題數', /其次是「成本」（15 題）/.test(tt), tt);

  const long = D.buildModel({ ...base, analytics: { ...A, by_event: [{ event_id: 'a', event_name: '經濟部四足機器人國產研發平台發表記者會暨成果展示活動', count: 5, media_list: [], questions: [] }] } });
  const lt = long.slides.find(s => s.id === 'events').title;
  check('★ 場名太長在標題截短（完整名稱留在表格與側欄），不把版面擠壞', lt.length < 45 && /…》/.test(lt) && long.events[0].name.length > 20, lt);
  const tieEv = D.buildModel({ ...base, analytics: { ...A, by_event: [{ event_id: 'a', event_name: '甲', count: 10, media_list: [], questions: [] }, { event_id: 'b', event_name: '乙', count: 10, media_list: [], questions: [] }] } });
  check('各場題數並列也照實寫，不指定「最多的是某一場」', /問題最多的有 2 場，各 10 題/.test(tieEv.slides.find(s => s.id === 'events').title), tieEv.slides.find(s => s.id === 'events').title);
}

console.log('\n── 三、沒有資料就不出現、不編數字 ──');
{
  const E = D.buildModel({ analytics: { total: 0, by_event: [] }, terms: [], today: 'x' });
  const ids = E.slides.map(s => s.id);
  check('完全沒有資料：只剩封面、KPI、算法、口徑，沒有議題／媒體／各場／露出／訓練頁', ids.join() === 'cover,kpi,calc,defs', ids.join());
  check('完全沒有資料：KPI 標題老實寫「目前還沒有記者問答紀錄」', /還沒有記者問答紀錄/.test(E.slides[1].title));
  check('沒有露出資料就沒有露出頁、沒有訓練資料就沒有訓練頁', !M.slides.some(s => s.id === 'exposure' || s.id === 'training') && M.exposure === null && M.training === null);
  const X = D.buildModel({ ...base, exposure: { totalExposure: 37, totalOutlets: 21, eventsWithExposure: 1, byEvent: { a: { exposure: { total: 37, outlets: 21, topOutlets: [] }, qa: { mediaAsked: 8 }, cross: { askedAndPublished: 6, askedPublishRate: 75, publishedNotAsked: 15 } } } },
    training: { overall: { sessions: 7, voice_sessions: 4, avg_score: 7.5 }, by_event: [{ event_id: 'a', event_name: '甲', sessions: 7, avg_score: 7.5 }] } });
  const xs = Object.fromEntries(X.slides.map(s => [s.id, s]));
  check('有露出資料：標題寫則數、家數、發稿率', /37 則媒體報導、21 家媒體/.test(xs.exposure.title) && /75%/.test(xs.exposure.title), xs.exposure.title);
  check('有訓練資料：標題寫場次與平均分', /已有 7 場/.test(xs.training.title) && /7\.5 \/ 10/.test(xs.training.title), xs.training.title);
  check('露出表格的「另有 N 家沒用 AI 問答仍有露出」用全部場次合計，不是只算表上列的幾場', X.exposure.publishedNotAsked === 15);
  const nr = D.buildModel({ ...base, exposure: { totalExposure: 5, totalOutlets: 3, eventsWithExposure: 1, byEvent: { a: { exposure: { total: 5, outlets: 3 }, qa: { mediaAsked: 0 }, cross: {} } } } });
  check('沒有媒體同時用過 AI 問答：發稿率是 null（頁面寫「無法計算」），不是 0%', nr.exposure.rate === null && !/後續有發稿/.test(nr.slides.find(s => s.id === 'exposure').title));
}

console.log('\n── 四、數字是靜態文字；跳脫 ──');
{
  check('★ 數字節點在 HTML 就是最後的字串（data-to 只是動畫的終點）：動畫沒跑、關掉、列印都一樣', /function cu\(value, dec\) \{ return '<span class="rd-cu" data-to="' \+ value \+ '" data-dec="' \+ \(dec \|\| 0\) \+ '">' \+ fmt\(value, dec\) \+ '<\/span>'/.test(src));
  check('★ 動畫結束一定設回最後的字串（不是停在補間值）', /if \(k < 1\) requestAnimationFrame\(f\); else node\.textContent = finalText/.test(src) && /function settle/.test(src));
  check('離開頁面時所有數字、環圈立刻回到最後的值', /function settle\(slide\)[\s\S]{0,300}n\.textContent = fmt\(Number\(n\.dataset\.to\)/.test(src));
  check('減少動態：尊重 prefers-reduced-motion，也可手動關動畫', /prefers-reduced-motion: reduce/.test(src) && /動畫：/.test(src) && /#rd-wrap\.reduce \.rd-rv/.test(read('public/report-deck.css')));
  check('每條長條都標數值與單位（bar 的輸出含數字與單位）', /<div class="rd-vv"><span>' \+ fmt\(value, dec\) \+ '<\/span><small>' \+ esc\(unit\)/.test(src));
  check('每頁都有「口徑」說明（note）：KPI、議題、媒體、各場、露出、訓練、算法', ['kpi', 'topics', 'media', 'events', 'exposure', 'training', 'calc'].every(k => new RegExp(k + ': function \\(m(, s)?\\) \\{[\\s\\S]*?note\\(').test(src)));
  check('訓練分數長條保留一位小數（7.5 不被四捨五入成 8）', /bar\(r\.event_name \|\| r\.event_id, r\.avg_score == null \? 0 : r\.avg_score, 10, '\/ 10 分', r\.sessions \+ ' 場', i \+ 2, 1\)/.test(src));

  const evil = '<img src=x onerror=alert(1)>';
  const E = D.buildModel({ ...base, analytics: { ...A, by_event: [{ event_id: 'a', event_name: evil, count: 3, media_list: [evil], questions: [] }] } });
  check('場名含 HTML：模型原樣保留、輸出時才跳脫（esc 會把 < > " & 全換掉）', E.events[0].name === evil && D.esc(evil) === '&lt;img src=x onerror=alert(1)&gt;' && D.esc('"&') === '&quot;&amp;');
  const raw = src.split('\n').filter(l => /innerHTML|\+ e\.name|\+ r\.name|\+ n \+|\+ t\.w|\+ t\.name/.test(l) && !/esc\(/.test(l));
  check('★ 所有拼進 HTML 的伺服器文字都過 esc()（逐行找沒跳脫的拼接）', raw.every(l => !/[+] (e|r|t|n)\.(name|w)\b(?!\))/.test(l)), raw.join('\n'));
}

console.log('\n── 五、結構 ──');
{
  const html = read('public/report.html');
  check('report.html 引入簡報樣式與腳本，並有「互動簡報」按鈕', /href="\/report-deck\.css"/.test(html) && /src="\/report-deck\.js"/.test(html) && /id="deck-btn"/.test(html));
  check('★ 原本的「列印 / 存 PDF」還在（簡報不取代文件版，列印是給紙本與 PDF 用的）', /onclick="window\.print\(\)"/.test(html));
  check('簡報用的資料就是報告頁已載入的那一份（沒有另外打 API）', /ReportDeck\.open\(\{\s*analytics: ANALYTICS, exposure: EXPOSURE, training: TRAINING/.test(html) && !/fetch\(/.test(src));
  check('每題分鐘數與報告頁輸入框雙向同步', /onMinChange/.test(html) && /onMinChange/.test(src));
  check('網址帶 #deck 開啟報告時直接進簡報（可傳連結給長官）', /\^#deck/.test(html));
  check('列印時簡報不印出來', /@media print \{ #rd-wrap \{ display: none !important; \} \}/.test(read('public/report-deck.css')));
  check('鍵盤：方向鍵換頁；拖滑桿時左右鍵不換頁；Esc 關閉', /ArrowRight/.test(src) && /tag === 'INPUT'/.test(src) && /k === 'Escape'/.test(src));
  check('關掉簡報會還原網址、焦點與頁面捲動', /replaceState\(null, '', location\.pathname \+ location\.search\)/.test(src) && /document\.body\.style\.overflow = deck\.prevOverflow/.test(src) && /opener\.focus/.test(src));
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（維持 10 個，批次 177、178 多了 cron_remind 三班）、rewrite（17 條）', vj.crons.length === 10 && vj.rewrites.length === 17, `${vj.crons.length}/${vj.rewrites.length}`);
  check('沒有新增 Function（api/ 仍是 11 支，Hobby 上限 12）', fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js')).length === 11);
  check('簡報沒有寫死任何成效數字（程式裡沒有「N 題／N 家／N 場」這種具體數字句）', !/['"][^'"]*\b\d{2,}\s*(題|家媒體|則|場)/.test(src.replace(/\/\/.*$/gm, '')));
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
