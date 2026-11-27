// 本機看報名頁右下角的米亞問答（批次 213）。
//
//   node tools/reg-ui-check/ask-preview.mjs        （預設 http://localhost:5213）
//   /register?c=demo          活動前、有邀請函 → 有米亞
//   /register?c=demo-hidden   活動前、沒有邀請函 → 沒有米亞
//
// 後端是真的 api/events.js、api/chat.js、api/event-page.js；Google Sheets 換成記憶體假試算表，
// **AI 的回答是固定的假字串**（不呼叫模型、不花錢、不碰任何正式資料）。
import { register } from 'node:module';
register('../../test/loader-82.mjs', import.meta.url);
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

Object.assign(process.env, { ADMIN_PASSWORD: 'pw', GOOGLE_SPREADSHEET_ID: 'sheet', ANTHROPIC_API_KEY: 'fake', LINE_CHANNEL_SECRET: 'testsecret' });
const ROOT = path.join(import.meta.dirname, '..', '..');
process.chdir(ROOT);

const FAKE_ANSWER = '（本機預覽的假回答）記者會訂於 14:00 開始，地點在工研院中興院區。採訪申請請洽新聞聯絡人王小明 03-5912345。';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opt);
  const events = [{ type: 'message_start', message: { usage: {} } },
    ...FAKE_ANSWER.match(/.{1,8}/g).map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

const { book, reset } = await import('../../test/fakes-sheets82.mjs');
const R = await import('../../lib/registration.js');
const handlers = {
  '/api/events': (await import('../../api/events.js')).default,
  '/api/chat': (await import('../../api/chat.js')).default,
  '/event': (await import('../../api/event-page.js')).default
};

reset(); R.resetRegistrationState();
const ev = (id, invite) => [id, '四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】本機預覽用的虛構內容', 'active', '2099-11-20',
  '', '', '', '工研院', 'edit', '14:00', '工研院中興院區', '記者會', '王小明 03-5912345', '', invite, ''];
book.events = [['id'], ev('demo', '誠摯邀請媒體朋友蒞臨採訪，14:00 於中興院區舉行。'), ev('demo-hidden', '')];
const sessions = ['A1｜2099-11-20｜14:00-15:00｜發表記者會｜201 廳｜13:30 報到', 'A2｜2099-11-20｜15:10-16:00｜技術展示與聯訪｜展示區', 'A3｜2099-11-20｜16:10-17:00｜實驗室參訪｜51 館'].join('\n');
const camp = (id) => R.campaignToRow({ id, title: '四足機器人記者會報名', status: 'open', intro: '誠摯邀請媒體朋友蒞臨採訪。', sessions_text: sessions,
  options_text: 'meal｜需要餐盒｜\nparty｜同行人數（含攝影，不含本人）｜｜number', contact: '工研院行銷傳播處 王小明 03-5912345', venue: '工研院中興院區', audience: 'media', event_id: id });
book.reg_campaigns = [R.CAMPAIGN_HEADERS, camp('demo'), camp('demo-hidden')];
book.registrations = [R.REG_HEADERS];

const PAGES = { '/register': 'register.html' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const handler = handlers[u.pathname];
  if (handler) {
    let raw = ''; for await (const c of req) raw += c;
    const out = {
      get headersSent() { return res.headersSent; },
      setHeader: (k, v) => res.setHeader(k, v), flushHeaders: () => res.flushHeaders(),
      status(c) { res.statusCode = c; return out; }, write: (x) => res.write(x), end(x) { res.end(x); return out; },
      json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return out; }, send(x) { res.end(x); return out; }
    };
    try { await handler({ method: req.method, headers: req.headers, socket: req.socket, query: Object.fromEntries(u.searchParams), body: raw ? JSON.parse(raw) : {} }, out); }
    catch (e) { console.error(e); res.statusCode = 500; res.end('{}'); }
    return;
  }
  const f = path.join(ROOT, 'public', PAGES[u.pathname] || u.pathname);
  if (!f.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(''); }
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(f)];
  if (type) res.setHeader('content-type', type);
  res.end(fs.readFileSync(f));
}).listen(Number(process.env.PORT) || 5213, () => console.log('http://localhost:' + (Number(process.env.PORT) || 5213) + '/register?c=demo'));
