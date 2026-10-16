// 批次 144：四角色走查（tools/persona-check/）找到的問題，修好之後在這裡永久守住。
//   一、後台助理「新增活動草稿」：日期一定要是 YYYY-MM-DD（「11/20」不能原樣寫進活動表 F 欄）
//   二、後台助理的活動工具：狀態給中文說法（status_label），模型才不會把 active／draft 講給主管聽
//   三、待教清單：超過 200 字的題目，第二天的排程不能再加一次、再推一次
//   四、合作洽詢：開頭帶招呼語（「你好，我想跟工研院談合作」）也認得出來；記者問合作新聞仍然不攔
//   五、手機版後台：米亞按鈕要讓開底部選單（不能蓋住「更多」）
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.EVENTS_TABLE_TTL_MS = '0';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

const { book, reset } = await import('./fakes-sheets82.mjs');
const A = await import('../lib/assistant.js');
const T = await import('../lib/teach-queue.js');
const { isPartnershipAsk } = await import('../lib/b2b-line.js');
reset();
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const Y = today.slice(0, 4);

// ═══ 一、新增活動草稿的日期 ═══════════════════════════════════════════════════
console.log('\n── 一、後台助理新增活動草稿：日期格式 ──');
{
  for (const bad of ['11/20', '下週三', `${Y}/11/20`, `${Y}-02-30`, '2026-1-5']) {
    const r = await A.buildProposal({ kind: 'create_event_draft', name: '量子論壇', event_date: bad });
    check(`★ 日期「${bad}」→ 不產生確認卡，退回給模型換算（訊息裡有 YYYY-MM-DD 與今天的日期）`,
      !r.ok && /YYYY-MM-DD/.test(r.error) && r.error.includes(today), JSON.stringify(r));
  }
  const r = await A.buildProposal({ kind: 'create_event_draft', name: '量子論壇', event_date: `${Y}-11-20`, venue: '中興院區' });
  check('合格的日期 → 卡片上帶星期幾、送出去的是純日期', r.ok && r.proposal.request.body.event_date === `${Y}-11-20`
    && r.proposal.fields.some((f) => f.label === '日期' && new RegExp(`^${Y}-11-20（[日一二三四五六]）$`).test(f.value)), JSON.stringify(r));
  const none = await A.buildProposal({ kind: 'create_event_draft', name: '量子論壇' });
  check('不給日期 → 照樣可以建（日期之後在編輯頁補）', none.ok && none.proposal.request.body.event_date === '' && !none.proposal.fields.some((f) => f.label === '日期'));
  const src = fs.readFileSync(path.join(ROOT, 'lib/assistant.js'), 'utf8');
  check('工具說明也講清楚 event_date 要 YYYY-MM-DD（先講清楚，少一輪退件）', /event_date（一定要 YYYY-MM-DD/.test(src));
}

// ═══ 二、活動狀態的中文說法 ═══════════════════════════════════════════════════
console.log('\n── 二、活動工具的狀態說法 ──');
{
  const ev = (id, status) => [id, `活動${id}`, '#000', '', status, '2026-10-20', '', '', '', '工研院', 'c', '', '', '', '', '', '', ''];
  book.events = [['id'], ev('a', 'active'), ev('d', 'draft'), ev('x', 'archived'), ev('e', 'ended'), ev('blank', '')];
  // list_events／get_event 沒有 export，走真的對話迴圈太重；直接看工具清單的結果：用 runAssistant 的假 fetch
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const last = body.messages.at(-1);
    const mk = (content, stop) => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: stop, usage: {} }) });
    if (typeof last.content === 'string') return mk([{ type: 'tool_use', id: 't1', name: 'list_events', input: {} }], 'tool_use');
    if (last.content[0].tool_use_id === 't1') return mk([{ type: 'tool_use', id: 't2', name: 'get_event', input: { id: 'd' } }], 'tool_use');
    return mk([{ type: 'text', text: '好了' }], 'end_turn');
  };
  await A.runAssistant([{ role: 'user', content: '有哪些活動' }], { apiKey: 'k' });
  const list = JSON.parse(calls[1].messages.at(-1).content[0].content);
  const labels = Object.fromEntries(list.events.map((e) => [e.id, e.status_label]));
  check('list_events：每場都有中文狀態（進行中／未發布／已封存／已結束；空白當進行中），而且不帶表情符號',
    labels.a === '進行中' && labels.d === '未發布' && labels.x === '已封存' && labels.e === '已結束' && labels.blank === '進行中', JSON.stringify(labels));
  check('　 篩選用的代碼還在（status），模型照樣可以用 status 篩選', list.events.find((e) => e.id === 'd').status === 'draft');
  const one = JSON.parse(calls[2].messages.at(-1).content[0].content);
  check('get_event 也有 status_label', one.status_label === '未發布', JSON.stringify(one));
}

