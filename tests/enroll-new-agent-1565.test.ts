// tests/enroll-new-agent-1565.test.ts — mupot#1565: /enroll told an owner "You may not act as any agent yet" about the agent they
// had just created. Cause: an agent's identity weld (member + agent_member_bindings row) is created lazily by the FIRST credential
// mint, but the /enroll picker (listConsentableAgents) INNER JOINed agent_member_bindings, so a freshly created agent was invisible and
// the only door that mints the first key could never be reached. /enroll now opts in (includeUnbound) to list such agents behind the
// SAME squad-admin bar; OAuth consent keeps the inner join. Driven through the real route (cookie session -> dashboardApp.fetch).
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import { loadEnrollView } from '../src/dashboard/enroll'
import { listConsentableAgents } from '../src/mcp/oauth-authorize'
import { createHomeForMember } from '../src/org/service'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'pot-new'
const ORIGIN = 'https://pot.test'

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

function setup(): { env: Env; store: Map<string, string> } {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-a', 'sq-a', 'Squad A'), ('sq-b', 'dept-a', 'sq-b', 'Squad B');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-admin', 'admin@pot.test', 'Admin A', 'active', '${TENANT}'),
      ('m-plain', 'plain@pot.test', 'Plain A', 'active', '${TENANT}'),
      ('m-owner', 'owner@pot.test', 'Owner', 'active', '${TENANT}'),
      ('m-other', 'other@pot.test', 'Other', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1', 'm-admin', 'squad', 'sq-a', 'admin'), ('c2', 'm-plain', 'squad', 'sq-a', 'member');
    -- freshly created agents: NO member, NO binding, NO token (exactly what create_agent leaves)
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('ag-new-a', 'sq-a', 'new-a', 'New Agent A', 'member', 'test', 'active'),
      ('ag-new-b', 'sq-b', 'new-b', 'New Agent B', 'member', 'test', 'active'),
      ('ag-dead', 'sq-a', 'dead', 'Dead Agent', 'member', 'test', 'inactive');
  `)
  const store = new Map<string, string>()
  for (const [id, email, role] of [['s-admin', 'admin@pot.test', 'member'], ['s-plain', 'plain@pot.test', 'member'], ['s-owner', 'owner@pot.test', 'owner']]) {
    store.set(`sess:${id}`, JSON.stringify({ userId: `u-${id}`, email, role, createdAt: '2026-01-01T00:00:00Z' }))
  }
  const env = {
    DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'T', PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } },
    OAUTH_KV: { get: async () => null, put: async () => undefined }, VEC: { query: async () => ({ matches: [] }) },
    BUS: { send: async () => {} }, BLOBS: {}, AI: {}, AGENT: {}, SQUAD: {},
  } as unknown as Env
  return { env, store }
}

const get = (env: Env, sid: string) => dashboardApp.fetch(new Request(`${ORIGIN}/enroll`, { headers: { Cookie: `mupot_session=${sid}`, Origin: ORIGIN } }), env)
const mint = (env: Env, sid: string, agent: string) => dashboardApp.fetch(new Request(`${ORIGIN}/enroll/mint`, {
  method: 'POST', headers: { Cookie: `mupot_session=${sid}`, Origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ agent_id: agent, seat: 'laptop' }),
}), env)

describe('#1565 /enroll lists a freshly created (unbound) agent', () => {
  it('REPRO/FIX: a squad admin sees the new agent, and minting through the page welds + issues the first key', async () => {
    const { env } = setup()
    const res = await get(env, 's-admin')
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toContain('You may not act as any agent yet')
    expect(body).toContain('ag-new-a')
    const m = await mint(env, 's-admin', 'ag-new-a')
    expect(m.status).toBe(200)
    expect((harness!.sqlite.prepare(`SELECT COUNT(*) n FROM agent_member_bindings WHERE agent_id = 'ag-new-a'`).get() as { n: number }).n).toBe(1)
    expect((harness!.sqlite.prepare(`SELECT COUNT(*) n FROM member_tokens WHERE agent_id = 'ag-new-a' AND revoked_at IS NULL`).get() as { n: number }).n).toBe(1)
  })

  it('the bar is unchanged: another squad\'s new agent, an inactive agent, and a squad-member (not admin) stay hidden', async () => {
    const { env } = setup()
    const body = await (await get(env, 's-admin')).text()
    expect(body).not.toContain('ag-new-b')
    expect(body).not.toContain('ag-dead')
    const plain = await (await get(env, 's-plain')).text()
    expect(plain).not.toContain('ag-new-a')
    expect(plain).toContain('You may not act as any agent yet')
  })

  it('refusal on the POST is unchanged for an unbound agent outside the caller\'s admin scope (and nothing is welded)', async () => {
    const { env } = setup()
    expect((await mint(env, 's-admin', 'ag-new-b')).status).toBe(403)
    expect((await mint(env, 's-plain', 'ag-new-a')).status).toBe(403)
    expect((harness!.sqlite.prepare(`SELECT COUNT(*) n FROM agent_member_bindings`).get() as { n: number }).n).toBe(0)
  })

  it('home-squad isolation (G-FP1b): an org owner does NOT see another member\'s unbound home agent, but sees their own', async () => {
    const { env } = setup()
    const own = await createHomeForMember(env, 'm-owner')
    const other = await createHomeForMember(env, 'm-other')
    if (!own.ok || !other.ok) throw new Error('home setup failed')
    harness!.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('ag-own-home', '${own.squad.id}', 'own-home', 'Own Home', 'member', 'test', 'active'),
      ('ag-other-home', '${other.squad.id}', 'other-home', 'Other Home', 'member', 'test', 'active')`)
    const auth = { userId: 'u', memberId: 'm-owner', email: 'owner@pot.test', role: 'owner', tenant: TENANT, channel: 'dashboard', boundAgentId: null } as unknown as AuthContext
    const ids = (await loadEnrollView(env, auth, {})).agents.map((a) => a.id)
    expect(ids).toContain('ag-new-a') // org owner: every work squad
    expect(ids).not.toContain('ag-other-home')
    expect(ids).toContain('ag-own-home')
  })

  it('OAuth consent default is unchanged: an unbound agent is NOT consentable', async () => {
    const { env } = setup()
    expect((await listConsentableAgents(env, 'm-admin')).map((a) => a.id)).not.toContain('ag-new-a')
    expect((await listConsentableAgents(env, 'm-admin', false, true)).map((a) => a.id)).toContain('ag-new-a')
  })
})
