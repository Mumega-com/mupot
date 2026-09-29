// mupot#1580 slice 2 (T2) — the three office.* MCP tools (src/mcp/office.ts,
// src/addons/office/service.ts): office.publish_post, office.list_pending_approvals,
// office.review_approval.
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations(). Fetch to
// WordPress is stubbed (global fetch); the vaulted connector credential path
// (useConnectorById/encryptConnectorSecret) is real.
//
// KNOWN, REPORTED GAP (see src/addons/office/service.ts's file header and the PR body):
// mcpwp-office cannot reach 'active' through the REAL install→configure→activate
// lifecycle today — src/addons/bindings.ts's preflightAddonBindings unconditionally
// refuses ANY connectorRequirements entry whose capability is 'write' (capability_
// mismatch), and addon_connector_bindings.capability is even schema-CHECK'd to 'read'
// only (migrations/0052_addon_bindings.sql). Both are pre-existing, out of scope for
// this PR (a lifecycle/schema change affecting every addon, not this one's tools).
// seedActiveOfficeInstallation below constructs the addon_installations/addon_receipts/
// addon_binding_generations/addon_connector_bindings rows DIRECTLY — mirroring exactly
// what installAddon→configureAddon→activateAddon would have written once that gap is
// fixed — because the tools under test only ever READ that state (listAddonInstallations/
// listAddonBindings), never the lifecycle mutators themselves. A regression test below
// (`activateAddon really does refuse this addon today`) pins the gap itself so this
// workaround is never silently forgotten.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { invokeTool } from '../src/mcp/index'
import '../src/mcp/office'
import { activateAddon, installAddon } from '../src/addons/service'
import { createTask } from '../src/tasks/service'
import * as bindingsModule from '../src/addons/bindings'
import { publishOfficePost } from '../src/addons/office/service'
import { resolveActiveOfficeInstallationId, buildOfficePublishFreeze } from '../src/addons/office/freeze'
import type { Task } from '../src/types'

const TENANT = 'tenant-office-tools'
const MASTER_KEY = '33'.repeat(32)
const SHA = 'd'.repeat(64)
const ORIGIN = 'https://mupot.mumega.com'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

function env(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY } as Env
}

/** mupot#1602 r1 P1: a deterministic interleave — wraps `db.prepare` so that the
 *  FIRST call whose SQL contains `match` runs `interleave()` (synchronously,
 *  before the real statement executes), simulating another request's write
 *  landing in the exact window between reviewOfficeApproval's hash SELECT and
 *  its verdict batch. Fires once; every other call passes through untouched. */
function envWithInterleave(harness: SqliteD1Harness, match: string, interleave: () => void): Env {
  let fired = false
  const realDb = harness.db
  const wrappedDb = {
    ...realDb,
    prepare(sql: string) {
      if (!fired && sql.includes(match)) {
        fired = true
        interleave()
      }
      return realDb.prepare(sql)
    },
  }
  return { DB: wrappedDb, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY } as unknown as Env
}

function auth(memberId: string, capabilities: CapabilityGrant[], role: AuthContext['role'] = 'member'): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role,
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

function grant(scopeType: CapabilityGrant['scope_type'], scopeId: string | null, capability: CapabilityGrant['capability']): CapabilityGrant {
  return { member_id: 'n/a', scope_type: scopeType, scope_id: scopeId, capability } as CapabilityGrant
}

// An org:owner GRANT (not just AuthContext.role) — needed because some tools' inline
// squad/department checks (e.g. task_update's memberCanOnSquad) read auth.capabilities
// directly and have no legacy-role escape at all; a real org-scope 'owner' grant covers
// every squad/department via planeCoversScope, so this one fixture works everywhere a
// generic "the real owner, doing fixture setup" caller is needed.
function orgOwnerAuth(memberId = 'owner-1'): AuthContext {
  return auth(memberId, [grant('org', null, 'owner')], 'owner')
}

/** Seeds the office department + a squad under it (departments/squads have no tenant
 *  column — single-tenant-per-DB, per migrations/0001_init.sql). Returns their ids. */
function seedOfficeDepartmentAndSquad(harness: SqliteD1Harness): { departmentId: string; squadId: string } {
  const departmentId = 'dept-office-1'
  const squadId = 'squad-office-1'
  harness.sqlite.prepare(
    `INSERT INTO departments (id, slug, name) VALUES (?, 'office', 'Office')`,
  ).run(departmentId)
  harness.sqlite.prepare(
    `INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, 'site-operator', 'Site Operator')`,
  ).run(squadId, departmentId)
  return { departmentId, squadId }
}

/** A department the caller does NOT hold office capability on — for the "wrong
 *  department capability" refusal test. */
function seedUnrelatedDepartment(harness: SqliteD1Harness): string {
  const departmentId = 'dept-unrelated-1'
  harness.sqlite.prepare(
    `INSERT INTO departments (id, slug, name) VALUES (?, 'unrelated', 'Unrelated')`,
  ).run(departmentId)
  return departmentId
}

/**
 * Constructs the addon_installations/addon_receipts/addon_binding_generations/
 * addon_connector_bindings rows exactly as installAddon → configureAddon →
 * activateAddon would have left them for mcpwp-office — see the file header for why
 * this bypasses those functions directly instead of calling them.
 */
function seedActiveOfficeInstallation(harness: SqliteD1Harness, connectorId: string): string {
  const installationId = 'inst-office-tools-1'
  const installReceipt = 'recpt-office-install-1'
  const configureReceipt = 'recpt-office-configure-1'
  const activateReceipt = 'recpt-office-activate-1'
  const actorId = 'owner-1'

  harness.sqlite.exec('BEGIN')
  try {
    harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES (?, ?, 'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed',
        ?, '^0.31.0', 'installed', NULL, ?, ?, ?, '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'external_isolated')
    `).run(installationId, TENANT, SHA, actorId, actorId, installReceipt)
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES (?, ?, ?, 'install', NULL, 'installed', 'mcpwp-office', '1.0.0', 'mumega',
        'native_reviewed', '^0.31.0', ?, ?, 'pass', '[]', '{}', '2026-01-01T00:00:00.000Z',
        'external_isolated')
    `).run(installReceipt, TENANT, installationId, SHA, actorId)

    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET state = 'configured', latest_previous_state = 'installed',
             latest_receipt_id = ?, latest_actor_id = ?, configured_at = ?, updated_at = ?
       WHERE id = ?
    `).run(configureReceipt, actorId, '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z', installationId)
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES (?, ?, ?, 'configure', 'installed', 'configured', 'mcpwp-office', '1.0.0',
        'mumega', 'native_reviewed', '^0.31.0', ?, ?, 'pass', '[]', '{}',
        '2026-01-01T00:01:00.000Z', 'external_isolated')
    `).run(configureReceipt, TENANT, installationId, SHA, actorId)

    // addon_binding_generations_fence_installation (migrations/0052) requires the
    // installation's CURRENT state/latest_receipt_id to match expected_installation_
    // state/base_receipt_id AT INSERT TIME — so the generation row must be inserted
    // here, while the installation is still 'configured' with configureReceipt as its
    // latest receipt (exactly when the real configureAddonBindings would have written
    // it), BEFORE the 'active' transition below moves both fields on.
    const generationId = 'gen-office-1'
    harness.sqlite.prepare(`
      INSERT INTO addon_binding_generations (
        id, tenant, installation_id, configuration_sha256, binding_count, manifest_sha256,
        configured_by, configured_at, revoked_at, previous_generation_id,
        expected_installation_state, base_receipt_id
      ) VALUES (?, ?, ?, ?, 1, ?, ?, '2026-01-01T00:01:00.000Z', NULL, NULL, 'configured', ?)
    `).run(generationId, TENANT, installationId, 'e'.repeat(64), SHA, actorId, configureReceipt)
    harness.sqlite.prepare(`
      INSERT INTO addon_connector_bindings (
        id, tenant, installation_id, generation_id, slot, adapter, binding_kind,
        capability, connector_id, manifest_sha256, configured_by, configured_at, revoked_at
      ) VALUES ('binding-office-1', ?, ?, ?, 'wordpress_site', 'mcpwp', 'vault_connector',
        'read', ?, ?, ?, '2026-01-01T00:01:00.000Z', NULL)
    `).run(TENANT, installationId, generationId, connectorId, SHA, actorId)

    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET state = 'active', latest_previous_state = 'configured',
             latest_receipt_id = ?, latest_actor_id = ?, activated_at = ?, updated_at = ?
       WHERE id = ?
    `).run(activateReceipt, actorId, '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:00.000Z', installationId)
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES (?, ?, ?, 'activate', 'configured', 'active', 'mcpwp-office', '1.0.0',
        'mumega', 'native_reviewed', '^0.31.0', ?, ?, 'pass', '[]', '{}',
        '2026-01-01T00:02:00.000Z', 'external_isolated')
    `).run(activateReceipt, TENANT, installationId, SHA, actorId)

    harness.sqlite.exec('COMMIT')
  } catch (error) {
    harness.sqlite.exec('ROLLBACK')
    throw error
  }
  return installationId
}

