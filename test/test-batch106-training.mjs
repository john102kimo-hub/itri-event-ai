// 批次 106（主管訓練通盤檢討）回歸測試。跑真的 api/training.js，只有 Google Sheets 與模型是假的；
// 訓練頁（public/training.html）用「把函式抽出來在假 DOM 上跑」。
//   一、活動選擇器：分「接下來要辦」「已辦完」、日期近的在前、每顆按鈕寫出日期與狀態；與後台共用同一套排序
//   二、選了單場活動之後，頁首要寫出是哪一場
//   三、彙整訓練的素材：只收真的有內容的、日期近的優先、有長度上限
//   四、AI 記者的「真實提問」素材：不含測試資料、同仁自己問的、已刪除的
//   五、模型出錯時主管看到中文，不是 API 原文
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TRAIN = read('public/training.html');
const INDEX = read('public/index.html');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function fnSource(html, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (!m) throw new Error('找不到函式 ' + name);
  const eol = html.indexOf('\n', m.index);
  const first = html.slice(m.index, eol);
  if (/\}\s*$/.test(first) && first.split('{').length === first.split('}').length) return first + '\n';
  return html.slice(m.index, html.indexOf('\n}\n', m.index) + 2);
}
const constLine = (html, re) => { const m = re.exec(html); if (!m) throw new Error('找不到 ' + re); return m[0]; };
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
}

