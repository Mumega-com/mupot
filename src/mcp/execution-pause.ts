// mupot — execution_pause / execution_resume MCP tools (loop brake #2, "agents as themselves" step 1).
// Kill switch for autonomous execution of ONE agent or a WHOLE squad (incident 2026-10-09, mupot#1780:
// queued agent.wake messages cannot be recalled, so the stop must be checked where execution happens).
//
// While a pause is ACTIVE: the bus consumer's wakeAgent, AgentDO.wake (alarm, /wake, queued wakes) and
// the executor's claim UPDATE all refuse (src/agents/execution-brakes.ts). Resume clears it.
// SCOPE OF THE CLAIM: this stops IN-WORKER autonomous execution (and wake_agent) only. It does NOT stop
// inbox/poll delivery to an external runtime (send, task_dispatch to an inbox-routed agent): an external
// runtime that polls its inbox keeps receiving messages. It is a brake on the Worker-side executor,
// not a firewall around the agent.
//
// Gate: org-admin only, operator principal only (no agent-bound caller) — the archive_row pattern
// (src/mcp/archive.ts). An agent must never be able to pause or un-pause itself or a peer.
//
// Receipts: the execution_pauses row IS the receipt (who/when/why for pause AND resume), plus an
// append-only mutation_audit_entries row written in the SAME batch and anchored on the transition
// (INSERT ... SELECT ... WHERE changes() = 1), so an idempotent repeat writes no second audit row.

import type { AuthContext } from '../types'
import { releaseExecutionHold } from '../agents/execution-brakes'
import { canReleaseExecutionHold } from '../agents/execution-release-policy'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }
const SCOPES = ['agent', 'squad'] as const
type PauseScope = (typeof SCOPES)[number]

function isScope(v: unknown): v is PauseScope {
  return v === 'agent' || v === 'squad'
}

function requireOperatorOrgAdmin(auth: AuthContext): ReturnType<typeof fail> | null {
  if (auth.boundAgentId) return fail(403, 'operator_principal_required')
  if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
  if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
  return null
}

const REASON_MAX = 2000

function inputSchema() {
  return {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: [...SCOPES] },
      id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['scope', 'id', 'reason'],
    additionalProperties: false,
  }
}

interface ParsedArgs { scope: PauseScope; id: string; reason: string }

function parseArgs(args: Record<string, unknown>): ParsedArgs | ReturnType<typeof fail> {
  if (!isScope(args.scope)) return fail(400, 'invalid_args', `scope must be one of ${SCOPES.join(', ')}`)
  const id = str(args.id)
  if (!id) return fail(400, 'invalid_args', 'id required')
  const reason = str(args.reason)
  if (!reason) return fail(400, 'invalid_args', 'reason required')
  if (reason.length > REASON_MAX) return fail(400, 'invalid_reason', `reason must be 1-${REASON_MAX} characters`)
  return { scope: args.scope, id, reason }
}

function isParsed(v: ParsedArgs | ReturnType<typeof fail>): v is ParsedArgs {
  return 'scope' in v && 'reason' in v
}