async function seedWordpressConnector(harness: SqliteD1Harness, siteUrl: string, secret: string): Promise<string> {
  const id = 'connector-office-wordpress'
  const encrypted = await encryptConnectorSecret(MASTER_KEY, id, 'mcpwp', secret)
  const meta = JSON.stringify({ siteUrl, username: 'office-agent' })
  harness.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'Office WordPress site', ?, ?, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(id, TENANT, encrypted, meta)
  return id
}

/** A real task, gated under this addon's own 'gate:office' namespace, in 'review'.
 *  Task status transitions are open -> in_progress -> review (src/tasks/service.ts
 *  TRANSITIONS) — two task_update hops, not a direct open -> review. */
async function makeOfficeTask(testEnv: Env, squadId: string): Promise<string> {
  const task = await createTask(
    testEnv,
    { squad_id: squadId, title: 'Publish: Q4 recap', done_when: 'post is live', gate_owner: 'gate:office' },
    { skipMirror: true, skipEvent: true },
  )
  const toInProgress = await invokeTool(
    orgOwnerAuth('seed'), testEnv, 'task_update', { task_id: task.id, status: 'in_progress' }, ORIGIN,
  )
  if (!toInProgress.ok) throw new Error(`fixture error: could not move task to in_progress: ${JSON.stringify(toInProgress)}`)
  const updated = await invokeTool(
    orgOwnerAuth('seed'),
    testEnv,
    'task_update',
    { task_id: task.id, status: 'review' },
    ORIGIN,
  )
  if (!updated.ok) throw new Error(`fixture error: could not move task to review: ${JSON.stringify(updated)}`)
  return task.id
}

/** mupot#1592 NEW-1: reads the hash office.list_pending_approvals would show a
 *  human — the same value office.review_approval now requires as
 *  expected_payload_sha256. Queries the addon's own table directly (not via the
 *  MCP tool) so this stays a pure fixture helper, independent of caller auth. */
async function officeFreezeHash(testEnv: Env, taskId: string): Promise<string | null> {
  const row = await testEnv.DB.prepare(
    `SELECT payload_sha256 FROM office_publish_freezes WHERE task_id = ?1 AND voided_at IS NULL`,
  ).bind(taskId).first<{ payload_sha256: string }>()
  return row?.payload_sha256 ?? null
}

async function approveOfficeTask(testEnv: Env, taskId: string): Promise<void> {
  const owner = orgOwnerAuth()
  const expectedPayloadSha256 = await officeFreezeHash(testEnv, taskId)
  // A real caller with no hash to report (no live freeze exists yet) simply omits
  // the field — the schema types it as an optional string, never null.
  const args: Record<string, unknown> = { task_id: taskId, verdict: 'approved' }
  if (expectedPayloadSha256) args.expected_payload_sha256 = expectedPayloadSha256
  const result = await invokeTool(owner, testEnv, 'office.review_approval', args, ORIGIN)
  if (!result.ok) throw new Error(`fixture error: could not approve office task: ${JSON.stringify(result)}`)
}

const officeLead = (departmentId: string) => auth('lead-1', [grant('department', departmentId, 'lead')])
const officeMember = (departmentId: string) => auth('member-1', [grant('department', departmentId, 'member')])
const wrongDeptCaller = (unrelatedDepartmentId: string) => auth('outsider-1', [grant('department', unrelatedDepartmentId, 'lead')])

beforeEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Wraps the REAL listAddonBindings (real D1 read) but reports the office
 *  wordpress_site binding's capability as 'write' — simulating the day T2b's
 *  schema/lifecycle gap (addon_connector_bindings.capability is CHECK'd to 'read'
 *  only today, migrations/0052) is fixed and a real write-capable binding becomes
 *  possible. Used ONLY to exercise office.publish_post's freeze/claim/fetch
 *  mechanics end to end; every OTHER test in this file exercises the REAL,
 *  currently-CHECK'd-to-'read' schema untouched. */
function mockWriteCapableOfficeBinding(): void {
  const original = bindingsModule.listAddonBindings
  vi.spyOn(bindingsModule, 'listAddonBindings').mockImplementation(async (mockEnv, installationId) => {
    const real = await original(mockEnv, installationId)
    return real.map((row) => (
      row.slot === 'wordpress_site' ? { ...row, capability: 'write' as unknown as typeof row.capability } : row
    ))
  })
}

describe('the known lifecycle gap this file works around (regression pin)', () => {
  it('activateAddon really does refuse mcpwp-office today (capability_mismatch) — do not silently start relying on the real lifecycle here', async () => {
    const harness = makeHarness()
    const owner = { id: 'owner-1', role: 'owner' as const }
    await installAddon(env(harness), owner, 'mcpwp-office')
    const activated = await activateAddon(env(harness), owner, 'mcpwp-office')
    expect(activated).toEqual({ ok: false, reason: 'capability_mismatch', state: 'installed' })
    harness.close()
  })

  // P3-2 (kasra-review adversarial round 1, PR #1588): the ORIGINAL resolver did
  // `.find(row => row.addonKey === OFFICE_ADDON_KEY)` and only then checked
  // state/trustClass — the FIRST row for this addon key in installed_at order, not
  // necessarily the active one. After an archive followed by a reinstall, the OLDER
  // archived row sorts first, `.find` returns it, sees state !== 'active', and
  // returns null FOREVER even though a genuinely active reinstalled row exists.
  it('resolves the ACTIVE installation, not simply the first one, after an archive followed by a reinstall', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)

    // An OLDER, ARCHIVED row for the same addon key — sorts FIRST in
    // listAddonInstallations' `ORDER BY installed_at ASC`. addon_installations'
    // OWN triggers (migrations/0050) require every row to be INSERTed as
    // 'installed' with no previous state, and only allow 'installed' -> 'disabled'
    // -> 'archived' (never a direct 'installed' -> 'archived' UPDATE) — so this
    // walks the same INSERT-then-UPDATE-with-a-fresh-receipt dance
    // seedActiveOfficeInstallation uses below, just to a different end state.
    harness.sqlite.exec('BEGIN')
    harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES ('inst-office-archived', ?, 'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed',
        ?, '^0.31.0', 'installed', NULL, 'owner-1', 'owner-1', 'recpt-archived-install',
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-archived-install', ?, 'inst-office-archived', 'install', NULL, 'installed',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.31.0', ?, 'owner-1', 'pass',
        '[]', '{}', '2025-01-01T00:00:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)

    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET state = 'disabled', latest_previous_state = 'installed',
             latest_receipt_id = 'recpt-archived-disable', latest_actor_id = 'owner-1', updated_at = ?
       WHERE id = 'inst-office-archived'
    `).run('2025-01-01T00:01:00.000Z')
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-archived-disable', ?, 'inst-office-archived', 'disable', 'installed', 'disabled',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.31.0', ?, 'owner-1', 'pass',
        '[]', '{}', '2025-01-01T00:01:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)

    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET state = 'archived', latest_previous_state = 'disabled',
             latest_receipt_id = 'recpt-archived-archive', latest_actor_id = 'owner-1',
             archived_at = ?, updated_at = ?
       WHERE id = 'inst-office-archived'
    `).run('2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z')
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-archived-archive', ?, 'inst-office-archived', 'archive', 'disabled', 'archived',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.31.0', ?, 'owner-1', 'pass',
        '[]', '{}', '2025-01-02T00:00:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)
    harness.sqlite.exec('COMMIT')

    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-reinstall')
    seedActiveOfficeInstallation(harness, connectorId) // the NEWER, active reinstall

    const resolved = await resolveActiveOfficeInstallationId(testEnv)
    expect(resolved).toBe('inst-office-tools-1')
    harness.close()
  })
})

