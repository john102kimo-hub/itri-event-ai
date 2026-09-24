// 批次 85 的回歸測試：朱朱答應的三件事。
//   一、「最近有哪些活動」也列最近 30 天辦過的場次（清單與按鈕）
//   二、沒講哪一場就要完整新聞稿 → 反問哪一場，按鈕按下去直接給那一場
//   三、AI 叫不動（金鑰失效、額度用完）→ LINE 通知管理員，一小時最多一次
// 跑真的 api/line.js 與 lib/router.js（Sheets／LINE／Anthropic 用 test/fakes.mjs 的假版本）。
// ⚠️ 活動日期一律用「今天往前／往後幾天」算，寫死日期的話過一個月這份測試就會自己壞掉。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';

const { calendarQuickReplyItems, formatCalendarReply, buildCalendarCards } = await import('../lib/router.js');
const { isFatalAiError, resetAiAlertThrottle } = await import('../lib/ai-alert.js');

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b85=${++modSeq}`, import.meta.url).href)).default; }
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
async function g(gid, uid, text, { mention = false } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
const qrText = (i) => (typeof i === 'object' && i ? (i.text ?? i.label) : i);
const texts = (out) => out.filter((s) => s.kind === 'text');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ev = (id, name, status, date, kb = '【新聞稿】' + name + '的內容') =>
  [id, name, '#0F9E7A', kb, status, date, '', '', '', '工研院', 'c-' + id, '', '', '', '王小明 03-1111111', '', '', ''];
function seed() {
  reset();
  state.events = [
    ev('up5', '五天後的綠能論壇', 'active', day(5)),
    ev('past3', '晶鏈高峰論壇測試場', 'active', day(-3)),
    ev('past10', '十天前的院士授證典禮', 'ended', day(-10)),
    ev('past45', '一個半月前的舊發表會', 'ended', day(-45)),
    ev('nokb', '兩天前的僅基本資料場', 'active', day(-2), '')
  ];
}

// ═══ 一、最近辦過的場次 ════════════════════════════════════════════════════════
console.log('\n── 一、「最近有哪些活動」也列最近 30 天辦過的 ──');
seed(); await fresh();
{
  const out = await dm('Ucal', '最近有哪些活動');
  const t = texts(out)[0]?.text || '';
  const btn = (texts(out)[0]?.quickReply || []).map(qrText);
  check('清單有【近期活動】（五天後那場）', /【近期活動】[\s\S]*五天後的綠能論壇/.test(t), t);
  check('★ 清單有【最近辦過】，列出 3 天前與 10 天前的場次', /【最近辦過】[\s\S]*晶鏈高峰論壇測試場[\s\S]*十天前的院士授證典禮/.test(t), t);
  check('一個半月前的不列（不讓過去式塞滿畫面）', !/一個半月前的舊發表會/.test(t), t);
  check('★ 按鈕也有最近辦過的場次', btn.includes('晶鏈高峰論壇測試場') && btn.includes('十天前的院士授證典禮') && btn.includes('五天後的綠能論壇'), JSON.stringify(btn));
  check('沒有資料的場次不佔按鈕（點了也問不出東西）', !btn.includes('兩天前的僅基本資料場'), JSON.stringify(btn));
  check('一個半月前的不佔按鈕', !btn.includes('一個半月前的舊發表會'), JSON.stringify(btn));
  check('按鈕總數不超過 13', btn.length <= 13, `${btn.length}`);
}
{
  // 近期活動很多時：最近辦過的最多保留 4 格，接下來要辦的也不會全被擠掉
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(ev('u' + i, `未來第${i}場`, 'active', day(i)));
  for (let i = 1; i <= 6; i++) rows.push(ev('p' + i, `過去第${i}場`, 'ended', day(-i)));
  const items = calendarQuickReplyItems(buildCalendarCards(rows));
  const pastN = items.filter((n) => n.startsWith('過去')).length;
  check('活動很多時：按鈕 8 顆、最近辦過的 4 顆、接下來要辦的 4 顆', items.length === 8 && pastN === 4, JSON.stringify(items));
  check('最近辦過的從最近的開始排', items.includes('過去第1場') && !items.includes('過去第6場'), JSON.stringify(items));
  const onlyPast = formatCalendarReply(buildCalendarCards([ev('p1', '上週的記者會', 'ended', day(-7))]));
  check('沒有排定中的活動、但最近有辦過 → 照樣列出最近辦過的', /目前沒有排定中的活動/.test(onlyPast) && /上週的記者會/.test(onlyPast), onlyPast);
}

// ═══ 二、要完整新聞稿但沒講哪一場 ═════════════════════════════════════════════
console.log('\n── 二、沒講哪一場就要完整新聞稿 → 反問，按鈕按下去直接給 ──');
seed(); await fresh();
{
  const out = await dm('Ufull', '給我完整新聞稿');
  const t = texts(out)[0];
  const btn = (t?.quickReply || []).map(qrText);
  check('★ 反問「想要哪一場的完整新聞稿」，不是兜底的「不太確定」', /想要哪一場的完整新聞稿/.test(t?.text || '') && !/不太確定/.test(t?.text || ''), t?.text);
  check('每一場一顆「給我《…》的完整新聞稿」按鈕（含最近辦過的）',
    btn.includes('給我《晶鏈高峰論壇測試場》的完整新聞稿') && btn.includes('給我《五天後的綠能論壇》的完整新聞稿'), JSON.stringify(btn));
  check('按鈕顯示的是活動名稱（不是整句）', (t?.quickReply || []).some((i) => typeof i === 'object' && i.label === '晶鏈高峰論壇測試場'));
  check('反問那則也找得到「找真人」', btn.includes('找真人'), JSON.stringify(btn));
  check('沒有呼叫模型答題（還不知道是哪一場）', !out.some((o) => o.kind === 'answer'));

  const out2 = await dm('Ufull', '給我《晶鏈高峰論壇測試場》的完整新聞稿');
  const a = out2.find((o) => o.kind === 'answer');
  check('★ 按下去直接答那一場', a?.event === 'past3', JSON.stringify(out2.map((o) => o.kind + ':' + (o.event || ''))));
  check('順便接上那一場（下一題不用再講是哪一場）', state.bindings.get('Ufull')?.event_id === 'past3', JSON.stringify(state.bindings.get('Ufull')));
  check('1 對 1 照舊給全文（沒有群組的一對一連結）', !/oaMessage/.test(texts(out2)[0]?.text || ''));

  const out3 = await dm('Ufull', '給我完整新聞稿');
  check('已經接上某一場時，「給我完整新聞稿」直接答那一場，不再反問', out3.some((o) => o.kind === 'answer' && o.event === 'past3') && !/想要哪一場/.test(texts(out3)[0]?.text || ''),
    JSON.stringify(out3.map((o) => o.kind + ':' + String(o.text || o.event || '').slice(0, 20))));
}
seed(); await fresh();
{
  let out = await g('Cfull', 'U王', '米亞 給我完整新聞稿');
  check('群組：叫了米亞要全文 → 一樣反問哪一場', /想要哪一場的完整新聞稿/.test(texts(out)[0]?.text || ''), texts(out)[0]?.text);
  // 另一位成員按按鈕，不 @、不寫米亞
  out = await g('Cfull', 'U李', '給我《十天前的院士授證典禮》的完整新聞稿');
  const a = out.find((o) => o.kind === 'answer');
  check('★ 群組裡別人按按鈕也會動，答那一場', a?.event === 'past10', JSON.stringify(out.map((o) => o.kind)));
  check('群組照群組規則：只給重點＋一對一拿全文的連結', /多人 LINE 群組/.test(a?.sys || '') && /oaMessage/.test(texts(out)[0]?.text || ''), texts(out)[0]?.text);
  out = await g('Cquiet', 'U路人', '給我完整新聞稿');
  check('群組裡沒叫米亞、也不在續問視窗內 → 安靜', out.length === 0, JSON.stringify(out));
}

// ═══ 三、AI 叫不動時通知管理員 ════════════════════════════════════════════════
console.log('\n── 三、AI 金鑰失效 → LINE 通知管理員 ──');
check('401 金鑰失效算「不會自己好」', isFatalAiError(401, 'API key is invalid.'));
check('額度用完算', isFatalAiError(400, 'Your credit balance is too low to access the Anthropic API.'));
check('429 太頻繁不算（暫時的）', !isFatalAiError(429, 'Number of request tokens has exceeded your per-minute rate limit'));
check('529 過載不算（暫時的）', !isFatalAiError(529, 'Overloaded'));

process.env.LINE_ADMIN_USER_ID = 'Uadmin';
seed(); await fresh(); resetAiAlertThrottle();
state.bindings.set('Ufail', { event_id: 'up5', media_name: '中央社', note: '', bound_at: Date.now() });
state.anthropicFail = 'auth';
{
  let out = await dm('Ufail', '這場的重點是什麼？');
  const toAdmin = out.filter((o) => o.to === 'Uadmin');
  check('★ 管理員收到 LINE 通知', toAdmin.length === 1 && /叫不動/.test(toAdmin[0].text) && /API key is invalid/.test(toAdmin[0].text), JSON.stringify(out.map((o) => [o.to, String(o.text).slice(0, 40)])));
  check('通知裡寫了怎麼修（Anthropic Console、更新 ANTHROPIC_API_KEY、重新部署）', /console\.anthropic\.com/.test(toAdmin[0]?.text || '') && /ANTHROPIC_API_KEY/.test(toAdmin[0]?.text || '') && /重新部署/.test(toAdmin[0]?.text || ''));
  check('記者照樣收到「目前無法取得回應」，不是沒有回應', out.some((o) => o.to === 'Ufail' && /無法取得回應/.test(o.text || '')), JSON.stringify(out.map((o) => [o.to, String(o.text).slice(0, 30)])));
  out = await dm('Ufail', '那合作廠商有哪些？');
  check('★ 一小時內不重複通知（出事時每一題都會失敗，不能洗管理員的版）', !out.some((o) => o.to === 'Uadmin'), JSON.stringify(out.map((o) => o.to)));
}
seed(); await fresh(); resetAiAlertThrottle();
state.bindings.set('Ubusy', { event_id: 'up5', media_name: '中央社', note: '', bound_at: Date.now() });
state.anthropicFail = 'overload';
{
  const out = await dm('Ubusy', '這場的重點是什麼？');
  check('過載（529）不通知——會自己好的錯誤不洗版', !out.some((o) => o.to === 'Uadmin'), JSON.stringify(out.map((o) => o.to)));
}
delete process.env.LINE_ADMIN_USER_ID;
seed(); await fresh(); resetAiAlertThrottle();
state.bindings.set('Unoadmin', { event_id: 'up5', media_name: '中央社', note: '', bound_at: Date.now() });
state.anthropicFail = 'auth';
{
  const out = await dm('Unoadmin', '這場的重點是什麼？');
  check('沒設 LINE_ADMIN_USER_ID → 不通知，但記者照樣收到回覆', out.length > 0 && out.every((o) => o.to === 'Unoadmin'), JSON.stringify(out.map((o) => o.to)));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 85 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
