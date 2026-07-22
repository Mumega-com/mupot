# mupot Module Kernel — durable core, pluggable modules, project-scoped presence

Status: DRAFT (Kasra, 2026-07-21) — the unifying architecture behind the
2026-07-21 direction session. Supersedes nothing; generalizes the addon
framework (marketing-cro-monitor proved the pattern) from one connector slot to
three module families.

## The one idea

**mupot Worker + Cloudflare primitives (D1, Durable Objects, Queues, KV, R2) are
the durable microkernel.** Everything else is a *module* that registers through a
uniform port, heartbeats, and can be dispatched or deleted at any time **without
the core losing durability.** Kernel survives every module's death; a dead module
just goes `offline` in the registry and its work reroutes.

This is the "bare minimum work" the human named: mupot-itself + Cloudflare is the
floor that never goes down. Hermes, SOS, cursor, codex, n8n, deepflow2, openclaw,
dashboards — all modules on top.

## Why now (the pain it fixes)

- ~10 agents are doing work; **not 2 are connected.** No shared presence, no
  roster, no "who is online on which project." SOS bus used to give this; the
  migration off SOS dropped it. mupot must give it back — project-scoped.
- The standing operator runs 19h idle because **nobody feeds the board** and
  there is **no gate-lane driver** (all flights park). Connectedness + a fed board
  + a gate lane = work that survives the human closing the laptop.

## The three module ports (all one registry)

Every module — whatever family — registers in ONE durable table
(`module_registry`) with: `id, kind, adapter, project_id?, status, capabilities,
last_heartbeat, registered_at`. The core owns the registry + the gate; the module
owns execution. Killing a module = one row flips to `offline`; the kernel is
untouched. This IS the durability guarantee.

### 1. Agent-system port  (the presence + onboarding win)
Onboard ANY agent runtime as an adapter, each declaring: identity, a presence
heartbeat, an inbox/dispatch hook, and a **project binding** (the agent selects
the project it is working on). mupot owns the roster + the gate; the agent-system
owns how it runs.

- **Onboard what is already running first** — Hermes (daemon), cursor, codex,
  mumcp. Prove the port on live agents, THEN generalize.
- **Then** external systems: deepflow2, openclaw — same adapter contract.
- **Presence** = agent connects through mupot → selects project → heartbeats →
  `GET /api/presence?project=<id>` returns the online roster. This is exactly what
  SOS gave, now durable on CF and project-scoped. Small, foundational, high-value.

Adapter contract (minimal):
```
register(identity, project_id, capabilities) -> module_id
heartbeat(module_id) every N seconds        -> keeps status=online
dispatch(module_id, task) [kernel -> module] -> module pulls + executes + reports
deregister(module_id) | stale heartbeat      -> status=offline (kernel durable)
```

### 2. Workflow port
Cloudflare Workflows = the DEFAULT (native `TASK_WORKFLOW` + the loop engine).
n8n (torivers.com), zapier, make = optional adapters behind the same port.
Direction decides the gate: inbound = signed source-only ingress; outbound =
gated act → receipt. External managers never hold the approval.

### 3. Surface port
Dashboards mount as panels (Hermes web UI first). A surface is read-through the
kernel's auth; it never becomes a second control plane.

## Per-project concierge (the always-on dispatcher, CF-native)

Each project has its OWN always-on concierge — NOT a systemd process per project
(that is the VPS-liability anti-pattern: doesn't scale, can die, not durable).
The concierge is a **per-project loop on the mupot Worker cron** (like
`runLoopsTick`, scoped per project): CF runs it every heartbeat, so it is
always-on by construction, zero idle cost, cannot die.

Two layers, cleanly split:
- **Concierge = decide.** Worker cron, per project, cheap heartbeat model →
  escalates to Sol for hard decomposition. Reads the project's goals + board +
  presence roster → ranks → dispatches work as agent-assigned board tasks → is
  the project's chat front-door. Registers as an agent-system module → shows on
  its own project's roster as `concierge: online`.
- **Drivers = execute.** The shared host operator's build drivers (cursor /
  claude / mumcp) pick up the dispatched tasks and build them; the gate-driver
  (review-worker) gates them.

Decision is per-project + always-on; execution is shared. One global operator
becomes N per-project concierges, each isolated (project scope). Idempotent by
design (rank, never act-loop; a concierge-originated starter is deduped by an
any-status origin marker + a DB unique index — never re-dispatched), per
brain=ATC. This is the "feed the board" half of the gate loop and the always-on
front the Hermes-Sol reasoning escalates from.

## Identity cluster (Port 1.x) — see companion doc

