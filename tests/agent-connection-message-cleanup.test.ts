import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ackAgentMessages,
  deleteAgentConnectionMessage,
  leaseAgentInbox,
  reconcileAgentInboxLeaseAttempt,
} from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function insertMessage(
  sqlite: SqliteD1Harness['sqlite'],
  values: {
    id: string
    tenant: string
    agent: string
    requestId: string
  },
): void {
  sqlite.prepare(
    `INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at)
     VALUES (?, ?, ?, ?, 'member-1', 'request', 'not persisted in receipt', ?, ?)`,
  ).run(
    values.id,
    values.tenant,
    values.agent,
    values.agent,
    values.requestId,
    '2026-07-24T12:00:00.000Z',
  )
}

describe('agent connection exact message cleanup', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as Env
    insertMessage(harness.sqlite, {
      id: 'message-target',
      tenant: 'tenant-a',
      agent: 'agent-1',
      requestId: 'agent-connection:receipt-1',
    })
    insertMessage(harness.sqlite, {
      id: 'message-neighbor',
      tenant: 'tenant-a',
      agent: 'agent-1',
      requestId: 'agent-connection:receipt-2',
    })
    insertMessage(harness.sqlite, {
      id: 'message-other-tenant',
      tenant: 'tenant-b',
      agent: 'agent-1',
      requestId: 'agent-connection:receipt-1',
    })
  })

  afterEach(() => harness.close())

  it('deletes only the exact tenant, message, agent, and request tuple', async () => {
    await expect(deleteAgentConnectionMessage(env, {
      messageId: 'message-target',
      agentId: 'agent-1',
      requestId: 'agent-connection:receipt-1',
    })).resolves.toEqual({ ok: true })

    expect(harness.sqlite.prepare(
      'SELECT id, tenant FROM agent_messages ORDER BY id',
    ).all()).toEqual([
      { id: 'message-neighbor', tenant: 'tenant-a' },
      { id: 'message-other-tenant', tenant: 'tenant-b' },
    ])
  })

  it('refuses every mismatched tuple without deleting any message', async () => {
    for (const input of [
      {
        messageId: 'message-target',
        agentId: 'agent-wrong',
        requestId: 'agent-connection:receipt-1',
      },
      {
        messageId: 'message-target',
        agentId: 'agent-1',
        requestId: 'agent-connection:receipt-wrong',
      },
      {
        messageId: 'message-other-tenant',
        agentId: 'agent-1',
        requestId: 'agent-connection:receipt-1',
      },
    ]) {
      await expect(deleteAgentConnectionMessage(env, input)).resolves.toEqual({
        ok: false,
        reason: 'message_not_found',
      })
    }
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM agent_messages',
    ).get()).toEqual({ count: 3 })
  })

  it('atomically terminalizes an acked attempt before deleting its verification message', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111'
    const leased = await leaseAgentInbox(env, {
      agent: 'agent-1', limit: 1, leaseSeconds: 30, attemptId,
    }, { now: () => '2026-07-24T12:00:01.000Z' })
    expect(leased).toMatchObject({ ok: true, state: 'leased', messages: [{ id: 'message-target' }] })
    expect(await ackAgentMessages(env, { agent: 'agent-1', ids: ['message-target'] }, {
      now: () => '2026-07-24T12:00:02.000Z',
    })).toMatchObject({ ok: true, acked: ['message-target'] })

    await expect(deleteAgentConnectionMessage(env, {
      messageId: 'message-target', agentId: 'agent-1', requestId: 'agent-connection:receipt-1',
    })).resolves.toEqual({ ok: true })
    expect(harness.sqlite.prepare(
      `SELECT state, message_id, terminal_message_id, message_seq,
              delivery_attempt, lease_expires_at
         FROM agent_inbox_lease_attempts WHERE attempt_id = ?`,
    ).get(attemptId)).toEqual({
      state: 'acked', message_id: null, terminal_message_id: 'message-target',
      message_seq: 1, delivery_attempt: 1,
      lease_expires_at: '2026-07-24T12:00:31.000Z',
    })
    await expect(reconcileAgentInboxLeaseAttempt(env, {
      agent: 'agent-1', attemptId,
    })).resolves.toMatchObject({ ok: true, state: 'acked', messages: [] })
  })

  it('atomically expires an unacked attempt before deleting its verification message', async () => {
    const attemptId = '22222222-2222-4222-8222-222222222222'
    expect(await leaseAgentInbox(env, {
      agent: 'agent-1', limit: 1, leaseSeconds: 1, attemptId,
    }, { now: () => '2026-07-24T12:00:01.000Z' })).toMatchObject({
      ok: true, state: 'leased', messages: [{ id: 'message-target' }],
    })

    await expect(deleteAgentConnectionMessage(env, {
      messageId: 'message-target', agentId: 'agent-1', requestId: 'agent-connection:receipt-1',
    })).resolves.toEqual({ ok: true })
    expect(harness.sqlite.prepare(
      `SELECT state, message_id, terminal_message_id, message_seq,
              delivery_attempt, lease_expires_at
         FROM agent_inbox_lease_attempts WHERE attempt_id = ?`,
    ).get(attemptId)).toEqual({
      state: 'expired', message_id: null, terminal_message_id: 'message-target',
      message_seq: 1, delivery_attempt: 1,
      lease_expires_at: '2026-07-24T12:00:02.000Z',
    })
    await expect(reconcileAgentInboxLeaseAttempt(env, {
      agent: 'agent-1', attemptId,
    })).resolves.toMatchObject({ ok: true, state: 'expired', messages: [] })
  })

  it('does not detach an attempt when the cleanup tuple is unauthorized', async () => {
    const attemptId = '33333333-3333-4333-8333-333333333333'
    await leaseAgentInbox(env, {
      agent: 'agent-1', limit: 1, leaseSeconds: 30, attemptId,
    }, { now: () => '2026-07-24T12:00:01.000Z' })

    await expect(deleteAgentConnectionMessage(env, {
      messageId: 'message-target', agentId: 'agent-1', requestId: 'agent-connection:wrong',
    })).resolves.toEqual({ ok: false, reason: 'message_not_found' })
    expect(harness.sqlite.prepare(
      'SELECT state, message_id FROM agent_inbox_lease_attempts WHERE attempt_id = ?',
    ).get(attemptId)).toEqual({ state: 'leased', message_id: 'message-target' })
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM agent_messages WHERE id='message-target'",
    ).get()).toEqual({ n: 1 })
  })
})
