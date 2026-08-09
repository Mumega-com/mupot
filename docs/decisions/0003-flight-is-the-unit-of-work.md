# 0003 — The flight is the unit of work; sprints are retired

**Status:** accepted
**Date:** 2026-08-09

## Decision

The **flight** is the unit of work. Sprints are retired from mupot.

## Evidence, not preference

| | code references | tables |
|---|---|---|
| flight | 781 | 2 (`0017_flights`, `0046_flight_event_outbox`) |
| sprint | 16 | 0 |

Sprint survives only in SOS's `sprint_telemetry`, from the older system.

## Why it is also correct

Sprints are time-boxed because **humans** are time-boxed — two weeks exists because people go home, and the calendar is the shared constraint.

Agents are **context-boxed**. The binding constraint is fuel: context, cache warmth, cost. A flight ends when the fuel does, not when Friday does. That is why the aviation model fits — preflight readiness, captain, crew, a landing that externalises state and records cost.

The session that produced this decision was compacted twice. That is refuelling mid-air. A sprint has no vocabulary for it; a flight does.

## Honest caveat recorded at acceptance

As of this date **no flight had ever landed carrying real work.** The board read 4 landed / 6 running / 4 held, and all four landings were trivial smoke tests. Six were stuck `running` at cost 0 because prod lacked #864, so `dispatch` created a row and never sent an envelope.

We work in *shifts* and call them flights. A flight is ONE bounded goal; a shift is whatever the human is awake for. The session accepting this decision spanned six workstreams — itself a shift, not a flight.

## Where flights live

Milestones are already used for releases, so flights use **labels plus tracking issues** — a label works on issues *and* PRs, which milestones and sub-issues do not.

`flight:F-NN` per flight, plus `flight` on each tracking issue. Live board:
`github.com/Mumega-com/mupot/issues?q=is:open+label:flight`

Each tracking issue carries a real `done_when`, its gate owner, and its blockers. Projects v2's Roadmap view provides a live Gantt when wired.

## Granularity, so these stop being conflated

| Purpose | Unit |
|---|---|
| Work | flight — one goal, fuel-bounded, lands with a receipt |
| Gate | the PR at an exact head |
| Record | the decision (this folder) |
| Backlog | task with `done_when` |
