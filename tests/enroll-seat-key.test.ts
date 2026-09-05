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
  authorizeEnrollMint,
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

function sessionRecord(email: string, role: 'owner' | 'admin' | 'member' = 'member'): string {
  return JSON.stringify({ userId: `u-${email}`, email, role, createdAt: '2026-01-01T00:00:00Z' })
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

  it('renders consentable agents for a signed-in owner whose member row holds eligibility', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-owner': sessionRecord('admin@pot.test', 'owner') })
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=hadi-assistant', 's-owner'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('admin@pot.test')
    expect(body).toContain(`member <code class="inline">${HUMAN_ADMIN}</code>`)
    expect(body).toContain('hadi-assistant')
    expect(body).toContain('Cursor River')
    expect(body).toContain(AGENT_A)
  })

  it('redirects unauthenticated enrollment visitors to login', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const res = await dashboardApp.fetch(new Request(`${ORIGIN}/enroll?seat=hadi-assistant`), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('does not resolve an owner email to an agent through another tenant', async () => {
    harness = makeHarness()
    const env = { ...envFor(harness, { 'sess:s-owner': sessionRecord('admin@pot.test', 'owner') }), TENANT_SLUG: 'other-pot' } as Env
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=hadi-assistant', 's-owner'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('admin@pot.test')
    expect(body).not.toContain(`member <code class="inline">${HUMAN_ADMIN}</code>`)
    expect(body).not.toContain('Cursor River')
    expect(body).not.toContain(AGENT_A)
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

  it('as a signed-in owner with a matching member row can coin a seat key through enrol', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-owner': sessionRecord('admin@pot.test', 'owner') })
    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?`)
      .get(AGENT_A) as { n: number }

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-owner', { agent_id: AGENT_A, seat: 'hadi-assistant' }),
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
    expect(minted.label).toBe('hadi-assistant')
    expect(minted.channel).toBe('workspace')
    expect(body).toContain('x-mupot-seat')
    expect(body).toContain('hadi-assistant')
    expect(body).not.toContain('token_hash')
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
  })

  // Kasra's collision ruling: #1253 and this branch both rewrite next_step for
  // the same unbound state, with tests that contradict each other. Enrollment
  // ships as structured data; the prose is left to whichever PR owns it. Pin the
  // absence, so re-adding the door to the sentence is a red test and not a
  // silent re-collision.
  it('does NOT put the enrollment door in next_step prose — structured field only', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const res = await callTool(env, 'boot_context', { seat: 'cursor-river' })
    const body = (await res.json()) as {
      result: { structuredContent: { enroll_url?: string; next_step: string } }
    }
    const sc = body.result.structuredContent
    expect(sc.enroll_url).toContain('/enroll')
    expect(sc.next_step).not.toContain('/enroll')
    // The pre-existing doors must survive the strip, or #1253's tests break too.
    expect(sc.next_step).toContain('connect')
    expect(sc.next_step).toContain('mint_agent_token')
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

// ── mupot#1324 BLOCK-1: bootstrap owner with NO members row ──────────────────
//
// Kasra's adversarial finding: every prior positive test in this file reuses
// HUMAN_ADMIN — a subject that has BOTH a members row AND a squad-admin grant.
// That is exactly why the bootstrap-owner shape was never exercised: a legacy
// owner/admin session (role from the ORG login, capability.ts:50-52's
// documented "the bootstrap owner has no grant rows at all") often has no
// `members` row either. Pre-fix, that principal got 403
// "No member identity resolved for this session" from POST /enroll/mint and
// saw zero consentable agents on GET /enroll, while the sibling
// POST /admin/agent-token/mint admitted the identical principal via
// isOrgAdmin. This block proves BOTH surfaces now agree.
describe('bootstrap owner with NO members row (mupot#1324 BLOCK-1)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  const BOOTSTRAP_OWNER_EMAIL = 'boss@pot.test'

  it('GET /enroll shows every active agent across every squad, not zero', async () => {
    harness = makeHarness()
    // Deliberately NO members row, NO capabilities row, for this email —
    // the exact shape the block report reproduced.
    const env = envFor(harness, { 'sess:s-boss': sessionRecord(BOOTSTRAP_OWNER_EMAIL, 'owner') })
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=owner-laptop', 's-boss'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(BOOTSTRAP_OWNER_EMAIL)
    // Pre-fix this was the empty-state copy ("You may not act as any agent
    // yet") because listConsentableAgents(env, null) never even ran.
    expect(body).not.toContain('You may not act as any agent yet')
    // Sees BOTH squads' agents — org-admin listing, not one squad's.
    expect(body).toContain('Cursor River')
    expect(body).toContain(AGENT_A)
    expect(body).toContain('Ghost Agent')
    expect(body).toContain(AGENT_B)
  })

  it('POST /enroll/mint succeeds for an agent OUTSIDE any squad this principal has a grant row on', async () => {
    harness = makeHarness()
    const sessions = statefulSessions({ 'sess:s-boss': sessionRecord(BOOTSTRAP_OWNER_EMAIL, 'owner') })
    const env = envFor(harness, {}, sessions.kv)
    const before = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?`)
      .get(AGENT_B) as { n: number }

    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-boss', { agent_id: AGENT_B, seat: 'owner-seat' }),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('x-mupot-seat')
    expect(body).toContain('owner-seat')
    expect(body).toMatch(/mupot_[0-9a-f]{64}/)

    const after = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?`)
      .get(AGENT_B) as { n: number }
    expect(after.n).toBe(before.n + 1)

    // No members row for this principal → mintAgentBoundToken is called
    // WITHOUT issuedBy (matching the sibling /admin/agent-token/mint route,
    // which never attaches it either) — an empty trail, not a fabricated one.
    const auditRows = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_token_issuance_audit`)
      .get() as { n: number }
    expect(auditRows.n).toBe(0)
  })

  it('does NOT admit a plain member with no org role and no grants — the widen is isOrgAdmin-only', async () => {
    harness = makeHarness()
    // A brand-new Google login: role 'member', no members row, no grants at all.
    const env = envFor(harness, { 'sess:s-nobody': sessionRecord('nobody@pot.test') })
    const res = await dashboardApp.fetch(
      dashboardPost('/enroll/mint', 's-nobody', { agent_id: AGENT_A, seat: 'nobody-seat' }),
      env,
    )
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toMatch(/Not allowed|requires owner or admin|forbidden|operator principal|No member identity resolved/i)
    expect(body).not.toMatch(/mupot_[0-9a-f]{64}/)
    const minted = harness.sqlite
      .prepare(`SELECT id FROM member_tokens WHERE label = ?`)
      .get('nobody-seat')
    expect(minted).toBeUndefined()
  })

  it('cross-tenant: the same owner email session scoped to a DIFFERENT tenant sees nothing from pot-a', async () => {
    harness = makeHarness()
    const env = {
      ...envFor(harness, { 'sess:s-boss': sessionRecord(BOOTSTRAP_OWNER_EMAIL, 'owner') }),
      TENANT_SLUG: 'other-pot',
    } as Env
    const res = await dashboardApp.fetch(dashboardReq('/enroll?seat=owner-laptop', 's-boss'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('Cursor River')
    expect(body).not.toContain(AGENT_A)
    expect(body).not.toContain('Ghost Agent')
    expect(body).not.toContain(AGENT_B)
  })
})

// ── mupot#1335 (surfaced by #1324's adversarial gate) — authorizeEnrollMint's
// grants source, enroll.ts:154 ───────────────────────────────────────────────
//
// The instructed fix is narrow: point authorizeEnrollMint's FALLBACK grants
// lookup at resolveHumanStandingGrants (status-gated) instead of the raw
// resolveCapabilities — WITHOUT touching resolveHumanMemberId's own step-2 gap
// (that gap is #1335's separate fix, tracked there).
//
// IMPORTANT, and worth being honest about in the PR rather than papering over
// with a lenient assertion: this closes the gap only on the branch where
// `auth.capabilities` is undefined (memberId set directly, no ambient
// capabilities already attached). On the LIVE dashboard cookie path, a
// role==='member' session gets `auth.capabilities` populated by
// loadAuthFromCookie's OWN email→member bridge (src/auth/index.ts) BEFORE
// authorizeEnrollMint ever runs — and that bridge calls the raw
// resolveCapabilities with no status check of its own. Since
// `auth.capabilities ?? (...)` short-circuits on a defined (even empty) array,
// a suspended member logging in fresh through that bridge is NOT closed by
// this PR's change; closing THAT would mean editing loadAuthFromCookie, which
// is its own surface change outside enroll.ts. Flagged for Kasra-core: if the
// intent was to close the live cookie path too, this PR does not fully do it,
// and that decision needs a human call, not a silent narrower test.
describe('authorizeEnrollMint — suspended-member grants source (mupot#1335, enroll.ts:154)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  const SUSPENDED_MEMBER = 'member-suspended'

  // Reason changed from squad_admin_required to principal_revoked (gate 6). The old code
  // sent a revoked principal to a page telling the operator to grant squad admin — which
  // hands admin to a suspended account, still 403s on reload, and escalates. A revoked
  // human and an under-privileged one are different refusals.
  it('refuses (principal_revoked) when the resolved memberId points at a suspended members row', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${SUSPENDED_MEMBER}', 'susp@pot.test', 'Suspended', 'suspended', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-susp-a', '${SUSPENDED_MEMBER}', 'squad', '${SQUAD_A}', 'admin');
    `)
    const env = envFor(harness)
    // auth.memberId set directly (bearer/memberId-resolved shape) and
    // auth.capabilities left undefined, so authorizeEnrollMint's fallback
    // (enroll.ts:154) is the branch actually exercised — the raw
    // resolveCapabilities would see the live capability row and admit this;
    // resolveHumanStandingGrants must not.
    const auth = {
      userId: 'u-susp',
      email: 'susp@pot.test',
      role: 'member' as const,
      tenant: TENANT,
      memberId: SUSPENDED_MEMBER,
    }
    const result = await authorizeEnrollMint(env, auth, SQUAD_A)
    expect(result).toEqual({ ok: false, reason: 'principal_revoked' })
  })

  it('control: the SAME memberId + grant, status active, is admitted', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${SUSPENDED_MEMBER}', 'susp@pot.test', 'Formerly suspended', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-susp-a', '${SUSPENDED_MEMBER}', 'squad', '${SQUAD_A}', 'admin');
    `)
    const env = envFor(harness)
    const auth = {
      userId: 'u-susp',
      email: 'susp@pot.test',
      role: 'member' as const,
      tenant: TENANT,
      memberId: SUSPENDED_MEMBER,
    }
    const result = await authorizeEnrollMint(env, auth, SQUAD_A)
    expect(result).toEqual({ ok: true })
  })
})
