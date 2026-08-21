// Tests for the Owner Control Center v1 (mupot#1067):
//   1. loadControlCenterView — hierarchy, memberships, credential state (no secrets), duplicates
//   2. GET /admin/control-center — org-admin gated
//   3. loadJoinPreview — resolve by id / unique slug; AMBIGUOUS slug -> fail closed
//   4. POST /squads/:id/agents/join — confirm via setAgentSquadAccess: no duplicate, no mint
//   5. Backlog create-vs-dispatch separation (dashboard board form presence)
import { describe, it, expect } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import { loadControlCenterView } from '../src/dashboard/control-center'
import { loadJoinPreview, confirmJoin } from '../src/dashboard/join-agent'
import type { Env } from '../src/types'

function makeEnv() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const sessionStore = new Map<string, string>()
  const env = {
    TENANT_SLUG: 'mumega',
    DB: harness.db,
    SESSIONS: {
      get: async (k: string) => sessionStore.get(k) ?? null,
      put: async (k: string, v: string) => sessionStore.set(k, v),
    },
  } as unknown as Env
  return { harness, env, sessionStore }
}

function seedOrg(harness: ReturnType<typeof makeEnv>['harness']) {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, kind) VALUES ('dept-1', 'eng', 'Engineering', 'work');
    INSERT INTO squads (id, department_id, slug, name, charter) VALUES ('sq-1', 'dept-1', 'hadi-mac', 'Hadi Mac', NULL);
    INSERT INTO squads (id, department_id, slug, name, charter) VALUES ('sq-2', 'dept-1', 'squad-core', 'Squad Core', NULL);
    -- two live cyrus-prime agents (duplicate slug across squads — the #1067 case)
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-bound', 'sq-1', 'cyrus-prime', 'Cyrus Prime (Hadi Mac)', 'admin', '@dsv4flash', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-core', 'sq-2', 'cyrus-prime', 'Cyrus Prime (Core)', 'member', '@dsv4flash', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-join', 'sq-1', 'hadi-codex', 'Hadi Codex', 'member', 'gpt-5.6-sol', 'active');
    -- member + weld for agent-join (needed by confirmJoin)
    INSERT INTO members (id, display_name, status, tenant) VALUES ('mem-join', 'Hadi Codex', 'active', 'mumega');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('mumega', 'agent-join', 'mem-join', '2026-08-15T00:00:00.000Z');
    -- one live credential for mem-join
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES
      ('tok-1', 'mem-join', 'hash-not-raw', 'codex laptop', 'workspace', 'mumega');
  `)
}

function ownerSession(sessionStore: Map<string, string>, memberId = 'owner-1') {
  sessionStore.set('sess:tok-1', JSON.stringify({
    userId: memberId, email: 'hadi@mumega.com', role: 'owner',
    createdAt: new Date().toISOString(),
  }))
}

describe('Owner Control Center v1 (mupot#1067)', () => {
  it('loadControlCenterView: hierarchy, memberships, credential state, duplicate warnings', async () => {
    const { harness, env } = makeEnv()
    seedOrg(harness)
    const view = await loadControlCenterView(env)

    expect(view.departments.length).toBe(1)
    const dept = view.departments[0]
    expect(dept.squads.length).toBe(2)

    const hadiMac = dept.squads.find((s) => s.slug === 'hadi-mac')!
    expect(hadiMac.agents.length).toBe(2)
    const codex = hadiMac.agents.find((a) => a.slug === 'hadi-codex')!
    expect(codex.id).toBe('agent-join')
    // credential state: bound + 1 live token, channels listed, NO hash/raw in the view
    expect(codex.credentialState.boundMemberId).toBe('mem-join')
    expect(codex.credentialState.liveTokenCount).toBe(1)
    expect(codex.credentialState.channels).toContain('workspace')
    expect(JSON.stringify(view)).not.toContain('hash-not-raw')

    // duplicate warning: cyrus-prime appears in 2 live rows
    expect(view.duplicateWarnings.length).toBe(1)
    expect(view.duplicateWarnings[0].slug).toBe('cyrus-prime')
    expect(view.duplicateWarnings[0].agents.length).toBe(2)
    expect(view.totals.agents).toBe(3)
    expect(view.totals.liveTokens).toBe(1)
  })

  it('GET /admin/control-center is org-admin gated (403 for non-admin)', async () => {
    const { harness, env, sessionStore } = makeEnv()
    seedOrg(harness)
    sessionStore.set('sess:tok-1', JSON.stringify({
      userId: 'member-1', email: 'm@m.com', role: 'member',
      createdAt: new Date().toISOString(),
    }))
    const res = await dashboardApp.fetch(new Request('http://localhost/admin/control-center', {
      headers: { cookie: 'mupot_session=tok-1' },
    }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    expect(res.status).toBe(403)
  })

  it('GET /admin/control-center renders for org-admin', async () => {
    const { harness, env, sessionStore } = makeEnv()
    seedOrg(harness)
    ownerSession(sessionStore)
    const res = await dashboardApp.fetch(new Request('http://localhost/admin/control-center', {
      headers: { cookie: 'mupot_session=tok-1' },
    }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Owner Control Center')
    expect(body).toContain('cyrus-prime') // duplicate warning visible
    expect(body).not.toContain('hash-not-raw') // no secrets
  })

  it('loadJoinPreview: resolves by exact id; AMBIGUOUS slug fails closed', async () => {
    const { harness, env } = makeEnv()
    seedOrg(harness)
    const squad = { id: 'sq-1', department_id: 'dept-1', slug: 'hadi-mac', name: 'Hadi Mac' } as never

    // exact id wins even with duplicate slugs
    const byId = await loadJoinPreview(env, squad, 'agent-join')
    expect(byId.ok).toBe(true)
    expect(byId.agent?.id).toBe('agent-join')
    expect(byId.agent?.bound).toBe(true)

    // ambiguous slug -> fail closed (two live cyrus-prime rows)
    const amb = await loadJoinPreview(env, squad, 'cyrus-prime')
    expect(amb.ok).toBe(false)
    expect(amb.error).toBe('ambiguous')

    // not found
    const nf = await loadJoinPreview(env, squad, 'ghost')
    expect(nf.ok).toBe(false)
    expect(nf.error).toBe('not_found')
  })

  it('confirmJoin: creates membership (no duplicate, no mint), idempotent update', async () => {
    const { harness, env } = makeEnv()
    seedOrg(harness)
    const squad = { id: 'sq-1', department_id: 'dept-1', slug: 'hadi-mac', name: 'Hadi Mac' } as never

    const created = await confirmJoin(env, squad, 'agent-join', 'admin')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.result).toBe('created')

    // idempotent re-confirm -> updated/unchanged, still ONE membership row
    const again = await confirmJoin(env, squad, 'agent-join', 'lead')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const rows = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = ?')
      .get('agent-join', 'sq-1') as { n: number }
    expect(Number(rows.n)).toBe(1)

    // unminted agent -> fail closed (join never mints)
    const unminted = await confirmJoin(env, squad, 'agent-bound', 'member')
    expect(unminted.ok).toBe(false)
    if (!unminted.ok) expect(unminted.error).toBe('agent_identity_unminted')
  })

  it('squad board separates backlog creation from dispatch (form + copy present)', async () => {
    const { harness, env, sessionStore } = makeEnv()
    seedOrg(harness)
    ownerSession(sessionStore)
    const res = await dashboardApp.fetch(new Request('http://localhost/squads/sq-1', {
      headers: { cookie: 'mupot_session=tok-1' },
    }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Create task (backlog only)')
    expect(body).toContain('Creation is separate from dispatch')
    expect(body).toContain('add an <strong>existing</strong> agent')
  })
})
