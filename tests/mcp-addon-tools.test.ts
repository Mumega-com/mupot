// tests/mcp-addon-tools.test.ts — MCP surface for the addon lifecycle mutation tools
// (addon_install/configure/activate/disable/archive, src/mcp/addons.ts).
//
// These tools expose the previously dashboard-only lifecycle routes
// (src/addons/routes.ts `mutate()`, gated by isOrgAdmin(auth) on a session-cookie/OAuth
// AuthContext) to MCP/API callers, gated by the capability-grant equivalent
// (hasWorkspaceAdmin, the org:admin bar). Coverage:
//   1. A grantless / under-privileged member is rejected — both at the central capability
//      FLOOR (invokeTool's chokepoint) and, for a caller who clears the floor on the wrong
//      scope, at the handler's own org-scope check (defense in depth — the floor alone is
//      scope-agnostic, see mcp-capability-floor.test.ts).
//   2. An org-admin capability holder succeeds, and the mutation is attributed to their
//      SERVER-DERIVED memberId (never anything from args — additionalProperties:false on
//      every tool's schema means an attacker-supplied identity-shaped field is rejected
//      before the handler even runs).
//   3. addon_configure rejects invalid/oversized bindings via the SAME shallow validator the
//      HTTP route uses (validateBindingInputs, src/addons/bindings.ts) — no drift between the
//      two entry points.
//   4. addon_activate on an already-active installation reconciles idempotently — the actual
//      regression this surface exists to prevent (2026-07-21 archive+reinstall incident: a
//      human had to click through the dashboard because this tool didn't exist yet, and that
//      path produced an unwanted archive+reinstall instead of a reconcile). Uses
//      fixture-addon-with-loop (src/addons/modules/fixture-with-loop.ts) so the assertion
//      also proves an addon-declared loop claim is never duplicated (PR #439 pattern).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import '../src/addons/modules/fixture-with-loop'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0014_loops.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const TENANT = 'tenant-a'
const ADDON_KEY = 'fixture-addon-with-loop'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    installation: () => harness.sqlite.prepare(
      'SELECT * FROM addon_installations WHERE tenant = ? AND addon_key = ? ORDER BY installed_at DESC LIMIT 1',
    ).get(TENANT, ADDON_KEY) as Record<string, unknown> | undefined,
    loops: () => harness.sqlite.prepare('SELECT * FROM loops').all() as Array<Record<string, unknown>>,
    claims: () => harness.sqlite.prepare(
      "SELECT * FROM addon_resource_ownership WHERE resource_type = 'loop'",
    ).all() as Array<Record<string, unknown>>,
  }
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member', // coarse org-role for a member-token MCP caller is ALWAYS 'member' —
    // see src/mcp/index.ts authenticateMember: "the REAL authorization is `capabilities`".
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

const orgAdmin = auth('admin-member', [grant('admin', 'org', null)])
const grantlessMember = auth('grantless-member', [])
const squadAdminOnly = auth('squad-admin-member', [grant('admin', 'squad', 'squad-X')])

describe('addon lifecycle MCP tools — registry', () => {
  it('all five lifecycle tools are registered with min: admin', () => {
    const names = ['addon_install', 'addon_configure', 'addon_activate', 'addon_disable', 'addon_archive']
    for (const name of names) {
      const spec = TOOLS.find((t) => t.name === name)
      expect(spec, `${name} should be registered`).toBeDefined()
      expect(spec?.min).toBe('admin')
    }
  })
})

