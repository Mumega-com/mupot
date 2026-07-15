# Native Addon Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest trustworthy native addon lifecycle in Mupot and prove it with a zero-authority fixture addon.

**Architecture:** Addons are frozen declarative manifests registered above the existing department microkernel. Tenant lifecycle state is stored in D1, bound to a canonical manifest digest, and changed through compare-and-set transitions with append-only receipts and a resumable operation journal. The fixture addon composes the existing fixture department and requests no connector or capability, keeping this rail independent from the later Marketing/CRO authority and integration work.

**Tech Stack:** TypeScript 5.6, Cloudflare Workers, Hono, D1/SQLite, Vitest 4, Wrangler 4, Playwright 1.61.

## Global Constraints

- This plan supports trusted native addons only; external MCP addon execution is deferred.
- Repository visibility may be public or private; security must not depend on source secrecy.
- Install is inert: it grants no capability, binds no connector, seeds no department, and starts no work.
- The fixture addon requests no connector, rank grant, surface grant, loop, schedule, or write action.
- Every lifecycle write is tenant-scoped, actor-attributed, compare-and-set, and receipt-backed.
- Manifest validation rejects unknown fields and the installation binds to a canonical SHA-256 digest.
- Disable stops new addon work before deactivating owned resources and preserves all evidence.
- Uninstall is a soft archive; no task, flight, metric, audit, or receipt is deleted.
- Do not add an addon-key switch statement to the kernel.
- Do not store plaintext secrets, encrypted connector material, arbitrary SQL, or callable functions in manifests.
- Marketing/CRO is the product focus, but no Marketing/CRO behavior is added until this rail passes.
- Every implementation task follows test-first development and ends with a focused commit.

---

## File Map

- `src/addons/contract.ts` — manifest types, strict validation, canonical serialization, and digest.
- `src/addons/registry.ts` — immutable in-process native addon catalog.
- `src/addons/modules/fixture.ts` — zero-authority fixture addon registration.
- `src/addons/service.ts` — tenant lifecycle, D1 persistence, operation journal, ownership, and receipts.
- `src/addons/routes.ts` — owner/admin JSON API for catalog and lifecycle commands.
- `src/dashboard/addons.ts` — server-rendered addon catalog and lifecycle controls.
- `migrations/0050_addons.sql` — native addon lifecycle tables and constraints.
- `scripts/addon-lifecycle-receipt.mjs` — independent API lifecycle evidence collector.
- `tests/addon-contract.test.ts` — validator, digest, and immutability tests.
- `tests/addon-registry.test.ts` — catalog and duplicate-registration tests.
- `tests/addon-service.test.ts` — lifecycle, interruption, ownership, and evidence tests.
- `tests/addon-routes.test.ts` — auth, body limits, state conflict, and response tests.
- `tests/dashboard-addons.test.ts` — catalog rendering and safe action-control tests.
- `tests/addon-lifecycle-receipt.test.ts` — receipt checker tests.
- `src/index.ts` — mount `/api/addons` before the dashboard catch-all.
- `src/dashboard/index.ts` — mount `/addons` and add the navigation entry.
- `package.json` — lifecycle receipt plan/check scripts.

---

### Task 1: Manifest Contract, Strict Validator, and Digest

**Files:**
- Create: `src/addons/contract.ts`
- Create: `tests/addon-contract.test.ts`

**Interfaces:**
- Produces: `AddonManifestV1`, `AddonValidationResult`, `validateAddonManifest(value)`, `canonicalManifestJson(manifest)`, and `manifestSha256(manifest)`.
- Consumes: `Capability` and `CapabilityScopeType` from `src/types.ts`.

- [ ] **Step 1: Write failing strict-validation and digest tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  canonicalManifestJson,
  manifestSha256,
  validateAddonManifest,
  type AddonManifestV1,
} from '../src/addons/contract'

