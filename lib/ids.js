// 活動 id／同仁編輯碼產生邏輯——api/events.js（後台新增活動）跟 lib/staff.js
// （LINE 職員模式開新活動）都要用同一份，不要兩邊各刻一份、之後格式跑掉都沒發現。

export function generateId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[一-龥]/g, '')   // 移除中文
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .substring(0, 20) || 'event';
  return `${slug}-${Date.now().toString(36)}`;
}

// 產生同仁編輯碼：16 碼英數，做為那一場的「編輯權杖」
export function generateEditCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去除易混淆字元
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