export const toolExecutionPause: ToolSpec = {
  name: 'execution_pause',
  scope: 'org',
  min: 'admin',
  args: '{ scope: "agent"|"squad", id: string, reason: string }' +
    ' -- org-admin only, operator principal only (no agent-bound caller). Pauses IN-WORKER AUTONOMOUS' +
    ' EXECUTION of one agent (agents.id) or every agent in a squad (squads.id): the bus consumer, AgentDO' +
    ' wake/alarm, the executor claim, wake_agent and router_tick assignment all refuse the paused agent, so' +
    ' already-queued agent.wake messages become no-ops when consumed. This is NOT a kill switch for an' +
    ' external runtime: inbox/poll delivery (send, task_dispatch routed to an inbox) is NOT stopped and an' +
    ' external runtime keeps receiving it. Idempotent: an already-paused target returns already_paused' +
    ' (no second receipt). Does not unassign tasks.',
  inputSchema: inputSchema(),
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail
    const parsed = parseArgs(args)
    if (!isParsed(parsed)) return parsed
    const { scope, id, reason } = parsed

    const target = scope === 'agent'
      ? await env.DB.prepare(`SELECT id FROM agents WHERE id = ?1`).bind(id).first<{ id: string }>()
      : await env.DB.prepare(`SELECT id FROM squads WHERE id = ?1`).bind(id).first<{ id: string }>()
    if (!target) return fail(404, 'not_found')

    const now = new Date().toISOString()
    const pauseId = crypto.randomUUID()
    const memberId = auth.memberId as string // requireOperatorOrgAdmin guarantees non-null
    const evidence = JSON.stringify({ scope, id, reason, pause_id: pauseId })
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (scope_type, scope_id) WHERE resumed_at IS NULL DO NOTHING`,
      ).bind(pauseId, env.TENANT_SLUG, scope, id, reason, memberId, now),
      env.DB.prepare(
        `INSERT INTO mutation_audit_entries (
           id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, origin, handler, operation, target_kind, target_id,
           task_id, request_id, idempotency_key, evidence_json, recorded_at
         )
         SELECT ?1, ?2, 'member', ?3, ?3, NULL,
                NULL, 'mcp', 'execution_pause', 'pause', ?4, ?5,
                NULL, ?6, ?6, ?7, ?8
          WHERE changes() = 1`,
      ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, scope, id, pauseId, evidence, now),
    ])
    const inserted = (results[0]?.meta as { changes?: number } | undefined)?.changes === 1
    if (!inserted) return done({ status: 'already_paused', scope, id })
    return done({ status: 'paused', scope, id, receipt_id: pauseId })
  },
}

export const toolExecutionResume: ToolSpec = {
  name: 'execution_resume',
  scope: 'org',
  min: 'admin',
  args: '{ scope: "agent"|"squad", id: string, reason: string }' +
    ' -- org-admin only, operator principal only (no agent-bound caller). Ends the ACTIVE execution pause' +
    ' on that exact target. Idempotent: a target that is not paused returns not_paused. Resuming a squad' +
    ' does not clear a separate pause on one of its agents (and vice versa).',
  inputSchema: inputSchema(),
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail
    const parsed = parseArgs(args)
    if (!isParsed(parsed)) return parsed
    const { scope, id, reason } = parsed

    const now = new Date().toISOString()
    const memberId = auth.memberId as string // requireOperatorOrgAdmin guarantees non-null
    const requestId = crypto.randomUUID()
    const evidence = JSON.stringify({ scope, id, reason, resume_request_id: requestId })
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE execution_pauses
            SET resumed_at = ?3, resumed_by_member_id = ?4, resume_reason = ?5
          WHERE scope_type = ?1 AND scope_id = ?2 AND resumed_at IS NULL`,
      ).bind(scope, id, now, memberId, reason),
      env.DB.prepare(
        `INSERT INTO mutation_audit_entries (
           id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, origin, handler, operation, target_kind, target_id,
           task_id, request_id, idempotency_key, evidence_json, recorded_at
         )
         SELECT ?1, ?2, 'member', ?3, ?3, NULL,
                NULL, 'mcp', 'execution_pause', 'resume', ?4, ?5,
                NULL, ?6, ?6, ?7, ?8
          WHERE changes() = 1`,
      ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, scope, id, requestId, evidence, now),
    ])
    const resumed = (results[0]?.meta as { changes?: number } | undefined)?.changes === 1
    if (!resumed) return done({ status: 'not_paused', scope, id })
    return done({ status: 'resumed', scope, id, receipt_id: requestId })
  },
}

export const toolExecutionRelease: ToolSpec = {
  name: 'execution_release',
  scope: 'squad (of the task)',
  min: 'member', // the real bar (org-admin or squad-admin of the task's squad, human only) is enforced in run()
  args: '{ task_id: string, reason: string }' +
    ' -- HUMAN only: no agent-bound caller; org-admin or squad-admin of the task\'s squad. Releases the' +
    ' escalation HOLD that the executor retry ceiling (3 refused attempts per task, across all agents,' +
    ' dispatches and external runtimes) places on a task, and resets its refusal counter. A held task is out of' +
    ' executor pickup for EVERY agent and refused by task_dispatch (task_held) until released. ONE release policy' +
    ' (same bar everywhere): the only other release is a task_update / PATCH /tasks/:id assignment to an agent by a' +
    ' non-agent-bound human holding the SAME bar (org-admin or squad-admin of the task\'s squad); an assignment to an' +
    ' agent by anyone below that bar is refused with 409 task_held. Audited. Returns released | not_held.' +
    ' After releasing, assign/dispatch the task as usual. task_get shows execution_hold.',
  inputSchema: {
    type: 'object',
    properties: { task_id: STRING_SCHEMA, reason: STRING_SCHEMA },
    required: ['task_id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    const reason = str(args.reason)
    if (!reason) return fail(400, 'invalid_args', 'reason required')
    if (reason.length > REASON_MAX) return fail(400, 'invalid_reason', `reason must be 1-${REASON_MAX} characters`)

    const task = await env.DB.prepare(`SELECT id, squad_id FROM tasks WHERE id = ?1`).bind(taskId).first<{ id: string; squad_id: string }>()
    if (!task) return fail(404, 'not_found')
    if (!(await canReleaseExecutionHold(env, auth, task.squad_id))) return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })

    const outcome = await releaseExecutionHold(env, { taskId: task.id, memberId: auth.memberId, reason, via: 'execution_release' })
    return done({ status: outcome, task_id: task.id })
  },
}

export const EXECUTION_PAUSE_TOOLS: ToolSpec[] = [toolExecutionPause, toolExecutionResume, toolExecutionRelease]
