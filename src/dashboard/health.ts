// dashboard/health.ts — operator health data for the dashboard /ops console.
//
// Read-only. This module deliberately aggregates existing D1/runtime evidence
// instead of creating a new health table. The point is an operator-readable
// answer to "is this pot healthy, what is wrong, and where do I act next?"

import type { Env } from '../types'

export type HealthTone = 'ok' | 'warn' | 'danger' | 'dim'

export interface HealthCheck {
  id: string
  label: string
  tone: HealthTone
  state: string
  detail: string
  nextAction: string
  href: string
}

export interface RuntimeSignal {
  id: string
  label: string
  kind: 'fleet_agent' | 'presence'
  runtime: string
  state: string
  tone: HealthTone
  lastSeen: string
  detail: string
  href: string
}

export interface RecentFailure {
  id: string
  title: string
  status: string
  detail: string
  updatedAt: string
  href: string
}

export interface AuditSignal {
  id: string
  label: string
  detail: string
  at: string
  href: string
}

export interface OpsHealthData {
  generatedAt: string
  overallTone: HealthTone
  checks: HealthCheck[]
  kpis: {
    activeAgents: number
    runtimeOnline: number
    activePresence: number
    needsDecision: number
    blockedOrRejected: number
    recentAudit: number
  }
  runtimeSignals: RuntimeSignal[]
  recentFailures: RecentFailure[]
  auditSignals: AuditSignal[]
}

interface CountRow {
  status?: string
  type?: string
  state?: string
  count?: number | string
  n?: number | string
}

interface FleetAgentRow {
  agent_id: string
  display: string
  runtime: string
  lifecycle: string
  status: string
  last_reported_at: string | null
  updated_at: string | null
}

interface PresenceRow {
  member_id: string
  display_name: string
  source: string
  label: string
  agent_id: string | null
  last_seen_at: string | null
}

interface TaskFailureRow {
  id: string
  squad_id: string
  title: string
  status: string
  result: string | null
  updated_at: string
}

interface WorkflowReceiptRow {
  id: string
  task_id: string
  step_name: string
  status: string
  detail: string | null
  created_at: string
}

interface ConnectorAuditRow {
  id: string
  action: string
  actor_id: string | null
  recorded_at: string
  label: string | null
  type: string | null
}

interface FleetControlRow {
  id: string
  agent_id: string
  verb: string
  requested_by_member: string
  created_at: string
}

interface VerdictAuditRow {
  id: string
  task_id: string
  title: string | null
  verdict: string
  decided_by: string
  decided_at: string
}

interface LoopObserverRow {
  agent_id: string
  consecutive_noops: number | string
  consecutive_fails: number | string
  liveness_fails: number | string
  last_escalated_at: string | null
}

interface QueryResult<T> {
  rows: T[]
  error: string | null
}

const ACTIVE_MS = 10 * 60 * 1000
const IDLE_MS = 24 * 60 * 60 * 1000
const STALE_RUNTIME_MS = 30 * 60 * 1000

const CORE_TABLES = [
  'agents',
  'tasks',
  'task_verdicts',
  'presence',
  'fleet_agents',
  'connectors',
  'connector_audit',
  'workflow_receipts',
]

function envWithOptionalSecrets(env: Env): Env & { EVENT_INGEST_SECRET?: string } {
  return env as Env & { EVENT_INGEST_SECRET?: string }
}

