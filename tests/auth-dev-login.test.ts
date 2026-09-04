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

  // mupot#1299 pins this here, next to the code that sets the cookie.
  //
  // The WFP dispatch branch forwards the incoming request to a tenant's User Worker with
  // its headers intact, INCLUDING Cookie. That is only safe because this cookie is
  // host-only: with no `Domain=` attribute a browser sends it to mupot.mumega.com and
  // nowhere else, so it never reaches `<tenant>.mupot.mumega.com`. Adding `Domain=` here
  // to "share the session across subdomains" would hand every tenant Worker in the
  // dispatch namespace a valid colony session cookie, and the dispatcher comment claiming
  // stripping is unnecessary would silently become false.
  //
  // If this test fails, do NOT relax it — go re-read src/dispatcher.ts and strip
  // credentials on the dispatch branch first.
  it('scopes the session cookie to the host — no Domain= (guards the dispatch branch)', async () => {
    const { env } = makeEnv()
    const res = await authApp.request('/dev-login', {}, env)
    const setCookie = res.headers.get('set-cookie') ?? ''

    expect(setCookie).toContain('mupot_session=')
    expect(setCookie.toLowerCase()).not.toContain('domain=')
  })
})
