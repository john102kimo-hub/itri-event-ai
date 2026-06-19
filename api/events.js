// 活動管理 API
// GET  ?action=list             → 所有活動（公開，不含知識庫）
// GET  ?action=get&id=xxx       → 單一活動含知識庫（需管理員密碼）
// POST {action:'create',...}    → 新增活動（需密碼）
// POST {action:'update',...}    → 更新活動（需密碼）
// POST {action:'archive',...}   → 封存活動（需密碼）

import { readRange, appendRows, updateRange } from './lib/sheets.js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminPassword = process.env.ADMIN_PASSWORD;

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, id, password } = req.query;
    try {
      const rows = await readRange('events!A2:I');

      if (action === 'get' && id) {
        if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
        const row = rows.find(r => r[0] === id);
        if (!row) return res.status(404).json({ error: '活動不存在' });
        return res.status(200).json({
          id: row[0], name: row[1], color: row[2] || '#0F9E7A',
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5],
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || ''
        });
      }

      // 預設：列表（不含知識庫，含 chips & images）
      const events = rows
        .filter(r => r[0] && r[4] !== 'archived')
        .map(r => ({
          id: r[0], name: r[1], color: r[2] || '#0F9E7A',
          status: r[4] || 'active', created_at: r[5] || '',
          chips: r[6] || '', images: r[7] || '', greeting: r[8] || ''
        }));
      return res.status(200).json({ events });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, password, id, name, color, knowledge_base, chips, status, images, greeting } = req.body || {};

    if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
    if (!action) return res.status(400).json({ error: '缺少 action 參數' });

    try {
      if (action === 'create') {
        if (!name) return res.status(400).json({ error: '活動名稱必填' });
        const newId = generateId(name);
        const created_at = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        await appendRows('events!A:I', [[
          newId, name, color || '#0F9E7A', knowledge_base || '', 'active', created_at, chips || '', images || '', greeting || ''
        ]]);
        return res.status(200).json({ success: true, id: newId });
      }

      if (action === 'update') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange('events!A2:I');
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const existing = rows[rowIndex];
        const updated = [
          id,
          name !== undefined ? name : (existing[1] || ''),
          color !== undefined ? color : (existing[2] || '#0F9E7A'),
          knowledge_base !== undefined ? knowledge_base : (existing[3] || ''),
          status !== undefined ? status : (existing[4] || 'active'),
          existing[5] || '',
          chips !== undefined ? chips : (existing[6] || ''),
          images !== undefined ? images : (existing[7] || ''),
          greeting !== undefined ? greeting : (existing[8] || '')
        ];
        await updateRange(`events!A${rowIndex + 2}:I${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true });
      }

      if (action === 'archive') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange('events!A2:I');
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const existing = rows[rowIndex];
        const updated = [existing[0], existing[1], existing[2], existing[3], 'archived', existing[5], existing[6] || '', existing[7] || '', existing[8] || ''];
        await updateRange(`events!A${rowIndex + 2}:I${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
