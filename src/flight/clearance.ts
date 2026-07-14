// flight/clearance — the ATC tower: cross-flight collision detection (S196 follow-on).
//
// Motivating incident: two agent teams worked the SAME dispatch/runtime seam blind to
// each other — one built a dispatch→inbox bridge, the other owned the runtime-inbox
// cutover issue for the same seam — and only discovered the overlap by manually
// grepping branches after both had already committed work. Preflight (#60,
// flight/preflight.ts) answers "is THIS flight ready to fly" — a single-flight
// question. It has no notion of what OTHER flights are doing right now. Clearance is
// the second, orthogonal question: "does this flight's airspace overlap a flight
// already in the air." Two flights can each be individually ready (GO on preflight)
// and still collide — that is exactly what happened.
//
// SEVERITY MODEL (the key design call):
//   HOLD  — hard conflict. Two live flights share a task_id (same atomic unit of work
//           claimed twice = genuine double-work, one will fight the other for the same
//           outcome) OR share an artifact_ref (same file/PR/issue = direct
//           merge-collision risk — the literal shape of the motivating incident: two
//           branches editing the same seam). These block dispatch by default.
//   WARN  — soft, informational co-work signal, NOT a block. Two live flights sharing
//           only objective_id/goal_id/squad_ids (no task/artifact overlap) is normal
//           parallel collaboration toward one objective — expected and healthy.
//           Blocking it would be false-positive gridlock, so it is surfaced, not held.
// Reasoning: HOLD-level fields (task_ids, artifact_refs) are the fields a flight
// DECLARES it is actively touching — collision there means two flights are about to
// do (or already did) the same work or edit the same thing. WARN-level fields
// (objective_id/goal_id/squad_ids) describe SHARED CONTEXT, not shared WORK — many
// flights legitimately share an objective without ever touching the same task or file.
//
// FAIL-CLOSED CHOICE on unparseable meta: a flight whose meta fails to parse
// (parseFlightMetaV1 → null, or the stored JSON is invalid) is treated as OPAQUE — it
// can neither assert nor deny a collision, and is silently skipped from comparison
// (logged via console.warn). We rejected fail-closed-as-HOLD (would manufacture a
// phantom HOLD against every legacy/malformed flight and jam the tower for reasons
// unrelated to real work) and fail-open-as-ignored-without-logging (would silently
// hide a genuinely malformed flight from operators). Opaque-but-logged is the middle
// path: no phantom HOLDs, but the malformation is visible.
//
// KNOWN LIMITATIONS (v1 — this is an ADVISORY tower, NOT an authoritative atomic
// anti-double-work mutex). Do not treat a CLEAR as a hard guarantee that no other
// flight will touch the same work; it is a coordination signal, not a lock.
//   - ADVISORY / TOCTOU (F1): dispatch.ts reads live flights, checks clearance, then
//     inserts — three separate D1 calls, no transaction/unique-constraint. Two
//     dispatches within the read→insert window both read a set that excludes the other
//     and both CLEAR. Harmless for the real use case (collisions that unfold over
//     hours/days — the first row exists well before the second dispatch, so the HOLD
//     fires; and a lost race degrades to exactly the pre-clearance behavior, no
//     corruption). It is NOT safe as a real-time mutex for sub-second concurrent
//     dispatch. A DB-level task-claim guard is required before any workflow relies on
//     CLEAR as authoritative — tracked as a follow-up.
//   - NO REF NORMALIZATION (F3): overlap is exact-string equality. 'src/x.ts' vs
//     './src/x.ts' vs 'SRC/X.TS' do NOT collide. Callers MUST declare canonical refs
//     (repo-relative POSIX paths, canonical issue/PR refs) or the tower silently misses
//     the overlap.
//   - META-OMISSION BYPASS (F4): a flight that declares no scope (empty/absent meta) is
//     opaque and collides with nothing — an agent can do colliding work while declaring
//     no task_ids/artifact_refs and never be HELD. Inherent ceiling of self-declared
//     scope; the tower only sees what flights honestly declare.
//
// Pure, no I/O — same "derivation exported for tests, thin DB read at the call site"
// discipline as board.ts. See docs/flight-operations.md.

import type { FlightRow, FlightStatus } from './service'
import { parseFlightMetaV1, type FlightMetaV1 } from './meta'

export type ClearanceSeverity = 'hold' | 'warn'

export type CollisionReason =
  | 'shared_task_id'
  | 'shared_artifact_ref'
  | 'shared_objective'
  | 'shared_goal'
  | 'shared_squad'

export interface FlightCollision {
  severity: ClearanceSeverity
  flight_a_id: string
  flight_b_id: string
  reasons: CollisionReason[]
  shared_task_ids: string[]
  shared_artifact_refs: string[]
  shared_objective_id: string | null
  shared_goal_id: string | null
  shared_squad_ids: string[]
}

export interface ClearanceResult {
  cleared: boolean
  holds: FlightCollision[]
  warns: FlightCollision[]
}

// A flight is "live" (currently doing or about to do work) while pre-launch, in the
// air, or sleeping between legs — mirrors board.ts's LIVE_PHASES membership (kept as
// an independent literal set here to avoid a board.ts↔clearance.ts import cycle;
// board.ts imports FROM clearance.ts for deriveActiveCollisions, not the reverse).
// Terminal flights (landed/failed/held) cannot collide — they are not doing anything.
const LIVE_STATUSES: ReadonlySet<FlightStatus> = new Set<FlightStatus>(['preflight', 'running', 'waiting', 'sleeping'])

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b)
  return [...new Set(a.filter((x) => setB.has(x)))]
}

