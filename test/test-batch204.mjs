// 批次 204：整句話被當成關鍵字（朱朱 LINE 截圖）。
//   記者打「目前工研院在幹嘛 都沒活動」，米亞回「工研院官網新聞中心目前沒有找到跟『目前在幹嘛都沒活動』直接相關的報導」，
//   底下還有一顆「幹嘛都沒活動的技術與洽案」。
//   一、isKeywordLike()：分得出「題目」與「一句話」，不誤傷真的技術詞
//   二、規則層：「沒活動／有沒有活動」是在問行事曆
//   三、LINE 流程：截圖那句、路由抽不出關鍵字的句子、按了「近期工研院新聞」之後打一整句
//   四、產業趨勢查不到時也不複誦整句
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 800) : ''}`); }
}

// ═══ 一、題目還是一句話 ═════════════════════════════════════════════════════
console.log('── 一、isKeywordLike() ──');
{
  const { isKeywordLike } = await import('../lib/line-chitchat.js');
  for (const s of ['半導體', '機器人', 'AI 晶片先進封裝', '自我修復材料', '淨零排放關鍵技術', 'humanoid robot', '火星殖民', '量子火箭引擎', '無人機', '有機材料', '智慧都市', '簽約儀式', '國際合作']) {
    check(`題目：「${s}」`, isKeywordLike(s) === true);
  }
  for (const s of ['目前在幹嘛都沒活動', '幹嘛都沒活動', '這個技術官網完全沒報導過', '你們最近在做什麼', '到底在忙什麼', '有沒有新東西', '可以給我一些資料', '', '這是一段超過十二個字而且很明顯不是題目的句子']) {
    check(`★ 不是題目：「${s}」`, isKeywordLike(s) === false);
  }
}

// ═══ 二、規則層 ═════════════════════════════════════════════════════════════
console.log('\n── 二、「沒活動／有沒有活動」是在問行事曆 ──');
{
  const { detectMetaIntent } = await import('../lib/menu.js');
  for (const s of ['目前工研院在幹嘛 都沒活動', '工研院最近有沒有活動', '最近都沒有記者會嗎', '這個月沒活動嗎']) {
    check(`★ 「${s}」→ calendar`, detectMetaIntent(s) === 'calendar', detectMetaIntent(s));
  }
  for (const s of ['這場之後都沒活動了嗎', '這個案子沒活動預算', '工研院沒有活動代碼怎麼辦', '半導體最近有什麼進展']) {
    check(`不誤收：「${s}」`, detectMetaIntent(s) !== 'calendar', detectMetaIntent(s));
  }
}

// ═══ 三、LINE 流程 ═════════════════════════════════════════════════════════
console.log('\n── 三、LINE 流程 ──');
{
  // 官網新聞搜尋照真的官網：關鍵字要剛好對得上才有結果，整句話一律 0 則；不帶關鍵字＝最新新聞
  const fakeFetch = globalThis.fetch;
  const searched = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('itri.org.tw') && u.includes('DisplayStyle=06')) {
      const kw = decodeURIComponent((u.match(/[?&]keyword=([^&]*)/) || [])[1] || '');
      searched.push(kw);
      return { ok: true, status: 200, text: async () => (kw === '半導體' || !kw ? state.itriHtml : '') };
    }
    return fakeFetch(url, opts);
  };
  let handler, seq = 0;
  const fresh = async () => { handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
  const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
  const dm = async (text) => {
    await fresh();
    sent.length = 0;
    searched.length = 0;
    const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt' + seq, source: { type: 'user', userId: 'U_rep' }, message: { type: 'text', id: 'm' + seq, text } }] });
    const r = new EventEmitter(); r.method = 'POST';
    r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
    setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
    await handler(r, res);
    const out = sent.slice();
    out.all = JSON.stringify(out); // 文字、卡片、按鈕全部攤平來比對：這幾條檢查要的是「哪裡都不能出現」
    return out;
  };
  const ECHO_RE = /直接相關的報導|幹嘛|在忙什麼|都沒活動的|的技術與洽案/;

  reset();
  let out = await dm('目前工研院在幹嘛 都沒活動');
  check('★ 截圖那句：不再說「沒有找到跟…直接相關的報導」，也沒有把句子做成按鈕', out.length > 0 && !ECHO_RE.test(out.all.replace(/目前工研院在幹嘛 都沒活動/g, '')), out.all);
  check('　 給的是近期活動（清單或「目前沒有排定中的活動」）', /近期活動|即將舉行|最近辦過|沒有排定中的活動/.test(out.all), out.all);
  check('　 沒有拿整句去查官網', searched.length === 0, JSON.stringify(searched));

  reset();
  out = await dm('工研院到底在忙什麼');
  check('★ 路由判成工研院新聞、但抽不出關鍵字 → 列最新新聞，先說一聲', /我先列工研院最近發布的新聞給您參考/.test(out.all), out.all);
  check('　 不說「沒有找到…」、不把句子做成按鈕', !/直接相關的報導|在忙什麼的|忙什麼的技術/.test(out.all), out.all);
  check('　 沒有拿整句去查官網（只查了不帶關鍵字的最新新聞）', searched.every((k) => k === ''), JSON.stringify(searched));

  reset();
  out = await dm('工研院在忙什麼活動');
  check('★ 抽不出關鍵字、句子提到活動 → 列近期活動', /這是工研院近期的活動|沒有排定中的活動/.test(out.all) && !/直接相關的報導/.test(out.all), out.all);

  reset();
  out = await dm('工研院半導體有什麼新聞嗎');
  check('不退步：抽得出關鍵字的照舊查新聞', /工研院新聞｜「半導體」/.test(out.all), out.all.slice(0, 300));

  reset();
  await dm('近期工研院新聞');
  out = await dm('這個東西官網完全沒報導過');
  check('★ 按了「近期工研院新聞」之後打一整句、查不到：不放進「」裡複誦', /沒有找到跟這個題目直接相關的報導/.test(out.all) && !/「這個東西官網完全沒報導過」/.test(out.all), out.all);
  check('　 照樣給一個找得到的人、提示換關鍵字', /綜合窗口|朱則瑋/.test(out.all) && /換個關鍵字/.test(out.all), out.all);
  check('　 沒有把句子做成「…的技術與洽案」按鈕', !/的技術與洽案/.test(out.all), out.all);

  reset();
  await dm('近期工研院新聞');
  out = await dm('火星殖民');
  check('不退步：打的是題目、查不到 → 照舊複誦題目', /沒有找到跟「火星殖民」直接相關的報導/.test(out.all), out.all);
  globalThis.fetch = fakeFetch;
}

// ═══ 四、產業趨勢 ═══════════════════════════════════════════════════════════
console.log('\n── 四、產業趨勢查不到 ──');
{
  const { formatTrendReply } = await import('../lib/industry-trends.js');
  const a = formatTrendReply({ keyword: '', matched: [], poolSize: 12, since: '2026/10/01' });
  check('★ 關鍵字留空（記者打的是一句話）→ 說「這個題目」，沒有空的「」', /沒有直接談到這個題目的內容/.test(a) && !/「」/.test(a), a);
  const b = formatTrendReply({ keyword: '量子', matched: [], poolSize: 12, since: '2026/10/01' });
  check('不退步：有關鍵字照舊複誦', /沒有直接談到「量子」的內容/.test(b), b);
}

console.log(`\n${fail ? '❌' : '✅'} 批次 204 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
