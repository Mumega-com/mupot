// Seat enrollment page + MCP enroll_url (choose-or-coin a per-seat key).
//
// Real schema via createSqliteD1 + applyAllMigrations — the #684/#711 ratchet
// rejects hand-written CREATE TABLE and SQL-string-matching env.DB mocks.
// Dashboard requests follow the fleet-scope harness: session cookie → SESSIONS
// KV → email→member bridge → resolveCapabilities. MCP requests follow the
// stateless-connect-persistence idiom: bearer token hashed into member_tokens.

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import { mcpApp } from '../src/mcp'
import {
  enrollUrl,
  ENROLL_MINT_RL_MAX,
  ENROLL_MINT_RL_TTL,
  ENROLL_MINT_RL_UNAVAILABLE_RETRY,
} from '../src/dashboard/enroll'
import { mintAgentBoundToken } from '../src/members/service'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_A = 'agent-river'
const AGENT_B = 'agent-ghost'
const HUMAN_ADMIN = 'member-admin'
const HUMAN_MEMBER = 'member-plain'
const UNBOUND_TOKEN = 'test-unbound-bearer'
const UNBOUND_HASH = createHash('sha256').update(UNBOUND_TOKEN).digest('hex')

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A}', 'dept-a', 'squad-a', 'River Squad'),
      ('${SQUAD_B}', 'dept-a', 'squad-b', 'Ghost Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_A}', '${SQUAD_A}', 'cursor-river', 'Cursor River', 'lead', 'test', 'active'),
      ('${AGENT_B}', '${SQUAD_B}', 'ghost-agent', 'Ghost Agent', 'member', 'test', 'active');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${HUMAN_ADMIN}', 'admin@pot.test', 'Squad Admin', 'active', '${TENANT}'),
      ('${HUMAN_MEMBER}', 'member@pot.test', 'Squad Member', 'active', '${TENANT}'),
      ('member-agent-a', NULL, 'Cursor River', 'active', '${TENANT}'),
      ('member-agent-b', NULL, 'Ghost Agent', 'active', '${TENANT}'),
      ('member-unbound', 'unbound@pot.test', 'Unbound Human', 'active', '${TENANT}');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-admin-a', '${HUMAN_ADMIN}', 'squad', '${SQUAD_A}', 'admin'),
      ('cap-plain-a', '${HUMAN_MEMBER}', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-a', 'member-agent-a', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-b', 'member-agent-b', 'squad', '${SQUAD_B}', 'member'),
      ('cap-unbound', 'member-unbound', 'squad', '${SQUAD_A}', 'member');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_A}', 'member-agent-a', datetime('now')),
      ('${TENANT}', '${AGENT_B}', 'member-agent-b', datetime('now'));

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-unbound', 'member-unbound', '${UNBOUND_HASH}', 'shared', 'workspace', datetime('now'), NULL, '${TENANT}');
  `)
  return harness
}

/**
 * A SESSIONS stand-in that actually STORES what is put into it.
 *
 * This is now the DEFAULT for `envFor`, not an opt-in. The earlier read-only
 * mock had no `put`, so every throttle check threw and took the fail-open
 * branch — which made a never-exercised limiter look identical to a working
 * one. Now that the limiter fails CLOSED, the same mock would turn every mint
 * in this file into a 429, which is a louder failure but still a fixture lie.
 * Model the binding honestly instead: a KV that can be written to.
 */
function statefulSessions(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
    },
  }
}

function envFor(
  harness: SqliteD1Harness,
  sessions: Record<string, string> = {},
  sessionsKv?: unknown,
): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: sessionsKv ?? statefulSessions(sessions).kv,
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) },
    BUS: { send: async () => {} },
    BLOBS: {},
    AI: {},
    AGENT: {},
    SQUAD: {},
  } as unknown as Env
}

function sessionRecord(email: string): string {
  return JSON.stringify({ userId: `u-${email}`, email, role: 'member', createdAt: '2026-01-01T00:00:00Z' })
}

function dashboardReq(path: string, sessionId: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Cookie', `mupot_session=${sessionId}`)
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

function dashboardPost(path: string, sessionId: string, values: Record<string, string>): Request {
  return dashboardReq(path, sessionId, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

async function callTool(
  env: Env,
  toolName: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return mcpApp.request(
    `${ORIGIN}/`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${UNBOUND_TOKEN}`,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `req-${toolName}`,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    },
    env,
  )
}

