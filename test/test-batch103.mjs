// 批次 103（A 批：全面審視後的修正）的回歸測試。
//   一、LINE 群組：列過活動清單後，閒聊不能被當成問題回答（批次 101 留下的退步）
//   二、1 對 1：笑聲／附和語不再被當成主題詞複誦
// 跑真的 api/line.js（Sheets／LINE／Anthropic 用 test/fakes.mjs 的假版本）。
import { register } from 'node:module';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

register('./loader.mjs', import.meta.url);
const { sent, state, reset } = await import('./fakes.mjs');
process.env.LINE_CHANNEL_SECRET = 'testsecret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'testtoken';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.GOOGLE_SPREADSHEET_ID = '';
process.env.LINE_BASIC_ID = '@123abcde';

let handler, modSeq = 0;
async function fresh() { handler = (await import(new URL(`../api/line.js?v=${++modSeq}`, import.meta.url).href)).default; }
const res = { status() { return this; }, json() { return this; }, end() { return this; }, setHeader() { return this; }, send() { return this; } };

let seq = 0;
function req(events) {
  const body = JSON.stringify({ events });
  const r = new EventEmitter(); r.method = 'POST';
  r.headers = { 'x-line-signature': createHmac('sha256', 'testsecret').update(Buffer.from(body)).digest('base64') };
  setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
  return r;
}
async function g(uid, text, { mention = false, groupId = 'Cg103' } = {}) {
  const q = 'qt' + (++seq);
  const message = { type: 'text', id: 'm' + seq, quoteToken: q, text };
  if (mention) message.mention = { mentionees: [{ index: 0, length: 3, type: 'user', userId: 'Ubot', isSelf: true }] };
  sent.length = 0;
  await handler(req([{ type: 'message', replyToken: 'rt' + seq, source: { type: 'group', groupId, userId: uid }, message }]), res);
  return sent.slice();
}
async function dm(uid, text) {
  sent.length = 0;
  await handler(req([{ type: 'message', replyToken: 'rt' + (++seq), source: { type: 'user', userId: uid }, message: { type: 'text', id: 'm' + seq, quoteToken: 'qt' + seq, text } }]), res);
  return sent.slice();
}
const answered = out => out.some(s => s.kind === 'answer');
const allText = out => out.map(s => s.text || '').join('\n');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 300) : ''}`); }
}

// ── 一、群組：列過活動清單後，閒聊要安靜 ────────────────────────────────────
console.log('\n── 一、群組：列過活動清單後的 10 分鐘內，閒聊不能被當成問題（批次 101 的退步）──');
const CHATTER = ['哈哈好喔', '對啊', '哈哈哈哈', '是喔', '真的假的'];
{
  // A：先列清單（留下 calendar 話題記憶），再綁定一場
  reset(); await fresh();
  await g('U王', '@米亞 最近有哪些活動', { mention: true });
  await g('U王', '半導體先進封裝技術發表會');
  let n = 0;
  for (const t of CHATTER) {
    const out = await g('U陳' + (++n), t);
    check(`★ 清單送出後，群組裡的「${t}」→ 安靜`, out.length === 0, allText(out));
  }

  // B：沒列過清單（對照組，本來就安靜）
  reset(); await fresh();
  await g('U王', '@米亞 半導體先進封裝技術發表會的重點', { mention: true });
  for (const t of CHATTER) {
    const out = await g('U陳' + (++n), t);
    check(`（對照）沒列過清單時，「${t}」→ 安靜`, out.length === 0, allText(out));
  }
}

console.log('\n── 一之二、清單上的場次名稱片段，照樣要接得住（批次 101 的本意不能被這次修正弄壞）──');
{
  reset(); await fresh();
  // 群組先被 @ 一次拿到清單，還沒綁定任何一場；接著另一位記者沒 @、只打場次名稱的一部分
  await g('U王', '@米亞 最近有哪些活動', { mention: true });
  const out = await g('U李', '先進封裝');
  check('★ 清單送出後，打「先進封裝」（清單上半導體那場的一部分）→ 有回答', answered(out), allText(out));
  check('　 回答的是半導體那一場', state.bindings.get('Cg103')?.event_id === 'semi', JSON.stringify(state.bindings.get('Cg103')));

  reset(); await fresh();
  await g('U王', '@米亞 最近有哪些活動', { mention: true });
  const noMatch = await g('U李', '他們晚點到');
  check('　 清單上沒有的字（「他們晚點到」）→ 安靜', noMatch.length === 0, allText(noMatch));
}

console.log('\n── 一之三、趨勢／技術題之後的「裸名詞追問」照舊放行（那是米亞自己邀請的）──');
{
  reset(); await fresh();
  // 同一個人：@ 米亞問技術 → 米亞問「想了解哪一項」→ 他回「機器人」→ 答完留下 tech_query 話題記憶
  await g('U王', '@米亞 想問什麼技術', { mention: true });
  const ans = await g('U王', '機器人');
  check('　（前置）回答了「機器人」這項技術', ans.length > 0, allText(ans));
  const follow = await g('U李', '太空');
  check('★ 接著另一位記者沒 @、只打「太空」→ 仍然會接', follow.length > 0, allText(follow));
  const chatter = await g('U陳', '哈哈好喔');
  check('　 同一段時間內，笑聲「哈哈好喔」→ 安靜', chatter.length === 0, allText(chatter));
}

// ── 二、1 對 1：笑聲／附和語不被當成主題詞 ───────────────────────────────────
console.log('\n── 二、1 對 1：笑聲／附和語不再被複誦成「我可以從兩個方向幫您找」──');
{
  reset(); await fresh();
  for (const t of ['哈哈好喔', '對啊', '哈哈哈哈']) {
    const out = await dm('U_dm_' + t, t);
    const txt = allText(out);
    const btns = out.flatMap(s => (s.quickReply || []).map(i => (typeof i === 'object' ? i.text ?? i.label : i)));
    check(`★ 「${t}」→ 不複誦成主題詞`, !txt.includes(`『${t}』`) && !txt.includes(`「${t}」`) || !/方向幫您找/.test(txt), txt);
    check(`　 「${t}」→ 沒有「${t}的產業趨勢」這種按鈕`, !btns.some(b => String(b).includes(t)), JSON.stringify(btns));
  }
  // 真的主題詞不受影響
  const real = await dm('U_dm_real', '太空');
  check('　 真的主題詞「太空」→ 照舊問「產業趨勢還是工研院技術」', /方向幫您找|產業趨勢|工研院技術/.test(allText(real)), allText(real));
  const real2 = await dm('U_dm_real2', '真空');
  check('　 第一個字剛好是「真」的真主題詞「真空」→ 仍當主題詞（不誤擋）', /方向幫您找|產業趨勢|工研院技術/.test(allText(real2)), allText(real2));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 103（A 批）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