The agent identity / memory / lifecycle design (agent-vs-instance sessions,
agent profile + placement tree, parentage, project-scoped memory, the
death-condition, project-context, and the controlled-ephemeral swarm policy)
lives in **`docs/architecture/mupot-agent-identity-memory-lifecycle.md`**, with
the competitive landscape in
`docs/research/agent-identity-lifecycle-comparables-2026-07-21.md`. Those are
extensions of this kernel — one agent, many harness instances; profiles that
give agents a role/why/death; memory the project holds, not just each agent.

## Durability guarantees (the non-negotiables)

1. Kernel state lives ONLY in CF primitives. No module holds kernel truth.
2. A module registers/heartbeats/deregisters; the kernel never blocks on a module.
3. Stale heartbeat → `offline` (never a hang). Work assigned to an offline module
   reroutes or parks — never lost.
4. Adding/removing a module is a registry write, never a core deploy.
5. The gate stays in the kernel. Every world-affecting act crosses it → receipt.

## Operating model (the ECC lesson, applied)

"Always-on" is NOT keeping the expensive decider (Opus) alive. It is:
cheap supervisor always-on (the standing operator) + **warm restart**
(save/resume-session) + **durable distilled learnings** (instinct-style memory) +
**gate-as-a-driver** (santa-loop: two independent models, both NICE before ship).
Wake the decider only for hard calls. mupot already has the supervisor, the
gate-lane driver, the fed board, and **Port 4 warm-restart + instinct-memory**.
The remaining build-order items are the surface port and workflow adapters.

## Build order (declared, not optional)

1. **Presence + module_registry** — the core primitive. Agent connects → selects
   project → heartbeat → roster. Onboard the running agents (Hermes, cursor,
   codex, mumcp). Fixes "10 agents, none connected" immediately.
2. **Feed the board + santa-loop gate-driver** — so connected agents do governed
   work that closes hands-off. First real unattended 2-agent flight.
3. **Warm-restart + instinct-memory** — ✅ LIVE (Port 4). `session_save` /
   `session_resume` (stale-replay guarded) + confidence-scored `instinct_*`
   (promotion gate ≥2 projects / avg conf ≥0.8). Migration 0070. So a
   post-compaction restart is warm, not cold.
4. **Surface port** — mount the Hermes dashboard as a mupot panel.
5. **Workflow adapters** — n8n behind the workflow port (marketing loop = proving
   ground).

Ports 2–3 are the ECC ports; port 1 is the SOS-connectedness we lost, rebuilt
durable. Port 4 is the ECC memory-persistence / continuous-learning-v2 port onto
CF. All five are extensions of the addon pattern, not new frameworks.

## Presence authz — the write path is gated too (2026-07-21, adversarial-gate fix)

Port 1's presence roster has TWO surfaces: a read (`presence_list` /
`GET /api/presence`) and a write (`presence_register`, `presence_heartbeat`).
Both bind a caller's identity to a `project_id`, so both must answer the same
question: can this caller touch THIS project?

- **Read** was gated from the start: `presence_list` reuses `readAccess` +
  `readableProject` (`src/mcp/projects.ts`) — the one project-visibility
  chokepoint `project_get` also uses. No second authz path invented for reads.
- **Write** initially was NOT gated — `presence_register`/`presence_heartbeat`
  correctly derive the caller's OWN identity server-side (never from args), but
  then bound that identity into an attacker-CHOSEN `project_id` with zero check
  that the caller could even read that project. Any authenticated member could
  inject itself — with free-form `capabilities` — into a project's roster it
  had no access to. Caught by adversarial gate on PR #457 (P1 BLOCK).
- **Fix**: `presence_register`/`presence_heartbeat` now run the SAME
  `readAccess` + `readableProject` check before writing, whenever
  `project_id` is non-null. Fails closed with the identical
  `project_not_found` shape the read path returns (no oracle for "wrong id"
  vs "no access"). `project_id: null` (the no-project self bucket) names no
  project, so it stays ungated on both read and write.
- **`presence_deregister` is the one write left ungated** — deliberately: it
  can only flip an EXISTING `(identity, project_id)` row it already owns to
  `offline`. It can't create a row or rebind identity into a new project, and
  it returns the same `not_registered` 404 whether the project is
  inaccessible or the row never existed. No new capability, no new
  disclosure — nothing to gate.

Lesson for the next module port: if a write binds identity into a scoped
resource (project, squad, department), gate the WRITE with the same
visibility primitive as the READ — deriving identity safely is necessary but
not sufficient; the destination scope needs its own check.
