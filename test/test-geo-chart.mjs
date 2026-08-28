// GEO 職員簡報（lib/geo-brief.js）的純函式測試——不碰網路，直接餵 api/geo.js
// action=status／action=series 形狀的樣本資料。
//
// 為什麼重寫這支：原本測的 buildGeoTrendChartUrl()（QuickChart.io 網址）已經移除——
// 使用者回報圖表在 LINE 裡長期顯示壞掉的圖示，查證後是 14 天資料量組出來的網址
// 實測落在 1200+ 字元，超過 LINE image 訊息 originalContentUrl 官方文件記載的
// 1000 字元上限，不是偶發，是這個做法資料量到一定規模後注定會壞。改用 LINE 原生
// Flex Message 畫長條圖，這支測 Flex 結構本身，以及 Flex 送不出去時的純文字退版。
import { buildGeoBriefFlex, formatGeoBriefText } from '../lib/geo-brief.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

const SITE = 'https://itri-event-ai.vercel.app';

const status = {
  date: '2026-08-28', done: 8, total: 20, remaining: 12,
  engines: [{ id: 'gemini', label: 'Gemini（Google 搜尋接地）', enabled: true }],
  judge: 'gemini / gemini-3.6-flash', cronSecretSet: true, ready: null
};

const series = {
  summary: { samples: 84, lastScan: '2026-08-28', score14: 52.3, mentionRate14: 61, citedRate14: 34, failed14: 0 },
  board: [
    { keyword: '化合物半導體', score: 68.5, delta: 4.2, mentionRate: 80, citedRate: 50, samples: 14, findings: [] },
    { keyword: '邊緣AI', score: 41.0, delta: -3.5, mentionRate: 40, citedRate: 10, samples: 14, findings: [] },
    { keyword: '智慧醫療', score: null, delta: null, mentionRate: null, citedRate: null, samples: 1, findings: [] }, // 樣本太少，分數還沒算出來——不該出現在長條圖榜單
  ],
  events: [
    {
      id: 'ev1', date: '2026-07-01', title: '四足機器人發表記者會', type: '記者會', structured: true,
      baseline: 30, peak: 72, peakDate: '2026-07-02', halfLifeDays: 5,
      lift: 12, settled: true, daysToFirstCitation: 2, citationWindowComplete: true,
      findings: [{ level: 'good', title: '基線被抬升了 +12', why: '', todo: '' }], windowSamples: 20
    },
    {
      id: 'ev2', date: '2026-08-20', title: '固態電池發表會', type: '記者會', structured: null,
      baseline: 25, peak: 55, peakDate: '2026-08-21', halfLifeDays: null,
      lift: null, settled: false, daysToFirstCitation: null, citationWindowComplete: false,
      findings: [], windowSamples: 6
    },
  ],
};

console.log('── buildGeoBriefFlex：基本結構 ──');
{
  const flex = buildGeoBriefFlex(status, series, SITE);
  check('回傳 type=flex', flex.type === 'flex');
  check('altText 存在且在 LINE 400 字上限內', typeof flex.altText === 'string' && flex.altText.length > 0 && flex.altText.length <= 400, flex.altText);
  check('bubble 結構', flex.contents.type === 'bubble');
  check('footer 按鈕帶完整儀表板網址', JSON.stringify(flex.contents.footer).includes(`${SITE}/geo`));
  check('沒有把 ADMIN_PASSWORD 或任何密碼字樣帶進卡片內容——這是要直接送進 LINE 對話的內容',
    !/password/i.test(JSON.stringify(flex)), 'flex 內容含 password 字樣');
}

console.log('── buildGeoBriefFlex：今日進度與警訊 ──');
{
  const flex = buildGeoBriefFlex(status, series, SITE);
  const s = JSON.stringify(flex.contents.body);
  check('今日進度數字有出現（8 / 20）', s.includes('"8 / 20"') || (s.includes('"8"') && s.includes('"20"')));
  const warn = buildGeoBriefFlex({ ...status, ready: '尚未設定任何引擎的 API key' }, series, SITE);
  check('ready 警訊要顯示（唯一值得標出來的內部狀態）',
    JSON.stringify(warn.contents.body).includes('尚未設定任何引擎的 API key'));
}

