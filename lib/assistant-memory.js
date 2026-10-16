// 後台助理的記憶（批次 142）——主管教她的事，之後每一次對話都帶著。
//
// 跟 `bot_memory`（批次 46，教「回答記者」的米亞）刻意分開：那份會出現在記者看到的答案裡，這份只給後台助理自己用，
// 內容多半是內部的叫法、偏好、背景（「『四足』指的是 e1 那場」「報名人數先看媒體家數」）。混在一起，
// 內部備忘就可能變成對記者說的話。
//
// 學習的規則（批次 139 的同一個道理）：**不自動學。** 助理答不出來時只會說「我不知道，你可以教我」；
// 要記住什麼，是使用者親口講、助理做成一張確認卡、使用者按了「確認」才寫進來（api/events.js assistant_remember）。
// 模型自己從工具資料或對話裡「覺得該記」的東西不會進來——不然記者問題裡一句「其實這場延期了」就能改掉助理的認知。
// 記憶也不能取代工具：系統提示明講資料類的答案以工具查到的為準，記憶只補名詞、規則、偏好、背景。

import { readRange, appendRows, updateRange, ensureSheets } from './sheets.js';
import { toTraditionalTW } from './zh-tw.js';

export const MEMORY_TAB = 'assistant_memory';
const SHEETS = { [MEMORY_TAB]: ['id', 'created_at', 'content', 'status'] };
export const RANGE = `${MEMORY_TAB}!A2:D`;
export const MAX_LEN = 200;       // 每條上限：這些字會進每一次的系統提示，太長每題都變慢變貴
export const MAX_ACTIVE = 30;     // 生效中的條數上限；滿了請先忘掉幾條
const TTL_MS = 60_000;

const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
let cache = { rows: null, at: 0 };
export const invalidateMemory = () => { cache = { rows: null, at: 0 }; };

const parse = (rows) => (rows || []).map((r, i) => ({ rowNumber: i + 2, id: Number(r[0]) || 0, created_at: r[1] || '', content: r[2] || '', status: (r[3] || 'on').trim() }))
  .filter((m) => m.id && m.content);

/** 生效中的記憶。讀不到（分頁還沒建、Sheets 忙）回空陣列——記憶是加分項，不能因為它讀不到讓整個助理壞掉。 */
export async function readMemories({ fresh = false } = {}) {
  if (!fresh && cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;
  try {
    const rows = parse(await readRange(RANGE)).filter((m) => m.status === 'on');
    cache = { rows, at: Date.now() };
    return rows;
  } catch { return cache.rows || []; }
}

const tidy = (s) => toTraditionalTW(String(s || '').replace(/\s+/g, ' ').trim(), { terms: false });

/** 寫入前的檢查（確認卡產生時與真正寫入時各跑一次）。回 { ok, content } 或 { ok:false, error }。 */
export function checkContent(raw) {
  const content = tidy(raw);
  if (!content) return { ok: false, error: '要記什麼？內容是空的' };
  if (content.length > MAX_LEN) return { ok: false, error: `太長了（${content.length} 字，上限 ${MAX_LEN} 字），請濃縮成一兩句話` };
  return { ok: true, content };
}

export async function addMemory(raw) {
  const c = checkContent(raw);
  if (!c.ok) return { status: 400, error: c.error };
  await ensureSheets(SHEETS);
  const all = parse(await readRange(RANGE)); // 讀失敗要報錯：不能把「讀不到」當成「還沒有」而編出重複的 id
  const active = all.filter((m) => m.status === 'on');
  if (active.some((m) => m.content === c.content)) return { status: 409, error: '這件事已經記過了' };
  if (active.length >= MAX_ACTIVE) return { status: 409, error: `記憶滿了（${MAX_ACTIVE} 條），請先忘掉幾條再教我新的` };
  const id = Math.max(0, ...all.map((m) => m.id)) + 1;
  await appendRows(`${MEMORY_TAB}!A:D`, [[id, now(), c.content, 'on']]);
  invalidateMemory();
  return { status: 200, id, content: c.content };
}

export async function forgetMemory(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { status: 400, error: '缺少記憶編號' };
  const all = parse(await readRange(RANGE));
  const m = all.find((x) => x.id === n && x.status === 'on');
  if (!m) return { status: 404, error: '找不到這條記憶（可能已經忘掉了）' };
  await updateRange(`${MEMORY_TAB}!D${m.rowNumber}`, [['off']]); // 標記而不是刪列：留著「誰教過什麼、什麼時候忘掉」
  invalidateMemory();
  return { status: 200, id: n, content: m.content };
}
