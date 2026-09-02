// LINE 自然語言意圖路由（批次 3）——沒有 #代碼綁定時，讓記者直接打活動名稱、
// 或問「最近有哪些活動」也能得到回應，不用先知道任何代碼。
//
// 一次 Haiku 呼叫同時判斷「這是查活動列表、問特定活動、還是其他」與「是哪一場」，
// 不額外多打一次 API。輸入只給行事曆摘要（id/名稱/日期/類型/有無資料），不給知識庫
// 全文——場次上看幾百場也就一兩萬 token，比對「上個月那場醫療的」這種模糊指涉也比
// 精準比對字串更準。不要為了「跨場次檢索」就想裝向量資料庫，場次規模用不到。

// events 表 F 欄有兩種既有格式：手動填的 "2026-07-08"，跟沒填日期時系統寫入的
// "2026/6/18 下午11:06:04"（建立時間戳記）。跟 api/event-page.js、public/index.html
// 的日期解析用同一套規則，三邊對日期的認定才會一致。
function parseEventDate(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(dt.getTime()) ? null : dt;
}
function toISODate(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// rows：api/line.js 的 getAllEventRows() 回傳的原始列（events!A2:O）。
export function buildAllCalendarCards(rows) {
  return (rows || [])
    .filter(r => r[0] && r[1])
    .map(r => ({
      id: r[0], name: r[1], status: r[4] || 'active',
      date: parseEventDate(r[5]), event_type: r[13] || '',
      has_kb: !!(r[3] && String(r[3]).trim())
    }));
}

// 記者版：draft／archived 一律不出現在這裡——跟 isUsable() 同一條規則，統一窗口讀
// 「所有場次」時，草稿與下架的場次不能被路由到、也不能出現在「最近有哪些活動」的清單裡。
// ⚠️ 職員模式（api/line.js 的 handleStaffMessage）不能用這支，要用上面的
// buildAllCalendarCards()——職員問得到 draft／archived，候選清單裡卻沒有那些場次的
// id，路由回傳的 id 會被 routeStaffIntent() 自己的白名單過濾掉，變成「查得到內容、
// 卻永遠比對不到活動」的怪 bug（批次 4 開發時真的踩到這個）。
export function buildCalendarCards(rows) {
  return buildAllCalendarCards(rows).filter(c => c.status !== 'draft' && c.status !== 'archived');
}

const VALID_INTENTS = ['calendar', 'qa', 'industry_trend', 'tech_query', 'other'];

// 回傳 { intent, event_ids, confidence }。任何失敗（沒 API key、Anthropic 出錯、
// JSON 解析不出來）一律退回 { intent: 'other', event_ids: [], confidence: 'low' }——
// 路由失敗不該讓記者卡住，呼叫端看到 'other' 會走安全的引導文案，不會誤觸問答。
//
// currentEventId（批次 16）：呼叫端目前綁定／軟綁定的場次，選填。這支本身沒有
// 對話記憶，一次只看單一句話 + 行事曆清單——「那合作廠商有哪些」這種依賴上一句
// 才聽得懂的合法續問，跟「友信你覺得呢」這種純聊天，在它眼裡是同一種「看不出跟
// 哪場活動有關」，一律會判成 other。給它「目前正在聊哪一場」這個提示之後，才分得
// 出「像是在延續這場的討論」跟「真的無關」的差別。
//
// 這是批次 14 群組續問視窗留下的坑：當時想直接拿 intent==='other' 當安靜門檻，
// 驗證後發現會連合法續問一起擋掉，只好先只做「明確 @ 別人」這個較窄的子集
// （見 LINE-PLAN.md 批次 14）。這個提示補上之後，呼叫端才能安全地把「其餘的
// other」也當安靜門檻用——見 api/line.js handleGroupMessage() 的說明。
export async function routeIntent(userText, cards, { currentEventId } = {}) {
  const fallback = { intent: 'other', event_ids: [], confidence: 'low', tech_keyword: '' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !cards.length) return fallback;

  const list = cards
    .slice()
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, 200) // 規模防線：實務上遠遠用不到，見 LINE-PLAN.md 坑 7 的規模討論
    .map(c => `${c.id}｜${c.name}｜${c.date ? toISODate(c.date) : '未排定'}｜${c.event_type || '—'}｜${c.has_kb ? '有資料' : '僅基本資料'}`)
    .join('\n');

  const systemPrompt = `你是記者會 LINE 問答系統的意圖判斷器。根據記者傳來的訊息，判斷屬於哪一種意圖，只回傳 JSON，不要有任何其他文字或說明。

意圖五選一：
- "calendar"：問活動列表、時程，例如「最近有哪些活動」「這個月有記者會嗎」——不是問特定一場的內容
- "qa"：在問某一場特定活動的內容，訊息裡有線索（活動全名、部分名稱、關鍵字、大約時間）指向下面清單中的某一場或幾場
- "industry_trend"：問整體產業趨勢、市場現況，不是在問工研院自己做過的技術或研發成果，例如「半導體最近有什麼趨勢」「AI 晶片產業現況如何」「機器人市場現在怎麼樣」——問的是外部市場、產業走向，不是特定機構的研發內容
- "tech_query"：問句裡明確提到「工研院」，問的是工研院自己在某項技術上的研發成果、進展、發表會、產品，例如「工研院在機器人技術上有什麼進展」「工研院有沒有做半導體封裝」「工研院最近的 AI 技術」——重點是問句本身點名工研院這個機構；訊息裡沒提到工研院、只是單純問某個技術或產業的趨勢／現況，就判成 "industry_trend"，不要用猜的
- "other"：閒聊、打招呼、政治或立場評論、與活動、產業趨勢、工研院技術都完全無關的問題、或訊息意義不明

判成 "tech_query" 時，另外從問句裡抽出一個簡短的技術關鍵字（例如「半導體」「機器人」「AI 晶片封裝」，2-6 個字，去掉「最近」「工研院」「有什麼」「新聞」「嗎」「呢」這類語助詞與泛稱），填進 "tech_keyword" 欄位——這個關鍵字會直接拿去查工研院官網的關鍵字搜尋，那邊是接近精準比對的搜尋，整句話（含語助詞、疑問句尾）常常查不到東西，只有抽出來的核心關鍵字查得到；其他意圖不需要這個欄位，留空字串即可。

以下是目前可查詢的活動清單（id｜名稱｜日期｜類型｜資料狀態），由新到舊：
${list}

只回傳這個格式的 JSON：
{"intent":"calendar|qa|industry_trend|tech_query|other","event_ids":["符合的活動 id，qa 才需要，從清單裡的 id 挑，最多 3 個，信心不足就多列幾個"],"tech_keyword":"tech_query 才需要，從問句抽出的簡短技術關鍵字","confidence":"high|low"}`;

  // currentEventId 的提示刻意不塞進上面那份 systemPrompt——那份逐 byte 穩定才吃
  // 得到下面的 ephemeral cache，這段因人而異，混進同一個快取區塊只會讓每個使用者
  // 的綁定狀態互相打散快取。獨立成第二個不快取的 system 區塊，大檔案（行事曆清單）
  // 的快取命中率不受影響，只多這一小段的 token 成本。
  const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  const currentEvent = currentEventId ? cards.find(c => c.id === currentEventId) : null;
  if (currentEvent) {
    system.push({
      type: 'text',
      text: `目前這個對話正在問的是「${currentEvent.name}」這一場。訊息如果沒有明確指向清單中的其他場次，但看起來像是在延續、追問這場活動的內容（即使沒有再提到活動名稱），請判成 "qa"，event_ids 填這一場的 id；如果訊息是在問整體產業趨勢、市場現況（不是這場活動本身的內容），請判成 "industry_trend"；如果訊息明確提到「工研院」、問的是工研院自己某項技術的研發成果（不是這場活動本身的內容），請判成 "tech_query"——這兩種都不要因為目前有綁定就硬塞成 "qa"；只有訊息明顯在聊完全無關的事、打招呼，才判為 "other"。`
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: String(userText || '').slice(0, 500) }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'router API 錯誤');

    const text = data.content?.[0]?.text || '';
    // 防呆：模型偶爾會在 JSON 前後多講幾句，抓第一個看起來像物件的區塊再解析
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);

    const intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'other';
    const validIds = new Set(cards.map(c => c.id));
    const event_ids = Array.isArray(parsed.event_ids)
      ? parsed.event_ids.filter(id => validIds.has(id)).slice(0, 3)
      : [];
    const confidence = parsed.confidence === 'high' ? 'high' : 'low';
    // 只在真的是 tech_query 時才採用抽出來的關鍵字——其餘意圖用不到，模型偶爾在
    // 不相關的意圖裡也塞了字串進這個欄位，不要照單全收。呼叫端（api/line.js）
    // 沒拿到關鍵字（空字串）時會退回原始問句，不是這支的責任去保證一定有值。
    const tech_keyword = intent === 'tech_query' ? String(parsed.tech_keyword || '').trim().slice(0, 40) : '';
    return { intent, event_ids, confidence, tech_keyword };
  } catch (e) {
    console.error('意圖路由失敗:', e.message);
    return fallback;
  }
}

