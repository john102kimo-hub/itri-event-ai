// 米亞（LINE）的同仁模式（批次 138）：給一般同事用，只有四件事——
//   新增活動、修改活動（附網站連結）、發布、媒體訓練連結。其餘全部看不到、也叫不到。
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
import { HOME_MENU, COLLEAGUE_HOME_CHIPS, markColleague, replyOrPush, staffChips } from './line-runtime.js';
import {
  routeStaffIntent, createDraftEvent, editLink, trainingLink, ensureEventEditCode, isExitColleagueCommand,
  revokeStaff, setStaffPending, isCancelReply, staffPickList, dateWithWeekday, todayTaipei, getStaffPendingData, getStaffName
} from './staff.js';
import { eventChecklist, shortDate, STATUS_LABEL } from './event-status.js';
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
const CARD_CMD_RE = /^(發布|訓練)\s*[:：]\s*(.+)$/;
// 路由判成這幾種、而且已經指到場次，就照那個指令做（問「新活動叫什麼」時同仁改口的情況）
const SWITCH_INTENTS = ['update_event', 'publish', 'training_link', 'calendar', 'progress'];
// 等著回答「哪一場」的追問。這時候點活動名稱是在回答問題，不是開活動卡。
const PICKING = ['create_event', 'training_pick', 'update_pick', 'publish_pick'];

const nameOf = (cards, id) => cards.find(c => c.id === id)?.name || id;
// 同仁選場次：只列接下來要辦的（改資料、發布、要訓練連結都不會是辦完的場次）
const pickNames = (cards) => staffPickList(cards, 8, { includePast: false }).map(c => c.name);

async function sendHome(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '要做什麼呢？點下面的按鈕，或直接用講的 🙂\n例如「智慧醫療那場地點改成南港展覽館」。',
    COLLEAGUE_HOME_CHIPS);
}

async function sendHelp(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '同仁模式能做的事 🔧 常用的都在下方選單。\n\n' +
    '・新增活動：點「新增活動」，打名稱就建好，會給你編輯連結\n' +
    '・修改活動：點「修改活動」選一場，再說要改什麼，例如「地點改成南港展覽館」，我會先跟你確認\n' +
    '・發布：點活動後按「🚀 發布」，或說「發布 智慧醫療那場」（日期、地點、新聞聯絡人、新聞稿要先填齊）\n' +
    '・媒體訓練：點「媒體訓練」選一場，給你發言練習連結\n\n' +
    '想像記者一樣問米亞問題，請打「退出同仁模式」。',
    COLLEAGUE_HOME_CHIPS);
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

// 活動卡：點了活動名稱看到的。重點是兩條網站連結（編輯頁、活動網頁）和「接著說要改什麼」。
async function sendCard(replyToken, userId, eventId) {
  const row = (await getAllEventRows()).find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips('修改活動'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  const when = [c.date ? shortDate(c.date) : '日期未定', c.time, c.venue].filter(Boolean).join('｜');
  const lines = [`《${c.name}》${STATUS_LABEL[c.status] || c.status}`, when, ''];
  lines.push(c.missingRequired.length ? `必填 ${c.doneRequired}／${c.totalRequired}，還缺：${c.missingRequired.join('、')}` : `必填 ${c.doneRequired}／${c.totalRequired} ✅ 都填齊了`);
  lines.push('\n接著直接說要改什麼就好，例如「地點改成南港展覽館」。');
  const links = (await eventLinksText(eventId)).trim();
  if (links) lines.push('\n' + links);
  const canPublish = c.status === 'draft' && !c.missingRequired.length;
  // 接著那一句「地點改成⋯」不用再講是哪一場（一次性，10 分鐘內有效，見 lib/staff.js getStaffPending）
  await setStaffPending(userId, 'edit_event', { eventId });
  await replyOrPush(replyToken, userId, lines.join('\n'),
    staffChips(canPublish ? { label: '🚀 發布', text: `發布：${c.name}` } : null,
      { label: '🎤 媒體訓練', text: `訓練：${c.name}` }, '修改活動'));
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
  console.log(`[line] 同仁新增活動 id=${created.id} name="${created.name}"`);
  await replyOrPush(replyToken, userId,
    `已建立《${created.name}》✅\n日期：${dateWithWeekday(date) || '未定（在編輯頁補上）'}\n狀態：未發布，記者還看不到\n\n` +
    `✏️ 編輯頁（新聞稿、邀請函、照片都在這，不需要密碼）：\n${editLink(created.id, created.editCode)}\n\n` +
    '日期、地點、新聞聯絡人、新聞稿填齊後，回來點「修改活動」選這一場，按「🚀 發布」，記者就問得到了。',
    staffChips({ label: '✏️ 修改這場', text: created.name }));
  await notifyAdminOfChange(userId,
    `➕ 同仁新增了活動\n《${created.name}》\n新增的人：${userName || '（沒有名字）'}\nLINE ID：${userId}`);
}

const FALLBACK_TEXT =
  '這個我在同仁模式幫不上忙 🙏\n\n' +
  '這裡只能：新增活動、修改活動（含發布）、拿媒體訓練連結。\n' +
  '改資料可以直接說，例如「智慧醫療那場地點改成南港展覽館」。\n\n' +
  '想像記者一樣問米亞問題，請打「退出同仁模式」；其他管理功能請找管理員。';

export async function handleColleagueMessage(replyToken, userId, text) {
  markColleague(); // 之後共用的 staffChips() 會自己換成同仁的按鈕
  const s = String(text || '').trim();

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
  const pendingData = await getStaffPendingData(userId);
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
      await replyOrPush(replyToken, userId, FALLBACK_TEXT, COLLEAGUE_HOME_CHIPS);
  }
}
