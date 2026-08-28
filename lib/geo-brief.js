// GEO 職員簡報——把 api/geo.js 的 action=status／action=series 資料組成一則同仁看得懂、
// 一眼抓得到重點的 LINE 訊息。
//
// 為什麼重做：舊版靠 QuickChart.io 把整張 Chart.js 設定塞進網址查詢字串再讓 LINE 去抓圖，
// 14 天的資料量實測網址長度落在 1200+ 字元，超過 LINE image 訊息 originalContentUrl
// 官方文件記載的 1000 字元上限——LINE 收到超長網址直接顯示一張抓不到的壞圖示，不是
// 偶發，是這個做法在資料量到一定規模後注定會壞。改成 LINE 原生 Flex Message：長條圖
// 用巢狀 box 的寬度百分比畫，不靠外部服務、沒有網址長度這個天花板，退件時（舊版
// LINE App、Flex 格式被拒）自動退回純文字版（全形方塊字元湊出來的長條）。
//
// 不重新實作 api/geo.js 的評分／半衰期／基線抬升／結構化稿判定邏輯——那些規則背後
// 是實測校準過的方法論（見 api/geo.js diagnoseEvent() 的完整說明），這裡只負責排版，
// 直接使用 action=series 已經算好的 events［］.findings／board［］.findings。

const BRAND = '#0F9E7A';
const WARN = '#B45309';
const BAD = '#B91C1C';
const MUTED = '#6B7280';

const arrow = (delta) => {
  if (delta === null || delta === undefined) return '';
  if (delta > 0) return `▲${delta}`;
  if (delta < 0) return `▼${Math.abs(delta)}`;
  return '→0';
};
const arrowColor = (delta) => (delta > 0 ? BRAND : delta < 0 ? BAD : MUTED);

// ── Flex：長條圖用巢狀 box 的寬度百分比畫 ─────────────────────────────
// 外層固定寬度的灰色軌道＋內層依分數百分比縮短的實心色塊，這是 LINE Flex 畫長條圖
// 的標準手法（跟 lib/menu.js numberedStep() 用固定寬高的 box 畫圓形號碼同一招）。
// filler 是 LINE Flex 專門用來撐開空 box 的元件，不然內層 box 沒有文字內容會被拒。
function barRow(label, score, delta, subLabel) {
  const pct = score === null ? 0 : Math.max(score <= 0 ? 0 : 3, Math.min(100, score)); // 有分數但很低時至少露出一點色塊，不會看起來像沒資料
  return {
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md',
    contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: label, size: 'xs', weight: 'bold', color: '#1A1A2E', flex: 1, wrap: true },
        { type: 'text', text: score === null ? '—' : `${score} ${arrow(delta)}`, size: 'xs', color: score === null ? MUTED : arrowColor(delta), flex: 0 }
      ]},
      { type: 'box', layout: 'vertical', height: '6px', backgroundColor: '#E5E7EB', cornerRadius: '3px', contents: [
        { type: 'box', layout: 'vertical', height: '6px', width: `${pct}%`, backgroundColor: BRAND, cornerRadius: '3px', contents: [{ type: 'filler' }] }
      ]},
      ...(subLabel ? [{ type: 'text', text: subLabel, size: 'xxs', color: MUTED, margin: 'xs', wrap: true }] : [])
    ]
  };
}

function sectionTitle(text) {
  return { type: 'text', text, size: 'sm', weight: 'bold', color: '#1A1A2E', margin: 'xl' };
}

