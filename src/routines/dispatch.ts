import type { D1Result } from '@cloudflare/workers-types'
import { sendAgentMessage as sendMessage } from '../agents/messages'
import { hasCapability } from '../auth/capability'
import { mcpEndpoint } from '../dashboard/connect'
import { applyPreflight, createFlight, failFlight, FlightCreateFenceError } from '../flight/service'
import { FLIGHT_META_V1_SCHEMA, parseFlightMetaV1, type FlightMetaV1 } from '../flight/meta'
import { getFleetAgentRuntimeStates } from '../fleet/registry'
import { canonicalJsonDigest, sha256Hex } from '../lib/canonical-json'
import { loadProjectSituation } from '../projects/situation'
import { createTask, TaskCreateFenceError } from '../tasks/service'
import type { CapabilityGrant, Env, Project, Task } from '../types'
import type { RoutinePolicySnapshot } from './types'
import { sqlNotCancellationPending } from './cancellation-fence'

const ROUTINE_SENDER = 'mupot-routines'
const ROUTINE_MEMBER = 'system:routines'
const CANDIDATE_LIMIT = 20

interface DispatchRunRow {
  id: string
  tenant: string
  project_id: string
  routine_id: string
  routine_revision: number
  policy_json: string
  status: string
  waiting_reason: string | null
  attempt: number
  task_id: string | null
  flight_id: string | null
  situation_digest: string | null
  assigned_agent_id: string | null
  cost_micro_usd: number
  objective: string
  routine_status: string
  current_routine_revision: number
  project_slug: string
  project_name: string
  project_description: string
  project_goal: string
  project_status: Project['status']
  parent_project_id: string | null
  target_date: string | null
  project_created_at: string
  project_updated_at: string
  project_access_level: string | null
}

interface CandidateRow {
  id: string
  slug: string
  department_id: string
  member_id: string | null
  weld_count: number
}

type AgentSelection =
  | { kind: 'selected'; agentId: string; inboxAgentId: string }
  | { kind: 'none' }
  | { kind: 'offline' }

export type RoutineDispatchResult =
  | {
      ok: true
      status: 'dispatched'
      run_id: string
      agent_id: string
      task_id: string
      flight_id: string
      duplicate: boolean
    }
  | { ok: true; status: 'waiting'; reason: 'agent' | 'budget'; run_id: string }
  | {
      ok: true
      status: 'retry_scheduled'
      reason: 'agent_offline' | 'inbox_full' | 'delivery_failed'
      run_id: string
    }
  | { ok: false; error: 'run_not_found' | 'run_not_dispatchable' | 'invalid_policy' | 'invalid_public_origin' }

export interface RoutineDispatchDependencies {
  sendAgentMessage?: typeof sendMessage
}

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function parsePolicy(value: string): RoutinePolicySnapshot | null {
  try {
    const parsed = JSON.parse(value) as Partial<RoutinePolicySnapshot>
    if (
      (parsed.execution_mode !== 'propose' && parsed.execution_mode !== 'execute_internal')
      || (parsed.overlap_policy !== 'skip' && parsed.overlap_policy !== 'queue')
      || typeof parsed.responsible_squad_id !== 'string'
      || parsed.responsible_squad_id.length < 1
      || parsed.responsible_squad_id.length > 200
      || (parsed.preferred_agent_id !== null && typeof parsed.preferred_agent_id !== 'string')
      || !Number.isSafeInteger(parsed.budget_micro_usd) || Number(parsed.budget_micro_usd) < 0
      || !Number.isInteger(parsed.max_attempts) || Number(parsed.max_attempts) < 1
      || !Number.isInteger(parsed.retry_backoff_seconds) || Number(parsed.retry_backoff_seconds) < 30
    ) return null
    return parsed as RoutinePolicySnapshot
  } catch {
    return null
  }
}

