// 批次 181：記者端「近期活動」改成圖像卡。
//   一、純函式 buildCalendarFlex()：每場一列、日期方塊、整列可點（只有有資料的場次）、沒有場次回 null
//   二、LINE 流程：1 對 1 送圖像卡＋只留五顆固定入口；群組維持文字（要引用原問題）；Flex 送不出去退回文字；「回首頁」開場白不丟
//   三、記者端其他圖像卡：技術與洽案、近期新聞、產業趨勢、邀訪窗口；每張都帶「📋 純文字（可複製）」，點了回原本的純文字版面
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

const { buildCalendarFlex, buildCalendarCards } = await import('../lib/router.js');

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
async function dm(uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res);
  return sent.slice();
}
async function group(gid, uid, text) {
  sent.length = 0;
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: `@米亞 ${text}`, mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } };
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const jsonOf = (o) => JSON.stringify(o);

// ═══ 一、純函式 ═══════════════════════════════════════════════════════════════
console.log('── 一、純函式 ──');
{
  // events 表欄位：A id, B name, C color, D knowledge_base, E status, F 日期（A～O，見 lib/router.js buildAllCalendarCards）
  const row = (id, name, date, kb) => [id, name, '#0F9E7A', kb, 'active', date, '', '', '', '工研院', '', '', '', '', ''];
  const KB = '【新聞稿】這是一段足夠長的新聞稿內容，用來讓知識庫算「有資料」。';
  const cards = buildCalendarCards([
    row('a', '五天後有資料的發表會', isoOffset(5), KB),
    row('b', '十天後只有基本資料', isoOffset(10), ''),
    row('c', '三天前辦過的記者會', isoOffset(-3), KB),
    row('d', '還沒定日期的論壇', '', KB)
  ]);
  const card = buildCalendarFlex(cards, { notes: ['（備註一）', '（備註二）'] });
  const js = jsonOf(card);
  check('★ 每場一列：即將舉行、最近辦過、日期未定的都在', card && ['五天後有資料的發表會', '十天後只有基本資料', '三天前辦過的記者會', '還沒定日期的論壇'].every((n) => js.includes(n)), js.slice(0, 200));
  check('　 有資料的整列可點（點了＝打活動名稱）；只有基本資料的不能點、寫「僅基本資料」', js.includes('"action":{"type":"message","label":"問這一場","text":"五天後有資料的發表會"}') && !js.includes('"text":"十天後只有基本資料"}') && /僅基本資料/.test(js), js.slice(0, 200));
  check('　 日期方塊：月份與日、星期與倒數；沒日期寫「未定」', /還有 5 天/.test(js) && /週[日一二三四五六]/.test(js) && /"text":"未定"/.test(js));
  check('　 備註一則一行放在底部；altText 寫得出場數（通知與聊天列表只看得到它）', /（備註一）/.test(js) && /（備註二）/.test(js) && /近期活動：即將舉行 \d+ 場/.test(card.altText), card?.altText);
  check('★ 沒有任何場次 → null（呼叫端照舊發那句文字）', buildCalendarFlex([]) === null && buildCalendarFlex(null) === null);
  check('　 只有過了 30 天的舊場次 → 也是 null', buildCalendarFlex(buildCalendarCards([row('z', '兩個月前', isoOffset(-60), KB)])) === null);
}

