// 媒體露出 API
//
// ── 同仁（用每場專屬 edit_code，不需管理員密碼）────────────────────────
// GET  ?action=list&id=xxx&code=yyy        → 該場已上傳的露出資料摘要
// POST {action:'upload',id,code,filename,data}  → 上傳露出清單並解析入庫
// POST {action:'clear',id,code}            → 清掉該場露出資料（重傳前用）
//
// ── 管理員（需 ADMIN_PASSWORD；上面三個動作也可改用 password 驗證）──────
// GET  ?action=analysis&id=xxx&password=.. → 露出 × AI 提問 交叉分析
//
// 設計重點：同仁只有 edit_code，沒有後台密碼。上傳與檢視必須能用 edit_code
// 通過，否則這個功能對同仁等於不存在。

import { readRange, appendRows, ensureSheets, listSheets, batchUpdate } from './lib/sheets.js';
import { parseExposureFile, normalizeOutlet } from './lib/exposure-parse.js';

const SHEETS = {
  exposure: ['event_id', '則數', '日期', '類型', '媒體名稱', '版位', '標題', '上傳時間', '來源檔'],
};

const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

async function safeRead(range) {
  try { return await readRange(range); } catch { return []; }
}

/** edit_code 或管理員密碼皆可通過 */
async function authorize({ id, code, password }) {
  const admin = process.env.ADMIN_PASSWORD;
  if (password && admin && password === admin) return { ok: true, who: 'admin' };
  if (!id) return { ok: false, status: 400, msg: '缺少活動 ID' };
  if (!code) return { ok: false, status: 401, msg: '缺少編輯碼，請使用承辦人給你的專屬編輯連結' };

  const rows = await readRange('events!A2:K');
  const row = rows.find((r) => r[0] === id);
  if (!row) return { ok: false, status: 404, msg: '找不到這場活動，請確認連結是否正確' };
  if (!row[10] || String(code) !== String(row[10])) {
    return { ok: false, status: 401, msg: '編輯碼錯誤，請向承辦人索取正確的編輯連結' };
  }
  if (row[4] === 'archived') return { ok: false, status: 403, msg: '這場活動已封存，無法上傳' };
  return { ok: true, who: 'staff', eventName: row[1] };
}

const rowsForEvent = (rows, id) => rows.filter((r) => r[0] === id);

/**
 * 只刪除該場活動在 exposure 分頁的列，不影響其他活動的資料。
 *
 * 舊版做法是「讀整表 → 清空全部 A2:I → 再把想保留的列寫回去」：清空成功但回寫失敗時
 * （Sheets 429、網路瞬斷、function 中止），所有活動的露出資料會一次歸零。
 * 改用 batchUpdate 的 deleteDimension 直接刪列，是單一原子操作，且全程只碰這一場的列。
 */
async function deleteEventRows(id) {
  const sheets = await listSheets();
  const sheet = sheets.find((s) => s.title === 'exposure');
  if (!sheet) return 0; // 分頁還沒建立，沒東西可刪

  const rows = await safeRead('exposure!A2:A'); // 只讀 A 欄（event_id）定位列號，省流量
  const rowIndexes = []; // 對應 rows 陣列的 0-based index；試算表實際列號 = index + 2（跳過表頭）
  rows.forEach((r, i) => { if (r[0] === id) rowIndexes.push(i); });
  if (!rowIndexes.length) return 0;

  // 由大到小排序再刪：先刪後面的列，前面列的索引才不會跟著位移錯位
  const requests = rowIndexes
    .sort((a, b) => b - a)
    .map((i) => ({
      deleteDimension: {
        range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: i + 1, endIndex: i + 2 },
      },
    }));
  await batchUpdate(requests);
  return rowIndexes.length;
}

function summarize(records) {
  const byOutlet = {}, byType = {}, byDate = {};
  records.forEach((r) => {
    if (r.outlet) byOutlet[r.outlet] = (byOutlet[r.outlet] || 0) + 1;
    if (r.type) byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.date) byDate[r.date] = (byDate[r.date] || 0) + 1;
  });
  return {
    total: records.length,
    outlets: Object.keys(byOutlet).length,
    byType,
    topOutlets: Object.entries(byOutlet).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, n]) => ({ name, n })),
    dates: Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ date: d, n })),
  };
}

/** 模糊比對：正規化後其中一方包含另一方即算命中（避免「Yahoo」對不上「Yahoo奇摩新聞」） */
function outletMatches(a, b) {
  const x = normalizeOutlet(a), y = normalizeOutlet(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short);
}

const CAVEAT = 'AI 問答的媒體名稱由記者自行輸入，露出清單的媒體名稱來自監測公司，兩者以模糊比對配對，可能有誤差；且只涵蓋「有使用 AI 問答」的記者，沒用 AI 的媒體不會出現在提問側。';