// 一場活動的重點：基線→峰值→（settled 才有）30 天後回頭看的抬升；只挑第一條
// bad／good 等級的 finding 當這場的一句話重點，too much 反而沒人看。
function eventRow(ev) {
  const trend = ev.baseline === null && ev.peak === null
    ? '尚無足夠掃描資料'
    : `基線 ${ev.baseline ?? '—'} → 峰值 ${ev.peak ?? '—'}${ev.halfLifeDays !== null ? `（${ev.halfLifeDays} 天半衰）` : ''}`;
  const liftText = !ev.settled
    ? '30 天觀察期還沒到，暫不評斷留存'
    : ev.lift === null ? '' : ev.lift > 0 ? `30 天後基線 +${ev.lift}` : `30 天後回到原點（${ev.lift}）`;
  const topFinding = ev.findings?.find(f => f.level === 'bad') || ev.findings?.find(f => f.level === 'good') || null;

  return {
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', paddingAll: '10px',
    backgroundColor: '#F9FAFB', cornerRadius: '8px',
    contents: [
      { type: 'text', text: ev.title || ev.id, size: 'xs', weight: 'bold', color: '#1A1A2E', wrap: true },
      { type: 'text', text: `${ev.date || ''}｜${trend}`, size: 'xxs', color: MUTED, wrap: true, margin: 'xs' },
      ...(liftText ? [{ type: 'text', text: liftText, size: 'xxs', color: ev.lift > 0 ? BRAND : MUTED, wrap: true }] : []),
      ...(topFinding ? [{
        type: 'text', wrap: true, size: 'xxs', margin: 'xs',
        color: topFinding.level === 'bad' ? BAD : topFinding.level === 'good' ? BRAND : WARN,
        text: `${topFinding.level === 'bad' ? '⚠ ' : topFinding.level === 'good' ? '✓ ' : ''}${topFinding.title}`
      }] : [])
    ]
  };
}

const MAX_TOPICS = 5;
const MAX_EVENTS = 4;

/**
 * statusData：getGeoStatusSummary()（action=status）的回傳，可能是 null。
 * seriesData：getGeoTrendSeries()（action=series）的回傳，可能是 null。
 * 兩邊都可能各自失敗（例如其中一個查詢逾時），不能因為一邊沒資料就整份簡報開天窗。
 * 回傳 null 代表兩邊都完全沒有可用資料，呼叫端這時應該退回純文字的「查詢失敗」訊息，
 * 不要送一個空殼 Flex 卡片。
 */
export function buildGeoBriefFlex(statusData, seriesData, siteUrl) {
  if (!statusData && !seriesData) return null;

  const summary = seriesData?.summary;
  const board = (seriesData?.board || []).filter(b => b.score !== null).slice(0, MAX_TOPICS);
  const events = (seriesData?.events || []).slice(-MAX_EVENTS).reverse(); // 最近的活動排前面

  const body = [];

  // 今日掃描進度＋環境檢查——同仁最直接想知道「掃描還活著嗎」
  if (statusData) {
    body.push({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '今日掃描', size: 'xs', color: MUTED, flex: 0 },
        { type: 'text', text: `${statusData.done ?? '—'} / ${statusData.total ?? '—'}`, size: 'xs', color: '#1A1A2E', weight: 'bold', flex: 0, margin: 'sm' }
      ]
    });
    if (statusData.ready) {
      body.push({ type: 'text', text: `⚠ ${statusData.ready}`, size: 'xxs', color: BAD, wrap: true, margin: 'xs' });
    }
  }

  // 近 14 天總覽三個數字
  if (summary && summary.samples) {
    body.push(sectionTitle('近 14 天總覽'));
    body.push({
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        statTile('平均分數', summary.score14),
        statTile('提及率', summary.mentionRate14 !== null ? `${summary.mentionRate14}%` : '—'),
        statTile('引用率', summary.citedRate14 !== null ? `${summary.citedRate14}%` : '—')
      ]
    });
    if (summary.failed14 > 0) {
      body.push({ type: 'text', text: `近 14 天有 ${summary.failed14} 次掃描失敗，樣本數可能被低估`, size: 'xxs', color: WARN, margin: 'xs', wrap: true });
    }
  }

  // 監視中的議題（排行）
  if (board.length) {
    body.push(sectionTitle('監視中的議題'));
    board.forEach(b => {
      const sub = `提及 ${b.mentionRate ?? '—'}%　引用 ${b.citedRate ?? '—'}%　樣本 ${b.samples}`;
      body.push(barRow(b.keyword, b.score, b.delta, sub));
    });
  }

  // 追蹤中的活動
  if (events.length) {
    body.push(sectionTitle('追蹤中的活動'));
    events.forEach(ev => body.push(eventRow(ev)));
  }

  if (!board.length && !events.length && !(summary && summary.samples)) {
    body.push({ type: 'text', text: '目前掃描資料還不夠，累積幾天後再回來看會更準。', size: 'xs', color: MUTED, wrap: true, margin: 'md' });
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px', spacing: 'xs',
      contents: [
        { type: 'text', text: 'GEO 績效簡報', size: 'lg', weight: 'bold', color: '#FFFFFF' },
        { type: 'text', text: statusData?.date || seriesData?.summary?.lastScan || '', size: 'xs', color: '#D8F3EA' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'none', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm',
      contents: [
        { type: 'button', height: 'sm', style: 'secondary', action: { type: 'uri', label: '完整儀表板', uri: `${siteUrl}/geo` } },
        { type: 'text', text: '方法論依據：AMEC；半衰期／基線抬升／結構化稿判定為規則式計算，非模型生成。', size: 'xxs', color: MUTED, wrap: true, margin: 'sm' }
      ]
    }
  };

  return {
    type: 'flex',
    altText: `GEO 績效簡報：${summary?.samples ? `近 14 天平均分數 ${summary.score14}` : '今日掃描進度 ' + (statusData?.done ?? '—') + '/' + (statusData?.total ?? '—')}，完整資料請見 /geo。`,
    contents: bubble
  };
}

