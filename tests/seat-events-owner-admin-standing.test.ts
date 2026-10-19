// Host standing via OWNER ADMIN rank (ownerAdminStandingSql): a host agent whose
// agents.owner_member_id currently holds rank >= admin on the target squad (or is org
// owner/admin) may wake a seat in that NON-home squad, when the grant's writer IS the owner.
// Real SQL on the sqlite D1 harness; every case asserts BOTH createSeatEventGrant (JS path)
// and authorizeSeatDelivery (SQL path). The host identity is built the production way:
// prepareAgentIdentityWeldStatements (member + binding + capability) then registerAgentPublicKey.
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { authorizeSeatDelivery, createSeatEventGrant } from '../src/agents/seat-events'
import { prepareAgentIdentityWeldStatements } from '../src/members/service'
import { registerAgentPublicKey } from '../src/fleet/agent-keys'

const TENANT = 't1'
const HOST = 'orca-hadi-mac'
const SEAT = 'aaaaaaaa-0000-4000-8000-0000000000dd' // gaf-codex stand-in, in the NON-home squad sg
const OWNER = 'mem-hadi'

async function pubkey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return jwk.x as string
}

/** ownerSql: SQL literal for the host's owner_member_id. ownerCap: owner's capability on sg (or null). */
async function world(opts: { ownerSql?: string; ownerCap?: string | null; extra?: string } = {}) {
  const ownerSql = opts.ownerSql ?? `'${OWNER}'`
  const ownerCap = opts.ownerCap === undefined ? 'admin' : opts.ownerCap
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${OWNER}', 'Hadi', 'active', '${TENANT}'),
      ('mem-other', 'Other', 'active', '${TENANT}');
    INSERT INTO departments (id, slug, name) VALUES ('dw', 'work', 'Work'), ('dg', 'gaf', 'GAF');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sw', 'dw', 'work', 'Work'), ('sg', 'dg', 'gaf', 'GAF');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
      ('${SEAT}', 'sg', 'gaf-codex', 'GAF Codex', 'member', 'm', 'active', NULL),
      ('work-seat', 'sw', 'work-seat', 'WorkSeat', 'member', 'm', 'active', NULL),
      ('${HOST}', 'sw', 'orca-hadi-mac', 'Orca', 'member', 'm', 'active', NULL);
  `)
  // Production host identity: weld (member + binding + capability), then register the key.
  await h.db.batch(prepareAgentIdentityWeldStatements(
    env, { id: HOST, squad_id: 'sw', slug: 'orca-hadi-mac', name: 'Orca' }, 'hostkey-m', '2026-09-27T00:00:00Z', 'member'))
  const reg = await registerAgentPublicKey(env, HOST, HOST, await pubkey())
  expect(reg.ok).toBe(true)
  // The host agent is the squad-sw member: it must NOT have standing in sg via the member ladder.
  h.sqlite.exec('PRAGMA foreign_keys = OFF') // only so the pathological '' owner can be seeded
  h.sqlite.exec(`UPDATE agents SET owner_member_id = ${ownerSql} WHERE id = '${HOST}';`)
  if (ownerCap) {
    const who = ownerSql === "''" ? '' : OWNER
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-owner', '${who}', 'squad', 'sg', '${ownerCap}')`)
  }
  if (opts.extra) h.sqlite.exec(opts.extra)
  h.sqlite.exec('PRAGMA foreign_keys = ON')
  return { h, env }
}
type W = Awaited<ReturnType<typeof world>>

const grant = (env: Env, agent: string, writer: string) =>
  createSeatEventGrant(env, { hostAgentId: HOST, agentId: agent, memberId: writer, reason: 'test' })

function forceGrant(h: W['h'], agent: string, writer: string) {
  h.sqlite.exec(`INSERT OR IGNORE INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
    VALUES ('g-${agent}', '${TENANT}', '${HOST}', '${agent}', NULL, '${writer}', 'x', '2026-09-27T00:00:00Z')`)
}

async function both(w: W, agent = SEAT, writer = OWNER) {
  const created = await grant(w.env, agent, writer)
  forceGrant(w.h, agent, writer)
  return { created, delivery: await authorizeSeatDelivery(w.env, HOST, agent) }
}
const DENIED = { ok: false, reason: 'host_no_squad_standing' }

