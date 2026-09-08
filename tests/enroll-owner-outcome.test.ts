// mumega-com#1218 — the OUTCOME, not the intermediate.
//
// The first cut of this fix asserted only that auth.memberId was populated for an
// owner. That is the intermediate. The adversarial gate pointed out the obvious
// question I had not asked: does the PICKER actually populate? Because
// listConsentableAgents (src/mcp/oauth-authorize.ts:456) filters on
//   canOnSquad(env, humanGrants, row.squad_id, 'admin')
// which takes GRANTS, not auth — no legacy-role escape anywhere. So a role-only
// owner, the exact principal this fix was written for, can have a memberId and STILL
// see agents: []. The null just moves one layer down.
//
// These two tests decide it.
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnrollView } from '../src/dashboard/enroll'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const MIGRATIONS = join(__dirname, '..', 'migrations')

function harnessWith(seed: string): SqliteD1Harness {
  const h = createSqliteD1()
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    h.sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1','d','D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq1','d1','s','S');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('ag1','sq1','a1','Agent One','member','test','active');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('m-owner','owner@pot.test','The Owner','active','${TENANT}'),
             ('m-agent','agent@pot.test','Agent Member','active','${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}','ag1','m-agent','2026-01-01T00:00:00.000Z');
    ${seed}
  `)
  return h
}

const ownerAuth = (): AuthContext => ({
  userId: 'u-owner',
  email: 'owner@pot.test',
  role: 'owner',
  tenant: TENANT,
  memberId: 'm-owner',
} as unknown as AuthContext)

describe('#1218 outcome — does the seat picker actually populate for an owner?', () => {
  let h: SqliteD1Harness | undefined
  afterEach(() => { h?.close(); h = undefined })

  it('an owner WITH an org-scope grant row sees the agent', async () => {
    h = harnessWith(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('c-owner','m-owner','org',NULL,'owner');
    `)
    const env = { TENANT_SLUG: TENANT, DB: h.db } as Env
    const view = await loadEnrollView(env, ownerAuth(), {})
    expect(view.memberId).toBe('m-owner')
    expect(view.agents.map((a) => a.id)).toContain('ag1')
  })

  // THE DECIDING CASE. A role-only owner is what src/auth/index.ts's own comment
  // names as the motivating principal ("A role-only owner has NO grant rows").
  // If this is empty, attaching memberId did not fix #1218 for them.
  it('a ROLE-ONLY owner (no capability rows) — this is the case #1218 is about', async () => {
    h = harnessWith('')
    const env = { TENANT_SLUG: TENANT, DB: h.db } as Env
    const view = await loadEnrollView(env, ownerAuth(), {})
    expect(view.memberId).toBe('m-owner')
    // eslint-disable-next-line no-console
    console.log('ROLE-ONLY OWNER agents =', JSON.stringify(view.agents.map((a) => a.id)))
    expect(view.agents.map((a) => a.id)).toContain('ag1')
  })
})
