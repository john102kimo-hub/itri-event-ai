// 批次 169：多天的活動——活動表只有開始日，第二天起「活動基本資料」寫「已經在 N 天前舉行」，
// 要補一句「這是第一天，還沒到的場次照議程回答」，模型才不會跟記者說整個活動已經結束（眺望 2027：10/28 起連辦 8 天）。
import { formatEventBasics } from '../lib/prompt.js';
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 300) : ''))); };
const now = new Date('2026-10-30T05:00:00Z'); // 台灣 10/30 下午 1 點
const b = formatEventBasics({ event_date: '2026-10-28', event_time: '09:00~11:50', venue: '臺大醫院國際會議中心 201', press_contact: '朱則瑋' }, now);
check('第三天：照舊寫明第一天已經過了 2 天、現在時間是 10/30', b.includes('已經在 2 天前舉行') && b.includes('現在時間：2026-10-30'), b);
check('★ 補上「多天的活動：上面是第一天，還沒到的場次照議程回答，不要說整個活動已經結束」', /活動跨好幾天時.*上面的活動日期是第一天.*還沒到的場次照議程的日期回答.*不要說整個活動已經結束/.test(b), b);
const noDate = formatEventBasics({ event_date: '2026/6/18 下午11:06:04', venue: 'A 館' }, now);
check('沒有正式日期（只有建立時間戳）就不加這句——沒有「第一天」可言', noDate && !noDate.includes('跨好幾天'), noDate);
check('原本的規則一個字都沒少（不一致就兩個都列、不用未來式）', b.includes('背景資料裡的說法跟這裡不一致時，兩個都列出來，並建議洽新聞聯絡人確認。已經舉行過的活動不要用未來式描述。'));
console.log(`\n${fail ? '❌' : '✅'} 批次 169 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
