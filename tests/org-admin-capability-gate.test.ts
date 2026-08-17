// tests/org-admin-capability-gate.test.ts
//
// THE DEFECT (#530 as a live lockout): isOrgAdmin read only `auth.role` — the
// coarse legacy column src/types.ts itself annotates "capabilities are the fine
// grain" — while org ownership lives as a capability row (scope 'org' → 'owner').
// `users.role` is written once at account creation and no supported interface can
// change it, so the org OWNER was refused by their own pot with no way out by
// configuration. The MCP plane already asked the right question
// (src/mcp/index.ts: hasCapability(grants, 'org', null, 'admin')).
//
// WIDENING IS THE DANGEROUS DIRECTION. A bug here does not lock someone out, it
// lets someone in. So the load-bearing assertions in this file are the REFUSALS:
// a plain member is still refused, and a SQUAD-scope admin never becomes an org
// admin. The admissions are the easy half.
//
// NO MOCKED AUTH. This drives the REAL requireAuth over a REAL SQLite D1 with the
// whole committed migration chain, so the email→member bridge that populates
// `auth.capabilities` runs for real. Mocking requireAuth here would have made the
// central question of this change — "is auth.capabilities actually populated at
// these call sites?" — unaskable, and the suite would have passed either way.

import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const { dashboardApp, dashboardBuiltInGetRoutes } = await import('../src/dashboard')
const { isOrgAdmin } = await import('../src/auth/capability')
const { ORG_ADMIN_REFUSAL_LINKS } = await import('../src/auth/refusal')
const { requireAuth } = await import('../src/auth')

const TENANT = 'test-tenant'
const ORIGIN = 'https://pot.test'

// ── harness ──────────────────────────────────────────────────────────────────

interface Seed {
  readonly userId: string
  readonly email: string
  readonly role: 'owner' | 'admin' | 'member'
  /** When set, a members row is created and these grants attached to it. */
  readonly memberGrants?: ReadonlyArray<{ scope_type: 'org' | 'department' | 'squad'; scope_id: string | null; capability: string }>
}

interface Harness {
  readonly env: Env
  readonly sqlite: SqliteD1Harness['sqlite']
  /** Mint a session for a seeded principal; returns the Cookie header value. */
  seed(s: Seed): string
}

