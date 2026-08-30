import { describe, expect, it } from 'vitest'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { listTaskDispatchReceiptTimeline, recordTaskDispatchRuntimeReceipt } from '../src/tasks/runtime-receipts'
import { invokeTool, mcpActionsApp } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'tenant-runtime-receipt'
const T0 = '2026-08-30T18:00:00.000Z'
const DISPATCH_ID = 'dispatch-runtime-1'
const MESSAGE_ID = 'message-runtime-1'
const TASK_ID = 'task-runtime-1'
const AGENT_ID = 'agent-runtime-1'
const MEMBER_ID = 'member-runtime-1'
const TOKEN_ID = 'token-runtime-1'
const GATE_AGENT_ID = 'agent-gate-1'
const GATE_MEMBER_ID = 'member-gate-1'
const GATE_TOKEN_ID = 'token-gate-1'
const SQUAD_ID = 'squad-runtime-1'
const RUNTIME_ADDRESS = 'hadi-codex'
const RUNTIME_HASH = 'a'.repeat(64)

function runtimeFixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-runtime-1', 'runtime', 'Runtime');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-runtime-1', 'runtime', 'Runtime');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', '${RUNTIME_ADDRESS}', 'Hadi Codex', 'active'),
      ('${GATE_AGENT_ID}', '${SQUAD_ID}', 'independent-gate', 'Independent Gate', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${MEMBER_ID}', 'Runtime Member', 'active', '${TENANT}'),
      ('${GATE_MEMBER_ID}', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-runtime-1', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member'),
      ('cap-gate-1', '${GATE_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${T0}'),
      ('${TENANT}', '${GATE_AGENT_ID}', '${GATE_MEMBER_ID}', '${T0}');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e', 'runtime', 'workspace', '${T0}', NULL,
      '${AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z'
    ), (
      '${GATE_TOKEN_ID}', '${GATE_MEMBER_ID}', 'hash-gate-1', 'gate', 'workspace', '${T0}', NULL,
      '${GATE_AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z'
    );
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gate-grant-1', 'gate:independent', 'agent', '${GATE_AGENT_ID}', '${MEMBER_ID}', '${T0}');
    INSERT INTO tasks (
      id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, created_at, updated_at
    ) VALUES (
      '${TASK_ID}', '${SQUAD_ID}', 'Runtime receipt task', 'Do the work',
      'The exact runtime consumption is receipted.', 'open', '${AGENT_ID}', 'gate:independent', '${T0}', '${T0}'
    );
    INSERT INTO task_dispatch_receipts (
      id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id,
      created_at, claimed_at, consumed_at, attempts, last_error
    ) VALUES (
      '${DISPATCH_ID}', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}',
      'member', '${MEMBER_ID}', '${T0}', '${T0}', '${T0}', 1, NULL
    );
    INSERT INTO agent_messages (
      id, tenant, to_agent, from_agent, from_member, kind, body, request_id,
      created_at, delivery_attempts, lease_expires_at
    ) VALUES (
      '${MESSAGE_ID}', '${TENANT}', '${RUNTIME_ADDRESS}', 'mupot-dispatch', '${MEMBER_ID}',
      'request',
      '{"version":"runtime.dispatch/v1","type":"task_dispatch","task_id":"${TASK_ID}","dispatch_receipt_id":"${DISPATCH_ID}","squad_id":"${SQUAD_ID}","runtime_address":"${RUNTIME_ADDRESS}"}',
      'dispatch-inbox:${DISPATCH_ID}', '${T0}', 1, '2099-01-01T00:00:00.000Z'
    );
  `)

  const auth: AuthContext = {
    userId: MEMBER_ID,
    tenant: TENANT,
    channel: 'workspace',
    role: 'member',
    memberId: MEMBER_ID,
    tokenId: TOKEN_ID,
    boundAgentId: AGENT_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
  }
  const gateAuth: AuthContext = {
    userId: GATE_MEMBER_ID,
    tenant: TENANT,
    channel: 'workspace',
    role: 'member',
    memberId: GATE_MEMBER_ID,
    tokenId: GATE_TOKEN_ID,
    boundAgentId: GATE_AGENT_ID,
    capabilities: [{
      member_id: GATE_MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
  }
  return { harness, env: { TENANT_SLUG: TENANT, DB: harness.db } as Env, auth, gateAuth }
}

describe('task dispatch runtime receipt schema', () => {
  it('anchors each append-only stage to the exact dispatch, task, agent, and inbox message', () => {
    const harness = createSqliteD1()
    try {
      applyAllMigrations(harness.sqlite)
      const columns = harness.sqlite
        .prepare("SELECT name FROM pragma_table_info('task_dispatch_runtime_receipts') ORDER BY cid")
        .all()
        .map((row) => String((row as { name: unknown }).name))

      expect(columns).toEqual([
        'id',
        'tenant',
        'dispatch_receipt_id',
        'task_id',
        'agent_id',
        'message_id',
        'member_id',
        'credential_id',
        'stage',
        'attempt',
        'runtime_address',
        'runtime_receipt_hash',
        'request_digest',
        'artifact_refs_json',
        'artifact_sha256',
        'result',
        'reason',
        'audit_entry_id',
        'created_at',
      ])

      const foreignKeys = harness.sqlite
        .prepare("SELECT [table], [from], [to] FROM pragma_foreign_key_list('task_dispatch_runtime_receipts')")
        .all()
        .map((row) => ({
          table: String((row as Record<string, unknown>).table),
          from: String((row as Record<string, unknown>).from),
          to: String((row as Record<string, unknown>).to),
        }))

      expect(foreignKeys).toEqual(expect.arrayContaining([
        { table: 'task_dispatch_receipts', from: 'dispatch_receipt_id', to: 'id' },
        { table: 'tasks', from: 'task_id', to: 'id' },
        { table: 'agents', from: 'agent_id', to: 'id' },
        { table: 'agent_messages', from: 'message_id', to: 'id' },
        { table: 'members', from: 'member_id', to: 'id' },
        { table: 'member_tokens', from: 'credential_id', to: 'id' },
        { table: 'mutation_audit_entries', from: 'audit_entry_id', to: 'id' },
      ]))
    } finally {
      harness.close()
    }
  })
})

describe('recordTaskDispatchRuntimeReceipt', () => {
  it('records exact runtime consumption and claims the task in progress without completing it', async () => {
    const fixture = runtimeFixture()
    try {
      const result = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      expect(result).toMatchObject({
        receipt: {
          stage: 'runtime_consumed',
          attempt: 1,
          runtime_address: RUNTIME_ADDRESS,
          runtime_receipt_hash: RUNTIME_HASH,
        },
        task_status: 'in_progress',
      })
      expect(fixture.harness.sqlite.prepare(
        'SELECT status, execution_receipt_id FROM tasks WHERE id = ?',
      ).get(TASK_ID)).toEqual({ status: 'in_progress', execution_receipt_id: DISPATCH_ID })
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts',
      ).get()).toEqual({ count: 1 })
    } finally {
      fixture.harness.close()
    }
  })

  it('returns one idempotent receipt and rejects changed content under the same stage attempt', async () => {
    const fixture = runtimeFixture()
    try {
      const input = {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed' as const,
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      }
      const first = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, input)
      const replay = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, input)
      expect(replay.receipt).toEqual(first.receipt)
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts',
      ).get()).toEqual({ count: 1 })

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        ...input,
        runtimeReceiptHash: 'b'.repeat(64),
      })).rejects.toMatchObject({ code: 'runtime_receipt_conflict' })
    } finally {
      fixture.harness.close()
    }
  })

  it('returns the original receipt after the source inbox row is acknowledged', async () => {
    const fixture = runtimeFixture()
    try {
      const input = {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed' as const,
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      }
      const first = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, input)
      fixture.harness.sqlite.prepare(
        'UPDATE agent_messages SET read_at = ?, lease_expires_at = NULL WHERE id = ?',
      ).run('2026-08-30T18:05:00.000Z', MESSAGE_ID)
      const replay = await recordTaskDispatchRuntimeReceipt({ ...fixture.env }, fixture.auth, input)
      expect(replay.receipt).toEqual(first.receipt)
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts',
      ).get()).toEqual({ count: 1 })
    } finally {
      fixture.harness.close()
    }
  })

  it('reauthorizes an idempotent replay and refuses it after capability revocation', async () => {
    const fixture = runtimeFixture()
    try {
      const input = {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed' as const,
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      }
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, input)
      fixture.harness.sqlite.prepare('DELETE FROM capabilities WHERE member_id = ?').run(MEMBER_ID)
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, input))
        .rejects.toMatchObject({ code: 'runtime_receipt_forbidden' })
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts',
      ).get()).toEqual({ count: 1 })
    } finally {
      fixture.harness.close()
    }
  })

  it('refuses completion before the same attempt has a runtime-consumed receipt', async () => {
    const fixture = runtimeFixture()
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'completed',
        runtimeReceiptHash: 'c'.repeat(64),
        attempt: 1,
        result: 'Implemented and tested.',
      })).rejects.toMatchObject({ code: 'runtime_receipt_transition_conflict' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'open' })
    } finally {
      fixture.harness.close()
    }
  })

  it('records completion only after consumption and moves work to review, never done', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      const completed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'completed',
        runtimeReceiptHash: 'd'.repeat(64),
        attempt: 1,
        result: 'Implemented and tested.',
      })
      expect(completed).toMatchObject({ receipt: { stage: 'completed' }, task_status: 'review' })
      expect(fixture.harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'review', result: 'Implemented and tested.' })
    } finally {
      fixture.harness.close()
    }
  })

  it('refuses runtime completion when the task has no independent gate owner', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare('UPDATE tasks SET gate_owner = NULL WHERE id = ?').run(TASK_ID)
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'completed', runtimeReceiptHash: '9'.repeat(64), attempt: 1,
        result: 'Completed but ungated.',
      })).rejects.toMatchObject({ code: 'runtime_gate_required' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'in_progress' })
    } finally {
      fixture.harness.close()
    }
  })

  it.each([
    {
      name: 'nonexistent gate grant',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.prepare("UPDATE tasks SET gate_owner = 'gate:missing' WHERE id = ?").run(TASK_ID)
      },
    },
    {
      name: 'gate held only by the assignee',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.exec(`
          DELETE FROM gate_grants;
          INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
          VALUES ('gate-self-only', 'gate:self-only', 'agent', '${AGENT_ID}', '${MEMBER_ID}', '${T0}');
          UPDATE tasks SET gate_owner = 'gate:self-only' WHERE id = '${TASK_ID}';
        `)
      },
    },
    {
      name: 'self-completion gate',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.prepare(
          "UPDATE tasks SET gate_owner = 'gate:agent-self-completion' WHERE id = ?",
        ).run(TASK_ID)
      },
    },
    {
      name: 'revoked gate credential',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.prepare('UPDATE member_tokens SET revoked_at = ? WHERE id = ?')
          .run(T0, GATE_TOKEN_ID)
      },
    },
    {
      name: 'inactive gate agent',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.prepare("UPDATE agents SET status = 'paused' WHERE id = ?")
          .run(GATE_AGENT_ID)
      },
    },
  ])('refuses completion for $name', async ({ mutate }) => {
    const fixture = runtimeFixture()
    try {
      mutate(fixture)
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'completed', runtimeReceiptHash: 'b'.repeat(64), attempt: 1,
        result: 'Must not enter zombie review.',
      })).rejects.toMatchObject({ code: 'runtime_gate_required' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'in_progress' })
    } finally {
      fixture.harness.close()
    }
  })

  it('fails atomically when the independent gate credential is revoked after precheck', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      let flipped = false
      const racedDb = {
        ...fixture.env.DB,
        prepare: fixture.env.DB.prepare.bind(fixture.env.DB),
        batch: async (statements: Parameters<Env['DB']['batch']>[0]) => {
          if (!flipped) {
            flipped = true
            fixture.harness.sqlite.prepare('UPDATE member_tokens SET revoked_at = ? WHERE id = ?')
              .run(T0, GATE_TOKEN_ID)
          }
          return fixture.env.DB.batch(statements)
        },
      } as Env['DB']
      await expect(recordTaskDispatchRuntimeReceipt(
        { ...fixture.env, DB: racedDb },
        fixture.auth,
        {
          taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
          stage: 'completed', runtimeReceiptHash: 'c'.repeat(64), attempt: 1,
          result: 'Race must roll back.',
        },
      )).rejects.toMatchObject({ code: 'runtime_receipt_transition_conflict' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'in_progress' })
      expect(fixture.harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts WHERE stage = 'completed'",
      ).get()).toEqual({ count: 0 })
    } finally {
      fixture.harness.close()
    }
  })

  it('moves runtime completion through review to a different granted gate agent verdict', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'completed', runtimeReceiptHash: 'a'.repeat(64), attempt: 1,
        result: 'Ready for independent review.',
      })
      const verdict = await invokeTool(
        fixture.gateAuth,
        fixture.env,
        'task_verdict',
        { task_id: TASK_ID, verdict: 'approved', note: 'Independent gate PASS' },
        'https://pot.test',
      )
      expect(verdict).toMatchObject({ ok: true, result: { task: { status: 'approved' } } })
      expect(fixture.harness.sqlite.prepare(
        'SELECT verdict, decided_by FROM task_verdicts WHERE task_id = ?',
      ).get(TASK_ID)).toEqual({ verdict: 'approved', decided_by: GATE_AGENT_ID })
    } finally {
      fixture.harness.close()
    }
  })

  it('records a bounded failure and moves current work to blocked without redispatch', async () => {
    const fixture = runtimeFixture()
    try {
      const failed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'failed',
        runtimeReceiptHash: 'e'.repeat(64),
        attempt: 1,
        reason: 'Runtime stopped before producing an artifact.',
      })
      expect(failed).toMatchObject({ receipt: { stage: 'failed' }, task_status: 'blocked' })
      expect(fixture.harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'blocked', result: 'Runtime stopped before producing an artifact.' })
      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM task_dispatch_receipts',
      ).get()).toEqual({ count: 1 })
    } finally {
      fixture.harness.close()
    }
  })

  it('terminally fences failed then runtime_consumed for the same dispatch attempt', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'failed',
        runtimeReceiptHash: '3'.repeat(64),
        attempt: 1,
        reason: 'Runtime failed before consumption.',
      })
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: '4'.repeat(64),
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_receipt_transition_conflict' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'blocked' })
      expect(fixture.harness.sqlite.prepare(
        'SELECT stage FROM task_dispatch_runtime_receipts ORDER BY created_at, id',
      ).all()).toEqual([{ stage: 'failed' }])
    } finally {
      fixture.harness.close()
    }
  })

  it('keeps the failed fence across restart and a re-lease as attempt two', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'failed',
        runtimeReceiptHash: '5'.repeat(64),
        attempt: 1,
        reason: 'Host stopped.',
      })
      fixture.harness.sqlite.prepare(
        'UPDATE agent_messages SET read_at = NULL, lease_expires_at = ?, delivery_attempts = 2 WHERE id = ?',
      ).run('2099-01-01T00:00:00.000Z', MESSAGE_ID)
      const restartedEnv = { ...fixture.env }
      await expect(recordTaskDispatchRuntimeReceipt(restartedEnv, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: '6'.repeat(64),
        attempt: 2,
      })).rejects.toMatchObject({ code: 'runtime_receipt_transition_conflict' })
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'blocked' })
    } finally {
      fixture.harness.close()
    }
  })

  it('rejects concurrent attempt-two consumption after attempt one failed', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'failed',
        runtimeReceiptHash: '7'.repeat(64),
        attempt: 1,
        reason: 'Concurrent failure won.',
      })
      fixture.harness.sqlite.prepare(
        'UPDATE agent_messages SET lease_expires_at = ?, delivery_attempts = 2 WHERE id = ?',
      ).run('2099-01-01T00:00:00.000Z', MESSAGE_ID)
      const consume = () => recordTaskDispatchRuntimeReceipt({ ...fixture.env }, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: '8'.repeat(64),
        attempt: 2,
      })
      const outcomes = await Promise.allSettled([consume(), consume()])
      expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
      expect(fixture.harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'blocked' })
      expect(fixture.harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts WHERE stage = 'failed'",
      ).get()).toEqual({ count: 1 })
    } finally {
      fixture.harness.close()
    }
  })

  it('requires matching Artifact and SHA256 evidence when the task contract asks for them', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(
        "UPDATE tasks SET done_when = 'Artifact: path and SHA256: digest are reported.' WHERE id = ?",
      ).run(TASK_ID)
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'completed',
        runtimeReceiptHash: 'f'.repeat(64),
        attempt: 1,
        result: 'Implemented and tested.',
      })).rejects.toMatchObject({ code: 'runtime_artifact_required' })

      const sha = '1'.repeat(64)
      const completed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'completed',
        runtimeReceiptHash: 'f'.repeat(64),
        attempt: 1,
        result: `Artifact: docs/runtime-receipt.md\nSHA256: ${sha}`,
        artifactRefs: ['docs/runtime-receipt.md'],
        artifactSha256: sha,
      })
      expect(completed).toMatchObject({
        task_status: 'review',
        receipt: {
          artifact_refs: ['docs/runtime-receipt.md'],
          artifact_sha256: sha,
        },
      })
    } finally {
      fixture.harness.close()
    }
  })

  it('uses the same service through MCP and the bearer REST Actions surface', async () => {
    const mcpFixture = runtimeFixture()
    const restFixture = runtimeFixture()
    const args = {
      task_id: TASK_ID,
      dispatch_receipt_id: DISPATCH_ID,
      message_id: MESSAGE_ID,
      stage: 'runtime_consumed',
      runtime_receipt_hash: RUNTIME_HASH,
      attempt: 1,
    }
    try {
      const mcp = await invokeTool(
        mcpFixture.auth,
        mcpFixture.env,
        'task_dispatch_runtime_receipt',
        args,
        'https://pot.test',
      )
      expect(mcp).toMatchObject({
        ok: true,
        result: { receipt: { stage: 'runtime_consumed' }, task_status: 'in_progress' },
      })

      const response = await mcpActionsApp.request(
        'https://pot.test/actions/task_dispatch_runtime_receipt',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(args),
        },
        restFixture.env,
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        result: { receipt: { stage: 'runtime_consumed' }, task_status: 'in_progress' },
      })
      expect(Object.keys((mcp.result as { receipt: Record<string, unknown> }).receipt).sort()).toEqual([
        'artifact_refs', 'artifact_sha256', 'attempt', 'created_at', 'reason', 'result',
        'runtime_address', 'runtime_receipt_hash', 'stage',
      ])
      expect(mcpFixture.harness.sqlite.prepare(
        "SELECT origin FROM mutation_audit_entries WHERE handler = 'task_dispatch_runtime_receipt'",
      ).get()).toEqual({ origin: 'mcp' })
      expect(restFixture.harness.sqlite.prepare(
        "SELECT origin FROM mutation_audit_entries WHERE handler = 'task_dispatch_runtime_receipt'",
      ).get()).toEqual({ origin: 'rest' })
    } finally {
      mcpFixture.harness.close()
      restFixture.harness.close()
    }
  })

  it('MCP and REST both reject completion through a nonexistent gate', async () => {
    const mcpFixture = runtimeFixture()
    const restFixture = runtimeFixture()
    try {
      for (const fixture of [mcpFixture, restFixture]) {
        fixture.harness.sqlite.prepare("UPDATE tasks SET gate_owner = 'gate:missing' WHERE id = ?")
          .run(TASK_ID)
        await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
          taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
          stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
        })
      }
      const args = {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, message_id: MESSAGE_ID,
        stage: 'completed', runtime_receipt_hash: 'd'.repeat(64), attempt: 1,
        result: 'Must remain in progress.',
      }
      const mcp = await invokeTool(
        mcpFixture.auth, mcpFixture.env, 'task_dispatch_runtime_receipt', args, 'https://pot.test',
      )
      expect(mcp).toMatchObject({ ok: false, status: 409, error: 'runtime_gate_required' })

      const response = await mcpActionsApp.request(
        'https://pot.test/actions/task_dispatch_runtime_receipt',
        {
          method: 'POST',
          headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
          body: JSON.stringify(args),
        },
        restFixture.env,
      )
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'runtime_gate_required' })
    } finally {
      mcpFixture.harness.close()
      restFixture.harness.close()
    }
  })

  it('reads transport and runtime stages independently for one visible task', async () => {
    const fixture = runtimeFixture()
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'completed',
        runtimeReceiptHash: '2'.repeat(64),
        attempt: 1,
        result: 'Implemented and tested.',
      })

      const timeline = await listTaskDispatchReceiptTimeline(fixture.env, TASK_ID)
      expect(timeline.transport).toEqual([{
        agent_slug: RUNTIME_ADDRESS,
        agent_name: 'Hadi Codex',
        dispatched_at: T0,
        transport_delivered_at: T0,
      }])
      expect(timeline.transport[0]).not.toHaveProperty('agent_id')
      expect(timeline.runtime.map((receipt) => receipt.stage)).toEqual([
        'runtime_consumed',
        'completed',
      ])
      expect(timeline.runtime[0]).toEqual({
        stage: 'runtime_consumed',
        attempt: 1,
        runtime_address: RUNTIME_ADDRESS,
        runtime_receipt_hash: RUNTIME_HASH,
        artifact_refs: [],
        artifact_sha256: null,
        result: null,
        reason: null,
        created_at: expect.any(String),
      })
      expect(timeline.runtime[0]).not.toHaveProperty('credential_id')
      expect(timeline.runtime[0]).not.toHaveProperty('audit_entry_id')
      expect(timeline.runtime[0]).not.toHaveProperty('message_id')
      expect(timeline.runtime[0]).not.toHaveProperty('dispatch_receipt_id')
      expect(timeline.runtime[0]).not.toHaveProperty('id')
      expect(timeline.task_status).toBe('review')
    } finally {
      fixture.harness.close()
    }
  })
})
