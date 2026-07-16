# Mupot Addon Framework Design

**Status:** Proposed
**Date:** 2026-07-15
**Reference addon:** Marketing Activity & Outcomes

## 1. Goal

Make business capabilities installable and activatable per pot without turning the
Mupot core into a collection of tenant-specific branches.

An addon packages the operating model for a business function: departments, squads,
agents, metrics, connector requirements, playbooks, loops, console surfaces, and
governance policies. The first addon composes Mupot's existing marketing primitives and
is activated on the Mumega pot. A later Accounting addon must use the same contract
without requiring marketing-specific changes to the addon kernel.

The product focus is Marketing and CRO. Accounting is only a portability check for the
contract and is not a near-term delivery target. Repository visibility is an operator and
commercial decision: Mupot may remain public or become private. Tenant safety must rely on
identity, isolation, capabilities, gates, and secret handling, never on source secrecy.

## 2. Product Boundary

Mupot core remains responsible for:

- identity, membership, tenant isolation, and capability RBAC;
- tasks, flights, approvals, receipts, audit, memory, and metering;
- the connector vault and connector resolution;
- lifecycle enforcement and addon health reporting.

An addon is responsible for declaring:

- the business departments and squads it needs;
- the connectors, capabilities, metrics, loops, and playbooks it provides or requires;
- its console entry points and operator-facing setup requirements;
- its approval defaults, data-retention expectations, and health checks.

An addon cannot mint authority, read raw connector secrets, bypass a gate, add arbitrary
routes at runtime, or execute untrusted code inside the Mupot Worker.

## 3. Approaches Considered

### 3.1 Addon as a renamed department

This is the smallest change, but a department is only one organizational unit. Marketing
needs to compose Growth, Agency, and Web Operations, while Accounting may compose
Bookkeeping, AP, AR, and Controller functions. Reusing the department abstraction would
make cross-department policies, connectors, health, and lifecycle ambiguous.

### 3.2 Arbitrary uploaded plugin code

This gives maximum flexibility but creates an unacceptable trust boundary. Uploaded code
could access Worker bindings, bypass capability checks, or leak tenant data. Cloudflare
Worker bundles also do not naturally support safe dynamic code loading.

### 3.3 Declarative addon manifests with trusted native and isolated external runtimes

This is the recommended design. Native addons are compiled, reviewed packages registered
with the Worker. External addons run in their own Worker, VPS process, or SaaS and connect
through MCP with explicitly granted capabilities. Both use the same declarative catalog
and tenant lifecycle.

## 4. Core Model

### 4.1 Addon kinds

**Native addon**

- Code is compiled into the Mupot release.
- The manifest may reference registered department modules, loop factories, playbooks,
  health checks, and pre-registered console renderers.
- Suitable for official Marketing, Accounting, Customer Success, Grants, and Web
  Operations packages.

**External MCP addon**

- Code and data processing run outside the Mupot Worker.
- The manifest declares an MCP connector, requested capabilities, tool intents, event
  subscriptions, and optional MCP App/deep-link surfaces.
- The external runtime receives scoped calls and data, never direct access to D1,
  Durable Objects, Worker environment variables, or the connector master key.

The contract reserves the external kind now, but first-release execution supports native
addons only. External MCP activation remains disabled until native ownership, grant
revocation, and lifecycle recovery pass adversarial tests.

### 4.2 Manifest

The manifest is immutable after registry registration and has a stable schema version.
It contains data only. Executable handlers are referenced by pre-registered IDs.

