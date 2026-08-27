// ESM loader：把 api/line.js import 的 lib/sheets.js 與 lib/line.js 換成 fakes.mjs 的版本。
// lib/menu.js、lib/router.js、lib/staff.js、lib/prompt.js 全部用真的，才測得到真正的邏輯。
const FAKES = new URL('./fakes.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.endsWith('/lib/sheets.js')) return { ...r, url: r.url + '?stub=sheets', shortCircuit: true };
  if (r.url.endsWith('/lib/line.js')) return { ...r, url: r.url + '?stub=line', shortCircuit: true };
  return r;
}

export async function load(url, context, next) {
  if (url.includes('?stub=sheets')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { sheets } from ${JSON.stringify(FAKES)};
export const readRange = (...a) => sheets.readRange(...a);
export const appendRows = (...a) => sheets.appendRows(...a);
export const updateRange = (...a) => sheets.updateRange(...a);
export const ensureSheets = (...a) => sheets.ensureSheets(...a);`
    };
  }
  if (url.includes('?stub=line')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { line } from ${JSON.stringify(FAKES)};
export { readRawBody, verifySignature } from ${JSON.stringify(url.replace('?stub=line', '?real=1'))};
export const replyOrPush = (...a) => line.replyOrPush(...a);
export const replyOrPushMessages = (...a) => line.replyOrPushMessages(...a);
export const startLoading = (...a) => line.startLoading(...a);
export const pushImages = (...a) => line.pushImages(...a);
export const createRichMenu = (...a) => line.createRichMenu(...a);
export const uploadRichMenuImage = (...a) => line.uploadRichMenuImage(...a);
export const setDefaultRichMenu = (...a) => line.setDefaultRichMenu(...a);
export const listRichMenus = (...a) => line.listRichMenus(...a);
export const deleteRichMenu = (...a) => line.deleteRichMenu(...a);
export const getProfile = (...a) => line.getProfile(...a);
export const replyMessage = (...a) => line.replyOrPush(null, null, ...a);
export const pushMessage = (...a) => line.replyOrPush(null, ...a);`
    };
  }
  return next(url, context);
}
