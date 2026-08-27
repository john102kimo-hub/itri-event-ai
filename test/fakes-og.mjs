// 給 test-og.mjs 用的假 events 資料。
// 欄位順序照 events!A2:K：A id, B name, C color, D kb, E status, F date,
// G chips, H images, I greeting, J organizer, K edit_code
const row = (id, name, status, images) =>
  [id, name, '#0F9E7A', '【新聞稿】內容內容。', status, '2026-08-08', '', images, '', '工研院', ''];

export const state = {
  events: [
    row('no-photos', '沒有照片的記者會', 'ended', ''),
    row('with-photos', '有照片的記者會', 'ended',
      'https://blob.example.com/a.jpg\nhttps://blob.example.com/second.png'),
    row('caption', '圖說格式記者會', 'ended',
      'https://blob.example.com/b.png｜何次長致詞'),
    row('bad-formats', '格式不合的記者會', 'ended',
      [
        'https://blob.example.com/x.webp',              // LINE/OG 不吃 webp
        'https://blob.example.com/y.gif',
        'http://blob.example.com/z.jpg',                // 非 https
        'https://drive.google.com/file/d/abc/view'      // 分享頁不是圖片直連
      ].join('\n')),
    row('mixed', '混合格式記者會', 'ended',
      'https://blob.example.com/x.webp\nhttp://nope.com/a.jpg\nhttps://blob.example.com/ok.jpeg｜現場合影'),
    row('active', '還沒辦的記者會', 'active', '')
  ]
};

export const sheets = {
  async readRange(range) {
    if (range.startsWith('events!')) return state.events.map(r => [...r]);
    return [];
  }
};
