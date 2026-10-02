// 批次 103（A 批）後台與後端的回歸測試。跑真的 api/events.js、lib/*.js，只有 Google Sheets 是假的
// （test/fakes-sheets82.mjs）。靜態頁（public/*.html）用「抽函式出來跑」的方式驗。
//   一、發布閘門：後台、同仁編輯頁、新增活動三個入口，必填沒齊都不給發布（朱朱批次 76 的決定）
//   二、知識庫範本：沒動過不算有新聞稿；三份範本（後端／後台／編輯頁）逐字相同
//   三、台灣時間：伺服器是 UTC，台灣 00:00–08:00 的「今天」不能算成昨天
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], body: undefined, headersSent: false, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.send = (o) => { r.body = o; r.headersSent = true; r.ended = true; return r; };
  r.end = (x) => { if (x !== undefined) r.chunks.push(String(x)); r.ended = true; return r; };
  return r;
}
// 把「現在」固定在某個時刻跑一段同步程式（模擬伺服器是 UTC、台灣已經是隔天清晨）
function withFakeNow(iso, fn) {
  const RealDate = Date;
  const t = RealDate.parse(iso);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(t); }
    static now() { return t; }
  }
  globalThis.Date = FakeDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

const events = (await import('../api/events.js')).default;
const call = async (method, query, body, headers = { 'x-admin-password': 'pw' }) => {
  const r = fakeRes();
  await events({ method, query: query || {}, body: body || {}, headers }, r);
  return r;
};
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const inDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const { KB_TEMPLATE, kbHasContent } = await import('../lib/kb-template.js');
const REAL_KB = '【新聞稿全文】\n工研院今日發表新一代技術，預計 2027 年第二季量產。';

// events 表的一列（A～R）
const row = (o = {}) => [
  o.id || 'e1', o.name || '測試活動', '#0F9E7A', o.kb ?? '', o.status || 'draft', o.date ?? '', '', '', '', '工研院',
  o.code || 'cc', o.time || '', o.venue || '', '', o.contact || '', '', '', ''
];
const statusOf = (id) => (book.events.find((r) => r[0] === id) || [])[4];

