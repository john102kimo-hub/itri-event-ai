// 批次 92 的回歸測試：群組續問視窗內，整句只是一串活動名詞（「聯訪時間」「講者名單」「新聞照片」）
// 也要接得住。回報的群組截圖：主管打「聯訪時間」米亞沒反應，改打「米亞 聯訪時間與受訪者」才有。
// 跑真的 api/line.js（Sheets／LINE／Anthropic 用 test/fakes.mjs 的假版本）。
// ⚠️ 路由器是假的（fakes.mjs 的簡化規則）。真的路由器對「聯訪時間」會判什麼要看正式站——所以這裡
// 把 fetch 包一層：記下路由有沒有收到「群組成員彼此也在聊天」那段提示，並且可以強制它回 other，
// 驗的是「呼叫端有沒有把第二道門開好」，不是模型判得準不準。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
const { isEventTopicAsk, isExactMetaAsk } = await import('../lib/menu.js');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';

// ── 包住 fetch：記錄路由呼叫、必要時強制判 other ─────────────────────────────────
const stubFetch = globalThis.fetch;
const routerCalls = [];
let forceOther = false;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    if ((body.system?.[0]?.text || '').includes('意圖判斷器')) {
      const chatter = (body.system || []).some((b) => /群組成員彼此之間也在聊天/.test(b?.text || ''));
      routerCalls.push({ text: body.messages?.[0]?.content, chatter });
      if (forceOther) {
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ intent: 'other', event_ids: [], confidence: 'low' }) }] }) };
      }
    }
  }
  return stubFetch(url, opts);
};

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?b92=${++modSeq}`, import.meta.url).href)).default; routerCalls.length = 0; forceOther = false; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function post(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
let seq = 0;
async function g(gid, uid, text) {
  sent.length = 0;
  await handler(post([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'group', groupId: gid, userId: uid }, message: { type: 'text', id: 'm' + seq, quoteToken: 'q' + seq, text } }]), res);
  return sent.slice();
}
const texts = (out) => out.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
const answered = (out, ev = 'quad') => out.some((o) => o.kind === 'answer' && o.event === ev);
const bindOpen = (id, event = 'quad') => state.bindings.set(id, { event_id: event, media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() + 10 * 60 * 1000 });

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 400) : ''}`); }
}

// ── 一、純函式：什麼算「一串活動名詞」 ────────────────────────────────────────────
console.log('\n── 一、isEventTopicAsk：整句扣完一個字不剩才算 ──');
const TOPIC_YES = [
  '聯訪', '聯訪時間', '聯訪時段', '聯訪時間與受訪者', '媒體聯訪', '受訪者', '受訪名單', '受訪對象', '採訪時間', '訪問時間',
  '活動時間', '活動日期', '活動地點', '記者會時間', '記者會地點', '時間地點', '時間與地點', '集合時間', '報到時間', '開始時間',
  '會場', '場地', '地址', '交通', '停車', '講者', '貴賓', '來賓', '講者名單', '貴賓名單', '出席名單', '主持人',
  '議程', '活動議程', '流程', '活動流程', '節目表', '新聞稿', '完整新聞稿', '新聞照片', '照片', '圖片', '素材', '乾淨帶',
  '背景資料', '懶人包', 'Q&A', '邀請函', '直播', '直播連結', '轉播', '亮點', '技術亮點', '合作廠商', '合作夥伴', '規格', '量產時程',
  '聯絡電話', '報名時間', '報名流程', '報名截止時間', '這場的聯訪時間', '那受訪者', '聯訪時間、受訪者、講者', '聯訪時間。'
];
for (const t of TOPIC_YES) check(`「${t}」→ 算`, isEventTopicAsk(t));

