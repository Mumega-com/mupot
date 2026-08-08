# Codex SOS Receiver

This document describes the current host-local receiver that wakes one exact
Codex thread from the SOS bus. It records observed behavior and the boundary
between the working prototype and a supported Mupot runtime endpoint.

The receiver is not part of the Mupot kernel. SOS is the current transport for
this prototype. Mupot owns the product-level identity, Project authorization,
runtime endpoint, durable work, and evidence contracts described in issue
[#577](https://github.com/Mumega-com/mupot/issues/577).

## Status

- Implementation: host-local macOS prototype
- Bus identity: `agent:hadi-codex`
- Supervisor: one user-scoped `launchd` service
- Poll interval: five seconds
- Target: one exact Codex thread handle configured on the host
- Delivery state: host-local durable pending spool
- Completion rule: mark delivered only after the resumed Codex process exits
  successfully

The raw Codex thread UUID, rollout path, SOS authorization value, message
bodies, and pending spool contents are host-sensitive. They must not be copied
into GitHub, Mupot receipts, logs intended for sharing, or agent messages.

## Components

```text
trusted SOS sender
  -> SOS durable inbox for agent:hadi-codex
  -> host-local polling watcher
  -> route and duplicate filters
  -> mode-0600 pending spool in a mode-0700 directory
  -> active-turn guard
  -> codex exec resume <exact-host-local-thread-handle>
  -> Codex handles the message
  -> optional correlated agent ACK over SOS
  -> successful child exit
  -> watcher advances its local seen cursor and clears the spool
```

The local `launchd` service keeps the watcher alive while the Mac user session
is running. Turning off the Mac or ending the user session stops this receiver.

## Receive Sequence

1. A sender writes a message to `agent:hadi-codex`.
2. SOS returns a transport receipt. This proves persistence on the bus; it does
   not prove that Codex read, accepted, or completed the request.
3. The watcher polls the `hadi-codex` inbox and derives a stable local message
   identity from `stream_id`, with a SHA-256 fallback.
4. It ignores self check-ins and onboarding-route noise.
5. It selects messages matching configured thread, Project, GitHub, or
   correlation tags.
6. Before starting Codex, it atomically writes the selected message IDs and
   bodies to a pending spool with mode `0600`. The containing directory is mode
   `0700`.
7. It scans the configured Codex rollout from the end to determine whether the
   exact thread already has an active turn.
8. If a turn is active, delivery stays pending. The watcher does not start a
   competing resume.
9. When the thread is idle, the watcher invokes `codex exec resume` with the
   configured exact thread UUID. It never uses `--last`.
10. Codex receives a synthetic user turn containing the selected SOS messages
    and receiver instructions.
11. If a message contains `[request_id:<uuid>]`, Codex replies to the sender
    with `{ack_for:<uuid>}` after it has accepted the request. Messages without
    a request ID do not require a formal ACK.
12. A zero exit from the resumed Codex process advances the local seen set and
    removes the pending spool. A non-zero exit or spawn failure retains the
    spool for retry.

## Receipt Semantics

These states must remain distinct:

| State | Meaning |
|---|---|
| SOS send receipt | SOS persisted the message |
| watcher pending | Host persisted the message before model activation |
| Codex process accepted | The exact thread started a turn |
| `{ack_for:<request_id>}` | The receiving agent accepted the correlated request |
| work receipt | The requested governed action produced evidence |
| watcher finalized | Codex exited successfully and local delivery state advanced |

An SOS send receipt must never be reported as an agent ACK. An ACK must never
be reported as task completion. ACK-only messages must not trigger another ACK,
or the agents can create an acknowledgement loop.

## Current Proof

The local watcher has demonstrated:

- `launchd` supervision and five-second successful polling;
- exact-thread resume rather than last-thread selection;
- durable spool-before-wake behavior;
- active-turn deferral without a competing resume process;
- success-only cursor advancement;
- a correlated ping from `hadi-codex` to the VPS `codex` agent and a matching
  `{ack_for:...}` response.

During that ping, the VPS `codex` agent reported a separate receiver defect:
its send and wake paths worked, but inbox retrieval returned an MCP SSE `404`.
This review did not independently reproduce the `404` from the VPS shell.
Sending the complete bounded payload directly in a follow-up message worked as
a temporary fallback. This fallback is not a substitute for reliable inbox
retrieval.

## Prototype Security Boundary

The current receiver is suitable only for a trusted internal SOS peer set.
These gaps prevent treating it as a general customer or multi-tenant endpoint:

1. **Text-tag routing is not authorization.** The watcher matches strings such
   as `[project:mupot]`; it does not verify a structured Project envelope.
2. **No explicit sender allowlist is enforced before model activation.** Any SOS
   peer able to address `hadi-codex` and reproduce a configured route tag may
   reach the synthetic Codex turn.
3. **Message text is inserted into the turn as untrusted content.** Metadata and
   body are not yet separated by a versioned, length-bounded envelope.
4. **The active-turn check is not an atomic app-server operation.** The watcher
   checks the rollout file and then spawns the CLI, leaving a narrow
   check-to-start race.
5. **Singleton scope is process-local.** `launchd` supervises one labelled
   service, but the script does not hold an inter-process lock against a second
   manually started watcher.
6. **Endpoint authority is host configuration.** A raw thread UUID selects the
   target locally. It is not a revocable, opaque Mupot endpoint capability.
7. **Delivery completion is child-exit based.** The receiver does not yet
   persist a server-authoritative Codex turn ID and acceptance receipt.
8. **Policy changes after spooling need a dead-letter rule.** A queued message
   is not reauthorized against sender, Project, or endpoint revocation before
   every retry.

These are security and lifecycle requirements, not reasons to move prompt
orchestration into Mupot. Codex still owns its thread context and execution.

## Supported Endpoint Target

A supported implementation should replace host text routing with a versioned
runtime endpoint:

```text
runtime_endpoint_id        opaque Mupot identifier
agent_id                   authenticated durable agent
project_id                 one authorized Project
runtime_kind               codex
host_registration_id       authenticated host
local_handle_ref           host-only lookup key, never the raw UUID in Mupot
lease_generation           revocable endpoint generation
last_seen_at               authenticated heartbeat
status                     accepting, busy, stale, revoked
```

Before wake, the host adapter must verify the sender, Project, endpoint lease,
message kind, request correlation, size limits, and current policy generation.
It should then call the Codex app-server's atomic turn start or queue operation,
persist the resulting turn acceptance receipt, and only then acknowledge
delivery. Credential custody and local thread handles remain host-only.

## Operator Check

Use the host-local status helper to inspect:

- `launchd` state and PID;
- last successful poll;
- pending count;
- active Codex child state;
- last wake and child exit;
- recent redacted errors.

A controlled canary is complete only when:

1. the sender receives an SOS transport receipt;
2. the receiver persists and wakes the exact intended thread;
3. the sender receives the correlated agent ACK;
4. the resumed turn exits successfully;
5. the pending spool is absent and the seen cursor has advanced;
6. no second Codex resume or ACK loop appears.

Failure handling:

| Symptom | Required behavior |
|---|---|
| SOS HTTP/auth failure | retain pending state or leave inbox unseen; repair credential |
| route tag mismatch | do not wake this thread |
| active thread | retain pending and retry later |
| Codex spawn/turn failure | retain pending; do not emit success |
| VPS inbox SSE `404` | report transport degraded; do not infer missing payload |
| stale/revoked endpoint | fail closed and dead-letter or retain under governed policy |
| duplicate watcher | refuse the second process after a host-level lock is added |

## Coordination With Kasra

Requests to Kasra should include:

- `[project:mupot]`;
- the public thread/lane label, not the raw Codex UUID;
- one `[request_id:<uuid>]`;
- the complete bounded task or a durable GitHub issue URL;
- explicit authority boundaries such as read-only, review-only, no deploy, or
  no credential use.

Kasra's response is accepted only when it includes the matching
`{ack_for:<uuid>}`. Long-running work should then produce a later PASS/BLOCK or
completion receipt with an exact commit and durable proof URL. GitHub remains
the durable decision and evidence record; SOS provides delivery, wake, and
correlation.

## References

- [Issue #577: exact Codex thread endpoint](https://github.com/Mumega-com/mupot/issues/577)
- [Issue #602: MCP read/write session divergence](https://github.com/Mumega-com/mupot/issues/602)
- [Runtime Adapter Contract](./runtime-adapter-contract.md)
- [Agent Host Project Evidence Design](./superpowers/specs/2026-07-18-agent-host-project-evidence-design.md)
