import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import {
  getProjectBinding,
  listProjectBindings,
  removeProjectBinding,
  upsertProjectBinding,
} from '../src/projects/providers/bindings'
import { isProjectBoardProvider, PROJECT_BOARD_PROVIDERS } from '../src/projects/providers/port'
import { isConnectorType } from '../src/connectors/crypto'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const THROUGH = '0062_project_provider_bindings.sql'

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
      })
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
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('archived_project')
    } finally {
      close()
    }
  })

  // #453: a per-project manager only has authority over the squad(s) actually
  // bound to THIS project (project_squad_access) — never over the tenant's
  // whole connector inventory. A referenced connector_id must be pot-wide, or
  // squad-scoped to a squad that holds access on this project; agent-scoped
  // connectors are never valid here. Otherwise a future Linear/Notion adapter
  // consuming binding.connector_id would inherit a confused-deputy credential
  // borrow the moment it starts reading connector_id for real.
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

    it('accepts a pot-wide connector regardless of project squads', async () => {
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
        })
        expect(result.ok).toBe(true)
      } finally {
        close()
      }
    })

    it('accepts a squad-scoped connector when that squad has access on this project', async () => {
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
        })
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
        })
        expect(result).toEqual({ ok: false, error: 'connector_out_of_scope' })
      } finally {
        close()
      }
    })

    it('REJECTS an agent-scoped connector outright, even if the agent sits on an in-scope squad', async () => {
      const { sqlite, db, close } = createSqliteD1()
      try {
        applyThrough(sqlite, THROUGH)
        seed(sqlite)
        // Grant squad-other (agent-1's squad) access too, to prove agent scope
        // is rejected on its own terms, not merely via the squad check.
        sqlite.exec(`
          INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
            VALUES ('proj-1', 'squad-other', 'write', datetime('now'));
        `)
        insertConnector(sqlite, 'conn-agent', 'agent', 'agent-1')
        const env = { DB: db, TENANT_SLUG: TENANT } as never
        const result = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: 'conn-agent',
        })
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
        })
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
        })
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
        })
        expect(result).toEqual({ ok: false, error: 'connector_not_found' })
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
        })
        expect(bound.ok).toBe(true)

        const cleared = await upsertProjectBinding(env, 'proj-1', {
          provider: 'linear',
          external_id: 'ENG',
          connector_id: null,
        })
        expect(cleared.ok).toBe(true)
        if (!cleared.ok) return
        expect(cleared.value.connector_id).toBeNull()
      } finally {
        close()
      }
    })
  })
})
