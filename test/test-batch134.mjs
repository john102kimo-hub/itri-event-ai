// 批次 134：模型拒答（stop_reason: "refusal"）。
//   一、判斷與記錄：isRefusal／refusalCategory／logRefusal（只認 stop_reason；log 不記內容）
//   二、給使用者的固定句 refusalReply()：中英文、有無聯絡人、過得了出口（繁體轉換、Markdown 清理、版面整理）
//   三、withRefusalFallbacks()／buildSonnetRetryBody()：純函式
//   四、postAnthropic()：伺服器端備援的自癒——參數寫錯時 400 → 記一次 log → 不帶備援重送 → 之後不再帶
//   五、周邊呼叫點：LINE 判斷問題類型（lib/router.js）、LINE 職員判斷意圖（lib/staff.js）、媒體訓練（api/training.js）
//       用攔截的 globalThis.fetch 餵 stop_reason:"refusal" 的回應，跑真的程式
//
// 這支測的是「被攔下的回應不會被當成成功」。沒有 ANTHROPIC_API_KEY、也不打真的 API：
// 伺服器端備援的請求形狀只能對照官方文件（見 lib/ai-refusal.js 的說明），沒有對真的 API 驗證過。
import { register } from 'node:module';
register('./loader-82.mjs', import.meta.url);
// 活動表有 30 秒共用快取（lib/events-table.js），這支一路改假試算表再打 API，關掉快取
process.env.EVENTS_TABLE_TTL_MS = '0';
process.env.ADMIN_PASSWORD = 'pw';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GOOGLE_SPREADSHEET_ID = 'sheet';
delete process.env.AI_REFUSAL_FALLBACKS;
delete process.env.LINE_ADMIN_USER_ID;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 600) : ''}`); }
}

const R = await import('../lib/ai-refusal.js');
const { toTraditionalTW, findResidualSimplified } = await import('../lib/zh-tw.js');
const { stripMarkdownForLine, tidyLineLayout } = await import('../lib/line-format.js');

// 攔下 console，回傳 { value, lines }：lines 是 [層級, 文字]。測試輸出不需要那幾行，也要能檢查「有沒有留 log」。
async function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const rec = (level) => (...a) => { lines.push([level, a.map(String).join(' ')]); };
  console.log = rec('log'); console.warn = rec('warn'); console.error = rec('error');
  try { return { value: await fn(), lines }; }
  finally { Object.assign(console, orig); }
}
const refusalLines = (lines) => lines.filter(([, t]) => t.includes('[ai-refusal]')).map(([, t]) => t);

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REFUSAL = (category = 'cyber', content = []) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content,
  stop_reason: 'refusal', stop_details: category === undefined ? undefined : { type: 'refusal', category },
  usage: { input_tokens: 10, output_tokens: 0 }
});
const OK = (text, stop = 'end_turn') => ({
  id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }],
  stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 }
});

/* ───────── 一、判斷與記錄 ───────── */
console.log('\n── 一、isRefusal／refusalCategory／logRefusal ──');
{
  check('isRefusal：stop_reason 是 "refusal" → true', R.isRefusal({ stop_reason: 'refusal' }) === true);
  check('　 正常結束（end_turn）→ false', R.isRefusal({ stop_reason: 'end_turn' }) === false);
  check('　 被截斷（max_tokens）→ false（不是拒答，是另一回事）', R.isRefusal({ stop_reason: 'max_tokens' }) === false);
  check('　 null／undefined／空物件 → false，不丟例外', R.isRefusal(null) === false && R.isRefusal(undefined) === false && R.isRefusal({}) === false);
  check('★ 只認 stop_reason，不靠 stop_details：有 stop_details 但 stop_reason 不是 refusal → false（官方：stop_details 只是參考）',
    R.isRefusal({ stop_reason: 'end_turn', stop_details: { category: 'cyber' } }) === false);
  check('　 stop_reason 是 refusal 而 stop_details 是 null → 照樣是拒答', R.isRefusal({ stop_reason: 'refusal', stop_details: null }) === true);

  check('refusalCategory：取 stop_details.category', R.refusalCategory({ stop_details: { category: 'bio' } }) === 'bio');
  check('　 stop_details 是 null → null（官方：null 是永久合法的狀態）', R.refusalCategory({ stop_reason: 'refusal', stop_details: null }) === null);
  check('　 沒有 stop_details → null', R.refusalCategory({ stop_reason: 'refusal' }) === null);
  check('　 category 本身是 null → null', R.refusalCategory({ stop_details: { category: null } }) === null);
  check('　 data 是 undefined → null，不丟例外', R.refusalCategory(undefined) === null);

  let r = await capture(() => R.logRefusal('LINE 問答', 'claude-sonnet-5-5', REFUSAL('bio', [{ type: 'text', text: '機密的新聞稿片段 XYZ-SECRET' }]), { eventId: 'ev9' }));
  const l1 = refusalLines(r.lines);
  check('logRefusal：一次呼叫只留一行，走 console.warn', l1.length === 1 && r.lines[0][0] === 'warn', JSON.stringify(r.lines));
  check('　 格式：[ai-refusal] where=… model=… category=… event=…', l1[0] === '[ai-refusal] where=LINE 問答 model=claude-sonnet-5-5 category=bio event=ev9', l1[0]);
  check('★ 不記任何內容：回應文字不會出現在 log 裡', !r.lines.some(([, t]) => t.includes('XYZ-SECRET')), JSON.stringify(r.lines));

  r = await capture(() => R.logRefusal('媒體訓練（reporter）', 'claude-sonnet-5-5', REFUSAL(null)));
  check('　 category 是 null、沒給 eventId → category=null event=-', refusalLines(r.lines)[0]?.endsWith('category=null event=-'), refusalLines(r.lines)[0]);
  r = await capture(() => R.logRefusal('x', 'm', { stop_reason: 'refusal', stop_details: null }));
  check('　 stop_details 整個是 null 也不丟例外', refusalLines(r.lines).length === 1);
  r = await capture(() => R.logRefusal('a\nb', 'm', REFUSAL('cyber'), { eventId: 'e1\nFAKE-LINE category=x' }));
  check('　 where／eventId 裡的換行被壓成空白（不能用換行偽造出第二行 log）', r.lines.length === 1 && !/\n/.test(r.lines[0][1]), JSON.stringify(r.lines));
}

/* ───────── 二、refusalReply ───────── */
console.log('\n── 二、refusalReply：給使用者的固定句 ──');
{
  check('中文有聯絡人：這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：{contact}。',
    R.refusalReply({ contact: '王小明 0912-345-678' }) === '這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：王小明 0912-345-678。', R.refusalReply({ contact: '王小明 0912-345-678' }));
  check('　 沒給參數 → 「建議洽新聞聯絡人」', R.refusalReply() === '這一題我這邊沒辦法回答，建議洽新聞聯絡人。', R.refusalReply());
  check('　 contact 是空白／換行 → 當作沒有', R.refusalReply({ contact: '  \n ' }) === R.refusalReply() && R.refusalReply({ contact: null }) === R.refusalReply());
  check('　 contact 結尾已經有句點／頓號 → 不會變成「。。」', R.refusalReply({ contact: '王小明 02-2345-6789。' }) === '這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：王小明 02-2345-6789。');
  check('　 多行的聯絡人用「、」接成一行（LINE 一句話裡不換行）', R.refusalReply({ contact: '王小明 0912\n李小華 0987' }) === '這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：王小明 0912、李小華 0987。', R.refusalReply({ contact: '王小明 0912\n李小華 0987' }));
  check('　 聯絡人裡的 * ` ~ 被拿掉（不留 Markdown 的符號）', !/[*`~]/.test(R.refusalReply({ contact: '**王小明** `0912`' })), R.refusalReply({ contact: '**王小明** `0912`' }));
  check('　 過長的聯絡人有上限，不會把一整頁塞進回覆', R.refusalReply({ contact: '字'.repeat(500) }).length < 200);

  check('英文有聯絡人', R.refusalReply({ contact: 'Wang 0912-345-678', english: true }) === "I'm unable to answer this one. Please contact the press contact directly: Wang 0912-345-678.", R.refusalReply({ contact: 'Wang 0912-345-678', english: true }));
  check('　 英文沒有聯絡人', R.refusalReply({ english: true }) === "I'm unable to answer this one. Please contact the press contact directly.");
  check('　 英文版沒有中文字', !/[一-鿿]/.test(R.refusalReply({ english: true, contact: 'Wang' })));

  const variants = [
    R.refusalReply(), R.refusalReply({ contact: '王小明 0912-345-678' }), R.refusalReply({ contact: '王小明 02-2345-6789\n李小華 0987-654-321' }),
    R.refusalReply({ english: true }), R.refusalReply({ english: true, contact: 'Wang 0912-345-678' })
  ];
  const changed = await capture(() => variants.filter((v) => toTraditionalTW(v) !== v));
  check('★ 五種寫法都通過 toTraditionalTW()，一個字都不被改動（本身就是台灣繁體）', changed.value.length === 0, JSON.stringify(changed.value));
  check('　 找不到任何簡體字殘留', variants.every((v) => findResidualSimplified(v).length === 0));
  check('　 通過 LINE 出口的 Markdown 清理與版面整理也不變（沒有 Markdown、沒有多餘換行）',
    variants.every((v) => tidyLineLayout(stripMarkdownForLine(v)) === v), JSON.stringify(variants.map((v) => tidyLineLayout(stripMarkdownForLine(v))).filter((v, i) => v !== variants[i])));
  check('★ isRefusalReply() 認得五種寫法的固定句（次要路線的守門靠它辨認「這次沒答成」，見 lib/ai-refusal.js 的說明）', variants.every((v) => R.isRefusalReply(v)), JSON.stringify(variants.filter((v) => !R.isRefusalReply(v))));
  check('　 前後有空白也認得；正常答案、askAnthropic() 的失敗訊息、空值都不誤認',
    R.isRefusalReply(`  ${variants[1]}\n`) && !R.isRefusalReply('四足機器人預計 2027 年量產。') && !R.isRefusalReply('抱歉，目前無法取得回應，請稍後再試。') && !R.isRefusalReply('') && !R.isRefusalReply(null) && !R.isRefusalReply(undefined));
  check('　 句子中間才出現同樣的字不算（避免正常答案裡引用到這句就被誤擋）', !R.isRefusalReply('記者問：這一題我這邊沒辦法回答嗎？'));

  // 批次 134 審查（回歸 F2）：以前只比對開頭（startsWith），模型自己寫出同一個開頭的正常答案會被誤判成拒答——
  // 米亞的人設本來就愛說「我這邊…」。誤判的後果：不補查官網、不接出口檢查提醒、不記進對話歷史，而且 log 看不出來。
  const looksSimilar = [
    '這一題我這邊沒辦法回答，因為新聞稿沒有提到。\n內容僅供參考，以工研院官網新聞稿或發言為準。',
    '這一題我這邊沒辦法回答得很精確，不過新聞稿提到年產能 500 台。',
    '這一題我這邊沒辦法回答，建議洽新聞聯絡人。但新聞稿有提到預計 2027 年量產。',
    "I'm unable to answer this one. Because the press release does not mention it.",
    "I'm unable to answer this one. Please contact the press contact directly. The press release says 500 units.",
    '這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：' + '字'.repeat(300) + '。'
  ];
  check('★ 開頭一樣、但後面是模型自己寫的話（正常答案）→ 不是拒答固定句（整句比對，不是只比開頭）', looksSimilar.every((t) => !R.isRefusalReply(t)), JSON.stringify(looksSimilar.filter((t) => R.isRefusalReply(t))));
  check('　 固定句後面多接任何一段字（企業免責句、官網連結、提醒）就不是「整句」了——所以呼叫端必須在接上那些之前判斷',
    !R.isRefusalReply(R.refusalReply() + '\n\n內容僅供參考，不構成報價或合作承諾。') && !R.isRefusalReply(R.refusalReply({ english: true }) + ' Thanks.'));
  check('　 聯絡人欄位什麼寫法（含冒號、括號、句號、換行）都還是認得；長度上限內的最長聯絡人也認得',
    ['王小明（發言人）：03-1111111', 'a。b、c', '業發處\n林小姐', '字'.repeat(500)].every((c) => R.isRefusalReply(R.refusalReply({ contact: c })) && R.isRefusalReply(R.refusalReply({ contact: c, english: true }))));
}

