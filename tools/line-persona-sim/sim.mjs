// 四種角色實務情境模擬（批次 75）：報社記者、電視台記者、同事（職員）、長官。
// 跑真的 api/line.js，Sheets／LINE／Anthropic 用 test/fakes.mjs 的假版本。
// ⚠️ AI 回答是假的（「（假回答）」），AI 路由也是 fakes.mjs 的簡化規則——這支看的是
// 規則層、分流、按鈕、職員功能與非文字訊息，不是回答品質。
//   node tools/line-persona-sim/sim.mjs > 某檔.md
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
register('../../test/loader.mjs', import.meta.url);
const { sent, state, reset } = await import('../../test/fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 's'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
process.env.ANTHROPIC_API_KEY = 'test'; process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_STAFF_PASSCODE = 'openseasame';

let handler, seq = 0;
const fresh = async () => { handler = (await import(new URL(`../../api/line.js?v=${++seq}`, import.meta.url).href)).default; };
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 's').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
const src = (uid, group) => group ? { type: 'group', groupId: group, userId: uid } : { type: 'user', userId: uid };
function msg(uid, m, group, mention) {
  const message = typeof m === 'string' ? { type: 'text', text: m } : m;
  if (mention && message.type === 'text') message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  return { type: 'message', replyToken: 'rt' + Math.random(), source: src(uid, group), message };
}
const chipText = (q) => (q || []).map(c => typeof c === 'object' ? (c.text || c.label) : c).join('｜');
async function say(uid, m, { group, mention, note } = {}) {
  sent.length = 0;
  const t0 = Date.now();
  await handler(req([typeof m === 'object' && m.type && !m.text && m.type !== 'text' && m.replyToken ? m : msg(uid, m, group, mention)]), res);
  const shown = typeof m === 'string' ? m : `〔${m.type}〕`;
  console.log(`\n**👤 ${shown}**${note ? `　_（${note}）_` : ''}`);
  if (!sent.length) console.log('> （沒有回覆）');
  for (const s of sent) {
    const body = s.text ?? (s.messages ? s.messages.map(x => x.altText || x.text || x.type).join(' / ') : '');
    const tag = s.kind === 'answer' ? '［AI 活動問答・假］' : s.kind === 'fallback' ? '［AI 兜底・假］' : s.kind === 'digest' ? '［AI 摘要・假］' : `［${s.kind}］`;
    console.log('> ' + tag + ' ' + String(body).replace(/\n+/g, '⏎').slice(0, 420));
    if (s.quickReply?.length) console.log('>   按鈕：' + chipText(s.quickReply));
  }
  return sent.slice();
}
const H = (t) => console.log(`\n## ${t}\n`);

// ═══ 1. 報社記者（文字、細節、要數字、要窗口、會截圖） ═══
reset(); await fresh();
H('角色一：報社記者（聯合報 陳記者）');
await say('U_paper', 'hi', { note: '加好友後第一句' });
await say('U_paper', '你好，我是聯合報記者');
await say('U_paper', '最近有哪些活動');
await say('U_paper', '半導體先進封裝技術發表會');
await say('U_paper', '這場的重點是什麼');
await say('U_paper', '有新聞稿嗎');
await say('U_paper', '幾點開始？在哪裡？');
await say('U_paper', '可以給我受訪者的手機嗎');
await say('U_paper', '有照片可以用嗎');
await say('U_paper', '這個技術跟台積電比如何');
await say('U_paper', '媒體邀訪需求');
await say('U_paper', '我想約所長專訪');
await say('U_paper', '產業趨勢分析');
await say('U_paper', '工研院最近有什麼新聞');
await say('U_paper', { type: 'image', id: 'img1' }, { note: '傳一張現場照片' });
await say('U_paper', '回首頁');
await say('U_paper', '謝謝米亞');

// ═══ 2. 電視台記者（趕 SNG、語音、要畫面、要受訪、時間緊） ═══
reset(); await fresh();
H('角色二：電視台記者（TVBS 林記者，趕連線）');
await say('U_tv', '哈囉');
await say('U_tv', '明天奈米材料那場幾點？');
await say('U_tv', '奈米材料前瞻應用發表會');
await say('U_tv', '有沒有可以拍的畫面 展品有哪些');
await say('U_tv', 'SNG車可以停哪');
await say('U_tv', '可以安排誰受訪？要能上鏡講30秒的');
await say('U_tv', { type: 'audio', id: 'a1', duration: 8000 }, { note: '在車上直接傳語音' });
await say('U_tv', { type: 'sticker', packageId: '1', stickerId: '1' }, { note: '傳貼圖' });
await say('U_tv', '急！！新聞聯絡人電話');
await say('U_tv', '記者會延期了嗎');
await say('U_tv', '智慧醫療那場呢');
await say('U_tv', '換一場');
await say('U_tv', 'ok');

