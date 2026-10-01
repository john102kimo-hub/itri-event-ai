// 批次 102：GEO 測量方法對齊 AMEC／IAB 準則＋工研院相關用語追蹤。
//
// 三層一起測，因為這個專案在同一個形狀上踩過四次——「絕對不能發生」的事不能只靠一層：
//   一、純函式（lib/geo-orgs.js 詞表、lib/geo-metrics.js 指標）：數字算對、邊界不出錯。
//   二、真的 api/geo.js ＋ 假 Google Sheets：報告與 method 動作實際吐出來的東西。
//   三、public/geo.html 的渲染函式，餵的是第二層**真的後端輸出**：畫面不能自己生數字、
//      AI 回答原文不能直接進 HTML。
// 外部模型一律不碰。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const { book, reset } = await import('./fakes-sheets82.mjs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
const near = (a, b, eps = 0.011) => a !== null && a !== undefined && Math.abs(a - b) <= eps;

const orgs = await import('../lib/geo-orgs.js');
const M = await import('../lib/geo-metrics.js');

// ═══ 一、詞表（lib/geo-orgs.js）══════════════════════════════════════════════
console.log('\n── 一、工研院相關用語詞表：三級，簡稱只當相關用語、不算提到 ──');
{
  const { BRAND_NAMES, BRAND_UNITS, BRAND_SHORT, BRAND_ALIAS_RE, BRAND_NAME_RE, findBrandTerms, resolveOrg, BRAND_KEY, BRAND_JUDGE_HINT } = orgs;

  // 官網組織架構頁（2026-10-01 核對）的研發與營運單位，缺一個就是詞表漏了
  const OFFICIAL = ['電子與光電系統研究所', '資訊與通訊研究所', '機械與機電系統研究所', '材料與化工研究所',
    '綠能與環境研究所', '生醫與醫材研究所', '產業科技國際策略發展所', '無人化創新科技研究所', '量測技術發展中心',
    '服務系統科技中心', '智慧感測與系統科技中心'];
  for (const u of OFFICIAL) check(`官網的單位全名「${u}」在詞表裡`, BRAND_UNITS.includes(u));
  for (const u of ['產業學院', '南分院', '中分院', '產業服務中心']) {
    check(`通用名稱「${u}」放在簡稱級（單獨出現不能斷定是工研院）`, BRAND_SHORT.includes(u) && !BRAND_UNITS.includes(u));
  }

  for (const t of [...BRAND_NAMES, ...BRAND_UNITS]) check(`題目防呆（BRAND_ALIAS_RE）認得「${t}」`, BRAND_ALIAS_RE.test(t));
  for (const t of BRAND_SHORT) check(`單位簡稱「${t}」不在 BRAND_ALIAS_RE 裡（歧義，交給 findBrandTerms）`, !BRAND_ALIAS_RE.test(t));
  check('BRAND_NAME_RE（稿件檢核用）跟批次 82 的 BRAND_ALIAS_RE 逐字相同',
    String(BRAND_NAME_RE) === String(/工研院|工業技術研究院|工业技术研究院|\b(?:ITRI|IEK|ISTI)\b|Industrial\s+Technology\s+Research\s+Institute/i),
    String(BRAND_NAME_RE));
  check('BRAND_ALIAS_RE 不含 lookbehind（iOS 16.4 以前的 Safari 會整支 script 語法錯誤）', !/\(\?<[=!]/.test(String(BRAND_ALIAS_RE)));
  const html = read('public/geo.html');
  const mirror = html.match(/const BRAND_ALIAS_RE = (\/.*\/i);/);
  check('GEO 頁鏡射的別名規則 = lib/geo-orgs.js 那一份', mirror && mirror[1] === String(BRAND_ALIAS_RE), mirror && mirror[1]);

  const CASES = [
    ['工研院材化所開發的技術', { strong: true, names: ['工研院'], short: ['材化所'] }],
    ['電子與光電系統研究所在做 micro LED', { strong: true, units: ['電子與光電系統研究所'] }],
    ['無人化創新科技研究所發表', { strong: true, units: ['無人化創新科技研究所'] }],
    ['產科國際所的分析師指出', { strong: true, units: ['產科國際所'] }],
    ['ITRI 與 IEK 的報告', { strong: true, names: ['ITRI', 'IEK'] }],
    ['Industrial  Technology Research Institute 的研究', { strong: true, names: ['Industrial Technology Research Institute'] }],
    ['電光所推出新技術', { strong: false, short: ['電光所'] }],
    ['成大電光所有研究', { strong: false, short: [] }],
    ['陽明交大電光所與台大機械所合作', { strong: false, short: [] }],
    ['國立成功大學電光所', { strong: false, short: [] }],
    ['台灣大學機械所', { strong: false, short: [] }],
    ['氮化物 nitride 與 statistics、logistics', { strong: false, short: [] }],
    ['資策會與台大', { strong: false, short: [] }],
    ['', { strong: false, short: [] }],
  ];
  for (const [text, exp] of CASES) {
    const t = findBrandTerms(text);
    const ok = t.strong === exp.strong
      && (!exp.names || JSON.stringify(t.names) === JSON.stringify(exp.names))
      && (!exp.units || JSON.stringify(t.units) === JSON.stringify(exp.units))
      && (!exp.short || JSON.stringify(t.short) === JSON.stringify(exp.short));
    check(`findBrandTerms：「${text}」`, ok, JSON.stringify(t));
  }
  check('★ 簡稱不算「提到」：只寫「電光所」→ strong 為 false', findBrandTerms('電光所推出新技術').strong === false);
  check('findBrandTerms 對 null／undefined 不丟例外', !findBrandTerms(null).strong && !findBrandTerms(undefined).strong);

  for (const u of BRAND_UNITS) check(`排行把「${u}」併進工研院`, resolveOrg(u).key === BRAND_KEY, resolveOrg(u).key);
  check('★ 「台大機械所」歸台大，不會因為包含「機械所」被併進工研院', resolveOrg('台大機械所').key !== BRAND_KEY, resolveOrg('台大機械所').key);
  check('「成大電光所」歸成大', resolveOrg('成大電光所').key === '成大', resolveOrg('成大電光所').key);
  check('「ITRI 材化所」仍併進工研院（批次 82）', resolveOrg('ITRI 材化所').key === BRAND_KEY);

  check('判官提示詞的同義寫法由詞表產生：每個單位全名都在', BRAND_UNITS.every((u) => BRAND_JUDGE_HINT.includes(u)));
  check('判官提示詞列出每個單位簡稱', BRAND_SHORT.every((u) => BRAND_JUDGE_HINT.includes(u)));
  check('判官提示詞講明「成大電光所」那類不算', /成大電光所/.test(BRAND_JUDGE_HINT) && /不是工研院/.test(BRAND_JUDGE_HINT));
  check('api/geo.js 的判官同義詞確實用詞表那一份', /return BRAND_JUDGE_HINT;/.test(read('api/geo.js')));

  // 稿件檢核：第一段只寫單位全名、沒寫工研院，那一項要判不及格（AI 讀完不見得連得回品牌）
  const { checkGeoDraft } = await import('../lib/geo-draft-check.js');
  const lead = (txt) => checkGeoDraft(`標題\n\n${txt}\n\n第二段。`).checks.find((c) => c.key === 'lead_brand');
  check('稿件檢核：第一段只寫「電子與光電系統研究所」→ 不算點名工研院', lead('電子與光電系統研究所今天發表新技術。')?.pass === false);
  check('稿件檢核：第一段寫「工研院」→ 通過', lead('工研院今天發表新技術。')?.pass === true);
  check('稿件檢核：第一段寫「ITRI」→ 通過（批次 82 行為不變）', lead('ITRI announced a new chip.')?.pass === true);
}

// ═══ 二、綜合指數與分項指標（lib/geo-metrics.js）═══════════════════════════════
console.log('\n── 二、綜合指數：公式不變，權重只有一份 ──');
{
  const OLD = ({ mentioned, rank, cited, specifics }) => {
    if (!mentioned) return 0;
    const rankPts = rank === 1 ? 20 : rank === 2 ? 14 : rank === 3 ? 9 : 5;
    return 45 + rankPts + (cited ? 20 : 0) + (specifics ? 15 : 0);
  };
  let bad = 0, n = 0;
  for (const mentioned of [false, true]) for (const rank of [0, 1, 2, 3, 4, 9]) for (const cited of [false, true]) for (const specifics of [false, true]) {
    n++; if (OLD({ mentioned, rank, cited, specifics }) !== M.compositeScore({ mentioned, rank, cited, specifics })) bad++;
  }
  check(`compositeScore 與批次 102 以前的 scoreOf 逐項一致（${n} 組）`, bad === 0, `不一致 ${bad}`);
  check('滿分 100（提及 45＋位置 20＋引用 20＋內容 15）',
    M.compositeScore({ mentioned: true, rank: 1, cited: true, specifics: true }) === 100);
  check('沒提到＝0，其餘三項都不算', M.compositeScore({ mentioned: false, rank: 1, cited: true, specifics: true }) === 0);
  check('COMPOSITE 被凍結，執行中不能被改', Object.isFrozen(M.COMPOSITE) && Object.isFrozen(M.COMPOSITE.rankPoints));
  const api = read('api/geo.js');
  check('api/geo.js 的 scoreOf 只是呼叫 compositeScore，沒有另外一份權重', /const scoreOf = \(obs\) => compositeScore\(obs\);/.test(api)
    && !/45 \+ rankPts/.test(api));
}

console.log('\n── 三、比例型指標：以「天」為群集的 bootstrap 區間 ──');
{
  const mk = (date, mentioned, extra = {}) => ({ date, keyword: 'K', engine: 'claude', mentioned, rank: mentioned ? 1 : 0, cited: false, specifics: false, competitors: '', excerpt: '', score: 0, error: '', ...extra });
  const d = (i) => `2026-09-${String(i + 1).padStart(2, '0')}`;

  // 每天一半一半（天與天之間沒有差異）→ 區間應該很窄
  const flat = []; for (let i = 0; i < 14; i++) for (let j = 0; j < 4; j++) flat.push(mk(d(i), j < 2));
  const rf = M.rateWithCI(flat, (r) => r.mentioned);
  check('每天都是 50%：k／n／pct 正確', rf.k === 28 && rf.n === 56 && rf.pct === 50, JSON.stringify(rf));
  check('每天都一樣 → 區間縮成一點（沒有天與天的變異）', rf.ci && rf.ci[0] === 50 && rf.ci[1] === 50, JSON.stringify(rf.ci));

  // 20 天裡 10 天全中、10 天全不中：天與天差很大，區間必須明顯比「把 80 筆當獨立樣本」的二項式區間寬
  const wild = []; for (let i = 0; i < 20; i++) for (let j = 0; j < 4; j++) wild.push(mk(d(i), i % 2 === 0));
  const rw = M.rateWithCI(wild, (r) => r.mentioned);
  check('★ 天與天差很大時區間要夠寬（當獨立樣本算只有約 22pp，群集 bootstrap 約 44pp）', rw.ci && rw.ci[1] - rw.ci[0] > 30, JSON.stringify(rw));
  check('區間包得住點估計', rw.ci[0] <= rw.pct && rw.pct <= rw.ci[1]);
  const rw2 = M.rateWithCI(wild, (r) => r.mentioned);
  check('★ 固定種子：同一份資料算兩次，區間一模一樣（報告不能一重整就換數字）', JSON.stringify(rw) === JSON.stringify(rw2));

  const few = []; for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) few.push(mk(d(i), j < 2));
  const rfew = M.rateWithCI(few, (r) => r.mentioned);
  check('★ 不到 7 天不給區間（ci 為 null），但點估計照給', rfew.ci === null && rfew.pct === 50 && rfew.days === 5, JSON.stringify(rfew));
  check('空資料不丟例外', M.rateWithCI([], () => true).pct === null && M.shareOfVoice([]).pct === null && M.reciprocalRank([]).mrr === null);

  // Share of Voice：每則回答每家機構只計一次，同一家的不同寫法先併起來
  const sov = M.shareOfVoice([
    mk(d(0), true, { competitors: '資策會 MIC、資策會產業情報研究所、台大' }),
    mk(d(0), false, { competitors: '資策會' }),
  ]);
  check('SoV：同一列「資策會 MIC」「資策會產業情報研究所」只算 1 家 → 對手 3 次、工研院 1 次、占 25%',
    sov.self === 1 && sov.others === 3 && sov.total === 4 && sov.pct === 25, JSON.stringify(sov));
  check('SoV：競爭集合＝這批回答裡出現的機構（工研院、資策會、台大＝3 家）', sov.orgs === 3, String(sov.orgs));
  check('SoV：沒有任何機構被點名時不除以零', M.shareOfVoice([mk(d(0), false)]).pct === null);

  // 倒數名次
  const rr = M.reciprocalRank([
    mk(d(0), true, { rank: 1 }), mk(d(0), true, { rank: 2 }), mk(d(0), true, { rank: 3 }),
    mk(d(0), false), mk(d(0), true, { rank: 0 }),
  ]);
  check('MRR：(1＋1/2＋1/3＋0＋0)/5 ≈ 0.37', near(rr.mrr, 0.37, 0.006), JSON.stringify(rr));
  check('MRR：判官沒給名次的那筆另外數出來（不默默當 1，也不默默丟掉）', rr.unranked === 1 && rr.mentioned === 4, JSON.stringify(rr));
  check('被提到時排第一的比例＝1／4＝25%', rr.firstPct === 25, String(rr.firstPct));

  // 分母
  const dn = M.denominators([mk(d(0), true), mk(d(0), true), mk(d(0), false),
    { ...mk(d(0), false), score: null, error: '接地未生效：回應沒有任何搜尋來源，此筆不計分' },
    { ...mk(d(0), false), score: null, error: 'timeout' }]);
  check('分母：嘗試 5、有效 3、不計分 2（其中沒有搜尋來源 1、其他錯誤 1），有效率 60%',
    dn.attempted === 5 && dn.scored === 3 && dn.failed === 2 && dn.noGround === 1 && dn.otherFailed === 1 && dn.pct === 60, JSON.stringify(dn));
  check('分母：沒有任何 run 時有效率為 null，不是 NaN', M.denominators([]).pct === null);

  // 測量等級
  const t12 = M.measurementTier({ prompts: 12, engines: 2 });
  const t49 = M.measurementTier({ prompts: 49, engines: 2 });
  const t50 = M.measurementTier({ prompts: 50, engines: 3 });
  check('12 題 → 探索性', t12.level === 'exploratory' && /探索性/.test(t12.label));
  check('49 題仍是探索性，50 題才是方向性（IAB 門檻：少於 50 題＝探索性）', t49.level === 'exploratory' && t50.level === 'directional');
  check('★ 任何情況都不宣稱決策等級', [t12, t49, t50].every((t) => t.decisionGrade === false));
  check('題數不足時要寫出 IAB 的 50 題門檻與 AMEC 的 25／50／100 題', /50 題/.test(t12.gaps[0]) && /25／50／100/.test(t12.gaps[0]), t12.gaps[0]);
  check('多個議題時講明是「每個議題最多」幾題，不拿加總灌水',
    /每個議題最多只有 4 題（全部 30 題分散在 8 個議題）/.test(M.measurementTier({ prompts: 4, totalPrompts: 30, topics: 8, engines: 2 }).gaps[0]));
  check('只有一個引擎時要講', M.measurementTier({ prompts: 60, engines: 1 }).gaps.some((g) => /只涵蓋 1 個引擎/.test(g)));
  check('永遠講明判官沒有人工抽樣驗證', t50.gaps.some((g) => /判官是 AI，沒有做過人工抽樣驗證/.test(g)));

  // 宣稱等級
  check('宣稱等級：沒有前後比較＝觀察', M.claimFor({}).level === 'observed' && M.claimFor().level === 'observed');
  check('宣稱等級：有前後比較（沒有對照組）最多到「相關」，不是「因果」',
    M.claimFor({ hasComparison: true }).level === 'associated' && /不能說是這場活動「造成」/.test(M.claimFor({ hasComparison: true }).text));
}

