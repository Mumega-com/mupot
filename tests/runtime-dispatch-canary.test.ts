import { describe, expect, it } from 'vitest'

import { listTaskDispatchReceiptTimeline, recordTaskDispatchRuntimeReceipt } from '../src/tasks/runtime-receipts'
import { writeVerdict } from '../src/tasks/service'
import type { AuthContext, Env, Task } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const TENANT = 'tenant-canary'
const TASK = 'task-canary'
const DISPATCH = 'dispatch-canary'
const MESSAGE = 'message-canary'
const AGENT = 'agent-canary'
const MEMBER = 'member-canary'
const TOKEN = 'token-canary'
const SQUAD = 'squad-canary'
const ADDRESS = 'codex-canary'
const T0 = '2026-08-30T18:00:00.000Z'

function canary() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('department-canary', 'canary', 'Canary');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD}', 'department-canary', 'canary', 'Canary');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT}', '${SQUAD}', '${ADDRESS}', 'Codex Canary', 'active'),
      ('agent-gate', '${SQUAD}', 'hadi-grok-canary', 'Hadi Grok Canary', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${MEMBER}', 'Canary Member', 'active', '${TENANT}'),
      ('member-gate', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-canary', '${MEMBER}', 'squad', '${SQUAD}', 'member'),
      ('cap-gate', 'member-gate', 'squad', '${SQUAD}', 'lead');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT}', '${MEMBER}', '${T0}'),
      ('${TENANT}', 'agent-gate', 'member-gate', '${T0}');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN}', '${MEMBER}', 'hash-canary', 'canary', 'workspace', '${T0}',
      '${AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner,
      created_at, updated_at
    ) VALUES (
      '${TASK}', '${SQUAD}', 'Synthetic runtime canary', 'Synthetic local-only work',
      'One runtime receipt and one independent verdict exist.', 'open', '${AGENT}',
      'gate:agent:agent-gate', '${T0}', '${T0}'
    );
    INSERT INTO task_dispatch_receipts (
      id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id,
      created_at, claimed_at, consumed_at, attempts
    ) VALUES (
      '${DISPATCH}', '${TENANT}', '${TASK}', '${SQUAD}', '${AGENT}', 'member',
      '${MEMBER}', '${T0}', '${T0}', '${T0}', 1
    );
    INSERT INTO agent_messages (
      id, tenant, to_agent, from_agent, from_member, kind, body, request_id,
      created_at, delivery_attempts, lease_expires_at
    ) VALUES (
      '${MESSAGE}', '${TENANT}', '${ADDRESS}', 'mupot-dispatch', '${MEMBER}', 'request',
      '{"version":"runtime.dispatch/v1","type":"task_dispatch","task_id":"${TASK}","dispatch_receipt_id":"${DISPATCH}","squad_id":"${SQUAD}","runtime_address":"${ADDRESS}"}',
      'dispatch-inbox:${DISPATCH}', '${T0}', 1, '2099-01-01T00:00:00.000Z'
    );
  `)
  const auth: AuthContext = {
    userId: MEMBER,
    tenant: TENANT,
    channel: 'workspace',
    role: 'member',
    memberId: MEMBER,
    tokenId: TOKEN,
    boundAgentId: AGENT,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
  }
  const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  return { harness, auth, env }
}

describe('runtime.dispatch/v1 synthetic restart canary', () => {
  it('persists one transport, consumption, completion, review, and independent gate chain', async () => {
    const fixture = canary()
    try {
      const consumedInput = {
        taskId: TASK,
        dispatchReceiptId: DISPATCH,
        messageId: MESSAGE,
        stage: 'runtime_consumed' as const,
        runtimeReceiptHash: 'a'.repeat(64),
        attempt: 1,
      }
      const consumed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, consumedInput)
      const restartedEnv = { ...fixture.env }
      const consumedReplay = await recordTaskDispatchRuntimeReceipt(restartedEnv, fixture.auth, consumedInput)
      expect(consumedReplay.receipt).toEqual(consumed.receipt)

      const completedInput = {
        ...consumedInput,
        stage: 'completed' as const,
        runtimeReceiptHash: 'b'.repeat(64),
        result: 'Synthetic work completed.',
      }
      const completed = await recordTaskDispatchRuntimeReceipt(restartedEnv, fixture.auth, completedInput)
      const completionReplay = await recordTaskDispatchRuntimeReceipt({ ...fixture.env }, fixture.auth, completedInput)
      expect(completionReplay.receipt).toEqual(completed.receipt)

      const task = fixture.harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK) as Task
      expect(task.status).toBe('review')
      await writeVerdict(
        fixture.env,
        { task, verdict: 'approved', note: 'Synthetic independent gate PASS', decidedBy: 'agent-gate' },
        { kind: 'agent', id: 'agent-gate' },
      )

      const timeline = await listTaskDispatchReceiptTimeline({ ...fixture.env }, TASK)
      expect(timeline.transport).toHaveLength(1)
      expect(timeline.runtime.map((receipt) => receipt.stage)).toEqual(['runtime_consumed', 'completed'])
      expect(timeline.gate).toEqual([
        expect.objectContaining({ verdict: 'approved', decided_by_display: 'Hadi Grok Canary' }),
      ])
      expect(timeline.gate[0]).not.toHaveProperty('decided_by')
      expect(timeline.task_status).toBe('approved')
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts',
      ).get()).toEqual({ count: 2 })
    } finally {
      fixture.harness.close()
    }
  })
})
