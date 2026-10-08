// 米亞（LINE）的記者端：活動問答（answerQuestion）、邀訪窗口、產業趨勢、工研院技術、最新新聞、
// 找真人、「跳出本場」意圖（handleMetaIntent）、近期活動、沒綁定時的路由（handleUnbound）、兜底。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。
// 職員模式與群組會借用這裡的流程（lib/line-staff-mode.js、lib/line-group.js），反過來不會——
// 這支不 import 那兩支，免得繞成循環。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { systemPromptFor, resolveEventContent, formatEventBasics } from './prompt.js';
import { isBusinessEvent, guardBusinessAnswer } from './audience.js';
import { replyOrPushMessages, replyTextWithImages, pushMessage } from './line.js';
import {
  buildCalendarCards, routeIntent, formatCalendarReply, calendarQuickReplyItems, matchShownEvents
} from './router.js';
import { detectCourtesy, isOrgWideNewsAsk, HELP_TEXT, ORG_INTRO_TEXT } from './menu.js';
import { lineBindUrl } from './line-link.js';
import { getMemories, formatFactBlock } from './bot-memory.js';
import {
  CONTACTS_DIR_RANGE, GLOBAL_CONTACT_TOPICS, ensureContactsDirectorySheet, parseContactsDirectory,
  formatGlobalContact, matchGlobalContactByText, isInternalContact
} from './contacts-directory.js';
import {
  fetchIndustryTrendDigest, formatDigestForPrompt, extractSourceIndices, resolveSourceUrls
} from './industry-trends.js';
import { fetchItriNews, formatNewsForPrompt, stripTechQueryFiller } from './itri-news.js';
import { selectRelatedEvents, formatRelatedEventsBlock } from './related-events.js';
import { TONE_RULE, lineExtraRules, sanitize } from './line-format.js';
import {
  CHITCHAT_FIXED_REPLIES, COURTESY_REPLIES, COURTESY_REPLIES_GROUP, detectChitchat, looksLikeBareTopic,
  looksLikePhotoRequest
} from './line-chitchat.js';
import {
  CACHE_TTL_MS, buildGroupTurnHistory, buildTurnHistory, clearBinding, getAllEventRows, getEventById,
  getStoredMediaName, getStoredNote, isUsable, recentTopicContext, rowToEvent, setBindingNote, setContactPending,
  setGroupTurn, setRecentTopic, setRecentTurn, upsertBinding
} from './line-store.js';
import {
  BTN, CONTACT_MENU_LABEL, CONTACT_MENU_TEXT_HINT, HOME_MENU, REPLY_RESERVE_MS, SITE, STAFF_QUICK_REPLIES,
  TECH_EXAMPLE_BUTTONS, askAnthropic, askMediaNameLater, budgetFor, buildHelpQuickReply,
  calendarQuickRepliesForReporter, eventQuickChips, isGroupTarget, msLeft, replyOrPush, takeQuoteToken
} from './line-runtime.js';
import {
  LOOKUP_BUDGET_MS, LOOKUP_MIN_MS, NO_DATA_PHRASE_RE, extractNoDataKeyword, guessNoDataKeyword, hasChinese,
  isGenericLookupKeyword, itriNewsHintBlock
} from './line-nodata.js';
import { handleRegisterIntent } from './line-register.js';

// ── 邀訪聯絡窗口分工（events!P，同仁在後台設定）───────────────────────
// 回報的意見：不同議題該找誰，記者常常猜不到，只能一律洽詢單一的「新聞聯絡人」。
// 同仁在後台可以設定多組「關鍵字｜姓名｜電話｜LINE ID」，記者點對應關鍵字就能拿到
// 精準的窗口，而不是每次都轉一手。
//
// 每行一組，用跟 images／chips 同一套「半形｜全形都收」的分隔規則：
//   關鍵字｜姓名｜電話｜LINE ID(選填)
export function parseEventContacts(event) {
  return String(event?.contacts || '')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const [keyword, name, phone, lineId] = line.split(/[|｜]/).map(s => (s || '').trim());
      return { keyword, name, phone, lineId };
    })
    .filter(c => c.keyword && c.name); // 缺關鍵字或姓名的行直接略過，不要讓半填的資料跑出去
}

// 訊息文字精準命中某個窗口的關鍵字才回覆聯絡資訊——只認完全比對（去空白、忽略大小寫），
// 不做模糊比對：這類回覆是「精準的聯絡方式」，寧可命中不了、讓記者換句話問一次，也不要
// 把「技術規格」跟「技術突破」這種相近但不同的關鍵字搞混、給錯聯絡人。
function matchContact(text, contactsField) {
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const t = norm(text);
  if (!t) return null;
  return parseEventContacts({ contacts: contactsField }).find(c => norm(c.keyword) === t) || null;
}

function formatContactReply(contact) {
  const lines = [`【${contact.keyword}】邀訪聯絡窗口`, contact.name];
  if (contact.phone) lines.push(`📞 ${contact.phone}`);
  if (contact.lineId) lines.push(`LINE：${contact.lineId}`);
  return lines.join('\n');
}

// ── 全域技術窗口分工（跨活動，同仁在後台維護，不綁定特定場次）───────────
// 資料格式、預設種子、比對邏輯都在 lib/contacts-directory.js——api/events.js 的
// 後台編輯 API 也要讀寫同一份資料，兩邊共用一份定義才不會格式或種子內容兜不起來。
const CONTACT_TOPIC_RE = /^邀訪[:：](.+)$/; // 主題按鈕送出的固定格式，見 sendGlobalContactMenu()
export const CONTACT_PENDING_NOTE = 'await_contact_topic'; // 按了「其他」，等記者自己打主題的一次性旗標
// 按了「想問什麼技術」，等記者自己打技術名稱的一次性旗標——跟 CONTACT_PENDING_NOTE
// 同一欄（line_users F 欄）、同一支 setContactPending() 讀寫，只是存的字串不同。
// 沒有另外寫一支 setTechQueryPending()：setContactPending() 內部本來就是「不管值是
// 什麼，寫進 F 欄」的通用寫法，名字雖然掛著 contact，邏輯跟這裡要的完全一樣，見
// handleTechQueryMessage() 的說明。
export const TECH_QUERY_PENDING_NOTE = 'await_tech_query';

// ── 一次性旗標的「這是誰按的」後綴（批次 28）─────────────────────────────
// 回報的意見：群組裡「答非所問、亂回」。其中最尖銳的一種是這兩個一次性旗標——
// 它們存在 line_users 的 F 欄，而群組是用 groupId 當 key，也就是整個群組共用一格：
// A 按了「想問什麼技術」之後，群組裡「任何人」講的「任何一句話」都會被當成技術
// 名稱直接送去查工研院官網，那個人根本沒在跟機器人講話，卻收到一段莫名其妙的
// 技術報導摘要。「邀訪：其他」的自由輸入視窗有一模一樣的問題。
//
// 修法是把「是誰按的」一起寫進旗標（`await_tech_query#U123...`），只有同一個人的
// 下一則才算數。別人插話不會被吃掉，按按鈕的人自己回來打字仍然接得住。
//
// 1 對 1 刻意不加後綴：targetId 本來就是發話者本人，多存一份只是雜訊，而且舊資料
// （沒有後綴的旗標）在 1 對 1 要照舊生效，不能因為這次改動就失效。
// ⚠️ 分隔符用 '#'——LINE 的 userId 是 `U` 開頭的 32 位十六進位字串，不會含 '#'，
// 旗標本身的值（await_xxx）也不會，切一刀就能還原，不需要 JSON。
const PENDING_SPEAKER_SEP = '#';

// speakerId 沒帶（1 對 1）或跟 targetId 相同時不加後綴，維持舊格式。
function pendingNoteFor(note, targetId, speakerId) {
  if (!note || !speakerId || speakerId === targetId) return note;
  return `${note}${PENDING_SPEAKER_SEP}${speakerId}`;
}

// 回傳 { note, speakerId }；沒有後綴時 speakerId 是空字串（＝「誰都算數」，舊行為）。
export function parsePendingNote(raw) {
  const s = String(raw || '');
  const i = s.indexOf(PENDING_SPEAKER_SEP);
  return i === -1 ? { note: s, speakerId: '' } : { note: s.slice(0, i), speakerId: s.slice(i + 1) };
}

// 這則訊息的發話者，有沒有資格用掉這個等待中的旗標。
// 旗標沒記發話者（1 對 1、或舊資料）→ 誰都算數；記了就只認同一個人。
// ⚠️ speakerId 讀不到時（LINE 群組事件在使用者沒同意提供 userId 時可能缺這個欄位）
// 一律當作「不是同一個人」→ 旗標不生效，退回一般路由。安全方向是「不要亂接」，
// 不是「寧可錯接也要接住」——這正是這次要修的問題本身。
export function pendingBelongsTo(rawNote, speakerId) {
  const { speakerId: owner } = parsePendingNote(rawNote);
  return !owner || owner === speakerId;
}

let contactsDirCache = { list: null, expiry: 0 };
async function getContactsDirectory() {
  if (contactsDirCache.list && Date.now() < contactsDirCache.expiry) return contactsDirCache.list;
  await ensureContactsDirectorySheet(ensureSheets, updateRange);
  let raw = '';
  try {
    const rows = await readRange(CONTACTS_DIR_RANGE);
    raw = rows[0]?.[0] || '';
  } catch { raw = ''; }
  const list = parseContactsDirectory(raw);
  contactsDirCache = { list, expiry: Date.now() + CACHE_TTL_MS };
  return list;
}

// 產業趨勢清單（lib/industry-trends.js）快取——跟 contactsDirCache 同一個模式，
// 差別只在 TTL 拉長到 6 小時：這不是 Google Sheets 配額考量（IEKnet 是外部網站，
// 沒有配額問題），是「沒必要每次提問都重抓一次外部網站」——IEK 免費焦點實測更新
// 頻率約每週幾篇，6 小時內反覆問同一個話題不需要每次都真的打一次 fetch。
let industryTrendCache = { items: null, expiry: 0 };
const INDUSTRY_TREND_CACHE_MS = 6 * 60 * 60 * 1000;
async function getIndustryTrendDigest() {
  if (industryTrendCache.items && Date.now() < industryTrendCache.expiry) return industryTrendCache.items;
  const items = await fetchIndustryTrendDigest();
  // 抓失敗／解析出 0 筆時 fetchIndustryTrendDigest() 回空陣列——刻意不快取這個
  // 空結果（TTL 設 0），下一次請求會立刻再試一次，不會被 6 小時的快取卡住連續
  // 失敗；抓成功才真的快取 6 小時。
  industryTrendCache = { items, expiry: items.length ? Date.now() + INDUSTRY_TREND_CACHE_MS : 0 };
  return items;
}

