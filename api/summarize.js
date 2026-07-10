// 知識庫自動摘要 API
// POST { password, text } → 用 Claude 將貼上的長文/新聞稿整理成精簡知識庫（≤約 2500 字）
// 供後台「貼長文或上傳 PDF → 自動生成知識庫」使用

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 未設定' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  const { password, text } = req.body || {};
  if (password !== adminPassword) return res.status(401).json({ error: '密碼錯誤' });
  if (!text || text.trim().length < 50) return res.status(400).json({ error: '內容太短，請貼上完整新聞稿或資料' });

  // 保護：過長時截斷（避免超出模型輸入）
  const source = text.length > 40000 ? text.slice(0, 40000) : text;

  const systemPrompt = `你是記者會新聞稿的知識庫整理助手。請把使用者提供的原始資料，整理成一份給「記者會 AI 新聞助理」使用的知識庫。

要求：
- 使用繁體中文，總長度控制在 2500 字以內。
- 完整保留重要事實：關鍵數字、日期、金額、規格、人名與職稱、單位與合作廠商名稱、技術亮點、應用場域。
- 移除純贅述、口號、重複段落與排版雜訊。
- 以清楚的分段或條列呈現，方便 AI 快速檢索作答。
- 不要杜撰或加入原文沒有的資訊；不確定的內容不要寫。
- 直接輸出整理後的知識庫內容本身，不要加「以下是…」之類的開場白。`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: `請整理以下資料成知識庫：\n\n${source}` }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API 錯誤' });

    const summary = data.content?.[0]?.text?.trim() || '';
    if (!summary) return res.status(500).json({ error: '摘要產生失敗，請重試' });
    return res.status(200).json({ summary });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
}
