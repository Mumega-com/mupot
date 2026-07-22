# mupot — Agent Identity, Memory & Lifecycle

**Design session 2026-07-21 (Hadi ↔ Kasra).** Companion to
`docs/architecture/mupot-module-kernel.md`. Captures the identity/memory/lifecycle
cluster (Port 1.x) that emerged from a live design conversation, the ECC lessons
adopted, and the competitive landscape.

---

## 0. The bottleneck this whole arc addresses

> "When I close my laptop, you all stop working. I made mupot to get rid of this
> bottleneck that is me."

The org stops when Hadi is away — **not** because runtimes die (the Hetzner VPS +
watchdog keep Kasra's tmux alive 24/7), but because nothing **drives turns** and
nothing is **connected/legible**. Three mechanical gaps:

1. **Board unfed** — work lived in a human-present session, never queued as
   agent-assigned tasks → the standing operator polled and no-op'd for 19h.
2. **No gate lane** — only build drivers existed; every verdict/merge was a human
   → all 8 flights parked, 0 landed.
3. **Not legible** — ~10 agents working, not 2 connected; no roster, no profiles,
   no "where is this project" summary, no lifecycle.

"Always-on" is **not** keeping the expensive decider (Opus) alive — ECC (211K★)
proved nobody does that; it's a mirage. Real always-on = **cheap supervisor
always-on + warm restart + durable learnings + gate-as-a-driver**, waking the
decider only for hard calls. We already pay for the runtime; we were missing the
*driver* and the *legibility*.

---

## 1. The module kernel (recap)

**mupot Worker + Cloudflare primitives = the durable microkernel.** Everything
else — agent-systems, workflow-managers, dashboards — plugs in as **modules**
through uniform ports and can be added/killed without the core losing durability.
Three ports, one `module_registry`:

- **Agent-system** — onboard any runtime (Claude Code, Hermes, cursor, codex,
  ChatGPT-Sol, deepflow2, openclaw) as an adapter: identity + heartbeat +
  dispatch + project binding.
- **Workflow** — Cloudflare Workflows = DEFAULT; n8n (torivers.com)/zapier/make =
  optional adapters. Inbound = signed source-only; outbound = gated act → receipt.
- **Surface** — dashboards mount as panels (Hermes web UI). Read-through kernel
  auth, never a second control plane.

**Durability law:** kernel state lives only in CF; a module registers/heartbeats/
deregisters; **stale heartbeat → offline is query-time derived (no cron)**; the
gate stays in the kernel; every world-act → receipt.

This is NOT a rewrite — it generalizes the addon pattern the marketing-cro-monitor
addon already proved.

---

## 2. The identity / memory / lifecycle cluster (Port 1.x) — the heart of the session

### 2.1 Agent vs Instance (Port 1.1 — sessions & addressing)
- **Agent** = a permanent identity (`agents` table). Survives forever.
- **Instance** = one connection of that agent through a harness — ephemeral,
  addressable, session-TTL'd. **One agent → many live instances** (Hermes-on-Claude
  + Hermes-on-Sol + Hermes-on-Cursor are instances of ONE agent, never separate
  agents).
- **Address**: the instance UUID, rendered routable as
  `<agent-slug>.<harness>.<shortid>` (e.g. `hermes.claude-code.a9e8`).
- **Two timescales**: 120s heartbeat → online/offline (BUILT); **24h idle session
  TTL → access expiry** (TO ADD, sliding window).
- **Cleanest "like a session"**: connect mints a short-lived session token (24h
  sliding) off the persistent agent token; idle → 401 → reconnect. Least-standing-
  access by construction.

### 2.2 Agent profile (Port 1.3 — role, why, tree) — *the missing definition*
Today a mupot agent is a **bare row** (id, name, slug, model, status, squad_id) —
no role, no purpose, no placement, no lifecycle. This directly caused the
2026-07-21 **3-hermes sprawl** (agent-hermes + kayhermes + hadi-hermes, all
distinct roles but indistinguishable as rows) and a bad dedup (Kasra retired two
distinct agents thinking they were duplicates). The fix is a **profile**:

```
identity:  qnft_ref            (WHO — immutable identity + lineage)
role:      name, purpose/why, owner
runtime:   model_preferred + fallback, capabilities[], skills[]
placement: squad/project + parent_agent_id  (the TREE — where + who spawned it)
lifecycle: death_condition (idle TTL, "no live instance + no activity")
defense:   prompt-defense baseline (ECC ships it free)
```

Two payoffs, both fixing the exact damage from this session:
1. **Onboarding resolves an existing profile before minting** → no more sprawl,
   no more bad dedup (roles visible).
2. **Death condition** → the org self-prunes.

### 2.3 Parentage & the tree (two lineages — don't conflate)
- **Identity lineage** — qNFT (who *minted* whom: loom→River→kasra). Permanent.
- **Runtime parentage** — `parent_agent_id` (who *spawned* whom this task).
  Ephemeral. **Required for swarm** (reaping, attribution, the tree).

The `agents` table has `squad_id` but **no `parent_agent_id`** — the gap. Add it to
the profile. The placement tree = org → dept → squad → project → agent →
instances.

