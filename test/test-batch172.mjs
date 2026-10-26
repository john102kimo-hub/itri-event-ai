// 批次 172：只有一場的活動報名（記者會、企業說明會大多是）——報名頁預先勾好那一場。
// 朱朱問：「活動報名新增場次，10/28 有很多場次這樣用沒問題，但記者會、企業洽案說明會也是用這樣格式嗎？」
// 格式一樣（一場就一列，從活動卡「這場的活動報名」建立會自動帶好 A1 那一列）；但實際用瀏覽器報一次單場的記者會，
// 記者還得自己勾「要參加哪幾場？」底下唯一的那一場，沒勾就被「請至少勾選一個場次」擋下來。
// 瀏覽器實測在 tools/reg-ui-check/check.mjs（只有一場→預先勾好、標題「活動場次」；多場照舊不預先勾）。
import fs from 'node:fs';
import path from 'node:path';
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 300) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const reg = fs.readFileSync(path.join(ROOT, 'public/register.html'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public/registrations.html'), 'utf8');

check('★ 只有一場、而且開放中、不是在改舊報名 → 那一場預先勾好',
  /const only = shown\.length === 1 && !shown\[0\]\.disabled && !\(pre\.sessions \|\| \[\]\)\.length \? shown\[0\]\.code : '';/.test(reg)
  && /sessionCard\(s, \(pre\.sessions \|\| \[\]\)\.includes\(s\.code\) \|\| s\.code === only\)/.test(reg));
check('　 標題跟著換：一場寫「活動場次」，多場照舊「要參加哪幾場？」', /only \? '活動場次' : '要參加哪幾場？'/.test(reg));
check('　 後台場次欄的說明講清楚：只有一場就只填一列', /只有一場（記者會、企業說明會）就只填這一列/.test(admin));

console.log(`\n${fail ? '❌' : '✅'} 批次 172 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
