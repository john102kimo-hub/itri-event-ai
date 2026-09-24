// 批次 83「LINE 群組對話盤點」的回歸測試。跑真的 api/line.js（Sheets／LINE／Anthropic
// 用 test/fakes.mjs 的假版本），另外直接測真的 lib/line.js（用 ?real=1 繞過 loader 的替身）。
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

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

let seq = 0;
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
// 群組裡某人講一句話。mention：@ 米亞。回傳 { out, quote }，quote 是這則訊息的 quoteToken。
async function g(uid, text, { mention = false, groupId = 'Cg1' } = {}) {
  const q = 'qt' + (++seq);
  const message = { type: 'text', id: 'm' + seq, quoteToken: q, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(req([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId, userId: uid }, message }]), res);
  return { out: sent.slice(), quote: q };
}
async function dm(uid, text) {
  const q = 'qt' + (++seq);
  sent.length = 0;
  await handler(req([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, quoteToken: q, text } }]), res);
  return { out: sent.slice(), quote: q };
}
const answers = (out) => out.filter((s) => s.kind === 'answer');
const texts = (out) => out.filter((s) => s.kind === 'text');
const btn = (s) => (s.quickReply || []).map((i) => (typeof i === 'object' ? i.text ?? i.label : i));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 300) : ''}`); }
}

// ── 一、群組回答引用原問題 ───────────────────────────────────────────────
console.log('\n── 一、群組回答引用原問題（多人輪流問時看得出在回誰）──');
reset(); await fresh();
{
  const a = await g('U王', '半導體先進封裝技術發表會的重點是什麼？', { mention: true });
  const t = texts(a.out)[0];
  check('★ 群組回答引用了那一則問題（quoteToken）', t && t.quoteToken === a.quote, JSON.stringify(t && t.quoteToken));
  const b = await g('U李', '有哪些合作廠商？');
  check('續問視窗內別人問，也引用他自己那一則', texts(b.out)[0]?.quoteToken === b.quote);
  const c = await dm('U私訊', '半導體先進封裝技術發表會的重點是什麼？');
  check('1 對 1 不引用（只有兩個人，引用只會多佔畫面）', texts(c.out).every((s) => !s.quoteToken));
}

// ── 二、群組第一題的按鈕列 ────────────────────────────────────────────────
console.log('\n── 二、群組裡剛接上一場時，第一個答案就用群組版按鈕 ──');
reset(); await fresh();
{
  const a = await g('U王', '半導體先進封裝技術發表會', { mention: true });
  const t = texts(a.out)[0];
  check('★ 軟綁定後的第一個答案帶群組導覽（產業趨勢、問技術）——以前是 1 對 1 那排',
    t && btn(t).includes('產業趨勢分析') && btn(t).includes('想問什麼技術'), JSON.stringify(t && btn(t)));
  const sys = answers(a.out)[0]?.sys || '';
  check('第一個答案也套群組規則（精簡、不貼全文）', /多人 LINE 群組/.test(sys));
}

// ── 三、每個人各記各的上一題 ──────────────────────────────────────────────
console.log('\n── 三、群組追問：每個人接得上自己的上一題，不會接到別人的 ──');
reset(); await fresh();
{
  await g('U王', '半導體先進封裝技術發表會預計何時量產？', { mention: true });
  await g('U李', '這場有哪些合作廠商？');
  const c = await g('U王', '那良率呢？');
  const msgs = answers(c.out)[0]?.msgs || [];
  const hist = msgs.slice(0, -1).map((m) => m.content).join('｜');
  check('★ 王的追問帶上王自己的上一題', /何時量產/.test(hist), hist);
  check('★ 不會帶到李剛剛問的（別人的題目不能混進來）', !/合作廠商/.test(hist), hist);
  const d = await g('U陳', '那良率呢？');
  const hist2 = (answers(d.out)[0]?.msgs || []).slice(0, -1);
  check('陳第一次問：沒有上一題就不帶', hist2.length === 0, JSON.stringify(hist2));
  const row = [...state.bindings.entries()].find(([id]) => id === 'Cg1')?.[1];
  const j = JSON.parse(row?.groupTurns || '{}');
  check('記在 J 欄、每人一格', !!j['U王'] && !!j['U李'], Object.keys(j).join(','));
  check('I 欄（話題記憶）沒被群組追問的記憶蓋掉', !String(row?.lastTurn || '').includes('"U王"'));
}
{
  // 發問者身分拿不到（LINE 沒給 userId）→ 不記、不回放
  reset(); await fresh();
  const mk = (text, mention) => {
    const q = 'qt' + (++seq);
    const message = { type: 'text', id: 'm' + seq, quoteToken: q, text };
    if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
    return { type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: 'Cg2' }, message };
  };
  sent.length = 0; await handler(req([mk('半導體先進封裝技術發表會預計何時量產？', true)]), res);
  sent.length = 0; await handler(req([mk('那良率呢？', true)]), res);
  check('拿不到發問者是誰：不回放任何人的上一題', (answers(sent)[0]?.msgs || []).length === 1);
}

// ── 四、群組閒聊不插話 ────────────────────────────────────────────────────
console.log('\n── 四、群組成員彼此的問句：告訴路由「群組裡的人也在互相講話」──');
reset(); await fresh();
{
  await g('U王', '半導體先進封裝技術發表會', { mention: true });
  const r = await g('U陳', '你明天幾點到？');
  check('★ 問群組其他人的「你明天幾點到？」：安靜（以前會被當成在問活動時間）', r.out.length === 0, JSON.stringify(r.out.map((s) => s.text)));
  const { GROUP_CHATTER_HINT } = await import('../lib/router.js');
  check('lib/router.js 有群組提示這段文字', typeof GROUP_CHATTER_HINT === 'string' && GROUP_CHATTER_HINT.length > 20);
  const hint = String(GROUP_CHATTER_HINT || '（沒有群組提示）').slice(0, 20);
  // 看路由那一呼叫送出去的 system：用 fetch 側錄
  const orig = globalThis.fetch; const routed = [];
  globalThis.fetch = async (u, o) => { if (String(u).includes('anthropic') && o?.body?.includes('意圖判斷器')) routed.push(o.body); return orig(u, o); };
  await g('U李', '這場的良率是多少？');
  check('續問視窗內沒被叫到：路由收到群組提示', routed.some((b) => b.includes(hint)));
  routed.length = 0;
  await g('U李', '這場的良率是多少？', { mention: true });
  check('被 @ 到：不帶群組提示（明確叫了就一定回）', routed.length > 0 && routed.every((b) => !b.includes(hint)));
  routed.length = 0;
  await dm('U私訊', '半導體先進封裝技術發表會的良率是多少？');
  check('1 對 1：不帶群組提示', routed.length > 0 && routed.every((b) => !b.includes(hint)));
  globalThis.fetch = orig;
}

// ── 五、群組裡找真人 ──────────────────────────────────────────────────────
console.log('\n── 五、群組裡「找真人」：不 @ 也找得到人，但同事之間的話不會誤觸 ──');
reset(); await fresh();
{
  await g('U王', '半導體先進封裝技術發表會', { mention: true });
  const a = await g('U李', '找真人');
  check('★ 續問視窗內打「找真人」（按鈕文字）：給聯絡人', /新聞聯絡人|新聞綜合窗口/.test(texts(a.out)[0]?.text || ''), JSON.stringify(a.out.map((s) => s.text)));
  const b = await g('U李', '我要找承辦人');
  check('續問視窗內「我要找承辦人」：也給', /新聞聯絡人|新聞綜合窗口/.test(texts(b.out)[0]?.text || ''));
  const c = await g('U陳', '你不行啦哈哈');
  check('同事之間的「你不行啦」：安靜（1 對 1 會當成要找人，群組不行）', c.out.length === 0, JSON.stringify(c.out.map((s) => s.text)));
  state.bindings.get('Cg1').groupSessionUntil = Date.now() - 60000;
  const d = await g('U林', '找真人');
  check('續問視窗過期、不 @：按「找真人」這顆按鈕照樣給聯絡人', /新聞聯絡人|新聞綜合窗口/.test(texts(d.out)[0]?.text || ''));
}

// ── 六、照片不用 push ─────────────────────────────────────────────────────
console.log('\n── 六、照片跟答案同一則 reply（群組的 push 照成員人數計費）──');
reset(); await fresh();
{
  state.events.find((e) => e[0] === 'semi')[7] = 'https://x.tw/a.jpg|合照\nhttps://x.tw/b.png|特寫';
  const a = await g('U王', '半導體先進封裝技術發表會有照片可以用嗎？', { mention: true });
  const t = texts(a.out)[0];
  check('★ 群組要照片：照片跟文字同一則 reply 送出', t && /a\.jpg/.test(t.images || '') && t.isGroup === true, JSON.stringify(t));
  check('★ 群組裡沒有任何照片 push', (state.imagePushes || []).length === 0, JSON.stringify(state.imagePushes));
  check('照片那則也引用了問題', t?.quoteToken === a.quote);
}

// ── 七、群組要全文 ────────────────────────────────────────────────────────
console.log('\n── 七、群組要完整新聞稿：不整篇貼進群組，附一對一拿全文的連結 ──');
reset(); await fresh();
{
  await g('U王', '半導體先進封裝技術發表會', { mention: true });
  const a = await g('U王', '給我完整新聞稿');
  const t = texts(a.out)[0]?.text || '';
  check('★ 附上一對一的連結（程式接上的，網址一個字都不能錯）', t.includes('https://line.me/R/oaMessage/%40123abcde/?%23semi'), t);
  check('群組答案的規則要模型只給重點', /不要把全文貼進群組/.test(answers(a.out)[0]?.sys || ''));
  const v = await g('U王', '米亞，有完整版影片嗎？'); // 不用 mention：g() 的假 mention 會切掉開頭 3 個字
  const vt = texts(v.out)[0]?.text || '';
  check('問「完整版影片」不是要新聞稿：不接「完整新聞稿比較長」那段', answers(v.out).length > 0 && !/完整新聞稿比較長/.test(vt), vt);
  const b = await dm('U私訊', '半導體先進封裝技術發表會給我完整新聞稿');
  check('1 對 1 要全文：照舊給（不附一對一連結、不套群組規則）', !/oaMessage/.test(texts(b.out)[0]?.text || '') && !/多人 LINE 群組/.test(answers(b.out)[0]?.sys || ''));
  delete process.env.LINE_BASIC_ID;
  const c = await g('U王', '給我完整新聞稿');
  check('沒設定 LINE_BASIC_ID：改說加好友私訊，不給壞掉的連結', /加我好友/.test(texts(c.out)[0]?.text || '') && !/oaMessage/.test(texts(c.out)[0]?.text || ''));
  process.env.LINE_BASIC_ID = '@123abcde';
}

// ── 八、群組的「謝謝」 ────────────────────────────────────────────────────
console.log('\n── 八、群組裡道謝：教大家下次怎麼叫米亞 ──');
reset(); await fresh();
{
  const a = await g('U林', '米亞 謝謝');
  check('群組「謝謝」的回覆講清楚要 @ 或用「米亞」開頭', /@我或用「米亞」開頭/.test(texts(a.out)[0]?.text || ''), texts(a.out)[0]?.text);
  const b = await dm('U私訊', '謝謝');
  check('1 對 1 的「謝謝」照舊', /直接打給我/.test(texts(b.out)[0]?.text || ''));
}

// ── 九、真的 lib/line.js：引用失敗不能連答案一起送不出去 ─────────────────────
console.log('\n── 九、lib/line.js：引用失敗會拿掉引用再送；照片那則的按鈕掛在最後一則 ──');
{
  const L = await import(new URL('../lib/line.js?real=1', import.meta.url).href);
  const orig = globalThis.fetch; const calls = [];
  let failQuote = true, failImages = false;
  globalThis.fetch = async (u, o) => {
    const body = JSON.parse(o.body);
    calls.push({ path: String(u).replace('https://api.line.me/v2/bot', ''), body });
    const hasQuote = (body.messages || []).some((m) => m.quoteToken);
    const hasImg = (body.messages || []).some((m) => m.type === 'image');
    const bad = (failQuote && hasQuote) || (failImages && hasImg);
    return new Response(bad ? '{"message":"bad"}' : '{}', { status: bad ? 400 : 200 });
  };
  const ok = await L.replyOrPush('rtX', 'Cg', '答案', ['按鈕'], { quoteToken: 'expired' });
  check('★ 引用被拒：拿掉引用、用同一個 reply token 再送一次，答案照樣送到', ok && calls.length === 2 && calls[1].path === '/message/reply' && !calls[1].body.messages[0].quoteToken, JSON.stringify(calls.map((c) => c.path)));
  check('沒有因為引用失敗就改走 push（群組 push 要錢）', calls.every((c) => c.path !== '/message/push'));
  calls.length = 0; failQuote = false;
  await L.replyTextWithImages('rtY', 'Cg', '這是照片', ['下一題'], 'https://x.tw/a.jpg|合照\nhttps://x.tw/b.png', { quoteToken: 'q1', isGroup: true });
  const m = calls[0]?.body?.messages || [];
  check('文字＋照片一次 reply（1 則文字＋2 張照片）', calls.length === 1 && calls[0].path === '/message/reply' && m.length === 3 && m[0].type === 'text' && m[2].type === 'image');
  check('★ 按鈕掛在最後一則（LINE 只顯示最後一則的快速回覆）', !m[0].quickReply && !!m[2].quickReply);
  check('文字那則帶引用', m[0].quoteToken === 'q1');
  calls.length = 0; failImages = true;
  await L.replyTextWithImages('rtZ', 'Cg', '這是照片', ['下一題'], 'https://x.tw/a.jpg', { isGroup: true });
  check('★ 照片那則被拒（群組）：退回只送文字，不 push 照片', calls.length === 2 && calls[1].path === '/message/reply' && calls[1].body.messages.length === 1 && calls.every((c) => c.path !== '/message/push'), JSON.stringify(calls.map((c) => c.path)));
  calls.length = 0;
  await L.replyTextWithImages('rtW', 'U1', '這是照片', ['下一題'], 'https://x.tw/a.jpg', { isGroup: false });
  check('照片那則被拒（1 對 1）：文字照送、照片照舊另外 push', calls.some((c) => c.path === '/message/push' && c.body.messages[0].type === 'image'));
  globalThis.fetch = orig;
}

console.log(`\n${fail ? '❌' : '✅'} 批次 83 群組測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
