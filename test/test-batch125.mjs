// 批次 125：LINE 群組對話盤點＋職員模式（朱朱口中的「LINE 後台」）瘦身。
//   一、職員模式的按鈕：每則回覆不再掛 12～13 顆，改成「這一步的下一步＋🏠 職員選單」
//   二、教米亞沒講哪一場：列出活動直接點，不用再講一次（以前照指示做會無限循環）；草稿場次也記得進去
//   三、群組各問各的：王問 A、李把群組切到 B，王追問時接回 A（以前答成 B）
//   四、職員密語被打在群組：群組裡不回，私訊打的人、通知管理員
//   五、群組自我介紹：補上隱私告知（LINE-PLAN.md 第 8 節第 6 條）與續問視窗的說明
//   六、問「會不會記錄我們的對話」：寫死的隱私告知，不交給模型發揮
// 跑真的 api/line.js，Sheets／LINE／模型用 test/fakes.mjs 的假版本。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_BASIC_ID = '@123abcde';
delete process.env.LINE_ADMIN_USER_ID;

const { detectChitchat, CHITCHAT_FIXED_REPLIES } = await import('../lib/line-chitchat.js');
const { STAFF_MENU } = await import('../lib/menu.js');
const { readFileSync } = await import('node:fs');

let handler, modSeq = 0;
// ?v=N 讓整個 lib/ 模組圖都重載（職員名單、line_users、活動列的模組層快取一起清掉，見 test/loader.mjs）
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
// mention：文字前面真的帶「@米亞」（index 0、長度 3），跟 LINE 送來的一樣——米亞會把那一段切掉再讀
async function g(gid, uid, text, { mention = true } = {}) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: mention ? `@米亞 ${text}` : text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
async function raw(ev) {
  sent.length = 0;
  await handler(post([ev]), res);
  return sent.slice();
}
// 最後一則看得到的訊息上的按鈕（文字訊息的 quickReply 或 Flex 自己帶的 quickReply）
function chips(out) {
  const vis = out.filter((s) => s.kind === 'text' || s.kind === 'flex');
  const last = vis[vis.length - 1];
  if (!last) return [];
  if (last.kind === 'text') return (last.quickReply || []).map((c) => (typeof c === 'object' ? { label: c.label ?? c.text, text: c.text ?? c.label } : { label: c, text: c }));
  const m = (last.messages || [])[last.messages.length - 1];
  return (m?.quickReply?.items || []).map((i) => ({ label: i.action?.label, text: i.action?.text }));
}
const texts = (out) => chips(out).map((c) => c.text);
const labels = (out) => chips(out).map((c) => c.label);
const textOf = (out) => out.filter((s) => s.kind === 'text').map((o) => o.text).join('\n---\n');
// 這一題實際照哪一場回答：system prompt 開頭是「你是「某場」的 AI 新聞助理」（lib/prompt.js）。
// 不用 fakes 記的 event 欄位——它抓的是 prompt 裡第一個出現的活動名稱，跨場次帶入時會抓到別場。
function answeredId(out) {
  const a = out.find((o) => o.kind === 'answer');
  if (!a) return null;
  const m = String(a.sys || a.sysAll || '').match(/你是「([^」]+)」的 AI/);
  return m ? (state.events.find((r) => r[1] === m[1])?.[0] || null) : a.event;
}
const HOME = '職員選單';
const ENDS_HOME = (out) => texts(out)[texts(out).length - 1] === HOME;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}
const staffRow = (uid) => [uid, '小美', '2026-08-27', '', ''];

