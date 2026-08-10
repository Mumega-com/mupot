// tests/routine-dispatch-candidates.test.ts — mupot#611 items 2 & 3.
//
// Item 2: CANDIDATE_LIMIT (src/routines/dispatch.ts) used to be a SILENT ceiling —
// past the 20th agent in a squad (ordered by ascending uuid) the rest were
// invisible to dispatch with no error and no log. Fixed by raising the limit AND
// making a breach loud (console.error with structured fields) rather than picking
// a bigger number and calling it done.
//
// Item 3: loadCandidates joined only on the agent's home column (a.squad_id),
// ignoring the separate `memberships` table (agent_id, squad_id, capability —
// migration 0001) that the send-authz path already treats as real squad
// membership (src/agents/messages.ts, validateMessageProjectAccess). An agent
// added to a squad via `memberships` while homed elsewhere could message that
// squad but could never be dispatched by it. The fix widens the candidate SELECT
// to home-squad OR membership-squad, and — the part that has to be right, not
// just present — pulls department_id from the TARGET squad rather than the
// candidate's home squad, so the capability gate in selectAgent (untouched by
// this fix) stays correctly scoped for a widened pool. tests/routine-dispatch.test.ts
// carries the end-to-end proof that the capability gate still blocks an
// unauthorized membership-only agent; this file is the direct SQL-shape coverage.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { CANDIDATE_LIMIT, loadCandidates } from '../src/routines/dispatch'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function bindAgent(sqlite: SqliteD1Harness['sqlite'], agentId: string, memberId: string): void {
  sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${memberId}', 'active', 'tenant-a');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('tenant-a', '${agentId}', '${memberId}', '2026-08-01T00:00:00.000Z');
  `)
}

describe('loadCandidates — mupot#611 items 2 & 3', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-one', 'Dept One');
      INSERT INTO departments (id, slug, name) VALUES ('dept-2', 'dept-two', 'Dept Two');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept-2', 'other', 'Other');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-home', 'squad-1', 'home', 'Home', 'active');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-member-only', 'squad-2', 'member-only', 'Member Only', 'active');
    `)
    bindAgent(harness.sqlite, 'agent-home', 'member-home')
    bindAgent(harness.sqlite, 'agent-member-only', 'member-only')
    env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
  })

  afterEach(() => {
    harness.close()
  })

  it('item 3: includes an agent homed elsewhere that has a `memberships` row on the target squad', async () => {
    harness.sqlite.exec(
      `INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m1', 'agent-member-only', 'squad-1', 'member')`,
    )

    const candidates = await loadCandidates(env, 'squad-1')
    const ids = candidates.map((c) => c.id).sort()
    expect(ids).toEqual(['agent-home', 'agent-member-only'])
  })

  it('item 3: excludes a `memberships` row for a DIFFERENT squad (no false widening)', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-3', 'dept-2', 'third', 'Third');
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m1', 'agent-member-only', 'squad-3', 'member')
    `)

    const candidates = await loadCandidates(env, 'squad-1')
    expect(candidates.map((c) => c.id)).toEqual(['agent-home'])
  })

  it('item 3 correctness: department_id on a widened candidate is the TARGET squad department, not its own home department', async () => {
    // This is the load-bearing correctness fix, not a cosmetic detail. selectAgent
    // passes this value into hasCapability's department-inheritance argument
    // (src/auth/capability.ts) to decide whether a department-level grant covers
    // the target squad. If this returned agent-member-only's HOME department
    // (dept-2) instead of squad-1's (dept-1), a department-admin grant the caller
    // holds on dept-2 — which has nothing to do with squad-1 — would incorrectly
    // satisfy the gate: a privilege escalation, not a bug in this test file.
    harness.sqlite.exec(
      `INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m1', 'agent-member-only', 'squad-1', 'member')`,
    )

    const candidates = await loadCandidates(env, 'squad-1')
    const widened = candidates.find((c) => c.id === 'agent-member-only')
    expect(widened?.department_id).toBe('dept-1')
    // and the home-squad candidate's department_id is unaffected by the fix
    expect(candidates.find((c) => c.id === 'agent-home')?.department_id).toBe('dept-1')
  })

  it('item 3: home-squad candidates are unaffected when no memberships rows exist (no regression)', async () => {
    const candidates = await loadCandidates(env, 'squad-1')
    expect(candidates.map((c) => c.id)).toEqual(['agent-home'])
  })

  it('item 2: returns every candidate up to the limit, silently, as before', async () => {
    const candidates = await loadCandidates(env, 'squad-1', 5)
    expect(candidates).toHaveLength(1)
  })

  it('item 2: truncates AND logs loudly when the pool exceeds the limit (was: truncates silently)', async () => {
    // Three real, distinct candidates on squad-1 (agent-home via home column,
    // agent-c via home column, agent-member-only via `memberships`); limit them
    // to 2 to force the truncation branch without needing 201 fixture rows.
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-c', 'squad-1', 'c', 'C', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m1', 'agent-member-only', 'squad-1', 'member');
    `)
    bindAgent(harness.sqlite, 'agent-c', 'member-c')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const candidates = await loadCandidates(env, 'squad-1', 2)
      // MUTATION TARGET: if the `rows.length > limit` branch is deleted (or the
      // slice is removed), this assertion is what catches it — the function
      // would return 3 rows for a limit of 2.
      expect(candidates).toHaveLength(2)
      // LOUD, not silent: this is the assertion that catches a mutation which
      // keeps the slice but deletes the console.error call.
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        'dispatch: candidate pool exceeds CANDIDATE_LIMIT, truncating',
        expect.objectContaining({
          tenant: 'tenant-a',
          squad_id: 'squad-1',
          limit: 2,
          candidates_found_at_least: 3,
        }),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('item 2: does NOT log when the pool exactly equals the limit — only a genuine breach is loud', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const candidates = await loadCandidates(env, 'squad-1', 1)
      expect(candidates).toHaveLength(1)
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('item 2: the exported default limit comfortably clears the stated target scale (200 agents, 10 tenants)', () => {
    expect(CANDIDATE_LIMIT).toBeGreaterThanOrEqual(200)
  })
})
