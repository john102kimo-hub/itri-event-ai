import {
  detectMetaIntent, matchEventByName, buildWelcomeFlex, buildRichMenuDefinition,
  ALL_MENUS, REPORTER_MENU, STAFF_MENU
} from '../lib/menu.js';
import { isExitStaffCommand } from '../lib/staff.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log(`❌ ${label}\n   期望 ${JSON.stringify(expected)} 實得 ${JSON.stringify(actual)}`); }
}

console.log('── 應該被判成「跳出本場」的句子 ──');
const META = {
  '最近活動': 'calendar',              // ← 使用者實際回報卡住的那句
  '最近有哪些活動': 'calendar',
  '近期活動': 'calendar',
  '其他活動': 'calendar',
  '有哪些活動': 'calendar',
  '有什麼記者會': 'calendar',
  '活動列表': 'calendar',
  '活動清單': 'calendar',
  '還有哪些場次': 'calendar',
  '換一場活動': 'switch',
  '換活動': 'switch',
  '換一場': 'switch',
  '切換活動': 'switch',
  '我要換別場': 'switch',
  '不是這場': 'switch',
  '重新選擇': 'switch',
  '使用說明': 'help',
  '說明': 'help',
  '怎麼用': 'help',
  '怎麼用？': 'help',
  'help': 'help',
  'HELP': 'help',
  '如何使用': 'help',
  '有什麼功能': 'help',
  '不會用': 'help',
  '這個帳號要怎麼用': 'help',
  '小特派怎麼用': 'help',
  '你要怎麼用': 'help',
  '這個機器人如何使用': 'help',
  // 實際回報的答非所問：群組裡 @ 問「妳能幫我什麼」，因為不含「怎麼／如何」，
  // 舊版 HELP_ABOUT_BOT_RE 接不住，掉進 routeIntent() 被判成 other，回一句跟
  // 問題完全對不上的「不確定您想問哪一場活動」。
  '妳能幫我什麼': 'help',              // ← 使用者實際回報答非所問的那句
  '你能幫我什麼': 'help',
  '你能幫我什麼忙': 'help',
  '你能幫我什麼忙嗎': 'help',
  '你可以做什麼': 'help',
  // 實際回報的第二種落空：群組續問視窗內（沒有再 @）打這句，完全沒有任何回覆——
  // 口語的「啥」沒對到舊版只認「什麼／哪些」的必要群組，掉進 routeIntent() 判成
  // other，群組裡沒被直接 @ 到時 other 是安靜門檻，體感就是「續問視窗好像沒接住」。
  '你能做啥': 'help',                  // ← 使用者實際回報完全沒反應的那句
  '你會做啥': 'help',
  '你可以做啥事': 'help',
  '妳會什麼': 'help',
  '小幫手能做什麼': 'help',
  '這個機器人可以做什麼': 'help',
  '你是誰': 'help',
  '妳是什麼': 'help',
  '你是做什麼的': 'help'
};
for (const [text, want] of Object.entries(META)) eq(detectMetaIntent(text), want, `detectMetaIntent("${text}")`);

console.log('── 正常提問「絕對不能」被攔截（誤判會讓記者的問題永遠沒被回答）──');
const NOT_META = [
  '這場記者會的重點是什麼',
  '四足機器人可以用在哪些場域',
  '這技術怎麼用在消防救災',          // 含「怎麼用」，但不是整句在問操作方式
  '這個平台怎麼用比較好',
  '有哪些合作廠商',
  '還有哪些應用場景',                // 含「還有哪些」，但後面不是活動類詞
  '這次記者會還有哪些廠商參與',
  '請問新聞聯絡人是誰',
  '給我完整新聞稿',
  '技術規格有哪些',
  '地下涵洞巡檢的細節',
  '成本大概多少',
  '可以提供照片嗎',
  '這場活動的主辦單位是誰',          // 含「活動」，但前面沒有範圍詞
  '未來的量產時程',                  // 含「未來」，但後面不是活動類詞
  '這項技術的功能',                  // 含「功能」，但不是整句
  '換算成新台幣是多少',              // 含「換」，但不是換場
  '你怎麼用這套資料判斷哪家廠商比較有優勢',  // 含「你…怎麼用」，但動詞後面還有受詞
  '這裡怎麼用最少的成本導入',
  '你能不能查一下這場記者會幾點開始',  // 含「你能不能」，但後面接著具體內容，是提問
  '你能提供什麼資料',                  // 含「你能…什麼」，但後面還接著「資料」這個受詞
  '這場活動你能幫我查一下嗎',          // 「你能」不在句首，是在問活動內容
  '你是不是搞錯活動了'                 // 含「你是」，但不是在問「你是誰／什麼」
];
for (const text of NOT_META) eq(detectMetaIntent(text), null, `detectMetaIntent("${text}") 應為 null`);

console.log('── 換場偵測 ──');
const cards = [
  { id: 'quad', name: '經濟部四足機器人國產研發平台發表記者會' },
  { id: 'semi', name: '半導體先進封裝技術發表會' },
  { id: 'med', name: '智慧醫療解決方案記者會' }
];
eq(matchEventByName('半導體先進封裝技術發表會', cards, 'quad')?.id, 'semi', '完整名稱（快速回覆按鈕送出的）→ 換場');
eq(matchEventByName('半導體先進封裝', cards, 'quad')?.id, 'semi', '部分名稱 → 換場');
eq(matchEventByName('經濟部四足機器人國產研發平台發表記者會', cards, 'quad'), null, '同一場不換');
eq(matchEventByName('半導體', cards, 'quad'), null, '太短（<6 字）不猜，避免吃掉提問');
eq(matchEventByName('半導體先進封裝的良率如何？', cards, 'quad'), null, '有問號 → 是提問不是選台');
eq(matchEventByName('請問半導體先進封裝技術發表會', cards, 'quad'), null, '疑問詞開頭 → 不換場');
eq(matchEventByName('記者會', cards, 'quad'), null, '命中多場 → 不猜');
eq(matchEventByName('這場的重點是什麼', cards, 'quad'), null, '一般提問 → 不換場');
eq(matchEventByName('智慧醫療解決方案 記者會', cards, 'quad')?.id, 'med', '中間有空白也要比對得到');