// ═══ 一、發布閘門 ═════════════════════════════════════════════════════════════
console.log('\n── 一、發布閘門：三個入口都擋（後台發布鈕、同仁編輯頁、直接以進行中新增）──');
{
  reset();
  book.events = [['id'],
    row({ id: 'dr1', name: '草稿一', kb: REAL_KB, date: inDays(10), code: 'c1' }),                 // 缺：地點、聯絡人
    row({ id: 'dr2', name: '草稿二', kb: KB_TEMPLATE, date: inDays(10), venue: '中興院區', contact: '王小明 03-1', code: 'c2' }), // 缺：新聞稿（範本沒動）
    row({ id: 'dr3', name: '草稿三', kb: REAL_KB, date: '2026/6/18 下午11:06:04', venue: 'A', contact: 'B', code: 'c3' }),   // 缺：日期（只有建立時間戳）
    row({ id: 'ok1', name: '齊全的草稿', kb: REAL_KB, date: inDays(10), venue: '中興院區', contact: '王小明 03-1', code: 'c4' }),
    row({ id: 'old', name: '舊的進行中（缺地點）', kb: REAL_KB, status: 'active', date: inDays(3), contact: 'x', code: 'c5' }),
  ];

  // 後台「發布」鈕（action=update 帶 status）
  let r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr1', status: 'active' });
  check('★ 後台發布：缺地點與新聞聯絡人 → 400，回 code 與缺項', r.statusCode === 400 && r.body.code === 'publish_blocked'
    && JSON.stringify(r.body.missing) === JSON.stringify(['地點', '新聞聯絡人']), JSON.stringify(r.body));
  check('　 錯誤訊息講得出缺什麼', /還不能發布，必填還缺：地點、新聞聯絡人/.test(r.body.error || ''), r.body.error);
  check('　 被擋下來的時候，試算表裡那場還是草稿（沒有寫入）', statusOf('dr1') === 'draft');

  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr2', status: 'active' });
  check('★ 知識庫還是原封不動的範本 → 算沒有新聞稿，擋下來', r.statusCode === 400 && r.body.missing.includes('新聞稿') && statusOf('dr2') === 'draft', JSON.stringify(r.body));

  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr3', status: 'active' });
  check('★ 日期欄只有「建立時間戳」（沒填活動日期）→ 算沒有日期，擋下來', r.statusCode === 400 && r.body.missing.includes('日期'), JSON.stringify(r.body));

  // 同一次請求把缺的補上、同時發布 → 以「寫入後的整列」判斷，放行
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr1', status: 'active', venue: '南港展覽館', press_contact: '王小明 03-5911234' });
  check('　 同一次請求補齊缺項再發布 → 放行，狀態變進行中', r.statusCode === 200 && statusOf('dr1') === 'active', JSON.stringify(r.body));

  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'ok1', status: 'active' });
  check('　 本來就齊全的草稿 → 照常發布', r.statusCode === 200 && statusOf('ok1') === 'active');

  // 沒有要離開草稿的編輯：不受影響
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr2', name: '改個名字', status: 'draft' });
  check('　 草稿只改名字、狀態不變 → 不擋（還沒要公開，缺項沒關係）', r.statusCode === 200 && (book.events.find((x) => x[0] === 'dr2') || [])[1] === '改個名字');

  // 本來就公開的舊活動：後續編輯不能因為缺地點就存不了
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'old', name: '舊的進行中（改了名字）' });
  check('★ 本來就進行中、缺地點的舊活動，改別的欄位 → 不擋（不能連改錯字都存不了）', r.statusCode === 200);
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'old', status: 'ended' });
  check('　 進行中 → 已結束 → 不擋（本來就公開）', r.statusCode === 200 && statusOf('old') === 'ended');

  // 草稿直接改成「已結束」也算公開（存檔頁會公開新聞稿）
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr3', status: 'ended' });
  check('★ 草稿直接改「已結束」也是發布（存檔頁會公開）→ 一樣要擋', r.statusCode === 400 && statusOf('dr3') === 'draft', JSON.stringify(r.body));

  // 封存是下架，不用擋；但「封存的草稿再改回進行中」不能繞過必填
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr3', status: 'archived' });
  check('　 草稿 → 封存 → 不擋', r.statusCode === 200 && statusOf('dr3') === 'archived');
  r = await call('POST', {}, { action: 'update', password: 'pw', id: 'dr3', status: 'active' });
  check('★ 封存的草稿再改回進行中 → 一樣要擋（不能用封存繞過必填）', r.statusCode === 400 && statusOf('dr3') === 'archived', JSON.stringify(r.body));
}

