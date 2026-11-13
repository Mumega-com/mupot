// tests/boundary/http-sweep.test.ts — the HTTP twins of the MCP sweep. Every GET route the web, dashboard
// and API apps register is requested as a caller with no standing on customer B, with B's ids put into every
// path parameter. Nothing customer B owns may appear in any response, and B's rows may not change.
//
// Routes are enumerated from the mounted Hono apps (app.routes), so a route added tomorrow is swept the day
// it is mounted. Credentials: a bearer API key (agent-bound, human, no grants, stranger) and a real web
// session cookie (signed in by the email one-time-code door). Streaming routes are opened, never drained.
// Mounted: the same sub-apps src/index.ts mounts, minus those that cannot load outside workerd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { orgApp } from '../../src/org'
import { agentsApp } from '../../src/agents'
import { tasksApp, gatesApp } from '../../src/tasks'
import { projectsApp } from '../../src/projects'
import { membersApp } from '../../src/members'
import { flightsApp } from '../../src/flight/routes'
import { inboxApp } from '../../src/agents/inbox-routes'
import { coordinationApp } from '../../src/coordination/routes'
import { studioApp } from '../../src/dashboard/studio'
import { studioDataApp } from '../../src/dashboard/studio-data-api'
import { radarApp } from '../../src/dashboard/radar-routes'
import { orientApp } from '../../src/orient/routes'
import { routinesApp } from '../../src/routines/routes'
import { attentionApp } from '../../src/attention/routes'
import { alertsApp } from '../../src/alerts/routes'
import { loopsApp } from '../../src/loops/routes'
import { routerApp } from '../../src/router/routes'
import { fleetControlApp } from '../../src/fleet/control-routes'
import { channelsAdminApp } from '../../src/channels/admin'
import { presenceApp } from '../../src/registry/presence-routes'
import { projectLinkApp } from '../../src/addons/project-link/routes'
import { addonsApp } from '../../src/addons/routes'
import { dashboardApp } from '../../src/dashboard'
import type { Env } from '../../src/types'
import { B_SECRET, B_SUPABASE_HOST, B_SUPABASE_KEY, RAW, RAW_STRANGER, bootstrapStranger, buildBoundary, snapshotB, type Boundary } from './fixture'

function mountAll(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>()
  a.route('/api/org', orgApp)
  a.route('/api/agents', agentsApp)
  a.route('/api/tasks', tasksApp)
  a.route('/api/gates', gatesApp)
  a.route('/api/projects', projectsApp)
  a.route('/api/members', membersApp)
  a.route('/api/flights', flightsApp)
  a.route('/api/inbox', inboxApp)
  a.route('/api/coordination', coordinationApp)
  a.route('/api/studio/database', studioDataApp)
  a.route('/api/studio', studioApp)
  a.route('/api/radar', radarApp)
  a.route('/api/orient', orientApp)
  a.route('/api', routinesApp)
  a.route('/api', attentionApp)
  a.route('/api/alerts', alertsApp)
  a.route('/api/loops', loopsApp)
  a.route('/api/router', routerApp)
  a.route('/api/fleet', fleetControlApp)
  a.route('/api/channels', channelsAdminApp)
  a.route('/api/presence', presenceApp)
  a.route('/api/project-links', projectLinkApp)
  a.route('/api/addons', addonsApp)
  a.route('/', dashboardApp)
  return a
}

const ID_FOR: Array<[RegExp, string]> = [
  [/task/i, 't-b'], [/project/i, 'p-b'], [/squad/i, 'sq-b'], [/agent/i, 'ag-b'], [/flight/i, 'f-b'],
  [/msg|message/i, 'msg-b'], [/member|user|principal/i, 'mem-b-human'], [/dep/i, 'dept-b'],
]
const ANY_ID = ['t-b', 'p-b', 'sq-b', 'ag-b', 'f-b', 'msg-b', 'mem-b-human', 'dept-b']

/** Every concrete GET path a route pattern can be asked at, with B's ids in each parameter. */
function concretePaths(pattern: string): string[] {
  const names = [...pattern.matchAll(/:([A-Za-z_]+)(?:\{[^}]*\})?\??/g)].map((m) => m[1])
  const fill = (id: (n: string) => string): string =>
    pattern.replace(/:([A-Za-z_]+)(?:\{[^}]*\})?\??/g, (_m, n: string) => id(n)).replace(/\*/g, 'x')
  if (names.length === 0) return [fill(() => '')]
  const known = (n: string): string | undefined => ID_FOR.find(([re]) => re.test(n))?.[1]
  if (names.every((n) => known(n))) return [fill((n) => known(n) ?? '')]
  return ANY_ID.map((id) => fill((n) => known(n) ?? id))
}

