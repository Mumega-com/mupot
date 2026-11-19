// Web approval of a gate:office (WordPress publish) task: POST /approvals/office/:id/decide.
//
// Real dashboardApp, real web sessions (dev-login), real migration chain, the real install -> configure -> activate
// office lifecycle. The route is a thin door onto reviewOfficeApproval (the SAME path office.review_approval uses);
// these tests pin each guard so removing it turns one red (mutation results are in the PR body).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An attached seat is a web session whose AuthContext also carries boundAgentId; reproduce it by decorating the REAL
// requireAuth result when a request header asks for it (everything else stays real).
vi.mock('../src/auth', async (original) => {
  const real = await original<typeof import('../src/auth')>()
  return {
    ...real,
    requireAuth: async (
      c: { req: { header: (n: string) => string | undefined }; get: (k: 'auth') => unknown; set: (k: 'auth', v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      // The mocked signature is structurally the real one for the only call site (dashboard middleware).
      return (real.requireAuth as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(c, async () => {
        const bound = c.req.header('x-test-bound-agent')
        if (bound) c.set('auth', { ...(c.get('auth') as object), boundAgentId: bound })
        // A bearer-style caller: authenticated and a real member, but NOT a browser web session.
        if (c.req.header('x-test-no-web-session')) c.set('auth', { ...(c.get('auth') as object), webSessionIdHash: undefined, webSessionMemberId: undefined })
        await next()
      })
    },
  }
})

const { authApp } = await import('../src/auth')
const { dashboardApp } = await import('../src/dashboard/index')
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { installAddon, configureAddon, activateAddon } from '../src/addons/service'
import { createTask } from '../src/tasks/service'
import { invokeTool } from '../src/mcp/index'
import '../src/mcp/office'
import { loadApprovals } from '../src/dashboard/approvals'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
const MASTER_KEY = '33'.repeat(32)

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let h: SqliteD1Harness
let taskId: string
let squadId: string
let deptId: string

function envFor(email: string, tenant = TENANT): Env {
  return {
    TENANT_SLUG: tenant, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(), DB: h.db, CONNECTOR_MASTER_KEY: MASTER_KEY,
  } as unknown as Env
}
async function login(email: string, tenant = TENANT): Promise<{ env: Env; cookie: string }> {
  const env = envFor(email, tenant)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  // Approve needs a fresh step-up (round 2); every session starts fresh, tests that exercise the step-up make it stale.
  h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date().toISOString())
  return { env, cookie: `mupot_session=${m[1]}` }
}
const staleReauth = (): void =>
  void h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60_000)).toISOString())
const frozenHash = (id = taskId): string =>
  (h.sqlite.prepare('SELECT payload_sha256 AS s FROM office_publish_freezes WHERE task_id = ? AND voided_at IS NULL').get(id) as { s: string }).s
const taskRow = (id = taskId) =>
  h.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }
const verdicts = (id = taskId) =>
  h.sqlite.prepare('SELECT verdict, decided_by FROM task_verdicts WHERE task_id = ?').all(id) as Array<{ verdict: string; decided_by: string }>

function decide(env: Env, cookie: string, fields: Record<string, string>, opts: { origin?: string | null; id?: string; bound?: string; ctype?: string; bearer?: boolean } = {}) {
  const headers: Record<string, string> = { cookie, 'content-type': opts.ctype ?? 'application/x-www-form-urlencoded' }
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
  if (opts.bound) headers['x-test-bound-agent'] = opts.bound
  if (opts.bearer) headers['x-test-no-web-session'] = '1'
  return dashboardApp.request(`/approvals/office/${opts.id ?? taskId}/decide`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }, env)
}

async function seedActiveOffice(): Promise<void> {
  const env = envFor('seed@x.test')
  const connectorId = 'connector-office-wordpress'
  const encrypted = await encryptConnectorSecret(MASTER_KEY, connectorId, 'mcpwp', 'wp-secret')
  h.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'WP', ?, ?, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(connectorId, TENANT, encrypted, JSON.stringify({ siteUrl: 'https://wordpress.example.com', username: 'office-agent' }))
  const owner = { id: 'owner-1', role: 'owner' as const }
  const i = await installAddon(env, owner, 'mcpwp-office')
  if (!i.ok) throw new Error(`install ${JSON.stringify(i)}`)
  const c = await configureAddon(env, owner, 'mcpwp-office', { bindings: [{ slot: 'wordpress_site', adapter: 'mcpwp', bindingKind: 'vault_connector', connectorId }] })
  if (!c.ok) throw new Error(`configure ${JSON.stringify(c)}`)
  const a = await activateAddon(env, owner, 'mcpwp-office')
  if (!a.ok) throw new Error(`activate ${JSON.stringify(a)}`)
}

