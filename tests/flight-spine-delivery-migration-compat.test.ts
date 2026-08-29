import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { unstable_splitSqlQuery } from 'wrangler'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const harnesses: SqliteD1Harness[] = []

const prerequisiteSchema = `
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  fenced_delivery_id TEXT,
  read_at TEXT
);
CREATE TABLE fenced_deliveries (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  state TEXT NOT NULL,
  source_acked_at TEXT,
  active_attempt_id TEXT,
  active_attempt_number INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  current_fencing_epoch INTEGER NOT NULL,
  runtime_seat_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  effect_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  ciphertext_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  runtime_input_digest TEXT NOT NULL
);
CREATE TABLE fenced_delivery_attempts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL
);
CREATE TABLE fenced_delivery_evidence (
  tenant TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  runtime_seat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  effect_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  ciphertext_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  runtime_input_digest TEXT NOT NULL,
  evidence_type TEXT NOT NULL
);
`

function createLocalD1(): SqliteD1Harness {
  const harness = createSqliteD1()
  harnesses.push(harness)
  harness.sqlite.exec(prerequisiteSchema)
  return harness
}

function migrationSql(migrationName: string): string {
  return readFileSync(join(root, 'migrations', migrationName), 'utf8')
}

function sourceAckTrigger(migrationName: string): string {
  const migration = migrationSql(migrationName)
  const trigger = unstable_splitSqlQuery(migration).find((statement) =>
    statement.includes('CREATE TRIGGER fenced_deliveries_source_ack_requires_chain'),
  )
  expect(trigger).toBeDefined()
  return trigger as string
}

function installedSourceAckTrigger(harness: SqliteD1Harness): string | null {
  const row = harness.sqlite.prepare(
    `SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'fenced_deliveries_source_ack_requires_chain'`,
  ).get() as { sql: string } | undefined
  return row?.sql ?? null
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
})

describe('fenced-delivery migration compatibility with local D1', () => {
  it('installs the source-ACK trigger from migration 0128', () => {
    const harness = createLocalD1()

    expect(() => harness.sqlite.exec(sourceAckTrigger('0128_fenced_deliveries.sql'))).not.toThrow()
    expect(installedSourceAckTrigger(harness)).toContain(
      'fenced delivery source ack requires complete evidence',
    )
  })

  it('rebuilds a previously installed source-ACK trigger through migration 0133', () => {
    const harness = createLocalD1()
    harness.sqlite.exec(
      `CREATE TRIGGER fenced_deliveries_source_ack_requires_chain
       BEFORE UPDATE OF state ON fenced_deliveries
       BEGIN
         SELECT RAISE(ABORT, 'old trigger');
       END;`,
    )
    expect(installedSourceAckTrigger(harness)).toContain('old trigger')

    expect(() => harness.sqlite.exec(
      migrationSql('0133_source_ack_trigger_d1_compat.sql'),
    )).not.toThrow()

    expect(installedSourceAckTrigger(harness)).toContain(
      'fenced delivery source ack requires complete evidence',
    )
    expect(installedSourceAckTrigger(harness)).not.toContain('old trigger')
  })
})