console.log('\n── 四、判官與詞表規則：兩套獨立判定的一致率 ──');
{
  const run = (mentioned, excerpt, extra = {}) => ({ date: '2026-09-01', engine: 'claude', mentioned, excerpt, ...extra });
  const rows = [
    run(true, '工研院在這個領域有成果'),               // 兩邊都有
    run(false, '資策會與台大都有成果'),                 // 兩邊都沒有
    run(true, '電光所推出新技術'),                      // 判官有、規則沒有（只寫簡稱）
    run(false, '工業技術研究院也有布局'),               // 規則有、判官沒有
    run(false, '成大電光所有研究'),                     // 學校的所：兩邊都沒有
    run(true, 'ITRI announced a chip'),                  // 兩邊都有
  ];
  const a = M.judgeVsRule(rows);
  check('一致率：6 筆裡 4 筆一致＝66.7%', a.n === 6 && a.both === 2 && a.neither === 2 && a.agreePct === 66.7, JSON.stringify(a));
  check('判官有、規則沒有 1 筆；規則有、判官沒有 1 筆', a.judgeOnly === 1 && a.ruleOnly === 1);
  check('★ 只出現單位簡稱、沒點名工研院的回答另外數（品牌斷鏈）＝1，「成大電光所」不算', a.shortOnly === 1, String(a.shortOnly));
  check('相關用語計數：電光所×1（簡稱）、工研院×1、ITRI×1', a.terms.some((x) => x.tier === 'short' && x.term === '電光所' && x.n === 1)
    && a.terms.some((x) => x.tier === 'name' && x.term === '工研院' && x.n === 1)
    && a.terms.some((x) => x.tier === 'name' && x.term === 'ITRI' && x.n === 1), JSON.stringify(a.terms));
  check('不一致的例子：規則有、判官沒有的排在前面（較可能是判官漏判）', a.examples[0]?.kind === 'rule_only' && a.examples.length === 2, JSON.stringify(a.examples));
  check('空資料不丟例外', M.judgeVsRule([]).agreePct === null);
}

