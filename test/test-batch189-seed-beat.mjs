// 批次 189：一次性匯入可以指定「這一批統一的路線」。真的 api/media.js，只有 Google 試算表是假的。
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('./loader-82.mjs', import.meta.url);
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');
reset();
book.media_settings = [['key', 'value']];
const media = (await import('../api/media.js')).default;
const A = { 'x-admin-password': 'pw' };
const call = async (body) => {
  let code = 200, out;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
  await media({ method: 'POST', query: {}, headers: A, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, out };
};
const row = (id) => book.media_roster.find((r) => r[0] === id);

// 1. 沒有 beat 欄的 CSV + 統一路線 → 全部套用
let r = await call({ action: 'seed', csv: 'id,name,outlet\nN1,王大明,經濟日報\nN2,李小華,工商時報', default_beat: '經濟部線' });
assert.equal(r.code, 200);
assert.equal(r.out.defaulted, 2);
assert.equal(r.out.default_beat, '經濟部線');
assert.equal(row('N1')[3], '經濟部線');
assert.equal(row('N2')[3], '經濟部線');

// 2. CSV 自己寫了路線的優先，沒寫的才套統一路線
r = await call({ action: 'seed', csv: 'id,name,outlet,beat\nN3,陳甲,電子時報,新竹工研院線\nN4,林乙,數位時報,', default_beat: '台北工研院線' });
assert.equal(row('N3')[3], '新竹工研院線');
assert.equal(row('N4')[3], '台北工研院線');
assert.equal(r.out.defaulted, 1);

// 3. ★ 名單裡已經有路線的人不會被統一路線改掉（人工填的優先）；還空白的才補
r = await call({ action: 'seed', csv: 'id,name,outlet\nN1,王大明,經濟日報\nN5,新人,中央社', default_beat: '新竹工研院線' });
assert.equal(row('N1')[3], '經濟部線', '已有路線不被覆蓋');
assert.equal(row('N5')[3], '新竹工研院線');
assert.equal(r.out.defaulted, 1, '只算真的套用到的人');

// 4. 不指定 → 跟以前一樣，路線留空，回應不帶 default 欄位
r = await call({ action: 'seed', csv: 'id,name,outlet\nN6,無路線,自由時報' });
assert.equal(row('N6')[3], '');
assert.equal(r.out.default_beat, undefined);

// 5. 不在選單上的路線一律拒絕，而且整批都不寫
const before = JSON.stringify(book.media_roster);
r = await call({ action: 'seed', csv: 'id,name,outlet\nN7,亂來,某報', default_beat: '亂編的路線' });
assert.equal(r.code, 400);
assert.equal(JSON.stringify(book.media_roster), before, '被拒絕時不能動到名單');

console.log('批次 189 匯入統一路線：全部通過');