console.log('\n── 一之二、同仁編輯頁（update_edit）與直接新增 ──');
{
  reset();
  book.events = [['id'], row({ id: 'dr1', name: '草稿一', kb: REAL_KB, date: inDays(10), code: 'cc1' })];
  let r = await call('POST', {}, { action: 'update_edit', id: 'dr1', code: 'cc1', status: 'active' }, {});
  check('★ 同仁編輯頁把狀態改進行中：缺項 → 400（同仁不用後台密碼，更要擋）', r.statusCode === 400 && r.body.code === 'publish_blocked' && statusOf('dr1') === 'draft', JSON.stringify(r.body));
  r = await call('POST', {}, { action: 'update_edit', id: 'dr1', code: 'cc1', status: 'active', venue: '中興院區', press_contact: '王小明' }, {});
  check('　 同一次補齊 → 放行', r.statusCode === 200 && statusOf('dr1') === 'active', JSON.stringify(r.body));
  r = await call('POST', {}, { action: 'update_edit', id: 'dr1', code: 'cc1', knowledge_base: REAL_KB + '\n再補一句。' }, {});
  check('　 已公開的活動，同仁只改內容 → 不受影響', r.statusCode === 200);

  reset();
  book.events = [['id']];
  r = await call('POST', {}, { action: 'create', password: 'pw', name: '只有名字', knowledge_base: KB_TEMPLATE });
  check('★ 新增活動預設草稿：只填名字、範本沒動 → 允許（草稿本來就是先開框架）', r.statusCode === 200 && r.body.status === 'draft' && book.events.length === 2, JSON.stringify(r.body));
  r = await call('POST', {}, { action: 'create', password: 'pw', name: '想直接公開', knowledge_base: KB_TEMPLATE, status: 'active' });
  check('★ 直接以「進行中」新增、必填沒齊 → 400，而且沒有新增那一列（API 是公開入口，不能繞過）', r.statusCode === 400 && r.body.code === 'publish_blocked' && book.events.length === 2, JSON.stringify(r.body));
  r = await call('POST', {}, { action: 'create', password: 'pw', name: '齊全直接公開', knowledge_base: REAL_KB, status: 'active', event_date: inDays(5), venue: '中興院區', press_contact: '王小明 03-1' });
  check('　 必填齊全才可以直接以進行中新增', r.statusCode === 200 && r.body.status === 'active');
}

console.log('\n── 一之三、後台列表帶「還缺什麼」，卡片發布前就看得到 ──');
{
  reset();
  book.events = [['id'],
    row({ id: 'a', name: 'A', kb: REAL_KB, date: inDays(10), code: 'c1' }),
    row({ id: 'b', name: 'B', kb: REAL_KB, date: inDays(10), venue: 'x', contact: 'y', code: 'c2' }),
  ];
  const r = await call('GET', { action: 'list_admin' });
  const a = r.body.events.find((e) => e.id === 'a'), b = r.body.events.find((e) => e.id === 'b');
  check('★ list_admin 每場都帶 missing（缺哪幾項）', JSON.stringify(a.missing) === JSON.stringify(['地點', '新聞聯絡人']) && Array.isArray(b.missing) && b.missing.length === 0, JSON.stringify([a.missing, b.missing]));
}

// ═══ 二、知識庫範本 ═══════════════════════════════════════════════════════════
console.log('\n── 二、範本沒動過不算有新聞稿；三份範本逐字相同 ──');
{
  check('空字串、純空白 → 沒有內容', !kbHasContent('') && !kbHasContent('  \n \n'));
  check('★ 範本原封不動 → 沒有內容', !kbHasContent(KB_TEMPLATE));
  check('　 範本只填了活動名稱 → 有內容', kbHasContent(KB_TEMPLATE.replace('【活動名稱】\n', '【活動名稱】\n工研院 AI 發表會\n')));
  check('　 範本在項目後面補了字（「- 劉某某（院長）：歡迎」）→ 有內容', kbHasContent(KB_TEMPLATE.replace('【貴賓致詞】\n- 姓名（職稱）：', '【貴賓致詞】\n- 劉某某（院長）：歡迎')));
  check('　 只剩標題、空項目、空標籤 → 沒有內容', !kbHasContent('【活動名稱】\n\n【合作廠商】\n- 廠商：\nQ：\nA：\n-'));
  check('　 一句沒有任何格式的話 → 有內容', kbHasContent('2026/10/5 工研院舉行院士授證典禮。'));
  for (const f of ['public/index.html', 'public/edit.html']) {
    const m = read(f).match(/const KB_TEMPLATE = `([\s\S]*?)`;/);
    check(`★ ${f} 的 KB_TEMPLATE 與 lib/kb-template.js 逐字相同（改範本要三處一起改）`, !!m && m[1] === KB_TEMPLATE, m ? '內容不同' : '找不到 KB_TEMPLATE');
  }
  // LINE 職員模式的發布檢查用的是同一份 eventChecklist（lib/event-status.js）
  const { eventChecklist } = await import('../lib/event-status.js');
  const c = eventChecklist(row({ kb: KB_TEMPLATE, date: inDays(5), venue: 'x', contact: 'y' }), today);
  check('★ LINE 職員模式的檢查清單：範本沒動的新聞稿也算「還缺」', c.missingRequired.includes('新聞稿'), JSON.stringify(c.missingRequired));
}

