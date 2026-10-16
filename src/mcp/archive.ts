// mupot — archive_row / unarchive_row / archive_plan_expand MCP tools (#1496).
// Thin ToolSpec wrappers around src/hygiene/archive.ts's receipted core.
//
// REST: registering these into TOOLS (src/mcp/index.ts) is the ENTIRE REST
// surface — mcpActionsApp's generic `POST /actions/:tool` dispatches any
// registered tool through the SAME invokeTool seam a minted bearer can call
// directly (same pattern as team_bootstrap — see src/mcp/team-bootstrap.ts's
// file header). No separate route is written.
//
// Gate: org-admin only (hasWorkspaceAdmin), operator principal only (no
// agent-bound caller) — matching move_agent_squad/team_bootstrap's bar for a
// broad, cross-entity administrative action, not the narrower single-scope
// admin bar deactivate_agent uses. NOTE: this means an agent-bound bearer
// (including Kasra's own welded credential) can never call archive_row/
// unarchive_row/archive_plan_expand — applying a plan requires an unbound
// org-admin bearer or an operator dashboard session, not an agent seat.

import type { AuthContext, Env } from '../types'
import { chunkForD1InList } from '../lib/d1-in-list'
import { isTaskStatus, ALL_TASK_STATUSES } from '../tasks/service'
import { type ToolSpec, type ToolOutcome, fail, done, str, hasWorkspaceAdmin } from './index'
import type { ElevationGrantRecord } from '../auth/elevation'
import { memberOrElevatedAgent, withElevationReceipt, type ElevationTarget } from './elevated-principal'
import { proposeArchives, MAX_PROPOSE_IDS } from '../hygiene/archive-proposals'
import {
  archiveRow,
  unarchiveRow,
  isArchivableTable,
  ARCHIVABLE_TABLES,
  taskArchiveEnabled,
  type ArchivableTable,
} from '../hygiene/archive'

const STRING_SCHEMA = { type: 'string' }

function requireOperatorOrgAdmin(auth: AuthContext): ReturnType<typeof fail> | null {
  if (auth.boundAgentId) return fail(403, 'operator_principal_required')
  if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
  if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
  return null
}