describe('office.publish_post', () => {
  // P3-2 (kasra-review adversarial round 1, PR #1588): the ORIGINAL version of this
  // test published successfully through a binding whose capability is 'read' — the
  // ONLY value addon_connector_bindings.capability can ever hold today (migrations/
  // 0052's CHECK constraint), even though the manifest declares this slot needs
  // 'write'. That was the bug: office.publish_post now checks the binding's
  // capability against what the manifest actually requires and refuses when it
  // does not match — which, given the schema, is always, today. This is the
  // "keep that pinned test" regression the adversarial gate asked for.
  it('refuses to publish through a binding that does not satisfy the required capability (T2b gap), with zero fetches, even though the task IS approved', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const secret = 'wordpress-app-password-xyz'
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', secret)
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('connector_capability_mismatch')
    expect(fetchSpy).not.toHaveBeenCalled()
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('approved')
    harness.close()
  })

  // The real happy path (fetch, one-shot claim, frozen-payload use, task-done
  // receipt) simulated against a write-capable binding — see
  // mockWriteCapableOfficeBinding's doc comment above. This is the ONLY test in
  // this file that does not exercise the real, currently-CHECK'd-to-'read' schema.
  it('publishes the FROZEN payload through the vaulted connector once a write-capable binding exists, and marks the task done as the execution receipt', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const secret = 'wordpress-app-password-xyz'
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', secret)
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    // The frozen payload was computed from task.title/task.body at APPROVAL time —
    // office.publish_post no longer accepts title/content from its caller at all.
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ id: 4242, link: 'https://wordpress.example.com/?p=4242' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result).toEqual({ post_id: 4242, article_url: 'https://wordpress.example.com/?p=4242' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [rawUrl, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const url = new URL(String(rawUrl))
    expect(url.origin).toBe('https://wordpress.example.com')
    expect(url.pathname).toBe('/wp-json/wp/v2/posts')
    const body = JSON.parse(String(init.body)) as { title: string; content: string; status: string }
    // task.title is 'Publish: Q4 recap' (makeOfficeTask) and task.body defaults to
    // '' (createTask's body is optional) — the point of this assertion is that the
    // published body is EXACTLY the frozen task fields, not any caller-supplied value.
    expect(body).toEqual({ title: 'Publish: Q4 recap', content: '', status: 'publish' })

    const row = harness.sqlite.prepare(`SELECT status, result, completed_at FROM tasks WHERE id = ?`).get(taskId) as
      { status: string; result: string | null; completed_at: string | null }
    expect(row.status).toBe('done')
    expect(row.completed_at).not.toBeNull()
    expect(JSON.parse(row.result ?? '{}')).toEqual({ postId: 4242, articleUrl: 'https://wordpress.example.com/?p=4242' })

    const freezeRow = harness.sqlite.prepare(`SELECT outcome, claimed_by FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as
      { outcome: string; claimed_by: string }
    expect(freezeRow.outcome).toBe('done')
    expect(freezeRow.claimed_by).toBe('lead-1')
    harness.close()
  })

  // P0-1 (kasra-review adversarial round 1, PR #1588, repro PA): the caller used to
  // be able to supply ANY title/content at publish time, regardless of what a human
  // approved. office.publish_post's schema no longer accepts title/content at all —
  // a caller that still passes them is refused outright (unknown field), never
  // silently ignored.
  it('refuses a caller-supplied title/content outright — the schema no longer accepts them', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-pa')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: taskId, title: 'TOTALLY DIFFERENT', content: '<p>unapproved content</p>' }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid_args')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  // P1-1 (kasra-review adversarial round 1, PR #1588, repro PB): ONE approval used
  // to permit N WordPress writes — the atomic guard ran AFTER the fetch, so it
  // could only decide which concurrent write got recorded, never stop a second one
  // from actually happening. The claim now runs BEFORE any fetch: exactly one
  // concurrent caller gets past it.
  it('one approval, concurrent publishes -> exactly one fetch and one ok (one-shot claim)', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-pb')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    let calls = 0
    const fetchSpy = vi.fn(async () => {
      calls += 1
      const mine = calls
      await new Promise((resolve) => setTimeout(resolve, 15))
      return new Response(JSON.stringify({ id: 1000 + mine, link: `https://wordpress.example.com/?p=${1000 + mine}` }), { status: 201 })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const results = await Promise.all(
      [1, 2, 3].map(() => invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)),
    )

    expect(fetchSpy).toHaveBeenCalledOnce()
    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(1)
    const refused = results.filter((r) => !r.ok) as Array<{ ok: false; error: string }>
    expect(refused).toHaveLength(2)
    for (const r of refused) expect(r.error).toBe('publish_claimed')

    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('done')
    harness.close()
  })

  // mupot#1592 NEW-2: round 1's design let ANY caller holding a bare gate:office
  // grant approve through the GENERIC task_verdict tool, entirely bypassing
  // office.review_approval (and so the freeze/hash binding it enforces) — the
  // adversarial repro for this: approve -> reverse -> reject -> re-approve via
  // task_verdict, publishing the REJECTED content. Closed at the SOURCE now:
  // writeVerdict() itself refuses to decide ANY gate:office task at all.
  it('task_verdict refuses to decide a gate:office task at all — the ONLY door is office.review_approval', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-bypass')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)

    // A gate:office grant would have been sufficient under round 1's design to
    // approve this task directly — it must not be sufficient any more.
    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('bypass-1', 'bypass@x.t', 'bypass', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-bypass', 'gate:office', 'member', 'bypass-1', 'test', datetime('now'))`,
    ).run()
    const bypassAuth = auth('bypass-1', [grant('squad', squadId, 'member')])
    const verdict = await invokeTool(bypassAuth, testEnv, 'task_verdict', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toBe('dedicated_gate_predicate_required')

    // Nothing was written: the task is still 'review', no verdict row exists, and
    // the freeze this task's review-entry minted is still unbound (verdict_id NULL).
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    const verdictCount = harness.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get(taskId) as { n: number }
    expect(verdictCount.n).toBe(0)
    const freeze = harness.sqlite.prepare(`SELECT verdict_id FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as { verdict_id: string | null }
    expect(freeze.verdict_id).toBeNull()

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const publishResult = await invokeTool(bypassAuth, testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)
    expect(publishResult.ok).toBe(false)
    if (!publishResult.ok) expect(publishResult.error).toBe('not_approved')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses with zero fetches when the task has no verdict yet', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-no-verdict')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    // No approveOfficeTask call — task stays in 'review'.

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: taskId }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_approved')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses with zero fetches when the verdict was rejected', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-rejected')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()
    const rejected = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'rejected' }, ORIGIN)
    expect(rejected.ok).toBe(true)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: taskId }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_approved')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses a task approved under a DIFFERENT gate — an unrelated approved task cannot be laundered into a WordPress write', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-wrong-gate')
    seedActiveOfficeInstallation(harness, connectorId)

    const otherTask = await createTask(
      testEnv,
      { squad_id: squadId, title: 'Unrelated approval', done_when: 'not applicable to this fixture', gate_owner: 'gate:loops' },
      { skipMirror: true, skipEvent: true },
    )
    const owner = orgOwnerAuth()
    await invokeTool(owner, testEnv, 'task_update', { task_id: otherTask.id, status: 'in_progress' }, ORIGIN)
    await invokeTool(owner, testEnv, 'task_update', { task_id: otherTask.id, status: 'review' }, ORIGIN)
    const verdict = await invokeTool(owner, testEnv, 'task_verdict', { task_id: otherTask.id, verdict: 'approved' }, ORIGIN)
    expect(verdict.ok).toBe(true)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: otherTask.id }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('wrong_gate')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses a caller who lacks office department capability, with zero fetches', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const unrelatedDepartmentId = seedUnrelatedDepartment(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-wrong-dept')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      wrongDeptCaller(unrelatedDepartmentId), testEnv, 'office.publish_post',
      { task_id: taskId }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_authorized')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses to APPROVE when the installation was never active — no target was ever resolvable to freeze (mupot#1602 r1 P2-2)', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    // installAddon only — never configured/activated, so listAddonInstallations sees
    // state='installed', not 'active', at review-entry time. buildOfficePublishFreeze
    // returns addon_inactive and freezeOfficeTaskOnReviewEntry silently leaves no
    // freeze row. Round 1's design let the APPROVAL land anyway ("independent of
    // infra readiness") and only publish refused; mupot#1602 r1 P2-2 closed that
    // as a success-shaped no-op on the addon's own main producer of content —
    // approval itself now refuses with no live freeze to bind.
    await installAddon(testEnv, { id: 'owner-1', role: 'owner' }, 'mcpwp-office')
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()

    const result = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('payload_not_frozen')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // The OTHER half: a target WAS resolvable and frozen at approval time, but the
  // installation went inactive before publish (disabled/archived in between) — the
  // drift check must still refuse, using the live re-resolution, not the frozen
  // installation_id blindly.
  it('refuses when the installation was active at approval but is no longer active at publish time', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-went-inactive')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    // Simulate the installation being disabled after approval — addon_installations'
    // own triggers require a fresh receipt on every state change (see the archive
    // test above), and its FK to addon_receipts is DEFERRABLE INITIALLY DEFERRED
    // (migrations/0050) specifically so the UPDATE can reference a receipt id that
    // is only INSERTed afterward, WITHIN the same transaction.
    harness.sqlite.exec('BEGIN')
    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET state = 'disabled', latest_previous_state = 'active',
             latest_receipt_id = 'recpt-office-disable-1', latest_actor_id = 'owner-1', updated_at = ?
       WHERE addon_key = 'mcpwp-office'
    `).run('2026-01-01T00:03:00.000Z')
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-office-disable-1', ?, 'inst-office-tools-1', 'disable', 'active', 'disabled',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.31.0', ?, 'owner-1', 'pass',
        '[]', '{}', '2026-01-01T00:03:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)
    harness.sqlite.exec('COMMIT')

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('addon_inactive')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses SSRF vectors with zero fetches — origin-only URL construction is unaffected by a hostile stored path', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const secret = 'wordpress-secret-ssrf-publish'
    const connectorId = await seedWordpressConnector(harness, 'https://blog.example.com//169.254.169.254/x', secret)
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: taskId }, ORIGIN,
    )

    // The stored siteUrl's HOST ('blog.example.com') is itself public/https, so
    // assertPublicHttpsUrl(config.siteUrl) passes — but the write only ever uses
    // base.origin (a plain string) to build the endpoint, never the hostile pathname,
    // so no host-confusion is possible and no fetch is refused for THAT reason. This
    // test pins that guarantee structurally: whatever the outcome, fetch is never
    // called against the metadata host.
    if (fetchSpy.mock.calls.length > 0) {
      const [rawUrl] = fetchSpy.mock.calls[0] as [string]
      expect(new URL(String(rawUrl)).hostname).toBe('blog.example.com')
    }
    expect(JSON.stringify(result)).not.toContain(secret)
    harness.close()
  })
})

