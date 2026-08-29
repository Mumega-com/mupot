// Tests for the agent-bound token mint path.
//
// Coverage:
//   1. loadAgentTokenView — DB query shape
//   2. mintAgentBoundToken (shared service helper) — happy path + security invariants
//   3. Route: GET /admin/agent-token — org-admin gated (redirect no-auth, 403 non-admin)
//   4. Route: POST /admin/agent-token/mint — org-admin gated
//   5. Mint binds agent_id (the weld): member_tokens.agent_id = agent.id
//   6. Escalation guard: capability is squad-scoped observer/member on the agent's own squad
//   7. Unknown agent → 404 (no token minted)
//   8. Raw returned once in response; token hash ≠ raw; raw absent from members/caps rows
//   9. Existing provision-tools tests stay green (separate file)
//  10. tsc strict — validated by build step

import { describe, it, expect, vi } from 'vitest'
import { mintAgentBoundToken, sha256Hex } from '../src/members/service'
import { loadAgentTokenView } from '../src/dashboard/agent-token'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// ── test fixtures ─────────────────────────────────────────────────────────────

const AGENT = {
  id: 'agent-abc',
  squad_id: 'squad-xyz',
  slug: 'growth-lead',
  name: 'Growth Lead',
}

interface Captured { sql: string; args: unknown[] }

// ── 1 & 2. Unit tests (no Hono) — mintAgentBoundToken + loadAgentTokenView ───
//
// The D1 mock must support:
//   - prepare(sql).all()    — no bind, used by loadAgentTokenView
//   - prepare(sql).bind().first/all/run()  — standard path
//   - DB.batch([stmt, ...]) — stmts carry .sql + .args so batch can capture them

function makeUnitEnv(opts: { captured?: Captured[]; agentExists?: boolean } = {}): Env {
  const captured = opts.captured ?? []
  const agentExists = opts.agentExists ?? true
  const agentWithSquad = { ...AGENT, squad_name: 'Growth Squad' }
  const agentRow = { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }

  const prepare = (sql: string) => {
    // Returns a stmt-like object.
    // .all() without bind — used by loadAgentTokenView (no params in that query).
    // .bind(...args) — returns a new stmt-like with the args captured.
    const makeStmt = (boundArgs: unknown[]) => ({
      sql,
      args: boundArgs,
      async first(): Promise<unknown> {
        if (sql.includes('FROM agent_member_bindings')) return null
        if (sql.includes('FROM agents') && sql.includes('WHERE id')) {
          return agentExists && boundArgs[0] === AGENT.id ? agentRow : null
        }
        if (sql.includes('FROM squads') && sql.includes('WHERE id')) {
          return { name: 'Growth Squad' }
        }
        return null
      },
      async all(): Promise<{ results: unknown[] }> {
        if (sql.includes('FROM agents')) {
          return { results: agentExists ? [agentWithSquad] : [] }
        }
        return { results: [] }
      },
      async run(): Promise<{ meta: { changes: number } }> {
        if (sql.includes('INSERT INTO')) captured.push({ sql, args: boundArgs })
        return { meta: { changes: 1 } }
      },
      bind(...args: unknown[]) { return makeStmt(args) },
    })

    const unbound = makeStmt([])
    return {
      ...unbound,
      // support .prepare(sql).all() directly (no bind)
      all: unbound.all.bind(unbound),
    }
  }

  return {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    DB: {
      prepare,
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) {
          if (s.sql && s.sql.includes('INSERT INTO')) captured.push({ sql: s.sql, args: s.args })
        }
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
    },
  } as unknown as Env
}

describe('loadAgentTokenView', () => {
  it('returns agents from the pot DB', async () => {
    const env = makeUnitEnv()
    const view = await loadAgentTokenView(env)
    expect(Array.isArray(view.agents)).toBe(true)
    expect(view.agents.length).toBe(1)
    expect(view.agents[0].slug).toBe(AGENT.slug)
  })

  it('returns empty array when no agents exist', async () => {
    const env = makeUnitEnv({ agentExists: false })
    const view = await loadAgentTokenView(env)
    expect(view.agents).toEqual([])
  })
})

