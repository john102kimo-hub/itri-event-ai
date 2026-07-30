// 記者會報到 API
//
// ── 公開（記者用，免登入）──────────────────────────────────────────────
// GET  ?action=event&id=xxx              → 場次基本資料（沿用 events 表）
// GET  ?action=search&id=xxx&q=關鍵字     → 在該場邀請名單中比對，只回姓名與媒體
// POST {action:'checkin',id,name,outlet} → 寫入報到
//
// ── 管理員（需 ADMIN_PASSWORD）────────────────────────────────────────
// POST {action:'setup'}                        → 建立 roster / roster_contact / invites / checkins
// POST {action:'import_roster',rows,contacts}  → 匯入記者總名單（後台網頁上傳，不進 repo）
// POST {action:'build_invites',id,keywords}    → 從總名單挑出本場邀請對象
// GET  ?action=stats&id=xxx                    → 現場看板統計
// GET  ?action=contacts&id=xxx                 → 本場名單「含電話 Email」，供 follow call
//
// 個資邊界：公開路徑只讀 invites / checkins / events。
// 電話與 Email 只存在 roster_contact，且只有帶密碼的 contacts 動作會去讀它。

import { readRange, appendRows, updateRange, ensureSheets } from './lib/sheets.js';

const SHEETS = {
  roster:         ['記者ID', '姓名', '媒體', '路線'],
  roster_contact: ['記者ID', '電話', 'Email'],
  invites:        ['event_id', '記者ID', '姓名', '媒體', '邀請狀態'],
  checkins:       ['event_id', '報到時間', '記者ID', '姓名', '媒體', '類型', '名單內', '來源'],
};

const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

// 分頁還沒建立時，讀取會丟「Unable to parse range」。公開端點不該因此 500。
async function safeRead(range) {
  try { return await readRange(range); } catch { return []; }
}

function mediaType(outlet) {
  const o = String(outlet || '');
  if (/中央社|通訊社|時報資訊/.test(o)) return '通訊社';
  if (/週刊|周刊|雜誌|今周刊|天下|遠見|商業周刊|財訊|數位時代|新電子|新通訊/.test(o)) return '雜誌';
  if (/廣播|電台|之音|IC之音|環宇|中國廣播/.test(o)) return '廣播';
  if (/電視|視$|TVBS|三立|東森|民視|中天|華視|台視|公視|八大|年代|壹電視|新唐人|大愛|鏡新聞|iNEWS/.test(o)) return '電視';
  if (/日報|時報|報$|新生報|人間福報/.test(o)) return '報紙';
  if (/網|新報|線上|Now|ET|Yahoo|INSIDE|科技新報|風傳媒|太報|知新聞/i.test(o)) return '網路';
  return '其他';
}

