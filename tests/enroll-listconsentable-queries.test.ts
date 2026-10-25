// /enroll latency: listConsentableAgents used to issue ~3+ serial D1 round trips PER AGENT
// (loadSquadScope, canOnSquad, resolveConsentedAgentCapabilities). This file pins
//  (1) the query count no longer grows with the agent count, and
//  (2) the exact admitted list + capabilities + order, so the batching cannot change who is admitted.
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listConsentableAgents } from '../src/mcp/oauth-authorize'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const MIGRATIONS = join(__dirname, '..', 'migrations')

function build(extraAgents: number): SqliteD1Harness {
  const h = createSqliteD1()
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    h.sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1','d1','Alpha'),('d2','d2','Beta');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('sqA','d1','sa','SqA','work'),('sqB','d1','sb','SqB','work'),
      ('sqC','d2','sc','SqC','work'),('sqH','d2','sh','Home','home');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-org','org@t','Org','active','${TENANT}'),
      ('m-sqadm','sq@t','SqAdm','active','${TENANT}'),
      ('m-plain','pl@t','Plain','active','${TENANT}'),
      ('m-off','off@t','Off','suspended','${TENANT}'),
      ('m-a1','a1@t','A1','active','${TENANT}'),('m-a2','a2@t','A2','active','${TENANT}'),
      ('m-a3','a3@t','A3','active','${TENANT}'),('m-a4','a4@t','A4','active','${TENANT}'),
      ('m-a5','a5@t','A5','active','${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('a1','sqA','a1','Agent 1','member','t','active'),
      ('a2','sqB','a2','Agent 2','member','t','active'),
      ('a3','sqC','a3','Agent 3','member','t','active'),
      ('a4','sqH','a4','Home agent','member','t','active'),
      ('a5','sqA','a5','Paused','member','t','paused'),
      ('a6','sqA','a6','Unbound','member','t','active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}','a1','m-a1','2026-01-01T00:00:00.000Z'),
      ('${TENANT}','a2','m-a2','2026-01-01T00:00:00.000Z'),
      ('${TENANT}','a3','m-a3','2026-01-01T00:00:00.000Z'),
      ('${TENANT}','a4','m-a4','2026-01-01T00:00:00.000Z'),
      ('${TENANT}','a5','m-a5','2026-01-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1','m-org','org',NULL,'owner'),
      ('c2','m-sqadm','squad','sqA','admin'),
      ('c3','m-plain','squad','sqA','member'),
      ('c4','m-off','squad','sqA','admin'),
      ('g1','m-a1','squad','sqA','admin'),
      ('g2','m-a1','org',NULL,'lead'),
      ('g3','m-a2','squad','sqB','member'),
      ('g4','m-a3','department','d2','admin'),
      ('g5','m-a4','squad','sqH','admin'),
      ('g6','m-a5','squad','sqA','admin');
  `)
  for (let i = 0; i < extraAgents; i++) {
    const sq = ['sqA', 'sqB', 'sqC'][i % 3]
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-x${i}','x${i}@t','X${i}','active','${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('x${i}','${sq}','x${i}','Extra ${i}','member','t','active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}','x${i}','m-x${i}','2026-01-01T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('gx${i}','m-x${i}','squad','${sq}','admin');
    `)
  }
  return h
}

function counted(h: SqliteD1Harness): { env: Env; count: () => number } {
  let n = 0
  const db = h.db
  const wrapped = new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'prepare') return (sql: string) => { n++; return (v as (s: string) => unknown).call(target, sql) }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { env: { TENANT_SLUG: TENANT, DB: wrapped } as Env, count: () => n }
}

const summarize = (rows: Awaited<ReturnType<typeof listConsentableAgents>>) =>
  rows.map((r) => `${r.id}|${r.squad_id}|` + r.capabilities.map((c) => `${c.scope_type}:${c.scope_id}:${c.capability}`).join(','))

describe('listConsentableAgents query count and semantics', () => {
  let h: SqliteD1Harness | undefined
  afterEach(() => { h?.close(); h = undefined })

  it('query count does not grow with agent count (org admin, 60 agents)', async () => {
    h = build(60)
    const { env, count } = counted(h)
    const out = await listConsentableAgents(env, 'm-org', true, true)
    expect(out.length).toBeGreaterThan(60)
    expect(count()).toBeLessThanOrEqual(15)
  })

  it('pins admitted agents, order, and clamped capabilities for a mixed fixture', async () => {
    h = build(0)
    const { env } = counted(h)
    const run = async (m: string, orgWide: boolean, unbound: boolean) => summarize(await listConsentableAgents(env, m, orgWide, unbound))
    // org admin by grant (orgWide flag false): every non-home squad; home squad excluded; paused agent excluded.
    expect(await run('m-org', false, false)).toMatchInlineSnapshot(`
      [
        "a1|sqA|squad:sqA:admin,org:null:lead",
        "a2|sqB|squad:sqB:member",
        "a3|sqC|department:d2:admin",
      ]
    `)
    // org admin via legacy-role flag, includeUnbound lists a6 too.
    expect(await run('m-org', true, true)).toMatchInlineSnapshot(`
      [
        "a1|sqA|squad:sqA:admin,org:null:lead",
        "a6|sqA|",
        "a2|sqB|squad:sqB:member",
        "a3|sqC|department:d2:admin",
      ]
    `)
    expect(await run('m-sqadm', false, false)).toMatchInlineSnapshot(`
      [
        "a1|sqA|squad:sqA:admin",
      ]
    `)
    expect(await run('m-sqadm', false, true)).toMatchInlineSnapshot(`
      [
        "a1|sqA|squad:sqA:admin",
        "a6|sqA|",
      ]
    `)
    expect(await run('m-plain', false, true)).toMatchInlineSnapshot(`[]`)
    // offboarded human: still has a grant row, capabilities must come back empty per agent.
    expect(await run('m-off', false, false)).toMatchInlineSnapshot(`
      [
        "a1|sqA|",
      ]
    `)
    expect(await run('m-nobody', false, false)).toMatchInlineSnapshot(`[]`)
    // legacy-role admin flag with no grants.
    expect(await run('m-nobody', true, true)).toMatchInlineSnapshot(`
      [
        "a1|sqA|",
        "a6|sqA|",
        "a2|sqB|",
        "a3|sqC|",
      ]
    `)
  })
})
