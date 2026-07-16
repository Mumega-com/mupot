import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classify,
  humanAge,
  busConfigured,
  resolveFleetProject,
  resolveFleetSender,
  resolveFleetOpsAgent,
  fleetScoped,
  loadFleet,
} from '../src/dashboard/fleet'
import type { Env } from '../src/types'

const NOW = 1_780_000_000_000

describe('classify', () => {
  it('null → never', () => expect(classify(null, NOW)).toBe('never'))
  it('5m ago → active', () => expect(classify(NOW - 5 * 60_000, NOW)).toBe('active'))
  it('exactly 10m → active boundary', () => expect(classify(NOW - 10 * 60_000, NOW)).toBe('active'))
  it('2h ago → idle', () => expect(classify(NOW - 2 * 3_600_000, NOW)).toBe('idle'))
  it('3d ago → dead', () => expect(classify(NOW - 3 * 86_400_000, NOW)).toBe('dead'))
})

describe('humanAge', () => {
  it('never on null', () => expect(humanAge(null, NOW)).toBe('never'))
  it('just now under a minute', () => expect(humanAge(NOW - 10_000, NOW)).toBe('just now'))
  it('minutes', () => expect(humanAge(NOW - 7 * 60_000, NOW)).toBe('7m ago'))
  it('hours', () => expect(humanAge(NOW - 5 * 3_600_000, NOW)).toBe('5h ago'))
  it('days past 48h', () => expect(humanAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago'))
})

describe('busConfigured', () => {
  it('false without token', () => {
    expect(busConfigured({} as Env)).toBe(false)
  })
  it('true with token (default URL)', () => {
    expect(busConfigured({ BUS_TOKEN: 'x' } as Env)).toBe(true)
  })
})

// ── tenant-scoping (Flock #43) ────────────────────────────────────────────────
// The fleet window must scope to the pot's OWN bus project + ops agent. A tenant
// pot must never address the company `sos` fleet or route control to our `kasra`.
// The project string is env-derived (never request-derived) so a worker cannot be
// tricked into cross-tenant fan-out.

describe('resolveFleetProject', () => {
  it('explicit FLEET_PROJECT wins', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: 'sos', TENANT_SLUG: 'mumega' } as Env)).toBe('sos')
  })
  it('falls back to TENANT_SLUG for a tenant pot', () => {
    expect(resolveFleetProject({ TENANT_SLUG: 'digid' } as Env)).toBe('digid')
  })
  // FAIL CLOSED (adversarial P1): an unscoped pot must NOT default to the
  // company `sos` project — it returns null so the send is refused.
  it('null when nothing set (fail closed, never sos)', () => {
    expect(resolveFleetProject({} as Env)).toBeNull()
  })
  it('null on blank/whitespace env (no silent company fallback)', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: '   ', TENANT_SLUG: '  ' } as Env)).toBeNull()
  })
  it('trims whitespace', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: '  digid ' } as Env)).toBe('digid')
  })
  it('digid pot never resolves to the company sos project', () => {
    expect(resolveFleetProject({ TENANT_SLUG: 'digid', FLEET_PROJECT: 'digid' } as Env)).not.toBe('sos')
  })
})

describe('resolveFleetSender', () => {
  it('tenant-specific HQ id', () => {
    expect(resolveFleetSender({ TENANT_SLUG: 'digid' } as Env)).toBe('mupot-digid-hq')
  })
  it('company id from mumega slug', () => {
    expect(resolveFleetSender({ TENANT_SLUG: 'mumega' } as Env)).toBe('mupot-mumega-hq')
  })
  it('null when slug missing (fail closed)', () => {
    expect(resolveFleetSender({} as Env)).toBeNull()
  })
})

describe('resolveFleetOpsAgent', () => {
  it('explicit FLEET_OPS_AGENT wins', () => {
    expect(resolveFleetOpsAgent({ FLEET_OPS_AGENT: 'digid' } as Env)).toBe('digid')
  })
  // FAIL CLOSED (adversarial P1): no fallback to our `kasra` — an unscoped pot
  // must not route control to the company ops agent.
  it('null when unset (never falls back to kasra)', () => {
    expect(resolveFleetOpsAgent({} as Env)).toBeNull()
  })
  it('digid pot routes control to its own ops agent, never kasra', () => {
    expect(resolveFleetOpsAgent({ FLEET_OPS_AGENT: 'digid' } as Env)).not.toBe('kasra')
  })
})

// ── env-overridable bus URL (de-mumega-ify #4: already correct pre-existing,
// this locks it in with an explicit test). DEFAULT_BUS_URL is only a fallback —
// env.BUS_URL, when set, wins; unset ⇒ byte-identical default host.
describe('loadFleet — bus URL resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hits the default bus.mumega.com host when BUS_URL is unset', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response(JSON.stringify({ fleet: [] }), { status: 200 })
      }),
    )
    await loadFleet({ BUS_TOKEN: 'x' } as Env, 0)
    expect(calls).toEqual(['https://bus.mumega.com/fleet'])
  })

  it('hits the fork-provided BUS_URL when set', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response(JSON.stringify({ fleet: [] }), { status: 200 })
      }),
    )
    await loadFleet({ BUS_TOKEN: 'x', BUS_URL: 'https://bus.forkedpot.example/' } as Env, 0)
    expect(calls).toEqual(['https://bus.forkedpot.example/fleet'])
  })
})

describe('fleetScoped', () => {
  it('false without bus token even if project set', () => {
    expect(fleetScoped({ FLEET_PROJECT: 'digid', TENANT_SLUG: 'digid' } as Env)).toBe(false)
  })
  it('false when bus configured but pot unscoped (no project/slug)', () => {
    expect(fleetScoped({ BUS_TOKEN: 'x' } as Env)).toBe(false)
  })
  it('true when bus configured AND scoped', () => {
    expect(fleetScoped({ BUS_TOKEN: 'x', TENANT_SLUG: 'digid' } as Env)).toBe(true)
  })
})
