// Pins the connector-vault registration for the 'linear' type added on
// flight-20260803-linear-posthog: useConnectorById's authenticatedFetch must build a
// raw-key Authorization header for 'linear' (Linear's GraphQL API takes the API key
// verbatim, unlike posthog/inkwell's "Bearer " scheme), following the SAME extension
// point telegram/posthog/mcpwp/inkwell already register through in
// src/connectors/service.ts — no parallel mechanism invented.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { useConnectorById } from '../src/connectors/service'
import type { Env } from '../src/types'

const MASTER_KEY = '33'.repeat(32)

async function vaultEnv(type: 'linear' | 'posthog' | 'mcpwp' | 'custom', secret: string, meta: string | null = null) {
  const id = `connector-${type}`
  const encryptedSecret = await encryptConnectorSecret(MASTER_KEY, id, type, secret)
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement },
        async first<T>() {
          const [rowId, tenant, rowType] = binds
          if (rowId !== id || tenant !== 'tenant-a' || rowType !== type) return null
          return { id, type, encrypted_secret: encryptedSecret, meta } as T
        },
      }
      return statement
    },
  } as unknown as D1Database
  return { env: { DB: db, TENANT_SLUG: 'tenant-a', CONNECTOR_MASTER_KEY: MASTER_KEY } as Env, id }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useConnectorById — linear auth header registration', () => {
  it('sets Authorization to the raw key (no Bearer prefix)', async () => {
    const secret = 'lin_test_key_123'
    const { env, id } = await vaultEnv('linear', secret)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await useConnectorById(env, id, 'linear', async (connector) => {
      await connector.authenticatedFetch('https://api.linear.app/graphql', { method: 'POST' })
      return { status: 'available' as const, observations: [] }
    })
    expect(result).toEqual({ status: 'available', observations: [] })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe(secret)
  })

  it('regression: posthog keeps its Bearer-prefixed header', async () => {
    const secret = 'posthog-secret'
    const { env, id } = await vaultEnv('posthog', secret)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await useConnectorById(env, id, 'posthog', async (connector) => {
      await connector.authenticatedFetch('https://us.posthog.com/api/x', { method: 'POST' })
      return { status: 'available' as const, observations: [] }
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`)
  })

  it('unsupported connector type still throws (no silent fallback)', async () => {
    const secret = 'custom-secret'
    const { env, id } = await vaultEnv('custom', secret)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    // The throw inside authenticatedFetch propagates through useConnectorById's own
    // try/catch as a rejected 'connector_use_failed' — never a silent success/null.
    await expect(
      useConnectorById(env, id, 'custom', async (connector) => {
        await connector.authenticatedFetch('https://example.com', { method: 'POST' })
        return { status: 'available' as const, observations: [] }
      }),
    ).rejects.toThrow('connector_use_failed')
  })
})
