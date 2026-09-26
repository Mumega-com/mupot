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

import type { AuthContext } from '../types'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import {
  archiveRow,
  unarchiveRow,
  isArchivableTable,
  ARCHIVABLE_TABLES,
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
      // mupot#1496 Round 3 scope cut: task archiving left this PR — see
      // https://github.com/Mumega-com/mupot/issues/1571.
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
  args: '{ table: "members"|"agents"|"squads"|"projects"|"tasks", id: string, reason: string }' +
    ' -- org-admin only, operator principal only (no agent-bound caller).' +
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

    const outcome = await archiveRow(env, auth, {
      table: args.table as ArchivableTable,
      id,
      reason,
      actorMemberId: auth.memberId as string,
    })
    return archiveOutcomeToResult(outcome)
  },
}

export const toolUnarchiveRow: ToolSpec = {
  name: 'unarchive_row',
  scope: 'org',
  min: 'admin',
  args: '{ table: "members"|"agents"|"squads"|"projects"|"tasks", id: string, reason: string }' +
    ' -- org-admin only, operator principal only (no agent-bound caller).',
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
    if (gateFail) return gateFail

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

const TASK_STATUS_VALUES = ['open', 'in_progress', 'blocked', 'done', 'review', 'approved', 'rejected']

// mupot#1496 Round 3 scope cut (adversarial gate round 2): task archiving
// left this PR entirely — see archiveRow/unarchiveRow's file-header comment
// in src/hygiene/archive.ts and https://github.com/Mumega-com/mupot/issues/1571.
// archive_plan_expand's ONLY purpose was expanding a bulk TASK archive/
// unarchive plan, so it now refuses unconditionally rather than doing
// read-only work in service of a write path that no longer exists. Kept
// registered (not deleted) so the follow-up issue can re-enable it by
// reverting this one early-return, not by re-deriving the tool from scratch.
export const toolArchivePlanExpand: ToolSpec = {
  name: 'archive_plan_expand',
  scope: 'org',
  min: 'admin',
  args: '{ table: "tasks", mode?: "live"|"archived", where: { status: string[] (>=1), created_before: string (ISO, required), project_ids: string[] (>=1, required) } }' +
    ' -- NOT SUPPORTED (mupot#1496 Round 3 scope cut): task archiving left this PR.' +
    ' See https://github.com/Mumega-com/mupot/issues/1571. Always refuses 409 not_supported.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: ['tasks'] },
      mode: { type: 'string', enum: ['live', 'archived'] },
      where: {
        type: 'object',
        properties: {
          status: { type: 'array', items: { type: 'string', enum: TASK_STATUS_VALUES }, minItems: 1 },
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
  async run(auth) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail

    return fail(409, 'not_supported', { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' })
  },
}

export const ARCHIVE_TOOLS: ToolSpec[] = [toolArchiveRow, toolUnarchiveRow, toolArchivePlanExpand]
