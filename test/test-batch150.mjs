// 批次 150：主管訓練的逐題紀錄（training_qa），後台「問答分析」有一個「主管訓練」分頁看它。
//   一、log_session 帶 turns → 另存一張 training_qa（題目、回答、分數、是否語音）；沒帶 turns 的舊行為一個字不變
//   二、內容的上限與清理：題數、字數、分數範圍；沒有題目的丟掉
//   三、逐題紀錄寫不進去，不影響演練紀錄、不讓主管看到錯誤
//   四、後台 qa_list：只有管理員、最新在前、可依活動篩、統計數字
//   五、不混進記者的問答（qa_log）：統計、待教清單、媒體訓練出題都讀不到它
//   六、頁面：訓練頁送出逐題內容並告知、後台分頁有跳脫、切分頁會藏掉只屬於記者問答的控制項
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
process.env.ADMIN_PASSWORD = 'pw'; process.env.ANTHROPIC_API_KEY = 'x'; process.env.GOOGLE_SPREADSHEET_ID = 's';
process.env.EVENTS_TABLE_TTL_MS = '0';
const S = await import('./fakes-sheets82.mjs');
const training = (await import('../api/training.js')).default;
const T = await import('../api/training.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.end = () => r; return r; };
let n = 0;
const post = async (body, headers = { 'x-admin-password': 'pw' }) => { const r = res(); await training({ method: 'POST', headers: { 'x-forwarded-for': `10.150.0.${++n}`, ...headers }, query: {}, body, socket: {} }, r); return r; };
const get = async (query, headers = { 'x-admin-password': 'pw' }) => { const r = res(); await training({ method: 'GET', headers: { 'x-forwarded-for': `10.150.1.${++n}`, ...headers }, query, socket: {} }, r); return r; };
const events = () => [['id'], ['e1', '智慧醫療記者會', '', '【新聞稿】內容', 'active', '2026-10-01', '', '', '', '', 'CODE1'], ['e2', '半導體論壇', '', '【新聞稿】內容', 'active', '2026-10-02', '', '', '', '', 'CODE2']];
// 模組層級的「分頁已建好」旗標不會跟著 S.reset() 清掉，所以每次 reset 後自己把表頭補回來
const QA_HEAD = ['timestamp', 'event_id', 'event_name', 'trainee', 'q_no', 'question', 'answer', 'score', 'voice'];
const LOG_HEAD = ['timestamp', 'event_id', 'event_name', 'trainee', 'question_count', 'avg_score', 'scores', 'note'];
const fresh = () => { S.reset(); S.book.events = events(); S.book.training_log = [LOG_HEAD]; S.book.training_qa = [QA_HEAD]; };
const turns = (k = 3) => Array.from({ length: k }, (_, i) => ({ q: `第 ${i + 1} 題：量產時程？`, a: `回答 ${i + 1}：預計明年。`, score: 6 + i, voice: i === 0 }));

/* ───────── 一、log_session 帶 turns ───────── */
console.log('\n── 一、逐題紀錄 ──');
fresh();
{
  const r = await post({ mode: 'log_session', event_id: 'e1', trainee: '王處長', scores: [6, 7, 8], voice_answers: 1, turns: turns() });
  check('log_session 成功，平均分照舊由後端算', r.statusCode === 200 && r.body.success && r.body.avg_score === 7, JSON.stringify(r.body));
  const log = (S.book.training_log || []).slice(1);
  check('★ training_log 的列跟以前一模一樣（8 欄、分數、語音註記）', log.length === 1 && log[0].length === 8 && log[0][3] === '王處長' && log[0][6] === '6|7|8' && log[0][7] === '語音作答 1/3 題', JSON.stringify(log));
  const qa = S.book.training_qa || [];
  check('另存 training_qa：表頭 9 欄', qa[0] && qa[0].join(',') === 'timestamp,event_id,event_name,trainee,q_no,question,answer,score,voice', JSON.stringify(qa[0]));
  check('　 三題各一列：題號、題目、回答、分數、語音', qa.length === 4 && qa[1][4] === '1' && qa[1][5] === '第 1 題：量產時程？' && qa[1][6] === '回答 1：預計明年。' && qa[1][7] === '6' && qa[1][8] === '1' && qa[3][7] === '8' && qa[3][8] === '', JSON.stringify(qa.slice(1)));
  check('　 受訓者、活動名稱每列都帶', qa.slice(1).every((x) => x[1] === 'e1' && x[2] === '智慧醫療記者會' && x[3] === '王處長'));
}
fresh(); delete S.book.training_qa;
{
  const r = await post({ mode: 'log_session', event_id: 'e1', trainee: '林副總', scores: [5, 6] });
  check('★ 沒帶 turns（舊版頁面、快取沒更新的手機）→ 跟以前一樣，只記 training_log，不碰 training_qa', r.statusCode === 200 && (S.book.training_log || []).filter((x) => x[3] === '林副總').length === 1 && !S.book.training_qa, Object.keys(S.book).join(','));
}

/* ───────── 二、上限與清理 ───────── */
console.log('\n── 二、內容上限與清理 ──');
{
  const rows = T.buildTrainingQaRows([
    { q: 'Q'.repeat(2000), a: 'A'.repeat(9000), score: 99 },
    { q: '', a: '沒有題目的丟掉', score: 5 },
    { q: '  第二題\r\n  ', a: ' 回答 ', score: 'x', voice: 'yes' },
    { q: '第三題', a: '', score: null },
    null, 'oops', { q: '負分', a: 'a', score: -1 }
  ], { timestamp: 't', eventId: 'e1', eventName: '名', trainee: '某人' });
  check('題目 600 字、回答 3000 字封頂', rows[0][5].length === 600 && rows[0][6].length === 3000);
  check('★ 分數不在 0–10 或不是數字 → 空白，不亂寫', rows[0][7] === '' && rows[1][7] === '' && rows[2][7] === '' && rows[3][7] === '');
  check('　 沒有題目的丟掉；沒有回答的題目留著（主管可能跳過）；換行與空白整理過', rows.length === 4 && rows[1][5] === '第二題' && rows[2][6] === '' && rows[1][8] === '1', JSON.stringify(rows.map((x) => x.slice(4))));
  check('　 題號是它在這場演練裡真正的題號（中間丟掉一題，不會讓後面的題號往前補）', rows.map((x) => x[4]).join() === '1,3,4,7', rows.map((x) => x[4]).join());
  const many = T.buildTrainingQaRows(Array.from({ length: 40 }, (_, i) => ({ q: 'q' + i, a: 'a' })), { timestamp: 't', eventId: 'e', eventName: 'n', trainee: 'x' });
  check('　 一場最多收 10 題（防止有人亂送一大包）', many.length === 10);
  check('　 turns 不是陣列 → 空陣列，不丟錯', T.buildTrainingQaRows(undefined, {}).length === 0 && T.buildTrainingQaRows('x', {}).length === 0 && T.buildTrainingQaRows({}, {}).length === 0);
}

/* ───────── 三、寫不進去不影響演練紀錄 ───────── */
console.log('\n── 三、逐題紀錄寫失敗 ──');
{
  S.reset(); S.book.events = events();
  await post({ mode: 'log_session', event_id: 'e1', trainee: '甲', scores: [7], turns: turns(1) }); // 先跑一次，表都建好了
  S.calls.length = 0; S.ctl.failWrites = 2; // 之後每次只有兩次寫入：training_log、training_qa；讓第二次失敗
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  const r = await post({ mode: 'log_session', event_id: 'e1', trainee: '乙', scores: [8], turns: turns(1) });
  console.error = orig; S.ctl.failWrites = 0;
  check('★ training_qa 寫失敗：這場演練照樣成功（200、分數回得來），主管不會看到錯誤', r.statusCode === 200 && r.body.success && r.body.avg_score === 8, JSON.stringify(r.body));
  check('　 training_log 那一列有寫進去；錯誤記進 log', (S.book.training_log || []).some((x) => x[3] === '乙') && logs.some((l) => /training_qa 寫入失敗/.test(l)), JSON.stringify(logs));
  check('　 失敗的那一場沒有留下半套逐題紀錄', !(S.book.training_qa || []).some((x) => x[3] === '乙'));
}

/* ───────── 四、qa_list ───────── */
console.log('\n── 四、後台 qa_list ──');
fresh();
await post({ mode: 'log_session', event_id: 'e1', trainee: '王處長', scores: [6, 7, 8], turns: turns(3) });
await post({ mode: 'log_session', event_id: 'e2', trainee: ' 王 處長 ', scores: [9], turns: [{ q: '半導體題', a: '回答', score: 9 }] });
await post({ mode: 'log_session', event_id: 'e1', trainee: '林副總', scores: [null], turns: [{ q: '沒評到分的一題', a: '', score: null }] });
{
  const r = await get({ action: 'qa_list' });
  check('管理員 → 200；總題數、受訓者數（空白不計，王處長算一位）、平均分只算有分數的', r.statusCode === 200 && r.body.total === 5 && r.body.trainees === 2 && r.body.avg_score === 7.5, JSON.stringify({ t: r.body.total, tr: r.body.trainees, a: r.body.avg_score }));
  check('★ 最新的在前', r.body.rows[0].question === '沒評到分的一題' && r.body.rows[r.body.rows.length - 1].question === '第 1 題：量產時程？', r.body.rows.map((x) => x.question).join('|'));
  check('　 沒評到分 → score 是 null；語音旗標是布林', r.body.rows[0].score === null && r.body.rows.find((x) => x.no === 1 && x.event_id === 'e1' && x.trainee === '王處長').voice === true);
  const e2 = await get({ action: 'qa_list', event_id: 'e2' });
  check('依活動篩', e2.body.total === 1 && e2.body.rows[0].question === '半導體題' && e2.body.rows[0].event_name === '半導體論壇');
  const lim = await get({ action: 'qa_list', limit: '2' });
  check('limit 只限制回傳筆數；總數照實回報', lim.body.rows.length === 2 && lim.body.total === 5);
  const huge = await get({ action: 'qa_list', limit: '99999' });
  check('　 limit 上限 500、亂填的退回預設', huge.statusCode === 200 && (await get({ action: 'qa_list', limit: 'abc' })).body.rows.length === 5);
  const noPw = await get({ action: 'qa_list' }, {});
  const wrong = await get({ action: 'qa_list' }, { 'x-admin-password': 'nope' });
  check('★ 沒帶密碼、密碼錯 → 401，不洩漏任何題目或回答', noPw.statusCode === 401 && wrong.statusCode === 401 && !noPw.body.rows && !wrong.body.rows, JSON.stringify([noPw.statusCode, wrong.statusCode]));
  const withCode = await get({ action: 'qa_list', event_id: 'e1', code: 'CODE1' }, {});
  check('　 單場的編輯碼也不行（這是給公關看的後台，不是給受訓者）', withCode.statusCode === 401);
  S.reset(); delete S.book.training_qa;
  const empty = await get({ action: 'qa_list' });
  check('　 表還不存在 → 空清單，不是 500', empty.statusCode === 200 && empty.body.total === 0 && empty.body.rows.length === 0 && empty.body.avg_score === null);
}

/* ───────── 五、不混進記者的問答 ───────── */
console.log('\n── 五、不混進記者的問答 ──');
{
  const users = [];
  for (const dir of ['lib', 'api']) for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.js') && /training_qa/.test(read(`${dir}/${f}`))) users.push(`${dir}/${f}`);
  check('★ 整個程式裡只有 api/training.js 碰 training_qa（qa_log 的統計、待教清單、露出交叉分析、助理、匯出都不會看到它）', users.join() === 'api/training.js', users.join());
  fresh();
  await post({ mode: 'log_session', event_id: 'e1', trainee: '王處長', scores: [6], turns: [{ q: '這部分我沒有資料嗎', a: '這部分我沒有資料', score: 6 }] });
  check('　 演練的內容（甚至剛好寫著「沒有資料」）沒有寫進 qa_log', !S.book.qa_log);
}

/* ───────── 六、頁面 ───────── */
console.log('\n── 六、頁面 ──');
{
  const tr = read('public/training.html');
  check('訓練頁：log_session 帶上每一題的題目、回答、分數、語音', /turns:\s*collectRounds\(\)\.map\(\(r\) => \(\{ q: r\.q, a: r\.a, score: r\.score, voice: r\.voice \}\)\)/.test(tr));
  check('★ 訓練頁事先告知：題目、回答和分數會記在後台（不能偷偷記）', /基本資料[\s\S]{0,400}題目、您的回答和分數會記在後台/.test(tr));
  const idx = read('public/index.html');
  const fn = (idx.match(/function renderTrainingList\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  check('後台「問答分析」有兩個分頁：記者與廠商問答／主管訓練', /id="atab-qa"/.test(idx) && /id="atab-training"/.test(idx) && /qa_list/.test(idx));
  check('★ 主管訓練列表：題目、回答、受訓者、活動名稱一律 escHtml（回答是使用者端送來的文字）',
    fn.length > 100 && ['r.question', 'r.answer', 'r.trainee', 'r.event_name'].every((v) => new RegExp(`escHtml\\(${v.replace('.', '\\.')}`).test(fn)) && !/\$\{r\.(question|answer|trainee|event_name)\}/.test(fn), fn.slice(0, 200));
  check('　 切到主管訓練 → 記者問答才有的控制項（排除測試、只看答不出來、匯出 CSV）藏起來', (idx.match(/class="[^"]*\bqa-only\b/g) || []).length === 3 && /querySelectorAll\('#view-analytics \.qa-only'\)/.test(idx));
  check('　 從活動卡點「問答分析」→ 回到記者問答分頁（不是停在上次看的主管訓練）', /function showAnalyticsByEvent[\s\S]{0,200}setAnalyticsTab\('qa', \{ load: false \}\)/.test(idx));
  check('　 搜尋框在兩個分頁都能用（renderQaList 依分頁分流）', /function renderQaList\(\) \{\s*if \(state\.analyticsTab === 'training'\) return renderTrainingList\(\)/.test(idx));
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 還是 11 支（Vercel Hobby 上限 12；qa_list 掛在原本的 api/training.js）', fns.length === 11);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 150 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
