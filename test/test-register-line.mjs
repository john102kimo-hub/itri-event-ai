// 批次 88 的測試（LINE 那一半）：米亞的「我要報名」卡片、報名完成頁按鈕送來的「#報名 代碼」綁定、
// 加好友歡迎卡、報名期間的圖文選單。資料層與網頁 API 在 test-register.mjs。
// 跑的是真的 api/line.js、lib/registration.js；Sheets 是通用的假試算表、LINE 是 fakes.mjs 的假 LINE。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('./loader-reg.mjs', import.meta.url);

process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_BASIC_ID = '@mia123';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.CRON_SECRET = 'cronsecret';
process.env.LINE_ADMIN_USER_ID = 'Uadmin000001';

// 假時鐘：測試裡所有「現在」都固定在 2026-09-29 中午（台灣時間），離眺望 10/28 還有一個月。
// 不固定的話，過了 10/28 這些用 10/28、10/29 場次的測試會因為「場次辦完了」而自己壞掉。
let clock = Date.UTC(2026, 8, 29, 4, 0, 0);
Date.now = () => clock;
const setClock = (iso) => { clock = new Date(iso).getTime(); };

const F = await import('./fakes.mjs');
const { sent, state, line, reset: resetLine, installFetchStub } = F;
const S = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const { REPORTER_MENU, REPORTER_MENU_REG, REG_MENU_TILE, STAFF_MENU, detectMetaIntent, buildWelcomeFlex } = await import('../lib/menu.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

// 每個情境重新載入 api/line.js（連同它 import 的 lib/），清掉模組層的 60 秒快取
let handler, seq = 0;
async function fresh() {
  handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default;
}
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter();
  r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
async function fire(events) { sent.length = 0; await handler(req(events), res); return [...sent]; }
const msg = (text, userId = 'Ureporter0001') => ({ type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', text } });
const say = (text, userId) => fire([msg(text, userId)]);
const follow = (userId = 'Ureporter0001') => fire([{ type: 'follow', replyToken: 'rt_' + Math.random(), source: { type: 'user', userId } }]);
const groupSay = (text, groupId = 'Cgroup0001') => fire([{
  type: 'message', replyToken: 'rt_' + Math.random(), source: { type: 'group', groupId, userId: 'Uspeaker0001' },
  message: { type: 'text', text: '@米亞 ' + text, mention: { mentionees: [{ index: 0, length: 4, type: 'user', userId: 'Ubot', isSelf: true }] } }
}]);

// ── 假資料 ────────────────────────────────────────────────────────────
const SESSIONS = [
  'A1｜2026-10-28｜09:30-12:00｜開幕論壇暨專刊發表｜201 廳',
  'A2｜2026-10-28｜13:30-16:35｜通訊',
  'B1｜2026-10-29｜09:30-12:00｜全球AI競局'
].join('\n');
function campaignRow(over = {}) {
  return R.campaignToRow({
    id: 'tw2027', title: '眺望2027 產業發展趨勢研討會', status: 'open', intro: '', sessions_text: SESSIONS, options_text: '',
    privacy: '', contact: '', closes_at: '2099-12-31', line_pitch: '', created_at: '2026-09-29T10:00:00+08:00', updated_at: '', ...over
  });
}
function regRow(over = {}) {
  return R.regToRow({
    reg_id: 'RABCDE', campaign_id: 'tw2027', created_at: '2026-10-01T10:00:00+08:00', updated_at: '2026-10-01T10:00:00+08:00',
    name: '王小明', outlet: '經濟日報', email: 'wang@example.com', phone: '0912345678', sessions: ['A1', 'B1'], options: {},
    line_user_id: '', edit_token: 'tok_' + 'x'.repeat(20), status: 'active', source: 'web', note: '', bound_at: '', ...over
  });
}
const EVENT_HEADER = ['id', 'name', 'color', 'knowledge_base', 'status', 'created_at', 'chips', 'images', 'greeting', 'organizer', 'edit_code', 'event_time', 'venue', 'event_type', 'press_contact', 'contacts', 'invite_letter', 'invite_letter_chips'];
function seed({ campaigns = [], regs = [] } = {}) {
  S.reset(); resetLine();
  S.book.events = [EVENT_HEADER, ['quad', '經濟部四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】四足機器人…', 'active', '2099-08-08', '', '', '', '工研院', 'code1']];
  S.book.line_users = [['line_user_id', 'event_id', 'media_name', 'bound_at', 'last_active', 'note', 'group_session_until', 'last_topic', 'last_turn', 'group_turns']];
  S.book.reg_campaigns = [R.CAMPAIGN_HEADERS, ...campaigns];
  S.book.registrations = [R.REG_HEADERS, ...regs];
}
// 註冊之外的任何 AI 呼叫都算錯：報名這幾條路是固定程式回覆
let aiCalls = 0;
function guardAi() {
  aiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) { aiCalls++; throw new Error('報名流程不該呼叫 AI'); }
    throw new Error('unexpected fetch ' + url);
  };
}
const flexOf = (out) => out.find((o) => o.kind === 'flex')?.messages?.[0];
const bubblesOf = (flex) => (flex?.contents?.type === 'carousel' ? flex.contents.contents : [flex?.contents]).filter(Boolean);
const uriOf = (bubble) => bubble?.footer?.contents?.[0]?.action?.uri || '';
const labelOf = (bubble) => bubble?.footer?.contents?.[0]?.action?.label || '';
const paramsOf = (uri) => Object.fromEntries(new URL(uri).searchParams);
const bookRegs = () => S.book.registrations.slice(1);

// ═══ 一、意圖判斷 ═════════════════════════════════════════════════════
console.log('\n── 一、哪些話算「要報名入口」 ──');
for (const t of ['我要報名', '報名', '媒體報名', '怎麼報名', '如何報名', '報名連結', '我的報名', '查報名', '修改報名', '取消報名', '我報名了嗎', '眺望2027報名', '可以報名嗎？']) {
  check(`「${t}」→ register`, detectMetaIntent(t) === 'register', detectMetaIntent(t));
}
for (const t of ['報名費用多少', '報名截止是什麼時候', '以後會開放報名嗎？', '這場需要報名嗎', '我要報名費用', '怎麼報名才能拿到新聞稿', '報名人數有限制嗎']) {
  check(`「${t}」是真的提問，不攔（交給問答）`, detectMetaIntent(t) !== 'register', detectMetaIntent(t));
}
check('報名版選單那一格送出的字一定認得（不然就是按了沒反應）', detectMetaIntent(REG_MENU_TILE.text) === 'register' && REPORTER_MENU_REG.buttons.some((b) => b.text === REG_MENU_TILE.text));
check('報名版只換掉一格（回首頁 → 報名），其他五格跟原本一模一樣',
  REPORTER_MENU_REG.buttons.length === 6 && REPORTER_MENU_REG.buttons.filter((b, i) => b.text !== REPORTER_MENU.buttons[i].text).length === 1 &&
  REPORTER_MENU_REG.buttons.map((b) => b.label).join('/') === '最近有哪些活動/眺望研討會報名/想問什麼技術/新聞稿全文/產業趨勢分析/媒體邀訪需求');
check('★ 選單那一格寫明是哪個活動的報名（不是籠統的「媒體報名」——記者不知道報什麼）',
  /眺望/.test(REG_MENU_TILE.label) && /報名/.test(REG_MENU_TILE.label) && /10\/28/.test(REG_MENU_TILE.sub) && REG_MENU_TILE.label !== '媒體報名', JSON.stringify(REG_MENU_TILE));
{
  // 底圖每格約 833px 寬：標題 92px 字（全形一字約 94px）→ 最多 8 個全形字；副標 52px 字 → 最多約 15 個全形字（抓 12 留邊）。半形字算半個。
  const width = (str) => [...str].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2000 ? 0.5 : 1), 0);
  check('選單那一格的字塞得進圖上的格子（標題 ≤ 8 個全形字寬、副標 ≤ 12）', width(REG_MENU_TILE.label) <= 8 && width(REG_MENU_TILE.sub) <= 12, `${width(REG_MENU_TILE.label)} / ${width(REG_MENU_TILE.sub)}`);
}
check('報名版的名稱與原本的不同（LINE 那邊用名稱找選單）', REPORTER_MENU_REG.name !== REPORTER_MENU.name && REPORTER_MENU_REG.key !== REPORTER_MENU.key);
check('歡迎卡沒開報名時完全不變（2 顆按鈕）', buildWelcomeFlex().contents.footer.contents.length === 2);
{
  const w = buildWelcomeFlex('', { registration: true });
  const texts = w.contents.footer.contents.map((b) => b.action.text);
  check('歡迎卡開報名時多一顆，而且排第一、是主按鈕', JSON.stringify(texts) === JSON.stringify(['我要報名', '最近有哪些活動', '使用說明']) && w.contents.footer.contents[0].style === 'primary' && w.contents.footer.contents[1].style === 'secondary');
  for (const t of texts) check(`歡迎卡按鈕「${t}」認得`, detectMetaIntent(t) !== null);
  check('歡迎卡沒有簡稱時，按鈕寫「活動報名（1 分鐘）」', w.contents.footer.contents[0].action.label === '📝 活動報名（1 分鐘）', w.contents.footer.contents[0].action.label);
  const w2 = buildWelcomeFlex('', { registration: R.welcomeButtonLabel({ short_name: '眺望2027場次' }) });
  check('★ 歡迎卡有簡稱時，按鈕寫明活動（送出的字還是「我要報名」）',
    w2.contents.footer.contents[0].action.label === '📝 眺望2027場次報名（1 分鐘）' && w2.contents.footer.contents[0].action.text === '我要報名', JSON.stringify(w2.contents.footer.contents[0].action));
}
check('registrationLabel：有簡稱＝簡稱＋報名、沒有＝活動報名、只有空白也算沒有',
  R.registrationLabel({ short_name: '眺望2027場次' }) === '眺望2027場次報名' && R.registrationLabel({}) === '活動報名' && R.registrationLabel({ short_name: '   ' }) === '活動報名' && R.registrationLabel(null) === '活動報名');
{
  // LINE 按鈕文字上限 20 字：簡稱最長 16 字，加上「📝 」「報名」「（1 分鐘）」會超過——超過就拿掉「（1 分鐘）」，不能送出去被 LINE 退件
  const long = R.welcomeButtonLabel({ short_name: '一二三四五六七八九十一二三四五六' });
  check('★ 簡稱很長時按鈕字數不超過 LINE 的 20 字上限（連 UTF-16 長度都不超過）、結尾還是完整的「報名」', long.length <= 20 && long.endsWith('報名') && long.startsWith('📝 一二三'), `${long} (${long.length})`);
  const edge = R.welcomeButtonLabel({ short_name: '一二三四五六七八九十一二三' });   // 13 字：加「（1 分鐘）」會超過 20，拿掉之後剛好放得下
  check('簡稱中等長度 → 只拿掉「（1 分鐘）」，簡稱完整保留', edge === '📝 一二三四五六七八九十一二三報名', edge);
  check('簡稱長度上限 16 字（超過的截掉）', R.campaignFromRow(campaignRow({ short_name: '一二三四五六七八九十一二三四五六七八九十' })).short_name.length === 16);
}

