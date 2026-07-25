# Google Agent Cell as a Mupot Microkernel Addon

- **Status:** Approved direction; design only
- **Date:** 2026-07-25
- **First operator:** DME
- **First service:** DME GEO
- **First sample customer:** Viamar
- **Related work:** issue #574 and draft PR #575 remain a branch-only
  customer-cell proof

**Builds on:**

- [Mupot Addon Microkernel Design](./2026-07-17-mupot-addon-microkernel-design.md)
- [BYOA Harness Support Matrix](./2026-07-23-byoa-harness-support-matrix-design.md)
- [DME Cross-Pot Agent Collaboration](./2026-07-18-dme-cross-pot-collaboration-design.md)
- [Runtime Adapter Contract](../../runtime-adapter-contract.md)

## 1. Decision

The first Google Cloud product for Mupot is a composable customer execution cell,
not a Google-specific branch of the Mupot core.

It is delivered as three separately versioned parts:

1. **Hermes runtime distribution** — carries an agent and connects model or tool
   gateways.
2. **Google GKE cell adapter** — installs and operates an isolated execution cell
   on Google Kubernetes Engine through provider-neutral Mupot ports.
3. **DME GEO addon** — owns the repeatable SEO/GEO business playbook and its
   schemas, policies, reports, and evidence rules.

The operator may experience the GKE cell as a “Google infrastructure addon” in the
Mupot catalog. Inside the kernel it remains a runtime adapter package, not a native
business addon and not core code.

Mupot continues to own organization, identity, projects, grants, gates, tasks,
flights, messages, and receipts. Google runs an optional execution and data plane.
Hermes remains replaceable. DME GEO remains portable to another compatible runtime
adapter.

## 2. Product Outcome

Mupot becomes the governed operating system for repeatable business capabilities:

- business specialists encode a useful method as a versioned playbook;
- developers implement deterministic executors or adapters;
- agents handle interpretation, research, and exceptions;
- people retain explicit gates for sensitive or expensive actions;
- owners install the capability into an isolated customer environment;
- consultants configure, supervise, and improve it; and
- Mupot preserves authority, progress, evidence, and revocation across the whole
  workflow.

The first proof is deliberately narrow. DME is the service provider; Viamar is
one customer of that service:

```text
DME service pot                         Viamar sovereign Mupot pot
----------------                        ---------------------------
DME GEO service definition  <--------> own Cloudflare Worker
delivery coordination          signed  own D1 / KV / R2
sanitized service status        link    own domain and identities
                                            |
                                            | governed runtime binding
                                            v
                                   Viamar-bound execution cell
                                            |
                                            +--> Hermes runtime
                                            +--> bounded GEO playbook
                                            +--> grounded Google query
                                            +--> Viamar PostHog detail
                                            `--> Viamar Mupot receipt
