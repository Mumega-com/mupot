// /agents/kayhermes — owner chat panel that proxies Hermes Sessions API.
// PURE PRESENTATION for the body; status is pre-loaded by the route.

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import { emptyState, pageHeader, sectionPanel } from './ui'
import type { Html } from './ui'
import type { KayhermesSession } from '../kayhermes/client'

export interface KayhermesPageStatus {
  configured: boolean
  healthy: boolean | null
  sessions: KayhermesSession[]
  error: string | null
}

export function kayhermesBody(env: Env, status: KayhermesPageStatus): Html {
  void env
  if (!status.configured) {
    return html`
      ${pageHeader({
        crumbs: 'Fleet / KayHermes',
        title: 'KayHermes chat',
        sub: 'Talk to the Hermes runtime that only lives on Mupot.',
      })}
      ${emptyState({
        title: 'Not configured',
        detail:
          'Set KAYHERMES_API_URL (public HTTPS tunnel to the kayhermes API server) and KAYHERMES_API_KEY (wrangler secret put). See agents/kayhermes/ENABLE-CHAT.md.',
      })}`
  }

  const errBanner = status.error
    ? html`<p class="ui-sub" style="color:var(--danger)">${status.error}</p>`
    : status.healthy === false
      ? html`<p class="ui-sub" style="color:var(--warn)">Upstream health check failed — chat may not work until the kayhermes API server is reachable.</p>`
      : ''

  const sessionRows =
    status.sessions.length === 0
      ? html`<p class="ui-sub">No sessions yet. Start a new chat.</p>`
      : html`<ul id="kh-session-list" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">
          ${status.sessions.map(
            (s) => html`<li>
              <button type="button" class="btn sm kh-session" data-sid="${s.id}" style="width:100%;text-align:left">
                ${s.title ?? s.id}
                ${s.source ? html` · ${s.source}` : ''}
              </button>
            </li>`,
          )}
        </ul>`

  const chatScript = raw(`<script>
(function () {
  var log = document.getElementById('kh-log');
  var input = document.getElementById('kh-input');
  var sendBtn = document.getElementById('kh-send');
  var newBtn = document.getElementById('kh-new');
  var sidEl = document.getElementById('kh-sid');
  var sid = null;

  function append(role, text) {
    var row = document.createElement('div');
    row.style.margin = '0 0 8px';
    row.style.whiteSpace = 'pre-wrap';
    row.style.fontFamily = 'var(--font-mono)';
    row.style.fontSize = '13px';
    if (role === 'user') row.style.color = 'var(--text)';
    else if (role === 'error') row.style.color = 'var(--danger)';
    else row.style.color = 'var(--primary)';
    row.textContent = (role === 'user' ? 'you · ' : role === 'error' ? 'err · ' : 'kay · ') + text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function setSid(next) {
    sid = next;
    sidEl.textContent = next ? ('session ' + next) : 'no session';
  }

  async function loadMessages(id) {
    log.innerHTML = '';
    var res = await fetch('/api/kayhermes/sessions/' + encodeURIComponent(id) + '/messages', {
      credentials: 'same-origin',
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      append('error', data.detail || data.error || ('HTTP ' + res.status));
      return;
    }
    (data.messages || []).forEach(function (m) {
      append(m.role === 'user' || m.role === 'human' ? 'user' : 'assistant', m.content || '');
    });
  }

  document.querySelectorAll('.kh-session').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-sid');
      if (!id) return;
      setSid(id);
      loadMessages(id);
    });
  });

  if (newBtn) {
    newBtn.addEventListener('click', async function () {
      newBtn.disabled = true;
      try {
        var res = await fetch('/api/kayhermes/sessions', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'mupot-console' }),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          append('error', data.detail || data.error || ('HTTP ' + res.status));
          return;
        }
        var id = data.session && data.session.id;
        if (!id) {
          append('error', 'create returned no session id');
          return;
        }
        setSid(id);
        log.innerHTML = '';
        append('assistant', '(new session)');
        location.reload();
      } finally {
        newBtn.disabled = false;
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', async function () {
      var text = (input.value || '').trim();
      if (!text) return;
      if (!sid) {
        append('error', 'pick or create a session first');
        return;
      }
      sendBtn.disabled = true;
      append('user', text);
      input.value = '';
      try {
        var res = await fetch('/api/kayhermes/sessions/' + encodeURIComponent(sid) + '/chat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: text }),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          append('error', data.detail || data.error || ('HTTP ' + res.status));
          return;
        }
        append('assistant', data.reply || '(no reply)');
      } catch (e) {
        append('error', 'request failed');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    });
  }

  if (input) {
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendBtn.click();
      }
    });
  }
})();
</script>`)

  return html`
    ${pageHeader({
      crumbs: 'Fleet / KayHermes',
      title: 'KayHermes chat',
      sub: 'Hermes sessions via the API server (same pattern as Open WebUI).',
      badge: status.healthy ? 'live' : 'degraded',
      badgeTone: status.healthy ? 'ok' : 'warn',
    })}
    ${errBanner}
    <div style="display:grid;grid-template-columns:minmax(180px,240px) 1fr;gap:16px;align-items:start">
      ${sectionPanel({
        title: 'Sessions',
        right: html`<button type="button" class="btn sm" id="kh-new">New</button>`,
        body: sessionRows,
      })}
      ${sectionPanel({
        title: 'Chat',
        right: html`<span class="ui-sub" id="kh-sid">no session</span>`,
        body: html`
          <div id="kh-log" style="min-height:220px;max-height:480px;overflow-y:auto;margin-bottom:12px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface)"></div>
          <div style="display:flex;gap:8px">
            <input id="kh-input" type="text" style="flex:1" placeholder="Message KayHermes…" maxlength="8000" />
            <button type="button" class="btn" id="kh-send">Send</button>
          </div>`,
      })}
    </div>
    ${chatScript}`
}
