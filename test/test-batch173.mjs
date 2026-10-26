// 批次 173：活動前有填媒體邀請函 → 新聞稿可以活動當天再補，照樣能發布。
// 朱朱看著「還不能發布：日期、地點、新聞聯絡人、新聞稿」問：「現在沒有這四項不能發布，但如果有媒體邀請函呢？也不能發布？」
// 以前真的不能：活動前米亞本來就只用邀請函回答，新聞稿這一項卻照樣擋——逼同仁在新聞稿定稿前先亂貼一段湊數。
//   一、規則（lib/event-status.js）：活動前＋有邀請函 → 新聞稿不擋；當天起照舊要新聞稿；提醒「當天前補上」
//   二、後端出口（api/events.js）：發布閘門跟著放行；當天、沒邀請函照舊擋
//   三、保險（lib/prompt.js）：活動當天新聞稿還沒貼，米亞繼續用邀請函，不會什麼都答「沒有資料」
//   四、畫面：後台與同仁編輯頁的「發布前必填」跟著同一條規則
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');
const { eventChecklist, publishBlockers, formatProgressOverview, formatNudgeMessage } = await import('../lib/event-status.js');
const { resolveEventContent, isPreEventMode, buildSystemPrompt, buildBusinessSystemPrompt } = await import('../lib/prompt.js');
const { KB_TEMPLATE } = await import('../lib/kb-template.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, body: undefined };
  r.setHeader = () => r; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; }; r.send = (o) => { r.body = o; return r; }; r.end = () => r;
  return r;
}
const events = (await import('../api/events.js')).default;
const call = async (body) => { const r = fakeRes(); await events({ method: 'POST', query: {}, body, headers: { 'x-admin-password': 'pw' } }, r); return r; };

const inDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const TODAY = inDays(0);
const INVITE = '親愛的媒體朋友：誠摯邀請蒞臨採訪。時間：10:00；地點：中興院區 51 館；議程：10:00 開幕、10:20 發表。';
const KB = '【新聞稿全文】\n工研院今日發表新一代儲電技術。';
// events 表的一列（A～R）
const row = (o = {}) => [
  o.id || 'e1', o.name || '儲電新技術發表會', '#0F9E7A', o.kb ?? KB_TEMPLATE, o.status || 'draft', o.date ?? inDays(3), '', o.images || '', '', '工研院',
  'cc', '10:00', '中興院區 51 館', o.type || '記者會', '林小華 03-5912222', '', o.invite ?? INVITE, ''
];
const rowOf = (id) => book.events.find((r) => r[0] === id) || [];

// ═══ 一、規則 ═════════════════════════════════════════════════════════════════
console.log('\n── 一、規則：活動前＋有邀請函 → 新聞稿可以當天再補 ──');
{
  const c = eventChecklist(row(), TODAY);
  const kbItem = c.required.find((i) => i.key === 'knowledge_base');
  check('★ 三天後才辦、知識庫只有範本、有填邀請函 → 必填齊了、可以發布', c.missingRequired.length === 0 && publishBlockers(row(), TODAY).length === 0, JSON.stringify(c.missingRequired));
  check('　 新聞稿那一項打勾，旁邊寫「活動前先用邀請函」；kbPending 標著還要補', kbItem.done && kbItem.detail === '活動前先用邀請函' && c.kbPending === true, JSON.stringify(kbItem));
  check('★ 沒有邀請函 → 新聞稿照舊要（四項必填不變）', publishBlockers(row({ invite: '' }), TODAY).includes('新聞稿'));
  check('　 只有空白的邀請函 → 不算', publishBlockers(row({ invite: ' \n ' }), TODAY).includes('新聞稿'));
  check('★ 活動當天 → 新聞稿照舊要（當天起記者問的就是新聞稿）', publishBlockers(row({ date: TODAY }), TODAY).includes('新聞稿'));
  check('　 已經辦過 → 照舊要', publishBlockers(row({ date: inDays(-2) }), TODAY).includes('新聞稿'));
  check('　 新聞稿已經貼了 → 照常，不標「先用邀請函」', !eventChecklist(row({ kb: KB }), TODAY).kbPending && eventChecklist(row({ kb: KB }), TODAY).required.find((i) => i.key === 'knowledge_base').detail !== '活動前先用邀請函');
  check('　 企業場不套（企業場沒有邀請函這回事，必填是「內容」）', eventChecklist(row({ type: '技術媒合會' }), TODAY).missingRequired.includes('內容'));
  check('　 日期、地點、新聞聯絡人照舊必填（邀請函只頂替新聞稿）', publishBlockers([...row().slice(0, 12), '', ...row().slice(13)], TODAY).includes('地點'));

  const ov = formatProgressOverview([row()], TODAY).text;
  check('★ LINE「活動與進度」：寫「必填 4／4 ✅（新聞稿活動當天前補上，活動前先用邀請函）」', /必填 4／4 ✅（新聞稿活動當天前補上，活動前先用邀請函）/.test(ov), ov);
  const nudge = formatNudgeMessage(eventChecklist(row(), TODAY), 'https://x/edit');
  check('　 催填訊息也提醒「新聞稿：活動前先用邀請函，活動當天前請補上」', /新聞稿：活動前先用邀請函，活動當天前請補上/.test(nudge) && !/必填還缺/.test(nudge), nudge);
}

