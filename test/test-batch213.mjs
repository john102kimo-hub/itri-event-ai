// 批次 213：報名頁右下角的米亞問答。
//   一、能不能出現由伺服器決定（reg_event_ask → lib/reg-ask.js）：沒關聯、未發布、敏感、企業場、未解禁一律 { ask: null }
//   二、回應只有活動代碼；任何一步出錯當作沒有，報名頁照常
//   三、報名頁：對話框是活動問答頁（?embed=1），不另寫問答、不帶報名資料；放在表單外
//   四、活動問答頁的嵌入模式
import { register } from 'node:module';
register('./loader-reg.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'MAIN';
process.env.EVENTS_TABLE_TTL_MS = '0';
delete process.env.B2B_SPREADSHEET_ID;

// 假時鐘：2026-10-07（週三）上午 10:00 台灣時間
let clock = Date.UTC(2026, 9, 7, 2, 0, 0);
Date.now = () => clock;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };

const S = await import('./fakes-sheets82.mjs');
const R = await import('../lib/registration.js');
const Q = await import('../lib/reg-ask.js');
const events = (await import('../api/events.js')).default;

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.send = (t) => (r.text = t, r); r.end = () => r; return r; };
const get = async (action, query = {}) => { const r = res(); await events({ method: 'GET', headers: { 'x-forwarded-for': '10.213.0.1' }, query: { action, ...query }, socket: {} }, r); return r; };

// 活動欄位：A id B 名稱 C 色 D 知識庫 E 狀態 F 日期 … K 編輯碼 L 時間 M 地點 N 類型 O 聯絡人 P 邀訪窗口 Q 邀請函
const row = ({ id = 'ev', status = 'active', date = '2026-10-01', type = '記者會', invite = '' } = {}) =>
  [id, '測試記者會', '#0F9E7A', '【新聞稿】機密內文', status, date, '', '', '', '工研院', 'edit-secret', '14:00', '中興院區', type, '王小明', '窗口｜李｜分機', invite, ''];
const SESS = 'A1｜2026-11-20｜14:00-16:00｜記者會';
const camp = ({ id = 'c1', event_id = 'ev', audience = 'media', status = 'open' } = {}) =>
  R.campaignToRow({ id, title: '記者會報名', status, sessions_text: SESS, audience, event_id });
const setup = (ev, c = camp()) => {
  S.reset(); R.resetRegistrationState();
  S.book.events = [['id'], ...(ev ? [ev] : [])];
  S.book.reg_campaigns = [R.CAMPAIGN_HEADERS, c];
  S.book.registrations = [R.REG_HEADERS];
};
const ask = async (ev, c) => { setup(ev, c); return get('reg_event_ask', { c: 'c1' }); };
const shown = async (ev, c) => (await ask(ev, c)).body?.ask?.event_id === 'ev';
const hidden = async (ev, c) => { const r = await ask(ev, c); return r.statusCode === 200 && JSON.stringify(r.body) === '{"ask":null}'; };

console.log('── 一、伺服器把關 ──');
check('★ 活動已發布、活動日已到 → 提供', await shown(row()));
check('　 活動日就是今天 → 提供（跟問答頁一樣，當天起用知識庫）', await shown(row({ date: '2026-10-07' })));
check('★ 活動前、有媒體邀請函 → 提供（問答端只拿邀請函回答）', await shown(row({ date: '2026-11-20', invite: '誠摯邀請' })));
check('★ 活動前、沒有邀請函（未解禁）→ 不提供', await hidden(row({ date: '2026-11-20' })));
check('　 邀請函只有空白 → 當作沒有', await hidden(row({ date: '2026-11-20', invite: ' \n ' })));
check('★ 沒填活動日期、沒標已結束 → 不提供', await hidden(row({ date: '' })));
check('　 日期欄是系統寫的建立時間戳記 → 不算活動日期，不提供', await hidden(row({ date: '2026/6/18 下午11:06:04' })));
check('　 已結束 → 提供（問答頁本來就能問，新聞稿已公開）', await shown(row({ status: 'ended', date: '' })));
check('★ 草稿 → 不提供', await hidden(row({ status: 'draft' })));
check('★ 封存 → 不提供', await hidden(row({ status: 'archived' })));
check('　 認不得的狀態 → 不提供', await hidden(row({ status: 'paused' })));
check('★ 敏感場次「聲明稿」→ 不提供', await hidden(row({ type: '聲明稿' })));
check('★ 敏感場次「敏感新聞回應說明」已結束也不提供', await hidden(row({ type: '敏感新聞回應說明', status: 'ended' })));
check('★ 企業場活動 → 不提供', await hidden(row({ type: '企業說明會' })));
check('★ 企業場報名（活動類型是一般記者會）→ 不提供', await hidden(row(), camp({ audience: 'business' })));
check('★ 報名沒有關聯活動 → 不提供', await hidden(row(), camp({ event_id: '' })));
check('　 關聯的活動找不到 → 不提供', await hidden(null));
setup(row());
check('　 報名代碼不存在 → 不提供', JSON.stringify((await get('reg_event_ask', { c: 'nope' })).body) === '{"ask":null}');
check('★ 拿活動代碼來打（不是報名代碼）→ 不提供', JSON.stringify((await get('reg_event_ask', { c: 'ev' })).body) === '{"ask":null}');
check('　 沒帶代碼 → 不提供', JSON.stringify((await get('reg_event_ask')).body) === '{"ask":null}');
check('　 草稿報名（承辦人試看）關聯已發布活動 → 提供', await shown(row(), camp({ status: 'draft' })));
check('　 純函式：空列 → false', Q.canAskOnRegisterPage(null) === false && Q.canAskOnRegisterPage([]) === false);