// metaIntent==='contacts' 且沒有活動專屬窗口可用時的入口（見 handleMetaIntent()）。
// 主題按鈕文字刻意用「邀訪：主題」而不是主題本身：LINE quick reply 現在支援
// {label,text} 分開（見 lib/line.js buildQuickReply()），按鈕上看到的字很短
// （例如「生醫」），但送出的文字帶固定前綴，才不會跟記者自己打的真正問題撞在一起
// （萬一剛好在問某場跟「生醫」有關的活動內容，不會被誤判成在找邀訪窗口）。
async function sendGlobalContactMenu(replyToken, userId, { view = 'top' } = {}) {
  // 批次 97：兩層選單（朱朱 9/30：比較清晰）。
  //   第一層：某一場活動窗口／各技術單位窗口／其他／找真人
  //   第二層（各技術單位窗口）：一頁列出全部單位（不分頁、不放找真人）
  // 標籤顯示名單裡的單位（生醫所、資通所…），送出的字仍是固定的「邀訪：主題」（批次 94）。
  if (view === 'top') {
    await replyOrPush(replyToken, userId,
      '請問想找哪一種邀訪窗口？\n・某一場活動的窗口\n・各技術單位的窗口\n・其他（輸入想了解的主題，我幫您媒合）\n・或直接找真人',
      [
        { label: '📅 某一場活動窗口', text: '最近有哪些活動' }, // 批次 84：原本標成「活動名稱」，看不出按了會怎樣
        { label: '🏢 各技術單位窗口', text: '邀訪：各單位' },
        { label: '其他', text: '邀訪：其他' },
        BTN.human // 批次 84：主題選單裡也找得到真人
      ]);
    return;
  }
  let directory = [];
  try { directory = await getContactsDirectory(); } catch { directory = []; }
  // 名單裡有的單位（扣掉「其他」與公關內部組別）都要找得到：朱朱排的順序在前，其餘照名單順序
  const usable = directory.filter(c => c.topic !== '其他' && !isInternalContact(c));
  const ordered = [
    ...GLOBAL_CONTACT_TOPICS.map(t => usable.find(c => c.topic === t)).filter(Boolean),
    ...usable.filter(c => !GLOBAL_CONTACT_TOPICS.includes(c.topic))
  ];
  const unitBtn = c => ({ label: (c.unit || c.topic).slice(0, 20), text: `邀訪：${c.topic}` });
  // 批次 100：單位選單不分頁、不放「找真人」「更多單位」（朱朱 9/30）——13 顆上限 = 回上一層 + 12 個單位，
  // 目前名單剛好 12 個（含電光所、產業學院、中分院）。找真人在第一層。單位超過 12 個時多出來的放不下：
  // 記一筆 log 提醒，那些單位仍可用「其他」打字比對到（matchGlobalContactByText）。
  if (ordered.length > 12) console.warn(`[line] 邀訪單位選單放不下：${ordered.length} 個單位，只顯示前 12 個`);
  const items = [
    { label: '↩ 回上一層', text: CONTACT_MENU_LABEL },
    ...ordered.slice(0, 12).map(unitBtn)
  ];
  await replyOrPush(replyToken, userId,
    ordered.length ? '請問想找哪個技術單位的邀訪窗口？請點下面按鈕。' : '目前還沒有設定各技術單位的窗口，請點「回上一層」選其他方式，或找真人。',
    items);
}

// 攔截「邀訪：主題」按鈕點擊，以及按過「其他」之後的下一則自由輸入——不管目前有沒有
// 活動綁定、綁定的是哪一場，這兩種情況都要優先攔下來，不能被送進當前那場活動的問答
// （記者按「邀訪：生醫」不是在問「生醫」這兩個字，是要查聯絡窗口）。命中就處理完並
// 回傳 true，呼叫端據此判斷要不要繼續往下走原本的流程；沒命中回傳 false。
//
// speakerId（批次 28）：群組裡是「誰」在講這句話。等待中的旗標會記下按按鈕的人，
// 只有同一個人的下一則才用得掉——見 pendingNoteFor() 的完整說明。
// 「其他」輸入的主題對不到任何窗口時，通知公關同仁（批次 94）。跟找真人同一個管道
// （LINE_ADMIN_USER_ID push）、同一個「30 分鐘只通知一次」的防洗版。回傳有沒有真的通知到。
async function notifyStaffNoContactMatch(targetId, text, speakerId = '') {
  const ownerId = process.env.LINE_ADMIN_USER_ID;
  if (!ownerId || ownerId === (speakerId || targetId)) return false;
  const key = `nomatch:${targetId}`;
  if (Date.now() - (humanNotified.get(key) || 0) <= HUMAN_NOTIFY_GAP_MS) return true;
  try {
    const res = await pushMessage(ownerId,
      `📨 邀訪窗口對不到主題\n${isGroupTarget(targetId) ? '（在群組裡）' : ''}記者輸入：「${sanitize(text, 100)}」\n\n` +
      '請找相關技術同仁回復；到 LINE 官方帳號管理後台的「聊天」可以直接回他。');
    const ok = !res || res.ok !== false;
    if (ok) humanNotified.set(key, Date.now());
    return ok;
  } catch (e) { console.error('邀訪對不到主題通知失敗:', e.message); return false; }
}

export async function handleContactTopicMessage(replyToken, targetId, text, { speakerId = '' } = {}) {
  const m = String(text || '').match(CONTACT_TOPIC_RE);
  if (m) {
    const topic = m[1].trim();
    if (topic === '各單位' || topic === '更多單位') { // 「更多單位」是分頁時期的舊按鈕，還留在舊訊息上的照樣接得住
      await setContactPending(targetId, '');
      await sendGlobalContactMenu(replyToken, targetId, { view: 'units' });
      return true;
    }
    if (topic === '其他') {
      await setContactPending(targetId, pendingNoteFor(CONTACT_PENDING_NOTE, targetId, speakerId));
      await replyOrPush(replyToken, targetId, '請直接輸入想了解的技術主題，或想邀訪的議題，我幫您媒合對應窗口。');
      return true;
    }
    // 按了別的主題按鈕，代表放棄了「其他」那個等待輸入的視窗（如果有的話）——不清掉
    // 的話，記者接下來打的第一句真正的問題會被誤當成在找邀訪窗口的自由輸入。
    await setContactPending(targetId, '');
    const directory = await getContactsDirectory();
    const contact = directory.find(c => c.topic === topic && !isInternalContact(c));
    await replyOrPush(replyToken, targetId,
      contact ? formatGlobalContact(contact) : '這個主題目前還沒有設定聯絡窗口，請洽現場工作人員。');
    return true;
  }

  const rawPending = await getStoredNote(targetId);
  if (parsePendingNote(rawPending).note === CONTACT_PENDING_NOTE && pendingBelongsTo(rawPending, speakerId)) {
    await setContactPending(targetId, ''); // 一次性：不管這則有沒有比對到，用掉就清掉
    const directory = await getContactsDirectory();
    const hit = matchGlobalContactByText(text, directory);
    const fallback = directory.find(c => c.topic === '其他');
    if (hit) {
      await replyOrPush(replyToken, targetId, formatGlobalContact(hit));
    } else if (fallback) {
      // 批次 94：對不到窗口不再把記者丟回「問趨勢／問技術」（鬼打牆）——給綜合窗口、通知公關同仁請
      // 相關技術同仁回復，並請記者直接留下資訊。不承諾回覆時間（LINE-PLAN.md 第 9 節）。
      const notified = await notifyStaffNoContactMatch(targetId, text, speakerId);
      await replyOrPush(replyToken, targetId,
        `目前對不到明確的窗口，您可以先聯繫綜合窗口：\n${formatGlobalContact(fallback)}\n\n` +
        (notified ? '我已經把您問的主題轉告公關同仁，會請相關技術同仁回復您。' : '想請相關技術同仁回復的話，可以打「找真人」。') +
        '\n也請直接在這裡留下貴媒體名稱、姓名與聯絡方式，同仁看得到。',
        [BTN.human, BTN.contact, BTN.events]);
    } else {
      await replyOrPush(replyToken, targetId, '目前還沒有設定綜合聯絡窗口，請洽現場工作人員。');
    }
    return true;
  }

  return false;
}

// ── 產業趨勢問答（批次 20，資料來源見 lib/industry-trends.js）─────────────────
// 記者問的不是某一場記者會的內容，是整體產業趨勢／市場現況（例如「半導體最近有
// 什麼趨勢」）——routeIntent() 判成 industry_trend 時走這支，跟現有的 qa／calendar
// 走同一套自然語言路由，1 對 1、群組都適用，不管有沒有綁定活動都答得到（見三個
// 呼叫端：handleUnbound()、handleEvent() 綁定中的判斷、handleGroupMessage() 綁定
// 中的判斷）。
//
// 只用 IEK 免費焦點清單本身就有的標題＋日期＋摘要回答，不呼叫網頁版那套帶知識庫
// 全文的 buildSystemPrompt()——這裡的資料來源、規則完全不同，硬塞進同一支反而
// 要多加一堆「這不是活動內容」的例外判斷。回答結尾一律附上警語＋公關窗口聯絡
// 資訊（使用者原話：「僅供參考，正式媒體報導引用請聯繫 公關窗口 朱則瑋」）——
// 這是 IEK 的免費摘要，不是正式新聞稿，記者可能直接截圖引用，跟
// lib/prompt.js buildSystemPrompt() 既有的「內容僅供參考，以工研院官網新聞稿
// 或發言為準」警語同一種目的。
//
// 優先讀 events!contacts_directory 裡「產業趨勢分析」這個既有主題的窗口
// （批次 9 就有，同仁可在後台「邀訪窗口分工」改名字或補電話，這裡自動跟著
// 更新，不需要改程式碼）；那個主題目前還沒填電話，name／phone 個別退回使用者
// 確認過的號碼當預設值，讓這個功能一上線就能用，不用等同仁先去後台補資料——
// 之後同仁在後台把任一欄填了，這裡就自動改用後台那組，不是永遠鎖死這組預設值。
const FALLBACK_INDUSTRY_TREND_CONTACT = { name: '朱則瑋', phone: '0934-267-766' };

async function industryTrendContactLine() {
  const directory = await getContactsDirectory();
  const configured = directory.find(c => c.topic === '產業趨勢分析');
  const name = configured?.name || FALLBACK_INDUSTRY_TREND_CONTACT.name;
  const phone = configured?.phone || FALLBACK_INDUSTRY_TREND_CONTACT.phone;
  return `\n\n僅供參考，正式媒體報導引用請聯繫 公關窗口 ${name}　📞 ${phone}`;
}

// 「這題問的是產業趨勢，那同一個題目問工研院自己的技術呢」——兩條路互相導流時要
// 用的簡短關鍵字。抽不乾淨（抽完太長、太短、或整句都是泛稱被抽成空的）就回空字串，
// 呼叫端拿到空字串就不放那顆按鈕：這是錦上添花的入口，寧可沒有也不要放一顆
// 「工研院的哪些產業趨勢重點技術」這種讀起來像亂碼的按鈕。
//
// 語助詞的部分直接沿用 lib/itri-news.js 已經在用的那份（stripTechQueryFiller），
// 不另外維護第二份清單；這裡只多去掉「產業／趨勢／市場／現況…」這類**產業趨勢題
// 專屬**的泛稱——那些字在 stripTechQueryFiller() 裡不能去掉（那支是給工研院官網
// 搜尋用的，「產業」本身可能就是要查的詞的一部分），只有在這個「把趨勢題轉成技術
// 題」的場景才該拿掉。
function crossTopicKeyword(text) {
  const kw = stripTechQueryFiller(text)
    // 批次 84：補上疑問詞。按「產業趨勢分析」送進來的固定句「最近有哪些產業趨勢重點」
    // 原本被抽成「有哪些」，按鈕變成「工研院的有哪些技術」。
    .replace(/產業|趨勢|市場|現況|分析|重點|方面|領域|相關|如何|怎樣|怎麼樣|現在|目前|未來|今年|有哪些|哪些|有什麼|什麼|有沒有|嗎|呢/g, '')
    .trim();
  return /^[^\s]{2,8}$/.test(kw) ? kw : '';
}

