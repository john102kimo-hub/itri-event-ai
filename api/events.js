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
// ── 併發保護 ──────────────────────────────────────────────────────────
// get_edit / get 會多回一個 rev（這一列的版本指紋）；update_edit / update 把它原封不動
// 帶回來，就能擋掉「用載入當下的舊快照蓋掉別人剛存的內容」，見下方 mergeContentRow。

import { readRange, appendRows, updateRange } from '../lib/sheets.js';
import { createHash } from 'crypto';
import { del } from '@vercel/blob';

// events 表欄位：A id, B name, C color, D knowledge_base, E status,
//               F created_at（實際存的是活動日期，欄名是舊的，見下方 event_date 別名）,
//               G chips, H images, I greeting, J organizer, K edit_code,
//               L event_time, M venue, N event_type, O press_contact
const RANGE = 'events!A2:O';

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

// 可編輯的內容欄位對照表：body 參數名 ↔ events 表欄位 ↔ 沒值時的預設 ↔ 衝突訊息用的中文名。
// 同仁自助編輯（update_edit）與後台（update）改的是同一組欄位，共用這張表，之後加欄位只要動這裡。
// A id 與 K edit_code 不在表內——兩邊都不可改，一律沿用既有值。
// 狀態(E) 開放同仁自行切換（未發布/進行中/已結束/已封存）；呼叫端須先用 EVENT_STATUSES
// 驗證過 status 是合法值（見 update_edit / update），這裡才會直接信任並寫入。
const CONTENT_FIELDS = [
  { key: 'name',           col: 1,  def: '',        label: '活動名稱' },
  { key: 'color',          col: 2,  def: '#0F9E7A', label: '品牌主色' },
  { key: 'knowledge_base', col: 3,  def: '',        label: '活動知識庫' },
  { key: 'status',         col: 4,  def: 'active',  label: '活動狀態' },
  { key: 'event_date',     col: 5,  def: '',        label: '活動日期' },
  { key: 'chips',          col: 6,  def: '',        label: '快速問題按鈕' },
  { key: 'images',         col: 7,  def: '',        label: '圖片資源' },
  { key: 'greeting',       col: 8,  def: '',        label: 'AI 開場白' },
  { key: 'organizer',      col: 9,  def: '工研院',   label: '主辦單位' },
  { key: 'event_time',     col: 11, def: '',        label: '活動時間' },
  { key: 'venue',          col: 12, def: '',        label: '活動地點' },
  { key: 'event_type',     col: 13, def: '',        label: '活動類型' },
  { key: 'press_contact',  col: 14, def: '',        label: '新聞聯絡人' }
];

// ── 併發保護（同一場活動被兩個人同時編輯）──────────────────────────────
// 一場活動可能同時開在「後台管理員的編輯視窗」和「同仁的專屬編輯連結」裡。活動前一週
// 資料還在改，兩邊都是載入當下抓一份快照、按儲存時整列寫回去——誰後按誰就會用自己的
// 舊快照把對方剛存的內容蓋掉，而且畫面上兩邊都顯示「已儲存」，完全看不出來。
//
// 作法（不動試算表結構，也不需要新欄位）：
//   讀取時回傳 rev＝把每個內容欄位各壓成一段短雜湊串起來，前端原封不動帶回；
//   儲存時重讀該列再算一次，逐欄三方比對：
//     · 別人沒動過這欄           → 寫入我送來的新值
//     · 別人動過、但我沒動       → 保留別人的值（「不要覆蓋別人」的關鍵）
//     · 別人動過、我也動同一欄   → 真衝突，整列都不寫，回 409 並列出是哪幾欄
//   沒帶 rev 的請求（舊分頁、只切狀態的發布／收回）維持原本「有送就覆蓋」的行為。
const REV_PREFIX = 'v1';

// 讀某一欄的現值。Sheets 會省略尾端空欄，所以 undefined 要補預設值——跟寫入時同一套規則，
// 兩邊才算得出一樣的指紋。
const cellOf = (row, f) => (row[f.col] !== undefined && row[f.col] !== null ? String(row[f.col]) : f.def);

// 比對用的指紋。先 trim 再算：前端送出前普遍會 .trim()，若連頭尾空白都算「改過」，
// 沒動過的欄位會被誤判成有修改，白白撞出假衝突。
const fieldHash = (v) => createHash('sha1').update(String(v ?? '').trim(), 'utf8').digest('hex').slice(0, 8);

function buildRev(row) {
  return [REV_PREFIX, ...CONTENT_FIELDS.map((f) => fieldHash(cellOf(row, f)))].join('.');
}

// 解析前端帶回的 rev。格式不符（舊版前端、被改壞）一律當成沒帶，退回原本行為，
// 寧可少擋一次，也不要因為版本字串對不上就讓同仁存不了東西。
function parseRev(rev) {
  if (!rev) return null;
  const parts = String(rev).split('.');
  if (parts[0] !== REV_PREFIX || parts.length !== CONTENT_FIELDS.length + 1) return null;
  return parts.slice(1);
}

