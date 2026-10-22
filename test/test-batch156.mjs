// 批次 156：業發處「上手門檻」與客戶專屬頁的企業版。
//   朱朱的回饋：① 設定要先做什麼，一般同仁看不出來 ② 客戶專屬頁打開還是「AI 新聞助理」、編輯內容全是新聞
//   （日期、地點、新聞稿、媒體露出），企業要看的是技術介紹、技轉合作規範、目前技術進度。
//   一、企業場的知識庫範本與發布必填（內容＋聯絡窗口，不要日期地點）；記者場的四項必填逐項不變
//   二、快速提問：企業場是技術說明那組，記者場照舊
//   三、對外字樣：網頁標題、分享預覽卡（og）、說明文字不寫「新聞」「記者會」；記者場逐字不變
//   四、編輯頁的企業場畫面（三段內容組回知識庫、原有內容不遺失）與 /b2b 首次設定引導——結構
//   五、沒有新增 Function／排程／rewrite
// 畫面（設定引導、編輯頁桌機／手機、前台）另用 Chromium 走過，見 docs/batches 批次 156。
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

register('./loader.mjs', import.meta.url);
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.ADMIN_PASSWORD = 'pw';

const F = await import('./fakes.mjs');
const { state, reset } = F;
const K = await import('../lib/kb-template.js');
const S = await import('../lib/event-status.js');
const C = await import('../lib/default-chips.js');

let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d !== undefined ? '\n   ' + String(d).slice(0, 500) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const res = () => { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => (r.headers[k] = v, r); r.status = (c) => (r.statusCode = c, r); r.json = (o) => (r.body = o, r); r.send = (b) => (r.body = b, r); r.end = (b) => (r.body = b, r); r.redirect = () => r; return r; };

// 欄位：A id B 名稱 C 色 D 知識庫 E 狀態 F 日期 G chips H 圖 I 開場 J 主辦 K 編輯碼 L 時間 M 地點 N 類型 O 聯絡 P 邀訪窗口 Q 邀請函 R 邀請函 chips
const row = (over = {}) => Object.assign(['b1', '某某精密 技術洽談', '#0F9E7A', '', 'draft', '', '', '', '', '工研院', 'code1234567890ab', '', '', '技術媒合會', '', '', '', ''], over);
const FILLED = '【技術介紹】\n先進封裝散熱模組\n\n【技轉與合作規範】\n先簽保密協定\n\n【目前技術進度】\n量產導入中';

console.log('\n── 一、範本與必填 ──');
{
  check('企業場範本只有三個小節標題（沒有說明文字：說明文字會被當成「有內容」，沒填的頁面就發布得出去）', K.BUSINESS_KB_TEMPLATE === '【技術介紹】\n\n【技轉與合作規範】\n\n【目前技術進度】\n', JSON.stringify(K.BUSINESS_KB_TEMPLATE));
  check('★ 範本本身不算有內容；填了任一段就算', !K.kbHasContent(K.BUSINESS_KB_TEMPLATE) && K.kbHasContent(FILLED) && K.kbHasContent(K.BUSINESS_KB_TEMPLATE.replace('【目前技術進度】', '【目前技術進度】\n量產中')));
  const blank = S.eventChecklist(row({ 3: K.BUSINESS_KB_TEMPLATE }), '2026-10-22');
  check('★ 企業場發布必填只有「內容」與「聯絡窗口」，不要日期、地點、新聞稿', blank.required.map((r) => r.label).join() === '內容,聯絡窗口' && blank.missingRequired.join() === '內容,聯絡窗口', blank.required.map((r) => r.label));
  check('　 內容與聯絡窗口都有 → 可以發布（沒有日期地點也行）', S.publishBlockers(row({ 3: FILLED, 14: '林業務 03-5912345' })).length === 0);
  check('　 只有內容、沒有窗口 → 擋，只缺「聯絡窗口」', S.publishBlockers(row({ 3: FILLED })).join() === '聯絡窗口');
  check('★ 記者場的四項必填一個字都沒變（日期、地點、新聞聯絡人、新聞稿）', S.publishBlockers(row({ 13: '記者會', 3: K.KB_TEMPLATE })).join() === '日期,地點,新聞聯絡人,新聞稿' && S.publishBlockers(row({ 13: '', 3: '' })).length === 4);
  check('　 類型留空的活動也是記者場那組（只有明確列出的四種才算企業場）', S.publishBlockers(row({ 13: '' })).length === 4);

  // 走真的 API：發布閘門
  reset(); state.events.push(row({ 3: K.BUSINESS_KB_TEMPLATE }));
  const events = (await import('../api/events.js')).default;
  const post = async (body) => { const r = res(); await events({ method: 'POST', headers: { 'content-type': 'application/json' }, body, query: {}, socket: {} }, r); return r; };
  const early = await post({ action: 'update_edit', id: 'b1', code: 'code1234567890ab', status: 'active' });
  check('★ 範本沒填就發布 → 擋下，缺「內容、聯絡窗口」', early.statusCode >= 400 && early.body.code === 'publish_blocked' && early.body.missing.join() === '內容,聯絡窗口', JSON.stringify(early.body));
  const ok = await post({ action: 'update_edit', id: 'b1', code: 'code1234567890ab', status: 'active', knowledge_base: FILLED, press_contact: '林業務 03-5912345' });
  check('★ 補內容與窗口就發布成功（沒有日期、地點）', ok.statusCode === 200 && ok.body.success === true && !ok.body.code, JSON.stringify([ok.body, state.events[0] && state.events[0][4]]));
  const pub = res(); await events({ method: 'GET', headers: {}, query: { action: 'get_public', id: 'b1' }, socket: {} }, pub);
  check('　 發布後客戶（不用登入）打得開，而且是企業場', pub.statusCode === 200 && pub.body.event.audience === 'business', JSON.stringify(pub.body).slice(0, 200));
}

