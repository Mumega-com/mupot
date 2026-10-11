// tests/task-result-submissions-result-text-migration.test.ts — migration 0210 is ADD COLUMN only.
//
// A migration-behaviour test: it constructs the historical state (every migration BEFORE 0210,
// plus a populated ledger row), then applies 0210 on top. It imports no src/.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { migrationFiles } from './helpers/migrations'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const TARGET = '0210_task_result_submissions_result_text.sql'

describe('migration 0210 (task_result_submissions.result_text)', () => {
  it('applies on a populated ledger, leaves old rows NULL, and keeps the append-only triggers', () => {
    const harness = createSqliteD1()
    try {
      const files = migrationFiles()
      expect(files).toContain(TARGET)
      for (const f of files.filter((n) => n < TARGET)) harness.sqlite.exec(readFileSync(join(DIR, f), 'utf8'))
      harness.sqlite.prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
         VALUES ('old-1', 't', 'task-1', 's', 'A', '/tmp/x', ?, ?)`,
      ).run('9f'.repeat(32), '1e'.repeat(32))

      harness.sqlite.exec(readFileSync(join(DIR, TARGET), 'utf8'))

      const cols = (harness.sqlite.prepare(`PRAGMA table_info(task_result_submissions)`).all() as Array<{ name: string; notnull: number }>)
      const col = cols.find((c) => c.name === 'result_text')
      expect(col).toBeDefined()
      expect(col?.notnull).toBe(0)
      expect(harness.sqlite.prepare(`SELECT id, result_text FROM task_result_submissions`).all()).toEqual([{ id: 'old-1', result_text: null }])
      // not a table rebuild: the ledger keeps its triggers and seq ordering
      const triggers = (harness.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'task_result_submissions' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name)
      expect(triggers).toEqual(['task_result_submissions_no_delete', 'task_result_submissions_no_update'])
      expect(() => harness.sqlite.prepare(`UPDATE task_result_submissions SET result_text = 'x'`).run()).toThrow(/append-only/)
      expect(() => harness.sqlite.prepare(`DELETE FROM task_result_submissions`).run()).toThrow(/append-only/)
      harness.sqlite.prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
         VALUES ('new-1', 't', 'task-1', 's', 'A', '/tmp/x', ?, ?, 'body')`,
      ).run('9f'.repeat(32), '1e'.repeat(32))
      expect(harness.sqlite.prepare(`SELECT seq FROM task_result_submissions ORDER BY seq`).all()).toEqual([{ seq: 1 }, { seq: 2 }])
    } finally {
      harness.close()
    }
  })
})
