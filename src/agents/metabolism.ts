// mupot — metabolism: the pot heartbeat that makes goal-bearing work-units MOVE.
//
// v0.3.0 gave each agent a goal-seeking loop (runGoalCycle), and AgentDO.alarm
// runs it on a self-perpetuating schedule — BUT only once an agent's alarm is set.
// A hibernating or never-woken agent has no alarm, so its loop never starts; and a
// DO alarm stops rescheduling when a cycle errors. So without a heartbeat, "set a
// unit's knobs and walk away" is inert — nothing fires the loop.
//
// The metabolism is that heartbeat. On each cron tick it KICKS every active,
// goal-bearing, not-yet-complete agent's DO /wake, which runs one runGoalCycle
// (metered) and (re)arms the agent's self-perpetuating alarm. This is the literal
// "constant small movement" — the thing that makes the pot feel alive and makes
// "design loops, not prompts" actually autonomous.
//
// ── Economic safety ────────────────────────────────────────────────────────────
// Each kick runs runGoalCycle, which already has its OWN per-agent daily meter gate
// (rate_limited → zero spend) and effort budget (effort=low → observe-only, no
// model call). The metabolism adds a second governor: it kicks at most
// MAX_AGENTS_PER_TICK agents per tick, ordered by least-recently-updated, so a
// large pot rotates across ticks instead of bursting. Goal-LESS agents are never
// kicked here — they have no autonomous loop and act only on explicit dispatch.

import type { Env } from '../types'

// Max agents kicked per cron tick. With more goal-bearing agents than this, the
// least-recently-updated are pulsed first, rotating fairly across ticks. The
// per-agent daily meter remains the hard spend ceiling regardless of this number.
export const MAX_AGENTS_PER_TICK = 25

export interface MetabolismResult {
  ok: boolean
  scanned: number // agents selected this tick
  kicked: number  // DO /wake calls that returned ok
  failed: number  // kicks that threw or returned non-ok
}

export interface MetabolismDeps {
  // Seam: select goal-bearing active agents to pulse this tick. Injectable for tests.
  selectAgents?: (env: Env, limit: number) => Promise<Array<{ id: string }>>
  // Seam: kick one agent's DO /wake. Injectable for tests (no DO in unit tests).
  kick?: (env: Env, agentId: string) => Promise<boolean>
}

/**
 * runMetabolism — one heartbeat tick. Best-effort: a failure selecting agents
 * returns a graceful {ok:false}; a failure kicking one agent is counted and does
 * NOT abort the sweep. Called from the Worker's scheduled() handler.
 */
export async function runMetabolism(env: Env, deps: MetabolismDeps = {}): Promise<MetabolismResult> {
  const select = deps.selectAgents ?? selectGoalBearingAgents
  const kick = deps.kick ?? kickAgentDO

  let agents: Array<{ id: string }>
  try {
    agents = await select(env, MAX_AGENTS_PER_TICK)
  } catch {
    // A failed selection must not crash the scheduled handler.
    return { ok: false, scanned: 0, kicked: 0, failed: 0 }
  }

  let kicked = 0
  let failed = 0
  for (const a of agents) {
    try {
      if (await kick(env, a.id)) kicked++
      else failed++
    } catch {
      failed++
    }
  }
  return { ok: true, scanned: agents.length, kicked, failed }
}

// Goal-bearing = active + non-empty OKR + kpi_progress < 100 (a met goal is left
// alone — runGoalCycle would no-op anyway). Ordered by updated_at ASC so the
// least-recently-touched agents pulse first (fair rotation when over the cap).
async function selectGoalBearingAgents(env: Env, limit: number): Promise<Array<{ id: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM agents
       WHERE status = 'active'
         AND dormant_reason IS NULL
         AND okr IS NOT NULL AND TRIM(okr) != ''
         AND kpi_progress < 100
       ORDER BY updated_at ASC
       LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>()
  return results ?? []
}

// Kick one agent via its Durable Object /wake (the same path the bus/IM/squad use).
// reason:'metabolism' drives a goal cycle (no task_id) and re-arms the alarm.
async function kickAgentDO(env: Env, agentId: string): Promise<boolean> {
  const stub = env.AGENT.get(env.AGENT.idFromName(agentId))
  const res = await stub.fetch('https://agent/wake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, reason: 'metabolism' }),
  })
  return res.ok
}
