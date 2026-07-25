import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import {
  getProjectBinding,
  listProjectBindings,
  removeProjectBinding,
  upsertProjectBinding,
  type BindingActorContext,
} from '../src/projects/providers/bindings'
import { isProjectBoardProvider, PROJECT_BOARD_PROVIDERS } from '../src/projects/providers/port'
import { isConnectorType } from '../src/connectors/crypto'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const THROUGH = '0062_project_provider_bindings.sql'

const ADMIN: BindingActorContext = { workspaceAdmin: true, actorSquadIds: [] }

function applyThrough(sqlite: { exec(sql: string): void }, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name <= throughFile).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

describe('project provider bindings', () => {
  it('exposes github_projects, linear, and notion as board providers', () => {
    expect(PROJECT_BOARD_PROVIDERS).toEqual(['github_projects', 'linear', 'notion'])
    expect(isProjectBoardProvider('notion')).toBe(true)
    expect(isConnectorType('notion')).toBe(true)
    expect(isConnectorType('linear')).toBe(true)
  })

  it('upserts and lists bindings on an active project', async () => {
    const { sqlite, db, close } = createSqliteD1()
    try {
      applyThrough(sqlite, THROUGH)
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj', 'Proj', 'active');
      `)
      const env = { DB: db } as never
      const created = await upsertProjectBinding(env, 'proj-1', {
        provider: 'github_projects',
        external_id: 'Mumega-com/12',
        meta: { agent_field: 'Agent' },
      }, ADMIN)
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.value.external_id).toBe('Mumega-com/12')
      const listed = await listProjectBindings(env, 'proj-1')
      expect(listed).toHaveLength(1)
      const got = await getProjectBinding(env, 'proj-1', 'github_projects')
      expect(got?.provider).toBe('github_projects')
      const removed = await removeProjectBinding(env, 'proj-1', 'github_projects')
      expect(removed.ok).toBe(true)
      expect(await listProjectBindings(env, 'proj-1')).toEqual([])
    } finally {
      close()
    }
  })

  it('rejects bindings on archived projects', async () => {
    const { sqlite, db, close } = createSqliteD1()
    try {
      applyThrough(sqlite, THROUGH)
      sqlite.exec(`
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'archived', 'Archived', 'archived');
      `)
      const env = { DB: db } as never
      const result = await upsertProjectBinding(env, 'proj-a', {
        provider: 'linear',
        external_id: 'ENG',
      }, ADMIN)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('archived_project')
    } finally {
      close()
    }
  })

  // #453: the referenced connector must be within the ACTOR'S OWN authority,
  // never merely "linked to the project." A first attempt at this fix (BLOCKed
  // by adversarial review at e4be75d) accepted any pot-wide connector, and any
  // squad-scoped connector belonging to ANY squad holding ANY access_level on
  // the project — broader than the caller's own authority. canManageProject
  // authorizes a non-admin actor through a SPECIFIC subset of their own squads
  // holding write/admin here; these tests pin the corrected policy: pot-wide
  // requires workspace-admin, squad-scoped requires the connector's squad to be
  // one of THIS actor's own actorSquadIds — not merely project-linked.
  describe('connector_id scope validation (#453)', () => {
    const TENANT = 'test-tenant'

    function seed(sqlite: { exec(sql: string): void }): void {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-mine', 'dept-1', 'squad-mine', 'Squad Mine');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-other', 'dept-1', 'squad-other', 'Squad Other');
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-1', 'squad-other', 'agent-one', 'Agent One');
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj', 'Proj', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
          VALUES ('proj-1', 'squad-mine', 'write', datetime('now'));
      `)
    }

    function insertConnector(
      sqlite: { exec(sql: string): void },
      id: string,
      scopeType: 'pot' | 'squad' | 'agent',
      scopeId: string | null,
      revoked = false,
    ): void {
      sqlite.exec(`
        INSERT INTO connectors (id, tenant, type, label, encrypted_secret, scope_type, scope_id, created_by, created_at, revoked_at)
        VALUES ('${id}', '${TENANT}', 'linear', 'test connector', 'ciphertext', '${scopeType}', ${scopeId ? `'${scopeId}'` : 'NULL'}, 'tester', datetime('now'), ${revoked ? "datetime('now')" : 'NULL'});
      `)
    }

    // The manager authorized through squad-mine on proj-1 — NOT an admin.
    const MANAGER_VIA_MINE: BindingActorContext = { workspaceAdmin: false, actorSquadIds: ['squad-mine'] }

    it('workspace admin may bind a pot-wide connector', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-pot', 'pot', null)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-pot',
        }, ADMIN)
        expect(result.ok).toBe(true)
      } finally {
        close()
      }
    })

    it('REJECTS a pot-wide connector for a non-admin project manager', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-pot', 'pot', null)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-pot',
        }, MANAGER_VIA_MINE)
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('accepts a squad-scoped connector when the actor is authorized through that same squad', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-mine', 'squad', 'squad-mine')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-mine',
        }, MANAGER_VIA_MINE)
        expect(result.ok).toBe(true)
      } finally {
        close()
      }
    })

    // #543 P2 (adversarial review of 86b05bb): workspace admin deliberately
    // has an empty actorSquadIds — the squad branch must still treat admin
    // as the authority superset, the same as it already does for pot-scope,
    // rather than unconditionally rejecting every squad connector for admins.
    it('workspace admin may bind a squad-scoped connector too (admin is the authority superset)', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-mine', 'squad', 'squad-mine')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-mine',
        }, ADMIN)
        expect(result.ok).toBe(true)
      } finally {
        close()
      }
    })

    it('REJECTS a squad-scoped connector belonging to a squad unrelated to this project', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        // squad-other has no project_squad_access row on proj-1 at all.
        insertConnector(sqlite, 'conn-other', 'squad', 'squad-other')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-other',
        }, MANAGER_VIA_MINE)
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('REJECTS a squad-scoped connector for a DIFFERENT squad even when that squad also has project access (the exact confused-deputy gap)', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        // squad-other ALSO has (read-only) access to proj-1 — but the calling
        // actor is authorized here through squad-mine only, so squad-other's
        // credential must still be out of THEIR reach.
        sqlite.exec(`
          INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
            VALUES ('proj-1', 'squad-other', 'read', datetime('now'));
        `)
        insertConnector(sqlite, 'conn-other', 'squad', 'squad-other')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-other',
        }, MANAGER_VIA_MINE)
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('REJECTS an agent-scoped connector outright, even for a workspace admin', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-agent', 'agent', 'agent-1')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-agent',
        }, ADMIN)
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('fails closed on a connector_id that does not exist', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'no-such-connector',
        }, ADMIN)
        expect(result).toEqual({ ok: false, error: 'connector_not_found' })
      } finally {
        close()
      }
    })

    it('fails closed on a revoked connector', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-revoked', 'pot', null, true)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-revoked',
        }, ADMIN)
        expect(result).toEqual({ ok: false, error: 'connector_not_found' })
      } finally {
        close()
      }
    })

    it('fails closed on a connector belonging to a different tenant', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        sqlite.exec(`
          INSERT INTO connectors (id, tenant, type, label, encrypted_secret, scope_type, scope_id, created_by, created_at, revoked_at)
          VALUES ('conn-cross-tenant', 'other-tenant', 'linear', 'test connector', 'ciphertext', 'pot', NULL, 'tester', datetime('now'), NULL);
        `)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-cross-tenant',
        }, ADMIN)
        expect(result).toEqual({ ok: false, error: 'connector_not_found' })
      } finally {
        close()
      }
    })

    // #543 P1 (adversarial review of 86b05bb): the actor context a route
    // handler snapshots before calling upsertProjectBinding can go stale if
    // the squad's access is revoked/downgraded concurrently. The fix moved
    // the REAL authority check into the write's own SQL, reading
    // project_squad_access LIVE rather than trusting actorSquadIds alone.
    // This proves it: the actor CLAIMS authority via squad-mine, but the
    // database, at the moment of the call, no longer grants squad-mine
    // write/admin here — the write must fail closed, not succeed on the
    // strength of the actor's (now-stale) claim.
    it('REJECTS a bind when the actor context is stale — squad access was revoked in the DB before this call runs', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite) // grants squad-mine 'write' on proj-1
        insertConnector(sqlite, 'conn-mine', 'squad', 'squad-mine')
        // Simulate a concurrent revoke landing between the caller's
        // authorization snapshot and this call actually running.
        sqlite.exec(`
          UPDATE project_squad_access SET access_level = 'read'
           WHERE project_id = 'proj-1' AND squad_id = 'squad-mine';
        `)
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-mine',
        }, MANAGER_VIA_MINE) // still claims actorSquadIds: ['squad-mine'] — stale
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('clearing connector_id back to null never needs scope validation', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        insertConnector(sqlite, 'conn-mine', 'squad', 'squad-mine')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const bound = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-mine',
        }, MANAGER_VIA_MINE)
        expect(bound.ok).toBe(true)

        const cleared = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: null,
        }, MANAGER_VIA_MINE)
        expect(cleared.ok).toBe(true)
        if (!cleared.ok) return
        expect(cleared.value.connector_id).toBeNull()
      } finally {
        close()
      }
    })
  })
})
