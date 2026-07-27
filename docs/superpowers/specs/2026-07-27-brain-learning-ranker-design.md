# Brain = Learning Ranker (Port-4 Instinct Loop)

**Status:** Design, drafted 2026-07-27. Design + contract only — no route, no
migration, no BrainPort shape change, no Hermes cutover. Awaiting dyad-gate
(Kasra-core correctness + diverse second-eye) before any build slice starts.
Unassigned = backlog, not active.

**Thesis owner:** Hadi, 2026-07-23 owner-experience / mubot session — *"replace
brain with a hermes gateway that learns from fuck-ups?"* Sharpened in-session:
the **learning** is the instinct loop (not the gateway); keep **rank-not-act**
(act-on-fabrication was the `#490` failure class); Hermes harness = **optional
resilient runtime**, not the learning mechanism.

**Builds on:** owner-experience artifact (2026-07-23),
[BrainPort seal](../../architecture/port-interfaces-model-brain.md) (rank-only),
[Port-4 instinct memory](../../architecture/mupot-agent-identity-memory-lifecycle.md)
(dormant task `b143e73d` / branch `cursor/task-b143e73d`),
[ECC continuous-learning-v2.1](../../architecture/ecc-as-agent-runtime.md),
`src/tasks/ranking.ts` (ATC list ordering), `src/tasks/effort-route.ts` (narrow
assign|skip|escalate — no restart/heal), hermes `experience.json` scaffold
(`agents/mumega-brain/hermes/scripts/experience.py`), project lifecycle
start-gap notes on `#490` ([lifecycle design](./2026-07-23-project-lifecycle-control-loop-design.md)),
PRs #500 / #503 / #507 as the same owner-experience backlog cluster.

**Machine contract:** [`docs/brain-learning-ranker-v1.json`](../../brain-learning-ranker-v1.json)
+ pure TS [`src/brain/learning-ranker-contract.ts`](../../../src/brain/learning-ranker-contract.ts).

## 0. Problem

Two tempting mistakes keep getting proposed as one:

1. **Replace the brain with a Hermes gateway** so "it can learn." That conflates
   *runtime resilience* with *learning*. A gateway that acts is still an actor.
2. **Let the brain act on what it learns** (restart a "down" service, heal a
   phantom outage, invent work from a fabricated backlog). That is the `#490`
   failure class — act-on-fabrication — and it breaks the sealed BrainPort
   keystone: **RANKS / PROPOSES — never acts.**

What we actually need: when a fuck-up is caught (wrong citation, false
restart, empty/phantom backlog treated as a real defect), that receipt must
become a **project-scoped instinct** that the ranker **recalls** next time —
so the *same* failure is demoted or forced to `noop` / escalate, without the
brain growing new action verbs.

## 1. Two roles (non-negotiable contrast)

| | **Brain = learning RANKER (this design)** | **Anti-pattern = learning ACTOR** |
|---|---|---|
| Role | Idempotent portfolio ATC: score / order / propose | Autonomous operator that executes side effects |
| Learning | Port-4 instincts recalled **at rank** | Instincts that trigger tools / restarts / merges |
| Output | `BrainDecision.ranked` proposals only | Direct motor calls that skip the gate |
| Runtime | Any: metabolism Worker, BYO brain, **optional** Hermes | "Hermes gateway *is* the brain" |
| Hot path | **0 LLM** — recall + pure bias only | Distill / frontier in every rank tick |
| `#490` stance | Fabrication ⇒ demote / `noop` / escalate | Fabrication ⇒ restart / heal / invent work |

Hermes stays useful as an **optional harness** for the brain *process* (warm
restart, frontier model for hard calls, durable daemon). It is **not** the
learning mechanism and **not** a license to act.

## 2. Thesis (one line)

**Receipts distill into gated instincts; rank recalls them; the core still
gates every proposal — the brain never becomes an actor.**

