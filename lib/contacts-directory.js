// 全域技術窗口分工（跨活動，不綁定特定場次）——共用給 api/line.js（記者端查詢）跟
// api/events.js（後台編輯）用，兩邊都要讀寫同一份資料，格式跟預設種子只能有一份。
//
// 回報的意見：events!P 那組邀訪窗口是「某一場活動」的資料，但媒體常常不是為了特定
// 記者會發問，而是臨時想問某個技術領域「該找誰」——這時候不該卡在「請先告訴我您想
// 問哪一場活動」，應該直接給一份跨場次的技術窗口清單，不需要先綁定任何活動。
//
// 存放位置刻意跟 events 表分開、另開一個分頁：這份資料是組織架構（哪個所對應哪個
// 議題、誰負責），不是任何一場活動的內容，跟活動的生命週期無關，活動封存了這份還在。
// 整份存成一個儲存格（跟 events!G chips／events!H images 同一套「一格塞多行」的
// 做法），而不是拆成一列一列的表格——這份清單同仁會常常整批調整（換人、加新單位），
// 在後台一個 textarea 貼過去存檔，比維護一張多欄表格好編輯，也不用另外做欄位對應的
// 表單 UI。格式沿用跟 events!P 一樣的「用｜分隔、每行一組」寫法，同仁不用學第二種語法：
//   主題｜單位｜聯絡人｜電話｜LINE ID(選填)｜一行簡介(選填)

export const CONTACTS_DIR_RANGE = 'contacts_directory!A2:A2';

// 這份清單建立時間點是 2026/8，來源是傳播處組織圖（技術傳播組 + 中分院 + 產業學院），
// 姓名由朱朱確認——先落人名，電話／LINE ID 之後同仁再自行到後台補上。分頁第一次被
// 建立時（見 ensureContactsDirectorySheet()）自動種進去，之後完全由後台編輯，這裡
// 的內容不會再被程式碼覆蓋。
export const DEFAULT_CONTACTS_DIRECTORY = [
  '生醫｜生醫所｜丁嘉琳｜｜｜智慧醫療、醫材、精準健康相關技術',
  '量測｜服科／量測中心｜陳佳君｜｜｜量測驗證、服務科技相關技術',
  '機械｜機械所｜林潔玲｜｜｜機械、自動化系統相關技術',
  '資通｜資通所｜戴孟錚｜｜｜資通訊、AI、數位相關技術',
  '綠能｜綠能所｜徐喬涵｜｜｜綠能、淨零碳排、能源技術',
  '材料｜材化所｜李琦瑋｜｜｜材料、化工相關技術',
  '無人機｜無人化所｜丁嘉琳｜｜｜無人載具、無人機技術',
  '產業趨勢分析｜產科國際所｜朱則瑋｜0934-267-766｜｜產業趨勢分析、國際布局相關議題',
  '感測｜南分院／感測系統｜譚宇哲｜｜｜南部產業服務、感測系統技術',
  '機器人｜技術傳播組｜譚宇哲｜｜｜機器人相關技術議題',
  '中分院｜中分院｜黃馨儀｜｜｜中部產業服務與技術輔導',
  '產業學院｜產業學院｜曾伈榮｜｜｜產業人才培訓、課程',
  '電光｜電光所｜郭建志｜｜｜電子、光電相關技術',
  '其他｜｜朱則瑋｜｜｜找不到對應窗口時的綜合聯絡人（其他選項用，不會出現在主題按鈕上）'
].join('\n');

// 直接顯示在「請問想了解哪個技術領域」那排主題按鈕上的清單（順序照朱朱給的順序）。
// 「中分院」「產業學院」「電光」不放進按鈕——按鈕最多 13 顆、扣掉固定的「活動名稱」
// 「其他」只剩 11 格，這三個仍然查得到（見 lib/line.js 側「其他」的自由輸入比對），
// 只是不佔按鈕。
export const GLOBAL_CONTACT_TOPICS = ['產業趨勢分析', '生醫', '資通', '機器人', '無人機', '綠能', '量測', '機械', '材料', '感測'];

let ensured = false;
export async function ensureContactsDirectorySheet(ensureSheets, updateRange) {
  if (ensured) return;
  try {
    const created = await ensureSheets({ contacts_directory: ['content'] });
    if ((created || []).includes('contacts_directory')) {
      // 剛建立這個分頁，代表這是第一次執行——順手把已知名單種進去，同仁在後台看到
      // 的是「可以直接改」的現成清單，不是要從零開始造格式。
      await updateRange('contacts_directory!A2', [[DEFAULT_CONTACTS_DIRECTORY]]);
    }
  } catch (e) {
    console.error('ensureSheets(contacts_directory) 失敗:', e.message);
  }
  ensured = true;
}

export function parseContactsDirectory(raw) {
  return String(raw || '')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const [topic, unit, name, phone, lineId, intro] = line.split(/[|｜]/).map(s => (s || '').trim());
      return { topic, unit, name, phone, lineId, intro };
    })
    .filter(c => c.topic && c.name); // 缺主題或聯絡人的行直接略過，不要讓半填的資料跑出去
}

export function formatGlobalContact(c) {
  const lines = [`【${c.unit || c.topic}】邀訪窗口`];
  if (c.intro) lines.push(c.intro);
  lines.push(c.name);
  if (c.phone) lines.push(`📞 ${c.phone}`);
  if (c.lineId) lines.push(`LINE：${c.lineId}`);
  return lines.join('\n');
}

// 「其他」按鈕之後記者自己打的自由文字——跟 events!P 那組窗口的精準比對不同，這裡的
// 對象是記者隨手打的一句話（例如「我想問感測技術」），要求整句完全等於某個主題不
// 實際，改用「這句話裡有沒有出現某個主題或單位名稱」做寬鬆比對。抓錯的代價也比
// events!P 那組小很多——比對到的仍然是清單裡設定好的正確聯絡人，最壞情況只是轉去
// 問了一個不是最相關的單位，不是給錯電話號碼。
export function matchGlobalContactByText(text, directory) {
  const t = String(text || '').trim();
  if (!t) return null;
  const pool = directory.filter(c => c.topic !== '其他');
  const exact = pool.find(c => t === c.topic);
  if (exact) return exact;
  return pool.find(c => t.includes(c.topic) || (c.unit && t.includes(c.unit))) || null;
}
