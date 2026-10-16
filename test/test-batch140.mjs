// 批次 140：記者名單——名片翻拍（拍照 → AI 讀出欄位 → 比對名單 → 人按了才新增／更新）。
//   一、純函式（lib/card-scan.js）：圖片檢查、模型輸出清理、比對、差異、遮罩
//   二、後端（真的 api/media.js；只有 Google Sheets 與 Anthropic 是假的）：card_scan、card_match、update_contact、add 補電話與職稱
//   三、頁面：入口與函式都在、事件不漏接
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const MEDIA = fs.readFileSync(path.join(ROOT, 'public/media.html'), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.ANTHROPIC_API_KEY = 'sk-test';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

const cs = await import('../lib/card-scan.js');
const jpeg = (n = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const dataUrl = (buf, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('\n── 一、圖片檢查、清理、比對 ──');
{
  let r = cs.parseImageInput(dataUrl(jpeg()));
  check('收 data URL 的 JPEG，回真實格式與純 base64', r.mime === 'image/jpeg' && !r.b64.includes(',') && !r.error, JSON.stringify(r).slice(0, 100));
  r = cs.parseImageInput(jpeg().toString('base64'));
  check('　 純 base64（沒有 data: 開頭）也收', r.mime === 'image/jpeg');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
  check('　 PNG、WebP 認得', cs.parseImageInput(dataUrl(png, 'image/png')).mime === 'image/png'
    && cs.parseImageInput(dataUrl(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200)]), 'image/webp')).mime === 'image/webp');
  check('★ 不是圖片的檔（PDF、文字）擋下，不送去給模型', !!cs.parseImageInput(dataUrl(Buffer.from('%PDF-1.4' + 'x'.repeat(300)), 'application/pdf')).error
    && !!cs.parseImageInput(dataUrl(Buffer.from('hello'.repeat(100)))).error);
  check('　 宣稱 PNG 實際是 JPEG → 擋下（選錯檔）', !!cs.parseImageInput(dataUrl(jpeg(), 'image/png')).error);
  check('　 空的、太小、亂碼都擋下並說人話', ['', null, 'data:image/jpeg;base64,', 'data:image/jpeg;base64,@@@@', dataUrl(Buffer.from([0xff, 0xd8, 0xff]))].every((x) => cs.parseImageInput(x).error));
  const big = cs.parseImageInput(dataUrl(jpeg(cs.MAX_IMAGE_BYTES + 10)));
  check('　 超過 3 MB 擋下並建議重拍', /太大/.test(big.error || ''), big.error);

  const req = cs.buildCardRequest({ mime: 'image/jpeg', b64: 'AAAA' });
  check('請求：用 Haiku、關 thinking、圖片在前文字在後；system 明講不准猜',
    req.model === 'claude-haiku-5-5' && req.thinking.type === 'disabled' && req.messages[0].content[0].type === 'image'
    && req.messages[0].content[0].source.media_type === 'image/jpeg' && /不要猜/.test(req.system));

  let c = cs.cleanCard({ name: ' 王  小明 ', outlet: '联合报', title: '记者', email: ' Wang＠UDN.com ', phone: '0912-345-678 轉 12' });
  check('清理：空白縮成一格；mail 修成小寫半形；簡體字轉繁體（只轉字）',
    c.name === '王 小明' && c.outlet === '聯合報' && c.title === '記者' && c.email === 'wang@udn.com', JSON.stringify(c));
  check('　 電話只留數字與 + - ( ) # 空白', /^[\d+\-()#\s]+$/.test(c.phone) && c.phone.startsWith('0912-345-678'), c.phone);
  c = cs.cleanCard({ name: 'A', email: 'wang.udn.com', phone: '12' });
  check('★ 不信模型：mail 格式不對→清成空字串；電話不到 6 碼→清掉', c.email === '' && c.phone === '', JSON.stringify(c));
  check('　 亂型別（null、陣列、數字）不丟例外', ['x', null, [], 5].every((x) => { try { return !cs.cleanCard(x).name; } catch { return false; } }));

  const reply = (text, extra = {}) => ({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }], ...extra });
  check('解析：JSON 前後多講幾句、先有 thinking 區塊都讀得到', cs.parseCardReply(reply('好的：{"name":"陳小華","outlet":"中央社","title":"","email":"c@cna.com.tw","phone":""} 以上')).card?.name === '陳小華');
  check('　 全空（不是名片）→ 給人話的錯誤；不是 JSON → 也是', /沒有讀到名片/.test(cs.parseCardReply(reply('{"name":"","outlet":"","title":"","email":"","phone":""}')).error)
    && !!cs.parseCardReply(reply('我看不到')).error && !!cs.parseCardReply(reply('{壞掉')).error && !!cs.parseCardReply({}).error);
}

