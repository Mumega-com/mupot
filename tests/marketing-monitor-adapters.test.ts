import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

import {
  MARKETING_MONITOR_ADAPTERS,
  createFirstPartyMarketingSource,
  createInkwellMarketingSource,
  createMcpwpMarketingSource,
  createPosthogMarketingSource,
} from '../src/addons/marketing/adapters'
import type { MonitorWindow, ResolvedAddonBinding } from '../src/addons/marketing/types'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { useConnectorById } from '../src/connectors/service'
import type { ConnectorType } from '../src/connectors/service'
import type { Env } from '../src/types'

const MASTER_KEY = '11'.repeat(32)
const RUN_ID = 'run-adapters-1'
const window: MonitorWindow = {
  start: '2026-07-16T00:00:00.000Z',
  end: '2026-07-16T23:59:59.999Z',
}

const firstPartyBinding: ResolvedAddonBinding = {
  id: 'binding-first-party',
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
  capability: 'read',
  connectorId: null,
}

function vaultBinding(
  adapter: 'posthog' | 'inkwell' | 'mcpwp',
  connectorId = `connector-${adapter}`,
): ResolvedAddonBinding {
  return {
    id: `binding-${adapter}`,
    slot: adapter === 'posthog' ? 'web_analytics' : 'content_surface',
    adapter,
    bindingKind: 'vault_connector',
    capability: 'read',
    connectorId,
  }
}

interface VaultFixture {
  readonly id: string
  readonly tenant: string
  readonly type: ConnectorType
  readonly encryptedSecret: string
  readonly meta: string | null
  readonly revokedAt?: string | null
}

async function connectorFixture(
  type: ConnectorType,
  secret: string,
  meta: Record<string, unknown> | null,
  overrides: Partial<Pick<VaultFixture, 'id' | 'tenant' | 'revokedAt'>> = {},
): Promise<VaultFixture> {
  const id = overrides.id ?? `connector-${type}`
  return {
    id,
    tenant: overrides.tenant ?? 'tenant-a',
    type,
    encryptedSecret: await encryptConnectorSecret(MASTER_KEY, id, type, secret),
    meta: meta === null ? null : JSON.stringify(meta),
    revokedAt: overrides.revokedAt ?? null,
  }
}

