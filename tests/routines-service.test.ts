import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import {
  archiveRoutine,
  createManualRoutineRun,
  createRoutine,
  enableRoutine,
  getRoutine,
  getRoutineRun,
  listRoutineRuns,
  listRoutines,
  pauseRoutine,
  updateRoutine,
} from '../src/routines/service'
import { routinePrincipal } from '../src/routines/access'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-1', 'dept-1', 'core', 'Core'),
      ('squad-2', 'dept-1', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-1', 'squad-1', 'worker', 'Worker', 'active'),
      ('agent-2', 'squad-2', 'other', 'Other', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active'),
      ('project-paused', 'project-paused', 'Paused', 'paused');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-a', 'squad-1', 'write'),
      ('project-b', 'squad-2', 'write'),
      ('project-paused', 'squad-1', 'write');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, tenant = 'tenant-a'): Env {
  return { DB: harness.db, TENANT_SLUG: tenant } as Env
}

function auth(grants?: CapabilityGrant[], role: AuthContext['role'] = 'member'): AuthContext {
  return {
    userId: 'user-1', email: 'user@example.test', role, tenant: 'tenant-a',
    memberId: 'member-1', capabilities: grants,
  }
}

const memberGrant: CapabilityGrant = {
  member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member',
}
const observerGrant: CapabilityGrant = {
  member_id: 'member-2', scope_type: 'squad', scope_id: 'squad-1', capability: 'observer',
}

function owner() {
  return routinePrincipal(auth(undefined, 'owner'))
}

function member() {
  return routinePrincipal(auth([memberGrant]))
}

function observer() {
  return routinePrincipal({ ...auth([observerGrant]), memberId: 'member-2', userId: 'user-2' })
}

const manualInput = {
  project_id: 'project-a',
  name: 'Keep momentum',
  objective: 'Choose one accountable next action',
  trigger_kind: 'manual',
  timezone: 'UTC',
  responsible_squad_id: 'squad-1',
  budget_micro_usd: 250_000,
}

describe('routine policy service', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('allows only workspace admins to create and mutate policy', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    expect(await createRoutine(env, member(), manualInput)).toEqual({ ok: false, error: 'forbidden' })

    const created = await createRoutine(env, owner(), manualInput)
    expect(created).toMatchObject({ ok: true, value: { status: 'draft', revision: 1 } })
    if (!created.ok) return
    expect(await enableRoutine(env, member(), created.value.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await enableRoutine(env, owner(), created.value.id)).toMatchObject({
      ok: true, value: { status: 'enabled', revision: 2, enabled_by: 'member-1' },
    })
    expect(await pauseRoutine(env, owner(), created.value.id)).toMatchObject({
      ok: true, value: { status: 'paused', revision: 3 },
    })
    expect(await archiveRoutine(env, owner(), created.value.id)).toMatchObject({
      ok: true, value: { status: 'archived', revision: 4 },
    })
  })

  it('hides routines outside tenant and Project readability', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const createdA = await createRoutine(env, owner(), manualInput)
    const createdB = await createRoutine(env, owner(), {
      ...manualInput, project_id: 'project-b', responsible_squad_id: 'squad-2', name: 'Hidden routine',
    })
    if (!createdA.ok || !createdB.ok) throw new Error('fixture creation failed')

    expect(await getRoutine(env, observer(), createdA.value.id)).toMatchObject({ id: createdA.value.id })
    expect(await getRoutine(env, observer(), createdB.value.id)).toBeNull()
    expect(await getRoutine(envFor(harness, 'tenant-b'), owner(), createdA.value.id)).toBeNull()
    expect(await listRoutines(env, observer(), { project_id: 'project-a', limit: 20 })).toMatchObject({
      ok: true, items: [{ id: createdA.value.id }], next_cursor: null,
    })
    expect(await listRoutines(env, observer(), { project_id: 'project-b', limit: 20 }))
      .toEqual({ ok: false, error: 'project_not_found' })
  })

  it('validates responsible squad, preferred agent, schedule, budget, and list bounds', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    expect(await createRoutine(env, owner(), { ...manualInput, responsible_squad_id: 'squad-2' }))
      .toEqual({ ok: false, error: 'responsible_squad_forbidden' })
    expect(await createRoutine(env, owner(), { ...manualInput, preferred_agent_id: 'agent-2' }))
      .toEqual({ ok: false, error: 'preferred_agent_ineligible' })
    expect(await createRoutine(env, owner(), { ...manualInput, budget_micro_usd: -1 }))
      .toEqual({ ok: false, error: 'invalid_budget' })
    expect(await createRoutine(env, owner(), {
      ...manualInput, trigger_kind: 'cron', cron_expression: '* * * * * *',
    })).toEqual({ ok: false, error: 'invalid_cron_expression' })
    expect(await createRoutine(env, owner(), { ...manualInput, trigger_kind: 'cron' }))
      .toEqual({ ok: false, error: 'invalid_cron_expression' })
    expect(await createRoutine(env, owner(), { ...manualInput, trigger_kind: 'once' }))
      .toEqual({ ok: false, error: 'invalid_once_at' })
    expect(await listRoutines(env, owner(), { project_id: 'project-a', limit: 101 }))
      .toEqual({ ok: false, error: 'invalid_pagination' })
  })

  it('increments revisions while preserving immutable run policy snapshots', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createRoutine(env, owner(), manualInput)
    if (!created.ok) throw new Error(created.error)
    const enabled = await enableRoutine(env, owner(), created.value.id)
    if (!enabled.ok) throw new Error(enabled.error)
    const run = await createManualRoutineRun(env, member(), enabled.value.id, 'manual-key-1')
    if (!run.ok) throw new Error(run.error)

    const updated = await updateRoutine(env, owner(), enabled.value.id, { budget_micro_usd: 900_000 })
    expect(updated).toMatchObject({ ok: true, value: { revision: 3, budget_micro_usd: 900_000 } })
    const storedRun = await getRoutineRun(env, member(), run.value.id)
    expect(JSON.parse(storedRun?.policy_json ?? '{}')).toMatchObject({
      execution_mode: 'propose', budget_micro_usd: 250_000, responsible_squad_id: 'squad-1',
    })
  })

  it('creates one manual occurrence for an identical idempotency key', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createRoutine(env, owner(), manualInput)
    if (!created.ok) throw new Error(created.error)
    const enabled = await enableRoutine(env, owner(), created.value.id)
    if (!enabled.ok) throw new Error(enabled.error)

    const first = await createManualRoutineRun(env, member(), enabled.value.id, 'manual-key-1')
    const replay = await createManualRoutineRun(env, member(), enabled.value.id, 'manual-key-1')
    expect(first).toMatchObject({ ok: true, duplicate: false })
    expect(replay).toMatchObject({ ok: true, duplicate: true })
    if (first.ok && replay.ok) expect(replay.value.id).toBe(first.value.id)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM routine_runs').get()).toEqual({ count: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM routine_run_events').get()).toEqual({ count: 1 })
  })

  it('stops creating manual occurrences at max_occurrences or stop_at', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const capped = await createRoutine(env, owner(), { ...manualInput, max_occurrences: 1 })
    if (!capped.ok) throw new Error(capped.error)
    const enabledCapped = await enableRoutine(env, owner(), capped.value.id)
    if (!enabledCapped.ok) throw new Error(enabledCapped.error)
    expect(await createManualRoutineRun(env, member(), enabledCapped.value.id, 'first'))
      .toMatchObject({ ok: true })
    expect(await createManualRoutineRun(env, member(), enabledCapped.value.id, 'second'))
      .toEqual({ ok: false, error: 'schedule_exhausted' })

    const stopped = await createRoutine(env, owner(), {
      ...manualInput,
      name: 'Stopped routine',
      stop_at: '2026-01-01T00:00:00.000Z',
    })
    if (!stopped.ok) throw new Error(stopped.error)
    const enabledStopped = await enableRoutine(env, owner(), stopped.value.id)
    if (!enabledStopped.ok) throw new Error(enabledStopped.error)
    expect(await createManualRoutineRun(env, member(), enabledStopped.value.id, 'after-stop'))
      .toEqual({ ok: false, error: 'schedule_exhausted' })
  })

  it('rejects manual runs for inactive Projects, disabled routines, and under-authorized callers', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const draft = await createRoutine(env, owner(), manualInput)
    if (!draft.ok) throw new Error(draft.error)
    expect(await createManualRoutineRun(env, member(), draft.value.id, 'draft-key'))
      .toEqual({ ok: false, error: 'routine_not_enabled' })
    expect(await createManualRoutineRun(env, observer(), draft.value.id, 'observer-key'))
      .toEqual({ ok: false, error: 'routine_not_enabled' })

    const pausedProjectRoutine = await createRoutine(env, owner(), {
      ...manualInput, project_id: 'project-paused', name: 'Paused project',
    })
    if (!pausedProjectRoutine.ok) throw new Error(pausedProjectRoutine.error)
    expect(await enableRoutine(env, owner(), pausedProjectRoutine.value.id))
      .toEqual({ ok: false, error: 'project_not_active' })

    const enabled = await enableRoutine(env, owner(), draft.value.id)
    if (!enabled.ok) throw new Error(enabled.error)
    expect(await createManualRoutineRun(env, observer(), enabled.value.id, 'observer-key'))
      .toEqual({ ok: false, error: 'forbidden' })
  })

  it('bounds and cursors run history', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createRoutine(env, owner(), manualInput)
    if (!created.ok) throw new Error(created.error)
    const enabled = await enableRoutine(env, owner(), created.value.id)
    if (!enabled.ok) throw new Error(enabled.error)
    await createManualRoutineRun(env, member(), enabled.value.id, 'manual-key-1')
    await createManualRoutineRun(env, member(), enabled.value.id, 'manual-key-2')

    const firstPage = await listRoutineRuns(env, member(), {
      project_id: 'project-a', routine_id: enabled.value.id, limit: 1,
    })
    expect(firstPage).toMatchObject({ ok: true, items: [expect.any(Object)], next_cursor: expect.any(Object) })
    if (!firstPage.ok || !firstPage.next_cursor) return
    const secondPage = await listRoutineRuns(env, member(), {
      project_id: 'project-a', routine_id: enabled.value.id, limit: 1, after: firstPage.next_cursor,
    })
    expect(secondPage).toMatchObject({ ok: true, items: [expect.any(Object)], next_cursor: null })
    if (secondPage.ok) expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id)
  })
})
