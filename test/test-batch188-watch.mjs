// 批次 188：主流媒體記者「疑似換媒體」追蹤（lib/media-tracker.js）。
// 純邏輯＋注入搜尋與推送，不打真的 Google News 與 LINE。
import { register } from 'node:module';
import assert from 'node:assert/strict';

register('./loader-82.mjs', import.meta.url); // Google 試算表換成假的，其餘用真的 api/media.js、lib/media-tracker.js
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_ADMIN_USER_ID = 'UADMIN';
process.env.CRON_SECRET = 'cronsecret';
const T = await import('../lib/media-tracker.js');
const parseRow = T.parseRosterRow;

const NOW = new Date('2026-11-05T02:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const hit = (source, n, title = '某則報導') => ({ title, link: `https://news.example/${source}/${n}`, source, publishedAt: daysAgo(n) });
const rec = (id, name, outlet, extra = {}) => parseRow([id, name, outlet, '', '', '', extra.invited ?? 2, 0, 0, '', extra.status ?? 'active', '', '', ''], Number(id.replace(/\D/g, '')) || 0);

// 媒體名稱比對
assert.ok(T.sameOutlet('聯合報', '聯合新聞網'));
assert.ok(T.sameOutlet('中央社', '中央社 CNA'));
assert.ok(T.sameOutlet('自由時報', '自由時報電子報'));
assert.ok(!T.sameOutlet('經濟日報', '工商時報'));
assert.ok(!T.sameOutlet('聯合報', '自由時報'));
assert.ok(T.isAggregator('Yahoo奇摩新聞'));
assert.ok(!T.isAggregator('工商時報'));

// 主流判斷
assert.ok(T.isMainstream('經濟日報'));
assert.ok(T.isMainstream('中央社 CNA'));
assert.ok(!T.isMainstream('某某地方生活報'));
assert.ok(!T.isMainstream(''));
assert.deepEqual(T.parseOutletList('甲報、乙報,丙報\n丁報'), ['甲報', '乙報', '丙報', '丁報']);

// 判斷
const wang = rec('m1', '王大明', '經濟日報');
assert.equal(T.judge(wang, [hit('經濟日報', 10)], NOW).verdict, 'ok');
assert.equal(T.judge(wang, [hit('UDN 經濟日報', 10), hit('工商時報', 5), hit('工商時報', 8)], NOW).verdict, 'ok', '原媒體有署名就算在職，不管別家');
const mv = T.judge(wang, [hit('工商時報', 5), hit('工商時報', 20), hit('Yahoo奇摩新聞', 3), hit('Yahoo奇摩新聞', 4)], NOW);
assert.equal(mv.verdict, 'moved');
assert.equal(mv.other_source, '工商時報');
assert.equal(mv.other_count, 2);
assert.equal(T.judge(wang, [hit('工商時報', 5)], NOW).verdict, 'unclear', '只有 1 篇不足以說換媒體');
assert.equal(T.judge(wang, [hit('Yahoo奇摩新聞', 5), hit('Yahoo奇摩新聞', 6)], NOW).verdict, 'unclear', '轉載平台不算另一家媒體');
assert.equal(T.judge(wang, [], NOW).verdict, 'silent');
assert.equal(T.judge(wang, [hit('工商時報', 200), hit('工商時報', 210)], NOW).verdict, 'silent', '超過 120 天的不算');

// 挑人：只挑主流、在職、沒被最近查過的；沒查過的先
const roster = [
  rec('m1', '王大明', '經濟日報', { invited: 5 }),
  rec('m2', '李小華', '聯合報', { invited: 1 }),
  rec('m3', '陳小弟', '某某地方生活報'),
  rec('m4', '林離職', '中央社', { status: 'left' }),
  rec('m5', '張剛查', '工商時報'),
];
const watch = [{ id: 'm5', checked_at: daysAgo(3), verdict: 'ok', rowNum: 2 }];
const batch = T.pickBatch(roster, watch, { now: NOW });
assert.deepEqual(batch.map((r) => r.id), ['m1', 'm2'], '依受邀次數排序，排除小媒體／離職／近期查過');
assert.equal(T.pickBatch(roster, watch, { now: NOW, size: 1 }).length, 1);

// 排程：moved 才推播、同結論不重複推、dismissed 不再提醒
const writes = [];
const store = { update: async (n, row) => writes.push(['u', n, row]), append: async (rows) => writes.push(['a', rows]) };
const always = async () => true;
const pushed = [];
const push = async (uid, text) => pushed.push([uid, text]);
const searchMap = {
  王大明: [hit('工商時報', 5), hit('工商時報', 9)],
  李小華: [hit('聯合新聞網', 4)],
};
const search = async (name) => { if (name === '失敗人') throw new Error('boom'); return searchMap[name] || []; };

let out = await T.runWatchCron({ now: NOW, roster, watch, list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0 });
assert.equal(out.checked, 2);
assert.equal(out.moved, 1);
assert.equal(out.ok, 1);
assert.equal(out.pushed, 1);
assert.equal(pushed[0][0], 'UADMIN', '只推給管理員');
assert.match(pushed[0][1], /王大明/);
assert.match(pushed[0][1], /不是確定/, '推播要老實說這是推測');
assert.doesNotMatch(pushed[0][1], /李小華/, '沒事的人不吵');
const appended = writes.find((w) => w[0] === 'a')[1];
assert.equal(appended.length, 2);
assert.equal(appended.find((r) => r[0] === 'm1')[2], 'moved');

// 第二輪：已通知過的同結論不再推
pushed.length = 0;
const watch2 = [{ id: 'm1', checked_at: daysAgo(30), verdict: 'moved', other_source: '工商時報', notified: '1', rowNum: 2, evidence: [] }];
out = await T.runWatchCron({ now: NOW, roster: [roster[0]], watch: watch2, list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0 });
assert.equal(out.moved, 1);
assert.equal(pushed.length, 0, '同一個疑似結論不重複通知');

// 人按了「還在跑」之後：同一家不再提醒、不推播
pushed.length = 0;
const watch3 = [{ id: 'm1', checked_at: daysAgo(30), verdict: 'dismissed', other_source: '工商時報', notified: '1', rowNum: 2, evidence: [] }];
out = await T.runWatchCron({ now: NOW, roster: [roster[0]], watch: watch3, list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0 });
assert.equal(out.moved, 0);
assert.equal(pushed.length, 0);

// 單一記者查詢失敗不影響其他人
const roster4 = [rec('m1', '王大明', '經濟日報'), rec('m9', '失敗人', '中央社')];
out = await T.runWatchCron({ now: NOW, roster: roster4, watch: [], list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0 });
assert.equal(out.failed, 1);
assert.equal(out.checked, 1);

// 文案不得有簡體
assert.doesNotMatch(T.formatWatchDigest([{ rec: wang, other_source: '工商時報', other_count: 2, evidence: [hit('工商時報', 5)] }]), /[这个们]/);

// 逾時收工：超過期限就不再查，已查的照寫；沒查的下次還排在最前面
writes.length = 0;
out = await T.runWatchCron({ now: NOW, roster, watch: [], list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0, deadlineMs: -1 });
assert.equal(out.checked, 0);

// 沒設定管理員 → 不推播、也不當掉；結果照常寫入
delete process.env.LINE_ADMIN_USER_ID;
pushed.length = 0;
out = await T.runWatchCron({ now: NOW, roster, watch: [], list: T.DEFAULT_MAINSTREAM, search, push, store, gapMs: 0 });
assert.equal(out.moved, 1);
assert.equal(out.pushed, 0);
assert.equal(pushed.length, 0);
process.env.LINE_ADMIN_USER_ID = 'UADMIN';

// 推播出口過簡體→繁體（CLAUDE.md 第 1 條）：記者姓名是人輸入的
pushed.length = 0;
await T.runWatchCron({ now: NOW, roster: [rec('m7', '张三', '经济日报')], watch: [], list: ['经济日报'], search: async () => [hit('工商時報', 5), hit('工商時報', 9)], push, store, gapMs: 0 });
assert.ok(pushed.length === 1 && !/[张济]/.test(pushed[0][1]), pushed[0]?.[1]);

// ═══ 後端：真的 api/media.js，只有 Google 試算表是假的 ═══
const { book, reset } = await import('./fakes-sheets82.mjs');
reset();
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
const media = (await import('../api/media.js')).default;
const call = async (method, q, body = {}, headers = {}) => {
  let code = 200, out;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
  await media({ method, query: q, headers, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, out };
};
const ago = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
let r = await call('POST', {}, { action: 'seed', password: 'pw', csv: ['id,name,outlet,beat,invited_count,last_invited', `R1,王大明,經濟日報,經濟部線,5,${ago(30)}`, `R2,李小華,聯合報,新竹工研院線,3,${ago(20)}`].join('\n') }, { 'x-admin-password': 'pw' });
assert.equal(r.code, 200);

// 排程入口：沒帶或帶錯 CRON_SECRET 一律拒絕（會打外部網站、會推播）
assert.equal((await call('GET', { action: 'watch_cron' })).code, 401);
assert.equal((await call('GET', { action: 'watch_cron' }, {}, { authorization: 'Bearer wrong' })).code, 401);
delete process.env.CRON_SECRET;
assert.equal((await call('GET', { action: 'watch_cron' }, {}, { authorization: 'Bearer ' })).code, 401, '沒設 CRON_SECRET 就一律拒絕');
process.env.CRON_SECRET = 'cronsecret';

// 查完把 R1 標成疑似換媒體（用真的 media_watch 分頁讀寫），名單頁就看得到證據
const liveRoster = book.media_roster.slice(1).map((row, i) => T.parseRosterRow(row, i));
await T.runWatchCron({ now: Date.now(), roster: liveRoster, list: T.DEFAULT_MAINSTREAM, push: async () => {}, gapMs: 0,
  search: async (name) => (name === '王大明' ? [hit('工商時報', 5), hit('工商時報', 9)] : []) });
r = await call('GET', { action: 'list', code: 'staffcode1' });
assert.equal(r.code, 200);
const moved = r.out.needsReview.find((x) => x.id === 'R1');
assert.ok(moved && moved.watch && moved.watch.other_source === '工商時報', JSON.stringify(r.out.needsReview));
assert.equal(moved.watch.evidence.length, 2);
assert.equal(r.out.needsReview[0].id, 'R1', '疑似換媒體的排最前面');
assert.ok(!r.out.needsReview.find((x) => x.id === 'R2')?.watch, '沒事的人不掛標記');

// 同仁按「還在跑」→ 標記收掉
r = await call('POST', {}, { action: 'update', code: 'staffcode1', id: 'R1', beat: '經濟部線' });
assert.equal(r.code, 200);
r = await call('GET', { action: 'list', code: 'staffcode1' });
assert.ok(!r.out.needsReview.find((x) => x.id === 'R1')?.watch, '按過還在跑就不再掛標記');

console.log('批次 188 離職追蹤：全部通過');
