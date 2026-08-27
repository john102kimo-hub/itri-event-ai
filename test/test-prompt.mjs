// lib/prompt.js 的邀請函替換邏輯（resolveEventContent／isPreEventMode）——純函式，
// 不需要 test/loader.mjs 那套 fake Sheets／LINE，直接測。
import { buildSystemPrompt, resolveEventContent, isPreEventMode } from '../lib/prompt.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log(`❌ ${label}\n   期望 ${JSON.stringify(expected)} 實得 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}`); }
}

// 動態算相對今天的日期，不寫死日期字串——測試才不會過幾個月就失效。
function isoOffset(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TOMORROW = isoOffset(1);
const TODAY = isoOffset(0);
const YESTERDAY = isoOffset(-1);

const base = {
  id: 'evt', name: '測試記者會', organizer: '工研院', status: 'active',
  knowledge_base: '【正式新聞稿】完整技術規格與時程…',
  images: 'https://example.com/photo.jpg',
  invite_letter: '【邀請函】誠摯邀請貴媒體蒞臨採訪本次記者會…'
};

console.log('── resolveEventContent／isPreEventMode ──');

// 活動日期還沒到 + 有填邀請函 → 替換
{
  const ev = { ...base, event_date: TOMORROW };
  ok(isPreEventMode(ev), '活動日期在明天、有填邀請函 → 判定為活動前');
  const resolved = resolveEventContent(ev);
  eq(resolved.knowledge_base, base.invite_letter, '活動前：knowledge_base 換成邀請函內容');
  eq(resolved.images, '', '活動前：images 清空，不提前給正式照片');
  eq(resolved.name, ev.name, '其他欄位（name）原樣保留');
}

// 活動當天 → 不算活動前（嚴格晚於今天才算）
{
  const ev = { ...base, event_date: TODAY };
  ok(!isPreEventMode(ev), '活動日期是今天 → 不算活動前，當天就要能正常回答');
  eq(resolveEventContent(ev).knowledge_base, base.knowledge_base, '活動當天：knowledge_base 不受影響');
}

// 活動已過 → 不算活動前
{
  const ev = { ...base, event_date: YESTERDAY };
  ok(!isPreEventMode(ev), '活動日期是昨天 → 不算活動前');
  eq(resolveEventContent(ev).knowledge_base, base.knowledge_base, '活動已過：knowledge_base 不受影響');
}

// 沒填邀請函 → 不管日期都不替換（新增欄位不能讓舊活動壞掉）
{
  const ev = { ...base, event_date: TOMORROW, invite_letter: '' };
  ok(!isPreEventMode(ev), '沒填邀請函 → 即使活動未到也不算活動前模式');
  eq(resolveEventContent(ev).knowledge_base, base.knowledge_base, '沒填邀請函：knowledge_base 不受影響');
  eq(resolveEventContent(ev).images, base.images, '沒填邀請函：images 不受影響');
}

// 沒填活動日期 → 保守當作不是活動前，不要誤鎖進邀請函模式回不去
{
  const ev = { ...base, event_date: '' };
  ok(!isPreEventMode(ev), '活動日期空白 → 保守判定不是活動前');
}

// 相容 events!F 欄的另一種既有格式（沒填日期時系統寫入的建立時間戳記）
{
  const futureTimestamp = (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 下午11:06:04`;
  })();
  const ev = { ...base, event_date: futureTimestamp };
  ok(isPreEventMode(ev), '「YYYY/M/D 下午HH:MM:SS」時間戳記格式，日期在一年後 → 也能正確判定為活動前');
}

console.log('── buildSystemPrompt 帶上邀請函規則 ──');
{
  const ev = resolveEventContent({ ...base, event_date: TOMORROW });
  const prompt = buildSystemPrompt(ev);
  ok(prompt.includes(base.invite_letter), '活動前的 system prompt 含邀請函內容');
  ok(!prompt.includes(base.knowledge_base), '活動前的 system prompt 不含正式新聞稿內容');
  ok(/媒體邀請函/.test(prompt) && /記者要完整新聞稿或照片時/.test(prompt), '有附加提醒 AI 別把邀請函講成正式新聞稿的規則');
}
{
  // 沒有邀請函模式時，行為要跟原本完全一樣（檔頭那句「不能逐 byte 走鐘」的保證）。
  const ev = resolveEventContent({ ...base, event_date: TODAY });
  const prompt = buildSystemPrompt(ev);
  ok(prompt.includes(base.knowledge_base), '非活動前：system prompt 含正式新聞稿內容');
  ok(!/媒體邀請函/.test(prompt), '非活動前：不會多出邀請函提醒規則');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 邀請函規則測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
