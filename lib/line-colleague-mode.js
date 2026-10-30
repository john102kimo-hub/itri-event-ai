// 米亞（LINE）的同仁模式（批次 138）：給一般同事用，只有四件事——
//   新增活動、修改活動（附網站連結）、發布、媒體訓練連結。其餘全部看不到、也叫不到。
// 批次 177 加了「一步步帶我」（新增活動後依序問日期、媒體邀請函、地點、聯絡人）、活動負責人（活動前一天提醒），
// 以及同仁可以直接傳照片——都是新增活動這件事的延伸，不是新的功能區。
//
// 朱朱的原話：「根據一般同仁做一個同仁模式，裡面就很單純新增、修改活動（並附上網站連結）、媒體訓練連結，
// 不然功能太複雜也不會用」；決定：所有場次都能改、可以自行發布（「反正我後台可以看」）。
//
// ⚠️ 這支是**白名單**，不是職員模式砍功能：同仁的每一則訊息只走這支，職員的 handleStaffMessage() 完全進不來。
// 身分判斷也一樣——lib/staff.js 的 isStaffAuthenticated() 只認職員，同仁預設進不去任何「職員才有」的入口。
// 同仁能做的事靠這裡一件一件列出來；以後新增職員功能，同仁預設就沒有（CLAUDE.md 第 2 條：擋在程式出口，不靠選單把按鈕藏起來）。
//
// 能共用的都共用職員模式那一套（改資料、確認、復原、發布的檢查清單、在 LINE 改的欄位白名單、修改紀錄、通知管理員），
// 同一件事不寫兩份。同仁模式自己多的只有：入口按鈕、活動卡（附連結）、改完附網站連結、不認得的就說「這個請找管理員」。

import { detectCourtesy, matchEventByName } from './menu.js';
import { buildAllCalendarCards } from './router.js';
import { unlinkRichMenuFromUser } from './line.js';
import { getAllEventRows, invalidateEventsCache } from './line-store.js';
import { HOME_MENU, COLLEAGUE_HOME_CHIPS, markColleague, replyOrPush, staffChips, twFlex, quickReplyOf } from './line-runtime.js';
import { replyOrPushMessages } from './line.js';
import {
  routeStaffIntent, parseCreateEventText, createDraftEvent, editLink, trainingLink, ensureEventEditCode, isExitColleagueCommand,
  revokeStaff, setStaffPending, isCancelReply, staffPickList, dateWithWeekday, todayTaipei, getStaffPendingData, getStaffName
} from './staff.js';
import { eventChecklist, shortDate, STATUS_LABEL, preEventWithoutInvite, buildColleagueCardFlex, previewLink } from './event-status.js';
import { proposeChange, applyChange, normalizeValue, readEventRowFresh } from './event-edit.js';
import { getOwnerMap, setEventOwner } from './event-owner.js';
import {
  GUIDE_ORDER, missingGuideSteps, nextGuideStep, guideQuestion, parseLooseDate, isNotYetReply, SKIP_RE, INVITE_MIN
} from './event-guide.js';
import { SIM_INTENT, handleSimMessage, simChipFor, startSimDay } from './line-sim-day.js';
import { rowToEvent } from './line-store.js';
import {
  handleEditFlow, proposeUpdate, proposePublish, findCardByExactName, notifyAdminOfChange, eventLinksText
} from './line-staff-mode.js';

// 選單與按鈕送出的固定句型，一律字面比對、不交給模型（跟職員模式同一個理由：按鈕是我們自己的，100% 認得出來）。
// ⚠️ 不用 detectMetaIntent() 的 'switch'／'menu'／'help'：它的「換/改 + 活動」規則會把「地點改成活動中心」
// 當成「換一場」。同仁模式的首頁、說明只認整句。
const HOME_RE = /^(🏠\s*)?(同仁選單|同仁首頁|回同仁選單|選單|主選單|回首頁|回到首頁)[?？!！。]?$/;
const HELP_RE = /^(使用說明|說明|教學|怎麼用|怎麼使用|功能|help)[?？!！。]?$/i;
const ENTRY_RE = /^(修改活動|更新活動|更新活動資訊|修改活動資訊|改活動資料|活動與進度|活動進度)[?？!！。]?$/;
const NEW_RE = /^(新增活動|新增一場活動|建立活動)[?？!！。]?$/;
const TRAIN_RE = /^(媒體訓練|要媒體訓練連結|媒體訓練連結)[?？!！。]?$/;
const CARD_CMD_RE = /^(發布|訓練|試問|帶我|自己填|邀請函|負責)\s*[:：]\s*(.+)$/;
// 路由判成這幾種、而且已經指到場次，就照那個指令做（問「新活動叫什麼」時同仁改口的情況）
const SWITCH_INTENTS = ['update_event', 'publish', 'training_link', 'calendar', 'progress'];
// 等著回答「哪一場」的追問。這時候點活動名稱是在回答問題，不是開活動卡。
const PICKING = ['create_event', 'training_pick', 'update_pick', 'publish_pick'];

