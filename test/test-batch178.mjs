// 批次 178：活動前後的其他提醒時間點——前一週（沒有邀請函）、當天早上（新聞稿還沒貼）、隔天（還沒有照片）。
//   一、純函式：每一種何時要提醒、何時不要；多天活動不催照片；訊息文字
//   二、排程：時段（早上／傍晚）、收件人（只有前一天會推給管理員）、去重、優先順序與額度、REMIND_OFF、dry
// 前一天那則（批次 177）的行為在 test-batch177.mjs。
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_COLLEAGUE_PASSCODE = 'Jerry';
process.env.LINE_BASIC_ID = '@123abcde';
process.env.LINE_ADMIN_USER_ID = 'U_admin';
process.env.CRON_SECRET = 'cronsecret';
delete process.env.REMIND_MONTHLY_MAX;
delete process.env.REMIND_OFF;

const G = await import('../lib/event-guide.js');
const { KB_TEMPLATE } = await import('../lib/kb-template.js');
const { runRemindCron, slotOf, SLOT_KINDS } = await import('../lib/event-remind.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 900) : ''}`); }
}
const pushes = () => sent.filter((o) => o.push);
const colleagueRow = (uid, name = '小華') => [uid, name, '2026-10-13', '', '', 'colleague'];
const KB = '【新聞稿全文】\n工研院今日發表新技術，預計 2027 年第二季量產。';
const evRow = (id, name, date, o = {}) => { const r = Array(18).fill(''); Object.assign(r, { 0: id, 1: name, 2: '#0F9E7A', 4: 'active', 5: date, 9: '工研院', 10: 'code_' + id }, o); return r; };

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('── 一、什麼時候提醒 ──');
{
  const today = isoOffset(0);
  const R = (kind, o) => G.reminderFor(kind, evRow('x', '測試活動', isoOffset(0), o), today);

  // 前一週
  check('★ 前一週：剛好 7 天後、沒有邀請函 → 提醒', G.reminderFor('week', evRow('x', 'a', isoOffset(7)), today)?.kind === 'week');
  check('　 　有邀請函 → 不提醒（沒缺不吵）', G.reminderFor('week', evRow('x', 'a', isoOffset(7), { 16: '邀請函' }), today) === null);
  check('　 　6 天後、8 天後 → 不提醒（只在剛好前一週那天）', [6, 8].every((n) => G.reminderFor('week', evRow('x', 'a', isoOffset(n)), today) === null));
  check('　 　草稿也提醒（邀請函本來就該在發布前備好）、企業場／封存不提醒', G.reminderFor('week', evRow('x', 'a', isoOffset(7), { 4: 'draft' }), today)?.draft === true && G.reminderFor('week', evRow('x', 'a', isoOffset(7), { 13: '客戶參訪' }), today) === null && G.reminderFor('week', evRow('x', 'a', isoOffset(7), { 4: 'archived' }), today) === null);

  // 當天
  check('★ 當天早上：今天辦、新聞稿沒貼 → 提醒，並帶著「有沒有邀請函」', G.reminderFor('day', evRow('x', 'a', isoOffset(0)), today)?.hasInvite === false && G.reminderFor('day', evRow('x', 'a', isoOffset(0), { 16: '邀請函' }), today)?.hasInvite === true);
  check('　 　新聞稿貼了 → 不提醒', G.reminderFor('day', evRow('x', 'a', isoOffset(0), { 3: KB }), today) === null);
  check('★ 　 　知識庫還是沒動過的範本 → 算沒貼（跟發布檢查同一條規則）', G.reminderFor('day', evRow('x', 'a', isoOffset(0), { 3: KB_TEMPLATE }), today)?.kind === 'day');
  check('　 　不是今天（昨天、明天）、已結束 → 不提醒', [-1, 1].every((n) => G.reminderFor('day', evRow('x', 'a', isoOffset(n)), today) === null) && G.reminderFor('day', evRow('x', 'a', isoOffset(0), { 4: 'ended' }), today) === null);

  // 隔天
  check('★ 隔天：昨天辦、沒有照片 → 提醒', G.reminderFor('after', evRow('x', 'a', isoOffset(-1), { 3: KB }), today)?.kind === 'after');
  check('　 　已經有照片 → 不提醒', G.reminderFor('after', evRow('x', 'a', isoOffset(-1), { 3: KB, 7: 'https://x/a.jpg' }), today) === null);
  check('　 　草稿（從來沒對記者開放）→ 不催照片；手動標成「已結束」的場次照樣催', G.reminderFor('after', evRow('x', 'a', isoOffset(-1), { 4: 'draft' }), today) === null && G.reminderFor('after', evRow('x', 'a', isoOffset(-1), { 4: 'ended' }), today)?.kind === 'after');
  check('　 　前天、今天 → 不提醒', [-2, 0].every((n) => G.reminderFor('after', evRow('x', 'a', isoOffset(n)), today) === null));
  const multi = `【活動議程】\n- ${Number(isoOffset(-1).slice(5, 7))}/${Number(isoOffset(-1).slice(8))} 開幕\n- ${Number(isoOffset(1).slice(5, 7))}/${Number(isoOffset(1).slice(8))} 第二天場次`;
  check('★ 多天的活動（議程寫了活動日之後的日期）→ 隔天不催照片（活動可能還在辦）', G.reminderFor('after', evRow('x', 'a', isoOffset(-1), { 3: multi }), today) === null);
  check('　 　looksMultiDay：只看活動日之後 1～14 天內；時間、倍數、比活動日早的日期不算', G.looksMultiDay('10/29 第二天', '2026-10-28') && !G.looksMultiDay('預計 3.5 倍成長，10:00 開始，10/20 完成報名', '2026-10-28') && !G.looksMultiDay('12/30 以後再說', '2026-10-28') && G.looksMultiDay('2026/11/2 閉幕', '2026-10-28'));

  check('　 　reminderFor 不認得的種類 → null', G.reminderFor('nope', evRow('x', 'a', isoOffset(0)), today) === null);
}

