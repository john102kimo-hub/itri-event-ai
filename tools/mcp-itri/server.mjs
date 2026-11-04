// itri-event-ai 的 MCP 伺服器（批次 186）：讓 Claude Code 直接查活動與問答，不用再手動貼資料。
//
//   MCP_ITRI_FIXTURE=tools/mcp-itri/fixture.sample.json node tools/mcp-itri/server.mjs   ← 範例資料（虛構），不碰任何真資料
//   GOOGLE_SERVICE_ACCOUNT_EMAIL=… GOOGLE_PRIVATE_KEY=… GOOGLE_SPREADSHEET_ID=… node tools/mcp-itri/server.mjs  ← 真的試算表
//
// 設計上刻意的取捨（為什麼長這樣，見 tools/mcp-itri/README.md）：
//   ① **唯讀**：五個工具都只讀。沒有任何寫入、發布、刪除——「讓 Claude 查」跟「讓 Claude 改正式資料」是兩回事。
//   ② **不吐編輯碼**：events 表 K 欄（edit_code）是同仁編輯頁的密碼，任何工具都不回傳。
//   ③ **預設不吐個資**：問答紀錄的媒體名稱、記者姓名預設不出現；要看得自己設 MCP_ITRI_ALLOW_PII=1。
//      （問題原文本身仍可能含個資——所以要查真資料，請只在自己的電腦上、不要把輸出貼到別處。）
//   ④ **愛惜 Sheets 額度**：讀取額度是每分鐘 60 次、跟正式站共用（lib/events-table.js）。活動表走既有的 30 秒快取，
//      問答紀錄這裡再快取 60 秒；不會因為 Claude 連問十題就打十次 Sheets。
//   ⑤ **零依賴**：跟專案其餘部分一樣不需要 npm install。MCP 的 stdio 傳輸就是「一行一個 JSON-RPC 訊息」，自己處理即可。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { eventChecklist, preEventWithoutInvite, publishBlockers, taipeiToday } from '../../lib/event-status.js';

