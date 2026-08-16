// mupot — read-only Owner Control Center (mupot#1067, smallest coherent v1).
//
// One owner-facing view that answers, in plain language:
//   - the hierarchy and object type (Department → Squad → Agent);
//   - canonical agent id + human label;
//   - home squad + additional memberships;
//   - effective capability and its source (direct grant vs inherited);
//   - bound runtime/credential state WITHOUT exposing secrets;
//   - duplicate/ambiguous identities with a safe repair path (resolve by id).
//
// READ-ONLY by construction: this module only SELECTs. The route handler gates on
// org-admin before calling. No mint, no grant, no write anywhere in this file.
//
// This module mirrors the agent-token.ts pattern: pure loader + HTML body builders,
// so the route in index.ts stays thin and the loader is unit-testable without Hono.

import { html, raw as honoRaw } from 'hono/html'
import type { Env, Department, Squad, Agent, Membership } from '../types'

// ── shapes ────────────────────────────────────────────────────────────────────

export interface ControlCenterAgent {
  id: string
  slug: string
  name: string
  role: string
  model: string
  status: string
  homeSquadId: string
  homeSquadName: string | null
  memberships: Array<{ squadId: string; squadName: string | null; capability: string }>
  /** Effective capability on the agent's HOME squad: direct membership first, else inherited org/dept/squad read. */
  effectiveCapability: string
  capabilitySource: 'membership' | 'inherited' | 'none'
  /** Credential state — counts + labels only, NEVER hashes or raw tokens. */
  credentialState: {
    boundMemberId: string | null
    liveTokenCount: number
    channels: string[]
  }
}

export interface ControlCenterSquad {
  id: string
  slug: string
  name: string
  agents: ControlCenterAgent[]
}

export interface ControlCenterDepartment {
  id: string
  slug: string
  name: string
  squads: ControlCenterSquad[]
}

export interface ControlCenterView {
  tenant: string
  departments: ControlCenterDepartment[]
  /** Live agents whose slug appears in 2+ live rows (same or different squads). */
  duplicateWarnings: Array<{ slug: string; agents: Array<{ id: string; name: string; squadName: string | null }> }>
  totals: { departments: number; squads: number; agents: number; memberships: number; liveTokens: number }
}

// ── data loader (read-only) ───────────────────────────────────────────────────