// ═══ 一、職員模式的按鈕 ═══════════════════════════════════════════════════════
console.log('── 一、職員模式（LINE 後台）：每則回覆＝這一步的下一步＋「🏠 職員選單」──');
reset(); await fresh();
{
  let out = await dm('U_new', 'openseasame');
  const want = [...STAFF_MENU.buttons.map((b) => `${b.icon} ${b.label}`), '❓ 使用說明'];
  check('★ 登入：按鈕就是圖文選單那六格＋使用說明（7 顆，以前 12 顆）',
    JSON.stringify(labels(out)) === JSON.stringify(want), JSON.stringify(labels(out)));
  check('★ 按鈕上的字跟圖文選單格子一樣（「成效數據」「GEO 狀態」，不再是「查活動後台數據」「GEO現在狀況」）',
    labels(out).some((l) => /成效數據/.test(l)) && labels(out).some((l) => /GEO 狀態/.test(l)) && !labels(out).some((l) => /查活動後台數據|GEO現在狀況/.test(l))
      && texts(out).includes('查活動後台數據'), JSON.stringify(chips(out)));
  check('★ 天天掛著的按鈕裡沒有「設定圖文選單」「退出職員模式」（很少用、按錯又要重打密語）',
    !texts(out).some((t) => /設定圖文選單|退出職員模式/.test(t)), JSON.stringify(texts(out)));
  check('　 管理員還沒設定 LINE_ADMIN_USER_ID：登入訊息附上 LINE ID 與設定方式（管理員第一次登入要用）',
    /LINE_ADMIN_USER_ID/.test(textOf(out)) && /U_new/.test(textOf(out)), textOf(out));

  reset(); await fresh();
  process.env.LINE_ADMIN_USER_ID = 'U_admin';
  out = await dm('U_col', 'openseasame');
  const login = out.find((o) => o.to === 'U_col' && o.kind === 'text')?.text || '';
  check('★ 已經設定好 LINE_ADMIN_USER_ID：同仁登入不再看到一段環境變數的工程說明',
    /職員模式已啟用/.test(login) && !/LINE_ADMIN_USER_ID|環境變數/.test(login), login);
  delete process.env.LINE_ADMIN_USER_ID;
}

