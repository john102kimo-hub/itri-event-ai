// 記者端的「跳出本場」意圖、使用說明文案、歡迎圖卡、圖文選單定義。
//
// 為什麼這裡的意圖判斷是純關鍵字、不呼叫 AI：
// lib/router.js 那支 routeIntent() 只在「沒有綁定」時跑一次，成本可以接受。但綁定
// 之後每一則訊息都是正式提問，如果為了判斷「這句是不是想換一場」而在每則問題前面
// 多打一次 Haiku，等於把所有記者的每一次提問都變慢、也多一份帳單，而真正會用到的
// 只有極少數幾句。這幾句又剛好都是我們自己控制的字串（圖文選單與快速回覆按鈕送出
// 的就是下面這些詞），關鍵字比對可以 100% 命中，不需要語意理解。
//
// 誤判的方向也刻意選過：寧可漏判（記者的「換一場」沒被認出來 → 當成提問，AI 會說
// 這場資料裡沒有，記者再打一次即可），也不要誤判（真正的提問被當成指令 → 記者的
// 問題從沒被回答，就是 handleEvent 裡 ask_name 那個已經修過一次的坑）。所以下面
// 每條規則都往「嚴格」的方向調。

// 問活動列表。「最近活動」「其他活動」「有哪些場次」都算。
// 第一段刻意要求時間／範圍詞（最近、其他、所有…）緊接著活動類詞，才不會把
// 「這場活動的重點」這種正常提問吃掉。
const CALENDAR_RE = /(最近|近期|其他|其它|別的|所有|全部|還有|之後|未來)\s*(有哪些|有什麼|哪些|什麼)?\s*(活動|場次|記者會)|(活動|場次)\s*(列表|清單|一覽|行事曆)|(有哪些|有什麼)\s*(活動|場次|記者會)/;

// 想換一場。沒有「換」「切換」這類動詞就不算——只打「別場」不會誤觸。
const SWITCH_RE = /(換|切換|改)\s*(成|到)?\s*(一)?\s*(場|個|別場|其他場|其它場)|(換|切換)\s*(活動|記者會|場次)|重新選擇|不是這場|不是問這場|解除綁定|離開這場/;

// 使用說明。這條最容易誤傷（「這技術怎麼用」也含「怎麼用」），所以只認
// 「整句就是在問怎麼用」的完全比對，外加明確指名這個帳號／機器人的問法。
const HELP_EXACT_RE = /^(說明|使用說明|操作說明|help|怎麼用|要怎麼用|該怎麼用|怎麼使用|如何使用|使用方式|功能|有什麼功能|教學|使用教學|新手教學|不會用|不知道怎麼用)[?？!！。]?$/i;
// 「你」「這裡」這兩個指稱太寬（記者也可能拿來指技術本身），所以這條要求「問句到此為止」——
// 用 $ 錨在結尾，而不是限制長度。差別就在動詞後面還有沒有東西：
//   「你要怎麼用」「這個帳號怎麼用」→ 在問這個帳號的用法，命中
//   「你怎麼用這套資料判斷哪家廠商有優勢」→ 動詞後面還接著受詞，是在問內容，不命中
const HELP_ABOUT_BOT_RE = /(這個(帳號|機器人|助理)|小幫手|小特派|你|這裡)\s*(要|該)?\s*(怎麼|如何)\s*(用|使用|操作|開始|發問|提問)[?？!！。]?$/;

