// tests/flight-spine-objectives.test.ts — Unit and conformance tests for Flight Spine objectives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptObjective, getObjective } from '../src/flight-spine/objectives'
import { verifyExecutionReceipt } from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-spine'
const SERVER_TIME = '2026-08-23T17:00:00.000Z'

let harness: SqliteD1Harness
let env: Env

function memberAuth(tenant = TENANT): AuthContext {
  return {
    userId: 'user-hadi',
    email: 'hadi@mumega.com',
    role: 'admin',
    tenant,
    memberId: 'm-hadi-01',
    boundAgentId: null,
  }
}

function agentAuth(tenant = TENANT): AuthContext {
  return {
    ...memberAuth(tenant),
    memberId: 'm-river-01',
    boundAgentId: 'agent-river-01',
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

  // Seed department and squad
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-core', 'core', 'Core Systems', datetime('now'));
    INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-hadi-mac', 'dept-core', 'hadi-mac', 'Hadi Mac Squad', datetime('now'));
    INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES ('m-hadi-01', '${TENANT}', 'Hadi', 'hadi@mumega.com', 'active', datetime('now'));
    INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES ('m-river-01', '${TENANT}', 'River Member', NULL, 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-river-01', 'squad-hadi-mac', 'hadi-river', 'River', 'Receipt Keeper', 'active', datetime('now'));
  `)
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine Objectives', () => {
  it('accepts a valid objective, generates receipts, and binds canonical payload digest', async () => {
    const objective = await acceptObjective(env, memberAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Bootstrap Flight Spine Kernel',
      successContract: 'All 6 hops execute deterministically with non-collapsing receipts.',
      authorityEnvelope: { allowedRoles: ['coordinator', 'worker', 'gate'], maxBudget: 5000000 },
      policy: { requireIndependentGate: true },
      budgetMicroUsd: 5000000,
      payload: { flightPlan: 'flight-02-spine-schema', targetSquad: 'hadi-mac' },
      idempotencyKey: 'obj-init-01',
    })

    expect(objective.id).toBeDefined()
    expect(objective.tenant).toBe(TENANT)
    expect(objective.title).toBe('Bootstrap Flight Spine Kernel')
    expect(objective.budgetMicroUsd).toBe(5000000)
    expect(objective.payloadDigest).toBeDefined()
    expect(objective.payloadDigest.length).toBe(64)
    expect(objective.acceptanceReceiptId).toBeDefined()

    // Verify receipt verification passes
    const verification = await verifyExecutionReceipt(env, objective.acceptanceReceiptId)
    expect(verification).toEqual({ ok: true })

    // Verify retrieval
    const fetched = await getObjective(env, memberAuth(), objective.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.title).toBe(objective.title)
    expect(fetched?.payloadDigest).toBe(objective.payloadDigest)
    expect(fetched?.payload).toEqual(objective.payload)
  })

  it('supports agent-bound caller and derives agent principal correctly', async () => {
    const objective = await acceptObjective(env, agentAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Agent Initiated Objective',
      successContract: 'Must prove agent creator attribution.',
      authorityEnvelope: { autonomy: 'draft' },
      policy: { verifyReceipts: true },
      budgetMicroUsd: 1000000,
      payload: { initiator: 'hadi-river' },
      idempotencyKey: 'obj-agent-01',
    })

    expect(objective.id).toBeDefined()
    const row = harness.sqlite.prepare('SELECT created_by_principal_kind, created_by_principal_id FROM objectives WHERE id = ?').get(objective.id) as any
    expect(row.created_by_principal_kind).toBe('agent')
    expect(row.created_by_principal_id).toBe('agent-river-01')
  })

  it('provides idempotent replay on identical idempotencyKey and payload', async () => {
    const input = {
      squadId: 'squad-hadi-mac',
      title: 'Idempotent Objective Test',
      successContract: 'Must replay cleanly without duplicating rows.',
      authorityEnvelope: { scope: 'test' },
      policy: {},
      budgetMicroUsd: 500000,
      payload: { step: 1, seed: 'abc' },
      idempotencyKey: 'obj-idempotent-01',
    }

    const first = await acceptObjective(env, memberAuth(), input)
    const second = await acceptObjective(env, memberAuth(), input)

    expect(second.id).toBe(first.id)
    expect(second.acceptanceReceiptId).toBe(first.acceptanceReceiptId)
    expect(second.payloadDigest).toBe(first.payloadDigest)
  })

  it('rejects same idempotencyKey with modified payload digest (idempotency conflict)', async () => {
    const inputA = {
      squadId: 'squad-hadi-mac',
      title: 'Conflict Test A',
      successContract: 'Initial success contract',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 500000,
      payload: { version: 1 },
      idempotencyKey: 'obj-conflict-key',
    }

    await acceptObjective(env, memberAuth(), inputA)

    const inputB = {
      ...inputA,
      payload: { version: 2 }, // mutated payload
    }

    await expect(acceptObjective(env, memberAuth(), inputB)).rejects.toThrow(/idempotency_conflict/)
  })

  it('enforces immutability: rejects direct SQL updates and deletes on objectives table', async () => {
    const objective = await acceptObjective(env, memberAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Immutable Objective',
      successContract: 'Cannot be altered.',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 100000,
      payload: { test: true },
      idempotencyKey: 'obj-immutability-01',
    })

    expect(() => {
      harness.sqlite.exec(`UPDATE objectives SET title = 'Hacked' WHERE id = '${objective.id}'`)
    }).toThrow(/objectives are immutable/)

    expect(() => {
      harness.sqlite.exec(`DELETE FROM objectives WHERE id = '${objective.id}'`)
    }).toThrow(/objectives are immutable/)
  })

  it('validates input bounds and rejects invalid inputs', async () => {
    // Missing squad
    await expect(acceptObjective(env, memberAuth(), {
      squadId: '',
      title: 'Test',
      successContract: 'Contract',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 100,
      payload: {},
      idempotencyKey: 'k1',
    })).rejects.toThrow(/squadId required/)

    // Negative budget
    await expect(acceptObjective(env, memberAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Test',
      successContract: 'Contract',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: -50,
      payload: {},
      idempotencyKey: 'k2',
    })).rejects.toThrow(/budgetMicroUsd/)

    // Nonexistent squad
    await expect(acceptObjective(env, memberAuth(), {
      squadId: 'squad-ghost',
      title: 'Test',
      successContract: 'Contract',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 100,
      payload: {},
      idempotencyKey: 'k3',
    })).rejects.toThrow(/squad_not_found/)
  })
})
