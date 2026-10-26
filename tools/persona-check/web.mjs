// 四種角色在瀏覽器裡實際走一遍前台與後台（批次 144）：主管、同事、記者、想洽案的廠商。
//
//   node tools/persona-check/web.mjs                 只印結果
//   OUT=某個資料夾 node tools/persona-check/web.mjs     另外存每一步的截圖（手機尺寸）
//
// 後端是**真的 api/*.js**（全部掛上去），只有兩樣是假的：
//   - Google Sheets → test/fakes-sheets82.mjs 的記憶體試算表（記者會那本＋業發處那本）
//   - Anthropic → 這支裡的 fakeClaude()：照「誰在問、問什麼」回固定的腳本（後台助理會真的走 tool_use 迴圈、
//     名片辨識回一張名片、網頁問答回 SSE 串流）。⚠️ 驗的是畫面、權限、寫進試算表的東西與流程接不接得起來，
//     不是 AI 回答的品質。
// 跟 tools/media-ui-check 一樣不進 npm test（需要 playwright 與 Chromium，不要加進 package.json）。
import { register } from 'node:module';
register('../../test/loader-82.mjs', import.meta.url);
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
Object.assign(process.env, {
  ADMIN_PASSWORD: 'pw', GOOGLE_SPREADSHEET_ID: 'sheet', ANTHROPIC_API_KEY: 'test', B2B_SPREADSHEET_ID: 'B2B',
  LINE_CHANNEL_SECRET: 's', LINE_BASIC_ID: '@mia123',
});
delete process.env.LINE_CHANNEL_ACCESS_TOKEN; // 不要真的推 LINE

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire('/opt/node-tools/')('playwright')); }

const S = await import(path.join(ROOT, 'test', 'fakes-sheets82.mjs'));
const { book, books } = S;

// ── 日期（相對今天，不寫死）──
const iso = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const YEAR = iso(0).slice(0, 4);
const ts = (d) => new Date(Date.now() + d * 86400000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

// ── 假資料 ──────────────────────────────────────────────────────────────
const EV_HEAD = ['id', 'name', 'color', 'knowledge_base', 'status', 'created_at', 'chips', 'images', 'greeting', 'organizer', 'edit_code', 'event_time', 'venue', 'event_type', 'press_contact', 'contacts', 'invite_letter', 'invite_letter_chips'];
book.events = [EV_HEAD,
  ['med', '智慧醫療解決方案記者會', '#0F9E7A', '【新聞稿】工研院今天發表 AI 輔助診斷平台，已在三家醫院試行。', 'active', iso(7), '這場的重點是什麼？', '', '', '工研院', 'code3', '14:00-15:30', '工研院中興院區 51 館', 'press', '王小明 03-5911111', '', '', ''],
  ['semi', '半導體先進封裝技術發表會', '#0F9E7A', '【新聞稿】先進封裝…', 'active', iso(-4), '', '', '', '工研院', 'code2', '10:00', '台北國際會議中心', 'press', '陳大文 03-2222222', '', '', ''],
  ['drafty', '還在準備的草稿活動', '#0F9E7A', '', 'draft', iso(30), '', '', '', '工研院', 'code9', '', '', '', '', '', '', ''],
];
book.media_roster = [['id', 'name', 'outlet', 'beat', 'email', 'phone', 'invited_count', 'confirmed_count', 'declined_count', 'last_invited', 'status', 'note', 'updated_at', 'updated_by'],
  ['R1', '林小美', '經濟日報', '半導體', 'mei.lin@udn.com', '0912000111', '6', '3', '0', iso(-40), 'active', '', '', ''],
  ['R2', '張大同', '中央社', '', 'tung@cna.com.tw', '', '1', '0', '0', iso(-500), 'active', '', '', ''],
];
book.media_settings = [['key', 'value'], ['staff_code', 'staffcode1']];
book.qa_log = [['time', 'event_id', 'event_name', 'media', 'question', 'answer', 'deleted', 'source', 'name'],
  // 已經辦完的那場有真的記者問答；活動前兩天同仁打的 hi 不算成效（批次 170：主管快看的題數要跟首頁一樣）
  [ts(-6), 'semi', '半導體先進封裝技術發表會', 'hi', '測試', '好的', '', 'line', ''],
  [ts(-4), 'semi', '半導體先進封裝技術發表會', '中央社', '封裝良率多少？', '九成以上。', '', 'line', '張大同'],
  [ts(-3), 'semi', '半導體先進封裝技術發表會', '經濟日報', '量產時程？', '明年第二季。', '', 'web', '林小美'],
];

// ── 假的 Anthropic ─────────────────────────────────────────────────────
const ai = { calls: [] };
const realFetch = globalThis.fetch;
const jsonRes = (o, status = 200) => ({ ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => o, text: async () => JSON.stringify(o), clone() { return jsonRes(o, status); } });
const msg = (content, stop_reason = 'end_turn') => jsonRes({ id: 'msg_' + Math.random(), type: 'message', role: 'assistant', model: 'fake', content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name, input) => msg([{ type: 'text', text: '我查一下。' }, { type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input }], 'tool_use');
const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && typeof messages[i].content === 'string') return messages[i].content.split('\n').at(-1);
  return '';
};