// ═══ 三、待教清單：長題目的去重 ═══════════════════════════════════════════════
console.log('\n── 三、待教清單：超過 200 字的題目 ──');
{
  const now = Date.now();
  const tw = (t) => new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const longQ = '請問這場記者會' + '關於智慧醫療平台的臨床驗證流程與資料保護機制'.repeat(12) + '可以說明嗎？';
  check('（前提）題目真的超過 200 字', longQ.length > 200, longQ.length);
  const rows = [[tw(now - 3600e3), 'med', '智慧醫療記者會', '經濟日報', longQ, '這部分我沒有資料，建議洽新聞聯絡人。', '', 'line', '']];
  const first = T.findSuspects(rows, { now });
  check('第一天：長題目被找出來', first.length === 1);
  // 存進 teach_queue 的是截到 200 字的題目（addToQueue），第二天排程用 parseQueueRows 讀回來算「已經提過」
  const stored = T.parseQueueRows([[1, tw(now), 'med', '智慧醫療記者會', first[0].question.slice(0, 200), 'unanswered', 1, '', 'open', 'Y']]);
  const seen = new Set(stored.map((x) => T.queueKey(x.eventId, x.question)));
  const second = T.findSuspects(rows, { now: now + 86400e3 - 7200e3 }).filter((s) => !seen.has(s.key));
  check('★ 第二天排程再掃到同一題 → 認得是已經提過的，不再加、不再推', second.length === 0, JSON.stringify(second.map((s) => s.question.length)));
  check('　 活動 id 前後有空白也對得上（讀回來會 trim）', T.findSuspects([[rows[0][0], ' med ', ...rows[0].slice(2)]], { now })[0].key === first[0].key);
}

// ═══ 四、合作洽詢的招呼語 ══════════════════════════════════════════════════════
console.log('\n── 四、合作洽詢：開頭的招呼語 ──');
{
  const yes = ['你好，我想跟工研院談合作', '您好！技術授權要找誰', '不好意思打擾了，合作洽詢', '嗨 企業合作洽詢', 'hi 我想跟工研院合作', '企業合作洽詢', '技術移轉洽詢'];
  const no = ['你好', '您好，請問最近有哪些活動', '你好，工研院跟台積電合作的新聞', '工研院跟台積電合作的新聞', '這場記者會有合作廠商嗎'];
  for (const t of yes) check(`認得：「${t}」`, isPartnershipAsk(t));
  for (const t of no) check(`★ 不攔：「${t}」（記者的問題照原本的路徑走）`, !isPartnershipAsk(t));
}

// ═══ 五、手機版後台：米亞讓開底部選單 ════════════════════════════════════════
console.log('\n── 五、手機版後台的米亞按鈕位置 ──');
{
  const js = fs.readFileSync(path.join(ROOT, 'public/mia-assistant.js'), 'utf8');
  check('偵測固定在底部的 #sidebar，按鈕與對話框往上讓開；視窗大小改變時重算',
    /getElementById\('sidebar'\)/.test(js) && /function placeFab/.test(js) && /fab\.style\.bottom/.test(js) && /panel\.style\.bottom/.test(js) && /addEventListener\('resize'/.test(js));
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check('（前提）後台首頁手機版的底部選單就是 #sidebar、最右邊是「更多」', /id="sidebar"/.test(html) && /id="nav-more-btn"/.test(html));
  // 真的在瀏覽器裡量位置的是 tools/persona-check/web.mjs（需要 Chromium，不進 npm test）
}

console.log(`\n${fail ? '❌' : '✅'} 批次 144 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
