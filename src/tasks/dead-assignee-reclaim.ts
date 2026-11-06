import type { Env } from '../types'
import { agentLiveness, livenessSnapshotMatchesSql } from '../agents/liveness'
import { archiveBlockingDispatchExistsSql } from './runtime-receipts'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { sendAgentMessage } from '../agents/messages'
import { TASK_RECLAIM_SENDER } from '../agents/system-senders'

export const DEAD_ASSIGNEE_RECLAIM_AFTER_MS = 24 * 60 * 60 * 1000
export const DEAD_ASSIGNEE_RECLAIM_LIMIT = 25
interface TaskRow { id: string; status: string; assignee_agent_id: string; updated_at: string; execution_receipt_id: string | null; execution_claim_expires_at: number | null }
/** Same custody exclusions as terminal-flight disposition, without changing flight state. */
function noExecutionSql(): string {
  return `NOT (
    (t.execution_claim_expires_at IS NOT NULL AND t.execution_claim_expires_at > ?3)
    OR (t.execution_receipt_id IS NOT NULL AND NOT (t.execution_claim_expires_at IS NOT NULL AND t.execution_claim_expires_at <= ?3))
    OR ${archiveBlockingDispatchExistsSql({ tenantParam: '?2', taskIdExpr: 't.id' })}
    OR EXISTS (SELECT 1 FROM flights f WHERE f.tenant = ?2 AND f.status IN ('preflight','running','waiting','sleeping')
      AND json_valid(f.meta) AND t.id IN (SELECT value FROM json_each(f.meta, '$.task_ids')))
  )`
}
export const RECLAIM_NOTICE_PER_OWNER = 3
export const RECLAIM_NOTICE_PER_SWEEP = 25
export const RECLAIM_NOTICE_CANDIDATES = 200
interface ReclaimedNotice { task: TaskRow; owner: string | null; auditId: string }
async function notifyOwners(env: Env, records: ReclaimedNotice[], now: number): Promise<number> {
  const groups = new Map<string, ReclaimedNotice[]>()
  for (const record of records) if (record.owner) groups.set(record.owner,[...(groups.get(record.owner) ?? []),record])
  if (!groups.size) return 0
  let delivered = 0, attempted = 0
  const sweepId = crypto.randomUUID(), perOwner = new Map<string,number>()
  try {
    const targets = await env.DB.prepare(`SELECT a.id,a.owner_member_id FROM agents a JOIN members m ON m.id = a.owner_member_id
      WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.tenant = ?2 AND m.status = 'active' AND m.archived_at IS NULL
        AND a.status = 'active' AND a.archived_at IS NULL ORDER BY m.id,a.id LIMIT ?3`)
      .bind(JSON.stringify([...groups.keys()]),env.TENANT_SLUG,RECLAIM_NOTICE_CANDIDATES).all<{id:string;owner_member_id:string}>()
    const states = await agentLiveness(env,(targets.results ?? []).map(target=>target.id),now)
    for (const target of targets.results ?? []) {
      if (attempted >= RECLAIM_NOTICE_PER_SWEEP) break
      const owned = groups.get(target.owner_member_id)
      if (!owned || owned.some(record=>record.task.assignee_agent_id === target.id)) continue
      const state = states.get(target.id)
      if (state?.state !== 'live' || state.operatorPaused || !state.executionEligible) continue
      if ((perOwner.get(target.owner_member_id) ?? 0) >= RECLAIM_NOTICE_PER_OWNER) continue
      // Count attempted deliveries too: failures must not create an unbounded fanout.
      attempted++
      perOwner.set(target.owner_member_id,(perOwner.get(target.owner_member_id) ?? 0)+1)
      try {
        const sent = await sendAgentMessage(env,{fromAgent:TASK_RECLAIM_SENDER,fromMember:'system:dead-assignee-reclaim',
          toAgent:target.id,kind:'message',requestId:`task-reclaim:${sweepId}:${target.id}`.slice(0,128),
          body:JSON.stringify({type:'dead_assignee_reclaim_notice',notice:'These tasks were reopened after proven resident death with no execution custody. Informational; no reply is owed.',
            tasks:owned.map(record=>({task_id:record.task.id,agent_id:record.task.assignee_agent_id,audit_id:record.auditId}))})
        },{system:true,reason:'batched reclaim notice to a live agent owned by the affected owner'})
        if(sent.ok) delivered++
      } catch { /* a failed target cannot undo reclaim or block later owner targets */ }
    }
  } catch { /* owner lookup failure is best effort after committed reclaim */ }
  return delivered
}

