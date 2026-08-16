import { describe, expect, it } from 'vitest'
import { loadOpsHealth } from '../src/dashboard/health'
import type { AuthContext, Env } from '../src/types'

const NOW = new Date('2026-07-08T12:00:00.000Z').getTime()
const RECENT = '2026-07-08T11:58:00.000Z'
const OLD = '2026-07-06T12:00:00.000Z'

const OWNER: AuthContext = { userId: 'owner-1', email: 'owner@test', role: 'owner', tenant: 'local' }

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

// Flight-008 Slice 1 (mupot#1060): loadOpsHealth's agent/runtime/needs-decision KPIs now
// route through operator-counts.ts's computeOperatorCounts, fed by the SAME canonical
// loaders Home uses (observatory.ts's loadAgentStats/loadAgentRuntimeStates,
// approvals.ts's loadApprovals) instead of health.ts's own ad hoc queries. Default fixture
// below: 2 agents, both with a live runtime (key_member_id + fleet status=running,
// recent heartbeat) — kept for continuity with this suite's pre-existing "2 online"
// expectations, now sourced from the canonical query shape instead of a GROUP BY.
interface MockRows {
  /** Raw agents.{id,status} rows (loadOperatorCounts' plain SELECT — no GROUP BY). */
  agents?: unknown[]
  /** loadAgentRuntimeStates' evidence rows (agent_id, key_member_id, fleet_status, last_reported_at). */
  runtimeEvidence?: unknown[]
  /** loadApprovals' gate-queue rows. */
  approvals?: unknown[]
  /** loadTaskStatusCounts' grouped rows — also feeds blockedOrRejected/open/in_progress. */
  taskCounts?: unknown[]
  fleet?: unknown[]
  presence?: unknown[]
  connectors?: unknown[]
  githubInstallations?: unknown[]
  failures?: unknown[]
  workflowReceipts?: unknown[]
  connectorAudit?: unknown[]
  fleetControl?: unknown[]
  verdicts?: unknown[]
  loopObserver?: unknown[]
  schema?: unknown[]
}

const DEFAULT_AGENTS = [
  { id: 'a1', status: 'active' },
  { id: 'a2', status: 'active' },
]

const DEFAULT_RUNTIME_EVIDENCE = [
  { agent_id: 'a1', key_member_id: 'm1', fleet_status: 'running', last_reported_at: RECENT },
  { agent_id: 'a2', key_member_id: 'm2', fleet_status: 'running', last_reported_at: RECENT },
]

