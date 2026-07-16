# Marketing/CRO Monitor V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a read-only `marketing-cro-monitor` addon that can be configured with tenant-local first-party evidence, proves unavailable-not-zero outcomes with deterministic fixtures, renders an operational console, and can later add vault-backed MCPWP/PostHog reads without changing the addon manifest.

**Architecture:** Keep lifecycle, departments, tasks, flights, metrics, connectors, and approvals in their existing owners. Add a generic addon renderer registry, secret-free tenant-scoped slot bindings, and a Marketing/CRO monitor package that resolves bindings at the Worker boundary and returns only normalized evidence. Persist immutable monitor runs separately from lifecycle receipts; the first pilot creates recommendations but has no external write executor.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1/SQLite, server-rendered HTML, Vitest.

## Global Constraints

- The first release is read-only and cannot publish content, mutate a CMS/CRM, send outreach, or widen authority.
- `marketing-cro-monitor` version is `1.0.0`; its manifest digest must remain identical between Mumega and DME.
- Required `web_analytics` accepts `first_party` and `posthog`; optional `content_surface` accepts `inkwell` and `mcpwp`; every binding capability is exactly `read`.
- Binding rows and HTTP responses never contain plaintext or encrypted connector secrets.
- Tenant comes only from `env.TENANT_SLUG`; connector IDs must resolve in the same tenant and must not be revoked.
- Missing, revoked, failed, or stale sources are unavailable; absence is never converted to numeric zero.
- Source output is bounded, malformed observations are rejected, redirects are refused, and outbound hosts use the shared SSRF guard.
- Disabled and archived installations cannot run sources or create recommendations.
- Fixture IDs and timestamps are injected; fixture data is never placed in production seed paths.
- The opportunity loop is disabled by default and produces at most one review recommendation per evidence window.
- Every task follows red-green-refactor: add one failing behavior test, verify the expected failure, add the minimum implementation, then rerun focused tests.

---

### Task 1: Generic Addon Renderer Registry and Marketing Manifest

**Files:**
- Create: `src/addons/console-registry.ts`
- Create: `src/addons/modules/marketing-cro-monitor.ts`
- Create: `src/addons/modules/index.ts`
- Modify: `src/addons/modules/fixture.ts`
- Modify: `src/addons/registry.ts`
- Modify: `src/addons/routes.ts`
- Modify: `src/dashboard/addons.ts`
- Test: `tests/addon-console-registry.test.ts`
- Test: `tests/addon-registry.test.ts`
- Test: `tests/addon-contract.test.ts`

**Interfaces:**
- Produces: `AddonConsoleRenderer`, `registerAddonConsoleRenderer()`, `getAddonConsoleRenderer()`, and immutable `MarketingCroMonitorAddon`.
- Consumes: `AddonManifestV1`, registered department modules, and the existing addon registry.

- [ ] **Step 1: Write failing registry and manifest tests**

```ts
it('resolves a pre-registered addon renderer independently of departments', () => {
  registerAddonConsoleRenderer({
    key: 'marketing-cro-monitor',
    path: '/addons/marketing-cro-monitor',
    title: 'Marketing & CRO',
    navIcon: 'chart-no-axes-combined',
    render: async () => html`<p>Unavailable until configured</p>`,
  })
  expect(getAddonConsoleRenderer('marketing-cro-monitor')?.path).toBe('/addons/marketing-cro-monitor')
})

it('registers the read-only marketing monitor manifest', async () => {
  expect(MarketingCroMonitorAddon.connectorRequirements).toEqual(expect.arrayContaining([
    expect.objectContaining({ slot: 'web_analytics', capability: 'read', required: true }),
    expect.objectContaining({ slot: 'content_surface', capability: 'read', required: false }),
  ]))
  expect(MarketingCroMonitorAddon.authorityRequests).toEqual({ rankGrants: [], surfaceGrants: [] })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts`

Expected: FAIL because the renderer registry and marketing manifest do not exist.

- [ ] **Step 3: Implement the renderer registry and manifest**

```ts
export interface AddonConsoleRenderer {
  key: string
  path: string
  title: string
  navIcon: string
  render(env: Env, installation: AddonInstallation | null): Promise<HtmlEscapedString>
}

export function registerAddonConsoleRenderer(renderer: AddonConsoleRenderer): void
export function getAddonConsoleRenderer(key: string): AddonConsoleRenderer | undefined
```

