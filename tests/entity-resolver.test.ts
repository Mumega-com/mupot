import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { resolveEntity } from '../src/lib/entity-resolver'
import { getSquad, getAgent, getTask } from '../src/mcp/index'
import type { Env } from '../src/types'

describe('entity-resolver — fail-closed short-UUID prefix resolution (real schema)', () => {
  function makeHarness() {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const env = {
      TENANT_SLUG: 'mumega',
      DB: harness.db,
    } as unknown as Env

    return { harness, env }
  }

  it('resolves exact UUID match', async () => {
    const { harness, env } = makeHarness()
    const agentId = '17aa283f-8cdb-4c1f-864f-1974ee45a033'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, tenant) VALUES ('dept-1', 'eng', 'Engineering', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad', 'Build core', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${agentId}', 'squad-1', 'loom', 'Loom', 'Lead', 'gemini', 'active', 'mumega');
    `)

    const res = await resolveEntity<{ id: string; name: string }>(
      env,
      'agents',
      agentId,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.entity.name).toBe('Loom')
      expect(res.entity.id).toBe(agentId)
    }
  })

  it('resolves unique 8-char short prefix', async () => {
    const { harness, env } = makeHarness()
    const agentId = '17aa283f-8cdb-4c1f-864f-1974ee45a033'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, tenant) VALUES ('dept-1', 'eng', 'Engineering', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad', 'Build core', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${agentId}', 'squad-1', 'loom', 'Loom', 'Lead', 'gemini', 'active', 'mumega');
    `)

    const res = await resolveEntity<{ id: string; name: string }>(
      env,
      'agents',
      '17aa283f',
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.entity.id).toBe(agentId)
      expect(res.entity.name).toBe('Loom')
    }
  })

  it('fails closed with not_found when prefix < 8 chars', async () => {
    const { harness, env } = makeHarness()
    const agentId = '17aa283f-8cdb-4c1f-864f-1974ee45a033'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, tenant) VALUES ('dept-1', 'eng', 'Engineering', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad', 'Build core', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${agentId}', 'squad-1', 'loom', 'Loom', 'Lead', 'gemini', 'active', 'mumega');
    `)

    const res = await resolveEntity<{ id: string }>(env, 'agents', '17aa28')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('not_found')
    }
  })

  it('fails closed with ambiguous and returns candidate IDs when multiple match', async () => {
    const { harness, env } = makeHarness()
    const id1 = 'ambig123-1111-4444-8888-aaaaaaaaaaaa'
    const id2 = 'ambig123-2222-4444-8888-bbbbbbbbbbbb'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, tenant) VALUES ('dept-1', 'eng', 'Engineering', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad', 'Build core', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${id1}', 'squad-1', 'a1', 'Agent 1', 'Lead', 'gemini', 'active', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${id2}', 'squad-1', 'a2', 'Agent 2', 'Lead', 'gemini', 'active', 'mumega');
    `)

    const res = await resolveEntity<{ id: string }>(env, 'agents', 'ambig123')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('ambiguous')
      if (res.reason === 'ambiguous') {
        expect(res.candidates.length).toBe(2)
        expect(res.candidates).toContain(id1)
        expect(res.candidates).toContain(id2)
      }
    }
  })

  it('integration: getSquad, getAgent, and getTask propagate 409 ambiguous status and candidates instead of flattening to 404 not_found', async () => {
    const { harness, env } = makeHarness()
    const squad1 = 'ambig123-sq11-4444-8888-aaaaaaaaaaaa'
    const squad2 = 'ambig123-sq22-4444-8888-bbbbbbbbbbbb'
    const agent1 = 'ambig123-ag11-4444-8888-aaaaaaaaaaaa'
    const agent2 = 'ambig123-ag22-4444-8888-bbbbbbbbbbbb'
    const task1 = 'ambig123-tk11-4444-8888-aaaaaaaaaaaa'
    const task2 = 'ambig123-tk22-4444-8888-bbbbbbbbbbbb'

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, tenant) VALUES ('dept-1', 'eng', 'Engineering', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('${squad1}', 'dept-1', 's1', 'Squad 1', 'C1', 'mumega');
      INSERT INTO squads (id, department_id, slug, name, charter, tenant) VALUES ('${squad2}', 'dept-1', 's2', 'Squad 2', 'C2', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${agent1}', '${squad1}', 'a1', 'Agent 1', 'Lead', 'gemini', 'active', 'mumega');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, tenant) VALUES ('${agent2}', '${squad1}', 'a2', 'Agent 2', 'Lead', 'gemini', 'active', 'mumega');
      INSERT INTO tasks (id, squad_id, title, done_when, status, tenant, created_at, updated_at) VALUES ('${task1}', '${squad1}', 'Task 1', 'Pass 1', 'open', 'mumega', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
      INSERT INTO tasks (id, squad_id, title, done_when, status, tenant, created_at, updated_at) VALUES ('${task2}', '${squad1}', 'Task 2', 'Pass 2', 'open', 'mumega', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
    `)

    const squadOutcome = await getSquad(env, 'ambig123')
    expect(squadOutcome.ok).toBe(false)
    if (!squadOutcome.ok) {
      expect(squadOutcome.status).toBe(409)
      expect(squadOutcome.error).toBe('ambiguous_squad_id')
      expect((squadOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
      expect((squadOutcome.detail as { candidates: string[] }).candidates).toContain(squad1)
      expect((squadOutcome.detail as { candidates: string[] }).candidates).toContain(squad2)
    }

    const agentOutcome = await getAgent(env, 'ambig123')
    expect(agentOutcome.ok).toBe(false)
    if (!agentOutcome.ok) {
      expect(agentOutcome.status).toBe(409)
      expect(agentOutcome.error).toBe('ambiguous_agent_id')
      expect((agentOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
      expect((agentOutcome.detail as { candidates: string[] }).candidates).toContain(agent1)
      expect((agentOutcome.detail as { candidates: string[] }).candidates).toContain(agent2)
    }

    const taskOutcome = await getTask(env, 'ambig123')
    expect(taskOutcome.ok).toBe(false)
    if (!taskOutcome.ok) {
      expect(taskOutcome.status).toBe(409)
      expect(taskOutcome.error).toBe('ambiguous_task_id')
      expect((taskOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
      expect((taskOutcome.detail as { candidates: string[] }).candidates).toContain(task1)
      expect((taskOutcome.detail as { candidates: string[] }).candidates).toContain(task2)
    }
  })
})