function makeEnv(rows: MockRows = {}, envOver: Partial<Env> & { EVENT_INGEST_SECRET?: string } = {}) {
  const calls: { sql: string; binds: unknown[] }[] = []
  const resultFor = (sql: string) => {
    // loadAgentStats (observatory.ts) — per-agent 24h task stats. Not exposed on
    // OpsHealthData.kpis; empty is fine unless a test asserts on it directly.
    if (sql.includes('AS task_count')) {
      return []
    }
    // loadAgentRuntimeStates (observatory.ts) — the canonical live/stale/offline/
    // unattached classifier Home's kpiStrip and Fleet's radar summary also read.
    if (sql.includes('key_member_id')) {
      return rows.runtimeEvidence ?? DEFAULT_RUNTIME_EVIDENCE
    }
    // loadApprovals (approvals.ts) — the RBAC + gate_owner-scoped gate queue, i.e.
    // "needs your decision".
    if (sql.includes('t.gate_owner')) {
      return rows.approvals ?? []
    }
    // loadTaskStatusCounts (operator-counts.ts) — the ONE grouped tasks-by-status
    // count; feeds blockedOrRejected AND the Task queues check's open/in_progress text.
    if (sql.includes('FROM tasks') && sql.includes('GROUP BY status')) {
      return rows.taskCounts ?? [
        { status: 'open', count: 1 },
        { status: 'in_progress', count: 1 },
        { status: 'review', count: 0 },
        { status: 'blocked', count: 0 },
        { status: 'rejected', count: 0 },
      ]
    }
    // Plain agents roster (operator-counts.ts loadOperatorCounts-equivalent: health.ts
    // feeds computeOperatorCounts directly, but the SELECT shape is the same).
    if (sql.includes('SELECT id, status FROM agents')) {
      return rows.agents ?? DEFAULT_AGENTS
    }
    if (sql.includes('FROM fleet_agents')) {
      return rows.fleet ?? [
        {
          agent_id: 'hermes-local',
          display: 'Hermes Local',
          runtime: 'hermes-cron',
          lifecycle: 'always_on',
          status: 'running',
          last_reported_at: RECENT,
          updated_at: RECENT,
        },
      ]
    }
    if (sql.includes('FROM presence')) {
      return rows.presence ?? [
        {
          member_id: 'm1',
          display_name: 'Hermes Operator',
          source: 'hermes',
          label: 'relay',
          agent_id: 'agent-hermes',
          last_seen_at: RECENT,
        },
      ]
    }
    if (sql.includes('FROM connectors') && sql.includes('GROUP BY')) {
      return rows.connectors ?? [{ type: 'github_app', state: 'active', count: 1 }]
    }
    if (sql.includes('FROM github_installations')) {
      return rows.githubInstallations ?? [{ count: 1 }]
    }
    if (sql.includes("status IN ('blocked', 'rejected')")) {
      return rows.failures ?? []
    }
    if (sql.includes('FROM workflow_receipts')) {
      return rows.workflowReceipts ?? [
        { id: 'wr-ok', task_id: 'task-1', step_name: 'execute', status: 'ok', detail: '{}', created_at: RECENT },
      ]
    }
    if (sql.includes('FROM connector_audit')) {
      return rows.connectorAudit ?? [
        {
          id: 'ca-1',
          action: 'add',
          actor_id: 'owner-1',
          recorded_at: RECENT,
          label: 'GitHub',
          type: 'github_app',
        },
      ]
    }
    if (sql.includes('FROM fleet_control_log')) {
      return rows.fleetControl ?? []
    }
    if (sql.includes('FROM task_verdicts')) {
      return rows.verdicts ?? [
        {
          id: 'v1',
          task_id: 'task-1',
          title: 'Approve seeded work',
          verdict: 'approved',
          decided_by: 'owner-1',
          decided_at: RECENT,
        },
      ]
    }
    if (sql.includes('FROM loop_observer')) {
      return rows.loopObserver ?? [
        {
          agent_id: 'agent-hermes',
          consecutive_noops: 0,
          consecutive_fails: 0,
          liveness_fails: 0,
          last_escalated_at: null,
        },
      ]
    }
    if (sql.includes('FROM sqlite_master')) {
      return rows.schema ?? CORE_TABLES.map((name) => ({ name }))
    }
    return []
  }

  const env = {
    TENANT_SLUG: 'local',
    IM_WEBHOOK_SECRET: 'im-secret',
    GITHUB_WEBHOOK_SECRET: 'github-secret',
    CONNECTOR_MASTER_KEY: 'master-key',
    EVENT_INGEST_SECRET: 'event-secret',
    DB: {
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] }
        calls.push(call)
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async all() {
            return { results: resultFor(sql) }
          },
        }
        return stmt
      },
    },
    ...envOver,
  } as unknown as Env

  return { env, calls }
}

