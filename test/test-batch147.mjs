// 批次 147：朱朱手機截圖的兩件事。
//   一、「快捷鍵選項沒出現」——活動編輯的快速提問收在預設收合的「進階設定」裡，留空時自動出的題畫面上也看不到。
//       現在搬到知識庫正下方，並即時預覽記者會看到的按鈕（api/events.js chips_preview，跟網頁、LINE 同一支 effectiveChips）。
//   二、「右下米亞設定長按可以到處移動」——長按拖曳、記住位置；編輯視窗打開時米亞先躲起來（截圖裡壓在「儲存」上）。
// 真的在瀏覽器裡拖、看預覽的是 tools/persona-check/web.mjs（需要 Chromium，不進 npm test）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

const { reset, calls } = await import('./fakes-sheets82.mjs');
reset();
const events = (await import('../api/events.js')).default;
const post = async (body, headers = {}) => {
  let code = 200, out;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, end() { return res; }, send() { return res; } };
  await events({ method: 'POST', headers, query: {}, body, socket: { remoteAddress: '7.7.7.7' } }, res);
  return { code, out };
};
const iso = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// ═══ 一、預覽 API ══════════════════════════════════════════════════════════════
console.log('── 一、快速提問預覽 API ──');
{
  const KB = '【新聞稿】工研院今天發表 AI 輔助診斷平台。\n\n【常見問答】\nQ：哪些醫院在試行？\nA：三家。';
  let r = await post({ action: 'chips_preview', knowledge_base: KB, venue: '中興院區', press_contact: '王小明 03-1234567' });
  check('★ 不用密碼也算得出來（純計算、不讀試算表）；留空 → 依知識庫自動出題、標 custom=false',
    r.code === 200 && r.out.custom === false && r.out.chips.includes('哪些醫院在試行？') && r.out.chips.includes('這次活動的重點是什麼？') && r.out.chips.includes('活動的時間和地點？'), JSON.stringify(r.out));
  check('　 沒有讀任何試算表（不會外洩任何資料）', !calls.some((c) => c[0] === 'read'), JSON.stringify(calls));
  r = await post({ action: 'chips_preview', knowledge_base: KB, chips: '發言人是誰？\n\n有停車位嗎？' });
  check('自己填了題目 → 就是那幾題、custom=true', r.out.custom === true && JSON.stringify(r.out.chips) === JSON.stringify(['發言人是誰？', '有停車位嗎？']), JSON.stringify(r.out));
  r = await post({ action: 'chips_preview', knowledge_base: KB, invite_letter: '誠摯邀請貴媒體…', event_date: iso(10) });
  check('活動前＋有邀請函 → 活動前的預設題、pre_event=true', r.out.pre_event === true && r.out.chips.includes('邀請函的內容是什麼？'), JSON.stringify(r.out));
  r = await post({ action: 'chips_preview', knowledge_base: KB, invite_letter: '誠摯邀請…', event_date: iso(10), invite_letter_chips: '怎麼申請採訪？' });
  check('　 活動前又有填「活動前快速提問」→ 用那一組、custom=true', r.out.custom === true && JSON.stringify(r.out.chips) === JSON.stringify(['怎麼申請採訪？']), JSON.stringify(r.out));
  r = await post({ action: 'chips_preview' });
  check('什麼都沒給 → 保底三題（不會壞掉）', r.code === 200 && r.out.chips.length === 3, JSON.stringify(r.out));
}

