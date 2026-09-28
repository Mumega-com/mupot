// mupot — MCP tools for the mcpwp-office addon (mupot#1580 slice 2 / T2).
//
// Named exactly as the manifest's authorityRequests.surfaceGrants declared them
// (src/addons/office/manifest.ts): office.publish_post, office.list_pending_approvals,
// office.review_approval. All business logic lives in src/addons/office/service.ts —
// this file is arg-schema validation, task resolution, and error-status mapping only,
// the same split workflow-circuits.ts uses for src/addons/workflow-circuits/service.ts.
//
// office.publish_post is the one WRITE: it requires an approved, non-self, non-reversed
// task_verdict on an office-gated task (gate_owner = 'gate:office') before any fetch —
// see service.ts's publishOfficePost for the exact ordering (content-binding check,
// then capability, then addon/connector liveness, all BEFORE the WordPress call).
//
// P0-1/P1-1 (kasra-review + Athena, PR #1588 round 1): publish_post takes NO
// title/content from its caller (see toolOfficePublishPost's inputSchema below) —
// it publishes ONLY the payload office.review_approval froze at approval time
// (office_publish_freezes), and atomically claims that one-shot approval BEFORE
// any fetch, so one human approval can never authorize more than one write.

import { getTask, type ToolSpec, fail, done, str } from './index'
import type { AuthContext } from '../types'
import {
  listOfficePendingApprovals,
  publishOfficePost,
  reviewOfficeApproval,
  type OfficeRefusalReason,
} from '../addons/office/service'
import '../addons/office/manifest'

const STRING_SCHEMA = { type: 'string' }

function officeFailureStatus(reason: OfficeRefusalReason): 400 | 403 | 404 | 409 {
  switch (reason) {
    case 'not_authorized':
    case 'self_verdict':
    case 'agent_approval_forbidden':
      return 403
    case 'task_not_found':
      return 404
    case 'addon_inactive':
    case 'connector_not_bound':
    case 'connector_capability_mismatch':
    case 'department_not_active':
    case 'wrong_gate':
    case 'not_in_review':
    case 'not_approved':
    case 'payload_not_frozen':
    case 'binding_changed':
    case 'publish_claimed':
    case 'invalid_site_config':
    case 'invalid_site_url':
    case 'unreachable':
    case 'key_invalid':
    case 'redirect_blocked':
    case 'bad_response':
    case 'write_failed':
    case 'verdict_race':
      return 409
    default:
      return 400
  }
}

const toolOfficePublishPost: ToolSpec = {
  name: 'office.publish_post',
  scope: 'department:office (lead) — WRITE, gated on an approved task_verdict',
  min: 'member',
  // P0-1 (kasra-review + Athena, PR #1588 round 1): title/content are DELIBERATELY
  // NOT accepted here anymore. A human approval must authorize exactly one write
  // with exactly the content that was approved — office.review_approval freezes
  // task.title/task.body (plus the installation/connector/site) at approval time
  // (src/addons/office/service.ts's office_publish_freezes), and this tool publishes
  // ONLY that frozen payload. additionalProperties:false below means a caller that
  // still passes title/content gets a hard 400 invalid_args (unknown field), never a
  // silent ignore — see tests/mcpwp-office-tools.test.ts.
  args: '{ task_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth: AuthContext, env, args) {
    const taskRef = str(args.task_id)
    if (!taskRef) return fail(400, 'invalid_args', 'task_id required')

    const taskRes = await getTask(env, taskRef)
    if (!taskRes.ok) return taskRes
    const result = await publishOfficePost(env, auth, { task: taskRes.task })
    if (!result.ok) return fail(officeFailureStatus(result.reason), result.reason)
    return done({ post_id: result.value.postId, article_url: result.value.articleUrl })
  },
}

const toolOfficeListPendingApprovals: ToolSpec = {
  name: 'office.list_pending_approvals',
  scope: 'department:office (member) — read-only',
  min: 'member',
  args: '{ limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number' } },
    required: [],
    additionalProperties: false,
  },
  async run(auth: AuthContext, env, args) {
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const result = await listOfficePendingApprovals(env, auth, limit)
    if (!result.ok) return fail(officeFailureStatus(result.reason), result.reason)
    return done({ tasks: result.value })
  },
}

const toolOfficeReviewApproval: ToolSpec = {
  name: 'office.review_approval',
  scope: 'squad (of the office task) — the office-gate verdict decision',
  min: 'member',
  args: '{ task_id: string, verdict: "approved"|"rejected", note?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      verdict: STRING_SCHEMA,
      note: STRING_SCHEMA,
    },
    required: ['task_id', 'verdict'],
    additionalProperties: false,
  },
  async run(auth: AuthContext, env, args) {
    const taskRef = str(args.task_id)
    if (!taskRef) return fail(400, 'invalid_args', 'task_id required')
    const verdict = args.verdict
    if (verdict !== 'approved' && verdict !== 'rejected') {
      return fail(400, 'invalid_verdict', { accepted: ['approved', 'rejected'] })
    }
    const note = str(args.note)

    const taskRes = await getTask(env, taskRef)
    if (!taskRes.ok) return taskRes
    const result = await reviewOfficeApproval(env, auth, { task: taskRes.task, verdict, note })
    if (!result.ok) return fail(officeFailureStatus(result.reason), result.reason)
    return done({ task: result.value.task })
  },
}

export const OFFICE_TOOLS: ToolSpec[] = [
  toolOfficePublishPost,
  toolOfficeListPendingApprovals,
  toolOfficeReviewApproval,
]
