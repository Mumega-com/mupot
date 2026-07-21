// Tests for B5 (label→squad routing) + D3 (CI→task) helpers.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { parseLabelSquadMap, squadForLabels } from '../src/integrations/github-routes'
import { syncCiResultToTask } from '../src/tasks/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

describe('parseLabelSquadMap (B5)', () => {
  it('parses a valid JSON label→squad map (case-insensitive keys)', () => {
    const m = parseLabelSquadMap('{"Bug":"sq1","feature":"sq2"}')
    expect(m).toEqual({ bug: 'sq1', feature: 'sq2' })
  })
  it('returns {} for absent/invalid', () => {
    expect(parseLabelSquadMap(undefined)).toEqual({})
    expect(parseLabelSquadMap('{bad')).toEqual({})
    expect(parseLabelSquadMap('')).toEqual({})
  })
  it('drops non-string values', () => {
    expect(parseLabelSquadMap('{"a":"sq","b":5}')).toEqual({ a: 'sq' })
  })
})

describe('squadForLabels (B5)', () => {
  const map = { bug: 'sq-bug', urgent: 'sq-urgent' }
  it('returns the first matching squad (case-insensitive)', () => {
    expect(squadForLabels(map, ['Bug'])).toBe('sq-bug')
    expect(squadForLabels(map, ['x', 'URGENT'])).toBe('sq-urgent')
  })
  it('returns null when no label matches', () => {
    expect(squadForLabels(map, ['docs', 'chore'])).toBeNull()
    expect(squadForLabels(map, [])).toBeNull()
  })
})

// Real-SQL harness (not a hand-rolled query-shape mock, per #399 fencing work —
// syncCiResultToTask now does a SELECT-then-UPDATE two-step to re-check per-project
// squad access, so a mock stubbing only `.run()` can no longer stand in for the DB).
describe('syncCiResultToTask (D3)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  function makeHarness(): SqliteD1Harness {
    const h = createSqliteD1()
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      h.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'squad-a', 'Squad A');
    `)
    return h
  }

  function insertTask(h: SqliteD1Harness, overrides: {
    id: string; status: string; prNumber: number; projectId?: string | null
  }): void {
    h.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, github_issue_url, project_id, created_at, updated_at)
       VALUES ('${overrides.id}', 'squad-a', 'PR task', 'CI passes', '${overrides.status}',
               'https://github.com/o/r/pull/${overrides.prNumber}',
               ${overrides.projectId ? `'${overrides.projectId}'` : 'NULL'},
               '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`,
    )
  }

  function envFor(h: SqliteD1Harness): Env {
    return { DB: h.db } as unknown as Env
  }

  it('failure conclusion bumps a review task back to in_progress', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'task-1', status: 'review', prNumber: 42 })

    const res = await syncCiResultToTask(envFor(harness), 42, 'failure')
    expect(res.updated).toBe(true)
    expect(harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get('task-1'))
      .toEqual({ status: 'in_progress', result: 'CI: failure' })
  })

  it('success records the note without changing a gate state', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'task-2', status: 'review', prNumber: 7 })

    const res = await syncCiResultToTask(envFor(harness), 7, 'success')
    expect(res.updated).toBe(true)
    expect(harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get('task-2'))
      .toEqual({ status: 'review', result: 'CI: success' }) // gate state untouched
  })

  it('no matching task → updated:false', async () => {
    harness = makeHarness()
    expect((await syncCiResultToTask(envFor(harness), 9, 'failure')).updated).toBe(false)
  })

  it('invalid pr number → no-op (short-circuits before touching the DB)', async () => {
    harness = makeHarness()
    expect((await syncCiResultToTask(envFor(harness), 0, 'failure')).updated).toBe(false)
  })
})
