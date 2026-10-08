// 米亞（LINE）的職員模式：活動卡／填寫進度／催填、在 LINE 改資料與發布、加照片、教米亞、圖文選單。
// 身分驗證與職員資料在 lib/staff.js；這支是 LINE 對話這一端。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。

import { toTraditionalTW } from './zh-tw.js';
import { isPreEventMode } from './prompt.js';
import {
  replyOrPushMessages, startLoading, listRichMenus, linkRichMenuToUser, unlinkRichMenuFromUser, pushMessage
} from './line.js';
import { buildAllCalendarCards } from './router.js';
import {
  detectMetaIntent, detectCourtesy, matchEventByName, REPORTER_MENU, STAFF_MENU, isStaffMoreCommand,
  findEventMentioned
} from './menu.js';
import { listOpenCampaigns } from './registration.js';
import {
  applyRichMenus, syncRegistrationMenu, registrationMenuStatus, pickMenuCampaign, buildRegMenu
} from './richmenu-sync.js';
import {
  routeStaffIntent, createDraftEvent, editLink, trainingLink, ensureEventEditCode, getEventRawById,
  getEventAnalyticsSummary, formatEventAnalyticsReply, getGeoStatusSummary, getGeoTrendSeries,
  isExitStaffCommand, revokeStaff, setStaffPending, isCancelReply, staffPickList, dateWithWeekday, todayTaipei,
  getEventStats, getStaffPendingData, getStaffName
} from './staff.js';
import {
  proposeChange, applyChange, findLastChangeBy, fieldLabel, displayValue, appendEventPhotos
} from './event-edit.js';
import { saveEventPhoto } from './photo-upload.js';
import { addPhoto, pendingPhotos, consumePhotos } from './photo-inbox.js';
import {
  eventChecklist, formatProgressOverview, buildEventCardFlex, formatEventCardText, formatNudgeMessage,
  previewLink
} from './event-status.js';
import { buildGeoBriefFlex, formatGeoBriefText } from './geo-brief.js';
import {
  getMemories, addMemory, setMemoryStatus, parseMemoryCommand, formatMemoryList, ON as MEM_ON,
  PENDING as MEM_PENDING, OFF as MEM_OFF, MEMORY_MAX_ACTIVE
} from './bot-memory.js';
import { getAllEventRows, getBinding, getEventById, invalidateEventsCache, isUsable } from './line-store.js';
import { HOME_MENU, SITE, STAFF_QUICK_REPLIES, quickReplyOf, replyOrPush, staffChips, twFlex } from './line-runtime.js';
import { answerQuestion, handleMetaIntent, handleUnbound } from './line-reporter.js';
import { isBusinessEvent } from './audience.js';

// 職員登入／設定選單時要拿到職員選單的 id。不另外存一份到試算表——選單本來就有
// name 欄位，用它反查即可，少一個會跟 LINE 那邊不同步的狀態。
async function findRichMenuIdByName(name) {
  const menus = await listRichMenus();
  return menus.find(m => m.name === name)?.richMenuId || null;
}

// 把某個 userId 換成職員選單。整段包在 try 裡：選單是體驗加分，綁失敗不能讓
// 「密語登入」這件事本身失敗——他仍然是職員，只是先看到記者選單而已。
export async function applyStaffMenu(userId) {
  try {
    const id = await findRichMenuIdByName(STAFF_MENU.name);
    if (!id) return; // 還沒跑過「設定圖文選單」，正常情況，不用吵
    await linkRichMenuToUser(userId, id);
  } catch (e) {
    console.error('綁定職員選單失敗（不影響職員身分）:', e.message);
  }
}
async function handleSetupRichMenu(replyToken, userId) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    await replyOrPush(replyToken, userId, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法建立圖文選單。', staffChips());
    return;
  }
  await startLoading(userId, 45);

  try {
    // 批次 88：有開放中的活動報名 → 記者選單用「報名版」（多一格報名入口）；報名結束後會自動換回
    // 原本那套（見 autoSyncRegistrationMenu()），也可以再打一次「設定圖文選單」馬上換。
    // 批次 113：報名格的字是同步當下畫上去的（見 lib/richmenu-sync.js）：已經綁著的那一場還開著就沿用，
    // 否則只有一場開放就是那一場、兩場以上就寫通用的「活動報名」。要指定綁哪一場，到後台「活動報名」按「放到 LINE 圖文選單」。
    const open = await listOpenCampaigns();
    let reporterMenu = REPORTER_MENU, linked, warning = '';
    if (open.length) {
      const bound = (await registrationMenuStatus()).campaign_id;
      const r = await syncRegistrationMenu(pickMenuCampaign(open, bound), { allowStaticFallback: true });
      reporterMenu = buildRegMenu(pickMenuCampaign(open, bound));
      linked = r.linked; warning = r.warning;
    } else {
      ({ linked } = await applyRichMenus(REPORTER_MENU));
    }
    const isReg = reporterMenu !== REPORTER_MENU;
    await replyOrPush(replyToken, userId,
      '圖文選單已設定完成 ✅\n\n' +
      `【記者看到的${isReg ? '（報名版）' : ''}】\n${reporterMenu.buttons.map(b => `・${b.label}`).join('\n')}\n\n` +
      `【職員看到的】（已套用到 ${linked} 位職員）\n${STAFF_MENU.buttons.map(b => `・${b.label}`).join('\n')}\n\n` +
      (warning ? `⚠️ ${warning}\n\n` : '') +
      '記者不會看到職員那一套。已經加過好友的人可能要把對話關掉重開才會看到。' +
      (isReg ? '\n\n報名格要綁哪一場，也可以到後台「活動報名」挑。' : ''),
      staffChips());
  } catch (e) {
    console.error('設定圖文選單失敗:', e.message);
    await replyOrPush(replyToken, userId, `設定圖文選單失敗：${e.message}\n\n請確認 LINE_CHANNEL_ACCESS_TOKEN 有效，且網站已部署最新版本。`, staffChips());
  }
}

// 報名結束後圖文選單自動換回、綁的那一場結束時自動改寫：見 lib/richmenu-sync.js autoSyncRegistrationMenu()（批次 88、113）。

