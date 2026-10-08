// LINE 官方帳號 webhook — 記者問答（批次 2 單場綁定 + 批次 3 自然語言意圖路由）
// + 內部職員模式（批次 4）。LINE-PLAN.md 有完整規格。
//
// 記者端，兩種問法都支援：
//   1. 掃該場 QR（連結已預帶 #活動代碼，見 LINE-PLAN.md 第 7 節）→ 綁定 line_users →
//      之後直接發問。#代碼對不上時，當成一般文字重新路由一次，不會只回「找不到」。
//   2. 沒綁定、直接打活動名稱或問「最近有哪些活動」→ 過 lib/router.js 的意圖路由，
//      判斷是查活動列表、問特定一場（順手軟綁定，下一題不用再打名稱）、還是無關問題。
// 兩條路徑最後都走同一份「跟網頁版同一份」knowledge_base 回答，寫回 qa_log（source=line）。
//
// 職員端（同一個 LINE 帳號、同一支 webhook）：講對 LINE_STAFF_PASSCODE 這組密語，
// 該 userId 永久記為職員（存 line_staff 表，要收回權限就去 Sheet 刪那一列）。之後
// 用自然語言下指令，過 lib/staff.js 的 routeStaffIntent()：查活動列表／問特定活動內容
// （含 draft／archived，reporter 那套 isUsable() 限制不套用）／查某場後台數據／查 GEO
// 狀態／新增活動並直接拿到同仁編輯連結／要某場的媒體訓練連結。安全模型見 lib/staff.js
// 開頭註解。
//
// 群組／多人聊天（批次 5，仿美玉姨模式）：加進群組後預設完全安靜，只有被 @ 到
// 才回答，見 handleGroupEvent() 開頭的說明。密語／職員指令、#代碼綁定在群組裡
// 完全不接——同一群組可能同時有記者跟公關同仁，職員身分只能私訊取得。
//
// 批次 2/3/4 刻意不做、目前仍未做的事（見 LINE-PLAN.md）：
//   - 真人接手轉接標記、邀訪收單（記者端的 media_requests）
//
// 安全與坑，詳見 LINE-PLAN.md 第 3 節：
//   - 簽章驗證必須用原始 bytes，不能碰 req.body（見 lib/line.js 開頭註解）
//   - reply token 60 秒只能用一次，reply 失敗一律 fallback push（見 lib/line.js）
//   - 限流用 line_user_id 當 key，不能用 IP——webhook 全部來自 LINE 自己的伺服器，
//     用 IP 當 key 等於全部記者共用同一個額度，會互相誤殺
//   - 沒有有效綁定／路由結果就不能呼叫 Anthropic，跟 api/chat.js「無 event_id 不碰
//     Anthropic」同一條原則；draft／archived 場次一律不進行事曆清單、不會被路由到
//
// 批次 117 起這支只剩入口：簽章驗證、逐一事件分派（handleEvent）、同一則事件不回兩次、出錯道歉。
// 其餘各條路搬到 lib/，程式與註解原封不動，註解裡的「見 xxx()」照樣找得到，只是在別的檔案：
//   lib/line-store.js       活動列快取、line_users 綁定、群組免 @ 視窗、話題與上一輪記憶
//   lib/line-runtime.js     請求死線、限流、答題模型（askAnthropic）、按鈕與送出回覆
//   lib/line-format.js      米亞的語氣與版面規則、出口清理（Markdown、版面）
//   lib/line-chitchat.js    不呼叫模型的字面判斷：閒聊、招呼、主題詞、媒體名稱、非文字訊息
//   lib/line-nodata.js      「這場答不出來」→ 補查工研院官網
//   lib/line-reporter.js    記者端：活動問答、邀訪窗口、產業趨勢、技術查詢、找真人、近期活動、兜底
//   lib/line-register.js    活動報名（我要報名、#報名 綁定）
//   lib/line-staff-mode.js  職員模式（活動卡、在 LINE 改資料、教米亞、圖文選單）
//   lib/line-group.js       群組（守門、喚醒詞、免 @ 續問視窗）
// 依賴只往下走：store／format／chitchat → runtime → nodata／register → reporter → staff-mode／group → 這支。

