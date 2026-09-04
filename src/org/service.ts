// mupot — shared org service (department / squad / agent creation).
//
// The single creation path for org-chart rows. Both the JSON API (src/org) and the
// server-rendered dashboard (src/dashboard) call these, so validation + the UNIQUE
// conflict mapping live in ONE place. These functions do NO authz — the caller
// (API route or dashboard handler) gates on the right scope BEFORE calling, using
// the same capability helpers. They return a discriminated result so each surface
// can shape its own response (JSON error vs re-rendered form).

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, Department, Squad, Agent, Effort, Autonomy, BudgetWindow, OrgKind } from '../types'
import { isEffort, isAutonomy, isBudgetWindow } from '../types'
import { checkCreateLimit } from '../billing/entitlement'
// Reused, not duplicated (mupot#1288, Kasra's gate) — src/fleet/boot-self-report.ts's
// bearer-authenticated boot self-report already validates a claimed model against
// this exact shape; update_agent's model/model_fallback fields must accept exactly
// the same values or the two self-report paths silently diverge.
import { MODEL_RE } from '../fleet/boot-self-report'

// ── kind (migration 0093, mupot#925 P0-N1; UNSETTABLE-BY-BODY fix, mupot#925
// P0-N3 / PR #928) ──────────────────────────────────────────────────────────
// 'work' (default) counts against PLAN_LIMITS; 'home' is bootstrap_self's
// per-human identity container and is STRUCTURALLY exempt — the entitlement
// gate below only ever runs when the row being created is kind='work'.
//
// P0-N3: kind used to live on DepartmentInput/SquadInput/AgentInput — the SAME
// shape the three authenticated REST routes (src/org/index.ts) cast an
// unvalidated JSON body into (`body = (await c.req.json()) as CreateXBody`,
// a CAST not a parse — TypeScript's excess-property check does not apply to a
// variable, only an object literal). Any org:admin/department:admin/squad:lead
// caller could POST `{"slug":"x","name":"x","kind":"home"}` and skip the
// entitlement gate entirely — WORSE than the bug P0-N1 fixed, because the
// planted rows are also invisible (GET /departments and GET .../squads select
// an explicit column list that never includes kind).
//
// THE FIX: kind is no longer a field any Input interface can carry, so no
// JSON body — however permissive its parsing — can ever set it. It is instead
// a SEPARATE parameter (`opts.kind`) that only a caller with the TypeScript
// reference to these functions can pass, and the only caller that ever does is
// src/members/bootstrap-self.ts. A route handler that hands a request body
// straight to input can no longer reach this parameter at all — not because
// something strips the key, but because the key has nowhere to bind to. A
// fourth route added later inherits this for free; there is no allowlist to
// forget to update.
export interface CreateOpts {
  // 'work' (default) | 'home'. Omit entirely on every call site except
  // src/members/bootstrap-self.ts — see the block comment above.
  kind?: OrgKind
}

const ORG_KINDS: readonly OrgKind[] = ['work', 'home']
export function isOrgKind(v: unknown): v is OrgKind {
  return typeof v === 'string' && (ORG_KINDS as readonly string[]).includes(v)
}

// slugs are URL-safe identifiers: lowercase alphanumeric + single hyphens,
// 1–48 chars, no leading/trailing/double hyphen.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isValidSlug(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 48 && SLUG_RE.test(v)
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

const AGENT_STATUSES = ['active', 'paused'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]
export function isAgentStatus(v: unknown): v is AgentStatus {
  return typeof v === 'string' && (AGENT_STATUSES as readonly string[]).includes(v)
}

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". Map those to a conflict rather than a 500.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

/** A create result: either the row, or a stable error code the caller maps to a
 *  status / message. Errors are the SAME codes the API already returns. */
export type CreateResult<T> = { ok: true; value: T } | { ok: false; error: string }

// ── departments ────────────────────────────────────────────────────────────────

export interface DepartmentInput {
  slug?: unknown
  name?: unknown
}

export async function createDepartment(
  env: Env,
  input: DepartmentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Department>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }
  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment above) — no runtime
  // validation is meaningful here beyond the type system itself.
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (mupot#925 P0-N1) — the pot's tier must permit one
  // more department. ONLY when creating a WORK department: a 'home' create
  // (bootstrap_self only) is structurally exempt — never even reads the tier.
  // Fail-closed: an unconfigured pot resolves to 'free'. Existing overage is
  // grandfathered — only the NEXT create is blocked.
  if (kind === 'work') {
    const deptCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM departments WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const deptGate = await checkCreateLimit(env, 'maxDepartments', deptCount)
    if (!deptGate.ok) return { ok: false, error: 'department_limit_reached' }
  }

  const dept: Department = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name.trim(),
    kind,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      'INSERT INTO departments (id, slug, name, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(dept.id, dept.slug, dept.name, dept.kind, dept.created_at)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: dept }
}

// ── squads ───────────────────────────────────────────────────────────────────

export interface SquadInput {
  slug?: unknown
  name?: unknown
  charter?: unknown
  // work-unit fields (optional; defaults applied when omitted)
  role?: unknown
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
}

