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

// 把一串字串轉成 LINE 的 Quick Reply 按鈕。每顆按鈕都是「message」動作——點下去
// 等同使用者自己打字送出同一句話，會走現有的路由判斷，不用另外維護一套按鈕專屬邏輯，
// 按錯也不會有後果，跟自己打字問一樣安全。
// LINE 限制：最多 13 顆、label 最長 20 字。label 太長時截斷，text（實際送出的內容）
// 保留完整，不然按鈕點下去送出的問題被腰斬，AI 收到殘缺的活動名稱反而答錯。
function buildQuickReply(items) {
  const list = (items || []).filter(Boolean).slice(0, 13);
  if (!list.length) return undefined;
  return {
    items: list.map(text => ({
      type: 'action',
      action: {
        type: 'message',
        label: String(text).length > 20 ? String(text).slice(0, 19) + '…' : String(text),
        text: String(text).slice(0, 300)
      }
    }))
  };
}

// 活動照片欄位（events 表 H 欄）轉成 LINE 的 image 訊息物件——每行「網址」或
// 「網址|圖說」，圖說在這裡用不到（image 訊息本身沒有文字欄位，圖說已經在文字
// 答案裡給過一次，見 lib/prompt.js 的 formatImages）。
// 只挑 .jpg/.jpeg/.png 結尾的網址：LINE 的 image 訊息規定內容要是 JPEG 或 PNG，
// 但這個欄位其實什麼網址都能貼（webp、gif、甚至 Google Drive 分享連結…），亂貼的
// 網址送給 LINE 只會在聊天室裡變一張壞掉的圖示，不篩掉的話記者體驗反而更差；
// 篩掉的照片不會真的不見，文字答案裡本來就附了完整下載網址可以點開看。
// originalContentUrl／previewImageUrl 用同一個網址：本專案沒有另外產生縮圖的
// 流程（api/upload.js 存的就是原圖直連網址），LINE 沒有禁止兩者相同，只是預覽
// 會跟原圖一樣大——正式照片多半幾百 KB～數 MB，聊天室裡載入還在可接受範圍。
function buildImageMessages(images, limit = 4) {
  const extRe = /\.(jpe?g|png)(\?.*)?$/i;
  const urls = String(images || '')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const i = line.search(/[|｜]/);
      return (i === -1 ? line : line.slice(0, i)).trim();
    })
    .filter(url => /^https:\/\//i.test(url) && extRe.test(url)); // LINE 要求 https 且限 jpg/png
  return urls.slice(0, limit).map(url => ({ type: 'image', originalContentUrl: url, previewImageUrl: url }));
}

// 把活動照片欄位推成 LINE image 訊息（最多 4 張）。固定走 push、跟文字答案分開
// 兩次呼叫，不是塞進同一個 messages 陣列——見 api/line.js answerQuestion() 的
// 註解，這樣就算某張照片網址有問題被 LINE 拒絕，也不會連累文字答案送不出去。
// 沒有任何一張通過篩選時回傳 { ok: true, skipped: true }，呼叫端不用另外判斷
// 陣列長度或幫空陣列包一層 if。
export function pushImages(userId, images) {
  const messages = buildImageMessages(images);
  if (!messages.length) return Promise.resolve({ ok: true, skipped: true });
  return callLineApi('/message/push', { to: userId, messages });
}

export function replyMessage(replyToken, text, quickReplyItems) {
  const message = { type: 'text', text: truncate(text) };
  const quickReply = buildQuickReply(quickReplyItems);
  if (quickReply) message.quickReply = quickReply;
  return callLineApi('/message/reply', { replyToken, messages: [message] });
}

export function pushMessage(userId, text, quickReplyItems) {
  const message = { type: 'text', text: truncate(text) };
  const quickReply = buildQuickReply(quickReplyItems);
  if (quickReply) message.quickReply = quickReply;
  return callLineApi('/message/push', { to: userId, messages: [message] });
}

