// 批次 124：整體檢討——使用者不便、bug、介面（網頁那一半；米亞那一半在 test-batch124-line.mjs）。
// 靜態頁沿用批次 104 的做法：把函式原始碼抽出來，在假 DOM 上真的跑（字串比對抓不到「寫了但沒接上」）；
// 後端跑真的 api/media.js、api/events.js，只有 Google Sheets 是假的（test/fakes-sheets82.mjs）。
//   一、電話連結的分機：報名頁以前把分機黏在總機後面（撥錯號），記者頁以前沒帶分機
//   二、記者網頁：電腦版置中、開場白不附複製、找不到活動的說明、大圖按 Esc 關
//   三、同仁編輯頁：標題寫出哪一場、手機按鈕一列、未發布的預覽、露出清單太大
//   四、後台：「標為已結束」、儲存列固定在底部、記者名單健檢的入口、範本依日期排
//   五、報名後台：快速切換狀態失敗時下拉選單回到原狀態
//   六、記者名單健檢：管理員密碼不進網址、確認過的不再一直出現、免重登、匯出
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const EV = read('public/event.html');
const REG = read('public/register.html');
const EDIT = read('public/edit.html');
const INDEX = read('public/index.html');
const REGS = read('public/registrations.html');
const MEDIA = read('public/media.html');

process.env.ADMIN_PASSWORD = 'pw';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function fnSource(html, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (!m) throw new Error('找不到函式 ' + name);
  const eol = html.indexOf('\n', m.index);
  const first = html.slice(m.index, eol);
  if (/\}\s*$/.test(first) && first.split('{').length === first.split('}').length) return first + '\n';
  return html.slice(m.index, html.indexOf('\n}\n', m.index) + 2);
}
const lineOf = (html, re) => { const m = re.exec(html); if (!m) throw new Error('找不到 ' + re); return m[0]; };
function load(html, names, extraSrc, vars) {
  const src = [...(extraSrc || []), ...names.map((n) => fnSource(html, n))].join('\n');
  const keys = Object.keys(vars || {});
  return new Function(...keys, `${src}\n; return { ${names.join(', ')} };`)(...keys.map((k) => vars[k]));
}
const cssBlock = (html, head) => { const i = html.indexOf(head); return i < 0 ? '' : html.slice(i, html.indexOf('\n  }\n', i) + 4); };

// ═══ 一、電話連結的分機 ═══════════════════════════════════════════════════════
console.log('\n── 一、電話連結的分機：tel:總機,分機（逗號＝接通後停一下再按分機）──');
{
  const mkEl = (tag) => ({ tag, children: [], href: '', textContent: '', append(...k) { this.children.push(...k); }, appendChild(c) { this.children.push(c); return c; } });
  const document = { createDocumentFragment: () => mkEl('frag'), createTextNode: (t) => ({ text: t }), createElement: (t) => mkEl(t) };
  const { linkify } = load(REG, ['telHref', 'linkify'], [], { document });
  const links = (t) => linkify(t).children.filter((c) => c.tag === 'a').map((a) => a.href);
  check('★ 報名頁：「03-5912345 分機 8888」→ tel:035912345,8888（以前是 tel:0359123458888，一點就撥到不存在的號碼）',
    links('王小明 03-5912345 分機 8888').join() === 'tel:035912345,8888', links('王小明 03-5912345 分機 8888'));
  check('　 「#」「轉」也是分機；沒有分機就只有總機；手機照舊；Email 照舊是 mailto',
    links('洽詢 02-2737-1234#567').join() === 'tel:0227371234,567' && links('03-5917777轉123').join() === 'tel:035917777,123'
      && links('0912-345-678').join() === 'tel:0912345678' && links('a@itri.org.tw 03-5912345').join() === 'mailto:a@itri.org.tw,tel:035912345',
    [links('洽詢 02-2737-1234#567'), links('03-5917777轉123'), links('a@itri.org.tw 03-5912345')].join(' / '));
  const label = linkify('王小明 03-5912345 分機 8888').children.find((c) => c.tag === 'a')?.textContent;
  check('　 連結文字是整段「03-5912345 分機 8888」', label === '03-5912345 分機 8888', label);

  const { contactNode } = load(EV, ['telHref', 'contactNode'], [lineOf(EV, /const PHONE_RE = .*;/)], { document });
  const a = contactNode('王小明 03-5911234 分機 8888').children.find((c) => c.tag === 'a');
  check('★ 記者頁「需要真人協助」的電話也帶分機（以前分機留在連結外，要聽完總機語音再自己按）', a && a.href === 'tel:035911234,8888' && a.textContent === '03-5911234 分機 8888', JSON.stringify(a));
  check('　 記者頁：沒有分機、手機號碼照舊', contactNode('林小美 0912-345-678').children.find((c) => c.tag === 'a')?.href === 'tel:0912345678'
    && contactNode('陳大文 02-2737-1234').children.find((c) => c.tag === 'a')?.href === 'tel:0227371234');
  check('★ 兩頁的 telHref() 逐字相同（同一套規則，不准漂開）', fnSource(EV, 'telHref') === fnSource(REG, 'telHref'));

  // 業發處後台：客戶自己填的電話（自由文字）
  const { phoneHref } = load(read('public/b2b.html'), ['phoneHref'], [], {});
  const got = ['02-2737-1234 分機 567', '+886 912-345-678', '0912345678', '(03)591-2345#88', '請寄信聯絡'].map(phoneHref);
  check('★ 業發處後台：客戶填的電話只取號碼、分機用逗號；認不出號碼就不給連結（以前原文整串塞進 tel:，「#」後面還被當成網址片段）',
    got.join(' | ') === 'tel:0227371234,567 | tel:+886912345678 | tel:0912345678 | tel:035912345,88 | ', got.join(' | '));
  check('　 頁面用的是 phoneHref()，不是原文', /<a href="\$\{esc\(phoneHref\(q\.phone\)\)\}">/.test(read('public/b2b.html')) && !/href="tel:\$\{esc\(q\.phone\)\}"/.test(read('public/b2b.html')));
}