// 實際回報的答非所問：群組裡 @ 問「妳能幫我什麼」，因為不含「怎麼／如何」，
// HELP_ABOUT_BOT_RE 接不住，掉進 routeIntent()，被判成 other，回一句「不確定您
// 想問哪一場活動」——記者問的明明是「你能做什麼」，卻拿到一句跟問題完全對不上的
// 回覆。這條專門接「能力題」（你/妳 能／可以／會 做什麼），跟 HELP_ABOUT_BOT_RE
// 同一個保守原則：$ 錨在結尾，只認「問句到此為止」的完整短句，「你能不能查一下
// 這場記者會幾點開始」這種問句後面還接著具體內容的正常提問不會誤觸。
//
// 實際回報的第二種落空：群組續問視窗內（沒有再 @）打「你能做啥」，完全沒有任何
// 回覆——不是續問視窗本身沒接住（見 handleGroupEvent() 的說明，那段是好的），是
// 這句話用口語的「啥」代替「什麼」，原本只認「什麼｜哪些」的必要群組沒對到，一樣
// 掉進 routeIntent() 被判成 other；群組裡沒被直接 @ 到時，other 是安靜門檻
// （silentOnOther，見 handleUnbound() 的說明），於是變成「看起來像沒接住續問視窗」
// 的假象，其實是這句話從一開始就沒被 detectMetaIntent() 認出來是在問能力。把「啥」
// 併進同一個必要群組即可，跟「什麼／哪些」同樣要求問句到此為止，不會擴大誤觸範圍。
const HELP_CAPABILITY_RE = /^(你|妳|這個(帳號|機器人|助理)|小幫手|小特派)\s*(能|可以|會)\s*(幫我|幫上|提供|回答|做)?\s*(什麼|哪些|啥)(忙|事|功能|服務)?(嗎|呢)?[?？!！～~。]?$/;
// 問「你是誰」「妳是什麼」——第一次遇到這個帳號時很自然會問的開場白，跟能力題
// 一樣不該落到「不確定您想問哪一場活動」這種答非所問的萬用回覆。
const HELP_WHOAMI_RE = /^(你|妳)\s*是(誰|什麼|哪位|做什麼的|什麼的)(嗎|呢)?[?？!！～~。]?$/;

// 邀訪聯絡窗口。這句幾乎只會來自「媒體邀訪需求」這顆固定按鈕（見 api/line.js 的
// eventQuickChips()），所以用完全比對——記者正常提問不會整句剛好等於這幾個詞。
const CONTACT_EXACT_RE = /^(媒體邀訪需求|邀訪需求|邀訪|聯絡窗口|聯繫窗口|窗口分工|媒體聯絡|採訪窗口)[?？!！。]?$/;

// 回報的意見：1 對 1 圖文選單、群組快速回覆都要加「產業趨勢分析」「想問什麼技術」
// 這兩個入口，也要讓記者不用按按鈕、直接打這幾個字也叫得動——跟 CONTACT_EXACT_RE
// 同一個道理，用完全比對，因為這幾句幾乎只會來自固定按鈕，記者正常提問不會整句
// 剛好等於這幾個詞。
//
// 兩條命中之後的處理方式不一樣（實際邏輯在 api/line.js 的 handleMetaIntent()）：
// INDUSTRY_TREND_EXACT_RE 命中直接答（資料來源是 IEK 產業情報網，見
// lib/industry-trends.js）；TECH_QUERY_EXACT_RE 命中不是直接答，是先問「想了解
// 哪一項技術」，等記者打技術名稱才真的去查（資料來源是工研院官網新聞中心，見
// lib/itri-news.js）——兩邊資料源、回答方式都不同，特意分成兩個按鈕、兩條路，不要
// 為了少一顆按鈕硬併成一個。
const INDUSTRY_TREND_EXACT_RE = /^(產業趨勢分析|產業趨勢|最近趨勢|最新趨勢)[?？!！。]?$/;
const TECH_QUERY_EXACT_RE = /^(想問什麼技術|工研院技術|技術詢問)[?？!！。]?$/;

// 提問語氣的開頭詞——用來擋掉「把一句問題誤認成活動名稱」。跟 api/line.js 的
// looksLikeNameOrSkip() 是同一類防線，但那支管的是媒體名稱，這支管的是活動名稱，
// 兩邊的誤判後果不同（那邊是少記一個媒體名，這邊是整個換錯場次），所以分開維護。
const QUESTION_LEAD_RE = /^(請問|為什麼|為何|什麼|怎麼|如何|哪裡|哪一|哪些|何時|多少|是否|能不能|可不可以|可以|會不會|有沒有|給我|請給|麻煩|幫我|提供|想問|想知道|想要|需要|介紹|說明一下)/;

// 回傳 'calendar' | 'switch' | 'help' | 'contacts' | 'industry_trend' | 'tech_query' | null。
// 順序有意義：help／contacts／industry_trend／tech_query 用完全比對最嚴格，先判；
// calendar 跟 switch 互斥度高，誰先都行。
export function detectMetaIntent(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (HELP_EXACT_RE.test(s) || HELP_ABOUT_BOT_RE.test(s) || HELP_CAPABILITY_RE.test(s) || HELP_WHOAMI_RE.test(s)) return 'help';
  if (CONTACT_EXACT_RE.test(s)) return 'contacts';
  if (INDUSTRY_TREND_EXACT_RE.test(s)) return 'industry_trend';
  if (TECH_QUERY_EXACT_RE.test(s)) return 'tech_query';
  if (SWITCH_RE.test(s)) return 'switch';
  if (CALENDAR_RE.test(s)) return 'calendar';
  return null;
}

