// mupot — shared org service (department / squad / agent creation).
//
// The single creation path for org-chart rows. Both the JSON API (src/org) and the
// server-rendered dashboard (src/dashboard) call these, so validation + the UNIQUE
// conflict mapping live in ONE place. These functions do NO authz — the caller
// (API route or dashboard handler) gates on the right scope BEFORE calling, using
// the same capability helpers. They return a discriminated result so each surface
// can shape its own response (JSON error vs re-rendered form).

import type { Env, Department, Squad, Agent } from '../types'

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

  const squad: Squad = {
    id: crypto.randomUUID(),
    department_id: departmentId,
    slug: input.slug,
    name: input.name.trim(),
    charter,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      'INSERT INTO squads (id, department_id, slug, name, charter, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(squad.id, squad.department_id, squad.slug, squad.name, squad.charter, squad.created_at)
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
  const model = input.model === undefined ? '@cf/meta/llama-3.3' : input.model
  if (!isNonEmptyString(model)) return { ok: false, error: 'invalid_model' }
  const status: AgentStatus = input.status === undefined ? 'active' : (input.status as AgentStatus)
  if (!isAgentStatus(status)) return { ok: false, error: 'invalid_status' }

  // The AgentDO is lazy — provisioned on first wake. Here we only insert the row;
  // the agent's id doubles as the DurableObject id name.
  const agent: Agent = {
    id: crypto.randomUUID(),
    squad_id: squadId,
    slug: input.slug,
    name: input.name.trim(),
    role: role.trim(),
    model: model.trim(),
    status,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      'INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        agent.id,
        agent.squad_id,
        agent.slug,
        agent.name,
        agent.role,
        agent.model,
        agent.status,
        agent.created_at,
      )
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: agent }
}