const nameOf = (cards, id) => cards.find(c => c.id === id)?.name || id;
// 同仁選場次：只列接下來要辦的（改資料、發布、要訓練連結都不會是辦完的場次）
const pickNames = (cards) => staffPickList(cards, 8, { includePast: false }).map(c => c.name);

// 退出的入口（批次 138 補）。三格選單已經滿了，天天掛在每則回覆上又太容易誤按（按錯要重打密語），
// 所以只放在「同仁選單／使用說明／聽不懂」這三個「找不到功能」的地方——職員模式的「退出」也是收在「更多功能」。
// 上線後第一次試用就回報「同仁模式沒有退出」：以前只有說明文字寫了「請打退出同仁模式」，沒有任何按鈕。
const EXIT_CHIP = { label: '🚪 退出同仁模式', text: '退出同仁模式' };
const HOME_WITH_EXIT = [...COLLEAGUE_HOME_CHIPS, EXIT_CHIP];

async function sendHome(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '要做什麼呢？點下面的按鈕，或直接用講的 🙂\n例如「智慧醫療那場地點改成南港展覽館」。\n要回到記者身分，點「🚪 退出同仁模式」。',
    HOME_WITH_EXIT);
}

async function sendHelp(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '同仁模式能做的事 🔧 常用的都在下方選單。\n\n' +
    '・新增活動：點「新增活動」，打名稱就建好，我會一步步帶你填日期、媒體邀請函、地點、聯絡人（也可以選自己填）；也可以一次講完，例如「新增活動：智慧醫療論壇 10/28」\n' +
    '・修改活動：點「修改活動」選一場，再說要改什麼，例如「地點改成南港展覽館」，我會先跟你確認\n' +
    '・發布：點活動後按「🚀 發布」，或說「發布 智慧醫療那場」（日期、地點、新聞聯絡人、新聞稿要先填齊）\n' +
    '・媒體訓練：點「媒體訓練」選一場，給你發言練習連結\n' +
    '・照片：活動現場拍的照片直接傳給我，再點是哪一場\n' +
    '・提醒：建活動的人就是負責人，活動前一天傍晚我會提醒你還缺哪些資料（新聞稿、議程、受訪者⋯）\n\n' +
    '想像記者一樣問米亞問題，點下面的「🚪 退出同仁模式」（再進來打一次密語就好）。',
    HOME_WITH_EXIT);
}

async function sendEditEntry(replyToken, userId, cards) {
  const names = pickNames(cards);
  await replyOrPush(replyToken, userId,
    names.length
      ? '要改哪一場？點下面的活動，或直接說，例如「智慧醫療那場地點改成南港展覽館」。\n\n' +
        '在 LINE 可以改：名稱、日期、時間、地點、新聞聯絡人。新聞稿、邀請函、照片，點活動之後用編輯頁連結改。'
      : '目前沒有可以修改的活動。要建新的，點「新增活動」。',
    staffChips(...names));
}