// 活動名稱比對用的正規化：拿掉空白與各種括號、標點，這樣「經濟部四足機器人
// 國產研發平台發表記者會」跟記者手打的「經濟部四足機器人 國產研發平台發表記者會」
// 會是同一個字串。不做繁簡轉換——場次名稱都是繁體，多這層只會多一個出錯的地方。
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　「」『』《》〈〉()（）[\]【】{}，,、。.!！?？:：;；~～\-—_|｜'"'']/g, '');
}

// 訊息「整句就是某一場活動的名稱」時回傳那張卡片，否則 null。
// 綁定中的記者打了別場名稱（多半是按了活動清單的快速回覆按鈕，那顆按鈕送出的
// 就是完整活動名稱）要能直接換過去，不然他會被鎖在原本那場、怎麼打都沒反應。
//
// 判斷刻意保守，寧可不換也不要換錯：
//   - 有問號、或用疑問詞開頭 → 這是提問不是選台，直接放棄
//   - 正規化後短於 6 個字 → 「半導體」這種詞太容易同時是提問內容，不當作選台
//   - 命中超過一場 → 不猜，交給呼叫端去問記者是哪一場
export function matchEventByName(text, cards, excludeId) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return null;
  if (/[?？]/.test(raw)) return null;
  if (QUESTION_LEAD_RE.test(raw)) return null;

  const q = normalizeName(raw);
  if (q.length < 6) return null;

  const pool = (cards || []).filter(c => c && c.id && c.id !== excludeId);

  // 完全相同優先：快速回覆／圖文選單按鈕送出的就是完整名稱，這條會命中
  const exact = pool.filter(c => normalizeName(c.name) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // 記者只打得出部分名稱時的退路
  const partial = pool.filter(c => normalizeName(c.name).includes(q));
  return partial.length === 1 ? partial[0] : null;
}

// ── 使用說明 ─────────────────────────────────────────────────────────
// 圖文選單、歡迎圖卡、以及記者直接問「怎麼用」三個入口共用同一份，改文案只改這裡。
// 結尾兩句（引用免責、個資告知）是 LINE-PLAN.md 第 8 節第 6 點要求的，不要拿掉。
export const HELP_TEXT = [
  '嗨，我是米亞 🙂 來跟您說說怎麼使用這個帳號～',
  '',
  '【怎麼使用這個帳號】',
  '這裡可以直接問記者會的內容，我會用主辦單位提供的新聞資料回答您。',
  '',
  '① 先選一場活動',
  '　掃描現場的 QR code，或直接輸入活動名稱。',
  '　不知道有哪些場次，就問我「最近有哪些活動」。',
  '',
  '② 直接問問題',
  '　例如：這場的重點是什麼／有哪些合作廠商／',
  '　技術規格／新聞聯絡人是誰。',
  '　想要新聞照片，就打「給我照片」。',
  '　想找對應的邀訪窗口，打「媒體邀訪需求」就可以。',
  '',
  '③ 想換一場',
  '　隨時輸入「換一場活動」，或直接打另一場的名稱。',
  '',
  '內容僅供參考，正式引用請以主辦單位官網新聞稿或現場發言為準。本帳號會記錄您的提問內容以改善新聞服務，不會蒐集您的個人資料。'
].join('\n');

// ── 歡迎圖卡（Flex Message）───────────────────────────────────────────
// 加好友當下只有一次機會講清楚「這是什麼、怎麼開始」。純文字會被滑過去，
// 圖卡的三步驟加兩顆按鈕讓記者可以直接點，不用先想要打什麼。
// 不放圖片（hero）：活動照片每場都不一樣，放固定圖只會讓卡片看起來像廣告；
// 純文字排版的卡片在 LINE 裡反而更像「系統說明」，也不用維護一張圖。
const BRAND = '#0F9E7A'; // 跟後台、記者前台同一個主色（events 表 color 欄的預設值）

