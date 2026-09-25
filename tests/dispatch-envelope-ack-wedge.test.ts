// mupot#1539 — acking a dispatch envelope before `completed` wedged the task forever.
//
// Defect class: "a delivery fact is being treated as a settle". `read_at` (inbox_ack, plain
// `inbox` consume) and lease expiry are facts about the INBOX ENVELOPE; validateEnvelope treated
// them as "this dispatch is stale" for `completed`/`failed` too, so a runner that acked its
// envelope after `runtime_consumed` (or simply outlived the lease) could never settle, and no
// repair path existed. Prod victims 5e194701 / 73d0c2a3.
//
// Every test drives the REAL service paths — MCP tool handlers via invokeTool, and the REST
// /actions surface via mcpActionsApp — against real SQLite with every migration applied.
// Direct SQL is used only to reach a state no public path can produce in test time (a lapsed
// lease, a dead-lettered row, a receipt attributed to another agent), and each such line says so.

import { describe, expect, it } from 'vitest'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { invokeTool, mcpActionsApp } from '../src/mcp'
import { inboxApp } from '../src/agents/inbox-routes'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'tenant-1539'
const T0 = '2026-09-23T18:00:00.000Z'
const DISPATCH_ID = 'dispatch-1539'
const MESSAGE_ID = 'message-1539'
const OTHER_MESSAGE_ID = 'message-1539-plain'
const TASK_ID = 'task-1539'
const AGENT_ID = 'agent-1539'
const MEMBER_ID = 'member-1539'
const TOKEN_ID = 'token-1539'
const GATE_AGENT_ID = 'agent-1539-gate'
const GATE_MEMBER_ID = 'member-1539-gate'
const GATE_TOKEN_ID = 'token-1539-gate'
const SQUAD_ID = 'squad-1539'
// sha256('test-token') — lets the REST /actions surface authenticate as AGENT_ID.
const TEST_TOKEN_HASH = '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e'
const ORIGIN = 'https://pot.test'

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  // The dispatch envelope is seeded exactly as deliverDispatchToInbox writes it: pristine
  // (delivery_attempts = 0, no lease, unread), to_agent = runtime_address = the assignee id.
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('department-1539', 'd1539', 'D1539');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-1539', 's1539', 'S1539');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', 'runner-1539', 'Runner', 'active'),
      ('${GATE_AGENT_ID}', '${SQUAD_ID}', 'gate-1539', 'Gate', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${MEMBER_ID}', 'Runner Member', 'active', '${TENANT}'),
      ('${GATE_MEMBER_ID}', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-1539', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member'),
      ('cap-1539-gate', '${GATE_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member'),
      ('cap-1539-operator', '${GATE_MEMBER_ID}', 'org', NULL, 'admin');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${T0}'),
      ('${TENANT}', '${GATE_AGENT_ID}', '${GATE_MEMBER_ID}', '${T0}');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at
    ) VALUES
      ('${TOKEN_ID}', '${MEMBER_ID}', '${TEST_TOKEN_HASH}', 'runner', 'workspace', '${T0}', NULL,
       '${AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z'),
      ('${GATE_TOKEN_ID}', '${GATE_MEMBER_ID}', 'hash-1539-gate', 'gate', 'workspace', '${T0}', NULL,
       '${GATE_AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gate-grant-1539', 'gate:independent', 'agent', '${GATE_AGENT_ID}', '${MEMBER_ID}', '${T0}');
    INSERT INTO tasks (
      id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, created_at, updated_at
    ) VALUES (
      '${TASK_ID}', '${SQUAD_ID}', 'Wedge repro', 'Do the work',
      'The work is receipted.', 'open', '${AGENT_ID}', 'gate:independent', '${T0}', '${T0}'
    );
    INSERT INTO task_dispatch_receipts (
      id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id,
      created_at, claimed_at, consumed_at, attempts, last_error
    ) VALUES (
      '${DISPATCH_ID}', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}',
      'member', '${MEMBER_ID}', '${T0}', '${T0}', '${T0}', 1, NULL
    );
    INSERT INTO agent_messages (
      id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at
    ) VALUES (
      '${MESSAGE_ID}', '${TENANT}', '${AGENT_ID}', 'mupot-dispatch', '${MEMBER_ID}', 'request',
      '{"version":"runtime.dispatch/v1","type":"task_dispatch","task_id":"${TASK_ID}","dispatch_receipt_id":"${DISPATCH_ID}","squad_id":"${SQUAD_ID}","runtime_address":"${AGENT_ID}"}',
      'dispatch-inbox:${DISPATCH_ID}', '${T0}'
    );
    INSERT INTO agent_messages (
      id, tenant, to_agent, from_agent, from_member, kind, body, created_at
    ) VALUES (
      '${OTHER_MESSAGE_ID}', '${TENANT}', '${AGENT_ID}', '${GATE_AGENT_ID}', '${GATE_MEMBER_ID}',
      'message', 'ordinary mail', '${T0}'
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
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
  // Race seam (mupot#1539 round 2, P0-1): `beforeBatch` runs ONCE, immediately before the next
  // env.DB.batch() — i.e. after validateEnvelope and every async authority/gate read, right at
  // the write boundary. It stands in for a concurrent writer landing in that window.
  const hooks: { beforeBatch: (() => void) | null } = { beforeBatch: null }
  const db = new Proxy(harness.db, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (stmts: Parameters<typeof target.batch>[0]) => {
          const hook = hooks.beforeBatch
          hooks.beforeBatch = null
          hook?.()
          return target.batch(stmts)
        }
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const env = { TENANT_SLUG: TENANT, DB: db } as Env
  const gateAuth: AuthContext = {
    userId: GATE_MEMBER_ID,
    tenant: TENANT,
    channel: 'workspace',
    role: 'member',
    memberId: GATE_MEMBER_ID,
    tokenId: GATE_TOKEN_ID,
    boundAgentId: GATE_AGENT_ID,
    capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
  // Org-admin OPERATOR (not agent-bound) for task_dispatch_lease_reset.
  const operatorAuth: AuthContext = {
    userId: GATE_MEMBER_ID,
    tenant: TENANT,
    channel: 'workspace',
    role: 'owner',
    memberId: GATE_MEMBER_ID,
    tokenId: GATE_TOKEN_ID,
    boundAgentId: undefined,
    capabilities: [{ member_id: GATE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
  const call = (tool: string, args: Record<string, unknown>) => invokeTool(auth, env, tool, args, ORIGIN)
  const callAs = (who: AuthContext, tool: string, args: Record<string, unknown>) => invokeTool(who, env, tool, args, ORIGIN)
  const restInboxConsume = async () => {
    const res = await inboxApp.request(`${ORIGIN}/`, { headers: { authorization: 'Bearer test-token' } }, env)
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const rest = async (tool: string, args: Record<string, unknown>) => {
    const res = await mcpActionsApp.request(`${ORIGIN}/actions/${tool}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }, env)
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const envelope = () => harness.sqlite.prepare(
    'SELECT read_at, delivery_attempts, lease_expires_at, dead_lettered_at FROM agent_messages WHERE id = ?',
  ).get(MESSAGE_ID) as {
    read_at: string | null; delivery_attempts: number; lease_expires_at: string | null; dead_lettered_at: string | null
  }
  const taskStatus = () => (harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as {
    status: string
  }).status
  const receipts = (stage: string) => (harness.sqlite.prepare(
    'SELECT COUNT(*) AS n FROM task_dispatch_runtime_receipts WHERE dispatch_receipt_id = ? AND stage = ?',
  ).get(DISPATCH_ID, stage) as { n: number }).n
  const lapseLease = () => harness.sqlite.prepare(
    "UPDATE agent_messages SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
  ).run(MESSAGE_ID)
  return {
    harness, env, auth, gateAuth, operatorAuth, hooks, call, callAs, rest, restInboxConsume,
    envelope, taskStatus, receipts, lapseLease,
  }
}

type Fixture = ReturnType<typeof fixture>

const settle = (stage: 'runtime_consumed' | 'completed' | 'failed', attempt = 1, extra: Record<string, unknown> = {}) => ({
  task_id: TASK_ID,
  dispatch_receipt_id: DISPATCH_ID,
  message_id: MESSAGE_ID,
  stage,
  runtime_receipt_hash: (stage === 'runtime_consumed' ? 'a' : stage === 'completed' ? 'b' : 'c').repeat(64),
  attempt,
  ...(stage === 'completed' ? { result: 'Work done.' } : {}),
  ...(stage === 'failed' ? { reason: 'Could not finish.' } : {}),
  ...extra,
})

/** Pair correlator (no message_id) — the task_list-only runner shape. */
const pairSettle = (stage: 'runtime_consumed' | 'completed' | 'failed', attempt = 1) => {
  const { message_id: _drop, ...rest } = settle(stage, attempt)
  return rest
}

/** Real custody: inbox_lease hands the envelope out (delivery_attempts 0 -> 1, live lease),
 *  then runtime_consumed is recorded under that lease. */
async function leaseAndConsume(f: Fixture) {
  const lease = await f.call('inbox_lease', {})
  expect(lease.ok).toBe(true)
  expect(f.envelope().delivery_attempts).toBe(1)
  const consumed = await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed'))
  expect(consumed).toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
}

/** A consumed receipt the CALLER did not write. No public path produces one (the settle path
 *  pins agent = dispatch.agent_id = task.assignee = caller, and receipts are append-only, so an
 *  UPDATE is refused by trigger); it is forged with direct INSERTs after a REAL lease. */
function forgeConsumed(f: Fixture, over: { agentId: string; memberId: string; tokenId: string; messageId: string }) {
  f.harness.sqlite.exec(`
    INSERT INTO mutation_audit_entries (
      id, tenant, principal_kind, principal_id, member_id, agent_id, credential_id, origin,
      handler, operation, target_kind, target_id, task_id, request_id, idempotency_key,
      evidence_json, recorded_at
    ) VALUES (
      'audit-forged', '${TENANT}', 'agent', '${over.agentId}', '${over.memberId}', '${over.agentId}',
      '${over.tokenId}', 'mcp', 'task_dispatch_runtime_receipt', 'runtime_consumed', 'task',
      '${TASK_ID}', '${TASK_ID}', 'forged', 'forged', '{}', '${T0}'
    );
    INSERT INTO task_dispatch_runtime_receipts (
      id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id,
      stage, attempt, runtime_address, runtime_receipt_hash, request_digest, artifact_refs_json,
      artifact_sha256, result, reason, audit_entry_id, created_at
    ) VALUES (
      'receipt-forged', '${TENANT}', '${DISPATCH_ID}', '${TASK_ID}', '${over.agentId}',
      '${over.messageId}', '${over.memberId}', '${over.tokenId}', 'runtime_consumed', 1,
      '${AGENT_ID}', '${'a'.repeat(64)}', '${'e'.repeat(64)}', '[]', NULL, NULL, NULL,
      'audit-forged', '${T0}'
    );
    UPDATE tasks SET status = 'in_progress', execution_receipt_id = '${DISPATCH_ID}' WHERE id = '${TASK_ID}';
  `)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('#1539 — completed/failed after the envelope was acked or its lease lapsed', () => {
  it('PROD SEQUENCE: dispatch -> runtime_consumed -> inbox_ack -> completed settles the task', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      expect(await f.call('inbox_ack', { ids: [MESSAGE_ID] }))
        .toMatchObject({ ok: true, result: { acked: [MESSAGE_ID], refused: [] } })
      expect(f.envelope().read_at).not.toBeNull()
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: true, result: { receipt: { stage: 'completed' }, task_status: 'review' } })
      // Exact replay stays idempotent on a read envelope.
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('PROD SEQUENCE over REST /actions: ack then completed settles', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      const ack = await f.rest('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack.status).toBe(200)
      const completed = await f.rest('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed.status).toBe(200)
      expect(completed.body).toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('failed after ack also settles (task -> blocked)', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('failed')))
        .toMatchObject({ ok: true, result: { receipt: { stage: 'failed' }, task_status: 'blocked' } })
    } finally {
      f.harness.close()
    }
  })

  it('completed after the lease LAPSED (unread, long work) settles', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.lapseLease() // direct SQL: stands in for >1h of wall-clock work
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })
})

describe('#1539 — what does NOT prove custody', () => {
  it('a read envelope with no consumed receipt cannot go straight to completed', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox', {})).ok).toBe(true)
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('open')
    } finally {
      f.harness.close()
    }
  })

  it('consumed receipt written by a DIFFERENT agent', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      forgeConsumed(f, { agentId: GATE_AGENT_ID, memberId: GATE_MEMBER_ID, tokenId: GATE_TOKEN_ID, messageId: MESSAGE_ID })
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })

  it('consumed receipt anchored to a DIFFERENT message', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      forgeConsumed(f, { agentId: AGENT_ID, memberId: MEMBER_ID, tokenId: TOKEN_ID, messageId: OTHER_MESSAGE_ID })
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })

  it('a dead-lettered envelope, even with a consumed receipt', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      f.harness.sqlite.prepare( // direct SQL: dead-lettering needs 5 real hand-outs
        "UPDATE agent_messages SET dead_lettered_at = ?, dead_letter_reason = 'max_delivery_attempts_exceeded:5' WHERE id = ?",
      ).run(T0, MESSAGE_ID)
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
    } finally {
      f.harness.close()
    }
  })

  it('attempt mismatch: envelope re-handed out after the consume', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.lapseLease()
      expect((await f.call('inbox_lease', {})).ok).toBe(true) // REAL re-lease -> attempt 2
      expect(f.envelope().delivery_attempts).toBe(2)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })

  it('completed@2 when only attempt 1 was consumed (no receipt row lands)', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.lapseLease()
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed', 2)))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.receipts('completed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('a failed receipt is not custody for completed', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      expect(await f.call('task_dispatch_runtime_receipt', settle('failed')))
        .toMatchObject({ ok: true, result: { task_status: 'blocked' } })
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.receipts('completed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('#1539 round 2 P0-1 — envelope invariants are re-asserted at write time (race)', () => {
  const relet = (f: Fixture) => () => {
    // A concurrent inbox_lease re-hand-out landing between validateEnvelope and the batch.
    f.harness.sqlite.prepare(
      "UPDATE agent_messages SET delivery_attempts = delivery_attempts + 1, lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(MESSAGE_ID)
  }

  it('runtime_consumed: a re-lease at the batch boundary refuses and writes nothing', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      f.hooks.beforeBatch = relet(f)
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(f.taskStatus()).toBe('open')
      expect(f.receipts('runtime_consumed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('completed (live-lease path): the Athena race refuses instead of moving the task to review', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.hooks.beforeBatch = relet(f)
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(f.taskStatus()).toBe('in_progress')
      expect(f.receipts('completed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('completed (custody path, acked): a dead-letter at the batch boundary refuses', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      f.hooks.beforeBatch = () => {
        f.harness.sqlite.prepare("UPDATE agent_messages SET dead_lettered_at = ? WHERE id = ?").run(T0, MESSAGE_ID)
      }
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(f.taskStatus()).toBe('in_progress')
      expect(f.receipts('completed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('failed (P2-b): a re-lease at the batch boundary refuses', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.hooks.beforeBatch = relet(f)
      expect(await f.call('task_dispatch_runtime_receipt', settle('failed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(f.taskStatus()).toBe('in_progress')
      expect(f.receipts('failed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('failed (P2-b): no consumed receipt and no live lease -> refused', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      f.lapseLease()
      expect(await f.call('task_dispatch_runtime_receipt', settle('failed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.receipts('failed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('#1539 round 2 P0-3 — an envelope read BEFORE custody is recoverable by the assignee', () => {
  it('plain MCP `inbox` consume -> runtime_consumed (pair correlator) -> completed', async () => {
    const f = fixture()
    try {
      const read = await f.call('inbox', {})
      expect(read.ok).toBe(true)
      expect(f.envelope()).toMatchObject({ delivery_attempts: 0 })
      expect(f.envelope().read_at).not.toBeNull()
      expect(await f.call('task_dispatch_runtime_receipt', pairSettle('runtime_consumed')))
        .toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
      expect(f.envelope().delivery_attempts).toBe(1)
      expect(await f.call('task_dispatch_runtime_receipt', pairSettle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('REST GET /api/inbox consume -> runtime_consumed (message_id) -> completed', async () => {
    const f = fixture()
    try {
      const read = await f.restInboxConsume()
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ ok: true, consumed: true })
      expect(f.envelope().read_at).not.toBeNull()
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed')))
        .toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('inbox_lease(attempt_id) -> inbox_lease_ack before custody -> runtime_consumed -> completed', async () => {
    const f = fixture()
    try {
      const A = 'attempt-1539-aaaaaaaa'
      expect(await f.call('inbox_lease', { attempt_id: A, limit: 1 }))
        .toMatchObject({ ok: true, result: { state: 'leased' } })
      expect(await f.call('inbox_lease_ack', { attempt_id: A }))
        .toMatchObject({ ok: true, result: { state: 'acked' } })
      expect(f.envelope()).toMatchObject({ delivery_attempts: 1, lease_expires_at: null })
      expect(f.envelope().read_at).not.toBeNull()
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed')))
        .toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
      expect(f.envelope().delivery_attempts).toBe(1) // never advanced, never rewound
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('inbox_ack before custody -> runtime_consumed -> completed (acking is never destructive)', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      expect(await f.call('inbox_ack', { ids: [MESSAGE_ID, OTHER_MESSAGE_ID] }))
        .toMatchObject({ ok: true, result: { acked: [MESSAGE_ID, OTHER_MESSAGE_ID], refused: [] } })
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed')))
        .toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('recovery claim is the assignee\'s only: another agent writes nothing to the envelope', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox', {})).ok).toBe(true)
      const before = f.envelope()
      const res = await f.callAs(f.gateAuth, 'task_dispatch_runtime_receipt', settle('runtime_consumed'))
      expect(res.ok).toBe(false)
      expect(f.envelope()).toEqual(before)
    } finally {
      f.harness.close()
    }
  })

  it('recovery never rewinds or advances the attempt: attempt 2 on a row handed out once is refused', async () => {
    const f = fixture()
    try {
      const A = 'attempt-1539-bbbbbbbb'
      await f.call('inbox_lease', { attempt_id: A, limit: 1 })
      await f.call('inbox_lease_ack', { attempt_id: A })
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed', 2)))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.envelope()).toMatchObject({ delivery_attempts: 1, lease_expires_at: null })
    } finally {
      f.harness.close()
    }
  })

  it('recovery is refused once any runtime receipt exists (failed, then read)', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      expect((await f.call('task_dispatch_runtime_receipt', settle('failed'))).ok).toBe(true)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      const before = f.envelope()
      expect((await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed'))).ok).toBe(false)
      expect(f.envelope()).toEqual(before)
    } finally {
      f.harness.close()
    }
  })

  it('recovery is refused while the task is in a status runtime_consumed cannot accept', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox', {})).ok).toBe(true)
      f.harness.sqlite.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(TASK_ID) // out-of-band move
      const before = f.envelope()
      expect((await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed'))).ok).toBe(false)
      expect(f.envelope()).toEqual(before)
    } finally {
      f.harness.close()
    }
  })

  it('the adversarial in_progress sequence no longer strands the envelope: inbox_ack succeeds', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      expect(await f.call('task_update', { task_id: TASK_ID, status: 'in_progress' })).toMatchObject({ ok: true })
      expect(await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(await f.call('inbox_ack', { ids: [MESSAGE_ID] }))
        .toMatchObject({ ok: true, result: { acked: [MESSAGE_ID] } })
    } finally {
      f.harness.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('#1539 round 2 P1-A — lease reset never rewinds the attempt under custody', () => {
  it('reset (no terminate) is refused once runtime_consumed exists; the stale completed@1 cannot land', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.lapseLease()
      const reset = await f.callAs(f.operatorAuth, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'runner looks dead',
      })
      expect(reset).toMatchObject({ ok: false, status: 409, error: 'dispatch_consumed' })
      expect(f.envelope().delivery_attempts).toBe(1)
      // The adversarial's continuation: a re-lease now moves to attempt 2, never back to 1.
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      expect(f.envelope().delivery_attempts).toBe(2)
      expect(await f.call('task_dispatch_runtime_receipt', settle('completed')))
        .toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.receipts('completed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })

  it('the atomic half: custody landing between the pre-check and the reset UPDATE still refuses', async () => {
    const f = fixture()
    try {
      expect((await f.call('inbox_lease', {})).ok).toBe(true)
      f.lapseLease()
      // Forge the consumed receipt at the reset's batch boundary (after its pre-check read).
      f.hooks.beforeBatch = () => forgeConsumed(f, {
        agentId: AGENT_ID, memberId: MEMBER_ID, tokenId: TOKEN_ID, messageId: MESSAGE_ID,
      })
      const reset = await f.callAs(f.operatorAuth, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'race',
      })
      expect(reset.ok).toBe(false)
      expect(f.envelope().delivery_attempts).toBe(1)
    } finally {
      f.harness.close()
    }
  })

  it('terminate stays available as the operator\'s way out under custody', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      f.lapseLease()
      const reset = await f.callAs(f.operatorAuth, 'task_dispatch_lease_reset', {
        task_id: TASK_ID, dispatch_receipt_id: DISPATCH_ID, reason: 'runner is gone', terminate: true,
      })
      expect(reset).toMatchObject({ ok: true, result: { reset: true, terminated: true } })
    } finally {
      f.harness.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('#1539 round 2 P2-a — failed cannot settle after the dispatch completed', () => {
  it('completed -> ack -> gate reject -> stale failed@1 is refused; task stays rejected, result intact', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      expect((await f.call('task_dispatch_runtime_receipt', settle('completed'))).ok).toBe(true)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(await f.callAs(f.gateAuth, 'task_verdict', { task_id: TASK_ID, verdict: 'rejected', note: 'redo' }))
        .toMatchObject({ ok: true, result: { task: { status: 'rejected' } } })
      expect(await f.call('task_dispatch_runtime_receipt', settle('failed')))
        .toMatchObject({ ok: false, error: 'runtime_receipt_transition_conflict' })
      expect(f.harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'rejected', result: 'Work done.' })
      expect(f.receipts('failed')).toBe(0)
    } finally {
      f.harness.close()
    }
  })
})
