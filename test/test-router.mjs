// lib/router.js 的行事曆清單邏輯。
//
// 回報的意見：LINE 上「最近有哪些活動」原本連已辦完的場次都列出來，滑一輪全被過去式
// 塞滿。這支測 formatCalendarReply()／calendarQuickReplyItems() 濾掉「已結束」的規則——
// 重點是 draft／archived／dateless 三種邊界情況不能被單純的「日期是否過去」誤傷。
import { formatCalendarReply, calendarQuickReplyItems, sortUpcoming, routeIntent } from '../lib/router.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

const d = (s) => new Date(s + 'T00:00:00');
const today = new Date(); today.setHours(0, 0, 0, 0);
const iso = (dt) => dt.toISOString().slice(0, 10);
const inPast = iso(new Date(today.getTime() - 20 * 86400000));
const inFuture = iso(new Date(today.getTime() + 10 * 86400000));

const cards = [
  { id: 'ended-past', name: '已結束的舊記者會', status: 'ended', date: d(inPast), has_kb: true },
  { id: 'active-future', name: '即將舉行的記者會', status: 'active', date: d(inFuture), has_kb: true },
  { id: 'draft-past', name: '草稿場次（日期填了很久以前）', status: 'draft', date: d(inPast), has_kb: false },
  { id: 'archived-future', name: '已下架但日期還沒到', status: 'archived', date: d(inFuture), has_kb: true },
  { id: 'active-nodate', name: '日期未定的活動', status: 'active', date: null, has_kb: true }
];

console.log('── sortUpcoming：三種狀態各自的規則 ──');
const up = sortUpcoming(cards);
const upIds = up.map(c => c.id);
check('已結束的過去場次被濾掉', !upIds.includes('ended-past'), JSON.stringify(upIds));
check('未來場次留著', upIds.includes('active-future'), JSON.stringify(upIds));
check('草稿即使日期是很久以前，還是留著（職員要看得到才不會忘記發布）', upIds.includes('draft-past'), JSON.stringify(upIds));
check('已下架的一律濾掉，即使日期還沒到', !upIds.includes('archived-future'), JSON.stringify(upIds));
check('日期未定的留著（還沒發生，不是「已結束」）', upIds.includes('active-nodate'), JSON.stringify(upIds));
check('有日期的按日期排序在前，日期未定的排最後',
  upIds.indexOf('active-future') < upIds.indexOf('active-nodate'), JSON.stringify(upIds));

console.log('── formatCalendarReply：文字輸出 ──');
const text = formatCalendarReply(cards);
check('沒有「近期已結束」這個標題了', !text.includes('近期已結束'), text);
check('已結束的活動名稱沒出現在清單裡', !text.includes('已結束的舊記者會'), text);
check('未來場次的名稱有出現', text.includes('即將舉行的記者會'), text);
check('草稿場次有出現且帶未發布標籤', /草稿場次.*🔒未發布/.test(text), text);
check('已下架的沒出現在清單裡（即使日期還沒到）', !text.includes('已下架但日期還沒到'), text);
check('文案有提示「含已結束的場次」可以直接打名字問', /含已結束的場次/.test(text), text);

console.log('── 全部場次都已結束時的訊息 ──');
const allEnded = [{ id: 'x', name: '很久以前的活動', status: 'ended', date: d(inPast), has_kb: true }];
const emptyText = formatCalendarReply(allEnded);
check('沒有任何排定中的場次時給明確訊息，不是空清單或報錯',
  /沒有排定中的活動/.test(emptyText), emptyText);
check('仍然引導可以直接問已結束的場次', /直接打活動名稱/.test(emptyText), emptyText);

console.log('── calendarQuickReplyItems：只挑有資料、已過濾的場次 ──');
const items = calendarQuickReplyItems(cards);
check('已結束場次不會出現在快速回覆按鈕', !items.includes('已結束的舊記者會'), JSON.stringify(items));
check('沒有 kb 的場次不占按鈕位置（草稿在 fixture 裡 has_kb=false）',
  !items.includes('草稿場次（日期填了很久以前）'), JSON.stringify(items));
check('未來場次的按鈕有出現', items.includes('即將舉行的記者會'), JSON.stringify(items));

console.log('── 沒有任何活動 ──');
check('空陣列給友善訊息，不是空字串或報錯', /查無已公開的活動資料/.test(formatCalendarReply([])));

// ── routeIntent() 的 system 區塊組裝（批次 24 的話題提示）─────────────────
// 這裡不測「模型判得準不準」（那要真的跑），只測這支「有沒有把該給的提示給出去」、
// 以及「有沒有維持既有的快取切割方式」——第一塊要逐 byte 穩定才吃得到 ephemeral
// cache，因人而異的提示必須另外開區塊（見 lib/router.js 的說明）。
console.log('── routeIntent：currentEventId／currentTopic 兩種提示的區塊組裝 ──');
const routerCards = [{ id: 'quad', name: '四足機器人記者會', status: 'active', date: d(inFuture), has_kb: true }];
const realFetch = globalThis.fetch;
let lastBody = null;
globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"intent":"other","event_ids":[],"confidence":"low"}' }] }) };
};
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';

const sysTexts = () => (lastBody?.system || []).map(s => s.text);

await routeIntent('太空', routerCards);
const baseSystem = sysTexts();
check('沒有任何提示時只有一個 system 區塊（就是吃快取的那塊）', baseSystem.length === 1, JSON.stringify(baseSystem.length));
check('那一塊有掛 ephemeral cache', lastBody?.system?.[0]?.cache_control?.type === 'ephemeral', JSON.stringify(lastBody?.system?.[0]?.cache_control));

await routeIntent('太空', routerCards, { currentTopic: 'industry_trend' });
let s = sysTexts();
check('給了 currentTopic 就多一個區塊', s.length === 2, JSON.stringify(s.length));
check('第一塊逐 byte 不變（因人而異的提示沒有混進去打散快取）', s[0] === baseSystem[0]);
check('話題提示那塊沒有掛 cache_control（因人而異，不該進快取）',
  !lastBody?.system?.[1]?.cache_control, JSON.stringify(lastBody?.system?.[1]?.cache_control));
check('產業趨勢的話題提示講的是「接回 industry_trend」',
  /上一則我剛回答完的是「產業趨勢」/.test(s[1]) && /"industry_trend"/.test(s[1]), s[1]);

await routeIntent('光通訊', routerCards, { currentTopic: 'tech_query' });
s = sysTexts();
check('工研院技術的話題提示講的是「接回 tech_query」、而且要記得抽關鍵字',
  /上一則我剛回答完的是「工研院自己在某項技術/.test(s[1]) && /tech_keyword/.test(s[1]), s[1]);

await routeIntent('太空', routerCards, { currentEventId: 'quad', currentTopic: 'industry_trend' });
s = sysTexts();
check('兩種提示同時存在時共三塊', s.length === 3, JSON.stringify(s.length));
check('話題提示排在活動提示「後面」（同一個裸名詞兩塊會給不同答案，最後一條才是模型看到的最新指示）',
  /目前這個對話正在問的是「四足機器人記者會」/.test(s[1]) && /上一則我剛回答完的是「產業趨勢」/.test(s[2]),
  JSON.stringify(s.map(t => t.slice(0, 20))));

await routeIntent('太空', routerCards, { currentTopic: 'nonsense' });
check('不認得的 currentTopic 值直接忽略，不會塞一塊空的或壞掉的提示進去',
  sysTexts().length === 1, JSON.stringify(sysTexts().length));

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} 行事曆清單測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
