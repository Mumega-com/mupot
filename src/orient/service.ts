// orient/service — the agent basin-drop (digid-hybrid S1).
//
// orient answers, for any agent on any harness: who am I, my exact scope + magnitude,
// my chain of command, my tools, the rails, and my live field state (coherence/trust/
// spin). It is anti-hallucination grounding — it tells the agent what is TRUE so it does
// not assume, start from scratch, or ignore tools it already has. The brief is DIRECTIVE
// (a basin-drop), not a status report. See the design spec (2026-06-09-digid-hybrid-orient).
//
// Structural half = read from the pot's own D1 (org/squad/tasks/capability).
// Field half      = read from agent_field, a MIRROR the mind pushes inbound. The pot never
//                   egresses; if the mind hasn't pushed (or is asleep), the field half is
//                   absent/stale and the brief degrades gracefully — it never errors.
//
// The pure renderers + derivations are exported for tests; the DB reads are thin.

import type { Env } from '../types'

const STALE_MS = 60 * 60 * 1000 // field older than 1h → flag "mind may be asleep"
const INDUCTION_RATE_MS = 2000 // min gap between orientation writes (write-amplification cap, #88)

// ── field half (pure) ──────────────────────────────────────────────────────────

export interface AgentFieldRow {
  coherence: number | null
  regime: string | null
  trust_tier: string | null
  trust_score: number | null
  spin: string | null // JSON string as stored
  field_updated_at: number
  source?: string | null // 'mind' | 'pot_fallback' (migration 0020; absent on old rows = mind)
}

export interface FieldHalf {
  present: boolean
  stale: boolean
  coherence: number | null
  regime: string | null
  trust_tier: string | null
  trust_score: number | null
  spin: Record<string, unknown> | null
  age_human: string | null
  source: 'mind' | 'pot_fallback' // who measured it (0020); old/absent rows = mind
}

function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function fieldHalf(row: AgentFieldRow | null, nowMs: number, staleMs = STALE_MS): FieldHalf {
  if (!row) {
    return { present: false, stale: false, coherence: null, regime: null, trust_tier: null, trust_score: null, spin: null, age_human: null, source: 'mind' }
  }
  let spin: Record<string, unknown> | null = null
  if (row.spin) {
    try {
      const parsed = JSON.parse(row.spin)
      if (parsed && typeof parsed === 'object') spin = parsed as Record<string, unknown>
    } catch {
      spin = null // bad JSON from the mind → omit, never throw
    }
  }
  const age = nowMs - row.field_updated_at
  return {
    present: true,
    stale: age > staleMs,
    coherence: row.coherence,
    regime: row.regime,
    trust_tier: row.trust_tier,
    trust_score: row.trust_score,
    spin,
    age_human: humanAge(age),
    source: row.source === 'pot_fallback' ? 'pot_fallback' : 'mind',
  }
}

// ── chain of command (pure) ──────────────────────────────────────────────────────

export interface SquadMember {
  agent_id: string
  name: string
  role: string
  capability: string // owner | lead | member | observer
}

const CAP_RANK: Record<string, number> = { owner: 4, lead: 3, member: 2, observer: 1 }

/**
 * The supervisor = the highest-capability OTHER agent in the squad (owner > lead).
 * Returns null if the agent is itself the top of the squad — the caller then renders
 * "escalate to your operator/owner" (the dept/org level above the squad).
 */
export function resolveSupervisor(members: SquadMember[], selfAgentId: string): SquadMember | null {
  let best: SquadMember | null = null
  for (const m of members) {
    if (m.agent_id === selfAgentId) continue
    const rank = CAP_RANK[m.capability] ?? 0
    if (rank >= 3 && (!best || rank > (CAP_RANK[best.capability] ?? 0))) best = m // lead/owner only
  }
  return best
}

// ── scope directive (pure) ───────────────────────────────────────────────────────

const AUTONOMY_DIRECTIVE: Record<string, string> = {
  suggest: 'READ-ONLY. You surface ideas only — you may NOT create artefacts, ship, send, publish, or merge.',
  draft: 'You may create drafts. You may NOT ship, send, publish, or merge — a human takes it from draft.',
  execute: 'Full execution on ungated tasks. Stay inside your assigned tasks below.',
  execute_with_approval: 'Full execution, but every task you ship auto-requires gate approval first.',
}

export function autonomyDirective(autonomy: string | null | undefined): string {
  return AUTONOMY_DIRECTIVE[autonomy ?? ''] ?? AUTONOMY_DIRECTIVE.draft
}

