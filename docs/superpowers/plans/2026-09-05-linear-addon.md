# Linear Project Board Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Linear as a native Mupot addon that exposes the existing Linear project-board adapter through the addon lifecycle without giving Linear execution authority.

**Architecture:** Add a small `AddonManifestV1` module for `linear-project-board`, import it from the existing addon module registry, and rely on the existing addon lifecycle, connector-binding UI, and project provider implementation. The addon declares a required read-only `linear` vault connector and no agents, loops, console sections, or authority grants.

**Tech Stack:** TypeScript, Hono dashboard HTML, Vitest, existing Mupot addon registry and connector vault.

**Spec:** `docs/superpowers/specs/2026-09-05-linear-addon.md`

## Global Constraints

- Use a fresh worktree for execution; do not stack this on the existing MUM-105 or MUM-107 worktrees.
- Linear is a source/adapter, not an authority plane.
- No Linear-originated text may wake an agent or authorize work.
- No new token, OAuth app, connector secret, webhook, deploy, publish, merge, or external send is part of this plan.
- The addon must request only a required read-only `linear` vault connector.
- The addon must declare no `authorityRequests`, no `agentTemplates`, no `loops`, no `eventSubscriptions`, and no `consoleSections`.
- Keep existing Linear provider semantics unchanged: connector required, admin-selected squad, unassigned import, `skipEvent: true`, `skipMirror: true`.

---

## File Structure

- Create: `src/addons/modules/linear-project-board.ts`
  - Owns the native addon manifest and registration call.
- Modify: `src/addons/modules/index.ts`
  - Imports the new module so production registry initialization includes it.
- Modify: `tests/addon-registry.test.ts`
  - Proves the manifest registers and carries the intended no-authority, read-only connector contract.
- Modify: `tests/addon-routes.test.ts`
  - Updates the public `/api/addons` catalog expectation to include Linear.
- Modify: `tests/dashboard-addons.test.ts`
  - Proves `/addons` renders a Linear vault binding and does not auto-configure it as first-party.

---

### Task 1: Create the Linear Addon Manifest

**Files:**
- Create: `src/addons/modules/linear-project-board.ts`
- Modify: `src/addons/modules/index.ts`
- Test: `tests/addon-registry.test.ts`

**Interfaces:**
- Consumes: `AddonManifestV1` from `src/addons/contract.ts`; `registerAddon(manifest)` from `src/addons/registry.ts`.
- Produces: `LinearProjectBoardAddon: AddonManifestV1` with key `linear-project-board`.

- [ ] **Step 1: Write the failing registry test**

Add this import near the top of `tests/addon-registry.test.ts`:

```ts
import { LinearProjectBoardAddon } from '../src/addons/modules/linear-project-board'
```

Add this test before the closing `})` of `describe('addon registry', () => {`:

```ts
  it('registers the Linear project board addon as a read-only adapter with no authority', async () => {
    const registry = createAddonRegistry()

    await registry.register(LinearProjectBoardAddon)

    expect(registry.get(LinearProjectBoardAddon.key)?.manifest).toMatchObject({
      schema: 'mupot.addon/v1',
      key: 'linear-project-board',
      name: 'Linear Project Board',
      trustClass: 'native_reviewed',
      kind: 'native',
      connectorRequirements: [{
        slot: 'project_board',
        accepts: ['linear'],
        required: true,
        capability: 'read',
        bindingKind: 'vault_connector',
      }],
      authorityRequests: { rankGrants: [], surfaceGrants: [] },
      agentTemplates: [],
      loops: [],
      consoleSections: [],
      eventSubscriptions: [],
    })
  })
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- tests/addon-registry.test.ts
```

Expected: fail because `../src/addons/modules/linear-project-board` does not exist.

- [ ] **Step 3: Add the minimal manifest**

Create `src/addons/modules/linear-project-board.ts`:

