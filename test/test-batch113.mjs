// 批次 113：LINE 圖文選單的報名格——後台挑哪一場、同步當下畫上那一場的名稱。
// 這支測「不需要 opentype.js／pngjs／字型」的部分（排版、填色、名稱與挑選規則、依賴與文件接線）；
// 真的畫一張圖、看長相見 tools/richmenu-render-check（要裝套件，不進 npm test）。
// 同步流程與後台 API 在 test-register-line.mjs（批次 113 那兩節）。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d !== undefined ? '\n   ' + String(d).slice(0, 400) : ''))); };

const RR = await import('../lib/richmenu-render.js');
const SYNC = await import('../lib/richmenu-sync.js');
const { REPORTER_MENU_REG, REG_MENU_TILE } = await import('../lib/menu.js');

console.log('\n── 一、填色（累加面積法）──');
{
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const rev = (c) => [...c].reverse();
  let cov = RR.coverage(10, 10, [sq(2, 2, 6, 6)]);
  check('整格的方塊：內部 1、外面 0', cov[3 * 10 + 3] === 1 && cov[0] === 0 && cov[8 * 10 + 8] === 0);
  cov = RR.coverage(10, 10, [sq(2.5, 2, 6, 6)]);
  check('★ 邊緣落在像素中間 → 覆蓋率 0.5（抗鋸齒）', Math.abs(cov[3 * 10 + 2] - 0.5) < 1e-6 && cov[3 * 10 + 3] === 1, cov[3 * 10 + 2]);
  cov = RR.coverage(12, 12, [sq(1, 1, 10, 10), rev(sq(4, 4, 7, 7))]);
  check('反向的內輪廓是洞（筆畫的空心處不被填滿）', cov[5 * 12 + 5] === 0 && cov[2 * 12 + 2] === 1);
  cov = RR.coverage(12, 12, [sq(1, 1, 8, 8), sq(4, 4, 10, 10)]);
  check('★ 同向重疊的輪廓（CJK 筆畫常見）不會算成 2、不會變暗或反白', cov[5 * 12 + 5] === 1 && Math.max(...cov) <= 1);
  const tri = RR.coverage(20, 20, [[[2, 2], [18, 2], [2, 18]]]);
  const area = tri.reduce((a, b) => a + b, 0);
  check('三角形的總面積接近 128（誤差 < 1%）', Math.abs(area - 128) < 1.3, area);
  check('輪廓超出範圍不會當掉也不會寫到範圍外', (() => { try { RR.coverage(5, 5, [sq(-3, -3, 9, 9)]); return true; } catch { return false; } })());
  const flat = RR.flattenCommands([{ type: 'M', x: 0, y: 0 }, { type: 'Q', x1: 5, y1: 10, x: 10, y: 0 }, { type: 'C', x1: 8, y1: -4, x2: 2, y2: -4, x: 0, y: 0 }, { type: 'Z' }]);
  check('曲線攤平成折線、輪廓封閉', flat.length === 1 && flat[0].length > 8 && Math.min(...flat[0].map((p) => p[1])) < 0 && Math.max(...flat[0].map((p) => p[1])) > 4);
}

console.log('\n── 二、排版（標題最多兩行、放不下就縮字）──');
{
  const m = (t, size) => [...t].reduce((w, ch) => w + (/[\x00-\x7f]/.test(ch) ? 0.6 : 1) * size, 0);   // 全形 1em、半形 0.6em
  let r = RR.layoutLabel('活動報名', m);
  check('短名稱：一行、最大字級 92', r.size === 92 && r.lines.length === 1 && r.lines[0] === '活動報名');
  r = RR.layoutLabel('眺望2099產業場次報名', m);
  check('★ 超過一行就先縮字，一行放得下就不換行（不會剩一個「名」字孤零零在第二行）', r.lines.length === 1 && r.size < 92 && m(r.lines[0], r.size) <= 777, JSON.stringify(r));
  r = RR.layoutLabel('一二三四五六七八九十一二三四五六七八報名', m);
  check('★ 真的太長 → 平均切兩行，兩行寬度差不多', r.lines.length === 2 && Math.abs(m(r.lines[0], r.size) - m(r.lines[1], r.size)) <= r.size && r.lines.every((l) => m(l, r.size) <= 777) && r.lines.join('') === '一二三四五六七八九十一二三四五六七八報名', JSON.stringify(r));
  r = RR.layoutLabel('字'.repeat(60), m);
  check('離譜地長 → 截斷加「…」，仍然放得進兩行', r.lines.length === 2 && r.lines[1].endsWith('…') && r.lines.every((l) => m(l, r.size) <= 777), JSON.stringify(r));
  check('空字串不當掉', RR.layoutLabel('', m).lines.length >= 1);
  let s = RR.layoutSub('10/28 起・選場次', m);
  check('副標：放得下就用 52', s.size === 52 && s.line === '10/28 起・選場次');
  s = RR.layoutSub('很長很長很長很長很長很長很長很長很長很長很長很長很長很長', m);
  check('副標太長 → 縮字或截斷，仍在寬度內', m(s.line, s.size) <= 777 && (s.size < 52 || s.line.endsWith('…')), JSON.stringify(s));
  check('逐字換行：CJK 每個字都能斷、超過行數回 null', JSON.stringify(RR.wrapLines('一二三四', (t) => t.length, 2, 2)) === '[["一二"],["三四"]]'.replace('[["一二"],["三四"]]', '["一二","三四"]') && RR.wrapLines('一二三四五', (t) => t.length, 2, 2) === null);
}

