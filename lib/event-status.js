// 活動卡與填寫進度（批次 77，職員模式第二批）。
//
// 盤點的結論（LINE-PLAN.md 批次 76）：職員模式「查」的功能很齊，但**看不到哪一場缺什麼**。
// 這支從 events 表的一列算出「這場填了多少、還缺什麼」，給三個地方用：
//   ① 活動卡（點活動名稱看到的那張）
//   ② 「活動與進度」總覽（所有近期場次一次列）
//   ③ 催填訊息（長按轉傳給負責填寫的同仁）
//
// ⚠️ 全部是純函式、不經過模型：「還缺什麼」要每次算出來都一樣，同仁才敢照著去催人。
//
// 必填項目是朱朱定的（批次 76 決定 3）：日期、地點、新聞聯絡人、新聞稿。其餘算加分。

// events 表欄位（同 api/events.js）：A id, B name, C color, D knowledge_base, E status,
// F 活動日期（沒填時是建立時間戳記）, G chips, H images, I greeting, J organizer,
// K edit_code, L event_time, M venue, N event_type, O press_contact, P contacts,
// Q invite_letter, R invite_letter_chips

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const SITE = 'https://itri-event-ai.vercel.app';
const BRAND = '#0F9E7A';

export const STATUS_LABEL = {
  draft: '🔒 未發布',
  active: '進行中',
  ended: '已結束',
  archived: '已封存'
};

