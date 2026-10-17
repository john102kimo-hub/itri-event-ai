// 批次 148：「簽約儀式相關的」查不到（朱朱 LINE 截圖）。
//   官網新聞搜尋接近精準比對：實測「簽約儀式相關的」0 則、「簽約儀式」3 則。去語助詞那一層沒處理「相關／有關／關於」，
//   而且回覆照抄記者的整句：「沒有找到跟『簽約儀式相關的』直接相關的報導」。
//   一、去字規則：開頭「關於／有關／針對」、結尾「相關／有關／方面／之類／報導／消息」；「跟」只在結尾也有「有關／相關」時才拿
//   二、LINE 流程：按「近期工研院新聞」→ 打「簽約儀式相關的」→ 查得到，標題、更多新聞按鈕都用「簽約儀式」；查不到時也不照抄整句
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
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

// ═══ 一、去字規則 ═══════════════════════════════════════════════════════════
console.log('── 一、關鍵字的口氣字 ──');
{
  const { stripTechQueryFiller } = await import('../lib/itri-news.js');
  const cases = [
    ['簽約儀式相關的', '簽約儀式'], ['簽約儀式相關', '簽約儀式'], ['有關簽約儀式的', '簽約儀式'], ['關於簽約儀式', '簽約儀式'],
    ['跟簽約儀式有關的新聞', '簽約儀式'], ['有沒有簽約儀式相關的報導', '簽約儀式'], ['半導體相關新聞', '半導體'], ['智慧醫療方面', '智慧醫療'],
    ['跟AI有關', 'AI'], ['最近的國際合作', '國際合作'],
  ];
  for (const [input, want] of cases) check(`「${input}」→「${want}」`, stripTechQueryFiller(input) === want, stripTechQueryFiller(input));
  const keep = [['跟車輔助', '跟車輔助'], ['跟車輔助技術', '跟車輔助技術'], ['資料中心', '資料中心'], ['資訊安全', '資訊安全'], ['相關', '相關']];
  for (const [input, want] of keep) check(`★ 不誤傷：「${input}」照舊是「${want}」（真的技術詞、或整句只剩口氣字）`, stripTechQueryFiller(input) === want, stripTechQueryFiller(input));
}

// ═══ 二、LINE 流程 ═════════════════════════════════════════════════════════
console.log('\n── 二、按「近期工研院新聞」再打關鍵字 ──');
{
  // 官網新聞搜尋：照真的官網的行為——關鍵字要剛好是「簽約儀式」才查得到，多帶「相關的」就是 0 則
  const fakeFetch = globalThis.fetch;
  const searched = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('itri.org.tw') && u.includes('DisplayStyle=06')) {
      const kw = decodeURIComponent((u.match(/[?&]keyword=([^&]*)/) || [])[1] || '');
      searched.push(kw);
      return { ok: true, status: 200, text: async () => (kw === '簽約儀式' || !kw ? state.itriHtml : '') };
    }
    return fakeFetch(url, opts);
  };
  let handler, seq = 0;
  const fresh = async () => { handler = (await import(new URL(`../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
  const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
  const dm = async (text) => {
    await fresh();
    sent.length = 0;
    const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt' + seq, source: { type: 'user', userId: 'U_rep' }, message: { type: 'text', id: 'm' + seq, text } }] });
    const r = new EventEmitter(); r.method = 'POST';
    r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
    setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
    await handler(r, res);
    const out = sent.slice();
    out.text = out.map((s) => s.text || '').join('\n');
    out.chips = (out.at(-1)?.quickReply || []).map((c) => (typeof c === 'object' && c ? (c.text ?? c.label) : String(c)));
    return out;
  };

  reset();
  await dm('近期工研院新聞');
  searched.length = 0;
  let out = await dm('簽約儀式相關的');
  check('★ 截圖的情況：打「簽約儀式相關的」→ 查得到（整句查 0 則後，去掉「相關的」再查一次）', /工研院新聞｜「簽約儀式」/.test(out.text) && searched.includes('簽約儀式'), JSON.stringify({ searched, text: out.text.slice(0, 200) }));
  check('　 標題寫「簽約儀式」，不照抄「簽約儀式相關的」', !/簽約儀式相關/.test(out.text), out.text.slice(0, 200));
  check('　 其他按鈕（技術與洽案、產業趨勢）也用「簽約儀式」', !out.chips.some((c) => /簽約儀式相關/.test(c)), JSON.stringify(out.chips));

  reset();
  await dm('近期工研院新聞');
  out = await dm('火星殖民相關的');
  check('★ 真的查不到時：說「沒有找到跟『火星殖民』直接相關的報導」，不照抄整句', /沒有找到跟「火星殖民」直接相關的報導/.test(out.text) && !/火星殖民相關的/.test(out.text), out.text);
  check('　 查不到時照樣給一個找得到的人（綜合窗口）', /綜合窗口|朱則瑋/.test(out.text), out.text);
  globalThis.fetch = fakeFetch;
}

console.log(`\n${fail ? '❌' : '✅'} 批次 148 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
