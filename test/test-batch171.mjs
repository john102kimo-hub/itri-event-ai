// 批次 171：活動前沒填「媒體邀請函」就發布——不擋，但一定要先看過後果。
// 朱朱：「記者透過 LINE 都可以問到所有活動資訊，我怕有些同仁在後台先上傳更新資料、忘記填寫活動前資訊（媒體邀請函），
// 活動前就按發布（LINE 會出現），能不能跳出警告？」
//   一、規則（lib/event-status.js）：什麼時候要問、問的是「發布」還是「改內容」
//   二、後端出口（api/events.js）：三個入口沒帶 ack_no_invite 一律 409、而且沒有寫入；帶了才寫
//   三、畫面：後台與同仁編輯頁的「媒體邀請函」不再收合、上面一行講後果、收到 409 跳確認視窗
// LINE 職員／同仁模式的確認訊息在 test-batch171-line.mjs。
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
const { preEventWithoutInvite, inviteLetterCheck, inviteLetterWarning } = await import('../lib/event-status.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
}
const events = (await import('../api/events.js')).default;
const call = async (body, headers = { 'x-admin-password': 'pw' }) => {
  const r = fakeRes();
  await events({ method: 'POST', query: {}, body, headers }, r);
  return r;
};
const inDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const TODAY = inDays(0);
const KB = '【新聞稿全文】\n工研院今日發表新一代技術，預計 2027 年第二季量產。（禁發至活動當天 10:00）';
const INVITE = '親愛的媒體朋友：誠摯邀請蒞臨採訪，10:00 開始。';

// events 表的一列（A～R）
const row = (o = {}) => [
  o.id || 'e1', o.name || '新技術發表會', '#0F9E7A', o.kb ?? KB, o.status || 'draft', o.date ?? inDays(2), '', o.images || '', '', '工研院',
  o.code || 'cc', '', o.venue ?? '中興院區', o.type || '記者會', o.contact ?? '王小明 03-1', '', o.invite ?? '', ''
];
const rowOf = (id) => book.events.find((r) => r[0] === id) || [];