```ts
import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

export const LinearProjectBoardAddon = Object.freeze<AddonManifestV1>({
  schema: 'mupot.addon/v1',
  key: 'linear-project-board',
  name: 'Linear Project Board',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.30.0',
  kind: 'native',
  description: 'Read-only Linear project board source for Mupot-governed project work.',
  departments: [],
  agentTemplates: [],
  connectorRequirements: [
    {
      slot: 'project_board',
      accepts: ['linear'],
      required: true,
      capability: 'read',
      bindingKind: 'vault_connector',
    },
  ],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [],
  playbooks: [],
  loops: [],
  consoleSections: [],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
})

await registerAddon(LinearProjectBoardAddon)
```

- [ ] **Step 4: Register the module in the catalog bootstrap**

Modify `src/addons/modules/index.ts` so it imports the new module:

```ts
import './fixture'
import './marketing-cro-monitor'
import './linear-project-board'
import '../project-link/manifest'
import '../workflow-circuits/manifest'
```

- [ ] **Step 5: Run the registry test**

Run:

```bash
npm test -- tests/addon-registry.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/addons/modules/linear-project-board.ts src/addons/modules/index.ts tests/addon-registry.test.ts
git commit -m "feat: add Linear project board addon manifest"
```

---

### Task 2: Expose Linear in the Addon API Catalog

**Files:**
- Modify: `tests/addon-routes.test.ts`

**Interfaces:**
- Consumes: production addon registry initialized by `src/addons/modules/index.ts`.
- Produces: `/api/addons` catalog includes public Linear addon fields without manifest internals.

- [ ] **Step 1: Update the failing API catalog expectation**

In `tests/addon-routes.test.ts`, find the test named:

```ts
it('returns the UI catalog joined with this tenant installation state without manifest internals', async () => {
```

Add this object after the `marketing-cro-monitor` entry and before `project-link`:

```ts
      {
        key: 'linear-project-board',
        name: 'Linear Project Board',
        version: '1.0.0',
        publisher: 'mumega',
        trustClass: 'native_reviewed',
        kind: 'native',
        description: 'Read-only Linear project board source for Mupot-governed project work.',
        state: null,
      },
```

- [ ] **Step 2: Run the API catalog test**

Run:

```bash
npm test -- tests/addon-routes.test.ts -- -t "returns the UI catalog"
```

Expected: pass if Task 1 is complete. If it fails on ordering, update only the expected array order to match `src/addons/modules/index.ts`.

- [ ] **Step 3: Run the full addon routes suite**

Run:

