// 米亞（LINE）的群組：預設安靜、被 @ 或叫「米亞」才回答、免 @ 的續問視窗與它的守門。
//
// 批次 117 從 api/line.js 搬出來，程式與註解原封不動（只在別的檔案要用的宣告前面加了 export）。

import { isBotMentioned, stripMentionText } from './line.js';
import { buildCalendarCards, routeIntent, matchShownEvents } from './router.js';
import { isHumanRequest, isEventTopicAsk, isExactMetaAsk, matchEventByName, MENU_WORDS } from './menu.js';
import { effectiveChips } from './default-chips.js';
import { CHITCHAT_FIXED_REPLIES, detectBoundChitchat, looksLikeBareTopic, nonTextReply } from './line-chitchat.js';
import {
  getAllEventRows, getBinding, getEventById, getGroupSessionUntil, getRecentTopic, getStoredEventId,
  getStoredNote, isUsable, recentTopicContext, rowToEvent, touchGroupSession, upsertBinding
} from './line-store.js';
import {
  CONTACT_MENU_LABEL, DEFAULT_CHIPS, HOME_MENU, NAV_HEAD, NAV_TAIL, eventContentChips, eventQuickChips,
  rateLimited, replyOrPush
} from './line-runtime.js';
import { pinGenericTechQueryToEvent } from './line-nodata.js';
import { resolveMetaIntent } from './line-register.js';
import {
  CONTACT_PENDING_NOTE, FULL_TEXT_PICK_RE, TECH_QUERY_PENDING_NOTE, answerIndustryTrend, answerQuestion,
  answerTechQuery, fullTextPickEvent, handleContactTopicMessage, handleMetaIntent, handleTechQueryMessage,
  handleUnbound, isFullTextAsk, parseEventContacts, parsePendingNote, pendingBelongsTo, sendCalendarReply
} from './line-reporter.js';

// ── 群組續問視窗的「這句話是在跟我講嗎」守門（批次 28）─────────────────────
// 回報的意見：「被拉進群組時，回答不要答非所問，而且不會亂回」。
//
// 現況的破口不是「被 @ 到之後答錯」，是**免 @ 續問視窗那 5 分鐘之內**：只要視窗還
// 開著，群組裡任何人講的任何一句話都會被送進整條處理鏈，而鏈上前面幾段（固定選單
// 意圖 detectMetaIntent、邀訪主題旗標、技術名稱旗標）根本不看「有沒有被 @」，後面
// 的路由也只有 intent==='other' 這一道安靜門檻。實際後果：
//   - 群組在聊「那個案子還有什麼活動要辦」→ 命中 CALENDAR_RE → 機器人跳出來貼一份
//     活動清單，沒有人在問它
//   - 群組在聊「台積電最近怎樣」→ 路由判成 industry_trend → 機器人開始講 IEK 趨勢
//   - 有人講「換一場」（在講別的事）→ 命中 SWITCH_RE → 機器人把整個群組的綁定清掉
// 這幾種都不是 other，現有的安靜門檻完全擋不住。
//
// 這支是視窗內「先問一句：這像是在跟我講話嗎」的統一守門，放在所有分支之前，
// 只在**沒有被 @** 時生效（真的 @ 到就一定要理人，跟批次 14／16 同一個原則）。
// 判準刻意全部是字面特徵、不呼叫 AI：群組裡「每一則」訊息都會過這支（包含我們最後
// 根本不會回的閒聊），花錢或多打一次 API 都不划算，理由跟 getGroupSessionUntil()
// 那段「不能直讀 Sheets」完全一樣。
//
// 放行的幾類，每一類都對應一個「不放行就會壞掉」的真實路徑：
//   ⓪ 我們剛問完一句、正在等這個人回答（一次性旗標還開著）——那則答案本身多半是
//      一個沒有問號的名詞，擋掉等於自己問了又不聽
//   ① 我們自己送出的按鈕文字（固定選單詞、邀訪主題、活動名稱、「工研院 ＸＸ」）——
//      群組裡按鈕送出的是不帶 @ 的純文字，擋掉就等於按鈕按了沒反應
//   ② 看起來就是一句提問（問號、疑問詞、句尾語助詞）——記者真的在問我們
//   ③ 剛回答完趨勢／技術題（話題記憶還在）時的裸名詞追問——那是我們自己邀請他打的
//   ④ 其餘一律安靜。陳述句、閒聊、跟別人的對話都落在這裡
//
// ⚠️ 這道守門是「加」在既有門檻之前，不是取代：放行之後，原本的「@ 到別人」否決、
// routeIntent() 判成 other 就安靜，全部照舊生效。寧可漏放（記者多打一個問號或重新
// @ 一次）也不要誤放——誤放一次就是在別人的群組裡插一段沒人要的話。
const GROUP_QUESTION_RE = /[?？]|如何|怎麼|怎麽|怎么|怎樣|什麼|甚麼|什么|為何|為什麼|哪些|哪一|哪裡|哪邊|誰|嗎|多少|幾點|幾號|有沒有|請問|想問|想知道|想了解|介紹一下|說明一下|給我|請給|麻煩|幫我|提供|可以嗎|(呢|吧)[?？!！～~。]?$/;

// ⚠️ 上面那條**整條都是中文**——這個帳號本來就支援英文提問（lib/prompt.js 有一條很強
// 的「跟著記者這一則提問的語言回答」規則），但群組守門完全沒有英文的判斷，結果是
// 英文訊息只要沒有 @ 就一律被安靜擋掉。實測回報：群組裡打
// 「Please reply in English.」完全沒反應——句號結尾、沒有問號、沒有任何中文疑問詞，
// 三道規則全部落空。外籍記者在群組裡等於完全問不到東西。
//
// 收的範圍跟中文那條對齊（同樣偏寬鬆）：疑問詞／助動詞開頭，或句子裡有 please。
// 過寬不是問題——守門只是第一層，後面 routeIntent() 判成 other 一樣會安靜。
const GROUP_QUESTION_EN_RE = /^\s*(what|when|where|who|whom|whose|why|how|which|can|could|would|will|shall|should|do|does|did|is|are|was|were|any|tell|show|give|send|need|want|may|might|let|help|hi|hello|hey)\b|\bplease\b/i;