reset();
state.staff.push(staffRow('U_staff'));
await fresh();
{
  const steps = [
    ['活動與進度', '活動與進度（選場次清單）', 13],
    ['更多功能', '更多功能', 5],
    ['新增活動', '新增活動問名稱', 3],
    ['算了', '不建了', 3],
    ['查活動後台數據', '問要查哪一場', 13],
    ['半導體先進封裝那場的後台數據', '後台數據結果', 4],
    ['智慧醫療那場的媒體訓練連結', '媒體訓練連結結果', 4],
    ['記憶清單', '記憶清單', 3],
    ['語氣：回答再短一點', '教完一條', 3],
    ['GEO 能見度現在如何', 'GEO 狀態', 3],
    ['我想問一個很奇怪的問題', '聽不懂的話（兜底）', 3]
  ];
  const bad = [];
  for (const [msg, name, max] of steps) {
    const out = await dm('U_staff', msg);
    const t = texts(out);
    if (!ENDS_HOME(out) || t.length > max || t.some((x) => /設定圖文選單/.test(x))) bad.push(`${name}：${JSON.stringify(t)}`);
  }
  check(`★ ${steps.length} 種職員回覆：最後一顆都是「🏠 職員選單」、只放這一步用得到的幾顆、沒有「設定圖文選單」`, bad.length === 0, bad.join('\n   '));

  let out = await dm('U_staff', '更多功能');
  check('　 「更多功能」：要媒體訓練連結、記憶清單、退出職員模式、使用說明＋職員選單（格子底下寫的「訓練、教米亞、退出」）',
    JSON.stringify(texts(out)) === JSON.stringify(['要媒體訓練連結', '記憶清單', '退出職員模式', '使用說明', HOME]), JSON.stringify(texts(out)));
  check('　 「設定圖文選單」還寫在「更多功能」的說明裡（要用時打字就好）', /設定圖文選單/.test(textOf(out)), textOf(out));

  out = await dm('U_staff', HOME);
  check('★ 按「🏠 職員選單」→ 一句話＋全部功能（六格＋使用說明），不是一面說明文字',
    texts(out).length === 7 && STAFF_MENU.buttons.every((b) => texts(out).includes(b.text)) && texts(out).includes('使用說明')
      && textOf(out).split('\n').length <= 3, JSON.stringify([textOf(out), texts(out)]));
  for (const w of ['選單', '回首頁']) {
    out = await dm('U_staff', w);
    check(`　 打「${w}」也一樣是職員選單`, texts(out).length === 7 && /要做什麼呢/.test(textOf(out)), JSON.stringify([textOf(out), texts(out)]));
  }

  await fresh(); // 上面已經連發十幾則，限流（每分鐘 15 則）是模組層狀態，重載一次歸零
  out = await dm('U_staff', '使用說明');
  const help = textOf(out);
  check('★ 「使用說明」：一件事一行（不再是【管理】【直接改資料】【教米亞】【離開】四段十七行的牆）',
    !/【管理】|【直接改資料】|【離開】/.test(help) && help.split('\n').filter((l) => l.startsWith('・')).length <= 6 && help.length < 420,
    `${help.length} 字\n${help}`);
  check('　 說明裡該有的都還在：活動與進度、新增活動、改資料、照片、教米亞、未發布也問得到、更多功能',
    ['活動與進度', '新增活動', '改成南港展覽館', '照片', '記住：', '語氣：', '還沒發布', '更多功能'].every((k) => help.includes(k)), help);
  check('　 「使用說明」的按鈕也是全部功能（7 顆）', texts(out).length === 7, JSON.stringify(texts(out)));

  // 例外照舊：確認修改只有兩顆
  out = await dm('U_staff', '智慧醫療那場地點改成南港展覽館');
  check('　 例外不變：「要改嗎？」只有確認／取消兩顆，不加職員選單（只有兩條路，旁邊擺別的出口只會讓人點走）',
    texts(out).length === 2 && texts(out).some((t) => /確認修改/.test(t)), JSON.stringify(texts(out)));
  await dm('U_staff', '✖ 取消修改');

  // GEO 簡報有資料時送的是 Flex（不會自動帶按鈕）：餵一份假的 /api/geo 回應，走真的 Flex 那條
  await fresh();
  const realFetch = globalThis.fetch;
  process.env.ADMIN_PASSWORD = 'pw';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/geo?action=status')) return { ok: true, json: async () => ({ date: '2026-10-11', done: 8, total: 20, remaining: 12, engines: [], ready: null }) };
    if (u.includes('/api/geo?action=series')) return { ok: true, json: async () => ({ summary: { samples: 84, lastScan: '2026-10-10', score14: 52.3, mentionRate14: 61, citedRate14: 34, failed14: 0 }, board: [{ keyword: '化合物半導體', score: 68.5, delta: 4.2, mentionRate: 80, citedRate: 50, samples: 14, findings: [] }], events: [] }) };
    return realFetch(url, opts);
  };
  try {
    out = await dm('U_staff', 'GEO 能見度現在如何');
    check('　 GEO 簡報（Flex 卡片）也帶「🏠 職員選單」（以前一顆按鈕都沒有，看完只能自己找圖文選單）',
      out[0]?.kind === 'flex' && ENDS_HOME(out), JSON.stringify([out[0]?.kind, texts(out)]));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ADMIN_PASSWORD;
  }
}

