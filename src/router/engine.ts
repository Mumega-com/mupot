// src/router/engine.ts — Edge-Native Active Router & Continuum Loop (FLIGHT-ROUTER / W3).
//
// Ports router.py to Cloudflare edge-native TypeScript execution:
// 1. Unassigned Task Discovery: scans open tasks with assignee_agent_id IS NULL.
// 2. Safety Guards:
//    - Filters GitHub webhook mirror event noise (`[GH <repo>] PR #...`).
//    - Filters HUMAN_ONLY decision/deploy/credential operations.
//    - Ambiguity detection: ambiguous keyword matches remain unassigned with human queue reasons.
// 3. Continuum Body & Active Seat Matching:
//    - Inspects live seats in D1 `presence` (status: active/live within lease_ttl_sec).
//    - Matches task capability requirement to live continuum bodies across harnesses:
//      * code/engineering/test -> Cursor / Codex / Grok CLI bodies
//      * audit/verification/docs -> Asha / Prime / Athena bodies
//      * comms/social/web -> Hermes / Mubot / WordPress bodies
// 4. Atomic Assignment & Wake:
//    - Assigns task to matched agent and emits `agent.wake` bus event over exact-seat mesh.

import type { Env, Task, BusEvent } from '../types'
import { createBus } from '../bus'

export const HUMAN_ONLY_KEYWORDS = [
  'decide', 'decision', 'countersign', 'approve', 'approval', 'policy', 'strategy',
  'pricing', 'hire', 'budget', 'legal', 'contract', 'owner', 'mint', 'revoke',
  'credential', 'token', 'secret', 'deploy', 'production', 'incident',
] as const

export const GH_MIRROR_RE = /^\[GH [^\]]+\] PR #\d+ /i

export interface LaneCapability {
  name: string
  continuumName: string
  preferredHarnesses: string[]
  keywords: string[]
}

export const CANONICAL_ROUTER_LANES: Record<string, LaneCapability> = {
  'tech-code': {
    name: 'tech-code',
    continuumName: 'river',
    preferredHarnesses: ['cursor-cloud', 'cursor-ide', 'claude-code', 'codex-desktop', 'grok-cli'],
    keywords: [
      'fix', 'bug', 'test', 'ci', 'migration', 'refactor', 'typecheck', 'guard',
      'gate', 'regression', 'schema', 'endpoint', 'route', 'worker', 'defect', 'feature',
      'fencing', 'delivery', 'router', 'build',
    ],
  },
  'builder-kasra': {
    name: 'builder-kasra',
    continuumName: 'kasra',
    preferredHarnesses: ['codex-desktop', 'cursor-ide', 'tmux'],
    keywords: [
      'merge', 'pr', 'release', 'worktree', 'pipeline', 'infra', 'compiler', 'engine',
    ],
  },
  'audit-athena': {
    name: 'audit-athena',
    continuumName: 'athena',
    preferredHarnesses: ['claude-code', 'cursor-cloud'],
    keywords: [
      'audit', 'verify', 'verification', 'inventory', 'docs', 'documentation',
      'readme', 'review', 'report', 'investigate', 'reconcile', 'triage', 'coherence',
    ],
  },
  'comms-hermes': {
    name: 'comms-hermes',
    continuumName: 'hermes',
    preferredHarnesses: ['hermes', 'telegram', 'openclaw'],
    keywords: [
      'telegram', 'chat', 'notify', 'announce', 'outreach', 'email', 'digest',
    ],
  },
}

export interface RouteMatchResult {
  lane: LaneCapability | null
  matchedKeywords: string[]
  reason: string
}

export interface RouterDecision {
  taskId: string
  taskTitle: string
  action: 'assigned' | 'skipped' | 'unrouted'
  assignedAgentId?: string
  assignedContinuum?: string
  reason: string
}

export interface RouterTickResult {
  scannedCount: number
  assignedCount: number
  skippedCount: number
  unroutedCount: number
  decisions: RouterDecision[]
}

/**
 * Pure classification of task text against lane keywords and safety guards.
 */
export function classifyTaskForRouting(
  title: string,
  body: string = '',
  lanes: Record<string, LaneCapability> = CANONICAL_ROUTER_LANES,
): RouteMatchResult {
  const cleanTitle = title.trim()
  if (GH_MIRROR_RE.test(cleanTitle)) {
    return {
      lane: null,
      matchedKeywords: [],
      reason: 'GitHub PR mirror notification — not actionable work; never route to a lane',
    }
  }

  const text = `${cleanTitle} ${body}`.toLowerCase()

  // 1. Check HUMAN_ONLY keywords first
  for (const humanWord of HUMAN_ONLY_KEYWORDS) {
    const re = new RegExp(`(?<![a-z0-9])${humanWord}(?![a-z0-9])`, 'i')
    if (re.test(text)) {
      return {
        lane: null,
        matchedKeywords: [humanWord],
        reason: `human-only signal "${humanWord}" — decisions, credentials and deploys are not delegated`,
      }
    }
  }

  // 2. Score lanes using word boundaries
  const hits: Array<{ lane: LaneCapability; count: number; matches: string[] }> = []

  for (const lane of Object.values(lanes)) {
    const matched: string[] = []
    for (const kw of lane.keywords) {
      const re = new RegExp(`(?<![a-z0-9])${kw}(?![a-z0-9])`, 'i')
      if (re.test(text)) {
        matched.push(kw)
      }
    }
    if (matched.length > 0) {
      hits.push({ lane, count: matched.length, matches: matched })
    }
  }

  if (hits.length === 0) {
    return {
      lane: null,
      matchedKeywords: [],
      reason: 'no lane keyword matched — needs human triage or a more descriptive title',
    }
  }

  hits.sort((a, b) => b.count - a.count)
  const top = hits[0]
  const second = hits.length > 1 ? hits[1] : null

  if (second && second.count === top.count) {
    return {
      lane: null,
      matchedKeywords: [...top.matches, ...second.matches],
      reason: `ambiguous match — ${top.lane.name} and ${second.lane.name} match equally (${top.matches.join(',')} vs ${second.matches.join(',')})`,
    }
  }

  return {
    lane: top.lane,
    matchedKeywords: top.matches,
    reason: `matched keywords: ${top.matches.join(', ')}`,
  }
}

