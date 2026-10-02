// 批次 104（B 批）後台與同仁編輯頁的前端回歸測試。
// public/*.html 是靜態頁、沒辦法 import，這裡的做法是「把函式原始碼抽出來，在假的 DOM 上真的執行」，
// 不是只比對字串——字串比對抓不到「寫了但沒接上」的錯。
//   一、活動分區與排序（沒填日期的活動不再浮到最上面、兩種日期格式混排、台灣時間）
//   二、活動卡片（缺什麼直接寫在卡片上、按鈕數量、危險操作收進「更多」）
//   三、發布前必填檢查列與發布被擋的流程（後台、同仁編輯頁）
//   四、知識庫「有沒有填」的判斷：後端與兩頁的鏡射結果一致
//   五、問答分析清單（搜尋、只看答不出來、姓名）與手機版版面
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INDEX = read('public/index.html');
const EDIT = read('public/edit.html');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}

// ── 抽函式：從靜態頁的 <script> 裡把「頂層函式」與指定的頂層常數整段抽出來 ──────────
function fnSource(html, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (!m) throw new Error('找不到函式 ' + name);
  // 一行寫完的函式（`function f() { ... }`）整行就是它；多行的到下一個頂格的 `}` 為止
  const eol = html.indexOf('\n', m.index);
  const first = html.slice(m.index, eol);
  if (/\}\s*$/.test(first) && first.split('{').length === first.split('}').length) return first + '\n';
  return html.slice(m.index, html.indexOf('\n}\n', m.index) + 2);
}
function constSource(html, re) {
  const m = re.exec(html);
  if (!m) throw new Error('找不到 ' + re);
  return m[0];
}
function load(html, names, extraSrc, vars) {
  const src = [...(extraSrc || []), ...names.map((n) => fnSource(html, n))].join('\n');
  const keys = Object.keys(vars || {});
  return new Function(...keys, `${src}\n; return { ${names.join(', ')} };`)(...keys.map((k) => vars[k]));
}

// ── 假的 DOM：getElementById 永遠回得出東西，值與 class 都記得住 ─────────────────
function makeDom(values = {}) {
  const els = new Map();
  const mk = (id) => {
    const cls = new Set();
    const el = {
      id, value: values[id] ?? '', checked: false, style: {}, dataset: {}, innerHTML: '', textContent: '', className: '', disabled: false,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      scrollIntoView() { el.scrolled = true; },
      addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => []
    };
    el.cls = cls;
    return el;
  };
  const document = { getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); }, querySelector: () => null, querySelectorAll: () => [] };
  return { document, els, el: (id) => document.getElementById(id) };
}
const noTimers = () => 0;   // highlightMissing 會 setTimeout 幾秒後拿掉框線，測試裡不要真的等

