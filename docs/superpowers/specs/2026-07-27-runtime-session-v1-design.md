# Canonical Runtime Sessions and Cross-Harness Adapters — Design

**Status:** Design, drafted 2026-07-27. Design/spec only — no implementation
code, no migration, no route. Awaiting dyad-gate (Kasra-core correctness +
diverse cross-vendor review) before any build slice starts.

**Revision (2026-07-27, same day, additive):** incorporates the boundary
clarification posted on #544
([issue comment](https://github.com/Mumega-com/mupot/issues/544#issuecomment-5087743126)):
SOS as an explicit **coordination-event adapter** (§3, new subsection,
distinct in kind from the five liveness-oriented adapters), an explicit
two-layer Project Situation presentation (§5, new subsection), and an
updated acceptance criterion + demo phase (§7, §10 row 10). Section numbering
is preserved — all additions are new `###`-level subsections or table rows,
nothing renumbered.

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
   fleet coordination substrate and SOS is being retired. Per the 2026-07-27
   boundary-clarification comment on #544, SOS also gets its own dedicated
   **coordination-event** adapter subsection (§3, "SOS Bus — coordination-
   event adapter") — distinct in *kind* from the five liveness-oriented
   adapters above it, because it projects discrete point-in-time events
   (delivery, ACK, gate result, …), not continuous session liveness. It
   remains explicitly the weakest-signal, non-authoritative adapter in this
   design (§5's two-layer presentation makes that boundary structural, not
   just prose).
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
  runtime: 'codex' | 'cursor' | 'claude-code' | 'hermes' | 'tmux' | 'dmux' | 'systemd-user' | 'python' | 'sos-bus'
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

### SOS Bus — coordination-event adapter (distinct in kind)

**This adapter is a different shape than the five above.** Codex, Cursor,
Claude Code, Hermes (IM), and tmux/dmux all project *continuous* worker
state — a session that is `active`/`idle`/`stale`, with an `activity` signal
that ticks roughly continuously while the harness runs. The SOS Bus adapter
instead projects **discrete coordination events** — point-in-time facts about
message traffic on the legacy SOS bus (per #473, being retired as the fleet
substrate; this adapter exists only "for the current Mumega deployment," per
the 2026-07-27 boundary-clarification comment on #544). It reuses the exact
same `mupot.runtime-session/v1` envelope and identity model (§2, "Identity
model" in `docs/runtime-session-contract.md`) — no new identity concept, no
new table. What differs is only *how* the six event kinds populate that one
shared shape, and the fact that a given SOS message produces exactly one
observation, not a ticking stream of them.

**Adapter id:** `sos-bus-event-v1`. **`runtime`:** `"sos-bus"` (new value
appended to the existing enum — additive, per the contract's own "additive
fields may be accepted" policy in `docs/runtime-session-contract.md` §Version).
**`source.target`:** `"sos-bus"` (already listed as the illustrative example
in the contract's `provenance.source_target` field, unchanged here — this
revision just gives it a concrete adapter to back it).

**Event-kind mapping** (the six kinds from the boundary-clarification
comment, each captured as `activity.last_signal_kind`):

| SOS event kind | `activity.last_signal_kind` | `observation_id` pattern | Notes |
|---|---|---|---|
| Delivery + durable stream receipt | `sos-delivery-receipt` | adapter-assigned, one per delivered bus message | Evidence a message reached a durable stream — not evidence about who sent it or that they're alive |
| Wake / check-in attempt | `sos-wake-checkin` | adapter-assigned, one per `check_in` call observed on the bus | Mirrors SOS's own `check_in` MCP tool call; still self-reported (§9 already notes `check_in`'s `inputSchema` carries no session-identifying field) |
| Request/ACK correlation | `sos-request-ack` (request half) / `sos-request-ack` (ack half) | **reuses the existing agent-comms `[request_id:<uuid>]` convention** (`~/.claude/rules/agent-comms.md` § ACK protocol) as the correlation key: the request-sent observation's `observation_id` **is** that `request_id`; the paired ack-received observation's `observation_id` is `{request_id}:ack` | No new correlation field invented — the request/ACK pairing already has a stable UUID in this codebase's convention, so it is reused as-is |
| Progress heartbeat | `sos-progress-heartbeat` | adapter-assigned, one per heartbeat message | Activity only; never upgrades `liveness` (see below) |
| Blocker or handoff | `sos-blocker-handoff` | adapter-assigned, one per blocker/handoff message | Populates `report.summary`/`report.remaining_risks` as evidence attached to the session — same non-mutating rule as every other adapter's `report` (§4) |
| Exact-head gate result + proof URL | `sos-gate-result` | adapter-assigned, one per gate-result message | `report.artifacts` = `[proof URL]`, `report.summary` = the verdict text as reported over the bus. **This is the sharpest instance of the §4 boundary in the whole design**: however final this looks, it cannot itself write a `task_verdicts` row — only a human or the dedicated verdict endpoint can, citing this observation's `report.artifacts` URL as evidence it consulted |

**Session/source attachment.** Per §9 (already in this design, unchanged),
SOS's own `check_in` schema carries no session-identifying field today, so
this adapter can only synthesize a best-effort `source_id` from
connection-layer metadata the bridge itself has visibility into — e.g. the
bus stream key, in the exact form this repo's own agents already use it:
`sos:stream:project:sos:agent:kasra`. **That string is a routing label, not
proof of identity** — it is exactly the kind of "SOS sender label" the
boundary-clarification comment says is a "routing/provenance input only."
Every SOS-Bus observation is therefore minted a `session_id` (session minting
is independent of identity mapping — a session can and often will exist with
`agent_id: null`) but its `identity_mapping.status` starts at `"unmapped"`
and stays there **unless** an admin has previously created an explicit,
verified mapping entry in `runtime_session_identity_map` binding that exact
stream key to a canonical `agent_id` (the same mechanism §4 already defines
for every other adapter — nothing new). Two consequences fall directly out
of reusing that existing mechanism, not inventing a new one:

- **A message whose bus sender label says `agent:kasra` does not, by itself,
  bind to the canonical `kasra` agent.** It is stored with
  `identity_mapping.status: "unmapped"` like any other unrecognized runtime
  until an explicit mapping exists — the same discipline already proven for
  tmux pane names and Cursor background-agent ids.
- **An observation from a genuinely unrecognized SOS sender** (no stream key
  ever previously mapped, ambiguous, or revoked) is stored and surfaces
  **only** in the "Unmapped runtimes" queue (§4's
  `runtime_session_identity_map`), exactly like every other adapter's stray
  identity — never auto-bound, never silently attributed to a guessed agent.
  This is the literal mechanism the acceptance addition in §10 row 10 means
  by "an unknown sender kept unmapped."

**Liveness, stated honestly.** `liveness.status` defaults to `"unverified"`
for all six event kinds. SOS provides no independent, cryptographic proof
that the labeled sender is who it claims — per §1 point 6, this is
deliberately "the weakest-signal adapter in this design, not the reference
one," and this revision does not invent a stronger liveness proof for it.
The one thing this adapter *can* honestly claim is "this event was recorded
on the bus at this time" (`activity`), never "the session/agent is alive"
(`liveness`) — the same `activity`-never-implies-`liveness` discipline as
every other adapter (tested by `activity_never_implies_liveness`, §6),
applied here to its sharpest case: a `sos-gate-result` event can carry a
very convincing-looking verdict and still never upgrade `liveness` or write
a real verdict row.

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

### Two-layer presentation: authoritative Mupot state vs. runtime observations

Per the 2026-07-27 boundary-clarification comment on #544, the Project
Situation view must present two layers **without conflating them** — not
merged into one ambiguous status blob. This is the same join above, but
split at the API/UI boundary into two structurally separate response
sections, each sourced from a disjoint set of tables:

- **Layer 1 — authoritative Mupot state.** Sourced **only** from the
  existing D1 tables already listed in §4's ownership table: `agents`
  (identity/capabilities), `squads`/`project_squad_access` (squad), `tasks`/
  `flights` (task/flight), `tasks.status` transitions (completion),
  `task_verdicts` (gate), `task_dispatch_receipts`/`project_link_receipts`/
  `github_prs_merged` (evidence). **Never** reads `runtime_sessions`,
  `runtime_session_observations`, or `runtime_session_identity_map` to
  populate this layer — an adapter observation can never leak into what this
  layer reports, by construction, not by convention.
- **Layer 2 — runtime observations.** Sourced **only** from the new tables
  this design defines (§4's second table): `runtime_sessions` (session/
  source, harness, observed activity, verified liveness, current objective,
  lifecycle/health as "adapter health"), `runtime_session_observations`
  (ACK/handoff, exact commit, timestamp, freshness — the newest accepted
  observation per session), and `runtime_session_identity_map` (the
  Unmapped runtimes queue). **Never** treated as authoritative for, or
  capable of mutating, anything in Layer 1 — this is the same non-mutation
  invariant from §4, restated here as a presentation-layer rule rather than
  a storage-layer one.

**Concrete response shape** (illustrative, matching the query in §5 above —
not committed code):

```jsonc
// GET /api/projects/:project_id/situation — illustrative response shape
{
  "project_id": "proj_...",
  "authoritative": {                      // Layer 1 — D1 only, never adapter-derived
    "agents": [
      { "agent_id": "kasra", "name": "Kasra", "capabilities": ["build"], "squad_id": "..." }
    ],
    "tasks": [
      { "task_id": "t_579", "status": "in_review", "flight_id": "fl_...", "gate_owner": "kasra-review" }
    ],
    "gates": [
      { "task_id": "t_579", "verdict": "pending", "decided_at": null, "decided_by": null }
    ],
    "evidence": [
      { "task_id": "t_579", "github_pr_url": "https://github.com/Mumega-com/mupot/pull/579" }
    ]
  },
  "runtime_observations": {               // Layer 2 — runtime_session* only, never authoritative
    "sessions": [
      {
        "session_id": "sess_8f2a...",
        "agent_id": "kasra",              // null if unmapped
        "adapter": "tmux-claude-code-v1",
        "runtime": "tmux",
        "source_id": "tmux:kasra",
        "harness": "claude-code",
        "objective": "independent round-6 gate review, Mupot PR #579",
        "linked": { "task_id": "t_579" },
        "activity": { "last_observed_at": "...", "last_signal_kind": "..." },
        "liveness": { "status": "verified", "verified_by_method": "bearer-checkin" },
        "state": { "lifecycle": "active", "health": "ok" },
        "adapter_health": "ok"
      }
    ],
    "unmapped": [
      { "session_id": "sess_c9d0...", "source_id": "sos:stream:project:sos:agent:unknown42", "adapter": "sos-bus-event-v1", "last_observed_at": "..." }
    ]
  }
}
```

**UI sketch:** two visually distinct panels in the Project detail view, never
one merged status pill — a "Mupot State" panel (gate/verdict badges,
task/flight status, squad membership — Layer 1) and a separately labeled
"Runtime Activity — observed, not authoritative" panel below or beside it
(session rows, adapter health, freshness ticker, an "Unmapped runtimes"
sub-list — Layer 2). The label on the second panel is load-bearing: it must
read as *observed*, not as a second source of truth.

This is precisely the fix for the incident walked through in §8: the
`kasra` agent-level identity row (Layer 1 — one row, unambiguous) is never
blended with its two divergent session objectives (Layer 2 — two rows,
individually verifiable) into one contradictory status string. §8's
"Read model presentation" paragraph already describes the *content* of this
split; this subsection makes the split *structural* — a UI/API contract, not
just a query pattern a future implementer might collapse back together.

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
| `sos_sender_label_alone_does_not_bind` | An SOS-Bus observation whose bus sender label matches an existing canonical `agent_id` string (e.g. `"kasra"`) but has no prior verified mapping entry is stored with `identity_mapping.status: "unmapped"`, `agent_id: null` — label match alone never binds |
| `sos_unrecognized_sender_surfaces_only_in_unmapped_queue` | An SOS-Bus observation from a stream key never seen before is stored and appears **only** in `runtime_session_identity_map` as `pending`, exactly like `unmapped_identity_queued_not_autobound`, applied to the SOS adapter specifically |
| `sos_gate_result_report_cannot_write_verdict` | A `sos-gate-result` observation with a convincing `report.summary`/`report.artifacts` proof URL never inserts a `task_verdicts` row and never changes `tasks.status` — proven the same way as `adapter_cannot_mutate_gate_verdict`, with the SOS gate-result event as the specific crafted input |
| `sos_request_ack_pairing_uses_existing_request_id` | A request-sent and its paired ack-received observation, both referencing the same agent-comms `request_id` UUID (per `sos-request-ack` in §3), are stored as two distinct `observation_id`s (`{request_id}` and `{request_id}:ack`) without any new correlation field or table |
| `layer_1_query_never_reads_runtime_session_tables` | The Layer 1 ("authoritative") query path (§5's two-layer subsection) contains no join to `runtime_sessions`/`runtime_session_observations`/`runtime_session_identity_map` — proven by query-shape assertion, not just by convention |

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

### Demo phase 2 — the 2026-07-27 acceptance addition (Codex + SOS, same task)

The boundary-clarification comment adds a **stricter, additional** acceptance
criterion (§10 row 10): "demonstrate Codex and one non-Codex runtime working
the same Project task, with SOS-derived delivery/ACK visible, an unknown
sender kept unmapped, and neither adapter able to complete a task or approve
its own gate." Phase 1 above does not satisfy this as written — it uses
Claude Code + tmux (neither is Codex) and two *different* tasks by design
(proving session multiplicity, not shared-task collaboration). Rather than
leaving the two demo phases unconnected, this revision adds **SOS as a
third adapter in the same phase-2 scenario**, not a standalone demo, because
the criterion's own wording bundles "same task" + "SOS-derived evidence" +
"unmapped sender" into one storyline:

1. Reuse `task_id A` from phase 1 (already has a Claude Code session
   attached with `liveness.status: "verified"`).
2. Bring up the Codex CLI adapter (`codex-cli-driver-v1`, named as the
   required next build in the original §7/§10) against the **same**
   `task_id A` — its own signed-attach `check_in`, per §3's Codex mapping
   sketch. The Project Situation view (§5's two-layer subsection) now shows
   Layer 2 with **two** session rows under `linked.task_id: task_id A`: one
   `claude-code`, one `codex`, each independently verified.
3. Have the SOS-Bus adapter (§3, new subsection) observe the same task's
   coordination traffic — a `sos-delivery-receipt` when a task-related bus
   message lands, and a `sos-request-ack` pair (request + `{request_id}:ack`)
   for one exchange about `task_id A`. Show these appear in Layer 2 as
   `agent_id: null`-eligible, `liveness.status: "unverified"` rows unless a
   prior mapping exists — i.e. *visible*, exactly as the criterion demands,
   without being conflated with either verified session's liveness.
4. Send one SOS-Bus message from a stream key that has **never** been
   mapped to any canonical agent. Show it lands only in the "Unmapped
   runtimes" queue (`runtime_session_identity_map`, Layer 2's `unmapped`
   list in the response shape above) — never auto-bound, never shown as a
   third "teammate" on the task.
5. Attempt (as a proof, not a real action) to have either the Codex or the
   SOS observation's `report.summary` claim task completion / gate approval.
   Show neither can: `tasks.status` and `task_verdicts` are byte-identical
   before and after, per the existing `adapter_cannot_mutate_task_status`/
   `_gate_verdict` tests (§6) and the new `sos_gate_result_report_cannot_write_verdict`
   test — satisfying "neither adapter able to complete a task or approve its
   own gate" for both adapters in the same run.

This reuses phase 1's already-open Claude Code session as the "one
non-Codex runtime" rather than standing up a second unrelated scenario,
keeps the demo to one shared task as the criterion requires, and folds SOS
in as evidence *about* that same task rather than a disconnected side-quest
— integrating, not just appending.

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

**Scope note (this revision):** this section is about a narrower, still-open
problem — SOS's own tool schema lacking a session-identifying field — and is
complementary to, not superseded by, the new §3 "SOS Bus — coordination-event
adapter" subsection. §3 designs what Mupot does with SOS coordination events
*today, as they exist*; this section is about a gap in SOS itself that only
SOS's own maintainers could close. Nothing in the boundary-clarification
comment resolves this section's open point (see also §11, item 5, unchanged).

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
| 10 | **(2026-07-27 revision)** Demonstrate Codex and one non-Codex runtime working the same Project task, with SOS-derived delivery/ACK visible, an unknown sender kept unmapped, and neither adapter able to complete a task or approve its own gate | §3's new "SOS Bus — coordination-event adapter" subsection (event-kind mapping, unmapped-by-default identity, `liveness: unverified` by default) + §5's new "Two-layer presentation" subsection (Layer 2 makes SOS observations visible without them becoming authoritative) + §7's new "Demo phase 2" subsection (reuses phase-1's `task_id A`, adds Codex + SOS against the same task, shows the unmapped-sender queue, proves neither adapter can mutate `tasks.status`/`task_verdicts`) + new §6 tests `sos_sender_label_alone_does_not_bind`, `sos_unrecognized_sender_surfaces_only_in_unmapped_queue`, `sos_gate_result_report_cannot_write_verdict`, `sos_request_ack_pairing_uses_existing_request_id`. This sharpens/extends criterion #9 above — same core mechanism, stricter same-task + SOS + unmapped-sender requirements |

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
   resolution route is built. **(2026-07-27 revision note: this question now
   also covers SOS-Bus entries in the same queue — §3's new subsection reuses
   this exact mechanism, so whatever capability gets decided here applies to
   SOS-origin unmapped rows identically. Not resolved by this revision, just
   confirmed to be the same open question, not a second one.)**
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
   would resolve this rather than assuming the worse case. **(2026-07-27
   revision note: still open — the boundary-clarification comment specifies
   *which* SOS events matter and the opt-in-mapping principle, both now
   captured in §3's new subsection, but says nothing about *how* `source_id`
   is synthesized at the bridge layer. Not resolved by this revision.)**
6. **(New, raised by this revision) Does a `sos-gate-result` observation's
   convincing-looking `report.summary`/proof-URL risk being read as a
   verdict in the dashboard UI even though it structurally cannot write
   one?** §4/§3 make the *storage-layer* invariant airtight (no
   `task_verdicts` row, ever, as a side effect), and §5's two-layer
   subsection keeps it out of the "authoritative" response section — but the
   *visual* design of the Layer 2 panel (§5) has not been reviewed for
   whether a gate-result-shaped observation needs a distinct, deliberately
   lower-trust rendering (e.g. a "reported, not verified" badge) to avoid a
   human reading it as the real gate verdict at a glance. Flagged for the
   UI/UX pass, not decided here.
7. **(New, raised by this revision) How does the phase-2 demo (§7) honestly
   produce a genuinely-unrecognized SOS sender** for the "unknown sender kept
   unmapped" acceptance step, without either (a) waiting on an actual
   unrecognized bus participant to show up live, which isn't controllable on
   demand, or (b) fabricating a fake-looking sender that a reviewer could
   fairly call staged? Recommend a real-but-deliberately-unbound test bus
   identity (a token that exists and can send, but has never been entered
   into `runtime_session_identity_map`) rather than a synthetic/mocked
   message — this keeps the demo honest (a real unmapped observation, not a
   simulated one) without depending on an unpredictable live event. Not
   decided here; flagged for whoever builds the demo script.
