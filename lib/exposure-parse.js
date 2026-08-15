// 露出清單解析
//
// 監測公司給的「OO露出清單.doc」其實不是 Word 二進位檔，是 MHTML
// （Word 的「單一檔案網頁」格式）。表格欄位固定為：
//   則數 | 監測日期 | 媒體(類型) | 媒體名稱 | 版位/時間 | 訊息標題
//
// ⚠️ 檔頭宣告的 charset 不可信 —— 實測檔案 header 寫 big5，內容其實是
// 帶 BOM 的 UTF-8。因此一律自行偵測，header 只當最後的備援。

import zlib from 'zlib';

// ───────────────────────── 共用

const clean = (s) => String(s)
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

function decodeBytes(bytes, declaredCharset) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder(declaredCharset || 'big5').decode(bytes); }
    catch { return new TextDecoder('big5').decode(bytes); }
  }
}

// ───────────────────────── MHTML(.doc / .mht)

function htmlFromMhtml(buf) {
  const s = buf.toString('latin1');
  const i = s.search(/Content-Type:\s*text\/html/i);
  if (i < 0) return null;

  const headerEnd = s.indexOf('\r\n\r\n', i) + 4;
  if (headerEnd < 4) return null;
  const header = s.slice(i, headerEnd);

  // 段落結束於下一條 boundary 線
  const rest = s.slice(headerEnd);
  const nb = rest.search(/\r\n--+=_NextPart/);
  let bytes = buf.slice(headerEnd, nb > 0 ? headerEnd + nb : buf.length);

  const enc = (header.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [, '8bit'])[1].trim().toLowerCase();
  if (enc === 'base64') {
    bytes = Buffer.from(bytes.toString('latin1').replace(/\s+/g, ''), 'base64');
  } else if (enc === 'quoted-printable') {
    const qp = bytes.toString('latin1')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    bytes = Buffer.from(qp, 'latin1');
  }

  const declared = (header.match(/charset="?([^"\r\n;]+)/i) || [, ''])[1].toLowerCase();
  return decodeBytes(bytes, declared);
}

// ───────────────────────── 最小 ZIP 讀取（給 .pptx，不引入相依套件）

function unzipEntries(buf) {
  // 由結尾往前找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    try {
      out.push({ name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    } catch { /* 略過壞掉的項目 */ }
  }
  return out;
}

function textFromPptx(buf) {
  const entries = unzipEntries(buf).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  entries.sort((a, b) => (+a.name.match(/\d+/)[0]) - (+b.name.match(/\d+/)[0]));
  return entries.map((e) => {
    const xml = e.data.toString('utf8');
    return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => clean(m[1])).filter(Boolean).join('\n');
  });
}

// ───────────────────────── 從 HTML 表格抽記錄

const HEADER_WORDS = /則數|監測日期|媒體|版位|訊息標題|序號|標題/;

function recordsFromHtml(html) {
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1])));

  const out = [];
  for (const r of rows) {
    if (r.length < 5) continue;
    if (!/^\d+$/.test(r[0])) continue;            // 資料列的第一欄一定是則數
    if (HEADER_WORDS.test(r[1]) && !/\d/.test(r[1])) continue;
    const [seq, date, type, outlet, section, ...restCells] = r;
    const title = restCells.join(' ').trim();
    if (!outlet && !title) continue;
    out.push({
      seq: Number(seq),
      date: normDate(date),
      type: type || '',
      outlet: outlet || '',
      section: section || '',
      title: title || '',
    });
  }
  return out;
}

function normDate(d) {
  const s = String(d).trim();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{3})[-/.](\d{1,2})[-/.](\d{1,2})/);       // 民國
  if (m) return `${+m[1] + 1911}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

// ───────────────────────── 對外

/**
 * 解析上傳的露出檔案。
 * @param {Buffer} buf  檔案內容
 * @param {string} filename  原始檔名（用來判斷格式）
 * @returns {{records: Array, format: string, note: string}}
 */
export function parseExposureFile(buf, filename = '') {
  const lower = filename.toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

  // .pptx（或任何 zip 開頭的 Office 檔）
  if (isZip || lower.endsWith('.pptx')) {
    const slides = textFromPptx(buf);
    if (!slides.length) return { records: [], format: 'pptx', note: '讀不到投影片內容，請改上傳監測公司的「露出清單.doc」。' };
    const records = [];
    slides.forEach((txt, i) => {
      txt.split('\n').forEach((line) => {
        const m = line.match(/^\s*(\d{1,3})[.、\s]+(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(.+)$/);
        if (m) {
          const tail = m[3].split(/\s{2,}|\t|\|/).map((x) => x.trim()).filter(Boolean);
          records.push({
            seq: +m[1], date: normDate(m[2]), type: '',
            outlet: tail[0] || '', section: '', title: tail.slice(1).join(' '),
          });
        }
      });
    });
    return {
      records, format: 'pptx',
      note: records.length
        ? `從 ${slides.length} 張投影片抓到 ${records.length} 筆。簡報是成品，欄位可能不完整——建議改上傳「露出清單.doc」以取得完整資料。`
        : `讀到 ${slides.length} 張投影片，但抓不到可辨識的露出列表。請改上傳監測公司的「露出清單.doc」。`,
    };
  }

  // MHTML（.doc / .mht / .mhtml）
  const html = htmlFromMhtml(buf);
  if (html) {
    const records = recordsFromHtml(html);
    return {
      records, format: 'doc(mhtml)',
      note: records.length ? '' : '檔案讀到了，但找不到露出表格。請確認是監測公司產出的「露出清單」原始檔。',
    };
  }

  // 純 HTML 備援
  const asText = decodeBytes(buf, '');
  if (/<tr[\s>]/i.test(asText)) {
    const records = recordsFromHtml(asText);
    return { records, format: 'html', note: records.length ? '' : '找不到露出表格。' };
  }

  return { records: [], format: 'unknown', note: '無法辨識這個檔案格式。支援：監測公司的露出清單 .doc／.mht，或露出報告 .pptx。' };
}

/** 媒體名稱正規化 —— 用於和 qa_log 的自填媒體名交叉比對 */
export function normalizeOutlet(name) {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s\-_·．,，、。]/g, '')
    .replace(/(新聞網|新聞台|電子報|網路版|即時新聞|新聞|網$)/g, '')
    .replace(/股份有限公司|有限公司/g, '')
    .toLowerCase();
}