// ═══ 3. 同事（職員：登入、查數據、建活動、要連結、群組裡被 @） ═══
reset(); await fresh();
state.richMenus.push({ richMenuId: 'rm_r', name: 'reporter' }, { richMenuId: 'rm_s', name: 'staff' });
H('角色三：同事（公關組 小美，職員模式）');
await say('U_col', '朱朱叫我來登入');
await say('U_col', 'openseasame');
await say('U_col', '使用說明');
await say('U_col', '最近有哪些活動');
await say('U_col', '半導體先進封裝那場的後台數據');
await say('U_col', '記者都問了什麼');
await say('U_col', '新增活動 眺望2027產業發展趨勢研討會 10/28');
await say('U_col', '智慧醫療那場的媒體訓練連結');
await say('U_col', 'GEO 能見度現在如何');
await say('U_col', '記住：眺望研討會的新聞聯絡人是王小明 0912-345-678');
await say('U_col', '記憶清單');
await say('U_col', '這場的重點是什麼', { note: '職員沒指定哪一場' });
await say('U_col', '@米亞 智慧醫療那場幾點', { group: 'Cteam', mention: true, note: '在工作群組 @ 機器人' });
await say('U_col', '大家晚上吃什麼', { group: 'Cteam', note: '群組一般聊天、沒 @' });
await say('U_col', '退出職員模式');

// ═══ 4. 長官（懶得打字、口語、要結論、可能沒登入） ═══
reset(); await fresh();
H('角色四：長官（處長，未登入職員模式）');
await say('U_boss', '這個是什麼');
await say('U_boss', '上次記者會效果怎麼樣');
await say('U_boss', '有多少記者來問');
await say('U_boss', '幫我整理一下這週的活動');
await say('U_boss', '工研院是做什麼的');
await say('U_boss', '院長是誰');
await say('U_boss', 'AI能見度報告給我看');
await say('U_boss', '好');
reset(); await fresh();
state.staff.push(['U_boss2', '處長', '2026-09-01', '']);
H('角色四之二：長官（已是職員）');
await say('U_boss2', '上次記者會效果怎麼樣');
await say('U_boss2', '四足機器人那場成效');
await say('U_boss2', 'GEO 簡報給我');
await say('U_boss2', '下週有什麼要注意的');
await say('U_boss2', '辛苦了');

// ═══ 5. 追問型記者（批次 196、197）：答不出來時，先問「要不要轉介真人」，回「是」才通知 ═══
// 看的是「答不出來」那一段：模型只寫接住與能說的；界線與詢問由程式接（朱朱給的原文）；管理員有沒有收到推播（回「是」之前不該有）；
// 第二則是不是比第一則短且不重複。AI 回答是假的（用 state.answerText 模擬模型照新規則寫的樣子）。
reset(); await fresh();
process.env.LINE_ADMIN_USER_ID = 'Uadmin';
await fresh();
const STMT = '關於研究員甲資格案的回應說明';
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
state.events.push(['stmt', STMT, '#0F9E7A',
  ['【活動名稱】' + STMT, '【新聞稿全文】', '本院已依內部規定啟動審議程序，審議期間不對個案作進一步評論。', '【口徑外的問題】', '本案處理到哪一階段、後續是否有進一步處置，院方尚未對外說明；如有進一步消息，將於官網公告。'].join('\n'),
  'active', today, '', '', '', '工研院', 'c-stmt', '10:00', '線上發布', '敏感新聞回應說明', '公關組 王小明 02-1234-5678', '', '', '']);
const DISC = '\n內容僅供參考，以工研院官網新聞稿或發言為準。';

H('角色五：一般活動——資料沒寫，先問要不要轉介，回「是」才通知');
state.routeForce = () => ({ intent: 'qa', event_ids: ['semi'], confidence: 'high' });
state.answerText = '了解，您想確認的是現場有沒有停車位。\n[[NO_DATA:停車]]' + DISC;
await say('U_press', '半導體先進封裝技術發表會有提供停車嗎', { note: '第一次問：預期接住＋「目前尚未有這部分資料，是否幫您轉介公關同仁?」，還沒有推播' });
await say('U_press', '要，請轉介', { note: '按下按鈕：預期通知管理員，並回「我已經通知公關同仁了」' });
await say('U_press', '那有接駁車嗎', { note: '再問一題答不出來' });
await say('U_press', '不用了', { note: '婉拒：預期一句收尾、不通知' });

H('角色五之二：聲明稿（敏感新聞回應說明）——「這部分我們暫無回應」，公關默默收到通知');
state.routeForce = () => ({ intent: 'qa', event_ids: ['stmt'], confidence: 'high' });
state.answerText = '了解，您想確認的是後續會不會有進一步處理。\n[[NO_DATA:口徑外]]' + DISC;
await say('U_press2', `${STMT}：所以不會撤銷研究員甲的資格？`, { note: '第一次問' });
state.answerText = '這部分剛剛已經說明過了。\n[[NO_DATA:口徑外]]' + DISC;
await say('U_press2', '所以還在討論中？', { note: '追問：預期更短、不重貼整段' });

H('角色五之三：群組裡 @ 米亞——只有被問的那個人回「是」才算');
state.routeForce = () => ({ intent: 'qa', event_ids: ['semi'], confidence: 'high' });
state.answerText = '了解，您想確認的是現場有沒有停車位。\n[[NO_DATA:停車]]' + DISC;
await say('U_g1', '@米亞 半導體先進封裝技術發表會有提供停車嗎', { group: 'Cpress', mention: true });
await say('U_g2', '@米亞 是', { group: 'Cpress', mention: true, note: '別人回「是」：不算' });
await say('U_g1', '@米亞 是', { group: 'Cpress', mention: true, note: '被問的人回「是」：通知，說法不承諾在群組回' });
