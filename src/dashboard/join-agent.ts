// mupot — "Add existing agent" join preview/confirm (mupot#1067, smallest v1).
//
// The squad page already lets an owner CREATE a new agent. This module adds the
// REUSE path: resolve an EXISTING agent by exact id (or unique slug — fail-closed
// on ambiguity), PREVIEW home squad + current memberships + the capability to be
// granted, then CONFIRM via the shared setAgentSquadAccess service. It NEVER
// creates a duplicate agent and NEVER mints/rotates/revokes credentials.
//
// Read-only preview + one confirm write, both gated on admin-of-target-squad by
// the route handlers (mirrors POST /agents/:id/memberships in src/org/index.ts).
//
// This module mirrors the agent-token.ts pattern: pure loader + HTML bodies, so
// routes stay thin and the logic is unit-testable without Hono.

import { html, raw as honoRaw } from 'hono/html'
import type { Env, Squad, Membership } from '../types'
import { resolveAgentRef } from '../org/resolve'
import { resolveAgentMemberBinding } from '../members/service'
import { setAgentSquadAccess, isAgentAccessCapability } from '../members/agent-access'
import type { AgentAccessCapability } from '../members/agent-access'

// ── shapes ────────────────────────────────────────────────────────────────────

export interface JoinPreviewAgent {
  id: string
  slug: string
  name: string
  role: string
  model: string
  status: string
  homeSquadId: string
  homeSquadName: string | null
  memberships: Array<{ squadId: string; squadName: string | null; capability: string }>
  alreadyMemberOfTarget: boolean
  currentTargetCapability: string | null
  bound: boolean
}

export interface JoinPreviewResult {
  ok: boolean
  error?: 'ambiguous' | 'not_found' | 'invalid_ref'
  agent?: JoinPreviewAgent
}

/** Full agent row shape (resolveAgentRef returns a minimal projection). */
interface JoinAgentRow {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  model: string
  status: string
}

export const JOIN_CAPABILITIES: AgentAccessCapability[] = ['observer', 'member', 'lead', 'admin']

// ── loaders ───────────────────────────────────────────────────────────────────

/** Resolve an existing agent by id or UNIQUE slug; refuse ambiguous slugs. */
export async function loadJoinPreview(env: Env, squad: Squad, ref: string): Promise<JoinPreviewResult> {
  const trimmed = (ref ?? '').trim()
  if (!trimmed) return { ok: false, error: 'invalid_ref' }

  const resolved = await resolveAgentRef(env, trimmed)
  if (!resolved.ok) return { ok: false, error: resolved.reason === 'ambiguous' ? 'ambiguous' : 'not_found' }
  const resolvedRow = resolved.value

  // Fetch the FULL agent row (resolveAgentRef returns a minimal projection) so the
  // preview can show role/model/status without guessing.
  const agentRow = await env.DB.prepare(
    'SELECT id, squad_id, slug, name, role, model, status FROM agents WHERE id = ?',
  ).bind(resolvedRow.id).first<JoinAgentRow>()
  if (!agentRow) return { ok: false, error: 'not_found' }
  const agent = agentRow

  const [squadNameRows, membershipRows, binding] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM squads').all<{ id: string; name: string }>(),
    env.DB.prepare('SELECT id, agent_id, squad_id, capability FROM memberships WHERE agent_id = ?')
      .bind(agent.id)
      .all<Membership>(),
    resolveAgentMemberBinding(env, agent.id),
  ])

  const squadName = new Map(squadNameRows.results?.map((s) => [s.id, s.name]) ?? [])
  const memberships = (membershipRows.results ?? []).map((m) => ({
    squadId: m.squad_id,
    squadName: squadName.get(m.squad_id) ?? null,
    capability: m.capability,
  }))
  const target = memberships.find((m) => m.squadId === squad.id)

  return {
    ok: true,
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      model: agent.model,
      status: agent.status,
      homeSquadId: agent.squad_id,
      homeSquadName: squadName.get(agent.squad_id) ?? null,
      memberships,
      alreadyMemberOfTarget: Boolean(target),
      currentTargetCapability: target?.capability ?? null,
      bound: binding.kind === 'bound',
    },
  }
}