// 職員模式指令分派（批次 4）。跟 handleUnbound 的差異：
//   - qa 意圖不套用 isUsable()——同仁本來就該問得到 draft／archived 場次的內容
//   - 不做軟綁定：職員一次對話常常在不同活動之間跳來跳去（查完 A 場數據又問 B 場
//     內容），鎖定單一活動反而綁手綁腳
//   - 多了 geo_status／event_analytics／create_event／training_link 四種指令
// 同仁按下的確認鈕送出的字串。用完整句子而不是「是／否」——這兩顆按鈕會留在對話
// 紀錄裡，隔天滑回去按到「是」卻不記得在確認什麼，比按不到更糟。
const TEACH_YES = '✅ 記起來';
const TEACH_NO = '✖ 不用記';

// 回傳 true 代表這則訊息已經被當成「教學指令」處理完了，呼叫端不要再往下走。
async function handleTeachMessage(replyToken, userId, text) {
  const s = String(text || '').trim();
  const mems = await getMemories();

  // 確認／取消：把最近一筆 pending 收掉。只收「這個人自己」剛剛留下的那一筆——
  // 兩位同仁同時在教的時候，不能互相確認到對方的內容。
  if (s === TEACH_YES || s === TEACH_NO) {
    const mine = mems.filter(m => m.status === MEM_PENDING && m.by === userId);
    const last = mine[mine.length - 1];
    if (!last) {
      await replyOrPush(replyToken, userId, '沒有等著確認的內容喔。', staffChips('記憶清單'));
      return true;
    }
    await setMemoryStatus(last.rowNumber, s === TEACH_YES ? MEM_ON : MEM_OFF);
    await replyOrPush(replyToken, userId,
      s === TEACH_YES ? `好，我記起來了 ✅\n「${last.text}」\n\n以後回答都會照這個來。要查或取消，打「記憶清單」。`
                      : '好，那就當作沒這回事 👌',
      staffChips('記憶清單'));
    return true;
  }

  const cmd = parseMemoryCommand(s);
  if (!cmd) return false;

  // 批次 76：「改成下午兩點開始」「請改一下這場的地點」是在改活動資料，不是在教米亞
  // 說話方式。舊版會把它記成全站語氣規則，套用到每一場（見 lib/bot-memory.js
  // looksLikeFieldChange() 的說明）。這裡不存任何東西，只指路。
  // 批次 78 起不在這裡回覆，交回呼叫端：這句話多半是「改資料」，交給職員路由的
  // update_event 走確認流程；路由也接不住時，呼叫端再送下面那段 FIELD_HINT_TEXT。
  if (cmd.kind === 'field_hint') return 'field_hint';

  if (cmd.kind === 'list') {
    // 清單是空的時候，下一步是「怎麼教」——職員版的「使用說明」裡有【教米亞】那段。
    // 刻意不做「記住：⋯⋯」按鈕：快速回覆是把固定字串直接送出去，送一句沒有內容的
    // 「記住：」只會換來一次聽不懂。
    const empty = !(mems || []).some(m => m.status === MEM_ON);
    await replyOrPush(replyToken, userId, formatMemoryList(mems),
      empty ? staffChips('使用說明') : staffChips());
    return true;
  }

  if (cmd.kind === 'forget') {
    const active = mems.filter(m => m.status === MEM_ON);
    const target = active[cmd.index - 1];
    if (!target) {
      await replyOrPush(replyToken, userId, `沒有第 ${cmd.index} 條喔，先打「記憶清單」看一下編號。`, staffChips('記憶清單'));
      return true;
    }
    await setMemoryStatus(target.rowNumber, MEM_OFF);
    await replyOrPush(replyToken, userId, `已經忘記這條 🗑\n「${target.text}」`, staffChips('記憶清單'));
    return true;
  }

  // cmd.kind === 'save'
  if (mems.filter(m => m.status === MEM_ON).length >= MEMORY_MAX_ACTIVE) {
    await replyOrPush(replyToken, userId,
      `我記的東西已經到上限（${MEMORY_MAX_ACTIVE} 條）了。這些內容每一題都會帶進去，太多會讓我變慢也變貴——請先打「記憶清單」忘記幾條再教我。`,
      staffChips('記憶清單'));
    return true;
  }

  // scope 'event' 代表「記在同仁現在綁定的那一場」。沒綁定就問一下是哪一場，
  // 不要默默記成全站——那是兩件完全不同的事。
  let scope = cmd.scope;
  let scopeName = '';
  if (scope === 'event') {
    const binding = await getBinding(userId);
    let current = binding?.event_id ? await getEventById(binding.event_id) : null;
    // 批次 75（四角色模擬）：同事打「記住：眺望研討會的新聞聯絡人是⋯⋯」，句子裡已經講了
    // 是哪一場，卻還被要求「先切到那一場再講一次」。沒綁定時先看句子點名了哪一場，
    // 只認得出唯一一場才用；認不出、或同時像好幾場，照舊問。
    if (!isUsable(current)) {
      const named = findEventMentioned(cmd.text, buildAllCalendarCards(await getAllEventRows()));
      if (named) current = await getEventById(named.id);
    }
    if (!isUsable(current)) {
      await replyOrPush(replyToken, userId,
        '要記在哪一場呢？請先打活動名稱切到那一場，再跟我說一次。\n\n（如果這件事是所有場次都適用的，改打「全站記住：⋯⋯」）',
        staffChips('最近有哪些活動'));
      return true;
    }
    scope = current.id;
    scopeName = current.name || '';
  }

  await addMemory({
    scope, type: cmd.type, text: cmd.text, by: userId,
    status: cmd.confirm ? MEM_PENDING : MEM_ON
  });

  if (cmd.confirm) {
    // 自然語句：先問一次再生效。理由見 lib/bot-memory.js 開頭的 ⚠️。
    // ⚠️ 這是整個職員模式**唯一**刻意不帶整套入口的一則：這一刻只有「記／不記」兩條路，
    // 旁邊擺一排別的出口只會讓人點走、留下一筆永遠 pending 的內容。不要順手統一掉。
    await replyOrPush(replyToken, userId,
      `這句話要我以後都照做嗎？\n「${cmd.text}」\n\n（會套用到所有場次的每一個回答）`, [TEACH_YES, TEACH_NO]);
  } else {
    const where = cmd.type === 'style' ? '所有回答' : (scope === 'global' ? '所有場次' : (scopeName ? `《${scopeName}》這一場` : '這一場'));
    await replyOrPush(replyToken, userId,
      `記起來了 ✅\n「${cmd.text}」\n\n之後${where}都會照這個來。要查或取消，打「記憶清單」。`,
      staffChips('記憶清單'));
  }
  console.log(`[line] 教學 user=${userId} type=${cmd.type} scope=${scope} confirm=${cmd.confirm} text="${cmd.text.slice(0, 40)}"`);
  return true;
}
// ── 活動卡／填寫進度／催填（批次 77）──────────────────────────────────────
// 按鈕與卡片送出的固定句型。用字面比對、不交給模型：這些字串都是我們自己按鈕送出的，
// 100% 認得出來，還省一次模型呼叫（lib/menu.js 開頭同一個道理）。
const PROGRESS_RE = /^(活動與進度|活動進度|填寫進度|看填寫進度|查填寫進度|填寫狀況|活動填寫狀況|哪幾場還沒填完)[?？。!！]?$/;
const UPDATE_ENTRY_RE = /^(更新活動|修改活動|更新活動資訊|修改活動資訊|改活動資料)[?？。!！]?$/;
const CARD_CMD_RE = /^(催填|數據|活動卡|發布)\s*[:：]\s*(.+)$/;
async function sendProgressOverview(replyToken, userId) {
  const { text, names } = formatProgressOverview(await getAllEventRows(), todayTaipei());
  await replyOrPush(replyToken, userId, text, staffChips(...names));
}

