// 批次 196（工單 B6）：評測的聲明稿題庫與新的評分規則。全程不呼叫模型（mock）。
// 重點跟批次 186 一樣：不是「標準答案會過」，而是「故意寫壞的答案會被抓到」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAnswer } from '../tools/eval/checks.mjs';
import { loadCases, runEval, shownTextFor, buildSystem } from '../tools/eval/run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = JSON.parse(fs.readFileSync(path.join(root, 'tools/eval/mock-statement.json'), 'utf8'));
const { event, cases } = loadCases('tools/eval/cases/statement.json');
const spec = (id) => cases.find((c) => c.id === id);
const grade = (id, raw) => gradeAnswer({ raw, shownText: shownTextFor(event, spec(id).q), spec: spec(id), profile: 'line' });
const failed = (g, level = 'hard') => g.checks.filter((c) => c.level === level && !c.pass).map((c) => c.name);
const DISC = '\n內容僅供參考，以工研院官網新聞稿或發言為準。';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); } };

await t('題庫：三類題目都有（口徑外追問、連續追問、資料沒寫），id 不重複，標準答案一題不多一題不少', () => {
  const tags = new Set(cases.map((c) => c.tag));
  for (const k of ['out-of-scope', 'follow-up', 'no-data']) assert.ok(tags.has(k), `缺 ${k}`);
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(Object.keys(GOOD).filter((k) => !k.startsWith('_')).sort(), [...ids].sort());
});
await t('題庫裡沒有真人姓名：用的是「研究員甲」', () => {
  assert.ok(JSON.stringify(cases).includes('研究員甲') && event.event_type === '敏感新聞回應說明');
});
await t('標準答案全部通過硬性檢查，也沒有軟性失敗', async () => {
  for (const c of cases) {
    const g = await grade(c.id, GOOD[c.id]);
    assert.ok(g.pass, `${c.id}：${failed(g).join('、')}｜${g.checks.filter((x) => !x.pass).map((x) => x.detail).join('；')}`);
    assert.deepEqual(failed(g, 'soft'), [], c.id);
  }
});
await t('runEval 跑聲明稿題庫（mock）：6／6 通過', async () => {
  const r = await runEval({ casesFile: 'tools/eval/cases/statement.json', provider: 'mock', mock: 'tools/eval/mock-statement.json' });
  assert.equal(r.summary.passed, 7);
  assert.equal(r.summary.total, 7);
});

// ── 故意寫壞的答案要被抓到 ──
await t('★ 口徑外的題目講成「我沒有資料」「無法確認」「無可奉告」→ 硬性失敗 out_of_scope_wording', async () => {
  for (const bad of ['這部分我沒有資料，無法確認是否還在討論中。', '目前無法確認。', '這個無可奉告。']) {
    const g = await grade('out-of-scope-pending', `${bad}\n[[NO_DATA:口徑外]]${DISC}`);
    assert.ok(failed(g).includes('out_of_scope_wording'), bad);
  }
});
await t('★ 模型自己寫「已轉給同仁」「幫您轉達」「轉介」→ 硬性失敗 no_false_handoff（轉告是不是真的只有程式知道）', async () => {
  for (const bad of ['這題我已經轉給公關同仁了。', '我會幫您轉達。', '已為您轉交給同仁。', '是否需要幫您轉介公關同仁？']) {
    const g = await grade('out-of-scope-pending', `院方目前對外的說明就到這裡。${bad}\n[[NO_DATA:口徑外]]${DISC}`);
    assert.ok(failed(g).includes('no_false_handoff'), bad);
  }
});
await t('★ 連續追問太長（超過 3 行）→ 硬性失敗 short_reply', async () => {
  const long = '了解。\n院方目前對外的說明就到這裡。\n我不方便替院方多做解讀。\n目前審議程序進行中。\n[[NO_DATA:口徑外]]' + DISC;
  assert.ok(failed(await grade('out-of-scope-followup', long)).includes('short_reply'));
  assert.ok(!failed(await grade('out-of-scope-followup', GOOD['out-of-scope-followup'])).includes('short_reply'));
});
await t('★ honest_no_data 新定義：沒標記、句型也不像沒資料（像是自己編了答案）→ 失敗；有標記或新講法的句型 → 通過', async () => {
  const fabricated = '審議預計三個月內完成。' + DISC;
  assert.ok(failed(await grade('written-missing', fabricated)).includes('honest_no_data'));
  // 沒有標記、只有新講法的句型：第二道網認得
  const phraseOnly = '了解，您想知道審議預計多久完成。這個我手上的資料還沒寫到。' + DISC;
  assert.ok(!failed(await grade('written-missing', phraseOnly)).includes('honest_no_data'));
  // 有標記、措辭完全換掉：看狀態、不看措辭
  const markerOnly = '了解，這一點先說到這裡。\n[[NO_DATA:審議期間]]' + DISC;
  assert.ok(!failed(await grade('written-missing', markerOnly)).includes('honest_no_data'));
});
await t('口徑外的題目沒有把關鍵詞填「口徑外」→ 只是軟性失敗（出口兜得住 no_data 的判斷，只是院方固定說法接不上）', async () => {
  const g = await grade('out-of-scope-pending', '院方目前對外的說明就到這裡，我不方便替院方多做解讀。\n[[NO_DATA:進度]]' + DISC);
  assert.ok(failed(g).length === 0 && failed(g, 'soft').includes('out_of_scope_marker'), failed(g).join());
});

// ── 評測的 prompt 跟正式站一致 ──
await t('line 版評測的 system prompt 用 LINE 的「答不出來」講法；web 版仍是舊的第 2 條', () => {
  assert.match(buildSystem(event, 'line'), /界線那一句與「要不要轉介真人」的詢問，由程式在你的回覆後面附上/);
  assert.doesNotMatch(buildSystem(event, 'line'), /直接說「這部分我沒有資料，建議洽現場新聞聯絡人」/);
  assert.match(buildSystem(event, 'web'), /直接說「這部分我沒有資料，建議洽現場新聞聯絡人」/);
});

console.log(`\n${fail ? '❌' : '✅'} 批次 196（評測：聲明稿題庫與新評分）測試：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
