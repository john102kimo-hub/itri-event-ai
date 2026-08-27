// ESM loader：只把 lib/sheets.js 換成假的，api/event-page.js 其餘部分全用真的。
// event-page.js 會 fs.readFileSync 讀 public/event.html，那支檔案真的存在，不用假造。
const FAKES = new URL('./fakes-og.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.endsWith('/lib/sheets.js')) return { ...r, url: r.url + '?stub=sheets', shortCircuit: true };
  return r;
}

export async function load(url, context, next) {
  if (url.includes('?stub=sheets')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { sheets } from ${JSON.stringify(FAKES)};
export const readRange = (...a) => sheets.readRange(...a);
export const appendRows = async () => {};
export const updateRange = async () => {};
export const ensureSheets = async () => {};`
    };
  }
  return next(url, context);
}