export const SERVER_INFO = { name: 'itri-event-ai', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 20_000;
const QA_TTL_MS = 60_000;

// events 表欄位（同 lib/event-status.js）：A id, B name, C color, D knowledge_base, E status, F 活動日期, G chips, H images,
// I greeting, J organizer, K edit_code（絕不回傳）, L event_time, M venue, N event_type, O press_contact, P contacts,
// Q invite_letter, R invite_letter_chips
// qa_log：A 時間, B event_id, C 活動名稱, D 媒體, E 問題, F 回答, G 已刪除(1), H 來源(web/line/staff), I 記者姓名

const today = () => process.env.MCP_ITRI_TODAY || taipeiToday();
const allowPii = () => process.env.MCP_ITRI_ALLOW_PII === '1';
const cell = (r, i) => String(r?.[i] ?? '').trim();
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const pad = (n) => String(n).padStart(2, '0');

/** 範例資料裡的 {{today+7}}、{{today-10}} 換成真的日期，範例就不會過期（批次 103 的日期炸彈教訓）。 */
export function resolveRelativeDates(value, todayIso = today()) {
  if (typeof value === 'string') {
    return value.replace(/\{\{today([+-]\d+)?\}\}/g, (_m, off) => {
      const d = new Date(`${todayIso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Number(off || 0));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveRelativeDates(v, todayIso));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRelativeDates(v, todayIso)]));
  return value;
}

// ───────────────────────── 資料來源 ─────────────────────────
let backendPromise = null;
export function resetBackend() { backendPromise = null; }

async function makeBackend() {
  const fx = process.env.MCP_ITRI_FIXTURE;
  if (fx) {
    const file = path.isAbsolute(fx) ? fx : path.resolve(process.cwd(), fx);
    const data = resolveRelativeDates(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { kind: 'fixture', events: async () => data.events || [], qa: async () => data.qa_log || [] };
  }
  const missing = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SPREADSHEET_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`沒有資料來源：缺少環境變數 ${missing.join('、')}。要試用範例資料，請設 MCP_ITRI_FIXTURE=tools/mcp-itri/fixture.sample.json。`);
  }
  const { readEventRows } = await import('../../lib/events-table.js');
  const { readRange } = await import('../../lib/sheets.js');
  let qaCache = { rows: null, at: 0 };
  return {
    kind: 'sheets',
    events: () => readEventRows(),
    qa: async () => {
      if (qaCache.rows && Date.now() - qaCache.at < QA_TTL_MS) return qaCache.rows;
      qaCache = { rows: await readRange('qa_log!A2:I'), at: Date.now() };
      return qaCache.rows;
    }
  };
}
const backend = () => (backendPromise ||= makeBackend().catch((e) => { backendPromise = null; throw e; }));

const findRow = async (id) => (await (await backend()).events()).find((r) => cell(r, 0) === String(id || '').trim());
const liveQa = async () => (await (await backend()).qa()).filter((r) => cell(r, 6) !== '1' && cell(r, 1)); // 已刪除的與空列不算

// ───────────────────────── 工具 ─────────────────────────
const TOOLS = [
  {
    name: 'list_events',
    description: '列出活動（不含新聞稿內容）：id、名稱、狀態、日期、地點、距今幾天、必填還缺什麼。找某一場的 id 先用這個。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'active', 'ended', 'archived'], description: 'draft 未發布、active 進行中、ended 已結束、archived 已封存' },
        upcoming_only: { type: 'boolean', description: '只列今天以後的活動' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多幾筆，預設 30' }
      }
    },
    run: async ({ status, upcoming_only, limit } = {}) => {
      const t = today();
      const rows = (await (await backend()).events()).filter((r) => cell(r, 0));
      const out = [];
      for (const r of rows) {
        const c = eventChecklist(r, t);
        if (status && c.status !== status) continue;
        if (upcoming_only && !(c.daysLeft !== null && c.daysLeft >= 0)) continue;
        out.push({ id: c.id, name: c.name, status: c.status, date: c.date || null, time: c.time || null, venue: c.venue || null, daysLeft: c.daysLeft, missingRequired: c.missingRequired });
      }
      return { today: t, count: out.length, events: out.slice(0, limit || 30) };
    }
  },
  {
    name: 'get_event',
    description: '一場活動的基本資料。預設不含新聞稿全文（可能是還沒解禁的稿）；要看才設 include_knowledge_base。永遠不會回傳編輯碼。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '活動 id（用 list_events 找）' },
        include_knowledge_base: { type: 'boolean', description: '是否附上新聞稿／知識庫文字，預設 false' },
        kb_max_chars: { type: 'integer', minimum: 100, maximum: 20000, description: '新聞稿最多回傳幾字，預設 4000' }
      },
      required: ['id']
    },
    run: async ({ id, include_knowledge_base, kb_max_chars } = {}) => {
      const r = await findRow(id);
      if (!r) throw new Error(`找不到活動「${id}」。用 list_events 看有哪些。`);
      const c = eventChecklist(r, today());
      const kb = cell(r, 3);
      return {
        id: c.id, name: c.name, status: c.status, date: c.date || null, time: c.time || null, venue: c.venue || null,
        event_type: cell(r, 13) || null, organizer: cell(r, 9) || null, press_contact: cell(r, 14) || null,
        chips: cell(r, 6) ? cell(r, 6).split(/\n|\|/).map((s) => s.trim()).filter(Boolean) : [],
        image_count: cell(r, 7) ? cell(r, 7).split('\n').filter((l) => l.trim()).length : 0,
        invite_letter_chars: cell(r, 16).length, knowledge_base_chars: kb.length,
        has_contacts: !!cell(r, 15),
        ...(include_knowledge_base ? { knowledge_base: clip(kb, kb_max_chars || 4000) } : {})
      };
    }
  },
  {
    name: 'event_checklist',
    description: '這場活動填得夠不夠、能不能發布、發布會有什麼後果。規則跟後台、LINE 職員模式用的是同一份程式（lib/event-status.js），所以答案一致。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '活動 id' } }, required: ['id'] },
    run: async ({ id } = {}) => {
      const r = await findRow(id);
      if (!r) throw new Error(`找不到活動「${id}」。用 list_events 看有哪些。`);
      const t = today();
      const c = eventChecklist(r, t);
      const blockers = publishBlockers(r, t);
      const noInvite = preEventWithoutInvite(r, t);
      return {
        today: t, id: c.id, name: c.name, status: c.status, date: c.date || null, daysLeft: c.daysLeft,
        required: c.required.map(({ label, done, detail }) => ({ label, done, ...(detail ? { detail } : {}) })),
        bonus: c.bonus.map(({ label, done }) => ({ label, done })),
        missingRequired: c.missingRequired,
        canPublish: blockers.length === 0,
        publishBlockers: blockers,
        warnings: [
          ...(noInvite ? [`活動 ${noInvite.daysLeft} 天後、沒有媒體邀請函：一發布，記者就問得到新聞稿全文與照片。發布前要讓承辦人看過這個後果（批次 171）。`] : []),
          ...(c.kbPending ? ['新聞稿還沒貼，目前由邀請函頂著；活動當天前要補上。'] : []),
          ...(c.urgent ? ['7 天內要辦、必填還沒齊。'] : [])
        ]
      };
    }
  },
  {
    name: 'qa_summary',
    description: '記者問答的統計：總數、各來源、答不出來的比例、最常被問的問題。只回彙總，不含記者姓名與媒體。',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: '只看這一場；不填＝全部' },
        top: { type: 'integer', minimum: 1, maximum: 30, description: '列出最常被問的前幾名，預設 10' }
      }
    },
    run: async ({ event_id, top } = {}) => {
      let noData = /(沒有|未|查不到|找不到).{0,10}(資料|內容|資訊|名單|說明)|沒有提到|未提及|沒有這方面|手上沒有|不在.{0,6}資料/;
      try { noData = (await import('../../lib/line-nodata.js')).NO_DATA_PHRASE_RE || noData; } catch { /* 用內建的 */ }
      const rows = (await liveQa()).filter((r) => !event_id || cell(r, 1) === String(event_id).trim());
      const bySource = {};
      const freq = new Map();
      let unanswered = 0;
      for (const r of rows) {
        const src = cell(r, 7) || 'web';
        bySource[src] = (bySource[src] || 0) + 1;
        if (noData.test(cell(r, 5))) unanswered++;
        const q = cell(r, 4).replace(/\s+/g, ' ').slice(0, 80);
        if (q) freq.set(q, (freq.get(q) || 0) + 1);
      }
      return {
        event_id: event_id || '(全部)', total: rows.length, by_source: bySource,
        distinct_media: new Set(rows.map((r) => cell(r, 3)).filter((m) => m && m !== '（未填寫）')).size,
        answer_says_no_data: unanswered,
        no_data_rate: rows.length ? Number((unanswered / rows.length).toFixed(3)) : 0,
        top_questions: [...freq].sort((a, b) => b[1] - a[1]).slice(0, top || 10).map(([question, count]) => ({ question, count }))
      };
    }
  },
  {
    name: 'search_qa',
    description: '在記者問答裡搜尋關鍵字（問題或回答含有就算）。預設不含記者姓名與媒體。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '關鍵字' },
        event_id: { type: 'string', description: '只搜這一場；不填＝全部' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '最多幾筆，預設 10（最新的在前）' }
      },
      required: ['query']
    },
    run: async ({ query, event_id, limit } = {}) => {
      const q = String(query || '').trim().toLowerCase();
      if (!q) throw new Error('query 不能是空的。');
      const rows = (await liveQa()).filter((r) => (!event_id || cell(r, 1) === String(event_id).trim()) && `${cell(r, 4)}\n${cell(r, 5)}`.toLowerCase().includes(q));
      const hits = rows.slice(-(limit || 10)).reverse().map((r) => ({
        time: cell(r, 0), event_id: cell(r, 1), source: cell(r, 7) || 'web',
        question: clip(cell(r, 4), 200), reply: clip(cell(r, 5), 300),
        ...(allowPii() ? { media: cell(r, 3), reporter: cell(r, 8) } : {})
      }));
      return { matched: rows.length, returned: hits.length, pii_included: allowPii(), results: hits };
    }
  }
];

// ───────────────────────── JSON-RPC ─────────────────────────
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** 處理一則訊息。通知（沒有 id）回 null。匯出給測試直接呼叫。 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id ?? null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return ok(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: '唯讀的活動與記者問答查詢。先 list_events 找活動 id；發布前用 event_checklist。不會回傳編輯碼與記者個資。'
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `沒有這個工具：${params?.name}`);
    try {
      const result = await tool.run(params?.arguments || {});
      return ok(id, { content: [{ type: 'text', text: clip(JSON.stringify(result, null, 2), MAX_TEXT) }] });
    } catch (err) {
      // 工具執行失敗要回「結果裡的 isError」，讓模型看得到原因、可以自己改參數再試；協定錯誤才用 error
      return ok(id, { content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
    }
  }
  if (isNotification) return null; // notifications/initialized、notifications/cancelled 等：不回應
  return fail(id, -32601, `Method not found: ${method}`);
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(fail(null, -32700, 'Parse error'))}\n`); return; }
    const reply = await handleMessage(msg).catch((e) => fail(msg?.id ?? null, -32603, String(e?.message || e)));
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
  rl.on('close', () => process.exit(0));
  console.error(`[itri-event-ai MCP] 啟動（唯讀）。資料來源：${process.env.MCP_ITRI_FIXTURE ? `範例檔 ${process.env.MCP_ITRI_FIXTURE}` : 'Google 試算表'}`); // stdout 只能放協定訊息，log 一律 stderr
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
