// ESM loader（批次 82）：lib/sheets.js 換成 fakes-sheets82.mjs，@vercel/blob 換成空殼
// （node_modules 不一定有裝；測試也不該真的碰 Blob）。其餘全部用真的。
const FAKE = new URL('./fakes-sheets82.mjs', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec === '@vercel/blob' || spec === '@vercel/blob/client') return { url: 'stub:blob', shortCircuit: true };
  const r = await next(spec, ctx);
  if (r.url.endsWith('/lib/sheets.js')) return { url: FAKE, shortCircuit: true };
  return r;
}
export async function load(url, ctx, next) {
  if (url === 'stub:blob') {
    return { format: 'module', shortCircuit: true, source: 'export async function del() {}\nexport async function put() { return { url: "" }; }\nexport async function handleUpload() { return {}; }' };
  }
  return next(url, ctx);
}