console.log('\n── 提醒文字 ──');
{
  const today = isoOffset(0);
  const w = G.reminderFor('week', evRow('w', '氫能展', isoOffset(7), { 11: '10:00', 12: '南港' }), today);
  const wt = G.formatReminderOf('week', [{ item: w, link: 'https://x/edit?id=w&code=c' }]);
  check('前一週：講一週後、沒有邀請函、為什麼先備（活動日之前記者只看到邀請函）、可以直接在 LINE 貼、附編輯連結', /一週後辦/.test(wt) && /還沒有「媒體邀請函」/.test(wt) && /只會看到邀請函/.test(wt) && /直接在這裡貼/.test(wt) && wt.includes('https://x/edit?id=w&code=c'), wt);
  const d1 = G.reminderFor('day', evRow('d', '氫能展', isoOffset(0), { 16: '邀請函' }), today);
  const d2 = G.reminderFor('day', evRow('d', '氫能展', isoOffset(0)), today);
  check('★ 當天：有邀請函 → 說「只能用邀請函回答」；沒有 → 說「什麼都答不出來」', /只能用邀請函的內容回答/.test(G.formatReminderOf('day', [{ item: d1, link: '' }])) && /什麼都答不出來/.test(G.formatReminderOf('day', [{ item: d2, link: '' }])), G.formatReminderOf('day', [{ item: d2, link: '' }]));
  check('　 　當天：講清楚貼完存檔後米亞很快改用新聞稿', /很快就會改用新聞稿/.test(G.formatReminderOf('day', [{ item: d1, link: '' }])));
  const a = G.reminderFor('after', evRow('a', '氫能展', isoOffset(-1)), today);
  const at = G.formatReminderOf('after', [{ item: a, link: 'https://x/edit?id=a&code=c' }]);
  check('隔天：講昨天辦完、沒有照片、直接傳給我、記者就能下載', /昨天辦完了/.test(at) && /還沒有活動照片/.test(at) && /直接傳給我/.test(at) && /記者就能下載/.test(at), at);
  check('　 前一天那則（批次 177）文字沒變：仍然叫 formatReminder、仍然講 00:00', /活動前一天提醒/.test(G.formatReminderOf('eve', [{ item: G.reminderItem(evRow('e', 'x', isoOffset(1)), today), link: '' }])) && /00:00/.test(G.formatReminderOf('eve', [{ item: G.reminderItem(evRow('e', 'x', isoOffset(1)), today), link: '' }])));
}

// ═══ 二、排程 ═══════════════════════════════════════════════════════════════════
console.log('\n── 時段 ──');
{
  check('★ 台灣 08:30（UTC 00:30）→ 早上；台灣 17:00、17:30 → 傍晚', slotOf(new Date('2026-10-30T00:30:00Z')) === 'morning' && slotOf(new Date('2026-10-30T09:00:00Z')) === 'evening' && slotOf(new Date('2026-10-30T09:30:00Z')) === 'evening');
  check('　 14 點是分界（Hobby 排程會晚到一小時內，早上那班與傍晚那班離分界都夠遠）', slotOf(new Date('2026-10-30T05:59:00Z')) === 'morning' && slotOf(new Date('2026-10-30T06:00:00Z')) === 'evening');
  check('　 早上做 當天、前一週、隔天（依優先順序）；傍晚只做前一天', JSON.stringify(SLOT_KINDS.morning) === JSON.stringify(['day', 'week', 'after']) && JSON.stringify(SLOT_KINDS.evening) === JSON.stringify(['eve']));
}