function makeHarness(): Harness {
  const d1 = createSqliteD1()
  applyAllMigrations(d1.sqlite)

  // One squad to hang squad-scope grants on.
  d1.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
  `)

  const sessions = new Map<string, string>()
  const kv = {
    get: async (k: string) => sessions.get(k) ?? null,
    put: async (k: string, v: string) => void sessions.set(k, v),
    delete: async (k: string) => void sessions.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  }

  const env = {
    TENANT_SLUG: TENANT,
    BRAND: 'Test',
    DB: d1.db,
    SESSIONS: kv,
    OAUTH_KV: kv,
  } as unknown as Env

  let n = 0
  return {
    env,
    sqlite: d1.sqlite,
    seed(s: Seed): string {
      n += 1
      d1.sqlite
        .prepare('INSERT INTO users (id, email, role) VALUES (?, ?, ?)')
        .run(s.userId, s.email, s.role)
      if (s.memberGrants) {
        const memberId = `m-${s.userId}`
        d1.sqlite
          .prepare("INSERT INTO members (id, email, display_name, status) VALUES (?, ?, ?, 'active')")
          .run(memberId, s.email, s.userId)
        // `tenant` arrived in a later migration than 0002; set it if the column exists.
        try {
          d1.sqlite.prepare('UPDATE members SET tenant = ? WHERE id = ?').run(TENANT, memberId)
        } catch {
          /* column absent in this schema revision — the bridge then matches on email alone */
        }
        for (const g of s.memberGrants) {
          d1.sqlite
            .prepare('INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)')
            .run(`cap-${memberId}-${g.scope_type}-${g.scope_id ?? 'null'}`, memberId, g.scope_type, g.scope_id, g.capability)
        }
      }
      const sid = `sess-${n}`
      sessions.set(
        `sess:${sid}`,
        JSON.stringify({ userId: s.userId, email: s.email, role: s.role, createdAt: '2026-01-01T00:00:00Z' }),
      )
      // Belt and braces: requireAuth owns its key format. Store under the bare id too.
      sessions.set(sid, sessions.get(`sess:${sid}`) as string)
      return `mupot_session=${sid}`
    },
  }
}

function get(h: Harness, cookie: string, path: string): Promise<Response> {
  return dashboardApp.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }), h.env)
}

function post(h: Harness, cookie: string, path: string): Promise<Response> {
  return dashboardApp.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=x&squad_id=squad-1',
    }),
    h.env,
  )
}

// The two real dashboard admin routes every refusal assertion runs against.
// One GET (which also crosses the read capability floor) and one POST (which
// does not — the floor is GET/HEAD only, so this is the path a grantless member
// actually reaches). Asserting the predicate in isolation would not have caught
// a route that forgot to call it.
const MINT_TOKEN = '/admin/agent-token'
const CREATE_AGENT = '/agents'

let h: Harness
beforeEach(() => {
  h = makeHarness()
})

// ── 1+2. the modern plane admits ─────────────────────────────────────────────

describe('a member whose ownership lives in the capability plane', () => {
  it('is ADMITTED with an org→owner grant despite role=member (the reported lockout)', async () => {
    const cookie = h.seed({
      userId: 'u-owner-cap',
      email: 'owner-cap@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).not.toBe(403)
  })

  it('is ADMITTED with an org→admin grant despite role=member', async () => {
    const cookie = h.seed({
      userId: 'u-admin-cap',
      email: 'admin-cap@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).not.toBe(403)
  })
})

// ── 3. the legacy plane still admits ─────────────────────────────────────────

describe('the legacy bootstrap owner', () => {
  it('is STILL ADMITTED with role=owner and ZERO capability rows', async () => {
    const cookie = h.seed({ userId: 'u-boot', email: 'boot@test.com', role: 'owner' })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM capabilities').get().n).toBe(0)
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).not.toBe(403)
  })
})

// ── 4. THE LOAD-BEARING ONE: a plain member is still refused ─────────────────

describe('a plain member with no org capability', () => {
  it('is REFUSED on GET /admin/agent-token', async () => {
    // A squad-observer grant so they clear the dashboard read floor and actually
    // REACH the isOrgAdmin gate — otherwise this would 403 for the wrong reason.
    const cookie = h.seed({
      userId: 'u-plain',
      email: 'plain@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    })
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).toBe(403)
  })

  it('is REFUSED on POST /agents (create agent)', async () => {
    const cookie = h.seed({ userId: 'u-plain2', email: 'plain2@test.com', role: 'member' })
    const res = await post(h, cookie, CREATE_AGENT)
    expect(res.status).toBe(403)
  })
})

// ── 5. squad admin must NEVER become org admin ───────────────────────────────

describe('a member holding only a SQUAD-scope admin grant', () => {
  it('is REFUSED at org scope on GET /admin/agent-token', async () => {
    const cookie = h.seed({
      userId: 'u-squad-admin',
      email: 'squad-admin@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }],
    })
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).toBe(403)
  })

  it('is REFUSED at org scope on POST /agents', async () => {
    const cookie = h.seed({
      userId: 'u-squad-owner',
      email: 'squad-owner@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'owner' }],
    })
    const res = await post(h, cookie, CREATE_AGENT)
    expect(res.status).toBe(403)
  })
})

// ── the predicate itself, at the scopes routes cannot easily reach ───────────

function ctx(role: AuthContext['role'], capabilities?: CapabilityGrant[]): AuthContext {
  return { tenant: TENANT, role, userId: 'u', email: 'u@test.com', capabilities } as AuthContext
}
const grant = (scope_type: string, scope_id: string | null, capability: string) =>
  ({ member_id: 'm', scope_type, scope_id, capability }) as unknown as CapabilityGrant

describe('isOrgAdmin — the ladder and the scope boundary', () => {
  it('admits org owner and org admin grants, refuses lead/member/observer', () => {
    expect(isOrgAdmin(ctx('member', [grant('org', null, 'owner')]))).toBe(true)
    expect(isOrgAdmin(ctx('member', [grant('org', null, 'admin')]))).toBe(true)
    expect(isOrgAdmin(ctx('member', [grant('org', null, 'lead')]))).toBe(false)
    expect(isOrgAdmin(ctx('member', [grant('org', null, 'member')]))).toBe(false)
    expect(isOrgAdmin(ctx('member', [grant('org', null, 'observer')]))).toBe(false)
  })

  it('never lets a squad or department grant become an org grant', () => {
    expect(isOrgAdmin(ctx('member', [grant('squad', 'squad-1', 'owner')]))).toBe(false)
    expect(isOrgAdmin(ctx('member', [grant('squad', 'squad-1', 'admin')]))).toBe(false)
    expect(isOrgAdmin(ctx('member', [grant('department', 'dept-1', 'owner')]))).toBe(false)
    expect(isOrgAdmin(ctx('member', [grant('department', 'dept-1', 'admin')]))).toBe(false)
  })

  it('keeps the legacy accept and refuses the grantless member', () => {
    expect(isOrgAdmin(ctx('owner'))).toBe(true)
    expect(isOrgAdmin(ctx('admin'))).toBe(true)
    expect(isOrgAdmin(ctx('member'))).toBe(false)
    expect(isOrgAdmin(ctx('member', []))).toBe(false)
  })

  it('reads `capabilities` (ambient) and NOT `latentCapabilities` (B1 ceiling, #712)', () => {
    const clamped = {
      tenant: TENANT,
      role: 'member',
      userId: 'u',
      capabilities: [],
      latentCapabilities: [grant('org', null, 'owner')],
    } as unknown as AuthContext
    expect(isOrgAdmin(clamped)).toBe(false)
  })
})

// ── the bridge: is auth.capabilities ACTUALLY populated? ─────────────────────

describe('the dashboard auth middleware', () => {
  it('populates auth.capabilities from D1 for a role=member web login', async () => {
    const cookie = h.seed({
      userId: 'u-bridge',
      email: 'bridge@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const probe = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    probe.use('*', requireAuth)
    probe.get('/probe', (c) => {
      const a = c.get('auth')
      return c.json({ memberId: a.memberId ?? null, capabilities: a.capabilities ?? null })
    })
    const res = await probe.fetch(new Request(`${ORIGIN}/probe`, { headers: { Cookie: cookie } }), h.env)
    const body = (await res.json()) as { memberId: string | null; capabilities: CapabilityGrant[] | null }
    expect(body.memberId).not.toBeNull()
    expect(body.capabilities).toEqual([
      expect.objectContaining({ scope_type: 'org', scope_id: null, capability: 'owner' }),
    ])
  })
})

// ── the refusal must be LEGIBLE, and must not be a dead end ──────────────────

describe('the refusal body', () => {
  it('NAMES the signed-in principal and their standing, not just the requirement', async () => {
    const cookie = h.seed({
      userId: 'u-legible',
      email: 'legible@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }],
    })
    const res = await get(h, cookie, MINT_TOKEN)
    expect(res.status).toBe(403)
    const body = await res.text()
    // WHO you are — the whole point. A future refactor that drops back to a bare
    // requirement string turns this red.
    expect(body).toContain('legible@test.com')
    expect(body).toContain('org role &quot;member&quot;')
    // WHY — the grant exists, just not on the plane this gate reads. This is the
    // sentence that would have saved the hours spent re-requesting a grant that
    // had already been made.
    expect(body).toContain('squad-scoped grants only, none at org scope')
    // WHAT NEXT.
    expect(body).toContain('ORG scope')
  })

  it('never names anyone but the caller', async () => {
    h.seed({
      userId: 'u-other',
      email: 'someone-else@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const cookie = h.seed({
      userId: 'u-nosy',
      email: 'nosy@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    })
    const body = await (await get(h, cookie, MINT_TOKEN)).text()
    expect(body).not.toContain('someone-else@test.com')
    expect(body).not.toContain('squad-1')
    expect(body).not.toContain('u-other')
  })

  it('offers links that EXIST in the live dashboard route table', () => {
    const registered = new Set(dashboardBuiltInGetRoutes.map((r) => r.path))
    expect(ORG_ADMIN_REFUSAL_LINKS.length).toBeGreaterThan(0)
    for (const l of ORG_ADMIN_REFUSAL_LINKS) expect(registered).toContain(l.href)
  })

  it('offers links the REFUSED principal can actually open (not another 403)', async () => {
    const cookie = h.seed({
      userId: 'u-links',
      email: 'links@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    })
    expect((await get(h, cookie, MINT_TOKEN)).status).toBe(403)
    for (const l of ORG_ADMIN_REFUSAL_LINKS) {
      const res = await get(h, cookie, l.href)
      expect(res.status, `${l.href} bounced the refused member`).not.toBe(403)
    }
  })

  it('renders those links into the 403 page', async () => {
    const cookie = h.seed({
      userId: 'u-render',
      email: 'render@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    })
    const body = await (await get(h, cookie, MINT_TOKEN)).text()
    for (const l of ORG_ADMIN_REFUSAL_LINKS) expect(body).toContain(`href="${l.href}"`)
  })

  it('carries the same identity + links in the JSON refusal', async () => {
    const cookie = h.seed({ userId: 'u-json', email: 'json@test.com', role: 'member' })
    const res = await post(h, cookie, CREATE_AGENT)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toContain('json@test.com')
  })
})

// ── EVERY gated dashboard route, swept ───────────────────────────────────────
//
// isOrgAdmin gates ~40 dashboard routes. Widening it is the dangerous direction,
// so "a member is still refused" is asserted on ALL of them, not on the two
// routes above plus an argument by analogy. Each entry below is a live
// `if (!isOrgAdmin(auth))` refusal in src/dashboard/index.ts; the sweep drives a
// real request as a plain member (squad-observer, so GETs clear the read floor
// and actually reach the org gate) and requires 403.
//
// DELIBERATELY EXCLUDED, and why — these two call isOrgAdmin as a SHORT-CIRCUIT
// with a squad-read fallback, not as an org-admin gate, so a squad member is
// legitimately allowed through them:
//   GET /squads/:id   (src/dashboard/index.ts ~1529)
//   GET /agents/:id   (src/dashboard/index.ts ~1591)
// Listing them here as "must 403" would assert the opposite of their design.
const GATED: ReadonlyArray<readonly [method: 'GET' | 'POST' | 'DELETE', path: string]> = [
  ['POST', '/admin/secret-env/req-1/bind'],
  ['POST', '/admin/secret-env/req-1/reject'],
  ['GET', '/ops'],
  ['GET', '/deployment'],
  ['GET', '/addons'],
  ['POST', '/addons/marketing-cro-monitor/run'],
  ['POST', '/admin/departments/growth/execute/gate-1'],
  ['POST', '/brain/loops/loop-1/control'],
  ['POST', '/fleet/wake'],
  ['POST', '/fleet/control'],
  ['POST', '/agents'],
  ['POST', '/agents/agent-1/status'],
  ['DELETE', '/agents/agent-1'],
  ['POST', '/agents/agent-1/config'],
  ['POST', '/squads/squad-1/config'],
  ['GET', '/admin/members'],
  ['GET', '/admin/divisions'],
  ['GET', '/admin/keys'],
  ['POST', '/admin/keys/mint'],
  ['GET', '/admin/agent-token'],
  ['POST', '/admin/agent-token/mint'],
  ['GET', '/admin/connectors'],
  ['POST', '/admin/connectors'],
  ['POST', '/admin/connectors/conn-1/rotate'],
  ['POST', '/admin/connectors/conn-1/revoke'],
  ['GET', '/admin/github/status'],
  ['GET', '/admin/github'],
  ['POST', '/admin/github/agent-def'],
  ['POST', '/admin/github/assign-copilot'],
  ['POST', '/admin/github/sync-fleet'],
  ['POST', '/admin/github/execute-task'],
  ['POST', '/admin/github/import-project'],
  ['GET', '/admin/github/connect'],
  ['GET', '/connect/github/callback'],
  ['GET', '/addons/some-console'], // the GET * addon-console catch-all
] as const

describe('the whole gated surface', () => {
  it.each(GATED)('still refuses a plain member: %s %s', async (method, path) => {
    const cookie = h.seed({
      userId: `u-sweep-${method}-${path}`,
      email: `sweep-${method}-${path.replace(/\W/g, '')}@test.com`,
      role: 'member',
      memberGrants: [{ scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
    })
    const res =
      method === 'GET'
        ? await get(h, cookie, path)
        : await dashboardApp.fetch(
            new Request(`${ORIGIN}${path}`, {
              method,
              headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
              body: method === 'DELETE' ? undefined : '{}',
            }),
            h.env,
          )
    expect(res.status).toBe(403)
  })

  it('admits the same sweep for a member holding an org→admin grant', async () => {
    // The mirror image: the sweep above must be refusing for the ORG-ADMIN reason,
    // not because every one of those routes 403s unconditionally. If a route
    // answered 403 to everybody, the sweep would be vacuous — this catches that.
    const cookie = h.seed({
      userId: 'u-sweep-admin',
      email: 'sweep-admin@test.com',
      role: 'member',
      memberGrants: [{ scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const stillForbidden: string[] = []
    let checked = 0
    for (const [method, path] of GATED) {
      if (method !== 'GET') continue
      checked += 1
      const res = await get(h, cookie, path)
      if (res.status === 403) stillForbidden.push(`${method} ${path}`)
    }
    expect(checked).toBeGreaterThan(5) // never let this loop quietly become empty
    expect(stillForbidden).toEqual([])
  })
})
