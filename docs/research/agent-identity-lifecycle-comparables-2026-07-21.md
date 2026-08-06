# mupot agent-identity/memory/lifecycle — competitive scan

Researched 2026-07-10, kasra-research. Trigger: mupot is building agent identity
(profile/role/lineage), agent-vs-instance sessions (ephemeral, TTL'd), project-scoped
memory, an idle-death condition, and subagent-hierarchy/swarm support. Question: what do
the leading agent frameworks/products do on these five axes, and what should mupot
adopt vs. what is mupot already ahead on.

## Part A — "deepflow2" / "deerflow2" identified

**Verdict: ByteDance DeerFlow 2.0** (github.com/bytedance/deer-flow, ~25k stars, "SuperAgent
harness," 2026-02-27 release). "Deerflow2"/"deepflow2" is the natural short form used across
docs (Olares docs literally use the URL slug `deerflow2.html`). The "openclaw" pairing checks
out independently — press frames the two as parallel local agent systems ("DeerFlow 2.0:
ByteDance's OpenClaw Rival").

Ruled out as name-collisions: `deepflowio/deepflow` (unrelated eBPF network-observability
tool) and `DeepFlowcc/DeepFlow` (small, unrelated Web3/HF code-gen framework).

- **Orchestration**: LangGraph + LangChain (2.0 rewrite), checkpointer/store, SQLite or
  Postgres backend.
- **Agent model**: single generalist **lead agent** per conversation thread
  (`make_lead_agent()`) — not a fixed planner/researcher/coder role split. Specialization
  comes from a 14-34-layer middleware chain + dynamic tool/skill loading, not separate
  persistent role-agents. Lead agent dynamically spawns sub-agents via a `task()` tool
  (`general-purpose`, `bash` built-ins), parallel fan-out → converge to lead ("a dozen
  sub-agents → one report").
- **Memory**: file-backed, persistent across sessions — global `memory.json` (user
  profile/history) + per-agent canonical facts under `agents/{agent_name}/facts/` + per-thread
  state under `backend/.deer-flow/users/{user_id}/threads/{thread_id}/`.
- **Lifecycle**: no persistent agent identity. Lead agent instantiated fresh per thread turn;
  sub-agents are ephemeral, capped ~150 turns, terminate on completion. No idle-retirement, no
  standing agent registry.
- **Fit for mupot**: **not a fit as a general identity/lifecycle module.** DeerFlow is
  architecturally a deep-research/task-execution pipeline, not an identity system — no agent
  profile records, no TTL'd session-vs-identity split, no project-memory tiering, no
  idle-auto-retirement. The one thing worth porting: its **dynamic on-the-fly sub-agent
  spawn + parallel fan-out → converge-to-lead pattern**, which is architecturally close to
  Claude Agent SDK's `Agent` tool model.

## Part B — comparison table

| Framework | 1. Identity/profile | 2. Lifecycle/death | 3. Subagent hierarchy/swarm | 4. Memory scoping | 5. Sessions/always-on |
|---|---|---|---|---|---|
| **DeerFlow 2.0** | No profile record; lead agent = LangGraph node per thread | No TTL; sub-agents cap ~150 turns, terminate on completion | Dynamic `task()` spawn, parallel fan-out → converge to lead | File-backed: global `memory.json` + per-agent facts/ + per-thread state | Cold-start-from-disk per thread_id |
| **OpenAI Agents SDK / Swarm** | Agent = code object (name/instructions/model/tools); no ID/lineage | No native TTL; backend-dependent (Dapr/Encrypted sessions support TTL) | Flat handoff (`transfer_to_X` tool) within one run; no depth | `Session` = shared message log across handed-off agents; pluggable backend | Cold-start/resume via session ID; not a standing process |
| **LangGraph** | Agent = graph node/subgraph with name; no persistent record | **Real TTL/reaping**: `checkpointer.ttl` (sweep_interval, delete strategy); Store items TTL-capable | Supervisor-worker via `Command(graph=PARENT)` handoffs / handoff-tools | Two-tier: Checkpointer (thread short-term) + Store (cross-thread long-term KV); no decay scoring | Cold-start-from-checkpoint (Postgres etc.); not standing process |
| **Claude Agent SDK** | `AgentDefinition` object (description/prompt/tools/model/skills/memory scope); `parent_tool_use_id` = lineage link | Concrete TTL: `cleanupPeriodDays` default 30d; depth cap 5 | Orchestrator-worker via `Agent` tool, depth-limited 5, background/foreground; `Workflow` tool for dozens-hundreds scale | Fresh isolated context per subagent + project `CLAUDE.md`; `memory` scoped user/project/local | `.jsonl` transcripts on disk, resume via sessionId; hosted (AgentCore) adds 15min idle/8h cumulative timeout |
| **CrewAI** | Static YAML/JSONC (`role`/`goal`/`backstory`/`llm`/`tools`); no ID/record | Not documented; process-lifetime only | `Crew` = 2-3 agents typical; Sequential or Hierarchical (`manager_agent`) | Crew-level `memory=True` (short/long-term/entity); auto-captured, not per-agent | No always-on server; run-lifetime unless externally persisted |
| **AutoGen / AG2** | `ConversableAgent` code object; no persistent ID. AutoGen = maintenance mode, AG2 = active fork | Not documented; in-process for conversation duration | `GroupChat` + `GroupChatManager`, 3-5 agents typical; speaker-selection modes + allowed-transitions | Shared conversation thread across GroupChat; no per-agent tiering, in-memory default | No built-in always-on session; process-lifetime unless externally saved |
| **Letta (MemGPT)** | **Live DB-backed `AgentState` with `agent_id`** via REST API — real persistent record | No TTL/auto-expire; persists until deleted. "Sleep-time agent" = idle-driven background memory-updater | Primary + sleep-time agent pair; parallel conversations share memory blocks; not crew/manager | **3 tiers**: core (in-context, editable) / archival (pgvector semantic) / recall (searchable convo log). **Memory blocks shareable across agents** via `block_ids`. No decay scoring | **"Stateful agents as a service"** — server-side persistent, messaged like a person; Agent File (`.af`) for checkpoint/export |
| **Cursor Cloud Agents** | No persistent agent profile; project-scoped `AGENTS.md`/rules + Cursor Memories (proposed/approved) | No documented hard TTL; compute-cost-driven; 6+ hr runs reported, 10min "disruptive" flag (unverified exact idle cutoff) | Parallel independent instances, unified Agents Window; not coordinator/child | Project-level only (Memories+Rules), auto-proposed/human-approved | Cold-start-per-task ephemeral VM; cross-day resumability unverified |
| **Manus** | No persistent identity; "every session starts from zero" | Sandboxed VM, persistent filesystem per session; `todo.md` = resumability anchor; no public TTL | **Wide Research**: 100+ parallel instances, isolated, fan-out/collect only, no cross-agent coordination | "Knowledge" module = user-taught prefs; explicitly **no persistent cross-session/team memory** (2026) | Cold-start-per-task; not always-on by default; company status in flux post-Meta-unwind |
| **Devin / Cognition** | Account/org-scoped "Knowledge" auto-recalled every session — closest to a persistent identity layer distinct from any run | Sessions explicitly **archive/sleep + resume** (designed state machine); auto-wake on trigger (new PR comment); no fixed TTL | **Managed Devins** (Mar 2026): coordinator decomposes, delegates to isolated child VMs, monitors, resolves conflicts, compiles; up to 10 parallel sessions | Knowledge = account/enterprise-level (not project-scoped), persists across all future sessions/repos, shareable org-wide (300 items) | **Warm-restart-from-checkpoint**: sleep/archive/resume first-class, resumable days later — closest to hosted-persistent semantics |

## Per-dimension: best patterns to adopt + what mupot already does differently/better

**1. Identity/profile.** Best precedent: **Letta's live DB-backed `AgentState`** with a real
`agent_id` — the only framework where "agent" is a persistent record, not a code/YAML object.
Devin's account-level Knowledge-layer-separate-from-session is the closest existing precedent
to mupot's identity-vs-session split. Claude Agent SDK's `parent_tool_use_id` is a usable
lightweight lineage-link pattern. **Mupot is already ahead of the majority** (OpenAI SDK,
LangGraph, CrewAI, AutoGen/AG2, DeerFlow all treat "agent" as a stateless config/graph-node,
re-instantiated per process) — a persistent record combining role + model + tools + RBAC tier
+ lineage in one place has no full precedent in the 9 systems surveyed.

**2. Lifecycle/death.** Best precedent: **LangGraph's `checkpointer.ttl`** (sweep_interval +
delete strategy) — the only infra-level idle-reaper found, closest existing analog to a
death-condition. Claude Agent SDK's flat `cleanupPeriodDays` (30d default) is a simpler
precedent. Devin's sleep/archive/wake-on-trigger is a *different, worth-borrowing* pattern —
suspend-and-resumable rather than hard-delete. **Flag: this is a genuine gap in the field.**
None of the 9 apply a death-condition to *agent identity* — every TTL/sweep mechanism found
targets threads/sessions/transcripts only; the agent *definition* is always treated as
permanent. Mupot's idle-agent auto-retirement (on the identity, not just the session) has no
existing prior art to lean on — that cuts both ways: it's a genuine differentiator, but also
means there's no field-tested sweep semantics to copy; design the reaper carefully (soft-delete
+ audit trail, not hard-delete) given the lack of precedent.

**3. Subagent hierarchy/swarm.** Best precedents: **Claude Agent SDK's depth-cap (5 levels)**
as a simple runaway-recursion guardrail; **Devin's Managed Devins** (coordinator decomposes →
isolated child VMs → monitors → resolves conflicts → compiles) as the most mature
coordinator/child production pattern; **Manus's Wide Research** (100+ parallel, isolated,
fan-out/collect, zero cross-agent coordination) for pure-breadth tasks. DeerFlow's dynamic
on-the-fly `task()` spawn matches this same family. Cross-reference with prior kasra research
([`mupot-agent-ops-comparables-research-2026-07-14.md`](./mupot-agent-ops-comparables-research-2026-07-14.md)):
multi-agent orchestration is the field's most commonly **over-built** surface — Roo Code
archived its whole multi-agent orchestration layer in May 2026, and a widely-cited 2026 study
of 47 production multi-agent deployments found 68% could've used a single well-built agent at
~3x lower cost. Swarm support should stay **scoped/opt-in per task**, not a default-on
architectural layer — same conclusion as before, now doubly confirmed.

