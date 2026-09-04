import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import {
  DISPATCH_LIMITS,
  extractDispatchTarget,
  fallbackReasonForStatus,
  handlePlatformDispatch,
  isWorkerReady,
  maybeHandleHostnameDispatch,
  matchPreviewPath,
  previewIframePath,
  scriptNameForProject,
} from '../src/platform/dispatcher'
import { platformApp, projectLivePreviewSplitHtml } from '../src/platform/routes'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
  `)
  return harness
}

// /preview/:project_id requires an authenticated session as of mupot#1305, so these
// dispatch-behaviour tests must carry one. They exercise what happens AFTER the gate;
// the gate itself is covered by tests/platform-preview-auth.test.ts, including the
// unauthenticated-refusal cases this helper deliberately does not produce.
const TEST_SESSION = JSON.stringify({
  userId: 'u1',
  email: 'owner@pot.test',
  role: 'owner',
  createdAt: '2026-09-04T00:00:00.000Z',
})

/** Requests to a gated route need the cookie as well as a resolving SESSIONS store. */
const AUTHED = { cookie: 'mupot_session=test-session-id' }

function envFor(harness: SqliteD1Harness, extra: Partial<Env> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    BRAND: 'Mupot',
    RELEASE_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    SESSIONS: { get: async () => TEST_SESSION },
    ...extra,
  } as unknown as Env
}

function mockDispatcher(fetchImpl?: (request: Request) => Promise<Response> | Response) {
  const fetch = vi.fn(async (request: Request) => {
    if (fetchImpl) return fetchImpl(request)
    return new Response(JSON.stringify({ ok: true, path: new URL(request.url).pathname }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const get = vi.fn(() => ({ fetch }))
  return { get, fetch }
}

describe('platform dispatch routing (pure)', () => {
  it('parses /preview/:project_id and wildcard hostnames', () => {
    expect(matchPreviewPath('/preview/proj-1')).toEqual({ projectId: 'proj-1', remainder: '/' })
    expect(matchPreviewPath('/preview/proj-1/app/home')).toEqual({
      projectId: 'proj-1',
      remainder: '/app/home',
    })
    expect(matchPreviewPath('/projects/proj-1')).toBeNull()
    expect(previewIframePath('proj-1')).toBe('/preview/proj-1/')

    expect(extractDispatchTarget(
      new URL('https://viamar.mupot.mumega.com/health'),
      'mumega',
    )).toEqual({ kind: 'hostname', slug: 'viamar', remainder: '/health' })

    expect(extractDispatchTarget(
      new URL('https://mumega.mupot.mumega.com/health'),
      'mumega',
    )).toBeNull()

    expect(extractDispatchTarget(
      new URL('https://mupot.mumega.com/preview/abc-123/x'),
      'mumega',
    )).toEqual({ kind: 'path', projectId: 'abc-123', remainder: '/x' })
  })

  it('treats only healthy workers as live', () => {
    expect(isWorkerReady('healthy')).toBe(true)
    expect(fallbackReasonForStatus('idle')).toBe('idle')
    expect(fallbackReasonForStatus('queued')).toBe('building')
    expect(fallbackReasonForStatus('deploying')).toBe('building')
    expect(fallbackReasonForStatus('failed')).toBe('failed')
    expect(scriptNameForProject({ slug: 'client-one', worker_name: 'viamar' })).toBe('viamar')
    expect(scriptNameForProject({ slug: 'client-one', worker_name: null })).toBe('client-one')
  })
})

describe('platform dispatch fetch', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('proxies /preview/:project_id/* to the project sub-worker and strips the prefix', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), {
      slug: 'viamar',
      name: 'Viamar',
      worker_name: 'viamar',
      repo_url: 'https://github.com/Digidinc/viamar',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    harness.sqlite.prepare("UPDATE projects SET deploy_status = 'healthy' WHERE id = ?").run(created.value.id)
    const dispatcher = mockDispatcher()
    const env = envFor(harness, { DISPATCHER: dispatcher })

    const response = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${created.value.id}/dashboard`, { headers: AUTHED }),
      env,
    )
    expect(response.status).toBe(200)
    expect(dispatcher.get).toHaveBeenCalledWith('viamar', {}, { limits: DISPATCH_LIMITS })
    expect(dispatcher.fetch).toHaveBeenCalledTimes(1)
    const forwarded = dispatcher.fetch.mock.calls[0][0] as Request
    expect(new URL(forwarded.url).pathname).toBe('/dashboard')
    await expect(response.json()).resolves.toEqual({ ok: true, path: '/dashboard' })
  })

  it('routes https://<project>.mupot.mumega.com to the project Worker by slug', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), {
      slug: 'dme',
      name: 'DME',
      worker_name: 'dme',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.prepare("UPDATE projects SET deploy_status = 'healthy' WHERE id = ?").run(created.value.id)

    const dispatcher = mockDispatcher()
    const env = envFor(harness, { DISPATCHER: dispatcher })
    const request = new Request('https://dme.mupot.mumega.com/health')
    const response = await handlePlatformDispatch(request, env)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(200)
    expect(dispatcher.get).toHaveBeenCalledWith('dme', {}, { limits: DISPATCH_LIMITS })
  })

  it('renders the building fallback instead of dispatching', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), {
      slug: 'building',
      name: 'Building',
      worker_name: 'building',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.prepare("UPDATE projects SET deploy_status = 'deploying' WHERE id = ?").run(created.value.id)

    const dispatcher = mockDispatcher()
    const env = envFor(harness, { DISPATCHER: dispatcher })
    const response = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${created.value.id}/`, { headers: AUTHED }),
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-mupot-preview')).toBe('building')
    const body = await response.text()
    expect(body).toContain('data-preview-fallback="building"')
    expect(body).toContain('Worker building')
    expect(dispatcher.get).not.toHaveBeenCalled()
  })

  it('renders the idle fallback when the worker has never been dispatched', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), {
      slug: 'idle-proj',
      name: 'Idle',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const response = await handlePlatformDispatch(
      new Request(`https://mupot.mumega.com/preview/${created.value.id}/`, { headers: AUTHED }),
      envFor(harness),
    )
    expect(response).not.toBeNull()
    expect(response!.headers.get('x-mupot-preview')).toBe('idle')
    expect(await response!.text()).toContain('Worker idle')
  })

  it('falls back when DISPATCHER.get says the user Worker is missing', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), {
      slug: 'ghost',
      name: 'Ghost',
      worker_name: 'ghost',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.prepare("UPDATE projects SET deploy_status = 'healthy' WHERE id = ?").run(created.value.id)

    const env = envFor(harness, {
      DISPATCHER: {
        get() {
          throw new Error('User worker not found in namespace mupot-pots')
        },
      },
    })
    const response = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${created.value.id}/`, { headers: AUTHED }),
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-mupot-preview')).toBe('not_provisioned')
    expect(await response.text()).toContain('Worker not provisioned')
  })

  it('returns 404 JSON for an unknown /preview/:project_id', async () => {
    harness = makeHarness()
    const response = await platformApp.fetch(
      new Request('https://mupot.mumega.com/preview/missing/', { headers: AUTHED }),
      envFor(harness),
    )
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: 'project_not_found',
      project_id: 'missing',
    })
  })

  it('does not steal the pot hostname from the dashboard', async () => {
    harness = makeHarness()
    const stolen = await maybeHandleHostnameDispatch(
      new Request('https://mumega.mupot.mumega.com/projects/abc'),
      envFor(harness),
    )
    expect(stolen).toBeNull()
  })
})

describe('project live preview split view', () => {
  it('embeds the preview iframe and code/logs panes', async () => {
    const html = String(projectLivePreviewSplitHtml({
      project: {
        id: 'proj-live',
        name: 'Live',
        slug: 'live',
        repo_url: 'https://github.com/Digidinc/viamar',
        live_url: 'https://viamar.mumega.com',
        worker_name: 'viamar',
        deploy_status: 'healthy',
      },
      deployments: [{
        id: 'dep-1',
        project_id: 'proj-live',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        deployment_id: 'cf-1',
        url: 'https://viamar.mumega.com',
        status: 'deploying',
        dispatched_by: 'member-a',
        flight_id: null,
        created_at: '2026-08-26T00:00:00.000Z',
      }],
      flights: [{ id: 'fl-1', goal: 'Ship preview', status: 'in_flight' }],
      prs: [{ title: 'Add preview', repo: 'Digidinc/viamar', pr_number: 12 }],
    }))

    expect(html).toContain('aria-label="Live preview"')
    expect(html).toContain('data-preview-iframe="proj-live"')
    expect(html).toContain('src="/preview/proj-live/"')
    expect(html).toContain('data-code-logs-pane')
    expect(html).toContain('Code / Logs')
    expect(html).toContain('Digidinc/viamar')
    expect(html).toContain('bbbbbbb')
    expect(html).toContain('Ship preview')
  })
})
