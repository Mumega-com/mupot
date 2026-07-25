# Mupot Typed Add-on Boundary Design

**Status:** Approved direction  
**Date:** 2026-07-25  
**Scope:** Product and architecture boundary only; no runtime behavior or release scope changes  
**Builds on:** `2026-07-17-mupot-addon-microkernel-design.md`,
`docs/architecture/mupot-module-kernel.md`

## 1. Decision

Mupot is the durable authority for a governed team of human and AI coworkers.
External products extend that team through typed ports; they do not replace
Mupot's identity, policy, work, or evidence model.

Users see one **Add-ons** catalog. Internally, every installed package declares
one or more narrowly typed adapters. A package may bundle several adapters when
the external product spans several capabilities.

The four terms are:

1. **Add-on package** — the product an operator installs and manages.
2. **Adapter** — an implementation of one typed Mupot port.
3. **Connector** — the sealed credential and endpoint needed by an adapter.
4. **Binding** — the mapping from a Mupot scope to an external resource.

This design does not turn every integration into a task-board provider and does
not merge agent runtime profiles into business add-on manifests.

## 2. Product Boundary

```text
Mupot core — durable authority
├── pot, organization, projects, squads, humans, and agents
├── identity, membership, capabilities, and grant ceilings
├── tasks, gates, flights, approvals, receipts, audit, and evidence
├── agent inbox, wake, presence, memory, and runtime control
└── registries, typed ports, connector vault, and add-on lifecycle
        │
        ├── Linear add-on ── ProjectBoardPort
        ├── Buzz add-on ──── CollaborationPort + surface module
        └── SOS add-on ───── CoordinationBridgePort + presence module
```

An add-on may transport, display, synchronize, or execute work. It may not
become the source of truth for:

- Mupot principal identity or membership;
- capability grants or grant ceilings;
- task, gate, flight, approval, or verdict state;
- audit events, receipts, or evidence;
- project and squad authorization.

If an external system disagrees with Mupot, the Mupot record controls. The
adapter reports the conflict instead of silently resolving it in the external
system's favor.

## 3. Current Capability Inventory

The current repository already contains the following substrate.

### 3.1 Stable in v0.23

- pot, organization, squad, member, and agent identity;
- capability-scoped authorization and approval gates;
- tasks, verdicts, flights, receipts, audit, and GitHub-backed verification;
- signed runtime attach/detach, heartbeat, inbox, and lifecycle control;
- MCP tools for task, flight, memory, messaging, peer discovery, and wake.

### 3.2 Present as v0.24 preview

- Project lifecycle, bounded hierarchy, explicit squad access, and Project
  Situation views;
- Project Activity and Evidence projections;
- Project-attributed tasks, flights, messages, receipts, and verdicts;
- Project Link for bounded, signed cross-pot task/evidence exchange;
- Mac and Kubernetes Agent Host support;
- module presence for `agent_system`, `workflow`, and `surface`;
- add-on install/configure/activate/disable/archive lifecycle with immutable
  manifest identity, binding generations, evidence, and receipts.

These remain preview until the v0.24 release gate passes. This design does not
add Buzz, SOS, or live Linear synchronization to the v0.24 release promise.

### 3.3 Implemented adapters and packages

- Channel adapters: Discord, Google Chat, and Telegram.
- Project-board adapter: GitHub Projects.
- Native packages: Project Link and Marketing & CRO Monitor.
- Other integrations include GitHub, GHL, first-party analytics, PostHog,
  Inkwell, and MCPWP.

### 3.4 Honest gaps

- Linear and Notion implement the `TaskBoardPort` shape but currently return
  `*_adapter_pending_credentials`; live external API synchronization is not
  implemented.
- The manifest schema names `external_mcp`, but the current installer accepts
  only `native_reviewed` packages.
- The connector-binding implementation is currently read-oriented and is not
  a general governed external-write framework.
- `ChannelAdapter` normalizes a text message and membership. It does not model
  native rooms, threads, reactions, typing, or a shared human-agent timeline.
