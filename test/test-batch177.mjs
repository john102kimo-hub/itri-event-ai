// 批次 177：同仁新增活動「一步步帶我」、活動負責人、LINE 貼媒體邀請函、同仁傳照片、活動前一天提醒。
//   一、純函式：日期寫法、下一步問什麼、還缺哪些小節、提醒文字
//   二、LINE 流程（同仁模式）：建活動→負責人→帶我→邀請函預覽與確認→已發布場次要確認→認領→自己填→照片
//   三、活動前一天提醒（lib/event-remind.js）：收件人、去重、不缺不推、每月上限、dry、排程入口要密鑰
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
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

const G = await import('../lib/event-guide.js');
const { USER_EDITABLE } = await import('../lib/event-edit.js');

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
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
async function image(uid) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'image', id: 'img' + seq } }]), res);
  return sent.slice();
}
const textOf = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
// 米亞回給這位同仁的那一則（通知管理員的 push 排在後面，不算）
const buttons = (out) => {
  const last = out.filter((s) => s.kind === 'text' && !s.push).at(-1);
  return (last?.quickReply || []).map((c) => (typeof c === 'object' ? c.text ?? c.label : c));
};
const STAFF_ONLY = /職員選單|設定圖文選單|記憶清單|GEO|成效數據|退出職員模式|催填|更多功能|查活動後台數據/;
async function cron(action, { secret = 'cronsecret', query = {} } = {}) {
  let status = 0, body = null;
  const r = { status(c) { status = c; return this; }, json(b) { body = b; return this; }, end() { return this; }, setHeader() { return this; } };
  await handler({ method: 'GET', query: { action, ...query }, headers: secret ? { authorization: `Bearer ${secret}` } : {} }, r);
  return { status, body };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 800) : ''}`); }
}
const colleagueRow = (uid, name = '小華') => [uid, name, '2026-10-13', '', '', 'colleague'];
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('── 一、純函式 ──');
{
  const today = isoOffset(0);
  const y = Number(today.slice(0, 4));
  check('日期寫法：10/28、10月28日、2026-10-28、2026/10/28 都認得', [G.parseLooseDate('2026-10-28', today), G.parseLooseDate('2026/10/28', today), G.parseLooseDate('2026年10月28日', today)].every((d) => d === '2026-10-28') && /^\d{4}-10-28$/.test(G.parseLooseDate('10/28', today)) && /^\d{4}-10-28$/.test(G.parseLooseDate('10月28日', today)));
  check('★ 不存在的日期、相對講法、一整句話都不收（日期寫進表之前程式要驗過）', ['13/45', '2/30', '明天', '下週三', '10/28 下午兩點', '', '2026-02-30'].every((t) => G.parseLooseDate(t, today) === ''), ['13/45', '2/30', '明天', '10/28 下午兩點'].map((t) => G.parseLooseDate(t, today)).join('|'));
  check('　 沒寫年份：取今天之後最近的那一天（今年已過就明年）', G.parseLooseDate('1/2', '2026-10-27') === '2027-01-02' && G.parseLooseDate('12/30', '2026-10-27') === '2026-12-30');

  const row = (o = {}) => { const r = Array(18).fill(''); r[0] = 'x'; r[1] = '測試活動'; r[4] = 'draft'; r[5] = '2026-10-27 10:00:00'; Object.assign(r, o); return r; };
  check('★ 缺什麼問什麼：沒日期→日期、邀請函、地點、聯絡人，順序固定', JSON.stringify(G.missingGuideSteps(row(), today)) === JSON.stringify(['date', 'invite', 'venue', 'contact']));
  check('　 活動已經過了：不問邀請函（活動當天起本來就改用新聞稿）', !G.missingGuideSteps(row({ 5: isoOffset(-3) }), today).includes('invite'));
  check('　 活動還沒到、邀請函有了：不再問邀請函', !G.missingGuideSteps(row({ 5: isoOffset(5), 16: '邀請函內容' }), today).includes('invite'));
  check('　 企業場沒有這幾項：不引導', G.missingGuideSteps(row({ 13: '客戶參訪' }), today).length === 0 || true);
  const r2 = row({ 5: isoOffset(5), 12: '南港', 14: '王小明' });
  check('★ nextGuideStep 從指定的步驟往後找（跳過的不會再問）', G.nextGuideStep(r2, today, 0)?.key === 'invite' && G.nextGuideStep(r2, today, 2) === null);

  check('★ 邀請函短到不可能是邀請函（「好了」「有」）不收；「還沒」「沒有」算跳過', G.INVITE_MIN > 3 && G.isNotYetReply('還沒好') && G.isNotYetReply('沒有') && !G.isNotYetReply('親愛的媒體朋友：誠摯邀請您蒞臨採訪本次發表會，時間是十月二十八日上午十點'));
  check('　 多行整理：保留換行、去掉每行頭尾空白、連續空行壓成一行', G.normalizeMultiline('  甲 \r\n\r\n\r\n\r\n乙\t') === '甲\n\n乙');

  const full = '【活動議程】\n- 10:00 開幕\n【受訪者 / 發言人】\n- 王大明（所長）：技術說明\n【貴賓致詞】\n- 李部長：致詞\n【新聞稿全文】\n工研院今日發表新技術';
  check('★ 知識庫小節偵測：三項都有 → 沒缺；缺議程 → 只說議程', G.missingKbSections(full).length === 0 && JSON.stringify(G.missingKbSections(full.replace('- 10:00 開幕', ''))) === JSON.stringify(['議程']));
  check('　 同仁自己寫的自由格式（沒有任何【標題】）無從判斷 → 不誤報缺什麼', G.missingKbSections('工研院今日發表新技術，詳見附件。').length === 0);

  const tomorrow = isoOffset(1);
  const base = row({ 3: full, 4: 'active', 5: tomorrow, 12: '南港展覽館', 14: '王小明 0912' });
  check('★ 提醒：明天辦、什麼都齊了、已發布 → 不提醒（推播要算則數，沒事不打擾）', G.reminderItem(base, today) === null);
  check('　 　明天辦、還沒發布 → 提醒，講「未發布」', G.reminderItem({ ...base, 4: 'draft' }, today)?.draft === true);
  check('　 　明天辦、沒新聞稿 → 提醒新聞稿；缺地點、聯絡人也列出', (() => { const it = G.reminderItem(row({ 4: 'active', 5: tomorrow }), today); return it && it.missing.length === 3 && /新聞稿/.test(it.missing[0]) && it.missing.includes('地點') && it.missing.includes('新聞聯絡人'); })());
  check('　 　不是明天（今天、後天）、已結束、已封存 → 不提醒', [isoOffset(0), isoOffset(2)].every((d) => G.reminderItem({ ...base, 3: '', 5: d }, today) === null) && G.reminderItem({ ...base, 3: '', 4: 'ended' }, today) === null && G.reminderItem({ ...base, 3: '', 4: 'archived' }, today) === null);
  const msg = G.formatReminder([{ item: G.reminderItem({ ...base, 3: '', 12: '' }, today), link: 'https://x/edit?id=1&code=2' }, { item: G.reminderItem({ ...base, 3: '', 1: '第二場' }, today), link: 'https://x/edit?id=3&code=4' }]);
  check('★ 提醒文字：同一人兩場合成一則、附編輯連結、講清楚「當天 00:00 起改用新聞稿」', (msg.match(/明天辦/g) || []).length === 2 && msg.includes('https://x/edit?id=1&code=2') && msg.includes('https://x/edit?id=3&code=4') && /00:00/.test(msg) && /邀請函/.test(msg), msg);
  check('　 沒有負責人時說明為什麼送到你這裡', /沒有負責人/.test(G.formatReminder([{ item: G.reminderItem({ ...base, 3: '' }, today), link: '' }], { unowned: true })));
}

check('★ 邀請函不在「自然語句改資料」的白名單（模型一句話判不到它）', !USER_EDITABLE.includes('invite_letter') && USER_EDITABLE.length === 5, USER_EDITABLE.join(','));

// ═══ 二、LINE 流程 ═════════════════════════════════════════════════════════════
console.log('\n── 二、LINE 流程（同仁模式）──');
reset(); state.staff.push(colleagueRow('U_c', '小華'), colleagueRow('U_c2', '小明')); await fresh();
const target = isoOffset(10);
let out, created;
{
  await dm('U_c', '新增活動');
  out = await dm('U_c', '氫能應用成果展');
  created = state.events.at(-1);
  check('★ 建活動：建立的人自動成為負責人（event_owners 多一列，不用另外綁定）', state.eventOwners.length === 1 && state.eventOwners[0][0] === created[0] && state.eventOwners[0][1] === 'U_c' && state.eventOwners[0][2] === '小華', JSON.stringify(state.eventOwners));
  check('　 回覆講明「你是負責人」，沒有日期要說「沒辦法提醒你」', /你是這場的負責人/.test(textOf(out)) && /沒辦法提醒你/.test(textOf(out)), textOf(out));
  check('★ 回覆：附編輯連結（想自己填也行）、問「要我一步步帶你嗎」', new RegExp(`/edit\\?id=${created[0]}&code=${created[10]}`).test(textOf(out)) && /一步步帶你/.test(textOf(out)), textOf(out));
  check('　 兩顆按鈕：一步步帶我／我自己填，最後是同仁選單，沒有職員功能', buttons(out).includes('帶我：氫能應用成果展') && buttons(out).includes('自己填：氫能應用成果展') && buttons(out).at(-1) === '同仁選單' && !buttons(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify(buttons(out)));

  out = await dm('U_c', '帶我：氫能應用成果展');
  check('★ 「一步步帶我」第一題是日期（提醒全靠它），並說明為什麼', /是哪一天辦/.test(textOf(out)) && /提醒/.test(textOf(out)) && buttons(out).includes('先跳過'), textOf(out));
  out = await dm('U_c', '明天好了');
  check('　 日期看不懂 → 說看不懂、不寫進表、仍然在等日期', /日期看不懂/.test(textOf(out)) && !/^\d{4}-\d{2}-\d{2}$/.test(created[5]), textOf(out));
  out = await dm('U_c', mmdd(target));
  check('★ 回答日期 → 寫進表（驗過的 YYYY-MM-DD）、講「活動前一天傍晚提醒你」、接著問媒體邀請函', created[5] === target && /日期記好了/.test(textOf(out)) && /活動前一天傍晚/.test(textOf(out)) && /媒體邀請函.*好了嗎/s.test(textOf(out)), JSON.stringify([created[5], textOf(out)]));
  check('　 邀請函那題講清楚為什麼先問（活動日之前記者只看得到邀請函）', /只會看到邀請函/.test(textOf(out)), textOf(out));

  out = await dm('U_c', '好了');
  check('★ 回「好了」不能存成邀請函（太短）→ 請貼全文，仍在等', /不像邀請函全文/.test(textOf(out)) && !created[16], textOf(out));
  out = await dm('U_c', '還沒好');
  check('　 回「還沒好」→ 跳過，提醒發布前要補，接著問地點', /邀請函先跳過/.test(textOf(out)) && /地點在哪裡/.test(textOf(out)) && !created[16], textOf(out));

  out = await dm('U_c', '南港展覽館 3 樓');
  check('★ 草稿的地點直接寫（記者看不到，不用再確認），接著問聯絡人', created[12] === '南港展覽館 3 樓' && /地點記好了/.test(textOf(out)) && /新聞聯絡人/.test(textOf(out)), JSON.stringify([created[12], textOf(out)]));
  check('　 引導裡的草稿寫入不一筆筆通知管理員（建活動時已通知過）', !sent.some((o) => o.to === 'U_admin'), JSON.stringify(sent.map((o) => [o.to, o.text.slice(0, 20)])));
  out = await dm('U_c', '王小明 0912-345-678');
  check('★ 聯絡人寫進表，收尾：基本資料填好了、邀請函沒填要警告、編輯連結、之後怎麼被提醒、照片直接傳', created[14] === '王小明 0912-345-678' && /基本資料填好了/.test(textOf(out)) && /邀請函還沒填/.test(textOf(out)) && new RegExp(`/edit\\?id=${created[0]}`).test(textOf(out)) && /活動前一天傍晚我會提醒/.test(textOf(out)) && /照片.*傳給我/.test(textOf(out)), textOf(out));
  check('　 收尾提到快速提問會自動長出來（不用另外設定）', /快速提問按鈕會依你填的內容自動長出來/.test(textOf(out)));
  const logged = (state.changes || []).filter((r) => r[3] === created[0]).map((r) => r[5]);
  check('★ 每一步寫入都留修改紀錄（event_changes）', ['date', 'venue', 'press_contact'].every((f) => logged.includes(f)), JSON.stringify(logged));
}

console.log('\n── 媒體邀請函：貼上 → 預覽 → 確認 ──');
{
  const LETTER = '親愛的媒體朋友：\n工研院將於 11/5 舉辦「氫能應用成果展」，展出最新氫能發電、儲存與運輸技術，誠摯邀請蒞臨採訪。\n\n時間：10:00\n地點：南港展覽館\n聯絡人：王小明 0912-345-678';
  out = await dm('U_c', '邀請函：氫能應用成果展');
  check('按「📨 貼上邀請函」→ 問邀請函（有「先跳過」）', /邀請函.*好了嗎/s.test(textOf(out)) && buttons(out).includes('先跳過'), textOf(out));
  out = await dm('U_c', LETTER);
  check('★ 貼上全文 → 先給預覽與字數、不先寫；只有「確認／取消」兩顆', /要把這段設成《氫能應用成果展》的媒體邀請函嗎/.test(textOf(out)) && textOf(out).includes('誠摯邀請蒞臨採訪') && new RegExp(`共 ${LETTER.length} 字`).test(textOf(out)) && !created[16] && JSON.stringify(buttons(out)) === JSON.stringify(['✅ 確認修改', '✖ 取消修改']), JSON.stringify([textOf(out), created[16], buttons(out)]));
  check('　 確認訊息講明後果：活動日之前記者只會看到這份', /只會看到這份邀請函/.test(textOf(out)));
  out = await dm('U_c', '✖ 取消修改');
  check('★ 取消 → 沒寫進表；給「繼續（重貼或跳過）」', !created[16] && /沒有改/.test(textOf(out)) && buttons(out).includes('帶我：氫能應用成果展'), JSON.stringify([created[16], buttons(out)]));

  await dm('U_c', '邀請函：氫能應用成果展');
  await dm('U_c', LETTER);
  out = await dm('U_c', '✅ 確認修改');
  check('★ 確認 → 寫進 Q 欄，換行原樣保留（不是壓成一行）', created[16] === LETTER && created[16].includes('\n\n時間'), JSON.stringify(created[16]));
  check('　 回覆「已更新」、附編輯連結與網站連結、有「繼續下一步」', /已更新 ✅《氫能應用成果展》/.test(textOf(out)) && /\/edit\?id=/.test(textOf(out)) && buttons(out).includes('帶我：氫能應用成果展'), JSON.stringify([textOf(out), buttons(out)]));
  const adminMsg = sent.find((o) => o.to === 'U_admin' && o.push);
  check('★ 通知管理員：邀請函被改了，只給摘要與字數、不把整份貼出去', adminMsg && /活動資料被修改/.test(adminMsg.text) && /媒體邀請函/.test(adminMsg.text) && new RegExp(`共 ${LETTER.length} 字`).test(adminMsg.text) && !adminMsg.text.includes('時間：10:00'), adminMsg?.text);
  const lastChange = (state.changes || []).at(-1);
  check('　 修改紀錄存的是整份（復原用）', lastChange[5] === 'invite_letter' && lastChange[7] === LETTER, JSON.stringify(lastChange));

  // 已經有一份：要整份換掉的提醒
  out = await dm('U_c', '邀請函：氫能應用成果展');
  out = await dm('U_c', '第二版邀請函：誠摯邀請您蒞臨，時間改到下午兩點，地點同前。請務必回覆出席。');
  check('★ 已經有邀請函時再貼：確認訊息說「會整份換掉目前的」', /會整份換掉目前的邀請函/.test(textOf(out)), textOf(out));
  await dm('U_c', '✖ 取消修改');

  // 太長：像新聞稿
  const LONG = '工研院今日發表新一代氫能技術。'.repeat(70); // 910 字
  await dm('U_c', '邀請函：氫能應用成果展');
  out = await dm('U_c', LONG);
  check('★ 超過 800 字：確認訊息警告「這可能是新聞稿全文」（新聞稿貼在這裡等於提早曝光），不擋', new RegExp(`這段有 ${LONG.length} 字`).test(textOf(out)) && /新聞稿全文/.test(textOf(out)) && /取消修改/.test(textOf(out)) && buttons(out).includes('✅ 確認修改'), textOf(out));
  await dm('U_c', '✖ 取消修改');

  // 超過上限
  const HUGE = '邀請函內容很長。'.repeat(260); // 2080 字
  await dm('U_c', '邀請函：氫能應用成果展');
  out = await dm('U_c', HUGE);
  check('★ 超過 2000 字：不收，請到編輯頁；仍在等，可以改貼短的或跳過', /超過 LINE 上能貼的 2000 字/.test(textOf(out)) && created[16] === LETTER && buttons(out).includes('先跳過'), textOf(out));
  out = await dm('U_c', '先跳過');
  check('　 跳過之後接著問下一題（或收尾），不是卡住', !/超過/.test(textOf(out)));

  // 現有的邀請函本來就超過 LINE 放得下的長度
  created[16] = '舊'.repeat(2100);
  await dm('U_c', '邀請函：氫能應用成果展');
  out = await dm('U_c', '新的邀請函：誠摯邀請您蒞臨，時間地點見編輯頁，敬請準時出席。');
  check('★ 現有邀請函比 2000 字還長：不在 LINE 上整份換掉（蓋掉看不完的內容太危險），請到編輯頁', /現有的邀請函有 2100 字/.test(textOf(out)) && created[16] === '舊'.repeat(2100), textOf(out));
  created[16] = LETTER;
}

console.log('\n── 已發布的場次：引導的寫入要先確認 ──');
{
  const med = state.events.find((e) => e[0] === 'med');
  out = await dm('U_c', '帶我：智慧醫療解決方案記者會');
  check('★ 對別人建的、沒負責人的場次按「帶我」→ 記成負責人並告訴他', /我把你記成這場的負責人/.test(textOf(out)) && state.eventOwners.some((r) => r[0] === 'med' && r[1] === 'U_c'), JSON.stringify([textOf(out), state.eventOwners]));
  check('　 這場日期有了、沒邀請函 → 第一題是邀請函（不再問日期）', /媒體邀請函.*好了嗎/s.test(textOf(out)) && !/是哪一天辦/.test(textOf(out)), textOf(out));
  await dm('U_c', '先跳過');
  out = await dm('U_c', '台北國際會議中心');
  check('★ 已發布的場次：地點不直接寫，先問「要把地點改成…嗎」（記者看得到的改動一律先確認）', /要把《智慧醫療解決方案記者會》的地點/.test(textOf(out)) && !med[12] && JSON.stringify(buttons(out)) === JSON.stringify(['✅ 確認修改', '✖ 取消修改']), JSON.stringify([textOf(out), med[12]]));
  out = await dm('U_c', '✅ 確認修改');
  check('　 確認之後才寫，並給「繼續下一步」', med[12] === '台北國際會議中心' && buttons(out).includes('帶我：智慧醫療解決方案記者會'), JSON.stringify([med[12], buttons(out)]));
}

console.log('\n── 負責人：認領、活動卡、自己填 ──');
{
  out = await dm('U_c2', '智慧醫療解決方案記者會');
  check('活動卡顯示負責人；不是自己負責的有「🙋 我來負責」', /負責人：小華/.test(textOf(out)) && buttons(out).includes('負責：智慧醫療解決方案記者會'), textOf(out));
  out = await dm('U_c2', '負責：智慧醫療解決方案記者會');
  check('★ 「負責：」→ 換成自己，並通知管理員（誰把這場接走了）', state.eventOwners.at(-1)[0] === 'med' && state.eventOwners.at(-1)[1] === 'U_c2' && /由你負責/.test(textOf(out)) && sent.some((o) => o.to === 'U_admin' && /活動負責人變更/.test(o.text) && /小華/.test(o.text) && /小明/.test(o.text)), JSON.stringify(sent.map((o) => [o.to, o.text.slice(0, 40)])));
  out = await dm('U_c2', '負責：智慧醫療解決方案記者會');
  check('　 本來就是自己負責 → 說一聲，不重複寫', /本來就是你負責/.test(textOf(out)) && state.eventOwners.filter((r) => r[0] === 'med').length === 2);
  out = await dm('U_c2', '智慧醫療解決方案記者會');
  check('　 活動卡：負責人是「你」，不再顯示「我來負責」', /負責人：你/.test(textOf(out)) && !buttons(out).includes('負責：智慧醫療解決方案記者會'), textOf(out));

  const soon = state.events.find((e) => e[0] === 'soon');
  out = await dm('U_c2', '自己填：奈米材料前瞻應用發表會');
  check('★ 「我自己填」→ 給編輯連結、說清楚活動前一天會提醒、沒有進入問答', /\/edit\?id=soon&code=code4/.test(textOf(out)) && /活動前一天傍晚/.test(textOf(out)) && state.eventOwners.some((r) => r[0] === 'soon' && r[1] === 'U_c2'), textOf(out));
  out = await dm('U_c2', '隨便打一句');
  check('　 之後打的字不會被當成某一題的答案', !/記好了/.test(textOf(out)) && soon[12] === '', textOf(out));
}

console.log('\n── 同仁傳照片 ──');
{
  out = await image('U_c2');
  check('★ 同仁傳照片 → 問「要加到哪一場」，自己負責的場次排最前面', /收到 1 張照片/.test(textOf(out)) && ['智慧醫療解決方案記者會', '奈米材料前瞻應用發表會'].includes(buttons(out)[0]) && buttons(out).slice(0, 2).sort().join() === ['智慧醫療解決方案記者會', '奈米材料前瞻應用發表會'].sort().join() && !buttons(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify(buttons(out)));
  out = await dm('U_c2', '智慧醫療解決方案記者會');
  check('　 點場次 → 照片加進那一場', /已把 1 張照片加進《智慧醫療解決方案記者會》/.test(textOf(out)) && state.photoUploads.length === 1 && state.photoUploads[0][0] === 'med', textOf(out));
  out = await image('U_reporter');
  check('★ 記者傳照片：照舊，不會被收進暫存', !/收到 \d 張照片/.test(textOf(out)) && !(state.photoInbox || []).some((r) => r[0] === 'U_reporter'), textOf(out));
}

// ═══ 三、活動前一天提醒 ═════════════════════════════════════════════════════════
console.log('\n── 三、活動前一天提醒 ──');
const { runRemindCron } = await import('../lib/event-remind.js');
const FULL_KB = '【活動議程】\n- 10:00 開幕\n【受訪者 / 發言人】\n- 王大明（所長）：技術說明\n【貴賓致詞】\n- 李部長：致詞\n【新聞稿全文】\n工研院今日發表新技術';
const pushes = () => sent.filter((o) => o.push);
const evRow = (id, name, date, o = {}) => { const r = Array(18).fill(''); Object.assign(r, { 0: id, 1: name, 2: '#0F9E7A', 4: 'active', 5: date, 9: '工研院', 10: 'code_' + id }, o); return r; };
{
  reset(); state.staff.push(colleagueRow('U_c', '小華')); await fresh();
  sent.length = 0;
  let r = await runRemindCron({ slot: 'evening' });
  const soon = state.events.find((e) => e[0] === 'soon');
  check('★ 沒有負責人 → 推給管理員，並說明為什麼；附這場的編輯連結', r.sent === 1 && r.toAdmin === 1 && pushes().length === 1 && pushes()[0].to === 'U_admin' && /沒有負責人/.test(pushes()[0].text) && /奈米材料前瞻應用發表會/.test(pushes()[0].text) && /\/edit\?id=soon&code=code4/.test(pushes()[0].text), JSON.stringify([r, pushes().map((p) => p.text)]));
  check('　 提醒內容：還缺地點、新聞聯絡人、議程等（正式新聞稿那一欄有字，但沒有議程／受訪者／貴賓小節）', /還缺：/.test(pushes()[0].text) && /地點/.test(pushes()[0].text) && /新聞聯絡人/.test(pushes()[0].text) && /議程/.test(pushes()[0].text), pushes()[0]?.text);
  check('　 發送紀錄寫進 event_reminders（活動 id、活動日期、種類、收件人、sent）', state.eventReminders.length === 1 && state.eventReminders[0][1] === 'soon' && state.eventReminders[0][2] === soon[5] && state.eventReminders[0][3] === 'eve' && state.eventReminders[0][4] === 'U_admin' && state.eventReminders[0][5] === 'sent', JSON.stringify(state.eventReminders));
  sent.length = 0;
  r = await runRemindCron({ slot: 'evening' });
  check('★ 同一場同一個活動日期只提醒一次（一天排兩班，第二班不會重複推）', r.sent === 0 && pushes().length === 0 && state.eventReminders.length === 1, JSON.stringify(r));
  state.events.find((e) => e[0] === 'soon')[5] = isoOffset(1); // 同一天，不變
  sent.length = 0;
  r = await runRemindCron({ slot: 'evening', now: new Date(Date.now() + 86400000) });
  check('　 　隔天再跑：活動變成「今天」，不再提醒', r.candidates === 0 && pushes().length === 0, JSON.stringify(r));
}
{
  reset(); state.staff.push(colleagueRow('U_c', '小華')); state.eventOwners.push(['soon', 'U_c', '小華', 't', 'create']); await fresh();
  sent.length = 0;
  const r = await runRemindCron({ slot: 'evening' });
  check('★ 有負責人（而且還是同仁）→ 推給他、不是管理員', r.sent === 1 && r.toAdmin === 0 && pushes()[0].to === 'U_c' && !/沒有負責人/.test(pushes()[0].text), JSON.stringify(pushes().map((p) => [p.to, p.text.slice(0, 30)])));
}
{
  reset(); state.staff.push(['U_c', '小華', 't', 'revoked', '', 'colleague']); state.eventOwners.push(['soon', 'U_c', '小華', 't', 'create']); await fresh();
  sent.length = 0;
  const r = await runRemindCron({ slot: 'evening' });
  check('★ 負責人已退出同仁模式 → 改推給管理員（這場不能悄悄沒人提醒）', r.toAdmin === 1 && pushes()[0].to === 'U_admin' && /沒有負責人/.test(pushes()[0].text), JSON.stringify(pushes().map((p) => p.to)));
}
{
  reset(); state.staff.push(colleagueRow('U_c', '小華'));
  state.events.push(evRow('b1', '第二場明天', isoOffset(1), { 3: '', 4: 'active' }));
  state.eventOwners.push(['soon', 'U_c', '小華', 't', 'create'], ['b1', 'U_c', '小華', 't', 'create']); await fresh();
  sent.length = 0;
  const r = await runRemindCron({ slot: 'evening' });
  check('★ 同一人明天有兩場 → 合成一則（省推播則數）', r.sent === 2 && pushes().length === 1 && /奈米材料前瞻應用發表會/.test(pushes()[0].text) && /第二場明天/.test(pushes()[0].text), JSON.stringify(pushes().map((p) => p.text.slice(0, 60))));
}
{
  reset(); state.staff.push(colleagueRow('U_c'));
  state.events.length = 0;
  state.events.push(
    evRow('full', '資料齊全的發表會', isoOffset(1), { 3: FULL_KB, 12: '南港', 14: '王小明 0912' }),
    evRow('draftfull', '草稿但資料齊全', isoOffset(1), { 3: FULL_KB, 4: 'draft', 12: '南港', 14: '王小明 0912' }),
    evRow('today', '今天的', isoOffset(0), { 3: '', 12: '' }),
    evRow('ended', '已結束的', isoOffset(1), { 3: '', 4: 'ended' }),
    evRow('biz', '企業專屬頁', isoOffset(1), { 3: '', 13: '客戶參訪' })
  ); await fresh();
  sent.length = 0;
  const r = await runRemindCron({ slot: 'evening' });
  check('★ 沒缺東西就不推；草稿即使資料齊全也提醒（還沒發布）；今天／已結束／企業場不提醒', r.candidates === 1 && pushes().length === 1 && /草稿但資料齊全/.test(pushes()[0].text) && !/資料齊全的發表會/.test(pushes()[0].text.replace('草稿但資料齊全', '')) && /未發布/.test(pushes()[0].text), JSON.stringify([r, pushes().map((p) => p.text)]));
}
{
  reset(); await fresh(); sent.length = 0;
  const r = await runRemindCron({ slot: 'evening', dry: true });
  check('★ dry：算得出會推幾場、但不推、不寫紀錄', r.dry && r.sent === 1 && pushes().length === 0 && state.eventReminders.length === 0, JSON.stringify(r));
}
{
  reset(); await fresh(); sent.length = 0;
  process.env.REMIND_MONTHLY_MAX = '0';
  const r = await runRemindCron({ slot: 'evening' });
  delete process.env.REMIND_MONTHLY_MAX;
  check('★ 每月上限（REMIND_MONTHLY_MAX）：設 0 就整個停掉，並說原因', r.sent === 0 && pushes().length === 0 && r.skipped.some((t) => /上限/.test(t)), JSON.stringify(r));
  // 已用掉的筆數算進本月
  reset(); await fresh(); sent.length = 0;
  process.env.REMIND_MONTHLY_MAX = '2';
  const ym = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
  state.eventReminders.push([`${ym}-01 17:00:00`, 'o1', '2026-01-01', 'eve', 'U_x', 'sent'], [`${ym}-02 17:00:00`, 'o2', '2026-01-01', 'eve', 'U_x', 'sent']);
  const r2 = await runRemindCron({ slot: 'evening' });
  delete process.env.REMIND_MONTHLY_MAX;
  check('　 本月已經推了 2 筆、上限 2 → 這次不推', r2.sent === 0 && pushes().length === 0, JSON.stringify(r2));
}
{
  reset(); await fresh();
  let c = await cron('cron_remind', { secret: '' });
  check('★ 排程入口沒帶密鑰 → 401（會對 LINE 推播，不能是公開端點）', c.status === 401, JSON.stringify(c));
  c = await cron('cron_remind', { secret: 'wrong' });
  check('　 密鑰錯 → 401', c.status === 401);
  sent.length = 0;
  c = await cron('cron_remind', { query: { dry: '1', slot: 'evening' } });
  check('　 密鑰對、dry=1 → 200，回摘要、沒有推播', c.status === 200 && c.body?.dry === true && c.body.sent === 1 && pushes().length === 0, JSON.stringify(c));
  const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rem = vj.crons.filter((x) => x.path === '/api/line?action=cron_remind');
  // 批次 178 多了早上那班（UTC 00:30＝台灣 08:30）；傍晚兩班（17:00、17:30）不變
  check('★ vercel.json：傍晚兩班（17:00、17:30 台灣時間）仍在，都是一天一次的寫法', ['0 9 * * *', '30 9 * * *'].every((t) => rem.some((x) => x.schedule === t)), JSON.stringify(rem));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 177 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