// 回報的意見：LINE 上的「最近有哪些活動」原本連已經辦完的場次都列出來（【近期已結束】
// 那一段），滑一輪手機螢幕全被過去式塞滿，想找的是「現在／接下來要辦哪些場」。
//
// 篩選規則（不是單純比日期，見下面三種狀態的理由）：
//   - draft   一律留著。草稿是「還沒發生、需要有人去處理」的事，性質上更接近
//             「未來要做的事」而不是「已經結束」，職員版本來就要看得到才不會忘記發布。
//   - archived 一律濾掉。已下架代表「不再是日常清單該出現的東西」，真要找回來
//             走後台管理頁，不該占用這份給日常掃一眼用的快速清單。
//   - active／ended 只在「日期還沒到、或日期未定」時留著；日期已經過去的
//             （多半是忘記按「已結束」的 active，或本來就是 ended）直接濾掉，
//             這正是使用者想拿掉的「已結束」清單。
//   「日期未定」以前被歸進「已結束」那組，其實它根本還沒發生——一併修正歸類。
function isUpcomingCard(c, today) {
  if (c.status === 'draft') return true;
  if (c.status === 'archived') return false;
  return !c.date || c.date >= today;
}

// 排序：有日期的按日期先後排，日期未定的排在最後面（有明確時程的優先看得到）。
export function sortUpcoming(cards) {
  const today = startOfToday();
  return cards
    .filter(c => isUpcomingCard(c, today))
    .sort((a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity));
}