### 2.4 Death condition (the SOS principle, enforced) — *ours to build*
> "SOS agents should die if not used and don't have heartbeat, but we don't have it."

An agent auto-retires when **no live instance (all sessions expired, no heartbeat)
AND no activity (no tasks/dispatch/verdict) past a TTL** → status → inactive.
A cron sweep (or query-time) enforces it. This **prevents sprawl by construction** —
an unused onboarding attempt dies on its own. **ECC does NOT have this** — its
agents are static `.md` files that never accumulate or die; ours are live rows, so
this is our novel need. Built on presence (Port 1) + sessions (Port 1.1).

### 2.5 Memory — three layers (one exists, two missing)
mupot HAS memory: `remember`/`recall` MCP tools, D1 `engrams` + Vectorize, scoped
per **agent + tenant** (isolated). But:

| Layer | Scope | Status |
|---|---|---|
| Agent memory | per-agent, private | ✅ exists (semantic, but **manual + flat**) |
| **Project memory** | shared per-project | ✅ exists (`project_remember` / `project_recall`) |
| **Instinct memory** | confidence + triggers, cross-session | ✅ Port 4 (`instinct_upsert` / `instinct_promote` + `session_save` / `session_resume`) |

- **Project memory** = the keystone for "everyone aligned just by accessing the
  project." Small extension: add `project_id` scope to engrams/recall.
