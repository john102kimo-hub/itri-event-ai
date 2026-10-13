// 批次 137：記者名單——新增單筆、挑收件人（貼進 Outlook）、Outlook 通訊錄 CSV。
// 公司資安不讓平台代寄信，邀請函從 Outlook 寄；這裡只幫承辦人「備好收件人」。
//   一、純函式（lib/media-pick.js）：mail 整理、挑人、分批、CSV
//   二、後端（真的 api/media.js，只有 Google Sheets 是假的）：add、pick、export_outlook 與權限
//   三、頁面（在假 DOM 上真的跑函式）：新增表單、挑出名單、複製、下載
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const MEDIA = fs.readFileSync(path.join(ROOT, 'public/media.html'), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
function fnSource(html, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (!m) throw new Error('找不到函式 ' + name);
  const eol = html.indexOf('\n', m.index);
  const first = html.slice(m.index, eol);
  if (/\}\s*$/.test(first) && first.split('{').length === first.split('}').length) return first + '\n';
  return html.slice(m.index, html.indexOf('\n}\n', m.index) + 2);
}

const pick = await import('../lib/media-pick.js');

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('\n── 一、mail 整理、挑人、分批、CSV ──');
{
  const n = pick.normalizeEmail;
  check('mail 整理：前後空白、大寫、全形＠都修成 Outlook 寄得出去的樣子',
    n('  Wang@Example.COM ') === 'wang@example.com' && n('wang＠itri.org.tw') === 'wang@itri.org.tw', [n('  Wang@Example.COM '), n('wang＠itri.org.tw')]);
  check('　 一格塞兩個信箱（分號／逗號／空白／頓號）→ 取第一個有效的', n('a@x.com; b@y.com') === 'a@x.com' && n('a@x.com,b@y.com') === 'a@x.com' && n('壞掉 b@y.com') === 'b@y.com' && n('a@x.com、b@y.com') === 'a@x.com');
  check('　 <角括號> 包起來的也認得', n('王小明 <wang@x.com>') === 'wang@x.com', n('王小明 <wang@x.com>'));
  check('★ 明顯壞掉的一律回空字串（寧可略過，也不貼進收件人欄）：缺 @、缺網域、空字串、null',
    ['wang.example.com', 'wang@', '@x.com', 'wang@x', '', null, undefined, '無'].every((x) => n(x) === ''), ['wang.example.com', 'wang@', 'wang@x'].map(n).join('|'));

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const ago = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const rows = [
    { name: '甲', outlet: '聯合報', beat: '半導體', email: 'a@x.com', status: 'active', last_invited: ago(30) },
    { name: '乙', outlet: '聯合新聞網', beat: '半導體', email: 'B@X.com', status: 'active', last_invited: ago(500) },
    { name: '丙', outlet: '中央社', beat: '生醫', email: 'c@x.com', status: 'active', last_invited: '' },
    { name: '丁', outlet: '聯合報', beat: '半導體', email: 'a@x.com', status: 'active', last_invited: ago(10) },    // 與甲 mail 重複
    { name: '戊', outlet: '聯合報', beat: '半導體', email: '', status: 'active', last_invited: ago(10) },          // 沒有 mail
    { name: '己', outlet: '聯合報', beat: '半導體', email: 'f@x.com', status: 'left', last_invited: ago(10) },     // 已離職
    { name: '庚', outlet: '經濟日報', beat: '', email: 'g@x.com', status: 'active', last_invited: ago(5) },
  ];
  let r = pick.pickRecipients(rows, {});
  check('不限條件：已離職的人不會被挑到；沒有 mail 的略過並計數；重複 mail 合併並計數',
    r.people.map((p) => p.name).join() === '甲,乙,丙,庚' && r.withoutEmail === 1 && r.duplicates === 1 && r.matched === 6, JSON.stringify({ n: r.people.map((p) => p.name), w: r.withoutEmail, d: r.duplicates, m: r.matched }));
  check('　 挑出來的 mail 一律轉小寫', r.people.find((p) => p.name === '乙').email === 'b@x.com');
  r = pick.pickRecipients(rows, { beat: '半導體' });
  check('照路線挑：只留半導體（沒填路線的庚不算）', r.people.map((p) => p.name).join() === '甲,乙', r.people.map((p) => p.name).join());
  r = pick.pickRecipients(rows, { outlet: '聯合' });
  check('照媒體名稱挑：包含「聯合」（聯合報、聯合新聞網都算）', r.people.map((p) => p.name).join() === '甲,乙', r.people.map((p) => p.name).join());
  r = pick.pickRecipients(rows, { recentOnly: true });
  check('只挑最近一年受邀過的：500 天前的乙、沒有受邀日期的丙都不算', r.people.map((p) => p.name).join() === '甲,庚', r.people.map((p) => p.name).join());
  r = pick.pickRecipients(rows, { beat: '半導體', outlet: '聯合', recentOnly: true });
  check('條件可以疊加', r.people.map((p) => p.name).join() === '甲', r.people.map((p) => p.name).join());
  check('　 沒人符合：回空名單、不丟例外', pick.pickRecipients(rows, { beat: '材料化學' }).people.length === 0 && pick.pickRecipients(null, {}).people.length === 0);

  const emails = Array.from({ length: 120 }, (_, i) => `u${i}@x.com`);
  let b = pick.toBatches(emails, 50);
  check('分批：120 人、每批 50 → 3 批（50／50／20），每批人數加起來不漏不重複',
    b.length === 3 && b.map((x) => x.count).join() === '50,50,20' && b.flatMap((x) => x.text.split('; ')).join() === emails.join());
  check('★ Outlook 收件人欄用分號加空格串（不是逗號）', b[2].text.startsWith('u100@x.com; u101@x.com') && !b[2].text.includes(','), b[2].text.slice(0, 60));
  check('　 每批人數：亂填（0、負數、字串、空）退回預設 50，超過 500 壓在 500',
    [0, -3, 'abc', '', undefined].every((v) => pick.clampBatchSize(v) === 50) && pick.clampBatchSize(9999) === 500 && pick.clampBatchSize('30') === 30);
  check('　 沒有人時是 0 批', pick.toBatches([], 50).length === 0);

  const csv = pick.buildOutlookCsv([{ name: '王小明', outlet: '聯合報', beat: '半導體', email: 'a@x.com' }, { name: '=HYPERLINK("x")', outlet: '引號"店', beat: '', email: 'b@x.com' }]);
  const lines = csv.split('\r\n');
  check('Outlook CSV：開頭有 BOM（Excel／Outlook 才不會把中文讀成亂碼）、標題列是 姓名／媒體／路線／電子郵件',
    csv.charCodeAt(0) === 0xFEFF && lines[0] === '﻿"姓名","媒體","路線","電子郵件"' && lines[1] === '"王小明","聯合報","半導體","a@x.com"', lines.slice(0, 2).join(' / '));
  check('　 公式注入：開頭是 = 的格子補單引號；引號跳脫成兩個', lines[2].startsWith(`"'=HYPERLINK(""x"")"`) && lines[2].includes('"引號""店"'), lines[2]);

  check('新增記者的 id：N0001 起，接在既有 N 開頭的最大編號後面；匯入進來的 R 開頭 id 不影響',
    pick.nextRosterId([]) === 'N0001' && pick.nextRosterId(['R0101', 'R0102']) === 'N0001' && pick.nextRosterId(['R1', 'N0007', 'N0003']) === 'N0008');
}