console.log('\n── 五、綜合指數敏感度分析 ──');
{
  const mk = (date, kw, mentioned, rank, cited, specifics) => ({ date, keyword: kw, mentioned, rank, cited, specifics });
  // 單一已知回答：提及、第 1 名、沒被引、沒內容 → 各方案的分數可以手算
  const single = M.compositeSensitivity([mk('2026-09-01', 'K', true, 1, false, false)]);
  const meanOf = (id) => single.schemes.find((s) => s.id === id).mean;
  check('手算：現行 45＋20＝65', meanOf('ours') === 65);
  check('手算：等權重 25＋25＝50', meanOf('equal') === 50);
  check('手算：提及為主 70＋10＝80', meanOf('mention-heavy') === 80);
  check('手算：加重引用 30＋15＝45', meanOf('cite-heavy') === 45);
  check('手算：位置改倒數名次，第 1 名仍是 45＋20＝65', meanOf('rr') === 65);
  check('手算：只看提及率＝100', meanOf('mention-only') === 100);
  check('資料天數不足時不給相關係數，並講明是「不足 8 天」，不是算出一個數字',
    single.schemes.every((s) => s.dailyCorr === null && /不足 8 天/.test(s.dailyWhy)));
  check('議題不足 3 個時不給名次相關', single.schemes.every((s) => s.topicCorr === null && /不足 3 個議題/.test(s.topicWhy)));

  // 多天多議題：現行那套對自己的相關一定是 1；只看提及率的平均分＝提及率×100
  const runs = []; let k = 0;
  for (let i = 0; i < 12; i++) for (const kw of ['A', 'B', 'C']) for (let j = 0; j < 4; j++, k++) {
    const m = ((i * 5 + j * 3 + kw.charCodeAt(0)) % 10) < (kw === 'A' ? 7 : kw === 'B' ? 4 : 2);
    runs.push(mk(`2026-09-${String(i + 1).padStart(2, '0')}`, kw, m, m ? 1 + (j % 3) : 0, m && j % 2 === 0, m && j % 3 === 0));
  }
  const s = M.compositeSensitivity(runs);
  const ours = s.schemes[0], mo = s.schemes.find((x) => x.id === 'mention-only');
  check('現行方案對自己的走勢相關＝1、名次相關＝1', ours.dailyCorr === 1 && ours.topicCorr === 1, JSON.stringify(ours));
  check('只看提及率的平均分＝提及率（×100）', near(mo.mean, (runs.filter((r) => r.mentioned).length / runs.length) * 100, 0.06), String(mo.mean));
  check('有 6 套方案，每套都有走勢相關與議題名次相關', s.schemes.length === 6 && s.schemes.every((x) => x.dailyCorr !== null && x.topicCorr !== null), JSON.stringify(s.schemes.map((x) => [x.id, x.dailyCorr, x.topicCorr])));
  check('相關係數都在 −1～1 之間', s.schemes.every((x) => Math.abs(x.dailyCorr) <= 1 && Math.abs(x.topicCorr) <= 1));
  check('★ 不替相關係數訂「及格線」（沒有標準可援引，硬訂就是又一個自己編的數字）', !('pass' in s) && !s.schemes.some((x) => 'pass' in x || 'ok' in x));
  check('空資料不丟例外', M.compositeSensitivity([]).schemes.length === 0);

  // 曲線是水平線時，講「算不出相關」，不要講「資料不足」
  const flatRuns = []; for (let i = 0; i < 10; i++) for (const kw of ['A', 'B', 'C']) flatRuns.push(mk(`2026-09-${String(i + 1).padStart(2, '0')}`, kw, true, 1, true, true));
  const fl = M.compositeSensitivity(flatRuns).schemes[1];
  check('水平的曲線：講「曲線是水平的，算不出相關」', fl.dailyCorr === null && /水平/.test(fl.dailyWhy), JSON.stringify(fl));
}

