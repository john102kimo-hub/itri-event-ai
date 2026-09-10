// 後台「新增／編輯活動」不能靜靜掉資料（批次 53）。
//
// 回報原話：「我在後台新增活動時，如果滑鼠點到旁邊，就會跳掉，造成資料未存」。
// 根因是 modal overlay 的 onclick 直接呼叫 closeModal()——點到外面那圈灰底，整份表單
// （知識庫一填就好幾百字）連問都不問就消失。
//
// 這支測試不只比對字串，而是把 public/index.html 裡那段 <script> 抓出來，配一個最小的
// 假 DOM 真的跑起來，驗行為本身：
//   1. 有未儲存內容時，點外面「不會關」
//   2. 按「取消」要先問過，答不要就留著
//   3. 不管怎麼關掉，內容都已經在 localStorage 的草稿裡，下次打開能還原
//   4. 存檔成功後草稿要清掉（不然下次新增活動會冒出上一場的內容）
//   5. MODAL_FIELDS 要涵蓋 modal 裡每一個欄位——以後有人加欄位卻忘了加進這份清單，
//      草稿就會少存那一欄，這是最容易再犯的一種
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// ── 一、markup 層：關閉入口一定要繞過 requestCloseModal ──────────────────────
const overlayTag = html.match(/<div id="event-modal"[^>]*>/)[0];
check('overlay 點擊走 requestCloseModal，不是直接 closeModal',
  /requestCloseModal\('backdrop'\)/.test(overlayTag) && !/closeModal\(\)/.test(overlayTag),
  overlayTag);

const modalBlock = html.slice(html.indexOf('<div id="event-modal"'), html.indexOf('<!-- Toast -->'));
check('「取消」按鈕也走 requestCloseModal',
  /onclick="requestCloseModal\('button'\)"[^>]*>取消/.test(modalBlock));

// ── 二、把 <script> 抓出來，用假 DOM 跑真的邏輯 ─────────────────────────────
const scripts = [...html.matchAll(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m => !/module/.test(m[1]))
  .map(m => m[2]);
const code = scripts.sort((a, b) => b.length - a.length)[0];   // 主程式是最長的那塊

const els = new Map();
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', disabled: false, scrollTop: 0,
    style: {}, dataset: {},
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {},
  };
}
const store = new Map();
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { reload() {}, href: '', search: '' },
  confirm: () => confirmAnswer,
  alert() {},
  addEventListener() {}, removeEventListener() {},
  fetch: async (url, opts) => {
    if (String(url).includes('action=get&id=')) {
      return { ok: true, status: 200, json: async () => EXISTING };
    }
    return fetchImpl(url, opts);
  },
  document: {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector: sel => (sel === '#event-modal .modal' ? sandbox.document.getElementById('__modal-box') : null),
    querySelectorAll: () => [],
    addEventListener() {}, createElement: makeEl,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let confirmAnswer = true;
let fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ success: true, id: 'ev-new' }) });

// showEditModal 會先去後端把該場資料撈回來，假一份給它
const EXISTING = {
  id: 'ev-semicon', name: '2026晶鏈高峰論壇（Semicon Network Summit）',
  organizer: '工研院', color: '#0F9E7A', knowledge_base: '【新聞稿全文】原本就存好的內容',
  chips: '', greeting: '', images: '', event_time: '', venue: '', event_type: '論壇',
  press_contact: '', contacts: '', invite_letter: '', invite_letter_chips: '',
  status: 'active', event_date: '2026-09-01',
};

// 頂層的 const／let 不會掛到 global 上（函式宣告才會），補一小段尾巴把要驗的兩個
// 內部狀態接出來——測的還是原檔那段程式，沒有另外抄一份。
runInNewContext(code + `
;globalThis.__MODAL_FIELDS = MODAL_FIELDS;
;globalThis.__setUploading = n => { uploadingCount = n; };
`, sandbox);

const $ = id => sandbox.document.getElementById(id);
const modalDisplay = () => $('event-modal').style.display;
// 測試之間收掉 modal，不要讓上一段的狀態影響下一段
const closeQuietly = () => { sandbox.discardDraft(); sandbox.closeModal(); };

// ── 三、MODAL_FIELDS 要跟 modal 裡的欄位對得起來 ────────────────────────────
const declared = new Set(sandbox.__MODAL_FIELDS);
const inMarkup = new Set(
  [...modalBlock.matchAll(/id="(input-[a-z-]+)"/g)].map(m => m[1])
    .filter(id => id !== 'input-image-file')   // 檔案選擇器本身不是要存的內容
);
const missing = [...inMarkup].filter(id => !declared.has(id));
const extra = [...declared].filter(id => !inMarkup.has(id));
check('MODAL_FIELDS 涵蓋 modal 裡每一個欄位（漏一欄＝草稿少存一欄）',
  missing.length === 0, '漏掉：' + missing.join(', '));
check('MODAL_FIELDS 沒有列到不存在的欄位', extra.length === 0, '多餘：' + extra.join(', '));

