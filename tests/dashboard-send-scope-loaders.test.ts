// tests/dashboard-send-scope-loaders.test.ts — scope dashboard agent/squad lists
// to the squads the caller can reach. Real SQL (applyAllMigrations) driving the
// real dashboardApp through the real requireAuth.
//   stranger (admin of own home squad only) -> only their own agents
//   squad admin                             -> only their squad's agents
//   org admin                               -> everything
// Routes: GET /send, GET / (overview), GET /agents (squad picker options).

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('squad-team', 'dept-a', 'squad-team', 'Squad Team', 'work'),
      ('squad-other', 'dept-a', 'squad-other', 'Squad Other', 'work'),
      ('squad-home-s', 'dept-a', 'squad-home-s', 'Home Stranger', 'home'),
      ('squad-home-x', 'dept-a', 'squad-home-x', 'Home Someone Else', 'home');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('ag-team', 'squad-team', 'ag-team', 'Agent TeamZ', 'operator', 'test', 'active'),
      ('ag-other', 'squad-other', 'ag-other', 'Agent OtherZ', 'operator', 'test', 'active'),
      ('ag-home-s', 'squad-home-s', 'ag-home-s', 'Agent StrangerZ', 'operator', 'test', 'active'),
      ('ag-home-x', 'squad-home-x', 'ag-home-x', 'Agent PrivateZ', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-stranger', 'stranger@pot.test', 'Stranger', 'active', 'pot-a'),
      ('m-squad', 'squad@pot.test', 'Squad Admin', 'active', 'pot-a'),
      ('m-org', 'org@pot.test', 'Org Admin', 'active', 'pot-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1', 'm-stranger', 'squad', 'squad-home-s', 'admin'),
      ('c2', 'm-squad', 'squad', 'squad-team', 'admin'),
      ('c3', 'm-org', 'org', NULL, 'admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  const sessions: Record<string, string> = {}
  for (const [id, email] of [['s-stranger', 'stranger@pot.test'], ['s-squad', 'squad@pot.test'], ['s-org', 'org@pot.test']]) {
    sessions[`sess:${id}`] = JSON.stringify({ userId: `u-${email}`, email, role: 'member', createdAt: '2026-01-01T00:00:00Z' })
  }
  return {
    DB: harness.db,
    TENANT_SLUG: 'pot-a',
    BRAND: 'Test Pot',
    SESSIONS: { get: async (k: string) => sessions[k] ?? null },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

async function get(env: Env, path: string, sid: string): Promise<{ status: number; body: string }> {
  const res = await dashboardApp.fetch(new Request(`https://pot.test${path}`, { headers: { Cookie: `mupot_session=${sid}` } }), env)
  return { status: res.status, body: await res.text() }
}

describe('dashboard agent/squad lists are scoped to the caller squads (real SQL)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  for (const path of ['/send', '/']) {
    it(`${path}: stranger sees only their own home-squad agent`, async () => {
      harness = makeHarness()
      const { status, body } = await get(envFor(harness), path, 's-stranger')
      expect(status).toBe(200)
      expect(body).toContain('Agent StrangerZ')
      for (const n of ['Agent TeamZ', 'Agent OtherZ', 'Agent PrivateZ']) expect(body).not.toContain(n)
    })

    it(`${path}: squad admin sees only their squad's agents`, async () => {
      harness = makeHarness()
      const { status, body } = await get(envFor(harness), path, 's-squad')
      expect(status).toBe(200)
      expect(body).toContain('Agent TeamZ')
      for (const n of ['Agent OtherZ', 'Agent PrivateZ', 'Agent StrangerZ']) expect(body).not.toContain(n)
    })

    it(`${path}: org admin sees every squad's agents`, async () => {
      harness = makeHarness()
      const { status, body } = await get(envFor(harness), path, 's-org')
      expect(status).toBe(200)
      for (const n of ['Agent TeamZ', 'Agent OtherZ']) expect(body).toContain(n)
    })
  }

  it('/agents: squad picker options list only reachable squads', async () => {
    harness = makeHarness()
    const stranger = await get(envFor(harness), '/agents', 's-stranger')
    expect(stranger.status).toBe(200)
    expect(stranger.body).not.toContain('Squad Team')
    expect(stranger.body).not.toContain('Squad Other')
    const squad = await get(envFor(harness), '/agents', 's-squad')
    expect(squad.body).not.toContain('Squad Other')
    const org = await get(envFor(harness), '/agents', 's-org')
    expect(org.body).toContain('Squad Team')
    expect(org.body).toContain('Squad Other')
  })
})
