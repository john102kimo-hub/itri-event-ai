// 批次 186：MCP 伺服器（tools/mcp-itri/server.mjs）的測試。
// 範例資料是虛構的；日期用 {{today+N}}，「今天」由 MCP_ITRI_TODAY 固定成跟測試行程同一天
// （SHIFT_DAYS 時間位移只改得到本行程，子行程要靠這個變數對齊，批次 103 的日期炸彈教訓）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taipeiToday } from '../lib/event-status.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(root, 'tools/mcp-itri/server.mjs');
const FIXTURE = path.join(root, 'tools/mcp-itri/fixture.sample.json');
const TODAY = taipeiToday();
process.env.MCP_ITRI_FIXTURE = FIXTURE;
process.env.MCP_ITRI_TODAY = TODAY;
delete process.env.MCP_ITRI_ALLOW_PII;

const { handleMessage, resolveRelativeDates, resetBackend, SERVER_INFO } = await import('../tools/mcp-itri/server.mjs');

let pass = 0, fail = 0, n = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); } };
const call = async (name, args = {}) => {
  const r = await handleMessage({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } });
  const text = r.result?.content?.[0]?.text ?? '';
  return { isError: !!r.result?.isError, text, json: r.result?.isError ? null : JSON.parse(text), raw: r };
};

await t('範例日期：{{today+7}}、{{today-10}} 換成真的日期，其餘不動', () => {
  const r = resolveRelativeDates({ a: '{{today}}', b: ['x', '{{today+7}}'], c: 5 }, '2026-01-30');
  assert.deepEqual(r, { a: '2026-01-30', b: ['x', '2026-02-06'], c: 5 });
  assert.equal(resolveRelativeDates('{{today-10}}', '2026-03-05'), '2026-02-23');
});

await t('initialize：回傳協定版本與 tools 能力；不認得的版本退回我們支援的最新版', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.deepEqual(r.result.serverInfo, SERVER_INFO);
  assert.ok(r.result.capabilities.tools);
  const r2 = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r2.result.protocolVersion, '2025-06-18');
});

await t('通知（沒有 id）不回應；未知方法回 -32601；壞格式回 -32600', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 9, method: 'nope' })).error.code, -32601);
  assert.equal((await handleMessage({ foo: 1 })).error.code, -32600);
});

await t('tools/list：五個工具，全部標示唯讀、有 inputSchema', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = r.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['event_checklist', 'get_event', 'list_events', 'qa_summary', 'search_qa']);
  for (const tool of r.result.tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.inputSchema.type, 'object'); assert.ok(!('run' in tool)); }
});

await t('list_events：4 場；status 與 upcoming_only 篩得動；不含新聞稿', async () => {
  const all = (await call('list_events')).json;
  assert.equal(all.today, TODAY); assert.equal(all.count, 4);
  assert.deepEqual((await call('list_events', { status: 'draft' })).json.events.map((e) => e.id), ['demo-draft']);
  assert.deepEqual((await call('list_events', { upcoming_only: true })).json.events.map((e) => e.id).sort(), ['demo-chip', 'demo-forum']);
  assert.ok(!(await call('list_events')).text.includes('28 奈米'), '列表不該帶新聞稿內容');
});

await t('get_event：預設不含新聞稿；要求才附，且會截斷', async () => {
  const a = (await call('get_event', { id: 'demo-chip' })).json;
  assert.equal(a.name, '（範例）AI 邊緣運算晶片發表記者會'); assert.equal(a.venue, '臺大醫院國際會議中心');
  assert.ok(!('knowledge_base' in a)); assert.ok(a.knowledge_base_chars > 50);
  const b = (await call('get_event', { id: 'demo-chip', include_knowledge_base: true, kb_max_chars: 100 })).json;
  assert.ok(b.knowledge_base.includes('28 奈米')); // 截在 100 字內仍含前段
  const c = (await call('get_event', { id: 'demo-chip', include_knowledge_base: true, kb_max_chars: 100 })).json.knowledge_base;
  assert.ok(c.length <= 101);
});

await t('★ 編輯碼絕不外洩：任何工具、任何參數都不會出現 SECRET-EDIT-CODE', async () => {
  const outs = [
    await call('list_events'), await call('get_event', { id: 'demo-chip', include_knowledge_base: true }),
    await call('get_event', { id: 'demo-forum', include_knowledge_base: true }), await call('get_event', { id: 'demo-draft' }),
    await call('event_checklist', { id: 'demo-chip' }), await call('qa_summary'), await call('search_qa', { query: '講者' })
  ];
  for (const o of outs) assert.ok(!o.text.includes('SECRET-EDIT-CODE'), o.text.slice(0, 80));
});