// ═══ 一、規則 ═════════════════════════════════════════════════════════════════
console.log('\n── 一、規則：活動前、沒有邀請函、不是企業場才要問 ──');
{
  const w = preEventWithoutInvite(row({ date: inDays(2) }), TODAY);
  check('★ 兩天後才辦、沒填邀請函 → 要問（帶日期與剩幾天）', w && w.date === inDays(2) && w.daysLeft === 2, JSON.stringify(w));
  check('　 有填邀請函 → 不用問（活動前米亞只用邀請函）', preEventWithoutInvite(row({ invite: INVITE }), TODAY) === null);
  check('　 只有空白的邀請函 → 算沒填', !!preEventWithoutInvite(row({ invite: '  \n ' }), TODAY));
  check('★ 活動當天 → 不用問（當天起本來就用知識庫，跟 lib/prompt.js isBeforeEventDate 一樣：嚴格晚於今天才算活動前）', preEventWithoutInvite(row({ date: TODAY }), TODAY) === null);
  check('　 已經辦過 → 不用問', preEventWithoutInvite(row({ date: inDays(-3) }), TODAY) === null);
  check('　 日期只有建立時間戳 → 不用問（沒有日期本來就發布不了）', preEventWithoutInvite(row({ date: '2026/10/22 上午8:59:17' }), TODAY) === null);
  check('　 企業場 → 不用問（沒有「活動前」這回事）', preEventWithoutInvite(row({ type: '技術媒合會' }), TODAY) === null);

  const draft = row(), live = row({ status: 'active' });
  check('★ 草稿 → 進行中：kind=publish', inviteLetterCheck(draft, live, TODAY)?.kind === 'publish');
  check('　 直接以進行中新增（before=null）：kind=publish', inviteLetterCheck(null, live, TODAY)?.kind === 'publish');
  check('　 封存 → 進行中也是發布', inviteLetterCheck(row({ status: 'archived' }), live, TODAY)?.kind === 'publish');
  check('　 草稿 → 已結束也是發布（已結束一樣公開）', inviteLetterCheck(draft, row({ status: 'ended' }), TODAY)?.kind === 'publish');
  check('★ 本來就公開、這次改了知識庫：kind=content（記者馬上就問得到新內容）', inviteLetterCheck(live, row({ status: 'active', kb: KB + '\n補一段。' }), TODAY)?.kind === 'content');
  check('　 本來就公開、加了照片：kind=content', inviteLetterCheck(live, row({ status: 'active', images: 'https://x/a.jpg' }), TODAY)?.kind === 'content');
  check('　 本來就公開、把邀請函清掉：kind=content（活動前那道牆拆了）', inviteLetterCheck(row({ status: 'active', invite: INVITE }), live, TODAY)?.kind === 'content');
  check('★ 本來就公開、只改名稱／時間這類欄位 → 不問（改錯字不用每次被攔）', inviteLetterCheck(live, row({ status: 'active', name: '新技術發表會（改名）' }), TODAY) === null);
  check('　 知識庫只差頭尾空白 → 不算改了', inviteLetterCheck(live, row({ status: 'active', kb: KB + '\n  ' }), TODAY) === null);
  check('　 草稿改內容 → 不問（記者還看不到）', inviteLetterCheck(draft, row({ kb: KB + '\n補一段。' }), TODAY) === null);
  check('　 公開 → 收回草稿 → 不問', inviteLetterCheck(live, row({ status: 'draft' }), TODAY) === null);

  const t = inviteLetterWarning({ kind: 'publish', date: inDays(2), daysLeft: 2 }, '新技術發表會');
  check('★ 後果講得清楚：哪一場、哪天辦、還有幾天、記者會拿到什麼、怎麼辦', /《新技術發表會》/.test(t) && /還有 2 天/.test(t) && /新聞稿全文、照片/.test(t) && /請先填媒體邀請函/.test(t) && /活動當天自動換回知識庫/.test(t), t);
  check('　 沒給名稱 → 寫「這場」（LINE 確認訊息上一行已經講了是哪一場）', /^這場 \d+\/\d+（.）才辦/.test(inviteLetterWarning({ kind: 'publish', date: inDays(2), daysLeft: 2 }, '')));
  check('　 改內容的說法不一樣（已經發布、這次存的內容）', /已經發布.*這次存的內容/.test(inviteLetterWarning({ kind: 'content', date: inDays(2), daysLeft: 2 }, 'x')));
}

