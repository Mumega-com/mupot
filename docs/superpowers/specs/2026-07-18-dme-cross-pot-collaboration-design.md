# DME Cross-Pot Agent Collaboration Design

## Goal

Enable agents running in different environments and sovereign Mupot deployments to work on one business outcome without copying customer data or credentials between pots.

The first implementation connects:

- `codex-mac-mumcp`, a Codex agent in the Mumega pot;
- `hadi-mupot-dme`, a Hermes development agent in the Mumega pot; and
- a Kubernetes-hosted Hermes operations agent in the DME pot.

Success means the agents can receive attributed work, exchange scoped messages, report status, and attach verifiable outcomes while each pot remains authoritative for its own data.

## Project Topology

The Mumega pot owns product development and integration work:

```text
Mupot Development
└── DME Integration
    ├── Core Platform (admin)
    └── DME Delivery (write)
```

The DME pot owns customer operations:

```text
DME Operations
└── DME Hermes Kubernetes
```

`DME Integration` is a child of `Mupot Development`. It records plugin development, integration tests, deployment preparation, and sanitized evidence. It must not contain DME customer records, marketing credentials, raw analytics, message bodies, or private model memory.

## Identities

Each runtime has a distinct agent identity and agent-bound token.

| Runtime | Pot authority | Identity | Responsibility |
| --- | --- | --- | --- |
| Codex desktop/CLI on Hadi's Mac | Mumega | `codex-mac-mumcp` | Product coordination, review, and implementation |
| Hermes development runtime | Mumega | `hadi-mupot-dme` | DME plugin development and integration testing |
| Hermes Kubernetes runtime | DME | DME-owned slug chosen in the DME pot | Customer operations and local evidence production |

Tokens are never copied between runtimes or pots. A runtime that connects to two pots uses two independently minted profiles and presents the correct token to each endpoint. Shared display names do not imply shared authority.

The Kubernetes Host mounts the DME-welded operator token as a read-only file
from a DME-owned Kubernetes Secret. Its sterile profile admits only that fixed
file path and the non-secret plugin mode. The daemon, probe shell, and inbox
dispatcher never receive the bearer value; the fixed Hermes adapter reads the
file immediately before spawning the one-shot Hermes child. The Hermes home
PVC, operator plugin ConfigMap, signing-key Secret, and operator-token Secret
remain controlled by the DME namespace and are verified by the deployment
receipt.
The fixed adapter transports each validated project batch over stdin to a
bounded Python bridge. Customer message bodies never become process arguments.
Release evidence includes a no-network, no-customer-PVC plugin-discovery Job
whose observed pod image ID, Job execution contract, plugin bundle, and
completion time must match the immutable Host release candidate.
The plugin ConfigMap is immutable and content-addressed; smoke evidence also
binds its live UID and resource version. The Host remains at zero replicas until
a guarded activation command revalidates the exact cluster snapshot, scales
with optimistic concurrency, checks the post-scale state, and automatically
returns to zero on mismatch.
The install manifest starts at zero replicas. The legacy subscriber must be
absent before the rendered Host is activated at one replica; rollback stops the
Host before restoring the old subscriber. Concurrent consumers for one welded
identity are prohibited because peek-before-consume activation is not a lease.
A fresh Kubernetes preflight enumerates workloads and pods, proves the legacy
container is absent and the Host is inert, and becomes a mandatory input to the
activation receipt. The receipt expires that proof after five minutes.
Rollback uses two equivalent live-cluster proofs: `rollback-ready` requires the
Host to be fully inert before restoration, and `rollback-complete` requires the
legacy subscriber to be restored only in the preserved DME Deployment while the
Host remains inert.
The consumer fence also pins the SHA-256 fingerprint of the exact registered
Ed25519 public key. Signed peek and consume SQL check that fingerprint in the
same statement that selects or claims messages, so replacing a key cannot
silently inherit live inbox authority.
Host readiness requires a successful signed inbox operation. Guarded activation
then rechecks the same fence generation and pinned fingerprint after readiness;
rollback-complete independently proves the live fence is `bearer_only` before it
can report a restored legacy consumer.

## Collaboration Model

Same-pot collaboration uses existing Mupot primitives:

- project-attributed tasks;
- project squad access;
- agent inbox and direct messages;
- governed flights;
- task and flight status updates; and
- verification receipts.

Cross-pot collaboration uses a provider-neutral project-link adapter. The adapter exchanges signed, bounded envelopes rather than database rows.

### Allowed Envelope

A cross-pot project envelope may contain:

- source pot and destination pot identifiers;
- source and destination project identifiers;
- source agent identity and key identifier;
- correlation, task, flight, and request identifiers;
- task title, state, priority, blocker summary, and success predicate;
- sanitized progress summary;
- evidence hash, media type, timestamp, and authorized URL;
- capability requested for the receiving action; and
- expiry and idempotency key.

It must not contain raw customer data, access tokens, API keys, private prompts, full conversation transcripts, contact lists, analytics exports, or unapproved file contents.

## Latest Situation Projection

Each project page computes its latest situation from durable facts rather than a manually written report. The projection includes:

- project intent status and target date;
- open, in-progress, review, blocked, and completed task counts;
- active, failed, held, and landed flights;
- participating squads and agents;
- agent liveness and last check-in;
- blockers and stale work;
- recent attributed activity;
- verified evidence receipts;
- linked-pot source and last synchronization time; and
- explicit unknown or unavailable states.

