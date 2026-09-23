// tools/geo-ui-check 用的合成 GEO 資料（批次 72）：3 個議題 × 3 題 × 2 引擎 × 90 天，
// 一場 40 天前的活動（固態電池，發稿後拉抬、第 15–30 天回落一半），約 3% 的掃描失敗。
// 數字是亂數產生的，只拿來看畫面與流程，不代表任何真實結果。
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const tw = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const today = new Date();
const dayStr = (off) => tw(new Date(today.getTime() - off * 86400000));
const KW = [
  { kw: '固態電池', base: 0.35, bump: 0.35 },
  { kw: '矽光子', base: 0.55, bump: 0 },
  { kw: '無人機', base: 0.2, bump: 0 },
];
const RIVALS = ['台積電', '資策會', '清華大學', '成功大學', '中研院', '鴻海'];
export const sheets = { geo_prompts: [], geo_runs: [], geo_events: [], geo_settings: [['engines', 'claude,gemini'], ['staff_code', 'abc']], events: [] };
let pid = 0;
for (const k of KW) for (let i = 0; i < 3; i++) {
  sheets.geo_prompts.push([`p${++pid}`, k.kw, `台灣在${k.kw}領域有哪些研究單位做得比較前面？（${i}）`, k.kw, '工研院', '', 'TRUE', dayStr(95)]);
}
const EVT_OFF = 40;
sheets.geo_events.push(['e1', dayStr(EVT_OFF), '固態電池技術發表會', '記者會', '固態電池', '', 'ev-solid', 'TRUE']);
sheets.events.push(['ev-solid', '固態電池技術發表會', '#0F9E7A', 'kb', 'ended', dayStr(EVT_OFF)]);
sheets.events.push(['ev-drone', '無人機應用論壇', '#0F9E7A', 'kb', 'active', dayStr(-10)]);
for (let off = 89; off >= 0; off--) {
  for (const p of sheets.geo_prompts) {
    const k = KW.find((x) => x.kw === p[3]);
    let prob = k.base;
    if (k.bump) { const d = EVT_OFF - off; if (d >= 0 && d < 14) prob += k.bump; else if (d >= 14 && d < 30) prob += k.bump * 0.5; else if (d >= 30) prob += k.bump * 0.3; }
    for (const eng of ['claude', 'gemini']) {
      if (rnd() < 0.03) { sheets.geo_runs.push([dayStr(off), '', p[0], p[1], p[3], eng, '', '', '', '', '', '', '', '', 'timeout']); continue; }
      const m = rnd() < prob; const rank = m ? 1 + Math.floor(rnd() * 3) : 0; const cited = m && rnd() < 0.4; const spec = m && rnd() < 0.6;
      const score = (m ? 45 : 0) + (m ? Math.round(20 * (1 - (rank - 1) / 3)) : 0) + (cited ? 20 : 0) + (spec ? 15 : 0);
      const rivals = RIVALS.filter(() => rnd() < 0.35).join('、');
      sheets.geo_runs.push([dayStr(off), dayStr(off) + 'T01:00', p[0], p[1], p[3], eng, m ? 'TRUE' : 'FALSE', String(rank), cited ? 'TRUE' : 'FALSE',
        cited ? 'https://www.itri.org.tw/x|https://news.example.com/y' : 'https://news.example.com/y', spec ? 'TRUE' : 'FALSE', String(score), rivals,
        m ? `在${k.kw}方面，工研院與${rivals || '多所大學'}都有投入，其中工研院已開發出…` : `${k.kw}領域的主要研究單位包括${rivals || '多所大學'}…`, '']);
    }
  }
}