// 我們自己在群組裡送出過的固定按鈕文字，這裡沒辦法用 detectMetaIntent() 涵蓋的那幾顆。
// 「工研院 ＸＸ」是 sendFallbackGuide()／answerIndustryTrend() 的導流按鈕送出的格式。
// 兩顆「導流按鈕」的精確形狀。批次 32 把它們排除在視窗外的放行之外，理由是「只能靠
// 前綴比對、日常對話會誤中」——但那等於我自己違反了同一批訂下的規則（**只要是我們
// 自己放到按鈕上的字，就一定按得動**），而回報又來了一次「點下面小按鈕沒有反應」。
//
// 改成比對**完整形狀**而不是前綴，就不必再破例：
//   `工研院 ＸＸ`   → 產生處見 answerIndustryTrend()／sendFallbackGuide() 的 crossItem
//   `ＸＸ產業趨勢`  → 產生處見 answerTechQuery()／sendFallbackGuide() 的 crossItem
// ⚠️ 那個**空白**是關鍵的辨別點：中文使用者自然書寫時不會在「工研院」後面空一格
// （會寫「工研院那邊怎麼說」），而我們的按鈕一定有。加上「後面只能是 2-8 個乾淨的
// 字、而且到此為止」，誤中的機會很低；真的誤中，結果也只是查一次官網回「沒找到」，
// 不是什麼危險的事。
const CROSS_TOPIC_TECH_RE = /^工研院[ 　][一-鿿A-Za-z0-9]{2,8}$/;
const CROSS_TOPIC_TREND_RE = /^[一-鿿A-Za-z0-9]{2,8}產業趨勢$/;
const GROUP_OWN_BUTTON_RE = /^工研院[\s　]|^邀訪[:：]/;

// ⚠️ 這裡刻意**不**用 detectMetaIntent() 當放行條件，即使它就是「這是不是固定選單
// 意圖」的權威判斷：那支裡面的 CALENDAR_RE／SWITCH_RE 是寬鬆的**片語**比對（不是
// 整句完全相同），本來就設計成「記者怎麼講都接得住」——在 1 對 1 那是體貼，在群組
// 就是誤判來源。實測會中的日常對話：
//   「那個案子後面還有活動要辦」→ 命中 CALENDAR_RE → 機器人貼一份活動清單
//   「這邊先換一場再說」        → 命中 SWITCH_RE   → 機器人把整個群組的綁定清掉
// 兩句都沒有人在跟機器人講話。所以這裡只認**整句完全等於**我們自己送出過的按鈕
// 文字；記者真的想問活動清單時講的「最近有哪些活動」「有什麼活動嗎」本來就帶疑問詞，
// 會走下面 GROUP_QUESTION_RE 那條，不需要靠這一條放行。
// ── 喚醒詞：叫得動機器人的第二種方式（批次 30）────────────────────────────
// 實測回報（附截圖）：同事在群組裡想 @ 這個帳號，**LINE 的 @ 選單裡根本找不到它**
// ——選單只列出真人成員。對他來說「只有被 @ 到才會說話」這條規矩不是有點麻煩，
// 是完全叫不動：他沒有任何辦法把訊息送到機器人面前。
//
// 官方帳號會不會出現在 @ 選單，是 LINE 那邊決定的（跟 app 版本、帳號設定有關），
// 我們的程式改不了。與其賭它會不會出現，不如**多給一條不依賴 @ 的呼叫方式**：
// 訊息開頭打「米亞」就等同 @ 到我們。
//
// ⚠️ 只認**開頭**，不是整句話裡出現「米亞」就算。群組裡談論這個帳號（「米亞剛剛
// 說的那個」「等等問米亞」）跟呼叫它是兩回事，中間出現不該觸發——這條界線就是
// 「亂回」與「叫得動」之間的平衡點。
// 後面允許接標點或空白（「米亞，最近有哪些活動」「米亞 你好」），也允許有人手打
// 一個 @（打了 @ 但選單裡選不到，最後送出的是純文字，正是回報的那個情境）。
export const WAKE_WORD_RE = /^\s*[@＠]?\s*米亞\s*[，,、。：:！!？?～~\-—]*\s*/;

// 把開頭的喚醒詞切掉，只留真正的問題。沒有喚醒詞就原樣回傳。
function stripWakeWord(text) {
  return String(text || '').replace(WAKE_WORD_RE, '').trim();
}