```
 gate FAIL / fabrication receipt / caught fuck-up
      │
      ▼
 ┌─────────────────────────────────────────────┐
 │  Port-4 observe (project-scoped)            │
 │  append observation from RECEIPT only       │
 └─────────────────────────────────────────────┘
      │
      │ offline / bounded cron (cheap model)
      ▼
 ┌─────────────────────────────────────────────┐
 │  distill → atomic instinct                  │
 │  {trigger, confidence, decay, domain}       │
 │  + evidence pointing at the receipt         │
 └─────────────────────────────────────────────┘
      │
      │ promote only via Port-4 gates (≥2 projects)
      ▼
        durable project instincts
      │
      │ at rank time (hot path, no LLM)
      ▼
 ┌─────────────────────────────────────────────┐
 │  sealed core loads BrainContext             │
 │  + RECALL gated instincts matching board    │
 │  brain.decide(ctx) → ranked proposals       │
 │  pure bias: demote / prefer noop / clamp    │
 └─────────────────────────────────────────────┘
      │
      ▼
   autonomy + capability + budget gates  →  act or hold
```

## 3. What already exists (reuse, do not rebuild)

| Piece | Where | Role here |
|---|---|---|
| BrainPort (rank-only) | `src/types.ts` `BrainPort` / `BrainDecision` | Unchanged role; learning feeds **context + bias**, not new verbs |
| Task ATC ranking | `src/tasks/ranking.ts` `rankTasks` | List ordering; instincts may later annotate bands — still pure |
| Effort router | `src/tasks/effort-route.ts` | Narrow `assign\|skip\|escalate` — template for "no restart/heal" |
| Port-4 instinct domain | dormant `cursor/task-b143e73d` (`src/memory/instinct*.ts`) | Confidence clamp, decay, inject filter, promote gate, distill parse |
| ECC continuous-learning-v2.1 | `docs/architecture/ecc-as-agent-runtime.md` | Atomic instincts + project scope + confidence |
| Hermes experience store | `experience.py` / `experience.json` | Mechanical reliability deltas; **hot path = 0 LLM**; clamped learn weight |
| Gate + receipts | gate-driver + FRC | Sole world-affecting path; distill **inputs** must be receipted |

Port-4 on `b143e73d` is **dormant / not on main**. This design wires the
*learning → rank* seam; it does not merge or re-implement that branch. Build
slices may consume Port-4 once dyad-gated and landed.

## 4. Key design decisions

1. **Brain role stays RANKER/ATC.** `BrainPort.decide` still returns
   `BrainDecision` only. No new proposal kinds (`restart_service`, `heal`,
   `merge`, `deploy`) — ever. Instincts may push `noop`, lower `priority`, or
   rewrite `summary`/`doneWhen` text; they may not invent motor verbs.
2. **Learning mechanism = Port-4 instinct loop**, not "swap brain for Hermes."
   Capture → cheap distill → atomic `{trigger, confidence, decay, domain}` →
   project scope → RECALL-at-rank.
3. **RECALL-at-rank is core-side injection.** The sealed core (or a pure
   adapter wrapping `decide`) loads eligible instincts into a sanitized
   `BrainContext` extension / parallel snapshot **before** `decide`. The brain
   adapter never holds Env/DB/fetch for instincts — keeps the port
   capability-free by type.
4. **Hot path = 0 LLM.** Rank ticks recall stored instincts + apply pure bias.
   Distill runs offline (bounded job / Hermes background), matching
   `experience.py`'s "0 LLM calls in any hot path" law.
5. **Distill inputs are receipted fuck-ups only.** Allowed sources:
   gate FAIL receipts, fabrication / false-positive incident receipts,
   human correction receipts tagged as such. Forbidden: raw agent self-report,
   unverified board diffs, model "I think we failed" notes. This is the
   self-poisoning fence.
6. **Instincts are triple-gated before they may bias rank:**
   - **confidence** after **decay** ≥ inject threshold (Port-4 defaults:
     floor 0.3, ceiling 0.9, inject ≥ 0.7, half-life 30d)
   - **domain** allowlisted for rank bias (`rank-discipline`, `routing`,
     `citation`, `lifecycle` — not arbitrary free text execution)
   - **gate-fronted**: biased proposals still cross autonomy + capability +
     budget; an instinct never bypasses a gate and never grants a new
     capability
7. **Hermes is optional runtime.** A pot may run the ranker inside a Hermes
   harness with a frontier model for *hard* offline distill or rare
   non-idempotent re-rank reviews — never as a substitute for BrainPort, never
   as an ungated actor.