console.log('── 歡迎圖卡結構 ──');
const flex = buildWelcomeFlex('工研院');
eq(flex.type, 'flex', 'Flex 訊息型別');
eq(typeof flex.altText === 'string' && flex.altText.length > 0 && flex.altText.length <= 400, true, 'altText 存在且長度合法');
eq(flex.contents.type, 'bubble', 'bubble 結構');
const btnTexts = flex.contents.footer.contents.map(b => b.action.text);
eq(btnTexts, ['最近有哪些活動', '使用說明'], '按鈕送出的文字');
// 按鈕送出的字一定要能被自己的意圖判斷認出來，不然按了沒反應
for (const t of btnTexts) eq(detectMetaIntent(t) !== null, true, `歡迎卡按鈕「${t}」要能被 detectMetaIntent 認出`);

console.log('── 圖文選單定義 ──');
for (const m of ALL_MENUS) {
  const menu = buildRichMenuDefinition(m);
  eq(menu.size, { width: 2500, height: 1686 }, `${m.name}：尺寸符合 LINE 大版規格`);
  eq(menu.areas.length, 6, `${m.name}：六個可點區域`);
  eq(menu.chatBarText.length <= 14, true, `${m.name}：chatBarText 在 14 字上限內`);
  eq(menu.areas[0].bounds, { x: 0, y: 0, width: 833, height: 843 }, `${m.name}：左上格`);

  // 六格必須無縫鋪滿整張圖：有縫隙就是點了沒反應，有重疊就是按到隔壁那格
  const covered = menu.areas.reduce((sum, a) => sum + a.bounds.width * a.bounds.height, 0);
  eq(covered, 2500 * 1686, `${m.name}：六格剛好鋪滿 2500x1686，沒有縫隙也沒有重疊`);
  eq(Math.max(...menu.areas.map(a => a.bounds.x + a.bounds.width)), 2500, `${m.name}：右緣補滿`);
  eq(Math.max(...menu.areas.map(a => a.bounds.y + a.bounds.height)), 1686, `${m.name}：下緣補滿`);

  for (const b of m.buttons) {
    eq(b.label.length <= 20, true, `${m.name}：label「${b.label}」在 20 字上限內`);
    eq(!!b.icon && !!b.sub && !!b.text, true, `${m.name}：「${b.label}」四個欄位都有值`);
  }
}

// 按鈕送出的文字必須被對應的路由認得，否則就是「按了沒反應」
console.log('── 選單按鈕送出的字要被路由認得 ──');
for (const b of REPORTER_MENU.buttons) {
  // 前三顆走 detectMetaIntent；後三顆是問該場內容的常見問題，交給既有問答路徑，
  // 這裡只要確認它們「不會」被 meta 意圖誤攔走（誤攔的話記者永遠問不到內容）
  const meta = detectMetaIntent(b.text);
  const isMetaButton = ['最近有哪些活動', '換一場活動', '使用說明', '媒體邀訪需求'].includes(b.text);
  eq(meta !== null, isMetaButton, `記者選單「${b.label}」→ meta=${meta}（預期 ${isMetaButton ? '被攔' : '放行給問答'}）`);
}
eq(detectMetaIntent('退出職員模式'), null, '「退出職員模式」不能被記者的 meta 意圖攔走（那是職員指令）');
for (const b of STAFF_MENU.buttons) {
  eq(typeof b.text === 'string' && b.text.length > 0, true, `職員選單「${b.label}」有送出文字`);
}

console.log('── 退出職員模式的指令比對 ──');
for (const t of ['退出職員模式', '離開職員模式', '結束職員模式', '退出職員身分', '登出', 'logout', 'exit', '關閉職員模式']) {
  eq(isExitStaffCommand(t), true, `「${t}」應可退出`);
}
for (const t of ['退出', '離開', '結束', '取消', '退出這場活動', '登出後還能再登入嗎', '這個展場的出口在哪']) {
  eq(isExitStaffCommand(t), false, `「${t}」不應被當成退出指令`);
}

console.log('── 邀訪聯絡窗口意圖（contacts）比對 ──');
for (const t of ['媒體邀訪需求', '邀訪需求', '邀訪', '聯絡窗口', '聯繫窗口', '窗口分工', '媒體聯絡', '採訪窗口', '邀訪？']) {
  eq(detectMetaIntent(t), 'contacts', `「${t}」應被判成 contacts`);
}
for (const t of [
  '我想採訪你們固態電池的團隊',   // 含「採訪」但不是整句就是那幾個固定詞
  '這場記者會安排了哪些媒體採訪', // 同上
  '請問邀訪流程是什麼',           // 含「邀訪」但不是完全比對
  '窗口分工表在哪裡下載'          // 含「窗口分工」但後面還接著別的內容
]) {
  eq(detectMetaIntent(t), null, `「${t}」是正常提問，不該被 contacts 攔走`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
