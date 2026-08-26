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
// draft／archived 一律不出現在這裡——跟 isUsable() 同一條規則，統一窗口讀「所有場次」
// 時，草稿與下架的場次不能被路由到、也不能出現在「最近有哪些活動」的清單裡。
export function buildCalendarCards(rows) {
  return (rows || [])
    .filter(r => r[0] && r[1] && r[4] !== 'draft' && r[4] !== 'archived')
    .map(r => ({
      id: r[0], name: r[1], status: r[4] || 'active',
      date: parseEventDate(r[5]), event_type: r[13] || '',
      has_kb: !!(r[3] && String(r[3]).trim())
    }));
}

const VALID_INTENTS = ['calendar', 'qa', 'other'];

// 回傳 { intent, event_ids, confidence }。任何失敗（沒 API key、Anthropic 出錯、
// JSON 解析不出來）一律退回 { intent: 'other', event_ids: [], confidence: 'low' }——
// 路由失敗不該讓記者卡住，呼叫端看到 'other' 會走安全的引導文案，不會誤觸問答。
export async function routeIntent(userText, cards) {
  const fallback = { intent: 'other', event_ids: [], confidence: 'low' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !cards.length) return fallback;

  const list = cards
    .slice()
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, 200) // 規模防線：實務上遠遠用不到，見 LINE-PLAN.md 坑 7 的規模討論
    .map(c => `${c.id}｜${c.name}｜${c.date ? toISODate(c.date) : '未排定'}｜${c.event_type || '—'}｜${c.has_kb ? '有資料' : '僅基本資料'}`)
    .join('\n');

  const systemPrompt = `你是記者會 LINE 問答系統的意圖判斷器。根據記者傳來的訊息，判斷屬於哪一種意圖，只回傳 JSON，不要有任何其他文字或說明。

意圖三選一：
- "calendar"：問活動列表、時程，例如「最近有哪些活動」「這個月有記者會嗎」——不是問特定一場的內容
- "qa"：在問某一場特定活動的內容，訊息裡有線索（活動全名、部分名稱、關鍵字、大約時間）指向下面清單中的某一場或幾場
- "other"：閒聊、打招呼、政治或立場評論、與活動完全無關的問題、或訊息意義不明

以下是目前可查詢的活動清單（id｜名稱｜日期｜類型｜資料狀態），由新到舊：
${list}

只回傳這個格式的 JSON：
{"intent":"calendar|qa|other","event_ids":["符合的活動 id，qa 才需要，從清單裡的 id 挑，最多 3 個，信心不足就多列幾個"],"confidence":"high|low"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        // 這份清單在 60 秒快取視窗內逐 byte 穩定，加 ephemeral cache 跟 api/chat.js
        // 同一招，記者連續發問時路由這段幾乎不花錢。
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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
    return { intent, event_ids, confidence };
  } catch (e) {
    console.error('意圖路由失敗:', e.message);
    return fallback;
  }
}

// 直接用行事曆資料組回覆，不呼叫 Anthropic，快又零成本。
export function formatCalendarReply(cards) {
  if (!cards.length) return '目前查無已公開的活動資料，建議直接洽新聞聯絡人。';

  const today = startOfToday();
  const upcoming = cards.filter(c => c.date && c.date >= today).sort((a, b) => a.date - b.date);
  const past = cards.filter(c => !c.date || c.date < today).sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  const fmt = c => `・${c.date ? toISODate(c.date) : '日期未定'}　${c.name}${c.has_kb ? '' : '（僅基本資料）'}`;
  const MAX_UPCOMING = 5, MAX_PAST = 3;
  const lines = [];

  if (upcoming.length) {
    lines.push('【近期活動】');
    upcoming.slice(0, MAX_UPCOMING).forEach(c => lines.push(fmt(c)));
    if (upcoming.length > MAX_UPCOMING) lines.push(`…還有 ${upcoming.length - MAX_UPCOMING} 場`);
  }
  if (past.length) {
    lines.push(upcoming.length ? '\n【近期已結束】' : '【近期已結束】');
    past.slice(0, MAX_PAST).forEach(c => lines.push(fmt(c)));
    if (past.length > MAX_PAST) lines.push(`…還有 ${past.length - MAX_PAST} 場`);
  }

  lines.push('\n想問特定一場，直接打活動名稱即可。');
  return lines.join('\n');
}
