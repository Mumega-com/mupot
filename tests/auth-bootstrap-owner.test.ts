import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

type Role = 'owner' | 'admin' | 'member'
type User = { id: string; email: string | null; role: Role }

function makeEnv(
  overrides: Partial<Env> = {},
  seedUsers: User[] = [],
) {
  const sessions = new Map<string, string>()
  const users = new Map<string, User>(seedUsers.map((user) => [user.id, { ...user }]))
  let claim: { userId: string } | null = null

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement = {
        __sql: sql,
        get __args() { return args },
        bind(...values: unknown[]) {
          args = values
          return statement
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SELECT id FROM users WHERE email')) {
            const email = args[0] as string
            return ([...users.values()].find((user) => user.email === email) ?? null) as T | null
          }
          if (sql.includes('SELECT user_id FROM owner_bootstrap_claim')) {
            return (claim ? { user_id: claim.userId } : null) as T | null
          }
          if (sql.includes('SELECT 1 AS present FROM owner_bootstrap_claim')) {
            return (claim ? { present: 1 } : null) as T | null
          }
          if (sql.includes('SELECT id, email, role FROM users WHERE id')) {
            const id = args[0] as string
            return (users.get(id) ?? null) as T | null
          }
          if (sql.includes("SELECT 1 AS present FROM users WHERE role = 'owner'")) {
            return ([...users.values()].some((user) => user.role === 'owner') ? { present: 1 } : null) as T | null
          }
          return null
        },
      }
      return statement
    },
    async batch(statements: Array<{ __sql: string; __args: unknown[] }>) {
      const claimStatement = statements.find((statement) => statement.__sql.includes('INSERT INTO owner_bootstrap_claim'))
      const userStatement = statements.find((statement) => statement.__sql.includes('INSERT INTO users'))
      if (!claimStatement || !userStatement) throw new Error('unexpected bootstrap batch')
      if (claim) throw new Error('D1_ERROR: UNIQUE constraint failed: owner_bootstrap_claim.singleton')

      const [id, email] = userStatement.__args as [string, string]
      const existingByEmail = [...users.values()].find((user) => user.email === email)
      if (existingByEmail) existingByEmail.role = 'owner'
      else users.set(id, { id, email, role: 'owner' })
      claim = { userId: claimStatement.__args[0] as string }
      return []
    },
  }

  const env = {
    TENANT_SLUG: 'self-hosted',
    OAUTH_PROVIDER: 'google',
    BOOTSTRAP_OWNER_TOKEN: 'b'.repeat(48),
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => { sessions.set(key, value) },
      delete: async (key: string) => { sessions.delete(key) },
    },
    DB: db,
    ...overrides,
  } as unknown as Env

  return { env, sessions, users, claim: () => claim }
}

function bootstrapRequest(token: string, email: string): Request {
  return new Request('https://pot.example/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, email }).toString(),
  })
}

describe('/auth/bootstrap', () => {
  it('is unavailable without a high-entropy bootstrap secret', async () => {
    const { env } = makeEnv({ BOOTSTRAP_OWNER_TOKEN: undefined })
    expect((await authApp.request('/bootstrap', {}, env)).status).toBe(404)
    expect((await authApp.fetch(bootstrapRequest('x'.repeat(48), 'owner@example.test'), env)).status).toBe(404)
  })

  it('mints the one owner session from a correct same-origin form submission', async () => {
    const { env, sessions, users, claim } = makeEnv()
    const form = await authApp.request('/bootstrap', {}, env)
    expect(form.status).toBe(200)
    expect(await form.text()).toContain('Bootstrap token')
    expect(form.headers.get('cache-control')).toBe('no-store')
    expect(form.headers.get('referrer-policy')).toBe('no-referrer')

    const res = await authApp.fetch(bootstrapRequest('b'.repeat(48), 'Owner@Example.test'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(res.headers.get('set-cookie')).toContain('Secure')
    expect(sessions.size).toBe(2) // session + presence marker
    expect([...users.values()]).toEqual([expect.objectContaining({ email: 'owner@example.test', role: 'owner' })])
    expect(claim()).toEqual({ userId: [...users.values()][0].id })
  })

  it('rejects an invalid token without writing a user, session, or claim', async () => {
    const { env, sessions, users, claim } = makeEnv()
    const res = await authApp.fetch(bootstrapRequest('wrong'.repeat(10), 'owner@example.test'), env)
    expect(res.status).toBe(401)
    expect(users.size).toBe(0)
    expect(sessions.size).toBe(0)
    expect(claim()).toBeNull()
  })

  it('is unavailable when either dashboard OAuth credential is configured', async () => {
    const token = 'b'.repeat(48)
    for (const overrides of [{ OAUTH_CLIENT_ID: 'client' }, { OAUTH_CLIENT_SECRET: 'secret' }]) {
      const { env } = makeEnv(overrides)
      expect((await authApp.fetch(bootstrapRequest(token, 'owner@example.test'), env)).status).toBe(404)
    }
  })

  it('promotes the secret holder once, resumes that owner, and rejects a second principal', async () => {
    const { env, users, claim } = makeEnv({}, [{ id: 'member-1', email: 'owner@example.test', role: 'member' }])
    expect((await authApp.fetch(bootstrapRequest('b'.repeat(48), 'owner@example.test'), env)).status).toBe(302)
    expect(users.get('member-1')?.role).toBe('owner')
    expect(claim()).toEqual({ userId: 'member-1' })
    expect((await authApp.fetch(bootstrapRequest('b'.repeat(48), 'owner@example.test'), env)).status).toBe(302)
    expect((await authApp.fetch(bootstrapRequest('b'.repeat(48), 'other@example.test'), env)).status).toBe(409)
    expect(users.size).toBe(1)
  })

  it('rejects malformed form input and never elevates an existing owner', async () => {
    const invalid = makeEnv()
    expect((await authApp.fetch(bootstrapRequest('b'.repeat(48), 'not-an-email'), invalid.env)).status).toBe(400)
    expect(invalid.users.size).toBe(0)

    const existing = makeEnv({}, [{ id: 'owner-1', email: 'owner@example.test', role: 'owner' }])
    expect((await authApp.fetch(bootstrapRequest('b'.repeat(48), 'owner@example.test'), existing.env)).status).toBe(409)
    expect(existing.claim()).toBeNull()
  })
})
