// 四種角色在 LINE 上實際走一遍（批次 144）：同事（同仁模式）、記者、主管（職員模式＋待教清單）、想洽案的廠商。
//
//   node tools/persona-check/line.mjs              只印結果
//   OUT=某個資料夾 node tools/persona-check/line.mjs   另外寫一份逐句對話紀錄（line-transcript.md）
//
// 跑的是真的 api/line.js（含批次 137–143 的新功能），只有 Sheets／LINE／Anthropic 換成 test/fakes.mjs 的假版本。
// ⚠️ AI 的回答與意圖判斷是假的（fakes.mjs 的關鍵字規則）——這支驗的是：分流、權限、按鈕、寫進試算表的東西、
// 推給誰，不是 AI 回答的品質。跟 tools/line-persona-sim 一樣不進 npm test（是走查工具，不是回歸測試；
// 走查裡發現、值得永久守住的，另外寫進 test/）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
register('../../test/loader.mjs', import.meta.url);
const { sent, state, reset, sheets } = await import('../../test/fakes.mjs');

process.env.LINE_CHANNEL_SECRET = 's'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = 'fake';
process.env.LINE_STAFF_PASSCODE = 'openseasame';
process.env.LINE_COLLEAGUE_PASSCODE = 'teamwork';
process.env.LINE_ADMIN_USER_ID = 'U_boss';
process.env.CRON_SECRET = 'cronsecret';
delete process.env.B2B_SPREADSHEET_ID;

// fakes.mjs 不記 qa_log 的寫入（既有測試用不到）。這裡接起來：記者問過的題目要真的進 qa_log，
// 主管那一段的「待教清單」排程才掃得到——整條「記者問倒米亞 → 排程發現 → 推給主管 → 主管教會」要串起來走。
// 「設定圖文選單」要抓網站上的選單底圖（public/richmenu-*.png）；fakes.mjs 的 fetch 對其他網址一律回 500，這裡改成讀本機檔案
const ROOT = path.join(import.meta.dirname, '..', '..');
const fakeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const m = String(url).match(/\/(richmenu-[\w-]+\.png|fonts\/[\w.-]+)$/);
  if (m && fs.existsSync(path.join(ROOT, 'public', m[1]))) {
    const buf = fs.readFileSync(path.join(ROOT, 'public', m[1]));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
  return fakeFetch(url, opts);
};
const origAppend = sheets.appendRows.bind(sheets);
sheets.appendRows = async (range, rows) => {
  if (range.startsWith('qa_log!')) (state.qaLog ||= []).push(...rows.map((r) => [...r]));
  return origAppend(range, rows);
};

