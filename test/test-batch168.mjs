// 批次 168：同仁編輯頁——知識庫往前排、選填欄位往後排，而且不收合（批次 147：收起來就找不到）。
import fs from 'node:fs';
import path from 'node:path';
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 300) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const ed = fs.readFileSync(path.join(ROOT, 'public/edit.html'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const at = (id) => ed.indexOf(`id="${id}"`);

check('★ 知識庫排在邀訪窗口分工、媒體邀請函、主辦單位前面', ['input-contacts', 'input-invite-letter', 'input-organizer'].every((id) => at('input-kb') > 0 && at(id) > at('input-kb')));
check('基本資訊的必填欄位與狀態仍在知識庫前面', ['input-date', 'input-venue', 'input-contact', 'input-status'].every((id) => at(id) > 0 && at(id) < at('input-kb')));
check('「活動前快速提問」緊接在「快速問題按鈕」與預覽下面（跟後台編輯視窗同一個順序）', at('input-chips') < at('input-invite-letter-chips') && at('chips-preview') < at('input-invite-letter-chips') && at('input-invite-letter-chips') < at('input-greeting'));
check('★ 沒有被收進摺疊區（編輯頁沒有 <details>）', !/<details/.test(ed));
const groupOf = (id) => ed.slice(ed.lastIndexOf('<div class="form-group', at(id)), at(id));
check('搬過的四格各自還掛著 biz-hide（企業場照樣藏）', ['input-contacts', 'input-invite-letter', 'input-invite-letter-chips', 'input-organizer'].every((id) => /biz-hide/.test(groupOf(id))));
check('說明的方向跟著位置改：「取代上面」「繼續用上面那組」（編輯頁與後台視窗都是）',
  /取代上面「快速問題按鈕」那組——留空則活動前也繼續用上面那組/.test(ed) && !/繼續用下面那組/.test(ed) && !/繼續用下面那組/.test(admin));

console.log(`\n${fail ? '❌' : '✅'} 批次 168 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
