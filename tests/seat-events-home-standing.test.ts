// Host standing in a member's HOME squad (orca-connection-diagnosis-20261019 §3 step 8).
// A host agent has standing in a home squad ONLY when agents.owner_member_id equals that
// home's owner member. Real SQL against the sqlite D1 harness; every case asserts BOTH
// createSeatEventGrant (JS path, hostHasStandingInSquad) and authorizeSeatDelivery
// (SQL path, HOST_STANDING_SQL) so the two can never diverge (#2040 round-1 BLOCK class).
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { authorizeSeatDelivery, createSeatEventGrant } from '../src/agents/seat-events'

const TENANT = 't1'
const NOW = 1_790_000_000
const HOST = 'orca-hadi-mac'
const SEAT = 'aaaaaaaa-0000-4000-8000-0000000000dd'
const OWNER = 'mem-hadi'

async function pubkey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return jwk.x as string
}

async function world(hostOwnerSql: string, hostExtra = '') {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  // The '' case needs a row FK-orphaned (or a pathological member with id ''), so FK checks are
  // off while seeding only.
  h.sqlite.exec('PRAGMA foreign_keys = OFF')
  const x = await pubkey()
  h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${OWNER}', 'Hadi', 'active', '${TENANT}'),
      ('mem-other', 'Other', 'active', '${TENANT}'),
      ('hostkey-m', 'Host key holder', 'active', '${TENANT}'),
      ('admin', 'Admin', 'active', '${TENANT}');
    INSERT INTO departments (id, slug, name) VALUES ('dw', 'work', 'Work');
    INSERT INTO departments (id, slug, name, kind) VALUES ('dh', 'dept-home-${OWNER}', 'Home', 'home');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sw', 'dw', 'work', 'Work');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sh', 'dh', 'home-mem-hadi', 'Home', 'home');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
      ('${SEAT}', 'sh', 'gaf-claude', 'GAF', 'member', 'm', 'active', NULL),
      ('work-seat', 'sw', 'work-seat', 'WorkSeat', 'member', 'm', 'active', NULL);
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id)
      VALUES ('${HOST}', 'sw', 'orca-hadi-mac', 'Orca', 'member', 'm', 'active', ${hostOwnerSql});
    ${hostExtra}
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
      VALUES ('${TENANT}', '${HOST}', '${x}', 'Ed25519', 'hostkey-m', ${NOW});
  `)
  h.sqlite.exec('PRAGMA foreign_keys = ON')
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  return { h, env }
}

const grant = (env: Env, agent: string, writer = OWNER) =>
  createSeatEventGrant(env, { hostAgentId: HOST, agentId: agent, memberId: writer, reason: 'test' })

/** Insert the grant row directly so the SQL delivery gate can be probed independent of the JS gate. */
function forceGrant(h: Awaited<ReturnType<typeof world>>['h'], agent: string, writer = OWNER) {
  h.sqlite.exec(`INSERT OR IGNORE INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
    VALUES ('g-${agent}', '${TENANT}', '${HOST}', '${agent}', NULL, '${writer}', 'x', '2026-09-27T00:00:00Z')`)
}

async function both(w: Awaited<ReturnType<typeof world>>, agent = SEAT, writer = OWNER) {
  const created = await grant(w.env, agent, writer)
  forceGrant(w.h, agent, writer)
  return { created, delivery: await authorizeSeatDelivery(w.env, HOST, agent) }
}

describe('home-squad host standing (owner_member_id)', () => {
  it('owner match: grant allowed AND delivery granted', async () => {
    const w = await world(`'${OWNER}'`)
    const r = await both(w)
    expect(r.created.ok).toBe(true)
    expect(r.delivery).toBe('granted')
  })

  it('different owner: 403 host_no_squad_standing and delivery not_granted', async () => {
    const w = await world(`'mem-other'`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('NULL owner: refused on both paths', async () => {
    const w = await world('NULL')
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it("'' owner: refused on both paths, even when a pathological '' member + 'dept-home-' home would join", async () => {
    // Without the explicit <> '' clause, owner '' joins member id '' and dept slug 'dept-home-'
    // (SQL '' is not NULL; the JS-truthiness vs SQL-NULL split).
    const w = await world(
      `''`,
      `INSERT INTO members (id, display_name, status, tenant) VALUES ('', 'Empty', 'active', '${TENANT}');
       INSERT INTO departments (id, slug, name, kind) VALUES ('de', 'dept-home-', 'E', 'home');
       INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('se', 'de', 'home-e', 'E', 'home');
       UPDATE agents SET squad_id = 'se' WHERE id = '${SEAT}';`,
    )
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('owner match but a work-kind squad with the same owner slug: no standing', async () => {
    const w = await world(`'${OWNER}'`)
    w.h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('other-work', 'sw', 'ow', 'OW', 'member', 'm', 'active')`)
    // host's own squad is 'sw' (branch 1) so use a fresh work squad the host is not in
    w.h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sw2', 'dw', 'work2', 'W2');
      UPDATE agents SET squad_id = 'sw2' WHERE id = 'other-work'`)
    const r = await both(w, 'other-work')
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('owner match but squad is kind=home inside a NON-home department (slug squat): no standing', async () => {
    const w = await world(`'${OWNER}'`)
    w.h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq', 'dw', 'fake-home', 'F', 'home');
      UPDATE agents SET squad_id = 'sq' WHERE id = '${SEAT}'`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('work-kind squad inside the owner\'s kind=home department: no standing (squad kind is pinned)', async () => {
    const w = await world(`'${OWNER}'`)
    w.h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sx', 'dh', 'extra-work', 'X');
      UPDATE agents SET squad_id = 'sx' WHERE id = '${SEAT}'`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('kind=home squad inside a WORK-kind department slugged dept-home-<owner>: no standing (department kind is pinned)', async () => {
    const w = await world(`'mem-other'`)
    w.h.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('dsq', 'dept-home-mem-other', 'Squat');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('ssq', 'dsq', 'home-sq', 'Sq', 'home');
      UPDATE agents SET squad_id = 'ssq' WHERE id = '${SEAT}'`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('home squad of a DIFFERENT member than the host owner: no standing', async () => {
    const w = await world(`'mem-other'`)
    // host owner is mem-other; home dept slug is dept-home-mem-hadi
    const r = await both(w)
    expect(r.created.ok).toBe(false)
    expect(r.delivery).toBe('not_granted')
  })

  it('archived host agent (archived_at set): refused on both paths', async () => {
    const w = await world(`'${OWNER}'`, `UPDATE agents SET archived_at = datetime('now') WHERE id = '${HOST}';`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('deactivated host agent (status inactive): refused on both paths', async () => {
    const w = await world(`'${OWNER}'`, `UPDATE agents SET status = 'inactive' WHERE id = '${HOST}';`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('archived home squad: refused on both paths', async () => {
    const w = await world(
      `'${OWNER}'`,
      `UPDATE squads SET status = 'archived', archived_at = datetime('now') WHERE id = 'sh';`,
    )
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('inactive owner member: refused on both paths', async () => {
    const w = await world(`'${OWNER}'`, `UPDATE members SET status = 'suspended' WHERE id = '${OWNER}';`)
    const r = await both(w)
    expect(r.created.ok).toBe(false)
    expect(r.delivery).toBe('not_granted')
  })

  it('standing is revalidated per delivery: clearing owner_member_id after the grant revokes delivery', async () => {
    const w = await world(`'${OWNER}'`)
    const r = await both(w)
    expect(r.delivery).toBe('granted')
    w.h.sqlite.exec(`UPDATE agents SET owner_member_id = NULL WHERE id = '${HOST}'`)
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('non-home squad behavior unchanged: host registered in the target squad is still allowed (no owner needed)', async () => {
    const w = await world('NULL')
    const r = await both(w, 'work-seat')
    expect(r.created.ok).toBe(true)
    expect(r.delivery).toBe('granted')
  })

  it('org-admin writer who is not the home owner: refused at grant time and a pre-existing row is not delivered', async () => {
    // Host owner IS the home owner (re-pointed by an admin), but the writer is 'admin'.
    const w = await world(`'${OWNER}'`)
    const r = await both(w, SEAT, 'admin')
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('pre-existing grant row written by a non-owner is not delivered (per-delivery writer pin)', async () => {
    const w = await world(`'${OWNER}'`)
    forceGrant(w.h, SEAT, 'mem-other')
    expect(await authorizeSeatDelivery(w.env, HOST, SEAT)).toBe('not_granted')
  })

  it('a DIFFERENT agent owned by the home owner does not give an unowned host standing (ho.id is pinned)', async () => {
    const w = await world('NULL', `INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id)
      VALUES ('other-owned', 'sw', 'oo', 'OO', 'member', 'm', 'active', '${OWNER}');`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })

  it('owner member row in another tenant: refused on both paths (om.tenant is pinned)', async () => {
    const w = await world(`'${OWNER}'`, `UPDATE members SET tenant = 'other-tenant' WHERE id = '${OWNER}';`)
    const r = await both(w)
    expect(r.created).toEqual({ ok: false, reason: 'host_no_squad_standing' })
    expect(r.delivery).toBe('not_granted')
  })
})