// 活動卡：點了活動名稱看到的。批次 178 起是 Flex 圖像卡（版面理由見 lib/event-status.js buildColleagueCardFlex()），
// 按鈕在卡片上；快速回覆只留「修改活動」「試問當天答案」跟回同仁選單。
// Flex 送不出去（舊版 LINE、格式被拒）退回下面那份純文字，跟職員的活動卡同一套降級。
async function sendCard(replyToken, userId, eventId) {
  const row = (await getAllEventRows()).find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips('修改活動'));
    return;
  }
  const today = todayTaipei();
  const c = eventChecklist(row, today);
  const when = [c.date ? shortDate(c.date) : '日期未定', c.time, c.venue].filter(Boolean).join('｜');
  const owner = (await getOwnerMap()).get(eventId);
  const ownerLabel = owner ? (owner.userId === userId ? '你' : owner.name || '（已指定）') : '還沒有（活動前一天的提醒會送給管理員）';
  const lines = [`《${c.name}》${STATUS_LABEL[c.status] || c.status}`, when, ''];
  lines.push(c.missingRequired.length ? `必填 ${c.doneRequired}／${c.totalRequired}，還缺：${c.missingRequired.join('、')}`
    : c.kbPending ? `必填 ${c.doneRequired}／${c.totalRequired} ✅ 可以發布（新聞稿活動當天前補上，活動前先用邀請函）` : `必填 ${c.doneRequired}／${c.totalRequired} ✅ 都填齊了`);
  lines.push(`負責人：${ownerLabel}`);
  lines.push('\n接著直接說要改什麼就好，例如「地點改成南港展覽館」。');
  const links = (await eventLinksText(eventId)).trim();
  if (links) lines.push('\n' + links);
  const canPublish = c.status === 'draft' && !c.missingRequired.length;
  const guideLeft = missingGuideSteps(row, today);
  const canClaim = owner?.userId !== userId;
  // 接著那一句「地點改成⋯」不用再講是哪一場（一次性，10 分鐘內有效，見 lib/staff.js getStaffPending）
  await setStaffPending(userId, 'edit_event', { eventId });
  const editCode = await ensureEventEditCode(eventId);
  const flex = twFlex(buildColleagueCardFlex(c, {
    ownerLabel, canPublish, guideLeft, canClaim,
    links: { edit: editCode ? editLink(eventId, editCode) : '', preview: previewLink(eventId) }
  }));
  const cardChips = staffChips({ label: '✏️ 修改別場', text: '修改活動' }, simChipFor(rowToEvent(row)));
  flex.quickReply = quickReplyOf(cardChips);
  const ok = await replyOrPushMessages(replyToken, userId, [flex]);
  if (ok) return;
  await replyOrPush(replyToken, userId, lines.join('\n'),
    staffChips(canPublish ? { label: '🚀 發布', text: `發布：${c.name}` } : null,
      guideLeft.length ? { label: '👣 帶我完成', text: `帶我：${c.name}` } : null,
      guideLeft.includes('invite') ? { label: '📨 貼上邀請函', text: `邀請函：${c.name}` } : null,
      { label: '🎤 媒體訓練', text: `訓練：${c.name}` }, simChipFor(rowToEvent(row)),
      canClaim ? { label: '🙋 我來負責', text: `負責：${c.name}` } : null,
      '修改活動'));
}

async function sendTraining(replyToken, userId, eventId, name) {
  // 舊活動可能還沒有編輯碼，當場補一個（冪等）
  const editCode = await ensureEventEditCode(eventId);
  if (!editCode) {
    await replyOrPush(replyToken, userId, '這場活動的連結產生失敗，請稍後再試。', staffChips());
    return;
  }
  await replyOrPush(replyToken, userId,
    `《${name}》\n\n媒體訓練（發言練習）：\n${trainingLink(eventId, editCode)}`,
    staffChips({ label: '✏️ 修改這場', text: name }));
}

async function askTrainingPick(replyToken, userId, cards) {
  await setStaffPending(userId, 'training_pick');
  await replyOrPush(replyToken, userId, '要哪一場的媒體訓練連結？點下面的活動，或打活動名稱。', staffChips(...pickNames(cards)));
}

async function askNewName(replyToken, userId) {
  // 記下「我正在等新活動名稱」，下一則整句就會被當成名稱
  await setStaffPending(userId, 'create_event');
  await replyOrPush(replyToken, userId,
    '請告訴我新活動的名稱，直接打名稱就好，例如：\n半導體先進封裝技術發表會\n\n（可以順便帶日期，例如「眺望研討會 10/28」；不建了就回「算了」）',
    staffChips({ label: '✖ 算了', text: '算了' }));
}

