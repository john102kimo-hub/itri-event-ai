// 知識庫字數上限：三個檔案講的必須是同一套（批次 53）。
//
// 原本三個地方各說各話：
//   public/index.html  文案寫「最多 8000 字」，但完全不擋，送出去才被後端退 400
//   public/edit.html   一樣寫「最多 8000 字」，實作卻是超過 8000 跳 confirm
//   api/events.js      真正的硬上限是 45000
// 也就是說畫面上那句「最多 8000 字」是假的，而真正會被退件的那條線沒人講。
//
// 合併成兩層意思：8000 建議（軟）、45000 硬上限。public/ 是靜態檔沒辦法 import lib/，
// 只能各寫一份常數——這支測試就是那份「不准漂開」的保證：
//   1. 三個檔案的數字對得上（含窗口分工的 20000）
//   2. 給人看的文案裡真的有這兩個數字（文案跟常數一起漂走是最常見的下一個 bug）
//   3. 行為：超過硬上限前台自己擋下、不送出；超過軟上限問過才送
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
};

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const api = read('api/events.js');
const admin = read('public/index.html');
const staff = read('public/edit.html');

const num = (src, name) => {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};

// ── 一、數字對得上 ──────────────────────────────────────────────────────────
const apiHard = num(api, 'KB_MAX_LEN');
const apiContacts = num(api, 'CONTACTS_DIR_MAX_LEN');
const adminHard = num(admin, 'KB_HARD_LIMIT');
const adminSoft = num(admin, 'KB_SOFT_LIMIT');
const adminContacts = num(admin, 'CONTACTS_DIR_LIMIT');
const staffHard = num(staff, 'KB_HARD_LIMIT');
const staffSoft = num(staff, 'KB_SOFT_LIMIT');

check('三個檔案都宣告了上限常數',
  [apiHard, apiContacts, adminHard, adminSoft, adminContacts, staffHard, staffSoft].every(n => n !== null),
  JSON.stringify({ apiHard, apiContacts, adminHard, adminSoft, adminContacts, staffHard, staffSoft }));
check('後台的硬上限 = 後端 KB_MAX_LEN', adminHard === apiHard, `${adminHard} vs ${apiHard}`);
check('同仁編輯頁的硬上限 = 後端 KB_MAX_LEN', staffHard === apiHard, `${staffHard} vs ${apiHard}`);
check('兩個前台的建議上限一致', adminSoft === staffSoft, `${adminSoft} vs ${staffSoft}`);
check('建議上限比硬上限小（不然「建議」沒有意義）', adminSoft < adminHard);
check('窗口分工上限 = 後端 CONTACTS_DIR_MAX_LEN', adminContacts === apiContacts,
  `${adminContacts} vs ${apiContacts}`);

// ── 二、給人看的文案要跟常數對得上 ──────────────────────────────────────────
// 常數改了、旁邊那句中文沒改，是這種鏡射最常見的下一個 bug
for (const [name, src] of [['後台', admin], ['同仁編輯頁', staff]]) {
  // 只看知識庫欄位底下那一段說明（從字數計數器往後數一小段），不要抓到別的 form-hint
  const at = src.indexOf('id="kb-count"');
  const hint = at === -1 ? '' : src.slice(at, at + 600);
  check(`${name}的說明文字有寫出建議上限 ${adminSoft}`, hint.includes(String(adminSoft)), hint.slice(0, 120));
  check(`${name}的說明文字有寫出硬上限 ${adminHard}`, hint.includes(String(adminHard)), hint.slice(0, 120));
}
check('沒有殘留寫死的「/ 8000 字」字串接法（都改走 updateKbCount）',
  !/kb-count'\)\.textContent\s*=\s*[^;]*' \/ 8000/.test(admin + staff));

// ── 三、行為：超過硬上限前台自己擋，不送出 ──────────────────────────────────
const code = [...admin.matchAll(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m => !/module/.test(m[1])).map(m => m[2]).sort((a, b) => b.length - a.length)[0];

const els = new Map();
const makeEl = id => ({
  id, value: '', textContent: '', innerHTML: '', disabled: false, scrollTop: 0,
  style: {}, dataset: {},
  addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {},
});

let confirmAnswer = true;
let posted = [];
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { reload() {}, href: '', search: '' },
  confirm: () => confirmAnswer,
  alert() {}, addEventListener() {}, removeEventListener() {},
  fetch: async (url, opts) => {
    posted.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ success: true, events: [] }) };
  },
  document: {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: makeEl,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
runInNewContext(code, sandbox);

const $ = id => sandbox.document.getElementById(id);

// 字數顯示的三段
$('input-kb').value = 'x'.repeat(100);
sandbox.updateKbCount();
check('未超過建議值：顯示「n / 8000 字」', $('kb-count').textContent === `100 / ${adminSoft} 字`);

$('input-kb').value = 'x'.repeat(adminSoft + 1);
sandbox.updateKbCount();
check('超過建議值：文字點出「超過建議」且變色',
  $('kb-count').textContent.includes('超過建議') && $('kb-count').style.color !== '');

$('input-kb').value = 'x'.repeat(adminHard + 1);
sandbox.updateKbCount();
check('超過硬上限：文字點出「存不進去」（打字當下就看得到，不必等按儲存）',
  $('kb-count').textContent.includes('存不進去'));

// 存檔：超過硬上限直接擋，一個請求都不該送出去
sandbox.showCreateModal('2026-09-20');
$('input-name').value = '測試場次';
$('input-kb').value = 'x'.repeat(adminHard + 1);
posted = [];
await sandbox.saveEvent();
check('★ 超過硬上限：前台自己擋下，沒有送出任何請求', posted.length === 0);
check('　 modal 沒關掉，內容還在', $('event-modal').style.display === 'flex');

// 超過軟上限：問過，答「不要」就不送
$('input-kb').value = 'x'.repeat(adminSoft + 1);
confirmAnswer = false;
posted = [];
await sandbox.saveEvent();
check('超過建議值且答「不要」：不送出', posted.length === 0);

confirmAnswer = true;
posted = [];
await sandbox.saveEvent();
check('超過建議值但答「確定」：照樣存得進去（建議不是禁止）',
  posted.some(p => String(p.url).includes('/api/events') && p.body?.action === 'create'));

// 窗口分工的上限也在前台擋
$('input-contacts-directory').value = 'x'.repeat(apiContacts + 1);
posted = [];
await sandbox.saveContactsDirectory();
check('窗口分工超過上限：前台擋下，沒有送出請求', posted.length === 0);
check('　 並且畫面上說明了為什麼',
  $('contacts-directory-status').textContent.includes(String(apiContacts)));

console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