// ═══ 二、教米亞：沒講哪一場 ═══════════════════════════════════════════════════
console.log('\n── 二、教米亞沒講哪一場：列出活動直接點，點了就記 ──');
reset();
state.staff.push(staffRow('U_staff'));
await fresh();
{
  const MEMO = '這場的技術還在實驗階段，不要說已經量產';
  let out = await dm('U_staff', '記住：' + MEMO);
  check('★ 沒講哪一場：問「要記在哪一場」，按鈕直接列出活動＋「所有場次都適用」',
    /要記在哪一場/.test(textOf(out)) && texts(out).includes('半導體先進封裝技術發表會') && texts(out).includes('所有場次都適用') && ENDS_HOME(out),
    JSON.stringify([textOf(out), texts(out)]));
  check('　 不再叫同仁「先打活動名稱切到那一場，再跟我說一次」（職員模式點名稱是開活動卡，照做只會再被問一次）',
    !/切到那一場|再跟我說一次/.test(textOf(out)), textOf(out));
  check('　 這時還沒記任何東西', state.memories.length === 0, JSON.stringify(state.memories));

  out = await dm('U_staff', '半導體先進封裝技術發表會');
  const m = state.memories[0] || [];
  check('★ 點活動名稱 → 記進那一場（以前是跳出活動卡，記不進去）',
    m[1] === 'semi' && m[3] === MEMO && m[5] === 'on' && /記起來了/.test(textOf(out)) && /半導體先進封裝技術發表會/.test(textOf(out))
      && !out.some((o) => o.kind === 'flex'), JSON.stringify([m, textOf(out)]));

  await dm('U_staff', '記住：所有活動的新聞聯絡窗口都是公關室');
  out = await dm('U_staff', '所有場次都適用');
  const g2 = state.memories[1] || [];
  check('★ 點「所有場次都適用」→ 記成全站', g2[1] === 'global' && g2[3] === '所有活動的新聞聯絡窗口都是公關室' && /所有場次/.test(textOf(out)), JSON.stringify([g2, textOf(out)]));

  await dm('U_staff', '記住：' + MEMO);
  out = await dm('U_staff', '算了');
  check('　 回「算了」→ 不記', state.memories.length === 2 && /沒有記/.test(textOf(out)), JSON.stringify([state.memories.length, textOf(out)]));

  // 草稿場次：句子裡講明了，以前因為「草稿當作不存在」被問哪一場
  reset();
  state.staff.push(staffRow('U_staff'));
  state.events.find((r) => r[0] === 'med')[4] = 'draft';
  await fresh();
  out = await dm('U_staff', '記住：智慧醫療那場的講者改成林博士');
  check('★ 還沒發布的場次，句子裡講明了 → 直接記進那一場（活動前正是最需要先教米亞的時候）',
    (state.memories[0] || [])[1] === 'med' && /記起來了/.test(textOf(out)), JSON.stringify([state.memories, textOf(out)]));

  // 選場次時上限已滿
  reset();
  state.staff.push(staffRow('U_staff'));
  await fresh();
  await dm('U_staff', '記住：' + MEMO);
  for (let i = 0; i < 40; i++) state.memories.push(['2026-10-01', 'global', 'style', `規則${i}`, 'U_x', 'on']);
  await fresh();
  out = await dm('U_staff', '半導體先進封裝技術發表會');
  check('　 問完到點下去之間記憶滿了 → 不記，說明上限', !state.memories.some((r) => r[3] === MEMO) && /上限/.test(textOf(out)), textOf(out));
}

