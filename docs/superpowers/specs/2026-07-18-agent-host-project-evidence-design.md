# Agent Host and Project Evidence Productization Design

**Status:** Approved through the active product goal on 2026-07-18.

## Goal

Productize the proven Mac bridge as the standard Mupot Agent Host, connect the
DME-owned Kubernetes Hermes without crossing the customer-data boundary, and
make project-attributed tasks, messages, flights, and receipts visible from the
project Activity and Evidence views.

This design extends, rather than replaces, the approved cross-platform runtime
installer, project-centered workspace, and DME cross-pot collaboration designs.
SOS is not a dependency or transport for this work.

## Product Boundaries

- A pot remains the sovereignty boundary and source of truth for its data.
- The existing `fleet-runtime` installer is the only Agent Host installer.
- A runtime profile describes how one welded agent is activated. It does not
  mint identities, embed credentials, or create a second project-state store.
- Kubernetes runs the same Agent Host contract under a container supervisor;
  it does not receive a Mumega token or customer data from the Mumega pot.
- Project Activity is a read projection over authoritative task, message, and
  flight rows. It is not a mutable event log.
- Project Evidence is a read projection over append-only receipts and retained
  task results. It never invents a success state.

## Agent Host Profiles

The starter manifest gains an optional versioned `profiles` section. Each
profile binds one declared agent to an adapter, an allowlisted sender set, an
allowlisted message-kind set, and a local command expressed as an argument
array. Shell command strings are not accepted for productized profiles.

The inbox handler persists a message before activation and consumes it only
after the adapter exits successfully. It invokes the executable directly with
`shell: false`, supplies the sanitized batch over stdin, caps execution time,
and records a redacted local result. A profile cannot modify the host service
definition or obtain another profile's credential path.

Codex and Hermes adapters remain ordinary local executables. Their model login
may be referenced from an operator-owned path, but model credentials and Mupot
tokens are never copied into manifests, service definitions, receipts, or Git.
The default policy rejects unknown senders and acknowledgement loops.

## Kubernetes Runtime

The repository provides a Kubernetes deployment template containing:

- one non-root Agent Host container;
- a read-only runtime bundle and writable state volume;
- a Secret reference for the DME-owned agent credential, never a literal;
- liveness and readiness probes over redacted Agent Host state;
- a restrictive security context and no host filesystem mount;
- tenant, project, identity, and endpoint supplied as deployment values; and
- a NetworkPolicy allowing only DNS, the DME Mupot endpoint, and the configured
  model/provider endpoint.

The DME operator creates the DME identity and Secret inside the DME pot and
cluster. Mumega stores only a signed, allowlisted cross-pot receipt containing
source project, destination project, correlation ID, state, timestamps, and
evidence hashes.

## Project Attribution

`agent_messages` gains nullable `project_id`. Existing messages remain valid
and unassigned. New project-attributed messages must reference a non-archived
project. Direct agent sends require both sender and recipient to belong to at
least one squad explicitly connected to the project. Task-dispatch bridge
messages inherit `tasks.project_id`; their system sender is not treated as a
human or agent participant.

The sender-scoped `request_id` idempotency contract includes `project_id` among
the immutable fields. Reusing one request ID for another project is a conflict.
Inbox reads return project attribution so local handlers preserve context.

## Activity Projection

The project loader returns a bounded, cursor-ready merge of:

- tasks, using `created_at` and current status;
- agent messages explicitly carrying `project_id`;
- flights, using `created_at` and current status.

Rows expose stable source type, source ID, timestamp, actor/agent attribution,
status/kind, title or bounded message body, and correlation references. Project
RBAC is applied before the projection is loaded. HTML is escaped by the existing
`hono/html` renderer. The first UI page shows the newest 100 rows and reports
when additional rows exist; API pagination is required before claiming complete
historical exposure.

## Evidence Projection

Evidence is derived from rows that can be linked to a project without guessing:

- retained terminal task results;
- task verdict receipts;
- workflow receipts;
- task dispatch receipts;
- flight landing outbox receipts; and
- explicitly attributed acknowledgement messages.

Each evidence row includes source type and ID, timestamp, status, actor where
available, correlation references, and a bounded summary. Raw credentials,
private keys, authorization headers, and unrelated message bodies are never
included. The UI never turns a missing or failed receipt into a pass.

## Failure and Security Rules

- Unknown, archived, or inaccessible project attribution fails closed.
- Unknown runtime profiles, senders, message kinds, and executable paths fail
  before activation.
- Duplicate inbox delivery reuses the durable request correlation and cannot
  execute twice after a successful local receipt.
- Kubernetes readiness fails when identity, heartbeat, or inbox progress is
  stale; it does not report ready merely because the process is running.
- Revoking either welded token stops future work while preserving prior local
  and project receipts.
- Cross-pot payloads use an explicit allowlist; prohibited customer fields are
  rejected before signing and before destination authorization.

## Acceptance Criteria

1. A clean macOS or Linux host can install, status, reload, and uninstall the
   Agent Host while preserving credentials and state.
2. Productized runtime profiles execute without shell interpolation and reject
   unauthorized senders and acknowledgement loops.
3. A DME-owned Kubernetes Hermes reports healthy through the same host contract
   without sharing a token with Mumega.
4. Project-attributed tasks, messages, and flights appear in Activity with
   project RBAC and stable correlations.
5. Task results and every supported task/flight/message receipt appear in
   Evidence without fabricated state.
6. Cursor pagination exposes history beyond the first page.
7. Tests prove replay, revocation, stale health, invalid signature, prohibited
   fields, archived project, and unauthorized project access fail closed.
8. An end-to-end DME flight produces matching sanitized evidence hashes in both
   pots and is visible from both project views.