- Fine-grained project/key authority and console consolidation belong to later
  roadmap releases.

## 4. Typed Ports

### 4.1 Existing `ProjectBoardPort`

Purpose: synchronize external issue or task boards into a Mupot Project without
making the external board the owner of Project identity or authorization.

Required behavior:

- list external board items through a project-provider binding;
- preview and import items into one authorized Mupot Project;
- preserve external IDs and links for attribution;
- surface partial failures per item;
- never mutate Mupot authorization from external membership.

Initial mappings:

- GitHub Projects: implemented reference adapter.
- Linear: registered adapter; live API work remains unscheduled by this design.
- Notion: registered adapter; live API work remains unscheduled by this design.

### 4.2 Proposed `CollaborationPort`

Purpose: expose human-agent collaboration spaces while Mupot retains authority
over who may see, post, dispatch, or approve work.

The port must be capability-based rather than vendor-shaped. Its first contract
should cover only:

- spaces and their external identifiers;
- messages with stable external and Mupot correlation IDs;
- optional reply/thread parent identifiers;
- optional reactions as display events;
- member projection and presence hints;
- inbound verification and normalized outbound delivery;
- deep links back to the external surface.

Threads and reactions are optional capabilities. An adapter that lacks them
must report them as unsupported; Mupot must not emulate false support.

Candidate mappings:

- Buzz: rooms, threads, reactions, DMs, and human-agent workspace surface.
- Discord, Google Chat, and Telegram: existing channel adapters migrated or
  wrapped incrementally without breaking their current contract.
- A future Mupot-native local room surface: another adapter, not a privileged
  exception inside the kernel.

### 4.3 Proposed `CoordinationBridgePort`

Purpose: bridge another agent-coordination network during migration or
coexistence without creating two authorities.

The minimum contract covers:

- direct send and bounded squad broadcast;
- inbox peek/consume with explicit delivery identity;
- wake/dispatch requests;
- roster and presence projection;
- request, acknowledgement, and correlation IDs;
- delivery receipts and explicit failure reasons.

Every bridge operation carries both external and Mupot correlation identifiers.
Inbound actors must resolve to a bound Mupot principal before they can steer
work. Unknown or unauthorized actors may produce an observable event, but they
cannot create privileged directives.

Initial mapping:

- SOS: compatibility bridge for current Mumega team coordination. SOS remains
  usable while native Mupot messaging matures, but Mupot does not depend on SOS
  to boot, authorize a user, retain work, or recover state.

### 4.4 Existing module ports remain separate

The module kernel's `agent_system`, `workflow`, and `surface` kinds describe a
running module's presence and execution role. They are not replaced by the
package lifecycle.

Examples:

- a Codex runtime profile is an `agent_system` module;
- a Buzz web client is a `surface` module;
- a Buzz add-on package may install both a collaboration adapter and the
  configuration needed by that surface;
- an SOS daemon may register presence while its package provides the
  coordination bridge binding.

## 5. Multi-adapter Packages

One package may declare several adapter provisions:

```text
Buzz package
├── collaboration: buzz
└── surface: buzz-web

SOS package
├── coordination_bridge: sos
└── presence: sos

Linear package
└── project_board: linear
```

The package is installed once, but every provision is configured and authorized
independently. Activating one provision does not silently activate another.
Disabling the package revokes all live provisions through one fenced lifecycle
operation and preserves evidence according to the existing retention contract.

The exact manifest extension is intentionally not specified here. It requires a
separate implementation design because the approved
`mupot.addon-package/v1` work has not landed on the current main branch and its
digest/migration rules must be preserved.

## 6. Data Flow

### 6.1 Linear

```text
Linear team/project
  → verified Linear connector
  → Linear ProjectBoard adapter
  → authorized project-provider binding
  → preview/import
  → Mupot tasks + external attribution
```

Linear never assigns Mupot capabilities. External assignees resolve only to
already-visible Mupot agents; unresolved assignees remain explicit import
results.

### 6.2 Buzz

