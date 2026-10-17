// 批次 145：批次 144 留給朱朱決定的六點，朱朱回「六點都改」。這支守網頁與 API 那四點；LINE 那兩點在 test-batch145-line.mjs。
//   一、合作洽詢：放寬成廠商常見的講法，記者的新聞題照樣不攔
//   二、後台米亞的 questions 工具：時間讀不懂的紀錄不算進「最近 N 天」，並回報略過幾筆
//   三、後台米亞的確認卡：按了「確認執行」還沒等到結果就離開，回來不能再按一次
//   四、記者名單：同仁（共用連結）要換掉既有的 mail，要管理員核准才生效
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(import.meta.dirname, '..');
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.EVENTS_TABLE_TTL_MS = '0';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

const { book, reset } = await import('./fakes-sheets82.mjs');
reset();

// ═══ 一、合作洽詢 ══════════════════════════════════════════════════════════════
console.log('\n── 一、合作洽詢的講法 ──');
{
  const { isPartnershipAsk } = await import('../lib/b2b-line.js');
  const yes = ['企業合作洽詢', '技術授權要找誰', '你好，我想跟工研院談合作', '我們公司想跟工研院合作', '本公司希望與工研院洽談合作',
    '想洽談技術合作', '想談合作', '我是廠商想洽詢合作', '我是台灣某某電子公司的，想洽談合作', '合作窗口', '技術合作的窗口是誰',
    '想委託工研院開發', '我想技轉', '我想技轉工研院的電池技術', '想授權工研院的技術', '想取得授權'];
  const no = ['產學合作', '技術合作', '授權', '技轉', '技術移轉', '合作', '你好', '工研院跟台積電合作的新聞', '工研院跟台積電合作',
    '工研院與台積電談合作', '這場記者會有合作廠商嗎', '合作的廠商有哪些', '討論合作的新聞', '我是經濟日報記者，想跟工研院談合作報導',
    '工研院技轉了什麼技術', '工研院的電池技術'];
  for (const t of yes) check(`認得：「${t}」`, isPartnershipAsk(t));
  for (const t of no) check(`★ 不攔：「${t}」（記者的新聞關鍵字或新聞題）`, !isPartnershipAsk(t));
}

// ═══ 二、questions 工具 ═════════════════════════════════════════════════════════
console.log('\n── 二、後台米亞 questions 工具：讀不懂的時間 ──');
{
  const A = await import('../lib/assistant.js');
  const tw = (t) => new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const now = Date.now();
  book.qa_log = [['time'],
    [tw(now - 3600e3), 'e1', '某記者會', '經濟日報', '新的一題', '答', '', 'web', ''],
    ['（手動貼上）', 'e1', '某記者會', '中央社', '時間欄是亂的', '答', '', 'web', ''],
    ['', 'e1', '某記者會', '中時', '時間欄是空的', '答', '', 'web', ''],
    [tw(now - 30 * 86400e3), 'e1', '某記者會', '聯合報', '一個月前', '答', '', 'web', '']];
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const last = body.messages.at(-1);
    const mk = (content, stop) => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: stop, usage: {} }) });
    if (typeof last.content === 'string') return mk([{ type: 'tool_use', id: 't1', name: 'questions', input: { days: 7 } }], 'tool_use');
    return mk([{ type: 'text', text: '好了' }], 'end_turn');
  };
  await A.runAssistant([{ role: 'user', content: '這週記者問了什麼' }], { apiKey: 'k' });
  const r = JSON.parse(calls[1].messages.at(-1).content[0].content);
  check('★ 最近 7 天只算時間讀得懂、而且在 7 天內的（1 題），時間讀不懂的 2 筆不算進去', r.total === 1 && r.latest.length === 1 && r.latest[0].question === '新的一題', JSON.stringify(r));
  check('　 回報略過幾筆（skipped_unknown_time），模型才不會把總數講得像是完整的', r.skipped_unknown_time === 2, JSON.stringify(r));
  const src = fs.readFileSync(path.join(ROOT, 'lib/assistant.js'), 'utf8');
  check('　 工具說明要她把略過的筆數告訴使用者', /skipped_unknown_time 是略過的筆數，有的話要跟使用者說/.test(src));
}