// 整句話是不是「我們自己送出去的那顆按鈕」——或者我們正在等這個人回答。
//
// ⚠️ 批次 30 第一版只認固定選單詞與「邀訪：ＸＸ」，實測回報又踩到同一個坑：同事按了
// 「半導體相關乾淨帶畫面提供」完全沒反應——那是**邀訪窗口關鍵字**按鈕，而那種按鈕送出
// 的是**原始關鍵字**（見 handleMetaIntent() 的 contacts 分支：`contacts.map(c => c.keyword)`，
// 沒有「邀訪：」前綴），同仁在後台自訂的快速提問 chips 也一樣是原始文字。兩種都沒被
// 涵蓋到，於是「按鈕按了沒反應」換個按鈕又發生一次。
//
// 規則收斂成一句話：**只要是我們自己放到按鈕上的字，就一定按得動**，不分視窗內外。
// 這比「哪幾種按鈕算數」的清單好記，也不會再有下一顆漏掉的按鈕。
//
// 唯二不放進來的是 `工研院 ＸＸ` 與 `ＸＸ產業趨勢` 這兩顆導流按鈕：它們是用關鍵字
// 拼出來的，比對只能靠前綴／後綴而不是完全相同，「工研院 那邊怎麼說」這種日常對話會
// 誤中。它們永遠出現在一則剛送出的答案底下，視窗本來就是開的，不需要靠這條放行。
async function isOwnButtonText(groupId, text, speakerId) {
  const s = String(text || '').trim();
  if (!s) return false;

  // 我們剛問完一句、正在等這個人回答（「請問您想了解工研院哪一項技術呢？」）——
  // 那則答案本身多半是個沒有問號的名詞，跟按鈕同一種性質：問了就要聽。
  const rawPending = await getStoredNote(groupId);
  const { note: pendingNote } = parsePendingNote(rawPending);
  if ((pendingNote === TECH_QUERY_PENDING_NOTE || pendingNote === CONTACT_PENDING_NOTE) &&
      pendingBelongsTo(rawPending, speakerId)) return true;

  if (GROUP_FIXED_BUTTONS.has(s)) return true;      // 固定選單詞
  if (/^邀訪[:：]/.test(s)) return true;             // 全域邀訪主題（機器產生的格式）
  if (FULL_TEXT_PICK_RE.test(s)) return true;         // 「要哪一場的完整新聞稿」那排（批次 85）
  // 兩顆導流按鈕——見 CROSS_TOPIC_*_RE 的說明。批次 34 補上，不再破例。
  if (CROSS_TOPIC_TECH_RE.test(s) || CROSS_TOPIC_TREND_RE.test(s)) return true;

  // 活動清單按鈕送出的是活動全名（matchEventByName 自己有「正規化後至少 6 個字、
  // 要唯一命中」的門檻，見 lib/menu.js，不會被一個短詞誤中）。
  if (matchEventByName(s, buildCalendarCards(await getAllEventRows()))) return true;

  // 同仁在後台設定的快速提問 chips 與邀訪窗口關鍵字（或沒設定時的 DEFAULT_CHIPS）——
  // 內容是同仁自由填的，沒辦法寫死在上面那個集合裡，但它們確確實實是我們送出去的按鈕。
  return !!(await ownChipEventId(groupId, s));
}

// 這則訊息是不是「某一場的快速提問按鈕／邀訪窗口關鍵字」；是的話回傳
// { eventId }（eventId 可能是空字串＝認得這顆按鈕，但推不出是哪一場），不是回 null。
//
// ⚠️ 這支刻意「不」呼叫 getBinding()。實測回報：群組裡的按鈕列停在下午 6:55 那則
// 訊息上，同事晚上 8:58 才滑回去點「這次活動的主要發表內容是什麼？」——完全沒反應。
// 原本的寫法是「拿目前綁定的那場，比對它的 chips」，兩個地方會落空：
//   ① 活動綁定有 6 小時 TTL，過了就 getBinding() → null，於是連比對都沒得比。
//      但 TTL 過期只代表「不知道現在該問哪一場」，不代表「這句話從來不是我們的
//      按鈕」——跟 getStoredMediaName()／getStoredNote() 不吃 TTL 是同一個道理。
//   ② 就算綁定還在，中途換過場的話，舊訊息上的按鈕屬於**上一場**，跟現在綁的那場
//      對不起來，一樣會被判成「不是我們的按鈕」。
// LINE 的快速回覆按鈕會永遠留在對話紀錄裡，「隔幾小時往上滑再點」是常態不是例外，
// 所以比對範圍要放大到「所有我們可能送出去的 chips」，再回推是哪一場。
async function ownChipEventId(groupId, text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const storedId = await getStoredEventId(groupId);

  // ① 這個群組上次綁的那場（不看 TTL）有這顆 → 就是那場，最準；DEFAULT_CHIPS 這種
  //    每場共用的按鈕也靠這一步分辨得出來。
  const stored = storedId ? await getEventById(storedId) : null;
  if (isUsable(stored) &&
      (eventContentChips(stored).includes(s) || parseEventContacts(stored).some(c => c.keyword === s))) {
    return { eventId: storedId };
  }

  // ② 同仁自己填的字（自訂 chips／活動前 chips／邀訪關鍵字）幾乎不會跟別場撞在一起，
  //    唯一命中就當作是那一場——這條讓「換過場之後點舊按鈕」也能回到正確的場次。
  //
  //    ⚠️ 這條是刻意選的取捨，不是沒想到：它同時把「別場的短 chip」（quad 的
  //    「重點」「應用」）也放進守門，於是群組裡有人單獨打一句「重點」也會被當成
  //    按鈕。判斷是整句**完全相同**才算，而且要剛好等於某場設定過的字，誤觸機率
  //    不高；反過來若限制成「只認目前這場的」，換過場之後點舊按鈕就會再度沉默——
  //    那正是回報的問題本身。按鈕不動的代價比偶爾多答一句大得多，所以往這邊靠。
  // 批次 104：預設快速提問改成「依知識庫算」之後，每場的按鈕不一樣，這裡也要拿同一支算出來的結果
  // 比對（只有某一場有的題目，例如「得獎名單有哪些？」，唯一命中就能回推是哪一場）。
  const customOf = ev => [
    ...String(ev.chips || '').split('\n'),
    ...String(ev.invite_letter_chips || '').split('\n'),
    ...effectiveChips(ev)
  ].map(x => x.trim()).filter(Boolean);
  const owners = (await getAllEventRows()).map(rowToEvent).filter(isUsable)
    .filter(ev => customOf(ev).includes(s) || parseEventContacts(ev).some(c => c.keyword === s));
  if (owners.length === 1) return { eventId: owners[0].id };
  if (owners.length > 1) return { eventId: storedId };

  // ③ 每一場共用的預設 chips，而且上次綁的那場也對不上（多半是綁定被清掉了）——
  //    仍然認得這是我們的按鈕，場次交給呼叫端去問。重點是**不要沉默**：按鈕按了
  //    沒反應，比多問一句「您想問哪一場」糟糕得多。
  if (DEFAULT_CHIPS.includes(s)) return { eventId: storedId };
  return null;
}

// ⚠️ 「找真人」（批次 83 補上）：批次 81 在兜底的按鈕列放了這顆，1 對 1 按得動，群組裡
// 卻不在這份清單上——群組按了等於沒按（視窗外被守門擋掉，視窗內它不是問句也被擋掉）。
// 偏偏是「記者任何時候都要找得到真人」的那一顆。
const GROUP_FIXED_BUTTONS = new Set([
  '最近有哪些活動', '產業趨勢分析', '想問什麼技術', CONTACT_MENU_LABEL, '使用說明', '回首頁', '找真人',
  ...MENU_WORDS // 批次 84：群組裡按鈕被別人的訊息收掉了，打「選單」叫回來，不用 @
]);

