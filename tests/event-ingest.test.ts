// mupot — event ingestion tests (feedback-loop act wiring, Door 14).
//
// Coverage:
//   ingestEvent — core function:
//     1. Mapped event type creates a task with a REAL (non-placeholder) done_when
//     2. Unmapped event type → ok:false, code:unmapped_event_type (no silent placeholder)
//     3. Squad not found in DB → ok:false, code:squad_not_found (no task created)
//     4. All 6 canonical event types produce non-empty, non-placeholder done_when strings
//     5. skipMirror defaults to true (external events do not loop back to GitHub)
//
//   HTTP surface (eventIngestApp):
//     6. Missing EVENT_INGEST_SECRET → 503 not_configured
//     7. Bad signature → 401 unauthorized
//     8. Valid signature + unmapped type → 400 unmapped_event_type (not 500, not silent)
//     9. Valid signature + known type + real squad → 201 with task_id and done_when
//     10. Missing field (squad_id) → 400 missing_field
//
//   RBAC / isolation:
//     11. squad_id not in DB → 404 squad_not_found (no cross-tenant task creation)
//
// Deliberately NOT testing: createTask internals (tested in tasks-done-when.test.ts),
// HMAC cryptography (tested in ghl-integration.test.ts).

import { describe, it, expect, vi } from 'vitest'
import { ingestEvent, verifyEventSignature, eventIngestApp, EVENT_REGISTRY } from '../src/events/ingest'
import type { InboundEvent } from '../src/events/ingest'
import type { Env } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_SECRET = 'event_secret_xyzzy'
const SQUAD_ID = 'squad-test-1'

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    TENANT_SLUG: 'test',
    DB: null as unknown as Env['DB'],
    VEC: null as unknown as Env['VEC'],
    BUS: null as unknown as Env['BUS'],
    SESSIONS: null as unknown as Env['SESSIONS'],
    OAUTH_KV: null as unknown as Env['OAUTH_KV'],
    BLOBS: null as unknown as Env['BLOBS'],
    AI: null as unknown as Env['AI'],
    AGENT: null as unknown as Env['AGENT'],
    SQUAD: null as unknown as Env['SQUAD'],
    TASK_WORKFLOW: undefined,
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
    ...overrides,
  } as unknown as Env
}

/** Build a D1 stub that handles squad lookup and task insert. */
function makeDB(squadExists: boolean) {
  const inserts: { sql: string; binds: unknown[] }[] = []
  return {
    inserts,
    db: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                // Squad existence check
                if (sql.includes('FROM squads')) {
                  if (!squadExists) return null
                  return { id: SQUAD_ID } as unknown as T
                }
                return null
              },
              async run() {
                inserts.push({ sql, binds })
                return { meta: { changes: 1 } }
              },
              async all<T>() {
                return { results: [] as T[] }
              },
            }
          },
        }
      },
    },
  }
}

function makeEnvWithDB(squadExists = true, extraEnv: Record<string, unknown> = {}): {
  env: Env
  inserts: { sql: string; binds: unknown[] }[]
} {
  const { db, inserts } = makeDB(squadExists)
  const env = makeEnv({
    DB: db as unknown as Env['DB'],
    BUS: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['BUS'],
    ...extraEnv,
  })
  return { env, inserts }
}

function makeEvent(type: string, payloadOverrides: Record<string, unknown> = {}): InboundEvent {
  return {
    type,
    source: 'test-source',
    squad_id: SQUAD_ID,
    payload: { lead_id: 'lead-42', email: 'test@example.com', ...payloadOverrides },
  }
}

// ── 1: mapped event creates task with real done_when ──────────────────────────

describe('ingestEvent — mapped event', () => {
  it('1. lead.captured creates a task with a non-empty, non-placeholder done_when', async () => {
    const { env, inserts } = makeEnvWithDB()
    const event = makeEvent('lead.captured', { lead_id: 'lead-42', email: 'alice@acme.com' })

    const result = await ingestEvent(env, event)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(typeof result.task_id).toBe('string')
    expect(result.task_id.length).toBeGreaterThan(0)
    expect(typeof result.done_when).toBe('string')
    expect(result.done_when.trim().length).toBeGreaterThan(0)

    // Must contain a real predicate — not a known sentinel
    const sentinels = ['(backfill required)', '(set via task update)', '(agent-generated']
    for (const s of sentinels) {
      expect(result.done_when).not.toContain(s)
    }

    // Task must have been written to DB
    const taskInsert = inserts.find(r => r.sql.includes('INSERT INTO tasks'))
    expect(taskInsert).toBeDefined()
    // The done_when in the DB row must match the returned value
    const doneWhenInRow = taskInsert?.binds.find(b => b === result.done_when)
    expect(doneWhenInRow).toBeDefined()
  })
})