function vaultEnv(connectors: readonly VaultFixture[], overrides: Partial<Env> = {}): Env {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = []
      const statement = {
        bind(...values: unknown[]) {
          binds = values
          return statement
        },
        async first<T>() {
          const [id, tenant, type] = binds
          const connector = connectors.find((candidate) => (
            candidate.id === id
            && candidate.tenant === tenant
            && candidate.type === type
            && candidate.revokedAt === null
          ))
          if (!connector) return null
          return {
            id: connector.id,
            type: connector.type,
            encrypted_secret: connector.encryptedSecret,
            meta: connector.meta,
          } as T
        },
      }
      expect(sql).toContain('id = ?1')
      expect(sql).toContain('tenant = ?2')
      expect(sql).toContain('revoked_at IS NULL')
      return statement
    },
  } as unknown as D1Database

  return {
    DB: db,
    TENANT_SLUG: 'tenant-a',
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    ...overrides,
  } as Env
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('exact-ID connector use', () => {
  it('gives adapter code only an expiring authenticated-fetch capability', async () => {
    const secret = 'vault-only-posthog-key'
    const connector = await connectorFixture('posthog', secret, {
      projectId: '436189',
      host: 'https://us.posthog.com',
    })
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)
    let retained: Parameters<Parameters<typeof useConnectorById>[3]>[0] | undefined

    const result = await useConnectorById(
      vaultEnv([connector]),
      connector.id,
      'posthog',
      async (resolved) => {
        retained = resolved
        expect(Object.isFrozen(resolved)).toBe(true)
        expect('secret' in resolved).toBe(false)
        expect('call' in resolved).toBe(false)
        expect('token' in resolved).toBe(false)
        expect('appPassword' in resolved).toBe(false)
        expect(Object.keys(resolved).sort()).toEqual(['authenticatedFetch', 'id', 'meta', 'type'])
        expect(JSON.stringify(resolved)).not.toContain(secret)
        await resolved.authenticatedFetch('https://us.posthog.com/api/projects/436189/query/', {
          method: 'POST',
        })
        return { status: 'available' as const, observations: [] }
      },
    )

    expect(result).toEqual({ status: 'available', observations: [] })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`)
    await expect(retained?.authenticatedFetch('https://us.posthog.com/after-return'))
      .rejects.toThrow('connector_use_expired')
  })

  it('freshly remaps secret-bearing fetch errors even after adapter mutation', async () => {
    const secret = 'vault-error-must-be-scrubbed'
    const connector = await connectorFixture('posthog', secret, null)
    const upstreamError = new Error(`upstream rejected Bearer ${secret}`)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw upstreamError
    }))

    let capabilityError: unknown
    let capabilityMessageBeforeMutation: string | undefined
    let thrown: unknown
    try {
      await useConnectorById(
        vaultEnv([connector]),
        connector.id,
        'posthog',
        async (resolved) => {
          try {
            await resolved.authenticatedFetch('https://us.posthog.com/api/projects/1/query/')
          } catch (error) {
            capabilityError = error
            capabilityMessageBeforeMutation = error instanceof Error ? error.message : String(error)
            if (error instanceof Error) error.message = `adapter rewrote error with ${secret}`
            throw error
          }
          return { status: 'available' as const, observations: [] }
        },
      )
    } catch (error) {
      thrown = error
    }

    expect(capabilityError).not.toBe(upstreamError)
    expect(capabilityMessageBeforeMutation).toBe('connector_fetch_failed')
    expect(capabilityError).toEqual(new Error(`adapter rewrote error with ${secret}`))
    expect(thrown).toEqual(new Error('connector_use_failed'))
    expect(thrown).not.toBe(capabilityError)
    expect(thrown).not.toBe(upstreamError)
    expect(String(thrown)).not.toContain(secret)
  })

  it('returns null without invoking the callback for a wrong connector type', async () => {
    const connector = await connectorFixture('inkwell', 'wrong-type-secret', null, {
      id: 'wrong-type',
    })
    const callback = vi.fn()

    await expect(useConnectorById(vaultEnv([connector]), connector.id, 'posthog', callback)).resolves.toBeNull()
    expect(callback).not.toHaveBeenCalled()
  })

  it('returns null without decrypting or invoking the callback for tenant mismatch or revocation', async () => {
    const wrongTenant = await connectorFixture('posthog', 'wrong-tenant-secret', null, {
      id: 'wrong-tenant',
      tenant: 'tenant-b',
    })
    const revoked = await connectorFixture('posthog', 'revoked-secret', null, {
      id: 'revoked',
      revokedAt: '2026-07-16T10:00:00.000Z',
    })
    const callback = vi.fn()

    await expect(useConnectorById(vaultEnv([wrongTenant]), wrongTenant.id, 'posthog', callback)).resolves.toBeNull()
    await expect(useConnectorById(vaultEnv([revoked]), revoked.id, 'posthog', callback)).resolves.toBeNull()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('first-party marketing adapter', () => {
  it('maps tenant-scoped metric points into normalized observations without DB writes', async () => {
    const sql: string[] = []
    const binds: unknown[][] = []
    const dbWrites: string[] = []
    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: {
        prepare(statementSql: string) {
          sql.push(statementSql)
          if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statementSql)) dbWrites.push(statementSql)
          const statement = {
            bind(...values: unknown[]) {
              binds.push(values)
              return statement
            },
            async all() {
              const bound = binds[binds.length - 1] ?? []
              const windowStart = bound[bound.length - 2] as string
              const windowEnd = bound[bound.length - 1] as string
              const rows = [
                { metric_key: 'seo.organic_sessions', value: 41, occurred_at: '2026-07-16T12:00:00.000Z' },
                { metric_key: 'seo.conversion_rate', value: 0.12, occurred_at: '2026-07-16T12:00:00.000Z' },
                { metric_key: 'ops.throughput', value: 9, occurred_at: '2026-07-16T12:00:00.000Z' },
                { metric_key: 'growth.leads', value: 3, occurred_at: '2026-07-15T23:59:59.999Z' },
              ]
              return {
                results: rows.filter((row) => (
                  row.occurred_at >= windowStart
                  && row.occurred_at <= windowEnd
                )),
              }
            },
          }
          return statement
        },
      },
    } as unknown as Env

    const snapshot = await createFirstPartyMarketingSource(RUN_ID).read(env, firstPartyBinding, window)

    expect(snapshot).toEqual({
      status: 'available',
      observations: [
        expect.objectContaining({
          runId: RUN_ID,
          metricKey: 'seo.organic_sessions',
          value: 41,
          unit: 'count',
          authority: 'first-party',
          observedAt: '2026-07-16T12:00:00.000Z',
        }),
        expect.objectContaining({
          runId: RUN_ID,
          metricKey: 'seo.conversion_rate',
          value: 0.12,
          unit: 'ratio',
          authority: 'first-party',
          observedAt: '2026-07-16T12:00:00.000Z',
        }),
      ],
    })
    expect(sql).toHaveLength(1)
    expect(sql[0]).toContain('tenant_id = ?')
    expect(sql[0]).toContain('metric_key IN (')
    expect(sql[0]).toContain('occurred_at >= ?')
    expect(sql[0]).toContain('occurred_at <= ?')
    expect(binds[0][0]).toBe('tenant-a')
    expect(binds[0]).toContain(window.start)
    expect(binds[0]).toContain(window.end)
    expect(dbWrites).toEqual([])
  })

  it('does not rely on the CRO top-200 scan (posthog ticks must not crowd out marketing keys)', async () => {
    const sql: string[] = []
    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: {
        prepare(statementSql: string) {
          sql.push(statementSql)
          return {
            bind() { return this },
            async all() { return { results: [] } },
          }
        },
      },
    } as unknown as Env

    await createFirstPartyMarketingSource(RUN_ID).read(env, firstPartyBinding, window)
    expect(sql[0]).not.toMatch(/LIKE \?/)
    expect(sql[0]).toContain('metric_key IN (')
  })
})

describe('PostHog marketing adapter', () => {
  it('uses the aggregate only as a health read and does not fabricate a marketing metric', async () => {
    const secret = 'posthog-vault-secret'
    const connector = await connectorFixture('posthog', secret, {
      projectId: '436189',
      host: 'https://us.posthog.com',
    })
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({ results: [[1234, 56]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('posthog'),
      window,
    )

    expect(snapshot).toEqual({
      status: 'available',
      observations: [],
    })
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://us.posthog.com/api/projects/436189/query/')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(String(init.body)).toContain('HogQLQuery')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(url).not.toContain(secret)
    expect(String(init.body)).not.toContain(secret)
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('rejects non-public hosts and never exposes the secret or upstream body in failures', async () => {
    const secret = 'posthog-never-echo'
    const privateConnector = await connectorFixture('posthog', secret, {
      projectId: '436189',
      host: 'https://169.254.169.254',
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const privateResult = await createPosthogMarketingSource(RUN_ID).read(
      vaultEnv([privateConnector]),
      vaultBinding('posthog'),
      window,
    )

    expect(privateResult).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(privateResult)).not.toContain(secret)

    const publicConnector = await connectorFixture('posthog', secret, {
      projectId: '436189',
      host: 'https://us.posthog.com',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`denied ${secret}`, { status: 401 })))
    const failed = await createPosthogMarketingSource(RUN_ID).read(
      vaultEnv([publicConnector]),
      vaultBinding('posthog'),
      window,
    )
    expect(failed).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(JSON.stringify(failed)).not.toContain('denied')
  })

  it('refuses PostHog redirects instead of following them past the SSRF guard', async () => {
    const connector = await connectorFixture('posthog', 'posthog-redirect-secret', {
      projectId: '436189',
      host: 'https://us.posthog.com',
    })
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('posthog'),
      window,
    )

    expect(snapshot).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
  })
})

describe('PostHog marketing adapter — env-credentials fallback (no vault connector)', () => {
  const envFallbackBinding: ResolvedAddonBinding = {
    id: 'binding-posthog-env',
    slot: 'web_analytics',
    adapter: 'posthog',
    bindingKind: 'internal_adapter',
    capability: 'read',
    connectorId: null,
  }

  function envWithoutConnectors(overrides: Partial<Env> = {}): Env {
    return { TENANT_SLUG: 'tenant-a', ...overrides } as Env
  }

  it('is unavailable and makes no fetch when env credentials are absent', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors(),
      envFallbackBinding,
      window,
    )

    expect(snapshot).toEqual({ status: 'unavailable', reason: 'source_unavailable', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('emits seo.organic_sessions from Worker env credentials, stamped at the window end', async () => {
    const key = 'posthog-env-personal-key'
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({ results: [[7]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors({
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: key,
        POSTHOG_HOST: 'https://us.posthog.com',
      }),
      envFallbackBinding,
      window,
    )

    expect(snapshot).toEqual({
      status: 'available',
      observations: [expect.objectContaining({
        runId: RUN_ID,
        metricKey: 'seo.organic_sessions',
        value: 7,
        unit: 'count',
        authority: 'posthog',
        observedAt: window.end,
      })],
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://us.posthog.com/api/projects/436189/query/')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(String(init.body)).toContain('HogQLQuery')
    expect(String(init.body)).toContain('organic_sessions')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(url).not.toContain(key)
    expect(String(init.body)).not.toContain(key)
    expect(JSON.stringify(snapshot)).not.toContain(key)
  })

  it('never fabricates a value when the query returns no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors({
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: 'k',
        POSTHOG_HOST: 'https://us.posthog.com',
      }),
      envFallbackBinding,
      window,
    )

    expect(snapshot).toEqual({ status: 'unavailable', reason: 'source_unavailable', observations: [] })
  })

  it('rejects a non-public POSTHOG_HOST without making a request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors({
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: 'k',
        POSTHOG_HOST: 'https://169.254.169.254',
      }),
      envFallbackBinding,
      window,
    )

    expect(snapshot).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses redirects and never leaks the key on a failed response', async () => {
    const key = 'posthog-env-never-echo'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`denied ${key}`, { status: 401 })))

    const failed = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors({
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: key,
        POSTHOG_HOST: 'https://us.posthog.com',
      }),
      envFallbackBinding,
      window,
    )
    expect(failed).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(JSON.stringify(failed)).not.toContain(key)
    expect(JSON.stringify(failed)).not.toContain('denied')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    })))
    const redirected = await createPosthogMarketingSource(RUN_ID).read(
      envWithoutConnectors({
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: key,
        POSTHOG_HOST: 'https://us.posthog.com',
      }),
      envFallbackBinding,
      window,
    )
    expect(redirected).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
  })

  it('still routes to the vault-connector path when a connectorId IS bound', async () => {
    // Same source instance, different binding shape — the vault path (existing,
    // unchanged health-read-only behavior) must still run when a real connector is bound,
    // even though env credentials also happen to be present.
    const secret = 'vault-still-wins'
    const connector = await connectorFixture('posthog', secret, {
      projectId: '436189',
      host: 'https://us.posthog.com',
    })
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createPosthogMarketingSource(RUN_ID).read(
      vaultEnv([connector], {
        POSTHOG_PROJECT_ID: '436189',
        POSTHOG_PERSONAL_API_KEY: 'env-key-should-be-ignored',
      }),
      vaultBinding('posthog'),
      window,
    )

    expect(snapshot).toEqual({ status: 'available', observations: [] })
    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`)
  })
})

