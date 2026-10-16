// 記者名片翻拍（批次 140）——拍一張名片，讀出姓名／媒體／職稱／mail／電話，比對名單裡是不是已經有這個人。
//
// 這支只放「純邏輯＋一個 fetch 包裝」，不碰 Google Sheets（api/media.js 負責讀寫名單）：
//   - 圖片檢查：parseImageInput()——只收 jpeg／png／webp／gif，大小有上限，檔頭要跟宣稱的格式對得上
//   - 請求與解析：buildCardRequest()／parseCardReply()／cleanCard()——模型讀出來的字一律當「草稿」，不直接進名單
//   - 比對名單：matchRoster()／diffCard()／maskEmail()／maskPhone()
//   - 實際呼叫：scanCard()
//
// 刻意的決定：
//   - 讀出來的東西**一律先給人看、人按了才寫進名單**。OCR 把 l 讀成 1、少一個字的 mail 寄出去就是寄丟，
//     所以 api/media.js 的新增／更新仍然走原本的格式檢查（normalizeEmail）與重複檢查，不信模型的輸出。
//   - 讀不到的欄位留空字串，不猜。prompt 也這樣要求，但 cleanCard() 不靠 prompt：mail 不是 mail 格式就清掉。
//   - 更新只會「補上／改成新的」，名片上沒有的欄位不會把名單裡原有的值洗掉（diffCard() 只看名片上有值的欄位）。

import { normalizeEmail } from './media-pick.js';
import { toTraditionalTW } from './zh-tw.js';
import { isRefusal, logRefusal } from './ai-refusal.js';
import { logAiUsage } from './ai-usage.js';
import { reportAiFailure } from './ai-alert.js';

export const CARD_MODEL = 'claude-haiku-5-5';
// 前端會先縮到長邊 1600px、轉成 JPEG（通常 300～600 KB）。Vercel 的請求 body 上限 4.5 MB，base64 約膨脹 33%，
// 所以原始檔上限抓 3 MB（base64 後約 4 MB），再大也不是縮過的圖，直接請他重拍。
export const MAX_IMAGE_BYTES = 3_000_000;
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// 檔頭（magic bytes）要跟宣稱的格式對得上。不是為了防駭，是為了「選錯檔」時早點講清楚，
// 而不是把一個 PDF 送去給模型、白花一次呼叫還拿到一句莫名其妙的錯誤。
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

/** 收前端送來的圖：純 base64 或 data URL 都收。回 { mime, b64 } 或 { error }。 */
export function parseImageInput(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '沒有收到照片' };
  let claimed = '';
  const m = /^data:([\w/+.-]+);base64,/i.exec(s);
  if (m) { claimed = m[1].toLowerCase(); s = s.slice(m[0].length); }
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return { error: '照片格式讀不出來，請重拍或換一張' };
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 100) return { error: '照片看起來是空的，請重拍或換一張' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: '照片太大了，請重拍或換一張較小的（建議直接用手機拍，不要用原始大圖）' };
  const real = sniff(buf);
  if (!real || !MIME_OK.has(real)) return { error: '只收照片檔（JPG、PNG、WebP、GIF）' };
  if (claimed && MIME_OK.has(claimed) && claimed !== real) return { error: '照片格式讀不出來，請重拍或換一張' };
  return { mime: real, b64: s };
}

const SYSTEM = [
  '你是名片辨識助手。照片是一張記者或媒體人的名片（可能是翻拍、有反光或歪斜）。請把名片上的資料抄成 JSON。',
  '只輸出一個 JSON 物件，不要任何說明、不要 Markdown 程式碼框。格式：',
  '{"name":"","outlet":"","title":"","email":"","phone":""}',
  '規則：',
  '1. name 是人名；outlet 是媒體或公司名稱（例如「經濟日報」），不要把部門塞進來；title 是職稱（例如「產業中心 記者」）。',
  '2. email 只抄名片上印的那一個；有好幾個就抄第一個個人的，不要抄公司總機信箱。phone 抄手機優先，沒有手機才抄辦公室電話，只抄一個。',
  '3. 名片上沒有、看不清楚、或你不確定的欄位一律給空字串。**不要猜、不要根據媒體名稱推測 mail、不要補全看不到的字。**',
  '4. 名片上若有中英文並列，姓名與媒體以中文為主；只有英文就抄英文。',
  '5. 這張圖片若不是名片，全部欄位給空字串。',
  '6. 照名片上的字抄，不要把簡體字改掉或加註；轉換由系統處理。',
].join('\n');

export function buildCardRequest({ mime, b64 }) {
  return {
    model: CARD_MODEL,
    // Haiku 5.5 預設開 adaptive thinking，抄名片不需要，會吃掉 max_tokens（見 lib/router.js 的說明）
    thinking: { type: 'disabled' },
    max_tokens: 400,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: '請辨識這張名片。' },
      ],
    }],
  };
}

