// tests/sender-message-get.test.ts — mupot#1323 sender-scoped read-back.
// Service + MCP `message_get`. Real sqlite D1 (migrations applied). No sent-folder list.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sendAgentMessage, readAgentInbox, getSenderMessage } from '../src/agents/messages'
import { invokeTool, TOOLS } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const SYSTEM = { system: true as const, reason: 'sender-readback-test' }
const REQUEST_ID = 'req-sender-readback-1'
const BODY = 'checkpoint body for #1323'

function migratedDb() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  fixture.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept', 'squad-a', 'Squad A'),
      ('squad-b', 'dept', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-sender', 'squad-a', 'sender', 'Sender'),
      ('agent-recipient', 'squad-b', 'recipient', 'Recipient'),
      ('agent-other', 'squad-a', 'other', 'Other');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('mem-sender', 'agent-sender', 'squad-a', 'member'),
      ('mem-recipient', 'agent-recipient', 'squad-b', 'member'),
      ('mem-other', 'agent-other', 'squad-a', 'member');
    INSERT INTO members (id, email, display_name) VALUES
      ('member-sender', 'sender@example.test', 'Sender Member'),
      ('member-other', 'other@example.test', 'Other Member');
  `)
  return fixture
}

function envWith(DB: Env['DB'], tenant = 'tenant'): Env {
  return { DB, TENANT_SLUG: tenant } as Env
}

async function sendCheckpoint(env: Env, requestId = REQUEST_ID) {
  return sendAgentMessage(
    env,
    {
      fromAgent: 'agent-sender',
      fromMember: 'member-sender',
      toAgent: 'agent-recipient',
      body: BODY,
      kind: 'request',
      requestId,
    },
    SYSTEM,
  )
}

const toolMessageGet = TOOLS.find((t) => t.name === 'message_get')
const CTX = { origin: 'https://pot.test' }

function auth(boundAgentId: string | null, extras: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u1',
    email: 'a@b.com',
    role: extras.role ?? 'member',
    tenant: 't',
    memberId: extras.memberId ?? 'member-sender',
    capabilities: extras.capabilities ?? [],
    boundAgentId,
  } as AuthContext
}

describe('getSenderMessage — #1323 sender read-back', () => {
  it('send → sender read-back by id and request_id → recipient peek/consume → sender still sees body + read_at', async () => {
    const { db, close } = migratedDb()
    try {
      const env = envWith(db)
      const sent = await sendCheckpoint(env)
      expect(sent.ok).toBe(true)
      if (!sent.ok) return

      const byId = await getSenderMessage(env, { fromAgent: 'agent-sender', id: sent.id })
      const byRid = await getSenderMessage(env, { fromAgent: 'agent-sender', requestId: REQUEST_ID })
      expect(byId).toEqual(byRid)
      expect(byId.ok).toBe(true)
      if (!byId.ok) return
      expect(byId.message).toMatchObject({
        id: sent.id,
        to_agent: 'agent-recipient',
        kind: 'request',
        body: BODY,
        request_id: REQUEST_ID,
        read_at: null,
      })
      expect(Number.isSafeInteger(byId.message.seq) && byId.message.seq > 0).toBe(true)
      const storedSeq = byId.message.seq

      const peeked = await readAgentInbox(env, { agent: 'agent-recipient', peek: true })
      expect(peeked.ok).toBe(true)
      if (peeked.ok) {
        expect(peeked.messages.map((m) => m.id)).toContain(sent.id)
      }

      const afterPeek = await getSenderMessage(env, { fromAgent: 'agent-sender', id: sent.id })
      expect(afterPeek).toMatchObject({ ok: true, message: { id: sent.id, body: BODY, read_at: null } })

      const consumed = await readAgentInbox(env, { agent: 'agent-recipient' })
      expect(consumed.ok).toBe(true)
      if (consumed.ok) {
        expect(consumed.messages.map((m) => m.id)).toContain(sent.id)
      }

      const afterConsume = await getSenderMessage(env, { fromAgent: 'agent-sender', requestId: REQUEST_ID })
      expect(afterConsume.ok).toBe(true)
      if (!afterConsume.ok) return
      expect(afterConsume.message.body).toBe(BODY)
      expect(afterConsume.message.seq).toBe(storedSeq)
      expect(afterConsume.message.to_agent).toBe('agent-recipient')
      expect(afterConsume.message.kind).toBe('request')
      expect(typeof afterConsume.message.read_at).toBe('string')
      expect(afterConsume.message.read_at).not.toBeNull()

      const recipientPeek = await readAgentInbox(env, { agent: 'agent-recipient', peek: true })
      expect(recipientPeek.ok).toBe(true)
      if (recipientPeek.ok) {
        expect(recipientPeek.messages.map((m) => m.id)).not.toContain(sent.id)
      }
    } finally {
      close()
    }
  })

  it('duplicate request_id send is the same row on read-back', async () => {
    const { db, close } = migratedDb()
    try {
      const env = envWith(db)
      const first = await sendCheckpoint(env)
      const again = await sendCheckpoint(env)
      expect(first.ok && again.ok).toBe(true)
      if (!first.ok || !again.ok) return
      expect(again.duplicate).toBe(true)
      expect(again.id).toBe(first.id)

      const got = await getSenderMessage(env, { fromAgent: 'agent-sender', requestId: REQUEST_ID })
      expect(got.ok).toBe(true)
      if (!got.ok) return
      expect(got.message.id).toBe(first.id)
      expect(got.message.body).toBe(BODY)
      expect(Number.isSafeInteger(got.message.seq) && got.message.seq > 0).toBe(true)
    } finally {
      close()
    }
  })

  it('wrong-sender, missing-id, and cross-tenant collapse to the same message_not_found', async () => {
    const { db, close } = migratedDb()
    try {
      const env = envWith(db)
      const sent = await sendCheckpoint(env)
      expect(sent.ok).toBe(true)
      if (!sent.ok) return

      const missing = await getSenderMessage(env, { fromAgent: 'agent-sender', id: '00000000-0000-4000-8000-000000000000' })
      const wrongSender = await getSenderMessage(env, { fromAgent: 'agent-other', id: sent.id })
      const wrongRid = await getSenderMessage(env, { fromAgent: 'agent-other', requestId: REQUEST_ID })
      const otherTenant = await getSenderMessage(envWith(db, 'other-tenant'), {
        fromAgent: 'agent-sender',
        id: sent.id,
      })

      expect(missing).toEqual({ ok: false, reason: 'message_not_found' })
      expect(wrongSender).toEqual(missing)
      expect(wrongRid).toEqual(missing)
      expect(otherTenant).toEqual(missing)
    } finally {
      close()
    }
  })

  it('does not accept a to_agent lookup and refuses both-or-neither selectors', async () => {
    const { db, close } = migratedDb()
    try {
      const env = envWith(db)
      const sent = await sendCheckpoint(env)
      expect(sent.ok).toBe(true)
      if (!sent.ok) return

      const neither = await getSenderMessage(env, { fromAgent: 'agent-sender' })
      const both = await getSenderMessage(env, {
        fromAgent: 'agent-sender',
        id: sent.id,
        requestId: REQUEST_ID,
      })
      expect(neither).toEqual({ ok: false, reason: 'invalid_args' })
      expect(both).toEqual({ ok: false, reason: 'invalid_args' })
    } finally {
      close()
    }
  })
})

describe('message_get MCP tool — #1323', () => {
  it('is registered and refuses an unbound token', async () => {
    expect(toolMessageGet).toBeTruthy()
    if (!toolMessageGet) return
    const { db, close } = migratedDb()
    try {
      const r = await invokeTool(auth(null), envWith(db), 'message_get', { request_id: REQUEST_ID }, CTX)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.status).toBe(403)
      expect(r.error).toBe('not_agent_bound')
    } finally {
      close()
    }
  })

  it('returns the outbound row for the bound sender; admin-as-other-agent cannot read it', async () => {
    expect(toolMessageGet).toBeTruthy()
    if (!toolMessageGet) return
    const { db, close } = migratedDb()
    try {
      const env = envWith(db)
      const sent = await sendCheckpoint(env)
      expect(sent.ok).toBe(true)
      if (!sent.ok) return

      const mine = await invokeTool(auth('agent-sender'), env, 'message_get', { id: sent.id }, CTX)
      expect(mine.ok).toBe(true)
      if (!mine.ok) return
      expect(mine.result).toMatchObject({
        id: sent.id,
        to_agent: 'agent-recipient',
        kind: 'request',
        body: BODY,
        read_at: null,
      })
      expect(Number.isSafeInteger((mine.result as { seq: number }).seq)).toBe(true)

      const adminCaps: CapabilityGrant[] = [
        { member_id: 'member-other', scope_type: 'org', scope_id: null, capability: 'admin' },
      ]
      const adminOther = await invokeTool(
        auth('agent-other', { role: 'admin', memberId: 'member-other', capabilities: adminCaps }),
        env,
        'message_get',
        { id: sent.id },
        CTX,
      )
      expect(adminOther.ok).toBe(false)
      if (adminOther.ok) return
      expect(adminOther.error).toBe('message_not_found')

      const sneakFrom = await invokeTool(
        auth('agent-other', { role: 'admin', memberId: 'member-other', capabilities: adminCaps }),
        env,
        'message_get',
        { id: sent.id, from_agent: 'agent-sender' },
        CTX,
      )
      expect(sneakFrom.ok).toBe(false)
    } finally {
      close()
    }
  })
})
