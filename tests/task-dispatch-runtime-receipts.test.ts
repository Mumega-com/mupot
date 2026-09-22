import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import {
  listTaskDispatchReceiptTimeline,
  recordTaskDispatchRuntimeReceipt,
  adminResetDispatchLease,
} from '../src/tasks/runtime-receipts'
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

/** Shared org-admin auth builder for adminResetDispatchLease tests (mupot#1494 v4) — same
 *  shape as the local `adminAuth` defined inside the "operator repair" describe block below,
 *  hoisted to module scope so the new P0/P1-a describe blocks can use it too without
 *  duplicating the fixture's own GATE_MEMBER_ID/GATE_TOKEN_ID wiring. */
function adminAuthFor(memberId: string, tokenId: string, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: memberId,
    tenant: TENANT,
    channel: 'workspace',
    role: 'owner',
    memberId,
    tokenId,
    boundAgentId: undefined,
    capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
    ...overrides,
  }
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
      // mupot#1494 v4 round 2 (P1-2) briefly reclassified this as `dispatch_terminated` by
      // checking the FULL terminal-stage set (completed/failed/reset_terminated) here —
      // round 3 (P1-A, adversarial regression) found that too broad: it also refused the
      // OPERATOR's own `task_dispatch_lease_reset({override:true})` repair on a `failed`
      // dispatch, breaking the normal "runner failed, let it retry" flow. Narrowed back to
      // `reset_terminated` only — this scenario (a genuine `failed`, no operator
      // termination) is unaffected by that check either way and falls through to its
      // ORIGINAL, pre-round-2 enforcement: the `runtime_consumed` mutation's own
      // `NOT EXISTS (... stage = 'failed')` fence, surfaced as `runtime_receipt_transition_conflict`.
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
      // mupot#1494 v4 round 3 (P1-A) — same reversion as the test above: `failed` alone
      // (no operator `terminate: true`) is repairable/retryable, not `dispatch_terminated`.
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

