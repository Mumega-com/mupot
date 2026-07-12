import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('task dispatch recovery migration', () => {
  it('upgrades a database where the committed 0047 migration was already applied', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      sqlite.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY);
        CREATE TABLE task_dispatch_receipts (
          id TEXT PRIMARY KEY,
          tenant TEXT NOT NULL,
          task_id TEXT NOT NULL,
          squad_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          actor_kind TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          consumed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
      `)

      sqlite.exec(readFileSync('migrations/0048_task_dispatch_recovery.sql', 'utf8'))

      const taskColumns = sqlite.prepare("SELECT name FROM pragma_table_info('tasks')").all()
      const receiptColumns = sqlite.prepare("SELECT name FROM pragma_table_info('task_dispatch_receipts')").all()
      expect(taskColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
        'execution_receipt_id', 'execution_claim_expires_at',
      ]))
      expect(receiptColumns.map((row) => row.name)).toContain('claim_expires_at')
    } finally {
      close()
    }
  })
})