// ═══ 六、真的 api/geo.js ＋ 假 Sheets：報告與 method 動作 ═══════════════════════
console.log('\n── 六、報告（action=report）實際吐出的標準指標與方法揭露 ──');
const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fakeRes = () => {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
};
const geo = (await import('../api/geo.js')).default;
const get = async (query, headers = { 'x-admin-password': 'pw' }) => { const r = fakeRes(); await geo({ method: 'GET', headers, query }, r); return r; };

const PROMPTS = [['p1', 'K1'], ['p2', 'K1'], ['p3', 'K1'], ['p4', 'K1'], ['p5', 'K2'], ['p6', 'K2'], ['p7', 'K2'], ['p8', 'K3'], ['p9', 'K3'], ['p10', 'K3']];
function mkRow({ off, pid, kw, eng, mentioned, rank, cited, specifics, competitors = '', excerpt = '', error = '' }) {
  const date = addDays(TODAY, off);
  if (error) return [date, `${date}T01:00`, pid, kw, kw, eng, '', '', '', '', '', '', '', '', error];
  const score = M.compositeScore({ mentioned, rank, cited, specifics });
  return [date, `${date}T01:00`, pid, kw, kw, eng, mentioned ? 'TRUE' : 'FALSE', String(rank), cited ? 'TRUE' : 'FALSE',
    cited ? 'itri.org.tw' : 'example.com', specifics ? 'TRUE' : 'FALSE', String(score), competitors, excerpt, ''];
}
const XSS = '<img src=x onerror=alert(1)>';
function seed() {
  reset();
  book.geo_settings = [['key', 'value']];
  book.geo_prompts = [['id'], ...PROMPTS.map(([id, kw]) => [id, kw, `${id} 的問句`, kw, '工研院', '', 'TRUE', '2026-08-01'])];
  book.geo_events = [['id'], ['e1', addDays(TODAY, -20), '測試活動', '記者會', 'K1', '', '', '']];
  const rows = [];
  for (let off = -34; off <= 0; off++) {
    PROMPTS.forEach(([pid, kw], pi) => ['claude', 'gemini'].forEach((eng, ei) => {
      const thr = kw === 'K1' ? (off < -20 ? 3 : 6) : kw === 'K2' ? 4 : 2; // 十分之幾的機率被提到：K1 在活動後變高
      const h = (off * 7 + pi * 3 + ei * 5 + 1000) % 10;
      const mentioned = h < thr;
      rows.push(mkRow({
        off, pid, kw, eng, mentioned, rank: mentioned ? 1 + (h % 3) : 0, cited: mentioned && h % 2 === 0, specifics: mentioned && h % 3 === 0,
        competitors: mentioned ? (h % 2 ? '資策會 MIC、台大' : '資策會') : '台大、中研院',
        excerpt: mentioned ? '工研院在這個領域有成果，資策會也有。' : '台大與中研院在這個領域有成果。',
      }));
    }));
  }
  // 特地安排的幾筆（K1、今天、perplexity）：判官有但只寫簡稱／規則有但判官沒有（含 XSS 原文）／兩種失敗
  rows.push(mkRow({ off: 0, pid: 'p1', kw: 'K1', eng: 'perplexity', mentioned: true, rank: 1, cited: false, specifics: false, competitors: '', excerpt: '電光所推出新技術。' }));
  rows.push(mkRow({ off: 0, pid: 'p2', kw: 'K1', eng: 'perplexity', mentioned: false, rank: 0, cited: false, specifics: false, competitors: '台大', excerpt: `工業技術研究院也有布局 ${XSS}` }));
  rows.push(mkRow({ off: 0, pid: 'p3', kw: 'K1', eng: 'perplexity', error: '接地未生效：回應沒有任何搜尋來源，此筆不計分（請確認搜尋額度是否開通）' }));
  rows.push(mkRow({ off: 0, pid: 'p4', kw: 'K1', eng: 'perplexity', error: 'timeout' }));
  book.geo_runs = [['date'], ...rows];
  return rows;
}
const rows = seed();
const from29 = addDays(TODAY, -29);
const k1 = rows.filter((r) => r[4] === 'K1' && r[0] >= from29 && r[14] === '');   // 報告預設 30 天
const countOthers = (r) => new Set(String(r[12]).split(/[、,，]/).map((x) => x.trim().split(' ')[0]).filter(Boolean)).size;