// mupot#1494 round 3 (P0, structural — Athena's ruling). Pair-settlement is NOT a
// pre-authorization write: the ownership/active/fence predicate lives INSIDE the claim
// UPDATE's WHERE, so a mismatched/ineligible caller's claim changes ZERO rows, every time.
describe('claimUnleasedForPairSettlement — is not a pre-authorization write (mupot#1494 round 3, P0)', () => {
  function unchangedMessageRow(sqlite: ReturnType<typeof createSqliteD1>['sqlite']) {
    return sqlite.prepare(
      'SELECT delivery_attempts, lease_expires_at, read_at FROM agent_messages WHERE id = ?',
    ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string | null; read_at: string | null }
  }

  it('a non-assignee squad member settling the VICTIM\'s pair is refused and changes zero rows; the victim then leases normally', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const before = unchangedMessageRow(fixture.harness.sqlite)
      expect(before).toEqual({ delivery_attempts: 0, lease_expires_at: null, read_at: null })

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.gateAuth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_receipt_forbidden' })

      const after = unchangedMessageRow(fixture.harness.sqlite)
      expect(after).toEqual(before) // byte-identical — zero side effects from the refused claim

      // The VICTIM's own real inbox_lease still works exactly as if the attack never happened.
      const leaseResult = await leaseAgentInbox(fixture.env, { agent: RUNTIME_ADDRESS })
      expect(leaseResult.ok).toBe(true)
      if (leaseResult.ok) {
        expect((leaseResult as { messages: unknown[] }).messages).toHaveLength(1)
      }
    } finally {
      fixture.harness.close()
    }
  })

  it('a CROSS-SQUAD agent (no capability at all on the victim\'s squad) settling the victim\'s pair is refused and changes zero rows', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const otherSquadId = 'squad-cross-1'
      const attackerAgentId = 'agent-cross-1'
      const attackerMemberId = 'member-cross-1'
      const attackerTokenId = 'token-cross-1'
      fixture.harness.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name) VALUES ('${otherSquadId}', 'department-runtime-1', 'cross-squad', 'Cross Squad');
        INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${attackerAgentId}', '${otherSquadId}', 'cross-attacker', 'Cross Attacker', 'active');
        INSERT INTO members (id, display_name, status, tenant) VALUES ('${attackerMemberId}', 'Cross Attacker Member', 'active', '${TENANT}');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${attackerAgentId}', '${attackerMemberId}', '${T0}');
        INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
          VALUES ('${attackerTokenId}', '${attackerMemberId}', 'hash-cross-1', 'cross', 'workspace', '${T0}', NULL, '${attackerAgentId}', '${TENANT}', '2099-01-01T00:00:00.000Z');
      `)
      const attackerAuth: AuthContext = {
        userId: attackerMemberId,
        tenant: TENANT,
        channel: 'workspace',
        role: 'member',
        memberId: attackerMemberId,
        tokenId: attackerTokenId,
        boundAgentId: attackerAgentId,
        capabilities: [], // NO capability on the victim's squad at all
      }
      const before = unchangedMessageRow(fixture.harness.sqlite)

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, attackerAuth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_receipt_forbidden' })

      expect(unchangedMessageRow(fixture.harness.sqlite)).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })

  it('the ASSIGNEE\'s own token still refuses the claim (and changes zero rows) once the agent is deactivated', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      fixture.harness.sqlite.prepare(`UPDATE agents SET status = 'inactive' WHERE id = ?`).run(AGENT_ID)
      const before = unchangedMessageRow(fixture.harness.sqlite)

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_receipt_forbidden' })

      expect(unchangedMessageRow(fixture.harness.sqlite)).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })

  it('a revoked token is refused before the claim ever runs, changing zero rows', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      fixture.harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(T0, TOKEN_ID)
      const before = unchangedMessageRow(fixture.harness.sqlite)

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'agent_bound_workspace_credential_required' })

      expect(unchangedMessageRow(fixture.harness.sqlite)).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })

  it('mupot#1494 round 3 (P1-ii) — a signed_only-fenced agent cannot settle its OWN pair via the bearer path; row untouched', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      fixture.harness.sqlite.exec(`
        INSERT INTO agent_inbox_fences (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
        VALUES ('${TENANT}', '${AGENT_ID}', 'signed_only', 1, '${'f'.repeat(64)}', '${MEMBER_ID}', '${T0}', 'native gateway cutover');
      `)
      const before = unchangedMessageRow(fixture.harness.sqlite)

      // The claim never fires (fence blocks it), so the row stays pristine
      // (delivery_attempts=0, no lease) — validateEnvelope then refuses it as stale (it
      // expects a resident's live lease, exactly like a never-`inbox_lease`d row always did
      // pre-#1494), NOT "not found": `loadDelivery` still finds the real dispatch/task/message
      // row, only the claim's WRITE was blocked.
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_stale' })

      expect(unchangedMessageRow(fixture.harness.sqlite)).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 3 (P2-1, adversarial round 2) — the claim's EXISTS pins TWO conjuncts
  // (dispatch.agent_id = caller AND task.assignee_agent_id = caller). A dispatch's own
  // `agent_id` always equals the task's `assignee_agent_id` AT DISPATCH TIME, so once the two
  // diverge (a later reassignment), `loadDelivery`'s OWN join (`dispatch.agent_id =
  // task.assignee_agent_id`) ALSO refuses independently — the terminal error code these two
  // tests see is `runtime_delivery_not_found` from THAT join either way. The load-bearing
  // assertion is narrower and stronger: the message row must be BYTE-IDENTICAL afterward,
  // proving the claim's own WRITE never fired — if either conjunct were missing from the
  // claim's EXISTS, the write would still land (delivery_attempts bumped, a live lease
  // stamped) even though the call still ultimately fails downstream at loadDelivery, a real,
  // wasted mutation on a message that was never the caller's to touch.
  it('M4b: task reassigned AWAY from the dispatch\'s own agent — that agent (still matching dispatch.agent_id) writes zero rows, pinning the task.assignee_agent_id conjunct', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // Reassign the task to GATE_AGENT_ID. DISPATCH_ID's own dispatch.agent_id is still
      // AGENT_ID (dispatches are never rewritten on reassignment) — only the TASK's
      // assignee_agent_id has moved. Conjunct 1 (dispatch.agent_id=caller) is SATISFIED;
      // conjunct 2 (task.assignee_agent_id=caller) is NOT — isolates conjunct 2.
      fixture.harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = ? WHERE id = ?`).run(GATE_AGENT_ID, TASK_ID)
      const before = unchangedMessageRow(fixture.harness.sqlite)
      expect(before).toEqual({ delivery_attempts: 0, lease_expires_at: null, read_at: null })

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_not_found' })

      expect(unchangedMessageRow(fixture.harness.sqlite)).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })

  it('M4: task reassigned TO an agent who was never the ORIGINAL dispatch\'s agent — that new assignee writes zero rows settling the OLD receipt, pinning the dispatch.agent_id conjunct', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // A prior dispatch (and its delivered inbox message) to GATE_AGENT_ID for the SAME
      // task — dispatch.agent_id=GATE_AGENT_ID. Conjunct 2 (task.assignee_agent_id=caller)
      // is SATISFIED (task is now assigned to AGENT_ID, the caller); conjunct 1
      // (dispatch.agent_id=caller) is NOT — isolates conjunct 1.
      const oldDispatchId = 'dispatch-runtime-old-1'
      const oldMessageId = 'message-runtime-old-1'
      fixture.harness.sqlite.exec(`
        INSERT INTO task_dispatch_receipts (
          id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id,
          created_at, claimed_at, consumed_at, attempts, last_error
        ) VALUES (
          '${oldDispatchId}', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${GATE_AGENT_ID}',
          'member', '${MEMBER_ID}', '${T0}', '${T0}', '${T0}', 1, NULL
        );
        INSERT INTO agent_messages (
          id, tenant, to_agent, from_agent, from_member, kind, body, request_id,
          created_at, delivery_attempts, lease_expires_at
        ) VALUES (
          '${oldMessageId}', '${TENANT}', 'independent-gate', 'mupot-dispatch', '${MEMBER_ID}',
          'request',
          '{"version":"runtime.dispatch/v1","type":"task_dispatch","task_id":"${TASK_ID}","dispatch_receipt_id":"${oldDispatchId}","squad_id":"${SQUAD_ID}","runtime_address":"independent-gate"}',
          'dispatch-inbox:${oldDispatchId}', '${T0}', 0, NULL
        );
      `)
      const oldMessageRow = () => fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at, read_at FROM agent_messages WHERE id = ?',
      ).get(oldMessageId) as { delivery_attempts: number; lease_expires_at: string | null; read_at: string | null }
      const before = oldMessageRow()
      expect(before).toEqual({ delivery_attempts: 0, lease_expires_at: null, read_at: null })

      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: oldDispatchId,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_not_found' })

      expect(oldMessageRow()).toEqual(before)
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 (P0, part b + Athena pin) — dispatch_receipt_id/delivered_via must be
// assignee-scoped on task_list/task_board, and the pin itself must be provably load-bearing:
// the round-2 gate found loadLatestDispatchReceiptsForTasks returning {} left ALL named tests
// green. These tests are that missing coverage.
describe('task_list / task_board — dispatch_receipt_id is assignee-scoped (mupot#1494 round 3, P0-b)', () => {
  it('task_list attaches dispatch_receipt_id + delivered_via for the ASSIGNEE\'s own view', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = ?`).run(DISPATCH_ID)
      const res = await invokeTool(fixture.auth, fixture.env, 'task_list', {}, 'https://pot.test')
      expect(res.ok).toBe(true)
      const tasks = (res.result as { tasks: Array<Record<string, unknown>> }).tasks
      const row = tasks.find((t) => t.id === TASK_ID)
      expect(row).toMatchObject({ dispatch_receipt_id: DISPATCH_ID, delivered_via: 'inbox' })
    } finally {
      fixture.harness.close()
    }
  })

  it('task_list does NOT attach dispatch_receipt_id for a non-assignee squad member viewing the SAME task', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = ?`).run(DISPATCH_ID)
      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_list', {}, 'https://pot.test')
      expect(res.ok).toBe(true)
      const tasks = (res.result as { tasks: Array<Record<string, unknown>> }).tasks
      const row = tasks.find((t) => t.id === TASK_ID)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('dispatch_receipt_id')
      expect(row).not.toHaveProperty('delivered_via')
    } finally {
      fixture.harness.close()
    }
  })

  it('task_board attaches dispatch_receipt_id + delivered_via for the ASSIGNEE\'s own view', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = ?`).run(DISPATCH_ID)
      const res = await invokeTool(fixture.auth, fixture.env, 'task_board', {}, 'https://pot.test')
      expect(res.ok).toBe(true)
      const columns = (res.result as { columns: Record<string, Array<Record<string, unknown>>> }).columns
      const row = columns.open.find((t) => t.id === TASK_ID)
      expect(row).toMatchObject({ dispatch_receipt_id: DISPATCH_ID, delivered_via: 'inbox' })
    } finally {
      fixture.harness.close()
    }
  })

  it('task_board does NOT attach dispatch_receipt_id for a non-assignee squad member viewing the SAME task', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = ?`).run(DISPATCH_ID)
      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_board', {}, 'https://pot.test')
      expect(res.ok).toBe(true)
      const columns = (res.result as { columns: Record<string, Array<Record<string, unknown>>> }).columns
      const row = columns.open.find((t) => t.id === TASK_ID)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('dispatch_receipt_id')
      expect(row).not.toHaveProperty('delivered_via')
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 3 (P2-1, adversarial round 2) — after a REASSIGNMENT, the NEW assignee's
  // own task_list/task_board view must never show the OLD agent's dispatch_receipt_id: even
  // though `assignee_agent_id === auth.boundAgentId` now holds for the new assignee,
  // `loadLatestDispatchReceiptsForTasks` filters to a receipt whose OWN `agent_id` still
  // matches the CURRENT assignee — the stale dispatch (agent_id = the OLD agent) no longer
  // qualifies at all, for anyone.
  it('after reassignment, the NEW assignee sees NO dispatch_receipt_id for the OLD agent\'s dispatch', async () => {
    const fixture = runtimeFixture()
    try {
      fixture.harness.sqlite.prepare(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = ?`).run(DISPATCH_ID)
      fixture.harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = ? WHERE id = ?`).run(GATE_AGENT_ID, TASK_ID)

      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_list', {}, 'https://pot.test')
      expect(res.ok).toBe(true)
      const tasks = (res.result as { tasks: Array<Record<string, unknown>> }).tasks
      const row = tasks.find((t) => t.id === TASK_ID)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('dispatch_receipt_id')
      expect(row).not.toHaveProperty('delivered_via')
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 — Athena's RECORD INTEGRITY ruling: a receipted operator repair for a
// wedged dispatch lease, tested end-to-end against a DIRECTLY-simulated wedge (the shape the
// now-impossible round-2 attack would have left behind).
describe('adminResetDispatchLease — operator repair for a wedged lease (mupot#1494 round 3)', () => {
  // Reuses the fixture's own GATE_MEMBER_ID (already a real `members` row — mutation_audit_
  // entries.member_id is FK'd to it) as the acting org-admin; adminResetDispatchLease itself
  // does not re-check authority (callers must already have verified hasWorkspaceAdmin per its
  // doc comment) — the MCP tool-layer gate is covered separately.
  function adminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
    return {
      userId: GATE_MEMBER_ID,
      tenant: TENANT,
      channel: 'workspace',
      role: 'owner',
      memberId: GATE_MEMBER_ID,
      tokenId: GATE_TOKEN_ID,
      boundAgentId: undefined,
      capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
      ...overrides,
    }
  }

  it('resets a wedged row to pristine, receipts the reset, and the victim recovers with ONE subsequent attempt:1 call', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // Simulate DIRECTLY in the DB the exact wedge the round-2 attack (now impossible) would
      // have left: delivery_attempts desynchronised to 2 with a live stray lease, as if an
      // attacker's claim had landed and the victim's own subsequent inbox_lease had bumped it
      // again.
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 2, lease_expires_at = ? WHERE id = ?`,
      ).run('2099-01-01T00:00:00.000Z', MESSAGE_ID)

      // Confirm the wedge: the victim's protocol-correct attempt:1 settle is refused stale.
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_stale' })

      // The simulated wedge left a technically-LIVE (far-future) lease — P1-A's own guard
      // now refuses to steal that without an explicit override, exactly as it should for a
      // genuinely in-flight hold. This scenario is an admin who has independently confirmed
      // the "holder" is not real (a wedge, not a live consumer), so it overrides.
      const result = await adminResetDispatchLease(fixture.env, adminAuth(), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'repairing a wedged lease found in the round-3 adversarial review',
        override: true,
      })
      expect(result.reset).toBe(true)
      expect(result.overrode).toBe(true)
      expect(result.message_id).toBe(MESSAGE_ID)

      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at, lease_attempt_id, read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string | null; lease_attempt_id: string | null; read_at: string | null }
      expect(row).toEqual({ delivery_attempts: 0, lease_expires_at: null, lease_attempt_id: null, read_at: null })

      // One receipt row, attributed to the admin, with the PRIOR (stolen) lease state
      // preserved in the evidence as an explicit override — never silently discarded.
      const audit = fixture.harness.sqlite.prepare(
        `SELECT principal_id, operation, handler, evidence_json FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { principal_id: string; operation: string; handler: string; evidence_json: string }
      expect(audit).toMatchObject({ principal_id: GATE_MEMBER_ID, operation: 'reset_override', handler: 'task_dispatch_lease_reset' })
      const evidence = JSON.parse(audit.evidence_json)
      expect(evidence).toMatchObject({ task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, override: true })
      expect(evidence.override_of).toMatchObject({
        delivery_attempts: 2, lease_expires_at: '2099-01-01T00:00:00.000Z',
      })

      // The victim recovers within ONE subsequent call — no special-casing on its end. The
      // reset row is pristine, the SAME shape a never-delivered dispatch starts in, so the
      // victim's ordinary {task_id, dispatch_receipt_id} pair-correlator settle (exactly what
      // a task_list-only runner already uses) claims it and proceeds normally.
      const recovered = await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })
      expect(recovered).toMatchObject({ receipt: { stage: 'runtime_consumed' }, task_status: 'in_progress' })
    } finally {
      fixture.harness.close()
    }
  })

  it('refuses (0 rows, reset:false) and still receipts once the message was already consumed (read_at set) — a repair, not an un-delete', async () => {
    const fixture = runtimeFixture() // pre-leased/read fixture default: NOT unleased
    try {
      fixture.harness.sqlite.prepare(`UPDATE agent_messages SET read_at = ? WHERE id = ?`).run(T0, MESSAGE_ID)

      const result = await adminResetDispatchLease(fixture.env, adminAuth(), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'attempted repair on an already-consumed message',
      })
      expect(result.reset).toBe(false)
      expect(result.message_id).toBe(MESSAGE_ID)

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string }
      expect(audit.operation).toBe('reset_refused_terminal')
    } finally {
      fixture.harness.close()
    }
  })

  it('reports not-found (and still receipts) for a dispatch_receipt_id with no delivered inbox message', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const result = await adminResetDispatchLease(fixture.env, adminAuth(), {
        taskId: TASK_ID,
        dispatchReceiptId: 'never-dispatched-receipt',
        reason: 'operator typo',
      })
      expect(result.reset).toBe(false)
      expect(result.message_id).toBeNull()

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string }
      expect(audit.operation).toBe('reset_not_found')
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 3 (P1-A, adversarial round 2) — a LIVE, unexpired lease held by a
  // genuine resident is NOT a wedge; resetting it steals the in-flight dispatch out from
  // under the real holder.
  it('P1-A: refuses a LIVE unexpired lease without override — typed refusal names the holder + expiry, zero side effects', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // A real resident leases it normally (delivery_attempts=1, a genuine future expiry) —
      // NOT a wedge, NOT desynchronised, just mid-flight.
      const liveExpiry = new Date(Date.now() + 5 * 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(liveExpiry, MESSAGE_ID)

      const result = await adminResetDispatchLease(fixture.env, adminAuth(), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'attempted reset while the lease is genuinely live',
      })
      expect(result.reset).toBe(false)
      expect(result.code).toBe('reset_refused_lease_live')
      expect(result.overrode).toBe(false)
      expect(result.lease_live).toMatchObject({ holder: RUNTIME_ADDRESS, delivery_attempts: 1 })

      // Zero side effects — the row is exactly as the real resident left it.
      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string }
      expect(row).toEqual({ delivery_attempts: 1, lease_expires_at: liveExpiry })

      // A SECOND consumer must not be handed the same dispatch — inbox_lease still refuses
      // it (still genuinely leased), exactly as if the reset attempt never happened.
      const leaseResult = await leaseAgentInbox(fixture.env, { agent: RUNTIME_ADDRESS })
      expect(leaseResult.ok).toBe(true)
      if (leaseResult.ok) expect((leaseResult as { messages: unknown[] }).messages).toHaveLength(0)

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation, evidence_json FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string; evidence_json: string }
      expect(audit.operation).toBe('reset_refused_lease_live')
      expect(JSON.parse(audit.evidence_json)).toMatchObject({ holder: RUNTIME_ADDRESS, override: false })
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 3 (P2-4, adversarial round 2) — input.taskId is validated against the
  // dispatch's OWN task before any read/write on the message.
  it('P2-4: refuses a taskId that does not match the dispatch\'s own task — typed refusal, zero side effects', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const before = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID)

      const result = await adminResetDispatchLease(fixture.env, adminAuth(), {
        taskId: 'some-other-task-entirely',
        dispatchReceiptId: DISPATCH_ID,
        reason: 'operator supplied the wrong task id',
      })
      expect(result.reset).toBe(false)
      expect(result.code).toBe('reset_refused_task_mismatch')

      expect(fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID)).toEqual(before)

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation, evidence_json FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string; evidence_json: string }
      expect(audit.operation).toBe('reset_refused_task_mismatch')
      expect(JSON.parse(audit.evidence_json)).toMatchObject({ actual_task_id: TASK_ID })
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 round 3 (P2-4) — the receipt is actor-faithful: an agent-bound caller (even
  // though the MCP tool layer refuses agent-bound tokens outright, P1-B) is receipted as the
  // agent that actually acted, never masked as a bare member action, as defense in depth.
  it('P2-4: an agent-bound principal is receipted as an agent, not silently as a bare member', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const result = await adminResetDispatchLease(fixture.env, adminAuth({ boundAgentId: GATE_AGENT_ID }), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'agent-bound caller (service layer, defense in depth)',
      })
      expect(result.reset).toBe(true)

      const audit = fixture.harness.sqlite.prepare(
        `SELECT principal_kind, principal_id, member_id, agent_id FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { principal_kind: string; principal_id: string; member_id: string; agent_id: string | null }
      expect(audit).toEqual({
        principal_kind: 'agent', principal_id: GATE_AGENT_ID, member_id: GATE_MEMBER_ID, agent_id: GATE_AGENT_ID,
      })
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 v4 (P0 successor, adversarial round 2 on PR #1514) — a SAME-UTC-DAY expired
// lease read as LIVE because the reset tool compared `lease_expires_at` (ISO, 'T' separator)
// against `nowSqlUtc()` (space separator) as a plain JS string: 'T' (0x54) sorts above ' '
// (0x20), so the ISO value always compared greater for any same-day instant. Fixed via
// LEASE_LIVE_PREDICATE (julianday on both sides, src/agents/messages.ts) — this block proves
// the fix on the exact repro shape (real, small offsets from `Date.now()`, not the fixture's
// usual 2099/T0 far-future/far-past constants, which never exercised the bug either way).
describe('adminResetDispatchLease — P0 successor: same-day timestamp format split (mupot#1494 v4)', () => {
  it('an expired-by-60-seconds SAME-DAY lease resets WITHOUT override — the exact case the tool exists for', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      const result = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'dead runner, lease expired a minute ago',
        // Deliberately NO override — a same-day expired lease must reset on its own merits.
        // Under the pre-fix JS string compare this call was WRONGLY refused
        // reset_refused_lease_live, and the only workaround (override:true) would have
        // written a FALSE override_of record naming a holder that held nothing.
      })
      expect(result.reset).toBe(true)
      expect(result.overrode).toBe(false)
      expect(result.code).toBe('reset')

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation, evidence_json FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string; evidence_json: string }
      expect(audit.operation).toBe('reset') // never 'reset_override' — nothing was overridden
      expect(JSON.parse(audit.evidence_json).override_of).toBeUndefined()
    } finally {
      fixture.harness.close()
    }
  })

  it('CONTROL: a genuinely LIVE same-day lease (expires 5 minutes from now) is still refused without override', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const liveSameDay = new Date(Date.now() + 5 * 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(liveSameDay, MESSAGE_ID)

      const result = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        reason: 'control: this one really is still live',
      })
      expect(result.reset).toBe(false)
      expect(result.code).toBe('reset_refused_lease_live')
    } finally {
      fixture.harness.close()
    }
  })

  it('validateEnvelope (via recordTaskDispatchRuntimeReceipt) refuses a settle on a lease that expired 10 minutes ago, same day — fail-CLOSED, not fail-open', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 10 * 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      // Pre-fix, src/tasks/runtime-receipts.ts:452-453's own JS string compare
      // (`row.message_lease_expires_at <= now`) was oriented the OPPOSITE way — fail-OPEN —
      // so this settle SUCCEEDED despite the lease having expired 10 minutes ago. Fixed: it
      // must now throw runtime_delivery_stale, same as any other expired-lease settle.
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'runtime_delivery_stale' })
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 v4 (P1-a, adversarial round 2 on PR #1514) — a lease reset alone left no exit
// from the wedge: hasInFlightDispatchReceipt keyed only on a terminal completed/failed
// runtime receipt, adminResetDispatchLease wrote neither, and task_dispatch had no in-flight
// guard of its own at all. This block proves the FULL dead-runner recovery path end to end:
// dispatch -> runner dies -> reset(terminate) -> reassign -> new dispatch -> settle.
describe('adminResetDispatchLease terminate:true — the wedge now has an exit (mupot#1494 v4, P1-a)', () => {
  it('PRE-FIX repro: reset alone (no terminate) leaves reassign/unassign refused AND a fresh dispatch succeeds anyway (the bypass)', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      const reset = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'dead runner', override: true,
      })
      expect(reset.reset).toBe(true)
      expect(reset.terminated).toBe(false) // terminate was not requested

      // Reassignment still refused — the dispatch has no terminal runtime receipt.
      const reassign = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: GATE_AGENT_ID,
      }, 'https://pot.test')
      expect(reassign).toMatchObject({ ok: false, status: 409, error: 'task_dispatch_in_flight' })

      // Unassignment (null) is ALSO refused — same in-flight guard.
      const unassign = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: null,
      }, 'https://pot.test')
      expect(unassign).toMatchObject({ ok: false, status: 409, error: 'task_dispatch_in_flight' })
    } finally {
      fixture.harness.close()
    }
  })

  it('dead-runner recovery end to end: dispatch already in flight -> reset(terminate:true) -> reassign -> fresh dispatch -> settle', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      // A fresh task_dispatch is refused while the fixture's own dispatch is still in flight
      // (P1-a's new guard) — even BEFORE any reset.
      const blockedDispatch = await invokeTool(fixture.gateAuth, fixture.env, 'task_dispatch', {
        task_id: TASK_ID,
      }, 'https://pot.test')
      expect(blockedDispatch).toMatchObject({ ok: false, status: 409, error: 'task_not_dispatchable' })

      // Operator repairs AND terminates in one call.
      const reset = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'dead runner, terminating', override: true, terminate: true,
      })
      expect(reset).toMatchObject({ reset: true, terminated: true })

      const terminalReceipt = fixture.harness.sqlite.prepare(
        `SELECT stage, agent_id, message_id FROM task_dispatch_runtime_receipts WHERE dispatch_receipt_id = ? AND stage = 'reset_terminated'`,
      ).get(DISPATCH_ID) as { stage: string; agent_id: string; message_id: string }
      expect(terminalReceipt).toMatchObject({ stage: 'reset_terminated', agent_id: AGENT_ID, message_id: MESSAGE_ID })

      // Reassignment now succeeds — hasInFlightDispatchReceipt sees the terminal marker.
      const reassign = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: GATE_AGENT_ID,
      }, 'https://pot.test')
      expect(reassign.ok).toBe(true)

      // A fresh dispatch to the new assignee now succeeds (task must be open/blocked/rejected
      // again first, and assignee resolved via GATE_AGENT_ID which the fixture's own squad
      // capability already covers).
      fixture.harness.sqlite.prepare(`UPDATE tasks SET status = 'open' WHERE id = ?`).run(TASK_ID)
      const freshDispatch = await invokeTool(fixture.gateAuth, fixture.env, 'task_dispatch', {
        task_id: TASK_ID,
      }, 'https://pot.test') as { ok: boolean; result?: { dispatched?: boolean; receipt?: { id: string } } }
      expect(freshDispatch.ok).toBe(true)
      expect(freshDispatch.result?.receipt?.id).toBeDefined()
      expect(freshDispatch.result?.receipt?.id).not.toBe(DISPATCH_ID)
    } finally {
      fixture.harness.close()
    }
  })

  it('terminate:true is idempotent — a second call never writes a duplicate reset_terminated row', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'first terminate', terminate: true,
      })
      const second = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'second terminate, already terminal', terminate: true,
      })
      expect(second.terminated).toBe(true) // idempotently "already terminal", no throw

      const count = fixture.harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM task_dispatch_runtime_receipts WHERE dispatch_receipt_id = ? AND stage = 'reset_terminated'`,
      ).get(DISPATCH_ID) as { n: number }
      expect(count.n).toBe(1)
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 v4 round 3 (P3, adversarial regression) — a caller that never asked to
  // terminate anything must never be told `terminated: true`, even when the dispatch
  // happens to ALREADY be reset_terminated for some other reason (an earlier call, an
  // operator elsewhere). `terminated` answers "did THIS call terminate it", not "is it
  // terminal".
  it('an already reset_terminated dispatch: a follow-up call with terminate:false (or omitted) is refused with terminated:false, never true', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'first terminate', terminate: true,
      })
      const followUp = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'plain reset, no terminate this time',
        // terminate omitted — defaults to false.
      })
      expect(followUp).toMatchObject({
        reset: false, code: 'reset_refused_already_terminal', terminated: false,
      })
    } finally {
      fixture.harness.close()
    }
  })

  it('terminate:true refuses (409, receipted, zero side effects) for a directory-session org-admin with no bearer credential', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const noCredentialAuth: AuthContext = {
        userId: GATE_MEMBER_ID,
        tenant: TENANT,
        channel: 'workspace',
        role: 'owner',
        memberId: GATE_MEMBER_ID,
        tokenId: undefined, // no live bearer token
        boundAgentId: undefined,
        capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
      }
      const result = await adminResetDispatchLease(fixture.env, noCredentialAuth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'no credential', terminate: true,
      })
      expect(result).toMatchObject({ reset: false, code: 'reset_refused_credential_required', terminated: false })

      // Zero side effects — the message is untouched (unleased fixture default: 0).
      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number }
      expect(row.delivery_attempts).toBe(0)
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 v4 round 2 (P1-2, adversarial regression on round 1's own terminate:true fix) —
// a dead runner declared terminal must NEVER be able to settle again through any door, and
// the underlying message must be provably CONSUMED (not merely "pristine, but there's a
// receipt saying not to use it") the instant terminate:true lands.
describe('adminResetDispatchLease terminate:true — the terminated dispatch cannot be resurrected (mupot#1494 v4 round 2, P1-2)', () => {
  it('terminate:true marks the underlying message CONSUMED (read_at set), not merely pristine', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      const reset = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'dead runner, terminating', terminate: true,
      })
      expect(reset).toMatchObject({ reset: true, terminated: true })

      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at, read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; lease_expires_at: string | null; read_at: string | null }
      expect(row.delivery_attempts).toBe(0)
      expect(row.lease_expires_at).toBeNull()
      expect(row.read_at).not.toBeNull() // CONSUMED, not pristine — the P1-2 fix
    } finally {
      fixture.harness.close()
    }
  })

  it('a plain reset (no terminate) still leaves the message pristine (read_at NULL) — unchanged behavior', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const expiredSameDay = new Date(Date.now() - 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(expiredSameDay, MESSAGE_ID)

      const reset = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'plain repair, no terminate',
      })
      expect(reset).toMatchObject({ reset: true, terminated: false })

      const row = fixture.harness.sqlite.prepare(
        'SELECT read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { read_at: string | null }
      expect(row.read_at).toBeNull()
    } finally {
      fixture.harness.close()
    }
  })

  it('a "dead" runner that actually resumes AFTER terminate:true cannot settle via the pair correlator — refused dispatch_terminated, no state corruption', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'declared dead', terminate: true,
      })

      const before = fixture.harness.sqlite.prepare('SELECT status, execution_receipt_id FROM tasks WHERE id = ?').get(TASK_ID)

      // The presumed-dead runner is not actually dead — it wakes up and tries to settle the
      // SAME dispatch via the task_list-only pair correlator (messageId omitted), exactly
      // the path a resurrection would use.
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: '',
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'dispatch_terminated' })

      // Zero corruption: tasks.execution_receipt_id/status untouched, message stays consumed.
      expect(fixture.harness.sqlite.prepare('SELECT status, execution_receipt_id FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual(before)
      const message = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, read_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; read_at: string | null }
      expect(message.delivery_attempts).toBe(0) // the pair-correlator claim never landed
      expect(message.read_at).not.toBeNull() // still consumed from termination
    } finally {
      fixture.harness.close()
    }
  })

  it('a "dead" runner that resumes with its OWN raw message_id (already leased before termination) is also refused', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // Simulate: the runner HAD already leased normally (delivery_attempts=1, live lease)
      // before the operator declared it dead.
      const liveExpiry = new Date(Date.now() + 5 * 60_000).toISOString()
      fixture.harness.sqlite.prepare(
        `UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = ? WHERE id = ?`,
      ).run(liveExpiry, MESSAGE_ID)

      const reset = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'declared dead mid-lease', override: true, terminate: true,
      })
      expect(reset).toMatchObject({ reset: true, overrode: true, terminated: true })

      // The runner, unaware, tries to settle with its OWN raw message_id.
      await expect(recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID,
        dispatchReceiptId: DISPATCH_ID,
        messageId: MESSAGE_ID,
        stage: 'runtime_consumed',
        runtimeReceiptHash: RUNTIME_HASH,
        attempt: 1,
      })).rejects.toMatchObject({ code: 'dispatch_terminated' })
    } finally {
      fixture.harness.close()
    }
  })

  it('the terminated message is invisible to inbox_lease — it can never be redelivered', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'declared dead', terminate: true,
      })

      const leaseResult = await leaseAgentInbox(fixture.env, { agent: RUNTIME_ADDRESS })
      expect(leaseResult.ok).toBe(true)
      if (leaseResult.ok) expect((leaseResult as { messages: unknown[] }).messages).toHaveLength(0)
    } finally {
      fixture.harness.close()
    }
  })

  // mupot#1494 v4 round 3 (P1-A, adversarial regression) — round 2 refused this outright
  // (`reset_refused_already_terminal`) for ANY terminal receipt, including a genuine
  // `failed`. PROVED wrong: this is EXACTLY the "runner failed, operator wants to reset the
  // lease so it (or a redelivered attempt) can retry" repair the tool exists for — a
  // `failed` settle does NOT, by itself, permanently fence the underlying message (only a
  // `reset_terminated` — an OPERATOR's own explicit declaration — does that). Renamed and
  // re-asserted for the CORRECT behavior: a genuinely `failed` dispatch remains repairable.
  it('reset(override:true, terminate:true) on a dispatch a runner genuinely FAILED (not operator-terminated) is REPAIRABLE — completed/failed are not permanently fenced', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // A REAL, honest settle through the normal path: runtime_consumed then failed (same
      // shape the pre-existing reassignment-guard test above uses — 'completed'
      // additionally requires an independent-gate grant this fixture's simplest path
      // doesn't exercise; 'failed' exercises the SAME class this test is about).
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: '',
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: '',
        stage: 'failed', runtimeReceiptHash: 'e'.repeat(64), attempt: 1, reason: 'genuinely failed, wants a retry',
      })
      // The pair-correlator claim from the FIRST call above left a genuinely LIVE 1-hour
      // lease on the message (attempt 1, never acked) — the exact "wedge" shape an
      // operator's repair call would encounter after a runner reports failure.
      const before = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, read_at, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; read_at: string | null; lease_expires_at: string | null }
      expect(before).toMatchObject({ delivery_attempts: 1, read_at: null })
      expect(before.lease_expires_at).not.toBeNull()

      const result = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'runner failed, resetting so it can retry',
        override: true, terminate: true,
      })
      // reset succeeds (the message's own live lease required override, which was given);
      // overrode is true (it really was live); terminated is FALSE — a `reset_terminated`
      // row is NOT written on top of the already-genuine `failed` receipt (the terminal-
      // receipt insert's own idempotency guard correctly refuses a redundant/contradictory
      // second terminal marker for the same dispatch).
      expect(result).toMatchObject({ reset: true, code: 'reset', overrode: true, terminated: false })

      // The message is genuinely reset — repair worked. delivery_attempts/lease are
      // cleared either way; read_at is set here ONLY because this call itself passed
      // terminate:true (the caller's own request to mark it consumed going forward),
      // not because completed/failed are fenced — that's the thing this test disproves.
      const after = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, read_at, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID) as { delivery_attempts: number; read_at: string | null; lease_expires_at: string | null }
      expect(after).toMatchObject({ delivery_attempts: 0, lease_expires_at: null })
      expect(after.read_at).not.toBeNull()

      // No reset_terminated row was manufactured on top of the genuine failed receipt —
      // exactly the two genuine receipts (order-independent: both happen back-to-back and
      // can tie on created_at's second-resolution timestamp).
      const stages = fixture.harness.sqlite.prepare(
        `SELECT stage FROM task_dispatch_runtime_receipts WHERE dispatch_receipt_id = ?`,
      ).all(DISPATCH_ID) as Array<{ stage: string }>
      expect(stages.map((s) => s.stage).sort()).toEqual(['failed', 'runtime_consumed'])

      const audit = fixture.harness.sqlite.prepare(
        `SELECT operation FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { operation: string }
      expect(audit.operation).toBe('reset_override')
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 (P1-B, adversarial round 2) — org-admin gate on task_dispatch_lease_reset
// must be provable from the CAPABILITY GRANT alone (never hasWorkspaceAdmin's legacy-role
// fallback), and must refuse every agent-bound token outright.
describe('task_dispatch_lease_reset — org-admin gate (mupot#1494 round 3, P1-B)', () => {
  it('M9: hasWorkspaceAdmin\'s legacy-role fallback (capabilities undefined, role reads \'admin\') is refused — 403 need org:admin', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // The EXACT M9 shape: `capabilities` UNDEFINED (never resolved/loaded, or a
      // legacy-session context) with a `role` column that reads 'admin' — the precise
      // condition under which `hasWorkspaceAdmin` (`if (auth.capabilities === undefined)
      // return auth.role === 'owner' || auth.role === 'admin'`) grants org-admin from the
      // LEGACY role alone, with no real org-scope capability grant behind it at all. A
      // capabilities array with only a SQUAD-scoped grant is already correctly refused by
      // `hasWorkspaceAdmin` itself (`hasCapability` gates on scope_type) — it's the
      // `undefined` fallback specifically that this tool must never consult.
      const legacyRoleAuth: AuthContext = {
        userId: GATE_MEMBER_ID,
        tenant: TENANT,
        channel: 'workspace',
        role: 'admin',
        memberId: GATE_MEMBER_ID,
        tokenId: GATE_TOKEN_ID,
        boundAgentId: undefined,
        capabilities: undefined,
      }
      const res = await invokeTool(legacyRoleAuth, fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'legacy-role fallback attempt',
      }, 'https://pot.test')
      expect(res).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

      const row = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID)
      expect(row).toEqual({ delivery_attempts: 0, lease_expires_at: null })
    } finally {
      fixture.harness.close()
    }
  })

  it('an agent-bound token whose member holds real org:admin is refused — operator_principal_required', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const agentBoundOrgAdmin: AuthContext = {
        userId: GATE_MEMBER_ID,
        tenant: TENANT,
        channel: 'workspace',
        role: 'member',
        memberId: GATE_MEMBER_ID,
        tokenId: GATE_TOKEN_ID,
        boundAgentId: GATE_AGENT_ID, // agent-bound
        capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
      }
      const res = await invokeTool(agentBoundOrgAdmin, fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'agent-bound org-admin attempt',
      }, 'https://pot.test')
      expect(res).toMatchObject({ ok: false, status: 403, error: 'operator_principal_required' })
    } finally {
      fixture.harness.close()
    }
  })

  it('a genuine org-admin, member-only (not agent-bound) token succeeds', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const orgAdmin: AuthContext = {
        userId: GATE_MEMBER_ID,
        tenant: TENANT,
        channel: 'workspace',
        role: 'member',
        memberId: GATE_MEMBER_ID,
        tokenId: GATE_TOKEN_ID,
        boundAgentId: undefined,
        capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
      }
      const res = await invokeTool(orgAdmin, fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'genuine org admin repair',
      }, 'https://pot.test')
      expect(res).toMatchObject({ ok: true, result: { reset: true } })
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 (P1-A, adversarial round 2) — the 409 mapping for `dispatch_terminated`
// and `reset_refused_already_terminal` must be proven at the actual MCP tool seam
// (invokeTool), not only via a direct function call. Adversarial finding: mutation M20
// (dropping dispatch_terminated from runtimeReceiptFailure's 409 map) survived because no
// existing test exercised that mapping through the tool layer — 184/184 stayed green.
describe('MCP seam: dispatch_terminated / reset_refused_already_terminal map to 409 (mupot#1494 round 3, P1-A, pins M20)', () => {
  it('task_dispatch_runtime_receipt: a settle attempt against a reset_terminated dispatch is refused 409 dispatch_terminated', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const terminate = await invokeTool(adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'operator declares this dispatch dead', terminate: true,
      }, 'https://pot.test')
      expect(terminate).toMatchObject({ ok: true, result: { reset: true, terminated: true } })

      const res = await invokeTool(fixture.auth, fixture.env, 'task_dispatch_runtime_receipt', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, stage: 'runtime_consumed',
        runtime_receipt_hash: RUNTIME_HASH, attempt: 1,
      }, 'https://pot.test')
      expect(res).toMatchObject({ ok: false, status: 409, error: 'dispatch_terminated' })
    } finally {
      fixture.harness.close()
    }
  })

  it('task_dispatch_lease_reset: a follow-up reset attempt against an already reset_terminated dispatch is refused 409 already_terminated', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const terminate = await invokeTool(adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'first terminate', terminate: true,
      }, 'https://pot.test')
      expect(terminate).toMatchObject({ ok: true, result: { reset: true, terminated: true } })

      const followUp = await invokeTool(adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), fixture.env, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'second attempt, already terminal',
      }, 'https://pot.test')
      expect(followUp).toMatchObject({ ok: false, status: 409, error: 'already_terminated' })
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 (P2-5, adversarial round 2) — reassigning a task while its dispatch is
// genuinely mid-flight (dispatched/consumed, not yet settled either way) orphans it: the old
// assignee's eventual settle fails ownership, the new assignee has nothing of its own to
// settle. task_update refuses the reassignment outright rather than create that wedge.
describe('task_update refuses reassignment while a dispatch is in flight (mupot#1494 round 3, P2-5)', () => {
  it('refuses reassigning assignee_agent_id away while the fixture\'s default dispatch is unsettled', async () => {
    const fixture = runtimeFixture()
    try {
      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: GATE_AGENT_ID,
      }, 'https://pot.test')
      expect(res).toMatchObject({ ok: false, status: 409, error: 'task_dispatch_in_flight' })

      const row = fixture.harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get(TASK_ID) as { assignee_agent_id: string }
      expect(row.assignee_agent_id).toBe(AGENT_ID) // untouched
    } finally {
      fixture.harness.close()
    }
  })

  it('allows reassignment once the dispatch has a TERMINAL runtime receipt (completed)', async () => {
    const fixture = runtimeFixture()
    try {
      // Settle it first — runtime_consumed then completed (VALID_ARTIFACT-free path: this
      // fixture's task has no Artifact:/SHA256: requirement in its done_when).
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'runtime_consumed', runtimeReceiptHash: RUNTIME_HASH, attempt: 1,
      })
      await recordTaskDispatchRuntimeReceipt(fixture.env, fixture.auth, {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, messageId: MESSAGE_ID,
        stage: 'failed', runtimeReceiptHash: 'd'.repeat(64), attempt: 1, reason: 'moving on',
      })

      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: GATE_AGENT_ID,
      }, 'https://pot.test')
      expect(res.ok).toBe(true)

      const row = fixture.harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get(TASK_ID) as { assignee_agent_id: string }
      expect(row.assignee_agent_id).toBe(GATE_AGENT_ID)
    } finally {
      fixture.harness.close()
    }
  })

  it('a same-value "reassignment" (no actual change) is never blocked, even mid-flight', async () => {
    const fixture = runtimeFixture()
    try {
      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, assignee_agent_id: AGENT_ID, note: 'no-op reassignment',
      }, 'https://pot.test')
      expect(res.ok).toBe(true)
    } finally {
      fixture.harness.close()
    }
  })

  // The guard lives ONLY inside the `assignee_agent_id !== undefined` branch — a STATUS
  // change (completion, landing, blocking) that never touches assignee_agent_id at all must
  // never be gated on dispatch flight-state. Regression coverage for the CI failure on
  // tests/mcp-flight-tools.test.ts's "re-authenticates the same Product bearer through
  // assignment, dispatch, read, task completion, and landing": that failure was NOT this
  // guard misfiring on a status change (it never even reaches this code path for one) — it
  // was a hand-rolled fixture missing the task_dispatch_receipts/task_dispatch_runtime_
  // receipts TABLES the guard's query references, on the earlier ASSIGNMENT call, which
  // threw `internal_error` (500) rather than the intended 409. Fixed by adding the (empty)
  // tables to that fixture. This test independently proves the guard's own SCOPE is
  // correct: a pure status transition sails through mid-flight; only a REAL
  // assignee_agent_id change is gated.
  it('a pure STATUS change (no assignee_agent_id in the call at all) is never blocked, even mid-flight — completion/landing must not be gated on dispatch state', async () => {
    const fixture = runtimeFixture()
    try {
      const res = await invokeTool(fixture.gateAuth, fixture.env, 'task_update', {
        task_id: TASK_ID, status: 'in_progress', note: 'operator lands/starts without touching assignment',
      }, 'https://pot.test')
      expect(res.ok).toBe(true)

      const row = fixture.harness.sqlite.prepare('SELECT assignee_agent_id, status FROM tasks WHERE id = ?').get(TASK_ID) as { assignee_agent_id: string; status: string }
      expect(row).toEqual({ assignee_agent_id: AGENT_ID, status: 'in_progress' }) // assignee untouched, status changed
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 round 3 (P1-B, adversarial round 2) — the lease/read_at UPDATE used to run
// OUTSIDE the env.DB.batch that wrote the audit + terminal receipt rows. If the batch threw,
// the message was left read_at-set / lease-cleared with ZERO receipt and ZERO audit rows —
// an unrepairable ghost state. Round 3 folded the lease UPDATE into the same batch. Pin it:
// proxy env.DB.batch to throw and assert the message row is completely untouched (mutation
// M22 — un-batching the lease UPDATE — must go red against this test).
describe('adminResetDispatchLease — the lease UPDATE is atomic with the audit/receipt writes (mupot#1494 round 3, P1-B, pins M22)', () => {
  it('when env.DB.batch throws, the message row (delivery_attempts/read_at/lease_expires_at) is completely untouched', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      const before = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, read_at, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID)

      const throwingDb = {
        ...fixture.env.DB,
        prepare: fixture.env.DB.prepare.bind(fixture.env.DB),
        batch: async () => {
          throw new Error('simulated D1 batch failure')
        },
      } as Env['DB']

      await expect(adminResetDispatchLease(
        { ...fixture.env, DB: throwingDb },
        adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID),
        {
          taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: 'batch will fail',
          terminate: true,
        },
      )).rejects.toThrow('simulated D1 batch failure')

      // If the lease UPDATE were NOT in the same batch (M22), this row would already show
      // delivery_attempts: 0 / read_at set / lease_expires_at: null despite the batch (and
      // therefore the audit + terminal receipt) never having committed anything.
      const after = fixture.harness.sqlite.prepare(
        'SELECT delivery_attempts, read_at, lease_expires_at FROM agent_messages WHERE id = ?',
      ).get(MESSAGE_ID)
      expect(after).toEqual(before)

      expect(fixture.harness.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM mutation_audit_entries WHERE handler = ?',
      ).get('task_dispatch_lease_reset')).toEqual({ count: 0 })
      expect(fixture.harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM task_dispatch_runtime_receipts WHERE stage = 'reset_terminated'",
      ).get()).toEqual({ count: 0 })
    } finally {
      fixture.harness.close()
    }
  })
})

