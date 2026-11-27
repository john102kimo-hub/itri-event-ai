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
assert.ok(T.sameOutlet('Yahoo奇摩新聞', 'Yahoo股市'));
assert.ok(!T.sameOutlet('聯合報', '新聞'), '光是「新聞」認不出是哪一家');
assert.equal(T.outletDomain('中央社'), 'cna.com.tw');
assert.equal(T.outletDomain('Yahoo奇摩新聞'), 'yahoo.com');
assert.equal(T.outletDomain('鏡週刊'), 'mirrormedia.mg');

// 主流判斷
assert.ok(T.isMainstream('經濟日報'));
assert.ok(T.isMainstream('中央社 CNA'));
assert.ok(!T.isMainstream('某某地方生活報'));
assert.ok(!T.isMainstream(''));
assert.deepEqual(T.parseOutletList('甲報、乙報,丙報\n丁報'), ['甲報', '乙報', '丙報', '丁報']);

// 判斷：只做正面查證，永遠不下「換媒體／離職」的結論（批次 212）
const wang = rec('m1', '王大明', '經濟日報');
assert.equal(T.judge(wang, [hit('經濟日報', 10)], NOW).verdict, 'ok');
assert.equal(T.judge(wang, [hit('UDN 經濟日報', 10), hit('工商時報', 5), hit('工商時報', 8)], NOW).same_count, 1);
const far = T.judge(wang, [hit('工商時報', 5), hit('工商時報', 20), hit('工商時報', 30)], NOW);
assert.equal(far.verdict, 'unclear', '別家有幾篇都不算換媒體');
assert.equal(far.other_source, '');
assert.deepEqual(far.evidence, [], '別家的連結不拿出來給人看');
assert.equal(T.judge(wang, [], NOW).verdict, 'silent');
assert.equal(T.judge(wang, [hit('經濟日報', 200)], NOW).verdict, 'silent', '超過 120 天的不算');

// 兩個正式使用的誤判（2026-11-27 實測的搜尋結果形狀）
const cnaRec = rec('m8', '張記者', '中央社');
const reprints = Array.from({ length: 25 }, (_, i) => hit('放言Fount Media', i + 1));
assert.notEqual(T.judge(cnaRec, reprints, NOW).verdict, 'moved', '通訊社稿件被轉載不是換媒體');
const queries = [];
const fakeFetch = (pages) => async (url) => {
  const q = new URL(url).searchParams.get('q'); queries.push(q);
  const items = (q.includes('site:') ? pages.site : pages.plain).map(([source, link]) => `<item><title>t</title><link>${link}</link><pubDate>${new Date().toUTCString()}</pubDate><source url="x">${source}</source></item>`).join('');
  return { ok: true, text: async () => `<rss>${items}</rss>` };
};
let found = await T.searchBylines(cnaRec, fakeFetch({ plain: [['放言Fount Media', 'a']], site: [['中央社 CNA', 'b'], ['中央社 CNA', 'c']] }));
assert.equal(T.judge(cnaRec, found).verdict, 'ok', '原媒體被轉載擠掉時，限定原媒體網站再查一次找得回來');
assert.ok(queries.length === 2 && queries[1].includes('site:cna.com.tw') && !queries.some((q) => q.includes(' OR ')), queries.join(' / '));
queries.length = 0;
found = await T.searchBylines(rec('m9', '陳記者', 'Yahoo'), fakeFetch({ plain: [['Yahoo股市', 'a'], ['Yahoo股市', 'b']], site: [] }));
assert.equal(queries.length, 1, '第一輪就夠了不多查');
assert.equal(T.judge(rec('m9', '陳記者', 'Yahoo'), found).same_count, 2);

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

// 排程：查完寫回 media_watch，不推播、不下指控
const writes = [];
const store = { update: async (n, row) => writes.push(['u', n, row]), append: async (rows) => writes.push(['a', rows]) };
const search = async (p) => (p.name === '王大明' ? [hit('工商時報', 5), hit('工商時報', 9)] : [hit(p.outlet, 3), hit(p.outlet, 4)]);
let out = await T.runWatchCron({ now: NOW, roster, watch, list: T.DEFAULT_MAINSTREAM, search, store, gapMs: 0 });
assert.equal(out.checked, 2);
assert.equal(out.confirmed, 1);
assert.equal(out.notfound, 1);
assert.ok(!('moved' in out) && !('pushed' in out));
const appended = writes.find((w) => w[0] === 'a')[1];
assert.equal(appended.find((r) => r[0] === 'm1')[2], 'unclear');
assert.equal(appended.find((r) => r[0] === 'm1')[7], '[]');
out = await T.runWatchCron({ now: NOW, roster, watch: [], list: T.DEFAULT_MAINSTREAM, search, store, gapMs: 0, deadlineMs: -1 });
assert.equal(out.checked, 0);

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

// 舊版留下的「疑似換媒體」紀錄：不再掛標記，離職的列出來讓人恢復
book.media_watch = [['id'], ['R1', daysAgo(1), 'moved', '0', '工商時報', '2', daysAgo(2), '[]', '1']];
r = await call('GET', { action: 'list', code: 'staffcode1' });
assert.equal(r.code, 200);
assert.ok(!JSON.stringify(r.out).includes('工商時報'), JSON.stringify(r.out));

console.log('批次 188 署名查證：全部通過');
