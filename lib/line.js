// LINE Messaging API 共用工具——純 fetch + Node 內建 crypto，不裝 @line/bot-sdk，
// 跟本專案「零 npm 依賴」的既有原則一致。

import { createHmac, timingSafeEqual } from 'crypto';

const LINE_API = 'https://api.line.me/v2/bot';

// 讀取原始 request body（Buffer）。整支 api/line.js 從頭到尾都不能碰 req.body——
// Vercel 的 req.body 是一個 JS getter，一旦存取就會把底層 stream 讀掉，之後這裡
// 就再也拿不到原始 bytes 了。簽章驗證一定要對「LINE 送來的原始 bytes」算，
// 不能用 JSON.parse 再 JSON.stringify 回去的字串（欄位順序、跳脫字元都可能不同，
// 簽章會時好時壞，而且平常多半會過，等真的出事才發現）。
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// x-line-signature 是對原始 bytes 做 HMAC-SHA256 再 Base64。
// 用 timingSafeEqual 比對，且長度不同就直接回 false（timingSafeEqual 對長度不同的
// buffer 會直接 throw，這裡先擋掉避免整支噴例外）。
export function verifySignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// LINE 文字訊息單則上限 5000 字。記者要完整新聞稿時，prompt 規則已經引導 AI 給網頁連結
// 而不是整段塞進來，但這裡仍留一道防線——真的超長時要讓記者收到「內容過長」的說明，
// 而不是整支 API 呼叫失敗、記者什麼都沒收到。
function truncate(text) {
  const MAX = 4800;
  const s = String(text || '');
  return s.length > MAX ? s.slice(0, MAX - 30) + '\n\n（內容過長，完整內容請見活動網頁）' : s;
}

async function callLineApi(path, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  return fetch(`${LINE_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

export function replyMessage(replyToken, text) {
  return callLineApi('/message/reply', {
    replyToken,
    messages: [{ type: 'text', text: truncate(text) }]
  });
}

export function pushMessage(userId, text) {
  return callLineApi('/message/push', {
    to: userId,
    messages: [{ type: 'text', text: truncate(text) }]
  });
}

// reply token 只活 60 秒、只能用一次。用過或過期後 reply 會回非 2xx（多半是
// Invalid reply token），這時退而求其次改用 push——push 會計費，但輕用量方案
// 每月免費 200 則，記者量級用不完；重點是記者不會「問了沒下文」。
export async function replyOrPush(replyToken, userId, text) {
  try {
    const res = await replyMessage(replyToken, text);
    if (res.ok) return true;
    console.error('LINE reply 失敗，改用 push:', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('LINE reply 例外，改用 push:', e.message);
  }
  try {
    const res = await pushMessage(userId, text);
    if (!res.ok) console.error('LINE push 也失敗:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) {
    console.error('LINE push 例外:', e.message);
    return false;
  }
}

// 顯示「輸入中」動畫，讓記者知道 bot 收到問題、正在處理——只用在一對一聊天，
// 失敗不影響主流程（純體驗加分，不是必要路徑，所以呼叫端不用 await 太久或處理例外）。
export async function startLoading(userId, seconds = 55) {
  try {
    await callLineApi('/chat/loading/start', { chatId: userId, loadingSeconds: seconds });
  } catch (e) {
    console.error('LINE loading 動畫失敗（不影響回覆）:', e.message);
  }
}