Register one renderer key per process, freeze the record, and make `assertAddonRuntimeContract()` validate console sections against this registry rather than department sections. Add a side-effect-only `modules/index.ts` importing both fixture and marketing modules, and replace scattered fixture imports with that index. Register the fixture renderer at its existing `/departments/fixture` location for backward compatibility; the marketing renderer uses `/addons/marketing-cro-monitor`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts tests/dashboard-addons.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/addons tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts tests/dashboard-addons.test.ts
git commit -m "feat(addons): register marketing CRO console"
```

### Task 2: Secret-Free Addon Bindings and Configuration Preflight

**Files:**
- Create: `migrations/0052_addon_bindings.sql`
- Create: `src/addons/bindings.ts`
- Modify: `src/addons/service.ts`
- Modify: `src/addons/routes.ts`
- Modify: `src/connectors/service.ts`
- Test: `tests/addon-bindings.test.ts`
- Test: `tests/addon-routes.test.ts`
- Test: `tests/addon-service.test.ts`

**Interfaces:**
- Produces: `AddonBindingInput`, `AddonBinding`, `configureAddonBindings()`, `listAddonBindings()`, `preflightAddonBindings()`, and `resolveConnectorByIdWithMeta()`.
- Consumes: immutable manifest connector requirements, live installation state, and tenant-scoped connector rows.

- [ ] **Step 1: Write failing binding tests**

```ts
it('configures the required first-party slot without a credential', async () => {
  const result = await configureAddon(env, owner, 'marketing-cro-monitor', {
    bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
  })
  expect(result).toMatchObject({ ok: true, state: 'configured' })
  expect(await listAddonBindings(env, result.installation.id)).toEqual([
    expect.objectContaining({ slot: 'web_analytics', adapter: 'first_party', capability: 'read', connectorId: null }),
  ])
})