const rep = (await get({ action: 'report', keyword: 'K1', days: '30' })).body;
check('報告可以產生', rep.ready === true && !!rep.standard && !!rep.method, JSON.stringify(rep).slice(0, 200));
{
  const st = rep.standard, hit = k1.filter((r) => r[6] === 'TRUE');
  check('提及率：k／n 與手算一致', st.mention.n === k1.length && st.mention.k === hit.length, `${st.mention.k}/${st.mention.n} vs ${hit.length}/${k1.length}`);
  check('提及率：pct 與 k／n 一致', near(st.mention.pct, (hit.length / k1.length) * 100, 0.06));
  check('★ 提及率有 95% 區間，且包得住點估計', Array.isArray(st.mention.ci) && st.mention.ci[0] <= st.mention.pct && st.mention.pct <= st.mention.ci[1], JSON.stringify(st.mention));
  check('★ 既有的「關鍵數字」跟標準指標講的是同一個數字，並且帶著同一組區間',
    rep.stats[0].pct === Math.round(st.mention.pct) && JSON.stringify(rep.stats[0].range) === JSON.stringify(st.mention.ci), JSON.stringify(rep.stats[0]));
  check('排第一的比例也帶區間', JSON.stringify(rep.stats[1].range) === JSON.stringify(st.first.ci));
  const others = k1.reduce((a, r) => a + countOthers(r), 0);
  check('話語權占比：工研院次數與對手次數與手算一致', st.sov.self === hit.length && st.sov.others === others, `${st.sov.self}/${st.sov.others} vs ${hit.length}/${others}`);
  check('話語權占比：total＝自己＋對手，占比與之一致', st.sov.total === st.sov.self + st.sov.others && near(st.sov.pct, (st.sov.self / st.sov.total) * 100, 0.06));
  const mrr = k1.reduce((a, r) => a + (r[6] === 'TRUE' && Number(r[7]) >= 1 ? 1 / Number(r[7]) : 0), 0) / k1.length;
  check('倒數名次均值與手算一致', near(st.position.mrr, mrr, 0.006), `${st.position.mrr} vs ${mrr}`);
  check('自家網域引用率：k 與手算一致', st.citation.k === k1.filter((r) => r[8] === 'TRUE').length);
  check('樣本橫跨超過 7 天，所以每一項都有區間', [st.mention, st.first, st.sov, st.position, st.citation].every((x) => Array.isArray(x.ci)));
}
{
  const m = rep.method, dn = m.denominators;
  const all = rows.filter((r) => r[4] === 'K1' && r[0] >= from29);
  check('分母：嘗試／有效／不計分與資料一致', dn.attempted === all.length && dn.scored === k1.length && dn.failed === 2, JSON.stringify(dn));
  check('★ 不計分的 2 筆裡，沒有搜尋來源的 1 筆、其他錯誤的 1 筆，分開列出', dn.noGround === 1 && dn.otherFailed === 1, JSON.stringify(dn));
  check('測量等級：K1 只有 4 題 → 探索性，並且明說不是決策等級', m.tier.level === 'exploratory' && m.tier.decisionGrade === false && m.tier.prompts === 4 && m.tier.gaps.length >= 4, JSON.stringify(m.tier).slice(0, 200));
  check('一致率：四類加起來＝有效筆數', m.agreement.both + m.agreement.neither + m.agreement.judgeOnly + m.agreement.ruleOnly === k1.length, JSON.stringify(m.agreement).slice(0, 200));
  check('★ 特地安排的「只寫電光所」那筆被數成判官有／規則沒有，並計入「只出現簡稱」', m.agreement.judgeOnly >= 1 && m.agreement.shortOnly >= 1);
  check('★ 特地安排的「判官沒有、原文有工業技術研究院」那筆被數成規則有／判官沒有', m.agreement.ruleOnly >= 1);
  check('不一致的例子最多 4 筆，規則有的排前面', m.agreement.examples.length <= 4 && m.agreement.examples[0].kind === 'rule_only');
  check('相關用語計數裡有「工研院」與「電光所」', m.agreement.terms.some((x) => x.term === '工研院') && m.agreement.terms.some((x) => x.term === '電光所' && x.tier === 'short'));
  check('方法揭露：引擎與模型版本、判官、沒有量測的項目都有', m.engines.length === 3 && m.engines.every((e) => e.model) && !!m.judge && m.notMeasured.length >= 4 && /情感/.test(m.notMeasured.join()), JSON.stringify(m.engines));
  check('★ 方法揭露不能比程式做得到的更強：只有「工研院」被程式擋，其他機構名稱只靠提示詞，要照實講',
    /程式會擋/.test(m.queries) && /只靠提示詞/.test(m.queries) && !/題庫不含任何機構名稱/.test(m.queries), m.queries);
  check('方法揭露：講明各引擎皆開網路搜尋、沒有來源者不計分', /網路搜尋/.test(m.retrieval) && /不計分/.test(m.retrieval));
  check('方法揭露：頻率講明每天一次與每月 1 日的校準輪', /每月 1 日加跑 2 輪校準/.test(m.cadence), m.cadence);
  check('調查期間寫出來', m.window.from === from29 && m.window.to === TODAY, JSON.stringify(m.window));
  check('★ 有活動前後比較（沒有對照組）→ 宣稱等級是「相關」，不是「因果」', rep.performance?.ready === true && rep.claim.level === 'associated', JSON.stringify(rep.claim));
}
{
  const noEv = (() => { book.geo_events = [['id']]; return get({ action: 'report', keyword: 'K1', days: '30' }); })();
  const r2 = (await noEv).body;
  check('沒有活動標記 → 宣稱等級是「觀察」', r2.claim.level === 'observed' && !r2.performance, JSON.stringify(r2.claim));
  seed();
}
{
  const all = (await get({ action: 'report', days: '30' })).body;
  check('不指定議題時，測量等級看「題最多的那個議題」，並講明分散在幾個議題',
    all.method.tier.prompts === 4 && all.method.tier.topics === 3 && /每個議題最多只有 4 題（全部 10 題分散在 3 個議題）/.test(all.method.tier.gaps[0]), JSON.stringify(all.method.tier).slice(0, 220));
  const thin = (await (async () => { book.geo_runs = [['date'], ...rows.filter((r) => r[0] >= addDays(TODAY, -3) && r[4] === 'K1')]; return get({ action: 'report', keyword: 'K1', days: '30' }); })()).body;
  check('★ 只有 4 天資料時，區間為 null（不硬給），畫面才會寫「不足 7 天」', thin.standard.mention.ci === null && thin.stats[0].range === null, JSON.stringify(thin.standard.mention));
  seed();
}