**4. Memory scoping.** Best precedent: **Letta's 3-tier model (core/archival/recall) +
memory blocks shareable across agents via `block_ids`** — the strongest adoptable pattern for
project-scoped memory, since one block attached to N agents gives shared memory without
duplication. LangGraph's Store (cross-thread KV, TTL-capable) is the closest precedent for
"project memory survives ephemeral agent sessions." Mupot's project-scoped-memory-over-per-agent
direction already mirrors Letta's shared-block idea, just at coarser (project, not block)
granularity — reasonable simplification. **Flag: confidence/decay scoring has zero prior art**
across all 9 systems surveyed — every research pass came back "not found" / "unverified" on
this specifically. If mupot wants confidence-weighted or decaying memories, that would be a
genuinely novel contribution to the field, not an adoption — treat it as higher-risk/unproven,
worth prototyping small before betting the memory architecture on it.

**5. Sessions/always-on.** Best precedents: **Letta's "stateful agents as a service"** (true
server-side persistent, messaged like a person) is the closest existing precedent to an
always-on agent; **Devin's sleep/archive/wake-on-trigger** is the best middle-ground pattern
for a TTL'd *session* distinct from a persistent *identity* — exactly mupot's target shape
(identity persists Letta-style, session suspends/wakes Devin-style rather than truly dying).
**Mupot's durable-CF-kernel is architecturally ahead of all 9**: every system surveyed bolts
persistence onto an external Postgres/SQLite/disk store from a request-driven server; none
runs the persistent-agent-as-object model natively on a durable, addressable compute primitive.
Cloudflare Durable Objects are a closer fit for Letta's "stateful agent as a service" framing
than anything Letta itself runs on — but mupot should still borrow Letta's memory-tier
vocabulary (core/archival/recall) and Devin's sleep/wake session semantics rather than
reinventing them from scratch.

## Sources
Primary: github.com/bytedance/deer-flow, docs.letta.com (agents/memory-blocks/archival-memory/
core-concepts), github.com/letta-ai/letta + agent-file, openai.github.io/openai-agents-python
(handoffs, sessions), github.com/openai/swarm, docs.langchain.com/oss/python/langgraph
(persistence), reference.langchain.com/python/langgraph-supervisor, support.langchain.com
(thread TTL), code.claude.com/docs/en/agent-sdk/subagents, docs.crewai.com (agents, crews),
docs.ag2.ai (ConversableAgent, GroupChat, GroupChatManager), github.com/ag2ai/ag2, cursor.com/
docs/rules + changelog, manus.im/docs/features/wide-research, cognition.ai/blog (Devin can now
Manage Devins). Secondary/community (flagged where used): aidevdayindia.org (AutoGen
maintenance-mode status), forum.cursor.com, venturebeat.com, taskade.com, medium.com writeups
on Devin knowledge base and OpenAI Swarm. Full per-framework citation lists were captured by
the four parallel research subagents that fed this synthesis (2026-07-10).