describe('Inkwell marketing adapter', () => {
  it('emits posts_published=0 for a reachable single-slug GET (not a window count)', async () => {
    const secret = 'inkwell-vault-secret'
    const connector = await connectorFixture('inkwell', secret, { slug: 'home' })
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({
        ok: true,
        title: 'Home',
        description: 'Public home page',
        author: 'Mupot',
        tags: [],
        status: 'published',
        content: '# Home',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createInkwellMarketingSource(RUN_ID).read(
      vaultEnv([connector], { INKWELL_API_URL: 'https://inkwell.example.com' }),
      vaultBinding('inkwell'),
      window,
    )

    expect(snapshot).toEqual({
      status: 'available',
      observations: [
        expect.objectContaining({
          metricKey: 'content.posts_published',
          value: 0,
          unit: 'count',
          authority: 'inkwell',
          observedAt: window.end,
        }),
      ],
    })
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/internal/content/home?tenant_slug=tenant-a')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('returns stable unavailable/failed results without exposing secret-bearing errors', async () => {
    const secret = 'inkwell-never-echo'
    const missingMeta = await connectorFixture('inkwell', secret, null)
    const unavailable = await createInkwellMarketingSource(RUN_ID).read(
      vaultEnv([missingMeta], { INKWELL_API_URL: 'https://inkwell.example.com' }),
      vaultBinding('inkwell'),
      window,
    )
    expect(unavailable).toEqual({ status: 'unavailable', reason: 'source_unavailable', observations: [] })

    const connector = await connectorFixture('inkwell', secret, { slug: 'home' })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`upstream Authorization Bearer ${secret}`)
    }))
    const failed = await createInkwellMarketingSource(RUN_ID).read(
      vaultEnv([connector], { INKWELL_API_URL: 'https://inkwell.example.com' }),
      vaultBinding('inkwell'),
      window,
    )
    expect(failed).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(JSON.stringify(failed)).not.toContain('Authorization')
  })
})