{
  const rows = [
    { id: 'R1', name: '吳雅婷', outlet: '三立新聞', email: 'wu@setn.com', phone: '0912-111-222', status: 'active' },
    { id: 'R2', name: '林小美', outlet: '聯合報', email: 'lin@udn.com', phone: '', status: 'left' },
    { id: 'R3', name: '林小美', outlet: '中央社', email: 'lin2@cna.com.tw', phone: '', status: 'active' },
    { id: 'R4', name: '張大同', outlet: '經濟日報', email: '', phone: '', status: 'active' },
  ];
  let m = cs.matchRoster(rows, { name: '吳雅婷', outlet: '三立', email: 'WU＠setn.com' });
  check('比對：mail 相同 → email（最可靠）', m.length === 1 && m[0].reason === 'email' && m[0].rec.id === 'R1');
  m = cs.matchRoster(rows, { name: '張大同', outlet: '經濟日報社', email: 'new@ctee.com.tw' });
  check('　 名單裡沒有 mail、同名同媒體（經濟日報 vs 經濟日報社）→ name_outlet', m.length === 1 && m[0].reason === 'name_outlet', JSON.stringify(m.map((x) => x.reason)));
  m = cs.matchRoster(rows, { name: '林小美', outlet: '聯合報', email: '' });
  check('★ 同名：同媒體排前面、不同媒體（可能轉職／同名同姓）排後面；已離職的也比對得到（不會再多建一筆）',
    m.map((x) => x.rec.id + ':' + x.reason).join() === 'R2:name_outlet,R3:name', m.map((x) => x.rec.id + ':' + x.reason).join());
  check('　 完全沒有 → 空陣列；名片沒姓名沒 mail 也不亂配', cs.matchRoster(rows, { name: '新人', email: 'n@x.com' }).length === 0 && cs.matchRoster(rows, { name: '', email: '' }).length === 0 && cs.matchRoster(null, {}).length === 0);

  let d = cs.diffCard(rows[0], { name: '吳雅婷', outlet: '三立新聞', email: 'wu@setn.com', phone: '0912-111-222' });
  check('差異：全部一樣 → 沒有要更新的', d.length === 0, JSON.stringify(d));
  d = cs.diffCard(rows[0], { name: '吳雅婷', outlet: '東森新聞', email: 'wu@ettoday.net', phone: '0912 111 222' });
  check('　 換了媒體與 mail → 兩項；電話只差空白與連字號不算不同', d.map((x) => x.field).join() === 'outlet,email', JSON.stringify(d));
  d = cs.diffCard(rows[0], { name: '', outlet: '', email: '', phone: '' });
  check('★ 名片上沒有的欄位不列（更新不會把名單原有的值洗成空白）', d.length === 0);
  d = cs.diffCard(rows[1], { name: '林小美', outlet: '聯合報', email: '', phone: '0922-333-444' });
  check('　 名單原本沒有的欄位（電話）→ 列為新增，from 是空字串', d.length === 1 && d[0].field === 'phone' && d[0].from === '', JSON.stringify(d));

  check('遮罩：mail 留第一個字與網域；電話只留後三碼；空的不出錯',
    cs.maskEmail('wu@setn.com') === 'w*@setn.com' && cs.maskEmail('') === '' && cs.maskPhone('0912-111-222').endsWith('222') && !cs.maskPhone('0912-111-222').includes('0912') && cs.maskPhone('') === '',
    [cs.maskEmail('wu@setn.com'), cs.maskPhone('0912-111-222')].join(' / '));
}

