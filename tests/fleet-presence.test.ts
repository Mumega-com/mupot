import { describe, it, expect } from 'vitest'
import {
  normalizeSource,
  sqliteUtcToMs,
  recordCheckin,
  listPresence,
  countActive,
} from '../src/fleet/presence'
import type { Env } from '../src/types'
import type { PresenceView } from '../src/fleet/presence'

describe('normalizeSource', () => {
  it('known runtime passes', () => expect(normalizeSource('hermes')).toBe('hermes'))
  it('unknown string → unknown (no raw client value stored)', () => expect(normalizeSource('evil')).toBe('unknown'))
  it('non-string → unknown', () => expect(normalizeSource(42)).toBe('unknown'))
})

describe('sqliteUtcToMs', () => {
  it("parses sqlite datetime('now') as UTC", () => {
    expect(sqliteUtcToMs('2026-06-09 04:00:00')).toBe(Date.parse('2026-06-09T04:00:00Z'))
  })
  it('null on null/garbage', () => {
    expect(sqliteUtcToMs(null)).toBeNull()
    expect(sqliteUtcToMs('nope')).toBeNull()
  })
})

interface Captured {
  args?: unknown[]
  ran?: boolean
}

function makeEnv(tenant: string, seed: Array<Record<string, unknown>> = []): { env: Env; captured: Captured } {
  const captured: Captured = {}
  const env = {
    TENANT_SLUG: tenant,
    DB: {
      prepare() {
        return {
          bind(...args: unknown[]) {
            captured.args = args
            return {
              async run() {
                captured.ran = true
                return { success: true }
              },
              async all() {
                const t = args[0]
                return { results: seed.filter((r) => r.__tenant === t) }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
  return { env, captured }
}

describe('recordCheckin', () => {
  it('sanitizes source + caps label, binds tenant + token identity (not body)', async () => {
    const { env, captured } = makeEnv('digid')
    await recordCheckin(
      env,
      { memberId: 'm1', displayName: 'Kasra', email: null },
      { source: 'evil', label: 'x'.repeat(500) },
    )
    expect(captured.args?.[0]).toBe('digid') // tenant (env-derived)
    expect(captured.args?.[1]).toBe('m1') // member_id (from token)
    expect(captured.args?.[3]).toBe('unknown') // source sanitized
    expect((captured.args?.[4] as string).length).toBe(120) // label capped
    expect(captured.ran).toBe(true)
  })
})

describe('listPresence', () => {
  const NOW = Date.parse('2026-06-09T04:10:00Z')
  it('is tenant-scoped and derives liveness from last_seen_at', async () => {
    const seed = [
      {
        __tenant: 'digid',
        member_id: 'm1',
        display_name: 'Kasra',
        source: 'claude-code',
        label: '',
        last_seen_at: '2026-06-09 04:08:00', // 2m ago → active
        first_seen_at: '2026-06-09 04:00:00',
      },
      {
        __tenant: 'other', // different tenant → must be excluded
        member_id: 'm2',
        display_name: 'X',
        source: 'tmux',
        label: '',
        last_seen_at: '2026-06-09 04:08:00',
        first_seen_at: '2026-06-09 04:00:00',
      },
    ]
    const { env } = makeEnv('digid', seed)
    const out = await listPresence(env, NOW)
    expect(out).toHaveLength(1)
    expect(out[0].display_name).toBe('Kasra')
    expect(out[0].liveness).toBe('active')
  })
})

describe('countActive', () => {
  it('counts only active rows', () => {
    const rows = [{ liveness: 'active' }, { liveness: 'dead' }, { liveness: 'active' }] as PresenceView[]
    expect(countActive(rows)).toBe(2)
  })
})