// ═══ 二、後端出口 ═════════════════════════════════════════════════════════════
console.log('\n── 二、後端：沒帶 ack_no_invite 一律 409、沒有寫入；帶了才寫 ──');
{
  reset();
  book.events = [['id'],
    row({ id: 'p1', code: 'c1' }),
    row({ id: 'p2', code: 'c2', invite: INVITE }),
    row({ id: 'p3', code: 'c3', date: TODAY }),
    row({ id: 'live', code: 'c4', status: 'active' }),
    row({ id: 'biz', code: 'c5', type: '技術媒合會', date: '', venue: '', kb: '技術介紹：…' }),
  ];

  // 後台卡片上的「發布」鈕（action=update 只帶 status）
  let r = await call({ action: 'update', password: 'pw', id: 'p1', status: 'active' });
  check('★ 後台按發布：活動前、沒邀請函 → 409 code=pre_event_no_invite、kind=publish', r.statusCode === 409 && r.body.code === 'pre_event_no_invite' && r.body.kind === 'publish' && r.body.date === inDays(2) && r.body.days_left === 2, JSON.stringify(r.body));
  check('　 錯誤訊息就是那段後果（舊版頁面也看得懂）', /還沒填「媒體邀請函」/.test(r.body.error || '') && /新聞稿全文、照片/.test(r.body.error || ''), r.body.error);
  check('★ 被退回的時候，試算表裡那場還是草稿（沒有寫入）', rowOf('p1')[4] === 'draft');
  r = await call({ action: 'update', password: 'pw', id: 'p1', status: 'active', ack_no_invite: 'yes' });
  check('　 ack 只認真正的 true（隨手帶的字串不算）', r.statusCode === 409 && rowOf('p1')[4] === 'draft', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'p1', status: 'active', ack_no_invite: true });
  check('★ 按「照樣發布」（帶 ack_no_invite）→ 發布', r.statusCode === 200 && rowOf('p1')[4] === 'active', JSON.stringify(r.body));

  r = await call({ action: 'update', password: 'pw', id: 'p2', status: 'active' });
  check('★ 有填邀請函 → 照常發布，不問', r.statusCode === 200 && rowOf('p2')[4] === 'active', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'p3', status: 'active' });
  check('　 活動當天發布 → 不問', r.statusCode === 200 && rowOf('p3')[4] === 'active', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'biz', status: 'active' });
  check('　 企業場發布 → 不問', r.statusCode === 200 && rowOf('biz')[4] === 'active', JSON.stringify(r.body));

  // 後台編輯視窗：本來就公開，同仁把新聞稿貼進來
  const kbBefore = rowOf('live')[3];
  r = await call({ action: 'update', password: 'pw', id: 'live', knowledge_base: KB + '\n【新聞稿全文】正式版貼上。' });
  check('★ 已發布、活動前、沒邀請函，貼了新的知識庫 → 409 kind=content，沒有寫入', r.statusCode === 409 && r.body.kind === 'content' && rowOf('live')[3] === kbBefore, JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'live', knowledge_base: KB + '\n【新聞稿全文】正式版貼上。', ack_no_invite: true });
  check('　 按「照樣儲存」→ 寫入', r.statusCode === 200 && /正式版貼上/.test(rowOf('live')[3]));
  r = await call({ action: 'update', password: 'pw', id: 'live', name: '新技術發表會（改名）' });
  check('★ 同一場只改名稱 → 直接存（不能連改錯字都被攔）', r.statusCode === 200 && rowOf('live')[1] === '新技術發表會（改名）', JSON.stringify(r.body));
  r = await call({ action: 'update', password: 'pw', id: 'live', knowledge_base: rowOf('live')[3], invite_letter: INVITE });
  check('★ 補上邀請函 → 直接存（這正是我們要的）', r.statusCode === 200 && rowOf('live')[16] === INVITE, JSON.stringify(r.body));

  // 同仁編輯頁（update_edit，不用後台密碼）
  reset();
  book.events = [['id'], row({ id: 'e1', code: 'ec1' })];
  r = await call({ action: 'update_edit', id: 'e1', code: 'ec1', status: 'active' }, {});
  check('★ 同仁編輯頁把狀態改進行中 → 一樣 409、沒有寫入', r.statusCode === 409 && r.body.code === 'pre_event_no_invite' && rowOf('e1')[4] === 'draft', JSON.stringify(r.body));
  r = await call({ action: 'update_edit', id: 'e1', code: 'ec1', status: 'active', ack_no_invite: true }, {});
  check('　 帶 ack → 發布', r.statusCode === 200 && rowOf('e1')[4] === 'active');
  r = await call({ action: 'update_edit', id: 'e1', code: 'ec1', status: 'active', knowledge_base: KB + '\n再補一句。' }, {});
  check('　 發布之後、活動前再改知識庫 → 409 kind=content', r.statusCode === 409 && r.body.kind === 'content', JSON.stringify(r.body));
  r = await call({ action: 'update_edit', id: 'e1', code: 'wrong', status: 'active', knowledge_base: KB + '\n再補一句。' }, {});
  check('　 編輯碼錯 → 照舊是 401（先驗身分，不會先洩漏這場的狀態）', r.statusCode === 401);

  // 必填沒齊的時候，先講必填（那是擋；這個是問）
  reset();
  book.events = [['id'], row({ id: 'm1', venue: '', contact: '' })];
  r = await call({ action: 'update', password: 'pw', id: 'm1', status: 'active' });
  check('★ 必填沒齊又沒邀請函 → 先回必填（400 publish_blocked），補齊了才輪到問邀請函', r.statusCode === 400 && r.body.code === 'publish_blocked', JSON.stringify(r.body));

  // 直接以進行中新增
  reset();
  book.events = [['id']];
  r = await call({ action: 'create', password: 'pw', name: '直接公開', knowledge_base: KB, status: 'active', event_date: inDays(5), venue: '中興院區', press_contact: '王小明' });
  check('★ 直接以進行中新增、活動前沒邀請函 → 409，而且沒有新增那一列', r.statusCode === 409 && book.events.length === 1, JSON.stringify(r.body));
  r = await call({ action: 'create', password: 'pw', name: '直接公開', knowledge_base: KB, status: 'active', event_date: inDays(5), venue: '中興院區', press_contact: '王小明', invite_letter: INVITE });
  check('　 一起填了邀請函 → 照常新增', r.statusCode === 200 && r.body.status === 'active' && book.events.length === 2, JSON.stringify(r.body));
  r = await call({ action: 'create', password: 'pw', name: '先建草稿', knowledge_base: KB, event_date: inDays(5) });
  check('　 新增草稿（預設）→ 不問', r.statusCode === 200 && r.body.status === 'draft');
}

