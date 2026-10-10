// mupot — task_incident_revert MCP tool (mupot#1780 incident recovery, option C).
// Thin ToolSpec wrapper around src/tasks/incident-revert.ts (the guarded core).
//
// Gate: org-admin only, operator principal only (no agent-bound caller), exactly the archive_row
// bar (src/mcp/archive.ts requireOperatorOrgAdmin): an agent seat can never rewrite task history.
// Registering into TOOLS is the entire REST surface (generic POST /actions/:tool via invokeTool).

import type { AuthContext } from '../types'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import { ALL_TASK_STATUSES, isTaskStatus } from '../tasks/service'
import {
  INCIDENT_REVERT_MAX_ROWS,
  revertTasksForIncident,
  type RevertRowInput,
} from '../tasks/incident-revert'

function requireOperatorOrgAdmin(auth: AuthContext): ReturnType<typeof fail> | null {
  if (auth.boundAgentId) return fail(403, 'operator_principal_required')
  if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
  if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
  return null
}

const ROW_KEYS = ['task_id', 'expected_status', 'expected_assignee_agent_id', 'expected_updated_at'] as const

function parseRows(raw: unknown): { ok: true; rows: RevertRowInput[] } | { ok: false; detail: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, detail: 'rows must be a non-empty array' }
  if (raw.length > INCIDENT_REVERT_MAX_ROWS) {
    return { ok: false, detail: `rows is capped at ${INCIDENT_REVERT_MAX_ROWS}` }
  }
  const rows: RevertRowInput[] = []
  const seen = new Set<string>()
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, detail: `rows[${i}] must be an object` }
    }
    const rec = entry as Record<string, unknown> // narrowed object, keys validated below
    for (const k of Object.keys(rec)) {
      if (!(ROW_KEYS as readonly string[]).includes(k)) return { ok: false, detail: `rows[${i}].${k} is not a known field` }
    }
    const taskId = str(rec.task_id)
    const status = str(rec.expected_status)
    const updatedAt = str(rec.expected_updated_at)
    if (!taskId) return { ok: false, detail: `rows[${i}].task_id required` }
    // Any KNOWN status parses; the non-revertable ones are refused per row (status_not_revertable).
    if (!status || !isTaskStatus(status)) {
      return { ok: false, detail: `rows[${i}].expected_status must be one of ${ALL_TASK_STATUSES.join(', ')}` }
    }
    if (!updatedAt) return { ok: false, detail: `rows[${i}].expected_updated_at required` }
    if (!('expected_assignee_agent_id' in rec)) {
      return { ok: false, detail: `rows[${i}].expected_assignee_agent_id required (string or null)` }
    }
    const assignee = rec.expected_assignee_agent_id
    if (assignee !== null && !str(assignee)) {
      return { ok: false, detail: `rows[${i}].expected_assignee_agent_id must be a non-empty string or null` }
    }
    if (seen.has(taskId)) return { ok: false, detail: `rows[${i}].task_id is duplicated` }
    seen.add(taskId)
    rows.push({
      task_id: taskId,
      expected_status: status,
      expected_assignee_agent_id: assignee === null ? null : (assignee as string), // str() above proved a non-empty string
      expected_updated_at: updatedAt,
    })
  }
  return { ok: true, rows }
}

export const toolTaskIncidentRevert: ToolSpec = {
  name: 'task_incident_revert',
  scope: 'org',
  min: 'admin',
  args: '{ reason: string (1-2000), incident_ref: string (1-500), rows: [{ task_id, expected_status, expected_assignee_agent_id: string|null, expected_updated_at }] (1-50) }' +
    ' -- FOR AUDITED INCIDENT RECOVERY ONLY. org-admin only, operator principal only (no agent-bound caller).' +
    ' The audited exception to the task state machine (which has no edge back to open). Only blocked and' +
    ' in_progress rows are revertable; any other expected_status is refused per row as status_not_revertable.' +
    ' Per row, ONE guarded UPDATE sets status=open, assignee_agent_id=NULL, updated_at=now ONLY when status,' +
    ' assignee, updated_at all equal the expected values AND assignee_member_id IS NULL; a row that does not' +
    ' match is SKIPPED and reported drifted with its actual values, never forced. Also refused (drifted, with a' +
    ' reason): a live execution claim (live_execution_claim); an in_progress task that still holds an' +
    ' execution_receipt_id without an expired claim (runtime_held); a dispatch that can still be executed or' +
    ' redelivered, the archive_row predicate (in_flight_dispatch). A blocked task keeps the execution_receipt_id of' +
    ' its finished run and is NOT refused for that alone. Archived tasks are refused (archived). result,' +
    ' completed_at, cost_micro_usd, gate_owner and every other column are left untouched; the FULL pre-revert' +
    ' row is saved in task_incident_revert_receipts in the same batch. A row that throws is reported as outcome' +
    ' error and the rest continue. Outcomes: reverted | drifted | status_not_revertable | not_found | archived |' +
    ' error. This does NOT fence queued agent.wake events: pause the executing agent first.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      incident_ref: { type: 'string' },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: INCIDENT_REVERT_MAX_ROWS,
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            expected_status: { type: 'string', enum: [...ALL_TASK_STATUSES] },
            expected_assignee_agent_id: { type: ['string', 'null'] },
            expected_updated_at: { type: 'string' },
          },
          required: [...ROW_KEYS],
          additionalProperties: false,
        },
      },
    },
    required: ['reason', 'incident_ref', 'rows'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail
    // Tenant isolation: the principal's tenant must be this pot's tenant, and every statement
    // below runs on this pot's own D1 and stamps env.TENANT_SLUG on the receipt.
    if (auth.tenant !== env.TENANT_SLUG) return fail(403, 'forbidden', { need: 'same_tenant' })

    const reason = str(args.reason)
    if (!reason || reason.trim().length > 2000) return fail(400, 'invalid_args', 'reason must be 1-2000 characters')
    const incidentRef = str(args.incident_ref)
    if (!incidentRef || incidentRef.trim().length > 500) return fail(400, 'invalid_args', 'incident_ref must be 1-500 characters')
    const parsed = parseRows(args.rows)
    if (!parsed.ok) return fail(400, 'invalid_args', parsed.detail)

    const outcomes = await revertTasksForIncident(
      env,
      { incidentRef, reason, actorMemberId: auth.memberId as string }, // requireOperatorOrgAdmin proved memberId
      parsed.rows,
    )
    const count = (o: string): number => outcomes.filter((r) => r.outcome === o).length
    return done({
      incident_ref: incidentRef,
      reverted: count('reverted'),
      drifted: count('drifted'),
      not_found: count('not_found'),
      archived: count('archived'),
      status_not_revertable: count('status_not_revertable'),
      error: count('error'),
      receipt_ids: outcomes.flatMap((r) => (r.outcome === 'reverted' ? [r.receipt_id] : [])),
      rows: outcomes,
    })
  },
}

export const INCIDENT_REVERT_TOOLS: ToolSpec[] = [toolTaskIncidentRevert]
