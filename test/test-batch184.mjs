// 批次 184：路由只剩一個候選、只是沒把握時，不要反問「這幾場的哪一場」（只列一個選項）——直接用那一場答。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
delete process.env.LINE_ADMIN_USER_ID;

let handler = (await import('../api/line.js?v=0')).default;
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
async function dm(uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res);
  return sent.slice();
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}

const KB = '【新聞稿全文】儲電新技術發表會：工研院今日發表新一代儲電技術，預計 2027 年第二季量產。\n新聞聯絡人：王小明';
reset();
state.events.length = 0;
state.events.push(['semi', '半導體記者會', '#0F9E7A', KB, 'active', isoOffset(3), '', '', '', '工研院', 'code_semi', '10:00', '南港展覽館', '記者會', '王小明 0912-345-678', '', '', '']);

const out = await dm('Ureporter1', '低信心單一候選 半導體的場次');
const asked = (o) => JSON.stringify(o.filter(x => x.kind !== 'answer'));   // 系統提示裡也會出現「哪一場」，只看回給記者的
const all = JSON.stringify(out);
check('只有一個候選、沒把握：不再反問「這幾場的哪一場」', !all.includes('這幾場的哪一場'), all);
check('直接回答那一場', out.some(s => s.kind === 'answer'), all);

// ── 只打日期：那天有活動就直接答，不要記者再打全名 ──
// 批次 202：日期一律用台北時間算（跟 fakes.mjs isoOffset() 同一把尺）。原本用機器的當地時間，在 UTC 的機器上
// 台北凌晨 0～8 點這段會跟活動資料差一天，「活動日期欄位那天也認得」固定紅——提交前的檢查在那個時段整批被擋。
const tpe = (days) => { const [y, m, d] = isoOffset(days).split('-').map(Number); return { getFullYear: () => y, getMonth: () => m - 1, getDate: () => d }; };
const start = tpe(3);
const later = tpe(9);   // 活動第七天，只寫在知識庫議程裡
const M = later.getMonth() + 1, D = later.getDate();
const MULTI = `【議程】\n${M}/${D} 上午 生醫論壇\n${M}/${D} 下午 健康照護論壇\n講者：王小明`;
reset();
state.events.length = 0;
state.events.push(
  ['semi', '眺望研討會', '#0F9E7A', MULTI, 'active', isoOffset(3), '', '', '', '工研院', 'code_semi', '10:00', '南港', '研討會', '', '', '', ''],
  ['med', '另一場醫療記者會', '#0F9E7A', KB, 'active', isoOffset(20), '', '', '', '工研院', 'code_med', '10:00', '南港', '記者會', '', '', '', '']
);
handler = (await import('../api/line.js?v=1')).default;   // 換一份新的，不吃上一段留在記憶體的活動快取
const formats = [`${M}/${D}(二)的研討會`, `${M}月${D}日有什麼場次`, `${M}-${D}`, `${later.getFullYear()}/${String(M).padStart(2, '0')}/${String(D).padStart(2, '0')} 研討會`, `${M}.${D}的研討會`];
for (const f of formats) {
  const o = await dm('Ud' + f.length + Math.random(), f);
  check(`日期「${f}」→ 直接答眺望，不反問`, o.some(x => x.kind === 'answer') && !asked(o).includes('哪一場'), JSON.stringify(o).slice(0, 300));
}
const none = await dm('Ud-none', `${M}/${D === 28 ? 27 : D + 1} 的研討會`);
check('那天沒有活動：不亂跳一場', !none.some(x => x.kind === 'answer'), JSON.stringify(none).slice(0, 300));
const same = await dm('Ud-first', `${start.getMonth() + 1}/${start.getDate()}的研討會`);
check('活動日期欄位那天也認得', same.some(x => x.kind === 'answer'), JSON.stringify(same).slice(0, 300));
const m30 = await dm('Ud-30', `${M}/${D}0 的研討會`);
check('11/3 不會誤中 11/30', !m30.some(x => x.kind === 'answer'), JSON.stringify(m30).slice(0, 300));

// ── 相對日期（批次 185）──
const tw = (n) => { const d = new Date(Date.now() + n * 86400000); const [y, m, dd] = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).split('-'); return `${+m}/${+dd}`; };
reset();
state.events.length = 0;
state.events.push(
  ['semi', '眺望研討會', '#0F9E7A', KB, 'active', isoOffset(1), '', '', '', '工研院', 'code_semi', '10:00', '南港', '研討會', '', '', '', ''],
  ['med', '另一場醫療記者會', '#0F9E7A', KB, 'active', isoOffset(2), '', '', '', '工研院', 'code_med', '10:00', '南港', '記者會', '', '', '', '']
);
handler = (await import('../api/line.js?v=2')).default;
for (const [q, label] of [['明天的研討會', '明天'], ['明日的記者會', '明日']]) {
  const o = await dm('Ur' + label, q);
  check(`「${q}」→ 明天剛好一場，直接答`, o.some(x => x.kind === 'answer') && !asked(o).includes('哪一場'), JSON.stringify(o).slice(0, 300));
}
const aft = await dm('Ur-after', '後天的記者會');
check('「後天的記者會」→ 後天那一場，不是整份清單', aft.some(x => x.kind === 'answer') && !asked(aft).includes('近期活動'), JSON.stringify(aft).slice(0, 300));
const today = await dm('Ur-today', '今天的研討會');
check('今天沒有活動：不亂跳一場', !today.some(x => x.kind === 'answer'), JSON.stringify(today).slice(0, 300));
const chat = await dm('Ur-chat', '明天天氣好嗎');
check('「明天天氣好嗎」不是在問活動，不攔', !chat.some(x => x.kind === 'answer'), JSON.stringify(chat).slice(0, 300));
const { parseAskedDates } = await import('../lib/router.js');
check('今天／明天／後天／大後天／昨天／前天換算（台灣日期）', JSON.stringify(['今天的活動', '明天的活動', '後天的活動', '大後天的活動', '昨天的活動', '前天的活動'].map(t => { const r = parseAskedDates(t)[0]; return `${r.m}/${r.d}`; })) === JSON.stringify([0, 1, 2, 3, -1, -2].map(tw)));

console.log(`\n${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