```

The Viamar pot remains the customer system of record and security boundary. It
is never a project, tenant row, or namespace inside the DME pot. Its first
deployment may be operated in a Mumega-managed Cloudflare account, but it uses
separate Worker, D1, KV, R2, domain, identities, and credentials so it can move
to Viamar's own Cloudflare account.

A Kubernetes namespace or pod is defense in depth, not a substitute for pot
isolation or project authorization.

## 3. Existing Boundaries Remain Authoritative

This design extends existing seams instead of replacing them.

### 3.1 Mupot addon packages

`mupot.addon-package/v1` remains the package wrapper for business addons. The
nested `mupot.addon/v1` lifecycle manifest remains authoritative for install,
configure, activate, disable, and archive.

Native packages remain declarative and reviewed. Mupot does not load third-party
JavaScript into the Worker.

### 3.2 External isolated addons

The existing `external_mcp` kind is the trust boundary for external executors.
The current service intentionally installs only `native` plus `native_reviewed`
manifests, so external activation is a real product gap. Closing that gap must be
provider-neutral and must not special-case Google.

### 3.3 Runtime adapters

`runtime-adapter/v1` remains the attachment contract for Hermes, Codex, Cursor,
and other runtimes. A runtime carries an agent; it does not create or assert the
agent's Mupot identity, tenant, project access, or capabilities.

Runtime profiles and business addon packages remain separate concepts. Installing
DME GEO does not install Hermes credentials, and installing a GKE cell does not
grant authority to run DME GEO.

### 3.4 Sovereign pots and project links

Each customer pot remains authoritative for its customer operations and data.
Cross-pot coordination uses signed, bounded project-link envelopes. It never
copies bearer tokens, private prompts, raw analytics, customer records, or model
memory between pots.

## 4. Approaches Considered

### 4.1 Put Google support in the Mupot core

Rejected. Google SDKs, GKE resource types, Vertex model names, and Marketplace
logic in the kernel would couple authority and workflow state to one cloud. Every
future Azure, AWS, on-premises, or Torivers integration would require another core
branch.

### 4.2 Ship one monolithic Google plus DME addon

Rejected. A single package would mix infrastructure lifecycle, agent runtime,
provider credentials, and DME business logic. DME could not move the playbook to
another runtime, and another business could not reuse the GKE cell without
installing DME concepts.

### 4.3 Compose a runtime, infrastructure adapter, and business addon

Selected. Each part has one reason to change:

| Part | Owns | Does not own |
| --- | --- | --- |
| Hermes runtime | model/tool gateway use, agent process, bounded execution | Mupot identity, grants, customer business schema |
| GKE cell adapter | Kubernetes resources, workload identity, isolation, health, metering | DME playbook logic, Mupot authorization |
| DME GEO addon | GEO workflow, source/result schemas, gates, reporting policy | cloud provisioning, agent credentials |
| Mupot core | identity, tenancy, projects, capabilities, tasks, gates, receipts | Google SDKs, provider secrets, customer algorithms |

## 5. Package Model

### 5.1 Hermes runtime distribution

Hermes is distributed as a runtime image and profile compatible with
`runtime-adapter/v1`. It may support multiple model and tool gateways internally.
That gateway compatibility is a Hermes concern.

The distribution:

- contains no Mupot, Google, PostHog, or model credential;
- uses an immutable image digest;
- runs as a non-root workload with a read-only root filesystem where practical;
- attaches through signed runtime identity when configured;
- emits redacted health and execution state; and
- passes the runtime conformance suite independently of DME GEO.

### 5.2 Google GKE cell adapter

The GKE cell is an operator-facing infrastructure addon and a kernel-level runtime
adapter package. Its package descriptor is separate from
`mupot.addon-package/v1`:

```ts
interface RuntimeAdapterPackageV1 {
  schema: 'mupot.runtime-adapter-package/v1'
  key: string
  version: string
  publisher: string
  runtimeContract: 'runtime-adapter/v1'
  controlContract: 'mupot.external-runtime-control/v1'
  trustClass: 'external_isolated'
  artifact: {
    imageDigest: `sha256:${string}`
    distributionDigest: `sha256:${string}`
  }
  capabilities: Array<
    | 'workflow.invoke'
    | 'workflow.status'
    | 'workflow.cancel'
    | 'health.read'
    | 'usage.report'
  >
}
```

The exact descriptor is additive. It does not alter the canonical digest rules of
`mupot.addon-package/v1` or `mupot.addon/v1`.

The adapter installs:

- a customer-specific Kubernetes namespace;
- a dedicated Kubernetes ServiceAccount;
- a Workload Identity binding configured by the customer/operator;
- Hermes and the bounded playbook runner;
- an external MCP/control endpoint;
- readiness and liveness probes;
- NetworkPolicy and restrictive container security contexts;
- resource requests, limits, and a concurrency ceiling;
- a local idempotency and budget ledger;
- redacted receipt, health, and usage emitters; and
- optional Google Marketplace metering only after the private proof.

The adapter never receives authority merely because its Kubernetes resources
exist. It begins inert and cannot invoke a workflow until Mupot binds a runtime
identity, project, capability set, and active package version.

### 5.3 DME GEO business addon

DME GEO remains a normal Mupot business addon. A package-level execution
requirement is added without changing the nested lifecycle manifest:

```ts
interface AddonPackageManifestV2 {
  schema: 'mupot.addon-package/v2'
  mupotPortVersion: string
  addon: AddonManifestV1
  runtimeRequirements: Array<{
    slot: string
    contract: 'mupot.external-runtime-control/v1'
    required: boolean
    capabilities: Array<
      'workflow.invoke' | 'workflow.status' | 'workflow.cancel'
    >
  }>
}
```

Version 2 is additive: existing version 1 packages continue to load unchanged.
The DME GEO package declares an `executor` slot. An operator binds that slot to a
compatible cell only while both the addon installation and runtime binding are
active.

## 6. Provider-Neutral Sealed Ports

The Mupot kernel exposes a small external runtime control contract. Google,
Kubernetes, Vertex, Azure, and Torivers names are forbidden in this contract.

### 6.1 Bind

`runtime.bind` associates an already registered runtime instance with one pot,
project, addon installation, package digest, and least-privilege grant set.

Mupot derives tenant and actor from authentication. The caller cannot supply a
tenant. The project, installation, runtime, and grants are reauthorized in the
same mutation that creates the binding.

### 6.2 Invoke

```ts
interface WorkflowInvokeV1 {
  schema: 'mupot.workflow-invoke/v1'
  requestId: string
  idempotencyKey: string
  projectId: string
  installationId: string
  runtimeBindingId: string
  playbook: { key: string; version: string; digest: string }
  inputRef: { mediaType: string; digest: string; authorizedUrl?: string }
  deadline: string
  budget: { unit: string; ceiling: number }
}
```

The request contains a reference and digest, not arbitrary customer data. The
external cell resolves permitted sources locally. Mupot signs the canonical
request and the cell verifies the binding, package digest, deadline, nonce, and
current revocation state before starting work.

### 6.3 Status and cancel

`workflow.status` returns bounded phase, progress, timestamps, stable reason
codes, and receipt references. It cannot return private model reasoning, raw
source data, secrets, or unbounded logs.

`workflow.cancel` is idempotent. Cancellation prevents new external steps and
requests cooperative termination of the current step. The final receipt states
whether termination was confirmed, still draining, or could not interrupt an
already committed external call.

### 6.4 Evidence and usage

The cell appends a signed result receipt through `evidence.append` and reports
bounded usage through `usage.report`.

Every receipt binds:

- tenant and project as resolved by Mupot;
- runtime binding and agent identity;
- addon installation and playbook version/digest;
- request and idempotency keys;
- input and output digests;
- start/end timestamps and terminal state;
- budget claimed and bounded usage observed;
- gate receipts used; and
- a stable redacted reason code on failure.

Usage is evidence, not an invoice. Provider billing reconciliation remains a
separate governed workflow.

### 6.5 Disable and revoke

Disabling an addon, revoking a runtime binding, removing project access, retiring
an identity, or changing the bound package digest blocks all new invocation and
delivery. The cell must re-check a short-lived authorization lease at step
boundaries. Historical receipts remain readable according to pot policy.

## 7. External Activation

External activation is a generic kernel feature, not a GKE feature.

The lifecycle is:

```text
catalog record
  -> inert install
  -> external endpoint registration
  -> signature and conformance challenge
  -> project/runtime binding
  -> explicit capability grant
  -> activate
  -> invoke/status/cancel
  -> disable or archive
