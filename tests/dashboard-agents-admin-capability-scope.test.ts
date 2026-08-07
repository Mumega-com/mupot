// tests/dashboard-agents-admin-capability-scope.test.ts — FLIGHT-001 F2.
//
// End-to-end, real SQL (createSqliteD1 + applyAllMigrations — the #684 ratchet
// rejects hand-built schema): drives the REAL dashboardApp through the REAL
// requireAuth (session cookie → KV → email→member bridge → resolveCapabilities),
// not a mocked auth layer. Proves two things together, because the bug was two
// layers of the same hole:
//
//   1. THE GATE (src/dashboard/index.ts) — a session with zero capability rows
//      never reaches ANY dashboard read route. Before this fix, requireAuth only
//      proved presence (a valid cookie); a random Google-connect signup sailed
//      straight through to every menu.
//   2. THE SCOPE (src/dashboard/agents-admin.ts loadAllAgents) — a session with
//      SOME capability, but only on one squad, sees only that squad's roster,
//      not the whole pot's.
//
// DENY matrix:
//   zero-capability member  → 403 on every gated route, no roster leak
//   squad-scoped member     → 200, sees ONLY their own squad's agents
//   org-scope capability    → 200, sees every squad
//   legacy owner (no fine-grained grants) → 200, sees every squad

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-zero', 'zero@drive-by.test', 'Zero Cap', 'active', 'pot-a'),
      ('member-squad-a', 'squad-a@pot.test', 'Squad A Member', 'active', 'pot-a'),
      ('member-org', 'org@pot.test', 'Org Member', 'active', 'pot-a');

    -- member-zero: NO rows in capabilities — the drive-by signup case.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-a', 'member-squad-a', 'squad', 'squad-a', 'member'),
      ('cap-org', 'member-org', 'org', NULL, 'admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, sessions: Record<string, string>): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'pot-a',
    BRAND: 'Test Pot',
    SESSIONS: {
      get: async (key: string) => sessions[key] ?? null,
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function sessionRecord(email: string, role: 'owner' | 'admin' | 'member' = 'member'): string {
  return JSON.stringify({ userId: `u-${email}`, email, role, createdAt: '2026-01-01T00:00:00Z' })
}

function req(path: string, sessionId: string): Request {
  return new Request(`https://pot.test${path}`, { headers: { Cookie: `mupot_session=${sessionId}` } })
}

describe('FLIGHT-001 F2 — dashboard capability floor + agent roster scoping (real SQL)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('zero-capability member: 403 on GET /agents (no roster leak)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const res = await dashboardApp.fetch(req('/agents', 's-zero'), env)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('Agent Alpha')
    expect(body).not.toContain('Agent Beta')
  })

  it('zero-capability member: 403 on GET / (overview) and GET /projects — every menu, not just roster', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const overview = await dashboardApp.fetch(req('/', 's-zero'), env)
    const projects = await dashboardApp.fetch(req('/projects', 's-zero'), env)
    expect(overview.status).toBe(403)
    expect(projects.status).toBe(403)
  })

  it('zero-capability member hitting a JSON-negotiated route gets a JSON 403, not an HTML page', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/agents?format=json', {
        headers: { Cookie: 'mupot_session=s-zero' },
      }),
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('forbidden')
  })

  it('squad-scoped member: 200 on GET /agents, sees ONLY their own squad', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/agents', 's-squad-a'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Agent Alpha')
    expect(body).not.toContain('Agent Beta')
  })

  it('org-scope capability: 200 on GET /agents, sees every squad', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    const res = await dashboardApp.fetch(req('/agents', 's-org'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Agent Alpha')
    expect(body).toContain('Agent Beta')
  })

  it('legacy owner (no fine-grained capabilities row at all): 200, sees every squad', async () => {
    harness = makeHarness()
    // No members row for this email at all — pure legacy web-login owner.
    const env = envFor(harness, { 'sess:s-owner': sessionRecord('owner@pot.test', 'owner') })
    const res = await dashboardApp.fetch(req('/agents', 's-owner'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Agent Alpha')
    expect(body).toContain('Agent Beta')
  })

  it('unauthenticated (no session cookie) still redirects to /auth/login, not the capability deny page', async () => {
    harness = makeHarness()
    const env = envFor(harness, {})
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/agents', { redirect: 'manual' }),
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  // ── GET /squads/:id — per-squad read gate (found auditing F2) ───────────────

  it('squad-a member: 200 on GET /squads/squad-a (their own squad)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/squads/squad-a', 's-squad-a'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agent Alpha')
  })

  it('squad-a member: 403 on GET /squads/squad-b (a DIFFERENT squad they hold no grant on)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/squads/squad-b', 's-squad-a'), env)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Agent Beta')
  })

  it('org-scope capability: 200 on GET /squads/:id for EVERY squad', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    expect((await dashboardApp.fetch(req('/squads/squad-a', 's-org'), env)).status).toBe(200)
    expect((await dashboardApp.fetch(req('/squads/squad-b', 's-org'), env)).status).toBe(200)
  })

  // ── GET /members — was UNGATED before this fix, leaking every member's ──────
  // email/display_name/telegram_chat_id + every live token label org-wide.

  it('zero-capability member: 403 on GET /members (floor stops it before the admin check)', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const res = await dashboardApp.fetch(req('/members', 's-zero'), env)
    expect(res.status).toBe(403)
  })

  it('squad-scoped (non-admin) member: 403 on GET /members — no org-wide member/token leak to a non-admin', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/members', 's-squad-a'), env)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('zero@drive-by.test')
    expect(body).not.toContain('org@pot.test')
  })

  it('org-admin capability: 200 on GET /members, sees the full roster', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    const res = await dashboardApp.fetch(req('/members', 's-org'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('squad-a@pot.test')
    expect(body).toContain('zero@drive-by.test')
  })
})
