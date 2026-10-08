// 米亞（LINE）的活動報名：「我要報名」、報名完成頁的「#報名」綁定。資料層與規則在 lib/registration.js。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。

import { readRange, appendRows, updateRange } from './sheets.js';
import { toTraditionalTW } from './zh-tw.js';
import { replyOrPushMessages } from './line.js';
import { detectMetaIntent } from './menu.js';
import {
  listOpenCampaigns, listRegistrationTopics, loadCampaigns, findRegistrationsForLineUser, bindRegistrationToLine,
  buildRegistrationFlex, buildRegistrationText, describeSessions, isCampaignRegisterPhrase
} from './registration.js';
import { createLimiter } from './rate-limit.js';
import { sanitize } from './line-format.js';
import { LINE_USERS_RANGE, ensureLineUsersSheet, invalidateLineUsersCache } from './line-store.js';
import { HOME_MENU, quickReplyOf, replyOrPush, twFlex } from './line-runtime.js';

// ── 活動報名（批次 88；批次 112 由「媒體報名」改名）─────────────────────────
// 資料層與規則在 lib/registration.js；這裡只負責「米亞這一端」：
//   ① 「我要報名」→ 一張卡片，點開是 LINE 內建瀏覽器裡的報名表（不是在聊天室一題一題問）
//   ② 報名完成頁的「用 LINE 連結我的報名」→ 「#報名 R7K3M」→ 把這個 LINE 帳號連到那筆報名
// 兩條都是固定程式回覆，不呼叫模型。
// 「我要報名」這類講法只有在「真的有報名可講」時才攔（開放中，或剛截止一週內）。都沒有的時候當一般
// 訊息，照原本的路徑走（綁定中交給那場問答、沒綁定交給路由／兜底）——上線後只要沒開任何報名活動，
// 米亞對「報名」「怎麼報名」的反應跟以前完全一樣，不會憑空多出一句「目前沒有開放報名」蓋掉問答。
export async function resolveMetaIntent(text) {
  const intent = detectMetaIntent(text);
  if (intent && intent !== 'register') return intent;
  // 沒有「報名」兩個字的訊息不必為了這件事多讀一次試算表（每則訊息都會走到這裡）
  if (!intent && !/報名/.test(String(text || ''))) return intent;
  const { open, closed } = await listRegistrationTopics();
  if (intent === 'register') return open.length || closed.length ? intent : null;
  // 批次 112：「眺望2027場次報名」這類——簡稱或活動名稱＋報名，認得目前每一個活動，不只眺望
  return [...open, ...closed].some((c) => isCampaignRegisterPhrase(text, c)) ? 'register' : null;
}

export async function handleRegisterIntent(replyToken, targetId, { group = false, staff = false } = {}) {
  let campaigns = await listOpenCampaigns();
  if (!staff && !campaigns.length) {
    // 剛截止的活動：老實說已截止，並附上媒體聯絡人（後台「媒體聯絡人」欄），比沉默或亂答有用
    // 批次 112：剛截止的活動可能不只一個，全部列出（以前只講第一個，另一個的記者會以為沒有這場）
    const { closed } = await listRegistrationTopics();
    if (closed.length) {
      const blocks = closed.slice(0, 3).map((c) =>
        `《${c.title}》的報名已經截止了。` + (c.contact ? `\n如果還想參加，請直接聯絡活動聯絡人：\n${c.contact}` : ''));
      const noContact = closed.slice(0, 3).some((c) => !c.contact);
      await replyOrPush(replyToken, targetId,
        blocks.join('\n\n') + (noContact ? '\n\n如果還想參加，請打「找真人」，同仁會協助您。' : ''),
        HOME_MENU);
      return;
    }
  }
  if (staff) {
    // 職員看得到草稿（測試中）的報名活動，才能在上線前自己走一遍
    try {
      campaigns = (await loadCampaigns()).filter(c => c.status !== 'closed')
        .map(c => (c.status === 'draft' ? { ...c, title: `${c.title}（測試中）` } : c));
    } catch { /* 讀不到就退回一般記者看到的 */ }
  }
  if (!campaigns.length) {
    await replyOrPush(replyToken, targetId,
      '目前沒有開放報名的活動。\n\n有新的活動報名開放時，這裡會第一時間放出來。想看看有哪些活動可以打「最近有哪些活動」，要找窗口打「媒體邀訪需求」。',
      HOME_MENU);
    return;
  }
  // 群組裡不帶任何人的身分：卡片是全群組看得到的，把某個人的簽章放上去就等於轉發給所有人
  const userId = group ? '' : targetId;
  const regs = group ? [] : await findRegistrationsForLineUser(targetId);
  const flex = { ...twFlex(buildRegistrationFlex(campaigns, regs, { userId })), quickReply: quickReplyOf(HOME_MENU) };
  const ok = await replyOrPushMessages(replyToken, targetId, [flex]);
  if (!ok) {
    await replyOrPush(replyToken, targetId, toTraditionalTW(buildRegistrationText(campaigns, regs, { userId })), HOME_MENU);
  }
}