// 後台助理的腳本：像一個「照規矩來」的模型——先用工具查、要寫入就提議、工具回錯就照錯誤訊息改。
function assistantTurn(body) {
  const last = body.messages.at(-1);
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const prevUse = body.messages.at(-2).content.find((b) => b.type === 'tool_use');
    let r; try { r = JSON.parse(last.content[0].content); } catch { r = {}; }
    if (prevUse.name === 'propose_action') {
      if (r.ok) return msg([{ type: 'text', text: '我準備好了，請看下面的卡片、確認沒問題再按確認。' }]);
      // 工具說日期格式不對：照錯誤訊息改成 YYYY-MM-DD 再提議一次（模型知道今天是哪一天）
      if (/YYYY-MM-DD/.test(r.error || '') && prevUse.input.event_date && !/^\d{4}-/.test(prevUse.input.event_date)) {
        const [m, d] = prevUse.input.event_date.split('/');
        return toolUse('propose_action', { ...prevUse.input, event_date: `${YEAR}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` });
      }
      return msg([{ type: 'text', text: `沒辦法做：${r.error}` }]);
    }
    if (prevUse.name === 'list_events') return msg([{ type: 'text', text: `**目前有 ${r.total} 場活動**：\n${(r.events || []).map((e) => `- ${e.name}（${e.status_label}）`).join('\n')}` }]);
    if (prevUse.name === 'questions') return msg([{ type: 'text', text: `最近 ${r.days} 天記者問了 ${r.total} 題，疑似沒答到 ${r.unanswered} 題。` }]);
    if (prevUse.name === 'reporters') return msg([{ type: 'text', text: `名單共 ${r.stats?.total} 位，${r.stats?.without_beat} 位還沒有路線。` }]);
    return msg([{ type: 'text', text: '查好了：' + JSON.stringify(r).slice(0, 200) }]);
  }
  const q = lastUserText(body.messages);
  if (/刪除|刪掉/.test(q)) return msg([{ type: 'text', text: '刪除我做不到喔，請到後台活動卡片上操作。' }]);
  if (/新增.*記者/.test(q)) return toolUse('propose_action', { kind: 'add_reporter', name: '王曉明', outlet: '中國時報', email: 'Wang.XM＠chinatimes.com', beat: '半導體' });
  if (/草稿/.test(q)) return toolUse('propose_action', { kind: 'create_event_draft', name: '量子運算前瞻論壇', event_date: '11/20', venue: '工研院中興院區' });
  if (/記住/.test(q)) return toolUse('propose_action', { kind: 'remember', content: '「四足」指的是經濟部四足機器人那場記者會' });
  if (/問了什麼|問答/.test(q)) return toolUse('questions', { days: 7 });
  if (/名單|記者/.test(q)) return toolUse('reporters', {});
  if (/活動/.test(q)) return toolUse('list_events', {});
  return msg([{ type: 'text', text: '這題我查不到，如果你告訴我答案，我可以記起來。' }]);
}

function sse(text) {
  const enc = new TextEncoder();
  const evs = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...[...text].reduce((a, ch, i) => { if (i % 6 === 0) a.push(''); a[a.length - 1] += ch; return a; }, []).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({ start(c) { for (const e of evs) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); c.close(); } });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('api.anthropic.com')) {
    if (u.startsWith('http://localhost')) return realFetch(url, opts);
    return jsonRes({}, 500); // 其他外部網站（官網、IEK…）一律當成連不上，不打真的網路
  }
  const body = JSON.parse(opts.body);
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system || '');
  ai.calls.push({ body, sys });
  if ((body.tools || []).some((t) => t.name === 'propose_action')) return assistantTurn(body);
  if (sys.includes('名片辨識助手')) return msg([{ type: 'text', text: '{"name":"林小美","outlet":"經濟日報","title":"產業中心 資深記者","email":"meimei.lin@udn.com","phone":"0912-345-678"}' }]);
  const q = lastUserText(body.messages);
  const text = /發言人/.test(q) ? '這部分我沒有資料，建議洽現場新聞聯絡人 王小明 03-5911111。' : '這場記者會將發表 AI 輔助診斷平台，已在三家醫院試行。\n\n內容僅供參考，以工研院官網新聞稿或發言為準。';
  return body.stream ? sse(text) : msg([{ type: 'text', text }]);
};