// F 欄只有「純日期」才算活動日期；後面帶著時間的是系統寫的建立時間戳記，不算
// （跟 lib/prompt.js strictEventDate() 同一條規則）。
export function eventDateOf(raw) {
  const m = String(raw || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function dayDiff(iso, todayIso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000);
}

// 「2026-10-28」→「10/28（三）」
export function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

const filled = v => !!String(v || '').trim();

// 一場活動的檢查清單。todayIso 由呼叫端給（台灣時間的今天），測試才固定得住。
//
// 回傳：
//   { id, name, status, date, time, venue, daysLeft,
//     required: [{ key, label, done }], bonus: [...],
//     missingRequired: ['地點', ...], doneRequired, totalRequired, urgent }
//
// urgent：7 天內（含當天）要辦、必填還沒填齊。已結束／封存的場次不算。
export function eventChecklist(row, todayIso) {
  const r = row || [];
  const date = eventDateOf(r[5]);
  const status = r[4] || 'active';
  const daysLeft = date ? dayDiff(date, todayIso) : null;
  const isFuture = daysLeft !== null && daysLeft > 0;
  const kb = String(r[3] || '').trim();

  const required = [
    { key: 'date', label: '日期', done: !!date },
    { key: 'venue', label: '地點', done: filled(r[12]) },
    { key: 'press_contact', label: '新聞聯絡人', done: filled(r[14]) },
    { key: 'knowledge_base', label: '新聞稿', done: !!kb, detail: kb ? `${kb.length} 字` : '' }
  ];
  const bonus = [
    { key: 'event_time', label: '時間', done: filled(r[11]) },
    { key: 'chips', label: '快速提問', done: filled(r[6]) },
    // 邀請函只有「活動還沒到」時有意義（活動當天起就自動改用正式新聞稿，見 lib/prompt.js）
    ...(isFuture || !date ? [{ key: 'invite_letter', label: '邀請函', done: filled(r[16]) }] : []),
    { key: 'images', label: '照片', done: filled(r[7]) }
  ];
  const missingRequired = required.filter(i => !i.done).map(i => i.label);
  const live = status !== 'ended' && status !== 'archived';
  return {
    id: r[0], name: r[1] || '', status, date,
    time: String(r[11] || '').trim(), venue: String(r[12] || '').trim(),
    daysLeft, required, bonus, missingRequired,
    doneRequired: required.length - missingRequired.length,
    totalRequired: required.length,
    urgent: live && missingRequired.length > 0 && daysLeft !== null && daysLeft >= 0 && daysLeft <= 7
  };
}

function whenLine(c) {
  const parts = [];
  parts.push(c.date ? shortDate(c.date) : '日期未定');
  if (c.time) parts.push(c.time);
  if (c.venue) parts.push(c.venue);
  let s = parts.join('｜');
  if (c.daysLeft !== null && c.status !== 'ended' && c.status !== 'archived') {
    if (c.daysLeft === 0) s += '　今天';
    else if (c.daysLeft > 0) s += `　還有 ${c.daysLeft} 天`;
  }
  return s;
}

function progressLine(c) {
  if (!c.missingRequired.length) return `必填 ${c.totalRequired}／${c.totalRequired} ✅`;
  return `${c.urgent ? '⚠️ ' : ''}必填 ${c.doneRequired}／${c.totalRequired}，還缺：${c.missingRequired.join('、')}`;
}

// ── 「活動與進度」總覽 ─────────────────────────────────────────────────
// 列哪些場：還沒到、或日期未定的場次；封存、已結束的不列。排序：有日期的照日期、
// 日期未定的排最後。
// ⚠️ 批次 80：舊版「草稿一律列」，結果日期早就過了、沒人管的草稿排在清單最上面
// （回報：「不要跳出已經過期的活動」）。過期只看日期，不看狀態。
export function progressCandidates(rows, todayIso) {
  const list = (rows || [])
    .filter(r => r && r[0] && r[1] && r[4] !== 'archived' && r[4] !== 'ended')
    .map(r => eventChecklist(r, todayIso))
    .filter(c => c.daysLeft === null || c.daysLeft >= 0);
  return list.sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

export function formatProgressOverview(rows, todayIso, { max = 10 } = {}) {
  const list = progressCandidates(rows, todayIso);
  if (!list.length) {
    return { text: '目前沒有近期或未發布的活動。\n\n要開一場新的，按「新增活動」就可以。', names: [] };
  }
  const shown = list.slice(0, max);
  const urgentCount = list.filter(c => c.urgent).length;
  const lines = [`【活動與進度】近期 ${list.length} 場${urgentCount ? `，⚠️ ${urgentCount} 場快到了還沒填齊` : ''}`];
  for (const c of shown) {
    lines.push('');
    lines.push(`・${c.name}　${STATUS_LABEL[c.status] || c.status}`);
    lines.push(`　${whenLine(c)}`);
    lines.push(`　${progressLine(c)}`);
  }
  if (list.length > max) lines.push(`\n…還有 ${list.length - max} 場`);
  lines.push('\n點下面的活動名稱，看那一場的活動卡（可以開編輯頁、產生催填訊息）。');
  return { text: lines.join('\n'), names: shown.map(c => c.name) };
}

// ── 活動卡 ──────────────────────────────────────────────────────────
// stats：{ qaCount, trainingCount }，讀不到就傳 null（卡片照樣出，只是少那一行）。
// links：{ edit, training, preview }，edit／training 可能是空字串（編輯碼產生失敗時）。

function checkRow(item) {
  return {
    type: 'text', size: 'sm', wrap: true, flex: 1,
    color: item.done ? '#1A1A2E' : '#B45309',
    text: `${item.done ? '✅' : '⬜'} ${item.label}${item.detail ? `（${item.detail}）` : ''}`
  };
}
// Flex 沒有 grid，兩欄用「一列放兩個 text」排
function checkGrid(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2).map(checkRow);
    if (pair.length === 1) pair.push({ type: 'box', layout: 'vertical', flex: 1, contents: [] });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: pair });
  }
  return rows;
}
function uriButton(label, uri, primary) {
  return {
    type: 'button', height: 'sm', style: primary ? 'primary' : 'secondary',
    ...(primary ? { color: BRAND } : {}),
    action: { type: 'uri', label, uri }
  };
}
function msgButton(label, text) {
  return { type: 'button', height: 'sm', style: 'secondary', action: { type: 'message', label, text } };
}