// ═══ 一、活動選擇器 ═══════════════════════════════════════════════════════════
console.log('\n── 一、活動選擇器：像後台一樣分兩區、日期近的在前，按鈕寫出日期與狀態 ──');
const MIRROR = ['eventDateIso', 'daysBetween', 'shortDateLabel', 'eventSections', 'todayTaipeiIso'];
{
  const same = MIRROR.filter((n) => fnSource(TRAIN, n) !== fnSource(INDEX, n));
  check('★ 排序與日期的函式與後台（public/index.html）逐字相同——兩邊的「接下來要辦」不會各說各話', same.length === 0, same.join('、'));
  check('　 星期的對照表也相同', constLine(TRAIN, /const WEEKDAYS = \[[^\]]*\];/) === constLine(INDEX, /const WEEKDAYS = \[[^\]]*\];/));
}
const mkEl = (tag = 'div') => ({
  tag, children: [], style: { cssText: '' }, textContent: '', className: '', type: '', onclick: null, onmouseover: null, onmouseout: null, removed: false,
  appendChild(c) { this.children.push(c); c.parent = this; return c; },
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
  insertAdjacentElement(where, el) { this.inserted = [where, el]; return el; }
});
const flat = (el) => [el, ...el.children.flatMap(flat)];
const buttons = (root) => flat(root).filter((e) => e.tag === 'button');
{
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
  const document = { getElementById: getEl, createElement: mkEl, title: '' };
  const state = { eventName: '工研院活動', eventId: null, hist: [], offered: 0, last: 0, url: '' };
  const src = [constLine(TRAIN, /const WEEKDAYS = \[[^\]]*\];/), ...MIRROR.map((n) => fnSource(TRAIN, n)), fnSource(TRAIN, 'eventMeta'), 'const PAST_SHOWN = 3;',
    fnSource(TRAIN, 'showEventSelector'), fnSource(TRAIN, 'createSelectorBtn'), fnSource(TRAIN, 'selectEvent')].join('\n');
  const api = new Function('document', 'history', 'renderLastSession', 'offerResume',
    `let eventName = '工研院活動'; let eventId = null;\n${src}\nreturn { showEventSelector, selectEvent, eventMeta, get eventName() { return eventName; }, get eventId() { return eventId; } };`)(
    document, { replaceState(a, b, u) { state.url = u; } }, () => { state.last++; }, () => { state.offered++; });

  const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const events = [
    { id: 'old', name: 'A 舊的已結束', status: 'ended', event_date: iso(-60) },
    { id: 'nodate', name: 'B 沒填日期', status: 'active', event_date: '' },
    { id: 'far', name: 'C 下個月', status: 'draft', event_date: iso(30), has_kb: true, missing: ['地點'] },
    { id: 'near', name: 'D 這禮拜', status: 'active', event_date: iso(3), has_kb: true, missing: [] },
    { id: 'stamp', name: 'E 建立時間戳', status: 'active', event_date: '2026/6/18 下午11:06:04' },
    { id: 'older', name: 'F 更舊', status: 'ended', event_date: iso(-120) },
    { id: 'o3', name: 'G', status: 'ended', event_date: iso(-30) },
    { id: 'o4', name: 'H', status: 'ended', event_date: iso(-45) },
    { id: 'empty', name: 'I 草稿沒新聞稿', status: 'draft', event_date: iso(10), has_kb: true, missing: ['新聞稿'] }
  ];
  api.showEventSelector(events);
  const box = els.get('info-card').inserted[1];
  els.set('event-selector', box);   // 真的 DOM 裡 container.id 會讓 getElementById 找得到它
  const btns = buttons(box);
  const label = (b) => b.textContent;
  const names = btns.filter((b) => b.onclick).map((b) => b.children.length ? b.textContent : b.textContent);
  const order = btns.map((b) => b.textContent.replace(/^📋 /, '')).filter((t) => !/顯示全部/.test(t));
  check('★ 第一顆是彙整訓練；單場活動「接下來要辦」的在前、日期近的先，日期未定的排最後——這禮拜要練的不用捲到最底下找', /彙整訓練/.test(order[0]) && order.slice(1, 6).join('|') === 'D 這禮拜|I 草稿沒新聞稿|C 下個月|B 沒填日期|E 建立時間戳', order.join(' / '));
  check('　 日期未定（含只有建立時間戳的）排在有日期的後面', order.indexOf('B 沒填日期') > order.indexOf('C 下個月') && order.indexOf('E 建立時間戳') > order.indexOf('C 下個月'));
  const sub = (name) => { const b = btns.find((x) => x.textContent.includes(name)); return b ? b.children.map((c) => c.textContent).join('') : ''; };
  check('★ 每顆按鈕第二行寫日期：這禮拜那場「還有 3 天」', /還有 3 天/.test(sub('D 這禮拜')), sub('D 這禮拜'));
  check('　 未發布的標「未發布」，已結束的標「已結束」，沒日期的標「日期未定」', /未發布/.test(sub('C 下個月')) && /已結束/.test(sub('G')) && /日期未定/.test(sub('B 沒填日期')), JSON.stringify([sub('C 下個月'), sub('B 沒填日期')]));
  check('★ 還沒有新聞稿的活動明講「題目會比較空泛」（不是練了半天才發現）', /還沒有新聞稿/.test(sub('I 草稿沒新聞稿')) && !/還沒有新聞稿/.test(sub('D 這禮拜')), sub('I 草稿沒新聞稿'));
  check('★ 已辦完只先顯示最近 3 場，其餘收在「顯示全部 4 場」後面（十幾場活動不會是一長串）', btns.some((b) => /顯示全部 4 場/.test(b.textContent)) && order.filter((t) => /^[AFGH]/.test(t)).length === 3 && order.filter((t) => /^[AFGH]/.test(t))[0] === 'G', order.join(' / '));
  const more = btns.find((b) => /顯示全部/.test(b.textContent));
  more.onclick();
  check('　 按了展開 → 剩下的也出現、「顯示全部」那顆消失', buttons(box).filter((b) => /^📋 [AFGH]/.test(b.textContent)).length === 4 && !buttons(box).some((b) => /顯示全部/.test(b.textContent)));
  check('　 已辦完的最近辦的在前（G 30 天前 → H 45 天前 → A 60 天前 → F 120 天前）', buttons(box).filter((b) => /^📋 [AFGH]/.test(b.textContent)).map((b) => b.textContent.replace(/^📋 /, '')[0]).join('') === 'GHAF', buttons(box).map((b) => b.textContent).join('|'));

  // 選了活動之後
  const pick = btns.find((b) => b.textContent.includes('D 這禮拜'));
  pick.onclick();
  check('★ 選了單場活動後：頁首與分頁標題寫出是哪一場（以前選了還是「媒體訓練模式」，同時開幾個分頁時分不出來）', document.getElementById('event-title').textContent === 'D 這禮拜 — 媒體訓練' && document.title === 'D 這禮拜 — 媒體訓練' && api.eventId === 'near', JSON.stringify([document.getElementById('event-title').textContent, document.title]));
  check('　 網址同步成這一場（重新整理接得回來），選擇器收掉、顯示開始區', state.url === '/training?id=near' && box.removed === true && document.getElementById('start-area').style.display === 'flex' && state.last === 1 && state.offered === 1);
  api.selectEvent('all');
  check('彙整訓練：頁首寫「彙整媒體訓練 — 全部活動」', /彙整媒體訓練/.test(document.getElementById('event-title').textContent) && document.title === '彙整媒體訓練');

  const none = (() => { const e2 = new Map(); const d2 = { getElementById: (id) => { if (!e2.has(id)) e2.set(id, mkEl()); return e2.get(id); }, createElement: mkEl };
    const a2 = new Function('document', `let eventName = ''; let eventId = null; ${src} return { showEventSelector };`)(d2, {}, () => {}, () => {}); a2.showEventSelector([]); return e2.get('info-card').inserted[1]; })();
  check('一場活動都沒有 → 說明可以先用彙整訓練，不是一片空白', flat(none).some((e) => /沒有可以練習的單場活動/.test(e.textContent)));
}

