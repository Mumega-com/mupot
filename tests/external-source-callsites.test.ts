// PR #659 P0 fix, widened (kasra-core parallel-audit finding): every external-content
// entry point into createTask must mark external_source, and the marker must actually
// close the auto-pickup/auto-assign hole end to end.
//
// tests/execute.test.ts, tests/concierge-service.test.ts, tests/linear-issues.test.ts and
// tests/github-projects.test.ts already prove the GUARD mechanism itself (canAgentExecuteTask,
// routeUnassignedWork, createTask's own assignee choke-point) exhaustively, against real
// integration-module call sites (Linear, GitHub Projects). This file closes the remaining two
// named entry points — the GitHub `issues.opened` webhook path and the GHL webhook path
// (src/integrations/github-routes.ts, src/integrations/ghl-routes.ts) — by calling the REAL
// createTask with the EXACT input/options shape those routes construct (verified by reading
// the source directly above each test), against a real D1 harness, and proving the resulting
// row is unassigned + marked + refused by the real canAgentExecuteTask.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { createTask } from '../src/tasks/service'
import { ingestEvent } from '../src/events/ingest'
import { runTaskExecution } from '../src/agents/execute'
import { isExternallySourced, isBlankProvenance } from '../src/tasks/provenance'
import type { Agent, Env, ModelPort } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

