// 媒體報名的 HTTP 入口（批次 88）。
//
// 為什麼不是新的 api/*.js：Vercel Hobby 的 Function 上限是 12 支，api/ 底下已經用掉 11 支
// （LINE-PLAN.md 坑 2）。報名功能搭在 api/events.js 上——它本來就同時有公開端點與管理員端點，
// 進來的 action 一律以 reg_ 開頭，api/events.js 在讀活動表之前就交給這裡。
//
// ── 公開（不需密碼）──────────────────────────────────────────────────
// GET  ?action=reg_config&c=xxx         → 報名頁要的活動內容（不帶 c＝目前唯一開放中的那個）
// GET  ?action=reg_get&c=xxx&t=編輯碼    → 用編輯碼讀回自己的報名（修改頁預填）
// POST {action:'reg_submit',...}        → 送出／更新報名
// POST {action:'reg_cancel',c,t}        → 取消自己的報名
// ── 管理員（需 ADMIN_PASSWORD）────────────────────────────────────────
// GET  ?action=reg_admin_list&c=xxx     → 後台總覽（活動、場次人數、名單、統計）；summary=1 只回所有活動的清單與人數
// GET  ?action=reg_export&c=xxx         → 匯出 CSV
// POST {action:'reg_admin_save_campaign',...}  → 新增／更新報名活動
// POST {action:'reg_admin_update',reg_id,...}  → 改單筆報名的狀態／備註／場次
// POST {action:'reg_admin_clear_tests',c}      → 清掉草稿活動送出的測試報名

import * as R from './registration.js';
import { safeEqual, passwordFrom, authBlocked, authFailed, tooManyAttempts } from './auth.js';

// ── 防濫用 ────────────────────────────────────────────────────────────
// 公開表單會寫進試算表，一定要有門檻。三層都很輕：
//   ① 蜜罐欄位（人看不到，機器人會填）② 太快送出（人不可能在 0.8 秒內填完）③ 每個 IP 限流。
// 限流放在記憶體裡，Function 冷啟動會歸零、多個 instance 各算各的——擋的是「單一來源狂送」，
// 不是精準額度，跟 api/chat.js 的 ipHits 同一個做法。
const SUBMIT_MAX = 12;
const SUBMIT_WINDOW_MS = 10 * 60_000;
const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < SUBMIT_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < SUBMIT_WINDOW_MS)) hits.delete(k);
  return list.length > SUBMIT_MAX;
}
export function resetRateLimit() { hits.clear(); }

function clientIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || 'unknown';
}

// 批次 110：比對統一走 lib/auth.js（不再讀網址的 ?password=、失敗限流）。adminPassword 仍由呼叫端傳進來。
function isAdmin(req, adminPassword) {
  return safeEqual(passwordFrom(req), adminPassword);
}

// 對外的活動內容：不含任何後台欄位。LINE 說明沒填就用預設；個資告知沒填就不顯示（朱朱決定不放）。
function publicCampaign(c) {
  const now = Date.now();
  const closed = !R.campaignAcceptsSubmissions(c, now).ok;
  return {
    id: c.id, title: c.title, intro: c.intro, closed, draft: c.status === 'draft',
    closes_at: c.closes_at, contact: c.contact, venue: c.venue || '',
    privacy: c.privacy || '',
    line_pitch: (c.line_pitch || R.DEFAULT_LINE_PITCH).split('\n').map((x) => x.trim()).filter(Boolean),
    // 辦完的場次照樣回傳、標 ended：報名頁自己決定要不要顯示（只有原本報了這一場的人才看得到，鎖住）
    sessions: c.sessions.filter((s) => s.status !== 'cancelled').map((s) => {
      const ended = R.isSessionEnded(s, now);
      return {
        code: s.code, date: s.date, dateLabel: s.dateLabel, weekday: s.weekday, time: s.time, start: s.start, end: s.end,
        title: s.title, room: s.room, note: s.note, url: s.url, status: ended ? 'ended' : s.status, ended, disabled: ended || s.status !== 'open'
      };
    }),
    options: c.options
  };
}

const publicRegistration = (g, campaign) => ({
  reg_id: g.reg_id, name: g.name, outlet: g.outlet, email: g.email, phone: R.formatPhone(g.phone),
  sessions: g.sessions, options: g.options, status: g.status, line_bound: !!g.line_user_id,
  session_labels: R.describeSessions(campaign, g.sessions)
});

// 報名頁的活動內容：CDN（Vercel edge）記 30 秒，瀏覽器每次都重新問 edge。刻意不加 stale-while-revalidate：
// 瀏覽器會把它當成「過期後還能先給舊的 120 秒」，承辦人在後台改了狀態或場次、重新整理看不到，會以為沒存到
// （實測在本機預覽踩到）。真正的關門一律以送出當下的伺服器檢查為準，這裡只是省 Sheets 讀取。
const CONFIG_CACHE = 'public, max-age=0, s-maxage=30';

const GENERIC_BUSY = '系統忙碌中，請稍後再試一次；如果一直失敗，請洽媒體聯絡人';

