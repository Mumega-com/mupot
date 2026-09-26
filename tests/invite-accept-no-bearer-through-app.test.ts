// tests/invite-accept-no-bearer-through-app.test.ts — mupot#1551 Option A.
//
// Every other invite-accept test in this repo hits membersApp directly at its
// bare, un-prefixed path (`membersApp.request('/invites/:id/accept', …)` /
// `membersApp.fetch(new Request('.../invites/:id/accept', …))`), never at the
// real production address a client actually calls. This file mounts membersApp
// the SAME way src/index.ts's top-level `app` does — `app.route(ROUTES.members,
// membersApp)`, ROUTES.members = '/api/members' (src/types.ts) — and hits the
// exact path: POST /api/members/invites/:id/accept.
//
// It does NOT `import { app } from '../src/index'`: src/index.ts transitively
// pulls DurableObject/WorkerEntrypoint/WorkflowEntrypoint from 'cloudflare:workers'
// via '@cloudflare/workers-oauth-provider', which only the workerd runtime
// provides — the default Node vitest pool's ESM loader rejects the `cloudflare:`
// scheme outright (see vitest.composition.config.ts's header, and
// tests/composition/*, which run that import under @cloudflare/vitest-pool-workers
// instead). That pool's only D1 binding is a schema-less scratch probe
// (D1_BATCH_PROBE, unrelated to this repo's migrations) — wiring a fully
// migrated D1 there for one route test is a real infra change, not this fix's
// scope. Re-declaring the exact same `app.route(ROUTES.members, membersApp)`
// composition here, under the default pool's real sqlite-D1 harness, proves
// the same two things (the prefix wiring AND the no-bearer contract) without
// that dependency.
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { membersApp } from '../src/members'
import { ROUTES } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

// mupot#1551: the SAME mount src/index.ts's `app` does for this component —
// `app.route(ROUTES.members, membersApp)` — so a drift in ROUTES.members away
// from '/api/members' would fail THIS test too, not just be invisible here.
const app = new Hono<{ Bindings: Env }>()
app.route(ROUTES.members, membersApp)

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    -- mupot#1551 slice 1: acceptInvite now re-checks the inviter's CURRENT
    -- standing at redemption — member-admin needs real authority on dept-a
    -- or this accept refuses invite_inviter_no_longer_authorized instead of
    -- reaching the no-bearer contract this file exists to prove.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-member-admin', 'member-admin', 'department', 'dept-a', 'admin');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-through-app', 'throughapp@example.com', 'dept-a', 'member', 'member-admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN } as unknown as Env
}

describe('mupot#1551 — POST /api/members/invites/:id/accept through the real ROUTES.members mount', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('reaches the real route, mints the member, and hands back token: null, next: sign_in', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const response = await app.fetch(
      new Request(`${ORIGIN}${ROUTES.members}/invites/inv-through-app/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: 'Through App' }),
      }),
      env,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')

    const body = await response.json() as {
      member_id: string
      capability: { scope_type: string; scope_id: string | null; capability: string }
      token: null
      next: string
    }
    expect(typeof body.member_id).toBe('string')
    expect(body.token).toBeNull()
    expect(body.next).toBe('sign_in')

    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?`)
      .get(body.member_id) as { n: number }
    expect(tokenCount.n).toBe(0)

    const member = harness.sqlite
      .prepare(`SELECT email, status FROM members WHERE id = ?`)
      .get(body.member_id) as { email: string; status: string }
    expect(member).toEqual({ email: 'throughapp@example.com', status: 'active' })
  })
})