describe('enrollUrl', () => {
  it('builds /enroll and encodes the seat when declared', () => {
    expect(enrollUrl('https://mupot.example')).toBe('https://mupot.example/enroll')
    expect(enrollUrl('https://mupot.example/', 'cursor-river')).toBe(
      'https://mupot.example/enroll?seat=cursor-river',
    )
    expect(enrollUrl('https://mupot.example', 'a b')).toBe(
      'https://mupot.example/enroll?seat=a%20b',
    )
  })
})

describe('GET /enroll — seat enrollment page (real schema)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('renders for a signed-in human, echoes the seat, and lists agents they may act as', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=cursor-river', 's-admin'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('cursor-river')
    expect(body).toContain('admin@pot.test')
    expect(body).toContain('Cursor River')
    expect(body).toContain('cursor-river')
    expect(body).toContain('name="seat"')
    expect(body).toContain('name="agent_id"')
    expect(body).toContain(AGENT_A)
  })

  it('omits an agent the human may not act as', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=cursor-river', 's-admin'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Cursor River')
    expect(body).not.toContain('Ghost Agent')
    expect(body).not.toContain(AGENT_B)
    expect(body).not.toContain('ghost-agent')
  })

  it('never renders a token_hash', async () => {
    harness = makeHarness()
    harness.sqlite
      .prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
         VALUES ('tok-existing', 'member-agent-a', ?, 'cursor-river', 'workspace', datetime('now'), ?, ?)`,
      )
      .run('deadbeef'.repeat(8), AGENT_A, TENANT)
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=cursor-river', 's-admin'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('token_hash')
    expect(body).not.toContain('deadbeef')
    expect(body).toContain('cursor-river')
    expect(body).toContain('workspace')
  })
})

describe('POST /enroll/mint — coin a seat key (real schema)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('as a squad admin creates a welded token labelled with the seat, shown once, with x-mupot-seat', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?`)
      .get(AGENT_A) as { n: number }

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'cursor-river' }),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.text()

    const tokens = harness.sqlite
      .prepare(`SELECT id, agent_id, label, channel FROM member_tokens WHERE agent_id = ?`)
      .all(AGENT_A) as Array<{ id: string; agent_id: string; label: string; channel: string }>
    expect(tokens.length).toBe(before.n + 1)
    const minted = tokens[tokens.length - 1]
    expect(minted.agent_id).toBe(AGENT_A)
    expect(minted.label).toBe('cursor-river')
    expect(minted.channel).toBe('workspace')

    const rawMatches = body.match(/mupot_[0-9a-f]{64}/g) ?? []
    expect(rawMatches).toHaveLength(1)
    expect(body).toContain('x-mupot-seat')
    expect(body).toContain('cursor-river')
    expect(body).not.toContain('token_hash')
    expect(body).not.toContain(sha256(rawMatches[0]))
  })

  it('WITHOUT admin on the target agent squad is refused and writes no member_tokens row', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-plain': sessionRecord('member@pot.test') })
    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-plain', { agent_id: AGENT_A, seat: 'stolen-seat' }),
      env,
    )
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toMatch(/Not allowed|requires owner or admin|forbidden/i)
    expect(body).toContain('/') // refusal offers a real link
    expect(body).not.toMatch(/mupot_[0-9a-f]{64}/)

    const after = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }
    expect(after.n).toBe(before.n)
    const stolen = harness.sqlite
      .prepare(`SELECT id FROM member_tokens WHERE label = ?`)
      .get('stolen-seat')
    expect(stolen).toBeUndefined()
  })

  it('two seats for the same human+agent mint two coexisting live tokens with distinct labels', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })

    const first = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'cursor-river' }),
      env,
    )
    expect(first.status).toBe(200)
    const second = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'cursor-cloud' }),
      env,
    )
    expect(second.status).toBe(200)

    const rows = harness.sqlite
      .prepare(
        `SELECT label FROM member_tokens
          WHERE agent_id = ? AND revoked_at IS NULL
          ORDER BY label ASC`,
      )
      .all(AGENT_A) as Array<{ label: string }>
    const labels = rows.map((r) => r.label)
    expect(labels).toContain('cursor-river')
    expect(labels).toContain('cursor-cloud')
    expect(labels.filter((l) => l === 'cursor-river' || l === 'cursor-cloud')).toHaveLength(2)
  })
})