const fixture: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-addon',
  name: 'Fixture Addon',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.23.0',
  kind: 'native',
  description: 'Lifecycle fixture with no authority.',
  departments: [{ moduleKey: 'fixture', required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [{ descriptorKey: 'fixture.pings', ownerDepartment: 'fixture' }],
  playbooks: [],
  loops: [],
  consoleSections: [{ rendererKey: 'fixture', path: '/departments/fixture', title: 'Fixture', navIcon: 'flask-conical' }],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

describe('addon contract', () => {
  it('accepts the zero-authority fixture', () => {
    expect(validateAddonManifest(fixture)).toEqual({ ok: true, manifest: fixture })
  })

  it('rejects unknown fields and wildcard surfaces', () => {
    expect(validateAddonManifest({ ...fixture, surprise: true })).toMatchObject({ ok: false })
    expect(validateAddonManifest({
      ...fixture,
      authorityRequests: { rankGrants: [], surfaceGrants: [{ subjectRef: 'agent:x', capability: 'mcp:*', reason: 'bad' }] },
    })).toMatchObject({ ok: false, reason: 'invalid_surface_capability' })
  })

  it('produces a stable digest independent of object insertion order', async () => {
    const reordered = JSON.parse(JSON.stringify(fixture)) as AddonManifestV1
    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(fixture))
    expect(await manifestSha256(reordered)).toBe(await manifestSha256(fixture))
  })
})
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `npx vitest run tests/addon-contract.test.ts`

Expected: FAIL because `src/addons/contract.ts` does not exist.

- [ ] **Step 3: Implement the manifest contract and strict validator**

Create `src/addons/contract.ts` with the exact public types in the approved design. Implement validation with an explicit top-level key allowlist, positive regexes (`key`: `^[a-z0-9-]{3,64}$`, `version`: semantic `x.y.z`, paths beginning with `/`), array duplicate checks, native trust matching, wildcard surface rejection, write-slot approval-policy coverage, and fixed retention literals.

Use this canonical serializer and digest implementation:

```ts
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  }
  return value
}

export function canonicalManifestJson(manifest: AddonManifestV1): string {
  return JSON.stringify(sortValue(manifest))
}

export async function manifestSha256(manifest: AddonManifestV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifestJson(manifest))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
```

Return errors as `{ ok: false, reason: string, path?: string }`; never throw for untrusted manifest input.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `npx vitest run tests/addon-contract.test.ts && npm run typecheck`

Expected: contract tests PASS and TypeScript exits `0`.

- [ ] **Step 5: Commit the contract**

```bash
git add src/addons/contract.ts tests/addon-contract.test.ts
git commit -m "feat(addons): define strict native addon manifest"
```

---

### Task 2: Immutable Registry and Fixture Addon

**Files:**
- Create: `src/addons/registry.ts`
- Create: `src/addons/modules/fixture.ts`
- Create: `tests/addon-registry.test.ts`

**Interfaces:**
- Consumes: `AddonManifestV1`, `validateAddonManifest`, and `manifestSha256` from Task 1.
- Produces: `AddonCatalogEntry`, `createAddonRegistry()`, `registerAddon()`, `getRegisteredAddon()`, `listRegisteredAddons()`, and `FixtureAddon`.

- [ ] **Step 1: Write failing registry tests**

```ts
import { describe, expect, it } from 'vitest'
import { createAddonRegistry } from '../src/addons/registry'
import { FixtureAddon } from '../src/addons/modules/fixture'

describe('addon registry', () => {
  it('registers a deep-frozen clone', async () => {
    const registry = createAddonRegistry()
    await registry.register(FixtureAddon)
    const stored = registry.get(FixtureAddon.key)
    expect(stored?.manifest).not.toBe(FixtureAddon)
    expect(Object.isFrozen(stored?.manifest)).toBe(true)
    expect(Object.isFrozen(stored?.manifest.departments)).toBe(true)
    expect(stored?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects duplicate keys without a replacement API', async () => {
    const registry = createAddonRegistry()
    await registry.register(FixtureAddon)
    await expect(registry.register(FixtureAddon)).rejects.toThrow('addon_registry_duplicate_key')
  })
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run tests/addon-registry.test.ts`

Expected: FAIL because registry and fixture modules do not exist.

- [ ] **Step 3: Implement the isolated registry**

`createAddonRegistry()` owns a private `Map<string, AddonCatalogEntry>`. `register()` validates, `structuredClone`s, recursively freezes the clone, computes its digest, and stores `{ manifest, manifestSha256 }`. The exported production singleton has no clear, unregister, replace, or mutable-map surface.

`src/addons/modules/fixture.ts` must import the existing `FixtureModule` so the department self-registration runs, export the exact fixture manifest from Task 1, and register it once with the production addon registry.

- [ ] **Step 4: Run registry, department-conformance, and type tests**

Run: `npx vitest run tests/addon-contract.test.ts tests/addon-registry.test.ts tests/department-conformance.test.ts && npm run typecheck`

Expected: all selected tests PASS; existing department behavior is unchanged.

- [ ] **Step 5: Commit the registry and fixture**

```bash
git add src/addons/registry.ts src/addons/modules/fixture.ts tests/addon-registry.test.ts
git commit -m "feat(addons): register immutable fixture addon"
```

---

### Task 3: D1 Schema and Inert Install/Configure Service

**Files:**
- Create: `migrations/0050_addons.sql`
- Create: `src/addons/service.ts`
- Create: `tests/addon-service.test.ts`

**Interfaces:**
- Consumes: `AddonCatalogEntry` and registry lookup from Task 2.
- Produces: `AddonState`, `AddonInstallation`, `AddonReceipt`, `listAddonInstallations(env)`, `installAddon(env, actor, key)`, `configureAddon(env, actor, key)`, and `getAddonReceipts(env, installationId)`.

- [ ] **Step 1: Write the migration with hard lifecycle constraints**

Create `migrations/0050_addons.sql` containing:

```sql
CREATE TABLE IF NOT EXISTS addon_installations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  addon_key TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class = 'native_reviewed'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  mupot_compatibility TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed','configured','active','disabled','archived')),
  installed_by TEXT NOT NULL,
  latest_actor_id TEXT NOT NULL,
  latest_receipt_id TEXT,
  installed_at TEXT NOT NULL,
  configured_at TEXT,
  activated_at TEXT,
  disabled_at TEXT,
  archived_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (tenant, addon_key)
);

CREATE TABLE IF NOT EXISTS addon_operations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('activate','disable','archive')),
  target_state TEXT NOT NULL,
  current_step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','compensated')),
  actor_id TEXT NOT NULL,
  lease_expires_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_running_operation
  ON addon_operations (tenant, installation_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS addon_resource_ownership (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('exclusive','co_owner')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (tenant, installation_id, resource_type, resource_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_exclusive_resource
  ON addon_resource_ownership (tenant, resource_type, resource_id)
  WHERE active = 1 AND ownership_mode = 'exclusive';

CREATE TABLE IF NOT EXISTS addon_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  manifest_sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  side_effect_ids TEXT NOT NULL DEFAULT '[]',
  checks TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addon_receipts_installation
  ON addon_receipts (tenant, installation_id, created_at DESC);
```

- [ ] **Step 2: Write failing service tests**

Use the repository's D1 mock pattern from `tests/department-conformance.test.ts`. Assert:

```ts
it('install is inert and digest-bound', async () => {
  const result = await installAddon(env, { id: 'owner-1', role: 'owner' }, 'fixture-addon')
  expect(result).toMatchObject({ ok: true, state: 'installed', created: true })
  expect(db.departments()).toHaveLength(0)
  expect(db.resources()).toHaveLength(0)
  expect(db.receipts()[0]).toMatchObject({ action: 'install', outcome: 'pass' })
})

it('configure advances only an installed matching digest', async () => {
  await installAddon(env, owner, 'fixture-addon')
  expect(await configureAddon(env, owner, 'fixture-addon')).toMatchObject({ ok: true, state: 'configured' })
  expect(await configureAddon(env, owner, 'fixture-addon')).toMatchObject({ ok: true, state: 'configured', idempotent: true })
})
```

- [ ] **Step 3: Run the service tests and verify failure**

Run: `npx vitest run tests/addon-service.test.ts`

Expected: FAIL because `src/addons/service.ts` does not exist.

- [ ] **Step 4: Implement install and configure**

Use explicit result unions with stable reasons: `addon_not_registered`, `manifest_digest_drift`, `invalid_state`, `write_failed`, and `not_authorized`. Install writes the installation and install receipt in one D1 batch. Configure reloads the registered digest, verifies the fixture has empty connector and authority requirements, then compare-and-sets `installed -> configured` with a configure receipt. Repeated install/configure against the same digest returns the existing state without duplicating receipts.

- [ ] **Step 5: Run migration tests, service tests, and typecheck**

Run: `npx vitest run tests/addon-service.test.ts tests/department-conformance.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add migrations/0050_addons.sql src/addons/service.ts tests/addon-service.test.ts
git commit -m "feat(addons): persist inert addon installation"
```

---

### Task 4: Resumable Activation, Safe Disable, and Soft Archive

**Files:**
- Modify: `src/addons/service.ts`
- Modify: `tests/addon-service.test.ts`

**Interfaces:**
- Consumes: existing `activate` and `deactivate` from `src/departments/registry.ts`.
- Produces: `activateAddon(env, actor, key, deps?)`, `disableAddon(env, actor, key, deps?)`, and `archiveAddon(env, actor, key)`.

- [ ] **Step 1: Write failing lifecycle and interruption tests**

Add tests for:

```ts
it('activates the fixture once and records owned department', async () => {
  await installAddon(env, owner, 'fixture-addon')
  await configureAddon(env, owner, 'fixture-addon')
  const first = await activateAddon(env, owner, 'fixture-addon', departmentDeps)
  const second = await activateAddon(env, owner, 'fixture-addon', departmentDeps)
  expect(first).toMatchObject({ ok: true, state: 'active' })
  expect(second).toMatchObject({ ok: true, state: 'active', idempotent: true })
  expect(db.resources()).toHaveLength(1)
})

it('resumes an interrupted activation without duplicate department seeds', async () => {
  departmentDeps.afterDepartmentActivated = () => { throw new Error('interrupt') }
  expect((await activateAddon(env, owner, 'fixture-addon', departmentDeps)).ok).toBe(false)
  departmentDeps.afterDepartmentActivated = undefined
  expect(await activateAddon(env, owner, 'fixture-addon', departmentDeps)).toMatchObject({ ok: true, state: 'active' })
  expect(db.resources()).toHaveLength(1)
})

it('disable preserves receipts and archive cannot reactivate', async () => {
  await disableAddon(env, owner, 'fixture-addon', departmentDeps)
  const receiptCount = db.receipts().length
  await archiveAddon(env, owner, 'fixture-addon')
  expect(db.receipts().length).toBeGreaterThan(receiptCount)
  expect(await activateAddon(env, owner, 'fixture-addon', departmentDeps)).toMatchObject({ ok: false, reason: 'invalid_state' })
})
```

- [ ] **Step 2: Run lifecycle tests and verify failure**

Run: `npx vitest run tests/addon-service.test.ts`

Expected: FAIL because lifecycle functions are missing.

- [ ] **Step 3: Implement the durable operation sequence**

Activation sequence:

1. accept only `configured` or `disabled`; return idempotently for `active`;
2. verify current catalog digest and zero pending connector/authority requirements;
3. create or resume one `running` activate operation;
4. for each declared department, skip a matching active ownership row or call existing department `activate`;
5. persist an idempotent `co_owner` resource row after each successful department activation;
6. mark the operation complete;
7. compare-and-set the installation to `active` and append the receipt in one batch.

Disable sequence:

1. compare-and-set `active -> disabled` before touching resources;
2. for every active ownership row, mark only this installation's row released;
3. call department `deactivate` only when no active co-owner remains;
4. complete the operation and receipt; preserve department rows, squads, metrics, tasks, and prior receipts.

Archive accepts only `disabled`, compare-and-sets to `archived`, and appends a receipt. It performs no deletes.

- [ ] **Step 4: Run lifecycle and department tests**

Run: `npx vitest run tests/addon-service.test.ts tests/department-conformance.test.ts`

Expected: PASS, including interruption and co-owner cases.

- [ ] **Step 5: Commit lifecycle behavior**

```bash
git add src/addons/service.ts tests/addon-service.test.ts
git commit -m "feat(addons): add resumable native addon lifecycle"
```

---

### Task 5: Owner/Admin Addon API

**Files:**
- Create: `src/addons/routes.ts`
- Create: `tests/addon-routes.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: registry catalog and service functions from Tasks 2-4.
- Produces routes under `/api/addons`: `GET /`, `POST /:key/install`, `POST /:key/configure`, `POST /:key/activate`, `POST /:key/disable`, `POST /:key/archive`, and `GET /:key/receipts`.

- [ ] **Step 1: Write failing route tests**

Cover these exact contracts:

- member receives `403 { error: 'forbidden', detail: 'owner/admin only' }` on every write;
- owner `GET /api/addons` receives catalog plus tenant installation state without manifest internals that are not needed by UI;
- lifecycle commands accept an empty body only and reject body size over 8 KiB with `413`;
- invalid transition returns `409 { error: 'invalid_state', state }`;
- unknown key returns `404 { error: 'addon_not_registered' }`;
- same command retry returns `200` with `idempotent: true`.

- [ ] **Step 2: Run route tests and verify failure**

Run: `npx vitest run tests/addon-routes.test.ts`

Expected: FAIL because the router is absent.

- [ ] **Step 3: Implement the Hono router**

Follow `src/reseller/routes.ts`: `requireAuth`, owner/admin guard, declared and actual UTF-8 body cap, stable JSON errors, and no secret-bearing fields. Export `addonsApp` and mount it in `src/index.ts` before `app.route(ROUTES.dashboard, dashboardApp)`:

```ts
import { addonsApp } from './addons/routes'
// ...
app.route('/api/addons', addonsApp)
```

Import `./addons/modules/fixture` in `src/addons/routes.ts` so the reference addon self-registers without a kernel switch.

- [ ] **Step 4: Run route, auth, and type tests**

Run: `npx vitest run tests/addon-routes.test.ts tests/dashboard-auth-shell.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the API**

```bash
git add src/addons/routes.ts tests/addon-routes.test.ts src/index.ts
git commit -m "feat(addons): expose governed addon lifecycle API"
```

---

### Task 6: Addons Console

**Files:**
- Create: `src/dashboard/addons.ts`
- Create: `tests/dashboard-addons.test.ts`
- Modify: `src/dashboard/index.ts`

**Interfaces:**
- Consumes: `listRegisteredAddons`, `listAddonInstallations`, and lifecycle API routes.
- Produces: authenticated `/addons` page with catalog cards, state, digest tail, requested authority count, receipts link, and state-valid actions.

- [ ] **Step 1: Write failing rendering tests**

Assert the fixture renders:

```ts
expect(html).toContain('Addons')
expect(html).toContain('Fixture Addon')
expect(html).toContain('No connectors or authority requested')
expect(html).toContain('Install')
expect(html).not.toContain('Upgrade')
expect(html).not.toContain('Delete data')
```

Add state tests: installed shows Configure; configured shows Activate; active shows Disable; disabled shows Activate and Uninstall; archived shows no mutation button. Confirm every action button carries the addon key in `data-addon-key`, not a user-controlled URL.

- [ ] **Step 2: Run dashboard tests and verify failure**

Run: `npx vitest run tests/dashboard-addons.test.ts`

Expected: FAIL because the addon dashboard module is absent.

- [ ] **Step 3: Implement the server-rendered page**

Use the existing dashboard shell and CSS variables. Use compact 8px-or-less cards, a puzzle icon from the existing icon mechanism, and buttons only for lifecycle commands. The browser script calls fixed `/api/addons/{encodedKey}/{action}` endpoints, disables the clicked button during the request, displays the stable error code inline, and reloads after success.

Add `dashboardApp.get('/addons', ...)` before the catch-all and one `Addons` navigation entry. Do not add nested cards, gradients, or marketing copy.

- [ ] **Step 4: Run dashboard and shell regression tests**

Run: `npx vitest run tests/dashboard-addons.test.ts tests/dashboard-auth-shell.test.ts tests/dashboard-header-chips.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the console**

```bash
git add src/dashboard/addons.ts tests/dashboard-addons.test.ts src/dashboard/index.ts
git commit -m "feat(addons): add addon lifecycle console"
```

---

### Task 7: Evidence Receipt and End-to-End Verification

**Files:**
- Create: `scripts/addon-lifecycle-receipt.mjs`
- Create: `tests/addon-lifecycle-receipt.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: authenticated lifecycle API from Task 5.
- Produces: `mupot-addon-lifecycle/v1` redacted evidence JSON and strict checker.

- [ ] **Step 1: Write failing receipt tests**

Test that the checker requires:

```json
{
  "receipt_type": "mupot-addon-lifecycle/v1",
  "status": "pass",
  "addon_key": "fixture-addon",
  "transitions": ["installed", "configured", "active", "disabled", "active", "disabled", "archived"],
  "install_side_effect_count": 0,
  "manifest_sha256": "<64 lowercase hex>",
  "secrets_present": false
}
```

Reject missing transitions, a malformed digest, nonzero install side effects, archived reactivation, raw `authorization` fields, and any key matching `/token|secret|password/i`.

- [ ] **Step 2: Run receipt tests and verify failure**

Run: `npx vitest run tests/addon-lifecycle-receipt.test.ts`

Expected: FAIL because the receipt script does not exist.

- [ ] **Step 3: Implement plan/check modes**

Follow `scripts/work-lifecycle-receipt.mjs`: `--plan` prints exact operator steps without writes; `--check --base-url <url> --token-env <ENV_NAME>` performs the lifecycle against the fixture addon, records HTTP status and receipt IDs, redacts authorization, confirms no install resource ownership, and emits one strict JSON receipt. Read the bearer only from the named environment variable and never print it.

Add scripts:

```json
"receipt:addon-lifecycle:plan": "node scripts/addon-lifecycle-receipt.mjs --plan",
"receipt:addon-lifecycle:check": "node scripts/addon-lifecycle-receipt.mjs --check"
```

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npx vitest run tests/addon-contract.test.ts tests/addon-registry.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts tests/addon-lifecycle-receipt.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: focused tests PASS, typecheck exits `0`, full suite PASS, and diff check is empty.

- [ ] **Step 5: Run local browser verification**

Run migrations and the local server:

```bash
npm run migrate:local:test
npm run seed:local:test
npm run dev:local:test
```

Use Playwright at desktop `1440x1000` and mobile `390x844` to authenticate with the local fixture owner, open `/addons`, execute install/configure/activate/disable, and capture screenshots. Verify no overlap, stable button dimensions, visible errors, no console exceptions, and that `/api/addons` returns the matching state after every click. Keep the server running until browser verification is complete, then stop it.

- [ ] **Step 6: Commit the receipt and verification support**

```bash
git add scripts/addon-lifecycle-receipt.mjs tests/addon-lifecycle-receipt.test.ts package.json
git commit -m "test(addons): add native addon lifecycle receipt"
```

---

## Completion Gate

The native addon rail is complete only when:

- the full test suite and typecheck pass;
- the fixture lifecycle receipt reports `pass`;
- install proves zero side effects;
- activation retry and interruption recovery produce no duplicate resource;
- disable preserves all receipts and only releases fixture-owned resources;
- archive cannot reactivate;
- desktop and mobile browser checks pass;
- no raw credentials appear in responses, logs, screenshots, or receipts;
- Kasra or another independent reviewer approves the lifecycle, authority boundary, and evidence.

After this gate, create the second implementation plan for connector slots, separately gated rank/surface authority grants, and the Marketing/CRO reference addon on Mumega.
