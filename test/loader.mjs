// ESM loader：把 api/line.js import 的 lib/sheets.js 與 lib/line.js 換成 fakes.mjs 的版本。
// lib/menu.js、lib/router.js、lib/staff.js、lib/prompt.js 全部用真的，才測得到真正的邏輯。
const FAKES = new URL('./fakes.mjs', import.meta.url).href;

// test-flow.mjs 每個情境用 `import('../api/line.js?v=N')` 重載一次，好清掉模組層的
// 60 秒快取。但光是重載 api/line.js 沒有用——它 import 的 lib/staff.js、lib/router.js
// 解析到的還是同一個 URL，拿到的是同一份舊實例，那些檔案自己的快取（staffCache…）
// 完全沒被清掉。所以這裡把 ?v=N 往下傳染給整個 lib/ 模組圖，讓每個情境拿到真正
// 乾淨的一份。fakes.mjs 不帶版本、維持單例，情境之間才共用得到同一份假資料。
function versionOf(url) {
  return url ? (url.match(/[?&]v=(\d+)/)?.[1] || null) : null;
}

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  const v = versionOf(context.parentURL);
  const bust = u => (v ? u + (u.includes('?') ? '&' : '?') + 'v=' + v : u);

  if (r.url.endsWith('/lib/sheets.js')) return { ...r, url: bust(r.url + '?stub=sheets'), shortCircuit: true };
  if (r.url.endsWith('/lib/line.js')) return { ...r, url: bust(r.url + '?stub=line'), shortCircuit: true };
  // 批次 79：照片上傳會打 LINE 與 Vercel Blob，測試換成假的
  if (r.url.endsWith('/lib/photo-upload.js')) return { ...r, url: bust(r.url + '?stub=photo'), shortCircuit: true };
  if (v && /\/lib\/[^/]+\.js$/.test(r.url)) return { ...r, url: bust(r.url), shortCircuit: true };
  const own = lineStateBust(context.parentURL, r.url);
  if (own) return { ...r, url: own, shortCircuit: true };
  return r;
}

// 批次 117：api/line.js 拆成 lib/line-*.js 之後，原本住在 api/line.js 裡的模組層狀態（活動列快取、
// line_users 快取、限流、找真人的通知間隔…）搬進了那幾支。有些測試用 `?b85=N` 這種參數只重載
// api/line.js、其餘 lib 共用同一份——以前這樣就清得掉那些狀態，現在要把同一個參數往下傳給
// lib/line-*.js，語意才跟拆檔前一樣。`?v=N` 已經整個 lib 都傳了，不用再管。
export function lineStateBust(parentURL, url) {
  const tag = parentURL?.match(/[?&]([A-Za-z]\w*=\d+)/)?.[1];
  if (!tag || versionOf(parentURL) || !/\/(api\/line|lib\/line-[^/]+)\.js(\?|$)/.test(parentURL)) return null;
  if (!/\/lib\/line-[^/]+\.js$/.test(url)) return null;
  return url + '?' + tag;
}

export async function load(url, context, next) {
  if (url.includes('?stub=sheets')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { sheets } from ${JSON.stringify(FAKES)};
export const readRange = (...a) => sheets.readRange(...a);
export const readRanges = (rs) => Promise.all(rs.map((r) => sheets.readRange(r)));
export const appendRows = (...a) => sheets.appendRows(...a);
export const updateRange = (...a) => sheets.updateRange(...a);
export const ensureSheets = (...a) => sheets.ensureSheets(...a);`
    };
  }
  if (url.includes('?stub=photo')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { photo } from ${JSON.stringify(FAKES)};
export const saveEventPhoto = (...a) => photo.saveEventPhoto(...a);`
    };
  }
  if (url.includes('?stub=line')) {
    return {
      format: 'module', shortCircuit: true,
      source: `import { line } from ${JSON.stringify(FAKES)};
export { readRawBody, verifySignature, isBotMentioned, stripMentionText } from ${JSON.stringify(url.replace('?stub=line', '?real=1'))};
export const replyOrPush = (...a) => line.replyOrPush(...a);
export const replyOrPushMessages = (...a) => line.replyOrPushMessages(...a);
export const startLoading = (...a) => line.startLoading(...a);
export const pushImages = (...a) => line.pushImages(...a);
export const replyTextWithImages = (...a) => line.replyTextWithImages(...a);
export const createRichMenu = (...a) => line.createRichMenu(...a);
export const uploadRichMenuImage = (...a) => line.uploadRichMenuImage(...a);
export const setDefaultRichMenu = (...a) => line.setDefaultRichMenu(...a);
export const listRichMenus = (...a) => line.listRichMenus(...a);
export const deleteRichMenu = (...a) => line.deleteRichMenu(...a);
export const linkRichMenuToUser = (...a) => line.linkRichMenuToUser(...a);
export const pushChartImage = (...a) => line.pushChartImage(...a);
export const unlinkRichMenuFromUser = (...a) => line.unlinkRichMenuFromUser(...a);
export const getProfile = (...a) => line.getProfile(...a);
export const replyMessage = (...a) => line.replyOrPush(null, null, ...a);
export const pushMessage = (...a) => line.replyOrPush(null, ...a);`
    };
  }
  return next(url, context);
}
