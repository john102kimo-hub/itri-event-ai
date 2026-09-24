// 批次 84 的回歸測試（後台那一半）：永久刪除活動、bot_memory 分頁不存在時自動建立。
// 跑的是真的 api/events.js 與 lib/bot-memory.js，只有 Google Sheets 是假的
// （test/fakes-sheets82.mjs）。後台頁面（public/index.html）直接讀檔，把要測的函式抽出來跑。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, calls, ctl, reset } = await import('./fakes-sheets82.mjs');

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
  r.end = () => r;
  return r;
}
const events = (await import('../api/events.js')).default;
async function post(body) {
  const res = fakeRes();
  await events({ method: 'POST', headers: {}, query: {}, body }, res);
  return res;
}
async function get(query) {
  const res = fakeRes();
  await events({ method: 'GET', headers: {}, query }, res);
  return res;
}

const HEADER = ['id', 'name', 'color', 'knowledge_base', 'status', 'created_at', 'chips', 'images', 'greeting', 'organizer', 'edit_code', 'event_time', 'venue', 'event_type', 'press_contact', 'contacts', 'invite_letter', 'invite_letter_chips'];
function seed() {
  reset();
  book.events = [
    HEADER,
    ['live', '進行中的記者會', '#0F9E7A', '【新聞稿】內容', 'active', '2026-09-01', '', '', '', '工研院', 'c1'],
    ['test1', '測試', '#0F9E7A', '', 'draft', '2026-08-27', '', '', '', '工研院', 'c2'],
    ['old', '去年的發表會', '#0F9E7A', '【新聞稿】舊', 'archived', '2025-10-01', '', '', '', '工研院', 'c3'],
    ['done', '已結束的論壇', '#0F9E7A', '【新聞稿】論壇', 'ended', '2026-08-01', '', '', '', '工研院', 'c4'],
  ];
}

// ═══ 一、永久刪除 ════════════════════════════════════════════════════════════
console.log('\n── 一、永久刪除：只刪未發布／已封存，刪之前先備份 ──');
seed();
{
  const res = await post({ action: 'delete', password: 'wrong', id: 'test1' });
  check('密碼錯誤 → 401，什麼都不動', res.statusCode === 401 && book.events.length === 5, `${res.statusCode}`);
}
{
  const res = await post({ action: 'delete', password: 'pw', id: 'live' });
  check('★ 進行中的活動不能直接刪（要先封存）→ 409', res.statusCode === 409 && /先封存/.test(res.body?.error || ''), JSON.stringify(res.body));
  check('進行中那一列還在', book.events.some((r) => r[0] === 'live'));
  const res2 = await post({ action: 'delete', password: 'pw', id: 'done' });
  check('已結束的活動也不能直接刪 → 409', res2.statusCode === 409 && book.events.some((r) => r[0] === 'done'));
}
{
  calls.length = 0;
  const res = await post({ action: 'delete', password: 'pw', id: 'test1' });
  check('★ 未發布的測試活動刪得掉', res.statusCode === 200 && res.body?.success === true, JSON.stringify(res.body));
  check('★ events 分頁裡那一列真的不見了', !book.events.some((r) => r[0] === 'test1'), JSON.stringify(book.events.map((r) => r[0])));
  check('其他活動一列都沒少、順序不變', JSON.stringify(book.events.map((r) => r[0])) === JSON.stringify(['id', 'live', 'old', 'done']));
  const trash = book.events_trash || [];
  check('★ 刪之前先整列備份到 events_trash（第一欄是刪除時間）',
    trash.length === 2 && trash[1][1] === 'test1' && trash[1][2] === '測試' && trash[1][5] === 'draft' && /\d/.test(trash[1][0]), JSON.stringify(trash));
  check('events_trash 的表頭 = 刪除時間 ＋ events 的欄名', JSON.stringify(trash[0]) === JSON.stringify(['deleted_at', ...HEADER]));
  const iBackup = calls.findIndex((c) => c[0] === 'append' && /events_trash/.test(c[1]));
  const iDelete = calls.findIndex((c) => c[0] === 'batch');
  check('備份一定在刪除之前（刪到一半失敗也不會兩頭落空）', iBackup >= 0 && iDelete > iBackup, JSON.stringify(calls));
}
{
  const res = await post({ action: 'delete', password: 'pw', id: 'old' });
  check('已封存的活動刪得掉', res.statusCode === 200 && !book.events.some((r) => r[0] === 'old'));
  const res2 = await post({ action: 'delete', password: 'pw', id: 'nope' });
  check('不存在的活動 → 404', res2.statusCode === 404);
}
{
  // 刪掉之後，後台列表與記者端都查不到
  seed();
  await post({ action: 'delete', password: 'pw', id: 'test1' });
  const admin = await get({ action: 'list_admin', password: 'pw' });
  check('刪掉之後，後台列表（含未發布）不再有這一場', !(admin.body?.events || []).some((e) => e.id === 'test1'), JSON.stringify(admin.body).slice(0, 200));
  const one = await get({ action: 'get_public', id: 'test1' });
  check('記者前台用網址直接打也查不到', one.statusCode === 404, `${one.statusCode}`);
}
{
  // 寫入備份失敗 → 不能刪（寧可刪不掉，也不要沒備份就刪）
  seed();
  ctl.failWrites = 1; // 第一次寫入（備份）就失敗
  const res = await post({ action: 'delete', password: 'pw', id: 'test1' });
  check('★ 備份寫不進去 → 不刪，那一列還在', res.statusCode === 500 && book.events.some((r) => r[0] === 'test1'), `${res.statusCode} ${JSON.stringify(res.body)}`);
}

