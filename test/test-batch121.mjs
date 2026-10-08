// 批次 121 的回歸測試：選單兩格改版——
//   「想問什麼技術」→「問技術與洽案」：資料來自官網「產業服務」技術清單（六大領域），每項放技術名稱、簡介、
//                    聯絡人（姓名＋信箱）、短網址
//   「新聞稿全文」  →「近期工研院新聞」：資料來自官網新聞中心，標題＋導言＋短網址（原本「想問什麼技術」那套搬過來）
//
// 這份測試從「記者實際會怎麼用」出發：一對一走一輪、群組走一輪、以及最重要的——**不會誤觸、不會答非所問**
// （打了別的話不被吃掉、群組裡別人聊天不被插話、舊按鈕舊講法照樣動）。
// 官網資料用 test/fakes.mjs 裡節錄自真實原始碼的假資料；真的連官網的實測見批次 121 紀錄。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.SITE_URL;

const tech = await import('../lib/itri-tech.js');
const news = await import('../lib/itri-news.js');
const shortLink = await import('../lib/short-link.js');
const { toTraditionalTW } = await import('../lib/zh-tw.js');
const { REPORTER_MENU, detectMetaIntent } = await import('../lib/menu.js');
const eventPage = (await import('../api/event-page.js')).default;

let handler, modSeq = 0;
async function fresh() { tech.__clearTechCache(); handler = (await import(new URL(`../api/line.js?b121=${++modSeq}`, import.meta.url).href)).default; }
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
const texts = (out) => out.filter((s) => s.kind === 'text');
const allText = (out) => texts(out).map((o) => o.text).join('\n---\n');
const chips = (out) => (texts(out).at(-1)?.quickReply || []).map((i) => (typeof i === 'object' ? i : { label: i, text: i }));
const chipTexts = (out) => chips(out).map((c) => c.text);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}

const ev = (id, name, status, date) =>
  [id, name, '#0F9E7A', '【新聞稿】' + name + '的內容', status, date, '', '', '', '工研院', 'c-' + id, '', '', '', '王小明 03-1111111', '', '', ''];
function seed() {
  reset();
  state.events = [ev('up5', '五天後的綠能論壇', 'active', isoOffset(5)), ev('past3', '晶鏈高峰論壇測試場', 'active', isoOffset(-3))];
}
const SIMPLIFIED_RE = /[机车网数据术实时开发电脑软应务发门问间对说让这们与为来会学务]/; // 常見簡體字；程式的輸出一個都不能有
const hasAnswer = (out) => out.some((o) => o.kind === 'answer'); // kind==='answer' ＝ 這則走了模型

// ═══ 一、純函式：解析官網的原始碼 ═════════════════════════════════════════════
console.log('── 一、解析官網原始碼（技術清單、內容頁、新聞清單）──');
{
  const list = tech.parseTechListHtml(`<ul><li><a href='ListStyle.aspx?DisplayStyle=13_content&SiteID=1&MmmID=1&Trt_idx=11246'>&#28961;&#22522;&#26448;&#25216;&#34899;</a></li>
<li><a href='x&Trt_idx=11245'>高效無鹵環保放電劑</a></li></ul><label id="lblDataSum" style="display:none">
            2882
        </label>`);
  check('清單：解出編號、名稱（含 &#數字; 實體）與總數', list.items.length === 2 && list.items[0].id === '11246' && list.items[0].title === '無基材技術' && list.total === 2882, JSON.stringify(list));
  check('清單：空頁面不炸、總數 0', tech.parseTechListHtml('').items.length === 0 && tech.parseTechListHtml(null).total === 0);

  const d = tech.parseTechDetailHtml(`<span id="spanTitle"> 某技術 </span><h4>技術簡介</h4><P>厚度&ge; 300 &mu;m。第二句。</P><h4> 技術特色 </h4><P>特色</P>
    <h4>聯絡資訊</h4><div class='connection Lb'><p>聯絡人：曾謙順 低碳與儲能技術組</p><p>電話：+886-6-3636952 或 Email：fengshuntseng&#65312;itri.org.tw</p></div>`);
  check('內容頁：聯絡人只取名字（不帶組別）', d.contactName === '曾謙順', d.contactName);
  check('★ 官網的全形＠換成半形，記者複製下來才寄得出去', d.email === 'fengshuntseng@itri.org.tw' && !/＠/.test(d.email), d.email);
  check('內容頁：具名實體（≥ μ）解開，不會出現 &ge;', d.intro.includes('≥ 300 μm') && !/&\w+;/.test(d.intro), d.intro);
  check('內容頁：簡介不含電話與組別', !/3636952|低碳與儲能/.test(JSON.stringify(d)), JSON.stringify(d));
  const none = tech.parseTechDetailHtml('<h4>技術簡介</h4><P>none</P><h4> 技術特色 </h4><P>退而求其次的特色說明</P><h4>聯絡資訊</h4><p>聯絡人：王大明 某組</p><p>電話：1 或 Email：a.b@itri.org.tw</p>');
  check('簡介欄寫 none → 退到「技術特色」，不顯示 none', none.intro === '退而求其次的特色說明', none.intro);
  const nothing = tech.parseTechDetailHtml('<h4>技術簡介</h4><P>none</P><h4>聯絡資訊</h4><p>聯絡人：王大明</p><p>Email：not-an-email</p>');
  check('簡介全空 → 空字串（不編）；信箱格式不對 → 不放（寧可沒有也不給錯的）', nothing.intro === '' && nothing.email === '' && nothing.contactName === '王大明', JSON.stringify(nothing));
  check('簡介太長 → 在句號收尾，不硬砍字中間', tech.shortenIntro('甲'.repeat(60) + '。' + '乙'.repeat(60)).endsWith('。') && tech.shortenIntro('甲'.repeat(200)).endsWith('…'));

  const nl = news.parseNewsListHtml(state.itriHtml);
  check('新聞清單：解出 MGID 當短網址編號', nl.length >= 1 && /^\d{10,}$/.test(nl[0].id), JSON.stringify(nl[0]));
}