// ── 伺服器：public/ 靜態檔＋vercel.json 的 rewrites＋全部 api/*.js ──────────
const rewrites = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites || [];
const handlers = {};
async function api(name) {
  if (!(name in handlers)) {
    const f = path.join(ROOT, 'api', `${name}.js`);
    handlers[name] = fs.existsSync(f) ? (await import(f)).default : null;
  }
  return handlers[name];
}
function fakeRes(res) {
  let code = 200;
  const out = {
    setHeader: (k, v) => res.setHeader(k, v), getHeader: (k) => res.getHeader(k), status(c) { code = c; return out; },
    json(o) { if (!res.headersSent) { res.statusCode = code; res.setHeader('content-type', 'application/json'); } res.end(JSON.stringify(o)); return out; },
    send(x) { if (!res.headersSent) res.statusCode = code; res.end(x); return out; }, end(x) { if (!res.headersSent) res.statusCode = code; res.end(x); return out; },
    write: (x) => res.write(x), flushHeaders: () => { res.statusCode = code; res.flushHeaders(); }, redirect(c, loc) { res.statusCode = typeof c === 'number' ? c : 302; res.setHeader('location', loc || c); res.end(); return out; },
  };
  return out;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  let u = new URL(req.url, 'http://x');
  const rw = rewrites.find((r) => r.source === u.pathname);
  if (rw) { const d = new URL(rw.destination, 'http://x'); for (const [k, v] of u.searchParams) d.searchParams.set(k, v); u = d; }
  const m = u.pathname.match(/^\/api\/([\w-]+)$/);
  if (m) {
    const h = await api(m[1]);
    if (!h) { res.statusCode = 404; return res.end('{}'); }
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
    try { await h({ method: req.method, url: u.pathname + u.search, query: Object.fromEntries(u.searchParams), headers: req.headers, body, socket: { remoteAddress: '1.1.1.1' } }, fakeRes(res)); }
    catch (e) { console.error(`[api/${m[1]}]`, e); if (!res.headersSent) { res.statusCode = 500; res.end('{}'); } }
    return;
  }
  const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(''); }
  res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// ── 斷言與截圖 ──
let pass = 0, fail = 0; const failures = [];
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`✅ ${label}`); } else { fail++; failures.push(label); console.log(`❌ ${label}${detail ? '\n   ' + String(detail).slice(0, 400) : ''}`); } };
const OUT = process.env.OUT;
const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, name), fullPage: false }); } };
const rows = (tab, b = book) => (b[tab] || []).slice(1).filter((r) => r && r.some((c) => c !== '' && c != null));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const errors = [];
async function newPage(tag, { viewport = { width: 390, height: 844 } } = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return page;
}
// 名片照片：一張 600×360 的白底 PNG（前端會先縮圖、轉成 JPEG 再送，跟真的手機照片走同一條路）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
const cardPng = (() => { const p = new PNG({ width: 600, height: 360 }); p.data.fill(255); const f = path.join(TMP, 'card.png'); fs.writeFileSync(f, PNG.sync.write(p)); return f; })();