```

Mupot stores endpoint identity, public verification material, contract version,
package digest, state, and receipts. It does not store provider credentials and
does not execute downloaded addon code.

Activation fails closed when:

- the endpoint cannot prove possession of its registered key;
- the runtime or control contract is unsupported;
- the package or image digest differs;
- tenant, project, installation, or identity binding is absent;
- required grants or human gates are absent;
- health or conformance evidence is stale; or
- the addon or runtime is disabled, archived, or revoked.

## 8. Dual Distribution Artifacts

The GKE product has two artifacts that describe different authorities:

1. **Mupot runtime adapter package** — describes compatibility, trust class,
   external capabilities, lifecycle, and immutable artifact digests.
2. **Google Marketplace Kubernetes application** — describes customer-cluster
   resources, images, configuration, upgrade, and uninstall.

They are paired by:

- package key and semantic version;
- immutable distribution and image digests;
- runtime contract version;
- a one-time pairing request generated in Mupot; and
- a signed pairing receipt returned after the live cell proves its package and
  key.

The one-time pairing value is not a durable bearer credential. It expires, is
single-use, is hashed at rest, and exchanges only for a bound runtime identity
challenge. It must not appear in Marketplace parameters, Kubernetes annotations,
logs, shell history, or support tickets.

## 9. DME Service and Customer-Pot Topology

### 9.1 Service and customer are separate products

DME GEO is a service installed and operated from the DME side. Viamar is the
first sample customer consuming that service. The service must not encode Viamar
as a privileged tenant or special kernel path.

Version one preserves both provider operations and customer sovereignty:

- the DME pot owns DME sales, reusable GEO playbooks, delivery coordination,
  consultant operations, and sanitized service-level status;
- the Viamar pot owns Viamar projects, customer membership, runtime identity,
  detailed customer evidence, receipts, and retention;
- the DME and Viamar pots have separate Cloudflare deployments and storage;
- a signed project-link exposes only the minimum state needed to deliver the DME
  service;
- DME receives no Viamar bearer token, raw analytics, source credentials,
  private model memory, or unrestricted customer evidence; and
- removing the link stops DME service coordination without disabling or deleting
  the Viamar pot.

Several external customers must not be modeled as projects inside one DME pot.
Every external customer receives a sovereign pot even if DME initially operates
its infrastructure. A customer namespace or project inside DME infrastructure is
only an execution-isolation mechanism; it is not the customer's Mupot tenancy.

### 9.2 Cloudflare portability

The initial `mupot-viamar` deployment may live in a Mumega-managed Cloudflare
account, but it must be portable by construction:

- its Worker, D1, KV, R2, queues, secrets, domain, and deployment configuration
  are not shared with DME;
- its tenant slug and durable public identifiers remain stable through a move;
- its deployment descriptor names only Viamar resources and contains no secret
  values;
- its data export is integrity-checked before import into the destination
  account;
- its runtime and project-link endpoints are re-paired after the destination is
  verified;
- new writes are quiesced during the final cutover so no receipt is silently
  lost;
- old identities and endpoints are revoked only after a watched destination
  proof; and
- the old deployment is retained inert for a bounded recovery window before any
  separately authorized purge.

Moving `mupot-viamar` to Viamar's own Cloudflare account is therefore a sovereign
pot migration, not an extraction from a DME database. The DME GEO addon and its
service contract do not change.

### 9.3 Execution custody is a separate choice

The Viamar-bound execution cell may initially run in a DME-operated GKE cluster
under an explicit data-processing agreement. In that topology DME's
`cluster-admin` is a trusted infrastructure operator; Kubernetes namespace RBAC
cannot make Viamar secrets inaccessible to a cluster super-user.

Use Workload Identity and an external secret store to avoid static Google keys
and reduce secret material stored in Kubernetes. If Viamar requires DME to be
technically unable to access its runtime secrets, the execution cell must run in
a Viamar-owned Google project and cluster, or behind a separately proven
confidential-computing boundary. A namespace in a DME-administered cluster is not
such a boundary.

In either topology:

- the cell uses only a Viamar-pot Mupot identity and Viamar-specific source/sink
  credentials;
- the runtime binds to the Viamar pot and project, never to the DME pot;
- DME sees only the signed project-link projection; and
- the cell can move to Viamar-owned Google infrastructure without changing the
  DME GEO playbook or Viamar Mupot history.

## 10. Data and Privacy Boundary

The cell follows a resolve-transform-release pipeline:

```text
source reference
  -> local authorized read
  -> classification
  -> minimization/deidentification
  -> deterministic or agent step
  -> schema validation
  -> local detailed result
  -> redacted Mupot receipt