async function safeAll<T>(env: Env, sql: string, binds: unknown[] = []): Promise<QueryResult<T>> {
  try {
    const prepared = env.DB.prepare(sql)
    const stmt = binds.length > 0 ? prepared.bind(...binds) : prepared
    const res = await stmt.all<T>()
    return { rows: res.results ?? [], error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function countFor(rows: CountRow[], key: string): number {
  const row = rows.find((r) => r.status === key || r.type === key || r.state === key)
  return toNumber(row?.count ?? row?.n)
}

function countConnectors(rows: CountRow[], type: string, state = 'active'): number {
  return rows
    .filter((r) => r.type === type && r.state === state)
    .reduce((sum, r) => sum + toNumber(r.count), 0)
}

function anyActiveConnectors(rows: CountRow[]): number {
  return rows
    .filter((r) => r.state === 'active')
    .reduce((sum, r) => sum + toNumber(r.count), 0)
}

function parseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : null
}

function liveness(iso: string | null | undefined, nowMs: number): 'active' | 'idle' | 'dead' | 'never' {
  const ms = parseTimeMs(iso)
  if (ms === null) return 'never'
  const age = Math.max(0, nowMs - ms)
  if (age <= ACTIVE_MS) return 'active'
  if (age <= IDLE_MS) return 'idle'
  return 'dead'
}

function humanAge(iso: string | null | undefined, nowMs: number): string {
  const ms = parseTimeMs(iso)
  if (ms === null) return 'never'
  const age = Math.max(0, nowMs - ms)
  if (age < 60_000) return 'just now'
  if (age < 60 * 60_000) return `${Math.round(age / 60_000)}m ago`
  if (age < 48 * 60 * 60_000) return `${Math.round(age / (60 * 60_000))}h ago`
  return `${Math.round(age / (24 * 60 * 60_000))}d ago`
}

function toneRank(tone: HealthTone): number {
  if (tone === 'danger') return 3
  if (tone === 'warn') return 2
  if (tone === 'dim') return 1
  return 0
}

function worstTone(checks: HealthCheck[]): HealthTone {
  return checks.reduce<HealthTone>((worst, c) => (toneRank(c.tone) > toneRank(worst) ? c.tone : worst), 'ok')
}

function shortDetail(value: string | null | undefined): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return 'No detail recorded.'
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean
}

function runtimeTone(state: string, lastSeen: string | null, nowMs: number): HealthTone {
  const seen = parseTimeMs(lastSeen)
  if (seen !== null && nowMs - seen > STALE_RUNTIME_MS) return 'warn'
  if (state === 'running' || state === 'active') return 'ok'
  if (state === 'idle' || state === 'stopped' || state === 'sleeping') return 'warn'
  if (state === 'dead') return 'danger'
  return 'dim'
}

function presenceTone(state: string): HealthTone {
  if (state === 'active') return 'ok'
  if (state === 'idle') return 'warn'
  if (state === 'dead') return 'danger'
  return 'dim'
}

function makeCheck(input: HealthCheck): HealthCheck {
  return input
}

export async function loadOpsHealth(env: Env, nowMs = Date.now()): Promise<OpsHealthData> {
  const tenant = env.TENANT_SLUG
  const [
    agents,
    tasks,
    fleet,
    presence,
    connectors,
    githubInstallations,
    recentFailures,
    workflowReceipts,
    connectorAudit,
    fleetControl,
    verdicts,
    loopObserver,
    schemaTables,
  ] = await Promise.all([
    safeAll<CountRow>(env, 'SELECT status, COUNT(*) AS count FROM agents GROUP BY status'),
    safeAll<CountRow>(env, 'SELECT status, COUNT(*) AS count FROM tasks GROUP BY status'),
    safeAll<FleetAgentRow>(
      env,
      `SELECT agent_id, display, runtime, lifecycle, status, last_reported_at, updated_at
         FROM fleet_agents
        WHERE tenant = ?1
        ORDER BY updated_at DESC
        LIMIT 25`,
      [tenant],
    ),
    safeAll<PresenceRow>(
      env,
      `SELECT member_id, display_name, source, label, agent_id, last_seen_at
         FROM presence
        WHERE tenant = ?1
        ORDER BY last_seen_at DESC
        LIMIT 25`,
      [tenant],
    ),
    safeAll<CountRow>(
      env,
      `SELECT type,
              CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS state,
              COUNT(*) AS count
         FROM connectors
        WHERE tenant = ?1
        GROUP BY type, state`,
      [tenant],
    ),
    safeAll<CountRow>(env, 'SELECT COUNT(*) AS count FROM github_installations WHERE tenant = ?1', [tenant]),
    safeAll<TaskFailureRow>(
      env,
      `SELECT id, squad_id, title, status, result, updated_at
         FROM tasks
        WHERE status IN ('blocked', 'rejected')
        ORDER BY updated_at DESC
        LIMIT 5`,
    ),
    safeAll<WorkflowReceiptRow>(
      env,
      `SELECT id, task_id, step_name, status, detail, created_at
         FROM workflow_receipts
        ORDER BY created_at DESC
        LIMIT 8`,
    ),
    safeAll<ConnectorAuditRow>(
      env,
      `SELECT ca.id, ca.action, ca.actor_id, ca.recorded_at, c.label, c.type
         FROM connector_audit ca
         LEFT JOIN connectors c ON c.id = ca.connector_id
        WHERE ca.tenant = ?1
        ORDER BY ca.recorded_at DESC
        LIMIT 5`,
      [tenant],
    ),
    safeAll<FleetControlRow>(
      env,
      `SELECT id, agent_id, verb, requested_by_member, created_at
         FROM fleet_control_log
        WHERE tenant = ?1
        ORDER BY created_at DESC
        LIMIT 5`,
      [tenant],
    ),
    safeAll<VerdictAuditRow>(
      env,
      `SELECT v.id, v.task_id, t.title, v.verdict, v.decided_by, v.decided_at
         FROM task_verdicts v
         LEFT JOIN tasks t ON t.id = v.task_id
        ORDER BY v.decided_at DESC
        LIMIT 5`,
    ),
    safeAll<LoopObserverRow>(
      env,
      `SELECT agent_id, consecutive_noops, consecutive_fails, liveness_fails, last_escalated_at
         FROM loop_observer
        WHERE tenant = ?1
        ORDER BY last_escalated_at DESC, agent_id ASC
        LIMIT 8`,
      [tenant],
    ),
    safeAll<{ name: string }>(
      env,
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table'
          AND name IN (${CORE_TABLES.map(() => '?').join(',')})`,
      CORE_TABLES,
    ),
  ])

  const queryErrors = [
    agents,
    tasks,
    fleet,
    presence,
    connectors,
    githubInstallations,
    recentFailures,
    workflowReceipts,
    connectorAudit,
    fleetControl,
    verdicts,
    loopObserver,
    schemaTables,
  ].flatMap((r) => (r.error ? [r.error] : []))

  const activeAgents = countFor(agents.rows, 'active')
  const pausedAgents = countFor(agents.rows, 'paused')
  const totalAgents = activeAgents + pausedAgents

  const openTasks = countFor(tasks.rows, 'open')
  const inProgressTasks = countFor(tasks.rows, 'in_progress')
  const reviewTasks = countFor(tasks.rows, 'review')
  const blockedTasks = countFor(tasks.rows, 'blocked')
  const rejectedTasks = countFor(tasks.rows, 'rejected')
  const blockedOrRejected = blockedTasks + rejectedTasks

  const runtimeSignals: RuntimeSignal[] = [
    ...fleet.rows.map((row) => {
      const last = row.updated_at ?? row.last_reported_at
      const state = row.status || 'unknown'
      return {
        id: `fleet:${row.agent_id}`,
        label: row.display || row.agent_id,
        kind: 'fleet_agent' as const,
        runtime: row.runtime || row.lifecycle || 'unknown',
        state,
        tone: runtimeTone(state, last, nowMs),
        lastSeen: humanAge(last, nowMs),
        detail: `${row.lifecycle || 'unknown lifecycle'} reported by fleet registry.`,
        href: '/fleet',
      }
    }),
    ...presence.rows.map((row) => {
      const state = liveness(row.last_seen_at, nowMs)
      return {
        id: `presence:${row.member_id}`,
        label: row.display_name || row.member_id,
        kind: 'presence' as const,
        runtime: row.source || 'unknown',
        state,
        tone: presenceTone(state),
        lastSeen: humanAge(row.last_seen_at, nowMs),
        detail: row.agent_id ? `Bound to ${row.agent_id}. ${row.label || 'No label.'}` : row.label || 'Member-token presence.',
        href: row.agent_id ? `/agents/${row.agent_id}` : '/fleet',
      }
    }),
  ].sort((a, b) => toneRank(b.tone) - toneRank(a.tone))

  const runtimeOnline = runtimeSignals.filter((r) => r.tone === 'ok').length
  const activePresence = presence.rows.filter((r) => liveness(r.last_seen_at, nowMs) === 'active').length
  const staleRuntime = runtimeSignals.filter((r) => r.tone === 'warn' || r.tone === 'danger').length

  const activeConnectors = anyActiveConnectors(connectors.rows)
  const activeGithubConnectors = countConnectors(connectors.rows, 'github_app')
  const activeGhlConnectors = countConnectors(connectors.rows, 'ghl')
  const githubInstallCount = countFor(githubInstallations.rows, 'active') || toNumber(githubInstallations.rows[0]?.count)

  const secretEnv = envWithOptionalSecrets(env)
  const missingSecrets: string[] = []
  if (!env.IM_WEBHOOK_SECRET) missingSecrets.push('IM_WEBHOOK_SECRET')
  if ((activeGithubConnectors > 0 || githubInstallCount > 0 || env.GITHUB_REPO) && !env.GITHUB_WEBHOOK_SECRET) {
    missingSecrets.push('GITHUB_WEBHOOK_SECRET')
  }
  if ((activeGhlConnectors > 0 || env.GHL_API_KEY || env.GHL_LOCATION_ID) && !env.GHL_WEBHOOK_SECRET) {
    missingSecrets.push('GHL_WEBHOOK_SECRET')
  }
  if (!secretEnv.EVENT_INGEST_SECRET) missingSecrets.push('EVENT_INGEST_SECRET')

  const missingCoreTables = CORE_TABLES.filter((name) => !schemaTables.rows.some((r) => r.name === name))

  const observerTrouble = loopObserver.rows.filter(
    (r) => toNumber(r.consecutive_fails) > 0 || toNumber(r.liveness_fails) > 0,
  )
  const failedWorkflowReceipts = workflowReceipts.rows.filter(
    (r) => !['ok', 'waiting', 'gate-resolved'].includes(r.status),
  )

  const recentFailuresList: RecentFailure[] = [
    ...recentFailures.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      detail: shortDetail(row.result),
      updatedAt: row.updated_at,
      href: `/squads/${row.squad_id}`,
    })),
    ...failedWorkflowReceipts.slice(0, 5).map((row) => ({
      id: row.id,
      title: `${row.step_name} for ${row.task_id}`,
      status: row.status,
      detail: shortDetail(row.detail),
      updatedAt: row.created_at,
      href: '/flights',
    })),
  ]

  const auditSignals: AuditSignal[] = [
    ...connectorAudit.rows.map((row) => ({
      id: `connector:${row.id}`,
      label: `Connector ${row.action}`,
      detail: `${row.label ?? row.type ?? 'connector'} by ${row.actor_id ?? 'unknown'}`,
      at: row.recorded_at,
      href: '/admin/connectors',
    })),
    ...fleetControl.rows.map((row) => ({
      id: `fleet:${row.id}`,
      label: `Fleet ${row.verb}`,
      detail: `${row.agent_id} requested by ${row.requested_by_member}`,
      at: row.created_at,
      href: '/fleet',
    })),
    ...verdicts.rows.map((row) => ({
      id: `verdict:${row.id}`,
      label: `Gate ${row.verdict}`,
      detail: `${row.title ?? row.task_id} decided by ${row.decided_by}`,
      at: row.decided_at,
      href: '/approvals',
    })),
    ...workflowReceipts.rows.slice(0, 5).map((row) => ({
      id: `workflow:${row.id}`,
      label: `Workflow ${row.status}`,
      detail: `${row.step_name} for ${row.task_id}`,
      at: row.created_at,
      href: '/flights',
    })),
  ]
    .filter((row) => row.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10)

  const checks: HealthCheck[] = [
    makeCheck({
      id: 'agents',
      label: 'Agent roster',
      tone: activeAgents > 0 ? 'ok' : totalAgents > 0 ? 'warn' : 'danger',
      state: activeAgents > 0 ? `${activeAgents} active` : totalAgents > 0 ? 'all paused' : 'empty',
      detail:
        totalAgents > 0
          ? `${activeAgents} active, ${pausedAgents} paused.`
          : 'No agent identities exist in this pot.',
      nextAction: activeAgents > 0 ? 'Review agents and pause only intentionally.' : 'Add or resume an agent.',
      href: '/agents',
    }),
    makeCheck({
      id: 'runtime',
      label: 'Runtime liveness',
      tone: runtimeOnline > 0 && staleRuntime === 0 ? 'ok' : runtimeOnline > 0 ? 'warn' : 'warn',
      state: runtimeOnline > 0 ? `${runtimeOnline} online` : 'no online runtime',
      detail:
        runtimeSignals.length > 0
          ? `${runtimeSignals.length} runtime or presence signals; ${staleRuntime} need attention.`
          : 'No runtime has checked in through fleet or pot-native presence.',
      nextAction: runtimeOnline > 0 ? 'Open Fleet for stale or stopped runtimes.' : 'Attach a runtime or start the host consumer.',
      href: '/fleet',
    }),
    makeCheck({
      id: 'tasks',
      label: 'Task queues',
      tone: blockedOrRejected > 0 ? 'danger' : openTasks + inProgressTasks > 0 ? 'ok' : 'dim',
      state: blockedOrRejected > 0 ? `${blockedOrRejected} failed` : `${openTasks + inProgressTasks} in flow`,
      detail: `${openTasks} open, ${inProgressTasks} in progress, ${blockedTasks} blocked, ${rejectedTasks} rejected.`,
      nextAction: blockedOrRejected > 0 ? 'Open the failed task and decide the next owner.' : 'Use Send a task to create new work.',
      href: '/send',
    }),
    makeCheck({
      id: 'approvals',
      label: 'Approval gates',
      tone: reviewTasks > 0 ? 'warn' : 'ok',
      state: reviewTasks > 0 ? `${reviewTasks} waiting` : 'clear',
      detail: reviewTasks > 0 ? 'Gated work is waiting for an accountable verdict.' : 'No tasks are waiting in review.',
      nextAction: reviewTasks > 0 ? 'Approve, reject, or request changes.' : 'No action needed.',
      href: '/approvals',
    }),
    makeCheck({
      id: 'webhooks',
      label: 'Webhook ingress',
      tone: missingSecrets.length > 0 ? 'warn' : 'ok',
      state: missingSecrets.length > 0 ? `${missingSecrets.length} missing` : 'secrets present',
      detail:
        missingSecrets.length > 0
          ? `Missing auth secrets: ${missingSecrets.join(', ')}.`
          : 'IM, GitHub/GHL when connected, and event-ingest auth secrets are present.',
      nextAction:
        missingSecrets.length > 0
          ? 'Set missing secrets with wrangler secret put before enabling those webhooks.'
          : 'Watch integration audit and webhook task creation.',
      href: '/admin/keys',
    }),
    makeCheck({
      id: 'integrations',
      label: 'Integrations',
      tone:
        activeConnectors === 0 && githubInstallCount === 0
          ? 'dim'
          : activeGithubConnectors > 0 && githubInstallCount === 0
            ? 'warn'
            : activeConnectors > 0 && !env.CONNECTOR_MASTER_KEY
              ? 'warn'
              : 'ok',
      state: activeConnectors > 0 ? `${activeConnectors} connector(s)` : githubInstallCount > 0 ? 'GitHub installed' : 'none',
      detail:
        activeGithubConnectors > 0 && githubInstallCount === 0
          ? 'A GitHub connector exists but no installation row is recorded.'
          : activeConnectors > 0 && !env.CONNECTOR_MASTER_KEY
            ? 'Connector rows exist, but CONNECTOR_MASTER_KEY is missing; secret resolution will fail closed.'
            : `${activeConnectors} active connector row(s), ${githubInstallCount} GitHub installation row(s).`,
      nextAction:
        activeConnectors > 0 || githubInstallCount > 0
          ? 'Open Directory sync or Connectors to inspect configuration.'
          : 'Connect GitHub, GHL, or another tool when this pot needs external actions.',
      href: activeGithubConnectors > 0 || githubInstallCount > 0 ? '/admin/github' : '/admin/connectors',
    }),
    makeCheck({
      id: 'schema',
      label: 'Schema readiness',
      tone: missingCoreTables.length > 0 ? 'danger' : 'ok',
      state: missingCoreTables.length > 0 ? `${missingCoreTables.length} missing` : 'core tables present',
      detail:
        missingCoreTables.length > 0
          ? `Missing tables: ${missingCoreTables.join(', ')}.`
          : `Core operator tables found: ${CORE_TABLES.length}.`,
      nextAction: missingCoreTables.length > 0 ? 'Run D1 migrations before trusting this pot.' : 'No schema action needed.',
      href: '/setup',
    }),
    makeCheck({
      id: 'audit',
      label: 'Audit evidence',
      tone: auditSignals.length > 0 ? 'ok' : 'dim',
      state: auditSignals.length > 0 ? `${auditSignals.length} recent` : 'quiet',
      detail:
        auditSignals.length > 0
          ? 'Recent connector, fleet, verdict, or workflow receipts are available.'
          : 'No recent audit-linked events were found in the operator tables.',
      nextAction: auditSignals.length > 0 ? 'Open the relevant linked surface for context.' : 'Use Audit log for broader review.',
      href: '/audit',
    }),
    makeCheck({
      id: 'observer',
      label: 'Loop observer',
      tone: observerTrouble.length > 0 ? 'warn' : loopObserver.rows.length > 0 ? 'ok' : 'dim',
      state: observerTrouble.length > 0 ? `${observerTrouble.length} noisy` : loopObserver.rows.length > 0 ? 'stable' : 'no rows',
      detail:
        observerTrouble.length > 0
          ? 'One or more agents have loop failures, no-op streaks, or liveness failures.'
          : loopObserver.rows.length > 0
            ? 'No loop observer counters currently need escalation.'
            : 'No loop observer rows have been written yet.',
      nextAction: observerTrouble.length > 0 ? 'Open Brain or Loops and inspect the failing agent.' : 'No action needed.',
      href: '/brain',
    }),
  ]

  if (queryErrors.length > 0) {
    checks.push({
      id: 'health-query-errors',
      label: 'Health queries',
      tone: 'danger',
      state: `${queryErrors.length} failed`,
      detail: shortDetail(queryErrors.join(' | ')),
      nextAction: 'Check migrations and table permissions; this page is missing evidence.',
      href: '/setup',
    })
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    overallTone: worstTone(checks),
    checks,
    kpis: {
      activeAgents,
      runtimeOnline,
      activePresence,
      needsDecision: reviewTasks,
      blockedOrRejected,
      recentAudit: auditSignals.length,
    },
    runtimeSignals,
    recentFailures: recentFailuresList.slice(0, 8),
    auditSignals,
  }
}