console.log('── buildGeoBriefFlex：監視中的議題（長條圖）──');
{
  const flex = buildGeoBriefFlex(status, series, SITE);
  check('議題名稱有出現在卡片內容裡', JSON.stringify(flex.contents.body).includes('化合物半導體'));
  check('分數 null 的項目（樣本太少）不會出現在長條圖榜單——沒算出分數的東西畫成長條圖只會誤導',
    !JSON.stringify(flex.contents.body).includes('智慧醫療'));

  // 長條寬度百分比要對得上分數；找出第一個議題（化合物半導體，score=68.5）的長條 box
  const flat = JSON.stringify(flex.contents.body);
  check('分數 68.5 的長條寬度算成 68.5%（沒有偷四捨五入成別的數字）', flat.includes('"width":"68.5%"'), flat);
  check('分數上升要有 ▲ 標記', flat.includes('▲4.2'));
  check('分數下降要有 ▼ 標記（絕對值，不該出現負號）', flat.includes('▼3.5') && !flat.includes('▼-3.5'));
}

console.log('── buildGeoBriefFlex：追蹤中的活動（settled 才給留存數字）──');
{
  const flex = buildGeoBriefFlex(status, series, SITE);
  const flat = JSON.stringify(flex.contents.body);
  check('已 settled 的活動顯示基線抬升數字', flat.includes('30 天後基線 +12'));
  check('已 settled 的活動附上找到的重點 finding', flat.includes('基線被抬升了 +12'));
  check('還沒 settled 的活動改顯示觀察中，不能提前下留存結論（這是 api/geo.js 已校準過的判定門檻，這裡只負責排版不重判）',
    flat.includes('30 天觀察期還沒到，暫不評斷留存'));
  check('還沒 settled 的活動不會出現任何 lift 數字', !flat.includes('固態電池') || !/固態電池[\s\S]{0,200}30 天後基線/.test(flat));
}

console.log('── buildGeoBriefFlex：兩份資料都拿不到時回 null，呼叫端才知道要退回純文字 ──');
{
  check('statusData／seriesData 都是 null', buildGeoBriefFlex(null, null, SITE) === null);
  check('只有 statusData 缺，seriesData 還在 → 仍然要生得出卡片', buildGeoBriefFlex(null, series, SITE) !== null);
  check('只有 seriesData 缺，statusData 還在 → 仍然要生得出卡片', buildGeoBriefFlex(status, null, SITE) !== null);
}

console.log('── buildGeoBriefFlex：完全沒有議題／活動資料時不留空區塊 ──');
{
  const empty = buildGeoBriefFlex(status, { summary: { samples: 0 }, board: [], events: [] }, SITE);
  check('沒資料時給出「還不夠」的引導文字，不是留白', JSON.stringify(empty.contents.body).includes('目前掃描資料還不夠'));
}

console.log('── formatGeoBriefText：純文字退版 ──');
{
  const text = formatGeoBriefText(status, series, SITE);
  check('保留日期與今日進度', /2026-08-28/.test(text) && /8 \/ 20/.test(text), text);
  check('附上完整儀表板連結', text.includes(`${SITE}/geo`), text);
  check('用全形方塊字元畫長條（10 格）', /[█░]{10}/.test(text), text);
  check('議題名稱有出現', text.includes('化合物半導體'), text);
  check('活動的基線→峰值有出現', text.includes('基線30→峰值72') || text.includes('基線 30 → 峰值 72') || /基線30.*峰值72/.test(text), text);
}

console.log('── formatGeoBriefText：兩份資料都查不到時，仍要給出可行動的連結，不是一片空白 ──');
{
  const noneText = formatGeoBriefText(null, null, SITE);
  check('查不到資料仍附 /geo 連結', noneText.includes(`${SITE}/geo`), noneText);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} GEO 圖表測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
