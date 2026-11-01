// 記者端的圖像卡共用元件（批次 181）：技術與洽案、近期新聞、產業趨勢、邀訪窗口都用這一支。
//
// 為什麼可以圖像化、又不傷到「複製」：圖像卡裡的字沒辦法選取複製（記者要複製信箱、標題去搜尋），所以
//   ・每張卡的快速回覆第一顆都是「📋 純文字（可複製）」，點了就用原本的純文字版面再送一次（見 lib/line-reporter.js）
//   ・連結一律做成按鈕（uri），網址不再貼成一長串
//   ・群組、沒有資料、Flex 送不出去：一律是原本的純文字
// 內容仍然是**程式照官網的字排出來的，不經過模型**（CLAUDE.md 第 2 條）：這支只負責排版，不改字。

export const CARD_BRAND = '#0F9E7A';
export const PLAIN_CHIP_LABEL = '📋 可複製版';

/** 只收 http／https 的網址（LINE uri 動作不合格會整則被退，所以寧可不放按鈕）。 */
export const uriOk = (u) => /^https?:\/\/\S{4,990}$/.test(String(u || ''));

/**
 * 電話 → tel: 連結。只認「純數字格式」（數字、空白、連字號、括號、加號、#）：寫著「分機」這類中文的，
 * 拿掉中文再撥會撥錯號碼（打錯一碼就是聯絡不到人），寧可沒有按鈕、只顯示文字。
 */
export function telUri(phone) {
  const p = String(phone || '').trim();
  if (!/^\+?[\d\s\-()#]{5,30}$/.test(p)) return '';
  const digits = p.replace(/[^\d+#]/g, '');
  return /^\+?\d{5,}/.test(digits) ? `tel:${digits}` : '';
}

const t = (text, o = {}) => ({ type: 'text', text: String(text), wrap: true, ...o });

/** 一則項目的卡片（一個泡泡）。tag：最上面的小字（領域／第幾則）。 */
export function itemBubble({ tag = '', title, meta = '', body = '', lines = [], buttons = [] }) {
  const contents = [
    ...(tag ? [t(tag, { size: 'xxs', color: CARD_BRAND, weight: 'bold' })] : []),
    t(title || '（無標題）', { size: 'sm', weight: 'bold', color: '#1A1A2E', margin: tag ? 'sm' : 'none' }),
    ...(meta ? [t(meta, { size: 'xs', color: '#6B7280', margin: 'xs' })] : []),
    ...(body ? [t(body, { size: 'xs', color: '#374151', margin: 'md', maxLines: 7 })] : []),
    ...lines.filter(Boolean).map((l, i) => t(l, { size: 'xs', color: '#1A1A2E', margin: i === 0 ? 'md' : 'xs' }))
  ];
  const foot = buttons.filter(b => b && uriOk(b.uri));
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'none', contents },
    ...(foot.length ? {
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'sm',
        contents: foot.map(b => ({ type: 'button', height: 'sm', style: 'secondary', action: { type: 'uri', label: b.label, uri: b.uri } }))
      }
    } : {})
  };
}

/** 一組泡泡 → 一則 Flex（橫向滑動）。LINE 一個輪播最多 12 個泡泡。 */
export function carouselFlex(altText, bubbles) {
  const list = bubbles.slice(0, 12);
  return {
    type: 'flex',
    altText: String(altText).slice(0, 380),
    contents: list.length === 1 ? list[0] : { type: 'carousel', contents: list }
  };
}

/**
 * 邀訪窗口卡：單位（標題）、姓名、電話、LINE ID；電話是純數字格式才放「📞 撥打」按鈕。
 * 資料原樣顯示，不改字（電話、LINE ID 打錯一碼就是聯絡不到人）。
 */
export function buildContactFlex({ title, name, phone = '', lineId = '', intro = '' }) {
  const tel = telUri(phone);
  const body = [
    t(title, { size: 'xs', color: CARD_BRAND, weight: 'bold' }),
    ...(intro ? [t(intro, { size: 'xs', color: '#6B7280', margin: 'sm' })] : []),
    t(name, { size: 'md', weight: 'bold', color: '#1A1A2E', margin: 'md' }),
    ...(phone ? [t(`📞 ${phone}`, { size: 'sm', color: '#1A1A2E', margin: 'sm' })] : []),
    ...(lineId ? [t(`LINE：${lineId}`, { size: 'sm', color: '#1A1A2E', margin: 'xs' })] : [])
  ];
  return {
    type: 'flex',
    altText: `邀訪窗口：${title}　${name}${phone ? `　${phone}` : ''}`.slice(0, 380),
    contents: {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'none', contents: body },
      ...(tel ? {
        footer: { type: 'box', layout: 'vertical', paddingAll: '10px', contents: [
          { type: 'button', height: 'sm', style: 'primary', color: CARD_BRAND, action: { type: 'uri', label: '📞 撥打', uri: tel } }
        ] }
      } : {})
    }
  };
}

// ── 按鈕卡（批次 182）───────────────────────────────────────────────────────
// 把「要選的東西」從快速回覆（一次只看得到兩三顆、要左右滑，記者不知道可以滑）搬到卡片上：全部直接看得到、往上捲也還在。
// buttons：[{ label, text }]（或純字串），送出的是 text——跟原本的快速回覆按鈕一模一樣，後端的規則與群組放行都不用改。
// columns：1＝一列一顆（題目、窗口這種字比較長的），2＝兩顆一列（領域這種短字）。label 上限 20 字（LINE 規定）。
const norm = (b) => {
  const label = String(typeof b === 'object' ? b.label : b);
  const text = String(typeof b === 'object' ? (b.text ?? b.label) : b);
  return { label: label.length > 20 ? label.slice(0, 19) + '…' : label, text: text.slice(0, 300) };
};

export function buildButtonCard({ title, hint = '', buttons, columns = 2, altText = '', footerNote = '' }) {
  const list = buttons.map(norm).slice(0, 12);
  const rows = [];
  for (let i = 0; i < list.length; i += columns) {
    const group = list.slice(i, i + columns).map(b => ({
      type: 'button', height: 'sm', style: 'secondary', flex: 1,
      action: { type: 'message', label: b.label, text: b.text }
    }));
    while (group.length < columns) group.push({ type: 'filler' });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: group });
  }
  return {
    type: 'flex',
    altText: (altText || title).slice(0, 380),
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: CARD_BRAND, paddingAll: '14px', spacing: 'xs',
        contents: [
          t(title, { size: 'md', weight: 'bold', color: '#FFFFFF' }),
          ...(hint ? [t(hint, { size: 'xs', color: '#E5F6F0' })] : [])
        ]
      },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'none', contents: rows },
      ...(footerNote ? { footer: { type: 'box', layout: 'vertical', paddingAll: '10px', contents: [t(footerNote, { size: 'xs', color: '#6B7280' })] } } : {})
    }
  };
}

/** 「這場可以問什麼」：題目一顆一列，點了就等於打那句話。 */
export function buildQuestionsCard(eventName, questions) {
  return buildButtonCard({
    title: '💡 這場可以這樣問',
    hint: `《${eventName}》點一題，或直接打字問我`,
    buttons: questions, columns: 1,
    altText: `《${eventName}》可以問的題目`
  });
}
