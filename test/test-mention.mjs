// lib/line.js 的群組 @ 提及解析：isBotMentioned()／stripMentionText()。純函式、
// 不碰網路，直接餵 LINE webhook 會送來的 message.mention 物件形狀。
import { isBotMentioned, stripMentionText } from '../lib/line.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

console.log('── isBotMentioned ──');
check('isSelf: true → 有被提及',
  isBotMentioned({ mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] }));
check('只提及別人（isSelf: false）→ 沒被提及',
  !isBotMentioned({ mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ualice', isSelf: false }] }));
check('多個提及，其中一個是我們 → 有被提及', isBotMentioned({
  mentionees: [
    { index: 0, length: 3, type: 'user', userId: 'Ualice', isSelf: false },
    { index: 4, length: 3, type: 'user', userId: 'Ubot', isSelf: true }
  ]
}));
check('@all 廣播（沒有 isSelf）→ 不算被指名提及', !isBotMentioned({ mentionees: [{ index: 0, length: 4, type: 'all' }] }));
check('沒有 mention 物件（純文字訊息）→ 沒被提及', !isBotMentioned(undefined));
check('mention 物件存在但 mentionees 是空陣列 → 沒被提及', !isBotMentioned({ mentionees: [] }));
check('isSelf 欄位整個不存在（理論上不該發生，但要安全失敗成「沒提及」而不是誤觸）',
  !isBotMentioned({ mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot' }] }));

console.log('── stripMentionText ──');
// LINE 的 index/length 是 UTF-16 code unit 偏移量；中文字在 BMP 內每字 1 code unit，
// 這裡的例子都可以直接用一般字串 slice 心算驗證。
{
  const text = '@我 最近有哪些活動';
  const out = stripMentionText(text, { mentionees: [{ index: 0, length: 2 }] });
  check('單一提及：拿掉「@我」剩下問題', out === '最近有哪些活動', out);
}
{
  const text = '@我 @小明 這題你們一起看一下';
  const out = stripMentionText(text, { mentionees: [{ index: 0, length: 2 }, { index: 3, length: 3 }] });
  check('多個提及（含提及別人）全部拿掉，只留問題', out === '這題你們一起看一下', out);
}
{
  // 只 @ 了機器人、後面沒接任何文字
  const out = stripMentionText('@我', { mentionees: [{ index: 0, length: 2 }] });
  check('只有 @，沒有問題內容 → 回傳空字串', out === '', JSON.stringify(out));
}
check('沒有 mention 物件時原樣回傳（trim 過）', stripMentionText('  你好  ', undefined) === '你好');
check('mention 存在但 mentionees 是空陣列 → 原樣回傳', stripMentionText('你好', { mentionees: [] }) === '你好');
check('text 是 undefined（極端防呆）不會噴例外，回傳空字串',
  stripMentionText(undefined, { mentionees: [{ index: 0, length: 2 }] }) === '');
{
  // length 為 0 或缺欄位的畸形資料要被忽略，不能讓 slice 算出奇怪的結果
  const out = stripMentionText('@我 問題', { mentionees: [{ index: 0, length: 0 }, { index: 3 }] });
  check('畸形 mentionee（length=0 或缺 length）被忽略，不影響其餘文字', out === '@我 問題', out);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} @ 提及解析測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
