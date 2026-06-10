# The coherence-loop brain caller (Python spec)

> Pot-side is built (v0.20): the connector API in `src/flight/routes.ts`. This doc specs the
> **brain side** (`SOS/sovereign`, Python) that closes the loop by calling it. The brain stays
> the **sole** coherence organ — it is never ported into the pot and never forked. The pot
> records flights + serves outcomes; the brain measures C(t) and decides whether to fly. See
> [coherence-model.md](coherence-model.md).

## The loop (what the brain does)

```
  brain MEASURES C(t)/regime  (existing: coherence.py — EMA success-fraction, ARF, regime)
        │
        ▼
  detects a DEFECT            ARF spike / regime ∈ {chaos,stall} / failing check / stale|dup work
        │                     (ARF≈0 + flow → rest; do NOT call the pot)
        ▼
  POST /api/flights           tee up ONE gated, recorded flight for exactly that defect
        │                     ← pot runs the readiness gate; returns go/held + flight id
        ▼
  (executor flies + lands)    the flight does gated work, then reports:
        │                       POST /api/flights/:id/land  {cost_micro_usd, score}
        ▼
  GET /api/flights?since=…    brain pulls landed/failed outcomes since its cursor
        │
        └──  fold outcome into C(t) → re-measure → loop closes ──┘
```

## The pot endpoints (already live)

Base: the pot's origin (e.g. `https://agents.digid.ca`). All require an **org-admin
member-token** as `Authorization: Bearer <token>` (the brain is an org-admin service
principal). Tenant is pot-derived — never sent.

### `POST /api/flights` — dispatch (only on a real defect)
Body:
```json
{
  "agent": "opus",
  "goal": "clear the stalled outreach backlog (regime=stall)",
  "trigger_source": "api",
  "budget_micro_usd": 2000000,
  "signals": {
    "contextComplete": true,
    "toolsReachable": true,
    "budgetRemainingMicroUsd": 5000000,
    "budgetEstimateMicroUsd": 2000000,
    "recentProgress": 0.4,
    "progressPerStep": 0.5,
    "wastePerStep": 0.1,
    "stepSeconds": 20
  },
  "opts": { "scoreThreshold": 0.5, "cacheWindowSeconds": 300, "minProgressRatio": 1 }
}
```
- The brain MUST supply the full `signals` block — the pot will not default a missing block to a launch (it 400s). The brain owns context/budget knowledge; the pot owns the gate math.
- Response `201` `{id, go:true, status:'running', score, reasons}` on GO; `200` `{id, go:false, status:'held', score, reasons}` on a recorded NO-GO (not an error — the gate worked, spend was avoided). Record `id`.

### `POST /api/flights/:id/land` — successful outcome
Body `{ "cost_micro_usd": 1840000, "score": 0.86 }` (both optional; `score` = the flight's
realized coherence 0..1). Idempotent via terminal-state guard. → `{ok, id, status}`.

### `POST /api/flights/:id/fail` — failed outcome
Body `{ "reason": "tool X unreachable after 3 tries" }`. → `{ok, id, status}`.

### `GET /api/flights?status=landed,failed&since=<cursor_ms>&limit=200` — outcome feed
→ `{ flights: [{id, agent, goal, status, score, cost_micro_usd, created_at, ended_at}], cursor }`.
Poll with `since = <last cursor>`; fold each new outcome into C(t):
- `landed` with `score` → a success sample (weight by `score` if you want graded EMA).
- `failed` → a failure sample.
- `cost_micro_usd` → feed the budget/energy accounting.

## Brain-side rules (DO / DON'T)

- **DO rest at equilibrium.** Call `POST /api/flights` ONLY on a real defect. ARF≈0 + flow ⇒ no call. This is also the de-facto throttle on the money path (see WARN below).
- **DO dispatch one flight per defect**, not a swarm. The flight is the unit of correction.
- **DO carry a cursor** (last `GET` cursor) so re-measure is incremental, not a full rescan.
- **DON'T compute coherence in the pot.** C(t)/ARF/regime stay in `coherence.py`. The pot's
  `score` field is the flight's realized outcome, an INPUT to your EMA — not a second C(t).
- **DON'T fork the brain per pot.** One organ (per-tenant scoped instance is fine); many pots.
- **DON'T send `tenant`** — the token + pot decide it. A token dispatches only its own pot.

## Token

Mint an org-admin member-token for the brain principal on each pot (the same member-token
path the flock uses, with an `org/admin` capability grant). Store per-pot in the brain's
secret store. Rotate on the standard cadence.

## Known follow-ups (pot-side, non-blocking)

- ~~**Dispatch rate-limit**~~ ✅ shipped (v0.20): `POST /api/flights` now carries a
  per-tenant hourly fuse — `FLIGHT_MAX_DISPATCH_HOUR` (default 30) → 429 + Retry-After
  before any row is written. The readiness gate + budget cap remain the fine guards.
  Also shipped on the same seam: individual ABSENT signals are rejected
  (`signals_incomplete:<names>` — absent ≠ measured-zero), and `/land` reconciles the
  reported cost against the pot's own meter (flag `cost_reconciliation` in the flight
  meta + response; pass the agents.id as `agent` at dispatch so the meter identity
  lines up). The pot also merges its OWN history into the gate: `agent_unreliable`
  grounds an agent whose recent flights mostly failed, whatever the caller claims.
- **401-vs-403**: a valid-but-non-admin token gets 403, a bad token 401 — a minor
  token-validity oracle, acceptable for a single-tenant pot.