/** 露出 × AI 提問 交叉分析（expRows/qaRows 都已篩成單一活動） */
function crossAnalyze(expRows, qaRows) {
  const exp = expRows.map((r) => ({ outlet: r[4], date: r[2], type: r[3], title: r[6] }));

  const asked = [...new Set(qaRows.map((r) => String(r[3] || '').trim())
    .filter((m) => m && m !== '（未填寫）'))];
  const published = [...new Set(exp.map((r) => r.outlet).filter(Boolean))];

  const askedAndPublished = asked.filter((a) => published.some((p) => outletMatches(a, p)));
  const askedNotPublished = asked.filter((a) => !published.some((p) => outletMatches(a, p)));
  const publishedNotAsked = published.filter((p) => !asked.some((a) => outletMatches(a, p)));

  const qCount = {};
  qaRows.forEach((r) => {
    const m = String(r[3] || '').trim();
    if (m && m !== '（未填寫）') qCount[m] = (qCount[m] || 0) + 1;
  });

  return {
    exposure: summarize(exp),
    qa: { questions: qaRows.length, mediaAsked: asked.length },
    cross: {
      askedAndPublished: askedAndPublished.length,
      askedNotPublished: askedNotPublished.length,
      publishedNotAsked: publishedNotAsked.length,
      // 有提問的媒體裡，最後有發稿的比例
      askedPublishRate: asked.length ? Math.round(askedAndPublished.length / asked.length * 100) : null,
      lists: {
        askedAndPublished,
        askedNotPublished,
        publishedNotAsked: publishedNotAsked.slice(0, 40),
      },
    },
    topAskers: Object.entries(qCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([media, n]) => ({ media, n })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ─────────────── GET
    if (req.method === 'GET') {
      const { action, id, code } = req.query;
      // 管理員密碼優先讀 header，避免留在網址列／瀏覽器歷史／伺服器存取紀錄裡（code 是同仁的
      // 專屬編輯連結，設計上本來就要能放在網址裡分享，維持走 query）
      const password = req.headers['x-admin-password'] || req.query.password;

      if (action === 'list') {
        const auth = await authorize({ id, code, password });
        if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });
        const rows = rowsForEvent(await safeRead('exposure!A2:I'), id);
        const records = rows.map((r) => ({
          seq: r[1], date: r[2], type: r[3], outlet: r[4], section: r[5], title: r[6],
        }));
        return res.status(200).json({
          ...summarize(records),
          uploadedAt: rows.length ? rows[rows.length - 1][7] : null,
          sourceFile: rows.length ? rows[rows.length - 1][8] : null,
        });
      }

      if (action === 'analysis' || action === 'analysis_all') {
        if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
        const [expRows, qaRowsRaw] = await Promise.all([
          safeRead('exposure!A2:I'), safeRead('qa_log!A2:G'),
        ]);
        // 已刪除的問答（G 欄標記，或舊資料殘留的 B 欄 [deleted]）不該算進交叉分析
        const qaRows = qaRowsRaw.filter((r) => r[1] !== '[deleted]' && r[6] !== '1');

        if (action === 'analysis') {
          return res.status(200).json({
            ...crossAnalyze(rowsForEvent(expRows, id), qaRows.filter((r) => r[1] === id)),
            caveat: CAVEAT,
          });
        }

        // 批次：每個有露出資料的活動各算一份，給 /report 用
        const ids = [...new Set(expRows.map((r) => r[0]).filter(Boolean))];
        const byEvent = {};
        ids.forEach((eid) => {
          byEvent[eid] = crossAnalyze(rowsForEvent(expRows, eid), qaRows.filter((r) => r[1] === eid));
        });
        return res.status(200).json({
          byEvent,
          totalExposure: expRows.length,
          totalOutlets: new Set(expRows.map((r) => r[4]).filter(Boolean)).size,
          eventsWithExposure: ids.length,
          caveat: CAVEAT,
        });
      }

      return res.status(400).json({ error: '不支援的操作' });
    }

    // ─────────────── POST
    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, id, code, password } = body;
      const auth = await authorize({ id, code, password });
      if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

      if (action === 'clear') {
        await ensureSheets(SHEETS);
        const removed = await deleteEventRows(id);
        return res.status(200).json({ success: true, removed });
      }

      if (action === 'upload') {
        const { filename = '', data } = body;
        if (!data) return res.status(400).json({ error: '沒有收到檔案內容' });

        let buf;
        try { buf = Buffer.from(String(data).split(',').pop(), 'base64'); }
        catch { return res.status(400).json({ error: '檔案內容解碼失敗' }); }
        if (!buf.length) return res.status(400).json({ error: '檔案是空的' });
        if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: '檔案超過 20MB' });

        const { records, format, note } = parseExposureFile(buf, filename);
        if (!records.length) {
          return res.status(422).json({ error: note || '這個檔案裡找不到露出資料。', format });
        }

        await ensureSheets(SHEETS);

        // 同一場重複上傳 → 先刪掉這一場的舊資料（不影響其他活動），避免累加重複
        const replaced = await deleteEventRows(id);

        const stamp = now();
        const rows = records.map((r) => [
          id, r.seq, r.date, r.type, r.outlet, r.section, r.title, stamp, filename,
        ]);
        await appendRows('exposure!A:I', rows);

        return res.status(200).json({
          success: true, format, note, replaced,
          ...summarize(records),
        });
      }

      return res.status(400).json({ error: `不支援的操作: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
