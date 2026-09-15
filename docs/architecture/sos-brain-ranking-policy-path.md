# SOS brain → mupot: ranking-policy path (not a brain fork)

Status: investigation + build path, 2026-09-15. Grounded in
[mupot-core.md](./mupot-core.md), [sos-sovereign-brain-and-cortex-system.md](./sos-sovereign-brain-and-cortex-system.md),
[architecture-audit-mupot-vs-sos.md](../architecture-audit-mupot-vs-sos.md),
[port-interfaces-model-brain.md](./port-interfaces-model-brain.md), and the
2026-07-21 orchestration comparables research. Updates by PR only.

## Verdict (one paragraph)

**Do not port the SOS Sovereign Brain into the Worker.** Keep field physics
(coherence C(t), utility gradient, trust tiers, hive evolution, treasury) in the
mind / external measure loop. **Do port the one reusable idea:**
`perceive → rank → dispatch-to-owner → rest`, implemented as a **rank-only**
`BrainPort` policy that reads board + receipts + Hadi's pinned directive and
returns ordered proposals — never wakes, never writes tasks, never bypasses a
gate. That is exactly what [mupot-core.md](./mupot-core.md) keeps from SOS and
what `BrainPort` in `src/types.ts` already seals.

For the wider peer comparison (LangGraph / CrewAI / Letta / Paperclip / Devin)
and the normative keep/build/avoid table, see
[orchestration-cognition-best-fit.md](./orchestration-cognition-best-fit.md).

## What SOS brain actually is

From the SOS loop (`perceive → think → act → remember → report → sleep`):

| Phase | SOS organ | Keep in mupot? |
|---|---|---|
| Perceive | cortex / board / capacity | **Yes** — as `BrainContext` snapshot |
| Think / rank | prefrontal utility + objections | **Yes** — as `BrainPort.decide` |
| Act | harness bodies | **No in-Worker** — owner / Paperclip / external runtime |
| Remember | Mirror / Vectorize | addon (mem0); attribution stays pot-side |
| Report | Telegram / Redis streams | Slack / inbox wakes with seat on envelope |
| Sleep | `sos:wake:*` | rest / noop when no defect; DO alarms only as wake hooks |

The whitepaper's "Edge Brain in AgentDO" sketch is **aspirational and overshoots**
the 2026-09-10 core subtraction: flights/loops/in-Worker goal cycles are on the
remove-or-replace list. The durable product shape is the **ranking routine**, not
a second cognitive daemon inside `workerd`.

## What already exists in this repo

| Piece | Location | Role today |
|---|---|---|
| `BrainPort` types (sealed v1) | `src/types.ts` | Contract only — **no adapter implements it** |
| Port doc | `docs/architecture/port-interfaces-model-brain.md` | Rank-not-act keystone; remaining S3 = default adapter + one swap |
| Human directive | `src/brain/directive.ts` | Pinned steering text for `BrainContext.lastHumanDirective` |
| Task list ATC | `src/tasks/ranking.ts` | Orders actionable tasks for `task_list` / dashboard — **not** BrainPort |
| Goal cycle | `src/agents/loop.ts` `runGoalCycle` | Model proposes + **acts** (spawns) — **bypasses** BrainPort |
| Metabolism | `src/agents/metabolism.ts` | Pulses DOs; mechanical flywheel, no field spin |
| Brain panel | `src/dashboard/brain.ts` | Observe-only C(t) ingest + loop decision feed |
| SOS addon | `src/addons/sos.ts` | Compat publish/bridge; bus coordination retired |
| Coherence caller | `docs/coherence-loop-brain-caller.md` | Brain stays outside; pot records flights/outcomes |

**Gap that matters:** the hexagonal brain port is declared but unused. Planning and
acting are still fused inside `runGoalCycle`. That is the opposite of the seal.

## What mupot can learn from orchestration (field receipts)

From `docs/research/agent-identity-lifecycle-comparables-2026-07-21.md` and
ROADMAP notes on multi-agent frameworks:

