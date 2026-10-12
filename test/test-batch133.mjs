// 批次 133：簡體字防線補「用語」＋漏網偵測（lib/zh-tw.js）。
//
// 背景：toTraditionalTW() 以前只轉「字」，「用繁體字寫出來的大陸用語」（軟件、信息、芯片、人工智能、
// 激光、視頻……）原樣通過；而且出口沒有任何偵測，漏網是無聲的——實測「没有」「强化」「氢能」「矿产」
// 「销售」原樣送了好幾個批次。這支測試分成：
//   一、每個收錄詞（字面預期，不是拿詞表自己對自己）＋簡體輸入走完整路徑
//   二、例外：兩個詞的交界會誤中的句子（電視頻道、演算法、眼光盤算、觸摸屏幕……）
//   三、刻意不收的詞（台灣也在用）一個字都不能動
//   四、專有名詞保護（批次 116 的前科：機構與公司名稱不能被改掉）＋已知取捨
//   五、冪等、由長到短
//   六、log：出口轉了用語記一行、保護住的不算、漏網偵測只記字不記全文
//   七、串流：整篇一次轉 vs 各種切法逐段轉，涵蓋新詞、名稱保護、強制切段
//   八、漏網偵測：命中、不誤報（台灣繁體、兩邊共用字、歧義字刻意保留）、去重、上限、效能
//   九、載入時的健康檢查真的會擋
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 轉換時 lib/zh-tw.js 會印 log（出口轉繁體、轉用語、殘留簡體字）。這支測試轉很多次，先攔下來：
// 一方面不要洗版，一方面第六節要驗證 log 的內容。其他訊息照常印。
const ROOT = path.join(import.meta.dirname, '..');
const realLog = console.log, realWarn = console.warn;
const zhLogs = [], leakWarns = [];
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[zh-tw]')) zhLogs.push(s); else realLog(...a); };
console.warn = (...a) => { const s = a.join(' '); if (s.startsWith('[zh-tw-leak]')) leakWarns.push(s); else realWarn(...a); };