// ═══ 二、沒有報名可講：米亞的行為跟以前完全一樣 ═══════════════════════
console.log('\n── 二、沒有開放中的報名 → 「報名」照原本的路徑走（上線後沒開活動＝零行為改變）──');
// 日期一律相對今天算：「剛截止一週內才攔」的判斷用真實時鐘，寫死日期過幾個月測試就會自己壞掉
const ymd = (days) => new Date(Date.now() + days * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const sessionsAround = (days) => `Z1｜${ymd(days)}｜09:00-11:00｜測試場次`;
seed(); guardAi(); await fresh();
{
  let out = await follow();
  check('加好友：歡迎卡照舊只有 2 顆按鈕', out[0]?.kind === 'flex' && out[0].messages[0].contents.footer.contents.length === 2);
  out = await say('我要報名');
  check('★ 一個報名活動都沒有 → 不攔：不回「目前沒有開放報名」、不回卡片，交給原本的路徑（這裡是路由，所以有去問 AI）',
    !/目前沒有開放報名/.test(out[0]?.text || '') && !flexOf(out) && aiCalls >= 1, JSON.stringify(out).slice(0, 300) + ' ai=' + aiCalls);
  aiCalls = 0;
  out = await say('怎麼報名', 'Ubound000001');
  check('「怎麼報名」也一樣照舊', !/目前沒有開放報名/.test(out[0]?.text || '') && !flexOf(out));
}
seed({ campaigns: [campaignRow({ status: 'draft', id: 'draftone', title: '草稿' })] }); guardAi(); await fresh();
{
  const out = await say('我要報名');
  check('★ 只有草稿 → 對記者等於沒有，不攔、不外露草稿的存在', !/草稿|測試/.test(JSON.stringify(out)) && !flexOf(out) && aiCalls >= 1);
}
seed({ campaigns: [campaignRow({ id: 'long-ago', title: '早就辦完的活動', status: 'closed', sessions_text: sessionsAround(-30) })] }); guardAi(); await fresh();
{
  const out = await say('我要報名');
  check('★ 已截止而且最後一場是一個月前 → 不再攔（不會永遠回「已截止」）', !/已經截止/.test(out[0]?.text || '') && !flexOf(out) && aiCalls >= 1);
}
seed({ campaigns: [campaignRow({ id: 'just-shut', title: '剛截止的活動', status: 'closed', sessions_text: sessionsAround(+3), contact: '工研院行銷傳播處 朱則瑋\nitriA70541@itri.org.tw\n0934-267-766' })] }); guardAi(); await fresh();
{
  const out = await say('我要報名');
  check('剛截止（場次還沒辦）→ 老實說已截止，附上活動聯絡人', out[0]?.kind === 'text' && /《剛截止的活動》的報名已經截止了/.test(out[0].text) && /朱則瑋/.test(out[0].text) && /0934-267-766/.test(out[0].text), JSON.stringify(out));
  check('這則是固定程式回覆：不呼叫 AI、帶整排按鈕', aiCalls === 0 && out[0].quickReply.length >= 5);
}
seed({ campaigns: [campaignRow({ id: 'late', title: '過了截止時間的活動', status: 'open', closes_at: '2020-01-01', sessions_text: sessionsAround(+3), contact: '' })] }); guardAi(); await fresh();
{
  const out = await say('我要報名');
  check('狀態還是 open 但過了截止時間 → 也是「已截止」；沒填聯絡人就請他打「找真人」', /已經截止了/.test(out[0]?.text || '') && /找真人/.test(out[0]?.text || ''), JSON.stringify(out));
}
seed({ campaigns: [campaignRow()] });
S.ctl.failReads.add('reg_campaigns'); guardAi(); await fresh();
{
  const f = await follow();
  check('★ 報名資料表讀不到時，新記者照樣收到歡迎卡（報名是加分，不能拖垮加好友）', f[0]?.kind === 'flex', JSON.stringify(f));
  const out = await say('我要報名');
  check('★ 讀不到時「我要報名」也不炸，當作沒有報名、照原本的路徑走', out.length >= 1 && !flexOf(out) && !/已經截止/.test(out[0]?.text || ''), JSON.stringify(out));
  S.ctl.failReads.clear();
}

// ═══ 三、有開放中的報名 ═══════════════════════════════════════════════
console.log('\n── 三、「我要報名」卡片 ──');
seed({ campaigns: [campaignRow()] }); guardAi(); await fresh();
const UID = 'Ureporter0001';
{
  let out = await follow();
  const btn = out[0].messages[0].contents.footer.contents.map((b) => b.action.text);
  check('加好友：歡迎卡多了「我要報名」，排第一', btn[0] === '我要報名' && btn.length === 3, JSON.stringify(btn));

  out = await say('我要報名', UID);
  const flex = flexOf(out);
  check('回一張 Flex 卡片（不是在聊天室一題一題問）', flex?.type === 'flex' && bubblesOf(flex).length === 1, JSON.stringify(out).slice(0, 300));
  const b = bubblesOf(flex)[0];
  const uri = uriOf(b);
  check('按鈕是開網頁（uri），標題是「填寫報名表」', b.footer.contents[0].action.type === 'uri' && labelOf(b) === '填寫報名表');
  check('網址指向報名頁與這個活動', uri.startsWith('https://itri-event-ai.vercel.app/register?') && paramsOf(uri).c === 'tw2027', uri);
  check('★ 網址帶著簽章過的 LINE 身分，而且驗得回同一個人', R.verifyLineToken(paramsOf(uri).u) === UID, uri);
  check('網址不含原始 userId 明文以外的個資、沒有編輯碼', !('t' in paramsOf(uri)) && uri.length < 1000, String(uri.length));
  check('卡片上有活動名稱、日期範圍與場數', JSON.stringify(b.header).includes('眺望2027') && JSON.stringify(b.header).includes('10/28（三） – 10/29（四）') && JSON.stringify(b.header).includes('共 3 場'), JSON.stringify(b.header));
  check('altText 是一句有用的話（鎖定畫面只看得到這行）', /活動報名/.test(flex.altText) && flex.altText.length < 400);
  check('卡片小標沒有簡稱時是「📝 活動報名」', JSON.stringify(b.header).includes('📝 活動報名'), JSON.stringify(b.header));
  check('卡片底下掛著整排導覽按鈕', (flex.quickReply?.items || []).length >= 5);
  check('繁體字：卡片文字沒有簡體字', !/[们这们个报么对话]/.test(JSON.stringify(flex)));
  check('不呼叫 AI', aiCalls === 0);
  check('沒寫入任何報名資料（點卡片才是開始填）', bookRegs().length === 0);
}
{
  for (const t of ['報名', '怎麼報名', '我的報名']) {
    const out = await say(t, UID);
    check(`打「${t}」得到同一張卡片`, bubblesOf(flexOf(out)).length === 1 && paramsOf(uriOf(bubblesOf(flexOf(out))[0])).c === 'tw2027');
  }
  const other = await say('我要報名', 'Uother000001');
  const uOther = paramsOf(uriOf(bubblesOf(flexOf(other))[0])).u;
  check('★ 不同人拿到的簽章不同、各自驗得回自己', R.verifyLineToken(uOther) === 'Uother000001' && uOther !== paramsOf(uriOf(bubblesOf(flexOf(await say('我要報名', UID)))[0])).u);
}
console.log('\n── 三之一、後台填了「LINE 簡稱」→ 歡迎卡與卡片都寫明是哪個活動 ──');
seed({ campaigns: [campaignRow({ short_name: '眺望2027場次' })] }); guardAi(); await fresh();
{
  const out = await follow();
  const first = out[0].messages[0].contents.footer.contents[0];
  check('★ 加好友：歡迎卡最上面那顆寫「📝 眺望2027場次報名（1 分鐘）」', first.action.label === '📝 眺望2027場次報名（1 分鐘）' && first.action.text === '我要報名', JSON.stringify(first.action));
  const card = flexOf(await say('我要報名', UID));
  check('★ 卡片小標寫「📝 眺望2027場次報名」', JSON.stringify(bubblesOf(card)[0].header).includes('📝 眺望2027場次報名'), JSON.stringify(bubblesOf(card)[0].header));
  check('簡稱只換字：按鈕、網址、活動名稱都沒變', labelOf(bubblesOf(card)[0]) === '填寫報名表' && paramsOf(uriOf(bubblesOf(card)[0])).c === 'tw2027' && JSON.stringify(bubblesOf(card)[0].header).includes('眺望2027 產業發展趨勢研討會'));
  check('沒寫入任何報名資料', bookRegs().length === 0);
}
seed({ campaigns: [campaignRow({ short_name: '眺望2027場次' }), campaignRow({ id: 'other', title: '另一場說明會', short_name: '另一場' })] }); guardAi(); await fresh();
{
  const out = await follow();
  const first = out[0].messages[0].contents.footer.contents[0];
  check('兩個活動同時開放 → 歡迎卡用通用的「活動報名（1 分鐘）」（不偏袒其中一個）', first.action.label === '📝 活動報名（1 分鐘）', JSON.stringify(first.action));
}
console.log('\n── 三之一之一、後台填了「活動地點」→ 卡片標題下方寫 📍 地點（批次 92，同仁反饋） ──');
seed({ campaigns: [campaignRow({ venue: '○○會議中心' })] }); guardAi(); await fresh();
{
  const card = flexOf(await say('我要報名', UID));
  const header = bubblesOf(card)[0].header.contents;
  check('★ 卡片標題區有「📍 ○○會議中心」', header.some((c) => c.text === '📍 ○○會議中心'), JSON.stringify(header));
  check('地點排在日期那一行後面（標題、日期、地點的順序）', header.map((c) => c.text).join('|').match(/共 \d+ 場.*📍/) !== null, JSON.stringify(header.map((c) => c.text)));
  check('地點只是多一行：按鈕、網址、場次數都沒變', labelOf(bubblesOf(card)[0]) === '填寫報名表' && paramsOf(uriOf(bubblesOf(card)[0])).c === 'tw2027' && JSON.stringify(header).includes('共 3 場'));
  check('地點是後台填的固定文字，卡片不呼叫 AI', aiCalls === 0, aiCalls);
}
seed({ campaigns: [campaignRow()] }); guardAi(); await fresh();
{
  const header = bubblesOf(flexOf(await say('我要報名', UID)))[0].header.contents;
  check('沒填地點 → 卡片跟以前一模一樣（不顯示空的 📍，也不亂補）', !JSON.stringify(header).includes('📍') && header.length === 3, JSON.stringify(header.map((c) => c.text)));
}
seed({ campaigns: [campaignRow({ venue: '○○會議中心' })], regs: [regRow({ line_user_id: UID, bound_at: '2026-10-01T10:05:00+08:00' })] }); guardAi(); await fresh();
{
  const b = bubblesOf(flexOf(await say('我要報名', UID)))[0];
  check('已報名的人看到的卡片也有地點（同一個標題區）', b.header.contents.some((c) => c.text === '📍 ○○會議中心') && labelOf(b) === '修改我的報名');
}
{
  const camp = R.campaignFromRow(campaignRow({ venue: '○○會議中心' }));
  const txt = R.buildRegistrationText([camp], [], { userId: '' });
  check('純文字版（卡片送不出去時）也帶地點', txt.includes('📍 ○○會議中心') && txt.indexOf('📍') > txt.indexOf(camp.title), txt);
  check('純文字版沒填地點 → 沒有 📍', !R.buildRegistrationText([R.campaignFromRow(campaignRow())], [], { userId: '' }).includes('📍'));
  check('欄位上限 60 字（超過的截掉）', R.campaignFromRow(campaignRow({ venue: '一二三四五六七八九十'.repeat(8) })).venue.length === 60);
}
console.log('\n── 三之二、兩個活動同時開放 → 輪播卡片 ──');
seed({ campaigns: [campaignRow(), campaignRow({ id: 'other', title: '另一場說明會' })] }); await fresh();
{
  const out = await say('我要報名', UID);
  const bs = bubblesOf(flexOf(out));
  check('每個活動一張', bs.length === 2 && flexOf(out).contents.type === 'carousel');
  check('各自指向自己的活動', paramsOf(uriOf(bs[0])).c === 'tw2027' && paramsOf(uriOf(bs[1])).c === 'other');
}

// ═══ 四、已連結報名的人 ═══════════════════════════════════════════════
console.log('\n── 四、已經連結報名的人再打「我要報名」 ──');
seed({ campaigns: [campaignRow()], regs: [regRow({ line_user_id: UID, bound_at: '2026-10-01T10:05:00+08:00' })] }); await fresh();
{
  const out = await say('我要報名', UID);
  const b = bubblesOf(flexOf(out))[0];
  const text = JSON.stringify(b.body);
  check('顯示「您已報名 2 場」與場次內容', text.includes('您已報名 2 場') && text.includes('A1 10/28（三）09:30-12:00 開幕論壇暨專刊發表') && text.includes('B1 10/29（四）'), text);
  check('按鈕變成「修改我的報名」', labelOf(b) === '修改我的報名');
  const p = paramsOf(uriOf(b));
  check('★ 連結帶編輯碼（打開就是修改模式）、不再帶 LINE 簽章', p.t === 'tok_' + 'x'.repeat(20) && !('u' in p), uriOf(b));
  const stranger = await say('我要報名', 'Ustranger001');
  check('★ 別的 LINE 帳號看不到這個人的報名', !JSON.stringify(flexOf(stranger)).includes('您已報名') && !JSON.stringify(flexOf(stranger)).includes('tok_'));
}
seed({ campaigns: [campaignRow()], regs: [regRow({ line_user_id: UID, status: 'cancelled' })] }); await fresh();
{
  const out = await say('我要報名', UID);
  check('已取消的報名不再顯示成「已報名」，回到「填寫報名表」', labelOf(bubblesOf(flexOf(out))[0]) === '填寫報名表');
}

// ═══ 五、報名完成頁按「用 LINE 連結我的報名」→ #報名 代碼 ═══════════════
console.log('\n── 五、#報名 代碼 綁定 ──');
seed({ campaigns: [campaignRow()], regs: [regRow()] }); guardAi(); await fresh();
{
  let out = await say('#報名 RABCDE', UID);
  check('綁定成功：回確認，列出姓名／媒體／場次', out[0]?.kind === 'text' && /已連結您的報名 ✅/.test(out[0].text) && /王小明｜經濟日報/.test(out[0].text) && /A1 10\/28（三）09:30-12:00 開幕論壇暨專刊發表/.test(out[0].text), JSON.stringify(out));
  check('★ 不會被當成活動代碼（沒有「找不到活動」那類回覆）', !/找不到|沒有這場|活動代碼/.test(out[0]?.text || ''));
  check('那一列寫進了 LINE userId 與綁定時間', bookRegs()[0][10] === UID && /^\d{4}-/.test(bookRegs()[0][15]));
  const lu = S.book.line_users.find((r) => r[0] === UID);
  check('自報的媒體名稱同時記進 line_users（之後米亞不用再問「貴媒體名稱」）', lu && lu[2] === '經濟日報', JSON.stringify(S.book.line_users));
  check('回覆帶整排按鈕', out[0].quickReply.length >= 5);
  out = await say('＃報名 rabcde', UID);
  check('再送一次（全形井號、小寫）→ 「早就連結好了」，不重複寫', /早就連結好了/.test(out[0]?.text || '') && bookRegs().length === 1);
  out = await say('#報名 RABCDE', 'Uintruder001');
  check('★ 已被另一個 LINE 帳號連結 → 拒絕，原本的連結不變', /已經連結到另一個 LINE 帳號/.test(out[0]?.text || '') && bookRegs()[0][10] === UID, JSON.stringify(out));
  out = await say('#報名 RZZZZZ', 'Unew0000001');
  check('不存在的編號 → 白話指引', /找不到這個報名編號/.test(out[0]?.text || ''));
  check('不呼叫 AI', aiCalls === 0);
}
seed({ campaigns: [campaignRow()], regs: [regRow(), regRow({ reg_id: 'RSECON', email: 'b@x.com', name: '李大華' })] }); await fresh();
{
  await say('#報名 RABCDE', UID);
  const out = await say('#報名 RSECON', UID);
  check('同一個 LINE 帳號在同一個活動只能連結一筆', /已經連結另一筆報名（王小明）/.test(out[0]?.text || '') && bookRegs()[1][10] === '', JSON.stringify(out));
}
seed({ campaigns: [campaignRow()], regs: [regRow({ status: 'cancelled' })] }); await fresh();
{
  const out = await say('#報名 RABCDE', UID);
  check('已取消的報名不能連結', /已經取消/.test(out[0]?.text || '') && bookRegs()[0][10] === '');
}
seed({ campaigns: [campaignRow()], regs: [regRow()] });
S.ctl.failReads.add('registrations'); await fresh();
{
  const out = await say('#報名 RABCDE', UID);
  check('★ 試算表暫時讀不到 → 白話道歉並指出路，不沉默', out[0]?.kind === 'text' && /暫時讀不到/.test(out[0].text) && /找真人/.test(out[0].text), JSON.stringify(out));
  S.ctl.failReads.clear();
}
console.log('\n── 五之二、一般 #活動代碼 不受影響 ──');
seed({ campaigns: [campaignRow()], regs: [regRow()] }); await fresh();
{
  const out = await say('#quad', UID);
  check('#quad 照舊接上那一場活動（不被報名綁定攔走）', /已為您接上/.test(out[0]?.text || ''), JSON.stringify(out));
  check('報名資料沒被動到', bookRegs()[0][10] === '');
  const out2 = await say('#報名', UID);
  check('只打「#報名」沒有代碼 → 走原本的流程，不當成綁定', bookRegs()[0][10] === '' && !/已連結您的報名/.test(out2[0]?.text || ''));
}

// ═══ 六、群組 ═════════════════════════════════════════════════════════
console.log('\n── 六、群組裡叫米亞報名 ──');
seed({ campaigns: [campaignRow()], regs: [regRow({ line_user_id: 'Uspeaker0001' })] }); guardAi(); await fresh();
{
  const out = await groupSay('我要報名');
  const b = bubblesOf(flexOf(out))[0];
  check('群組也接得住，回卡片', !!b && labelOf(b) === '填寫報名表', JSON.stringify(out).slice(0, 300));
  const uri = uriOf(b);
  check('★ 群組的連結不帶任何人的身分與編輯碼（全群組都看得到這張卡）', !('u' in paramsOf(uri)) && !('t' in paramsOf(uri)) && !JSON.stringify(flexOf(out)).includes('您已報名'), uri);
}

// ═══ 七、職員 ═════════════════════════════════════════════════════════
console.log('\n── 七、職員模式 ──');
seed({ campaigns: [campaignRow({ status: 'draft', id: 'test1', title: '測試用報名' })], regs: [] }); await fresh();
installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  let out = await say('我要報名', 'Ustaff000001');
  const b = bubblesOf(flexOf(out))[0];
  check('職員看得到草稿（測試中）的報名活動，才能上線前自己走一遍', !!b && JSON.stringify(b.header).includes('（測試中）'), JSON.stringify(out).slice(0, 300));
  check('連結指向那個草稿活動', paramsOf(uriOf(b)).c === 'test1');
  out = await say('#報名 RNOPE1', 'Ustaff000001');
  check('職員也能用 #報名 綁定（不會被送去職員 AI 路由）', /找不到這個報名編號/.test(out[0]?.text || ''), JSON.stringify(out));
  const reporter = await say('我要報名', 'Ureporter0009');
  check('同一個時間，一般記者仍然看不到草稿（沒有卡片、也不提測試）', !flexOf(reporter) && !/測試中|test1/.test(JSON.stringify(reporter)));
}