import { timingSafeEqual } from 'crypto';
import { toTraditionalTW } from '../lib/zh-tw.js';
import { readRawBody, verifySignature, replyOrPushMessages, startLoading, isBotMentioned } from '../lib/line.js';
import { buildCalendarCards, buildCalendarCardsFor, routeIntent } from '../lib/router.js';
import { matchEventByName, buildWelcomeFlex } from '../lib/menu.js';
import { listOpenCampaigns, parseRegBindText, parseRegBindCheck, welcomeButtonLabel } from '../lib/registration.js';
import { autoSyncRegistrationMenu } from '../lib/richmenu-sync.js';
import { isPasscodeMatch, isStaffAuthenticated, authenticateStaff } from '../lib/staff.js';
import { isBusinessEvent } from '../lib/audience.js';
import { parseB2BBind, handleB2BBind, isPartnershipAsk, handlePartnershipAsk } from '../lib/b2b-line.js';
import { sanitize } from '../lib/line-format.js';
import {
  CHITCHAT_FIXED_REPLIES, detectBoundChitchat, looksLikeNameOrSkip, mediaNameOf, nonTextReply
} from '../lib/line-chitchat.js';
import {
  findEventByCode, getAllEventRows, getBinding, getEventById, getStoredMediaName, isUsable, recentTopicContext,
  setBindingNote, setMediaName, upsertBinding
} from '../lib/line-store.js';
import {
  HOME_MENU, REQUEST_BUDGET_MS, STAFF_QUICK_REPLIES, askMediaNameLater, eventContentChips, eventQuickChips,
  markStaff, mediaNameChips, rateLimited, replyOrPush, requestCtx, staffChips, toQuickReply
} from '../lib/line-runtime.js';
import { pinGenericTechQueryToEvent } from '../lib/line-nodata.js';
import { handleRegBind, resolveMetaIntent } from '../lib/line-register.js';
import {
  answerIndustryTrend, answerQuestion, answerTechQuery, fullTextPickEvent, handleContactTopicMessage,
  handleMetaIntent, handleTechQueryMessage, handleUnbound, isFullTextAsk, sendCalendarReply
} from '../lib/line-reporter.js';
import { applyStaffMenu, handleStaffImage, handleStaffMessage } from '../lib/line-staff-mode.js';
import { WAKE_WORD_RE, handleGroupEvent, handleGroupJoin } from '../lib/line-group.js';

// ── 簡體字防線（批次 45）─────────────────────────────────────────────────
// 回報的截圖：一整則回覆都是繁體，只有最後那句警語跑出簡體——
// 「内容仅供参考，以工研院官网新闻稿或发言为准。」
//
// 兩層一起做，跟 Markdown 那次同一個結構：
//   ① prompt 加一條明確規則（見 askAnthropic() 的 ZH_TW_RULE）
//   ② **出口再轉一次**——規則是請求、不是保證。這一層才是真正的保證。
//
// 轉換表與函式本體現在住在 lib/zh-tw.js——媒體訓練的語音轉寫是第二個出口，也要用
// 同一份表，與其兩邊各維護一份（遲早長歪），不如搬出去共用。這裡照樣 re-export，
// 外面既有的 `import { toTraditionalTW } from '../api/line.js'` 一行都不用改。
export { toTraditionalTW };
// 批次 117：這兩組搬到 lib/ 之後照樣從這裡 re-export，測試與工具既有的 import 不用改。
export { stripMarkdownForLine, tidyLineLayout } from '../lib/line-format.js';
export { extractNoDataKeyword, guessNoDataKeyword } from '../lib/line-nodata.js';

