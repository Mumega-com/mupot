// /admin/security-bar: GET read view for any signed-in member, POST owner-only, server decides raise vs lower.
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSecurityBarApp } from '../src/dashboard/security-bar'
import type { AppEnv } from '../src/dashboard/wizard'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
let harness: SqliteD1Harness
let env: Env

function appFor(auth: AuthContext | null) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => { if (auth) c.set('auth', auth); await next() })
  app.route('/', makeSecurityBarApp((_e, _t, body) => body))
  return app
}
const owner = { userId: 'o', email: 'o@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'o', boundAgentId: null, capabilities: [{ member_id: 'o', scope_type: 'org', scope_id: null, capability: 'owner' }] } as AuthContext
const admin = { ...owner, userId: 'a', memberId: 'a', capabilities: [{ member_id: 'a', scope_type: 'org', scope_id: null, capability: 'admin' }] } as AuthContext
const post = (app: Hono<AppEnv>, body: unknown) => app.request('/admin/security-bar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  harness.sqlite.exec(`INSERT INTO members (id, tenant, email, display_name, status) VALUES ('o', '${TENANT}', 'o@x.test', 'O', 'active'), ('a', '${TENANT}', 'a@x.test', 'A', 'active')`)
})
afterEach(() => harness.close())

describe('/admin/security-bar', () => {
  it('GET shows the level and the YAML view to a signed-in member, with no change form for non-owners', async () => {
    const res = await appFor(admin).request('/admin/security-bar', {}, env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('task.intake.p1-linkage:')
    expect(text).toContain('level: operating')
    expect(text).not.toContain('form-bar')
    expect(await (await appFor(owner).request('/admin/security-bar', {}, env)).text()).toContain('form-bar')
    expect((await appFor(null).request('/admin/security-bar', {}, env)).status).toBe(401)
  })

  it('POST is owner-only', async () => {
    expect((await post(appFor(admin), { action: 'set', level: 'under_attack' })).status).toBe(403)
    expect((await post(appFor(null), { action: 'set', level: 'under_attack' })).status).toBe(403)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM security_bar_state').get()).toEqual({ n: 0 })
  })

  it('POST raises for the owner; a "set" that would LOWER is routed to the step-up path by the server, not applied', async () => {
    expect((await post(appFor(owner), { action: 'set', level: 'under_attack' })).status).toBe(200)
    const lower = await post(appFor(owner), { action: 'set', level: 'onboarding' }) // client label says set; the server sees a lowering
    expect(lower.status).toBe(403)
    expect(await lower.json()).toEqual({ error: 'reauth_required' })
    expect(harness.sqlite.prepare('SELECT level FROM security_bar_state').get()).toEqual({ level: 'under_attack' })
  })

  it('POST rejects bad input', async () => {
    expect((await post(appFor(owner), { action: 'set', level: 'wide-open' })).status).toBe(400)
    expect((await post(appFor(owner), { action: 'delete' })).status).toBe(400)
    expect((await post(appFor(owner), { action: 'confirm_lower' })).status).toBe(403) // no web session
  })
})
