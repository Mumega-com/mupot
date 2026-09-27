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
import { resolveActiveOfficeInstallationId } from '../src/addons/office/service'

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

async function approveOfficeTask(testEnv: Env, taskId: string): Promise<void> {
  const owner = orgOwnerAuth()
  const result = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)
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

  it('refuses when the task was approved directly through task_verdict (bypassing office.review_approval) — no frozen payload to publish', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    const connectorId = await seedWordpressConnector(harness, 'https://wordpress.example.com', 'secret-bypass')
    seedActiveOfficeInstallation(harness, connectorId)
    mockWriteCapableOfficeBinding()
    const taskId = await makeOfficeTask(testEnv, squadId)

    // A gate:office grant lets task_verdict approve this task directly, entirely
    // bypassing office.review_approval — and so, entirely bypassing the freeze.
    harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('bypass-1', 'bypass@x.t', 'bypass', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-bypass', 'gate:office', 'member', 'bypass-1', 'test', datetime('now'))`,
    ).run()
    const bypassAuth = auth('bypass-1', [grant('squad', squadId, 'member')])
    const verdict = await invokeTool(bypassAuth, testEnv, 'task_verdict', { task_id: taskId, verdict: 'approved' }, ORIGIN)
    expect(verdict.ok).toBe(true)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(officeLead(departmentId), testEnv, 'office.publish_post', { task_id: taskId }, ORIGIN)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('payload_not_frozen')
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

  it('refuses when the installation was never active, with zero fetches (no target was ever resolvable to freeze)', async () => {
    const harness = makeHarness()
    const testEnv = env(harness)
    const { departmentId, squadId } = seedOfficeDepartmentAndSquad(harness)
    // installAddon only — never configured/activated, so listAddonInstallations sees
    // state='installed', not 'active', at BOTH approval and publish time. The
    // approval still lands (a human's decision to approve content is independent
    // of infra readiness — see reviewOfficeApproval's comment), but with no frozen
    // payload (buildOfficePublishFreeze itself returns addon_inactive and is
    // skipped), so publish now correctly reports 'payload_not_frozen' rather than
    // re-deriving 'addon_inactive' a second time — see the dedicated
    // 'installation is active at publish time but was not at approval time' case
    // below for the case where it WAS active at approval and then went inactive.
    await installAddon(testEnv, { id: 'owner-1', role: 'owner' }, 'mcpwp-office')
    const taskId = await makeOfficeTask(testEnv, squadId)
    await approveOfficeTask(testEnv, taskId)

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await invokeTool(
      officeLead(departmentId), testEnv, 'office.publish_post',
      { task_id: taskId }, ORIGIN,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('payload_not_frozen')
    expect(fetchSpy).not.toHaveBeenCalled()
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
    const taskId = await makeOfficeTask(testEnv, squadId)
    const owner = orgOwnerAuth()

    const result = await invokeTool(owner, testEnv, 'office.review_approval', { task_id: taskId, verdict: 'approved' }, ORIGIN)

    expect(result.ok).toBe(true)
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }
    expect(row.status).toBe('approved')
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
