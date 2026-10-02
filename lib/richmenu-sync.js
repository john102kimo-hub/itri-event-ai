// LINE 圖文選單的同步（批次 113）：後台挑「報名格要寫哪一場」→ 畫圖 → 建選單 → 設為預設 → 綁職員。
//
// 以前這段（applyRichMenus、報名結束自動換回）在 api/line.js 裡，只有職員在 LINE 打「設定圖文選單」或排程叫得到；
// 格子上的字又寫死在 lib/menu.js 的 REG_MENU_TILE，換活動要改程式、到原本那台機器重產底圖。
// 搬到這裡之後三條路共用：後台按鈕（api/events.js 的 reg_admin_menu_* ）、職員的 LINE 指令、每天的排程。
//
// 「現在綁哪一場」不另外存：直接寫在 LINE 上那份選單的名稱裡（「記者主選單（報名版）｜活動代碼」），
// 以 LINE 實際裝著的為準——不會出現「後台寫綁 A、LINE 其實還是 B」的兩份真相。
import { createRichMenu, uploadRichMenuImage, setDefaultRichMenu, listRichMenus, deleteRichMenu, linkRichMenuToUser, pushMessage } from './line.js';
import { listActiveStaffIds } from './staff.js';
import { buildRichMenuDefinition, REPORTER_MENU, REPORTER_MENU_REG, REG_MENU_TILE, STAFF_MENU } from './menu.js';
import { listOpenCampaignsStrict, registrationLabel } from './registration.js';
import { renderRegMenuImage } from './richmenu-render.js';

// 底圖與字型都去自己的網站抓（public/），不用 includeFiles 打包進 Function（跟選單底圖原本的做法一致）
export const SITE = 'https://itri-event-ai.vercel.app';
const NAME_SEP = '｜';

export const regMenuName = (c) => (c && c.id ? `${REPORTER_MENU_REG.name}${NAME_SEP}${c.id}` : REPORTER_MENU_REG.name);
export const isRegMenuName = (name) => String(name || '') === REPORTER_MENU_REG.name || String(name || '').startsWith(REPORTER_MENU_REG.name + NAME_SEP);
/** 從選單名稱讀出綁的活動代碼；沒綁（通用格）回空字串。 */
export const boundCampaignId = (name) => (isRegMenuName(name) ? String(name).slice(REPORTER_MENU_REG.name.length + NAME_SEP.length) : '');

/** 報名格該綁哪一場：指定的還開著就用它；否則只有一場開放就是那一場；兩場以上又沒指定＝通用格（null）。 */
export function pickMenuCampaign(open, boundId = '') {
  return open.find((c) => c.id === boundId) || (open.length === 1 ? open[0] : null);
}

/** 格子上的字：標題＝「簡稱＋報名」（沒簡稱＝「活動報名」），副標＝「10/28 起・選場次」（已經開始了就只寫「選場次」）。 */
export function tileFor(c, now = Date.now()) {
  if (!c) return { label: '活動報名', sub: '選場次・1 分鐘' };
  const first = (c.sessions || []).find((s) => s.status !== 'cancelled');
  const future = first && !Number.isNaN(Date.parse(`${first.date}T00:00:00+08:00`)) && Date.parse(`${first.date}T00:00:00+08:00`) > now;
  return { label: registrationLabel(c), sub: future ? `${first.md} 起・選場次` : '選場次' };
}

/** 把報名版選單的那一格換成指定的字、名稱帶上活動代碼。 */
export function buildRegMenu(c, now = Date.now()) {
  const { label, sub } = tileFor(c, now);
  return {
    ...REPORTER_MENU_REG, name: regMenuName(c),
    buttons: REPORTER_MENU_REG.buttons.map((b) => (b.text === REG_MENU_TILE.text ? { icon: REG_MENU_TILE.icon, label, sub, text: REG_MENU_TILE.text } : b))
  };
}
const tileBounds = (menu) => buildRichMenuDefinition(menu).areas[menu.buttons.findIndex((b) => b.text === REG_MENU_TILE.text)].bounds;

// 測試接縫：npm test 不裝 opentype.js／pngjs，也不連網抓字型，用假的畫圖函式
let renderer = null;
export function __setRenderer(fn) { renderer = fn; }