const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 電話：只留數字與 + - ( ) # 空白，最多 30 字；少於 6 個數字不像電話，清掉。 */
export function cleanPhone(raw) {
  const s = oneLine(raw, 60).replace(/[^\d+\-()#\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return s.replace(/\D/g, '').length >= 6 ? s : '';
}

/**
 * 模型讀出來的物件 → 乾淨的草稿。mail 不是 mail 格式就清掉（不信模型）；
 * 姓名／媒體／職稱過 toTraditionalTW({terms:false})：只轉字、不轉用語——它們是名稱，照原樣才對（批次 133）。
 */
export function cleanCard(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const tw = (v, max) => toTraditionalTW(oneLine(v, max), { terms: false });
  return {
    name: tw(o.name, 40),
    outlet: tw(o.outlet, 60),
    title: tw(o.title, 60),
    email: normalizeEmail(o.email),
    phone: cleanPhone(o.phone),
  };
}

export const isEmptyCard = (c) => !c || !(c.name || c.outlet || c.email || c.phone);

/** 解析 Messages API 的回應。回 { card } 或 { error }。 */
export function parseCardReply(data) {
  // 不能寫死 content[0]：可能先有 thinking 區塊（見 api/line.js askAnthropic()）
  const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: '這張照片米亞讀不出來，請重拍（光線亮一點、名片放正）或直接手動填寫' };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { error: '這張照片米亞讀不出來，請重拍（光線亮一點、名片放正）或直接手動填寫' }; }
  const card = cleanCard(parsed);
  if (isEmptyCard(card)) return { error: '照片裡沒有讀到名片資料，請確認拍的是名片、字清楚，或直接手動填寫' };
  return { card };
}

/** 實際呼叫模型。回 { card } 或 { error }（error 是可以直接給使用者看的繁體中文）。 */
export async function scanCard(image, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return { error: '還沒設定 AI 金鑰（ANTHROPIC_API_KEY），名片辨識暫時不能用，請先手動填寫', status: 503 };
  const WHERE = '名片辨識';
  let response, data;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(40_000),
      body: JSON.stringify(buildCardRequest(image)),
    });
    data = await response.json();
  } catch (e) {
    console.error('名片辨識失敗:', e.message);
    return { error: '名片辨識連線失敗，請稍後再試，或直接手動填寫', status: 502 };
  }
  logAiUsage(WHERE, CARD_MODEL, data?.usage);
  if (!response.ok) {
    await reportAiFailure({ status: response.status, message: data?.error?.message, where: WHERE });
    return { error: '名片辨識暫時叫不動，請稍後再試，或直接手動填寫', status: 502 };
  }
  // 拒答是 HTTP 200（批次 134）：content 可能是空的或只有一半，不能拿去解析
  if (isRefusal(data)) {
    logRefusal(WHERE, CARD_MODEL, data);
    return { error: '這張照片米亞讀不了，請重拍或直接手動填寫', status: 422 };
  }
  const r = parseCardReply(data);
  return r.error ? { error: r.error, status: 422 } : r;
}

// ── 比對名單 ───────────────────────────────────────────────────────────────

const squash = (s) => String(s || '').replace(/[\s·．.\-()（）]/g, '').toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

// 媒體名稱有沒有互相包含：「聯合報」vs「聯合報 udn」、「經濟日報」vs「經濟日報社」都算同一家。
// 短於 2 個字不比（一個字的包含關係沒有意義）。
function sameOutlet(a, b) {
  const x = squash(a), y = squash(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 名片 vs 名單：找出可能是同一個人的記錄，最多 5 筆，信心由高到低。
 *   email   mail 完全相同（最可靠）
 *   name_outlet  同名、同一家媒體
 *   name    同名但媒體不同——可能是轉職，也可能只是同名同姓，要人判斷
 * rows 是 parseRow() 之後的記者。已離職的也比對（轉職回來、或同一個人換了 mail，都要找得到，而不是再新增一筆重複的）。
 */
export function matchRoster(rows, card) {
  const mail = normalizeEmail(card?.email);
  const name = squash(card?.name);
  const out = [];
  for (const r of rows || []) {
    let reason = '';
    if (mail && normalizeEmail(r.email) === mail) reason = 'email';
    else if (name && squash(r.name) === name) reason = sameOutlet(r.outlet, card.outlet) ? 'name_outlet' : 'name';
    if (reason) out.push({ rec: r, reason });
  }
  const rank = { email: 0, name_outlet: 1, name: 2 };
  out.sort((a, b) => rank[a.reason] - rank[b.reason]);
  return out.slice(0, 5);
}

export const FIELD_LABELS = { name: '姓名', outlet: '媒體', email: '電子郵件', phone: '電話' };

/**
 * 名片上有值、而且跟名單不一樣的欄位。名片上沒有的欄位不列（不會洗掉名單原有的值）。
 * 回 [{ field, from, to }]；from 是名單現在的值（可能是空字串）。
 */
export function diffCard(rec, card) {
  const changes = [];
  const push = (field, from, to) => changes.push({ field, from: from || '', to });
  if (card?.name && squash(card.name) !== squash(rec.name)) push('name', rec.name, card.name);
  if (card?.outlet && squash(card.outlet) !== squash(rec.outlet)) push('outlet', rec.outlet, card.outlet);
  const mail = normalizeEmail(card?.email);
  if (mail && mail !== normalizeEmail(rec.email)) push('email', rec.email, mail);
  if (card?.phone && digits(card.phone) !== digits(rec.phone)) push('phone', rec.phone, card.phone);
  return changes;
}

// 同仁共用連結看得到「名單裡已有的 mail／電話」會破壞批次 137 的邊界（mail 是個資，連結外流不能撈走整份）。
// 比對結果給同仁時遮一半：認得出是不是同一個人，但抄不走。管理員看全部。
export function maskEmail(e) {
  const m = /^(.)(.*)@(.+)$/.exec(String(e || ''));
  return m ? `${m[1]}${'*'.repeat(Math.min(m[2].length, 4))}@${m[3]}` : '';
}
export function maskPhone(p) {
  const d = digits(p);
  return d.length >= 4 ? `${'*'.repeat(Math.min(d.length - 3, 6))}${d.slice(-3)}` : (d ? '***' : '');
}