```

Each input and output field is classified as one of:

- `public`
- `customer_internal`
- `personal`
- `credential`
- `derived_safe`

Only fields explicitly allowed by the selected executor schema may cross its
boundary. Credentials never cross. Personal and customer-internal fields require
a playbook-specific transform and negative tests. If the transform cannot prove
that an output satisfies the release schema, the step fails closed.

Torivers or another privacy-preserving deterministic executor can implement the
same executor contract. It receives only the minimized payload, performs its
algorithm, and returns a schema-bound result. Google Workspace workflows, n8n,
or future adapters can do the same.

Mupot receipts never contain raw customer data, access tokens, API keys, private
prompts, full transcripts, model chain-of-thought, analytics exports, or provider
error bodies.

## 11. Identity and Secrets

Production Google access uses Workload Identity or the current Google agent
identity mechanism supported by the runtime. API keys are allowed only for local
development fixtures that do not touch customer data.

Model-provider credentials belong to the customer or cell operator:

- the operator signs in or provisions the credential directly inside the
  customer-controlled environment;
- the secret is stored in the customer secret manager or a dedicated encrypted
  volume;
- Mupot never receives, copies, displays, logs, backs up, or brokers the raw
  credential;
- the runtime receives it only at execution time; and
- revocation can stop the runtime without deleting Mupot history.

For a Codex subscription-backed runtime, device authentication is an explicit
operator action inside the cell. Its cached authentication material is treated
as a password. Mupot is not a ChatGPT credential custodian.

The Kubernetes control plane, probe containers, support tooling, and receipt
emitters must not receive model, PostHog, source-system, or Mupot bearer
credentials unless their exact function requires one. Prefer signed Mupot runtime
paths so the long-running cell does not store a general bearer token.

## 12. Playbook Contract

A playbook is a versioned directed acyclic graph of typed steps:

```ts
type PlaybookStepV1 =
  | { kind: 'deterministic'; executor: string; input: string; output: string }
  | { kind: 'agent'; profile: string; input: string; output: string }
  | { kind: 'human_gate'; policy: string }
  | { kind: 'evidence'; schema: string }
