import { describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const prefixes = ['/api/inkwell', '/api/addons/inkwell']
const paths = prefixes.flatMap((prefix) => ['', '/', '/publish', '/publish/', '/publish/nested', '/internal-content', '/internal-content/', '/draft', '/draft/', '/publications', '/health/', '/health/nested', '/unknown'].map((route) => `${prefix}${route}`))
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND']

describe('Inkwell retirement through the worker entry', () => {
  it.each(paths)('%s returns 404 for every method without reaching services or auth storage', async (path) => {
    const fetcher = vi.fn(() => { throw new Error('unexpected Inkwell request') })
    const env = {
      TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test',
      INKWELL_SECRET: 'test-addon-credential', INKWELL_TOKEN: 'test-addon-credential',
      INKWELL_API_TOKEN: 'test-addon-credential', INKWELL_PUBLISH_TOKEN: 'test-retired-credential',
      INKWELL_API_URL: 'https://inkwell.test', INKWELL_SVC: { fetch: fetcher },
    } as unknown as Env
    for (const method of methods) {
      const response = await worker.fetch(new Request(`https://pot.test${path}`, {
        method, headers: { authorization: 'Bearer test-addon-credential' },
      }), env, ctx)
      expect(response.status, method).toBe(404)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(prefixes)('%s/health remains available without credentials', async (prefix) => {
    const response = await worker.fetch(new Request(`https://pot.test${prefix}/health`), {
      TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test',
    } as Env, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, addon: 'inkwell' })
    for (const [method, status] of [['HEAD', 200], ['POST', 404]] as const) {
      const result = await worker.fetch(new Request(`https://pot.test${prefix}/health`, { method }), {
        TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test',
      } as Env, ctx)
      expect(result.status, method).toBe(status)
    }
  })
})