/* ───────── 二之二、網頁問答的對話歷史：被拒答的那一輪不再帶進下一題（批次 134 審查，回歸 F1）───────── */
console.log('\n── 二之二、dropRefusedTurns／isRefusedTurnText／looksEnglish：純函式 ──');
{
  const J = JSON.stringify;
  const U = (c) => ({ role: 'user', content: c });
  const A = (c) => ({ role: 'assistant', content: c });
  const FIXED = R.refusalReply({ contact: '王小明 03-1111111' });
  const MID = '預計 2027 年第二季\n\n' + R.REFUSAL_MIDWAY_ZH;
  const names = (list) => list.map((m) => m.content);
  check('★ 被拒答的一輪（user 問題＋assistant 固定句）整輪拿掉，其餘原樣、順序不變',
    J(names(R.dropRefusedTurns([U('Q1'), A('A1'), U('Q2'), A(FIXED), U('Q3'), A('A3'), U('Q4')]))) === J(['Q1', 'A1', 'Q3', 'A3', 'Q4']));
  check('★ 輸出到一半被攔下的那一輪（半截答案＋後半段說明）也整輪拿掉；英文說明也是',
    J(names(R.dropRefusedTurns([U('Q1'), A(MID), U('Q2'), A('x\n\n' + R.REFUSAL_MIDWAY_EN), U('Q3')]))) === J(['Q3']));
  check('　 連續好幾輪都被拒答：全部拿掉，最後這一題留著', J(names(R.dropRefusedTurns([U('Q1'), A(FIXED), U('Q2'), A(FIXED), U('Q3')]))) === J(['Q3']));
  check('　 沒有拒答的歷史：內容完全不變（回傳新陣列，不是同一個）', (() => { const h = [U('Q1'), A('A1'), U('Q2')]; const o = R.dropRefusedTurns(h); return J(o) === J(h) && o !== h; })());
  check('★ 最後一則永遠留著：就算最後一則是 assistant 的固定句也不動（不把使用者這一題拿光）',
    J(names(R.dropRefusedTurns([U('Q1'), A(FIXED)]))) === J(['Q1', FIXED]) && J(names(R.dropRefusedTurns([A(FIXED)]))) === J([FIXED]));
  check('　 前面不是 user 的孤兒 assistant 固定句：不亂拿掉前一則 assistant（交給呼叫端「第一則必須是 user」處理）',
    J(names(R.dropRefusedTurns([A('A0'), A(FIXED), U('Q')]))) === J(['A0', FIXED, 'Q']));
  check('　 assistant 內容只是「提到」固定句、或固定句後面還有別的字：不當成被拒答（整句比對）',
    J(names(R.dropRefusedTurns([U('Q1'), A('我剛剛說：' + FIXED), U('Q2'), A(FIXED + ' 但是新聞稿有提到'), U('Q3')]))) === J(['Q1', '我剛剛說：' + FIXED, 'Q2', FIXED + ' 但是新聞稿有提到', 'Q3']));
  check('　 不是陣列／空陣列／含 null 的怪輸入：不丟例外', [null, undefined, 'x', [], [null], [U('Q'), null, A('A')]].every((v) => Array.isArray(R.dropRefusedTurns(v))));
  check('　 isRefusedTurnText：固定句、半截答案＋說明為真；正常答案與空值為假',
    R.isRefusedTurnText(FIXED) && R.isRefusedTurnText(MID) && R.isRefusedTurnText('  ' + MID + '\n') && !R.isRefusedTurnText('年產能 500 台。') && !R.isRefusedTurnText('') && !R.isRefusedTurnText(null)
      && !R.isRefusedTurnText(R.REFUSAL_MIDWAY_ZH + '\n\n後面還有別的字'));

  // 固定句語言：只有縮寫、數字的短問題當中文（台灣記者），夠像一句英文才給英文
  const en = (t) => R.looksEnglish(t);
  check('★ looksEnglish：有中文字 → 中文（false）；英文問句 → 英文（true）',
    !en('產能多少？') && !en('TSMC 的產能多少？') && en('What is the annual capacity?') && en('Is the chip mass produced in 2027?'));
  check('★ 只打縮寫、型號、數字、表情符號的短問題 → 中文（以前「沒有中文字就當英文」會收到整句英文拒答）',
    ['TSMC?', 'HBM4？', '5G', '2026', '👍', 'TSMC 28nm', '？', ''].every((t) => !en(t)), J(['TSMC?', 'HBM4？', '5G', '2026', '👍', 'TSMC 28nm', '？', ''].filter(en)));
  check('　 兩個英文字但夠長（英文字母合計 12 個以上）算英文；日文假名、韓文字 → 外語，給英文版',
    en('TSMC capacity?') && en('こんにちは') && en('안녕하세요'));
  check('　 null／undefined／數字不丟例外', [null, undefined, 42, {}].every((v) => typeof R.looksEnglish(v) === 'boolean'));
}

