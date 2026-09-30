// The decision port's config names must not be requestable through secret_env_request:
// secret-env can write bindings onto the worker itself, so an unreserved config name
// (e.g. DECISION_ADAPTER) could be flipped through an admin approval.
import { afterEach, describe, expect, it } from 'vitest'
import { requestSecretEnv } from '../src/secret-env/service'
import { ENV_REVIEWED_BINDING_NAMES } from '../src/secret-env/env-reviewed-names'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const NAMES = ['DECISION_ADAPTER', 'DECISION_GATEWAY_ID', 'TYPESAFE_API_KEY']
const harnesses: SqliteD1Harness[] = []
afterEach(() => { while (harnesses.length) harnesses.pop()?.close() })

describe('decision port env names are reserved', () => {
  it.each(NAMES)('%s is in the reviewed list', (name) => {
    expect(ENV_REVIEWED_BINDING_NAMES.has(name)).toBe(true)
  })
  it.each(NAMES)('secret_env_request for %s returns reserved_binding_name', async (name) => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harnesses.push(harness)
    // Test double: requestSecretEnv reads only these fields (same shape as secret-env-service.test.ts).
    const env = { TENANT_SLUG: 't', DB: harness.db } as unknown as Env
    const result = await requestSecretEnv(env, {
      keys: [{ name, purpose: 'flip decision config' }],
      reason: 'test',
      adapterHint: null,
      requestedBy: 'agent-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toBe('reserved_binding_name')
  })
})