// 一列步驟：左邊圓形號碼、右邊標題與說明。
// Flex 沒有「圓形」這種容器，圓號碼是用固定寬高的 box + cornerRadius 取一半做出來的。
function numberedStep(no, title, desc) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'lg',
    contents: [
      {
        type: 'box', layout: 'vertical', width: '22px', height: '22px', flex: 0,
        backgroundColor: BRAND, cornerRadius: '11px', justifyContent: 'center',
        contents: [{ type: 'text', text: no, size: 'xs', color: '#FFFFFF', weight: 'bold', align: 'center' }]
      },
      {
        type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
        contents: [
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: '#1A1A2E', wrap: true },
          { type: 'text', text: desc, size: 'xs', color: '#6B7280', wrap: true }
        ]
      }
    ]
  };
}

// action 一律用 message 型別：點下去等同記者自己打那句話，會走跟手打完全一樣的
// 路由，不用為按鈕另外維護一套 postback 分支（跟 lib/line.js buildQuickReply 同一個理由）。
function actionButton(label, text, primary) {
  return {
    type: 'button', height: 'sm',
    style: primary ? 'primary' : 'secondary',
    color: primary ? BRAND : undefined,
    action: { type: 'message', label, text }
  };
}

// 「米亞」是這個帳號的人設名字（使用者定的，見對話紀錄）——只出現在這張歡迎卡跟
// altText，不動 lineExtraRules／system prompt 那邊的回答語氣，範圍刻意收窄：
// 使用者只要求改歡迎卡，不是整個帳號的人格重寫。
export function buildWelcomeFlex(organizer = '') {
  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '18px', spacing: 'xs',
      contents: [
        { type: 'text', text: '嗨，我是米亞 👋', size: 'lg', weight: 'bold', color: '#FFFFFF' },
        {
          type: 'text', wrap: true, size: 'xs', color: '#D8F3EA',
          text: organizer ? `${organizer}記者會 AI 新聞助理` : '工研院記者會 AI 新聞助理'
        }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'none',
      contents: [
        {
          type: 'text', wrap: true, size: 'sm', color: '#6B7280',
          text: '近期所有工研院記者會資訊、媒體邀訪窗口，都能直接問我'
        },
        { type: 'box', layout: 'vertical', margin: 'lg', contents: [
          numberedStep('1', '點選近期活動', '選你想了解的那一場'),
          numberedStep('2', '直接打字，或點下方關鍵字', '活動前給基本資訊，活動當天新聞稿、照片都有'),
          numberedStep('3', '想換一場', '打「換一場活動」隨時切換')
        ]},
        { type: 'separator', margin: 'xl' },
        {
          type: 'text', margin: 'lg', wrap: true, size: 'xxs', color: '#9CA3AF',
          text: '內容僅供參考，正式引用請以主辦單位官網新聞稿或現場發言為準。本帳號會記錄提問內容以改善新聞服務，不會蒐集您的個人資料。'
        }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
      contents: [
        actionButton('看看最近有哪些活動', '最近有哪些活動', true),
        actionButton('詳細使用說明', '使用說明', false)
      ]
    }
  };

  // altText 是通知列與不支援 Flex 的環境會看到的字，不能只寫「歡迎」——
  // 記者在鎖定畫面只看得到這行，要能自成一句有用的話。
  return {
    type: 'flex',
    altText: '嗨，我是米亞！工研院記者會 AI 新聞助理，掃現場 QR code 或直接打活動名稱就能開始提問。',
    contents: bubble
  };
}

// ── 圖文選單定義 ─────────────────────────────────────────────────────
// 2500x1686 是 LINE 的大版尺寸（另一種是 2500x843 的精簡版）。用大版是因為六格
// 才放得下記者與同仁各自真正會用到的功能——精簡版三格擺不下，使用者得先知道
// 「還可以打什麼」才用得到其餘功能，那就失去降低上手成本的意義了。
//
// ⚠️ 為什麼要分成兩套選單、而不是一套共用：
// 職員那六格裡有「新增一場活動」「後台數據」「GEO 狀態」，這些是內部操作。
// 一套共用的選單等於把內部功能的入口攤在每一個記者眼前——就算他按下去會因為
// 沒有職員身分而被擋掉，也已經洩漏了這個帳號背後有哪些內部功能。所以改用 LINE 的
// per-user rich menu：預設所有人是記者選單，密語登入後才把該 userId 換成職員選單，
// 退出職員模式時解除連結、自動落回記者選單。
//
// 按鈕送出的文字必須能被對應的路由認出來（記者版是 detectMetaIntent()，職員版是
// lib/staff.js 的 routeStaffIntent()／isExitStaffCommand()）。改文案要一起改，
// 否則會變成「按了沒反應」——test/test-menu.mjs 有守這件事。
export const RICH_MENU_SIZE = { width: 2500, height: 1686 };

