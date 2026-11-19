// The /approvals office row's OWN pre-checks (agent-bound, self-owner) in isolation. In production the verdict-gate
// evaluation behind them also refuses these principals; here evaluateVerdictGates is forced to ALLOW so the UI check is
// the only thing standing between the principal and an Approve/Reject button. Removing either check turns a test red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/tasks/index', async (original) => {
  const real = await original<typeof import('../src/tasks/index')>()
  return { ...real, evaluateVerdictGates: async () => ({ allowed: true, principal: { type: 'member', id: 'mem-lead' } }) }
})

import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { installAddon, configureAddon, activateAddon } from '../src/addons/service'
import { createTask } from '../src/tasks/service'
import { invokeTool } from '../src/mcp/index'
import '../src/mcp/office'
import { loadApprovals } from '../src/dashboard/approvals'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
const MASTER_KEY = '33'.repeat(32)
let h: SqliteD1Harness
let taskId: string
const env = (): Env => ({ TENANT_SLUG: TENANT, BRAND: 'Test Pot', DB: h.db, CONNECTOR_MASTER_KEY: MASTER_KEY, SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined } } as unknown as Env)
const principal = (boundAgentId: string | null) => ({
  userId: 'mem-lead', email: null, role: 'owner' as const, tenant: TENANT, memberId: 'mem-lead', boundAgentId,
  capabilities: [{ member_id: 'mem-lead', scope_type: 'org' as const, scope_id: null, capability: 'owner' as const }],
})

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');`)
  h.sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-lead', 'lead@x.test', 'lead', 'active', ?)`).run(TENANT)
  const connectorId = 'connector-office-wordpress'
  const encrypted = await encryptConnectorSecret(MASTER_KEY, connectorId, 'mcpwp', 'wp-secret')
  h.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'WP', ?, ?, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(connectorId, TENANT, encrypted, JSON.stringify({ siteUrl: 'https://wordpress.example.com', username: 'office-agent' }))
  const owner = { id: 'owner-1', role: 'owner' as const }
  for (const step of [() => installAddon(env(), owner, 'mcpwp-office'), () => configureAddon(env(), owner, 'mcpwp-office', { bindings: [{ slot: 'wordpress_site', adapter: 'mcpwp', bindingKind: 'vault_connector', connectorId }] }), () => activateAddon(env(), owner, 'mcpwp-office')]) {
    const r = await step()
    if (!r.ok) throw new Error(`fixture ${JSON.stringify(r)}`)
  }
  const squadId = (h.sqlite.prepare(`SELECT id FROM squads WHERE slug = 'site-operator'`).get() as { id: string }).id
  const task = await createTask(env(), { squad_id: squadId, title: 'Publish: Q4 recap', body: 'the exact words', done_when: 'post is live', gate_owner: 'gate:office' }, { skipMirror: true, skipEvent: true })
  taskId = task.id
  const seed = { userId: 'seed', email: null, role: 'owner' as const, tenant: TENANT, memberId: 'seed', capabilities: [{ member_id: 'seed', scope_type: 'org' as const, scope_id: null, capability: 'owner' as const }], boundAgentId: null }
  for (const status of ['in_progress', 'review']) {
    const r = await invokeTool(seed as never, env(), 'task_update', { task_id: task.id, status }, ORIGIN)
    if (!r.ok) throw new Error(`fixture ${status} ${JSON.stringify(r)}`)
  }
})
afterEach(() => h.close())

describe('office row UI pre-checks (verdict gate forced to allow)', () => {
  it('control: an unbound non-owner-of-task principal is offered Approve and Reject', async () => {
    const row = (await loadApprovals(env(), principal(null))).items.find((i) => i.id === taskId)
    expect(row, 'office row must render').toBeDefined()
    expect(row).toMatchObject({ is_office: true, can_approve: true, can_reject: true })
  })

  it('an agent-bound (attached seat) principal is offered nothing', async () => {
    const row = (await loadApprovals(env(), principal('agent-x'))).items.find((i) => i.id === taskId)
    expect(row?.can_approve ?? false).toBe(false)
    expect(row?.can_reject ?? false).toBe(false)
  })

  it('the task\'s own human owner is offered nothing', async () => {
    h.sqlite.prepare(`UPDATE tasks SET assignee_member_id = 'mem-lead' WHERE id = ?`).run(taskId)
    const row = (await loadApprovals(env(), principal(null))).items.find((i) => i.id === taskId)
    expect(row?.can_approve ?? false).toBe(false)
    expect(row?.can_reject ?? false).toBe(false)
  })
})