// ═══ 二、手機上的打字提示 ═════════════════════════════════════════════════════
console.log('\n── 二、手機：打字框提示不再折成兩行被切掉 ──');
{
  check('★ 打字框預設提示只有「輸入您的回答…」；Enter／Shift+Enter 的鍵盤提示只給有實體鍵盤的裝置', /<textarea id="user-input" rows="1" placeholder="輸入您的回答…" disabled>/.test(TRAIN) && /\(pointer: coarse\)[\s\S]{0,200}Shift\+Enter/.test(TRAIN));
}

// ═══ 三、彙整訓練的素材 ═══════════════════════════════════════════════════════
console.log('\n── 三、彙整訓練：只收真的有內容的、日期近的優先、有長度上限 ──');
const T = await import('../api/training.js');
const { KB_TEMPLATE } = await import('../lib/kb-template.js');
const REAL = (t) => `【新聞稿全文】\n${t}`;
const evRow = (id, name, status, date, kb, code = 'cc') => [id, name, '#0F9E7A', kb, status, date, '', '', '', '工研院', code];
{
  const rows = [
    evRow('a', '舊的記者會', 'ended', '2026-05-01', REAL('舊的內容 AAA')),
    evRow('b', '新的記者會', 'active', '2026-10-20', REAL('新的內容 BBB')),
    evRow('c', '只有範本的草稿', 'draft', '2026-10-25', KB_TEMPLATE),
    evRow('d', '已封存', 'archived', '2026-10-01', REAL('封存的 DDD')),
    evRow('e', '沒日期', 'active', '', REAL('沒日期 EEE')),
    evRow('f', '建立時間戳', 'active', '2026/6/18 下午11:06:04', REAL('時間戳 FFF'))
  ];
  const r = T.buildAllEventsKnowledge(rows);
  check('★ 彙整素材不含：只有範本沒填內容的草稿、已封存的', !/只有範本/.test(r.knowledge_base) && !/封存的 DDD/.test(r.knowledge_base) && !r.names.includes('只有範本的草稿') && !r.names.includes('已封存'), r.names.join('、'));
  check('★ 日期近的在前（新的 → 舊的），沒有日期（含只有建立時間戳）的排最後', r.names.join('、') === '新的記者會、舊的記者會、沒日期、建立時間戳' || r.names.join('、') === '新的記者會、舊的記者會、建立時間戳、沒日期', r.names.join('、'));
  const big = Array.from({ length: 30 }, (_, i) => evRow('e' + i, `活動${i}`, 'active', `2026-09-${String(i % 28 + 1).padStart(2, '0')}`, REAL('字'.repeat(9000))));
  const rb = T.buildAllEventsKnowledge(big);
  check('★ 每場最多 6000 字、全部加起來最多 60000 字（活動愈辦愈多，不會讓每次出題與評分愈來愈慢、愈來愈貴）', rb.names.length >= 8 && rb.names.length <= 10 && rb.knowledge_base.length <= T.ALL_TOTAL_MAX + 100 && !/字{6001}/.test(rb.knowledge_base), `names=${rb.names.length} len=${rb.knowledge_base.length}`);
  check('　 超過上限而沒帶進去的場數有算出來', rb.skipped === 30 - rb.names.length && rb.skipped > 0, `skipped=${rb.skipped}`);
  check('　 全部都沒內容 → 「（無活動資料）」，不是空字串', T.buildAllEventsKnowledge([evRow('x', 'x', 'draft', '', KB_TEMPLATE)]).knowledge_base === '（無活動資料）');
}