describe('MCPWP marketing adapter', () => {
  it('performs one bounded metadata-only GET for published posts and refuses redirects', async () => {
    const secret = 'wordpress-application-password'
    const connector = await connectorFixture('mcpwp', secret, {
      siteUrl: 'https://wordpress.example.com/path',
      username: 'agent',
    })
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify([{
        id: 7,
        slug: 'published-post',
        link: 'https://wordpress.example.com/published-post',
        date: '2026-07-16T12:00:00',
        modified: '2026-07-16T12:30:00',
        title: { rendered: 'Published post' },
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createMcpwpMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('mcpwp'),
      window,
    )

    expect(snapshot).toEqual({
      status: 'available',
      observations: [
        expect.objectContaining({
          metricKey: 'content.posts_published',
          value: 1,
          unit: 'count',
          authority: 'mcpwp',
          observedAt: window.end,
        }),
      ],
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [rawUrl, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const url = new URL(rawUrl)
    expect(url.origin).toBe('https://wordpress.example.com')
    expect(url.pathname).toBe('/wp-json/wp/v2/posts')
    expect(url.searchParams.get('status')).toBe('publish')
    expect(Number(url.searchParams.get('per_page'))).toBeLessThanOrEqual(50)
    expect(url.searchParams.get('_fields')?.split(',').sort()).toEqual(
      ['date', 'id', 'link', 'modified', 'slug', 'title'].sort(),
    )
    expect(url.searchParams.get('_fields')).not.toContain('content')
    expect(url.searchParams.get('_fields')).not.toContain('excerpt')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${btoa(`agent:${secret}`)}`,
    )
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('refuses an actual 3xx response without following its location', async () => {
    const connector = await connectorFixture('mcpwp', 'wordpress-redirect-secret', {
      siteUrl: 'https://wordpress.example.com',
      username: 'agent',
    })
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://redirect.example.com/posts' },
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const snapshot = await createMcpwpMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('mcpwp'),
      window,
    )

    expect(snapshot).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('uses an eight-second timeout and never echoes response bodies or credentials', async () => {
    vi.useFakeTimers()
    const secret = 'wordpress-never-echo'
    const connector = await connectorFixture('mcpwp', secret, {
      siteUrl: 'https://wordpress.example.com',
      username: 'agent',
    })
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markFetchStarted?.()
      init?.signal?.addEventListener('abort', () => reject(new Error(`aborted ${secret}`)))
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const pending = createMcpwpMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('mcpwp'),
      window,
    )
    await fetchStarted
    await vi.advanceTimersByTimeAsync(8_001)
    const timedOut = await pending
    expect(timedOut).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(JSON.stringify(timedOut)).not.toContain(secret)

    vi.useRealTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`credential rejected: ${secret}`, { status: 403 })))
    const failed = await createMcpwpMarketingSource(RUN_ID).read(
      vaultEnv([connector]),
      vaultBinding('mcpwp'),
      window,
    )
    expect(failed).toEqual({ status: 'failed', reason: 'source_unavailable', observations: [] })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(JSON.stringify(failed)).not.toContain('credential rejected')
  })
})

describe('marketing adapter registry', () => {
  it('registers exactly the four Task 6 adapters as run-scoped source factories', () => {
    expect(MARKETING_MONITOR_ADAPTERS.map((record) => record.adapter)).toEqual([
      'first_party',
      'posthog',
      'inkwell',
      'mcpwp',
    ])
    expect(MARKETING_MONITOR_ADAPTERS.map((record) => record.create(RUN_ID))).toEqual([
      expect.objectContaining({ key: 'first_party', slot: 'web_analytics', read: expect.any(Function) }),
      expect.objectContaining({ key: 'posthog', slot: 'web_analytics', read: expect.any(Function) }),
      expect.objectContaining({ key: 'inkwell', slot: 'content_surface', read: expect.any(Function) }),
      expect.objectContaining({ key: 'mcpwp', slot: 'content_surface', read: expect.any(Function) }),
    ])
  })
})
