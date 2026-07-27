# Canonical Runtime Sessions and Cross-Harness Adapters — Design

**Status:** Design, drafted 2026-07-27. Design/spec only — no implementation
code, no migration, no route. Awaiting dyad-gate (Kasra-core correctness +
diverse cross-vendor review) before any build slice starts.

**Issue:** [Mumega-com/mupot#544](https://github.com/Mumega-com/mupot/issues/544)
— "Architecture: canonical runtime sessions and cross-harness adapters."

**Builds on:**
[Runtime Adapter Contract `runtime-adapter/v1`](../../runtime-adapter-contract.md),
[Runtime Session Contract `mupot.runtime-session/v1`](../../runtime-session-contract.md)
(new, this design),
[BYOA Harness Support](./2026-07-23-byoa-harness-support-matrix-design.md),
[mupot Module Kernel](../../architecture/mupot-module-kernel.md),
[Agent Identity, Memory & Lifecycle §2.1](../../architecture/mupot-agent-identity-memory-lifecycle.md)
(the unimplemented Port 1.1 "Agent vs Instance" prose this design turns into a
real schema), and
[#473 ADR: fleet coordination = mupot CF-native, retire SOS](https://github.com/Mumega-com/mupot/issues/473).

## 0. What problem this actually closes

Confirmed by grepping every migration in this repo (2026-07-27): there is
**no D1 concept of "session," "worker," or "concurrent instance of an
agent."** The two tables that look like presence — `fleet_agents`
(`migrations/0035`/`0039`/`0051`, `PRIMARY KEY (tenant, agent_id)`) and
`presence` (`migrations/0016`, `PRIMARY KEY (tenant, member_id)`) — are both
**single-row-per-identity caches**. A second concurrent runtime attaching or
checking in as the same agent silently **upserts over the first row** —
last-write-wins, zero multi-session representation anywhere in the stack.
`docs/architecture/mupot-agent-identity-memory-lifecycle.md` §2.1 already
named this gap in prose on 2026-07-21 ("Agent vs Instance — Port 1.1") but it
was never turned into a schema. This design is that schema.

The concrete trigger is a real incident recorded on the issue (2026-07-27):
tmux sessions named `kasra` and `mumcp` both emitted SOS bus replies as
`agent:kasra`. The `kasra` session correctly owned an independent PR-579
gate review; the `mumcp` session separately owned unrelated work on
`Mumega-com/mcpwp` branch `feat/seo-market-data`. Both reports were
individually true. Agent-level status looked contradictory only because
nothing below the agent distinguished the two concurrent sessions. §8 below
walks this incident through the schema end to end.

## 1. Key design decisions

1. **Three distinct identities, not two.** `agent_id` (permanent, one per
   real teammate) → `session_id` (Mupot-minted, one per concurrent runtime
   instance) → `source_id` (harness-local opaque id an adapter supplies, the
   dedupe key alongside `tenant`+`adapter`). A session never gets reassigned
   to a different agent; an agent rolls up many concurrent sessions read-time,
   never through a second mutable row.
2. **Observations are an append-only log, not an upsert cache.** Unlike
   `fleet_agents`/`presence`, the new `runtime_session_observations` table is
   append-only and idempotent by `observation_id`, with a monotonic per-session
   `seq` so out-of-order delivery cannot regress the latest-state projection.
   This is a deliberate divergence from the existing presence pattern because
   the existing pattern is the literal bug this issue exists to fix.
3. **Activity and liveness are separate axes, always.** No single field
   means both. `activity` is "something happened recently, self-reported or
   observed." `liveness` is "an independently checkable proof of aliveness,"
   and it carries its own `verified_by_method` so a reader can tell a
   cryptographically signed attach apart from a vendor API poll apart from
   nothing at all.
4. **Identity mapping is opt-in and queued, never auto-created.** An
   observation with no resolvable `agent_id` is stored and only ever
   surfaced in an org-admin **Unmapped runtimes** queue (per Hadi's
   2026-07-27 delivery brief on the issue). Nothing about this design
   auto-creates an agent from an observed external name — that is exactly
   the "3-hermes sprawl" failure `mupot-agent-identity-memory-lifecycle.md`
   §2.2 already recorded and moved to avoid.
5. **Adapters are strictly downstream of `runtime-adapter/v1`.** This
   contract does not replace attach/detach/messaging/task/flight surfaces —
   it is a parallel, read-only observation channel. An adapter that wants to
   *act* still goes through the existing signed/bearer attach and MCP task
   tools; this contract only describes what is happening.
6. **SOS is one optional, temporary, read-only adapter among several**, not
   the model for the contract. Per #473, mupot's own D1+DO+Queues are the
   fleet coordination substrate and SOS is being retired; the SOS-import
   adapter (§3, "Hermes/SOS bridge") is explicitly the weakest-signal adapter
   in this design, not the reference one.
7. **This design does not touch `module_registry` or `fleet_agents`
   directly.** They stay as-is in this slice; a later slice may redefine
   them as query-time projections *over* `runtime_sessions` (noted as an
   explicit follow-on, not decided here — see open questions, §9).

## 2. The `mupot.runtime-session/v1` contract

Full field-by-field contract: [`docs/runtime-session-contract.md`](../../runtime-session-contract.md).
Machine-readable artifact: [`docs/runtime-session-v1.json`](../../runtime-session-v1.json).

Illustrative TypeScript sketch (matching `src/types.ts` conventions — **not
committed to `src/types.ts`**, this is a design illustration, no code lands
in this slice):

```ts
// Illustrative only — mupot.runtime-session/v1, see docs/runtime-session-contract.md
export interface RuntimeSessionObservation {
  schema: 'mupot.runtime-session/v1'
  tenant: string
  observation_id: string
  session_id: string | null // null on first observation; Mupot mints + echoes
  source_id: string
  worker_id?: string
  seq: number
  observed_at: string // RFC3339
  emitted_at: string // RFC3339

  adapter: string
  runtime: 'codex' | 'cursor' | 'claude-code' | 'hermes' | 'tmux' | 'dmux' | 'systemd-user' | 'python'
  agent_id: string | null
  identity_mapping: {
    status: 'unmapped' | 'mapped' | 'ambiguous' | 'revoked'
    mapped_agent_id?: string
    mapped_by_member_id?: string
    mapped_at?: string
    method?: string
  }
  context: { repo?: string; branch?: string; worktree_path?: string; host?: string; pid?: number }
  objective?: string
  linked: { task_id?: string; flight_id?: string; project_id?: string }
  owned_paths: string[]
  activity: { last_observed_at: string; last_signal_kind: string }
  liveness: {
    status: 'verified' | 'unverified' | 'unknown'
    verified_at?: string
    verified_by_method?: 'signed-attach' | 'bearer-checkin' | 'vendor-api-poll' | 'hmac-webhook'
  }
  state: {
    lifecycle: 'attaching' | 'active' | 'idle' | 'stale' | 'detached' | 'unavailable'
    health: 'ok' | 'degraded' | 'blocked' | 'unknown'
  }
  provenance: { source_target: string; adapter_version: string; observed_at: string }
  report: { summary?: string; validation_performed: string[]; artifacts: string[]; remaining_risks: string[] }
  source: { target: string; adapter_version: string }
}
```

## 3. Per-adapter mapping sketch

For each initial adapter: what maps to `activity`, what (if anything) maps to
`liveness`, and what is honestly not available.

### Codex / Codex App Server

- **Topology A (`codex exec` headless, per the BYOA matrix)**: `activity` =
  process stdout/JSON event stream and worktree file mtimes, captured by the
  conformant driver described in the BYOA design. `liveness` = the driver
  performing its own periodic signed attach (`fleet-attach:v1`) or
  `check_in` — this is `verified_by_method: "signed-attach"`, a Mupot-side
  cryptographic proof, not a Codex-side one.
- **Topology C (Codex App Server / Claude-Managed-Agents-equivalent,
  poll/SSE only per BYOA reality-check #4)**: if/when wired, `liveness` could
  additionally carry `verified_by_method: "vendor-api-poll"` — a live poll
  response from OpenAI's own control plane confirming the session exists.
  This is a **different trust root** than a Mupot-verified signed attach and
  must be labeled as such, never merged into the same "verified" bucket
  without the method tag.
- **Gap, stated honestly**: Codex Cloud's launch/poll API is not public today
  (BYOA reality-check #2, OpenAI issue #24777 open) — until it exists there is
  no independent Codex-side witness at all; only the driver's self-reported
  signed attach is available for Codex CLI. No adapter should claim more.

### Cursor

- **Topology A (`cursor-agent` CLI)**: same pattern as Codex CLI — `activity`
  from process output/worktree mtimes, `liveness` from the driver's own
  signed attach.
- **Topology C (Cursor Background Agents, beta)**: `activity` and `liveness`
  can both come from the vendor's HMAC-signed `statusChange` webhook —
  `verified_by_method: "hmac-webhook"` is a real cryptographic signal, not
  self-report.
- **Gap, stated honestly**: per BYOA reality-check #3/#5, the beta API
  version is unconfirmed and MCP-client support from the cloud agent back to
  Mupot is unconfirmed. Until verified, Cursor Cloud observations should be
  treated as webhook-status-only with no MCP-tool-call breadcrumb trail —
  thinner evidence than Codex-CLI or Claude Code, and the design should not
  invent a stronger signal than what's documented as live.

### Claude Code

- This is the harness this very design doc is being written in. `activity` =
  MCP tool calls landing on Mupot's own MCP server (`task_list`,
  `task_update`, `send`, etc.), timestamped **server-side** — this is
  actually the strongest activity signal of the five because it's Mupot's
  own request log, not a self-report relayed through an intermediary.
  `liveness` = the existing signed/bearer attach + debounced `check_in`
  (`docs/runtime-adapter-contract.md` §Heartbeat And Presence, already
  built) — `verified_by_method: "bearer-checkin"` or `"signed-attach"`.
- **Gap, stated honestly**: Claude Desktop (topology B, human-driven,
  GUI-only) is explicitly de-scoped by the BYOA design ("not a governable
  dispatch target") — there is no session observation for a human using
  Claude Desktop against Mupot's MCP; this design keeps that non-goal.

### Hermes

- `activity` = Telegram update intents hitting `/im/webhook`
  (`docs/runtime-adapter-contract.md` §Hermes IM Task Lifecycle),
  timestamped server-side on receipt.
- `liveness` = the same webhook receipt (Telegram's delivery infrastructure
  is the third-party witness that the message arrived) **or**, when Hermes
  itself also holds an agent-bound token, its own `check_in`.
- **Gap, stated honestly**: Hermes activity is very often a *human's*
  message relayed through the bot, not evidence the Hermes *process* itself
  is healthy. This design does not conflate "a human sent something through
  Hermes" with "the Hermes runtime is alive" — the two must stay in separate
  `activity.last_signal_kind` values so a reader isn't misled.

### tmux / dmux

- This is the exact runtime kind in the 2026-07-27 incident. `activity` =
  pane presence / last-output timestamp, self-reported by a host-local daemon
  (the existing `fleet-runtime/inbox-handler.mjs` pattern), keyed by the tmux
  session name as the natural `source_id` (e.g. `tmux:kasra`, `tmux:mumcp`).
- **`liveness` is honestly close to nothing at the tmux layer itself.** tmux
  provides no cryptographic proof of anything — it is a terminal multiplexer,
  not an identity system. The only real liveness proof available is from the
  **harness running inside the pane** (e.g. Claude Code CLI performing its
  own signed attach). This is a deliberate and useful separation: tmux/dmux
  supplies `source_id` + `host` + `pid` (the "which concurrent instance"
  answer); the inner harness supplies `liveness` (the "is it actually alive"
  answer). A tmux-only adapter with no inner harness attach should report
  `liveness.status: "unverified"` and never upgrade it on activity alone —
  this is precisely the discipline that was missing on 2026-07-27.

## 4. State ownership boundary

**Authoritative in Mupot D1/Durable Objects (adapters may read, never
write):**

| Concern | Table(s) |
|---|---|
| Identity, capabilities | `agents`, `agent_member_bindings` (`0071`, update-forbidden by trigger), capability grants |
| Squads, room events | `squads` (`0001`), `agent_messages` |
| Tasks, `done_when` | `tasks` (`0001`+`0026`+…), transition matrix in `docs/runtime-adapter-contract.md` |
| Delivery, wake, ACKs | `task_dispatch_receipts` (`0047`) |
| Flights | `flights` (`0017`) |
| Handoffs / evidence references | `project_link_receipts` (`0057`), `tasks.github_issue_url`, `github_prs_merged` (`0038`) |
| Gate ownership, verdicts, receipts | `tasks.gate_owner`, `task_verdicts` (`0007`, append-only, no UPDATE/DELETE path) |
| Project structure | `projects`, `project_squad_access` (`0055`) |

**New in this design, adapter-observation-owned (idempotent publish only):**

| Table (illustrative name) | Owns |
|---|---|
| `runtime_sessions` | Latest-projection row per `session_id`: `agent_id` (nullable), `adapter`, `runtime`, `source_id`, `host`, `first_seen_at`, `last_seen_at`, current `lifecycle`/`health` — all **derived from the newest accepted observation by `seq`**, never independently editable |
| `runtime_session_observations` | Append-only log, one row per accepted `observation_id`, the full envelope+body from §2 |
| `runtime_session_identity_map` | Pending/mapped/rejected queue for unmapped external identities — the "Unmapped runtimes" surface from Hadi's brief |

**The concrete disallowed action, to make the boundary unambiguous to a
future implementer:**

> An adapter publishing a `mupot.runtime-session/v1` observation whose
> `report.summary` says "task complete, all tests green" **cannot** set
> `tasks.status = 'done'` and **cannot** insert a `task_verdicts` row. Only
> Mupot's own task service (`task_update` with a valid transition, or the
> dedicated verdict endpoint) can change `tasks.status` or append a verdict.
> The observation's `report` fields are stored as evidence attached to the
> *session*, and a human or the task's own `task_update` call may later cite
> that evidence when actually transitioning the task — but the transition
> itself is a separate, authorized action through the existing task surface,
> never a side effect of accepting an observation.

The same boundary applies identically to gate verdicts (`task_verdicts`),
membership (`agent_member_bindings`, immutable by trigger already), and
capability grants: an observation is data about what an adapter *saw*, never
an instruction Mupot executes.

## 5. Read-model join sketch

```
agents (authoritative identity)
   │ 1:N (read-time rollup, no mutable "current session" column on agents)
   ▼
runtime_sessions (session_id PK, agent_id nullable FK, adapter, runtime,
                   source_id, host, latest lifecycle/health projection)
   │ 1:N append-only
   ▼
runtime_session_observations (observation_id PK, session_id FK, seq,
                                observed_at, full payload incl. linked.*)
   │
   ├── linked.task_id ──► tasks ──► squads ──► project_squad_access ──► projects
   │                         │
   │                         ├──► task_dispatch_receipts   (delivery/wake/ACK evidence)
   │                         ├──► task_verdicts            (gate receipts, read-only join)
   │                         └──► tasks.github_issue_url /
   │                              project_link_receipts    (GitHub / cross-pot evidence)
   │
   ├── linked.flight_id ──► flights
   │
   └── (unmapped) ──► runtime_session_identity_map (pending/mapped/rejected queue)

agent_member_bindings (agent_id → member_id, immutable) joins alongside
agents wherever a human-facing "who" is needed.
```

**Concrete read query shape** for the Project "Live teammates" view from
Hadi's 2026-07-27 delivery brief:

```
SELECT rs.session_id, rs.agent_id, a.name, rs.adapter, rs.runtime,
       rs.source_id, rs.host, latest_obs.liveness_status,
       latest_obs.lifecycle, latest_obs.health, latest_obs.objective,
       t.id AS task_id, t.status AS task_status, tv.verdict AS latest_verdict,
       tdr.claimed_at, tdr.consumed_at
FROM runtime_sessions rs
JOIN agents a ON a.id = rs.agent_id
LEFT JOIN <latest observation per session, by seq> latest_obs ON ...
LEFT JOIN tasks t ON t.id = latest_obs.linked_task_id
LEFT JOIN task_verdicts tv ON tv.task_id = t.id            -- latest by decided_at
LEFT JOIN task_dispatch_receipts tdr ON tdr.task_id = t.id  -- latest by created_at
WHERE t.squad_id IN (
  SELECT squad_id FROM project_squad_access WHERE project_id = :project_id
)
   OR latest_obs.linked_project_id = :project_id
```

This directly answers the Done-bar question from Hadi's brief: *who, through
which runtime, on what mission, last verified alive when, delivered what,
blocked on what, needs what human decision* — every column above maps to one
clause of that sentence, and every join target is already an existing,
authoritative table. Nothing here requires a new "Project members" table
(confirmed not to exist; Project access is squad-based via
`project_squad_access`, per the grounding research) — session-to-project
attribution reuses that existing squad-access check, the same way `tasks`
and `flights` already validate `project_id` today.

## 6. Test plan

| Test | One-line description |
|---|---|
| `malformed_envelope_rejected` | Missing/wrong-typed `schema`, `tenant`, `observation_id`, or `seq` → `bad_request`, no row written |
| `oversized_payload_rejected` | Observation body exceeding the route byte cap → `payload_too_large`, matching `runtime-adapter/v1` precedent |
| `first_observation_mints_session` | First accepted observation for a new `(tenant, adapter, source_id)` gets a fresh `session_id` minted and returned |
| `reattach_reuses_session` | A second observation with the same `(tenant, adapter, source_id)` and no prior detach reuses the existing `session_id`, does not mint a duplicate |
| `identical_replay_is_noop` | Same `observation_id` + identical payload retried → accepted as duplicate, no new row, no error |
| `conflicting_replay_rejected` | Same `observation_id` + different payload → `observation_conflict` |
| `out_of_order_seq_does_not_regress_projection` | An observation with `seq` lower than the session's current `seq` is stored in the append-only log but does not overwrite `runtime_sessions`' latest-state projection |
| `stale_session_flagged_not_silently_dropped` | A session with no observation past its adapter-declared TTL surfaces `lifecycle: "stale"` in reads, never silently vanishes from the roster |
| `activity_never_implies_liveness` | An observation with fresh `activity.last_observed_at` and `liveness.status: "unverified"` is stored and read back with both fields intact — no code path upgrades liveness from activity |
| `session_agent_mismatch_refused` | An observation echoing a `session_id` that belongs to a different `agent_id` than the caller's authenticated identity resolves to → `session_agent_mismatch`, rejected |
| `unmapped_identity_queued_not_autobound` | An observation with no resolvable `agent_id` is stored and appears only in `runtime_session_identity_map` as `pending`, never auto-creates or auto-binds an agent |
| `ambiguous_mapping_flagged` | An external identity that could plausibly match more than one agent surfaces `identity_mapping.status: "ambiguous"`, requires an explicit human/admin resolution, never a guessed bind |
| `mapping_change_requires_authorization_and_receipt` | Resolving a pending mapping requires current Mupot authorization on the target agent and produces an auditable receipt row |
| `revocation_race_does_not_leave_zombie_mapping` | Revoking an agent's capability/membership concurrently with an in-flight mapping resolution does not leave a session mapped to a now-unauthorized agent |
| `cross_tenant_isolation` | An observation whose authenticated token's tenant differs from its own `tenant` field is refused (`cross_tenant_denied`); no cross-tenant session or observation is ever readable |
| `adapter_cannot_mutate_task_status` | A crafted observation with `report.summary` implying completion never changes `tasks.status`; only `task_update`/verdict endpoints do — proven by asserting the task row is byte-identical before/after accepting the observation |
| `adapter_cannot_mutate_gate_verdict` | Same proof for `task_verdicts` — no verdict row is ever inserted as a side effect of an observation |
| `adapter_cannot_mutate_membership_or_capabilities` | Same proof for `agent_member_bindings` and capability grants |
| `stale_reference_dropped_not_trusted` | An observation whose `linked.task_id`/`flight_id` does not resolve, or is not visible to the mapped agent, is stored with that field dropped and flagged `stale_reference`, never trusted blind into the read model |
| `adapter_outage_core_project_view_still_available` | With the runtime-session ingest path fully down (simulated), the core Project view (squads, tasks, flights, verdicts) still renders correctly — the new surface degrades gracefully, never becomes a hard dependency |
| `dashboard_rest_mcp_parity` | The same session/observation state is visible and consistent across the dashboard read, a REST read, and an MCP read (three transports, one truth) |

## 7. Demo plan

**Recommended minimum pair: Claude Code (topology A/B, MCP-native, already
live) + tmux/dmux (the exact incident runtime).** Rationale: Claude Code
already has the strongest available `liveness` signal (server-side MCP call
timestamps + existing signed/bearer attach, nothing new to build for that
half) and is the harness this very design is being authored in, so the
adapter can be validated against its own live traffic first. tmux/dmux is
the runtime kind from the real incident that motivated this issue, so
demonstrating it directly closes the reported gap rather than a
hypothetical one. Codex CLI is the second-best candidate (per the BYOA
matrix, the most fully-verified topology-A harness) and should be the
**next** adapter built, satisfying the acceptance criterion "Codex plus at
least one non-OpenAI runtime" once both are live — but it is not required
for the first demo since Claude Code + tmux already proves the core claim
(one canonical agent, two concurrent sessions, distinguishable) without
waiting on a second adapter build.

**Demo steps:**

1. Open one Claude Code session against a Mupot project task (`task_id A`),
   let it perform a normal MCP `task_list`/`task_update` cycle — this
   publishes `mupot.runtime-session/v1` observations with
   `adapter: "claude-code-mcp-v1"`, `source_id` = that session's own
   connection id, `liveness.status: "verified"` from the existing bearer
   check-in.
2. In parallel, open a second, distinct tmux pane running a different
   harness process against a *different* task (`task_id B`) under the
   **same canonical agent identity** — mirroring the actual 2026-07-27
   incident's shape (one agent, two concurrent runtimes, two objectives).
3. Open the Project detail view (or the read-model query from §5 run
   directly) and show: one agent row, two session rows underneath it, each
   with its own `source_id`, `objective`, `task_id`, `liveness`, and
   `activity` — no contradiction, no last-write-wins collapse.
4. Kill the tmux pane's inner harness process without a clean detach; show
   that session's `lifecycle` degrade to `stale` (query-time derived, no
   cron needed, matching the existing `module_registry` staleness pattern)
   while the Claude Code session's row is unaffected.
5. Show the join to `task_dispatch_receipts`/`task_verdicts` for `task_id A`
   proving the read model answers "delivered what, blocked on what, needs
   what human decision" from the same view, without opening tmux or SOS —
   the literal Done-bar from Hadi's brief.

## 8. Walking the 2026-07-27 incident through this schema

Given the real incident text on the issue: tmux sessions `kasra` and `mumcp`
both emitted SOS bus replies as `agent:kasra`.

**Session A (the `kasra` tmux pane, PR-579 gate reviewer):**

- `agent_id`: the one canonical Mupot row for the "kasra" agent
- `session_id`: freshly minted on first observation, e.g. `sess_8f2a…`
  (opaque, Mupot-generated, immutable for that pane's lifetime)
- `adapter`: `"tmux-claude-code-v1"` (or whichever adapter implementation
  wraps that pane's inner harness)
- `runtime`: `"tmux"`
- `source_id`: `"tmux:kasra"` (or host-qualified, e.g.
  `"ubuntu-16gb-ash-1:tmux:kasra"`, if two hosts could otherwise collide on
  a bare pane name)
- `linked.task_id`: the PR-579 round-6 gate review task
- `objective`: `"independent round-6 gate review, Mupot PR #579"`
- `liveness`: `verified`, `verified_by_method: "bearer-checkin"` (the inner
  Claude Code harness's own check-in), distinct from the tmux layer's mere
  pane-activity signal

**Session B (the `mumcp` tmux pane, mcpwp branch owner):**

- `agent_id`: **the same canonical Mupot "kasra" row** — this is the whole
  point; one identity, two sessions
- `session_id`: a **different** freshly minted id, e.g. `sess_c114…`
- `adapter`: `"tmux-claude-code-v1"` (same adapter implementation, different
  instance)
- `runtime`: `"tmux"`
- `source_id`: `"tmux:mumcp"` — a different pane name, hence a different
  dedupe key, hence a different `session_id`
- `linked.task_id`: the `Mumega-com/mcpwp` `feat/seo-market-data` task
- `objective`: `"Tasks 4-5, feat/seo-market-data, commit 0937744"`
- `liveness`: independently verified through that pane's own inner harness
  check-in, unrelated to Session A's

**Read model presentation:** the agent-level view for "kasra" shows **two
open sessions**, each with its own objective, task link, and liveness — not
one contradictory status. A reader asking "is kasra working on PR-579 or on
feat/seo-market-data" gets the correct answer: **both, in two separate,
individually verifiable sessions**, exactly the outcome Hadi's 2026-07-27
comment specifies ("Activity, heartbeat, task ownership, and handoff
receipts attach to the session and then roll up to the agent"). No schema
change to `agents` or `agent_member_bindings` was needed to represent this —
the entire fix lives in the new session layer sitting above the existing,
untouched identity invariant.

## 9. SOS `check_in` interface boundary (noted, not designed here)

SOS's own `check_in` MCP tool's `inputSchema` today only declares `model` and
`summary` — no node/thread/session-identifying field exists at all, so
nothing can be passed in today to let an SOS-side caller disambiguate
concurrent sessions of the same agent. This is exactly why the 2026-07-27
incident was invisible to SOS itself: SOS has no field to carry a
`source_id` even if a caller wanted to supply one.

Under #473, SOS is being retired as the fleet coordination substrate and
would only ever participate here as **one optional, temporary, read-only
observation adapter** (per Hadi's 2026-07-27 brief: "SOS is permitted only as
a temporary, optional, read-only observation adapter during migration under
#473"). Given that, this design's `mupot.runtime-session/v1` `source_id`
field is defined generically enough to accept whatever an SOS-import adapter
can supply — but until SOS's own `check_in` schema gains a real
session/thread-identifying field, an SOS-import adapter **cannot itself
distinguish two concurrent SOS sessions of the same agent** any better than
SOS can today. It would have to either (a) synthesize a `source_id` from
connection-layer metadata available to the *bridge* process rather than the
`check_in` payload itself (e.g. the bus connection socket, if the bridge has
visibility into it), which is a partial, best-effort mitigation, or (b) fall
back to a single bucket that itself surfaces as `identity_mapping.status:
"ambiguous"` when two truly-concurrent SOS-origin observations can't be told
apart — which is an honest degraded state, not a silent merge.

**This design does not fix SOS's `check_in` schema** — that is a different
repo/surface and explicitly out of scope here. It only notes the boundary so
a future SOS-side change knows exactly what field shape
`mupot.runtime-session/v1` would consume if/when SOS adds one: a stable,
adapter-supplied `source_id` string, mirroring the field this contract
already defines for every other adapter.

## 10. Acceptance criteria — explicit mapping

| # | Acceptance criterion (from #544) | Addressed by |
|---|---|---|
| 1 | `mupot.runtime-session/v1` schema documented, versioned, strictly validated | §2 + `docs/runtime-session-contract.md` (full field table, version/status header) + `docs/runtime-session-v1.json` (machine-readable artifact); "strictly validated" = the error taxonomy in the contract doc (`bad_request`, `observation_conflict`, `session_agent_mismatch`, etc.) plus the malformed/oversized test cases in §6 |
| 2 | Activity and verified liveness represented separately | §2 field table (`activity` vs `liveness`, distinct sub-objects, `liveness.verified_by_method` making the proof mechanism explicit); reinforced per-adapter in §3 (tmux section is the sharpest example) and tested by `activity_never_implies_liveness` in §6 |
| 3 | Every observation includes source, adapter version, timestamp, idempotency identity | §2 envelope table: `source.target`+`source.adapter_version` (also mirrored in `provenance`), `observed_at`/`emitted_at`, `observation_id` |
| 4 | Codex plus at least one non-OpenAI runtime produce conforming snapshots | §7 demo plan recommends Claude Code + tmux/dmux as the first pair (both non-OpenAI, proves the core mechanism fastest) and names Codex CLI as the required next adapter to satisfy this exact criterion once both are live — §3 gives Codex's own mapping sketch so that adapter's build is already scoped |
| 5 | Unknown, stale, unavailable, degraded states distinguishable | §2 `state.lifecycle` (`attaching/active/idle/stale/detached/unavailable`) and `state.health` (`ok/degraded/blocked/unknown`) as two orthogonal enums, not one collapsed status; tested by `stale_session_flagged_not_silently_dropped` |
| 6 | Adapters cannot mutate task completion, gate verdicts, membership, or capabilities | §4 state-ownership boundary with the concrete disallowed-action example, plus `invariants.adapterCannotMutate` in the JSON artifact, plus four dedicated tests in §6 (`adapter_cannot_mutate_task_status`, `_gate_verdict`, `_membership_or_capabilities`) |
| 7 | A read model can join session observations to squad/task/flight/handoff/GitHub-evidence/gate-receipts | §5 join sketch, with the concrete SQL-shape query for the Project "Live teammates" view, joining through `tasks`→`squads`→`project_squad_access`, `task_dispatch_receipts`, `task_verdicts`, `flights`, and `project_link_receipts`/`github_issue_url` |
| 8 | Tests cover malformed snapshots, stale observations, replay/idempotency, cross-tenant isolation, adapter failure | §6 full table — `malformed_envelope_rejected`/`oversized_payload_rejected` (malformed), `stale_session_flagged_not_silently_dropped`/`out_of_order_seq_does_not_regress_projection` (stale/out-of-order), `identical_replay_is_noop`/`conflicting_replay_rejected` (replay/idempotency), `cross_tenant_isolation` (cross-tenant), `adapter_outage_core_project_view_still_available` (adapter failure) |
| 9 | A demo shows one Codex worker and one non-Codex worker visible against the same Mupot task | §7 demo plan — steps 1-3 show two concurrent sessions (recommended pair: Claude Code + tmux for the first demo) against two related tasks under one agent; the same steps generalize directly to a Codex-CLI-adapter + Claude-Code pairing against one shared task once the Codex adapter (named as the required next build in §7) lands |

## 11. Open questions (left for review, not decided unilaterally)

1. **Should `module_registry`/`fleet_agents`/`presence` eventually become
   query-time projections *over* `runtime_sessions`, or stay independent
   caches indefinitely?** This design deliberately does not touch those
   three existing tables — they keep working exactly as today. Collapsing
   them into a session-derived view would remove a second source of
   agent-level truth but is a larger, separate migration with its own
   backward-compatibility surface (existing dashboard/radar-view readers).
   Recommend deciding this only after the first adapter pair (§7) is live
   and the join pattern in §5 has been used in anger.
2. **Exact `session_id` retirement/TTL policy.** The contract says a session
   goes `stale` when it misses its adapter-declared TTL and is "retired, not
   deleted" — but the precise TTL default, whether it's adapter-configurable
   or contract-fixed, and whether a retired session's row is ever purged (vs.
   kept forever as history) is not decided here. Recommend borrowing the
   existing `module_registry` "stale reads as offline, no cron sweep"
   discipline as the default, but this should be confirmed against expected
   observation volume before implementation.
3. **Where the `runtime_session_identity_map` "Unmapped runtimes" queue
   surfaces in the dashboard**, and what capability level is required to
   resolve a pending mapping — this design assumes "current Mupot
   authorization on the target agent" per Hadi's brief but does not pin the
   exact capability (e.g. `admin` on the agent's squad vs. a dedicated
   platform-level capability). Needs an explicit call before the mapping-
   resolution route is built.
4. **Whether `worker_id` sees any real adapter usage in the first two
   adapters.** Claude Code's own subagent fan-out (this very session spawned
   a research subagent) is arguably a first candidate for populating
   `worker_id`, but this design leaves it optional and unused in the initial
   build to avoid speculative complexity — flagged for review rather than
   assumed necessary.
5. **The SOS-import adapter's best-effort `source_id` synthesis (§9,
   option a)** — whether the SOS bridge process actually has access to
   per-connection metadata sufficient to synthesize a stable `source_id`
   without a SOS-side schema change is unverified; this design assumes it
   might not, and treats the degraded "ambiguous" bucket (option b) as the
   safe default, but a concrete look at the SOS bridge's connection handling
   would resolve this rather than assuming the worse case.
