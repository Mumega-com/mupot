// mupot — GHL gated act-channel tests (issue #8).
//
// Coverage:
//   ghlConfigured:
//     1.  true when both GHL_API_KEY + GHL_LOCATION_ID set
//     2.  false when GHL_API_KEY missing
//     3.  false when GHL_LOCATION_ID missing
//     4.  false when both missing
//
//   runApprovedActs — gate enforcement (the core security tests):
//     5.  verdict NOT approved (rejected) → acts marked 'refused', ghlFetch NEVER called
//     6.  verdict absent (none) → acts marked 'refused', ghlFetch NEVER called
//     7.  verdict approved + !ghlConfigured → acts stay 'pending', ghlFetch NEVER called
//         (fails-closed test — the most important single test in this file)
//     8.  verdict approved + configured + ghlFetch 2xx → act 'sent', verdict_id set
//     9.  verdict approved + configured + ghlFetch non-2xx → act 'failed', sanitized detail
//     10. ghlFetch throws → act 'failed', detail = 'fetch_error'
//     11. ghlFetch called with Bearer key — key in call args, NOT in returned objects or errors
//     12. failed act detail NEVER contains the API key
//
//   createOutboundAct:
//     13. rejects unknown kind (code: unknown_act_kind)
//     14. rejects malformed payload (send_email missing subject)
//     15. persists pending act with correct kind + payload
//
//   inbound webhook (verifyGHLWebhook + ghlInboundApp):
//     16. unset GHL_WEBHOOK_SECRET → 503 not_configured
//     17. bad signature → 401 unauthorized, no task created
//     18. missing signature header → 401, no task created
//     19. valid HMAC signature → 200, createTask called once
//
//   pipeline integration:
//     20. approved gate + pending acts → runApprovedActs invoked once
//     21. rejected verdict → runApprovedActs NOT invoked
//     22. gate-timeout (no verdict) → runApprovedActs NOT invoked
//     23. approved gate + zero pending acts → outbound-acts step skipped

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ghlConfigured, runApprovedActs, createOutboundAct } from '../src/integrations/ghl'
import type { GHLFetch, ReadLatestVerdict, ActRunResult } from '../src/integrations/ghl'
import { verifyGHLWebhook } from '../src/integrations/ghl-routes'
import { ghlInboundApp } from '../src/integrations/ghl-routes'
import { runTaskPipeline } from '../src/workflows/pipeline'
import type { StepLike, TaskPipelineParams, PipelineDeps, VerdictRow } from '../src/workflows/pipeline'
import type { Env, Agent } from '../src/types'
import type { ExecuteResult } from '../src/agents/execute'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_API_KEY = 'ghl_api_key_abc123xyz'
const FAKE_LOCATION = 'loc_999'
const FAKE_SECRET = 'webhook_secret_xyzzy'
const TASK_ID = 'task-ghl-1'
const ACT_ID = 'act-uuid-1'
const VERDICT_ID = 'verdict-uuid-1'

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    TENANT_SLUG: 'test',
    DB: null as unknown as Env['DB'],
    VEC: null as unknown as Env['VEC'],
    BUS: null as unknown as Env['BUS'],
    SESSIONS: null as unknown as Env['SESSIONS'],
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

function makeConfiguredEnv(): Env {
  return makeEnv({ GHL_API_KEY: FAKE_API_KEY, GHL_LOCATION_ID: FAKE_LOCATION })
}

/** Build a minimal D1-like stub that records writes and returns canned data. */
interface ActRow { id: string; kind: string; payload: string }

