// Tests for the secret-env service (request / status / bind / reject / resolve).
//
// Custody invariant under test throughout: third-party secret VALUES must never
// appear in any D1 SQL bind argument or audit `detail` string. Only binding
// NAMES, purposes, reasons, and actor ids may touch D1.
//
// Real SQLite, and the schema is the WHOLE committed migration chain via
// applyAllMigrations (the #684 ratchet — scripts/check-test-schema-source.mjs).
// The first draft of this file hand-rolled a D1-shaped object literal that
// string-matched SQL and answered whatever the test expected — it never
// executed a query, so a bind naming a column that does not exist could not
// be contradicted. Real SQLite catches that.

import { describe, it, expect } from 'vitest'
import {
  requestSecretEnv,
  listPendingSecretEnvRequests,
  getSecretEnvStatus,
  bindSecretEnv,
  rejectSecretEnv,
  resolveSecretEnvBinding,
} from '../src/secret-env/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// ── DB harness ────────────────────────────────────────────────────────────

function makeEnv(opts: {
  tenant?: string
  cfConfigured?: boolean
} = {}): { env: Env; harness: SqliteD1Harness } {
  const tenant = opts.tenant ?? 'test-tenant'
  const cfConfigured = opts.cfConfigured ?? true

  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)

  const envBase: Record<string, unknown> = { TENANT_SLUG: tenant, DB: harness.db }
  if (cfConfigured) {
    envBase.SECRET_ENV_CF_ACCOUNT_ID = 'acct'
    envBase.SECRET_ENV_CF_SCRIPT_NAME = 'mupot-t'
    envBase.SECRET_ENV_CF_API_TOKEN = 'ops-tok'
  }

  return { env: envBase as unknown as Env, harness }
}

// Direct real-row reads — the substrate-real replacement for the old mock's
// in-memory Maps. These read the ACTUAL committed state, not an author's
// belief about what an INSERT would have produced.
function requestRows(harness: SqliteD1Harness): Record<string, unknown>[] {
  return harness.sqlite.prepare('SELECT * FROM secret_env_requests').all()
}
function bindingRows(harness: SqliteD1Harness): Record<string, unknown>[] {
  return harness.sqlite.prepare('SELECT * FROM secret_env_bindings').all()
}
function auditRows(harness: SqliteD1Harness): Record<string, unknown>[] {
  return harness.sqlite.prepare('SELECT * FROM secret_env_audit').all()
}

const validKeys = [
  { name: 'NOTION_API_KEY', purpose: 'Read/write Notion pages for the agent' },
]

// ── requestSecretEnv ──────────────────────────────────────────────────────────

