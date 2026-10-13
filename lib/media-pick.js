// 記者名單的「挑收件人」——給承辦人貼進 Outlook 寄邀請函用（批次 137）。全部是純函式，不碰網路。
//
// 為什麼是「備好收件人」而不是「平台直接寄」：公司資安不讓平台代寄，邀請函還是從 Outlook 寄。
// 所以這支只管三件事：照條件挑出該寄的人、把 mail 串成 Outlook 貼得進去的樣子、必要時分批。
//
// Outlook 的收件人欄用**分號**分隔（逗號在部分語系設定下不認）。用「; 」（分號加空格），貼進去之後
// Outlook 會自己轉成一顆顆收件人。名單很長時分批，避免撞到公司信箱的單封收件人上限——
// 上限是多少我們查不到，預設每批 50 人，承辦人可以自己改。

const STALE_DAYS = 365;

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 500;

// 夠嚴到擋掉明顯打錯的（缺 @、缺網域、中間有空白或分號），又不嚴到擋掉合法但少見的寫法。
const EMAIL_RE = /^[^\s@;,<>()[\]\\"]+@[^\s@;,<>()[\]\\"]+\.[^\s@;,<>()[\]\\"]+$/;

/**
 * 從一格 mail 欄位取出第一個有效的信箱（小寫）；沒有就回空字串。
 * 名單來源很雜：官網與 Word 常見全形＠、欄位裡有時塞兩個信箱（用分號、逗號、空白或頓號隔開），
 * 前後常有空白。這裡統一修成 Outlook 寄得出去的樣子；寧可略過一筆也不要把壞字串貼進收件人欄。
 */
export function normalizeEmail(raw) {
  const parts = String(raw ?? '').replace(/[＠]/g, '@').split(/[;,\s、；，]+/);
  for (const p of parts) {
    const s = p.trim().replace(/^[<(]+|[>).。]+$/g, '').toLowerCase();
    if (EMAIL_RE.test(s)) return s;
  }
  return '';
}

export const isValidEmail = (raw) => !!normalizeEmail(raw);

const daysSince = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

/**
 * 照條件挑人。rows 是 parseRow() 之後的記者（api/media.js）。
 * filters：{ beat, outlet, recentOnly }
 *   beat       路線，空字串＝不限
 *   outlet     媒體名稱包含這段字（不分大小寫），空字串＝不限
 *   recentOnly 只挑「最近一年受邀過」的；沒有受邀日期的不算
 * 一律排除已離職／轉線（status === 'left'）。
 *
 * 回 { people, matched, withoutEmail, duplicates }
 *   people        有有效 mail 的人，mail 已轉小寫、同一個 mail 只留第一筆
 *   matched       符合條件的總人數（含沒有 mail 與重複的）
 *   withoutEmail  符合條件但沒有有效 mail 而被略過的人數——要讓承辦人看到，不能默默少寄
 *   duplicates    因為 mail 重複而合併掉的筆數
 */
export function pickRecipients(rows, { beat = '', outlet = '', recentOnly = false } = {}) {
  const kw = String(outlet || '').trim().toLowerCase();
  const people = [];
  const seen = new Set();
  let matched = 0, withoutEmail = 0, duplicates = 0;
  for (const r of rows || []) {
    if (r.status === 'left') continue;
    if (beat && r.beat !== beat) continue;
    if (kw && !String(r.outlet || '').toLowerCase().includes(kw)) continue;
    if (recentOnly) {
      const d = daysSince(r.last_invited);
      if (d === null || d > STALE_DAYS) continue;
    }
    matched++;
    const email = normalizeEmail(r.email);
    if (!email) { withoutEmail++; continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    people.push({ name: r.name, outlet: r.outlet, beat: r.beat, email });
  }
  return { people, matched, withoutEmail, duplicates };
}

/** 每批人數：非數字或 < 1 用預設，超過上限就壓在上限。 */
export function clampBatchSize(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(v, MAX_BATCH_SIZE);
}

/** Outlook 收件人欄用的字串。 */
export const outlookList = (emails) => emails.join('; ');

/** 把 mail 切成每批 size 個，每批附上可直接貼進 Outlook 的字串。 */
export function toBatches(emails, size = DEFAULT_BATCH_SIZE) {
  const n = clampBatchSize(size);
  const out = [];
  for (let i = 0; i < emails.length; i += n) {
    const part = emails.slice(i, i + n);
    out.push({ count: part.length, text: outlookList(part) });
  }
  return out;
}

// CSV 公式注入防護（批次 116）：開頭是 = + - @ Tab 歸位字元的補一個單引號，Excel 才不會把它當公式。
export const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * Outlook 通訊錄／Word 合併郵件用的 CSV：姓名、媒體、路線、電子郵件。
 * 開頭加 BOM，Excel 與 Outlook 匯入精靈才不會把中文讀成亂碼。
 */
export function buildOutlookCsv(people) {
  const header = ['姓名', '媒體', '路線', '電子郵件'];
  const body = people.map((p) => [p.name, p.outlet, p.beat, p.email]);
  return '﻿' + [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** 新增記者用的下一個 id：既有 N 開頭的最大編號 + 1（N0001、N0002…），不動匯入進來的 R 開頭 id。 */
export function nextRosterId(existingIds) {
  let max = 0;
  for (const id of existingIds || []) {
    const m = /^N(\d+)$/.exec(String(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'N' + String(max + 1).padStart(4, '0');
}