// ═══ 角色一：主管（後台＋右下角的米亞助理）═════════════════════════════════
console.log('\n── 主管：後台與米亞助理 ──');
{
  const page = await newPage('主管');
  await page.goto(`${base}/admin`);
  check('還沒登入：右下角看不到米亞', !(await page.locator('#mia-fab').isVisible().catch(() => false)));
  await page.fill('#pwd-input', 'wrong'); await page.click('.login-btn');
  await page.waitForSelector('#login-error', { state: 'visible' });
  check('密碼打錯 → 顯示「密碼錯誤」、沒進後台', await page.locator('#login-error').isVisible());
  await page.fill('#pwd-input', 'pw'); await page.click('.login-btn');
  await page.waitForSelector('#app', { state: 'visible' });
  await page.waitForSelector('#mia-fab', { state: 'visible', timeout: 5000 });
  check('登入後台 → 右下角出現米亞', await page.locator('#mia-fab').isVisible());
  const fabBox = await page.locator('#mia-fab').boundingBox(), moreBox = await page.locator('#nav-more-btn').boundingBox();
  const overlap = fabBox && moreBox && !(fabBox.y + fabBox.height <= moreBox.y || moreBox.y + moreBox.height <= fabBox.y || fabBox.x + fabBox.width <= moreBox.x || moreBox.x + moreBox.width <= fabBox.x);
  check('★ 手機版：米亞按鈕不能蓋住底部選單的「更多」（記者名單、活動報名、登出都在裡面）', moreBox && !overlap, JSON.stringify({ fabBox, moreBox }));
  // 捲到最底：最後一段內容不能躲在米亞按鈕底下（手機上捲到底，右下角的「顯示全部」連結以前被蓋住）
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  const lastBottom = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#main *')].filter((e) => e.offsetParent && e.getBoundingClientRect().height > 0 && getComputedStyle(e).position !== 'fixed');
    return Math.max(...els.map((e) => e.getBoundingClientRect().bottom));
  });
  const fabTop = (await page.locator('#mia-fab').boundingBox()).y;
  check('★ 手機版捲到最底：最後一段內容在米亞按鈕上方，不會被蓋住', lastBottom <= fabTop + 1, JSON.stringify({ lastBottom, fabTop }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#nav-more-btn');
  check('　 點得到「更多」、面板打開', await page.locator('.more-pop').isVisible().catch(() => false));
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('.more-backdrop').catch(() => {});

  // 批次 147：編輯活動——快速提問在知識庫下面就看得到（不用打開「進階設定」），而且即時列出記者現在會看到的按鈕
  await page.evaluate(() => showEditModal('med'));
  await page.waitForSelector('#event-modal', { state: 'visible' });
  check('★ 編輯視窗打開時米亞先躲起來（不再壓住右下角的「儲存」）', !(await page.locator('#mia-fab').isVisible()));
  const chipsBox = page.locator('#input-chips');
  await chipsBox.scrollIntoViewIfNeeded();
  await chipsBox.fill(''); // 這場本來有一題自訂的；先清空，看「留空時系統自動出題」
  check('★ 「快速問題按鈕」不在收合的「進階設定」裡，打開編輯視窗就看得到', await chipsBox.isVisible() && !(await page.evaluate(() => !!document.getElementById('input-chips').closest('details'))));
  await page.waitForFunction(() => /自動出題/.test(document.getElementById('chips-preview').textContent), null, { timeout: 5000 }).catch(() => {});
  const autoTxt = await page.locator('#chips-preview').textContent();
  check('　 欄位留空 → 下面列出系統依知識庫自動出的題（記者現在看到的）', /自動出題/.test(autoTxt) && /這次活動的重點是什麼？/.test(autoTxt) && /活動的時間和地點？/.test(autoTxt), autoTxt);
  await shot(page, 'boss-6-chips-preview.png');
  await chipsBox.fill('這場的發言人是誰？\n有提供停車位嗎？');
  await page.waitForFunction(() => /有提供停車位嗎/.test(document.getElementById('chips-preview').textContent), null, { timeout: 5000 }).catch(() => {});
  const customTxt = await page.locator('#chips-preview').textContent();
  check('　 自己打了題目 → 預覽馬上換成「用你填的題目」那兩顆', /用你填的題目/.test(customTxt) && /有提供停車位嗎？/.test(customTxt) && !/這次活動的重點是什麼？/.test(customTxt), customTxt);
  await chipsBox.fill('');
  await page.evaluate(() => { modalBaseline = snapshotForm(); closeModal(); });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('mia-fab')).display !== 'none', null, { timeout: 3000 }).catch(() => {});
  check('　 關掉編輯視窗 → 米亞回來', await page.locator('#mia-fab').isVisible());

  // 批次 147：長按米亞可以拖到別的地方，放開後記住位置；點一下照樣打開對話
  let fb = await page.locator('#mia-fab').boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.move(120, 330, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  fb = await page.locator('#mia-fab').boundingBox();
  check('★ 長按米亞 → 拖到哪就放在哪', Math.abs(fb.x + fb.width / 2 - 120) < 4 && Math.abs(fb.y + fb.height / 2 - 330) < 4, JSON.stringify(fb));
  check('　 放開不會順便打開對話框', !(await page.locator('#mia-panel.open').count()));
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.move(200, 600, { steps: 4 }); await page.mouse.up();
  const fb2 = await page.locator('#mia-fab').boundingBox();
  check('　 沒有長按就滑動 → 不會被拖走（跟一般滑動頁面一樣）', Math.abs(fb2.x - fb.x) < 2 && Math.abs(fb2.y - fb.y) < 2, JSON.stringify(fb2));
  await page.reload();
  await page.waitForSelector('#mia-fab', { state: 'visible' });
  const fb3 = await page.locator('#mia-fab').boundingBox();
  check('★ 重新整理之後還在剛剛拖到的位置', Math.abs(fb3.x - fb.x) < 4 && Math.abs(fb3.y - fb.y) < 4, JSON.stringify([fb, fb3]));
  await page.mouse.move(fb3.x + fb3.width / 2, fb3.y + fb3.height / 2);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.move(380, 830, { steps: 6 }); await page.mouse.up();
  const fb4 = await page.locator('#mia-fab').boundingBox();
  const navTop = (await page.locator('#sidebar').boundingBox()).y;
  check('　 拖到最底下也會被擋在底部選單上方、不會跑出畫面', fb4.y + fb4.height <= navTop && fb4.x + fb4.width <= 390, JSON.stringify({ fb4, navTop }));
  await shot(page, 'boss-7-drag.png');
  // 放回預設位置，後面的步驟照原本的版面走
  await page.evaluate(() => { localStorage.removeItem('mia_fab_pos_v1'); });
  await page.reload();
  await page.waitForSelector('#mia-fab', { state: 'visible' });
  await shot(page, 'boss-1-admin.png');

  await page.click('#mia-fab');
  await page.waitForSelector('#mia-panel.open');
  check('點米亞 → 對話框打開：三顆大按鈕（主管快看）＋三個常用問題；輸入框上方的小按鈕列還不出現', (await page.locator('.mia-big button').count()) === 3 && (await page.locator('.mia-chips button').count()) === 3 && !(await page.isVisible('#mia-quick')));
  // 主管快看（批次 170）：按了直接出程式算好的圖卡，不經過 AI
  await page.click('.mia-big button:has-text("一分鐘看成效")');
  await page.waitForSelector('.mia-brief');
  const kpiCard = (await page.locator('.mia-brief').last().textContent()) || '';
  const homeQa = (await page.textContent('#stat-total-qa')) || '';
  check('★ 按「一分鐘看成效」→ 成效圖卡（數字方塊、各場長條、打開互動簡報），題數跟後台首頁的「記者問答」同一個數字', /成效一覽/.test(kpiCard) && /記者提問/.test(kpiCard) && kpiCard.includes(homeQa.trim() + '題') && /打開完整互動簡報/.test(kpiCard), kpiCard + ' / 首頁 ' + homeQa);
  check('　 對話開始後，輸入框上方出現三顆小按鈕', await page.isVisible('#mia-quick') && (await page.locator('#mia-quick button').count()) === 3);
  await page.click('#mia-quick button[title="活動近況"]');
  await page.waitForFunction(() => document.querySelectorAll('.mia-brief').length >= 2);
  const evCard = (await page.locator('.mia-brief').last().textContent()) || '';
  check('按「📅 活動近況」→ 列出接下來的活動與準備狀況', /活動近況/.test(evCard) && /接下來/.test(evCard), evCard);
  await shot(page, 'boss-2b-brief.png');
  const ask = async (text) => {
    const before = await page.locator('#mia-msgs .mia-m').count();
    await page.fill('#mia-input', text); await page.press('#mia-input', 'Enter');
    await page.waitForFunction((n) => !document.querySelector('.mia-m.busy') && document.querySelectorAll('#mia-msgs .mia-m').length > n, before, { timeout: 15000 });
    return (await page.locator('#mia-msgs .mia-m.a').last().textContent()) || '';
  };
  let reply = await ask('最近有哪些活動？');
  check('問「最近有哪些活動」→ 走 list_events 工具、數字跟試算表一樣（3 場）', /3 場/.test(reply), reply);
  check('★ 模型回的 Markdown（**粗體**、- 條列）在出口被清掉', !/\*\*|^- /m.test(reply), reply);
  check('活動狀態講中文（工具給 status_label），不會冒出 active／draft 這種代碼', /進行中/.test(reply) && /未發布/.test(reply) && !/\b(active|draft)\b/.test(reply), reply);
  await shot(page, 'boss-2-ask.png');

  reply = await ask('幫我新增一位記者：王曉明，中國時報，Wang.XM＠chinatimes.com，跑半導體');
  await page.waitForSelector('.mia-card');
  const cardText = await page.locator('.mia-card').last().textContent();
  check('要新增記者 → 出現確認卡；mail 已經修成小寫半形（卡上的字是程式組的，不是模型寫的）', /新增一位記者/.test(cardText) && /wang\.xm@chinatimes\.com/.test(cardText), cardText);
  check('按確認之前，名單還沒有這個人', !rows('media_roster').some((r) => r[1] === '王曉明'));
  await shot(page, 'boss-3-card.png');
  await page.locator('.mia-card').last().locator('button.ok').click();
  await page.waitForFunction(() => /已完成|沒有成功/.test(document.querySelector('.mia-card:last-of-type .st')?.textContent || ''));
  check('按「確認執行」→ 名單真的多了王曉明（N0001、路線半導體）', rows('media_roster').some((r) => r[0] === 'N0001' && r[1] === '王曉明' && r[3] === '半導體' && r[4] === 'wang.xm@chinatimes.com'), JSON.stringify(rows('media_roster').at(-1)));

  reply = await ask('幫我開一個活動草稿：量子運算前瞻論壇，11/20，在中興院區');
  await page.waitForFunction(() => document.querySelectorAll('.mia-card').length >= 2);
  const draftCard = await page.locator('.mia-card').last().textContent();
  check(`★ 新增活動草稿：日期一定要是 YYYY-MM-DD（「11/20」不能原樣寫進 F 欄；批次 76 同一個教訓）`, new RegExp(`${YEAR}-11-20`).test(draftCard) && !/日期11\/20/.test(draftCard), draftCard);
  await page.locator('.mia-card').last().locator('button.ok').click();
  await page.waitForFunction(() => /已完成|沒有成功/.test([...document.querySelectorAll('.mia-card .st')].at(-1)?.textContent || ''));
  const draft = rows('events').find((r) => r[1] === '量子運算前瞻論壇');
  check('確認 → 活動表多一場草稿（status=draft、F 欄是日期格式）', draft && draft[4] === 'draft' && /^\d{4}-\d{2}-\d{2}$/.test(draft[5]), JSON.stringify(draft));

  reply = await ask('幫我把半導體那場刪掉');
  check('要刪除 → 說做不到、沒有確認卡', /做不到/.test(reply) && (await page.locator('.mia-card').count()) === 2, reply);

  reply = await ask('記住：「四足」指的是經濟部四足機器人那場');
  await page.waitForFunction(() => document.querySelectorAll('.mia-card').length >= 3);
  await page.locator('.mia-card').last().locator('button:not(.ok)').click();
  check('教她記事情 → 按「取消」就不寫', !rows('assistant_memory').length);
  reply = await ask('記住：「四足」指的是經濟部四足機器人那場');
  await page.waitForFunction(() => document.querySelectorAll('.mia-card').length >= 4);
  await page.locator('.mia-card').last().locator('button.ok').click();
  await page.waitForFunction(() => /已完成|沒有成功/.test([...document.querySelectorAll('.mia-card .st')].at(-1)?.textContent || ''));
  check('按確認 → assistant_memory 多一條、狀態 on', rows('assistant_memory').some((r) => /四足/.test(r[2]) && r[3] === 'on'), JSON.stringify(rows('assistant_memory')));
  await ask('這幾天記者問了什麼？');
  check('下一次對話：系統提示裡帶著剛教的那一條', /四足/.test(ai.calls.filter((c) => (c.body.tools || []).length).at(-1).sys));
  await shot(page, 'boss-4-memory.png');

  // 按了「確認執行」還沒等到結果就重新整理（批次 145）：讓建立活動的請求卡住不回，模擬網路慢、人先離開
  await ask('再幫我開一個活動草稿：量子運算前瞻論壇，11/20');
  await page.waitForFunction(() => document.querySelectorAll('.mia-card').length >= 5);
  await page.route('**/api/events', (route) => (/"action":"create"/.test(route.request().postData() || '') ? undefined : route.continue()));
  await page.locator('.mia-card').last().locator('button.ok').click();
  await page.waitForFunction(() => /執行中/.test([...document.querySelectorAll('.mia-card .st')].at(-1)?.textContent || ''));
  await page.reload();
  await page.unroute('**/api/events');
  await page.waitForSelector('#mia-fab', { state: 'visible' });
  await page.click('#mia-fab');
  check('重新整理頁面 → 對話紀錄還在（同一個分頁）', (await page.locator('#mia-msgs .mia-m').count()) > 3);
  const lastCard = page.locator('.mia-card').last();
  check('★ 執行到一半離開的那張卡 → 變成「不確定有沒有完成」，沒有「確認執行」可以再按（不會建出兩份）',
    /不確定有沒有完成/.test(await lastCard.textContent()) && (await lastCard.locator('button.ok').count()) === 0, await lastCard.textContent());
  check('　 那個活動草稿真的只有一份（卡住的那次沒寫進去）', rows('events').filter((r) => r[1] === '量子運算前瞻論壇').length === 1);

  // 直接打 API：沒有密碼、或拿同仁的名單代碼，都叫不動助理
  const noPw = await (await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'assistant_chat', messages: [{ role: 'user', content: '名單有幾個人' }] }) })).status;
  check('★ 沒帶管理員密碼直接打 assistant_chat → 401', noPw === 401, noPw);
  const remember = await (await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'assistant_remember', content: '偷偷記一條' }) })).status;
  check('★ 沒帶密碼直接打 assistant_remember → 401，記憶沒多', remember === 401 && rows('assistant_memory').length === 1, remember);

  // 其他後台頁也都有米亞
  for (const p of ['/report', '/registrations', '/geo.html']) {
    const pg = await newPage(`主管 ${p}`);
    await pg.goto(`${base}/admin`);
    await pg.fill('#pwd-input', 'pw'); await pg.click('.login-btn'); await pg.waitForSelector('#app', { state: 'visible' });
    await pg.goto(`${base}${p}`);
    await pg.waitForTimeout(1600);
    check(`主管打開 ${p}（同一個分頁、不用重登）→ 右下角有米亞`, await pg.locator('#mia-fab').isVisible(), p);
    await pg.context().close();
  }
  await page.context().close();
}

