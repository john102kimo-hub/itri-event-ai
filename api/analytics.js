// 問答分析 API
// 管理員密碼一律放 header X-Admin-Password（POST 也可放內文）；批次 110 起不再讀網址的 ?password=
// GET                            → 全部活動統計（含 row_num 供刪除／改媒體名稱）
// GET  ?event_id=xx              → 單一活動統計
// POST {action:'delete', row_num, password, timestamp, question} → 標記刪除單筆 Q&A
// POST {action:'update_media', row_num, password, timestamp, question, media_name}
//      → 手動改這筆的媒體名稱。LINE 問答沒辦法強制記者一定要打媒體名稱（見
//      lib/line.js looksLikeNameOrSkip 附近的說明），現場公關人員多半認得出對方
//      是哪家媒體，這支就是給他們手動補的入口，不用去試算表直接改。
// POST {action:'scan_dirty_media', password}
//      → 掃出「媒體名稱欄其實是記者問題」的髒資料，只回清單不動資料。
// POST {action:'clean_dirty_media', password, row_nums:[...]}
//      → 把指定的那幾列媒體名稱清回「（未填寫）」，只清人工看過勾選的列。
//
// GET  ?summary=1 …              → 儀表板用的輕量版：只回數字與各場彙總，不含逐筆問答（批次 104，見下面說明）
// GET  ?answer_row=N …           → 單筆 AI 回答全文（後台展開一列時才載，列表本身只帶預覽）
// POST update_media 可同時帶 reporter_name（批次 105：媒體欄拆成「媒體」＋「姓名」，姓名在 I 欄）
//
// 管理員密碼也可用 X-Admin-Password header 傳（GET 用這個，不要放在網址上——
// 網址會留在瀏覽器歷史與伺服器存取紀錄裡）。

import { readRange, updateRange } from '../lib/sheets.js';
import { groupOutlets, isTestMedia, isNotMedia, splitMedia } from '../lib/media-name.js';
import { requireAdmin } from '../lib/auth.js';
import { readQaRowsWithoutAnswers } from '../lib/qa-log.js';
import { readEventRows } from '../lib/events-table.js';
import { isBusinessEvent } from '../lib/audience.js';