console.log('\n── 排程：早上那班 ──');
function setupMorning({ owned = true } = {}) {
  reset();
  state.staff.push(colleagueRow('U_c', '小華'));
  state.events.length = 0;
  state.events.push(
    evRow('w1', '一週後的展', isoOffset(7)),                                  // 沒邀請函
    evRow('d1', '今天的展', isoOffset(0), { 16: '邀請函內容' }),               // 新聞稿沒貼
    evRow('a1', '昨天的展', isoOffset(-1), { 3: KB })                         // 沒照片
  );
  if (owned) for (const id of ['w1', 'd1', 'a1']) state.eventOwners.push([id, 'U_c', '小華', 't', 'create']);
}
{
  setupMorning(); sent.length = 0;
  let r = await runRemindCron({ slot: 'morning' });
  check('★ 早上：三種各一則，都推給負責人（不是管理員）', r.sent === 3 && JSON.stringify(r.byKind) === JSON.stringify({ day: 1, week: 1, after: 1 }) && pushes().length === 3 && pushes().every((p) => p.to === 'U_c'), JSON.stringify([r, pushes().map((p) => p.to)]));
  check('　 優先順序：當天 → 前一週 → 隔天（額度不夠時前面的先送）', /今天辦/.test(pushes()[0].text) && /一週後辦/.test(pushes()[1].text) && /昨天辦完了/.test(pushes()[2].text), pushes().map((p) => p.text.slice(0, 12)).join('|'));
  check('★ 前一週那則帶著「貼邀請函」按鈕（同仁模式認得「邀請函：活動名稱」）；其餘兩則沒有', pushes()[1].quickReply.some((c) => c.text === '邀請函：一週後的展') && pushes()[0].quickReply.length === 0 && pushes()[2].quickReply.length === 0, JSON.stringify(pushes().map((p) => p.quickReply)));
  check('　 發送紀錄多了三列，種類分別是 day／week／after', JSON.stringify(state.eventReminders.map((x) => x[3]).sort()) === JSON.stringify(['after', 'day', 'week']), JSON.stringify(state.eventReminders));

  sent.length = 0;
  r = await runRemindCron({ slot: 'morning' });
  check('★ 再跑一次不會重複推（每一種各自去重）', r.sent === 0 && pushes().length === 0 && state.eventReminders.length === 3, JSON.stringify(r));

  sent.length = 0;
  r = await runRemindCron({ slot: 'evening' });
  check('★ 傍晚那班只做「前一天」：這三場都不是明天，什麼都不推', r.sent === 0 && r.kinds.join() === 'eve' && pushes().length === 0, JSON.stringify(r));
}
{
  setupMorning({ owned: false }); sent.length = 0;
  const r = await runRemindCron({ slot: 'morning' });
  check('★ 沒有負責人的場次：早上這三種都不推（也不轉給管理員——既有活動大多沒有負責人，會讓朱朱被多推三則）', r.sent === 0 && pushes().length === 0 && r.skipped.some((t) => /只送給負責人/.test(t)), JSON.stringify(r));
  check('　 摘要說明是因為沒有負責人', r.skipped.filter((t) => /沒有可以推的負責人/.test(t)).length === 3, JSON.stringify(r.skipped));
}
{
  setupMorning(); state.staff.length = 0; state.staff.push(['U_c', '小華', 't', 'revoked', '', 'colleague']); sent.length = 0;
  const r = await runRemindCron({ slot: 'morning' });
  check('★ 負責人已退出 → 不推給他，也不轉給管理員', r.sent === 0 && pushes().length === 0, JSON.stringify(r));
}
{
  setupMorning(); sent.length = 0;
  process.env.REMIND_OFF = 'week, after';
  const r = await runRemindCron({ slot: 'morning' });
  delete process.env.REMIND_OFF;
  check('★ REMIND_OFF=week, after → 只剩當天；摘要的 kinds 也只列 day', r.kinds.join() === 'day' && r.sent === 1 && /今天辦/.test(pushes()[0].text), JSON.stringify(r));
  setupMorning(); sent.length = 0;
  process.env.REMIND_OFF = 'day,week,after';
  const r2 = await runRemindCron({ slot: 'morning' });
  delete process.env.REMIND_OFF;
  check('　 全部關掉 → 什麼都不做，也不讀試算表', r2.sent === 0 && r2.kinds.length === 0 && pushes().length === 0, JSON.stringify(r2));
  setupMorning(); sent.length = 0;
  process.env.REMIND_OFF = 'eve';
  const r3 = await runRemindCron({ slot: 'evening' });
  delete process.env.REMIND_OFF;
  check('　 REMIND_OFF 也關得掉前一天', r3.kinds.length === 0 && r3.sent === 0);
}
{
  // 額度：前一週與隔天只用到上限的 70%
  setupMorning(); sent.length = 0;
  process.env.REMIND_MONTHLY_MAX = '10';
  const ym = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
  for (let i = 0; i < 7; i++) state.eventReminders.push([`${ym}-01 17:00:00`, 'old' + i, '2026-01-01', 'eve', 'U_x', 'sent']);
  const r = await runRemindCron({ slot: 'morning' });
  delete process.env.REMIND_MONTHLY_MAX;
  check('★ 上限 10、本月已用 7：當天（可用到 100%）照推；前一週、隔天（只用到 70% ＝ 7）讓位', r.byKind.day === 1 && !r.byKind.week && !r.byKind.after && pushes().length === 1 && /今天辦/.test(pushes()[0].text) && r.skipped.filter((t) => /已到上限 7/.test(t)).length === 2, JSON.stringify(r));
}
{
  setupMorning(); sent.length = 0;
  const r = await runRemindCron({ slot: 'morning', dry: true });
  check('★ dry：算得出會推幾則、不推、不寫紀錄', r.dry && r.sent === 3 && pushes().length === 0 && state.eventReminders.length === 0, JSON.stringify(r));
}
{
  // 多天活動與隔天
  reset(); state.staff.push(colleagueRow('U_c'));
  state.events.length = 0;
  const m = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}`;
  state.events.push(evRow('multi', '多天的展', isoOffset(-1), { 3: `【議程】\n- ${m(isoOffset(-1))} 開幕\n- ${m(isoOffset(1))} 第三天` }), evRow('single', '單天的展', isoOffset(-1), { 3: KB }));
  state.eventOwners.push(['multi', 'U_c', '小華', 't', 'c'], ['single', 'U_c', '小華', 't', 'c']);
  sent.length = 0;
  const r = await runRemindCron({ slot: 'morning' });
  check('★ 隔天：議程還有後續日期的多天活動不催；單天的催', r.byKind.after === 1 && /單天的展/.test(pushes()[0].text) && !/多天的展/.test(pushes()[0].text), JSON.stringify([r, pushes().map((p) => p.text)]));
}
{
  // 同一人同一種有兩場 → 合成一則
  reset(); state.staff.push(colleagueRow('U_c'));
  state.events.length = 0;
  state.events.push(evRow('a1', '甲展', isoOffset(-1)), evRow('a2', '乙展', isoOffset(-1)));
  state.eventOwners.push(['a1', 'U_c', '小華', 't', 'c'], ['a2', 'U_c', '小華', 't', 'c']);
  sent.length = 0;
  const r = await runRemindCron({ slot: 'morning' });
  check('★ 同一人同一種有兩場 → 合成一則（省推播則數）', r.sent === 2 && pushes().length === 1 && /甲展/.test(pushes()[0].text) && /乙展/.test(pushes()[0].text), JSON.stringify(pushes().map((p) => p.text.slice(0, 60))));
}
{
  // 前一天（批次 177）仍然在沒有負責人時推給管理員——這條不能因為這批而變
  reset(); state.staff.push(colleagueRow('U_c'));
  state.events.length = 0; state.events.push(evRow('e1', '明天的展', isoOffset(1)));
  sent.length = 0;
  const r = await runRemindCron({ slot: 'evening' });
  check('★ 前一天：沒有負責人 → 照舊推給管理員，不放「貼邀請函」按鈕（管理員不一定是同仁）', r.toAdmin === 1 && pushes()[0].to === 'U_admin' && pushes()[0].quickReply.length === 0, JSON.stringify(r));
}

console.log('\n── 排程入口與說明 ──');
{
  const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rem = vj.crons.filter((x) => x.path === '/api/line?action=cron_remind').map((x) => x.schedule);
  check('★ vercel.json：早上一班（UTC 00:30＝台灣 08:30）＋傍晚兩班，共三條，都是一天一次的寫法', rem.length === 3 && ['30 0 * * *', '0 9 * * *', '30 9 * * *'].every((t) => rem.includes(t)) && rem.every((t) => /^\d+ \d+ \* \* \*$/.test(t)), JSON.stringify(rem));
  const src = readFileSync(new URL('../api/line.js', import.meta.url), 'utf8');
  check('　 api/line.js 把 &slot= 交給 runRemindCron（可以手動指定時段試跑）', /runRemindCron\(\{ dry: req\.query\?\.dry === '1', slot: req\.query\?\.slot \}\)/.test(src));
  const colleague = readFileSync(new URL('../lib/line-colleague-mode.js', import.meta.url), 'utf8');
  check('　 同仁模式的說明與收尾講清楚四個提醒時間點（前一週、前一天、當天早上、隔天），並說沒缺就不吵', /前一週/.test(colleague) && /當天早上/.test(colleague) && /隔天/.test(colleague) && /沒缺就不吵你/.test(colleague));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 178 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
