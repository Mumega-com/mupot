import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sendAgentMessage,
  readAgentInbox,
  leaseAgentInbox,
  listDeadLetteredMessages,
} from '../src/agents/messages'
import { sha256Hex } from '../src/lib/canonical-json'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const FROM_AGENT = 'agent-sender'
const TO_AGENT = 'agent-recipient'
const ORIGINAL_BODY = 'FIRST LINE: preserve these exact message bytes.'
const CUT_BODY = 'FIRST LINE: preserve'
const SAME_LENGTH_TAMPER = `X${ORIGINAL_BODY.slice(1)}`

interface IntegrityMessage {
  body: string
  body_length: number | null
  checksum_sha256: string | null
  is_intact: boolean | null
}

describe('persisted message-integrity baseline', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { emit: async () => {} },
    } as unknown as Env
  })

  afterEach(() => harness.close())

  async function sendOriginal(): Promise<void> {
    const sent = await sendAgentMessage(
      env,
      {
        fromAgent: FROM_AGENT,
        fromMember: 'member-sender',
        toAgent: TO_AGENT,
        body: ORIGINAL_BODY,
      },
      { system: true, reason: 'integrity regression fixture uses fixed principals' },
      { idGen: () => 'message-integrity-fixture' },
    )
    expect(sent.ok).toBe(true)
  }

  it('stores the immutable send-time length and digest on the D1 row', async () => {
    await sendOriginal()

    const row = await env.DB.prepare(
      'SELECT * FROM agent_messages WHERE id = ?1',
    ).bind('message-integrity-fixture').first<Record<string, unknown>>()

    expect(row).toMatchObject({
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
    })

    const inbox = await readAgentInbox(env, { agent: TO_AGENT, peek: true })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.messages[0]).toMatchObject({
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
      is_intact: true,
    })

    await expect(env.DB.prepare(
      'UPDATE agent_messages SET checksum_sha256 = ?1 WHERE id = ?2',
    ).bind('0'.repeat(64), 'message-integrity-fixture').run()).rejects.toThrow(
      /integrity baseline is immutable/,
    )
    await expect(env.DB.prepare(
      'UPDATE agent_messages SET body_length = ?1 WHERE id = ?2',
    ).bind(0, 'message-integrity-fixture').run()).rejects.toThrow(
      /integrity baseline is immutable/,
    )
  })

  it('reports a cut stored body as not intact through inbox and inbox_lease', async () => {
    await sendOriginal()
    await env.DB.prepare(
      'UPDATE agent_messages SET body = ?1 WHERE id = ?2',
    ).bind(CUT_BODY, 'message-integrity-fixture').run()

    const inbox = await readAgentInbox(env, { agent: TO_AGENT, peek: true })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    const inboxMessage = inbox.messages[0] as unknown as IntegrityMessage
    expect(inboxMessage).toMatchObject({
      body: CUT_BODY,
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
      is_intact: false,
    })

    const lease = await leaseAgentInbox(env, { agent: TO_AGENT, leaseSeconds: 60 })
    expect(lease.ok).toBe(true)
    if (!lease.ok) return
    const leasedMessage = lease.messages[0] as unknown as IntegrityMessage
    expect(leasedMessage).toMatchObject({
      body: CUT_BODY,
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
      is_intact: false,
    })
  })

  it('reports a cut dead-lettered body as not intact', async () => {
    await sendOriginal()
    await env.DB.prepare(
      `UPDATE agent_messages
          SET body = ?1,
              dead_lettered_at = ?2,
              dead_letter_reason = 'integrity-regression-fixture'
        WHERE id = ?3`,
    ).bind(CUT_BODY, '2026-08-28T00:00:00.000Z', 'message-integrity-fixture').run()

    const deadLetters = await listDeadLetteredMessages(env, { agent: TO_AGENT })
    expect(deadLetters.ok).toBe(true)
    if (!deadLetters.ok) return
    const message = deadLetters.messages[0] as unknown as IntegrityMessage
    expect(message).toMatchObject({
      body: CUT_BODY,
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
      is_intact: false,
    })
  })

  it('uses the digest to reject a same-length body substitution', async () => {
    await sendOriginal()
    expect(SAME_LENGTH_TAMPER).toHaveLength(ORIGINAL_BODY.length)
    await env.DB.prepare(
      'UPDATE agent_messages SET body = ?1 WHERE id = ?2',
    ).bind(SAME_LENGTH_TAMPER, 'message-integrity-fixture').run()

    const inbox = await readAgentInbox(env, { agent: TO_AGENT, peek: true })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.messages[0]).toMatchObject({
      body: SAME_LENGTH_TAMPER,
      body_length: ORIGINAL_BODY.length,
      checksum_sha256: await sha256Hex(ORIGINAL_BODY),
      is_intact: false,
    })
  })
})