// ═══ 三、台灣時間 ═════════════════════════════════════════════════════════════
console.log('\n── 三、伺服器是 UTC：台灣清晨（00:00–08:00）的「今天」不能是昨天 ──');
{
  const TW_MORNING = '2026-10-01T23:30:00Z';   // = 台灣 2026-10-02 07:30
  const { taipeiToday } = await import('../lib/event-status.js');
  check('taipeiToday()：UTC 10/01 23:30 → 台灣 10/02', withFakeNow(TW_MORNING, () => taipeiToday()) === '2026-10-02');

  // 活動當天起，記者問答就該改回正式新聞稿（邀請函只在「活動前」用）
  const { resolveEventContent } = await import('../lib/prompt.js');
  const ev = { invite_letter: '【邀請函】歡迎採訪', knowledge_base: '【正式新聞稿】', event_date: '2026-10-02', chips: '正式題', invite_letter_chips: '邀請函題', images: 'https://x/a.jpg' };
  const early = withFakeNow(TW_MORNING, () => resolveEventContent(ev));
  check('★ 活動當天台灣 07:30（伺服器還是前一天）→ 已經是「活動當天」，用正式新聞稿與照片', early.knowledge_base === '【正式新聞稿】' && early.images === 'https://x/a.jpg', JSON.stringify(early));
  const eve = withFakeNow('2026-10-01T10:00:00Z', () => resolveEventContent(ev));   // 台灣 10/01 18:00
  check('　 前一天傍晚 → 仍是活動前，只給邀請函（原本的保護照舊）', eve.knowledge_base === '【邀請函】歡迎採訪' && eve.images === '', JSON.stringify(eve));

  // 「近期活動」vs「最近辦過」：昨天辦完的活動，今天凌晨就該在「最近辦過」
  const { buildCalendarCards, formatCalendarReply } = await import('../lib/router.js');
  const rows = [['y1', '昨天辦的記者會', '#0F9E7A', '新聞稿', 'active', '2026-10-01'], ['t1', '明天要辦的論壇', '#0F9E7A', '新聞稿', 'active', '2026-10-03']];
  const txt = withFakeNow(TW_MORNING, () => formatCalendarReply(buildCalendarCards(rows)));
  const up = txt.slice(txt.indexOf('【近期活動】'), txt.indexOf('【最近辦過】'));
  check('★ 台灣 10/02 清晨：昨天（10/01）辦的活動歸在「最近辦過」，不再掛在「近期活動」', txt.includes('【最近辦過】') && !up.includes('昨天辦的記者會') && up.includes('明天要辦的論壇'), txt);
}

// ═══ 四、其他 UTC 日期 ═══════════════════════════════════════════════════════
console.log('\n── 四、前端與匯出的日期都用台灣時間 ──');
{
  const noComments = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');   // 註解裡會提到舊寫法，不算
  for (const f of ['public/index.html', 'public/geo.html', 'public/registrations.html']) {
    check(`${f} 不再用 toISOString().slice(0,10)（那是 UTC 日期）`, !/toISOString\(\)\.slice\(0,\s*10\)/.test(noComments(read(f))));
  }
  check('api/export.js 的檔名日期用台灣時間', !/toISOString\(\)\.slice\(0,\s*10\)/.test(read('api/export.js')) && /taipeiToday\(\)/.test(read('api/export.js')));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 103（A 批・後台）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
