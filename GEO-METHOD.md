# AI 能見度（GEO）測量方法：怎麼算、依據什麼、被問到怎麼答

> **資料取得日：2026-10-01。** 這個領域 2026 年才開始有準則，IAB 自己也寫明門檻與做法「會隨市場成熟而調整」，
> 建議每季回頭看一次原文有沒有更新（見第八節）。本文件所有引用都已逐一回到原文核對，
> 核對方式與**沒能核對到的部分**寫在最後一節，不藏。

---

## 一、先講結論（給主管的三句話）

1. **沒有 ISO／IEC 等級、專門針對 AI 能見度（GEO）的國際標準**——我在 2026-10-01 查不到。IAB 自己的文件也寫：
   只有 16% 的品牌有系統地追蹤 AI 能見度，原因之一是「沒有共同的測量標準」；
   2026 年 7 月的一篇文獻綜述（預印本）也說這個領域的「術語、指標與證據標準仍然不一致」。
2. **但 2026 年 5 月到 8 月，三個國際業界公會先後發布了測量準則**：AMEC《GEO Principles》（5 月 20 日）、
   PRCA《How to Measure GEO》（6 月）、IAB《Measuring Visibility in the AI Era》（8 月）。它們不是 ISO 那種標準，
   是業界公會的指引，但已經是目前最能援引的依據。**三份都沒有定義一個通用的「能見度分數」**，
   而是定義分項指標與揭露要求；AMEC 還明講不要倚賴任何單一分數。
3. **所以我們的「能見度指數」（提及 45＋位置 20＋引用 20＋內容 15）是自訂的，不是標準**，這一點要主動講。
   做法是：對外引用**分項指標**（提及率、話語權占比、位置、引用率——IAB 有定義，我們照它的定義算，並附區間與分母）；
   能見度指數保留，但標明是自訂綜合指數、只用來看自己的趨勢，並依 IAB 的要求公開權重、依 OECD 手冊的建議做敏感度分析。

---

## 二、可以援引的文件

**先分清楚它們是什麼等級**：下表只有最後兩列是學術／官方方法文獻，前面是業界公會的準則。
**對外引用時請照「性質」欄的說法講，不要說成「國際標準」。**

