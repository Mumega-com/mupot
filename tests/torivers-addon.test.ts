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
    expect(resAuth.status).toBe(200)
    const json = await resAuth.json()
    expect(json.ok).toBe(true)
    expect(json.workflowId).toBe('auto_seo_audit')
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
