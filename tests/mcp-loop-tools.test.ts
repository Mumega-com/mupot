// tests/mcp-loop-tools.test.ts — loop_list / loop_set_status MCP (paused→active promote).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createLoop, setLoopStatus } from '../src/loops/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0014_loops.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

const VALID_SPEC = {
  agent_id: 'addon:install-1',
  squad_id: null,
  okr: 'Improve on-site conversion via a monitored, human-gated CRO review loop',
  kpi: { signal: 'avg_conversion_bps', target: 500 },
  sources: [{ kind: 'memory', name: 'cro-pages' }],
  channels: [],
  gate: { require_approval: true },
  budget: { cap_micro_usd: null, window: 'week', effort: 'standard' },
  cadence: { heartbeat: true },
  stop: { dry_rounds_max: 10 },
}

function makeDb() {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    row: (id: string) => harness.sqlite.prepare('SELECT * FROM loops WHERE id = ?').get(id) as Record<string, unknown> | undefined,
  }
}

function grant(capability: CapabilityGrant['capability']): CapabilityGrant {
  return { member_id: 'n/a', scope_type: 'org', scope_id: null, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

const orgAdmin = auth('admin-member', [grant('admin')])
const grantless = auth('grantless', [])

describe('loop MCP tools — registry', () => {
  it('registers loop_list and loop_set_status', () => {
    for (const name of ['loop_list', 'loop_set_status']) {
      expect(TOOLS.find((t) => t.name === name)?.min).toBe('admin')
    }
  })
})

describe('loop_set_status — promote paused → active', () => {
  it('rejects non-admin', async () => {
    const db = makeDb()
    const out = await invokeTool(grantless, db.env, 'loop_set_status', {
      loop_id: 'loop-1',
      status: 'active',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })

  it('promotes a paused loop to active', async () => {
    const db = makeDb()
    const created = await createLoop(db.env, VALID_SPEC)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.id
    expect(await setLoopStatus(db.env, id, 'paused')).toBe(true)
    expect(db.row(id)?.status).toBe('paused')

    const listed = await invokeTool(orgAdmin, db.env, 'loop_list', { status: 'paused' }, ORIGIN)
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect((listed.result as { loops: Array<{ id: string }> }).loops.map((l) => l.id)).toContain(id)
    }

    const promoted = await invokeTool(orgAdmin, db.env, 'loop_set_status', {
      loop_id: id,
      status: 'active',
    }, ORIGIN)
    expect(promoted.ok).toBe(true)
    expect(db.row(id)?.status).toBe('active')
  })

  it('refuses to revive a killed loop', async () => {
    const db = makeDb()
    const created = await createLoop(db.env, VALID_SPEC)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.id
    await invokeTool(orgAdmin, db.env, 'loop_set_status', { loop_id: id, status: 'killed' }, ORIGIN)
    const revive = await invokeTool(orgAdmin, db.env, 'loop_set_status', { loop_id: id, status: 'active' }, ORIGIN)
    expect(revive.ok).toBe(false)
    expect(db.row(id)?.status).toBe('killed')
  })
})
