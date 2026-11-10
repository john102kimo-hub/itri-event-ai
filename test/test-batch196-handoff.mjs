// 批次 196、197（工單 B）：答不出來時的講法，以及「先問記者要不要轉介真人，回『是』才通知」。
//   一、prompt：LINE 的第 2 條規則換成「模型只寫接住與能說的」，網頁版逐 byte 不變；敏感場次的類型清單與口徑外那一段
//   二、純函式：程式接的句子（朱朱給的原文）、回「是」「不用」的判斷、通知上限
//   三、LINE 端到端（真的 api/line.js，只有 Sheets／LINE／模型是假的）：
//       資料沒寫、口徑以外、連續追問、回「是」才通知、推播失敗、超過上限、群組（發問者各自一份）、聲明稿（默默通知）、不補查官網、不帶別場資料、省略警語
//   四、發布前檢查：敏感場次沒有預擬問答／口徑外固定句／聯絡人電話 → 提醒
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset, isoOffset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
process.env.LINE_ADMIN_USER_ID = 'Uadmin';
process.env.LINE_BASIC_ID = '@123abcde';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
delete process.env.NODATA_NOTIFY_PER_DAY;
delete process.env.NODATA_NOTIFY_EVENT_PER_HOUR;
delete process.env.NODATA_NOTIFY_SENSITIVE_PER_HOUR;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 800) : ''}`); }
}

const P = await import('../lib/prompt.js');
const F = await import('../lib/line-format.js');
const H = await import('../lib/no-data-handoff.js');
const S = await import('../lib/sensitive-event.js');
const N = await import('../lib/line-nodata.js');
const ES = await import('../lib/event-status.js');

const STMT_KB = [
  '【活動名稱】關於王大明先生資格案的回應說明', '',
  '【新聞稿全文】', '本院今日針對外界關注之王大明先生資格案發布說明：本院已啟動內部程序，過程依規定辦理。', '',
  '【常見問答 Q&A】', 'Q：是否已有結論？', 'A：目前尚無結論。', '',
  '【口徑外的問題】', '本案目前處理到哪一階段、後續是否有進一步處置，院方尚未對外說明；如有進一步消息，將於官網公告。'
].join('\n');
const STATEMENT = '本案目前處理到哪一階段、後續是否有進一步處置，院方尚未對外說明；如有進一步消息，將於官網公告。';
const DISC = '\n內容僅供參考，以工研院官網新聞稿或發言為準。';
const SENSITIVE_TYPE = '敏感新聞回應說明';

// ═══ 一、prompt 與清單 ═══════════════════════════════════════════════════════
console.log('\n── 一、prompt 與敏感場次清單 ──');
{
  const ev = { name: '測試場', organizer: '工研院', knowledge_base: '【新聞稿】內容', event_date: isoOffset(-1) };
  const web = P.buildSystemPrompt(ev);
  const line = P.buildSystemPrompt(ev, [], { noDataRule: F.LINE_NO_DATA_RULE });
  check('★ 網頁版（不帶參數）：第 2 條逐 byte 是舊的「這部分我沒有資料，建議洽現場新聞聯絡人」', web.includes(P.DEFAULT_NO_DATA_RULE) && web === P.buildSystemPrompt(ev, [], {}) && web.includes('直接說「這部分我沒有資料，建議洽現場新聞聯絡人」'));
  check('★ LINE 版：第 2 條被「換掉」（舊台詞整句不見，不是再加一條去蓋掉它）；模型只寫接住與能說的', !line.includes('這部分我沒有資料，建議洽現場新聞聯絡人') && /你只寫兩件事/.test(line) && /接住/.test(line));
  check('　 規則清單的條數沒變（換一條，不是多一條）', (line.match(/\n- /g) || []).length === (web.match(/\n- /g) || []).length);
  check('　 LINE 版明講：界線與「要不要轉介」由程式附上，模型不要寫「建議洽」「我幫您轉達」「已轉給同仁」「是否幫您轉介」', /界線那一句與「要不要轉介真人」的詢問，由程式在你的回覆後面附上/.test(line) && /不要自己寫「建議洽某某」「我幫您轉達」「已轉給同仁」「是否幫您轉介」/.test(line));
  check('　 企業場照舊用企業版的規則（不吃 LINE 的講法）', P.systemPromptFor({ ...ev, event_type: '企業說明會' }, [], { noDataRule: F.LINE_NO_DATA_RULE }).includes('建議洽活動聯絡窗口'));

  const rules = F.lineExtraRules({ press_contact: '王小明 0912' }).join('\n');
  check('★ [[NO_DATA]] 標記改成「看狀態、不看措辭」，口徑外的關鍵詞固定填「口徑外」', /不管你怎麼措辭/.test(rules) && /關鍵詞固定填「口徑外」/.test(rules) && !/出現「這部分我沒有資料」/.test(rules));
  check('　 語氣規則的最後一句不再教「直接、明確地說沒有」（活動問答用的版本）', !F.TONE_RULE_QA.includes('直接、明確地說沒有') && F.TONE_RULE.includes('直接、明確地說沒有') && rules.includes(F.TONE_RULE_QA));
  check('　 不再把聯絡人電話寫進 prompt 讓模型照抄（聯絡人由程式附）', !rules.includes('王小明 0912'));
  check('NO_DATA_PHRASE_RE 認得新講法（標記沒出現時的第二道網）',
    ['這個我手上的資料還沒寫到。', '目前尚無這部分資料', '院方目前對外的說明就到這裡，我不方便替院方多做解讀。', '這點我不方便替院方回答'].every((t) => N.NO_DATA_PHRASE_RE.test(t)) && !N.NO_DATA_PHRASE_RE.test('活動在南港舉行。'));
}
{
  check('敏感場次是一份明確的清單（聲明稿、敏感新聞回應說明），不是「名稱含某字就算」',
    S.isSensitiveEvent('聲明稿') && S.isSensitiveEvent({ event_type: ` ${SENSITIVE_TYPE} ` }) && !S.isSensitiveEvent('回應說明') && !S.isSensitiveEvent('記者會') && !S.isSensitiveEvent({ name: '關於聲明的記者會' }) && !S.isSensitiveEvent(null));
  check('口徑外固定說法：從知識庫【口徑外的問題】原文取出；沒有、沒寫（只有標題）都是空字串', S.outOfScopeStatement(STMT_KB) === STATEMENT && S.outOfScopeStatement('【新聞稿全文】\n內容') === '' && S.outOfScopeStatement('【口徑外的問題】\n') === '');
  check('預擬問答：【常見問答 Q&A】有寫才算（只有空的「Q：」「A：」不算）', S.hasPreparedQa(STMT_KB) && !S.hasPreparedQa('【常見問答 Q&A】\nQ：\nA：\n') && !S.hasPreparedQa('無'));
}

// ═══ 二、程式接的句子 ═════════════════════════════════════════════════════════
console.log('\n── 二、程式接的句子（朱朱給的原文）與回「是」的判斷 ──');
{
  const T = H.noDataTail;
  check('★ 資料沒寫：「目前尚未有這部分資料，是否幫您轉介公關同仁?」，並記下「問過了」', T({}).text === '目前尚未有這部分資料，是否幫您轉介公關同仁?' && T({}).offered === true);
  check('★ 一般活動的口徑以外：「目前尚無這部分資料，需要我幫您轉介真人嗎」', T({ outOfScope: true }).text === '目前尚無這部分資料，需要我幫您轉介真人嗎' && T({ outOfScope: true }).offered === true);
  check('★ 聲明稿的口徑以外：「這部分我們暫無回應，主要仍以聲明稿內容為主」，不問要不要轉介', T({ sensitive: true, outOfScope: true }).text === '這部分我們暫無回應，主要仍以聲明稿內容為主' && T({ sensitive: true, outOfScope: true }).offered === false);
  check('　 聲明稿的知識庫有【口徑外的問題】：用公關寫的原文', T({ sensitive: true, outOfScope: true, statement: STATEMENT }).text === STATEMENT);
  check('　 聲明稿但問的是「資料沒寫」（不是口徑外）：照一般的詢問轉介', T({ sensitive: true }).text === '目前尚未有這部分資料，是否幫您轉介公關同仁?');
  const esc = T({ escalate: true, contact: '林小華 0912' });
  check('★ 連續追問（升級版）：這幾題都超出範圍，再問也一樣；仍然是「問」要不要轉介（沒有人說過要，不能說已轉給）',
    /^這幾題都超出我能說的範圍，再問我也是一樣的答案，不想耽誤您時間。目前尚未有這部分資料，是否幫您轉介公關同仁\?/.test(esc.text) && /趕稿的話，直接找 林小華 0912 最快/.test(esc.text) && esc.offered && !/已經|已轉|轉給/.test(esc.text), esc.text);
  check('　 聲明稿連續追問口徑外：用預設那一句收尾（短），不再重貼整段', T({ sensitive: true, outOfScope: true, statement: STATEMENT, escalate: true }).text === H.STATEMENT_DEFAULT);
  check('　 群組：提示要打字回「是」；不承諾「會在這裡回您」', /（要的話請回覆「是」）/.test(T({ group: true }).text));

  const C = H.classifyHandoffReply;
  check('★ 整句是「是／好／要／需要／麻煩了／要，請轉介／OK」才算同意（含 @米亞 開頭）', ['是', '好', '好的', '要', '需要', '麻煩了', '要，請轉介', '請轉介', 'OK', '@米亞 是', '是！'].every((x) => C(x) === 'yes'), ['是', '好', '要，請轉介', '@米亞 是'].map(C).join());
  check('　 整句是「不用／不用了／不需要／算了」才算婉拒', ['不用', '不用了', '不需要', '算了', '沒關係'].every((x) => C(x) === 'no'));
  check('★ 夾著別的話的、太長的、一般提問都不攔（照一般提問處理）', ['半導體是什麼', '好的謝謝你今天的說明真的很清楚', '謝謝', '', '什麼時候開始', '是不是明天'].every((x) => C(x) === ''), ['半導體是什麼', '謝謝', '是不是明天'].map(C).join());
  check('回「是」之後的句子：通知成功才說「已經通知公關同仁了」；沒成功老實說，只留聯絡人',
    /^好的，我已經通知公關同仁了，他們看到會直接在這裡回您；趕稿的話，直接打給新聞聯絡人比較快：林 1/.test(H.handoffConfirmText({ forwarded: true, contact: '林 1' })) && !/在這裡回您/.test(H.handoffConfirmText({ forwarded: true, group: true, contact: '林 1' }))
      && /^我這邊暫時沒辦法通知到同仁，趕稿的話/.test(H.handoffConfirmText({ forwarded: false, contact: '林 1' })) && !/已經通知/.test(H.handoffConfirmText({ forwarded: false })));
}

// ═══ 三、LINE 端到端 ══════════════════════════════════════════════════════════
console.log('\n── 三、LINE：一般活動——先問，回「是」才通知 ──');
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
async function grp(gid, uid, text) {
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text, mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } };
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return sent.slice();
}
const replyOf = (out) => out.filter((s) => s.kind === 'text' && !s.push).map((s) => s.text).join('\n---\n');
const chipsOf = (out) => JSON.stringify(out.filter((s) => s.kind === 'text' && !s.push).map((s) => s.quickReply));
const alerts = (re = /答不出來|轉介真人/) => sent.filter((s) => s.push && s.to !== undefined && /^U(admin|owner)$/.test(s.to) && re.test(s.text || ''));
const lastQa = () => state.qaAppended[state.qaAppended.length - 1] || [];
const ev = (id, name, kb, type, contact) =>
  [id, name, '#0F9E7A', kb, 'active', isoOffset(-1), '', '', '', '工研院', 'c-' + id, '10:00', '南港展覽館', type, contact, '', '', ''];
const STMT_NAME = '關於王大明先生資格案的回應說明';
function seed(kb = STMT_KB) {
  reset();
  state.events.push(ev('stmt', STMT_NAME, kb, SENSITIVE_TYPE, '林小華 0912-345-678'));
}
const toStmt = () => ({ intent: 'qa', event_ids: ['stmt'], confidence: 'high' });
const toSemi = () => ({ intent: 'qa', event_ids: ['semi'], confidence: 'high' });
const Q_SEMI = '半導體先進封裝技術發表會有提供停車嗎';
const MARK_BLANK = `了解，您想確認的是停車資訊。\n[[NO_DATA:停車]]${DISC}`;
const MARK_OUT = `了解，您想確認的是後續會不會有進一步處理。\n[[NO_DATA:口徑外]]${DISC}`;
const OFFER_BLANK = '目前尚未有這部分資料，是否幫您轉介公關同仁?';

// ── 3-1 資料沒寫：先問，不推播 ──
seed();
await fresh();
state.answerText = MARK_BLANK;
let out = await dm('U1', Q_SEMI);
let r = replyOf(out);
check('★ 資料沒寫：模型寫接住那句，程式接上「目前尚未有這部分資料，是否幫您轉介公關同仁?」；標記沒外流', r.includes('了解，您想確認的是停車資訊。') && r.includes(OFFER_BLANK) && !/NO_DATA/.test(r), r);
check('★ 這時候還沒通知任何人（先問記者要不要）；也沒有說「已轉給」', alerts().length === 0 && !/已經|已轉|通知公關/.test(r), JSON.stringify(sent.filter((s) => s.push).map((s) => s.to)));
check('★ 純粹答不出來的短回覆不寫警語（朱朱決定省略）', !/僅供參考/.test(r), r);
check('　 1 對 1 多一顆「要，請轉介」按鈕（點下去等於回「是」）', /要，請轉介/.test(chipsOf(out)), chipsOf(out));
check('　 qa_log：answer_status 是 no_data、關鍵詞「停車」', lastQa()[9] === 'no_data' && lastQa()[15] === '停車', JSON.stringify(lastQa().slice(8)));
check('　 這句詢問不進對話歷史（記下的是模型那段話，加上「問過了」的記號）', !/轉介/.test(state.bindings.get('U1')?.lastTurn || '') && /"o":1/.test(state.bindings.get('U1')?.lastTurn || ''), state.bindings.get('U1')?.lastTurn);

// ── 3-2 回「是」→ 通知真人 ──
const qaBefore = state.qaAppended.length;
out = await dm('U1', '要，請轉介');
r = replyOf(out);
check('★ 回「是」→ 管理員真的收到推播：標明「轉介真人」、哪一場、記者原話', alerts().length === 1 && /請米亞轉介真人/.test(alerts()[0].text) && /《半導體先進封裝技術發表會》/.test(alerts()[0].text) && /有提供停車嗎/.test(alerts()[0].text), JSON.stringify(alerts().map((x) => x.text)));
check('★ 通知成功才說「我已經通知公關同仁了，他們看到會直接在這裡回您」，並附新聞聯絡人', /好的，我已經通知公關同仁了，他們看到會直接在這裡回您/.test(r) && /陳大文 03-2222222/.test(r), r);
check('　 這句「是」不算一題：qa_log 沒有多一列（後台「累積回答題數」不灌水）', state.qaAppended.length === qaBefore);
out = await dm('U1', '好');
check('　 同一個詢問只算一次：再回「好」不會重複通知（照一般的收尾語處理）', alerts().length === 0 && !/通知公關同仁/.test(replyOf(out)), replyOf(out));

// ── 3-3 回「不用」→ 不通知 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
await dm('U2', Q_SEMI);
out = await dm('U2', '不用了');
check('★ 回「不用了」→ 一句收尾、不通知', alerts().length === 0 && /有需要再跟我說/.test(replyOf(out)));
out = await dm('U2', '是');
check('　 之後再單獨回「是」：沒有待回覆的詢問，不會誤觸通知', alerts().length === 0 && !/通知公關同仁/.test(replyOf(out)));

// ── 3-4 沒有人問過就回「是」→ 不攔 ──
seed(); await fresh();
out = await dm('U3', '是');
check('★ 沒被問過就單獨回「是」：不通知（照一般訊息處理）', alerts().length === 0 && !/通知公關同仁/.test(replyOf(out)));

// ── 3-5 模型講了別的（問了別題）→ 舊的詢問作廢 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
await dm('U4', Q_SEMI);
state.answerText = '預計 2027 年第一季量產。' + DISC;
await dm('U4', '半導體先進封裝技術發表會什麼時候量產');
out = await dm('U4', '是');
check('　 記者先問了別題、拿到正常答案，再回「是」：舊的詢問已作廢，不通知', alerts().length === 0 && !/通知公關同仁/.test(replyOf(out)));

// ── 3-6 推播失敗：老實說 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
await dm('U5', Q_SEMI);
state.failPushTo = 'Uadmin';
out = await dm('U5', '是');
r = replyOf(out);
check('★ 回「是」但推播給管理員失敗 → 不說「已經通知」，老實說並留聯絡人', !/已經通知/.test(r) && /我這邊暫時沒辦法通知到同仁/.test(r) && /陳大文/.test(r), r);
state.failPushTo = '';

// ── 3-7 上限 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
process.env.NODATA_NOTIFY_PER_DAY = '0';
await dm('U6', Q_SEMI);
out = await dm('U6', '是');
check('★ 全站每天上限用完（這裡設 0）→ 不推播、不說已通知', alerts().length === 0 && !/已經通知/.test(replyOf(out)) && /暫時沒辦法通知到同仁/.test(replyOf(out)), replyOf(out));
delete process.env.NODATA_NOTIFY_PER_DAY;
seed(); await fresh();
state.answerText = MARK_BLANK;
process.env.NODATA_NOTIFY_EVENT_PER_HOUR = '1';
await dm('U7', Q_SEMI); await dm('U7', '是');
await dm('U8', Q_SEMI); out = await dm('U8', '是');
check('★ 每場每小時上限（設 1）：第二個人回「是」也不再推播', alerts().length === 0 && /暫時沒辦法通知到同仁/.test(replyOf(out)));
delete process.env.NODATA_NOTIFY_EVENT_PER_HOUR;

// ── 3-8 活動負責人一併通知 ──
seed();
state.eventOwners = [['semi', 'Uowner', '承辦小花', '2026/11/10', 'line']];
await fresh();
state.answerText = MARK_BLANK;
await dm('U9', Q_SEMI); await dm('U9', '是');
check('　 有活動負責人：管理員與負責人都收到推播', sent.filter((s) => s.push && /轉介真人/.test(s.text || '')).map((s) => s.to).sort().join() === 'Uadmin,Uowner');

// ── 3-9 一般活動的口徑以外 ──
seed(); await fresh();
state.answerText = MARK_OUT;
out = await dm('U10', Q_SEMI);
r = replyOf(out);
check('★ 一般活動的口徑以外（關鍵詞「口徑外」）：「目前尚無這部分資料，需要我幫您轉介真人嗎」', r.includes('目前尚無這部分資料，需要我幫您轉介真人嗎') && !r.includes('暫無回應') && alerts().length === 0, r);

// ── 3-10 沒有標記、只有句型 ──
seed(); await fresh();
state.answerText = `了解，您想確認的是停車資訊。這個我手上的資料還沒寫到。${DISC}`;
out = await dm('U11', Q_SEMI);
check('　 模型忘了加標記，只靠句型也判成 no_data 並接上詢問（第二道網）', lastQa()[9] === 'no_data' && replyOf(out).includes(OFFER_BLANK), JSON.stringify(lastQa().slice(8)));

// ── 3-11 連續追問 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
out = await dm('U12', Q_SEMI);
const first = replyOf(out);
out = await dm('U12', '那有接駁車嗎');
r = replyOf(out);
const secondAnswer = out.find((s) => s.kind === 'answer');
check('★ 連續兩題都答不出來：第二題換成升級版（這幾題都超出範圍……）＋再問一次要不要轉介＋聯絡人', /這幾題都超出我能說的範圍，再問我也是一樣的答案/.test(r) && r.includes(OFFER_BLANK) && /趕稿的話，直接找 陳大文 03-2222222/.test(r), r);
check('　 第二題的 prompt 多一句「上一題已經說明過界線，不要重複同一套話，兩行以內」', /不要重複同一套話，兩行以內/.test(secondAnswer?.sysAll || ''));
check('　 兩題都沒有推播（記者還沒說要）', alerts().length === 0);

// ── 3-12 有實質內容的部分回答：保留警語，詢問在警語前面 ──
seed(); await fresh();
const LONG = '會場在南港展覽館，活動從上午十點開始，現場有三場技術發表，包含先進封裝、異質整合與散熱設計，各場約四十分鐘，之後安排媒體聯訪與展示體驗，現場另備有新聞稿電子檔與簡報資料可供索取，也會有工作人員協助引導動線與採訪登記，若需要提前進場架設器材，請於活動前一天下午三點以前向現場工作人員登記，並攜帶採訪證件與器材清單，以利安檢與動線安排。';
state.answerText = `${LONG}\n停車資訊背景資料沒有提到。\n[[NO_DATA:停車]]${DISC}`;
out = await dm('U13', Q_SEMI);
r = replyOf(out);
check('★ 有實質內容的部分回答：警語保留、仍是全篇最後一行；詢問轉介接在警語前面', r.trim().endsWith('以工研院官網新聞稿或發言為準。') && r.indexOf(OFFER_BLANK) > 0 && r.indexOf(OFFER_BLANK) < r.indexOf('內容僅供參考'), r);

// ── 3-13 群組：發問者各自一份 ──
console.log('\n── 三之二、群組：回「是」的人才算數 ──');
seed(); await fresh();
state.answerText = MARK_BLANK;
state.routeForce = toSemi;
out = await grp('C8', 'Ua', `米亞 ${Q_SEMI}`);
r = replyOf(out);
check('★ 群組：詢問轉介（提示要打字回「是」），沒有按鈕、沒有推播', r.includes(OFFER_BLANK) && /（要的話請回覆「是」）/.test(r) && !/要，請轉介/.test(chipsOf(out)) && alerts().length === 0, r);
out = await grp('C8', 'Ub', '米亞 是');
check('★ 別人（乙）回「是」不算：問的是甲，乙沒有被問過', alerts().length === 0 && !/通知公關同仁/.test(replyOf(out)), replyOf(out));
out = await grp('C8', 'Ua', '米亞 是');
r = replyOf(out);
check('★ 甲回「是」→ 通知（標明在群組裡）；群組的說法不承諾「會在這裡回您」', alerts().length === 1 && /在群組裡/.test(alerts()[0].text) && /我已經通知公關同仁了/.test(r) && !/在這裡回您/.test(r), `${r}\n${JSON.stringify(alerts().map((x) => x.text))}`);
check('　 群組的 qa_log：context_source 以 group/ 開頭，answer_status no_data', /^group\//.test(lastQa()[13]) && lastQa()[9] === 'no_data', JSON.stringify(lastQa().slice(8)));

// ── 3-14 職員試問不接 ──
seed(); await fresh();
state.answerText = MARK_BLANK;
await dm('U_staff', 'openseasame');
out = await dm('U_staff', Q_SEMI);
check('　 職員模式（內部）問到答不出來：不接「是否幫您轉介」、不通知', !replyOf(out).includes('轉介') && alerts().length === 0, replyOf(out));

// ═══ 三之三、聲明稿（敏感場次）═════════════════════════════════════════════════
console.log('\n── 三之三、聲明稿／敏感新聞回應說明 ──');
seed(); await fresh();
state.answerText = MARK_OUT;
state.routeForce = toStmt;
out = await dm('U20', `${STMT_NAME}：所以不會撤銷王大明先生的資格？`);
r = replyOf(out);
check('★ 口徑以外：模型只寫接住，程式原樣接上知識庫【口徑外的問題】；不問要不要轉介、不說已轉告', r.includes('了解，您想確認的是後續會不會有進一步處理。') && r.includes(STATEMENT) && !/轉介|已經通知|轉給/.test(r), r);
check('★ 公關同仁默默收到通知（標明敏感場次、口徑以外）；每一題都通知', alerts().length === 1 && /敏感場次/.test(alerts()[0].text) && /口徑以外/.test(alerts()[0].text), JSON.stringify(alerts().map((x) => x.text)));
check('★ 沒有接官網新聞（敏感場次一律不補查），標記沒外流，也沒有警語', !/官網新聞中心/.test(r) && !/NO_DATA/.test(r) && !/僅供參考/.test(r), r);
check('　 qa_log：answer_status no_data、關鍵詞「口徑外」、kb_source 沒有 news', lastQa()[9] === 'no_data' && lastQa()[15] === '口徑外' && !/news/.test(lastQa()[14]), JSON.stringify(lastQa().slice(8)));
const stmtAnswer = out.find((s) => s.kind === 'answer');
check('　 敏感場次不帶別場資料（system prompt 裡沒有跨場次區塊）', !/相關活動|其他場次的資料/.test(stmtAnswer?.sysAll || '') && !/先進封裝/.test(stmtAnswer?.sysAll || ''), (stmtAnswer?.sysAll || '').slice(-400));
const firstStmt = r;
state.answerText = `這部分剛剛已經說明過了。\n[[NO_DATA:口徑外]]${DISC}`;
out = await dm('U20', '所以還在討論中？');
r = replyOf(out);
check('★ 第二題（連續追問）：比第一題短，用預設那一句「這部分我們暫無回應，主要仍以聲明稿內容為主」，沒有把口徑外整段再貼一次',
  r.length < firstStmt.length && r.includes('這部分我們暫無回應，主要仍以聲明稿內容為主') && !r.includes(STATEMENT) && alerts().length === 1, `${firstStmt.length} → ${r.length}\n${r}`);
check('　 後台「疑似答不出來」數得到這兩題（qa_log 兩列 answer_status 都是 no_data）', state.qaAppended.length === 2 && state.qaAppended.every((q) => q[9] === 'no_data'), JSON.stringify(state.qaAppended.map((q) => q[9])));

seed(STMT_KB.split('\n【口徑外的問題】')[0]); await fresh();
state.answerText = MARK_OUT; state.routeForce = toStmt;
out = await dm('U21', `${STMT_NAME}：後續會怎麼處理？`);
check('　 聲明稿的知識庫沒寫【口徑外的問題】：用預設那一句（公關補上之後就換成他們的原文）', replyOf(out).includes('這部分我們暫無回應，主要仍以聲明稿內容為主'), replyOf(out));

seed(); await fresh();
state.answerText = MARK_BLANK; state.routeForce = toStmt;
out = await dm('U22', `${STMT_NAME}：調查期間是多久？`);
check('　 聲明稿但問的是「資料沒寫」（關鍵詞不是口徑外）：照一般的詢問轉介，公關同仁也默默收到通知', replyOf(out).includes(OFFER_BLANK) && alerts().length === 1);
out = await dm('U22', '是');
check('　 回「是」→ 再通知一次（記者明講要找人，不受「同一個對話只通知一次」限制）', alerts(/轉介真人/).length === 1 && /我已經通知公關同仁了/.test(replyOf(out)), JSON.stringify(alerts(/轉介真人/).map((x) => x.text)));

// ═══ 四、發布前檢查 ═══════════════════════════════════════════════════════════
console.log('\n── 四、發布前檢查：敏感場次 ──');
{
  const row = (kb, contact, type = SENSITIVE_TYPE) => ['x', '測試', '#000', kb, 'draft', isoOffset(2), '', '', '', '工研院', 'c', '10:00', '南港', type, contact, '', '', ''];
  const labels = (items) => items.filter((i) => !i.done).map((i) => i.label).join('|');
  const bare = ES.eventChecklist(row('【新聞稿全文】\n內容', '林小華'), isoOffset(0));
  check('★ 敏感場次沒有預擬問答、沒有口徑外固定句、聯絡人沒有電話 → 三項都提醒（加分項，不擋發布）',
    /預擬問答/.test(labels(bare.bonus)) && /口徑外固定句/.test(labels(bare.bonus)) && /新聞聯絡人電話/.test(labels(bare.bonus)) && bare.missingRequired.indexOf('預擬問答') < 0, labels(bare.bonus));
  const ok = ES.eventChecklist(row(STMT_KB, '林小華 0912-345-678'), isoOffset(0));
  check('　 三樣都有 → 不再提醒', !/預擬問答|口徑外固定句|新聞聯絡人電話/.test(labels(ok.bonus)), labels(ok.bonus));
  const normal = ES.eventChecklist(row('【新聞稿全文】\n內容', '林小華', '記者會'), isoOffset(0));
  check('　 一般記者會完全不受影響（沒有這三項）', !normal.bonus.some((i) => ['prepared_qa', 'out_of_scope', 'contact_phone'].includes(i.key)));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 196、197（答不出來的講法、先問再轉介）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