// ── 逐一事件處理 ─────────────────────────────────────────────────────
async function handleEvent(ev) {
  console.log(`[line] 收到事件 type=${ev.type} msgType=${ev.message?.type || '-'} user=${ev.source?.userId || '-'}`);
  if (ev.type === 'follow') {
    const userId = ev.source?.userId;
    if (!userId || !ev.replyToken) return;
    // 加好友只有這一次機會講清楚「這是什麼、怎麼開始」。純文字會被滑過去，改送
    // 有三步驟與按鈕的 Flex 圖卡（見 lib/menu.js buildWelcomeFlex）。
    // Flex 送失敗（欄位打錯、LINE 版本太舊）不能讓新記者收到一片空白，
    // 所以退回原本那則純文字歡迎詞——文案本身仍然是完整可用的引導。
    // 批次 84：圖卡本身也掛上起點按鈕——盤點抓到加好友這則一顆按鈕都沒有；手機的圖文
    // 選單要先點開才看得到，LINE 電腦版則完全不顯示圖文選單（官方文件）。
    // 批次 88：有開放中的活動報名時，歡迎卡最上面多一顆「活動報名」。查詢失敗當作沒有，
    // 不能讓新記者因為報名資料表讀不到就收不到歡迎卡（listOpenCampaigns() 自己吞例外）。
    // 按鈕上的字用後台「LINE 簡稱」（例：眺望2027場次報名），只有一個活動開放時才具體，兩個以上就用通用的。
    const openNow = await listOpenCampaigns();
    const registration = openNow.length === 1 ? welcomeButtonLabel(openNow[0]) : openNow.length > 1;
    const ok = await replyOrPushMessages(ev.replyToken, userId, [{ ...buildWelcomeFlex('', { registration }), quickReply: toQuickReply(HOME_MENU) }]);
    if (!ok) {
      await replyOrPush(ev.replyToken, userId,
        '感謝加入好友！\n\n請掃描活動現場的 QR code，或直接輸入「#活動代碼」開始問答；也可以直接打活動名稱，或點下面的按鈕看看目前有哪些活動。\n\n本帳號會記錄您的提問內容以改善新聞服務，不會蒐集您的個人資料。',
        HOME_MENU);
    }
    return;
  }

  // 被拉進群組／多人聊天：自我介紹一次並講清楚「只有被 @ 才會說話」，見
  // handleGroupJoin() 的完整說明。這是唯一一次可以不請自來講話的時機，錯過就沒有了。
  if (ev.type === 'join') {
    await handleGroupJoin(ev.replyToken, ev);
    return;
  }

  // ⚠️ memberJoined（有「別人」加入我們所在的群組）刻意不處理：那不是在跟我們打招呼，
  // 每次有人進群就跳出來自我介紹一次，正是這個帳號最該避免的洗版行為（LINE-PLAN.md
  // 第 8 節「不要做推播行銷」）。leave／unfollow 也沒有可用的 replyToken，沒有事情
  // 可做——真的要清資料的話那是另一件事，不在這支的責任範圍。
  if (ev.type !== 'message') return; // unfollow／leave／memberJoined／postback 都不處理

  const replyToken = ev.replyToken;
  if (!replyToken) return;

  // 群組／多人聊天：被 @ 到才回答（見 handleGroupEvent() 開頭的說明），跟下面
  // 1 對 1 的流程分開走，不共用職員模式／#代碼綁定那一段。
  if (ev.source?.type !== 'user') {
    await handleGroupEvent(replyToken, ev);
    return;
  }

  const userId = ev.source?.userId;
  if (!userId) return;

  if (ev.message?.type !== 'text') {
    // 批次 79：職員傳照片 → 問要加到哪一場。記者傳照片照舊回「看不到」。
    // 限流照樣算：一次傳十張照片不能變成十次沒上限的處理。
    if ((ev.message?.type === 'image' || ev.message?.type === 'file') && await isStaffAuthenticated(userId)) {
      markStaff();
      if (rateLimited(userId)) {
        await replyOrPush(replyToken, userId, '傳得太快了，請稍候片刻再傳。');
        return;
      }
      if (ev.message.type === 'image') {
        await handleStaffImage(replyToken, userId, ev.message.id);
      } else {
        await replyOrPush(replyToken, userId,
          '檔案我這邊還不能直接讀 🙏 新聞稿的 Word 檔，請到那場的編輯頁，用知識庫上方的「從 Word 檔匯入」。',
          staffChips('更新活動'));
      }
      return;
    }
    await replyOrPush(replyToken, userId, nonTextReply(ev.message?.type));
    return;
  }

  const text = String(ev.message.text || '').trim();
  if (!text) return;

  if (rateLimited(userId)) {
    await replyOrPush(replyToken, userId, '提問太頻繁，請稍候片刻再試。');
    return;
  }

  // ── 「輸入中」動畫：每一則 1 對 1 訊息都要跑（批次 60）──────────────────────
  // 回報（附截圖）：「有時候思考會很久 有可能固定出現像截圖這種… 讓大家知道其實有在
  // 思考」。關鍵字是**「有時候」**——動畫本身早就做好了，但呼叫它的地方只有一個：
  // answerQuestion()，也就是「活動問答」那一條路。
  //
  // 於是記者的體感是這樣的：問某一場活動的內容 → 看得到動畫；問產業趨勢、工研院技術、
  // 最新新聞，或是任何掉進智慧兜底的問題 → 送出後畫面完全沒有反應。而那幾條路**恰好
  // 是比較慢的**（產業趨勢要先抓 IEK 清單、技術要先查官網，都是外部網站，再接模型），
  // 正是最需要讓人知道「我在處理」的那幾條。會動的那條反而是最快的。
  //
  // 所以這支不放在各條答題路線裡面，改放在這裡——1 對 1 的唯一咽喉點，在路由、Sheets
  // 讀取、模型呼叫**全部之前**。三個理由：
  //   ① 五條答題路線一次到位，以後新增第六條也不會漏掉（同 LAYOUT_RULE 的道理，
  //      批次 59；也是批次 53「同一件事散在好幾個地方各寫一份，遲早漂開」的教訓）
  //   ② 慢的不只是模型——routeIntent() 自己就有 15 秒逾時、Sheets 也可能卡在配額重試。
  //      放在答題函式裡的話，這段等待時間畫面上仍然是死的
  //   ③ 連職員模式、使用說明、活動清單這種快路徑也一起蓋到。它們一兩秒就回覆，動畫
  //      只會閃一下就被訊息蓋掉（LINE 收到訊息會自動收掉動畫），沒有副作用——而
  //      「固定會出現」本來就是這次回報要的東西
  //
  // ⚠️ 要 await。不 await 的話有機會「訊息先送到、loading 才送到」，那會變成答案底下
  // 掛著一個沒人收得掉的動畫，整整轉 55 秒——比沒有動畫更糟。這支自己有 3 秒逾時、
  // 也自己吞例外（見 lib/line.js startLoading），拖不住後面的答案。
  //
  // ⚠️ 群組拿不到這個。LINE 的 /chat/loading/start 官方文件明講只支援一對一，group／
  // room 傳了穩定失敗。這段在 handleGroupEvent() 分流「之後」，所以群組本來就走不到
  // 這裡。群組要有同樣的體感只能改成先送一則「稍等一下」的訊息，那等於每一題都洗兩則
  // 版——這個帳號最該避免的事（LINE-PLAN.md 第 8 節），刻意不做。
  await startLoading(userId, 55);

  // 職員模式（批次 4）：密語比對與已登入狀態一律最優先判斷，整段接管、不再往下走
  // #代碼／reporter 流程——職員用自然語言下所有指令，不用記兩套語法。
  if (isPasscodeMatch(text)) {
    markStaff();
    if (await isStaffAuthenticated(userId)) {
      await replyOrPush(replyToken, userId, '您已經是職員模式了，直接問我就可以，不用再輸入一次密語。', staffChips());
      return;
    }
    const { displayName } = await authenticateStaff(userId);
    await applyStaffMenu(userId); // 下方選單換成職員版
    console.log(`[line] 新職員登入 user=${userId} name=${displayName || '(無)'}`);
    await replyOrPush(replyToken, userId,
      `職員模式已啟用${displayName ? `，${displayName} 您好` : ''}！\n\n下方選單已換成職員版，也可以直接用講的。\n\n您的 LINE ID：${userId}\n（想在「有新的人用密語登入」時收到通知，把這組 ID 設成 LINE_ADMIN_USER_ID 環境變數即可）`,
      STAFF_QUICK_REPLIES);
    return;
  }
  // 報名頁按「用 LINE 連結我的報名」送來的「#報名 R7K3M」（批次 88）。必須排在職員判斷與一般
  // 「#活動代碼」之前：它也是 # 開頭，晚一步就會被當成活動代碼、回一句「找不到活動」。
  const regBindCode = parseRegBindText(text);
  if (regBindCode) {
    await handleRegBind(replyToken, userId, regBindCode, parseRegBindCheck(text));
    return;
  }
  // 業發處（批次 119，見 lib/b2b-line.js）：業務窗口綁 LINE 通知的「#業務 M7K3Q-檢查碼」也是 # 開頭，要排在
  // 一般「#活動代碼」之前。
  const b2bBind = parseB2BBind(text);
  if (b2bBind) {
    await handleB2BBind(replyToken, userId, b2bBind);
    return;
  }
  if (await isStaffAuthenticated(userId)) {
    markStaff();
    await handleStaffMessage(replyToken, userId, text);
    return;
  }
  // 「企業合作洽詢」只回洽詢單網址（批次 119）。排在職員模式之後：職員怎麼講都照原本的職員模式走，不被業發處攔走；
  // 業發處沒設定、暫停收件、讀設定失敗，也都照原本的路徑走。
  if (isPartnershipAsk(text) && await handlePartnershipAsk(replyToken, userId)) return;

  // #代碼 綁定（半形／全形井號都收，同仁貼連結時中文輸入法常會打成全形）
  if (text.startsWith('#') || text.startsWith('＃')) {
    const code = text.slice(1).trim();
    const event = await findEventByCode(code);
    if (isUsable(event)) {
      await upsertBinding(userId, event.id, 'ask_name');
      // 企業場（批次 118）問公司或單位，不問媒體——對方不是記者
      const who = isBusinessEvent(event)
        ? '請問您是哪家公司或單位？（方便活動窗口後續聯繫，打公司名稱即可，或點「略過」）'
        : '請問您是哪家媒體？（方便新聞聯絡人後續服務，打媒體名稱即可，或點「略過」）';
      await replyOrPush(replyToken, userId,
        `已為您接上《${event.name}》✅\n\n${who}\n\n之後就可以直接問問題了。`,
        mediaNameChips(event));
      return;
    }
    // 代碼對不上——很可能是把活動「代碼」跟活動「名稱」搞混了，把 # 拿掉當一般
    // 文字重新路由一次，不要只回「找不到」就結束，記者不會知道代碼跟名稱是兩回事。
    await handleUnbound(replyToken, userId, code || text);
    return;
  }

  // 按了「給我《ＸＸ》的完整新聞稿」（批次 85）：直接接上那一場、給全文，不經過路由。
  const pickedFullText = await fullTextPickEvent(text);
  if (pickedFullText) {
    await upsertBinding(userId, pickedFullText.id, '');
    await answerQuestion(replyToken, userId, pickedFullText, await getStoredMediaName(userId), '給我完整新聞稿', { memory: true });
    return;
  }

  const binding = await getBinding(userId);

  // 活動列表／換一場／使用說明——不管有沒有綁定都要先攔，見 handleMetaIntent() 的說明
  const metaIntent = await resolveMetaIntent(text);
  if (metaIntent) {
    console.log(`[line] meta intent=${metaIntent} user=${userId} q="${text.slice(0, 40)}"`);
    await handleMetaIntent(replyToken, userId, text, metaIntent, binding);
    return;
  }

  // 全域邀訪窗口的主題按鈕／自由輸入（見 handleContactTopicMessage() 的說明）——
  // 跟 metaIntent 同一優先順序，命中就直接處理，不會被送進當前綁定活動的問答。
  if (await handleContactTopicMessage(replyToken, userId, text)) return;

  // 「想問什麼技術」按鈕之後記者打的技術名稱（見 handleTechQueryMessage() 的說明）。
  if (await handleTechQueryMessage(replyToken, userId, text)) return;

  if (!binding) {
    await handleUnbound(replyToken, userId, text);
    return;
  }

  // 綁定中但整句就是「另一場活動的名稱」（多半是剛按了活動清單的按鈕）→ 直接換過去。
  // 不做這件事的話，按了按鈕只會讓舊那場的 AI 去回答「某某記者會」這句話。
  const switchTo = matchEventByName(text, buildCalendarCards(await getAllEventRows()), binding.event_id);
  if (switchTo) {
    const target = await getEventById(switchTo.id);
    if (isUsable(target)) {
      console.log(`[line] 換場 ${binding.event_id} → ${target.id} user=${userId}`);
      // 第三個參數傳空字串是要「清掉」note，不是省略。記者掃 QR 綁定後被問了媒體
      // 名稱（note='ask_name'），卻改打另一場的名稱換過去——這代表他跳過了報名字。
      // 不在這裡清掉的話旗標會跟著新綁定留下來，他換場後打的第一句真正的問題會被
      // 下面 looksLikeNameOrSkip() 誤判成媒體名稱吃掉（同下方 ⚠️ 那個已修過的坑）。
      await upsertBinding(userId, target.id, '');
      // ⚠️ 這是純粹「選台」，不是問題——不能走 answerQuestion()。之前這裡直接把
      // 「某某記者會」這句話當成問題送進 Anthropic、寫進 qa_log，後台的「累積回答
      // 題數」跟「今日問答」就被按活動清單按鈕的動作灌水，跟記者真的發問混在一起，
      // report.html 給長官看的數字失真。改成單純回一句換場確認，不呼叫 AI、不寫
      // qa_log——跟 #代碼綁定拿到的「已為您接上」同一種純確認訊息。
      // 批次 84：1 對 1 這則原本一顆按鈕都沒有（群組版批次 40 就補了），剛換過來正是最需要
      // 看到「這場能問什麼」的時候。
      await replyOrPush(replyToken, userId, `已為您換到《${target.name}》✅ 請直接問問題即可。`,
        eventQuickChips(target));
      // ⚠️ 實際回報的坑：換場這條路一直都不會問媒體名稱——不管換過去之前有沒有
      // 被問過。原本只有「掃 QR／#代碼」跟「自然語言軟綁定」兩條路會問，這位記者
      // 從頭到尾都是靠打活動名稱換場，於是永遠沒被問過，後台分析永遠看到
      // 「（未填寫）」。補問邏輯跟 handleUnbound() 的軟綁定分支同一套：只在「這個人
      // 從沒被問過」才問（media_name 已有值就不重問），而且用 push 補問，不擋住
      // 剛剛送出的換場確認。
      if (!binding.media_name) await askMediaNameLater(userId, target);
      return;
    }
  }

  const event = await getEventById(binding.event_id);
  if (!isUsable(event)) {
    await replyOrPush(replyToken, userId, '這場活動目前無法問答，請洽現場工作人員。');
    return;
  }

  // 媒體名稱擷取：只在 #代碼綁定當下明確問過一次（note==='ask_name'）的「下一則」
  // 才嘗試擷取，而且無論這則判斷結果是不是像名稱，用掉這一次後就立刻清掉旗標，
  // 之後永遠不會再被攔截。
  //
  // ⚠️ 這是實際在正式環境發生過的 bug 修正：舊版判斷式只看「media_name 還沒填」，
  // 不管有沒有真的被問過名稱——軟綁定（自然語言命中，見 handleUnbound）的記者
  // 從頭到尾沒被問過名稱，media_name 永遠是空字串，於是只要問題剛好不含「？」
  // 也沒用疑問詞開頭（例如「給我完整新聞稿」），就會被 looksLikeNameOrSkip 誤判成
  // 「像名稱」，永遠卡在「已記錄，謝謝」、問幾次都一樣，真正的問題從沒被回答過。
  // ⚠️ note 欄位（line_users F 欄）批次 5 規劃另外要用來標 pending（真人接手），
  // 兩者目前不會同時發生，但要做批次 5 時請先看 LINE-PLAN.md 這段的完整說明。
  if (binding.note === 'ask_name') {
    await setBindingNote(userId, ''); // 一次性：不管這則判斷結果如何，用掉就清掉
    // 批次 84：補問那則現在帶著這場的快速提問按鈕——記者按了「合作廠商」這種短短的
    // 自訂提問，不能被當成媒體名稱記下來、回一句「已記錄」就把問題吞掉。
    if (looksLikeNameOrSkip(text) && !eventContentChips(event).includes(text)) {
      const isSkip = /^(略過|skip|跳過)$/i.test(text);
      await setMediaName(userId, isSkip ? '（未提供）' : sanitize(mediaNameOf(text), 40));
      // 這裡就是記者準備開始問問題的第一個時間點，順手把快速提問按鈕帶上——
      // 不用等他問完第一題、answerQuestion() 自己送出來的答案才第一次看到。
      await replyOrPush(replyToken, userId, '已記錄，謝謝！請直接輸入您的問題即可。', eventQuickChips(event));
      return;
    }
    // 不像名稱、比較像直接問問題 → 不回「已記錄」，直接當問題往下走，
    // 記者不會因為系統誤判而被迫多問一次。
  }

  // 綁定中的閒聊（批次 86，見 detectBoundChitchat()）：寫死的回覆＋這場的按鈕，不呼叫模型、
  // 不補查官網、不寫 qa_log。
  const boundChitchat = detectBoundChitchat(text);
  if (boundChitchat) {
    await replyOrPush(replyToken, userId, CHITCHAT_FIXED_REPLIES[boundChitchat], eventQuickChips(event));
    return;
  }

  // 綁定不再是鎖，是預設值：每則問題都用同一支 routeIntent()（跟未綁定時
  // handleUnbound() 用的是同一套）檢查一次「這其實是在問別場」——回報的意見：
  // 換一場活動，記者就再也問不到其他場。matchEventByName() 只認得出「整句就是
  // 活動名稱」的選台動作，一句夾著別場線索的完整問題（多半帶著問號）認不出來，
  // 前面才會掉到這裡。
  //
  // 只有 confidence high、剛好指到一場、而且不是目前這場，才自動換；其餘一律
  // 留在原場繼續回答——寧可誤判成「留在原場」也不要誤判成「換去別場」，換錯場
  // 比換不了場更糟：記者不會發現答案其實來自另一場，還可能直接截圖引用
  // （同一種風險見 LINE-PLAN.md 坑 6）。currentEventId 帶目前這場給 routeIntent()，
  // 讓它分得出「延續這場的討論」跟「真的指向別場」（見 lib/router.js 的說明），
  // 減少沒有明確線索時被誤判成 other、進而誤觸換場判斷的機會。
  // currentTopic 一併帶上：綁定中一樣可能剛問完產業趨勢（那條路不動活動綁定，見
  // 下面 industry_trend 分支），接著打一個裸名詞追問——沒有這個提示，那句話會被
  // currentEventId 的提示硬拉回「延續這場活動」，記者拿到的是那場的 AI 說「這部分
  // 我沒有資料」，一樣是答非所問，只是換了一種形式。見 getRecentTopic() 的說明。
  // ⚠️ 批次 58：只帶話題標籤不夠——記者的追問常常是一句完整問句（回報的截圖：
  // 「有談機器人發展的嗎」），標籤給不出任何依據，那句話照樣被 currentEventId 拉回
  // 這一場。recentTopicContext() 會連「上一則實際答了什麼」一起帶上去。
  // 整句只是在要完整新聞稿（選單「新聞稿全文」）：綁定中就是這一場的，不等模型（批次 115）。
  const routed = isFullTextAsk(text)
    ? { intent: 'qa', event_ids: [event.id], confidence: 'high' }
    : pinGenericTechQueryToEvent(
      await routeIntent(text, buildCalendarCardsFor(await getAllEventRows(), event.id),
        { currentEventId: event.id, ...(await recentTopicContext(userId)) }),
      text, event.id);

  // 綁定中，但這題其實是在問「有哪些場次」——不動原本的活動綁定，只列清單（跟
  // handleMetaIntent() 的 calendar 分支同一支，見 sendCalendarReply()）。
  //
  // ⚠️ 這個分支批次 57 之前**不存在**：綁定中只認 industry_trend／tech_query 兩種
  // 「跳出本場」的意圖，routeIntent() 判成 calendar 時直接掉到下面的 answerQuestion()，
  // 由那一場的 AI 拿它的知識庫回答「最近有哪些活動」——正是 handleMetaIntent() 開頭
  // 那段註解在講的原始 bug，只是換了一條路徑重演。以前沒被發現，是因為 CALENDAR_RE
  // 幾乎什麼都吃得下來；這一批把那條規則收緊（見 lib/menu.js EVENT_LOCAL_RE）之後，
  // 沒有這個分支就會變成真的漏判。規則保證、AI 涵蓋，兩層都要有（CLAUDE.md 第 2 條）。
  if (routed.intent === 'calendar') {
    console.log(`[line] 綁定中被判成 calendar，改列清單 q="${text.slice(0, 40)}"`);
    await sendCalendarReply(replyToken, userId, buildCalendarCards(await getAllEventRows()), event);
    return;
  }

  // 綁定中，但這題其實在問整體產業趨勢、不是這場活動的內容——不動原本的活動綁定
  // （跟「延續這場討論」是兩件事，換場判斷只在下面才做），記者下一題還是繼續問
  // 原本那場。
  if (routed.intent === 'industry_trend') {
    await answerIndustryTrend(replyToken, userId, text);
    return;
  }

  // 同上，只是問的是工研院自己的技術，不是整體產業趨勢——一樣不動活動綁定。
  // 優先用 routeIntent() 抽出來的關鍵字，不要整句原話去查——見 handleUnbound()
  // 那條同樣的說明（LINE-PLAN.md 批次 22）。
  if (routed.intent === 'tech_query') {
    await answerTechQuery(replyToken, userId, routed.tech_keyword || text);
    return;
  }

  let answerEvent = event;
  let switchNotice = '';
  if (routed.intent === 'qa' && routed.confidence === 'high' &&
      routed.event_ids.length === 1 && routed.event_ids[0] !== event.id) {
    const target = await getEventById(routed.event_ids[0]);
    if (isUsable(target)) {
      console.log(`[line] 問答中自動換場 ${event.id} → ${target.id} user=${userId} q="${text.slice(0, 40)}"`);
      await upsertBinding(userId, target.id, '');
      answerEvent = target;
      switchNotice = `🔄 已切換到《${target.name}》：\n`;
    }
  }

  await answerQuestion(replyToken, userId, answerEvent, binding.media_name, text, { switchNotice, memory: true });
}