// ═══ 三、確認卡：執行到一半離開頁面 ════════════════════════════════════════════
console.log('\n── 三、後台米亞確認卡：執行到一半離開 ──');
{
  const js = fs.readFileSync(path.join(ROOT, 'public/mia-assistant.js'), 'utf8');
  // 在假的瀏覽器環境裡把 mia-assistant.js 跑起來：sessionStorage 裡放一張「執行中」的卡，模擬上次按了確認就離開
  const store = {
    itri_pwd: 'pw',
    mia_assist_v1: JSON.stringify([
      { role: 'user', text: '幫我開一個活動草稿' },
      { role: 'card', proposal: { kind: 'create_event_draft', title: '新增活動草稿', fields: [], request: { url: '/api/events', body: { action: 'create', name: 'x' } } }, status: 'working', note: '執行中…' },
      { role: 'card', proposal: { kind: 'add_reporter', title: '新增一位記者', fields: [], request: { url: '/api/media', body: { action: 'add' } } }, status: 'pending' },
    ]),
  };
  const made = [];
  const mkEl = (tag) => {
    const e = { tag, children: [], style: {}, className: '', textContent: '', classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, setAttribute() {}, focus() {}, scrollHeight: 0 };
    made.push(e);
    return e;
  };
  const sandbox = {
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }), innerHeight: 800, dispatchEvent() {} },
    document: { readyState: 'complete', head: mkEl('head'), body: mkEl('body'), createElement: mkEl, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    setInterval: () => 0, setTimeout: () => 0, getComputedStyle: () => ({ position: 'static' }), JSON, Math, String, Array, Object,
    CustomEvent: function () {}, fetch: async () => { throw new Error('不該送出任何請求'); },
  };
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  vm.runInNewContext(js, sandbox);
  const buttons = made.filter((e) => e.tag === 'button').map((e) => e.textContent);
  const notes = made.filter((e) => e.className === 'st').map((e) => e.textContent);
  check('★ 上次「執行中」就離開的卡：回來變成「不確定有沒有完成」，沒有「確認執行」可以再按', notes.some((t) => /不確定有沒有完成/.test(t)) && buttons.filter((t) => t === '確認執行').length === 1, JSON.stringify({ buttons, notes }));
  check('　 其他還在等確認的卡照舊可以按（只有一顆「確認執行」＝那張待確認的）', buttons.filter((t) => t === '取消').length === 1);
  check('　 按下「確認執行」的當下就先存成「執行中」（不是等結果回來才存）', /m\.status = 'working'; m\.note = '執行中…'; save\(\);/.test(js));
  // 連線中斷（含頁面重新整理把請求中斷）→ 沒拿到回應 → 「不確定」，不是「沒有成功」（走查實際踩到：重新整理時瀏覽器丟 Failed to fetch）
  const exec = js.slice(js.indexOf('async function execute'), js.indexOf('function history'));
  check('★ 沒拿到伺服器回應（斷線、重新整理）→ 記成「不確定有沒有完成」，不是「沒有成功」（不然人會再叫她做一次）',
    /if \(!res\) \{[\s\S]*?m\.status = 'unknown'/.test(exec) && /不確定有沒有寫入；請使用者先確認，不要直接再提議一次/.test(exec));
}

