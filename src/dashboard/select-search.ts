// Progressive enhancement shared by every server-rendered page: any single
// <select> with 6+ options gets a type-to-search box above it. Client-side only
// (it hides options, never adds values), so server validation is unchanged.
// Opt out per element with data-no-filter. Hadi 2026-10-13: "human first".
export const SELECT_SEARCH_SCRIPT = `
      (function () {
        var MIN = 6;
        function apply(sel, box) {
          // Filter only. Never auto-pick, never fire 'change', never hide the
          // current choice, and never un-hide an option the page itself hid
          // (we only toggle options we hid, marked data-ss-hidden). #1881.
          var q = box.value.trim().toLowerCase();
          var shown = 0;
          for (var i = 0; i < sel.options.length; i++) {
            var o = sel.options[i];
            var hit = !q || o.selected || o.text.toLowerCase().indexOf(q) !== -1;
            if (hit && o.dataset.ssHidden) { o.hidden = false; delete o.dataset.ssHidden; }
            else if (!hit && !o.hidden) { o.hidden = true; o.dataset.ssHidden = '1'; }
            if (!o.hidden) shown++;
          }
          sel.size = q ? Math.min(Math.max(shown, 2), 8) : 0;
        }
        function enhance(sel) {
          if (sel.multiple || sel.hasAttribute('data-no-filter')) return;
          if (sel.__ssBox) { apply(sel, sel.__ssBox); return; }
          if (sel.options.length < MIN) return;
          var box = document.createElement('input');
          box.type = 'search';
          box.autocomplete = 'off';
          box.placeholder = 'Type to search ' + sel.options.length + ' options';
          box.setAttribute('aria-label', 'Search the list below');
          box.style.display = 'block'; box.style.width = '100%'; box.style.maxWidth = '420px'; box.style.marginBottom = '4px';
          // Keep an implicit <label> wrapping the select pointing at the select.
          var anchor = sel.closest('label') || sel;
          anchor.parentNode.insertBefore(box, anchor);
          sel.__ssBox = box;
          box.addEventListener('input', function () { apply(sel, box); });
          box.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sel.focus(); }
          });
          sel.addEventListener('change', function () { if (box.value) sel.size = 0; });
          if (sel.form) sel.form.addEventListener('reset', function () {
            setTimeout(function () { box.value = ''; apply(sel, box); }, 0);
          });
        }
        function scan() { var all = document.querySelectorAll('select'); for (var i = 0; i < all.length; i++) enhance(all[i]); }
        scan();
        var queued = false;
        new MutationObserver(function (records) {
          if (queued) return;
          for (var r = 0; r < records.length; r++) if (records[r].addedNodes.length) {
            queued = true;
            requestAnimationFrame(function () { queued = false; scan(); });
            return;
          }
        }).observe(document.body, { childList: true, subtree: true });
      })();
`