const TOPIC_NO = [
  // 裸的泛稱：同事天天在講，單獨不算
  '時間', '地點', '日期', '名單', '資料', '主題', '窗口', '簡報', '影片', '採訪', '專訪', '半導體',
  // 有動作、有人稱、有內容的一句話——即使含主題詞
  '聯訪時間我已經跟他講了', '受訪者我再確認', '新聞稿我寄給你了', '照片我等等傳', '我們明天聯訪要帶設備',
  '聯訪時間改到下午', '講者名單還沒出來', '直播連結我貼在群組', '記得帶新聞稿', '幫我跟他說聯訪時間',
  // 跟活動名詞無關
  '大家晚上吃什麼', '好的謝謝', '哈哈好喔', '', '   ',
  // 太長
  '聯訪時間與受訪者與講者與貴賓與來賓與主持人與議程與流程'
];
for (const t of TOPIC_NO) check(`「${t}」→ 不算`, !isEventTopicAsk(t));

console.log('\n── 二、isExactMetaAsk：只收整句錨定的固定講法 ──');
for (const t of ['採訪窗口', '聯絡窗口', '邀訪需求', '媒體邀訪需求', '新聞聯絡人', '產業趨勢', '最新趨勢', '工研院技術', '技術查詢', '工研院簡介', '報名', '報名連結', '最近有哪些新聞', '最新新聞']) {
  check(`「${t}」→ 算`, isExactMetaAsk(t));
}
// SWITCH_RE／CALENDAR_RE 是寬鬆的片語比對，這裡不能收（見 lib/menu.js 的說明）
for (const t of ['這邊先換一場再說', '那個案子後面還有活動要辦', '換一場', '說明', '功能', '選單', '我等等把資料寄給你', '新聞', '窗口']) {
  check(`「${t}」→ 不算`, !isExactMetaAsk(t));
}

// ── 三、群組流程：回報的截圖 ─────────────────────────────────────────────────────
console.log('\n── 三、回報的截圖：視窗內、沒 @ 打「聯訪時間」──');
reset(); await fresh();
bindOpen('Cshot');
{
  let out = await g('Cshot', 'U朱', '哪些人可以受訪');
  check('（截圖第一句）有疑問詞的「哪些人可以受訪」照舊回答', answered(out), JSON.stringify(out.map((o) => o.kind)));
  out = await g('Cshot', 'U朱', '聯訪時間');
  check('★ 「聯訪時間」（沒有問號、沒有疑問詞）→ 回答這一場', answered(out), JSON.stringify(out.map((o) => o.kind)));
  // 同一個人的上一題會被回放在前面（批次 83 的群組記憶），所以看最後一則，不是 messages[0]
  const lastMsg = out.find((o) => o.kind === 'answer')?.msgs?.at(-1)?.content;
  check('★ 送去問模型的就是主管打的那個詞', lastMsg === '聯訪時間', lastMsg);
  out = await g('Cshot', 'U朱', '米亞 聯訪時間與受訪者');
  check('（截圖第三句）「米亞 聯訪時間與受訪者」照舊回答', answered(out), JSON.stringify(out.map((o) => o.kind)));
}

// ── 四、第二道門：路由器不能翻案 ─────────────────────────────────────────────────
console.log('\n── 四、守門放行之後，路由不能再把它判成閒聊 ──');
reset(); await fresh();
bindOpen('Cgate');
forceOther = true; // 模擬真的路由器看到「聯訪時間」這種裸名詞拿不準、判 other
{
  const out = await g('Cgate', 'U朱', '聯訪時間');
  check('★ 路由器判 other，一串活動名詞照樣回答（不能因為 other 就安靜）', answered(out), JSON.stringify(out.map((o) => o.kind)));
  const call = routerCalls.find((c) => c.text === '聯訪時間');
  check('★ 送去路由的時候沒有帶「群組成員彼此也在聊天」那段提示（那段提示會叫它拿不準就判 other）', call && call.chatter === false, JSON.stringify(routerCalls));
}
{
  // 對照組：有疑問詞、所以過了守門，但不是活動名詞——這種照舊帶提示、照舊可以被 other 擋下
  reset(); await fresh(); bindOpen('Cgate'); forceOther = true;
  const out = await g('Cgate', 'U李', '那合作廠商有哪些');
  const call = routerCalls.find((c) => c.text === '那合作廠商有哪些');
  check('對照：一般提問照舊帶群組閒聊提示', call && call.chatter === true, JSON.stringify(routerCalls));
  check('對照：一般提問被路由判 other 時照舊安靜（沒有因為這次修改放寬）', out.length === 0, JSON.stringify(out.map((o) => o.kind)));
}
forceOther = false;