// ═══ 四、同仁換 mail 要管理員核准 ══════════════════════════════════════════════
console.log('\n── 四、記者名單：同仁換掉既有 mail 要管理員核准 ──');
{
  reset();
  book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
  book.media_roster = [['id'],
    ['R1', '吳雅婷', '三立新聞', '半導體', 'wu@setn.com', '0912111222', 86, 3, 0, '2026-09-01', 'active', '', '', ''],
    ['R2', '張大同', '中央社', '', '', '', 1, 0, 0, '', 'active', '', '', ''],
    ['R3', '林小美', '聯合報', '生醫', 'lin@udn.com', '', 4, 0, 0, '', 'active', '', '', '']];
  const media = (await import('../api/media.js')).default;
  const call = async (method, q, body = {}, headers = {}) => {
    let code = 200, out;
    const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
    await media({ method, query: q, headers, body, socket: { remoteAddress: '8.8.8.8' } }, res);
    return { code, out };
  };
  const AD = { 'x-admin-password': 'pw' };
  const row = (id) => book.media_roster.find((x) => x[0] === id);
  const reqs = () => (book.media_mail_requests || []).slice(1).filter((x) => x && x[0]);

  let r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'evil@example.com', phone: '0911-000-000', updated_by: '小林' });
  check('★ 同仁換掉既有的 mail → 名單上的 mail 不變、回 pending_email；同一次的其他欄位照樣更新',
    r.code === 200 && r.out.pending_email === true && row('R1')[4] === 'wu@setn.com' && row('R1')[5] === '0911-000-000', JSON.stringify([r.out, row('R1')]));
  check('　 排進 media_mail_requests：舊 mail、新 mail、誰送的、狀態 open', reqs().length === 1 && reqs()[0][5] === 'wu@setn.com' && reqs()[0][6] === 'evil@example.com' && reqs()[0][7] === '小林' && reqs()[0][8] === 'open', JSON.stringify(reqs()));
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'evil@example.com' });
  check('　 同一個申請送兩次不會排兩筆', reqs().length === 1);

  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R2', email: 'tung@cna.com.tw' });
  check('　 原本沒有 mail 的 → 同仁補上直接生效（之前根本寄不到，沒有收件人可以被搶走）', r.code === 200 && !r.out.pending_email && row('R2')[4] === 'tung@cna.com.tw', JSON.stringify([r.out, row('R2')]));
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'WU@setn.com', name: '吳雅婷' });
  check('　 mail 沒變（大小寫不同）不算換、不排申請', r.code === 200 && !r.out.pending_email && reqs().length === 1);
  r = await call('POST', {}, { action: 'update_contact', password: 'pw', id: 'R3', email: 'lin.new@udn.com' }, AD);
  check('　 管理員換 mail 直接生效', r.code === 200 && !r.out.pending_email && row('R3')[4] === 'lin.new@udn.com', JSON.stringify([r.out, row('R3')]));

  r = await call('GET', { action: 'mail_requests', code: 'staffcode1' });
  check('★ 同仁看不到待核准清單（裡面是 mail）→ 401', r.code === 401, r.code);
  r = await call('POST', {}, { action: 'mail_request_decide', code: 'staffcode1', id: reqs()[0][0], approve: true });
  check('★ 同仁不能自己核准 → 401，mail 沒變', r.code === 401 && row('R1')[4] === 'wu@setn.com', r.code);
  r = await call('GET', { action: 'mail_requests' }, {}, AD);
  check('管理員看得到待核准清單（姓名、媒體、舊 mail、新 mail）', r.code === 200 && r.out.requests.length === 1 && r.out.requests[0].new_email === 'evil@example.com' && r.out.requests[0].name === '吳雅婷', JSON.stringify(r.out));

  r = await call('POST', {}, { action: 'mail_request_decide', password: 'pw', id: reqs()[0][0], approve: false }, AD);
  check('管理員不核准 → mail 不變、申請標 rejected、清單上不再出現', r.code === 200 && row('R1')[4] === 'wu@setn.com' && reqs()[0][8] === 'rejected' && (await call('GET', { action: 'mail_requests' }, {}, AD)).out.requests.length === 0, JSON.stringify(reqs()));
  r = await call('POST', {}, { action: 'mail_request_decide', password: 'pw', id: reqs()[0][0], approve: true }, AD);
  check('　 處理過的不能再處理一次 → 409', r.code === 409 && row('R1')[4] === 'wu@setn.com');

  await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'wu.new@ettoday.net' });
  const second = reqs().find((x) => x[6] === 'wu.new@ettoday.net');
  r = await call('POST', {}, { action: 'mail_request_decide', password: 'pw', id: second[0], approve: true }, AD);
  check('管理員核准 → mail 真的換掉、申請標 approved、留下「管理員核准」', r.code === 200 && row('R1')[4] === 'wu.new@ettoday.net' && second[8] === 'approved' && row('R1')[13] === '管理員核准', JSON.stringify([r.out, row('R1'), second]));

  await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R3', email: 'shared@udn.com' });
  book.media_roster.push(['R4', '別人', '聯合報', '', 'shared@udn.com', '', 0, 0, 0, '', 'active', '', '', '']);
  const third = reqs().find((x) => x[6] === 'shared@udn.com');
  r = await call('POST', {}, { action: 'mail_request_decide', password: 'pw', id: third[0], approve: true }, AD);
  check('　 核准當下新 mail 已經是別人的 → 409、不換（不會變成兩筆同 mail）', r.code === 409 && /別人/.test(r.out.error) && row('R3')[4] === 'lin.new@udn.com', JSON.stringify(r.out));

  const html = fs.readFileSync(path.join(ROOT, 'public/media.html'), 'utf8');
  check('頁面：管理員有「同仁送來的 mail 修改」核准區；同仁更新後會被告知 mail 要等核准', /id="mailreq-box"/.test(html) && /function loadMailRequests/.test(html) && /function decideMailRequest/.test(html) && /mail 的修改要等管理員核准/.test(html) && /要管理員核准<\/span>/.test(html));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 145 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