/** Confirm the join: reuse setAgentSquadAccess (idempotent — no duplicate, no mint). */
export async function confirmJoin(
  env: Env,
  squad: Squad,
  agentId: string,
  capability: string,
): Promise<{ ok: true; result: 'created' | 'updated' | 'unchanged'; membership: Membership; grant: unknown }
  | { ok: false; error: string }> {
  const cap = (capability || 'member') as AgentAccessCapability
  if (!isAgentAccessCapability(cap)) return { ok: false, error: 'invalid_capability' }

  const binding = await resolveAgentMemberBinding(env, agentId)
  if (binding.kind !== 'bound') return { ok: false, error: 'agent_identity_unminted' }

  const outcome = await setAgentSquadAccess(env, {
    agentId,
    memberId: binding.memberId,
    squadId: squad.id,
    capability: cap,
  })
  if (!outcome.ok) return { ok: false, error: outcome.error }
  // setAgentSquadAccess can return 'removed' in general, but a join never removes —
  // treat it as unchanged for the UI (defensive; the service is the arbiter).
  const result: 'created' | 'updated' | 'unchanged' =
    outcome.result === 'removed' ? 'unchanged' : outcome.result
  return {
    ok: true,
    result,
    membership: outcome.membership,
    grant: outcome.grant,
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const CAP_OPTIONS = JOIN_CAPABILITIES.map((c) => `<option value="${c}">${c}</option>`).join('')

/** GET /squads/:id/agents/join?ref=... — preview page. */
export function joinPreviewPageBody(squad: Squad, ref: string, result: JoinPreviewResult) {
  const errorHtml =
    result.ok || !result.error
      ? ''
      : result.error === 'ambiguous'
        ? `<div class="warn-box"><strong>Ambiguous slug.</strong> More than one live agent matches "${esc(ref)}". Resolve by the exact agent id instead.</div>`
        : `<div class="warn-box"><strong>Not found.</strong> No active agent matches "${esc(ref)}".</div>`

  if (!result.ok || !result.agent) {
    return html`<div class="crumbs"><a href="/">Overview</a> › <a href="/squads/${squad.id}">${esc(squad.name)}</a> › Add existing agent</div>
      <h1>Add existing agent · ${esc(squad.name)}</h1>
      ${honoRaw(errorHtml)}
      <div class="card">
        <form method="get" action="/squads/${squad.id}/agents/join" autocomplete="off">
          <label>Agent id or unique slug
            <input name="ref" required placeholder="cyrus-prime or 5498e2bb-…" value="${esc(ref)}" style="width:100%;margin-top:6px"/>
          </label>
          <button type="submit" class="btn" style="margin-top:10px">Preview</button>
        </form>
      </div>`
  }

  const a = result.agent
  const membershipRows = a.memberships
    .map((m) => `<li><code class="inline">${esc(m.capability)}</code> @ ${esc(m.squadName ?? m.squadId.slice(0, 8))}</li>`)
    .join('')
  const already = a.alreadyMemberOfTarget
    ? `<div class="warn-box" style="margin:8px 0"><strong>Already a member</strong> of this squad (${esc(a.currentTargetCapability ?? '?')}). Confirm to update the capability (idempotent).</div>`
    : ''
  const unbound = a.bound
    ? ''
    : `<div class="warn-box" style="margin:8px 0"><strong>Identity not minted.</strong> This agent has no welded member identity; join will fail with agent_identity_unminted. Mint an agent-bound token first (separate step — join never mints).</div>`

  return html`<div class="crumbs"><a href="/">Overview</a> › <a href="/squads/${squad.id}">${esc(squad.name)}</a> › Add existing agent</div>
    <h1>Add existing agent · ${esc(squad.name)}</h1>
    ${honoRaw(already)}
    ${honoRaw(unbound)}
    <div class="card">
      <dl class="kv">
        <dt>Name</dt><dd>${esc(a.name)}</dd>
        <dt>Slug</dt><dd><code class="inline">${esc(a.slug)}</code></dd>
        <dt>Agent id</dt><dd><code class="inline">${esc(a.id)}</code></dd>
        <dt>Role / model</dt><dd>${esc(a.role)} · ${esc(a.model)}</dd>
        <dt>Status</dt><dd>${esc(a.status)}</dd>
        <dt>Home squad</dt><dd>${esc(a.homeSquadName ?? '?')} <span style="color:var(--muted)">(${esc(a.homeSquadId.slice(0, 8))})</span></dd>
        <dt>Memberships</dt><dd>${a.memberships.length ? `<ul style="margin:4px 0">${honoRaw(membershipRows)}</ul>` : '<span style="color:var(--muted)">none</span>'}</dd>
        <dt>Identity</dt><dd>${a.bound ? 'bound (minted)' : '<strong style="color:#b45309">unminted</strong>'}</dd>
      </dl>
      <form method="post" action="/squads/${squad.id}/agents/join" autocomplete="off" style="margin-top:12px">
        <input type="hidden" name="agent_id" value="${esc(a.id)}" />
        <label>Capability to grant on ${esc(squad.name)}
          <select name="capability" style="margin-top:6px">${honoRaw(CAP_OPTIONS)}</select>
        </label>
        <div style="margin-top:12px">
          <button type="submit" class="btn">${a.alreadyMemberOfTarget ? 'Update membership' : 'Add to squad'}</button>
          <a class="btn secondary" href="/squads/${squad.id}">Cancel</a>
        </div>
      </form>
    </div>`
}

/** POST /squads/:id/agents/join — confirm result page (POST-redirect-GET friendly). */
export function joinConfirmedBody(squad: Squad, agentName: string, result: 'created' | 'updated' | 'unchanged', capability: string) {
  const verb = result === 'created' ? 'added to' : result === 'updated' ? 'updated on' : 'already a member of'
  return html`<div class="crumbs"><a href="/">Overview</a> › <a href="/squads/${squad.id}">${esc(squad.name)}</a></div>
    <h1>Membership confirmed</h1>
    <div class="card">
      <p><strong>${esc(agentName)}</strong> ${verb} <strong>${esc(squad.name)}</strong> with capability
      <code class="inline">${esc(capability)}</code> (result: ${esc(result)}). No credential was minted.</p>
      <a class="btn" href="/squads/${squad.id}">Back to squad</a>
    </div>`
}