// ── 2: unmapped event type is rejected (not silently placeholder-ed) ───────────

describe('ingestEvent — unmapped event type', () => {
  it('2. unknown event type → ok:false, code:unmapped_event_type, no DB write', async () => {
    const { env, inserts } = makeEnvWithDB()
    const event = makeEvent('mystery.event.type')

    const result = await ingestEvent(env, event)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unmapped_event_type')
    expect(result.event_type).toBe('mystery.event.type')

    // No task must have been inserted
    const taskInsert = inserts.find(r => r.sql.includes('INSERT INTO tasks'))
    expect(taskInsert).toBeUndefined()
  })
})

// ── 3: squad not found ────────────────────────────────────────────────────────

describe('ingestEvent — squad isolation', () => {
  it('3. squad_id not in DB → ok:false, code:squad_not_found, no task created', async () => {
    const { env, inserts } = makeEnvWithDB(false /* squadExists */)
    const event = makeEvent('lead.captured')

    const result = await ingestEvent(env, event)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('squad_not_found')
    expect(result.squad_id).toBe(SQUAD_ID)

    const taskInsert = inserts.find(r => r.sql.includes('INSERT INTO tasks'))
    expect(taskInsert).toBeUndefined()
  })
})

// ── 4: all canonical event types produce valid done_when strings ──────────────

describe('EVENT_REGISTRY — all canonical types produce valid done_when', () => {
  const SENTINEL_PATTERNS = [
    '(backfill required)',
    '(set via task update)',
    '(agent-generated',
  ]

  function isValidDoneWhen(dw: string): boolean {
    if (dw.trim().length === 0) return false
    for (const s of SENTINEL_PATTERNS) {
      if (dw.toLowerCase().includes(s.toLowerCase())) return false
    }
    return true
  }

  const samplePayloads: Record<string, Record<string, unknown>> = {
    'lead.captured': { lead_id: 'L1', email: 'a@b.com', source: 'ghl' },
    'lead.reply_received': { contact_id: 'C2' },
    'form.submitted': { form_id: 'contact-us', email: 'form@b.com' },
    'booking.created': { booking_id: 'B3', contact_id: 'C3', start_time: '2026-07-01T10:00Z' },
    'pipeline.stage_changed': { contact_id: 'C4', stage: 'Proposal Sent' },
    'analytics.signal': { event: 'page_viewed_pricing', distinct_id: 'user-5' },
  }

  for (const [eventType, payload] of Object.entries(samplePayloads)) {
    it(`4. ${eventType} → non-empty, non-placeholder done_when`, () => {
      const deriver = EVENT_REGISTRY.get(eventType)
      expect(deriver).toBeDefined()
      if (!deriver) return

      const derived = deriver(payload)
      expect(derived.done_when.trim().length).toBeGreaterThan(0)
      expect(isValidDoneWhen(derived.done_when)).toBe(true)
      expect(derived.title.trim().length).toBeGreaterThan(0)
    })
  }
})

// ── 5: skipMirror defaults true ────────────────────────────────────────────────

