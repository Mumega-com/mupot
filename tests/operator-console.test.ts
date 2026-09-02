// tests/operator-console.test.ts — the operator console (GET /operator,
// POST /operator/*), against the real migration chain.
//
// Coverage this file targets, per the brief that shipped this page:
//   1. loadOperatorRoster renders an INELIGIBLE agent WITH its reason in a
//      PARTIAL list — the exact #1254 gap (listConsentableAgents' INNER JOIN
//      silently drops unminted/paused/inactive/no-capability agents, and its
//      only explanatory copy fires when the whole list is empty).
//   2. A caller-supplied slug on the create-agent FORM cannot influence the
//      created agent's slug — it is always derived from the name server-side.
//   3. CSRF refusal (dashboard-wide hono/csrf) on every mutating route.
//   4. An agent-bound caller is refused by every flow function AND by the
//      page-level gate — operator_principal_required, never satisfied by a
//      dashboard session (which never carries a boundAgentId at all).
//   5. No raw credential appears anywhere in this page's own responses.
//
// Schema via createSqliteD1 + applyAllMigrations only — no hand-written
// CREATE TABLE (tests/helpers/migrations.ts).

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import {
  createAgentFlow,
  createProjectFlow,
  createSquadFlow,
  deriveSlugFromName,
  linkProjectSquadFlow,
  loadOperatorConsoleView,
  loadOperatorRoster,
  operatorConsoleBody,
  requireOperatorConsoleAuthority,
  rosterReasonCopy,
  setAgentCapabilityFlow,
} from '../src/dashboard/operator-console'
import type { AuthContext, Env } from '../src/types'

async function render(value: unknown): Promise<string> {
  return String(await value)
}

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const DEPT_A = 'dept-a'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const HUMAN_ADMIN = 'member-admin'
const HUMAN_PLAIN = 'member-plain'

const AGENT_ELIGIBLE = 'agent-eligible'
const AGENT_UNMINTED = 'agent-unminted'
const AGENT_PAUSED = 'agent-paused'
const AGENT_INACTIVE = 'agent-inactive'
const AGENT_NOCAP = 'agent-nocap'

