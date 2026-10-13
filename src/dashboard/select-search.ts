// Progressive enhancement shared by every server-rendered page: any single
// <select> with 6+ options gets a type-to-search box above it. Client-side only
// (it hides options, never adds values), so server validation is unchanged.
// Opt out per element with data-no-filter. Hadi 2026-10-13: "human first".
export const SELECT_SEARCH_SCRIPT = `
      (function () {
        var MIN = 6;
        function enhance(sel) {
          if (sel.multiple || sel.dataset.filterReady || sel.hasAttribute('data-no-filter') || sel.options.length < MIN) return;
          sel.dataset.filterReady = '1';
          var box = document.createElement('input');
          box.type = 'search';
          box.autocomplete = 'off';
          box.placeholder = 'Type to search ' + sel.options.length + ' options';
          box.setAttribute('aria-label', 'Search the list below');
          box.style.display = 'block'; box.style.width = '100%'; box.style.maxWidth = '420px'; box.style.marginBottom = '4px';
          sel.parentNode.insertBefore(box, sel);
          box.addEventListener('input', function () {
            // Filter only. Never auto-pick an option and never fire 'change':
            // the human clicks the one they mean (review on #1881).
            var q = box.value.trim().toLowerCase();
            var shown = 0;
            for (var i = 0; i < sel.options.length; i++) {
              var o = sel.options[i];
              var hit = !q || o.text.toLowerCase().indexOf(q) !== -1;
              o.hidden = !hit;
              if (hit) shown++;
            }
            var cur = sel.options[sel.selectedIndex];
            if (cur && cur.hidden) sel.selectedIndex = -1;
            sel.size = q ? Math.min(Math.max(shown, 2), 8) : 0;
          });
          box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sel.focus(); } });
          sel.addEventListener('change', function () { if (box.value) sel.size = 0; });
        }
        function scan(root) { var all = (root || document).querySelectorAll('select'); for (var i = 0; i < all.length; i++) enhance(all[i]); }
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