```text
Buzz room/message
  → verified Buzz identity/signature
  → Collaboration adapter
  → Mupot project/squad authorization
  → durable message or governed work request
  → task/gate/receipt when work is created
  → correlated reply back to Buzz
```

Chat remains conversation. A message becomes work only through an explicit,
authorized conversion or directive path.

### 6.3 SOS

```text
SOS delivery
  → Coordination Bridge adapter
  → bound Mupot agent identity
  → native send/inbox/wake/presence operation
  → Mupot receipt/correlation
  → SOS acknowledgement
```

The bridge must make duplicate, partial, delayed, and rejected delivery visible.
An SOS receipt proves transport delivery; it does not prove Mupot authorization
or task completion.

## 7. Trust and Failure Rules

1. The Mupot kernel evaluates authorization before any adapter invocation that
   can read scoped data or cause an external action.
2. Connectors remain sealed host resources. Packages receive a typed host
   capability, never raw credentials.
3. External/community code runs outside the Worker and connects through a
   versioned, authenticated boundary.
4. Every write-capable provision starts disabled and requires an explicit
   authorized activation.
5. Adapter unavailability marks that provision degraded or offline; it does not
   corrupt kernel state or make the pot unavailable.
6. Retries require idempotency and correlation identifiers. Unknown delivery
   state is reported as unknown, never success.
7. External deletion does not erase Mupot evidence.
8. Package disable/archive follows the existing receipt and retention rules.
9. No adapter may self-approve an action it proposed.

## 8. Product Presentation

The operator sees one Add-ons catalog with capability badges:

- **Project board**
- **Collaboration**
- **Coordination bridge**
- **Runtime**
- **Workflow**
- **Surface**
- **Business capability**

Each add-on page must show:

- provided capabilities;
- requested scopes and permissions;
- required connectors;
- current bindings;
- activation and health state;
- latest evidence and receipts;
- unsupported optional capabilities.

The product copy must not call a registered stub “connected” or “synchronized.”
Linear and Notion remain “adapter available; live connection not implemented”
until real external evidence exists.

## 9. Release and Commercial Boundary

This design does not move work into v0.24. The canonical roadmap assigns the
minimum first-party Mupot Squad Room, `CollaborationPort`, and SOS-backed
`CoordinationBridgePort` compatibility slice to v0.25. It assigns the public
adapter SDK, conformance suite, Buzz reference add-on, and managed bridge
operation to v0.29. Those assignments preserve the roadmap's “one release, one
promise” rule and do not make live Linear or Notion synchronization a v0.25
promise.

The commercial boundary remains:

- the sovereign Mupot core can be self-hosted;
- operators may install their own compatible adapters;
- `mupot.mumega.com` can monetize managed hosting, connector operation,
  upgrades, health, support, and operated presence;
- the v0.29 managed Buzz relay or managed coordination bridge is an operated
  service, not a reason to make the core dependent on Buzz or SOS.

## 10. Acceptance Criteria for a Future Implementation Plan

A later implementation plan is acceptable only if it:

1. preserves the current v0.23 and v0.24 public contracts;
2. assigns the work to a named roadmap milestone before implementation;
3. defines versioned contracts for each new typed port;
4. proves one package can bundle multiple independently authorized adapters;
5. includes conformance tests for supported and unsupported capabilities;
6. includes negative authorization, cross-tenant, identity-spoofing,
   replay/idempotency, connector-revocation, and adapter-offline tests;
7. keeps external code and credentials outside untrusted package code;
8. reports partial delivery and unknown outcomes honestly;
9. demonstrates that removing Buzz, SOS, or Linear leaves Mupot's identity,
   work, gates, receipts, and recovery intact.

## 11. Documentation Consequences

- README describes Mupot as the authority and labels current provider status
  honestly.
- The module-kernel architecture documents one catalog over several typed
  ports.
- Existing add-on package and runtime-profile documents remain authoritative
  within their own layers.
- No public document claims that Buzz or SOS integration, live Linear sync, or
  external add-on execution has shipped.
