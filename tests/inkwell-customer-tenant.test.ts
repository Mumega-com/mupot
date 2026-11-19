// B3c: department-gate drafts go to the customer's OWN Inkwell tenant (the task's squad-scoped connector's
// meta.tenantSlug), never the operator's env.TENANT_SLUG, and never to another customer's tenant.
// Assertions are on the actual Inkwell HTTP call (tenant_slug in the body), not only on status.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../src/connectors/service', async (orig) => ({
  ...(await orig<typeof import('../src/connectors/service')>()),
  resolveConnector: vi.fn(),
  resolveConnectorWithMeta: vi.fn(),
  resolveSquadConnectorWithMeta: vi.fn(),
}))

import { dashboardApp } from '../src/dashboard/index'
import { resolveConnectorWithMeta, resolveSquadConnectorWithMeta } from '../src/connectors/service'
import { parseInkwellTenantSlug } from '../src/departments/inkwell-target'
import type { Env } from '../src/types'

const mockSquad = vi.mocked(resolveSquadConnectorWithMeta)
const mockWithMeta = vi.mocked(resolveConnectorWithMeta)

const OPERATOR_SLUG = 'operator-pot'
const GATE = 'task-1'

function envFor(taskSquad: string | null | 'no-task'): Env {
  return {
    TENANT_SLUG: OPERATOR_SLUG,
    BRAND: 'Test',
    INKWELL_API_URL: 'https://inkwell-api.example.com',
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: (..._args: unknown[]) => ({
          async first<T>() {
            if (sql.includes('FROM task_verdicts')) return { verdict: 'approved' } as unknown as T
            if (sql.includes('FROM department_proposals')) {
              return {
                gate_id: GATE, tenant_id: OPERATOR_SLUG, department_key: 'growth', action: 'content-publish',
                payload_json: JSON.stringify({ executor: 'inkwell-content', title: 'T', content: 'body', status: 'draft' }),
              } as unknown as T
            }
            if (sql.includes('FROM tasks WHERE id')) {
              return (taskSquad === 'no-task' ? null : { squad_id: taskSquad }) as unknown as T
            }
            return null as unknown as T
          },
          async run() { return { meta: { changes: 1 } } },
          async all() { return { results: [] } },
        }),
      })),
    },
    SESSIONS: { get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'owner', createdAt: '2026-01-01T00:00:00Z' })) },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

