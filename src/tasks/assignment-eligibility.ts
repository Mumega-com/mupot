import { executionPausedSql } from '../agents/execution-brake-sql'
import { nowSqlUtc } from '../auth/token-lifecycle'
import type { Env } from '../types'
import { independentGateHolderExistsSql } from './runtime-receipts'

interface AssignmentEligibilitySql {
  agentIdExpr: string
  gateOwnerExpr: string
  squadIdExpr: string
  tenantParam: string
  nowParam: string
}

/** Shared auto-assignment rule. Expressions are trusted SQL/parameters, never caller text.
 * Liveness, caller authority and squad/project access remain the writer's own contracts.
 * Embed this in the claim UPDATE as well as selection: read checks alone are advisory.
 */
export function assignmentEligibilitySql(p: AssignmentEligibilitySql): string {
  return `(
    EXISTS (
      SELECT 1 FROM agents assignment_agent
       WHERE assignment_agent.id = ${p.agentIdExpr}
         AND assignment_agent.status = 'active'
         AND NOT ${executionPausedSql('assignment_agent.id')}
    )
    AND (
      ${p.gateOwnerExpr} IS NULL
      OR ${p.gateOwnerExpr} = 'gate:agent-self-completion'
      OR ${independentGateHolderExistsSql({
        gateOwnerExpr: p.gateOwnerExpr, assigneeIdExpr: p.agentIdExpr, squadIdExpr: p.squadIdExpr,
        tenantParam: p.tenantParam, nowParam: p.nowParam, allowMemberHolders: true,
      })}
    )
  )`
}

/** Read-side form of the exact claim predicate, using the task's current gate and squad. */
export async function isAssignmentEligible(env: Env, taskId: string, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS eligible FROM tasks assignment_task
    WHERE assignment_task.id = ?1 AND ${assignmentEligibilitySql({
      agentIdExpr: '?2', gateOwnerExpr: 'assignment_task.gate_owner', squadIdExpr: 'assignment_task.squad_id',
      tenantParam: '?3', nowParam: '?4',
    })}`).bind(taskId, agentId, env.TENANT_SLUG, nowSqlUtc()).first()
  return row !== null
}

/** One eligibility read for an entire online roster, independent of its size. */
export async function getAssignmentEligibleAgentIds(env: Env, taskId: string, agentIds: readonly string[]): Promise<Set<string>> {
  const rows = await env.DB.prepare(`SELECT CAST(online_agent.value AS TEXT) AS id
    FROM tasks assignment_task CROSS JOIN json_each(?2) online_agent
    WHERE assignment_task.id = ?1 AND ${assignmentEligibilitySql({
      agentIdExpr: 'CAST(online_agent.value AS TEXT)', gateOwnerExpr: 'assignment_task.gate_owner', squadIdExpr: 'assignment_task.squad_id',
      tenantParam: '?3', nowParam: '?4',
    })}`).bind(taskId, JSON.stringify(agentIds), env.TENANT_SLUG, nowSqlUtc()).all<{ id: string }>()
  return new Set((rows.results ?? []).map(row => row.id))
}
