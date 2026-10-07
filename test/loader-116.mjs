// ESM loader（批次 116）：沿用 loader-reg.mjs，只把 @vercel/blob/client 的 handleUpload 換成「真的會呼叫
// onBeforeGenerateToken」的版本——上傳端點的身分檢查全寫在那個回呼裡，原本的空殼根本跑不到它。
import { resolve as regResolve, load as regLoad } from './loader-reg.mjs';

export const resolve = regResolve;

export async function load(url, ctx, next) {
  if (url === 'stub:blob') {
    const source = [
      'export async function del() {}',
      'export async function put() { return { url: "" }; }',
      'export async function handleUpload({ body, onBeforeGenerateToken }) {',
      '  const p = (body && body.payload) || {};',
      '  await onBeforeGenerateToken(p.pathname || "a.jpg", p.clientPayload || "{}");',
      '  return { type: "blob.generate-client-token", clientToken: "TOKEN" };',
      '}'
    ].join('\n');
    return { format: 'module', shortCircuit: true, source };
  }
  return regLoad(url, ctx, next);
}
