// 批次 138：LINE「同仁模式」——給一般同事用，只有新增活動、修改活動（附網站連結）、發布、媒體訓練。
//   一、登入：第二組密語（LINE_COLLEAGUE_PASSCODE）、身分記在 line_staff 的 F 欄、不跟職員搞混
//   二、白名單：職員才有的功能（GEO、後台數據、教米亞、設定選單、問內容）同仁打字也叫不到
//   三、四件事：新增、修改（所有場次都能改、改完附連結）、發布（必填沒齊照樣擋）、媒體訓練
//   四、選單與按鈕：三格選單、底圖、同仁看不到職員選單；退出與再登入
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_COLLEAGUE_PASSCODE = 'Jerry';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

const { COLLEAGUE_MENU, STAFF_MENU, buildRichMenuDefinition, ALL_MENUS } = await import('../lib/menu.js');
const { readFileSync } = await import('node:fs');

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
async function g(gid, uid, text, { mention = true } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: mention ? `@米亞 ${text}` : text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
async function image(uid) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'image', id: 'img' + seq } }]), res);
  return sent.slice();
}
function chips(out) {
  // 通知管理員的 push 不帶按鈕，要看的是同仁自己收到的最後一則
  const vis = out.filter((s) => (s.kind === 'text' || s.kind === 'flex') && s.to !== 'U_admin');
  const last = vis[vis.length - 1];
  if (!last) return [];
  if (last.kind === 'text') return (last.quickReply || []).map((c) => (typeof c === 'object' ? { label: c.label ?? c.text, text: c.text ?? c.label } : { label: c, text: c }));
  const m = (last.messages || [])[last.messages.length - 1];
  return (m?.quickReply?.items || []).map((i) => ({ label: i.action?.label, text: i.action?.text }));
}
const texts = (out) => chips(out).map((c) => c.text);
const labels = (out) => chips(out).map((c) => c.label);
const textOf = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
const HOME = '同仁選單';
const HOME_ALL = ['新增活動', '修改活動', '媒體訓練', '使用說明', '退出同仁模式']; // 首頁、說明、聽不懂：整套入口（跟職員的 STAFF_HOME_CHIPS 同一個做法）
const ENDS_HOME = (out) => texts(out)[texts(out).length - 1] === HOME || JSON.stringify(texts(out)) === JSON.stringify(HOME_ALL);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const colleagueRow = (uid) => [uid, '小華', '2026-10-13', '', '', 'colleague'];
const staffRow = (uid) => [uid, '小美', '2026-08-27', '', ''];
const STAFF_ONLY = /職員選單|設定圖文選單|記憶清單|GEO|成效數據|退出職員模式|催填|更多功能|查活動後台數據/;