export async function createSquad(
  env: Env,
  departmentId: string,
  input: SquadInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Squad>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }

  const charter =
    input.charter === undefined || input.charter === null
      ? null
      : typeof input.charter === 'string'
        ? input.charter
        : undefined
  if (charter === undefined) return { ok: false, error: 'invalid_charter' }

  // work-unit field validation + defaults
  const role =
    input.role === undefined || input.role === null
      ? null
      : typeof input.role === 'string'
        ? input.role.trim() || null
        : undefined
  if (role === undefined) return { ok: false, error: 'invalid_role' }

  const okr =
    input.okr === undefined || input.okr === null
      ? null
      : typeof input.okr === 'string'
        ? input.okr
        : undefined
  if (okr === undefined) return { ok: false, error: 'invalid_okr' }

  const kpi_target =
    input.kpi_target === undefined || input.kpi_target === null
      ? null
      : typeof input.kpi_target === 'string'
        ? input.kpi_target
        : undefined
  if (kpi_target === undefined) return { ok: false, error: 'invalid_kpi_target' }

  const effort: Effort = input.effort === undefined ? 'standard' : (input.effort as Effort)
  if (!isEffort(effort)) return { ok: false, error: 'invalid_effort' }

  const autonomy: Autonomy = input.autonomy === undefined ? 'draft' : (input.autonomy as Autonomy)
  if (!isAutonomy(autonomy)) return { ok: false, error: 'invalid_autonomy' }

  const budget_cap_cents =
    input.budget_cap_cents === undefined || input.budget_cap_cents === null
      ? null
      : typeof input.budget_cap_cents === 'number' &&
          Number.isInteger(input.budget_cap_cents) &&
          input.budget_cap_cents >= 0
        ? input.budget_cap_cents
        : undefined
  if (budget_cap_cents === undefined) return { ok: false, error: 'invalid_budget_cap_cents' }

  const budget_window: BudgetWindow =
    input.budget_window === undefined ? 'week' : (input.budget_window as BudgetWindow)
  if (!isBudgetWindow(budget_window)) return { ok: false, error: 'invalid_budget_window' }

  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment near CreateOpts above).
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (S6; kind-filtered per mupot#925 P0-N1) — the pot's
  // tier must permit one more WORK squad. This is a pot-level invariant (the
  // tier's maxSquads), NOT caller authz (the route already gated scope).
  // Fail-closed: an unconfigured pot resolves to 'free'. Existing overage is
  // grandfathered — only the NEXT create is blocked. A 'home' create
  // (bootstrap_self only) is structurally exempt — never reaches this block.
  if (kind === 'work') {
    const squadCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM squads WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const squadGate = await checkCreateLimit(env, 'maxSquads', squadCount)
    if (!squadGate.ok) return { ok: false, error: 'squad_limit_reached' }
  }

  const squad: Squad = {
    id: crypto.randomUUID(),
    department_id: departmentId,
    slug: input.slug,
    name: input.name.trim(),
    charter,
    kind,
    role,
    okr,
    kpi_target,
    kpi_progress: 0,
    effort,
    autonomy,
    budget_cap_cents,
    budget_window,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      `INSERT INTO squads
        (id, department_id, slug, name, charter, kind,
         role, okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        squad.id,
        squad.department_id,
        squad.slug,
        squad.name,
        squad.charter,
        squad.kind,
        squad.role,
        squad.okr,
        squad.kpi_target,
        squad.kpi_progress,
        squad.effort,
        squad.autonomy,
        squad.budget_cap_cents,
        squad.budget_window,
        squad.created_at,
      )
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: squad }
}

// ── agents ───────────────────────────────────────────────────────────────────

export interface AgentInput {
  slug?: unknown
  name?: unknown
  role?: unknown
  model?: unknown
  status?: unknown
  // work-unit fields (optional; defaults applied when omitted)
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
  // profile fields (0068_agent_profile.sql) — Port 1.3, all optional
  purpose?: unknown
  owner?: unknown
  model_fallback?: unknown
  capabilities?: unknown // string[] on the wire
  skills?: unknown // string[] on the wire
  parent_agent_id?: unknown
  qnft_ref?: unknown
  death_condition?: unknown // JSON object or string
}

export type CreateAgentInput = AgentInput

export interface PreparedAgentCreate {
  agent: Agent
  statements: [D1PreparedStatement, D1PreparedStatement]
}

// A nullable free-text profile field: undefined|null → null; a string → itself;
// anything else → the sentinel `undefined` (caller maps to an invalid_* error).
function optString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : undefined
}

// A nullable JSON string-array field (capabilities/skills). Stored as a JSON text
// column, so validate it is an array of strings and re-serialize canonically.
// undefined|null → null; string[] → JSON; anything else → undefined (invalid).
function optStringArrayJson(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return undefined
  return JSON.stringify(v)
}

// A plain (non-null, non-array) JSON object.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// death_condition: a JSON lifecycle-policy OBJECT stored as text. Accept an object
// (serialize it) or a string (must itself parse to a plain object, stored verbatim).
// undefined|null → null; anything that is not a plain object → undefined (invalid).
// Rejecting arrays / scalars ("null", "42", "[...]") keeps the stored blob a policy
// object, so a future enforcement sweep can trust its shape.
function optJsonObject(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') {
    try {
      return isPlainObject(JSON.parse(v)) ? v : undefined
    } catch {
      return undefined
    }
  }
  if (isPlainObject(v)) return JSON.stringify(v)
  return undefined
}

export async function prepareAgentCreate(
  env: Env,
  squadId: string,
  input: AgentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<PreparedAgentCreate>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }

  // role/model fall back to the schema defaults when omitted.
  const role = input.role === undefined ? 'member' : input.role
  if (!isNonEmptyString(role)) return { ok: false, error: 'invalid_role' }
  // '@cf/meta/llama-3.3' is NOT a valid Workers AI model id — the real one is
  // '@cf/meta/llama-3.3-70b-instruct-fp8-fast'. Using the wrong id yields a 5007
  // error from Workers AI on first wake. (Bug introduced in initial scaffold, fixed here.)
  const model = input.model === undefined ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : input.model
  if (!isNonEmptyString(model)) return { ok: false, error: 'invalid_model' }
  const status: AgentStatus = input.status === undefined ? 'active' : (input.status as AgentStatus)
  if (!isAgentStatus(status)) return { ok: false, error: 'invalid_status' }

  // work-unit field validation + defaults
  const okr =
    input.okr === undefined || input.okr === null
      ? null
      : typeof input.okr === 'string'
        ? input.okr
        : undefined
  if (okr === undefined) return { ok: false, error: 'invalid_okr' }

  const kpi_target =
    input.kpi_target === undefined || input.kpi_target === null
      ? null
      : typeof input.kpi_target === 'string'
        ? input.kpi_target
        : undefined
  if (kpi_target === undefined) return { ok: false, error: 'invalid_kpi_target' }

  const effort: Effort = input.effort === undefined ? 'standard' : (input.effort as Effort)
  if (!isEffort(effort)) return { ok: false, error: 'invalid_effort' }

  const autonomy: Autonomy = input.autonomy === undefined ? 'draft' : (input.autonomy as Autonomy)
  if (!isAutonomy(autonomy)) return { ok: false, error: 'invalid_autonomy' }

  const budget_cap_cents =
    input.budget_cap_cents === undefined || input.budget_cap_cents === null
      ? null
      : typeof input.budget_cap_cents === 'number' &&
          Number.isInteger(input.budget_cap_cents) &&
          input.budget_cap_cents >= 0
        ? input.budget_cap_cents
        : undefined
  if (budget_cap_cents === undefined) return { ok: false, error: 'invalid_budget_cap_cents' }

  const budget_window: BudgetWindow =
    input.budget_window === undefined ? 'week' : (input.budget_window as BudgetWindow)
  if (!isBudgetWindow(budget_window)) return { ok: false, error: 'invalid_budget_window' }

  // ── profile field validation + defaults (0068, Port 1.3) ────────────────────────
  const purpose = optString(input.purpose)
  if (purpose === undefined) return { ok: false, error: 'invalid_purpose' }
  const owner = optString(input.owner)
  if (owner === undefined) return { ok: false, error: 'invalid_owner' }
  const model_fallback = optString(input.model_fallback)
  if (model_fallback === undefined) return { ok: false, error: 'invalid_model_fallback' }
  const qnft_ref = optString(input.qnft_ref)
  if (qnft_ref === undefined) return { ok: false, error: 'invalid_qnft_ref' }
  const capabilities = optStringArrayJson(input.capabilities)
  if (capabilities === undefined) return { ok: false, error: 'invalid_capabilities' }
  const skills = optStringArrayJson(input.skills)
  if (skills === undefined) return { ok: false, error: 'invalid_skills' }
  const death_condition = optJsonObject(input.death_condition)
  if (death_condition === undefined) return { ok: false, error: 'invalid_death_condition' }

  // parent_agent_id: soft self-reference (no FK, see migration). Validate the
  // parent exists so the placement tree can't point at a phantom id.
  const parent_agent_id = optString(input.parent_agent_id)
  if (parent_agent_id === undefined) return { ok: false, error: 'invalid_parent_agent_id' }
  if (parent_agent_id !== null) {
    const parent = await env.DB.prepare('SELECT 1 AS ok FROM agents WHERE id = ?')
      .bind(parent_agent_id)
      .first<{ ok: number }>()
    if (!parent) return { ok: false, error: 'parent_agent_not_found' }
  }

  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment near CreateOpts above).
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (S6; kind-filtered per mupot#925 P0-N1) — the pot's
  // tier must permit one more WORK agent. Pot-level invariant (the tier's
  // maxAgents), NOT caller authz. Fail-closed to 'free' when unconfigured.
  // Existing overage grandfathered — only the NEXT create is blocked. A 'home'
  // create (bootstrap_self only) is structurally exempt — never reaches this.
  if (kind === 'work') {
    const agentCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const agentGate = await checkCreateLimit(env, 'maxAgents', agentCount)
    if (!agentGate.ok) return { ok: false, error: 'agent_limit_reached' }
  }

  // The AgentDO is lazy — provisioned on first wake. Here we only insert the row;
  // the agent's id doubles as the DurableObject id name.
  const agent: Agent = {
    id: crypto.randomUUID(),
    squad_id: squadId,
    slug: input.slug,
    name: input.name.trim(),
    role: (role as string).trim(),
    model: (model as string).trim(),
    status,
    kind,
    okr,
    kpi_target,
    kpi_progress: 0,
    effort,
    autonomy,
    budget_cap_cents,
    budget_window,
    created_at: new Date().toISOString(),
    // profile (0068) — arrays are parsed for the return value; JSON text goes to the DB.
    purpose,
    owner,
    model_fallback,
    capabilities: capabilities === null ? null : (JSON.parse(capabilities) as string[]),
    skills: skills === null ? null : (JSON.parse(skills) as string[]),
    parent_agent_id,
    qnft_ref,
    death_condition,
  }

  // Prepare the agent AND its neutral home routing membership. The caller may
  // compose these statements into a larger provisioning transaction.
  // (agent_id -> its own squad, 'member') is what the project-scoped message path
  // (src/agents/messages.ts) checks — without it, an onboarded agent could not send
  // or receive a project-scoped message (see gh #469).
  const statements: [D1PreparedStatement, D1PreparedStatement] = [
    env.DB.prepare(
      `INSERT INTO agents
      (id, squad_id, slug, name, role, model, status, kind,
       okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
       created_at,
       purpose, owner, model_fallback, capabilities, skills, parent_agent_id, qnft_ref, death_condition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      agent.id,
      agent.squad_id,
      agent.slug,
      agent.name,
      agent.role,
      agent.model,
      agent.status,
      agent.kind,
      agent.okr,
      agent.kpi_target,
      agent.kpi_progress,
      agent.effort,
      agent.autonomy,
      agent.budget_cap_cents,
      agent.budget_window,
      agent.created_at,
      purpose,
      owner,
      model_fallback,
      capabilities,
      skills,
      parent_agent_id,
      qnft_ref,
      death_condition,
    ),
    env.DB.prepare(
      `INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES (?, ?, ?, 'member')`,
    ).bind(crypto.randomUUID(), agent.id, agent.squad_id),
  ]
  return { ok: true, value: { agent, statements } }
}

