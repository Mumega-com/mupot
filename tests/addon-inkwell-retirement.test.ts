import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { inkwellApp } from '../src/addons/inkwell'
import type { Env } from '../src/types'

const prefixes = ['/api/inkwell', '/api/addons/inkwell']
const retired = ['/publish', '/internal-content', '/draft']
const paths = prefixes.flatMap((prefix) => [
  '', '/', ...retired.flatMap((route) => [route, `${route}/`, `${route}/nested`]),
  '/publications', '/health/', '/health/nested', '/unknown',
].map((route) => `${prefix}${route}`))
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE', 'TRACK', 'PROPFIND']
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)

// Execute the actual top-level Inkwell registrations from index.ts, rather than
// maintaining a second copy of the route guards. Full entry is covered in workerd.
const statements = file.statements.filter((statement) => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
  const call = statement.expression
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.expression.getText(file) === 'app'
    && ['on', 'route'].includes(call.expression.name.text)
    && (call.arguments[1]?.getText(file) === 'inkwellApp' || call.arguments[1]?.getText(file).includes("'/api/inkwell"))
})

function router() {
  const app = new Hono<{ Bindings: Env }>()
  const registrations = ts.transpileModule(statements.map((statement) => statement.getText(file)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
  new Function('app', 'inkwellApp', registrations)(app, inkwellApp)
  // A later wildcard must never receive a retired request.
  app.all('*', (c) => c.text('catch-all reached', 418))
  return app
}

describe('retired Inkwell addon writes', () => {
  it('has no write handler and registers all-method 404s before either mount and the dashboard', () => {
    expect(inkwellApp.routes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/health' },
    ])
    const guard = statements.find((statement) => statement.getText(file).startsWith('app.on('))
    expect(guard).toBeDefined()
    const call = (guard as ts.ExpressionStatement).expression as ts.CallExpression
    expect((call.arguments[0] as ts.StringLiteral).text).toBe('ALL')
    const registered = call.arguments[1] as ts.ArrayLiteralExpression
    expect(registered.elements.map((element) => (element as ts.StringLiteral).text).sort()).toEqual(prefixes.flatMap((prefix) => [prefix, `${prefix}/*`]).sort())
    for (const mount of statements.filter((statement) => statement !== guard)) {
      expect(guard!.pos).toBeLessThan(mount.pos)
    }
    expect(guard!.pos).toBeLessThan(source.indexOf('app.route(ROUTES.dashboard, dashboardApp)'))
    expect(readFileSync(new URL('../src/addons/inkwell.ts', import.meta.url), 'utf8')).not.toMatch(/handlePublishing|\/api\/publish|INKWELL_PUBLISH_TOKEN/)
  })

  it('keeps the entire addon module health-only, including sibling apps and mounts', () => {
    const addon = ts.createSourceFile('inkwell.ts', readFileSync(new URL('../src/addons/inkwell.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const registrations: string[] = []
    const constructors: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) constructors.push(node.expression.getText(addon))
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'on', 'use', 'route', 'mount'].includes(node.expression.name.text)) {
        registrations.push(`${node.expression.getText(addon)}(${node.arguments[0]?.getText(addon)})`)
      }
      ts.forEachChild(node, visit)
    }
    visit(addon)
    expect(constructors).toEqual(['Hono'])
    expect(registrations).toEqual(["inkwellApp.get('/health')"])
  })

  it('keeps retired publishing names out of Env and the reviewed bindings', () => {
    for (const path of ['../src/types.ts', '../src/secret-env/env-reviewed-names.ts']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toMatch(/\bINKWELL_(?:SECRET|TOKEN|API_TOKEN)\b/)
    }
  })

  it('documents Inkwell token comparisons as historical after retirement', () => {
    expect(readFileSync(new URL('../.jules/sentinel.md', import.meta.url), 'utf8')).toContain('Inkwell addon is now health-only; its publishing routes and shared-secret middleware have been retired.')
  })

  describe.each(paths)('%s', (path) => {
    it.each(methods)('%s returns 404 with all legacy settings present and never fetches', async (method) => {
      const fetcher = vi.fn()
      const env = {
        INKWELL_SECRET: 'test-addon-credential', INKWELL_TOKEN: 'test-addon-credential',
        INKWELL_API_TOKEN: 'test-addon-credential', INKWELL_PUBLISH_TOKEN: 'test-retired-credential',
        INKWELL_API_URL: 'https://inkwell.test', INKWELL_SVC: { fetch: fetcher },
      } as unknown as Env
      // Fetch forbids constructing CONNECT/TRACE/TRACK; override only the method
      // to exercise Hono's dispatch for those methods as well.
      const request = new Request(`https://pot.test${path}`, {
        method: 'POST', headers: { authorization: 'Bearer test-addon-credential', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Title', slug: 'slug', content: 'Content' }),
      })
      Object.defineProperty(request, 'method', { value: method })
      const response = await router().fetch(request, env)
      expect(response.status).toBe(404)
      expect(fetcher).not.toHaveBeenCalled()
    })
  })

  it.each(prefixes)('%s/health remains available without credentials', async (prefix) => {
    const response = await router().request(`${prefix}/health`, {}, {} as Env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, addon: 'inkwell' })
    expect((await router().request(`${prefix}/health`, { method: 'HEAD' }, {} as Env)).status).toBe(200)
    expect((await router().request(`${prefix}/health`, { method: 'POST' }, {} as Env)).status).toBe(404)
  })
})