describe('POST /enroll/mint — issuance audit (0139)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('records WHO coined the key, on which surface and seat, in the same batch as the token', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'cursor-river' }),
      env,
    )
    expect(res.status).toBe(200)

    const rows = harness.sqlite
      .prepare(`SELECT * FROM agent_token_issuance_audit`)
      .all() as Array<Record<string, string>>
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.actor_member_id).toBe(HUMAN_ADMIN)
    expect(row.actor_principal).toBe('admin@pot.test')
    expect(row.surface).toBe('enroll')
    expect(row.seat_label).toBe('cursor-river')
    expect(row.agent_id).toBe(AGENT_A)
    expect(row.tenant).toBe(TENANT)

    // The audit must point at the token that actually landed.
    const minted = harness.sqlite
      .prepare(`SELECT id, member_id FROM member_tokens WHERE agent_id = ? AND label = ?`)
      .get(AGENT_A, 'cursor-river') as { id: string; member_id: string }
    expect(row.token_id).toBe(minted.id)
    expect(row.member_id).toBe(minted.member_id)
  })

  it('never copies the token hash or raw secret into the trail', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'cursor-river' }),
      env,
    )
    const raw = ((await res.text()).match(/mupot_[0-9a-f]{64}/) ?? [])[0]
    expect(raw).toBeDefined()

    const serialised = JSON.stringify(
      harness.sqlite.prepare(`SELECT * FROM agent_token_issuance_audit`).all(),
    )
    expect(serialised).not.toContain(raw)
    expect(serialised).not.toContain(sha256(raw as string))
  })

  it('writes NO audit row when the mint is refused', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-plain': sessionRecord('member@pot.test') })
    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-plain', { agent_id: AGENT_A, seat: 'stolen-seat' }),
      env,
    )
    expect(res.status).toBe(403)
    const rows = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_token_issuance_audit`)
      .get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('leaves the trail empty for mint paths that do not declare an issuer', async () => {
    // mintAgentBoundToken without issuedBy is the pre-0139 behaviour verbatim:
    // a token, no audit row. Proves the option is opt-in and cannot half-fire.
    harness = makeHarness()
    const env = envFor(harness)
    const agent = { id: AGENT_A, slug: 'cursor-river', name: 'Cursor River', squad_id: SQUAD_A }
    await mintAgentBoundToken(env, agent as never, 'no-issuer-seat')

    const minted = harness.sqlite
      .prepare(`SELECT id FROM member_tokens WHERE label = ?`)
      .get('no-issuer-seat')
    expect(minted).toBeDefined()
    const rows = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_token_issuance_audit`)
      .get() as { n: number }
    expect(rows.n).toBe(0)
  })
})

