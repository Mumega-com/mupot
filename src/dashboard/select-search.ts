// Progressive enhancement shared by every server-rendered page: any single
// <select> with 6+ options gets a type-to-search box right after it. The box
// NEVER touches the select's options (no hidden/disabled writes, no auto-pick):
// it lists matching visible, enabled options as buttons, and only a human click
// sets the select's value. Pages keep full control of their own options.
// Opt out per element with data-no-filter. Hadi 2026-10-13: "human first".
export const SELECT_SEARCH_SCRIPT = `
      (function () {
        var MIN = 6;
        function enhance(sel) {
          if (sel.__ssBox || sel.multiple || sel.hasAttribute('data-no-filter') || sel.options.length < MIN) return;
          var wrap = document.createElement('span');
          wrap.style.display = 'block'; wrap.style.maxWidth = '420px'; wrap.style.marginTop = '4px';
          var box = document.createElement('input');
          box.type = 'search';
          box.autocomplete = 'off';
          box.placeholder = 'Search this list';
          box.setAttribute('aria-label', 'Search the list above');
          box.style.display = 'block'; box.style.width = '100%';
          var list = document.createElement('span');
          list.setAttribute('role', 'listbox');
          list.style.display = 'none';
          wrap.appendChild(box); wrap.appendChild(list);
          // After the select (inside the same parent), so a wrapping <label> still
          // labels the select and a hidden group hides the search with it.
          sel.parentNode.insertBefore(wrap, sel.nextSibling);
          sel.__ssBox = box;
          function render() {
            var q = box.value.trim().toLowerCase();
            while (list.firstChild) list.removeChild(list.firstChild);
            if (!q) { list.style.display = 'none'; return; }
            var n = 0;
            for (var i = 0; i < sel.options.length && n < 8; i++) {
              var o = sel.options[i];
              if (o.hidden || o.disabled || o.text.toLowerCase().indexOf(q) === -1) continue;
              var b = document.createElement('button');
              b.type = 'button';
              b.className = 'btn';
              b.setAttribute('role', 'option');
              b.textContent = o.text + (o.selected ? '  (selected)' : '');
              b.style.display = 'block'; b.style.width = '100%'; b.style.textAlign = 'left'; b.style.marginTop = '2px';
              b.addEventListener('click', (function (opt) { return function () {
                if (opt.hidden || opt.disabled || opt.parentNode === null) { render(); return; }
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                box.value = ''; render(); sel.focus();
              }; })(o));
              list.appendChild(b); n++;
            }
            if (n === 0) { var none = document.createElement('span'); none.className = 'ui-sub'; none.textContent = 'No match'; list.appendChild(none); }
            list.style.display = 'block';
          }
          box.addEventListener('input', render);
          box.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });
          if (sel.form) sel.form.addEventListener('reset', function () { setTimeout(function () { box.value = ''; render(); }, 0); });
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
