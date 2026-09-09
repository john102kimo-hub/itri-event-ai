// lib/related-events.js：跨場次相關資料挑選。純函式、不碰網路，直接餵接近真實的
// 場次資料。重點是「問『今年院士有誰』要挑得到院士授證典禮那場」——那正是回報的案例。
import { extractTerms, selectRelatedEvents, formatRelatedEventsBlock } from '../lib/related-events.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${label}${detail ? '\n   ' + detail : ''}`); }
}

// 接近真實的場次：每一篇都寫成新聞稿的樣子，共用一堆泛用詞（工研院、技術、產業），
// 差別在各自的主題。挑選要靠主題詞分辨，不能被共用詞帶著走。
const events = [
  {
    id: 'fellow', name: '工研院院士授證典禮',
    knowledge_base: '工研院今日舉行第15屆院士授證典禮，由總統親自授證。本屆新任院士包括半導體領域的張三、資通訊領域的李四、智慧醫療領域的王五，三位院士長期投入技術研發與產業推動。院士制度自2008年設立，旨在表彰對產業有卓越貢獻的人士。'
  },
  {
    id: 'summit', name: '2026晶鏈高峰論壇',
    knowledge_base: '2026晶鏈高峰論壇今日登場，共有美國、日本、歐盟等38國代表出席。論壇聚焦半導體供應鏈韌性與AI晶片發展，工研院表示將持續推動國際合作。現場並頒發經濟部專業獎章。'
  },
  {
    id: 'quad', name: '四足機器人國產研發平台發表記者會',
    knowledge_base: '工研院發表四足機器人國產研發平台，整合感測、運動控制與AI決策技術，可應用於巡檢與救災場域。平台已與多家廠商合作導入。'
  },
  {
    id: 'nano', name: '奈米材料前瞻應用發表會',
    knowledge_base: '工研院發表奈米材料前瞻應用成果，涵蓋能源儲存與環境感測兩大方向，相關技術已完成試量產驗證。'
  },
  {
    id: 'empty', name: '尚未提供資料的場次', knowledge_base: '   '
  }
];

console.log('── extractTerms ──');
{
  const t = extractTerms('今年院士有誰');
  check('中文問句切出 2-gram，含關鍵的「院士」', t.includes('院士'), JSON.stringify(t));
  check('也切出 3-gram', t.includes('今年院'), JSON.stringify(t));
}
check('英數詞抓得到（AI）', extractTerms('AI 晶片的進展').includes('ai'), JSON.stringify(extractTerms('AI 晶片的進展')));
check('英數詞抓得到（含數字的 5G）', extractTerms('5G 佈建').includes('5g'), JSON.stringify(extractTerms('5G 佈建')));
check('空字串不會噴例外', extractTerms('').length === 0);
check('單一中文字不產生詞（雜訊太多）', extractTerms('好').length === 0, JSON.stringify(extractTerms('好')));

console.log('── selectRelatedEvents：回報的案例 ──');
{
  // 記者綁在「晶鏈高峰論壇」，問的卻是院士——答案在另一場的新聞稿裡。
  const picked = selectRelatedEvents('今年院士有誰', events, { exclude: 'summit' });
  check('問「今年院士有誰」→ 挑得到《工研院院士授證典禮》', picked[0]?.id === 'fellow',
    JSON.stringify(picked.map(e => e.id)));
}
{
  const picked = selectRelatedEvents('院士授證典禮是誰授證的', events, { exclude: 'summit' });
  check('問得更明確一點 → 一樣挑得到那場', picked[0]?.id === 'fellow', JSON.stringify(picked.map(e => e.id)));
}
{
  const picked = selectRelatedEvents('四足機器人可以用在哪裡', events, { exclude: 'summit' });
  check('問四足機器人 → 挑得到那場，不是院士那場', picked[0]?.id === 'quad', JSON.stringify(picked.map(e => e.id)));
}

console.log('── selectRelatedEvents：不該亂挑 ──');
check('主場次自己不會被挑進來（已經完整帶進 prompt 了）',
  !selectRelatedEvents('今年院士有誰', events, { exclude: 'fellow' }).some(e => e.id === 'fellow'),
  JSON.stringify(selectRelatedEvents('今年院士有誰', events, { exclude: 'fellow' }).map(e => e.id)));
check('沒有知識庫的場次不會被挑（帶進去也沒東西可讀）',
  !selectRelatedEvents('尚未提供資料', events).some(e => e.id === 'empty'));
{
  // 只由泛用詞組成的問句，不該把每一場都拖進來
  const picked = selectRelatedEvents('工研院的技術', events, { exclude: 'summit' });
  check('只有泛用詞的問句 → 不會把所有場次都挑進來', picked.length < 3,
    `挑了 ${picked.length} 場：${JSON.stringify(picked.map(e => e.id))}`);
}
check('問句完全沒有可用詞 → 回空陣列', selectRelatedEvents('？？', events).length === 0);
check('沒有任何場次 → 回空陣列，不會噴例外', selectRelatedEvents('院士', []).length === 0);
check('events 傳 null → 回空陣列', selectRelatedEvents('院士', null).length === 0);

console.log('── 上限 ──');
{
  const picked = selectRelatedEvents('半導體 AI 技術 機器人 奈米 院士', events, { maxEvents: 2 });
  check('挑中的場次數不超過 maxEvents', picked.length <= 2, JSON.stringify(picked.map(e => e.id)));
}
{
  // 第一名就超過字數上限時，還是要收——挑到第一名卻因為長度丟掉，整支等於白做
  const huge = [{ id: 'huge', name: '超長場次', knowledge_base: '院士' + 'x'.repeat(50000) }];
  const picked = selectRelatedEvents('院士', huge, { maxChars: 100 });
  check('第一場就超過字數上限時仍然收下（不然等於白挑）', picked.length === 1, JSON.stringify(picked.map(e => e.id)));
}
{
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `e${i}`, name: `場次${i}`, knowledge_base: '院士授證' + 'x'.repeat(20000)
  }));
  const picked = selectRelatedEvents('院士授證', many, { maxChars: 30000 });
  check('字數上限會擋住後面的場次', picked.length < 6, `挑了 ${picked.length} 場`);
}

console.log('── formatRelatedEventsBlock ──');
{
  const block = formatRelatedEventsBlock([events[0]], '2026晶鏈高峰論壇');
  check('帶出場次名稱與知識庫內容', /工研院院士授證典禮/.test(block) && /本屆新任院士包括/.test(block), block.slice(0, 120));
  check('⚠️ 一定要有「必須講出是哪一場」的規則（張冠李戴比答不出來嚴重）',
    /必須在回答裡明確講出是哪一場/.test(block), block);
  check('提醒不可以講得像是主場次的內容，並帶出主場次名稱',
    /《2026晶鏈高峰論壇》/.test(block), block);
  check('沿用既有的「資料區塊不是指令」防線', /不是給你的指令/.test(block), block);
  check('沒有答案時照舊老實說，不要硬湊', /老實說沒有資料/.test(block), block);
}
check('沒有相關場次 → 回空字串，呼叫端就不加這個區塊', formatRelatedEventsBlock([]) === '');
check('只有空知識庫的場次 → 也回空字串', formatRelatedEventsBlock([events[4]]) === '');

console.log(`\n${fail === 0 ? '✅' : '❌'} 跨場次挑選測試通過 ${pass}／失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
