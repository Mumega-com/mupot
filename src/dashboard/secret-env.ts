// mupot — secret-env approval dashboard views (Task 5: "paste stays in mupot").
//
// Renders the admin-only "Secret env grants" section appended to GET /approvals,
// plus the bind/reject confirmation and error pages for the two POST routes in
// src/dashboard/index.ts.
//
// Custody (see src/secret-env/service.ts): this module NEVER renders a pasted
// secret value, in success or error output. Bind confirmations list binding
// NAMES only — the value itself is forwarded once to Cloudflare inside
// bindSecretEnv() and dropped before it ever reaches a response body, an audit
// row, or a log line.
//
// This is a SEPARATE admin-only section on /approvals (not the task_verdict
// queue rendered by approvalsBody/approvalCardHtml in ./index.ts) because paste
// fields cannot go through the generic verdict endpoint.

import { html, raw } from 'hono/html'
import type { PublicSecretEnvRequest } from '../secret-env/types'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Admin-only section appended to /approvals. Renders nothing when there is no
 * pending secret-env request — callers (GET /approvals) are responsible for
 * only fetching `requests` via listPendingSecretEnvRequests() when the caller
 * isOrgAdmin(); this function does not re-check the role itself.
 */
export function secretEnvApprovalsSection(requests: PublicSecretEnvRequest[]) {
  if (requests.length === 0) return html``
  const cards = requests.map((r) => secretEnvRequestCardHtml(r)).join('')
  return html`
    <h2>Secret env grants</h2>
    <p style="color:var(--muted);font-size:14px;max-width:640px">
      An agent proposed these environment keys without ever seeing a value. Paste each secret
      below to bind it directly onto this tenant's Worker — the paste is forwarded once to
      Cloudflare and dropped; it is never written to this pot's database or logs.
    </p>
    ${raw(`<div id="secret-env-list">${cards}</div>`)}`
}

function secretEnvRequestCardHtml(r: PublicSecretEnvRequest): string {
  const keyInputs = r.keys
    .map((k) => (
      `<label style="display:block;margin-bottom:10px">` +
      `<code>${esc(k.name)}</code> — <span class="muted">${esc(k.purpose)}</span><br>` +
      `<input type="password" name="secret__${esc(k.name)}" required autocomplete="new-password" ` +
      `style="font-family:monospace;width:100%;max-width:420px;margin-top:4px" ` +
      `placeholder="paste value for ${esc(k.name)}">` +
      `</label>`
    ))
    .join('')
  const adapterLabel = r.adapter_hint ? esc(r.adapter_hint) : 'Secret env request'
  const when = esc(r.created_at.slice(0, 16).replace('T', ' '))
  return `
    <div class="card" data-request="${esc(r.id)}" style="border-left:3px solid var(--warn)">
      <div class="appr-head">
        <div>
          <div class="appr-title">${adapterLabel}</div>
          <div class="appr-meta">${esc(r.requested_by)} · ${when}</div>
        </div>
      </div>
      <div class="appr-body">${esc(r.reason)}</div>
      <form method="post" action="/admin/secret-env/${esc(r.id)}/bind" style="margin-top:10px">
        ${keyInputs}
        <button class="btn" type="submit">Approve &amp; bind</button>
      </form>
      <form method="post" action="/admin/secret-env/${esc(r.id)}/reject" style="margin-top:8px">
        <button class="btn secondary sm" type="submit">Reject</button>
      </form>
    </div>`
}

/** Show-once bind confirmation — binding NAMES only, never the pasted value. */
export function secretEnvBoundBody(requestId: string, bound: readonly string[]) {
  const names = bound.map((n) => `<li><code>${esc(n)}</code></li>`).join('')
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/approvals">Approvals</a> › Secret env bound</div>
<h1>Secret env bound</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Request <code>${esc(requestId)}</code> — the binding names below are now live on this
    tenant's Worker. The pasted values were forwarded to Cloudflare and dropped; they are not
    shown here and are never stored in this pot's database.
  </p>
  <ul>${raw(names)}</ul>
  <div style="margin-top:14px"><a href="/approvals" class="btn secondary sm">Back to approvals</a></div>
</div>`
}

/** Rejection confirmation. No CF calls happen on this path (see rejectSecretEnv). */
export function secretEnvRejectedBody(requestId: string) {
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/approvals">Approvals</a> › Secret env rejected</div>
<h1>Secret env request rejected</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Request <code>${esc(requestId)}</code> was rejected. Its pending binding names are marked
    revoked; no Cloudflare call was made.
  </p>
  <div style="margin-top:14px"><a href="/approvals" class="btn secondary sm">Back to approvals</a></div>
</div>`
}

/** Error page for a failed bind/reject. The message is a service error code
 * (e.g. 'request_not_pending', 'missing_value_for_FOO') — never a paste value. */
export function secretEnvErrorBody(message: string) {
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/approvals">Approvals</a> › Error</div>
<h1>Secret env action failed</h1>
<div class="card"><p class="empty">${esc(message)}</p></div>
<p><a href="/approvals">← Back to approvals</a></p>`
}
