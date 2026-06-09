# Flight Operations — running expensive agents as disciplined flights

> A **flight** is one bounded run of an expensive agent toward a goal. Internally we
> call it a flight (the aviation discipline is load-bearing); in code/API the
> ecosystem-standard word is **session**. This doc is the organizing model.

## Why aviation, not poetry — the cache forces it

The Opus prompt cache has a **~5-minute TTL**. A cold start or an expired-mid-run cache
costs roughly **double**. So an expensive run cannot be stop-start — it must be **one
continuous warm-cache burst**: stage everything *before* the meter starts, then fly
straight to landing. That is an airline: you don't board passengers with the engines
running and the gate empty.

**Idle = cache cools = double cost.** That is the single thing this model designs out.

## The model

| Aviation | What it is here | Status |
|---|---|---|
| **Flight** | one **session** = a goal run, bounded takeoff→landing | sessions exist |
| **Captain** | the lead **Opus** agent driving the flight | ✅ |
| **Crew** | the flight's **own subagents/specialists**, provisioned for *this* goal, land with it | ✅ squads/subagents |
| **Preflight checklist** | **readiness gate** — context loaded, tools/MCP connected, data fetched, cache warm, budget allocated, goal/KPI set — GREEN *before* the expensive meter starts | partial (gates) → **#60** |
| **Ground crew / airport** | the **cheap always-on** layer (brain, heartbeat agents) that stages the gate so the captain boards a ready cabin | ✅ brain |
| **Fuel** | the **cache** — keep it hot, fly continuous | — |
| **ATC / dispatch** | the **scheduler/router** — when flights depart, sequencing | routines (future) |
| **Flight recorder (black box)** | **cost accounting + audit trace** | ✅ execution-meter |
| **Landing** | results committed, **state externalized** (sessions are ephemeral), cost recorded, cache released | partial |
| **Flight board** | the Fleet view — who's flying (running) / sleeping (next departure) / cost | #45 → **#61** |

## The one discipline that unlocks it

A **preflight checklist gate**. The cheap **ground crew** (brain / heartbeat agents)
assembles the flight plan and stages *everything*; only when the checklist is **GREEN**
does the **expensive captain launch**. So **zero Opus tokens burn on setup or waiting**.
Captain flies one warm-cache burst, lands, the black box records the cost. Between flights
the agent is **sleeping** (next departure on the board), not dead.

This *simplifies*: one coherent ops model over five scattered concerns — cost, readiness,
crew, audit, scheduling.

## The control law — one score + two checks

The preflight gate is not a vibe. It's a **coherence score** plus **two go/no-go checks**,
all computed from signals the pot already logs. Plain numbers, no new machinery.

**Coherence score (0–1)** — how healthy a flight is, combined from factors we already have:

| Factor | Signal | Healthy |
|---|---|---|
| cache readiness | is the context cached / will it stay cached | warm |
| context complete | the flight plan is fully loaded (goal, data, prior state) | nothing missing |
| tools reachable | every tool/MCP the flight needs answers | all up |
| budget headroom | enough budget allocated for the whole flight | yes |
| progress signal | recent useful progress, low retry/error rate | trending up |

Combine the factors into one 0–1 score. A flight launches only when the score is above a
set threshold **and both checks below pass**.

**Check 1 — progress beats waste.** Estimate useful progress per step vs tokens burned per
step. If a flight burns more than it advances, it will **wander** (drift around the problem,
spending without closing it). Wandering flight → don't launch; a flight that starts
wandering mid-air → land it. *(This is the single most common expensive-agent failure: busy,
not progressing.)*

**Check 2 — cache stays warm.** Each planned step must land inside the cache window (~5 min)
so the cache stays hot. If steps are too slow or too gappy, the cache cools and the next call
roughly **doubles** in cost. Too-cold a plan → restructure (shorter steps, pre-fetch
everything in preflight) or don't launch.

**In flight, watch two things:**
- **Score trend** — if the coherence score is *dropping*, that's an early warning: land
  before it collapses (cheaper than a failed landing).
- **The two checks** — progress stalls (waste > progress) or cache goes cold → abort/land.

**Selection rule:** when choosing between flights or paths, prefer the one with the higher
**sustained progress**, not the one with more activity/tokens. Busywork is not coherence.

**Honest guard (don't trust the score blind).** Only rely on the coherence score where it
actually predicts flight cost/outcome **better than a dumb baseline** — e.g. "cache cold +
no progress in N steps → abort." Pre-pick the factors *before* measuring, then check on held-
out flights whether the score beats the dumb rule. If the dumb rule does just as well, use
the dumb rule. Measure before you trust; keep it simple where simple wins.

## Vocabulary (adopted)

`loop` (the think→act→observe cycle) · `routine` (a saved config + trigger that fires
runs) · `session` (one bounded run = a flight) · `sleeping` (scheduled rest between
flights) · `heartbeat` (liveness for cheap always-on agents) · `model routing` /
`cascade` (cheap first, escalate to expensive). Keep `flight`, `captain`, `crew`, `DMN`,
`prefrontal`, `System 1/2` as **internal** metaphors — not in API/user surfaces.

Two presence sources, by agent tier:

| Agent tier | Presence from | States |
|---|---|---|
| cheap **always-on** (brain, Hermes/openclaw daemon) | **heartbeat** + TTL | active · idle · dead |
| expensive **session** (Opus captain) | the **routine schedule** | running · **sleeping (next 14:00)** · done |

## What is this version vs future

**v0.19 (now):**
- **#60** preflight checklist gate — the coherence score + the two checks (progress-beats-waste,
  cache-stays-warm). GREEN before the expensive meter starts. The core money-saver.
- **#61** flight board — Fleet shows running/sleeping + per-flight cost + the coherence score and
  its trend (the early-warning).
- **#62** sleeping / schedule-aware presence + vocab adoption.

**Future (post-0.19):**
- ATC / dispatch — multi-flight sequencing + automatic departure scheduling (routines).
- Cache-warm automation — the harness actively keeps the cache hot for the flight's
  duration; abort/relaunch policy on cache expiry.
- Cascade / model routing — cheap router handles the easy legs, escalates only the hard
  legs to the captain.
- Crew provisioning automation — spin a flight's specialist crew from the flight plan,
  land them with the flight.

See [ROADMAP.md](../ROADMAP.md) for how these land across versions, and
[CHANGELOG.md](../CHANGELOG.md) for what has shipped.