describe('mintAgentBoundToken', () => {
  it('returns a mupot_-prefixed raw token', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    const result = await mintAgentBoundToken(env, AGENT, 'test-label')
    expect(result.raw).toMatch(/^mupot_[0-9a-f]{64}$/)
    expect(typeof result.tokenId).toBe('string')
    expect(typeof result.memberId).toBe('string')
  })

  it('batches exactly 5 INSERT rows (member + binding + capability + token + D2 lane grant)', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    await mintAgentBoundToken(env, AGENT, 'batch-test')
    expect(captured).toHaveLength(5)
    expect(captured.some((c) => c.sql.includes('INSERT INTO members'))).toBe(true)
    expect(captured.some((c) => c.sql.includes('INSERT INTO agent_member_bindings'))).toBe(true)
    expect(captured.some((c) => c.sql.includes('INSERT INTO capabilities'))).toBe(true)
    expect(captured.some((c) => c.sql.includes('INSERT INTO member_tokens'))).toBe(true)
    expect(captured.some((c) => c.sql.includes('INSERT INTO gate_grants'))).toBe(true)
  })

  it('THE WELD: member_tokens binds agent.id and tenant', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    await mintAgentBoundToken(env, AGENT, 'weld-test')
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert).toBeDefined()
    expect(tokenInsert!.args).toContain(AGENT.id)
    expect(tokenInsert!.args).toContain('test')
  })

  it("THE ESCALATION GUARD: default capability is scope_type='squad' capability='member' on agent's squad", async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    await mintAgentBoundToken(env, AGENT, 'guard-test')
    const capInsert = captured.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.sql).toContain("'squad'")
    expect(capInsert!.args).toContain(AGENT.squad_id)
    expect(capInsert!.args).toContain('member')
    expect(capInsert!.sql).not.toContain("'org'")
    expect(capInsert!.sql).not.toContain("'department'")
  })

  it("can lower the agent grant to observer without widening scope", async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    const result = await mintAgentBoundToken(env, AGENT, 'observer-test', 'observer')
    expect(result.grantCapability).toBe('observer')
    const capInsert = captured.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.sql).toContain("'squad'")
    expect(capInsert!.args).toContain(AGENT.squad_id)
    expect(capInsert!.args).toContain('observer')
  })

  it('label truncates to 64 chars', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    await mintAgentBoundToken(env, AGENT, 'a'.repeat(100))
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    const label = tokenInsert!.args[3] as string
    expect(label.length).toBeLessThanOrEqual(64)
  })

  it('empty label defaults to agent slug', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    await mintAgentBoundToken(env, AGENT, '')
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert!.args[3]).toBe(AGENT.slug)
  })

  it('token hash stored ≠ raw token (only hash persisted)', async () => {
    const captured: Captured[] = []
    const env = makeUnitEnv({ captured })
    const result = await mintAgentBoundToken(env, AGENT, 'hash-test')
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    const hash = tokenInsert!.args[2] as string
    expect(hash).not.toBe(result.raw)
    // hash is a 64-char hex string (SHA-256)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // raw must NOT appear in members or capability args
    const membersInsert = captured.find((c) => c.sql.includes('INSERT INTO members'))
    if (membersInsert) expect(membersInsert.args).not.toContain(result.raw)
    const capInsert = captured.find((c) => c.sql.includes('INSERT INTO capabilities'))
    if (capInsert) expect(capInsert.args).not.toContain(result.raw)
  })

  it('discards a losing raw token and retries once on the concurrent canonical binding', async () => {
    const batches: Captured[][] = []
    let bindingRead = 0
    const winnerMemberId = 'member-race-winner'
    const prepare = (sql: string) => {
      const makeStmt = (args: unknown[]) => ({
        sql,
        args,
        bind(...values: unknown[]) { return makeStmt(values) },
        async first(): Promise<unknown> {
          if (sql.includes('FROM agent_member_bindings')) {
            bindingRead += 1
            return bindingRead === 1 ? null : { member_id: winnerMemberId }
          }
          if (sql.includes('SELECT capability FROM capabilities')) {
            return { capability: 'observer' }
          }
          return null
        },
        async all(): Promise<{ results: unknown[] }> {
          return { results: [] }
        },
        async run(): Promise<{ meta: { changes: number } }> {
          return { meta: { changes: 1 } }
        },
      })
      return makeStmt([])
    }
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare,
        async batch(statements: Captured[]) {
          batches.push(statements)
          if (batches.length === 1) throw new Error('agent_identity_conflict')
          return statements.map(() => ({ meta: { changes: 1 } }))
        },
      },
    } as unknown as Env

    const result = await mintAgentBoundToken(env, AGENT, 'race-label', 'member')

    expect(batches).toHaveLength(2)
    // BLOCK-4 re-baseline (kasra-review 2026-08-13): the D2 lane grant
    // (gate:<slug>) is part of the atomic mint batch, so the first mint is
    // 5 rows (member + binding + capability + token + gate_grants) and the
    // winning re-mint is 2 rows (token + gate_grants). Batch COUNT stays 2 —
    // the losing commit + the winning retry — no third batch.
    expect(batches[0]).toHaveLength(5)
    expect(batches[1]).toHaveLength(2)
    const losingToken = batches[0].find(({ sql }) => sql.includes('INSERT INTO member_tokens'))
    const winningToken = batches[1].find(({ sql }) => sql.includes('INSERT INTO member_tokens'))
    expect(losingToken).toBeDefined()
    expect(winningToken).toBeDefined()
    expect(result.memberId).toBe(winnerMemberId)
    expect(result.grantCapability).toBe('observer')
    expect(winningToken?.args[1]).toBe(winnerMemberId)
    expect(winningToken?.args[2]).toBe(await sha256Hex(result.raw))
    expect(losingToken?.args[2]).not.toBe(winningToken?.args[2])
  })
})

