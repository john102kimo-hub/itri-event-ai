// 吃什麼地圖的中文指令解析測試。
//
// 這支測的是「同一個輸入框既能新增又能查詢」會不會打架——那是整個 App 唯一
// 一改就會靜靜壞掉的地方。壞掉的樣子不是報錯，是「打『想吃拉麵』結果被新增
// 了一家叫拉麵的店」，使用者要等到清單長出垃圾才會發現。
//
//   node test/test-food-parse.mjs
import {
  parseCommand, guessTags, extractTags, selectPlaces, distance,
  findPlace, isClosedOn, mealOfHour, priceLevelOf, formatDistance
} from '../public/food-parse.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   實際：' + JSON.stringify(detail) : ''}`); }
}
const cmd = s => parseCommand(s);

console.log('── 新增店家 ──');
check('「加 鼎泰豐」→ 新增，預設想吃', (() => { const c = cmd('加 鼎泰豐'); return c.type === 'add' && c.name === '鼎泰豐' && c.status === 'want'; })(), cmd('加 鼎泰豐'));
check('「新增一蘭拉麵」也認得', cmd('新增一蘭拉麵').type === 'add');
check('「想吃一蘭拉麵」→ 新增（後面接得出店名）', (() => { const c = cmd('想吃一蘭拉麵'); return c.type === 'add' && c.name === '一蘭拉麵'; })(), cmd('想吃一蘭拉麵'));
check('狀態詞在句尾也認得：「加 鼎泰豐 常吃」', (() => { const c = cmd('加 鼎泰豐 常吃'); return c.type === 'add' && c.status === 'ok' && c.name === '鼎泰豐'; })(), cmd('加 鼎泰豐 常吃'));
check('地址會被拆出來，不會黏在店名後面',
  (() => { const c = cmd('加 鼎泰豐 信義路二段194號'); return c.name === '鼎泰豐' && c.addr === '信義路二段194號'; })(), cmd('加 鼎泰豐 信義路二段194號'));
check('全形逗號分隔也可以', (() => { const c = cmd('加，阿宗麵線，峨眉街8-1號，要站著吃'); return c.name === '阿宗麵線' && c.addr === '峨眉街8-1號' && c.note.includes('站著'); })(), cmd('加，阿宗麵線，峨眉街8-1號，要站著吃'));
check('「在這」→ 直接用目前 GPS 位置，不必再查地址', cmd('加 春水堂 在這').useHere === true);
check('#自訂標籤留得住', cmd('加 某某店 #不排隊').tags.includes('不排隊'));
check('店名自動猜標籤：一蘭拉麵 → 拉麵', cmd('想吃一蘭拉麵').tags.includes('拉麵'));
check('$$ 會變成價位等級 2', cmd('加 某店 $$').price === 2);
check('「均消200」抓得到價位', cmd('加 某店 均消200').price === 2, cmd('加 某店 均消200'));

console.log('── 查詢：附近吃什麼 ──');
check('「附近有什麼」→ 查詢且要附近', (() => { const c = cmd('附近有什麼'); return c.type === 'find' && c.filters.near; })(), cmd('附近有什麼'));
check('「吃啥」也認得', cmd('吃啥').type === 'find');
check('查詢預設排除踩雷店', JSON.stringify(cmd('附近有什麼').filters.status) === JSON.stringify(['ok', 'want']));
check('「想吃拉麵」→ 查詢我的拉麵口袋名單，不是新增一家叫拉麵的店',
  (() => { const c = cmd('想吃拉麵'); return c.type === 'find' && c.filters.tags.includes('拉麵') && c.filters.status[0] === 'want'; })(), cmd('想吃拉麵'));
check('「晚上想吃日式」→ 時段晚餐＋標籤日式',
  (() => { const c = cmd('晚上想吃日式'); return c.type === 'find' && c.filters.meal === '晚餐' && c.filters.tags.includes('日式'); })(), cmd('晚上想吃日式'));
check('「500公尺內吃什麼」→ 半徑 500', cmd('500公尺內吃什麼').filters.radius === 500, cmd('500公尺內吃什麼'));
check('「1公里」→ 半徑 1000', cmd('1公里內想吃的').filters.radius === 1000);
check('「走路5分鐘」→ 約 400 公尺', cmd('走路5分鐘有什麼').filters.radius === 400);
check('「中午吃啥」→ 時段午餐', cmd('中午吃啥').filters.meal === '午餐');
check('「火鍋」兩個字就當查詢', (() => { const c = cmd('火鍋'); return c.type === 'find' && c.filters.tags.includes('火鍋'); })(), cmd('火鍋'));
check('「想吃的清單」→ 只列想吃', (() => { const c = cmd('想吃的清單'); return c.type === 'find' && c.filters.status[0] === 'want'; })(), cmd('想吃的清單'));
check('「隨便」→ 隨機選一家', cmd('隨便').random === true);
check('「選擇障礙」也是隨機', cmd('選擇障礙').random === true);
check('「幫我選一家」也是隨機', cmd('幫我選一家').random === true);

console.log('── 狀態變更與刪除 ──');
check('「鼎泰豐吃過了」→ 打卡，不是新增', (() => { const c = cmd('鼎泰豐吃過了'); return c.type === 'visit' && c.target === '鼎泰豐'; })(), cmd('鼎泰豐吃過了'));
check('「阿宗麵線踩雷」→ 標成踩雷', (() => { const c = cmd('阿宗麵線踩雷'); return c.type === 'mark' && c.status === 'nope' && c.target === '阿宗麵線'; })(), cmd('阿宗麵線踩雷'));
check('「刪掉鼎泰豐」→ 刪除', (() => { const c = cmd('刪掉鼎泰豐'); return c.type === 'remove' && c.target === '鼎泰豐'; })(), cmd('刪掉鼎泰豐'));
check('單獨一句「吃過了」沒指名店家，不能動任何資料', cmd('吃過了').type !== 'visit', cmd('吃過了'));
check('說明指令', cmd('說明').type === 'help' && cmd('?').type === 'help');
check('認不出來的字一律當搜尋，絕不誤新增', cmd('鼎泰豐').type === 'search', cmd('鼎泰豐'));
check('空字串回 null', parseCommand('   ') === null);

console.log('── 標籤字典 ──');
check('牛肉麵猜得到牛肉麵', guessTags('林東芳牛肉麵').includes('牛肉麵'));
check('居酒屋歸日式', guessTags('鳥貴族居酒屋').includes('日式'));
check('句子裡抓得到多個標籤', extractTags('想吃日式或火鍋').length >= 2);
check('價位級距：80 元是 $', priceLevelOf(80) === 1);
check('價位級距：1200 元是 $$$$', priceLevelOf(1200) === 4);

console.log('── 距離與排序 ──');
const TAIPEI_101 = { lat: 25.0339, lng: 121.5645 };
const places = [
  { id: 'a', name: '近的店', status: 'ok', lat: 25.0345, lng: 121.5648, tags: ['麵食'] },
  { id: 'b', name: '遠的店', status: 'ok', lat: 25.0500, lng: 121.5800, tags: ['火鍋'] },
  { id: 'c', name: '想吃的店', status: 'want', lat: 25.0341, lng: 121.5650, tags: ['日式'] },
  { id: 'd', name: '踩雷的店', status: 'nope', lat: 25.0340, lng: 121.5646, tags: ['麵食'] },
  { id: 'e', name: '還沒定位的店', status: 'want', lat: null, lng: null, tags: [] }
];
const d = distance(TAIPEI_101, places[0]);
check('距離算得出來且量級合理（幾十到幾百公尺）', d > 30 && d < 500, d);
check('缺座標回 null，不會變成 NaN 排到最前面', distance(TAIPEI_101, places[4]) === null);
check('公尺／公里格式化', formatDistance(850) === '850 公尺' && formatDistance(1500) === '1.5 公里');

let got = selectPlaces(places, { status: ['ok', 'want'] }, { origin: TAIPEI_101 });
check('踩雷的店不會出現在預設清單裡', !got.some(p => p.id === 'd'), got.map(p => p.id));
check('照距離排序，最近的在最前面', got[0].id === 'c' || got[0].id === 'a', got.map(p => p.id));
check('還沒定位的店排最後，不會卡在最上面', got[got.length - 1].id === 'e', got.map(p => p.id));

got = selectPlaces(places, { status: ['ok', 'want'], radius: 500 }, { origin: TAIPEI_101 });
check('半徑過濾會濾掉遠的店', !got.some(p => p.id === 'b'), got.map(p => p.id));
check('半徑過濾時，沒座標的店也不該混進來', !got.some(p => p.id === 'e'), got.map(p => p.id));

got = selectPlaces(places, { status: ['ok', 'want'], tags: ['火鍋'] }, { origin: TAIPEI_101 });
check('標籤過濾只留火鍋', got.length === 1 && got[0].id === 'b', got.map(p => p.id));

got = selectPlaces(places, { status: ['want'] }, { origin: null });
check('沒有定位也要能出清單（不能整個空掉）', got.length === 2, got.map(p => p.id));

console.log('── 公休與時段 ──');
const monClosed = { name: '週一公休店', closed: [1] };
check('週一公休：星期一判定為休息', isClosedOn(monClosed, new Date('2026-09-07T12:00:00+08:00')) === true);
check('週一公休：星期二判定為有開', isClosedOn(monClosed, new Date('2026-09-08T12:00:00+08:00')) === false);
check('沒填公休就不算休息', isClosedOn({ name: '沒填' }, new Date()) === false);
check('12 點是午餐', mealOfHour(12) === '午餐');
check('20 點是晚餐', mealOfHour(20) === '晚餐');
check('凌晨 2 點是宵夜', mealOfHour(2) === '宵夜');

console.log('── 用店名找店 ──');
check('完全相同', findPlace(places, '近的店').id === 'a');
check('打一半也找得到', findPlace(places, '想吃').id === 'c');
check('找不到回 null，不會亂配一家', findPlace(places, '不存在的店名XYZ') === null);

console.log(`\n${fail === 0 ? '✅' : '❌'} 通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