// 直接用行事曆資料組回覆，不呼叫 Anthropic，快又零成本。
export function formatCalendarReply(cards) {
  if (!cards.length) return '目前查無已公開的活動資料，建議直接洽新聞聯絡人。';

  const upcoming = sortUpcoming(cards);
  if (!upcoming.length) return '目前沒有排定中的活動，想問已經辦過的場次，直接打活動名稱即可。';

  // 記者版的 cards 永遠不含 draft／archived，🔒未發布 這個標籤不會出現；職員版
  // （buildAllCalendarCards）會，讓職員一眼看出哪幾場還沒發布。
  const fmt = c => {
    const tag = c.status === 'draft' ? '　🔒未發布' : '';
    return `・${c.date ? toISODate(c.date) : '日期未定'}　${c.name}${c.has_kb ? '' : '（僅基本資料）'}${tag}`;
  };
  const MAX = 8;
  const lines = ['【近期活動】'];
  upcoming.slice(0, MAX).forEach(c => lines.push(fmt(c)));
  if (upcoming.length > MAX) lines.push(`…還有 ${upcoming.length - MAX} 場`);

  lines.push('\n想問特定一場（含已結束的場次），直接打活動名稱即可。');
  return lines.join('\n');
}

// 給快速回覆按鈕用：只挑「有資料」的場次——沒有 kb 的場次點了按鈕也問不出內容，
// 不占按鈕位置（LINE 上限 13 顆，要留給問得出東西的）。
export function calendarQuickReplyItems(cards, limit = 8) {
  return sortUpcoming(cards.filter(c => c.has_kb)).slice(0, limit).map(c => c.name);
}
