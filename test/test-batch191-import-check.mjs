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
