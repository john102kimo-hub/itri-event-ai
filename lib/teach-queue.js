// 待教清單（批次 139）：從記者的問答裡「自動發現」米亞可能沒答好的題目，推給朱朱，由朱朱一句話教會。
//
// 使用者的原話：「記者或使用者在 LINE 提問，他會記憶學習，確保下次同樣錯誤不會發生（如問 A 答 B）」。
//
// ⚠️ 一條刻意的界線：**記者的話不直接變成知識。**
// 完全自動學習有兩個洞——誰來判斷「答錯了」（模型自己判會有誤判），以及有人刻意在對話裡說
// 「其實這場延期了」就能改掉所有人讀到的答案。所以這支只做「發現」與「提醒」：
//   發現  每天掃一次 qa_log，挑出疑似沒答好的題目，存進 teach_queue 分頁
//   提醒  推到朱朱的 LINE（LINE_ADMIN_USER_ID）
//   核准  朱朱回「教 12：正確答案」，才寫進 bot_memory（沿用批次 46 的 fact）；回「略過 12」就不再提
// 寫進知識庫的每一個字都是同仁親口講的，記者端的內容一個字都不會直接進去。
//
// 兩個訊號（都只是線索，寧可漏、不要吵）：
//   unanswered  米亞的回答裡有「這部分我沒有資料」這類說法（後台「疑似答不出來」同一條規則）
//   rephrased   同一位記者在同一場、十分鐘內換句話又問了一次類似的題目——問 A 答 B 最典型的樣子：
//               第一次沒得到想要的，所以再問一遍。被判成待教的是**第一次那一題**。
//
// 一題只會被提一次：不管之後是教了、略過、還是沒理它，同一場同一題都不會再進清單。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { isTestMedia } from './media-name.js';
import { toTraditionalTW } from './zh-tw.js';
import { pushMessage } from './line.js';
import { isStaffAuthenticated } from './staff.js';

// 「AI 這題疑似沒答到」：提示詞規定答不出來時要說「這部分我沒有資料，建議洽現場新聞聯絡人」
// （lib/prompt.js），所以這句話的出現是個可靠的線索。只是線索——模型偶爾會換個說法，漏標沒關係。
// 原本住在 api/analytics.js（批次 104），後台標「疑似答不出來」與這裡共用同一條，兩邊才不會各判各的。
export const UNANSWERED_RE = /這部分我沒有資料|背景資料(?:中|裡)?(?:並)?沒有(?:提到|提供|記載)|沒有(?:相關|這方面的)資料|查無相關資料/;

export const QUEUE_RANGE = 'teach_queue!A2:J';
const HEADER = ['編號', '建立時間', '活動id', '活動名稱', '問題', '訊號', '次數', '米亞的回答', '狀態', '已推送'];

export const OPEN = 'open', TAUGHT = 'taught', SKIPPED = 'skipped';

export const SCAN_WINDOW_MS = 48 * 3600 * 1000; // 排程一天一次；多抓一天，漏跑一次也補得到（重複的由清單去重）
export const REPHRASE_GAP_MS = 10 * 60 * 1000;
// 中文換個助詞（的／是／在）雙連詞的重疊就掉一大截：「展示地點在哪裡」vs「展示的地點是哪裡」只有 0.375。
// 0.35 擋得住「同主題、問不同事」（「展示地點在哪裡」vs「發言人是誰」約 0.25）。這只是線索，寧可偶爾多提一題，朱朱按「略過」就好。
export const REPHRASE_SIMILARITY = 0.35;
export const MAX_OPEN = 30;   // 清單上等著教的題數上限。沒人理的話不再往上疊，免得推播變成噪音
export const PUSH_BATCH = 5;  // 一次推幾題
const QUESTION_MAX = 200;      // 題目存進清單的長度上限；掃描時也截一樣長，去重才對得上

// ── 掃 qa_log ─────────────────────────────────────────────────────────

