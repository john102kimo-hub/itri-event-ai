// 計畫成效唯讀連結的 HTTP 入口（批次 151）。規則與資料界線在 lib/impact.js。
//
// 搭在 api/events.js 上（action 一律以 impact_ 開頭），理由跟報名、業發處一樣：Vercel Hobby 的 Function 上限是 12 支，
// api/ 已經用掉 11 支。
//
// GET  ?action=impact_view&id=活動代碼&k=連結碼        → 公開的唯讀檢視（連結碼對才給；錯誤、停用、沒這場一律同一種 404）
// GET  ?action=impact_admin_get&id=…（X-Admin-Password）  → 後台：這一場現在的連結
// POST {action:'impact_admin_share', id, mode}（管理員）  → 產生／重新產生／停用（mode = create | rotate | off）
import * as I from './impact.js';
import { requireAdmin, authBlocked, authFailed, tooManyAttempts } from './auth.js';

export async function handleImpactRequest(req, res) {
  const isGet = req.method === 'GET';
  const src = isGet ? (req.query || {}) : (req.body || {});
  const action = String(src.action || '');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (isGet && action === 'impact_view') {
      if (authBlocked(req)) return tooManyAttempts(res);
      const v = await I.impactView(String(src.id || '').trim(), String(src.k || ''));
      // 亂猜的來源跟猜後台密碼共用失敗限流（lib/auth.js）
      if (!v) { authFailed(req); return res.status(404).json({ error: '這個連結已失效或不正確，請向分享給您的承辦人重新索取' }); }
      return res.status(200).json(v);
    }
    if (isGet && action === 'impact_admin_get') {
      if (!requireAdmin(req, res)) return;
      return res.status(200).json(await I.getShare(String(src.id || '').trim()));
    }
    if (!isGet && action === 'impact_admin_share') {
      if (!requireAdmin(req, res)) return;
      const r = await I.adminSetShare(String(src.id || '').trim(), String(src.mode || ''));
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.status(200).json({ ok: true, token: r.token, url: r.url });
    }
    return res.status(400).json({ error: '不支援的操作' });
  } catch (e) {
    console.error('[impact] 失敗:', e.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
}