// ═══ 三、群組各問各的 ═════════════════════════════════════════════════════════
console.log('\n── 三、群組：每個人接著問自己那一場 ──');
reset(); await fresh();
{
  const G = 'Cpress125';
  await g(G, 'U王', '半導體先進封裝那場的重點是什麼？');
  let out = await g(G, 'U李', '智慧醫療那場幾點開始？');
  check('（前提）李問別場 → 群組切到智慧醫療', state.bindings.get(G)?.event_id === 'med' && /已切換到《智慧醫療解決方案記者會》/.test(textOf(out)), textOf(out));

  out = await g(G, 'U王', '那良率呢？', { mention: false });
  const ans = out.find((o) => o.kind === 'answer');
  check('★ 王接著追問（沒 @）→ 答的是他自己問的半導體那場（以前答成李切過去的智慧醫療）', answeredId(out) === 'semi', JSON.stringify(answeredId(out)));
  check('★ 開頭標明接的是哪一場，群組裡其他人看得懂', /^↩️ 接著您剛剛問的《半導體先進封裝技術發表會》/.test(textOf(out)), textOf(out));
  check('★ 王的上一輪（半導體那題）有一起送給模型——「那良率呢」接得上',
    JSON.stringify(ans?.msgs || []).includes('半導體先進封裝那場的重點是什麼？'), JSON.stringify(ans?.msgs || []).slice(0, 300));
  check('　 群組的綁定沒有被王的追問改掉（還是智慧醫療）', state.bindings.get(G)?.event_id === 'med', JSON.stringify(state.bindings.get(G)?.event_id));

  out = await g(G, 'U李', '那地點在哪？', { mention: false });
  check('　 李接著問 → 還是智慧醫療，也不會多一句「接著您剛剛問的」', answeredId(out) === 'med' && !/接著您剛剛問的/.test(textOf(out)), textOf(out));

  out = await g(G, 'U陳', '這場有新聞稿嗎？');
  check('　 沒問過的人 → 照群組最後切到的那一場（智慧醫療）', answeredId(out) === 'med', JSON.stringify(answeredId(out)));

  out = await g(G, 'U王', '智慧醫療那場的講者是誰？');
  check('　 王明講別場 → 照舊換過去（換場也改群組綁定）', answeredId(out) === 'med' && state.bindings.get(G)?.event_id === 'med', textOf(out));

  // 自己的上一題超過 10 分鐘：照群組綁定
  await g(G, 'U林', '半導體先進封裝那場的重點是什麼？');
  await g(G, 'U李', '智慧醫療那場幾點開始？');
  const b = state.bindings.get(G);
  const turns = JSON.parse(b.groupTurns || '{}');
  if (turns['U林']) turns['U林'].t = Date.now() - 11 * 60 * 1000;
  b.groupTurns = JSON.stringify(turns);
  await fresh();
  out = await g(G, 'U林', '那良率呢？', { mention: false });
  check('　 自己的上一題已經超過 10 分鐘 → 不硬接，照群組綁定', answeredId(out) === 'med', JSON.stringify(answeredId(out)));
}

// ═══ 四、職員密語被打在群組 ═══════════════════════════════════════════════════
console.log('\n── 四、職員密語被打在群組：群組裡不回，私訊提醒 ──');
reset(); await fresh();
{
  const G = 'Cwork125';
  process.env.LINE_ADMIN_USER_ID = 'U_admin';
  let out = await g(G, 'U陳', 'openseasame');
  check('★ 「@米亞 密語」→ 群組裡一個字都不回（不幫密語多曝光一次，也不再答非所問）', !out.some((o) => o.to === G), JSON.stringify(out.map((o) => o.to)));
  const toSpeaker = out.find((o) => o.to === 'U陳');
  check('★ 私訊打的人：群組裡大家都看得到、要在一對一登入、建議換密語', toSpeaker?.push === true && /群組裡的人都看得到/.test(toSpeaker.text) && /一對一/.test(toSpeaker.text), JSON.stringify(toSpeaker));
  check('★ 通知管理員（附群組 ID，建議更換 LINE_STAFF_PASSCODE）', out.some((o) => o.to === 'U_admin' && o.push && /LINE_STAFF_PASSCODE/.test(o.text) && o.text.includes(G)), JSON.stringify(out));
  check('　 不會因此變成職員（群組不接職員模式）', state.staff.length === 0, JSON.stringify(state.staff));
  check('　 沒有送去問模型', !out.some((o) => o.kind === 'answer' || o.kind === 'fallback'), JSON.stringify(out.map((o) => o.kind)));

  out = await g(G, 'U周', 'OpenSeasame', { mention: false }); // 大小寫不同也算（isPasscodeMatch 不分大小寫）
  check('　 沒 @ 也一樣提醒（密語一打出來大家就看得到了）', out.some((o) => o.to === 'U周') && !out.some((o) => o.to === G), JSON.stringify(out.map((o) => o.to)));
  delete process.env.LINE_ADMIN_USER_ID;

  out = await g(G, 'U陳', '你好');
  check('　 一般訊息不受影響（照舊在群組裡回）', out.some((o) => o.to === G), JSON.stringify(out.map((o) => o.to)));
}