describe('POST /enroll/mint — per-member throttle', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('refuses with 429 + Retry-After once the hourly ceiling is reached, and mints nothing further', async () => {
    harness = makeHarness()
    const sessions = statefulSessions({ 'sess:s-admin': sessionRecord('admin@pot.test') })
    const env = envFor(harness, {}, sessions.kv)

    for (let i = 0; i < ENROLL_MINT_RL_MAX; i++) {
      const ok = await dashboardApp.fetch(
        dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: `seat-${i}` }),
        env,
      )
      expect(ok.status).toBe(200)
    }

    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }

    const blocked = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'one-too-many' }),
      env,
    )
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe(String(ENROLL_MINT_RL_TTL))
    const body = await blocked.text()
    expect(body).not.toMatch(/mupot_[0-9a-f]{64}/)

    const after = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(
      harness.sqlite.prepare(`SELECT id FROM member_tokens WHERE label = ?`).get('one-too-many'),
    ).toBeUndefined()
  })

  it('is keyed on the member — exhausting one human does not throttle another', async () => {
    harness = makeHarness()
    harness.sqlite.exec(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-admin-2', '${HUMAN_MEMBER}', 'squad', '${SQUAD_B}', 'admin');`,
    )
    const sessions = statefulSessions({
      'sess:s-admin': sessionRecord('admin@pot.test'),
      'sess:s-plain': sessionRecord('member@pot.test'),
    })
    const env = envFor(harness, {}, sessions.kv)

    for (let i = 0; i < ENROLL_MINT_RL_MAX; i++) {
      await dashboardApp.fetch(
        dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: `seat-${i}` }),
        env,
      )
    }
    const exhausted = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'blocked' }),
      env,
    )
    expect(exhausted.status).toBe(429)

    const other = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-plain', { agent_id: AGENT_B, seat: 'other-human' }),
      env,
    )
    // 200, not merely "not 429": a 403 here would also dodge the throttle
    // assertion while proving nothing about the second human being able to mint.
    expect(other.status).toBe(200)
  })

  it('burns budget on a REFUSED attempt — the abuse shape must not be free', async () => {
    harness = makeHarness()
    const sessions = statefulSessions({ 'sess:s-plain': sessionRecord('member@pot.test') })
    const env = envFor(harness, {}, sessions.kv)

    const denied = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-plain', { agent_id: AGENT_A, seat: 'nope' }),
      env,
    )
    expect(denied.status).toBe(403)
    expect(sessions.store.get(`enroll-mint-rl:${HUMAN_MEMBER}`)).toBe('1')
  })

  // Fail-CLOSED, and the assertion that matters is the token count, not the
  // status: a 429 with a minted token would still be the hole.
  it('fails CLOSED when the KV binding is unavailable, and mints nothing', async () => {
    harness = makeHarness()
    const env = envFor(harness, {}, {
      get: async (key: string) =>
        key === 'sess:s-admin' ? sessionRecord('admin@pot.test') : null,
      put: async () => { throw new Error('KV down') },
    })

    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'kv-down' }),
      env,
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe(String(ENROLL_MINT_RL_UNAVAILABLE_RETRY))

    const after = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens`)
      .get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(
      harness.sqlite.prepare(`SELECT id FROM member_tokens WHERE label = ?`).get('kv-down'),
    ).toBeUndefined()

    const body = await res.text()
    expect(body).not.toMatch(/mupot_[0-9a-f]{64}/)
    // Outage copy, not ceiling copy: an operator must be able to tell a broken
    // session store from a busy hour without reading logs.
    expect(body).toMatch(/could not be checked/i)
  })

  // A read failure and a write failure are different code paths into the same
  // catch; pin both so a future refactor cannot restore fail-open on one of them.
  it('fails CLOSED when the counter cannot be READ either', async () => {
    harness = makeHarness()
    const env = envFor(harness, {}, {
      get: async (key: string) => {
        if (key === 'sess:s-admin') return sessionRecord('admin@pot.test')
        throw new Error('KV down')
      },
      put: async () => undefined,
    })
    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-admin', { agent_id: AGENT_A, seat: 'kv-read-down' }),
      env,
    )
    expect(res.status).toBe(429)
    expect(
      harness.sqlite.prepare(`SELECT id FROM member_tokens WHERE label = ?`).get('kv-read-down'),
    ).toBeUndefined()
  })
})

describe('MCP unbound session surfaces enroll_url', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('boot_context on an unbound session returns enroll_url containing /enroll and the declared seat', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const res = await callTool(env, 'boot_context', { seat: 'cursor-river' }, {
      'x-mupot-seat': 'cursor-river',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { identity_status: string; enroll_url?: string; next_step: string } }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('unminted')
    expect(sc.enroll_url).toBeDefined()
    expect(sc.enroll_url).toContain('/enroll')
    expect(sc.enroll_url).toContain('cursor-river')
    expect(sc.next_step).toContain('/enroll')
  })

  it('inbox with no agent binding returns not_agent_bound AND an enroll_url', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const res = await callTool(env, 'inbox', {}, { 'x-mupot-seat': 'cursor-river' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      error: { message: string; data?: { detail?: string; enroll_url?: string } }
    }
    expect(body.error.message).toBe('not_agent_bound')
    expect(body.error.data?.enroll_url).toBeDefined()
    expect(body.error.data?.enroll_url).toContain('/enroll')
    expect(body.error.data?.detail).toContain('inbox requires an agent-bound token')
  })
})
