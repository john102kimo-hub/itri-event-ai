// 活動管理 API
// ── 公開 ──────────────────────────────────────────────────────────────
// GET  ?action=list                    → 所有活動（不含知識庫、不含編輯碼）
// GET  ?action=get_public&id=xxx       → 單一活動前台所需欄位（記者用）
// ── 同仁自助編輯（用每場專屬 edit_code，不需管理員密碼）────────────────
// GET  ?action=get_edit&id=xxx&code=yyy → 讀取單一活動可編輯內容（同仁用）
// POST {action:'update_edit',id,code,...} → 同仁更新自己那場的內容
// ── 管理員（需 ADMIN_PASSWORD）────────────────────────────────────────
// GET  ?action=get&id=xxx&password=..  → 單一活動含知識庫與編輯碼
// POST {action:'create',...}           → 新增活動（自動產生 edit_code）
// POST {action:'update',...}           → 更新活動
// POST {action:'archive',...}          → 封存活動
// POST {action:'ensure_edit_code',id}  → 確保該活動有 edit_code（沒有就補上），回傳

import { readRange, appendRows, updateRange } from './lib/sheets.js';

// events 表欄位：A id, B name, C color, D knowledge_base, E status,
//               F created_at, G chips, H images, I greeting, J organizer, K edit_code
const RANGE = 'events!A2:K';

function generateId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[一-龥]/g, '')   // 移除中文
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .substring(0, 20) || 'event';
  return `${slug}-${Date.now().toString(36)}`;
}