// 「AI 這題疑似沒答到」：提示詞規定答不出來時要說「這部分我沒有資料，建議洽現場新聞聯絡人」
// （lib/prompt.js），所以這句話的出現是個可靠的線索。只是**線索**——模型偶爾會換個說法，
// 漏標沒關係，後台標的是「疑似」，目的是讓承辦人一眼找出知識庫補哪裡（批次 104）。
const UNANSWERED_RE = /這部分我沒有資料|背景資料(?:中|裡)?(?:並)?沒有(?:提到|提供|記載)|沒有(?:相關|這方面的)資料|查無相關資料/;
const previewOf = (a, n = 140) => String(a || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 判斷「已經存進媒體名稱欄的值」其實比較像一句問題，不是真的媒體/記者名稱——
// LINE 的一次性擷取視窗誤判時會發生（見 lib/line.js looksLikeNameOrSkip 的說明：
// 誤判的方向刻意選過，寧可漏放過一句問題不擋，也不要誤傷記者的下一題，所以這裡
// 反過來抓「明顯是問題」的殘留）。判斷刻意保守，寧可漏掃、不要洗掉真的名稱：
//   - 含問號，或用疑問詞／祈使句開頭 → 幾乎確定是問題
//   - 長度超過 20 字 → 一次性擷取視窗本來就只收 ≤20 字的訊息當名稱，超過的
//     不可能是那個機制存進來的，一定是別的管道寫壞的髒資料
function isDirtyMediaName(name) {
  const s = String(name || '').trim();
  if (!s || s === '（未填寫）' || s === '（未提供）' || s === '（內部職員）') return false;
  if (s.length > 20) return true;
  if (/[?？]/.test(s)) return true;
  if (/^(請問|為什麼|什麼|怎麼|哪裡|哪一|何時|多少|是否|能不能|可以|會不會|有沒有|給我|請給|麻煩|幫我|提供|傳給我|傳送|寄送|附上|想問|想要|需要|來一份|給一份)/.test(s)) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST：刪除單筆 ────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, row_num, timestamp, question } = req.body || {};
    if (!requireAdmin(req, res)) return;   // 批次 110：沒設 ADMIN_PASSWORD 一律拒絕、固定時間比對、失敗限流（lib/auth.js）
    if (action === 'delete' && row_num) {
      // 刪除前先比對這一列現在的內容，避免試算表被手動整理過、row_num 早就指向別筆資料，
      // 開著的舊後台頁面一按刪除就標記錯人的問答。
      if (timestamp !== undefined || question !== undefined) {
        const check = await readRange(`qa_log!A${row_num}:E${row_num}`);
        const row = check[0];
        if (!row || (timestamp !== undefined && row[0] !== timestamp) || (question !== undefined && row[4] !== question)) {
          return res.status(409).json({ error: '這筆資料已變動，請重新整理後再試' });
        }
      }
      // 標記刪除寫到 G 欄（deleted），不要覆蓋 B 欄的 event_id —— 覆蓋掉的話，
      // 這筆問答原本屬於哪一場就永久查不回來了。
      await updateRange(`qa_log!G${row_num}:G${row_num}`, [['1']]);
      return res.status(200).json({ success: true });
    }
    if (action === 'update_media' && row_num) {
      const { media_name } = req.body || {};
      const name = String(media_name ?? '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: '媒體名稱不可空白，要清空請填「（未填寫）」' });
      // 跟刪除同一道防線：改之前先比對這一列現在的內容，避免試算表被手動整理過、
      // row_num 早就指向別筆資料，開著的舊後台頁面一按送出改到別人的問答。
      if (timestamp !== undefined || question !== undefined) {
        const check = await readRange(`qa_log!A${row_num}:E${row_num}`);
        const row = check[0];
        if (!row || (timestamp !== undefined && row[0] !== timestamp) || (question !== undefined && row[4] !== question)) {
          return res.status(409).json({ error: '這筆資料已變動，請重新整理後再試' });
        }
      }
      // D 欄是媒體名稱。有帶 reporter_name 才一併改 I 欄（姓名）；沒帶就只動 D，不會把姓名清掉。
      await updateRange(`qa_log!D${row_num}:D${row_num}`, [[name]]);
      if (typeof req.body.reporter_name === 'string') {
        const person = req.body.reporter_name.replace(/\s+/g, ' ').trim().slice(0, 40);
        await updateRange(`qa_log!I${row_num}:I${row_num}`, [[person]]);
        return res.status(200).json({ success: true, media_name: name, reporter_name: person });
      }
      return res.status(200).json({ success: true, media_name: name });
    }
    if (action === 'scan_dirty_media') {
      // 找出「媒體名稱欄其實是問題」的髒資料——LINE 的一次性擷取視窗（見 lib/line.js
      // looksLikeNameOrSkip 附近的說明）誤判時，會把記者的真實問題錯記成媒體名稱，
      // 這裡用同一套邏輯回頭掃 qa_log 找出來，只回傳清單給人看，不直接動資料
      // （見下面 clean_dirty_media 的說明——要人看過勾選才會真的寫入）。
      const rows = await readRange('qa_log!A2:H');
      const dirty = rows
        .map((r, i) => ({ r, rowNum: i + 2 }))
        .filter(({ r }) => r[1] && r[1] !== '[deleted]' && r[6] !== '1' && isDirtyMediaName(r[3]))
        .map(({ r, rowNum }) => ({
          row_num: rowNum, timestamp: r[0], event_name: r[2] || r[1],
          current_name: r[3], question: r[4]
        }));
      return res.status(200).json({ dirty });
    }
    if (action === 'clean_dirty_media') {
      // 只清「使用者勾選確認過」的那幾列，不是掃到什麼就清什麼——誤判的代價是把
      // 一個湊巧很像問句的真實媒體名稱洗掉，人工看過一眼再決定比較保險。
      const { row_nums } = req.body || {};
      const nums = Array.isArray(row_nums) ? row_nums.filter(n => Number.isInteger(n) && n > 1).slice(0, 200) : [];
      if (!nums.length) return res.status(400).json({ error: '沒有指定要清理的資料列' });
      let cleaned = 0;
      for (const n of nums) {
        try {
          await updateRange(`qa_log!D${n}:D${n}`, [['（未填寫）']]);
          cleaned++;
        } catch (e) {
          console.error(`清理媒體欄失敗 row=${n}:`, e.message);
        }
      }
      return res.status(200).json({ success: true, cleaned });
    }
    return res.status(400).json({ error: '不支援的操作' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET：統計 ────────────────────────────────────────────
  const { event_id, exclude_test } = req.query;
  if (!requireAdmin(req, res)) return;

  // 測試資料（依媒體名稱）：測試／test／demo／純數字／常見亂打，以及同仁在 LINE 職員模式自己問的
  // （「（內部職員）」，批次 104 起算測試資料）。判斷放在 lib/media-name.js，後台首頁、問答分析、
  // 成效報告、LINE 職員的「後台數據」共用同一份。
  const dropTest = exclude_test === '1' || exclude_test === 'true';
  const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';

  // 單筆 AI 回答全文：列表只帶預覽（每筆回答動輒上千字，一次全帶 200 筆是好幾百 KB），
  // 承辦人點開某一列才來要那一筆。
  if (req.query.answer_row !== undefined) {
    const n = parseInt(req.query.answer_row, 10);
    if (!Number.isInteger(n) || n < 2) return res.status(400).json({ error: 'answer_row 不正確' });
    try {
      const row = (await readRange(`qa_log!A${n}:I${n}`))[0];
      if (!row || !row[1] || row[1] === '[deleted]' || row[6] === '1') return res.status(404).json({ error: '找不到這筆問答' });
      return res.status(200).json({ row_num: n, time: row[0] || '', question: row[4] || '', answer: row[5] || '', unanswered: UNANSWERED_RE.test(row[5] || '') });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // recent 預設回最近 50 筆，可用 ?limit= 調整（上限 500）——記者會當天問答量很容易破 50，
  // 「今日問答」與「最新問答」在最需要盯的那天反而會失準。
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  try {
    // I 欄＝記者姓名（批次 105），舊資料是空的。儀表板的摘要版用不到 AI 回答全文（F 欄），
    // 跳過那一欄（批次 117，見 lib/qa-log.js）；完整版要算「疑似沒答到」與預覽，照舊整張讀。
    const rawRows = summaryOnly ? await readQaRowsWithoutAnswers() : await readRange('qa_log!A2:I');
    // 保留原始 row_num（sheet 第幾列，row 2 = index 0）
    const rowsWithNum = rawRows.map((r, i) => ({ r, rowNum: i + 2 }));

    // 過濾已刪除：新資料看 G 欄（deleted 標記），舊資料相容 B 欄殘留的 [deleted] 寫法
    let valid = rowsWithNum.filter(({ r }) => r[1] && r[1] !== '[deleted]' && r[6] !== '1');
    if (dropTest) valid = valid.filter(({ r }) => !isTestMedia(r[3]));
    const filtered = event_id
      ? valid.filter(({ r }) => r[1] === event_id)
      : valid;

    // 企業場（批次 118，見 lib/audience.js）：與會者填的是公司，不是媒體——不算進「服務媒體家數」、
    // 媒體排行與填寫率（那幾個數字是要報給長官的公關成效）。問答則數照算。
    // 只看單一場企業場時，同一組數字照算，畫面上改叫「單位」（audience）。活動表走共用快取，讀不到就當沒有企業場。
    const businessIds = new Set(await readEventRows()
      .then((rows) => rows.filter((r) => isBusinessEvent(r[13])).map((r) => r[0]))
      .catch(() => []));
    const audience = event_id && businessIds.has(event_id) ? 'business' : 'media';
    const outletRows = audience === 'business' ? filtered : filtered.filter(({ r }) => !businessIds.has(r[1]));

    // 按活動分組（H 欄 source 是批次 2 才有的欄位，舊資料一律當 web）
    //
    // 媒體家數一律用 groupOutlets() 算（批次 105）：「經濟日報 王小明」與「經濟日報 林小美」是同一家，
    // 「（未提供）」「（內部職員）」與整句問題不算任何一家。以前拿 D 欄整串文字去重，三種都會多算。
    // 逐筆問答（questions）不再帶 AI 回答全文——成效報告只用 question 與 media，帶 answer 只是讓
    // 每次載入多傳好幾百 KB（120 筆就 211KB，登入就打兩次）。
    const byEvent = {};
    filtered.forEach(({ r }) => {
      const eid = r[1] || 'unknown';
      if (!byEvent[eid]) {
        byEvent[eid] = { event_id: eid, event_name: r[2] || eid, count: 0, medias: [], questions: [], line_count: 0, media_filled: 0 };
      }
      byEvent[eid].count++;
      // 媒體填寫率的分子：要真的有一家媒體才算（「（未填寫）」「（未提供）」「（群組提問）」、整句問題都不算）
      if (!isNotMedia(r[3]) && splitMedia(r[3]).outlet) byEvent[eid].media_filled++;
      if ((r[7] || 'web') === 'line') byEvent[eid].line_count++;
      byEvent[eid].medias.push(r[3]);
      if (!summaryOnly) byEvent[eid].questions.push({ time: r[0], media: r[3], reporter: r[8] || '', question: r[4], source: r[7] || 'web' });
    });

    const byEventArr = Object.values(byEvent).map(({ medias, questions, ...e }) => {
      const outlets = groupOutlets(medias);
      return { ...e, ...(summaryOnly ? {} : { questions }), media_list: outlets.map(o => o.name), media_count: outlets.length,
        audience: businessIds.has(e.event_id) ? 'business' : 'media' };
    });

    // 關鍵字統計：改用字典比對（活動的 chips／知識庫小標題 + 通用產業詞表），
    // 不再用「連續中文 2–8 字」貪婪切詞——貪婪切詞切出的是斷句碎片，
    // 兩位記者問同一件事只要措辭差一個字就會被算成兩個不同關鍵字，熱點永遠浮不出來。
    const GENERIC_TERMS = [
      'AI', '人工智慧', '量產', '技轉', '時程', '成本', '合作廠商', '合作對象', '應用場域',
      '技術突破', '商業化', '專利', '產能', '良率', '補助', '投資', '國際', '出貨', '市場',
      '規格', '效能', '安全', '法規', '永續', '碳排', '淨零', '智慧製造', '半導體', '晶片',
      '醫療', '機器人', '能源', '資安', '雲端', '合作備忘錄', 'MOU', '授權', '團隊', '成果'
    ];
    const dict = new Set(GENERIC_TERMS);
    const keywords = {};
    filtered.forEach(({ r }) => {
      const q = r[4] || '';
      dict.forEach(word => {
        if (q.includes(word)) keywords[word] = (keywords[word] || 0) + 1;
      });
    });
    const topKeywords = Object.entries(keywords)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // 每小時分佈
    // ⚠️ qa_log 的時間戳是 toLocaleString('zh-TW') 的字串，長這樣：「2026/8/27 下午9:57:22」
    // ——是 12 小時制帶「上午／下午」。原本只抓 `(\d{1,2}):\d{2}` 的話，下午 9 點會被
    // 算成 9 點，整個下午與晚上的問答全部疊到早上去（記者會多半在下午開，等於這張圖
    // 剛好把最重要的時段搬錯位置）。這份資料目前前端還沒有畫出來，但算錯就是算錯。
    const hourly = Array(24).fill(0);
    filtered.forEach(({ r }) => {
      const ts = r[0] || '';
      const match = ts.match(/(上午|下午)?\s*(\d{1,2}):\d{2}/);
      if (!match) return;
      let h = parseInt(match[2], 10);
      if (match[1] === '下午' && h < 12) h += 12;   // 下午12點就是 12，不再加
      if (match[1] === '上午' && h === 12) h = 0;    // 上午12點是午夜 0 點
      if (h >= 0 && h < 24) hourly[h]++;
    });

    // 媒體排行（同一家併在一起；不算「沒填／略過／員工自己問」）
    const allOutlets = groupOutlets(outletRows.map(({ r }) => r[3]));
    const topMedia = allOutlets.slice(0, 10).map(({ name, count }) => ({ name, count }));

    // 今日筆數：對「全部」filtered 資料算，不是只看 recent 那截斷後的 50 筆
    // ——記者會當天問答量很容易破 50，只看 recent 會讓「今日問答」數字失真。
    //
    // ⚠️ 兩個都修過的坑：
    // 1. 時區。qa_log 的時間戳是用 Asia/Taipei 寫的，但這裡原本沒指定時區，Vercel 上
    //    跑的是 UTC——台灣時間 00:00–08:00 之間，「今天」會算成台灣的昨天，早上開的
    //    記者會在後台看到的「今日問答」是 0。
    // 2. 用 includes() 比對。台灣時間 8/2 的 todayStr 是「2026/8/2」，而 8/20～8/29 的
    //    時間戳都包含這串，於是每個月 2 號都會把下旬的問答算成今天。改成只比對空白前
    //    的日期部分、而且要完全相等。
    const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
    const dayOf = (ts) => String(ts || '').trim().split(/[\s ]/)[0];
    const todayCount = filtered.filter(({ r }) => dayOf(r[0]) === todayStr).length;

    // 有媒體名稱的筆數／全部筆數：成效報告的「媒體填寫率」
    const filledRows = outletRows.filter(({ r }) => !isNotMedia(r[3]) && splitMedia(r[3]).outlet).length;

    const base = {
      total: filtered.length,
      today_count: todayCount,
      media_total: allOutlets.length,                       // 全部（或所選活動）服務了幾家媒體；企業場不算（見上面）
      media_filled_count: filledRows,
      audience,                                             // 所選的是企業場時，前台把「媒體」改叫「單位」
      business_qa: audience === 'media' ? filtered.length - outletRows.length : 0, // 企業場的問答則數（沒算進媒體數字的那些）
      by_event: byEventArr,
      top_keywords: topKeywords,
      top_media: topMedia,
      hourly_distribution: hourly
    };
    // 儀表板只要數字：不回逐筆（批次 104）。同樣 120 筆，完整版 200KB、摘要版 < 3KB。
    if (summaryOnly) return res.status(200).json(base);

    return res.status(200).json({
      ...base,
      unanswered_count: filtered.filter(({ r }) => UNANSWERED_RE.test(r[5] || '')).length,
      recent: filtered.slice(-limit).reverse().map(({ r, rowNum }) => ({
        time: r[0], event_id: r[1], event: r[2], media: r[3], reporter: r[8] || '', question: r[4],
        answer_preview: previewOf(r[5]), unanswered: UNANSWERED_RE.test(r[5] || ''),
        row_num: rowNum, source: r[7] || 'web'
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
