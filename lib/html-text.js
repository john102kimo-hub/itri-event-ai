// 共用的輕量 HTML 文字處理——目前給 lib/industry-trends.js（IEK 產業情報網）跟
// lib/itri-news.js（工研院官網新聞中心）兩邊清單頁解析共用。兩邊抓的都是「純文字
// 內容、不會有巢狀結構」的標題／摘要欄位，不需要真正的 HTML parser，簡單字串取代
// 就夠用——跟這個專案其餘部分同一個「零依賴、不裝 cheerio 之類套件」原則。
//
// 原本各自在兩支檔案裡各寫一份幾乎一樣的版本，之後改一邊忘了改另一邊、兩邊解出來
// 的文字就會悄悄不一致（例如某個 HTML 實體漏解）——抽成這裡共用一份，這種走鐘在
// 結構上就不可能發生。
export function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ') // 防呆：標題／摘要理論上不會有巢狀標籤，萬一有就拿掉不要整段解析壞掉
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}