// mupot#1494 v4 round 2 (P2-c, adversarial regression — M-WHERE2 survived), RESTRUCTURED
// round 3 (P1-B) — the override guard used to live inside TWO separate, sequentially-run
// UPDATE statements. Round 3 combined them into ONE lease UPDATE (chosen via `useOverride`)
// so it can be batched atomically with the audit + terminal-receipt writes (see the
// behavioral batch-atomicity tests below) — the "two-attempt" shape this block originally
// pinned no longer exists as written SQL, so pinning it by counting inlined WHERE-clause
// occurrences no longer applies. What still needs pinning: the negated and un-negated
// guard fragments both still exist as their OWN named `const`s, and the lease UPDATE's
// WHERE genuinely branches between them via `useOverride` rather than hard-coding one.
describe('source-assert: adminResetDispatchLease\'s not-live/live guard fragments (mupot#1494 v4 round 3, P1-B)', () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tasks', 'runtime-receipts.ts'),
    'utf8',
  )

  it('the not-live guard is defined negated', () => {
    expect(SOURCE).toContain("const notLiveGuard = `NOT (${LEASE_LIVE_PREDICATE('lease_expires_at', '?3')})`")
  })

  it('the live (override) guard is defined UN-negated — a distinct const, not a copy of the not-live one', () => {
    expect(SOURCE).toContain("const liveGuard = LEASE_LIVE_PREDICATE('lease_expires_at', '?3')")
  })

  it('the lease UPDATE\'s WHERE genuinely branches on useOverride between the two guards, rather than hard-coding one', () => {
    expect(SOURCE).toContain('AND ${useOverride ? liveGuard : notLiveGuard}')
  })

  it('the lease UPDATE requires read_at IS NULL AND dead_lettered_at IS NULL — a terminal message can never be reset', () => {
    expect(SOURCE).toContain('WHERE tenant = ?1 AND id = ?2 AND read_at IS NULL AND dead_lettered_at IS NULL')
  })
})

