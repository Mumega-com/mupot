import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAgent, updateAgentProfile } from '../src/org/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// 0086_agent_audit_trail — append-only triggers (agent_audit_no_update /
// agent_audit_no_delete). Matches task_verdicts_no_update/_no_delete
// (migrations/0008_gate_grants.sql) and routine_events_no_update/_no_delete
// (migrations/0074_routine_cancellation_events.sql): BEFORE UPDATE/DELETE
// triggers that RAISE(ABORT) so the guard cannot be bypassed at the
// application layer.
//
// agent_audit differs from both precedents in one way: updateAgentProfile
// (src/org/service.ts) writes it inside the SAME env.DB.batch() as the
// `agents` UPDATE it records, and that batch's third statement UPDATEs the
// just-inserted row to backfill after_state (the INSERT runs before the
// `agents` UPDATE, so the post-image isn't known yet at INSERT time). A
// blanket append-only trigger would ABORT that statement and break every
// update_agent call. agent_audit_no_update therefore permits exactly that one
// transition (OLD.after_state = '' -> a real value, nothing else different)
// and blocks everything else — same narrow-allow-list shape as
// task_verdicts_no_update.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-1', 'sqa', 'Squad A');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
  `)
}

function insertAuditRow(
  sqlite: SqliteD1Harness['sqlite'],
  overrides: Partial<{
    id: string
    agentId: string
    afterState: string
  }> = {},
): void {
  const id = overrides.id ?? 'audit-1'
  const agentId = overrides.agentId ?? 'agent-1'
  const afterState = overrides.afterState ?? '{"slug":"after"}'
  sqlite.exec(`
    INSERT INTO agent_audit
      (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
    VALUES
      ('${id}', '${agentId}', 'actor-1', 'user', 'update_agent', '["slug"]', '{"slug":"before"}', '${afterState}');
  `)
}

describe('0086_agent_audit_trail — append-only triggers', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    seed(harness.sqlite)
  })

  it('allows INSERT', () => {
    expect(() => insertAuditRow(harness.sqlite)).not.toThrow()
    const row = harness.sqlite
      .prepare('SELECT id, agent_id, after_state FROM agent_audit WHERE id = ?')
      .get('audit-1') as { id: string; agent_id: string; after_state: string } | undefined
    expect(row?.id).toBe('audit-1')
    expect(row?.agent_id).toBe('agent-1')
  })

  it('refuses UPDATE on an existing row (generic mutation, not the after_state backfill)', () => {
    insertAuditRow(harness.sqlite, { afterState: '{"slug":"after"}' })
    expect(() =>
      harness.sqlite.exec(`UPDATE agent_audit SET actor_id = 'someone-else' WHERE id = 'audit-1'`),
    ).toThrow(/agent_audit is append-only: UPDATE is forbidden/)
    expect(() =>
      harness.sqlite.exec(`UPDATE agent_audit SET before_state = '{}' WHERE id = 'audit-1'`),
    ).toThrow(/agent_audit is append-only: UPDATE is forbidden/)
    expect(() =>
      harness.sqlite.exec(`UPDATE agent_audit SET action = 'rollback_agent' WHERE id = 'audit-1'`),
    ).toThrow(/agent_audit is append-only: UPDATE is forbidden/)
  })

  it('refuses a second after_state backfill on a row that already has one', () => {
    // Row already has a non-'' after_state (simulating an already-completed
    // updateAgentProfile write). A repeat of the exact backfill statement must
    // still be refused — the exception is a one-time transition, not a
    // standing door on after_state.
    insertAuditRow(harness.sqlite, { afterState: '{"slug":"after"}' })
    expect(() =>
      harness.sqlite.exec(`UPDATE agent_audit SET after_state = '{"slug":"other"}' WHERE id = 'audit-1'`),
    ).toThrow(/agent_audit is append-only: UPDATE is forbidden/)
  })

  it('allows the narrow after_state backfill transition (empty -> real value, nothing else changed)', () => {
    // Mirrors updateAgentProfile's statement 3 exactly: INSERT leaves
    // after_state = '', then a follow-up UPDATE sets only after_state.
    insertAuditRow(harness.sqlite, { afterState: '' })
    expect(() =>
      harness.sqlite.exec(`UPDATE agent_audit SET after_state = '{"slug":"after"}' WHERE id = 'audit-1'`),
    ).not.toThrow()
    const row = harness.sqlite
      .prepare('SELECT after_state FROM agent_audit WHERE id = ?')
      .get('audit-1') as { after_state: string } | undefined
    expect(row?.after_state).toBe('{"slug":"after"}')
  })

  it('refuses the after_state backfill transition if any other column also changes', () => {
    // Same exception, but smuggling a second column change alongside the
    // legitimate after_state write must still be blocked.
    insertAuditRow(harness.sqlite, { afterState: '' })
    expect(() =>
      harness.sqlite.exec(
        `UPDATE agent_audit SET after_state = '{"slug":"after"}', actor_id = 'someone-else' WHERE id = 'audit-1'`,
      ),
    ).toThrow(/agent_audit is append-only: UPDATE is forbidden/)
  })

  it('refuses DELETE on an existing row', () => {
    insertAuditRow(harness.sqlite)
    expect(() => harness.sqlite.exec(`DELETE FROM agent_audit WHERE id = 'audit-1'`)).toThrow(
      /agent_audit is append-only: DELETE is forbidden/,
    )
  })

  it('leaves updateAgentProfile working end to end (the flow that matters most)', async () => {
    const env = { DB: harness.db } as unknown as Env
    const createdAgent = await createAgent(env, 'sq-a', {
      slug: 'prime2',
      name: 'Prime2',
      role: 'member',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    })
    if (!createdAgent.ok) throw new Error(`fixture create failed: ${createdAgent.error}`)

    const result = await updateAgentProfile(
      env,
      createdAgent.value.id,
      { model: 'claude-opus-5', role: 'gatekeeper' },
      { id: 'member-42', type: 'user' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = await env.DB.prepare(
      'SELECT after_state, before_state FROM agent_audit WHERE id = ?',
    )
      .bind(result.auditId)
      .first<{ after_state: string; before_state: string }>()
    expect(row).not.toBeNull()
    expect(JSON.parse(row!.after_state).model).toBe('claude-opus-5')
    expect(JSON.parse(row!.before_state).model).not.toBe('claude-opus-5')
  })
})
