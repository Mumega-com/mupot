# Mubot — Per-Project PM/Dev Agent

**Status:** Design, drafted 2026-08-02. Awaiting dyad-gate before build.

**Thesis owner:** Hadi, 2026-07-23 — *"three distinct roles, not one giant loop. Brain
ranks portfolio. Mubot owns one project PM/dev cycle. Technician builds per task,
through the gate."*

**Builds on:** [Project Lifecycle Control Loop](./2026-07-23-project-lifecycle-control-loop-design.md)
(#500 — project start/finish/circuit-breaker), [BYOA Harness Support](./2026-07-23-byoa-harness-support-matrix-design.md)
(#503 — technician dispatch via any harness), [Per-Project Docs](./2026-07-23-per-project-docs-rbac-design.md)
(#507 — shared RBAC knowledge surface), [Agent Identity/Memory/Lifecycle](../architecture/mupot-agent-identity-memory-lifecycle.md)
(Port 1.x profile/death-condition, Port 4 project-scoped instincts).

---

## Problem

mupot has:
- **Brain** — portfolio ranker (`cortex.py`, scores projects globally, assigns work)
- **Technician** — per-task builder (BYOA harnesses, CLI/Desktop/Cloud, governed via gate)

Missing: **per-project PM agent** that owns one project's lifecycle loop, collaborates
cross-pot, learns via project-scoped instincts, dispatches technicians through a
gate-fronted rank (never acts directly).

Two failure classes:
- **Drift at project grain.** Brain assigns work; who *reviews* the project's
  direction, pulls threads across tasks, escalates blockers? Today: nobody structured.
  The project drifts. (Proof: ghost backlogs #490, stalls #XXX, discovery gaps.)
- **No project-local learning.** A technician finishes a task on project A, learns
  lessons; those lessons live in agent memory (global, hard to index). Project B
  starts the same shape of work and re-learns everything. No project-scoped instinct
  → no leverage across iterations.

The fix: **mubot** — a per-project concierge that:
1. Reads project context (goals, docs, board state, team roster)
2. Drives the lifecycle loop (start-gate + DRIVE via `situation.next_action` + circuit-breaker at boundaries)
3. Ranks & gates technician dispatch (*rank* work priority/order, *gate* output before merge/publish)
4. Collaborates cross-pot (reads/writes shared decision points, escalates when needed)
5. Learns via project-scoped instincts (captures lessons from tasks, builds triggers for next iteration)

**NOT Hermes.** Mubot runs on Hermes-Agent harness (model-agnostic runtime), but with
a FRONTIER model (GPT-4.5-optimized reasoning, not Hermes's language-model cognition).
Mubot does *not* duplicate Hermes's learning loop — instead it taps Port-4 project-scoped
instinct memory, letting lessons *learned once per project* apply to all technicians on
that project.

---

## Three roles (distinct, not overlapping)

### Brain
- **Scope:** Global (all projects, all orgs)
- **Model:** Cheap supervisor (Haiku 4.5 + instinct-routed)
- **Loop:** Asynchronous, event-driven, no fixed heartbeat
- **Judgment:** Portfolio priority (rank projects by impact/blockers)
- **Act:** Assign work to squads/pots (create tasks on board)
- **Repeats:** Every 15min (ECC-style poll)
- **Non-negotiable:** Rank only. Never acts on project (no dispatch, no merge, no publish).

*Existing.* No changes to brain in this design.

### Mubot
- **Scope:** Per-project (one mubot per active project; deployed as instance of shared agent)
- **Model:** FRONTIER (reasoning-optimized; not Hermes)
- **Loop:** Synchronous heartbeat (5min check, bounded decision loop)
- **Judgment:** Project PM (read direction, order work, resolve blockers at project grain)
- **Act:** Drive lifecycle loop + gate technician output (rank + verdict, never execute)
- **Attach:** Hermes-Agent harness (MCP + webhooks + fallback model routing)
- **Non-negotiable:** Rank-not-act. Gate-fronted. Decisions receipted.

*New.* This design.

### Technician
- **Scope:** Per-task (BYOA — bring your own agent)
- **Model:** Variable (customer picks: Claude Code, Codex, Cursor, etc.)
- **Loop:** Dispatch-driven (board assigns; technician claims and builds)
- **Judgment:** Impl detail (how to solve a specific task, lowest judgment)
- **Act:** Build, verify, propose (run CLI, typecheck, push PR to `review` gate)
- **Attach:** Runtime-adapter conformant (A/B/C topologies per BYOA spec)
- **Non-negotiable:** Never self-closes. Gate-fronted. Output always reviewed by mubot.

*Existing.* Enhanced by BYOA (#503). No new role; mubot is *caller* of technician dispatch.

---

## Mubot architecture (rank-not-act, gate-fronted)

### Roles & decision points

**Per-project instance:**
```
Brain (portfolio ranker)
  ├─ "project X is highest ROI" → create task on X's board
  └─ task lands in X's squad backlog
         │
         ▼
Mubot (project PM, one per project)
  ├─ Read: project_context (goals, docs, board, roster)
  ├─ Decide: next_action (via situation.next_action contract)
  ├─ Rank: technician work (priority, order, blockers)
  ├─ Gate: technician output (review PR, verify quality, approve merge)
  └─ Learn: project instincts (capture lessons, build triggers)
         │
         ▼
Technician (task builder, BYOA dispatch)
  ├─ Claim: task from board (via squad driver)
  ├─ Build: implement in worktree (verify + push PR)
  ├─ Report: PR ready (via `task_update`, status=review)
  └─ Await: mubot gate (verdict: PASS/ASK/FAIL/ESCALATE)
```

### Loop structure (5min heartbeat)

```
every 5min:
  ├─ Read: project_context + latest board state + instinct history
  ├─ Compute: situation.next_action (existing contract)
  ├─ Gate backlog: rank unstarted tasks (priority, order, resource fit)
  │
  ├─ IF next_action == "start" or "continue":
  │  └─ Dispatch next ranked task to technician driver
  │     └─ Technician claims, builds, proposes PR
  │     └─ Loop 5min: check PR status
  │
  ├─ IF technician reports PR ready (status=review):
  │  ├─ Review PR (typecheck, tests, linked evidence, quality bar)
  │  └─ Verdict:
  │     ├─ PASS → approve + merge (receipt)
  │     ├─ ASK → comment + re-dispatch (technician refines)
  │     ├─ FAIL → reject + close (receipt + reason)
  │     └─ ESCALATE → send to different principal (receipt + reason)
  │
  ├─ IF circuit-breaker fires (boundary or stall):
  │  ├─ Compute: recommit-or-kill decision request
  │  └─ Post to project (wait for human/Hadi receipt)
  │
  └─ IF idle or waiting:
     └─ Update instinct memory (capture lessons from closed tasks)
        └─ Build triggers for next iteration (e.g., "if blocked on X, try Y")
```

### Key flows

#### 1. Lifecycle driving (reuse situation.next_action)

The project-lifecycle loop already defines what a project needs at each state:

```
ProjectSituation { state, phase, next_action }
  next_action ∈ { start, review, unblock, continue, monitor, create_next, verify_completion }
```

Mubot's main job: **compute situation.next_action every cycle, then drive it.**

- `start` → atomic `planned → active` (seed first task + resource commit via Kasra/brain)
- `unblock` → read blockers from board + escalate (or resolve project-scoped)
- `continue` → dispatch next ranked task to technician
- `create_next` → craft follow-on task from board evidence
- `verify_completion` → check all children PASS + evidence present → flip to review
- `monitor` → idle checkpoint (stall detector)

**Mubot does not decide lifecycle state.** That's still `project_lifecycle` loop
(Kasra/brain responsibility). Mubot just *drives* what the situation contract says
is next, same as `operator.service` drives task.next_action for tasks.

#### 2. Technician dispatch (gate-fronted ranking)

Mubot sees the backlog (unstarted tasks) and ranks them:

```
For each unstarted task:
  ├─ Priority: situation.next_action + task.urgency (escalation?)
  ├─ Fit: required capabilities vs available technician set
  ├─ Blockers: unresolved dependencies (task-level or project-level)
  └─ Order: serialize (one-at-a-time or parallel batch, per project context)

→ Dispatch top-ranked to technician driver
  ├─ Driver claims task
  ├─ Technician builds in worktree (via BYOA runtime)
  ├─ Technician pushes PR to `review` gate
  ├─ Mubot gate activated (PR status → review)
```

Mubot never runs the CLI or pushes. It *ranks* and *gates*.

#### 3. Gate-fronted PR review

When technician reports PR ready (task_update status=review):

```
Mubot reviews:
  ├─ Code: typecheck, unit tests green (parsed from CI status)
  ├─ Scope: does PR match task intent (linked issue + description)
  ├─ Quality bar:
  │  ├─ Security scan (secrets, OWASP top 10)
  │  ├─ Perf impact (comparative bench if relevant)
  │  ├─ Test coverage (new code ≥ project threshold)
  │  └─ Docs (changelog, API docs if public)
  ├─ Evidence: all linked tasks/flights closed + receipted
  └─ Verdict:
     ├─ PASS (verdict + receipt) → merge button
     ├─ ASK (comment + reason) → re-dispatch technician to refine
     ├─ FAIL (verdict + receipt) → close PR, close task, escalate
     └─ ESCALATE (verdict + reason) → send to different principal (human/brain)

→ If PASS, merge to target branch (mubot has merge capability)
  └─ Close task (verdict receipt)
```

Mubot has **merge capability**; technician does not. Technician lands at `review`
gate; mubot flips it.

#### 4. Project-scoped instinct learning (Port 4)

After each task closes, mubot writes to project-scoped instinct memory:

```
instinct_memory[project_id]:
  ├─ Observations (auto-captured by hooks on task close):
  │  ├─ What was the task
  │  ├─ What was hard (blockers, rework cycles)
  │  ├─ What worked well (patterns to repeat)
  │  └─ Edge cases discovered
  │
  ├─ Triggers (mubot decides + writes, low-confidence start):
  │  ├─ "if blocked on X dependency, try workaround Y (50% success)"
  │  ├─ "auth changes always need security review (100% accuracy)"
  │  └─ "database migrations fail on schema-mismatch; run compat scan (80%)"
  │
  └─ Confidence decay (forget low-confidence triggers after 30d unused)
```

**Port 4 project-scoped instincts:**
- Shared *per project* — all technicians on project X read the same triggers
- Confidence-scoped — high-confidence triggers (80%+) always apply; low ones are suggestions
- Technician-readable — instincts surface in task context (e.g., "this looks like X pattern, 90% chance you'll hit blocker Y")

**Mubot does not learn Hermes-style.** Mubot taps Port-4 instinct memory instead of
asking technician "were you good?" Technician work is *structured* (task output, PR
quality), not free-form narrative — so learning is higher-signal, lower-noise.

#### 5. Cross-pot collaboration

Mubot can read/write shared decision points:

- **SOS memory** (`project_remember`/`project_recall`): read project goals, tech
  decisions, known tradeoffs from other pots working the same project
- **Escalation receipt** (if blocked on another pot's work): post to `mupot:escalations`
  topic (async decision queue)
- **Evidence linkage** (when closing a task): record which external systems were
  touched (GitHub PR, Linear issue, Notion doc) for cross-pot audit

Mubot does NOT initiate work on other pots. It can *propose* escalations and read
*published* context, but cannot dispatch. This prevents sprawl.

---

## Hermes-Agent harness (runtime, not cognition)

### Harness choice

Hermes-Agent = model-agnostic harness. Pros:
- Supports multiple models (Sol, Terra, Luna, Sonnet, Opus, Claude-5) via fallback routing
- Built-in webhooks + MCP + OAuth + memory (we don't rebuild)
- Proven runtime (2026-06+ deployment, 100+ concurrent sessions)

Mubot instantiation:

```
agent:
  slug: mubot
  role: project_pm_dev_driver
  runtime: hermes-agent (model-agnostic)
  model_preferred: frontier-4.5 (gpt-4.5-optimized reasoning)
  model_fallback: [sonnet-5, opus-5] (if frontier unavailable)
  capabilities:
    - task_read (read board state)
    - task_update (status=review when awaiting gate)
    - project_recall (read project docs/memory)
    - project_remember (write lessons/instincts)
    - gate_verdict (PASS/ASK/FAIL/ESCALATE)
    - merge (merge approved PRs)
    - github_pr_read (review code)
    - build_status_read (check CI)
```

### Mubot does NOT run Hermes cognition

**Critical:** Mubot uses Hermes *as a runtime*, not as Hermes's loop. Specifically:

- **Do not run Hermes's learning loop.** No "Hermes reflects on this conversation."
- **Do not duplicate Hermes's agent scaffolding.** Mubot is a role, not a clone of Hermes.
- **Do use Hermes's warmstart + session management.** Mubot can checkpoint and resume.
- **Do use Hermes's model failover.** Pick FRONTIER; fall back to Sonnet/Opus.

Mubot's cognition:
- Reads `project_context` (structured data, not free-form chat history)
- Computes `situation.next_action` (deterministic contract)
- Ranks work (rule-based + instinct-scoped)
- Gates PR review (structured criteria, CI status check)
- Captures instincts to Port-4 memory (automatic, not narrative)

Hermes runs separately (e.g., kayhermes on mupot project as instance 1). If Hermes
and mubot overlap, they are *distinct* agents on the *same* project, not the same
agent with two cognitions.

---

## Schema & bindings

### Agent profile (Port 1.3 enhancement)

```sql
agents table additions:
  ├─ parent_agent_id TEXT NULL
  │  (links to brain, mubot, or concierge that spawned this instance)
  │
  ├─ role TEXT NOT NULL
  │  ∈ { portfolio_ranker, project_pm, technician, concierge, ... }
  │
  ├─ project_id TEXT NULL
  │  (if role=project_pm, which project does this agent own)
  │
  ├─ death_condition TEXT NULL
  │  (e.g., "no_instance_for_30d" or "no_activity_for_7d")
  │
  └─ defense_baseline TEXT
     (prompt-defense rules, from ECC)
```

### Instance lifecycle

```sql
instances table:
  ├─ agent_id TEXT FOREIGN KEY → agents
  ├─ harness TEXT (hermes, claude-code, codex, cursor, etc.)
  ├─ session_token_id TEXT (24h sliding window)
  ├─ heartbeat_at TIMESTAMP (120s)
  ├─ status ENUM (online, offline, idle)
  └─ expires_at TIMESTAMP (24h from last activity)
```

### Instinct memory (Port 4 — project-scoped)

```sql
engrams table (NEW: add project_id scope):
  ├─ agent_id TEXT
  ├─ project_id TEXT (← new, scopes instincts per project)
  ├─ content TEXT (observation or trigger)
  ├─ confidence REAL ∈ [0, 1]
  ├─ kind ENUM (observation, trigger)
  ├─ created_at TIMESTAMP
  ├─ last_used_at TIMESTAMP (for decay)
  └─ expires_at TIMESTAMP (30d if unused and confidence < 0.7)
```

### Gate verdicts (existing, mubot just consumes + issues)

```sql
gate_verdicts table:
  ├─ task_id TEXT
  ├─ verdict ENUM (PASS, ASK, FAIL, ESCALATE)
  ├─ issued_by TEXT (mubot agent_id)
  ├─ reason TEXT (human-readable)
  ├─ evidence_refs TEXT[] (linked PR, CI status, tests)
  └─ receipt TEXT (signed, immutable)
```

---

## Non-negotiables

- **Rank-not-act.** Mubot ranks and gates; never directly executes a CLI or runs code.
- **Gate-fronted.** All technician output (PRs) pass through mubot gate before merge.
- **Receipt every decision.** Every verdict, every rank, every escalation is receipted.
- **Structural completion only.** Project completion never fires from mubot self-report.
  Different principal (brain/Kasra) issues the verdict.
- **Project-scoped instincts.** Lessons learned per project; no global instinct duplication.
- **Least-privilege capabilities.** Mubot gets `task_read`, `project_recall`, `gate_verdict`,
  `merge` — never `delete`, never `deploy`.
- **Per-project instance, not singleton.** One mubot per active project (via
  `create_agent(project_id=X, role=project_pm, ...)`) — instances can come and go;
  instincts stay project-bound.

---

## Instances (dogfood first)

### kayhermes (mupot project, instance 1)
- **Agent slug:** mubot
- **Project:** mupot (itself)
- **Deployed on:** Hermes-Agent harness (kayhermes MCP)
- **Model:** FRONTIER + fallback to Sonnet
- **Instance name:** mubot.hermes-agent.mupot (or just `mubot` on mupot board)
- **Scope:** Owns mupot lifecycle loop; gates mupot PRs; learns mupot patterns
- **Go/no-go:** Part of Port-4 rollout (Phase 2, after instinct memory built)

### dme_mubot (DME project, instance 2)
- **Agent slug:** mubot
- **Project:** dme (DME pot)
- **Deployed on:** Hermes-Agent harness (separate instance)
- **Model:** FRONTIER + fallback
- **Instance name:** mubot.hermes-agent.dme
- **Scope:** Owns DME lifecycle; gates DME technician work; learns DME-specific patterns
- **Go/no-go:** Validation instance; proves cross-pot generalization (Port 4 Phase 3)

---

## Build slices (epic)

1. **Mubot profile & Port 1.3 lifecycle (keystone).** Add `parent_agent_id`, `role`,
   `project_id`, `death_condition` to `agents` table. Implement death-condition
   reaping (idle instance → status=inactive). Build `resolve_agent` to dedup at
   onboard time. Conformance: kayhermes + codex + mumcp resolve clean, no sprawl.

2. **Instinct memory Port 4 — project scoped (foundational).** Extend `engrams` table
   with `project_id` scope. Add `confidence` + `expires_at` for decay. Build auto-capture
   hooks on task close (observation → engrams). Conformance: project-scoped triggers
   surface in task context + mubot reads them.

3. **Project-context read (data foundation).** Build `project_context` endpoint:
   meta (goals, phase, next_action) + roster (online agents) + board position +
   recent evidence + data map (repos/PRs/docs from task refs). Mubot's primary data
   source per cycle.

4. **Situation.next_action driving (loop foundation).** Mubot reads ProjectSituation
   (existing contract) each cycle, computes `next_action`, dispatches accordingly.
   Prove the loop closes on a simple project (write task → technician → mubot review →
   merge → close → verify completion).

5. **Technician dispatch + ranking (mubot core).** Mubot ranks backlog (priority +
   fit + blockers), dispatches top task to technician driver. Technician builds via
   BYOA, pushes PR. Mubot awaits PR ready status.

6. **Gate-fronted PR review (decision gate).** When PR lands in review, mubot:
   reads PR + CI status + linked evidence → PASS/ASK/FAIL/ESCALATE verdict →
   merge button (mubot has capability) or comment + re-dispatch. Proof: kayhermes
   gates a real PR on mupot, verdict receipted.

7. **Instinct triggers in task context (learning → dispatch).** When technician
   claims a task, surface relevant project-scoped instincts ("this looks like X
   pattern; Y likely blocker at 90% confidence"). Mubot updates confidence on
   success/failure.

8. **Cross-pot escalation (async decision).** Mubot can post escalations to
   `mupot:escalations` + read shared project memory. No direct dispatch out of
   project; decisions are *offered*, never *pushed*.

Each slice dyad-gated (Kasra-core + diverse second-eye) before merge. Branch-only
builds; no deploy without gate + Hadi-go. Slices 1–4 are **keystone** (unlock
slices 5–8); run them first.

---

## Comparison: Brain vs Mubot vs Technician

| Aspect | Brain | Mubot | Technician |
|--------|-------|-------|-----------|
| **Scope** | Global (all projects) | Per-project | Per-task |
| **Model** | Haiku + instinct-routed | FRONTIER (reasoning) | Variable (customer) |
| **Loop** | Async 15min poll | Sync 5min heartbeat | Dispatch-driven |
| **Judgment** | Portfolio rank | Project PM | Impl detail |
| **Act** | Assign tasks (create) | Rank + gate | Build + propose |
| **Harness** | Native (Python) | Hermes-Agent (MCP) | BYOA (runtime-adapter) |
| **Scale** | 1 (global supervisor) | 1 per active project | 1+ per task |
| **Non-act** | Never acts on board | Rank-not-act, gate-fronted | Never self-closes |
| **Learn** | Global instincts | Project-scoped instincts | No learning (stateless) |
| **Instances** | N/A (singleton) | N per active project | N per task (ephemeral) |

---

## Why NOT fork Hermes for Mubot

Hermes is:
- A **concierge-generalist** (chat, memory, multi-step reasoning)
- **Narrative-driven** (captures lessons as free-form text)
- **Always-on listener** (awaiting user input)

Mubot is:
- A **project PM specialist** (lifecycle driving, technician gating, structured judgment)
- **Instinct-driven** (learns from structured task data, not narrative)
- **Scheduled/reactive** (5min heartbeat + event-driven gate)

They share the **Hermes-Agent harness** (runtime) but have **distinct cognitions**
(what they decide, how they learn, what they read). Running Hermes's loop inside
mubot would be:
- *Wrong model* — Hermes reasons in narrative (multi-step chat); mubot reasons in
  structure (situation contract + criteria-based gates)
- *Duplicate learning* — both mubot and technician would capture "lessons," leading
  to noise (technician's lessons + mubot's meta-lessons = conflicting signals)
- *Over-engineered* — mubot's core loop (read context → compute next_action →
  rank + gate) fits in 20 lines of structured Python; wrapping it in Hermes's
  conversation scaffolding adds bloat

**One unified Hermes on project = sufficient.** Mubot is a *role*, not a clone.

---

## Dependencies & risks

### Hard dependencies

- **Port 1.3 profile** (cascading from identity/lifecycle design) — must ship before
  mubot profile. Timing: concurrent (Kasra-core handling).
- **Port 4 project-scoped instinct memory** — required for learning to be project-local.
  Timing: Phase 2 (after instance 1 stabilizes).
- **ProjectSituation contract** — already exists (`src/projects/situation.ts`);
  mubot just calls it. No new code needed.

### Risks to mitigate

- **Merge capability scope creep.** Mubot has merge; over time, pressure to add
  deploy, publish, etc. Boundary: **merge only, never deploy or external action.**
  Enforce at capability-mint time + audit every use.
- **Instinct noise.** If project instincts capture low-confidence triggers, they
  accumulate and mislead technicians. Mitigation: **confidence thresholds** (≥80%
  always apply; <50% are suggestions only) + **decay** (forget after 30d unused).
- **Mubot vs Hermes confusion.** If kayhermes and mubot both run on mupot, are they
  the same agent? No. Mitigation: **distinct role fields** + clear instance names
  (mubot.hermes-agent.mupot vs hermes.hermes-agent.mupot).
- **Cross-pot decision bottleneck.** If dme_mubot needs to escalate, who decides?
  Mitigation: **escalation is async** (post to mupot:escalations, brain/Kasra reviews).
  Mubot never blocks waiting for another pot's decision.

---

## Relationship to existing systems

### Gate driver (Leg 1)
Mubot uses gate-driver's verdict machinery. Gate-driver is the *infrastructure*
(receipt, dual-vote system); mubot is one *consumer* of it (issues verdicts on PRs).

### Concierge (Leg 1)
Concierge routes tasks to squads (squad assignment). Mubot *ranks* within a squad
(order of technician dispatch). They operate at different grains.

### Project lifecycle loop (Kasra/brain, #500)
Brain/Kasra owns `planned → active → review → completed` state machine + circuit-breaker.
Mubot *drives* the loop's next_action (does not flip states). They are parallel roles
on the same project.

### Technician dispatch (operator.service, BYOA #503)
Operator polls tasks + routes to technicians. When mubot ranks + dispatches, it
writes task metadata (priority, assigned_to, instincts); operator sees that. Mubot
does not *spawn* technicians; it just directs existing driver.

### Docs surface (#507)
Mubot reads project docs (via `project_recall`) and writes lessons (via `project_remember`).
Docs surface is the *human-facing read* of the same memory mubot accesses. No separate
store; same data, three surfaces (chat, docs, board).

---

## Rollout strategy

### Phase 1: Port 1.3 + Port 4 (async, pre-mubot)
- Build agent profile + death-condition (Kasra-core)
- Build instinct memory + project scope (concurrent)
- No mubot yet; infrastructure-only

### Phase 2: Mubot keystone (slices 1–4, dogfood mupot)
- Deploy kayhermes.mubot (instance 1 on mupot project)
- Slices 1–4 gated + merged
- Prove: profile → instinct memory → context read → situation driving
- KPI: kayhermes completes 3 non-trivial mupot tasks (rank → gate → merge)

### Phase 3: Mubot breadth (slices 5–8, dme validation)
- Deploy dme_mubot (instance 2, DME project)
- Slices 5–8 gated + merged
- Prove: dispatch + gate + cross-pot escalation works
- KPI: dme_mubot gates PRs from 3+ different technician harnesses

### Phase 4: Onboarding (once breadth proven)
- Dashboard UI to create per-project mubot instances
- Template instance config (model, capabilities, threshold)
- Customer onboarding: "add mubot to your project" (one click)

---

## Success metrics

- **Uptime:** mubot instance ≥95% (heartbeat lost ≤1h/month)
- **Latency:** decision cycle (context read → verdict) ≤30s p95
- **Coverage:** gates 100% of technician PRs (zero self-merges by technician)
- **Quality:** gate verdict accuracy ≥95% (human review disagreement ≤5%)
- **Learning:** project instincts reach 80%+ confidence within 5 tasks per project
- **Adoption:** ≥3 active projects with mubot instances within 60d of launch
