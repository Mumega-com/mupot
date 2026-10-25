// Signed, body-free webhook doorbell. Failing cases are the gate's list:
// signature, replay, AAD, 5xx dead-letter + backoff, 3xx not followed, allowlist,
// payload shape, receipt authz, one ring per version, flag off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendAgentMessage } from '../src/agents/messages'
import {
  memoryDoorbellReplayStore,
  signDoorbellAttempt,
  SIGNED_DOORBELL_PAYLOAD_KEYS,
  signedDoorbellBody,
  verifySignedDoorbell,
} from '../src/agents/doorbell-signature'
import {
  scheduleTaskAssignedDoorbell,
  sendDoorbellTestPing,
  setAgentWebhookDoorbell,
  TEST_PING_LIMIT,
} from '../src/agents/webhook-doorbell'
import { deliverSignedDoorbell, enqueueSignedInboxDoorbell } from '../src/bus/doorbell-delivery'
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
    for (let i = 0; i < 5; i++) {
      await deliverSignedDoorbell(env, job.payload, { nowMs: Date.parse(T0) + i * 1000 })
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
    const shown = await deliverSignedDoorbell(env, reassign!.payload, { nowMs: Date.parse(T0) + 1000 })
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
})
