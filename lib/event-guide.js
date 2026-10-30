// 同仁新增活動的「一步步帶我」與活動前一天提醒（批次 177）。
//
// 朱朱的需求：降低同仁新增活動的門檻——不要只丟一個編輯連結，而是帶著同仁一步一步填，
// 並且在活動前依時間點跟負責人要資料。
//
// 這支全是純函式、不碰試算表也不碰 LINE：「下一步問什麼」「還缺什麼」要每次算出來都一樣，
// 同仁才敢照著做（跟 lib/event-status.js 同一個理由），也才測得穩。
//
// ⚠️ 設計上最重要的一條：**引導是從資料算出來的，不是一個存起來的狀態機**。
// 這個流程會拖好幾天，同仁問到一半去開會是常態；每次都從「這場現在缺什麼」重新算下一步，
// 隨時點活動卡都接得上，不會卡在一個沒人記得的第 3 步。只有「正在等他貼邀請函」這種當場的
// 短問答才用 10 分鐘的追問狀態（lib/staff.js setStaffPending）。

import { eventDateOf, shortDate } from './event-status.js';
import { kbHasContent, kbSections } from './kb-template.js';
import { isBusinessEvent } from './audience.js';

// events 表欄位（同 api/events.js）：D knowledge_base, E status, F 日期, L 時間, M 地點, N 類型,
// O 新聞聯絡人, Q 媒體邀請函

const filled = v => !!String(v ?? '').trim();

function dayDiff(iso, todayIso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000);
}

// ── 媒體邀請函（從 LINE 貼）─────────────────────────────────────────────
// 上限 2000 字：追問狀態存在試算表的一格（上限 5 萬字元），確認那一步要把「改前、改後」都帶著，
// 中文經過 encodeURIComponent 約 9 倍長，兩份各 2000 字約 3.6 萬，剛好放得下。
// 更長的（或本來就很長的）請到編輯頁，LINE 上也不好校對。
export const INVITE_MAX = 2000;
// 邀請函通常只有幾百字。超過這個長度多半是把新聞稿全文貼錯地方——邀請函是活動前記者唯一看得到的內容，
// 新聞稿貼在這裡等於提早曝光，所以確認那一步要多問一句（不擋：有些邀請函本來就長）。
export const INVITE_LONG_WARN = 800;
// 短到不可能是邀請函：「好了」「有」「貼好了」這類回答，不能存成邀請函
export const INVITE_MIN = 20;