export async function handleRegistrationRequest(req, res, { adminPassword } = {}) {
  const isGet = req.method === 'GET';
  const src = isGet ? (req.query || {}) : (req.body || {});
  const action = String(src.action || '');
  const adminOnly = /^reg_(admin_|export)/.test(action);

  try {
    if (adminOnly) {
      if (authBlocked(req)) return tooManyAttempts(res);
      if (!isAdmin(req, adminPassword)) { authFailed(req); return res.status(401).json({ error: '密碼錯誤' }); }
    }

    // ── 公開 GET ─────────────────────────────────────────────────────
    if (isGet && action === 'reg_config') {
      const id = String(src.c || '').trim();
      let campaign;
      if (id) campaign = await R.getCampaign(id);
      else {
        const open = await R.listOpenCampaigns();
        if (open.length > 1) {
          res.setHeader('Cache-Control', CONFIG_CACHE);
          // 多場同時開放：總入口列出每一場，記者自己點進要報的那一場（帶日期與地點，不用猜哪個是哪個）
          return res.status(200).json({ choices: open.map((c) => ({ id: c.id, title: c.title, when: R.campaignDateRange(c), venue: c.venue || '' })) });
        }
        campaign = open[0] || null;
      }
      if (!campaign) return res.status(404).json({ error: id ? '找不到這個報名活動，請確認連結是否正確' : '目前沒有開放報名的活動' });
      // 草稿只給拿到連結的人看，而且不能被 CDN 記住（後台改了要馬上看到）
      res.setHeader('Cache-Control', campaign.status === 'draft' ? 'no-store' : CONFIG_CACHE);
      return res.status(200).json({ campaign: publicCampaign(campaign) });
    }

    if (isGet && action === 'reg_get') {
      const campaign = await R.getCampaign(src.c);
      const g = campaign ? await R.getRegistrationByToken(campaign.id, src.t) : null;
      res.setHeader('Cache-Control', 'no-store');
      if (!g) return res.status(404).json({ error: '找不到這筆報名，可能連結不完整' });
      return res.status(200).json({ reg: publicRegistration(g, campaign) });
    }

    // ── 公開 POST ────────────────────────────────────────────────────
    if (!isGet && action === 'reg_submit') {
      if (rateLimited(clientIp(req))) return res.status(429).json({ error: '送出太頻繁了，請稍候幾分鐘再試' });
      // 蜜罐有東西＝機器人。假裝成功，不寫任何資料，讓它以為得手了
      if (String(src.hp || '').trim()) return res.status(200).json({ ok: true, mode: 'created', reg: { reg_id: 'R-----', name: '', outlet: '', session_labels: [] }, line: {} });
      if (typeof src.elapsed === 'number' && src.elapsed < 800) return res.status(400).json({ error: '送出得太快了，請確認資料後再按一次' });
      const r = await R.submitRegistration(src);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error, errors: r.errors, closed: !!r.closed });
      return res.status(200).json({
        ok: true, mode: r.mode, test: r.test, token: r.token,
        // 沒證明身分（只靠 Email 對上既有報名）的更新，只回「這次自己勾的場次」，不回那一筆的任何內容
        reg: r.proven ? {
          reg_id: r.reg.reg_id, name: r.reg.name, outlet: r.reg.outlet, sessions: r.reg.sessions,
          session_labels: R.describeSessions(r.campaign, r.reg.sessions), options: r.reg.options
        } : {
          reg_id: '', name: '', outlet: '', sessions: r.asked, session_labels: R.describeSessions(r.campaign, r.asked), options: {}
        },
        line: r.line
      });
    }

    if (!isGet && action === 'reg_cancel') {
      if (rateLimited(clientIp(req))) return res.status(429).json({ error: '操作太頻繁了，請稍候幾分鐘再試' });
      const campaign = await R.getCampaign(src.c);
      if (!campaign) return res.status(404).json({ error: '找不到這個報名活動' });
      const r = await R.cancelRegistration(campaign.id, src.t);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.status(200).json({ ok: true });
    }

    // ── 管理員 ───────────────────────────────────────────────────────
    if (isGet && action === 'reg_admin_list') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await R.adminOverview(String(src.c || ''), { includeTest: src.include_test === '1', summary: src.summary === '1' }));
    }

    if (isGet && action === 'reg_export') {
      const r = await R.adminExportCsv(String(src.c || ''), { includeCancelled: src.all === '1' });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(r.csv);
    }

    if (!isGet && action === 'reg_admin_save_campaign') {
      const r = await R.adminSaveCampaign(src);
      if (!r.ok) return res.status(400).json({ error: r.error, details: r.details });
      return res.status(200).json({ success: true, id: r.id, created: r.created });
    }

    if (!isGet && action === 'reg_admin_update') {
      const r = await R.adminUpdateRegistration(src.reg_id, { status: src.status, note: src.note, sessions: src.sessions });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.status(200).json({ success: true });
    }

    if (!isGet && action === 'reg_admin_clear_tests') {
      const r = await R.adminClearTests(String(src.c || ''));
      return res.status(200).json({ success: true, cleared: r.cleared });
    }

    return res.status(400).json({ error: `不支援的操作: ${action}` });
  } catch (err) {
    console.error(`[reg] ${action} 失敗:`, err.message);
    // 公開端點不把內部錯誤訊息（Sheets 權限、欄位名稱…）丟給記者看；管理員看得到原因
    return res.status(500).json({ error: adminOnly ? err.message : GENERIC_BUSY });
  }
}
