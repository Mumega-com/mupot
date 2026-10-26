// src/tasks/lenses.ts — review lens evidence for the owner-self verdict (mom-walk D1).
//
// An owner may decide their own agent's result only when the task's CURRENT submission carries two independent passing
// lenses (compileOwnerSelfLensesSql, src/tasks/verdict-independence.ts re-asserts them inside the verdict UPDATE). This is
// the WRITE side: an independent holder of the task's gate lane records one lens on the submission it actually reviewed.
// Nothing here decides eligibility for good: a row is only evidence, and the decision-time predicate re-judges the reviewer
// (lane still held, active, independent of the task, not owned by / bound to the deciding owner).

import type { AuthContext, Env } from '../types'
import { evaluateVerdictGates } from './index'
import { resolveVerdictSubmission } from './verdict-binding'

export type LensOutcome = 'pass' | 'fail'

export type RecordLensRefusal =
  | { ok: false; status: 404; error: 'task_not_found' }
  | { ok: false; status: 409; error: 'no_gate' | 'not_in_review' | 'dedicated_lane' | 'no_current_submission' | 'submission_mismatch' | 'lens_reviewer_not_independent' }
  | { ok: false; status: 403; error: 'forbidden' }
  | { ok: false; status: 400; error: 'invalid_lens' | 'invalid_outcome' }

export type RecordLensResult =
  | { ok: true; lens: { id: string; task_id: string; submission_id: string; lens: string; outcome: LensOutcome; reviewer_kind: 'agent' | 'member'; reviewer_id: string } }
  | RecordLensRefusal

export async function recordReviewLens(
  env: Env,
  auth: AuthContext,
  input: { taskId: string; lens: unknown; outcome: unknown; note?: string | null; expectedSubmissionId: string },
): Promise<RecordLensResult> {
  const lens = typeof input.lens === 'string' ? input.lens.trim() : ''
  if (lens.length < 1 || lens.length > 64) return { ok: false, status: 400, error: 'invalid_lens' }
  if (input.outcome !== 'pass' && input.outcome !== 'fail') return { ok: false, status: 400, error: 'invalid_outcome' }
  const outcome: LensOutcome = input.outcome

  const task = await env.DB.prepare('SELECT id, squad_id, status, gate_owner, assignee_agent_id FROM tasks WHERE id = ?1')
    .bind(input.taskId)
    .first<{ id: string; squad_id: string; status: string; gate_owner: string | null; assignee_agent_id: string | null }>()
  if (!task) return { ok: false, status: 404, error: 'task_not_found' }
  if (!task.gate_owner) return { ok: false, status: 409, error: 'no_gate' }
  if (task.status !== 'review') return { ok: false, status: 409, error: 'not_in_review' }
  // The self-completion lane and dedicated-predicate lanes have their own deciders; lenses are not their evidence.
  if (task.gate_owner === 'gate:agent-self-completion' || task.gate_owner === 'gate:office') return { ok: false, status: 409, error: 'dedicated_lane' }

  // The reviewer must hold the lane AND be independent of the task: the SAME predicate a verdict uses (evaluateVerdictGates).
  // 'rejected' is asked so the gate:loops send-surface cap (an approval-only rule) is not applied to a lens. A reviewer let
  // through only by a supervisory/owner waiver is a party to the work and is not an independent lens.
  const gate = await evaluateVerdictGates(
    env, auth,
    { id: task.id, squad_id: task.squad_id, gate_owner: task.gate_owner, assignee_agent_id: task.assignee_agent_id },
    'rejected',
  )
  if (!gate.allowed) {
    if (gate.code === 'self_verdict') return { ok: false, status: 409, error: 'lens_reviewer_not_independent' }
    return { ok: false, status: 403, error: 'forbidden' }
  }
  if (gate.independenceWaiver) return { ok: false, status: 409, error: 'lens_reviewer_not_independent' }
  // Human org-admin passes without holding the lane row; an eligible lens needs the lane held at count time, so refuse early.
  const kind = gate.principal.type
  if (kind !== 'agent' && kind !== 'member') return { ok: false, status: 403, error: 'forbidden' }
  const holds = await env.DB.prepare(
    `SELECT 1 FROM gate_grants WHERE capability = ?1 AND principal_type = ?2 AND principal_id = ?3 LIMIT 1`,
  ).bind(task.gate_owner, kind, gate.principal.id).first()
  if (!holds) return { ok: false, status: 403, error: 'forbidden' }

  const submission = await resolveVerdictSubmission(env, task.id)
  if (!submission) return { ok: false, status: 409, error: 'no_current_submission' }
  if (submission.submissionId !== input.expectedSubmissionId) return { ok: false, status: 409, error: 'submission_mismatch' }

  const id = crypto.randomUUID()
  // Written conditionally on the task STILL being in review on this submission and lane (a concurrent replace loses).
  const res = await env.DB.prepare(
    `INSERT INTO task_review_lenses (id, task_id, submission_id, result_digest, gate_owner, lens, reviewer_kind, reviewer_id, outcome, note, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
        WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?2 AND status = 'review' AND gate_owner = ?5)
          AND EXISTS (SELECT 1 FROM task_result_submissions s WHERE s.id = ?3 AND s.task_id = ?2)`,
  ).bind(id, task.id, submission.submissionId, submission.resultDigest, task.gate_owner, lens, kind, gate.principal.id, outcome,
    typeof input.note === 'string' ? input.note.slice(0, 2000) : null, new Date().toISOString()).run()
  if (!res.meta?.changes) return { ok: false, status: 409, error: 'not_in_review' }
  return { ok: true, lens: { id, task_id: task.id, submission_id: submission.submissionId, lens, outcome, reviewer_kind: kind, reviewer_id: gate.principal.id } }
}