// ── 例外的出口：記者永遠不該面對「已讀不回」（批次 57）────────────────────
// 實測（test/test-resilience.mjs 把 events 表的讀取換成會丟例外的版本）：Sheets 一
// 出狀況，記者送出的那一則問題**一個字都不會有回應**——handler 的 catch 只 console.error，
// Vercel Logs 上很乾淨，記者那邊就是已讀不回。
//
// 這是 CLAUDE.md 第 4 條「送出成功 ≠ 使用者看得到」的另一面：**我們自己知道出事了，
// 但沒有人告訴記者**。而且它最容易發生的時機正好是最不能出事的時機——記者會開場後
// 十分鐘，幾十位記者同時發問，Sheets 那個「每分鐘 60 次、全站共用」的配額最緊繃
// （見 lib/sheets.js fetchWithRetry() 的說明）。
//
// 為什麼補在這裡、而不是在每一支可能丟例外的函式裡各自 try：這是**結構性保證**，
// 跟 replyOrPush() 包一層補群組導覽、跟 toTraditionalTW() 擋在出口是同一招（CLAUDE.md
// 第 2 條）。往後任何人新增一條問答路線、忘了自己接例外，記者一樣拿得到一句人話。
//
// ⚠️ 群組只有「真的被叫到」才道歉。沒被 @ 到、也沒用喚醒詞的訊息，我們本來就不該
// 開口——如果因為處理它的過程中出了例外就跳出來講話，那正是這個帳號最該避免的插話
// （而且看起來像莫名其妙的鬼打牆）。判斷只看事件本身（mention／喚醒詞），不再碰任何
// 會再丟一次例外的 I/O。
// ⚠️ 整支包在 try 裡：道歉本身失敗（LINE API 也掛了）不能再往外丟，那會讓 handler
// 回 500，LINE 就會重送整批 webhook，變成雪上加霜的重試風暴。
// 同一則事件不回第二次（批次 117）。LINE 後台若開了「Webhook 重送」，我們這邊 60 秒內還在答題、
// LINE 那邊已經等不及判定逾時，就會把同一則事件再送一次——記者會收到兩則一樣的答案，問答紀錄也多一筆。
// 每則事件都有唯一的 webhookEventId，記住最近 10 分鐘看過的。記在這台機器的記憶體裡（best-effort）：
// 重送大多落在同一台還熱著的機器上；落到別台時照舊處理——寧可偶爾回兩次，也不要漏答。
const SEEN_EVENT_TTL_MS = 10 * 60_000;
const seenEvents = new Map();
function isDuplicateDelivery(ev) {
  const id = ev?.webhookEventId;
  if (!id) return false;
  const now = Date.now();
  if (seenEvents.size > 2000) for (const [k, t] of seenEvents) if (now - t > SEEN_EVENT_TTL_MS) seenEvents.delete(k);
  const seenAt = seenEvents.get(id);
  if (seenAt && now - seenAt < SEEN_EVENT_TTL_MS) return true;
  seenEvents.set(id, now);
  return false;
}

