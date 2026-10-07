import { createBus } from '../bus'
import type { ExecutionScopeDecision } from '../auth/execution-scope'
import { nowSqlUtc } from '../auth/token-lifecycle'
import { hasIndependentRuntimeGate, independentGateHolderExistsSql } from '../tasks/runtime-receipts'
import type { BusEvent, Env } from '../types'

export interface RouterTickInput {
  squadId: string
  dryRun: boolean
  limit?: number
}

export interface RouterTickResult {
  squad_id: string
  dry_run: boolean
  scanned: number
  assigned: number
  unrouted: number
  decisions: Array<{
    task_id: string
    outcome: 'would_assign' | 'assigned' | 'unrouted' | 'lost_claim' | 'held_no_gate_holder'
    agent_id: string | null
    /** Set only for held_no_gate_holder: the gate_owner no independent holder can clear. */
    gate_owner?: string
  }>
}

type RouterDecision = Extract<ExecutionScopeDecision, { ok: true }>

interface RouterClaimAuthority {
  memberId: string
}

interface RouterTaskRow {
  id: string
  project_id: string | null
  project_routable: number
  gate_owner: string | null
}

interface RouterAgentRow {
  id: string
}

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 25
  return Math.min(50, Math.max(1, Math.floor(limit as number)))
}

/**
 * Run one explicitly-authorized squad router tick.
 *
 * The decision is issued before this function is entered. Every subsequent D1
 * read and mutation remains bound to that same server-resolved squad id.
 */