console.log('\n── 七、method 動作（總覽「怎麼算」用）與權限 ──');
const meth = (await get({ action: 'method' })).body;
{
  check('回傳現行權重 45／20／20／15 與位置配分 20／14／9／5',
    meth.composite.weights.mention === 45 && meth.composite.weights.position === 20 && meth.composite.weights.owned === 20
    && meth.composite.weights.specifics === 15 && JSON.stringify(meth.composite.rankPoints) === '[20,14,9,5]', JSON.stringify(meth.composite));
  check('敏感度：6 套方案，3 個議題、35 天，所以走勢相關與名次相關都算得出來',
    meth.sensitivity.schemes.length === 6 && meth.sensitivity.topics === 3 && meth.sensitivity.days >= 8
    && meth.sensitivity.schemes.every((s) => s.dailyCorr !== null && s.topicCorr !== null), JSON.stringify(meth.sensitivity.schemes.map((s) => [s.id, s.dailyCorr, s.topicCorr])));
  check('測量等級：3 個議題、最多 4 題 → 探索性', meth.tier.level === 'exploratory' && meth.tier.prompts === 4 && meth.tier.topics === 3);
  check('也帶分母與方法揭露', meth.denominators.attempted > 0 && !!meth.architecture && !!meth.judge);
  const noAuth = await get({ action: 'method' }, {});
  check('沒有密碼 → 401', noAuth.statusCode === 401);
  book.geo_settings = [['key', 'value'], ['staff_code', 'abc']];
  const staff = await get({ action: 'method', code: 'abc' }, {});
  // loadSettings 只在行程內載一次；staff_code 這條在同仁連結的既有測試裡驗，這裡只確認 method 不在 ADMIN_ONLY
  check('method 與 report 不在只有承辦人能做的動作清單裡（同仁要能看）', staff.statusCode !== 403 && !/'method'|'report'/.test(read('api/geo.js').match(/const ADMIN_ONLY = new Set\(\[[\s\S]*?\]\);/)[0]));
  seed();
}

