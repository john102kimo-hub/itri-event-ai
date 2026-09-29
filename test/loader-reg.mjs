// ESM loader（批次 87）：給「LINE × 報名」測試用的混合版。
//   - lib/sheets.js → fakes-sheets82.mjs（通用 A1 範圍讀寫，reg_campaigns／registrations 這種新分頁不用另外寫假的）
//   - lib/line.js、lib/photo-upload.js → fakes.mjs（收下米亞送出的每一則訊息，測試才看得到）
//   - 其餘 lib 帶版本號重載（跟 loader.mjs 一樣，每個情境拿到乾淨的模組快取）
// load 沿用 loader.mjs 的（?stub=line、?stub=photo 的產生方式一模一樣），只多補 @vercel/blob 的空殼。
import { load as baseLoad } from './loader.mjs';

export async function load(url, ctx, next) {
  if (url === 'stub:blob') {
    const source = [
      'export async function del() {}',
      'export async function put() { return { url: "" }; }',
      'export async function handleUpload() { return {}; }'
    ].join('\n');
    return { format: 'module', shortCircuit: true, source };
  }
  return baseLoad(url, ctx, next);
}

const SHEETS82 = new URL('./fakes-sheets82.mjs', import.meta.url).href;

function versionOf(url) {
  return url ? (url.match(/[?&]v=(\d+)/)?.[1] || null) : null;
}

export async function resolve(specifier, context, next) {
  if (specifier === '@vercel/blob' || specifier === '@vercel/blob/client') return { url: 'stub:blob', shortCircuit: true };
  const r = await next(specifier, context);
  const v = versionOf(context.parentURL);
  const bust = (u) => (v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u);

  // 試算表不帶版本：整個測試共用同一本假試算表
  if (r.url.endsWith('/lib/sheets.js')) return { url: SHEETS82, shortCircuit: true };
  if (r.url.endsWith('/lib/line.js')) return { ...r, url: bust(r.url + '?stub=line'), shortCircuit: true };
  if (r.url.endsWith('/lib/photo-upload.js')) return { ...r, url: bust(r.url + '?stub=photo'), shortCircuit: true };
  if (v && /\/lib\/[^/]+\.js$/.test(r.url)) return { ...r, url: bust(r.url), shortCircuit: true };
  return r;
}
