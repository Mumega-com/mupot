// mupot — approve page HTML. Server-rendered; the only script is the optional nonce'd double-submit guard below. Every value is HTML-escaped; agent-authored text
// goes ONLY inside the "untrusted" box, control/invisible characters made visible and length capped, so it
// can never pass as the page's own words. Colours are CSS custom properties (light + dark), no literals
// outside the token block.

const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/gu

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Agent-authored text -> safe, visibly-escaped, length-capped plain text (still to be HTML-escaped by the box). */
export function sanitizeUntrusted(s: string, max = 1200): string {
  const shown = s.length > max ? `${s.slice(0, max)}\n[truncated]` : s
  return shown.replace(INVISIBLE_RE, (c) => {
    if (c === '\n') return c
    const cp = c.codePointAt(0) ?? 0
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
}

export function untrustedBox(label: string, text: string): string {
  return `<div class="untrusted" role="note"><p class="tag">Untrusted. Written by the agent, not by this system. ${escapeHtml(label)}</p><pre>${escapeHtml(sanitizeUntrusted(text))}</pre></div>`
}

/**
 * `script`, when given, is the page's ONE inline script, emitted under the caller's CSP nonce. `srcs` are same-origin
 * script files loaded first (each with a subresource-integrity hash, nonce'd as well): the secure-drop sealer.
 */
export function renderPage(title: string, body: string, script?: { nonce: string; code: string; srcs?: ReadonlyArray<{ src: string; integrity: string }> }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f6f4;--surface:#ffffff;--text:#1b1b1b;--muted:#5c5c5c;--border:#cfcfc8;--accent:#1f4fd8;--accent-text:#ffffff;--danger:#b3261e;--warn-bg:#fff4d6;--warn-border:#d9a400;--bad-bg:#fde7e5;--bad-border:#b3261e;--ok-bg:#e4f4e6;--ok-border:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--surface:#1c1c1c;--text:#ececec;--muted:#a0a0a0;--border:#3a3a3a;--accent:#7aa2ff;--accent-text:#0b0b0b;--danger:#ff8a80;--warn-bg:#3a2f0a;--warn-border:#d9a400;--bad-bg:#3a1512;--bad-border:#ff8a80;--ok-bg:#12301a;--ok-border:#66bb6a}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:1rem 16px 3rem}
h1{font-size:1.35rem;margin:1rem 0 .5rem}h2{font-size:1.05rem;margin:1.25rem 0 .25rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
.status-ok{background:var(--ok-bg);border-color:var(--ok-border)}.status-warn{background:var(--warn-bg);border-color:var(--warn-border)}.status-bad{background:var(--bad-bg);border-color:var(--bad-border)}
.untrusted{border:2px dashed var(--warn-border);background:var(--warn-bg);border-radius:8px;padding:.5rem .75rem;margin:.5rem 0}
.untrusted .tag{margin:0 0 .25rem;font-weight:600;font-size:.9rem}.untrusted pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
ul{padding-left:1.25rem}li{margin:.25rem 0}code{font-family:ui-monospace,monospace;word-break:break-all}
.row{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;min-height:44px}
button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}
select{font:inherit;padding:.4rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px}
.muted{color:var(--muted)}label{display:block}
input[type=password],input[type=text]{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px}
.choices{list-style:none;padding:0;margin:.25rem 0}.choices li{margin:.5rem 0}
label.choice{display:flex;gap:.75rem;align-items:flex-start;box-sizing:border-box;min-height:44px;padding:.65rem .75rem;margin:.5rem 0;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer;touch-action:manipulation}
.choices label.choice{margin:0}
label.choice>input{flex:none;width:1.5rem;height:1.5rem;min-width:24px;min-height:24px;margin:.1rem 0 0;accent-color:var(--accent)}
label.choice>span{flex:1;min-width:0;word-break:break-word}
label.choice:has(>input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 2px var(--accent);background:var(--bg)}
label.choice:has(>input:disabled){border-style:dashed;cursor:not-allowed;opacity:.8}
label.choice .lock-tag{font-weight:600}
label.choice:focus-within{outline:3px solid var(--accent);outline-offset:2px}
.fp{font:1.05rem/1.6 ui-monospace,monospace;letter-spacing:.04em;word-break:break-word}
</style></head><body><main>${body}</main>${script ? `${(script.srcs ?? []).map((f) => `<script nonce="${escapeHtml(script.nonce)}" src="${escapeHtml(f.src)}" integrity="${escapeHtml(f.integrity)}" crossorigin="anonymous"></script>`).join('')}<script nonce="${escapeHtml(script.nonce)}">${script.code}</script>` : ''}</body></html>`
}

export function messagePage(title: string, message: string, status: 'ok' | 'warn' | 'bad'): string {
  return renderPage(title, `<h1>${escapeHtml(title)}</h1><div class="card status-${status}"><p>${escapeHtml(message)}</p></div>`)
}

/**
 * The decision form's double-submit guard (mupot#1860): the first submit keeps the pressed button's value (a
 * disabled submitter would not be sent), then every button is disabled SYNCHRONOUSLY, before the browser builds the
 * entry list, so the pressed button is not sent a second time beside its hidden copy (a doubled `decision` field
 * parses as an array). A progress line replaces the buttons' promise. A second tap can no longer race the first. No network, no secrets, no server text.
 */
export const SUBMIT_ONCE_SCRIPT = `(function(){
document.addEventListener('submit',function(e){
 var f=e.target;if(!f||f.getAttribute('data-once')!=='1')return;
 if(f.getAttribute('data-sent')==='1'){e.preventDefault();return}
 f.setAttribute('data-sent','1');
 var s=e.submitter;if(s&&s.name){var h=document.createElement('input');h.type='hidden';h.name=s.name;h.value=s.value;f.appendChild(h)}
 var p=document.getElementById('progress');if(p)p.textContent='Working. Do not reload or tap again; this page updates when it is done.';
 var bs=f.querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].disabled=true;
});
})();`
