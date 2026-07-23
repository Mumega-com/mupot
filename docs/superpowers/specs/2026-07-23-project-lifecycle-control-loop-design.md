# Project Lifecycle Control Loop — Start & Finish Guarantees

**Status:** Design, drafted 2026-07-23. Awaiting dyad-gate before implementation.
**Feeds:** the fleet-lifecycle keystone (Mupot Development board `c936f79b`), extended
from *fleet/agent* dormancy to *project* liveness.
**Builds on:** [Project-Centered Workspace Design](./2026-07-17-project-centered-workspace-design.md)
(the data model) and [ECC as the mupot Agent-Runtime Adapter](../../architecture/ecc-as-agent-runtime.md)
(the task-level self-closing loop that this design lifts one level up).

## Problem

mupot has a project **data model** and a deterministic **situation contract**, but no
**driver** at project grain. Two failure classes follow:

- **Start gap.** A `planned` project with no seeded work is a ghost. Nothing forces
  `planned → active` or provisions first work. This is the `#490` failure class — the
  brain staring at an empty/phantom backlog.
- **Finish gap.** An `active` project can stall forever: no open tasks, not `completed`,
  no activity for weeks, and nothing forces a terminal state. It rots silently.

The task lifecycle does **not** have this problem: `mupot-operator.service` polls
`task_list` and drives every task to a terminal state through the gate
(`board → technician → gated PR → verdict → done`, proven E2E on task `774de7d9`). The
fix is to run the *same shape of loop* one level up — with one deliberate inversion (below).

## The load-bearing insight (from comparables research, 2026-07-23)

The best finish guarantee in the industry is **a kill default, not a completion pusher.**

| System | Finish mechanism | Lesson for mupot |
|---|---|---|
| **Shape Up** | Circuit breaker — unfinished work gets **no automatic extension**; to continue it must be re-shaped and re-win the betting table | **ADOPT.** Silent continuation is the disease. Default at a boundary = stop, not extend. mupot has zero analog today. |
| **GitHub Projects** | `closed/merged → Done` — completion fires from a **structural event**, never self-report | **ADOPT.** Flip `→ completed` only from structural PASS, never agent "I'm done". |
| **ECC santa-loop** | Dual-reviewer verdict, **max-N FAIL rounds → hard halt + escalate** | **ADOPT** the cap+escalate wrapper; mupot already has verdict+receipts. |
| **ECC loop-status** | Idle-checkpoint stall detection (detection → decision, not auto-fix) | **ADOPT** as the trigger feeding the circuit breaker. |
| **Linear cycles** | Cycle *ends on schedule*; incomplete issues **auto-carry silently** | **ANTI-PATTERN.** Adopt calendar rollover to *create a review checkpoint*; explicitly reject auto-carry. |
| **PMBOK** | Charter authorizes start; teeth come only when wired to a **real resource commit** (finance/procurement) | **ADOPT.** `planned → active` must mint a real resource (token/capability/seeded task), not just flip an enum. |

## Design

The project control loop is the task loop one level up, with a **circuit breaker at the
boundary instead of a completion pusher.** Three guarantees:

### 1. START — authorize + provision, atomically (no ghosts)

`planned → active` is not a bare enum flip. The transition must, in one governed action:

- seed at least one first task (from the project `goal`) assigned to a squad with
  `write`/`admin` access, **and**
- mint/confirm the resource that lets that squad act (agent-bound token / capability),
  reusing the existing grant path — do not fork provisioning.

If the resource commit cannot be made, the project stays `planned` and surfaces as a
blocked start, not a false `active`. A `planned` project older than a threshold with no
provision attempt escalates to the owner (a ghost-start alarm).

### 2. DRIVE — reuse `situation.next_action` (already built)

Each project-loop cycle, for every `active` project the caller can read, compute
`ProjectSituation` (existing `src/projects/situation.ts`) and dispatch its `next_action`
to the owning squad through the existing task machinery. No new decision logic — the
situation contract already derives review → unblock → continue → start → monitor →
create-next → verify-completion. The loop only *drives* what the contract already *decides*.

### 3. FINISH — structural completion OR circuit breaker (nothing rots, nothing self-certifies)

Two, and only two, ways an `active` project leaves `active`:

- **Structural completion.** All child tasks and their gates are terminal with
  verdict = PASS **and** completion evidence is present → `active → review` → a
  **different-principal gated verdict** (self-verdict blocked, as at task level) →
  `completed`, then `completed → archived` with a lessons-capture receipt. Never flips
  from an agent's self-reported "done".
- **Circuit breaker at the boundary.** At a cycle/phase boundary (or when the stall
  detector fires), if status ≠ `completed`, the loop does **not** silently continue.
  It writes a `recommit_or_kill` decision request; the project cannot remain `active`
  past the boundary without a **receipted** recommit (agent-or-Hadi-go, scaled by
  stakes). Absent a recommit, default action is **kill → `archived`** (with reason),
  not extend. This is the Shape-Up inversion: continuation is the thing that must be
  justified, not termination.

### Stall detection (feeds the breaker)

Each poll, compute idle-duration per active project (max of: newest task activity,
newest flight event, newest evidence). Past a per-project threshold, set a `stalled`
flag. `stalled` does not auto-fix — it **raises the circuit-breaker check early** so a
rotting project reaches the recommit-or-kill decision instead of drifting.

## Schema deltas (draft — validate in dyad-gate)

- `projects`: add `cycle_boundary_at TEXT NULL` (next boundary at which the breaker
  evaluates), `stalled INTEGER NOT NULL DEFAULT 0`, `stall_threshold_days INTEGER NULL`
  (NULL = tenant default).
- New receipt/decision type `recommit_or_kill` (recorded through the existing receipt
  path — no second store), capturing: project_id, boundary_at, decision
  (`recommit` | `kill`), principal, reason.
- No new state store. Projects, tasks, flights, activity, evidence, receipts remain the
  single source of truth (per the v0.24 Project Operations global constraint).

## Boundaries / non-negotiables

- Completion never fires from agent self-report — structural signal + different-principal
  verdict only.
- The breaker's default is **kill, not extend**. Recommit is the exception and must be
  receipted.
- START must commit a real resource; a status flip without provision is forbidden.
- Reuse `situation.next_action`, the task-driver loop, the gate/verdict path, and the
  receipt store. This design adds a *boundary and a start-gate*, not a parallel engine.
- Tenant + capability filtering preserved; a project loop never acts outside the caller's
  readable scope. No weakening of signed inbox fencing, token welding, or release gates.

## Build slices (smallest-shippable first)

1. **Circuit breaker slice** — `cycle_boundary_at` + `recommit_or_kill` receipt +
   boundary evaluation on the existing loop (kill default). Smallest thing that stops rot.
2. **Structural-completion gate** — `active → review → completed` driven by
   all-children-PASS + evidence, different-principal verdict.
3. **Start-gate** — atomic `planned → active` = seed-first-task + resource-commit; ghost
   alarm on stale `planned`.
4. **Stall detector** — idle-duration per active project → `stalled` flag → early breaker.
5. **Cycle creation** — calendar rollover to schedule boundaries (creation only; NO
   auto-carry).

Each slice is dyad-gated (Kasra-core + diverse second-eye) before merge. Arms build on
branches only; no deploy without Kasra-core gate + Hadi-go.