// 自報的媒體名稱順手記進 line_users（跟 #代碼綁定時問的那個是同一欄）：報名時他已經填過單位了，
// 之後米亞不必再問一次「方便留個貴媒體的名稱嗎？」。原本是空的或他之前選了「略過」才寫。
async function rememberMediaNameFromRegistration(userId, outlet) {
  const name = sanitize(outlet, 40);
  if (!name) return;
  try {
    await ensureLineUsersSheet();
    const rows = await readRange(LINE_USERS_RANGE);
    const idx = rows.findIndex(r => r[0] === userId);
    if (idx === -1) await appendRows('line_users!A:F', [[userId, '', name, '', String(Date.now()), '']]);
    else if (!rows[idx][2] || rows[idx][2] === '（未提供）') await updateRange(`line_users!C${idx + 2}`, [[name]]);
  } catch (e) {
    console.error('報名後記錄媒體名稱失敗（不影響綁定）:', e.message);
  } finally {
    invalidateLineUsersCache();
  }
}

// 綁定失敗的限流（批次 116）：報名編號只有 5 碼，舊按鈕又不帶檢查碼——同一個 LINE 帳號一天錯 5 次
// 就先停手，一個一個猜編號的路走不通。正常人按的是完成頁的按鈕，一天錯不到兩次。
// 跟其他限流一樣只記在這個 instance 的記憶體裡（best-effort，見 lib/rate-limit.js）。
const regBindFails = createLimiter({ windowMs: 24 * 3600e3, max: 5 });

export async function handleRegBind(replyToken, userId, code, check = '') {
  if (regBindFails.blocked(userId)) {
    await replyOrPush(replyToken, userId, '連結報名的嘗試次數太多了，請明天再試；或打「找真人」，同仁會協助您。', HOME_MENU);
    return;
  }
  let r;
  try {
    r = await bindRegistrationToLine(code, userId, { check });
    if (!r.ok) regBindFails.hit(userId);
  } catch (e) {
    console.error('綁定報名失敗:', e.message);
    await replyOrPush(replyToken, userId, '報名資料暫時讀不到，請稍後再按一次；如果一直不行，打「找真人」，同仁會協助您。', HOME_MENU);
    return;
  }
  if (!r.ok) {
    const msg = {
      not_found: '找不到這個報名編號 🤔 請回到報名完成的頁面，再按一次「用 LINE 連結我的報名」。如果還是不行，打「找真人」，同仁會協助您。',
      taken: '這筆報名已經連結到另一個 LINE 帳號了。如果那不是您本人，請打「找真人」，同仁會協助處理。',
      inactive: '這筆報名已經取消了。要重新報名，請打「我要報名」。',
      has_other: `您的 LINE 已經連結另一筆報名${r.reg?.name ? `（${r.reg.name}）` : ''}，同一個活動只能連結一筆。要看或修改請打「我要報名」。`
    }[r.reason] || '這筆報名暫時連結不了，請打「找真人」，同仁會協助您。';
    await replyOrPush(replyToken, userId, msg, HOME_MENU);
    return;
  }
  await rememberMediaNameFromRegistration(userId, r.reg.outlet);
  const lines = r.campaign ? describeSessions(r.campaign, r.reg.sessions) : [];
  await replyOrPush(replyToken, userId,
    `${r.already ? '這筆報名早就連結好了' : '已連結您的報名'} ✅\n\n` +
    `${r.campaign ? `《${r.campaign.title}》\n` : ''}${r.reg.name}｜${r.reg.outlet}\n` +
    `已報名 ${r.reg.sessions.length} 場：\n${lines.map(t => `・${t}`).join('\n')}\n\n` +
    '想改場次，打「我要報名」就找得到；議程、交通、報到時間，也可以直接問我。',
    HOME_MENU);
}
