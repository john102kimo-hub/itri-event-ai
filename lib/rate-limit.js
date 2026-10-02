// 陽春限流小工具（批次 109）。
//
// ⚠️ 跟 api/chat.js、api/line.js、lib/registration-api.js 各自那份一樣是「best-effort」：
// 計數放在單一 instance 的記憶體裡，Vercel 開了好幾個 instance 就各算各的，擋不住分散式濫用，
// 擋得住單來源無腦迴圈與猜密碼。真正的上限要靠 Anthropic Console 的每月花費上限與 Google 的配額。
// 這支存在是為了不要每個檔案再各寫一份（那三份先不動，避免搬動時改壞已經測過的行為）。

export function clientIp(req) {
  const raw = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown';
  return String(raw).split(',')[0].trim() || 'unknown';
}

export function createLimiter({ windowMs, max, maxKeys = 4000 }) {
  const log = new Map();
  const recent = (key, now) => (log.get(key) || []).filter((t) => now - t < windowMs);
  return {
    // 記一筆，回傳「這個 key 在視窗內是不是已經超過 max 次」
    hit(key, now = Date.now()) {
      const hits = recent(key, now);
      hits.push(now);
      log.set(key, hits);
      if (log.size > maxKeys) {
        for (const [k, v] of log) if (!v.length || now - v[v.length - 1] >= windowMs) log.delete(k);
      }
      return hits.length > max;
    },
    // 只看、不記：視窗內已經有 max 次以上就算擋下（給「失敗才計數」的用法，例如猜密碼）
    blocked(key, now = Date.now()) { return recent(key, now).length >= max; },
    reset() { log.clear(); },
  };
}