// ═══ 八、圖文選單依有沒有開放報名挑版本 ═══════════════════════════════
console.log('\n── 八、「設定圖文選單」：報名期間用報名版，結束後換回 ──');
let SYNC = null;   // 這一輪 api/line.js 用的那份 lib/richmenu-sync.js（同一個版本號才是同一個實例）
const loadSync = async () => { SYNC = await import(new URL(`../lib/richmenu-sync.js?v=${seq}`, import.meta.url).href); return SYNC; };
let rendered = [];
const stubRenderer = () => SYNC.__setRenderer(async (args) => { rendered.push(args); return Buffer.from('PNG-' + args.label); });
async function setupMenu({ render = true } = {}) {
  const created = [], defs = [];
  const uploaded = [];       // 去網站抓的底圖檔名
  const uploadedBytes = [];  // 實際上傳給 LINE 的內容
  let defaultId = null;
  rendered = [];
  if (render) stubRenderer(); else SYNC.__setRenderer(async () => { throw new Error('模擬畫圖失敗'); });
  const base = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/richmenu-')) { uploaded.push(String(url).split('/').pop()); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; }
    return base(url, o);
  };
  line.createRichMenu = async (def) => { created.push(def.name); defs.push(def); return 'rm_' + created.length; };
  line.uploadRichMenuImage = async (id, buf) => { uploadedBytes.push(String(buf)); return true; };
  line.setDefaultRichMenu = async (id) => { defaultId = id; return true; };
  const out = await say('設定圖文選單', 'Ustaff000001');
  globalThis.fetch = base;
  return { created, defs, uploaded, uploadedBytes, defaultId, text: out[0]?.text || '' };
}
seed({ campaigns: [campaignRow()] }); await fresh(); await loadSync(); installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  F.state.richMenus.length = 0;
  const r = await setupMenu();
  check('有開放中的報名 → 建的是「報名版」（名稱帶活動代碼）＋職員版', r.created.join('|') === `${REPORTER_MENU_REG.name}｜tw2027|${STAFF_MENU.name}`, r.created.join('|'));
  check('★ 報名格的字是同步當下畫上去的：記者版底圖是畫出來的那張，職員版才是去網站抓的固定圖', r.uploadedBytes[0] === 'PNG-活動報名' && r.uploaded.join('|') === 'richmenu-staff.png', JSON.stringify([r.uploadedBytes, r.uploaded]));
  check('報名版設為預設選單（所有記者）', r.defaultId === 'rm_1');
  check('完成訊息寫明這次裝的是報名版，並列出報名那一格的名稱', /（報名版）/.test(r.text) && r.text.includes('・活動報名') && !/⚠️/.test(r.text), r.text);
}
seed({ campaigns: [campaignRow({ status: 'closed' })] }); await fresh(); await loadSync(); installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  const r = await setupMenu();
  check('報名結束後再設定一次 → 換回原本那套', r.created.join('|') === `${REPORTER_MENU.name}|${STAFF_MENU.name}` && r.uploaded[0] === 'richmenu-reporter.png', r.created.join('|'));
  check('完成訊息沒有「報名版」字樣', !/（報名版）/.test(r.text));
}