// ═══ 模型假的：記下收到的 system prompt ═══════════════════════════════════════
const modelCalls = [];
let modelStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(opts.body);
    modelCalls.push({ system: (body.system || []).map((b) => b.text).join('\n'), messages: body.messages });
    if (modelStatus !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: modelStatus, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '您好，我是經濟日報的王記者。請問何時量產？' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const training = (await import('../api/training.js')).default;
const callTraining = async (body) => { const r = fakeRes(); await training({ method: 'POST', headers: {}, query: {}, body: { password: 'pw', messages: [], mode: 'reporter', ...body } }, r); return r; };

// ═══ 四、真實提問素材 ═════════════════════════════════════════════════════════
console.log('\n── 四、AI 記者的「真實提問」素材：不含測試資料、同仁自己問的、已刪除的 ──');
{
  reset();
  book.events = [['id'], evRow('real-q', '素材測試場', 'active', '2026-10-01', REAL('素材測試的內容'))];
  const qa = (event, media, q, deleted = '', source = 'web') => ['2026/9/23 上午10:00:00', event, '活動', media, q, '答', deleted, source];
  book.qa_log = [['timestamp', 'event_id', 'event_name', 'media_name', 'question', 'answer', 'deleted', 'source'],
    qa('real-q', '經濟日報', '記者真的問過的問題甲'),
    qa('real-q', '聯合報', '記者真的問過的問題乙'),
    qa('real-q', 'test', '測試資料的問題丙丙丙'),
    qa('real-q', '（內部職員）', '同仁自己試問的問題丁丁丁', '', 'line'),
    qa('real-q', '中央社', '已被刪除的問題戊戊戊', '1'),
    qa('real-q', '（群組提問）', '群組裡記者問的問題己己己', '', 'line'),
    qa('other-ev', '工商時報', '其他場次記者問的問題庚庚庚')
  ];
  modelCalls.length = 0;
  const r = await callTraining({ event_id: 'real-q' });
  const sys = modelCalls[0]?.system || '';
  check('（前置）出題成功', r.statusCode === 200 && /王記者/.test(r.body.reply || ''), JSON.stringify(r.body));
  check('★ 真的被問過的問題進得了出題素材（本場與其他場次都有）', /問題甲/.test(sys) && /問題乙/.test(sys) && /問題庚庚庚/.test(sys));
  check('★ 測試資料、同仁在 LINE 職員模式自己問的、已刪除的，不會被當成「記者最關心的角度」餵給 AI 記者', !/丙丙丙/.test(sys) && !/丁丁丁/.test(sys) && !/戊戊戊/.test(sys), sys.slice(sys.indexOf('記者實際問過'), sys.indexOf('記者實際問過') + 400));
  check('　 LINE 群組裡記者問的是真實提問，照樣收', /己己己/.test(sys));
}

// ═══ 彙整訓練端到端 ═══════════════════════════════════════════════════════════
{
  reset();
  book.events = [['id'],
    evRow('b', '新的記者會', 'active', '2026-10-20', REAL('新的內容 BBB')),
    evRow('c', '只有範本的草稿', 'draft', '2026-10-25', KB_TEMPLATE),
    evRow('d', '已封存', 'archived', '2026-10-01', REAL('封存的 DDD'))];
  book.qa_log = [['timestamp']];
  modelCalls.length = 0;
  const r = await callTraining({ event_id: 'all' });
  const sys = modelCalls[0]?.system || '';
  check('彙整訓練端到端：帶了有內容的活動，沒帶範本草稿與封存的；活動名稱不再是一長串', r.statusCode === 200 && /BBB/.test(sys) && !/DDD/.test(sys) && !/只有範本/.test(sys) && /工研院彙整訓練（新的記者會）/.test(sys), sys.slice(0, 200));
}

// ═══ 五、模型出錯時主管看到中文 ═══════════════════════════════════════════════
console.log('\n── 五、模型出錯：主管看到的是中文與下一步，不是 API 原文 ──');
{
  const origError = console.error;
  console.error = () => {};   // 後端照實把 API 原文寫進 log；測試輸出不需要那幾行
  reset();
  book.events = [['id'], evRow('err-ev', '出錯場', 'active', '2026-10-01', REAL('內容'))];
  book.qa_log = [['timestamp']];
  for (const st of [529, 429, 503]) {
    modelStatus = st;
    const r = await callTraining({ event_id: 'err-ev' });
    check(`★ 模型回 ${st}：訓練頁收到中文說明（含「再試一次」），沒有「Overloaded」`, r.statusCode === st && /再試一次/.test(r.body.error) && !/Overloaded|overloaded/.test(JSON.stringify(r.body)) && /[一-鿿]/.test(r.body.error), JSON.stringify(r.body));
  }
  modelStatus = 400;
  const r4 = await callTraining({ event_id: 'err-ev' });
  check('　 其他錯誤（400）一樣是中文，並請他通知管理員', r4.statusCode === 400 && /再試一次/.test(r4.body.error) && /管理員/.test(r4.body.error) && !/invalid_request|Overloaded/.test(JSON.stringify(r4.body)), JSON.stringify(r4.body));
  modelStatus = 200;
  check('　 原文照樣寫進 log（除錯用的資訊不少）', /console\.error\('training Anthropic API 錯誤:'/.test(read('api/training.js')));
  console.error = origError;
}

globalThis.fetch = realFetch;
console.log(`\n${fail ? '❌' : '✅'} 批次 106（主管訓練）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
