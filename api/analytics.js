// 問答分析 API
// GET  ?password=xxx             → 全部活動統計（含 row_num 供刪除／改媒體名稱）
// GET  ?password=xxx&event_id=xx → 單一活動統計
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
// 管理員密碼也可用 X-Admin-Password header 傳（GET 用這個，不要放在網址上——
// 網址會留在瀏覽器歷史與伺服器存取紀錄裡）。

import { readRange, updateRange } from '../lib/sheets.js';

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

  const adminPassword = process.env.ADMIN_PASSWORD;

  // ── POST：刪除單筆 ────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, password, row_num, timestamp, question } = req.body || {};
    if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
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
      // D 欄是媒體名稱，只動這一欄。
      await updateRange(`qa_log!D${row_num}:D${row_num}`, [[name]]);
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
  const password = req.headers['x-admin-password'] || req.query.password;
  const { event_id, exclude_test } = req.query;
  if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });

  // 判斷是否為測試資料（依媒體名稱）：測試 / test / demo / 純數字 / 常見亂打
  const isTestMedia = (m) => {
    if (!m) return false;
    const s = String(m).trim().toLowerCase();
    if (/測試|test|demo|範例|sample|練習/.test(s)) return true;
    if (/^[0-9]+$/.test(s)) return true;
    if (/^(abc|xxx|aaa|ttt|qqq|asdf|qwer|zzz|123)$/.test(s)) return true;
    return false;
  };
  const dropTest = exclude_test === '1' || exclude_test === 'true';

  // recent 預設回最近 50 筆，可用 ?limit= 調整（上限 500）——記者會當天問答量很容易破 50，
  // 「今日問答」與「最新問答」在最需要盯的那天反而會失準。
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);

  try {
    const rawRows = await readRange('qa_log!A2:H');
    // 保留原始 row_num（sheet 第幾列，row 2 = index 0）
    const rowsWithNum = rawRows.map((r, i) => ({ r, rowNum: i + 2 }));

    // 過濾已刪除：新資料看 G 欄（deleted 標記），舊資料相容 B 欄殘留的 [deleted] 寫法
    let valid = rowsWithNum.filter(({ r }) => r[1] && r[1] !== '[deleted]' && r[6] !== '1');
    if (dropTest) valid = valid.filter(({ r }) => !isTestMedia(r[3]));
    const filtered = event_id
      ? valid.filter(({ r }) => r[1] === event_id)
      : valid;

    // 按活動分組（H 欄 source 是批次 2 才有的欄位，舊資料一律當 web）
    const byEvent = {};
    filtered.forEach(({ r }) => {
      const eid = r[1] || 'unknown';
      if (!byEvent[eid]) {
        byEvent[eid] = { event_id: eid, event_name: r[2] || eid, count: 0, media_list: new Set(), questions: [], line_count: 0 };
      }
      byEvent[eid].count++;
      if ((r[7] || 'web') === 'line') byEvent[eid].line_count++;
      if (r[3] && r[3] !== '（未填寫）') byEvent[eid].media_list.add(r[3]);
      byEvent[eid].questions.push({ time: r[0], media: r[3], question: r[4], answer: r[5], source: r[7] || 'web' });
    });

    const byEventArr = Object.values(byEvent).map(e => ({
      ...e,
      media_list: [...e.media_list],
      media_count: e.media_list.size
    }));

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

    // 媒體排行
    const mediaCount = {};
    filtered.forEach(({ r }) => {
      const m = r[3];
      if (m && m !== '（未填寫）') mediaCount[m] = (mediaCount[m] || 0) + 1;
    });
    const topMedia = Object.entries(mediaCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count }));

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

    return res.status(200).json({
      total: filtered.length,
      today_count: todayCount,
      by_event: byEventArr,
      top_keywords: topKeywords,
      top_media: topMedia,
      hourly_distribution: hourly,
      recent: filtered.slice(-limit).reverse().map(({ r, rowNum }) => ({
        time: r[0], event_id: r[1], event: r[2], media: r[3], question: r[4], row_num: rowNum, source: r[7] || 'web'
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
