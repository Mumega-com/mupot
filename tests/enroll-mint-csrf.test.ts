// POST /enroll/mint — CSRF receipt for dashboard-wide hono/csrf middleware.
//
// Proves (or falsifies) that `dashboardApp.use('*', csrf())` in
// src/dashboard/index.ts runs BEFORE the mint handler and blocks cross-origin
// form POSTs without writing member_tokens rows.
//
// Schema via createSqliteD1 + applyAllMigrations — no hand-written CREATE TABLE.

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_A = 'agent-river'
const AGENT_B = 'agent-ghost'
const HUMAN_ADMIN = 'member-admin'
const HUMAN_MEMBER = 'member-plain'
const UNBOUND_HASH = createHash('sha256').update('test-unbound-bearer').digest('hex')

const CSRF_FORBIDDEN_BODY = 'Forbidden'

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

function envFor(harness: SqliteD1Harness, sessions: Record<string, string> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    // Writable, because the mint throttle fails CLOSED: a read-only KV mock
    // makes every mint here 429 and the CSRF boundary untestable.
    SESSIONS: (() => {
      const store = new Map<string, string>(Object.entries(sessions))
      return {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value) },
        delete: async (key: string) => { store.delete(key) },
      }
    })(),
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

function memberTokenCount(harness: SqliteD1Harness): number {
  return (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM member_tokens`).get() as { n: number }).n
}

function enrollMintPost(
  sessionId: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const hdrs = new Headers(headers)
  hdrs.set('Cookie', `mupot_session=${sessionId}`)
  hdrs.set('content-type', 'application/x-www-form-urlencoded')
  return new Request(`${ORIGIN}/enroll/mint`, {
    method: 'POST',
    headers: hdrs,
    body: new URLSearchParams(values),
  })
}

describe('POST /enroll/mint — CSRF (dashboard-wide hono/csrf)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('rejects cross-origin POST before minting (403 Forbidden, member_tokens unchanged)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const before = memberTokenCount(harness)

    const res = await dashboardApp.fetch(
      enrollMintPost(
        's-admin',
        { agent_id: AGENT_A, seat: 'csrf-evil-seat' },
        { Origin: 'https://evil.example' },
      ),
      env,
    )

    expect(res.status).toBe(403)
    expect(await res.text()).toBe(CSRF_FORBIDDEN_BODY)

    expect(memberTokenCount(harness)).toBe(before)
    const stolen = harness.sqlite
      .prepare(`SELECT id FROM member_tokens WHERE label = ?`)
      .get('csrf-evil-seat')
    expect(stolen).toBeUndefined()
  })

  // The honest boundary of the CSRF claim, and the invariant that makes the
  // route safe anyway.
  //
  // hono/csrf only fires when the content-type is a form-element type
  // (x-www-form-urlencoded, multipart/form-data, text/plain) or absent. A POST
  // declaring application/json therefore walks straight past the middleware --
  // verified here, not assumed: it reaches the handler and returns 400, not the
  // 403 Forbidden the middleware would have produced.
  //
  // It mints NOTHING, and the reason is worth stating because it is implicit:
  // the handler reads c.req.parseBody(), which only understands the very
  // content-types csrf() guards. So the bypass hands the handler an empty body
  // and dies on "Pick an agent." The protection survives on a COUPLING between
  // the middleware's content-type filter and the handler's parser.
  //
  // That coupling is unwritten and one refactor from breaking: switch this
  // handler to c.req.json() to accept an API-shaped client and CSRF protection
  // silently evaporates, with no test failing to say so. This test is that
  // test. If it starts failing because the route learned to read JSON, the
  // route needs its own CSRF check -- do not just update the assertion.
  //
  // (A real browser cannot mount this anyway: a cross-origin application/json
  // POST is not a simple request and needs a CORS preflight the dashboard never
  // grants, and the session cookie is SameSite=Lax so it would not be attached
  // cross-site regardless. This is defence in depth, not the only defence.)
  it('a JSON content-type POST bypasses hono/csrf but cannot mint — the parseBody coupling', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const before = memberTokenCount(harness)

    const hdrs = new Headers({
      Origin: 'https://evil.example',
      'content-type': 'application/json',
      Cookie: 'mupot_session=s-admin',
    })
    const res = await dashboardApp.fetch(
      new Request(`${ORIGIN}/enroll/mint`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ agent_id: AGENT_A, seat: 'json-bypass-seat' }),
      }),
      env,
    )

    // Past the middleware: this is the handler's refusal, not hono/csrf's.
    const body = await res.text()
    expect(res.status).toBe(400)
    expect(body).not.toBe(CSRF_FORBIDDEN_BODY)

    // And nothing was issued.
    expect(memberTokenCount(harness)).toBe(before)
    expect(
      harness.sqlite.prepare(`SELECT id FROM member_tokens WHERE label = ?`).get('json-bypass-seat'),
    ).toBeUndefined()
  })

  it('passes same-origin POST through the CSRF layer (auth refusal is HTML, not plain Forbidden)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-plain': sessionRecord('member@pot.test') })
    const before = memberTokenCount(harness)

    const res = await dashboardApp.fetch(
      enrollMintPost(
        's-plain',
        { agent_id: AGENT_A, seat: 'csrf-legit-seat' },
        { Origin: ORIGIN },
      ),
      env,
    )

    const body = await res.text()
    expect(body).not.toBe(CSRF_FORBIDDEN_BODY)
    expect(res.status).toBe(403)
    expect(body).toMatch(/Not allowed|requires owner or admin|forbidden/i)
    expect(memberTokenCount(harness)).toBe(before)
  })

  it('passes same-origin POST with matching Origin through CSRF to a successful mint', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })
    const before = memberTokenCount(harness)

    const res = await dashboardApp.fetch(
      enrollMintPost(
        's-admin',
        { agent_id: AGENT_A, seat: 'csrf-good-seat' },
        { Origin: ORIGIN },
      ),
      env,
    )

    const body = await res.text()
    expect(body).not.toBe(CSRF_FORBIDDEN_BODY)
    expect(res.status).toBe(200)
    expect(body).toMatch(/mupot_[0-9a-f]{64}/)
    expect(memberTokenCount(harness)).toBe(before + 1)
  })

  it('documents missing Origin on same-origin POST (hono/csrf empirical behaviour)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })

    const withoutOriginOrSecFetch = await dashboardApp.fetch(
      enrollMintPost('s-admin', { agent_id: AGENT_A, seat: 'no-origin-seat' }),
      env,
    )
    const withoutOriginBody = await withoutOriginOrSecFetch.text()

    const withSecFetchSameOrigin = await dashboardApp.fetch(
      enrollMintPost(
        's-admin',
        { agent_id: AGENT_A, seat: 'sec-fetch-seat' },
        { 'Sec-Fetch-Site': 'same-origin' },
      ),
      env,
    )
    const withSecFetchBody = await withSecFetchSameOrigin.text()

    // hono/csrf blocks when BOTH Origin and Sec-Fetch-Site checks fail.
    expect(withoutOriginOrSecFetch.status).toBe(403)
    expect(withoutOriginBody).toBe(CSRF_FORBIDDEN_BODY)

    expect(withSecFetchSameOrigin.status).toBe(200)
    expect(withSecFetchBody).not.toBe(CSRF_FORBIDDEN_BODY)
    expect(withSecFetchBody).toMatch(/mupot_[0-9a-f]{64}/)
  })

  it('does not apply CSRF to GET /enroll (safe method)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-admin': sessionRecord('admin@pot.test') })

    const res = await dashboardApp.fetch(
      new Request(`${ORIGIN}/enroll?seat=cursor-river`, {
        headers: {
          Cookie: 'mupot_session=s-admin',
          Origin: 'https://evil.example',
        },
      }),
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toBe(CSRF_FORBIDDEN_BODY)
    expect(body).toContain('Enroll a seat key')
    expect(body).toContain('cursor-river')
  })
})
