// 通用的假 Google Sheets（批次 82）：支援 A1 範圍讀寫，給 test-review82.mjs 直接跑
// 真的 api/*.js。每一次寫入都記進 calls，測試可以數「刪一筆到底寫了幾次」；
// failWrites 設成 n，就讓第 n 次寫入丟例外（模擬寫到一半 Sheets 429）。
export const book = {};
export const calls = [];
// strictTabs（批次 84）：讀不存在的分頁時照真的 Sheets API 丟「Unable to parse range」。
export const ctl = { failWrites: 0, failReads: new Set(), strictTabs: false };

const colNum = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
function parse(range) {
  const [tab, rest = 'A1'] = String(range).split('!');
  const [a, b] = rest.split(':');
  const pa = a.match(/^([A-Z]+)?(\d+)?$/);
  const pb = (b || a).match(/^([A-Z]+)?(\d+)?$/);
  return {
    tab,
    c1: pa[1] ? colNum(pa[1]) - 1 : 0,
    r1: pa[2] ? +pa[2] - 1 : 0,
    c2: pb[1] ? colNum(pb[1]) - 1 : 999,
    r2: pb[2] ? +pb[2] - 1 : 1e9,
  };
}
function maybeFail(kind, range) {
  calls.push([kind, range]);
  if (kind !== 'read' && ctl.failWrites && calls.filter((c) => c[0] !== 'read').length === ctl.failWrites) {
    throw new Error('模擬 Sheets 寫入失敗（429）');
  }
}
export function reset() {
  for (const k of Object.keys(book)) delete book[k];
  calls.length = 0;
  ctl.failWrites = 0;
  ctl.failReads.clear();
  ctl.strictTabs = false;
}
export async function readRange(range) {
  calls.push(['read', range]);
  const { tab, c1, r1, c2, r2 } = parse(range);
  if (ctl.failReads.has(tab)) throw new Error('模擬 Sheets 讀取失敗');
  if (ctl.strictTabs && !book[tab]) throw new Error(`Unable to parse range: ${range}`);
  const rows = book[tab] || [];
  const out = [];
  for (let i = r1; i <= Math.min(r2, rows.length - 1); i++) {
    const row = (rows[i] || []).slice(c1, c2 + 1).map((v) => (v == null ? '' : String(v)));
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}
export async function appendRows(range, values) {
  maybeFail('append', range);
  const { tab, c1 } = parse(range);
  const rows = (book[tab] ||= []);
  let last = rows.length - 1;
  while (last >= 0 && !(rows[last] || []).some((v) => v !== '' && v != null)) last--;
  values.forEach((v, k) => {
    const row = rows[last + 1 + k] || [];
    v.forEach((x, j) => { row[c1 + j] = x == null ? '' : String(x); });
    rows[last + 1 + k] = row;
  });
  return {};
}
export async function updateRange(range, values) {
  maybeFail('update', range);
  const { tab, c1, r1 } = parse(range);
  const rows = (book[tab] ||= []);
  values.forEach((v, k) => {
    const row = rows[r1 + k] || [];
    v.forEach((x, j) => { if (x != null) row[c1 + j] = String(x); });
    rows[r1 + k] = row;
  });
  return {};
}
export async function listSheets() { return Object.keys(book).map((title, i) => ({ title, sheetId: i + 1 })); }
// 批次 84：支援 deleteDimension（刪整列），sheetId 對應 listSheets() 的編號。
export async function batchUpdate(requests = []) {
  maybeFail('batch', JSON.stringify(requests).slice(0, 80));
  const titles = Object.keys(book);
  for (const r of requests) {
    const d = r?.deleteDimension?.range;
    if (!d || d.dimension !== 'ROWS') continue;
    const tab = titles[d.sheetId - 1];
    if (tab) book[tab].splice(d.startIndex, d.endIndex - d.startIndex);
  }
  return {};
}
export async function ensureSheets(spec) {
  for (const t of Object.keys(spec)) if (!book[t]) book[t] = [spec[t].map(String)];
  return [];
}
export function warmAuth() { return Promise.resolve(); }