export async function runRouterTick(
  env: Env,
  decision: RouterDecision,
  input: RouterTickInput,
  authority: RouterClaimAuthority,
): Promise<RouterTickResult> {
  if (decision.squadId !== input.squadId || decision.tenant !== env.TENANT_SLUG) {
    throw new Error('router_scope_mismatch')
  }

  const squadId = decision.squadId
  const limit = boundedLimit(input.limit)
  const tasks = await env.DB.prepare(
    `SELECT t.id,
            t.project_id,
            t.gate_owner,
            CASE WHEN t.project_id IS NULL THEN 1
                 WHEN EXISTS (
                   SELECT 1
                     FROM projects p
                     JOIN project_squad_access psa
                       ON psa.project_id = p.id
                      AND psa.squad_id = t.squad_id
                      AND psa.access_level IN ('write', 'admin')
                    WHERE p.id = t.project_id
                      AND p.status = 'active'
                 ) THEN 1
                 ELSE 0 END AS project_routable
       FROM tasks t
      WHERE t.squad_id = ?1
        AND t.status = 'open'
        AND t.assignee_agent_id IS NULL
        -- mupot#1733 — a held task stays open+unassigned forever, so it must not occupy the
        -- bounded scan window (starvation). A real gate:* task is only scanned if SOME
        -- independent holder exists (assignee '' matches no agent: coarse, member+agent mode);
        -- the per-candidate hasIndependentRuntimeGate below is the precise test.
        AND (
          t.gate_owner IS NULL
          OR t.gate_owner = 'gate:agent-self-completion'
          OR ${independentGateHolderExistsSql({
            gateOwnerExpr: 't.gate_owner', assigneeIdExpr: "''", squadIdExpr: 't.squad_id',
            tenantParam: '?3', nowParam: '?4', allowMemberHolders: true,
          })}
        )
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT ?2`,
  ).bind(squadId, limit, decision.tenant, nowSqlUtc()).all<RouterTaskRow>()

  const decisions: RouterTickResult['decisions'] = []
  let assigned = 0
  let unrouted = 0

  for (const task of tasks.results ?? []) {
    if (task.project_routable !== 1) {
      unrouted += 1
      decisions.push({ task_id: task.id, outcome: 'unrouted', agent_id: null })
      continue
    }

    // mupot#1733 — pick the FIRST live agent (existing id order) that is independent of the
    // gate's holders; a gate held only by the lowest-id agent must not strand the task when
    // another live agent could take it. Hold only if none passes. null / self-completion
    // gates claim no independent holder, so the first live agent is taken as before.
    const candidates = await env.DB.prepare(
      `SELECT DISTINCT a.id
         FROM agents a
         JOIN presence p
           ON p.agent_id = a.id
          AND p.tenant = ?1
        WHERE a.squad_id = ?2
          AND a.status = 'active'
          AND p.last_seen_at >= datetime('now', '-10 minutes')
        ORDER BY a.id ASC
        LIMIT 50`,
    ).bind(decision.tenant, squadId).all<RouterAgentRow>()
    const live = candidates.results ?? []

    if (live.length === 0) {
      unrouted += 1
      decisions.push({ task_id: task.id, outcome: 'unrouted', agent_id: null })
      continue
    }

    // Same predicate task_dispatch uses (normal mode: independent agent OR human holder).
    // The claim UPDATE below does not re-assert it (TOCTOU on a revoked grant; documented).
    const gated = task.gate_owner !== null && task.gate_owner !== 'gate:agent-self-completion'
    let candidate: RouterAgentRow | undefined
    for (const agent of live) {
      if (
        !gated
        || await hasIndependentRuntimeGate(env, task.gate_owner, agent.id, squadId, { allowMemberHolders: true })
      ) { candidate = agent; break }
    }
    if (!candidate) {
      unrouted += 1
      decisions.push({ task_id: task.id, outcome: 'held_no_gate_holder', agent_id: null, gate_owner: task.gate_owner ?? undefined })
      console.error('router_tick: held, no eligible gate holder', { task_id: task.id, gate_owner: task.gate_owner })
      continue
    }

    if (input.dryRun) {
      decisions.push({ task_id: task.id, outcome: 'would_assign', agent_id: candidate.id })
      continue
    }

    const now = new Date().toISOString()
    const claim = await env.DB.prepare(
      `UPDATE tasks
          SET assignee_agent_id = ?1,
              updated_at = ?2
        WHERE id = ?3
          AND squad_id = ?4
          AND status = 'open'
          AND assignee_agent_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM squads actor_squad
             WHERE actor_squad.id = ?4
               AND (
                 EXISTS (
                   SELECT 1
                     FROM capabilities actor_grant
                    WHERE actor_grant.member_id = ?6
                      AND actor_grant.capability IN ('lead', 'admin', 'owner')
                      AND (
                        actor_grant.scope_type = 'org'
                        OR (actor_grant.scope_type = 'squad' AND actor_grant.scope_id = ?4)
                        OR (
                          actor_grant.scope_type = 'department'
                          AND actor_grant.scope_id = actor_squad.department_id
                        )
                      )
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM channel_capability_grants actor_channel_grant
                    WHERE actor_channel_grant.member_id = ?6
                      AND actor_channel_grant.squad_id = ?4
                      AND actor_channel_grant.capability IN ('lead', 'admin', 'owner')
                 )
               )
          )
          AND EXISTS (
            SELECT 1
              FROM agents a
              JOIN presence presence_now
                ON presence_now.agent_id = a.id
               AND presence_now.tenant = ?5
             WHERE a.id = ?1
               AND a.squad_id = ?4
               AND a.status = 'active'
               AND presence_now.last_seen_at >= datetime('now', '-10 minutes')
          )
          AND (
            project_id IS NULL
            OR EXISTS (
              SELECT 1
                FROM projects project_now
                JOIN project_squad_access access_now
                  ON access_now.project_id = project_now.id
                 AND access_now.squad_id = tasks.squad_id
                 AND access_now.access_level IN ('write', 'admin')
               WHERE project_now.id = tasks.project_id
                 AND project_now.status = 'active'
            )
          )`,
    ).bind(candidate.id, now, task.id, squadId, decision.tenant, authority.memberId).run()

    if (claim.meta.changes !== 1) {
      decisions.push({ task_id: task.id, outcome: 'lost_claim', agent_id: candidate.id })
      continue
    }

    const wake: BusEvent<{ task_id: string; reason: string }> = {
      type: 'agent.wake',
      tenant: decision.tenant,
      squad_id: squadId,
      agent_id: candidate.id,
      payload: { task_id: task.id, reason: 'router.tick' },
      ts: now,
    }
    await createBus(env).emit(wake)
    assigned += 1
    decisions.push({ task_id: task.id, outcome: 'assigned', agent_id: candidate.id })
  }

  return {
    squad_id: squadId,
    dry_run: input.dryRun,
    scanned: (tasks.results ?? []).length,
    assigned,
    unrouted,
    decisions,
  }
}