function archiveOutcomeToResult(outcome: Awaited<ReturnType<typeof archiveRow>>) {
  if (outcome.ok) {
    if (outcome.status === 'already_archived') return done({ status: 'already_archived' })
    return done({ status: 'archived', receipt_id: outcome.receiptId, revoked: outcome.revoked })
  }
  switch (outcome.error) {
    case 'not_found':
      return fail(404, 'not_found')
    case 'invalid_reason':
      return fail(400, 'invalid_reason', 'reason must be 1-2000 characters')
    case 'active_dependents':
      return fail(409, 'active_dependents', outcome.counts)
    case 'live_execution_claim':
      return fail(409, 'live_execution_claim')
    case 'in_air_flight':
      return fail(409, 'in_air_flight')
    case 'in_flight_dispatch':
      // mupot#1571: an unsettled dispatch receipt would still be delivered by the bus consumer.
      return fail(409, 'in_flight_dispatch')
    case 'status_drift':
      // mupot#1571: the plan reviewed one status, the row now has another. Refused per row.
      return fail(409, 'status_drift', { expected: outcome.expected, actual: outcome.actual })
    case 'invalid_expected_status':
      return fail(400, 'invalid_expected_status', { accepted: outcome.accepted })
    case 'owns_active_agent':
      return fail(409, 'owns_active_agent', outcome.counts)
    case 'cannot_archive_self':
      return fail(409, 'cannot_archive_self')
    case 'cannot_affect_higher_rank':
      return fail(403, 'cannot_affect_higher_rank')
    case 'last_org_owner':
      return fail(409, 'last_org_owner')
    case 'must_deactivate_first':
      return fail(409, 'must_deactivate_first', { tool: outcome.tool })
    case 'not_supported':
      return fail(409, 'not_supported', { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' })
    case 'archive_refused_conflict':
      // mupot#1496 Round 4 (Athena confirmation-pass BLOCK): a 0-row guarded
      // write with no re-derivable refusal reason AND the row not actually
      // archived — an unexplained write conflict (e.g. a benign race), never
      // reported as a success. Caller should re-check state and retry.
      return fail(409, 'archive_refused_conflict')
  }
}

function unarchiveOutcomeToResult(outcome: Awaited<ReturnType<typeof unarchiveRow>>) {
  if (outcome.ok) {
    if (outcome.status === 'not_archived') return done({ status: 'not_archived' })
    return done({ status: 'unarchived', receipt_id: outcome.receiptId })
  }
  switch (outcome.error) {
    case 'not_found':
      return fail(404, 'not_found')
    case 'invalid_reason':
      return fail(400, 'invalid_reason', 'reason must be 1-2000 characters')
    case 'parent_archived':
      return fail(409, 'parent_archived', { parent: outcome.parent })
    case 'cannot_affect_higher_rank':
      return fail(403, 'cannot_affect_higher_rank')
    case 'not_supported':
      return fail(409, 'not_supported', { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' })
  }
}

export const toolArchiveRow: ToolSpec = {
  name: 'archive_row',
  scope: 'org',
  min: 'admin',
  args: '{ table: "members"|"agents"|"squads"|"projects"|"tasks", id: string, reason: string, expected_status?: string }' +
    ' -- org-admin only, operator principal only (no agent-bound caller).' +
    ' tasks: REQUIRES the pot to opt in with TASK_ARCHIVE_ENABLED=1; with it off, archive_row/unarchive_row on' +
    ' table=tasks return 409 not_supported {table, issue} (the other four tables are unaffected).' +
    ' An archived task accepts NO action (router/concierge claim, task_update,' +
    ' task_verdict, dispatch, runtime receipts, flight_dispatch all refuse it); refuses' +
    ' live_execution_claim and in_air_flight; expected_status (a plan\'s reviewed status) is' +
    ' re-checked inside the write and refused per row as status_drift; an unknown value is' +
    ' invalid_expected_status. unarchive restores tasks_archive_state.prior_status.' +
    ' members: archiving ALWAYS suspends the member and revokes its live tokens/web' +
    ' sessions/agent sessions; refuses cannot_archive_self, cannot_affect_higher_rank' +
    ' (the same #1337 rank-ceiling predicate PATCH /members/:id uses), last_org_owner,' +
    ' or owns_active_agent (an agent_member_bindings row, a live agent-bound' +
    ' member_tokens row, or agents.owner_member_id pointing at a status=active agent).' +
    ' agents: requires the agent already be status=inactive (call deactivate_agent' +
    ' first — this tool never deactivates implicitly). archive_refused_conflict: a 0-row' +
    ' write with no re-derivable refusal reason and the row not actually archived' +
    ' (an unexplained write conflict, e.g. a benign race) — re-check state and retry.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: [...ARCHIVABLE_TABLES] },
      id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      expected_status: STRING_SCHEMA,
    },
    required: ['table', 'id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail

    if (!isArchivableTable(args.table)) {
      return fail(400, 'invalid_args', `table must be one of ${ARCHIVABLE_TABLES.join(', ')}`)
    }
    const id = str(args.id)
    if (!id) return fail(400, 'invalid_args', 'id required')
    const reason = str(args.reason)
    if (!reason) return fail(400, 'invalid_args', 'reason required')
    if (args.expected_status !== undefined && (args.table !== 'tasks' || typeof args.expected_status !== 'string')) {
      return fail(400, 'invalid_args', 'expected_status is a string and applies to table=tasks only')
    }

    const outcome = await archiveRow(env, auth, {
      table: args.table as ArchivableTable,
      id,
      reason,
      actorMemberId: auth.memberId as string,
      ...(typeof args.expected_status === 'string' ? { expectedStatus: args.expected_status } : {}),
    })
    return archiveOutcomeToResult(outcome)
  },
}

// Tables an elevated agent may restore. Members/agents/tasks stay operator-only:
// a member restore is rank-sensitive and a task is not a project-lifecycle object.
const ELEVATED_UNARCHIVE_TABLES: readonly string[] = ['projects', 'squads']

// Marker appended to the receipt reason so the archive_receipts row names the
// elevation grant that authorized the restore (no schema change).
const ELEVATION_REASON_SUFFIX_MAX = 80

/**
 * An agent-bound unarchive_row caller (refused by requireOperatorOrgAdmin) may
 * restore a squad under a live action:project_status grant covering that
 * squad (an org grant covers non-home squads only), or a project under an
 * ORG-scope grant only. A covered table with no covering grant returns the
 * helper's refusal (with the request_elevation hint); any other table or no
 * member identity returns `null` and the caller falls through to the unchanged
 * refusal.
 */
async function elevatedUnarchive(
  auth: AuthContext,
  env: Env,
  args: Record<string, unknown>,
): Promise<{ grant: ElevationGrantRecord; table: ArchivableTable; id: string; reason: string } | { refusal: ToolOutcome } | null> {
  if (!auth.boundAgentId || !auth.memberId) return null
  if (typeof args.table !== 'string' || !ELEVATED_UNARCHIVE_TABLES.includes(args.table) || !isArchivableTable(args.table)) return null
  // Canonical (trimmed) id: authorized and written as the same value.
  const id = str(args.id)?.trim() ?? null
  const reason = str(args.reason)
  if (!id || !reason) return null
  if (reason.length > 2000 - ELEVATION_REASON_SUFFIX_MAX) {
    return { refusal: fail(400, 'invalid_reason', 'reason must be 1-2000 characters') }
  }
  // Target is exactly the row's own scope. A squad: ONLY {squad,id} (never {org}
  // first) so hasElevatedAction's home-squad fence runs; an org grant still covers
  // a non-home squad through it. A project: ORG scope only — a squad-scoped grant
  // (a squad admin's approval) never restores a project, same as project_create.
  const target: ElevationTarget = args.table === 'squads' ? { type: 'squad', id } : { type: 'org' }
  const acting = await memberOrElevatedAgent(auth, env, 'action:project_status', target, {
    toolName: 'unarchive_row',
    refusalCode: 'operator_principal_required',
    detail: { table: args.table, id },
    recordUsage: false,
  })
  if (!acting.ok) return { refusal: acting.outcome }
  if (acting.via !== 'elevation') return null
  return { grant: acting.grant, table: args.table, id, reason: `${reason} [elevation_grant:${acting.grant.id}]` }
}

export const toolUnarchiveRow: ToolSpec = {
  name: 'unarchive_row',
  scope: 'org',
  min: 'admin',
  args: '{ table: "members"|"agents"|"squads"|"projects"|"tasks", id: string, reason: string }' +
    ' -- org-admin only, operator principal only. The one exception: an agent-bound caller holding a live' +
    ' action:project_status elevation grant covering the squad (squads) or the org (projects) may restore' +
    ' table=projects or table=squads (the receipt reason records the grant id); every other table stays operator-only.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: [...ARCHIVABLE_TABLES] },
      id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['table', 'id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) {
      const elevated = await elevatedUnarchive(auth, env, args)
      if (!elevated) return gateFail
      if ('refusal' in elevated) return elevated.refusal
      const receipted = await withElevationReceipt(
        env, elevated.grant, 'unarchive_row', { table: elevated.table, id: elevated.id },
        (receiptId) => unarchiveRow(env, auth, {
          table: elevated.table,
          id: elevated.id,
          reason: elevated.reason,
          actorMemberId: auth.memberId as string, // as: elevatedUnarchive returns null unless auth.memberId is set
          elevationReceiptId: receiptId,
        }),
        (o) => (o.ok && o.status === 'unarchived' ? { applied: true } : { applied: false, code: o.ok ? 'noop_not_archived' : o.error }),
        { inBatch: true },
      )
      if (!receipted.began) return receipted.outcome
      const outcome = receipted.value
      return unarchiveOutcomeToResult(outcome)
    }

    if (!isArchivableTable(args.table)) {
      return fail(400, 'invalid_args', `table must be one of ${ARCHIVABLE_TABLES.join(', ')}`)
    }
    const id = str(args.id)
    if (!id) return fail(400, 'invalid_args', 'id required')
    const reason = str(args.reason)
    if (!reason) return fail(400, 'invalid_args', 'reason required')

    const outcome = await unarchiveRow(env, auth, {
      table: args.table as ArchivableTable,
      id,
      reason,
      actorMemberId: auth.memberId as string,
    })
    return unarchiveOutcomeToResult(outcome)
  },
}

// ── archive_plan_expand — read-only bulk-plan expansion ──────────────────────
// Scope: `tasks` ONLY. This is the one bulk-archive shape actually asked for
// (a "deep clean" board reset expanding a status/date/project filter into a
// concrete task-id list before the CLI loops archive_row over each id). The
// other four tables are archived one id at a time via archive_row directly —
// widening this to a generic filter DSL across all five tables is scope this
// brief did not ask for.
//
// ROUND 2 hardening (adversarial P1-5 on PR #1561): `where:{}` used to return
// EVERY non-archived task including client projects — now project_ids (non-
// empty) AND a valid ISO created_before AND at least one status are ALL
// required, so a plan can never accidentally be "everything". `mode` picks
// which side of tasks_archive_state to match: 'live' (default) for an
// archive plan, 'archived' for an unarchive plan — Round 1's expander always
// filtered to non-archived, so a bulk `--unarchive` plan silently expanded to
// the WRONG set (tasks that were never archived). The 5000-row cap now
// reports `truncated: true` instead of silently dropping rows past it.

const TASK_STATUS_VALUES: readonly string[] = ALL_TASK_STATUSES
const PLAN_EXPAND_LIMIT = 5000

// A conservative, no-dependency ISO-8601-ish check: YYYY-MM-DD, optionally
// with a T time component. Rejects garbage like 'zzzz' (which SQLite's
// string comparison against created_at would otherwise happily "match"
// everything against, since an un-parseable string still compares lexically).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/

export const toolArchivePlanExpand: ToolSpec = {
  name: 'archive_plan_expand',
  scope: 'org',
  min: 'admin',
  args: '{ table: "tasks", mode?: "live"|"archived", where: { status: string[] (>=1, known task statuses only), created_before: string (ISO, required), project_ids: string[] (>=1, required; any length) } }' +
    ' -- read-only. Requires TASK_ARCHIVE_ENABLED=1 (otherwise 409 not_supported, same as archive_row on tasks).' +
    ' Returns the tasks a bulk archive/unarchive plan would touch, without' +
    ' archiving anything. project_ids, created_before, and a non-empty status list are' +
    ' ALL required — there is no unscoped "match everything" shape. mode="live" (default)' +
    ' matches tasks with NO tasks_archive_state row (for an archive plan); mode="archived"' +
    ' matches tasks that already HAVE one (for an unarchive plan). `rows` carries each' +
    ' task\'s CURRENT status so the plan can pass it back as archive_row.expected_status' +
    ' (drift check at apply). Result reports truncated:true when more than 5000 rows matched.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: ['tasks'] },
      mode: { type: 'string', enum: ['live', 'archived'] },
      where: {
        type: 'object',
        properties: {
          status: { type: 'array', items: { type: 'string', enum: [...TASK_STATUS_VALUES] }, minItems: 1 },
          created_before: STRING_SCHEMA,
          project_ids: { type: 'array', items: STRING_SCHEMA, minItems: 1 },
        },
        required: ['status', 'created_before', 'project_ids'],
        additionalProperties: false,
      },
    },
    required: ['table', 'where'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail

    if (args.table !== 'tasks') return fail(400, 'unsupported_table', 'only table=tasks supports plan expansion')
    // Parity with archive_row/unarchive_row: a plan for an archive that cannot run is misleading.
    if (!taskArchiveEnabled(env)) {
      return fail(409, 'not_supported', { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' })
    }
    const mode = args.mode === 'archived' ? 'archived' : 'live'
    // `as`: args is Record<string, unknown>; every field of this shape is re-validated below
    // (array/string/ISO/enum checks) before any value is used, so the cast only names the shape.
    const where = (args.where ?? {}) as {
      status?: unknown
      created_before?: unknown
      project_ids?: unknown
    }

    if (!Array.isArray(where.status) || where.status.length === 0) {
      return fail(400, 'invalid_args', 'where.status must be a non-empty array')
    }
    // Unknown status values are rejected, not passed through: an unrecognised string would
    // match nothing and read as "no tasks to archive" (a success-shaped empty plan).
    const statuses: string[] = []
    for (const value of where.status) {
      if (typeof value !== 'string' || !isTaskStatus(value)) {
        return fail(400, 'invalid_status', { accepted: ALL_TASK_STATUSES })
      }
      statuses.push(value)
    }
    // Dedupe: repeated statuses would inflate the bind count past D1's 100-variable ceiling.
    const uniqueStatuses = Array.from(new Set(statuses))
    if (typeof where.created_before !== 'string' || !ISO_DATE_RE.test(where.created_before)) {
      return fail(400, 'invalid_args', 'where.created_before must be an ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)')
    }
    if (!Array.isArray(where.project_ids) || where.project_ids.length === 0) {
      return fail(400, 'invalid_args', 'where.project_ids must be a non-empty array')
    }
    const projectIds: string[] = []
    for (const value of where.project_ids) {
      if (typeof value !== 'string' || value.length === 0) return fail(400, 'invalid_args', 'where.project_ids must be non-empty strings')
      projectIds.push(value)
    }

    // D1 refuses >100 bound parameters per statement (mupot#1676). Statuses (<=7) + the date
    // + one project_ids chunk stay well under it; each chunk is its own statement, results are
    // merged, ordered and capped here (a task has exactly one project_id, so chunks are disjoint).
    const archivedClause = mode === 'archived' ? 'ta.task_id IS NOT NULL' : 'ta.task_id IS NULL'
    const statusPlaceholders = uniqueStatuses.map((_, i) => `?${i + 1}`).join(',')
    const dateIdx = uniqueStatuses.length + 1
    const merged: Array<{ id: string; status: string; created_at: string }> = []
    for (const chunk of chunkForD1InList(Array.from(new Set(projectIds)))) {
      const projectPlaceholders = chunk.map((_, i) => `?${dateIdx + 1 + i}`).join(',')
      const sql = `SELECT t.id, t.status, t.created_at FROM tasks t
                    LEFT JOIN tasks_archive_state ta ON ta.task_id = t.id
                    WHERE ${archivedClause}
                      AND t.status IN (${statusPlaceholders})
                      AND t.created_at < ?${dateIdx}
                      AND t.project_id IN (${projectPlaceholders})
                    ORDER BY t.created_at ASC, t.id ASC
                    LIMIT ${PLAN_EXPAND_LIMIT + 1}`
      const { results } = await env.DB.prepare(sql)
        .bind(...uniqueStatuses, where.created_before, ...chunk)
        .all<{ id: string; status: string; created_at: string }>()
      merged.push(...(results ?? []))
    }
    merged.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    const truncated = merged.length > PLAN_EXPAND_LIMIT
    const rows = (truncated ? merged.slice(0, PLAN_EXPAND_LIMIT) : merged).map((r) => ({ id: r.id, status: r.status }))
    return done({ table: 'tasks', mode, count: rows.length, truncated, ids: rows.map((r) => r.id), rows })
  },
}

// archive_propose: the AGENT half of /board/cleanup. Writes archive_proposals rows and nothing else; it never
// archives (archive_row stays operator-only, and the human page is the one place a proposal becomes an archive).
export const toolArchivePropose: ToolSpec = {
  name: 'archive_propose',
  scope: 'org',
  min: 'member',
  args: `{ task_ids: string[] (1-${MAX_PROPOSE_IDS}), reason: string, evidence?: string }` +
    ' -- agent-bound callers only. Proposes archiving tasks; NEVER archives. A human org admin reviews pending' +
    ' proposals at /board/cleanup and archives them there. The task\'s current status is recorded and re-checked at' +
    ' archive time (a task that moved is refused). Returns proposed / already_pending / not_proposable (missing, unreadable or archived: not told apart) / cap_reached (200 pending per agent). 409 not_supported when TASK_ARCHIVE_ENABLED is off.',
  inputSchema: {
    type: 'object',
    properties: {
      task_ids: { type: 'array', items: STRING_SCHEMA, minItems: 1, maxItems: MAX_PROPOSE_IDS },
      reason: STRING_SCHEMA,
      evidence: STRING_SCHEMA,
    },
    required: ['task_ids', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.boundAgentId) return fail(403, 'agent_principal_required')
    if (!Array.isArray(args.task_ids) || args.task_ids.some((v) => typeof v !== 'string')) {
      return fail(400, 'invalid_args', 'task_ids must be an array of strings')
    }
    const reason = str(args.reason)
    if (!reason) return fail(400, 'invalid_args', 'reason required')
    if (args.evidence !== undefined && typeof args.evidence !== 'string') return fail(400, 'invalid_args', 'evidence must be a string')
    const result = await proposeArchives(env, auth, {
      agentId: auth.boundAgentId,
      taskIds: args.task_ids as string[], // as: every element was just checked to be a string
      reason,
      evidence: typeof args.evidence === 'string' ? args.evidence : '',
    })
    if (!result.ok) return fail(result.error === 'not_supported' ? 409 : 400, result.error, result.detail)
    return done(result)
  },
}

export const ARCHIVE_TOOLS: ToolSpec[] = [toolArchiveRow, toolUnarchiveRow, toolArchivePlanExpand, toolArchivePropose]
