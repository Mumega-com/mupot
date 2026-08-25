// tests/loop-control-tool.test.ts — MCP loop_control (governor signal + receipt, #1166).

import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { insertLoopIfAbsent } from '../src/loops/service'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'
const SQUAD_ID = 'squad-alpha'

const VALID_SPEC = {
  agent_id: null,
  squad_id: SQUAD_ID,
  okr: 'Contain a monitored loop so a runaway cycle can be paused or killed',
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
  applyAllMigrations(harness.sqlite)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    control: (loopId: string) =>
      harness.sqlite.prepare('SELECT * FROM loop_controls WHERE loop_id = ?').get(loopId) as
        | Record<string, unknown>
        | undefined,
    receipts: (loopId: string) =>
      harness.sqlite.prepare(
        'SELECT * FROM loop_control_receipts WHERE loop_id = ? ORDER BY issued_at ASC',
      ).all(loopId) as Array<Record<string, unknown>>,
  }
}

function grant(
  capability: CapabilityGrant['capability'],
  scope_type: CapabilityGrant['scope_type'] = 'org',
  scope_id: string | null = null,
): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
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
const squadMember = auth('squad-member', [grant('member', 'squad', SQUAD_ID)])

async function insertActiveLoop(env: Env, id: string) {
  const inserted = await insertLoopIfAbsent(env, id, 'active', VALID_SPEC)
  expect(inserted.ok).toBe(true)
}

describe('loop_control — registry', () => {
  it('registers loop_control at min lead', () => {
    const spec = TOOLS.find((t) => t.name === 'loop_control')
    expect(spec).toBeDefined()
    expect(spec?.min).toBe('lead')
  })
})

describe('loop_control — pause writes loop_controls and a receipt', () => {
  it('pausing an active loop writes to loop_controls and records receipt', async () => {
    const db = makeDb()
    const loopId = 'loop-pause-1'
    await insertActiveLoop(db.env, loopId)

    const out = await invokeTool(orgAdmin, db.env, 'loop_control', {
      loop_id: loopId,
      action: 'pause',
      reason: 'runaway cycle observed',
    }, ORIGIN)

    expect(out.ok).toBe(true)
    if (out.ok) {
      const result = out.result as { ok: boolean; action: string; loop_id: string; receipt_id: string }
      expect(result.ok).toBe(true)
      expect(result.action).toBe('pause')
      expect(result.loop_id).toBe(loopId)
      expect(typeof result.receipt_id).toBe('string')
      expect(result.receipt_id.length).toBeGreaterThan(0)
    }

    const control = db.control(loopId)
    expect(control).toBeDefined()
    expect(control?.action).toBe('pause')
    expect(control?.tenant).toBe(TENANT)
    expect(control?.issued_by).toBe('admin-member@example.test')

    const receipts = db.receipts(loopId)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      tenant: TENANT,
      loop_id: loopId,
      action: 'pause',
      reason: 'runaway cycle observed',
      actor_id: 'admin-member@example.test',
    })
    if (out.ok) {
      expect(receipts[0]?.id).toBe((out.result as { receipt_id: string }).receipt_id)
    }
  })
})

describe('loop_control — kill writes action kill', () => {
  it('killing a loop writes action kill', async () => {
    const db = makeDb()
    const loopId = 'loop-kill-1'
    await insertActiveLoop(db.env, loopId)

    const out = await invokeTool(orgAdmin, db.env, 'loop_control', {
      loop_id: loopId,
      action: 'kill',
      reason: 'terminal containment after confirmed runaway',
    }, ORIGIN)

    expect(out.ok).toBe(true)
    expect(db.control(loopId)?.action).toBe('kill')
    expect(db.receipts(loopId)[0]?.action).toBe('kill')
  })
})

describe('loop_control — unauthorized member', () => {
  it('unauthorized member receives 403 forbidden', async () => {
    const db = makeDb()
    const loopId = 'loop-forbidden-1'
    await insertActiveLoop(db.env, loopId)

    const out = await invokeTool(squadMember, db.env, 'loop_control', {
      loop_id: loopId,
      action: 'pause',
      reason: 'member should not be able to pause',
    }, ORIGIN)

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(403)
      expect(out.error).toBe('forbidden')
    }
    expect(db.control(loopId)).toBeUndefined()
    expect(db.receipts(loopId)).toHaveLength(0)
  })
})