// ── 五、界線：這次修改沒有變成新的亂回來源 ───────────────────────────────────────
console.log('\n── 五、界線 ──');
// ⚠️ 每個情境都重新載入模組：api/line.js 對 line_users 有 60 秒的列快取，同一個實例裡事後才
// 寫進假資料的群組讀不到——「視窗過期→安靜」會因為根本讀不到視窗而通過，那是為了錯的理由通過。
for (const chat of ['聯訪時間我已經跟他講了', '受訪者我再確認', '新聞稿我寄給你了', '照片我等等傳', '時間', '地點', '半導體', '大家晚上吃什麼', '這邊先換一場再說']) {
  reset(); await fresh(); bindOpen('Cline');
  const out = await g('Cline', 'U陳', chat);
  check(`視窗內、同事之間的「${chat}」→ 安靜`, out.length === 0, JSON.stringify(out.map((o) => o.kind)));
}
{
  // 視窗外：核心規矩「沒 @、沒叫米亞、不在視窗內 → 完全安靜」沒有被動到
  reset(); await fresh();
  state.bindings.set('Cexp', { event_id: 'quad', media_name: '', note: '', bound_at: Date.now(), groupSessionUntil: Date.now() - 60 * 1000 });
  const out = await g('Cexp', 'U朱', '聯訪時間');
  check('★ 視窗過期後「聯訪時間」→ 照舊安靜（要叫米亞或 @ 才會回）', out.length === 0, JSON.stringify(out.map((o) => o.kind)));
  const out2 = await g('Cexp', 'U朱', '米亞 聯訪時間');
  check('視窗過期後用喚醒詞「米亞 聯訪時間」→ 照樣回答', answered(out2), JSON.stringify(out2.map((o) => o.kind)));
}
{
  // 視窗開著、但這個群組沒綁任何一場：不為了一個名詞反問「您想問哪一場」
  reset(); await fresh();
  state.bindings.set('Cnone', { event_id: '', media_name: '', note: '', bound_at: 0, groupSessionUntil: Date.now() + 10 * 60 * 1000 });
  const out = await g('Cnone', 'U朱', '聯訪時間');
  check('沒有綁定任何一場時「聯訪時間」→ 安靜，不會冒出「您想問哪一場」', out.length === 0, JSON.stringify(out.map((o) => o.kind + ':' + String(o.text || '').slice(0, 20))));
}
{
  // 答完之後視窗續命（跟其他所有有回答的路徑一樣）
  reset(); await fresh(); bindOpen('Cttl');
  const before = state.bindings.get('Cttl').groupSessionUntil;
  await new Promise((r) => setTimeout(r, 5));
  await g('Cttl', 'U朱', '講者名單');
  check('答完之後續問視窗有續命', state.bindings.get('Cttl').groupSessionUntil > before, `${before} → ${state.bindings.get('Cttl').groupSessionUntil}`);
}

// ── 六、整句固定講法：米亞本來就有專屬處理，視窗內也要接得住 ─────────────────────────
console.log('\n── 六、「採訪窗口」「產業趨勢」這種整句固定講法 ──');
{
  reset(); await fresh(); bindOpen('Cmeta');
  let out = await g('Cmeta', 'U朱', '採訪窗口');
  check('★ 「採訪窗口」→ 回窗口聯絡人（不送模型）', out.length > 0 && !out.some((o) => o.kind === 'answer'), JSON.stringify(out.map((o) => o.kind)));
  reset(); await fresh(); bindOpen('Cmeta');
  out = await g('Cmeta', 'U朱', '產業趨勢');
  check('★ 「產業趨勢」→ 有回應', out.length > 0, JSON.stringify(out.map((o) => o.kind)));
  reset(); await fresh(); bindOpen('Cmeta');
  out = await g('Cmeta', 'U朱', '工研院簡介');
  check('★ 「工研院簡介」→ 回機構簡介', /工研院/.test(texts(out)), texts(out));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 92 測試：${pass} 通過，${fail} 失敗`);
if (fail) process.exit(1);
