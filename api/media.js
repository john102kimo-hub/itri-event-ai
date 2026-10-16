// 記者名單健檢 API
//
// 背景：記者主檔累積 1,470 筆，但 88% 沒有「路線」欄位，且不知道誰已經離職／轉線——
// 這份資料只有這個平台上大家都能連到，同仁才有辦法幫忙補。
//
// ── 同仁（用團隊共用連結的 code，不需管理員密碼）────────────────────────
// GET  ?action=list&code=xxx           → 待確認名單（依重要性排序，每次給一批）
// GET  ?action=search&code=xxx&q=xxx   → 搜尋特定記者（辦活動前先查）
// POST {action:'update',code,id,...}   → 一鍵更新：補路線／標記離職／標記仍在職
// POST {action:'add',code,name,outlet,email,beat?,phone?,title?} → 新增一位記者（批次 137，不用編 id、不用貼 CSV）
// POST {action:'card_scan',code,image}  → 名片翻拍：AI 讀出姓名／媒體／mail／電話，並比對名單裡是不是已經有這個人（批次 140）
// POST card_match（不呼叫 AI）           → 同仁改過讀出來的欄位後，重新比對一次
// POST {action:'update_contact',code,id,name?,outlet?,email?,phone?,title?,mark?} → 用名片上的新資料更新既有記者（批次 140）
//
// ── 管理員（需 ADMIN_PASSWORD）───────────────────────────────────────
// POST {action:'seed',password,csv}    → 貼上 CSV 一次性匯入／更新（用 id 對應，重覆貼不會炸掉）
// POST {action:'settings_save',password,revoke?,regenerate?} → 產生／收回同仁連結的 code
// GET  ?action=export                  → 匯出全部名單 CSV（管理員，header X-Admin-Password）
// GET  ?action=pick&beat=&outlet=&recent=1&size=50 → 挑收件人：照路線／媒體／最近受邀篩出有 mail 的在職記者，
//                                        mail 串成 Outlook 收件人欄的格式並分批（管理員，批次 137）
// GET  ?action=export_outlook&…(同 pick) → 挑出來的人匯成 Outlook 通訊錄／合併郵件用的 CSV（管理員，批次 137）
//
// 誠實邊界：這裡不猜記者現在跑什麼路線，只把「太久沒受邀」「從沒填過路線」的人
// 排到前面讓人判斷，是否還在職、路線是什麼，一律由人工按一下確認。

import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';
import { adminAttempt, requireAdmin, passwordFrom, codeMatches, authFailed } from '../lib/auth.js';
import { generateShareCode } from '../lib/ids.js';
import { pickRecipients, toBatches, clampBatchSize, buildOutlookCsv, csvCell, normalizeEmail, nextRosterId } from '../lib/media-pick.js';
import { parseImageInput, scanCard, matchRoster, diffCard, cleanPhone, maskEmail, maskPhone } from '../lib/card-scan.js';
import { createLimiter, clientIp } from '../lib/rate-limit.js';

const SHEETS = {
  media_roster: [
    'id', 'name', 'outlet', 'beat', 'email', 'phone',
    'invited_count', 'confirmed_count', 'declined_count', 'last_invited',
    'status', 'note', 'updated_at', 'updated_by',
  ],
  media_settings: ['key', 'value'],
};

const STALE_DAYS = 365;
const BATCH_SIZE = 25;
const BEATS = ['半導體', '生醫', 'AI／資通訊', '淨零／能源', '機器人／智慧製造', '材料化學', '財經／產業', '一般'];

const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

async function safeRead(range) {
  try { return await readRange(range); } catch { return []; }
}