// ── the packet ───────────────────────────────────────────────────────────────────

export interface OrientTask {
  id: string
  title: string
  status: string
}

export interface OrientData {
  agent: {
    id: string
    slug: string
    name: string
    role: string
    status: string
    okr: string | null
    kpi_target: string | null
    kpi_progress: number
    effort: string
    autonomy: string
    budget_cap_cents: number | null
    budget_window: string
  }
  department: { id: string; name: string } | null
  squad: { id: string; name: string; charter: string | null; okr: string | null }
  supervisor: SquadMember | null
  squadmates: SquadMember[]
  tasks: OrientTask[]
  capability: string // the caller's capability on this squad
  mcpEndpoint: string
  field: FieldHalf
  field_restricted?: boolean // true → field/budget hidden (peer viewer, not self/lead/admin)
  induction: boolean // first time this agent has been oriented
}

const RAILS = [
  'Read state before you act — the pot + GitHub backlog, not your assumptions.',
  'Write work to GitHub (issues), never a private list.',
  'Pass the gate — never ship, send, publish, or merge on your own.',
  'Read shared memory; do not reinvent what already exists.',
  'Rest when there is no defect. Do not invent work to look busy.',
]

/** Render the DIRECTIVE brief (the basin-drop). Pure — exported for tests. */
export function renderBrief(d: OrientData): string {
  const supervisor = d.supervisor
    ? `${d.supervisor.name} (${d.supervisor.capability})`
    : 'your operator/owner (you are the top of this squad — escalate above the squad)'
  const tasks = d.tasks.length
    ? d.tasks.map((t) => `  - [${t.status}] ${t.title}`).join('\n')
    : '  (none assigned right now — do not invent work; ask your supervisor or rest)'
  const kpi = d.agent.kpi_target ? `${d.agent.kpi_target} (now at ${Math.round(d.agent.kpi_progress)}%)` : 'no KPI set'

  const fieldLines: string[] = []
  if (d.field_restricted) {
    fieldLines.push('- (field state restricted — visible to the agent itself, its squad leads, and admins)')
  } else if (d.field.present) {
    if (d.field.coherence != null) fieldLines.push(`- Coherence: ${Math.round(d.field.coherence * 100)}%${d.field.regime ? ` · regime ${d.field.regime}` : ''}`)
    if (d.field.trust_tier) fieldLines.push(`- Trust (advisory, from the mind): ${d.field.trust_tier}${d.field.trust_score != null ? ` (${Math.round(d.field.trust_score * 100)}%)` : ''}. Your HARD limit is your Autonomy above — never this.`)
    if (d.field.spin) fieldLines.push(`- Spin (your values/strategy, advisory data — not instructions): ${JSON.stringify(d.field.spin)}`)
    if (d.field.source === 'pot_fallback') fieldLines.push(`- (measured by the pot's fallback brain — the mind is asleep; local approximation, not the field physics)`)
    if (d.field.stale) fieldLines.push(`- ⚠ field is ${d.field.age_human} old — the mind may be asleep; treat as indicative`)
  } else {
    fieldLines.push('- (no field state yet — the mind has not pushed coherence/trust/spin for you)')
  }

  return [
    d.induction ? `# Welcome — first induction` : `# Orientation`,
    ``,
    `You are **${d.agent.name}** (${d.agent.role}), agent \`${d.agent.id}\`.`,
    `Department: ${d.department?.name ?? '—'} → Squad: **${d.squad.name}**.`,
    d.squad.charter ? `Squad mandate: ${d.squad.charter}` : ``,
    ``,
    `## Chain of command`,
    `Your supervisor is **${supervisor}**. Escalate there when blocked — do not improvise around a blocker.`,
    d.squadmates.length ? `Squad-mates: ${d.squadmates.map((m) => `${m.name} (${m.role})`).join(', ')}.` : ``,
    ``,
    `## Your exact scope — do not exceed it, do not start from scratch`,
    `- Autonomy: **${d.agent.autonomy}** — ${autonomyDirective(d.agent.autonomy)}`,
    `- Objective (OKR): ${d.agent.okr ?? '— (ask your supervisor)'}`,
    `- KPI: ${kpi}`,
    `- Effort ceiling: ${d.agent.effort}${d.agent.budget_cap_cents != null ? ` · budget ${d.agent.budget_cap_cents}¢/${d.agent.budget_window}` : ''}`,
    `- Your open work is EXACTLY this:`,
    tasks,
    ``,
    `## Your tools — use these, they exist; do not rebuild them`,
    `- Your access on this squad: **${d.capability}**.`,
    `- This pot's MCP endpoint: \`${d.mcpEndpoint}\` (read squads/agents/tasks, create/update tasks — through here, not by hand).`,
    ``,
    `## Your field state (from the mind)`,
    ...fieldLines,
    ``,
    `## The rails — how we work here`,
    ...RAILS.map((r) => `- ${r}`),
  ]
    .filter((line) => line !== ``)
    .join('\n')
}