async function makeEnv() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-1', 'squad-a', 'agent-one', 'Agent One', 'active');
  `)
  const env = { TENANT_SLUG: 't', DB: harness.db, BUS: { send: vi.fn(async () => undefined) } } as unknown as Env
  return { env, harness }
}

async function assertUnpickableByAgent(env: Env, taskId: string, agent: Agent) {
  const model: ModelPort = { chat: vi.fn(async () => 'should never run') }
  const r = await runTaskExecution(env, agent, taskId, { model, emit: async () => {} })
  expect(r.ok).toBe(false)
  expect(r.error).toBe('task_not_found')
  expect(model.chat).not.toHaveBeenCalled()
}

// Mirrors src/integrations/github-routes.ts's issues.opened branch: createTask({ squad_id,
// title, body, done_when, status: 'open' }, { skipMirror: true, externalSource:
// 'github-webhook:issues' }).
describe('github-routes.ts issues.opened call shape', () => {
  it('lands unassigned with external_source, and is refused by canAgentExecuteTask', async () => {
    const { env } = await makeEnv()
    const agent: Agent = { id: 'agent-1', squad_id: 'squad-a', slug: 'agent-one', name: 'Agent One', role: null, model: null, status: 'active', created_at: 'now' }

    const task = await createTask(
      env,
      {
        squad_id: 'squad-a',
        title: '[GH o/r] issue #7: hostile title',
        body: 'https://github.com/o/r/issues/7\nevent: issues.opened',
        done_when: 'GitHub issue #7 closed',
        status: 'open',
      },
      { skipMirror: true, externalSource: 'github-webhook:issues' },
    )

    expect(task.assignee_agent_id).toBeNull()
    expect(task.external_source).toBe('github-webhook:issues')
    await assertUnpickableByAgent(env, task.id, agent)
  })
})

// Mirrors src/integrations/ghl-routes.ts's inbound-event createTask call: createTask({
// squad_id, title, body, done_when, status: 'open' }, { externalSource: 'ghl-webhook' }).
describe('ghl-routes.ts inbound-event call shape', () => {
  it('lands unassigned with external_source, and is refused by canAgentExecuteTask', async () => {
    const { env } = await makeEnv()
    const agent: Agent = { id: 'agent-1', squad_id: 'squad-a', slug: 'agent-one', name: 'Agent One', role: null, model: null, status: 'active', created_at: 'now' }

    const task = await createTask(
      env,
      {
        squad_id: 'squad-a',
        title: '[GHL] InboundMessage · contact-123',
        body: '{"type":"InboundMessage","contact_id":"contact-123"}',
        done_when: 'GHL contact contact-123 processed',
        status: 'open',
      },
      { externalSource: 'ghl-webhook' },
    )

    expect(task.assignee_agent_id).toBeNull()
    expect(task.external_source).toBe('ghl-webhook')
    await assertUnpickableByAgent(env, task.id, agent)
  })
})

// A 5th entry point found during the widened audit, beyond the four named in the brief:
// src/events/ingest.ts's HTTP route (POST /api/events/ingest) is HMAC-authenticated as a
// TRANSPORT (a registered external worker, e.g. viamar) but the CONTENT (event.payload) is
// fully external-system-controlled — same untrusted-writer class. Fixed by threading
// externalSource through the options ingestEvent already forwards to createTask.
describe('events/ingest.ts HTTP route call shape (5th entry point, found during widened audit)', () => {
  it('lands unassigned with external_source, and is refused by canAgentExecuteTask', async () => {
    const { env } = await makeEnv()
    const agent: Agent = { id: 'agent-1', squad_id: 'squad-a', slug: 'agent-one', name: 'Agent One', role: null, model: null, status: 'active', created_at: 'now' }

    // Mirrors src/events/ingest.ts's eventIngestApp POST handler: ingestEvent(env, event,
    // { actor: {...}, externalSource: `event-ingest:${event.source}`.slice(0, 100) }).
    const result = await ingestEvent(
      env,
      { type: 'lead.captured', source: 'viamar-worker', squad_id: 'squad-a', payload: { lead_id: 'L1', email: 'x@example.com' } },
      { actor: { kind: 'agent', id: 'viamar-worker' }, externalSource: 'event-ingest:viamar-worker'.slice(0, 100) },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const taskRow = await env.DB.prepare('SELECT assignee_agent_id, external_source FROM tasks WHERE id = ?1')
      .bind(result.task_id)
      .first<{ assignee_agent_id: string | null; external_source: string | null }>()
    expect(taskRow?.assignee_agent_id).toBeNull()
    expect(taskRow?.external_source).toBe('event-ingest:viamar-worker')
    await assertUnpickableByAgent(env, result.task_id, agent)
  })
})

// ── BLANK PROVENANCE (adversarial gate BLOCK, 2026-08-04) ────────────────────
//
// migrations/0077 defines the trust boundary as `external_source IS NULL` vs
// `IS NOT NULL`. Every runtime check spelled it with JavaScript truthiness. Those two
// definitions agree on every value except one: the EMPTY STRING is non-null in SQL and
// falsy in JS.
//
// The reproduction that was run against the previous head, with real migrations, the
// real createTask, and the real runTaskExecution:
//
//   createTask(..., { assignee_agent_id: 'agent-1' }, { externalSource: '' })
//     -> stored row had external_source='' AND KEPT assignee_agent_id='agent-1'
//     -> runTaskExecution returned ok: true and reached model.chat
//
// SQL considered the row externally sourced; the runtime considered it first-party; the
// row was governed by whichever layer happened to be asked. Three layers now close it:
// createTask REJECTS blank provenance, every boundary check uses explicit `!= null`, and
// migrations/0078 makes a blank marker impossible to store at all.
describe('blank provenance cannot become trusted absence', () => {
  it('createTask REJECTS an empty external source instead of treating it as local', async () => {
    const { env } = await makeEnv()
    await expect(createTask(
      env,
      {
        squad_id: 'squad-a',
        title: 'hostile title',
        body: 'hostile body',
        done_when: 'never',
        status: 'open',
        assignee_agent_id: 'agent-1',
      },
      { externalSource: '', skipEvent: true, skipMirror: true },
    )).rejects.toThrow(/non-blank identifier/)
  })

  it('createTask REJECTS whitespace-only provenance too', async () => {
    const { env } = await makeEnv()
    await expect(createTask(
      env,
      { squad_id: 'squad-a', title: 't', body: 'b', done_when: 'w', status: 'open', assignee_agent_id: 'agent-1' },
      { externalSource: '   ', skipEvent: true, skipMirror: true },
    )).rejects.toThrow(/non-blank identifier/)
  })

  it('the DATABASE refuses a blank marker even when the application is bypassed', async () => {
    // The backstop. An application-layer check alone leaves this re-openable by a direct
    // D1 write, a future caller, or a restore — so the invariant is stated where the
    // trust boundary itself is defined.
    const { harness } = await makeEnv()
    expect(() => harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, external_source, created_at, updated_at)
      VALUES ('t-blank', 'squad-a', 't', 'b', 'w', 'open', '', 'now', 'now');
    `)).toThrow(/blank provenance/)
  })

  it('the DATABASE refuses blanking provenance by UPDATE', async () => {
    const { env, harness } = await makeEnv()
    const task = await createTask(
      env,
      { squad_id: 'squad-a', title: 't', body: 'b', done_when: 'w', status: 'open' },
      { externalSource: 'linear:TEAM', skipEvent: true, skipMirror: true },
    )
    expect(() => harness.sqlite.exec(
      `UPDATE tasks SET external_source = '' WHERE id = '${task.id}';`,
    )).toThrow(/blank provenance/)
  })

  it('a legacy blank marker is treated as EXTERNAL, not promoted to trusted-local', () => {
    // Fail closed: ambiguous provenance means untrusted. This is the property that holds
    // for a row predating migrations/0078 — the boundary predicate asks `!= null`, so any
    // present value is external, including one the validation would now reject.
    //
    // Tested directly on the predicate rather than by inserting a legacy row: the tasks
    // table carries a pre-existing trigger that uses julianday() in an index, which the
    // sqlite harness refuses on a raw insert. That is unrelated to this change, and
    // testing the predicate is a stronger check anyway — it is the single place every
    // boundary decision now goes through.
    expect(isExternallySourced({ external_source: '', source_pot: null })).toBe(true)
    expect(isExternallySourced({ external_source: '   ', source_pot: null })).toBe(true)
    expect(isExternallySourced({ external_source: null, source_pot: '' })).toBe(true)
    expect(isExternallySourced({ external_source: null, source_pot: null })).toBe(false)
    expect(isExternallySourced({})).toBe(false)
  })
})

