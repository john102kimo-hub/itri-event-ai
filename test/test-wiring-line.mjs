// 批次 132／133／134／135 接線：LINE 端（lib/line-runtime.js askAnthropic()、lib/line-reporter.js answerQuestion()、
// lib/line-nodata.js、使用者輸入處的 toTraditionalTW(…, { terms:false })）
//   一、askAnthropic() 的請求：伺服器端備援（fallbacks:"default"＋anthropic-beta 標頭）、備援被退回的自癒、其餘欄位沒變
//   二、askAnthropic() 的拒答（HTTP 200＋stop_reason:"refusal"）：固定句、繁體出口、log、不是 reportAiFailure；備援發生時只取 text
//   三、靠「辨認拒答固定句」的守門：官網補查、兜底引導、產業趨勢的話題記憶
//   四、answerQuestion() 的出口檢查：影子模式逐字不改、on 才附提醒（位置、不進歷史）、標記與企業場不受影響、拒答不補查不寫歷史
//   五、使用者輸入處（卡片、報名、催填、官網清單）只轉字不轉用語，模型輸出路徑照舊轉用語
//   六、test-batch117 的「每一支會呼叫模型的檔案都有記用量」守門：新增一支沒記用量的 postAnthropic() 呼叫會變紅
//
// 跑的是真的 api/line.js 與 lib/*.js；Sheets／LINE 是 test/fakes.mjs 的假版本，Anthropic 由 fakes.mjs 的假模型接手，
// 需要特定回應（拒答、備援、400）的呼叫由下面這支測試自己包一層 fetch 攔截——不改 fakes.mjs。
// 這個環境沒有 ANTHROPIC_API_KEY，沒有真的 API 可以驗：備援請求的形狀只對照官方文件（claude-api 的 model-migration.md）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

register('./loader.mjs', import.meta.url);

process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'key-main';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_ADMIN_USER_ID = 'Uadmin';
delete process.env.ANTHROPIC_API_KEY_BUSINESS;
delete process.env.ANSWER_GROUNDING;
delete process.env.AI_REFUSAL_FALLBACKS;

const F = await import('./fakes.mjs');
const { sent, state, reset, sheets, line } = F;
const fakeFetch = globalThis.fetch;                 // fakes.mjs 裝的假 Anthropic／官網
const { askAnthropic, twFlex } = await import('../lib/line-runtime.js');
const { resetRefusalFallbacks, refusalReply, isRefusalReply, FALLBACK_BETA } = await import('../lib/ai-refusal.js');
const { resetAiAlertThrottle } = await import('../lib/ai-alert.js');
const { ZH_TW_RULE, findResidualSimplified } = await import('../lib/zh-tw.js');
const { formatNewsReply } = await import('../lib/itri-news.js');
const { formatTechReply } = await import('../lib/itri-tech.js');
const { handleRegisterIntent } = await import('../lib/line-register.js');
const { NO_DATA_PHRASE_RE } = await import('../lib/line-nodata.js');
const R = await import('../lib/registration.js');

