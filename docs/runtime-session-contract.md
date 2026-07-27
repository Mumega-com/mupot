# Runtime Session Contract

This document defines `mupot.runtime-session/v1`, the contract adapters use to
publish **observations** of a concurrent harness instance — a "runtime
session" — into Mupot.

This is a companion contract to
[`docs/runtime-adapter-contract.md`](./runtime-adapter-contract.md)
(`runtime-adapter/v1`), not a replacement. `runtime-adapter/v1` governs how a
runtime **attaches, authenticates, and acts** (attach/detach, messaging,
tasks, flights). `mupot.runtime-session/v1` governs how Mupot **observes and
displays** the fact that N concurrent instances of one agent identity exist,
each doing different work, without collapsing them into one contradictory
status.

The matching machine-readable artifact is
[`docs/runtime-session-v1.json`](./runtime-session-v1.json), in the same
descriptive-contract style as `docs/runtime-adapter-v1.json` (not a strict
JSON Schema document — this repo has no JSON Schema / ajv / zod precedent;
the descriptive-contract-JSON + prose-doc pairing is the established
convention). A TypeScript type sketch matching `src/types.ts` conventions is
in the design doc,
[`docs/superpowers/specs/2026-07-27-runtime-session-v1-design.md`](./superpowers/specs/2026-07-27-runtime-session-v1-design.md).

This is a **design/spec artifact**. No code in this repo implements it yet.

## Version

- Contract id: `mupot.runtime-session/v1`
- Status: proposed, unimplemented — companion design doc pending dyad-gate
  before any migration or route lands
- Depends on: `runtime-adapter/v1` (identity/attach), the immutable
  `agent_member_bindings` invariant (`migrations/0071_agent_connections.sql`),
  `module_registry` presence (`migrations/0066_module_registry.sql`)
- Future incompatible changes must create a new contract id. Additive fields
  may be accepted when readers ignore unknown fields, matching the
  `runtime-adapter/v1` precedent.
- **Revision (2026-07-27, additive):** `runtime` enum gained `sos-bus`
  (coordination-event adapter, distinct in kind from the liveness-oriented
  adapters — see design doc §3). No breaking change; existing readers that
  ignore unrecognized enum values are unaffected.

## The problem this closes

Confirmed live gap (`migrations/` grep, 2026-07-27 research pass): there is
**no D1 concept of "session," "worker," or "concurrent instance of an
agent."** `fleet_agents` (`PRIMARY KEY (tenant, agent_id)`) and `presence`
(`PRIMARY KEY (tenant, member_id)`) are both **single-row-per-identity**
caches. A second concurrent runtime attaching or checking in as the same
agent **silently upserts over the first row** — last-write-wins, no
multi-session representation anywhere.