// qa_log 的時間欄是 toLocaleString('zh-TW') 寫的「2026/10/15 下午2:30:00」，Node 的 Date 解析器不保證
// 讀得回來（見 lib/line-store.js 的說明），自己拆。回傳 epoch 毫秒（當成台灣時間 UTC+8），認不得就是 NaN。
export function parseQaTime(s) {
  const m = String(s || '').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[\sT]*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (!m) return NaN;
  let h = Number(m[5]);
  const pm = /下午|PM/i.test(m[4] || ''), am = /上午|AM/i.test(m[4] || '');
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h - 8, Number(m[6]), Number(m[7] || 0));
}

// 題目的比對用寫法：去掉空白與標點、轉小寫。「智慧醫療在哪裡？」跟「智慧醫療 在哪裡」是同一題。
export function normQuestion(q) {
  return String(q || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
export function similarity(a, b) {
  const x = normQuestion(a), y = normQuestion(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export const queueKey = (eventId, question) => `${eventId || ''}|${normQuestion(question)}`;
const flat = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * rows＝qa_log!A2:I（A 時間 B 活動 id C 活動名稱 D 媒體 E 問題 F 回答 G 刪除旗標 H 來源 I 姓名）。
 * 回傳疑似沒答好的題目，每一題（同一場、同一個問法）一筆，被問越多次越前面。
 */
export function findSuspects(rows, { now = Date.now(), windowMs = SCAN_WINDOW_MS } = {}) {
  const recs = [];
  for (const r of rows || []) {
    // 200 字：跟寫進 teach_queue 的長度（addToQueue）一致。不一致的話，超過 200 字的題目存進去被截短，
    // 下次排程用沒截短的版本算 queueKey，對不上「已經提過」，同一題每天再加一次、再推一次（批次 144）
    const q = flat(r[4], QUESTION_MAX);
    if (!q || r[6]) continue;                 // 沒有問題、或後台已刪除
    if (isTestMedia(r[3])) continue;          // 測試、員工自己問的（結案報告也不算這些）
    const ts = parseQaTime(r[0]);
    if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 3600 * 1000) continue;
    recs.push({ ts, eventId: String(r[1] || '').trim(), eventName: String(r[2] || ''), media: String(r[3] || ''), who: String(r[8] || ''), q, a: String(r[5] || '') });
  }
  recs.sort((x, y) => x.ts - y.ts);

  // 同一題被問了幾次（窗口內）
  const asked = new Map();
  for (const x of recs) asked.set(queueKey(x.eventId, x.q), (asked.get(queueKey(x.eventId, x.q)) || 0) + 1);

  const groups = new Map();
  const flag = (rec, signal) => {
    const key = queueKey(rec.eventId, rec.q);
    if (!normQuestion(rec.q)) return;
    let g = groups.get(key);
    if (!g) {
      g = { key, eventId: rec.eventId, eventName: rec.eventName, question: rec.q, answer: flat(rec.a, 120), signals: new Set(), count: asked.get(key) || 1 };
      groups.set(key, g);
    }
    g.signals.add(signal);
  };

  for (const x of recs) if (UNANSWERED_RE.test(x.a)) flag(x, 'unanswered');

  // 換句話又問：同一位（媒體＋姓名）、同一場、十分鐘內連續兩題相似。
  // 媒體名稱沒填的（「（未填寫）」）分不出是不是同一個人，不判。
  const last = new Map();
  for (const x of recs) {
    if (!x.media || /^（.*）$/.test(x.media)) continue;
    const who = `${x.eventId}|${x.media}|${x.who}`;
    const prev = last.get(who);
    if (prev && x.ts - prev.ts <= REPHRASE_GAP_MS && similarity(prev.q, x.q) >= REPHRASE_SIMILARITY) flag(prev, 'rephrased');
    last.set(who, x);
  }

  return [...groups.values()]
    .map(g => ({ ...g, signals: [...g.signals] }))
    .sort((a, b) => b.signals.length - a.signals.length || b.count - a.count);
}

// ── teach_queue 分頁 ──────────────────────────────────────────────────

let ensured = false;
export async function ensureQueueSheet() {
  if (ensured) return;
  try {
    await ensureSheets({ teach_queue: HEADER });
  } catch (e) {
    console.error('ensureSheets(teach_queue) 失敗:', e.message);
  }
  ensured = true;
}

export function parseQueueRows(rows) {
  return (rows || []).map((r, i) => ({
    rowNumber: i + 2,
    id: Number(r[0]) || 0,
    at: r[1] || '',
    eventId: (r[2] || '').trim(),
    eventName: r[3] || '',
    question: r[4] || '',
    signals: (r[5] || '').split(',').map(s => s.trim()).filter(Boolean),
    count: Number(r[6]) || 1,
    answer: r[7] || '',
    status: (r[8] || '').trim() || OPEN,
    pushed: (r[9] || '').trim() === 'Y'
  })).filter(x => x.id && x.question);
}

// 不快取：只有每天一次的排程與同仁打「待教清單／教／略過」才讀，量很小；快取反而會讓「剛教完又被提醒」。
export async function readQueue() {
  try {
    return parseQueueRows(await readRange(QUEUE_RANGE));
  } catch (e) {
    // 分頁還沒建（第一次排程跑之前同仁就打了「待教清單」）——建起來、當作空的
    if (/Unable to parse range/i.test(e.message)) {
      await ensureQueueSheet();
      return [];
    }
    throw e;
  }
}

export async function addToQueue(items, existing) {
  if (!items.length) return [];
  await ensureQueueSheet();
  const at = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let id = Math.max(0, ...(existing || []).map(x => x.id));
  const rows = items.map(it => [++id, at, it.eventId, it.eventName, it.question.slice(0, QUESTION_MAX), it.signals.join(','), it.count, it.answer, OPEN, '']);
  await appendRows('teach_queue!A:J', rows);
  return rows;
}

export const setQueueStatus = (rowNumber, status) => updateRange(`teach_queue!I${rowNumber}`, [[status]]);
export const markPushed = (rowNumber) => updateRange(`teach_queue!J${rowNumber}`, [['Y']]);

// ── 推給朱朱的文字 ────────────────────────────────────────────────────

const SIGNAL_TEXT = { unanswered: '米亞回答「沒有資料」', rephrased: '記者換句話又問了一次' };

function itemLines(it) {
  const why = it.signals.map(s => SIGNAL_TEXT[s]).filter(Boolean).join('、');
  return [
    `【${it.id}】${it.eventName ? `《${it.eventName}》` : '（未指定活動）'}`,
    `問：${it.question}${it.count > 1 ? `（被問 ${it.count} 次）` : ''}`,
    ...(it.answer ? [`米亞答：${it.answer}`] : []),
    ...(why ? [`原因：${why}`] : []),
    `→ 教 ${it.id}：正確答案　或　略過 ${it.id}`
  ].join('\n');
}

// 推播對象還不是職員時（批次 145）：「教 N：」只有職員模式認得，提醒要先登入，不然回了會被當成一般問題。
export const NEED_STAFF_LOGIN_NOTE = '\n\n⚠️ 你目前不在職員模式（還沒登入或退出過），要先在這裡打一次職員密語，才能用「教 N：」「略過 N」。';

export function formatDigest(items, totalOpen, { needLogin = false } = {}) {
  const more = totalOpen - items.length;
  return toTraditionalTW(
    `📚 米亞有 ${items.length} 題可能沒答好，想請你教教我\n` +
    '（最近兩天記者問的，已排除測試與內部同仁的提問）\n\n' +
    items.map(itemLines).join('\n\n') +
    `\n\n教的內容會記在那一場，之後記者問同樣的事就會照這個答。` +
    (more > 0 ? `\n還有 ${more} 題在清單裡，打「待教清單」可以看。` : '') +
    (needLogin ? NEED_STAFF_LOGIN_NOTE : ''),
    { terms: false });
}

export function formatQueueList(open) {
  if (!open.length) return '目前沒有等著教的題目 👌\n\n每天早上我會把記者問過、可能沒答好的題目整理給你。';
  const shown = open.slice(0, 8);
  return toTraditionalTW(
    `等著教的題目有 ${open.length} 題：\n\n` + shown.map(itemLines).join('\n\n') +
    (open.length > shown.length ? `\n\n（只列前 ${shown.length} 題，教掉或略過幾題後再打「待教清單」看其餘的）` : ''),
    { terms: false });
}

// ── 排程 ──────────────────────────────────────────────────────────────

/** 每天一次：掃 qa_log → 新的題目進清單 → 還沒推過的推給朱朱。回傳摘要（給排程的回應與測試看）。 */
export async function runTeachQueueCron({ now = Date.now() } = {}) {
  const rows = await readRange('qa_log!A2:I');
  const queue = await readQueue();

  const seen = new Set(queue.map(x => queueKey(x.eventId, x.question)));
  const openCount = queue.filter(x => x.status === OPEN).length;
  const room = Math.max(0, MAX_OPEN - openCount);
  const fresh = findSuspects(rows, { now }).filter(s => !seen.has(s.key)).slice(0, room);
  if (fresh.length) await addToQueue(fresh, queue);

  const all = fresh.length ? await readQueue() : queue;
  const open = all.filter(x => x.status === OPEN);
  const toPush = open.filter(x => !x.pushed).sort((a, b) => b.signals.length - a.signals.length || b.count - a.count).slice(0, PUSH_BATCH);
  const summary = { scanned: (rows || []).length, added: fresh.length, open: open.length, pushed: 0 };
  if (!toPush.length) return summary;

  // 沒設管理員就不推（題目留在清單裡，同仁打「待教清單」一樣看得到）。不吞掉也不報錯：這是設定，不是故障。
  const ownerId = process.env.LINE_ADMIN_USER_ID;
  if (!ownerId || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return { ...summary, skipped: '沒有設定 LINE_ADMIN_USER_ID' };

  // 讀不到 line_staff 就當成已登入（不要因為試算表忙碌多推一句可能是錯的提醒）
  const needLogin = !(await isStaffAuthenticated(ownerId).catch(() => true));
  const res = await pushMessage(ownerId, formatDigest(toPush, open.length, { needLogin }), needLogin ? [] : ['待教清單']);
  if (res && res.ok === false) {
    console.error('待教清單推播失敗:', res.status);
    return { ...summary, skipped: `LINE 推播失敗 ${res.status}` }; // 沒標「已推送」，明天會再試
  }
  for (const it of toPush) await markPushed(it.rowNumber);
  return { ...summary, pushed: toPush.length };
}

// ── 同仁在 LINE 打的指令 ──────────────────────────────────────────────

const CMD_LIST = /^(待教清單|待教|米亞不會的|待教題目)[?？。]?$/;
const CMD_TEACH = /^教\s*(\d{1,4})\s*[:：]\s*([\s\S]+)$/;
const CMD_SKIP = /^(略過|跳過|不用教)\s*(\d{1,4})$/;

export function parseQueueCommand(text) {
  const s = String(text || '').trim();
  if (CMD_LIST.test(s)) return { kind: 'list' };
  const t = s.match(CMD_TEACH);
  if (t) return { kind: 'teach', id: Number(t[1]), answer: t[2].trim() };
  const k = s.match(CMD_SKIP);
  if (k) return { kind: 'skip', id: Number(k[2]) };
  return null;
}

/**
 * 把「題目＋同仁教的答案」組成一條記憶的內容。記憶上限 200 字（lib/bot-memory.js MEMORY_MAX_LEN）：
 * 題目先縮（只是個提示），答案不能被默默截掉——截掉一半的答案比沒有答案更糟。縮到題目只剩 8 個字還放不下就回 null。
 */
export function buildTaughtFact(question, answer, maxLen) {
  const a = String(answer || '').trim();
  const q = flat(question, 200);
  const make = (qq) => `被問到「${qq}」時，正確答案是：${a}`;
  for (let n = Math.min(q.length, 60); n >= Math.min(8, q.length); n -= 4) {
    const t = make(n < q.length ? q.slice(0, n) + '…' : q);
    if (t.length <= maxLen) return t;
  }
  return null;
}