Remote facts are labeled with their source pot. A stale remote link never appears current. Missing data is shown as unknown and is never inferred from unrelated workspace activity.

## Runtime Protocol

On startup, each connected runtime:

1. selects its pot profile and MCP endpoint;
2. authenticates with its agent-bound token;
3. calls `check_in` with its runtime source and project label;
4. calls `orient` to obtain identity, squad, and assigned work;
5. reads its inbox and project-filtered task list;
6. accepts only work allowed by its current capability grants; and
7. updates task or flight state and attaches evidence as work progresses.

The Hermes development agent and Codex communicate directly through Mupot inbox messages and shared tasks. A local Codex CLI runtime may poll the inbox and activate work while the Mac is online. The desktop conversation itself is not treated as an always-on daemon.

### Activation Modes

The Hermes development identity supports two activation modes without changing its Mupot authority:

1. **On demand:** a signed-in desktop Hermes session reads its Mupot inbox and project tasks when the operator requests it. MCP tools are discovered when the desktop session starts, so the session must be restarted after the connection is installed.
2. **Supervised background activation:** a macOS LaunchAgent runs a narrow subscriber that peeks one durable inbox item, persists it before execution, invokes the welded Hermes profile, persists the response, sends a correlated reply, and consumes the inbox item only after the reply is durable.

The subscriber is an activation adapter, not a second source of project state. It rejects unauthorized senders, suppresses acknowledgement loops, preserves `request_id` and `in_reply_to`, and tags the invoked Hermes session with its source. It does not inject messages into an existing desktop conversation. Mupot tasks, messages, flights, and receipts remain authoritative whether Hermes is activated on demand or in the background.

## Project-Link Adapter

The cross-pot adapter is an addon, not microkernel code. Its responsibilities are:

- authenticate both pot endpoints independently;
- map the paired project identifiers;
- grant task-write and evidence-write independently per paired link;
- validate and sign outbound envelopes;
- enforce an allowlist of fields, evidence types, and evidence origins;
- deduplicate delivery by idempotency key;
- preserve source attribution;
- retry transient delivery safely;
- acquire one bounded outbound delivery lease with an authorization-guarded D1
  write before any remote request;
- expose link health and last successful synchronization; and
- return a destination-signed canonical receipt and record the verified receipt
  atomically with delivery state in both pots.

The adapter cannot mint identities, broaden capabilities, or read arbitrary source-pot data. Both projects must explicitly enable the link.

## Failure Handling

- Invalid signatures, expired envelopes, unknown projects, and insufficient capability fail closed.
- Duplicate envelopes reauthorize the current link before returning the original
  signed receipt without repeating the action.
- A destination outage leaves the source item pending with bounded retry metadata.
- Matching failed deliveries remain resumable with the same signed envelope and
  cumulative attempt count; exhausted delivery is surfaced for operator review.
- Every success, retry, and failure transition must present the active delivery
  claim. A concurrent invocation cannot send, and a late failure cannot downgrade
  a delivery already recorded as delivered.
- Revoking either project link or runtime token stops future delivery without deleting prior receipts.
- Remote status becomes stale when its freshness window expires.

## Security Boundary

The DME pot remains the system of record for customer operations. Mumega receives
only the minimum approved coordination state. Evidence URLs are references only,
must use an explicitly paired HTTPS origin, and carry no query or fragment. No
cross-pot action inherits the sender's local capability; the destination
reauthorizes every requested operation against its own RBAC grants immediately
before the atomic write. Receipts are signed by the destination key registered in
the paired link; matching hashes alone are not treated as authentication.
Project messages are visible only when both endpoint identities resolve and both
endpoint squads are readable; an absent identity never implies project-wide scope.

## Initial Backlog

1. Create the `DME Integration` child project in the Mumega pot.
2. Create the `DME Delivery` squad and grant it write access to the child project.
3. Register `hadi-mupot-dme` in that squad and mint an agent-bound token.
4. Connect its Hermes plugin and complete check-in, orientation, inbox, and direct-message handshakes.
5. Add Codex coordination and Hermes integration tasks to the child project.
6. Define the project-link addon manifest and signed envelope schema.
7. Implement idempotent cross-pot delivery and receipt storage.
8. Add remote status to the project latest-situation projection.
9. Connect the DME Kubernetes Hermes with a DME-owned identity and project.
10. Run an end-to-end flight that produces a sanitized receipt in both pots.
11. Verify revocation, stale-link, duplicate-delivery, and customer-data-denial paths.
12. Publish the integration receipt and operating runbook.

## Acceptance Criteria

- Codex and `hadi-mupot-dme` appear as active participants in the Mumega DME project.
- Both can exchange direct messages and work from the same project-attributed task list.
- The Kubernetes Hermes remains controlled by the DME pot and does not share its token.
- A signed task envelope can cross between paired projects exactly once.
- Both pots retain the same destination-signed linked receipt with matching
  correlation, evidence, envelope, and canonical receipt hashes.
- The Mumega project page shows source-labeled remote status and staleness.
- Tests prove that prohibited customer fields, invalid signatures, revoked links, and unauthorized actions fail closed.

## Rollout

Phase one provisions same-pot collaboration between Codex and `hadi-mupot-dme`. Phase two implements the project-link addon and tests it between non-production fixtures. Phase three connects the DME Kubernetes runtime with a narrow allowlist. Production customer workflows remain disabled until the data-boundary and revocation tests pass.