const CSRF_FORBIDDEN_BODY = 'Forbidden'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    -- Unmetered tier: this file exercises operator-console logic, not the
    -- billing entitlement gates (free tier is maxAgents:2/maxSquads:1, which
    -- the 5-agent/2-squad seed below would immediately exceed).
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');

    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_A}', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A}', '${DEPT_A}', 'squad-a', 'River Squad'),
      ('${SQUAD_B}', '${DEPT_A}', 'squad-b', 'Ghost Squad');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${HUMAN_ADMIN}', 'admin@pot.test', 'Squad Admin', 'active', '${TENANT}'),
      ('${HUMAN_PLAIN}', 'plain@pot.test', 'Plain Member', 'active', '${TENANT}'),
      ('member-agent-eligible', NULL, 'Eligible Agent', 'active', '${TENANT}'),
      ('member-agent-paused', NULL, 'Paused Agent', 'active', '${TENANT}'),
      ('member-agent-inactive', NULL, 'Inactive Agent', 'active', '${TENANT}'),
      ('member-agent-nocap', NULL, 'No-Cap Agent', 'active', '${TENANT}');

    -- HUMAN_ADMIN gets an ORG-wide admin grant (so HTTP-level tests, which
    -- resolve capabilities from D1 via the session's email, can pass the
    -- page's isOrgAdmin gate AND every squad-scoped write) PLUS the same
    -- squad-A-only grant adminAuth() below builds by hand for DIRECT
    -- flow-function calls, so the two never drift apart. HUMAN_PLAIN holds
    -- only a squad-member grant — a real account, but not org-admin.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-admin-a', '${HUMAN_ADMIN}', 'squad', '${SQUAD_A}', 'admin'),
      ('cap-admin-org', '${HUMAN_ADMIN}', 'org', NULL, 'admin'),
      ('cap-plain-a', '${HUMAN_PLAIN}', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-eligible', 'member-agent-eligible', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-paused', 'member-agent-paused', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-inactive', 'member-agent-inactive', 'squad', '${SQUAD_A}', 'member'),
      ('cap-agent-nocap', 'member-agent-nocap', 'squad', '${SQUAD_B}', 'member');

    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_ELIGIBLE}', '${SQUAD_A}', 'eligible-agent', 'Eligible Agent', 'member', 'test', 'active'),
      ('${AGENT_UNMINTED}', '${SQUAD_A}', 'unminted-agent', 'Unminted Agent', 'member', 'test', 'active'),
      ('${AGENT_PAUSED}', '${SQUAD_A}', 'paused-agent', 'Paused Agent', 'member', 'test', 'paused'),
      ('${AGENT_INACTIVE}', '${SQUAD_A}', 'inactive-agent', 'Inactive Agent', 'member', 'test', 'inactive'),
      ('${AGENT_NOCAP}', '${SQUAD_B}', 'nocap-agent', 'No-Cap Agent', 'member', 'test', 'active');

    -- The routing membership every agent gets on its home squad at
    -- create_agent time (org/service.ts prepareAgentCreate) — present for
    -- ALL five, independent of binding, exactly like production.
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('mem-eligible', '${AGENT_ELIGIBLE}', '${SQUAD_A}', 'member'),
      ('mem-unminted', '${AGENT_UNMINTED}', '${SQUAD_A}', 'member'),
      ('mem-paused', '${AGENT_PAUSED}', '${SQUAD_A}', 'member'),
      ('mem-inactive', '${AGENT_INACTIVE}', '${SQUAD_A}', 'member'),
      ('mem-nocap', '${AGENT_NOCAP}', '${SQUAD_B}', 'member');

    -- Every agent EXCEPT the unminted one has a binding — the unminted one is
    -- the whole point of the test: a real row with no binding at all.
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_ELIGIBLE}', 'member-agent-eligible', datetime('now')),
      ('${TENANT}', '${AGENT_PAUSED}', 'member-agent-paused', datetime('now')),
      ('${TENANT}', '${AGENT_INACTIVE}', 'member-agent-inactive', datetime('now')),
      ('${TENANT}', '${AGENT_NOCAP}', 'member-agent-nocap', datetime('now'));
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: (() => {
      const store = new Map<string, string>()
      return {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value) },
        delete: async (key: string) => { store.delete(key) },
      }
    })(),
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) },
    BUS: { send: async () => {} },
    BLOBS: {},
    AI: {},
    AGENT: {},
    SQUAD: {},
  } as unknown as Env
}

/** The human-side AuthContext used for direct flow-function calls — squad-A
 *  admin, no org-wide grant, exactly matching the seed above. */
function adminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u-admin',
    email: 'admin@pot.test',
    role: 'member',
    tenant: TENANT,
    memberId: HUMAN_ADMIN,
    capabilities: [{ member_id: HUMAN_ADMIN, scope_type: 'squad', scope_id: SQUAD_A, capability: 'admin' }],
    boundAgentId: null,
    ...overrides,
  }
}

function sessionRecord(email: string, role: 'owner' | 'admin' | 'member' = 'member'): string {
  return JSON.stringify({ userId: `u-${email}`, email, role, createdAt: '2026-01-01T00:00:00Z' })
}

/** A real HTTP session bridged (by email, role: 'member') to HUMAN_ADMIN —
 *  its org-wide admin capability row resolves from D1, exactly the path a
 *  real signed-in operator takes. Not the legacy role='owner' escape hatch:
 *  that column carries NO capabilities rows at all (loadAuthFromCookie only
 *  bridges role:'member' sessions to D1 grants), which passes isOrgAdmin's
 *  legacy branch but then fails every squad-scoped write this page makes —
 *  proving that mismatch cost a false failure the first time this file ran. */
async function withAdminSession(env: Env): Promise<string> {
  const sid = 's-admin'
  await (env.SESSIONS as { put: (k: string, v: string) => Promise<void> }).put(
    `sess:${sid}`,
    sessionRecord('admin@pot.test', 'member'),
  )
  return sid
}