describe('office.list_pending_approvals', () => {
  it('lists office-gated tasks in review, and only those', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const officeTaskId = await makeOfficeTask(testEnv, squadId)
    await createTask(
      testEnv,
      { squad_id: squadId, title: 'Not an office task', done_when: 'not applicable to this fixture', gate_owner: 'gate:loops' },
      { skipMirror: true, skipEvent: true },
    )

    const result = await invokeTool(officeMember(departmentId), testEnv, 'office.list_pending_approvals', {}, ORIGIN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const tasks = (result.result as { tasks: Array<{ id: string }> }).tasks
      expect(tasks.map((task) => task.id)).toEqual([officeTaskId])
    }
    harness.close()
  })

  it('refuses a caller with no office department capability', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    seedOfficeDepartmentAndSquad(harness)
    const unrelatedDepartmentId = seedUnrelatedDepartment(harness)

    const result = await invokeTool(wrongDeptCaller(unrelatedDepartmentId), testEnv, 'office.list_pending_approvals', {}, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_authorized')
    harness.close()
  })

  // P3-1 (kasra-review adversarial round 1, PR #1588): this query used to select
  // EVERY gate:office task in 'review' tenant-wide, with no squad/department join —
  // a task attached to an entirely unrelated squad (any department) that happened
  // to be gated 'gate:office' still leaked its body to any office-department
  // member. hasOfficeCapability is a FLOOR, not a per-row scope check.
  it('never returns a gate:office task from a squad the caller cannot act on, even one under an unrelated department', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const officeTaskId = await makeOfficeTask(testEnv, squadId)

    const unrelatedDepartmentId = seedUnrelatedDepartment(harness)
    const unrelatedSquadId = 'squad-unrelated-1'
    harness.sqlite.prepare(
      `INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, 'unrelated-squad', 'Unrelated Squad')`,
    ).run(unrelatedSquadId, unrelatedDepartmentId)
    const crossSquadTask = await createTask(
      testEnv,
      { squad_id: unrelatedSquadId, title: 'Cross-squad leak', done_when: 'not applicable to this fixture', gate_owner: 'gate:office' },
      { skipMirror: true, skipEvent: true },
    )
    await invokeTool(orgOwnerAuth('seed'), testEnv, 'task_update', { task_id: crossSquadTask.id, status: 'in_progress' }, ORIGIN)
    await invokeTool(orgOwnerAuth('seed'), testEnv, 'task_update', { task_id: crossSquadTask.id, status: 'review' }, ORIGIN)

    // officeMember only holds a DEPARTMENT-scoped grant on 'office' — it does not
    // cover the unrelated department's squad at all.
    const result = await invokeTool(officeMember(departmentId), testEnv, 'office.list_pending_approvals', {}, ORIGIN)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const tasks = (result.result as { tasks: Array<{ id: string }> }).tasks
      expect(tasks.map((task) => task.id)).toEqual([officeTaskId])
    }
    harness.close()
  })
})