// ═══ 二、版面 ══════════════════════════════════════════════════════════════════
console.log('\n── 二、快速提問在編輯畫面上看得到 ──');
{
  const html = read('public/index.html');
  const details = html.slice(html.indexOf('<details class="adv"'), html.indexOf('</details>', html.indexOf('<details class="adv"')));
  check('★ 後台編輯視窗：「快速問題按鈕」與「活動前快速提問」不在收合的「進階設定」裡', !/id="input-chips"/.test(details) && !/id="input-invite-letter-chips"/.test(details) && /id="input-chips"/.test(html));
  check('　 排在知識庫正下方、有自己的區塊標題', html.indexOf('id="input-chips"') > html.indexOf('id="input-kb"') && html.indexOf('id="input-chips"') < html.indexOf('<details class="adv"') && /快速提問按鈕 <small>記者在活動網頁和 LINE 點了就問<\/small>/.test(html));
  check('　 預覽區、共用程式、打開視窗與還原草稿時都會重算', /id="chips-preview"/.test(html) && /<script src="\/chips-preview\.js"><\/script>/.test(html) && /setupChipsPreview\(/.test(html)
    && /modalOpen = true;\n  if \(window\.chipsPreview\) chipsPreview\.refresh\(\)/.test(html) && /syncModalDerived\(\);\n  if \(window\.chipsPreview\) chipsPreview\.schedule\(\)/.test(html));
  check('　 「活動前快速提問」的說明改成「取代上面那組」（現在排在下面）', /取代上面「快速問題按鈕」那組/.test(html) && !/取代下面「快速問題按鈕」那組/.test(html));
  const edit = read('public/edit.html');
  check('同仁編輯頁也有預覽，說明不再寫過時的「留空則使用預設通用問題」', /id="chips-preview"/.test(edit) && /<script src="\/chips-preview\.js"><\/script>/.test(edit) && /initial: true/.test(edit) && !/留空則使用預設通用問題/.test(edit));
  const js = read('public/chips-preview.js');
  check('預覽程式：打 chips_preview、用 textContent 顯示（問句不當 HTML）、連不上就不顯示', /action: 'chips_preview'/.test(js) && /textContent/.test(js) && !/innerHTML/.test(js) && /\.catch\(function \(\) \{/.test(js));
}

// ═══ 三、米亞：長按拖曳、編輯視窗開著時躲起來 ════════════════════════════════
console.log('\n── 三、米亞長按拖曳與躲開編輯視窗 ──');
{
  const js = read('public/mia-assistant.js');
  check('★ 長按 0.45 秒才拿起來（點一下照樣打開對話）、拖曳用 pointer 事件並抓住指標', /var LONG_PRESS_MS = 450;/.test(js) && /addEventListener\('pointerdown'/.test(js) && /addEventListener\('pointermove'/.test(js) && /setPointerCapture/.test(js) && /if \(suppressClick\) \{ suppressClick = false; return; \} toggle\(\);/.test(js));
  check('　 還沒到長按就移動 → 取消（不會誤拖）；拖的時候頁面不跟著捲、不跳出 iOS 長按圖片選單', /Math\.abs\(e\.clientX - press\.x0\) > 10/.test(js) && /touch-action:none/.test(js) && /-webkit-touch-callout:none/.test(js) && /'contextmenu', function \(e\) \{ e\.preventDefault\(\); \}/.test(js));
  check('　 位置記在這台裝置（localStorage，存畫面比例），讀寫都包 try；放開時夾回畫面內、不壓底部選單', /var POS_KEY = 'mia_fab_pos_v1';/.test(js) && /fx: \(r\.left \+ r\.width \/ 2\) \/ window\.innerWidth/.test(js) && /try \{ localStorage\.setItem\(POS_KEY/.test(js) && /y = Math\.min\(Math\.max\(y, 6\), h - inset - size - 6\);/.test(js));
  check('★ 編輯視窗（.modal-overlay）打開時米亞先躲起來，用 MutationObserver 即時跟著開關', /function overlayOpen\(\)/.test(js) && /querySelectorAll\('\.modal-overlay'\)/.test(js) && /new MutationObserver/.test(js) && /on && !overlayOpen\(\) \? 'block' : 'none'/.test(js));
  check('　 監看只看別人的變化（米亞自己、body 不算），拖曳中不重新定位（走查實際踩到：拖到一半被拉回原位）', /t !== document\.body && t !== fab && !fab\.contains\(t\) && !panel\.contains\(t\)/.test(js) && /!fab\.classList\.contains\('dragging'\)\) placeFab\(\)/.test(js));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 147 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
