// The presence route inventory is deliberately route-shaped, rather than a list
// of files.  A file can contain several mutations, including reductions which
// must stay easy to perform.  Each row names the one HTTP writer that expands a
// principal or channel's reach.  This makes adding a new writer a conscious
// policy decision, and makes removing its chokepoint fail CI.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { dashboardApp } from '../src/dashboard/index'
import { tasksApp, gatesApp } from '../src/tasks/index'
import { membersApp } from '../src/members/index'
import { orgApp } from '../src/org/index'
import { authApp } from '../src/auth/index'
import { channelsAdminApp } from '../src/channels/admin'
import { seatEventsApp } from '../src/agents/seat-events-routes'
import { approveApp } from '../src/access/routes'
import { Hono } from 'hono'
import { ROUTES } from '../src/types'

type Router = { routes: Array<{ method: string; path: string }> }
type Route = {
  method: 'POST'
  /** Mounted path, not the local path passed to Hono. */
  path: string
  source: string
  /** Name of the local Hono receiver used in the source registration. */
  receiver: string
  localPath: string
  kind: string
  router: Router
}
const POST = { method: 'POST' as const }

const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8')

// This is the complete widening-writer inventory.  It is intentionally
// explicit: do not replace it with a file allowlist.  Reducing routes (revoke,
// detach, reject, clear) are absent because presence must never make it harder
// to take authority away.
const WIDENING_WRITERS = ([
  { path: '/claim/:code', source: 'dashboard/claim.ts', receiver: 'app', localPath: '/claim/:code', kind: 'claim_confirm', router: dashboardApp },
  { path: '/agents/:id/claim', source: 'dashboard/claim.ts', receiver: 'app', localPath: '/agents/:id/claim', kind: 'claim_own', router: dashboardApp },
  { path: '/connections/attach', source: 'dashboard/connections.ts', receiver: 'app', localPath: '/connections/attach', kind: 'seat_attach', router: dashboardApp },
  { path: '/connections/seats/:id/:action{hold|release|return}', source: 'dashboard/connections.ts', receiver: 'app', localPath: '/connections/seats/:id/:action{hold|release|return}', kind: 'seat_release', router: dashboardApp },
  { path: '/connections/seats/:id/:action{hold|release|return}', source: 'dashboard/connections.ts', receiver: 'app', localPath: '/connections/seats/:id/:action{hold|release|return}', kind: 'seat_return_from_held', router: dashboardApp },
  { path: '/agents/:id/designation', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/agents/:id/designation', kind: 'designation_allow', router: dashboardApp },
  { path: '/agents/:id/owner', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/agents/:id/owner', kind: 'agent_owner_set', router: dashboardApp },
  { path: '/agents/:id/access', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/agents/:id/access', kind: 'agent_access_set', router: dashboardApp },
  { path: '/squads/:id/agents/join', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/squads/:id/agents/join', kind: 'squad_agent_join', router: dashboardApp },
  { path: '/operators/delegate', source: 'dashboard/operators.ts', receiver: 'app', localPath: '/operators/delegate', kind: 'operator_delegate', router: dashboardApp },
  { path: '/admin/agent-token/mint', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/admin/agent-token/mint', kind: 'agent_token_mint', router: dashboardApp },
  { path: '/admin/keys/mint', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/admin/keys/mint', kind: 'scoped_key_mint', router: dashboardApp },
  { path: '/enroll/mint', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/enroll/mint', kind: 'seat_key_mint', router: dashboardApp },
  { path: '/members/:id/tokens', source: 'dashboard/index.ts', receiver: 'dashboardApp', localPath: '/members/:id/tokens', kind: 'member_token_mint', router: dashboardApp },
  { path: '/api/members/members/:id/tokens', source: 'members/index.ts', receiver: 'membersApp', localPath: '/members/:id/tokens', kind: 'member_token_mint', router: membersApp },
  { path: '/api/members/members/:id/capabilities', source: 'members/index.ts', receiver: 'membersApp', localPath: '/members/:id/capabilities', kind: 'member_capability_grant', router: membersApp },
  { path: '/api/members/invites', source: 'members/index.ts', receiver: 'membersApp', localPath: '/invites', kind: 'telegram_bind', router: membersApp },
  { path: '/auth/elevation/requests/:id/decide', source: 'auth/index.ts', receiver: 'authApp', localPath: '/elevation/requests/:id/decide', kind: 'elevation_approve', router: authApp },
  { path: '/auth/link-signin/:id/unlink', source: 'auth/index.ts', receiver: 'authApp', localPath: '/link-signin/:id/unlink', kind: 'login_identity_revoke', router: authApp },
  { path: '/auth/identities/:id/revoke', source: 'auth/index.ts', receiver: 'authApp', localPath: '/identities/:id/revoke', kind: 'login_identity_revoke', router: authApp },
  { path: '/api/tasks/:id/verdict', source: 'tasks/index.ts', receiver: 'tasksApp', localPath: '/:id/verdict', kind: 'task_verdict_approve', router: tasksApp },
  { path: '/api/gates/grants', source: 'tasks/index.ts', receiver: 'gatesApp', localPath: '/grants', kind: 'gate_grant', router: gatesApp },
  { path: '/account/passkey/enrol', source: 'dashboard/account.ts', receiver: 'app', localPath: '/account/passkey/enrol', kind: 'passkey_enrol', router: dashboardApp },
  { path: '/account/passkey/:id/revoke', source: 'dashboard/account.ts', receiver: 'app', localPath: '/account/passkey/:id/revoke', kind: 'passkey_revoke', router: dashboardApp },
  { path: '/account/telegram-device/enrol', source: 'dashboard/account.ts', receiver: 'app', localPath: '/account/telegram-device/enrol', kind: 'telegram_device_enrol', router: dashboardApp },
  { path: '/account/telegram-device/:id/window', source: 'dashboard/account.ts', receiver: 'app', localPath: '/account/telegram-device/:id/window', kind: 'telegram_device_window', router: dashboardApp },
  { path: '/api/org/agents/:id/memberships', source: 'org/index.ts', receiver: 'orgApp', localPath: '/agents/:id/memberships', kind: 'agent_membership_grant', router: orgApp },
  { path: '/api/channels/bindings', source: 'channels/admin.ts', receiver: 'channelsAdminApp', localPath: '/bindings', kind: 'channel_binding', router: channelsAdminApp },
  { path: '/api/fleet/events/grants', source: 'agents/seat-events-routes.ts', receiver: 'seatEventsApp', localPath: '/grants', kind: 'seat_event_grant', router: seatEventsApp },
  { path: '/setup/im', source: 'dashboard/wizard.ts', receiver: 'wizardApp', localPath: '/im', kind: 'im_settings_set', router: dashboardApp },
  { path: '/admin/im-settings', source: 'dashboard/im-settings.ts', receiver: 'app', localPath: '/admin/im-settings', kind: 'im_settings_set', router: dashboardApp },
  { path: '/approve/seed/:id', source: 'access/routes.ts', receiver: 'approveApp', localPath: '/seed/:id', kind: 'access_seed_approve', router: approveApp },
  { path: '/approve/elevation/:id', source: 'access/routes.ts', receiver: 'approveApp', localPath: '/elevation/:id', kind: 'access_elevation_approve', router: approveApp },
] as const).map((route): Route => ({ ...POST, ...route }))

// OAuth consent is a raw Request handler, not a Hono router.  Keeping it here
// prevents that exceptional door from becoming an untested exception to the
// route inventory.
const RAW_WIDENING_WRITERS = [
  { source: 'mcp/oauth-authorize.ts', selector: "url.pathname === '/oauth/consent'", kind: 'oauth_consent' },
] as const

type ParsedRoute = { method: string; receiver: string; path: string; body: string; gateKinds: string[]; sensitive: boolean }
const HTTP_METHODS = new Set(['post', 'put', 'patch', 'delete'])
const GATES = new Set(['presenceGate', 'presenceGateJson', 'presenceFor'])
const WRITERS = new Set(['mintMemberToken', 'mintAgentBoundToken', 'mintHarnessToken', 'grantGateCapability', 'setAgentSquadAccess', 'bindMemberStatement', 'createProjectInvite', 'createSeatEventGrant'])
function parsedRoutes(source: string, file = 'route.ts'): ParsedRoute[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const routes: ParsedRoute[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && HTTP_METHODS.has(node.expression.name.text)) {
      const receiver = node.expression.expression.getText(parsed)
      const first = node.arguments[0]
      const handler = node.arguments[node.arguments.length - 1]
      if (first && ts.isStringLiteralLike(first) && handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const gateKinds: string[] = []
        let sensitive = false
        const inspect = (child: ts.Node): void => {
          if (ts.isCallExpression(child)) {
            const name = ts.isIdentifier(child.expression) ? child.expression.text : ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : ''
            if (WRITERS.has(name)) sensitive = true
            if (name === 'prepare') {
              const sql = child.arguments[0]
              if (sql && (ts.isStringLiteralLike(sql) || ts.isTemplateExpression(sql))) {
                const text = sql.getText(parsed)
                if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:member_tokens|capabilities|gate_grants|channel_bindings|memberships|member_passkeys)|UPDATE\s+(?:capabilities|memberships)\s+SET\s+capability/i.test(text)) sensitive = true
              }
            }
            if (GATES.has(name)) for (const arg of child.arguments) {
              if (!ts.isObjectLiteralExpression(arg)) continue
              for (const property of arg.properties) {
                if (!ts.isPropertyAssignment(property) || property.name.getText(parsed) !== 'kind') continue
                const addKinds = (kind: ts.Node): void => {
                  if (ts.isStringLiteralLike(kind)) gateKinds.push(kind.text)
                  else if (ts.isConditionalExpression(kind)) { addKinds(kind.whenTrue); addKinds(kind.whenFalse) }
                  else ts.forEachChild(kind, addKinds)
                }
                addKinds(property.initializer)
              }
            }
          }
          ts.forEachChild(child, inspect)
        }
        inspect(handler.body)
        routes.push({ method: node.expression.name.text.toUpperCase(), receiver, path: first.text, body: handler.body.getText(parsed), gateKinds, sensitive })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return routes
}
function registeredRoute(source: string, receiver: string, path: string, method = 'POST'): ParsedRoute {
  const match = parsedRoutes(source).find((route) => route.method === method && route.receiver === receiver && route.path === path)
  expect(match, `registration ${receiver}.${method.toLowerCase()}(${path})`).toBeDefined()
  return match!
}

function normalizedRoutePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '')
}

function routerHasPost(router: Router, localPath: string): boolean {
  return router.routes.some((route) => route.method === 'POST' && normalizedRoutePath(route.path) === normalizedRoutePath(localPath))
}
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(child) : entry.isFile() && entry.name.endsWith('.ts') ? [child] : []
  })
}

// Load the real component routers using the actual root mount declarations.
// Importing src/index.ts itself requires the Workers-only cloudflare: runtime.
function mountedRouterTable(): Router {
  const routers: Record<string, Router> = { dashboardApp, tasksApp, gatesApp, membersApp, orgApp, authApp, channelsAdminApp, seatEventsApp, approveApp }
  const root = new Hono()
  const file = ts.createSourceFile('index.ts', src('index.ts'), ts.ScriptTarget.Latest, true)
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === 'app' && node.expression.name.text === 'route') {
      const [mount, router] = node.arguments
      const component = router && ts.isIdentifier(router) ? routers[router.text] : undefined
      if (component && mount) {
        const prefix = ts.isStringLiteralLike(mount) ? mount.text
          : ts.isPropertyAccessExpression(mount) && mount.expression.getText(file) === 'ROUTES'
            ? ROUTES[mount.name.text as keyof typeof ROUTES] : undefined
        expect(prefix, `unresolved root mount for ${router.getText(file)}`).toBeTypeOf('string')
        // Hono only reads the component's actual routes here, never invokes a handler.
        root.route(prefix!, component as Hono)
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(file)
  return root
}
const rootApp = mountedRouterTable()

describe('human-presence widening-writer ratchet', () => {
  it('keeps every explicitly expected HTTP widening writer in the actual Hono router and behind its route-local gate', () => {
    for (const expected of WIDENING_WRITERS) {
      expect(expected.method).toBe('POST')
      expect(routerHasPost(rootApp, expected.path), `${expected.method} ${expected.path} missing from root Hono router table`).toBe(true)
      const route = registeredRoute(src(expected.source), expected.receiver, expected.localPath, expected.method)
      expect(route.gateKinds, `${expected.path} must call the gate for its own decision`).toContain(expected.kind)
    }
  })

  it('does not allow a new gated widening decision to bypass the explicit inventory', () => {
    const inventory = new Set(WIDENING_WRITERS.map((writer) => `${writer.method}:${writer.source}:${writer.receiver}:${writer.localPath}:${writer.kind}`))
    const sourceRoot = join(__dirname, '..', 'src')
    for (const filename of sourceFiles(sourceRoot)) {
      const relative = filename.slice(sourceRoot.length + 1)
      for (const route of parsedRoutes(readFileSync(filename, 'utf8'), relative)) {
        for (const kind of route.gateKinds) {
          const key = `${route.method}:${relative}:${route.receiver}:${route.path}:${kind}`
          expect(inventory.has(key), `unlisted gated widening writer ${key}`).toBe(true)
        }
      }
    }
    for (const raw of RAW_WIDENING_WRITERS) {
      const source = src(raw.source)
      const start = source.indexOf(raw.selector)
      expect(start, `raw widening route ${raw.selector}`).toBeGreaterThanOrEqual(0)
      const block = source.slice(start, start + 18000)
      expect(block).toMatch(/presence(?:Gate(?:Json)?|Check)\s*\(/)
      expect(block).toContain(`kind: '${raw.kind}'`)
    }
  })

  it('does not allow an unlisted sensitive authority write to appear in a registered POST handler', () => {
    const listed = new Set(WIDENING_WRITERS.map((writer) => `${writer.method}:${writer.source}:${writer.receiver}:${writer.localPath}`))
    const sourceRoot = join(__dirname, '..', 'src')
    for (const filename of sourceFiles(sourceRoot)) {
      const relative = filename.slice(sourceRoot.length + 1)
      for (const route of parsedRoutes(readFileSync(filename, 'utf8'), relative)) {
        if (!route.sensitive) continue
        const key = `${route.method}:${relative}:${route.receiver}:${route.path}`
        expect(listed.has(key), `unlisted sensitive widening writer ${key}`).toBe(true)
        expect(route.gateKinds.length, `${key} needs presence before its sensitive write`).toBeGreaterThan(0)
      }
    }
  })
  it('recognizes an unlisted write even with no gate, and ignores a gate mentioned only in a comment', () => {
    const routes = parsedRoutes(`app.patch('/new-authority', async (c) => {
      // presenceGateJson(c, member, { kind: 'member_token_mint' })
      return mintMemberToken(c.env, member, label, channel)
    })`)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ method: 'PATCH', path: '/new-authority', sensitive: true, gateKinds: [] })
  })

})