async function apologise(ev, cause) {
  try {
    if (ev?.type !== 'message' || !ev.replyToken) return;
    const isDirect = ev.source?.type === 'user';
    const targetId = isDirect ? ev.source?.userId : (ev.source?.groupId || ev.source?.roomId);
    if (!targetId) return;
    if (!isDirect) {
      const rawText = ev.message?.type === 'text' ? String(ev.message.text || '') : '';
      const addressed = isBotMentioned(ev.message?.mention) || WAKE_WORD_RE.test(rawText);
      if (!addressed) return; // 沒在跟我們講話，出錯也不要插話
    }
    console.error(`[line] 回覆道歉訊息 target=${targetId} cause=${cause?.message || '-'}`);
    // reply token 60 秒只能用一次，走到這裡多半還沒被用掉（例外通常發生在送出回覆
    // 之前）；真的用掉了 replyOrPush() 會自動退回 push，記者一樣收得到。
    await replyOrPush(ev.replyToken, targetId,
      '不好意思，我這邊剛剛卡住了，這一題沒能查出來 🙏\n麻煩再問我一次；如果連續幾次都這樣，打「找真人」或直接洽現場新聞聯絡人，不要等我。');
  } catch (e) {
    console.error('道歉訊息也送不出去:', e.message);
  }
}

