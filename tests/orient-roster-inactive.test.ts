// tests/orient-roster-inactive.test.ts — PR #1321 P2: buildOrient's squadmate roster must
// exclude inactive agents, the same predicate resolveAgentRef/agentsNamed already apply
// (src/org/resolve.ts, src/agents/messages.ts). Uses a REAL sqlite-backed D1 (migrations
// applied), same pattern as tests/send-target-confinement.test.ts, so this exercises the
// actual SQL rather than a hand-rolled substring mock.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOrient } from '../src/orient/service'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migratedDb() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  fixture.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept', 'squad-1', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role, status) VALUES
      ('agent-self', 'squad-1', 'self', 'Self', 'member', 'active'),
      ('agent-live-mate', 'squad-1', 'live-mate', 'Live Mate', 'member', 'active'),
      ('agent-dead-mate', 'squad-1', 'dead-mate', 'Dead Mate', 'member', 'inactive');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-self', 'agent-self', 'squad-1', 'member'),
      ('membership-live', 'agent-live-mate', 'squad-1', 'member'),
      ('membership-dead', 'agent-dead-mate', 'squad-1', 'member');
  `)
  return fixture
}

function envWith(DB: Env['DB']): Env {
  return { DB, TENANT_SLUG: 'tenant' } as Env
}

describe('buildOrient squadmate roster (#1321 P2)', () => {
  it('omits an inactive squadmate from the roster', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await buildOrient(envWith(db), 'agent-self', 'member', 'https://mupot.example/mcp', true, Date.now())
      expect(res.data).not.toBeNull()
      const slugs = (res.data?.squadmates ?? []).map((m) => m.slug)
      expect(slugs).toContain('live-mate')
      expect(slugs).not.toContain('dead-mate')
    } finally {
      close()
    }
  })
})
