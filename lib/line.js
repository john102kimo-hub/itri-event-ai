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

// 把一串字串（或 {label,text} 物件）轉成 LINE 的 Quick Reply 按鈕。每顆按鈕都是
// 「message」動作——點下去等同使用者自己打字送出同一句話，會走現有的路由判斷，不用
// 另外維護一套按鈕專屬邏輯，按錯也不會有後果，跟自己打字問一樣安全。
// LINE 限制：最多 13 顆、label 最長 20 字。label 太長時截斷，text（實際送出的內容）
// 保留完整，不然按鈕點下去送出的問題被腰斬，AI 收到殘缺的活動名稱反而答錯。
//
// 大部分按鈕（活動名稱、chips…）點下去送出的文字就是按鈕上顯示的文字，字串就夠用。
// 少數情況需要「顯示的字」跟「送出的字」不一樣——例如全域邀訪窗口的主題按鈕，顯示
// 「生醫」但要送出不會跟記者自己打字問問題搞混的「邀訪：生醫」，這時傳
// { label: '生醫', text: '邀訪：生醫' }。
function buildQuickReply(items) {
  const list = (items || []).filter(Boolean).slice(0, 13);
  if (!list.length) return undefined;
  return {
    items: list.map(item => {
      const isObj = item && typeof item === 'object';
      const label = isObj ? item.label : item;
      const text = isObj ? (item.text ?? item.label) : item;
      return {
        type: 'action',
        action: {
          type: 'message',
          label: String(label).length > 20 ? String(label).slice(0, 19) + '…' : String(label),
          text: String(text).slice(0, 300)
        }
      };
    })
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

// 送一張單張圖片，網址不經過 pushImages() 的 jpg/png 副檔名篩選——那套是給「活動
// 照片」那個同仁手動貼、什麼網址都可能出現的欄位用的；這支是給我們自己組出來、
// 來源可信、但網址路徑上不見得有標準副檔名的圖片連結用（例如查詢字串結尾的圖表
// 服務網址），套用同一套副檔名正則只會把自己組的圖擋掉。
//
// ⚠️ 目前沒有呼叫端在用：原本 GEO 趨勢圖表是用這支送 QuickChart.io 產生的圖，
// 但 14 天資料量組出來的網址實測長度落在 1200+ 字元，超過 LINE image 訊息
// originalContentUrl 官方文件記載的 1000 字元上限，會固定顯示壞掉的圖示——GEO
// 職員簡報已經改用 lib/geo-brief.js 的 LINE 原生 Flex Message 長條圖，不再需要
// 組外部圖表網址。這支留著是因為它本身沒有問題（是「用網址組圖」這個手法在資料量
// 大時會爆的問題），之後如果有其他來源可信、網址較短的圖片需求還能直接用。
export function pushChartImage(userId, url) {
  if (!url) return Promise.resolve({ ok: true, skipped: true });
  return callLineApi('/message/push', {
    to: userId,
    messages: [{ type: 'image', originalContentUrl: url, previewImageUrl: url }]
  });
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

// 綁一個「只有這個 userId 看得到」的選單。個人連結的優先度高於預設選單，
// 所以職員會看到職員選單、其他人維持預設的記者選單。
export async function linkRichMenuToUser(userId, richMenuId) {
  const res = await callLineApi(`/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`, {});
  if (!res.ok) throw new Error(`綁定個人選單失敗 ${res.status}: ${await res.text().catch(() => '')}`);
  return true;
}

// 解除個人連結 → 自動落回預設選單。404 也算成功：代表這個人本來就沒有個人連結，
// 對呼叫端而言結果一樣（他現在看到的就是預設選單）。
export async function unlinkRichMenuFromUser(userId) {
  try {
    const res = await fetch(`${LINE_API}/user/${encodeURIComponent(userId)}/richmenu`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    return res.ok || res.status === 404;
  } catch (e) {
    console.error('解除個人選單連結失敗:', e.message);
    return false;
  }
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

// ── 群組／多人聊天的 @ 提及 ─────────────────────────────────────────
// 「被 @ 才回答」（類似美玉姨）需要兩件事：判斷這則訊息有沒有 @ 到我們自己、
// 把 @ 的那段文字從問題裡拿掉，只留真正要問的內容。
//
// LINE 的文字訊息若含提及，會附一個 message.mention 物件：
//   { mentionees: [{ index, length, type: 'user'|'all', userId, isSelf }, ...] }
// index／length 是對 message.text 的 UTF-16 code unit 偏移量（JS 字串本來就是
// UTF-16，直接用 slice 處理不用額外轉碼）。
//
// isSelf 是 LINE 官方為了「機器人判斷自己有沒有被提及」特地加的欄位——不用
// 自己存一份 bot 的 userId 去比對。這支完全依賴這個欄位；哪天 LINE 某個舊版
// client 送來的事件沒有這個欄位，isBotMentioned() 會回 false，效果是「安靜不
// 回應」而不是「誤判成被提及、在群組裡亂插話」——這個方向的失敗比較安全。
export function isBotMentioned(mention) {
  return (mention?.mentionees || []).some(m => m?.isSelf === true);
}

// 把所有提及的文字片段拿掉（不只拿掉自己那段——「@我 @小明 這題你們兩個一起看一下」
// 裡「@小明」也不是問題的一部分），留下乾淨的問題文字。
// 由後往前刪：先刪掉的片段如果在前面，後面片段的 index 會位移，由後往前刪就不用
// 另外重新計算 offset。
export function stripMentionText(text, mention) {
  const raw = String(text || '');
  const spans = (mention?.mentionees || [])
    .filter(m => Number.isInteger(m?.index) && Number.isInteger(m?.length) && m.length > 0)
    .sort((a, b) => b.index - a.index);
  let out = raw;
  for (const m of spans) out = out.slice(0, m.index) + out.slice(m.index + m.length);
  return out.replace(/\s+/g, ' ').trim();
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