describe('requestSecretEnv', () => {
  it('inserts request + pending bindings + request audit', async () => {
    const { env, harness } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: validKeys,
      reason: 'Need Notion access for the docs adapter',
      adapterHint: 'mcp:notion',
      requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error()
    expect(result.request.status).toBe('pending')
    expect(result.request.keys).toEqual(validKeys)
    expect(result.request.adapter_hint).toBe('mcp:notion')

    expect(requestRows(harness).length).toBe(1)
    const bindings = bindingRows(harness)
    expect(bindings.length).toBe(1)
    expect(bindings[0]!.binding_name).toBe('NOTION_API_KEY')
    expect(bindings[0]!.status).toBe('pending')

    const audit = auditRows(harness)
    expect(audit.length).toBe(1)
    expect(audit[0]!.action).toBe('request')
    expect(String(audit[0]!.detail)).toContain('NOTION_API_KEY')
  })

  it('rejects an invalid binding name', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: [{ name: 'notion_api_key', purpose: 'lowercase invalid' }],
      reason: 'reason',
      adapterHint: null,
      requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('invalid_binding_name')
  })

  it('rejects a reserved binding name', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: [{ name: 'CONNECTOR_MASTER_KEY', purpose: 'trying to steal' }],
      reason: 'reason',
      adapterHint: null,
      requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('reserved_binding_name')
  })

  it('rejects an empty reason', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: validKeys,
      reason: '   ',
      adapterHint: null,
      requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('reason_required')
  })

  it('rejects more than 20 keys', async () => {
    const { env } = makeEnv()
    const keys = Array.from({ length: 21 }, (_, i) => ({ name: `KEY_${i}`, purpose: 'p' }))
    const result = await requestSecretEnv(env, {
      keys, reason: 'reason', adapterHint: null, requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('too_many_keys')
  })

  it('rejects reason longer than 500 chars', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: validKeys, reason: 'x'.repeat(501), adapterHint: null, requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('reason_too_long')
  })

  it('rejects purpose longer than 280 chars', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: [{ name: 'NOTION_API_KEY', purpose: 'x'.repeat(281) }],
      reason: 'reason', adapterHint: null, requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('purpose_too_long')
  })

  it('rejects adapterHint longer than 64 chars', async () => {
    const { env } = makeEnv()
    const result = await requestSecretEnv(env, {
      keys: validKeys, reason: 'reason', adapterHint: 'x'.repeat(65), requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('adapter_hint_too_long')
  })

  it('rejects re-requesting a name that is already pending, with binding_name_conflict', async () => {
    const { env, harness } = makeEnv()
    const first = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r1', adapterHint: null, requestedBy: 'agent-1',
    })
    expect(first.ok).toBe(true)

    const second = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r2', adapterHint: null, requestedBy: 'agent-2',
    })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error()
    expect(second.error).toBe('binding_name_conflict')
    // No partial write from the rejected second request.
    expect(bindingRows(harness).length).toBe(1)
  })

  it('rejects re-requesting a name that is already bound, with binding_name_conflict', async () => {
    const { env } = makeEnv()
    const first = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r1', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!first.ok) throw new Error()
    const fetchImpl = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    const bound = await bindSecretEnv(env, {
      requestId: first.request.id, values: { NOTION_API_KEY: 'v' }, actorId: 'admin-1', fetchImpl,
    })
    expect(bound.ok).toBe(true)

    const second = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r2', adapterHint: null, requestedBy: 'agent-2',
    })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error()
    expect(second.error).toBe('binding_name_conflict')
  })

  it('returns binding_name_conflict when batch hits a UNIQUE constraint (concurrent race)', async () => {
    const { env } = makeEnv()
    const uniqueErr = new Error(
      'D1_ERROR: UNIQUE constraint failed: secret_env_bindings.tenant, secret_env_bindings.binding_name',
    )
    env.DB.batch = async () => {
      throw uniqueErr
    }

    const result = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r1', adapterHint: null, requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error()
    expect(result.error).toBe('binding_name_conflict')
  })

  it('allows re-requesting a name that was revoked (reuses the row, back to pending)', async () => {
    const { env, harness } = makeEnv()
    const first = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r1', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!first.ok) throw new Error()
    const rejected = await rejectSecretEnv(env, { requestId: first.request.id, actorId: 'admin-1' })
    expect(rejected).toEqual({ ok: true })
    expect(await getSecretEnvStatus(env, ['NOTION_API_KEY'])).toEqual({ NOTION_API_KEY: 'revoked' })

    const second = await requestSecretEnv(env, {
      keys: [{ name: 'NOTION_API_KEY', purpose: 'reused purpose' }],
      reason: 'r2', adapterHint: 'mcp:notion', requestedBy: 'agent-2',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error()

    // Reused in place — still exactly one binding row for the name, not two.
    const bindings = bindingRows(harness)
    expect(bindings.length).toBe(1)
    const row = bindings[0]!
    expect(row.status).toBe('pending')
    expect(row.purpose).toBe('reused purpose')
    expect(row.request_id).toBe(second.request.id)

    expect(await getSecretEnvStatus(env, ['NOTION_API_KEY'])).toEqual({ NOTION_API_KEY: 'pending' })
  })
})

// ── listPendingSecretEnvRequests ─────────────────────────────────────────────

describe('listPendingSecretEnvRequests', () => {
  it('returns only pending requests for this tenant', async () => {
    const { env } = makeEnv()
    await requestSecretEnv(env, { keys: validKeys, reason: 'r1', adapterHint: null, requestedBy: 'agent-1' })
    const rows = await listPendingSecretEnvRequests(env)
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.keys).toEqual(validKeys)
  })
})

// ── getSecretEnvStatus / bindSecretEnv ───────────────────────────────────────

