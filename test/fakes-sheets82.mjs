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
  for (const k of Object.keys(books)) delete books[k];
  calls.length = 0;
  ctl.failWrites = 0;
  ctl.failReads.clear();
  ctl.strictTabs = false;
}

// 批次 119：一份工具綁一本試算表（lib/sheets.js 的 sheetsFor()）。預設那一組綁 book；
// sheetsFor(id) 綁 books[id]——業發處的資料要放在另一本，測試才驗得到「沒有寫回記者會那本」。
// calls 裡另一本的範圍前面帶「id/」，數記者會那本讀了幾次的既有測試不受影響。
export const books = {};
function bound(b, tag) {
  const label = (range) => (tag ? `${tag}/${range}` : range);
  function readNoLog(range) {
    const { tab, c1, r1, c2, r2 } = parse(range);
    if (ctl.failReads.has(tab)) throw new Error('模擬 Sheets 讀取失敗');
    if (ctl.strictTabs && !b[tab]) throw new Error(`Unable to parse range: ${range}`);
    const rows = b[tab] || [];
    const out = [];
    for (let i = r1; i <= Math.min(r2, rows.length - 1); i++) {
      const row = (rows[i] || []).slice(c1, c2 + 1).map((v) => (v == null ? '' : String(v)));
      while (row.length && row[row.length - 1] === '') row.pop();
      out.push(row);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  }
  return {
    async readRange(range) {
      calls.push(['read', label(range)]);
      return readNoLog(range);
    },
    // 批次 117：values:batchGet。真的 API 是一次請求，這裡也只記一筆讀取（範圍用「|」串起來），
    // 數讀取次數的測試（批次 109）才不會因為改用一次讀兩段而多算。
    async readRanges(ranges) {
      calls.push(['read', label(ranges.join('|'))]);
      return ranges.map(readNoLog);
    },
    async appendRows(range, values) {
      maybeFail('append', label(range));
      const { tab, c1 } = parse(range);
      const rows = (b[tab] ||= []);
      let last = rows.length - 1;
      while (last >= 0 && !(rows[last] || []).some((v) => v !== '' && v != null)) last--;
      values.forEach((v, k) => {
        const row = rows[last + 1 + k] || [];
        v.forEach((x, j) => { row[c1 + j] = x == null ? '' : String(x); });
        rows[last + 1 + k] = row;
      });
      return {};
    },
    async updateRange(range, values) {
      maybeFail('update', label(range));
      const { tab, c1, r1 } = parse(range);
      const rows = (b[tab] ||= []);
      values.forEach((v, k) => {
        const row = rows[r1 + k] || [];
        v.forEach((x, j) => { if (x != null) row[c1 + j] = String(x); });
        rows[r1 + k] = row;
      });
      return {};
    },
    async listSheets() { return Object.keys(b).map((title, i) => ({ title, sheetId: i + 1 })); },
    // 批次 84：支援 deleteDimension（刪整列），sheetId 對應 listSheets() 的編號。
    async batchUpdate(requests = []) {
      maybeFail('batch', label(JSON.stringify(requests).slice(0, 80)));
      const titles = Object.keys(b);
      for (const r of requests) {
        const d = r?.deleteDimension?.range;
        if (!d || d.dimension !== 'ROWS') continue;
        const tab = titles[d.sheetId - 1];
        if (tab) b[tab].splice(d.startIndex, d.endIndex - d.startIndex);
      }
      return {};
    },
    async ensureSheets(spec) {
      for (const t of Object.keys(spec)) if (!b[t]) b[t] = [spec[t].map(String)];
      return [];
    }
  };
}
const main = bound(book, '');
export const readRange = main.readRange;
export const readRanges = main.readRanges;
export const appendRows = main.appendRows;
export const updateRange = main.updateRange;
export const listSheets = main.listSheets;
export const batchUpdate = main.batchUpdate;
export const ensureSheets = main.ensureSheets;
export function sheetsFor(id) {
  if (!id) throw new Error('沒有指定試算表 ID');
  return bound((books[id] ||= {}), id);
}
export function warmAuth() { return Promise.resolve(); }