console.log('\n── 二、回應內容與出錯 ──');
{
  const r = await ask(row({ date: '2026-11-20', invite: '誠摯邀請' }));
  check('★ 回應只有活動代碼，沒有知識庫、邀請函、編輯碼、聯絡窗口', JSON.stringify(r.body) === '{"ask":{"event_id":"ev"}}', JSON.stringify(r.body));
  const err = console.error; console.error = () => {};
  setup(row()); S.book.events = null;
  const broken = await get('reg_event_ask', { c: 'c1' });
  const cfg = await get('reg_config', { c: 'c1' });
  console.error = err;
  check('★ 活動表讀不到 → { ask: null }，不是 500', broken.statusCode === 200 && broken.body.ask === null, JSON.stringify(broken.body));
  check('　 報名頁的活動內容照常讀得到，而且不含 event_id', cfg.statusCode === 200 && cfg.body.campaign.id === 'c1' && !JSON.stringify(cfg.body).includes('event_id'));
}

console.log('\n── 三、報名頁 ──');
const reg = read('public/register.html');
const block = reg.slice(reg.indexOf('/* ── 米亞問答'), reg.lastIndexOf('init();'));
const code = block.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
check('抓得到米亞那一段程式', code.includes('function mountMia') && code.length > 1000);
check('★ 不另寫問答：整頁沒有打 /api/chat', !reg.includes('/api/chat'));
check('★ 對話框就是活動問答頁，網址只帶活動代碼與 embed', code.includes('`/event?id=${encodeURIComponent(eventId)}&embed=1`') && code.includes("referrerpolicy: 'no-referrer'"));
check('★ 這一段不碰報名資料：沒有身分簽章、編輯碼、表單欄位、瀏覽器儲存', !/LINE_TOKEN|EDIT_TOKEN|collect\(|#f-|\bediting\b|\bstore\.|localStorage|postMessage/.test(code), code.match(/LINE_TOKEN|EDIT_TOKEN|collect\(|#f-|\bediting\b|\bstore\.|localStorage|postMessage/)?.[0]);
check('★ 掛在 body（#app 與表單外面），開關不重畫表單', code.includes('document.body.append(fab, panel)') && !/renderForm|renderDone|replaceChildren|location\.(href|assign|replace|reload)/.test(code));
check('　 按鈕都是 type=button（不會誤送出報名）', (code.match(/el\('button'/g) || []).length === (code.match(/el\('button', \{[^}]*type: 'button'/g) || []).length);
check('　 手機「返回」先關對話框', code.includes('history.pushState') && code.includes("'popstate'"));
check('★ 關對話框不把表單捲回原位（先設 scrollRestoration 才墊紀錄）', code.indexOf("scrollRestoration = 'manual'") > 0 && code.indexOf("scrollRestoration = 'manual'") < code.indexOf('history.pushState'));
check('★ 圖示墊在送出列上面', code.includes("$('.bar')") && reg.includes('bottom: var(--mia-lift, 16px)'));
check('　 查詢不擋報名表（不 await）', /\n\s*loadMia\(campaign\.id\);/.test(reg));
check('　 圖示用本站圖片，不載外部資源', fs.existsSync(path.join(ROOT, 'public', 'mia-avatar.png')) && !/<(script|link)[^>]+https?:/.test(reg));

console.log('\n── 四、活動問答頁嵌入模式 ──');
const ev = read('public/event.html');
check('★ ?embed=1 收掉標題列', ev.includes("params.get('embed') === '1'") && ev.includes('body.embed #header { display: none; }'));
check('★ 嵌入時不放「我要報名」與 LINE 入口', /if \(!EMBED\) \{\s*addLineLink\([^\n]*\n\s*addRegisterLink\(/.test(ev) && (ev.match(/addRegisterLink\(welcomeEl/g) || []).length === 1);
check('　 嵌入時拿掉 SSR 的新聞稿存檔，不會攤在對話框裡', ev.includes("if (EMBED) document.getElementById('geo-article')?.remove();"));
check('　 報名頁與活動頁沒有被禁止嵌入（/event 不在 X-Frame-Options 清單）', JSON.parse(read('vercel.json')).headers.filter((h) => h.headers.some((x) => x.key === 'X-Frame-Options')).every((h) => !/[(|]event[)|]/.test(h.source)));
check('★ api/ 沒有新增 Function', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length <= 11);

console.log('\n── 五、獨立審查後補的（嵌入模式的活動前內容、問答端舊快取）──');
{
  const pre = (extra = {}) => { const r = row({ date: '2026-11-20', invite: '誠摯邀請' }); r[6] = '當天才能問的晶片良率？'; r[8] = '今天發表全球首創'; Object.assign(r, extra); return r; };
  setup(pre());
  const embed = (await get('get_public', { id: 'ev', embed: '1' })).body.event;
  check('★ 活動前＋嵌入：一般快速提問與開場白不出現', !JSON.stringify(embed).includes('晶片良率') && !JSON.stringify(embed).includes('全球首創') && embed.greeting === '', JSON.stringify(embed));
  check('　 換成活動前預設那組快速提問', embed.chips.includes('邀請函的內容是什麼？'), embed.chips);
  const page = (await get('get_public', { id: 'ev' })).body.event;
  check('　 活動問答頁（沒帶 embed）行為不變', page.chips.includes('晶片良率') && page.greeting === '今天發表全球首創');
  setup(pre({ 17: '採訪怎麼報名？' }));
  check('★ 有填「活動前快速提問」就用那組', (await get('get_public', { id: 'ev', embed: '1' })).body.event.chips === '採訪怎麼報名？');
  setup(pre({ 5: '2026-10-01' }));
  const day = (await get('get_public', { id: 'ev', embed: '1' })).body.event;
  check('　 活動日起：嵌入模式照常用同仁的快速提問與開場白', day.chips.includes('晶片良率') && day.greeting === '今天發表全球首創');

  // 問答端：閒置很久的 instance 不能拿舊設定答第一題
  process.env.ANTHROPIC_API_KEY = 'fake';
  const chat = (await import('../api/chat.js')).default;
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => { sent.push(opt.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: '好的' }], usage: {} }), { headers: { 'content-type': 'application/json' } }); };
  const askChat = async () => { const r = res(); await chat({ method: 'POST', headers: { 'x-forwarded-for': '10.213.1.1' }, socket: {}, body: { event_id: 'ev', media_name: '測試日報', messages: [{ role: 'user', content: '請問重點？' }] } }, r); return sent.at(-1) || ''; };
  const log = console.log, err = console.error; console.log = console.error = () => {};
  setup(row({ date: '2026-11-20' }));
  const first = await askChat();
  setup(row({ date: '2026-11-20', invite: '誠摯邀請' }));
  clock += 3 * 3600e3;
  const later = await askChat();
  console.log = log; console.error = err; globalThis.fetch = realFetch;
  check('　 對照：還沒有邀請函時，模型看得到知識庫', first.includes('機密內文'));
  check('★ 補上邀請函、閒置 3 小時後的第一題：模型只看到邀請函', later.includes('誠摯邀請') && !later.includes('機密內文'), later.slice(0, 300));
}
const evHtml = read('public/event.html');
check('★ 嵌入時帶 embed=1 讀活動', evHtml.includes("(EMBED ? '&embed=1' : '')"));
check('★ 嵌入時的錯誤畫面不叫人重新整理整頁，有「再試一次」', /function showError\(msg\) \{[\s\S]{0,700}if \(EMBED\)[\s\S]{0,600}再試一次/.test(evHtml));
check('　 上次沒載成功，再點開會重載', code.includes('frame && broken(frame)'));
check('　 圖示延後出現，不吃掉那一下點擊', code.includes('setTimeout') && code.includes("addEventListener('focusout', calm)"));
check('　 CSS 與 JS 的全螢幕條件一致（含橫向）', reg.includes('@media (max-width: 640px), (max-height: 500px)') && reg.includes("MIA_FULL = '(max-width: 640px), (max-height: 500px)'"));

console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
