// 活動管理 API
// ── 公開 ──────────────────────────────────────────────────────────────
// GET  ?action=list                    → 所有活動（不含知識庫、不含編輯碼、不含 draft）
// GET  ?action=get_public&id=xxx       → 單一活動前台所需欄位（記者用，draft 一律 404）
// ── 同仁自助編輯（用每場專屬 edit_code，不需管理員密碼）────────────────
// GET  ?action=get_edit&id=xxx&code=yyy → 讀取單一活動可編輯內容（同仁用）
// POST {action:'update_edit',id,code,...} → 同仁更新自己那場的內容
// ── 管理員（需 ADMIN_PASSWORD）────────────────────────────────────────
// GET  ?action=get&id=xxx&password=..  → 單一活動含知識庫與編輯碼
// GET  ?action=list_admin&password=..  → 後台列表用（含 draft／archived，附 has_kb，不含知識庫全文）
// POST {action:'create',...}           → 新增活動（自動產生 edit_code，預設 status=draft）
// POST {action:'update',...}           → 更新活動（後台的「發布／收回」按鈕也是打這個，帶 status）
// POST {action:'archive',...}          → 封存活動
// POST {action:'ensure_edit_code',id}  → 確保該活動有 edit_code（沒有就補上），回傳

import { readRange, appendRows, updateRange } from '../lib/sheets.js';
import { generateId, generateEditCode } from '../lib/ids.js';
import { del } from '@vercel/blob';

// events 表欄位：A id, B name, C color, D knowledge_base, E status,
//               F created_at（實際存的是活動日期，欄名是舊的，見下方 event_date 別名）,
//               G chips, H images, I greeting, J organizer, K edit_code,
//               L event_time, M venue, N event_type, O press_contact,
//               P contacts（邀訪聯絡窗口分工；每行「關鍵字｜姓名｜電話｜LINE ID(選填)」，
//                 這支只負責存取原始字串，解析邏輯在 api/line.js 的 parseEventContacts()）
const RANGE = 'events!A2:P';

// Google Sheets 單一儲存格上限約 5 萬字元；留一點餘裕避免踩線寫入失敗
const KB_MAX_LEN = 45000;

// 活動狀態合法值：
//   draft    未發布——只有後台看得到，記者前台(get_public)、公開列表、event-page SSR
//            一律當不存在。給「活動框架先開好，內容還在填」用，見後台的「發布」按鈕。
//   active   進行中，對外公開。
//   ended    已結束（會觸發新聞稿全文開放搜尋引擎與 AI 收錄，見 event-page.js 的 isConcluded）。
//   archived 已封存（記者前台下架）。
// 同仁自助編輯與管理員共用同一份檢查，避免寫入允許值以外的字串。
const EVENT_STATUSES = ['draft', 'active', 'ended', 'archived'];

