// mupot — addon-declared Loop instantiation (#471).
//
// Proves the gap found in the root-cause investigation is closed: an addon manifest's
// loops[] (e.g. marketing-cro-monitor's 'website-opportunity-review') now materializes a
// real `loops` row at activation time — idempotently, ownership-tracked via
// addon_resource_ownership (mirroring how departments are claimed), status='paused'
// (defaultState:'disabled' + approvalRequired:true ⇒ the loop EXISTS but never runs).
// Turning a loop 'active' is explicitly out of scope (see docs/superpowers/specs/
// 2026-07-16-marketing-cro-monitor-addon-design.md) — not exercised here.
//
// Uses fixture-addon-with-loop (src/addons/modules/fixture-with-loop.ts), a lifecycle
// fixture with no connector requirements, so these tests exercise the loop-claim
// mechanism in isolation from marketing-cro-monitor's connector preflight. It declares
// the SAME real 'website-opportunity-review' template registered by
// marketing-cro-monitor.ts, so this also proves that production template is valid.
//
// fixture-with-loop.ts is imported directly (not via the shared src/addons/modules
// barrel) so its registration stays local to this test file's module graph and never
// pollutes addon-catalog-enumeration tests in other files (vitest isolates per file).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  activateAddon,
  archiveAddon,
  configureAddon,
  disableAddon,
  installAddon,
  type AddonMutationResult,
} from '../src/addons/service'
import { registerAddon, type AddonManifestV1 } from '../src/addons/registry'
import { FixtureModule } from '../src/departments/modules/fixture'
import { validateLoopSpec } from '../src/loops/manifest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import '../src/addons/modules/fixture-with-loop'