export async function answerIndustryTrend(replyToken, targetId, text) {
  const items = await getIndustryTrendDigest();
  const contactLine = await industryTrendContactLine();
  // 導到另一條路（工研院自己的技術）的按鈕——實際回報的截圖裡，AI 老實說了「清單
  // 裡沒有航太專項的分析」之後就沒有下文了，記者只能自己猜下一步該打什麼，猜出來
  // 的「太空」又剛好掉進兜底文案。IEK 免費焦點只有十來則、覆蓋不到的領域是常態，
  // 「這裡沒有，可以改從工研院自己的技術報導找」本來就該是預設出口。
  const kw = crossTopicKeyword(text);
  const crossItem = kw ? [{ label: `工研院的${kw}技術`, text: `工研院 ${kw}` }] : [];

  if (!items.length) {
    // 抓取失敗（網路問題、IEK 網站改版）——誠實說抓不到，不要硬答或裝死。
    await replyOrPush(replyToken, targetId,
      `這部分我暫時抓不到最新的產業趨勢資料，真不好意思 🙏${contactLine}`,
      [...crossItem, BTN.events, BTN.tech, BTN.contact, BTN.human]);
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者的產業趨勢問題。下面是「IEK 產業情報網」免費焦點清單（標題／日期／摘要），這是 IEK 自己公開的免費導讀摘要，不是完整報告。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整報告裡才有但摘要沒寫的細節。',
    '如果清單裡沒有明顯對應記者問題的項目，就誠實說「目前免費焦點清單裡沒有直接對應的資料」，不要硬答或東拼西湊。',
    // 實際回報的截圖：AI 老實說了「但沒有航太專項的分析」，然後就沒有下文——記者
    // 只能自己猜下一步該打什麼。誠實不夠，還要給得出出口，不然記者就卡在那裡。
    // ⚠️ 只能建議「換個領域問趨勢」或「改問工研院的技術」這兩條真的存在的路，不要
    // 自己發明「我幫您轉給某某」「請稍等我查一下」這種這個帳號做不到的事。
    '清單裡沒有直接對應的資料時，除了老實講，還要順帶給記者一條明確的下一步：可以換個領域再問我產業趨勢，或是直接問我工研院自己在這個領域的技術（打「工研院＋技術名稱」就可以）。不要只丟一句「沒有資料」就結束，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。',
    '記者的問題如果很籠統、沒有指定特定技術或產業領域（例如只是問「產業趨勢」「最近有什麼趨勢」這種泛稱，不是問特定的半導體、AI 之類），不要反問記者想了解哪個領域——直接摘要清單裡最新的 1-2 則重點回答即可，這正是這份清單存在的目的（讓記者一次掃到最新的幾則重點）；只有記者的問題明確指定了某個領域、清單裡卻完全沒有相關項目時，才適用上一條「沒有直接對應資料」的規則。',
    '回答控制在 4 行以內，先講最相關的 1-2 則的重點，並標明是哪一篇、什麼時候發布的。不要用 Markdown 語法（LINE 不會渲染）。',
    '明確讓記者知道這是 IEK 的免費摘要，不是完整報告——不要講得像這就是 IEK 的完整分析或工研院的正式研究結論。',
    // 人設：使用者要求「對答更有人味、符合米亞的人設」。米亞原本只活在歡迎圖卡與
    // 使用說明裡（見 lib/menu.js buildWelcomeFlex／HELP_TEXT），真正在對話的這幾支
    // 反而是公文語氣。這條只調語氣、不放寬任何一條「只能照資料回答」的規則——記者
    // 會直接截圖引用，親切不能換成含糊，講不知道的時候要更清楚，不是更委婉。
    TONE_RULE,
    '回答最後另起一行，只用這個格式標出這次引用了清單中第幾則（從 1 開始的編號，可能不只一則，用逗號分隔），例如「來源編號：2,5」；這行只給程式判讀連結用，不算進上面「4 行以內」的限制。如果清單裡沒有直接對應的資料，就不要加這一行。',
    '',
    '【IEK 產業情報網 免費焦點清單，由新到舊】',
    formatDigestForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, text);
  // 「來源編號」那行是給程式看的，不能讓記者在 LINE 上看到——extractSourceIndices()
  // 負責切掉它，回報的意見裡記者要的是接下來附的連結，不是這行原始標記。
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  // 沒解析到可信編號（AI 沒加這行、格式不符、或判成「沒有直接對應的資料」）就不附
  // 連結——見 lib/industry-trends.js resolveSourceUrls() 的說明，寧可沒有也不要附錯。
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';
  const reply = `${aiReply}${linksBlock}${contactLine}`;
  console.log(`[line] industry_trend q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply, [...crossItem, BTN.events, BTN.tech, BTN.contact, BTN.human]);
  // 記住這一輪聊的是產業趨勢——下一則如果只是個裸名詞（截圖裡的「太空」），
  // routeIntent() 才接得回這個話題，不會掉進「我沒抓到您想問哪一場活動」。
  // 放在送出回覆之後：這是加分功能，寫失敗（setRecentTopic 自己吞例外）也絕對不能
  // 讓記者收不到剛剛那則答案。
  // ⚠️ 一併記下問句與答案節錄（批次 58）：追問常常不是裸名詞，而是一句指著這段
  // 答案的完整問句（「有談機器人發展的嗎」），路由要看得到這段才判得出來。
  // 存的是 aiReply 不是 reply——連結區塊與窗口警語是我們自己加的裝飾，不是內容，
  // 留在脈絡裡只會讓模型把那幾行也當成「剛剛講過的東西」。
  await setRecentTopic(targetId, 'industry_trend', { question: text, answer: aiReply });
}

// ── 「想問什麼技術」問答（回報的意見，跟產業趨勢問答平行的另一套）──────────
// 記者想直接問工研院「自己」在某項技術上的研發成果，不是在問某一場記者會、也不是
// 在問整體產業趨勢（那是 answerIndustryTrend() 的事）——資料來源是工研院官網新聞
// 中心自己的報導，用記者給的技術名稱當關鍵字去查（見 lib/itri-news.js
// fetchItriNews() 的說明）。兩支故意不共用同一支：資料源不同、查詢方式不同（這支
// 要帶關鍵字去查，answerIndustryTrend() 是固定抓最新清單）、結尾的窗口導引邏輯也
// 不同（這支盡量比對出對應技術領域的窗口，answerIndustryTrend() 固定導向「產業
// 趨勢分析」那個窗口）——硬併成一支只會讓兩邊互相牽制對方的邏輯。
//
// keywordText 兩種來源：①「想問什麼技術」按鈕之後記者自己打的技術名稱（見下面
// handleTechQueryMessage()）；②記者直接自然語言問「工研院在ＸＸ技術上有什麼
// 進展」，routeIntent() 判成 tech_query 時會順手抽一個關鍵字（見 lib/router.js），
// 呼叫端優先用抽出來的關鍵字，沒抽到才退回整句原話。
// ⚠️ 這兩種來源都可能是一整句話而不是乾淨的技術名稱——工研院官網的關鍵字搜尋是
// 接近精準比對，不是全文檢索，整句話（含語助詞）常常查不到（這裡曾經誤判成「全文
// 檢索，整句拿去查更可靠」，實測是錯的，見下方 fetchItriNews() 呼叫）。查無資料時
// 去語助詞再試一次的保底邏輯統一放在 lib/itri-news.js fetchItriNews() 裡面，這支
// 不用自己重試——不管 keywordText 乾不乾淨，這支都不用假設它已經是乾淨關鍵字。
// 查不到、或查到的不相關的時候，一定要留一個「人」給記者（批次 93）。
// 回報（同仁，附截圖）：問「瀝青」「拉麵機器人」，米亞說官網沒有相關報導，然後只有一句「請洽媒體邀訪
// 窗口」——沒有名字、沒有電話。而「機器人」明明有專屬窗口，那句話卻沒有帶出來。這是批次 81（世新事件）
// 講過的形狀：AI 答不出來、又沒有人可以找。
// 優先給比對得到的技術領域窗口（見 matchGlobalContactByText()），比對不到就給綜合窗口（主題「其他」），
// 兩個都沒有才退回那句不含人名的話——後台一個人都沒設定的時候，不能編一個出來。
async function contactTailFor(keyword, lead) {
  const directory = await getContactsDirectory();
  const contact = matchGlobalContactByText(keyword, directory) || directory.find(c => c.topic === '其他');
  return contact
    ? `\n\n${lead}\n${formatGlobalContact(contact)}`
    : '\n\n想安排採訪或進一步了解，請洽媒體邀訪窗口。';
}

export async function answerTechQuery(replyToken, targetId, keywordText) {
  const keyword = sanitize(keywordText, 60);
  // ⚠️ 沒有關鍵字、或關鍵字只是「新聞」「新聞稿」這種泛稱時，改走「最新新聞清單」
  // 那條路。這是 lib/menu.js isLatestNewsQuestion() 那條死板規則之外的第二層：
  // 記者的講法千變萬化，規則接不住的（「工研院這陣子在忙什麼新聞」）會掉到
  // routeIntent()，AI 判成 tech_query 但抽不出技術關鍵字——這時候拿泛稱去查官網
  // 只會撈到雜訊（見 NO_DATA_GENERIC 的說明），列最新清單才是記者真正想要的。
  // 兩層都要有，理由見 CLAUDE.md 第 2 條：規則是保證，AI 是涵蓋率。
  if (!keyword || isGenericLookupKeyword(keyword)) {
    await answerLatestNews(replyToken, targetId, keywordText || '最近有哪些新聞');
    return;
  }
  const { ok, items } = await fetchItriNews(keyword);
  // 導到另一條路（整體產業趨勢）的按鈕，跟 answerIndustryTrend() 的 crossItem 對稱：
  // 工研院官網沒報導過某個題目是常態（尤其比較新的領域），但那不代表「這個題目在
  // 這個帳號問不到東西」——IEK 免費焦點可能剛好有。查不到就只丟一句「請洽窗口」，
  // 等於把還走得通的另一條路藏起來。
  const kw = crossTopicKeyword(keyword);
  const crossItem = kw ? [{ label: `${kw}的產業趨勢`, text: `${kw}產業趨勢` }] : [];

  if (!ok) {
    // 抓取失敗（網路問題、官網改版）——誠實說抓不到，不要硬答或裝死，跟
    // answerIndustryTrend() 抓取失敗那條路同一個原則。
    await replyOrPush(replyToken, targetId,
      '這部分我暫時抓不到工研院官網的最新資料，真不好意思 🙏 建議直接洽媒體邀訪窗口。',
      [...crossItem, BTN.events, BTN.trend, BTN.contact, BTN.human]);
    return;
  }
  if (!items.length) {
    // 查無資料是很正常的結果（工研院官網不是每個技術都報導過，或記者打的詞比較
    // 冷門）——不是網站掛了，見 fetchItriNews() 的說明。老實說查不到，直接給邀訪
    // 窗口讓記者換個管道問，不要硬答或東拼西湊。
    await replyOrPush(replyToken, targetId,
      `工研院官網新聞中心目前沒有找到跟「${keyword}」直接相關的報導。` +
      await contactTailFor(keyword, '要找人談的話，可以直接聯繫：') +
      '\n\n想請相關技術同仁回復，也可以打「找真人」。',
      [BTN.human, BTN.contact, BTN.events]); // 批次 94：不再導去「產業趨勢」——記者問的是技術，被丟回去問趨勢就是鬼打牆
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者關於工研院自己技術的問題。下面是用記者提供的關鍵字，在「工研院官網新聞中心」查到的相關報導（標題／日期／摘要），這是工研院自己發布的新聞稿摘要，不是完整報告全文。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整報導裡才有但摘要沒寫的細節。',
    '如果清單裡的項目其實跟記者問的技術關聯不大，就誠實說「目前工研院官網新聞中心沒有找到直接對應的報導」，並順帶給記者一條明確的下一步：可以改問我這個題目的整體產業趨勢，或換個技術名稱再問一次。不要硬答或東拼西湊，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。',
    '回答控制在 4 行以內，先講最相關的 1-2 則的重點，並標明是哪一篇、什麼時候發布的。不要用 Markdown 語法（LINE 不會渲染）。',
    TONE_RULE, // 見上面 TONE_RULE 的說明：只調語氣，不放寬「只能照資料回答」的規則
    '回答最後另起一行，只用這個格式標出這次引用了清單中第幾則（從 1 開始的編號，可能不只一則，用逗號分隔），例如「來源編號：2,5」；這行只給程式判讀連結用，不算進上面「4 行以內」的限制。如果清單裡沒有直接對應的報導，就不要加這一行。',
    '',
    `【工研院官網新聞中心 搜尋「${keyword}」的結果，由新到舊】`,
    formatNewsForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, keywordText);
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';

  // 導引窗口：優先用記者的關鍵字比對出對應技術領域的專屬窗口（跟「媒體邀訪需求」
  // 按鈕裡「其他」自由輸入同一支比對邏輯，見 lib/contacts-directory.js
  // matchGlobalContactByText() 的說明），比對不到才退回一般性的邀訪窗口指引——
  // 給得出精準窗口就不要只給一句「請洽邀訪窗口」，記者還要再點一次按鈕才找得到人。
  const contactLine = await contactTailFor(keyword, '想安排採訪或進一步了解，可直接聯繫：');

  const reply = `${aiReply}${linksBlock}${contactLine}`;
  console.log(`[line] tech_query kw="${keyword}" reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply, [...crossItem, BTN.events, BTN.trend, BTN.contact, BTN.human]);
  // 跟 answerIndustryTrend() 同一個道理：記住這一輪聊的是工研院技術，下一則只打一個
  // 技術名詞（「那光通訊呢」的省略講法）才接得回來，見 getRecentTopic() 的說明。
  // 問句與答案節錄一併記下，理由同 answerIndustryTrend() 那段（批次 58）。
  await setRecentTopic(targetId, 'tech_query', { question: keyword, answer: aiReply });
}