// ═══ 九、報名結束後，圖文選單自動換回（Vercel Cron）════════════════════
console.log('\n── 九、報名結束後圖文選單自動換回 ──');
function cronRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  r.setHeader = () => r;
  return r;
}
async function runCron(headers = { authorization: 'Bearer cronsecret' }) {
  const created = [], uploaded = [];
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/richmenu-')) { uploaded.push(String(url).split('/').pop()); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; }
    return baseFetch(url, o);
  };
  line.createRichMenu = async (def) => { created.push(def.name); return 'rm_new' + created.length; };
  line.uploadRichMenuImage = async () => true;
  line.setDefaultRichMenu = async () => true;
  sent.length = 0;
  const res = cronRes();
  await handler({ method: 'GET', query: { action: 'cron_menu' }, headers }, res);
  globalThis.fetch = baseFetch;
  return { res, created, uploaded, pushes: sent.filter((x) => x.push) };
}
const installedMenus = (regVariant) => {
  F.state.richMenus.length = 0;
  F.state.richMenus.push({ richMenuId: 'rm_r', name: (regVariant ? REPORTER_MENU_REG : REPORTER_MENU).name }, { richMenuId: 'rm_s', name: STAFF_MENU.name });
};
{
  seed({ campaigns: [campaignRow({ status: 'closed' })] }); await fresh(); guardAi(); installedMenus(true);
  const r = await runCron();
  check('★ 報名已結束、目前裝的是報名版 → 自動換回原本那套（記者版＋職員版一起重建）',
    r.res.statusCode === 200 && r.res.body?.action === 'reverted' && r.created.join('|') === `${REPORTER_MENU.name}|${STAFF_MENU.name}` && r.uploaded.join('|') === 'richmenu-reporter.png|richmenu-staff.png', JSON.stringify([r.res.body, r.created, r.uploaded]));
  check('換的那天推一則給管理員（不是給記者）', r.pushes.length === 1 && r.pushes[0].to === 'Uadmin000001' && /自動換回/.test(r.pushes[0].text), JSON.stringify(r.pushes));
  check('不呼叫 AI', aiCalls === 0);
}
{
  seed({ campaigns: [campaignRow()] }); await fresh(); installedMenus(true);
  const r = await runCron();
  check('★ 報名還開著 → 什麼都不動、不推播', r.res.body?.action === 'skip' && /還有開放中/.test(r.res.body.why) && r.created.length === 0 && r.pushes.length === 0, JSON.stringify(r.res.body));
}
{
  seed({ campaigns: [campaignRow({ status: 'closed' })] }); await fresh(); installedMenus(false);
  const r = await runCron();
  check('目前本來就是原版 → 什麼都不動（每天跑一次不會每天重建選單）', r.res.body?.action === 'skip' && /不是報名版/.test(r.res.body.why) && r.created.length === 0 && r.pushes.length === 0, JSON.stringify(r.res.body));
}
{
  seed({ campaigns: [campaignRow()] }); await fresh(); installedMenus(true);
  // 沒設截止時間、狀態還是 open，但最後一場（10/29）辦完了 → 自動關 → 選單換回
  setClock('2026-10-30T09:00:00+08:00');
  const r = await runCron();
  check('★ 狀態還是 open、但所有場次都辦完了 → 也算結束，選單換回（不用有人記得去改狀態）', r.res.body?.action === 'reverted', JSON.stringify(r.res.body));
  setClock('2026-09-29T12:00:00+08:00');
}
{
  seed({ campaigns: [campaignRow({ status: 'closed' })] }); await fresh(); installedMenus(true);
  const noHeader = await runCron({});
  const wrong = await runCron({ authorization: 'Bearer nope' });
  check('沒帶／帶錯 CRON_SECRET → 401，選單完全沒動', noHeader.res.statusCode === 401 && wrong.res.statusCode === 401 && noHeader.created.length + wrong.created.length === 0);
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  const unset = await runCron({ authorization: 'Bearer ' });
  process.env.CRON_SECRET = saved;
  check('連 CRON_SECRET 都沒設定 → 一律拒絕（這個入口會動到 LINE 帳號的選單）', unset.res.statusCode === 401 && unset.created.length === 0);
}
{
  seed({ campaigns: [campaignRow()] }); await fresh(); installedMenus(true);
  S.ctl.failReads.add('reg_campaigns');
  const r = await runCron();
  check('★ 試算表暫時讀不到 → 500、什麼都不換（不能把「讀不到」當成「報名結束」）', r.res.statusCode === 500 && r.created.length === 0 && r.pushes.length === 0, JSON.stringify([r.res.statusCode, r.res.body]));
  S.ctl.failReads.clear();
}
{
  // 沒設 LINE token（例如預覽環境）：靜靜跳過
  seed({ campaigns: [campaignRow({ status: 'closed' })] }); await fresh(); installedMenus(true);
  const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN; delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const r = await runCron();
  process.env.LINE_CHANNEL_ACCESS_TOKEN = saved;
  check('沒有 LINE_CHANNEL_ACCESS_TOKEN → 跳過，不炸', r.res.statusCode === 200 && r.res.body?.action === 'skip' && r.created.length === 0);
}
{
  // GET 的其他用途仍然是 405（這支本來只收 LINE 的 POST）
  seed(); await fresh();
  const res = cronRes(); res.end = () => { res.statusCode = 405; return res; };
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  check('沒帶 action 的 GET 照舊 405', res.statusCode === 405);
}