// ═══ 七之二、畫面：餵真的後端輸出給 public/geo.html 的渲染函式 ═══════════════════
console.log('\n── 八、畫面：報告的「方法與依據」與總覽的「怎麼算」 ──');
{
  const html = read('public/geo.html');
  const code = [...html.matchAll(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/module/.test(m[1])).map((m) => m[2]).sort((a, b) => b.length - a.length)[0];
  const els = new Map();
  const makeEl = (id) => ({
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {},
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 920, height: 300 }),
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {},
  });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, href: '', search: '', hash: '' },
    URLSearchParams, URL, history: { replaceState() {} },
    confirm: () => true, alert() {}, addEventListener() {}, removeEventListener() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    document: { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: makeEl },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  runInNewContext(code, sandbox);

  const out = sandbox.repMethodHtml(rep, '');
  check('報告「方法與依據」：折在細節裡，本身不再有章節標題', !/方法與依據<\/div>/.test(out) && /測量等級/.test(out));
  check('★ 寫出測量等級「探索性」與「不是決策等級」', /探索性/.test(out) && /不是決策等級/.test(out));
  check('寫出宣稱等級', /宣稱等級：相關（Associated）/.test(out) || /宣稱等級：觀察（Observed）/.test(out));
  check('五個分項指標都在，且標明 IAB 的名稱', ['IAB Mention Rate', 'IAB Share of Voice', 'IAB Position', 'IAB Citation Rate', 'MRR'].every((s) => out.includes(s)));
  check('★ 每個指標都帶 95% 區間（有資料天數足夠時是數字區間）', (out.match(/\d+～\d+%/g) || []).length >= 4 && /0\.\d\d～\d\.\d\d|0\.\d\d～0\.\d\d/.test(out), out.slice(0, 100));
  check('寫出樣本與分母：嘗試／有效／沒有搜尋來源', /嘗試 \d+ 次，有效 \d+ 次/.test(out) && /引擎沒有真的去搜尋/.test(out));
  check('寫出判官與規則的一致率', /兩套獨立判定的一致率：\d+(\.\d)?%/.test(out));
  check('★ 相關用語追蹤：列出 AI 怎麼稱呼工研院，並點出「只出現單位簡稱」的次數', /AI 怎麼稱呼工研院/.test(out) && /電光所 ×\d+/.test(out) && /只出現單位簡稱、沒有提到工研院/.test(out));
  check('寫出依據的文件，並講明不是 ISO 等級', /IAB《Measuring Visibility in the AI Era》/.test(out) && /AMEC《GEO Principles》/.test(out) && /不是 ISO 等級的標準/.test(out));
  check('指到專案文件 GEO-METHOD.md', /GEO-METHOD\.md/.test(out));
  check('★ AI 回答原文不能直接進 HTML（<img onerror> 被跳脫）', !out.includes('<img') && out.includes('&lt;img'), out.slice(out.indexOf('不一致'), out.indexOf('不一致') + 200));
  check('一頁報告不出現「能見度指數」（綜合指數刻意不放在對外報告裡）', !/能見度指數/.test(out));

  const thinOut = sandbox.repMethodHtml((await (async () => {
    book.geo_runs = [['date'], ...rows.filter((r) => r[0] >= addDays(TODAY, -3) && r[4] === 'K1')];
    return get({ action: 'report', keyword: 'K1', days: '30' });
  })()).body, '六、');
  check('★ 只有幾天資料時，畫面寫「不足 7 天，暫不提供」，不會自己湊一個區間', /不足 7 天，暫不提供/.test(thinOut) && !/\d+～\d+%/.test(thinOut));
  seed();

  const calc = sandbox.compositeExplainHtml(meth);
  check('總覽「怎麼算」：配分 45／20／20／15 與位置 20／14／9／5 都在', ['>45<', '>20<', '>15<', '第 1 個被提到 20', '第 2 個 14', '第 3 個 9', '第 4 個以後 5'].every((s) => calc.includes(s)));
  check('★ 開頭就講「是價值判斷，不是標準」，並引 OECD 手冊原句', /價值判斷，不是標準/.test(calc) && /weights are essentially value judgements/.test(calc) && /Step 7/.test(calc));
  check('6 套權重方案都列出來', (calc.match(/<tr><td>(現行|四項等權重|提及為主|加重自家引用|位置改用倒數名次|只看提及率)/g) || []).length === 6, String((calc.match(/<tr><td>/g) || []).length));
  check('寫出測量等級與為什麼', /測量等級：探索性/.test(calc) && /不是決策等級/.test(calc));
  check('不替相關係數下「穩／不穩」的判定', !/(很穩|不穩|通過|及格)/.test(calc));

  check('總覽：KPI 標成「（自訂）」並連到怎麼算', /近 14 天能見度指數（自訂）/.test(html) && /自訂綜合指數，非國際標準/.test(html) && /openCalc\(event\)/.test(html));
  check('總覽：「這些數字量的是什麼？」展開時才載入 method', /id="calc-card" ontoggle="if\(this\.open\) loadCalc\(\)"/.test(html) && /api\('action=method&days=60'\)/.test(html));
  check('總覽：開宗明義講「不是國際標準」並列出三份準則', /「能見度指數」是我們自訂的綜合指數，不是國際標準/.test(html)
    && /AMEC《GEO Principles》（5 月 20 日）/.test(html) && /PRCA《How to Measure GEO》（6 月）/.test(html) && /IAB《Measuring Visibility in the AI Era》（8 月）/.test(html));
  check('原本那段 AMEC 引文不再誇大成「做的正是這件事」', !/做的正是這件事/.test(html) && /綜合單一分數/.test(html));
  check('★ 簡報裡唯一用到綜合指數的那張走勢投影片：標明自訂、附權重、寫「不是國際標準」',
    /能見度指數走勢（自訂指數，近/.test(html) && /提及 45＋位置 20＋自家網域被引用 20＋有具體內容 15），<b>不是國際標準<\/b>/.test(html));
  check('簡報最後一張「方法與限制」揭露測量等級與宣稱等級（來自 API，不自己生）', /測量等級：\$\{esc\(d\.method\.tier\.label\)\}/.test(html) && /宣稱等級：\$\{esc\(d\.claim\.label\)\}/.test(html));
  check('議題排行的表頭也標「（自訂）」', /<th>能見度指數（自訂）<\/th>/.test(html));
  check('報告頁真的有呼叫「方法與依據」', /repMethodHtml\(d, ''\)/.test(html) && /想看細節（點開）/.test(html));
  check('KPI 卡片的 hint 不再只寫「滿分 100」', !/<div class="hint">滿分 100<\/div>/.test(html));
}