const post = () =>
  new Request(`https://pot.test/admin/departments/growth/execute/${GATE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=s', Origin: 'https://pot.test' },
  })

let inkwellFetch: ReturnType<typeof vi.fn>
beforeEach(() => {
  mockWithMeta.mockResolvedValue(null)
  mockSquad.mockReset()
  inkwellFetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', inkwellFetch)
})
afterEach(() => vi.unstubAllGlobals())

const sentTenants = (): string[] =>
  inkwellFetch.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).tenant_slug as string)

describe('execute route: Inkwell destination is the customer tenant', () => {
  it('task in squad-a with connector meta.tenantSlug tenant-a sends tenant_slug tenant-a (draft)', async () => {
    mockSquad.mockResolvedValue({ secret: 'tok-a', meta: JSON.stringify({ tenantSlug: 'tenant-a' }) })
    const res = await dashboardApp.fetch(post(), envFor('squad-a'))
    expect(res.status).toBe(200)
    expect(mockSquad).toHaveBeenCalledWith(expect.anything(), 'squad-a', 'inkwell')
    expect(inkwellFetch).toHaveBeenCalledTimes(1)
    expect(sentTenants()).toEqual(['tenant-a'])
    expect(JSON.parse(String((inkwellFetch.mock.calls[0][1] as RequestInit).body)).status).toBe('draft')
  })

  it('customer B task never sends customer A tenantSlug', async () => {
    mockSquad.mockImplementation(async (_e, squadId) =>
      squadId === 'squad-a'
        ? { secret: 'tok-a', meta: JSON.stringify({ tenantSlug: 'tenant-a' }) }
        : squadId === 'squad-b'
          ? { secret: 'tok-b', meta: JSON.stringify({ tenantSlug: 'tenant-b' }) }
          : null,
    )
    await dashboardApp.fetch(post(), envFor('squad-b'))
    expect(sentTenants()).toEqual(['tenant-b'])
    expect(sentTenants()).not.toContain('tenant-a')
  })

  it.each([
    ['meta missing', null],
    ['meta not json', 'nope'],
    ['meta without tenantSlug', JSON.stringify({ other: 1 })],
    ['empty tenantSlug', JSON.stringify({ tenantSlug: '  ' })],
    ['non-string tenantSlug', JSON.stringify({ tenantSlug: 7 })],
    ['malformed tenantSlug', JSON.stringify({ tenantSlug: 'a/../b' })],
  ])('%s → refused 503 executor_not_configured, 0 Inkwell calls, no operator fallback', async (_n, meta) => {
    mockSquad.mockResolvedValue({ secret: 'tok-a', meta })
    const res = await dashboardApp.fetch(post(), envFor('squad-a'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
    expect(inkwellFetch).not.toHaveBeenCalled()
  })

  it('no squad connector → refused, 0 Inkwell calls', async () => {
    mockSquad.mockResolvedValue(null)
    const res = await dashboardApp.fetch(post(), envFor('squad-a'))
    expect(res.status).toBe(503)
    expect(inkwellFetch).not.toHaveBeenCalled()
  })

  it('gate with no task row → refused, connector lookup never attempted', async () => {
    mockSquad.mockResolvedValue({ secret: 'tok', meta: JSON.stringify({ tenantSlug: 'tenant-a' }) })
    const res = await dashboardApp.fetch(post(), envFor('no-task'))
    expect(res.status).toBe(503)
    expect(mockSquad).not.toHaveBeenCalled()
    expect(inkwellFetch).not.toHaveBeenCalled()
  })

  it('the operator TENANT_SLUG is never sent to Inkwell, in any outcome', async () => {
    mockSquad.mockResolvedValue({ secret: 'tok-a', meta: JSON.stringify({ tenantSlug: 'tenant-a' }) })
    await dashboardApp.fetch(post(), envFor('squad-a'))
    mockSquad.mockResolvedValue({ secret: 'tok-a', meta: JSON.stringify({}) })
    await dashboardApp.fetch(post(), envFor('squad-a'))
    expect(sentTenants()).not.toContain(OPERATOR_SLUG)
    expect(sentTenants()).toEqual(['tenant-a'])
  })

  it('non-admin stays forbidden (authority not widened)', async () => {
    mockSquad.mockResolvedValue({ secret: 'tok-a', meta: JSON.stringify({ tenantSlug: 'tenant-a' }) })
    const env = envFor('squad-a')
    ;(env.SESSIONS.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ userId: 'u2', email: 'm@b.com', role: 'member', createdAt: '2026-01-01T00:00:00Z' }),
    )
    const res = await dashboardApp.fetch(post(), env)
    expect(res.status).toBe(403)
    expect(inkwellFetch).not.toHaveBeenCalled()
  })
})

describe('parseInkwellTenantSlug', () => {
  it('accepts a plain slug, rejects junk', () => {
    expect(parseInkwellTenantSlug('{"tenantSlug":"tenant-a"}')).toBe('tenant-a')
    expect(parseInkwellTenantSlug('[]')).toBeNull()
    expect(parseInkwellTenantSlug('null')).toBeNull()
  })
})

describe('resolveSquadConnectorWithMeta is strictly squad-scoped', async () => {
  const real = await vi.importActual<typeof import('../src/connectors/service')>('../src/connectors/service')
  it('queries only scope_type=squad for the given squad (no pot/agent fallthrough)', async () => {
    const seen: { sql: string; args: unknown[] }[] = []
    const env = {
      TENANT_SLUG: OPERATOR_SLUG,
      CONNECTOR_MASTER_KEY: 'k',
      DB: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => { seen.push({ sql, args }); return null } }) }) },
    } as unknown as Env
    expect(await real.resolveSquadConnectorWithMeta(env, 'squad-a', 'inkwell')).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0].sql).toContain("scope_type = 'squad'")
    expect(seen[0].sql).not.toMatch(/scope_type\s*=\s*'pot'|OR\s+scope_type/i)
    expect(seen[0].args).toEqual([OPERATOR_SLUG, 'inkwell', 'squad-a'])
    expect(await real.resolveSquadConnectorWithMeta(env, '', 'inkwell')).toBeNull()
  })
})
