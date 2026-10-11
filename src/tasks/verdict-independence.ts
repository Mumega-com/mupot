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

function directConflictSqlRaw(): string {
  return `(
    EXISTS (SELECT 1 FROM tasks dt WHERE dt.id = @T AND (dt.assignee_agent_id = @D OR dt.assignee_member_id = @D))
    OR EXISTS (SELECT 1 FROM task_result_submissions ds WHERE ds.task_id = @T AND ds.submitted_by_agent_id = @D)
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
    ))`)
  return `(\n    ${parts.join('\n    OR ')}\n  )`
}

export type VerdictConflictKind = 'direct' | 'affiliated'

/**
 * Compile a verdict-independence fragment to positional `?` SQL plus its params, in order of
 * appearance. `taskIdExpr` is either a bound id (pass `{ bind: taskId }`) or a raw correlated
 * column expression (pass `{ column: 'tasks.id' }`), never caller text.
 */
export function compileVerdictIndependenceSql(
  kinds: readonly VerdictConflictKind[],
  deciderId: string,
  task: { bind: string } | { column: string },
): { sql: string; params: string[] } {
  const raw = kinds.map((k) => (k === 'direct' ? directConflictSqlRaw() : affiliatedConflictSqlRaw())).join(' OR ')
  const params: string[] = []
  const sql = raw.replace(/@D|@T/g, (marker) => {
    if (marker === '@D') { params.push(deciderId); return '?' }
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