const SKIP = /(^|\/)(stream|events|push|ws|sse|logout|callback|login)(\/|$)/i

function getRoutes(app: Hono<{ Bindings: Env }>): string[] {
  const seen = new Set<string>()
  for (const r of app.routes) {
    if (r.method !== 'GET' || SKIP.test(r.path)) continue
    for (const p of concretePaths(r.path)) seen.add(p)
  }
  return [...seen].sort()
}

interface Credential { name: string; headers: (b: Boundary) => Promise<Record<string, string>> }
const bearerOf = (raw: string): Credential['headers'] => async () => ({ authorization: `Bearer ${raw}` })
const credentials: Credential[] = [
  { name: "bearer: customer A's agent", headers: bearerOf(RAW.agentA) },
  { name: "bearer: customer A's human", headers: bearerOf(RAW.humanA) },
  { name: 'bearer: a member with no grants', headers: bearerOf(RAW.zero) },
  { name: 'bearer: a stranger after bootstrap_self', headers: async (b) => { await bootstrapStranger(b, { apiKey: true }); return { authorization: `Bearer ${RAW_STRANGER}` } } },
  { name: "cookie: customer A's human", headers: async (b) => ({ cookie: await b.signIn('web@a.test') }) },
  { name: 'cookie: a stranger after bootstrap_self', headers: async (b) => { await bootstrapStranger(b); return { cookie: await b.signIn('stranger@x.test') } } },
]

const root = mountAll()
const PATHS = getRoutes(root)

// Leaks this sweep found that are not fixed yet. Each is excluded from the generic assertion above, and pinned
// by its own it.fails below, so the day the route is fixed that test goes red and the entry is deleted.
// task 22db3773 is the audit of tenant-wide surfaces a bootstrap_self identity can reach; these two are what
// the audit finds, and they are reachable by every squad member, not only by a bootstrapped stranger.
const KNOWN_OPEN: Array<{ task: string; path: string; what: string }> = [
  { task: '22db3773', path: '/dashboard/kanban', what: 'the board selector lists every project name in the pot, including other customers\'' },
  { task: '22db3773', path: '/squads/sq-b/agents/join', what: 'the refusal page for a squad the caller cannot see prints that squad\'s name in its title' },
]
const OPEN_PATHS = new Set(KNOWN_OPEN.map((k) => k.path))

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
})
afterEach(() => vi.unstubAllGlobals())

describe('route enumeration', () => {
  it('finds the GET routes of the mounted apps (the sweep is not vacuous)', () => {
    expect(PATHS.length).toBeGreaterThan(80)
    expect(PATHS).toContain('/api/org/tree')
    expect(PATHS.some((p) => p.startsWith('/api/coordination'))).toBe(true)
  })
})

describe.each(credentials)('GET sweep, $name', (cred) => {
  it('no route shows or changes customer B', async () => {
    const b = await buildBoundary()
    try {
      const headers = await cred.headers(b)
      const before = snapshotB(b)
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      const leaks: string[] = []
      for (const path of PATHS) {
        if (OPEN_PATHS.has(path)) continue
        let res: Response
        try {
          res = await root.fetch(new Request(`https://pot.test${path}`, { headers }), b.env, ctx)
        } catch {
          continue // a handler that throws answers 500; that is not a boundary finding
        }
        const type = res.headers.get('content-type') ?? ''
        if (type.includes('event-stream')) { await res.body?.cancel(); continue }
        const body = await res.text()
        if (body.includes(B_SECRET) || body.includes(B_SUPABASE_HOST) || body.includes(B_SUPABASE_KEY)) leaks.push(`${path} -> ${res.status}`)
      }
      expect(leaks, 'routes that showed customer B to a caller with no standing').toEqual([])
      expect(snapshotB(b)).toBe(before)
    } finally {
      b.close()
    }
  }, 120_000)
})

describe('known open leaks found by the sweep', () => {
  for (const { task, path, what } of KNOWN_OPEN) {
    it.fails(`${task}: ${path}: ${what}`, async () => {
      const b = await buildBoundary()
      try {
        await bootstrapStranger(b)
        const cookie = await b.signIn('stranger@x.test')
        const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
        const res = await root.fetch(new Request(`https://pot.test${path}`, { headers: { cookie } }), b.env, ctx)
        expect(await res.text()).not.toContain(B_SECRET)
      } finally {
        b.close()
      }
    })
  }
})
