import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

function makeEnv(overrides: Partial<Env> = {}) {
  const sessions = new Map<string, string>()
  const users = new Map<string, { id: string; email: string | null; role: 'owner' | 'admin' | 'member' }>()

  const env = {
    TENANT_SLUG: 'local',
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: 'local-owner@mupot.test',
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => {
        sessions.set(key, value)
      },
      delete: async (key: string) => {
        sessions.delete(key)
      },
    },
    DB: {
      prepare(sql: string) {
        let boundArgs: unknown[] = []
        const first = async <T>(args: unknown[]): Promise<T | null> => {
          if (sql.includes('WHERE email')) {
            const email = args[0] as string
            return ([...users.values()].find((u) => u.email === email) ?? null) as T | null
          }
          if (sql.includes('WHERE id')) {
            const id = args[0] as string
            return (users.get(id) ?? null) as T | null
          }
          if (sql.includes('COUNT(*)')) {
            return { n: users.size } as T
          }
          return null as T | null
        }
        const run = async (args: unknown[]) => {
          if (sql.includes('INSERT INTO users')) {
            const [id, email, role] = args as [string, string | null, 'owner' | 'admin' | 'member']
            if (!users.has(id)) users.set(id, { id, email, role })
          }
          return { meta: { changes: 1 } }
        }
        const api = {
          bind(...args: unknown[]) {
            boundArgs = args
            return {
              first: <T>() => first<T>(args),
              run: () => run(args),
            }
          },
          first: <T>() => first<T>(boundArgs),
          run: () => run(boundArgs),
        }
        return api
      },
    },
    ...overrides,
  } as unknown as Env

  return { env, sessions, users }
}

describe('/auth/dev-login', () => {
  it('is disabled unless LOCAL_TEST_AUTH=1', async () => {
    const { env } = makeEnv({ LOCAL_TEST_AUTH: undefined })
    const res = await authApp.request('/dev-login', {}, env)
    expect(res.status).toBe(404)
  })

  it('mints a local owner session with a non-Secure localhost cookie', async () => {
    const { env, sessions, users } = makeEnv()

    const res = await authApp.request('/dev-login', {}, env)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('mupot_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).not.toContain('Secure')
    expect(sessions.size).toBeGreaterThanOrEqual(2) // session + presence marker
    expect([...users.values()][0]).toMatchObject({
      email: 'local-owner@mupot.test',
      role: 'owner',
    })
  })
})