describe('loadOpsHealth', () => {
  it('classifies a connected pot as healthy', async () => {
    const { env } = makeEnv()

    const health = await loadOpsHealth(env, OWNER, NOW)

    expect(health.overallTone).toBe('ok')
    expect(health.kpis.activeAgents).toBe(2)
    expect(health.kpis.runtimeOnline).toBeGreaterThan(0)
    expect(health.checks.find((c) => c.id === 'runtime')).toMatchObject({
      tone: 'ok',
      state: '2 online',
    })
    expect(health.auditSignals.length).toBeGreaterThan(0)
  })

  it('surfaces missing webhook and connector secret next actions', async () => {
    const { env } = makeEnv(
      {
        connectors: [
          { type: 'github_app', state: 'active', count: 1 },
          { type: 'ghl', state: 'active', count: 1 },
        ],
      },
      {
        IM_WEBHOOK_SECRET: undefined,
        GITHUB_WEBHOOK_SECRET: undefined,
        GHL_WEBHOOK_SECRET: undefined,
        CONNECTOR_MASTER_KEY: undefined,
        EVENT_INGEST_SECRET: undefined,
      } as never,
    )

    const health = await loadOpsHealth(env, OWNER, NOW)
    const webhooks = health.checks.find((c) => c.id === 'webhooks')!
    const integrations = health.checks.find((c) => c.id === 'integrations')!

    expect(webhooks.tone).toBe('warn')
    expect(webhooks.detail).toContain('IM_WEBHOOK_SECRET')
    expect(webhooks.detail).toContain('GITHUB_WEBHOOK_SECRET')
    expect(webhooks.detail).toContain('GHL_WEBHOOK_SECRET')
    expect(webhooks.detail).toContain('EVENT_INGEST_SECRET')
    expect(webhooks.nextAction).toContain('wrangler secret put')
    expect(integrations.tone).toBe('warn')
    expect(integrations.detail).toContain('CONNECTOR_MASTER_KEY')
  })

  it('marks blocked task and failed workflow receipts as action-needed failures', async () => {
    const { env } = makeEnv({
      taskCounts: [
        { status: 'open', count: 0 },
        { status: 'in_progress', count: 0 },
        { status: 'review', count: 0 },
        { status: 'blocked', count: 1 },
        { status: 'rejected', count: 0 },
      ],
      failures: [
        {
          id: 'task-blocked',
          squad_id: 'sq-growth',
          title: 'Blocked task',
          status: 'blocked',
          result: 'Provider returned 502.',
          updated_at: RECENT,
        },
      ],
      workflowReceipts: [
        {
          id: 'wr-fail',
          task_id: 'task-blocked',
          step_name: 'execute',
          status: 'agent_not_found',
          detail: 'No assigned agent row.',
          created_at: RECENT,
        },
      ],
    })

    const health = await loadOpsHealth(env, OWNER, NOW)

    expect(health.overallTone).toBe('danger')
    expect(health.checks.find((c) => c.id === 'tasks')).toMatchObject({ tone: 'danger' })
    expect(health.recentFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Blocked task', status: 'blocked' }),
        expect.objectContaining({ title: 'execute for task-blocked', status: 'agent_not_found' }),
      ]),
    )
  })

  it('detects missing core schema tables', async () => {
    const { env } = makeEnv({ schema: [{ name: 'agents' }, { name: 'tasks' }] })

    const health = await loadOpsHealth(env, OWNER, NOW)
    const schema = health.checks.find((c) => c.id === 'schema')!

    expect(schema.tone).toBe('danger')
    expect(schema.detail).toContain('task_verdicts')
    expect(schema.nextAction).toContain('Run D1 migrations')
  })

  it('renders a squad-targeted fleet_control_log row by squad_id, not a blank agent_id', async () => {
    // migrations/0098: a squad-targeted control row leaves agent_id = '' and carries the real
    // target in squad_id — the audit feed must not render a blank target (kasra-review MEDIUM).
    const { env } = makeEnv({
      fleetControl: [
        { id: 'fc-1', agent_id: '', squad_id: 'squad-core', verb: 'stop', requested_by_member: 'hadi@digid.ca', created_at: RECENT },
        { id: 'fc-2', agent_id: 'kasra', squad_id: null, verb: 'start', requested_by_member: 'hadi@digid.ca', created_at: RECENT },
      ],
    })

    const health = await loadOpsHealth(env, OWNER, NOW)
    const details = health.auditSignals.map((s) => s.detail)
    expect(details).toContain('squad:squad-core requested by hadi@digid.ca')
    expect(details).toContain('kasra requested by hadi@digid.ca')
  })

  it('warns when runtime evidence is stale', async () => {
    const { env } = makeEnv({
      fleet: [
        {
          agent_id: 'codex-local',
          display: 'Codex Local',
          runtime: 'codex',
          lifecycle: 'on_demand',
          status: 'running',
          last_reported_at: OLD,
          updated_at: OLD,
        },
      ],
      presence: [
        {
          member_id: 'm1',
          display_name: 'Old Worker',
          source: 'codex',
          label: 'builder',
          agent_id: 'agent-codex',
          last_seen_at: OLD,
        },
      ],
    })

    const health = await loadOpsHealth(env, OWNER, NOW)
    const runtime = health.checks.find((c) => c.id === 'runtime')!

    expect(runtime.tone).toBe('warn')
    expect(runtime.detail).toContain('need attention')
    expect(health.runtimeSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Codex Local', tone: 'warn' }),
        expect.objectContaining({ label: 'Old Worker', tone: 'danger' }),
      ]),
    )
  })
})
