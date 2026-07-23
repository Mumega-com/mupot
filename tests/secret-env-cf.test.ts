import { describe, it, expect, vi } from 'vitest'
import { getSecretEnvCfConfig, putScriptSecrets } from '../src/secret-env/cf-secrets'
import type { Env } from '../src/types'

describe('secret-env CF client', () => {
  it('returns null when bootstrap incomplete', () => {
    expect(getSecretEnvCfConfig({ TENANT_SLUG: 't' } as Env)).toBeNull()
  })

  it('PUTs secret_text bindings and never returns values', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    const config = {
      accountId: 'acct',
      scriptName: 'mupot-t',
      apiToken: 'tok',
    }
    const result = await putScriptSecrets(
      config,
      [{ name: 'NOTION_API_KEY', text: 'super-secret' }],
      fetchImpl as unknown as typeof fetch,
    )
    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('/accounts/acct/workers/scripts/mupot-t/secrets')
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ name: 'NOTION_API_KEY', text: 'super-secret', type: 'secret_text' })
    expect(JSON.stringify(result)).not.toContain('super-secret')
  })

  it('surfaces CF failure without echoing secret', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 403 }),
    )
    const result = await putScriptSecrets(
      { accountId: 'a', scriptName: 's', apiToken: 't' },
      [{ name: 'X_KEY', text: 'leak-me' }],
      fetchImpl as unknown as typeof fetch,
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('leak-me')
  })
})
