import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { unstable_splitSqlQuery } from 'wrangler'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const config = join(root, 'wrangler-local-test.toml')
const database = 'mupot-local-test'
const temporaryDirectories: string[] = []

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

function runD1(persistTo: string, command: string) {
  return spawnSync(
    wrangler,
    [
      'd1',
      'execute',
      database,
      '--local',
      '--config',
      config,
      '--persist-to',
      persistTo,
      '--command',
      command,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      timeout: 30_000,
    },
  )
}

function createLocalD1(): string {
  const persistTo = mkdtempSync(join(tmpdir(), 'mupot-delivery-migration-'))
  temporaryDirectories.push(persistTo)
  const setup = runD1(persistTo, prerequisiteSchema)
  expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0)
  return persistTo
}

function sourceAckTrigger(migrationName: string): string {
  const migration = readFileSync(join(root, 'migrations', migrationName), 'utf8')
  const trigger = unstable_splitSqlQuery(migration).find((statement) =>
    statement.includes('CREATE TRIGGER fenced_deliveries_source_ack_requires_chain'),
  )
  expect(trigger).toBeDefined()
  return trigger as string
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('fenced-delivery migration compatibility with local D1', () => {
  it('installs the source-ACK trigger from migration 0128', () => {
    const persistTo = createLocalD1()
    const installed = runD1(
      persistTo,
      sourceAckTrigger('0128_fenced_deliveries.sql'),
    )

    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0)
  })

  it('rebuilds a previously installed source-ACK trigger through migration 0133', () => {
    const persistTo = createLocalD1()
    const oldTrigger = runD1(
      persistTo,
      `CREATE TRIGGER fenced_deliveries_source_ack_requires_chain
       BEFORE UPDATE OF state ON fenced_deliveries
       BEGIN
         SELECT RAISE(ABORT, 'old trigger');
       END;`,
    )
    expect(oldTrigger.status, `${oldTrigger.stdout}\n${oldTrigger.stderr}`).toBe(0)

    const dropped = runD1(
      persistTo,
      'DROP TRIGGER IF EXISTS fenced_deliveries_source_ack_requires_chain',
    )
    expect(dropped.status, `${dropped.stdout}\n${dropped.stderr}`).toBe(0)

    const repaired = runD1(
      persistTo,
      sourceAckTrigger('0133_source_ack_trigger_d1_compat.sql'),
    )

    expect(repaired.status, `${repaired.stdout}\n${repaired.stderr}`).toBe(0)
  })
})
