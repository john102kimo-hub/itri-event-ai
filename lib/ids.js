// 活動 id／同仁編輯碼產生邏輯——api/events.js（後台新增活動）跟 lib/staff.js
// （LINE 職員模式開新活動）都要用同一份，不要兩邊各刻一份、之後格式跑掉都沒發現。
import { randomInt } from 'node:crypto';

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

// 編輯碼、共用連結碼都是「拿到就能進去」的權杖，用密碼學亂數（批次 116）。
// 以前是 Math.random()：它的內部狀態看過幾個輸出就推得回來，當權杖用不夠格。
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去除易混淆字元
function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

// 產生同仁編輯碼：16 碼英數，做為那一場的「編輯權杖」
export function generateEditCode() {
  return randomCode(16);
}

// 「同仁共用連結」的碼（AI 能見度 /geo、記者名單健檢 /media）：12 碼，放在網址上轉給同仁
export function generateShareCode() {
  return randomCode(12);
}