function statTile(label, value) {
  return {
    type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
    contents: [
      { type: 'text', text: String(value ?? '—'), size: 'md', weight: 'bold', color: '#1A1A2E', align: 'center' },
      { type: 'text', text: label, size: 'xxs', color: MUTED, align: 'center' }
    ]
  };
}

// ── 純文字退版：全形方塊字元湊出來的長條，Flex 送不出去時（舊版 LINE App、
// 訊息格式被拒）呼叫端會退回這支，跟 lib/menu.js buildWelcomeFlex 同一套降級模式。
const BLOCKS = 10;
function textBar(score) {
  const filled = score === null ? 0 : Math.round(Math.max(0, Math.min(100, score)) / 100 * BLOCKS);
  return '█'.repeat(filled) + '░'.repeat(BLOCKS - filled);
}

export function formatGeoBriefText(statusData, seriesData, siteUrl) {
  if (!statusData && !seriesData) {
    return `目前查詢不到 GEO 資料，可能是這個功能還沒啟用，或內部查詢暫時失敗。\n\n直接看儀表板：\n${siteUrl}/geo`;
  }
  const lines = [`【GEO 績效簡報】${statusData?.date || seriesData?.summary?.lastScan || ''}`];

  if (statusData) {
    lines.push(`今日掃描：${statusData.done ?? '—'} / ${statusData.total ?? '—'}`);
    if (statusData.ready) lines.push(`⚠ ${statusData.ready}`);
  }

  const summary = seriesData?.summary;
  if (summary && summary.samples) {
    lines.push('', '近 14 天：平均分數 ' + (summary.score14 ?? '—')
      + '　提及率 ' + (summary.mentionRate14 !== null ? summary.mentionRate14 + '%' : '—')
      + '　引用率 ' + (summary.citedRate14 !== null ? summary.citedRate14 + '%' : '—'));
    if (summary.failed14 > 0) lines.push(`（近 14 天 ${summary.failed14} 次掃描失敗，樣本可能被低估）`);
  }

  const board = (seriesData?.board || []).filter(b => b.score !== null).slice(0, MAX_TOPICS);
  if (board.length) {
    lines.push('', '【監視中的議題】');
    board.forEach(b => lines.push(`${textBar(b.score)} ${b.score} ${arrow(b.delta)}　${b.keyword}`));
  }

  const events = (seriesData?.events || []).slice(-MAX_EVENTS).reverse();
  if (events.length) {
    lines.push('', '【追蹤中的活動】');
    events.forEach(ev => {
      const trend = ev.baseline === null && ev.peak === null
        ? '尚無足夠掃描資料' : `基線${ev.baseline ?? '—'}→峰值${ev.peak ?? '—'}`;
      lines.push(`・${ev.title || ev.id}（${ev.date || ''}）${trend}`);
    });
  }

  if (!board.length && !events.length && !(summary && summary.samples)) {
    lines.push('', '目前掃描資料還不夠，累積幾天後再回來看會更準。');
  }

  lines.push('', `完整儀表板：\n${siteUrl}/geo`);
  return lines.join('\n');
}