async function makeReviewTask(env: Env, forSquad: string, title = 'Publish: Q4 recap'): Promise<string> {
  const task = await createTask(env, { squad_id: forSquad, title, body: 'the exact words', done_when: 'post is live', gate_owner: 'gate:office' }, { skipMirror: true, skipEvent: true })
  const owner = { userId: 'seed', email: null, role: 'owner' as const, tenant: TENANT, memberId: 'seed', capabilities: [{ member_id: 'seed', scope_type: 'org' as const, scope_id: null, capability: 'owner' as const }], boundAgentId: null }
  for (const status of ['in_progress', 'review']) {
    const r = await invokeTool(owner as never, env, 'task_update', { task_id: task.id, status }, ORIGIN)
    if (!r.ok) throw new Error(`fixture: ${status} ${JSON.stringify(r)}`)
  }
  return task.id
}

function member(id: string, email: string, capability: 'lead' | 'member', scope: 'department' | 'org' = 'department'): void {
  h.sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`).run(id, email, id, TENANT)
  h.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)`)
    .run(`cap-${id}`, id, scope, scope === 'department' ? deptId : null, capability)
  h.sqlite.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, 'gate:office', 'member', ?, 'test', datetime('now'))`).run(`gg-${id}`, id)
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');`)
  await seedActiveOffice()
  deptId = (h.sqlite.prepare(`SELECT id FROM departments WHERE slug = 'office'`).get() as { id: string }).id
  squadId = (h.sqlite.prepare(`SELECT id FROM squads WHERE slug = 'site-operator'`).get() as { id: string }).id
  member('mem-lead', 'lead@x.test', 'lead')
  taskId = await makeReviewTask(envFor('seed@x.test'), squadId)
})
afterEach(() => h.close())

