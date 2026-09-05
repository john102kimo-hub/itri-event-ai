// 吃什麼地圖的離線外殼。
//
// ⚠️ 這支跟工研院活動平台共用同一個網域，所以它的 scope 是整個站台（`/`）。
// 只要它多攔一個不該攔的請求，/admin、/event、/geo 這些正式頁面就會拿到快取的舊版，
// 而且使用者不會看到任何錯誤訊息、只會覺得「後台怪怪的」，極難追。
//
// 因此這裡的規則只有一條，而且不可以放寬：
//   **URL 不在下面 ASSETS 這份白名單裡，就直接 return，完全不碰。**
// fetch 事件沒有呼叫 respondWith() 時，瀏覽器會照原本的方式送出請求，
// 等於這支 Service Worker 對平台其他頁面完全不存在。
const CACHE = 'food-map-v1';

const ASSETS = [
  '/food',
  '/food.html',
  '/food-parse.js',
  '/food.webmanifest',
  '/food-icon-180.png',
  '/food-icon-192.png',
  '/food-icon-512.png',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
];
const ALLOW = new Set(ASSETS);

self.addEventListener('install', e => {
  // 逐一 put：其中一個抓失敗（例如 CDN 當掉）不該讓整個安裝失敗，
  // 否則使用者會完全裝不起來，卻只在 DevTools 裡才看得到原因。
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('food-map-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const key = url.origin === self.location.origin ? url.pathname : url.origin + url.pathname;
  // 白名單外一律不處理——平台其他頁面照原本的方式走網路
  if (!ALLOW.has(key)) return;

  // CDN 的檔案帶版本號、內容不會變：快取優先，開啟速度最快。
  if (url.origin !== self.location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    })));
    return;
  }

  // 自己的檔案：網路優先，這樣改版後一開就是新的；沒網路才退回快取。
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch {
      return (await caches.match(key)) || (await caches.match(req)) || Response.error();
    }
  })());
});