export async function createAgent(
  env: Env,
  squadId: string,
  input: AgentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Agent>> {
  const prepared = await prepareAgentCreate(env, squadId, input, opts)
  if (!prepared.ok) return prepared
  try {
    await env.DB.batch(prepared.value.statements)
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: prepared.value.agent }
}

// ── profile reads (0068, Port 1.3) ──────────────────────────────────────────────

// A lightweight profile summary — enough for resolve-before-mint and roster display.
export interface AgentProfileSummary {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  status: string
  model: string
  model_fallback: string | null
  purpose: string | null
  owner: string | null
  capabilities: string[] | null
  skills: string[] | null
  parent_agent_id: string | null
  qnft_ref: string | null
  death_condition: string | null
  budget_cap_cents: number | null
  budget_window: string
}

interface AgentProfileRow {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  status: string
  model: string
  model_fallback: string | null
  purpose: string | null
  owner: string | null
  capabilities: string | null
  skills: string | null
  parent_agent_id: string | null
  qnft_ref: string | null
  death_condition: string | null
  budget_cap_cents: number | null
  budget_window: string
}

// JSON-array text column → string[]; tolerate a corrupt/legacy value by returning null
// rather than throwing (a bad stored value must not brick a read path).
function parseArrayColumn(v: string | null): string[] | null {
  if (v === null) return null
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null
  } catch {
    return null
  }
}