// 設定快取 60 秒（批次 116）。以前是「這台機器讀過一次就永遠不再讀」：後台按「收回共用連結」
// 只改得到按的那一台，其他還熱著的機器照樣放行舊連結，直到它們自己冷啟動——收回等於沒收回。
// 跟活動表快取同一個尺度：別台最多晚一分鐘生效。讀不到時沿用手上的值，不要因為一次 Sheets 逾時把連結全關掉。
const SETTINGS_TTL_MS = 60_000;
const CFG = { staffCode: null, loadedAt: 0 };
async function loadSettings() {
  if (CFG.loadedAt && Date.now() - CFG.loadedAt < SETTINGS_TTL_MS) return CFG;
  try {
    const rows = await readRange('media_settings!A2:B');
    CFG.staffCode = null;
    rows.forEach(([k, v]) => { if (k === 'staff_code') CFG.staffCode = String(v || '').trim() || null; });
  } catch { /* 分頁還沒建、或暫時讀不到：沿用手上的 */ }
  CFG.loadedAt = Date.now();
  return CFG;
}
async function saveSetting(key, value) {
  await ensureSheets(SHEETS);
  const rows = await safeRead('media_settings!A2:B');
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) await updateRange(`media_settings!A${idx + 2}:B${idx + 2}`, [[key, value]]);
  else await appendRows('media_settings!A:B', [[key, value]]);
}

// 名片辨識每次都是一次付費的 AI 呼叫，而同仁共用連結是設計成會外流的（見 authorize()）。
// 跟其他限流一樣是 best-effort（單一 instance 的記憶體）；真正的上限是 Anthropic Console 的月花費上限。
const scanLimiter = createLimiter({ windowMs: 10 * 60_000, max: 40 });

// 名片比對結果。同仁（共用連結）看到的「名單裡已有的 mail／電話」遮一半：認得出是不是同一個人，但抄不走
// （批次 137：mail 是個資，連結外流不能撈走整份名單）。管理員看全部。
function describeMatches(rows, card, isAdmin) {
  return matchRoster(rows, card).map(({ rec, reason }) => {
    const m = (field, v) => (isAdmin ? v : field === 'email' ? maskEmail(v) : field === 'phone' ? maskPhone(v) : v);
    return {
      id: rec.id, reason, status: rec.status,
      name: rec.name, outlet: rec.outlet, beat: rec.beat,
      email: m('email', rec.email), phone: m('phone', rec.phone),
      changes: diffCard(rec, card).map((c) => ({ field: c.field, from: m(c.field, c.from), to: c.to })),
    };
  });
}

const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

function parseRow(r, i) {
  return {
    rowNum: i + 2,
    id: r[0] || '', name: r[1] || '', outlet: r[2] || '', beat: r[3] || '',
    email: r[4] || '', phone: r[5] || '',
    invited_count: Number(r[6]) || 0, confirmed_count: Number(r[7]) || 0, declined_count: Number(r[8]) || 0,
    last_invited: r[9] || '', status: r[10] || 'active', note: r[11] || '',
    updated_at: r[12] || '', updated_by: r[13] || '',
  };
}

