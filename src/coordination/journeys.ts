// mupot — the Control Tower: cross-project agent coordination board (the departures board).
//
// A `journey` = one agent's flight to a PROJECT (destination), over time, with a status. Light,
// agent-self-registered (any agent-bound token can board one — like check-in), NOT the brain's
// money-gated `flights` (0017). This module is the pure service + the board view model:
//   - boardJourney   — an agent boards a flight (status 'boarding').
//   - updateJourney  — the SAME agent advances/exits it (depart/arrive/delay/cancel). Self-owned.
//   - listJourneys   — read the board (live, or all/history).
//   - buildDepartureBoard — derive display cards (airport metaphor) from rows. No I/O.
//
// Discipline (sovereign core): tenant = env.TENANT_SLUG (never client); agent identity is the
// caller's token weld, passed in by the route (never read from the body); every field validated
// + capped; writes are receipt-checked.

import type { Env } from '../types'
import { humanDur } from '../flight/board'
import { anySquadHasProjectWrite } from '../projects/access'

// ── tunables ───────────────────────────────────────────────────────────────────────────────
const MAX_AGENT = 128
const MAX_GOAL = 200
const MAX_GATE = 300
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
// A project (destination) is a slug-ish name: starts alnum, then [a-z0-9._-]. Linear regex.
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const STATUSES = ['boarding', 'departed', 'arrived', 'delayed', 'cancelled'] as const
export type JourneyStatus = (typeof STATUSES)[number]
// Live = still on the board (not yet history). arrived/cancelled fall off into history.
const LIVE_STATUSES: ReadonlySet<JourneyStatus> = new Set<JourneyStatus>(['boarding', 'departed', 'delayed'])

// ── types ──────────────────────────────────────────────────────────────────────────────────
export interface JourneyRow {
  id: string
  tenant: string
  agent: string
  project: string
  goal: string
  status: JourneyStatus
  gate: string
  departed_at: number | null
  eta: number | null
  arrived_at: number | null
  created_at: number
  updated_at: number
}

export interface BoardInput {
  agent: string
  project: string
  goal?: string
  gate?: string
  eta?: number
}

export interface UpdateInput {
  status?: JourneyStatus
  goal?: string
  gate?: string
  eta?: number
}

interface Opts {
  now?: () => number
  idGen?: () => string
}

export type BoardResult = { ok: true; id: string } | { ok: false; reason: BoardFailReason; detail?: string }
type BoardFailReason = 'no_tenant' | 'invalid_agent' | 'invalid_project' | 'invalid_goal' | 'invalid_gate' | 'invalid_eta' | 'db_error'

export type UpdateResult =
  | { ok: true }
  | { ok: false; reason: 'no_tenant' | 'invalid_status' | 'invalid_goal' | 'invalid_gate' | 'invalid_eta' | 'not_found' | 'db_error'; detail?: string }

// ── validation helpers (pure) ────────────────────────────────────────────────────────────────
function capStr(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null
}
// eta is a Unix-ms timestamp. Bound it: positive, and no more than this horizon past `now` — so a
// garbage value (e.g. 1e300) can't land a dishonest "ETA" on the board. A past eta is allowed (the
// board shows it as "due").
const MAX_ETA_HORIZON_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
function validEta(v: unknown, nowMs: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= nowMs + MAX_ETA_HORIZON_MS
}