// 活動卡：同仁點了活動名稱、或卡片上的按鈕指回這一場時看到的那張。
async function sendEventCard(replyToken, userId, eventId) {
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名或封存了。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  const [editCode, stats] = await Promise.all([ensureEventEditCode(eventId), getEventStats(eventId)]);
  const links = {
    edit: editCode ? editLink(eventId, editCode) : '',
    training: editCode ? trainingLink(eventId, editCode) : '',
    preview: previewLink(eventId)
  };
  const chips = staffChips({ label: '問米亞這場', text: `${c.name}的重點是什麼` }, '活動與進度');
  const flex = twFlex(buildEventCardFlex(c, stats, links));
  flex.quickReply = quickReplyOf(chips);
  const ok = await replyOrPushMessages(replyToken, userId, [flex]);
  // Flex 送不出去（舊版 LINE、格式被拒）退回純文字，跟 GEO 簡報卡同一套降級
  if (!ok) await replyOrPush(replyToken, userId, formatEventCardText(c, stats, links), chips);
}

// 催填訊息：兩則。第二則單獨成一個泡泡，同仁長按「轉傳」只會轉那一則。
async function sendNudge(replyToken, userId, eventId) {
  const rows = await getAllEventRows();
  const row = rows.find(r => r[0] === eventId);
  const editCode = row ? await ensureEventEditCode(eventId) : null;
  if (!row || !editCode) {
    await replyOrPush(replyToken, userId, '這場活動的編輯連結產生失敗，請稍後再試。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  const nudge = { type: 'text', text: toTraditionalTW(formatNudgeMessage(c, editLink(eventId, editCode))) };
  nudge.quickReply = quickReplyOf(staffChips('活動與進度'));
  const ok = await replyOrPushMessages(replyToken, userId, [
    { type: 'text', text: '下面這則可以直接長按「轉傳」給負責填寫的同仁 👇' },
    nudge
  ]);
  if (!ok) await replyOrPush(replyToken, userId, nudge.text, staffChips('活動與進度'));
}

// 卡片按鈕送出的「催填：活動名稱」要找回是哪一場。只收名稱完全相同（正規化後）的
// 那一場——那是我們自己的按鈕送出來的，對不上就代表活動剛被改名，不猜。
function findCardByExactName(name, cards) {
  const norm = s => String(s || '').replace(/[\s　《》「」]/g, '');
  const hits = cards.filter(c => norm(c.name) === norm(name));
  return hits.length === 1 ? hits[0] : null;
}

// ── 在 LINE 改資料、發布、復原（批次 78）────────────────────────────────────
// 確認鈕用完整句子，不用「是／否」：這兩顆按鈕會留在對話紀錄裡，隔天滑回去按到，
// 也要看得出是在確認什麼（跟 TEACH_YES 同一個理由）。過了 10 分鐘，按了只會得到
// 「沒有等著確認的修改」，不會改到任何東西。
const CONFIRM_UPDATE = '✅ 確認修改';
const CANCEL_UPDATE = '✖ 取消修改';
const CONFIRM_PUBLISH = '🚀 確認發布';
const CANCEL_PUBLISH = '✖ 先不發布';
const UNDO_RE = /^(復原上一個修改|復原|還原上一個修改|取消上一個修改|改回來|改回去)[。!！]?$/;

const FIELD_HINT_TEXT =
  '這句看起來是要改活動資料，我沒有把它記成規則，不然會套用到所有場次 🙏\n\n' +
  '要改的話請說是哪一場，例如「智慧醫療那場改到下午兩點」，我會先跟你確認再改。\n' +
  '只想讓米亞知道、不改資料：打「記住：」加上活動名稱和內容。';

// 有人在 LINE 改了記者看得到的資料 → 通知管理員（批次 76 決定 5：職員不分權限，
// 所以每次修改都要讓管理員知道，密語外流被亂改時才來得及發現）。
async function notifyAdminOfChange(userId, text) {
  const ownerId = process.env.LINE_ADMIN_USER_ID;
  if (!ownerId || ownerId === userId) return;
  try { await pushMessage(ownerId, text); } catch (e) { console.error('通知管理員失敗:', e.message); }
}

async function proposeUpdate(replyToken, userId, eventId, field, value, { raw = false, undo = false } = {}) {
  const r = await proposeChange(eventId, field, value, { raw });
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  const p = r.proposal;
  await setStaffPending(userId, 'update_confirm', p);
  // ⚠️ 跟教米亞的確認句一樣，這一則刻意**只有兩顆按鈕**：這一刻只有改／不改兩條路，
  // 旁邊擺一排別的出口只會讓人點走、留下一筆懸著的修改。
  // 批次 80：改到今天以前的日期多半是打錯（或年份猜錯），確認句先講清楚
  const pastWarn = field === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(p.after) && p.after < todayTaipei()
    ? '\n\n⚠️ 這個日期已經過了，確定沒打錯嗎？' : '';
  await replyOrPush(replyToken, userId,
    `${undo ? '復原上一個修改：\n' : ''}要把《${p.eventName}》的${fieldLabel(field)}\n從「${displayValue(field, p.before)}」\n改成「${displayValue(field, p.after)}」嗎？${pastWarn}\n\n改了以後，記者問米亞、活動網頁都會跟著更新。`,
    [CONFIRM_UPDATE, CANCEL_UPDATE]);
}

async function proposePublish(replyToken, userId, eventId) {
  const row = (await getAllEventRows()).find(r => r[0] === eventId);
  if (!row) {
    await replyOrPush(replyToken, userId, '找不到這場活動，可能剛被改名了。', staffChips('活動與進度'));
    return;
  }
  const c = eventChecklist(row, todayTaipei());
  if (c.status !== 'draft') {
    await replyOrPush(replyToken, userId, `《${c.name}》已經是${displayValue('status', c.status)}，記者本來就問得到。`, staffChips({ label: '看這場的活動卡', text: c.name }));
    return;
  }
  // 朱朱的決定（批次 76 決定 2）：先過檢查清單。必填沒齊就不給發布——記者問得到卻什麼
  // 都答不出來，比晚一點發布更糟。
  if (c.missingRequired.length) {
    await replyOrPush(replyToken, userId,
      `《${c.name}》還不能發布，必填還缺：${c.missingRequired.join('、')}。\n\n補齊之後再按一次「發布」就可以。`,
      staffChips({ label: '產生催填訊息', text: `催填：${c.name}` }, { label: '看這場的活動卡', text: c.name }));
    return;
  }
  const r = await proposeChange(eventId, 'status', 'active');
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  await setStaffPending(userId, 'publish_confirm', r.proposal);
  await replyOrPush(replyToken, userId,
    `要發布《${c.name}》嗎？\n${c.date ? `活動日期：${dateWithWeekday(c.date)}\n` : ''}\n發布後記者在 LINE 和活動網頁都問得到這一場。`,
    [CONFIRM_PUBLISH, CANCEL_PUBLISH]);
}

// ── 傳照片給米亞（批次 79）─────────────────────────────────────────────
// 活動現場拍完，直接在 LINE 傳給米亞，不用回電腦開編輯頁上傳。只有職員可以。
// 一次傳好幾張時，LINE 會一張一張送 webhook：每一張都接進同一個「等著選場次」的清單，
// 選一次就全部加進去。
// 批次 80：照片清單改存 lib/photo-inbox.js（每張一列），理由見那支檔案開頭。
export async function handleStaffImage(replyToken, userId, messageId) {
  const count = await addPhoto(userId, messageId);
  await setStaffPending(userId, 'photo_pick');
  const cards = buildAllCalendarCards(await getAllEventRows());
  await replyOrPush(replyToken, userId,
    `收到 ${count} 張照片 📷 要加到哪一場？點下面的活動。\n（還有照片的話可以繼續傳，選一次就一起加；不加了就回「不用了」）`,
    // 補照片常常是活動隔天的事：辦完兩週內的場次也列
    staffChips(...staffPickList(cards, 8, { includePast: true, pastDays: 14 }).map(c => c.name)));
}

async function addPhotosToEvent(replyToken, userId, eventId, messageIds) {
  await startLoading(userId, 45);
  const urls = [];
  let failed = 0;
  for (const id of messageIds) {
    try { urls.push(await saveEventPhoto(eventId, id)); }
    catch (e) { failed++; console.error(`存照片失敗 msg=${id}:`, e.message); }
  }
  if (!urls.length) {
    await replyOrPush(replyToken, userId,
      '照片沒能存起來 🙏 可能是 LINE 的檔案已經過期，或暫時連不上。請再傳一次，或到編輯頁用「上傳照片檔案」。',
      staffChips('活動與進度'));
    return;
  }
  const userName = await getStaffName(userId);
  const r = await appendEventPhotos(eventId, urls, { userId, userName });
  if (!r.ok) {
    await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
    return;
  }
  invalidateEventsCache();
  const ev = await getEventById(eventId);
  // 活動前（有邀請函）記者拿不到照片，是設計好的（lib/prompt.js resolveEventContent），
  // 先講清楚，不然同仁會以為沒加成功
  const preEvent = ev && isPreEventMode(ev) ? '\n\n（這場還在活動前，記者要到活動當天才拿得到照片）' : '';
  await replyOrPush(replyToken, userId,
    `已把 ${urls.length} 張照片加進《${r.eventName}》✅ 現在共 ${r.total} 張。${failed ? `\n另外 ${failed} 張沒存成功，要的話請再傳一次。` : ''}${preEvent}\n\n要拿掉或加圖說，請到編輯頁的「圖片資源」。`,
    staffChips({ label: '看這場的活動卡', text: r.eventName }, '活動與進度'));
  await notifyAdminOfChange(userId,
    `📷 活動照片被新增\n《${r.eventName}》加了 ${urls.length} 張\n加的人：${userName || '（沒有名字）'}\nLINE ID：${userId}`);
}

// 回傳 true＝這則訊息已經處理完。
async function handleEditFlow(replyToken, userId, text, pendingData, cards) {
  const pending = pendingData?.intent || null;
  const payload = pendingData?.payload || null;
  const s = String(text || '').trim();

  if (s === CONFIRM_UPDATE || s === CONFIRM_PUBLISH) {
    const want = s === CONFIRM_UPDATE ? 'update_confirm' : 'publish_confirm';
    if (pending !== want || !payload) {
      await replyOrPush(replyToken, userId, '沒有等著確認的修改喔（超過 10 分鐘會自動取消）。要改的話再說一次就好。', staffChips('活動與進度'));
      return true;
    }
    const userName = await getStaffName(userId);
    const r = await applyChange(payload, { userId, userName });
    if (!r.ok) {
      await replyOrPush(replyToken, userId, r.reason, staffChips('活動與進度'));
      return true;
    }
    invalidateEventsCache();
    const name = payload.field === 'name' ? payload.after : payload.eventName;
    const change = `${fieldLabel(payload.field)}：「${displayValue(payload.field, payload.before)}」→「${displayValue(payload.field, payload.after)}」`;
    console.log(`[line] 職員修改 user=${userId} event=${payload.eventId} field=${payload.field}`);
    await replyOrPush(replyToken, userId,
      payload.field === 'status' && payload.after === 'active'
        ? `已發布 ✅《${name}》\n記者現在問得到這一場了。`
        : `已更新 ✅《${name}》\n${change}`,
      staffChips({ label: '看這場的活動卡', text: name }, '復原上一個修改'));
    await notifyAdminOfChange(userId,
      `✏️ 活動資料被修改\n《${name}》\n${change}\n改的人：${userName || '（沒有名字）'}\nLINE ID：${userId}\n\n不是你認識的人改的，可以到試算表 event_changes 分頁查紀錄。`);
    return true;
  }
  if (s === CANCEL_UPDATE || s === CANCEL_PUBLISH) {
    await replyOrPush(replyToken, userId, s === CANCEL_PUBLISH ? '好，先不發布 👌' : '好，沒有改 👌', staffChips('活動與進度'));
    return true;
  }

  if (UNDO_RE.test(s)) {
    const last = await findLastChangeBy(userId);
    if (!last) {
      await replyOrPush(replyToken, userId, '你最近沒有在 LINE 上改過活動資料，沒有東西可以復原。', staffChips('活動與進度'));
      return true;
    }
    await proposeUpdate(replyToken, userId, last.eventId, last.field, last.before, { raw: true, undo: true });
    return true;
  }

  // 批次 79：同仁剛傳了照片，這一則是「要加到哪一場」
  if (pending === 'photo_pick') {
    const photos = await pendingPhotos(userId);
    if (photos.length && isCancelReply(s)) {
      await consumePhotos(photos);
      await replyOrPush(replyToken, userId, '好，照片沒有加 👌', staffChips('活動與進度'));
      return true;
    }
    const target = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (photos.length && target) {
      await consumePhotos(photos); // 先標記用掉：就算下面上傳失敗，也不會下次選場次時又被加一次
      await addPhotosToEvent(replyToken, userId, target.id, photos.map(p => p.messageId));
      return true;
    }
  }

  // 上一則問了「要改／發布哪一場」，這一則是場次名稱
  if ((pending === 'update_pick' && payload) || pending === 'publish_pick') {
    if (isCancelReply(s)) {
      await replyOrPush(replyToken, userId, '好，沒有改 👌', staffChips('活動與進度'));
      return true;
    }
    const target = findCardByExactName(s, cards) || matchEventByName(s, cards);
    if (target) {
      if (pending === 'publish_pick') await proposePublish(replyToken, userId, target.id);
      else await proposeUpdate(replyToken, userId, target.id, payload.field, payload.value);
      return true;
    }
  }
  return false;
}

export async function handleStaffMessage(replyToken, userId, text) {
  // ⚠️ 退出一定要在 routeStaffIntent() 之前用字面比對攔下來。交給 AI 判意圖會被歸到
  // 'other'，使用者只會拿到一份能力清單、永遠退不出去（實際回報過的狀況）。
  // 權限的關閉不該取決於模型當下判得準不準。
  if (isExitStaffCommand(text)) {
    await revokeStaff(userId);
    await unlinkRichMenuFromUser(userId); // 解除個人連結 → 自動落回記者選單
    console.log(`[line] 職員退出 user=${userId}`);
    await replyOrPush(replyToken, userId,
      '已退出職員模式 ✅\n\n您現在跟一般記者看到的一樣，下方選單也換回記者版。\n要再進來，重新輸入一次密語即可。',
      HOME_MENU);
    return;
  }

  // 選單最右下那一格（批次 114）。字面比對、不進模型：每次回的都是同一則固定文字。
  if (isStaffMoreCommand(text)) {
    await sendStaffMore(replyToken, userId);
    return;
  }

  // ── 用對話教米亞（批次 46）────────────────────────────────────────────
  // ⚠️ 一定要排在 routeStaffIntent() 之前，而且用字面比對——跟 isExitStaffCommand()
  // 同一個理由：「這句話會不會被寫進知識庫、讓每個記者都讀到」，不該取決於模型當下
  // 判得準不準。
  const teach = await handleTeachMessage(replyToken, userId, text);
  if (teach === true) return;
  const fieldHint = teach === 'field_hint';

  // ── 職員 ＝ 記者 ＋ 管理，不是「另一個世界」（回報：「職員模式要重新思考改進，
  // 不好用」）────────────────────────────────────────────────────────────
  // 回報的截圖：在職員模式問「最近有發什麼新聞稿」，拿回來的是一份職員功能清單。
  //
  // 根因是結構性的：職員模式**取代**了記者模式，而不是疊在它上面。走到這支之後，
  // 每一則訊息都只過 routeStaffIntent() 那七個管理意圖，記者端有的東西——最新
  // 新聞稿、產業趨勢、工研院技術、邀訪窗口——一個都叫不到，全部落進 'other'，
  // 換來一面功能清單的牆。公關同仁本來就是這個帳號用得最兇的人，卻是能力最少的人。
  //
  // 修法：記者端有、管理端沒有的那幾種意圖，直接共用記者端整套處理。用
  // detectMetaIntent() 的字面比對先攔，不進 routeStaffIntent()——順便省一次模型呼叫。
  //
  // ⚠️ 'calendar' 刻意**不**在這裡短路。職員的「所有場次的後台數據」也會命中
  // CALENDAR_RE（「所有…場次」），短路掉就再也查不到後台數據了——那條要留給
  // routeStaffIntent() 用語意判。六顆職員按鈕會不會被這裡誤攔，測試有釘住。
  const metaIntent = detectMetaIntent(text);
  if (metaIntent === 'news' || metaIntent === 'industry_trend'
      || metaIntent === 'tech_query' || metaIntent === 'contacts' || metaIntent === 'org_intro'
      || metaIntent === 'register') {
    console.log(`[line] staff 借用記者端意圖 intent=${metaIntent} q="${text.slice(0, 40)}"`);
    await handleMetaIntent(replyToken, userId, text, metaIntent, null, { staff: true });
    return;
  }
  if (metaIntent === 'help' || metaIntent === 'switch' || metaIntent === 'menu') {
    // 職員的「使用說明／回首頁」＝職員功能表，不是記者那份說明影片。
    // 「選單」（批次 84）也一樣：職員要叫回的是職員那組按鈕。
    await sendStaffMenu(replyToken, userId);
    return;
  }

  const rows = await getAllEventRows();
  // 職員要用「全部場次」的候選清單，不能用記者版的 buildCalendarCards()——
  // 那支會濾掉 draft／archived，職員問得到的場次卻不在候選清單裡，路由回傳的
  // event_id 會被 routeStaffIntent() 自己的白名單過濾掉，變成「查得到內容、卻永遠
  // 比對不到活動」。見 lib/router.js 的註解。
  const cards = buildAllCalendarCards(rows);
  const cardName = id => cards.find(c => c.id === id)?.name || id;
  // 批次 76：沒指定候選時用 staffPickList()（接下來要辦的在前、封存的不列）。舊版拿
  // 試算表前 8 列＝最舊的 8 場。後面一律接上整套職員入口（批次 54 的規則）。
  // 批次 80：預設只列還沒過期的——改資料、發布、要訓練連結都用不到辦完的場次。
  // 查成效（活動後才看）另外傳 { includePast: true }。
  const eventQuickReplies = (ids, pickOpts = { includePast: false }) =>
    staffChips(...(ids && ids.length ? ids.map(cardName) : staffPickList(cards, 8, pickOpts).map(c => c.name)));

  // ⚠️ 承接上一則的追問。實際回報的 bug：打「查活動後台數據」→ 系統問「哪一場？」→
  // 打「四足」→ 卻跑去回答四足那場的活動內容。
  //
  // 職員模式原本每一則訊息都各自重新路由一次，完全沒有記憶。「四足」單獨看就是一個
  // 活動名稱，模型判成 qa 完全合理——問題不在模型判錯，而在沒有人告訴它「上一句我問
  // 的是哪一場的後台數據」。所以這裡先把 pending 讀回來（讀取免費，isStaffAuthenticated
  // 本來就要讀同一批列），再用它覆寫這次的意圖。
  // 批次 78：追問可能帶著資料（等確認的那筆修改），要在清掉之前讀出來
  const pendingData = await getStaffPendingData(userId);
  const pending = pendingData?.intent || null;
  if (pending) await setStaffPending(userId, ''); // 一次性，用掉就清

  // ── 批次 78：修改／發布的確認、復原、選場次 ────────────────────────────────
  if (await handleEditFlow(replyToken, userId, text, pendingData, cards)) return;

  // ── 批次 77：選單與活動卡按鈕送出的固定句型，字面比對直接處理 ─────────────
  if (PROGRESS_RE.test(text)) {
    await sendProgressOverview(replyToken, userId);
    return;
  }
  if (UPDATE_ENTRY_RE.test(text)) {
    await replyOrPush(replyToken, userId,
      '名稱、日期、時間、地點、新聞聯絡人可以直接跟我說，例如「智慧醫療那場地點改成南港展覽館」，我會先跟你確認再改。\n\n' +
      '新聞稿、邀請函、照片：點下面的活動，在活動卡上按「✏️ 開啟編輯頁」；要請別人填，按「📨 催填訊息」。',
      eventQuickReplies());
    return;
  }
  const cardCmd = text.match(CARD_CMD_RE);
  if (cardCmd) {
    const target = findCardByExactName(cardCmd[2], cards);
    if (!target) {
      await replyOrPush(replyToken, userId, `找不到《${cardCmd[2].slice(0, 40)}》這場，可能剛被改名了。從清單再點一次：`, eventQuickReplies());
      return;
    }
    if (cardCmd[1] === '催填') return sendNudge(replyToken, userId, target.id);
    if (cardCmd[1] === '發布') return proposePublish(replyToken, userId, target.id);
    if (cardCmd[1] === '數據') {
      const summary = await getEventAnalyticsSummary(target.id, target.name, { business: isBusinessEvent(target) });
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary), staffChips('活動與進度'));
      return;
    }
    return sendEventCard(replyToken, userId, target.id);
  }
  // 點了清單上的活動名稱（整句就是某一場的名稱）→ 活動卡。帶著問題的（「某某那場的
  // 重點」）不會命中 matchEventByName()，照舊交給下面的路由讓米亞回答。
  // ⚠️ 等「哪一場」答案的時候（pending 查數據／要訓練連結）不攔：那時候點名稱是在回答問題。
  if (!['event_analytics', 'training_link', 'create_event', 'update_pick', 'publish_pick', 'photo_pick'].includes(pending)) {
    // 批次 80：先比「名稱完全相同」。matchEventByName() 要求至少 6 個字，「眺望研討會」
    // 這種短名稱點了清單按鈕會對不上，被當成主題詞問「要查產業趨勢還是技術」。
    const tapped = findCardByExactName(text, cards) || matchEventByName(text, cards);
    if (tapped) {
      await sendEventCard(replyToken, userId, tapped.id);
      return;
    }
  }

  const routed = await routeStaffIntent(text, cards);

  // 批次 76：米亞剛問「新活動叫什麼名字」，同仁回的是「算了／不用了／取消」。舊版把這句
  // 當成名稱，建出一場叫「算了」的草稿。取消用字面比對攔下（不交給模型判）。
  if (pending === 'create_event' && (isCancelReply(text) || detectCourtesy(text))) {
    console.log(`[line] staff 取消新增活動 q="${text.slice(0, 40)}"`);
    await replyOrPush(replyToken, userId, '好，先不建立 👌 要建的時候再按「新增活動」就可以。', staffChips());
    return;
  }

  if (pending) {
    // 批次 75（四角色模擬）：舊版不管這一則是什麼都當成新活動名稱。同事被問「新活動叫
    // 什麼」之後改口要「智慧醫療那場的媒體訓練連結」，結果建出一場叫這個名字的活動。
    // 模型已經明確判成別的管理指令（查數據、要連結、看 GEO、查清單）時，就照那個指令做。
    const CLEAR_STAFF_INTENTS = ['calendar', 'event_analytics', 'training_link', 'geo_status', 'setup_richmenu'];
    if (pending === 'create_event' && routed.intent !== 'create_event' && !CLEAR_STAFF_INTENTS.includes(routed.intent)) {
      // 上一則問的是「新活動叫什麼名字」，這一則整句就是答案。不能交給模型重判——
      // 「半導體技術發表會」這種輸入看起來就像在問某場活動的內容。
      routed.intent = 'create_event';
      routed.new_event_name = text;
    } else if ((pending === 'event_analytics' || pending === 'training_link') && routed.event_ids.length > 0) {
      // 上一則問的是「哪一場」，這一則模型已經比對出場次了，只要把意圖換回來
      routed.intent = pending;
    }
    console.log(`[line] staff 承接追問 pending=${pending} → intent=${routed.intent}`);
  }

  console.log(`[line] staff route user=${userId} q="${text.slice(0, 60)}" → ${JSON.stringify(routed)}`);

  // 追問時附上活動名稱按鈕：點按鈕送出的是完整活動名稱，模型比對得到、pending 也
  // 還在，兩條路都通。只列有意義的前幾場，LINE 上限 13 顆。

  // 批次 77：職員的「活動列表」就是「活動與進度」——同一份清單，每場多寫一行還缺什麼。
  // 同仁看清單本來就是為了知道「接下來要處理哪一場」。
  if (routed.intent === 'calendar' || routed.intent === 'progress') {
    await sendProgressOverview(replyToken, userId);
    return;
  }

  if (routed.intent === 'geo_status') {
    // 一則 Flex 訊息把「今日掃描進度」「近 14 天總覽」「監視中的議題」「追蹤中的
    // 活動」全部帶齊，不再分兩次送（舊版文字+另外 push 一張圖）。長條圖用 LINE
    // 原生 Flex box 畫（見 lib/geo-brief.js 開頭的說明），不靠外部服務組圖表網址，
    // 沒有網址長度上限這個天花板——這正是舊版圖片常態性顯示壞掉圖示的根因。
    const [statusData, seriesData] = await Promise.all([getGeoStatusSummary(), getGeoTrendSeries()]);
    const flex = buildGeoBriefFlex(statusData, seriesData, SITE);
    const ok = flex ? await replyOrPushMessages(replyToken, userId, [flex]) : false;
    if (!ok) {
      // Flex 送失敗（舊版 LINE App、格式被拒、或兩邊資料都查不到）不能讓同仁收到
      // 一片空白，退回純文字版——跟 lib/menu.js buildWelcomeFlex 同一套降級模式。
      await replyOrPush(replyToken, userId, formatGeoBriefText(statusData, seriesData, SITE));
    }
    return;
  }

  // 批次 78：在 LINE 直接改資料。模型只負責聽懂「哪一場、哪一欄、改成什麼」；能不能改、
  // 格式對不對、改前是什麼，全部由 lib/event-edit.js 決定，而且一定先給人按確認。
  if (routed.intent === 'update_event') {
    if (!routed.update_field || !routed.update_value) {
      await replyOrPush(replyToken, userId,
        '要改哪一場的什麼？直接說就好，例如：\n・智慧醫療那場地點改成南港展覽館\n・眺望研討會改到 10/30\n・奈米那場的新聞聯絡人換成王小明 0912-345-678\n\n在 LINE 可以改：名稱、日期、時間、地點、新聞聯絡人。新聞稿、邀請函、照片請按活動卡上的「開啟編輯頁」。',
        eventQuickReplies());
      return;
    }
    if (routed.event_ids.length === 1) {
      await proposeUpdate(replyToken, userId, routed.event_ids[0], routed.update_field, routed.update_value);
      return;
    }
    await setStaffPending(userId, 'update_pick', { field: routed.update_field, value: routed.update_value });
    await replyOrPush(replyToken, userId,
      `要改哪一場的${fieldLabel(routed.update_field)}（改成「${routed.update_value}」）？點下面的活動，或打活動名稱。`,
      eventQuickReplies(routed.event_ids));
    return;
  }

  if (routed.intent === 'publish') {
    if (routed.event_ids.length === 1) {
      await proposePublish(replyToken, userId, routed.event_ids[0]);
      return;
    }
    await setStaffPending(userId, 'publish_pick');
    await replyOrPush(replyToken, userId, '要發布哪一場？點下面的活動，或打活動名稱。', eventQuickReplies(routed.event_ids));
    return;
  }

  if (routed.intent === 'setup_richmenu') {
    await handleSetupRichMenu(replyToken, userId);
    return;
  }

  if (routed.intent === 'create_event') {
    if (!routed.new_event_name) {
      // 記下「我正在等新活動名稱」，下一則整句就會被當成名稱（見上面承接追問那段）
      await setStaffPending(userId, 'create_event');
      await replyOrPush(replyToken, userId,
        '請告訴我新活動的名稱，直接打名稱就好，例如：\n半導體先進封裝技術發表會\n\n（可以順便帶日期，例如「眺望研討會 10/28」；不建了就回「算了」）',
        staffChips());
      return;
    }
    const created = await createDraftEvent(routed.new_event_name, routed.new_event_date);
    invalidateEventsCache();
    console.log(`[line] 職員新增活動 id=${created.id} name="${created.name}"`);
    const dateLine = dateWithWeekday(routed.new_event_date);
    // 批次 76：舊版寫「要到後台按『發布』」——後台要密碼，而同仁編輯頁本來就能發布。
    await replyOrPush(replyToken, userId,
      `已建立《${created.name}》✅\n日期：${dateLine || '未定（在編輯頁補上）'}\n狀態：未發布，記者還看不到\n\n` +
      `同仁編輯連結（轉給負責的同仁，不需要後台密碼）：\n${editLink(created.id, created.editCode)}\n\n` +
      '內容填好後，在編輯頁把「活動狀態」改成「進行中」，記者就問得到了。',
      staffChips({ label: '看這場的活動卡', text: created.name }, '活動與進度'));
    return;
  }

  if (routed.intent === 'event_analytics' || routed.intent === 'training_link') {
    const what = routed.intent === 'event_analytics' ? '後台數據' : '媒體訓練連結';
    if (routed.event_ids.length === 0) {
      // 記下「我正在等他回答哪一場」，否則他打「四足」會被重新判成問活動內容
      await setStaffPending(userId, routed.intent);
      await replyOrPush(replyToken, userId,
        `請問是想查哪一場的${what}？直接打活動名稱，或點下面的按鈕。`,
        eventQuickReplies(null, { includePast: routed.intent === 'event_analytics' }));
      return;
    }
    if (routed.event_ids.length > 1) {
      await setStaffPending(userId, routed.intent);
      await replyOrPush(replyToken, userId,
        `是想查這幾場的哪一場的${what}？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`,
        eventQuickReplies(routed.event_ids));
      return;
    }
    const eventId = routed.event_ids[0];
    if (routed.intent === 'event_analytics') {
      const summary = await getEventAnalyticsSummary(eventId, cardName(eventId), { business: isBusinessEvent(cards.find(c => c.id === eventId)) });
      await replyOrPush(replyToken, userId, formatEventAnalyticsReply(summary), staffChips());
    } else {
      // 舊活動可能還沒有編輯碼，當場補一個（冪等），不要把同仁踢回後台自己弄一次
      const editCode = await ensureEventEditCode(eventId);
      if (!editCode) {
        await replyOrPush(replyToken, userId, '這場活動的編輯碼產生失敗，請稍後再試，或到後台開啟一次該活動的編輯連結。', staffChips());
        return;
      }
      await replyOrPush(replyToken, userId,
        `《${cardName(eventId)}》\n\n媒體訓練（發言練習）：\n${trainingLink(eventId, editCode)}\n\n同仁編輯連結（改內容用，不需後台密碼）：\n${editLink(eventId, editCode)}`,
        staffChips());
    }
    return;
  }

  if (routed.intent === 'qa' && routed.event_ids.length === 1 && routed.confidence === 'high') {
    const event = await getEventRawById(routed.event_ids[0]);
    if (event) {
      // 職員模式刻意不呼叫 isUsable()：draft／archived 場次的內容同仁都問得到。
      // allowPreEventSubstitution:false——同仁自己要看真正的新聞稿內容準備活動，
      // 不能被「活動前只給邀請函」這條規則反過來卡住自己人。
      await answerQuestion(replyToken, userId, event, '（內部職員）', text, { allowPreEventSubstitution: false });
      return;
    }
  }
  if (routed.intent === 'qa' && routed.event_ids.length > 1) {
    await replyOrPush(replyToken, userId,
      `是想問這幾場的哪一場？\n${routed.event_ids.map(id => '・' + cardName(id)).join('\n')}`,
      staffChips(...routed.event_ids.map(cardName)));
    return;
  }

  // 走到這裡代表 routeStaffIntent() 判成 'other'。但 'other' 在職員這邊涵蓋得太寬：
  // 那份 prompt 裡根本沒有新聞稿、產業趨勢、技術報導、邀訪窗口這幾種意圖，同仁只要
  // 問了其中任何一種、講法又剛好沒被上面的字面比對接住，就會掉到這裡。原本這裡直接
  // 丟一面功能清單的牆——那就是回報截圖裡的那一則。
  //
  // 改成交給記者端那條自然語言路由：它認得產業趨勢、工研院技術、活動問答，而且它的
  // 兜底（sendFallbackGuide）會針對同仁這一句講一段貼題的話，不是列清單。
  //
  // ⚠️ 這條路會多花一次模型呼叫（職員路由一次、記者路由一次）。可以接受：走到這裡
  // 的本來就是「兩邊都沒對上」的少數訊息，而同仁的訊息量遠小於記者。
  // askMediaName／remember 都關掉：同仁不是記者，不要問他貴媒體的名稱，內部對話也
  // 不該混進記者的對話記憶。staff:true 讓兜底那則帶職員的按鈕，不是記者的。
  // 批次 76／78：「改成下午兩點開始」這種句子，模型也沒聽出是哪一欄、哪一場。不能交給
  // 兜底——那條路可能把它當閒聊回。明確告訴同仁怎麼講才改得動。
  if (fieldHint) {
    await replyOrPush(replyToken, userId, FIELD_HINT_TEXT, eventQuickReplies());
    return;
  }
  await handleUnbound(replyToken, userId, text, { askMediaName: false, remember: false, staff: true });
}