```ts
interface AddonManifestV1 {
  schema: 'mupot.addon/v1'
  key: string
  name: string
  version: string
  publisher: string
  trustClass: 'native_reviewed' | 'external_isolated'
  mupotCompatibility: string
  kind: 'native' | 'external_mcp'
  description: string
  departments: Array<{
    moduleKey: string
    required: boolean
  }>
  agentTemplates: Array<{
    key: string
    name: string
    role: string
    departmentModuleKey: string
    squadSlug: string
    defaultStatus: 'inactive'
  }>
  connectorRequirements: Array<{
    slot: string
    accepts: string[]
    required: boolean
    capability: 'read' | 'write'
    bindingKind: 'vault_connector' | 'internal_adapter' | 'either'
  }>
  authorityRequests: {
    rankGrants: Array<{
      subjectRef: string
      capability: Capability
      scopeType: 'org' | 'department' | 'squad'
      scopeRef: string | null
      reason: string
    }>
    surfaceGrants: Array<{
      subjectRef: string
      capability: string
      reason: string
    }>
  }
  metrics: Array<{
    descriptorKey: string
    ownerDepartment: string
  }>
  playbooks: Array<{
    key: string
    version: string
  }>
  loops: Array<{
    templateKey: string
    defaultState: 'disabled' | 'active'
    approvalRequired: boolean
  }>
  consoleSections: Array<{
    rendererKey: string
    path: string
    title: string
    navIcon: string
  }>
  eventSubscriptions: string[]
  approvalPolicies: Array<{
    action: string
    requiredCapability: Capability
    selfApproval: false
  }>
  healthChecks: string[]
  retention: {
    disablePreservesData: true
    purgeRequiresOwner: true
  }
}
```

Manifest validation rejects unknown fields, duplicate keys, missing registered
references, undeclared metric sources, unsupported capabilities, unsafe routes, write
connectors without approval policies, and external addons that request native handlers.

### 4.3 Registry

`AddonRegistry` follows the established `DepartmentRegistry` pattern:

- registry instances are isolated and testable;
- registration clone-freezes the complete authority-bearing manifest;
- duplicate addon keys fail closed;
- native handler and renderer references must already be registered;
- the production registry exposes no clear, replace, or unregister operation;
- a new addon registers itself without adding a switch statement to the kernel.

The addon registry lists what the deployed release can install. Tenant installation state
lives in D1 and never mutates the static catalog.

At install time Mupot computes a canonical SHA-256 digest of the validated frozen
manifest. The installation and every lifecycle receipt bind to `addon_key`, version,
publisher, trust class, compatibility range, and this digest. Activation rejects manifest
digest drift. An external installation is immutably bound to `external_isolated` and its
approved MCP runtime identity; it cannot promote itself to native trust.

## 5. Tenant Lifecycle

### 5.1 States

```text
available -> installed -> configured -> active
                  |            |          |
                  +---------- disabled <--+
                                 |
                    uninstalled (archived)
```

- **Available:** present in the compiled or configured catalog; no tenant state.
- **Installed:** installation row exists; no agents or schedules run.
- **Configured:** required connector slots are bound and preflight passes.
- **Active:** departments, policies, loops, and console sections are enabled.
- **Disabled:** schedules and dispatch are stopped; data and receipts remain readable.
- **Uninstalled (archived):** the user-facing Uninstall command hides the installation
  from normal operation after disabling it. This is a soft uninstall: historical evidence
  remains. Purge is a separate, owner-only operation and is not part of the initial release.

Every persisted transition uses compare-and-set on the prior state and records actor,
timestamp, and receipt ID. `active` requires configured slots, approved grants, matching
manifest digest, and a completed activation journal. An archived installation cannot be
reactivated; the operator creates a new installation lifecycle with a new installation ID.
Archived receipts and ownership history remain immutable, and no prior grant or active
resource claim carries into the replacement lifecycle.

### 5.2 Install

Installation validates the manifest against the current Mupot release and writes an
`addon_installations` row plus an append-only receipt. It does not seed departments,
start agents, bind connectors, or grant any capability.

### 5.3 Configure

An owner or admin binds each integration slot to an existing pot connector or a registered
internal adapter. Vault bindings store only connector IDs and requested access level. The
connector remains encrypted in the existing vault. Internal adapters, such as first-party
metric collection, carry no secret and are selected by registered adapter key. The addon
receives a narrow resolved adapter only during an authorized operation.

Configuration preflight verifies:

- required connectors are active and compatible;
- required capabilities exist and do not exceed the operator's grant ceiling;
- referenced department modules and renderers are registered;
- required database migrations are present;
- every write action has an approval policy;
- external MCP endpoints use HTTPS and pass the existing SSRF policy.

