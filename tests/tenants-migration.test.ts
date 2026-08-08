import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TARGET = '0076_tenants.sql'
const ACCOUNT_A = 'a'.repeat(32)
const ACCOUNT_B = 'b'.repeat(32)
const SHA = 'c'.repeat(40)

function applyPriorMigrations(sqlite: { exec(sql: string): void }): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < TARGET)
    .sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function applyTarget(sqlite: { exec(sql: string): void }): void {
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf8'))
}

describe('0076_tenants migration', () => {
  it('adds the Phase 1 registry columns only (metadata/refs, no tenant data tables)', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      applyTarget(sqlite)

      const columns = sqlite
        .prepare("SELECT name FROM pragma_table_info('tenants') ORDER BY cid")
        .all()
        .map((row) => row.name)
      expect(columns).toEqual([
        'id',
        'cf_account_id',
        'broker_token_ref',
        'deployed_worker_url',
        'health_status',
        'last_deploy_sha',
      ])

      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tenants').get()).toEqual({ n: 0 })

      const indexes = sqlite
        .prepare("SELECT name FROM pragma_index_list('tenants')")
        .all()
        .map((row) => row.name)
      expect(indexes).toEqual(expect.arrayContaining(['idx_tenants_health_status']))
    } finally {
      close()
    }
  })

  it('accepts metadata/ref rows and rejects credential-shaped broker_token_ref values', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      applyTarget(sqlite)

      sqlite.exec(`
        INSERT INTO tenants (
          id, cf_account_id, broker_token_ref, deployed_worker_url, health_status, last_deploy_sha
        ) VALUES (
          'acme',
          '${ACCOUNT_A}',
          'secret:tenants/acme/deploy-write',
          'https://acme.example.workers.dev',
          'healthy',
          '${SHA}'
        );
      `)

      expect(
        sqlite.prepare('SELECT id, health_status, broker_token_ref FROM tenants WHERE id = ?').get('acme'),
      ).toEqual({
        id: 'acme',
        health_status: 'healthy',
        broker_token_ref: 'secret:tenants/acme/deploy-write',
      })

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id, broker_token_ref)
          VALUES ('bad-bearer', '${ACCOUNT_B}', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789');
        `),
      ).toThrow()

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id, broker_token_ref)
          VALUES ('bad-jwt', '${ACCOUNT_B}', 'eyJhbGciOiJub25lIn0.e30.');
        `),
      ).toThrow()

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id, broker_token_ref)
          VALUES ('bad-raw', '${ACCOUNT_B}', '${'d'.repeat(40)}');
        `),
      ).toThrow()

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id, deployed_worker_url)
          VALUES ('bad-url', '${ACCOUNT_B}', 'http://acme.example.workers.dev');
        `),
      ).toThrow()

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id, health_status)
          VALUES ('bad-health', '${ACCOUNT_B}', 'compromised');
        `),
      ).toThrow()

      expect(() =>
        sqlite.exec(`
          INSERT INTO tenants (id, cf_account_id)
          VALUES ('dup-account', '${ACCOUNT_A}');
        `),
      ).toThrow()
    } finally {
      close()
    }
  })
})
