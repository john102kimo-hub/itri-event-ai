// 批次 191：匯入後自動盤查（lib/media-tracker.js checkImported ＋ api/media.js import_check）。
// 只有「疑似換媒體」會被建議刪除；查不到署名（silent）不建議刪除，名單照樣留著。
import { register } from 'node:module';
import assert from 'node:assert/strict';

register('./loader-82.mjs', import.meta.url);
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
const T = await import('../lib/media-tracker.js');

const NOW = new Date('2026-11-05T02:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const hit = (source, n) => ({ title: '某則報導', link: `https://news.example/${source}/${n}`, source, publishedAt: daysAgo(n) });
const rec = (id, name, outlet, status = 'active') => T.parseRosterRow([id, name, outlet, '', '', '', 0, 0, 0, '', status, '', '', ''], Number(id.replace(/\D/g, '')));

const roster = [
  rec('N1', '王大明', '經濟日報'),            // 原媒體還有署名 → ok
  rec('N2', '李小華', '聯合報'),              // 另一家連續署名 → 建議刪除
  rec('N3', '陳小弟', '某某地方生活報'),      // 完全查不到 → silent，不建議刪除（小媒體常沒收錄）
  rec('N4', '收稿信箱人員姓名過長不是人', '上報'), // 非個人 → 略過
  rec('N5', '林離職', '中央社', 'left'),      // 已離職 → 略過
  rec('N6', '張失敗', '工商時報'),            // 查詢失敗 → 留在 remaining
  rec('N7', '不在這批', '工商時報'),          // 沒被要求 → 不查
];
const map = { 王大明: [hit('經濟日報', 5)], 李小華: [hit('工商時報', 4), hit('工商時報', 9)] };
const searched = [];
const search = async (n) => { searched.push(n); if (n === '張失敗') throw new Error('boom'); return map[n] || []; };
const writes = [];
const store = { update: async (n, row) => writes.push(['u', n, row]), append: async (rows) => writes.push(['a', rows]) };

let out = await T.checkImported({ ids: ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'], now: NOW, roster, watch: [], search, store, gapMs: 0 });
assert.equal(out.checked, 3);
assert.equal(out.ok, 1);
assert.equal(out.silent, 1, 'silent 只回報數量');
assert.equal(out.skipped, 2, '非個人與已離職略過');
assert.deepEqual(out.remaining, ['N6'], '失敗的留給下一輪');
assert.equal(out.failed, 1);
assert.deepEqual(out.suggest_delete.map((s) => s.id), ['N2'], '只有疑似換媒體才建議刪除');
assert.equal(out.suggest_delete[0].other_source, '工商時報');
assert.ok(out.suggest_delete[0].link.startsWith('https://'));
assert.ok(!searched.includes('不在這批') && !searched.includes('林離職'), '沒要求的與離職的不查');
assert.equal(writes.find((w) => w[0] === 'a')[1].length, 3, '三位查過的都寫進 media_watch');

// 不看「28 天內查過」：剛匯進來就是要現在查
writes.length = 0;
out = await T.checkImported({ ids: ['N1'], now: NOW, roster, watch: [{ id: 'N1', checked_at: daysAgo(1), verdict: 'ok', rowNum: 2, evidence: [] }], search, store, gapMs: 0 });
assert.equal(out.checked, 1);
assert.equal(writes[0][0], 'u');

// 人按過「還在跑」的同一家不再建議刪除
out = await T.checkImported({ ids: ['N2'], now: NOW, roster, watch: [{ id: 'N2', checked_at: daysAgo(30), verdict: 'dismissed', other_source: '工商時報', rowNum: 2, evidence: [] }], search, store, gapMs: 0 });
assert.equal(out.suggest_delete.length, 0);

// 逾時收工：沒查到的全部留在 remaining，畫面接著打
out = await T.checkImported({ ids: ['N1', 'N2'], now: NOW, roster, watch: [], search, store, gapMs: 0, deadlineMs: -1 });
assert.equal(out.checked, 0);
assert.deepEqual(out.remaining, ['N1', 'N2']);

// ═══ 後端：真的 api/media.js ═══
const { book, reset } = await import('./fakes-sheets82.mjs');
reset();
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
const media = (await import('../api/media.js')).default;
const call = async (body, headers = {}) => {
  let code = 200, o;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(x) { o = x; return res; }, send(x) { o = x; return res; }, end() { return res; } };
  await media({ method: 'POST', query: {}, headers, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, o };
};
let r = await call({ action: 'seed', password: 'pw', csv: 'id,name,outlet\nN1,王大明,經濟日報\nN2,李小華,聯合報' }, { 'x-admin-password': 'pw' });
assert.deepEqual(r.o.ids, ['N1', 'N2'], 'seed 回傳這一批的 id，畫面拿去盤查');
assert.equal((await call({ action: 'import_check', code: 'staffcode1', ids: ['N1'] })).code, 401, '同仁連結不能觸發對外查詢');
assert.equal((await call({ action: 'import_check', password: 'pw', ids: [] }, { 'x-admin-password': 'pw' })).code, 400);
console.log('批次 191 匯入後自動盤查：全部通過');

// ═══ 批次 192：一鍵盤查既有待確認（pending_ids）═══
reset();
const old = (d) => new Date(Date.now() - d * 86400000).toISOString();
book.media_roster = [['id'],
  ['P1', '甲甲', '聯合報', '', '', '', 0, 0, 0, '', 'active', '', '', ''],            // 路線空白 → 待確認
  ['P2', '乙乙', '經濟日報', '經濟部線', '', '', 0, 0, 0, '', 'active', '', '', ''],  // 沒受邀紀錄 → 待確認
  ['P3', '丙丙', '工商時報', '', '', '', 0, 0, 0, '', 'left', '', '', ''],            // 離職 → 不查
  ['P4', '丁丁', '中央社', '', '', '', 0, 0, 0, '', 'active', '', '', ''],            // 剛查過 → 跳過
  ['P5', '戊戊戊戊戊戊', '上報', '', '', '', 0, 0, 0, '', 'active', '', '', ''],      // 非個人 → 跳過
  ['P6', '己己', '自由時報', '', '', '', 0, 0, 0, '', 'active', '', '', ''],          // 已標疑似換媒體 → 人還沒處理，不重查
];
book.media_watch = [['id'],
  ['P4', old(3), 'ok', 1, '', 0, '', '[]', '1'],
  ['P6', old(60), 'moved', 0, '工商時報', 2, '', '[]', '1']];
const get = async (q, headers = {}) => {
  let code = 200, o;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(x) { o = x; return res; }, send(x) { o = x; return res; }, end() { return res; } };
  await media({ method: 'GET', query: q, headers, body: {}, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, o };
};
assert.equal((await get({ action: 'pending_ids', code: 'x' })).code, 401, '同仁連結不能觸發');
const pend = await get({ action: 'pending_ids' }, { 'x-admin-password': 'pw' });
assert.deepEqual(pend.o.ids.sort(), ['P1', 'P2'], '只含待確認、在職、像個人、近期沒查過、沒被標疑似換媒體的');
console.log('批次 192 一鍵盤查待確認：全部通過');

// ═══ 批次 193：全部名單管理（all／bulk）═══
reset();
book.media_roster = [['id'],
  ['A1', '甲甲', '聯合報', '經濟部線', 'a@x.com', '0911', 2, 0, 0, '', 'active', '', '', ''],
  ['A2', '乙乙', '經濟日報', '', 'b@x.com', '0922', 0, 0, 0, '', 'active', '', '', ''],
  ['A3', '丙丙', '工商時報', '半導體', 'c@x.com', '', 0, 0, 0, '', 'left', '', '', ''],
  ['A4', '丁丁', '中央社', '台北工研院線', 'd@x.com', '', 0, 0, 0, '', 'active', '', '', '']];
const adm = { 'x-admin-password': 'pw' };
assert.equal((await get({ action: 'all', code: 'x' })).code, 401, '全部名單含 mail，不開放同仁連結');
let a = (await get({ action: 'all' }, adm)).o;
assert.equal(a.total, 3, '預設只看在職');
assert.equal(a.all, 4); assert.equal(a.active, 3);
assert.equal(a.rows.find((x) => x.id === 'A1').email, 'a@x.com', '管理員看得到 mail');
assert.equal((await get({ action: 'all', status: 'left' }, adm)).o.rows[0].id, 'A3');
assert.equal((await get({ action: 'all', status: 'all' }, adm)).o.total, 4);
assert.deepEqual((await get({ action: 'all', beat: '__none' }, adm)).o.rows.map((x) => x.id), ['A2'], '未填路線');
assert.deepEqual((await get({ action: 'all', q: 'b@x' }, adm)).o.rows.map((x) => x.id), ['A2'], '可搜 mail');
assert.equal((await get({ action: 'all', size: 10 }, adm)).o.size, 10);

assert.equal((await call({ action: 'bulk', code: 'staffcode1', ids: ['A1'], op: 'delete' })).code, 401);
assert.equal((await call({ action: 'bulk', password: 'pw', ids: ['A1'], op: 'beat', beat: '亂填' }, adm)).code, 400, '路線只收三線');
assert.equal((await call({ action: 'bulk', password: 'pw', ids: [], op: 'left' }, adm)).code, 400);
let b = await call({ action: 'bulk', password: 'pw', ids: ['A1', 'A2'], op: 'beat', beat: '新竹工研院線' }, adm);
assert.equal(b.o.affected, 2);
assert.equal(book.media_roster.find((r) => r[0] === 'A2')[3], '新竹工研院線');
b = await call({ action: 'bulk', password: 'pw', ids: ['A4'], op: 'left' }, adm);
assert.equal(book.media_roster.find((r) => r[0] === 'A4')[10], 'left');
b = await call({ action: 'bulk', password: 'pw', ids: ['A3', 'ZZ'], op: 'delete' }, adm);
assert.equal(b.o.affected, 1, '不存在的 id 不算');
assert.ok(!book.media_roster.some((r) => r[0] === 'A3'), '刪掉就不在了');
assert.equal(book.media_roster.filter((r) => r[0] && r[0] !== 'id').length, 3, '其他人完好');
console.log('批次 193 全部名單管理：全部通過');