describe('addon lifecycle MCP tools — rejection paths', () => {
  it('rejects a fully grantless member at the central capability floor (handler never runs)', async () => {
    const db = makeDb()
    const outcome = await invokeTool(grantlessMember, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.status).toBe(403)
    expect(db.installation()).toBeUndefined()
  })

  it.each(['addon_install', 'addon_configure', 'addon_activate', 'addon_disable', 'addon_archive'])(
    'rejects a squad-scoped (non-org) admin grant on %s — floor is scope-agnostic, the handler is not',
    async (toolName) => {
      const db = makeDb()
      // squadAdminOnly clears the central capability FLOOR (holdsCapabilityFloor is
      // scope-agnostic — an admin grant on ANY scope satisfies a min:'admin' floor). The
      // handler's own hasWorkspaceAdmin(auth) check is what must catch that this is not an
      // ORG admin grant. If it didn't, a squad admin anywhere in the org could mutate the
      // global addon catalog — exactly the cross-scope-confusion class this test guards.
      const outcome = await invokeTool(squadAdminOnly, db.env, toolName, { key: ADDON_KEY }, ORIGIN)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.status).toBe(403)
        expect(outcome.error).toBe('forbidden')
      }
      expect(db.installation()).toBeUndefined()
    },
  )

  it('rejects an attacker-supplied identity-shaped field before the handler runs (schema, not trust)', async () => {
    const db = makeDb()
    const outcome = await invokeTool(
      orgAdmin,
      db.env,
      'addon_install',
      { key: ADDON_KEY, actor: 'someone-else', memberId: 'someone-else' },
      ORIGIN,
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(400)
      expect(outcome.error).toBe('invalid_args')
    }
    expect(db.installation()).toBeUndefined()
  })

  it('rejects an unregistered addon key with 404, gate still runs first for a non-admin caller', async () => {
    const db = makeDb()
    const nonAdmin = await invokeTool(grantlessMember, db.env, 'addon_install', { key: 'no-such-addon' }, ORIGIN)
    expect(nonAdmin.ok).toBe(false)
    if (!nonAdmin.ok) expect(nonAdmin.status).toBe(403) // gate before existence check — no oracle

    const admin = await invokeTool(orgAdmin, db.env, 'addon_install', { key: 'no-such-addon' }, ORIGIN)
    expect(admin.ok).toBe(false)
    if (!admin.ok) {
      expect(admin.status).toBe(404)
      expect(admin.error).toBe('addon_not_registered')
    }
  })
})

describe('addon lifecycle MCP tools — org-admin happy path', () => {
  it('addon_install attributes the installation to the caller\'s server-derived memberId', async () => {
    const db = makeDb()
    const outcome = await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const result = outcome.result as Record<string, unknown>
      expect(result).toMatchObject({ key: ADDON_KEY, state: 'installed', created: true })
    }
    const row = db.installation()
    expect(row?.installed_by).toBe('admin-member')
    expect(row?.latest_actor_id).toBe('admin-member')
  })

  it('addon_install is idempotent on retry (idempotent:true, no duplicate row)', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    const retry = await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result).toMatchObject({ key: ADDON_KEY, idempotent: true })
  })

  it('addon_configure with no bindings succeeds for a zero-connector-requirement addon', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    const outcome = await invokeTool(orgAdmin, db.env, 'addon_configure', { key: ADDON_KEY }, ORIGIN)
    expect(outcome.ok).toBe(true)
  })

  it('addon_configure rejects a bindings array that exceeds the manifest\'s connector requirement count', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    // fixture-addon-with-loop declares connectorRequirements: [] — ANY non-empty bindings
    // array is over the bound. Same rejection the HTTP route gives (validateBindingInputs).
    const outcome = await invokeTool(
      orgAdmin,
      db.env,
      'addon_configure',
      { key: ADDON_KEY, bindings: [{ slot: 'primary', adapter: 'x', bindingKind: 'internal_adapter' }] },
      ORIGIN,
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(400)
      expect(outcome.error).toBe('invalid_args')
    }
  })

  it('addon_configure rejects a malformed binding (invalid bindingKind, missing fields, duplicate slots)', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)

    const badKind = await invokeTool(
      orgAdmin, db.env, 'addon_configure',
      { key: ADDON_KEY, bindings: [{ slot: 'a', adapter: 'x', bindingKind: 'not_a_kind' }] },
      ORIGIN,
    )
    expect(badKind.ok).toBe(false)

    const missingAdapter = await invokeTool(
      orgAdmin, db.env, 'addon_configure',
      { key: ADDON_KEY, bindings: [{ slot: 'a', bindingKind: 'internal_adapter' }] },
      ORIGIN,
    )
    expect(missingAdapter.ok).toBe(false)
  })

  it('addon_activate → addon_disable → addon_archive walks the full lifecycle', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'addon_configure', { key: ADDON_KEY }, ORIGIN)

    const activated = await invokeTool(orgAdmin, db.env, 'addon_activate', { key: ADDON_KEY }, ORIGIN)
    expect(activated.ok).toBe(true)
    if (activated.ok) expect(activated.result).toMatchObject({ key: ADDON_KEY, state: 'active' })

    const disabled = await invokeTool(orgAdmin, db.env, 'addon_disable', { key: ADDON_KEY }, ORIGIN)
    expect(disabled.ok).toBe(true)
    if (disabled.ok) expect(disabled.result).toMatchObject({ key: ADDON_KEY, state: 'disabled' })

    const archived = await invokeTool(orgAdmin, db.env, 'addon_archive', { key: ADDON_KEY }, ORIGIN)
    expect(archived.ok).toBe(true)
    if (archived.ok) expect(archived.result).toMatchObject({ key: ADDON_KEY, state: 'archived' })
  })
})

