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
// admin bar deactivate_agent uses.

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
const OPTIONAL_BOOLEAN_SCHEMA = { type: 'boolean' }

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
    case 'live_credentials':
      return fail(409, 'live_credentials', { tokens: outcome.tokens, sessions: outcome.sessions })
    case 'active_dependents':
      return fail(409, 'active_dependents', outcome.counts)
    case 'live_execution_claim':
      return fail(409, 'live_execution_claim')
    case 'in_air_flight':
      return fail(409, 'in_air_flight')
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
  }
}

export const toolArchiveRow: ToolSpec = {
  name: 'archive_row',
  scope: 'org',
  min: 'admin',
  args: '{ table: "members"|"agents"|"squads"|"projects"|"tasks", id: string, reason: string, revoke?: boolean }' +
    ' -- org-admin only, operator principal only (no agent-bound caller).' +
    ' revoke: for members/agents with live tokens (and, for members, live web sessions),' +
    ' revoke them as part of this call instead of refusing with live_credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: [...ARCHIVABLE_TABLES] },
      id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      revoke: OPTIONAL_BOOLEAN_SCHEMA,
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

    const outcome = await archiveRow(env, {
      table: args.table as ArchivableTable,
      id,
      reason,
      actorMemberId: auth.memberId as string,
      revoke: Boolean(args.revoke),
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

    const outcome = await unarchiveRow(env, {
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

const TASK_STATUS_VALUES = ['open', 'in_progress', 'blocked', 'done', 'review', 'approved', 'rejected']

export const toolArchivePlanExpand: ToolSpec = {
  name: 'archive_plan_expand',
  scope: 'org',
  min: 'admin',
  args: '{ table: "tasks", where: { status?: string[], created_before?: string (ISO), project_ids?: string[] } }' +
    ' -- read-only. Returns the ids a bulk archive plan would touch, without archiving anything.',
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: ['tasks'] },
      where: {
        type: 'object',
        properties: {
          status: { type: 'array', items: { type: 'string', enum: TASK_STATUS_VALUES } },
          created_before: STRING_SCHEMA,
          project_ids: { type: 'array', items: { type: 'string' } },
        },
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
    const where = (args.where ?? {}) as {
      status?: unknown
      created_before?: unknown
      project_ids?: unknown
    }

    const clauses: string[] = ["ta.task_id IS NULL"] // never re-offer an already-archived task
    const binds: unknown[] = []
    let n = 1

    if (Array.isArray(where.status) && where.status.length > 0) {
      const placeholders = where.status.map(() => `?${n++}`).join(',')
      clauses.push(`t.status IN (${placeholders})`)
      binds.push(...where.status)
    }
    if (typeof where.created_before === 'string' && where.created_before.trim().length > 0) {
      clauses.push(`t.created_at < ?${n++}`)
      binds.push(where.created_before)
    }
    if (Array.isArray(where.project_ids) && where.project_ids.length > 0) {
      const placeholders = where.project_ids.map(() => `?${n++}`).join(',')
      clauses.push(`t.project_id IN (${placeholders})`)
      binds.push(...where.project_ids)
    }

    const sql = `SELECT t.id FROM tasks t
                  LEFT JOIN tasks_archive_state ta ON ta.task_id = t.id
                  WHERE ${clauses.join(' AND ')}
                  ORDER BY t.created_at ASC
                  LIMIT 5000`
    const { results } = await env.DB.prepare(sql).bind(...binds).all<{ id: string }>()
    const ids = results.map((r) => r.id)
    return done({ table: 'tasks', count: ids.length, ids })
  },
}

export const ARCHIVE_TOOLS: ToolSpec[] = [toolArchiveRow, toolUnarchiveRow, toolArchivePlanExpand]
