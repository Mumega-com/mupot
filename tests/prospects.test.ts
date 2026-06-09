// tests/prospects.test.ts — the outreach prospect queue (P4, #35). Hand-mocked D1.

import { describe, expect, it } from 'vitest'
import { createProspect, listQueued, setProspectStatus, countByStatus, findByEmail } from '../src/loops/prospects'
import type { Prospect } from '../src/loops/prospects'
import type { Env } from '../src/types'

function makeEnv(tenant = 't', seed: Prospect[] = []) {
  const rows = new Map<string, Prospect>(seed.map((p) => [p.id, p]))
  const ACTIVE = new Set(['queued', 'drafted', 'sent'])
  const env = {
    TENANT_SLUG: tenant,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (sql.includes('COUNT(*)')) {
                  const [t, status] = args as [string, string]
                  const c = [...rows.values()].filter((p) => p.tenant === t && p.status === status).length
                  return { c } as unknown as T
                }
                if (sql.includes('SELECT * FROM prospects WHERE tenant = ? AND email = ?')) {
                  const [t, email] = args as [string, string]
                  const hit = [...rows.values()].filter((p) => p.tenant === t && p.email === email).pop()
                  return (hit ?? null) as unknown as T
                }
                return null
              },
              async all<T>(): Promise<{ results: T[] }> {
                const t = args[0] as string
                let list = [...rows.values()].filter((p) => p.tenant === t && p.status === 'queued')
                if (sql.includes('AND loop_id = ?')) {
                  const loopId = args[1] as string
                  list = list.filter((p) => p.loop_id === loopId)
                }
                return { results: list as unknown as T[] }
              },
              async run(): Promise<{ meta: { changes: number } }> {
                if (sql.startsWith('INSERT INTO prospects')) {
                  const [id, tenant2, loop_id, org, contact_name, email, source, consent_basis, notes, created_at] =
                    args as [string, string, string | null, string | null, string | null, string, string, string, string | null, string]
                  // simulate the active-unique index on (tenant,email)
                  const dup = [...rows.values()].some((p) => p.tenant === tenant2 && p.email === email && ACTIVE.has(p.status))
                  if (dup) throw new Error('UNIQUE constraint failed: prospects.tenant, prospects.email')
                  rows.set(id, {
                    id, tenant: tenant2, loop_id, org, contact_name, email,
                    source: source as Prospect['source'], consent_basis: consent_basis as Prospect['consent_basis'],
                    status: 'queued', notes, created_at,
                  })
                  return { meta: { changes: 1 } }
                }
                if (sql.startsWith('UPDATE prospects SET status')) {
                  const [status, , id, t] = args as [string, string, string, string]
                  const p = rows.get(id)
                  if (p && p.tenant === t) {
                    rows.set(id, { ...p, status: status as Prospect['status'] })
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

describe('createProspect', () => {
  it('rejects an invalid email', async () => {
    const { env } = makeEnv()
    expect((await createProspect(env, { email: 'nope' })).ok).toBe(false)
    expect((await createProspect(env, {})).ok).toBe(false)
  })

  it('queues a prospect, normalizing the email', async () => {
    const { env, rows } = makeEnv()
    const r = await createProspect(env, { email: 'Hi@Acme.com', org: 'Acme', source: 'seed', consent_basis: 'consent' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.email).toBe('hi@acme.com')
      expect(r.value.status).toBe('queued')
      expect(r.value.consent_basis).toBe('consent')
    }
    expect(rows.size).toBe(1)
  })

  it('defaults consent_basis to unknown (CASL — must be gated)', async () => {
    const { env } = makeEnv()
    const r = await createProspect(env, { email: 'x@y.com' })
    if (r.ok) expect(r.value.consent_basis).toBe('unknown')
  })

  it('dedups an active duplicate (same tenant+email) → duplicate_active', async () => {
    const { env } = makeEnv()
    expect((await createProspect(env, { email: 'dup@y.com' })).ok).toBe(true)
    const second = await createProspect(env, { email: 'dup@y.com' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('duplicate_active')
  })
})

describe('queue reads + transitions', () => {
  it('listQueued returns queued prospects for the tenant', async () => {
    const { env } = makeEnv()
    await createProspect(env, { email: 'a@y.com' })
    await createProspect(env, { email: 'b@y.com' })
    const q = await listQueued(env, { limit: 10 })
    expect(q.length).toBe(2)
  })

  it('setProspectStatus transitions and frees the email for re-queue', async () => {
    const { env } = makeEnv()
    const r = await createProspect(env, { email: 'c@y.com' })
    if (!r.ok) throw new Error('setup')
    expect(await setProspectStatus(env, r.value.id, 'opted_out')).toBe(true)
    // now terminal → a new active prospect for the same email is allowed
    expect((await createProspect(env, { email: 'c@y.com' })).ok).toBe(true)
  })

  it('countByStatus + findByEmail work tenant-scoped', async () => {
    const { env } = makeEnv()
    const r = await createProspect(env, { email: 'd@y.com' })
    if (!r.ok) throw new Error('setup')
    await setProspectStatus(env, r.value.id, 'replied')
    expect(await countByStatus(env, 'replied')).toBe(1)
    expect((await findByEmail(env, 'D@Y.com'))?.id).toBe(r.value.id)
  })
})