```

Every step declares:

- input and output schema digests;
- required connector and runtime capabilities;
- data classifications admitted and released;
- timeout, retry, and idempotency policy;
- budget unit and ceiling;
- side-effect class;
- compensation or recovery behavior; and
- the human gate required before sensitive or externally visible effects.

Retries are permitted only when the executor contract proves the operation is
idempotent. An ambiguous billable or externally visible action consumes its
claim and requires reconciliation instead of blind replay.

The first bundled playbook is `dme.geo-baseline/v1`:

```text
validate public profile
  -> claim daily query budget
  -> run bounded grounded queries
  -> normalize and classify evidence
  -> write detailed Viamar PostHog events
  -> append redacted Viamar Mupot receipt
  -> expose sanitized DME project-link status
```

Draft PR #575 is evidence for this vertical slice, not evidence that the generic
external activation and adapter package contracts already exist.

The first implementation hard-codes only the sealed
`dme.geo-baseline/v1` sequence behind the generic invoke contract. It does not
build a general DAG authoring or scheduling engine. General DAG execution becomes
eligible only after the external invoke, status, cancel, evidence, idempotency,
and revocation paths pass conformance.

## 13. Lifecycle

### Install

Installation creates inert records and renders resources at zero active
execution capacity. It does not mint an identity, grant project access, read
customer data, or incur model spend.

### Configure and bind

The owner selects the sovereign pot/project, runtime adapter, source/sink
bindings, public playbook configuration, budgets, and human gate policy. Secrets
are configured at their owning provider, not pasted into Mupot.

### Activate

Activation requires current package and image digests, external conformance,
healthy runtime evidence, live project authorization, explicit grants, and
required human approval. The first customer run remains a watched one-shot job.

### Disable

Disable rejects new invocations, revokes scheduling and authorization leases, and
requests cancellation of active work. It does not destroy evidence or customer
data.

### Archive

Archive makes the installation permanently inactive while retaining receipts and
history under pot retention policy.

### Uninstall

Uninstall removes adapter-owned compute resources only after the cell is inert.
It preserves customer databases, object stores, PostHog projects, secret-manager
entries, and Mupot receipts unless the owner authorizes a separate, explicit,
recoverable purge.

## 14. Failure and Revocation Rules

- Unknown, expired, replayed, or incorrectly signed requests fail closed.
- Tenant and project are derived from authenticated Mupot state.
- The cell reauthorizes before every side effect and at each long-running step
  boundary.
- Duplicate invocation returns the original receipt or current state without
  repeating the effect.
- A stale cell cannot appear healthy; status shows the last verified timestamp.
- A provider outage preserves a bounded pending or failed state and never
  fabricates completion.
- Receipt failure after an external effect triggers reconciliation of that effect,
  not repetition.
- Budget exhaustion is a terminal governed outcome until an authorized new
  budget window.
- Revocation stops future work while preserving prior signed evidence.
- Moving a cell requires drain, export of non-secret state, old identity
  revocation, new identity pairing, and a watched proof in the destination.

## 15. Customer and Operator Surface

The Mupot customer project page shows:

- installed business capabilities and bound runtime adapter;
- current cell health and last verified time;
- active, queued, blocked, and completed playbook runs;
- human gates awaiting a decision;
- budget ceiling, claimed usage, and reconciliation status;
- redacted activity and evidence receipts; and
- explicit disabled, stale, revoked, or unknown states.

Detailed customer evidence stays in the customer-owned system until a
project-scoped read binding and authorization model exists. The dashboard does
not turn an internal DME squad grant into customer access.

The DME operator view is a service-provider projection, not a view into the
Viamar pot. It receives only project-link fields approved for cross-pot
coordination: state, blocker summary, bounded counts, evidence digest, authorized
URL, timestamps, and staleness.

## 16. Commercial and Marketplace Path

The initial delivery is private and bring-your-own-license:

- the customer pays Google Cloud and model-provider charges;
- Mumega charges for Mupot, onboarding, implementation, playbook
  customization, support, and managed operations;
- DME charges for interpreted SEO/GEO service and customer outcomes; and
- the private install proves packaging and support before a public Marketplace
  listing.

Mupot should not depend on reselling model tokens. A future usage metric should
represent governed product value, such as an active isolated customer cell or a
completed governed workflow, and must be reconciled against signed Mupot
receipts.

After the private DME/Viamar proof:

1. validate Google Marketplace install, upgrade, and uninstall;
2. add immutable image provenance and vulnerability gates;
3. add Marketplace metering without giving it workflow authority;
4. complete customer-facing documentation and support boundaries; and
5. pursue public listing only after revocation, isolation, billing, and recovery
   evidence is current.

## 17. Verification and Gates

### Contract tests

- version 1 addon packages continue to load unchanged;
- version 2 runtime requirements reject unknown fields, duplicate slots,
  unsupported contracts, and excess capabilities;
- runtime adapter package descriptors have canonical digests;
- no provider-specific identifier appears in the sealed core contract;
- an external endpoint cannot self-assert tenant, project, identity, or grants;
- signatures, nonce, deadline, and idempotency behavior pass conformance;
- status, evidence, and usage payloads remain bounded and redacted.

### Security tests

- wrong pot, project, agent, installation, runtime, or package digest is denied;
- the DME service identity cannot read Viamar pot storage or invoke an unlinked
  Viamar project;
- revoked or retired identities cannot invoke with cached credentials;
- disabling either addon or adapter blocks new work immediately;
- stale authorization leases fail at the next step boundary;
- duplicate and concurrent invocation cannot repeat an external side effect;
- raw credentials and prohibited data classes are rejected from requests,
  receipts, logs, and support bundles;
- cross-pot envelopes deny unknown fields and customer data;
- network policy denies unapproved egress;
- namespace and ServiceAccount boundaries are customer-specific; and
- uninstall cannot delete customer-owned data by default.

When the cell runs in a DME-administered cluster, tests prove least privilege for
ordinary DME service identities and workloads; they do not falsely claim
isolation from `cluster-admin`. A deployment that requires exclusion of DME
administrators must use the Viamar-owned infrastructure topology.

### Distribution tests

- clean install starts inert;
- configuration contains no secret value;
- images are pinned by digest and run non-root;
- pairing is single-use and bound to the exact package;
- upgrade preserves bindings only when compatibility and digest checks pass;
- rollback returns the old cell to its exact prior inert/active state;
- uninstall removes owned compute while preserving customer state; and
- the same business addon passes against a non-Google conformance fixture.

### First live proof

A live Viamar proof is separately authorized and watched. It requires:

- the Viamar sovereign pot and real project binding;
- dedicated Viamar identities and credentials;
- a dedicated least-privilege Viamar Google workload principal rather than a
  reusable Mumega agent principal;
- approved public prompt/profile configuration;
- an immutable image digest;
- exact Google, PostHog, and Mupot destinations;
- a low one-run budget ceiling;
- current redaction and secret-scan evidence; and
- independent review of the exact release head.

Green local tests or draft PR evidence do not authorize deployment, credentials,
customer-data access, spend, or publication.

## 18. Rollout

1. **Generic external rail:** implement external endpoint registration,
   challenge, lifecycle, invoke/status/cancel, evidence, usage, and revocation
   against a local fixture.
2. **Package compatibility:** add the runtime adapter package descriptor and
   additive addon package version 2 without changing version 1 behavior.
3. **Hermes conformance:** prove the credential-free Hermes distribution against
   `runtime-adapter/v1`.
4. **GKE adapter offline proof:** render an inert cell and verify isolation,
   package pairing, upgrade, rollback, uninstall, and secret absence locally.
5. **DME/Viamar staging:** bind the suspended Viamar customer cell and DME GEO
   playbook across the signed project-link without a live external query. Prove
   that DME and Viamar use separate Mupot deployments and storage.
6. **Watched Viamar baseline:** after explicit authorization, run the bounded GEO
   proof and retain redacted receipts in the Viamar pot.
7. **Private Google offering:** package the same cell for a DME-controlled private
   Marketplace install.
8. **Repeatability:** onboard a second sovereign fixture pot without adding core
   provider code.
9. **Cloudflare portability:** rehearse moving a sovereign fixture customer pot
   between Cloudflare accounts without changing its DME service contract.
10. **Public marketplace:** pursue only after support, billing, isolation,
   revocation, upgrade, and recovery gates pass.
11. **Second provider:** implement an Azure AKS cell against the same sealed ports
    without changing DME GEO.

## 19. Acceptance Criteria

- The Mupot core imports no Google SDK and contains no Google-specific lifecycle
  branch.
- Hermes, the GKE cell, and DME GEO are independently versioned and replaceable.
- Runtime identity and business addon authority remain separate and require an
  explicit project binding.
- External isolated addons can complete a generic inert-to-active lifecycle
  without loading their code into the Worker.
- DME GEO operates as a reusable service; Viamar is a normal sample customer with
  no customer-specific kernel path.
- `mupot-viamar` uses a separate Cloudflare deployment and separate D1, KV, R2,
  identities, and credentials from DME.
- The Viamar cell is bound only to the Viamar sovereign pot, project, identity,
  and credentials; DME receives only sanitized project-link state.
- A rehearsed fixture move proves that a customer pot can migrate to the
  customer's Cloudflare account without changing the DME service contract.
- Customer data is minimized inside the cell before any external executor and
  detailed evidence remains customer-owned.
- Every invocation is bounded by digest, idempotency, deadline, budget, current
  authorization, and a signed terminal receipt.
- Disable, revoke, archive, uninstall, and migration behavior is independently
  tested.
- The same DME GEO package can bind to a non-Google conformance adapter.
- No live deployment or spend occurs from implementing this design alone.

## 20. Non-Goals

- Porting the Cloudflare Worker, D1, Durable Objects, or the Mupot control plane
  to Google Cloud.
- Adding Google, Vertex, GKE, Marketplace, Azure, or Torivers branches to the
  Mupot kernel.
- Loading third-party JavaScript or Python into the Worker.
- Combining agent runtime profiles with business addon lifecycle manifests.
- Building a general DAG engine before the sealed
  `dme.geo-baseline/v1` invoke path passes conformance.
- Making Mupot a custodian for ChatGPT, model-provider, Google, PostHog, or
  customer-source credentials.
- Treating a pod or namespace as the sole customer authorization boundary.
- Moving any external customer into the DME pot; each customer remains a
  sovereign Mupot deployment.
- Autonomous live spend, customer-data access, deployment, or public
  Marketplace publication.
- Implementing the Azure adapter in the first Google/DME slice.