console.log('\n── 二、領域與按鈕句型 ──');
{
  check('六大領域，代碼對得上官網 API（B C D E F N）', tech.TECH_DOMAINS.map((d) => d.code).join('') === 'BCDEFN');
  check('按鈕送出的句型能被解析回來（領域／關鍵字／翻頁）',
    tech.parseTechPick(tech.techPickText({ domain: tech.TECH_DOMAINS[4], page: 3 }))?.domain?.code === 'F'
    && tech.parseTechPick(tech.techPickText({ domain: tech.TECH_DOMAINS[4], page: 3 })).page === 3
    && tech.parseTechPick(tech.techPickText({ keyword: 'AI晶片' })).keyword === 'AI晶片'
    && news.parseNewsPick(news.newsPickText({ keyword: '半導體', page: 2 })).page === 2
    && news.parseNewsPick(news.newsPickText({ page: 4 })).page === 4 && news.parseNewsPick(news.newsPickText({ page: 4 })).keyword === '');
  for (const t of ['技術領域：', '技術關鍵字：', '新聞關鍵字：', '技術領域', '我想看技術領域：機械', '請問技術關鍵字：電池', '新聞關鍵字', '近期工研院新聞']) {
    check(`不是句型的字不被認：「${t}」`, !tech.parseTechPick(t) && !news.parseNewsPick(t), JSON.stringify([tech.parseTechPick(t), news.parseNewsPick(t)]));
  }
  check('領域名稱打錯字 → 當關鍵字查（不是按了沒反應）', tech.parseTechPick('技術領域：生醫').domain === null && tech.parseTechPick('技術領域：生醫').keyword === '生醫');
  check('領域頁碼上限 200、下限 1', tech.parseTechPick('技術領域：綠能與環境 第99999頁') === null || tech.parseTechPick('技術領域：綠能與環境 第999頁').page === 200);
}

