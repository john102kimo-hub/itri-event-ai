// 同仁在 LINE「試問記者會當天的答案」（批次 175，職員模式與同仁模式共用）。
//
// 朱朱：「活動前記者問答只會顯示媒體邀請函內容，無法測試記者會當天真實問答狀況」。活動日之前米亞只用邀請函回答
// （lib/prompt.js resolveEventContent()），同仁自己又沒辦法把日期調成今天——試不到記者會當天的樣子。
//
// 做法：活動卡上多一顆「🎤 試問當天答案」（只在「活動還沒到、有邀請函」的場次出現），按下去進入試問：
// 接下來同仁打的每一句，都當成記者在活動當天問的（同一份活動資料加 sim_day 旗標，見 lib/prompt.js simulateEventDay()）。
// 打「結束試問」離開；10 分鐘沒動靜自動結束（用的是職員表 E 欄的追問狀態，見 lib/staff.js PENDING_TTL_MS）。
//
// ⚠️ 只有已經驗過身分的同仁／職員才走得到這支（api/line.js 只在 handleStaffMessage／handleColleagueMessage 裡呼叫），
// 記者自己打「試問：某某活動」只是一句普通的問題，沒有任何旗標會被帶進去。
// ⚠️ 試問記成「（內部職員）」：結案報告與後台統計本來就會濾掉（lib/media-name.js）。

import { getEventById } from './line-store.js';
import { canSimulateDay, simulateEventDay } from './prompt.js';
import { effectiveChips } from './default-chips.js';
import { setStaffPending, isExitStaffCommand, isExitColleagueCommand } from './staff.js';
import { STAFF_HOME_CHIPS, COLLEAGUE_HOME_CHIPS, replyOrPush, staffChips } from './line-runtime.js';
import { answerQuestion } from './line-reporter.js';
import { MEDIA_STAFF } from './media-name.js';

export const SIM_INTENT = 'sim_day';
// 整句比對：「不用報名嗎？」這種問題開頭剛好是「不用」，不能當成結束（isCancelReply 是開頭比對，這裡不用它）
const SIM_END_RE = /^(結束試問|結束模擬|不試了|算了|不用了|取消)[?？!！。]?$/;
const END_CHIP = { label: '🔚 結束試問', text: '結束試問' };
const NOTICE = '🎤 模擬記者會當天（打「結束試問」離開）\n';

// 選單上的格子（職員、同仁兩套）與「指令：活動名稱」那幾種按鈕——按到這些就是不想試問了，交還給原本的處理
const MENU_TEXTS = new Set([...STAFF_HOME_CHIPS, ...COLLEAGUE_HOME_CHIPS]
  .map(c => c.text).concat(['職員選單', '同仁選單', '更多功能', '使用說明', '回首頁', '主選單']));
const COMMAND_PREFIX_RE = /^(發布|訓練|催填|數據|試問|新增活動|修改活動|更新活動)\s*[:：]/;

export function leavesSim(text) {
  const s = String(text || '').trim();
  return MENU_TEXTS.has(s) || COMMAND_PREFIX_RE.test(s) || isExitStaffCommand(s) || isExitColleagueCommand(s);
}

/** 活動卡上的按鈕。只有「活動還沒到、有邀請函」才放，其他場次放了按下去也沒有差別。 */
export function simChipFor(event) {
  return event && canSimulateDay(event) ? { label: '🎤 試問當天答案', text: `試問：${event.name}` } : null;
}

export async function startSimDay(replyToken, userId, eventId) {
  const ev = await getEventById(eventId);
  if (!ev) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips());
    return;
  }
  if (!canSimulateDay(ev)) {
    await replyOrPush(replyToken, userId,
      `《${ev.name}》不用模擬 🙂\n記者現在問到的，本來就是新聞稿那一份（活動已經到了，或這場沒有填邀請函）。`,
      staffChips({ label: '看這場的活動卡', text: ev.name }));
    return;
  }
  await setStaffPending(userId, SIM_INTENT, { eventId });
  const samples = effectiveChips(simulateEventDay(ev)).slice(0, 4);
  await replyOrPush(replyToken, userId,
    `🎤 開始試問：《${ev.name}》\n\n` +
    '接下來你打的每一句，米亞都用「活動當天」記者會拿到的內容回答（新聞稿、照片、當天的快速提問）。\n\n' +
    '・這是測試：記者現在問到的還是邀請函，不受影響\n' +
    '・問答不會算進統計\n' +
    '・問完了點下面的「結束試問」（10 分鐘沒動靜也會自動結束）\n\n' +
    '直接打問題，或點下面記者當天會看到的快速提問。',
    staffChips(END_CHIP, ...samples));
}

/**
 * 試問中收到的每一句。回 true＝這一句我處理掉了；回 false＝不是試問的事（選單、退出模式、新的指令），
 * 試問狀態已經清掉，呼叫端照原本的流程往下走。
 */
export async function handleSimMessage(replyToken, userId, text, payload) {
  const s = String(text || '').trim();
  if (leavesSim(s)) { await setStaffPending(userId, ''); return false; }
  if (SIM_END_RE.test(s)) {
    await setStaffPending(userId, '');
    await replyOrPush(replyToken, userId, '好，結束試問 👌 記者那邊不受影響。', staffChips());
    return true;
  }
  const ev = payload?.eventId ? await getEventById(payload.eventId) : null;
  if (!ev) {
    await setStaffPending(userId, '');
    await replyOrPush(replyToken, userId, '找不到這場活動，試問先結束了。', staffChips());
    return true;
  }
  await setStaffPending(userId, SIM_INTENT, { eventId: ev.id }); // 每問一題就把 10 分鐘重新算
  await answerQuestion(replyToken, userId, simulateEventDay(ev), MEDIA_STAFF, s, { switchNotice: NOTICE });
  return true;
}