// ═══ 角色二：同事（同仁共用連結：記者名單＋名片翻拍；活動編輯頁）══════════════
console.log('\n── 同事：記者名單（共用連結）與名片翻拍、活動編輯頁 ──');
{
  const page = await newPage('同事');
  await page.goto(`${base}/media.html?code=staffcode1`);
  await page.waitForSelector('#app', { state: 'visible' });
  check('同仁連結進得去記者名單；看不到挑收件人（mail 個資）', await page.locator('#add-card').isVisible() && !(await page.locator('#admin-panel').isVisible()));
  check('同仁頁面沒有米亞助理（它要管理員密碼）', !(await page.locator('#mia-fab').isVisible().catch(() => false)));
  await page.setInputFiles('#card-file', cardPng);
  await page.waitForFunction(() => /讀好了|讀不出來|失敗|太大|只收/.test(document.getElementById('card-msg').textContent), null, { timeout: 15000 });
  check('拍名片 → 欄位填好（姓名、媒體、mail、電話）', (await page.inputValue('#card-name')) === '林小美' && (await page.inputValue('#card-email')) === 'meimei.lin@udn.com', await page.textContent('#card-msg'));
  const matchTxt = await page.locator('#card-matches').textContent();
  check('比對名單：同名同媒體的林小美 → 列出要更新的欄位', /林小美（經濟日報）/.test(matchTxt) && /同名|媒體/.test(matchTxt), matchTxt);
  check('★ 同仁看到的「名單裡原本的 mail」是遮過的（不能藉名片比對撈走個資）', !/(^|[^\w.])mei\.lin@udn\.com/.test(matchTxt) && /m\*+@udn\.com/.test(matchTxt), matchTxt);
  await shot(page, 'coll-1-card.png');
  check('　 要換掉的 mail 旁邊標「要管理員核准」（不讓人以為按下去就換好了）', /要管理員核准/.test(matchTxt), matchTxt);
  await page.locator('#card-matches button.primary').first().click();
  await page.waitForFunction(() => /已更新/.test(document.getElementById('toast')?.textContent || ''));
  const toastTxt = await page.textContent('#toast');
  let r1 = rows('media_roster').find((r) => r[0] === 'R1');
  check('★ 按「用名片更新這位」→ 電話換成名片上的、路線沒被洗掉、職稱進備註；mail 先不換，提示要等管理員核准（批次 145）',
    r1[4] === 'mei.lin@udn.com' && r1[5] === '0912-345-678' && r1[3] === '半導體' && /資深記者/.test(r1[11]) && /管理員核准/.test(toastTxt), JSON.stringify([toastTxt, r1]));

  // 管理員打開記者名單 → 看到同仁送來的 mail 修改 → 核准
  const adminPage = await newPage('主管（名單）');
  await adminPage.goto(`${base}/media.html`);
  await adminPage.fill('#gate-input', 'pw'); await adminPage.click('#gate-box button');
  await adminPage.waitForSelector('#mailreq-box', { state: 'visible', timeout: 8000 }).catch(() => {});
  const reqTxt = await adminPage.locator('#mailreq-box').textContent().catch(() => '');
  check('主管打開記者名單 → 看到「同仁送來的 mail 修改」：林小美 舊 mail → 新 mail', /林小美/.test(reqTxt) && /mei\.lin@udn\.com/.test(reqTxt) && /meimei\.lin@udn\.com/.test(reqTxt), reqTxt);
  await shot(adminPage, 'boss-5-mailreq.png');
  await adminPage.locator('#mailreq-list button.primary').first().click();
  await adminPage.waitForFunction(() => /已核准/.test(document.getElementById('toast')?.textContent || ''));
  r1 = rows('media_roster').find((r) => r[0] === 'R1');
  check('　 按「核准」→ mail 才真的換掉，清單上不再出現', r1[4] === 'meimei.lin@udn.com' && !(await adminPage.locator('#mailreq-box').isVisible()), JSON.stringify(r1));
  await adminPage.context().close();

  const pick = await (await fetch(`${base}/api/media?action=pick&code=staffcode1`)).status;
  check('★ 同仁代碼直接打「挑收件人」API → 401（mail 清單只給管理員）', pick === 401, pick);
  const exp = await (await fetch(`${base}/api/media?action=export&code=staffcode1`)).status;
  check('★ 同仁代碼直接打「匯出全部名單」→ 401', exp === 401, exp);

  await page.goto(`${base}/edit?id=med&code=code3`);
  await page.waitForSelector('#input-venue');
  await page.waitForFunction(() => document.getElementById('input-venue').value !== '');
  check('同仁打開活動編輯頁（編輯碼連結）→ 帶出原本的地點', (await page.inputValue('#input-venue')) === '工研院中興院區 51 館');
  await page.fill('#input-venue', '工研院中興院區 中興文薈廳');
  await page.click('#save-btn');
  await page.waitForTimeout(800);
  check('改地點按儲存 → 活動表真的更新', rows('events').find((r) => r[0] === 'med')[12] === '工研院中興院區 中興文薈廳', rows('events').find((r) => r[0] === 'med')[12]);
  await shot(page, 'coll-2-edit.png');
  await page.goto(`${base}/edit?id=med&code=wrongcode`);
  await page.waitForTimeout(800);
  check('★ 編輯碼不對 → 看不到也改不了', !(await page.locator('#save-btn').isVisible().catch(() => false)) || /連結|無效|錯誤|找不到/.test(await page.textContent('body')));
  await page.context().close();
}