export function buildEventCardFlex(c, stats, links) {
  const statLine = stats
    ? `記者問答 ${stats.qaCount} 則・媒體訓練 ${stats.trainingCount} 次`
    : '';
  const bodyContents = [
    { type: 'text', text: whenLine(c), size: 'sm', color: '#6B7280', wrap: true },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: `必填 ${c.doneRequired}／${c.totalRequired}`, weight: 'bold', size: 'sm', margin: 'md',
      color: c.missingRequired.length ? '#B45309' : BRAND },
    ...checkGrid(c.required),
    { type: 'text', text: '加分項目', weight: 'bold', size: 'sm', margin: 'md', color: '#6B7280' },
    ...checkGrid(c.bonus),
    ...(statLine ? [{ type: 'separator', margin: 'md' }, { type: 'text', text: statLine, size: 'xs', color: '#6B7280', margin: 'md', wrap: true }] : [])
  ];
  const footer = [];
  if (links.edit) footer.push(uriButton('✏️ 開啟編輯頁', links.edit, true));
  if (c.missingRequired.length || c.bonus.some(i => !i.done)) footer.push(msgButton('📨 催填訊息', `催填：${c.name}`));
  // 批次 78：草稿、而且必填都齊了，才出現「發布」——缺東西的時候按了也只會被擋下來
  if (c.status === 'draft' && !c.missingRequired.length) footer.push(msgButton('🚀 發布', `發布：${c.name}`));
  footer.push(msgButton('📊 問答數據', `數據：${c.name}`));
  if (links.training) footer.push(uriButton('🎓 媒體訓練', links.training, false));
  if (links.preview && c.status !== 'draft') footer.push(uriButton('👀 記者看到的頁面', links.preview, false));

  return {
    type: 'flex',
    altText: `《${c.name}》${STATUS_LABEL[c.status] || ''} 必填 ${c.doneRequired}/${c.totalRequired}` +
      (c.missingRequired.length ? `，還缺：${c.missingRequired.join('、')}` : ''),
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: c.status === 'draft' ? '#475569' : BRAND,
        paddingAll: '14px', spacing: 'xs',
        contents: [
          { type: 'text', text: STATUS_LABEL[c.status] || c.status, size: 'xs', color: '#E5F6F0' },
          { type: 'text', text: c.name, size: 'md', weight: 'bold', color: '#FFFFFF', wrap: true }
        ]
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm', contents: bodyContents },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer }
    }
  };
}

// Flex 送不出去時的純文字版（跟 GEO 簡報卡同一套降級）
export function formatEventCardText(c, stats, links) {
  const lines = [`《${c.name}》${STATUS_LABEL[c.status] || c.status}`, whenLine(c), ''];
  lines.push(progressLine(c));
  const missingBonus = c.bonus.filter(i => !i.done).map(i => i.label);
  if (missingBonus.length) lines.push(`加分項目還沒填：${missingBonus.join('、')}`);
  if (stats) lines.push(`記者問答 ${stats.qaCount} 則・媒體訓練 ${stats.trainingCount} 次`);
  if (links.edit) lines.push(`\n同仁編輯連結（不需要後台密碼）：\n${links.edit}`);
  if (links.training) lines.push(`\n媒體訓練：\n${links.training}`);
  lines.push(`\n要催人填，打「催填：${c.name}」。`);
  return lines.join('\n');
}

// ── 催填訊息 ────────────────────────────────────────────────────────
// 這一則是要被**長按轉傳**給負責填寫的同仁的，所以：
//   - 單獨成一則訊息（轉傳只會轉那一則泡泡）
//   - 寫給「對方」看，不是寫給職員看
//   - 不放任何職員才看得懂的字（後台、draft、編輯碼）
export function formatNudgeMessage(c, editUrl) {
  const lines = [`您好，《${c.name}》的活動資料麻煩協助補齊 🙏`];
  if (c.date) lines.push(`活動日期：${shortDate(c.date)}${c.daysLeft > 0 ? `，還有 ${c.daysLeft} 天` : ''}`);
  if (c.missingRequired.length) lines.push(`\n必填還缺：${c.missingRequired.join('、')}`);
  const missingBonus = c.bonus.filter(i => !i.done).map(i => i.label);
  if (missingBonus.length) lines.push(`${c.missingRequired.length ? '' : '\n'}有空再補：${missingBonus.join('、')}`);
  lines.push('\n手機點下面的連結就能直接填，不需要帳號密碼：');
  lines.push(editUrl);
  lines.push('\n填好後，記者在 LINE 問米亞就查得到這場的內容。謝謝！');
  return lines.join('\n');
}

export const previewLink = id => `${SITE}/event?id=${encodeURIComponent(id)}`;
