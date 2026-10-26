// Signed, body-free webhook doorbell. Failing cases are the gate's list:
// signature, replay, AAD, 5xx dead-letter + backoff, 3xx not followed, allowlist,
// payload shape, receipt authz, one ring per version, flag off.
// Issue #2186 follow-ups are in this file too.

import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendAgentMessage } from '../src/agents/messages'
import { ASSIGNMENT_WAKE_ACTOR, ASSIGNMENT_WAKE_SENDER } from '../src/agents/assignment-wake'
import {
  memoryDoorbellReplayStore,
  normalizeDoorbellHmacSecret,
  signDoorbellAttempt,
  SIGNED_DOORBELL_PAYLOAD_KEYS,
  signedDoorbellBody,
  verifySignedDoorbell,
} from '../src/agents/doorbell-signature'
import {
  RECEIPT_RETENTION_MS,
  scheduleTaskAssignedDoorbell,
  sendDoorbellTestPing,
  setAgentWebhookDoorbell,
  TEST_PING_LIMIT,
  WAKE_BURST_LIMIT,
} from '../src/agents/webhook-doorbell'
import { deliverSignedDoorbell, DOORBELL_CLAIM_LEASE_MS, enqueueSignedInboxDoorbell } from '../src/bus/doorbell-delivery'
import { deliverDispatchToInbox } from '../src/bus/fleet-bridge'
import { backoffDelaySec } from '../src/bus/events-delivery'
import { handleQueue } from '../src/bus/consumer'
import { createBus } from '../src/bus'
import { decryptConnectorSecret, encryptConnectorSecret } from '../src/connectors/crypto'
import { invokeTool } from '../src/mcp'
import type { AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-a'
const MEMBER_ID = 'member-1'
const OTHER_MEMBER_ID = 'member-2'
const DEPT_ID = 'dept-a'
const SQUAD_ID = 'squad-a'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'
const T0 = '2026-10-25T12:00:00.000Z'
const MASTER = 'a'.repeat(64)
const HOST = 'webhook.example'
const URL = `https://${HOST}/grokbot/wake`
const AUTHZ = { system: true, reason: 'test: signed doorbell' } as const

function whsec(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `whsec_${btoa(bin)}`
}

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const SIGNING_SECRET = whsec(KEY_BYTES)
const OTHER_SECRET = whsec(new Uint8Array(32).fill(9))

function auth(bound: string): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: bound,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
  }
}

function humanAdmin(): AuthContext {
  return {
    userId: OTHER_MEMBER_ID,
    memberId: OTHER_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [
      { member_id: OTHER_MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' },
    ],
  }
}

describe('signed doorbell verifier', () => {
  it('accepts the right key and rejects a wrong key, a stale timestamp, a replayed nonce, and another agent AAD', async () => {
    const body = signedDoorbellBody(
      { type: 'mupot.inbox.wake', agent_id: AGENT_A, seq: 4, message_id: 'm-1', kind: 'message' },
      'nonce-1',
    )
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([...SIGNED_DOORBELL_PAYLOAD_KEYS['mupot.inbox.wake']].sort())
    expect(body).not.toContain('from_agent')
    const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
    const signed = await signDoorbellAttempt(SIGNING_SECRET, 'msg_test', body, nowMs)
    const replay = memoryDoorbellReplayStore()
    const ok = await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: 'msg_test',
      timestampSec: signed.timestampSec,
      signature: signed.headers['webhook-signature'],
      body,
      nowSec: signed.timestampSec,
      replay,
    })
    expect(ok.ok).toBe(true)

    const wrong = await verifySignedDoorbell({
      secret: OTHER_SECRET,
      webhookId: 'msg_test',
      timestampSec: signed.timestampSec,
      signature: signed.headers['webhook-signature'],
      body,
      nowSec: signed.timestampSec,
      replay: memoryDoorbellReplayStore(),
    })
    expect(wrong).toEqual({ ok: false, reason: 'bad_signature' })

    const stale = await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: 'msg_test',
      timestampSec: signed.timestampSec - 301,
      signature: signed.headers['webhook-signature'],
      body,
      nowSec: signed.timestampSec,
      replay: memoryDoorbellReplayStore(),
    })
    expect(stale).toEqual({ ok: false, reason: 'stale_timestamp' })

    const again = await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: 'msg_test',
      timestampSec: signed.timestampSec,
      signature: signed.headers['webhook-signature'],
      body,
      nowSec: signed.timestampSec,
      replay,
    })
    expect(again).toEqual({ ok: false, reason: 'replayed' })

    const ct = await encryptConnectorSecret(MASTER, AGENT_A, 'agent_doorbell_hmac', SIGNING_SECRET, AGENT_A)
    await expect(decryptConnectorSecret(MASTER, AGENT_A, 'agent_doorbell_hmac', ct, AGENT_B)).rejects.toThrow()
    await expect(decryptConnectorSecret(MASTER, AGENT_A, 'agent_doorbell_hmac', ct, AGENT_A)).resolves.toBe(SIGNING_SECRET)
  })

  it('dedupes a retry on webhook-id when the nonce changes', async () => {
    const fields = { type: 'mupot.inbox.wake' as const, agent_id: AGENT_A, seq: 4, message_id: 'm-1', kind: 'message' }
    const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
    const replay = memoryDoorbellReplayStore()
    const firstBody = signedDoorbellBody(fields, 'nonce-attempt-1')
    const first = await signDoorbellAttempt(SIGNING_SECRET, 'msg_same', firstBody, nowMs)
    expect(await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: 'msg_same',
      timestampSec: first.timestampSec,
      signature: first.headers['webhook-signature'],
      body: firstBody,
      nowSec: first.timestampSec,
      replay,
    })).toMatchObject({ ok: true })
    const retryBody = signedDoorbellBody(fields, 'nonce-attempt-2')
    const retry = await signDoorbellAttempt(SIGNING_SECRET, 'msg_same', retryBody, nowMs + 1000)
    expect(await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: 'msg_same',
      timestampSec: retry.timestampSec,
      signature: retry.headers['webhook-signature'],
      body: retryBody,
      nowSec: retry.timestampSec,
      replay,
    })).toEqual({ ok: false, reason: 'replayed' })
  })

  it('refuses an HMAC key shorter than 32 decoded bytes', () => {
    const short = whsec(Uint8Array.from({ length: 31 }, () => 7))
    const exact = whsec(Uint8Array.from({ length: 32 }, () => 7))
    expect(normalizeDoorbellHmacSecret(short).ok).toBe(false)
    expect(normalizeDoorbellHmacSecret(exact)).toEqual({ ok: true, secret: exact })
    expect(normalizeDoorbellHmacSecret('whsec_' + Buffer.alloc(24, 3).toString('base64')).ok).toBe(false)
  })

  it('documents webhook-id dedupe, the decoded whsec_ key, and a silent flag rollback', () => {
    const doc = readFileSync('docs/plugins/grokbot-webhook-spine.md', 'utf8')
    expect(doc).toContain('Dedupe on `webhook-id` alone')
    expect(doc).toContain('base64-decoded bytes after the `whsec_` prefix')
    expect(doc).toContain('## Flag rollback')
    expect(doc).toMatch(/fails closed/i)
  })
})