// ═══ 批次 112：同時有多個活動 ════════════════════════════════════════
console.log('\n── 批次 112：同時兩個以上的活動，米亞要接得住 ──');
seed({ campaigns: [
  campaignRow({ id: 'a-one', title: '甲活動', short_name: '甲場次', status: 'closed', sessions_text: sessionsAround(+3), contact: '甲聯絡人 0911-111-111' }),
  campaignRow({ id: 'b-two', title: '乙活動', status: 'closed', sessions_text: sessionsAround(+4), contact: '' })
] }); guardAi(); await fresh();
{
  const out = await say('我要報名');
  const t = out[0]?.text || '';
  check('★ 兩個剛截止的活動 → 兩個都講（以前只講第一個，另一個的記者會以為沒有這場）', /《甲活動》的報名已經截止了/.test(t) && /《乙活動》的報名已經截止了/.test(t), t);
  check('有聯絡人的附聯絡人、沒有的統一請他打「找真人」', /甲聯絡人 0911-111-111/.test(t) && /找真人/.test(t), t);
  check('這則是固定程式回覆：不呼叫 AI', aiCalls === 0);
}
seed({ campaigns: [
  campaignRow({ short_name: '眺望2027場次' }),
  campaignRow({ id: 'other', title: '另一場說明會', short_name: '新品說明會' })
] }); guardAi(); await fresh();
{
  const out = await say('我要報名', UID);
  const bs = bubblesOf(flexOf(out));
  check('★ 兩個活動同時開放 → 一張卡片各一個活動（輪播），網址各帶各的代碼', bs.length === 2 && paramsOf(uriOf(bs[0])).c === 'tw2027' && paramsOf(uriOf(bs[1])).c === 'other', JSON.stringify(bs.map(uriOf)));
  check('每張卡片小標用各自的簡稱', JSON.stringify(bs[0].header).includes('📝 眺望2027場次報名') && JSON.stringify(bs[1].header).includes('📝 新品說明會報名'));
  for (const t of ['新品說明會報名', '眺望2027場次報名', '📝 新品說明會報名', '另一場說明會報名', '新品說明會報名連結', '新品說明會 報名']) {
    const o = await say(t, UID);
    check(`★ 打卡片上看到的「${t}」→ 報名卡片（不只眺望一個活動認得）`, !!flexOf(o) && aiCalls === 0, JSON.stringify(o).slice(0, 200) + ' ai=' + aiCalls);
  }
  aiCalls = 0;
  const q = await say('新品說明會報名費多少？', UID);
  check('★ 「簡稱＋報名費」是真正的提問 → 不被當成報名入口（照原本的路徑走）', !flexOf(q) && aiCalls >= 1, JSON.stringify(q).slice(0, 200) + ' ai=' + aiCalls);
}
{
  // 沒有「報名」兩個字的訊息，不必為了辨識報名多讀一次報名活動表（每則訊息都會經過這裡）
  seed({ campaigns: [campaignRow({ short_name: '眺望2027場次' })] }); guardAi(); await fresh();
  S.calls.length = 0;
  await say('哈囉', UID);
  check('★ 一般訊息不會去讀報名活動表（省 Sheets 讀取額度）', !S.calls.some((c) => /reg_campaigns/.test(c[1])), JSON.stringify(S.calls.filter((c) => /reg_campaigns/.test(c[1]))));
}
check('isCampaignRegisterPhrase：簡稱或活動名稱後面接「報名」才算；只有「報名」兩個字由 menu.js 處理',
  R.isCampaignRegisterPhrase('新品說明會報名', { short_name: '新品說明會' }) && R.isCampaignRegisterPhrase('新品 發表會 報名表', { title: '新品發表會' })
  && !R.isCampaignRegisterPhrase('報名', { short_name: '新品說明會' }) && !R.isCampaignRegisterPhrase('新品說明會', { short_name: '新品說明會' })
  && !R.isCampaignRegisterPhrase('新品說明會報名費', { short_name: '新品說明會' }) && !R.isCampaignRegisterPhrase('新品說明會報名', {}) && !R.isCampaignRegisterPhrase('新品說明會報名', null));