// ═══ 二、LINE 流程 ═════════════════════════════════════════════════════════════
console.log('\n── 二、LINE 流程 ──');
reset(); await fresh();
{
  state.rawCalendarFlex = true;
  let out = await dm('U_r', '最近有哪些活動');
  const flex = out.find((o) => o.kind === 'flex');
  const msg = flex?.messages?.[flex.messages.length - 1];
  check('★ 1 對 1 問「最近有哪些活動」→ 圖像卡（不是文字清單）', !!flex && msg?.type === 'flex' && /近期活動/.test(msg.altText) && !out.some((o) => o.kind === 'text' && /【近期活動】/.test(o.text)), jsonOf(out).slice(0, 300));
  const chips = (msg?.quickReply?.items || []).map((i) => i.action.text);
  check('　 快速回覆只剩五顆固定入口（活動改由卡上每一列點）', JSON.stringify(chips) === JSON.stringify(['產業趨勢分析', '問技術與洽案', '媒體邀訪需求', '找真人', '使用說明']), JSON.stringify(chips));
  check('　 卡上有點得到的活動列、底部提醒媒體邀訪需求窗口', /"label":"問這一場"/.test(jsonOf(msg)) && /媒體邀訪需求/.test(jsonOf(msg)), jsonOf(msg).slice(0, 200));

  out = await dm('U_r', '回首頁');
  const f2 = out.find((o) => o.kind === 'flex');
  check('★ 「回首頁」：開場白（文字）＋圖像卡一次送出，開場白不能掉', !!f2 && f2.messages[0]?.type === 'text' && /已經回到首頁/.test(f2.messages[0].text) && f2.messages.at(-1)?.type === 'flex', jsonOf(out).slice(0, 300));

  state.flexFails = true;
  out = await dm('U_r', '最近有哪些活動');
  state.flexFails = false;
  const t = out.find((o) => o.kind === 'text');
  check('★ Flex 送不出去 → 退回純文字清單＋活動名稱按鈕（跟批次 181 之前一樣）', !out.some((o) => o.kind === 'flex') && /【近期活動】/.test(t?.text || '') && (t?.quickReply || []).some((c) => /智慧醫療解決方案記者會/.test(typeof c === 'object' ? c.text : c)), jsonOf(out).slice(0, 300));

  out = await group('C_g', 'U_r', '最近有哪些活動');
  check('★ 群組維持文字（回覆要引用原問題，Flex 的送法不帶引用）', !out.some((o) => o.kind === 'flex') && out.some((o) => o.kind === 'text' && /【近期活動】/.test(o.text)), jsonOf(out).slice(0, 300));
  state.rawCalendarFlex = false;
}

