import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  createProject,
  getProject,
  listProjectSquads,
  listProjects,
  removeProjectSquadAccess,
  updateProject,
  upsertProjectSquadAccess,
} from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-one', 'Squad One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept-1', 'squad-two', 'Squad Two');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db } as Env
}

async function createRoot(env: Env, slug = 'root') {
  const result = await createProject(env, { slug, name: 'Root project' })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe('project domain service', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('validates project slugs and maps duplicate slugs', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    await expect(createProject(env, { slug: 'Not A Slug', name: 'Project' }))
      .resolves.toEqual({ ok: false, error: 'invalid_slug' })
    await expect(createProject(env, { slug: 'valid-project', name: '  Project  ' }))
      .resolves.toMatchObject({ ok: true, value: { slug: 'valid-project', name: 'Project', status: 'active' } })
    await expect(createProject(env, { slug: 'valid-project', name: 'Again' }))
      .resolves.toEqual({ ok: false, error: 'slug_taken' })
  })

  it('creates roots and children, lists them, and returns detail rows', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    const childResult = await createProject(env, {
      slug: 'child', name: 'Child project', parent_project_id: root.id, goal: 'Ship it', target_date: '2026-08-01',
    })

    expect(childResult).toMatchObject({ ok: true, value: { parent_project_id: root.id, goal: 'Ship it', target_date: '2026-08-01' } })
    expect(await listProjects(env)).toMatchObject([
      { id: root.id, parent_project_id: null },
      { parent_project_id: root.id, slug: 'child' },
    ])
    expect(await getProject(env, root.id)).toMatchObject({ id: root.id, slug: 'root' })
    expect(await getProject(env, 'missing')).toBeNull()
  })

  it('rejects children below the approved two-level hierarchy', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    const child = await createProject(env, { slug: 'child', name: 'Child', parent_project_id: root.id })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    await expect(createProject(env, { slug: 'grandchild', name: 'Grandchild', parent_project_id: child.value.id }))
      .resolves.toEqual({ ok: false, error: 'hierarchy_depth' })
  })

  it('rejects reparenting that would create a cycle', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    const child = await createProject(env, { slug: 'child', name: 'Child', parent_project_id: root.id })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    await expect(updateProject(env, root.id, { parent_project_id: child.value.id }))
      .resolves.toEqual({ ok: false, error: 'hierarchy_cycle' })
  })

  it('does not reparent a project that already has archived children', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    const child = await createProject(env, { slug: 'child', name: 'Child', parent_project_id: root.id })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const otherRoot = await createRoot(env, 'other-root')
    await updateProject(env, child.value.id, { status: 'archived' })

    await expect(updateProject(env, root.id, { parent_project_id: otherRoot.id }))
      .resolves.toEqual({ ok: false, error: 'hierarchy_depth' })
  })

  it('rejects archiving a parent with active children', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    await createProject(env, { slug: 'child', name: 'Child', parent_project_id: root.id })

    await expect(updateProject(env, root.id, { status: 'archived' }))
      .resolves.toEqual({ ok: false, error: 'active_children' })
  })

  it('makes archived projects immutable except for restoration to active', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    expect(await updateProject(env, root.id, { status: 'archived' })).toMatchObject({ ok: true, value: { status: 'archived' } })

    await expect(updateProject(env, root.id, { name: 'Renamed' }))
      .resolves.toEqual({ ok: false, error: 'archived_project' })
    await expect(updateProject(env, root.id, { status: 'active' }))
      .resolves.toMatchObject({ ok: true, value: { status: 'active' } })
  })

  it('keeps squad access explicit per project and supports upsert and removal', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const root = await createRoot(env)
    const child = await createProject(env, { slug: 'child', name: 'Child', parent_project_id: root.id })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    await expect(upsertProjectSquadAccess(env, root.id, 'squad-1', 'write'))
      .resolves.toMatchObject({ ok: true, value: { project_id: root.id, squad_id: 'squad-1', access_level: 'write' } })
    await expect(upsertProjectSquadAccess(env, root.id, 'squad-1', 'admin'))
      .resolves.toMatchObject({ ok: true, value: { access_level: 'admin' } })
    expect(await listProjectSquads(env, root.id)).toMatchObject([{ squad_id: 'squad-1', access_level: 'admin' }])
    expect(await listProjectSquads(env, child.value.id)).toEqual([])
    await expect(upsertProjectSquadAccess(env, root.id, 'missing', 'write'))
      .resolves.toEqual({ ok: false, error: 'squad_not_found' })
    await expect(upsertProjectSquadAccess(env, root.id, 'squad-2', 'owner'))
      .resolves.toEqual({ ok: false, error: 'invalid_access_level' })
    await expect(removeProjectSquadAccess(env, root.id, 'squad-1')).resolves.toEqual({ ok: true, value: undefined })
    expect(await listProjectSquads(env, root.id)).toEqual([])
  })

  it('maps zero-row write receipts to receipt_failed', async () => {
    const env = {
      DB: {
        prepare() {
          return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
        },
      },
    } as Env

    await expect(createProject(env, { slug: 'project', name: 'Project' }))
      .resolves.toEqual({ ok: false, error: 'receipt_failed' })
  })
})