function rowToProfileSummary(r: AgentProfileRow): AgentProfileSummary {
  return {
    id: r.id,
    squad_id: r.squad_id,
    slug: r.slug,
    name: r.name,
    role: r.role,
    status: r.status,
    model: r.model,
    model_fallback: r.model_fallback,
    purpose: r.purpose,
    owner: r.owner,
    capabilities: parseArrayColumn(r.capabilities),
    skills: parseArrayColumn(r.skills),
    parent_agent_id: r.parent_agent_id,
    qnft_ref: r.qnft_ref,
    death_condition: r.death_condition,
    budget_cap_cents: r.budget_cap_cents,
    budget_window: r.budget_window,
  }
}

const PROFILE_COLUMNS =
  'id, squad_id, slug, name, role, status, model, model_fallback, purpose, owner, capabilities, skills, parent_agent_id, qnft_ref, death_condition, budget_cap_cents, budget_window'

// Read one agent's profile by id. null when the agent does not exist.
export async function getAgentProfile(env: Env, agentId: string): Promise<AgentProfileSummary | null> {
  const row = await env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM agents WHERE id = ?`)
    .bind(agentId)
    .first<AgentProfileRow>()
  return row ? rowToProfileSummary(row) : null
}

// resolve-before-mint: find existing agents matching a name/slug query, across ALL
// squads, so onboarding surfaces existing ROLES before minting a duplicate identity.
// This is the anti-sprawl primitive (the 2026-07-21 3-hermes incident). Case-
// insensitive substring match on name OR slug; excludes 'inactive' by default.
export async function findAgentsByName(
  env: Env,
  query: string,
  opts: { includeInactive?: boolean; limit?: number } = {},
): Promise<AgentProfileSummary[]> {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const statusClause = opts.includeInactive ? '' : " AND status != 'inactive'"
  const rows = await env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM agents
      WHERE (LOWER(name) LIKE ?1 ESCAPE '\\' OR LOWER(slug) LIKE ?1 ESCAPE '\\')${statusClause}
      ORDER BY name ASC, slug ASC
      LIMIT ?2`,
  )
    .bind(like, limit)
    .all<AgentProfileRow>()
  return (rows.results ?? []).map(rowToProfileSummary)
}