// ═══ 一、登入 ═════════════════════════════════════════════════════════════════
console.log('── 一、登入：第二組密語，身分記在 line_staff 的 F 欄 ──');
reset(); await fresh();
{
  state.richMenus.push({ richMenuId: 'rm_col', name: '同仁主選單' }, { richMenuId: 'rm_staff', name: '職員主選單' });
  let out = await dm('U_c1', 'Jerry');
  check('★ 打同仁密語 → 登入，寫進 line_staff，F 欄是 colleague', state.staff.length === 1 && state.staff[0][0] === 'U_c1' && state.staff[0][5] === 'colleague', JSON.stringify(state.staff));
  check('★ 登入訊息：同仁模式已啟用，講的是三件事；不是職員模式', /同仁模式已啟用/.test(textOf(out)) && !/職員模式已啟用/.test(textOf(out)), textOf(out));
  check('★ 登入後的按鈕：三格＋使用說明，沒有任何職員功能', JSON.stringify(labels(out)) === JSON.stringify([...COLLEAGUE_MENU.buttons.map((b) => `${b.icon} ${b.label}`), '❓ 使用說明']) && !texts(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify(labels(out)));
  check('★ 下方選單換成「同仁主選單」（不是職員選單）', state.linkedMenus.get('U_c1') === 'rm_col', JSON.stringify([...state.linkedMenus]));

  out = await dm('U_c1', 'jerry');
  check('　 已經登入又打一次（大小寫不同也算）→ 「已經是同仁模式」，不再寫一列', /已經是同仁模式/.test(textOf(out)) && state.staff.length === 1, JSON.stringify(state.staff));

  out = await dm('U_s1', 'openseasame');
  const sRow = state.staff.find((r) => r[0] === 'U_s1');
  check('　 職員密語照舊：登入成為職員，F 欄空白', /職員模式已啟用/.test(textOf(out)) && sRow && !sRow[5], JSON.stringify(state.staff));
  out = await dm('U_s1', 'Jerry');
  check('★ 職員打同仁密語 → 不降級、不另外寫一列', /已經是職員模式/.test(textOf(out)) && state.staff.filter((r) => r[0] === 'U_s1').length === 1 && !state.staff.find((r) => r[0] === 'U_s1')[5], JSON.stringify(state.staff));

  out = await dm('U_c1', 'openseasame');
  const rows = state.staff.filter((r) => r[0] === 'U_c1');
  check('★ 同仁拿職員密語 → 升級成職員，改原本那一列（只有一列、F 欄清空）', /職員模式已啟用/.test(textOf(out)) && rows.length === 1 && !rows[0][5], JSON.stringify(state.staff));
  check('　 升級後下方選單換成職員版', state.linkedMenus.get('U_c1') === 'rm_staff', JSON.stringify([...state.linkedMenus]));
}

reset(); await fresh();
{
  const saved = process.env.LINE_COLLEAGUE_PASSCODE;
  delete process.env.LINE_COLLEAGUE_PASSCODE;
  await fresh();
  const out = await dm('U_x', 'Jerry');
  check('★ 沒設定 LINE_COLLEAGUE_PASSCODE → 同仁模式整個停用（打 Jerry 只是一般文字，不會登入）', state.staff.length === 0 && !/同仁模式/.test(textOf(out)), JSON.stringify([state.staff, textOf(out)]));
  process.env.LINE_COLLEAGUE_PASSCODE = saved;
}

reset(); await fresh();
{
  process.env.LINE_ADMIN_USER_ID = 'U_admin';
  const out = await dm('U_c2', 'Jerry');
  const note = out.find((o) => o.to === 'U_admin' && o.push);
  check('★ 有新同仁登入 → 通知管理員，講明是「同仁」、密語外流時要換 LINE_COLLEAGUE_PASSCODE', note && /同仁模式登入/.test(note.text) && /LINE_COLLEAGUE_PASSCODE/.test(note.text) && /U_c2/.test(note.text), JSON.stringify(note));
  check('　 已設定管理員：登入訊息不附環境變數說明', !/LINE_ADMIN_USER_ID|環境變數/.test(textOf(out.filter((o) => o.to === 'U_c2'))), textOf(out));
  delete process.env.LINE_ADMIN_USER_ID;
}

reset(); await fresh();
{
  const G = 'Cwork138';
  process.env.LINE_ADMIN_USER_ID = 'U_admin';
  const out = await g(G, 'U陳', 'Jerry');
  check('★ 同仁密語被打在群組 → 群組裡一個字都不回，私訊提醒、通知管理員換 LINE_COLLEAGUE_PASSCODE',
    !out.some((o) => o.to === G) && out.some((o) => o.to === 'U陳' && o.push && /同仁密語/.test(o.text)) && out.some((o) => o.to === 'U_admin' && /LINE_COLLEAGUE_PASSCODE/.test(o.text)), JSON.stringify(out.map((o) => [o.to, o.text])));
  check('　 不會因此變成同仁，也沒有送去問模型', state.staff.length === 0 && !out.some((o) => o.kind === 'answer' || o.kind === 'fallback'), JSON.stringify(state.staff));
  delete process.env.LINE_ADMIN_USER_ID;
}

// ═══ 二、白名單 ═══════════════════════════════════════════════════════════════
console.log('\n── 二、白名單：職員才有的功能，同仁打字也叫不到 ──');
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
{
  const staffMod = await import('../lib/staff.js?v=perm');
  check('★ isStaffAuthenticated() 只認職員：同仁是 false（預設拒絕，以後新增的職員功能同仁也進不去）', (await staffMod.isStaffAuthenticated('U_c')) === false && (await staffMod.isColleagueAuthenticated('U_c')) === true);
  check('　 listActiveStaffIds() 不含同仁、listActiveColleagueIds() 含', !(await staffMod.listActiveStaffIds()).includes('U_c') && (await staffMod.listActiveColleagueIds()).includes('U_c'));

  const asks = [
    ['GEO現在狀況', 'GEO 狀態'], ['查活動後台數據', '後台數據'], ['設定圖文選單', '設定圖文選單'],
    ['記住：這場還在實驗階段', '教米亞'], ['記憶清單', '記憶清單'], ['語氣：回答再短一點', '教米亞（語氣）'],
    ['半導體那場的重點是什麼', '問活動內容'], ['催填：智慧醫療解決方案記者會', '催填'], ['數據：智慧醫療解決方案記者會', '單場數據'],
    ['更多功能', '更多功能'], ['近期工研院新聞', '記者端的新聞'], ['隨便聊聊', '閒聊']
  ];
  const bad = [];
  for (const [msg, name] of asks) {
    await fresh(); // 限流是模組層狀態
    const out = await dm('U_c', msg);
    const ok = /這個我在同仁模式幫不上忙/.test(textOf(out)) && ENDS_HOME(out) && !texts(out).some((t) => STAFF_ONLY.test(t));
    if (!ok) bad.push(`${name}「${msg}」→ ${JSON.stringify([textOf(out).slice(0, 60), texts(out)])}`);
  }
  check(`★ ${asks.length} 種職員才有的叫法：全部回「這個我在同仁模式幫不上忙」，按鈕只有同仁那幾顆`, bad.length === 0, bad.join('\n   '));
  check('★ 什麼都沒被做：沒有記憶被寫入、沒有建選單、沒有改到任何活動', state.memories.length === 0 && state.richMenus.length === 0 && !(state.changes || []).length, JSON.stringify([state.memories, state.changes]));

  await fresh();
  const out = await image('U_c');
  check('★ 同仁傳照片 → 請到編輯頁，不走職員的「加到哪一場」（沒有照片被收進暫存）', /編輯頁/.test(textOf(out)) && (state.photoInbox || []).length === 0 && texts(out).includes('修改活動') && !texts(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify([textOf(out), state.photoInbox]));
}

// ═══ 三、四件事 ═══════════════════════════════════════════════════════════════
console.log('\n── 三、四件事：新增、修改（附連結）、發布、媒體訓練 ──');
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
process.env.LINE_ADMIN_USER_ID = 'U_admin';
{
  // 新增
  let out = await dm('U_c', '新增活動');
  check('★ 「新增活動」→ 問名稱（有「算了」可退）', /新活動的名稱/.test(textOf(out)) && texts(out).includes('算了') && ENDS_HOME(out), JSON.stringify([textOf(out), texts(out)]));
  const before = state.events.length;
  out = await dm('U_c', '算了');
  check('　 回「算了」→ 不建，不會建出一場叫「算了」的活動', state.events.length === before && /先不建立/.test(textOf(out)), JSON.stringify(state.events.map((e) => e[1])));

  await dm('U_c', '新增活動');
  out = await dm('U_c', '氫能應用成果展');
  const created = state.events[state.events.length - 1];
  check('★ 打名稱 → 建好一場草稿（狀態 draft，名稱就是同仁打的）', state.events.length === before + 1 && created[1] === '氫能應用成果展' && created[4] === 'draft', JSON.stringify(created));
  check('★ 回覆附編輯頁連結（不需要後台密碼）、講明記者還看不到', new RegExp(`/edit\\?id=${created[0]}&code=${created[10]}`).test(textOf(out)) && /記者還看不到/.test(textOf(out)), textOf(out));
  check('　 按鈕：看這場／回同仁選單，沒有職員功能', texts(out).includes('氫能應用成果展') && ENDS_HOME(out) && !texts(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify(texts(out)));
  check('★ 通知管理員有同仁新增活動（朱朱「反正我後台可以看」＋事後通知）', sent.some((o) => o.to === 'U_admin' && o.push && /同仁新增了活動/.test(o.text) && /氫能應用成果展/.test(o.text)), JSON.stringify(sent.map((o) => [o.to, o.text])));
  const newId = created[0], newCode = created[10];

  // 修改：入口與活動卡
  out = await dm('U_c', '修改活動');
  check('★ 「修改活動」→ 列出活動讓他點（包含草稿與別人建的場次：所有場次都能改）', texts(out).includes('智慧醫療解決方案記者會') && texts(out).includes('氫能應用成果展') && ENDS_HOME(out), JSON.stringify(texts(out)));
  check('　 說明講的是能改哪五欄、其他用編輯頁', /名稱、日期、時間、地點、新聞聯絡人/.test(textOf(out)) && /編輯頁/.test(textOf(out)), textOf(out));

  out = await dm('U_c', '智慧醫療解決方案記者會');
  const card = textOf(out);
  check('★ 點活動名稱 → 活動卡：附「編輯頁」與「活動網頁」兩條連結', /\/edit\?id=med&code=code3/.test(card) && /\/event\?id=med/.test(card), card);
  check('　 卡上有還缺什麼、接著怎麼說', /還缺：/.test(card) && /接著直接說要改什麼/.test(card), card);
  check('　 卡上的按鈕：媒體訓練、修改活動、回同仁選單（沒有催填、數據）', texts(out).includes('訓練：智慧醫療解決方案記者會') && texts(out).includes('修改活動') && ENDS_HOME(out) && !texts(out).some((t) => STAFF_ONLY.test(t)), JSON.stringify(texts(out)));

  // 接著不講哪一場
  out = await dm('U_c', '地點改成南港展覽館');
  check('★ 活動卡剛顯示過 → 接著說「地點改成南港展覽館」不用再講是哪一場，先問確認（只有確認／取消兩顆）',
    /智慧醫療解決方案記者會/.test(textOf(out)) && /南港展覽館/.test(textOf(out)) && texts(out).length === 2 && texts(out).includes('✅ 確認修改'), JSON.stringify([textOf(out), texts(out)]));
  out = await dm('U_c', '✅ 確認修改');
  check('★ 確認 → 改好了', state.events.find((e) => e[0] === 'med')[12] === '南港展覽館', JSON.stringify(state.events.find((e) => e[0] === 'med')));
  check('★ 改完附網站連結：編輯頁＋活動網頁（這場已發布）', /已更新 ✅/.test(textOf(out)) && /\/edit\?id=med&code=code3/.test(textOf(out)) && /\/event\?id=med/.test(textOf(out)), textOf(out));
  check('　 修改紀錄留下來、通知管理員', (state.changes || []).length >= 1 && sent.some((o) => o.to === 'U_admin' && /活動資料被修改/.test(o.text)), JSON.stringify([state.changes, sent.map((o) => o.text)]));
  check('　 按鈕有「復原上一個修改」', texts(out).includes('復原上一個修改') && ENDS_HOME(out), JSON.stringify(texts(out)));
  out = await dm('U_c', '復原上一個修改');
  out = await dm('U_c', '✅ 確認修改');
  check('　 復原：地點改回原本的', state.events.find((e) => e[0] === 'med')[12] === '', JSON.stringify(state.events.find((e) => e[0] === 'med')));

  // 直接講哪一場；別人建的、別場都能改
  await fresh();
  out = await dm('U_c', '半導體那場時間改成下午兩點');
  out = await dm('U_c', '✅ 確認修改');
  check('★ 直接講「半導體那場時間改成⋯」→ 別人的場次也能改（所有場次都能改）', /已更新/.test(textOf(out)) && state.events.find((e) => e[0] === 'semi')[11] === '下午兩點', JSON.stringify(state.events.find((e) => e[0] === 'semi')));

  // 「改成活動中心」不能被當成「換一場」而跳回首頁
  out = await dm('U_c', '智慧醫療那場地點改成活動中心');
  check('★ 「地點改成活動中心」是在改資料，不是「換一場活動」（職員模式的 SWITCH 規則會誤判，同仁模式不吃那條）', /要把《智慧醫療解決方案記者會》的地點/.test(textOf(out)) && /活動中心/.test(textOf(out)), textOf(out));
  await dm('U_c', '✖ 取消修改');

  // 發布：新增的草稿必填沒齊 → 擋
  out = await dm('U_c', `發布：氫能應用成果展`);
  check('★ 發布：必填沒齊照樣擋（日期、地點、新聞聯絡人、新聞稿）——同仁自行發布也一樣', /還不能發布/.test(textOf(out)) && /地點/.test(textOf(out)) && /新聞稿/.test(textOf(out)) && state.events.find((e) => e[0] === newId)[4] === 'draft', textOf(out));
  check('　 被擋時的按鈕沒有「產生催填訊息」（同仁模式沒有催填）', !texts(out).some((t) => /催填/.test(t)) && ENDS_HOME(out), JSON.stringify(texts(out)));

  // 發布：必填齊了
  state.events.push(['rdy', '先進製程成果發表', '#0F9E7A', '【新聞稿】先進製程成果：良率提升與量產時程說明。', 'draft', isoOffset(10), '', '', '', '工研院', 'codeR', '', '南港展覽館', '', '王小明 0912-345-678', '', '', '']);
  await fresh(); // 活動列有快取
  out = await dm('U_c', '先進製程成果發表');
  check('　 草稿、必填齊了 → 活動卡出現「🚀 發布」；草稿沒有活動網頁連結（記者看不到，點開也是找不到）', texts(out).includes('發布：先進製程成果發表') && /\/edit\?id=rdy/.test(textOf(out)) && !/\/event\?id=rdy/.test(textOf(out)), JSON.stringify([texts(out), textOf(out)]));
  out = await dm('U_c', '發布：先進製程成果發表');
  check('★ 按發布 → 先確認（確認／取消兩顆）', /要發布《先進製程成果發表》嗎/.test(textOf(out)) && texts(out).length === 2 && texts(out).includes('🚀 確認發布'), JSON.stringify([textOf(out), texts(out)]));
  out = await dm('U_c', '🚀 確認發布');
  check('★ 確認 → 發布了（同仁可以自行發布）', state.events.find((e) => e[0] === 'rdy')[4] === 'active' && /已發布 ✅/.test(textOf(out)), JSON.stringify(state.events.find((e) => e[0] === 'rdy')));
  check('　 發布完附網站連結（這場現在公開了，附活動網頁）並通知管理員', /\/event\?id=rdy/.test(textOf(out)) && /\/edit\?id=rdy/.test(textOf(out)) && sent.some((o) => o.to === 'U_admin' && /先進製程成果發表/.test(o.text)), textOf(out));

  // 沒講哪一場的「發布」
  await fresh();
  out = await dm('U_c', '發布');
  check('　 只說「發布」沒講哪一場 → 問哪一場（列出活動）', /要發布哪一場/.test(textOf(out)) && ENDS_HOME(out), textOf(out));

  // 媒體訓練
  out = await dm('U_c', '媒體訓練');
  check('★ 「媒體訓練」→ 問哪一場', /要哪一場的媒體訓練連結/.test(textOf(out)) && texts(out).includes('智慧醫療解決方案記者會') && ENDS_HOME(out), JSON.stringify([textOf(out), texts(out)]));
  out = await dm('U_c', '智慧醫療解決方案記者會');
  check('★ 點活動 → 媒體訓練連結（不是活動卡）', /\/training\?id=med&code=code3/.test(textOf(out)) && !/還缺/.test(textOf(out)), textOf(out));
  out = await dm('U_c', '訓練：半導體先進封裝技術發表會');
  check('　 活動卡上的「🎤 媒體訓練」鈕 → 直接給連結', /\/training\?id=semi&code=code2/.test(textOf(out)), textOf(out));
  await fresh();
  out = await dm('U_c', '智慧醫療那場的媒體訓練連結');
  check('　 用講的「智慧醫療那場的媒體訓練連結」也行', /\/training\?id=med&code=code3/.test(textOf(out)), textOf(out));
}
delete process.env.LINE_ADMIN_USER_ID;

// ═══ 四、選單與按鈕 ═══════════════════════════════════════════════════════════
console.log('\n── 四、選單、按鈕、退出 ──');
{
  const def = buildRichMenuDefinition(COLLEAGUE_MENU);
  check('★ 同仁選單：三格排一列，小尺寸 2500×843，剛好鋪滿', def.size.width === 2500 && def.size.height === 843 && def.areas.length === 3
    && def.areas.reduce((n, a) => n + a.bounds.width * a.bounds.height, 0) === 2500 * 843, JSON.stringify(def.areas.map((a) => a.bounds)));
  check('　 三格送出的字：新增活動、修改活動、媒體訓練；名稱「同仁主選單」', JSON.stringify(def.areas.map((a) => a.action.text)) === JSON.stringify(['新增活動', '修改活動', '媒體訓練']) && def.name === '同仁主選單');
  check('　 其他選單照舊（記者、職員仍是大版 6 格）', buildRichMenuDefinition(STAFF_MENU).areas.length === 6 && ALL_MENUS.includes(COLLEAGUE_MENU));
  const png = readFileSync(new URL('../public/richmenu-colleague.png', import.meta.url));
  check('　 底圖 public/richmenu-colleague.png 存在、是 PNG、尺寸 2500×843（跟可點區域一致）', png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 2500 && png.readUInt32BE(20) === 843, `${png.length} bytes ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
}
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
{
  // 選單格子送出的字，每一個都要真的有反應（不是「這個我幫不上忙」）
  const bad = [];
  for (const b of COLLEAGUE_MENU.buttons) {
    await fresh();
    const out = await dm('U_c', b.text);
    if (/幫不上忙/.test(textOf(out)) || !textOf(out)) bad.push(`${b.label}：${textOf(out).slice(0, 60)}`);
  }
  check('★ 三格送出的字都認得（按了不會得到「幫不上忙」）', bad.length === 0, bad.join('\n   '));

  const steps = [['新增活動', 3], ['算了', 3], ['修改活動', 13], ['媒體訓練', 13], ['隨便聊聊', 5], ['使用說明', 5]];
  // 退出只出現在「選單／說明／聽不懂」，其他回覆（新增、修改、訓練）不掛，避免誤按
  const hasExit = (m) => ['隨便聊聊', '使用說明'].includes(m);
  const wrong = [];
  for (const [msg, max] of steps) {
    await fresh();
    const out = await dm('U_c', msg);
    if (!ENDS_HOME(out) || texts(out).length > max || texts(out).some((t) => STAFF_ONLY.test(t)) || (texts(out).includes('退出同仁模式') !== hasExit(msg))) wrong.push(`${msg}：${JSON.stringify(texts(out))}`);
  }
  check('★ 每則回覆：最後一顆都是「🏠 同仁選單」、沒有職員的按鈕', wrong.length === 0, wrong.join('\n   '));

  await fresh();
  let out = await dm('U_c', HOME);
  check('★ 按「🏠 同仁選單」→ 一句話＋三格＋使用說明＋退出同仁模式', texts(out).length === 5 && COLLEAGUE_MENU.buttons.every((b) => texts(out).includes(b.text)) && texts(out).includes('使用說明') && texts(out).includes('退出同仁模式') && textOf(out).split('\n').length <= 3, JSON.stringify([textOf(out), texts(out)]));
  for (const w of ['選單', '回首頁']) {
    out = await dm('U_c', w);
    check(`　 打「${w}」也是同仁選單`, texts(out).length === 5 && /要做什麼呢/.test(textOf(out)), JSON.stringify([textOf(out), texts(out)]));
  }
  await fresh();
  out = await dm('U_c', '使用說明');
  const help = textOf(out);
  check('★ 使用說明：四件事一件一行，不提 GEO、後台數據、教米亞、設定圖文選單', help.split('\n').filter((l) => l.startsWith('・')).length === 4 && /新增活動/.test(help) && /修改活動/.test(help) && /發布/.test(help) && /媒體訓練/.test(help) && !/GEO|後台數據|記住：|設定圖文選單/.test(help), help);
  check('★ 說明有「🚪 退出同仁模式」按鈕（回報：同仁模式沒有退出——以前只有文字寫了，沒有按鈕）；按下去真的退得出去', /退出同仁模式/.test(help) && texts(out).includes('退出同仁模式'), JSON.stringify(texts(out)));
}

reset(); state.staff.push(colleagueRow('U_c')); state.richMenus.push({ richMenuId: 'rm_col', name: '同仁主選單' }); state.linkedMenus.set('U_c', 'rm_col'); await fresh();
{
  let out = await dm('U_c', '退出同仁模式');
  check('★ 「退出同仁模式」→ 交回身分：line_staff 標 revoked（保留稽核紀錄）、解除同仁選單', state.staff[0][3] === 'revoked' && !state.linkedMenus.has('U_c') && /已退出同仁模式/.test(textOf(out)), JSON.stringify([state.staff, [...state.linkedMenus]]));
  check('　 退出後的按鈕是記者那一排（不是同仁的）', texts(out).includes('最近有哪些活動') && !texts(out).includes(HOME), JSON.stringify(texts(out)));
  await fresh();
  out = await dm('U_c', '修改活動');
  check('★ 退出之後同仁功能叫不到（又是一般記者）', !/要改哪一場/.test(textOf(out)), textOf(out));
  out = await dm('U_c', 'Jerry');
  check('★ 再用密語回來 → 改原本那一列、F 欄還是 colleague、不另外寫一列', state.staff.length === 1 && state.staff[0][3] === '' && state.staff[0][5] === 'colleague' && /同仁模式已啟用/.test(textOf(out)), JSON.stringify(state.staff));
}
reset(); state.staff.push(colleagueRow('U_c')); await fresh();
{
  const out = await dm('U_c', '退出職員模式');
  check('　 同仁手滑打「退出職員模式」也退得出去', state.staff[0][3] === 'revoked' && /已退出同仁模式/.test(textOf(out)), JSON.stringify(state.staff));
}

// 職員模式照舊（沒有被改壞）：職員還是看得到全部、選單還是六格
reset(); state.staff.push(staffRow('U_s')); await fresh();
{
  const out = await dm('U_s', '職員選單');
  check('★ 職員模式照舊：「職員選單」仍是六格＋使用說明，沒有同仁的按鈕', texts(out).length === 7 && STAFF_MENU.buttons.every((b) => texts(out).includes(b.text)) && !texts(out).includes(HOME), JSON.stringify(texts(out)));
  await fresh();
  const out2 = await dm('U_s', '智慧醫療那場地點改成南港展覽館');
  const out3 = await dm('U_s', '✅ 確認修改');
  check('　 職員改資料照舊：不附同仁那兩條網站連結、按鈕仍是職員選單', /已更新 ✅/.test(textOf(out3)) && !/完整編輯頁/.test(textOf(out3)) && texts(out3).includes('職員選單'), textOf(out3));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 138（同仁模式）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