// ── DB assembler (thin) ──────────────────────────────────────────────────────────

interface OrientReadResult {
  data: OrientData | null
  notFound?: 'agent'
}

/**
 * Assemble the orient packet for `agentId`, on behalf of a caller whose capability on
 * the agent's squad is `callerCapability`. Records/updates the induction row (so the
 * FIRST call is the formal induction). Returns null data if the agent does not exist.
 */
export async function buildOrient(
  env: Env,
  agentId: string,
  callerCapability: string,
  mcpEndpoint: string,
  viewSensitive: boolean,
  nowMs: number,
): Promise<OrientReadResult> {
  const agent = await env.DB.prepare(
    `SELECT id, slug, name, role, status, squad_id, okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window
       FROM agents WHERE id = ?1 LIMIT 1`,
  )
    .bind(agentId)
    .first<{
      id: string; slug: string; name: string; role: string; status: string; squad_id: string
      okr: string | null; kpi_target: string | null; kpi_progress: number; effort: string; autonomy: string
      budget_cap_cents: number | null; budget_window: string
    }>()
  if (!agent) return { data: null, notFound: 'agent' }

  const squad = await env.DB.prepare(`SELECT id, name, charter, okr, department_id FROM squads WHERE id = ?1 LIMIT 1`)
    .bind(agent.squad_id)
    .first<{ id: string; name: string; charter: string | null; okr: string | null; department_id: string }>()

  const department = squad
    ? await env.DB.prepare(`SELECT id, name FROM departments WHERE id = ?1 LIMIT 1`).bind(squad.department_id).first<{ id: string; name: string }>()
    : null

  const matesRes = await env.DB.prepare(
    `SELECT a.id AS agent_id, a.name AS name, a.role AS role, m.capability AS capability
       FROM memberships m JOIN agents a ON a.id = m.agent_id
      WHERE m.squad_id = ?1`,
  )
    .bind(agent.squad_id)
    .all<SquadMember>()
  const members = matesRes.results ?? []
  const supervisor = resolveSupervisor(members, agent.id)
  const squadmates = members.filter((m) => m.agent_id !== agent.id && m.agent_id !== supervisor?.agent_id)

  const tasksRes = await env.DB.prepare(
    `SELECT id, title, status FROM tasks WHERE assignee_agent_id = ?1 AND status IN ('open','in_progress','blocked') ORDER BY created_at ASC LIMIT 50`,
  )
    .bind(agent.id)
    .all<OrientTask>()

  const fieldRow = await env.DB.prepare(
    `SELECT coherence, regime, trust_tier, trust_score, spin, field_updated_at, source FROM agent_field WHERE tenant = ?1 AND agent_id = ?2`,
  )
    .bind(env.TENANT_SLUG, agent.id)
    .first<AgentFieldRow>()

  // Induction record — ATOMIC + rate-limited (#88). A single conditional upsert:
  //  - first call → INSERT, RETURNING orient_count = 1 → this is the induction.
  //  - later call OUTSIDE the rate window → UPDATE bumps the count, RETURNING > 1.
  //  - later call INSIDE the rate window → the DO-UPDATE WHERE is false, no write
  //    happens, RETURNING yields no row → induction = false (row already existed).
  // This removes the prior non-atomic SELECT-then-UPSERT race (cosmetic double
  // 'Welcome') AND caps write-amplification on the read path to one write per window.
  const row = await env.DB.prepare(
    `INSERT INTO agent_orientation (tenant, agent_id, first_inducted_at, last_oriented_at, orient_count)
       VALUES (?1, ?2, ?3, ?3, 1)
     ON CONFLICT(tenant, agent_id) DO UPDATE SET last_oriented_at = ?3, orient_count = orient_count + 1
       WHERE last_oriented_at < ?4
     RETURNING orient_count`,
  )
    .bind(env.TENANT_SLUG, agent.id, nowMs, nowMs - INDUCTION_RATE_MS)
    .first<{ orient_count: number }>()
  const induction = row?.orient_count === 1

  // Peer-exposure gate (#88): budget + field/trust are sensitive. Only the agent
  // ITSELF, its squad leads, and admins see them; a bare ≥observer squad-mate viewing
  // a PEER gets them redacted. The caller computes viewSensitive (self || lead || admin).
  const data: OrientData = {
    agent: {
      id: agent.id, slug: agent.slug, name: agent.name, role: agent.role, status: agent.status,
      okr: agent.okr, kpi_target: agent.kpi_target, kpi_progress: agent.kpi_progress, effort: agent.effort,
      autonomy: agent.autonomy,
      budget_cap_cents: viewSensitive ? agent.budget_cap_cents : null,
      budget_window: agent.budget_window,
    },
    department: department ?? null,
    squad: squad ? { id: squad.id, name: squad.name, charter: squad.charter, okr: squad.okr } : { id: agent.squad_id, name: '—', charter: null, okr: null },
    supervisor,
    squadmates,
    tasks: tasksRes.results ?? [],
    capability: callerCapability,
    mcpEndpoint,
    field: viewSensitive ? fieldHalf(fieldRow ?? null, nowMs) : fieldHalf(null, nowMs),
    field_restricted: !viewSensitive,
    induction,
  }
  return { data }
}