async function fetchBytes(path, what) {
  const res = await fetch(`${SITE}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`抓取${what}失敗 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function renderTileImage(menu) {
  const btn = menu.buttons.find((b) => b.text === REG_MENU_TILE.text);
  const args = { label: btn.label, sub: btn.sub, tile: tileBounds(menu) };
  if (renderer) return renderer(args);
  const base = await fetchBytes('/richmenu-reporter-reg.png', '選單底圖');
  const fetchFont = async () => { const b = await fetchBytes('/fonts/NotoSansTC-Bold.ttf', '字型檔'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  return renderRegMenuImage(base, args, { fetchFont });
}

/**
 * 建立並套用整組圖文選單（記者版＋職員版）。失敗會丟例外，由呼叫端決定怎麼回報。
 * reporterImage：記者版的底圖（Buffer）；沒給就抓 public/richmenu-{key}.png。
 */
export async function applyRichMenus(reporterMenu, { reporterImage } = {}) {
  // 先記下現有的，等新選單全部確定上線後才刪——順序反過來的話，中間只要有一步
  // 失敗，記者就會看到一個完全沒有選單的帳號。
  const before = await listRichMenus();
  const created = {};
  for (const menu of [reporterMenu, STAFF_MENU]) {
    const img = menu === reporterMenu && reporterImage ? reporterImage : await fetchBytes(`/richmenu-${menu.key}.png`, `${menu.name}底圖`);
    const id = await createRichMenu(buildRichMenuDefinition(menu));
    await uploadRichMenuImage(id, img, 'image/png');
    created[menu.key] = id;
  }
  // 記者選單設為預設（所有人），職員再逐一覆蓋成職員選單。
  // per-user 連結的優先度高於預設，所以記者永遠看不到「新增活動」「後台數據」這些內部功能的入口。
  await setDefaultRichMenu(created[reporterMenu.key]);
  const staffIds = await listActiveStaffIds();
  let linked = 0;
  for (const sid of staffIds) {
    try { await linkRichMenuToUser(sid, created[STAFF_MENU.key]); linked++; }
    catch (e) { console.error(`綁定職員選單失敗 user=${sid}:`, e.message); }
  }
  const keep = new Set(Object.values(created));
  for (const old of before) if (old.richMenuId && !keep.has(old.richMenuId)) await deleteRichMenu(old.richMenuId);
  console.log(`[line] 圖文選單已設定 ${JSON.stringify(created)} 職員綁定 ${linked}/${staffIds.length} 清掉舊的 ${before.length} 個`);
  return { created, linked, staffCount: staffIds.length };
}

const needToken = () => { if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法同步圖文選單'); };

/**
 * 把報名格同步到 LINE。campaign：要綁的活動物件，null＝通用格（「活動報名」）。
 * 畫圖失敗：allowStaticFallback（職員在 LINE 打指令時）退回固定的舊圖並回 warning；否則整個失敗、選單完全不動——
 * 舊圖寫的是眺望，換成別場活動卻還寫眺望，比失敗更糟。
 */
export async function syncRegistrationMenu(campaign, { allowStaticFallback = false, now = Date.now() } = {}) {
  needToken();
  const menu = buildRegMenu(campaign, now);
  let image = null, warning = '';
  try { image = await renderTileImage(menu); }
  catch (e) {
    console.error('畫選單格子失敗:', e.message);
    if (!allowStaticFallback) throw new Error(`畫選單圖失敗，選單沒有動：${e.message}`);
    warning = `格子上的字沒能換成這一場（${e.message}），這次用的是固定的舊圖。`;
  }
  const useMenu = image ? menu : { ...REPORTER_MENU_REG };
  const r = await applyRichMenus(useMenu, image ? { reporterImage: image } : {});
  const btn = menu.buttons.find((b) => b.text === REG_MENU_TILE.text);
  return { ok: true, mode: image ? 'dynamic' : 'static', campaign_id: campaign ? campaign.id : '', label: image ? btn.label : REG_MENU_TILE.label, sub: image ? btn.sub : REG_MENU_TILE.sub, warning, linked: r.linked, staffCount: r.staffCount };
}

/** 換回原本的一般選單（沒有報名格）。 */
export async function resetRegistrationMenu() {
  needToken();
  const r = await applyRichMenus(REPORTER_MENU);
  return { ok: true, linked: r.linked, staffCount: r.staffCount };
}

/** 後台顯示用：LINE 上現在裝的是一般選單，還是報名版（綁哪一場）。 */
export async function registrationMenuStatus() {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return { configured: false, installed: false, campaign_id: '' };
  const menus = await listRichMenus();
  const m = menus.find((x) => isRegMenuName(x.name));
  return { configured: true, installed: !!m, campaign_id: m ? boundCampaignId(m.name) : '' };
}

/**
 * 每天的排程（Vercel Cron，見 api/line.js action=cron_menu）。只動「已經裝著報名版」的情況，報名開始時要不要裝上去
 * 仍是人決定（剛建活動、還在測的時候，不該有東西自己冒出來）：
 *   ① 沒有任何開放中的報名 → 換回一般選單
 *   ② 報名格綁的那一場結束了、但還有別場開放 → 改寫成現在該寫的（只有一場就是它，否則通用格）
 *   ③ 其餘什麼都不動
 * ⚠️ 用 listOpenCampaignsStrict()：試算表暫時讀不到就丟例外、什麼都不動，不能把「讀不到」當成
 * 「沒有開放中的報名」而把選單換掉（報名正在收的時候換掉，記者就少了入口）。
 */
export async function autoSyncRegistrationMenu() {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return { action: 'skip', why: '沒設定 LINE_CHANNEL_ACCESS_TOKEN' };
  const open = await listOpenCampaignsStrict();
  const menus = await listRichMenus();
  const reg = menus.find((m) => isRegMenuName(m.name));
  const notify = async (text) => {
    const ownerId = process.env.LINE_ADMIN_USER_ID;
    if (!ownerId) return;
    // 只有真的換的那天才推一則（一次 1 則，不是行銷推播）
    try { await pushMessage(ownerId, text); } catch (e) { console.error('通知管理員失敗:', e.message); }
  };
  if (!open.length) {
    if (!reg) return { action: 'skip', why: '目前不是報名版選單' };
    const r = await applyRichMenus(REPORTER_MENU);
    await notify('報名已結束，圖文選單已自動換回原本那套（沒有報名那一格了）。');
    return { action: 'reverted', linked: r.linked };
  }
  if (!reg) return { action: 'skip', why: '目前不是報名版選單' };
  const bound = boundCampaignId(reg.name);
  if (!bound || open.some((c) => c.id === bound)) return { action: 'skip', why: '還有開放中的報名' };
  const next = pickMenuCampaign(open, '');
  const r = await syncRegistrationMenu(next, { allowStaticFallback: true });
  await notify(`報名格原本綁的那一場已經結束，圖文選單已自動改成「${r.label}」。`);
  return { action: 'resynced', campaign_id: r.campaign_id, linked: r.linked };
}
