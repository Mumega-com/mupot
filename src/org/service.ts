// mupot — shared org service (department / squad / agent creation).
//
// The single creation path for org-chart rows. Both the JSON API (src/org) and the
// server-rendered dashboard (src/dashboard) call these, so validation + the UNIQUE
// conflict mapping live in ONE place. These functions do NO authz — the caller
// (API route or dashboard handler) gates on the right scope BEFORE calling, using
// the same capability helpers. They return a discriminated result so each surface
// can shape its own response (JSON error vs re-rendered form).

import type { Env, Department, Squad, Agent, Effort, Autonomy, BudgetWindow } from '../types'
import { isEffort, isAutonomy, isBudgetWindow } from '../types'
import { checkCreateLimit } from '../billing/entitlement'

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
): Promise<CreateResult<Department>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }

  const dept: Department = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name.trim(),
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      'INSERT INTO departments (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(dept.id, dept.slug, dept.name, dept.created_at)
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

  // ── Plan ENTITLEMENT gate (S6) — the pot's tier must permit one more squad ──────
  // This is a pot-level invariant (the tier's maxSquads), NOT caller authz (the route
  // already gated scope). Fail-closed: an unconfigured pot resolves to 'free'. Existing
  // overage is grandfathered — only the NEXT create is blocked.
  const squadCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM squads').bind().first<{ n: number }>())?.n ?? 0
  const squadGate = await checkCreateLimit(env, 'maxSquads', squadCount)
  if (!squadGate.ok) return { ok: false, error: 'squad_limit_reached' }

  const squad: Squad = {
    id: crypto.randomUUID(),
    department_id: departmentId,
    slug: input.slug,
    name: input.name.trim(),
    charter,
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
        (id, department_id, slug, name, charter,
         role, okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        squad.id,
        squad.department_id,
        squad.slug,
        squad.name,
        squad.charter,
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

export async function createAgent(
  env: Env,
  squadId: string,
  input: AgentInput,
): Promise<CreateResult<Agent>> {
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

  // ── Plan ENTITLEMENT gate (S6) — the pot's tier must permit one more agent ──────
  // Pot-level invariant (the tier's maxAgents), NOT caller authz. Fail-closed to 'free'
  // when unconfigured. Existing overage grandfathered — only the NEXT create is blocked.
  const agentCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM agents').bind().first<{ n: number }>())?.n ?? 0
  const agentGate = await checkCreateLimit(env, 'maxAgents', agentCount)
  if (!agentGate.ok) return { ok: false, error: 'agent_limit_reached' }

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

  try {
    await env.DB.prepare(
      `INSERT INTO agents
        (id, squad_id, slug, name, role, model, status,
         okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
         created_at,
         purpose, owner, model_fallback, capabilities, skills, parent_agent_id, qnft_ref, death_condition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        agent.id,
        agent.squad_id,
        agent.slug,
        agent.name,
        agent.role,
        agent.model,
        agent.status,
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
        capabilities, // JSON text or null
        skills, // JSON text or null
        parent_agent_id,
        qnft_ref,
        death_condition,
      )
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: agent }
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
  }
}

const PROFILE_COLUMNS =
  'id, squad_id, slug, name, role, status, model, model_fallback, purpose, owner, capabilities, skills, parent_agent_id, qnft_ref, death_condition'

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
    } else if (typeof v === 'number' && Number.isInteger(v)) {
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
  // Null out task assignee references first to keep FK-cleanliness (D1 does not
  // enforce FKs by default, but orphan assignee ids produce confusing UI gaps).
  await env.DB.prepare('UPDATE tasks SET assignee_agent_id = NULL WHERE assignee_agent_id = ?')
    .bind(agentId)
    .run()

  const result = await env.DB.prepare('DELETE FROM agents WHERE id = ?')
    .bind(agentId)
    .run()
  if (!result.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}
