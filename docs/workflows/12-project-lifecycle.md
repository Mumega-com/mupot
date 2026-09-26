# Project lifecycle (start, revive, recommit, circuit breaker)

A project runs in cycles. At each cycle boundary it must be recommitted or the circuit
breaker archives it; an archived project can be revived through the same start gate a new
project uses. mupot#1532 (revive), #1533 (recommit warning), design:
`docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md`. Cited against
`origin/main` @ `c14ebc8c`.

## Trigger

- **Start / revive**: an admin moves a project `planned → active` (`project_update` or
  `PATCH /api/projects/:id`). A revival is `archived → planned`, then the same start.
- **Recommit**: a workspace admin answers the `project_recommit_due` item on needs_you.
- **Breaker**: the project loop cron tick (`runProjectLoopTick`, `src/projects/loop.ts:193`).

## Actor(s)

Org admin or project manager (start, recommit); `system:project-loop` (breaker and start
gate receipts, `src/projects/start-gate.ts:85`, `src/projects/circuit-breaker.ts:16`).

## Tool/route sequence

1. **Start gate** — `startProject` (`src/projects/start-gate.ts:713`), reached from
   `project_update` (`src/mcp/projects.ts:394`, `:422`) and `PATCH` (`src/projects/index.ts:449`).
   Requires `status = 'planned'` (`:722`). Picks or auto-creates a writable squad, commits
   the squad resource, then reuses an existing start-gate seed task on that squad or
   creates one from the goal (`:782-822`). #1532: pre-existing non-seed tasks on a revived
   project no longer fail the start with `task_seed_failed`; they are kept and a seed is added.
2. **Boundary reset on activation** (#1532) — a fresh `now + cycle` boundary is folded into
   the same UPDATE as the `active` flip (`reset_cycle_boundary_at`, `:826-850`), never a
   second write. `stalled` is not hand-reset; the stall detector must clear it from evidence.
3. **Per-activation receipt** — `recordStartGateActivation` (`:597`), step
   `project_start_activation`, carries old and new boundary.
4. **Recommit-due warning** (#1533) — needs_you source in `src/attention/service.ts:454-585`.
   Raised when the boundary is within 72 h (urgent within 24 h), or when idleness is within
   2 days of the stall threshold, since a stalled project can be archived on the same tick.
5. **Recommit** — one-tap button on needs_you (`src/dashboard/needs-you.ts:101`) posts to
   `POST /api/projects/:id/recommit` (`src/projects/index.ts:491`); MCP `project_recommit`
   (`src/mcp/projects.ts:454`). Writes a `recommit` decision for this boundary only.
6. **Circuit breaker** — `evaluateProjectCircuitBreaker` (`src/projects/circuit-breaker.ts:353`):
   at the boundary, with no receipted recommit, the default is kill → `archived`
   (`cycle_boundary_no_recommit`). `completed`, `archived`, `review` and `planned` are exempt
   (`BREAKER_EXEMPT_STATUSES`, `:110`); `planned` is exempt so a mid-revival project is not
   killed on its stale boundary.

## Human gate

Starting and recommitting are admin actions; the breaker needs none. The recommit is the
human decision that continuation is justified. Doing nothing is a decision to archive.

## Receipt(s) written

All through `workflow_receipts` (`writeReceiptToD1`), no second store:
`project_start_gate`, `project_start_activation`, `blocked_start`, `ghost_start_alarm`
(start gate) and `recommit_or_kill` (schema `mupot.recommit_or_kill/v1`, recommit and kill).

## What the person sees

needs_you shows the project with the reason, e.g. "cycle boundary at … — recommitting
protects only through this boundary (…); archived automatically without one", and a
Recommit button. The project's Wiki tab (`/projects/:id/wiki`, #1534) holds its card.

## Tests that pin it

`tests/project-start-gate.test.ts`, `tests/project-circuit-breaker.test.ts`,
`tests/project-stall-detector.test.ts`, `tests/attention-recommit-due.test.ts`,
`tests/dashboard-recommit-route.test.ts`, `tests/dashboard-needs-you.test.ts`.

## Known gaps

- mupot#1535 — revive-before-boundary can launder the breaker; `stalled=1` left on the row;
  parked-planned revival is invisible; reset guard and loop SQL list unpinned.
- mupot#1536 — a recommit silences the idle warning until one tick before the kill;
  idleness is shared as pieces, not one function; needs_you load cost.
