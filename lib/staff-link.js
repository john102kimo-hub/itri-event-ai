// 同仁專屬連結（批次 209）：同仁不用後台密碼，拿一條連結就能看活動清單、新增活動、進編輯頁。
//
// 為什麼不是把後台密碼公開：後台能匯出全部個資、改機構資料、動 LINE 選單、封存活動。
// 同仁連結是「另一把、小很多的鑰匙」，而且這個界線寫在程式裡（只有下面兩支入口認它），不是靠頁面不顯示：
//   ✅ staff_list   看活動清單（名稱、日期、狀態、地點）＋各場的編輯、媒體訓練連結
//   ✅ staff_create 新增活動（一律是「未發布」草稿，發布仍要過原本的發布閘門）
//   ❌ 其餘一切（知識庫全文、問答紀錄、報名名單與個資、匯出、封存、刪除、LINE 選單）仍然只認管理員密碼。
//
// 連結長這樣：https://（網站）/staff#k=金鑰。金鑰放在 # 後面——瀏覽器不會把 # 後面的東西送給伺服器，
// 所以不會進伺服器存取紀錄；頁面讀到後用 header（X-Staff-Key）帶給 API，不放網址參數。
// 金鑰存在 Vercel 環境變數 STAFF_LINK_KEY：
//   - 沒設定、或短於 16 字 → 一律拒絕（fail-closed，跟 lib/auth.js 的 ADMIN_PASSWORD 同一個理由）。
//   - 連結外流了 → 換一個新值、重新部署，舊連結立刻失效。
// 比對、猜錯限流都走 lib/auth.js（固定時間比對；同一個來源猜錯太多次先擋 10 分鐘）。
import { readRange, appendRows } from './sheets.js';
import { EVENTS_RANGE, invalidateEventsTable } from './events-table.js';
import { generateId, generateEditCode } from './ids.js';
import { safeEqual, authBlocked, authFailed, tooManyAttempts } from './auth.js';
import { createLimiter, clientIp } from './rate-limit.js';

export const STAFF_KEY_MIN = 16;

let warned = false;
export function isStaffKey(given) {
  const key = process.env.STAFF_LINK_KEY;
  if (!key || key.length < STAFF_KEY_MIN) {
    if (!warned) { warned = true; console.error(`[staff-link] STAFF_LINK_KEY 沒有設定或短於 ${STAFF_KEY_MIN} 字：同仁連結一律拒絕。`); }
    return false;
  }
  return safeEqual(given, key);
}

export function staffKeyFrom(req) {
  const h = req?.headers?.['x-staff-key'];
  return typeof h === 'string' ? h.trim() : '';
}

function requireStaff(req, res) {
  if (authBlocked(req)) { tooManyAttempts(res); return false; }
  if (isStaffKey(staffKeyFrom(req))) return true;
  authFailed(req);
  res.status(401).json({ error: '這條連結已失效或不正確，請向管理員重新索取' });
  return false;
}

// 新增活動的限流：連結外流時，別人最多一個來源 10 分鐘建 15 筆草稿，不會把試算表灌爆。
const createLimit = createLimiter({ windowMs: 10 * 60_000, max: 15 });
export const resetStaffLinkLimiter = () => createLimit.reset();

const cleanName = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const cleanLine = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
// 日期只收 YYYY-MM-DD 而且是真的有這一天（2026-02-31 不算）；其餘當沒填
export function strictDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : '';
}

const editUrl = (id, code) => `/edit?id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;
// 媒體訓練（批次 211）：認的是同一把編輯碼，清單本來就附編輯連結，權限沒有變大
const trainingUrl = (id, code) => `/training?id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;

/** GET ?action=staff_list */
export async function handleStaffList(req, res) {
  if (!requireStaff(req, res)) return;
  try {
    const rows = await readRange(EVENTS_RANGE);
    const events = rows
      .filter((r) => r[0] && r[4] !== 'archived')
      .map((r) => ({
        id: r[0], name: r[1] || '', status: r[4] || 'active', event_date: r[5] || '', venue: r[12] || '',
        edit_url: r[10] ? editUrl(r[0], r[10]) : '',
        training_url: r[10] ? trainingUrl(r[0], r[10]) : ''
      }))
      .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ events });
  } catch (err) {
    console.error('[staff-link] 讀取活動失敗:', err.message);
    return res.status(500).json({ error: '暫時讀不到活動清單，請稍後再試' });
  }
}

/** POST {action:'staff_create', name, event_date?, venue?} → 新增一場「未發布」草稿 */
export async function handleStaffCreate(req, res) {
  if (!requireStaff(req, res)) return;
  const body = req.body || {};
  const name = cleanName(body.name);
  if (!name) return res.status(400).json({ error: '請填活動名稱' });
  if (createLimit.hit(clientIp(req))) return res.status(429).json({ error: '新增得太頻繁了，請稍候幾分鐘再試' });
  try {
    const id = generateId(name);
    const code = generateEditCode();
    const date = strictDate(body.event_date) || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    // 欄位順序見 api/events.js 檔頭：A id … E status(draft) F 日期 … J 主辦 K 編輯碼 … M 地點
    await appendRows('events!A:R', [[id, name, '#0F9E7A', '', 'draft', date, '', '', '', '工研院', code, '', cleanLine(body.venue, 200), '', '', '', '', '']]);
    invalidateEventsTable();
    return res.status(200).json({ success: true, id, status: 'draft', edit_url: editUrl(id, code) });
  } catch (err) {
    console.error('[staff-link] 新增活動失敗:', err.message);
    return res.status(500).json({ error: '新增失敗，請稍後再試；如果一直失敗請洽管理員' });
  }
}