console.log('\n── 二、快速提問 ──');
{
  const biz = C.deriveChips({ event_type: '技術媒合會', knowledge_base: FILLED, press_contact: '林業務' });
  check('★ 企業場：技術介紹／技轉合作／進度／聯絡窗口，不問「這次活動的重點」「時間和地點」', biz.join('|') === '這項技術是什麼、能解決什麼問題？|技轉與合作是怎麼進行的？|目前技術進度到哪裡？|要怎麼聯絡窗口？', biz.join('|'));
  check('　 沒寫的小節不出題（只寫技術介紹 → 只有那一題＋聯絡窗口）', C.deriveChips({ event_type: '客戶參訪', knowledge_base: '【技術介紹】\n散熱模組', press_contact: '林' }).join('|') === '這項技術是什麼、能解決什麼問題？|要怎麼聯絡窗口？');
  check('　 什麼都算不出來 → 企業場保底四題，不是記者那三題', C.effectiveChips({ event_type: '企業說明會', knowledge_base: '' }).join('|') === C.BUSINESS_GENERIC_CHIPS.join('|'));
  check('★ 記者場照舊（有內容：問重點、時間地點）', C.deriveChips({ event_type: '記者會', knowledge_base: K.KB_TEMPLATE.replace('【技術亮點 / 發表內容】', '【技術亮點 / 發表內容】\n- x'), venue: 'v', press_contact: 'p' }).includes('這次活動的重點是什麼？'));
  check('　 記者場保底仍是原本三題', C.effectiveChips({ event_type: '', knowledge_base: '' }).join('|') === C.GENERIC_CHIPS.join('|'));
  reset(); state.events.push(row({ 3: FILLED, 4: 'active', 14: '林業務 03-5912345' }));
  const events = (await import('../api/events.js')).default;
  const gp = res(); await events({ method: 'GET', headers: {}, query: { action: 'get_public', id: 'b1' }, socket: {} }, gp);
  check('★ 前台 get_public 給的就是企業場那組（網頁、預覽、LINE 用同一支 effectiveChips）', gp.statusCode === 200 && /技轉與合作是怎麼進行的/.test(gp.body.event.chips) && !/這次活動的重點/.test(gp.body.event.chips), gp.body && gp.body.event && gp.body.event.chips);
  const pv = res(); await events({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'chips_preview', knowledge_base: FILLED, event_type: '技術媒合會', press_contact: 'x' }, query: {}, socket: {} }, pv);
  check('　 編輯頁的即時預覽帶 event_type，跟前台一致', pv.statusCode === 200 && pv.body.chips.includes('目前技術進度到哪裡？'), JSON.stringify(pv.body));
}