// Parse + validate a flight row's stored meta. Unparseable/invalid meta → null
// (opaque, logged) — see the module-level fail-closed-choice note above.
function parseRowMeta(row: FlightRow): FlightMetaV1 | null {
  let raw: unknown
  try {
    raw = JSON.parse(row.meta)
  } catch {
    console.warn('flight/clearance: unparseable meta JSON, treating flight as opaque (no collision asserted)', {
      flight_id: row.id,
    })
    return null
  }
  const meta = parseFlightMetaV1(raw)
  if (!meta) {
    console.warn('flight/clearance: meta failed FlightMetaV1 validation, treating flight as opaque (no collision asserted)', {
      flight_id: row.id,
    })
  }
  return meta
}

// Compare two flight metas (with their owning flight id + tenant) and return the
// collision between them, or null. Tenant is checked here as defense-in-depth even
// though callers are expected to already scope to one tenant (listFlights is
// tenant-scoped by its DB query) — a flight in another tenant must never collide.
function compareMeta(
  aId: string,
  aTenant: string,
  aMeta: FlightMetaV1,
  bId: string,
  bTenant: string,
  bMeta: FlightMetaV1,
): FlightCollision | null {
  if (aId === bId) return null
  if (aTenant !== bTenant) return null

  const sharedTaskIds = intersect(aMeta.task_ids, bMeta.task_ids)
  const sharedArtifactRefs = intersect(aMeta.artifact_refs, bMeta.artifact_refs)
  const sharedObjectiveId = aMeta.objective_id === bMeta.objective_id ? aMeta.objective_id : null
  const sharedGoalId = aMeta.goal_id === bMeta.goal_id ? aMeta.goal_id : null
  const sharedSquadIds = intersect(aMeta.squad_ids, bMeta.squad_ids)

  const hardReasons: CollisionReason[] = []
  if (sharedTaskIds.length > 0) hardReasons.push('shared_task_id')
  if (sharedArtifactRefs.length > 0) hardReasons.push('shared_artifact_ref')

  if (hardReasons.length > 0) {
    return {
      severity: 'hold',
      flight_a_id: aId,
      flight_b_id: bId,
      reasons: hardReasons,
      shared_task_ids: sharedTaskIds,
      shared_artifact_refs: sharedArtifactRefs,
      shared_objective_id: sharedObjectiveId,
      shared_goal_id: sharedGoalId,
      shared_squad_ids: sharedSquadIds,
    }
  }

  const softReasons: CollisionReason[] = []
  if (sharedObjectiveId) softReasons.push('shared_objective')
  if (sharedGoalId) softReasons.push('shared_goal')
  if (sharedSquadIds.length > 0) softReasons.push('shared_squad')
  if (softReasons.length === 0) return null

  return {
    severity: 'warn',
    flight_a_id: aId,
    flight_b_id: bId,
    reasons: softReasons,
    shared_task_ids: [],
    shared_artifact_refs: [],
    shared_objective_id: sharedObjectiveId,
    shared_goal_id: sharedGoalId,
    shared_squad_ids: sharedSquadIds,
  }
}

/**
 * Pairwise collision scan across a set of flights. Internally filters to LIVE statuses
 * and same-tenant pairs (defense-in-depth — safe even if a caller passes terminal
 * flights or a mixed-tenant array) and skips flights whose meta is opaque (see above).
 * O(n^2) over the input — fine at board scale (listFlights already caps at 500).
 */
export function detectFlightCollisions(flights: FlightRow[]): FlightCollision[] {
  const live = flights.filter((row) => LIVE_STATUSES.has(row.status))
  const parsed = live
    .map((row) => ({ row, meta: parseRowMeta(row) }))
    .filter((x): x is { row: FlightRow; meta: FlightMetaV1 } => x.meta !== null)

  const collisions: FlightCollision[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const a = parsed[i]
      const b = parsed[j]
      const collision = compareMeta(a.row.id, a.row.tenant, a.meta, b.row.id, b.row.tenant, b.meta)
      if (collision) collisions.push(collision)
    }
  }
  return collisions
}

/**
 * Check a PROPOSED (not-yet-created) flight's meta against currently active flights.
 * `cleared` is false iff at least one HOLD-level collision exists against a live,
 * same-tenant, non-ignored flight. `opts.tenant`, when given, additionally scopes the
 * comparison (defense-in-depth on top of the caller already tenant-scoping
 * `activeFlights`). `opts.ignoreFlightIds` is the override mechanism — an intentional
 * co-work flight that already knows about and accepts collision with specific active
 * flights can name them here to bypass the HOLD (see dispatch.ts `allowCollisionWith`).
 */
export function checkFlightClearance(
  proposed: FlightMetaV1,
  activeFlights: FlightRow[],
  opts: { tenant?: string; ignoreFlightIds?: string[] } = {},
): ClearanceResult {
  const ignore = new Set(opts.ignoreFlightIds ?? [])
  const proposedId = '__proposed__'
  const holds: FlightCollision[] = []
  const warns: FlightCollision[] = []

  for (const row of activeFlights) {
    if (!LIVE_STATUSES.has(row.status)) continue
    if (ignore.has(row.id)) continue
    if (opts.tenant != null && row.tenant !== opts.tenant) continue
    const meta = parseRowMeta(row)
    if (!meta) continue
    const tenant = opts.tenant ?? row.tenant
    const collision = compareMeta(proposedId, tenant, proposed, row.id, row.tenant, meta)
    if (!collision) continue
    if (collision.severity === 'hold') holds.push(collision)
    else warns.push(collision)
  }

  return { cleared: holds.length === 0, holds, warns }
}
