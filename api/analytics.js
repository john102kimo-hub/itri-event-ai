// 問答分析 API
// GET  ?password=xxx             → 全部活動統計（含 row_num 供刪除）
// GET  ?password=xxx&event_id=xx → 單一活動統計
// POST {action:'delete', row_num, password, timestamp, question} → 標記刪除單筆 Q&A
//
// 管理員密碼也可用 X-Admin-Password header 傳（GET 用這個，不要放在網址上——
// 網址會留在瀏覽器歷史與伺服器存取紀錄裡）。

import { readRange, updateRange } from '../lib/sheets.js';

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
    const hourly = Array(24).fill(0);
    filtered.forEach(({ r }) => {
      const match = (r[0] || '').match(/(\d{1,2}):\d{2}/);
      if (match) { const h = parseInt(match[1]); if (h >= 0 && h < 24) hourly[h]++; }
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
    const todayStr = new Date().toLocaleDateString('zh-TW');
    const todayCount = filtered.filter(({ r }) => r[0] && r[0].includes(todayStr)).length;

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
