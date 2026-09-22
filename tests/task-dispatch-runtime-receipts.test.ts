import { describe, expect, it } from 'vitest'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { listTaskDispatchReceiptTimeline, recordTaskDispatchRuntimeReceipt } from '../src/tasks/runtime-receipts'
import { invokeTool, mcpActionsApp } from '../src/mcp'
import { leaseAgentInbox } from '../src/agents/messages'
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

// mupot#1494 round 2 (P1-a, adversarial gate note) — `unleased: true` seeds the agent_messages
// row in the state `deliverDispatchToInbox`/`sendAgentMessage` ACTUALLY produces at write time
// (delivery_attempts=0, lease_expires_at=NULL — the 0090 migration's real INSERT defaults),
// not the pre-leased state (delivery_attempts=1, a 2099 lease) the default fixture below uses
// to simulate "a resident agent already called inbox_lease". A task_list-only runner NEVER
// calls inbox_lease, so its message is genuinely, exactly in this unleased state — the earlier
// (round-1) task_id+dispatch_receipt_id tests all built on the pre-leased default, which is
// why they passed while the real production path (never leased) still failed.
function runtimeFixture(opts: { unleased?: boolean } = {}) {
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
      'dispatch-inbox:${DISPATCH_ID}', '${T0}',
      ${opts.unleased ? '0' : '1'}, ${opts.unleased ? 'NULL' : "'2099-01-01T00:00:00.000Z'"}
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
    {
      name: 'cross-squad gate without task-squad member authority',
      mutate: (fixture: ReturnType<typeof runtimeFixture>) => {
        fixture.harness.sqlite.exec(`
          INSERT INTO squads (id, department_id, slug, name)
          VALUES ('squad-gate-only', 'department-runtime-1', 'gate-only', 'Gate Only');
          UPDATE agents SET squad_id = 'squad-gate-only' WHERE id = '${GATE_AGENT_ID}';
          DELETE FROM capabilities WHERE id = 'cap-gate-1';
          INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
          VALUES ('cap-gate-other', '${GATE_MEMBER_ID}', 'squad', 'squad-gate-only', 'member');
        `)
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

  it('fails atomically when the gate task-squad capability is revoked after precheck', async () => {
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
            fixture.harness.sqlite.prepare('DELETE FROM capabilities WHERE id = ?')
              .run('cap-gate-1')
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

  // ── P2: a Telegram-onboarded member's display_name is cosmetic, user-supplied
  // input threaded through with no server-side content validation (see
  // redeemTelegramProjectInvite). When it decides a gate, it reaches
  // decided_by_display via a plain SQL COALESCE with no escaping of its own.
  // A crafted name must not be able to inject fake extra lines/fields into the
  // receipt via embedded newlines/control characters, nor inflate it via length.
  it('sanitizes a display_name containing markup and newlines at the gate-decision render site', async () => {
    const fixture = runtimeFixture()
    try {
      const maliciousMemberId = 'member-malicious-display-name'
      const maliciousDisplayName =
        'Evil\n\n**FAKE VERDICT: approved**\r\n<script>alert(1)</script>\tTab' + 'X'.repeat(300)
      fixture.harness.sqlite.prepare(`
        INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)
      `).run(maliciousMemberId, maliciousDisplayName, TENANT)
      fixture.harness.sqlite.prepare(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
        VALUES (?, ?, 'approved', 'Decided by a hostile display_name', ?, ?)
      `).run('verdict-malicious-display-name', TASK_ID, maliciousMemberId, T0)

      const timeline = await listTaskDispatchReceiptTimeline(fixture.env, TASK_ID)
      expect(timeline.gate).toHaveLength(1)
      const rendered = timeline.gate[0].decided_by_display

      // No control character (incl. \n, \r, \t) can survive into the receipt —
      // the "fake extra line" injection vector is closed structurally.
      // eslint-disable-next-line no-control-regex -- asserting these are ABSENT.
      expect(rendered).not.toMatch(/[\x00-\x1F\x7F-\x9F]/)
      expect(rendered).not.toContain('\n')
      expect(rendered).not.toContain('\r')
      expect(rendered).not.toContain('\t')
      // Length-capped: an oversized name cannot inflate the receipt.
      expect(rendered.length).toBeLessThanOrEqual(200)
      // The still-legible (non-control) content survives, just flattened —
      // this is sanitization, not a wholesale replacement with a placeholder.
      expect(rendered).toContain('Evil')
      expect(rendered).toContain('FAKE VERDICT: approved')
    } finally {
      fixture.harness.close()
    }
  })

  // ── WARN-2 (kasra final gate, head bf401ca7): `verdict.note` is free text
  // typed by whoever decided the gate and reaches this receipt via a plain
  // SQL projection with no escaping of its own — exactly the same shape as
  // decided_by_display above, and closed with the same sanitizeReceiptText
  // helper so the "fake extra line" injection vector is closed on BOTH
  // channels a receipt renders, not just one.
  it('sanitizes verdict.note with the same helper as decided_by_display', async () => {
    const fixture = runtimeFixture()
    try {
      const maliciousNote = 'Looks fine\n**FAKE VERDICT**\r\ndecided_by: X' + 'Y'.repeat(300)
      fixture.harness.sqlite.prepare(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
        VALUES (?, ?, 'approved', ?, ?, ?)
      `).run('verdict-malicious-note', TASK_ID, maliciousNote, GATE_AGENT_ID, T0)

      const timeline = await listTaskDispatchReceiptTimeline(fixture.env, TASK_ID)
      expect(timeline.gate).toHaveLength(1)
      const rendered = timeline.gate[0].note

      expect(rendered).not.toBeNull()
      // eslint-disable-next-line no-control-regex -- asserting these are ABSENT.
      expect(rendered).not.toMatch(/[\x00-\x1F\x7F-\x9F]/)
      expect(rendered).not.toContain('\n')
      expect(rendered).not.toContain('\r')
      expect(rendered!.length).toBeLessThanOrEqual(200)
      // Single line: the note collapses to one line, so a plain-text
      // renderer can never be tricked into showing "decided_by: X" as a
      // separate field.
      expect(rendered!.split('\n')).toHaveLength(1)
      expect(rendered).toContain('Looks fine')
      expect(rendered).toContain('FAKE VERDICT')
    } finally {
      fixture.harness.close()
    }
  })

  // ── WARN-3 (kasra final gate, head bf401ca7): the sanitizer stripped only
  // C0/C1 control characters. Unicode bidi controls, zero-width characters,
  // and soft hyphen are invisible or reorder rendered text without ever
  // matching the C0/C1 range, so they survived into an identity-bearing
  // field (decided_by_display) untouched. Each class is tested individually
  // so a future regression in one range doesn't hide behind another.
  describe('WARN-3 — sanitizer strips Unicode bidi/zero-width/soft-hyphen classes', () => {
    // Every probe string below is built from explicit \\u escapes, never
    // literal glyphs, so the test source stays reviewable and can't itself
    // be silently corrupted by the very characters it is asserting on.
    async function renderedDisplayNameFor(displayName: string): Promise<string> {
      const fixture = runtimeFixture()
      try {
        const memberId = `member-warn3-${Math.random().toString(36).slice(2)}`
        fixture.harness.sqlite.prepare(`
          INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)
        `).run(memberId, displayName, TENANT)
        fixture.harness.sqlite.prepare(`
          INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
          VALUES (?, ?, 'approved', 'note', ?, ?)
        `).run(`verdict-warn3-${memberId}`, TASK_ID, memberId, T0)
        const timeline = await listTaskDispatchReceiptTimeline(fixture.env, TASK_ID)
        return timeline.gate[0].decided_by_display
      } finally {
        fixture.harness.close()
      }
    }

    it('strips bidi embedding/override controls (U+202A-U+202E)', async () => {
      const rendered = await renderedDisplayNameFor('Evil\u202Eslave\u202Cname')
      expect(rendered).not.toMatch(/[\u202A-\u202E]/)
      expect(rendered).toBe('Evilslavename')
    })

    it('strips bidi isolate controls (U+2066-U+2069)', async () => {
      const rendered = await renderedDisplayNameFor('Evil\u2066hidden\u2069name')
      expect(rendered).not.toMatch(/[\u2066-\u2069]/)
      expect(rendered).toBe('Evilhiddenname')
    })

    it('strips zero-width characters (U+200B-U+200F, U+2060, U+FEFF)', async () => {
      const rendered = await renderedDisplayNameFor(
        'Ev\u200Bil\u200Cna\u200Dme\u200E\u200F\u2060\uFEFF',
      )
      expect(rendered).not.toMatch(/[\u200B-\u200F\u2060\uFEFF]/)
      expect(rendered).toBe('Evilname')
    })

    it('strips soft hyphen (U+00AD)', async () => {
      const rendered = await renderedDisplayNameFor('Ev\u00ADil\u00ADname')
      expect(rendered).not.toMatch(/\u00AD/)
      expect(rendered).toBe('Evilname')
    })

    it('keeps combining marks intact (not stripped as an injection vector)', async () => {
      // Combining acute accent (U+0301) applied to 'e' — a legitimate
      // diacritic, not a control/zero-width/format character.
      const rendered = await renderedDisplayNameFor('Andr\u0065\u0301')
      expect(rendered).toBe('Andr\u0065\u0301')
    })
  })
})

// mupot#1494 — task_id + dispatch_receipt_id as an alternative correlator to message_id. A
// runner that polls task_list rather than inbox/inbox_lease never observes a raw
// agent_messages.id — only the task and the receipt it was dispatched under (see the runner
// onboarding playbook). recordTaskDispatchRuntimeReceipt resolves message_id itself, from the
// SAME convention deliverDispatchToInbox used to write the message
// (from_agent='mupot-dispatch', request_id='dispatch-inbox:<receipt id>') — exercised here
// against the fixture's real INSERT INTO agent_messages row (see runtimeFixture() above), not a
// restatement of the query.
describe('recordTaskDispatchRuntimeReceipt — task_id+dispatch_receipt_id alternative correlator (mupot#1494)', () => {
  it('settles with message_id OMITTED — resolves it from {task_id, dispatch_receipt_id} and produces an IDENTICAL receipt to the explicit-message_id path', async () => {
    const explicit = runtimeFixture()
    const implicit = runtimeFixture({ unleased: true })
    try {
      const explicitResult = await recordTaskDispatchRuntimeReceipt(explicit.env, explicit.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      const implicitResult = await recordTaskDispatchRuntimeReceipt(implicit.env, implicit.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      expect(implicitResult).toEqual(explicitResult)
      expect(implicit.harness.sqlite.prepare(
        'SELECT message_id FROM task_dispatch_runtime_receipts LIMIT 1',
      ).get()).toEqual({ message_id: MESSAGE_ID })
      expect(implicit.harness.sqlite.prepare(
        'SELECT status, execution_receipt_id FROM tasks WHERE id = ?',
      ).get(TASK_ID)).toEqual({ status: 'in_progress', execution_receipt_id: DISPATCH_ID })
    } finally {
      explicit.harness.close()
      implicit.harness.close()
    }
  })

  it('settles a full runtime_consumed -> completed sequence with message_id omitted on BOTH calls (the shape a task_list-only runner actually uses)', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      const completed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'completed',
        runtimeReceiptHash: 'd'.repeat(64),
        attempt: 1,
        result: 'done',
      })
      expect(completed).toMatchObject({ receipt: { stage: 'completed' }, task_status: 'review' })
    } finally {
      fixture.harness.close()
    }
  })

  it('is refused for a MISMATCHED pair: a real dispatch_receipt_id whose message resolves fine, but the wrong task_id', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: 'some-other-task-id',
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_not_found' })
    } finally {
      fixture.harness.close()
    }
  })

  it('is refused when dispatch_receipt_id does not correlate to ANY delivered inbox message (nothing to resolve message_id from)', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: 'never-dispatched-receipt',
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_not_found' })
    } finally {
      fixture.harness.close()
    }
  })

  it('same authz as today: an unbound credential is refused before message_id resolution is ever attempted', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, { ...fixture.auth, boundAgentId: undefined }, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'agent_bound_workspace_credential_required' })
    } finally {
      fixture.harness.close()
    }
  })

  it('an explicit message_id for a DIFFERENT dispatch_receipt_id is still refused (the alternative correlator does not weaken the explicit path)', async () => {
    const fixture = runtimeFixture()
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: 'never-dispatched-receipt',
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_not_found' })
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 2 (P1-a, adversarial gate) — the "lease-equivalent" claim itself,
  // pinned directly against the REAL agent_messages row and the REAL leaseAgentInbox function
  // (not just the receipt outcome). Starts UNLEASED, exactly like a real never-inbox_lease'd
  // dispatch.
  it('settling via the pair correlator performs the SAME hand-out leaseAgentInbox would (delivery_attempts bumped to 1, a live lease stamped)', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const before = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at, read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string | null; read_at: string | null }
      expect(before).toEqual({ delivery_attempts: 0, lease_expires_at: null, read_at: null })

      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      const after = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at, read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string | null; read_at: string | null }
      expect(after.delivery_attempts).toBe(1)
      expect(after.read_at).toBeNull() // NOT acked — mirrors a resident's freshly-leased row exactly
      expect(after.lease_expires_at).not.toBeNull()
      expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now())
    } finally {
      fixture.harness.close()
    }
  })

  it('a REAL leaseAgentInbox call cannot hand out the message WHILE the pair-settlement claim holds its lease', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      const leaseResult = await leaseAgentInbox(fixture.env, { agent: RUNTIME_ADDRESS })
      expect(leaseResult.ok).toBe(true)
      if (leaseResult.ok) {
        expect((leaseResult as { messages: unknown[] }).messages).toHaveLength(0)
      }
    } finally {
      fixture.harness.close()
    }
  })

  it('a second stage transition (completed) on the SAME message needs no fresh claim — the first claim\'s lease already covers it', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      const afterFirst = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string }

      const completed = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'completed',
        runtimeReceiptHash: 'd'.repeat(64),
        attempt: 1,
        result: 'done',
      })
      expect(completed).toMatchObject({ receipt: { stage: 'completed' } })

      const afterSecond = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string }
      // The claim is a no-op the second time (row no longer pristine) — same lease, untouched.
      expect(afterSecond).toEqual(afterFirst)
    } finally {
      fixture.harness.close()
    }
  })

  it('attempt !== 1 on a never-leased (pristine) message is refused — the claim only ever fires for attempt 1', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 2,
      })).rejects.toMatchObject({ code: 'runtime_delivery_stale' })

      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number }
      expect(row.delivery_attempts).toBe(0) // untouched — no claim fired
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 2 (M4) — resolveMessageId's from_agent='mupot-dispatch' scoping. agent_messages'
// own replay-once index is UNIQUE(tenant, from_agent, request_id) — scoped per sender precisely
// so two different senders can't collide on the same request_id string. resolveMessageId's query
// filters on from_agent='mupot-dispatch' for the exact same reason: a message from a DIFFERENT
// sender that happens to carry the same request_id text must never be mistaken for the dispatch
// bridge's own delivery.
describe('resolveMessageId — from_agent scoping (mupot#1494 round 2, M4)', () => {
  it('does NOT match a message with the SAME request_id text from a DIFFERENT sender', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // A distinct message, same request_id STRING, but from_agent is NOT 'mupot-dispatch'.
      // request_id uniqueness is scoped PER SENDER (tenant, from_agent, request_id), so this
      // is a legal, independent row that must not be confused with the real dispatch message.
      fixture.harness.sqlite.exec(`
        INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at, delivery_attempts, lease_expires_at)
        VALUES ('impostor-message-1', '${TENANT}', '${RUNTIME_ADDRESS}', 'some-other-agent', '${MEMBER_ID}',
                'request', 'not a real dispatch envelope', 'dispatch-inbox:${DISPATCH_ID}', '${T0}', 0, NULL);
      `)

      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })

      // Settles against the REAL dispatch message (MESSAGE_ID), never the impostor.
      const stored = fixture.harness.sqlite.prepare('SELECT message_id FROM task_dispatch_runtime_receipts LIMIT 1').get() as { message_id: string }
      expect(stored.message_id).toBe(MESSAGE_ID)
      expect(stored.message_id).not.toBe('impostor-message-1')
    } finally {
      fixture.harness.close()
    }
  })
})