// 職員功能表。同仁打「使用說明」「回首頁」，或按下方選單時看到的就是這一則。
//
// ⚠️ 這則**不再**當「聽不懂」的兜底用（見 handleStaffMessage 結尾）。一份清單當答案
// 是很糟的體驗：同仁問的是一個具體問題，拿回來的是「這裡有八個功能」。
//
// 分成兩段，因為回報的「不好用」有一半是**看不出自己能做什麼**：原本這份清單只列了
// 管理功能，同仁不知道可以用對話教米亞（批次 46 做好了，但除了 LINE-PLAN.md 之外
// 沒有任何地方寫著怎麼叫它——跟批次 51「最新新聞清單沒有入口」是同一個形狀）。
//
// ⚠️ 批次 52 曾經在這裡加過第三段【記者問得到的，您一樣問得到】，批次 55 拿掉了。
// 原話：「職員模式應該重點是調整、設定？要問趨勢什麼的去跟記者一樣地方就好，
// 不用進入職員模式吧。」——這份清單要回答的是「**在這個模式裡**我能做什麼」，
// 列一串「其實你不用進來也做得到」的東西只是把它撐長。
//
// ⚠️⚠️ 但那是**文案**的取捨，不是能力的取捨。職員問趨勢／技術／新聞／邀訪窗口
// 照樣答得出來（批次 52 修的是 handleStaffMessage() 的路由，不是這段文字）——
// 那條路被拿掉的話，回報過的「問新聞稿拿到一面功能清單的牆」就會整個回來。
// 測試釘住了這一條。
// 【教米亞】那一段：功能表與「更多功能」兩處都要寫，抄兩份遲早有一份跟不上。
const STAFF_TEACH_TEXT =
  '【教米亞】\n' +
  '・「記住：這場的技術還在實驗階段，不要說已經量產」——只記這一場\n' +
  '・「語氣：回答再短一點」——全站通用\n' +
  '・打「記憶清單」看目前記得什麼';