describe('owner-admin host standing', () => {
  it('owner is admin on the squad, writer is owner: grant allowed AND delivery granted', async () => {
    const r = await both(await world())
    expect(r.created.ok).toBe(true)
    expect(r.delivery).toBe('granted')
  })

  it('owner is org admin via a live org capability: allowed on both paths', async () => {
    const w = await world({
      ownerCap: null,
      extra: `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', '${OWNER}', 'org', NULL, 'admin')`,
    })
    const r = await both(w)
    expect(r.created.ok).toBe(true)
    expect(r.delivery).toBe('granted')
  })

  it('owner is only a member of the squad: refused on both paths', async () => {
    const r = await both(await world({ ownerCap: 'member' }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('owner holds no capability on the squad: refused on both paths', async () => {
    const r = await both(await world({ ownerCap: null }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('writer is not the owner (an admin writing under a re-pointed host): refused on both paths', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-w', 'mem-other', 'squad', 'sg', 'admin')`)
    const r = await both(w, SEAT, 'mem-other')
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('pre-existing grant row written by a non-owner is not delivered (per-delivery writer pin)', async () => {
    const w = await world()
    forceGrant(w.h, SEAT, 'mem-other')
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('NULL owner: refused on both paths, even if the writer holds admin', async () => {
    const w = await world({ ownerSql: 'NULL', ownerCap: null })
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-w', '${OWNER}', 'squad', 'sg', 'admin')`)
    const r = await both(w)
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it("'' owner: refused on both paths even with a pathological '' member holding admin and writing the grant", async () => {
    const w = await world({
      ownerSql: "''",
      extra: `INSERT INTO members (id, display_name, status, tenant) VALUES ('', 'Empty', 'active', '${TENANT}')`,
    })
    const r = await both(w, SEAT, '')
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('owner demoted after the grant: delivery refused', async () => {
    const w = await world()
    const r = await both(w)
    expect(r.delivery).toBe('granted')
    w.h.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-owner'`)
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('owner capability expired after the grant: delivery refused', async () => {
    const w = await world()
    await both(w)
    w.h.sqlite.exec(`UPDATE capabilities SET expires_at = '2000-01-01T00:00:00Z' WHERE id = 'cap-owner'`)
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('owner_member_id cleared after the grant: delivery refused', async () => {
    const w = await world()
    await both(w)
    w.h.sqlite.exec(`UPDATE agents SET owner_member_id = NULL WHERE id = '${HOST}'`)
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('archived host: refused on both paths', async () => {
    const r = await both(await world({ extra: `UPDATE agents SET archived_at = datetime('now') WHERE id = '${HOST}'` }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('inactive host: refused on both paths', async () => {
    const r = await both(await world({ extra: `UPDATE agents SET status = 'inactive' WHERE id = '${HOST}'` }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('inactive owner member: refused on both paths', async () => {
    const r = await both(await world({ extra: `UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'` }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('owner member in another tenant: refused on both paths (tenant pinned)', async () => {
    const r = await both(await world({ extra: `UPDATE members SET tenant = 'other' WHERE id = '${OWNER}'` }))
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('a DIFFERENT agent owned by the admin does not give an unowned host standing (host id pinned)', async () => {
    const w = await world({
      ownerSql: 'NULL',
      ownerCap: null,
      extra: `INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id)
        VALUES ('other-owned', 'sw', 'oo', 'OO', 'member', 'm', 'active', '${OWNER}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', '${OWNER}', 'squad', 'sg', 'admin')`,
    })
    const r = await both(w)
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('admin on an UNRELATED squad confers nothing on sg', async () => {
    const w = await world({
      ownerCap: null,
      extra: `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-sw', '${OWNER}', 'squad', 'sw', 'admin')`,
    })
    const r = await both(w)
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })

  it('same-squad behaviour unchanged: host registered in the target squad needs no owner', async () => {
    const r = await both(await world({ ownerSql: 'NULL', ownerCap: null }), 'work-seat')
    expect(r.created.ok).toBe(true)
    expect(r.delivery).toBe('granted')
  })

  it('owner admin does NOT widen home squads: no home standing for an admin-owner via this branch', async () => {
    const w = await world({
      extra: `INSERT INTO departments (id, slug, name, kind) VALUES ('dh', 'dept-home-mem-other', 'Home', 'home');
        INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sh', 'dh', 'home-other', 'H', 'home');
        INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('home-seat', 'sh', 'hs', 'HS', 'member', 'm', 'active');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', '${OWNER}', 'org', NULL, 'admin')`,
    })
    // Owner is org admin, but a home squad of someone else is never reachable by the ladder.
    const r = await both(w, 'home-seat')
    expect(r.created).toEqual(DENIED)
    expect(r.delivery).toBe('not_granted')
  })
})
