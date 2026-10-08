// 業發處合作洽詢的 HTTP 入口（批次 119）。規則與資料層在 lib/b2b.js。
//
// 搭在 api/events.js 上（action 一律以 b2b_ 開頭），理由跟報名一樣：Vercel Hobby 的 Function 上限是 12 支，
// api/ 已經用掉 11 支。⚠️ 但業發處的 B2B 用途是商業使用，Hobby 方案的條款不允許——正式對外前要升級 Pro
// （見 SETUP.md「業發處」一節）。升級後要不要拆成獨立的 api/b2b.js，到時候再決定。
//
// ── 公開（不需身分）──────────────────────────────────────────────────
// GET  ?action=b2b_public_config               → 洽詢單要的東西（收不收件、個資告知、技術領域選項、幾個工作天回覆）
// POST {action:'b2b_inquiry_submit', ...}      → 送出洽詢（蜜罐、太快送出、每個 IP 限流）
// ── 成員（個人連結：X-B2B-Key 標頭；或後台管理員密碼）────────────────────
// GET  ?action=b2b_me                          → 我是誰、可以改派給誰、LINE 通知綁了沒
// GET  ?action=b2b_list                        → 收件匣（摘要；管理員看全部、業務窗口看自己的）
// GET  ?action=b2b_get&id=Q…                   → 單筆（含聯絡方式；看了記稽核）
// POST {action:'b2b_update', id, status?, owner?, note?}
// ── 管理員 ───────────────────────────────────────────────────────────
// GET  ?action=b2b_members／b2b_settings／b2b_audit
// POST {action:'b2b_member_save', ...}／{action:'b2b_member_reset', id}／{action:'b2b_settings_save', ...}
// ── 排程 ─────────────────────────────────────────────────────────────
// GET  ?action=b2b_cron（Authorization: Bearer CRON_SECRET）→ 期限提醒

import { timingSafeEqual } from 'node:crypto';
import * as B from './b2b.js';
import { passwordFrom, isAdminPassword, authBlocked, authFailed, tooManyAttempts } from './auth.js';
import { createLimiter, clientIp } from './rate-limit.js';

const submitLimit = createLimiter({ windowMs: 10 * 60_000, max: 5 });
// 個人連結對不上的次數，業發處自己算，不記進後台管理員密碼那一份（lib/auth.js，每個 IP 10 分鐘 30 次就擋全部後台）：
// 院內的辦公室共用一個對外 IP，業務同仁拿舊連結多開幾次，不能把公關同仁鎖在 /admin 門外（朱朱 10/8：不要影響既有的功能）。
// 在這裡打錯「管理員密碼」照樣記進那一份——猜的是同一組密碼，哪個門口猜都要算。
const keyFailures = createLimiter({ windowMs: 10 * 60_000, max: 30 });
export function resetB2BRateLimit() { submitLimit.reset(); keyFailures.reset(); }

// 後台管理員密碼（ADMIN_PASSWORD）也進得來，當成「系統管理員」：第一位成員要有人建、成員全部被停用時要有人救。
const SITE_ADMIN = { id: 'admin', name: '系統管理員', role: 'admin' };

async function resolveActor(req) {
  const key = String(req.headers?.['x-b2b-key'] || '').trim();
  if (key) {
    const m = await B.memberByKey(key);
    if (m) return { member: m, admin: m.role === 'admin' };
    keyFailures.hit(clientIp(req));
    return null;
  }
  const pw = passwordFrom(req);
  if (pw && isAdminPassword(pw)) return { member: SITE_ADMIN, admin: true };
  if (pw) authFailed(req);
  return null;
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(bearer), b = Buffer.from(secret || '');
  return !!secret && a.length === b.length && timingSafeEqual(a, b);
}

