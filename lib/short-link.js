// 米亞回給記者的「短網址」（批次 121）。
//
// 工研院官網的網址又長又難看（ListStyle.aspx?DisplayStyle=13_content&SiteID=1&MmmID=…&Trt_idx=…），
// 貼在 LINE 裡佔掉半個畫面，群組裡更是一整排。朱朱要的是「短網址呈現」。
//
// ⚠️ 為什麼不是接外部縮網址服務（bit.ly 之類）：① 要多一個外部相依與金鑰，掛了記者就點不開；
// ② 縮出來的網址要存在某個地方才查得回去，我們沒有適合放這個的資料庫。
// 做法是**不存任何東西**：短網址本身就帶著官網那筆資料的編號，
//   https://<本站>/t/11246           → 官網「產業服務」那筆技術（Trt_idx=11246）
//   https://<本站>/n/115100714231450331 → 官網新聞中心那則新聞（MGID=…）
// 點開時由 api/event-page.js（_r=go）導回官網。編號是官網自己的，官網不下架它，連結就一直有效。
//
// ⚠️ 導向的網域是**寫死**的 www.itri.org.tw，編號只收純數字——這個端點永遠不可能被拿去導到別的網站
// （開放式轉址是釣魚網站最愛的洞）。

const site = () => String(process.env.SITE_URL || 'https://itri-event-ai.vercel.app').replace(/\/+$/, '');
const ITRI = 'https://www.itri.org.tw/ListStyle.aspx';

// 官網的選單編號（MmmID）：技術清單頁與新聞中心頁各一個，文章頁要帶著才打得開（實測：少了 MmmID 回空白頁）。
export const TECH_MMM_ID = '1036233405427625204';
export const NEWS_MMM_ID = '1036276263153520257';

const KINDS = {
  t: id => `${ITRI}?DisplayStyle=13_content&SiteID=1&MmmID=${TECH_MMM_ID}&Trt_idx=${id}`,
  n: id => `${ITRI}?DisplayStyle=01_content&SiteID=1&MmmID=${NEWS_MMM_ID}&MGID=${id}`
};
const ID_RE = /^\d{1,24}$/;

export const shortTechUrl = id => (ID_RE.test(String(id || '')) ? `${site()}/t/${id}` : '');
export const shortNewsUrl = id => (ID_RE.test(String(id || '')) ? `${site()}/n/${id}` : '');

/** 短網址 → 官網網址；種類不認得或編號不是純數字回空字串（呼叫端回 404）。 */
export function resolveShortLink(kind, id) {
  const build = KINDS[String(kind || '')];
  const clean = String(id || '').trim();
  return build && ID_RE.test(clean) ? build(clean) : '';
}
