import { describe, expect, it } from 'vitest'
import { loadOpsHealth } from '../src/dashboard/health'
import type { Env } from '../src/types'

const NOW = new Date('2026-07-08T12:00:00.000Z').getTime()
const RECENT = '2026-07-08T11:58:00.000Z'
const OLD = '2026-07-06T12:00:00.000Z'

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

interface MockRows {
  agentCounts?: unknown[]
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

function makeEnv(rows: MockRows = {}, envOver: Partial<Env> & { EVENT_INGEST_SECRET?: string } = {}) {
  const calls: { sql: string; binds: unknown[] }[] = []
  const resultFor = (sql: string) => {
    if (sql.includes('FROM agents') && sql.includes('GROUP BY status')) {
      return rows.agentCounts ?? [{ status: 'active', count: 2 }]
    }
    if (sql.includes('FROM tasks') && sql.includes('GROUP BY status')) {
      return rows.taskCounts ?? [
        { status: 'open', count: 1 },
        { status: 'in_progress', count: 1 },
        { status: 'review', count: 0 },
        { status: 'blocked', count: 0 },
        { status: 'rejected', count: 0 },
      ]
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

    const health = await loadOpsHealth(env, NOW)

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

    const health = await loadOpsHealth(env, NOW)
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

    const health = await loadOpsHealth(env, NOW)

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

    const health = await loadOpsHealth(env, NOW)
    const schema = health.checks.find((c) => c.id === 'schema')!

    expect(schema.tone).toBe('danger')
    expect(schema.detail).toContain('task_verdicts')
    expect(schema.nextAction).toContain('Run D1 migrations')
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

    const health = await loadOpsHealth(env, NOW)
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
