// src/tasks/verdict-independence.ts — policy rule 3: nobody gives a verdict on their own task.
//
// A LEAF module (imports only types) so both the verdict write path (src/tasks/service.ts) and the
// runtime-receipt path (src/tasks/runtime-receipts.ts) can share ONE copy of the predicate without
// an import cycle.

import type { Env } from '../types'
import { chunkForD1InList } from '../lib/d1-in-list'

/**
 * memberAffiliatedWithAssigneeSql (mupot#1663 P2) — TRUE iff the member is the
 * ASSIGNEE AGENT's owner (agents.owner_member_id), or bound to the assignee agent (agent_member_bindings: the
 * agent's own identity), or the member an assignee-agent key authenticates
 * as (agent_keys.member_id — the same signal memberOwnsAssigneeAgent /
 * hasConflictOfInterest use on the IM path). Such a member is not independent of the work: a
 * harness-attested human_origin verdict (mupot#1425) writes the verdict AS the
 * owner. This is THE exclusion — review entry (humanGateHolderExistsSql) and
 * every verdict writer (evaluateVerdictGates, which office_review_approval
 * also runs) call it; semantics mirror hasConflictOfInterest in
 * src/im/origin-verdict.ts. An agent with NO owner_member_id has nothing to
 * match on the owner side (falls back to the pre-existing rule).
 *
 * Deliberately NO email leg: an earlier draft also excluded "another member
 * row with the owner's email". That is a raw members.email authority match,
 * which the member-email-authority-lookup ratchet forbids outside the
 * canonical identity resolver, and the identity model (0143) binds a human to
 * a provider subject, never to an email. Known residual: one human holding two
 * member rows that share no owner/binding/key link is not excluded — tracked
 * on the follow-up issue, to be closed by a canonical same-human relation, not
 * by email.
 */
// mupot#2006: the human who ATTACHED a thread to the agent acted as it, so is affiliated with it. agent_seat_attachments
// rows persist after detach; an admission that went live and was later revoked counts too. pending/denied/expired
// admissions never attached anything ('expired' only comes from a pending admission lapsing in ensureAdmission; the
// 0220 trigger forbids live -> expired) and do not count: otherwise anyone could taint an independent reviewer by
// merely requesting an admission for the agent and letting it lapse.
export function memberAffiliatedWithAssigneeSql(p: { memberExpr: string; assigneeIdExpr: string }): string {
  return `EXISTS (
      SELECT 1
        FROM agents assignee_agent
       WHERE assignee_agent.id = ${p.assigneeIdExpr}
         AND (
           assignee_agent.owner_member_id = ${p.memberExpr}
           OR EXISTS (
             SELECT 1 FROM agent_member_bindings assignee_binding
              WHERE assignee_binding.agent_id = assignee_agent.id AND assignee_binding.member_id = ${p.memberExpr}
           )
           OR EXISTS (
             SELECT 1 FROM agent_keys assignee_key
              WHERE assignee_key.agent_id = assignee_agent.id AND assignee_key.member_id = ${p.memberExpr}
           )
           OR EXISTS (
             SELECT 1 FROM agent_seat_attachments assignee_attach
              WHERE assignee_attach.agent_id = assignee_agent.id AND assignee_attach.human_member_id = ${p.memberExpr}
           )
           OR EXISTS (
             SELECT 1 FROM agent_seat_admissions assignee_admission
              WHERE assignee_admission.agent_id = assignee_agent.id AND assignee_admission.human_member_id = ${p.memberExpr}
                AND assignee_admission.status IN ('live', 'revoked')
           )
           OR EXISTS (
             SELECT 1 FROM agent_seats assignee_seat
              WHERE assignee_seat.agent_id = assignee_agent.id AND assignee_seat.member_id = ${p.memberExpr}
           )
         )
    )`
}