function makeD1(opts: {
  pendingActs?: ActRow[]
  insertId?: string
  writeCallback?: (sql: string, binds: unknown[]) => void
} = {}) {
  // Captures all bind() calls so tests can assert on them.
  const insertedRows: { sql: string; binds: unknown[] }[] = []

  function prepareFn(sql: string) {
    return {
      bind(...binds: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            // outbound_acts COUNT
            if (sql.includes('COUNT(*)')) {
              return { n: opts.pendingActs?.length ?? 0 } as unknown as T
            }
            // outbound_acts SELECT for runApprovedActs
            if (sql.includes('FROM outbound_acts') && sql.includes('SELECT id, kind, payload')) {
              return null // all() handles the multi-row case
            }
            // task_verdicts
            if (sql.includes('FROM task_verdicts')) {
              return null
            }
            return null
          },
          async all<T>(): Promise<{ results: T[] }> {
            // pending acts for runApprovedActs
            if (sql.includes('SELECT id, kind, payload')) {
              return { results: (opts.pendingActs ?? []) as unknown as T[] }
            }
            // refused-act sweep (SELECT id FROM outbound_acts WHERE ... status = 'pending')
            if (sql.includes("status = 'pending'") && sql.includes('SELECT id')) {
              return { results: (opts.pendingActs?.map(a => ({ id: a.id })) ?? []) as unknown as T[] }
            }
            return { results: [] }
          },
          async run() {
            insertedRows.push({ sql, binds })
            opts.writeCallback?.(sql, binds)
            return { meta: { changes: 1 } }
          },
        }
      },
    }
  }

  return {
    prepare: prepareFn,
    insertedRows,
  }
}

// ── 1–4: ghlConfigured ───────────────────────────────────────────────────────

describe('ghlConfigured', () => {
  it('1. returns true when both GHL_API_KEY + GHL_LOCATION_ID are set', () => {
    expect(ghlConfigured(makeConfiguredEnv())).toBe(true)
  })

  it('2. returns false when GHL_API_KEY is missing', () => {
    expect(ghlConfigured(makeEnv({ GHL_LOCATION_ID: FAKE_LOCATION }))).toBe(false)
  })

  it('3. returns false when GHL_LOCATION_ID is missing', () => {
    expect(ghlConfigured(makeEnv({ GHL_API_KEY: FAKE_API_KEY }))).toBe(false)
  })

  it('4. returns false when both are missing', () => {
    expect(ghlConfigured(makeEnv())).toBe(false)
  })
})

// ── 5–12: runApprovedActs — gate enforcement ──────────────────────────────────

