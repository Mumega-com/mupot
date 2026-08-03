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