// ═══ 一、活動分區與排序 ═══════════════════════════════════════════════════════
console.log('\n── 一、活動分區與排序：沒填日期的不再浮到最上面，兩種日期格式照真正的日期排 ──');
const WEEKDAYS_SRC = constSource(INDEX, /const WEEKDAYS = \[[^\]]*\];/);
const sec = load(INDEX, ['eventDateIso', 'daysBetween', 'shortDateLabel', 'eventSections', 'dateMetaHtml'], [WEEKDAYS_SRC], {});
{
  const T = '2026-10-02';
  const ev = (id, status, date, name) => ({ id, status, event_date: date, name: name || id });
  const list = [
    ev('undated', 'active', ''),
    ev('stamp', 'active', '2026/6/18 下午11:06:04'),     // 系統寫的建立時間戳，不是活動日期
    ev('slash', 'draft', '2026/10/5'),
    ev('iso20', 'draft', '2026-10-20'),
    ev('today', 'active', '2026-10-02'),
    ev('old-active', 'active', '2026-09-01'),             // 日期過了、狀態還是進行中
    ev('ended1', 'ended', '2026-08-01'),
    ev('ended2', 'ended', '2026-09-20'),
    ev('arch', 'archived', '2026-05-01')
  ];
  const r = sec.eventSections(list, T);
  const ids = (a) => a.map((e) => e.id).join(',');
  check('★ 接下來要辦：日期近的在前、「2026/10/5」與「2026-10-20」照真正日期排，日期未定的排最後', ids(r.upcoming) === 'today,slash,iso20,stamp,undated' || ids(r.upcoming) === 'today,slash,iso20,undated,stamp', ids(r.upcoming));
  check('★ 沒填日期（含只有建立時間戳）的活動不會排在有日期的活動前面', ['undated', 'stamp'].every((id) => r.upcoming.findIndex((e) => e.id === id) > r.upcoming.findIndex((e) => e.id === 'iso20')), ids(r.upcoming));
  check('已辦完／已過期：已結束，或日期已過；最近辦的在最上面', ids(r.past) === 'ended2,old-active,ended1', ids(r.past));
  check('已封存自己一區，不混進其他兩區', ids(r.archived) === 'arch' && !ids(r.upcoming).includes('arch') && !ids(r.past).includes('arch'));
  check('系統寫的建立時間戳不是活動日期：eventDateIso 回空字串（跟後端發布閘門同一條規則）',
    sec.eventDateIso({ event_date: '2026/6/18 下午11:06:04' }) === '' && sec.eventDateIso({ event_date: '2026-10-05 10:00:00' }) === '');
  check('純日期兩種寫法都認，月日補零', sec.eventDateIso({ event_date: '2026/10/5' }) === '2026-10-05' && sec.eventDateIso({ event_date: '2026-10-05' }) === '2026-10-05');

  check('日期那一行：日期未定 → 橘字「日期未定」', /日期未定/.test(sec.dateMetaHtml(ev('a', 'active', ''), T)));
  check('日期那一行：今天', /10\/2（五）.*今天/.test(sec.dateMetaHtml(ev('a', 'active', '2026-10-02'), T)), sec.dateMetaHtml(ev('a', 'active', '2026-10-02'), T));
  check('日期那一行：還有 3 天', /還有 3 天/.test(sec.dateMetaHtml(ev('a', 'active', '2026-10-05'), T)));
  check('日期那一行：已結束的活動不再寫「還有幾天」，過去的寫「幾天前」', /30 天前/.test(sec.dateMetaHtml(ev('a', 'ended', '2026-09-02'), T)));
}

// 「今天」是台灣的今天：伺服器／瀏覽器在 UTC，台灣清晨不能是昨天
{
  const fn = fnSource(INDEX, 'todayTaipeiIso');
  const RealDate = Date;
  const at = (iso) => { const t = RealDate.parse(iso); class D extends RealDate { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } } return D; };
  const run = (iso) => new Function('Date', `${fn}; return todayTaipeiIso();`)(at(iso));
  check('★ 台灣清晨（UTC 前一天 23:30）→ 今天是台灣的隔天', run('2026-10-01T23:30:00Z') === '2026-10-02', run('2026-10-01T23:30:00Z'));
  check('　 台灣傍晚（UTC 同一天 10:00）→ 同一天', run('2026-10-01T10:00:00Z') === '2026-10-01');
}