// ═══ 五、群組自我介紹 ═════════════════════════════════════════════════════════
console.log('\n── 五、群組自我介紹：隱私告知與續問視窗 ──');
reset(); await fresh();
{
  const out = await raw({ type: 'join', replyToken: 'rtj', source: { type: 'group', groupId: 'Cjoin125' } });
  const t = out[0]?.text || '';
  const MENU = readFileSync(new URL('../lib/menu.js', import.meta.url), 'utf8');
  const notice = '本帳號會記錄提問內容以改善新聞服務，不會蒐集您的個人資料。';
  check('★ 有隱私告知（群組裡的人是被別人拉進來的，從沒看過 1 對 1 的歡迎詞）', t.includes(notice), t);
  check('　 字句跟 1 對 1 歡迎卡那句同一份（lib/menu.js），不是另外寫一個版本', MENU.includes(notice));
  check('★ 講了續問視窗：叫過之後幾分鐘內接著問不用再 @（不然沒 @ 的提問被回，看起來像插話）', /幾分鐘內，接著問不用再 @/.test(t), t);
  check('　 原本的規矩照舊寫在最前面', /只有被叫到的時候才會說話/.test(t) && t.indexOf('只有被叫到') < t.indexOf('本帳號會記錄'), t);
}

// ═══ 六、問「會不會記錄我們的對話」 ═══════════════════════════════════════════
console.log('\n── 六、隱私問題：寫死的告知，不交給模型 ──');
{
  const yes = ['這個帳號會記錄我們的對話嗎？', '你會記錄我問的問題嗎', '我的個資會被你們拿去用嗎', '米亞有在蒐集個資嗎', '對話會被記錄嗎？', '你們會不會保存我的提問'];
  const no = ['工研院有隱私運算技術嗎？', '這場有沒有儲存技術的發表？', '這邊有儲能與資料儲存的技術嗎？', '這個技術的數據會被記錄嗎', '請問新聞稿中提到的資料儲存方案有哪些', '有照片可以用嗎？', '記者會現場會不會有人記錄我們的提問？'];
  const wrong = [...yes.filter((t) => detectChitchat(t) !== 'privacy').map((t) => `應認得：${t}`), ...no.filter((t) => detectChitchat(t) === 'privacy').map((t) => `不該攔：${t}`)];
  check(`★ ${yes.length} 種問法認得出來，${no.length} 句真的技術題／活動題不會被攔（「隱私運算」「資料儲存」「記者會現場有沒有人記錄」是記者真的會問的）`, wrong.length === 0, wrong.join('\n   '));
  check('　 回覆用的是審過的那句隱私告知', CHITCHAT_FIXED_REPLIES.privacy.includes('本帳號會記錄提問內容以改善新聞服務，不會蒐集您的個人資料。'));

  reset(); await fresh();
  state.bindings.set('U_rep', { event_id: 'semi', media_name: '聯合報', bound_at: Date.now(), note: '' });
  let out = await dm('U_rep', '這個帳號會記錄我們的對話嗎？');
  check('★ 1 對 1（綁定中）問 → 固定告知，不送去問模型（模型可能答出「我不會記錄任何內容」）',
    textOf(out).includes('本帳號會記錄提問內容') && !out.some((o) => o.kind === 'answer'), JSON.stringify(out.map((o) => [o.kind, o.text])));
  out = await dm('U_new2', '你會記錄我問的問題嗎');
  check('　 1 對 1（沒綁定）問 → 一樣是固定告知', textOf(out).includes('本帳號會記錄提問內容') && !out.some((o) => o.kind === 'fallback'), JSON.stringify(out.map((o) => [o.kind, o.text])));
  out = await g('Cpriv125', 'U林', '這個帳號會記錄我們的對話嗎？');
  check('　 群組 @ 米亞問 → 一樣是固定告知', textOf(out).includes('本帳號會記錄提問內容'), textOf(out));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 125（群組盤點＋職員模式瘦身）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
