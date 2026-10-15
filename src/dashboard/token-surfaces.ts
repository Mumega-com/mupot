// mupot#1566 — the three token-minting pages are one path, not three islands.
//
//   /enroll              connect an AGENT (seat key + paste-ready client config)
//   /admin/agent-token   connect an AGENT, admin form (same snippet, same outcome)
//   /admin/keys          YOUR OWN scoped API key (a human credential)
//
// This module is the only place that words that choice and renders the shared client snippet,
// so the pages cannot drift. Links are root-relative on purpose: the Worker entry re-roots every
// root-relative href under `/t/<slug>` at one choke point (src/platform/tenant-path.ts
// `withTenantPrefix` -> `applyTenantPrefix`); building a prefix here would double it.
//
// PRESENTATION ONLY. No authz lives here: who may mint is decided by each route.

import { html, raw as honoRaw } from 'hono/html'

export type TokenSurface = 'enroll' | 'agent-token' | 'keys'

const SURFACES: ReadonlyArray<{ id: TokenSurface; href: string; label: string; when: string }> = [
  { id: 'enroll', href: '/enroll', label: 'Enroll a seat', when: 'Connect an agent to this pot (pick an agent, get a key plus a paste-ready config).' },
  { id: 'agent-token', href: '/admin/agent-token', label: 'Mint an agent token', when: 'Connect an agent as an org admin, with grant and expiry controls.' },
  { id: 'keys', href: '/admin/keys', label: 'Scoped API keys', when: 'Your own API key, for you or a teammate to call the API directly (not an agent).' },
]

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Links to the other two surfaces, one line each saying when to use it. */
export function tokenSurfaceLinks(current: TokenSurface): string {
  const items = SURFACES.filter((s) => s.id !== current)
    .map((s) => `<li><a href="${s.href}">${escText(s.label)}</a> — ${escText(s.when)}</li>`)
    .join('')
  return `<div class="card" style="padding:14px 18px;margin-top:18px">
  <strong>Not the right page?</strong>
  <ul style="margin:8px 0 0;padding-left:18px;font-size:14px;color:var(--muted)">${items}</ul>
</div>`
}

/** The shared paste-ready client config card. `snippet` comes from enrollClientSnippet. */
export function connectSnippetCard(snippet: string, intro: string) {
  return html`<div class="card" style="margin-top:18px">
  <h2 style="margin-top:0">Paste-ready MCP config</h2>
  <p style="font-size:14px;color:var(--muted);margin:0 0 12px">${honoRaw(intro)}</p>
  <pre style="overflow:auto;font-size:13px" id="enrollSnippet">${honoRaw(escText(snippet))}</pre>
</div>`
}