// 選單「更多功能」那一格（批次 114）。只回格子底下寫的那三件事——訓練、教米亞、退出——
// 不是整份功能表；要看完整的打「使用說明」。按鈕列照規矩帶整套入口（staffChips），
// 只是把這一則最相關的三顆排在前面。
async function sendStaffMore(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '更多功能 🧰\n\n' +
    '【媒體訓練】\n' +
    '・「要媒體訓練連結」——發言練習（每張活動卡上也有）\n\n' +
    STAFF_TEACH_TEXT + '\n\n' +
    '【其他】\n' +
    '・「設定圖文選單」——重設下方選單\n' +
    '・「退出職員模式」——回到記者身分\n\n' +
    '完整的功能說明打「使用說明」。',
    staffChips('要媒體訓練連結', '記憶清單', '退出職員模式', '使用說明'));
}

async function sendStaffMenu(replyToken, userId) {
  await replyOrPush(replyToken, userId,
    '職員模式 🔧 下面按鈕直接點，或用講的都可以。\n\n' +
    '【管理】\n' +
    STAFF_MENU.buttons.map(b => `・${b.label}——${b.sub}`).join('\n') +
    '\n・要媒體訓練連結——發言練習（每張活動卡上也有）' +
    '\n・設定圖文選單——重設下方選單\n' +
    '・點活動名稱——看那一場的活動卡：填寫進度、編輯頁、催填訊息、媒體訓練\n' +
    '・帶著問題問（「某某那場的重點是什麼」）——米亞照那場的內容回答（含未發布）\n\n' +
    '【直接改資料】\n' +
    '・「智慧醫療那場地點改成南港展覽館」——名稱、日期、時間、地點、新聞聯絡人都可以，會先跟你確認\n' +
    '・「發布 某某那場」——必填都齊了才能發布\n' +
    '・打「復原上一個修改」改回去\n' +
    '・直接傳照片——選一場，照片就加進那一場的活動照片\n\n' +
    STAFF_TEACH_TEXT + '\n\n' +
    '【離開】打「退出職員模式」回到記者身分。',
    STAFF_QUICK_REPLIES);
}