Requested authority is presented as a separate proposal with scoped rank grants and named
surface grants kept distinct, matching Mupot's existing `capabilities` and `gate_grants`
boundaries. An owner must approve each target scope and named surface through the existing
human gate. Approval writes a grant-specific receipt and addon-owned grant row; activation
itself never silently grants authority. Org-wide authority requires an explicit manifest
declaration and owner approval. Wildcard surface grants are invalid. The activating actor
cannot approve above their own rank ceiling or grant an unregistered surface capability,
and self-approval remains prohibited where proposer and approver identities coincide.

### 5.4 Activate

Activation is idempotent, resumable, and receipt-backed. It:

1. reruns preflight;
2. revalidates the manifest digest, connector bindings, and separately approved grants;
3. activates referenced department modules through `DepartmentRegistry.activate`;
4. seeds addon-owned playbook and loop templates using stable keys;
5. enables console sections and event subscriptions;
6. marks the installation active and writes an activation receipt.

The existing department activations each use their own D1 batch, so addon activation
cannot honestly claim one transaction across the complete composition. The lifecycle
service therefore creates a durable operation journal, records each owned resource after
its successful step, and marks the installation active only after all steps finish. A
failed or interrupted run remains non-active and can resume or compensate from the
journal. External effects use an outbox and reconcile after commit. A retry converges
without duplicate departments, squads, loops, grants, or subscriptions.

Reactivation from disabled repeats connector, grant, health, compatibility, and manifest
digest checks. It never blindly resumes a previously approved authority set.

### 5.5 Disable and archive

Disable first moves the installation out of `active`; every addon dispatch path checks
that state, closing the race for new work. It then stops addon loops, schedules, and
subscriptions, revokes addon-created grants, deactivates addon-owned department instances
when they are not shared by another active addon, and preserves tasks, flights, metrics,
audit records, and receipts. Shared departments use reference counting through
installation ownership rows.

Ownership is one row per `(installation, resource)`, not a mutable scalar refcount. An
exclusive resource may have one active owner; a shared resource may have multiple active
co-owner rows. Disable removes only the current installation's ownership and deactivates
the resource only when no active co-owner remains. This prevents addon-to-addon teardown
and last-writer-wins behavior.

Uninstall/archive is allowed only from disabled. The initial release does not delete
business data.

### 5.6 Upgrade (post-MVP)

The data model reserves version and digest fields, but automated upgrade is deferred until
the native install/activate/disable rail passes adversarial tests. The later upgrade flow
compares the installed version with the immutable registered manifest. It
produces a plan showing new capabilities, connectors, departments, loops, and policies.
Any authority expansion requires fresh owner approval. Upgrades are resumable and write
versioned receipts. Downgrade is unsupported initially; rollback disables the new version
and restores the prior compatible manifest state when possible.

## 6. Persistence

The initial framework adds:

### `addon_installations`

- `id`, `tenant`, `addon_key`, `installed_version`, `publisher`, `trust_class`;
- `manifest_sha256`, `mupot_compatibility`, and `state`;
- `installed_by`, `installed_at`, `configured_at`, `activated_at`, `disabled_at`;
- `updated_at`, `latest_receipt_id`, exact prior-state snapshot, and actor for the latest
  transition;
- `configuration` containing non-secret addon settings;
- `last_health`, `last_health_at`, and `last_error`;
- one non-archived installation per `(tenant, addon_key)`; archived rows are unlimited and
  remain historical evidence;
- immutable installation identity, digest, publisher, compatibility, tenant, and installer
  fields after insert.

### `addon_connector_bindings`

- `installation_id`, `slot`, `binding_kind`, `connector_id`, `adapter_key`, `access_level`;
- unique `(installation_id, slot)`;
- foreign keys to installation and connector rows when `binding_kind=vault_connector`;
- exactly one of `connector_id` or `adapter_key` is populated.

Every binding is resolved through the installation's tenant and slot. Addon code cannot
list or resolve unbound connectors. A revoked connector, type mismatch, scope mismatch,
or insufficient access level makes preflight fail closed. Rotation keeps the connector ID
stable and is reflected by the next health check and lifecycle receipt without exposing
credential material.