// ═══ 二、活動卡片 ═════════════════════════════════════════════════════════════
console.log('\n── 二、活動卡片：缺什麼直接寫在卡片上，按鈕不再滿版，危險操作收進「更多」──');
const escHtml = load(INDEX, ['escHtml'], [], {}).escHtml;
const cardState = { line: { basic_id: '@abc' } };
const cardFns = load(INDEX, ['eventCardHtml', 'eventStatusMeta', 'moreMenuItems'], [], {
  ...sec, escHtml, state: cardState, WEEKDAYS: ['日', '一', '二', '三', '四', '五', '六'],
  eventDateIso: sec.eventDateIso, dateMetaHtml: sec.dateMetaHtml, window: {}, copyLink() {}, openLineQr() {}, copyEditLink() {}, openTraining() {},
  showAnalyticsByEvent() {}, exportCSV() {}, unpublishEvent() {}, deleteEvent() {}
});
{
  const card = (o) => cardFns.eventCardHtml({ id: 'x1', name: '測試活動', status: 'draft', event_date: '2026-10-20', venue: '', missing: [], has_kb: true, ...o }, { count: 3, today: '2026-10-02' });
  const buttons = (html) => (html.match(/class="action-btn[^"]*"/g) || []).length;
  const draftMissing = card({ missing: ['地點', '新聞聯絡人'] });
  check('★ 草稿缺必填：卡片上直接寫「發布前還缺：地點、新聞聯絡人」並附「去補」', /發布前還缺：地點、新聞聯絡人/.test(draftMissing) && /去補/.test(draftMissing), draftMissing);
  check('草稿必填齊了：寫「必填都齊了，可以發布」', /必填都齊了，可以發布/.test(card({ missing: [] })));
  check('進行中但還缺必填：寫「必填還缺」（舊活動補資料）', /必填還缺：日期/.test(card({ status: 'active', missing: ['日期'] })));
  check('已結束／已封存：不顯示必填提示', !/必填|發布前還缺/.test(card({ status: 'ended', missing: ['地點'] })) && !/必填|發布前還缺/.test(card({ status: 'archived', missing: ['地點'] })));
  check('★ 每張卡片的按鈕都不超過 5 個（含「更多」）——以前進行中的活動有 8～9 個', ['draft', 'active', 'ended', 'archived'].every((s) => buttons(card({ status: s })) <= 5), ['draft', 'active', 'ended', 'archived'].map((s) => s + ':' + buttons(card({ status: s }))).join(' '));
  check('草稿卡最顯眼的是「發布」，進行中卡最顯眼的是「編輯」',
    /action-btn primary"[^>]*onclick="publishEvent[^>]*>.*?發布/s.test(card({ status: 'draft' })) && /action-btn primary"[^>]*onclick="showEditModal/.test(card({ status: 'active' })));
  // 只看按鈕列（卡片標題旁的「已封存」徽章不是按鈕）
  const actionsOf = (html) => (html.match(/<div class="event-actions">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/) || [''])[0];
  const noDanger = ['draft', 'active', 'ended', 'archived'].every((s) => actionsOf(card({ status: s })) && !/永久刪除|封存|收回為未發布|deleteEvent|unpublishEvent/.test(actionsOf(card({ status: s }))));
  check('★ 刪除、收回、封存這類危險操作不在卡片上，點錯一下就出事的按鈕不要擺在主要操作旁邊', noDanger);
  const menu = (status) => cardFns.moreMenuItems({ id: 'x1', status }).map((i) => i.label || '|').join(',');
  check('「更多」裡：只有未發布與已封存的活動能永久刪除（後端另外把關）', /永久刪除/.test(menu('draft')) && /永久刪除/.test(menu('archived')) && !/永久刪除/.test(menu('active')) && !/永久刪除/.test(menu('ended')), [menu('draft'), menu('active')].join(' / '));
  check('「更多」裡：進行中的活動可以收回為未發布', /收回為未發布/.test(menu('active')) && !/收回為未發布/.test(menu('ended')));
}

// ═══ 三、發布前必填檢查列、發布被擋的流程 ═════════════════════════════════════════
console.log('\n── 三、發布前必填：檢查列即時更新；被擋時列出缺什麼、框出欄位、內容不丟 ──');
const KB_TEMPLATE_RE = /const KB_TEMPLATE = `[\s\S]*?`;/;
const KB_LINES_SRC = [constSource(INDEX, /let KB_TEMPLATE_LINES = null;/), constSource(INDEX, KB_TEMPLATE_RE), constSource(INDEX, /const KB_EMPTY_SHAPES = \[.*\];/)];
const REAL_KB = '【新聞稿全文】\n工研院今日發表新一代技術，預計 2027 年第二季量產。';
{
  const dom = makeDom();
  const f = load(INDEX, ['kbHasContent', 'missingForPublish', 'updateReadiness', 'highlightMissing'], [...KB_LINES_SRC], { document: dom.document, setTimeout: noTimers });
  const setVals = (v) => Object.entries(v).forEach(([k, x]) => { dom.el(k).value = x; });
  const labels = () => f.missingForPublish().map((m) => m.label).join('、');

  check('空白表單：日期、地點、新聞聯絡人、新聞稿四項都缺', labels() === '日期、地點、新聞聯絡人、新聞稿', labels());
  setVals({ 'input-date': '2026/10/5', 'input-venue': '中興院區', 'input-contact': '王小明 03-1', 'input-kb': REAL_KB });
  check('★ 日期欄必須是 YYYY-MM-DD（date 欄位給的格式）；其他寫法算沒填', labels() === '日期', labels());
  setVals({ 'input-date': '2026-10-05' });
  check('四項都填 → 沒有缺的', labels() === '', labels());
  setVals({ 'input-kb': fs.readFileSync(path.join(ROOT, 'lib/kb-template.js'), 'utf8').match(/export const KB_TEMPLATE = `([\s\S]*?)`;/)[1] });
  check('★ 知識庫是範本原封不動 → 新聞稿算沒填（以前範本不是空字串，被當成有填）', labels() === '新聞稿', labels());
  setVals({ 'input-venue': '   ' });
  check('地點只有空白 → 算沒填', /地點/.test(labels()), labels());

  setVals({ 'input-venue': '中興院區', 'input-kb': REAL_KB });
  f.updateReadiness();
  const box = dom.el('readiness');
  check('檢查列：全部填齊 → 綠底（all-ok）＋「都齊了」', /all-ok/.test(box.className) && /都齊了/.test(box.innerHTML), box.className + box.innerHTML);
  setVals({ 'input-contact': '' });
  f.updateReadiness();
  check('檢查列：缺聯絡人 → 不是綠底，缺的那項標橘色（miss）、其餘打勾（ok）', !/all-ok/.test(box.className) && /miss"><i class="ti ti-square"><\/i> 新聞聯絡人/.test(box.innerHTML) && /ok"><i class="ti ti-circle-check"><\/i> 日期/.test(box.innerHTML), box.innerHTML);

  f.highlightMissing(['地點', '新聞稿']);
  check('★ highlightMissing：缺的欄位加上框線，並捲到第一個缺的', dom.el('input-venue').cls.has('field-missing') && dom.el('input-kb').cls.has('field-missing') && !dom.el('input-date').cls.has('field-missing') && dom.el('input-venue').scrolled === true);
}

// 後台：按卡片上的「發布」被後端擋下來
{
  const dom = makeDom();
  const toasts = [], calls = [];
  const state = { password: 'pw', events: [{ id: 'e1', name: '眺望 2027 研討會' }] };
  const authedFetch = async (url, opts) => ({ ok: false, json: async () => ({ error: '還不能發布，必填還缺：地點、新聞聯絡人。', code: 'publish_blocked', missing: ['地點', '新聞聯絡人'] }) });
  const f = load(INDEX, ['publishEvent', 'showPublishBlocked', 'closePublishBlocked', 'highlightMissing'], [], {
    document: dom.document, state, authedFetch, escHtml, setTimeout: noTimers,
    toast: (m, t) => toasts.push([m, t]), loadEvents: async () => calls.push('loadEvents'), flashCard: () => calls.push('flash'),
    showEditModal: async (id) => { calls.push('edit:' + id); }
  });
  await f.publishEvent('e1');
  check('★ 後台按「發布」被擋 → 跳出說明視窗，列出缺的項目，而不是只丟一句錯誤', dom.el('publish-blocked-modal').style.display === 'flex' && /地點/.test(dom.el('pb-list').innerHTML) && /新聞聯絡人/.test(dom.el('pb-list').innerHTML) && dom.el('pb-name').textContent === '眺望 2027 研討會', dom.el('pb-list').innerHTML);
  check('　 被擋時不會顯示「發布失敗」、也不會重新整理列表當作成功', toasts.length === 0 && !calls.includes('loadEvents') && !calls.includes('flash'), JSON.stringify([toasts, calls]));
  await dom.el('pb-go').onclick();
  check('★ 按「去補齊」→ 關掉說明、打開該活動的編輯視窗，並把缺的欄位框起來', dom.el('publish-blocked-modal').style.display === 'none' && calls.includes('edit:e1') && dom.el('input-venue').cls.has('field-missing') && dom.el('input-contact').cls.has('field-missing'));
}
// 後台：在編輯視窗把狀態改成進行中、按儲存被擋
{
  const dom = makeDom({ 'edit-event-id': 'e1', 'input-name': '眺望', 'input-organizer': '', 'input-color': '#0F9E7A', 'input-kb': REAL_KB, 'input-status': 'active', 'input-date': '2026-10-20' });
  const toasts = [], calls = [];
  const authedFetch = async () => ({ ok: false, json: async () => ({ error: '還不能發布，必填還缺：地點。', code: 'publish_blocked', missing: ['地點'] }) });
  const f = load(INDEX, ['saveEvent', 'finishSave', 'highlightMissing'], [constSource(INDEX, /const KB_SOFT_LIMIT = \d+;/), constSource(INDEX, /const KB_HARD_LIMIT = \d+;/)], {
    document: dom.document, state: { password: 'pw' }, authedFetch, setTimeout: noTimers, confirm: () => true,
    toast: (m, t) => toasts.push([m, t]), saveDraft: () => calls.push('saveDraft'), clearDraft: () => calls.push('clearDraft'),
    closeModal: () => calls.push('closeModal'), loadEvents: async () => calls.push('loadEvents'), flashCard: () => calls.push('flash')
  });
  await f.saveEvent();
  check('★ 編輯視窗存檔被發布閘門擋下：視窗不關、草稿再備份一次、缺的欄位框起來、錯誤說明留在畫面上',
    !calls.includes('closeModal') && calls.includes('saveDraft') && !calls.includes('clearDraft') && dom.el('input-venue').cls.has('field-missing') && toasts.length === 1 && /必填還缺：地點/.test(toasts[0][0]), JSON.stringify([calls, toasts]));
  check('　 存檔按鈕恢復可按（不會卡在「儲存中…」）', dom.el('save-btn').disabled === false && /儲存/.test(dom.el('save-btn').innerHTML) && !/儲存中/.test(dom.el('save-btn').innerHTML), dom.el('save-btn').innerHTML);
}

// 同仁編輯頁（edit.html）
{
  check('★ edit.html：地點、新聞聯絡人不再寫「（選填）」——它們是發布前必填，畫面不能說謊', !/活動地點（選填）/.test(EDIT) && !/新聞聯絡人（選填）/.test(EDIT) && (EDIT.match(/發布前必填/g) || []).length >= 4);
  check('edit.html：頁面上有發布前檢查列 #readiness', /id="readiness"/.test(EDIT));
  const dom = makeDom({ 'input-name': '眺望', 'input-kb': REAL_KB, 'input-status': 'active', 'input-color': '#0F9E7A', 'input-date': '2026-10-20', 'input-venue': '' });
  const toasts = [];
  const EDIT_CONSTS = [constSource(EDIT, /const KB_SOFT_LIMIT = \d+;/), constSource(EDIT, /const KB_HARD_LIMIT = \d+;/), 'let loadedStatus = "draft"; let dirty = true; const EVENT_ID = "e1"; const EDIT_CODE = "code";'];
  const fetchBlocked = async () => ({ ok: false, json: async () => ({ error: '還不能發布，必填還缺：地點。請先補齊，或讓活動維持在「未發布」。', code: 'publish_blocked', missing: ['地點'] }) });
  const f = load(EDIT, ['save', 'highlightMissing'], EDIT_CONSTS, { document: dom.document, fetch: fetchBlocked, setTimeout: noTimers, confirm: () => true, toast: (m, ms) => toasts.push([m, ms]) });
  await f.save();
  check('★ edit.html：發布被後端擋下 → 缺的欄位框起來、說明停留 8 秒、按鈕恢復，不是「儲存失敗」', dom.el('input-venue').cls.has('field-missing') && toasts.length === 1 && toasts[0][1] === 8000 && /必填還缺：地點/.test(toasts[0][0]) && !/儲存失敗/.test(toasts[0][0]) && dom.el('save-btn').disabled === false, JSON.stringify([toasts, [...dom.el('input-venue').cls]]));
  const eed = load(EDIT, ['eventDateIso'], [], {});
  check('★ edit.html：活動日期只收純日期——建立時間戳不再被當成活動日期預填（會讓人以為日期已經填了）',
    eed.eventDateIso({ event_date: '2026/6/18 下午11:06:04' }) === '' && eed.eventDateIso({ event_date: '2026-06-18 23:06:04' }) === '' && eed.eventDateIso({ event_date: '2026/6/8' }) === '2026-06-08');
  check('edit.html：載入時不再用 created_at 當活動日期', !/ev\.event_date \|\| ev\.created_at/.test(EDIT));
}

// ═══ 四、知識庫「有沒有填」：後端與兩頁的鏡射一致 ═══════════════════════════════════
console.log('\n── 四、kbHasContent 三份（lib／後台／同仁編輯頁）對同一批樣本結果一致 ──');
{
  const { KB_TEMPLATE, kbHasContent: lib } = await import('../lib/kb-template.js');
  const samples = [
    '', '   ', '\n\n', KB_TEMPLATE, KB_TEMPLATE.trim(),
    KB_TEMPLATE.replace('【活動名稱】\n', '【活動名稱】\n工研院 AI 發表會\n'),
    KB_TEMPLATE.replace('【貴賓致詞】\n- 姓名（職稱）：', '【貴賓致詞】\n- 劉某某（院長）：歡迎'),
    KB_TEMPLATE.replace('【新聞稿全文】\n\n\n', '【新聞稿全文】\n工研院今日發表。\n\n'),
    '【活動名稱】\n\n【合作廠商】\n- 廠商：\nQ：\nA：\n-',
    '2026/10/5 工研院舉行院士授證典禮。',
    '-', '・', '*', '【得獎名單】（頒獎場填，其餘留空）\n-', '【素材連結】\n- 技術影片：\n- 照片：',
    '- 技術影片：https://example.com/v', 'Q：何時量產？\nA：明年。', 'Q：\nA：2027 年',
    '【活動名稱】工研院院士授證典禮', '【新聞稿全文】   \n\n  ', '備註：', '備註：無'
  ];
  const mirror = (html) => load(html, ['kbHasContent'], [constSource(html, /let KB_TEMPLATE_LINES = null;/), constSource(html, /const KB_TEMPLATE = `[\s\S]*?`;/), constSource(html, /const KB_EMPTY_SHAPES = \[.*\];/)], {}).kbHasContent;
  const a = mirror(INDEX), b = mirror(EDIT);
  const diffs = samples.map((s, i) => [i, lib(s), a(s), b(s)]).filter(([, x, y, z]) => x !== y || x !== z);
  check(`★ ${samples.length} 個樣本：lib／後台／同仁編輯頁判斷完全一致（鏡射不准漂開）`, diffs.length === 0, JSON.stringify(diffs));
  check('樣本裡兩種結果都有（不是三邊一起恆為 true／false）', samples.some((s) => lib(s)) && samples.some((s) => !lib(s)));
}

// ═══ 五、問答分析清單與手機版版面 ═══════════════════════════════════════════════
console.log('\n── 五、問答分析清單（搜尋、只看答不出來、姓名）與手機版版面 ──');
{
  const rows = [
    { row_num: 2, time: '2026/9/23 上午11:53', event: '四足機器人記者會', media: '中央社', reporter: '林小美', question: '價格大概多少？', answer_preview: '根據新聞稿，價格尚未公布', unanswered: false, source: 'web' },
    { row_num: 3, time: '2026/9/23 上午10:46', event: '半導體發表會', media: '（未填寫）', reporter: '', question: '何時量產？', answer_preview: '這部分我沒有資料，建議洽現場新聞聯絡人。', unanswered: true, source: 'line' },
    { row_num: 4, time: '2026/9/23 上午09:39', event: '半導體發表會', media: '數位時代', reporter: '', question: '跟 CoWoS 有什麼不同？', answer_preview: '能耗降低 35%', unanswered: false, source: 'web' }
  ];
  const run = (search, onlyUnans, over = {}) => {
    const dom = makeDom({ 'analytics-search': search });
    dom.el('analytics-only-unanswered').checked = onlyUnans;
    const state = { qa: { rows, total: rows.length, limit: 200, open: new Set(), answers: {}, ...over } };
    const f = load(INDEX, ['renderQaList', 'answerBoxHtml'], [], { document: dom.document, state, escHtml });
    f.renderQaList();
    return dom.el('qa-list').innerHTML;
  };
  const trs = (h) => (h.match(/<tr>\s*<td class="t-time">/g) || []).length;   // 表頭那一列不算
  check('沒有篩選：三筆都在', trs(run('', false)) === 3);
  check('★ 搜尋框：比對問題、媒體、姓名、AI 回答預覽——搜「林小美」只剩一筆', trs(run('林小美', false)) === 1 && trs(run('能耗', false)) === 1 && trs(run('中央社', false)) === 1);
  check('★ 「只看疑似答不出來」：只剩 AI 說「這部分我沒有資料」那一筆', trs(run('', true)) === 1 && /何時量產/.test(run('', true)));
  check('姓名顯示在媒體下面（媒體與姓名是兩個欄位）', /中央社[\s\S]*林小美/.test(run('', false)));
  check('找不到時說明怎麼辦，不是空白一片', /沒有符合的問答/.test(run('不存在的關鍵字', false)));
  check('列表只帶預覽、整段回答點開才載（toggleAnswer 走 answer_row）', /qa-ans-prev/.test(run('', false)) && /answer_row=\$\{rowNum\}/.test(INDEX));
  check('首頁數字用 summary=1（不載全部問答）、並排除測試與同仁自己問的', /summary=1&exclude_test=1/.test(INDEX));
}
{
  const css = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));
  const mobile = css.slice(css.indexOf('/* 響應式 */'));
  check('★ 手機版：底部導覽只留常用的、其餘收進「更多」（原本八個擠不下，登出被推到畫面外）', /\.nav-secondary,[^{]*\.sidebar-bottom\s*\{\s*display:\s*none/.test(mobile) && /\.nav-more-btn\s*\{\s*display:\s*flex/.test(mobile) && /id="nav-more-btn"/.test(INDEX));
  check('★ 手機版：問答表一則一張卡片（不再橫向捲動、問題欄不會在畫面外）', /\.qa-table thead\s*\{\s*display:\s*none/.test(mobile) && /\.qa-table td\s*\{[^}]*\}/.test(mobile) && /\.qa-table, \.qa-table tbody, \.qa-table tr, \.qa-table td \{ display: block/.test(mobile));
  check('手機版：統計卡縮小、圖示拿掉（四張卡原本佔掉第一屏近一半）', /\.stat-icon\s*\{\s*display:\s*none/.test(mobile) && /\.stat-card\s*\{\s*padding:\s*9px 12px/.test(mobile));
  check('卡片等高、按鈕列貼底（同一列的按鈕不會高高低低）', /\.event-card-body \.event-actions\s*\{\s*margin-top:\s*auto/.test(css) && /\.event-card\s*\{\s*display:\s*flex;\s*flex-direction:\s*column/.test(css));
  check('更多選單在手機上從底部升起（點得到、不會超出畫面）', /\.more-pop\s*\{[^}]*bottom:\s*0 !important/.test(mobile));
  check('預設收起行事曆（手機）／展開（電腦），並記住選擇', /function calOpenPref\(\)/.test(INDEX) && /itri_cal_open/.test(INDEX));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 104（B 批・後台與編輯頁）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