const { toTraditionalTW, createTraditionalStream, findResidualSimplified, TW_TERMS, TW_TERM_KEEP } = await import('../lib/zh-tw.js');
const tw = toTraditionalTW;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else { fail++; realLog(`❌ ${label}${detail !== undefined ? '\n   ' + String(detail).slice(0, 500) : ''}`); }
}
function eq(input, want, why) {
  const got = tw(input);
  check(`${why ? why + '：' : ''}「${input}」→「${want}」`, got === want, `實際：「${got}」`);
}
function section(t) { realLog(`── ${t} ──`); }
// 「把 lib/zh-tw.js 改壞一點再載入」的小工具：第六節（單字表漏了一個字，出口會不會記 leak）與
// 第九節（載入時的健康檢查會不會擋）共用。副本寫在系統暫存資料夾，跑完刪掉；lib/zh-tw.js 沒有 import，可以單獨載入。
const ZHTW_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'zh-tw.js'), 'utf8');
const VARIANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhtw133-'));
process.on('exit', () => { try { fs.rmSync(VARIANT_DIR, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } }); // 中途失敗也要清
let variantSeq = 0;
async function loadVariant(patch) {
  const out = patch(ZHTW_SRC);
  if (out === ZHTW_SRC) return { error: new Error('patch 沒有改到任何東西') };
  const file = path.join(VARIANT_DIR, `v${++variantSeq}.mjs`);
  fs.writeFileSync(file, out);
  try { return { error: null, mod: await import(pathToFileURL(file).href) }; } catch (e) { return { error: e }; }
}
// 從單字表拿掉幾個字，模擬「字表漏了」
const withoutPairs = (chars) => (src) => chars.reduce((s, c) => s.replace(new RegExp(`'${c}.',`), ''), src);
// 轉一次，回傳結果與這一次印出的 log
function run(text) {
  zhLogs.length = 0; leakWarns.length = 0;
  const out = tw(text);
  return { out, logs: [...zhLogs], warns: [...leakWarns] };
}

/* ═══ 一、每個收錄詞 ═══════════════════════════════════════════════════════════ */
section('一、每個收錄詞：繁體寫法的大陸用語 → 台灣用語');
// [輸入, 預期]。預期是我（人）判斷的台灣說法，不是從詞表複製來的。
const CASES = [
  // 資訊／電腦
  ['這套軟件很好用', '這套軟體很好用'], ['硬件規格', '硬體規格'],
  ['信息安全與信息化', '資訊安全與資訊化'],
  ['備份到光盤裡', '備份到光碟裡'], ['換一顆硬盤', '換一顆硬碟'], ['磁盤陣列', '磁碟陣列'], ['插上U盤', '插上隨身碟'],
  ['滑動鼠標', '滑動滑鼠'], ['這台打印機壞了', '這台印表機壞了'], ['3D打印技術', '3D列印技術'],
  ['這台服務器當機', '這台伺服器當機'], ['建立數據庫', '建立資料庫'],
  ['存儲芯片缺貨', '記憶體晶片缺貨'], ['擴充存儲器', '擴充記憶體'], ['提升存儲能力', '提升儲存能力'],
  ['雲存儲服務', '雲端儲存服務'], ['資料存儲在雲端', '資料儲存在雲端'],
  ['壓力傳感器', '壓力感測器'], ['資深程序員', '資深程式設計師'], ['學習編程語言', '學習程式語言'],
  ['優化算法', '優化演算法'], ['發展人工智能', '發展人工智慧'],
  ['一支智能手機', '一支智慧型手機'], ['筆記本電腦', '筆記型電腦'], ['雲計算平台', '雲端運算平台'],
  ['掃描二維碼', '掃描二維條碼'], ['保護知識產權', '保護智慧財產權'],
  ['恢復默認值', '恢復預設值'], ['默認設置不變', '預設設定不變'], ['默認設定', '預設設定'], ['默認情況下關閉', '預設情況下關閉'],
  ['兼容性測試', '相容性測試'], ['與舊版不兼容', '與舊版不相容'], ['向下兼容', '向下相容'], ['向後兼容', '向後相容'],
  ['數碼相機', '數位相機'],
  ['數字化轉型', '數位轉型'], ['推動數字化', '推動數位化'], ['數字轉型', '數位轉型'], ['數字經濟', '數位經濟'],
  ['數字孿生', '數位孿生'], ['數字信號', '數位訊號'], ['數字電路', '數位電路'], ['數字技術', '數位技術'],
  ['數字科技', '數位科技'], ['數字內容', '數位內容'], ['數字貨幣', '數位貨幣'], ['數字產業', '數位產業'],
  ['數字平台', '數位平台'],
  // 網路／通訊
  ['互聯網企業', '網際網路企業'], ['架設局域網', '架設區域網路'], ['以太網交換', '乙太網路交換'], ['升級寬帶', '升級寬頻'],
  ['新建5G基站', '新建5G基地台'], ['移動通信技術', '行動通訊技術'],
  ['神經網絡模型', '神經網路模型'], ['網絡安全法', '網路安全法'], ['無線網絡覆蓋', '無線網路覆蓋'], ['移動網絡', '行動網路'],
  ['社交網絡', '社群網路'], ['網絡攻擊', '網路攻擊'],
  // 半導體／光電／顯示
  ['芯片設計', '晶片設計'], ['集成電路產業', '積體電路產業'], ['系統集成商', '系統整合商'],
  ['功率晶體管', '功率電晶體'], ['發光二極管', '發光二極體'], ['雙極三極管', '雙極三極體'], ['場效應管', '場效電晶體'],
  ['光刻膠', '光阻'],
  ['外延片', '磊晶片'], ['外延生長', '磊晶成長'], ['硅晶圓', '矽晶圓'], ['硅谷', '矽谷'],
  ['激光雷達', '雷射雷達'], ['大屏幕', '大螢幕'], ['觸摸屏', '觸控螢幕'], ['提高分辨率', '提高解析度'],
  ['視頻會議', '視訊會議'], ['視頻通話', '視訊通話'], ['視頻電話', '視訊電話'], ['短視頻', '短影片'],
  ['納米材料', '奈米材料'], ['塑料瓶', '塑膠瓶'],
  // 能源／車／太空
  ['光伏發電', '太陽光電發電'], ['電動汽車', '電動車'],
  ['宇航員', '太空人'], ['航天員', '太空人'],
];
for (const [input, want] of CASES) eq(input, want);
// 詞表每一條都要有字面測試——以後有人在詞表加了詞卻沒補測試，這裡會紅
for (const [from] of TW_TERMS) {
  check(`詞表「${from}」有字面測試`, CASES.some(([input]) => input.includes(from)));
}
check('詞表夠大（沒有被誤刪成一小張）', TW_TERMS.length >= 80, TW_TERMS.length);

section('一之二、簡體輸入：先過字表、再過詞表（兩層疊起來）');
for (const [input, want] of [
  ['软件与硬件', '軟體與硬體'], ['信息技术', '資訊技術'], ['芯片设计', '晶片設計'], ['人工智能', '人工智慧'],
  ['激光雷达', '雷射雷達'], ['视频会议', '視訊會議'], ['短视频', '短影片'], ['默认设置', '預設設定'],
  ['数字化转型', '數位轉型'], ['服务器', '伺服器'], ['数据库', '資料庫'], ['存储芯片', '記憶體晶片'],
  ['传感器', '感測器'], ['集成电路', '積體電路'], ['纳米材料', '奈米材料'], ['光伏发电', '太陽光電發電'],
  ['电动汽车', '電動車'], ['宇航员', '太空人'], ['互联网', '網際網路'], ['神经网络', '神經網路'],
]) eq(input, want, '簡體進、台灣用語出');

section('一之三、字表補漏：以前整批原樣通過的常用字（單字表 + 詞表的歧義字）');
for (const [input, want] of [
  // 單字：舊表沒收的常用字（GB2312 一級）
  ['没有问题', '沒有問題'], ['温度与湿度', '溫度與濕度'], ['黄色的猫', '黃色的貓'], ['强化销售', '強化銷售'],
  ['氢能源与矿产', '氫能源與礦產'], ['烟雾和灾难', '煙霧和災難'], ['写作业', '寫作業'], ['我们的税收', '我們的稅收'],
  ['轴承与钉子', '軸承與釘子'], ['钙铅锡', '鈣鉛錫'], ['纺织与纹路', '紡織與紋路'], ['脚踏车', '腳踏車'],
  ['梦想与档案', '夢想與檔案'], ['横向与竖向', '橫向與豎向'], ['盖子与盐', '蓋子與鹽'], ['猪肉与盗版', '豬肉與盜版'],
  // 單字：二級字（以前連 log 都沒有）
  ['鳄鱼与橄榄', '鱷魚與橄欖'], ['绯闻', '緋聞'], ['钕铁硼磁铁', '釹鐵硼磁鐵'], ['鹦鹉与桦树', '鸚鵡與樺樹'], ['缤纷缭绕', '繽紛繚繞'],
  // 台灣標準字形與 OpenCC 預設不同：手動改正
  ['湿度', '濕度'], ['碱与硷', '鹼與鹼'], ['荧光与萤火虫', '螢光與螢火蟲'], ['账号', '帳號'], ['颚与腭', '顎與顎'],
  // 一對多的歧義字：預設轉多數的那個，例外用詞補
  ['汇率与外汇', '匯率與外匯'], ['汇总与词汇', '彙總與詞彙'], ['外汇总额', '外匯總額'],
  ['心脏与内脏', '心臟與內臟'], ['脏衣服', '髒衣服'], ['动荡与荡漾', '動盪與蕩漾'], ['锻炼与炼油', '鍛鍊與煉油'],
  ['恶心与恶劣', '噁心與惡劣'], ['哗然与喧哗', '譁然與喧嘩'], ['学历与阳历', '學歷與陽曆'], ['多年历经风雨', '多年歷經風雨'],
  ['近20年历史', '近20年歷史'], ['尽管与尽头', '盡管與盡頭'], ['针灸与别针', '針灸與別針'], ['艳丽的坝', '豔麗的壩'],
  // 台灣字集（Big5）也收的字：只在詞裡轉
  ['什么时候', '什麼時候'], ['怎么办', '怎麼辦'], ['那么这么多么', '那麼這麼多麼'],
  ['胜利与获胜', '勝利與獲勝'], ['反复与恢复', '反覆與恢復'], ['复习与复兴', '複習與復興'], ['复杂', '複雜'],
  ['咨询服务', '諮詢服務'], ['香烟与烟草', '香菸與菸草'], ['涌现与汹涌', '湧現與洶湧'], ['特征与象征', '特徵與象徵'],
  ['风云变幻', '風雲變幻'], ['白云与云南', '白雲與雲南'], ['接触与赶快', '接觸與趕快'], ['干扰与困扰', '干擾與困擾'],
  ['看着接着着重', '看著接著著重'], ['怜悯与可怜', '憐憫與可憐'], ['栖息地与肮脏', '棲息地與骯髒'],
]) eq(input, want, '字表補漏');
// 不能被新收的字／詞改壞：台灣字集有收、有自己用途的字
for (const keep of ['祢的名', '叱咤風雲', '叁拾元', '周杰倫', '胜肽', '涌', '人云亦云', '云云', '咨文', '征服', '遠征', '復興', '複雜', '歷史', '曆法', '盡量', '儘管']) {
  eq(keep, keep, '台灣本來就對的寫法不動');
}
check('單字表一口氣轉 1,400 多個新字之後，沒有任何一個「轉出來的字」又被轉一次（連鎖）',
  (() => { let bad = ''; for (let cp = 0x4E00; cp <= 0x9FFF; cp++) { const c = String.fromCodePoint(cp); const o = tw(c); if (tw(o) !== o) bad += c; } return bad === '' || bad; })() === true);
check('整個 CJK 區段：凡是轉得動的字，轉出來的字都不是殘留簡體字（轉換與偵測名單不打架）',
  (() => { let bad = ''; for (let cp = 0x4E00; cp <= 0x9FFF; cp++) { const c = String.fromCodePoint(cp); const o = tw(c); if (o !== c && findResidualSimplified(o).length) bad += c; } return bad === '' || bad; })() === true);
{
  // 偵測名單裡的字，單字表是不是都轉得掉？現在是全部——名單的字全是單字表轉得動的，所以正常情況下
  // 偵測永遠不會響；它響，代表單字表出了事（被誤刪、被改壞）。這一條把這個現況寫下來：
  // 以後若有人只加偵測名單、沒加單字表，這裡會紅，提醒他「這個字會一直警告卻沒人轉」。
  const left = [];
  for (let cp = 0x4E00; cp <= 0x9FFF; cp++) { const c = String.fromCodePoint(cp); if (findResidualSimplified(c).length && tw(c) === c) left.push(c); }
  check('整個 CJK 區段：偵測名單裡的每個字，單字表都轉得動（沒有「只警告、不轉換」的字）', left.length === 0, left.join(''));
}

/* ═══ 二、例外：兩個詞的交界 ═══════════════════════════════════════════════════ */
section('二、例外：兩個詞的交界不能被誤中（每一條 before／after 例外一個句子）');
// 這些句子「本來就是對的」，一個字都不能動
const SAME_GUARD = [
  ['通信息息相關', '信息 after 息：通信｜息息相關'],
  ['陽光盤旋而上', '光盤 before：陽光｜盤旋'], ['態度強硬盤踞要津', '硬盤 before：強硬｜盤踞'],
  ['老鼠標記領地', '鼠標 before：老鼠｜標記'],
  ['攻打印度', '打印 after：攻打｜印度'], ['雙打印象深刻', '打印 after：雙打｜印象'],
  ['提供服務器械租借', '服務器 after：服務｜器械'],
  ['庫存儲備充足', '存儲 before：庫存｜儲備'], ['現存儲量下降', '存儲 before：現存｜儲量'], ['既有存儲能源設備', '存儲 after 能：存｜儲能'],
  ['預算法修正案', '算法 before：預算｜法'], ['計算法則', '算法 before：計算｜法則'], ['演算法的演進', '演算法本身不能變成演演算法'],
  ['雲計算機房', '雲計算 after 機：雲｜計算機房'],
  ['默認值得關注', '默認值 after 得'],
  ['結晶體管理', '晶體管 after 理'], ['液晶體管道', '晶體管 after 道'], ['第二極管理', '二極管 after 理'], ['三極管理', '三極管 after 理'],
  ['互聯網絡連線', '互聯網 after 絡'], ['局域網絡架構', '局域網 after 絡'],
  ['放寬帶來新契機', '寬帶 before：放寬｜帶來'], ['打好根基站穩腳跟', '基站 before：根基｜站穩'],
  ['刺激光敏細胞', '激光 before：刺激｜光敏'],
  ['分辨率先到達的人', '分辨率 after 先'],
  ['電視頻道', '視頻 before：電視｜頻道'], ['無線電視頻率', '視頻 before：電視｜頻率'], ['近視頻繁驗光', '視頻 before：近視｜頻繁'],
  ['接納米蘭球員', '納米 before：接納｜米蘭'], ['雕塑料理', '塑料 before：雕塑｜料理'], ['月光伏案苦讀', '光伏 after：月光｜伏案'],
];
for (const [input, why] of SAME_GUARD) eq(input, input, why);
const MIXED_GUARD = [['觸摸屏幕即可操作', '觸摸螢幕即可操作']];
// 詞表裡每一條帶 before／after 例外的詞，都要有一個「正是這個詞被例外擋下」的句子（程式註解保證過的事）
for (const [from, , guard] of TW_TERMS) {
  if (!guard) continue;
  check(`例外有對應的測試句：「${from}」(${Object.keys(guard).join('／')})`, SAME_GUARD.some(([input]) => input.includes(from) && tw(input) === input) || MIXED_GUARD.some(([input, want]) => input.includes(from) && tw(input) === want));
}
// 例外擋住的是「交界那一個」，同一句裡其他該轉的照轉
for (const [input, want] of MIXED_GUARD) eq(input, want, '觸摸屏 after 幕：不轉成「觸控螢幕幕」，後面的屏幕照轉');
eq('電視頻道播放短視頻', '電視頻道播放短影片', '電視頻道不動、短視頻照轉');
eq('預算法與算法', '預算法與演算法', '預算法不動、獨立的算法照轉');

/* ═══ 三、刻意不收的詞 ═════════════════════════════════════════════════════════ */
section('三、刻意不收的詞（台灣也在用／會誤中）：一個字都不能動');
const NOT_COLLECTED = [
  '這個物體的質量是五公斤', '執行這個程序', '用計算機算一下', '開啟文件', '我們支持這項計畫', '用戶回報問題',
  '智能製造產線', '優化製程', '大數據分析', '數據顯示成長三成', '項目管理', '登錄系統', '運行速度', '通信協定',
  '供應鏈網絡', '人際網絡', '默認接受這個結果', '收集使用者反饋', '調試程式', '兼容並蓄', '國內存在差異',
  '緊固件', '博客來書店', '資源代碼', '交換機制', '明顯卡位', '主板上市', '出租車位', '時光刻畫', '內涵與外延',
  '主流片商', '檢測序列', '短信', '網絡',
  // 台灣的主流媒體或業界「也」這樣寫的詞：光刻機、核電站、機械臂、醫療器械、基因測序
  '極紫外光刻機', '福島核電站', '六軸機械臂', '醫療器械公司', '基因測序技術',
];
for (const s of NOT_COLLECTED) eq(s, s, '台灣也在用，不是大陸專屬用語');

/* ═══ 四、專有名詞保護 ═════════════════════════════════════════════════════════ */
section('四、專有名詞保護：機構與公司名稱裡的詞不轉（批次 116 的前科）');
// 以機構結尾的名稱：整個名稱原封不動
const NAMES = [
  '中國信息通信研究院', '某某信息技術有限公司', '長江存儲科技有限責任公司', '北京智源人工智能研究院',
  '清華大學信息科學技術學院', '中國光伏行業協會', '中芯國際集成電路製造有限公司', '國家集成電路產業投資基金股份有限公司',
  '南京信息工程大學', '北京郵電大學信息與通信工程學院', '大族激光科技產業集團股份有限公司', '中國電子信息產業發展研究院',
  '中國互聯網絡信息中心', '華為雲計算技術有限公司', '上海硅產業集團股份有限公司', '杭州海康威視數字技術股份有限公司',
  '中國人工智能學會', '中科院信息工程研究所', '國家信息中心', '清華大學人工智能研究院',
];
for (const n of NAMES) eq(n, n, '機構名稱不動');
// 沒有結尾可看的知名簡稱：白名單
for (const k of TW_TERM_KEEP) eq(`${k}今年擴產`, `${k}今年擴產`, '知名簡稱不動');
eq('長江存儲與長鑫存儲的差距', '長江存儲與長鑫存儲的差距', '兩個簡稱同一句');
eq('納米比亞與納米技術', '納米比亞與奈米技術', '國名不動、納米技術照轉');
eq('數碼港的數碼相機', '數碼港的數位相機', '香港 Cyberport 不動、數碼相機照轉');
eq('大族激光與浪潮信息宣布合作', '大族激光與浪潮信息宣布合作', '簡稱不動');
// 簡體輸入：字照轉、名稱裡的詞不動
eq('中国信息通信研究院发布报告', '中國信息通信研究院發布報告', '簡體輸入：字轉了、名稱裡的「信息」留著');
eq('长江存储科技有限责任公司', '長江存儲科技有限責任公司', '簡體輸入：公司名');
eq('大族激光与浪潮信息', '大族激光與浪潮信息', '簡體輸入：簡稱');
eq('北京大学信息科学技术学院', '北京大學信息科學技術學院', '簡體輸入：學院');
// 同一句裡名稱不動、一般用語照轉
eq('中國信息通信研究院指出，芯片與軟件產業成長', '中國信息通信研究院指出，晶片與軟體產業成長', '名稱後面的詞照轉');
eq('某某信息技術有限公司的軟件與芯片', '某某信息技術有限公司的軟體與晶片', '同一小句：公司名不動、「的」之後的詞照轉');
eq('長江存儲是存儲芯片廠', '長江存儲是記憶體晶片廠', '簡稱不動、同一句的存儲芯片照轉');
// 一般句子：剛好有機構結尾也要看是不是真的名稱——隔了句子的骨架（的、把、給…）就不算
eq('我們把信息整理後交給研究院', '我們把資訊整理後交給研究院', '中間隔著句子的骨架，不是名稱');
eq('這顆芯片的研究院成果', '這顆晶片的研究院成果', '「的」把詞和結尾隔開');
eq('一家芯片公司', '一家晶片公司', '公司兩個字緊接著：一般用法，照轉');
eq('這間軟件公司', '這間軟體公司', '同上');
// ── 已知取捨（寫成測試是為了讓行為明確；改了它要有意識地改這裡）──
eq('一家芯片設計公司', '一家芯片設計公司', '⚠️ 已知取捨：詞和「公司」隔兩個字以上就當成名稱（誤保護，寧可漏轉）');
eq('中芯國際集成電路製造（上海）有限公司', '中芯國際積體電路製造（上海）有限公司', '⚠️ 已知限制：名稱被括號切成兩小句，結尾看不到，會被改');
eq('《人工智能標準化白皮書》', '《人工智慧標準化白皮書》', '⚠️ 已知限制：書名號內的標題沒有機構結尾，會被改');

/* ═══ 五、冪等、由長到短 ═══════════════════════════════════════════════════════ */
section('五、冪等：轉兩次跟轉一次一樣；由長到短：長詞不被短詞先吃掉');
const IDEM_SAMPLES = [
  ...CASES.map((c) => c[0]), ...SAME_GUARD.map((c) => c[0]), ...NOT_COLLECTED, ...NAMES,
  '软件与信息，芯片和人工智能；激光视频，默认设置', '计算机与信息工程学院的数字化转型',
  '长江存储与存储器、存储芯片、云存储', '电视频道和视频会议、短视频', '这是一个演算法，也是一个算法',
  '内容仅供参考，以工研院官网新闻稿或发言为准。', '会后将于官网公布，请勿转发', '中科后里园区的产线与阿里山',
];
for (const s of IDEM_SAMPLES) {
  const once = tw(s);
  check(`冪等：「${s.slice(0, 20)}」`, tw(once) === once, `${once} → ${tw(once)}`);
}
for (const [from, to] of TW_TERMS) {
  check(`詞表右邊再轉一次不變：${from}→${to}`, tw(to) === to, tw(to));
}
eq('存儲芯片', '記憶體晶片', '由長到短：存儲芯片不是「儲存晶片」');
eq('視頻會議', '視訊會議', '由長到短：視頻會議不是「影片會議」');
eq('數字化轉型', '數位轉型', '由長到短：不是「數位化轉型」');
eq('打印機', '印表機', '由長到短：不是「列印機」');
eq('集成電路', '積體電路', '由長到短：長詞整個轉');
eq('存儲能力', '儲存能力', '由長到短：不被 after 例外擋成「存儲能力」');
eq('向下兼容', '向下相容', '由長到短');

/* ═══ 六、log ═════════════════════════════════════════════════════════════════ */
section('六、log：轉了用語記一行；保護住的、沒換的不算；漏網偵測只記字');
{
  let r = run('軟件、硬件、軟件');
  check('只轉用語時只有一行「出口轉用語」', r.logs.length === 1 && r.logs[0] === '[zh-tw] 出口轉用語：換掉 3 個詞', JSON.stringify(r.logs));
  r = run('软件与芯片');
  check('簡體字與用語各記一行，格式跟「出口轉繁體」同一風格',
    r.logs.includes('[zh-tw] 出口轉繁體：換掉 2 個簡體字') && r.logs.includes('[zh-tw] 出口轉用語：換掉 2 個詞'), JSON.stringify(r.logs));
  r = run('中國信息通信研究院');
  check('被名稱保護住的不算「換掉」，也不記 log', r.logs.length === 0, JSON.stringify(r.logs));
  r = run('長江存儲');
  check('白名單保留的不算', r.logs.length === 0, JSON.stringify(r.logs));
  r = run('電視頻道');
  check('被例外擋下的不算', r.logs.length === 0, JSON.stringify(r.logs));
  r = run('台灣的科技產業很蓬勃');
  check('沒有轉任何東西 → 完全不記 log', r.logs.length === 0 && r.warns.length === 0, JSON.stringify(r));
  r = run('一家芯片公司，與中國信息通信研究院');
  check('一句裡有轉有不轉：只算轉了的', r.logs.length === 1 && r.logs[0] === '[zh-tw] 出口轉用語：換掉 1 個詞', JSON.stringify(r.logs));
  r = run('這是繁體，没有簡體殘留');
  check('「没」現在會轉（以前原樣通過）', r.out === '這是繁體，沒有簡體殘留' && r.warns.length === 0, JSON.stringify(r));
}
{
  // 漏網偵測的 log：只記字，不記全文。現在常用的簡體字都轉得掉，要看到 leak 得「讓字表漏一個字」——
  // 這正是這個偵測存在的理由：字表被誤刪或漏收時，出口不再無聲。
  const sentence = '機密：下個月發表的新型钕铁硼磁鐵配方，由某某公司獨家供應';
  check('（對照組）字表沒漏時：钕铁硼轉得掉、不記 leak', (() => { const r = run(sentence); return r.out.includes('釹鐵硼') && r.warns.length === 0; })());
  const v = await loadVariant(withoutPairs(['钕']));
  check('（準備）變體載入成功', !v.error && typeof v.mod?.toTraditionalTW === 'function', v.error?.message);
  zhLogs.length = 0; leakWarns.length = 0;
  const out = v.mod.toTraditionalTW(sentence);
  const warns = [...leakWarns];
  check('字表漏了「钕」→ 出口記一行 [zh-tw-leak]，格式「殘留簡體字：字」', warns.length === 1 && warns[0] === '[zh-tw-leak] 殘留簡體字：钕', JSON.stringify(warns));
  check('⚠️ log 不含全文（只有字，沒有任何一段原文）',
    !warns[0].includes('機密') && !warns[0].includes('磁鐵') && !warns[0].includes('配方') && warns[0].length < 40, warns[0]);
  check('殘留的字照樣原樣送出（偵測只記錄、不改內容）', out.includes('钕') && out.includes('鐵硼'), out);
  const rare = ['钕', '钐', '铽', '镝', '钇', '钆', '铕', '铥', '镥', '镱', '钬', '铒', '钪', '钌', '铑'];
  const v2 = await loadVariant(withoutPairs(rare));
  zhLogs.length = 0; leakWarns.length = 0;
  v2.mod.toTraditionalTW(rare.join(''));
  check('殘留很多時最多記 10 個', leakWarns.length === 1 && leakWarns[0].replace('[zh-tw-leak] 殘留簡體字：', '').split('、').length === 10, leakWarns[0]);
  zhLogs.length = 0; leakWarns.length = 0;
  v2.mod.toTraditionalTW('钕钕钕，钕钐钐');
  check('同一個字重複出現只記一次', leakWarns.length === 1 && leakWarns[0] === '[zh-tw-leak] 殘留簡體字：钕、钐', JSON.stringify(leakWarns));
  // 串流版：每一段轉的時候同樣會記
  zhLogs.length = 0; leakWarns.length = 0;
  const s = v.mod.createTraditionalStream();
  s.push('新型钕铁硼，'); s.flush();
  check('串流出口同樣會記 leak', leakWarns.some((w) => w.includes('钕')), JSON.stringify(leakWarns));
}

/* ═══ 七、串流 ════════════════════════════════════════════════════════════════ */
section('七、串流：整篇一次轉 vs 各種切法逐段轉，涵蓋新詞、名稱保護、例外');
function streamed(text, sizes) {
  const s = createTraditionalStream();
  let out = '', i = 0, k = 0;
  const chars = [...text];
  while (i < chars.length) { const n = sizes[k++ % sizes.length]; out += s.push(chars.slice(i, i + n).join('')); i += n; }
  return out + s.flush();
}
const STREAM_SAMPLES = [
  '芯片、软件与信息；集成电路和人工智能。激光视频，默认值与数字化转型。',
  '中国信息通信研究院指出，某某信息技术有限公司的芯片设计；纳米比亚与纳米材料；长江存储与存储器。',
  '电视频道与视频会议，演算法与算法，眼光盘算与光盘，攻打印度与打印机。',
  '通信息息相关。库存储备与存储能力，现存储量；预算法与算法。观触摸屏幕与触摸屏。',
  '没有问题，温度很高；强化销售，氢能源与矿产。什么时候，怎么办，这么做。',
  'The 5G 基站 and 芯片 are ready. 工研院表示，国产化比例达 85%，光伏发电与电动汽车同步成长。',
];
for (const t of STREAM_SAMPLES) {
  const whole = tw(t);
  for (const sizes of [[1], [2], [2, 3], [5, 1, 7], [4], [1000]]) {
    const got = streamed(t, sizes);
    check(`分段 ${JSON.stringify(sizes)}：「${t.slice(0, 12)}…」`, got === whole, `${got} ≠ ${whole}`);
  }
}
{
  // 一長串沒有標點：強制切段。詞躺在切點前後每一個位置都要跟整篇轉一樣
  const FILL_A = '甲', FILL_B = '乙';
  const probes = ['集成电路', '演算法', '中国信息通信研究院', '存储芯片', '数字化转型', '光刻胶', '电视频道', '纳米比亚', '长江存储', '库存储备', '触摸屏幕', '某某信息技术有限公司'];
  const bad = [];
  for (const probe of probes) {
    for (let n = 40; n <= 100; n++) {
      const text = FILL_A.repeat(n) + probe + FILL_B.repeat(60);
      const whole = tw(text);
      for (const size of [1, 3, 7, 16]) {
        const got = streamed(text, [size]);
        if (got !== whole) bad.push(`${probe}@${n}/${size}`);
      }
    }
  }
  check(`強制切段（沒有標點）：${probes.length} 個詞 × 61 個位置 × 4 種切法，全部跟整篇一次轉相同`, bad.length === 0, bad.slice(0, 8).join('、'));
  const s = createTraditionalStream();
  const first = s.push('这'.repeat(100));
  check('一長串沒有標點的字：不會一直囤著不送', first.length > 0 && !/这/.test(first));
  check('強制切段留得下最長的詞（留尾 ≥ 最長詞長）', first.length <= 100 - Math.max(...TW_TERMS.map((t) => t[0].length)), first.length);
  // 詞密集、一直找不到安全切點時，最後還是要送出去
  const dense = '芯片'.repeat(150);
  const s2 = createTraditionalStream();
  const got2 = s2.push(dense);
  check('詞密集到找不到安全切點：等到上限還是會硬切送出（畫面不能一直停住）', got2.length > 0, got2.length);
  check('硬切之後整篇內容沒有遺失或重複', got2 + s2.flush() === tw(dense), got2.length);
}
{
  const s = createTraditionalStream();
  const parts = [s.push('我們的集成'), s.push('電路與人工'), s.push('智能，'), s.push('完全沒有'), s.push('標點的結尾'), s.flush()];
  check('逐段餵、詞被切在兩段中間：結果等於整篇', parts.join('') === tw('我們的集成電路與人工智能，完全沒有標點的結尾'), parts.join('|'));
  check('標點前不送出（詞可能還沒到齊）', parts[0] === '' && parts[1] === '', JSON.stringify(parts));
}

/* ═══ 八、漏網偵測 ════════════════════════════════════════════════════════════ */
section('八、漏網偵測：命中、不誤報、去重、上限、效能');
{
  check('找得到殘留的簡體專用字', findResidualSimplified('钕铁硼').join('') === '钕铁', findResidualSimplified('钕铁硼').join(''));
  check('依出現順序、去重', findResidualSimplified('钆钇钆钇钆').join('') === '钆钇', findResidualSimplified('钆钇钆钇钆').join(''));
  check('最多 10 個', findResidualSimplified('钕钐铽镝钇钆铕铥镥镱钬铒钪钌铑').length === 10);
  check('傳字串以外的東西不噴例外', findResidualSimplified(null).length === 0 && findResidualSimplified(undefined).length === 0 && findResidualSimplified(123).length === 0);
  check('空字串、純英文、純數字、網址 → 空', ['', 'For reference only.', '2026-10-12 85%', 'https://www.itri.org.tw/ListStyle.aspx?MGID=1'].every((s) => findResidualSimplified(s).length === 0));
  check('「发」永遠要轉（發／髮），轉完還在就是漏網 → 在名單裡', findResidualSimplified('发').join('') === '发');
  check('單字表的字（网）轉完不該還在 → 也在名單裡，當第二道網', findResidualSimplified('网').join('') === '网');
}
{
  // ⚠️ 不誤報：台灣繁體裡正常出現的字、兩邊共用的字、歧義字，一個都不能列
  const TRAD = [
    '的了在內為台里后准干於余云系制筑松划冲范采斗柜伙板表才面回只',
    '台灣的科技產業很蓬勃，臺北市政府宣布公里、里程碑與鄰里關係，批准、不準、准許',
    '皇后、太后、影后、頭髮、髮型、余先生、于小姐、范先生、風采、一面之緣、三隻小豬',
    '中科后里園區在台中市后里區，阿里山與阿里巴巴、密蘇里州、克里斯、筑波大學',
    '乾淨、乾燥、幹部、骨幹、樹幹，曆法與歷史，鬆綁與輕鬆，劃分與計劃，衝突與衝擊',
    '周杰倫與胜肽，么麼小丑，复姓，涌泉相報，咨文與占卜，征服與遠征',
    '工研院今天發表四足機器人，採用先進的半導體製程與人工智慧技術。內容僅供參考，以工研院官網新聞稿或發言為準。',
  ];
  for (const s of TRAD) check(`台灣繁體不誤報：「${s.slice(0, 16)}…」`, findResidualSimplified(s).length === 0, findResidualSimplified(s).join(''));
  // 歧義字「刻意保留不轉」的情形：繁體句子裡的后／里／准，轉換後既不會被改、也不會被偵測喊漏網
  for (const s of ['中科后里園區', '阿里山的日出', '金馬影后', '批准與核准', '本次活動在中科后里園區舉行']) {
    const r = run(s);
    check(`歧義字刻意保留：「${s}」不改、不警告`, r.out === s && r.warns.length === 0, JSON.stringify(r));
  }
  // 兩邊共用的字，一個字一個字查
  const SHARED = [...'的了在內為台里后准干于余云系制筑松划冲范采斗柜伙板表才面回只著么胜复涌杰峰咨占征托布吊泛污秘升局克奸尸幸佣冢涂游注周昆雕卷舍杆朱弦扎扣家吃几栖酸困念祢咤叁'];
  const hit = SHARED.filter((ch) => findResidualSimplified(ch).length);
  check(`${SHARED.length} 個兩邊共用／有歧義的字，沒有任何一個在名單裡`, hit.length === 0, hit.join(''));
  // 轉換後的結果：單字表會轉的字都不該殘留
  const SIMP = '没有问题温度很高黄色的猫强化销售氢能源与矿产烟雾灾难写作业税收这个国家们会议对话图书馆软件数据库网络电脑';
  const r = run(SIMP);
  check('一段常見簡體文字轉完後沒有殘留（也沒有 leak 警告）', findResidualSimplified(r.out).length === 0 && r.warns.length === 0, `${r.out} / ${r.warns}`);
  // 真實的繁體文字語料：使用者看得到的網頁（geo.html、training.html 的簡體字是比對用的正規表示式，不是顯示的內容）
  const skip = new Set(['geo.html', 'training.html']);
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html') && !skip.has(f));
  let total = 0; const dirty = [];
  for (const f of pages) {
    const text = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    total += text.length;
    const got = findResidualSimplified(text);
    if (got.length) dirty.push(`${f}:${got.join('')}`);
  }
  check(`真實語料：public/*.html 共 ${pages.length} 頁、${total} 字，沒有任何誤報`, pages.length > 3 && dirty.length === 0, dirty.join('、'));
}
{
  // 效能：O(n)
  const big = '工研院今天發表半導體製程與人工智慧技術。'.repeat(100_000); // 約 200 萬字
  let t0 = process.hrtime.bigint();
  const a = findResidualSimplified(big);
  const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
  const small = big.slice(0, big.length / 10);
  t0 = process.hrtime.bigint();
  findResidualSimplified(small);
  const ms2 = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`效能：約 ${(big.length / 1e6).toFixed(1)}M 字掃一遍 < 2 秒（${ms1.toFixed(0)}ms），而且大約是線性的（長 10 倍、時間不到 60 倍）`, a.length === 0 && ms1 < 2000 && ms1 < Math.max(ms2, 10) * 60, `${ms1}ms / ${ms2}ms`);
}