export default async function handler(req, res) {
  // Vercel Cron（GET）：報名結束後把圖文選單換回原本那套（批次 88）。一定要帶 CRON_SECRET，
  // 沒設定就一律拒絕——這個入口會動到 LINE 帳號的選單。
  if (req.method === 'GET' && req.query?.action === 'cron_menu') {
    const secret = process.env.CRON_SECRET;
    const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(bearer), b = Buffer.from(secret || '');
    if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
    try {
      return res.status(200).json(await autoSyncRegistrationMenu());
    } catch (e) {
      console.error('自動換回圖文選單失敗:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).end();

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error('LINE_CHANNEL_SECRET 未設定');
    return res.status(500).end();
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(400).end();
  }

  // 簽章沒過一律 401 並直接結束，不做記 log 之外的任何動作——這支是全公開端點，
  // 沒有這道就是開放的 LLM 代理。
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(raw, signature, channelSecret)) {
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).end();
  }

  const events = Array.isArray(payload.events) ? payload.events : [];

  // 這一次 function 呼叫的死線（見 msLeft() 的說明）。從這裡起算——LINE 那邊的
  // reply token 也是 60 秒，兩個時鐘一起起跑最貼近實情。
  await requestCtx.run({ deadlineAt: Date.now() + REQUEST_BUDGET_MS, quoteToken: null }, async () => {
    // 依序處理、不平行——記者會現場的量級不需要平行處理，依序執行也不會讓同一批
    // webhook 裡的多個事件互搶 Anthropic／Sheets 配額。
    for (const ev of events) {
      if (isDuplicateDelivery(ev)) {
        console.log(`[line] 同一則事件第二次送達，略過 id=${ev.webhookEventId} redelivery=${!!ev.deliveryContext?.isRedelivery}`);
        continue;
      }
      // 這一則要引用的訊息（只有群組會用到，見 takeQuoteToken()）。每一則事件重設一次，
      // 前一則沒用掉的 token 不能漏到下一則的回覆上。
      const store = requestCtx.getStore();
      if (store) store.quoteToken = ev?.message?.quoteToken || null;
      try {
        await handleEvent(ev);
      } catch (e) {
        // 單一事件出錯不能讓整支回 500——LINE 收到非 2xx 會重送整批 webhook，
        // 容易在配額耗盡或 Anthropic 暫時出狀況時觸發重試風暴、雪上加霜。
        console.error('LINE 事件處理失敗:', e.message, ev?.type);
        await apologise(ev, e); // ⚠️ 記 log 不夠，記者那邊看到的是「已讀不回」，見該支的說明
      }
    }
  });

  return res.status(200).json({ ok: true });
}
