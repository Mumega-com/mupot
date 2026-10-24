// dashboard/visible-flights — the ONE flight lister for dashboard surfaces (/flights, /status).
//
// Rule: a viewer sees a flight only if visibleFlight (src/mcp/flight-spine.ts, the MCP flight reader's
// check) says so: observer on EVERY squad in meta.squad_ids, plus a readable project. Workspace admins
// see the whole tenant.
//
// Two stages, so one noisy squad cannot crowd the viewer's own flights out of a capped scan:
//   1. SQL narrows to flights whose squads are all in the viewer's observer squads and whose project
//      (if any) is readable, BEFORE the row cap. This is a superset filter, never the authority.
//   2. visibleFlight runs on what is left. It stays the final word.
//
// D1 budget: visibleFlight costs about 5 + 2*squads queries (estimated) per flight. VERIFY_QUERY_BUDGET bounds the
// total per request (well under D1's 1000 per invocation); past it the scan stops and says so
// (scanLimited) rather than pretending the list is complete.
//
// Fail closed: if visibleFlight throws, this throws; no unchecked row is ever returned.
import type { AuthContext, Env } from '../types'
// Load the MCP tool registry first: flight-spine imports it cyclically (mcp/projects -> elevated-principal
// -> mcp/index), and entering that cycle from flight-spine leaves PROJECT_TOOLS uninitialised.
import '../mcp'
import { visibleFlight } from '../mcp/flight-spine'
import { hasWorkspaceAdmin } from '../auth/capability'
import { cancelledColumnSql } from '../flight/cancelled'
import { parseFlightMetaV1 } from '../flight/meta'
import { readableFlightSql } from '../flight/meta-sql'
import type { FlightRow, FlightStatus } from '../flight/service'
import { projectReadAccessFromGrants, projectVisibilityClause } from '../projects/access'
import { resolveGrantedSquadIds } from '../projects/readable-squads'

export const VERIFY_QUERY_BUDGET = 800
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export interface VisibleFlightsOptions {
  status?: FlightStatus
  limit?: number
}

export interface VisibleFlightsResult {
  rows: FlightRow[]
  /** Rows may be missing: the verification budget ran out, or fewer than `limit` survived while more matched. */
  scanLimited: boolean
  /** More flights matched than `limit` (the list is the newest `limit`, not everything). */
  more: boolean
}

function estimateVerifyCost(meta: string): number {
  let squads = 8 // unparseable meta: assume the largest allowed
  try {
    const parsed = parseFlightMetaV1(JSON.parse(meta))
    if (parsed) squads = parsed.squad_ids.length
  } catch {
    // keep the pessimistic default
  }
  return 5 + 2 * squads
}

export async function visibleFlights(
  env: Env,
  auth: AuthContext,
  opts: VisibleFlightsOptions = {},
): Promise<VisibleFlightsResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const admin = hasWorkspaceAdmin(auth)
  const statusSql = opts.status === undefined ? '' : 'AND f.status = ?'
  const statusBind = opts.status === undefined ? [] : [opts.status]

  if (admin) {
    const res = await env.DB.prepare(
      `SELECT f.*, ${cancelledColumnSql('f')}, a.name AS agent_name, s.name AS squad_name
         FROM flights f
         LEFT JOIN agents a ON a.id = f.agent
         LEFT JOIN squads s ON s.id = a.squad_id
        WHERE f.tenant = ? ${statusSql}
        ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    ).bind(env.TENANT_SLUG, ...statusBind, limit + 1).all<FlightRow>()
    const all = res.results ?? []
    return { rows: all.slice(0, limit), scanLimited: false, more: all.length > limit }
  }

  const grants = auth.capabilities ?? []
  const observerSquads = await resolveGrantedSquadIds(env, grants, 'observer')
  if (observerSquads.length === 0) return { rows: [], scanLimited: false, more: false }
  const project = projectVisibilityClause(projectReadAccessFromGrants(auth, grants))

  const res = await env.DB.prepare(
    `SELECT f.*, ${cancelledColumnSql('f')}, a.name AS agent_name, s.name AS squad_name
       FROM flights f
       LEFT JOIN agents a ON a.id = f.agent
       LEFT JOIN squads s ON s.id = a.squad_id
      WHERE f.tenant = ? ${statusSql}
        ${readableFlightSql('f', '?')}
        AND (f.project_id IS NULL OR EXISTS (
          SELECT 1 FROM projects p WHERE p.id = f.project_id AND ${project.sql}
        ))
      ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
  ).bind(
    env.TENANT_SLUG,
    ...statusBind,
    JSON.stringify([...new Set(observerSquads)]),
    ...project.binds,
    limit + 1,
  ).all<FlightRow>()
  const candidates = res.results ?? []
  const more = candidates.length > limit

  let spent = 0
  let budgetHit = false
  const examine: FlightRow[] = []
  for (const row of candidates.slice(0, limit)) {
    const cost = estimateVerifyCost(row.meta)
    if (spent + cost > VERIFY_QUERY_BUDGET) {
      budgetHit = true
      break
    }
    spent += cost
    examine.push(row)
  }
  const ok = await Promise.all(examine.map(async (r) => (await visibleFlight(env, auth, r.id)) !== null))
  const rows = examine.filter((_, i) => ok[i])
  return { rows, scanLimited: budgetHit || (more && rows.length < limit), more }
}