export interface LivePresenceSeat {
  member_id: string
  agent_id: string | null
  seat: string
  harness: string
  continuum_name: string | null
  last_seen_at: string
}

/**
 * Scans active D1 presence and matches task to live continuum bodies.
 */
export async function runRouterTick(
  env: Env,
  options: { dryRun?: boolean; squadId?: string; limit?: number } = {},
): Promise<RouterTickResult> {
  const dryRun = options.dryRun !== false
  const limit = options.limit && options.limit > 0 ? options.limit : 50

  // 1. Fetch unassigned open tasks
  let taskQuery = `SELECT id, squad_id, title, body, status, priority, assignee_agent_id
                     FROM tasks
                    WHERE status = 'open' AND assignee_agent_id IS NULL`
  const params: unknown[] = []

  if (options.squadId) {
    taskQuery += ` AND squad_id = ?1`
    params.push(options.squadId)
  }
  taskQuery += ` ORDER BY created_at ASC LIMIT ?${params.length + 1}`
  params.push(limit)

  const taskRows = await env.DB.prepare(taskQuery).bind(...params).all<Task>()
  const tasks = taskRows.results ?? []

  // 2. Fetch live presence seats and agents
  const [presenceRows, agentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT member_id, agent_id, seat, harness, continuum_name, last_seen_at
         FROM presence
        WHERE tenant = ?1
          AND datetime(last_seen_at) >= datetime('now', '-300 seconds')`,
    ).bind(env.TENANT_SLUG).all<LivePresenceSeat>(),
    env.DB.prepare(
      `SELECT id, slug, name, squad_id, status FROM agents WHERE status = 'active'`,
    ).all<{ id: string; slug: string; name: string; squad_id: string }>(),
  ])

  const liveSeats = presenceRows.results ?? []
  const agents = agentRows.results ?? []

  const decisions: RouterDecision[] = []
  let assignedCount = 0
  let skippedCount = 0
  let unroutedCount = 0

  for (const task of tasks) {
    const match = classifyTaskForRouting(task.title, task.body)

    if (!match.lane) {
      if (match.reason.includes('GitHub PR mirror')) {
        skippedCount++
        decisions.push({ taskId: task.id, taskTitle: task.title, action: 'skipped', reason: match.reason })
      } else {
        unroutedCount++
        decisions.push({ taskId: task.id, taskTitle: task.title, action: 'unrouted', reason: match.reason })
      }
      continue
    }

    // Resolve target agent by continuum name on this task squad or any active agent matching continuum
    const targetContinuum = match.lane.continuumName
    const liveMatch = liveSeats.find((s) => s.continuum_name === targetContinuum || (s.agent_id && agents.some((a) => a.id === s.agent_id && a.slug.includes(targetContinuum))))

    let matchedAgent = agents.find((a) => a.squad_id === task.squad_id && a.slug.toLowerCase().includes(targetContinuum))
    if (!matchedAgent && liveMatch?.agent_id) {
      matchedAgent = agents.find((a) => a.id === liveMatch.agent_id)
    }
    if (!matchedAgent) {
      matchedAgent = agents.find((a) => a.slug.toLowerCase().includes(targetContinuum))
    }
    if (!matchedAgent && agents.length > 0) {
      matchedAgent = agents.find((a) => a.squad_id === task.squad_id) || agents[0]
    }

    if (!matchedAgent) {
      unroutedCount++
      decisions.push({
        taskId: task.id,
        taskTitle: task.title,
        action: 'unrouted',
        reason: `matched lane ${match.lane.name} (${targetContinuum}) but no active agent registered`,
      })
      continue
    }

    if (!dryRun) {
      const nowIso = new Date().toISOString()
      await env.DB.prepare(
        `UPDATE tasks
            SET assignee_agent_id = ?1,
                updated_at = ?2
          WHERE id = ?3 AND assignee_agent_id IS NULL`,
      )
        .bind(matchedAgent.id, nowIso, task.id)
        .run()

      // Emit wake event
      const wakeEvent: BusEvent<{ task_id: string; by: string }> = {
        type: 'agent.wake',
        tenant: env.TENANT_SLUG,
        squad_id: task.squad_id,
        agent_id: matchedAgent.id,
        payload: { task_id: task.id, by: 'router.edge' },
        ts: nowIso,
      }
      await createBus(env).emit(wakeEvent)
    }

    assignedCount++
    decisions.push({
      taskId: task.id,
      taskTitle: task.title,
      action: 'assigned',
      assignedAgentId: matchedAgent.id,
      assignedContinuum: targetContinuum,
      reason: `${match.reason} (assigned to ${matchedAgent.name} [${matchedAgent.id}])`,
    })
  }

  return {
    scannedCount: tasks.length,
    assignedCount,
    skippedCount,
    unroutedCount,
    decisions,
  }
}