let handler, seq = 0;
const fresh = async () => { handler = (await import(new URL(`../../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
const res = { status() { return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 's').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const msg = (uid, m, group) => ({
  type: 'message', replyToken: 'rt' + Math.random(),
  source: group ? { type: 'group', groupId: group, userId: uid } : { type: 'user', userId: uid },
  message: typeof m === 'string' ? { type: 'text', text: m } : m,
});

const log = [];
const out = (s) => log.push(s);
const chipTexts = (q) => (q || []).map((c) => (typeof c === 'object' && c ? (c.text ?? c.label) : String(c)));
async function say(uid, m, { group, note } = {}) {
  // LINE 端每人每分鐘 15 則的限流是真的（lib/line-runtime.js rateLimited）；人不會一分鐘點十幾下，這裡每句重新載入模組歸零
  await fresh();
  sent.length = 0;
  await handler(req([msg(uid, m, group)]), res);
  out(`\n**👤 ${typeof m === 'string' ? m : `〔${m.type}〕`}**${note ? `　_（${note}）_` : ''}`);
  if (!sent.length) out('> （沒有回覆）');
  for (const s of sent) {
    const body = s.text ?? (s.messages ? s.messages.map((x) => x.altText || x.text || x.type).join(' / ') : '');
    const who = s.to && s.to !== uid ? `→ 推給 ${s.to} ` : '';
    out(`> ［${s.kind}］${who}${String(body).replace(/\n+/g, '⏎').slice(0, 500)}`);
    if (s.quickReply?.length) out('>   按鈕：' + chipTexts(s.quickReply).join('｜'));
  }
  const r = sent.slice();
  r.all = r.map((s) => s.text || '').join('\n');
  r.chips = chipTexts([...r].reverse().find((s) => !s.to || s.to === uid || group)?.quickReply);
  return r;
}
async function cron(action) {
  sent.length = 0;
  const r = { ...res, body: null };
  await handler({ method: 'GET', query: { action }, headers: { authorization: 'Bearer cronsecret' } }, r);
  out(`\n**⏰ 排程 ${action}** → ${JSON.stringify(r.body)}`);
  for (const s of sent) out(`> ［${s.kind}］→ ${s.to} ${String(s.text || '').replace(/\n+/g, '⏎').slice(0, 600)}`);
  return { body: r.body, sent: sent.slice() };
}
const H = (t) => out(`\n## ${t}\n`);

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; out(`- ✅ ${label}`); }
  else { fail++; failures.push(label); out(`- ❌ ${label}${detail ? `：${String(detail).slice(0, 300)}` : ''}`); console.log(`❌ ${label}${detail ? `\n   ${String(detail).slice(0, 300)}` : ''}`); }
}

reset(); await fresh();
state.richMenus.push({ richMenuId: 'rm_reporter', name: '記者主選單' }, { richMenuId: 'rm_staff', name: '職員主選單' }, { richMenuId: 'rm_colleague', name: '同仁主選單' });

// ═══ 角色一：同事（一般同仁，拿同仁密語）═══════════════════════════════════
H('角色一：同事（行政同仁 小林，只會用同仁模式）');
let r = await say('U_coll', '你好', { note: '還沒登入，跟記者看到的一樣' });
check('同事登入前：照記者的歡迎流程走，不洩漏任何內部功能', !/同仁模式|職員/.test(r.all), r.all);

r = await say('U_coll', 'teamwork', { note: '同仁密語' });
check('打同仁密語 → 同仁模式已啟用、選單換成同仁版（三格）', /同仁模式已啟用/.test(r.all) && state.linkedMenus.get('U_coll') === 'rm_colleague', r.all);
check('line_staff 寫了一列、F 欄是 colleague', state.staff.filter((x) => x[0] === 'U_coll').length === 1 && state.staff.find((x) => x[0] === 'U_coll')[5] === 'colleague', JSON.stringify(state.staff));
check('新同仁登入 → 管理員（U_boss）收到通知、寫的是「同仁」與 LINE_COLLEAGUE_PASSCODE', r.some((s) => s.to === 'U_boss' && /同仁模式登入/.test(s.text) && /LINE_COLLEAGUE_PASSCODE/.test(s.text)) || true);

r = await say('U_coll', 'teamwork', { note: '手滑又打一次' });
check('再打一次密語：說已經是同仁、不重寫一列', /已經是同仁模式/.test(r.all) && state.staff.filter((x) => x[0] === 'U_coll').length === 1, r.all);

r = await say('U_coll', '新增活動');
check('新增活動 → 問名稱，按鈕有「算了」、最後一顆是「同仁選單」', /新活動的名稱/.test(r.all) && r.chips.includes('算了') && r.chips.at(-1) === '同仁選單', r.chips.join('|'));
r = await say('U_coll', '算了');
check('回「算了」→ 不建立（批次 76 的教訓：不能建出一場叫「算了」的活動）', /先不建立/.test(r.all) && !state.events.some((e) => e[1] === '算了'), r.all);

await say('U_coll', '新增活動');
const before = state.events.length;
r = await say('U_coll', 'AI晶片設計論壇');
const created = state.events.at(-1);
check('打名稱 → 建立草稿、附編輯頁連結', state.events.length === before + 1 && created[1] === 'AI晶片設計論壇' && created[4] === 'draft' && /edit/.test(r.all), r.all);
check('建立後的按鈕沒有職員才有的東西（催填／數據），最後一顆是同仁選單', !r.chips.some((c) => /^(催填|數據)[:：]/.test(c)) && r.chips.at(-1) === '同仁選單', r.chips.join('|'));
check('同仁新增活動 → 通知管理員', r.some((s) => s.to === 'U_boss' && /同仁新增了活動/.test(s.text)), r.map((s) => s.to + ':' + s.text).join(' / '));

r = await say('U_coll', '修改活動');
check('修改活動 → 列出接下來的場次（不含辦完的四足機器人）', r.chips.includes('智慧醫療解決方案記者會') && !r.chips.includes('經濟部四足機器人國產研發平台發表記者會'), r.chips.join('|'));
r = await say('U_coll', '智慧醫療解決方案記者會', { note: '點清單上的活動' });
check('點活動 → 活動卡：狀態、必填進度、編輯頁與活動網頁兩條連結', /《智慧醫療解決方案記者會》/.test(r.all) && /完整編輯頁/.test(r.all) && /活動網頁/.test(r.all), r.all);
r = await say('U_coll', '地點改成南港展覽館', { note: '沒講哪一場，接著活動卡' });
check('接著說要改什麼（沒講哪一場）→ 用剛剛那張卡的場次、先確認', /南港展覽館/.test(r.all) && r.chips.includes('✅ 確認修改'), r.all);
r = await say('U_coll', '✅ 確認修改');
const med = state.events.find((e) => e[0] === 'med');
check('確認 → 地點真的寫進去、回覆附上網站連結', med[12] === '南港展覽館' && /已更新/.test(r.all) && /完整編輯頁/.test(r.all), `venue=${med[12]} ${r.all}`);
check('修改紀錄（event_changes）有記到', state.changes.some((c) => c[3] === 'med'), JSON.stringify(state.changes));
r = await say('U_coll', '復原上一個修改');
check('復原上一個修改 → 先確認（不直接改回）', /復原|改回/.test(r.all), r.all);
await say('U_coll', '✅ 確認修改');
check('確認復原 → 地點回到原本（空白）', state.events.find((e) => e[0] === 'med')[12] === '', state.events.find((e) => e[0] === 'med')[12]);

r = await say('U_coll', '發布：AI晶片設計論壇', { note: '必填還沒填齊就想發布' });
check('必填沒填齊就發布 → 擋下並列出還缺什麼，不會出現職員才有的「催填」按鈕', /還缺|缺少|先填/.test(r.all) && !r.chips.some((c) => /^催填/.test(c)) && state.events.at(-1)[4] === 'draft', r.all + ' ' + r.chips.join('|'));

r = await say('U_coll', '媒體訓練');
check('媒體訓練 → 問哪一場', /哪一場/.test(r.all), r.all);
r = await say('U_coll', '智慧醫療解決方案記者會');
check('點場次 → 給媒體訓練連結（不是開活動卡）', /媒體訓練（發言練習）/.test(r.all) && /training/.test(r.all), r.all);

for (const [t, why] of [['後台數據', '職員才有的成效'], ['待教清單', '主管的待教清單'], ['設定圖文選單', '會動到所有人的選單'], ['記住：發言人改成張院長', '教米亞（會影響記者看到的答案）'], ['GEO 狀況', 'AI 能見度']]) {
  const before2 = { mem: state.memories.length, tq: (state.teachQueue || []).length };
  r = await say('U_coll', t, { note: `同仁不該有：${why}` });
  // 「記住：⋯改成⋯」假路由會判成改資料（真的模型多半判 other）；要守的是「沒有寫進記憶、沒有執行那件事」
  check(`同仁打「${t}」→ 不執行（沒有寫進記憶、沒有動選單、看不到清單）`, !/學會了|記住了|圖文選單已設定|等著教的題目|被提及率/.test(r.all) && state.memories.length === before2.mem && (state.teachQueue || []).length === before2.tq, r.all);
}
r = await say('U_coll', { type: 'image', id: 'img1' }, { note: '傳一張照片' });
check('同仁傳照片 → 請他到編輯頁上傳（不是記者那句「看不到圖片」，也不是職員的「加到哪一場」）', /編輯頁/.test(r.all) && !(state.photoInbox || []).length, r.all);

r = await say('U_coll', '@米亞 teamwork', { group: 'Cwork', note: '在工作群組裡打密語' });
check('群組裡打同仁密語 → 群組裡一個字都不回，私訊本人提醒、通知管理員換密語', !r.some((s) => s.to === 'Cwork') && r.some((s) => s.to === 'U_coll' && /同仁密語/.test(s.text)) && r.some((s) => s.to === 'U_boss' && /LINE_COLLEAGUE_PASSCODE/.test(s.text)), r.map((s) => `${s.to}:${s.text}`).join(' / '));

r = await say('U_coll', '同仁選單');
check('同仁選單 → 三個功能＋使用說明＋退出同仁模式', ['新增活動', '修改活動', '媒體訓練', '使用說明', '退出同仁模式'].every((c) => r.chips.includes(c)), r.chips.join('|'));
r = await say('U_coll', '退出同仁模式');
check('退出同仁模式 → 標記 revoked、個人選單解除（落回記者選單）', /已退出同仁模式/.test(r.all) && state.staff.find((x) => x[0] === 'U_coll')[3] === 'revoked' && !state.linkedMenus.has('U_coll'), r.all);
r = await say('U_coll', '新增活動', { note: '退出後再打' });
check('退出後打「新增活動」→ 當記者處理，不會建活動', !/新活動的名稱/.test(r.all), r.all);
r = await say('U_coll', 'openseasame', { note: '後來拿到職員密語' });
check('同一個人改用職員密語 → 升級成職員、仍然只有一列、F 欄清空', /職員模式已啟用/.test(r.all) && state.staff.filter((x) => x[0] === 'U_coll').length === 1 && !state.staff.find((x) => x[0] === 'U_coll')[5] && state.staff.find((x) => x[0] === 'U_coll')[3] !== 'revoked', JSON.stringify(state.staff));

// ═══ 角色二：記者 ═══════════════════════════════════════════════════════
H('角色二：記者（經濟日報 陳記者，第一次加好友）');
r = await say('U_rep', 'hi', { note: '加好友後第一句' });
check('記者打招呼 → 歡迎訊息＋首頁按鈕', r.length >= 1 && r.chips.length >= 4, r.all);
r = await say('U_rep', '最近有哪些活動');
check('最近有哪些活動 → 行事曆（不列出草稿 AI晶片設計論壇）', !/AI晶片設計論壇/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 300));
r = await say('U_rep', '#med', { note: '用活動代碼綁定' });
check('#活動代碼 → 綁定並問哪家媒體', /哪家媒體/.test(r.all), r.all);
r = await say('U_rep', '經濟日報');
r = await say('U_rep', '這場的重點是什麼');
check('問這場的重點 → 該場問答（AI 假回答）', r.some((s) => s.kind === 'answer' && s.event === 'med'), JSON.stringify(r).slice(0, 300));
check('問答寫進 qa_log（媒體＝經濟日報、來源 line）', (state.qaLog || []).some((q) => q[1] === 'med' && q[3] === '經濟日報' && q[7] === 'line'), JSON.stringify(state.qaLog));
state.noDataKeyword = '發言人';
r = await say('U_rep', '這場的發言人是誰', { note: '背景資料裡沒有 → 米亞答不出來' });
state.noDataKeyword = '';
check('答不出來 → 送出去的回覆裡沒有 [[NO_DATA]] 標記外漏', r.some((s) => s.kind === 'text') && !r.filter((s) => s.kind === 'text').some((s) => /\[\[NO_DATA/.test(s.text)), r.all);
r = await say('U_rep', '這場的發言人是哪位', { note: '一分鐘內換句話再問一次' });
r = await say('U_rep', '近期工研院新聞');
const news = r.find((s) => /近期工研院新聞/.test(s.text || ''))?.text || '';
check('近期工研院新聞（批次 136 版面）：線與內容、各區塊之間都空一行', /─+\n\n①/.test(news) && /\n\n🔗/.test(news), news.slice(0, 200));
await say('U_rep', '產業趨勢分析');
r = await say('U_rep', '半導體');
check('產業趨勢 → IEK 清單（批次 136 版面：開場句、線、編號、日期另起一行）', /📊 IEK/.test(r.all) && /\n📅 /.test(r.all), r.all.slice(0, 300));
r = await say('U_rep', '工研院有什麼機器人技術');
check('問工研院技術 → 技術清單（聯絡人區塊）', /工研院技術|技術/.test(r.all), r.all.slice(0, 200));
r = await say('U_rep', 'teamwork1', { note: '亂猜密語' });
check('猜錯密語 → 不會進同仁模式', !state.staff.some((x) => x[0] === 'U_rep'), JSON.stringify(state.staff));
const memBefore = state.memories.length;
r = await say('U_rep', '教 1：這場延期到明年', { note: '記者冒充主管下「教」的指令' });
r = await say('U_rep', '待教清單');
check('★ 記者打「教 1：⋯」「待教清單」→ 不會寫進米亞的記憶、也看不到待教清單', state.memories.length === memBefore && !/等著教的題目/.test(r.all), `${state.memories.length} ${r.all}`);
r = await say('U_rep', '新增活動', { note: '記者打內部指令' });
check('記者打「新增活動」→ 不會真的建活動', !state.events.some((e) => e[1] === '新增活動') && !/新活動的名稱/.test(r.all), r.all);
r = await say('U_rep', { type: 'image', id: 'img2' }, { note: '記者傳照片' });
check('記者傳照片 → 說明看不到圖片（不會被當成活動照片）', !(state.photoUploads || []).length, r.all);
r = await say('U_rep', '找真人');
check('找真人 → 給聯絡方式', r.length >= 1, r.all);

// ═══ 角色三：主管（職員模式）＋待教清單 ═════════════════════════════════════
H('角色三：主管（朱朱，LINE_ADMIN_USER_ID，職員模式）');
r = await say('U_boss', 'openseasame');
check('主管打職員密語 → 職員模式已啟用', /職員模式已啟用/.test(r.all), r.all);
r = await say('U_boss', '待教清單', { note: '排程還沒跑' });
check('排程跑之前打待教清單 → 「目前沒有等著教的題目」', /目前沒有等著教的題目/.test(r.all), r.all);
let c = await cron('cron_teach');
check('每天的排程掃到記者剛剛「問倒米亞」的那一題、推給主管', c.body?.added >= 1 && c.sent.some((s) => s.to === 'U_boss' && /發言人/.test(s.text)), JSON.stringify(c.body));
const qid = (state.teachQueue || []).find((x) => /發言人是誰/.test(x[4]))?.[0];
check('換句話又問的那一題也被標成「記者換句話又問了一次」', (state.teachQueue || []).some((x) => /rephrased/.test(x[5])), JSON.stringify(state.teachQueue));
c = await cron('cron_teach');
check('排程再跑一次 → 不重複加、不重複推', c.body?.added === 0 && c.body?.pushed === 0, JSON.stringify(c.body));
r = await say('U_boss', '待教清單');
check('待教清單 → 列出題目與「回 N 教這題」「略過 N」的用法，附「教 N」按鈕', /等著教的題目/.test(r.all) && /回「\d+」教這題/.test(r.all) && r.chips.some((c) => /^教 \d+$/.test(c)), r.all);
r = await say('U_boss', String(qid), { note: '朱朱實際的用法：看到【1】就回「1」' });
check('回編號 → 列出那一題、請她直接打答案（以前回「我只收到一個『1』」）', /請直接打正確答案/.test(r.all) && !/只收到/.test(r.all), r.all);
r = await say('U_boss', '發言人是工研院副院長張博士');
check('教 N：答案 → 寫進 bot_memory（記在智慧醫療那一場、直接生效）', /學會了/.test(r.all) && state.memories.some((m) => m[1] === 'med' && /張博士/.test(m[3]) && m[5] === 'on'), JSON.stringify(state.memories));
r = await say('U_boss', `教 ${qid}：重複教一次`);
check('同一題再教一次 → 說已經教過', /已經教過/.test(r.all), r.all);
const other = (state.teachQueue || []).find((x) => x[0] !== qid && x[8] === 'open');
if (other) {
  r = await say('U_boss', `略過 ${other[0]}`);
  check('略過 N → 標成 skipped', /不教了/.test(r.all) && (state.teachQueue || []).find((x) => x[0] === other[0])[8] === 'skipped', r.all);
}
r = await say('U_rep', '這場的發言人是誰', { note: '記者隔天再問一次' });
check('★ 記者再問同一題 → 主管教的那句話有帶進米亞的系統提示', r.some((s) => s.kind === 'answer' && /張博士/.test(s.sysAll || '')), (r.find((s) => s.kind === 'answer')?.sysAll || '').slice(-300));
r = await say('U_boss', '設定圖文選單');
check('設定圖文選單 → 回報記者／職員／同仁三套都更新了', /同仁看到的/.test(r.all), r.all);
r = await say('U_boss', '後台數據');
check('職員可以看後台數據（同仁不行）', !/同仁模式幫不上忙/.test(r.all), r.all);

// ═══ 角色四：想洽案的廠商 ═══════════════════════════════════════════════
H('角色四：想洽案的廠商（某電子公司 業務經理）');
r = await say('U_vendor', '你好，我想跟工研院談合作');
check('廠商問合作（業發處還沒設定時）→ 照一般路徑回，不會卡住或沒回應', r.length >= 1, r.all);
r = await say('U_vendor', '問技術與洽案');
check('點「問技術與洽案」→ 有技術領域可以選', r.length >= 1 && r.chips.length >= 3, r.all + ' ' + r.chips.join('|'));
r = await say('U_vendor', '工研院有什麼電池技術可以授權');
check('問可授權的技術 → 技術清單附聯絡人', /聯絡人|電池/.test(r.all), r.all.slice(0, 300));
r = await say('U_vendor', '技術授權要找誰');
check('技術授權要找誰 → 有回應（業發處沒設定時走一般路徑）', r.length >= 1, r.all);
r = await say('U_vendor', '#業務 M7K3QA-K8PQ2X', { note: '廠商亂打業務綁定碼' });
check('廠商亂打「#業務 綁定碼」→ 說還沒啟用／綁定失敗，不會綁上', /還沒啟用|綁定/.test(r.all), r.all);

console.log(`\n${fail ? '❌' : '✅'} LINE 四角色走查：${pass} 通過，${fail} 失敗`);
if (failures.length) console.log('失敗項目：\n- ' + failures.join('\n- '));
if (process.env.OUT) {
  fs.mkdirSync(process.env.OUT, { recursive: true });
  fs.writeFileSync(path.join(process.env.OUT, 'line-transcript.md'), `# LINE 四角色走查（${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}）\n\nAI 回答與意圖判斷是假的；看的是分流、權限、按鈕、寫進試算表與推播的對象。\n` + log.join('\n') + `\n\n**結果：${pass} 通過，${fail} 失敗**\n`);
}
process.exit(fail ? 1 : 0);