1. **Multi-agent orchestration is the most over-built surface.** Roo Code archived
   its orchestration layer; surveyed production swarms often collapse to one good
   agent at lower cost. Mupot should not grow a CrewAI/AutoGen-shaped coordinator.
2. **Swarm stays opt-in per task**, depth-capped — never a default architectural
   layer. Brain ranks *whether* to wake someone; it does not fan out tentacles.
3. **Rank-not-act is the safe swap.** A BYO / sovereign / YC-CEO brain changes
   proposals only; autonomy, capability, budget, and gate stay sealed in core.
4. **Sleep/wake beats always-on orchestration.** Devin-style suspend-and-resume
   matches pot presence + inbox wakes better than a continuous Worker brain loop.
5. **Do not fork field physics.** Audit 2026-06-09: coherence, utility, trust,
   evolution stay in the mind. The pot mirrors field state for orient; it does not
   recompute C(t).
6. **Pipeline modules are fine; "orchestration frameworks" are not.** Pure
   orchestrators already in-tree (`workflows/pipeline.ts`, CMS apply, metabolism
   select+kick) are thin seams over ports — keep that shape for brain apply.

## Build path (ordered, small)

### Slice A — default `BrainPort` adapter (this branch starts it)

Pure function `decide(ctx: BrainContext): BrainDecision` in
`src/brain/ranking-policy.ts`:

- **Perceive:** board statuses, goals/KPI, budget remaining, directive presence.
- **Rank:** prefer finish `in_progress` → claim `open` → surface `blocked` as noop
  attention → `noop` when healthy / empty / budget-starved.
- **Directive:** when `lastHumanDirective` is set, bias the top proposal summary
  toward it (still proposal-only).
- **Never act:** no `Env`, no D1, no bus, no wake.

Wire later (not required to prove the policy): a consumer that turns the top
proposal into a *gated* handoff to an owner seat (Paperclip / Linear addon /
last-resort native board), never into AgentDO spawn.

### Slice B — separate rank from act in the loop

Refactor `runGoalCycle` so proposal generation emits `BrainDecision` (or accepts
an injected `BrainPort`). Core applies through autonomy + meter + gates. Behaviour
preserve first; then delete the act path when mupot#1390 / executor removal lands.

### Slice C — one real swap

Prove the seam with a trivial alternate adapter (e.g. directive-only noop brain,
or a fixture brain for tests). Document how a sovereign brain would plug in without
touching gates.

### Slice D — retire SOS leftovers (ops, not code port)

Stop residual SOS services after caller check; keep addon routes as compat only;
archive Mirror after backup. Service change; Hadi's go.

## Explicit non-goals

- Porting `brain.py` / `cortex.py` / `hive_evolution.py` into TypeScript.
- Rebuilding Redis SOS bus coordination.
- In-Worker autonomous CEO that dispatches without a non-author gate.
- Replacing Linear/Paperclip boards with a richer native orchestrator.
- Expanding flights/loops/circuits as the brain substrate (core says replace).

## Acceptance for "SOS brain made correctly" in mupot

1. A default `BrainPort` adapter exists and is unit-tested without I/O.
2. Stable `BrainContext` → stable ranking (idempotent; rest when noop).
3. No path from brain adapter to task write, wake, or meter spend.
4. At least one consumer applies proposals only through existing gates.
5. Docs and dashboard language say **rank-only policy**, not "sovereign brain in pot".

## References

- [mupot-core.md](./mupot-core.md) — SOS brain = the one idea worth keeping
- [port-interfaces-model-brain.md](./port-interfaces-model-brain.md) — sealed BrainPort
- [sos-sovereign-brain-and-cortex-system.md](./sos-sovereign-brain-and-cortex-system.md) — SOS loop map
- [architecture-audit-mupot-vs-sos.md](../architecture-audit-mupot-vs-sos.md) — mind/body boundary
- [coherence-loop-brain-caller.md](../coherence-loop-brain-caller.md) — brain stays outside
- [sos-coordination-compat.md](./sos-coordination-compat.md) — bus retired
- Issue lineage: substrate #167 S3 (ports), #70 (coherence seam), #22 (ATC ranking scope)