async function deterministicUuid(kind: string, runId: string): Promise<string> {
  const hex = await sha256Hex(`mupot:routine:${kind}:${runId}`)
  const bytes = Array.from({ length: 16 }, (_, index) => hex.slice(index * 2, index * 2 + 2))
  bytes[6] = (((Number.parseInt(bytes[6], 16) & 0x0f) | 0x50).toString(16)).padStart(2, '0')
  bytes[8] = (((Number.parseInt(bytes[8], 16) & 0x3f) | 0x80).toString(16)).padStart(2, '0')
  const normalized = bytes.join('')
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`
}

function projectFrom(row: DispatchRunRow): Project {
  return {
    id: row.project_id,
    slug: row.project_slug,
    name: row.project_name,
    description: row.project_description,
    goal: row.project_goal,
    status: row.project_status,
    parent_project_id: row.parent_project_id,
    target_date: row.target_date,
    created_at: row.project_created_at,
    updated_at: row.project_updated_at,
  }
}

function publicMcpEndpoint(env: Env): string | null {
  const configured = env.PUBLIC_ORIGIN?.trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return mcpEndpoint(url.origin)
  } catch {
    return null
  }
}

async function loadRun(env: Env, runId: string): Promise<DispatchRunRow | null> {
  return env.DB.prepare(
    `SELECT rr.id, rr.tenant, rr.project_id, rr.routine_id, rr.routine_revision,
            rr.policy_json, rr.status, rr.waiting_reason, rr.attempt, rr.task_id,
            rr.flight_id, rr.situation_digest, rr.assigned_agent_id, rr.cost_micro_usd,
            r.objective, r.status AS routine_status, r.revision AS current_routine_revision,
            p.slug AS project_slug, p.name AS project_name,
            p.description AS project_description, p.goal AS project_goal,
            p.status AS project_status, p.parent_project_id, p.target_date,
            p.created_at AS project_created_at, p.updated_at AS project_updated_at,
            psa.access_level AS project_access_level
       FROM routine_runs rr
       JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant
       JOIN projects p ON p.id = rr.project_id
       LEFT JOIN project_squad_access psa
         ON psa.project_id = rr.project_id
        AND psa.squad_id = json_extract(rr.policy_json, '$.responsible_squad_id')
      WHERE rr.id = ? AND rr.tenant = ?`,
  ).bind(runId, env.TENANT_SLUG).first<DispatchRunRow>()
}

async function loadCandidates(env: Env, squadId: string): Promise<CandidateRow[]> {
  const result = await env.DB.prepare(
    `SELECT a.id, a.slug, s.department_id,
            MIN(mt.member_id) AS member_id,
            COUNT(DISTINCT mt.member_id) AS weld_count
       FROM agents a
       JOIN squads s ON s.id = a.squad_id
       LEFT JOIN member_tokens mt
         ON mt.agent_id = a.id AND mt.tenant = ? AND mt.revoked_at IS NULL
       LEFT JOIN members m
         ON m.id = mt.member_id AND m.tenant = ? AND m.status = 'active'
      WHERE a.squad_id = ? AND a.status = 'active'
        AND (mt.member_id IS NULL OR m.id IS NOT NULL)
      GROUP BY a.id, a.slug, s.department_id
      ORDER BY a.id ASC LIMIT ?`,
  ).bind(env.TENANT_SLUG, env.TENANT_SLUG, squadId, CANDIDATE_LIMIT).all<CandidateRow>()
  return result.results ?? []
}

async function loadCandidateGrants(env: Env, memberIds: string[]): Promise<Map<string, CapabilityGrant[]>> {
  if (!memberIds.length) return new Map()
  const result = await env.DB.prepare(
    `SELECT member_id, scope_type, scope_id, capability FROM capabilities
      WHERE member_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
     UNION ALL
     SELECT member_id, 'squad' AS scope_type, squad_id AS scope_id, capability
       FROM channel_capability_grants
      WHERE member_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(JSON.stringify(memberIds), JSON.stringify(memberIds)).all<CapabilityGrant>()
  const byMember = new Map<string, CapabilityGrant[]>()
  for (const grant of result.results ?? []) {
    const grants = byMember.get(grant.member_id) ?? []
    grants.push(grant)
    byMember.set(grant.member_id, grants)
  }
  return byMember
}