// ═══ 三、畫面 ═════════════════════════════════════════════════════════════════
console.log('\n── 三、畫面：邀請函不收合、上面一行講後果、收到 409 跳確認視窗 ──');
{
  const admin = read('public/index.html');
  const ed = read('public/edit.html');
  const details = admin.slice(admin.indexOf('<details class="adv"'), admin.indexOf('</details>', admin.indexOf('<details class="adv"')));
  const at = (html, id) => html.indexOf(`id="${id}"`);
  check('★ 後台編輯視窗：媒體邀請函不在收合的「進階設定」裡', at(admin, 'input-invite-letter') > 0 && !/id="input-invite-letter"/.test(details));
  check('　 排在知識庫下面、快速提問上面（後台與同仁編輯頁同一個順序）',
    at(admin, 'input-kb') < at(admin, 'input-invite-letter') && at(admin, 'input-invite-letter') < at(admin, 'input-chips')
    && at(ed, 'input-kb') < at(ed, 'input-invite-letter') && at(ed, 'input-invite-letter') < at(ed, 'input-chips'));
  check('　 進階設定的說明不再寫「邀請函」（不在裡面了）；活動前快速提問的說明改成「上面有填媒體邀請函時」',
    !/<small>[^<]*邀請函[^<]*<\/small><\/summary>/.test(admin) && /活動前（而且上面有填媒體邀請函時）/.test(admin));
  check('★ 兩頁都有「活動前，記者現在問得到什麼」那一行，三種情況都講到', [admin, ed].every((h) => /id="pre-event-now"/.test(h)
    && /還沒填邀請函：\$\{live \? '記者現在' : '一發布，記者'\}/.test(h) && /活動前記者只拿得到下面這份邀請函/.test(h) && /活動已經到了：記者問到的是上面的知識庫/.test(h)));
  check('★ 兩頁收到 pre_event_no_invite 都跳確認視窗、按「照樣」才帶 ack_no_invite 再送一次', [admin, ed].every((h) => /data\.code === 'pre_event_no_invite'/.test(h) && /ack_no_invite:/.test(h) && /內容可以公開，照樣發布/.test(h) && /先去填邀請函/.test(h)));
  check('　 後台卡片上的「發布」鈕也接了（不只編輯視窗）', /async function publishEvent\(id, ack = false\)/.test(admin) && /publishEvent\(id, true\)/.test(admin));
  check('　 同仁編輯頁：會被問邀請函的時候，不先跳一般的「確定要發布嗎」（不連跳兩個視窗）', /!ack && !preEventDaysWithoutInvite\(\) &&\s*!confirm\('確定要發布這場活動嗎/.test(ed));
  check('　 同仁編輯頁：邀請函那一格仍掛 biz-hide（企業場照樣藏）；剩下的卡片改名「邀訪窗口與主辦單位」',
    /<div class="form-group biz-hide">\s*<textarea class="form-control" id="input-invite-letter"/.test(ed) && /邀訪窗口與主辦單位（選填）/.test(ed) && !/邀訪窗口與邀請函/.test(ed));
  check('　 確認視窗裡的字用 textContent 填（活動名稱不經過 innerHTML）', [admin, ed].every((h) => /getElementById\('iw-body'\)\.textContent =/.test(h) && !/iw-body'\)\.innerHTML/.test(h)));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 171 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
