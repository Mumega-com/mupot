# The coherence model — how all agents and all work stay coherent

> The one question this answers: with many agents, many repos, many surfaces, and a growing
> portfolio — **how does it all stay coherent instead of scattering?** The answer is not one
> component. It is **the brain running a measure → correct loop on four shared rails.** Every
> agent reads the same state, writes the same backlog, passes the same gate, shares the same
> memory; the brain watches the whole and corrects drift. This doc is the north star every
> agent reads.

## The four rails — one of each, or it scatters

| Rail | The one place | Kills the scatter of… |
|---|---|---|
| **Work** | GitHub — issues = the backlog, **PR = the gate** | scattered task lists / duplicate effort |
| **State** | the pot — Fleet + flight board + tasks | agents acting blind to each other |
| **Gate** | PR approval + `/approvals` | unreviewed output drifting |
| **Memory** | pot memory + brand-crystal | agents reinventing / going off-brand |

A new project becomes a new **pot** with the same four rails. Learn the rails once → operate
any project. (How an agent learns a pot: [pot-operating-context.md](pot-operating-context.md).)

## The engine — the brain's measure → correct loop

The brain (`SOS/sovereign/brain.py` + `coherence.py`) is the **coherence organ**. Its job is
coherence, not output. It is cheap and always-on, and it **rests at equilibrium** — it acts
only on a real defect.

```
  brain MEASURES coherence        C(t)=EMA(success-fraction) · R=1/(1+backlog)
        │                          ARF=R·Psi·C (defect-activation) · regime (flow|chaos|coercion|stall)
        ▼
  detects a DEFECT                ARF spikes / regime→chaos|stall / failing check / stale|duplicate work
        │                          (ARF ≈ 0 + flow  →  nothing to do, rest)
        ▼
  tees up a FLIGHT                one gated, recorded, cost-metered prefrontal burst — ONLY on a real defect
        │
        ▼
  flight CORRECTS via the rails   reads GitHub backlog + pot state → does gated work → lands
        │
        ▼
  state UPDATES                   GitHub + Fleet + memory
        │
        └─────────────  brain re-measures → loop closes ─────────────┘
```

Coherence is *held* by this loop, not by any single part. Agents don't drift because the loop
detects drift (as falling C, rising ARF, a chaos/stall regime, a red check, a stale task) and
spends one expensive correction on exactly that — then rests again.

## Who owns what (no duplication)

| Concern | Owner |
|---|---|
| **Coherence** measurement (C, R, Psi, ARF, regime) + **whether to fly** | the **brain** (`coherence.py`) |
| The **cycle** (perceive→think→act→remember→sleep), **model tiering**, **budget gate** | the **brain** (`brain.py`) |
| **Readiness** (is a flight ready to launch) + the **flight record** | the **pot** (`src/flight/`) |
| The four **rails** (work/state/gate/memory) per project | the **pot** |

"I am the prefrontal, not the brain": the brain is ground crew — it perceives cheaply, decides
whether a flight is worth it, and tees it up; the expensive prefrontal burst (the flight) only
runs on a teed-up defect. The pot does NOT compute its own coherence — it reads the brain's.

## What's built vs the gap

Built (this is the parts list, mapped to the loop):
- **State rail** — pot-native Fleet + check-in (v0.18, live on digid).
- **Unit of correction** — the flight spine + preflight/readiness gate (v0.19).
- **Coherence organ** — the brain's C(t)/regime, live in `SOS/sovereign`; plus (v0.20) the
  pot's **fallback brain** (`src/brain/`) — a minimal local measure (C/EMA + backlog →
  flow|chaos|stall) that runs ONLY while no mind is connected and yields to a fresh mind
  push (field provenance: `agent_field.source`).
- **Work rail / Gate** — GitHub issues + PR approval + `/approvals`.
- **Memory rail** — pot memory + brand-crystal.
- **The verified seam** (v0.20) — the #70 wire is no longer trust-only: landed cost is
  reconciled against the pot's own meter, individual absent signals are rejected, dispatch
  has an hourly fuse, and the gate reads the pot's OWN outcome history (`agent_unreliable`).

**The wire decision (was the v0.20 open question): resolved as HYBRID.** The pot does not
port the full physics and does not stay brain-blind: it ships the smallest honest local
measure so a sovereign fork closes the loop alone (zero-ops promise holds), and the moment a
real mind pushes field state the fallback stands down — mumega pots run on `SOS/sovereign`.
Extending `src/brain/` toward the full field physics (Psi, ARF, coercion, trust, spin) is
forking the brain — don't; wire the mind instead.

**The remaining gap:** the forked SOS brain as the LIVE caller on a tenant pot (dispatching
flights + pushing field state in production) — rides v0.22 digid go-live. See
[ROADMAP.md](../ROADMAP.md).

## The one rule for every agent

> Read the rails before you act. Write work to GitHub, not a private list. Pass the gate —
> never send/publish/merge on your own. Read shared memory; don't reinvent. If you measure or
> correct coherence, you are extending the brain — never fork it. Rest when there's no defect.