await t('event_checklist：草稿四項全缺、不能發布；缺邀請函會警告；有邀請函的沒有警告', async () => {
  const d = (await call('event_checklist', { id: 'demo-draft' })).json;
  assert.equal(d.canPublish, false); assert.deepEqual(d.missingRequired, ['日期', '地點', '新聞聯絡人', '新聞稿']);
  const c = (await call('event_checklist', { id: 'demo-chip' })).json;
  assert.equal(c.canPublish, true); assert.equal(c.daysLeft, 7);
  assert.ok(c.warnings.some((w) => w.includes('沒有媒體邀請函')));
  const f = (await call('event_checklist', { id: 'demo-forum' })).json;
  assert.equal(f.canPublish, true); assert.deepEqual(f.warnings, []);
});

await t('找不到的活動：回 isError 與可行動的說明，不是例外', async () => {
  const r = await call('event_checklist', { id: 'nope' });
  assert.equal(r.isError, true); assert.match(r.text, /找不到活動/); assert.match(r.text, /list_events/);
});

await t('qa_summary：已刪除的不算；來源、答不出來的比例、最常被問的', async () => {
  const s = (await call('qa_summary')).json;
  assert.equal(s.total, 5); assert.deepEqual(s.by_source, { web: 3, line: 2 });
  assert.equal(s.answer_says_no_data, 1); assert.equal(s.no_data_rate, 0.2);
  assert.deepEqual(s.top_questions[0], { question: '講者有誰？', count: 2 });
  assert.equal((await call('qa_summary', { event_id: 'demo-forum' })).json.total, 1);
});

await t('★ 個資：預設不含記者姓名與媒體；設 MCP_ITRI_ALLOW_PII=1 才出現', async () => {
  const off = await call('search_qa', { query: '講者' });
  assert.equal(off.json.pii_included, false); assert.equal(off.json.matched, 2);
  for (const bad of ['測試記者', '範例新聞網', '範例日報']) assert.ok(!off.text.includes(bad), `不該出現 ${bad}`);
  assert.ok(!(await call('qa_summary')).text.includes('測試記者'));
  process.env.MCP_ITRI_ALLOW_PII = '1';
  const on = await call('search_qa', { query: '講者' });
  assert.equal(on.json.pii_included, true); assert.ok(on.text.includes('測試記者'));
  delete process.env.MCP_ITRI_ALLOW_PII;
});

await t('search_qa：大小寫不拘、搜得到回答裡的字、已刪除的搜不到；空 query 回錯誤', async () => {
  assert.equal((await call('search_qa', { query: 'tops' })).json.matched, 1);
  assert.equal((await call('search_qa', { query: '已被後台刪除' })).json.matched, 0);
  assert.equal((await call('search_qa', { query: '講者', limit: 1 })).json.returned, 1);
  assert.equal((await call('search_qa', { query: '  ' })).isError, true);
});

await t('沒有任何資料來源：工具回 isError 並說明怎麼設，伺服器不會當掉', async () => {
  const keep = { ...process.env };
  delete process.env.MCP_ITRI_FIXTURE; for (const k of ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SPREADSHEET_ID']) delete process.env[k];
  resetBackend();
  const r = await call('list_events');
  assert.equal(r.isError, true); assert.match(r.text, /MCP_ITRI_FIXTURE/);
  Object.assign(process.env, keep); resetBackend();
  assert.equal((await call('list_events')).isError, false); // 補回之後恢復正常
});

// ── 真的開子行程，走 stdio 一行一則 JSON-RPC ──
await t('stdio 端到端：initialize → 通知（無回應）→ tools/list → tools/call；壞 JSON 回 -32700；stdout 只有協定訊息', async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MCP_ITRI_FIXTURE: FIXTURE, MCP_ITRI_TODAY: TODAY }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const send = (o) => child.stdin.write(typeof o === 'string' ? `${o}\n` : `${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send('{ this is not json');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_events', arguments: { status: 'ended' } } });
  const t0 = Date.now();
  while (lines.length < 4 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));
  child.stdin.end(); await new Promise((r) => child.on('close', r));
  const msgs = lines.map((l) => JSON.parse(l)); // 任何一行不是 JSON 就會丟例外＝stdout 被污染
  assert.equal(msgs.length, 4, `預期 4 則回應（通知不回），實際 ${msgs.length}`);
  assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name, 'itri-event-ai');
  assert.equal(msgs.find((m) => m.id === 2).result.tools.length, 5);
  assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
  assert.deepEqual(JSON.parse(msgs.find((m) => m.id === 3).result.content[0].text).events.map((e) => e.id), ['demo-past']);
});

await t('.mcp.json 預設只指向範例資料，不含任何金鑰', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  const s = cfg.mcpServers['itri-event-ai'];
  assert.equal(s.command, 'node'); assert.equal(s.env.MCP_ITRI_FIXTURE, 'tools/mcp-itri/fixture.sample.json');
  assert.ok(Object.keys(s.env).every((k) => k === 'MCP_ITRI_FIXTURE'), '預設設定不能放真資料來源的設定');
});

console.log(`批次 186 MCP 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