// ═══ 角色三：記者（活動網頁問答）═══════════════════════════════════════════
console.log('\n── 記者：活動網頁問答 ──');
{
  const page = await newPage('記者');
  await page.goto(`${base}/event?id=med`);
  await page.waitForSelector('#media-modal:not([hidden])', { timeout: 8000 }).catch(() => {});
  check('打開活動頁 → 先請記者留媒體與姓名', await page.locator('#media-modal').isVisible());
  await page.fill('#media-modal-input', '經濟日報'); await page.fill('#media-modal-person', '林小美');
  await page.click('#media-modal-btn');
  await page.fill('#user-input', '這場的重點是什麼？'); await page.press('#user-input', 'Enter');
  await page.waitForFunction(() => /AI 輔助診斷/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
  check('問重點 → 串流答案出現在畫面上', /AI 輔助診斷平台/.test(await page.textContent('body')));
  const q1 = rows('qa_log').find((r) => /重點/.test(r[4]));
  check('問答寫進 qa_log（媒體、姓名分開、來源 web）', q1 && q1[3] === '經濟日報' && q1[8] === '林小美' && q1[7] === 'web', JSON.stringify(q1));
  await page.fill('#user-input', '這場的發言人是誰？'); await page.press('#user-input', 'Enter');
  await page.waitForFunction(() => /沒有資料/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  check('答不出來 → 畫面上出現「找真人」的協助（UNANSWERED_RE）', /沒有資料/.test(await page.textContent('body')) && (await page.locator('.human-help, [class*=human]').count()) > 0);
  await shot(page, 'rep-1-chat.png');
  const draft = await page.goto(`${base}/event?id=drafty`);
  check('★ 記者打開草稿活動的網址 → 404（還沒發布的不能看）', draft.status() === 404, draft.status());
  const chatDraft = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'drafty', media_name: '某報', messages: [{ role: 'user', content: '這場是什麼' }] }) })).status;
  check('★ 直接打 api/chat 問草稿活動 → 被擋（不是 200）', chatDraft !== 200, chatDraft);
  await page.context().close();
}

