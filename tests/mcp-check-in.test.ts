import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-1'

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'member@example.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [],
    ...overrides,
  }
}

function makeEnv(opts: { debounced?: boolean; memberRow?: { display_name: string; email: string | null } | null } = {}) {
  const writes: unknown[][] = []
  const kv: { get: string[]; put: Array<{ key: string; value: string; opts: { expirationTtl: number } }> } = {
    get: [],
    put: [],
  }
  const memberRow = opts.memberRow === undefined
    ? { display_name: 'Kasra Code', email: 'code@example.com' }
    : opts.memberRow

  const env = {
    TENANT_SLUG: TENANT,
    SESSIONS: {
      async get(key: string) {
        kv.get.push(key)
        return opts.debounced ? '1' : null
      },
      async put(key: string, value: string, putOpts: { expirationTtl: number }) {
        kv.put.push({ key, value, opts: putOpts })
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM members WHERE id = ?1')) return memberRow
                return null
              },
              async run() {
                if (sql.includes('INSERT INTO presence')) writes.push(args)
                return { meta: { changes: 1 } }
              },
              async all() {
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, writes, kv }
}

describe('MCP check_in tool', () => {
  it('is advertised on the MCP surface', () => {
    expect(TOOLS.map((t) => t.name)).toContain('check_in')
  })

  it('records pot-native presence using authenticated member identity, not args', async () => {
    const { env, writes, kv } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'check_in',
      { source: 'codex', label: 'primary runtime' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect((res.result as { ok: boolean; agent: string; agent_id: string | null; debounced: boolean })).toMatchObject({
      ok: true,
      agent: 'Kasra Code',
      agent_id: AGENT_ID,
      debounced: false,
    })
    expect(kv.get).toEqual([`checkin:${TENANT}:${MEMBER_ID}`])
    expect(kv.put).toEqual([
      { key: `checkin:${TENANT}:${MEMBER_ID}`, value: '1', opts: { expirationTtl: 30 } },
    ])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual([
      TENANT,
      MEMBER_ID,
      'Kasra Code',
      'codex',
      'primary runtime',
      AGENT_ID,
    ])
  })

  it('debounces rapid repeats without touching the presence table', async () => {
    const { env, writes, kv } = makeEnv({ debounced: true })

    const res = await invokeTool(auth(), env, 'check_in', { source: 'hermes' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect((res.result as { debounced: boolean }).debounced).toBe(true)
    expect(kv.get).toEqual([`checkin:${TENANT}:${MEMBER_ID}`])
    expect(kv.put).toEqual([])
    expect(writes).toEqual([])
  })

  it('normalizes unknown source and caps label through the shared presence service', async () => {
    const { env, writes } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'check_in',
      { source: 'evil-runtime', label: 'x'.repeat(500) },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect(writes[0][3]).toBe('unknown')
    expect((writes[0][4] as string).length).toBe(120)
  })

  it('refuses a principal with no member id', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(
      auth({ memberId: undefined, capabilities: [] }),
      env,
      'check_in',
      {},
      'https://pot.example',
    )

    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_member_bound')
  })
})