console.log('\n── 三、對外字樣 ──');
{
  const page = (await import('../api/event-page.js')).default;
  const ssr = async (id) => { const r = res(); await page({ method: 'GET', headers: {}, query: { id } }, r); return String(r.body); };
  reset();
  state.events.push(row({ 3: FILLED, 4: 'active', 14: '林業務' }), row({ 0: 'm1', 1: '某記者會', 13: '記者會', 3: '【新聞稿全文】\n內容內容內容內容內容內容內容', 4: 'active', 5: '2027-01-01', 12: '台北', 14: 'x' }));
  const biz = await ssr('b1'), media = await ssr('m1');
  check('★ 企業場網頁標題與分享預覽卡寫「AI 技術說明助理」，不寫「新聞助理」「記者會」', /<title>某某精密 技術洽談 — AI 技術說明助理｜工研院<\/title>/.test(biz) && /og:site_name" content="工研院 AI 技術說明助理"/.test(biz) && !/新聞助理|記者會|新聞稿/.test(biz.slice(biz.indexOf('<title>'), biz.indexOf('application/ld+json'))), biz.slice(biz.indexOf('<title>'), biz.indexOf('<title>') + 700));
  check('　 說明文字（description）寫技術介紹、技轉與合作方式、進度', /可直接提問技術介紹、技轉與合作方式、目前進度/.test(biz));
  check('★ 記者場逐字不變：「— AI 新聞助理｜」「記者會 AI 新聞助理」', /<title>某記者會 — AI 新聞助理｜工研院<\/title>/.test(media) && /工研院 記者會 AI 新聞助理"/.test(media));
  const ev = read('public/event.html');
  check('前台企業場字樣：窗口叫「洽談窗口」、已結束不說「記者會已結束」、不出「新聞稿存檔」鈕', /contact: '洽談窗口'/.test(ev) && /ended: '洽談已結束'/.test(ev) && /event\.audience !== 'business' && !!document\.getElementById\('geo-article'\)/.test(ev));
  check('　 圖片區塊標題不寫「新聞照」', /技術資料圖片/.test(ev));
}

console.log('\n── 四、編輯頁與 /b2b 引導（結構；畫面另用 Chromium 走過）──');
{
  const ed = read('public/edit.html');
  check('編輯頁：活動類型是企業場四種之一才換畫面（清單跟 lib/audience.js 一字不差）', /const BIZ_TYPES = \['企業說明會', '技術媒合會', '客戶參訪', '技術交流會'\]/.test(ed) && /BUSINESS_EVENT_TYPES = \['企業說明會', '技術媒合會', '客戶參訪', '技術交流會'\]/.test(read('lib/audience.js')));
  check('★ 企業場畫面藏掉：日期、時間、地點、類型、邀訪窗口、邀請函、活動前快提、主辦、前台呈現、媒體露出、媒體訓練', (ed.match(/biz-hide/g) || []).length >= 12 && /body\.biz \.biz-hide \{ display: none !important; \}/.test(ed));
  check('　 只留：頁面標題、聯絡窗口、狀態、三段內容（Word 匯入也留著）', /id="biz-tech"/.test(ed) && /id="biz-coop"/.test(ed) && /id="biz-prog"/.test(ed) && /if \(BIZ\) bizPull\(\);/.test(ed));
  // 把 bizParse / bizCompose 抽出來實跑（跟 kbHasContent 鏡射一樣：靜態頁沒辦法 import，所以在這裡跑它的原始碼）
  const grab = (name) => ed.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
  const kbsrc = ed.match(/const KB_TEMPLATE = `[\s\S]*?`;/)[0];
  const fn = new Function('document', `${kbsrc}\nlet KB_TEMPLATE_LINES = null;\nconst KB_EMPTY_SHAPES = [/^[-・•*]+$/, /^【[^】]*】(（[^）]*）|\\([^)]*\\))?$/, /^[-・•*]?\\s*[^：:]{0,30}[：:]$/];\n${grab('kbHasContent')}\nconst BIZ_HEADS = ['技術介紹', '技轉與合作規範', '目前技術進度'];\nconst BIZ_BOX = { '技術介紹': 'biz-tech', '技轉與合作規範': 'biz-coop', '目前技術進度': 'biz-prog' };\n${grab('bizParse')}\n${grab('bizCompose')}\nreturn { bizParse, bizCompose };`);
  const boxes = {};
  const doc = { getElementById: (id) => ({ get value() { return boxes[id] || ''; } }) };
  const { bizParse, bizCompose } = fn(doc);
  const p = bizParse(FILLED + '\n\n【得獎名單】\n- 2025 研發獎');
  check('★ 三段內容拆進三個框；不在這三段裡的原有內容放「其他資料」（不因為換畫面而遺失）', p['技術介紹'] === '先進封裝散熱模組' && p['技轉與合作規範'] === '先簽保密協定' && p['目前技術進度'] === '量產導入中' && p.extra === '【得獎名單】\n- 2025 研發獎', JSON.stringify(p));
  check('　 舊的新聞範本（建過專屬頁、還沒改）當作空的，範本標題不會跑進「其他資料」', JSON.stringify(bizParse(K.KB_TEMPLATE)) === JSON.stringify({ '技術介紹': '', '技轉與合作規範': '', '目前技術進度': '', extra: '' }));
  Object.assign(boxes, { 'biz-tech': ' 散熱模組 ', 'biz-coop': '', 'biz-prog': '量產中', 'biz-extra': '【得獎名單】\n- x' });
  const kb = bizCompose();
  check('★ 組回知識庫：三個標題一定都在、順序固定、空的小節只有標題；其他資料接在最後', kb === '【技術介紹】\n散熱模組\n\n【技轉與合作規範】\n\n【目前技術進度】\n量產中\n\n【得獎名單】\n- x', JSON.stringify(kb));
  check('　 拆開再組回來內容不變（來回一次不會越存越亂）', bizCompose() === kb && JSON.stringify(bizParse(kb)) === JSON.stringify(bizParse(bizCompose())));
  check('編輯頁的必填檢查跟後端同一套：企業場只看內容與聯絡窗口', /if \(BIZ\) \{[\s\S]{0,260}label: '內容'[\s\S]{0,120}label: '聯絡窗口'/.test(ed) && /'內容': 'biz-tech'/.test(ed));
  check('狀態下拉的字講給業務聽：未發布（客戶打不開）／已發布（客戶可以打開）', /未發布（客戶打不開）/.test(ed) && /已發布（客戶可以打開）/.test(ed));

  const b2b = read('public/b2b.html');
  check('★ /b2b 首次設定引導：管理員、缺個資告知或預設承辦人時，收件匣最上面出現提醒與「一鍵開通」', /async function setupCard\(\)/.test(b2b) && /if \(!ME\.admin\) return ''/.test(b2b) && /id="setup-go">一鍵開通/.test(b2b));
  check('　 一鍵開通只補缺的：個資告知已填就不覆蓋、預設承辦人已設就不動', /if \(!String\(s\.privacy \|\| ''\)\.trim\(\)\) patch\.privacy = privacy_template/.test(b2b) && /if \(!s\.default_owner && owner\) patch\.default_owner = owner\.id/.test(b2b));
  check('　 範本要法務確認的提醒留在卡片上', /正式對外前請院內法務確認文字/.test(b2b));
  check('　 設定頁：必要 3 項在前、其他收進「進階設定」（預設收合）', /洽詢單（必要的 3 項）/.test(b2b) && /<details style="margin-top:14px"><summary[^>]*><b>進階設定<\/b>/.test(b2b) && !/<details[^>]* open/.test(b2b));
  check('　 一般同仁（業務窗口）不用設定：設定與成員分頁、設定引導只給管理員', /ME\.admin \? \[\['members'/.test(b2b) && /if \(!ME\.admin\) return ''/.test(b2b));
}

console.log('\n── 五、結構 ──');
{
  const vj = JSON.parse(read('vercel.json'));
  check('沒有新增排程（7 個）、rewrite（17 條）、Function（api/ 11 支）', vj.crons.length === 7 && vj.rewrites.length === 17 && fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length === 11);
  check('b2b 建專屬頁用企業場範本（不是新聞範本）', /BUSINESS_KB_TEMPLATE, 'draft'/.test(read('lib/b2b.js')));
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
