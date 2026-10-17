// 快速提問預覽（批次 147）——後台編輯視窗（index.html）與同仁編輯頁（edit.html）共用。
//
// 朱朱的回報：「快捷鍵選項沒出現」。快速提問欄位留空時，系統會依知識庫自動出題（lib/default-chips.js），
// 但編輯畫面上完全看不到會出哪幾題，看起來就像「沒有快速提問」。這支在欄位下面即時列出記者現在會看到的按鈕，
// 算法跟網頁、LINE 是同一支（api/events.js action=chips_preview → effectiveChips()），不會兩邊各算各的。
//
// 用法：window.chipsPreview = setupChipsPreview({ box: '顯示區的 id', fields: { 欄位名: '輸入框 id', ... } })
//   之後程式化填值（打開視窗、還原草稿、複製範本）呼叫 chipsPreview.schedule() 重算一次。
// 所有顯示一律用 textContent，問句不會被當成 HTML。
(function () {
  'use strict';
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }

  window.setupChipsPreview = function (opts) {
    var box = document.getElementById(opts.box);
    if (!box) return { schedule: function () {}, refresh: function () {} };
    var timer = null, seq = 0;

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function render(d) {
      box.textContent = '';
      var chips = (d && d.chips) || [];
      var head = d && d.custom
        ? (d.pre_event ? '記者現在看到的（活動前，用你填的「活動前快速提問」）：' : '記者現在看到的（用你填的題目）：')
        : (d && d.pre_event ? '記者現在看到的（活動前，系統預設）：' : '記者現在看到的（系統依知識庫自動出題）：');
      box.appendChild(el('div', 'cp-head', head));
      var row = el('div', 'cp-row');
      chips.forEach(function (c) { row.appendChild(el('span', 'cp-chip', c)); });
      box.appendChild(row);
      if (!(d && d.custom)) box.appendChild(el('div', 'cp-tip', '想自己決定題目，就在上面的欄位每行打一題。'));
    }
    function refresh() {
      var my = ++seq;
      var body = { action: 'chips_preview' };
      Object.keys(opts.fields).forEach(function (k) { body[k] = val(opts.fields[k]); });
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (my === seq && d && Array.isArray(d.chips)) render(d); })
        .catch(function () { /* 預覽是輔助資訊，連不上就不顯示，不影響編輯 */ });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 500); }

    Object.keys(opts.fields).forEach(function (k) {
      var e = document.getElementById(opts.fields[k]);
      if (e) { e.addEventListener('input', schedule); e.addEventListener('change', schedule); }
    });

    var style = document.createElement('style');
    style.textContent = [
      '#' + opts.box + '{margin-top:8px;padding:10px 12px;border:1px dashed var(--border,#cbd5e1);border-radius:10px;background:#f8fafc}',
      '#' + opts.box + ' .cp-head{font-size:.8rem;color:var(--muted,#64748b);margin-bottom:6px}',
      '#' + opts.box + ' .cp-row{display:flex;flex-wrap:wrap;gap:6px}',
      '#' + opts.box + ' .cp-chip{display:inline-block;padding:5px 11px;border-radius:16px;border:1px solid #bfdbfe;background:#fff;color:#1d4ed8;font-size:.82rem;line-height:1.4}',
      '#' + opts.box + ' .cp-tip{font-size:.75rem;color:var(--muted,#64748b);margin-top:6px}',
    ].join('\n');
    document.head.appendChild(style);
    // initial：欄位可能在這支載入之前就被填好了（edit.html 的資料是非同步讀回來的），載入時也算一次
    if (opts.initial) schedule();
    return { schedule: schedule, refresh: refresh };
  };
})();