// ═══ 二、後端 ═════════════════════════════════════════════════════════════════
console.log('\n── 二、後端：add、pick、export_outlook ──');
const { book, reset, ctl } = await import('./fakes-sheets82.mjs');
reset();
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
const media = (await import('../api/media.js')).default;
const call = async (method, q, body = {}, headers = {}) => {
  let code = 200, out, hdrs = {};
  const res = { setHeader(k, v) { hdrs[k] = v; }, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
  await media({ method, query: q, headers, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, out, hdrs };
};
const A = { 'x-admin-password': 'pw' };
const iso = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
{
  const seed = ['id,name,outlet,beat,email,invited_count,last_invited',
    `R1,吳雅婷,三立新聞,半導體,wu@setn.com,86,${iso(40)}`,
    `R2,林小美,聯合報,生醫,lin@udn.com,40,${iso(700)}`,
    'R3,張大同,中央社,半導體,,10,' + iso(20)].join('\n');
  let r = await call('POST', {}, { action: 'seed', csv: seed }, A);
  check('（準備）匯入三位記者', r.code === 200 && r.out.created === 3, JSON.stringify(r.out));

  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '  陳新人 ', outlet: '經濟日報', email: ' New＠Ctee.com.tw ', beat: '財經／產業', updated_by: '朱朱' });
  const row = book.media_roster.find((x) => x[1] === '陳新人');
  check('★ 新增一位記者：姓名、媒體、mail 就能存；id 系統編（N0001），狀態在職，mail 已整理成小寫半形',
    r.code === 200 && r.out.id === 'N0001' && row && row[0] === 'N0001' && row[2] === '經濟日報' && row[3] === '財經／產業' && row[4] === 'new@ctee.com.tw' && row[10] === 'active' && row[13] === '朱朱', JSON.stringify({ r: r.out, row }));
  check('　 同仁共用連結也能新增（不用管理員密碼）', r.code === 200);
  r = await call('POST', {}, { action: 'add', password: 'pw', name: '第二位', outlet: '工商時報', email: 'two@ctee.com.tw' }, A);
  check('　 第二位的 id 接著編 N0002；沒選路線就是空的（會出現在待確認名單裡讓同仁補）', r.out.id === 'N0002' && book.media_roster.find((x) => x[0] === 'N0002')[3] === '');
  const list = await call('GET', { action: 'list' }, {}, A);
  check('　 新增之後在職人數 +2', list.out.totalActive === 5, list.out.totalActive);

  const before = book.media_roster.length;
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '重複的人', outlet: '別家', email: 'LIN@udn.com' });
  check('★ mail 已經在名單裡：擋下並指出是誰（不會悄悄多出一筆重複的記者）', r.code === 409 && /林小美（聯合報）/.test(r.out.error) && book.media_roster.length === before, JSON.stringify(r.out));
  await call('POST', {}, { action: 'update', code: 'staffcode1', id: 'R2', mark: 'left' });
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '重複的人', outlet: '別家', email: 'lin@udn.com' });
  check('　 重複的是已離職的人：訊息提醒可以去搜尋「恢復在職」', r.code === 409 && /已離職/.test(r.out.error) && /恢復在職/.test(r.out.error), r.out.error);

  const bad = async (body) => (await call('POST', {}, { action: 'add', code: 'staffcode1', ...body }));
  check('缺姓名／媒體／mail 都擋下', (await bad({ outlet: 'x', email: 'a@x.com' })).code === 400 && (await bad({ name: 'x', email: 'a@x.com' })).code === 400 && (await bad({ name: 'x', outlet: 'y' })).code === 400);
  check('　 mail 格式不對擋下並說明（例如缺網域）', (await bad({ name: 'x', outlet: 'y', email: 'abc@def' })).out.error.includes('mail 格式'));
  check('　 路線不在選項裡擋下', (await bad({ name: 'x', outlet: 'y', email: 'ok@x.com', beat: '亂寫' })).code === 400);
  check('　 沒帶連結代碼也沒帶密碼 → 401，名單沒有多一筆', (await call('POST', {}, { action: 'add', name: 'x', outlet: 'y', email: 'ok@x.com' })).code === 401
    && !book.media_roster.some((x) => x[1] === 'x'));
  ctl.failReads.add('media_roster');
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '讀失敗時', outlet: 'y', email: 'rf@x.com' });
  ctl.failReads.delete('media_roster');
  check('★ 讀名單失敗時不新增（不能當成「名單是空的」而編出重複的 id、查不到重複的 mail）', r.code === 500 && !book.media_roster.some((x) => x[1] === '讀失敗時'), JSON.stringify(r));

  // ── pick ──
  r = await call('GET', { action: 'pick', code: 'staffcode1' });
  check('★ 挑收件人只給管理員：同仁共用連結拿不到 mail（連結外流也撈不走整份名單）', r.code === 401 && !JSON.stringify(r.out).includes('@'), JSON.stringify(r.out));
  r = await call('GET', { action: 'export_outlook', code: 'staffcode1' });
  check('　 Outlook CSV 也只給管理員', r.code === 401);
  r = await call('GET', { action: 'pick', beat: '半導體', size: '1' }, {}, A);
  check('管理員挑「半導體」：吳雅婷有 mail 可寄；張大同沒有 mail 被略過並如實回報',
    r.code === 200 && r.out.total === 1 && r.out.people[0].email === 'wu@setn.com' && r.out.withoutEmail === 1 && r.out.matched === 2, JSON.stringify(r.out));
  r = await call('GET', { action: 'pick', size: '2' }, {}, A);
  check('　 不限條件、每批 2 人：已離職的林小美不在；其餘有 mail 的 3 人分成 2 批（2＋1），用分號串',
    r.out.total === 3 && r.out.batches.length === 2 && r.out.batches[0].count === 2 && r.out.batches[0].text.includes('; ') && r.out.batches[1].count === 1
      && !JSON.stringify(r.out).includes('lin@udn.com'), JSON.stringify(r.out.batches));
  r = await call('GET', { action: 'pick', recent: '1' }, {}, A);
  check('　 只挑最近一年受邀過的：新增的（沒有受邀日期）不算，只剩吳雅婷', r.out.people.map((p) => p.name).join() === '吳雅婷', r.out.people.map((p) => p.name).join());
  r = await call('GET', { action: 'pick', outlet: '三立' }, {}, A);
  check('　 照媒體名稱挑', r.out.people.map((p) => p.name).join() === '吳雅婷');
  ctl.failReads.add('media_roster');
  r = await call('GET', { action: 'pick' }, {}, A);
  ctl.failReads.delete('media_roster');
  check('★ 讀名單失敗時回錯誤，不是回「0 人」（承辦人會以為這個條件沒有人，白白少寄）', r.code === 500, JSON.stringify(r));

  r = await call('GET', { action: 'export_outlook', beat: '半導體' }, {}, A);
  check('Outlook 通訊錄 CSV：帶 BOM、只有挑出來的人、檔名有日期',
    r.code === 200 && r.out.charCodeAt(0) === 0xFEFF && r.out.includes('"吳雅婷","三立新聞","半導體","wu@setn.com"') && !r.out.includes('張大同') && /outlook_contacts_\d{4}-\d{2}-\d{2}\.csv/.test(r.hdrs['Content-Disposition']), r.out + JSON.stringify(r.hdrs));

  // 既有的整份匯出沒被搬壞
  r = await call('GET', { action: 'export' }, {}, A);
  check('（既有）匯出整份名單照舊可用', r.code === 200 && r.out.includes('"吳雅婷"') && r.out.charCodeAt(0) === 0xFEFF);
}