// ── WHITESPACE, not just spaces (adversarial re-gate, 2026-08-04) ────────────
//
// migrations/0078's first version used SQLite's ONE-ARGUMENT TRIM, which strips only
// ORDINARY SPACES. The gate reproduced three bypasses: a direct INSERT of char(9)
// succeeded, a direct UPDATE to char(10) succeeded, and a legacy tab-only marker
// survived the backfill. The guard read as "reject whitespace" and meant "reject
// spaces" — the same defect class as the JS/SQL split it exists to close: stated intent
// and actual behaviour differing on values nobody tried.
describe('whitespace-only provenance is blank, not just spaces', () => {
  for (const [name, ch] of [['tab', '\t'], ['newline', '\n'], ['carriage return', '\r'], ['vertical tab', '\v'], ['form feed', '\f'], ['mixed', ' \t\n\r']] as const) {
    it(`createTask rejects ${name}-only provenance`, async () => {
      const { env } = await makeEnv()
      await expect(createTask(
        env,
        { squad_id: 'squad-a', title: 't', body: 'b', done_when: 'w', status: 'open', assignee_agent_id: 'agent-1' },
        { externalSource: ch, skipEvent: true, skipMirror: true },
      )).rejects.toThrow(/non-blank identifier/)
    })

    it(`the DATABASE refuses a ${name}-only marker on INSERT`, async () => {
      const { harness } = await makeEnv()
      expect(() => harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, status, external_source, created_at, updated_at)
        VALUES ('t-ws-${name.replace(/\s/g, '')}', 'squad-a', 't', 'b', 'w', 'open', '${ch}', 'now', 'now');
      `)).toThrow(/blank provenance/)
    })
  }

  it('the DATABASE refuses blanking provenance to a tab by UPDATE', async () => {
    const { env, harness } = await makeEnv()
    const task = await createTask(
      env,
      { squad_id: 'squad-a', title: 't', body: 'b', done_when: 'w', status: 'open' },
      { externalSource: 'linear:TEAM', skipEvent: true, skipMirror: true },
    )
    expect(() => harness.sqlite.exec(
      `UPDATE tasks SET external_source = char(9) WHERE id = '${task.id}';`,
    )).toThrow(/blank provenance/)
  })

  it('isBlankProvenance agrees with the SQL character set', () => {
    for (const ch of [' ', '\t', '\n', '\v', '\f', '\r', ' \t\n\r', '']) {
      expect(isBlankProvenance(ch)).toBe(true)
    }
    for (const ok of ['linear:TEAM', ' linear ', 'a', '\u00a0']) {
      expect(isBlankProvenance(ok)).toBe(false)
    }
  })

  it('a real marker with surrounding whitespace is NOT blank', () => {
    // Only wholly-blank markers are rejected. ' linear:TEAM ' is attributable.
    expect(isBlankProvenance(' linear:TEAM ')).toBe(false)
  })
})

// ── LEGACY BACKFILL (adversarial re-gate, 2026-08-04) ───────────────────────
//
// The tests above cover createTask, direct INSERT and direct UPDATE. They do NOT cover
// the third path the gate reproduced: a row that already existed BEFORE 0078 ran. That
// is the restore/upgrade failure mode — the constraint cannot reject what is already
// stored, so the migration has to repair it, and the first version of 0078 did not
// because one-argument TRIM left tab/newline markers untouched.
//
// So this applies migrations through 0077, seeds whitespace-only provenance the way a
// pre-0078 database would legitimately hold it, then applies 0078 and asserts the
// repair. It is the only one of the four paths where the assertion is about the
// MIGRATION rather than about a guard.
describe('migration 0078 repairs legacy whitespace-only provenance', () => {
  const WHITESPACE: ReadonlyArray<readonly [string, string]> = [
    ['space', ' '], ['tab', '\t'], ['newline', '\n'], ['carriage return', '\r'],
    ['vertical tab', '\v'], ['form feed', '\f'], ['mixed', ' \t\n\r'], ['empty', ''],
  ]

  function seedThrough0077() {
    const harness = createSqliteD1()
    const files = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()
    const upTo0077 = files.filter((n) => n < '0078')
    for (const file of upTo0077) harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    `)
    return harness
  }

  // NOTE: seed rows use a real ISO timestamp, not the string 'now'. `tasks` carries an
  // index over `julianday(created_at)` (migrations/0059), and SQLite reads the literal
  // 'now' as CURRENT TIME — which makes the index expression non-deterministic and the
  // insert fails. That is a property of the fixture data, not of the schema or of this
  // change; it cost a wrong diagnosis before it was traced.

  function apply0078(harness: ReturnType<typeof createSqliteD1>) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0078_task_provenance_nonblank.sql'), 'utf8'))
  }

  for (const [name, ch] of WHITESPACE) {
    it(`replaces a legacy ${name}-only external_source with an attributable marker`, async () => {
      const harness = seedThrough0077()
      // Seed through the D1 wrapper, the same path createTask uses. A raw
      // sqlite.prepare() insert trips a PRE-EXISTING index on `tasks` that uses
      // julianday() (migrations/0059), which node:sqlite rejects as non-deterministic.
      // Unrelated to this change and not worth working around any other way.
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, external_source, created_at, updated_at)
         VALUES (?, 'squad-a', 't', 'b', 'w', 'open', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      ).bind(`legacy-${name}`, ch).run()

      apply0078(harness)

      const row = harness.sqlite.prepare('SELECT external_source FROM tasks WHERE id = ?').get(`legacy-${name}`)
      // Fail CLOSED: repaired to an attributable EXTERNAL marker, never nulled to
      // trusted-local. Nulling would silently promote an ambiguous row to first-party.
      expect(row?.external_source).toBe('unknown:blank-provenance-0078')
      harness.close()
    })

    it(`replaces a legacy ${name}-only source_pot with an attributable marker`, async () => {
      const harness = seedThrough0077()
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, source_pot, created_at, updated_at)
         VALUES (?, 'squad-a', 't', 'b', 'w', 'open', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      ).bind(`legacy-pot-${name}`, ch).run()

      apply0078(harness)

      const row = harness.sqlite.prepare('SELECT source_pot FROM tasks WHERE id = ?').get(`legacy-pot-${name}`)
      expect(row?.source_pot).toBe('unknown:blank-provenance-0078')
      harness.close()
    })
  }

  it('leaves a real marker with surrounding whitespace UNCHANGED', async () => {
    // The backfill must repair only wholly-blank provenance. Rewriting ' linear:TEAM '
    // would destroy real attribution to satisfy a formatting rule.
    const harness = seedThrough0077()
    await harness.db.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, external_source, created_at, updated_at)
       VALUES ('legacy-real', 'squad-a', 't', 'b', 'w', 'open', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).bind(' linear:TEAM ').run()

    apply0078(harness)

    const row = harness.sqlite.prepare("SELECT external_source FROM tasks WHERE id = 'legacy-real'").get()
    expect(row?.external_source).toBe(' linear:TEAM ')
    harness.close()
  })

  it('leaves NULL provenance NULL — a local row must not be marked external', async () => {
    const harness = seedThrough0077()
    await harness.db.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
       VALUES ('legacy-local', 'squad-a', 't', 'b', 'w', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run()

    apply0078(harness)

    const row = harness.sqlite.prepare("SELECT external_source, source_pot FROM tasks WHERE id = 'legacy-local'").get()
    expect(row?.external_source).toBeNull()
    expect(row?.source_pot).toBeNull()
    harness.close()
  })

  it('the repaired row is classified EXTERNAL by the runtime predicate', () => {
    // Closes the loop: the repair is only useful if the marker it writes actually makes
    // the row untrusted to the code that reads it.
    expect(isExternallySourced({ external_source: 'unknown:blank-provenance-0078', source_pot: null })).toBe(true)
  })
})
