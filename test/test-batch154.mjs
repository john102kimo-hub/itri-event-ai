// 批次 154：/admin 側邊欄的「業發處（合作洽詢）」入口。
//   一、電腦版側邊欄與手機「更多」都有入口，同一分頁開 /b2b（不開新分頁：管理員密碼放在這個分頁的 sessionStorage）
//   二、/admin 與 /b2b 讀寫的是同一個 sessionStorage 鍵，所以不用重新登入
//   三、「回活動後台」只給用管理員密碼進來的；業務窗口用個人連結進來看不到公關後台的入口
//   四、沒有新增 Function／排程／rewrite（/b2b 本來就有）
// 瀏覽器端實際點過（Chromium，電腦與手機尺寸），見 docs/batches 批次 154。
import fs from 'node:fs';
import path from 'node:path';
let pass = 0, fail = 0;
const check = (l, c, d) => { c ? (pass++, console.log('✅ ' + l)) : (fail++, console.log('❌ ' + l + (d ? '\n   ' + String(d).slice(0, 400) : ''))); };
const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const idx = read('public/index.html');
const b2b = read('public/b2b.html');

console.log('\n── 一、入口 ──');
{
  const side = (idx.match(/<a class="nav-item nav-secondary" href="\/b2b"[^>]*>[\s\S]*?<\/a>/) || [''])[0];
  check('電腦版側邊欄：有「企業洽案管理」（批次 157 由「業發處（合作洽詢）」改名），連到 /b2b', /企業洽案管理/.test(side) && /ti-briefcase/.test(side), side);
  check('★ 同一分頁開（沒有 target=_blank）：管理員密碼在這個分頁的 sessionStorage，開新分頁就要重新登入', !/target=/.test(side));
  check('手機「更多」選單也有，同一分頁開 /b2b', /label: '企業洽案管理', run: \(\) => \{ location\.href = '\/b2b'; \}/.test(idx));
  check('電腦版入口是次要項目（nav-secondary）：手機底部選單不被塞滿，改放在「更多」', /class="nav-item nav-secondary" href="\/b2b"/.test(idx));
}

console.log('\n── 二、不用重新登入 ──');
{
  check('★ /admin 把密碼存在 sessionStorage 的 itri_pwd', /sessionStorage\.setItem\('itri_pwd'/.test(idx));
  check('★ /b2b 讀同一個鍵（sessionStorage 的 itri_pwd），帶成 X-Admin-Password', /headers\(\)[\s\S]{0,300}X-Admin-Password'\] = store\.get\('itri_pwd'\)/.test(b2b) && /const area = \(k\) => \(k === KEY \? localStorage : sessionStorage\)/.test(b2b));
  check('　 /b2b 有密碼就直接進，不先跳登入畫面', /if \(!store\.get\('itri_b2b_key'\) && !store\.get\('itri_pwd'\)\) return showLogin\(''\)/.test(b2b));
}

console.log('\n── 三、「回活動後台」 ──');
{
  check('/b2b 標頭有「活動後台」連結，預設藏起來', /<a id="to-admin" href="\/admin" hidden>活動後台<\/a>/.test(b2b));
  check('★ 只有「用管理員密碼進來、沒有個人連結」才顯示；業務窗口（有個人連結）看不到公關後台的入口', /\$\('to-admin'\)\.hidden = !!store\.get\('itri_b2b_key'\) \|\| !store\.get\('itri_pwd'\)/.test(b2b));
  check('　 這個連結只是導航：公關後台自己還是要管理員密碼（業務窗口點了也進不去）', /requireAdmin|ADMIN_PASSWORD/.test(read('lib/auth.js')) && /X-Admin-Password/.test(idx));
}

console.log('\n── 四、結構 ──');
{
  const vercel = JSON.parse(read('vercel.json'));
  const fns = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  check('★ api/ 仍是 11 支；排程仍是 10 個（批次 177、178 多了 cron_remind 三班）；rewrites 仍是 17 條（/b2b 批次 119 就有了）', fns.length === 11 && vercel.crons.length === 10 && vercel.rewrites.length === 17);
  check('/b2b 的安全標頭（不可被嵌入）本來就有', /b2b\|inquiry/.test(read('vercel.json')));
}

console.log(`\n${fail ? '❌' : '✅'} 批次 154 測試：${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