describe('runApprovedActs — gate enforcement', () => {
  const pendingActs: ActRow[] = [
    { id: ACT_ID, kind: 'send_email', payload: JSON.stringify({ subject: 'Hi', body: 'Hello', email: 'a@b.com' }) },
  ]

  it('5. verdict rejected → acts refused, ghlFetch NEVER called', async () => {
    const ghlFetch = vi.fn<GHLFetch>()
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'rejected' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(ghlFetch).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    expect(result.reason).toBe('gate_not_approved')
    // Verify the act was marked refused.
    const updateCalls = db.insertedRows.filter(r => r.sql.includes("status = 'refused'"))
    expect(updateCalls.length).toBeGreaterThan(0)
  })

  it('6. no verdict (null) → acts refused, ghlFetch NEVER called', async () => {
    const ghlFetch = vi.fn<GHLFetch>()
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue(null)
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(ghlFetch).not.toHaveBeenCalled()
    expect(result.reason).toBe('gate_not_approved')
    expect(result.sent).toBe(0)
  })

  it('7. verdict approved + !ghlConfigured → acts stay pending, ghlFetch NEVER called (fails-closed)', async () => {
    const ghlFetch = vi.fn<GHLFetch>()
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    // Not configured — no GHL secrets
    const env = { ...makeEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(ghlFetch).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_configured')
    expect(result.sent).toBe(0)
    // Acts must NOT be updated (they stay pending for when config arrives).
    const updateCalls = db.insertedRows.filter(r =>
      r.sql.includes('UPDATE outbound_acts')
    )
    expect(updateCalls.length).toBe(0)
  })

  it('8. verdict approved + configured + 2xx → act sent, verdict_id set', async () => {
    const ghlFetch: GHLFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(result.ok).toBe(true)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    // Verify sent update carries verdict_id
    const sentUpdate = db.insertedRows.find(r => r.sql.includes("status = 'sent'"))
    expect(sentUpdate).toBeDefined()
    expect(sentUpdate?.binds).toContain(VERDICT_ID)
  })

  it('9. verdict approved + configured + non-2xx → act failed, detail is sanitized status code', async () => {
    const ghlFetch: GHLFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
    // Detail must be status-code only (e.g. "ghl_429"), never the key.
    const failUpdate = db.insertedRows.find(r => r.sql.includes("status = 'failed'"))
    expect(failUpdate).toBeDefined()
    const detail = failUpdate?.binds.find(b => typeof b === 'string' && (b as string).startsWith('ghl_'))
    expect(detail).toBe('ghl_429')
  })

  it('9b. P1: claim returns 0 changes (already sent by a prior attempt) → NO re-send', async () => {
    // Simulates a CF Workflows step retry: the act was already claimed+sent on the
    // first attempt. The atomic pending→sending claim now changes 0 rows, so the
    // loop must SKIP it and never call ghlFetch again. Guards customer double-send.
    const ghlFetch = vi.fn<GHLFetch>().mockResolvedValue({ ok: true, status: 200 })
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    // Custom DB whose claim UPDATE (SET status = 'sending') reports 0 changes.
    const rows: { sql: string; binds: unknown[] }[] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (sql.includes('COUNT(*)')) return { n: 1 } as unknown as T
                return null
              },
              async all<T>(): Promise<{ results: T[] }> {
                if (sql.includes('SELECT id, kind, payload')) {
                  return { results: [{ id: ACT_ID, kind: 'send_email', payload: JSON.stringify({ subject: 'Hi', body: 'Hello', email: 'a@b.com' }) }] as unknown as T[] }
                }
                return { results: [] }
              },
              async run() {
                rows.push({ sql, binds })
                // The claim is the only UPDATE that must report 0 changes.
                const changes = sql.includes("status = 'sending'") ? 0 : 1
                return { meta: { changes } }
              },
            }
          },
        }
      },
    }
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(ghlFetch).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
    // No 'sent' write happened either.
    expect(rows.find(r => r.sql.includes("status = 'sent'"))).toBeUndefined()
  })

  it('10. ghlFetch throws → act failed, detail = fetch_error', async () => {
    const ghlFetch: GHLFetch = vi.fn().mockRejectedValue(new Error('network timeout'))
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    const result = await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    expect(result.failed).toBe(1)
    const failUpdate = db.insertedRows.find(r =>
      r.sql.includes("status = 'failed'") && r.binds.includes('fetch_error')
    )
    expect(failUpdate).toBeDefined()
  })

  it('11. ghlFetch is called with the Bearer api key', async () => {
    let capturedKey: string | undefined
    const ghlFetch: GHLFetch = vi.fn().mockImplementation(
      async (_path, _method, _body, apiKey) => {
        capturedKey = apiKey
        return { ok: true, status: 200 }
      }
    )
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    // The key was passed to ghlFetch (so it can be used for the real API call).
    expect(capturedKey).toBe(FAKE_API_KEY)
  })

  it('12. failed act detail NEVER contains the API key', async () => {
    const ghlFetch: GHLFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const readLatestVerdict: ReadLatestVerdict = vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' })
    const db = makeD1({ pendingActs })
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }

    await runApprovedActs(env, TASK_ID, { readLatestVerdict, ghlFetch })

    // Inspect every DB write — none should contain the api key string.
    for (const row of db.insertedRows) {
      for (const bind of row.binds) {
        if (typeof bind === 'string') {
          expect(bind).not.toContain(FAKE_API_KEY)
        }
      }
    }
  })
})

// ── 13–15: createOutboundAct ──────────────────────────────────────────────────

