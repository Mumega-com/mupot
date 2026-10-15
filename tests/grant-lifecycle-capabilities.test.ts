// tests/grant-lifecycle-capabilities.test.ts — migration 0228.
//
// ISO 27001 A.5.18 / SOC 2 CC6.2-6.3: a standing capability grant has a lifecycle —
// it can expire, it records who granted it / through what / why, and its history
// (grant and revoke) survives the hard DELETE.
//
// NO MOCKS — triggers and predicates are SQL semantics a DB mock cannot see
// (mupot#684). The schema is built FROM THE COMMITTED MIGRATIONS and the real
// exported functions run against it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  brandSquadScope,
  currentMemberRankAtLeastSql,
  hasCapability,
  nowCapabilitySql,
  resolveCapabilities,
} from '../src/auth/capability'
import { revokeContextStatements } from '../src/auth/grant-events'
import { humanGateHolderExistsSql } from '../src/tasks/runtime-receipts'
import {
  commitRemoveAgentSquadAccess,
  removeAgentSquadAccess,
  setAgentSquadAccess,
} from '../src/members/agent-access'
import { upsertCapabilityGrant } from '../src/members/service'
import type { Env } from '../src/types'

const TENANT = 'tenant-lifecycle'
const MEMBER = 'member-1'
const ADMIN = 'member-admin'
const SQUAD = 'squad-a'
const DEPT = 'dept-1'
const PAST = '2020-01-01 00:00:00'
const FUTURE = '2099-01-01 00:00:00'

interface EventRow {
  grant_table: string
  grant_id: string
  event: string
  actor: string | null
  reason: string | null
  tenant: string
  snapshot_json: string
}