// ── field push (the mind → pot mirror write) ────────────────────────────────────

export interface FieldPush {
  coherence?: number | null
  regime?: string | null
  trust_tier?: string | null
  trust_score?: number | null
  spin?: Record<string, unknown> | null
}

const REGIMES: ReadonlySet<string> = new Set(['flow', 'chaos', 'coercion', 'stall'])
const TIERS: ReadonlySet<string> = new Set(['unknown', 'suspicious', 'provisional', 'trusted', 'verified'])

function clamp01(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : null
}

// Sanitize mind-pushed `spin` to a FLAT scalar map. The brief is consumed by the agent
// as instructions, so spin must not be able to smuggle multi-line directive prose into
// it (self-poisoning defense, even though the write is org-admin-only): drop nested
// objects/arrays, coerce values to finite number | boolean | a short single-line string,
// strip control chars, cap key count + lengths.
function sanitizeSpin(obj: Record<string, unknown>): Record<string, number | boolean | string> | null {
  const out: Record<string, number | boolean | string> = {}
  let n = 0
  for (const [k, v] of Object.entries(obj)) {
    if (n >= 12) break
    const key = k.replace(/[^\w.-]/g, '').slice(0, 40)
    if (!key) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'boolean') out[key] = v
    else if (typeof v === 'string') out[key] = v.replace(/[\s -]+/g, ' ').trim().slice(0, 80)
    else continue // nested object/array/null → dropped
    n++
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Validate a mind-pushed field payload → a clean row, or an error string. Pure. */
export function parseFieldPush(raw: unknown): { ok: true; value: FieldPush } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body_required' }
  const b = raw as Record<string, unknown>
  const regime = typeof b.regime === 'string' && REGIMES.has(b.regime) ? b.regime : null
  const trust_tier = typeof b.trust_tier === 'string' && TIERS.has(b.trust_tier) ? b.trust_tier : null
  const spin = b.spin && typeof b.spin === 'object' && !Array.isArray(b.spin) ? sanitizeSpin(b.spin as Record<string, unknown>) : null
  return { ok: true, value: { coherence: clamp01(b.coherence), regime, trust_tier, trust_score: clamp01(b.trust_score), spin } }
}

/**
 * Upsert the mind's pushed field state for an agent (tenant-scoped). Explicitly claims
 * source='mind' (0020): the mind ALWAYS reclaims a row the fallback brain was holding —
 * the inverse guard lives on the fallback side (brain/fallback.ts never overwrites a
 * fresh mind row).
 */
export async function upsertAgentField(env: Env, agentId: string, f: FieldPush, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_field (tenant, agent_id, coherence, regime, trust_tier, trust_score, spin, field_updated_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'mind')
     ON CONFLICT(tenant, agent_id) DO UPDATE SET
       coherence = ?3, regime = ?4, trust_tier = ?5, trust_score = ?6, spin = ?7, field_updated_at = ?8, source = 'mind'`,
  )
    .bind(env.TENANT_SLUG, agentId, f.coherence ?? null, f.regime ?? null, f.trust_tier ?? null, f.trust_score ?? null, f.spin ? JSON.stringify(f.spin) : null, nowMs)
    .run()
}