/* ───────── 三、withRefusalFallbacks／buildSonnetRetryBody ───────── */
console.log('\n── 三、withRefusalFallbacks／buildSonnetRetryBody：純函式 ──');
{
  check('FALLBACK_BETA 是官方文件的 "default" 寫法對應的標頭', R.FALLBACK_BETA === 'server-side-fallback-2026-07-01');
  const headers = { 'x-api-key': 'k' };
  const body = { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  const out = R.withRefusalFallbacks({ headers, body });
  check('body 加 fallbacks:"default"', out.body.fallbacks === 'default' && out.body.model === 'claude-sonnet-5-5' && out.body.max_tokens === 10 && out.body.messages === body.messages);
  check('　 headers 加 anthropic-beta，其餘照舊', out.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && out.headers['x-api-key'] === 'k');
  check('　 不改傳進來的物件', !('fallbacks' in body) && !('anthropic-beta' in headers));
  const merged = R.withRefusalFallbacks({ headers: { 'Anthropic-Beta': 'files-api-2025-04-14' }, body });
  check('　 呼叫端已經有別的 beta → 逗號接在後面，不覆蓋、不留兩個大小寫不同的標頭',
    merged.headers['anthropic-beta'] === 'files-api-2025-04-14,server-side-fallback-2026-07-01' && Object.keys(merged.headers).length === 1, JSON.stringify(merged.headers));
  const twice = R.withRefusalFallbacks(R.withRefusalFallbacks({ headers, body }));
  check('　 套兩次不會重複（冪等）', twice.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01');
  const bare = R.withRefusalFallbacks();
  check('　 不給參數也不丟例外', bare.body.fallbacks === 'default' && bare.headers['anthropic-beta'] === R.FALLBACK_BETA);

  check('supportsServerFallback：Sonnet／Opus 可以，Haiku 不行（官方：Haiku 5.5 沒有伺服器端備援）',
    R.supportsServerFallback('claude-sonnet-5-5') && R.supportsServerFallback('claude-opus-5') && !R.supportsServerFallback('claude-haiku-5-5') && !R.supportsServerFallback('claude-haiku-4-5-20251001'));

  const orig = {
    model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, max_tokens: 4096, stream: true, temperature: 0, top_p: 0.9, top_k: 5, budget_tokens: 1000, fallbacks: 'default',
    system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'Q' }], metadata: { user_id: 'u' }
  };
  const snapshot = JSON.stringify(orig);
  const s = R.buildSonnetRetryBody(orig);
  check('buildSonnetRetryBody：model 換成 claude-sonnet-5-5', s.model === 'claude-sonnet-5-5' && R.SONNET_RETRY_MODEL === 'claude-sonnet-5-5');
  check('　 thinking 是 {type:"between_tools"}，裡面沒有別的欄位（Sonnet 5.5 不收 disabled，between_tools 裡不能有 display／budget_tokens）', JSON.stringify(s.thinking) === '{"type":"between_tools"}', JSON.stringify(s.thinking));
  check('　 stream 是 false', s.stream === false);
  check('　 temperature／top_p／top_k／budget_tokens 都不送（5.5 會 400）', !('temperature' in s) && !('top_p' in s) && !('top_k' in s) && !('budget_tokens' in s));
  check('　 fallbacks 不帶（重答這一發自己不再繞一圈）', !('fallbacks' in s));
  check('　 system、messages、max_tokens 原樣保留，其他欄位也不丟', s.system === orig.system && s.messages === orig.messages && s.max_tokens === 4096 && s.metadata.user_id === 'u');
  check('　 不改傳進來的物件', JSON.stringify(orig) === snapshot);
  const s2 = R.buildSonnetRetryBody({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [] });
  check('　 原本沒有 thinking／stream 也一樣補齊', s2.thinking.type === 'between_tools' && s2.stream === false && s2.model === 'claude-sonnet-5-5');
  check('　 不給參數也不丟例外', R.buildSonnetRetryBody().model === 'claude-sonnet-5-5');
}