// ═══ 批次 113：後台挑哪一場、報名格寫那一場的名稱 ══════════════════════
console.log('\n── 批次 113：圖文選單的報名格綁哪一場 ──');
const bound = (id) => { F.state.richMenus.length = 0; F.state.richMenus.push({ richMenuId: 'rm_r', name: SYNC.regMenuName(id ? { id } : null) }, { richMenuId: 'rm_s', name: STAFF_MENU.name }); };
const ymd2 = (days) => new Date(Date.now() + days * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const futureSessions = `A1｜${ymd2(30)}｜09:30-12:00｜開幕論壇`;
seed({ campaigns: [campaignRow({ short_name: '眺望場次', sessions_text: futureSessions })] }); await fresh(); await loadSync(); installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  F.state.richMenus.length = 0;
  const r = await setupMenu();
  const t = r.defs[0].areas.find((a) => a.action.text === '我要報名');
  check('★ 只有一場開放 → 格子寫「簡稱＋報名」，副標是開始日期；送出的字仍是「我要報名」', rendered[0]?.label === '眺望場次報名' && /^\d+\/\d+ 起・選場次$/.test(rendered[0]?.sub) && t.action.label === '眺望場次報名', JSON.stringify([rendered, t]));
  check('畫圖用的格子範圍來自選單的可點區域（x=833、第一排）——圖與按鈕不會錯位', rendered[0]?.tile.x === 833 && rendered[0].tile.y === 0 && rendered[0].tile.width === 833 && rendered[0].tile.height === 843, JSON.stringify(rendered[0]?.tile));
}
seed({ campaigns: [campaignRow({ short_name: '眺望場次' }), campaignRow({ id: 'other', title: '另一場', short_name: '新品說明會' })] }); await fresh(); await loadSync(); installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  F.state.richMenus.length = 0;
  let r = await setupMenu();
  check('★ 兩場以上開放、沒指定綁哪一場 → 通用的「活動報名」，名稱沒帶活動代碼', rendered[0]?.label === '活動報名' && rendered[0]?.sub === '選場次・1 分鐘' && r.created[0] === REPORTER_MENU_REG.name, JSON.stringify([rendered[0], r.created]));
  bound('other');
  r = await setupMenu();
  check('★ 後台已經綁了其中一場、而且還開著 → 職員在 LINE 重設選單時沿用，不會被洗成通用格', rendered[0]?.label === '新品說明會報名' && r.created[0] === `${REPORTER_MENU_REG.name}｜other`, JSON.stringify([rendered[0], r.created]));
}
seed({ campaigns: [campaignRow()] }); await fresh(); await loadSync(); installFetchStub();
{
  await say('openseasame', 'Ustaff000001');
  F.state.richMenus.length = 0;
  const r = await setupMenu({ render: false });
  check('★ 畫圖壞了、職員在 LINE 打指令 → 退回固定的舊圖並寫明（不是整個失敗，選單照樣裝得起來）', r.created[0] === REPORTER_MENU_REG.name && r.uploaded.includes('richmenu-reporter-reg.png') && /⚠️/.test(r.text) && /固定的舊圖/.test(r.text), JSON.stringify([r.created, r.uploaded, r.text]));
}
// 排程：綁的那一場結束、別場還開著 → 改寫；綁的還開著 → 不動
seed({ campaigns: [campaignRow({ id: 'gone', status: 'closed', title: '結束的', sessions_text: sessionsAround(-3) }), campaignRow({ id: 'other', title: '另一場', short_name: '新品說明會' })] }); await fresh(); await loadSync(); installFetchStub();
{
  stubRenderer(); rendered = [];
  bound('gone');
  const r = await runCron();
  check('★ 報名格綁的那一場結束了、但還有別場開放 → 自動改寫成現在開著的那一場（不是留著一個已結束的活動名稱）', r.res.body?.action === 'resynced' && r.res.body.campaign_id === 'other' && r.created[0] === `${REPORTER_MENU_REG.name}｜other` && rendered[0]?.label === '新品說明會報名', JSON.stringify([r.res.body, r.created, rendered]));
  check('改寫的那天推一則給管理員', r.pushes.length === 1 && /已經結束/.test(r.pushes[0].text) && /新品說明會報名/.test(r.pushes[0].text), JSON.stringify(r.pushes));
  bound('other');
  const again = await runCron();
  check('綁的那一場還開著 → 什麼都不動（每天跑一次不會每天重建）', again.res.body?.action === 'skip' && again.created.length === 0 && again.pushes.length === 0, JSON.stringify(again.res.body));
}