// ═══ 三、頁面 ═════════════════════════════════════════════════════════════════
console.log('\n── 三、頁面：新增表單、挑出名單、複製 ──');
{
  check('新增記者的表單所有人都看得到（在 admin-panel 外面）；挑收件人在管理區裡（只有管理員）',
    MEDIA.indexOf('id="add-card"') > 0 && MEDIA.indexOf('id="add-card"') < MEDIA.indexOf('id="admin-panel"')
      && MEDIA.indexOf('id="pick-result"') > MEDIA.indexOf('id="admin-panel"'));
  check('　 管理區對同仁是隱藏的（既有行為沒被改掉）', /admin-panel'\)\.style\.display = admin \? 'block' : 'none'/.test(MEDIA));

  const mkDoc = (vals = {}) => {
    const els = {};
    const get = (id) => (els[id] ||= { id, value: vals[id] ?? '', checked: false, textContent: '', innerHTML: '', className: '', disabled: false, style: {}, options: [], appendChild(o) { this.options.push(o); } });
    return { els, document: { getElementById: get, createElement: () => ({ style: {}, select() {}, remove() {} }), body: { appendChild() {} } } };
  };

  // 新增表單
  {
    const { els, document } = mkDoc({ 'add-name': ' 陳新人 ', 'add-outlet': '經濟日報', 'add-email': 'new@x.com', 'add-beat': '半導體' });
    const calls = [], toasts = [], rendered = [];
    const call = async (a, body, method) => { calls.push([a, body, method]); return a === 'add' ? { success: true, id: 'N0001' } : { totalActive: 9 }; };
    const { addReporter } = new Function('document', 'call', 'toast', 'render', `${fnSource(MEDIA, 'addReporter')}; return { addReporter };`)(document, call, (m) => toasts.push(m), (d) => rendered.push(d));
    await addReporter();
    check('★ 新增表單：把姓名／媒體／mail／路線送出、成功後清空欄位、重新載入統計',
      calls[0][0] === 'add' && calls[0][2] === 'POST' && calls[0][1].name === '陳新人' && calls[0][1].email === 'new@x.com' && calls[0][1].beat === '半導體'
        && els['add-name'].value === '' && els['add-email'].value === '' && rendered.length === 1 && /已新增/.test(els['add-msg'].textContent), JSON.stringify(calls[0]));
    check('　 按鈕在請求結束後恢復可按', els['add-btn'].disabled === false);
  }
  {
    const { els, document } = mkDoc({ 'add-name': '陳新人', 'add-outlet': '', 'add-email': 'new@x.com' });
    const calls = [];
    const { addReporter } = new Function('document', 'call', 'toast', 'render', `${fnSource(MEDIA, 'addReporter')}; return { addReporter };`)(document, async () => { calls.push(1); return {}; }, () => {}, () => {});
    await addReporter();
    check('　 有欄位沒填：在畫面上提醒、不送出', calls.length === 0 && els['add-msg'].className.includes('err') && /都要填/.test(els['add-msg'].textContent));
  }
  {
    const { els, document } = mkDoc({ 'add-name': '重複', 'add-outlet': 'x', 'add-email': 'dup@x.com' });
    const { addReporter } = new Function('document', 'call', 'toast', 'render', `${fnSource(MEDIA, 'addReporter')}; return { addReporter };`)(document, async () => ({ error: '這個 mail 已經在名單裡了：林小美（聯合報）' }), () => {}, () => {});
    await addReporter();
    check('　 後端說 mail 重複：原文顯示在表單下面，已填的欄位保留（不用重打）', /林小美（聯合報）/.test(els['add-msg'].textContent) && els['add-email'].value === 'dup@x.com');
  }

  // 挑出名單＋複製
  {
    const { els, document } = mkDoc({ 'pick-beat': '半導體', 'pick-outlet': ' 聯合 ', 'pick-size': '2' });
    els['pick-recent'] = { checked: true };
    document.getElementById('pick-recent').checked = true;
    const calls = [], toasts = [], clip = [];
    const data = { matched: 7, total: 5, withoutEmail: 2, duplicates: 0, batches: [{ count: 2, text: 'a@x.com; b@x.com' }, { count: 2, text: 'c@x.com; d@x.com' }, { count: 1, text: 'e@x.com' }], people: [{ name: '甲<script>', outlet: '乙', email: 'a@x.com' }] };
    const navigator = { clipboard: { writeText: async (t) => { clip.push(t); } } };
    const api = new Function('document', 'call', 'toast', 'navigator', `let pickBatches = []; ${['esc', 'pickParams', 'runPick', 'copyText', 'copyBatch'].map((n) => fnSource(MEDIA, n)).join('\n')}; return { runPick, copyBatch };`)(document, async (a, p) => { calls.push([a, p]); return data; }, (m) => toasts.push(m), navigator);
    await api.runPick();
    check('★ 挑出名單：把路線、媒體（去前後空白）、每批人數、「最近受邀」送給後端', calls[0][0] === 'pick' && calls[0][1].beat === '半導體' && calls[0][1].outlet === '聯合' && calls[0][1].size === '2' && calls[0][1].recent === '1', JSON.stringify(calls[0]));
    const html = els['pick-result'].innerHTML;
    check('　 畫面寫出符合幾位、可寄幾位；沒有 mail 被略過的人數用警示字（不能默默少寄）', /符合條件的在職記者 <b>7<\/b> 位，可以寄的有 <b>5<\/b> 位/.test(html) && /另有 2 位沒有 mail/.test(html), html);
    check('　 分成 3 批、每批各一顆「複製收件人」，並提醒貼到「密件副本」', (html.match(/複製收件人/g) || []).length === 3 && /第 3 批・1 人/.test(html) && /密件副本/.test(html));
    check('　 名單裡的姓名要跳脫（不會把名字當 HTML 執行）', !html.includes('<script>') && html.includes('&lt;script&gt;'));
    await api.copyBatch(1);
    check('★ 複製第 2 批：剪貼簿裡就是那一批的收件人字串，並提示去哪裡貼', clip[0] === 'c@x.com; d@x.com' && /第 2 批（2 人）/.test(toasts[0]) && /密件副本/.test(toasts[0]), JSON.stringify({ clip, toasts }));
  }
  {
    // 剪貼簿 API 不能用時退回 execCommand；兩個都不行就提示改用 CSV
    const { document } = mkDoc();
    let copied = 0;
    document.createElement = () => ({ style: {}, select() {}, remove() {} });
    document.execCommand = () => { copied++; return true; };
    const mk = (nav, doc) => new Function('document', 'navigator', `${fnSource(MEDIA, 'copyText')}; return copyText;`)(doc, nav);
    const okFallback = await mk({}, { ...document, execCommand: () => { copied++; return true; } })('x');
    check('剪貼簿 API 用不了（非 https、被瀏覽器擋）→ 退回 execCommand 照樣複製得到', okFallback === true && copied === 1);
    const fail = await mk({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, { ...document, execCommand: () => false })('x');
    check('　 兩種都失敗：回 false（頁面會提示改用下載 CSV，不會假裝複製成功）', fail === false);
  }
  {
    const { document } = mkDoc();
    const toasts = [];
    const { copyBatch } = new Function('document', 'call', 'toast', 'navigator', `let pickBatches = []; ${fnSource(MEDIA, 'copyText')} ${fnSource(MEDIA, 'copyBatch')}; return { copyBatch };`)(document, null, (m) => toasts.push(m), {});
    await copyBatch(0);
    check('還沒按「挑出名單」就按複製：提醒先挑，不會複製出空字串', /請先按「挑出名單」/.test(toasts[0] || ''), toasts[0]);
  }
  check('下載 Outlook CSV 走 header 帶密碼（不放網址）、用 Blob 下載',
    /fetch\('\/api\/media\?'\+qs\.toString\(\), \{ headers: \{ 'X-Admin-Password': S\.pwd \} \}\)/.test(fnSource(MEDIA, 'downloadOutlookCsv')) && /action:'export_outlook'/.test(fnSource(MEDIA, 'downloadOutlookCsv')));
  check('路線下拉由後端給的 beats 填入（新增表單與挑人共用同一份），已填過不重填', /beatsList = data\.beats; fillBeatSelects\(\)/.test(MEDIA) && /el\.options\.length > 1\) return/.test(fnSource(MEDIA, 'fillBeatSelects')));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 137（記者名單：新增、挑收件人、Outlook）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