/* ───────── 四、postAnthropic ───────── */
console.log('\n── 四、postAnthropic：伺服器端備援與自癒 ──');
const realFetch = globalThis.fetch;
const net = { calls: [], script: [] };
// script 的每一項是 Response／假回應物件／Error；用完就回 200
globalThis.fetch = async (url, opts = {}) => {
  net.calls.push({ url: String(url), method: opts.method, headers: { ...(opts.headers || {}) }, body: opts.body ? JSON.parse(opts.body) : null, signal: opts.signal, hasSignalKey: 'signal' in opts });
  const step = net.script.shift();
  if (step instanceof Error) throw step;
  return step ?? jsonRes(200, OK('ok'));
};
const run = async (script, args) => {
  net.calls.length = 0; net.script = [...script];
  return capture(async () => { try { return { res: await R.postAnthropic(args) }; } catch (e) { return { err: e }; } });
};
const SONNET = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'Q' }] };
const FB_400 = () => jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: Extra inputs are not permitted' } });
// 回應的 body 被讀走時 .json() 會丟例外；測試要紅燈，不要整支當掉
const safeJson = async (res) => { try { return await res.json(); } catch (e) { return { threw: e.message }; } };
const safeText = async (res) => { try { return await res.text(); } catch (e) { return `threw: ${e.message}`; } };
const hasFallbacks = (c) => !!(c.body && 'fallbacks' in c.body) || 'anthropic-beta' in c.headers;