/**
 * 把這次送進來的欄位併回試算表上的那一列，組出完整 15 欄。
 *
 * @param existing    重讀出來的現況列
 * @param b           request body
 * @param baseHashes  parseRev(b.rev)；null＝沒帶版本，走舊行為
 * @param backfillEditCode  舊活動沒有編輯碼時是否順手補一組（後台 update 用）
 * @returns {{ row: string[], conflicts: string[] }} conflicts 非空代表兩邊改到同一欄
 */
function mergeContentRow(existing, b, baseHashes, { backfillEditCode = false } = {}) {
  const row = new Array(15).fill('');
  row[0] = String(existing[0] || '');                                             // A id（不可改）
  row[10] = String(existing[10] || (backfillEditCode ? generateEditCode() : '')); // K edit_code（不可改）
  const conflicts = [];

  CONTENT_FIELDS.forEach((f, i) => {
    const current = cellOf(existing, f);
    // 這次沒送這欄（含 null）→ 保持現值。寧可少改一欄，也不要把 "null" 這種字串寫進去。
    if (b[f.key] === undefined || b[f.key] === null) { row[f.col] = current; return; }
    const incoming = String(b[f.key]);
    if (!baseHashes) { row[f.col] = incoming; return; }             // 沒帶版本 → 舊行為

    if (fieldHash(current) === baseHashes[i]) { row[f.col] = incoming; return; }  // 別人沒動 → 用我的
    if (fieldHash(incoming) === baseHashes[i]) { row[f.col] = current; return; }  // 我沒動 → 留別人的
    row[f.col] = incoming;      // 兩邊都動了；有衝突的話整列都不會寫進去
    conflicts.push(f.label);
  });

  return { row, conflicts };
}

// 衝突時回給前端的內容：列出撞到的欄位，並附上最新版本讓「確定要覆蓋」能接著比對。
function conflictResponse(res, existing, conflicts, who) {
  return res.status(409).json({
    conflict: true,
    fields: conflicts,
    rev: buildRev(existing),
    error: `這場活動在你開啟編輯畫面之後，已經被${who}改過（${conflicts.join('、')}）。`
         + '為了不蓋掉對方的內容，這次沒有儲存。'
  });
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
            event_time: row[11] || '', venue: row[12] || '', event_type: row[13] || '', press_contact: row[14] || ''
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
          knowledge_base: row[3] || '', status: row[4] || 'active', created_at: row[5] || '', event_date: row[5] || '',
          chips: row[6] || '', images: row[7] || '', greeting: row[8] || '', organizer: row[9] || '工研院',
          event_time: row[11] || '', venue: row[12] || '', event_type: row[13] || '', press_contact: row[14] || '',
          rev: buildRev(row)   // 儲存時原封不動帶回來，用來擋掉互相覆蓋
        });
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
          rev: buildRev(row)   // 儲存時原封不動帶回來，用來擋掉互相覆蓋
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
            event_time: r[11] || '', venue: r[12] || '', event_type: r[13] || '', press_contact: r[14] || ''
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
          event_time: r[11] || '', venue: r[12] || '', event_type: r[13] || '', press_contact: r[14] || ''
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
        // 併發保護：帶了 rev 就逐欄比對，只有「兩邊都改到同一欄」才擋下來（force 可強制覆蓋）
        const { row: updated, conflicts } = mergeContentRow(existing, body, parseRev(body.rev));
        if (conflicts.length && !body.force) return conflictResponse(res, existing, conflicts, '其他人');
        await updateRange(`events!A${rowIndex + 2}:O${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true, rev: buildRev(updated) });
      }

      // ── 以下皆需管理員密碼 ────────────────────────────────────────────
      const {
        password, id, name, color, knowledge_base, chips, status, images, event_date, greeting, organizer,
        event_time, venue, event_type, press_contact
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
        const newRow = [
          newId, name, color || '#0F9E7A', knowledge_base || '', initialStatus, created_at,
          chips || '', images || '', greeting || '', organizer || '工研院', editCode,
          event_time || '', venue || '', event_type || '', press_contact || ''
        ];
        await appendRows('events!A:O', [newRow]);
        return res.status(200).json({
          success: true, id: newId, edit_code: editCode, status: initialStatus, rev: buildRev(newRow)
        });
      }

      if (action === 'update') {
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const rows = await readRange(RANGE);
        const rowIndex = rows.findIndex(r => r[0] === id);
        if (rowIndex === -1) return res.status(404).json({ error: '活動不存在' });
        const existing = rows[rowIndex];
        // 跟同仁編輯共用同一套併發保護：後台編輯視窗開著沒關、同仁這段時間從編輯連結
        // 存了新的知識庫，按下儲存時不會再把對方的內容整段蓋掉。
        // 卡片上的「發布／收回」只送 status，沒帶 rev 也不受影響（其他欄位本來就沿用現值）。
        const { row: updated, conflicts } =
          mergeContentRow(existing, body, parseRev(body.rev), { backfillEditCode: true });
        if (conflicts.length && !body.force) return conflictResponse(res, existing, conflicts, '同仁（從編輯連結）');
        await updateRange(`events!A${rowIndex + 2}:O${rowIndex + 2}`, [updated]);
        return res.status(200).json({ success: true, edit_code: updated[10], rev: buildRev(updated) });
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
          e[11] || '', e[12] || '', e[13] || '', e[14] || ''
        ];
        await updateRange(`events!A${rowIndex + 2}:O${rowIndex + 2}`, [updated]);
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
