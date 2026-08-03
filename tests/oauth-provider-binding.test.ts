import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

describe('OAuth provider binding ownership', () => {
  it('keeps the dashboard IdP selector separate from the OAuth helper binding', async () => {
    const stored = new Map<string, string>()
    const env = {
      IDP_PROVIDER: 'google',
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => ({ clientId: 'client-id' }),
        completeAuthorization: async () => ({ redirectTo: 'https://client.example/callback' }),
      },
      OAUTH_CLIENT_ID: 'dashboard-client-id',
      SESSIONS: {
        get: async (key: string) => stored.get(key) ?? null,
        put: async (key: string, value: string) => void stored.set(key, value),
        delete: async (key: string) => void stored.delete(key),
      },
    } as unknown as Env

    const response = await authApp.request('/login', {}, env)

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe('dashboard-client-id')
    expect(stored.size).toBe(1)
  })
})