// ═══ 二、後端 ═════════════════════════════════════════════════════════════════
console.log('\n── 二、後端：card_scan、card_match、update_contact、add ──');
const { book, reset, ctl } = await import('./fakes-sheets82.mjs');
reset();
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
const media = (await import('../api/media.js')).default;
const call = async (method, q, body = {}, headers = {}) => {
  let code = 200, out;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
  await media({ method, query: q, headers, body, socket: { remoteAddress: '9.9.9.9' } }, res);
  return { code, out };
};
const A = { 'x-admin-password': 'pw' };

// 假的 Anthropic：記下收到的請求，回我們指定的內容
const realFetch = globalThis.fetch;
const sent = [];
let nextReply = null;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('api.anthropic.com')) return realFetch(url, opts);
  sent.push(JSON.parse(opts.body));
  const r = nextReply;
  return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
};
const cardReply = (o) => ({ body: { content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 900, output_tokens: 60 } } });

{
  const seed = ['id,name,outlet,beat,email,phone,invited_count,last_invited',
    'R1,吳雅婷,三立新聞,半導體,wu@setn.com,0912111222,86,2026-09-01',
    'R2,林小美,聯合報,生醫,lin@udn.com,,40,2025-01-01'].join('\n');
  let r = await call('POST', {}, { action: 'seed', csv: seed }, A);
  check('（準備）匯入兩位記者', r.code === 200 && r.out.created === 2, JSON.stringify(r.out));
  await call('POST', {}, { action: 'update', code: 'staffcode1', id: 'R2', mark: 'left' });

  // ── card_scan ──
  nextReply = cardReply({ name: '吳雅婷', outlet: '東森新聞', title: '主跑記者', email: 'Wu@ettoday.net', phone: '0912-111-222' });
  const before = JSON.stringify(book.media_roster);
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('★ card_scan：回讀出的草稿與比對結果，而且不寫任何東西（名單一個字沒動）',
    r.code === 200 && r.out.card.email === 'wu@ettoday.net' && JSON.stringify(book.media_roster) === before, JSON.stringify(r.out).slice(0, 300));
  const m = r.out.matches[0];
  check('　 比對到吳雅婷（同名、媒體不同）；差異列出媒體與 mail；同仁看到的原 mail／電話是遮過的',
    m && m.id === 'R1' && m.reason === 'name' && m.changes.map((c) => c.field).join() === 'outlet,email'
    && m.email !== 'wu@setn.com' && m.email.includes('*') && !m.phone.includes('0912') && m.changes.find((c) => c.field === 'email').from.includes('*'), JSON.stringify(m));
  check('　 送給模型的是 Haiku、圖片是 base64 JPEG', sent.at(-1).model === 'claude-haiku-5-5' && sent.at(-1).messages[0].content[0].source.media_type === 'image/jpeg');

  r = await call('POST', {}, { action: 'card_scan', password: 'pw', image: dataUrl(jpeg()) }, A);
  check('　 管理員看得到完整的原 mail', r.out.matches[0].email === 'wu@setn.com' && r.out.matches[0].changes.find((c) => c.field === 'email').from === 'wu@setn.com', JSON.stringify(r.out.matches[0]));

  nextReply = cardReply({ name: '林小美', outlet: '聯合報', title: '', email: 'lin@udn.com', phone: '' });
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('　 已離職的人也比對得到（mail 相同），並標出目前是離職狀態', r.out.matches[0]?.id === 'R2' && r.out.matches[0].reason === 'email' && r.out.matches[0].status === 'left');

  const n = sent.length;
  r = await call('POST', {}, { action: 'card_scan', image: dataUrl(jpeg()) });
  check('★ 沒帶連結代碼也沒帶密碼 → 401，而且沒有呼叫 AI（不能讓外人燒你的額度）', r.code === 401 && sent.length === n);
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: 'data:image/jpeg;base64,@@@' });
  check('　 圖片有問題 → 400，沒呼叫 AI', r.code === 400 && sent.length === n, JSON.stringify(r.out));

  nextReply = { ok: false, status: 500, body: { error: { message: 'overloaded' } } };
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('　 AI 叫不動 → 502 與人話，提示可以手動填寫', r.code === 502 && /手動填寫/.test(r.out.error), JSON.stringify(r));
  nextReply = { body: { stop_reason: 'refusal', content: [], stop_details: { category: null } } };
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('★ 模型拒答（HTTP 200、stop_reason:"refusal"）→ 不當成讀到名片，給人話', r.code === 422 && /重拍|手動/.test(r.out.error), JSON.stringify(r));
  nextReply = cardReply({ name: '', outlet: '', title: '', email: '', phone: '' });
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('　 拍的不是名片（全空）→ 422 與說明', r.code === 422 && /沒有讀到名片/.test(r.out.error));
  nextReply = cardReply({ name: '新來的', outlet: '工商時報', title: '', email: 'new@ctee.com.tw', phone: '' });
  ctl.failReads.add('media_roster');
  r = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  ctl.failReads.delete('media_roster');
  check('★ 名單讀不到：辨識結果照給（那次 AI 呼叫已經花了），比對標成沒做並說明；不能當成「名單裡沒有這位」',
    r.code === 200 && r.out.card.name === '新來的' && r.out.matches.length === 0 && /無法比對/.test(r.out.matchError), JSON.stringify(r.out));

  // ── card_match ──
  const nm = sent.length;
  r = await call('POST', {}, { action: 'card_match', code: 'staffcode1', name: '吳雅婷', outlet: '三立新聞', email: '' });
  check('card_match：改過欄位後重新比對（不呼叫 AI）', r.out.matches[0]?.reason === 'name_outlet' && sent.length === nm, JSON.stringify(r.out).slice(0, 200));
  ctl.failReads.add('media_roster');
  r = await call('POST', {}, { action: 'card_match', code: 'staffcode1', name: '吳雅婷' });
  ctl.failReads.delete('media_roster');
  check('　 名單讀不到 → 500（不能回「沒有這位」讓人又新增一筆）', r.code === 500);

  // ── update_contact ──
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', outlet: '東森新聞', email: 'Wu@Ettoday.net', phone: '0912-111-222', title: '主跑記者', updated_by: '朱朱' });
  let row = book.media_roster.find((x) => x[0] === 'R1');
  check('★ 更新：媒體、mail 換成名片上的；電話保留；路線、受邀次數、受邀日期原封不動；職稱進備註；留下更新者',
    r.code === 200 && row[2] === '東森新聞' && row[4] === 'wu@ettoday.net' && row[5] === '0912-111-222' && row[3] === '半導體' && String(row[6]) === '86' && row[11] === '職稱：主跑記者' && row[13] === '朱朱', JSON.stringify(row));
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', title: '改過的職稱' });
  check('　 備註已經有內容就不蓋掉（備註是人工填的）', book.media_roster.find((x) => x[0] === 'R1')[11] === '職稱：主跑記者');
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', phone: '0933-000-111' });
  row = book.media_roster.find((x) => x[0] === 'R1');
  check('　 只帶電話：只改電話，其他欄位不會被洗成空白', row[2] === '東森新聞' && row[4] === 'wu@ettoday.net' && row[5] === '0933-000-111');
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'lin@udn.com' });
  check('★ 新 mail 已經是另一位的 → 409 並指出是誰（不會悄悄變成兩筆同 mail）', r.code === 409 && /林小美/.test(r.out.error) && book.media_roster.find((x) => x[0] === 'R1')[4] === 'wu@ettoday.net', JSON.stringify(r.out));
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R1', email: 'wu@ettoday.net', name: '吳雅婷' });
  check('　 mail 沒變（自己的）不算重複', r.code === 200);
  r = await call('POST', {}, { action: 'update_contact', code: 'staffcode1', id: 'R2', mark: 'active', email: 'lin@udn.com.tw' });
  row = book.media_roster.find((x) => x[0] === 'R2');
  check('　 已離職的人帶 mark:active → 更新並恢復在職', r.code === 200 && row[10] === 'active' && row[4] === 'lin@udn.com.tw');
  const bad = (b) => call('POST', {}, { action: 'update_contact', code: 'staffcode1', ...b });
  check('　 擋下：缺 id、找不到、mail 格式不對、電話太短、什麼都沒帶',
    (await bad({ name: 'x' })).code === 400 && (await bad({ id: 'ZZ', name: 'x' })).code === 404 && (await bad({ id: 'R1', email: 'abc@def' })).code === 400
    && (await bad({ id: 'R1', phone: '12' })).code === 400 && (await bad({ id: 'R1' })).code === 400);
  check('　 沒帶連結代碼 → 401', (await call('POST', {}, { action: 'update_contact', id: 'R1', name: 'x' })).code === 401);
  ctl.failReads.add('media_roster');
  r = await bad({ id: 'R1', name: '讀失敗' });
  ctl.failReads.delete('media_roster');
  check('　 讀名單失敗 → 500，不寫入', r.code === 500 && book.media_roster.find((x) => x[0] === 'R1')[1] === '吳雅婷');

  // ── add 補電話、職稱 ──
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '名片新人', outlet: '工商時報', email: 'new@ctee.com.tw', phone: '02-2222-3333', title: '財經組 記者' });
  row = book.media_roster.find((x) => x[1] === '名片新人');
  check('新增：電話寫進電話欄、職稱寫進備註', r.code === 200 && row[5] === '02-2222-3333' && row[11] === '職稱：財經組 記者', JSON.stringify(row));
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '電話壞', outlet: 'x', email: 'bad@x.com', phone: '12' });
  check('　 電話格式不對 → 400，不新增', r.code === 400 && !book.media_roster.some((x) => x[1] === '電話壞'));
  r = await call('POST', {}, { action: 'add', code: 'staffcode1', name: '沒電話', outlet: 'x', email: 'nophone@x.com' });
  check('　 沒有電話也能新增（原本的流程不變）', r.code === 200);

  // ── 限流 ──
  nextReply = cardReply({ name: '限流', outlet: 'x', title: '', email: '', phone: '' });
  let last;
  for (let i = 0; i < 45; i++) last = await call('POST', {}, { action: 'card_scan', code: 'staffcode1', image: dataUrl(jpeg()) });
  check('★ 連續辨識太多張 → 429（共用連結外流時擋住無腦迴圈燒額度）', last.code === 429, last.code);
}
globalThis.fetch = realFetch;

