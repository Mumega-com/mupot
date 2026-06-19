// mupot — connector dashboard views (issue #116).
//
// Exposes:
//   connectorsPageBody(rows, error?)    → HTML for GET /admin/connectors
//   connectorAddedBody(connector, hint) → Show-once add confirmation (no secret)
//   connectorRotatedBody(connector, hint) → Show-once rotate confirmation
//
// Security: these views NEVER render the encrypted_secret or the raw secret.
// The hint (last-4) is passed in from the service result and shown once on
// add/rotate; it is NOT shown on the list view.

import { html, raw } from 'hono/html'
import type { ConnectorListRow } from './service'
import type { ConnectorType } from './crypto'

const TYPE_LABELS: Record<ConnectorType, string> = {
  telegram:  'Telegram',
  instantly: 'Instantly',
  ghl:       'GoHighLevel',
  apify:     'Apify',
  mcpwp:      'MCPWP',
  inkwell:    'Inkwell',
  github_app: 'GitHub App',
  posthog:               'PostHog',
  google_search_console: 'Google Search Console',
  google_ads:            'Google Ads',
  facebook_ads:          'Facebook Ads',
  crm:                   'CRM',
  custom:     'Custom',
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** GET /admin/connectors — list view */
export function connectorsPageBody(
  rows: ConnectorListRow[],
  error?: string,
) {
  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  const connectorRows =
    rows.length === 0
      ? `<tr><td colspan="5" class="empty">No active credentials yet.</td></tr>`
      : rows
          .map((r) => {
            const typeLabel = TYPE_LABELS[r.type] ?? r.type
            const scopeLabel =
              r.scope_type === 'pot'
                ? 'Organization-wide'
                : `${esc(r.scope_type === 'squad' ? 'team' : r.scope_type)}: ${esc(r.scope_id ?? '—')}`
            return (
              `<tr>` +
              `<td><span class="tag">${esc(typeLabel)}</span></td>` +
              `<td>${esc(r.label)}</td>` +
              `<td class="muted">${esc(scopeLabel)}</td>` +
              `<td class="muted">${esc(r.created_at.slice(0, 10))}</td>` +
              `<td class="actions" style="display:flex;gap:6px;flex-wrap:wrap">` +
              // Rotate: re-encrypt with a new secret
              `<form method="post" action="/admin/connectors/${esc(r.id)}/rotate" style="display:flex;gap:6px;align-items:center">` +
              `<input type="password" name="new_secret" placeholder="new secret" required autocomplete="new-password" ` +
              `style="font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);width:160px">` +
              `<button class="btn sm secondary" type="submit">Rotate</button>` +
              `</form>` +
              // Revoke
              `<form method="post" action="/admin/connectors/${esc(r.id)}/revoke" style="display:inline">` +
              `<button class="btn sm secondary" type="submit" onclick="return confirm('Revoke credential \\'${esc(r.label)}\\'?')">Revoke</button>` +
              `</form>` +
              `</td>` +
              `</tr>`
            )
          })
          .join('')

  const typeOptions = (Object.entries(TYPE_LABELS) as [ConnectorType, string][])
    .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)
    .join('')

  return html`
<div class="crumbs"><a href="/">Overview</a> › Connector Credentials</div>
<h1>Connector Credentials</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px">
  Tool access credentials (Telegram bot tokens, Instantly keys, GHL, custom) stored <strong>encrypted at rest</strong>.
  The raw secret is shown <strong>once on provision/rotate</strong>, then discarded — never stored plaintext, never returned
  by the list. AI agents receive credentials at call-time via <code>resolveConnector()</code>; the plaintext is never logged.
</p>

${raw(errorHtml)}

<h2>Provision credential</h2>
<div class="card">
  <form method="post" action="/admin/connectors">
    <div class="adminform" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:end">
        <label>
          Type
          <select name="type" required>
            <option value="">— choose type —</option>
            ${raw(typeOptions)}
          </select>
        </label>
        <label>
          Label
          <input type="text" name="label" placeholder="e.g. Acme Telegram bot" required maxlength="120">
        </label>
        <label>
          Secret / Token
          <input type="password" name="secret" required autocomplete="new-password" placeholder="paste secret here">
        </label>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:end;margin-top:12px">
        <label>
          Scope
          <select name="scope_type" id="scopeTypeSelect" onchange="updateScopeId(this.value)">
            <option value="pot">Organization-wide</option>
            <option value="squad">Team</option>
            <option value="agent">AI Agent</option>
          </select>
        </label>
        <label id="scopeIdLabel" style="display:none">
          Scope ID (UUID)
          <input type="text" name="scope_id" id="scopeIdInput" placeholder="team or agent UUID" pattern="[0-9a-f-]{36}">
        </label>
      </div>
      <div style="margin-top:12px">
        <label>
          Meta (JSON, optional — e.g. Telegram: <code>["chat_id_1","chat_id_2"]</code> allowed_chats)
          <input type="text" name="meta" placeholder='["123456789"]' style="font-family:monospace;width:100%">
        </label>
      </div>
      <div style="margin-top:16px">
        <button class="btn" type="submit">Provision credential</button>
        <span style="font-size:13px;color:var(--muted);margin-left:12px">
          The secret is encrypted immediately and shown once — then gone.
        </span>
      </div>
    </div>
  </form>
</div>

<h2>Active credentials</h2>
<div class="card" style="padding:0;overflow:hidden">
  <table class="grid">
    <thead><tr>
      <th>Type</th><th>Label</th><th>Scope</th><th>Added</th><th>Actions</th>
    </tr></thead>
    <tbody>${raw(connectorRows)}</tbody>
  </table>
</div>

<p style="font-size:12px;color:var(--dim);margin-top:8px">
  Hint: the last-4 of the secret is shown once on add/rotate and is not stored or shown here.
  Use Rotate to update a secret; use Revoke to permanently disable it.
</p>

<script>
  function updateScopeId(scopeType) {
    const label = document.getElementById('scopeIdLabel');
    const input = document.getElementById('scopeIdInput');
    if (scopeType === 'pot') {
      label.style.display = 'none';
      input.removeAttribute('required');
    } else {
      label.style.display = '';
      input.setAttribute('required', '');
    }
  }
</script>`
}