describe('createOutboundAct', () => {
  it('13. rejects unknown kind with code unknown_act_kind', async () => {
    const db = makeD1()
    const env = { ...makeEnv(), DB: db as unknown as Env['DB'] }

    await expect(
      createOutboundAct(env, TASK_ID, 'send_sms', { phone: '+1234' })
    ).rejects.toMatchObject({ code: 'unknown_act_kind' })

    // No DB write should have happened.
    expect(db.insertedRows).toHaveLength(0)
  })

  it('14. rejects malformed payload (send_email missing subject)', async () => {
    const db = makeD1()
    const env = { ...makeEnv(), DB: db as unknown as Env['DB'] }

    await expect(
      createOutboundAct(env, TASK_ID, 'send_email', { email: 'a@b.com', body: 'hi' })
    ).rejects.toMatchObject({ code: 'invalid_act_payload' })

    expect(db.insertedRows).toHaveLength(0)
  })

  it('15. persists pending act with correct kind + payload', async () => {
    let capturedSql = ''
    let capturedBinds: unknown[] = []
    const db = makeD1({
      writeCallback: (sql, binds) => {
        capturedSql = sql
        capturedBinds = binds
      },
    })
    const env = { ...makeEnv(), DB: db as unknown as Env['DB'] }
    const payload = { email: 'c@d.com', subject: 'Welcome', body: 'Hi there' }

    const { id } = await createOutboundAct(env, TASK_ID, 'send_email', payload)

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(capturedSql).toContain('INSERT INTO outbound_acts')
    expect(capturedBinds).toContain('send_email')
    expect(capturedBinds).toContain(TASK_ID)
    // Payload is stored as JSON string
    const payloadBind = capturedBinds.find(b => typeof b === 'string' && (b as string).includes('Welcome'))
    expect(payloadBind).toBeDefined()
  })
})

// ── 16–19: inbound webhook ────────────────────────────────────────────────────

