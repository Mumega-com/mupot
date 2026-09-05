# Codex Exact Delivery: Status and Activation Boundary

**Status snapshot:** 2026-09-05. This document distinguishes the installed
active-turn integration from the inactive exact-delivery receiver. It authorizes
neither configuration changes nor service activation.

## System boundary

```text
Mupot = identity, authorization, task/dispatch state, receipts, and gates
Codex plugin = active-turn Mupot context and action preflight
Host receiver = one exact inbox, durable intake, private route, App Server wake
Codex App Server = exact thread/turn events and consumption attestation
Independent gate = review of a completed artifact, never a transport event
```

A Mupot message can request a wake. It never grants action authority. Transport
delivery, runtime consumption, correlated acknowledgment, completion, and a
gate verdict remain separate states.

## Current evidence table

| Component | Evidence | Current status | Do not infer |
|---|---|---|---|
| Generic Mupot runtime attachment | [Runtime Adapter Contract](../runtime-adapter-contract.md) | Documented; broader adapter conformance remains planned. | Exact Codex idle wake or runtime consumption. |
| Mupot Codex plugin | Local personal plugin package | Installed active-turn MCP/skill integration with a restricted tool policy. | A background receiver, a durable service, or automatic idle wake. |
| Runtime dispatch contract issue | [Issue #1240](https://github.com/Mumega-com/mupot/issues/1240), closed 2026-08-30 | Defined the Mupot-side exact-runtime receipt contract and acceptance boundary. | Complete live implementation or canary evidence. |
| First server foundation | [PR #1249](https://github.com/Mumega-com/mupot/pull/1249), merged 2026-08-30 | Added the first exact external dispatch-receipt foundation. | An activated receiver or finished dispatch contract. |
| Current server repair | [PR #1327](https://github.com/Mumega-com/mupot/pull/1327), open | Runtime-consumption lease fencing and shared dispatch/review-wake repair. | Merge readiness: the observed build currently fails a cross-squad assignment test. |
| Canonical standalone receiver | Reviewed source branch; no PR found | JavaScript receiver, ledger, App Server client, receipt handler, policy, and synthetic conformance exist. | A running process, valid credential, or live consumption proof. |
| Hadi-CC activation adapter | Local-only branch; no PR found | Synthetic gate/replay evidence around the receiver exists. | Authorization to install, bind a credential, or wake a real task. |
| Rust `mupot-hostd` / Tauri | Historical implementation plan | Future host-consolidation design. | Any Rust workspace, binary, service, or user interface exists. |

## Active-turn plugin: what it is and is not

The Codex plugin uses one canonical Mupot MCP mapping with a bearer environment
variable reference. Its constrained initial surface is intended for:

- exact workspace identity orientation;
- bounded project/task/inbox context;
- inbox leasing; and
- explicit check-in or approval-gated writes.

The plugin is an active-turn aid. It must not be described as a daemon and must
not be used to infer an idle task can wake itself. MCP connects a running
Codex turn; it does not create a durable receive loop.

Legacy generic connector configuration must be treated as connection guidance
only. It does not establish an agent-bound identity, authorize a receiver, or
prove a task was consumed. Keep bearer values in protected environment/secret
storage; never place raw values in repository configuration, prompts, receipts,
or screenshots.

## Exact receiver contract

Before any Mupot-derived context is injected, and again immediately before every
privileged Mupot write, a receiver must prove:

1. a workspace-channel, exact agent-bound credential;
2. expected immutable agent identity, tenant, squad, project, seat, and
   harness visibility;
3. one owner-only receiver per inbox/credential;
4. trusted outer sender, allowed public route, dedicated private thread/workdir,
   and active voice-task exclusion;
5. durable intake, cursor/deduplication, singleton ownership, and
   generation-fenced lease before an external effect; and
6. Mupot’s current task/dispatch authority at the moment of every receipt or
   acknowledgment write.

The host must fail closed on unknown, active, blocked, stale, replayed,
wrong-sender, wrong-route, identity-drift, expired, or ambiguous states.

### Machine-verifiable consumption

For a dedicated synthetic Codex thread, the receiver records `start_pending`
before App Server start. It accepts consumption only after the exact thread and
turn invoke the thread-bound dynamic consumption tool and the matching successful
dynamic-tool completion event arrives. Model prose, generic events, transport
delivery, and an assistant response are never consumption evidence.

The local Codex App Server dynamic-tool capability is experimental. It therefore
requires a versioned capability check and fails closed rather than falling back
to transcript parsing or an uncorrelated CLI marker.

## Required proof chain before activation

```text
task assigned
→ dispatch receipt
→ one durable inbox delivery
→ durable receiver intake and start fence
→ one exact Codex thread/turn start
→ runtime_consumed receipt
→ one correlated Mupot acknowledgment
→ artifact/completion record
→ independent gate verdict
```

Each restart/replay boundary must preserve one model turn and one receipt per
idempotency key. A terminal or failed dispatch must not become consumable after
reopen, and an artifact claim must be checked against a safe path and digest.

## Activation prerequisites

The following are distinct approval and evidence steps:

1. Repair PR #1327’s current cross-squad assignment failure; rerun required
   checks and obtain independent review before merge.
2. Reconfirm the Mupot-side external envelope contains the trusted correlation
   required by the receiver. Private thread IDs and raw credentials never leave
   the host.
3. Resolve all receiver safety findings: terminal-state fence ordering,
   parent-symlink/TOCTOU-safe artifact evidence, and mandatory normalized
   dispatch-body validation.
4. Prepare an owner-only route registry, ledger, singleton lock, and one
   dedicated synthetic thread. No active voice task or arbitrary user thread may
   be a route target.
5. Prove the protected workspace identity and render/verify the host tool policy
   without widening permissions or using a shared/admin credential.
6. Run one independently observed synthetic canary, including restart/replay
   boundaries and zero duplicate consumption or ACKs.
7. Obtain a separate service-installation/activation approval and retain a
   disable/rollback path.

Until all seven steps have their required evidence, the receiver is **not
active**.

## Rust host is a later consolidation, not an activation shortcut

The planned `mupot-hostd` would consolidate fixed-operation verification,
per-seat isolation, durable local state, harness adapters, and a future thin
management UI while retaining Mupot as the authority plane. The plan has no
runnable Rust workspace or service today.

Do not begin with a daemon installer or Tauri UI. First establish the JavaScript
receiver as the parity oracle through the exact live synthetic canary. Only then
should Rust Stage 1 freeze cross-language fixtures and protocol parity.

## Related references

- [Runtime Adapter Contract](../runtime-adapter-contract.md)
- [Host a seat](../host-a-seat.md)
- [Workflow/Studio/Council lineage](../architecture/workflow-studio-council-lineage.md)
- [Mupot runtime-dispatch issue #1240](https://github.com/Mumega-com/mupot/issues/1240)