describe('migration 0228 — capability grant lifecycle', () => {
  let h: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT}', 'eng', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('${SQUAD}', '${DEPT}', 'a', 'A'), ('squad-b', '${DEPT}', 'b', 'B');
      INSERT INTO members (id, tenant, display_name, status, created_at) VALUES
        ('${MEMBER}', '${TENANT}', 'One', 'active', datetime('now')),
        ('${ADMIN}', '${TENANT}', 'Admin', 'active', datetime('now'));
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  const scope = brandSquadScope({ id: SQUAD, department_id: DEPT, kind: 'work' })

  function events(): EventRow[] {
    return h.sqlite.prepare('SELECT * FROM grant_events ORDER BY rowid').all() as unknown as EventRow[]
  }

  function insertGrant(
    id: string,
    over: Partial<{
      scopeType: string
      scopeId: string | null
      capability: string
      expiresAt: string | null
      grantedBy: string | null
      grantedVia: string | null
      reason: string | null
    }> = {},
  ): void {
    h.sqlite
      .prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at, granted_by, granted_via, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, MEMBER, over.scopeType ?? 'squad', over.scopeId === undefined ? SQUAD : over.scopeId,
        over.capability ?? 'lead', over.expiresAt ?? null, over.grantedBy ?? null,
        over.grantedVia ?? null, over.reason ?? null,
      )
  }

  // ── schema ──────────────────────────────────────────────────────────────────

  it('adds the four additive columns, all NULLable, and backfills nothing', () => {
    const cols = h.sqlite.prepare('PRAGMA table_info(capabilities)').all() as Array<{ name: string; notnull: number }>
    for (const name of ['expires_at', 'reason', 'granted_by', 'granted_via']) {
      const col = cols.find((c) => c.name === name)
      expect(col, name).toBeDefined()
      expect(col?.notnull, name).toBe(0)
    }
  })

  // ── an expired grant has no authority, before any sweeper ───────────────────

  describe('an expired grant gives no authority (no sweeper involved)', () => {
    it('resolveCapabilities', async () => {
      insertGrant('dead', { expiresAt: PAST })
      expect(await resolveCapabilities(env, MEMBER)).toHaveLength(0)
      insertGrant('live', { scopeId: 'squad-b', expiresAt: FUTURE })
      const grants = await resolveCapabilities(env, MEMBER)
      expect(grants).toHaveLength(1)
      expect(hasCapability(grants, 'squad', scope, 'lead')).toBe(false)
    })

    const rankProbe = (
      scopeType: 'org' | 'department' | 'squad',
      scopeId: string | null,
      required: number,
    ): boolean => {
      const sql = currentMemberRankAtLeastSql(scopeType, {
        inviterIdParam: '?1', scopeIdParam: '?2', requiredRankParam: '?3', nowParam: '?4',
      })
      const row = h.sqlite
        .prepare(`SELECT ${sql} AS ok`)
        .get(MEMBER, scopeId, required, nowCapabilitySql()) as { ok: number }
      return row.ok === 1
    }

    it('currentMemberRankAtLeastSql — org, department and squad rungs', () => {
      // member-1 has no legacy users row, so only the grants decide.
      insertGrant('org-dead', { scopeType: 'org', scopeId: null, capability: 'admin', expiresAt: PAST })
      insertGrant('dept-dead', { scopeType: 'department', scopeId: DEPT, capability: 'admin', expiresAt: PAST })
      insertGrant('squad-dead', { capability: 'admin', expiresAt: PAST })
      expect(rankProbe('org', null, 3)).toBe(false)
      expect(rankProbe('department', DEPT, 3)).toBe(false)
      expect(rankProbe('squad', SQUAD, 3)).toBe(false)
      // the very same rows, un-expired, DO confer the rank — so the false above is the predicate, not the probe.
      h.sqlite.exec(`UPDATE capabilities SET expires_at = NULL`)
      expect(rankProbe('org', null, 3)).toBe(true)
      expect(rankProbe('department', DEPT, 3)).toBe(true)
      expect(rankProbe('squad', SQUAD, 3)).toBe(true)
    })

    it('humanGateHolderExistsSql — a gate holder whose squad standing lapsed is not a holder', () => {
      h.sqlite.exec(`
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('gg', 'gate:review', 'member', '${MEMBER}', '${ADMIN}', datetime('now'));
        INSERT INTO agents (id, squad_id, slug, name, role, model, status)
        VALUES ('assignee', '${SQUAD}', 'asg', 'Assignee', 'member', 't', 'active');
      `)
      const probe = (): boolean => {
        const sql = humanGateHolderExistsSql({
          gateOwnerExpr: "'gate:review'", assigneeIdExpr: "'assignee'", squadIdExpr: `'${SQUAD}'`,
          tenantParam: `'${TENANT}'`, nowParam: `'${nowCapabilitySql()}'`,
        })
        return (h.sqlite.prepare(`SELECT ${sql} AS ok`).get() as { ok: number }).ok === 1
      }
      insertGrant('standing', { capability: 'member', expiresAt: PAST })
      expect(probe()).toBe(false)
      h.sqlite.exec(`UPDATE capabilities SET expires_at = NULL`)
      expect(probe()).toBe(true)
    })
  })

  it('LEGACY: a NULL-expiry grant with no provenance resolves exactly as before', async () => {
    insertGrant('legacy', { capability: 'lead' })
    const row = h.sqlite.prepare("SELECT expires_at, reason, granted_by, granted_via FROM capabilities WHERE id = 'legacy'").get()
    expect(row).toEqual({ expires_at: null, reason: null, granted_by: null, granted_via: null })
    expect(hasCapability(await resolveCapabilities(env, MEMBER), 'squad', scope, 'lead')).toBe(true)
  })

  // ── history: written by trigger, in the change's own transaction ────────────

  describe('grant_events', () => {
    it('INSERT writes a granted event from the row’s own provenance', () => {
      insertGrant('g1', { grantedBy: ADMIN, grantedVia: 'dashboard', reason: 'on-call', expiresAt: FUTURE })
      const [e] = events()
      expect(events()).toHaveLength(1)
      expect(e).toMatchObject({
        grant_table: 'capabilities', grant_id: 'g1', event: 'granted',
        actor: ADMIN, reason: 'on-call', tenant: TENANT,
      })
      expect(JSON.parse(e!.snapshot_json)).toMatchObject({
        id: 'g1', member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD,
        capability: 'lead', expires_at: FUTURE, granted_via: 'dashboard',
      })
    })

    it('a legacy-shaped INSERT (no provenance) is still recorded, with a NULL actor', () => {
      insertGrant('g1')
      expect(events()).toMatchObject([{ event: 'granted', actor: null, reason: null }])
    })

    it('an upsert that changes the capability, horizon or provenance writes another granted event', () => {
      insertGrant('g1', { capability: 'member', grantedBy: ADMIN, grantedVia: 'mcp' })
      h.sqlite.exec(`UPDATE capabilities SET capability = 'admin' WHERE id = 'g1'`)
      h.sqlite.exec(`UPDATE capabilities SET expires_at = '${FUTURE}' WHERE id = 'g1'`)
      h.sqlite.exec(`UPDATE capabilities SET granted_by = 'someone-else' WHERE id = 'g1'`)
      expect(events().map((e) => e.event)).toEqual(['granted', 'granted', 'granted', 'granted'])
      expect(JSON.parse(events()[1]!.snapshot_json)).toMatchObject({ capability: 'admin', previous_capability: 'member' })
    })

    it('a no-op re-grant (same capability, horizon and provenance) is silent', () => {
      insertGrant('g1', { grantedBy: ADMIN, grantedVia: 'mcp' })
      h.sqlite.exec(`UPDATE capabilities SET capability = capability, provisional_door_id = NULL WHERE id = 'g1'`)
      expect(events()).toHaveLength(1)
    })

    it('an INSERT OR IGNORE that wrote no row writes no event', () => {
      insertGrant('g1')
      h.sqlite
        .prepare(
          `INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
           VALUES ('dup', ?, 'squad', ?, 'admin')`,
        )
        .run(MEMBER, SQUAD)
      expect(events()).toHaveLength(1)
    })

    it('a DELETE writes a revoked event attributed through the revoke context', async () => {
      insertGrant('g1', { grantedBy: ADMIN, grantedVia: 'mcp' })
      const [setCtx, clearCtx] = revokeContextStatements(env, { grantedBy: 'revoker-1', reason: 'left the team' })
      await env.DB.batch([
        setCtx,
        env.DB.prepare('DELETE FROM capabilities WHERE id = ?').bind('g1'),
        clearCtx,
      ])
      const revoked = events().filter((e) => e.event === 'revoked')
      expect(revoked).toHaveLength(1)
      expect(revoked[0]).toMatchObject({ grant_id: 'g1', actor: 'revoker-1', reason: 'left the team', tenant: TENANT })
      expect(JSON.parse(revoked[0]!.snapshot_json)).toMatchObject({ id: 'g1', capability: 'lead', granted_by: ADMIN })
      // the live table kept hard-DELETE semantics, and the context did not linger.
      expect(h.sqlite.prepare("SELECT COUNT(*) n FROM capabilities WHERE id = 'g1'").get()).toEqual({ n: 0 })
      expect(h.sqlite.prepare('SELECT COUNT(*) n FROM grant_event_context').get()).toEqual({ n: 0 })
    })

    it('a DELETE with no context is still recorded, with a NULL actor', () => {
      insertGrant('g1')
      h.sqlite.exec("DELETE FROM capabilities WHERE id = 'g1'")
      expect(events().filter((e) => e.event === 'revoked')).toMatchObject([{ grant_id: 'g1', actor: null }])
    })

    it('a context older than 60 seconds is ignored (cannot mis-attribute a later revoke)', () => {
      insertGrant('g1')
      h.sqlite
        .prepare(
          `INSERT INTO grant_event_context (id, tenant, actor, reason, event, at)
           VALUES (1, ?, 'stale-actor', 'stale', 'expired', ?)`,
        )
        .run(TENANT, new Date(Date.now() - 10 * 60_000).toISOString())
      h.sqlite.exec("DELETE FROM capabilities WHERE id = 'g1'")
      expect(events().filter((e) => e.event !== 'granted')).toMatchObject([
        { event: 'revoked', actor: null, reason: null },
      ])
    })

    it('a fresh context can mark the end as expired (the sweeper’s path)', async () => {
      insertGrant('g1')
      const [setCtx, clearCtx] = revokeContextStatements(env, { grantedBy: 'system:sweeper', reason: 'expired' }, 'expired')
      await env.DB.batch([setCtx, env.DB.prepare('DELETE FROM capabilities WHERE id = ?').bind('g1'), clearCtx])
      expect(events().filter((e) => e.event === 'expired')).toMatchObject([{ grant_id: 'g1', actor: 'system:sweeper' }])
    })

    it('a failed revoke batch rolls back WITH its event — no orphan', async () => {
      insertGrant('g1')
      const [setCtx, clearCtx] = revokeContextStatements(env, { grantedBy: 'revoker-1', reason: 'x' })
      await expect(
        env.DB.batch([
          setCtx,
          env.DB.prepare('DELETE FROM capabilities WHERE id = ?').bind('g1'),
          clearCtx,
          env.DB.prepare('INSERT INTO capabilities (id) VALUES (NULL)'), // NOT NULL violation: throws
        ]),
      ).rejects.toThrow()
      expect(h.sqlite.prepare("SELECT COUNT(*) n FROM capabilities WHERE id = 'g1'").get()).toEqual({ n: 1 })
      expect(events().map((e) => e.event)).toEqual(['granted'])
      expect(h.sqlite.prepare('SELECT COUNT(*) n FROM grant_event_context').get()).toEqual({ n: 0 })
    })

    it('a DELETE that matches nothing writes no event', () => {
      h.sqlite.exec("DELETE FROM capabilities WHERE id = 'never-existed'")
      expect(events()).toHaveLength(0)
    })

    it('the members ON DELETE CASCADE is recorded too (no writer to forget it)', () => {
      insertGrant('g1')
      h.sqlite.exec(`DELETE FROM members WHERE id = '${MEMBER}'`)
      expect(events().map((e) => e.event)).toEqual(['granted', 'revoked'])
      expect(events()[1]).toMatchObject({ grant_id: 'g1', tenant: TENANT })
    })

    it('the event table is append-only: UPDATE and DELETE are refused', () => {
      insertGrant('g1')
      expect(() => h.sqlite.exec("UPDATE grant_events SET actor = 'forged'")).toThrow(/append-only/)
      expect(() => h.sqlite.exec('DELETE FROM grant_events')).toThrow(/append-only/)
      expect(events()).toHaveLength(1)
    })

    it('grant_events rejects an unknown table or event kind', () => {
      const bad = (table: string, event: string): void => {
        h.sqlite
          .prepare(
            `INSERT INTO grant_events (id, tenant, grant_table, grant_id, event, at, snapshot_json)
             VALUES (lower(hex(randomblob(8))), 't', ?, 'x', ?, datetime('now'), '{}')`,
          )
          .run(table, event)
      }
      expect(() => bad('members', 'granted')).toThrow()
      expect(() => bad('capabilities', 'deleted')).toThrow()
      expect(() => bad('gate_grants', 'reviewed')).not.toThrow()
    })
  })

  // ── writers record provenance, and a revoke is attributable ─────────────────

  describe('writers', () => {
    const AGENT = 'agent-1'
    const AGENT_MEMBER = 'member-agent'

    function seedAgent(): void {
      h.sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name, role, model, status)
          VALUES ('${AGENT}', 'squad-b', 'agent', 'Agent', 'member', 'test', 'active');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-home', '${AGENT}', 'squad-b', 'member');
        INSERT INTO members (id, display_name, status, tenant) VALUES ('${AGENT_MEMBER}', 'Agent Member', 'active', '${TENANT}');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
          VALUES ('${TENANT}', '${AGENT}', '${AGENT_MEMBER}', datetime('now'));
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, granted_via)
          VALUES ('home-grant', '${AGENT_MEMBER}', 'squad', 'squad-b', 'member', 'token_mint');
      `)
    }

    const agentGrant = (): Record<string, unknown> | undefined =>
      h.sqlite
        .prepare(
          `SELECT capability, expires_at, granted_by, granted_via, reason FROM capabilities
            WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
        )
        .get(AGENT_MEMBER, SQUAD) as Record<string, unknown> | undefined

    it('setAgentSquadAccess records granted_by, granted_via, reason and the elevation horizon', async () => {
      seedAgent()
      const out = await setAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, capability: 'lead',
        expiresAt: FUTURE,
        provenance: { grantedBy: ADMIN, grantedVia: 'elevation', reason: 'elevation e-1' },
      })
      expect(out.ok).toBe(true)
      expect(agentGrant()).toEqual({
        capability: 'lead', expires_at: FUTURE, granted_by: ADMIN, granted_via: 'elevation', reason: 'elevation e-1',
      })
      const ev = events().filter((e) => e.grant_table === 'capabilities' && JSON.parse(e.snapshot_json).scope_id === SQUAD)
      expect(ev).toMatchObject([{ event: 'granted', actor: ADMIN, reason: 'elevation e-1' }])
    })

    it('a re-grant by another actor re-attributes the row and logs it', async () => {
      seedAgent()
      await setAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, capability: 'member',
        provenance: { grantedBy: ADMIN, grantedVia: 'mcp' },
      })
      await setAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, capability: 'lead',
        provenance: { grantedBy: 'second-admin', grantedVia: 'dashboard', reason: 'promoted' },
      })
      expect(agentGrant()).toMatchObject({ capability: 'lead', granted_by: 'second-admin', granted_via: 'dashboard', reason: 'promoted' })
      const ev = events().filter((e) => JSON.parse(e.snapshot_json).scope_id === SQUAD)
      expect(ev.map((e) => [e.event, e.actor])).toEqual([['granted', ADMIN], ['granted', 'second-admin']])
    })

    it('removeAgentSquadAccess records WHO revoked, in the same batch as the DELETE', async () => {
      seedAgent()
      await setAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, capability: 'lead',
        provenance: { grantedBy: ADMIN, grantedVia: 'mcp' },
      })
      const out = await removeAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD,
        provenance: { grantedBy: 'revoking-admin', reason: 'project ended' },
      })
      expect(out.ok).toBe(true)
      expect(agentGrant()).toBeUndefined()
      const revoked = events().filter((e) => e.event === 'revoked')
      expect(revoked).toMatchObject([{ actor: 'revoking-admin', reason: 'project ended' }])
      expect(h.sqlite.prepare('SELECT COUNT(*) n FROM grant_event_context').get()).toEqual({ n: 0 })
    })

    it('a revoke whose receipt hook throws leaves the grant AND no revoke event', async () => {
      seedAgent()
      await setAgentSquadAccess(env, {
        agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, capability: 'lead',
        provenance: { grantedBy: ADMIN, grantedVia: 'mcp' },
      })
      await expect(
        commitRemoveAgentSquadAccess(
          env,
          { agentId: AGENT, memberId: AGENT_MEMBER, squadId: SQUAD, provenance: { grantedBy: 'r', reason: null } },
          () => [env.DB.prepare('INSERT INTO capabilities (id) VALUES (NULL)')], // throws inside the batch
        ),
      ).rejects.toThrow()
      expect(agentGrant()).toMatchObject({ capability: 'lead' })
      expect(events().filter((e) => e.event === 'revoked')).toHaveLength(0)
    })

    it('upsertCapabilityGrant stamps the new row and attributes the replaced one', async () => {
      await upsertCapabilityGrant(env, { member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' },
        { grantedBy: ADMIN, grantedVia: 'http', reason: 'first' })
      await upsertCapabilityGrant(env, { member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'lead' },
        { grantedBy: 'admin-2', grantedVia: 'http', reason: 'second' })
      const row = h.sqlite
        .prepare("SELECT capability, granted_by, granted_via, reason FROM capabilities WHERE member_id = ? AND scope_id = ?")
        .get(MEMBER, SQUAD)
      expect(row).toEqual({ capability: 'lead', granted_by: 'admin-2', granted_via: 'http', reason: 'second' })
      expect(events().map((e) => [e.event, e.actor])).toEqual([
        ['granted', ADMIN],
        ['revoked', 'admin-2'],
        ['granted', 'admin-2'],
      ])
    })
  })

  // ── the rank ceiling is unchanged for live grants ───────────────────────────

  it('RANK CEILING UNCHANGED: a live grant still confers exactly its own rank, no more', () => {
    insertGrant('member-grant', { capability: 'member', expiresAt: FUTURE })
    const probe = (required: number): boolean => {
      const sql = currentMemberRankAtLeastSql('squad', {
        inviterIdParam: '?1', scopeIdParam: '?2', requiredRankParam: '?3', nowParam: '?4',
      })
      return (h.sqlite.prepare(`SELECT ${sql} AS ok`).get(MEMBER, SQUAD, required, nowCapabilitySql()) as { ok: number }).ok === 1
    }
    expect(probe(1)).toBe(true)  // observer
    expect(probe(2)).toBe(true)  // member
    expect(probe(3)).toBe(false) // lead
    expect(probe(4)).toBe(false) // admin
  })
})