{
  R.resetRefusalFallbacks();
  const ctl = new AbortController();
  let r = await run([jsonRes(200, OK('hi'))], { apiKey: 'K1', body: SONNET, signal: ctl.signal });
  const c = net.calls[0];
  check('fallbacks 沒開：只打一次，POST 到 /v1/messages', net.calls.length === 1 && c.url === 'https://api.anthropic.com/v1/messages' && c.method === 'POST');
  check('　 完全不帶：body 一個字不多、沒有 fallbacks、沒有 anthropic-beta', !hasFallbacks(c) && JSON.stringify(c.body) === JSON.stringify(SONNET), JSON.stringify(c));
  check('　 x-api-key、anthropic-version、Content-Type 都有', c.headers['x-api-key'] === 'K1' && c.headers['anthropic-version'] === '2023-06-01' && c.headers['Content-Type'] === 'application/json');
  check('　 signal 原樣傳給 fetch', c.signal === ctl.signal);
  check('　 回傳的就是 fetch 的 Response：照舊 .ok／.json()', r.value.res.ok === true && (await safeJson(r.value.res)).content?.[0]?.text === 'hi');

  r = await run([], { apiKey: 'K', body: SONNET });
  check('　 沒給 signal 就不傳 signal（不會傳一個 undefined 進去）', net.calls[0].hasSignalKey === false && net.calls[0].signal === undefined);

  r = await run([], { apiKey: 'K', body: JSON.stringify(SONNET), headers: { 'anthropic-beta': 'files-api-2025-04-14' } });
  check('　 body 給 JSON 字串也行；額外的 headers 帶得過去', net.calls[0].body.model === 'claude-sonnet-5-5' && net.calls[0].headers['anthropic-beta'] === 'files-api-2025-04-14');

  r = await run([], { apiKey: 'K', body: SONNET, fallbacks: true, signal: ctl.signal });
  const f = net.calls[0];
  check('fallbacks 開著（Sonnet）：body 有 fallbacks:"default"，headers 有 anthropic-beta', f.body.fallbacks === 'default' && f.headers['anthropic-beta'] === R.FALLBACK_BETA, JSON.stringify(f));
  check('　 其餘不變：model／messages／max_tokens、x-api-key、signal 都還在', f.body.model === SONNET.model && f.body.max_tokens === 100 && f.headers['x-api-key'] === 'K' && f.signal === ctl.signal);
  check('　 呼叫端傳進來的 body 物件沒被改', !('fallbacks' in SONNET));

  r = await run([], { apiKey: 'K', body: { ...SONNET, model: 'claude-haiku-5-5' }, fallbacks: true });
  check('★ Haiku 就算呼叫端要求 fallbacks 也不帶（官方：Haiku 5.5 沒有伺服器端備援）', !hasFallbacks(net.calls[0]), JSON.stringify(net.calls[0]));

  process.env.AI_REFUSAL_FALLBACKS = 'off';
  r = await run([], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('AI_REFUSAL_FALLBACKS=off：一開始就不帶', !hasFallbacks(net.calls[0]) && R.fallbacksEnabled() === false);
  process.env.AI_REFUSAL_FALLBACKS = 'OFF';
  r = await run([], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 大小寫不拘（OFF）', !hasFallbacks(net.calls[0]));
  process.env.AI_REFUSAL_FALLBACKS = 'on';
  r = await run([], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 設成別的值（on）不影響', hasFallbacks(net.calls[0]) && R.fallbacksEnabled() === true);
  delete process.env.AI_REFUSAL_FALLBACKS;
}

// 自癒
{
  R.resetRefusalFallbacks();
  const ctl = new AbortController();
  let r = await run([FB_400(), jsonRes(200, OK('第二次成功'))], { apiKey: 'K', body: SONNET, fallbacks: true, signal: ctl.signal });
  check('★ 自癒：帶備援被 400（訊息提到 fallbacks）→ 不帶備援立刻重送一次，共 2 次', net.calls.length === 2, net.calls.length);
  check('　 第一次有帶、第二次完全不帶（body 沒有 fallbacks、headers 沒有 anthropic-beta）', hasFallbacks(net.calls[0]) && !hasFallbacks(net.calls[1]) && JSON.stringify(net.calls[1].body) === JSON.stringify(SONNET), JSON.stringify(net.calls[1]));
  check('　 重送也帶著 signal 與 x-api-key（死線不會因為重送而丟掉）', net.calls[1].signal === ctl.signal && net.calls[1].headers['x-api-key'] === 'K' && net.calls[1].headers['anthropic-version'] === '2023-06-01');
  check('　 呼叫端拿到的是第二次的回應，照舊 .ok／.json()', r.value.res.ok === true && (await safeJson(r.value.res)).content?.[0]?.text === '第二次成功');
  const logs = refusalLines(r.lines);
  check('　 只記一次 log，而且是 warn，寫得出是哪個訊息、怎麼關', logs.length === 1 && r.lines.find(([, t]) => t.includes('[ai-refusal]'))[0] === 'warn' && /Extra inputs are not permitted/.test(logs[0]) && /AI_REFUSAL_FALLBACKS=off/.test(logs[0]), JSON.stringify(logs));
  check('　 行程內旗標已停用', R.fallbacksEnabled() === false);

  r = await run([], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('★ 之後的呼叫都不再帶備援，也不再重複記 log', net.calls.length === 1 && !hasFallbacks(net.calls[0]) && refusalLines(r.lines).length === 0, JSON.stringify(net.calls));
  R.resetRefusalFallbacks();
  check('　 resetRefusalFallbacks() 之後恢復', R.fallbacksEnabled() === true);

  // 訊息措辭不同也要接得住
  for (const msg of [
    'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.',
    'This beta feature is not enabled for your organization',
    'fallbacks: Input should be a valid list',
    'Unknown parameter: fallbacks',
    'request contains an unsupported field'
  ]) {
    R.resetRefusalFallbacks();
    r = await run([jsonRes(400, { type: 'error', error: { message: msg } }), jsonRes(200, OK('ok'))], { apiKey: 'K', body: SONNET, fallbacks: true });
    check(`　 訊息「${msg.slice(0, 48)}…」也會自癒`, net.calls.length === 2 && !hasFallbacks(net.calls[1]) && R.fallbacksEnabled() === false);
  }

  // 呼叫端自己的別的 beta：重送時要留著
  R.resetRefusalFallbacks();
  r = await run([FB_400(), jsonRes(200, OK('ok'))], { apiKey: 'K', body: SONNET, fallbacks: true, headers: { 'anthropic-beta': 'files-api-2025-04-14' } });
  check('　 重送只拿掉我們加的那個 beta，呼叫端自己開的別的 beta 還在',
    net.calls[0].headers['anthropic-beta'] === 'files-api-2025-04-14,server-side-fallback-2026-07-01' && net.calls[1].headers['anthropic-beta'] === 'files-api-2025-04-14', JSON.stringify(net.calls.map((c) => c.headers['anthropic-beta'])));
  R.resetRefusalFallbacks();

  // 沒有 clone() 的假回應（既有測試常見的 {ok,status,json} 形狀）
  r = await run([
    { ok: false, status: 400, json: async () => ({ error: { message: 'fallbacks: Extra inputs are not permitted' } }) },
    { ok: true, status: 200, json: async () => OK('假回應也行') }
  ], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 沒有 clone() 的假回應也能自癒', net.calls.length === 2 && (await safeJson(r.value.res)).content?.[0]?.text === '假回應也行');
  R.resetRefusalFallbacks();
}

// 不該觸發自癒的狀況
{
  R.resetRefusalFallbacks();
  for (const [status, label] of [[401, '金鑰失效'], [429, '太頻繁'], [500, '伺服器錯誤'], [529, '過載'], [503, '暫時不可用']]) {
    const r = await run([jsonRes(status, { type: 'error', error: { message: 'fallbacks beta unsupported (故意放關鍵字也不能觸發)' } })], { apiKey: 'K', body: SONNET, fallbacks: true });
    check(`★ 非 400（${status} ${label}）不觸發自癒：只打一次、原封不動還給呼叫端、旗標不變`,
      net.calls.length === 1 && r.value.res.status === status && R.fallbacksEnabled() === true && refusalLines(r.lines).length === 0);
  }
  let r = await run([jsonRes(200, OK('ok'))], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 200 不重送', net.calls.length === 1 && r.value.res.status === 200);

  r = await run([jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } })], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('★ 400 但跟備援無關（prompt 太長）：不重送、旗標不變', net.calls.length === 1 && R.fallbacksEnabled() === true && r.value.res.status === 400, net.calls.length);
  const again = await safeJson(r.value.res);
  check('　 而且回應沒被讀走：呼叫端照舊 .json() 拿得到自己的錯誤訊息（它要拿去 reportAiFailure）', /prompt is too long/.test(again.error?.message || ''), JSON.stringify(again));

  r = await run([{ ok: false, status: 400, json: async () => ({ error: { message: 'prompt is too long' } }) }], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 沒有 clone() 的假回應、400 無關備援：讀過之後仍然讀得到同樣內容', net.calls.length === 1 && (await safeJson(r.value.res)).error?.message === 'prompt is too long');

  r = await run([new Response('<html>bad gateway</html>', { status: 400 })], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 400 但內文不是 JSON：不丟例外、不重送、原樣還給', net.calls.length === 1 && r.value.res.status === 400 && (await safeText(r.value.res)).includes('bad gateway'));

  // 不帶備援時的 400 本來就不歸這裡管，連 clone 都不碰
  r = await run([FB_400()], { apiKey: 'K', body: SONNET });
  check('　 沒開 fallbacks 的請求遇到 400：不重送', net.calls.length === 1 && r.value.res.status === 400);

  // 重送還是 400：問題不在備援，旗標要恢復
  r = await run([FB_400(), jsonRes(400, { type: 'error', error: { message: 'prompt is too long' } })], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('★ 重送仍然 400 → 問題不在備援，旗標恢復（不為別人的錯永久關掉備援）', net.calls.length === 2 && R.fallbacksEnabled() === true && r.value.res.status === 400);
  check('　 這種情況留兩行 log（偵測到、以及恢復）', refusalLines(r.lines).length === 2, JSON.stringify(refusalLines(r.lines)));

  // 重送時連線出狀況
  const boom = new TypeError('fetch failed');
  r = await run([FB_400(), boom], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 重送時連線失敗 → 例外照常往外拋（呼叫端的 catch 接），旗標恢復（證明不了是備援的錯）', r.value.err === boom && R.fallbacksEnabled() === true);

  // 第一次就連線失敗 / 逾時：不是這裡的事
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  r = await run([timeout], { apiKey: 'K', body: SONNET, fallbacks: true });
  check('　 第一次就逾時：例外原樣往外拋、不重送', r.value.err === timeout && net.calls.length === 1);
}

/* ───────── 五、周邊呼叫點 ───────── */
console.log('\n── 五、周邊呼叫點：被攔下的回應不會被當成成功 ──');
const { routeIntent } = await import('../lib/router.js');
const { routeStaffIntent } = await import('../lib/staff.js');
let modelBody = null;
const respond = { next: null };
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    modelBody = JSON.parse(opts.body);
    return jsonRes(200, respond.next);
  }
  return realFetch(url, opts);
};

// ── 5-1 lib/router.js ──
{
  const cards = [{ id: 'quad', name: '四足機器人記者會', status: 'active', date: new Date(2026, 9, 20), has_kb: true }];
  const PARTIAL = '{"intent":"qa","event_ids":["quad"],"tech_keyword":"","confidence":"high"}';
  const OTHER = { intent: 'other', event_ids: [], confidence: 'low', tech_keyword: '' };

  respond.next = OK(PARTIAL);
  let r = await capture(() => routeIntent('四足機器人什麼時候量產', cards, { currentEventId: 'quad' }));
  check('（對照組）同樣的內容、stop_reason 是 end_turn → 照常解析成 qa／quad', r.value.intent === 'qa' && r.value.event_ids[0] === 'quad' && r.value.confidence === 'high', JSON.stringify(r.value));
  check('　 沒有 [ai-refusal] 的 log', refusalLines(r.lines).length === 0);

  respond.next = REFUSAL('cyber', []);
  r = await capture(() => routeIntent('四足機器人的資安漏洞', cards, { currentEventId: 'quad' }));
  check('router：拒答（content 是空陣列）→ 走既有退路 { intent:"other" }', JSON.stringify(r.value) === JSON.stringify(OTHER), JSON.stringify(r.value));
  const l = refusalLines(r.lines);
  check('　 留一行 [ai-refusal]：哪一條路、模型、分類、目前綁定的活動', l.length === 1 && l[0] === '[ai-refusal] where=LINE 判斷問題類型 model=claude-haiku-5-5 category=cyber event=quad', JSON.stringify(l));
  check('　 不是走例外：沒有「意圖路由失敗」的 error（以前是空字串解析失敗才掉進 catch）', !r.lines.some(([lv, t]) => lv === 'error' || t.includes('意圖路由失敗')), JSON.stringify(r.lines));

  respond.next = REFUSAL('bio', [{ type: 'text', text: PARTIAL }]);
  r = await capture(() => routeIntent('四足機器人什麼時候量產', cards));
  check('★ 拒答但 content 剛好是一個完整的 JSON（跟上面對照組同一段）→ 仍然是 other，不採用那段內容',
    JSON.stringify(r.value) === JSON.stringify(OTHER), JSON.stringify(r.value));
  check('　 沒有綁定活動時 event=-', refusalLines(r.lines)[0]?.endsWith('category=bio event=-'), refusalLines(r.lines)[0]);

  respond.next = REFUSAL(null, []);
  r = await capture(() => routeIntent('x', cards));
  check('　 stop_details 是 null → category=null，照樣走退路', refusalLines(r.lines)[0]?.includes('category=null') && r.value.intent === 'other', JSON.stringify(r.lines));
  respond.next = { ...REFUSAL('cyber', []), stop_details: undefined };
  r = await capture(() => routeIntent('x', cards));
  check('　 整個沒有 stop_details 欄位也一樣', refusalLines(r.lines).length === 1 && r.value.intent === 'other');
  respond.next = { content: [{ type: 'text', text: PARTIAL }], stop_reason: 'refusal', stop_details: null };
  r = await capture(() => routeIntent('x', cards));
  check('　 沒有 usage 欄位的拒答也不丟例外', r.value.intent === 'other' && refusalLines(r.lines).length === 1);
}

// ── 5-2 lib/staff.js ──
{
  const cards = [{ id: 'med', name: '智慧醫療記者會', status: 'active', date: new Date(2026, 9, 20), has_kb: true }];
  const PARTIAL = '{"intent":"create_event","event_ids":[],"new_event_name":"不該被建立的活動","new_event_date":"","update_field":"","update_value":"","confidence":"high"}';

  respond.next = OK(PARTIAL);
  let r = await capture(() => routeStaffIntent('幫我開一場新活動', cards));
  check('（對照組）同樣的內容、end_turn → 照常解析成 create_event', r.value.intent === 'create_event' && r.value.new_event_name === '不該被建立的活動', JSON.stringify(r.value));

  respond.next = REFUSAL('cyber', []);
  r = await capture(() => routeStaffIntent('幫我看資安漏洞', cards));
  check('staff：拒答（content 是空陣列）→ 退回 other，其餘欄位都是空的', r.value.intent === 'other' && r.value.event_ids.length === 0 && r.value.new_event_name === '' && r.value.update_field === '' && r.value.confidence === 'low', JSON.stringify(r.value));
  const l = refusalLines(r.lines);
  check('　 留一行 [ai-refusal]：LINE 職員判斷意圖、claude-haiku-5-5、cyber', l.length === 1 && l[0] === '[ai-refusal] where=LINE 職員判斷意圖 model=claude-haiku-5-5 category=cyber event=-', JSON.stringify(l));
  check('　 不是走例外（沒有「職員意圖路由失敗」）', !r.lines.some(([lv, t]) => lv === 'error' || t.includes('職員意圖路由失敗')), JSON.stringify(r.lines));

  respond.next = REFUSAL('general_harms', [{ type: 'text', text: PARTIAL }]);
  r = await capture(() => routeStaffIntent('幫我開一場新活動', cards));
  check('★ 拒答但 content 剛好是完整的 create_event JSON → 仍然是 other（create_event 會直接建一場草稿，不能被一半的回應觸發）',
    r.value.intent === 'other' && r.value.new_event_name === '', JSON.stringify(r.value));

  respond.next = REFUSAL(null, []);
  r = await capture(() => routeStaffIntent('x', cards));
  check('　 stop_details 是 null → category=null，照樣退路', refusalLines(r.lines)[0]?.includes('category=null') && r.value.intent === 'other');

  // 按鈕字串走字面比對，根本不呼叫模型，不受影響
  modelBody = null;
  r = await capture(() => routeStaffIntent('新增活動', cards));
  check('　 按鈕字串（不打模型）不受影響', r.value.intent === 'create_event' && modelBody === null);
}

// ── 5-3 api/training.js ──
{
  const { book, reset } = await import('./fakes-sheets82.mjs');
  const { KB_TEMPLATE } = await import('../lib/kb-template.js');
  const training = await import('../api/training.js');
  const REAL = (t) => `【新聞稿全文】\n${t}`;
  const evRow = (id, name, status, date, kb, code = 'cc') => [id, name, '#0F9E7A', kb, status, date, '', '', '', '工研院', code];
  const fakeRes = () => {
    const r = { statusCode: 200, headers: {}, body: undefined };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (o) => { r.body = o; return r; };
    r.end = () => r;
    return r;
  };
  const callTraining = async (body) => {
    const res = fakeRes();
    const cap = await capture(() => training.default({ method: 'POST', headers: {}, query: {}, body: { password: 'pw', messages: [], mode: 'reporter', ...body } }, res));
    return { res, lines: cap.lines };
  };
  reset();
  book.events = [['id'], evRow('bio-ev', '生醫記者會', 'active', '2026-10-20', REAL('新藥研發內容'))];
  book.qa_log = [['timestamp']];

  respond.next = OK('您好，我是經濟日報的王記者。請問何時量產？');
  let { res, lines } = await callTraining({ event_id: 'bio-ev' });
  check('（對照組）正常回應 → 200＋reply，不是拒答', res.statusCode === 200 && /王記者/.test(res.body.reply || '') && refusalLines(lines).length === 0, JSON.stringify(res.body));

  respond.next = REFUSAL('bio', []);
  ({ res, lines } = await callTraining({ event_id: 'bio-ev' }));
  check('training：拒答（content 是空陣列）→ 非 2xx（422）＋中文 error', res.statusCode === 422 && typeof res.body.error === 'string' && /[一-鿿]/.test(res.body.error), JSON.stringify(res.body));
  check('★ 沒有 reply 欄位——訓練頁看到 reply 會把它當成 AI 記者的提問推進對話歷程（以前是 200＋「無法取得回應。」）', !('reply' in res.body), JSON.stringify(res.body));
  check('　 錯誤訊息講得出「再試一次」、「可能是誤判」、「通知管理員」', /再試一次/.test(res.body.error) && /誤判/.test(res.body.error) && /管理員/.test(res.body.error), res.body.error);
  check('　 錯誤訊息裡沒有 API 原文或 stop_reason 這類英文', !/refusal|stop_reason|invalid_request|bio\b/.test(res.body.error), res.body.error);
  check('　 錯誤訊息本身是台灣繁體，通過 toTraditionalTW() 不被改動', toTraditionalTW(res.body.error) === res.body.error && findResidualSimplified(res.body.error).length === 0);
  check('　 friendlyRefusalError() 就是回給前端的那句', training.friendlyRefusalError() === res.body.error);
  const l = refusalLines(lines);
  check('　 留一行 [ai-refusal]：媒體訓練（reporter）、claude-sonnet-5-5、bio、哪一場', l.length === 1 && l[0] === '[ai-refusal] where=媒體訓練（reporter） model=claude-sonnet-5-5 category=bio event=bio-ev', JSON.stringify(l));

  respond.next = REFUSAL('cyber', [{ type: 'text', text: '好的，以下是評分：第一題 8 分，第二題' }]);
  ({ res, lines } = await callTraining({ event_id: 'bio-ev', mode: 'evaluate', messages: [{ role: 'assistant', content: '請問？' }, { role: 'user', content: '答' }] }));
  check('★ evaluate 模式、content 有一半 → 一樣 422，那半句評分不會被送給前端', res.statusCode === 422 && !JSON.stringify(res.body).includes('第一題 8 分') && !('reply' in res.body), JSON.stringify(res.body));
  check('　 log 的 where 帶模式：媒體訓練（evaluate）', refusalLines(lines)[0]?.includes('where=媒體訓練（evaluate）') && refusalLines(lines)[0]?.includes('category=cyber'), refusalLines(lines)[0]);

  respond.next = REFUSAL(null, []);
  ({ res, lines } = await callTraining({ event_id: 'bio-ev' }));
  check('　 stop_details 是 null → category=null，照樣 422', res.statusCode === 422 && refusalLines(lines)[0]?.includes('category=null'));

  respond.next = { ...REFUSAL('bio', []), usage: undefined, stop_details: undefined };
  ({ res, lines } = await callTraining({ event_id: 'bio-ev' }));
  check('　 沒有 usage、沒有 stop_details 的拒答也不丟例外（不會變成 500）', res.statusCode === 422);

  respond.next = OK('被截斷的一半問題', 'max_tokens');
  ({ res, lines } = await callTraining({ event_id: 'bio-ev' }));
  check('（回歸）max_tokens 照舊：200＋reply，並留「被截斷」的 warn（不是拒答，不能被誤擋）',
    res.statusCode === 200 && res.body.reply === '被截斷的一半問題' && lines.some(([, t]) => t.includes('training 回應被截斷')) && refusalLines(lines).length === 0, JSON.stringify([res.statusCode, res.body]));

  respond.next = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).startsWith('https://api.anthropic.com/') ? jsonRes(529, respond.next) : realFetch(url, opts);
  ({ res, lines } = await callTraining({ event_id: 'bio-ev' }));
  globalThis.fetch = savedFetch;
  check('（回歸）HTTP 529 照舊走 friendlyModelError，不是拒答的訊息', res.statusCode === 529 && /比較忙/.test(res.body.error) && refusalLines(lines).length === 0, JSON.stringify(res.body));
}

globalThis.fetch = realFetch;
console.log(`\n${fail ? '❌' : '✅'} 批次 134（拒答處理）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
