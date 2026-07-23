// Tests for the secret-env service (request / status / bind / reject / resolve).
//
// Custody invariant under test throughout: third-party secret VALUES must never
// appear in any D1 SQL bind argument or audit `detail` string. Only binding
// NAMES, purposes, reasons, and actor ids may touch D1.

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

// ── DB mock ───────────────────────────────────────────────────────────────────

interface CallRecord { sql: string; binds: unknown[] }

/** Minimal in-memory store for secret_env_requests / bindings / audit, patterned
 * on tests/connectors.test.ts. SQL matching is by distinctive substrings that
 * correspond 1:1 to the literal SQL written in src/secret-env/service.ts. */
function makeEnv(opts: {
  tenant?: string
  cfConfigured?: boolean
} = {}): {
  env: Env
  calls: CallRecord[]
  requests: Map<string, Record<string, unknown>>
  bindings: Map<string, Record<string, unknown>>
  audit: Record<string, unknown>[]
} {
  const tenant = opts.tenant ?? 'test-tenant'
  const cfConfigured = opts.cfConfigured ?? true
  const calls: CallRecord[] = []

  const requests = new Map<string, Record<string, unknown>>()
  const bindings = new Map<string, Record<string, unknown>>()
  const audit: Record<string, unknown>[] = []

  const envBase: Record<string, unknown> = { TENANT_SLUG: tenant }
  if (cfConfigured) {
    envBase.SECRET_ENV_CF_ACCOUNT_ID = 'acct'
    envBase.SECRET_ENV_CF_SCRIPT_NAME = 'mupot-t'
    envBase.SECRET_ENV_CF_API_TOKEN = 'ops-tok'
  }

  envBase.DB = {
    prepare(sql: string) {
      const call: CallRecord = { sql, binds: [] }
      calls.push(call)
      const sNorm = sql.replace(/\s+/g, ' ').trim().toUpperCase()
      const stmt = {
        bind(...args: unknown[]) { call.binds = args; return stmt },
        async run() {
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_REQUESTS')) {
            const [id, ten, reason, schemaJson, requestedBy, createdAt] = call.binds
            requests.set(id as string, {
              id, tenant: ten, reason, schema_json: schemaJson, status: 'pending',
              requested_by: requestedBy, decided_by: null, created_at: createdAt, decided_at: null,
            })
            return { meta: { changes: 1 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'APPROVED'")) {
            const [actorId, decidedAt, requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) {
              row.status = 'approved'; row.decided_by = actorId; row.decided_at = decidedAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'REJECTED'")) {
            const [actorId, decidedAt, requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) {
              row.status = 'rejected'; row.decided_by = actorId; row.decided_at = decidedAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_BINDINGS')) {
            const [id, ten, bindingName, purpose, adapterHint, requestedBy, requestId, createdAt] = call.binds
            bindings.set(id as string, {
              id, tenant: ten, binding_name: bindingName, purpose, adapter_hint: adapterHint,
              status: 'pending', requested_by: requestedBy, bound_by: null, request_id: requestId,
              created_at: createdAt, bound_at: null, revoked_at: null,
            })
            return { meta: { changes: 1 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_BINDINGS') && sNorm.includes("STATUS = 'BOUND'")) {
            const [actorId, boundAt, bindingId, ten] = call.binds
            const row = bindings.get(bindingId as string)
            if (row && row.tenant === ten) {
              row.status = 'bound'; row.bound_by = actorId; row.bound_at = boundAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_BINDINGS') && sNorm.includes("STATUS = 'REVOKED'")) {
            const [revokedAt, ten, requestId] = call.binds
            let changes = 0
            for (const row of bindings.values()) {
              if (row.tenant === ten && row.request_id === requestId && row.status === 'pending') {
                row.status = 'revoked'; row.revoked_at = revokedAt
                changes += 1
              }
            }
            return { meta: { changes } }
          }
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_AUDIT')) {
            const [id, ten, requestId, bindingName, action, actorId, detail, recordedAt] = call.binds
            audit.push({ id, tenant: ten, request_id: requestId, binding_name: bindingName, action, actor_id: actorId, detail, recorded_at: recordedAt })
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
        async first<T>(): Promise<T | null> {
          if (sNorm.includes('SELECT STATUS FROM SECRET_ENV_BINDINGS')) {
            const [ten, bindingName] = call.binds
            for (const row of bindings.values()) {
              if (row.tenant === ten && row.binding_name === bindingName) {
                return { status: row.status } as unknown as T
              }
            }
            return null
          }
          if (sNorm.includes('FROM SECRET_ENV_REQUESTS') && sNorm.includes('LIMIT 1')) {
            const [requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) return row as unknown as T
            return null
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sNorm.includes('FROM SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'PENDING'")) {
            const [ten] = call.binds
            const rows = [...requests.values()].filter((r) => r.tenant === ten && r.status === 'pending')
            return { results: rows as unknown as T[] }
          }
          if (sNorm.includes('FROM SECRET_ENV_BINDINGS') && sNorm.includes('REQUEST_ID') && sNorm.includes("STATUS = 'PENDING'")) {
            const [ten, requestId] = call.binds
            const rows = [...bindings.values()].filter((r) => r.tenant === ten && r.request_id === requestId && r.status === 'pending')
            return { results: rows as unknown as T[] }
          }
          return { results: [] }
        },
      }
      return stmt
    },
  }

  return { env: envBase as unknown as Env, calls, requests, bindings, audit }
}

const validKeys = [
  { name: 'NOTION_API_KEY', purpose: 'Read/write Notion pages for the agent' },
]

// ── requestSecretEnv ──────────────────────────────────────────────────────────

describe('requestSecretEnv', () => {
  it('inserts request + pending bindings + request audit', async () => {
    const { env, requests, bindings, audit } = makeEnv()
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

    expect(requests.size).toBe(1)
    expect(bindings.size).toBe(1)
    const bindingRow = [...bindings.values()][0]!
    expect(bindingRow.binding_name).toBe('NOTION_API_KEY')
    expect(bindingRow.status).toBe('pending')

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

  it('(custody) no D1 bind argument or audit detail ever contains the pasted plaintext', async () => {
    const { env, calls, audit } = makeEnv()
    const req = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!req.ok) throw new Error()

    const plaintext = 'sk-super-secret-plaintext-XYZ-123'
    const fetchImpl = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    const bind = await bindSecretEnv(env, {
      requestId: req.request.id,
      values: { NOTION_API_KEY: plaintext },
      actorId: 'admin-1',
      fetchImpl,
    })
    expect(bind.ok).toBe(true)

    for (const call of calls) {
      for (const arg of call.binds) {
        expect(String(arg)).not.toContain(plaintext)
      }
    }
    for (const entry of audit) {
      expect(String(entry.detail)).not.toContain(plaintext)
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