async function selectAgent(
  env: Env,
  policy: RoutinePolicySnapshot,
  now: Date,
  assignedAgentId: string | null,
): Promise<AgentSelection> {
  const candidates = await loadCandidates(env, policy.responsible_squad_id)
  const memberIds = candidates
    .filter(candidate => Number(candidate.weld_count) === 1 && candidate.member_id)
    .map(candidate => candidate.member_id as string)
  const grants = await loadCandidateGrants(env, [...new Set(memberIds)])
  const eligible = candidates.filter(candidate => {
    if (assignedAgentId !== null && candidate.id !== assignedAgentId) return false
    if (Number(candidate.weld_count) !== 1 || !candidate.member_id) return false
    return hasCapability(
      grants.get(candidate.member_id) ?? [],
      'squad',
      policy.responsible_squad_id,
      'member',
      candidate.department_id,
    )
  }).sort((left, right) => {
    const preferred = policy.preferred_agent_id
    if (left.id === preferred && right.id !== preferred) return -1
    if (right.id === preferred && left.id !== preferred) return 1
    return left.id.localeCompare(right.id)
  })
  if (!eligible.length) return { kind: 'none' }
  const states = await getFleetAgentRuntimeStates(
    env,
    eligible.map(candidate => ({ agent_id: candidate.id, slug: candidate.slug })),
    now.getTime(),
  )
  for (const candidate of eligible) {
    const state = states.get(candidate.id)
    if (state?.runtime && state.presence === 'live') {
      return { kind: 'selected', agentId: candidate.id, inboxAgentId: state.agent_id }
    }
  }
  return { kind: 'offline' }
}

async function appendStateEvent(
  env: Env,
  run: DispatchRunRow,
  now: string,
  input: {
    status: 'queued' | 'waiting'
    waitingReason: 'agent' | 'budget' | null
    resultSummary: string
    retryAt: string | null
    eventKind: 'retry_scheduled' | 'agent_waiting' | 'budget_blocked'
  },
): Promise<boolean> {
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = ?, waiting_reason = ?, retry_at = ?,
              result_summary = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND tenant = ? AND status IN ('leased','observing')
          AND ${sqlNotCancellationPending('routine_runs')}`,
    ).bind(
      input.status, input.waitingReason, input.retryAt, input.resultSummary,
      now, run.id, run.tenant,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, ?, 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = ?
         AND ((? IS NULL AND waiting_reason IS NULL) OR waiting_reason = ?)
         AND result_summary = ? AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = ?
              AND CAST(json_extract(e.metadata_json, '$.attempt') AS INTEGER) = ?
         )`,
    ).bind(
      crypto.randomUUID(), input.eventKind, ROUTINE_SENDER, now,
      JSON.stringify({ reason: input.resultSummary, retry_at: input.retryAt, attempt: run.attempt }),
      run.id, run.tenant, input.status, input.waitingReason, input.waitingReason,
      input.resultSummary, now, input.eventKind, run.attempt,
    ),
  ])
  return wrote(outcomes[0])
}

async function waitForBudget(env: Env, run: DispatchRunRow, now: Date): Promise<RoutineDispatchResult> {
  const transitioned = await appendStateEvent(env, run, now.toISOString(), {
    status: 'waiting', waitingReason: 'budget', resultSummary: 'budget_exhausted',
    retryAt: null, eventKind: 'budget_blocked',
  })
  if (!transitioned) return { ok: false, error: 'run_not_dispatchable' }
  return { ok: true, status: 'waiting', reason: 'budget', run_id: run.id }
}

async function waitForAgent(env: Env, run: DispatchRunRow, now: Date, reason: string): Promise<RoutineDispatchResult> {
  const policy = parsePolicy(run.policy_json)
  if (!policy) return { ok: false, error: 'invalid_policy' }
  if (run.attempt >= policy.max_attempts || reason === 'no_eligible_agent') {
    const transitioned = await appendStateEvent(env, run, now.toISOString(), {
      status: 'waiting', waitingReason: 'agent', resultSummary: reason,
      retryAt: null, eventKind: 'agent_waiting',
    })
    if (!transitioned) return { ok: false, error: 'run_not_dispatchable' }
    return { ok: true, status: 'waiting', reason: 'agent', run_id: run.id }
  }
  const retryAt = new Date(now.getTime() + policy.retry_backoff_seconds * 1000).toISOString()
  const transitioned = await appendStateEvent(env, run, now.toISOString(), {
    status: 'queued', waitingReason: null, resultSummary: reason,
    retryAt, eventKind: 'retry_scheduled',
  })
  if (!transitioned) return { ok: false, error: 'run_not_dispatchable' }
  const publicReason = reason === 'agent_offline' || reason === 'inbox_full'
    ? reason
    : 'delivery_failed'
  return { ok: true, status: 'retry_scheduled', reason: publicReason, run_id: run.id }
}

async function existingTask(env: Env, id: string): Promise<Task | null> {
  return env.DB.prepare(
    `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
            github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       FROM tasks WHERE id = ?`,
  ).bind(id).first<Task>()
}