// mupot#1494 v4 round 2 (P3, adversarial regression — M-SANITIZE survived) — a BEHAVIORAL
// pin (stronger than a source-assert): seed a `reason` containing control/bidi/zero-width
// characters this file's own `sanitizeReceiptText` strips, and prove the PERSISTED
// evidence_json (both the mutation_audit_entries row AND, when terminate:true, the
// task_dispatch_runtime_receipts.reason column) actually has them stripped — not merely
// that the function is referenced somewhere in the source.
describe('adminResetDispatchLease sanitizes `reason` before it is ever persisted (mupot#1494 v4 round 2, P3)', () => {
  it('a control character + a zero-width character + a bidi override in `reason` are stripped from BOTH the audit evidence and the terminal receipt row', async () => {
    const fixture = runtimeFixture({ unleased: true })
    try {
      // \x07 (BEL, a C0 control char), ​ (zero-width space), ‮ (RTL override).
      const hostileReason = 'operator says: stop\x07 now​‮reversed'
      const result = await adminResetDispatchLease(fixture.env, adminAuthFor(GATE_MEMBER_ID, GATE_TOKEN_ID), {
        taskId: TASK_ID, dispatchReceiptId: DISPATCH_ID, reason: hostileReason, terminate: true,
      })
      expect(result).toMatchObject({ reset: true, terminated: true })

      const audit = fixture.harness.sqlite.prepare(
        `SELECT evidence_json FROM mutation_audit_entries WHERE id = ?`,
      ).get(result.audit_id) as { evidence_json: string }
      const auditReason = (JSON.parse(audit.evidence_json) as { reason: string }).reason
      expect(auditReason).not.toContain('\x07')
      expect(auditReason).not.toContain('​')
      expect(auditReason).not.toContain('‮')
      expect(auditReason).toContain('operator says: stop')
      expect(auditReason).toContain('reversed')

      const receipt = fixture.harness.sqlite.prepare(
        `SELECT reason FROM task_dispatch_runtime_receipts WHERE dispatch_receipt_id = ? AND stage = 'reset_terminated'`,
      ).get(DISPATCH_ID) as { reason: string }
      expect(receipt.reason).not.toContain('\x07')
      expect(receipt.reason).not.toContain('​')
      expect(receipt.reason).not.toContain('‮')
      expect(receipt.reason).toBe(auditReason) // both writes sanitize identically
    } finally {
      fixture.harness.close()
    }
  })
})
