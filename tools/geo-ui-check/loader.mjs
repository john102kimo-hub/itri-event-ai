// 把 api/geo.js import 的 lib/sheets.js 換成讀 data.mjs 的假版本（同 test/loader.mjs 的做法）。
const DATA = new URL('./data.mjs', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (r.url.endsWith('/lib/sheets.js')) return { ...r, url: r.url + '?stub', shortCircuit: true };
  return r;
}
export async function load(url, ctx, next) {
  if (url.endsWith('/lib/sheets.js?stub')) return { format: 'module', shortCircuit: true, source: `
import { sheets } from ${JSON.stringify(DATA)};
const tab = (range) => range.split('!')[0];
export async function readRange(range) {
  const t = tab(range); const rows = sheets[t] || [];
  if (/!A1:/.test(range)) return [['h']];
  return rows.map(r => [...r]);
}
export async function appendRows(range, rows) { (sheets[tab(range)] ||= []).push(...rows); return { ok: true }; }
export async function updateRange(range, rows) { return { ok: true }; }
export async function ensureSheets() { return; }
export async function warmAuth() {}
` };
  return next(url, ctx);
}