async function ensureTask(
  env: Env,
  run: DispatchRunRow,
  policy: RoutinePolicySnapshot,
  agentId: string,
): Promise<Task | null> {
  const id = await deterministicUuid('task', `${run.id}:${run.attempt}`)
  const existing = await existingTask(env, id)
  const matches = (task: Task): boolean => (
    task.project_id === run.project_id
    && task.squad_id === policy.responsible_squad_id
    && task.assignee_agent_id === agentId
    && (task.status === 'open' || task.status === 'in_progress')
  )
  if (existing) return matches(existing) ? existing : null
  try {
    return await createTask(env, {
      squad_id: policy.responsible_squad_id,
      project_id: run.project_id,
      title: `Routine: ${run.objective}`.slice(0, 240),
      body: `Observe Project state and return one governed proposal for RoutineRun ${run.id}.`,
      done_when: `A correlated routine.proposal/v1 for RoutineRun ${run.id} is accepted.`,
      status: 'open',
      assignee_agent_id: agentId,
    }, {
      id, skipMirror: true, skipEvent: true,
      routineRunFence: { runId: run.id, tenant: run.tenant },
    })
  } catch (error) {
    if (error instanceof TaskCreateFenceError) return null
    const raced = await existingTask(env, id)
    if (raced) return matches(raced) ? raced : null
    throw error
  }
}

async function ensureFlight(
  env: Env,
  run: DispatchRunRow,
  policy: RoutinePolicySnapshot,
  agentId: string,
  task: Task,
  budgetMicroUsd: number,
): Promise<string | null> {
  const id = await deterministicUuid('flight', `${run.id}:${run.attempt}`)
  type ExistingFlight = { id: string; project_id: string | null; agent: string; status: string; budget_micro_usd: number | null; meta: string }
  const loadExisting = () => env.DB.prepare(
    'SELECT id, project_id, agent, status, budget_micro_usd, meta FROM flights WHERE id = ? AND tenant = ?',
  ).bind(id, env.TENANT_SLUG).first<ExistingFlight>()
  const matches = (flight: ExistingFlight): boolean => {
    try {
      const meta = parseFlightMetaV1(JSON.parse(flight.meta) as unknown)
      return flight.project_id === run.project_id
        && flight.agent === agentId
        && (flight.status === 'preflight' || flight.status === 'running')
        && Number(flight.budget_micro_usd) === budgetMicroUsd
        && meta?.routine_run_id === run.id
        && meta.routine_revision === run.routine_revision
        && meta.task_ids.includes(task.id)
        && meta.squad_ids.includes(policy.responsible_squad_id)
    } catch {
      return false
    }
  }
  const existing = await loadExisting()
  if (existing) return matches(existing) ? existing.id : null
  const meta: FlightMetaV1 = {
    schema: FLIGHT_META_V1_SCHEMA,
    goal_id: run.routine_id,
    objective_id: run.id,
    squad_ids: [policy.responsible_squad_id],
    task_ids: [task.id],
    done_when: [task.done_when],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
    routine_run_id: run.id,
    routine_revision: run.routine_revision,
  }
  return createFlight(env, {
    agent: agentId,
    goal: run.objective,
    project_id: run.project_id,
    trigger_source: 'schedule',
    budget_micro_usd: budgetMicroUsd,
    meta,
  }, { id, routineRunFence: { runId: run.id, tenant: run.tenant } }).catch(async (error) => {
    if (error instanceof FlightCreateFenceError) return null
    const raced = await loadExisting()
    if (raced) return matches(raced) ? raced.id : null
    throw error
  })
}

function proposalSchema(): Record<string, unknown> {
  return {
    version: 'routine.proposal/v1',
    required: ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'],
    action_kinds: ['create_task', 'dispatch_flight', 'request_review', 'ask_human', 'no_action'],
  }
}