```bash
npm test -- tests/addon-routes.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit Task 2**

```bash
git add tests/addon-routes.test.ts
git commit -m "test: expose Linear addon in catalog API"
```

---

### Task 3: Prove Dashboard Binding Behavior

**Files:**
- Modify: `tests/dashboard-addons.test.ts`

**Interfaces:**
- Consumes: `addonsBody(entries, installations, builtInRoutes, connectors)` from `src/dashboard/addons.ts`.
- Produces: regression coverage that Linear renders as a required vault connector and does not get a first-party auto-binding.

- [ ] **Step 1: Add the Linear addon import**

Add this import near the existing addon imports in `tests/dashboard-addons.test.ts`:

```ts
import { LinearProjectBoardAddon } from '../src/addons/modules/linear-project-board'
```

- [ ] **Step 2: Add the failing dashboard test**

Add this test before the closing `})` of `describe('addonsBody', () => {`:

```ts
  it('renders Linear as a required vault connector without a first-party configure shortcut', () => {
    const entry: AddonCatalogEntry = {
      manifest: LinearProjectBoardAddon,
      manifestSha256: 'b'.repeat(64),
    }
    const body = String(addonsBody([entry], [], dashboardBuiltInGetRoutes, [{
      id: 'connector-linear-1',
      type: 'linear',
      label: 'Mumega Linear',
      meta: '{"workspace":"mumega"}',
      scope_type: 'pot',
      scope_id: null,
      created_by: 'owner-1',
      created_at: '2026-09-05T00:00:00.000Z',
      revoked_at: null,
    }]))

    expect(body).toContain('Linear Project Board')
    expect(body).toContain('Required read source')
    expect(body).toContain('Mumega Linear')
    expect(body).toContain('connector-linear-1')
    expect(body).toContain('data-addon-binding-select')
    expect(body).not.toContain('First-party internal data')
    expect(body).not.toContain('data-addon-configure-body')
    expect(body).not.toContain('encrypted_secret')
  })
```

- [ ] **Step 3: Run the focused dashboard test**

Run:

```bash
npm test -- tests/dashboard-addons.test.ts -- -t "renders Linear as a required vault connector"
```

Expected: pass if Task 1 is complete.

- [ ] **Step 4: Run the dashboard addon suite**

Run:

```bash
npm test -- tests/dashboard-addons.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add tests/dashboard-addons.test.ts
git commit -m "test: render Linear addon connector binding"
```

---

### Task 4: Verify Existing Linear Provider Boundaries Still Hold

**Files:**
- Test only: `tests/linear-board-provider.test.ts`
- Test only: `tests/linear-issues.test.ts`
- Test only: `tests/connectors-linear-auth.test.ts`

**Interfaces:**
- Consumes: existing `createLinearBoardPort`, `fetchLinearIssues`, `importLinearIssues`, and connector vault behavior.
- Produces: evidence that adding the addon did not change Linear execution boundaries.

- [ ] **Step 1: Run Linear connector/auth tests**

Run:

```bash
npm test -- tests/connectors-linear-auth.test.ts
```

Expected: pass.

- [ ] **Step 2: Run Linear issues bridge tests**

Run:

```bash
npm test -- tests/linear-issues.test.ts
```

Expected: pass.

- [ ] **Step 3: Run Linear board provider tests**

Run:

```bash
npm test -- tests/linear-board-provider.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit only if test fixtures need adjustment**

If no files changed in Task 4, do not commit. If test fixture changes were required:

```bash
git add tests/linear-board-provider.test.ts tests/linear-issues.test.ts tests/connectors-linear-auth.test.ts
git commit -m "test: preserve Linear provider boundaries"
```

---

### Task 5: Final Verification

**Files:**
- No source files expected.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: local evidence package for Hadi review.

- [ ] **Step 1: Run focused addon and Linear suites together**

Run:

```bash
npm test -- tests/addon-registry.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts tests/connectors-linear-auth.test.ts tests/linear-issues.test.ts tests/linear-board-provider.test.ts
```

Expected: pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git diff HEAD~3..HEAD -- src/addons/modules/linear-project-board.ts src/addons/modules/index.ts tests/addon-registry.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts
```

Expected: only the manifest, module import, and focused tests changed.

- [ ] **Step 4: Prepare review summary**

Use this summary shape:

```markdown
Implemented draft Linear addon registration.

Changed:
- Added `linear-project-board` native addon manifest.
- Required read-only `linear` vault connector binding.
- Registered it in addon bootstrap.
- Added registry, API catalog, and dashboard binding coverage.

Verified:
- `npm test -- tests/addon-registry.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts tests/connectors-linear-auth.test.ts tests/linear-issues.test.ts tests/linear-board-provider.test.ts`
- `npm run typecheck`

Not done:
- No deployment.
- No connector secret created.
- No Linear OAuth/app mutation.
- No webhook/wake/write-back behavior.
```

- [ ] **Step 5: Hold for Hadi**

Do not merge, deploy, publish, create credentials, or update Linear externally from this plan.

---

## Execution Preflight

Before Task 1, create the isolated worktree:

```bash
cd /Users/hadi/dev/mumega/mupot
git fetch origin main
git worktree add /Users/hadi/dev/worktrees/mupot-linear-addon -b mum-linear-addon origin/main
cd /Users/hadi/dev/worktrees/mupot-linear-addon
```

Check for unexpected dirt:

```bash
git status --short --branch
```

Expected: clean branch `mum-linear-addon`.

---

## Self-Review

- Spec coverage: all spec requirements map to Tasks 1 through 5.
- Placeholder scan: no unresolved implementation markers or unspecified steps remain.
- Type consistency: `LinearProjectBoardAddon`, `linear-project-board`, `project_board`, and `linear` are used consistently.
- Authority boundary: no task adds Linear wake, webhook, write-back, credential minting, agent assignment, or authority grants.
