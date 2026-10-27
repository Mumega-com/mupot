import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {}, BackupWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({ OAuthProvider: class {} }))

const { app } = await import('../src/index')

it('does not reference the Mirror module, even under a new mount prefix', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const references: string[] = []
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && /^\.\/addons\/mirror(?:[./]|$)/.test(node.text)) {
      references.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(references).toEqual([])
})

const variants = [
  '/API/MIRROR', '/api/MiRrOr/search', '/API/ADDONS/MIRROR/memory',
  '/api/mirror/', '/api/addons/mirror/',
  '/api/mirror%2Fsearch', '/api/addons/mirror%2fmemory',
  '/api%2Fmirror/search', '/api%2faddons%2Fmirror',
  '/%61pi/%6Dirror/search', '/api/addons/%4Dirror/search',
  '/api/mirror;v=1', '/api/mirror;v=1/search',
  '/api;v=1/addons;v=2/mirror;v=3/search',
  '/api/addons/mirror%3bv=1%2fsearch',
  '//api/mirror', '/api//mirror/search', '/api/addons//mirror//memory',
  '//API;%76=1//ADDONS%2f%4dIRROR%3bversion=1%2Fsearch',
  '/api/mirror/%zz', '/api/mirror%2F%E0%A4%A',
] as const

describe('retired Mirror namespace variants', () => {
  describe.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s', (method) => {
    it.each(variants)('returns 404 for %s before auth or catch-all', async (path) => {
      const response = await app.request(`https://pot.test${path}`, { method }, { TENANT_SLUG: 'test' } as Env)
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
      if (method !== 'HEAD') expect(await response.text()).toBe('404 Not Found')
    })
  })

  it.each(['/api/addons/mirror-like', '/api/addons/mirrors'])('preserves addon auth for %s', async (path) => {
    const response = await app.request(`https://pot.test${path}`, {}, { TENANT_SLUG: 'test' } as Env)
    expect(response.status).toBe(401)
  })

  it.each(['/api/inkwell/health', '/api/sos/health', '/api/torivers/health'])('preserves live %s', async (path) => {
    const response = await app.request(`https://pot.test${path}`, {}, {} as Env)
    expect(response.status).toBe(200)
  })
})

const requests = [
  ['GET', ''],
  ['POST', ''],
  ['GET', '/search'],
  ['POST', '/search'],
  ['GET', '/health'],
  ['POST', '/rrf-search'],
  ['POST', '/engrams'],
  ['POST', '/memory/store'],
  ['POST', '/memory/search'],
  ['POST', '/memory/forget'],
  ['DELETE', '/memory/forget'],
  ['DELETE', '/memory/entry-1'],
  ['GET', '/memory/entry-1'],
  ['GET', '/memory'],
] as const

describe.each(['MIRROR_SECRET', 'MIRROR_TOKEN'] as const)('unmounted Mirror with %s configured', (binding) => {
  describe.each(['/api/mirror', '/api/addons/mirror'])('%s', (prefix) => {
    it.each(requests)('returns 404 for %s %s', async (method, suffix) => {
      const env = { [binding]: 'mirror-route-test', TENANT_SLUG: 'test' } as Env
      const response = await app.request(`https://pot.test${prefix}${suffix}`, {
        method,
        headers: {
          authorization: 'Bearer mirror-route-test',
          'x-mirror-secret': 'mirror-route-test',
          'content-type': 'application/json',
          origin: 'https://pot.test',
        },
        ...(method === 'POST' ? { body: JSON.stringify({ query: 'test', text: 'test', id: 'entry-1' }) } : {}),
      }, env)

      expect(response.status).toBe(404)
      expect(await response.text()).toBe('404 Not Found')
    })
  })
})