console.log('\n── 三、短網址（導回官網；不可能被拿去導到別的網站）──');
{
  check('技術短網址', shortLink.shortTechUrl('11246') === 'https://itri-event-ai.vercel.app/t/11246');
  check('新聞短網址', shortLink.shortNewsUrl('115100714231450331') === 'https://itri-event-ai.vercel.app/n/115100714231450331');
  check('★ 編號不是純數字 → 不產生連結（空字串）', !shortLink.shortTechUrl('1;x') && !shortLink.shortNewsUrl('../a') && !shortLink.shortTechUrl(''));
  check('技術 → 官網內容頁（帶對的 MmmID 與 Trt_idx）', /^https:\/\/www\.itri\.org\.tw\/ListStyle\.aspx\?DisplayStyle=13_content&SiteID=1&MmmID=1036233405427625204&Trt_idx=11246$/.test(shortLink.resolveShortLink('t', '11246')));
  check('新聞 → 官網文章頁（帶對的 MmmID 與 MGID）', /DisplayStyle=01_content&SiteID=1&MmmID=1036276263153520257&MGID=115100714231450331$/.test(shortLink.resolveShortLink('n', '115100714231450331')));
  for (const [k, n] of [['t', 'abc'], ['t', '1&MmmID=9'], ['t', '//evil.com'], ['x', '123'], ['', '123'], ['t', ''], ['n', 'https://evil.com'], ['t', '9'.repeat(40)]]) {
    check(`★ 不合法的組合回空字串：${k}/${n.slice(0, 20)}`, shortLink.resolveShortLink(k, n) === '');
  }
  // 批次 122：產業趨勢（IEK）的連結也用短網址
  check('IEK 長網址 → 短網址 /i/領域-報告編號', shortLink.shortenIekUrl('https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?actiontype=rpt&indu_idno=0&domain=28&rpt_idno=343831942') === 'https://itri-event-ai.vercel.app/i/28-343831942');
  check('短網址 → IEK 原文（indu_idno=0、領域、編號都對）', shortLink.resolveShortLink('i', '28-343831942') === 'https://ieknet.iek.org.tw/iekrpt/rpt_more.aspx?actiontype=rpt&indu_idno=0&domain=28&rpt_idno=343831942');
  check('★ 認不得的網址原樣回傳，不產生錯的短網址', shortLink.shortenIekUrl('https://example.com/x?domain=1&rpt_idno=2') === 'https://example.com/x?domain=1&rpt_idno=2' && shortLink.shortenIekUrl('') === '');
  for (const bad of ['28', '28-', '-5', 'a-b', '28-1;x', '28-343831942-1', '1'.repeat(9) + '-1', '//evil.com']) {
    check(`★ IEK 短網址編號不合法 → 空字串：${bad}`, shortLink.resolveShortLink('i', bad) === '');
  }
  check('種類 i 不接受技術／新聞那種單一數字編號', shortLink.resolveShortLink('i', '11246') === '' && shortLink.resolveShortLink('t', '28-343831942') === '');
  const call = async (query) => {
    const r = { code: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
    await eventPage({ query, method: 'GET', headers: {} }, r);
    return r;
  };
  let r = await call({ _r: 'go', k: 't', n: '11246' });
  check('端點：/t/11246 → 302 導到官網', r.code === 302 && /^https:\/\/www\.itri\.org\.tw\//.test(r.headers.Location || ''), JSON.stringify([r.code, r.headers.Location]));
  r = await call({ _r: 'go', k: 'n', n: '115100714231450331' });
  check('端點：/n/… → 302 導到官網新聞', r.code === 302 && /MGID=115100714231450331/.test(r.headers.Location || ''));
  r = await call({ _r: 'go', k: 't', n: 'http://evil.com' });
  check('★ 端點：編號夾帶網址 → 404，不導走', r.code === 404 && !r.headers.Location, JSON.stringify([r.code, r.headers.Location]));
  r = await call({ _r: 'go', k: 'i', n: '28-343831942' });
  check('端點：/i/28-343831942 → 302 導到 IEK', r.code === 302 && /^https:\/\/ieknet\.iek\.org\.tw\//.test(r.headers.Location || ''), JSON.stringify([r.code, r.headers.Location]));
  r = await call({ _r: 'go', k: 'i', n: 'http://evil.com' });
  check('★ 端點：/i/ 夾帶網址 → 404', r.code === 404 && !r.headers.Location);
  r = await call({ _r: 'go', k: 'z', n: '1' });
  check('端點：不認得的種類 → 404', r.code === 404);
  r = await call({ _r: 'go' });
  check('端點：什麼都沒帶 → 404（不噴例外）', r.code === 404);
  const vercel = JSON.parse((await import('node:fs')).readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  check('vercel.json：/t/:id、/n/:id、/i/:id 三條 rewrite 都有，且沒有多開 Function（Hobby 上限 12）',
    vercel.rewrites.some((x) => x.source === '/t/:id' && /_r=go&k=t&n=:id/.test(x.destination))
    && vercel.rewrites.some((x) => x.source === '/n/:id' && /_r=go&k=n&n=:id/.test(x.destination))
    && vercel.rewrites.some((x) => x.source === '/i/:id' && /_r=go&k=i&n=:id/.test(x.destination)));
  const fs = await import('node:fs');
  check('api/ 底下的 Function 數量沒超過 12', fs.readdirSync(new URL('../api', import.meta.url)).filter((f) => f.endsWith('.js')).length <= 12);
}

// ═══ 三之二、產業趨勢的連結走短網址（走完整 LINE 流程）═══════════════════════
console.log('\n── 三之二、產業趨勢分析：原文連結是短網址 ──');
seed(); await fresh();
{
  state.fallbackReply = null;
  const iek = (await import('../lib/industry-trends.js')).parseDigestHtml(state.iekHtml);
  const first = iek[0]?.url || '';
  state.answerText = 'AI 資料中心帶動電力與儲能需求。\n來源編號：1,2'; // 模擬模型照規定標出引用了第幾則
  const out = await dm('Utrend', '產業趨勢分析');
  state.answerText = '';
  const t = allText(out);
  check('★ 產業趨勢回覆附「原文連結」，而且是 /i/ 短網址（不是 IEK 長網址）', /🔗 原文連結：\nhttps:\/\/itri-event-ai\.vercel\.app\/i\/\d+-\d+/.test(t) && !/ieknet\.iek\.org\.tw/.test(t), t.slice(0, 300));
  check('　 「來源編號」那行沒有漏給記者看', !/來源編號/.test(t), t.slice(0, 200));
  check('（前置）假資料的 IEK 項目能轉成短網址', /^https:\/\/itri-event-ai\.vercel\.app\/i\/\d+-\d+$/.test(shortLink.shortenIekUrl(first)), first);
}

// ═══ 三之三、「這場答不出來、補查官網」附的新聞連結也是短網址 ═══════════════════
console.log('\n── 三之三、補查官網：原文連結是短網址 ──');
seed(); await fresh();
{
  state.noDataKeyword = '院士';
  state.bindings.set('Uhint', { event_id: 'past3', media_name: '中央社', note: '', bound_at: Date.now() });
  const out = await dm('Uhint', '今年院士有誰？');
  state.noDataKeyword = '';
  const t = allText(out);
  check('★ 補查官網附的新聞連結是 /n/ 短網址，沒有官網長網址', /https:\/\/itri-event-ai\.vercel\.app\/n\/\d+/.test(t) && !/itri\.org\.tw|ListStyle\.aspx|MmmID/.test(t), t.slice(-300));
}

// ═══ 四、選單與意圖 ═════════════════════════════════════════════════════════
console.log('\n── 四、圖文選單改名、送出的字一定被認得（否則就是按了沒反應）──');
{
  const labels = REPORTER_MENU.buttons.map((b) => b.label);
  check('選單六格：問技術與洽案、近期工研院新聞取代舊的兩格', labels.includes('問技術與洽案') && labels.includes('近期工研院新聞') && !labels.includes('想問什麼技術') && !labels.includes('新聞稿全文'), labels.join('/'));
  check('「問技術與洽案」→ tech_query；「近期工研院新聞」→ news', detectMetaIntent('問技術與洽案') === 'tech_query' && detectMetaIntent('近期工研院新聞') === 'news');
  for (const t of ['想問什麼技術', '技術查詢', '技術呢', '最近有哪些新聞', '最近發的新聞稿麼', '近期新聞', '工研院新聞']) {
    check(`舊講法與口語仍然認得：「${t}」`, ['tech_query', 'news'].includes(detectMetaIntent(t)), detectMetaIntent(t));
  }
  // 不能誤觸：這些是一般提問或聊天，不是在叫兩顆按鈕
  for (const t of ['技術', '新聞', '我想問技術上的問題', '這個技術什麼時候量產', '新聞稿幾點發', '技術領域：', '洽談時間', '今天的新聞很多', '工研院在新聞裡說了什麼', '這場有哪些技術']) {
    check(`★ 不誤觸：「${t}」不是 tech_query／news`, !['tech_query', 'news'].includes(detectMetaIntent(t)), detectMetaIntent(t));
  }
}

// ═══ 五、一對一：問技術與洽案 ═════════════════════════════════════════════
console.log('\n── 五、1 對 1：問技術與洽案 ──');
seed(); await fresh();
{
  let out = await dm('U1', '問技術與洽案');
  check('按「問技術與洽案」→ 先問哪個領域，附六大領域按鈕與範例關鍵字', texts(out).length === 1 && /想找工研院哪方面的技術/.test(out[0].text)
    && chips(out).filter((c) => /^技術領域：/.test(c.text)).length === 6 && chipTexts(out).includes('技術關鍵字：電池'), JSON.stringify(chips(out)));
  check('　 沒有跑模型、沒有查官網（還沒給關鍵字）', !hasAnswer(out));
  check('　 按鈕 label 都在 LINE 的 20 字內、總數在 13 顆內', chips(out).every((c) => c.label.length <= 20) && chips(out).length <= 13, JSON.stringify(chips(out).map((c) => c.label.length)));

  out = await dm('U1', '技術領域：綠能與環境');
  let t = allText(out);
  check('按領域「綠能與環境」→ 列出該領域的技術（名稱、簡介、聯絡人、短網址）',
    /綠能與環境（共 \d+ 項，第 1–2 項）/.test(t) && /【先期技術】藻類回收技術/.test(t) && /簡介：根據水中藻類/.test(t) && /聯絡人：劉晏嘉　yanjia@itri\.org\.tw/.test(t)
    && /🔗 https:\/\/itri-event-ai\.vercel\.app\/t\/10843/.test(t), t);
  check('★ 只有姓名＋信箱：沒有電話、沒有組別、沒有官網長網址', !/\+886|03-|低碳與儲能|ListStyle\.aspx|MmmID/.test(t) && !/＠/.test(t), t);
  check('　 沒有走模型（內容是程式照官網的字排的）', !hasAnswer(out));
  check('　 只有 2 項時沒有「更多技術」按鈕', !chips(out).some((c) => /更多技術/.test(c.label)));

  out = await dm('U1', '技術領域：通訊與光電');
  t = allText(out);
  check('領域「通訊與光電」有 13 項 → 第一頁放 5 項，附「➡️ 更多技術」', (t.match(/🔗 /g) || []).length === 5 && chips(out)[0].label === '➡️ 更多技術' && chips(out)[0].text === '技術領域：通訊與光電 第2頁', t + JSON.stringify(chips(out)[0]));
  out = await dm('U1', '技術領域：通訊與光電 第2頁');
  t = allText(out);
  check('第 2 頁接著第 6–10 項，仍有下一頁', /第 6–10 項/.test(t) && chips(out)[0].text === '技術領域：通訊與光電 第3頁', t.slice(0, 120));
  out = await dm('U1', '技術領域：通訊與光電 第3頁');
  t = allText(out);
  check('最後一頁（11–13 項）沒有「更多」按鈕', /第 11–13 項/.test(t) && !chips(out).some((c) => /更多技術/.test(c.label)), t.slice(0, 120));
  out = await dm('U1', '技術領域：通訊與光電 第9頁');
  check('翻過頭 → 老實說沒有更多，不是空白也不是報錯', /沒有更多了/.test(allText(out)), allText(out));

  out = await dm('U1', '問技術與洽案');
  out = await dm('U1', '電池');
  t = allText(out);
  check('★ 打關鍵字「電池」→ 查得到相關技術，附聯絡人與短網址', /「電池」/.test(t) && /電池電極奈米塗層技術/.test(t) && /\/t\/10701/.test(t) && /yuchiw@itri\.org\.tw/.test(t), t);
  check('　 旗標用掉了：接著再打字不會又被當關鍵字', state.bindings.get('U1')?.note !== 'await_tech_query', state.bindings.get('U1')?.note);

  await dm('U1', '問技術與洽案');
  out = await dm('U1', '我想找電池的技術');
  check('整句（含語助詞）→ 去泛稱重試後查得到', /電池電極奈米塗層技術/.test(allText(out)), allText(out));

  await dm('U1', '問技術與洽案');
  out = await dm('U1', '生醫與醫材');
  check('打的字剛好是領域名稱 → 當領域查（不是當關鍵字）', /生醫與醫材（共/.test(allText(out)) && /核酸片段化裝置與方法/.test(allText(out)), allText(out));

  await dm('U1', '問技術與洽案');
  out = await dm('U1', '量子火箭引擎');
  t = allText(out);
  check('★ 查無資料 → 老實說沒有，不硬掰技術；給六個領域按鈕、窗口與「找真人」',
    /沒有找到跟「量子火箭引擎」相關的技術/.test(t) && /找真人/.test(t) && /朱則瑋/.test(t) && chips(out).filter((c) => /^技術領域：/.test(c.text)).length === 6, t);
  check('　 沒有導去「產業趨勢」（批次 94：技術找不到不鬼打牆）', !chips(out).some((c) => /趨勢/.test(c.label)), JSON.stringify(chips(out).map((c) => c.label)));

  state.techFetchFail = true; tech.__clearTechCache();
  out = await dm('U1', '技術領域：機械與系統');
  t = allText(out);
  check('★ 官網抓不到 → 誠實說暫時抓不到，附官網連結與找真人，不噴例外', /暫時抓不到工研院官網的技術清單/.test(t) && /ListStyle\.aspx\?DisplayStyle=13/.test(t) && /找真人/.test(t), t);
  state.techFetchFail = false; tech.__clearTechCache();

  await fresh(); // 換一份乾淨的限流計數（前面連續問了很多次）
  state.techDetailFail = '10842'; tech.__clearTechCache();
  out = await dm('U1', '技術領域：綠能與環境');
  t = allText(out);
  check('★ 其中一項的內容頁抓失敗 → 那一項只留名稱與連結，其他項照常（整頁不能因為一項壞掉就消失）',
    /竹材多元應用加工技術\n🔗 https:\/\/itri-event-ai\.vercel\.app\/t\/10842/.test(t) && /藻類回收技術\n簡介/.test(t), t);
  state.techDetailFail = ''; tech.__clearTechCache();

  out = await dm('U1', '技術領域：材料與化工');
  t = allText(out);
  check('簡介欄是 none 的技術 → 改用「技術特色」，不顯示 none', /高效無鹵環保放電劑\n簡介：以無鹵配方取代傳統放電劑/.test(t) && !/none/i.test(t), t);

  out = await dm('U1', '技術領域：生醫與醫材');
  check('官網簡介裡的 &ge; &mu; 符號解開', /≥ 300 μm/.test(allText(out)) && !/&\w+;/.test(allText(out)), allText(out));
}

// ═══ 六、一對一：近期工研院新聞 ═════════════════════════════════════════════
console.log('\n── 六、1 對 1：近期工研院新聞 ──');
seed(); await fresh();
{
  let out = await dm('U2', '近期工研院新聞');
  let t = allText(out);
  check('按「近期工研院新聞」→ 標題＋日期導言＋短網址，不經過模型', /📰 近期工研院新聞（共 \d+ 則/.test(t) && /1\. 工研院攜AMRA打造足型機器人新標準/.test(t) && /2026\/08\/20　機器人應用落地/.test(t)
    && /🔗 https:\/\/itri-event-ai\.vercel\.app\/n\/\d+/.test(t) && !hasAnswer(out), t);
  check('　 不含官網長網址', !/ListStyle\.aspx|MmmID/.test(t), t);
  check('　 提示可以打關鍵字，並附範例按鈕（固定句型）', /直接輸入關鍵字/.test(t) && chipTexts(out).includes('新聞關鍵字：半導體'), JSON.stringify(chipTexts(out)));
  check('　 旗標已記下，等關鍵字', state.bindings.get('U2')?.note === 'await_news_query', state.bindings.get('U2')?.note);

  out = await dm('U2', '機器人');
  t = allText(out);
  check('接著打關鍵字 → 查新聞（標題＋導言＋短網址）＋比對到窗口', /工研院新聞｜「機器人」/.test(t) && /譚宇哲/.test(t) && /\/n\/\d+/.test(t), t);
  check('　 結果底下有「找這個題目的技術與聯絡人」按鈕（洽案一步到位）', chipTexts(out).includes('技術關鍵字：機器人'), JSON.stringify(chipTexts(out)));

  out = await dm('U2', '新聞關鍵字：半導體');
  check('按範例「半導體」→ 直接查（不需要旗標）', /工研院新聞｜「半導體」/.test(allText(out)), allText(out));

  state.itriHtml = '';
  out = await dm('U2', '新聞關鍵字：量子火箭引擎');
  check('新聞查無資料 → 老實說沒有，給窗口與找真人，沒有導去產業趨勢', /沒有找到跟「量子火箭引擎」直接相關的報導/.test(allText(out)) && /找真人/.test(allText(out)) && !chips(out).some((c) => /趨勢/.test(c.label)), allText(out));
  out = await dm('U2', '近期工研院新聞');
  check('最新清單讀不到 → 誠實說，附官網新聞中心連結（不是空白）', /暫時抓不到|暫時讀不到/.test(allText(out)) && /DisplayStyle=06/.test(allText(out)), allText(out));
  state.itriHtml = state.itriHtml || undefined;
}
seed(); await fresh();
{
  state.itriFetchFail = true;
  const out = await dm('U2b', '近期工研院新聞');
  check('官網新聞中心連不上 → 誠實說抓不到，不噴例外', /暫時抓不到工研院官網/.test(allText(out)) && /DisplayStyle=06/.test(allText(out)), allText(out));
  state.itriFetchFail = false;
}

// ═══ 七、不誤觸、不答非所問（使用者角度）═══════════════════════════════════════
console.log('\n── 七、不誤觸、不答非所問 ──');
seed(); await fresh();
{
  // 7-1 按了按鈕之後，記者其實是問別的事：不能被當關鍵字吃掉
  await dm('U3', '近期工研院新聞');
  let out = await dm('U3', '這場記者會幾點開始？');
  check('★ 按了「近期工研院新聞」後問「這場記者會幾點開始？」→ 不被當關鍵字去搜新聞', !/工研院新聞｜「這場/.test(allText(out)) && !/沒有找到跟「這場/.test(allText(out)), allText(out).slice(0, 200));
  check('　 旗標被用掉，不會吃第二句', state.bindings.get('U3')?.note !== 'await_news_query');

  await dm('U3', '問技術與洽案');
  out = await dm('U3', '報名要怎麼報？');
  check('★ 按了「問技術與洽案」後問「報名要怎麼報？」→ 不被當技術關鍵字', !/產業服務」目前沒有找到/.test(allText(out)) && !/工研院技術｜/.test(allText(out)), allText(out).slice(0, 200));

  await dm('U3', '問技術與洽案');
  out = await dm('U3', '謝謝');
  check('按了按鈕後說「謝謝」→ 回收尾語，不拿「謝謝」去查技術', !/工研院技術｜|沒有找到跟「謝謝」/.test(allText(out)), allText(out).slice(0, 200));
  check('　 旗標被清掉', state.bindings.get('U3')?.note !== 'await_tech_query');

  await dm('U3', '問技術與洽案');
  out = await dm('U3', '回首頁');
  check('按了「問技術與洽案」又改按「回首頁」→ 旗標當場作廢', state.bindings.get('U3')?.note !== 'await_tech_query' && /已經回到首頁/.test(allText(out)), allText(out).slice(0, 100));
  out = await dm('U3b', '回首頁');
  out = await dm('U3b', '電池');
  check('　 沒有任何前文、單獨打「電池」→ 不會被當成技術查詢（走原本的主題詞複誦，給兩條路選）', /我可以從兩個方向幫您找/.test(allText(out)), allText(out).slice(0, 150));

  await dm('U3', '近期工研院新聞');
  await dm('U3', '問技術與洽案');
  check('兩顆按鈕連按 → 只剩最後一顆的旗標', state.bindings.get('U3')?.note === 'await_tech_query', state.bindings.get('U3')?.note);
  out = await dm('U3', '機器人');
  check('　 這時打關鍵字走的是技術（最後按的那顆），不是新聞', !/工研院新聞｜/.test(allText(out)));

  // 7-2 沒按按鈕就打的話：不能被攔走
  seed(); await fresh();
  for (const t of ['技術', '新聞', '今天天氣如何', '洽談時間', '你好']) {
    out = await dm('U4' + t, t);
    check(`沒按按鈕直接打「${t}」→ 不會冒出技術清單或新聞清單`, !/📰|🔬 工研院技術/.test(allText(out)), allText(out).slice(0, 120));
  }
  // 7-3 舊按鈕、舊講法：照樣動
  out = await dm('U5', '想問什麼技術');
  check('舊選單的「想問什麼技術」照樣動（LINE 上舊選單不會立刻換掉）', /想找工研院哪方面的技術/.test(allText(out)));
  await dm('U5', '想問什麼技術');
  out = await dm('U5', '給我完整新聞稿');
  check('舊選單的「給我完整新聞稿」照樣動（而且就算前面剛按過「想問什麼技術」、旗標還在等，也不會被當成關鍵字去搜）（反問要哪一場，批次 85 的功能沒壞）', /想要哪一場的完整新聞稿/.test(allText(out)), allText(out));
  out = await dm('U5', '工研院 機器人');
  check('舊的導流按鈕「工研院 機器人」照樣動（查新聞）', /工研院新聞｜「機器人」/.test(allText(out)), allText(out).slice(0, 120));
  out = await dm('U5', '工研院在機器人技術上有什麼進展');
  check('自然語言問研發進展 → 仍然查新聞（官網新聞才有「進展」）', /工研院新聞｜/.test(allText(out)), allText(out).slice(0, 120));

  // 7-4 剛看完技術清單，只打一個題目 → 繼續找技術（不是突然變成找新聞）
  await dm('U6', '技術領域：綠能與環境');
  out = await dm('U6', '電池');
  check('★ 看完技術清單後只打「電池」→ 繼續找技術，不變成新聞', /工研院技術｜「電池」/.test(allText(out)) && !/工研院新聞｜/.test(allText(out)), allText(out).slice(0, 150));
  await dm('U6', '技術領域：綠能與環境');
  out = await dm('U6', '工研院電池的最新新聞');
  check('　 但句子明講「新聞」→ 照樣查新聞', /工研院新聞｜/.test(allText(out)), allText(out).slice(0, 150));

  // 7-4b 明確按「新聞關鍵字」「📰 ＸＸ的新聞」按鈕：絕不能被「剛看過技術清單」的接續判斷改走技術（實測抓到的）
  await dm('U6', '技術領域：綠能與環境');
  out = await dm('U6', '新聞關鍵字：機器人');
  check('★ 剛看完技術清單，按「📰 ＸＸ的新聞」按鈕 → 一定是新聞（不被改走技術）', /工研院新聞｜「機器人」/.test(allText(out)) && !/工研院技術｜|產業服務」目前沒有/.test(allText(out)), allText(out).slice(0, 150));
  await dm('U6', '技術領域：綠能與環境');
  out = await dm('U6', '近期工研院新聞 第2頁');
  check('　 剛看完技術清單，按新聞翻頁 → 一定是新聞', /近期工研院新聞（共/.test(allText(out)) || /沒有更多/.test(allText(out)), allText(out).slice(0, 150));

  // 7-4c 自然語言的講法：殘留「做」「在」也要查得到
  await fresh();
  await dm('U8', '問技術與洽案');
  out = await dm('U8', '幫我找可以做電池的技術');
  check('★ 「幫我找可以做電池的技術」→ 去掉泛稱與開頭的「做」後查得到「電池」', /工研院技術｜「電池」/.test(allText(out)) && /電池電極奈米塗層技術/.test(out.map((o) => o.text || '').join('')), allText(out).slice(0, 150));
  out = await dm('U8', '技術關鍵字：有機太陽能');
  check('「有機」「無人」開頭的真技術詞不會被誤砍字（查無時回覆仍引用使用者原本打的字）', /「有機太陽能」/.test(allText(out)), allText(out).slice(0, 150));

  // 7-4d 自然語言「找技術、談合作」→ 技術與洽案；「進展／新聞」→ 新聞（規則分，不靠模型）
  await fresh();
  out = await dm('U9', '工研院有沒有電池的技術可以合作');
  check('★ 自然語言「工研院有沒有電池的技術可以合作」→ 技術與洽案（有聯絡人信箱），不是新聞', /工研院技術｜「電池」/.test(allText(out)) && /yuchiw@itri\.org\.tw/.test(allText(out)) && !/工研院新聞｜/.test(allText(out)), allText(out).slice(0, 150));
  out = await dm('U9', '工研院在電池技術上有什麼進展');
  check('　 「工研院在電池技術上有什麼進展」→ 新聞（明講進展）', /工研院新聞｜/.test(allText(out)) && !/工研院技術｜/.test(allText(out)), allText(out).slice(0, 150));
  out = await dm('U9', '工研院半導體有什麼新聞嗎');
  check('　 「工研院半導體有什麼新聞嗎」→ 新聞', /工研院新聞｜「半導體」/.test(allText(out)), allText(out).slice(0, 150));

  // 7-5 綁定中：不動活動綁定，回頭問活動照常答
  seed(); await fresh();
  state.bindings.set('U7', { event_id: 'past3', media_name: '', note: '', bound_at: Date.now() });
  out = await dm('U7', '問技術與洽案');
  check('綁定某場活動時按「問技術與洽案」→ 照樣給領域按鈕', /想找工研院哪方面的技術/.test(allText(out)));
  out = await dm('U7', '技術領域：綠能與環境');
  check('　 列出技術，不被塞進這一場的問答', /藻類回收技術/.test(allText(out)) && !hasAnswer(out));
  check('　 活動綁定沒被打亂', state.bindings.get('U7')?.event_id === 'past3', JSON.stringify(state.bindings.get('U7')));
  out = await dm('U7', '這場的重點是什麼');
  check('　 回頭問活動 → 照樣由這一場回答', out.some((o) => o.kind === 'answer' && o.event === 'past3'), JSON.stringify(out.map((o) => o.kind + (o.event || ''))));
  out = await dm('U7', '近期工研院新聞');
  check('綁定時按「近期工研院新聞」→ 給全院新聞，不被釘回這一場', /近期工研院新聞（共/.test(allText(out)) && !hasAnswer(out), allText(out).slice(0, 100));
}

// ═══ 八、群組 ═════════════════════════════════════════════════════════════════
console.log('\n── 八、群組 ──');
seed(); await fresh();
{
  const G = 'Cg121';
  let out = await g(G, 'Ualice', '@米亞 問技術與洽案', { mention: true });
  check('群組 @ 米亞「問技術與洽案」→ 問領域，附按鈕', /想找工研院哪方面的技術/.test(allText(out)) && chips(out).filter((c) => /^技術領域：/.test(c.text)).length === 6, allText(out).slice(0, 100));
  check('　 旗標記了是誰按的（別人的話不會被吃掉）', state.bindings.get(G)?.note === 'await_tech_query#Ualice', state.bindings.get(G)?.note);

  out = await g(G, 'Ubob', '電池');
  check('★ 換 Bob 說「電池」（沒 @）→ 不被當成 Alice 要查的關鍵字，米亞不插話', out.length === 0, allText(out));
  out = await g(G, 'Ubob', '技術領域：綠能與環境');
  check('★ Bob 按領域按鈕（沒 @）→ 按鈕任何人按都算數', /藻類回收技術/.test(allText(out)), allText(out).slice(0, 100));
  out = await g(G, 'Ualice', '電池');
  check('Alice 自己回來打「電池」→ 照樣查得到（守門沒把正主擋掉）', /電池電極奈米塗層技術/.test(allText(out)), allText(out).slice(0, 100));

  out = await g(G, 'Ucarol', '近期工研院新聞');
  check('群組裡有人按選單上的「近期工研院新聞」（沒 @）→ 回新聞清單', /近期工研院新聞（共/.test(allText(out)) && /\/n\/\d+/.test(allText(out)), allText(out).slice(0, 100));
  out = await g(G, 'Udave', '近期工研院新聞 第2頁');
  check('別人按「更多新聞」（沒 @）→ 照樣翻頁（第二頁沒有資料時老實說）', texts(out).length === 1, allText(out));
  out = await g(G, 'Udave', '技術領域：通訊與光電 第2頁');
  check('別人按「更多技術」（沒 @）→ 翻到第 2 頁', /第 6–10 項/.test(allText(out)), allText(out).slice(0, 100));

  // 群組裡同事之間的閒聊：不能被插話
  const G2 = 'Cchat121';
  await g(G2, 'Ualice', '@米亞 你好', { mention: true }); // 開啟續問視窗
  for (const t of ['這個技術很有趣', '新聞稿我晚點寄給你', '洽談時間再確認', '我們有技術合作的案子', '工研院新聞好像有寫', '技術領域這個詞好難', '待會看新聞']) {
    out = await g(G2, 'Ubob', t);
    check(`★ 群組閒聊「${t}」→ 米亞不插話`, out.length === 0, allText(out));
  }
  const G3 = 'Cquiet121';
  for (const t of ['問技術與洽案', '近期工研院新聞']) {
    out = await g(G3, 'Ux', t);
    check(`群組沒 @、視窗沒開，但打的是選單上的字「${t}」→ 有回應（按鈕永遠不沉默）`, texts(out).length >= 1, allText(out));
  }
  out = await g('Cquiet2', 'Ux', '我想問技術上的問題');
  check('★ 群組沒 @ 打一般句子（含「技術」）→ 安靜', out.length === 0, allText(out));
}

// ═══ 九、繁體字防線與版面 ════════════════════════════════════════════════════
console.log('\n── 九、出口：繁體字、長度、按鈕上限 ──');
{
  const simp = tech.formatTechReply({ items: [{ id: '1', title: '机器人关键技术', intro: '实现软件开发与数据处理', contactName: '王大明', email: 'a@itri.org.tw', url: shortLink.shortTechUrl('1') }], total: 1, page: 1, label: '通讯与光电' });
  check('★ 技術清單出口接了繁體防線：官網萬一混進簡體，送出去的是繁體', /機器人關鍵技術/.test(simp) && !SIMPLIFIED_RE.test(simp), simp);
  const simpNews = news.formatNewsReply({ items: [{ id: '115', title: '工研院发布机器人', date: '2026/10/01', abstract: '软件与数据', url: 'x' }], total: 1, page: 1 });
  check('★ 新聞清單出口也接了：簡體 → 繁體', /工研院發布機器人/.test(simpNews) && !SIMPLIFIED_RE.test(simpNews), simpNews);
  check('專有名詞不被改壞（信箱、網址原樣）', toTraditionalTW(simp) === simp && /a@itri\.org\.tw/.test(simp) && /https:\/\/itri-event-ai\.vercel\.app\/t\/1/.test(simp));

  seed(); await fresh();
  const all = [];
  for (const m of ['問技術與洽案', '技術領域：通訊與光電', '技術領域：綠能與環境', '近期工研院新聞', '新聞關鍵字：機器人']) all.push(...texts(await dm('Uzh', m)));
  check('實際送出的每一則都沒有簡體字', all.every((o) => !SIMPLIFIED_RE.test(o.text)), all.find((o) => SIMPLIFIED_RE.test(o.text))?.text.slice(0, 80));
  check('每一則都在 LINE 單則 5000 字內', all.every((o) => o.text.length < 4500), String(Math.max(...all.map((o) => o.text.length))));
  check('每則的快速回覆都在 13 顆內、label 在 20 字內', all.every((o) => (o.quickReply || []).length <= 13 && (o.quickReply || []).every((c) => String(c.label || c).length <= 20)),
    JSON.stringify(all.map((o) => (o.quickReply || []).length)));
  check('沒有 Markdown 符號（LINE 不會渲染）', all.every((o) => !/\*\*|^#{1,3} |`/m.test(o.text)));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 121 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