function createMigratedMintEnv(): {
  env: Env
  sqlite: ReturnType<typeof createSqliteD1>['sqlite']
  close(): void
} {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-mint', 'mint', 'Mint');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${AGENT.squad_id}', 'dept-mint', 'growth', 'Growth');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT.id}', '${AGENT.squad_id}', '${AGENT.slug}', '${AGENT.name}', 'member', 'test', 'active');
  `)
  return {
    env: { TENANT_SLUG: 'test', DB: harness.db } as Env,
    sqlite: harness.sqlite,
    close: harness.close,
  }
}

describe('mintAgentBoundToken — canonical SQLite identity', () => {
  it('does not persist a replacement when its requested prior token is not live for the agent', async () => {
    const harness = createMigratedMintEnv()
    try {
      const first = await mintAgentBoundToken(harness.env, AGENT, 'first')

      expect(harness.sqlite.prepare(
        'SELECT expires_at FROM member_tokens WHERE id = ?',
      ).get(first.tokenId)).toEqual({ expires_at: expect.any(String) })

      await expect(
        mintAgentBoundToken(harness.env, AGENT, 'replacement', {
          revokePriorTokenId: 'missing-prior-token',
        }),
      ).rejects.toThrow('replacement_token_unavailable')

      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM member_tokens WHERE tenant = ? AND agent_id = ?',
      ).get('test', AGENT.id)).toEqual({ count: 1 })
      expect(harness.sqlite.prepare(
        'SELECT revoked_at FROM member_tokens WHERE id = ?',
      ).get(first.tokenId)).toEqual({ revoked_at: null })
    } finally {
      harness.close()
    }
  })

  it('rejects foreign and already-revoked replacement priors without minting another token', async () => {
    const harness = createMigratedMintEnv()
    try {
      const first = await mintAgentBoundToken(harness.env, AGENT, 'first')
      const foreignAgent = { ...AGENT, id: 'agent-foreign', slug: 'foreign-agent', name: 'Foreign Agent' }
      harness.sqlite.prepare(
        `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
         VALUES (?, ?, ?, ?, 'member', 'test', 'active')`,
      ).run(foreignAgent.id, foreignAgent.squad_id, foreignAgent.slug, foreignAgent.name)
      const foreign = await mintAgentBoundToken(harness.env, foreignAgent, 'foreign')

      await expect(mintAgentBoundToken(harness.env, AGENT, 'foreign-replacement', {
        revokePriorTokenId: foreign.tokenId,
      })).rejects.toThrow('replacement_token_unavailable')

      harness.sqlite.prepare('UPDATE member_tokens SET revoked_at = ? WHERE id = ?')
        .run('2026-08-29T00:00:00.000Z', first.tokenId)
      await expect(mintAgentBoundToken(harness.env, AGENT, 'revoked-replacement', {
        revokePriorTokenId: first.tokenId,
      })).rejects.toThrow('replacement_token_unavailable')

      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM member_tokens WHERE tenant = ? AND agent_id = ?',
      ).get('test', AGENT.id)).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })

  it('allows exactly one concurrent replacement of the same prior token', async () => {
    const harness = createMigratedMintEnv()
    try {
      const prior = await mintAgentBoundToken(harness.env, AGENT, 'prior')
      const replacements = await Promise.allSettled([
        mintAgentBoundToken(harness.env, AGENT, 'replacement-a', { revokePriorTokenId: prior.tokenId }),
        mintAgentBoundToken(harness.env, AGENT, 'replacement-b', { revokePriorTokenId: prior.tokenId }),
      ])

      expect(replacements.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(replacements.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM member_tokens WHERE tenant = ? AND agent_id = ?',
      ).get('test', AGENT.id)).toEqual({ count: 2 })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM member_tokens WHERE tenant = ? AND agent_id = ? AND revoked_at IS NULL',
      ).get('test', AGENT.id)).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })

  it('keeps one member and its committed home grant after every token is revoked', async () => {
    const harness = createMigratedMintEnv()
    try {
      const first = await mintAgentBoundToken(harness.env, AGENT, 'first', 'observer')
      harness.sqlite.prepare(
        'UPDATE member_tokens SET revoked_at = ? WHERE tenant = ? AND agent_id = ?',
      ).run('2026-07-24T12:00:00.000Z', 'test', AGENT.id)

      const second = await mintAgentBoundToken(harness.env, AGENT, 'second', 'member')
      expect(second.memberId).toBe(first.memberId)
      expect(second.grantCapability).toBe('observer')
      expect(harness.sqlite.prepare(
        'SELECT COUNT(DISTINCT member_id) AS count FROM member_tokens WHERE tenant = ? AND agent_id = ?',
      ).get('test', AGENT.id)).toEqual({ count: 1 })
      expect(harness.sqlite.prepare(
        'SELECT member_id FROM agent_member_bindings WHERE tenant = ? AND agent_id = ?',
      ).get('test', AGENT.id)).toEqual({ member_id: first.memberId })
      expect(harness.sqlite.prepare(
        `SELECT capability FROM capabilities
          WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
      ).get(first.memberId, AGENT.squad_id)).toEqual({ capability: 'observer' })
    } finally {
      harness.close()
    }
  })

  it('allows multiple live credentials without creating multiple identities', async () => {
    const harness = createMigratedMintEnv()
    try {
      const first = await mintAgentBoundToken(harness.env, AGENT, 'first')
      const second = await mintAgentBoundToken(harness.env, AGENT, 'second')
      expect(second.memberId).toBe(first.memberId)
      expect(harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM member_tokens WHERE revoked_at IS NULL AND agent_id = ?',
      ).get(AGENT.id)).toEqual({ count: 2 })
      expect(harness.sqlite.prepare(
        'SELECT COUNT(DISTINCT member_id) AS count FROM member_tokens WHERE agent_id = ?',
      ).get(AGENT.id)).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })
})

