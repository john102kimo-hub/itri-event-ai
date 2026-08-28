// 純函式測試：媒體訓練的分數持久化——認證規則、分數清洗、平均值計算。
// 不碰網路、不碰 Sheets——`node test/training.test.mjs` 直接跑。
//
// 這份檔案存在的理由：api/training.js 原本完全不落地任何資料，`/report` 成效報告
// 永遠算不出「演練場次／平均分」。這裡的 parseValidScores 曾經有一個真的會把分數
// 算錯的 bug（`Number(null)` 和 `Number('')` 都是 `0`，不是 `NaN`——一題沒評出分數
// 的會被悄悄記成「拿了 0 分」，把整場平均硬拖下去，且沒有任何錯誤訊息）；這份測試
// 就是在寫的當下抓到那個 bug 的，故意留著，不要讓它有機會回歸。
import { authorizeTraining, avgOf, parseValidScores } from '../api/training.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

process.env.ADMIN_PASSWORD = 'test-admin-pwd';

console.log('[1] parseValidScores — 分數清洗（含「未評分」的正確處理）');
{
  ok(JSON.stringify(parseValidScores([8, 7, '9', -1, 11, 'x'])) === '[8,7,9]',
    '陣列輸入：丟掉負數／超過10／非數字，字串數字照收');
  ok(JSON.stringify(parseValidScores([8, null, 9, undefined, 7])) === '[8,9,7]',
    '陣列裡的 null／undefined（該題沒評出分數）整個跳過，不會變成 0 分');
  ok(JSON.stringify(parseValidScores('8|7|9')) === '[8,7,9]', 'pipe 字串輸入（Sheets 存的格式）');
  ok(JSON.stringify(parseValidScores('8||9|6|8')) === '[8,9,6,8]',
    'pipe 字串中間的空段（某題沒分數）不會被當成 0 分');
  ok(JSON.stringify(parseValidScores('')) === '[]', '空字串 → 空陣列');
  ok(JSON.stringify(parseValidScores([null, null, undefined])) === '[]', '整場都沒評出分數 → 空陣列');
  ok(JSON.stringify(parseValidScores(null)) === '[]', 'null 輸入不炸掉');
  ok(JSON.stringify(parseValidScores([0, 10])) === '[0,10]', '邊界值 0 與 10 都算合法分數');
}

console.log('\n[2] avgOf — 平均值');
{
  ok(avgOf([8, 7, 9]) === 8, '整數平均');
  ok(avgOf([8, 7]) === 7.5, '有小數的平均');
  ok(avgOf([8, 7, 7]) === 7.3, '四捨五入到一位小數');
  ok(avgOf([]) === null, '空陣列 → null（不是 0——0 會被誤讀成「拿了最低分」）');
}

console.log('\n[3] authorizeTraining — 認證規則（reporter／evaluate／log_session 共用同一份）');
{
  const active = { name: '測試活動', status: 'active', edit_code: 'ABC123' };
  const archived = { name: '舊活動', status: 'archived', edit_code: 'X' };

  ok(authorizeTraining('all', null, '', 'test-admin-pwd').ok, '彙整訓練：對的 admin 密碼放行');
  ok(!authorizeTraining('all', null, '', 'wrong').ok, '彙整訓練：錯密碼擋下');
  ok(!authorizeTraining('all', null, 'ABC123', '').ok, '彙整訓練：edit_code 無效，只認 admin（沒有單一場次可比對）');

  ok(authorizeTraining('ev1', active, 'ABC123', '').ok, '單場：對的 edit_code 放行');
  ok(!authorizeTraining('ev1', active, 'WRONG', '').ok, '單場：錯的 edit_code 擋下');
  ok(authorizeTraining('ev1', active, '', 'test-admin-pwd').ok, '單場：admin 密碼也放行，不用知道 edit_code');
  const missing = authorizeTraining('ev1', null, 'ABC123', '');
  ok(!missing.ok && missing.status === 404, '單場：活動不存在 → 404');
  const arch = authorizeTraining('ev2', archived, 'X', '');
  ok(!arch.ok && arch.status === 403, '單場：已封存的活動擋下 → 403（edit_code 對也一樣擋）');

  ok(!authorizeTraining('', null, '', '').ok, '沒選活動、非 admin 擋下');
  ok(authorizeTraining('', null, '', 'test-admin-pwd').ok, '沒選活動但是 admin，放行（給彙整訓練的選擇畫面用）');
}

console.log(fails === 0 ? '\n全部通過 ✅' : `\n失敗 ${fails} 項 ❌`);
process.exit(fails === 0 ? 0 : 1);
