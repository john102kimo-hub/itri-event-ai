// 同仁在 LINE 傳的照片 → 存進 Vercel Blob → 拿回直連網址（批次 79）。
//
// 跟編輯頁的「上傳照片檔案」存到同一個 Blob store（見 api/upload.js），拿回的網址格式
// 一樣，所以後台、記者頁、封存時刪圖（api/events.js 的 archive）全部照舊運作。
//
// 獨立成一支檔案，是為了測試能整支換成假的（test/loader.mjs）——測試環境沒有
// LINE 與 Blob 的金鑰，也不該真的打網路。


const LINE_DATA_API = 'https://api-data.line.me/v2/bot'; // 下載使用者傳的檔案是這個網域，不是 api.line.me
const MAX_BYTES = 10 * 1024 * 1024; // 跟 api/upload.js 同一個上限

async function fetchLineImage(messageId) {
  const res = await fetch(`${LINE_DATA_API}/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) throw new Error(`下載 LINE 照片失敗 ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  if (!/^image\/(jpeg|png|webp|gif)/.test(contentType)) throw new Error(`不支援的檔案類型 ${contentType}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('照片超過 10MB');
  return { buffer, contentType };
}

// 回傳 Blob 的公開網址。失敗就丟例外，呼叫端逐張處理、回報幾張成功幾張失敗。
export async function saveEventPhoto(eventId, messageId) {
  const { buffer, contentType } = await fetchLineImage(messageId);
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : contentType.includes('gif') ? 'gif' : 'jpg';
  // 用到才載入：api/line.js 每次冷啟動都會載入這支檔案，但只有職員傳照片時才需要 Blob SDK
  const { put } = await import('@vercel/blob');
  const blob = await put(`line-${eventId}-${Date.now()}.${ext}`, buffer, {
    access: 'public', contentType, addRandomSuffix: true
  });
  return blob.url;
}