async function createEvent(replyToken, userId, name, date) {
  const created = await createDraftEvent(name, date);
  invalidateEventsCache();
  const userName = await getStaffName(userId);
  // 建立的人就是負責人（批次 177）：活動前一天的提醒送給他，不用另外「綁定」
  const ownerOk = await setEventOwner(created.id, userId, userName, 'create');
  console.log(`[line] 同仁新增活動 id=${created.id} name="${created.name}" owner=${ownerOk ? 'ok' : 'fail'}`);
  await replyOrPush(replyToken, userId,
    `已建立《${created.name}》✅\n日期：${dateWithWeekday(date) || '未定'}\n狀態：未發布，記者還看不到\n` +
    (ownerOk
      ? `你是這場的負責人${date ? '，活動前一天傍晚我會提醒你補資料。' : '。（還沒有日期，我沒辦法提醒你；下一步會先問日期。）'}\n\n`
      : '⚠️ 負責人沒記起來（暫時寫不進去），活動前一天的提醒可能不會送給你。\n\n') +
    `想自己填的話，編輯頁在這（新聞稿、邀請函、照片都在這，不需要密碼）：\n${editLink(created.id, created.editCode)}\n\n` +
    '要我一步步帶你把基本資料填完嗎？只要回答幾個問題。',
    staffChips({ label: '👣 一步步帶我', text: `帶我：${created.name}` }, { label: '✏️ 我自己填', text: `自己填：${created.name}` }));
  await notifyAdminOfChange(userId,
    `➕ 同仁新增了活動\n《${created.name}》\n新增的人：${userName || '（沒有名字）'}\nLINE ID：${userId}`);
}

// ── 一步步帶我（批次 177）─────────────────────────────────────────────────
// 引導是從資料算出來的（lib/event-guide.js nextGuideStep()），不是存起來的狀態機：同仁問到一半去開會，
// 隔天點活動卡的「👣 帶我完成」就從還缺的那一題接著問。追問狀態只用來接「正在等他回答這一題」的下一句（10 分鐘）。

// 這場有負責人就不動；沒有就記成這個人（他按了「帶我」「自己填」，就是在接手這場）。回傳是否剛剛認領了。
async function ensureOwner(userId, eventId) {
  const owners = await getOwnerMap();
  if (owners.get(eventId)) return false;
  return setEventOwner(eventId, userId, await getStaffName(userId), 'guide');
}

async function askGuide(replyToken, userId, eventId, fromIdx = 0, prefix = '') {
  const row = await readEventRowFresh(eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips('修改活動'));
    return;
  }
  const step = nextGuideStep(row, todayTaipei(), fromIdx);
  if (!step) return finishGuide(replyToken, userId, row, prefix);
  await setStaffPending(userId, `guide_${step.key}`, { eventId, idx: step.idx });
  await replyOrPush(replyToken, userId, (prefix ? prefix + '\n\n' : '') + guideQuestion(step.key, row[1] || ''),
    staffChips({ label: '⏭ 先跳過', text: '先跳過' }, { label: '✖ 先到這', text: '算了' }));
}

async function finishGuide(replyToken, userId, row, prefix = '') {
  const today = todayTaipei();
  const c = eventChecklist(row, today);
  const when = [c.date ? shortDate(c.date) : '日期未定', c.time, c.venue].filter(Boolean).join('｜');
  const lines = [];
  if (prefix) lines.push(prefix, '');
  lines.push(`基本資料填好了 🎉《${c.name}》`, when, '');
  const missingNow = missingGuideSteps(row, today);
  if (missingNow.length) {
    const label = { date: '日期', invite: '媒體邀請函', venue: '地點', contact: '新聞聯絡人' };
    lines.push(`還沒填：${missingNow.map(k => label[k]).join('、')}（點活動卡的「👣 帶我完成」可以接著填）`, '');
  }
  if (preEventWithoutInvite(row, today)) {
    lines.push('⚠️ 媒體邀請函還沒填：發布前請先補。活動前沒有邀請函就發布，記者一問就會看到整份新聞稿（包括還不能曝光的部分）。', '');
  }
  lines.push(
    '接下來：',
    '・新聞稿、議程、受訪者、貴賓：到編輯頁貼（連結在下面）。活動前一天傍晚我會提醒你還缺哪些。',
    '・快速提問按鈕會依你填的內容自動長出來，不用設定。',
    '・活動當天或隔天拍的照片，直接傳給我就好。');
  const links = (await eventLinksText(c.id)).trim();
  if (links) lines.push('', links);
  const canPublish = c.status === 'draft' && !c.missingRequired.length;
  await replyOrPush(replyToken, userId, lines.join('\n'),
    staffChips(canPublish ? { label: '🚀 發布', text: `發布：${c.name}` } : null,
      { label: '🎤 媒體訓練', text: `訓練：${c.name}` }, '修改活動'));
}

