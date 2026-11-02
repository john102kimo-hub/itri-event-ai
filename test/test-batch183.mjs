// 報名表上的場次代碼（G2、「G2場次 目錄」）要直接回場次資料，不能當成裸主題詞。
import assert from 'node:assert/strict';
import { parseSessions, matchSessionCodeAsk, buildSessionCodeText } from '../lib/registration.js';

const { sessions } = parseSessions([
  'G1｜2026-11-05｜09:10-11:40｜先進電子材料',
  'G2｜2026-11-05｜13:30-16:30｜智慧機械 × AI機器人｜國際會議中心',
  'H1｜2026-11-06｜09:00-11:50｜全球市場展望'
].join('\n'), 2026);
const c = { id: 'tw2027', title: '眺望2027 產業發展趨勢研討會', short_name: '眺望2027', sessions };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

for (const t of ['G2', 'g2', 'G2場次', 'G2場次 目錄', '眺望\nG2場次 目錄', 'G2 是什麼？', '請問G2的時間', '眺望2027 G2']) {
  ok(`認得「${t.replace('\n', '⏎')}」`, () => assert.equal(matchSessionCodeAsk(t, [c])[0]?.session.code, 'G2'));
}
for (const t of ['G2 的講者是誰', 'G2 可以帶攝影嗎', '我想訪問 G2 的講者', 'A1', 'iPhone15', '智慧機械', 'G9']) {
  ok(`不攔「${t}」`, () => assert.equal(matchSessionCodeAsk(t, [c]).length, 0));
}
ok('回覆有日期時間名稱地點、沒有亂補', () => {
  const r = buildSessionCodeText(matchSessionCodeAsk('G2', [c]));
  assert.match(r, /11\/5/); assert.match(r, /13:30-16:30/); assert.match(r, /智慧機械 × AI機器人/); assert.match(r, /國際會議中心/);
  assert.doesNotMatch(r, /講者：/);
});
console.log(`${n} 項通過`);