export async function handleB2BRequest(req, res) {
  const isGet = req.method === 'GET';
  const src = isGet ? (req.query || {}) : (req.body || {});
  const action = String(src.action || '');
  res.setHeader('Cache-Control', 'no-store');
  let authed = false;
  try {
    // ── 排程 ───────────────────────────────────────────────────────────
    if (isGet && action === 'b2b_cron') {
      if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
      return res.status(200).json(await B.runSlaCheck());
    }

    // ── 公開 ───────────────────────────────────────────────────────────
    if (isGet && action === 'b2b_public_config') {
      if (!B.b2bConfigured()) return res.status(200).json({ open: false });
      const cfg = await B.loadSettings();
      return res.status(200).json({ open: B.intakeOpen(cfg), privacy: cfg.privacy, topics: B.topicList(cfg), sla_days: B.slaDays(cfg) });
    }
    if (!isGet && action === 'b2b_inquiry_submit') {
      if (submitLimit.hit(clientIp(req))) return res.status(429).json({ error: '送出太頻繁了，請稍候幾分鐘再試' });
      // 蜜罐有東西＝機器人：假裝成功，不寫任何資料
      if (String(src.hp || '').trim()) return res.status(200).json({ ok: true, id: 'Q------', sla_days: 2 });
      if (typeof src.elapsed === 'number' && src.elapsed < 1500) return res.status(400).json({ error: '送出得太快了，請確認資料後再按一次' });
      if (!B.b2bConfigured()) return res.status(503).json({ error: '目前暫停線上收件，請直接聯絡活動或業務窗口' });
      const r = await B.submitInquiry(src);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error, errors: r.errors });
      return res.status(200).json({ ok: true, id: r.id, sla_days: r.sla_days });
    }

    // ── 以下都要身分 ───────────────────────────────────────────────────
    if (!B.b2bConfigured()) return res.status(503).json({ error: new B.B2BNotConfigured().message, code: 'not_configured' });
    if (authBlocked(req) || keyFailures.blocked(clientIp(req))) return tooManyAttempts(res);
    const actor = await resolveActor(req);
    if (!actor) return res.status(401).json({ error: '連結無效或已停用，請向業發處管理員索取新的個人連結' });
    authed = true;
    const needAdmin = () => { if (actor.admin) return false; res.status(403).json({ error: '只有管理員可以做這件事' }); return true; };

    if (isGet && action === 'b2b_me') {
      const [members, cfg] = await Promise.all([B.loadMembers(), B.loadSettings()]);
      const m = actor.member;
      return res.status(200).json({
        me: { id: m.id, name: m.name, role: m.role, unit: m.unit || '', line_bound: !!m.line_user_id, line_bind_url: m.id === 'admin' ? '' : B.memberLineBindUrl(m) },
        admin: actor.admin,
        members: members.filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, unit: x.unit })),
        statuses: B.INQUIRY_STATUSES, roles: B.ROLES,
        push: B.pushUsage(cfg) // 本月用米亞推了幾則通知（額度用完時收件匣顯示提示）
      });
    }
    if (isGet && action === 'b2b_list') return res.status(200).json({ inquiries: await B.listInquiriesFor(actor) });
    if (isGet && action === 'b2b_get') {
      const q = await B.getInquiryFor(actor, src.id);
      return q ? res.status(200).json({ inquiry: q }) : res.status(404).json({ error: '找不到這筆洽詢' });
    }
    if (!isGet && action === 'b2b_update') {
      const r = await B.updateInquiry(actor, src.id, { status: src.status, owner: src.owner, note: src.note });
      return r.ok ? res.status(200).json({ success: true }) : res.status(r.status || 400).json({ error: r.error });
    }

    if (isGet && action === 'b2b_members') { if (needAdmin()) return; return res.status(200).json({ members: await B.listMembers() }); }
    if (!isGet && action === 'b2b_member_save') {
      if (needAdmin()) return;
      const r = await B.saveMember(actor, src);
      return r.ok ? res.status(200).json({ success: true, member: r.member, link: r.link || '' }) : res.status(r.status || 400).json({ error: r.error });
    }
    if (!isGet && action === 'b2b_member_reset') {
      if (needAdmin()) return;
      const r = await B.resetMemberKey(actor, src.id);
      return r.ok ? res.status(200).json({ success: true, link: r.link }) : res.status(r.status || 400).json({ error: r.error });
    }
    if (isGet && action === 'b2b_settings') {
      if (needAdmin()) return;
      const cfg = await B.loadSettings({ fresh: true });
      return res.status(200).json({ settings: cfg, push: B.pushUsage(cfg), privacy_template: B.INQUIRY_PRIVACY_TEMPLATE });
    }
    if (!isGet && action === 'b2b_settings_save') {
      if (needAdmin()) return;
      return res.status(200).json({ success: true, ...(await B.saveSettings(actor, src)) });
    }
    if (isGet && action === 'b2b_audit') { if (needAdmin()) return; return res.status(200).json({ audit: await B.listAudit() }); }

    return res.status(400).json({ error: `不支援的操作: ${action}` });
  } catch (err) {
    console.error(`[b2b] ${action} 失敗:`, err.message);
    // 公開端點不把內部錯誤（Sheets 權限、欄位名稱…）給外人看；驗過身分的看得到原因
    return res.status(500).json({ error: authed ? err.message : '系統忙碌中，請稍後再試；如果一直失敗，請直接聯絡業務窗口' });
  }
}