const UNREGISTERED_TEMPLATE_ADDON: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-addon-unregistered-loop',
  name: 'Fixture Addon Unregistered Loop',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.24.0',
  kind: 'native',
  description: 'Lifecycle fixture declaring a templateKey with no registered factory.',
  departments: [{ moduleKey: FixtureModule.key, required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [],
  playbooks: [],
  loops: [{ templateKey: 'no-such-template', defaultState: 'disabled', approvalRequired: true }],
  consoleSections: [],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}
await registerAddon(UNREGISTERED_TEMPLATE_ADDON)

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0014_loops.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const owner = { id: 'owner-1', role: 'owner' } as const
const ADDON_KEY = 'fixture-addon-with-loop'

interface LoopRow {
  id: string
  tenant: string
  squad_id: string | null
  agent_id: string | null
  status: string
  spec: string
  dry_rounds: number
  created_at: string
  updated_at: string
}

interface OwnershipRow {
  id: string
  tenant: string
  installation_id: string
  resource_type: string
  resource_id: string
  resource_key: string
  ownership_mode: string
  preserve_on_release: number
  active: number
  created_at: string
  released_at: string | null
}

function makeDb(tenant = 'tenant-a') {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
  return {
    env: { DB: harness.db, TENANT_SLUG: tenant } as Env,
    loops: () => harness.sqlite.prepare('SELECT * FROM loops ORDER BY created_at, id').all() as LoopRow[],
    claims: () => harness.sqlite.prepare(
      "SELECT * FROM addon_resource_ownership WHERE resource_type = 'loop' ORDER BY created_at, id",
    ).all() as OwnershipRow[],
  }
}

function ok(result: AddonMutationResult) {
  if (!result.ok) throw new Error(`expected successful addon mutation, received ${result.reason}`)
  return result.installation
}

async function activateFixtureWithLoop(db: ReturnType<typeof makeDb>) {
  await installAddon(db.env, owner, ADDON_KEY)
  await configureAddon(db.env, owner, ADDON_KEY)
  return activateAddon(db.env, owner, ADDON_KEY)
}

describe('addon-declared loop instantiation (#471)', () => {
  it('creates the loop row as paused with a valid spec on activation', async () => {
    const db = makeDb()
    const activated = ok(await activateFixtureWithLoop(db))
    expect(activated.state).toBe('active')

    const loops = db.loops()
    expect(loops).toHaveLength(1)
    expect(loops[0].tenant).toBe('tenant-a')
    expect(loops[0].status).toBe('paused')

    const spec = JSON.parse(loops[0].spec)
    expect(spec.kind).toBe('cro')
    const validated = validateLoopSpec(spec)
    expect(validated.ok).toBe(true)
  })

  it('ownership-tracks the loop via addon_resource_ownership (exclusive, active)', async () => {
    const db = makeDb()
    const activated = ok(await activateFixtureWithLoop(db))
    const loops = db.loops()
    const claims = db.claims()

    expect(claims).toHaveLength(1)
    expect(claims[0].installation_id).toBe(activated.id)
    expect(claims[0].resource_type).toBe('loop')
    expect(claims[0].resource_key).toBe('website-opportunity-review')
    expect(claims[0].resource_id).toBe(loops[0].id)
    expect(claims[0].ownership_mode).toBe('exclusive')
    expect(claims[0].active).toBe(1)
  })

  it('does not duplicate the loop row when activation is re-run (idempotent)', async () => {
    const db = makeDb()
    ok(await activateFixtureWithLoop(db))
    expect(db.loops()).toHaveLength(1)

    // Calling activateAddon again while already 'active' takes the idempotent fast
    // path (no new operation, no new claim, no new loop row).
    const second = await activateAddon(db.env, owner, ADDON_KEY)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.idempotent).toBe(true)

    expect(db.loops()).toHaveLength(1)
    expect(db.claims()).toHaveLength(1)
  })

  it('does not duplicate the loop row across a disable/re-activate cycle', async () => {
    const db = makeDb()
    ok(await activateFixtureWithLoop(db))
    const [loopBefore] = db.loops()
    const [claimBefore] = db.claims()

    const disabled = await disableAddon(db.env, owner, ADDON_KEY)
    expect(disabled.ok).toBe(true)
    expect(db.claims()[0].active).toBe(0) // released, not deleted (append-only evidence)
    expect(db.loops()).toHaveLength(1) // the loop row itself is untouched by disable

    const reactivated = await activateAddon(db.env, owner, ADDON_KEY)
    expect(reactivated.ok).toBe(true)

    const loopsAfter = db.loops()
    const claimsAfter = db.claims()
    expect(loopsAfter).toHaveLength(1)
    expect(claimsAfter).toHaveLength(1) // same claim row reactivated, not a new one
    expect(loopsAfter[0].id).toBe(loopBefore.id) // SAME loop row reused, never a duplicate
    expect(claimsAfter[0].id).toBe(claimBefore.id)
    expect(claimsAfter[0].active).toBe(1)
    expect(loopsAfter[0].status).toBe('paused') // addon lifecycle never touches loop status
  })

  it('releases the loop claim on disable so archive is not permanently blocked', async () => {
    const db = makeDb()
    ok(await activateFixtureWithLoop(db))

    const disabled = await disableAddon(db.env, owner, ADDON_KEY)
    expect(disabled.ok).toBe(true)
    expect(db.claims()[0].active).toBe(0)

    // Before this fix, an ownership row for resource_type='loop' would never be
    // released, and archiveAddon's "no active claims remain" transition guard
    // (addon_installations_archive_requires_released_ownership) would fail forever.
    const archived = await archiveAddon(db.env, owner, ADDON_KEY)
    expect(archived.ok).toBe(true)
    if (archived.ok) expect(archived.state).toBe('archived')

    // The loop row itself survives archive (disablePreservesData) — only ownership
    // bookkeeping and the installation lifecycle change.
    expect(db.loops()).toHaveLength(1)
  })

  it('fails loudly (never silently skips) when a manifest names an unregistered template key', async () => {
    const db = makeDb()
    await installAddon(db.env, owner, UNREGISTERED_TEMPLATE_ADDON.key)
    await configureAddon(db.env, owner, UNREGISTERED_TEMPLATE_ADDON.key)

    const result = await activateAddon(db.env, owner, UNREGISTERED_TEMPLATE_ADDON.key)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('write_failed')

    // The installation never reaches 'active' — the failure surfaces before the
    // activation transition, not as a partially-active installation.
    expect(result.ok ? undefined : result.state).not.toBe('active')
    // The ownership claim (the durable reservation) may still have been written before
    // the throw — that is expected and self-heals on a future retry (ensureLoopRow is
    // idempotent-by-id); what must NEVER happen is a materialized loop row with an
    // invalid/missing spec.
    expect(db.loops()).toHaveLength(0)
  })
})