// ── work-unit helpers ─────────────────────────────────────────────────────────

/**
 * autonomyImpliesGate returns true when the autonomy level requires that tasks
 * produced by this unit are automatically gated (gate_owner will be auto-set
 * when the loop builds tasks — that wiring lands in #27).
 */
export function autonomyImpliesGate(autonomy: Autonomy): boolean {
  return autonomy === 'execute_with_approval'
}

// The set of fields updateUnitConfig may patch (any subset is valid).
export interface UnitConfigPatch {
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
  // role is patchable on squads (and on agents, though agents already have role
  // in the core shape — it is included here for uniform patch surface).
  role?: unknown
}

export type UpdateUnitConfigResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'invalid_role' | 'invalid_okr' | 'invalid_kpi_target' | 'invalid_effort' | 'invalid_autonomy' | 'invalid_budget_cap_cents' | 'invalid_budget_window' }

/**
 * Patch any subset of the work-unit config fields on an agent or squad.
 * Validates every supplied field before touching D1. Returns not_found when
 * the row does not exist (zero changes). Returns invalid_* for bad values.
 * Fields absent from the patch are left untouched.
 */
export async function updateUnitConfig(
  env: Env,
  kind: 'agent' | 'squad',
  id: string,
  patch: UnitConfigPatch,
): Promise<UpdateUnitConfigResult> {
  const setClauses: string[] = []
  const binds: (string | number | null)[] = []

  // role (optional field on both agents and squads)
  if ('role' in patch) {
    const v = patch.role
    if (v === null || v === undefined) {
      if (kind === 'squad') {
        // squads allow null role
        setClauses.push('role = ?')
        binds.push(null)
      } else {
        return { ok: false, error: 'invalid_role' }
      }
    } else if (typeof v === 'string' && v.trim().length > 0) {
      setClauses.push('role = ?')
      binds.push(v.trim())
    } else {
      return { ok: false, error: 'invalid_role' }
    }
  }

  if ('okr' in patch) {
    const v = patch.okr
    if (v === null || v === undefined) {
      setClauses.push('okr = ?')
      binds.push(null)
    } else if (typeof v === 'string') {
      setClauses.push('okr = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_okr' }
    }
  }

  if ('kpi_target' in patch) {
    const v = patch.kpi_target
    if (v === null || v === undefined) {
      setClauses.push('kpi_target = ?')
      binds.push(null)
    } else if (typeof v === 'string') {
      setClauses.push('kpi_target = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_kpi_target' }
    }
  }

  if ('effort' in patch) {
    if (!isEffort(patch.effort)) return { ok: false, error: 'invalid_effort' }
    setClauses.push('effort = ?')
    binds.push(patch.effort)
  }

  if ('autonomy' in patch) {
    if (!isAutonomy(patch.autonomy)) return { ok: false, error: 'invalid_autonomy' }
    setClauses.push('autonomy = ?')
    binds.push(patch.autonomy)
  }

  if ('budget_cap_cents' in patch) {
    const v = patch.budget_cap_cents
    if (v === null || v === undefined) {
      setClauses.push('budget_cap_cents = ?')
      binds.push(null)
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      // >= 0 matches the creation-path guard (prepareSquadCreate/prepareAgentCreate,
      // above) — this branch was missing it, so a negative cap could previously be
      // set post-creation even though creation itself always rejected one. A cap of
      // -1 clamps nothing (meter.ts only applies budgetCapMicroDollars when it is a
      // POSITIVE finite number — see the Governor/budget-cap inversion note), so a
      // negative value here was not a stricter cap, it was a silently-ignored one.
      setClauses.push('budget_cap_cents = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_budget_cap_cents' }
    }
  }

  if ('budget_window' in patch) {
    if (!isBudgetWindow(patch.budget_window)) return { ok: false, error: 'invalid_budget_window' }
    setClauses.push('budget_window = ?')
    binds.push(patch.budget_window)
  }

  // Nothing to patch — treat as a no-op success (caller is responsible for sending
  // a non-empty patch; we do not 400 here because a partial update with unknown
  // keys simply elides those keys and the result is consistent).
  if (setClauses.length === 0) return { ok: true }

  const table = kind === 'agent' ? 'agents' : 'squads'
  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ?`
  binds.push(id)

  const result = await env.DB.prepare(sql)
    .bind(...binds)
    .run()

  if (!result.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}

// ── agent mutations ───────────────────────────────────────────────────────────

export type SetStatusResult = { ok: true } | { ok: false; error: 'not_found' }

/**
 * Pause or resume an agent by updating its status column.
 * Returns ok:true on success or ok:false + 'not_found' when the id does not exist.
 */
export async function setAgentStatus(
  env: Env,
  agentId: string,
  status: AgentStatus,
): Promise<SetStatusResult> {
  const result = await env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?')
    .bind(status, agentId)
    .run()
  if (!result.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}

export type UpdateAgentProfileResult =
  | { ok: true; value: AgentProfileSummary; auditId: string }
  | { ok: false; error: 'not_found' | 'slug_taken' | 'no_fields' | 'invalid_field' }

/** Who made a correction. `actor_type` is constrained by 0086's CHECK; a member
 *  acting through the MCP tool is a 'user'. */
export interface AuditActor {
  id: string
  type: 'agent' | 'user' | 'system'
}

// A call that supplies no actor is a system-initiated correction — migrations,
// reconciliation jobs, tests. The MCP tool always passes the real member.
const SYSTEM_ACTOR: AuditActor = { id: 'system', type: 'system' }

// The audited snapshot, built in SQL so it can be taken inside the transaction.
// Deliberately excludes `id` (the audit row already carries agent_id) and
// created_at (immutable). Keep in sync with the updatable columns above: a
// field that can be corrected but is not snapshotted is a change no one can
// reverse from the trail.
const AGENT_SNAPSHOT_JSON = `json_object(
  'squad_id', squad_id, 'slug', slug, 'name', name, 'role', role, 'status', status,
  'model', model, 'model_fallback', model_fallback, 'purpose', purpose, 'owner', owner,
  'capabilities', capabilities, 'skills', skills, 'parent_agent_id', parent_agent_id,
  'qnft_ref', qnft_ref, 'budget_cap_cents', budget_cap_cents, 'budget_window', budget_window
)`

// Fields an admin may correct on an existing agent. `status` is deliberately
// excluded — setAgentStatus/deactivateAgent own that transition and carry their
// own semantics. `id` and `squad_id` are excluded because moving an agent
// between squads changes its capability scope and is not a profile edit.
//
// `parent_agent_id` is excluded for the same reason, and it is the sharper case.
// It shipped on this list and reached the SET clause through the generic text
// path — trimmed, bound, written — with none of createAgent's validation. That
// made the governed repair path the ONLY way to write the corruption it exists
// to prevent:
//
//   phantom  update_agent(a, {parent_agent_id: 'not-an-agent'})
//   self     update_agent(a, {parent_agent_id: a})
//   cycle    update_agent(a, {parent_agent_id: b}) + update_agent(b, {parent_agent_id: a})
//
// The column is a soft self-reference with no foreign key (see migration), so
// D1 catches none of it, and a cycle makes every consumer that walks the
// placement tree loop forever.
//
// createAgent cannot produce any of the three: it validates that the parent row
// exists, and the new agent's id is crypto.randomUUID() generated server-side —
// a caller cannot name it, so it can be neither its own parent nor an ancestor
// of anything. With this column off the update list, no service path can create
// a cycle at all, which is why this is an exclusion and not a validator.
//
// Re-parenting remains possible by re-provisioning, exactly as with squad_id. If
// a governed in-place re-parent is wanted later, it needs its own entry point
// with an existence check, a self check, and a bounded ancestor walk — not a
// line on this list.
const UPDATABLE_TEXT_COLUMNS = [
  'slug',
  'name',
  'role',
  'model',
  'model_fallback',
  'purpose',
  'owner',
  'qnft_ref',
] as const

const UPDATABLE_ARRAY_COLUMNS = ['capabilities', 'skills'] as const

// Shape caps for update_agent's self-lane fields (mupot#1288, Kasra's gate F3) —
// enforced HERE, not just at the MCP tool layer, so the admin path gets them too
// (an admin fat-fingering a 100k-char purpose is the same corrupted row as an
// agent doing it). MODEL_RE is imported, not redefined, so this and boot-time
// self-report (src/fleet/boot-self-report.ts) can never silently diverge on what
// a "valid model string" is.
//
// PURPOSE_MAX_LEN / PURPOSE_CONTROL_CHAR_RE: purpose is free text (unlike model,
// which is a slug-shaped identifier), so it only gets a length ceiling and a
// control-character ban — NUL and friends have no legitimate reason to appear in
// a one-line self-description, and letting them through risks corrupting log
// lines / CSV exports / terminal renders downstream. \n is allowed (a purpose can
// be a short paragraph); every other C0 control code and DEL are not.
const PURPOSE_MAX_LEN = 2000
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to REJECT them
const PURPOSE_CONTROL_CHAR_RE = /[\x00-\x09\x0B-\x1F\x7F]/

// skills: capped at 32 entries, each a short lowercase tag — same shape family as
// a capability/permission string elsewhere in this codebase, not free text.
const SKILLS_MAX_COUNT = 32
const SKILL_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/

// NAME_MAX_LEN / ROLE_MAX_LEN / IDENTITY_CONTROL_CHAR_RE (mupot#1288 gate round 3,
// R4): name and role had NO shape cap on the admin path even after F3 capped
// model/model_fallback/purpose/skills — and they are the two fields
// interpolated RAW into an agent's own system turn (src/agents/execute.ts,
// src/agents/loop.ts, src/agents/agent-do.ts), a stricter authority surface
// than purpose (which reaches no prompt builder). Unlike purpose,
// \n is NOT allowed here — a newline in role/name forges a standalone
// prompt LINE, not just an oversized one, so the ban is every C0 control
// code AND \n, not "every control code except \n". Bounds are generous for
// a one-line identity string, not a paragraph: name tracks a short display
// name (80 chars), role a short descriptor (200 chars — mirrors purpose's
// intent but at a fraction of its length, since role is a title, not a brief).
const NAME_MAX_LEN = 80
const ROLE_MAX_LEN = 200
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to REJECT them
const IDENTITY_CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

// budget_cap_cents/budget_window (mupot#611 item 1): before this, budget_cap_cents
// was settable ONLY at creation (prepareSquadCreate/prepareAgentCreate above). An
// agent or squad created without a cap — or one whose spend profile changed — could
// never dispatch a budgeted flight again (src/mcp/index.ts's flight_budget_policy_missing
// gate requires a positive integer cap on the bound agent AND every referenced squad),
// and the only "fix" was recreating the row, discarding its grants and history. These
// two get their own category (not TEXT, not ARRAY) because the valid shape is a typed
// number/enum, not a free string — validation below mirrors prepareAgentCreate's guard
// exactly (integer >= 0 or null; budget_window ∈ BudgetWindow).
const UPDATABLE_NUMERIC_COLUMNS = ['budget_cap_cents'] as const
const UPDATABLE_ENUM_COLUMNS = ['budget_window'] as const

export type UpdatableAgentField =
  | (typeof UPDATABLE_TEXT_COLUMNS)[number]
  | (typeof UPDATABLE_ARRAY_COLUMNS)[number]
  | (typeof UPDATABLE_NUMERIC_COLUMNS)[number]
  | (typeof UPDATABLE_ENUM_COLUMNS)[number]

export type AgentProfilePatch = Partial<Record<UpdatableAgentField, unknown>>

/**
 * Correct an existing agent's profile row in place.
 *
 * Exists because the registry drifts: a seat is re-harnessed or re-modelled and
 * the row keeps asserting what was true at creation. Before this, the only
 * mutations on `agents` were status and kpi_progress, so a wrong model or a
 * stale role could be fixed only by direct database access — which meant it
 * never stayed fixed.
 *
 * Partial by construction: only the keys present in `patch` are written, so a
 * caller correcting a model cannot accidentally blank a purpose. An explicit
 * null clears a nullable column; `slug` and `name` reject null because the
 * schema requires them.
 */
export async function updateAgentProfile(
  env: Env,
  agentId: string,
  patch: AgentProfilePatch,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<UpdateAgentProfileResult> {
  const sets: string[] = []
  const binds: (string | number | null)[] = []

  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue

    if ((UPDATABLE_NUMERIC_COLUMNS as readonly string[]).includes(key)) {
      // budget_cap_cents: null clears the cap; otherwise integer >= 0, exactly
      // mirroring prepareAgentCreate/prepareSquadCreate's guard (lines ~139-147
      // above). A negative value is not a stricter cap — meter.ts only applies
      // budgetCapMicroDollars when it is positive — so rejecting it here rather
      // than silently storing a no-op cap matches the creation path's intent,
      // not just its shape.
      if (raw === null) {
        sets.push(`${key} = ?`)
        binds.push(null)
        continue
      }
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(raw)
      continue
    }

    if ((UPDATABLE_ENUM_COLUMNS as readonly string[]).includes(key)) {
      // budget_window has a schema DEFAULT and is never null-valued on a live
      // row (prepareAgentCreate defaults it to 'week' when omitted) — unlike
      // budget_cap_cents, null is not accepted here.
      if (!isBudgetWindow(raw)) return { ok: false, error: 'invalid_field' }
      sets.push(`${key} = ?`)
      binds.push(raw)
      continue
    }

    if ((UPDATABLE_ARRAY_COLUMNS as readonly string[]).includes(key)) {
      if (raw === null) {
        sets.push(`${key} = ?`)
        binds.push(null)
        continue
      }
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
        return { ok: false, error: 'invalid_field' }
      }
      // mupot#1288 F3 — skills is the one array column reachable from
      // update_agent's self lane, so it gets the same shape discipline as a
      // capability/permission tag: capped count, short lowercase-tag shape.
      // `capabilities` (the other UPDATABLE_ARRAY_COLUMNS member) is
      // admin-only on every path and keeps its existing string[] check only.
      if (key === 'skills') {
        if (raw.length > SKILLS_MAX_COUNT) return { ok: false, error: 'invalid_field' }
        if (!raw.every((s) => SKILL_RE.test(s))) return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(JSON.stringify(raw))
      continue
    }

    if (!(UPDATABLE_TEXT_COLUMNS as readonly string[]).includes(key)) {
      return { ok: false, error: 'invalid_field' }
    }

    if (raw === null) {
      // slug, name, role and model are NOT NULL in the schema (migration 0049
      // — role/model carry schema DEFAULTs, but D1 still rejects an explicit
      // NULL). Before mupot#1288 F4, role/model were missing from this list:
      // a { role: null } or { model: null } patch sailed through this
      // function's own validation, then threw a raw SQLite NOT NULL
      // constraint violation out of the D1 batch — an admin-path patch that
      // 500'd instead of failing closed with a named field.
      if (key === 'slug' || key === 'name' || key === 'role' || key === 'model') {
        return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(null)
      continue
    }

    if (typeof raw !== 'string') return { ok: false, error: 'invalid_field' }
    const trimmed = raw.trim()
    if ((key === 'slug' || key === 'name' || key === 'role' || key === 'model') && !trimmed) {
      return { ok: false, error: 'invalid_field' }
    }
    // mupot#1288 F3 — model/model_fallback are the two update_agent self-lane
    // fields shaped like an identifier rather than free text; model_fallback
    // is nullable (handled above) but once it IS a string it must be shaped
    // the same as model, or a fallback nobody validated becomes the live
    // model the moment the primary fails.
    if ((key === 'model' || key === 'model_fallback') && !MODEL_RE.test(trimmed)) {
      return { ok: false, error: 'invalid_field' }
    }
    if (key === 'purpose') {
      if (trimmed.length > PURPOSE_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (PURPOSE_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    // mupot#1288 gate round 3, R4 — name/role reach the system prompt raw
    // (see the block comment above IDENTITY_CONTROL_CHAR_RE); the non-empty
    // check above already enforces the 1-char floor, this adds the ceiling
    // and bans EVERY control character including \n (a newline here forges
    // a standalone prompt line, unlike purpose where \n is legitimate).
    if (key === 'name') {
      if (trimmed.length > NAME_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (IDENTITY_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    if (key === 'role') {
      if (trimmed.length > ROLE_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (IDENTITY_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    sets.push(`${key} = ?`)
    binds.push(trimmed)
  }

  if (!sets.length) return { ok: false, error: 'no_fields' }

  const auditId = crypto.randomUUID()
  const fieldsChanged = JSON.stringify(Object.keys(patch).filter((k) => patch[k as UpdatableAgentField] !== undefined))

  let changes = 0
  try {
    // No updated_at column on `agents` — 0049 rebuilt the table without one and
    // no later migration adds it. Provenance for a correction lives in the audit
    // trail, not on the row, which is why that trail must be durable.
    //
    // All three statements run in ONE D1 batch, i.e. one transaction. This is
    // load-bearing on both counts:
    //
    //   Durability — the audit row commits WITH the update or not at all. The
    //   previous design wrote the row, then emitted a bus event that was caught
    //   and swallowed on failure, so a correction could land with no record of
    //   what changed or what it was before. On a table with no updated_at, that
    //   is an unrecorded mutation the design tells operators to trust.
    //
    //   Accuracy — the before-image is captured in SQL, inside the transaction,
    //   rather than by a separate SELECT beforehand. A concurrent write between
    //   a client-side read and the UPDATE would otherwise make before_state a
    //   fabrication: a diff that never happened.
    //
    // Same shape as 0046_flight_event_outbox ("Landing and outbox insertion
    // share one D1 batch").
    //
    // Statement 1 uses INSERT..SELECT so a missing agent inserts no audit row;
    // statement 2 then reports 0 changes and we return not_found with nothing
    // written. Statement 3 backfills after_state from the committed row.
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_audit
           (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
         SELECT ?, id, ?, ?, 'update_agent', ?, ${AGENT_SNAPSHOT_JSON}, ''
           FROM agents WHERE id = ?`,
      ).bind(auditId, actor.id, actor.type, fieldsChanged, agentId),
      env.DB.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, agentId),
      env.DB.prepare(
        `UPDATE agent_audit
            SET after_state = (SELECT ${AGENT_SNAPSHOT_JSON} FROM agents WHERE id = ?)
          WHERE id = ?`,
      ).bind(agentId, auditId),
    ])
    changes = batch[1]?.meta.changes ?? 0
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  if (!changes) return { ok: false, error: 'not_found' }

  const profile = await getAgentProfile(env, agentId)
  if (!profile) return { ok: false, error: 'not_found' }
  return { ok: true, value: profile, auditId }
}

export type DeleteAgentResult = { ok: true } | { ok: false; error: 'not_found' }

/**
 * Delete an agent row and null out any task assignee references.
 *
 * The AgentDO is lazy — it is only provisioned on first wake. A deleted agent
 * id is simply never woken again, so no explicit DurableObject teardown is
 * required (the stub exists but no calls reach it once the row is gone from D1).
 *
 * We also null out tasks.assignee_agent_id where it references this agent to
 * avoid orphaned assignee ids that would otherwise render as '—' in the UI.
 */
export async function deleteAgent(
  env: Env,
  agentId: string,
): Promise<DeleteAgentResult> {
  // Keep assignment cleanup and deletion in one D1 transaction. A canonical
  // binding or any other delete guard rolls the cleanup back instead of
  // returning an error after tasks have already been destructively unassigned.
  const writes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks
          SET assignee_agent_id = NULL
        WHERE assignee_agent_id = ?
          AND EXISTS (SELECT 1 FROM agents WHERE id = ?)`,
    ).bind(agentId, agentId),
    env.DB.prepare('DELETE FROM agents WHERE id = ?').bind(agentId),
  ])
  if (!writes[1]?.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}