console.log('\n── 三、名稱、挑選與格子上的字 ──');
{
  const C = (id, over = {}) => ({ id, title: id, short_name: '', sessions: [{ code: 'A1', date: '2099-10-28', md: '10/28', status: 'open' }], ...over });
  check('選單名稱帶活動代碼，讀得回來；通用格沒有代碼', SYNC.regMenuName(C('tw2027')) === `${REPORTER_MENU_REG.name}｜tw2027` && SYNC.boundCampaignId(SYNC.regMenuName(C('tw2027'))) === 'tw2027' && SYNC.regMenuName(null) === REPORTER_MENU_REG.name && SYNC.boundCampaignId(REPORTER_MENU_REG.name) === '');
  check('不是報名版的選單名稱不會被誤認', !SYNC.isRegMenuName('記者主選單') && !SYNC.isRegMenuName('職員主選單') && SYNC.isRegMenuName(REPORTER_MENU_REG.name));
  const a = C('a'), b = C('b');
  check('★ 挑選規則：綁的還開著就沿用；只有一場就是那一場；兩場以上又沒指定＝通用（null）；沒有＝null',
    SYNC.pickMenuCampaign([a, b], 'b') === b && SYNC.pickMenuCampaign([a], '') === a && SYNC.pickMenuCampaign([a], 'gone') === a && SYNC.pickMenuCampaign([a, b], '') === null && SYNC.pickMenuCampaign([a, b], 'gone') === null && SYNC.pickMenuCampaign([], 'a') === null);
  const t = SYNC.tileFor(C('x', { short_name: '眺望場次' }), Date.UTC(2026, 9, 2));
  check('格子上的字：標題＝簡稱＋報名、副標＝開始日期＋「起・選場次」', t.label === '眺望場次報名' && t.sub === '10/28 起・選場次', JSON.stringify(t));
  check('沒簡稱 → 「活動報名」；已經開始的活動副標只寫「選場次」；通用格有自己的字',
    SYNC.tileFor(C('x')).label === '活動報名' && SYNC.tileFor(C('x'), Date.UTC(2100, 0, 1)).sub === '選場次' && SYNC.tileFor(null).label === '活動報名' && SYNC.tileFor(null).sub === '選場次・1 分鐘');
  const menu = SYNC.buildRegMenu(C('x', { short_name: '眺望場次' }));
  const tile = menu.buttons.find((x) => x.text === REG_MENU_TILE.text);
  check('★ 報名版選單只換報名那一格；其餘五格、順序、送出的字都沒動；送出的字仍是「我要報名」',
    menu.buttons.length === 6 && tile.label === '眺望場次報名' && menu.buttons.filter((x) => x !== tile).every((x, i) => REPORTER_MENU_REG.buttons.filter((y) => y.text !== REG_MENU_TILE.text)[i] === x) && menu.buttons.indexOf(tile) === REPORTER_MENU_REG.buttons.findIndex((x) => x.text === REG_MENU_TILE.text));
  check('名稱與格子上的字都在 LINE 的長度限制內（動作 label ≤ 20、選單名稱 ≤ 300）', [...tile.label].length <= 20 && menu.name.length <= 300 && [...SYNC.tileFor(C('x', { short_name: '一二三四五六七八九十一二三四五六' })).label].length <= 20);
}

console.log('\n── 四、依賴、字型與文件的接線 ──');
{
  const pkg = JSON.parse(read('package.json'));
  check('★ 畫字用的兩個套件鎖死版本（跟 @vercel/blob 一樣；沒有 lockfile，不能讓它們浮動）', pkg.dependencies['opentype.js'] === '2.0.0' && pkg.dependencies.pngjs === '7.0.0' && /^\d+\.\d+\.\d+$/.test(pkg.dependencies['@vercel/blob']));
  const src = read('lib/richmenu-render.js').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check('★ 這兩個套件只在畫圖時動態載入、不在檔案最上面 import（CI 不做 npm install，載入失敗只會讓畫圖失敗、不會讓整支 Function 起不來）', !/^import .*['"](opentype\.js|pngjs)['"]/m.test(src) && /await import\('opentype\.js'\)/.test(src) && /await import\('pngjs'\)/.test(src));
  const syncSrc = read('lib/richmenu-sync.js');
  check('同步邏輯只有一份（lib/richmenu-sync.js），api/line.js 不再自己建選單', /export async function applyRichMenus/.test(syncSrc) && !/async function applyRichMenus|createRichMenu\(/.test(read('api/line.js')));
  check('字型檔放在 public/fonts/（Function 去網站抓），旁邊附授權（SIL OFL）', fs.existsSync(path.join(ROOT, 'public/fonts/NotoSansTC-Bold.ttf')) && /SIL Open Font License/.test(read('public/fonts/OFL.txt')) && /fonts\/NotoSansTC-Bold\.ttf/.test(syncSrc));
  check('字型檔是原封不動的 Noto Sans TC Bold（OFL 的保留字型名稱規則：不修改、不改名）', fs.statSync(path.join(ROOT, 'public/fonts/NotoSansTC-Bold.ttf')).size === 7104212);
  const v = JSON.parse(read('vercel.json'));
  check('api/events.js 的最長執行時間拉到 60 秒（同步選單要畫圖、建兩份選單、綁職員）；沒有多開 Function', v.functions['api/events.js'].maxDuration === 60 && Object.keys(v.functions).length === 6);
  check('後台頁有「放到 LINE 圖文選單並同步」與「換回一般選單」，並呼叫三個 reg_admin_menu_ 動作', /reg_admin_menu_status/.test(read('public/registrations.html')) && /reg_admin_menu_sync/.test(read('public/registrations.html')) && /reg_admin_menu_reset/.test(read('public/registrations.html')) && /放到 LINE 圖文選單並同步/.test(read('public/registrations.html')));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 113 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
