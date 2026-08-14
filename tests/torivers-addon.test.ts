import { describe, expect, it, beforeEach } from 'vitest'
import { toriversAddonApp } from '../src/addons/torivers'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega.com',
    TORIVERS_SECRET: 'test-torivers-secret-123',
  } as Env
})

describe('ToRivers v2 Deterministic Automation Addon Suite (@mumega/addon-torivers)', () => {
  it('1) GET /health returns 200 OK with addon metadata', async () => {
    const res = await toriversAddonApp.request('/health', {}, env)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.addon).toBe('@mumega/addon-torivers')
  })

  it('2) GET /marketplace/automations returns catalog', async () => {
    const res = await toriversAddonApp.request('/marketplace/automations', {}, env)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.automations.length).toBeGreaterThan(0)
  })

  it('3) POST /workflows/execute requires secret authorization', async () => {
    const resNoAuth = await toriversAddonApp.request(
      '/workflows/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: 'auto_seo_audit' }),
      },
      env
    )
    expect(resNoAuth.status).toBe(401)

    const resAuth = await toriversAddonApp.request(
      '/workflows/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torivers-Secret': 'test-torivers-secret-123',
        },
        body: JSON.stringify({ workflowId: 'auto_seo_audit' }),
      },
      env
    )
    // 501, not 200 — the engine is not built (mupot#1017). This assertion previously
    // read `200 / ok: true`, which is what let a stub that fabricated receipts and wrote
    // hardcoded token counts into `subagent_token_usage` pass review as working code.
    // The test asserted the claim rather than the behaviour.
    expect(resAuth.status).toBe(501)
    const json = await resAuth.json()
    expect(json.ok).toBe(false)
    expect(json.error).toBe('not_implemented')
    expect(json.workflowId).toBe('auto_seo_audit')
    // The auth path still works — 401 above, past-auth here. Only execution is absent.
  })

  it('3b) /workflows/execute writes NOTHING to the ledger', async () => {
    // THE LOAD-BEARING TEST. The defect was not the fake receipt in the response body —
    // a caller can see that. It was the INSERT into subagent_token_usage: hardcoded
    // prompt/completion tokens 150/300, indistinguishable at read time from measured
    // usage, silently inflating COGS on every call.
    //
    // So this asserts the absence of a write, which nothing else can: a DB whose
    // prepare() throws. If any statement is issued on this path, the request 500s and
    // this test fails. Restoring the INSERT — or adding any other write here before the
    // real engine exists — turns it red.
    const writes: string[] = []
    const envNoWrites = {
      ...env,
      DB: {
        prepare(sql: string) {
          writes.push(sql)
          throw new Error('no write should occur on the not-implemented path')
        },
      },
    } as unknown as typeof env

    const res = await toriversAddonApp.request(
      '/workflows/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torivers-Secret': 'test-torivers-secret-123',
        },
        body: JSON.stringify({ workflowId: 'auto_seo_audit' }),
      },
      envNoWrites
    )

    expect(res.status).toBe(501)
    expect(writes).toEqual([])
  })

  it('4) Flight F1: POST /workflows/execute returns 503 when TORIVERS_SECRET is unconfigured', async () => {
    const unconfiguredEnv = {
      DB: harness.db,
      TENANT_SLUG: 'mumega.com',
    } as Env

    const res = await toriversAddonApp.request(
      '/workflows/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: 'auto_seo_audit' }),
      },
      unconfiguredEnv
    )
    expect(res.status).toBe(503)
  })
})