/** JS form of the SAME fragment, for verdict writers (one predicate, two call shapes). */
export async function isMemberAffiliatedWithAssigneeAgent(
  env: Env,
  memberId: string,
  assigneeAgentId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 WHERE ${memberAffiliatedWithAssigneeSql({ memberExpr: '?1', assigneeIdExpr: '?2' })}`,
  ).bind(memberId, assigneeAgentId).first<{ 1: number }>()
  return row !== null
}

/**
 * VERDICT INDEPENDENCE (policy rule 3: nobody gives a verdict on their own task).
 *
 * The parties to a task's work are: its assignee (agent, or the human `assignee_member_id`), every
 * agent that SUBMITTED a result for it (task_result_submissions — the assignee at submit time,
 * who may since have been reassigned), and every agent / member recorded as RUNNING it
 * (task_dispatch_runtime_receipts). A decider conflicts with the task in two ways:
 *   - 'direct':     the decider id IS a party (same agent id, same member id);
 *   - 'affiliated': the decider is not a party but acts for one: a MEMBER who owns / is bound to /
 *                   holds the key of a party agent (memberAffiliatedWithAssigneeSql), or an AGENT
 *                   whose owner or bound member is the human assignee ("an agent acting for its
 *                   owner member").
 * One fragment per kind, parameterised on the decider id and the task id so the SAME text is the
 * JS pre-check (evaluateVerdictGates) and the write-time guard inside buildVerdictStatements'
 * UPDATE WHERE. `@D` / `@T` are decider / task-id markers resolved by compileVerdictIndependenceSql.
 */
// Only stages where the agent / credential member actually RAN the work make it a party.
// 'reset_terminated' is an operator's administrative marker (adminResetDispatchLease records the
// operator's member id on it); counting it would lock the admin who reset a lease out of deciding.
const RAN_STAGES = "pr.stage IN ('runtime_consumed', 'completed', 'failed')"

function partyAgentSources(): Array<{ from: string; agentCol: string }> {
  return [
    { from: 'tasks pt WHERE pt.id = @T AND pt.assignee_agent_id IS NOT NULL', agentCol: 'pt.assignee_agent_id' },
    { from: 'task_result_submissions ps WHERE ps.task_id = @T', agentCol: 'ps.submitted_by_agent_id' },
    { from: `task_dispatch_runtime_receipts pr WHERE pr.task_id = @T AND ${RAN_STAGES}`, agentCol: 'pr.agent_id' },
  ]
}

/**
 * agentLinkedToMemberSql (mupot#2009) — TRUE iff the AGENT is owned by, bound to, or keyed to the member.
 * ONE copy shared by the verdict check (directConflictSqlRaw: an agent decider linked to the submission's
 * consenting member) and review entry (independentGateHolderExistsSql: a gate-holder agent linked to the
 * consenting member is no eligible decider), so the two cannot drift. Raw SQL expressions only, never caller text.
 */
export function agentLinkedToMemberSql(p: { agentExpr: string; memberExpr: string }): string {
  return `(
        EXISTS (SELECT 1 FROM agents lk_owner WHERE lk_owner.id = ${p.agentExpr} AND lk_owner.owner_member_id = ${p.memberExpr})
        OR EXISTS (SELECT 1 FROM agent_member_bindings lk_bind WHERE lk_bind.agent_id = ${p.agentExpr} AND lk_bind.member_id = ${p.memberExpr})
        OR EXISTS (SELECT 1 FROM agent_keys lk_key WHERE lk_key.agent_id = ${p.agentExpr} AND lk_key.member_id = ${p.memberExpr})
        OR EXISTS (SELECT 1 FROM agent_seats lk_seat WHERE lk_seat.agent_id = ${p.agentExpr} AND lk_seat.member_id = ${p.memberExpr})
      )`
}

function directConflictSqlRaw(): string {
  return `(
    EXISTS (SELECT 1 FROM tasks dt WHERE dt.id = @T AND (dt.assignee_agent_id = @D OR dt.assignee_member_id = @D))
    OR EXISTS (SELECT 1 FROM task_result_submissions ds WHERE ds.task_id = @T AND ds.submitted_by_agent_id = @D)
    OR EXISTS (SELECT 1 FROM task_result_submissions cs WHERE cs.task_id = @T AND cs.consenting_member_id = @D)
    OR EXISTS (
      SELECT 1 FROM task_result_submissions ca WHERE ca.task_id = @T AND ca.consenting_member_id IS NOT NULL
        AND ${agentLinkedToMemberSql({ agentExpr: '@D', memberExpr: 'ca.consenting_member_id' })}
    )
    OR EXISTS (SELECT 1 FROM task_dispatch_runtime_receipts dr WHERE dr.task_id = @T AND dr.stage IN ('runtime_consumed', 'completed', 'failed') AND (dr.agent_id = @D OR dr.member_id = @D))
  )`
}

function affiliatedConflictSqlRaw(): string {
  const parts: string[] = []
  // A MEMBER decider who owns / is bound to / holds the key of a party agent. (An AGENT decider is
  // deliberately NOT matched through its own owner here: two agents sharing an owner may review
  // each other's work on their own authority; that pre-existing behaviour is pinned by
  // tests/task-verdict-human-origin.test.ts. The owner acting THROUGH a harness-attested origin is
  // a MEMBER decider and is caught by this leg.)
  for (const src of partyAgentSources()) {
    parts.push(`EXISTS (SELECT 1 FROM ${src.from} AND ${memberAffiliatedWithAssigneeSql({ memberExpr: '@D', assigneeIdExpr: src.agentCol })})`)
  }
  // An AGENT decider acting for the HUMAN who owns the task (tasks.assignee_member_id): the agent's
  // owner or bound member IS that member.
  parts.push(`EXISTS (SELECT 1 FROM tasks mt WHERE mt.id = @T AND mt.assignee_member_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM agents ma WHERE ma.id = @D AND ma.owner_member_id = mt.assignee_member_id)
      OR EXISTS (SELECT 1 FROM agent_member_bindings mb WHERE mb.agent_id = @D AND mb.member_id = mt.assignee_member_id)
      OR EXISTS (SELECT 1 FROM agent_seats ms WHERE ms.agent_id = @D AND ms.member_id = mt.assignee_member_id)
    ))`)
  return `(\n    ${parts.join('\n    OR ')}\n  )`
}

/**
 * OWNER-SELF AUTHORITY (mom-walk D1, task 7ae27377). The ONE narrow exemption from the 'affiliated' conflict for a
 * plain MEMBER decider: the human who OWNS the agent (agents.owner_member_id) may give the verdict on that agent's
 * work. TRUE iff, for EVERY party agent of the task (assignee, every submitter, every runner) the decider is
 * affiliated with, the decider is that agent's OWNER and is NOT bound to it (agent_member_bindings: a bound member IS
 * the agent's own identity, so deciding there is the agent grading itself). Any party agent the decider reaches by a
 * leg other than ownership alone (a key minter who is not the owner, a binding) makes this FALSE, so a non-owner who
 * merely minted a token for the agent (#2094) stays refused. It never speaks to the 'direct' kind: callers evaluate
 * 'direct' first and keep refusing it.
 */
function ownerSelfSqlRaw(): string {
  const parts = partyAgentSources().map((src) => `NOT EXISTS (
      SELECT 1 FROM ${src.from}
         AND ${memberAffiliatedWithAssigneeSql({ memberExpr: '@D', assigneeIdExpr: src.agentCol })}
         AND NOT (
           EXISTS (SELECT 1 FROM agents os_owner WHERE os_owner.id = ${src.agentCol} AND os_owner.owner_member_id = @D)
           AND NOT EXISTS (SELECT 1 FROM agent_member_bindings os_bind WHERE os_bind.agent_id = ${src.agentCol} AND os_bind.member_id = @D)
         )
    )`)
  return `(\n    EXISTS (SELECT 1 FROM members os_member WHERE os_member.id = @D AND os_member.status = 'active')\n    AND ${parts.join('\n    AND ')}\n  )`
}

export function compileOwnerSelfAuthoritySql(
  deciderId: string,
  task: { bind: string } | { column: string },
): { sql: string; params: string[] } {
  const params: string[] = []
  const sql = ownerSelfSqlRaw().replace(/@D|@T/g, (marker) => {
    if (marker === '@D') { params.push(deciderId); return '?' }
    if ('column' in task) return task.column
    params.push(task.bind)
    return '?'
  })
  return { sql, params }
}

/**
 * OWNER-SELF LENS EVIDENCE (mom-walk D1, Athena's conditions on task 565da9e9). An owner may decide their own agent's
 * work ONLY when the task's CURRENT submission carries two independent passing review lenses. The predicate (re-asserted
 * inside the verdict UPDATE's WHERE, so a revoked reviewer, a replaced submission, a re-gated task or an ownership change
 * between the pre-check and the write refuses atomically):
 *   - rows in task_review_lenses bound to THIS submission id AND result digest AND the task's CURRENT gate_owner
 *     (replacing the submission, or re-gating / changing the reviewer lane, orphans every earlier lens);
 *   - per (reviewer, lens) only the LATEST row counts (append-only ledger: a later 'fail' withdraws an earlier 'pass');
 *   - the reviewer is live-eligible NOW: still holds the gate lane, is active, is not the decider, is not a task party and
 *     does not act for one (verdict independence, both kinds), and is not owned by / bound to / keyed to the decider
 *     (self-authored evidence);
 *   - at least two DISTINCT reviewers with two DISTINCT lens names pass, and no eligible reviewer's latest lens is a fail.
 * `taskIdExpr`/`gateOwnerExpr` are raw correlated expressions; the submission id/digest and the decider are bound params.
 */
function ownerSelfLensesSqlRaw(): string {
  const latest = `l.rowid = (SELECT MAX(l2.rowid) FROM task_review_lenses l2
          WHERE l2.task_id = l.task_id AND l2.submission_id = l.submission_id AND l2.reviewer_id = l.reviewer_id AND l2.lens = l.lens)`
  const bound = `l.task_id = @T AND l.submission_id = @SUB AND l.result_digest = @DIG AND l.gate_owner = @GATE AND ${latest}`
  const independent = compileVerdictIndependenceSql(['direct', 'affiliated'], { column: 'l.reviewer_id' }, { column: '@T' })
  const eligible = `(
      l.reviewer_id <> @D
      AND NOT ${independent.sql}
      AND (
        (l.reviewer_kind = 'agent'
          AND EXISTS (SELECT 1 FROM agents la WHERE la.id = l.reviewer_id AND la.status = 'active')
          AND NOT ${agentLinkedToMemberSql({ agentExpr: 'l.reviewer_id', memberExpr: '@D' })})
        OR (l.reviewer_kind = 'member'
          AND EXISTS (SELECT 1 FROM members lm WHERE lm.id = l.reviewer_id AND lm.status = 'active'))
      )
      AND EXISTS (SELECT 1 FROM gate_grants lg WHERE lg.capability = @GATE AND lg.principal_type = l.reviewer_kind AND lg.principal_id = l.reviewer_id)
    )`
  return `(
    (SELECT COUNT(DISTINCT l.reviewer_id) FROM task_review_lenses l WHERE ${bound} AND l.outcome = 'pass' AND ${eligible}) >= 2
    AND (SELECT COUNT(DISTINCT l.lens) FROM task_review_lenses l WHERE ${bound} AND l.outcome = 'pass' AND ${eligible}) >= 2
    AND NOT EXISTS (SELECT 1 FROM task_review_lenses l WHERE ${bound} AND l.outcome = 'fail' AND ${eligible})
  )`
}

export function compileOwnerSelfLensesSql(
  deciderId: string,
  task: { taskIdExpr: string; gateOwnerExpr: string },
  submission: { submissionId: string; resultDigest: string },
): { sql: string; params: string[] } {
  const params: string[] = []
  const sql = ownerSelfLensesSqlRaw().replace(/@DIG|@SUB|@GATE|@D|@T/g, (marker) => {
    switch (marker) {
      case '@D': params.push(deciderId); return '?'
      case '@SUB': params.push(submission.submissionId); return '?'
      case '@DIG': params.push(submission.resultDigest); return '?'
      case '@T': return task.taskIdExpr
      default: return task.gateOwnerExpr
    }
  })
  return { sql, params }
}

/**
 * The whole owner-self verdict authority, JS form of the pair the verdict UPDATE re-asserts: live ownership
 * (compileOwnerSelfAuthoritySql) AND two independent passing lenses on the given CURRENT submission. A null submission
 * (no ledger row the verdict could bind to) fails closed: lenses are about a specific piece of content.
 */
export async function holdsOwnerSelfVerdictAuthority(
  env: Env,
  deciderId: string,
  taskId: string,
  submission: { submissionId: string; resultDigest: string } | null,
): Promise<boolean> {
  if (!submission) return false
  const own = compileOwnerSelfAuthoritySql(deciderId, { bind: taskId })
  const lens = compileOwnerSelfLensesSql(deciderId, { taskIdExpr: 'tasks.id', gateOwnerExpr: 'tasks.gate_owner' }, submission)
  const row = await env.DB.prepare(`SELECT ${own.sql} AND ${lens.sql} AS c FROM tasks WHERE tasks.id = ?`)
    .bind(...own.params, ...lens.params, taskId).first<{ c: number }>()
  return row !== null && Number(row.c) === 1
}

/** JS form of ownerSelfSqlRaw (one predicate, two call shapes). Call only after 'direct' has been ruled out. */
export async function holdsOwnerSelfAuthority(env: Env, deciderId: string, taskId: string): Promise<boolean> {
  const c = compileOwnerSelfAuthoritySql(deciderId, { bind: taskId })
  const row = await env.DB.prepare(`SELECT ${c.sql} AS c`).bind(...c.params).first<{ c: number }>()
  return row !== null && Number(row.c) === 1
}

export type VerdictConflictKind = 'direct' | 'affiliated'

/**
 * Compile a verdict-independence fragment to positional `?` SQL plus its params, in order of
 * appearance. `taskIdExpr` is either a bound id (pass `{ bind: taskId }`) or a raw correlated
 * column expression (pass `{ column: 'tasks.id' }`), never caller text.
 */
export function compileVerdictIndependenceSql(
  kinds: readonly VerdictConflictKind[],
  deciderId: string | { column: string },
  task: { bind: string } | { column: string },
): { sql: string; params: string[] } {
  const raw = kinds.map((k) => (k === 'direct' ? directConflictSqlRaw() : affiliatedConflictSqlRaw())).join(' OR ')
  const params: string[] = []
  const sql = raw.replace(/@D|@T/g, (marker) => {
    if (marker === '@D') {
      if (typeof deciderId !== 'string') return deciderId.column
      params.push(deciderId); return '?'
    }
    if ('column' in task) return task.column
    params.push(task.bind)
    return '?'
  })
  return { sql: `(${sql})`, params }
}

/**
 * JS form of the SAME fragments (one predicate, two call shapes — see isMemberAffiliatedWithAssigneeAgent).
 * Returns 'direct' when the decider is a party, 'affiliated' when it only acts for one, else null.
 */
export async function findVerdictIndependenceConflict(
  env: Env,
  deciderId: string,
  taskId: string,
): Promise<VerdictConflictKind | null> {
  const direct = compileVerdictIndependenceSql(['direct'], deciderId, { bind: taskId })
  const d = await env.DB.prepare(`SELECT ${direct.sql} AS c`).bind(...direct.params).first<{ c: number }>()
  if (d && Number(d.c) === 1) return 'direct'
  const aff = compileVerdictIndependenceSql(['affiliated'], deciderId, { bind: taskId })
  const a = await env.DB.prepare(`SELECT ${aff.sql} AS c`).bind(...aff.params).first<{ c: number }>()
  return a && Number(a.c) === 1 ? 'affiliated' : null
}


/**
 * Batch form for read-side listings (decorateApprovals, the attention queue): which of `taskIds`
 * conflict for `deciderId`, in ONE query per chunk instead of one per row. Same fragments as
 * findVerdictIndependenceConflict, so the read side cannot drift from the write guard.
 */
export async function findVerdictIndependenceConflicts(
  env: Env,
  deciderId: string,
  taskIds: readonly string[],
): Promise<Map<string, VerdictConflictKind | null>> {
  const out = new Map<string, VerdictConflictKind | null>()
  const unique = [...new Set(taskIds)]
  const direct = compileVerdictIndependenceSql(['direct'], deciderId, { column: 't.id' })
  const aff = compileVerdictIndependenceSql(['affiliated'], deciderId, { column: 't.id' })
  for (const chunk of chunkForD1InList(unique, undefined, direct.params.length + aff.params.length)) {
    const rows = await env.DB.prepare(
      `SELECT t.id AS id, ${direct.sql} AS d, ${aff.sql} AS a FROM tasks t WHERE t.id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...direct.params, ...aff.params, ...chunk).all<{ id: string; d: number; a: number }>()
    for (const r of rows.results ?? []) {
      out.set(r.id, Number(r.d) === 1 ? 'direct' : Number(r.a) === 1 ? 'affiliated' : null)
    }
    for (const id of chunk) if (!out.has(id)) out.set(id, null)
  }
  return out
}