### `addon_capability_grants`

- `installation_id`, `grant_kind` (`rank` or `surface`), approved underlying grant ID,
  subject, target scope when rank-scoped, capability, approver, approval receipt ID,
  active flag, and revoked timestamp;
- separate from human/manual and channel-derived grants so disable can revoke only
  addon-owned authority;
- unique active grant per installation, grant kind, subject, target scope, and capability;
- no grant exists until its distinct authority proposal receives a valid human verdict.

### `addon_resource_ownership`

- `installation_id`, `resource_type`, `resource_id`, `resource_key`, `ownership_mode`;
- tracks which addon seeded each department, loop, grant, playbook, or subscription;
- tenant-scoped unique constraints prevent two exclusive owners for one resource;
- `shared` and `co_owner` modes allow declared composition without last-writer-wins;
- prevents disabling one addon from deactivating a resource shared by another;
- claim identity is immutable and undeletable; archive requires every claim to be inactive,
  and archived installations cannot acquire or reactivate claims.

### `addon_operations`

- durable journal for activate, disable, uninstall, and upgrade operations;
- records operation ID, target version/state, current step, status, lease expiry, and
  redacted error code;
- action and target state are constrained as one pair;
- supports crash recovery, bounded retries, compensation, and exactly-one active
  lifecycle operation per installation.

### `addon_receipts`

- append-only lifecycle receipts for install, configure, activate, disable, archive,
  upgrade, health, and failed preflight;
- deterministic database sequence establishes receipt chronology independently of clock
  ties or random IDs;
- includes action, previous/next state, actor, addon/version, publisher/trust class,
  manifest SHA-256, requested authority, grant receipt IDs, affected resource IDs,
  recomputed checks, outcome, and a redacted error or compensation code;
- a state-authorizing receipt must be fresh, successful, actor-matched, and attest the exact
  prior and next states; failed lifecycle receipts remain valid evidence only when they do
  not authorize a state change;
- database triggers prevent update, delete, ID replacement, and sequence replacement;
- never contains connector secrets or bearer values.

Addon manifests cannot contain arbitrary SQL. Native addon schema changes ship through
the normal ordered Mupot migrations. External addons own their storage.

## 7. Capability and Connector Rules

- Only owner/admin can install, bind connectors, activate, disable, or upgrade addons.
- The operator cannot approve a capability above their own grant ceiling.
- Installation grants no authority; every addon grant is a separate human-gated event.
- Connector bindings are explicit per slot; addons cannot resolve arbitrary connector
  records by type.
- Read and write access are distinct. A read binding cannot satisfy a write slot.
- Connector credentials are decrypted only at the existing execution boundary.
- Every customer-facing write is routed through the existing task gate and immutable
  verdict receipt.
- Self-approval remains prohibited.
- External MCP addons receive a tenant-scoped identity and addon-scoped grants.
- External receipts are attributed to the immutable addon/runtime identity, never to the
  host as if the host performed the work.
- Disabling an addon first makes every addon surface inert, then stops owned schedules and
  subscriptions, then revokes only addon-owned grants.

## 8. Console Experience

The console adds an **Addons** section with:

- an available catalog filtered by plan and deployment compatibility;
- installation state, version, requested permissions, and health;
- connector-slot configuration using existing connector records;
- preflight results with actionable missing requirements;
- Activate and Disable commands with confirmation for authority changes;
- lifecycle receipts and addon-owned resources.

The user-facing **Uninstall** command performs the evidence-preserving archive described
above. The console must state explicitly that historical tasks, flights, metrics, audit,
and receipts remain.

Native addon pages use pre-registered renderers. A later external-addon release may provide
deep links or standards-compliant MCP App resources. Arbitrary HTML or scripts are not
injected into the Mupot shell.

## 9. Fixture Addon

Before Marketing, a trivial native fixture addon proves the lifecycle rail with minimal
domain risk. It references one existing fixture department, emits one declared metric,
requires no connector or write capability, and contributes one read-only console section.
Its tests prove install has no side effects, activation is idempotent, interruption is
resumable, disable preserves evidence, and soft uninstall archives the installation.

