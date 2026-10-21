// 成效報告「互動簡報」（批次 155）。風格取自朱朱上傳的米亞互動簡報；樣式在 report-deck.css。
//
// 原則（朱朱：「數據成效還是要清楚明瞭，不要單純動畫好看」）——寫在程式裡，不是只寫在口頭：
//   ① 每一頁的標題直接寫結論（含數字），由 buildModel() 組好，測試逐句驗。
//   ② 數字一律是 HTML 裡的靜態文字；動畫只是「從 0 跳到那個數字」，結束時一定停在同一個字串（沒跑完、關掉動畫、列印都一樣）。
//   ③ 每張圖都標數值與單位；④ 每頁底下寫「口徑」——怎麼算的、哪些不算。
// 資料與算法跟 /report 原本的報告同一套（排除企業場、媒體家數去重、節省工時＝題數×每題分鐘÷60），這支只是換一種呈現。
// 簡報完全由現有資料產生，沒有任何寫死的成效數字。
(function (root) {
  'use strict';

  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var fmt = function (n, dec) { n = Number(n) || 0; return n.toLocaleString('zh-TW', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 }); };
  var sum = function (a) { return a.reduce(function (n, x) { return n + (Number(x) || 0); }, 0); };
  var MIN_LO = 1, MIN_HI = 30;
  function clampMin(m) { m = parseInt(m, 10); return isNaN(m) ? 3 : Math.min(MIN_HI, Math.max(MIN_LO, m)); }
  // 跟 /report 原本一樣：滿 10 小時取整數，不到 10 小時留一位小數
  function hoursStr(h) { return h >= 10 ? String(Math.round(h)) : h.toFixed(1); }
  // 標題裡的場名太長會把版面擠壞：截短放標題，完整名稱留在表格與側欄
  function shortName(n, max) { n = String(n || ''); return n.length > max ? n.slice(0, max) + '…' : n; }
  // 並列第一名要照實寫成並列，不能硬分出「其次」
  function topicsTitle(t) {
    var top = t.filter(function (x) { return x.c === t[0].c; });
    if (top.length > 1) {
      var more = top.length > 3 ? '等 ' + top.length + ' 個主題' : top.map(function (x) { return '「' + x.w + '」'; }).join('');
      var rest = t.filter(function (x) { return x.c < t[0].c; })[0];
      return '記者最常問' + more + '（各 ' + t[0].c + ' 題）' + (rest ? '，其次是「' + rest.w + '」（' + rest.c + ' 題）' : '');
    }
    return '記者最常問「' + t[0].w + '」（' + t[0].c + ' 題）' + (t[1] ? '，其次是「' + t[1].w + '」' : '') + (t[2] ? '、「' + t[2].w + '」' : '');
  }
  function eventsTitle(events) {
    var top = events.filter(function (e) { return e.count === events[0].count; });
    var head0 = '共 ' + events.length + ' 場記者會';
    if (!events[0].count) return head0;
    if (top.length > 1) return head0 + '；問題最多的有 ' + top.length + ' 場，各 ' + events[0].count + ' 題';
    return head0 + '；問題最多的是《' + shortName(events[0].name, 12) + '》（' + events[0].count + ' 題）';
  }
  var NOT_MEDIA_RE = /^（(未填寫|未提供|內部職員|群組提問)）$/;

  // ───────────────────────── 資料模型（純函式，可在 node 測）─────────────────────────
  function buildModel(input) {
    input = input || {};
    var A = input.analytics || {}, X = input.exposure || null, T = input.training || null;
    var minPerQ = clampMin(input.minPerQ);
    var terms = input.terms || [];
    var today = input.today || '';
    // 企業場不是記者會：不列進這份報告（批次 118，跟 /report 一致）
    var byEvent = (A.by_event || []).filter(function (e) { return e.audience !== 'business'; });
    var total = A.business_qa ? sum(byEvent.map(function (e) { return e.count; })) : (A.total || 0);
    var union = {};
    byEvent.forEach(function (e) { (e.media_list || []).forEach(function (m) { union[m] = 1; }); });
    var mediaTotal = A.media_total != null ? A.media_total : Object.keys(union).length;
    var hasExp = !!(X && X.totalExposure);
    var hasTrain = !!(T && T.overall && T.overall.sessions);
    var trainBy = {};
    ((T && T.by_event) || []).forEach(function (t) { trainBy[t.event_id] = t; });

    function topicsOf(questions, n) {
      var kw = {};
      (questions || []).forEach(function (q) {
        var text = (q && q.question) || '';
        terms.forEach(function (w) { if (text.indexOf(w) !== -1) kw[w] = (kw[w] || 0) + 1; });
      });
      return Object.keys(kw).map(function (w) { return { w: w, c: kw[w] }; }).sort(function (a, b) { return b.c - a.c; }).slice(0, n);
    }
    var allQuestions = [];
    byEvent.forEach(function (e) { (e.questions || []).forEach(function (q) { allQuestions.push(q); }); });
    var analysed = allQuestions.length || total;
    var topics = topicsOf(allQuestions, 8).map(function (t) { return { w: t.w, c: t.c, pct: analysed ? Math.round(t.c / analysed * 100) : 0 }; });

    var filledSum = 0;
    var events = byEvent.map(function (e) {
      var filled = e.media_filled != null ? e.media_filled
        : (e.questions || []).filter(function (q) { return q.media && !NOT_MEDIA_RE.test(q.media); }).length;
      filledSum += filled;
      var tr = trainBy[e.event_id];
      var ex = hasExp && X.byEvent ? X.byEvent[e.event_id] : null;
      var exp = ex && ex.exposure && ex.exposure.total ? {
        total: ex.exposure.total, outlets: ex.exposure.outlets,
        rate: ex.cross && ex.cross.askedPublishRate != null ? ex.cross.askedPublishRate : null,
        asked: ex.qa ? ex.qa.mediaAsked : 0, askedPublished: ex.cross ? ex.cross.askedAndPublished : 0,
        publishedNotAsked: ex.cross ? ex.cross.publishedNotAsked : 0,
        top: (ex.exposure.topOutlets || []).slice(0, 6)
      } : null;
      return {
        id: e.event_id, name: e.event_name || e.event_id, count: e.count || 0, mediaCount: e.media_count || 0,
        fillRate: e.count ? Math.round(filled / e.count * 100) : 0, lineCount: e.line_count || 0,
        topics: topicsOf(e.questions, 6), mediaList: e.media_list || [],
        training: tr && tr.sessions ? { sessions: tr.sessions, avg: tr.avg_score } : null, exposure: exp
      };
    }).sort(function (a, b) { return b.count - a.count; });
    var fillRate = total ? Math.round(filledSum / total * 100) : 0;
    var topMedia = (A.top_media || []).slice(0, 8).map(function (m) { return { name: m.name, count: m.count }; });

    // 露出與「提問 → 發稿」：各場合計（同一家媒體跨場會重複算；口徑頁有寫）
    var exp = null;
    if (hasExp) {
      var asked = sum(events.map(function (e) { return e.exposure ? e.exposure.asked : 0; }));
      var ap = sum(events.map(function (e) { return e.exposure ? e.exposure.askedPublished : 0; }));
      exp = {
        total: X.totalExposure, outlets: X.totalOutlets, events: X.eventsWithExposure,
        asked: asked, askedPublished: ap, rate: asked ? Math.round(ap / asked * 100) : null,
        publishedNotAsked: sum(events.map(function (e) { return e.exposure ? e.exposure.publishedNotAsked : 0; })),
        eventCount: events.filter(function (e) { return e.exposure; }).length,
        rows: events.filter(function (e) { return e.exposure; }).sort(function (a, b) { return b.exposure.total - a.exposure.total; }).slice(0, 8),
        caveat: X.caveat || ''
      };
    }
    var train = hasTrain ? { sessions: T.overall.sessions, voice: T.overall.voice_sessions || 0, avg: T.overall.avg_score,
      rows: ((T.by_event) || []).filter(function (t) { return t.sessions; }).slice(0, 8) } : null;

    function hoursFor(m) { return total * clampMin(m) / 60; }
    var titles = {
      kpi: function (m) {
        return total ? '記者問了 ' + fmt(total) + ' 題、服務 ' + fmt(mediaTotal) + ' 家媒體，估計替同仁省下 ' + hoursStr(hoursFor(m)) + ' 小時'
          : '目前還沒有記者問答紀錄';
      },
      calc: function (m) { m = clampMin(m); return '每題人工回覆以 ' + m + ' 分鐘估算，' + fmt(total) + ' 題等於省下 ' + hoursStr(hoursFor(m)) + ' 小時'; }
    };

    var slides = [];
    slides.push({ id: 'cover', chapter: '總覽', kind: 'cover', title: '工研院活動溝通 AI 平台｜成效報告' });
    slides.push({ id: 'kpi', chapter: '總覽', kind: 'kpi', title: titles.kpi(minPerQ), sub: '先看整體：幾場、幾題、幾家媒體、省了多少人力' });
    if (topics.length) {
      var t = topics;
      slides.push({ id: 'topics', chapter: '記者問什麼', kind: 'topics',
        title: topicsTitle(t),
        sub: '共分析 ' + fmt(analysed) + ' 題問答；每一條是「問題裡提到這個主題」的題數' });
    }
    if (mediaTotal || topMedia.length) {
      slides.push({ id: 'media', chapter: '誰在用', kind: 'media',
        title: '共服務 ' + fmt(mediaTotal) + ' 家媒體' + (topMedia[0] ? '，最常使用的是' + shortName(topMedia[0].name, 14) + '（' + topMedia[0].count + ' 題）' : ''),
        sub: '同一家媒體只算一次；排行看的是各家提問的題數' });
    }
    if (events.length) {
      slides.push({ id: 'events', chapter: '各場成效', kind: 'events',
        title: eventsTitle(events),
        sub: '點任一場，右邊看該場記者最關心的議題與到訪媒體；點欄位標題可以重新排序' });
    }
    if (exp) {
      slides.push({ id: 'exposure', chapter: '露出', kind: 'exposure',
        title: fmt(exp.total) + ' 則媒體報導、' + fmt(exp.outlets) + ' 家媒體' + (exp.rate != null ? '；使用過 AI 問答的媒體，' + exp.rate + '% 後續有發稿' : ''),
        sub: '來自各場上傳的媒體露出清單，與 AI 問答紀錄交叉比對' });
    }
    if (train) {
      slides.push({ id: 'training', chapter: '訓練', kind: 'training',
        title: '已有 ' + fmt(train.sessions) + ' 場媒體訓練演練' + (train.avg != null ? '，平均 ' + train.avg + ' / 10 分' : ''),
        sub: '發言人會前讓 AI 扮記者出題、逐題評分' });
    }
    slides.push({ id: 'calc', chapter: '算法', kind: 'calc', title: titles.calc(minPerQ), sub: '「節省人力」是估算——每題人工回覆要花多久，拖動下面的滑桿自己調' });
    slides.push({ id: 'defs', chapter: '算法', kind: 'defs', title: '怎麼看這份報告：哪些算、哪些不算', sub: '數字背後的算法與限制，寫清楚比好看重要' });

    return {
      minPerQ: minPerQ, today: today, total: total, mediaTotal: mediaTotal, analysed: analysed, fillRate: fillRate,
      events: events, topics: topics, topMedia: topMedia, exposure: exp, training: train,
      businessQa: A.business_qa || 0, slides: slides, hoursFor: hoursFor, titles: titles, hoursStr: hoursStr
    };
  }

  // ───────────────────────── 畫面 ─────────────────────────
  var deck = null; // 目前開著的簡報

  function bar(name, value, max, unit, extra, d, dec) {
    var w = max ? Math.max(2, Math.round(value / max * 100)) : 0;
    return '<div class="rd-brow rd-rv" style="--d:' + d + ';--w:' + w + '%"><div class="rd-nm" title="' + esc(name) + '">' + esc(name) +
      '</div><div class="rd-tr"><i></i></div><div class="rd-vv"><span>' + fmt(value, dec) + '</span><small>' + esc(unit) + (extra ? '・' + esc(extra) : '') + '</small></div></div>';
  }
  function cu(value, dec) { return '<span class="rd-cu" data-to="' + value + '" data-dec="' + (dec || 0) + '">' + fmt(value, dec) + '</span>'; }
  function ring(pct, sizeLabel, subLabel, color) {
    var R = 130, C = 2 * Math.PI * R, off = C * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return '<div class="rd-ring"><svg viewBox="0 0 340 340"><circle cx="170" cy="170" r="' + R + '" fill="none" stroke="#EFE9DC" stroke-width="40"/>' +
      '<circle class="rd-fg" cx="170" cy="170" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="40" stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) +
      '" stroke-dashoffset="' + off.toFixed(2) + '" data-full="' + C.toFixed(2) + '" data-off="' + off.toFixed(2) + '"/></svg>' +
      '<div class="rd-rc"><b>' + esc(sizeLabel) + '</b><span>' + esc(subLabel) + '</span></div></div>';
  }
  function head(s) { var L = String(s.title || '').length; return '<div class="rd-hd"><h2 class="rd-rv' + (L > 70 ? ' xl' : L > 28 ? ' long' : '') + '" data-bind="title-' + esc(s.id) + '">' + esc(s.title) + '</h2><p class="rd-rv" style="--d:1">' + esc(s.sub || '') + '</p></div>'; }
  function note(html) { return '<div class="rd-note rd-rv" style="--d:9"><b>口徑：</b>' + html + '</div>'; }

  var RENDER = {
    cover: function (m) {
      var chips = '<span class="rd-tag"><b>' + fmt(m.events.length) + '</b>場記者會</span><span class="rd-tag o"><b>' + fmt(m.total) + '</b>題問答</span><span class="rd-tag"><b>' + fmt(m.mediaTotal) + '</b>家媒體</span>';
      var facts = [];
      if (m.topics[0]) facts.push('記者最常問的是「' + m.topics[0].w + '」，共 ' + m.topics[0].c + ' 題');
      if (m.events[0] && m.events[0].count) facts.push('問題最多的一場：《' + m.events[0].name + '》，' + m.events[0].count + ' 題');
      facts.push('累計服務 ' + fmt(m.mediaTotal) + ' 家媒體');
      facts.push('估計替同仁省下 ' + hoursStr(m.hoursFor(m.minPerQ)) + ' 小時');
      return '<div class="rd-cover"><div class="rd-k rd-rv">AI 新聞助理</div>' +
        '<div class="rd-t rd-rv" style="--d:1">工研院活動溝通<br><span>AI 平台成效報告</span></div>' +
        '<div class="rd-chips rd-rv pop" style="--d:3">' + chips + '</div>' +
        '<div class="rd-meta rd-rv" style="--d:4">報告產出日：' + esc(m.today) + '<br>數據來自 AI 新聞助理實際問答紀錄，已排除測試資料</div>' +
        '<div class="rd-hero rd-rv pop" style="--d:2"><div class="rd-bubble" id="rd-bubble">嗨！點我看一個重點 👆</div><img class="rd-mia" id="rd-mia" src="/mia-avatar.png" alt="米亞" data-facts="' + esc(JSON.stringify(facts)) + '"></div>' +
        '<div class="rd-hint rd-rv" style="--d:5">按 → 或空白鍵看下一頁</div></div>';
    },
    kpi: function (m) {
      var cards = [
        { c: 't1', lab: '支援記者會場次', v: m.events.length, hint: '企業場不列入' },
        { c: 't2', lab: '累積回答題數', v: m.total, hint: '已排除測試資料' },
        { c: 't3', lab: '服務媒體家數', v: m.mediaTotal, hint: '同一家媒體只算一次；未填媒體名稱的不計，實際觸及可能更高' },
        { c: 't4', lab: '估算節省工時', v: Number(hoursStr(m.hoursFor(m.minPerQ))), dec: m.hoursFor(m.minPerQ) >= 10 ? 0 : 1, unit: '小時', hint: '<span data-bind="formula">' + fmt(m.total) + ' 題 × ' + m.minPerQ + ' 分 ÷ 60</span>（下一頁可調）' }
      ];
      if (m.exposure) {
        cards.push({ c: 't1', lab: '累積媒體露出則數', v: m.exposure.total, hint: '涵蓋 ' + m.exposure.events + ' 場已登錄露出的活動' });
        cards.push({ c: 't2', lab: '露出媒體家數', v: m.exposure.outlets, hint: '依監測清單的媒體名稱去重' });
      }
      if (m.training) {
        cards.push({ c: 't3', lab: '媒體訓練演練場次', v: m.training.sessions, hint: '發言人會前 AI 記者實戰演練' });
        cards.push({ c: 't4', lab: '平均訓練分數', v: m.training.avg == null ? 0 : m.training.avg, dec: 1, unit: '/ 10', hint: 'AI 訓練師逐題評分的平均' });
      }
      cards = cards.slice(0, 8);
      return head(m.slides[1]) + '<div class="rd-body"><div class="rd-kpis">' + cards.map(function (k, i) {
        return '<div class="rd-kpi rd-card rd-rv pop ' + k.c + '" style="--d:' + (i + 2) + '"><div class="rd-lab">' + esc(k.lab) + '</div><div class="rd-val">' +
          (k.lab === '估算節省工時' ? '<span class="rd-cu" data-bind="hours" data-to="' + k.v + '" data-dec="' + (k.dec || 0) + '">' + fmt(k.v, k.dec) + '</span>' : cu(k.v, k.dec)) +
          (k.unit ? '<small>' + esc(k.unit) + '</small>' : '') + '</div><div class="rd-hint2">' + k.hint + '</div></div>';
      }).join('') + '</div></div>' + note('數據來自 AI 新聞助理實際問答紀錄，已排除測試資料' + (m.businessQa ? '與企業場（' + m.businessQa + ' 則問答不列入）' : '') + '；「節省工時」是估算值，不是實測。');
    },
    topics: function (m, s) {
      var max = m.topics[0].c;
      return head(s) + '<div class="rd-body"><div class="rd-cols"><div class="rd-bars">' + m.topics.map(function (t, i) { return bar(t.w, t.c, max, '題', t.pct + '%', i + 2); }).join('') +
        '</div><div class="rd-side rd-card rd-rv" style="--d:6"><h3>怎麼讀這張圖</h3><ul><li>橫條長度＝提到這個主題的<b>題數</b>，右邊同時寫出題數與占全部問答的百分比。</li>' +
        '<li>一題可以同時提到好幾個主題，所以百分比<b>不會加總成 100%</b>。</li><li>主題是用固定的產業詞表比對問題文字，沒有收進詞表的問法不會出現在這裡。</li></ul></div></div></div>' +
        note('分析範圍：' + fmt(m.analysed) + ' 題問答（已排除測試資料與企業場）。');
    },
    media: function (m, s) {
      var max = m.topMedia[0] ? m.topMedia[0].count : 0;
      var names = [];
      m.events.forEach(function (e) { e.mediaList.forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); }); });
      var shown = names.slice(0, 30);
      return head(s) + '<div class="rd-body"><div class="rd-cols"><div class="rd-bars">' +
        (m.topMedia.length ? m.topMedia.map(function (t, i) { return bar(t.name, t.count, max, '題', '', i + 2); }).join('') : '<div class="rd-empty">記者多未填寫媒體名稱，暫時沒有排行</div>') +
        '</div><div class="rd-side rd-card rd-rv" style="--d:6"><h3>媒體填寫率</h3><div class="rd-big">' + cu(m.fillRate) + '<small>%</small></div><p>有填媒體名稱的題數 ÷ 全部題數。</p>' +
        '<h3 style="margin-top:14px">到訪媒體</h3><div class="rd-chipwrap">' + shown.map(function (n) { return '<span class="rd-tag">' + esc(n) + '</span>'; }).join('') +
        (names.length > shown.length ? '<span class="rd-tag o">…等 ' + names.length + ' 家</span>' : '') + (names.length ? '' : '<p>尚無資料</p>') + '</div></div></div></div>' +
        note('媒體名稱由記者自己填；同一家媒體的不同記者併成一家，「（未提供）」「（內部職員）」與整句問題不算媒體。沒填名稱的題目不計入家數，所以實際觸及的媒體可能更多。');
    },
    events: function (m, s) {
      var hasExp = !!m.exposure;
      var cols = '1fr 150px 130px 140px 140px' + (hasExp ? ' 130px' : '');
      var head0 = '<div class="rd-tr0" style="grid-template-columns:' + cols + '"><button data-sort="name">場次</button><button data-sort="count" class="on">回答題數</button><button data-sort="media">媒體家數</button><button data-sort="fill">媒體填寫率</button><button data-sort="hours">估算省時</button>' + (hasExp ? '<button data-sort="exp">露出則數</button>' : '') + '</div>';
      return head(s) + '<div class="rd-body"><div class="rd-cols"><div class="rd-tbl rd-rv" style="--d:2">' + head0 +
        '<div class="rd-tbody" id="rd-tbody" data-cols="' + cols + '"></div></div><div class="rd-side rd-card rd-rv" style="--d:3" id="rd-evside"></div></div></div>' +
        note('題數＝該場記者實際問的題數（已排除測試資料）；媒體填寫率＝有填媒體名稱的題數 ÷ 題數；估算省時＝題數 × 每題分鐘 ÷ 60（每題分鐘數見「算法」頁）。');
    },
    exposure: function (m, s) {
      var e = m.exposure, cols = '1fr 120px 130px 170px 110px';
      var ringHtml = e.rate != null ? ring(e.rate, e.rate + '%', e.askedPublished + ' / ' + e.asked + ' 家', '#14C2B5')
        : '<div class="rd-empty" style="font-size:24px;padding:20px 0">沒有媒體同時用過 AI 問答，<br>無法計算發稿率</div>';
      var thead = '<div class="rd-tr0" style="grid-template-columns:' + cols + '"><span>場次</span><span>露出則數</span><span>露出媒體</span><span>提問媒體→有發稿</span><span>發稿率</span></div>';
      var trs = e.rows.map(function (r) {
        var x = r.exposure;
        return '<div class="rd-trow rd-rv" style="grid-template-columns:' + cols + ';--d:3"><div class="rd-nm">' + esc(r.name) + '</div><div class="c">' + fmt(x.total) + '<small>則</small></div>' +
          '<div class="c">' + fmt(x.outlets) + '<small>家</small></div><div class="c">' + (x.asked ? fmt(x.askedPublished) + ' / ' + fmt(x.asked) + '<small>家</small>' : '—') + '</div>' +
          '<div class="c">' + (x.rate != null ? x.rate + '<small>%</small>' : '—') + '</div></div>';
      }).join('');
      return head(s) + '<div class="rd-body"><div class="rd-cols"><div class="rd-tbl rd-static rd-rv" style="--d:2">' + thead + '<div class="rd-tbody">' + trs + '</div></div>' +
        '<div class="rd-side rd-card rd-rv" style="--d:5"><h3>提問 → 發稿（合計）</h3>' + ringHtml +
        '<div class="rd-cap">使用過 AI 問答的媒體，<br>後續有露出的比例</div><p style="margin-top:10px">另有 <b>' + fmt(e.publishedNotAsked) + '</b> 家媒體沒用 AI 問答，但仍有露出。</p></div></div></div>' +
        note('露出清單由同仁上傳（監測公司提供）；「提問 → 發稿」以媒體名稱模糊比對，可能有誤差，而且只涵蓋「有使用 AI 問答」的媒體；各場合計，同一家媒體跨場會重複計算。' +
          (e.eventCount > e.rows.length ? '表格只列露出最多的 ' + e.rows.length + ' 場（共 ' + e.eventCount + ' 場）。' : ''));
    },
    training: function (m, s) {
      var t = m.training, avg = t.avg == null ? 0 : t.avg;
      var rows = t.rows.map(function (r, i) {
        return bar(r.event_name || r.event_id, r.avg_score == null ? 0 : r.avg_score, 10, '/ 10 分', r.sessions + ' 場', i + 2, 1);
      }).join('');
      return head(s) + '<div class="rd-body"><div class="rd-cols"><div class="rd-bars">' + rows + '</div><div class="rd-side rd-card rd-rv" style="--d:5"><h3>平均分數</h3>' +
        ring(avg * 10, String(t.avg == null ? '—' : t.avg), '/ 10 分', '#FF9A2E') + '<div class="rd-cap">共 ' + fmt(t.sessions) + ' 場，其中 ' + fmt(t.voice) + ' 場用語音作答</div></div></div></div>' +
        note('分數是 AI 訓練師逐題評分（0–10）的平均，由每一題的原始分數重新計算；只統計「練完整場」的紀錄，中途離開的不算。');
    },
    calc: function (m, s) {
      return head(s) + '<div class="rd-body rd-calc"><div class="rd-formula rd-rv" style="--d:2"><b data-bind="q">' + fmt(m.total) + '</b> 題 × <b data-bind="min">' + m.minPerQ + '</b> 分鐘 ÷ 60 ＝ ' +
        '<b data-bind="hours2">' + hoursStr(m.hoursFor(m.minPerQ)) + '</b> 小時</div><div class="rd-result rd-rv" style="--d:3">約等於 <b data-bind="days">' + (m.hoursFor(m.minPerQ) / 8).toFixed(1) + '</b> 個 8 小時工作天</div>' +
        '<div class="rd-slider rd-card rd-rv" style="--d:4"><label for="rd-range">每一題，人工回覆大約要花幾分鐘？ <b data-bind="min2">' + m.minPerQ + '</b> 分鐘</label>' +
        '<input id="rd-range" type="range" min="' + MIN_LO + '" max="' + MIN_HI + '" step="1" value="' + m.minPerQ + '"><div class="rd-presets">' +
        [2, 3, 5, 10, 15].map(function (n) { return '<button type="button" data-min="' + n + '"' + (n === m.minPerQ ? ' class="on"' : '') + '>' + n + ' 分</button>'; }).join('') + '</div></div></div>' +
        note('把一題人工回答要花的時間（查新聞稿、回訊息）乘上 AI 代答的題數，只是效益的參考估算；調整這裡，報告首頁的數字會跟著變。');
    },
    defs: function (m, s) {
      var defs = [
        ['數據從哪來', '來自 AI 新聞助理（網頁與 LINE）實際的問答紀錄，已排除測試資料，以及同仁自己問的題目。'],
        ['企業場不列入', '企業說明會、技術媒合會、客戶參訪、技術交流會的問答不算進這份報告' + (m.businessQa ? '（目前有 ' + m.businessQa + ' 則）' : '') + '。'],
        ['服務媒體家數', '以記者填寫的媒體名稱計算，同一家媒體的不同記者只算一家；沒填名稱的不計，實際觸及可能更高。'],
        ['估算節省工時', '回答題數 × 每題人工回覆分鐘數 ÷ 60。分鐘數是估計值，可在「算法」頁調整，不是實測。'],
        ['媒體露出', '露出清單由同仁上傳（監測公司提供）；「提問 → 發稿」以名稱模糊比對，可能有誤差。'],
        ['媒體訓練', '發言人會前讓 AI 扮記者出題、逐題評分；只統計練完整場的紀錄。']
      ];
      return head(s) + '<div class="rd-body"><div class="rd-defs">' + defs.map(function (d, i) {
        return '<div class="rd-def rd-card rd-rv pop" style="--d:' + (i + 2) + '"><h4>' + esc(d[0]) + '</h4><p>' + esc(d[1]) + '</p></div>';
      }).join('') + '</div></div><div class="rd-note rd-rv" style="--d:9">報告產出日：' + esc(m.today) + '　·　這份簡報由後台資料即時產生；要列印或存 PDF，請回到報告頁按「列印／存 PDF」。</div>';
    }
  };

  // ───────────────────────── 互動 ─────────────────────────
  function el(id) { return document.getElementById(id); }
  function qsa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  function countUp(node, reduce) {
    var to = Number(node.dataset.to) || 0, dec = Number(node.dataset.dec) || 0;
    var finalText = fmt(to, dec);
    if (reduce || to === 0) { node.textContent = finalText; return; }
    var t0 = null;
    function f(t) {
      if (node._stop) { node.textContent = finalText; return; }
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3);
      node.textContent = fmt(to * e, dec);
      if (k < 1) requestAnimationFrame(f); else node.textContent = finalText; // 一定停在最後那個字串
    }
    node._stop = false;
    requestAnimationFrame(f);
  }
  function settle(slide) { // 離開頁面：所有數字、環圈回到最後的值
    qsa(slide, '.rd-cu').forEach(function (n) { n._stop = true; n.textContent = fmt(Number(n.dataset.to) || 0, Number(n.dataset.dec) || 0); });
    qsa(slide, '.rd-fg').forEach(function (c) { c.style.transition = ''; c.style.strokeDashoffset = c.dataset.off; });
  }
  function enter(slide) {
    var reduce = deck.wrap.classList.contains('reduce');
    qsa(slide, '.rd-cu').forEach(function (n) { n._stop = false; setTimeout(function () { if (slide.classList.contains('active')) countUp(n, reduce); }, 350); });
    if (!reduce) qsa(slide, '.rd-fg').forEach(function (c) {
      c.style.transition = 'none'; c.style.strokeDashoffset = c.dataset.full; void c.getBoundingClientRect();
      c.style.transition = ''; requestAnimationFrame(function () { c.style.strokeDashoffset = c.dataset.off; });
    });
  }

  function open(opts) {
    if (deck) close();
    var model = buildModel(opts);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    var wrap = document.createElement('div');
    wrap.id = 'rd-wrap'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-label', '成效報告互動簡報');
    wrap.innerHTML = '<div id="rd-stage"><div id="rd-grid-bg"></div><nav id="rd-chap"></nav><div id="rd-slides"></div><div id="rd-prog"></div>' +
      '<div id="rd-foot"><span>AI 新聞助理｜成效報告・' + esc(model.today) + '</span><span class="rd-tools"><button type="button" id="rd-prev" aria-label="上一頁">◀</button><span class="rd-pg" id="rd-pg"></span>' +
      '<button type="button" id="rd-next" aria-label="下一頁">▶</button><button type="button" id="rd-gridbtn">總覽 (O)</button><button type="button" id="rd-motion">動畫：開</button>' +
      '<button type="button" id="rd-full">全螢幕 (F)</button><button type="button" id="rd-close">關閉 (Esc)</button></span></div>' +
      '<div id="rd-ov"><h2>簡報總覽 <small>點一下跳過去・Esc 關閉</small></h2><div class="rd-gg" id="rd-gg"></div></div></div>';
    document.body.appendChild(wrap);
    var reduceMq = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMq) wrap.classList.add('reduce');
    deck = { wrap: wrap, model: model, opts: opts, cur: -1, prevOverflow: prevOverflow, opener: document.activeElement, sort: { key: 'count', dir: -1 }, sel: model.events[0] ? model.events[0].id : '', handlers: [] };
    render();
    fit();
    on(window, 'resize', fit);
    on(document, 'keydown', onKey, true);
    on(el('rd-stage'), 'touchstart', function (e) { deck.tx = e.touches[0].clientX; }, { passive: true });
    on(el('rd-stage'), 'touchend', function (e) { if (deck.tx == null) return; var dx = e.changedTouches[0].clientX - deck.tx; if (Math.abs(dx) > 70) (dx < 0 ? next() : prev()); deck.tx = null; });
    el('rd-prev').onclick = prev; el('rd-next').onclick = next; el('rd-close').onclick = close;
    el('rd-gridbtn').onclick = toggleGrid; el('rd-full').onclick = toggleFull;
    el('rd-motion').onclick = function () { var r = wrap.classList.toggle('reduce'); this.textContent = '動畫：' + (r ? '關' : '開'); };
    if (reduceMq) el('rd-motion').textContent = '動畫：關';
    go(0);
    return { close: close, go: go, model: model };
  }
  function on(target, type, fn, opt) { target.addEventListener(type, fn, opt); deck.handlers.push([target, type, fn, opt]); }
  function close() {
    if (!deck) return;
    deck.handlers.forEach(function (h) { h[0].removeEventListener(h[1], h[2], h[3]); });
    if (document.fullscreenElement) document.exitFullscreen();
    deck.wrap.remove();
    document.body.style.overflow = deck.prevOverflow;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    try { if (deck.opener && deck.opener.focus) deck.opener.focus(); } catch (e) { /* ignore */ }
    deck = null;
  }
  function fit() { var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080); el('rd-stage').style.transform = 'scale(' + s + ')'; }

  function render() {
    var m = deck.model, host = el('rd-slides');
    host.innerHTML = m.slides.map(function (s, i) { return '<section class="rd-slide" id="rd-s' + i + '" data-title="' + esc(s.title) + '">' + RENDER[s.kind](m, s) + '</section>'; }).join('');
    var seen = {}, chap = el('rd-chap'); chap.innerHTML = '';
    m.slides.forEach(function (s, i) {
      if (seen[s.chapter]) return; seen[s.chapter] = 1;
      var b = document.createElement('button'); b.type = 'button'; b.textContent = s.chapter; b.dataset.first = i; b.onclick = function () { go(i); }; chap.appendChild(b);
    });
    el('rd-gg').innerHTML = m.slides.map(function (s, i) {
      return '<button type="button" class="rd-gi" data-i="' + i + '"><div class="rd-gn">' + String(i + 1).padStart(2, '0') + '</div>' + esc(s.title) + '</button>';
    }).join('');
    qsa(el('rd-gg'), '.rd-gi').forEach(function (b) { b.onclick = function () { toggleGrid(); go(+b.dataset.i); }; });
    wire();
  }

  function wire() {
    var m = deck.model;
    var mia = el('rd-mia');
    if (mia) { var facts = JSON.parse(mia.dataset.facts || '[]'), k = 0; mia.onclick = function () { el('rd-bubble').textContent = facts[k++ % facts.length]; }; }
    var tb = el('rd-tbody');
    if (tb) {
      qsa(document, '.rd-tr0 button').forEach(function (b) {
        b.onclick = function () {
          var key = b.dataset.sort; deck.sort = { key: key, dir: deck.sort.key === key ? -deck.sort.dir : (key === 'name' ? 1 : -1) };
          qsa(document, '.rd-tr0 button').forEach(function (x) { x.classList.toggle('on', x === b); });
          renderRows();
        };
      });
      renderRows();
    }
    var range = el('rd-range');
    if (range) {
      range.oninput = function () { setMin(+range.value); };
      qsa(document, '.rd-presets button').forEach(function (b) { b.onclick = function () { range.value = b.dataset.min; setMin(+b.dataset.min); }; });
    }
  }

  function evValue(e, key, m) {
    if (key === 'name') return e.name; if (key === 'media') return e.mediaCount; if (key === 'fill') return e.fillRate;
    if (key === 'hours') return e.count * m.minPerQ / 60; if (key === 'exp') return e.exposure ? e.exposure.total : 0; return e.count;
  }
  function renderRows() {
    var m = deck.model, tb = el('rd-tbody'), cols = tb.dataset.cols, hasExp = !!m.exposure, s = deck.sort;
    var rows = m.events.slice().sort(function (a, b) {
      var x = evValue(a, s.key, m), y = evValue(b, s.key, m);
      return (typeof x === 'string' ? x.localeCompare(y, 'zh-Hant') : x - y) * s.dir || b.count - a.count;
    });
    var max = Math.max.apply(null, [1].concat(m.events.map(function (e) { return e.count; })));
    tb.innerHTML = rows.map(function (e) {
      return '<button type="button" class="rd-trow' + (e.id === deck.sel ? ' sel' : '') + '" data-id="' + esc(e.id) + '" style="grid-template-columns:' + cols + '"><div class="rd-nm">' + esc(e.name) + '</div>' +
        '<div class="c">' + fmt(e.count) + '<small>題</small><i class="rd-mini" style="--w:' + Math.max(3, Math.round(e.count / max * 100)) + '%"></i></div>' +
        '<div class="c">' + fmt(e.mediaCount) + '<small>家</small></div><div class="c">' + e.fillRate + '<small>%</small></div>' +
        '<div class="c" data-evq="' + e.count + '">' + (e.count * m.minPerQ / 60).toFixed(1) + '<small>小時</small></div>' +
        (hasExp ? '<div class="c">' + (e.exposure ? fmt(e.exposure.total) + '<small>則</small>' : '—') + '</div>' : '') + '</button>';
    }).join('');
    qsa(tb, '.rd-trow').forEach(function (b) { b.onclick = function () { deck.sel = b.dataset.id; qsa(tb, '.rd-trow').forEach(function (x) { x.classList.toggle('sel', x === b); }); renderSide(); }; });
    renderSide();
  }
  function renderSide() {
    var m = deck.model, e = m.events.filter(function (x) { return x.id === deck.sel; })[0], host = el('rd-evside');
    if (!e) { host.innerHTML = '<p>點左邊任一場看細節</p>'; return; }
    var parts = ['<h3>' + esc(e.name) + '</h3><p><b>' + fmt(e.count) + '</b> 題・<b>' + fmt(e.mediaCount) + '</b> 家媒體' + (e.lineCount ? '・其中 ' + e.lineCount + ' 題來自 LINE' : '') + '</p>'];
    parts.push('<h3 style="margin-top:12px">記者最關心</h3><div class="rd-chipwrap">' + (e.topics.length ? e.topics.map(function (t) { return '<span class="rd-tag">' + esc(t.w) + '・' + t.c + ' 題</span>'; }).join('') : '<p>尚無資料</p>') + '</div>');
    parts.push('<h3 style="margin-top:12px">到訪媒體</h3><div class="rd-chipwrap">' + (e.mediaList.length ? e.mediaList.slice(0, 16).map(function (n) { return '<span class="rd-tag o">' + esc(n) + '</span>'; }).join('') + (e.mediaList.length > 16 ? '<span class="rd-tag">…等 ' + e.mediaList.length + ' 家</span>' : '') : '<p>記者多未填寫媒體名稱</p>') + '</div>');
    if (e.exposure) parts.push('<h3 style="margin-top:12px">媒體露出</h3><p><b>' + fmt(e.exposure.total) + '</b> 則・<b>' + fmt(e.exposure.outlets) + '</b> 家媒體' + (e.exposure.rate != null ? '・提問媒體發稿率 <b>' + e.exposure.rate + '%</b>' : '') + '</p>');
    if (e.training) parts.push('<h3 style="margin-top:12px">媒體訓練</h3><p><b>' + e.training.sessions + '</b> 場演練' + (e.training.avg != null ? '・平均 <b>' + e.training.avg + '</b> / 10' : '') + '</p>');
    host.innerHTML = parts.join('');
  }

  // 每題分鐘數改了：只更新有標記的地方，不重畫（拖滑桿時不能把滑桿本身換掉）
  function setMin(v) {
    var m = deck.model; m.minPerQ = clampMin(v);
    var h = m.hoursFor(m.minPerQ), hs = hoursStr(h);
    function setAll(sel, text) { qsa(document, '[data-bind="' + sel + '"]').forEach(function (n) { n.textContent = text; }); }
    setAll('min', m.minPerQ); setAll('min2', m.minPerQ); setAll('hours2', hs); setAll('days', (h / 8).toFixed(1));
    setAll('formula', fmt(m.total) + ' 題 × ' + m.minPerQ + ' 分 ÷ 60');
    qsa(document, '[data-bind="hours"]').forEach(function (n) { n.dataset.to = hs; n.dataset.dec = h >= 10 ? 0 : 1; n.textContent = fmt(Number(hs), h >= 10 ? 0 : 1); });
    qsa(document, '[data-bind="title-kpi"]').forEach(function (n) { n.textContent = m.titles.kpi(m.minPerQ); });
    qsa(document, '[data-bind="title-calc"]').forEach(function (n) { n.textContent = m.titles.calc(m.minPerQ); });
    qsa(document, '[data-evq]').forEach(function (n) { n.innerHTML = (Number(n.dataset.evq) * m.minPerQ / 60).toFixed(1) + '<small>小時</small>'; });
    qsa(document, '.rd-presets button').forEach(function (b) { b.classList.toggle('on', +b.dataset.min === m.minPerQ); });
    var r = el('rd-range'); if (r && +r.value !== m.minPerQ) r.value = m.minPerQ;
    m.slides[1].title = m.titles.kpi(m.minPerQ); m.slides[m.slides.length - 2].title = m.titles.calc(m.minPerQ);
    if (deck.opts && deck.opts.onMinChange) deck.opts.onMinChange(m.minPerQ); // 同步回報告頁的「每題估算節省 N 分鐘」
  }

  function go(i, atEnd) {
    var slides = qsa(el('rd-slides'), '.rd-slide');
    if (i < 0 || i >= slides.length || i === deck.cur) return;
    var fwd = i > deck.cur, old = slides[deck.cur], nw = slides[i];
    if (old) { old.classList.toggle('left', fwd); old.classList.remove('active'); settle(old); }
    nw.style.transition = 'none'; nw.classList.toggle('left', !fwd); void nw.offsetWidth; nw.style.transition = '';
    nw.classList.add('active');
    deck.cur = i;
    el('rd-pg').textContent = (i + 1) + ' / ' + slides.length;
    el('rd-prog').style.width = ((i + 1) / slides.length * 100) + '%';
    var ch = deck.model.slides[i].chapter;
    qsa(el('rd-chap'), 'button').forEach(function (b) { b.classList.toggle('on', b.textContent === ch); });
    enter(nw);
    try { history.replaceState(null, '', '#deck-' + (i + 1)); } catch (e) { /* ignore */ }
  }
  function next() { if (deck.cur < deck.model.slides.length - 1) go(deck.cur + 1); }
  function prev() { if (deck.cur > 0) go(deck.cur - 1, true); }
  function toggleGrid() {
    var ov = el('rd-ov'); var on = ov.classList.toggle('on');
    if (on) qsa(ov, '.rd-gi').forEach(function (b, i) { b.classList.toggle('cur', i === deck.cur); });
  }
  function toggleFull() { if (!document.fullscreenElement) deck.wrap.requestFullscreen && deck.wrap.requestFullscreen().catch(function () {}); else document.exitFullscreen(); }

  function onKey(e) {
    if (!deck) return;
    var k = e.key, tag = e.target && e.target.tagName;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); if (el('rd-ov').classList.contains('on')) toggleGrid(); else close(); return; }
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;           // 拖滑桿時，左右鍵是調數字，不是換頁
    if ((k === ' ' || k === 'Enter') && tag === 'BUTTON') return; // 讓按鈕自己處理
    if (['ArrowRight', 'PageDown', ' ', 'Enter', 'ArrowDown'].indexOf(k) !== -1) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp', 'Backspace'].indexOf(k) !== -1) { e.preventDefault(); prev(); }
    else if (k === 'Home') go(0); else if (k === 'End') go(deck.model.slides.length - 1);
    else if (k === 'o' || k === 'O') toggleGrid(); else if (k === 'f' || k === 'F') toggleFull();
  }

  root.ReportDeck = { buildModel: buildModel, open: open, close: close, esc: esc, hoursStr: hoursStr };
})(typeof window !== 'undefined' ? window : globalThis);