Real incident, 2026-07-27 (recorded on mupot#544): tmux sessions `kasra` and
`mumcp` both emitted SOS bus replies as `agent:kasra`. The `kasra` session
owned an independent PR-579 gate; the `mumcp` session separately owned
`Mumega-com/mcpwp` branch `feat/seo-market-data`. Both reports were
individually correct; agent-level status looked contradictory because
nothing below the agent distinguished the two concurrent sessions. §8 of the
design doc walks this exact incident through the schema below.

## Identity model — session, source, and agent are three different things

- **`agent_id`** — the permanent, durable Mupot agent identity (`agents`
  table). One canonical identity per real teammate. Immutably bound to at
  most one `member_id` via `agent_member_bindings` (`migrations/0071`,
  update-forbidden by trigger). **Never minted or mutated by an adapter.**
- **`session_id`** — a Mupot-minted, immutable UUID identifying one
  concurrent runtime instance of that agent. Minted once, on first
  observation for a given `(tenant, adapter, source_id)` tuple that has no
  existing open session; never reused, never reassigned to a different
  `agent_id`. A session is retired (not deleted) when it goes stale past its
  adapter-declared TTL or receives an explicit detach observation.
- **`source_id`** — the harness-local stable identifier for the concurrent
  instance, supplied by the adapter, opaque to Mupot: a tmux session name
  (`tmux:kasra`), a Codex thread id, a Cursor background-agent id, a Claude
  Code process's `.mcp.json` connection id. `source_id` plus `adapter` plus
  `tenant` is what lets a re-attaching adapter find and continue its own
  existing `session_id` instead of minting a duplicate — this triple is the
  session-identity dedupe key, analogous to how `(tenant, identity,
  project_key)` dedupes `module_registry` rows today.
- **`worker_id`** *(optional)* — for adapters whose harness fans a session
  out into sub-processes (Codex subagents, a Claude Agent SDK `Task` fan-out,
  a Codex worktree-manager child), `worker_id` scopes an individual
  observation to one sub-unit of the session. Most adapters never populate
  this field; when absent, the observation describes the whole session.

**Relationship:** one `agent_id` → many concurrent `session_id`s → each
`session_id` keyed by exactly one `(adapter, source_id)` pair → each session
optionally fans out into `worker_id`s. Activity, heartbeat, task ownership,
and handoff evidence attach to the **session** first; the agent-level view is
a **read-time rollup** over that agent's currently-open sessions, never a
second mutable row that something can last-write-wins over.

## Envelope (every observation)

| Field | Type | Notes |
|---|---|---|
| `schema` | `"mupot.runtime-session/v1"` | Contract id, literal |
| `tenant` | string | Always `env.TENANT_SLUG`; never client-asserted, matching `runtime-adapter/v1` |
| `observation_id` | string | Adapter-supplied idempotency key, unique per `(tenant, adapter, source_id)`. Retrying the same `observation_id` with identical payload is a no-op; retrying with different payload is `observation_conflict` (mirrors `request_id_conflict` in `runtime-adapter/v1`) |
| `session_id` | string \| null | Null on the **first** observation for a new `(tenant, adapter, source_id)`; Mupot mints and returns it, adapter must echo it on every subsequent observation for that session |
| `source_id` | string | Harness-local stable id, see above |
| `worker_id` | string \| null | Optional sub-unit id, see above |
| `seq` | integer | Monotonic per `session_id`, adapter-assigned or Mupot-assigned on accept. Resolves out-of-order delivery: an observation with `seq` ≤ the session's currently-stored `seq` updates the append-only log but never regresses the session's latest-state projection |
| `observed_at` | RFC3339 timestamp | When the adapter captured the observation locally |
| `emitted_at` | RFC3339 timestamp | When the adapter sent it (may lag `observed_at` under backpressure) |

## Body fields (mapped to the issue's minimum-field list)

| Issue requirement | Field(s) | Notes |
|---|---|---|
| stable session and worker identifiers | `session_id`, `source_id`, `worker_id?` | see Identity model above |
| adapter and runtime kind | `adapter` (implementation id, e.g. `codex-cli-driver-v1`), `runtime` (kind enum — reuses `runtime-adapter/v1`'s existing set: `codex`, `cursor`, `claude-code`, `hermes`, `tmux`, `dmux`, `systemd-user`, `python`, plus `sos-bus` **(2026-07-27 revision, additive)** — the coordination-event adapter, see the design doc §3 "SOS Bus — coordination-event adapter" for its event-kind mapping) | `adapter` names the specific driver/integration; `runtime` names the harness family |
| agent identity, where verified | `agent_id: string \| null`, `identity_mapping: { status: "unmapped" \| "mapped" \| "ambiguous" \| "revoked", mapped_agent_id?, mapped_by_member_id?, mapped_at?, method? }` | Unmapped observations are stored and visible only in the org-admin **Unmapped runtimes** queue (per Hadi's 2026-07-27 comment) — never auto-bound to a guessed agent |
| repository, branch, worktree, process metadata | `context: { repo?, branch?, worktree_path?, host?, pid? }` | All optional/best-effort; a tmux adapter may only have `host`, a CI adapter only `repo`+`branch` |
| objective, linked task/flight, owned/seeded paths | `objective: string?`, `linked: { task_id?, flight_id?, project_id? }`, `owned_paths: string[]` | `linked.task_id`/`flight_id` are read-only references Mupot validates exist and are visible to the session's mapped agent; an unresolvable reference is dropped from the stored observation and flagged, never trusted blind |
| observed activity and separately verified liveness | `activity: { last_observed_at, last_signal_kind }`, `liveness: { status: "verified" \| "unverified" \| "unknown", verified_at?, verified_by_method? }` | **Never conflated.** `activity` is "something happened here recently" (a log line, a webhook, a file mtime); `liveness` is "an independent, checkable proof the process is currently alive" (a signed attach, a bearer check-in, a vendor-API poll response). A session can have fresh `activity` and `unverified` liveness (e.g. tmux pane output with no inner harness attach) |
| worker state and health with provenance and observation time | `state: { lifecycle: "attaching" \| "active" \| "idle" \| "stale" \| "detached" \| "unavailable", health: "ok" \| "degraded" \| "blocked" \| "unknown" }`, `provenance: { source_target, adapter_version, observed_at }` | `lifecycle` and `health` are orthogonal axes so "stale but was healthy" and "active but degraded" are both representable, per acceptance criterion on distinguishing unknown/stale/unavailable/degraded |
| output summary, validation performed, artifacts, remaining risks | `report: { summary?, validation_performed: string[], artifacts: string[], remaining_risks: string[] }` | Free-text/URI evidence only. **Never a completion signal** — see the state-ownership doc for why a full `report` cannot set `tasks.status='done'` |
| source target and adapter version | `source: { target: string, adapter_version: string }` | `target` names the system-of-record the observation was derived from: `"sos-bus"`, `"codex-app-server-api"`, `"tmux-local-daemon"`, `"cursor-webhook"`, etc. — lets a reader weigh a vendor-API-attested observation differently from a self-reported one |

## Error taxonomy (mirrors `runtime-adapter/v1` §Error Taxonomy)

- `unauthorized` / `forbidden` — same meaning as `runtime-adapter/v1`
- `bad_request` — malformed envelope or body
- `observation_conflict` — `observation_id` reused with different payload
- `session_agent_mismatch` — adapter echoed a `session_id` that belongs to a
  different `agent_id` than the current identity mapping resolves to (replay
  or cross-tenant confusion attempt)
- `identity_unmapped` — observation accepted and stored, but has no bound
  `agent_id`; surfaces only in the Unmapped runtimes queue
- `stale_reference` — `linked.task_id`/`flight_id` did not resolve or is not
  visible to the mapped agent; the reference is dropped, not trusted
- `cross_tenant_denied` — signature/token tenant does not match the
  observation's own `tenant` field

## What this contract explicitly does not do

- It does not mint, mutate, or delete an `agents` row.
- It does not write `tasks.status`, `task_verdicts`, `flights.status`,
  `agent_member_bindings`, `project_squad_access`, or any capability grant.
- It does not treat a fresh `activity` signal as `liveness`, and does not
  treat `report` evidence as a gate verdict.
- It is not a transport. Adapters still use `runtime-adapter/v1`'s existing
  attach/messaging/task surfaces to act; this contract is the parallel,
  read-only observation channel describing what is happening.
- **(2026-07-27 revision)** It is never presented as, or merged with, the
  authoritative Mupot state layer (agent identity, squad, task/flight,
  completion, gate, evidence). Any surface built on this contract must keep
  that layer structurally separate — see the design doc §5 "Two-layer
  presentation" subsection for the concrete API/UI split.
