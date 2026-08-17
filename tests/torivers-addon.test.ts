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

  // ── /credentials/match (mupot#1085) ────────────────────────────────────────
  //
  // The defect: the handler mapped over the caller's OWN requiredScopes and stamped
  // satisfied:true on each, with allSatisfied:true and a vaultKeyId string-substituted
  // out of the scope name. No lookup existed. It answered YES to anything.
  //
  // These tests pin the REFUSAL, not the shape of a refusal. #3 in particular asserts
  // the two exact strings that carried the defect can no longer appear in a response
  // body, so re-introducing the map — in any spelling — turns it red.

  const matchReq = (body: unknown, secret: string | null = 'test-torivers-secret-123') =>
    toriversAddonApp.request(
      '/credentials/match',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret === null ? {} : { 'X-Torivers-Secret': secret }),
        },
        body: JSON.stringify(body),
      },
      env
    )

  it('5) POST /credentials/match requires secret authorization', async () => {
    const res = await matchReq({ requiredScopes: ['github.repo'] }, null)
    expect(res.status).toBe(401)
  })

  it('6) POST /credentials/match still rejects a malformed body with 400', async () => {
    // The 400 guard predates the fix and must survive it: a missing/!Array
    // requiredScopes is a caller error, distinct from the endpoint being unbuilt.
    const res = await matchReq({ provider: 'google-oauth2' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.error).toContain('requiredScopes')
  })

  it('7) POST /credentials/match does NOT answer satisfied:true — it answers 501', async () => {
    // `admin.everything` is not a real scope. The old handler confirmed it anyway,
    // because it never consulted anything. That is the whole defect in one request.
    const res = await matchReq({
      requiredScopes: ['admin.everything', 'github.repo', 'google.analytics'],
      provider: 'google-oauth2',
    })

    expect(res.status).toBe(501)

    const raw = await res.text()
    const json = JSON.parse(raw)

    // The claim that was false.
    expect(json.ok).toBe(false)
    expect(json.error).toBe('not_implemented')

    // No satisfaction verdict is rendered, positively or negatively — the endpoint has
    // no basis for either. Asserting `!== true` would still pass on `satisfied: false`,
    // which would be an equally unfounded claim; these assert ABSENCE.
    expect(json.allSatisfied).toBeUndefined()
    expect(json.matches).toBeUndefined()

    // Value-level, on the serialized body: the literals that carried the defect.
    // `satisfied` was the always-yes; `vaultKeyId`/`vault_` was the fabricated key id,
    // invented by string-substituting the scope name into something that reads like a
    // real vault reference. None may appear as a FIELD in any response from this route
    // again — asserted in JSON-key form (`"name":`), because a real field can only
    // serialize that way, so no spelling of the map escapes these. Prose in `detail`
    // is deliberately not caught: the first draft of this test asserted the bare word
    // and went red on the fix's own explanatory string, which is a test failing on
    // documentation rather than on behaviour.
    expect(raw).not.toContain('"satisfied":')
    expect(raw).not.toContain('"allSatisfied":')
    expect(raw).not.toContain('"vaultKeyId":')
    expect(raw).not.toContain('vault_')

    // The request is echoed back so an integrator can see WHAT was refused. Echoing
    // input is safe; asserting something about it is not.
    expect(json.requiredScopes).toEqual(['admin.everything', 'github.repo', 'google.analytics'])
  })

  it('8) /credentials/match writes NOTHING — no ledger row, no audit row', async () => {
    // Same guard as 3b above and for the same reason: a DB whose prepare() throws. The
    // sibling defect (#1017) was not the fake response body but the INSERT behind it.
    // Nothing on this path may touch the database while the scope model does not exist.
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
      '/credentials/match',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torivers-Secret': 'test-torivers-secret-123',
        },
        body: JSON.stringify({ requiredScopes: ['github.repo'] }),
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