/** 保留換行的整理：統一換行符號、每行去頭尾空白、連續空行壓成一行。 */
export function normalizeMultiline(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map(l => l.replace(/[ \t　]+$/g, '').replace(/^[ \t]+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 給人看的邀請函摘要（修改紀錄、通知管理員、復原提示用）：第一行開頭＋總字數。 */
export function invitePreview(v, n = 60) {
  const s = String(v ?? '').trim();
  if (!s) return '（空白）';
  const one = s.replace(/\s+/g, ' ');
  return `${one.length > n ? one.slice(0, n) + '…' : one}（共 ${s.length} 字）`;
}

/** 貼完邀請函後的確認訊息（比一般欄位多：預覽、字數、會取代舊的、記者看到什麼）。 */
export function inviteConfirmText({ eventName, before, after, undo = false }) {
  const b = String(before ?? '').trim();
  const a = String(after ?? '').trim();
  const lines = [];
  lines.push(undo ? `復原上一個修改：《${eventName}》的媒體邀請函` : `要把這段設成《${eventName}》的媒體邀請函嗎？`);
  lines.push('');
  const show = a.length > 300 ? a.slice(0, 300) + '…' : a;
  lines.push('────────', show || '（空白）', '────────');
  lines.push(`共 ${a.length} 字`);
  if (b) lines.push(`⚠️ 會整份換掉目前的邀請函（${b.length} 字）。`);
  if (a.length > INVITE_LONG_WARN) {
    lines.push('', `⚠️ 這段有 ${a.length} 字，邀請函通常很短。如果這是新聞稿全文請按「取消修改」——新聞稿請貼在編輯頁的知識庫，不要貼在這裡。`);
  }
  lines.push('', '確認後，活動日之前記者問米亞，只會看到這份邀請函（活動當天自動換成新聞稿）。');
  return lines.join('\n');
}

// ── 一步步帶我 ─────────────────────────────────────────────────────────
// 順序是朱朱定的：日期（提醒全靠它）→ 邀請函（活動前唯一給記者看的）→ 地點 → 新聞聯絡人。
// 新聞稿、議程、受訪者、貴賓不在這裡問：它們是同一個知識庫欄位裡的小節，LINE 上沒辦法分開存，
// 問了也只是讓同仁跑去編輯頁再回來答——改成活動前一天由系統偵測、列出還缺哪幾項（見下面 reminderItem）。
export const GUIDE_ORDER = ['date', 'invite', 'venue', 'contact'];

/** 這場現在缺的引導步驟（依 GUIDE_ORDER 的順序）。企業場沒有這幾項，回 []。 */
export function missingGuideSteps(row, todayIso) {
  const r = row || [];
  if (isBusinessEvent(r[13])) return [];
  const date = eventDateOf(r[5]);
  const daysLeft = date ? dayDiff(date, todayIso) : null;
  const out = [];
  if (!date) out.push('date');
  // 邀請函只有「活動還沒到」或「日期還沒定」有意義（跟 event-status.js 檢查清單同一條規則）
  if (!filled(r[16]) && (!date || daysLeft > 0)) out.push('invite');
  if (!filled(r[12])) out.push('venue');
  if (!filled(r[14])) out.push('contact');
  return out;
}

/** 從第 fromIdx 個步驟（GUIDE_ORDER 的索引）起，下一個缺的是哪一步。沒有了回 null。 */
export function nextGuideStep(row, todayIso, fromIdx = 0) {
  const missing = new Set(missingGuideSteps(row, todayIso));
  for (let i = Math.max(0, fromIdx); i < GUIDE_ORDER.length; i++) {
    if (missing.has(GUIDE_ORDER[i])) return { key: GUIDE_ORDER[i], idx: i };
  }
  return null;
}

export function guideQuestion(key, name) {
  switch (key) {
    case 'date':
      return `《${name}》是哪一天辦？\n直接打日期就好，例如「10/28」。\n\n日期很重要：有了日期，我才能在活動前一天提醒你補資料。`;
    case 'invite':
      return `《${name}》的「媒體邀請函」好了嗎？\n\n好了的話，把全文整段貼上來；我會先給你看過再存。\n\n💡 為什麼先問這個：活動日之前，記者問米亞只會看到邀請函，看不到新聞稿與照片。邀請函先備好，之後你再放新聞稿也不用擔心提早曝光。\n\n還沒好的話按「先跳過」，發布前記得補。`;
    case 'venue':
      return `《${name}》的地點在哪裡？\n直接打，例如「南港展覽館 3 樓」。`;
    case 'contact':
      return `記者要找誰詢問？請打新聞聯絡人的姓名和電話，例如「王小明 0912-345-678」。`;
    default:
      return '';
  }
}

// 「還沒」「沒有」這類回答：不是邀請函，是在說還沒好
const NOT_YET_RE = /^(還沒|尚未|沒有|沒呢|沒好|還沒有|還沒好|還沒做好|還在改|還在寫|等等)/;
export const SKIP_RE = /^(先跳過|跳過|略過|先略過|這題跳過)[。!！]?$/;
export function isNotYetReply(text) {
  const s = String(text || '').trim();
  return s.length <= 12 && NOT_YET_RE.test(s);
}

/**
 * 同仁打的日期：10/28、10月28日、2026/10/28、2026-10-28。整句就是日期才收，其餘回 ''。
 * 沒寫年份取今天之後最近的那一天（跟 lib/staff.js parseCreateEventText 同一個規則）。
 * 這裡是字面比對、不問模型：寫進表之前的日期一定要程式驗過（CLAUDE.md 第 2 條）。
 */
export function parseLooseDate(text, todayIso) {
  const s = String(text || '').trim().replace(/[。！!\s]+$/, '');
  const m = s.match(/^(?:(\d{4})\s*[\/\-.年]\s*)?(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*[日號号]?$/);
  if (!m) return '';
  const pad = n => String(n).padStart(2, '0');
  const valid = (y) => {
    const iso = `${y}-${pad(m[2])}-${pad(m[3])}`;
    const d = new Date(Date.UTC(y, +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === y && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? iso : '';
  };
  if (m[1]) return valid(+m[1]);
  const y = Number(todayIso.slice(0, 4));
  const iso = valid(y);
  if (iso && iso < todayIso) return valid(y + 1) || iso;
  return iso;
}

// ── 活動前一天提醒 ─────────────────────────────────────────────────────
// 知識庫（新聞稿那一欄）裡，這三種內容有沒有寫。判斷用小節標題；整份沒有任何【標題】
// （同仁自己寫的自由格式）就無從判斷，回 []，寧可不提醒也不要誤報「缺議程」。
const KB_NEEDS = [
  { label: '議程', re: /議程|流程/ },
  { label: '受訪者／發言人', re: /受訪者|發言人|講者/ },
  { label: '貴賓', re: /貴賓|致詞/ }
];
export function missingKbSections(kb) {
  const sections = kbSections(kb);
  if (!sections.length) return [];
  return KB_NEEDS
    .filter(n => !sections.some(s => n.re.test(s.heading) && s.content.length))
    .map(n => n.label);
}

/**
 * 活動前一天要不要提醒、提醒什麼。回 null＝不用提醒（沒缺東西就不打擾，推播要算則數）。
 * 只在「明天就辦」那一天回傳；已結束、封存、企業場一律 null。
 * 回傳 { kind:'eve', eventId, name, date, time, venue, status, missing: [...], draft }。
 */
export function reminderItem(row, todayIso) {
  const r = row || [];
  if (isBusinessEvent(r[13])) return null;
  const status = r[4] || 'active';
  if (status === 'ended' || status === 'archived') return null;
  const date = eventDateOf(r[5]);
  if (!date || dayDiff(date, todayIso) !== 1) return null;

  const missing = [];
  if (!kbHasContent(r[3])) missing.push('新聞稿（議程、受訪者、貴賓也都填在同一個知識庫欄位）');
  else missing.push(...missingKbSections(r[3]));
  if (!filled(r[12])) missing.push('地點');
  if (!filled(r[14])) missing.push('新聞聯絡人');
  const draft = status === 'draft';
  if (!missing.length && !draft) return null;
  return { ...baseItem(r, date, status), kind: 'eve', missing, draft };
}

function baseItem(r, date, status) {
  return {
    eventId: r[0], name: r[1] || '', date, time: String(r[11] || '').trim(), venue: String(r[12] || '').trim(),
    status, draft: status === 'draft'
  };
}

// ── 其他時間點的提醒（批次 178）──────────────────────────────────────────
// 活動前一週（沒有邀請函）、活動當天早上（新聞稿還沒貼）、活動隔天（還沒有照片）。
// 跟前一天那則一樣：沒缺東西就不推；每一種對同一場同一個活動日期最多一次（發送紀錄去重，見 lib/event-remind.js）。

export const KIND_EVE = 'eve', KIND_WEEK = 'week', KIND_DAY = 'day', KIND_AFTER = 'after';
export const ALL_KINDS = [KIND_EVE, KIND_DAY, KIND_WEEK, KIND_AFTER];

/**
 * 多天的活動（批次 169）：活動表只有一個日期（第一天），沒有結束日。隔天還在辦的活動不能催「怎麼還沒傳照片」。
 * 沒有可靠的欄位可以判斷，只能看知識庫（議程）有沒有寫出「活動日之後 1～14 天內」的日期，有就當多天活動。
 * 寧可誤判成多天（少催一次）也不要把還在辦的活動說成辦完了。
 */
export function looksMultiDay(kb, eventDateIso) {
  const base = Date.parse(eventDateIso + 'T00:00:00Z');
  if (!Number.isFinite(base)) return false;
  const y = Number(eventDateIso.slice(0, 4));
  const re = /(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})|(\d{1,2})\s*[\/月]\s*(\d{1,2})/g;
  for (const m of String(kb || '').matchAll(re)) {
    const yy = m[1] ? Number(m[1]) : y;
    const mo = Number(m[2] || m[4]), dd = Number(m[3] || m[5]);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
    const t = Date.UTC(yy, mo - 1, dd);
    const diff = Math.round((t - base) / 86400000);
    if (diff >= 1 && diff <= 14) return true;
  }
  return false;
}

/** 某一種提醒對這一列要不要送、送什麼。不用送回 null。 */
export function reminderFor(kind, row, todayIso) {
  if (kind === KIND_EVE) return reminderItem(row, todayIso);
  const r = row || [];
  if (isBusinessEvent(r[13])) return null;
  const status = r[4] || 'active';
  if (status === 'archived') return null;
  const date = eventDateOf(r[5]);
  if (!date) return null;
  const diff = dayDiff(date, todayIso);
  const item = { ...baseItem(r, date, status), kind, missing: [], hasInvite: filled(r[16]) };
  if (kind === KIND_WEEK) {
    // 還沒發布的草稿也要提醒：邀請函本來就該在發布之前備好
    return status !== 'ended' && diff === 7 && !item.hasInvite ? item : null;
  }
  if (kind === KIND_DAY) {
    return status !== 'ended' && diff === 0 && !kbHasContent(r[3]) ? item : null;
  }
  if (kind === KIND_AFTER) {
    // 草稿從來沒對記者開放過，照片沒有時效；手動標成「已結束」的場次照樣要催（辦完才是傳照片的時候）
    return status !== 'draft' && diff === -1 && !filled(r[7]) && !looksMultiDay(r[3], date) ? item : null;
  }
  return null;
}

const whenOf = (item) => [shortDate(item.date), item.time, item.venue].filter(Boolean).join('｜');
const linkLine = (link) => (link ? ['', `📝 編輯頁（不需要登入）：\n${link}`] : []);

/** 一個收件人的提醒訊息（同一人同一種提醒有好幾場合成一則，省推播則數）。entries: [{ item, link }] */
export function formatReminder(entries, { unowned = false } = {}) {
  const blocks = entries.map(({ item, link }) => {
    const lines = [`《${item.name}》明天辦`, whenOf(item)];
    if (item.missing.length) lines.push(`還缺：${item.missing.join('、')}`);
    if (item.draft) lines.push('目前是「未發布」，記者還問不到這場。');
    if (unowned) lines.push('（這場沒有負責人，所以提醒送到你這裡。負責人可在 LINE 同仁模式點活動卡的「🙋 我來負責」。）');
    if (link) lines.push('', `📝 補資料（不需要登入）：\n${link}`);
    return lines.join('\n');
  });
  return [
    '⏰ 活動前一天提醒',
    '',
    blocks.join('\n\n────────\n\n'),
    '',
    '小提醒：活動當天 00:00 起，記者問米亞會改用新聞稿回答；那時新聞稿還沒貼，米亞就只能給邀請函的內容。貼完後在編輯頁把「活動狀態」改成進行中就能發布。'
  ].join('\n');
}

/** 活動前一週：還沒有媒體邀請函 */
export function formatWeekReminder(entries) {
  const blocks = entries.map(({ item, link }) => [
    `《${item.name}》一週後辦（${whenOf(item)}），還沒有「媒體邀請函」。`,
    ...(item.draft ? ['目前是「未發布」。'] : []),
    ...linkLine(link)
  ].join('\n'));
  return [
    '📨 活動前一週提醒',
    '',
    blocks.join('\n\n────────\n\n'),
    '',
    '為什麼先備邀請函：活動日之前，記者問米亞只會看到邀請函（看不到新聞稿和照片）。邀請函先備好，之後再放新聞稿也不用擔心提早曝光。',
    '直接在這裡貼也可以：點下面的按鈕，把邀請函全文貼上來，我先給你看過再存。'
  ].join('\n');
}

/** 活動當天早上：新聞稿還沒貼 */
export function formatDayReminder(entries) {
  const blocks = entries.map(({ item, link }) => [
    `《${item.name}》今天辦（${whenOf(item)}）`,
    item.hasInvite
      ? '新聞稿還沒貼：現在記者問米亞，米亞只能用邀請函的內容回答。'
      : '新聞稿還沒貼，也沒有邀請函：現在記者問米亞，米亞什麼都答不出來。',
    ...(item.draft ? ['目前是「未發布」，記者還問不到這場。'] : []),
    ...linkLine(link)
  ].join('\n'));
  return [
    '☀️ 今天有活動',
    '',
    blocks.join('\n\n────────\n\n'),
    '',
    '新聞稿貼好並存檔後，米亞很快就會改用新聞稿回答。還沒發布的話，在編輯頁把「活動狀態」改成進行中。'
  ].join('\n');
}

/** 活動隔天：還沒有照片 */
export function formatAfterReminder(entries) {
  const blocks = entries.map(({ item, link }) => [
    `《${item.name}》昨天辦完了，還沒有活動照片。`,
    ...linkLine(link)
  ].join('\n'));
  return [
    '📷 活動結束了',
    '',
    blocks.join('\n\n────────\n\n'),
    '',
    '現場拍的照片直接傳給我，再點是哪一場，記者就能下載（也可以到編輯頁的「圖片資源」上傳）。'
  ].join('\n');
}

export function formatReminderOf(kind, entries, opts) {
  if (kind === KIND_WEEK) return formatWeekReminder(entries);
  if (kind === KIND_DAY) return formatDayReminder(entries);
  if (kind === KIND_AFTER) return formatAfterReminder(entries);
  return formatReminder(entries, opts);
}