/** Show-once confirmation after adding a connector (hint shown here and nowhere else). */
export function connectorAddedBody(
  type: ConnectorType,
  label: string,
  hint: string,
  connectorId: string,
) {
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/admin/connectors">Connector Credentials</a> › Provisioned</div>
<h1>Credential provisioned</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    <strong>${esc(TYPE_LABELS[type] ?? type)}</strong> — ${esc(label)}
  </p>
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Write-only.</strong> The secret is encrypted and stored. The hint below is derived from the last 4 characters
    of the secret you entered. The full secret is not stored and cannot be retrieved — use Rotate to replace it.
  </div>
  <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-family:monospace">
    ID: ${esc(connectorId)}<br>
    Hint (last 4): <strong>…${esc(hint)}</strong>
  </div>
  <div style="margin-top:14px">
    <a href="/admin/connectors" class="btn secondary sm">Back to credentials</a>
  </div>
</div>`
}

/** Show-once confirmation after rotating a connector secret. */
export function connectorRotatedBody(
  type: ConnectorType,
  label: string,
  hint: string,
  connectorId: string,
) {
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/admin/connectors">Connector Credentials</a> › Rotated</div>
<h1>Secret rotated</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    <strong>${esc(TYPE_LABELS[type] ?? type)}</strong> — ${esc(label)}
  </p>
  <div class="ok-box" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:14px">
    <strong>Rotated.</strong> The old ciphertext has been overwritten. The new secret is encrypted at rest.
  </div>
  <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-family:monospace">
    ID: ${esc(connectorId)}<br>
    New hint (last 4): <strong>…${esc(hint)}</strong>
  </div>
  <div style="margin-top:14px">
    <a href="/admin/connectors" class="btn secondary sm">Back to credentials</a>
  </div>
</div>`
}
