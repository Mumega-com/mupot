// tests/migration-0171-fleet-agents-dedup.test.ts — mupot#1494 v4 round 2 (P2-b, adversarial
// regression). migrations/0171_fleet_agents_presence_mode.sql's P1-b backfill (Case A rename,
// Case B merge+receipt+delete) only ever runs against rows that ALREADY exist before the
// migration applies — a normal application-level test (real schema, empty DB, then calling
// reportFleetAgents/upsertPollFleetPresence) can never reach it, because those functions'
// OWN fix (resolveFleetWriteAgentId) prevents a duplicate from ever being created going
// forward. This is a genuinely migration-only concern: apply every migration EXCEPT 0171,
// hand-seed the exact "one agent, two rows" shape a pre-fix production database could hold,
// THEN apply 0171 and assert on the result — same technique this codebase's own adversarial
// review already used ad hoc for 0168/0171 (real node:sqlite, real migration chain, real
// populated data), committed here as a real test.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { migrationFiles } from './helpers/migrations'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const TARGET = '0171_fleet_agents_presence_mode.sql'

function now(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

let harness: SqliteD1Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

/** Apply every migration strictly BEFORE 0171, in order — the exact pre-migration state a
 *  live database with this defect would be in. */
function applyMigrationsBefore0171(sqlite: SqliteD1Harness['sqlite']): void {
  const files = migrationFiles()
  const targetIdx = files.indexOf(TARGET)
  expect(targetIdx).toBeGreaterThan(-1) // fails loudly if 0171 is ever renamed/renumbered again
  for (const file of files.slice(0, targetIdx)) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function apply0171(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf8'))
}

describe('migration 0171 — fleet_agents dedup backfill (mupot#1494 v4 round 2, P2-b)', () => {
  it('Case B: merges display/runtime/squads/host FORWARD from the rich slug row onto the empty uuid row, and receipts the merge', () => {
    harness = createSqliteD1()
    applyMigrationsBefore0171(harness.sqlite)

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p2b', 'dept-p2b', 'Dept P2B');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-p2b', 'dept-p2b', 'squad-p2b', 'Squad P2B');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-uuid-p2b', 'squad-p2b', 'p2b-runner', 'P2B Runner', 'active');
    `)
    // The RICH row — daemon-reported, keyed by the SLUG (round-1's own writer shape before
    // the P1-b fix started resolving it).
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('p2b-runner', 'mumega', 'P2B Display', 'claude-code', '["squad-p2b"]', 'on_demand', 'running', 'daemon', 'p2b-host', '${now()}', '${now()}')
    `)
    // The EMPTY row — poll-written, keyed by the uuid (upsertPollFleetPresence never sets
    // display/runtime/host).
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('agent-uuid-p2b', 'mumega', '', '', '[]', '', 'running', 'poll-writer', '', '${now()}', '${now()}')
    `)

    apply0171(harness.sqlite)

    const rows = harness.sqlite.prepare(
      `SELECT agent_id, reported_by, display, runtime, squads, host FROM fleet_agents WHERE tenant = 'mumega'`,
    ).all() as Array<{ agent_id: string; reported_by: string; display: string; runtime: string; squads: string; host: string }>
    expect(rows).toHaveLength(1) // the slug row is gone — ONE row survives
    expect(rows[0]).toMatchObject({
      agent_id: 'agent-uuid-p2b', // the uuid row is the survivor
      reported_by: 'poll-writer', // NOT clobbered by the merge — only empty fields are filled
      display: 'P2B Display', // merged forward from the deleted slug row
      runtime: 'claude-code', // merged forward
      squads: '["squad-p2b"]', // merged forward
      host: 'p2b-host', // merged forward
    })

    const receipts = harness.sqlite.prepare(
      `SELECT operation, target_id, evidence_json FROM mutation_audit_entries WHERE operation = 'fleet_agents_dedup_merge'`,
    ).all() as Array<{ operation: string; target_id: string; evidence_json: string }>
    expect(receipts).toHaveLength(1)
    expect(receipts[0].target_id).toBe('agent-uuid-p2b')
    const evidence = JSON.parse(receipts[0].evidence_json) as Record<string, unknown>
    expect(evidence).toMatchObject({
      merged_from_agent_id: 'p2b-runner',
      merged_display: 'P2B Display',
      merged_runtime: 'claude-code',
      merged_squads: '["squad-p2b"]',
      merged_host: 'p2b-host',
    })
  })

  it('Case B: rich-uuid/stale-slug — never overwrites a NON-EMPTY value AND never receipts a false merge (mupot#1494 round 3, P2-B)', () => {
    harness = createSqliteD1()
    applyMigrationsBefore0171(harness.sqlite)

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p2b2', 'dept-p2b2', 'Dept P2B2');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-p2b2', 'dept-p2b2', 'squad-p2b2', 'Squad P2B2');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-uuid-p2b2', 'squad-p2b2', 'p2b2-runner', 'P2B2 Runner', 'active');
    `)
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('p2b2-runner', 'mumega', 'Slug Display (should NOT win)', 'codex', '["squad-p2b2"]', 'on_demand', 'running', 'daemon', 'slug-host', '${now()}', '${now()}')
    `)
    // The uuid row ALREADY has real values on every field — the merge must leave them alone.
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('agent-uuid-p2b2', 'mumega', 'Real Display', 'claude-code', '["already-real"]', 'always_on', 'running', 'poll-writer', 'real-host', '${now()}', '${now()}')
    `)

    apply0171(harness.sqlite)

    const rows = harness.sqlite.prepare(
      `SELECT agent_id, display, runtime, squads, host FROM fleet_agents WHERE tenant = 'mumega'`,
    ).all() as Array<{ agent_id: string; display: string; runtime: string; squads: string; host: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      agent_id: 'agent-uuid-p2b2', display: 'Real Display', runtime: 'claude-code',
      squads: '["already-real"]', host: 'real-host',
    })

    // mupot#1494 round 3 (P2-B, adversarial round 2) — round 2's Part 2 receipted a "merge"
    // for EVERY uuid/slug pair unconditionally, so this rich-uuid/stale-slug case (nothing
    // was actually copied — every field above stayed at its own real value) got a false
    // receipt claiming the STALE slug values had been merged in. Fixed: no receipt row at
    // all when nothing was actually merged forward.
    const receipts = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE operation = 'fleet_agents_dedup_merge'`,
    ).get() as { n: number }
    expect(receipts.n).toBe(0)
  })

  it('Case B: a PARTIAL merge (some fields real, some empty) receipts only the fields actually copied — the rest NULL, never the stale slug value', () => {
    harness = createSqliteD1()
    applyMigrationsBefore0171(harness.sqlite)

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p2b4', 'dept-p2b4', 'Dept P2B4');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-p2b4', 'dept-p2b4', 'squad-p2b4', 'Squad P2B4');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-uuid-p2b4', 'squad-p2b4', 'p2b4-runner', 'P2B4 Runner', 'active');
    `)
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('p2b4-runner', 'mumega', 'Slug Display', 'codex', '["squad-p2b4"]', 'on_demand', 'running', 'daemon', 'slug-host', '${now()}', '${now()}')
    `)
    // uuid row already has a real `display`, but empty `runtime`/`squads`/`host` —
    // only those three should be merged forward and receipted.
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('agent-uuid-p2b4', 'mumega', 'Already Real Display', '', '[]', '', 'running', 'poll-writer', '', '${now()}', '${now()}')
    `)

    apply0171(harness.sqlite)

    const row = harness.sqlite.prepare(
      `SELECT display, runtime, squads, host FROM fleet_agents WHERE agent_id = 'agent-uuid-p2b4'`,
    ).get() as { display: string; runtime: string; squads: string; host: string }
    expect(row).toEqual({
      display: 'Already Real Display', // untouched
      runtime: 'codex', // merged
      squads: '["squad-p2b4"]', // merged
      host: 'slug-host', // merged
    })

    const receipts = harness.sqlite.prepare(
      `SELECT evidence_json FROM mutation_audit_entries WHERE operation = 'fleet_agents_dedup_merge' AND target_id = 'agent-uuid-p2b4'`,
    ).all() as Array<{ evidence_json: string }>
    expect(receipts).toHaveLength(1)
    const evidence = JSON.parse(receipts[0].evidence_json) as Record<string, unknown>
    expect(evidence).toMatchObject({
      merged_display: null, // NOT merged — must not claim the stale slug value
      merged_runtime: 'codex',
      merged_squads: '["squad-p2b4"]',
      merged_host: 'slug-host',
    })
  })

  it('Case A (rename, no merge needed) and unmapped/ambiguous rows are unaffected by the P2-b change', () => {
    harness = createSqliteD1()
    applyMigrationsBefore0171(harness.sqlite)

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p2b3', 'dept-p2b3', 'Dept P2B3');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-p2b3', 'dept-p2b3', 'squad-p2b3', 'Squad P2B3');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-uuid-p2b3', 'squad-p2b3', 'p2b3-runner', 'P2B3 Runner', 'active');
    `)
    // Case A: only a slug row exists, no uuid counterpart — rename in place, no merge.
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('p2b3-runner', 'mumega', 'Solo Display', 'claude-code', '[]', 'on_demand', 'running', 'daemon', 'solo-host', '${now()}', '${now()}')
    `)
    // Unmapped: matches no real agent at all.
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('ghost-p2b3', 'mumega', '', '', '[]', '', 'unknown', 'daemon', '', '${now()}', '${now()}')
    `)

    apply0171(harness.sqlite)

    const rows = harness.sqlite.prepare(
      `SELECT agent_id, display FROM fleet_agents WHERE tenant = 'mumega' ORDER BY agent_id`,
    ).all() as Array<{ agent_id: string; display: string }>
    expect(rows).toEqual([
      { agent_id: 'agent-uuid-p2b3', display: 'Solo Display' }, // renamed in place
      { agent_id: 'ghost-p2b3', display: '' }, // untouched
    ])

    // No merge receipt for Case A — nothing was merged, only renamed.
    const receipts = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE operation = 'fleet_agents_dedup_merge'`,
    ).get() as { n: number }
    expect(receipts.n).toBe(0)
  })
})