// 引導裡的寫入：未發布的草稿記者看不到，不再確認一次（同仁是看著題目、親手打出答案的）；
// 已發布的場次照一般改資料的規矩，先確認（記者看得到的改動一律先確認）。
const STEP_FIELD = { date: 'date', venue: 'venue', contact: 'press_contact' };
async function guideWrite(userId, eventId, field, value) {
  const r = await proposeChange(eventId, field, value);
  if (!r.ok) return r;
  if (r.proposal.status !== 'draft') return { ok: true, confirm: true };
  const w = await applyChange(r.proposal, { userId, userName: await getStaffName(userId) });
  if (!w.ok) return w;
  invalidateEventsCache();
  return { ok: true, saved: true };
}

const SAVED_TEXT = {
  date: (v) => `日期記好了：${dateWithWeekday(v)}。活動前一天傍晚我會提醒你補資料。` + (v < todayTaipei() ? '\n⚠️ 這個日期已經過了，打錯的話隨時再跟我說。' : ''),
  venue: (v) => `地點記好了：${v}`,
  contact: (v) => `新聞聯絡人記好了：${v}`
};

// 回 true＝這則訊息已經當成這一題的答案處理完了
async function handleGuideAnswer(replyToken, userId, s, pending, payload) {
  const key = pending.replace(/^guide_/, '');
  const eventId = payload?.eventId;
  if (!eventId || !GUIDE_ORDER.includes(key)) return false;
  const idx = Number.isInteger(payload?.idx) ? payload.idx : GUIDE_ORDER.indexOf(key);
  const repend = () => setStaffPending(userId, pending, { eventId, idx });
  const skipChips = staffChips({ label: '⏭ 先跳過', text: '先跳過' }, { label: '✖ 先到這', text: '算了' });

  // 「算了」「晚點再說」：整個引導先停在這裡（長文字不套這條——邀請函全文開頭不會是「算了」，但保險）
  if (s.length <= 12 && isCancelReply(s)) {
    const row = await readEventRowFresh(eventId);
    await replyOrPush(replyToken, userId,
      '好，先到這 👌 想接著填的時候，點活動後按「👣 帶我完成」，我會從還缺的地方接著問。',
      staffChips(row ? { label: '看這場的活動卡', text: row[1] } : null));
    return true;
  }
  if (SKIP_RE.test(s) || (key === 'invite' && isNotYetReply(s))) {
    const note = key === 'date' ? '好，日期先留空。沒有日期我沒辦法提醒你，記得補上。'
      : key === 'invite' ? '好，邀請函先跳過。發布前記得補——活動前沒有邀請函就發布，記者會看到整份新聞稿。' : '好，先跳過。';
    await askGuide(replyToken, userId, eventId, idx + 1, note);
    return true;
  }

  if (key === 'invite') {
    if (s.length < INVITE_MIN) {
      await repend();
      await replyOrPush(replyToken, userId, '這看起來不像邀請函全文 🙏 請把邀請函的內容整段貼上來；還沒好的話按「先跳過」。', skipChips);
      return true;
    }
    const norm = normalizeValue('invite_letter', s);
    if (!norm.ok) {
      await repend();
      await replyOrPush(replyToken, userId, norm.reason, skipChips);
      return true;
    }
    // 邀請函一律先給人看預覽、按確認才寫（記者活動前唯一看得到的整段內容）
    await proposeUpdate(replyToken, userId, eventId, 'invite_letter', s, { guide: true });
    return true;
  }

  const field = STEP_FIELD[key];
  const value = key === 'date' ? parseLooseDate(s, todayTaipei()) : s;
  if (key === 'date' && !value) {
    await repend();
    await replyOrPush(replyToken, userId, '日期看不懂 🙏 請用「10/28」或「2026-10-28」這種寫法再打一次；還沒定的話按「先跳過」。', skipChips);
    return true;
  }
  const r = await guideWrite(userId, eventId, field, value);
  if (r.same) { await askGuide(replyToken, userId, eventId, idx + 1, r.reason); return true; }
  if (!r.ok) {
    await repend();
    await replyOrPush(replyToken, userId, r.reason, skipChips);
    return true;
  }
  if (r.confirm) { await proposeUpdate(replyToken, userId, eventId, field, value, { guide: true }); return true; }
  await askGuide(replyToken, userId, eventId, idx + 1, SAVED_TEXT[key](value ?? ''));
  return true;
}

