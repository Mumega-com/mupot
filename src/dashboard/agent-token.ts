// mupot — agent-bound token mint dashboard (POST /admin/agent-token/mint).
//
// An AGENT-BOUND token is different from an operator/human token:
//   - It mints a DEDICATED member envelope (no email, no IM) for the agent.
//   - The escalation guard is hard-coded: squad-scoped observer/member on the
//     agent's OWN squad — never org/dept, never above member.
//   - The token row's agent_id = the agent's id (the weld).  The /attach endpoint
//     requires token.boundAgentId === agent_id; an operator token (agent_id NULL)
//     fails that check.
//
// This module exposes:
//   loadAgentTokenView(env)   → { agents: AgentOptionRow[] }
//   agentTokenPageBody(...)   → HTML (GET /admin/agent-token)
//   agentTokenMintedBody(...) → HTML (show-once after POST /admin/agent-token/mint)
//
// The route handlers live in src/dashboard/index.ts — they call these helpers and
// the shared mintAgentBoundToken from src/members/service.ts.
// The MCP mint_agent_token tool calls the same mintAgentBoundToken — single mint path.
//
// Security invariants:
//   1. isAdmin gate is checked in the route BEFORE calling mintAgentBoundToken.
//   2. agent is validated against this pot's own agents table (not a free-form string).
//   3. Raw token returned ONCE; never logged, redirected, or stored in plain text.
//   4. CSRF middleware covers the POST (applied dashboard-wide in index.ts).

import { html, raw as honoRaw } from 'hono/html'
import type { Env } from '../types'

// ── shapes ────────────────────────────────────────────────────────────────────

export interface AgentOptionRow {
  id: string
  slug: string
  name: string
  squad_id: string
  squad_name: string | null
}

export interface AgentTokenView {
  agents: AgentOptionRow[]
}

// ── data loader ───────────────────────────────────────────────────────────────

/**
 * Load all active agents in this pot, joined to their squad name for display.
 * Source of truth = the pot's own `agents` table (validated, tenant-scoped D1).
 */
export async function loadAgentTokenView(env: Env): Promise<AgentTokenView> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.slug, a.name, a.squad_id, s.name AS squad_name
       FROM agents a
       LEFT JOIN squads s ON s.id = a.squad_id
      WHERE a.status = 'active'
      ORDER BY s.name ASC, a.name ASC`,
  ).all<AgentOptionRow>()
  return { agents: rows.results ?? [] }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** GET /admin/agent-token — the agent picker form. */
export function agentTokenPageBody(view: AgentTokenView, error?: string) {
  const { agents } = view

  const agentOptions =
    agents.length === 0
      ? `<option value="">— no active agents in this pot —</option>`
      : agents
          .map(
            (a) =>
              `<option value="${esc(a.id)}">` +
              `${a.squad_name ? esc(a.squad_name) + ' / ' : ''}${esc(a.name)} (${esc(a.slug)})` +
              `</option>`,
          )
          .join('')

  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/members">Access Tokens</a> › Mint agent token</div>
<h1>Mint agent token</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px;margin-bottom:20px">
  An <strong>agent-bound</strong> token is wired to a specific agent. It is the credential
  the agent runtime pastes into its workspace config. Unlike an operator token (which has
  <em>no</em> agent binding), an agent-bound token is required by the
  <code class="inline">/attach</code> endpoint and carries only a hard-capped
  squad-scoped <code class="inline">observer</code> or <code class="inline">member</code>
  grant — it can never inherit your org-admin standing.
</p>

${honoRaw(errorHtml)}

<div class="card">
  <div class="warn-box" style="margin-bottom:16px">
    <strong>Show once only.</strong> Copy the token immediately after minting — it cannot be retrieved again.
    Place it at <code class="inline">~/.fleet/agents/&lt;agent&gt;.token</code> on the host.
    Never paste it in chat or logs.
  </div>
  <form method="post" action="/admin/agent-token/mint" autocomplete="off">
    <div class="adminform" style="flex-direction:column;align-items:stretch">
      <label>
        Agent
        <select name="agent_id" required>
          <option value="">— choose an agent —</option>
          ${honoRaw(agentOptions)}
        </select>
      </label>
      <label style="margin-top:10px">
        Label <span style="font-size:12px;color:var(--muted)">(optional — max 64 chars)</span>
        <input name="label" placeholder="e.g. main-host" maxlength="64" style="min-width:200px" />
      </label>
      <label style="margin-top:10px">
        Squad grant
        <select name="capability">
          <option value="member">Member — can write squad tasks, broadcast, and shared memory</option>
          <option value="observer">Observer — can read roster/shared memory, inbox, and private memory</option>
        </select>
      </label>
      <div style="margin-top:16px">
        <button class="btn" type="submit">Mint agent token</button>
        <a href="/members" class="btn secondary sm" style="margin-left:10px">Cancel</a>
      </div>
    </div>
  </form>
</div>

<h2 style="margin-top:32px">See also</h2>
<div class="card" style="padding:14px 18px">
  <p style="margin:0;font-size:14px;color:var(--muted)">
    <strong>Operator tokens</strong> (NULL-bound, for humans) are provisioned under
    <a href="/members">Access Tokens</a>. Use this page only for agent runtimes.
  </p>
</div>`
}

/** Show-once page after a successful agent-bound mint. */
export function agentTokenMintedBody(
  agentName: string,
  agentSlug: string,
  squadName: string | null,
  raw: string,
  tokenId: string,
  capability: string,
) {
  const scopeLabel = squadName ? `${squadName} / ${agentName}` : agentName
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/members">Access Tokens</a> › <a href="/admin/agent-token">Mint agent token</a> › Token minted</div>
<h1>Agent token minted</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Bound to <strong>${scopeLabel}</strong> (slug: <code class="inline">${agentSlug}</code>) ·
    Token ID: <code class="inline">${tokenId}</code> ·
    Squad grant: <code class="inline">${capability}</code>
  </p>
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Shown once only.</strong> Copy this token now — it cannot be retrieved again.
    Place it at <code class="inline">~/.fleet/agents/${agentSlug}.token</code> on the host.
    Never paste it in chat, bus messages, or version control.
  </div>
  <code class="token" id="rawToken">${raw}</code>
  <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
    <button class="btn secondary sm" onclick="copyToken()">Copy</button>
    <a href="/admin/agent-token" class="btn secondary sm">Mint another</a>
    <a href="/members" class="btn secondary sm">Done</a>
    <span id="copyFeedback" style="font-size:13px;color:var(--ok);display:none">Copied!</span>
  </div>
</div>
<script>
  function copyToken() {
    const text = document.getElementById('rawToken').textContent.trim();
    navigator.clipboard.writeText(text).then(function() {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline';
      setTimeout(function() { fb.style.display = 'none'; }, 2000);
    });
  }
</script>`
}