- The current memory is **manual** (agents must call `remember`, so they don't) and
  **flat** (no confidence, no triggers). ECC's model fixes both (§3).

### 2.6 Project context (Port 1.2 — "where is this project, where's the data")
> "Access project → retrieve a summary of the exact position. mupot should know
> where the data is."

No unified project-position read exists (pieces scattered: `project_get`,
`listProjectEvidence`, board, roster). Build `project_context` (MCP +
`/api/projects/:id/context`): **meta + roster (who's online) + board position +
recent evidence + a DATA MAP** (repos/PRs from task+flight refs, docs, D1 evidence,
R2 blobs — *where everything lives*). It reads project memory (§2.5) and makes the
concierge smarter (know position before dispatching).

### 2.7 Swarm — controlled ephemeral, not a persistent horde
- We already run a **de-facto controlled swarm**: Claude Code's Agent tool spawns
  subagents (this session spawned ~12 arms, reaped after). But they're **invisible
  to mupot** (not on the roster).
- The 1.x cluster composes into first-class swarm: **instances (ephemeral) +
  parentage + death-condition = many short-lived agents under a parent, TTL'd,
  self-reaping.**
- **Strategic tension** (`feedback_fewer_agents_deterministic_workflow`): a large
  autonomous *persistent horde* fights our "minimize agents, one judgment seat"
  discipline. **Recommendation: controlled ephemeral swarm** (task-scoped,
  parent-owned, auto-reaped — what the arms already are), made visible + governed.
- **Hermes = the swarm coordinator** (concierge dispatches N tasks → N workers
  spawn → gate-driver reviews → reaped). Whether the Hermes *daemon* self-spawns
  workers is a daemon-side capability to verify.

---

## 3. What ECC gave us

ECC (`ecc-universal`, 211K★, Affaan Mustafa) — the biggest lessons, adopted:

| ECC pattern | We adopt as | Note |
|---|---|---|
| **santa-loop** (two independent models, both NICE before ship) | the gate-driver's diverse review | already building (Leg 1) |
| **continuous-learning-v2** — auto-capture (hooks → observations.jsonl) + cheap-model distill (Haiku, 5-min loop) + **confidence(0.3–0.9) + triggers** | Port 4 instinct memory | **mupot memory is manual + flat; ECC's is automatic + structured — flip it** |
| project + global instinct scope (precedence) | project-memory scope | the missing project layer |
| **agent def schema** (frontmatter role/model/tools + prompt-defense baseline) | Port 1.3 profile | proven shape, don't reinvent |
| **model-route** (preferred + fallback tiering) | concierge/Hermes model routing | Sol/Terra/Luna ≈ Opus/Sonnet/Haiku |
| **session hooks** (save on Stop, re-inject on boot, stale-replay guarded) | Port 4 warm-restart | ECC's "always-on" is really warm-restart |

**What ECC does NOT give (build ourselves):** the **death condition** (its agents
are static files, never die) and the **rich placement tree** (ECC has a flat
catalog; ours is org→dept→squad→project, mupot-native).

**One-line takeaway:** ECC doesn't ask the agent to be disciplined about memory —
it *captures automatically and distills cheaply*. mupot asks; so memory stays thin.
Port that mechanic onto our live-runtime substrate + add the lifecycle ECC never
needed.

---

## 4. Competitive landscape

Grounded scan of 9 systems (full doc:
`docs/research/agent-identity-lifecycle-comparables-2026-07-21.md`).

**deepflow2 = ByteDance DeerFlow 2.0** (github.com/bytedance/deer-flow, ~25k★,
LangGraph, Feb 2026). Single lead-agent per thread that spawns ephemeral sub-agents
via a `task()` fan-out→converge (capped ~150 turns). File-backed memory, **no
confidence, no TTL, no persistent agent-identity record** (lead reinstantiated fresh
per thread). **Fit: NOT an identity system — a deep-research pipeline.** Only
portable idea = its fan-out/converge swarm (which Claude SDK's Agent tool already
does). ("openclaw" is its confirmed parallel; both are local agent systems.)

| System | Identity | Lifecycle/death | Swarm | Memory | Sessions |
|---|---|---|---|---|---|
| DeerFlow 2.0 | graph node, no record | none (150-turn cap) | dynamic task() fan-out | file global+agent+thread | cold-start |
| OpenAI Agents SDK/Swarm | code object, no ID | backend-dependent | flat handoff | shared msg log | resume via id |
| LangGraph | graph node | **TTL sweeper (checkpointer.ttl)** — but on *threads*, not identity | supervisor-worker | Checkpointer + Store(cross-thread) | checkpoint |
| Claude Agent SDK | AgentDefinition + `parent_tool_use_id` | cleanup 30d, **depth cap 5** | orchestrator-worker | fresh isolated ctx | .jsonl resume; hosted 15min idle |
| CrewAI | static YAML | process-lifetime | crew 2–3 | crew-level | none |
| AutoGen/AG2 | object | — | GroupChat | shared thread | none |
| **Letta (MemGPT)** | **live DB AgentState + agent_id** | idle-driven sleep-time updater | primary+sleep pair | **3-tier core/archival/recall, shareable blocks** | **stateful-agents-as-a-service** |
| Cursor Cloud | project rules, no profile | compute-cost | parallel instances | project-level | ephemeral VM |
| Manus | none | sandbox VM | **100+ wide fan-out** | prefs only | cold-start |
| Devin/Cognition | account Knowledge | **sleep/archive/wake-on-trigger** | coordinator→child ≤10 | org-shareable | **warm-restart-from-checkpoint** |

**Where mupot already leads (validated):**
- **Identity** — only **Letta** has a true persistent DB-backed agent record; everyone else is a stateless code/YAML object. mupot's record (role + model + tools + **RBAC + lineage + lifecycle** in one) is *ahead* of the field.
- **Death condition** — every TTL mechanism found (LangGraph, Claude SDK, Devin) targets **sessions/threads/transcripts, NEVER agent identity.** Idle-agent auto-retirement has **zero field precedent** — a genuine differentiator. Build it **soft-delete + audit-trail** (no established sweep semantics to copy).
- **Kernel** — mupot's Durable-Object kernel is architecturally ahead of all 9 (each bolts persistence onto an external DB from a request-driven server).
- **Confidence/decay memory** — **zero precedent anywhere.** Novel if we build it → prototype small, don't over-invest.

**What to borrow (don't reinvent):**
- **Letta's memory vocabulary** — 3-tier **core / archival / recall** + **shareable blocks across agents** (`block_ids`) = the strongest precedent for our project-scoped/shared memory. Adopt the model, not a rewrite.
- **Devin's sleep / archive / wake-on-trigger** — maps *directly* onto our agent(persistent)/instance(TTL'd session) split. Borrow the semantics + naming.
- **Swarm depth-cap** (Claude SDK = 5; Devin ≤10) — bound it.

**The field's biggest warning (reinforces our call):** multi-agent orchestration is
the **most over-built surface** — Roo Code archived its entire layer; **68% of 47
studied deployments needed only ONE agent** (prior research
`mupot-agent-ops-comparables-research-2026-07-14.md`). **Keep swarm opt-in, never
the default architecture.** This confirms: controlled ephemeral swarm, not a
persistent horde.

---

## 5. Current state (as of 2026-07-21)

- **Leg 0 — Presence** ✅ LIVE (Version cd80eb97). `module_registry` + presence;
  kasra + cursor + mumcp + kayhermes on the roster.
- **Leg 1 — the loop** — gate-driver (#458, review-only, 3 P0s caught+fixed) +
  concierge (#459, deployed) + build-driver presence (#461) all merged; operator
  updated (interval 90s), review + presence drivers cycling. **First autonomous
  dispatch fires on the next */15 cron tick, server-side, without a human.**
- **Hermes** — canonical = **kayhermes** (`942e2845`, gpt-5.6-sol); agent-hermes
  (represents Hadi) + hadi-hermes (his MacBook) are distinct, restored active.
- **Auto-merge** stays flag-off (2 blockers tracked, #460; Hadi-go to flip).

## 6. Sequencing

The 1.x identity cluster, after the Leg-1 loop takes its first breath:
1. **Port 1.3 profile-first** (+ resolve-before-mint) — kills the sprawl, the one
   actively causing errors.
2. **Project memory** (add project scope to engrams/recall) — the alignment keystone.
3. **Port 1.2 project-context** (reads project memory + data map).
4. **Death condition** (cron on presence+sessions).
5. **Port 1.1 sessions/TTL** + **Port 4 instinct memory** (auto-capture + distill).

Profile + parentage + swarm are **fields + a policy** inside this cluster, not new
ports. The strategic open question: **controlled ephemeral swarm (recommended) vs
persistent horde.**