/* ═══ 九、載入時的健康檢查 ═════════════════════════════════════════════════════ */
section('九、載入時的健康檢查：詞表或名單壞了，整支載入就丟例外（不讓錯誤安靜地上線）');
{
  const ANCHOR = "  ['軟件', '軟體'], ['硬件', '硬體'],";
  check('（對照組）沒改壞的原始碼載得進來', !(await loadVariant((s) => s + '\n// noop')).error);
  let r = await loadVariant((s) => s.replace(ANCHOR, ANCHOR + "\n  ['軟件', '軟體'],"));
  check('詞表左邊重複 → 載入失敗', /重複/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace(ANCHOR, ANCHOR + "\n  ['光碟機', '光碟機'],"));
  check('詞表左右一樣（沒有轉換）→ 載入失敗', /沒有轉換/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace(ANCHOR, ANCHOR + "\n  ['軟件包', '軟件箱'],"));
  check('詞表右邊還含別條的左邊（轉兩次會不一樣）→ 載入失敗', /不冪等/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace(ANCHOR, ANCHOR + "\n  ['软件包', '軟體包'],"));
  check('詞表左邊含簡體字（永遠比對不到）→ 載入失敗', /含簡體字/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace("const RESIDUAL_SIMPLIFIED_SRC =\n", "const RESIDUAL_SIMPLIFIED_SRC =\n  '台' +\n"));
  check('漏網名單誤收「台」（兩邊共用的字）→ 載入失敗', /兩邊共用/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace("const RESIDUAL_SIMPLIFIED_SRC =\n", "const RESIDUAL_SIMPLIFIED_SRC =\n  '體' +\n"));
  check('漏網名單誤收繁體字（體）→ 載入失敗', /兩邊共用|繁體字/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace("  '并並','将將',", "  '體体','并並','将將',"));
  check('單字表連鎖轉換（體→体、体→體）→ 載入失敗', /連鎖/.test(r.error?.message || ''), r.error?.message);
  r = await loadVariant((s) => s.replace("  ['什么', '什麼'],", "  ['测试词', '測試词'], ['什么', '什麼'],"));
  check('S2T_WORDS 右邊留了簡體字（轉兩次不一樣）→ 載入失敗', /S2T_WORDS 右邊/.test(r.error?.message || ''), r.error?.message);
}

console.log = realLog; console.warn = realWarn;
console.log(`\n${fail === 0 ? '✅' : '❌'} 批次 133 測試：${pass} 通過，${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
