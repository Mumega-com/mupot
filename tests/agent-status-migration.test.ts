import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

// 0049_agent_status_inactive.sql widens agents.status's CHECK constraint to
// include 'inactive'. D1 can't ALTER a CHECK, so the migration recreates the
// agents table (create agents_new, copy rows, DROP TABLE agents, rename).
//
// `agents` is a PARENT of memberships (agent_id ... ON DELETE CASCADE) and
// tasks (assignee_agent_id ... ON DELETE SET NULL). `wrangler d1 migrations
// apply` runs an entire migration file inside ONE transaction, and SQLite
// documents `PRAGMA foreign_keys` as a no-op while a transaction is open —
// so the migration's `PRAGMA foreign_keys = off` does NOT protect the child
// rows during `DROP TABLE agents`. FK enforcement stays ON, and the DROP
// fires the CASCADE / SET NULL actions for real: every membership row is
// deleted and every task assignment is nulled, once, at deploy.
//
// This harness runs on node:sqlite (real SQLite), not a mock, and wraps the
// migration script in an explicit transaction the same way `wrangler d1
// migrations apply` does — so it reproduces the no-op-pragma-inside-a-
// transaction behavior instead of falsely passing the way a statement-mode
// (non-transactional) test runner would.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET_MIGRATION = '0049_agent_status_inactive.sql'

function priorMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < TARGET_MIGRATION)
    .sort()
}

function applyInTransaction(sqlite: { exec(sql: string): void }, sql: string): void {
  // Mirrors `wrangler d1 migrations apply`: the whole file runs as one
  // transaction, so PRAGMA foreign_keys inside it is a documented no-op.
  sqlite.exec('BEGIN')
  try {
    sqlite.exec(sql)
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

function buildSeededDb() {
  const { sqlite, close } = createSqliteD1()

  for (const file of priorMigrations()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }

  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'sq', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-1', 'sq-1', 'a1', 'Agent One', 'member', '@cf/meta/llama-3.3', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-2', 'sq-1', 'a2', 'Agent Two', 'member', '@cf/meta/llama-3.3', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('mem-1', 'agent-1', 'sq-1', 'member');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('mem-2', 'agent-2', 'sq-1', 'member');
    INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id)
      VALUES ('task-1', 'sq-1', 'Task One', 'open', 'agent-1');
  `)

  return { sqlite, close }
}

describe('0049_agent_status_inactive migration — child-row survival', () => {
  it('preserves memberships and task assignments through the agents table recreate', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      const before = sqlite.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }
      expect(before.n).toBe(2)

      applyInTransaction(sqlite, readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8'))

      const membershipsAfter = sqlite.prepare('SELECT COUNT(*) AS n FROM memberships').get() as { n: number }
      expect(membershipsAfter.n).toBe(2)

      const membershipRows = sqlite
        .prepare('SELECT agent_id FROM memberships ORDER BY agent_id')
        .all() as Array<{ agent_id: string }>
      expect(membershipRows.map((r) => r.agent_id)).toEqual(['agent-1', 'agent-2'])

      const task = sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-1') as {
        assignee_agent_id: string | null
      }
      expect(task.assignee_agent_id).toBe('agent-1')

      // The migration's actual purpose still holds: the CHECK now accepts 'inactive'.
      expect(() => sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-2'`)).not.toThrow()
      const flipped = sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('agent-2') as { status: string }
      expect(flipped.status).toBe('inactive')
    } finally {
      close()
    }
  })

  it('still rejects a status value outside the widened enum', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8'))
      expect(() => sqlite.exec(`UPDATE agents SET status = 'zombie' WHERE id = 'agent-1'`)).toThrow()
    } finally {
      close()
    }
  })
})
