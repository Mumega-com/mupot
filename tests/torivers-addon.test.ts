import { describe, expect, it } from 'vitest'
import { toriversAddonApp } from '../src/addons/torivers'

describe('ToRivers v2 Deterministic Automation Addon Suite (@mumega/addon-torivers)', () => {
  const mockEnv = {
    TENANT_SLUG: 'mumega.com',
    TORIVERS_SECRET: 'test-torivers-secret-123',
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
        }),
      }),
    },
  } as any

  it('1) GET /health returns 200 OK with addon metadata', async () => {
    const res = await toriversAddonApp.request('/health', {}, mockEnv)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.addon).toBe('@mumega/addon-torivers')
  })

  it('2) GET /marketplace/automations returns catalog', async () => {
    const res = await toriversAddonApp.request('/marketplace/automations', {}, mockEnv)
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
      mockEnv
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
      mockEnv
    )
    expect(resAuth.status).toBe(200)
    const json = await resAuth.json()
    expect(json.ok).toBe(true)
    expect(json.workflowId).toBe('auto_seo_audit')
    expect(json.receipt.stepsExecuted).toBe(3)
  })

  it('4) POST /credentials/match matches required scopes', async () => {
    const res = await toriversAddonApp.request(
      '/credentials/match',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torivers-Secret': 'test-torivers-secret-123',
        },
        body: JSON.stringify({ requiredScopes: ['google.sheets', 'github.repo'] }),
      },
      mockEnv
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.allSatisfied).toBe(true)
    expect(json.matches.length).toBe(2)
  })

  it('5) Returns HTTP 400 on missing workflowId', async () => {
    const res = await toriversAddonApp.request(
      '/workflows/execute',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torivers-Secret': 'test-torivers-secret-123',
        },
        body: JSON.stringify({}),
      },
      mockEnv
    )
    expect(res.status).toBe(400)
  })
})