## 10. Marketing Activity & Outcomes Reference Addon

The first addon proves composition rather than introducing a parallel marketing stack.

### Departments

- `growth`: demand generation, outreach, and pipeline;
- `agency`: SEO/AEO, content, advertising, and CRO;
- `web-ops`: governed website execution and QA.

### Connector slots

- `content_surface`: accepts `inkwell` or `mcpwp`, write, required;
- `web_analytics`: accepts `first_party`, `posthog`, or a future analytics MCP connector,
  read, required;
- `search_performance`: accepts `gsc`, read, optional in the first release;
- `crm`: accepts `ghl`, read/write, optional;
- `ai_visibility`: accepts a future AI-visibility connector, read, optional.

### Default outcomes

- visibility, qualified traffic, leads, conversion, and attributable revenue;
- all unavailable metrics render as unavailable, never fabricated zeroes;
- metric definitions declare source authority and units through existing
  `MetricDescriptor` contracts.

### Default program

`website-opportunity-review` is installed disabled. When activated, it:

1. reads approved analytics and content signals;
2. identifies one bounded opportunity;
3. creates a task and governed flight;
4. proposes one measurable change;
5. waits for human approval;
6. executes through the selected content-surface adapter;
7. verifies the artifact and stores the receipt;
8. remeasures the declared KPI and records the result.

### Mumega activation

Mumega is tenant zero and uses:

- Inkwell for `content_surface`;
- existing first-party/PostHog signals for `web_analytics`;
- GSC when available for `search_performance`;
- existing owner approval and receipt paths.

The first proof is complete when one real Mumega.com opportunity moves from live signal
to approved change, verified artifact, and measured result.

### DME activation

DME uses the same addon manifest and lifecycle with separate connector bindings:

- MCPWP for `content_surface`;
- DME-owned analytics and Search Console;
- DME's GHL location when outreach is enabled;
- DME-specific KPI definitions, approval owners, and branding.

No Mumega credential, metric, task, flight, or receipt is copied into the DME pot.

## 11. Accounting Portability Test

The addon framework is not complete until an Accounting manifest can be described without
changing addon-kernel types. Its likely composition is:

- Bookkeeping, Accounts Payable, Accounts Receivable, and Controller departments;
- QuickBooks or Xero read connectors, with separately gated write slots;
- cash balance, reconciliation status, overdue invoices, and receivables aging metrics;
- payment, invoice, and journal-entry writes requiring approval;
- month-end close and exception-review playbooks.

Accounting is a contract test and subsequent addon, not part of the first implementation.

## 12. Addon Authoring

Official native addons live under a dedicated addon package boundary and export one
manifest plus registrations for any referenced, pre-reviewed modules, renderers, loop
templates, playbooks, and health checks. A validator command performs schema validation,
reference resolution, authority-diff generation, and contract tests without activating
the addon.

The initial authoring flow is:

1. scaffold an addon package from the manifest schema;
2. declare capabilities, connector slots, departments, metrics, policies, and surfaces;
3. run manifest validation and security contract tests;
4. submit native code through the normal repository review and release path.

In the later external-addon release, external manifests must have registry provenance or
an operator-approved signature and an immutable runtime identity.
Unsigned manifests may be inspected locally but cannot be activated. A public marketplace
and automated commercial settlement are later products; they are not required to let
operators build and activate private addons.

## 13. Error Handling

- Validation failures return stable machine-readable reason codes.
- Missing connectors or capabilities leave an addon installed but not configured.
- Failed activation leaves the prior lifecycle state unchanged and writes a failed
  preflight or activation receipt.
- External side effects use an outbox and bounded retries.
- Health degradation never silently disables gates or widens authority.
- A disabled or unhealthy addon cannot create new flights or execute writes.
- Connector failures appear as unavailable data or failed execution, not fabricated
  metrics or successful receipts.

## 14. Test Strategy

### Contract tests

- manifest schema, unknown-field rejection, duplicate keys, and deep immutability;
- native/external reference validation;
- write-slot approval-policy enforcement;
- capability allowlist and grant-ceiling enforcement.