describe('office.review_approval', () => {
  it('approves an office-gated task under review', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-approve-happy')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()
    const expectedPayloadSha256 = await officeFreezeHash(testEnv, taskId)
    expect(expectedPayloadSha256).not.toBeNull()

    const result = await invokeTool(
      owner, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: expectedPayloadSha256 },
      ORIGIN,
    )

    expect(result.ok).toBe(true)
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('approved')
    harness.close()
  })

  // mupot#1602 r1 adversarial gate P2-2: round 1's design let this succeed as a
  // no-op ("a human's decision to approve content is independent of WordPress
  // infra readiness") — the tool's own description already promised otherwise
  // ("a mismatch (or a missing/voided freeze) refuses the approval"). Now it does.
  it('refuses to approve when no live freeze exists at all — no WordPress infra was ever resolvable', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    // No installation/connector seeded — the review-entry freeze hook silently
    // leaves no freeze row (addon_inactive).
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()

    const result = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('payload_not_frozen')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  it('refuses to decide a task gated under a different namespace', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const otherTask = await createTask(
      testEnv,
      { squad_id: squadId, title: 'Not office-gated', done_when: 'not applicable to this fixture', gate_owner: 'gate:loops' },
      { skipMirror: true, skipEvent: true },
    )
    const owner = orgOwnerAuth()
    await invokeTool(owner, testEnv, 'task_update', { task_id: otherTask.id, status: 'in_progress' }, ORIGIN)
    await invokeTool(owner, testEnv, 'task_update', { task_id: otherTask.id, status: 'review' }, ORIGIN)

    const result = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: otherTask.id, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('wrong_gate')
    harness.close()
  })

  it('refuses a caller with no gate:office capability (a plain grantless member)', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const grantlessMember = auth('grantless-1', [grant('squad', squadId, 'member')])

    const result = await invokeTool(grantlessMember, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_authorized')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // P1-2 (kasra-review adversarial round 1, PR #1588, repro PE): an agent — even one
  // whose bearer carries an org-owner MEMBER's capabilities — must never approve. A
  // human-review gate that an agent can satisfy on its own is not a human-review gate.
  it('refuses an agent-bound caller outright — approval must be a human decision', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const agentBoundOwner: AuthContext = { ...orgOwnerAuth(), boundAgentId: 'ag-1' }

    const result = await invokeTool(agentBoundOwner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('agent_approval_forbidden')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // The requester (the task's own human owner) can never approve their own request —
  // evaluateVerdictGates' shared self_verdict rule only ever compares against
  // assignee_agent_id, so a human self-assigned to their own office task was not
  // caught by it.
  it("refuses the task's own human owner from approving their own request", async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('requester-1', 'requester@x.t', 'requester', 'active', ?)`,
    ).run(TENANT)
    const task = await createTask(
      testEnv,
      {
        squad_id: squadId, title: 'Publish: self request', done_when: 'post is live',
        gate_owner: 'gate:office', assignee_member_id: 'requester-1',
      },
      { skipMirror: true, skipEvent: true },
    )
    await invokeTool(orgOwnerAuth('seed'), testEnv, 'task_update', { task_id: task.id, status: 'in_progress' }, ORIGIN)
    await invokeTool(orgOwnerAuth('seed'), testEnv, 'task_update', { task_id: task.id, status: 'review' }, ORIGIN)
    void departmentId

    const requester = auth('requester-1', [grant('squad', squadId, 'member')])
    const result = await invokeTool(requester, testEnv, 'office.review_approval', { task_id: task.id, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('self_verdict')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // P2-2 (kasra-review adversarial round 1, PR #1588, repro PD): office.review_approval
  // used to skip the squad-scope base guard task_verdict's own surfaces run BEFORE
  // evaluateVerdictGates — a caller who held gate:office but belonged to a DIFFERENT
  // squad only got 'ok' here while task_verdict correctly refused the identical
  // task/caller pair. One task, one verdict authority.
  // P2-2's ONLY isolating case: a department:office grant already covers EVERY
  // squad under the office department (hasCapability's department -> squad
  // inheritance), so a caller who passes hasOfficeCapability(lead) for a task's
  // own department also, structurally, always passes canActOnSquad for that same
  // task — the squad-scope check cannot be observed by giving the caller LESS
  // office access. It CAN be observed when the office-GATED task itself lives
  // under a squad from an UNRELATED department (nothing stops task_create from
  // doing this; P3-1's cross-squad-leak test above proves it happens): the caller
  // holds office lead + gate:office, so every OTHER check passes, but the task's
  // squad is outside any department they hold authority over.
  it('refuses a caller who holds office lead + gate:office when the task itself lives under an unrelated squad — matches task_verdict', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId } = seedOfficeDepartmentAndSquad(harness)
    const unrelatedDepartmentId = seedUnrelatedDepartment(harness)
    const unrelatedSquadId = 'squad-unrelated-p2-2'
    harness.sqlite.prepare(
      `INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, 'unrelated-squad', 'Unrelated Squad')`,
    ).run(unrelatedSquadId, unrelatedDepartmentId)
    const taskId = await makeOfficeTask(testEnv, unrelatedSquadId)

    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-out', 'o@x.t', 'o', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-out', 'gate:office', 'member', 'm-out', 'test', datetime('now'))`,
    ).run()
    const outsider = auth('m-out', [grant('department', departmentId, 'lead')])

    const taskVerdictResult = await invokeTool(outsider, testEnv, 'task_verdict', { task_id: taskId, verdict: 'approved' }, ORIGIN)
    expect(taskVerdictResult.ok).toBe(false)

    const reviewResult = await invokeTool(outsider, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)
    expect(reviewResult.ok).toBe(false)
    if (!reviewResult.ok) expect(reviewResult.error).toBe('not_authorized')

    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // The manifest's own approvalPolicies entry ('office.publish', requiredCapability:
  // 'lead') was declared but never actually read by this tool — a caller holding
  // ONLY a gate:office grant (no department capability at all) could approve.
  it('refuses a caller who holds gate:office and squad access but lacks the department lead capability the manifest requires', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const taskId = await makeOfficeTask(testEnv, squadId)

    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m2', 'm2@x.t', 'm2', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-m2', 'gate:office', 'member', 'm2', 'test', datetime('now'))`,
    ).run()
    const gateHolderNoLead = auth('m2', [grant('squad', squadId, 'member')])

    const result = await invokeTool(gateHolderNoLead, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_authorized')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // mupot#1592 NEW-5 (r2 adversarial follow-up on PR #1588): the PRIOR version of
  // this class of test used a caller with NO department capability at all — so
  // mutating resolveOfficePublishRequiredCapability's rank from 'lead' to 'member'
  // left the test GREEN (the caller was refused either way, for an unrelated
  // reason: it never held department:'member' either). Non-vacuous by
  // construction: this caller holds department:'member' — satisfies a
  // requiredCapability of 'member', NOT 'lead' — so if the manifest's declared
  // rank for 'office.publish' were ever silently weakened to 'member', THIS test
  // (and only a test built exactly this way) would flip from refused to allowed.
  it('refuses a caller holding department:member (satisfies member, not lead) — the manifest requires lead', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const taskId = await makeOfficeTask(testEnv, squadId)

    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m3', 'm3@x.t', 'm3', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-m3', 'gate:office', 'member', 'm3', 'test', datetime('now'))`,
    ).run()
    const memberOnly = auth('m3', [
      grant('squad', squadId, 'member'),
      grant('department', departmentId, 'member'),
    ])

    const expectedPayloadSha256 = await officeFreezeHash(testEnv, taskId)
    const result = await invokeTool(
      memberOnly, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: expectedPayloadSha256 ?? undefined },
      ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('not_authorized')
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })

  // P1-2 (repro PE, full chain): even when an agent COULD satisfy every capability
  // check, it must never reach a live WordPress write — office.review_approval's
  // agent-approval-forbidden refusal makes this structurally impossible, not just
  // unlikely.
  it('an agent that creates its own unassigned gate:office task can never approve or publish it', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-pe')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    harness.sqlite.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag-1', ?, 'site-op', 'Site Op', 'worker', 'x', 'active')`,
    ).run(squadId)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-ag1', 'gate:office', 'agent', 'ag-1', 'test', datetime('now'))`,
    ).run()
    const agentAuth: AuthContext = { ...auth('m-lead', [grant('department', departmentId, 'lead')]), boundAgentId: 'ag-1' }
    const taskId = await makeOfficeTask(testEnv, squadId)

    const approve = await invokeTool(agentAuth, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)
    expect(approve.ok).toBe(false)
    if (!approve.ok) expect(approve.error).toBe('agent_approval_forbidden')

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const publish = await invokeTool(agentAuth, testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)
    expect(publish.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    harness.close()
  })
})