// 「負責：活動名稱」——明確接手（原本有別人負責也改成你，並通知管理員）
async function claimEvent(replyToken, userId, target) {
  const owners = await getOwnerMap();
  const prev = owners.get(target.id);
  if (prev?.userId === userId) {
    await replyOrPush(replyToken, userId, `《${target.name}》本來就是你負責的 👍`, staffChips({ label: '看這場的活動卡', text: target.name }));
    return;
  }
  const userName = await getStaffName(userId);
  if (!(await setEventOwner(target.id, userId, userName, 'claim'))) {
    await replyOrPush(replyToken, userId, '負責人沒記起來（暫時寫不進去），請稍後再按一次 🙏', staffChips({ label: '看這場的活動卡', text: target.name }));
    return;
  }
  const row = (await getAllEventRows()).find(r => r[0] === target.id);
  await replyOrPush(replyToken, userId,
    `好，《${target.name}》由你負責 ✅\n活動前一天傍晚，我會提醒你還缺哪些資料。` +
    (row && !eventChecklist(row, todayTaipei()).date ? '\n（這場還沒有日期，先補日期我才能提醒你。）' : ''),
    staffChips({ label: '👣 帶我完成', text: `帶我：${target.name}` }, { label: '看這場的活動卡', text: target.name }));
  if (prev) {
    await notifyAdminOfChange(userId, `🙋 活動負責人變更\n《${target.name}》\n原負責人：${prev.name || prev.userId}\n新負責人：${userName || '（沒有名字）'}\nLINE ID：${userId}`);
  }
}

// 「自己填：活動名稱」——選擇不要引導：給編輯連結，並說清楚之後怎麼被提醒
async function sendSelfFill(replyToken, userId, target) {
  const claimed = await ensureOwner(userId, target.id);
  const links = (await eventLinksText(target.id)).trim();
  const row = (await getAllEventRows()).find(r => r[0] === target.id);
  const noDate = row && !eventChecklist(row, todayTaipei()).date;
  await replyOrPush(replyToken, userId,
    `好，你自己填 👍《${target.name}》\n${links}\n\n` +
    (noDate ? '⚠️ 這場還沒有日期，記得先填日期，不然我沒辦法提醒你。' : '活動前一天傍晚，我會提醒你還缺哪些資料。') +
    (claimed ? '\n（我把你記成這場的負責人。）' : ''),
    staffChips({ label: '👣 改成一步步帶我', text: `帶我：${target.name}` }, { label: '看這場的活動卡', text: target.name }));
}

const FALLBACK_TEXT =
  '這個我在同仁模式幫不上忙 🙏\n\n' +
  '這裡只能：新增活動、修改活動（含發布）、拿媒體訓練連結。\n' +
  '改資料可以直接說，例如「智慧醫療那場地點改成南港展覽館」。\n\n' +
  '想像記者一樣問米亞問題，請打「退出同仁模式」；其他管理功能請找管理員。';