| 文件 | 發布者 | 日期 | 性質 | 我們拿它引什麼 |
|---|---|---|---|---|
| **[Measuring Visibility in the AI Era](https://www.iab.com/guidelines/measuring-visibility-in-the-ai-era/)** | IAB（Interactive Advertising Bureau） | 2026-08 | 測量指引（自稱 framework／measurement guidelines），屬 IAB 的 Project Eidos；尚無認證制度，只提到「可能的未來認證計畫」 | 指標定義（Mention Rate、Citation Rate、Share of Voice、Position）；Directional／Decision-Grade 兩級；綜合指數的揭露規定；「附上誤差範圍比裸數字誠實」 |
| **[AMEC GEO Principles](https://amecorg.com/wp-content/uploads/2026/05/AMEC-GEO-Principles.pdf)** 與 [實務指南](https://amecorg.com/wp-content/uploads/2026/05/AMEC-Practitioners-Guide-to-GEO-Measurement.pdf) | AMEC（國際傳播測量與評估協會，Barcelona Principles 的發布者） | 2026-05-20（都柏林 Global Summit） | 七項原則、三個證據領域、最低證據標準；實務指南 | 觀察到的 AI 輸出只是「方向性指標」；不要倚賴單一分數；最低證據標準；能見度不等於成效 |
| [How to measure AI-led discovery – applying AMEC's new GEO principles](https://amecorg.com/2026/07/how-to-measure-geo-applying-the-amec-principles/) | AMEC，作者 James Crawford（AMEC 董事、GEO 原則共同主筆） | 2026-07 | 實務文章 | 揭露清單；五種事件要分開（接地／引用／提及／推薦／轉介）；宣稱等級（Observed／Associated／Contributed／Caused） |
| [How to Measure GEO（Beyond Visibility）](https://www.prca.global/how-measure-geo) | PRCA AI Innovation Group（英國公關暨傳播協會） | 2026-06，v1.0 | 實務指南，明講「不取代」AMEC 文件 | 起手七項指標；「AI 能見度是方向性指標」；使用者面的引用次數是虛榮指標 |
| [Barcelona Principles 4.0](https://amecorg.com/2025/07/bp4-0/) | AMEC | 2025-06（2025 AMEC Global Summit 的發布簡報；AMEC 於同年 7 月辦發布說明會） | 公關測量原則；AMEC 稱它是公關與傳播測量業界的基石（cornerstone） | 目標先行；不使用無效指標（如 AVE）；資料、方法與技術要透明 |
| [GEO: Generative Engine Optimization](https://arxiv.org/abs/2311.09735)（Aggarwal 等） | 作者單位含普林斯頓大學與印度理工學院德里分校；KDD 2024（2024 年 8 月，巴塞隆納） | 2024 | **同儕審查論文**（KDD 2024 接受） | 「GEO」與「visibility／impression」一詞的學術出處；位置加權有學術先例 |
| [Optimizing Visibility in Generative Engines: A Critical Survey of GEO (2023–2026)](https://arxiv.org/abs/2607.14035)（Martinez） | Olivier Martinez（Sciences Po） | 2026-07-15 | **arXiv 預印本，單一作者，未經同儕審查** | 「術語、指標與證據標準仍然不一致」；分母要攤開；判官要驗證；以天／題為群集的 bootstrap |
| [Handbook on Constructing Composite Indicators](https://www.oecd.org/content/dam/oecd/en/publications/reports/2008/08/handbook-on-constructing-composite-indicators-methodology-and-user-guide_g1gh9301/9789264043466-en.pdf)（Nardo、Saisana、Saltelli、Tarantola、Hoffmann、Giovannini） | OECD 與歐盟 JRC | 2008，ISBN 978-92-64-04345-9 | OECD 出版的官方方法手冊，主要作者來自歐盟 JRC 與 OECD | 綜合指數的權重是價值判斷；要做不確定性與敏感度分析 |

另外兩個出處不附連結（沒有逐字核對到原文，只當成已確立的指標名稱，不引原句）：
**倒數名次均值（MRR）**出自 Voorhees（1999）〈The TREC-8 Question Answering Track Report〉（NIST）。

**原文裡最好用的幾句**（逐字，已核對）：

- IAB：「The component metrics defined in this framework are the authoritative measurement vocabulary; composite scores are a presentation layer, and the underlying data must always be accessible.」
- AMEC 新聞稿（2026-05）：「They reinforce that AI outputs should be treated as directional evidence rather than absolute truth, and caution against relying on any single score, platform or tool.」
- AMEC GEO Principles 的倫理護欄：「No single score, tool or prompt set can prove total AI visibility or communication impact.」
- AMEC，Crawford（2026-07）：「Visibility is not an outcome. Report it as an observed output, and reserve outcome language for evidence about people and organisations.」
- OECD／JRC（Step 6）：「Regardless of which method is used, weights are essentially value judgements.」

---

## 三、我們每個數字怎麼算、對應哪份文件

這些就是詳細版一頁報告「方法與依據」那一節的內容。**詳細版一頁報告只用這幾項，不放能見度指數**；簡報裡保留一張「能見度指數走勢」（主管習慣看走勢圖），但投影片上直接標明自訂指數、附權重、寫「不是國際標準」。

| 指標 | 公式 | 對應 | 我們的操作化定義（IAB 要求揭露） |
|---|---|---|---|
| 提及率 | 有提到工研院的回答數 ÷ 總回答數 | IAB Mention Rate（「the most fundamental visibility metric」） | 「有提到」由判官（AI）讀回答**正文**判定，只出現在來源清單不算；單位全名與工研院名稱的各種寫法都算（第五節） |
| 話語權占比 | 工研院被點名次數 ÷（工研院＋所有其他機構被點名次數） | IAB Share of Voice | IAB 要求揭露「競爭集合怎麼定、分母怎麼算」：競爭集合＝這批回答裡判官實際點名的機構，**不是事先指定的名單**；每則回答每家機構只計一次；同一家的不同寫法（資策會 MIC、資策會產業情報研究所…）先併成一家 |
| 被提到時排第一 | 被提到的回答中，工研院是第一個被講到的機構的比例 | IAB Position（first entity mentioned） | IAB 說敘述型回答「沒有通用算法，要揭露怎麼定」：由判官依回答正文的出現順序判定，機構、單位、公司都算 |
| 位置（倒數名次均值） | 工研院第 1 個被提到＝1、第 2＝0.5、第 3＝0.33…，沒被提到＝0，再取平均 | IAB Position；MRR（Voorhees 1999） | 判官沒給名次的回答不計入分子，數量另外列出 |
| 自家網域引用率 | 引用來源裡有自家網域的回答數 ÷ 總回答數 | IAB Citation Rate | IAB 的 citation 包含「有連結」與「只寫名字」兩種；**我們只計有連結的來源網域**（itri.org.tw、itritech.itri.org.tw、iek.org.tw），所以會比 IAB 的定義保守 |
| 發稿前後的變化 | 基準期與餘波期／D+31 後的提及率差（百分點） | IAB Visibility Momentum（類似） | IAB 用「百分比變化」，我們刻意用**百分點（pp）**——30%→60% 講成 +100% 太容易被誤讀。引用時要講明這個差異 |

**區間怎麼來的**：以「天」為單位重抽 1,000 次，取 2.5%／97.5% 分位，固定種子（同一份資料每次算出一樣的區間）。
理由是同一天問的是同一批題目，彼此相關，當獨立樣本會嚴重低估誤差（Martinez 2026 §11.3 也建議以日期、題目為群集的 bootstrap）。
**它估的是「這組題目重測的變異」，不代表所有可能的問法**——AMEC 說題庫沒有已知的母體，25／50／100 題只是診斷用樣本，
所以我們不推到全市場。不足 7 天不給區間（畫面會寫「不足 7 天，暫不提供」）。

IAB 的報告建議：「approximately 22%, plus or minus 4 points based on current measurement precision」比裸的「22%」誠實，
所以每個比例都附區間，而且**趨勢優先於單點**。

---

## 四、綜合指數（能見度指數）：自訂的，以及它為什麼還能留著

### 公式

**能見度指數＝提及 45＋位置 20＋自家網域被引用 20＋有具體內容 15（0–100）。**

- 沒被提到＝0 分，其餘三項都不算。
- 位置分：第 1 個被提到 20、第 2 個 14、第 3 個 9、第 4 個以後 5（判官沒給名次也算 5）。
- 自家網域被引用：來源裡有 itri.org.tw、itritech.itri.org.tw、iek.org.tw 任一個。
- 有具體內容：針對工研院給出可查證的技術名稱、數字、年份、案例或合作對象。
- 每一筆回答各算一個分數再取平均；分數由程式依固定規則算，不是模型評分（`lib/geo-metrics.js` 的 `COMPOSITE`，全專案只有這一份）。

位置配分 20／14／9／5 也是我們定的。位置該怎麼加權，連原始 GEO 論文用的指數遞減都只是「假設前面的引用更受注意」，
Martinez（2026）指出這個假設沒有經過使用者研究驗證。

### 準則怎麼看這種東西

| 文件 | 立場 |
|---|---|
| IAB | **可以有，但要揭露**：「any provider offering a composite index」必須公開完整權重、正規化方式、各分項數值、聚合方式的限制；分項指標才是權威詞彙，綜合分數是呈現層 |
| AMEC | 原則的倫理護欄：沒有任何單一分數、工具或題組能證明整體 AI 能見度或傳播成效。Crawford 的文章：「Combining them into a single universal score can hide important distinctions … It can also give a small prompt sample the appearance of market-wide precision.」 |
| PRCA | 沒有單一指標能涵蓋整體能見度；AI 輸出是「方向性指標，不是穩定的分數」 |
| Martinez（預印本） | 純量分數只有在權重對應到明確目標時才站得住腳；把提及、準確引用、轉換混成一個分數，只是把規範性的選擇藏起來（§3.2，大意轉述） |
| OECD／JRC | 權重本質上是價值判斷；要用不確定性與敏感度分析檢查結論的穩健程度 |

### 所以我們這樣處理

1. **公開**（對應 IAB 的揭露規定）：總覽的「這些數字量的是什麼？」卡片攤開權重、說明不另做正規化（配分本身就是 0–100）、分項數值在 KPI 與報告裡。
2. **標明自訂**：KPI、走勢圖、摘要都寫「（自訂）」，並連到上述卡片。
3. **做敏感度分析**（對應 OECD Step 7）：把同一批回答換 5 套替代權重重算——四項等權重、提及為主（70／10／10／10）、加重自家引用（30／15／40／15）、位置改用倒數名次、只看提及率——
   算「每日平均分曲線的走勢相關」與「各議題名次相關」。**不設及格線**：沒有任何標準說相關係數幾以上算穩，硬訂一條線就是又一個自己編的數字。
   讀法：相關高＝「45／20／20／15 是不是剛好最好」不影響結論；某一列明顯偏低＝那部分結論是權重決定的，對外就不能只講綜合指數。
4. **對外不拿它當成績**：詳細版一頁報告與簡報的數字用分項指標；簡報裡那張走勢投影片標明自訂、附權重；能見度指數只用來看自己的趨勢。

### 怎麼改權重（別直接改）

目前 `geo_runs` 存的是**掃描當下算好的 `score`**，圖表讀的也是這一欄。直接改 `COMPOSITE`，新資料用新權重、舊資料維持舊分數，
曲線會在改的那天斷開，而且不會有人發現。IAB 的要求也是模型或方法改變時要**重設基準、前後分開報告**。
要改的話：(1) 改 `COMPOSITE` 與本節的數字（`test/test-geo-method.mjs` 會比對文件與程式，不一致就紅燈）；
(2) 讀取時改成用 `mentioned`／`rank`／`cited`／`specifics` 四欄重算分數（這四欄都有存，歷史可以重算）；
(3) 在 `docs/batches/` 最新那份記下改了什麼、為什麼、哪一天（做法見 CLAUDE.md 第 5 條）。

---

## 五、工研院相關用語追蹤

需求：「工研院追蹤也要追蹤相關用語」。AI 指到工研院的方式不只有名稱，還有一整層是**只寫單位名、完全不出現「工研院」**。
詞表放在 `lib/geo-orgs.js`（改一處，題目防呆、判官提示詞、排行合併、規則比對全部跟上），分三級：

| 級別 | 內容 | 怎麼算 |
|---|---|---|
| **名稱** | 工研院、工業技術研究院、工业技术研究院（簡體）、ITRI、IEK、ISTI、Industrial Technology Research Institute | 出現就算提到 |
| **單位全名** | [工研院官網組織架構頁](https://www.itri.org.tw/ListStyle.aspx?DisplayStyle=20&SiteID=1&MmmID=1344111713711334002)（2026-10-01 核對）上的研發與營運單位：電子與光電系統研究所、資訊與通訊研究所、機械與機電系統研究所、材料與化工研究所、綠能與環境研究所、生醫與醫材研究所、產業科技國際策略發展所、無人化創新科技研究所、量測技術發展中心、服務系統科技中心、智慧感測與系統科技中心；另加「產科國際所」（沒有第二個機構用這個名字）與 IEK 的舊名「產業經濟與趨勢研究中心」 | 出現就算提到 |
| **單位簡稱** | 電光所、資通所、機械所、材化所、綠能所、生醫所、量測中心、服科中心、感測中心；以及名字太通用的產業服務中心、產業學院、南分院、中分院 | **只記錄、不算提到** |

**簡稱為什麼不算**：「成大電光所」「台大機械所」也叫這個名字。把它們算進去，學校的所會被靜靜地灌到工研院頭上。
所以簡稱前面緊貼著學校或其他機構名稱（成大、台大、陽明交大、大學…）時不記錄，單獨出現才記錄，而且**不計入提及**。
判官的提示詞也講了同一條規則。

**簡稱出現本身是有用的訊號**：AI 認得那個單位、卻沒有把它連到工研院（品牌斷鏈）。
報告會單獨數出「只出現單位簡稱、沒有提到工研院」幾次——那是發稿時「單位簡稱前面要掛工研院」的直接證據。
詳細版一頁報告的「AI 怎麼稱呼工研院」列出各用語出現幾次。

**兩套獨立判定**（對應 Martinez §6.4：判官「是被量測的儀器，不是不容質疑的真相」，要保留一個不靠判官的觀察指標）：
「有沒有提到工研院」由判官（AI）與詞表規則（程式比對名稱與單位全名）各判一次，報告印出一致率與不一致的樣本供人工複核。
**分數仍以判官為準**（歷史曲線不能斷）；規則是交叉檢查，不改分數。
規則是在**讀出來時**對回答節錄計算，所以詞表一擴，舊資料也跟著重算，不用搬資料。
限制：存檔只留回答前 500 字（回答上限約 400 字，絕大多數涵蓋全文）。

**要補新單位**（改制、新成立、舊名）：只改 `lib/geo-orgs.js` 的 `BRAND_UNITS`（獨一無二的全名）或 `BRAND_SHORT`（通用或簡稱），
再把 `public/geo.html` 鏡射的 `BRAND_ALIAS_RE` 換成新值（`test/test-review82.mjs` 會比對兩邊逐字相同）。
**不要**把會跟學校重名的簡稱放進 `BRAND_UNITS`。

---

## 六、對照準則：我們做到了哪些、還沒做到哪些

誠實列出落差。**自己先講，比被問倒好。**（✅ 做到　⚠️ 部分　❌ 還沒有）

| 準則要求（出處） | 現況 | 備註／下一步 |
|---|---|---|
| 分項指標採用共同定義（IAB） | ✅ | 第三節 |
| 每個數字附區間、揭露變異（IAB、AMEC「repeat testing with variation disclosed」） | ✅ | 以天為群集的 bootstrap；不足 7 天不給 |
| 同一題重問的變異單獨量測（IAB 決策等級） | ⚠️ | 每月 1 日有 2 輪校準，那天有同日重複樣本，但還沒有把它的變異算出來報告 |
| 分母攤開、不默默丟資料（AMEC、Martinez §6.3／§11.2） | ⚠️ | 報告列出嘗試／有效／不計分。**「引擎沒有真的搜尋」的回答會整筆不計分**——這是刻意的（那是模型憑記憶講的，不是能見度），但 Martinez 認為這類輸出本身就是結果；現在只做到「照實揭露丟了幾筆」 |
| 平台分開回報（IAB） | ⚠️ | 「最近一次掃描」按引擎分開；趨勢曲線與一頁報告是各引擎合併，且沒有依消費者使用量加權 |
| 題庫大小：少於 50 題＝探索性（IAB）；25／50／100 題可當診斷樣本（AMEC） | ❌ | 每個議題通常 4 題。**報告上自稱「探索性」**，不稱「方向性」更不稱「決策等級」。我們把 IAB 的「queries」解讀為不同的題目，不是發問次數——同一題問一百遍不會讓題組變大；若解讀為發問總次數則門檻容易達到，但那不符合「題組要能涵蓋一個類別」的原意 |
| 題目依意圖分段（資訊／比較／推薦／交易）（IAB） | ❌ | 我們的四種問法（找單位、找合作、找解方、找新聞）沒有對到 IAB 的四類 |
| 判官經人工抽樣驗證、回報一致率（Martinez、IAB） | ⚠️ | 有「判官 vs 詞表規則」的一致率與不一致樣本；**沒有**人工抽樣標註 |
| 保存原始回答作為證據（AMEC「saved outputs as evidence」） | ⚠️ | 只存前 500 字節錄 |
| 逐筆記錄引擎與模型版本（AMEC、IAB） | ❌ | 報告揭露的是「目前設定」；`geo_runs` 沒有版本欄位。換過模型的話趨勢要當成不同基準 |
| 模型更新時重設基準、前後分開報告（IAB） | ❌ | 目前沒有這個機制 |
| 品牌題與非品牌題都要做（AMEC 實務指南） | ⚠️ | 我們**刻意只做非品牌題**（點名工研院就是自問自答）；「AI 被直接問到工研院時，講得對不對」沒有量 |
| 情感、框架、幻覺率、事實錯誤率（IAB Portrayal） | ❌ | 報告的「方法揭露」明列為「沒有量測」 |
| 能見度與成效分開、連到行為與成果（AMEC 原則 5、PRCA） | ⚠️ | 報告標「宣稱等級」，不用成效語言；**還沒有**接網站分析（AMEC 的 Crawford 文章提到 GA4 自 2026 年 5 月起有「AI Assistant」管道） |
| 三個證據領域一起看（AMEC：上游聲譽、搜尋與內容可讀性、下游 AI 輸出） | ✅ | 露出報告、發稿檢查清單、本頁（詳見總覽的方法論卡片） |
| 宣稱強度與證據相稱（AMEC 四級） | ✅ | 無前後比較＝「觀察」；有前後比較但無對照組＝最多「相關」，不寫「造成」 |

**措辭已改（批次 102）**：AMEC 與 PRCA 都強調**能見度不是成果（outcome）**，所以原本的「成果績效報告」改為「變化確認報告」
（仍然只有通過 D+31 檢定才用），績效區塊標題「這一場帶來的變化」改為「這一場前後的變化」。報告上另有「宣稱等級」與「能見度不等於成效」兩處聲明。

---

## 七、被問到時怎麼答

**「這個能見度指數是國際標準嗎？」**
不是。目前沒有 ISO 等級的 AI 能見度標準；2026 年有 AMEC、PRCA、IAB 三份業界準則，而且三份都不定義通用分數。
我們對外用的是 IAB 有定義的分項指標（提及率、話語權占比、位置、引用率），能見度指數只用來看自己的趨勢，而且權重公開。

**「為什麼是 45／20／20／15？」**
這是我們自訂的配分，沒有標準規定。邏輯是沒被提到就沒有後面的事，所以「提及」占最大塊；位置、被自家網頁引用、有具體內容是提到之後的加分。
OECD 與歐盟 JRC 的手冊說所有權重本質上都是價值判斷，所以我們不宣稱它「正確」，而是換 5 套合理的權重重算，看走勢與議題名次會不會變
（結果在總覽「這些數字量的是什麼？」裡，隨資料更新）。

**「樣本多大？可以信嗎？」**
看報告的「方法與依據」：有樣本數、天數、題數、每個數字的 95% 區間，還有嘗試了幾次、有幾次不計分。
以目前題庫的規模（每個議題通常 4 題），測量等級是**探索性**（IAB 的門檻是每個測量方案至少 50 題），是方向參考，不是決策等級——這是 IAB 的分級，我們先自己講。實際等級以報告上印的為準。

**「活動之後數字漲了，是活動的功勞嗎？」**
只能說「相關」。我們有發稿前的基準期與發稿後的比較，而且要過 D+31 之後、兩段都通過信賴區間才說基線墊高；
但沒有對照組，不能說是活動「造成」的（AMEC 的宣稱等級：觀察、相關、貢獻、因果）。能見度也不等於對人的成效。

**「判官是 AI，會不會判錯？」**
會，所以不只靠它。分數由程式依固定規則算；「有沒有提到工研院」另有詞表規則獨立判一次，報告印出一致率和不一致的樣本。
目前還沒有做人工抽樣標註，這是列在落差裡的。

**「為什麼不直接買現成的 AI 能見度工具？」**
IAB 的文件指出市面上有 20 家以上的工具，各用不同方法，同一個品牌會得到不同答案，買家沒有依據評估自己買的是什麼（大意轉述）。
買工具不會自動得到標準；我們的做法是方法全部公開、指標照 IAB 定義，缺點是題庫規模小。

**「題目為什麼不能直接問工研院？」**
指名就是自問自答，量到的是 AI 認不認識我們，不是它會不會主動推薦我們。AMEC 的實務指南其實建議品牌題與非品牌題都要做——
我們目前只做非品牌題（這是刻意的，也列在落差裡），「被直接問到時講得對不對」還沒有量。

**「跟我在 ChatGPT／Google AI Overviews 看到的一樣嗎？」**
不一樣。量到的是可用 API 的答案引擎（開啟網路搜尋），不是消費端畫面。IAB 要求不同檢索設定或存取方式的結果不能不揭露就合併，
所以報告會寫引擎與模型版本。這是代理指標：趨勢與相對變化可用，絕對值不可宣稱等同某個產品。

---

## 八、怎麼核對的，以及沒能核對到的部分

**逐字讀過原文**（2026-10-01）：IAB《Measuring Visibility in the AI Era》PDF 全文（36 頁）；AMEC GEO Principles PDF 與 Practitioner's Guide PDF；
AMEC 發布新聞稿與 Crawford 的實務文章；PRCA 指南網頁；Martinez 綜述 PDF 的 §3.2、§4.3、§6、§11；Aggarwal 論文 §2.2.1（位置加權的公式）；
OECD／JRC 手冊 Step 6 與 Step 7 的段落；Barcelona Principles 4.0 的發布簡報（七項原則原文）；工研院官網組織架構頁。

**沒能核對到的**：
- Voorhees（1999）MRR 只透過搜尋結果的摘要確認，沒有讀到原報告，所以只引指標名稱與出處，不引原句。
- Martinez 引用的底層研究（Schulte 等、Kirsten 等 2026 年的審計研究）我沒有個別核對；本文只引用綜述本身說了什麼，並標明它是預印本。
- PRCA 在 prca.org.uk 的鏡像頁因為連線憑證問題讀不到，改用 prca.global 的頁面（內容相同，標示 2026-06-01 發布、v1.0）。
- IAB 的「Provider Disclosure Framework」我們只對照了與我們相關的項目，沒有逐項對照它的整份揭露表。
- 我（寫這份文件的 AI）無法替你判斷這些公會在你們主管心中的份量；AMEC 對公關單位最貼近，IAB 對「測量方法學」最具體。

**建議每季回頭看一次**：IAB 文件寫明「variability thresholds, query volume minimums, and the platform coverage required for decision-grade measurement will continue to evolve」；
AMEC 另有 GEO Hub 持續更新資源。

---

## 九、版本紀錄

- **2026-10-01（批次 102）**：初版。新增分項指標與區間、測量等級、判官與詞表規則的一致率、工研院相關用語三級詞表、綜合指數敏感度分析。
  詳細的改動與原因見 `docs/batches/` 批次 102（索引在 `docs/batches/README.md`）。
