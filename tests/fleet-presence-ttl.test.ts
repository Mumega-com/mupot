// tests/fleet-presence-ttl.test.ts — derived liveness (presence) from heartbeat recency.
// presence is DISTINCT from the stored `status` intent: status=running is what attach set,
// presence=live/stale/offline is whether a heartbeat actually landed within the TTL.
import { describe, it, expect } from 'vitest'
import { derivePresence, presenceTtlSec, DEFAULT_PRESENCE_TTL_SEC } from '../src/fleet/registry'

const NOW = Date.parse('2026-06-30T22:00:00Z')
const at = (iso: string) => iso.replace('T', ' ').replace('Z', '')  // → SQLite 'YYYY-MM-DD HH:MM:SS'

describe('derivePresence', () => {
  it('live when status=running and last_seen within TTL', () => {
    expect(derivePresence('running', at('2026-06-30T21:59:00Z'), 180, NOW)).toBe('live')  // 60s old
  })

  it('stale when status=running but last_seen older than TTL', () => {
    expect(derivePresence('running', at('2026-06-30T21:50:00Z'), 180, NOW)).toBe('stale') // 600s old
  })

  it('offline when status=stopped, regardless of recency (intent wins)', () => {
    expect(derivePresence('stopped', at('2026-06-30T21:59:59Z'), 180, NOW)).toBe('offline')
  })

  it('boundary: exactly at TTL is still live (<=)', () => {
    expect(derivePresence('running', at('2026-06-30T21:57:00Z'), 180, NOW)).toBe('live')  // 180s exactly
  })

  it('one second past TTL is stale', () => {
    expect(derivePresence('running', at('2026-06-30T21:56:59Z'), 180, NOW)).toBe('stale') // 181s
  })

  it('future-dated stamp (clock skew) is within TTL → live, never crashes', () => {
    expect(derivePresence('running', at('2026-06-30T22:00:30Z'), 180, NOW)).toBe('live')
  })

  it('fails to STALE (never live) on empty or unparseable stamp', () => {
    expect(derivePresence('running', '', 180, NOW)).toBe('stale')
    expect(derivePresence('running', 'not-a-date', 180, NOW)).toBe('stale')
  })

  it('honest gap: a one-shot attach with no daemon decays running→stale after TTL', () => {
    // status stays 'running' (intent) but presence flips to stale once the heartbeat lapses —
    // it never reports `live` without a fresh ping.
    expect(derivePresence('running', at('2026-06-30T21:55:00Z'), 180, NOW)).toBe('stale')
  })
})

describe('presenceTtlSec', () => {
  it('defaults when unset', () => {
    expect(presenceTtlSec({} as never)).toBe(DEFAULT_PRESENCE_TTL_SEC)
  })
  it('honors a positive env override', () => {
    expect(presenceTtlSec({ FLEET_PRESENCE_TTL_SEC: '90' } as never)).toBe(90)
  })
  it('ignores junk / non-positive overrides (falls back to default)', () => {
    expect(presenceTtlSec({ FLEET_PRESENCE_TTL_SEC: 'abc' } as never)).toBe(DEFAULT_PRESENCE_TTL_SEC)
    expect(presenceTtlSec({ FLEET_PRESENCE_TTL_SEC: '0' } as never)).toBe(DEFAULT_PRESENCE_TTL_SEC)
    expect(presenceTtlSec({ FLEET_PRESENCE_TTL_SEC: '-5' } as never)).toBe(DEFAULT_PRESENCE_TTL_SEC)
  })
})
