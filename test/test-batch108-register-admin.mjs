// 批次 108：媒體報名後台——手機上名單一筆一張卡片（以前是橫向捲動的七欄表，操作按鈕在畫面外）。
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/registrations.html', import.meta.url), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l)); };
check('★ 手機版：表頭隱藏、每列變成卡片（不再要求最小寬度 760px 橫向捲動）', /thead \{ display: none; \}/.test(mobile) && /table, tbody, tr, td \{ display: block; width: 100%; \}/.test(mobile) && !/min-width: 760px/.test(css));
check('★ 手機版：操作按鈕（場次／備註／取消／刪除）可換行、不會被推出畫面', /td\.act \{[^}]*white-space: normal !important/.test(mobile));
check('卡片上每個欄位有標籤（場次／選填／名單／報名），沒內容的欄位不佔位', ['場次', '選填', '名單', '報名'].every((l) => html.includes(`data-l="${l}"`)) && /td:empty \{ display: none; \}/.test(mobile));
console.log(`\n${fail ? '❌' : '✅'} 批次 108 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