// ── board: an agent boards a flight ──────────────────────────────────────────────────────────
export async function boardJourney(env: Env, input: BoardInput, opts: Opts = {}): Promise<BoardResult> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }
  if (typeof input.agent !== 'string' || input.agent.length === 0 || input.agent.length > MAX_AGENT)
    return { ok: false, reason: 'invalid_agent' }
  if (typeof input.project !== 'string' || !PROJECT_RE.test(input.project))
    return { ok: false, reason: 'invalid_project', detail: 'project must match [a-z0-9][a-z0-9._-]{0,63}' }
  const goal = input.goal === undefined ? '' : capStr(input.goal, MAX_GOAL)
  if (goal === null) return { ok: false, reason: 'invalid_goal' }
  const gate = input.gate === undefined ? '' : capStr(input.gate, MAX_GATE)
  if (gate === null) return { ok: false, reason: 'invalid_gate' }

  const now = opts.now ?? (() => Date.now())
  const ts = now()
  let eta: number | null = null
  if (input.eta !== undefined) {
    if (!validEta(input.eta, ts)) return { ok: false, reason: 'invalid_eta' }
    eta = Math.floor(input.eta)
  }

  const idGen = opts.idGen ?? (() => crypto.randomUUID())
  const id = idGen()
  try {
    const r = await env.DB.prepare(
      `INSERT INTO journeys (id, tenant, agent, project, goal, status, gate, eta, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 'boarding', ?6, ?7, ?8, ?8)`,
    )
      .bind(id, tenant, input.agent, input.project, goal, gate, eta, ts)
      .run()
    if ((r.meta?.changes ?? 0) === 0) return { ok: false, reason: 'db_error', detail: 'insert wrote 0 rows' }
    return { ok: true, id }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ── update: the SAME agent advances/exits its own flight ───────────────────────────────────────
export async function updateJourney(
  env: Env,
  id: string,
  agent: string,
  patch: UpdateInput,
  opts: Opts = {},
): Promise<UpdateResult> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }
  if (typeof id !== 'string' || id.length === 0 || typeof agent !== 'string' || agent.length === 0)
    return { ok: false, reason: 'not_found' }

  if (patch.status !== undefined && !STATUSES.includes(patch.status))
    return { ok: false, reason: 'invalid_status', detail: `status ∈ ${STATUSES.join('|')}` }
  let goal: string | undefined
  if (patch.goal !== undefined) {
    const g = capStr(patch.goal, MAX_GOAL)
    if (g === null) return { ok: false, reason: 'invalid_goal' }
    goal = g
  }
  let gate: string | undefined
  if (patch.gate !== undefined) {
    const g = capStr(patch.gate, MAX_GATE)
    if (g === null) return { ok: false, reason: 'invalid_gate' }
    gate = g
  }
  const now = opts.now ?? (() => Date.now())
  const ts = now()
  let eta: number | undefined
  if (patch.eta !== undefined) {
    if (!validEta(patch.eta, ts)) return { ok: false, reason: 'invalid_eta' }
    eta = Math.floor(patch.eta)
  }
  // Build a single conditional UPDATE. departed_at / arrived_at are stamped only on the FIRST
  // transition into that status (COALESCE keeps an earlier stamp). Ownership is enforced in the
  // WHERE (tenant + agent) — a non-owner / unknown id changes 0 rows → not_found (no ownership oracle).
  try {
    const r = await env.DB.prepare(
      `UPDATE journeys
          SET status      = COALESCE(?4, status),
              goal        = COALESCE(?5, goal),
              gate        = COALESCE(?6, gate),
              eta         = COALESCE(?7, eta),
              departed_at = CASE WHEN ?4 = 'departed' THEN COALESCE(departed_at, ?8) ELSE departed_at END,
              arrived_at  = CASE WHEN ?4 = 'arrived'  THEN COALESCE(arrived_at, ?8)  ELSE arrived_at  END,
              updated_at  = ?8
        WHERE id = ?1 AND tenant = ?2 AND agent = ?3`,
    )
      .bind(id, tenant, agent, patch.status ?? null, goal ?? null, gate ?? null, eta ?? null, ts)
      .run()
    if ((r.meta?.changes ?? 0) === 0) return { ok: false, reason: 'not_found' }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ── project authorization (write) ───────────────────────────────────────────────────────────
// A journey names its destination project as free text, so on its own the board lets any agent
// post under another customer's project name (P0, board dee4b1f4). The route calls this BEFORE
// boardJourney. Rule: an org admin may use any name (they can read every project anyway); anyone
// else must post for an agent whose squad holds write/admin on the project the name resolves to
// (project_squad_access). A name that resolves to no project and a project the squad has no access
// to are the SAME refusal, so the answer reveals nothing about which projects exist.
export async function canBoardUnderProject(
  env: Env,
  who: { isAdmin: boolean; agentId: string },
  project: string,
): Promise<boolean> {
  if (who.isAdmin) return true
  const agent = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1').bind(who.agentId).first<{ squad_id: string }>()
  if (!agent?.squad_id) return false
  const proj = await env.DB.prepare('SELECT id FROM projects WHERE LOWER(slug) = LOWER(?1) OR id = ?1 LIMIT 1')
    .bind(project)
    .first<{ id: string }>()
  if (!proj) return false
  return anySquadHasProjectWrite(env, proj.id, [agent.squad_id])
}

// ── list: read the board ───────────────────────────────────────────────────────────────────────
// `canSee` is REQUIRED: the board is only ever read through a caller's visibility (agentVisibility
// in src/mcp/provision.ts: org admin sees all, a bound agent sees itself, anyone else needs
// observer-or-above on the agent's squad). It is applied BEFORE the limit, by paging, so a hidden
// journey can neither take a slot nor change the response. A journey whose agent row is gone has no
// squad and is visible only to an org admin.
const LIST_PAGE = 200
const LIST_MAX_PAGES = 20
export async function listJourneys(
  env: Env,
  opts: { scope?: 'live' | 'all'; limit?: number; canSee: (agent: { id: string; squad_id: string }) => Promise<boolean> },
): Promise<JourneyRow[]> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return []
  let limit = DEFAULT_LIMIT
  if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
    limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit)))
  }
  const cols = 'j.id, j.tenant, j.agent, j.project, j.goal, j.status, j.gate, j.departed_at, j.eta, j.arrived_at, j.created_at, j.updated_at'
  const live = opts.scope === 'live' ? " AND j.status IN ('boarding','departed','delayed')" : ''
  const sql = `SELECT ${cols}, a.squad_id AS squad_id FROM journeys j LEFT JOIN agents a ON a.id = j.agent
                WHERE j.tenant = ?1${live} ORDER BY j.created_at DESC, j.id ASC LIMIT ?2 OFFSET ?3`
  const out: JourneyRow[] = []
  for (let page = 0; page < LIST_MAX_PAGES && out.length < limit; page++) {
    const rows = await env.DB.prepare(sql).bind(tenant, LIST_PAGE, page * LIST_PAGE).all<JourneyRow & { squad_id: string | null }>()
    const batch = rows.results ?? []
    for (const { squad_id, ...row } of batch) {
      if (out.length >= limit) break
      if (await opts.canSee({ id: row.agent, squad_id: squad_id ?? '' })) out.push(row)
    }
    if (batch.length < LIST_PAGE) break
  }
  return out
}