export async function handleColleagueMessage(replyToken, userId, text) {
  markColleague(); // 之後共用的 staffChips() 會自己換成同仁的按鈕
  const s = String(text || '').trim();

  // 試問記者會當天的答案（批次 175）：試問中打的每一句都當記者問題；選單、退出、新指令會先結束試問再照原本流程走。
  // 同仁模式本來沒有任何問答，這是唯一的例外——只能問「這一場、活動當天」的內容，不能叫到別的職員功能。
  const simPending = await getStaffPendingData(userId);
  if (simPending?.intent === SIM_INTENT && await handleSimMessage(replyToken, userId, s, simPending.payload)) return;

  // ⚠️ 退出跟職員模式一樣，一定用字面比對、不交給模型：權限的開與關不該取決於模型當下判得準不準。
  if (isExitColleagueCommand(s)) {
    await revokeStaff(userId);
    await unlinkRichMenuFromUser(userId); // 解除個人連結 → 自動落回記者選單
    console.log(`[line] 同仁退出 user=${userId}`);
    await replyOrPush(replyToken, userId,
      '已退出同仁模式 ✅\n\n您現在跟一般記者看到的一樣，下方選單也換回記者版。\n要再進來，重新輸入一次密語即可。',
      HOME_MENU);
    return;
  }
  if (HOME_RE.test(s)) return sendHome(replyToken, userId);
  if (HELP_RE.test(s)) return sendHelp(replyToken, userId);

  const cards = buildAllCalendarCards(await getAllEventRows());
  // 承接上一則的追問（讀最新的、不吃快取，理由見 lib/staff.js freshStaffRow()）。一次性，用掉就清。
  const pendingData = simPending; // 上面已經讀過（試問判斷），不多讀一次試算表
  const pending = pendingData?.intent || null;
  if (pending) await setStaffPending(userId, '');

  // 確認／取消修改、復原、「要改／發布哪一場」的回答——跟職員模式共用同一支
  if (await handleEditFlow(replyToken, userId, s, pendingData, cards)) return;

  if (ENTRY_RE.test(s)) return sendEditEntry(replyToken, userId, cards);
  if (NEW_RE.test(s)) return askNewName(replyToken, userId);
  if (TRAIN_RE.test(s)) return askTrainingPick(replyToken, userId, cards);

  const cardCmd = s.match(CARD_CMD_RE);
  if (cardCmd) {
    const target = findCardByExactName(cardCmd[2], cards);
    if (!target) {
      await replyOrPush(replyToken, userId, `找不到《${cardCmd[2].slice(0, 40)}》這場，可能剛被改名了。從清單再點一次：`, staffChips(...pickNames(cards)));
      return;
    }
    if (cardCmd[1] === '發布') return proposePublish(replyToken, userId, target.id);
    if (cardCmd[1] === '試問') return startSimDay(replyToken, userId, target.id);
    if (cardCmd[1] === '負責') return claimEvent(replyToken, userId, target);
    if (cardCmd[1] === '自己填') return sendSelfFill(replyToken, userId, target);
    if (cardCmd[1] === '帶我') {
      const claimed = await ensureOwner(userId, target.id);
      return askGuide(replyToken, userId, target.id, 0, claimed ? '我把你記成這場的負責人，活動前一天傍晚會提醒你補資料。' : '');
    }
    if (cardCmd[1] === '邀請函') {
      // 明確要貼邀請函：就算已經有一份也問（確認那一步會說「會整份換掉目前的」）
      await ensureOwner(userId, target.id);
      await setStaffPending(userId, 'guide_invite', { eventId: target.id, idx: GUIDE_ORDER.indexOf('invite') });
      return replyOrPush(replyToken, userId, guideQuestion('invite', target.name),
        staffChips({ label: '⏭ 先跳過', text: '先跳過' }, { label: '✖ 先到這', text: '算了' }));
    }
    return sendTraining(replyToken, userId, target.id, target.name);
  }

  // 「要哪一場的訓練連結」的答案
  if (pending === 'training_pick') {
    if (isCancelReply(s)) {
      await replyOrPush(replyToken, userId, '好，不拿了 👌', staffChips());
      return;
    }
    const target = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (target) return sendTraining(replyToken, userId, target.id, target.name);
  }

  // 「新增活動：名稱」連名稱一起打（批次 162）：字面認得出來就直接建，不問模型。
  // 排在「點活動名稱開活動卡」之前，也不受追問狀態影響——米亞剛問「新活動叫什麼」時，同仁照樣可能整句重打一次。
  const literalCreate = parseCreateEventText(s);
  if (literalCreate) return createEvent(replyToken, userId, literalCreate.name, literalCreate.date);

  // 「一步步帶我」正在等這一題的答案（批次 177）。排在「點活動名稱開活動卡」之前：地點、聯絡人的答案
  // 可能剛好長得像某一場的名稱。選單、退出、卡片按鈕、「新增活動」都在上面先處理掉了，不會被當成答案。
  if (pending && pending.startsWith('guide_') && pendingData?.payload?.eventId) {
    if (await handleGuideAnswer(replyToken, userId, s, pending, pendingData.payload)) return;
  }

  // 點了清單上的活動名稱（整句就是某一場的名稱）→ 活動卡。等「哪一場」答案的時候不攔：那時候點名稱是在回答問題。
  if (!PICKING.includes(pending)) {
    const tapped = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (tapped) return sendCard(replyToken, userId, tapped.id);
  }

  // 米亞剛問「新活動叫什麼名字」：「算了」不能當名稱（批次 76 的教訓：算了／不用了全部建出同名草稿）
  if (pending === 'create_event' && (isCancelReply(s) || detectCourtesy(s))) {
    await replyOrPush(replyToken, userId, '好，先不建立 👌 要建的時候再按「新增活動」就可以。', staffChips());
    return;
  }

  const routed = await routeStaffIntent(s, cards);

  if (pending === 'create_event') {
    // 模型明確判成別的指令、而且指到場次，就照那個做；否則整句就是名稱——「半導體技術發表會」
    // 看起來像在問某場活動的內容，不能交給模型重判（跟職員模式同一個做法）。
    const switched = SWITCH_INTENTS.includes(routed.intent) && (routed.event_ids.length || routed.intent === 'calendar' || routed.intent === 'progress');
    if (!switched) {
      const isCreate = routed.intent === 'create_event' && routed.new_event_name;
      return createEvent(replyToken, userId, isCreate ? routed.new_event_name : s, isCreate ? routed.new_event_date : '');
    }
  }

  // 活動卡剛顯示過：接著那一句「地點改成⋯」「發布」沒講哪一場，就是那一場
  const cardEventId = pending === 'edit_event' ? pendingData?.payload?.eventId : '';
  const ids = routed.event_ids.length ? routed.event_ids : (cardEventId ? [cardEventId] : []);
  const eventChips = (list) => staffChips(...(list && list.length ? list.map(id => nameOf(cards, id)) : pickNames(cards)));

  switch (routed.intent) {
    case 'calendar':
    case 'progress':
      return sendEditEntry(replyToken, userId, cards);

    case 'create_event':
      if (!routed.new_event_name) return askNewName(replyToken, userId);
      return createEvent(replyToken, userId, routed.new_event_name, routed.new_event_date);

    case 'update_event':
      if (!routed.update_field || !routed.update_value) {
        await replyOrPush(replyToken, userId,
          '要改哪一場的什麼？直接說就好，例如：\n・智慧醫療那場地點改成南港展覽館\n・眺望研討會改到 10/30\n・奈米那場的新聞聯絡人換成王小明 0912-345-678\n\n在 LINE 可以改：名稱、日期、時間、地點、新聞聯絡人。新聞稿、邀請函、照片請用編輯頁連結。',
          eventChips());
        return;
      }
      if (ids.length === 1) return proposeUpdate(replyToken, userId, ids[0], routed.update_field, routed.update_value);
      await setStaffPending(userId, 'update_pick', { field: routed.update_field, value: routed.update_value });
      await replyOrPush(replyToken, userId, `要改哪一場？（改成「${routed.update_value}」）點下面的活動，或打活動名稱。`, eventChips(ids));
      return;

    case 'publish':
      if (ids.length === 1) return proposePublish(replyToken, userId, ids[0]);
      await setStaffPending(userId, 'publish_pick');
      await replyOrPush(replyToken, userId, '要發布哪一場？點下面的活動，或打活動名稱。', eventChips(ids));
      return;

    case 'training_link':
      if (ids.length === 1) return sendTraining(replyToken, userId, ids[0], nameOf(cards, ids[0]));
      return askTrainingPick(replyToken, userId, cards);

    default:
      // qa／geo_status／event_analytics／setup_richmenu／other 全部走到這裡：同仁模式沒有這些，
      // 打字叫也叫不到（選單上沒有按鈕不算數，見檔案開頭）。
      await replyOrPush(replyToken, userId, FALLBACK_TEXT, HOME_WITH_EXIT);
  }
}