8. **`experience.json` remains a mechanical signal**, not the fuck-up
   instinct store. Reliability / stall rates may continue to clamp-adjust
   scores; structured "don't do X again" lives in Port-4 instincts.

## 5. Worked example — `#490` class → instinct → next rank

**Fuck-up:** brain treats a fabricated / mis-attributed outage (or empty phantom
backlog) as a real defect and proposes a side-effecting repair (false
service restart / invent work).

**Receipt:** gate or human marks the proposal / flight as FAIL with reason
`fabrication` or `false_restart`.

**Distill (offline, cheap model):**

```yaml
id: no-act-on-fabrication
trigger: "when evidence for an outage or empty backlog is missing, stale, or fabricated"
confidence: 0.85
domain: "rank-discipline"
scope: project
---
## Action
Prefer noop or escalate; never propose restart, heal, or invent work from the fabrication.
## Evidence
- receipt:<id> (#490-class false-service-restart / act-on-fabrication)
```

**Next rank:** core recalls the instinct (confidence after decay ≥ 0.7). Pure
bias demotes any matching `spawn_task`/`wake_agent` whose summary matches the
trigger pattern, or replaces it with `noop` + rationale citing the instinct id.
Core gates still apply — if something must run, a human/directive or a
receipted defect must authorize it.

## 6. Data / port deltas (draft — validate in dyad-gate)

No migration and no `BrainPort` version bump in this design commit.

Future additive (non-breaking) shape for the rank snapshot the core loads:

```ts
// Sanitized, capability-free — parallel to BrainContext pulses.
interface RankInstinctSnapshot {
  id: string
  trigger: string
  confidence: number // already decayed + threshold-filtered by core
  domain: string
  action: string
  projectId: string | null
}
```

Persistence stays on Port-4 tables (`instincts` / `instinct_observations`) once
that branch lands. This design only locks the **rank bias contract**.

## 7. Rank pipeline (pure contract)

Encoded in `src/brain/learning-ranker-contract.ts` and
`docs/brain-learning-ranker-v1.json`:

1. `loadBoardContext` — sanitized goals/board/pulses/directive/budget.
2. `recallInstincts` — project (+ optional global) instincts, decayed + filtered.
3. `gateInstincts` — confidence + domain allowlist + inject cap (fail closed).
4. `decide` — `BrainPort.decide(ctx)` (existing; may be mechanical or model-backed).
5. `applyInstinctBias` — pure reorder / demote / prefer `noop` from gated
   instincts (still proposal kinds only).
6. `emitDecision` — `BrainDecision` to sealed core.
7. **end** — core applies autonomy + capability + budget; brain process holds.

Illegal (must fail closed): LLM distill inside the hot rank path; instinct that
introduces a forbidden action verb; bias that skips a gate; distill from
non-receipt sources; treating Hermes attach as "brain may act."

## 8. Boundaries / non-negotiables

- Brain **never** writes tasks, restarts services, merges, deploys, or verdicts.
- Instincts **never** execute; they only bias ranking / proposal text.
- Self-poisoning fence: receipted inputs only + confidence/decay + inject
  threshold + domain allowlist + Port-4 promote gate for global scope.
- Optional Hermes ≠ learning; learning ≠ acting.
- Does **not** merge dormant Port-4 (`b143e73d`) in this commit.
- Does **not** change live `rankTasks` / `effort-route` behavior in this commit.

## 9. Build slices (after dyad-gate — not this commit)

1. **contract-lock** — this design + JSON + pure module + tests (DONE here).
2. **port4-land** — gate + merge Port-4 instinct substrate (`b143e73d`) or a
   slimmed equivalent on main.
3. **receipt-observe** — map gate FAIL / fabrication receipts → observations.
4. **offline-distill** — cheap-model job; hot path remains LLM-free.
5. **recall-at-rank** — core injects gated `RankInstinctSnapshot` + pure bias
   wrapper around `BrainPort.decide`.
6. **optional-hermes-runtime** — document/attach Hermes as resilient host for
   brain process + distill worker only.

## 10. Non-goals

- Replacing BrainPort with a Hermes Sessions gateway.
- Making the brain an autonomous actor / motor.
- Applying Port-4 migrations in this design commit.
- UI for instinct browsing (follow-up).
- Auto-promoting project instincts to global without the ≥2-project gate.