describe('ingestEvent — skipMirror default', () => {
  it('5. skipMirror defaults to true (no GitHub mirror for external events)', async () => {
    // If skipMirror were false, mirrorTaskCreate would call fetch() with a GitHub URL.
    // We confirm fetch is NOT called when GITHUB_TOKEN + GITHUB_REPO are set.
    const { env } = makeEnvWithDB(true, {
      GITHUB_TOKEN: 'gh-token-xyz',
      GITHUB_REPO: 'acme/test-repo',
    })

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    try {
      const event = makeEvent('lead.captured', { lead_id: 'L99' })
      const result = await ingestEvent(env, event)

      expect(result.ok).toBe(true)
      // fetch must NOT have been called (no GitHub mirror)
      const ghCalls = fetchSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && (args[0] as string).includes('github.com'),
      )
      expect(ghCalls).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── 6–11: HTTP surface ─────────────────────────────────────────────────────────

async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('verifyEventSignature', () => {
  it('6. no secret configured → not_configured', async () => {
    const env = makeEnv()
    expect(await verifyEventSignature(env, '{}', 'sig')).toBe('not_configured')
  })

  it('7a. bad signature → invalid', async () => {
    const env = makeEnv({ EVENT_INGEST_SECRET: FAKE_SECRET })
    expect(await verifyEventSignature(env, '{"type":"lead.captured"}', 'badhex')).toBe('invalid')
  })

  it('7b. missing signature → invalid', async () => {
    const env = makeEnv({ EVENT_INGEST_SECRET: FAKE_SECRET })
    expect(await verifyEventSignature(env, '{"type":"lead.captured"}', null)).toBe('invalid')
  })

  it('valid signature → ok', async () => {
    const body = '{"type":"lead.captured","squad_id":"s1"}'
    const sig = await signBody(FAKE_SECRET, body)
    const env = makeEnv({ EVENT_INGEST_SECRET: FAKE_SECRET })
    expect(await verifyEventSignature(env, body, sig)).toBe('ok')
  })
})

describe('eventIngestApp HTTP handler', () => {
  function makeEnvForHTTP(squadExists = true): Env {
    const { db } = makeDB(squadExists)
    return makeEnv({
      EVENT_INGEST_SECRET: FAKE_SECRET,
      DB: db as unknown as Env['DB'],
      BUS: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['BUS'],
    })
  }

  const VALID_BODY = JSON.stringify({
    type: 'lead.captured',
    source: 'viamar-worker',
    squad_id: SQUAD_ID,
    payload: { lead_id: 'L100', email: 'lead@viamar.ca' },
  })

  it('6. missing secret → 503', async () => {
    const env = makeEnv()
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body: VALID_BODY,
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(503)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('not_configured')
  })

  it('7. bad signature → 401', async () => {
    const env = makeEnvForHTTP()
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body: VALID_BODY,
      headers: {
        'Content-Type': 'application/json',
        'x-mupot-signature': 'badhex',
      },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(401)
  })

  it('8. valid signature + unmapped type → 400 unmapped_event_type (not silent)', async () => {
    const env = makeEnvForHTTP()
    const body = JSON.stringify({
      type: 'definitely.not.registered',
      source: 'test',
      squad_id: SQUAD_ID,
      payload: {},
    })
    const sig = await signBody(FAKE_SECRET, body)
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'x-mupot-signature': sig,
      },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string; event_type: string }
    expect(json.error).toBe('unmapped_event_type')
    expect(json.event_type).toBe('definitely.not.registered')
  })

  it('9. valid signature + known type + real squad → 201 with task_id and done_when', async () => {
    const env = makeEnvForHTTP(true)
    const sig = await signBody(FAKE_SECRET, VALID_BODY)
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body: VALID_BODY,
      headers: {
        'Content-Type': 'application/json',
        'x-mupot-signature': sig,
      },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(201)
    const json = await res.json() as { ok: boolean; task_id: string; done_when: string }
    expect(json.ok).toBe(true)
    expect(typeof json.task_id).toBe('string')
    expect(json.task_id.length).toBeGreaterThan(0)
    expect(typeof json.done_when).toBe('string')
    expect(json.done_when.trim().length).toBeGreaterThan(0)
  })

  it('10. missing squad_id → 400 missing_field', async () => {
    const env = makeEnvForHTTP()
    const body = JSON.stringify({ type: 'lead.captured', source: 'test', payload: {} })
    const sig = await signBody(FAKE_SECRET, body)
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'x-mupot-signature': sig,
      },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string; field: string }
    expect(json.error).toBe('missing_field')
    expect(json.field).toBe('squad_id')
  })

  it('11. squad_id not in this pot → 404 squad_not_found (tenant isolation)', async () => {
    const env = makeEnvForHTTP(false /* squadExists */)
    const sig = await signBody(FAKE_SECRET, VALID_BODY)
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      body: VALID_BODY,
      headers: {
        'Content-Type': 'application/json',
        'x-mupot-signature': sig,
      },
    })
    const res = await eventIngestApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(404)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('squad_not_found')
  })
})