// 同仁可編輯的內容欄位 → 組出完整 16 欄，編輯碼(K)一律沿用既有值。
// 狀態(E) 開放同仁自行切換（未發布/進行中/已結束/已封存）；呼叫端須先用 EVENT_STATUSES
// 驗證過 b.status 是合法值（見 update_edit），這裡才會直接信任並寫入。
function buildContentRow(existing, b) {
  const pick = (v, i, def) => (v !== undefined ? v : (existing[i] !== undefined ? existing[i] : def));
  return [
    existing[0],                                   // A id（不可改）
    pick(b.name, 1, ''),                            // B name
    pick(b.color, 2, '#0F9E7A'),                    // C color
    pick(b.knowledge_base, 3, ''),                  // D knowledge_base
    pick(b.status, 4, 'active'),                    // E status（同仁可改）
    pick(b.event_date, 5, ''),                      // F created_at / 活動日期
    pick(b.chips, 6, ''),                           // G chips
    pick(b.images, 7, ''),                          // H images
    pick(b.greeting, 8, ''),                        // I greeting
    pick(b.organizer, 9, '工研院'),                 // J organizer
    existing[10] || '',                             // K edit_code（不可改）
    pick(b.event_time, 11, ''),                     // L event_time
    pick(b.venue, 12, ''),                          // M venue
    pick(b.event_type, 13, ''),                     // N event_type
    pick(b.press_contact, 14, ''),                  // O press_contact
    pick(b.contacts, 15, '')                        // P contacts（邀訪窗口分工）
  ];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminPassword = process.env.ADMIN_PASSWORD;

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, id, code } = req.query;
    // 管理員密碼優先讀 header，避免留在網址列／瀏覽器歷史／伺服器存取紀錄裡
    const password = req.headers['x-admin-password'] || req.query.password;
    try {
      const rows = await readRange(RANGE);

      // 公開端點：只回傳單一活動前台所需欄位（不含知識庫、不需密碼）
      if (action === 'get_public' && id) {
        const row = rows.find(r => r[0] === id);
        // draft 尚未對外公開，跟 archived 一樣視為不存在——不能讓記者用網址直接看到還沒發布的場次
        if (!row || row[4] === 'archived' || row[4] === 'draft') return res.status(404).json({ error: '活動不存在' });
        return res.status(200).json({
          event: {
            id: row[0], name: row[1], color: row[2] || '#0F9E7A',
            status: row[4] || 'active', created_at: row[5] || '', event_date: row[5] || '',
            chips: row[6] || '', images: row[7] || '', greeting: row[8] || '',
            event_time: row[11] || '', venue: row[12] || '', event_type: row[13] || '', press_contact: row[14] || '',
            contacts: row[15] || ''
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
        const payload = {
          id: row[0], name: row[1], color: row[2] || '#0F9E7A',
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5] || '', event_date: row[5] || '',
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || '', organizer: row[9] || '工研院',
          event_time: row[11] || '', venue: row[12] || '', event_type: row[13] || '', press_contact: row[14] || '',
          contacts: row[15] || ''
        };
        // 「以既有活動為範本」：同仁已用自己這一場的 edit_code 通過驗證，即視為可信的內部同仁，
        // 可再指定 copy_from 帶出另一場活動的知識庫供複製參考——跟後台管理員版的複製範本邏輯一致，
        // 只是驗證身分用的是這一場的 code，而不是管理員密碼。
        if (req.query.copy_from) {
          const srcRow = rows.find(r => r[0] === req.query.copy_from);
          if (srcRow) {
            payload.copy_source = {
              id: srcRow[0], name: srcRow[1] || '',
              knowledge_base: srcRow[3] || '', chips: srcRow[6] || '', organizer: srcRow[9] || '工研院'
            };
          }
        }
        return res.status(200).json(payload);
      }

      // 管理員：單一活動含知識庫與編輯碼
      if (action === 'get' && id) {
        if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
        const row = rows.find(r => r[0] === id);
        if (!row) return res.status(404).json({ error: '活動不存在' });
        return res.status(200).json({
          id: row[0], name: row[1], color: row[2] || '#0F9E7A',
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5], event_date: row[5] || '',
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || '', organizer: row[9] || '工研院',
          edit_code: row[10] || '',
          event_time: row[11] || '', venue: row[12] || '', event_type: row[13] || '', press_contact: row[14] || '',
          contacts: row[15] || ''
        });
      }

      // 後台專用列表：給行事曆／活動卡片管理用，含 draft 與 archived，並附 has_kb
      // （只回布林值，不吐知識庫全文——列表一次抓幾十場，塞全文既浪費頻寬又沒必要）。
      // 跟 action=get 共用同一把密碼驗證。
      if (action === 'list_admin') {
        if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
        const events = rows
          .filter(r => r[0])
          .map(r => ({
            id: r[0], name: r[1], color: r[2] || '#0F9E7A',
            status: r[4] || 'active', created_at: r[5] || '', event_date: r[5] || '',
            chips: r[6] || '', images: r[7] || '', greeting: r[8] || '', organizer: r[9] || '工研院',
            has_kb: !!(r[3] && String(r[3]).trim()),
            event_time: r[11] || '', venue: r[12] || '', event_type: r[13] || '', press_contact: r[14] || '',
            contacts: r[15] || ''
          }));
        return res.status(200).json({ events });
      }

      // 預設：公開列表（不含知識庫、不含編輯碼、不含 draft——記者與之後的 LINE 都走這支，
      // draft 混進來就等於預告工研院還沒發布的場次）
      const events = rows
        .filter(r => r[0] && r[4] !== 'archived' && r[4] !== 'draft')
        .map(r => ({
          id: r[0], name: r[1], color: r[2] || '#0F9E7A',
          status: r[4] || 'active', created_at: r[5] || '', event_date: r[5] || '',
          chips: r[6] || '', images: r[7] || '', greeting: r[8] || '', organizer: r[9] || '工研院',
          has_kb: !!(r[3] && String(r[3]).trim()),
          event_time: r[11] || '', venue: r[12] || '', event_type: r[13] || '', press_contact: r[14] || '',
          contacts: r[15] || ''
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
        if (body.knowledge_base !== undefined && String(body.knowledge_base).length > KB_MAX_LEN) {
          return res.status(400).json({ error: `內容過長（上限 ${KB_MAX_LEN} 字），請刪減後再存` });
        }
        if (body.status !== undefined && !EVENT_STATUSES.includes(body.status)) {
          return res.status(400).json({ error: '狀態值不正確' });
        }
        const updated = buildContentRow(existing, body);
        await updateRange(`events!A${rowIndex + 2}:P${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true });
      }

      // ── 以下皆需管理員密碼 ────────────────────────────────────────────
      const {
        password, id, name, color, knowledge_base, chips, status, images, event_date, greeting, organizer,
        event_time, venue, event_type, press_contact, contacts
      } = body;
      if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
      if (knowledge_base !== undefined && String(knowledge_base).length > KB_MAX_LEN) {
        return res.status(400).json({ error: `內容過長（上限 ${KB_MAX_LEN} 字），請刪減後再存` });
      }
      if (status !== undefined && !EVENT_STATUSES.includes(status)) {
        return res.status(400).json({ error: '狀態值不正確' });
      }

      if (action === 'create') {
        if (!name) return res.status(400).json({ error: '活動名稱必填' });
        const newId = generateId(name);
        const created_at = event_date || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const editCode = generateEditCode();
        // 預設 draft（未發布）：新活動先只在後台看得到，記者前台、公開列表都查不到，
        // 按活動卡片上的「發布」（其實是 action=update 帶 status=active）之後才對外開放。
        const initialStatus = status || 'draft';
        await appendRows('events!A:P', [[
          newId, name, color || '#0F9E7A', knowledge_base || '', initialStatus, created_at,
          chips || '', images || '', greeting || '', organizer || '工研院', editCode,
          event_time || '', venue || '', event_type || '', press_contact || '', contacts || ''
        ]]);
        return res.status(200).json({ success: true, id: newId, edit_code: editCode, status: initialStatus });
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
          existing[10] || generateEditCode(),   // 舊活動若無編輯碼，順手補上
          event_time !== undefined ? event_time : (existing[11] || ''),
          venue !== undefined ? venue : (existing[12] || ''),
          event_type !== undefined ? event_type : (existing[13] || ''),
          press_contact !== undefined ? press_contact : (existing[14] || ''),
          contacts !== undefined ? contacts : (existing[15] || '')
        ];
        await updateRange(`events!A${rowIndex + 2}:P${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true, edit_code: updated[10] });
      }

      if (action === 'archive') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const e = rows[rowIndex];

        // 封存時順便刪掉存在 Vercel Blob 的圖片，釋放空間；只刪自己 store 上傳的檔案，
        // 手動貼的外部連結（example.com 之類）留著不動，del() 對它們也不會有作用。
        const imageLines = (e[7] || '').split('\n').map(s => s.trim()).filter(Boolean);
        const blobUrls = imageLines
          .map(line => { const i = line.search(/[|｜]/); return i === -1 ? line : line.slice(0, i).trim(); })
          .filter(url => url.includes('.public.blob.vercel-storage.com'));
        if (blobUrls.length) {
          try { await del(blobUrls); } catch (err) { console.error('封存時刪除 Blob 圖片失敗:', err.message); }
        }

        const updated = [
          e[0], e[1], e[2], e[3], 'archived', e[5], e[6] || '', '', e[8] || '', e[9] || '工研院', e[10] || '',
          e[11] || '', e[12] || '', e[13] || '', e[14] || '', e[15] || ''
        ];
        await updateRange(`events!A${rowIndex + 2}:P${rowIndex + 2}`, [updated]);
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
