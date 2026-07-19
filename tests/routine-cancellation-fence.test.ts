import { describe, expect, it } from 'vitest'
import { sqlNotCancellationPending } from '../src/routines/cancellation-fence'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('Routine cancellation SQL fence', () => {
  it('blocks a production-style UPDATE when the outer columns are qualified', () => {
    const harness = createSqliteD1()
    try {
      harness.sqlite.exec(`
        CREATE TABLE routine_runs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE routine_run_events (
          id TEXT PRIMARY KEY, tenant TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL
        );
        INSERT INTO routine_runs VALUES ('run-1', 'tenant-a', 'queued');
        INSERT INTO routine_run_events VALUES (
          'request-1', 'tenant-a', 'run-1', 'cancellation_requested'
        );
      `)

      const result = harness.sqlite.prepare(`
        UPDATE routine_runs SET status = 'leased'
         WHERE id = 'run-1' AND tenant = 'tenant-a'
           AND ${sqlNotCancellationPending('routine_runs')}
      `).run()

      expect(Number(result.changes)).toBe(0)
      expect(harness.sqlite.prepare("SELECT status FROM routine_runs WHERE id = 'run-1'").get())
        .toEqual({ status: 'queued' })
    } finally {
      harness.close()
    }
  })
})
