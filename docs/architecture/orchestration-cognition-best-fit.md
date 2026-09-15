# Orchestration & cognition — peer map and best fit for mupot

Status: decision recommendation, 2026-09-15. Grounded in repo receipts
([mupot-core.md](./mupot-core.md), [sos-brain-ranking-policy-path.md](./sos-brain-ranking-policy-path.md),
[port-interfaces-model-brain.md](./port-interfaces-model-brain.md),
[loop-container-design](../superpowers/specs/2026-06-08-loop-container-design.md),
[agent-identity-lifecycle-comparables-2026-07-21.md](../research/agent-identity-lifecycle-comparables-2026-07-21.md),
ROADMAP Paperclip map) plus 2026 field surveys and a **GitHub code survey**
(Mumega family + starred orchestration repos). Updates by PR only.

## One-sentence recommendation

**Split the problem:** cognition = rank-only `BrainPort` (SOS perceive→rank→rest);
orchestration = seat + gate + receipt + thin wake mailbox, with work execution
owned by external runtimes (Paperclip / harness / CF Workflows) — **never** a
CrewAI/LangGraph-shaped multi-agent framework inside the pot.

## GitHub landscape (code that actually exists)

The earlier peer table understated how crowded GitHub is. Treat these as
*adjacent codebases to learn from*, not candidates to vendor into mupot core.

### Mumega family (same org — highest priority to place correctly)

