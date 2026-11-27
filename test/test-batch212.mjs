// 批次 212：記者名單健檢跟活動報名、活動問答同步；有活動紀錄的自動算確認；待確認與同步建議可以批次處理。
// 人名、單位、mail 全部是虛構的。真的 api/media.js，只有 Google 試算表是假的。
import { register } from 'node:module';
import assert from 'node:assert/strict';

register('./loader-82.mjs', import.meta.url);
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
const { book, calls, reset } = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const { resetSyncCache } = await import('../lib/media-sync.js');
const media = (await import('../api/media.js')).default;

let pass = 0;
const ok = (label, cond, detail = '') => { assert.ok(cond, `${label} ${detail}`); pass++; console.log(`✅ ${label}`); };

const req = async (method, q, body = {}, headers = {}) => {
  let code = 200, out;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
  await media({ method, query: q, headers, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, out };
};
const ADMIN = { 'x-admin-password': 'pw' };
const adminGet = (q) => req('GET', q, {}, ADMIN);
const adminPost = (body) => req('POST', {}, body, ADMIN);
const staffGet = (q) => req('GET', { ...q, code: 'staffcode1' });
const staffPost = (body) => req('POST', {}, { ...body, code: 'staffcode1' });

const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const qaTime = (d) => new Date(Date.now() - d * 86400000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const person = (id, name, outlet, extra = {}) => [id, name, outlet, extra.beat ?? '', extra.email ?? '', extra.phone ?? '', 0, 0, 0, '', extra.status ?? 'active', '', extra.updated ?? '', ''];
const campaignRow = (id, audience = '') => { const row = new Array(R.CAMPAIGN_HEADERS.length).fill(''); const set = (k, v) => { row[R.CAMPAIGN_HEADERS.indexOf(k)] = v; }; set('id', id); set('title', `測驗活動${id}`); set('status', 'open'); set('audience', audience); return row; };
const regRow = (id, camp, name, outlet, email, extra = {}) => { const row = new Array(R.REG_HEADERS.length).fill(''); const set = (k, v) => { row[R.REG_HEADERS.indexOf(k)] = v; }; Object.entries({ reg_id: id, campaign_id: camp, created_at: extra.at ?? iso(10), updated_at: extra.at ?? iso(10), name, outlet, email, phone: extra.phone ?? '', status: extra.status ?? 'active', source: extra.source ?? 'web' }).forEach(([k, v]) => set(k, v)); return row; };

function setup() {
  reset();
  R.resetRegistrationState();
  resetSyncCache();
  book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
  book.media_roster = [['id'],
    person('R1', '王一', '經濟日報', { email: 'one@a.example' }),                 // 同單位報名 → 自動確認＋補電話
    person('R2', '李二', '聯合報', { email: 'two@a.example' }),                   // 同 mail、換單位 → 換媒體建議
    person('R3', '陳三', '中央社'),                                               // 問答提問 → 自動確認
    person('R4', '林四', '工商時報', { status: 'left' }),                         // 舊版誤判標離職 → 恢復建議
    person('R5', '張五', '自由時報', { email: 'five@a.example' }),                // 沒有任何紀錄 → 待確認
    person('R6', '吳六', '公視', { email: 'six@a.example' }),                     // 同名不同單位 → 只建議、不確認
    person('R7', '周七', '三立', { email: 'seven@a.example', beat: '經濟部線' }), // 換新 mail → 同仁要管理員核准
    person('R8', '鄭八', '民視', { email: 'eight@a.example' }),                   // 只有企業場、測試報名 → 不算
    person('R9', '黃九', '年代', { email: 'nine@a.example', updated: qaTime(2) }), // 名單在報名之後改過 → 不建議
  ];
  book.reg_campaigns = [R.CAMPAIGN_HEADERS, campaignRow('C1'), campaignRow('C2', 'business')];
  book.registrations = [R.REG_HEADERS,
    regRow('A1', 'C1', '王一', '經濟日報社', 'one@a.example', { phone: '0912345678' }),
    regRow('A2', 'C1', '李二', '工商時報', 'two@a.example'),
    regRow('A6', 'C1', '吳六', '鏡週刊', 'other@b.example'),
    regRow('A7', 'C1', '周七', '三立新聞', 'new7@b.example'),
    regRow('A8', 'C2', '鄭八', '某公司', 'eight@a.example'),
    regRow('A9', 'C1', '鄭八', '某公司', 'eight@a.example', { source: 'web:test' }),
    regRow('AA', 'C1', '黃九', '非凡', 'nine@a.example'),
    regRow('AB', 'C1', '新人', '科技新報', 'newbie@b.example', { phone: '0922333444' }),
    regRow('AC', 'C1', '舊人', '科技新報', 'old@b.example', { at: iso(500) }),
  ];
  book.qa_log = [['時間'],
    [qaTime(3), 'e1', '活動', '中央社', '問題', '答', '', 'web', '陳三'],
    [qaTime(3), 'e1', '活動', '中天', '問題', '答', '', 'web', '張五'],   // 問答單位不同：不拿來判斷換媒體
    [qaTime(3), 'e1', '活動', '中央社', '問題', '答', '1', 'web', '張五'], // 刪掉的不算
  ];
  book.media_watch = [['id'], ['R4', iso(5), 'moved', '0', '別家', '3', iso(6), '[]', '1']];
}

setup();
let r = await adminGet({ action: 'list' });
ok('清單讀得到', r.code === 200, JSON.stringify(r.out));
const pendingIds = r.out.needsReview.map((x) => x.id).sort().join();
ok('有報名／提問紀錄的自動確認，不進待確認；換媒體的改在同步區處理', pendingIds === 'R5,R6,R8', pendingIds);
ok('自動確認的來源分得出來', r.out.verified.registration === 2 && r.out.verified.qa === 1, JSON.stringify(r.out.verified));
ok('待確認數字跟清單一致', r.out.totalNeedsReview === 3);
ok('缺路線另外算', r.out.totalNoBeat === 7, String(r.out.totalNoBeat));

r = await adminGet({ action: 'list' });
const by = (type, name) => r.out.suggestions.find((s) => s.type === type && s.name === name);
ok('同 mail 換單位 → 換媒體建議（預設勾）', by('outlet', '李二')?.to === '工商時報' && by('outlet', '李二').safe);
ok('同名不同單位 → 只當可能、預設不勾', by('outlet_maybe', '吳六')?.safe === false);
ok('舊版新聞推測標離職的 → 恢復建議', by('restore_news', '林四')?.safe === false);
ok('補電話', by('phone', '王一')?.safe);
ok('換 mail 預設不勾', by('email', '周七')?.safe === false);
ok('名單外報名者', by('new', '新人')?.safe && by('new', '新人').email === 'newbie@b.example');
ok('超過一年的報名、企業場、測試報名都不算', !by('new', '舊人') && !r.out.suggestions.some((s) => s.name === '鄭八'));
ok('名單在報名之後有人改過 → 不建議改回去', !r.out.suggestions.some((s) => s.name === '黃九'));
ok('清單與建議都不寫試算表', !calls.some(([kind]) => kind !== 'read'), JSON.stringify(calls.filter(([k]) => k !== 'read')));
calls.length = 0;
await adminGet({ action: 'list' });
ok('★ 一分鐘內重整清單只重讀名單與署名紀錄（讀取額度跟米亞問答共用）', calls.length <= 2, JSON.stringify(calls));
resetSyncCache();
calls.length = 0;
await adminGet({ action: 'list' });
ok('　 沒有快取時一次清單最多讀 7 次', calls.length <= 7, JSON.stringify(calls));

r = await staffGet({ action: 'list' });
const text = JSON.stringify(r.out);
ok('同仁看到的 mail／電話有遮', !text.includes('newbie@b.example') && !text.includes('0922333444') && !text.includes('new7@b.example') && !text.includes('0912345678'), text);
ok('同仁換掉既有 mail 會標示要核准', r.out.suggestions.find((s) => s.type === 'email').needsAdmin);
ok('沒有連結碼讀不到', (await req('GET', { action: 'list', code: 'bad' })).code === 401);

const keys = r.out.suggestions.filter((s) => ['李二', '林四', '王一', '周七', '新人'].includes(s.name)).map((s) => s.key);
r = await staffPost({ action: 'sync_apply', keys, to: '亂改', outlet: '亂改' });
ok('同仁批次套用', r.code === 200 && r.out.applied === 4 && r.out.pending_email === 1, JSON.stringify(r.out));
const row = (id) => book.media_roster.find((x) => x[0] === id);
ok('換媒體寫進去、原媒體留在備註', row('R2')[2] === '工商時報' && row('R2')[11] === '原媒體：聯合報');
ok('恢復在職', row('R4')[10] === 'active');
ok('電話補上', row('R1')[5] === '0912345678');
ok('同仁換 mail 沒有直接生效、進核准清單', row('R7')[4] === 'seven@a.example' && book.media_mail_requests.some((x) => x[2] === 'R7' && x[6] === 'new7@b.example'));
const added = book.media_roster.find((x) => x[1] === '新人');
ok('新記者進名單、有新編號', added && added[0] === 'N0001' && added[4] === 'newbie@b.example');
ok('沒勾的不動', row('R6')[2] === '公視' && !book.media_roster.some((x) => x[1] === '舊人'));

r = await staffPost({ action: 'sync_apply', keys });
ok('同一批再按一次不會重複寫', r.out.applied === 0 && book.media_roster.filter((x) => x[1] === '新人').length === 1 && book.media_mail_requests.filter((x) => x[2] === 'R7').length === 1, JSON.stringify(r.out));

r = await adminGet({ action: 'list' });
const maybe = r.out.suggestions.find((s) => s.type === 'outlet_maybe');
r = await adminPost({ action: 'sync_dismiss', keys: [maybe.key] });
ok('忽略', r.out.dismissed === 1);
r = await adminGet({ action: 'list' });
ok('忽略過的不再出現', !r.out.suggestions.some((s) => s.key === maybe.key));
ok('亂送的 key 擋掉', (await adminPost({ action: 'sync_apply', keys: ['../x'] })).code === 400);

// ── 批次處理待確認 ──
setup();
ok('批次確認需要連結碼', (await req('POST', {}, { action: 'batch', code: 'bad', ids: ['R5'], op: 'confirm' })).code === 401);
ok('批次不提供刪除', (await staffPost({ action: 'batch', ids: ['R5'], op: 'delete' })).code === 400);
ok('一次上限 200', (await staffPost({ action: 'batch', ids: Array.from({ length: 201 }, (_, i) => `X${i}`), op: 'confirm' })).code === 400);
ok('只設路線要選路線', (await staffPost({ action: 'batch', ids: ['R5'], op: 'beat' })).code === 400);
calls.length = 0;
r = await staffPost({ action: 'batch', ids: ['R5', 'R6', 'R4'], op: 'confirm' });
ok('批次確認：離職的不會被順手復活', r.out.affected === 2 && row('R4')[10] === 'left', JSON.stringify(r.out));
ok('只寫一次試算表', calls.filter(([k]) => k !== 'read').length === 1, JSON.stringify(calls));
r = await staffGet({ action: 'list' });
ok('確認完就離開待確認', r.out.needsReview.map((x) => x.id).sort().join() === 'R8');
r = await staffPost({ action: 'batch', ids: ['R8'], op: 'beat', beat: '經濟部線' });
ok('只設路線不算確認在職', row('R8')[3] === '經濟部線' && row('R8')[12] === '' && (await staffGet({ action: 'list' })).out.needsReview.some((x) => x.id === 'R8'));
await staffPost({ action: 'batch', ids: ['R8'], op: 'left' });
ok('批次標離職', row('R8')[10] === 'left');
ok('沒動到的列完好', row('R5')[2] === '自由時報' && row('R1')[4] === 'one@a.example');

// 同步來源讀不到時：不誤判成在職，講清楚
setup();
const { ctl } = await import('./fakes-sheets82.mjs');
ctl.failReads.add('registrations');
resetSyncCache();
r = await adminGet({ action: 'list' });
ok('報名讀不到：清單照出、明講讀不到', r.code === 200 && r.out.unavailable.includes('活動報名') && r.out.needsReview.some((x) => x.id === 'R1'), JSON.stringify(r.out.unavailable));
ok('報名讀不到：不套用建議', (await adminPost({ action: 'sync_apply', keys: ['0000000000000000'] })).code === 500);
ctl.failReads.clear();

// 重複與缺 mail 篩選
setup();
book.media_roster.push(person('R10', '王一', '經濟日報'));
r = await adminGet({ action: 'all', issue: 'dup' });
ok('重複篩選', r.out.rows.map((x) => x.id).sort().join() === 'R1,R10', JSON.stringify(r.out.rows.map((x) => x.id)));
r = await adminGet({ action: 'all', issue: 'noemail' });
ok('缺 mail 篩選', r.out.rows.every((x) => !x.email) && r.out.rows.length === 2);

console.log(`\n✅ 批次 212 測試：${pass} 通過，0 失敗`);