function postForm(path: string, sessionId: string, values: Record<string, string>, headers: Record<string, string> = {}): Request {
  const hdrs = new Headers(headers)
  // Same-origin by default — hono/csrf requires Origin present AND matching;
  // a CSRF-negative test overrides this to a foreign origin explicitly.
  if (!hdrs.has('Origin')) hdrs.set('Origin', ORIGIN)
  hdrs.set('Cookie', `mupot_session=${sessionId}`)
  hdrs.set('content-type', 'application/x-www-form-urlencoded')
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: hdrs, body: new URLSearchParams(values) })
}

function getPage(path: string, sessionId: string): Request {
  const hdrs = new Headers({ Cookie: `mupot_session=${sessionId}` })
  return new Request(`${ORIGIN}${path}`, { headers: hdrs })
}

describe('operator console', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  // ── requirement 1: partial-list reasons ─────────────────────────────────
  describe('loadOperatorRoster — the whole roster, including what is not usable, with why', () => {
    it('returns every agent — none silently dropped — with a reason on every non-eligible row', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const roster = await loadOperatorRoster(env, adminAuth())

      expect(roster).toHaveLength(5)
      const byId = new Map(roster.map((r) => [r.id, r]))

      const eligible = byId.get(AGENT_ELIGIBLE)!
      expect(eligible.eligible).toBe(true)
      expect(eligible.reason).toBeNull()

      const unminted = byId.get(AGENT_UNMINTED)!
      expect(unminted.eligible).toBe(false)
      expect(unminted.reason).toBe('unminted')
      expect(unminted.bound).toBe(false)

      const paused = byId.get(AGENT_PAUSED)!
      expect(paused.eligible).toBe(false)
      expect(paused.reason).toBe('paused')

      const inactive = byId.get(AGENT_INACTIVE)!
      expect(inactive.eligible).toBe(false)
      expect(inactive.reason).toBe('inactive')

      const nocap = byId.get(AGENT_NOCAP)!
      expect(nocap.eligible).toBe(false)
      expect(nocap.reason).toBe('no_capability')

      // Every non-eligible row has non-empty, DISTINCT-per-reason remedy copy —
      // the #1254 defect was not "wrong reason", it was "no row at all".
      for (const row of [unminted, paused, inactive, nocap]) {
        const { label, remedy } = rosterReasonCopy(row)
        expect(label.length).toBeGreaterThan(0)
        expect(remedy.length).toBeGreaterThan(0)
      }
      expect(rosterReasonCopy(unminted).remedy).toMatch(/mint/i)
      expect(rosterReasonCopy(paused).remedy).toMatch(/resume/i)
      expect(rosterReasonCopy(inactive).remedy).toMatch(/retired|new agent/i)
      expect(rosterReasonCopy(nocap).remedy).toContain('Ghost Squad')
    })

    it('surfaces the membership/grant-capability divergence (mupot#1261) rather than hiding it', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const roster = await loadOperatorRoster(env, adminAuth())
      const unminted = roster.find((r) => r.id === AGENT_UNMINTED)!
      // Every fresh agent gets a `memberships` row at create time but no
      // `capabilities` row until it is minted — the divergence must be VISIBLE,
      // not coalesced into one field.
      expect(unminted.membership_capability).toBe('member')
      expect(unminted.grant_capability).toBeNull()
    })

    it('GET /operator (as the org admin) renders the unminted/paused/inactive rows with their reason text, in a list that is NOT empty', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const sid = await withAdminSession(env)
      const res = await dashboardApp.fetch(getPage('/operator', sid), env)
      expect(res.status).toBe(200)
      const bodyText = await res.text()

      // All five names appear — nothing is silently absent.
      for (const name of ['Eligible Agent', 'Unminted Agent', 'Paused Agent', 'Inactive Agent', 'No-Cap Agent']) {
        expect(bodyText).toContain(name)
      }
      // The reason labels render, not just a generic "not usable". Note:
      // 'no capability on that squad' is intentionally NOT asserted here — an
      // org-wide admin grant (what withAdminSession carries, and what the
      // page's own gate requires to get in at all) inherits to every squad by
      // construction (hasCapability: "an org-wide grant covers every
      // scope"), so it is correctly unreachable for THIS viewer. The next
      // test renders the same roster through a narrower, squad-scoped-only
      // viewer to prove that reason's copy actually exists and renders.
      expect(bodyText).toMatch(/not minted yet/i)
      expect(bodyText).toMatch(/paused/i)
      expect(bodyText).toMatch(/retired/i)
    })

    it('renders "no capability on that squad" for a viewer who is NOT admin everywhere (bypassing the org-admin page gate on purpose, to reach loadOperatorRoster/operatorConsoleBody directly)', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      // adminAuth()'s default grant is squad-A-only admin — exactly the
      // account the roster-reason unit tests above already proved yields
      // reason: 'no_capability' for the SQUAD_B agent.
      const view = await loadOperatorConsoleView(env, adminAuth())
      const bodyText = await render(operatorConsoleBody(view))
      expect(bodyText).toContain('No-Cap Agent')
      expect(bodyText).toMatch(/no capability on that squad/i)
      expect(bodyText).toContain('Ghost Squad')
    })
  })

  // ── requirement 2: server-derived agent slug ────────────────────────────
  describe('agent slug is always server-derived, never taken from the caller', () => {
    it('createAgentFlow ignores any slug field on the input type entirely (derives from name)', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const result = await createAgentFlow(env, adminAuth(), { squadRef: SQUAD_A, name: 'My Cool Agent' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.slug).toBe(deriveSlugFromName('My Cool Agent'))
        expect(result.value.slug).toBe('my-cool-agent')
      }
    })

    it('POST /operator/agents with a smuggled slug field in the form body cannot influence the created slug', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const sid = await withAdminSession(env)
      const res = await dashboardApp.fetch(
        postForm('/operator/agents', sid, {
          squad: SQUAD_A,
          name: 'Totally Normal Agent',
          // The route handler never reads this field at all — proven by
          // asserting the STORED row, not just the response.
          slug: 'evil-slug-nobody-derived',
        }),
        env,
      )
      expect(res.status).toBe(200)
      const row = harness.sqlite
        .prepare(`SELECT slug FROM agents WHERE name = ?`)
        .get('Totally Normal Agent') as { slug: string } | undefined
      expect(row).toBeDefined()
      expect(row!.slug).toBe('totally-normal-agent')
      expect(row!.slug).not.toBe('evil-slug-nobody-derived')
    })

    it('refuses a derived slug that already exists tenant-wide, naming the colliding squad', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      // 'eligible-agent' already exists in SQUAD_A. Ask for it again in SQUAD_B
      // via a name that derives to the exact same slug — the tenant-wide guard,
      // not the per-squad UNIQUE constraint, must be what catches this (SQUAD_B
      // has no existing row with this slug, so the DB constraint alone would
      // have allowed it).
      const grants = [{ member_id: HUMAN_ADMIN, scope_type: 'squad' as const, scope_id: SQUAD_B, capability: 'lead' as const }]
      const result = await createAgentFlow(
        env,
        adminAuth({ capabilities: grants }),
        { squadRef: SQUAD_B, name: 'Eligible Agent' },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('slug_taken')
        expect(result.detail).toContain('River Squad')
      }
      const count = (harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM agents WHERE slug = 'eligible-agent'`)
        .get() as { n: number }).n
      expect(count).toBe(1)
    })
  })

  // ── requirement 3: CSRF on every mutating route ─────────────────────────
  describe('CSRF (dashboard-wide hono/csrf) refuses every mutating route', () => {
    const routes: Array<{ path: string; values: Record<string, string> }> = [
      { path: '/operator/agents', values: { squad: SQUAD_A, name: 'CSRF Agent' } },
      { path: '/operator/squads', values: { department: DEPT_A, name: 'CSRF Squad' } },
      { path: '/operator/projects', values: { name: 'CSRF Project' } },
      { path: '/operator/projects/link', values: { project_id: 'nonexistent', squad_id: SQUAD_A, access_level: 'read' } },
      { path: '/operator/capability', values: { agent: AGENT_ELIGIBLE, squad: SQUAD_A, capability: 'member' } },
    ]

    for (const { path, values } of routes) {
      it(`rejects a cross-origin POST to ${path} (403 Forbidden, nothing written)`, async () => {
        harness = makeHarness()
        const env = envFor(harness)
        const sid = await withAdminSession(env)
        const agentCountBefore = (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n
        const squadCountBefore = (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM squads`).get() as { n: number }).n
        const projectCountBefore = (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n

        const res = await dashboardApp.fetch(postForm(path, sid, values, { Origin: 'https://evil.example' }), env)

        expect(res.status).toBe(403)
        expect(await res.text()).toBe(CSRF_FORBIDDEN_BODY)
        expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n).toBe(agentCountBefore)
        expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM squads`).get() as { n: number }).n).toBe(squadCountBefore)
        expect((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n).toBe(projectCountBefore)
      })
    }
  })

  // ── requirement 4: operator_principal_required ──────────────────────────
  describe('an agent-bound caller is refused (operator_principal_required)', () => {
    it('requireOperatorConsoleAuthority refuses a bound caller before the org-admin check', () => {
      const bound = adminAuth({ boundAgentId: AGENT_ELIGIBLE, capabilities: [], role: 'owner' })
      const outcome = requireOperatorConsoleAuthority(bound)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('operator_principal_required')
    })

    it('every mutation flow refuses a bound caller independently of the route-level gate', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const bound = adminAuth({ boundAgentId: AGENT_ELIGIBLE, role: 'owner' })

      const agentResult = await createAgentFlow(env, bound, { squadRef: SQUAD_A, name: 'Should Not Exist' })
      expect(agentResult).toEqual({ ok: false, error: 'operator_principal_required' })

      const squadResult = await createSquadFlow(env, bound, { departmentRef: DEPT_A, name: 'Should Not Exist' })
      expect(squadResult).toEqual({ ok: false, error: 'operator_principal_required' })

      const projectResult = await createProjectFlow(env, bound, { name: 'Should Not Exist' })
      expect(projectResult).toEqual({ ok: false, error: 'operator_principal_required' })

      const linkResult = await linkProjectSquadFlow(env, bound, { projectId: 'x', squadId: SQUAD_A, accessLevel: 'read' })
      expect(linkResult).toEqual({ ok: false, error: 'operator_principal_required' })

      const capResult = await setAgentCapabilityFlow(env, bound, { agentRef: AGENT_ELIGIBLE, squadRef: SQUAD_A, capability: 'member' })
      expect(capResult).toEqual({ ok: false, error: 'operator_principal_required' })

      // Nothing was created despite the org-owner role riding along.
      const count = (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agents WHERE name = 'Should Not Exist'`).get() as { n: number }).n
      expect(count).toBe(0)
    })
  })

  // ── requirement 5: no raw credential anywhere in this page ──────────────
  describe('never renders a raw credential', () => {
    it('GET /operator contains no <code class="token"> (the show-once raw-token marker from enroll.ts) and no bearer-shaped string', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const sid = await withAdminSession(env)
      const res = await dashboardApp.fetch(getPage('/operator', sid), env)
      const bodyText = await res.text()
      expect(bodyText).not.toContain('class="token"')
      expect(bodyText).not.toMatch(/mupot_[A-Za-z0-9]{16,}/)
    })

    it('the inline mint form for an unminted agent POSTs to the EXISTING /enroll/mint route and carries no token field', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const sid = await withAdminSession(env)
      const res = await dashboardApp.fetch(getPage('/operator', sid), env)
      const bodyText = await res.text()
      expect(bodyText).toContain('action="/enroll/mint"')
      expect(bodyText).not.toMatch(/name="token"/)
      expect(bodyText).not.toMatch(/name="raw"/)
    })
  })

  // ── page-level gate ──────────────────────────────────────────────────────
  describe('page-level authority', () => {
    it('a non-org-admin member is refused with a named remedy, not a blank 403', async () => {
      harness = makeHarness()
      const env = envFor(harness)
      const sid = 's-plain'
      await (env.SESSIONS as { put: (k: string, v: string) => Promise<void> }).put(
        `sess:${sid}`,
        sessionRecord('plain@pot.test', 'member'),
      )
      // plain@pot.test only holds a squad-member grant on SQUAD_A (seeded
      // above) — no org-scope capability at all — so this must be refused.
      const res = await dashboardApp.fetch(getPage('/operator', sid), env)
      expect(res.status).toBe(403)
      const bodyText = await res.text()
      expect(bodyText.length).toBeGreaterThan(0)
    })
  })
})
