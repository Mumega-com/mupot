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
import {
  DISPATCH_ENVELOPE_REQUEST_PREFIX,
  DISPATCH_ENVELOPE_SENDER,
} from '../src/agents/messages'
import { DISPATCH_BRIDGE_SENDER, DISPATCH_INBOX_PREFIX } from '../src/bus/fleet-bridge'
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
      ('cap-1539-gate', '${GATE_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
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
  const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  const call = (tool: string, args: Record<string, unknown>) => invokeTool(auth, env, tool, args, ORIGIN)
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
  return { harness, env, auth, call, rest, envelope, taskStatus }
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

/** Real custody: inbox_lease hands the envelope out (delivery_attempts 0 -> 1, live lease),
 *  then runtime_consumed is recorded under that lease. */
async function leaseAndConsume(f: Fixture) {
  const lease = await f.call('inbox_lease', {})
  expect(lease.ok).toBe(true)
  expect(f.envelope().delivery_attempts).toBe(1)
  const consumed = await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed'))
  expect(consumed).toMatchObject({ ok: true, result: { task_status: 'in_progress' } })
}

describe('mupot#1539 — completed/failed after the envelope was acked or its lease lapsed', () => {
  it('PROD SEQUENCE: dispatch -> runtime_consumed -> inbox_ack -> completed settles the task', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID], refused: [] } })
      expect(f.envelope().read_at).not.toBeNull()

      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: true, result: { receipt: { stage: 'completed' }, task_status: 'review' } })
      expect(f.taskStatus()).toBe('review')
      // Exact replay of the same completed call stays idempotent on a read envelope.
      const replay = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(replay).toMatchObject({ ok: true, result: { task_status: 'review' } })
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
      expect(ack.body).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID] } })
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
      const failed = await f.call('task_dispatch_runtime_receipt', settle('failed'))
      expect(failed).toMatchObject({ ok: true, result: { receipt: { stage: 'failed' }, task_status: 'blocked' } })
    } finally {
      f.harness.close()
    }
  })

  it('completed after the lease LAPSED (unread, long work) settles', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      // Direct SQL: stands in for >1h of wall-clock work; no public path moves the clock.
      f.harness.sqlite.prepare("UPDATE agent_messages SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
        .run(MESSAGE_ID)
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: true, result: { task_status: 'review' } })
    } finally {
      f.harness.close()
    }
  })

  it('read envelope with NO consumed receipt: runtime_consumed AND completed stay refused', async () => {
    const f = fixture()
    try {
      // Real path that marks a pristine envelope read without custody: a plain `inbox` consume.
      const read = await f.call('inbox', {})
      expect(read.ok).toBe(true)
      expect(f.envelope().read_at).not.toBeNull()
      const consumed = await f.call('task_dispatch_runtime_receipt', settle('runtime_consumed'))
      expect(consumed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('open')
    } finally {
      f.harness.close()
    }
  })

  // A consumed receipt the CALLER did not write. No public path produces one (the settle path
  // pins agent = dispatch.agent_id = task.assignee = caller, and receipts are append-only), so
  // it is forged with direct SQL: the runner really leases the envelope, the forged receipt is
  // inserted, the task is moved to the state a real consume would leave, and the runner acks.
  // Without the pins in consumed_by_caller, the runner could then settle `completed` on the
  // strength of a receipt that proves nothing about its own custody.
  async function forgeConsumed(f: Fixture, over: { agentId: string; memberId: string; tokenId: string; messageId: string }) {
    const lease = await f.call('inbox_lease', {})
    expect(lease.ok).toBe(true)
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
    const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
    expect(ack).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID] } })
  }

  it('consumed receipt written by a DIFFERENT agent does not prove the caller\'s custody', async () => {
    const f = fixture()
    try {
      await forgeConsumed(f, {
        agentId: GATE_AGENT_ID, memberId: GATE_MEMBER_ID, tokenId: GATE_TOKEN_ID, messageId: MESSAGE_ID,
      })
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })

  it('consumed receipt anchored to a DIFFERENT message does not count', async () => {
    const f = fixture()
    try {
      await forgeConsumed(f, {
        agentId: AGENT_ID, memberId: MEMBER_ID, tokenId: TOKEN_ID, messageId: OTHER_MESSAGE_ID,
      })
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })

  it('dead-lettered envelope stays refused even with a consumed receipt', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      // Direct SQL: dead-lettering needs 5 real hand-outs; the state is what matters here.
      f.harness.sqlite.prepare(
        "UPDATE agent_messages SET dead_lettered_at = ?, dead_letter_reason = 'max_delivery_attempts_exceeded:5' WHERE id = ?",
      ).run(T0, MESSAGE_ID)
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
    } finally {
      f.harness.close()
    }
  })

  it('attempt mismatch (envelope re-handed out after the consume) stays refused', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      // Direct SQL: lapse the lease, then a REAL inbox_lease re-hands the envelope out
      // (delivery_attempts 1 -> 2) — the redelivery the lease exists to allow.
      f.harness.sqlite.prepare("UPDATE agent_messages SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
        .run(MESSAGE_ID)
      const relet = await f.call('inbox_lease', {})
      expect(relet.ok).toBe(true)
      expect(f.envelope().delivery_attempts).toBe(2)
      await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: false, error: 'runtime_delivery_stale' })
      expect(f.taskStatus()).toBe('in_progress')
    } finally {
      f.harness.close()
    }
  })
})