// ═══ 三、頁面 ═════════════════════════════════════════════════════════════════
console.log('\n── 三、頁面 ──');
{
  check('有名片翻拍卡片與檔案選擇（手機會開相機）', /id="card-file"[^>]*accept="image\/\*"/.test(MEDIA) && MEDIA.includes('名片翻拍'));
  check('函式都在：onCardFile、shrinkImage、applyCardUpdate、submitCardAdd、rematchCard、clearCard',
    ['onCardFile', 'shrinkImage', 'applyCardUpdate', 'submitCardAdd', 'rematchCard', 'clearCard'].every((f) => new RegExp(`function ${f}\\(`).test(MEDIA)));
  check('★ 送出前先縮圖（長邊 1600、JPEG），不然手機原圖會超過伺服器請求上限', /1600/.test(MEDIA) && /toDataURL\('image\/jpeg'/.test(MEDIA));
  check('　 同名不同媒體的更新要先問一次「確定是同一位」', /reason === 'name' && !confirm/.test(MEDIA));
  check('　 讀出來的欄位全部過 esc()（名片上的字不能變成頁面上的 HTML）', (() => { const body = MEDIA.slice(MEDIA.indexOf('function renderCardMatches'), MEDIA.indexOf('async function rematchCard')); return body.length > 200 && !/\$\{m\.(name|outlet|email|phone|reason)\}/.test(body) && !/\$\{c\.(from|to)\}/.test(body) && /esc\(m\.name\)/.test(body) && /esc\(c\.to\)/.test(body); })());
  check('　 改了姓名／媒體／mail 會重新比對', ['card-name', 'card-outlet', 'card-email'].every((id) => new RegExp(`id="${id}"[^>]*onchange="rematchCard\\(\\)"`).test(MEDIA)));
}

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