// ── 「最近工研院有哪些新聞」（回報，附截圖）─────────────────────────────
// 記者在群組打「米亞 最近工研院有哪些新聞」，米亞回的是【近期活動】行事曆，記者
// 只好再追問一次「最近發的新聞稿麼」。問的是新聞稿，回的是記者會場次表——在這個
// 帳號裡這是兩個不同的資料來源（新聞稿在工研院官網新聞中心，場次在 events 表）。
//
// 這支跟 answerTechQuery() 的差別只有一個：**不帶關鍵字**，直接抓官網新聞中心的
// 「最新新聞」第一頁。lib/itri-news.js 的 fetchItriNews() 早就備好這條路（那支的
// 註解寫著「這個分支是給之後萬一有『不指定技術、直接看工研院最新動態』需求時的
// 退路」），這裡才第一次真的用到。
//
// ⚠️ 為什麼不共用 answerTechQuery()：那支的每一句話都繞著「記者給的那個關鍵字」
// 打轉——查無資料的文案（「沒有找到跟『ＸＸ』相關的報導」）、導到 IEK 的按鈕
// （crossTopicKeyword）、比對技術領域窗口（matchGlobalContactByText）三處都要
// 關鍵字。沒有關鍵字時那三處全部沒有意義，硬併只會讓兩邊互相牽制。
async function answerLatestNews(replyToken, targetId, question) {
  const { ok, items } = await fetchItriNews('');
  if (!ok) {
    await replyOrPush(replyToken, targetId,
      '這部分我暫時抓不到工研院官網的最新資料，真不好意思 🙏 建議直接洽媒體邀訪窗口。',
      ['產業趨勢分析', CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }
  if (!items.length) {
    // 官網連得上、清單卻是空的——多半是官網改版讓 parseNewsListHtml() 解析不到
    // （見 lib/itri-news.js）。誠實說抓不到，不要硬掰。
    await replyOrPush(replyToken, targetId,
      '我這邊暫時讀不到工研院官網新聞中心的清單，真不好意思 🙏 可以直接看官網：\nhttps://www.itri.org.tw/ListStyle.aspx?DisplayStyle=06&SiteID=1&MmmID=1036276263153520257',
      ['產業趨勢分析', CONTACT_MENU_LABEL, '最近有哪些活動']);
    return;
  }

  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，正在回答記者「工研院最近發了哪些新聞」這個問題。下面是「工研院官網新聞中心」最新一頁的新聞稿（標題／日期／摘要），由新到舊。',
    '只能根據下面清單裡的標題與摘要回答，不要延伸、不要用你自己既有的知識補充清單以外的內容、不要臆測完整新聞稿裡才有但摘要沒寫的細節。',
    // ⚠️ 這裡刻意要求「條列最新的幾則」而不是「摘要重點」：記者問的是「有哪些」，
    // 要的是一份可以掃過去的清單，不是一段濃縮成兩句話的綜述。答成綜述等於把他
    // 真正想要的東西（哪幾則、什麼時候發的）藏起來。
    '用條列的方式列出最新的 5 則，一則一行，格式是「日期　標題」（標題太長就精簡到 30 字內，但不要改變原意）。開頭先用一句話說明這是工研院官網新聞中心最近發布的新聞稿。',
    '不要加上你自己的評論或推薦，也不要承諾任何你做不到的事（例如幫忙轉接、稍後回覆、代為查詢）。不要用 Markdown 語法（LINE 不會渲染）。',
    TONE_RULE, // 見上面 TONE_RULE 的說明：只調語氣，不放寬「只能照資料回答」的規則
    '回答最後另起一行，只用這個格式標出你列出來的是清單中第幾則（從 1 開始的編號，用逗號分隔），例如「來源編號：1,2,3,4,5」；這行只給程式判讀連結用，不算進上面的行數限制。',
    '',
    '【工研院官網新聞中心 最新新聞，由新到舊】',
    formatNewsForPrompt(items)
  ].join('\n');

  const rawReply = await askAnthropic(systemPrompt, question);
  const { text: aiReply, indices } = extractSourceIndices(rawReply);
  const urls = resolveSourceUrls(indices, items);
  const linksBlock = urls.length ? `\n\n🔗 原文連結：\n${urls.join('\n')}` : '';

  const reply = `${aiReply}${linksBlock}\n\n想看某一則的細節，直接打標題裡的關鍵字就可以；要安排採訪請洽媒體邀訪窗口。`;
  console.log(`[line] latest_news items=${items.length} reply="${reply.slice(0, 200)}"`);
  await replyOrPush(replyToken, targetId, reply,
    [BTN.events, BTN.trend, BTN.tech, BTN.contact, BTN.human]);
  // 記住這一輪聊的是工研院自己的新聞：下一則只打一個技術名詞（「那半導體呢」的省略
  // 講法）才接得回 tech_query，見 getRecentTopic() 的說明。
  // 問句與答案節錄一併記下，理由同 answerIndustryTrend() 那段（批次 58）——這條路
  // 的答案是一份新聞標題清單，記者的追問（「有談機器人的嗎」）幾乎一定是指著清單裡
  // 的某一則，更需要這段脈絡。
  await setRecentTopic(targetId, 'tech_query', { question, answer: aiReply });
}

// 「想問什麼技術」按鈕之後記者自己打的技術名稱——跟 handleContactTopicMessage()
// 「其他」自由輸入同一個模式：先記一個一次性旗標，下一則不管長什麼樣都當成技術
// 名稱直接去查，不逼記者用特定句型（「我想問」「請問」之類），也不用 AI 再判斷
// 一次「這是不是技術名稱」——反正查不到 answerTechQuery() 自己會老實說查不到。
//
// speakerId（批次 28）：理由同 handleContactTopicMessage()，見 pendingNoteFor()。
export async function handleTechQueryMessage(replyToken, targetId, text, { speakerId = '' } = {}) {
  const rawPending = await getStoredNote(targetId);
  if (parsePendingNote(rawPending).note !== TECH_QUERY_PENDING_NOTE) return false;
  if (!pendingBelongsTo(rawPending, speakerId)) return false; // 群組裡別人插的話，不是他要查的技術名稱
  await setContactPending(targetId, ''); // 一次性：不管查不查得到，用掉這一次就清掉
  await answerTechQuery(replyToken, targetId, text);
  return true;
}
// 正式問答：開輸入中動畫 → 呼叫 Anthropic → reply（失敗 fallback push）→ 寫 qa_log。
// 綁定路徑（#代碼）跟路由命中路徑（自然語言直接命中某一場）最後都走這支，避免兩邊各自
// 維護一份幾乎一樣的邏輯、之後改一邊忘了改另一邊。
//
// memory（批次 28）：要不要帶上「上一輪對話」給模型，並在答完之後記下這一輪。
// 只有 1 對 1 的記者問答會傳 true——群組多人交錯提問、職員模式問的是後台資料，
// 兩者回放上一輪只會製造答非所問，見 getRecentTurn() 的說明。
export async function answerQuestion(replyToken, userId, rawEvent, mediaName, text, { allowPreEventSubstitution = true, switchNotice = '', memory = false, group = false, speakerId = '' } = {}) {
  // 是不是群組，直接看對象的 id（C／R 開頭），不靠呼叫端記得傳 group:true（批次 83）。
  // 實測抓到的：群組裡點活動清單的按鈕 → handleUnbound() 軟綁定後答第一題，那條路沒傳
  // group，第一則答案掛的是 1 對 1 那排按鈕（少了產業趨勢、問技術），也沒套群組規則。
  group = group || isGroupTarget(userId);
  // 活動前只給媒體邀請函、不給正式新聞稿與照片（見 lib/prompt.js resolveEventContent()
  // 的說明）。放在這裡而不是呼叫端各自判斷，理由跟下面的邀訪窗口比對一樣：1 對 1、
  // 群組最後都走這支，寫一次兩邊都受惠。
  //
  // ⚠️ 職員模式呼叫這支時會傳 allowPreEventSubstitution:false——同仁需要看到真正的
  // 新聞稿內容準備活動，不能被自己設的「活動前」邏輯反過來卡住自己。
  const event = allowPreEventSubstitution ? resolveEventContent(rawEvent) : rawEvent;

  // ⚠️ 「輸入中」動畫以前在這裡（只有這條路有），批次 60 移到 handleEvent() 的 1 對 1
  // 咽喉點——回報是「動畫只有時候才出現」，而原因就是它只掛在這一支上，產業趨勢、
  // 工研院技術、智慧兜底那幾條（剛好是比較慢的）完全沒有。理由與取捨見那邊的說明。
  // 群組走到這支時本來就不該有動畫（LINE 只支援一對一），移上去之後自然成立，不必再
  // 靠呼叫端記得傳 loading:false。

  // 命中同仁設定的邀訪窗口關鍵字就直接回聯絡資訊，不呼叫 AI——這類回覆要求精準，
  // 電話號碼、LINE ID 這種資訊不該讓 AI 用自然語言重新生成一次（打錯一碼就是
  // 記者聯絡不到人）。放在 answerQuestion() 裡而不是呼叫端各自檢查，是因為
  // 1 對 1、群組、職員模式最後都走這支，寫一次三邊都受惠。
  // switchNotice：批次 13「綁定改成預設值」加的提示字首（見 handleEvent／
  // handleGroupMessage 裡呼叫端判斷這題其實在問別場時傳進來的「🔄 已切換到《X》：」）。
  // 兩個分支（命中邀訪關鍵字／走 AI 問答）都要接上，記者才看得出這題是被自動切去
  // 別場回答的——悄悄換掉答案卻不說一聲，比根本不能換更危險（LINE-PLAN.md 坑 6）。
  const contact = matchContact(text, event.contacts);
  if (contact) {
    const reply = switchNotice + formatContactReply(contact);
    console.log(`[line] contact match event=${event.id} keyword="${contact.keyword}"`);
    await replyOrPush(replyToken, userId, reply, eventQuickChips(event, { group }));
    await logQa(event, mediaName, text, reply);
    return;
  }

  // 同仁後續補充／更正（批次 46）。接在新聞稿之後、標明「以這裡為準」——同仁最常用
  // 它更正已經過時的內容（改地點、改時間），只寫「補充資料」的話，模型看到兩個互相
  // 矛盾的說法時不知道該信哪一個。
  const factBlock = formatFactBlock(await getMemories(), event.id);
  // 企業場（批次 118）用企業版的規則，見 lib/prompt.js systemPromptFor()
  const systemPrompt = systemPromptFor(event, [...lineExtraRules(event), ...(group ? [GROUP_ANSWER_RULE] : [])]) + factBlock;
  // 上一輪對話——「那成本呢」這種省略式續問要接得住，靠的就是這兩則；見
  // buildTurnHistory() 的說明。群組照「發問的那個人」各記各的（批次 83，見 setGroupTurn()）。
  const history = memory ? await buildTurnHistory(userId, event.id)
    : group ? await buildGroupTurnHistory(userId, speakerId, event.id) : [];

  // ── 跨場次（批次 36）──────────────────────────────────────────────────
  // 回報的意見：「這一定要切來切去特定活動專屬回答系統嗎？不能一體適用？」
  // 記者問「今年院士有誰」，答案就寫在《工研院院士授證典禮》那場的新聞稿裡——但問答
  // 只讀「目前綁定的這一場」，於是不是答不出來、就是要先切過去。記者根本不該需要知道
  // 「這個問題屬於哪一場」。
  //
  // 主場次照舊完整帶進第一個（吃快取的）system 區塊，另外自動挑幾場真的跟這題有關的
  // 接在第二個區塊——挑選是純字面比對、不呼叫 AI（見 lib/related-events.js 的說明）。
  // 挑不到就是空字串，行為跟改動前完全一樣。
  //
  // ⚠️ 用 allEvents 而不是 buildCalendarCards()：卡片只有 id／名稱／日期，沒有知識庫
  // 全文，比不出「哪一場的內容跟這題有關」。這裡要的就是全文。
  // ⚠️ 一樣過 resolveEventContent()：活動前的場次只能拿邀請函出來，不能因為它是「別
  // 場」就繞過那道限制（見 lib/prompt.js 的說明）。
  let relatedBlock = '';
  try {
    // 企業場（批次 118）的知識庫不帶進任何一題：給客戶看的內容不能被記者的問題拉出來（見 lib/audience.js）
    const others = (await getAllEventRows()).map(rowToEvent)
      .filter(e => isUsable(e) && !isBusinessEvent(e))
      .map(e => resolveEventContent(e));
    const related = selectRelatedEvents(text, others, { exclude: event.id });
    relatedBlock = formatRelatedEventsBlock(related, event.name);
    if (related.length) {
      console.log(`[line] 跨場次帶入 ${related.map(e => e.id).join(',')} q="${text.slice(0, 40)}"`);
    }
  } catch (e) {
    // 跨場次是加分功能，挑選出錯絕對不能讓記者連本場的答案都拿不到。
    console.error('selectRelatedEvents 失敗:', e.message);
  }

  // 活動基本資料（日期／時間／地點／聯絡人＋現在時間）放在第二個、不吃快取的 system
  // 區塊：現在時間每分鐘在變，放進第一塊會讓每一題都重建快取（見 formatEventBasics()）。
  const basicsBlock = formatEventBasics(event);
  const extraSystem = [basicsBlock, relatedBlock].filter(Boolean).join('\n\n');
  const rawReply = await askAnthropic(systemPrompt, text, history, { extraSystem, business: isBusinessEvent(event) });
  // 標記一定要切掉（不管後面用不用得到那個關鍵詞），見 extractNoDataKeyword() 的 ⚠️。
  const { text: cutReply, keyword: noDataKeyword } = extractNoDataKeyword(rawReply);
  // 企業場（批次 118）：背景資料沒有的金額＝模型自己估的價，整則換成固定回覆；沒問題的補上免責句。
  // 放在切標記之後、補查官網之前：補查接上去的是官網連結，不是模型寫的字。
  const aiReply = isBusinessEvent(event) ? guardBusinessAnswer(cutReply, event).text : cutReply;
  // 這場答不出來時，補查一次工研院官網新聞中心——回報的截圖就是這個洞（見
  // lineExtraRules() 那條規則的說明）。查不到就是空字串，原本的答案照舊。
  // 標記優先（模型抓的關鍵詞語意最準），沒有標記就看回覆內容像不像「我沒有這項資料」，
  // 像的話從問句猜一個關鍵詞——見 NO_DATA_PHRASE_RE 的說明（批次 37）。
  // 兩個來源都算數，依序試（見 itriNewsHintBlock() 的 ⚠️）：標記的語意最準，但模型
  // 常常把整句話塞進去、官網那種接近精準比對的搜尋查不到；猜的比較乾淨、命中率高。
  // 只要其中一個查得到就算數。
  const phraseHit = NO_DATA_PHRASE_RE.test(aiReply);
  const guessed = (noDataKeyword || phraseHit) ? guessNoDataKeyword(text) : '';
  const lookupKeywords = [...new Set([noDataKeyword, guessed].filter(Boolean))];
  if (lookupKeywords.length) {
    console.log(`[line] 補查官網 候選=${JSON.stringify(lookupKeywords)} 標記=${noDataKeyword || '-'} 句型=${phraseHit}`);
  }
  // ⚠️ 補查是**加分**，不能拿已經算出來的答案去賭它（批次 57）。
  // 這條路最壞情況是：官網 HTTP 最多 4 次（2 個候選詞 × 每個查無資料會去語助詞再試
  // 一次，見 lib/itri-news.js）＋ 再一次 Sonnet 把結果讀成答案。答題那段已經花掉的
  // 時間再加上這一串，整支很容易撞到 Vercel 的 60 秒被砍——而被砍掉的那一刻，
  // 上面那句誠實的「這部分我沒有資料」也跟著消失，記者連本來拿得到的答案都沒了。
  // 用剩餘時間當預算：不夠就直接跳過補查，把答案先送出去。
  const lookupBudget = budgetFor(LOOKUP_BUDGET_MS, REPLY_RESERVE_MS);
  const newsHint = (lookupKeywords.length && lookupBudget >= LOOKUP_MIN_MS)
    ? await itriNewsHintBlock(lookupKeywords, { chinese: hasChinese(aiReply), question: text, budgetMs: lookupBudget })
    : '';
  if (lookupKeywords.length && lookupBudget < LOOKUP_MIN_MS) {
    console.log(`[line] 補查官網跳過：這次請求只剩 ${msLeft()}ms，先把答案送出去`);
  }
  // 群組裡要全文：模型只給重點（GROUP_ANSWER_RULE），一對一拿全文的連結由程式接上——
  // 網址一個字都不能錯，不交給模型寫。
  const fullTextTail = group && GROUP_FULL_TEXT_RE.test(text) ? groupFullTextTail(event) : '';
  const reply = switchNotice + aiReply + newsHint + fullTextTail;
  // 診斷用途，不是必要邏輯：路由判斷得準不準、AI 答得順不順，靠這行在 Vercel Logs
  // 裡直接看得到，不用另外接工具。刻意截斷長度，避免整份新聞稿灌爆單行 log。
  console.log(`[line] answer event=${event.id} status=${event.status} q="${text.slice(0, 60)}" reply="${reply.slice(0, 200)}"`);
  // 每則答案都附上這場的快速提問按鈕（同仁自訂的 chips，或沒設定時的預設問題）——
  // 跟網頁版一樣，chips 不是「選過一次就收起來」的一次性選單，而是隨時都在，記者
  // 問完一題還想繼續問別的方向，點一下就好，不用自己想下一句要打什麼。
  const chips = eventQuickChips(event, { group });
  if (event.images && looksLikePhotoRequest(text)) {
    // 照片跟文字答案同一則 reply 送出（批次 83）——以前照片另外 push，而群組的 push 是照
    // 成員人數計費的，大群組問幾次照片就能用光整個帳號一個月的額度。照片網址被 LINE
    // 拒絕時會自動退回只送文字，不會連累答案，見 lib/line.js replyTextWithImages()。
    await replyTextWithImages(replyToken, userId, reply, chips, event.images,
      { quoteToken: takeQuoteToken(userId), isGroup: group });
  } else {
    await replyOrPush(replyToken, userId, reply, chips);
  }
  await logQa(event, mediaName, text, reply);
  // 記下這一輪，讓下一則的省略式續問接得回來。放在最後（答案早就送出去了）而且
  // setRecentTurn() 自己吞例外——這是體驗加分，寫失敗絕對不能連累剛剛那則答案。
  // 記的是 aiReply 而不是 reply：switchNotice（「已切換到《X》：」）是講給人看的
  // 系統提示，不是對話內容，回放給模型只會變成雜訊。
  // 存 aiReply（已切掉標記、不含補查來的連結區塊）——那些連結是給人點的線索，
  // 回放給模型當對話脈絡只會變成雜訊。
  if (memory) await setRecentTurn(userId, event.id, text, aiReply);
  else if (group) await setGroupTurn(userId, speakerId, event.id, text, aiReply);
}

// 群組問答多一條規則（批次 83）。群組裡還有其他人：一整篇新聞稿貼進去，所有人的畫面
// 都被洗掉一大段，而且 LINE 單則 5000 字，長稿本來就會被截斷。
const GROUP_ANSWER_RULE = '這一題是在多人 LINE 群組裡問的，群組裡還有其他人在聊天：只回答這一題的重點，比平常更精簡。記者要完整新聞稿、全文或完整內容時，不要把全文貼進群組，只給 5 行以內的重點摘要——程式會在後面自動附上一對一取得全文的方式，你不用自己寫連結或教他怎麼拿。';
// 只認「要整份稿子」的講法。刻意不收「完整版」「逐字稿」：「有完整版影片嗎？」「有沒有
// 逐字稿？」問的不是新聞稿，後面接一段「完整新聞稿比較長…」就是答非所問。
const GROUP_FULL_TEXT_RE = /(完整|整篇|整份)的?(新聞)?稿|新聞稿的?(全文|全部|完整)|全文|完整的?內容|整篇(貼|給|傳|發)/;
// 「整句就只是在要完整新聞稿、沒帶任何主題」：圖文選單「新聞稿全文」那一格送出的固定句型（「給我完整新聞稿」）
// 與記者手打的常見講法。批次 115：這種句子**不能交給模型判**。回報（截圖）：按那一格，回來的是「工研院官網
// 新聞中心目前沒有找到跟『給我完整新聞稿』直接相關的報導」——正式環境的模型把它判成 tech_query、又抽不出關鍵字，
// 整句被丟去官網搜尋。上面反問「要哪一場」的規則（批次 85）排在路由「之後」，路由判成別的就永遠輪不到。
// 刻意收得緊：有主題的（「半導體的完整新聞稿」）、點名活動的（《ＸＸ》的完整新聞稿）都不吃，那些照舊交給路由。
const FULL_TEXT_ASK_EXACT_RE = /^(請|麻煩)?(給我|我要|我想要|想要|可以給我|能給我)?((完整|整篇|整份)的?新聞稿|新聞稿(全文|全部|完整版?))(嗎|呢)?[?？!！。]*$/;
export const isFullTextAsk = (text) => FULL_TEXT_ASK_EXACT_RE.test(String(text || '').trim());
// 「要哪一場的完整新聞稿」那排按鈕送出的字（批次 85）。固定格式，才能不靠模型、直接認出是哪一場，
// 群組裡別人按也認得（見 isOwnButtonText()）。有人照這個格式自己打字，意思也一樣。
export const FULL_TEXT_PICK_RE = /^給我《(.+)》的完整新聞稿$/;
function fullTextPickButton(name) {
  return { label: name, text: `給我《${name}》的完整新聞稿` };
}
// 「要哪一場的完整新聞稿」那一則。eventIds：路由已經認出的場次（有知識庫的才算）；沒有就列全部。
// 回 false＝一場都列不出來（呼叫端照原流程往下走）。
async function sendFullTextPicker(replyToken, userId, cards, eventIds = []) {
  const named = eventIds.map(id => cards.find(c => c.id === id)).filter(c => c?.has_kb);
  const picks = named.length ? named.map(c => c.name) : calendarQuickReplyItems(cards);
  if (!picks.length) return false;
  await replyOrPush(replyToken, userId,
    `想要哪一場的完整新聞稿呢？點下面的活動就給您：\n${picks.map(n => '・' + n).join('\n')}`,
    [...picks.map(fullTextPickButton), BTN.events, BTN.human].slice(0, 13));
  return true;
}
export async function fullTextPickEvent(text) {
  const m = String(text || '').trim().match(FULL_TEXT_PICK_RE);
  if (!m) return null;
  const name = m[1].trim();
  const row = (await getAllEventRows()).find(r => String(r[1] || '').trim() === name);
  const event = row ? rowToEvent(row) : null;
  // 企業場（批次 118）不能靠打出活動名稱就拿到全文：按鈕本來就只列記者的清單，自己照格式打的也一樣不給
  return isUsable(event) && !isBusinessEvent(event) ? event : null;
}

function groupFullTextTail(event) {
  const url = lineBindUrl(event.id);
  return url
    ? `\n\n📄 完整新聞稿比較長，就不在群組裡整篇貼出來了。想要全文，點這個連結跟我一對一（會自動帶入這一場），傳送之後再打「給我完整新聞稿」：\n${url}`
    : '\n\n📄 完整新聞稿比較長，就不在群組裡整篇貼出來了。想要全文，加我好友之後私訊我「給我完整新聞稿」。';
}
// ── 「跳出本場」意圖（活動列表／換一場／使用說明）─────────────────────
// ⚠️ 這是實際回報的問題：原本只要 line_users 有有效綁定，handleEvent 就把每一則
// 訊息無條件送進 answerQuestion()，記者打「最近活動」會被當成「請那一場的 AI 回答
// 『最近活動』」——AI 手上只有那一場的知識庫，只能再自我介紹一次，記者等於被鎖死在
// 掃到的那場，沒有任何出口。
//
// 解法是在進問答之前先攔三種「這句話不是在問某一場內容」的意圖。判斷放在
// lib/menu.js、純關鍵字不呼叫 AI（理由見該檔開頭），所以綁定中的正常提問一個字節
// 都沒變慢，也不會多一分錢。
//
// 放在綁定判斷「之前」是刻意的：沒綁定的記者問「使用說明」一樣要拿到說明，而不是
// 掉進 routeIntent() 被判成 other、只拿到「不確定您想問哪一場」。
// ── 找真人（批次 81）──────────────────────────────────────────────────────
// 世新大學事件的教訓：AI 最傷人的不是答錯，是「答不出來、又找不到人」。所以這一則：
//   ① 一定給得出真人：目前這場的新聞聯絡人 → 全站綜合窗口（contacts_directory 的「其他」）
//      → 都沒有時，退到程式裡寫死的綜合聯絡人（跟產業趨勢那條同一位）
//   ② 通知公關同仁（LINE_ADMIN_USER_ID）：記者可以在 LINE 官方帳號後台的聊天室被真人直接回覆
//   ③ 不承諾回覆時間（LINE-PLAN.md 第 9 節：收了單沒回，比沒有這個功能更傷）
// 全部寫死、不經過模型：聯絡方式不能是模型生出來的。
const HUMAN_NOTIFY_GAP_MS = 30 * 60 * 1000; // 同一個對話 30 分鐘內只通知一次，避免記者連打幾次就洗管理員的版
const humanNotified = new Map();

async function sendHumanContact(replyToken, targetId, text, binding, { speakerId = '', group = false } = {}) {
  const lines = ['我是米亞，工研院的 AI 小幫手 🙂 想直接找人的話：'];
  const event = binding?.event_id ? await getEventById(binding.event_id) : null;
  if (isUsable(event) && event.press_contact) {
    lines.push(`・《${event.name}》新聞聯絡人：${event.press_contact}`);
  }
  let dir = [];
  try { dir = await getContactsDirectory(); } catch { dir = []; }
  const general = dir.find(c => c.topic === '其他');
  const g = general?.name ? { ...general } : { ...FALLBACK_INDUSTRY_TREND_CONTACT };
  // 預設名單的「其他」那行沒填電話（同一個人在「產業趨勢分析」那行有）。只給名字等於沒給，
  // 從名單裡找同一個人的電話補上；再沒有就用程式裡寫死的那支。
  if (!g.phone) {
    g.phone = dir.find(c => c.name === g.name && c.phone)?.phone
      || (g.name === FALLBACK_INDUSTRY_TREND_CONTACT.name ? FALLBACK_INDUSTRY_TREND_CONTACT.phone : '');
  }
  lines.push(`・工研院新聞綜合窗口：${g.name}${g.phone ? ` ${g.phone}` : ''}${g.lineId ? `（LINE：${g.lineId}）` : ''}`);
  lines.push('・各技術領域的窗口：打「媒體邀訪需求」');

  const ownerId = process.env.LINE_ADMIN_USER_ID;
  const key = group ? `${targetId}` : targetId;
  const last = humanNotified.get(key) || 0;
  let notified = false;
  if (ownerId && ownerId !== (speakerId || targetId) && Date.now() - last > HUMAN_NOTIFY_GAP_MS) {
    try {
      const res = await pushMessage(ownerId,
        `🙋 有人在 LINE 要找真人\n${group ? '（在群組裡）' : ''}${isUsable(event) ? `目前在問：《${event.name}》\n` : ''}原話：「${sanitize(text, 100)}」\n\n` +
        '可以到 LINE 官方帳號管理後台的「聊天」直接回覆他。');
      notified = !res || res.ok !== false;
      if (notified) humanNotified.set(key, Date.now());
    } catch (e) { console.error('找真人通知失敗:', e.message); }
  } else if (ownerId && Date.now() - last <= HUMAN_NOTIFY_GAP_MS) {
    notified = true; // 剛剛已經通知過了
  }
  if (notified) lines.push('\n我也轉告公關同仁了，他們看到會在這個對話直接回你；急的話直接打電話比較快。');
  console.log(`[line] 找真人 target=${targetId} group=${group} notified=${notified}`);
  await replyOrPush(replyToken, targetId, lines.join('\n'),
    [BTN.contact, BTN.events, BTN.trend, BTN.tech, BTN.help]); // 批次 84：不放「找真人」自己
}

export async function handleMetaIntent(replyToken, userId, text, metaIntent, binding, { speakerId = '', group = false, staff = false } = {}) {
  // ask_name 是「#代碼綁定後問了媒體名稱，下一則要試著擷取」的一次性旗標。
  // 記者在那個視窗裡改按了選單按鈕，代表他跳過了報名字這件事，旗標要當場作廢——
  // 不清掉的話，等他選完活動再回來打的第一句真正的問題，會被 looksLikeNameOrSkip()
  // 誤判成媒體名稱吃掉（就是上面 handleEvent 註解裡已經修過一次的那個坑）。
  if (binding?.note === 'ask_name') await setBindingNote(userId, '');
  // await_contact_topic（按了「其他」，等記者自己打技術主題）與 await_tech_query
  // （按了「想問什麼技術」，等記者自己打技術名稱）這兩個一次性旗標，記者這時候改按
  // 了別的選單按鈕就代表他放棄了那次自由輸入，旗標要當場作廢——不清掉的話，他接下來
  // 打的第一句真正的問題會被誤判成在找邀訪窗口／在報技術名稱。
  // （這裡沒辦法只看 binding?.note，因為這兩個旗標常常是在完全沒有活動綁定時設的。）
  // ⚠️ 兩個旗標存在同一欄、用同一支讀寫，所以只讀一次就夠：原本寫成連續兩個
  // `await getStoredNote()`，第一個若命中會 setContactPending() → 快取失效 →
  // 第二個必定真的再打一次 Sheets 讀取，白花一次全站共用的配額。
  // ⚠️ 旗標可能帶著「這是誰按的」後綴（群組，見 pendingNoteFor()），比對前要先切掉；
  // 這裡刻意「不」檢查是不是同一個人——按了別的選單按鈕就是放棄那次自由輸入，不管
  // 是誰按的，那個等待中的視窗都該當場作廢，留著只會讓下一句真正的問題被誤判。
  const { note: pendingNote } = parsePendingNote(await getStoredNote(userId));
  if (pendingNote === CONTACT_PENDING_NOTE || pendingNote === TECH_QUERY_PENDING_NOTE) {
    await setContactPending(userId, '');
  }

  if (metaIntent === 'thanks' || metaIntent === 'ack') {
    // 收尾語（批次 72，見 lib/menu.js detectCourtesy()）。寫死一句、不呼叫模型：
    // 以前綁定中說「謝謝」會送進 answerQuestion()，花一次 Sonnet、回一句「不客氣」再加
    // 一行「內容僅供參考，以工研院官網新聞稿為準」，還被記進 qa_log 算成一題提問；
    // 沒綁定時更糟，會被當成主題詞複誦（「『謝謝米亞』我可以從兩個方向幫您找」）。
    // 按鈕照樣給：綁定中是這場的快速提問（他可能還想問），沒綁定是四條路。
    const current = binding?.event_id ? await getEventById(binding.event_id) : null;
    const chips = isUsable(current) ? eventQuickChips(current, { group })
      : HOME_MENU; // 批次 84：群組與 1 對 1 同一排（原本群組拿到的是預設導覽、1 對 1 少了找真人）
    await replyOrPush(replyToken, userId, (group ? COURTESY_REPLIES_GROUP : COURTESY_REPLIES)[metaIntent], chips);
    return;
  }

  if (metaIntent === 'menu') {
    // 叫出按鈕（批次 84，見 lib/menu.js MENU_EXACT_RE）。正在問某一場就給那場的整排，
    // 否則給起點那排。純按鈕、不呼叫模型、不寫 qa_log。
    const current = binding?.event_id ? await getEventById(binding.event_id) : null;
    await replyOrPush(replyToken, userId,
      isUsable(current)
        ? `按鈕在下面 👇 目前在問的是《${current.name}》，也可以直接打字問。`
        : '按鈕在下面 👇 想問什麼也可以直接打字。',
      isUsable(current) ? eventQuickChips(current) : HOME_MENU);
    return;
  }

  if (metaIntent === 'help') {
    // ⚠️ 直接把影片送進對話裡播，不是丟一條連結（批次 46）。
    // 回報的原話：「影片現在是跳連結，有可能直接在對話傳或播影片嗎？不會有人特別
    // 還會去點連結的」——完全正確。使用說明的目的是「讓人真的看」，一條連結把
    // 「看」變成一個要主動決定的動作，多數人就滑過去了；LINE 的 video 訊息會直接
    // 在對話裡顯示成可播放的畫面，門檻是零。
    //
    // 影片是 public/mia-guide-v2.mp4（30 秒、9:16、約 11 MB，遠低於 LINE 的
    // ⚠️ 換影片時檔名要換（v3…）：LINE 依網址快取媒體，同網址換檔它不會重抓，
    // 使用者會一直看到舊片（批次 87 實測抓到）。
    // 200 MB 上限），封面是第一格的截圖。兩個都必須是 https 直連網址，所以放在自家
    // 站台的 public/ 底下跟著部署走——不依賴任何外部服務，也不會有連結過期的問題。
    //
    // 影片送失敗（網路、LINE 端拒絕）時不能連文字說明都沒了：兩則是同一次
    // replyOrPushMessages，LINE 會整批處理；真的整批失敗，下面那行還會用 push 補一次
    // 純文字，記者至少拿得到說明。
    // ⚠️ 順序是「文字在前、影片在後」（批次 49）。回報：「先放文字再放影片，不然文字
    // 這麼多，影片早就被淹沒看不到」——完全正確。聊天室是由上往下長的，最後一則才停
    // 在畫面最下方、緊貼輸入框；影片放前面，後面那串文字會把它整個推出畫面。
    // HELP_TEXT 也同時精簡到 18 行（原本 33 行）——影片負責講完整流程，文字只留速查。
    //
    // ⚠️ quickReply 掛在**最後一則**：LINE 只顯示最後一則訊息的快速回覆，掛在文字那則
    // 會整排消失。
    const ok = await replyOrPushMessages(replyToken, userId, [
      { type: 'text', text: HELP_TEXT },
      {
        type: 'video',
        originalContentUrl: `${SITE}/mia-guide-v2.mp4`,
        previewImageUrl: `${SITE}/mia-guide-v2-cover.jpg`,
        quickReply: buildHelpQuickReply()
      }
    ]);
    if (!ok) await replyOrPush(replyToken, userId, HELP_TEXT, HOME_MENU.filter(b => b !== BTN.help));
    return;
  }

  if (metaIntent === 'industry_trend') {
    // 直接答，不用像 tech_query 那樣先問一次——這四個固定觸發詞（見 lib/menu.js
    // INDUSTRY_TREND_EXACT_RE）本身就夠明確，answerIndustryTrend() 固定抓最新
    // 清單，不需要記者再給關鍵字。
    //
    // ⚠️ 實際回報的問題：點「產業趨勢分析」這顆按鈕，AI 沒有直接摘要最新幾則，
    // 反而列了一串範例主題反問「請問您想了解哪個產業或技術領域」——跟打「最近
    // 趨勢」拿到的乾淨摘要體驗不一致。根因是原本這裡把按鈕送出的原始文字（例如
    // 「產業趨勢分析」這種比較像分類標籤、不像一句請求的名詞短語）直接當「記者的
    // 問題」丟給 AI，AI 有時會把它讀成「範圍不夠明確」而反問，不是每次都直接摘要。
    // 這四個觸發詞代表的都是同一個意圖「給我最新的產業趨勢摘要」，不像自然語言
    // 路由（routeIntent 判成 industry_trend）那條路需要保留記者原話（那邊記者可能
    // 真的在問某個特定領域）——這裡固定換成一句明確的請求句，不看按的是哪一個
    // 觸發詞，確保每次都拿到一樣乾淨的摘要，不受 AI 對「名詞短語 vs. 請求句」
    // 解讀不穩定的影響。
    await answerIndustryTrend(replyToken, userId, '最近有哪些產業趨勢重點');
    return;
  }

  if (metaIntent === 'news') {
    // ⚠️ 綁定中、而且句子沒有指向全院（「有新聞稿嗎」「給我新聞稿」「新聞稿呢」）——
    // 問的是**這一場**的新聞稿，交給這一場回答（批次 72，見 lib/menu.js
    // isOrgWideNewsAsk()）。這場答不出來時 answerQuestion() 自己會老實說還沒有、給
    // 新聞聯絡人；活動前會說正式新聞稿當天發布（邀請函模式）——都比丟一份工研院
    // 最新五則正確。批次 61 在 routeIntent() 那條路修過同一個症狀，這裡是規則層那條。
    if (binding?.event_id && !isOrgWideNewsAsk(text)) {
      const current = await getEventById(binding.event_id);
      if (isUsable(current)) {
        console.log(`[line] 綁定中問新聞稿 → 答這一場 event=${current.id} q="${text.slice(0, 40)}"`);
        await answerQuestion(replyToken, userId, current, group ? '（群組提問）' : (binding.media_name || ''), text,
          { group, memory: !group, speakerId });
        return;
      }
    }
    // 直接答，不用像 tech_query 那樣先問一次要哪個技術——記者問的就是「最近有哪些
    // 新聞」，答案是官網新聞中心的最新清單，本來就不需要關鍵字（見 answerLatestNews）。
    // 原話刻意照傳給模型（不像 industry_trend 那樣固定換成一句請求句）：這條規則接得
    // 住的句子本來就是自然語言（「最近發的新聞稿麼」），原話比替換過的句子更貼近
    // 記者實際想問的。
    await answerLatestNews(replyToken, userId, text);
    return;
  }

  if (metaIntent === 'tech_query') {
    // 跟「產業趨勢分析」不同，這裡不能直接答——「想問什麼技術」本身不是一個技術
    // 名稱，answerTechQuery() 需要記者給關鍵字才查得到東西。先問一次、記一個
    // 一次性旗標，下一則不管記者打什麼都當成技術名稱去查，見 handleTechQueryMessage()。
    await setContactPending(userId, pendingNoteFor(TECH_QUERY_PENDING_NOTE, userId, speakerId));
    // 批次 84：原本這則一顆按鈕都沒有（1 對 1），記者得自己想要打什麼。例句直接做成按鈕，
    // 送出的是「工研院 ＸＸ」這個固定格式——群組裡別人按也認得（isOwnButtonText() 的
    // CROSS_TOPIC_TECH_RE），不會因為旗標綁在發問者身上就按了沒反應。
    await replyOrPush(replyToken, userId,
      '請問您想了解工研院哪一項技術呢？直接輸入技術名稱即可，例如：機器人、半導體封裝、AI 晶片。',
      [...TECH_EXAMPLE_BUTTONS, BTN.home, BTN.events, BTN.trend, BTN.contact, BTN.human]);
    return;
  }

  if (metaIntent === 'org_intro') {
    // 直接答，不呼叫模型——院長／董事長姓名寫錯是「絕對不能發生」等級的事（跟批次 3
    // 的一整套坑同一個形狀），見 lib/menu.js ORG_INTRO_TEXT 的說明。附上整套入口
    // 按鈕，記者問完機構簡介不會卡在死巷子裡，跟 sendFallbackGuide() 同一個道理。
    await replyOrPush(replyToken, userId, ORG_INTRO_TEXT,
      HOME_MENU);
    return;
  }

  // ── 批次 81：「我要找真人」——米亞是幫手，不是取代真人（見 lib/menu.js isHumanRequest()）──
  if (metaIntent === 'human') {
    await sendHumanContact(replyToken, userId, text, binding, { speakerId, group });
    return;
  }

  if (metaIntent === 'contacts') {
    // 邀訪窗口分兩層：先看這場活動自己有沒有設定專屬窗口（events!P，同仁在後台
    // 針對這一場填的），有就照舊給精準的那組；這場沒設定（或根本還沒綁定任何
    // 活動）就退到跨活動的全域技術窗口清單（見 sendGlobalContactMenu()）——
    // 不管有沒有綁定活動都拿得到，不會再卡在「請先告訴我您想問哪一場」。
    const current = binding ? await getEventById(binding.event_id) : null;
    if (isUsable(current)) {
      const contacts = parseEventContacts(current);
      if (contacts.length) {
        await replyOrPush(replyToken, userId,
          `《${current.name}》的邀訪聯絡窗口：\n請選擇想聯絡的主題，或直接打關鍵字。`,
          contacts.map(c => c.keyword));
        return;
      }
      if (current.press_contact) {
        await replyOrPush(replyToken, userId,
          `《${current.name}》的新聞聯絡人：\n${current.press_contact}`, eventQuickChips(current, { group }));
        return;
      }
      // 這場活動兩個都沒設定 → 往下退到全域技術窗口清單，比什麼都拿不到好。
    }
    await sendGlobalContactMenu(replyToken, userId);
    return;
  }

  // 媒體報名（批次 88，見 lib/registration.js）。固定程式回覆、不呼叫模型：報名入口答偏一次，
  // 就是少一位記者。
  if (metaIntent === 'register') {
    await handleRegisterIntent(replyToken, userId, { group, staff });
    return;
  }

  const cards = buildCalendarCards(await getAllEventRows());

  if (metaIntent === 'switch') {
    // 真的解除綁定，不只是回一句提示：記者說「回首頁」之後打的下一句多半是新場次
    // 的名稱，留著舊綁定的話那句會先被當成對舊場次的提問。
    if (binding) await clearBinding(userId);
    // 回報的意見：這顆按鈕原本叫「換一場活動」，回覆也只提活動——但這個帳號能問的
    // 不只活動，也能問產業趨勢、工研院技術。回覆順手點出這兩個入口，不是只列活動
    // 清單，記者才看得出來「回首頁」是回到全部功能，不是單純換一場活動。
    await replyOrPush(replyToken, userId,
      `好的，已經回到首頁。\n\n請直接輸入想問的活動名稱，或從下面挑一場；也可以打「產業趨勢分析」「想問什麼技術」問其他問題。\n\n${formatCalendarReply(cards)}${CONTACT_MENU_TEXT_HINT}`,
      calendarQuickRepliesForReporter(cards));
    return;
  }

  // calendar：只列清單，不解除綁定——記者多半只是想看看有什麼，看完還會繼續問
  // 原本那場。真的要換，按下清單的按鈕（送出的就是完整活動名稱）會走
  // matchEventByName() 自動切過去，不需要他先「離開」再「進入」。
  await sendCalendarReply(replyToken, userId, cards, binding ? await getEventById(binding.event_id) : null);
}

// 「近期活動」那則回覆的唯一出口（批次 57）。原本只有 handleMetaIntent() 的 calendar
// 分支長這樣；抽出來是因為現在有三個呼叫端（固定規則命中、1 對 1 綁定中被 AI 判成
// calendar、群組綁定中被 AI 判成 calendar），三邊必須長得一模一樣——記者不該從
// 「怎麼問到的」看得出差別。
async function noteCalendarShown(targetId) {
  await setRecentTopic(targetId, 'calendar', { keepTurn: true });
}

export async function sendCalendarReply(replyToken, targetId, cards, currentEvent) {
  const suffix = isUsable(currentEvent)
    ? `\n\n（您目前在問的是《${currentEvent.name}》，直接發問就會回答這一場；想換場點下面的按鈕即可。）`
    : '';
  await replyOrPush(replyToken, targetId,
    formatCalendarReply(cards) + suffix + CONTACT_MENU_TEXT_HINT,
    calendarQuickRepliesForReporter(cards));
  await noteCalendarShown(targetId);
}

// 沒有有效綁定時的自然語言處理（批次 3）：讓路由判斷這是查活動列表、問特定一場、
// 還是無關問題。路由失敗或判不出來，一律退回批次 2 原本的引導文案，不會卡住、
// 也不會誤觸問答。
//
// silentOnOther：群組的「免 @ 續問視窗」（見 handleGroupEvent）在用，判不出來要
// 問哪一場時，1 對 1 給引導文案是體貼，群組裡沒被直接 @ 又給同一句引導文案就是
// 插話——這種情況安靜比較安全，等真的被 @ 到再回。1 對 1 呼叫端不傳這個參數，
// 維持原本一定會給引導文案的行為。
//
// askMediaName：回報的意見——用打活動名稱軟綁定（這支）的記者從頭到尾沒被問過
// 媒體名稱，跟 #代碼 QR 掃碼綁定（有 ask_name 一次性擷取視窗）不一樣，後台的問答
// 分析永遠看到「（未填寫）」，沒辦法統計哪些媒體來過。群組不能問——一個群組裡有
// 多個不同媒體的人，「貴媒體名稱」這句話對群組沒有意義，group 呼叫端傳 false。
//
// remember（批次 28）：軟綁定命中、直接答一題時要不要開 1 對 1 的對話記憶（I 欄）。
// 群組傳 false——群組是照發問的人各記各的（speakerId → J 欄，批次 83，見 setGroupTurn()）。
export async function handleUnbound(replyToken, userId, text, { silentOnOther = false, askMediaName = true, remember = true, staff = false, speakerId = '' } = {}) {
  const rows = await getAllEventRows();
  const cards = buildCalendarCards(rows);
  // 上一則剛回答完的是不是產業趨勢／工研院技術題——沒有這個提示，記者接著打的
  // 追問（尤其是「太空」這種裸名詞）在 routeIntent() 眼裡跟純聊天沒兩樣，見
  // getRecentTopic() 開頭那段回報的截圖。讀的是 getBinding() 早就載入的那份 60 秒
  // 快取，不會多打一次 Sheets。
  const topicCtx = await recentTopicContext(userId);

  // 剛看完活動清單、接著點名清單上的某一場（批次 101）：「院士」原本被當成裸主題詞，
  // 回「產業趨勢還是工研院技術」——米亞明明剛剛才列出「院士授證典禮」。規則層先接，
  // 不等模型判斷。只有比中清單上的場次才接；比不中就照原流程。
  if (topicCtx.currentTopic === 'calendar') {
    const hit = matchShownEvents(cards, text);
    if (hit.length === 1) {
      const event = await getEventById(hit[0].id);
      if (isUsable(event)) {
        await upsertBinding(userId, event.id);
        const existingName = askMediaName ? await getStoredMediaName(userId) : '';
        await answerQuestion(replyToken, userId, event, existingName, `${event.name}的重點資訊`, { memory: remember, speakerId });
        if (askMediaName && !existingName) await askMediaNameLater(userId, event);
        return;
      }
    } else if (hit.length > 1) {
      const names = hit.slice(0, 5).map(c => c.name);
      await replyOrPush(replyToken, userId,
        `清單裡有幾場跟「${String(text).trim()}」有關，您是想問哪一場？\n${names.map(n => '・' + n).join('\n')}`,
        names);
      return;
    }
  }
  // 整句只是在要完整新聞稿（選單「新聞稿全文」）：規則先接，不等模型（批次 115，見 FULL_TEXT_ASK_EXACT_RE）。
  // silentOnOther（群組裡沒被叫到）照舊不開口。
  if (!silentOnOther && isFullTextAsk(text) && await sendFullTextPicker(replyToken, userId, cards)) return;

  // groupChatter（批次 83）：群組裡沒被叫到的訊息，提醒路由「群組成員彼此也在聊天」——
  // silentOnOther 為 true 的情況正好就是這種（見 lib/router.js 的說明）。
  const { intent, event_ids, confidence, tech_keyword } = await routeIntent(text, cards, { ...topicCtx, groupChatter: silentOnOther });
  console.log(`[line] reporter route q="${text.slice(0, 60)}" → intent=${intent} event_ids=${JSON.stringify(event_ids)} confidence=${confidence} topic=${topicCtx.currentTopic || '-'}`);

  if (intent === 'calendar') {
    await replyOrPush(replyToken, userId, formatCalendarReply(cards) + CONTACT_MENU_TEXT_HINT, calendarQuickRepliesForReporter(cards));
    await noteCalendarShown(userId);
    return;
  }

  if (intent === 'industry_trend') {
    // 不做軟綁定——這題跟任何一場活動都無關，沒有「場次」可以綁。
    await answerIndustryTrend(replyToken, userId, text);
    return;
  }

  if (intent === 'tech_query') {
    // 記者直接問「工研院在ＸＸ技術上有什麼進展」這種完整句子，不用先問一次要查
    // 什麼——但不能把整句原話直接丟給工研院官網的關鍵字搜尋：實測那邊接近精準
    // 比對，整句話（含「最近」「有什麼新聞」「嗎」這類語助詞）常常查不到任何
    // 結果，只有抽出來的核心關鍵字查得到（見 LINE-PLAN.md 批次 22 的說明）。
    // routeIntent() 判成 tech_query 時會順手抽一個關鍵字，優先用那個；抽不出來
    // （空字串）才退回整句原話，總比完全不查好。
    await answerTechQuery(replyToken, userId, tech_keyword || text);
    return;
  }

  if (intent === 'qa' && event_ids.length === 1 && confidence === 'high') {
    const event = await getEventById(event_ids[0]);
    if (isUsable(event)) {
      // 路由命中就順手軟綁定——下一題不用再重打一次活動名稱，也能重複利用
      // 6 小時 TTL 那套過期機制，不用另外維護一套「路由記憶」。
      await upsertBinding(userId, event.id);
      // 媒體名稱是跟著這個人走的（見 getStoredMediaName 的說明），不是這場才有——
      // 之前來問過別場、報過名字或按過略過的人，這裡沿用，不用再問一次。
      const existingName = askMediaName ? await getStoredMediaName(userId) : '';
      await answerQuestion(replyToken, userId, event, existingName, text, { memory: remember, speakerId });
      // 只在「這個人從沒被問過」時才順手問一次，而且不擋住剛剛的答案——用 push
      // 補問，記者不用先回答完媒體名稱才拿得到他真正想要的內容。
      if (askMediaName && !existingName) await askMediaNameLater(userId, event);
      return;
    }
  }

  // 要的是「某一場的完整新聞稿」，但沒講哪一場、目前也沒在問哪一場（批次 85）。以前掉到兜底
  // 「這句我不太確定該從哪邊幫您找答案」——其實我們很清楚他要什麼，只是不知道哪一場。
  // 反問一次，每一場一顆按鈕，按下去直接給那一場（見 FULL_TEXT_PICK_RE）。
  if (!silentOnOther && GROUP_FULL_TEXT_RE.test(text) && await sendFullTextPicker(replyToken, userId, cards, event_ids)) return;

  if (intent === 'qa' && event_ids.length > 0) {
    const names = event_ids.map(id => cards.find(c => c.id === id)?.name).filter(Boolean).slice(0, 3);
    if (names.length) {
      await replyOrPush(replyToken, userId,
        `您是想問這幾場的哪一場呢？\n${names.map(n => '・' + n).join('\n')}\n\n請直接打完整或部分活動名稱。`,
        names);
      return;
    }
  }

  // intent === 'other'，或 qa 但完全比對不到、或路由本身失敗。
  if (silentOnOther) return; // 群組裡沒被直接 @、又猜不到問題在問什麼 → 安靜，不要沒事跳出來說「不確定」

  await sendFallbackGuide(replyToken, userId, text, { staff });
}
// 任何 routeIntent() 判不出來的訊息最後都會走到這裡（1 對 1 的 handleUnbound()、
// 以及綁定中但連目前這場都接不上的情況）。
//
// ⚠️ 回報的截圖就是這句話造成的：記者問完產業趨勢、照著我們自己回覆裡的邀請打了
// 「太空」，收到的是「嗯～我沒抓到您想問哪一場活動耶」——他從頭到尾沒有在問活動。
// 舊文案把「猜不出來」一律講成「猜不出是哪一場活動」，等於每次猜錯都額外多答非所問
// 一次。這裡改成兩件事：
//   ① 措辭不再假設記者一定是在問活動（這個帳號有四條路，活動只是其中一條）
//   ② 看起來像主題詞的訊息，直接複誦回去給兩條真的走得通的路，不要叫記者自己猜
// 話題記憶（getRecentTopic）是第一道防線，但它有 10 分鐘 TTL、也可能是記者一進來
// 就直接打一個詞——這支是那道防線之外的第二層，兩層都不依賴對方。
// 固定兜底文案——智慧兜底（composeFallbackReply）組不出來時的保底。這份永遠不會
// 出錯、也永遠不會講錯話，是這條路徑的安全底線，不要因為有了智慧兜底就拿掉。
const FALLBACK_GUIDE_TEXT = [
  '嗯～這句我不太確定該從哪邊幫您找答案 🤔 這幾件事我都能查：',
  '・某一場記者會的內容 → 直接打活動名稱，或問我「最近有哪些活動」',
  '・產業趨勢 → 打「產業趨勢分析」，或直接問我某個領域的趨勢',
  '・工研院的技術 → 打「工研院」加技術名稱，例如「工研院 太空」',
  '・想找採訪窗口 → 打「媒體邀訪需求」'
].join('\n');

// ── 智慧兜底（批次 28）───────────────────────────────────────────────────
// 回報的意見：「回答不要答非所問」「希望能回答各種問題」。批次 26／27 兩次回報其實
// 都指向同一件事——記者問了一句我們四條資料來源都對不上的話，收到的是一份**跟他
// 那句話完全無關的功能選單**。選單本身沒寫錯，但對「請問可以申請採訪證嗎」「你們
// 上次那個發表會在哪裡辦」這種問句來說，貼一份四條路的清單就是答非所問：它沒有
// 表現出「我聽懂你在問什麼」，只是把說明書再念一次。
//
// 這支用一次 Haiku 呼叫，讓米亞針對「記者這一句」講一段真的貼題的話：先讓他知道
// 我聽懂了、老實說這個我這邊查不到，再指到真的走得通的那一條路。
//
// ⚠️ 這支**不回答問題本身**，這是它跟「讓 AI 自由發揮」的根本差別，也是它敢上線的
// 唯一理由：這個帳號掛著主辦單位名義、記者可能直接截圖引用，沒有資料來源就生成
// 事實內容是這整份規格從第一天就禁止的事（LINE-PLAN.md 第 3 節）。system prompt
// 把「不要提供任何事實內容」寫成最硬的一條，輸出再過一次長度／格式守門，出任何
// 差錯都退回上面那份固定文案。
//
// 成本只發生在兜底這條路（四條路都對不上才會走到），不是每則提問都多一次呼叫。
const FALLBACK_MAX_LEN = 300;

async function composeFallbackReply(text) {
  const question = sanitize(text, 300);
  if (!question) return '';
  const systemPrompt = [
    '你是工研院 LINE 官方帳號的 AI 新聞助理，名字叫「米亞」，現在的角色是「兜底引導員」。',
    '記者剛剛傳來一句話，我們四種資料來源（某一場記者會的內容、IEK 產業情報網的產業趨勢、工研院官網新聞中心的技術報導、媒體邀訪窗口名單）都比對不到可以回答它的資料。',
    '',
    '你這次的任務**不是回答那個問題**，而是：',
    '① 用一句話讓記者知道你聽懂了他想問什麼（用他自己的話複述，不要照抄整句）。',
    '② 老實說這個我這邊查不到，或這不是這個帳號查得到的東西。',
    '③ 從上面四條路裡挑出**最接近**他這個問題的一到兩條，具體告訴他該打什麼字。真的一條都不沾邊（例如問天氣、閒聊、數學題），就直接說這裡只服務工研院的活動與技術採訪需求，並簡短點出這四條路，不要硬拗成某一條。',
    '',
    '絕對禁止（這幾條比上面的任務更優先）：',
    '- 不要提供任何事實內容：不要講數字、日期、人名、地點、技術細節、活動內容、聯絡方式，一個字都不要。你手上沒有任何資料，講出來的都是編的。',
    '- 不要假裝查過、不要說「根據我查到的」。',
    '- 不要承諾你做不到的事：不能說幫忙轉接、稍後回覆、代為查詢、幫他問同事。',
    '- 不要重複貼整份功能選單當作回答（那正是這次要修掉的答非所問）。',
    '- 不要用 Markdown 語法（LINE 不會渲染）。',
    '',
    '格式：3 行以內，總長度不超過 120 個字。不要加結尾警語（這則沒有引用任何資料，不需要）。',
    TONE_RULE
  ].join('\n');

  const reply = String(await askAnthropic(systemPrompt, question) || '').trim();
  // 守門：askAnthropic() 失敗時回的是它自己那幾句「抱歉，目前無法取得回應」，那句話
  // 拿來當兜底比固定文案還糟（記者會以為系統壞了，其實只是沒對上資料）；太長、或
  // 混進 Markdown 的輸出也一律不要，退回固定文案。
  if (!reply) return '';
  if (reply.length > FALLBACK_MAX_LEN) return '';
  if (/抱歉，目前無法取得回應|系統目前無法回答|無法取得回應/.test(reply)) return '';
  // 批次 32 起不用在這裡擋 Markdown：askAnthropic() 的出口已經統一清過一次
  // （見 stripMarkdownForLine()），四條問答路線都受惠，不需要兜底自己再擋一次。
  return reply;
}

// staff（職員模式借道這條路時，見 handleStaffMessage 結尾）：底下的按鈕要換成職員
// 那組，並且補一句「這裡是職員模式」——同仁在職員模式裡拿到一整排記者按鈕會以為
// 自己被踢出去了。
async function sendFallbackGuide(replyToken, targetId, text, { staff = false } = {}) {
  const chips = staff ? STAFF_QUICK_REPLIES : HOME_MENU;
  // 批次 81：每一條兜底都要留一條通往真人的路（世新事件的教訓：AI 答不出來又找不到人）。
  // 寫死在程式裡接在最後，不交給模型——兜底那支本來就禁止模型講聯絡方式。
  const staffTail = staff ? '\n\n（您在職員模式，打「使用說明」可以看內部功能。）' : '';
  const deadEndTail = staff ? staffTail : '\n\n（想直接找人，打「找真人」。）';

  // 天氣／告白／問個性這種閒聊：不呼叫 Haiku，直接送寫死的俏皮話（見上方
  // CHITCHAT_FIXED_REPLIES 的說明）。放在 looksLikeBareTopic 之前，因為裸主題詞判斷
  // 同樣會誤收「天氣」兩個字。
  // 收尾語：記者端早在 detectMetaIntent() 就攔下了，會走到這裡的是職員模式借道
  // （職員那邊不經過 handleMetaIntent() 的這個分支）。
  const courtesy = detectCourtesy(text);
  if (courtesy) {
    await replyOrPush(replyToken, targetId, COURTESY_REPLIES[courtesy] + staffTail, chips);
    return;
  }
  const chitchat = detectChitchat(text);
  if (chitchat) {
    await replyOrPush(replyToken, targetId, CHITCHAT_FIXED_REPLIES[chitchat] + staffTail, chips);
    return;
  }

  if (looksLikeBareTopic(text)) {
    const kw = String(text).trim();
    await replyOrPush(replyToken, targetId,
      `「${kw}」我可以從兩個方向幫您找 🙂\n・整體產業趨勢（IEK 產業情報網的免費焦點）\n・工研院自己在這方面的技術與發表\n想看哪一種？點下面的按鈕就可以。`,
      [
        { label: `${kw}的產業趨勢`, text: `${kw}產業趨勢` },
        { label: `工研院的${kw}技術`, text: `工研院 ${kw}` },
        ...(staff ? ['最近有哪些新聞', '使用說明'] : [BTN.events, BTN.contact, BTN.human])
      ]);
    return;
  }

  // 先試著用米亞的口吻，針對記者「這一句」講一段真的貼題的話（見
  // composeFallbackReply()）；組不出來就退回下面這份固定文案。
  const smart = await composeFallbackReply(text);
  await replyOrPush(replyToken, targetId, (smart || FALLBACK_GUIDE_TEXT) + deadEndTail, chips);
}
async function logQa(event, mediaName, question, reply) {
  if (!process.env.GOOGLE_SPREADSHEET_ID) return;
  try {
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    // H 欄 source=line，G 欄（刪除旗標）補空字串佔位——跟 api/chat.js 用同一張表、
    // 同一個欄位順序，兩邊沒對齊的話後台會把資料判成已刪除。
    await appendRows('qa_log!A:H', [[
      timestamp, event.id, event.name, mediaName || '（未填寫）',
      sanitize(question, 2000), reply, '', 'line'
    ]]);
    console.log(`[line] qa_log 寫入成功 event=${event.id}`);
  } catch (e) {
    console.error('LINE qa_log 寫入失敗:', e.message);
  }
}
