// tests/task-bridge-external-source-suppression.test.ts
//
// A task that already names a home must not have a second one manufactured for it.
//
// Real SQLite + the whole committed migration chain (the #684/#720 ratchet,
// scripts/check-test-schema-source.mjs). A hand-rolled prepare() stand-in would let these
// pass while naming a column that does not exist, and the claim under test is about which
// rows actually land — external_source is a real column with a real trust boundary
// (migrations/0077), and the suppression decision reads it.
//
// WHAT IS BEING PROVEN: the mirror fires for first-party tasks and does NOT fire for
// externally-sourced ones. BOTH halves matter. A suppression that also suppresses
// first-party tasks would silently stop mirroring everything — fail-closed, still a bug,
// and a negative-only test cannot tell that apart from correct behaviour.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { createTask } from '../src/tasks/service'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const ISSUE_URL = 'https://github.com/Mumega-com/mumega-com/issues/9999'

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-a', 'squad-core', 'Core');
  `)

  // GITHUB_REPO + a token are what make mirrorTaskCreate attempt anything at all; without
  // both it returns null early and every test here would pass for the wrong reason.
  // createTask emits task.created on the bus; a Queue-shaped stub keeps that path real
  // without asserting on it — this file is about the GitHub mirror, not the event spine.
  const env = {
    TENANT_SLUG: 'mumega',
    DB: harness.db,
    GITHUB_REPO: 'Mumega-com/mumega-com',
    GITHUB_TOKEN: 'ghp_test_token_not_a_real_credential',
    BUS: { send: async () => {} },
  } as unknown as Env

  return { harness, env }
}

describe('task bridge — external_source suppresses mirror creation', () => {
  let calls: string[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ html_url: ISSUE_URL }), { status: 201 })
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('DOES mirror a first-party task — the positive half, so suppression cannot pass by suppressing everything', async () => {
    const { env } = fixture()

    const task = await createTask(env, {
      squad_id: 'squad-core', title: 'first-party work', body: 'b',
      done_when: 'the mirror issue exists', status: 'open',
    } as Parameters<typeof createTask>[1], { actor: { kind: 'agent', id: 'kasra' } })

    // MUTATION GUARD: if the suppression condition were inverted or over-broad, this
    // goes red. Without this case, `externalSource === null` -> `true` (mirror nothing)
    // would still pass the negative test below.
    expect(calls.filter((u) => u.includes('/issues'))).toHaveLength(1)
    expect(task.github_issue_url).toBe(ISSUE_URL)
  })

  it('does NOT mirror when external_source names an existing home', async () => {
    const { env } = fixture()

    const task = await createTask(env, {
      squad_id: 'squad-core', title: 'work filed by hand in the right repo', body: 'b',
      done_when: 'mupot#1026 closed', status: 'open',
    } as Parameters<typeof createTask>[1], {
      actor: { kind: 'agent', id: 'kasra' },
      externalSource: 'Mumega-com/mupot#1026',
    })

    // The whole defect: 529 mumega-com mirrors were manufactured for work that already
    // had a home, with identical title AND body, which defeats dedup-by-search.
    // MUTATION: drop `&& externalSource === null` from the guard -> RED.
    expect(calls.filter((u) => u.includes('/issues'))).toHaveLength(0)
    expect(task.github_issue_url).toBeNull()
  })

  it('persists external_source as real provenance, not just as a suppression flag', async () => {
    const { env, harness } = fixture()

    const task = await createTask(env, {
      squad_id: 'squad-core', title: 'external', body: 'b',
      done_when: 'mupot#1033 closed', status: 'open',
    } as Parameters<typeof createTask>[1], {
      actor: { kind: 'agent', id: 'kasra' },
      externalSource: 'Mumega-com/mupot#1033',
    })

    // Suppression must not be achieved by discarding the marker — the trust boundary in
    // migrations/0077 is `external_source IS NULL` vs `IS NOT NULL`, and assignability
    // gating reads the stored row, not the option.
    const row = harness.sqlite
      .prepare(`SELECT external_source FROM tasks WHERE id = ?`)
      .get(task.id) as { external_source: string | null }
    expect(row.external_source).toBe('Mumega-com/mupot#1033')
  })

  it('rejects blank provenance rather than coercing it — the ""-is-non-null-in-SQL split', async () => {
    const { env } = fixture()

    // '' is NON-NULL external provenance in SQLite and FALSY in JS. The guard compares
    // `externalSource === null` precisely so the two layers cannot disagree; blanks are
    // rejected upstream so they never reach it. If someone "simplifies" the guard to a
    // truthiness test, '' would suppress in JS while reading as external in SQL — the
    // exact shape that already shipped one live defect here (adversarial BLOCK 2026-08-04).
    await expect(createTask(env, {
      squad_id: 'squad-core', title: 'blank provenance', body: 'b',
      done_when: 'never', status: 'open',
    } as Parameters<typeof createTask>[1], {
      actor: { kind: 'agent', id: 'kasra' },
      externalSource: '',
    })).rejects.toThrow(/non-blank identifier or null/)
  })
})