// mupot#1592 — r2 adversarial follow-up on PR #1588 (comment 5860750102): NEW-1
// (freeze at request time, hash binding), NEW-2 (freeze bound to the verdict,
// voided on reverse/reject), NEW-3 (claim re-checks status atomically), NEW-4
// (verdict + freeze bind land in one batch). Separate describe block: these
// exercise the FULL request->review->approve->reverse->rework lifecycle rather
// than a single tool call, unlike the suites above.
describe('mupot#1592 freeze/verdict binding', () => {
  // mupot#1602 r1 adversarial gate P1 (check-then-write race, deterministic):
  // reviewOfficeApproval's hash compare is a plain SELECT — this proves the
  // write ITSELF (not just that earlier read) still refuses when the freeze
  // changes underneath it. Uses envWithInterleave to land the interleaving
  // mutation at the EXACT point the adversarial repro needs: after the hash
  // SELECT has already matched (so the early check alone cannot catch this —
  // if it fired before that SELECT, `payload_mismatch` would trip immediately
  // and this test would not be exercising the batch-level extraGuard at all),
  // but before writeOfficeVerdictAndBindFreeze's verdict batch executes.
  it('P1 deterministic race: a freeze that changes between the hash check and the verdict batch cannot be bound', async () => {
    const harness = makeHarness()
    const realEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-p1-race')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(realEnv, squadId)
    const owner = orgOwnerAuth()

    // Human A's view: read BEFORE anything races.
    const hashSeenByA = await officeFreezeHash(realEnv, taskId)
    expect(hashSeenByA).not.toBeNull()

    // Precompute what a rework to 'EVIL BODY' would freeze — buildOfficePublishFreeze
    // is async (sha256Hex uses crypto.subtle) and cannot run inside the synchronous
    // interleave callback below, so it is computed up front and inserted via raw SQL
    // at interleave time, matching exactly what freezeOfficeTaskOnReviewEntry would
    // have produced for that content.
    const liveTask = await realEnv.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(taskId).first<Task>()
    const evilTask: Task = { ...(liveTask as Task), body: 'EVIL BODY' }
    const evilFreezeResult = await buildOfficePublishFreeze(realEnv, evilTask)
    if (!evilFreezeResult.ok) throw new Error(`fixture error: could not build evil freeze: ${JSON.stringify(evilFreezeResult)}`)
    const evilFreeze = evilFreezeResult.value
    expect(evilFreeze.payloadSha256).not.toBe(hashSeenByA)

    // Interleaves right before the verdict batch's own `UPDATE tasks ... WHERE
    // status = 'review'` statement is BUILT (buildVerdictStatements, src/tasks/
    // service.ts) — synchronous SQLite, so it completes before env.DB.batch()
    // executes the batch moments later: B rejects the freeze A already read,
    // the agent reworks the body and re-enters review, minting a FRESH freeze
    // bound to DIFFERENT bytes — all in the window A's approval call is still
    // inside, after A's own hash check already matched the OLD freeze.
    const raceEnv = envWithInterleave(
      harness,
      "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'review'",
      () => {
        harness.sqlite.prepare(`UPDATE tasks SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(taskId)
        harness.sqlite.prepare(
          `UPDATE office_publish_freezes SET voided_at = datetime('now'), voided_reason = 'rejected' WHERE task_id = ? AND voided_at IS NULL`,
        ).run(taskId)
        harness.sqlite.prepare(
          `UPDATE tasks SET status = 'in_progress', body = 'EVIL BODY', updated_at = datetime('now') WHERE id = ?`,
        ).run(taskId)
        harness.sqlite.prepare(`UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?`).run(taskId)
        harness.sqlite.prepare(`
          INSERT INTO office_publish_freezes (
            task_id, payload_json, payload_sha256, installation_id, connector_id, site_origin, frozen_by, frozen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            payload_json = excluded.payload_json, payload_sha256 = excluded.payload_sha256,
            installation_id = excluded.installation_id, connector_id = excluded.connector_id,
            site_origin = excluded.site_origin, frozen_by = excluded.frozen_by, frozen_at = excluded.frozen_at,
            verdict_id = NULL, voided_at = NULL, voided_reason = NULL, claimed_by = NULL, claimed_at = NULL,
            outcome = NULL, outcome_detail = NULL, completed_at = NULL,
            generation = office_publish_freezes.generation + 1
        `).run(
          taskId, evilFreeze.payloadJson, evilFreeze.payloadSha256,
          evilFreeze.installationId, evilFreeze.connectorId, evilFreeze.siteOrigin,
          'agent-rework', new Date().toISOString(),
        )
      },
    )

    const result = await invokeTool(
      owner, raceEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: hashSeenByA },
      ORIGIN,
    )

    // The write itself refused — a race loss, not a clean approval of stale bytes.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('verdict_race')

    // The task is 'review' (B's rework), NOT 'approved' under A's stale hash.
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    // A's verdict never landed at all.
    const verdictCount = harness.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get(taskId) as { n: number }
    expect(verdictCount.n).toBe(0)
    // The fresh (evil) freeze is still unbound — A's stale approval never touched it.
    const freeze = harness.sqlite.prepare(`SELECT verdict_id, payload_sha256 FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as { verdict_id: string | null; payload_sha256: string }
    expect(freeze.verdict_id).toBeNull()
    expect(freeze.payload_sha256).toBe(evilFreeze.payloadSha256)

    // publish never fetches — nothing was ever bound to authorize it.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const publishAttempt = await invokeTool(owner, realEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)
    expect(publishAttempt.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses a payload hash mismatch outright — no fetch, no verdict written, no task state change', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-mismatch')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)

    const shownHash = await officeFreezeHash(testEnv, taskId)
    expect(shownHash).not.toBeNull()

    // Simulates the freeze having drifted from what the human saw (e.g. a
    // hypothetical bypass of the task_update/PATCH edit-lock, or a rework cycle
    // the human's stale list_pending_approvals read never picked up) — a direct
    // write to office_publish_freezes, not through any tool.
    harness.sqlite.prepare(
      `UPDATE office_publish_freezes SET payload_sha256 = ? WHERE task_id = ?`,
    ).run('deadbeef'.repeat(8), taskId)

    const owner = orgOwnerAuth()
    const result = await invokeTool(
      owner, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: shownHash },
      ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('payload_mismatch')

    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('review')
    const verdictCount = harness.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get(taskId) as { n: number }
    expect(verdictCount.n).toBe(0)
    harness.close()
  })

  it('publishes the payload frozen at review-entry even when task.title/body were mutated directly afterward — publish never reads live task content', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-integrity')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    // Direct mutation bypassing every tool — simulates a hypothetical future bug
    // in the edit-lock, or a direct-D1 writer this addon never anticipated.
    harness.sqlite.prepare(`UPDATE tasks SET title = 'HIJACKED TITLE', body = 'HIJACKED BODY' WHERE id = ?`).run(taskId)

    let capturedBody: { title?: string; content?: string } | null = null
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 42, link: 'https://wordpress.example.com/?p=42' }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)
    expect(result.ok).toBe(true)
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.title).toBe('Publish: Q4 recap')
    expect(capturedBody!.title).not.toBe('HIJACKED TITLE')
    expect(capturedBody!.content).not.toBe('HIJACKED BODY')
    harness.close()
  })

  it('NEW-3: the one-shot claim re-checks status=\'approved\' atomically — a stale in-memory "approved" task object cannot publish once the real row has been reversed', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-race')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    // The STALE in-memory task, read BEFORE the reversal below — this is exactly
    // what a caller holding an already-fetched Task object across an await gap
    // would have. publishOfficePost must never trust task.status from its own
    // argument for the one-shot claim; it must re-derive it inside the UPDATE.
    const staleTask = await testEnv.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(taskId).first<Task>()
    expect(staleTask?.status).toBe('approved')

    const owner = orgOwnerAuth()
    const reversal = await invokeTool(
      owner, testEnv, 'task_update',
      { task_id: taskId, status: 'review', reversal_reason: 'wrong content, undo it' },
      ORIGIN,
    )
    if (!reversal.ok) throw new Error(`fixture error: reversal failed: ${JSON.stringify(reversal)}`)
    const liveRow = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(liveRow.status).toBe('review')

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const publishResult = await publishOfficePost(testEnv, officeLead(departmentId), { task: staleTask as Task })
    expect(publishResult.ok).toBe(false)
    if (!publishResult.ok) expect(publishResult.reason).toBe('publish_claimed')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  // NEW-3, ISOLATED from NEW-2: the test above is ALSO satisfied by the
  // verdict_id/reversed_at binding alone (reversal always sets reversed_at,
  // which independently breaks the claim's verdict_id subquery) — mutating away
  // ONLY the claim's `EXISTS (... status = 'approved')` conjunct leaves that
  // test green. This one isolates the status re-check on its own: task.status is
  // changed away from 'approved' WITHOUT touching task_verdicts at all (a raw
  // write, simulating any future/other code path that flips status without
  // knowing about this addon's verdict-binding invariant) — verdict_id stays
  // valid and unreversed, so ONLY the status re-check can catch this.
  it('NEW-3 isolated: the claim also re-derives status=\'approved\' independently of the verdict_id binding', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-race-status-only')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const staleTask = await testEnv.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(taskId).first<Task>()
    expect(staleTask?.status).toBe('approved')

    // Raw write — status flips away from 'approved' with NO reversal, no
    // task_verdicts change at all. freeze.verdict_id is still bound to the
    // still-unreversed approved verdict.
    harness.sqlite.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(taskId)
    const freezeRow = harness.sqlite.prepare(`SELECT verdict_id FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as { verdict_id: string | null }
    expect(freezeRow.verdict_id).not.toBeNull()

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const publishResult = await publishOfficePost(testEnv, officeLead(departmentId), { task: staleTask as Task })
    expect(publishResult.ok).toBe(false)
    if (!publishResult.ok) expect(publishResult.reason).toBe('publish_claimed')
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('reverse voids the freeze and re-entering review mints a fresh, unbound one; reject also voids; a stale pre-rework hash is refused after content actually changes', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-rework')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()

    const hashV1 = await officeFreezeHash(testEnv, taskId)
    expect(hashV1).not.toBeNull()
    await approveOfficeTask(testEnv, taskId)
    const freezeAfterApprove = harness.sqlite.prepare(
      `SELECT verdict_id, voided_at FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { verdict_id: string | null; voided_at: string | null }
    expect(freezeAfterApprove.verdict_id).not.toBeNull()
    expect(freezeAfterApprove.voided_at).toBeNull()
    const v1VerdictId = freezeAfterApprove.verdict_id

    // Reverse (org owner/admin, mandatory reason) — NEW-2: voids the freeze.
    const reversal = await invokeTool(
      owner, testEnv, 'task_update',
      { task_id: taskId, status: 'review', reversal_reason: 'need to fix a typo first' },
      ORIGIN,
    )
    if (!reversal.ok) throw new Error(`fixture error: reversal failed: ${JSON.stringify(reversal)}`)

    // The review-entry hook re-fires on the reversal's own review-entry, minting a
    // FRESH freeze (content unchanged so far -> same hash as v1 is fine; what
    // matters is it is UNBOUND: verdict_id NULL, voided_at NULL).
    const freezeAfterReversal = harness.sqlite.prepare(
      `SELECT verdict_id, voided_at FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { verdict_id: string | null; voided_at: string | null }
    expect(freezeAfterReversal.verdict_id).toBeNull()
    expect(freezeAfterReversal.voided_at).toBeNull()

    // Reject this fresh freeze — NEW-2: voids it too, in the same batch as the verdict.
    const hashV2 = await officeFreezeHash(testEnv, taskId)
    const rejected = await invokeTool(
      owner, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'rejected', expected_payload_sha256: hashV2 },
      ORIGIN,
    )
    if (!rejected.ok) throw new Error(`fixture error: reject failed: ${JSON.stringify(rejected)}`)
    const freezeAfterReject = harness.sqlite.prepare(
      `SELECT voided_at, voided_reason FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { voided_at: string | null; voided_reason: string | null }
    expect(freezeAfterReject.voided_at).not.toBeNull()
    expect(freezeAfterReject.voided_reason).toBe('rejected')

    // Generic task_verdict must still refuse this task outright (NEW-2's own
    // dedicated-gate refusal, exercised in the earlier describe block too).
    const bypassAttempt = await invokeTool(owner, testEnv, 'task_verdict', { task_id: taskId, verdict: 'approved' }, ORIGIN)
    expect(bypassAttempt.ok).toBe(false)

    // Rework: rejected -> in_progress (content editable here) -> review (fresh freeze).
    const toInProgress = await invokeTool(owner, testEnv, 'task_update', { task_id: taskId, status: 'in_progress' }, ORIGIN)
    if (!toInProgress.ok) throw new Error(`fixture error: could not move to in_progress: ${JSON.stringify(toInProgress)}`)
    const editedTask = await invokeTool(owner, testEnv, 'task_update', { task_id: taskId, body: 'revised, corrected content' }, ORIGIN)
    if (!editedTask.ok) throw new Error(`fixture error: could not edit body: ${JSON.stringify(editedTask)}`)
    const backToReview = await invokeTool(owner, testEnv, 'task_update', { task_id: taskId, status: 'review' }, ORIGIN)
    if (!backToReview.ok) throw new Error(`fixture error: could not re-enter review: ${JSON.stringify(backToReview)}`)

    const hashV3 = await officeFreezeHash(testEnv, taskId)
    expect(hashV3).not.toBeNull()
    expect(hashV3).not.toBe(hashV1) // content genuinely changed -> genuinely different hash

    // mupot#1592: "after any re-approval, the old frozen payload is not
    // publishable" — the OLD hash (from before the content change) is now stale
    // and must be refused, not silently accepted.
    const staleApprove = await invokeTool(
      owner, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: hashV1 },
      ORIGIN,
    )
    expect(staleApprove.ok).toBe(false)
    if (!staleApprove.ok) expect(staleApprove.error).toBe('payload_mismatch')

    // The CURRENT hash approves cleanly, bound to a NEW verdict distinct from v1.
    const freshApprove = await invokeTool(
      owner, testEnv, 'office.review_approval',
      { task_id: taskId, verdict: 'approved', expected_payload_sha256: hashV3 },
      ORIGIN,
    )
    expect(freshApprove.ok).toBe(true)
    const finalFreeze = harness.sqlite.prepare(
      `SELECT verdict_id FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { verdict_id: string | null }
    expect(finalFreeze.verdict_id).not.toBeNull()
    expect(finalFreeze.verdict_id).not.toBe(v1VerdictId)
    harness.close()
  })

  it('NEW-4: concurrent approvals on the same review task land exactly one verdict, bound to the freeze; the loser is refused with nothing written', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-concurrent-approve')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    const hash = await officeFreezeHash(testEnv, taskId)

    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m4', 'm4@x.t', 'm4', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-m4', 'gate:office', 'member', 'm4', 'test', datetime('now'))`,
    ).run()
    const secondApprover = auth('m4', [grant('department', departmentId, 'lead'), grant('squad', squadId, 'member')])
    const firstApprover = orgOwnerAuth()

    const results = await Promise.all([
      invokeTool(firstApprover, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved', expected_payload_sha256: hash }, ORIGIN),
      invokeTool(secondApprover, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved', expected_payload_sha256: hash }, ORIGIN),
    ])

    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(1)
    const loser = results.find((r) => !r.ok) as { ok: false; error: string } | undefined
    expect(loser?.error).toBe('verdict_race')

    const verdictCount = harness.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get(taskId) as { n: number }
    expect(verdictCount.n).toBe(1)
    const verdictRow = harness.sqlite.prepare(`SELECT id FROM task_verdicts WHERE task_id = ?`).get(taskId) as { id: string }
    const freeze = harness.sqlite.prepare(`SELECT verdict_id FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as { verdict_id: string | null }
    expect(freeze.verdict_id).toBe(verdictRow.id)
    harness.close()
  })
})

// mupot#1592 P3 ("a documented recovery path that actually works ...
// reconcile-before-reapprove against WordPress"): a freeze CLAIMED but never
// reaching an outcome (worker died mid-fetch) must block a fresh auto-refreeze —
// office.reconcile_stalled_publish (org owner/admin, manual WordPress check) is
// the only way out.
describe('mupot#1592 reconcile-before-reapprove', () => {
  it('refuses to mint a fresh freeze while a prior one is claimed-but-unconfirmed, until an org admin reconciles it', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-reconcile')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const before = harness.sqlite.prepare(`SELECT frozen_at FROM office_publish_freezes WHERE task_id = ?`).get(taskId) as { frozen_at: string }

    // Simulate "claimed, then the worker died before recording an outcome" — the
    // exact ambiguous state a real timeout/crash mid-publish leaves behind.
    harness.sqlite.prepare(
      `UPDATE office_publish_freezes SET claimed_by = 'ghost-worker', claimed_at = ? WHERE task_id = ?`,
      // Backdated well past RECONCILE_MIN_STALENESS_MS (mupot#1602 r1 P3-3) — a
      // reconcile call must refuse a claim that could still be a live in-flight
      // fetch; this simulates one old enough to be genuinely stalled.
    ).run(new Date(Date.now() - 60_000).toISOString(), taskId)

    // Org admin reverses the (never-actually-executed) approval to get the task
    // back into review — the review-entry hook fires but must NOT mint a fresh
    // freeze over the unreconciled one.
    const owner = orgOwnerAuth()
    const reversal = await invokeTool(
      owner, testEnv, 'task_update',
      { task_id: taskId, status: 'review', reversal_reason: 'publish outcome unknown, need to check WordPress by hand' },
      ORIGIN,
    )
    if (!reversal.ok) throw new Error(`fixture error: reversal failed: ${JSON.stringify(reversal)}`)

    const afterReversal = harness.sqlite.prepare(
      `SELECT frozen_at, claimed_at, outcome FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { frozen_at: string; claimed_at: string | null; outcome: string | null }
    expect(afterReversal.frozen_at).toBe(before.frozen_at) // untouched — no silent refreeze
    expect(afterReversal.claimed_at).not.toBeNull()
    expect(afterReversal.outcome).toBeNull()

    // A non-admin cannot reconcile it.
    const nonAdmin = auth('m5', [grant('department', 'dept-office-1', 'lead')])
    const deniedReconcile = await invokeTool(
      nonAdmin, testEnv, 'office.reconcile_stalled_publish',
      { task_id: taskId, outcome: 'failed', detail: 'confirmed absent on WordPress' },
      ORIGIN,
    )
    expect(deniedReconcile.ok).toBe(false)
    if (!deniedReconcile.ok) expect(deniedReconcile.error).toBe('not_authorized')

    // An org admin reconciles it — confirmed by hand that WordPress never got the post.
    const reconciled = await invokeTool(
      owner, testEnv, 'office.reconcile_stalled_publish',
      { task_id: taskId, outcome: 'failed', detail: 'confirmed absent on WordPress' },
      ORIGIN,
    )
    expect(reconciled.ok).toBe(true)
    const afterReconcile = harness.sqlite.prepare(
      `SELECT outcome, outcome_detail FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { outcome: string | null; outcome_detail: string | null }
    expect(afterReconcile.outcome).toBe('failed')
    expect(afterReconcile.outcome_detail).toBe('confirmed absent on WordPress')

    // Reconciling twice is refused — it is not a re-openable action.
    const secondReconcile = await invokeTool(
      owner, testEnv, 'office.reconcile_stalled_publish',
      { task_id: taskId, outcome: 'failed' },
      ORIGIN,
    )
    expect(secondReconcile.ok).toBe(false)
    if (!secondReconcile.ok) expect(secondReconcile.error).toBe('already_reconciled')

    // NOW a fresh review-entry mints a real, unclaimed freeze again. review's only
    // outbound transitions are approved/rejected (TRANSITIONS, src/tasks/
    // service.ts) — reject first (the voided freeze needs no hash), then the
    // ordinary rejected -> in_progress -> review rework loop.
    const reject = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'rejected' }, ORIGIN)
    if (!reject.ok) throw new Error(`fixture error: could not reject: ${JSON.stringify(reject)}`)
    const toInProgress = await invokeTool(owner, testEnv, 'task_update', { task_id: taskId, status: 'in_progress' }, ORIGIN)
    if (!toInProgress.ok) throw new Error(`fixture error: could not move to in_progress: ${JSON.stringify(toInProgress)}`)
    const backToReview = await invokeTool(owner, testEnv, 'task_update', { task_id: taskId, status: 'review' }, ORIGIN)
    if (!backToReview.ok) throw new Error(`fixture error: could not re-enter review: ${JSON.stringify(backToReview)}`)

    const freshFreeze = harness.sqlite.prepare(
      `SELECT frozen_at, claimed_at, outcome FROM office_publish_freezes WHERE task_id = ?`,
    ).get(taskId) as { frozen_at: string; claimed_at: string | null; outcome: string | null }
    expect(freshFreeze.frozen_at).not.toBe(before.frozen_at)
    expect(freshFreeze.claimed_at).toBeNull()
    expect(freshFreeze.outcome).toBeNull()

    await approveOfficeTask(testEnv, taskId)
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('approved')
    harness.close()
  })

  it('reconcile with outcome:"done" marks the task published without ever calling WordPress again', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-reconcile-done')
    seedActiveOfficeInstallation(harness, connectorId)
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)
    harness.sqlite.prepare(
      `UPDATE office_publish_freezes SET claimed_by = 'ghost-worker', claimed_at = ? WHERE task_id = ?`,
      // Backdated well past RECONCILE_MIN_STALENESS_MS (mupot#1602 r1 P3-3) — a
      // reconcile call must refuse a claim that could still be a live in-flight
      // fetch; this simulates one old enough to be genuinely stalled.
    ).run(new Date(Date.now() - 60_000).toISOString(), taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const owner = orgOwnerAuth()
    const reconciled = await invokeTool(
      owner, testEnv, 'office.reconcile_stalled_publish',
      { task_id: taskId, outcome: 'done', post_id: 99, article_url: 'https://wordpress.example.com/?p=99', detail: 'found it live, published manually earlier' },
      ORIGIN,
    )
    expect(reconciled.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()

    const row = harness.sqlite.prepare(`SELECT status, result FROM tasks WHERE id = ?`).get(taskId) as { status: string; result: string }
    expect(row.status).toBe('done')
    expect(JSON.parse(row.result)).toMatchObject({ postId: 99, articleUrl: 'https://wordpress.example.com/?p=99' })
    harness.close()
  })
})