describe('signed webhook doorbell delivery', () => {
  let harness: SqliteD1Harness
  let env: Env
  let fetched: Array<{ url: string; init: RequestInit }>
  let sent: Array<{ body: BusEvent; delaySeconds?: number }>
  const realFetch = globalThis.fetch

  function busSend(body: BusEvent, opts?: { delaySeconds?: number }) {
    sent.push({ body, delaySeconds: opts?.delaySeconds })
    return Promise.resolve()
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'dept-a', 'Department A');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-a', 'Squad Alpha');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
        ('${AGENT_A}', '${SQUAD_ID}', 'grokbot-ceo', 'CEO', 'operator', 'test', 'active'),
        ('${AGENT_B}', '${SQUAD_ID}', 'grokbot-staff', 'Staff', 'operator', 'test', 'active');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES
        ('${MEMBER_ID}', 'owner@pot.test', 'Owner', 'active', '${TENANT}'),
        ('${OTHER_MEMBER_ID}', 'other@pot.test', 'Other', 'active', '${TENANT}');
    `)
    fetched = []
    sent = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: busSend },
      CONNECTOR_MASTER_KEY: MASTER,
      WEBHOOK_DOORBELL: '1',
      WEBHOOK_DOORBELL_SIGNED: '1',
      EVENTS_CALLBACK_HOSTS: HOST,
    } as unknown as Env
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    harness.close()
  })

  async function register(agentId = AGENT_A) {
    const set = await setAgentWebhookDoorbell(env, {
      agentId,
      webhookUrl: URL,
      bearer: SIGNING_SECRET,
      createdByMemberId: MEMBER_ID,
      now: T0,
    })
    expect(set.ok).toBe(true)
    if (!set.ok) throw new Error('register failed')
    expect(set.doorbell.delivery_version).toBe('signed')
    expect(set.doorbell.auth_last4).toBe(SIGNING_SECRET.slice(-4))
    expect(JSON.stringify(set.doorbell)).not.toContain(SIGNING_SECRET.slice(0, 12))
    return set
  }

  async function sendOne(requestId: string, body = 'hello from staff — not on the wire') {
    return sendAgentMessage(env, {
      fromAgent: AGENT_B,
      fromMember: MEMBER_ID,
      toAgent: AGENT_A,
      body,
      kind: 'request',
      requestId,
    }, AUTHZ, { now: () => T0, idGen: () => `msg-${requestId}` })
  }

  function doorbellJobs(): BusEvent[] {
    return sent.filter((s) => s.body.type === 'mcp.doorbell.delivery').map((s) => s.body)
  }

  it('enforces the allowlist at registration and at send time', async () => {
    const blocked = await setAgentWebhookDoorbell(
      { ...env, EVENTS_CALLBACK_HOSTS: undefined } as Env,
      { agentId: AGENT_A, webhookUrl: URL, bearer: SIGNING_SECRET, createdByMemberId: MEMBER_ID },
    )
    expect(blocked.ok).toBe(false)
    if (blocked.ok) throw new Error('expected refusal')
    expect(blocked.error).toBe('invalid_webhook_url')
    expect(blocked.detail).toBe('callback_host_not_allowed')

    const linkLocal = await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: 'https://169.254.169.254/latest', bearer: SIGNING_SECRET, createdByMemberId: MEMBER_ID,
    })
    expect(linkLocal.ok).toBe(false)
    const privateNet = await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: 'https://10.1.2.3/hook', bearer: SIGNING_SECRET, createdByMemberId: MEMBER_ID,
    })
    expect(privateNet.ok).toBe(false)

    await register()
    const sentOk = await sendOne('rid-allow')
    expect(sentOk.ok).toBe(true)
    if (!sentOk.ok) throw new Error('send failed')
    const job = doorbellJobs()[0]
    expect(job).toBeTruthy()
    env.EVENTS_CALLBACK_HOSTS = 'elsewhere.example'
    fetched.length = 0
    const denied = await deliverSignedDoorbell(env, job.payload)
    expect(denied.outcome).toBe('failed')
    expect(denied.reason).toBe('callback_host_not_allowed')
    expect(fetched).toHaveLength(0)
    const receipt = harness.sqlite.prepare(
      `SELECT outcome, error_class, http_status FROM agent_webhook_doorbell_receipts`,
    ).get() as { outcome: string; error_class: string; http_status: number | null }
    expect(receipt).toMatchObject({ outcome: 'failed', error_class: 'callback_host_not_allowed', http_status: null })
  })

  it('POSTs a body with no from_agent or message body, and the receipt reader refuses a non-self non-admin', async () => {
    await register()
    const secretText = 'SECRET-BODY-should-not-leak'
    const sentMsg = await sendOne('rid-shape', secretText)
    expect(sentMsg.ok).toBe(true)
    if (!sentMsg.ok) throw new Error('send failed')
    const job = doorbellJobs()[0]
    const result = await deliverSignedDoorbell(env, job.payload)
    expect(result.outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)
    expect(fetched[0].url).toBe(URL)
    const headers = fetched[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['webhook-id']).toMatch(/^msg_/)
    expect(headers['webhook-timestamp']).toMatch(/^\d+$/)
    expect(headers['webhook-signature']).toMatch(/^v1,/)
    expect(fetched[0].init.redirect).toBe('manual')
    const payload = JSON.parse(String(fetched[0].init.body)) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([...SIGNED_DOORBELL_PAYLOAD_KEYS['mupot.inbox.wake']].sort())
    expect(payload).not.toHaveProperty('from_agent')
    expect(payload).not.toHaveProperty('body')
    expect(JSON.stringify(payload)).not.toContain(secretText)
    expect(payload).toMatchObject({
      type: 'mupot.inbox.wake',
      agent_id: AGENT_A,
      message_id: sentMsg.id,
      kind: 'request',
    })
    const verified = await verifySignedDoorbell({
      secret: SIGNING_SECRET,
      webhookId: headers['webhook-id'],
      timestampSec: Number(headers['webhook-timestamp']),
      signature: headers['webhook-signature'],
      body: String(fetched[0].init.body),
      nowSec: Number(headers['webhook-timestamp']),
      replay: memoryDoorbellReplayStore(),
    })
    expect(verified.ok).toBe(true)

    const stranger = await invokeTool(auth(AGENT_B), env, 'list_agent_webhook_doorbell_receipts', { agent: AGENT_A }, 'https://pot.example')
    expect(stranger.ok).toBe(false)
    if (stranger.ok) throw new Error('expected refusal')
    expect(stranger.status).toBe(403)

    const self = await invokeTool(auth(AGENT_A), env, 'list_agent_webhook_doorbell_receipts', {}, 'https://pot.example')
    expect(self.ok).toBe(true)
    if (!self.ok) throw new Error('self read failed')
    const packed = JSON.stringify(self.result)
    expect(packed).not.toContain(URL)
    expect(packed).not.toContain(SIGNING_SECRET)
    expect(packed).not.toContain(secretText)
    expect(packed).not.toContain('auth_ciphertext')
    expect(self.result).toMatchObject({
      agent_id: AGENT_A,
      receipts: [expect.objectContaining({ outcome: 'posted', event_type: 'mupot.inbox.wake', agent_id: AGENT_A, attempt: 1 })],
    })

    const admin = await invokeTool(humanAdmin(), env, 'list_agent_webhook_doorbell_receipts', { agent: AGENT_A }, 'https://pot.example')
    expect(admin.ok).toBe(true)
  })

  it('retries 5xx five times then dead_letters, with backoff taken from receipts', async () => {
    await register()
    const sentMsg = await sendOne('rid-5xx')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    expect(job.payload).not.toHaveProperty('attempt')
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response('down', { status: 500 })
    }) as typeof fetch
    fetched.length = 0
    const before = sent.length
    let now = Date.parse(T0)
    for (let i = 0; i < 5; i++) {
      await deliverSignedDoorbell(env, job.payload, { nowMs: now })
      now += backoffDelaySec(i + 1) * 1000
    }
    expect(fetched).toHaveLength(5)
    const receipts = harness.sqlite.prepare(
      `SELECT attempt, outcome, http_status, error_class FROM agent_webhook_doorbell_receipts ORDER BY attempt`,
    ).all() as Array<{ attempt: number; outcome: string; http_status: number; error_class: string }>
    expect(receipts).toHaveLength(5)
    expect(receipts.map((r) => r.outcome)).toEqual(['retry', 'retry', 'retry', 'retry', 'dead_letter'])
    expect(receipts.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5])
    expect(receipts.every((r) => r.http_status === 500 && r.error_class === 'http_500')).toBe(true)
    const delays = sent.slice(before).map((s) => s.delaySeconds)
    expect(delays).toEqual([backoffDelaySec(1), backoffDelaySec(2), backoffDelaySec(3), backoffDelaySec(4)])
    await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) + 10_000 })
    expect(fetched).toHaveLength(5)
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM agent_webhook_doorbell_receipts`).get()).toEqual({ n: 5 })
  })

  it('does not follow a 3xx', async () => {
    await register()
    const sentMsg = await sendOne('rid-3xx')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } })
    }) as typeof fetch
    fetched.length = 0
    const before = sent.length
    const result = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    expect(result.outcome).toBe('retry')
    expect(fetched).toHaveLength(1)
    expect(fetched[0].url).not.toContain('evil.example')
    expect(fetched[0].init.redirect).toBe('manual')
    expect(sent[before].delaySeconds).toBe(backoffDelaySec(1))
    const row = harness.sqlite.prepare(
      `SELECT outcome, http_status, error_class FROM agent_webhook_doorbell_receipts`,
    ).get() as { outcome: string; http_status: number; error_class: string }
    expect(row).toMatchObject({ outcome: 'retry', http_status: 302, error_class: 'redirect' })
  })

  it('rings a signed row exactly once and a legacy row exactly once', async () => {
    await register()
    const signedSend = await sendOne('rid-signed-once')
    expect(signedSend.ok).toBe(true)
    if (!signedSend.ok) throw new Error('send failed')
    expect(fetched).toHaveLength(0)
    const created = sent.find((s) => s.body.type === 'message.created')
    expect(created).toBeTruthy()
    await handleQueue({
      messages: [{ id: 'q1', body: created!.body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as never, env)
    const jobs = doorbellJobs()
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    for (const job of jobs) await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    expect(fetched).toHaveLength(1)
    expect(JSON.parse(String(fetched[0].init.body)).message_id).toBe(signedSend.id)

    fetched.length = 0
    sent.length = 0
    const legacyEnv = { ...env, WEBHOOK_DOORBELL_SIGNED: undefined, EVENTS_CALLBACK_HOSTS: undefined } as Env
    const legacyFetches: Array<{ url: string; init: RequestInit }> = []
    await setAgentWebhookDoorbell(legacyEnv, {
      agentId: AGENT_A,
      webhookUrl: URL,
      bearer: 'legacy-bearer-key-XYZ',
      createdByMemberId: MEMBER_ID,
    })
    const version = harness.sqlite.prepare(
      `SELECT delivery_version FROM agent_webhook_doorbells WHERE agent_id = ?`,
    ).get(AGENT_A) as { delivery_version: string }
    expect(version.delivery_version).toBe('legacy')
    const pending: Promise<unknown>[] = []
    const legacySend = await sendAgentMessage(legacyEnv, {
      fromAgent: AGENT_B,
      fromMember: MEMBER_ID,
      toAgent: AGENT_A,
      body: 'legacy body stays in the inbox',
      kind: 'message',
      requestId: 'rid-legacy-once',
    }, AUTHZ, {
      now: () => T0,
      fetch: (async (url: unknown, init?: RequestInit) => {
        legacyFetches.push({ url: String(url), init: init ?? {} })
        return new Response(null, { status: 204 })
      }) as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    expect(legacySend.ok).toBe(true)
    await Promise.all(pending)
    const legacyCreated = sent.find((s) => s.body.type === 'message.created')
    await handleQueue({
      messages: [{ id: 'q2', body: legacyCreated!.body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as never, env)
    expect(legacyFetches).toHaveLength(1)
    expect((legacyFetches[0].init.headers as Record<string, string>).Authorization).toBe('Bearer legacy-bearer-key-XYZ')
    expect(JSON.parse(String(legacyFetches[0].init.body))).not.toHaveProperty('nonce')
    expect(fetched).toHaveLength(0)
    expect(sent.filter((s) => s.body.type === 'mcp.doorbell.delivery')).toHaveLength(0)
  })

  it('flag off is the legacy bearer path and the signed worker does nothing', async () => {
    const off = { ...env, WEBHOOK_DOORBELL_SIGNED: undefined } as Env
    const set = await setAgentWebhookDoorbell(off, {
      agentId: AGENT_A,
      webhookUrl: URL,
      bearer: 'legacy-bearer-key-XYZ',
      createdByMemberId: MEMBER_ID,
    })
    expect(set.ok).toBe(true)
    if (!set.ok) throw new Error('set failed')
    expect(set.doorbell.delivery_version).toBe('legacy')
    const fetches: RequestInit[] = []
    const pending: Promise<unknown>[] = []
    const res = await sendAgentMessage(off, {
      fromAgent: AGENT_B,
      fromMember: MEMBER_ID,
      toAgent: AGENT_A,
      body: 'flag off body',
      kind: 'message',
      requestId: 'rid-flag-off',
    }, AUTHZ, {
      now: () => T0,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        fetches.push(init ?? {})
        return new Response('ok', { status: 202 })
      }) as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    expect(res.ok).toBe(true)
    await Promise.all(pending)
    expect(fetches).toHaveLength(1)
    const headers = fetches[0].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer legacy-bearer-key-XYZ')
    expect(headers['webhook-signature']).toBeUndefined()
    expect(JSON.parse(String(fetches[0].body))).not.toHaveProperty('nonce')
    expect(sent.filter((s) => s.body.type === 'mcp.doorbell.delivery')).toHaveLength(0)
    fetched.length = 0
    const skipped = await deliverSignedDoorbell(off, { wake_type: 'mupot.inbox.wake', agent_id: AGENT_A, ref_id: 'm' })
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'disabled' })
    expect(await enqueueSignedInboxDoorbell(off, { type: 'message.created', tenant: TENANT, payload: {}, ts: T0 })).toBe(0)
    expect(fetched).toHaveLength(0)
    await expect(createBus(off).emit({
      type: 'mcp.doorbell.delivery', tenant: TENANT, payload: {}, ts: T0,
    })).rejects.toThrow(/internal-only/)
  })

  it('rings each test ping until the per-agent window cap', async () => {
    await register()
    fetched.length = 0
    const outcomes: string[] = []
    for (let i = 0; i < TEST_PING_LIMIT; i++) {
      outcomes.push((await sendDoorbellTestPing(env, AGENT_A)).outcome)
    }
    expect(outcomes).toEqual(Array.from({ length: TEST_PING_LIMIT }, () => 'posted'))
    expect(fetched).toHaveLength(TEST_PING_LIMIT)
    const blocked = await sendDoorbellTestPing(env, AGENT_A)
    expect(blocked).toMatchObject({ outcome: 'rate_limited', reason: 'test_ping_rate_limited' })
    expect(fetched).toHaveLength(TEST_PING_LIMIT)
  })

  it('a task dispatch rings the assignee once', async () => {
    await register()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t-dispatch', '${SQUAD_ID}', 'Dispatch once', 'body stays off the wire', 'done', 'open', '${AGENT_A}', '${T0}', '${T0}');
    `)
    const pending: Promise<unknown>[] = []
    const out = await invokeTool(humanAdmin(), env, 'task_dispatch', { task_id: 't-dispatch' }, {
      origin: 'https://pot.example',
      transport: 'mcp',
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    await Promise.all(pending)
    const receipt = harness.sqlite.prepare(
      `SELECT id FROM task_dispatch_receipts WHERE task_id = 't-dispatch'`,
    ).get() as { id: string }
    const bridge = await deliverDispatchToInbox(env, {
      agentId: AGENT_A,
      squadId: SQUAD_ID,
      taskId: 't-dispatch',
      receiptId: receipt.id,
      dispatchedByMemberId: MEMBER_ID,
      projectId: null,
    })
    expect(bridge.delivered).toBe(true)
    const jobs = doorbellJobs()
    expect(jobs).toHaveLength(1)
    fetched.length = 0
    for (const job of jobs) {
      await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    }
    expect(fetched).toHaveLength(1)
    expect(JSON.parse(String(fetched[0].init.body)).type).toBe('mupot.task.assigned')
  })

  it('does not permanently suppress a wake when a release or reassign cannot be confirmed yet', async () => {
    await register()
    const taskId = 't-release'
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${taskId}', '${SQUAD_ID}', 'Release', 'b', 'done', 'open', '${AGENT_B}', '${T0}', '${T0}');
    `)
    // The reassign to A has been asked for, but the task row still names B.
    await scheduleTaskAssignedDoorbell(env, AGENT_A, taskId, { assignment: 'epoch-reassign' })
    const reassign = doorbellJobs().at(-1)
    expect(reassign).toBeTruthy()
    fetched.length = 0
    const hidden = await deliverSignedDoorbell(env, reassign!.payload, { nowMs: Date.parse(T0) })
    expect(hidden.outcome).toBe('retry')
    expect(fetched).toHaveLength(0)
    harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = ? WHERE id = ?`).run(AGENT_A, taskId)
    const shown = await deliverSignedDoorbell(env, reassign!.payload, { nowMs: Date.parse(T0) + backoffDelaySec(1) * 1000 })
    expect(shown.outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)

    // A release token is not the task's updated_at and has no wake-ledger row. Each one is its own event.
    fetched.length = 0
    sent.length = 0
    await scheduleTaskAssignedDoorbell(env, AGENT_A, taskId, { assignment: 'release:one' })
    await scheduleTaskAssignedDoorbell(env, AGENT_A, taskId, { assignment: 'release:two' })
    const releases = doorbellJobs()
    expect(releases).toHaveLength(2)
    for (const job of releases) {
      expect((await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) + 5000 })).outcome).toBe('delivered')
    }
    expect(fetched).toHaveLength(2)
  })

  it('enqueues one delivery job per inbox message so a 5xx follows one backoff', async () => {
    await register()
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response('down', { status: 500 })
    }) as typeof fetch
    const sentMsg = await sendOne('rid-one-job')
    expect(sentMsg.ok).toBe(true)
    const created = sent.find((s) => s.body.type === 'message.created')
    expect(created).toBeTruthy()
    await handleQueue({
      messages: [{ id: 'q-one-job', body: created!.body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as never, env)
    const jobs = doorbellJobs()
    expect(jobs).toHaveLength(1)
    fetched.length = 0
    const before = sent.length
    for (const job of jobs) {
      await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    }
    expect(fetched).toHaveLength(1)
    expect(sent.slice(before).map((s) => s.delaySeconds)).toEqual([backoffDelaySec(1)])
  })

  it('an assignment letter does not ring twice when another assignment for the same agent is in flight', async () => {
    await register()
    harness.sqlite.prepare(
      `INSERT INTO task_assignment_wakes
         (id, tenant, task_id, agent_id, epoch, outcome, message_seq, created_at, updated_at)
       VALUES ('wake-other', ?, 'task-other', ?, 'epoch-other', 'pending', NULL, ?, ?)`,
    ).run(TENANT, AGENT_A, T0, T0)
    const sentMsg = await sendAgentMessage(env, {
      fromAgent: ASSIGNMENT_WAKE_SENDER,
      fromMember: ASSIGNMENT_WAKE_ACTOR,
      toAgent: AGENT_A,
      body: 'assignment letter body stays off the wire',
      kind: 'message',
      requestId: 'assign:this',
    }, { system: true, reason: 'test: assignment letter' }, {
      now: () => T0,
      idGen: () => 'msg-assign-this',
      doorbellCorrelation: 'task-this#epoch-this',
    })
    expect(sentMsg.ok).toBe(true)
    if (!sentMsg.ok) throw new Error('assignment letter failed')
    const created = sent.find((s) => s.body.type === 'message.created')
    expect(created).toBeTruthy()
    const owned = doorbellJobs()
    expect(owned).toHaveLength(1)
    expect(owned[0].payload).toMatchObject({ correlation: 'task-this#epoch-this' })

    // The letter's seq is not on a wake row yet. The in-flight row must not be claimed.
    await handleQueue({
      messages: [{ id: 'q-assign', body: created!.body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as never, env)
    expect(doorbellJobs()).toHaveLength(1)
    expect(doorbellJobs().some((job) => (job.payload as { correlation?: string }).correlation === 'task-other#epoch-other')).toBe(false)

    harness.sqlite.prepare(
      `INSERT INTO task_assignment_wakes
         (id, tenant, task_id, agent_id, epoch, outcome, message_seq, created_at, updated_at)
       VALUES ('wake-this', ?, 'task-this', ?, 'epoch-this', 'sent', ?, ?, ?)`,
    ).run(TENANT, AGENT_A, sentMsg.seq, T0, T0)
    expect(await enqueueSignedInboxDoorbell(env, created!.body)).toBe(0)
    expect(doorbellJobs()).toHaveLength(1)

    fetched.length = 0
    for (const job of doorbellJobs()) {
      expect((await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })).outcome).toBe('delivered')
    }
    expect(fetched).toHaveLength(1)
    const payload = JSON.parse(String(fetched[0].init.body)) as Record<string, unknown>
    expect(payload).not.toHaveProperty('from_agent')
    expect(payload).not.toHaveProperty('body')
    expect(JSON.stringify(payload)).not.toContain('assignment letter body')
    expect(payload).toMatchObject({ type: 'mupot.inbox.wake', message_id: sentMsg.id })
    const ids = fetched.map((call) => (call.init.headers as Record<string, string>)['webhook-id'])
    expect(new Set(ids).size).toBe(1)
  })

  it('12 parallel test pings send at most the cap', async () => {
    await register()
    fetched.length = 0
    const results = await Promise.all(Array.from({ length: 12 }, () => sendDoorbellTestPing(env, AGENT_A)))
    expect(fetched.length).toBeLessThanOrEqual(TEST_PING_LIMIT)
    expect(results.filter((r) => r.outcome === 'rate_limited').length).toBeGreaterThanOrEqual(12 - TEST_PING_LIMIT)
    expect(fetched.every((call) => call.init.redirect === 'manual')).toBe(true)
  })

  it('reclaims a stale delivery claim and refuses a claim still inside the lease', async () => {
    await register()
    const sentMsg = await sendOne('rid-stale-claim')
    expect(sentMsg.ok).toBe(true)
    if (!sentMsg.ok) throw new Error('send failed')
    const job = doorbellJobs()[0]
    const staleAt = new Date(Date.parse(T0) - DOORBELL_CLAIM_LEASE_MS - 1000).toISOString()
    harness.sqlite.prepare(
      `INSERT INTO agent_webhook_doorbell_receipts
         (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
       VALUES ('claim-stale', ?, ?, 'mupot.inbox.wake', ?, 'claimed', NULL, NULL, ?, 1, NULL, NULL)`,
    ).run(TENANT, AGENT_A, sentMsg.id, staleAt)
    fetched.length = 0
    const reclaimed = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    expect(reclaimed.outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)
    const row = harness.sqlite.prepare(
      `SELECT id, outcome, attempt FROM agent_webhook_doorbell_receipts WHERE id = 'claim-stale'`,
    ).get() as { id: string; outcome: string; attempt: number }
    expect(row).toMatchObject({ outcome: 'posted', attempt: 1 })

    const freshMsg = await sendOne('rid-fresh-claim')
    expect(freshMsg.ok).toBe(true)
    if (!freshMsg.ok) throw new Error('send failed')
    const freshJob = doorbellJobs().at(-1)
    const freshAt = new Date(Date.parse(T0)).toISOString()
    harness.sqlite.prepare(
      `INSERT INTO agent_webhook_doorbell_receipts
         (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
       VALUES ('claim-fresh', ?, ?, 'mupot.inbox.wake', ?, 'claimed', NULL, NULL, ?, 1, NULL, NULL)`,
    ).run(TENANT, AGENT_A, freshMsg.id, freshAt)
    fetched.length = 0
    const blocked = await deliverSignedDoorbell(env, freshJob!.payload, { nowMs: Date.parse(T0) + 1000 })
    expect(blocked).toMatchObject({ outcome: 'skipped', reason: 'duplicate' })
    expect(fetched).toHaveLength(0)
  })

  it('a queue redelivery after a recorded retry waits out the backoff', async () => {
    await register()
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response('down', { status: 500 })
    }) as typeof fetch
    const sentMsg = await sendOne('rid-backoff')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    fetched.length = 0
    const t0 = Date.parse(T0)
    const first = await deliverSignedDoorbell(env, job.payload, { nowMs: t0 })
    expect(first.outcome).toBe('retry')
    expect(fetched).toHaveLength(1)
    const early = await deliverSignedDoorbell(env, job.payload, { nowMs: t0 + 1000 })
    expect(early).toMatchObject({ outcome: 'skipped', reason: 'backoff' })
    expect(fetched).toHaveLength(1)
    const due = t0 + backoffDelaySec(1) * 1000
    const second = await deliverSignedDoorbell(env, job.payload, { nowMs: due })
    expect(second.outcome).toBe('retry')
    expect(fetched).toHaveLength(2)
    const attempts = harness.sqlite.prepare(
      `SELECT attempt, outcome FROM agent_webhook_doorbell_receipts WHERE ref_id = ? AND attempt IS NOT NULL ORDER BY attempt`,
    ).all(sentMsg.ok ? sentMsg.id : '') as Array<{ attempt: number; outcome: string }>
    expect(attempts.map((r) => r.attempt)).toEqual([1, 2])
  })

  it('still rings once when the queue send fails and the other producer already lost the claim', async () => {
    await register()
    env.BUS = {
      send: async (body: BusEvent, opts?: { delaySeconds?: number }) => {
        if (body.type === 'mcp.doorbell.delivery') throw new Error('queue down')
        sent.push({ body, delaySeconds: opts?.delaySeconds })
      },
    } as Env['BUS']
    const sentMsg = await sendOne('rid-lost-ring', 'lost-ring body stays in the inbox')
    expect(sentMsg.ok).toBe(true)
    if (!sentMsg.ok) throw new Error('send failed')
    expect(fetched).toHaveLength(1)
    const payload = JSON.parse(String(fetched[0].init.body)) as Record<string, unknown>
    expect(payload).not.toHaveProperty('from_agent')
    expect(payload).not.toHaveProperty('body')
    expect(JSON.stringify(payload)).not.toContain('lost-ring body')
    expect(fetched[0].init.redirect).toBe('manual')
    const created = sent.find((s) => s.body.type === 'message.created')
    expect(created).toBeTruthy()
    await expect(enqueueSignedInboxDoorbell(env, created!.body)).resolves.toBe(0)
    expect(fetched).toHaveLength(1)
    const posted = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts WHERE outcome = 'posted'`,
    ).get() as { n: number }
    expect(posted.n).toBe(1)
  })

  it('does not let unconfirmed assignment retries fill the burst cap', async () => {
    await register()
    const recent = new Date(Date.parse(T0) - 1000).toISOString()
    for (let i = 0; i < WAKE_BURST_LIMIT; i++) {
      harness.sqlite.prepare(
        `INSERT INTO agent_webhook_doorbell_receipts
           (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
         VALUES (?, ?, ?, 'mupot.task.assigned', ?, 'retry', NULL, NULL, ?, 1, 'task_not_assigned', NULL)`,
      ).run(`unconf-${i}`, TENANT, AGENT_A, `unconf-ref-${i}`, recent)
    }
    const sentMsg = await sendOne('rid-unconf-burst')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs().at(-1)
    fetched.length = 0
    const result = await deliverSignedDoorbell(env, job!.payload, { nowMs: Date.parse(T0) })
    expect(result.outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)
    const skipped = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts WHERE ref_id = ? AND outcome = 'skipped'`,
    ).get(sentMsg.ok ? sentMsg.id : '') as { n: number }
    expect(skipped.n).toBe(0)
  })

  it('prunes expired receipts and enqueue locks when a signed doorbell rings', async () => {
    await register()
    const old = new Date(Date.parse(T0) - RECEIPT_RETENTION_MS - 60_000).toISOString()
    const fresh = new Date(Date.parse(T0) - 1000).toISOString()
    const insert = harness.sqlite.prepare(
      `INSERT INTO agent_webhook_doorbell_receipts
         (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
       VALUES (?, ?, ?, 'mupot.inbox.wake', ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
    )
    insert.run('old-receipt', TENANT, AGENT_A, 'old-receipt', 'posted', null, old, 1)
    insert.run('old-lock', TENANT, AGENT_A, 'old-lock', 'claimed', 'enqueued', old, null)
    insert.run('fresh-receipt', TENANT, AGENT_A, 'fresh-receipt', 'posted', null, fresh, 1)
    const sentMsg = await sendOne('rid-prune')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs().at(-1)
    await deliverSignedDoorbell(env, job!.payload, { nowMs: Date.parse(T0) })
    const refs = harness.sqlite.prepare(
      `SELECT ref_id FROM agent_webhook_doorbell_receipts`,
    ).all() as Array<{ ref_id: string }>
    const ids = refs.map((r) => r.ref_id)
    expect(ids).not.toContain('old-receipt')
    expect(ids).not.toContain('old-lock')
    expect(ids).toContain('fresh-receipt')
  })

  it('a flag rollback does not POST the signed key', async () => {
    await register()
    const off = { ...env, WEBHOOK_DOORBELL_SIGNED: undefined } as Env
    const pending: Promise<unknown>[] = []
    fetched.length = 0
    const res = await sendAgentMessage(off, {
      fromAgent: AGENT_B,
      fromMember: MEMBER_ID,
      toAgent: AGENT_A,
      body: 'rollback body stays in the inbox',
      kind: 'message',
      requestId: 'rid-rollback',
    }, AUTHZ, {
      now: () => T0,
      fetch: globalThis.fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    expect(res.ok).toBe(true)
    await Promise.all(pending)
    expect(fetched).toHaveLength(0)
    const packed = JSON.stringify(fetched)
    expect(packed).not.toContain(SIGNING_SECRET)
    const posted = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts WHERE outcome = 'posted'`,
    ).get() as { n: number }
    expect(posted.n).toBe(0)
  })

  it('the consumer keeps a dispatch letter on the dispatch correlation (one ring)', async () => {
    await register()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t-n5', '${SQUAD_ID}', 'Dispatch correlation', 'body stays off the wire', 'done', 'open', '${AGENT_A}', '${T0}', '${T0}');
    `)
    const pending: Promise<unknown>[] = []
    const out = await invokeTool(humanAdmin(), env, 'task_dispatch', { task_id: 't-n5' }, {
      origin: 'https://pot.example',
      transport: 'mcp',
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    await Promise.all(pending)
    const receipt = harness.sqlite.prepare(
      `SELECT id FROM task_dispatch_receipts WHERE task_id = 't-n5'`,
    ).get() as { id: string }
    const bridge = await deliverDispatchToInbox(env, {
      agentId: AGENT_A,
      squadId: SQUAD_ID,
      taskId: 't-n5',
      receiptId: receipt.id,
      dispatchedByMemberId: MEMBER_ID,
      projectId: null,
    })
    expect(bridge.delivered).toBe(true)
    expect(doorbellJobs()).toHaveLength(1)
    expect(doorbellJobs()[0].payload).toMatchObject({ correlation: `dispatch:${receipt.id}` })
    const created = sent.find((s) => s.body.type === 'message.created')
    expect(created).toBeTruthy()
    await handleQueue({
      messages: [{ id: 'q-n5', body: created!.body, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
    } as never, env)
    expect(doorbellJobs()).toHaveLength(1)
    fetched.length = 0
    expect((await deliverSignedDoorbell(env, doorbellJobs()[0].payload, { nowMs: Date.parse(T0) })).outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)
    expect(JSON.parse(String(fetched[0].init.body))).not.toHaveProperty('from_agent')
  })

  it('a fresh in-flight claim blocks a second POST', async () => {
    await register()
    const sentMsg = await sendOne('rid-inflight')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      await gate
      return new Response(null, { status: 204 })
    }) as typeof fetch
    fetched.length = 0
    const first = deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    await vi.waitFor(() => { expect(fetched).toHaveLength(1) })
    const second = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) + 500 })
    expect(second).toMatchObject({ outcome: 'skipped', reason: 'duplicate' })
    expect(fetched).toHaveLength(1)
    release()
    expect((await first).outcome).toBe('delivered')
    expect(fetched).toHaveLength(1)
  })

  it('two racers claim one attempt', async () => {
    await register()
    const sentMsg = await sendOne('rid-claim-dedupe')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    fetched.length = 0
    const [a, b] = await Promise.all([
      deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) }),
      deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) }),
    ])
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['delivered', 'skipped'])
    expect(fetched).toHaveLength(1)
    expect(fetched[0].init.redirect).toBe('manual')
    const claims = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts WHERE ref_id = ? AND attempt IS NOT NULL`,
    ).get(sentMsg.ok ? sentMsg.id : '') as { n: number }
    expect(claims.n).toBe(1)
  })

  it('retries 408 and 429 and fails other 4xx without another POST', async () => {
    await register()
    for (const status of [408, 429] as const) {
      fetched.length = 0
      sent.length = 0
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        fetched.push({ url: String(url), init: init ?? {} })
        return new Response('later', { status })
      }) as typeof fetch
      const sentMsg = await sendOne(`rid-${status}`)
      expect(sentMsg.ok).toBe(true)
      const job = doorbellJobs()[0]
      const before = sent.length
      const result = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
      expect(result).toMatchObject({ outcome: 'retry', http_status: status })
      expect(fetched).toHaveLength(1)
      expect(sent[before].delaySeconds).toBe(backoffDelaySec(1))
      expect(fetched[0].init.redirect).toBe('manual')
    }
    fetched.length = 0
    sent.length = 0
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetched.push({ url: String(url), init: init ?? {} })
      return new Response('no', { status: 400 })
    }) as typeof fetch
    const sentMsg = await sendOne('rid-400')
    expect(sentMsg.ok).toBe(true)
    const job = doorbellJobs()[0]
    const before = sent.length
    const failed = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })
    expect(failed).toMatchObject({ outcome: 'failed', http_status: 400 })
    expect(sent.slice(before).filter((s) => s.body.type === 'mcp.doorbell.delivery')).toHaveLength(0)
    const again = await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) + 60_000 })
    expect(again).toMatchObject({ outcome: 'skipped', reason: 'terminal' })
    expect(fetched).toHaveLength(1)
  })

  it('rings distinct wakes up to the burst cap and does not retry the skipped one', async () => {
    await register()
    const jobs = []
    for (let i = 0; i < WAKE_BURST_LIMIT + 1; i++) {
      const sentMsg = await sendOne(`rid-cap-${i}`)
      expect(sentMsg.ok).toBe(true)
      jobs.push(doorbellJobs().at(-1)!)
    }
    fetched.length = 0
    const outcomes = []
    for (const job of jobs) {
      outcomes.push((await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) })).outcome)
    }
    expect(outcomes.slice(0, WAKE_BURST_LIMIT)).toEqual(Array.from({ length: WAKE_BURST_LIMIT }, () => 'delivered'))
    expect(outcomes[WAKE_BURST_LIMIT]).toBe('skipped')
    expect(fetched).toHaveLength(WAKE_BURST_LIMIT)
    const again = await deliverSignedDoorbell(env, jobs[WAKE_BURST_LIMIT].payload, { nowMs: Date.parse(T0) + 1000 })
    expect(again).toMatchObject({ outcome: 'skipped', reason: 'terminal' })
    expect(fetched).toHaveLength(WAKE_BURST_LIMIT)
  })
})