describe('addon lifecycle MCP tools — activate reconciles idempotently (the incident this closes)', () => {
  // 2026-07-21: re-activating an already-'active' installation through the dashboard UI
  // archived the live installation (id e85b578b…, connector bindings already configured)
  // and created a brand-new 'installed' row with zero bindings, instead of reconciling. That
  // is the class of outcome an agent-drivable addon_activate must never produce: calling it
  // again on a live installation must be a no-op reconcile (idempotent:true, same
  // installation row, any addon-declared loop claim ensured but never duplicated) — never an
  // archive+reinstall.
  it('re-running addon_activate on an already-active installation does not archive or reinstall it', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'addon_configure', { key: ADDON_KEY }, ORIGIN)
    const first = await invokeTool(orgAdmin, db.env, 'addon_activate', { key: ADDON_KEY }, ORIGIN)
    expect(first.ok).toBe(true)

    const installationAfterFirst = db.installation()
    expect(installationAfterFirst?.state).toBe('active')
    const installationId = installationAfterFirst?.id
    expect(db.loops()).toHaveLength(1)
    expect(db.claims()).toHaveLength(1)

    const second = await invokeTool(orgAdmin, db.env, 'addon_activate', { key: ADDON_KEY }, ORIGIN)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.result).toMatchObject({ key: ADDON_KEY, state: 'active', idempotent: true })

    const installationAfterSecond = db.installation()
    // SAME row — never archived, never a fresh 'installed' row created alongside it.
    expect(installationAfterSecond?.id).toBe(installationId)
    expect(installationAfterSecond?.state).toBe('active')
    expect(db.loops()).toHaveLength(1) // no duplicate loop row
    expect(db.claims()).toHaveLength(1) // no duplicate ownership claim

    // No archived row exists anywhere for this addon key — the incident's signature.
    expect(installationAfterSecond?.archived_at).toBeNull()
  })

  it('a fresh install+configure+activate cycle also materializes the loop claim exactly once', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'addon_install', { key: ADDON_KEY }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'addon_configure', { key: ADDON_KEY }, ORIGIN)
    const activated = await invokeTool(orgAdmin, db.env, 'addon_activate', { key: ADDON_KEY }, ORIGIN)
    expect(activated.ok).toBe(true)
    if (activated.ok) expect(activated.result).not.toMatchObject({ idempotent: true })

    expect(db.loops()).toHaveLength(1)
    expect(db.loops()[0].status).toBe('paused')
    expect(db.claims()).toHaveLength(1)
  })
})