/** Bounded, conditional reclaim. Unknown age, polling staleness and operator pause never establish death. */
export async function reclaimDeadAssignments(env: Env, opts: { nowMs?: number; limit?: number } = {}) {
  const now = opts.nowMs ?? Date.now(), iso = new Date(now).toISOString()
  const limit = Number.isFinite(opts.limit) ? Math.min(DEAD_ASSIGNEE_RECLAIM_LIMIT,Math.max(1,Math.floor(opts.limit!))) : DEAD_ASSIGNEE_RECLAIM_LIMIT
  const assigned = await env.DB.prepare(`SELECT DISTINCT t.assignee_agent_id AS id FROM tasks t
    WHERE t.assignee_agent_id IS NOT NULL AND t.assignee_member_id IS NULL AND t.status IN ('open','in_progress') AND ${TASK_NOT_ARCHIVED_SQL('t')}`)
    .all<{ id: string }>()
  const states = await agentLiveness(env,(assigned.results ?? []).map(row=>row.id),now)
  const dead = [...states.values()].filter(state=>state.state === 'dead' && state.mode === 'resident' && state.deadSinceMs !== null
    && state.deadSinceMs < now - DEAD_ASSIGNEE_RECLAIM_AFTER_MS && state.snapshot !== null)
  const result = { scanned: 0, reclaimed: 0, lost: 0, failed: 0, notified: 0 }
  const notices: ReclaimedNotice[] = []
  if (!dead.length) return result
  const tasks = await env.DB.prepare(`SELECT t.id,t.status,t.assignee_agent_id,t.updated_at,t.execution_receipt_id,t.execution_claim_expires_at FROM tasks t
    WHERE t.assignee_agent_id IN (SELECT value FROM json_each(?1)) AND t.status IN ('open','in_progress')
      AND t.assignee_member_id IS NULL AND ${TASK_NOT_ARCHIVED_SQL('t')} AND ${noExecutionSql()}
    ORDER BY t.updated_at,t.id LIMIT ?4`)
    .bind(JSON.stringify(dead.map(state=>state.agentId)),env.TENANT_SLUG,now,limit).all<TaskRow>()
  for (const task of tasks.results ?? []) {
    result.scanned++
    const state = states.get(task.assignee_agent_id)!
    const auditId = crypto.randomUUID(), request = `dead-assignee-reclaim:${auditId}`
    const where = `t.id = ?1 AND t.assignee_agent_id = ?4 AND t.status = ?5
      AND t.assignee_member_id IS NULL AND t.updated_at = ?6
      AND t.execution_receipt_id IS ?9 AND t.execution_claim_expires_at IS ?10 AND ${TASK_NOT_ARCHIVED_SQL('t')}
      AND ${noExecutionSql()} AND ${livenessSnapshotMatchesSql(env,{ tenant:'?2',agentId:'?4',snapshot:'?7',now:'?3' })}`
    try {
      const writes = await env.DB.batch([
        env.DB.prepare(`UPDATE tasks AS t SET assignee_agent_id = NULL,status = 'open',updated_at = ?8,
          execution_receipt_id = NULL,execution_claim_expires_at = NULL
          WHERE ${where} AND ${TASK_NOT_ARCHIVED_SQL('t')}`).bind(task.id,env.TENANT_SLUG,now,task.assignee_agent_id,task.status,task.updated_at,state.snapshot,iso,task.execution_receipt_id,task.execution_claim_expires_at),
        env.DB.prepare(`INSERT INTO mutation_audit_entries(id,tenant,principal_kind,principal_id,member_id,agent_id,
          origin,handler,operation,target_kind,target_id,task_id,request_id,evidence_json,recorded_at)
          SELECT ?1,?2,'system','dead-assignee-reclaim',?3,?4,'scheduled_job','dead-assignee-reclaim','dead_assignee_reclaim',
            'task',?5,?5,?6,?7,?8 WHERE changes() = 1`)
          .bind(auditId,env.TENANT_SLUG,state.ownerMemberId,task.assignee_agent_id,task.id,request,JSON.stringify({from_status:task.status,
            assignee_agent_id:task.assignee_agent_id,owner_member_id:state.ownerMemberId,dead_since_ms:state.deadSinceMs,
            previous_execution_receipt_id:task.execution_receipt_id,previous_execution_claim_expires_at:task.execution_claim_expires_at,
            reason:'dead_assignee',notice:'best_effort_owner_inboxes'}),iso),
      ])
      if (writes[0].meta.changes !== 1) { result.lost++; continue }
      result.reclaimed++
      notices.push({task,owner:state.ownerMemberId,auditId})
    } catch { result.failed++ }
  }
  result.notified = await notifyOwners(env,notices,now)
  return result
}