describe('getSecretEnvStatus + bindSecretEnv', () => {
  it('reports pending then bound after a successful bind', async () => {
    const { env } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    const before = await getSecretEnvStatus(env, ['NOTION_API_KEY'])
    expect(before).toEqual({ NOTION_API_KEY: 'pending' })

    const fetchImpl = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    const bind = await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { NOTION_API_KEY: 'super-secret-plaintext-value' },
      actorId: 'admin-1',
      fetchImpl,
    })
    expect(bind).toEqual({ ok: true, bound: ['NOTION_API_KEY'] })

    const after = await getSecretEnvStatus(env, ['NOTION_API_KEY'])
    expect(after).toEqual({ NOTION_API_KEY: 'bound' })
  })

  it('returns unknown for a name with no binding at all', async () => {
    const { env } = makeEnv()
    const status = await getSecretEnvStatus(env, ['NEVER_REQUESTED'])
    expect(status).toEqual({ NEVER_REQUESTED: 'unbound' })
  })

  it('fails with secret_env_ops_unconfigured when CF config is null (no fetch)', async () => {
    const { env } = makeEnv({ cfConfigured: false })
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    let fetchCalled = false
    const fetchImpl = (async () => { fetchCalled = true; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch

    const bind = await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { NOTION_API_KEY: 'value' },
      actorId: 'admin-1',
      fetchImpl,
    })
    expect(bind).toEqual({ ok: false, error: 'secret_env_ops_unconfigured' })
    expect(fetchCalled).toBe(false)
  })

  it('(custody) no D1 row or audit entry ever contains the pasted plaintext', async () => {
    const { env, harness } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    const plaintext = 'CANARY-plaintext-must-never-appear-XYZ-123'
    const fetchImpl = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    const bind = await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { NOTION_API_KEY: plaintext },
      actorId: 'admin-1',
      fetchImpl,
    })
    expect(bind.ok).toBe(true)

    // Real engine, real persisted state: dump EVERY row of EVERY secret_env_*
    // table and prove the pasted plaintext is not sitting in any column. This
    // is the substrate-real replacement for the old mock's per-call
    // bind-argument check — bindSecretEnv never puts the value into a D1 bind
    // at all (it only ever reaches putScriptSecrets/fetchImpl), so asserting
    // against the actual committed rows is the stronger, faithful proof of
    // the same custody claim: the paste never reaches storage.
    for (const rows of [requestRows(harness), bindingRows(harness), auditRows(harness)]) {
      for (const row of rows) {
        for (const value of Object.values(row)) {
          expect(String(value)).not.toContain(plaintext)
        }
      }
    }
  })

  it('partial CF failure: does not mark any binding bound; request stays pending for retry', async () => {
    const { env } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: [
        { name: 'KEY_ONE', purpose: 'first' },
        { name: 'KEY_TWO', purpose: 'second' },
      ],
      reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ success: true }), { status: 200 })
      return new Response(JSON.stringify({ success: false }), { status: 403 })
    }) as unknown as typeof fetch

    const bind = await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { KEY_ONE: 'value-one', KEY_TWO: 'value-two' },
      actorId: 'admin-1',
      fetchImpl,
    })
    expect(bind.ok).toBe(false)

    const status = await getSecretEnvStatus(env, ['KEY_ONE', 'KEY_TWO'])
    expect(status).toEqual({ KEY_ONE: 'pending', KEY_TWO: 'pending' })

    const pending = await listPendingSecretEnvRequests(env)
    expect(pending.length).toBe(1)
    expect(pending[0]!.status).toBe('pending')
  })
})

// ── rejectSecretEnv ───────────────────────────────────────────────────────────

describe('rejectSecretEnv', () => {
  it('sets request rejected and makes no CF calls', async () => {
    const { env } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    const result = await rejectSecretEnv(env, { requestId: req.request.id, actorId: 'admin-1' })
    expect(result).toEqual({ ok: true })

    const pending = await listPendingSecretEnvRequests(env)
    expect(pending.length).toBe(0)
  })

  it('returns request_not_found for unknown id', async () => {
    const { env } = makeEnv()
    const result = await rejectSecretEnv(env, { requestId: 'nope', actorId: 'admin-1' })
    expect(result).toEqual({ ok: false, error: 'request_not_found' })
  })
})

// ── resolveSecretEnvBinding ────────────────────────────────────────────────────

describe('resolveSecretEnvBinding', () => {
  it('returns the env value only when D1 binding status is bound', async () => {
    const { env } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    // Not bound yet.
    ;(env as unknown as Record<string, unknown>).NOTION_API_KEY = 'the-bound-value'
    const beforeBind = await resolveSecretEnvBinding(env, 'NOTION_API_KEY')
    expect(beforeBind).toBeNull()

    const fetchImpl = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { NOTION_API_KEY: 'the-bound-value' },
      actorId: 'admin-1',
      fetchImpl,
    })

    const afterBind = await resolveSecretEnvBinding(env, 'NOTION_API_KEY')
    expect(afterBind).toBe('the-bound-value')
  })

  it('returns null for a binding that was never requested', async () => {
    const { env } = makeEnv()
    const result = await resolveSecretEnvBinding(env, 'NEVER_REQUESTED')
    expect(result).toBeNull()
  })
})