describe('POST /approvals/office/:id/decide', () => {
  it('approve happy path: a named human lead approves the hash they saw; verdict recorded as that member', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, task_id: taskId, verdict: 'approved' })
    expect(taskRow().status).toBe('approved')
    expect(verdicts()).toEqual([{ verdict: 'approved', decided_by: 'mem-lead' }])
  })

  it('reject: records the rejection with the note, no hash needed', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'rejected', note: 'wrong tone' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(taskRow().status).toBe('rejected')
    expect(verdicts()).toEqual([{ verdict: 'rejected', decided_by: 'mem-lead' }])
  })

  it('stale payload hash: 409 payload_mismatch, nothing written', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: 'f'.repeat(64) })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'payload_mismatch' })
    expect(taskRow().status).toBe('review')
    expect(verdicts()).toEqual([])
  })

  it('approve without any hash is refused (400), nothing written', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'expected_hash_required' })
    expect(verdicts()).toEqual([])
  })

  it('agent-bound (attached seat) session is refused, nothing written', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() }, { bound: 'agent-x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'agent_approval_forbidden' })
    expect(verdicts()).toEqual([])
  })

  it('a non-browser (bearer-style) caller with the same member authority is refused: human web session only', async () => {
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() }, { bearer: true })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not_a_web_session' })
    expect(verdicts()).toEqual([])
  })

  it('non-lead member (office department member only) is refused, nothing written', async () => {
    member('mem-plain', 'plain@x.test', 'member')
    const { env, cookie } = await login('plain@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not_authorized' })
    expect(taskRow().status).toBe('review')
    expect(verdicts()).toEqual([])
  })

  it('self-approval: the human owner of the task cannot approve their own request', async () => {
    h.sqlite.prepare(`UPDATE tasks SET assignee_member_id = 'mem-lead' WHERE id = ?`).run(taskId)
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'self_verdict' })
    expect(verdicts()).toEqual([])
  })

  it('cross-squad: an office lead cannot decide an office task in a squad they have no scope on', async () => {
    h.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d-other', 'other', 'Other');
                   INSERT INTO squads (id, department_id, slug, name) VALUES ('s-other', 'd-other', 'other-sq', 'Other Squad');`)
    const foreign = await makeReviewTask(envFor('seed@x.test'), 's-other', 'Publish: foreign')
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash(foreign) }, { id: foreign })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not_authorized' })
    expect(taskRow(foreign).status).toBe('review')
  })

  it('cross-tenant: a session minted for another tenant cannot decide this pot\'s task', async () => {
    const { cookie } = await login('lead@x.test')
    const res = await decide(envFor('lead@x.test', 'other-pot'), cookie, { verdict: 'approved', payload_sha256: frozenHash() })
    expect([302, 401, 403]).toContain(res.status)
    expect(taskRow().status).toBe('review')
    expect(verdicts()).toEqual([])
  })

  it('no web session (no cookie) is refused', async () => {
    const res = await dashboardApp.request(`/approvals/office/${taskId}/decide`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ verdict: 'approved', payload_sha256: frozenHash() }).toString(),
    }, envFor('lead@x.test'))
    expect([302, 401, 403]).toContain(res.status)
    expect(verdicts()).toEqual([])
  })

  it('CSRF: missing / cross-origin Origin is refused; non-form content types are refused 415', async () => {
    const { env, cookie } = await login('lead@x.test')
    const fields = { verdict: 'approved', payload_sha256: frozenHash() }
    expect((await decide(env, cookie, fields, { origin: null })).status).toBe(403)
    expect((await decide(env, cookie, fields, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await decide(env, cookie, fields, { origin: 'https://evil.test', ctype: 'application/json' })).status).toBe(415)
    expect((await decide(env, cookie, fields, { ctype: 'text/plain' })).status).toBe(415)
    expect(verdicts()).toEqual([])
  })

  it('invalid verdict value is refused', async () => {
    const { env, cookie } = await login('lead@x.test')
    expect((await decide(env, cookie, { verdict: 'maybe' })).status).toBe(400)
  })

  it('the generic verdict route still refuses gate:office (no second approval path)', async () => {
    const { tasksApp } = await import('../src/tasks')
    const { env, cookie } = await login('lead@x.test')
    const res = await tasksApp.request(`/${taskId}/verdict`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approved' }) }, env)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(taskRow().status).toBe('review')
  })
})

describe('/approvals office rows (what the human is shown)', () => {
  async function authFor(email: string) {
    const { env, cookie } = await login(email)
    const page = await dashboardApp.request('/approvals', { headers: { cookie } }, env)
    return { env, html: await page.text() }
  }

  it('a lead sees Approve/Reject on the office row, bound to the frozen hash, showing the frozen text', async () => {
    const { html } = await authFor('lead@x.test')
    expect(html).toContain(`data-office-sha="${frozenHash()}"`)
    expect(html).toContain('the exact words')
    expect(html).toContain('class="btn appr-approve"')
    expect(html).toContain('/approvals/office/')
  })

  it('a non-lead member is not offered Approve (no buttons)', async () => {
    member('mem-plain', 'plain@x.test', 'member')
    const { html } = await authFor('plain@x.test')
    expect(html).not.toContain(`data-office-sha="${frozenHash()}"`)
  })

  it('the self-owner of the task is not offered Approve', async () => {
    h.sqlite.prepare(`UPDATE tasks SET assignee_member_id = 'mem-lead' WHERE id = ?`).run(taskId)
    const { html } = await authFor('lead@x.test')
    expect(html).not.toContain(`data-office-sha="${frozenHash()}"`)
    expect(html).not.toContain('class="btn appr-approve"')
    expect(html).not.toContain('class="btn btn-reject appr-reject"')
  })

  // An org owner passes every capability/gate check on its own (isOrgAdmin), so the UI's own pre-checks are the only thing
  // that stops these two rows from offering a button the service would refuse. Each renders the real row.
  const ownerAuth = (extra: { boundAgentId: string | null }) => ({
    userId: 'mem-lead', email: null, role: 'owner' as const, tenant: TENANT, memberId: 'mem-lead', boundAgentId: extra.boundAgentId,
    capabilities: [{ member_id: 'mem-lead', scope_type: 'org' as const, scope_id: null, capability: 'owner' as const }],
  })

  it('loadApprovals control: an unbound owner is offered Approve and Reject on the row', async () => {
    const q = await loadApprovals(envFor('seed@x.test'), ownerAuth({ boundAgentId: null }))
    const row = q.items.find((i) => i.id === taskId)
    expect(row, 'office row must be visible to an owner').toBeDefined()
    expect(row).toMatchObject({ is_office: true, can_approve: true, can_reject: true })
  })

  it('loadApprovals: an agent-bound caller gets no actions on an office row (UI boundAgentId check)', async () => {
    const q = await loadApprovals(envFor('seed@x.test'), ownerAuth({ boundAgentId: 'agent-x' }))
    const row = q.items.find((i) => i.id === taskId)
    expect(row?.can_approve ?? false).toBe(false)
    expect(row?.can_reject ?? false).toBe(false)
    expect(row?.can_verdict ?? false).toBe(false)
  })

  it('the card shows the FROZEN text, not the live row, when they differ', async () => {
    // The live task text drifts after the freeze (title/body edited); the human must see the frozen bytes.
    h.sqlite.prepare(`UPDATE tasks SET title = 'LIVE title drift', body = 'LIVE body drift' WHERE id = ?`).run(taskId)
    const { html } = await authFor('lead@x.test')
    expect(html).toContain('the exact words')
    expect(html).toContain('Publish: Q4 recap')
    expect(html).not.toContain('LIVE body drift')
    expect(html).not.toContain('LIVE title drift')
  })

  it('a stale freeze (frozen text differs from live) offers no Approve button, but Reject stays', async () => {
    h.sqlite.prepare(`UPDATE tasks SET body = 'edited after freeze' WHERE id = ?`).run(taskId)
    const { html } = await authFor('lead@x.test')
    expect(html).toContain('data-can-approve="0"')
    expect(html).toContain('data-can-reject="1"')
    expect(html).not.toContain('class="btn appr-approve"')
    expect(html).toContain('class="btn btn-reject appr-reject"')
  })

  it('shows the destination (frozen site_origin) on the card', async () => {
    const { html } = await authFor('lead@x.test')
    expect(html).toContain('Publishes to')
    expect(html).toContain('https://wordpress.example.com')
  })

  it('the destination is HTML-escaped', async () => {
    h.sqlite.prepare(`UPDATE office_publish_freezes SET payload_json = json_set(payload_json, '$.site_origin', ?) WHERE task_id = ?`)
      .run('https://x.test/"><script>alert(1)</script>', taskId)
    const { html } = await authFor('lead@x.test')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('an office row with NO freeze is still marked office (so Reject routes to the office door) and offers Reject only', async () => {
    h.sqlite.prepare(`UPDATE office_publish_freezes SET voided_at = datetime('now') WHERE task_id = ?`).run(taskId)
    const { html } = await authFor('lead@x.test')
    expect(html).toContain('data-office="1"')
    expect(html).not.toContain('data-office-sha=')
    expect(html).toContain('data-can-approve="0"')
    expect(html).toContain('data-can-reject="1"')
    expect(html).not.toContain('class="btn appr-approve"')
    // The page script routes every data-office row to the office door regardless of sha.
    expect(html).toContain(`card.getAttribute('data-office') === '1'`)
  })

  it('no-freeze office row: Reject succeeds on the office route', async () => {
    h.sqlite.prepare(`UPDATE office_publish_freezes SET voided_at = datetime('now') WHERE task_id = ?`).run(taskId)
    const { env, cookie } = await login('lead@x.test')
    const res = await decide(env, cookie, { verdict: 'rejected', note: 'not publishing', payload_sha256: '' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(taskRow().status).toBe('rejected')
  })

  it('the page script follows reauth_required to the re-auth redirect', async () => {
    const { html } = await authFor('lead@x.test')
    expect(html).toContain(`r.data.error === 'reauth_required'`)
    expect(html).toContain('window.location.href = r.data.reauth_url')
  })
})

describe('fresh step-up (approve only)', () => {
  it('approve with a non-fresh session: reauth_required with a return-to-approvals URL, nothing written', async () => {
    const { env, cookie } = await login('lead@x.test')
    staleReauth()
    const res = await decide(env, cookie, { verdict: 'approved', payload_sha256: frozenHash() })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'reauth_required', reauth_url: `/auth/reauth?return=${encodeURIComponent('/approvals')}` })
    expect(taskRow().status).toBe('review')
    expect(verdicts()).toEqual([])
  })

  it('reject with a non-fresh session still succeeds', async () => {
    const { env, cookie } = await login('lead@x.test')
    staleReauth()
    const res = await decide(env, cookie, { verdict: 'rejected', note: 'no' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(taskRow().status).toBe('rejected')
  })
})