export async function dispatchRoutineRun(
  env: Env,
  runId: string,
  now: Date,
  deps: RoutineDispatchDependencies = {},
): Promise<RoutineDispatchResult> {
  const run = await loadRun(env, runId)
  if (!run) return { ok: false, error: 'run_not_found' }
  if (run.status === 'running' && run.assigned_agent_id && run.task_id && run.flight_id) {
    return {
      ok: true, status: 'dispatched', run_id: run.id, agent_id: run.assigned_agent_id,
      task_id: run.task_id, flight_id: run.flight_id, duplicate: true,
    }
  }
  if (run.status !== 'leased' && run.status !== 'observing') {
    return { ok: false, error: 'run_not_dispatchable' }
  }
  const policy = parsePolicy(run.policy_json)
  if (!policy) return { ok: false, error: 'invalid_policy' }
  if (
    run.project_status !== 'active'
    || run.routine_status !== 'enabled'
    || run.current_routine_revision !== run.routine_revision
  ) {
    return { ok: false, error: 'run_not_dispatchable' }
  }
  if (run.project_access_level !== 'write' && run.project_access_level !== 'admin') {
    return { ok: false, error: 'run_not_dispatchable' }
  }
  const endpoint = publicMcpEndpoint(env)
  if (!endpoint) return { ok: false, error: 'invalid_public_origin' }
  const remainingBudget = Math.max(0, policy.budget_micro_usd - Number(run.cost_micro_usd))
  if (remainingBudget === 0) return waitForBudget(env, run, now)

  const selected = await selectAgent(env, policy, now, run.assigned_agent_id)
  if (selected.kind === 'none') return waitForAgent(env, run, now, 'no_eligible_agent')
  if (selected.kind === 'offline') return waitForAgent(env, run, now, 'agent_offline')

  const reserved = await env.DB.prepare(
    `UPDATE routine_runs SET assigned_agent_id = ?, updated_at = ?
      WHERE id = ? AND tenant = ? AND status IN ('leased','observing')
        AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)
        AND ${sqlNotCancellationPending('routine_runs')}`,
  ).bind(selected.agentId, now.toISOString(), run.id, run.tenant, selected.agentId).run()
  if (!wrote(reserved)) return { ok: false, error: 'run_not_dispatchable' }
  run.assigned_agent_id = selected.agentId

  const task = await ensureTask(env, run, policy, selected.agentId)
  if (!task) return { ok: false, error: 'run_not_dispatchable' }
  const flightId = await ensureFlight(env, run, policy, selected.agentId, task, remainingBudget)
  if (!flightId) return { ok: false, error: 'run_not_dispatchable' }
  const situation = await loadProjectSituation(env, projectFrom(run), [policy.responsible_squad_id], {
    excludeTaskIds: [task.id],
    excludeFlightIds: [flightId],
  })
  const situationDigest = await canonicalJsonDigest(situation)
  const nowIso = now.toISOString()
  const observed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'observing', assigned_agent_id = ?, task_id = ?,
              flight_id = ?, situation_digest = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status IN ('leased','observing')
          AND assigned_agent_id = ?
          AND ${sqlNotCancellationPending('routine_runs')}`,
    ).bind(
      selected.agentId, task.id, flightId, situationDigest, nowIso,
      run.id, run.tenant, selected.agentId,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, ?, ?, ?, 'observed', 'system', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM routine_runs
          WHERE id = ? AND tenant = ? AND status = 'observing'
            AND assigned_agent_id = ? AND task_id = ? AND flight_id = ?
            AND situation_digest = ? AND updated_at = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM routine_run_events WHERE run_id = ? AND kind = 'observed'
       )`,
    ).bind(
      crypto.randomUUID(), run.tenant, run.project_id, run.id, ROUTINE_SENDER, nowIso,
      JSON.stringify({ situation_digest: situationDigest }), run.id,
      run.id, run.tenant, selected.agentId, task.id, flightId, situationDigest, nowIso,
      run.id,
    ),
  ])
  if (!wrote(observed[0])) return { ok: false, error: 'run_not_dispatchable' }

  const body = JSON.stringify({
    version: 'routine.run/v1',
    run_id: run.id,
    project_id: run.project_id,
    routine_revision: run.routine_revision,
    objective: run.objective,
    situation_digest: situationDigest,
    mcp_endpoint: endpoint,
    proposal_schema: proposalSchema(),
  })
  const send = deps.sendAgentMessage ?? sendMessage
  const delivery = await send(env, {
    fromAgent: ROUTINE_SENDER,
    fromMember: ROUTINE_MEMBER,
    toAgent: selected.inboxAgentId,
    body,
    kind: 'request',
    requestId: `routine-run:${run.id}`,
    projectId: run.project_id,
  }, {
    systemProjectAttribution: true,
    routineRunFence: { runId: run.id, projectId: run.project_id },
  })
  if (!delivery.ok) {
    if (delivery.reason === 'dispatch_fenced') return { ok: false, error: 'run_not_dispatchable' }
    return waitForAgent(env, run, now, delivery.reason === 'inbox_full' ? 'inbox_full' : 'delivery_failed')
  }

  await applyPreflight(env, flightId, {
    go: true,
    score: 1,
    checks: {
      contextComplete: true, toolsReachable: true, budgetHeadroom: true,
      progressBeatsWaste: true, cacheStaysWarm: true,
    },
    reasons: [],
  })

  const finished = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'running', waiting_reason = NULL,
              lease_owner = NULL, lease_expires_at = NULL, retry_at = NULL,
              assigned_agent_id = ?, task_id = ?, flight_id = ?, situation_digest = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'observing'
          AND ${sqlNotCancellationPending('routine_runs')}
          AND EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.id = ? AND t.project_id = ? AND t.squad_id = ?
               AND t.assignee_agent_id = ? AND t.status IN ('open','in_progress')
          )
          AND EXISTS (
            SELECT 1 FROM flights f
             WHERE f.id = ? AND f.tenant = ? AND f.project_id = ?
               AND f.agent = ? AND f.status = 'running'
          )`,
    ).bind(
      selected.agentId, task.id, flightId, situationDigest, nowIso, run.id, run.tenant,
      task.id, run.project_id, policy.responsible_squad_id, selected.agentId,
      flightId, run.tenant, run.project_id, selected.agentId,
    ),
    env.DB.prepare(
      `UPDATE tasks SET status = 'in_progress', updated_at = ?
        WHERE id = ? AND project_id = ? AND squad_id = ? AND assignee_agent_id = ?
          AND status IN ('open','in_progress')
          AND EXISTS (
            SELECT 1 FROM routine_runs rr
             WHERE rr.id = ? AND rr.tenant = ? AND rr.status = 'running'
               AND rr.task_id = tasks.id AND rr.flight_id = ?
          )`,
    ).bind(
      nowIso, task.id, run.project_id, policy.responsible_squad_id, selected.agentId,
      run.id, run.tenant, flightId,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'dispatched', 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'running'
         AND assigned_agent_id = ? AND task_id = ? AND flight_id = ?
         AND situation_digest = ? AND updated_at = ?`,
    ).bind(
      crypto.randomUUID(), ROUTINE_SENDER, nowIso,
      JSON.stringify({ agent_id: selected.agentId, task_id: task.id, flight_id: flightId, message_id: delivery.id }),
      run.id, run.tenant, selected.agentId, task.id, flightId, situationDigest, nowIso,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO routine_run_refs
        (id, tenant, project_id, run_id, ref_type, ref_id, relation, created_at)
       SELECT ?, tenant, project_id, id, 'task', ?, 'dispatch_task', ?
         FROM routine_runs
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND task_id = ? AND flight_id = ? AND situation_digest = ? AND updated_at = ?`,
    ).bind(crypto.randomUUID(), task.id, nowIso, run.id, run.tenant, task.id, flightId, situationDigest, nowIso),
    env.DB.prepare(
      `INSERT OR IGNORE INTO routine_run_refs
        (id, tenant, project_id, run_id, ref_type, ref_id, relation, created_at)
       SELECT ?, tenant, project_id, id, 'flight', ?, 'dispatch_flight', ?
         FROM routine_runs
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND task_id = ? AND flight_id = ? AND situation_digest = ? AND updated_at = ?`,
    ).bind(crypto.randomUUID(), flightId, nowIso, run.id, run.tenant, task.id, flightId, situationDigest, nowIso),
    env.DB.prepare(
      `INSERT OR IGNORE INTO routine_run_refs
        (id, tenant, project_id, run_id, ref_type, ref_id, relation, created_at)
       SELECT ?, tenant, project_id, id, 'message', ?, 'dispatch_envelope', ?
         FROM routine_runs
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND task_id = ? AND flight_id = ? AND situation_digest = ? AND updated_at = ?`,
    ).bind(crypto.randomUUID(), delivery.id, nowIso, run.id, run.tenant, task.id, flightId, situationDigest, nowIso),
  ])
  if (!wrote(finished[0]) || !wrote(finished[1])) {
    await failFlight(env, flightId, 'routine_run_not_dispatchable')
    return { ok: false, error: 'run_not_dispatchable' }
  }
  return {
    ok: true, status: 'dispatched', run_id: run.id, agent_id: selected.agentId,
    task_id: task.id, flight_id: flightId, duplicate: delivery.duplicate,
  }
}