### Lifecycle tests

- install, configure, activate, disable, re-activate, and archive;
- idempotent retries at every state transition;
- resumable operation-journal behavior and per-step atomic receipts;
- interrupted activation never becomes active and can resume without duplicate seeds;
- shared-resource reference counting;
- disable preserves evidence and prevents new work.
- archived installations cannot reactivate without a new install lifecycle.

### Security tests

- tenant isolation on every addon table;
- no raw secret in API responses, receipts, audit, or logs;
- connector slot cannot resolve an unbound connector;
- connector slot rejects revoked, wrong-type, wrong-tenant, and wrong-scope connectors;
- read binding cannot execute write actions;
- self-approval and authority-escalation rejection.
- activation rejects manifest digest drift;
- disable revokes only addon-owned grants;
- exclusive-resource ownership conflicts fail closed while declared co-ownership survives.

### Reference-addon tests

- the fixture addon proves the native lifecycle before Marketing is registered;
- Marketing installs using existing Growth, Agency, and Web Operations modules;
- Mumega configuration accepts Inkwell and refuses an incompatible connector;
- the default program remains disabled until explicitly activated;
- one fixture signal creates one deduplicated proposal and gated flight;
- approved execution records an artifact, verification, and outcome measurement;
- unavailable analytics remains visibly unavailable.

### Browser tests

- catalog and installation states at desktop and mobile sizes;
- permission review, connector binding, preflight, activation, and disable flows;
- no overlapping controls or hidden error states;
- lifecycle receipts and unavailable metrics remain legible.

## 15. Delivery Slices

1. **Addon contract and registry:** manifest schema, frozen catalog, authoring validator,
   authority diff, reference validation, and unit tests.
2. **Persistence and lifecycle:** migrations, installation service, operation journal,
   receipts, ownership, and compare-and-set state transitions.
3. **Fixture addon:** prove install/activate/disable/archive with no connector or write
   authority.
4. **Capabilities and connector slots:** explicit binding, human-gated scoped grants,
   preflight, grant ceilings, and disable-time revocation.
5. **Console:** catalog, install/configure/activate/disable, health, and receipts.
6. **Marketing reference addon:** compose existing departments and connectors, add the
   disabled opportunity-review program, and activate on Mumega.
7. **Live proof:** execute one real Mumega.com outcome flight and preserve evidence.
8. **DME activation:** create a separate DME pot or approved tenant deployment, bind DME
   connectors, and activate the unchanged addon.
9. **External MCP addons and upgrades:** design follow-on implementation only after native
   lifecycle and revocation pass adversarial gates.

Each slice lands behind tests and produces a receipt. No duration-based soak is required;
release readiness is evidence-based.

## 16. Non-Goals for the First Release

- executing uploaded third-party JavaScript inside the Mupot Worker;
- activating external MCP addons before the native lifecycle is proven;
- automated addon upgrade or downgrade;
- a public paid addon marketplace;
- automatic installation of arbitrary database migrations from manifests;
- deleting business evidence during uninstall;
- runtime route injection or unreviewed iframe content;
- cross-pot data sharing;
- building the Accounting addon before the Marketing reference addon is proven;
- replacing departments, connectors, MCP, tasks, flights, gates, or receipts.

## 17. Acceptance Criteria

- A native addon can register without an addon-key switch in the kernel.
- An owner can install, configure, activate, disable, and re-activate it.
- An operator can scaffold and validate a private addon without editing addon-kernel code.
- Activation is idempotent and produces a redacted receipt.
- Activation is bound to the installed manifest digest and separately approved grants.
- Interrupted activation remains non-active and resumes without duplicate resources.
- Connector access is slot-bound and cannot exceed approved capabilities.
- Disabling stops new work and preserves all historical evidence.
- Uninstall is a soft archive and clearly preserves historical evidence.
- A fixture addon proves the lifecycle before the Marketing composition is activated.
- Marketing composes the existing three department modules rather than duplicating them.
- One real Mumega.com opportunity completes the measured, gated execution loop.
- The unchanged contract can express the proposed Accounting addon.