// ── 3 & 4. Route integration tests ────────────────────────────────────────────
//
// The dashboard auth reads mupot_session cookie → SESSIONS.get(token) → JSON.
// We mock SESSIONS to return a session with the desired role (no real KV needed).
// Pattern follows tests/github-admin-routes.test.ts.
//
// The DB mock here must support ALL the SQL patterns hit during a request:
//   - prepare(sql).all()           — loadAgentTokenView (no bind)
//   - prepare(sql).bind(id).first()— resolveAgentRef (id lookup)
//   - prepare(sql).bind(id).all()  — resolveAgentRef (slug fallback)
//   - prepare(sql).bind(id).first()— squad name lookup
//   - DB.batch([...])              — mintAgentBoundToken atomic write

function makeRouteEnv(role: 'owner' | 'admin' | 'member', opts: {
  agentExists?: boolean
  captured?: Captured[]
} = {}): Env {
  const captured = opts.captured ?? []
  const agentExists = opts.agentExists ?? true

  const agentRow = { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }
  const agentWithSquad = { ...agentRow, squad_name: 'Growth Squad' }

  const prepare = (sql: string) => {
    const makeStmt = (boundArgs: unknown[]) => ({
      sql,
      args: boundArgs,
      bind(...args: unknown[]) { return makeStmt(args) },
      async first(): Promise<unknown> {
        const ref = boundArgs[0]
        if (sql.includes('FROM agent_member_bindings')) return null
        if (sql.includes('FROM agents') && sql.includes('WHERE id')) {
          return agentExists && ref === AGENT.id ? agentRow : null
        }
        if (sql.includes('FROM squads') && sql.includes('WHERE id')) {
          return { name: 'Growth Squad' }
        }
        return null
      },
      async all(): Promise<{ results: unknown[] }> {
        // loadAgentTokenView — agents JOIN squads (no bind, or bind with no meaningful args)
        if (sql.includes('FROM agents')) {
          return { results: agentExists ? [agentWithSquad] : [] }
        }
        // resolveAgentRef slug fallback
        if (sql.includes('WHERE slug')) {
          const ref = boundArgs[0]
          if (ref === AGENT.slug && agentExists) return { results: [agentRow] }
          return { results: [] }
        }
        return { results: [] }
      },
      async run(): Promise<{ meta: { changes: number } }> {
        return { meta: { changes: 1 } }
      },
    })

    return makeStmt([])
  }

  return {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
    PUBLIC_ORIGIN: 'https://test.mupot.app',
    DB: {
      prepare,
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) {
          if (s.sql && s.sql.includes('INSERT INTO')) captured.push({ sql: s.sql, args: s.args })
        }
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
    },
    SESSIONS: {
      get: vi.fn(async () =>
        JSON.stringify({
          userId: 'u1',
          email: 'operator@test.com',
          role,
          createdAt: '2026-06-01T00:00:00Z',
        }),
      ),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

function makeReq(path: string, method: 'GET' | 'POST', body?: URLSearchParams): Request {
  return new Request(`https://test.mupot.app${path}`, {
    method,
    headers: {
      'Content-Type': body ? 'application/x-www-form-urlencoded' : 'text/html',
      Cookie: 'mupot_session=sess-test',
      Origin: 'https://test.mupot.app',
    },
    body: body?.toString(),
  })
}

describe('GET /admin/agent-token', () => {
  it('redirects to /auth/login when no session (SESSIONS returns null)', async () => {
    const env = makeRouteEnv('admin')
    ;(env as unknown as { SESSIONS: { get: ReturnType<typeof vi.fn> } }).SESSIONS.get = vi.fn(async () => null)
    const req = new Request('https://test.mupot.app/admin/agent-token', {
      headers: { Cookie: '', Origin: 'https://test.mupot.app' },
    })
    const res = await dashboardApp.fetch(req, env)
    // Unauthenticated → redirect to login
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
  })

  it('403s a non-admin (member role)', async () => {
    const env = makeRouteEnv('member')
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token', 'GET'), env)
    expect(res.status).toBe(403)
  })

  it('200s an org-admin with the agent picker form', async () => {
    const env = makeRouteEnv('admin')
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token', 'GET'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Mint agent token')
    expect(body).toContain('agent_id')
    expect(body).toContain('name="capability"')
  })

  it('200s an owner role as well', async () => {
    const env = makeRouteEnv('owner')
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token', 'GET'), env)
    expect(res.status).toBe(200)
  })
})

describe('POST /admin/agent-token/mint', () => {
  it('redirects when no session', async () => {
    const env = makeRouteEnv('admin')
    ;(env as unknown as { SESSIONS: { get: ReturnType<typeof vi.fn> } }).SESSIONS.get = vi.fn(async () => null)
    const req = new Request('https://test.mupot.app/admin/agent-token/mint', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: '',
        Origin: 'https://test.mupot.app',
      },
      body: new URLSearchParams({ agent_id: AGENT.id, label: '' }).toString(),
    })
    const res = await dashboardApp.fetch(req, env)
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
  })

  it('403s a member (non-admin)', async () => {
    const env = makeRouteEnv('member')
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'test' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(403)
  })

  it('400 when agent_id is blank', async () => {
    const env = makeRouteEnv('admin')
    const form = new URLSearchParams({ agent_id: '', label: '' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Pick an agent')
  })

  it('404 when agent does not exist in this pot', async () => {
    const env = makeRouteEnv('admin', { agentExists: false })
    const form = new URLSearchParams({ agent_id: 'ghost-id', label: '' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toContain('Agent not found')
  })

  it('200 + show-once page on a valid mint', async () => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'main-host' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Shown once only')
    expect(text).toContain('mupot_')
    // THE WELD: agent_id is bound on the member_tokens INSERT.
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    expect(tokenInsert).toBeDefined()
    expect(tokenInsert!.args).toContain(AGENT.id)
    expect(tokenInsert!.args).toContain('test')
  })

  it('mints an observer agent token from the dashboard form', async () => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'review-host', capability: 'observer' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Squad grant:')
    expect(text).toContain('observer')
    const capInsert = captured.find((c) => c.sql.includes('INSERT INTO capabilities'))
    expect(capInsert).toBeDefined()
    expect(capInsert!.args).toContain('observer')
  })

  it('400s an invalid agent grant before minting rows', async () => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'bad-host', capability: 'lead' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Grant must be observer or member')
    expect(captured.length).toBe(0)
  })

  it.each(['0', '-1', 'not-a-number'])('400s invalid dashboard expiry %s before minting rows', async (expiresInDays) => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'expiry-test', expires_in_days: expiresInDays })

    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Expiry must be a whole number from 1 to 365 days')
    expect(captured).toHaveLength(0)
  })

  it('503s before minting when PUBLIC_ORIGIN is not a secure canonical origin', async () => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    env.PUBLIC_ORIGIN = 'http://evil.example'
    const form = new URLSearchParams({ agent_id: AGENT.id, label: 'origin-gap' })

    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)

    expect(res.status).toBe(503)
    expect(await res.text()).toContain('secure public origin')
    expect(captured).toHaveLength(0)
  })

  it('Cache-Control: no-store on the mint result page', async () => {
    const env = makeRouteEnv('admin')
    const form = new URLSearchParams({ agent_id: AGENT.id, label: '' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('raw token on show-once page is not stored in any INSERT args', async () => {
    const captured: Captured[] = []
    const env = makeRouteEnv('admin', { captured })
    const form = new URLSearchParams({ agent_id: AGENT.id, label: '' })
    const res = await dashboardApp.fetch(makeReq('/admin/agent-token/mint', 'POST', form), env)
    expect(res.status).toBe(200)
    const text = await res.text()
    const match = text.match(/mupot_[0-9a-f]{64}/)
    expect(match).not.toBeNull()
    const raw = match![0]
    // The raw token must NOT appear in any INSERT args (hash only in DB)
    for (const c of captured) {
      expect(c.args).not.toContain(raw)
    }
    // token_hash in member_tokens INSERT must be sha256 hex (not the raw)
    const tokenInsert = captured.find((c) => c.sql.includes('INSERT INTO member_tokens'))
    if (tokenInsert) {
      const hash = tokenInsert.args[2]
      expect(hash).not.toBe(raw)
      expect(typeof hash).toBe('string')
      expect((hash as string).length).toBe(64)
    }
  })
})
