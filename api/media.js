// 記者名單健檢 API
//
// 背景：記者主檔累積 1,470 筆，但 88% 沒有「路線」欄位，且不知道誰已經離職／轉線——
// 這份資料只有這個平台上大家都能連到，同仁才有辦法幫忙補。
//
// ── 同仁（用團隊共用連結的 code，不需管理員密碼）────────────────────────
// GET  ?action=list&code=xxx           → 待確認名單（依重要性排序，每次給一批）
// GET  ?action=search&code=xxx&q=xxx   → 搜尋特定記者（辦活動前先查）
// POST {action:'update',code,id,...}   → 一鍵更新：補路線／標記離職／標記仍在職
//
// ── 管理員（需 ADMIN_PASSWORD）───────────────────────────────────────
// POST {action:'seed',password,csv}    → 貼上 CSV 一次性匯入／更新（用 id 對應，重覆貼不會炸掉）
// POST {action:'settings_save',password,revoke?,regenerate?} → 產生／收回同仁連結的 code
// GET  ?action=export&password=xxx     → 匯出全部名單 CSV
//
// 誠實邊界：這裡不猜記者現在跑什麼路線，只把「太久沒受邀」「從沒填過路線」的人
// 排到前面讓人判斷，是否還在職、路線是什麼，一律由人工按一下確認。

import { readRange, appendRows, updateRange, ensureSheets } from '../lib/sheets.js';

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

const CFG = { staffCode: null, loaded: false };
async function loadSettings() {
  if (CFG.loaded) return CFG;
  const rows = await safeRead('media_settings!A2:B');
  rows.forEach(([k, v]) => { if (k === 'staff_code') CFG.staffCode = String(v || '').trim() || null; });
  CFG.loaded = true;
  return CFG;
}
async function saveSetting(key, value) {
  await ensureSheets(SHEETS);
  const rows = await safeRead('media_settings!A2:B');
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) await updateRange(`media_settings!A${idx + 2}:B${idx + 2}`, [[key, value]]);
  else await appendRows('media_settings!A:B', [[key, value]]);
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

/** 需要人工確認：還在職名單裡、但路線空白或太久沒受邀 */
function needsReview(rec) {
  if (rec.status === 'left') return false;
  if (!rec.beat) return true;
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

async function authorize({ code, password }) {
  const admin = process.env.ADMIN_PASSWORD;
  if (password && admin && password === admin) return { ok: true, who: 'admin' };
  await loadSettings();
  if (!CFG.staffCode) return { ok: false, status: 401, msg: '這個功能還沒開放共用連結，請向承辦人索取' };
  if (!code || String(code) !== CFG.staffCode) {
    return { ok: false, status: 401, msg: '這條連結已失效，請向承辦人索取新的' };
  }
  return { ok: true, who: 'staff' };
}

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
      // 管理員密碼優先讀 header，避免留在網址列／瀏覽器歷史／伺服器存取紀錄裡（code 是同仁的
      // 共用連結碼，設計上本來就要能放在網址裡分享，維持走 query）
      const password = req.headers['x-admin-password'] || req.query.password;

      if (action === 'list') {
        const auth = await authorize({ code, password });
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
        const auth = await authorize({ code, password });
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
        if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
        const rows = await safeRead('media_roster!A2:N');
        const header = SHEETS.media_roster;
        const csv = [header, ...rows].map((row) =>
          row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="media_roster_${today()}.csv"`);
        return res.status(200).send('﻿' + csv);
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, code, password } = body;

      if (action === 'settings_save') {
        if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
        await ensureSheets(SHEETS);
        if (body.revoke) {
          await saveSetting('staff_code', '');
          CFG.staffCode = null;
          return res.status(200).json({ success: true, code: null });
        }
        let c = CFG.staffCode;
        if (!c || body.regenerate) {
          c = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
          await saveSetting('staff_code', c);
          CFG.staffCode = c;
        }
        return res.status(200).json({ success: true, code: c });
      }

      if (action === 'seed') {
        if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
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

        const existing = (await safeRead('media_roster!A2:N')).map(parseRow);
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
        // 整批覆寫（先清空再寫），避免用 append 造成同一 id 重複列
        const old = await safeRead('media_roster!A2:N');
        if (old.length) await updateRange(`media_roster!A2:N${old.length + 1}`, old.map(() => new Array(14).fill('')));
        if (rowsOut.length) await updateRange(`media_roster!A2:N${rowsOut.length + 1}`, rowsOut);

        return res.status(200).json({ success: true, created, updated, total: all.length });
      }

      // ── 以下需要同仁 code 或管理員密碼 ──
      const auth = await authorize({ code, password });
      if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

      if (action === 'update') {
        const { id, beat, mark, updated_by } = body;
        if (!id) return res.status(400).json({ error: '缺少記者 ID' });
        const rows = await safeRead('media_roster!A2:N');
        const i = rows.findIndex((r) => r[0] === id);
        if (i < 0) return res.status(404).json({ error: '找不到這筆記者資料' });

        const rec = parseRow(rows[i], i);
        if (beat !== undefined) rec.beat = beat;
        if (mark === 'left') rec.status = 'left';
        else if (mark === 'active') rec.status = 'active';
        rec.updated_at = now();
        rec.updated_by = (updated_by || '').slice(0, 20);

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