// 後台 API（api/events.js 的 reg_admin_menu_*）
console.log('\n── 批次 113：後台的選單 API ──');
const eventsApi = (await import(new URL(`../api/events.js?v=${seq}`, import.meta.url).href)).default;
const adminCall = async (method, body, pw = 'pw') => {
  const r = { statusCode: 200, body: undefined, headers: {} };
  const res = { status(c) { r.statusCode = c; return res; }, json(o) { r.body = o; return res; }, end() { return res; }, send() { return res; }, setHeader() { return res; } };
  const headers = pw ? { 'x-admin-password': pw, 'x-forwarded-for': '10.9.9.9' } : { 'x-forwarded-for': '10.9.9.9' };
  await eventsApi(method === 'GET' ? { method, headers, query: body } : { method, headers, query: {}, body }, res);
  return r;
};
process.env.ADMIN_PASSWORD = 'pw';
seed({ campaigns: [campaignRow({ short_name: '眺望場次' }), campaignRow({ id: 'other', title: '另一場', short_name: '新品說明會' }), campaignRow({ id: 'drafty', title: '草稿', status: 'draft' }), campaignRow({ id: 'shut', title: '已截止', status: 'closed' })] }); guardAi();
{
  const SYNC2 = await import(new URL(`../lib/richmenu-sync.js?v=${seq}`, import.meta.url).href); // events.js 用的是同一個版本號
  SYNC2.__setRenderer(async (a) => { rendered.push(a); return Buffer.from('PNG-' + a.label); });
  const created = [];
  line.createRichMenu = async (def) => { created.push(def.name); return 'rm_a' + created.length; };
  line.uploadRichMenuImage = async () => true; line.setDefaultRichMenu = async () => true;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('/richmenu-') ? { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } : base(url, o));
  rendered = [];
  const noPw = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'other' }, '');
  check('★ 沒有管理員密碼 → 401，選單完全沒動', noPw.statusCode === 401 && created.length === 0 && (await adminCall('GET', { action: 'reg_admin_menu_status' }, '')).statusCode === 401);
  const bad = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'drafty' });
  const bad2 = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'shut' });
  const bad3 = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'nope' });
  check('★ 草稿與已截止的活動不能放到記者看得到的選單上（400）；不存在 → 404；都沒有建任何選單', bad.statusCode === 400 && bad2.statusCode === 400 && bad3.statusCode === 404 && created.length === 0, JSON.stringify([bad.body, bad2.body, bad3.body]));
  const ok = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'other' });
  check('★ 挑「新品說明會」按同步 → 畫圖、建報名版（名稱帶代碼）與職員版、成功', ok.statusCode === 200 && ok.body.success && ok.body.campaign_id === 'other' && ok.body.label === '新品說明會報名' && created.join('|') === `${REPORTER_MENU_REG.name}｜other|${STAFF_MENU.name}`, JSON.stringify([ok.body, created]));
  F.state.richMenus.length = 0; F.state.richMenus.push({ richMenuId: 'rm_a1', name: created[0] });
  const st = await adminCall('GET', { action: 'reg_admin_menu_status' });
  check('狀態：讀得出 LINE 上現在綁的是哪一場，並列出可選的開放中活動（不含草稿與已截止）', st.body.installed === true && st.body.campaign_id === 'other' && st.body.open.map((c) => c.id).join() === 'tw2027,other', JSON.stringify(st.body));
  const gen = await adminCall('POST', { action: 'reg_admin_menu_sync', c: '*' });
  check('c=* ＝ 通用的「活動報名」', gen.body.label === '活動報名' && gen.body.campaign_id === '', JSON.stringify(gen.body));
  created.length = 0;
  const rs = await adminCall('POST', { action: 'reg_admin_menu_reset' });
  check('換回一般選單 → 建的是原本那套（沒有報名格）', rs.body.success && created.join('|') === `${REPORTER_MENU.name}|${STAFF_MENU.name}`, JSON.stringify([rs.body, created]));
  created.length = 0;
  SYNC2.__setRenderer(async () => { throw new Error('模擬畫圖失敗'); });
  const fail = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'other' });
  check('★ 後台按同步時畫圖失敗 → 500 講明原因、選單完全沒動（不會用寫著別場的舊圖頂替）', fail.statusCode === 500 && /畫選單圖失敗，選單沒有動/.test(fail.body.error) && created.length === 0, JSON.stringify([fail.statusCode, fail.body, created]));
  const savedTok = process.env.LINE_CHANNEL_ACCESS_TOKEN; delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const noTok = await adminCall('POST', { action: 'reg_admin_menu_sync', c: 'other' });
  const stNo = await adminCall('GET', { action: 'reg_admin_menu_status' });
  process.env.LINE_CHANNEL_ACCESS_TOKEN = savedTok;
  check('沒設 LINE_CHANNEL_ACCESS_TOKEN → 同步回明確的錯誤；狀態回 configured:false，不炸', noTok.statusCode === 500 && /LINE_CHANNEL_ACCESS_TOKEN/.test(noTok.body.error) && stNo.body.configured === false, JSON.stringify([noTok.body, stNo.body]));
  globalThis.fetch = base;
}

console.log(`\n批次 88（LINE × 報名）測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