async function getEvent(id) {
  const rows = await readRange('events!A2:K');
  const r = rows.find(x => x[0] === id);
  if (!r) return null;
  return { id: r[0], name: r[1], color: r[2] || '#0F9E7A', status: r[4] || 'active', date: r[5] || '', organizer: r[9] || '工研院' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN = process.env.ADMIN_PASSWORD;

  try {
    // ────────────────────────────── GET
    if (req.method === 'GET') {
      const { action, id, q, password } = req.query;

      if (action === 'event') {
        const ev = await getEvent(id);
        if (!ev) return res.status(404).json({ error: '找不到這場活動，請確認 QR Code 或連結是否正確。' });
        if (ev.status === 'archived') return res.status(403).json({ error: '本場報到已結束，感謝您的出席。' });
        return res.status(200).json({ event: ev });
      }

      // 只在本場邀請名單內比對，且只回姓名與媒體
      if (action === 'search') {
        const kw = String(q || '').trim();
        if (!kw) return res.status(200).json({ results: [] });
        const rows = await safeRead('invites!A2:E');
        const hit = rows.filter(r => r[0] === id && (String(r[2]).includes(kw) || String(r[3]).includes(kw)));
        return res.status(200).json({
          results: hit.slice(0, 25).map(r => ({ rid: r[1] || '', name: r[2], outlet: r[3] }))
        });
      }

      if (action === 'stats') {
        if (password !== ADMIN) return res.status(401).json({ error: '密碼錯誤' });
        const ev = await getEvent(id);
        const [inv, chk] = await Promise.all([readRange('invites!A2:E'), readRange('checkins!A2:H')]);
        const invited = inv.filter(r => r[0] === id);
        const done = chk.filter(r => r[0] === id);

        const byType = {};
        const outlets = new Set();
        done.forEach(r => {
          const t = r[5] || mediaType(r[4]);
          byType[t] = (byType[t] || 0) + 1;
          outlets.add(r[4]);
        });
        const arrived = new Set(done.map(r => `${r[3]}|${r[4]}`));
        const notYet = invited.filter(r => !arrived.has(`${r[2]}|${r[3]}`)).map(r => ({ name: r[2], outlet: r[3] }));

        return res.status(200).json({
          eventName: ev ? ev.name : '(未知場次)',
          invited: invited.length,
          checked: done.length,
          outlets: outlets.size,
          walkins: done.filter(r => r[6] !== '是').length,
          rate: invited.length ? Math.round(done.length / invited.length * 100) : 0,
          byType,
          recent: done.slice(-12).reverse().map(r => ({
            name: r[3], outlet: r[4], type: r[5],
            time: String(r[1]).slice(-8, -3), walkin: r[6] !== '是'
          })),
          notYet: notYet.slice(0, 60),
          notYetTotal: notYet.length,
        });
      }

      // 唯一會讀取聯絡資料的路徑，需管理員密碼
      if (action === 'contacts') {
        if (password !== ADMIN) return res.status(401).json({ error: '密碼錯誤' });
        const [inv, contact, chk] = await Promise.all([
          readRange('invites!A2:E'), readRange('roster_contact!A2:C'), readRange('checkins!A2:H')
        ]);
        const cmap = new Map(contact.map(r => [r[0], { phone: r[1] || '', email: r[2] || '' }]));
        const arrived = new Set(chk.filter(r => r[0] === id).map(r => `${r[3]}|${r[4]}`));
        return res.status(200).json({
          list: inv.filter(r => r[0] === id).map(r => ({
            rid: r[1], name: r[2], outlet: r[3], status: r[4] || '',
            ...(cmap.get(r[1]) || { phone: '', email: '' }),
            arrived: arrived.has(`${r[2]}|${r[3]}`),
          }))
        });
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    // ────────────────────────────── POST
    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      // 公開：寫入報到
      if (action === 'checkin') {
        const { id, name, outlet, rid } = body;
        if (!id || !name || !outlet) return res.status(400).json({ error: '請填寫姓名與媒體。' });
        const ev = await getEvent(id);
        if (!ev) return res.status(404).json({ error: '找不到這場活動。' });
        if (ev.status === 'archived') return res.status(403).json({ error: '本場報到已結束，感謝您的出席。' });

        const done = (await safeRead('checkins!A2:H')).filter(r => r[0] === id);
        if (done.some(r => r[3] === name && r[4] === outlet)) {
          return res.status(200).json({ success: true, dup: true, seq: done.length });
        }
        await appendRows('checkins!A:H', [[
          id, now(), rid || '', name, outlet, mediaType(outlet), rid ? '是' : '否', rid ? '名單比對' : '現場手填'
        ]]);
        return res.status(200).json({ success: true, dup: false, seq: done.length + 1 });
      }

      // ── 以下需管理員密碼 ──
      if (body.password !== ADMIN) return res.status(401).json({ error: '密碼錯誤' });

      if (action === 'setup') {
        const created = await ensureSheets(SHEETS);
        return res.status(200).json({ success: true, created, existing: Object.keys(SHEETS).filter(t => !created.includes(t)) });
      }

      // rows: [[記者ID,姓名,媒體,路線]...]　contacts: [[記者ID,電話,Email]...]
      if (action === 'import_roster') {
        await ensureSheets(SHEETS);
        const { rows = [], contacts = [], mode } = body;
        if (!rows.length) return res.status(400).json({ error: '沒有資料' });
        if (mode === 'replace') {
          // 先清空舊資料（新名單較短時，避免殘留舊列）
          const old = await safeRead('roster!A2:D');
          if (old.length) await updateRange(`roster!A2:D${old.length + 1}`, old.map(() => ['', '', '', '']));
          const oc = await safeRead('roster_contact!A2:C');
          if (oc.length) await updateRange(`roster_contact!A2:C${oc.length + 1}`, oc.map(() => ['', '', '']));
          // 寫入時範圍必須涵蓋資料列數，只給起始格會被 API 拒絕
          await updateRange(`roster!A2:D${rows.length + 1}`, rows);
          if (contacts.length) await updateRange(`roster_contact!A2:C${contacts.length + 1}`, contacts);
        } else {
          await appendRows('roster!A:D', rows);
          if (contacts.length) await appendRows('roster_contact!A:C', contacts);
        }
        return res.status(200).json({ success: true, roster: rows.length, contacts: contacts.length });
      }

      if (action === 'build_invites') {
        const { id, keywords } = body;
        if (!id) return res.status(400).json({ error: '缺少活動 ID' });
        const kws = String(keywords || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        const roster = await readRange('roster!A2:D');
        const picked = roster.filter(r => r[1] && (!kws.length || kws.some(k => String(r[2]).includes(k))));
        if (!picked.length) return res.status(400).json({ error: '沒有符合條件的記者' });

        const already = new Set((await readRange('invites!A2:E')).filter(r => r[0] === id).map(r => `${r[2]}|${r[3]}`));
        const add = picked.filter(r => !already.has(`${r[1]}|${r[2]}`))
                          .map(r => [id, r[0], r[1], r[2], '待邀請']);
        if (add.length) await appendRows('invites!A:E', add);
        return res.status(200).json({ success: true, added: add.length, skipped: picked.length - add.length });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