// ═══ 三、其他圖像卡 ═════════════════════════════════════════════════════════════
console.log('\n── 三、技術與洽案、近期新聞、產業趨勢、邀訪窗口 ──');
{
  const tech = await import('../lib/itri-tech.js');
  const news = await import('../lib/itri-news.js');
  const trends = await import('../lib/industry-trends.js');
  const cards = await import('../lib/reporter-cards.js');
  const nav = (m) => (m?.quickReply?.items || []).map((i) => ({ label: i.action.label, text: i.action.text }));
  const flexOf = (out) => out.find((o) => o.kind === 'flex');
  const cardJson = (out) => JSON.stringify(flexOf(out)?.messages || []);
  const lastMsg = (out) => { const f = flexOf(out); return f?.messages?.[f.messages.length - 1]; };

  check('★ 句型：結尾的「純文字」解析得出來；沒有時 plain 是 false，翻頁與純文字可以同時帶',
    tech.parseTechPick('技術領域：綠能與環境 純文字').plain === true && tech.parseTechPick('技術領域：綠能與環境 純文字').domain?.name === '綠能與環境'
    && tech.parseTechPick('技術領域：綠能與環境').plain === false && tech.parseTechPick('技術領域：通訊與光電 第2頁 純文字').page === 2
    && news.parseNewsPick('新聞關鍵字：半導體 純文字').keyword === '半導體' && news.parseNewsPick('新聞關鍵字：半導體 純文字').plain === true
    && news.parseNewsPick('近期工研院新聞 純文字')?.plain === true && news.parseNewsPick('近期工研院新聞 第2頁 純文字')?.page === 2
    && trends.parseTrendPick('趨勢關鍵字：能源 純文字').keyword === '能源' && trends.parseTrendPick('趨勢關鍵字：能源 純文字').plain === true
    && trends.parseTrendPick('趨勢關鍵字：能源').plain === false);
  check('　 組出來的句型能被自己解析回去', tech.parseTechPick(tech.techPickText({ keyword: '電池', page: 2, plain: true })).plain === true
    && news.parseNewsPick(news.newsPickText({ keyword: '電池', page: 3, plain: true })).page === 3 && trends.parseTrendPick(trends.trendPickText('AI', { plain: true })).plain === true);
  check('★ 電話：純數字格式才有「撥打」；寫著中文「分機」的不給按鈕（拿掉中文再撥會撥錯號碼）',
    cards.telUri('02-2345-6789') === 'tel:0223456789' && cards.telUri('+886 2 2345 6789') === 'tel:+88622345 6789'.replace(' ', '') && cards.telUri('03-5916800 分機 123') === '' && cards.telUri('') === '' && cards.telUri('abc') === '',
    [cards.telUri('02-2345-6789'), cards.telUri('+886 2 2345 6789'), cards.telUri('03-5916800 分機 123')].join('|'));
  check('　 網址不是 http／https 的不放按鈕（不合格的 uri 會讓整則被 LINE 退掉）', cards.uriOk('https://x.tw/a') && !cards.uriOk('javascript:alert(1)') && !cards.uriOk('') && !cards.uriOk('mailto:a@b.c'));

  state.rawCalendarFlex = true; state.reporterCards = true;
  tech.__clearTechCache();
  let out = await dm('U_t', '技術領域：綠能與環境');
  let m = lastMsg(out);
  check('★ 技術：頭一行（共幾項）＋圖像卡（一項一張）＋後面的提醒，一次送出', flexOf(out)?.messages?.length === 3 && flexOf(out).messages[0].type === 'text' && /共 \d+ 項/.test(flexOf(out).messages[0].text) && flexOf(out).messages[1].type === 'flex' && flexOf(out).messages[1].contents?.type === 'carousel', cardJson(out).slice(0, 300));
  check('　 卡上有技術名稱、聯絡人、信箱，「官網技術頁」是按鈕', /藻類回收技術/.test(cardJson(out)) && /劉晏嘉/.test(cardJson(out)) && /yanjia@itri\.org\.tw/.test(cardJson(out)) && /"label":"🔗 官網技術頁","uri":"https:\/\/[^"]+"/.test(cardJson(out)), cardJson(out).slice(0, 400));
  check('★ 第一顆快速回覆是「📋 純文字（可複製）」，送出的是同一個領域加「純文字」；沒有被擠掉的「找真人」', nav(m)[0]?.label === cards.PLAIN_CHIP_LABEL && nav(m)[0]?.text === '技術領域：綠能與環境 純文字' && nav(m).some((c) => c.text === '找真人') && nav(m).length <= 13, JSON.stringify(nav(m)));
  out = await dm('U_t', '技術領域：綠能與環境 純文字');
  check('★ 點「純文字」→ 原本的文字版面（信箱一行一個、可以長按複製），不再是圖像卡，也沒有「純文字」那顆', !flexOf(out) && /✉️ yanjia@itri\.org\.tw/.test(allTextOf(out)) && !(out.at(-1)?.quickReply || []).some((c) => /純文字/.test(typeof c === 'object' ? c.label : c)), JSON.stringify(out).slice(0, 300));
  out = await dm('U_t', '技術領域：通訊與光電');
  m = lastMsg(out);
  check('　 有下一頁時「純文字」第一顆、「更多技術」緊接著（句型是下一頁，沒有帶純文字旗標）', nav(m)[0]?.label === cards.PLAIN_CHIP_LABEL && nav(m)[1]?.label === '➡️ 更多技術' && nav(m)[1].text === '技術領域：通訊與光電 第2頁', JSON.stringify(nav(m).slice(0, 3)));
  out = await dm('U_t', '技術領域：通訊與光電 第2頁 純文字');
  check('　 純文字模式翻頁：「更多技術」的句型也帶著「純文字」，不會翻一頁就變回圖像卡', !flexOf(out) && (out.at(-1)?.quickReply || []).some((c) => (typeof c === 'object' ? c.text : c) === '技術領域：通訊與光電 第3頁 純文字'), JSON.stringify((out.at(-1)?.quickReply || []).slice(0, 2)));

  out = await dm('U_t', '近期工研院新聞');
  m = lastMsg(out);
  check('★ 近期新聞：圖像卡（一則一張，「閱讀全文」是按鈕）、提示那段照樣接在後面、快速回覆第一顆是純文字', !!flexOf(out) && flexOf(out).messages.some((x) => x.type === 'flex' && x.contents?.type === 'carousel') && /"label":"🔗 閱讀全文"/.test(cardJson(out)) && /想找特定主題的新聞/.test(cardJson(out)) && nav(m)[0]?.text === '近期工研院新聞 純文字', cardJson(out).slice(0, 300));
  out = await dm('U_t', '近期工研院新聞 純文字');
  check('　 「純文字」→ 原本的新聞文字（編號、日期、短網址）', !flexOf(out) && /📰 近期工研院新聞/.test(allTextOf(out)) && /🔗 /.test(allTextOf(out)), allTextOf(out).slice(0, 200));
  out = await dm('U_t', '新聞關鍵字：半導體');
  check('　 關鍵字新聞也是圖像卡，純文字句型帶著關鍵字', !!flexOf(out) && nav(lastMsg(out))[0]?.text === '新聞關鍵字：半導體 純文字', JSON.stringify(nav(lastMsg(out)).slice(0, 2)));

  out = await dm('U_t', '趨勢關鍵字：半導體');
  m = lastMsg(out);
  check('★ 趨勢：有符合的文章 → 圖像卡（一篇一張，「看原文」是按鈕）＋前後兩行說明；純文字句型帶著關鍵字', !!flexOf(out) && flexOf(out).messages[0].type === 'text' && flexOf(out).messages.some((x) => x.type === 'flex') && /"label":"🔗 看原文"/.test(cardJson(out)) && nav(m)[0]?.text === '趨勢關鍵字：半導體 純文字', cardJson(out).slice(0, 300));
  check('　 免費摘要的說明還在（不能讓記者以為這是完整報告）', /這是 IEK 公開的免費摘要，不是完整報告/.test(cardJson(out)));
  out = await dm('U_t', '趨勢關鍵字：半導體 純文字');
  check('　 「純文字」→ 原本的趨勢文字', !flexOf(out) && /IEK 免費焦點/.test(allTextOf(out)) && /🔗 /.test(allTextOf(out)), allTextOf(out).slice(0, 200));
  out = await dm('U_t', '趨勢關鍵字：不存在的領域詞xyz');
  check('★ 沒有符合的文章 → 照舊是一段文字（不是空的圖像卡）', !flexOf(out) && /沒有直接談到/.test(allTextOf(out)), JSON.stringify(out).slice(0, 200));


  // 邀訪窗口：按主題按鈕 → 窗口卡；目錄取預設種子（test-flow 的「邀訪：生醫」同一個主題）
  out = await dm('U_t', '邀訪：生醫');
  check('★ 邀訪窗口：按主題 → 窗口卡（單位與姓名在卡上、altText 寫得出窗口），不是文字', !!flexOf(out) && /邀訪窗口：/.test(flexOf(out).messages.at(-1).altText) && /生醫/.test(cardJson(out)), JSON.stringify(out).slice(0, 300));
  check('　 窗口卡沒有「純文字」那顆（資料短、電話有撥打鈕），仍保有一般導覽入口', !nav(lastMsg(out)).some((c) => /純文字/.test(c.label)) && nav(lastMsg(out)).some((c) => c.text === '找真人'), JSON.stringify(nav(lastMsg(out))));
  state.reporterCards = false;
  out = await dm('U_t', '邀訪：生醫');
  check('　 退回純文字時內容一樣：「【…】邀訪窗口」那一版', !flexOf(out) && /邀訪窗口/.test(allTextOf(out)), JSON.stringify(out).slice(0, 200));
  state.reporterCards = true;

  out = await group('C_g2', 'U_t', '技術領域：綠能與環境');
  check('★ 群組：技術清單維持文字（回覆要引用原問題）', !flexOf(out) && /✉️ yanjia@itri\.org\.tw/.test(allTextOf(out)), JSON.stringify(out).slice(0, 200));

  state.flexFails = true;
  out = await dm('U_t', '技術領域：綠能與環境');
  state.flexFails = false;
  check('★ Flex 送不出去 → 退回純文字清單，信箱與按鈕都在', !flexOf(out) && /✉️ yanjia@itri\.org\.tw/.test(allTextOf(out)), JSON.stringify(out).slice(0, 200));

  state.reporterCards = false; state.rawCalendarFlex = false;
}

function allTextOf(out) { return out.filter((o) => o.kind === 'text').map((o) => o.text).join('\n---\n'); }

console.log(`\n${fail ? '❌' : '✅'} 批次 181 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
