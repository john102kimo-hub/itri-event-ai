// 假的 Sheets／LINE／Anthropic，給 test-flow.mjs 用。
// events 欄位順序照 events!A2:O：A id, B name, C color, D kb, E status, F date,
// G chips, H images, I greeting, J organizer, K edit_code, L time, M venue, N type, O contact
export const state = {
  events: [
    ['quad', '經濟部四足機器人國產研發平台發表記者會', '#0F9E7A', '【新聞稿】四足機器人…', 'ended', '2026-08-08', '重點\n應用', '', '', '工研院', 'code1', '', '', '', ''],
    ['semi', '半導體先進封裝技術發表會', '#0F9E7A', '【新聞稿】先進封裝…', 'active', '2026-09-20', '', '', '', '工研院', 'code2', '', '', '', ''],
    ['med', '智慧醫療解決方案記者會', '#0F9E7A', '【新聞稿】智慧醫療…', 'active', '2026-10-01', '', '', '', '工研院', 'code3', '', '', '', '']
  ],
  bindings: new Map(),
  staff: [],                 // line_staff!A2:D 的列：userId | name | authorized_at | note
  richMenus: [],             // listRichMenus() 回傳的 [{richMenuId, name}]
  linkedMenus: new Map()     // userId → richMenuId（per-user 連結）
};
export const sent = [];

// 只清假資料。api/line.js 那邊的模組層快取（eventsCache／lineUsersCache）從外面
// 碰不到，由 test-flow.mjs 的 freshModule() 重新 import 整支模組來清。
export function reset() {
  state.bindings.clear();
  state.staff.length = 0;
  state.richMenus.length = 0;
  state.linkedMenus.clear();
  sent.length = 0;
}

function bindingRows() {
  return [...state.bindings.entries()].map(([id, b]) => [
    id, b.event_id || '', b.media_name || '', b.bound_at ? String(b.bound_at) : '', String(Date.now()), b.note || ''
  ]);
}

// ── lib/sheets.js ────────────────────────────────────────────────────
export const sheets = {
  async readRange(range) {
    if (range.startsWith('events!')) return state.events.map(r => [...r]);
    if (range.startsWith('line_users!')) return bindingRows();
    if (range.startsWith('line_staff!')) return state.staff.map(r => [...r]);
    return [];
  },
  async appendRows(range, rows) {
    if (range.startsWith('line_users!')) {
      for (const r of rows) state.bindings.set(r[0], { event_id: r[1], media_name: r[2], bound_at: Number(r[3]), note: r[5] });
    }
    if (range.startsWith('line_staff!')) state.staff.push(...rows.map(r => [...r]));
  },
  async updateRange(range, values) {
    const staffM = range.match(/^line_staff!([A-D])(\d+)(?::([A-D])(\d+))?$/);
    if (staffM) {
      const row = state.staff[Number(staffM[2]) - 2];
      if (row) values[0].forEach((v, i) => { row[staffM[1].charCodeAt(0) - 65 + i] = v; });
      return;
    }
    const m = range.match(/^line_users!([A-F])(\d+)(?::([A-F])(\d+))?$/);
    if (!m) return;
    const rowNum = Number(m[2]);
    const keys = [...state.bindings.keys()];
    const userId = keys[rowNum - 2];
    if (!userId) return;
    const b = state.bindings.get(userId);
    const startCol = m[1].charCodeAt(0) - 65;
    const row = values[0];
    // 欄位對應：0=id 1=event_id 2=media_name 3=bound_at 4=last_active 5=note
    row.forEach((v, i) => {
      const col = startCol + i;
      if (col === 1) b.event_id = v;
      if (col === 2) b.media_name = v;
      if (col === 3) b.bound_at = v === '' ? 0 : Number(v);
      if (col === 5) b.note = v;
    });
  },
  async ensureSheets() {}
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
  async getProfile() { return null; }
};

// 記錄「哪一場回答了什麼」——answerQuestion 走的是 fetch → Anthropic，
// 這裡直接攔 global fetch，比替換整支 askAnthropic 乾淨。
export function installFetchStub() {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      // system prompt 裡會帶該場的知識庫，從中反推是哪一場回答的
      const sys = body.system?.[0]?.text || '';
      const ev = state.events.find(e => sys.includes(e[1]))?.[0] || 'unknown';
      sent.push({ kind: 'answer', event: ev, text: '（假回答）' });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '（假回答）' }] }) };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
}
installFetchStub();