describe('inbound webhook verification', () => {
  // Helper: compute a real HMAC-SHA256 for test verification
  async function signBody(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  it('16. unset GHL_WEBHOOK_SECRET → 503 not_configured (verifyGHLWebhook)', async () => {
    const env = makeEnv()
    const result = await verifyGHLWebhook(env, '{}', 'sig')
    expect(result).toBe('not_configured')
  })

  it('17. bad signature → invalid (verifyGHLWebhook)', async () => {
    const env = makeEnv({ GHL_WEBHOOK_SECRET: FAKE_SECRET })
    const result = await verifyGHLWebhook(env, '{"type":"reply"}', 'badhex')
    expect(result).toBe('invalid')
  })

  it('18. missing signature header → invalid', async () => {
    const env = makeEnv({ GHL_WEBHOOK_SECRET: FAKE_SECRET })
    const result = await verifyGHLWebhook(env, '{"type":"reply"}', null)
    expect(result).toBe('invalid')
  })

  it('19. valid HMAC signature → ok', async () => {
    const body = '{"type":"reply_received","contact_id":"cid-1"}'
    const sig = await signBody(FAKE_SECRET, body)
    const env = makeEnv({ GHL_WEBHOOK_SECRET: FAKE_SECRET })
    const result = await verifyGHLWebhook(env, body, sig)
    expect(result).toBe('ok')
  })
})

describe('ghlInboundApp HTTP handler', () => {
  async function signBody(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const BODY = '{"type":"reply_received","contact_id":"cid-x"}'

  function makeEnvWithSquad(extraSecrets: Record<string, unknown> = {}) {
    // D1 mock: resolveInboundSquad calls prepare(sql).first<T>() (no bind),
    // while createTask calls prepare(sql).bind(...).run(). Both paths are handled.
    const db = {
      prepare(sql: string) {
        // The bound sub-object is returned by both `.first()` and `.bind()`.
        const stmt = {
          bind(..._binds: unknown[]) {
            return {
              async first<T>(): Promise<T | null> { return null },
              async run() { return { meta: { changes: 1 } } },
              async all<T>() { return { results: [] as T[] } },
            }
          },
          // resolveInboundSquad: prepare(sql).first() — no bind() call
          async first<T>(): Promise<T | null> {
            if (sql.includes('FROM squads')) {
              return { id: 'squad-default' } as unknown as T
            }
            return null
          },
          async run() { return { meta: { changes: 1 } } },
          async all<T>() { return { results: [] as T[] } },
        }
        return stmt
      },
    }
    return makeEnv({
      DB: db as unknown as Env['DB'],
      BUS: {
        // CF Queue.send — used by createBus in createTask's emitTaskEvent
        send: vi.fn().mockResolvedValue(undefined),
      } as unknown as Env['BUS'],
      GITHUB_TOKEN: undefined,
      ...extraSecrets,
    })
  }

  it('handles missing webhook secret → 503', async () => {
    const env = makeEnvWithSquad()
    const req = new Request('http://localhost/inbound', {
      method: 'POST',
      body: BODY,
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await ghlInboundApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(503)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('not_configured')
  })

  it('handles bad signature → 401', async () => {
    const env = makeEnvWithSquad({ GHL_WEBHOOK_SECRET: FAKE_SECRET })
    const req = new Request('http://localhost/inbound', {
      method: 'POST',
      body: BODY,
      headers: {
        'Content-Type': 'application/json',
        'x-ghl-signature': 'badhex',
      },
    })
    const res = await ghlInboundApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(401)
  })

  it('valid signature → 200 ok', async () => {
    const sig = await signBody(FAKE_SECRET, BODY)
    const env = makeEnvWithSquad({ GHL_WEBHOOK_SECRET: FAKE_SECRET })
    const req = new Request('http://localhost/inbound', {
      method: 'POST',
      body: BODY,
      headers: {
        'Content-Type': 'application/json',
        'x-ghl-signature': sig,
      },
    })
    const res = await ghlInboundApp.fetch(req, env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean }
    expect(json.ok).toBe(true)
  })
})

// ── 20–23: pipeline integration ──────────────────────────────────────────────

describe('pipeline outbound-acts wiring', () => {
  const PARAMS: TaskPipelineParams = {
    taskId: 'task-pipe-1',
    squadId: 'squad-pipe-1',
    agentId: 'agent-pipe-1',
  }

  const AGENT: Agent = {
    id: 'agent-pipe-1',
    squad_id: 'squad-pipe-1',
    slug: 'worker',
    name: 'Worker',
    role: 'executor',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: null,
    kpi_target: null,
    kpi_progress: 0,
    effort: 'standard',
    autonomy: 'execute_with_approval',
    budget_cap_cents: null,
    budget_window: 'day',
    created_at: '2026-06-08T00:00:00.000Z',
  }

  function makeStep(opts: { waitForEventThrows?: boolean } = {}): StepLike {
    return {
      do<T>(name: string, configOrCb: unknown, maybeCb?: () => Promise<T>): Promise<T> {
        const cb = typeof configOrCb === 'function'
          ? (configOrCb as () => Promise<T>)
          : (maybeCb as () => Promise<T>)
        return cb()
      },
      waitForEvent<T>(_name: string, _opts: { type: string; timeout?: string }): Promise<{ payload: T }> {
        if (opts.waitForEventThrows) return Promise.reject(new Error('timeout'))
        return Promise.resolve({ payload: {} as T })
      },
    }
  }

  const approvedVerdict: VerdictRow = { verdict: 'approved' }
  const rejectedVerdict: VerdictRow = { verdict: 'rejected' }

  const successExecute = vi.fn<(env: Env, agent: Agent, taskId: string) => Promise<ExecuteResult>>()
    .mockResolvedValue({ ok: true, task_id: PARAMS.taskId, decided: 'review', task_status: 'review' } as ExecuteResult)

  it('20. approved gate + pending acts → runApprovedActs invoked once, sent=1', async () => {
    const ghlFetch = vi.fn<GHLFetch>().mockResolvedValue({ ok: true, status: 200 })
    const pendingActs: ActRow[] = [
      { id: ACT_ID, kind: 'send_email', payload: JSON.stringify({ subject: 'Hi', body: 'Hello', email: 'a@b.com' }) },
    ]
    const db = makeD1({ pendingActs })

    const deps: PipelineDeps = {
      loadAgent: vi.fn().mockResolvedValue(AGENT),
      runTaskExecution: successExecute,
      readLatestVerdict: vi.fn().mockResolvedValue(approvedVerdict),
      writeReceipt: vi.fn().mockResolvedValue(undefined),
      countPendingActs: vi.fn().mockResolvedValue(1),
      ghlDeps: {
        readLatestVerdict: vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'approved' }),
        ghlFetch,
      },
    }

    // Configured env so ghlConfigured() = true
    const env = { ...makeConfiguredEnv(), DB: db as unknown as Env['DB'] }
    const summary = await runTaskPipeline(env, PARAMS, makeStep(), 'inst-1', deps)

    expect(summary.gated).toBe(true)
    expect(summary.resolved).toBe(true)
    // countPendingActs was called (the guard ran)
    expect(deps.countPendingActs).toHaveBeenCalledWith(env, PARAMS.taskId)
    // actsResult is present (step ran); ghlFetch was called (approved + configured)
    expect(summary.actsResult).toBeDefined()
    expect(ghlFetch).toHaveBeenCalledOnce()
    expect(summary.actsResult?.sent).toBe(1)
  })

  it('21. rejected verdict → ghlFetch NEVER called (runApprovedActs refuses internally)', async () => {
    // When the pipeline resolves with a rejected verdict, the outbound-acts step is
    // entered (gated=true, resolved=true, pending acts > 0) but runApprovedActs
    // independently re-reads the verdict and refuses before sending. ghlFetch MUST
    // NOT be called under any circumstances with a rejected verdict.
    const ghlFetch = vi.fn<GHLFetch>()

    // Build a D1 mock that handles the refused-acts sweep
    // (SELECT id FROM outbound_acts WHERE ... status = 'pending').
    const db = makeD1({
      pendingActs: [{ id: ACT_ID, kind: 'send_email', payload: '{}' }],
    })

    const deps: PipelineDeps = {
      loadAgent: vi.fn().mockResolvedValue(AGENT),
      runTaskExecution: successExecute,
      readLatestVerdict: vi.fn().mockResolvedValue(rejectedVerdict),
      writeReceipt: vi.fn().mockResolvedValue(undefined),
      countPendingActs: vi.fn().mockResolvedValue(1),
      ghlDeps: {
        readLatestVerdict: vi.fn().mockResolvedValue({ id: VERDICT_ID, verdict: 'rejected' }),
        ghlFetch,
      },
    }

    const env = { ...makeEnv(), DB: db as unknown as Env['DB'] }
    const summary = await runTaskPipeline(env, PARAMS, makeStep(), 'inst-2', deps)

    expect(summary.gated).toBe(true)
    expect(summary.resolved).toBe(true)
    // Core assertion: ghlFetch never called with rejected verdict.
    expect(ghlFetch).not.toHaveBeenCalled()
    // actsResult is set (step ran), sent=0 (refused internally).
    expect(summary.actsResult?.sent).toBe(0)
  })

  it('22. gate-timeout (no verdict in D1) → resolved=false, outbound-acts step NOT entered', async () => {
    const countPendingActs = vi.fn<(env: Env, taskId: string) => Promise<number>>().mockResolvedValue(3)
    const ghlFetch = vi.fn<GHLFetch>()

    const deps: PipelineDeps = {
      loadAgent: vi.fn().mockResolvedValue(AGENT),
      runTaskExecution: successExecute,
      readLatestVerdict: vi.fn().mockResolvedValue(null), // timeout: no verdict
      writeReceipt: vi.fn().mockResolvedValue(undefined),
      countPendingActs,
      ghlDeps: { ghlFetch },
    }

    const env = makeEnv()
    const summary = await runTaskPipeline(env, PARAMS, makeStep({ waitForEventThrows: true }), 'inst-3', deps)

    expect(summary.resolved).toBe(false)
    // countPendingActs NOT called — step guard requires resolved=true.
    expect(countPendingActs).not.toHaveBeenCalled()
    expect(ghlFetch).not.toHaveBeenCalled()
    expect(summary.actsResult).toBeUndefined()
  })

  it('23. approved gate + zero pending acts → outbound-acts step body skipped, no step.do', async () => {
    const ghlFetch = vi.fn<GHLFetch>()

    const deps: PipelineDeps = {
      loadAgent: vi.fn().mockResolvedValue(AGENT),
      runTaskExecution: successExecute,
      readLatestVerdict: vi.fn().mockResolvedValue(approvedVerdict),
      writeReceipt: vi.fn().mockResolvedValue(undefined),
      countPendingActs: vi.fn().mockResolvedValue(0), // zero pending
      ghlDeps: { ghlFetch },
    }

    const env = makeEnv()
    const summary = await runTaskPipeline(env, PARAMS, makeStep(), 'inst-4', deps)

    // step skipped entirely (no actsResult) because count === 0
    expect(summary.actsResult).toBeUndefined()
    expect(ghlFetch).not.toHaveBeenCalled()
  })
})
