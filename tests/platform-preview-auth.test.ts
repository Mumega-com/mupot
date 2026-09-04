// tests/platform-preview-auth.test.ts — mupot#1305.
//
// `/preview/:project_id` dispatches into `env.DISPATCHER` — the SAME `mupot-pots`
// namespace that holds sovereign tenant pots — using a member-supplied script name
// (`worker_name || slug`). It was mounted with NO auth middleware, and was confirmed
// reachable unauthenticated on production 2026-09-04:
//
//   GET https://mupot.mumega.com/preview/<uuid>/ -> {"error":"project_not_found",...}
//
// A database lookup ran for an anonymous stranger. For a project in `healthy` state the
// request would have been dispatched into that project Worker instead.
//
// This surface also defeats the credential argument that makes the WFP hostname branch
// safe (see src/dispatcher.ts, mupot#1299/#1301). There, a browser only sends cookies it
// scoped to the tenant hostname, and the colony session cookie is host-only so it never
// arrives. Here the request is SAME-ORIGIN on the colony, so the browser attaches
// `mupot_session` precisely BECAUSE it is host-only, and dispatchProjectRequest forwards
// headers intact.
//
// The gate that caught this mutated a header selector onto handlePlatformDispatch and
// 0 of 7,427 tests went red. These are the tests that would now go red.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import { platformApp } from '../src/platform/routes'

let harness: SqliteD1Harness | null = null
afterEach(() => { harness?.close(); harness = null })

function makeHarness(): SqliteD1Harness {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
  `)
  return h
}

const SESSION_RECORD = JSON.stringify({
  userId: 'u1',
  email: 'owner@pot.test',
  role: 'owner',
  createdAt: '2026-09-04T00:00:00.000Z',
})

/** Records every script name the dispatch namespace was asked for. */
function spyDispatcher() {
  const asked: string[] = []
  const get = vi.fn((name: string) => {
    asked.push(name)
    return { fetch: async () => new Response(JSON.stringify({ served_by: 'project-worker' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) }
  })
  return { asked, binding: { get } }
}

function envFor(h: SqliteD1Harness, dispatcher: { get: unknown }, authenticated: boolean): Env {
  return {
    DB: h.db,
    TENANT_SLUG: 'mumega',
    BRAND: 'Mupot',
    DISPATCHER: dispatcher,
    // An authenticated session resolves; otherwise the cookie maps to nothing.
    SESSIONS: { get: vi.fn(async () => (authenticated ? SESSION_RECORD : null)) },
  } as unknown as Env
}

/** A project in `healthy` state — the only state that actually dispatches. */
async function healthyProject(h: SqliteD1Harness, env: Env, workerName: string) {
  const created = await createProject(env, {
    name: 'Preview Target',
    slug: 'preview-target',
    goal: 'g',
    squad_id: 'squad-a',
    worker_name: workerName,
    live_url: 'https://example.test',
  } as never)
  if (!created.ok) throw new Error(`fixture failed: ${JSON.stringify(created)}`)
  h.sqlite.exec(`UPDATE projects SET deploy_status = 'healthy' WHERE id = '${created.value.id}'`)
  return created.value.id
}

describe('/preview/:project_id requires authentication (#1305)', () => {
  it('refuses an unauthenticated request AND never touches the dispatch namespace', async () => {
    harness = makeHarness()
    const d = spyDispatcher()
    const env = envFor(harness, d.binding, false)
    const id = await healthyProject(harness, envFor(harness, d.binding, true), 'gaf')

    const res = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${id}/`),
      env,
    )

    expect(res.status).toBe(401)
    // The assertion that matters: not merely "refused", but "never reached the namespace".
    // A 401 rendered AFTER a dispatch would still have leaked the request.
    expect(d.asked, `dispatch namespace was consulted: ${d.asked.join(',')}`).toEqual([])
  })

  it('refuses without a session on the wildcard sub-path too', async () => {
    harness = makeHarness()
    const d = spyDispatcher()
    const env = envFor(harness, d.binding, false)
    const id = await healthyProject(harness, envFor(harness, d.binding, true), 'gaf')

    const res = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${id}/deep/path?q=1`),
      env,
    )

    expect(res.status).toBe(401)
    expect(d.asked).toEqual([])
  })

  it('refuses BEFORE disclosing whether the project exists', async () => {
    // Pre-fix, an anonymous caller learned project existence from the 404 body. The
    // refusal must not be ordered after the lookup.
    harness = makeHarness()
    const d = spyDispatcher()
    const res = await platformApp.fetch(
      new Request('https://mupot.mumega.com/preview/00000000-0000-0000-0000-000000000000/'),
      envFor(harness, d.binding, false),
    )
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('project_not_found')
  })

  // PAIRED POSITIVE CONTROL. Without this, a change that broke /preview entirely would
  // satisfy every assertion above — "nothing was dispatched" is also what a dead route
  // looks like.
  it('still dispatches for an authenticated session', async () => {
    harness = makeHarness()
    const d = spyDispatcher()
    const env = envFor(harness, d.binding, true)
    const id = await healthyProject(harness, env, 'gaf')

    const res = await platformApp.fetch(
      new Request(`https://mupot.mumega.com/preview/${id}/`, {
        headers: { cookie: 'mupot_session=live-session-id' },
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ served_by: 'project-worker' })
    expect(d.asked).toEqual(['gaf'])
  })
})