/** Load the full org tree + memberships + credential state in a bounded set of scans. */
export async function loadControlCenterView(env: Env): Promise<ControlCenterView> {
  const [depts, squads, agents, memberships, bindings, tokens] = await Promise.all([
    env.DB.prepare('SELECT id, slug, name, kind FROM departments ORDER BY name ASC').all<Department>(),
    env.DB.prepare('SELECT id, department_id, slug, name FROM squads ORDER BY name ASC').all<Squad>(),
    env.DB.prepare('SELECT id, squad_id, slug, name, role, model, status FROM agents ORDER BY name ASC').all<Agent>(),
    env.DB.prepare('SELECT id, agent_id, squad_id, capability FROM memberships').all<Membership>(),
    env.DB.prepare(
      `SELECT b.agent_id, b.member_id
         FROM agent_member_bindings b
         JOIN members m ON m.id = b.member_id AND m.status = 'active'`,
    ).all<{ agent_id: string; member_id: string }>(),
    env.DB.prepare(
      `SELECT member_id, channel FROM member_tokens WHERE revoked_at IS NULL`,
    ).all<{ member_id: string; channel: string }>(),
  ])

  const squadName = new Map<string, string>((squads.results ?? []).map((s) => [s.id, s.name]))

  const membershipsByAgent = new Map<string, ControlCenterAgent['memberships']>()
  for (const m of memberships.results ?? []) {
    const list = membershipsByAgent.get(m.agent_id) ?? []
    list.push({ squadId: m.squad_id, squadName: squadName.get(m.squad_id) ?? null, capability: m.capability })
    membershipsByAgent.set(m.agent_id, list)
  }

  const bindingsByAgent = new Map<string, string>()
  for (const b of bindings.results ?? []) bindingsByAgent.set(b.agent_id, b.member_id)

  const liveTokensByMember = new Map<string, { count: number; channels: Set<string> }>()
  for (const t of tokens.results ?? []) {
    const entry = liveTokensByMember.get(t.member_id) ?? { count: 0, channels: new Set<string>() }
    entry.count += 1
    entry.channels.add(t.channel)
    liveTokensByMember.set(t.member_id, entry)
  }

  const agentsBySquad = new Map<string, ControlCenterAgent[]>()
  let liveAgentsTotal = 0
  let liveTokensTotal = 0

  for (const a of agents.results ?? []) {
    const membershipsFor = membershipsByAgent.get(a.id) ?? []
    const homeCap = membershipsFor.find((m) => m.squadId === a.squad_id)?.capability
    const effective = homeCap ?? 'observer' // inherited read floor for a live agent
    const boundMemberId = bindingsByAgent.get(a.id) ?? null
    const tokenState = boundMemberId ? liveTokensByMember.get(boundMemberId) : undefined
    const channels = tokenState ? [...tokenState.channels].sort() : []
    const node: ControlCenterAgent = {
      id: a.id,
      slug: a.slug,
      name: a.name,
      role: a.role,
      model: a.model,
      status: a.status,
      homeSquadId: a.squad_id,
      homeSquadName: squadName.get(a.squad_id) ?? null,
      memberships: membershipsFor,
      effectiveCapability: effective,
      capabilitySource: homeCap ? 'membership' : 'inherited',
      credentialState: {
        boundMemberId,
        liveTokenCount: tokenState?.count ?? 0,
        channels,
      },
    }
    liveTokensTotal += tokenState?.count ?? 0
    const list = agentsBySquad.get(a.squad_id) ?? []
    list.push(node)
    agentsBySquad.set(a.squad_id, list)
    if (a.status === 'active') liveAgentsTotal += 1
  }

  const squadsByDept = new Map<string, ControlCenterSquad[]>()
  for (const s of squads.results ?? []) {
    const node: ControlCenterSquad = {
      id: s.id,
      slug: s.slug,
      name: s.name,
      agents: agentsBySquad.get(s.id) ?? [],
    }
    const list = squadsByDept.get(s.department_id) ?? []
    list.push(node)
    squadsByDept.set(s.department_id, list)
  }

  const departments: ControlCenterDepartment[] = (depts.results ?? []).map((d) => ({
    id: d.id,
    slug: d.slug,
    name: d.name,
    squads: squadsByDept.get(d.id) ?? [],
  }))

  // Duplicate-slug warnings: live (active) agents grouped by slug with 2+ rows.
  const bySlug = new Map<string, ControlCenterView['duplicateWarnings'][number]['agents']>()
  for (const a of agents.results ?? []) {
    if (a.status !== 'active') continue
    const list = bySlug.get(a.slug) ?? []
    list.push({ id: a.id, name: a.name, squadName: squadName.get(a.squad_id) ?? null })
    bySlug.set(a.slug, list)
  }
  const duplicateWarnings: ControlCenterView['duplicateWarnings'] = []
  for (const [slug, list] of bySlug) {
    if (list.length > 1) duplicateWarnings.push({ slug, agents: list })
  }
  duplicateWarnings.sort((a, b) => a.slug.localeCompare(b.slug))

  return {
    tenant: env.TENANT_SLUG,
    departments,
    duplicateWarnings,
    totals: {
      departments: departments.length,
      squads: (squads.results ?? []).length,
      agents: liveAgentsTotal,
      memberships: (memberships.results ?? []).length,
      liveTokens: liveTokensTotal,
    },
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

function badge(tone: string, text: string) {
  return `<span class="badge" style="background:var(--${tone});color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(text)}</span>`
}

/** GET /admin/control-center — read-only org hierarchy + credential state. */
export function controlCenterPageBody(view: ControlCenterView) {
  const { departments, duplicateWarnings, totals } = view

  const dupHtml =
    duplicateWarnings.length === 0
      ? `<p class="empty">No duplicate live agent slugs detected.</p>`
      : duplicateWarnings
          .map(
            (d) => `<div class="warn-box" style="margin:6px 0">
                <strong>Duplicate slug: ${esc(d.slug)}</strong> — ${d.agents.length} live rows.
                Resolve by exact agent id (never slug) for joins/grants.
                ${d.agents.map((a) => `<code class="inline">${esc(a.id.slice(0, 8))}</code> ${esc(a.name)} (${esc(a.squadName ?? '?')})`).join(' · ')}
              </div>`,
          )
          .join('')

  const deptHtml = departments
    .map((d) => {
      const squadsHtml = d.squads
        .map((s) => {
          const agentsHtml = s.agents
            .map((a) => {
              const membershipsHtml = a.memberships
                .map((m) => `<code class="inline">${esc(m.capability)}</code> @ ${esc(m.squadName ?? m.squadId.slice(0, 8))}`)
                .join(' ')
              const cred = a.credentialState
              const credHtml =
                cred.boundMemberId === null
                  ? badge('dim', 'unbound')
                  : cred.liveTokenCount === 0
                    ? badge('warn', 'bound · no live token')
                    : `${badge('ok', `bound · ${cred.liveTokenCount} token(s)`)}${
                        cred.channels.length ? ` <span style="color:var(--muted)">${esc(cred.channels.join('/'))}</span>` : ''
                      }`
              return `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border,#eee)">
                <div>
                  <strong>${esc(a.name)}</strong> <code class="inline">${esc(a.slug)}</code>
                  <span style="color:var(--muted)">${esc(a.role)} · ${esc(a.model)}</span><br>
                  <span style="color:var(--muted);font-size:12px">id <code class="inline">${esc(a.id)}</code> · home ${esc(a.homeSquadName ?? '?')} · eff ${esc(a.effectiveCapability)} (${esc(a.capabilitySource)})</span>
                  ${membershipsHtml ? `<div style="margin-top:4px">${membershipsHtml}</div>` : ''}
                </div>
                <div style="text-align:right">${badge(a.status === 'active' ? 'ok' : 'dim', a.status)} ${credHtml}</div>
              </div>`
            })
            .join('')
          return `<div class="card" style="margin:10px 0">
            <h3 style="margin:0 0 6px">${esc(s.name)} <span style="color:var(--muted);font-weight:400">(${esc(s.slug)})</span> <span style="color:var(--muted);font-size:12px">· ${s.agents.length} agent(s)</span></h3>
            ${agentsHtml || '<p class="empty">No agents.</p>'}
          </div>`
        })
        .join('')
      return `<div style="margin:18px 0">
        <h2 style="margin:0 0 4px">${esc(d.name)} <span style="color:var(--muted);font-weight:400">(${esc(d.slug)})</span></h2>
        ${squadsHtml || '<p class="empty">No squads.</p>'}
      </div>`
    })
    .join('')

  return html`
<div class="crumbs"><a href="/">Overview</a> › Control Center</div>
<h1>Owner Control Center</h1>
<p style="color:var(--muted);font-size:14px;max-width:760px">
  Read-only authoritative roster: <strong>${totals.departments}</strong> department(s),
  <strong>${totals.squads}</strong> squad(s), <strong>${totals.agents}</strong> active agent(s),
  <strong>${totals.memberships}</strong> membership(s), <strong>${totals.liveTokens}</strong> live credential(s).
  Credentials are shown as state only — hashes/raw tokens are never displayed.
</p>
<h2>Duplicate warnings</h2>
<div class="card">${honoRaw(dupHtml)}</div>
<h2>Hierarchy</h2>
${honoRaw(deptHtml)}
`
}