// 回報的意見：把「使用說明」「活動照片」換成「想問什麼技術」「產業趨勢分析」——
// 六格是稀缺資源，記者更常需要的是問工研院技術／產業趨勢這兩個新入口。換掉的
// 兩個都沒有真的消失：「使用說明」還是隨時打這幾個字就叫得出來（HELP_EXACT_RE
// 等既有規則沒動），「活動照片」也還是打「給我照片」就問得到（looksLikePhotoRequest()
// 在 api/line.js，不綁定這顆按鈕的固定文字），只是不再佔固定選單的一格。
export const REPORTER_MENU = {
  key: 'reporter',
  name: '記者主選單',
  chatBarText: '功能選單', // 選單收起來時輸入框上方那條的文字（上限 14 字）
  buttons: [
    { icon: '📅', label: '最近有哪些活動', sub: '看場次清單',       text: '最近有哪些活動' },
    { icon: '🔄', label: '換一場活動',     sub: '切換問答場次',     text: '換一場活動' },
    { icon: '🔬', label: '想問什麼技術',   sub: '查工研院技術',     text: '想問什麼技術' },
    { icon: '📄', label: '新聞稿全文',     sub: '取得完整內容',     text: '給我完整新聞稿' },
    { icon: '📊', label: '產業趨勢分析',   sub: '查產業動態',       text: '產業趨勢分析' },
    { icon: '📞', label: '媒體邀訪需求',   sub: '找聯絡窗口',       text: '媒體邀訪需求' }
  ]
};

// 下面三顆（新增活動／後台數據／媒體訓練連結）刻意不帶活動名稱：routeStaffIntent()
// 判出意圖但沒有 event_id 時，會回一句「請問是想查哪一場？」，比要求同仁自己記得
// 「查○○場的後台數據」這種完整句型好用。
export const STAFF_MENU = {
  key: 'staff',
  name: '職員主選單',
  chatBarText: '職員選單',
  buttons: [
    { icon: '📅', label: '活動列表',       sub: '含未發布場次',   text: '最近有哪些活動' },
    { icon: '➕', label: '新增一場活動',   sub: '給同仁編輯連結', text: '新增活動' },
    { icon: '📊', label: '後台數據',       sub: '問答統計',       text: '查活動後台數據' },
    { icon: '🎓', label: '媒體訓練連結',   sub: '發言練習',       text: '要媒體訓練連結' },
    { icon: '📈', label: 'GEO 狀態',       sub: 'AI 能見度掃描',  text: 'GEO現在狀況' },
    { icon: '🚪', label: '退出職員模式',   sub: '回到記者身分',   text: '退出職員模式' }
  ]
};

export const ALL_MENUS = [REPORTER_MENU, STAFF_MENU];

// 六格排成 2 列 3 欄。除不盡的餘數補進每列最後一格／最後一列，不然邊緣會留下
// 一條點不到的空白。
export function buildRichMenuDefinition(menu) {
  const COLS = 3, ROWS = 2;
  const { width, height } = RICH_MENU_SIZE;
  const cw = Math.floor(width / COLS);
  const ch = Math.floor(height / ROWS);

  return {
    size: { ...RICH_MENU_SIZE },
    selected: true, // 一進聊天室就把選單展開，不用先去按那個小箭頭
    name: menu.name,
    chatBarText: menu.chatBarText,
    areas: menu.buttons.slice(0, COLS * ROWS).map((b, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      return {
        bounds: {
          x: col * cw,
          y: row * ch,
          width: col === COLS - 1 ? width - col * cw : cw,
          height: row === ROWS - 1 ? height - row * ch : ch
        },
        action: { type: 'message', label: b.label.slice(0, 20), text: b.text }
      };
    })
  };
}