| Repo | What it is | Layer | Relation to mupot |
|---|---|---|---|
| [`Mumega-com/sos`](https://github.com/Mumega-com/sos) | MCP-native agent OS: Redis bus, squad labor, inboxes, wakes, optional Mirror | Coordination **kernel** under many harnesses | **Do not re-build inside mupot.** Bus/squad poll paths retire per mupot-core; keep only rank policy + seat-on-envelope inbox. SOS README itself says frameworks build *one* agent/workflow; SOS sits *under* them — mupot is the sealed *wall*, not a second SOS. |
| [`Mumega-com/mirror`](https://github.com/Mumega-com/mirror) | Engrams + pgvector memory, MCP, tenant RLS | Cognition / memory | Archive-or-replace with mem0 port; keep attribution on the pot. Optional plane for SOS; not mupot core. |
| [`Mumega-com/herdr-mupot-bridge`](https://github.com/Mumega-com/herdr-mupot-bridge) | Poll plugin: flights board, presence, inbox deliver (allowlisted reads) | Execution bridge | Pattern to keep: **thin, allowlisted, seat-scoped hop**. Event-driven seatlink is the successor; don’t grow a second orchestrator here. |
| [`Mumega-com/prime-mupot-experience`](https://github.com/Mumega-com/prime-mupot-experience) | Runbooks for prime seat vs mupot+SOS | Ops cognition | Evidence for gate discipline and boot — not a runtime to merge. |
| [`Mumega-com/inkwell`](https://github.com/Mumega-com/inkwell) | Agent-first publishing engine | Product addon | Stays outside core (content plane). |

### Starred / widely cloned orchestration code on GitHub

| Repo (approx. stars) | Pattern in the code | Steal | Don’t steal into mupot |
|---|---|---|---|
| [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) (~80k) | Company OS: goals, org chart, budgets, heartbeats, board UI; “if OpenClaw is an employee, Paperclip is the company” | Adapter proof; budget/heartbeat *patterns*; board-as-source-of-work | Identity/authz (ROADMAP: weaker than mupot gates); don’t become Paperclip |
| [`microsoft/autogen`](https://github.com/microsoft/autogen) (~61k) + Magentic-One | Group chat / orchestrator + specialists; task ledger + progress ledger loops | Progress-ledger *as receipts*; open-ended manager only in a **harness** | Actor group-chat as pot control plane |
| [`crewAIInc/crewAI`](https://github.com/crewAIInc/crewAI) (~59k) | Crews (roles) + Flows (event workflows) | Flows ≈ CF Workflows thinking; keep crews out of core | Role YAML org inside the Worker |
| [`openai/swarm`](https://github.com/openai/swarm) (~22k) | Educational flat handoffs | Handoff ergonomics at **task** scope | Standing multi-agent runtime |
| [`letta-ai/letta`](https://github.com/letta-ai/letta) (~25k) | Stateful agents + tiered memory | Memory tier vocabulary behind mem0 port | Hosting Letta as the control plane |
| [`kyegomez/swarms`](https://github.com/kyegomez/swarms) (~7k) | Enterprise swarm topologies | Opt-in fan-out recipes for harnesses only | Default swarm architecture |
| [`VRSEN/agency-swarm`](https://github.com/VRSEN/agency-swarm) (~4.5k) | Agency roles + tool handoffs | Role≠authority reminder (authority = grants) | Agency tree as RBAC |
| [`mainframecomputer/orchestra`](https://github.com/mainframecomputer/orchestra) (~0.8k) | Conduct/Compose hierarchical teams | Conductor≠executor split (aligns with rank-not-act) | Another in-process team runtime |
| [`Yeachan-Heo/oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode) (~39k) | Teams-first orchestration **for Claude Code** | Harness-side parallel seats; mupot remains the door/gate | Pulling IDE team orchestration into the pot |
| [`mikeyobrien/ralph-orchestrator`](https://github.com/mikeyobrien/ralph-orchestrator) (~3k) | Autonomous loop over coding CLIs | Loop+receipt discipline for a seat | Replacing gates with “keep looping” |
| [`Kocoro-lab/Shannon`](https://github.com/Kocoro-lab/Shannon), [`abhi1693/openclaw-mission-control`](https://github.com/abhi1693/openclaw-mission-control), [`RunMaestro/Maestro`](https://github.com/RunMaestro/Maestro) | Prod orchestration platforms / mission-control UIs | Observability + JSON agent defs as *addons* | Second control tower beside mupot door |
| [`tinyhumansai/openhuman`](https://github.com/tinyhumansai/openhuman), [`HKUDS/DeepCode`](https://github.com/HKUDS/DeepCode), [`cft0808/edict`](https://github.com/cft0808/edict) | Harness + multi-agent workflow engines | Harness engineering lives with the seat | Competing “agent OS” inside CF Worker |

**Pattern that repeats across GH:** almost every popular repo fuses (1) a reasoning
loop, (2) multi-agent routing, and (3) sometimes a UI. Mupot’s subtraction says
those are three different products. SOS already claimed (2)’s *bus*; Paperclip
claims (3)+(org); harness repos claim (1). Mupot should own **authority + proof**,
not win the stars race in category (1) or (2).

**After this GH pass:** the recommendation does **not** change — it gets sharper.
Mumega already *has* the coordination kernel (`sos`) and the memory plane
(`mirror`). Starred orchestration code on GitHub is mostly competing to own
those layers again. Mupot’s job is the sealed wall (seat · door · gate ·
receipt · rank-only brain), with adapters out to Paperclip/boards and bridges
out to harnesses (`herdr-mupot-bridge` / seatlink), not another swarm framework.

## First: separate two words the field conflates

| Layer | Question it answers | Peer examples | Mupot home |
|---|---|---|---|
| **Cognition** | *What should we care about next?* Memory, planning, ranking, reflection | Letta memory tiers; SOS brain; Devin Knowledge | `BrainPort.decide` + directive + board/receipts snapshot |
| **Orchestration** | *Who may do what, in what order, with what proof?* Routing, handoffs, approvals, budgets, durability | LangGraph graphs; Paperclip company OS; Temporal/Workflows; AutoGen actors | Identity · door · gate · receipt (+ CF Queues/Workflows as substrate) |
| **Execution / harness** | *How does a body actually run?* Tool loop, sandbox, IDE agent | Claude Agent SDK, Codex, Cursor, Hermes | Outside the pot (mupot-core: pot must not execute assigned work) |

Most “agent frameworks” sell **orchestration + a reasoning loop fused together**.
Mupot’s core decision record already rejected that fusion: the pot is the wall
work passes through, not the employee and not the company org chart.

## How peers handle it (comparative map)

### A. Graph / workflow orchestrators (control flow first)

| System | Pattern | Cognition stance | Fit for mupot |
|---|---|---|---|
| **LangGraph** | Explicit state graph, checkpoints, interrupts, supervisor→worker | Thin; “bring your own planner” | **Borrow substrate ideas** (checkpoint TTL, human interrupt) via **CF Workflows**, not LangGraph itself. ROADMAP: do not adopt Temporal/Inngest/etc.; use Cloudflare primitives we already pay for. |
| **Temporal / Inngest / Restate** | Durable workflows, signals, timers | None | Same — replace broken flights/loops with CF Workflows `waitForEvent`, not an external engine. |
| **OpenAI Agents SDK / Swarm** | Flat handoffs inside one run | Prompt+tools per agent object | Handoff *pattern* is fine at task scope; no standing swarm layer. |

### B. Role / crew orchestrators (org chart first)

| System | Pattern | Cognition stance | Fit for mupot |
|---|---|---|---|
| **CrewAI** | YAML roles, sequential/hierarchical crew | Role backstory as pseudo-cognition | **Avoid as architecture.** Over-built; Roo archived similar layer; field study ~68% of multi-agent prod could be one agent. |
| **AutoGen / AG2** | Actor mailboxes, group chat manager | Conversation-as-orchestration | Avoid as core; inbox-with-seat already covers wake messaging. |
| **Paperclip** | “Agents are employees; Paperclip is the company” — goals, heartbeats, board gates, budgets | Org OS, not a brain | **Complement, don’t copy.** ROADMAP: Paperclip = org chart; mupot = wall. Adapter-compatible; do not vendor its authz. |
| **MetaGPT / ChatDev** | Simulated software company | Scripted SOP cognition | Research demos; not mupot’s product shape. |

### C. Cognition-first systems (memory / ranking first)

| System | Pattern | Orchestration stance | Fit for mupot |
|---|---|---|---|
| **Letta (MemGPT)** | Persistent `AgentState`, core/archival/recall memory, sleep-time memory agent | Thin fixed loop | **Borrow memory vocabulary** (core/archival/recall) behind mem0 port; attribution stays pot-side. Do not host Letta as the control plane. |
| **SOS Sovereign Brain** | Perceive→think→act→remember→report→sleep + field physics | Dispatches to harness bodies | **Keep policy only** (rank→dispatch-to-owner→rest). Never fork C(t)/utility/trust into Worker. See [sos-brain-ranking-policy-path.md](./sos-brain-ranking-policy-path.md). |
| **Devin / Cognition** | Knowledge layer + sleep/archive/wake; Managed Devins coordinator | Strong session orchestration | **Borrow sleep/wake session semantics**; keep identity Letta-persistent / session Devin-suspendable. Coordinator pattern only opt-in per task, depth-capped. |

### D. Harness / lead-agent spawners (execution first)

| System | Pattern | Fit for mupot |
|---|---|---|
| **Claude Agent SDK / DeerFlow** | One lead agent + ephemeral subagents (`Agent`/`task` tool), depth caps | Correct *execution* shape for a harness seat — **outside** pot. Pot ranks and gates; harness fans out. |
| **Cursor / Codex / Hermes** | Interactive or daemon seats | Door targets; pot does not replace them. |

### E. Mechanism-level research (2026)

Mechanism reviews (cognitive-architecture → language-agent lineage) converge on:
separate **runtime boundaries** (checkpoint, interrupt, memory edit, budget stop,
uncertainty→ask-or-stop) from **judgment**. Utility-guided orchestration papers
treat “respond / retrieve / tool / verify / stop” as *admission control*, not as
a multi-agent soap opera. That matches mupot’s gate+meter+verifier direction.

## Fit against mupot constraints (non-negotiables)

From [mupot-core.md](./mupot-core.md):

1. Pot owns **identity, door, gate, receipt** (+ thin wake mailbox).
2. Pot does **not** own boards, org charts, chat products, or in-Worker execution.
3. SOS brain idea kept = **ranking policy that never acts**.
4. Verifier (open artifact, rehash, retest on exact ref) is the missing fifth core.
5. Multi-agent orchestration is historically over-built — keep swarm **opt-in**.

Therefore any “best solution” that installs LangGraph/CrewAI/AutoGen *inside*
mupot as the brain **fails the core**. Any solution that puts full SOS field
physics inside the Worker **fails the mind/body audit**. Any solution that makes
the pot the executor **fails mupot#1390 / core invariant 5**.

## Best solution for mupot (target architecture)

```
                    Hadi pinned directive
                            │
                            ▼
   board/receipts ──► BrainPort.decide ──► ranked proposals (noop|wake|spawn_shape)
   (Linear/Paperclip/native)   ▲                    │
                               │                    │ never acts
                        (swap: BYO / SOS measure)   ▼
                                         sealed core: autonomy · capability · budget · gate
                                                    │
                                                    ▼
                                         handoff to OWNER SEAT / addon
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          ▼                         ▼                         ▼
                   Paperclip/Linear            CF Workflows              Harness seat
                   (org + issue row)         (durable wait/gate)      (Cursor/Codex/…)
                          │                         │                         │
                          └─────────────────────────┴─────────────────────────┘
                                                    │
                                                    ▼
                                              receipt + (future) verifier
```

### Keep / build / avoid

| | Action |
|---|---|
| **Keep** | Seat identity; MCP door; grants/gates; runtime receipts; rank-only `BrainPort`; task-list ATC as *list* ranking; CF Queues/Workflows as durable substrate; Paperclip/Linear as boards |
| **Build next** | (1) Default `BrainPort` adapter + tests — started as `src/brain/ranking-policy.ts`; (2) consumer that applies top proposal **only through gates**; (3) separate propose vs act in `runGoalCycle` or delete act path; (4) one alternate brain swap; (5) verifier |
| **Avoid** | In-pot CrewAI/LangGraph/AutoGen; forking SOS `brain.py`/field physics; always-on Worker CEO; native board replacing Linear/Paperclip; swarm-as-default; rebuilding Temporal |

### Cognition policy (normative)

1. **Rank, don’t act.** Stable context → stable ranking → rest when healthy.
2. **Directive biases summaries, never bypasses gates.**
3. **Budget starve → noop.** No spend from the brain adapter.
4. **Swarm is a task option**, depth-capped in the *harness*, invisible to core.
5. **Memory:** mem0 (or Letta-shaped tiers) behind a port; pot keeps seat attribution.

### Orchestration policy (normative)

1. **Org chart lives in Paperclip (or equivalent); pot is the wall.**
2. **Durability = CF Workflows**, not flights/loops/circuits reinvented.
3. **Wakes = inbox with seat on envelope**, not SOS Redis bus.
4. **Approvals = gate grants + Workflows `waitForEvent`**, not chat text.
5. **One good agent first**; add specialists only for distinct permissions or true parallel isolation.

## Why this beats the alternatives for *this* product

| Alternative | Why it loses for mupot |
|---|---|
| “Become LangGraph for agents” | Duplicates CF Workflows + gates; fights subtraction roadmap |
| “Become Paperclip” | Wrong layer; authz weaker; we want adapter proof, not a migrate |
| “Port full SOS brain into DO” | Forks mind; whitepaper overshoots core; C(t) must stay external |
| “Crew/swarm as default” | Field evidence of over-build and cost; Roo archived the category |
| “Pot executes goal cycles forever” | Violates “pot never does unassigned/in-Worker assignee work” |

| This recommendation | Why it wins |
|---|---|
| Rank-only cognition + gated handoff | Matches sealed `BrainPort`, SOS keepable idea, and 2026-09-10 receipts |
| External org + external harness | Matches “door so they keep their agent” |
| CF primitives for durability | Matches paid substrate; ROADMAP adoption survey |
| Verifier as next core | Unique gap no peer owns |

## Acceptance checks (recommendation is “done” when)

1. This doc is the cited decision record for orchestration vs cognition questions.
2. Default rank-only `BrainPort` exists and cannot perform I/O (Slice A).
3. No new dependency on LangGraph/CrewAI/AutoGen/Temporal appears in core.
4. Paperclip/Linear remain board-side; pot does not grow a competing orchestrator UI.
5. Next implementation PRs cite this doc’s keep/build/avoid table.

## Related

- [sos-brain-ranking-policy-path.md](./sos-brain-ranking-policy-path.md) — SOS-specific build path
- [port-interfaces-model-brain.md](./port-interfaces-model-brain.md) — sealed BrainPort
- [mupot-core.md](./mupot-core.md) — four core things + SOS brain keep
- [agent-identity-lifecycle-comparables-2026-07-21.md](../research/agent-identity-lifecycle-comparables-2026-07-21.md) — peer identity/swarm/memory scan
- ROADMAP § Paperclip / adoption survey — org-chart vs wall; CF Workflows