// 群組續問視窗內，明講要找真人／承辦人的話一律放行（批次 83）。刻意比 lib/menu.js 的
// isHumanRequest() 窄：那支為了 1 對 1「寧可多攔」，連「你不行啦」「給我電話」都收，
// 在群組裡那是同事之間會講的話，放行就是插話——這裡只認句子裡明講了要找哪一種人的講法。
const GROUP_HUMAN_WORD_RE = /真人|人工|客服|承辦|公關/;

async function looksAddressedToBot(groupId, text, speakerId) {
  const s = String(text || '').trim();
  if (!s) return false;

  // ⓪① 我們自己送出去的按鈕，或我們正在等這個人回答——跟視窗外用的是同一支，
  // 兩邊共用一份清單才不會像批次 30 那樣「補了一種按鈕、漏掉另一種」。
  if (await isOwnButtonText(groupId, s, speakerId)) return true;

  // ①（續）導流按鈕「工研院 ＸＸ」「ＸＸ產業趨勢」——只在視窗內放行，理由見
  // isOwnButtonText() 最後一段。
  if (GROUP_OWN_BUTTON_RE.test(s)) return true;

  // ②-前 批次 75（四角色模擬）：同事在工作群組 @ 過米亞之後的續問視窗裡，接著問「大家
  // 晚上吃什麼」——有「什麼」，會被 ② 當成提問放行，接下來全看模型判不判得出是閒聊。
  // 句子明講在問「大家／各位／你們」，對象就不是米亞；沒提到米亞就安靜。
  if (/大家|各位|你們|妳們|誰要|有人要|有沒有人/.test(s) && !/米亞/.test(s)) return false;

  // ②-後 明講要找真人（批次 83，見 GROUP_HUMAN_WORD_RE 的說明）。「我要找真人」「轉人工」
  // 沒有問號也沒有疑問詞，② 接不住；記者任何時候都要找得到真人，不能被守門擋掉。
  if (isHumanRequest(s) && GROUP_HUMAN_WORD_RE.test(s)) return true;

  // ② 一句提問（中文或英文，見 GROUP_QUESTION_EN_RE 的說明）
  if (GROUP_QUESTION_RE.test(s) || GROUP_QUESTION_EN_RE.test(s)) return true;

  // ②（續）整句只是一串活動名詞（批次 92）：「聯訪時間」「講者名單」「新聞照片」。主管在群組
  // 打「聯訪時間」沒反應——沒有問號、沒有疑問詞，② 接不住。判準見 lib/menu.js isEventTopicAsk()；
  // 米亞有專屬處理的整句固定講法（「採訪窗口」「產業趨勢」）同一個洞，一併放行。
  // 兩支都是「整句扣完一個字不剩」或「整句錨定」，有動作、有人稱的句子不會中。
  if (isEventTopicAsk(s) || isExactMetaAsk(s)) return true;

  // ③ 剛回答完趨勢／技術題時的裸名詞追問（「太空」）——那是我們自己在上一則答案
  // 結尾邀請他打的。沒有話題記憶時**不**放行：一個沒頭沒尾的名詞在群組裡多半是
  // 別人在聊自己的事（「半導體」），不是在問我們。
  //
  // ⚠️ 批次 103：話題記憶是 'calendar'（剛列過活動清單，批次 101 新增）時**不能**再用「像一個
  // 裸名詞」放行。批次 101 只想到路由（TOPIC_HINTS 沒有 calendar），沒想到這一關也讀同一份話題
  // 記憶——結果清單送出後的 10 分鐘內，群組裡的「哈哈好喔」「對啊」「哈哈哈哈」都是 2～8 個字、
  // 沒有疑問詞，全被當成裸名詞放行，米亞對著閒聊回一整段答案加 11 顆按鈕（對照實驗：沒列過
  // 清單時同樣四句全部安靜）。清單不像趨勢／技術題那樣邀請記者「打個名詞」，它邀請的是「打活動
  // 名稱」，所以這一關只認一件事：整句是剛剛清單上某一場名稱的一部分（matchShownEvents，
  // 跟 1 對 1 點名清單同一支規則）。比不中就安靜。
  if (await getRecentTopic(groupId) === 'calendar') {
    return matchShownEvents(buildCalendarCards(await getAllEventRows()), s).length > 0;
  }
  if (looksLikeBareTopic(s) && await getRecentTopic(groupId)) return true;

  return false;
}

