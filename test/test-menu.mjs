import { detectMetaIntent, matchEventByName, buildWelcomeFlex, buildRichMenuDefinition, RICH_MENU_BUTTONS } from '../lib/menu.js';

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
  '這個機器人如何使用': 'help'
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
  '這裡怎麼用最少的成本導入'
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
const menu = buildRichMenuDefinition();
eq(menu.size, { width: 2500, height: 843 }, '尺寸符合 LINE 精簡版規格');
eq(menu.areas.length, 3, '三個可點區域');
eq(menu.areas[0].bounds, { x: 0, y: 0, width: 833, height: 843 }, '第一格');
eq(menu.areas[2].bounds.x + menu.areas[2].bounds.width, 2500, '最後一格補滿餘數、沒有點不到的空白');
eq(menu.chatBarText.length <= 14, true, 'chatBarText 在 14 字上限內');
for (const b of RICH_MENU_BUTTONS) {
  eq(detectMetaIntent(b.text) !== null, true, `選單按鈕「${b.text}」要能被 detectMetaIntent 認出`);
  eq(b.label.length <= 20, true, `選單 label「${b.label}」在 20 字上限內`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