describe('mupot#1539 — inbox_ack refuses a dispatch envelope not yet taken into custody', () => {
  it('refuses the unsettled envelope with a typed reason and still acks the rest of the batch', async () => {
    const f = fixture()
    try {
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID, OTHER_MESSAGE_ID] })
      expect(ack).toMatchObject({
        ok: true,
        result: {
          acked: [OTHER_MESSAGE_ID],
          already_read: [],
          refused: [MESSAGE_ID],
          refusal_reasons: { [MESSAGE_ID]: 'dispatch_envelope_unsettled' },
        },
      })
      expect(f.envelope().read_at).toBeNull()
      // Custody is still takeable after the refused ack — the whole point of refusing it.
      await leaseAndConsume(f)
    } finally {
      f.harness.close()
    }
  })

  it('REST /actions/inbox_ack applies the same guard', async () => {
    const f = fixture()
    try {
      const ack = await f.rest('inbox_ack', { ids: [MESSAGE_ID, OTHER_MESSAGE_ID] })
      expect(ack.status).toBe(200)
      expect(ack.body).toMatchObject({
        ok: true,
        result: { acked: [OTHER_MESSAGE_ID], refusal_reasons: { [MESSAGE_ID]: 'dispatch_envelope_unsettled' } },
      })
      expect(f.envelope().read_at).toBeNull()
    } finally {
      f.harness.close()
    }
  })

  it('after completed, inbox_ack succeeds', async () => {
    const f = fixture()
    try {
      await leaseAndConsume(f)
      const completed = await f.call('task_dispatch_runtime_receipt', settle('completed'))
      expect(completed).toMatchObject({ ok: true, result: { task_status: 'review' } })
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID], refused: [], refusal_reasons: {} } })
    } finally {
      f.harness.close()
    }
  })

  it('an envelope whose task is no longer settleable (done) is ackable — the guard never strands mail', async () => {
    const f = fixture()
    try {
      // Direct SQL: the task was closed out-of-band (operator), so this dispatch can never settle.
      f.harness.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(TASK_ID)
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID], refusal_reasons: {} } })
    } finally {
      f.harness.close()
    }
  })

  it('a dead-lettered envelope is ackable — settle is already impossible for it', async () => {
    const f = fixture()
    try {
      // Direct SQL: see the dead-letter test above.
      f.harness.sqlite.prepare(
        "UPDATE agent_messages SET dead_lettered_at = ?, dead_letter_reason = 'max_delivery_attempts_exceeded:5' WHERE id = ?",
      ).run(T0, MESSAGE_ID)
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack).toMatchObject({ ok: true, result: { acked: [MESSAGE_ID], refusal_reasons: {} } })
    } finally {
      f.harness.close()
    }
  })

  it('refusal reasons are never given for ids that are not the caller\'s (no message-id oracle)', async () => {
    const f = fixture()
    try {
      // Direct SQL: readdress the envelope to another agent.
      f.harness.sqlite.prepare('UPDATE agent_messages SET to_agent = ? WHERE id = ?').run(GATE_AGENT_ID, MESSAGE_ID)
      const ack = await f.call('inbox_ack', { ids: [MESSAGE_ID] })
      expect(ack).toMatchObject({ ok: true, result: { acked: [], refused: [MESSAGE_ID], refusal_reasons: {} } })
    } finally {
      f.harness.close()
    }
  })

  it('the guard\'s literals match what deliverDispatchToInbox writes', () => {
    expect(DISPATCH_ENVELOPE_SENDER).toBe(DISPATCH_BRIDGE_SENDER)
    expect(DISPATCH_ENVELOPE_REQUEST_PREFIX).toBe(DISPATCH_INBOX_PREFIX)
  })
})