// ── 群組／多人聊天（批次 5/6，仿美玉姨：被 @ 到才開口，短暫續問視窗）──────
// 前置作業（人類要做的事，程式碼管不到）：LINE Official Account Manager →
// 「設定 → 回應設定」把「允許加入群組/多人聊天」打開，官方帳號才有辦法被邀進群組；
// 沒開這個，LINE 根本不會讓人把帳號拉進群組，這支永遠不會被觸發。
//
// 核心規矩：沒被 @ 到、也不在剛互動過的短暫視窗內，就完全安靜——不回覆、不留任何
// 痕跡。這支帳號要是每則群組訊息都插話，很快就會被關靜音或直接被踢出群組，這個
// 通道就毀了（跟 LINE-PLAN.md 第 8 節「不要做推播行銷」同一種風險：一旦刷了存在
// 感，就再也回不去了）。isBotMentioned() 判斷用的是 LINE 官方為此加的
// mentionee.isSelf 欄位，見 lib/line.js 開頭的說明；這個欄位不存在或不是 true，
// 一律當作沒被叫到。
//
// ⚠️ 實際回報的體感落差：@ 一次拿到活動清單之後，接著（沒有再 @）打清單裡的活動
// 名稱，完全沒反應——每則都要 @ 的規則本身沒有邏輯錯誤，但使用者會覺得「剛剛不是
// 才理我嗎」。解法是 GROUP_SESSION_MS 那段續問視窗（見上面 touchGroupSession() 的
// 說明）：被 @ 到並回答之後，接下來幾分鐘內同一個群組不用重新 @ 也算在跟我們對話；
// 這段期間如果猜不出問題在問什麼，安靜略過（silentOnOther）而不是跳出來說「不確定
// 您想問哪一場」——那句話對一個直接 @ 我們的人是體貼，對群組裡剛好聊到別的事的人
// 就是插話。
export async function handleGroupEvent(replyToken, ev) {
  const groupId = ev.source?.groupId || ev.source?.roomId || null;
  if (!groupId) return; // 不明來源，安全起見不回覆

  const rawText = ev.message?.type === 'text' ? String(ev.message.text || '') : '';

  // speakerId：群組裡「這句話是誰講的」。一次性旗標要記住是誰按的按鈕（見
  // pendingNoteFor()），守門也要靠它判斷「正在等回答的那個人是不是他」。LINE 在
  // 使用者沒同意提供 userId 時可能沒有這個欄位，拿不到就傳空字串。
  const speakerId = ev.source?.userId || '';

  // 被 @ 到，或用喚醒詞「米亞」叫我們——兩種都算「明確在叫機器人」，一律要理人。
  // 喚醒詞的理由見 WAKE_WORD_RE 的說明（實測回報：有人的 LINE @ 選單裡根本找不到
  // 這個官方帳號，對他來說「只有被 @ 才說話」等於完全叫不動）。
  const mentioned = isBotMentioned(ev.message?.mention) || WAKE_WORD_RE.test(rawText);
  if (!mentioned) {
    if (ev.message?.type !== 'text') return; // 非文字訊息（貼圖…）沒被 @ 就安靜略過，不用來亂回

    const sessionUntil = await getGroupSessionUntil(groupId);
    const inWindow = !!sessionUntil && Date.now() <= sessionUntil;
    // 視窗外原本一律安靜，實測回報這會讓「按鈕按了沒反應」：LINE 的快速回覆按鈕會
    // 一直留在對話紀錄裡，同事往上滑、或隔了十幾分鐘才按，送出的是不帶 @ 的純文字，
    // 視窗早就過期 → 完全沒反應，體感就是壞掉。
    // 這種訊息其實是最不可能誤判的一種：整句話「完全等於」我們自己送出去的按鈕文字
    // （見 isOwnButtonText()），沒有人會在群組閒聊裡剛好打出「媒體邀訪需求」這五個字。
    // 所以視窗外也接這一種，其餘維持安靜。
    if (!inWindow && !(await isOwnButtonText(groupId, rawText, speakerId))) return;

    // 回報的意見：續問視窗內只要有人講話就會回，即使明顯是在跟另一個人講話
    // （例如「我再跟＠小明說話」）——機器人還是煞有其事答一段內容，感覺像亂回。
    //
    // 這裡沒被 @ 到、但訊息本身明確 @ 了「別人」（有 mentionee，且沒有一個是我們
    // 自己）——這是最乾脆的「不是在跟我講話」訊號，比事後用 AI 判斷「這是不是
    // 閒聊」更準也更省一次呼叫：routeIntent() 沒有對話記憶，看不出「那合作廠商
    // 有哪些」這種依賴上一句才聽得懂的續問跟純聊天的差別，用它來擋這種情況風險
    // 太高，會連正常續問一起擋掉；但「@ 了別人」這件事本身就已經很明確，不需要
    // 靠 AI 猜。
    //
    // 安靜（不呼叫 touchGroupSession()）還有第二層效果：目前的雪球是「亂回一次
    // → 視窗又續命 5 分鐘 → 群組只要持續有人講話，視窗永遠不會真的過期」。不幫
    // 這種訊息續命，視窗才有機會真的到期。
    if ((ev.message.mention?.mentionees || []).some(m => m?.isSelf !== true)) return;
  } else if (ev.message?.type !== 'text') {
    await replyOrPush(replyToken, groupId, nonTextReply(ev.message?.type));
    return;
  }

  // 把 @ 的那段文字拿掉，只留真正的問題；沒被 @ 到（續問視窗內）時 mention 是
  // undefined，stripMentionText 會原樣回傳（trim 過）。
  const text = stripWakeWord(stripMentionText(ev.message?.text, ev.message?.mention));
  if (!text) {
    // 只 @ 沒接問題——這句提示只在「真的被 @ 到」時才有意義；續問視窗內若剛好
    // 出現空文字（理論上不會發生，防呆而已）不用多嘴。
    //
    // 回報的意見：舊文案只教「怎麼問」（例句只有「最近有哪些活動」），沒講「可以
    // 問什麼」——群組裡第一次 @ 我們的人常常就是只打個 @ 試探，看到的卻只有一句
    // 操作說明，猜不到「媒體邀訪需求」這條路也走得通。改成先簡短自我介紹，同時
    // 把記者最常問的方向都講出來，再附快速回覆按鈕讓對方不用自己打字。
    //
    // 回報的意見（第二次）：群組快速回覆也要加上「產業趨勢分析」「想問什麼技術」
    // 這兩個新入口，跟 1 對 1 圖文選單同步——群組裡沒有持續顯示的圖文選單，這則
    // 歡迎訊息附的按鈕就是群組唯一一次看得到「還能問什麼」的機會，兩個新能力沒
    // 放進來的話，群組裡的記者根本不會知道可以這樣問。
    if (mentioned) {
      await replyOrPush(replyToken, groupId,
        '你好，我是工研院 AI 助手米亞 🙂\n想了解最近有哪些活動、產業趨勢、工研院技術，或是媒體邀訪需求，都歡迎直接問我！\n請在 @ 我的後面接著打問題（或用「米亞」開頭，例如「米亞 最近有哪些活動」），也可以點下面的按鈕：',
        HOME_MENU);
      // 這則回覆本身也附了按鈕，記者點下去送出的是沒有 @ 的純文字——續問視窗沒開
      // 的話會被 handleGroupEvent() 開頭那段「沒被 @ 又不在視窗內 → 安靜」擋掉，
      // 按鈕就變成「按了沒反應」。跟其餘所有「有回答」的路徑一樣，這裡也要續命。
      await touchGroupSession(groupId);
    }
    return;
  }

  // 免 @ 續問視窗內的統一守門（批次 28）——這句話看起來不是在跟我們講，就完全安靜。
  //
  // ⚠️ 一定要放在下面那道限流「之前」。上線後實測到的兩個症狀都是這個順序造成的：
  //   ① 群組裡連續聊了十幾句自己的事（我們全程安靜、一句都沒回），第 16 句時機器人
  //      突然冒出一句「提問太頻繁，請稍候片刻再試。」——沒有人在跟它講話，這正是
  //      「亂回」本身，而且比答錯內容更莫名其妙
  //   ② 那些我們根本不會回的閒聊照樣吃掉配額，等到真的有人 @ 我們問問題時，額度
  //      早就被閒聊燒光，真正的提問反而被擋下來
  // 限流保護的是 Anthropic／Sheets 的呼叫額度，而被守門擋掉的訊息從頭到尾不會走到
  // 那些呼叫，本來就不該計入。守門在前面，計數才對得上「我們真的做了幾次事」。
  if (!mentioned && !(await looksAddressedToBot(groupId, text, speakerId))) return;

  // 用 groupId 當限流 key，跟 1 對 1 用 line_user_id 同一個理由：LINE webhook
  // 全部來自 LINE 自己的伺服器，用單一額度保護的是「這個群組」，不會因為某個人
  // 連環發問就把同一群組其他人也一起鎖住（額度本來就是共用的，這是刻意的）。
  // 走到這裡的訊息都已經通過守門（或本來就被 @ 到），也就是真的在跟我們講話——
  // 這時候回一句「提問太頻繁」是對的，不是插話。
  if (rateLimited(groupId)) {
    await replyOrPush(replyToken, groupId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // ⚠️ 群組裡刻意不接職員模式：密語比對／#代碼綁定完全跳過，一律走記者端的自然
  // 語言路由。同一群組裡可能同時有記者、公關同仁、甚至長官，密語一旦在群組裡打
  // 出來，所有在場的人都看得到——職員身分只能在私訊裡取得，這裡沒有例外。
  await handleGroupMessage(replyToken, groupId, text, { mentioned, speakerId });
}

// 被拉進群組的那一刻（批次 28）。LINE 會送一個 `join` 事件、附 replyToken——
// 在這之前這支完全沒處理，效果是被拉進群組後**什麼都不說**，然後從此只在被 @ 到時
// 才開口。對群組裡的人來說，那是一個突然出現、不講話也不知道能幹嘛的帳號，第一次
// 有人想用它時只能亂猜（回報的意見就是從這裡開始的：「被拉進群組時也要能回答，
// 不要答非所問、不會亂回」——期待要先講清楚，才不會被當成壞掉或亂回）。
//
// 這則自我介紹刻意做三件事，順序就是重要性：
//   ① 先講規矩：「我只有被 @ 到才會說話」。這是「不會亂回」最有效的一句話——
//      它同時是承諾（我不會洗版）跟操作說明（要問我就 @ 我），而且講在最前面，
//      群組成員第一眼看到的就是這個，不是功能列表。
//   ② 再講能問什麼：四條路一次講完，不要讓人自己猜（跟 sendFallbackGuide()、
//      群組「只 @ 沒接問題」那則自我介紹同一份口徑）。
//   ③ 附快速回覆按鈕，讓第一個想試的人不用先學會怎麼 @。
//
// ⚠️ 這裡呼叫 touchGroupSession()：按鈕送出的是不帶 @ 的純文字，沒有續問視窗就會被
// 「沒被 @ 又不在視窗內 → 安靜」擋掉，按鈕變成按了沒反應（跟批次 18「只 @ 沒接問題」
// 那則踩過的坑一模一樣）。開這 5 分鐘的視窗在批次 28 之前是有風險的（視窗內什麼話
// 都會被硬答），但 looksAddressedToBot() 這道守門補上之後，視窗內也只接「看起來
// 真的在跟我們講話」的訊息，開窗讓按鈕能用的代價已經降到可以接受。
export async function handleGroupJoin(replyToken, ev) {
  const groupId = ev.source?.groupId || ev.source?.roomId || null;
  if (!groupId || !replyToken) return;
  console.log(`[line] 被加入群組 group=${groupId}`);
  await replyOrPush(replyToken, groupId,
    [
      '大家好，我是工研院的 AI 新聞助理米亞 🙂',
      '',
      '先說一下我的規矩：我只有被叫到的時候才會說話，平常的聊天我不會插話，也不會主動推播。',
      '',
      '要問我事情，兩種都可以：',
      '・@ 我一下，後面接著打問題',
      '・或直接用「米亞」開頭，例如「米亞 最近有哪些活動」',
      '',
      '（有些人的 @ 選單裡找不到我，那就用「米亞」開頭叫我就好。）',
      '',
      '這幾件事我都查得到：',
      '・某一場記者會的內容（直接打活動名稱，或問我「最近有哪些活動」）',
      '・整體產業趨勢（IEK 產業情報網的免費焦點）',
      '・工研院自己的技術與發表（打「工研院」加技術名稱）',
      '・想找採訪窗口（打「媒體邀訪需求」）',
      '',
      '要不要先看看目前有哪些活動？點下面的按鈕就可以。'
    ].join('\n'),
    HOME_MENU);
  // 上面那排按鈕送出的是沒有 @ 的純文字，要靠續問視窗才接得住——見這支開頭的 ⚠️。
  await touchGroupSession(groupId);
}

// 跟 1 對 1（handleUnbound／handleMetaIntent／答題）共用整套邏輯，差異只有：
//   - 沒有 #代碼／ask_name 媒體名稱擷取——群組裡不會有人主動報媒體名稱，qa_log
//     統一記成「（群組提問）」
//   - 沒有「輸入中」動畫——LINE 的 /chat/loading/start 只支援一對一。批次 60 把它移到
//     handleEvent() 的 1 對 1 咽喉點之後，群組自然走不到，不必再靠呼叫端記得關掉
//   - mentioned 決定猜不出問題時要不要出聲（見 handleGroupEvent 開頭的說明）
// 其餘（跳出本場意圖、換場、軟綁定）完全沿用 1 對 1 那一套，用 groupId 當
// line_users 表的 key——等於「這個群組」自己有一份軟綁定狀態，直接複用整套 TTL／
// 換場機制，不必為群組另外維護一份幾乎一樣的邏輯。
async function handleGroupMessage(replyToken, groupId, text, { mentioned, speakerId = '' }) {
  // ⚠️ 免 @ 續問視窗的守門（looksAddressedToBot）不在這支，在呼叫端 handleGroupEvent()
  // 裡、而且刻意排在限流「之前」——走到這支的訊息都已經確定是在跟我們講話。理由見
  // 那裡的說明（被守門擋掉的訊息不該吃掉限流額度，更不該讓機器人冒出一句
  // 「提問太頻繁」插話）。守門擋掉時也不會呼叫 touchGroupSession()，理由跟批次 14
  // 「@ 到別人時安靜」一樣：不幫這種訊息續命，視窗才有機會真的到期。
  let binding = await getBinding(groupId);

  // 綁定過期（6 小時 TTL）或指向別場，但這則訊息是某一場的快速提問按鈕——把綁定接
  // 回那一場再往下走（批次 41）。
  //
  // ⚠️ 只補「守門放行了、卻沒有場次可以回答」這個洞，不是新的換場機制：
  // isOwnButtonText() 現在認得舊訊息上的按鈕（見 ownChipEventId() 的 ⚠️），但如果
  // 這裡的 getBinding() 照樣回 null，訊息會掉進 handleUnbound()，而群組沒被 @ 到時
  // 那支是 silentOnOther——結果還是「按了沒反應」，只是沉默的位置往後挪了一段。
  // 守門放行跟真的答得出來，是兩道各自獨立的門，兩道都要開。
  // 這則訊息是不是我們自己送出去的按鈕（很可能是好幾小時前那則訊息上的）。下面兩個
  // 地方都要用：接回綁定，以及最後那道「按鈕永遠不沉默」。讀的都是 60 秒快取，
  // 不會多打 Sheets。
  const ownButton = await isOwnButtonText(groupId, text, speakerId);

  if (!binding?.event_id) {
    const owned = await ownChipEventId(groupId, text);
    if (owned?.eventId && isUsable(await getEventById(owned.eventId))) {
      await upsertBinding(groupId, owned.eventId, '');
      binding = await getBinding(groupId);
      console.log(`[line] 群組點了舊按鈕，綁定接回 event=${owned.eventId} text="${text.slice(0, 40)}"`);
    }
  }

  // 按了「給我《ＸＸ》的完整新聞稿」（批次 85）：接上那一場。群組版的答案照群組規則只給重點，
  // 後面自動接一對一拿全文的連結（見 GROUP_FULL_TEXT_RE）。
  const pickedFullText = await fullTextPickEvent(text);
  if (pickedFullText) {
    await upsertBinding(groupId, pickedFullText.id, '');
    await answerQuestion(replyToken, groupId, pickedFullText, '（群組提問）', '給我完整新聞稿', { group: true, speakerId });
    await touchGroupSession(groupId);
    return;
  }

  const metaIntent = await resolveMetaIntent(text);
  if (metaIntent) {
    await handleMetaIntent(replyToken, groupId, text, metaIntent, binding, { speakerId, group: true });
    await touchGroupSession(groupId); // 這一輪有回答 → 續問視窗重新計時
    return;
  }

  // 全域邀訪窗口的主題按鈕／自由輸入（見 handleContactTopicMessage() 的說明）——
  // 跟 metaIntent 同一優先順序，命中就直接處理，不會被送進當前綁定活動的問答。
  if (await handleContactTopicMessage(replyToken, groupId, text, { speakerId })) {
    await touchGroupSession(groupId);
    return;
  }

  // 「想問什麼技術」按鈕之後記者打的技術名稱（見 handleTechQueryMessage() 的說明）——
  // 同一優先順序，命中就直接查、不會被送進當前綁定活動的問答。
  if (await handleTechQueryMessage(replyToken, groupId, text, { speakerId })) {
    await touchGroupSession(groupId);
    return;
  }

  if (!binding) {
    // ⚠️ silentOnOther 對「我們自己的按鈕」一律關掉（批次 41）：安靜是為了不要在群組
    // 裡對著別人的閒聊插話，但按鈕是**我們自己請對方按的**，按了沒反應永遠是 bug，
    // 不是體貼。推不出場次時 handleUnbound() 會反問「您想問哪一場」並附上清單——
    // 多問一句，比裝作沒看到好得多。
    await handleUnbound(replyToken, groupId, text, { silentOnOther: !mentioned && !ownButton, askMediaName: false, remember: false, speakerId });
    await touchGroupSession(groupId); // 不管有沒有真的答上，只要走到這裡就算還在互動，續命
    return;
  }

  const switchTo = matchEventByName(text, buildCalendarCards(await getAllEventRows()), binding.event_id);
  if (switchTo) {
    const target = await getEventById(switchTo.id);
    if (isUsable(target)) {
      await upsertBinding(groupId, target.id, '');
      // 純粹選台，不是問題——理由跟 1:1 那段同一套（見上方那段的完整說明），
      // 不呼叫 AI、不寫 qa_log，避免灌水「累積回答題數」。
      // ⚠️ 這則原本完全沒附按鈕（1 對 1 有圖文選單頂著，看不出問題）。群組裡剛換完
      // 場正是最需要導覽的一刻：換錯了要能馬上換回去，換對了要能看到這場能問什麼。
      await replyOrPush(replyToken, groupId, `已為您換到《${target.name}》✅ 請直接問問題即可。`,
        eventQuickChips(target, { group: true }));
      await touchGroupSession(groupId);
      return;
    }
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    // 綁定指向的活動變成不可問答（例如被下架）——這種邊界情況比照 silentOnOther
    // 的邏輯：真的被 @ 到才值得說明，續問視窗內安靜跳過就好。
    if (mentioned) {
      // 一樣附上導覽：這場問不了，記者需要的是「那還能問什麼」，不是一句句點。
      await replyOrPush(replyToken, groupId, '這場活動目前無法問答，請洽現場工作人員。',
        [...NAV_HEAD, ...NAV_TAIL]);
    }
    return;
  }

  // 綁定中的閒聊（批次 86）：只在真的叫了米亞時攔——續問視窗內同事之間的「在嗎？」
  // 照樣交給下面的路由判斷要不要安靜，不能因為這段就開口。
  const boundChitchat = mentioned ? detectBoundChitchat(text) : null;
  if (boundChitchat) {
    await replyOrPush(replyToken, groupId, CHITCHAT_FIXED_REPLIES[boundChitchat], eventQuickChips(event));
    await touchGroupSession(groupId);
    return;
  }

  // 跟 1:1 那段同一套邏輯（完整說明見 handleEvent()）：綁定是預設值不是鎖，問句
  // 明確指向別場才自動換，其餘留在原場。群組共用一份綁定，換場會影響整個群組
  // 接下來的預設場次——跟現有「打整句活動名稱換台」本來就是同一種風險，不是
  // 這裡新增的。currentEventId 帶目前這場給 routeIntent()，讓它分得出「延續這場
  // 的討論」跟「真的無關」（見 lib/router.js 的說明），下面的安靜門檻才靠得住。
  // currentTopic 的理由跟 1 對 1 那段完全一樣（見 handleEvent() 同一行的說明）。
  // 整句就是一串活動名詞（批次 92）：守門已經因為「這句在問活動資料」放行了，這裡不能再讓路由
  // 用「群組成員彼此也在聊天」的提示把它翻案。GROUP_CHATTER_HINT 明講「拿不準判 other，即使
  // 它剛好提到時間、地點或資料」，而裸名詞「聯訪時間」正是最拿不準的那種——守門放行、路由
  // 判 other、下面那道門又安靜，等於回報的「沒觸發」只是往後挪了一段（跟批次 41 的按鈕同一個
  // 形狀：守門放行跟真的答得出來，是兩道各自獨立的門，兩道都要開）。
  // 綁定中才開：沒綁定時 handleUnbound() 的 silentOnOther 不動，不會為了一個名詞去反問「哪一場」。
  const topicAsk = !mentioned && !ownButton && (isEventTopicAsk(text) || isExactMetaAsk(text));
  // 綁定中、被叫到、整句只是在要完整新聞稿：就是在要這一場的，不等模型（批次 115）。
  const routed = (mentioned || ownButton) && isFullTextAsk(text)
    ? { intent: 'qa', event_ids: [event.id], confidence: 'high' }
    : pinGenericTechQueryToEvent(
      await routeIntent(text, buildCalendarCards(await getAllEventRows()),
        { currentEventId: event.id, ...(await recentTopicContext(groupId)), groupChatter: !mentioned && !ownButton && !topicAsk }),
      text, event.id);

  // 回報的意見：批次 14 只擋得住「明確 @ 別人」這種訊號很強的情況，續問視窗內
  // 純聊天、答非所問的訊息（例如「友信你覺得呢」）當時沒有安全的判斷依據——
  // routeIntent() 沒有對話記憶，分不出這種話跟「那合作廠商有哪些」這種合法續問
  // 的差別，一律判成 other。現在多了 currentEventId 提示，other 已經是「連目前
  // 這場都接不上」的結果，才能放心拿來當安靜門檻，不會連續問視窗本身要保護的
  // 案例一起擋掉。
  //
  // 真的被 @ 到時不受影響——跟 1 對 1、跟 handleUnbound() 的 silentOnOther:false
  // 同一個原則，明確叫了機器人就不能不理人。
  // 同上：按鈕不受這道安靜門檻約束。綁定中點到「這場沒有的內容」時 routeIntent()
  // 有可能判成 other，那也該老實回一句，不能讓按鈕變成按了沒反應。
  if (!mentioned && !ownButton && !topicAsk && routed.intent === 'other') return;

  // 綁定中，但這題其實是在問「有哪些場次」——理由與 1 對 1 那段完全相同（見
  // handleEvent() 同一個分支的完整說明）。
  if (routed.intent === 'calendar') {
    await sendCalendarReply(replyToken, groupId, buildCalendarCards(await getAllEventRows()), event);
    await touchGroupSession(groupId);
    return;
  }

  // 綁定中，但這題其實在問整體產業趨勢、不是這場活動的內容——不動原本的活動
  // 綁定（跟「延續這場討論」是兩件事，換場判斷只在下面 qa 分支才做），答完照樣
  // 續問視窗續命。
  if (routed.intent === 'industry_trend') {
    await answerIndustryTrend(replyToken, groupId, text);
    await touchGroupSession(groupId);
    return;
  }

  // 同上，只是問的是工研院自己的技術，不是整體產業趨勢——一樣不動活動綁定。
  // 優先用 routeIntent() 抽出來的關鍵字，不要整句原話去查——見上面 handleUnbound()
  // 那條同樣的說明（LINE-PLAN.md 批次 22）。
  if (routed.intent === 'tech_query') {
    await answerTechQuery(replyToken, groupId, routed.tech_keyword || text);
    await touchGroupSession(groupId);
    return;
  }

  let answerEvent = event;
  let switchNotice = '';
  if (routed.intent === 'qa' && routed.confidence === 'high' &&
      routed.event_ids.length === 1 && routed.event_ids[0] !== event.id) {
    const target = await getEventById(routed.event_ids[0]);
    if (isUsable(target)) {
      await upsertBinding(groupId, target.id, '');
      answerEvent = target;
      switchNotice = `🔄 已切換到《${target.name}》：\n`;
    }
  }

  await answerQuestion(replyToken, groupId, answerEvent, '（群組提問）', text, { switchNotice, group: true, speakerId });
  await touchGroupSession(groupId);
}