// ═══ 九、方法文件與程式不能各說各話 ═════════════════════════════════════════════
console.log('\n── 九、GEO-METHOD.md 與程式一致 ──');
{
  const doc = fs.existsSync(path.join(ROOT, 'GEO-METHOD.md')) ? read('GEO-METHOD.md') : '';
  check('GEO-METHOD.md 存在', doc.length > 2000);
  const w = M.COMPOSITE;
  check('★ 文件裡的權重與 COMPOSITE 一致（改權重沒改文件就會紅）',
    new RegExp(`提及\\s*${w.mention}`).test(doc) && new RegExp(`位置\\s*${w.rankPoints[0]}`).test(doc)
    && new RegExp(`引用\\s*${w.owned}`).test(doc) && new RegExp(`內容\\s*${w.specifics}`).test(doc)
    && doc.includes(w.rankPoints.join('／')), '');
  for (const url of [
    'https://amecorg.com/wp-content/uploads/2026/05/AMEC-GEO-Principles.pdf',
    'https://www.iab.com/guidelines/measuring-visibility-in-the-ai-era/',
    'https://www.prca.global/how-measure-geo',
    'https://amecorg.com/2026/07/how-to-measure-geo-applying-the-amec-principles/',
    'https://arxiv.org/abs/2311.09735',
    'https://arxiv.org/abs/2607.14035',
    'https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=20&SiteID=1&MmmID=1344111713711334002',
  ]) check(`引用來源有附原文連結：${url.replace(/^https?:\/\//, '').slice(0, 60)}`, doc.includes(url));
  check('文件講明「沒有 ISO 等級的標準」', /沒有.{0,12}ISO/.test(doc) || /ISO.{0,20}(沒有|查不到)/.test(doc));
  check('文件講明綜合指數是自訂、不是標準', /自訂/.test(doc) && /不是(國際)?標準/.test(doc));
  check('文件有「被問到時怎麼回答」', /被問到/.test(doc));
  check('文件誠實列出與準則的落差', /落差|還沒做到|尚未做到/.test(doc));
  check('文件講明測量日期：資料取得日 2026-10-01', /2026-10-01|2026 年 10 月 1 日/.test(doc));
  check('package.json 的測試鏈有這支', /test-geo-method\.mjs/.test(read('package.json')));
}

console.log(`\n${fail ? '❌' : '✅'} GEO 測量方法測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