// 送任意訊息物件（Flex 圖卡等），走跟 replyOrPush 同一套 reply→push 降級。
// 上面的 replyOrPush 是「純文字 + 快速回覆」的便捷版，兩者共用這條路徑，
// 之後改降級邏輯只要改一個地方。
export async function replyOrPushMessages(replyToken, userId, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).slice(0, 5);
  if (!list.length) return false;
  try {
    const res = await callLineApi('/message/reply', { replyToken, messages: list });
    if (res.ok) return true;
    console.error('LINE reply(flex) 失敗，改用 push:', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('LINE reply(flex) 例外，改用 push:', e.message);
  }
  try {
    const res = await callLineApi('/message/push', { to: userId, messages: list });
    if (!res.ok) console.error('LINE push(flex) 也失敗:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) {
    console.error('LINE push(flex) 例外:', e.message);
    return false;
  }
}

// reply token 只活 60 秒、只能用一次。用過或過期後 reply 會回非 2xx（多半是
// Invalid reply token），這時退而求其次改用 push——push 會計費，但輕用量方案
// 每月免費 200 則，記者量級用不完；重點是記者不會「問了沒下文」。
// quickReplyItems 是選填的按鈕文字陣列，兩條路徑（reply／push）都會帶上，
// 記者不會因為剛好遇到 reply 失效退回 push 就少看到按鈕。
export async function replyOrPush(replyToken, userId, text, quickReplyItems) {
  try {
    const res = await replyMessage(replyToken, text, quickReplyItems);
    if (res.ok) return true;
    console.error('LINE reply 失敗，改用 push:', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('LINE reply 例外，改用 push:', e.message);
  }
  try {
    const res = await pushMessage(userId, text, quickReplyItems);
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

// ── 圖文選單（rich menu）─────────────────────────────────────────────
// 聊天室下方那塊常駐選單，是「不知道怎麼開始」最有效的解法——記者一加好友就看得到
// 按鈕，不必先知道任何指令。每顆按鈕都送出一句純文字（跟快速回覆同一招，見
// buildQuickReply），所以不需要為選單另外寫一套 postback 處理邏輯。
//
// 安裝流程是三步、而且順序不能換：建立選單拿 id → 上傳底圖 → 設為所有人的預設。
// 底圖沒上傳完就設成預設，LINE 會回 400（選單沒有圖片不能啟用）。
const LINE_DATA_API = 'https://api-data.line.me/v2/bot'; // 上傳／下載檔案是另一個網域，不是 api.line.me

export async function createRichMenu(definition) {
  const res = await callLineApi('/richmenu', definition);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`建立圖文選單失敗 ${res.status}: ${data.message || ''}`);
  return data.richMenuId;
}

// LINE 只收 JPEG／PNG，尺寸限 2500x1686 或 2500x843，檔案 1MB 以內。
// imageBuffer 是原始 bytes（ArrayBuffer 或 Buffer 都可以）。
export async function uploadRichMenuImage(richMenuId, imageBuffer, contentType = 'image/png') {
  const res = await fetch(`${LINE_DATA_API}/richmenu/${encodeURIComponent(richMenuId)}/content`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer)
  });
  if (!res.ok) throw new Error(`上傳選單底圖失敗 ${res.status}: ${await res.text().catch(() => '')}`);
  return true;
}

export async function setDefaultRichMenu(richMenuId) {
  const res = await callLineApi(`/user/all/richmenu/${encodeURIComponent(richMenuId)}`, {});
  if (!res.ok) throw new Error(`設為預設選單失敗 ${res.status}: ${await res.text().catch(() => '')}`);
  return true;
}

export async function listRichMenus() {
  try {
    const res = await fetch(`${LINE_API}/richmenu/list`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.richmenus) ? data.richmenus : [];
  } catch (e) {
    console.error('列出圖文選單失敗:', e.message);
    return [];
  }
}

// 舊選單不刪掉的話，每重設一次就多留一份在帳號裡（上限 1000 個，不會馬上爆，
// 但之後從後台看會分不清哪個在用）。刪除失敗只記 log——這是收尾動作，
// 新選單早就已經設定成功了，不能讓清理失敗害整個指令回報失敗。
export async function deleteRichMenu(richMenuId) {
  try {
    const res = await fetch(`${LINE_API}/richmenu/${encodeURIComponent(richMenuId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    return res.ok;
  } catch (e) {
    console.error('刪除舊圖文選單失敗:', e.message);
    return false;
  }
}

// 取得使用者顯示名稱——只給職員模式的登入通知用（記錄「誰」拿到管理權限，
// 是內部帳號可歸責的必要資訊）。一般記者問答完全不呼叫這支，不蒐集記者的顯示名稱，
// 見 LINE-PLAN.md「不要存記者的 LINE 顯示名稱」。失敗就回 null，呼叫端要能不靠
// 名字也運作（退回只顯示 userId）。
export async function getProfile(userId) {
  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const res = await fetch(`${LINE_API}/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName || null;
  } catch (e) {
    console.error('取得 LINE 顯示名稱失敗:', e.message);
    return null;
  }
}