// ── board view model (pure — airport departures cards) ──────────────────────────────────────────
export type BoardPhase = 'BOARDING' | 'IN FLIGHT' | 'ARRIVED' | 'DELAYED' | 'CANCELLED'
const PHASE: Record<JourneyStatus, BoardPhase> = {
  boarding: 'BOARDING',
  departed: 'IN FLIGHT',
  arrived: 'ARRIVED',
  delayed: 'DELAYED',
  cancelled: 'CANCELLED',
}

export interface DepartureCard {
  id: string
  agent: string
  project: string
  goal: string
  status: JourneyStatus
  phase: BoardPhase
  live: boolean
  gate: string
  departed: string // "12m ago" | "—"
  eta: string // "in 20m" | "due" | "—"
  age: string // "3m ago"
}

function etaDisplay(eta: number | null, nowMs: number): string {
  if (eta == null) return '—'
  const delta = eta - nowMs
  return delta <= 0 ? 'due' : `in ${humanDur(delta)}`
}

export function buildDepartureBoard(rows: JourneyRow[], nowMs: number): DepartureCard[] {
  return rows.map((row) => {
    const phase = PHASE[row.status]
    return {
      id: row.id,
      agent: row.agent,
      project: row.project,
      goal: row.goal,
      status: row.status,
      phase,
      live: LIVE_STATUSES.has(row.status),
      gate: row.gate,
      departed: row.departed_at == null ? '—' : `${humanDur(nowMs - row.departed_at)} ago`,
      eta: etaDisplay(row.eta, nowMs),
      age: `${humanDur(nowMs - row.created_at)} ago`,
    }
  })
}