// ── 四、行為：點旁邊不會掉資料 ──────────────────────────────────────────────
sandbox.showCreateModal('2026-09-20');
check('新增活動：modal 打開', modalDisplay() === 'flex');

sandbox.requestCloseModal('backdrop');
check('沒動過任何欄位時，點旁邊照樣關得掉（不擾民）', modalDisplay() === 'none');

sandbox.showCreateModal('2026-09-20');
$('input-name').value = '工研院 AI 智慧醫療大平台發表記者會';
$('input-kb').value = '【活動名稱】智慧醫療\n【新聞稿全文】辛苦打了很久的內容……';
sandbox.markModalChanged();

sandbox.requestCloseModal('backdrop');
check('★ 有未儲存內容時，點旁邊不會關掉（本次回報的 bug）', modalDisplay() === 'flex');
check('　 內容原封不動留在畫面上', $('input-kb').value.includes('辛苦打了很久的內容'));

confirmAnswer = false;
sandbox.requestCloseModal('button');
check('按「取消」會先問，答「不要」就留著', modalDisplay() === 'flex');

// ── 五、行為：真的關掉時，草稿要接得住 ─────────────────────────────────────
confirmAnswer = true;
sandbox.requestCloseModal('button');
check('按「取消」並確認後才真的關閉', modalDisplay() === 'none');
check('關掉的內容已存成草稿', store.has('itri_event_draft:new'));

sandbox.showCreateModal();
check('重開新增活動時跳出草稿還原橫幅', $('draft-banner').style.display === 'flex');
check('　 橫幅出現前欄位是乾淨的範本（沒有偷偷自動蓋回去）',
  !$('input-kb').value.includes('辛苦打了很久的內容'));

sandbox.restoreDraft();
check('按「還原」把內容救回來', $('input-kb').value.includes('辛苦打了很久的內容') &&
  $('input-name').value.includes('智慧醫療'));
check('　 還原後字數統計有跟著更新',
  $('kb-count').textContent === $('input-kb').value.length + ' / 8000 字');

// ── 六、存檔成功要清草稿；存檔失敗要保住 ───────────────────────────────────
await sandbox.saveEvent();
check('存檔成功後 modal 關閉', modalDisplay() === 'none');
check('★ 存檔成功後草稿清掉（不然下次新增會冒出上一場的內容）',
  !store.has('itri_event_draft:new'));

sandbox.showCreateModal();
$('input-name').value = '第二場記者會';
$('input-kb').value = '【新聞稿全文】這次後端會壞掉';
fetchImpl = () => ({ ok: false, status: 500, json: async () => ({ error: 'Sheets 掛了' }) });
await sandbox.saveEvent();
check('★ 存檔失敗時 modal 不關（內容還在畫面上）', modalDisplay() === 'flex');
check('　 且草稿仍留著', store.get('itri_event_draft:new')?.includes('這次後端會壞掉'));

// ── 六之二、編輯既有活動也一樣（回報影片走的是這條路，不是「新增」）─────────
// 影片：點卡片的「編輯」→ 在「邀訪聯絡窗口分工」打字 → 滑鼠點到右邊卡片區的灰底
// → modal 整個不見、字全沒了。這條路的 baseline 是後端撈回來的內容，跟「新增」不同，
// 要分開驗。
{
  store.clear();
  await sandbox.showEditModal('ev-semicon');
  check('編輯：modal 打開且帶入既有內容', modalDisplay() === 'flex' &&
    $('input-kb').value.includes('原本就存好的內容'));

  sandbox.requestCloseModal('backdrop');
  check('編輯：沒改任何東西時，點旁邊關得掉', modalDisplay() === 'none');

  await sandbox.showEditModal('ev-semicon');
  $('input-contacts').value = '徐喬涵035915128 XXX';
  sandbox.markModalChanged();
  sandbox.requestCloseModal('backdrop');
  check('★ 編輯：打了字之後點旁邊不會關掉（回報影片的情境）', modalDisplay() === 'flex');
  check('　 剛打的窗口分工還在', $('input-contacts').value === '徐喬涵035915128 XXX');

  confirmAnswer = true;
  sandbox.requestCloseModal('button');
  check('編輯：確認後才關，且草稿存在該場活動自己的 key 下',
    modalDisplay() === 'none' && store.has('itri_event_draft:ev-semicon'));

  await sandbox.showEditModal('ev-semicon');
  check('編輯：重開同一場跳出草稿橫幅', $('draft-banner').style.display === 'flex');
  sandbox.restoreDraft();
  check('編輯：還原拿回剛剛打的窗口分工', $('input-contacts').value === '徐喬涵035915128 XXX');
  closeQuietly();
}

// ── 七、上傳中不准關 ───────────────────────────────────────────────────────
sandbox.showCreateModal('2026-09-20');
$('input-name').value = '上傳中的活動';
sandbox.markModalChanged();
sandbox.__setUploading(1);
sandbox.requestCloseModal('button');
check('照片上傳中時關不掉（不然拿不回圖片網址）', modalDisplay() === 'flex');
sandbox.__setUploading(0);

console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
