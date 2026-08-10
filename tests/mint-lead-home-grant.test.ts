// Regression: an agent holding `lead` (or admin/owner) on its OWN home squad
// must still be mintable — mupot#890.
//
// The bug: prepareAgentBoundTokenMintForBinding filtered the home-grant lookup
// by `AND capability IN ('observer','member')`. Because `capabilities` is
// UNIQUE(member_id, scope_type, scope_id), raising a member's home grant to
// `lead` REPLACES the 'member' row rather than adding one. The SELECT then
// returned nothing and the mint threw `agent_home_capability_missing`, which
// surfaced to MCP callers as a bare `internal_error`.
//
// Impact when found: 22 of 36 active agents held `lead` and could not be
// re-minted at all. Recovery required an operator principal to downgrade the
// capability first, so no agent could self-recover — a fleet-wide lockout.
//
// The fix splits one question into two: the PRECONDITION is "does a home grant
// exist at all" (any capability), and the CLAMP is "what may the token record"
// (never above 'member'). Both are asserted below. If someone reintroduces the
// IN-filter, `mints when the home grant is lead` fails. If someone removes the
// clamp so a token could carry `lead`, `clamps a lead home grant down to member`
// fails. Neither test passes vacuously.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { mintAgentBoundToken } from '../src/members/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const DIR = join(__dirname, '..', 'migrations')

const AGENT = {
  id: 'agent-loom',
  squad_id: 'squad-mmhq',
  slug: 'loom',
  name: 'Loom',
}
const MEMBER = 'member-loom'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(DIR, file), 'utf8'))
  }
}

/** A canonical, already-minted identity: agent + member + binding + home grant. */
function seed(harness: SqliteD1Harness, homeCapability: string): void {
  const s = harness.sqlite
  s.exec(`INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering')`)
  s.exec(
    `INSERT INTO squads (id, department_id, slug, name)
     VALUES ('${AGENT.squad_id}', 'dept-eng', 'mmhq', 'mumega hq'),
            ('squad-elsewhere', 'dept-eng', 'elsewhere', 'Elsewhere')`,
  )
  s.exec(
    `INSERT INTO agents (id, slug, name, status, squad_id)
     VALUES ('${AGENT.id}', '${AGENT.slug}', '${AGENT.name}', 'active', '${AGENT.squad_id}')`,
  )
  s.exec(
    `INSERT INTO members (id, email, display_name, status, created_at, tenant)
     VALUES ('${MEMBER}', NULL, 'Loom', 'active', '2026-08-01T00:00:00.000Z', 'mumega')`,
  )
  s.exec(
    `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
     VALUES ('mumega', '${AGENT.id}', '${MEMBER}', '2026-08-01T00:00:00.000Z')`,
  )
  s.exec(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
     VALUES ('cap-home', '${MEMBER}', 'squad', '${AGENT.squad_id}', '${homeCapability}')`,
  )
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
}

describe('mupot#890 — lead on the home squad must not lock out minting', () => {
  it('mints when the home grant is lead (the lockout case)', async () => {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    seed(h, 'lead')

    const minted = await mintAgentBoundToken(envFor(h), AGENT, 'loom-remint')

    expect(minted.tokenId).toBeTruthy()
    // Canonical identity reused — a lockout workaround that created a second
    // envelope would show a different member id here.
    expect(minted.memberId).toBe(MEMBER)
    expect(minted.bindingDisposition).toBe('reused')
  })

  it('clamps a lead home grant down to member on the token', async () => {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    seed(h, 'lead')

    const minted = await mintAgentBoundToken(envFor(h), AGENT, 'loom-remint')

    // The escalation guard: a token may never carry more than 'member',
    // regardless of how high the member's own home grant is.
    expect(minted.grantCapability).toBe('member')
    expect(['observer', 'member']).toContain(minted.grantCapability)
  })

  it('still records observer when the home grant is observer', async () => {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    seed(h, 'observer')

    const minted = await mintAgentBoundToken(envFor(h), AGENT, 'loom-remint')

    // Pre-existing behaviour preserved: observer is not silently widened.
    expect(minted.grantCapability).toBe('observer')
  })

  it('still refuses when the canonical member has NO home grant', async () => {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    seed(h, 'member')
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${MEMBER}'`)

    await expect(mintAgentBoundToken(envFor(h), AGENT, 'loom-remint')).rejects.toThrow(
      /agent_home_capability_missing/,
    )
  })

  it('a grant on a DIFFERENT squad does not satisfy the home precondition', async () => {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    seed(h, 'member')
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${MEMBER}'`)
    h.sqlite.exec(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-other', '${MEMBER}', 'squad', 'squad-elsewhere', 'lead')`,
    )

    // Dropping the scope_id predicate would make this pass — it must not.
    await expect(mintAgentBoundToken(envFor(h), AGENT, 'loom-remint')).rejects.toThrow(
      /agent_home_capability_missing/,
    )
  })
})