// ═══ 二、記者網頁 ═════════════════════════════════════════════════════════════
console.log('\n── 二、記者網頁：電腦版置中、開場白不附複製、找不到活動的說明、大圖按 Esc 關 ──');
{
  const desk = cssBlock(EV, '@media (min-width: 900px)');
  check('★ 電腦版（900px 以上）把標題、媒體欄、對話、快速提問、輸入框收進置中的一欄（左右 padding，不改結構）',
    /--col:\s*860px/.test(desk) && /#header, #media-banner, #chip-dock, #input-area, #messages\s*\{[^}]*padding-left:\s*calc\(\(100% - var\(--col\)\) \/ 2\)/.test(desk)
      && /padding-right:\s*calc\(\(100% - var\(--col\)\) \/ 2\)/.test(desk), desk);
  check('　 手機那段（520px 以下）還在、而且沒有被套到置中', /@media \(max-width: 520px\)/.test(EV) && !/--col/.test(cssBlock(EV, '@media (max-width: 520px)')));

  // addMessage：開場白沒有「複製」，一般回答有
  const made = [];
  const mkEl = () => { const el = { className: '', innerHTML: '', children: [], querySelector: (s) => (s === '.copy-btn' && /copy-btn/.test(el.innerHTML) ? { addEventListener() {} } : null), scrollIntoView() {} }; made.push(el); return el; };
  const document = { createElement: mkEl, getElementById: () => ({ appendChild() {} }) };
  const f = load(EV, ['addMessage'], [], { document, renderMarkdown: (t) => t, escHtml: (t) => t, copyText() {}, ICON: { robot: '', user: '', copy: '' } });
  const greet = f.addMessage('ai', '您好！', { noCopy: true });
  const answer = f.addMessage('ai', '預計 2027 年量產。');
  check('★ 開場白不附「複製」（沒有人要引用一句招呼），一般回答照舊有', !/copy-btn/.test(greet.innerHTML) && /copy-btn/.test(answer.innerHTML));
  check('　 開場白是用 noCopy 送出的', /addMessage\('ai', greeting, \{ noCopy: true \}\)/.test(fnSource(EV, 'startConversation')));

  const init = fnSource(EV, 'init');
  check('★ 找不到活動：講清楚可能是還沒發布、已經下架或網址不完整，並請他問提供連結的承辦人（不再只說「此活動不存在」）',
    /可能還沒發布、已經下架，或網址不完整/.test(init) && /請向提供連結的承辦人確認/.test(init) && !/'此活動不存在/.test(init) && !/或已結束，請確認網址/.test(EV));
  check('　 三種情況刻意不分開講（分開講等於告訴外人這場草稿存在）', !/還沒發布'\s*:/.test(init) && (init.match(/showError\(/g) || []).length === 3);
  check('大圖（燈箱）按 Esc 就關', /e\.key === 'Escape' && document\.getElementById\('lightbox'\)\.classList\.contains\('open'\)\) closeLightbox\(\)/.test(EV));
}

// ═══ 三、同仁編輯頁 ═══════════════════════════════════════════════════════════
console.log('\n── 三、同仁編輯頁：標題寫出哪一場、手機按鈕一列、未發布的預覽、露出清單太大 ──');
{
  const els = {};
  const document = { getElementById: (id) => (els[id] ||= { textContent: '', value: '' }), title: '' };
  const f = load(EDIT, ['showEventName'], [], { document });
  f.showEventName('2026 AI 晶片前瞻論壇');
  check('★ 標題列與分頁標題寫出正在編哪一場（同時開好幾場的編輯連結時分得出來）', els['topbar-event']?.textContent === '2026 AI 晶片前瞻論壇' && document.title === '2026 AI 晶片前瞻論壇｜更新記者會內容', document.title);
  f.showEventName('   ');
  check('　 名稱是空的就不動', els['topbar-event']?.textContent === '2026 AI 晶片前瞻論壇');
  check('　 載入時就呼叫、改名稱的時候也跟著變', /showEventName\(ev\.name\)/.test(fnSource(EDIT, 'load')) && /getElementById\('input-name'\)\.addEventListener\('change', \(e\) => showEventName\(e\.target\.value\)\)/.test(EDIT));

  const toasts = [];
  const mk = (status) => new Function('toast', `let loadedStatus = ${JSON.stringify(status)}; ${fnSource(EDIT, 'previewBlocked')}; return previewBlocked;`)((m) => toasts.push(m));
  let prevented = false;
  mk('draft')({ preventDefault() { prevented = true; } });
  check('★ 未發布的場次按「預覽記者前台」：不再打開「找不到活動」，改成說明要發布後才看得到', prevented && /還沒發布/.test(toasts[0] || '') && /進行中/.test(toasts[0] || ''), toasts[0]);
  prevented = false;
  mk('active')({ preventDefault() { prevented = true; } });
  check('　 已經發布的照常打開預覽', prevented === false && toasts.length === 1);
  check('　 預覽鈕接上了這支', /getElementById\('preview-link'\)\.addEventListener\('click', previewBlocked\)/.test(EDIT));

  const loadSrc = fnSource(EDIT, 'load');
  check('連線失敗不再把英文原文（Failed to fetch）印給同仁看', !/e\.message \+ '，請檢查網路/.test(loadSrc) && /目前連不上資料/.test(loadSrc));

  const mob = cssBlock(EDIT, '@media (max-width: 600px)');
  check('★ 手機：底部三顆按鈕一列排完（次要的兩顆換短字「訓練」「預覽」、儲存佔剩下的寬度）',
    /\.action-bar \.btn-outline \.lbl-full \{ display: none; \}/.test(mob) && /\.action-bar \.btn-outline \.lbl-short \{ display: inline; \}/.test(mob) && /\.action-bar #save-btn \{ flex: 1; \}/.test(mob)
      && /<span class="lbl-full">媒體訓練<\/span><span class="lbl-short">訓練<\/span>/.test(EDIT) && /<span class="lbl-full">預覽記者前台<\/span><span class="lbl-short">預覽<\/span>/.test(EDIT), mob);
  check('　 電腦版短字藏起來', /^\.lbl-short \{ display: none; \}/m.test(EDIT));

  // 露出清單：Vercel 一個請求最多約 4.5 MB，原始檔超過約 3 MB 就被平台退回
  const { exposurePayload, bytesToBase64 } = load(EDIT, ['exposurePayload', 'bytesToBase64'], [lineOf(EDIT, /const EXPOSURE_MAX_BYTES = .*;/)], { TextDecoder, btoa: (s) => Buffer.from(s, 'latin1').toString('base64') });
  const { parseExposureFile } = await import('../lib/exposure-parse.js');
  const table = ['<html><body><table>', '<tr><td>則數</td><td>監測日期</td><td>媒體(類型)</td><td>媒體名稱</td><td>版位/時間</td><td>訊息標題</td></tr>',
    ...Array.from({ length: 30 }, (_, i) => `<tr><td>${i + 1}</td><td>2026/10/0${(i % 9) + 1}</td><td>報紙</td><td>經濟日報</td><td>A${i}</td><td>固態電池量產第${i + 1}則</td></tr>`),
    '</table></body></html>'].join('\r\n');
  const htmlPart = Buffer.from(table, 'utf8');
  // 標頭順序照 Word 存的 MHTML：Content-Location、Content-Transfer-Encoding、Content-Type
  const mhtml = (imageBytes, html = htmlPart, enc = '8bit') => Buffer.concat([
    Buffer.from(`MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="----=_NextPart_01DA0000.12345678"\r\n\r\n------=_NextPart_01DA0000.12345678\r\nContent-Location: file:///C:/x.htm\r\nContent-Transfer-Encoding: ${enc}\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n`, 'latin1'),
    html,
    Buffer.from('\r\n\r\n------=_NextPart_01DA0000.12345678\r\nContent-Location: file:///C:/x_files/image001.png\r\nContent-Transfer-Encoding: base64\r\nContent-Type: image/png\r\n\r\n', 'latin1'),
    Buffer.from('A'.repeat(imageBytes), 'latin1'),
    Buffer.from('\r\n\r\n------=_NextPart_01DA0000.12345678--\r\n', 'latin1')
  ]);
  const small = new Uint8Array(mhtml(1000));
  const pSmall = exposurePayload(small, '露出清單.doc');
  check('小檔案原封不動送出（跟以前一樣）', pSmall.trimmed === false && pSmall.bytes.length === small.length);
  const big = new Uint8Array(mhtml(4_000_000));
  let pBig = { trimmed: false, bytes: big };
  try { pBig = exposurePayload(big, '露出清單.doc'); } catch (e) { pBig.error = e.message; }
  const fullRecords = parseExposureFile(Buffer.from(big), '露出清單.doc').records;
  const trimRecords = parseExposureFile(Buffer.from(pBig.bytes), '露出清單.doc').records;
  check('★ 4 MB 的露出清單（圖片佔大部分）：只送表格那一段，小於上限', pBig.trimmed === true && pBig.bytes.length < 3_200_000, pBig.error || pBig.bytes.length);
  check('★ 只送那一段，後端解析出來的露出跟整份檔案一模一樣（後端本來就只讀第一段 text/html）',
    pBig.trimmed === true && fullRecords.length === 30 && JSON.stringify(trimRecords) === JSON.stringify(fullRecords), `${fullRecords.length} vs ${trimRecords.length}`);
  check('　 base64 轉換正確', Buffer.from(bytesToBase64(pBig.bytes), 'base64').equals(Buffer.from(pBig.bytes)));
  // Word 網頁內容的樣式區塊：「-->」落在行首。只看「行首是 --」找段落結尾的話，會在這裡就切斷、表格整個不見
  const wordHtml = Buffer.from(table.replace('<html><body>', '<html><head><style>\r\n<!--\r\n p.MsoNormal {margin:0cm;}\r\n--></style></head><body>'), 'utf8');
  const bigWord = new Uint8Array(mhtml(4_000_000, wordHtml));
  let pWord = { bytes: bigWord };
  try { pWord = exposurePayload(bigWord, '露出清單.doc'); } catch (e) { pWord.error = e.message; }
  const wordFull = parseExposureFile(Buffer.from(bigWord), '露出清單.doc').records;
  const wordTrim = parseExposureFile(Buffer.from(pWord.bytes), '露出清單.doc').records;
  check('★ 內容裡有「-->」落在行首（Word 的樣式區塊）：照樣裁到表格那一段結尾，不會切掉一半',
    pWord.trimmed === true && wordFull.length === 30 && JSON.stringify(wordTrim) === JSON.stringify(wordFull), pWord.error || `${wordFull.length} vs ${wordTrim.length}`);
  // Word 存的 MHTML 多半是 quoted-printable，而且那一行排在 Content-Type 前面——以前後端從 Content-Type 才開始讀標頭，
  // 看不到編碼，中文變成「=E5=9B=BA…」
  const qpEncode = (buf) => {
    let out = '', line = '';
    for (let k = 0; k < buf.length; k++) {
      const c = buf[k];
      if (c === 0x0d && buf[k + 1] === 0x0a) { out += line + '\r\n'; line = ''; k++; continue; }
      const t = (c >= 32 && c <= 126 && c !== 61) ? String.fromCharCode(c) : '=' + c.toString(16).toUpperCase().padStart(2, '0');
      if (line.length + t.length > 75) { out += line + '=\r\n'; line = ''; }
      line += t;
    }
    return Buffer.from(out + line, 'latin1');
  };
  const qpRecords = parseExposureFile(mhtml(1000, qpEncode(htmlPart), 'quoted-printable'), '露出清單.doc').records;
  const plainRecords = parseExposureFile(mhtml(1000), '露出清單.doc').records;
  check('★ 後端：quoted-printable 排在 Content-Type 前面（Word 的順序）也認得，解出來的中文跟沒編碼的一模一樣',
    plainRecords.length === 30 && JSON.stringify(qpRecords) === JSON.stringify(plainRecords), JSON.stringify(qpRecords[0] || null));
  const qpBig = new Uint8Array(mhtml(4_000_000, qpEncode(wordHtml), 'quoted-printable'));
  let pQp = { bytes: qpBig };
  try { pQp = exposurePayload(qpBig, '露出清單.doc'); } catch (e) { pQp.error = e.message; }
  check('　 quoted-printable 的大檔案裁過之後，後端照樣解得出同樣的 30 則',
    pQp.trimmed === true && JSON.stringify(parseExposureFile(Buffer.from(pQp.bytes), '露出清單.doc').records) === JSON.stringify(plainRecords), pQp.error || '');
  let err = '';
  try { exposurePayload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(3_300_000)]), '露出報告.pptx'); } catch (e) { err = e.message; }
  check('★ 太大的 .pptx：先擋下來、講清楚改上傳「露出清單.doc」（以前送出去被平台退回，畫面只有「Unexpected token…」）', /簡報檔/.test(err) && /露出清單\.doc/.test(err) && /3 MB/.test(err), err);
  const up = fnSource(EDIT, 'uploadExposure');
  check('　 平台回的不是 JSON（413）時給中文說明，不印解析錯誤', /res\.json\(\)\.catch\(\(\) => \(\{/.test(up) && /res\.status === 413/.test(up) && /exposurePayload\(/.test(up));
}

// ═══ 四、後台 ═════════════════════════════════════════════════════════════════
console.log('\n── 四、後台：「標為已結束」、儲存列固定在底部、記者名單健檢的入口、範本依日期排 ──');
const WEEKDAYS_SRC = lineOf(INDEX, /const WEEKDAYS = \[[^\]]*\];/);
const sec = load(INDEX, ['eventDateIso', 'daysBetween', 'shortDateLabel', 'dateMetaHtml'], [WEEKDAYS_SRC], {});
const escHtml = load(INDEX, ['escHtml'], [], {}).escHtml;
{
  const cardFns = load(INDEX, ['eventCardHtml', 'eventStatusMeta', 'moreMenuItems', 'isBusinessCard'], [], {
    ...sec, escHtml, state: { line: { basic_id: '@abc' } }, window: {}, todayTaipeiIso: () => '2026-10-11'
  });
  const T = '2026-10-11';
  const card = (o) => cardFns.eventCardHtml({ id: 'x1', name: '固態電池發表會', status: 'active', event_date: '2026-10-08', venue: '中興院區', missing: [], has_kb: true, ...o }, { count: 3, today: T });
  const past = card({});
  check('★ 日期已過、還是「進行中」：卡片寫出來，最顯眼的按鈕是「標為已結束」', /活動日期已過，狀態還是「進行中」/.test(past) && /action-btn primary"[^>]*onclick="markEnded\('x1'\)"[^>]*>.*?標為已結束/s.test(past), past);
  check('　 記者場：講清楚按了之後新聞稿會開放給搜尋引擎與 AI 收錄', /搜尋引擎與 AI 收錄/.test(past));
  check('　 企業場：不提收錄（企業場本來就不會被收錄）', !/收錄/.test(card({ event_type: '企業說明會' })) && /標為已結束/.test(card({ event_type: '企業說明會' })));
  check('　 還沒到的進行中活動：沒有這個提醒，照舊是「編輯」最顯眼', !/標為已結束|日期已過/.test(card({ event_date: '2026-10-20' })) && /action-btn primary"[^>]*onclick="showEditModal/.test(card({ event_date: '2026-10-20' })));
  check('　 已結束、草稿、沒日期的：沒有這個提醒', ['ended', 'draft'].every((s) => !/日期已過/.test(card({ status: s }))) && !/日期已過/.test(card({ event_date: '' })));
  check('　 還缺必填的舊活動：先講缺什麼（「去補」優先）', /必填還缺：地點/.test(card({ missing: ['地點'] })) && !/日期已過/.test(card({ missing: ['地點'] })));
  check('　 按鈕數一樣不超過 5 個', (past.match(/class="action-btn[^"]*"/g) || []).length <= 5);
  const menu = (status) => cardFns.moreMenuItems({ id: 'x1', status }).map((i) => i.label || '|');
  check('「更多」裡：進行中的活動都可以「標為已結束」（當天辦完當天就能按）', menu('active').includes('標為已結束') && !menu('ended').includes('標為已結束') && !menu('draft').includes('標為已結束'));
  const pastMenu = cardFns.moreMenuItems({ id: 'x1', status: 'active', event_date: '2026-10-08' }).map((i) => i.label || '|');
  const futureMenu = cardFns.moreMenuItems({ id: 'x1', status: 'active', event_date: '2026-10-20' }).map((i) => i.label || '|');
  check('　 已過期的卡片把 LINE QR 讓給了「標為已結束」，LINE QR 收進「更多」（還沒到的照舊在卡片上，不重複）',
    pastMenu.includes('LINE QR') && !futureMenu.includes('LINE QR') && !/openLineQr/.test(past) && /openLineQr/.test(card({ event_date: '2026-10-20' })), pastMenu.join() + ' / ' + futureMenu.join());

  // markEnded：先講後果、確認了才送；用的是一般的 update（從進行中改成已結束不經過發布閘門）
  const calls = [], toasts = [];
  let answer = false;
  const mkMark = () => load(INDEX, ['markEnded', 'isBusinessCard'], [], {
    state: { password: 'pw', events: [{ id: 'e1', name: '固態電池發表會', event_type: '記者會' }] },
    confirm: (m) => { calls.push(['confirm', m]); return answer; },
    authedFetch: async (url, opts) => { calls.push(['fetch', JSON.parse(opts.body)]); return { json: async () => ({ success: true }) }; },
    toast: (m) => toasts.push(m), loadEvents: async () => {}, flashCard() {}, showPublishBlocked() {}
  }).markEnded;
  await mkMark()('e1');
  check('★ 「標為已結束」先說清楚後果（新聞稿全文開放收錄、收不回來），按取消就什麼都不送', calls.length === 1 && /無法完全收回/.test(calls[0][1]) && /還在禁發/.test(calls[0][1]), JSON.stringify(calls));
  answer = true; calls.length = 0;
  await mkMark()('e1');
  check('　 確認了才送 update status=ended', calls.some((c) => c[0] === 'fetch' && c[1].action === 'update' && c[1].status === 'ended' && c[1].id === 'e1') && /已標為已結束/.test(toasts.join()), JSON.stringify(calls));

  // 後端：進行中 → 已結束 不經過發布閘門（就算是舊活動還缺欄位）
  const { book, reset } = await import('./fakes-sheets82.mjs');
  reset();
  book.events = [['id'], ['old1', '舊活動', '#0F9E7A', '知識庫內容', 'active', '2026-10-01', '', '', '', '工研院', 'code', '', '', '', '', '', '', '']];
  const events = (await import('../api/events.js')).default;
  let code = 0, body;
  const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { body = o; return res; }, end() { return res; } };
  await events({ method: 'POST', headers: { 'x-admin-password': 'pw' }, query: {}, body: { action: 'update', id: 'old1', status: 'ended' } }, res);
  check('　 後端：進行中改成已結束直接過（發布閘門只擋「從未發布變公開」）', code === 200 && book.events[1][4] === 'ended', JSON.stringify(body));
  check('　 後端：只改狀態，名稱、知識庫、日期、編輯碼一個都沒動（請求裡只帶 id 與 status）',
    book.events[1][1] === '舊活動' && book.events[1][3] === '知識庫內容' && book.events[1][5] === '2026-10-01' && book.events[1][10] === 'code', JSON.stringify(book.events[1]));

  // 儲存列固定在視窗底部
  check('★ 新增／編輯活動：「取消／儲存」固定在視窗底部，不用捲過整份知識庫才按得到',
    /#event-modal \.modal-actions \{\s*position: sticky; bottom: 0;[^}]*background: #fff;/.test(INDEX) && /#event-modal \.modal \{ padding-bottom: 0; \}/.test(INDEX));

  // 記者名單健檢的入口
  check('★ 側邊欄有「記者名單健檢」（以前後台找不到入口，只能自己記網址）', /<a class="nav-item nav-secondary" href="\/media\.html"[^>]*>\s*<i class="ti ti-users"><\/i> 記者名單健檢/.test(INDEX));
  check('　 手機底部選單的「更多」也有', /label: '記者名單健檢', run: \(\) => \{ location\.href = '\/media\.html'; \}/.test(fnSource(INDEX, 'openNavMore')));

  // 範本下拉依活動日期排
  const opts = [];
  const dom = { getElementById: () => ({ set innerHTML(v) { opts.push(...[...v.matchAll(/value="([^"]+)"/g)].map((m) => m[1])); } }) };
  load(INDEX, ['populateCopyTemplate', 'eventDateIso'], [], {
    document: dom, escHtml,
    state: { events: [{ id: 'stamp', created_at: '2026/6/18 下午11:06:04' }, { id: 'oct5', event_date: '2026-10-05' }, { id: 'none', event_date: '' }, { id: 'sep30', event_date: '2026/9/30' }, { id: 'nov1', event_date: '2026-11-01' }] }
  }).populateCopyTemplate();
  check('★ 「以既有活動為範本」依活動日期新到舊排、沒日期的在最後（以前拿兩種格式的字串直接比）', opts.join() === 'nov1,oct5,sep30,stamp,none', opts.join());
}

// ═══ 五、報名後台 ═════════════════════════════════════════════════════════════
console.log('\n── 五、報名後台：快速切換狀態失敗，下拉選單回到原狀態 ──');
{
  const log = [];
  const run = (fails) => new Function('DATA', 'CUR', 'callJson', 'toast', 'loadCamp', 'renderCamp', 'alert', 'relock', 'STATUS_LABEL',
    `${fnSource(REGS, 'quickStatus')}; return quickStatus;`)(
    { campaigns: [{ id: 'biz', status: 'draft' }] }, 'biz',
    async () => { if (fails) { const e = new Error(fails === 401 ? '密碼錯誤' : '企業場要先填個資告知才能開放'); e.status = fails === 401 ? 401 : 400; throw e; } return {}; },
    (m) => log.push('toast:' + m), async () => log.push('load'), () => log.push('render'), (m) => log.push('alert:' + m), () => log.push('relock'), { open: '開放報名' });
  await run(400)('open');
  check('★ 存不成功（企業場沒填個資告知就改開放）：跳出原因後重畫，下拉選單回到原本的「草稿」', log.join() === 'alert:企業場要先填個資告知才能開放,render', log.join());
  log.length = 0;
  await run(401)('open');
  check('　 登入失效：回到密碼畫面', log.join() === 'relock', log.join());
  log.length = 0;
  await run(0)('open');
  check('　 存成功照舊：提示、重讀、重畫', log.join() === 'toast:已改成「開放報名」,load,render', log.join());
}

// ═══ 六、記者名單健檢 ═════════════════════════════════════════════════════════
console.log('\n── 六、記者名單健檢：管理員密碼不進網址、確認過的不再一直出現、免重登、匯出 ──');
{
  // 入口：先當管理員密碼（header），不對才當連結代碼（網址）
  const fetches = [];
  const mkUnlock = (adminOk) => {
    const els = {};
    const document = { getElementById: (id) => (els[id] ||= { value: id === 'gate-input' ? 'Secret-Pw1' : '', textContent: '', style: {} }) };
    const store = {};
    const sessionStorage = { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] || null, removeItem: (k) => { delete store[k]; } };
    const fetch = async (url, opts = {}) => {
      fetches.push({ url, headers: opts.headers || {}, body: opts.body });
      const isAdmin = (opts.headers || {})['X-Admin-Password'] === 'Secret-Pw1';
      return { json: async () => (isAdmin && adminOk ? { totalActive: 1, needsReview: [] } : { error: '這條連結已失效，請向承辦人索取新的' }) };
    };
    const api = new Function('document', 'fetch', 'sessionStorage', 'render', `let S = { pwd:'', code:'', role:'staff' }; ${fnSource(MEDIA, 'call')} ${fnSource(MEDIA, 'unlock')} ${fnSource(MEDIA, 'enterApp')} ${fnSource(MEDIA, 'loadMailRequests')}; return { unlock, S: () => S };`)(document, fetch, sessionStorage, () => {});
    return { api, els, store };
  };
  let t = mkUnlock(true);
  await t.api.unlock();
  check('★ 管理員在入口輸入密碼：第一個請求就用 header 送，網址上沒有密碼（以前先被當成連結代碼放進 ?code=，留在伺服器紀錄）',
    // 批次 145：管理員進場後會再讀一次「待核准的 mail 修改」（也走 header）——守的是每一個請求的網址都沒有密碼
    fetches.length >= 1 && fetches.every((f) => !f.url.includes('Secret-Pw1')) && fetches[0].headers['X-Admin-Password'] === 'Secret-Pw1', JSON.stringify(fetches));
  check('　 進得去、記住登入（之後同分頁免重登）、出現管理區與「回後台」', t.api.S().role === 'admin' && t.store.itri_pwd === 'Secret-Pw1' && t.els['admin-panel'].style.display === 'block' && t.els['back-admin'].style.display === 'inline-block');
  fetches.length = 0;
  t = mkUnlock(false);
  await t.api.unlock();
  check('　 密碼不對才當同仁的連結代碼試（連結代碼本來就是放網址分享的）', fetches.length === 2 && fetches[1].url.includes('code=Secret-Pw1') && !fetches[1].headers['X-Admin-Password'], JSON.stringify(fetches.map((x) => x.url)));
  check('　 兩種都不對：講清楚該輸入什麼（不是只丟「連結已失效」給管理員看）', /密碼或連結代碼不正確/.test(t.els['gate-err'].textContent), t.els['gate-err'].textContent);
  check('入口輸入框是密碼型（不在畫面上明碼顯示）', /<input id="gate-input" type="password"/.test(MEDIA));
  check('★ 從後台同一個分頁點進來免再輸入密碼（跟成效報告、活動報名一樣）', /sessionStorage\.getItem\('itri_pwd'\)/.test(MEDIA) && /S\.role='admin'; S\.pwd=saved;/.test(MEDIA));
  check('管理員有「匯出 CSV」（後端早就有 export，畫面上一直沒有按鈕），用 header 帶密碼下載', /onclick="doExport\(\)"/.test(MEDIA) && /fetch\('\/api\/media\?action=export', \{ headers: \{ 'X-Admin-Password': S\.pwd \} \}\)/.test(fnSource(MEDIA, 'doExport')));

  // 還沒有路線的人，要先點路線才能確認
  const toasts = [], posts = [];
  const confirmRec = new Function('recBeats', 'pendingBeat', 'toast', 'call', 'document', 'setTimeout', `${fnSource(MEDIA, 'confirmRec')}; return confirmRec;`)(
    { r1: '', r2: '半導體' }, {}, (m) => toasts.push(m), async (a, body) => { posts.push(body); return {}; },
    { getElementById: () => ({ classList: { add() {} }, remove() {} }) }, () => {});
  await confirmRec('r1');
  check('★ 沒有路線的人按「資料正確」：先請他點路線，不送出（不然路線還是空的，下次又排在最前面）', posts.length === 0 && /請先點他現在跑的路線/.test(toasts[0] || ''), toasts[0]);
  await confirmRec('r2');
  check('　 已經有路線的照常確認', posts.length === 1 && posts[0].id === 'r2');

  // 後端：一年內確認過的不再列進待確認
  const { book, reset } = await import('./fakes-sheets82.mjs');
  reset();
  const media = (await import('../api/media.js')).default;
  const call = async (method, q, body = {}, headers = {}) => {
    let code = 200, out;
    const res = { setHeader() {}, status(c) { code = c; return res; }, json(o) { out = o; return res; }, send(o) { out = o; return res; }, end() { return res; } };
    await media({ method, query: q, headers, body }, res);
    return { code, out };
  };
  const A = { 'x-admin-password': 'pw' };
  const csv = ['id,name,outlet,beat,invited_count,last_invited', 'R1,吳雅婷,三立新聞,半導體,86,2024-01-10', 'R2,林小美,聯合報,,40,2026-09-01', 'R3,張大同,中央社,生醫,10,2026-09-20'].join('\n');
  let r = await call('POST', {}, { action: 'seed', csv }, A);
  check('（準備）匯入三位記者', r.code === 200 && r.out.created === 3, JSON.stringify(r.out));
  r = await call('GET', { action: 'list' }, {}, A);
  const ids = (x) => (x.out.needsReview || []).map((n) => n.id).sort().join();
  check('（準備）太久沒受邀的 R1、沒有路線的 R2 在待確認裡；R3 不在', ids(r) === 'R1,R2', ids(r));
  await call('POST', {}, { action: 'update', id: 'R1' }, A);
  await call('POST', {}, { action: 'update', id: 'R2' }, A);
  r = await call('GET', { action: 'list' }, {}, A);
  check('★ 按過「還在跑，資料正確」的 R1 不再出現（以前只淡出畫面，下次打開又排第一個，確認等於白做）', !ids(r).includes('R1'), ids(r));
  check('　 沒點路線就確認的 R2 還在（路線還是空的，資料不算完整）', ids(r).includes('R2'));
  await call('POST', {}, { action: 'update', id: 'R2', beat: '財經／產業' }, A);
  r = await call('GET', { action: 'list' }, {}, A);
  check('　 補了路線之後 R2 也離開待確認', ids(r) === '', ids(r));
  // 一年前確認過的又會回來
  const row = book.media_roster.findIndex((x) => x[0] === 'R1');
  book.media_roster[row][12] = '2024/09/01 10:00:00';
  r = await call('GET', { action: 'list' }, {}, A);
  check('　 超過一年沒人確認、也一直沒受邀的，又會回到待確認（不是確認一次就永遠消失）', ids(r) === 'R1', ids(r));
}

// ═══ 七、搜尋引擎 ═════════════════════════════════════════════════════════════
console.log('\n── 七、後台與帶權杖的頁面不讓搜尋引擎收錄 ──');
{
  const pages = ['edit', 'geo', 'index', 'media', 'report', 'training', 'registrations', 'register', 'b2b', 'inquiry'];
  const missing = pages.filter((p) => !/<meta name="robots" content="noindex,nofollow">/.test(read(`public/${p}.html`)));
  check('★ 後台與網址帶編輯碼／共用連結碼的頁面都掛 noindex（連結萬一被貼到公開的地方，也不會變成搜尋結果）', missing.length === 0, missing.join(', '));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 124（整體檢討・網頁）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
