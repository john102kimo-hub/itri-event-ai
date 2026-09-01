// 假的 Sheets／LINE／Anthropic，給 test-flow.mjs 用。
// events 欄位順序照 events!A2:R：A id, B name, C color, D kb, E status, F date,
// G chips, H images, I greeting, J organizer, K edit_code, L time, M venue, N type,
// O press_contact, P contacts（邀訪窗口分工）, Q invite_letter（媒體邀請函）,
// R invite_letter_chips（活動前快速提問）
export const state = {
  events: [
    ['quad', '經濟部四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】四足機器人…', 'ended', '2026-08-08', '重點\n應用', '', '', '工研院', 'code1', '', '', '', '王小明 03-1111111',
      '技術規格｜陳美玲｜03-1111111 分機9999｜lineid_amy\n新聞稿｜王小明｜03-1111111 分機1234', '', ''],
    ['semi', '半導體先進封裝技術發表會', '#0F9E7A', '【新聞稿】先進封裝…', 'active', '2026-09-20', '', '', '', '工研院', 'code2', '', '', '', '陳大文 03-2222222 分機5678', '', '', ''],
    ['med', '智慧醫療解決方案記者會', '#0F9E7A', '【新聞稿】智慧醫療…', 'active', '2026-10-01', '', '', '', '工研院', 'code3', '', '', '', '', '', '', ''],
    // 活動日期動態算「明天」，配合媒體邀請函測試（見 test-flow.mjs 情境 14）——不能寫死
    // 日期字串，不然這個 fixture 過幾個月就會變成「已過期」，測試會跟著失效。
    // chips（G 欄）刻意填一題「活動內容」問句，invite_letter_chips（R 欄）刻意填一題
    // 完全不同的「邀請函」問句——這樣才測得出來活動前記者看到的按鈕真的換了一組，
    // 不是剛好兩組長一樣。
    ['soon', '奈米材料前瞻應用發表會', '#0F9E7A', '【正式新聞稿】完整技術規格與時程…', 'active',
      (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
      '這場的技術突破是什麼？', 'https://example.com/photo.jpg', '', '工研院', 'code4', '', '', '', '',
      '', '【邀請函】誠摯邀請貴媒體蒞臨採訪本次記者會…', '邀請函內容是什麼？\n採訪申請方式？']
  ],
  bindings: new Map(),
  staff: [],                 // line_staff!A2:D 的列：userId | name | authorized_at | note
  richMenus: [],             // listRichMenus() 回傳的 [{richMenuId, name}]
  linkedMenus: new Map(),    // userId → richMenuId（per-user 連結）
  // 全域技術窗口分工（contacts_directory!A2，見 lib/contacts-directory.js）。
  // 格式：主題｜單位｜聯絡人｜電話｜LINE ID｜簡介，一行一組。
  contactsDirectory: [
    '生醫｜生醫所｜丁嘉琳｜03-1111111｜lineid_ding｜智慧醫療、醫材相關技術',
    '機械｜機械所｜林潔玲｜｜｜機械、自動化系統相關技術',
    '產業趨勢分析｜產科國際所｜朱則瑋｜0934-266-766｜｜產業趨勢分析、國際布局相關議題',
    '其他｜｜朱則瑋｜03-9999999｜｜找不到對應窗口時的綜合聯絡人'
  ].join('\n'),
  // lib/industry-trends.js 抓的 IEK 免費焦點清單——api/line.js 的 getIndustryTrendDigest()
  // 呼叫 fetchIndustryTrendDigest()，內部打 https://ieknet.iek.org.tw/...，這裡用
  // installFetchStub() 攔截並回傳這份假 HTML（結構節錄自實測的真實網站原始碼，
  // 見 test-industry-trends.mjs 開頭的說明）。iekFetchFail 設 true 可以模擬抓取失敗。
  iekHtml: `<div class="listItem row no-gutters"><article class="col-md-11 listText"><h2 class="g-font-weight-600"><a href="./rpt_more.aspx?actiontype=rpt&amp;indu_idno=0&amp;domain=2&amp;rpt_idno=997557802" title="IEK精華包：半導體先進封裝供需展望">IEK精華包：半導體先進封裝供需展望</a></h2><small class="date">2026/08/26</small><p> 先進封裝需求持續攀升，帶動測試與載板產能吃緊。 </p></article></div>`,
  iekFetchFail: false
};
export const sent = [];

// 只清假資料。api/line.js 那邊的模組層快取（eventsCache／lineUsersCache）從外面
// 碰不到，由 test-flow.mjs 的 freshModule() 重新 import 整支模組來清。
export function reset() {
  state.bindings.clear();
  state.staff.length = 0;
  state.richMenus.length = 0;
  state.linkedMenus.clear();
  state.iekFetchFail = false; // 個別情境會開這個旗標模擬抓取失敗，其餘情境要看到預設值
  sent.length = 0;
}

function bindingRows() {
  return [...state.bindings.entries()].map(([id, b]) => [
    id, b.event_id || '', b.media_name || '', b.bound_at ? String(b.bound_at) : '', String(Date.now()), b.note || '',
    b.groupSessionUntil ? String(b.groupSessionUntil) : ''
  ]);
}

// ── lib/sheets.js ────────────────────────────────────────────────────
export const sheets = {
  async readRange(range) {
    if (range.startsWith('events!')) return state.events.map(r => [...r]);
    if (range.startsWith('line_users!')) return bindingRows();
    if (range.startsWith('line_staff!')) return state.staff.map(r => [...r]);
    if (range.startsWith('contacts_directory!')) return state.contactsDirectory ? [[state.contactsDirectory]] : [];
    return [];
  },
  async appendRows(range, rows) {
    if (range.startsWith('line_users!')) {
      for (const r of rows) state.bindings.set(r[0], {
        event_id: r[1], media_name: r[2], bound_at: Number(r[3]), note: r[5],
        groupSessionUntil: r[6] ? Number(r[6]) : 0
      });
    }
    if (range.startsWith('line_staff!')) state.staff.push(...rows.map(r => [...r]));
    if (range.startsWith('events!')) state.events.push(...rows.map(r => [...r]));
  },
  async updateRange(range, values) {
    if (range === 'contacts_directory!A2') { state.contactsDirectory = values[0][0]; return; }
    // events!K12 這種單欄寫入（補編輯碼）。A=0 起算，K 是索引 10。
    const evM = range.match(/^events!([A-R])(\d+)(?::([A-R])(\d+))?$/);
    if (evM) {
      const row = state.events[Number(evM[2]) - 2];
      if (row) values[0].forEach((v, i) => { row[evM[1].charCodeAt(0) - 65 + i] = v; });
      return;
    }
    const staffM = range.match(/^line_staff!([A-E])(\d+)(?::([A-E])(\d+))?$/);
    if (staffM) {
      const row = state.staff[Number(staffM[2]) - 2];
      if (row) values[0].forEach((v, i) => { row[staffM[1].charCodeAt(0) - 65 + i] = v; });
      return;
    }
    const m = range.match(/^line_users!([A-G])(\d+)(?::([A-G])(\d+))?$/);
    if (!m) return;
    const rowNum = Number(m[2]);
    const keys = [...state.bindings.keys()];
    const userId = keys[rowNum - 2];
    if (!userId) return;
    const b = state.bindings.get(userId);
    const startCol = m[1].charCodeAt(0) - 65;
    const row = values[0];
    // 欄位對應：0=id 1=event_id 2=media_name 3=bound_at 4=last_active 5=note 6=group_session_until
    row.forEach((v, i) => {
      const col = startCol + i;
      if (col === 1) b.event_id = v;
      if (col === 2) b.media_name = v;
      if (col === 3) b.bound_at = v === '' ? 0 : Number(v);
      if (col === 5) b.note = v;
      if (col === 6) b.groupSessionUntil = v === '' ? 0 : Number(v);
    });
  },
  // 回傳空陣列＝「分頁本來就存在」，不觸發 lib/contacts-directory.js 的
  // 「剛建立就種預設名單」那段——測試要用的是上面 state.contactsDirectory 那份
  // 固定小名單，不是正式站的完整種子內容。
  async ensureSheets() { return []; }
};

// ── lib/line.js（只換掉會對外送東西的那幾支）─────────────────────────
export const line = {
  async replyOrPush(replyToken, userId, text, quickReplyItems) {
    sent.push({ kind: 'text', text, quickReply: quickReplyItems || [] });
    return true;
  },
  async replyOrPushMessages(replyToken, userId, messages) { sent.push({ kind: 'flex', messages }); return true; },
  async startLoading() {},
  async pushImages() { return { ok: true, skipped: true }; },
  async createRichMenu() { return 'rm_fake'; },
  async uploadRichMenuImage() { return true; },
  async setDefaultRichMenu() { return true; },
  async listRichMenus() { return state.richMenus; },
  async deleteRichMenu() { return true; },
  async linkRichMenuToUser(userId, id) { state.linkedMenus.set(userId, id); return true; },
  async unlinkRichMenuFromUser(userId) { state.linkedMenus.delete(userId); return true; },
  async pushChartImage(userId, url) {
    if (!url) return { ok: true, skipped: true };
    sent.push({ kind: 'chart', url });
    return { ok: true };
  },
  async getProfile() { return null; }
};

// ── 假的意圖路由 ─────────────────────────────────────────────────────
// routeStaffIntent()／routeIntent() 真的會打 Anthropic，測試裡要換掉。
//
// ⚠️ 這份對照表是「假設模型會這樣判」，不是在測模型判得準不準（那要靠真的跑）。
// 它存在的目的，是讓 handleStaffMessage() 拿到一組固定的路由結果，好驗證**它自己**
// 的邏輯——尤其是「追問哪一場」那段狀態承接。回報的 bug 正是出在這裡：模型把
// 「四足」判成 qa 其實完全合理，錯的是沒有人記得上一句在問什麼。
const EVENT_KEYWORDS = {
  quad: ['四足', '機器人', '經濟部'],
  semi: ['半導體', '封裝'],
  med: ['醫療'],
  soon: ['奈米材料', '前瞻應用']
};

function matchEventIds(text) {
  return Object.entries(EVENT_KEYWORDS)
    .filter(([id, kws]) => {
      const name = state.events.find(e => e[0] === id)?.[1] || '';
      return (name && text.includes(name)) || kws.some(k => text.includes(k));
    })
    .map(([id]) => id);
}

function fakeStaffRoute(text) {
  const ids = matchEventIds(text);
  const base = { event_ids: ids, new_event_name: '', new_event_date: '', confidence: 'high' };
  if (/設定圖文選單/.test(text)) return { ...base, intent: 'setup_richmenu', event_ids: [] };
  if (/GEO/i.test(text)) return { ...base, intent: 'geo_status', event_ids: [] };
  if (/後台數據|問答統計|成效/.test(text)) return { ...base, intent: 'event_analytics' };
  if (/媒體訓練/.test(text)) return { ...base, intent: 'training_link' };
  if (/新增活動|建立活動/.test(text)) return { ...base, intent: 'create_event', event_ids: [] };
  if (/最近|哪些活動|活動列表/.test(text)) return { ...base, intent: 'calendar', event_ids: [] };
  if (ids.length) return { ...base, intent: 'qa' };
  return { ...base, intent: 'other', confidence: 'low' };
}

// currentEventHint：批次 16，模擬 lib/router.js routeIntent() 多的 currentEventId
// 提示——沒有其他場次的線索、也不是查活動列表時，「看起來像是在延續目前這場」
// 還是「真的無關」。這裡不是要精準模擬真的 LLM 判斷（那要看真的跑），只用夠讓
// 測試分得清楚「續問視窗合法追問」跟「回報案例的閒聊」兩種情況的簡單規則：
// 文字裡出現「你覺得」這種問別人主觀意見的語氣，判定跟活動無關；否則當作延續。
// 產業趨勢題的判斷放在活動關鍵字之前——真的遇到「半導體」這種同時可能是活動
// 關鍵字（quad 場次沒有，但避免以後加了活動撞到）也可能是產業趨勢問題的字，
// 「趨勢／市場現況／產業現況」這種明確詞優先判成 industry_trend，比較貼近
// lib/router.js 系統提示裡「跟清單中任何一場都無關」的判斷精神。
function fakeReporterRoute(text, currentEventHint) {
  const ids = matchEventIds(text);
  if (/最近|哪些活動|活動列表/.test(text)) return { intent: 'calendar', event_ids: [], confidence: 'high' };
  if (/趨勢|市場現況|產業現況/.test(text)) return { intent: 'industry_trend', event_ids: [], confidence: 'high' };
  if (ids.length) return { intent: 'qa', event_ids: ids, confidence: 'high' };
  if (currentEventHint && !/你覺得/.test(text)) return { intent: 'qa', event_ids: [currentEventHint], confidence: 'high' };
  return { intent: 'other', event_ids: [], confidence: 'low' };
}

// answerQuestion 也是走 fetch → Anthropic，這裡一併攔掉，比替換整支 askAnthropic 乾淨。
export function installFetchStub() {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      const sys = body.system?.[0]?.text || '';
      // routeIntent() 的 currentEventId 提示是獨立的第二個 system 區塊（見
      // lib/router.js 的說明，刻意不塞進第一塊以免打散 ephemeral cache）——
      // 從那段話裡把活動名稱抓出來，反查回 id 給 fakeReporterRoute() 用。
      const sysHint = body.system?.[1]?.text || '';
      const hintName = sysHint.match(/目前這個對話正在問的是「(.+?)」/)?.[1];
      const currentEventHint = hintName ? state.events.find(e => e[1] === hintName)?.[0] : null;
      const userText = body.messages?.[0]?.content || '';

      // 路由呼叫跟問答呼叫都打同一個端點，用 system prompt 的特徵分辨
      const json = o => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(o) }] }) });
      if (sys.includes('內部職員助理')) return json(fakeStaffRoute(userText));
      if (sys.includes('意圖判斷器')) return json(fakeReporterRoute(userText, currentEventHint));

      // 問答：system prompt 裡會帶該場的知識庫，從中反推是哪一場回答的。
      // sys 一併存起來——媒體邀請函測試要驗證 system prompt 裡到底帶的是正式新聞稿
      // 還是邀請函內容，不能只看「有沒有回答」。
      const ev = state.events.find(e => sys.includes(e[1]))?.[0] || 'unknown';
      sent.push({ kind: 'answer', event: ev, text: '（假回答）', sys });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '（假回答）' }] }) };
    }
    // lib/industry-trends.js fetchIndustryTrendDigest() 打的 IEK 免費焦點清單頁。
    if (u.includes('ieknet.iek.org.tw')) {
      if (state.iekFetchFail) return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
      return { ok: true, text: async () => state.iekHtml || '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
}
installFetchStub();
