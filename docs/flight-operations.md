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
- **#60** preflight checklist gate — the core money-saver.
- **#61** flight board — Fleet shows running/sleeping + per-flight cost.
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