it('rejects cross-tenant, revoked, wrong-type, and write-widened bindings', async () => {
  await expectPreflightFailure('connector_not_available')
  await expectPreflightFailure('adapter_type_mismatch')
  await expectPreflightFailure('capability_mismatch')
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts`

Expected: FAIL because configure accepts no binding payload and the table does not exist.

- [ ] **Step 3: Add the binding schema**

```sql
CREATE TABLE addon_connector_bindings (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  adapter TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('internal_adapter','vault_connector')),
  capability TEXT NOT NULL CHECK (capability = 'read'),
  connector_id TEXT,
  manifest_sha256 TEXT NOT NULL,
  configured_by TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (installation_id, tenant) REFERENCES addon_installations(id, tenant),
  CHECK ((binding_kind = 'internal_adapter' AND connector_id IS NULL)
      OR (binding_kind = 'vault_connector' AND connector_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_addon_live_binding_slot
  ON addon_connector_bindings(tenant, installation_id, slot)
  WHERE revoked_at IS NULL;
```

Add append-only/no-update guards except the single `revoked_at NULL -> timestamp` transition. Add a trigger preventing live bindings on archived installations.

- [ ] **Step 4: Implement validation and lifecycle integration**

```ts
export interface AddonBindingInput {
  slot: string
  adapter: string
  bindingKind: 'internal_adapter' | 'vault_connector'
  connectorId?: string
}

export type AddonBindingPreflight =
  | { ok: true; bindings: AddonBinding[] }
  | { ok: false; reason: 'missing_required_slot' | 'unknown_slot' | 'adapter_not_allowed' |
      'binding_kind_mismatch' | 'connector_not_available' | 'adapter_type_mismatch' |
      'capability_mismatch' | 'manifest_digest_drift' }
```

`first_party` is the only initial internal adapter. Vault validation selects only safe connector columns by exact ID + `env.TENANT_SLUG`, rejects revoked rows, and compares type to adapter. Configuration writes the new binding generation and the lifecycle receipt in one `env.DB.batch()`. Empty configuration remains valid for zero-requirement fixture addons. Activation re-runs preflight. Disable preserves bindings; archive revokes them.

- [ ] **Step 5: Add bounded route parsing**

Accept either an empty body for legacy zero-requirement addons or JSON `{ "bindings": [...] }` up to 8 KiB. Reject unknown keys, duplicate slots, non-string fields, and bodies on non-configure lifecycle actions.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0052_addon_bindings.sql src/addons src/connectors/service.ts tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts
git commit -m "feat(addons): add read-only connector bindings"
```

### Task 3: Normalized Source Snapshots and Deterministic Fixtures

**Files:**
- Create: `src/addons/marketing/types.ts`
- Create: `src/addons/marketing/sources.ts`
- Create: `src/addons/marketing/outcomes.ts`
- Create: `tests/fixtures/marketing-monitor.ts`
- Test: `tests/marketing-monitor-sources.test.ts`
- Test: `tests/marketing-monitor-outcomes.test.ts`

**Interfaces:**
- Produces: `MarketingMonitorSource`, `MonitorWindow`, `SourceSnapshot`, `MonitorObservation`, `OutcomeValue`, `collectMarketingSnapshots()`, and `deriveMarketingOutcomes()`.
- Consumes: resolved safe binding metadata; no source receives a connector row or raw secret through HTTP-facing types.

- [ ] **Step 1: Write failing source-isolation and unavailable tests**

```ts
it('keeps healthy source evidence when an optional source fails', async () => {
  const snapshot = await collectMarketingSnapshots(env, bindings, window, [healthyFixture, failingFixture])
  expect(snapshot.observations).toHaveLength(5)
  expect(snapshot.sources).toContainEqual(expect.objectContaining({ key: 'content', status: 'failed' }))
})

it('does not render missing revenue as zero', () => {
  const outcomes = deriveMarketingOutcomes(fixtureObservations)
  expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts`

Expected: FAIL because the monitor contracts do not exist.

- [ ] **Step 3: Implement the contracts and collector**

```ts
export interface MarketingMonitorSource {
  readonly key: string
  readonly slot: string
  read(env: Env, binding: ResolvedAddonBinding, window: MonitorWindow): Promise<SourceSnapshot>
}

export type OutcomeValue =
  | { status: 'available'; value: number; unit: string; source: string; observedAt: string }
  | { status: 'unavailable'; reason: string }
```

Cap each source at 200 observations before validation. Accept only declared metric keys, finite values, non-empty units/authorities, and ISO timestamps within the requested window. Run sources sequentially for stable evidence order. Return source statuses `available`, `unavailable`, or `failed` with stable non-secret reasons.

- [ ] **Step 4: Add deterministic fixture evidence**

The fixture exports a source factory requiring injected `runId`, `observedAt`, and window. It emits exactly `seo.ai_citations`, `seo.organic_sessions`, `growth.leads`, `growth.replies`, and `seo.conversion_rate`; revenue remains unavailable.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/addons/marketing tests/fixtures/marketing-monitor.ts tests/marketing-monitor-*.test.ts
git commit -m "feat(marketing): normalize monitor evidence"
```

### Task 4: Durable Monitor Runs and Read API

**Files:**
- Create: `migrations/0053_marketing_monitor_runs.sql`
- Create: `src/addons/marketing/service.ts`
- Modify: `src/addons/routes.ts`
- Test: `tests/marketing-monitor-service.test.ts`
- Test: `tests/addon-routes.test.ts`

**Interfaces:**
- Produces: `runMarketingMonitor()`, `getLatestMarketingMonitorRun()`, `listMarketingMonitorRuns()`, and redacted `POST/GET /api/addons/marketing-cro-monitor/monitor` endpoints.
- Consumes: active installation, current bindings, normalized sources, and outcome derivation.

- [ ] **Step 1: Write failing active-state and idempotency tests**

```ts
it('persists one immutable run for an active installation and evidence window', async () => {
  const first = await runMarketingMonitor(env, actor, input, deps)
  const second = await runMarketingMonitor(env, actor, input, deps)
  expect(second).toMatchObject({ ok: true, idempotent: true, run: { id: first.run.id } })
})

it.each(['installed', 'configured', 'disabled', 'archived'])('refuses a %s installation', async (state) => {
  expect(await runForState(state)).toEqual({ ok: false, reason: 'addon_not_active' })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/marketing-monitor-service.test.ts tests/addon-routes.test.ts`

Expected: FAIL because monitor persistence and routes do not exist.

- [ ] **Step 3: Add immutable run tables**

Create `marketing_monitor_runs`, `marketing_monitor_sources`, and `marketing_monitor_observations`. Bind every row to tenant + installation + evidence window. Add a unique dedup index on `(tenant, installation_id, program_version, window_start, window_end)`, JSON validity checks, source/observation caps enforced by service, and no-update/no-delete triggers.

- [ ] **Step 4: Implement run persistence and redacted APIs**

Use one D1 batch for the run, source statuses, observations, and final digest. APIs return normalized outcomes, stable source statuses, evidence IDs, and timestamps only. They never return connector IDs, connector metadata, upstream payloads, or secrets. POST requires owner/admin and an active installation; GET is owner/admin read-only.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/marketing-monitor-service.test.ts tests/addon-routes.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0053_marketing_monitor_runs.sql src/addons/marketing/service.ts src/addons/routes.ts tests/marketing-monitor-service.test.ts tests/addon-routes.test.ts
git commit -m "feat(marketing): persist read-only monitor runs"
```

### Task 5: Operational Addon Console

**Files:**
- Create: `src/dashboard/marketing-cro-monitor.ts`
- Modify: `src/addons/modules/marketing-cro-monitor.ts`
- Modify: `src/dashboard/index.ts`
- Modify: `src/dashboard/addons.ts`
- Test: `tests/dashboard-marketing-cro-monitor.test.ts`

**Interfaces:**
- Produces: `loadMarketingCroMonitorView()` and `marketingCroMonitorBody()`.
- Consumes: latest run, bindings, installation state, existing dashboard UI primitives.

- [ ] **Step 1: Write failing renderer tests**

```ts
it('renders outcomes, source health, runs, and unavailable revenue honestly', async () => {
  const html = String(marketingCroMonitorBody(view))
  expect(html).toContain('AI visibility')
  expect(html).toContain('Source health')
  expect(html).toContain('Revenue')
  expect(html).toContain('Unavailable')
  expect(html).not.toMatch(/Revenue[\s\S]{0,100}>0</)
})

it('keeps the monitor surface within a 390px viewport', () => {
  expect(String(marketingCroMonitorBody(view))).toContain('@media (max-width: 680px)')
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/dashboard-marketing-cro-monitor.test.ts tests/dashboard-addons.test.ts`

Expected: FAIL because the operational renderer does not exist.

- [ ] **Step 3: Implement server-rendered console and generic route**

Render a compact outcome strip, source-health rows, one opportunity panel, recent runs, and receipt links. Add a generic dashboard route that resolves the renderer from the registered manifest section and fails closed for unknown/uninstalled addons. The catalog card links to the operational console only after installation.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/dashboard-marketing-cro-monitor.test.ts tests/dashboard-addons.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard src/addons/modules/marketing-cro-monitor.ts tests/dashboard-marketing-cro-monitor.test.ts tests/dashboard-addons.test.ts
git commit -m "feat(marketing): render monitor console"
```

### Task 6: First-Party, PostHog, Inkwell, and MCPWP Read Adapters

**Files:**
- Create: `src/addons/marketing/adapters/first-party.ts`
- Create: `src/addons/marketing/adapters/posthog.ts`
- Create: `src/addons/marketing/adapters/inkwell.ts`
- Create: `src/addons/marketing/adapters/mcpwp.ts`
- Create: `src/addons/marketing/adapters/index.ts`
- Modify: `src/connectors/service.ts`
- Test: `tests/marketing-monitor-adapters.test.ts`

**Interfaces:**
- Produces: registered adapter records for `first_party`, `posthog`, `inkwell`, and `mcpwp`.
- Consumes: `firstPartyCroSource`, safe Inkwell GET, exact-ID vault resolver, `parseWpConnectorConfig()`, shared SSRF guard, bounded redirect-refusing fetch.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('maps first-party points into normalized observations without re-persisting them', async () => {
  expect(await firstPartyMarketingSource.read(env, binding, window)).toMatchObject({ status: 'available' })
  expect(dbWrites).toEqual([])
})

it('reads bounded WordPress post metadata using GET and refuses redirects', async () => {
  await mcpwpMarketingSource.read(env, binding, window)
  expect(fetchCalls[0].init).toMatchObject({ method: 'GET', redirect: 'manual' })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/marketing-monitor-adapters.test.ts tests/cro-sources.test.ts tests/cro-posthog.test.ts tests/executor-mcpwp-s4.test.ts`

Expected: FAIL because monitor adapters and exact-ID vault resolution do not exist.

- [ ] **Step 3: Implement adapter boundaries**

The first-party adapter wraps existing tenant-scoped `metric_points` reads. PostHog uses the existing aggregate query shape but receives vault-resolved key + non-secret project/host metadata. Inkwell wraps the existing guarded read primitive. MCPWP performs one bounded core REST GET for published post metadata only, with `_fields`, `per_page <= 50`, 8-second timeout, `redirect: 'manual'`, Basic auth at call time, and no response-body echo. Exact-ID connector resolution decrypts only for the immediate adapter call and returns `null` on tenant mismatch or revocation.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/marketing-monitor-adapters.test.ts tests/cro-sources.test.ts tests/cro-posthog.test.ts tests/executor-mcpwp-s4.test.ts tests/connectors.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/addons/marketing/adapters src/connectors/service.ts tests/marketing-monitor-adapters.test.ts
git commit -m "feat(marketing): add read-only source adapters"
```

### Task 7: One Deduplicated Governed Recommendation

**Files:**
- Create: `migrations/0054_marketing_recommendations.sql`
- Create: `src/addons/marketing/opportunities.ts`
- Modify: `src/addons/marketing/service.ts`
- Modify: `src/dashboard/marketing-cro-monitor.ts`
- Test: `tests/marketing-monitor-opportunities.test.ts`

**Interfaces:**
- Produces: `rankMarketingOpportunities()` and `prepareMarketingRecommendation()`.
- Consumes: latest immutable run, canonical `createTask()`, `createFlight()`, addon-owned Web Operations squad, and approval gate metadata.

- [ ] **Step 1: Write failing bounded/dedup tests**

```ts
it('creates at most one task and flight for the same evidence window', async () => {
  const first = await prepareMarketingRecommendation(env, actor, run.id)
  const second = await prepareMarketingRecommendation(env, actor, run.id)
  expect(second).toMatchObject({ ok: true, idempotent: true, recommendation: { id: first.recommendation.id } })
  expect(createdTasks).toHaveLength(1)
  expect(createdFlights).toHaveLength(1)
})

it('never calls an external executor', async () => {
  await prepareMarketingRecommendation(env, actor, run.id)
  expect(executorCalls).toEqual([])
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/marketing-monitor-opportunities.test.ts`

Expected: FAIL because opportunity persistence and creation do not exist.

- [ ] **Step 3: Add recommendation evidence table and service**

Persist target, problem, hypothesis, KPI baseline, limiting unavailable evidence, dedup key, task ID, flight ID, approval requirement, and receipt digest. The unique dedup key includes tenant, installation, program version, target, window, and kind. Rank deterministic candidates and select at most one. The task terminal is `review`; the flight terminal action is `recommendation_ready`; no executor is attached.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/marketing-monitor-opportunities.test.ts tests/flight-service.test.ts tests/tasks-service.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0054_marketing_recommendations.sql src/addons/marketing src/dashboard/marketing-cro-monitor.ts tests/marketing-monitor-opportunities.test.ts
git commit -m "feat(marketing): prepare governed CRO recommendations"
```

### Task 8: Lifecycle Receipt, Browser Validation, and Mumega Pilot

**Files:**
- Create: `scripts/marketing-monitor-lifecycle-receipt.mjs`
- Create: `tests/marketing-monitor-lifecycle-receipt.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-16-marketing-cro-monitor-addon-design.md`

**Interfaces:**
- Produces: deterministic local receipt and authenticated live receipt bundle.
- Consumes: lifecycle APIs, binding API, monitor API, console, and recommendation evidence.

- [ ] **Step 1: Write failing receipt verifier tests**

The verifier must require install, configure with `first_party`, activate, read, one recommendation, disable, archive, reinstall, and repeat. It must reject duplicated live bindings/work, unavailable rendered as zero, missing task/flight linkage, active resources after archive, and manifest digest drift.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/marketing-monitor-lifecycle-receipt.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement the verifier and package command**

Add `npm run receipt:marketing-monitor`. Default mode is read-only instructions; explicit authenticated mode performs writes only against the named tenant and archives the fixture lifecycle at the end.

- [ ] **Step 4: Run complete verification**

Run: `npm run typecheck`

Run: `npx vitest run --maxWorkers=4`

Run: `git diff --check`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 5: Validate local and production browser flows**

Run local migrations and dev Worker. Exercise desktop and 390x844 views through install, configure, activate, monitor, disable, archive, and reinstall. After independent review and deployment, repeat on Mumega with `first_party`, leave the production addon disabled unless the owner explicitly chooses active monitoring, and attach the receipt URL to the PR.

- [ ] **Step 6: Commit**

```bash
git add scripts/marketing-monitor-lifecycle-receipt.mjs tests/marketing-monitor-lifecycle-receipt.test.ts package.json docs/superpowers/specs/2026-07-16-marketing-cro-monitor-addon-design.md
git commit -m "test(marketing): verify monitor lifecycle"
```

## Self-Review

- Spec coverage: delivery slices 1-7 and every V1 acceptance criterion map to Tasks 1-8. Approval-gated external execution remains explicitly outside V1.
- Placeholder scan: no task depends on TBD/TODO behavior; GSC and AI-visibility remain optional unavailable sources exactly as specified.
- Type consistency: binding, source, outcome, run, recommendation, renderer, and route names are introduced once and consumed by later tasks with the same names.
- Security coverage: Tasks 2, 4, and 6 cover tenant binding, revocation, redaction, SSRF, timeouts, redirect refusal, and read-only capability.
- Evidence coverage: Tasks 3, 4, 7, and 8 prove unavailable-not-zero, immutable runs, one deduplicated recommendation, lifecycle cleanup, and reproducible receipts.
