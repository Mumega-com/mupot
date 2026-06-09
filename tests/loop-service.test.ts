// tests/loop-service.test.ts — Loop storage (P1, #32). Hand-mocked D1.
// Covers: createLoop validation + persist, tenant-scoped get (no cross-tenant read),
// hydrate rejects corrupt/invalid spec, listLoops filter + skip-invalid, setLoopStatus.

import { describe, expect, it } from 'vitest'
import { createLoop, getLoop, listLoops, setLoopStatus, hydrateLoop } from '../src/loops/service'
import type { Env } from '../src/types'

const VALID_SPEC = {
  agent_id: 'agent-1',
  squad_id: null,
  okr: 'Book 5 meetings',
  kpi: { signal: 'positive_replies', target: 5 },
  sources: [{ kind: 'queue', name: 'prospects' }],
  channels: [{ kind: 'mcp', url: 'https://ghl.example/mcp', auth_ref: 'GHL_API_KEY' }],
  gate: { require_approval: true, timeout_sec: 86400, on_timeout: 'pause' },
  budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
  cadence: { heartbeat: true },
  stop: { dry_rounds_max: 3 },
}

interface Row {
  id: string
  tenant: string
  squad_id: string | null
  agent_id: string | null
  status: string
  spec: string
  dry_rounds: number
  created_at: string
  updated_at: string
}

function makeEnv(tenant = 'test-tenant', seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]))
  const env = {
    TENANT_SLUG: tenant,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (sql.includes('SELECT') && sql.includes('WHERE id = ?')) {
                  const id = args[0] as string
                  const t = args[1] as string
                  const r = rows.get(id)
                  return r && r.tenant === t ? (r as unknown as T) : null
                }
                return null
              },
              async all<T>(): Promise<{ results: T[] }> {
                const t = args[0] as string
                let list = [...rows.values()].filter((r) => r.tenant === t)
                if (sql.includes('AND status = ?')) {
                  const st = args[1] as string
                  list = list.filter((r) => r.status === st)
                }
                return { results: list as unknown as T[] }
              },
              async run(): Promise<{ meta: { changes: number } }> {
                if (sql.startsWith('INSERT INTO loops')) {
                  const [id, tenant2, squad_id, agent_id, spec, created_at, updated_at] = args as [
                    string, string, string | null, string | null, string, string, string,
                  ]
                  rows.set(id, { id, tenant: tenant2, squad_id, agent_id, status: 'active', spec, dry_rounds: 0, created_at, updated_at })
                  return { meta: { changes: 1 } }
                }
                if (sql.startsWith('UPDATE loops SET status')) {
                  const [status, updated_at, id, t] = args as [string, string, string, string]
                  const r = rows.get(id)
                  // mirror the WHERE: tenant-scoped + killed/done are terminal
                  if (r && r.tenant === t && r.status !== 'killed' && r.status !== 'done') {
                    rows.set(id, { ...r, status, updated_at })
                    return { meta: { changes: 1 } }
                  }
                  return { meta: { changes: 0 } }
                }
                return { meta: { changes: 0 } }
              },
            }
          },
        }
      },
    },
  }
  return { env: env as unknown as Env, rows }
}

describe('createLoop', () => {
  it('rejects an invalid spec', async () => {
    const { env } = makeEnv()
    const r = await createLoop(env, { okr: '', agent_id: 'a', squad_id: null })
    expect(r.ok).toBe(false)
  })

  it('persists a valid loop and returns the manifest with server identity', async () => {
    const { env, rows } = makeEnv()
    const r = await createLoop(env, VALID_SPEC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.id).toMatch(/[0-9a-f-]{36}/)
      expect(r.value.tenant).toBe('test-tenant')
      expect(r.value.status).toBe('active')
      expect(r.value.kpi.target).toBe(5)
      expect(rows.size).toBe(1)
    }
  })
})

describe('getLoop — tenant scoped', () => {
  it('returns the loop for its own tenant', async () => {
    const { env } = makeEnv()
    const created = await createLoop(env, VALID_SPEC)
    if (!created.ok) throw new Error('setup')
    const got = await getLoop(env, created.value.id)
    expect(got?.id).toBe(created.value.id)
  })

  it('NEVER returns a loop belonging to another tenant', async () => {
    const { env: envA, rows } = makeEnv('tenant-a')
    const created = await createLoop(envA, VALID_SPEC)
    if (!created.ok) throw new Error('setup')
    // Same row store, different tenant identity:
    const { env: envB } = makeEnv('tenant-b', [...rows.values()])
    const leaked = await getLoop(envB, created.value.id)
    expect(leaked).toBeNull()
  })
})

describe('hydrateLoop', () => {
  const baseRow = {
    id: 'l1', tenant: 't', squad_id: null, agent_id: 'a', status: 'active',
    dry_rounds: 0, created_at: 'x', updated_at: 'x',
  }
  it('returns null on corrupt JSON', () => {
    expect(hydrateLoop({ ...baseRow, spec: '{not json' })).toBeNull()
  })
  it('returns null when the stored spec no longer validates', () => {
    expect(hydrateLoop({ ...baseRow, spec: JSON.stringify({ okr: '' }) })).toBeNull()
  })
  it('returns null on an unknown status', () => {
    expect(hydrateLoop({ ...baseRow, status: 'zombie', spec: JSON.stringify(VALID_SPEC) })).toBeNull()
  })
  it('hydrates a valid row', () => {
    const m = hydrateLoop({ ...baseRow, spec: JSON.stringify(VALID_SPEC) })
    expect(m?.okr).toBe('Book 5 meetings')
  })
})

describe('listLoops + setLoopStatus', () => {
  it('lists this tenant only, filters by status, skips invalid rows', async () => {
    const { env, rows } = makeEnv()
    await createLoop(env, VALID_SPEC)
    await createLoop(env, { ...VALID_SPEC, okr: 'second' })
    // inject a corrupt row for this tenant — must be skipped, not throw
    rows.set('bad', { id: 'bad', tenant: 'test-tenant', squad_id: null, agent_id: 'a', status: 'active', spec: '{bad', dry_rounds: 0, created_at: 'x', updated_at: 'x' })
    const all = await listLoops(env)
    expect(all.length).toBe(2) // corrupt skipped
    const active = await listLoops(env, { status: 'active' })
    expect(active.length).toBe(2)
    const paused = await listLoops(env, { status: 'paused' })
    expect(paused.length).toBe(0)
  })

  it('setLoopStatus transitions and is tenant-scoped', async () => {
    const { env, rows } = makeEnv()
    const created = await createLoop(env, VALID_SPEC)
    if (!created.ok) throw new Error('setup')
    expect(await setLoopStatus(env, created.value.id, 'paused')).toBe(true)
    expect(rows.get(created.value.id)?.status).toBe('paused')
    // other tenant cannot transition it
    const { env: envB } = makeEnv('tenant-b', [...rows.values()])
    expect(await setLoopStatus(envB, created.value.id, 'active')).toBe(false)
  })

  it('killed is terminal — a killed loop cannot be revived', async () => {
    const { env } = makeEnv()
    const created = await createLoop(env, VALID_SPEC)
    if (!created.ok) throw new Error('setup')
    expect(await setLoopStatus(env, created.value.id, 'killed')).toBe(true)
    expect(await setLoopStatus(env, created.value.id, 'active')).toBe(false) // cannot revive
  })
})