// ═══ 二、bot_memory 分頁不存在 ════════════════════════════════════════════════
console.log('\n── 二、bot_memory 分頁不存在：自動建立，不再每一題都讀失敗 ──');
reset();
ctl.strictTabs = true;
book.events = [HEADER];
{
  const mem = await import('../lib/bot-memory.js');
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const first = await mem.getMemories();
  const readsAfterFirst = calls.filter((c) => c[0] === 'read' && /bot_memory/.test(c[1])).length;
  const second = await mem.getMemories();
  const readsAfterSecond = calls.filter((c) => c[0] === 'read' && /bot_memory/.test(c[1])).length;
  console.error = origErr;
  check('分頁不存在 → 當作沒有記憶，問答照常', Array.isArray(first) && first.length === 0);
  check('★ 順手把 bot_memory 分頁建起來', Array.isArray(book.bot_memory) && book.bot_memory.length >= 1, JSON.stringify(book.bot_memory));
  check('★ 第二題不再去讀一次（60 秒快取，不再每題失敗一次）', readsAfterSecond === readsAfterFirst && second.length === 0, `${readsAfterFirst} → ${readsAfterSecond}`);
  check('不再印「讀取 bot_memory 失敗」洗版', !errors.some((e) => /讀取 bot_memory 失敗/.test(e)), JSON.stringify(errors));
}

// ═══ 三、後台頁面 ═════════════════════════════════════════════════════════════
console.log('\n── 三、後台頁面：刪除鍵只出現在未發布／已封存，按了要打「刪除」才會送出 ──');
const html = read('public/index.html');
{
  const card = html.slice(html.indexOf('<div class="event-actions">'), html.indexOf("}).join('');", html.indexOf('<div class="event-actions">')));
  check('卡片上有「刪除」鍵，條件是 draft 或 archived',
    /ev\.status === 'draft' \|\| ev\.status === 'archived' \? `[\s\S]*deleteEvent\(/.test(card), card.slice(-600));
  check('編輯視窗有「永久刪除」鍵，而且只對 draft／archived 顯示',
    /id="delete-btn"/.test(html) && /deletable \? 'inline-flex' : 'none'/.test(html));
}
{
  const a = html.indexOf('async function deleteEvent(');
  const b = html.indexOf('// 發布：draft → active。');
  let fn = null;
  try { fn = a > 0 && b > a ? new Function('state', 'prompt', 'toast', 'authedFetch', 'document', 'clearDraft', 'closeModal', 'loadEvents', html.slice(a, b) + '; return deleteEvent;') : null; } catch { fn = null; }
  check('抽得出 deleteEvent()', !!fn);
  if (fn) {
    const sent = [], toasts = [];
    const deps = (answer) => [
      { password: 'pw', events: [{ id: 'test1', name: '測試' }] },
      () => answer,
      (m) => toasts.push(m),
      async (url, opt) => { sent.push(JSON.parse(opt.body)); return { json: async () => ({ success: true }) }; },
      { getElementById: () => ({ value: '' }) },
      () => {}, () => {}, async () => {}
    ];
    await fn(...deps(null))('test1');
    check('按取消 → 不送出', sent.length === 0);
    await fn(...deps('好'))('test1');
    check('沒打「刪除」→ 不送出，並且說明為什麼', sent.length === 0 && /沒有輸入「刪除」/.test(toasts.at(-1) || ''), JSON.stringify(toasts));
    await fn(...deps(' 刪除 '))('test1');
    check('★ 打「刪除」才送出 action=delete', sent.length === 1 && sent[0].action === 'delete' && sent[0].id === 'test1', JSON.stringify(sent));
  }
}

console.log(`\n${fail ? '❌' : '✅'} 批次 84 刪除／bot_memory 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
