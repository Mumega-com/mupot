# Architecture audit — mupot vs SOS/sovereign (2026-06-09)

> The question (Hadi): *"Did we build mupot as a microkernel grounded in SOS/Mumega, or did
> a Claude start a fresh codebase from scratch?"* — answered from evidence (read both trees),
> not memory. Also: where do the **field physics** (basin / spin / orbit / no-crash) live?

## Verdict

**mupot was NOT built as a microkernel on SOS.** It is an independent Cloudflare/TypeScript
reimplementation of the **body** (org structure, RBAC, identity, task lifecycle, durable
execution, dispatch spine, metabolism heartbeat, presence, channels, dashboard, gated acts,
cost metering). It vendors/imports **zero** SOS code — every `SOS` token in mupot is a comment.

The **field physics live entirely in SOS/sovereign (Python), not in mupot.** SOS is the
**mind**: the coherence field, the spin, the economy, the evolution. mupot recently (this week,
#68 + #70) started *deferring* to that mind instead of faking a local copy — which is the
correct direction, just days old.

So: not a fork of the brain's organs (it never had them), but a parallel body that drifted
into reimplementing some concepts (its own readiness/coherence) before the reconciliation.

## Organ matrix (evidence-based)

| Field/organism concept | SOS/sovereign (the MIND) | mupot (the BODY) |
|---|---|---|
| **Coherence C(t) / regime** | `genetics.py` 16D PhysicsState (R, Ψ, C) + regime (flow/chaos/coercion); `brain.py` measures | **Shallow** — `flight/preflight.ts` `readinessScore` only; explicitly *not* C(t); brain pulls outcomes (#70) |
| **The gradient / control law** | `goals.py` — utility `U(a)=α·P−β·O+γ·C−δ·R` + Objection model | **Absent** — no utility function; agents spawn tasks per effort budget |
| **Spin (self-motion + identity)** | `genetics.py` learning_strategy + beliefs (hypothesis↔fact); `bank.py` endogenous values (sovereignty/efficiency/alignment/innovation) that *evolve* with metabolic state | **Mechanical only** — metabolism heartbeat pulses agents every ~15m; but knobs are static, outcomes/cost never feed back to modulate them |
| **Basin (scope well)** | `brain.py` `_assert_in_scope` hard wall; squad membership + goal assignment | **Structural** — squad row + work-unit columns; read lazily at cycle time, no induction |
| **Anti-crash (friction)** | `trust.py` 5-tier trust + witness gates + value ceilings; coherence gate `C<0.5` blocks earning | **Partial** — RBAC + budget caps + readiness NO-GO; **no trust/reputation at all** |
| **Free-energy / economy** | `bank.py` + `treasury.py` (Solana MIND) + `bounty_board.py` marketplace | **Governance only** — `execution_meter` cost caps; no earn/incentive, no bank, cost recorded but never read by gates |
| **Evolution** | `hive_evolution.py` recipe winner-keep/loser-rewrite, efficiency gradient | **Absent** — no genome, no mutation, no population dynamics |
| **Onboarding / activation** | `AGENT_TEMPLATE.md` + `squad_activate.py`/`squad_state.py` — config.yml (personality/model/knowledge/channels) + join squad + load shared state | **Structural only** — wizard seeds an agent row; **no orientation ritual, no supervisor binding, no tool catalog, no boot manifest** |
| **Org / RBAC / identity** | squad_router/scheduler/state | **Full + better** — D1 dept→squad→agent, capabilities, member-tokens, channels |
| **Durable execution / gates** | Mirror tasks + Discord approval | **Full + better** — CF Workflows, task_verdicts (immutable), `/approvals`, GHL gated acts |
| **Presence / fleet** | tmux session count | **Full + better** — pot-native check-in, schedule-aware presence |

## The field physics — where each lives (the heart of the question)

- **Basin** (settle into a scope well): SOS `_assert_in_scope` + goal assignment. mupot has the *coordinates* (squad/scope/KPI columns) but no *drop* — agents read scope lazily, there's no induction that places them.
- **Spin** (own rotation / self-motion): SOS `genetics` beliefs + `bank` endogenous values that shift with state = real spin. mupot has a *flywheel* (metabolism pulse) but **no field spin** — static knobs, no outcome→knob feedback.
- **Orbit** (legible trajectory): SOS utility-gradient descent + logged perceive→think→act. mupot has structured loops (perceive→reason→act→observe→stop) — legible, but reasoning-agnostic, no gradient.
- **No-crash** (don't collide/overrun/collapse): SOS trust tiers + coherence-gate + scope wall. mupot has RBAC + budget cap + readiness NO-GO + scope guard — real walls, but **no trust/reputation friction**.

## The body/mind boundary (what this implies)

The two are **complementary, not redundant** — the audit confirms mupot did not re-fork SOS's
organs; it lacks them. Drawn from evidence:

- **Stays in the MIND (SOS):** coherence C(t)/regime, the utility gradient, spin (genetics
  beliefs + bank values), trust tiers, the free-energy economy (bank/treasury/bounty),
  evolution (hive). These are *field* properties — global, stateful, slow.
- **Lives in the BODY (mupot):** org/RBAC/identity, task lifecycle, durable execution, dispatch
  spine (flights), metabolism heartbeat, presence, channels, dashboard, gated acts, cost
  metering. These are *mechanical* — sealed, fast, per-tenant.
- **The SEAM (to build):** the #70 connector is the *dispatch* half. The **orient/induction
  packet is the missing *identity/basin* half** — where a body-agent reads its field state
  (coherence, trust tier, spin/values, scope basin) FROM the mind and gets dropped into orbit.

## Implication for the orient/onboarding work

orient must NOT be a pot-local info dump. It should compose two halves:
1. **Structural half (pot owns):** identity, department→squad, chain of command (supervisor =
   `memberships.capability` lead/owner), exact scope + magnitude (autonomy enum + KPI + assigned
   tasks), tools (RBAC + MCP endpoint + skills), the rails.
2. **Field half (pulled from the mind):** the agent's coherence/regime, trust tier, and spin
   (genetics values) — so the basin-drop carries the real field state, not a pot guess.

That honors *extend-don't-proliferate* and *never-fork-the-brain*, and makes the field physics
real in orientation without porting the brain into the pot.