// ═══ 角色四：想洽案的廠商（洽詢單）════════════════════════════════════════
console.log('\n── 廠商：技術合作洽詢單 ──');
{
  // 業發處先要有個資告知才收件（fail-closed）
  const page0 = await newPage('廠商（未開放）');
  await page0.goto(`${base}/inquiry`);
  await page0.waitForTimeout(800);
  check('業發處還沒填個資告知 → 洽詢單顯示「暫停線上收件」', /暫停線上收件/.test(await page0.textContent('body')));
  await page0.context().close();
  const B = await import(path.join(ROOT, 'lib', 'b2b.js'));
  books.B2B ||= {};
  books.B2B.b2b_settings = [['key', 'value'], ['privacy', B.INQUIRY_PRIVACY_TEMPLATE || '個人資料蒐集告知：依個人資料保護法…'], ['topics', '先進封裝\n智慧醫療\n電池材料'], ['sla_days', '3']];
  B.resetB2BState();

  const page = await newPage('廠商');
  await page.goto(`${base}/inquiry`);
  await page.waitForSelector('#f-company', { timeout: 8000 }).catch(() => {});
  check('業發處開放收件 → 洽詢單出現，技術領域有選項', (await page.locator('#f-topic option').count()) >= 4, await page.textContent('body'));
  await page.click('#go');
  check('什麼都沒填就送出 → 每個必填欄位都有提示、沒有送出', (await page.locator('.field.bad').count()) >= 4);
  await page.fill('#f-company', '台灣某某電子股份有限公司'); await page.fill('#f-name', '陳經理');
  await page.fill('#f-email', 'chen@example-elec.com.tw'); await page.fill('#f-phone', '02-2345-6789');
  await page.selectOption('#f-topic', '電池材料');
  await page.fill('#f-need', '想導入固態電池的電極塗佈技術，評估技術授權與合作開發的可能。');
  await page.check('#f-consent');
  await page.waitForTimeout(1600); // 太快送出會被當成機器人
  await page.click('#go');
  await page.waitForSelector('.card.done', { timeout: 8000 }).catch(() => {});
  const done = await page.textContent('body');
  check('送出 → 「已收到您的洽詢」＋洽詢編號＋幾天內回覆', /已收到您的洽詢/.test(done) && /洽詢編號 Q/.test(done) && /3 個工作天/.test(done), done.slice(0, 300));
  const inq = (books.B2B?.b2b_inquiries || []).slice(1);
  check('★ 洽詢寫進業發處那本試算表，不是記者會那本', inq.some((r) => r.some((c) => /台灣某某電子/.test(String(c)))) && !Object.keys(book).some((k) => /b2b/.test(k)), JSON.stringify(inq).slice(0, 300));
  await shot(page, 'vendor-1-done.png');
  await page.context().close();
}

check('整趟沒有任何頁面 JS 錯誤', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} 瀏覽器四角色走查：${pass} 通過，${fail} 失敗`);
if (failures.length) console.log('失敗項目：\n- ' + failures.join('\n- '));
process.exit(fail ? 1 : 0);