// ═══ 二、後端出口 ═════════════════════════════════════════════════════════════
console.log('\n── 二、後端：發布閘門跟著放行；當天、沒邀請函照舊擋 ──');
{
  reset();
  book.events = [['id'], row({ id: 'inv' }), row({ id: 'noinv', invite: '' }), row({ id: 'today', date: TODAY })];
  let r = await call({ action: 'update', password: 'pw', id: 'inv', status: 'active' });
  check('★ 活動前、有邀請函、新聞稿還沒貼 → 按發布直接成功（也不跳批次 171 的邀請函警告，因為有邀請函）', r.statusCode === 200 && rowOf('inv')[4] === 'active', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'noinv', status: 'active' });
  check('★ 沒邀請函、也沒新聞稿 → 照舊 400，缺新聞稿', r.statusCode === 400 && r.body.code === 'publish_blocked' && r.body.missing.includes('新聞稿') && rowOf('noinv')[4] === 'draft', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'today', status: 'active' });
  check('　 活動當天才發布、只有邀請函 → 照舊 400（當天要新聞稿）', r.statusCode === 400 && r.body.missing.includes('新聞稿'), JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'inv', invite_letter: '' });
  check('★ 已發布的活動、活動前把邀請函清掉 → 批次 171 照樣先問（記者會改拿到整份知識庫）', r.statusCode === 409 && r.body.code === 'pre_event_no_invite' && rowOf('inv')[16] === INVITE, JSON.stringify(r.body));
}

// ═══ 三、保險：活動當天新聞稿還沒貼 ═════════════════════════════════════════════
console.log('\n── 三、保險：活動當天新聞稿還沒貼，米亞繼續用邀請函 ──');
{
  const ev = (o = {}) => ({ name: '儲電新技術發表會', organizer: '工研院', event_date: o.date ?? TODAY, knowledge_base: o.kb ?? KB_TEMPLATE, invite_letter: o.invite ?? INVITE, images: 'https://x/a.jpg', chips: '正式題', invite_letter_chips: '活動前題' });
  const d = resolveEventContent(ev());
  check('★ 活動當天、知識庫只有範本、有邀請函 → 用邀請函回答（不會什麼都說「沒有資料」）', d.knowledge_base === INVITE && d.invite_fallback === true, JSON.stringify(d));
  check('　 照片、快速提問照常（當天上傳的照片本來就是給記者的；不是活動前模式）', d.images === 'https://x/a.jpg' && d.chips === '正式題' && !isPreEventMode(ev()));
  const withKb = resolveEventContent(ev({ kb: KB }));
  check('★ 新聞稿貼了 → 當天照常用知識庫（原本的行為不變）', withKb.knowledge_base === KB && !withKb.invite_fallback);
  check('　 活動前 → 照舊是活動前模式（只用邀請函、不給照片）', resolveEventContent(ev({ date: inDays(2) })).images === '' && !resolveEventContent(ev({ date: inDays(2) })).invite_fallback);
  check('　 沒有邀請函 → 不換（知識庫是空的就是空的，跟以前一樣）', resolveEventContent(ev({ invite: '' })).knowledge_base === KB_TEMPLATE);
  const pub = resolveEventContent({ status: 'active', event_date: TODAY, chips: '', images: 'a.jpg', invite_letter: INVITE, invite_letter_chips: '' });
  check('★ 公開端點那種只帶 chips／images 的呼叫 → 不會多出 knowledge_base（邀請函全文不外送）', !('knowledge_base' in pub) && !pub.invite_fallback, JSON.stringify(Object.keys(pub)));
  const p = buildSystemPrompt(d);
  check('★ 這時候的提示：背景資料是邀請函、正式新聞稿還沒提供，不要把邀請函說成新聞稿全文', /正式新聞稿還沒有提供/.test(p) && /不要把邀請函內容說成是新聞稿全文/.test(p) && /<資料開始>\n親愛的媒體朋友/.test(p));
  check('　 不是「活動尚未舉行」那一句（活動已經開始了）', !/目前活動尚未舉行/.test(p));
  check('　 一般情況（有新聞稿）提示一個字都沒多', !/正式新聞稿還沒有提供/.test(buildSystemPrompt(withKb)));
  check('　 企業場的提示也有對應的一句', /正式資料還沒有提供/.test(buildBusinessSystemPrompt({ ...d, event_type: '技術媒合會' })));
}

// ═══ 四、畫面 ═════════════════════════════════════════════════════════════════
console.log('\n── 四、畫面：「發布前必填」跟著同一條規則 ──');
{
  const admin = read('public/index.html'), ed = read('public/edit.html');
  check('★ 後台與同仁編輯頁的必填檢查：活動前＋有邀請函 → 新聞稿不算缺', [admin, ed].every((h) =>
    /miss\.kbViaInvite = !kbHasContent\(v\('input-kb'\)\) && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(v\('input-date'\)\) && v\('input-date'\) > today && !!v\('input-invite-letter'\);/.test(h)
    && /if \(!kbHasContent\(v\('input-kb'\)\) && !miss\.kbViaInvite\) miss\.push\(\{ label: '新聞稿'/.test(h)));
  check('　 打勾的那一格寫「新聞稿（活動前先用邀請函，當天再補）」', [admin, ed].every((h) => /活動前先用邀請函，當天再補/.test(h)));
  check('★ 邀請函上面那一行講實話：新聞稿還沒貼時，當天會繼續用邀請函；當天還沒貼就提醒', [admin, ed].every((h) => /新聞稿還沒貼上之前，繼續用邀請函；記得當天補上新聞稿/.test(h) && /活動已經到了，但上面的知識庫還沒有新聞稿：記者問到的仍是這份邀請函/.test(h)));
  check('　 「還不能發布」視窗與知識庫說明講到邀請函這條路', /先填<b>媒體邀請函<\/b>就可以發布，新聞稿活動當天再補/.test(admin) && /活動前填了下面的媒體邀請函就可以先發布/.test(admin) && /新聞稿發布前必填（活動前可先用邀請函）/.test(ed));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 173 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