// 產生同仁編輯碼：16 碼英數，做為那一場的「編輯權杖」
function generateEditCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去除易混淆字元
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 同仁可編輯的內容欄位 → 組出完整 11 欄，狀態(E)與編輯碼(K)一律沿用既有值
function buildContentRow(existing, b) {
  const pick = (v, i, def) => (v !== undefined ? v : (existing[i] !== undefined ? existing[i] : def));
  return [
    existing[0],                                   // A id（不可改）
    pick(b.name, 1, ''),                            // B name
    pick(b.color, 2, '#0F9E7A'),                    // C color
    pick(b.knowledge_base, 3, ''),                  // D knowledge_base
    existing[4] || 'active',                        // E status（同仁不可改）
    pick(b.event_date, 5, ''),                      // F created_at / 活動日期
    pick(b.chips, 6, ''),                           // G chips
    pick(b.images, 7, ''),                          // H images
    pick(b.greeting, 8, ''),                        // I greeting
    pick(b.organizer, 9, '工研院'),                 // J organizer
    existing[10] || ''                              // K edit_code（不可改）
  ];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminPassword = process.env.ADMIN_PASSWORD;

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, id, password, code } = req.query;
    try {
      const rows = await readRange(RANGE);

      // 公開端點：只回傳單一活動前台所需欄位（不含知識庫、不需密碼）
      if (action === 'get_public' && id) {
        const row = rows.find(r => r[0] === id);
        if (!row || row[4] === 'archived') return res.status(404).json({ error: '活動不存在' });
        return res.status(200).json({
          event: {
            id: row[0], name: row[1], color: row[2] || '#0F9E7A',
            status: row[4] || 'active', created_at: row[5] || '',
            chips: row[6] || '', images: row[7] || '', greeting: row[8] || ''
          }
        });
      }

      // 同仁自助編輯：用 edit_code 讀取自己那一場（只回單一活動，不含編輯碼、不含分析）
      if (action === 'get_edit' && id) {
        const row = rows.find(r => r[0] === id);
        if (!row) return res.status(404).json({ error: '找不到這場活動，請確認連結是否正確' });
        if (!row[10] || String(code) !== String(row[10])) {
          return res.status(401).json({ error: '編輯碼錯誤，請向承辦人索取正確的編輯連結' });
        }
        if (row[4] === 'archived') return res.status(403).json({ error: '這場活動已封存，如需修改請聯絡承辦人' });
        return res.status(200).json({
          id: row[0], name: row[1], color: row[2] || '#0F9E7A',
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5] || '',
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || '', organizer: row[9] || '工研院'
        });
      }

      // 管理員：單一活動含知識庫與編輯碼
      if (action === 'get' && id) {
        if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
        const row = rows.find(r => r[0] === id);
        if (!row) return res.status(404).json({ error: '活動不存在' });
        return res.status(200).json({
          id: row[0], name: row[1], color: row[2] || '#0F9E7A',
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5],
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || '', organizer: row[9] || '工研院',
          edit_code: row[10] || ''
        });
      }

      // 預設：列表（不含知識庫、不含編輯碼）
      const events = rows
        .filter(r => r[0] && r[4] !== 'archived')
        .map(r => ({
          id: r[0], name: r[1], color: r[2] || '#0F9E7A',
          status: r[4] || 'active', created_at: r[5] || '',
          chips: r[6] || '', images: r[7] || '', greeting: r[8] || '', organizer: r[9] || '工研院'
        }));
      return res.status(200).json({ events });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action } = body;
    if (!action) return res.status(400).json({ error: '缺少 action 參數' });

    try {
      // ── 同仁自助編輯：用 edit_code 驗證，不需管理員密碼 ──────────────
      if (action === 'update_edit') {
        const { id, code } = body;
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        if (!code) return res.status(400).json({ error: '缺少編輯碼' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '找不到這場活動' });
        const existing = rows[rowIndex];
        if (!existing[10] || String(code) !== String(existing[10])) {
          return res.status(401).json({ error: '編輯碼錯誤，無法儲存' });
        }
        if (existing[4] === 'archived') {
          return res.status(403).json({ error: '這場活動已封存，無法修改' });
        }
        const updated = buildContentRow(existing, body);
        await updateRange(`events!A${rowIndex + 2}:K${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true });
      }

      // ── 以下皆需管理員密碼 ────────────────────────────────────────────
      const { password, id, name, color, knowledge_base, chips, status, images, event_date, greeting, organizer } = body;
      if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });

      if (action === 'create') {
        if (!name) return res.status(400).json({ error: '活動名稱必填' });
        const newId = generateId(name);
        const created_at = event_date || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const editCode = generateEditCode();
        await appendRows('events!A:K', [[
          newId, name, color || '#0F9E7A', knowledge_base || '', 'active', created_at,
          chips || '', images || '', greeting || '', organizer || '工研院', editCode
        ]]);
        return res.status(200).json({ success: true, id: newId, edit_code: editCode });
      }

      if (action === 'update') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const existing = rows[rowIndex];
        const updated = [
          id,
          name !== undefined ? name : (existing[1] || ''),
          color !== undefined ? color : (existing[2] || '#0F9E7A'),
          knowledge_base !== undefined ? knowledge_base : (existing[3] || ''),
          status !== undefined ? status : (existing[4] || 'active'),
          event_date !== undefined ? event_date : (existing[5] || ''),
          chips !== undefined ? chips : (existing[6] || ''),
          images !== undefined ? images : (existing[7] || ''),
          greeting !== undefined ? greeting : (existing[8] || ''),
          organizer !== undefined ? organizer : (existing[9] || '工研院'),
          existing[10] || generateEditCode()   // 舊活動若無編輯碼，順手補上
        ];
        await updateRange(`events!A${rowIndex + 2}:K${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true, edit_code: updated[10] });
      }

      if (action === 'archive') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const e = rows[rowIndex];
        const updated = [e[0], e[1], e[2], e[3], 'archived', e[5], e[6] || '', e[7] || '', e[8] || '', e[9] || '工研院', e[10] || ''];
        await updateRange(`events!A${rowIndex + 2}:K${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true });
      }

      // 確保該活動有編輯碼（提供給後台「複製同仁編輯連結」按鈕，含相容舊活動）
      if (action === 'ensure_edit_code') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const existing = rows[rowIndex];
        let editCode = existing[10];
        if (!editCode) {
          editCode = generateEditCode();
          await updateRange(`events!K${rowIndex + 2}`, [[editCode]]);
        }
        return res.status(200).json({ success: true, edit_code: editCode });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