// ── 檢查工具 ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const out = (s) => process.stdout.write(s + '\n');
function check(label, cond, detail) {
  if (cond) { pass++; out(`✅ ${label}`); }
  else { fail++; out(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 700) : ''}`); }
}
const ROOT = path.join(import.meta.dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const J = (v) => JSON.stringify(v);

// 攔截 console：模型端與出口檢查的 log 都在這裡看，也不讓它們洗版
const logBuf = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logBuf.push(a.map(String).join(' ')); };

// ── 假的 Anthropic（疊在 fakes.mjs 的假模型上）─────────────────────────────────
// plan 是一串規則 { match, res }：第一個符合的非路由呼叫吃掉它；沒有符合的規則就交給 fakes.mjs 的假模型。
// 路由（意圖判斷器、職員助理）永遠交給 fakes.mjs，不會被規則吃掉。
let plan = [];
let calls = [];
const ROUTING = /意圖判斷器|內部職員助理/;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/') && opts.body) {
    const body = JSON.parse(opts.body);
    const sys0 = body.system?.[0]?.text || '';
    const call = { body, raw: opts.body, headers: { ...(opts.headers || {}) }, signal: opts.signal, sys0, sysAll: (body.system || []).map((b) => b?.text || '').join('\n') };
    if (!ROUTING.test(sys0)) {
      const i = plan.findIndex((r) => !r.match || r.match(call));
      if (i !== -1) {
        const [rule] = plan.splice(i, 1);
        calls.push(call);
        return typeof rule.res === 'function' ? rule.res(call) : rule.res;
      }
      calls.push(call); // 沒有規則：交給假模型，但還是記下來（看得到請求長怎樣）
    }
  }
  return fakeFetch(url, opts);
};
const isQa = (c) => c.sys0.includes('【本次活動背景資料】');
const isDigest = (c) => c.sys0.includes('工研院官網新聞中心 搜尋');
const isTrend = (c) => c.sys0.includes('IEK 產業情報網') && c.sys0.includes('來源編號');
const isGuide = (c) => c.sys0.includes('兜底引導員');
const on = (match, res) => ({ match, res });
const any = (res) => ({ match: null, res });

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const msgBody = (text, o = {}) => ({
  id: 'msg_x', type: 'message', role: 'assistant', model: o.model || 'claude-sonnet-5-5',
  content: o.content || (text === null ? [] : [{ type: 'text', text }]),
  stop_reason: o.stop_reason || 'end_turn', stop_details: o.stop_details ?? null,
  usage: { input_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 30 }
});
const okRes = (text, o) => jsonRes(msgBody(text, o));
const refusalRes = (o = {}) => jsonRes(msgBody(o.partial ?? null, {
  stop_reason: 'refusal', model: o.model,
  stop_details: o.details === undefined ? { type: 'refusal', category: o.category === undefined ? 'cyber' : o.category, explanation: '測試' } : o.details
}));
const errRes = (status, type, message) => jsonRes({ type: 'error', error: { type, message } }, status);
const BAD_FALLBACK_MSG = 'fallbacks: Extra inputs are not permitted';

const adminPushes = () => sent.filter((s) => s.push && s.to === 'Uadmin');

// 直接呼叫 askAnthropic()（所有 LINE 問答路線的唯一出口）
async function ask(o = {}) {
  calls = []; logBuf.length = 0; sent.length = 0;
  plan = o.plan ? [...o.plan] : [];
  const reply = await askAnthropic(o.system ?? '系統提示 SP', o.q ?? '請問良率是多少？', o.history ?? [], {
    extraSystem: o.extra ?? '基本資料 EX', business: o.business, contact: o.contact, eventId: o.eventId
  });
  return { reply, calls: [...calls], logs: [...logBuf] };
}

// ── 打 api/line.js ────────────────────────────────────────────────────────
let handler, modSeq = 0;
// ?v=N 讓整個 lib/ 模組圖都重載（活動列、line_users、限流的模組層快取一起清掉，見 test/loader.mjs）
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
async function dm(uid, text, p = []) {
  sent.length = 0; calls = []; logBuf.length = 0; plan = [...p];
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, text } }]), res);
  return { out: sent.slice(), calls: [...calls], logs: [...logBuf] };
}
async function grp(gid, uid, text, p = []) {
  sent.length = 0; calls = []; logBuf.length = 0; plan = [...p];
  const message = { type: 'text', id: 'm' + (++seq), quoteToken: 'q' + seq, text: `@米亞 ${text}`, mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] } };
  await handler(post([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId: gid, userId: uid }, message }]), res);
  return { out: sent.slice(), calls: [...calls], logs: [...logBuf] };
}
const textOf = (r) => r.out.filter((s) => s.kind === 'text').map((s) => s.text).join('\n---\n');
const bind = (uid, eventId = 'semi') => state.bindings.set(uid, { event_id: eventId, media_name: '聯合報', bound_at: Date.now(), note: '' });
const turnOf = (uid) => { try { return JSON.parse(state.bindings.get(uid)?.lastTurn || 'null'); } catch { return null; } };
const setMode = (v) => { if (v === undefined) delete process.env.ANSWER_GROUNDING; else process.env.ANSWER_GROUNDING = v; };
const hasGrounding = (r) => r.logs.some((l) => l.startsWith('[grounding]'));

/* ═════════════════════════ 一、askAnthropic() 的請求：備援與自癒 ═════════════════════════ */
out('\n── 一、askAnthropic() 的請求：伺服器端備援（Sonnet 5.5）──');
resetRefusalFallbacks(); resetAiAlertThrottle(); reset();
{
  const r = await ask({ plan: [any(okRes('良率 92%。'))], history: [{ role: 'user', content: '上一題' }, { role: 'assistant', content: '上一答' }] });
  const c = r.calls[0];
  check('回答照舊回傳（備援參數不影響正常答案）', r.reply === '良率 92%。' && r.calls.length === 1, r.reply);
  check('★ 答題模型是 Sonnet 5.5，body 帶 fallbacks:"default"', c?.body.model === 'claude-sonnet-5-5' && c.body.fallbacks === 'default', J(c?.body.model) + J(c?.body.fallbacks));
  check('★ 標頭帶 anthropic-beta: server-side-fallback-2026-07-01（"default" 純量寫法的那一個，不是陣列寫法的 -06-01）',
    c?.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && c.headers['anthropic-beta'] === FALLBACK_BETA, J(c?.headers));
  check('　 金鑰、API 版本、Content-Type 標頭照舊', c?.headers['x-api-key'] === 'key-main' && c.headers['anthropic-version'] === '2023-06-01' && c.headers['Content-Type'] === 'application/json', J(c?.headers));
  const { fallbacks, ...rest } = c.body;
  check('★ 除了 fallbacks，body 的欄位一個都沒多沒少（thinking:between_tools、max_tokens 4096、system、messages）',
    J(Object.keys(rest)) === J(['model', 'thinking', 'max_tokens', 'system', 'messages']) && J(rest.thinking) === J({ type: 'between_tools' }) && rest.max_tokens === 4096, J(Object.keys(rest)));
  check('　 system 第一塊是「系統提示＋繁體規則＋版面規則」且吃快取；第二塊是 extraSystem、不吃快取',
    rest.system.length === 2 && rest.system[0].text.startsWith('系統提示 SP\n' + ZH_TW_RULE + '\n版面：') && J(rest.system[0].cache_control) === J({ type: 'ephemeral' })
      && rest.system[1].text === '基本資料 EX' && !('cache_control' in rest.system[1]), J(rest.system.map((b) => b.text.slice(0, 30))));
  check('　 messages＝上一輪歷史＋這一題', J(rest.messages) === J([{ role: 'user', content: '上一題' }, { role: 'assistant', content: '上一答' }, { role: 'user', content: '請問良率是多少？' }]), J(rest.messages));
  check('　 死線 signal 原樣傳給 fetch（逾時保護沒掉）', c?.signal instanceof AbortSignal && c.signal.aborted === false);
}
{
  process.env.ANTHROPIC_API_KEY_BUSINESS = 'key-biz';
  const r = await ask({ plan: [any(okRes('企業場答案'))], business: true });
  delete process.env.ANTHROPIC_API_KEY_BUSINESS;
  check('企業場：照舊用業發處那一把金鑰，同樣帶備援', r.calls[0]?.headers['x-api-key'] === 'key-biz' && r.calls[0].body.fallbacks === 'default' && r.calls[0].headers['anthropic-beta'] === FALLBACK_BETA, J(r.calls[0]?.headers));
}
{
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const r = await ask({ plan: [any(okRes('不該被呼叫'))] });
  process.env.ANTHROPIC_API_KEY = saved;
  check('沒有 API 金鑰：回固定句、一次都不打 API', r.calls.length === 0 && /系統目前無法回答/.test(r.reply), r.reply);
}

out('\n── 一之二、備援被 API 以 400 退回：自癒 ──');
{
  resetRefusalFallbacks();
  let r = await ask({ plan: [any(errRes(400, 'invalid_request_error', BAD_FALLBACK_MSG)), any(okRes('不帶備援重送後的答案'))] });
  check('★ 400 的訊息提到 fallbacks → 立刻不帶備援重送一次，記者拿到的是正常答案', r.reply === '不帶備援重送後的答案' && r.calls.length === 2, r.reply + r.calls.length);
  check('　 重送的請求沒有 fallbacks 欄位、沒有 anthropic-beta 標頭，其餘欄位一模一樣',
    !('fallbacks' in r.calls[1].body) && !('anthropic-beta' in r.calls[1].headers)
      && J({ ...r.calls[0].body, fallbacks: undefined }) === J({ ...r.calls[1].body, fallbacks: undefined }), J(r.calls[1]?.headers));
  check('　 記一行 [ai-refusal] log 說明改不帶備援重送；不是金鑰失效，沒有通知管理員',
    r.logs.some((l) => l.startsWith('[ai-refusal] 伺服器端備援被 API 以 400 退回')) && adminPushes().length === 0, J(r.logs.slice(0, 3)));
  r = await ask({ plan: [any(okRes('第二題'))] });
  check('★ 之後的呼叫都不再帶備援（本行程已停用），不會每一題都多吃一次 400', r.calls.length === 1 && !('fallbacks' in r.calls[0].body) && !('anthropic-beta' in r.calls[0].headers), J(r.calls[0]?.headers));
  resetRefusalFallbacks();
  r = await ask({ plan: [any(okRes('重設後'))] });
  check('　 （測試用的 resetRefusalFallbacks 歸零後又會帶備援，證明上一條是旗標造成的）', r.calls[0]?.body.fallbacks === 'default');
}
{
  resetRefusalFallbacks();
  let r = await ask({ plan: [any(errRes(400, 'invalid_request_error', 'messages.0.content: Input should be a valid string'))] });
  check('400 但跟備援無關（訊息沒提到備援／beta／不支援的參數）→ 不重送、原樣走失敗路徑', r.calls.length === 1 && /目前無法取得回應/.test(r.reply), r.reply + r.calls.length);
  r = await ask({ plan: [any(okRes('x'))] });
  check('　 而且不會因此停用備援（下一題照樣帶）', r.calls[0]?.body.fallbacks === 'default');

  r = await ask({ plan: [any(errRes(400, 'invalid_request_error', BAD_FALLBACK_MSG)), any(errRes(400, 'invalid_request_error', 'prompt is too long'))] });
  check('重送後仍是 400（問題不在備援，只是訊息措辭撞到關鍵字）→ 回失敗句，備援旗標恢復', r.calls.length === 2 && /目前無法取得回應/.test(r.reply), r.reply + r.calls.length);
  r = await ask({ plan: [any(okRes('x'))] });
  check('　 恢復之後下一題又帶備援（不為別人的錯永久關掉備援）', r.calls[0]?.body.fallbacks === 'default' && r.calls[0].headers['anthropic-beta'] === FALLBACK_BETA);
}
{
  process.env.AI_REFUSAL_FALLBACKS = 'off';
  const r = await ask({ plan: [any(okRes('x'))] });
  delete process.env.AI_REFUSAL_FALLBACKS;
  check('環境變數 AI_REFUSAL_FALLBACKS=off → 一開始就不帶 fallbacks 與 beta 標頭（連第一次 400 都省）', r.calls.length === 1 && !('fallbacks' in r.calls[0].body) && !('anthropic-beta' in r.calls[0].headers), J(r.calls[0]?.headers));
}
{
  resetAiAlertThrottle(); resetRefusalFallbacks();
  const r = await ask({ plan: [any(errRes(401, 'authentication_error', 'invalid x-api-key'))] });
  check('既有行為不變：401 金鑰失效仍然回失敗句，並通知管理員（金鑰失效的警報沒被拒答處理吃掉）',
    /目前無法取得回應/.test(r.reply) && adminPushes().length === 1 && !r.logs.some((l) => l.startsWith('[ai-refusal] where=')), J([r.reply, sent.map((s) => s.to)]));
  resetAiAlertThrottle();
}

/* ═════════════════════════ 二、askAnthropic() 的拒答 ═════════════════════════ */
out('\n── 二、askAnthropic() 的拒答（HTTP 200＋stop_reason:"refusal"）──');
resetRefusalFallbacks();
{
  const CONTACT = '王小明 03-1111111';
  let r = await ask({ plan: [any(refusalRes())], contact: CONTACT, eventId: 'semi' });
  check('★ 拒答（中文提問、有聯絡人）→ 固定句，一字不差等於 refusalReply()', r.reply === refusalReply({ contact: CONTACT }) && r.reply === '這一題我這邊沒辦法回答，建議直接洽新聞聯絡人：王小明 03-1111111。', r.reply);
  check('　 只打一次 API，不重答（再問一次多半還是被攔）', r.calls.length === 1);
  check('★ 不是 reportAiFailure：沒有通知管理員、沒有「Anthropic API 錯誤」的 error log', adminPushes().length === 0 && !r.logs.some((l) => l.startsWith('Anthropic API 錯誤')), J(r.logs));
  check('★ log 用 [ai-refusal]，記下哪一條路、哪個模型、什麼分類、哪一場', r.logs.includes('[ai-refusal] where=LINE 問答 model=claude-sonnet-5-5 category=cyber event=semi'), J(r.logs));
  check('　 用量照記（被攔下的輸入照樣計費）', r.logs.some((l) => /^\[ai-usage\] LINE 問答 model=claude-sonnet-5-5 in=1200 cache_read=1000/.test(l)), J(r.logs));
  check('　 isRefusalReply() 認得這句（下游幾條守門靠它）', isRefusalReply(r.reply) === true);

  r = await ask({ plan: [any(refusalRes())], q: 'What is the yield rate?', contact: CONTACT });
  check('英文提問 → 英文固定句，聯絡人原樣', r.reply === refusalReply({ contact: CONTACT, english: true }) && r.reply.startsWith("I'm unable to answer this one.") && r.reply.includes(CONTACT), r.reply);
  check('　 英文固定句經過繁體出口也沒被改（撇號、英文字不受影響），下游的 isRefusalReply() 照樣認得', isRefusalReply(r.reply) === true, r.reply);

  r = await ask({ plan: [any(refusalRes())] });
  check('沒有聯絡人（沒傳 contact）→ 「建議洽新聞聯絡人。」，log 的場次是「-」', r.reply === '這一題我這邊沒辦法回答，建議洽新聞聯絡人。' && r.logs.includes('[ai-refusal] where=LINE 問答 model=claude-sonnet-5-5 category=cyber event=-'), r.reply + J(r.logs));

  r = await ask({ plan: [any(refusalRes())], q: 'What is the yield rate?' });
  check('　 英文提問、沒有聯絡人 → 英文版「Please contact the press contact directly.」', r.reply === refusalReply({ english: true }) && r.reply.endsWith('Please contact the press contact directly.'), r.reply);

  r = await ask({ plan: [any(refusalRes())], contact: '張工程師（发言人）03-123 光伏組' });
  check('★ 聯絡人是同仁在後台打的字：簡體字照樣轉繁體（發言人），但「光伏」這種名稱不被用語層改掉（terms:false）',
    r.reply.includes('發言人') && r.reply.includes('光伏') && !r.reply.includes('发') && findResidualSimplified(r.reply).length === 0, r.reply);

  r = await ask({ plan: [any(refusalRes({ partial: '前半段答案：新聞稿裡沒公開的機密數字 777 億', details: null }))], contact: CONTACT, eventId: 'semi' });
  check('拒答時 content 有一半的字、stop_details 是 null → 只回固定句，半句話不外流；category 記成 null',
    r.reply === refusalReply({ contact: CONTACT }) && !r.reply.includes('777') && r.logs.some((l) => /category=null event=semi$/.test(l)), r.reply + J(r.logs));
  check('★ log 不含任何內容：提問原話、聯絡人、模型吐出的半句話都不在 log 裡',
    !r.logs.join('\n').includes('777') && !r.logs.join('\n').includes('請問良率') && !r.logs.join('\n').includes('王小明'), J(r.logs));

  r = await ask({ plan: [any(refusalRes({ category: 'bio' }))], business: true, eventId: 'biz' });
  check('企業場的拒答：log 的 where 標明企業場、分類照記', r.logs.includes('[ai-refusal] where=LINE 問答（企業場） model=claude-sonnet-5-5 category=bio event=biz'), J(r.logs));

  r = await ask({ plan: [any(okRes('答案裡剛好寫到 "stop_reason":"refusal" 這個字串，但那只是文字。'))] });
  check('答案文字裡剛好寫著 stop_reason refusal 不算拒答（只看回應的 stop_reason 欄位）', r.reply.startsWith('答案裡剛好寫到') && !isRefusalReply(r.reply) && !r.logs.some((l) => l.startsWith('[ai-refusal] where=')), r.reply);
}

out('\n── 二之二、備援真的發生時 ──');
{
  const FB = [{ type: 'fallback', model: 'claude-opus-4-8' }, { type: 'text', text: '備援模型回答：良率 92%。' }];
  let r = await ask({ plan: [any(okRes(null, { model: 'claude-opus-4-8', content: FB }))] });
  check('★ 回應的 model 是 claude-opus-4-8、content 多一塊 type:"fallback" → 只取 type:"text" 的區塊，不會出現「undefined」或區塊內容', r.reply === '備援模型回答：良率 92%。', r.reply);
  check('★ 用量用實際回答的那個模型估價（opus-4-8 有價目，看得到 usd≈），不是我們送出去的 Sonnet 5.5',
    r.logs.some((l) => /^\[ai-usage\] LINE 問答 model=claude-opus-4-8 .*usd≈/.test(l)) && !r.logs.some((l) => l.includes('model=claude-sonnet-5-5')), J(r.logs));

  r = await ask({ plan: [any(okRes(null, { content: [{ type: 'thinking', thinking: '內心獨白' }, { type: 'text', text: '前半。' }, { type: 'fallback', model: 'claude-sonnet-5' }, { type: 'text', text: '後半。' }] }))] });
  check('thinking 區塊與 fallback 區塊夾在中間：兩段 text 用換行接起來，其餘不外流', r.reply.includes('前半。') && r.reply.includes('後半。') && !r.reply.includes('內心獨白') && !/fallback/.test(r.reply), r.reply);

  r = await ask({ plan: [any(refusalRes({ model: 'claude-opus-4-8' }))], contact: '王小明' });
  check('備援那一手也被拒（整條鏈都拒）→ 一樣是固定句，log 的模型是實際回答的那個', r.reply === refusalReply({ contact: '王小明' }) && r.logs.some((l) => l.startsWith('[ai-refusal] where=LINE 問答 model=claude-opus-4-8 ')), r.reply + J(r.logs));

  const noModel = msgBody('沒有 model 欄位'); delete noModel.model;
  r = await ask({ plan: [any(jsonRes(noModel))] });
  check('回應沒有 model 欄位（舊版回應）→ 用量用我們送出去的 claude-sonnet-5-5', r.logs.some((l) => l.startsWith('[ai-usage] LINE 問答 model=claude-sonnet-5-5 ')), J(r.logs));
}

/* ═════════════════════════ 三、靠辨認拒答固定句的守門 ═════════════════════════ */
out('\n── 三、官網補查、兜底引導、產業趨勢遇到拒答 ──');
const NODATA_ANSWER = '這部分我沒有資料。\n\n若需更詳細的資訊，建議洽新聞聯絡人。\n[[NO_DATA:院士]]\n\n內容僅供參考，以工研院官網新聞稿或發言為準。';
const REFUSAL_RE = /這一題我這邊沒辦法回答/;
{
  // 對照組：官網補查那一支正常回答 → 「我在工研院官網新聞中心找到了：」
  reset(); await fresh(); bind('U1');
  let r = await dm('U1', '今年院士有誰', [on(isQa, okRes(NODATA_ANSWER)), on(isDigest, okRes('官網新聞中心 10 月 12 日報導，今年有三位院士受證。'))]);
  let t = textOf(r);
  check('（對照）官網補查的摘要正常 → 接在「我在工研院官網新聞中心找到了：」後面', /我在工研院官網新聞中心找到了：\n官網新聞中心 10 月 12 日報導/.test(t) && !REFUSAL_RE.test(t), t.slice(0, 300));

  reset(); await fresh(); bind('U1');
  r = await dm('U1', '今年院士有誰', [on(isQa, okRes(NODATA_ANSWER)), on(isDigest, refusalRes({ category: 'general_harms' }))]);
  t = textOf(r);
  check('★ 官網補查那一支被拒答 → 退回只附連結（不說「找到了：」、也不把拒答固定句接在後面）',
    /工研院官網新聞中心有相關報導，您可以直接看原文/.test(t) && !/找到了：/.test(t) && !REFUSAL_RE.test(t) && /itri-event-ai\.vercel\.app\/n\/\d+/.test(t), t.slice(0, 400));
  check('　 原本那句誠實的「我沒有資料」還在、[[NO_DATA]] 標記沒外流', /這部分我沒有資料/.test(t) && !/NO_DATA/.test(t));
  check('　 補查那一支的拒答有記 [ai-refusal]（where=LINE 問答、場次是「-」），而且沒有通知管理員',
    r.logs.some((l) => /^\[ai-refusal\] where=LINE 問答 model=claude-sonnet-5-5 category=general_harms event=-$/.test(l)) && adminPushes().length === 0, J(r.logs.filter((l) => l.includes('ai-refusal'))));
  check('　 補查退回的原因寫在 log（[line] 補查官網：模型拒答，退回只附連結）', r.logs.some((l) => l.startsWith('[line] 補查官網：模型拒答，退回只附連結')), J(r.logs.filter((l) => l.includes('補查'))));
}
{
  // 兜底引導：四條路都對不上時，模型寫一小段引導
  reset(); await fresh();
  let r = await dm('U_new1', '隨便問一句跟任何主題都不相關的話', [on(isGuide, okRes('這題我這邊查不到耶，要不要從活動或技術找找看？'))]);
  check('（對照）兜底引導正常 → 用模型寫的那一段', /這題我這邊查不到耶/.test(textOf(r)), textOf(r).slice(0, 200));
  reset(); await fresh();
  r = await dm('U_new2', '隨便問一句跟任何主題都不相關的話', [on(isGuide, refusalRes())]);
  const t = textOf(r);
  check('★ 兜底引導被拒答 → 退回固定文案，不把「這一題我這邊沒辦法回答」當引導送給記者', r.calls.some(isGuide) && t.length > 0 && !REFUSAL_RE.test(t) && !/I'm unable/.test(t), t.slice(0, 300));
}
{
  // 產業趨勢：拒答 → 話題記憶的 answer 留空
  const Q = '太空現在有什麼趨勢';
  reset(); await fresh();
  let r = await dm('U_t1', Q, [on(isTrend, okRes('IEK 免費焦點清單提到先進封裝需求持續攀升。\n來源編號：1'))]);
  check('（對照）產業趨勢正常 → 話題標籤與答案節錄都記下來（追問靠節錄接得上）', /^industry_trend@/.test(state.bindings.get('U_t1')?.lastTopic || '') && /先進封裝需求持續攀升/.test(turnOf('U_t1')?.a || ''), J([state.bindings.get('U_t1')]));

  reset(); await fresh();
  r = await dm('U_t2', Q, [on(isTrend, refusalRes())]);
  const t = textOf(r);
  check('★ 產業趨勢被拒答 → 記者看到固定句，後面不掛「🔗 原文連結」（固定句沒有來源編號）', r.calls.some(isTrend) && REFUSAL_RE.test(t) && !/🔗 原文連結/.test(t), t.slice(0, 300));
  const b = state.bindings.get('U_t2') || {};
  check('★ 話題標籤照記（追問仍接得回產業趨勢），但答案節錄是空的——固定句不是「我上一則實際回答的內容」',
    /^industry_trend@/.test(b.lastTopic || '') && (b.lastTurn || '') === '', J(b));
}

/* ═════════════════════════ 四、answerQuestion() ═════════════════════════ */
out('\n── 四、answerQuestion()：答案出口檢查（批次 132）──');
const KB = '【新聞稿】工研院發表先進封裝產線，良率達 92%，預計 2027 年第二季量產，年產能 500 萬片。技術詳見 https://www.itri.org.tw/semi 。';
const W = '內容僅供參考，以工研院官網新聞稿或發言為準。';
const GOOD = `良率達 92%，預計 2027 年第二季量產。\n\n${W}`;
const FAB = `預計 2028 年第二季量產，並投資 800 億元，詳見 https://fake.example.com/semi。\n\n${W}`;
const NOTE_START = '\n\n⚠️ 以上內容有幾處（';
const NOTE_END = '）在新聞稿原文裡查不到，引用前請向新聞聯絡人確認。';
const CONTACT_SEMI = '陳大文 03-2222222 分機5678';
const Q1 = '先進封裝的良率是多少？';
const seedSemi = () => { reset(); state.events.find((r) => r[0] === 'semi')[3] = KB; };
async function answerOnce(model, plan1, { q = Q1, mode } = {}) {
  setMode(mode); seedSemi(); await fresh(); bind('U_q');
  const r = await dm('U_q', q, plan1);
  setMode(undefined);
  return { ...r, text: textOf(r) };
}
{
  const off = await answerOnce(null, [on(isQa, okRes(FAB))], { mode: 'off' });
  const shadow = await answerOnce(null, [on(isQa, okRes(FAB))]);
  const shadow2 = await answerOnce(null, [on(isQa, okRes(FAB))], { mode: 'shadow' });
  const typo = await answerOnce(null, [on(isQa, okRes(FAB))], { mode: 'ON!' });
  check('（前提）關掉出口檢查時，送出去的就是模型的答案本身', off.text === FAB, off.text);
  check('★ 影子模式（ANSWER_GROUNDING 沒設）：回覆逐字等於模型答案，編造的年份、金額、網址都沒被動', shadow.text === FAB && shadow.text === off.text, shadow.text);
  check('★ 影子模式：只記 [grounding] log（where=line、場次、被標出的項目），不記答案全文',
    shadow.logs.some((l) => /^\[grounding\] where=line event=semi numbers=.*2028 年.*800 億元.* urls=\["https:\/\/fake\.example\.com\/semi/.test(l)) && !shadow.logs.some((l) => l.startsWith('[grounding]') && l.includes('並投資')), J(shadow.logs.filter((l) => l.startsWith('[grounding]'))));
  check('　 ANSWER_GROUNDING=shadow 與打錯字（ON!）都當影子模式：逐字不改', shadow2.text === FAB && typo.text === FAB);
  check('　 ANSWER_GROUNDING=off：連 log 都不記', !hasGrounding(off));

  const onr = await answerOnce(null, [on(isQa, okRes(FAB))], { mode: 'on' });
  check('★ ANSWER_GROUNDING=on：提醒接在模型答案後面（空一行），模型答案一個字沒動', onr.text.startsWith(FAB + NOTE_START) && onr.text.endsWith(NOTE_END), onr.text);
  check('　 提醒點名被標出的項目（2028 年、800 億元…）', /2028 年/.test(onr.text) && /800 億元/.test(onr.text), onr.text);
  const good = await answerOnce(null, [on(isQa, okRes(GOOD))], { mode: 'on' });
  check('★ on 模式下正確的答案（數字都在新聞稿裡）不加任何提醒，也沒有 [grounding] log', good.text === GOOD && !hasGrounding(good), good.text);
  const urlOk = await answerOnce(null, [on(isQa, okRes(`詳見 https://www.itri.org.tw/semi 。\n\n${W}`))], { mode: 'on' });
  check('　 答案裡的網址若是新聞稿裡的原網址就不算編造（不加提醒）', urlOk.text === `詳見 https://www.itri.org.tw/semi 。\n\n${W}` && !hasGrounding(urlOk), urlOk.text);
}
{
  // on 模式的提醒：位置（補查結果之前）、不進對話歷史、NO_DATA 標記不受影響
  const NODATA_FAB = `這部分我沒有資料，不過預計 2028 年量產。\n[[NO_DATA:院士]]\n\n${W}`;
  const r = await answerOnce(null, [on(isQa, okRes(NODATA_FAB)), on(isDigest, okRes('官網新聞中心報導今年有三位院士受證。'))], { mode: 'on', q: '今年院士有誰' });
  const t = r.text;
  const iNote = t.indexOf('⚠️ 以上內容有幾處'), iNews = t.indexOf('———');
  check('★ on 模式：提醒在模型答案之後、補查官網的結果之前（答案 → 提醒 → 官網補查）', iNote > t.indexOf(W) && iNews > iNote && iNote > 0, t);
  check('　 [[NO_DATA:…]] 標記照樣切乾淨，而且標記裡的關鍵詞不被拿去檢查（提醒只點名答案正文的 2028 年）',
    !/NO_DATA/.test(t) && /（2028 年）在新聞稿原文裡查不到/.test(t), t);
  check('　 補查官網照樣跑（標記優先）', /我在工研院官網新聞中心找到了：/.test(t) && r.calls.some(isDigest), t.slice(-300));
  const turn = turnOf('U_q');
  check('★ 提醒不進對話歷史：記下的上一輪答案是模型原本的答案（沒有「⚠️ 以上內容」，也沒有補查區塊）',
    !!turn && !/以上內容有幾處|找到了：|———/.test(turn.a) && /預計 2028 年量產/.test(turn.a) && turn.q === '今年院士有誰', J(turn));
}
{
  // 下一題送給模型的 messages：上一輪回放，不含提醒
  setMode('on'); seedSemi(); await fresh(); bind('U_h');
  await dm('U_h', Q1, [on(isQa, okRes(FAB))]);
  const r2 = await dm('U_h', '那量產時間呢？', [on(isQa, okRes(GOOD))]);
  setMode(undefined);
  const msgs = r2.calls.find(isQa)?.body.messages || [];
  check('　 下一題回放的上一輪是「問題＋模型原本的答案」，沒有出口檢查的提醒', msgs.length === 3 && msgs[0].content === Q1 && msgs[1].role === 'assistant' && msgs[1].content.includes('預計 2028 年第二季量產') && !/以上內容有幾處/.test(JSON.stringify(msgs)), J(msgs).slice(0, 400));
}
{
  // shownText 傳的是模型這一次真的看到的字：上一輪的使用者提問算、上一輪模型自己寫的答案不算
  setMode('on'); seedSemi(); await fresh(); bind('U_s');
  await dm('U_s', '2031 年的目標良率是多少？', [on(isQa, okRes(`目前良率 92%。\n\n${W}`))]);
  const asUser = await dm('U_s', '那量產時間呢？', [on(isQa, okRes(`你問的 2031 年之前不會量產。\n\n${W}`))]);
  check('　 上一輪「使用者」提過的數字算模型看過（2031 年不被標出）', !/以上內容有幾處/.test(textOf(asUser)), textOf(asUser));
  const asModel = await dm('U_s', '再說一次', [on(isQa, okRes(`目前良率 92%，上一題我說過 99.9% 的良率。\n\n${W}`))]);
  setMode(undefined);
  check('★ 上一輪「模型自己寫」的答案不算來源（替它洗白）：它那輪編的 99.9% 這輪再說，照樣被標出', /（99\.9%）在新聞稿原文裡查不到/.test(textOf(asModel)) || /99\.9/.test(textOf(asModel).split('以上內容有幾處')[1] || ''), textOf(asModel));
}
{
  // 企業場：有自己的 guardBusinessAnswer()，不做這個檢查
  const BIZ_KB = '【技術說明】產線熱管理模組XJ9：計畫總經費新台幣 3 億元，適用 CNC 與射出成型產線。';
  const bizRow = () => { reset(); state.events.push(['biz', '智慧製造技術說明會', '#0F9E7A', BIZ_KB, 'active', '2026-09-24', '', '', '', '工研院', 'cc', '', '', '企業說明會', '業務窗口 林小姐 03-5912345', '', '', '']); };
  setMode('on'); bizRow(); await fresh(); bind('U_b', 'biz');
  const r = await dm('U_b', '模組的量產時間？', [on(isQa, okRes(`XJ9 預計 2031 年量產，採用 Zeta-9 製程。\n\n${W}`))]);
  setMode(undefined);
  const t = textOf(r);
  check('★ 企業場：不跑答案出口檢查（沒有 [grounding] log、沒有提醒），照舊補企業免責句', !hasGrounding(r) && !/以上內容有幾處/.test(t) && /不構成報價或合作承諾/.test(t) && t.includes('2031 年量產'), t);

  setMode('on'); bizRow(); await fresh(); bind('U_b2', 'biz');
  const r2 = await dm('U_b2', '模組的量產時間？', [on(isQa, refusalRes())]);
  setMode(undefined);
  const t2 = textOf(r2);
  check('★ 企業場被拒答：回的就是帶新聞聯絡人的固定句（業務窗口），一個字都不多——不補企業免責句（網頁版本來就不補，兩邊一致），也不寫歷史',
    t2 === refusalReply({ contact: '業務窗口 林小姐 03-5912345' }) && !/不構成報價或合作承諾/.test(t2) && turnOf('U_b2') === null, t2);

  // 聯絡人欄位若帶金額樣式（「業發處 NT$5000 起」），整句不能被企業場出口換成「牽涉到費用、報價」的封鎖句
  state.events.length = 0; bizRow(); state.events[state.events.length - 1][14] = '業發處 NT$5000 起 03-5912345';
  await fresh(); bind('U_b3', 'biz');
  const r3 = await dm('U_b3', '模組的量產時間？', [on(isQa, refusalRes())]);
  const t3 = textOf(r3);
  check('　 聯絡人字串帶金額樣式：固定句照樣原樣送出，不會被企業場的金額封鎖整句換掉', t3 === refusalReply({ contact: '業發處 NT$5000 起 03-5912345' }) && !/費用、報價/.test(t3), t3);
  // 對照：模型真的答了（沒被拒答）的企業場，免責句照舊要補
  bizRow(); await fresh(); bind('U_b4', 'biz');
  const r4 = await dm('U_b4', '模組的量產時間？', [on(isQa, okRes(`適用 CNC 與射出成型產線。`))]);
  check('　 （對照）企業場沒被拒答時，企業免責句照舊要補', /不構成報價或合作承諾/.test(textOf(r4)), textOf(r4));
}

out('\n── 四之一、批次 134 審查補強：語氣偏好算進來源、英文提醒、提醒過繁體出口、正常答案不被誤判成拒答 ──');
{
  // 同仁教的語氣偏好（bot_memory 的 style）askAnthropic() 會接進 system prompt 送給模型；出口檢查也要把它當成「模型看到的字」，
  // 不然模型照做的署名（含英文名詞與數字）會被當成「新聞稿查不到」，誤報率灌高、on 模式還會對記者亂標。
  const SIGNED = `良率達 92%。\n\n— Mia-2000 助理\n\n${W}`;
  const addStyle = () => state.memories.push(['2026-10-01', 'global', 'style', '語氣：回答結尾固定署名「Mia-2000 助理」', 'Ux', 'on']);

  setMode('on'); seedSemi(); await fresh(); bind('U_m0');
  const without = await dm('U_m0', Q1, [on(isQa, okRes(SIGNED))]);
  check('（對照）沒有這條語氣偏好時，署名裡的 Mia-2000 是模型沒看過的東西，on 模式會被標出——證明下面那題的「沒被標出」不是檢查本身壞了',
    /（.*Mia-2000.*）在新聞稿原文裡查不到/.test(textOf(without)) || /Mia-2000/.test(textOf(without).split('⚠️')[1] || ''), textOf(without));

  seedSemi(); addStyle(); await fresh(); bind('U_m1');
  const withStyle = await dm('U_m1', Q1, [on(isQa, okRes(SIGNED))]);
  setMode(undefined);
  const sentSys = withStyle.calls.find(isQa)?.sysAll || '';
  check('（前提）語氣偏好真的有送給模型（system prompt 裡有「署名」那條）', /Mia-2000 助理/.test(sentSys), sentSys.slice(-300));
  check('★ 語氣偏好算進來源：模型照做的署名 Mia-2000 不被標出（on 模式沒有提醒、沒有 [grounding] log）',
    textOf(withStyle) === SIGNED && !hasGrounding(withStyle), textOf(withStyle));
  check('　 沒有多打 Sheets：記憶是同一份 60 秒快取（answerQuestion 取一次，askAnthropic 讀同一份快取）',
    withStyle.calls.filter(isQa).length === 1);
  // 語氣偏好以外的編造照樣標出（沒有因為多收了來源而放水）
  setMode('on'); seedSemi(); addStyle(); await fresh(); bind('U_m2');
  const stillFlag = await dm('U_m2', Q1, [on(isQa, okRes(`預計 2028 年量產。\n\n— Mia-2000 助理\n\n${W}`))]);
  setMode(undefined);
  const noteLine = textOf(stillFlag).split('⚠️')[1] || '';
  check('　 語氣偏好以外的編造數字（2028 年）照樣被標出，署名不在提醒裡', /2028 年/.test(noteLine) && !/Mia-2000/.test(noteLine), textOf(stillFlag));
  state.memories.length = 0;
}
{
  // 英文答案（記者用英文問）：on 模式附英文版提醒；結尾警語仍是中文也一樣；提醒不進歷史、排在補查結果之前
  const EN_FAB = 'The mass production target is 2028 with an investment of 800 billion NT dollars.';
  setMode('on'); seedSemi(); await fresh(); bind('U_en');
  const r = await dm('U_en', 'When is mass production planned?', [on(isQa, okRes(`${EN_FAB}\n\n${W}`))]);
  const t = textOf(r);
  const note = t.split('\n\n').pop();
  check('★ 英文答案（結尾警語仍是中文）：附的是英文版提醒，沒有中文字、沒有 Markdown，點名編造的 2028',
    /^⚠️ Some items above \(.*2028.*\) could not be found in the press release\. Please confirm with the press contact before citing\.$/.test(note) && !/[一-鿿]/.test(note) && !/[*_`#]/.test(note), t);
  check('　 英文答案本身一個字沒動，提醒接在警語之後', t.startsWith(`${EN_FAB}\n\n${W}\n\n⚠️ Some items above`), t);
  const turn = turnOf('U_en');
  check('　 英文版提醒也不進對話歷史', !!turn && !/Some items above|⚠️/.test(turn.a) && turn.a.includes('2028'), J(turn));
  seedSemi(); await fresh(); bind('U_zh');
  const zh = await dm('U_zh', Q1, [on(isQa, okRes(FAB))]);
  setMode(undefined);
  check('★ （對照）中文答案仍是中文版提醒，一個字沒變', textOf(zh).startsWith(FAB + NOTE_START) && textOf(zh).endsWith(NOTE_END), textOf(zh));
}
{
  // 提醒過繁體出口（跟網頁版同一個承諾）。提醒是固定句加答案片段，沒有辦法從外面餵進簡體，所以這裡是靜態守門 + 變異測試守住
  const lr = src('lib/line-reporter.js');
  check('　 LINE 的提醒（groundingNote）過 toTraditionalTW(…, { terms:false })：只轉字不轉用語，簡體防線連固定句也不留例外',
    /groundingNote = grounding\?\.note \? `\\n\\n\$\{toTraditionalTW\(grounding\.note, \{ terms: false \}\)\}` : ''/.test(lr));
}
{
  // 回歸 F2：模型自己寫出以「這一題我這邊沒辦法回答」開頭的正常答案，不能被當成拒答
  const LOOK = `這一題我這邊沒辦法回答得很精確，不過預計 2028 年量產。\n[[NO_DATA:院士]]\n\n${W}`;
  setMode('on'); seedSemi(); await fresh(); bind('U_lk');
  const r = await dm('U_lk', '今年院士有誰', [on(isQa, okRes(LOOK)), on(isDigest, okRes('官網新聞中心報導今年有三位院士受證。'))]);
  setMode(undefined);
  const t = textOf(r);
  check('★ 正常答案剛好以「這一題我這邊沒辦法回答」開頭：照樣補查官網（標記優先）', /我在工研院官網新聞中心找到了：/.test(t) && r.calls.some(isDigest), t);
  check('★ 　 照樣做答案出口檢查（on 模式標出編造的 2028 年）', /（2028 年）在新聞稿原文裡查不到/.test(t), t);
  const turn = turnOf('U_lk');
  check('★ 　 照樣記進對話歷史（追問才接得上）；而且 log 看得到補查', !!turn && turn.q === '今年院士有誰' && /沒辦法回答得很精確/.test(turn.a) && r.logs.some((l) => l.startsWith('[line] 補查官網')), J(turn));
}
{
  // 規範 F6：固定句的語言——只打縮寫或數字的短問題當中文
  const sys = '系統提示 SP';
  const langs = [];
  for (const [q, english] of [['TSMC?', false], ['HBM4？', false], ['5G', false], ['2026', false], ['TSMC capacity?', true], ['When is mass production planned?', true], ['良率多少？', false]]) {
    const r = await ask({ q, system: sys, plan: [any(refusalRes())], contact: '王小明 03-1111111' });
    if (r.reply !== refusalReply({ contact: '王小明 03-1111111', english })) langs.push(`${q} → ${r.reply}`);
  }
  check('★ askAnthropic 拒答固定句的語言：「TSMC?」「HBM4？」「5G」「2026」收到中文；夠像一句英文的才收到英文', langs.length === 0, langs.join('\n'));
}

out('\n── 四之二、answerQuestion()：拒答（批次 134）──');
{
  // 一輪成功之後被拒答：不補查、不寫歷史、上一輪還在
  setMode('on'); seedSemi(); await fresh(); bind('U_r');
  const first = await dm('U_r', Q1, [on(isQa, okRes(GOOD))]);
  const turnBefore = turnOf('U_r');
  const r = await dm('U_r', '今年院士有誰', [on(isQa, refusalRes({ category: 'bio' })), on(isDigest, okRes('不該被呼叫'))]);
  setMode(undefined);
  const t = textOf(r);
  check('（前提）第一題正常、記下上一輪', first.out.length > 0 && turnBefore?.q === Q1);
  check('★ 拒答 → 記者收到固定句，帶這場的新聞聯絡人（event.press_contact 有傳進 askAnthropic）', t.startsWith(refusalReply({ contact: CONTACT_SEMI })) && t.includes('陳大文 03-2222222'), t);
  check('★ 拒答 → 只有固定句，沒有出口檢查的提醒、沒有官網補查區塊、沒有 NO_DATA', t === refusalReply({ contact: CONTACT_SEMI }), t);
  check('★ 拒答 → 一次官網補查都沒打（模型呼叫只有答題那一次；摘要那支的規則沒被吃掉）', r.calls.filter(isDigest).length === 0 && plan.some((p) => p.match === isDigest) && !r.logs.some((l) => l.startsWith('[line] 補查官網')), J(r.logs.filter((l) => l.includes('補查'))));
  check('　 拒答 → 沒有跑出口檢查（[grounding] 一行都沒有）', !hasGrounding(r));
  check('　 拒答 → [ai-refusal] log 帶場次 semi、分類 bio', r.logs.includes('[ai-refusal] where=LINE 問答 model=claude-sonnet-5-5 category=bio event=semi'), J(r.logs.filter((l) => l.includes('ai-refusal'))));
  check('★ 拒答 → 這一輪不寫進對話歷史：記下的上一輪還是第一題的問答', J(turnOf('U_r')) === J(turnBefore), J(turnOf('U_r')));
  setMode(undefined);
  const r3 = await dm('U_r', '那量產時間呢？', [on(isQa, okRes(GOOD))]);
  const msgs = r3.calls.find(isQa)?.body.messages || [];
  check('★ 被拒的那一題不會回放給下一題：messages 是「第一題的問答＋這一題」，沒有「今年院士有誰」', msgs.length === 3 && msgs[0].content === Q1 && !JSON.stringify(msgs).includes('今年院士有誰') && !JSON.stringify(msgs).includes('沒辦法回答'), J(msgs).slice(0, 400));
}
{
  // 第一題就被拒：沒有歷史可留，更不能寫一筆
  seedSemi(); await fresh(); bind('U_r2');
  const r = await dm('U_r2', Q1, [on(isQa, refusalRes())]);
  check('第一題就被拒答 → line_users 沒有寫任何上一輪記憶', turnOf('U_r2') === null && textOf(r) === refusalReply({ contact: CONTACT_SEMI }), J(state.bindings.get('U_r2')));
}
{
  // 聯絡人欄是同仁自由填的字，剛好寫著「沒有資料」這種句型：固定句會中 NO_DATA_PHRASE_RE，但拒答不是「這場沒有資料」，不能因此去補查官網
  seedSemi(); state.events.find((r) => r[0] === 'semi')[14] = '尚未公布，目前沒有資料';
  await fresh(); bind('U_r3');
  const r = await dm('U_r3', '今年院士有誰', [on(isQa, refusalRes())]);
  const t = textOf(r);
  check('★ 拒答固定句帶到的聯絡人欄寫著「沒有資料」（這句確實會中 NO_DATA_PHRASE_RE）→ 仍然不補查官網、不接「找到了」',
    t === refusalReply({ contact: '尚未公布，目前沒有資料' }) && NO_DATA_PHRASE_RE.test(t) && !r.logs.some((l) => l.startsWith('[line] 補查官網')) && !/工研院官網新聞中心/.test(t), t + J(r.logs.filter((l) => l.includes('補查'))));
}
{
  // 群組：拒答不接全文連結、不寫群組歷史；對照組有全文連結
  seedSemi(); await fresh();
  state.bindings.set('Cg1', { event_id: 'semi', media_name: '', bound_at: Date.now(), note: '' });
  let r = await grp('Cg1', 'U王', '這份新聞稿的全文給我', [on(isQa, okRes(`重點：良率 92%。\n\n${W}`))]);
  check('（對照）群組要全文 → 接上「一對一取得全文」的說明', /完整新聞稿比較長，就不在群組裡整篇貼出來了/.test(textOf(r)), textOf(r).slice(0, 300));
  seedSemi(); await fresh();
  state.bindings.set('Cg2', { event_id: 'semi', media_name: '', bound_at: Date.now(), note: '' });
  r = await grp('Cg2', 'U王', '這份新聞稿的全文給我', [on(isQa, refusalRes())]);
  const t = textOf(r);
  check('★ 群組被拒答：只有固定句，不接全文連結（沒有東西可以給全文）', t === refusalReply({ contact: CONTACT_SEMI }) && !/完整新聞稿比較長/.test(t), t);
  check('　 群組被拒答：不寫發問者的群組歷史（groupTurns 沒有 U王）', !/U王/.test(state.bindings.get('Cg2')?.groupTurns || ''), J(state.bindings.get('Cg2')));
}


{
  // 群組的影子模式：log 的 where 標明是群組，回覆仍逐字不改
  seedSemi(); await fresh();
  state.bindings.set('Cg3', { event_id: 'semi', media_name: '', bound_at: Date.now(), note: '' });
  const r = await grp('Cg3', 'U王', Q1, [on(isQa, okRes(FAB))]);
  check('　 群組的影子模式：log 的 where=line-group、回覆逐字等於模型答案', r.logs.some((l) => l.startsWith('[grounding] where=line-group event=semi ')) && textOf(r) === FAB, textOf(r));
}
{
  // 英文提問被拒答：英文固定句，聯絡人是這場的新聞聯絡人
  seedSemi(); await fresh(); bind('U_en');
  const r = await dm('U_en', 'What is the yield rate of the advanced packaging line?', [on(isQa, refusalRes())]);
  check('英文提問被拒答（整條路）→ 英文固定句＋這場的新聞聯絡人，不補查、不寫歷史', textOf(r) === refusalReply({ contact: CONTACT_SEMI, english: true }) && turnOf('U_en') === null, textOf(r));
}

/* ═════════════════════════ 五、使用者輸入處：只轉字、不轉用語 ═════════════════════════ */
out('\n── 五、使用者輸入處（卡片、報名、催填、官網清單）：簡體字轉繁體，但「光伏」「信息」原樣顯示 ──');
// 同仁在後台打的名稱、官網的原文，不是模型寫的：用語層（光伏→太陽光電、信息→資訊）會把名稱改掉（批次 116 的教訓）
const keeps = (s) => String(s).includes('光伏') && String(s).includes('信息') && !/太陽光電|資訊/.test(s);
const noSimp = (s) => findResidualSimplified(String(s)).length === 0;
// Flex 裡「顯示給人看」的字（text／altText／label）；message action 的 text 是按下去送回來的指令字串，本來就不動
const shown = (node, acc = []) => {
  if (Array.isArray(node)) node.forEach((n) => shown(n, acc));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') { if ((k === 'text' && node.type !== 'message') || k === 'altText' || k === 'label') acc.push(v); }
      else shown(v, acc);
    }
  }
  return acc;
};
{
  const node = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '光伏技术发布会（信息组）' }] },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', action: { type: 'message', label: '问光伏场', text: '光伏技术发布会' } },
      { type: 'button', action: { type: 'uri', label: '开启信息页', uri: 'https://example.com/光伏/发布会' } }
    ] }
  };
  const tw = twFlex({ ...node, altText: '光伏发布会 信息' });
  const body = tw.header.contents[0].text;
  check('★ twFlex 卡片：顯示用的 text 簡體轉繁體（技術、發布會），「光伏」「信息」原樣', body === '光伏技術發布會（信息組）', body);
  check('　 altText 與按鈕 label 一樣只轉字', tw.altText === '光伏發布會 信息' && tw.footer.contents[0].action.label === '問光伏場' && tw.footer.contents[1].action.label === '開啟信息頁', J([tw.altText, tw.footer.contents.map((b) => b.action.label)]));
  check('　 按下去送出的指令字串（message action 的 text）與網址一個字都沒動——改了就是按了沒反應', tw.footer.contents[0].action.text === '光伏技术发布会' && tw.footer.contents[1].action.uri === 'https://example.com/光伏/发布会', J(tw.footer.contents.map((b) => b.action)));
}
{
  // 報名確認：lib/line-register.js（Flex 卡片＋送不出去時的純文字版）
  const regBook = { camp: [], regs: [] };
  const realRead = sheets.readRange;
  sheets.readRange = async (range) => {
    if (range.startsWith('reg_campaigns!A1')) return [R.CAMPAIGN_HEADERS];
    if (range.startsWith('reg_campaigns!')) return regBook.camp.map((r) => [...r]);
    if (range.startsWith('registrations!')) return regBook.regs.map((r) => [...r]);
    return realRead(range);
  };
  regBook.camp = [R.campaignToRow({
    id: 'gf', title: '光伏技术发布会 信息安全场', status: 'open', intro: '', venue: '光伏园区信息大楼',
    sessions_text: 'A1｜2099-10-28｜09:30-12:00｜光伏开幕论坛｜201 廳', options_text: '', privacy: '', contact: '', closes_at: '2099-12-31', line_pitch: '',
    created_at: '2026-09-29T10:00:00+08:00', updated_at: ''
  })];
  regBook.regs = [R.regToRow({
    reg_id: 'RABCDE', campaign_id: 'gf', created_at: '2026-10-01T10:00:00+08:00', updated_at: '2026-10-01T10:00:00+08:00',
    name: '林光伏', outlet: '光伏日报信息组', email: 'lin@example.com', phone: '0912345678', sessions: ['A1'], options: {},
    line_user_id: 'U_reg', edit_token: 'tok_' + 'x'.repeat(20), status: 'active', source: 'web', note: '', bound_at: ''
  })];
  try {
    reset(); sent.length = 0;
    await handleRegisterIntent('rt_reg1', 'U_reg');
    const flexMsg = sent.find((s) => s.kind === 'flex')?.messages?.[0];
    const card = J(flexMsg || {});
    check('★ 報名卡片（Flex）：活動標題、地點、場次名稱的簡體字轉繁體，「光伏」「信息」原樣', !!flexMsg && card.includes('光伏技術發布會 信息安全場') && card.includes('光伏園區信息大樓') && card.includes('光伏開幕論壇') && keeps(card) && noSimp(card), card.slice(0, 500));

    const realMsgs = line.replyOrPushMessages;
    line.replyOrPushMessages = async () => false; // 模擬 Flex 被 LINE 退件，走純文字備援
    try {
      sent.length = 0;
      await handleRegisterIntent('rt_reg2', 'U_reg');
    } finally { line.replyOrPushMessages = realMsgs; }
    const txt = sent.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
    check('★ 報名確認的純文字備援：一樣只轉字——標題與地點的「光伏」「信息」原樣、簡體字轉繁體', txt.includes('光伏技術發布會 信息安全場') && txt.includes('光伏園區信息大樓') && keeps(txt) && noSimp(txt), txt.slice(0, 400));
  } finally { sheets.readRange = realRead; }
}
{
  // 催填訊息與活動卡（職員模式）：活動名稱是同仁打的
  reset(); await fresh();
  const NAME = '光伏技术发布会（信息组）';
  state.events.find((r) => r[0] === 'med')[1] = NAME;
  state.staff.push(['U_staff', '', '2026-08-27', '', '']);
  const card = await dm('U_staff', NAME);
  const cardJson = J(card.out.find((s) => s.kind === 'flex')?.messages || []);
  check('★ 活動卡（Flex，twFlex）：活動名稱簡體字轉繁體，「光伏」「信息」原樣', cardJson.includes('光伏技術發布會（信息組）') && !/太陽光電|（資訊組）/.test(cardJson) && noSimp(shown(card.out.find((s) => s.kind === 'flex')?.messages).join('\n')), cardJson.slice(0, 400));
  const nudge = await dm('U_staff', '催填：' + NAME);
  const n2 = nudge.out.find((s) => s.kind === 'flex')?.messages?.[1]?.text || '';
  check('★ 催填訊息：《活動名稱》簡體字轉繁體、「光伏」「信息」原樣，編輯連結沒被動', n2.includes('《光伏技術發布會（信息組）》') && keeps(n2) && noSimp(n2) && /\/edit\?id=med&code=code3/.test(n2), n2);
}
{
  // 官網清單：標題、導言、聯絡人是官網原文
  const news = formatNewsReply({ items: [{ id: '1', title: '光伏技术突破 信息安全平台', date: '2026/09/07', abstract: '光伏模组转换效率提升，信息传输更稳定。', url: 'https://www.itri.org.tw/n/1' }], total: 1, page: 1, keyword: '光伏信息' });
  check('★ 官網新聞清單：標題、導言簡體字轉繁體，「光伏」「信息」原樣（記者拿標題去搜尋要對得上官網原文）', news.includes('光伏技術突破 信息安全平台') && news.includes('光伏模組轉換效率提升，信息傳輸更穩定') && news.includes('「光伏信息」') && keeps(news) && noSimp(news), news);
  const tech = formatTechReply({ items: [{ id: '1', title: '光伏逆变器信息监控技术', intro: '光伏电站的信息采集。', contactName: '林工程师', email: 'lin＠itri.org.tw', url: 'https://www.itri.org.tw/t/1' }], total: 1, page: 1, label: '綠能' });
  check('★ 官網技術清單：名稱、簡介、聯絡人簡體字轉繁體，「光伏」「信息」原樣', tech.includes('光伏逆變器信息監控技術') && tech.includes('光伏電站的信息採集') && tech.includes('林工程師') && keeps(tech) && noSimp(tech), tech);

  // 從「近期工研院新聞」整條走一遍（抓官網 → 排版 → 出口）
  reset(); await fresh();
  state.itriHtml = `<dl class="Bb_dotted pic_list sline" id="divContent"><dt><img src='x.webp' alt='x'></dt><dd><a href='ListStyle.aspx?DisplayStyle=01_content&SiteID=1&MmmID=1&MGID=115082015023981066' class='title'>光伏技术突破 信息安全平台</a><div class='Lb'><p>日期：2026/09/07</p></div><p>光伏模组转换效率提升，信息传输更稳定。</p></dd></dl>`;
  const r = await dm('U_news', '近期工研院新聞');
  const t = textOf(r);
  check('　 整條路走一遍：「近期工研院新聞」回的清單也是同樣的行為', t.includes('光伏技術突破 信息安全平台') && keeps(t) && noSimp(t), t.slice(0, 300));
}
{
  // 對照：模型輸出那條路仍然轉用語
  resetRefusalFallbacks();
  const r = await ask({ plan: [any(okRes('這個光伏專案的信息安全軟件很强，视频已公開。'))] });
  check('★ 模型輸出（askAnthropic 的出口）仍然轉用語：光伏→太陽光電、信息→資訊、軟件→軟體，簡體字也轉', r.reply === '這個太陽光電專案的資訊安全軟體很強，影片已公開。', r.reply);
  setMode(undefined); seedSemi(); await fresh(); bind('U_m');
  const a = await dm('U_m', Q1, [on(isQa, okRes(`光伏模组的良率達 92%，信息已公開。\n\n${W}`))]);
  const t = textOf(a);
  check('　 活動問答整條路也一樣：回給記者的是「太陽光電」「資訊」「模組」', t.startsWith('太陽光電模組的良率達 92%，資訊已公開。') && !/光伏|信息/.test(t), t);
  check('　 而且被記下的上一輪（對話歷史）也是轉換後的字', /太陽光電模組/.test(turnOf('U_m')?.a || ''), J(turnOf('U_m')));
}

/* ═════════════════════════ 六、test-batch117 的「每一支會呼叫模型的檔案都有記用量」守門 ═════════════════════════ */
out('\n── 六、守門本身：有人新增一支沒記用量的模型呼叫會變紅（含只走 postAnthropic() 的）──');
{
  // 從 test-batch117.mjs 的原始碼取出那一段守門，拿「虛擬的檔案系統」餵它——
  // 測的是那支測試真正的判斷邏輯，不是我們另外抄一份。
  const source = src('test/test-batch117.mjs');
  const start = source.indexOf("const files = ['api', 'lib']");
  const end = source.indexOf('\n}\n', start);
  const block = start === -1 || end === -1 ? '' : source.slice(start, end);
  check('（前提）找得到 test-batch117 的守門區塊（沒被改格式而找不到）', block.includes('postAnthropic') && block.includes('logAiUsage') && block.includes('check('), block.slice(0, 120));

  // 真實的檔案樹當底，再疊上要試的檔案
  const real = {};
  for (const d of ['api', 'lib']) for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith('.js'))) real[`${d}/${f}`] = src(`${d}/${f}`);
  function runGuard(extra = {}, drop = []) {
    const files = { ...real, ...extra };
    for (const k of drop) delete files[k];
    const verdict = [];
    const vfs = { readdirSync: (dir) => Object.keys(files).filter((k) => k.startsWith(path.basename(dir) + '/')).map((k) => k.split('/')[1]) };
    new Function('fs', 'path', 'ROOT', 'src', 'check', block)(vfs, path, '/virtual', (p) => files[p], (label, cond, detail) => verdict.push({ label, cond, detail }));
    return verdict[0] || { cond: null, detail: '守門區塊沒有呼叫 check' };
  }
  const base = runGuard();
  check('（對照）現在的檔案樹：守門是綠的（lib/ai-refusal.js 是通道、被排除）', base.cond === true && /含改走 postAnthropic\(\) 的/.test(base.label), J(base));
  const NEW_CALL = "import { postAnthropic } from './ai-refusal.js';\nexport async function ask(x) { const r = await postAnthropic({ apiKey: 'k', body: x }); return r.json(); }\n";
  let v = runGuard({ 'lib/zz-new-caller.js': NEW_CALL });
  check('★ 新增一支只用 postAnthropic() 呼叫模型、沒記用量的檔案 → 守門變紅，而且點名那個檔案', v.cond === false && /lib\/zz-new-caller\.js/.test(v.detail), J(v));
  v = runGuard({ 'lib/zz-new-caller.js': NEW_CALL + "import { logAiUsage } from './ai-usage.js';\nlogAiUsage('x', 'm', {});\n" });
  check('　 同一支檔案補上 logAiUsage() → 守門回到綠色', v.cond === true, J(v));
  v = runGuard({ 'api/zz-old-style.js': "export default async function h() { return fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }); }\n" });
  check('　 舊的寫法（自己 fetch api.anthropic.com）沒記用量 → 一樣變紅（改寫守門沒把舊的那條弄丟）', v.cond === false && /api\/zz-old-style\.js/.test(v.detail), J(v));
  check('★ lib/line-runtime.js 現在只靠 postAnthropic() 呼叫模型（檔案裡沒有 api.anthropic.com 網址字串）——所以只認網址的舊守門根本看不到它',
    !real['lib/line-runtime.js'].includes('api.anthropic.com') && /\bpostAnthropic\(/.test(real['lib/line-runtime.js']));
  v = runGuard({ 'lib/line-runtime.js': real['lib/line-runtime.js'].replaceAll('logAiUsage(', 'noteUsage(') });
  check('★ 有人把 lib/line-runtime.js 的 logAiUsage() 拿掉 → 守門變紅，點名 lib/line-runtime.js', v.cond === false && /lib\/line-runtime\.js/.test(v.detail), J(v));
}


Object.assign(console, realConsole);
globalThis.fetch = fakeFetch;
out(`\n${fail ? '❌' : '✅'} 批次 132–135 LINE 端接線測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