// 最近一次有人確認（按「還在跑，資料正確」、恢復在職）是幾天前。updated_at 是 now() 寫的
// 「2026/10/11 14:30:00」；讀不出來就當作沒確認過。
function confirmedDaysAgo(rec) {
  const m = String(rec.updated_at || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
}

/** 需要人工確認：還在職名單裡、但路線空白或太久沒受邀 */
// 批次 124：一年內有人確認過的不再列進來。以前只看路線與受邀日期——同仁按了「還在跑，資料正確」，
// 那一筆只是從畫面上淡出，「太久沒受邀」的條件沒變，下次打開又排在最前面，確認了等於白做，
// 「資料會愈用愈準」從來不成立。路線還是空的仍然要確認（頁面也要求先點路線才按得了確認）。
function needsReview(rec) {
  if (rec.status === 'left') return false;
  if (!rec.beat) return true;
  const c = confirmedDaysAgo(rec);
  if (c !== null && c <= STALE_DAYS) return false;
  const d = daysSince(rec.last_invited);
  if (d === null) return true;
  return d > STALE_DAYS;
}

function priority(rec) {
  // 受邀次數愈多、代表這筆資料愈重要（該優先花時間確認）
  let score = rec.invited_count * 10;
  if (!rec.beat) score += 5;
  const d = daysSince(rec.last_invited);
  if (d !== null) score += Math.min(d / 30, 24); // 愈久沒受邀分數愈高，封頂 24 個月
  return score;
}

async function authorize({ code, password }, req) {
  // 批次 116：先看限流、密碼帶錯也記失敗（見 lib/auth.js adminAttempt()）
  const who = adminAttempt(req, password);
  if (who === 'blocked') return { ok: false, status: 429, msg: '嘗試的次數太多了，請 10 分鐘後再試。' };
  if (who === 'admin') return { ok: true, who: 'admin' };
  await loadSettings();
  if (!CFG.staffCode) {
    if (code) authFailed(req);
    return { ok: false, status: 401, msg: '這個功能還沒開放共用連結，請向承辦人索取' };
  }
  if (!codeMatches(code, CFG.staffCode)) {
    authFailed(req);
    return { ok: false, status: 401, msg: '這條連結已失效，請向承辦人索取新的' };
  }
  return { ok: true, who: 'staff' };
}

// CSV 公式注入防護（批次 116）住在 lib/media-pick.js 的 csvCell()（批次 137 搬過去，匯出名單與 Outlook CSV 共用同一支）。

/** 極簡 CSV 解析：逗號分隔、雙引號括住可含逗號的欄位。給管理員一次性貼資料用，不追求處理所有 Excel 怪狀況。 */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await loadSettings();

    if (req.method === 'GET') {
      const { action, code, q } = req.query;
      // 管理員密碼只收 header（批次 110 起不再讀網址）。code 是同仁的共用連結碼，
      // 設計上本來就要能放在網址裡分享，維持走 query。
      const password = passwordFrom(req);

      if (action === 'list') {
        const auth = await authorize({ code, password }, req);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const review = rows.filter(needsReview).sort((a, b) => priority(b) - priority(a));
        const active = rows.filter((r) => r.status !== 'left');

        return res.status(200).json({
          totalActive: active.length,
          totalNeedsReview: review.length,
          totalWithBeat: active.filter((r) => r.beat).length,
          beats: BEATS,
          showing: Math.min(BATCH_SIZE, review.length),
          needsReview: review.slice(0, BATCH_SIZE).map((r) => ({
            id: r.id, name: r.name, outlet: r.outlet, beat: r.beat,
            invited_count: r.invited_count, last_invited: r.last_invited,
            daysSince: daysSince(r.last_invited),
          })),
        });
      }

      if (action === 'search') {
        const auth = await authorize({ code, password }, req);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });
        const kw = String(q || '').trim();
        if (kw.length < 1) return res.status(200).json({ results: [] });
        const rows = (await safeRead('media_roster!A2:N')).map(parseRow);
        const results = rows.filter((r) => r.name.includes(kw) || r.outlet.includes(kw)).slice(0, 20)
          .map((r) => ({
            id: r.id, name: r.name, outlet: r.outlet, beat: r.beat, status: r.status,
            invited_count: r.invited_count, last_invited: r.last_invited,
          }));
        return res.status(200).json({ results });
      }

      if (action === 'export') {
        if (!requireAdmin(req, res, password)) return;
        const rows = await safeRead('media_roster!A2:N');
        const header = SHEETS.media_roster;
        const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="media_roster_${today()}.csv"`);
        return res.status(200).send('﻿' + csv);
      }

      // 挑收件人（批次 137）：mail 是個資，只給管理員；同仁共用連結看不到（連結外流也撈不走整份 mail）。
      if (action === 'pick' || action === 'export_outlook') {
        if (!requireAdmin(req, res, password)) return;
        const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗要報錯，不能當成「沒有人」
        const picked = pickRecipients(rows, {
          beat: String(req.query.beat || ''), outlet: String(req.query.outlet || '').slice(0, 30),
          recentOnly: req.query.recent === '1',
        });
        if (action === 'export_outlook') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="outlook_contacts_${today()}.csv"`);
          return res.status(200).send(buildOutlookCsv(picked.people));
        }
        const size = clampBatchSize(req.query.size);
        return res.status(200).json({
          matched: picked.matched, withoutEmail: picked.withoutEmail, duplicates: picked.duplicates,
          total: picked.people.length, batchSize: size,
          batches: toBatches(picked.people.map((p) => p.email), size),
          people: picked.people,
        });
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, code } = body;
      const password = passwordFrom(req);

      if (action === 'settings_save') {
        if (!requireAdmin(req, res, password)) return;
        await ensureSheets(SHEETS);
        if (body.revoke) {
          await saveSetting('staff_code', '');
          CFG.staffCode = null;
          CFG.loadedAt = Date.now();
          return res.status(200).json({ success: true, code: null });
        }
        let c = CFG.staffCode;
        if (!c || body.regenerate) {
          c = generateShareCode(); // 批次 116：密碼學亂數，不用 Math.random()
          await saveSetting('staff_code', c);
          CFG.staffCode = c;
          CFG.loadedAt = Date.now();
        }
        return res.status(200).json({ success: true, code: c });
      }

      if (action === 'seed') {
        if (!requireAdmin(req, res, password)) return;
        const { csv } = body;
        if (!csv || !csv.trim()) return res.status(400).json({ error: '沒有收到 CSV 內容' });
        await ensureSheets(SHEETS);

        const parsed = parseCsv(csv);
        if (parsed.length < 2) return res.status(422).json({ error: 'CSV 至少要有標題列加一列資料' });
        const header = parsed[0].map((h) => h.trim());
        const idx = (name) => header.indexOf(name);
        const need = ['id', 'name', 'outlet'];
        for (const n of need) {
          if (idx(n) < 0) return res.status(422).json({ error: `CSV 缺少必要欄位：${n}` });
        }

        // ⚠️ 這裡用 readRange，不用 safeRead（批次 82）：safeRead 讀失敗會回空陣列，匯入就會
        // 以為「目前一個記者都沒有」，接著把新名單從第 2 列起整片蓋上去——既有記者的
        // 路線、離職標記、備註全部被別人的資料覆蓋。讀不到就停下來請他再試一次。
        const existing = (await readRange('media_roster!A2:N')).map(parseRow);
        const byId = new Map(existing.map((r) => [r.id, r]));
        let created = 0, updated = 0;

        for (const cells of parsed.slice(1)) {
          const id = cells[idx('id')] || '';
          if (!id) continue;
          const incoming = {
            id, name: cells[idx('name')] || '', outlet: cells[idx('outlet')] || '',
            beat: idx('beat') >= 0 ? cells[idx('beat')] || '' : '',
            email: idx('email') >= 0 ? cells[idx('email')] || '' : '',
            phone: idx('phone') >= 0 ? cells[idx('phone')] || '' : '',
            invited_count: idx('invited_count') >= 0 ? Number(cells[idx('invited_count')]) || 0 : 0,
            confirmed_count: idx('confirmed_count') >= 0 ? Number(cells[idx('confirmed_count')]) || 0 : 0,
            declined_count: idx('declined_count') >= 0 ? Number(cells[idx('declined_count')]) || 0 : 0,
            last_invited: idx('last_invited') >= 0 ? cells[idx('last_invited')] || '' : '',
          };
          const prior = byId.get(id);
          if (prior) {
            // 既有的路線／狀態／備註是人工填的，匯入不覆蓋；只補資料本身（受邀次數等）
            byId.set(id, {
              ...prior, ...incoming,
              beat: prior.beat || incoming.beat, status: prior.status, note: prior.note,
            });
            updated++;
          } else {
            byId.set(id, { ...incoming, status: 'active', note: '', updated_at: '', updated_by: '' });
            created++;
          }
        }

        const all = [...byId.values()];
        const rowsOut = all.map((r) => [
          r.id, r.name, r.outlet, r.beat, r.email, r.phone,
          r.invited_count, r.confirmed_count, r.declined_count, r.last_invited,
          r.status, r.note, r.updated_at, r.updated_by,
        ]);
        // 整批覆寫（不用 append，避免同一 id 重複列）。⚠️ 一次寫完，不要「先清空再寫」
        // （批次 82）：兩步寫法在第二步失敗時整份記者名單歸零。現在是新名單補滿、比舊名單
        // 短的部分補空白，同一個 values.update 一起送出，要嘛全部換成新的、要嘛完全沒動。
        const old = await readRange('media_roster!A2:N');
        const height = Math.max(old.length, rowsOut.length);
        const blank = () => new Array(14).fill('');
        const full = [...rowsOut.map((r) => [...r, ...blank()].slice(0, 14)),
          ...Array.from({ length: height - rowsOut.length }, blank)];
        if (height) await updateRange(`media_roster!A2:N${height + 1}`, full);

        return res.status(200).json({ success: true, created, updated, total: all.length });
      }

      // ── 以下需要同仁 code 或管理員密碼 ──
      const auth = await authorize({ code, password }, req);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

      // 新增一位記者（批次 137）：姓名、媒體、mail 必填，路線選填。id 由系統編（N0001…），不用自己想。
      if (action === 'add') {
        const name = String(body.name || '').trim().slice(0, 40);
        const outlet = String(body.outlet || '').trim().slice(0, 60);
        const beat = String(body.beat || '').trim();
        const rawEmail = String(body.email || '').trim();
        const rawPhone = String(body.phone || '').trim();
        const phone = rawPhone ? cleanPhone(rawPhone) : '';
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (rawPhone && !phone) return res.status(400).json({ error: '電話格式看起來不對，請再確認（至少要有 6 碼數字）' });
        if (!name) return res.status(400).json({ error: '請填記者姓名' });
        if (!outlet) return res.status(400).json({ error: '請填媒體名稱' });
        const email = normalizeEmail(rawEmail);
        if (!email) return res.status(400).json({ error: 'mail 格式看起來不對，請再確認（例如 name@example.com）' });
        if (beat && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        await ensureSheets(SHEETS);
        // 用 readRange、不用 safeRead：讀失敗時 safeRead 回空陣列，會以為名單是空的而編出重複的 id、也查不到重複的 mail
        const existing = (await readRange('media_roster!A2:N')).map(parseRow);
        const dup = existing.find((r) => normalizeEmail(r.email) === email);
        if (dup) {
          return res.status(409).json({
            error: `這個 mail 已經在名單裡了：${dup.name}（${dup.outlet}）${dup.status === 'left' ? '，目前標記為已離職，可以用上面的搜尋找到他再按「恢復在職」' : ''}`,
            duplicate: { id: dup.id, name: dup.name, outlet: dup.outlet, status: dup.status },
          });
        }
        const id = nextRosterId(existing.map((r) => r.id));
        await appendRows('media_roster!A:N', [[
          id, name, outlet, beat, email, phone, 0, 0, 0, '', 'active', title ? `職稱：${title}` : '', now(), String(body.updated_by || '').slice(0, 20),
        ]]);
        return res.status(200).json({ success: true, id });
      }

      // 名片翻拍（批次 140）：照片 → AI 讀出欄位 → 比對名單。這一步**不寫任何東西**，讀出來的只是草稿，
      // 人看過、按了「新增」或「更新」才會走 add／update_contact（那兩條有自己的格式與重複檢查）。
      if (action === 'card_scan') {
        if (scanLimiter.hit(clientIp(req))) return res.status(429).json({ error: '短時間內辨識太多張了，請 10 分鐘後再試，或先手動填寫' });
        const img = parseImageInput(body.image);
        if (img.error) return res.status(400).json({ error: img.error });
        const r = await scanCard(img);
        if (r.error) return res.status(r.status || 422).json({ error: r.error });
        // 比對失敗（Sheets 讀不到）不該讓辨識結果跟著報廢：照片已經花了一次 AI 呼叫，先把草稿給人，比對標成沒做
        let matches = [], matchError = '';
        try { matches = describeMatches((await readRange('media_roster!A2:N')).map(parseRow), r.card, auth.who === 'admin'); }
        catch { matchError = '暫時查不到名單，無法比對是否已經有這位，請稍後按「重新比對」'; }
        return res.status(200).json({ card: r.card, matches, matchError });
      }

      if (action === 'card_match') {
        const card = {
          name: String(body.name || '').trim().slice(0, 40), outlet: String(body.outlet || '').trim().slice(0, 60),
          email: normalizeEmail(body.email), phone: cleanPhone(body.phone),
        };
        const rows = (await readRange('media_roster!A2:N')).map(parseRow); // 讀失敗要報錯，不能當成「名單裡沒有這個人」
        return res.status(200).json({ matches: describeMatches(rows, card, auth.who === 'admin') });
      }

      // 用名片上的新資料更新既有記者。只動有帶值的欄位（名片上沒有的欄位不會把名單原有的值洗掉）。
      if (action === 'update_contact') {
        const { id, mark } = body;
        if (!id) return res.status(400).json({ error: '缺少記者 ID' });
        const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const outlet = String(body.outlet || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const rawEmail = String(body.email || '').trim();
        const rawPhone = String(body.phone || '').trim();
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const email = rawEmail ? normalizeEmail(rawEmail) : '';
        const phone = rawPhone ? cleanPhone(rawPhone) : '';
        if (rawEmail && !email) return res.status(400).json({ error: 'mail 格式看起來不對，請再確認（例如 name@example.com）' });
        if (rawPhone && !phone) return res.status(400).json({ error: '電話格式看起來不對，請再確認（至少要有 6 碼數字）' });
        if (!name && !outlet && !email && !phone && !title && mark !== 'active') return res.status(400).json({ error: '沒有要更新的內容' });
        await ensureSheets(SHEETS);
        // 用 readRange、不用 safeRead：讀失敗時 safeRead 回空陣列，會變成「找不到這筆」或查不到別人已經用了這個 mail
        const rows = (await readRange('media_roster!A2:N')).map(parseRow);
        const rec = rows.find((r) => r.id === id);
        if (!rec) return res.status(404).json({ error: '找不到這筆記者資料' });
        if (email) {
          const dup = rows.find((r) => r.id !== id && normalizeEmail(r.email) === email);
          if (dup) return res.status(409).json({ error: `這個 mail 已經是另一位的了：${dup.name}（${dup.outlet}），請先確認是不是重複建了兩筆`, duplicate: { id: dup.id, name: dup.name, outlet: dup.outlet, status: dup.status } });
        }
        if (name) rec.name = name;
        if (outlet) rec.outlet = outlet;
        if (email) rec.email = email;
        if (phone) rec.phone = phone;
        if (title && !rec.note) rec.note = `職稱：${title}`; // note 是人工填的，已經有內容就不蓋
        if (mark === 'active') rec.status = 'active';
        rec.updated_at = now();
        rec.updated_by = String(body.updated_by || '').slice(0, 20);
        await updateRange(`media_roster!A${rec.rowNum}:N${rec.rowNum}`, [[
          rec.id, rec.name, rec.outlet, rec.beat, rec.email, rec.phone,
          rec.invited_count, rec.confirmed_count, rec.declined_count, rec.last_invited,
          rec.status, rec.note, rec.updated_at, rec.updated_by,
        ]]);
        return res.status(200).json({ success: true });
      }

      if (action === 'update') {
        const { id, beat, mark, updated_by } = body;
        if (!id) return res.status(400).json({ error: '缺少記者 ID' });
        // 路線只收選單上那幾個（批次 116）：頁面只給這幾顆按鈕，其他值只會是有人直接打 API
        if (beat !== undefined && beat !== '' && !BEATS.includes(beat)) return res.status(400).json({ error: '路線請從選項裡挑' });
        const rows = await safeRead('media_roster!A2:N');
        const i = rows.findIndex((r) => r[0] === id);
        if (i < 0) return res.status(404).json({ error: '找不到這筆記者資料' });

        const rec = parseRow(rows[i], i);
        if (beat !== undefined) rec.beat = beat;
        if (mark === 'left') rec.status = 'left';
        else if (mark === 'active') rec.status = 'active';
        rec.updated_at = now();
        rec.updated_by = String(updated_by || '').slice(0, 20);

        await updateRange(`media_roster!A${rec.rowNum}:N${rec.rowNum}`, [[
          rec.id, rec.name, rec.outlet, rec.beat, rec.email, rec.phone,
          rec.invited_count, rec.confirmed_count, rec.declined_count, rec.last_invited,
          rec.status, rec.note, rec.updated_at, rec.updated_by,
        ]]);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
