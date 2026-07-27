# Owner Experience — Unify Chat + Docs + Board into One Goal-Directed Surface

**Status:** Design, drafted 2026-07-27. Design + contract only — no route, no
migration, no UI, no ModelPort change. Awaiting dyad-gate (Kasra-core
correctness + diverse second-eye) before any build slice starts. Unassigned =
backlog, not active until pulled.

**Thesis owner:** Hadi, 2026-07-23 mubot/owner-experience session — artifact
`4cb8d84f-b5b9-4a55-a47c-3af193161b19` (*"Your mupot gets better at your
business every week"*). The felt product an owner lives: declare an OUTCOME →
mubot drives the loop → owner sees goal-progress + earned-trust + what it
learned.

**Builds on:** owner-experience artifact (2026-07-23),
[project-centered workspace](./2026-07-17-project-centered-workspace-design.md),
[project lifecycle](./2026-07-23-project-lifecycle-control-loop-design.md) (PR #500),
[BYOA harness matrix](./2026-07-23-byoa-harness-support-matrix-design.md) (PR #503),
[per-project docs RBAC](./2026-07-23-per-project-docs-rbac-design.md) (PR #507 / #522–526),
Tier-2 chat design (`2026-07-27-tier2-stateless-user-chat-design.md`, currently
dyad-gate **BLOCK**), Tier-1 kayhermes panel (PR #505), `ProjectSituation`
(`src/projects/situation.ts`), agent `Autonomy` (`src/types.ts`),
`workflow_receipts` + completion/lessons receipts, BrainPort v1 (rank-only).

**Machine contract:** [`docs/owner-experience-v1.json`](../../owner-experience-v1.json)
+ pure TS [`src/owner/owner-experience-contract.ts`](../../../src/owner/owner-experience-contract.ts).

## 0. Problem

Today an owner meets **three separate products** that happen to share a pot:

| Surface | Intent | Current state (verified 2026-07-27 on this worktree) |
|---|---|---|
| **Chat** (talk to mubot) | Intent in, clarification out | Tier-1 kayhermes panel in review (#505). Tier-2 every-member chat is **design-blocked** (ModelPort has no tools; pot monthly budget display-only; result fan-in unsettled). |
| **Docs** (read/edit knowledge) | Shared memory the mubot acts on | Spec #507 drafted; **no dashboard Docs surface** on main. `project_remember` / `project_recall` exist as MCP. |
| **Board** (watch it work) | Living picture of work | **Wired:** project detail + `ProjectSituation` (health, blockers, reviews, `next_action`), lifecycle loop (start-gate / circuit-breaker / completion / stall). |

Missing is the **relationship**, not another panel: one goal-directed home where
the owner declares an OUTCOME (north-star metric), the mubot drives Sense → Rank
→ Act → Receipt → Learn → Adapt, and the owner always sees **goal-progress +
earned-trust level + what the mubot learned** — honest (receipts, not
fake-green), with trust that widens only on verified wins.

## 1. Thesis (one line)

**Owner owns the goal and the gate; the mubot owns execution and adaptation;
the surface is one relationship with three facets — Talk, Know, Watch —
bound to a single project outcome.**

```
                 ┌────────── owner home (per project) ──────────┐
                 │  OUTCOME strip (north-star + progress truth) │
                 │  TRUST strip   (autonomy + what needs a yes) │
                 ├──────────┬──────────────┬────────────────────┤
                 │   Talk   │     Know     │       Watch        │
                 │  (chat)  │    (docs)    │ (board/situation)  │
                 └────┬─────┴──────┬───────┴──────────┬─────────┘
                      │            │                  │
                      ▼            ▼                  ▼
              intent / Q&A    same memory store    situation + tasks
                      │            │                  │
                      └────────────┴────────┬─────────┘
                                            ▼
                         closed loop (mubot drives; owner gates)
              Goal → Sense → Rank → Act → Receipt → Learn → Adapt ↺
                                            │
                                            ▼
                                    Gate (owner holds)
```

## 2. Seven moments (product arc — from the artifact)

These are acceptance *feelings*, not build slices. Every slice must preserve them.

1. **Declare an outcome** — not a task list. Structured north-star + how it is measured.
2. **Meet the mubot** — one teammate restates the goal, proposes a first plan, asks before acting.
3. **Work where you can see it** — one living picture: goal, progress, now, blocked, next.
4. **Learn from what didn't work** — misses are receipted and visible; hidden misses cannot teach.
5. **Adapt toward the goal** — dead ends die; verified movers get doubled down.
6. **Trust compounds** — autonomy widens only with verified wins (earned, never blanket).
7. **Owner always owns goal + gate** — mubot never redefines the target or self-signs risky work.

## 3. Substrate inventory (existence ≠ enforcement)

### 3.1 Wired on main — reuse, do not rebuild

| Piece | Where | Role in owner-experience |
|---|---|---|
| Project row + free-text `goal` | `projects` / `src/projects/service.ts` | Carrier for outcome text today; must grow a **structured** north-star (slice 1) |
| `ProjectSituation` + `next_action` | `src/projects/situation.ts` | Watch facet truth (health, blockers, reviews, flights) |
| Project lifecycle loop | `src/projects/loop.ts`, start-gate, circuit-breaker, completion-gate, stall | Drive/finish guarantees behind Watch |
| Board tasks + flights | `src/tasks/*`, `src/flight/*` | Act surface; chat may only dispatch here |
| `workflow_receipts` + verdicts + evidence projections | `writeReceiptToD1`, `src/projects/projections.ts` | Honest win/miss store (resolve by **receipt id**, never free-string label) |
| `lessons_capture` receipt | `src/projects/completion-gate.ts` | First visible-learning feed (project terminal) |
| Agent `Autonomy` enum | `src/types.ts` `suggest\|draft\|execute\|execute_with_approval` | Trust strip vocabulary — **static dial today** |
| `autonomyImpliesGate` | `src/org/service.ts` | Gate implication already enforced on task create |
| `grant_agent_capability` | `src/mcp/provision.ts` | Manual capability path; earned-autonomy proposes, owner confirms |
| Live task ranking | `src/tasks/ranking.ts` `rankTasks` (callers: mcp/index, tasks/index) | Rank facet interim surface until BrainPort default adapter exists |
| Project memory MCP | `project_remember` / `project_recall` / `project_context` | Know facet store (same store docs must use — #507) |

### 3.2 Explicit unmet dependencies (not cited as reuse)

| Dependency | Status | Consequence if ignored |
|---|---|---|
| **Tier-1 persistent mubot chat (#505)** | PR **CLOSED unmerged**; no `src/chat`; no successor | Talk facet has **zero** implementation. **Decision: Talk is OPTIONAL on owner home** until #505 is revived or replaced. Slice 2 ships Know+Watch; `assertOwnerHomeFacets` requires only those two. |
| **Tier-2 chat** (`tier2-user-chat/v1`) | Dyad-gate **BLOCK** | Talk for every member cannot ship on Tier-2 until that design amends. |
| **BrainPort default adapter** | Type-only SEALED; zero implementations / zero callers | Do **not** cite BrainPort under reuse. Rank step maps to live `rankTasks` interim, or waits for ranker's `brainport-default-adapter` slice. |
| **Project-scoped KPI source** | Not built (`task_counter`/`github_prs` are agent/tenant scoped) | v1 Outcome progress is **`unmeasured_until_project_kpi`** — never render measured from wrong-scope sources. |
| **ModelPort v2 (tool-calling)** | Named breaking change in `types.ts`; **not built** | Do not plan owner-chat tool loops against ModelPort v1. |
| **Pot monthly model ledger** | Plan field is display-only; live meter is per-agent/day | Any Talk budget story must name a real debit path or stay out of this epic. |
| **Per-project Docs UI (#507)** | Design only | Know facet starts as memory read/write via existing MCP + a thin viewer; full MDX editor is a later docs slice. |
| **Port-4 instinct memory** | Dormant branch (`cursor/task-b143e73d`); zero live callers on main; migration number collision risk | **Learn→Adapt that injects instincts is blocked.** Name Port-4 + learning-ranker as **slice 0 of the learning epic**, gated separately — do not merge that branch from this worktree. |
| **Learning ranker design** | Under dyad-gate / hold | Adapt-by-instinct is out of scope until that gate PASSes and Port-4 is live. Until then Adapt = board plan changes + situation `next_action` only. |
| **Structured project Outcome / KpiSpec** | Not on `projects` (only free-text `goal`) | Slice 1 must add it; do not pretend `projects.goal` is a measurable north-star. |
| **Automatic earned-autonomy widener** | Not built (`Autonomy` is a static column) | Slice 4 introduces propose-widen from verified wins; never auto-blanket keys. |
| **Project concierge** | Existing surface | Remains a deep-link into owner home facets — not a fourth panel; no parallel UX. |

> **Generalizable rule (from Tier-2 dyad-gate):** a "reuse" table entry must have a
> *caller on an enforcement path*. Existence, a type, or a dashboard display is
> not enforcement. Dormant branches are prerequisites with owners and gates, not
> dependencies you can lean on.

## 4. Design — one home, three facets, one loop

### 4.1 Owner home composition (UI non-goals for this commit)

First viewport of `/projects/:id` (or a dedicated `/home` that deep-links a
primary project) becomes **one composition**, not a dashboard of widgets:

1. **Outcome strip** — north-star statement + measured progress (or explicit
   `unmeasured` — never a fake 100%).
2. **Trust strip** — current autonomy level + "needs your yes" count from
   pending gated reviews.
3. **Three facets** (same page, same project scope):
   - **Talk** — Tier-1 mubot chat for the pot's named PM (kayhermes / tenant
     mubot). Tier-2 member chat is a later facet once its gate PASSes.
   - **Know** — RBAC-filtered project memory / docs list (same store as
     `project_recall`).
   - **Watch** — existing situation card + task/flight lists (already live).

No cards-in-hero. Brand/product remains the pot; the mubot is the teammate
voice inside Talk. Stats clusters and secondary marketing blocks stay out of
the first viewport.

### 4.2 Outcome model (north-star)

Replace "goal is a sentence" with **Outcome**:

```
Outcome {
  statement: string          // owner's words ("20 booked calls / month")
  metric: KpiSpec | null     // how progress is measured; null = unmeasured
  owner_principal: string    // human owner/admin who set it
  set_at: string
  version: number            // increments only on owner change
}
```

`KpiSpec` reuses the loop-container idea: named signal + source id. v1 allows
only sources that already have an enforcement/read path (`task_counter`,
`github_prs`, and future connector-backed sources when wired). **Unknown or
unwired source ⇒ progress renders `unmeasured`**, never a guessed green bar.

Only `owner` / `admin` principals may create or change Outcome. Mubot / agent
tokens may **propose** a restatement (Talk) but the write path requires the
owner principal — encoded in the contract as `mayMubotRedefineGoal === false`.

### 4.3 Closed loop mapping

| Step | Owner-experience meaning | Substrate |
|---|---|---|
| **Goal** | Outcome strip | New structured fields (slice 1) |
| **Sense** | Watch situation + metric read | `loadProjectSituation` + KPI source |
| **Rank** | What moves the number next | BrainPort ranking (rank-not-act); learning bias **only after** Port-4+ranker PASS |
| **Act** | Board tasks / flights through technicians | Existing board + BYOA |
| **Receipt** | Win or miss, by receipt id | `workflow_receipts` / verdicts / evidence |
| **Learn** | Distill miss→guardrail, win→playbook | v1: surface `lessons_capture` + gate-fail receipts; v2: Port-4 distill |
| **Adapt** | Plan bends | v1: new board work + kill dead tasks via lifecycle breaker; v2: instinct-biased rank |
| **Gate** | Owner holds risky/irreversible | Existing gate_owner + autonomyImpliesGate + earned widen |

### 4.4 Earned autonomy (trust widens with verified wins)

Trust levels map 1:1 onto existing `Autonomy` (no parallel enum):

| Trust level | Autonomy | Owner feeling |
|---|---|---|
| L0 observe | `suggest` | mubot only proposes |
| L1 draft | `draft` | mubot drafts; owner starts work |
| L2 gated execute | `execute_with_approval` | mubot runs; gate holds the line |
| L3 execute | `execute` | mubot runs within capability envelope |

**Widen rule (contract-enforced shape):**

- Input requires **projectId** and **agentId** (scope keys on the gate itself —
  not a sibling table convention). Fail closed on mismatch.
- Wins are **branded `VerifiedWinRef`** minted only by
  `verifiedWinRefFromResolver(resolver, receiptId, scope)`, registered in a
  runtime **WeakSet**, and frozen. The resolver is the trust boundary (Port-4
  InstinctChat pattern); the WeakSet is the provenance check (same class as
  ranker's `VerifiedReceiptRef`). A caller-written
  `{ verification: 'resolved_by_id' }` label **or** a forged `{ _brand:
  'VerifiedWinRef', ... }` literal is rejected — mechanism-lock ≠ trust-lock.
  The brand carries resolved **content** (polarity must be `win`, projectId,
  agentId, resolvedAt).
- Pure gate passes only when:
  1. `proposed` is exactly one step above `current` (no skip-to-blanket),
  2. `actingPrincipal` is an owner/admin human (never the mubot agent id),
  3. `verifiedWinCount >= requiredWinsForStep` (v1 default: 3),
  4. every win is a branded ref matching the input scope,
  5. none of the win receipt ids appear in `consumedReceiptIds`.
- On success the decision returns `consumeReceiptIds`; the caller must persist
  them before the next widen. **Rate/consumption story (named):**
  `mark_consumed_after_successful_widen` — the same three receipts cannot walk
  suggest → draft → execute_with_approval → execute. Outer defense remains the
  audit trail plus mandatory owner review of each widen.
- Worth knowing: per existing `autonomyImpliesGate`, `execute` is NOT
  auto-gated (only `execute_with_approval` is). The top of this ladder is the
  state where tasks stop being auto-gated.
- Narrowing (after a miss / gate FAIL storm) is always allowed to owner; mubot
  may *recommend* narrow, never self-narrow to escape accountability.

This deliberately does **not** call Port-4 for instincts. Verification binds to
`workflow_receipts` via the injected resolver at the build-slice wiring layer.
### 4.5 Honest progress (no fake-green)

`decideProgressDisplay`:

- If `metric === null` or source unwired → `{ kind: 'unmeasured' }`
- If KPI signal compute fails → `{ kind: 'unavailable', reason }` (not 0%, not 100%)
- If signal ok → `{ kind: 'measured', value, target, ratio }` with ratio clamped
  to \[0, 1\] for display but raw values retained for audit
- **Forbidden:** rendering `kind: 'measured'` from task-count alone when the
  Outcome metric names an external signal; task_counter is allowed only when
  the Outcome explicitly selected it.

### 4.6 Visible learning

Watch (or a Learning sub-facet) lists lessons with:

- `receipt_id` (required),
- `polarity: 'win' | 'miss'`,
- `summary` (short, owner-facing),
- `source_schema` (e.g. `mupot.lessons_capture/v1`, gate fail schema).

Entries without a receipt id are rejected by the contract helper. No
"mubot says it learned X" without a backing receipt.

## 5. Data model (draft — validate in dyad-gate; no migration in this commit)

```
-- additive on projects (shape only; slice 1 owns the migration)
outcome_statement     TEXT NOT NULL DEFAULT ''   -- may mirror goal initially
outcome_metric_json   TEXT NULL                -- KpiSpec or null
outcome_owner         TEXT NULL
outcome_set_at        TEXT NULL
outcome_version       INTEGER NOT NULL DEFAULT 0

-- earned autonomy audit (new table)
autonomy_widen_events (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  from_autonomy   TEXT NOT NULL,
  to_autonomy     TEXT NOT NULL,
  win_receipt_ids TEXT NOT NULL,   -- JSON array of receipt ids
  decided_by      TEXT NOT NULL,   -- owner principal
  created_at      TEXT NOT NULL
)
```

No second memory store. Docs continue to target the #507 unification with
`project_remember` / `project_recall`.

## 6. Boundaries / non-negotiables

1. Mubot **cannot** redefine Outcome; owner/admin write only.
2. Mubot **cannot** self-verdict gates or widen its own autonomy.
3. Wins/misses/lessons resolve by **receipt id** against pot stores — never by
   caller-supplied free-string provenance labels.
4. Progress never fake-greens: unmeasured/unavailable are first-class.
5. Talk v1 = Tier-1 mubot only; Tier-2 is a prerequisite with its own gate.
6. Learn→Adapt via instincts requires Port-4 + learning-ranker PASS as an
   explicit prerequisite epic — not silently assumed.
7. Brain remains rank-not-act; owner-experience must not add proposal verbs.
8. Branch-only builds; no merge/deploy/publish from this epic's slices without
   dyad-gate + Hadi-go.
9. Do not merge dormant Port-4 / ranker branches from this worktree to "unblock"
   learning — they need their own gates (D1 migrations included).

## 7. Acceptance criteria (design locked when)

1. Spec + `owner-experience/v1` contract encode the thesis, three facets, loop
   steps, and the six principles from the artifact.
2. Pure module encodes: owner-owns-goal, owner-owns-gate, earned-autonomy
   one-step widen with verified receipt ids, honest progress, lesson-requires-
   receipt, Talk-v1=Tier-1-only.
3. Focused vitest covers those invariants; `tsc --noEmit` clean.
4. Build slices listed; **none implemented** in this commit (no route /
   migration / UI).
5. Unmet dependencies named with status — no dormant surface cited as reuse.

## 8. Build slices (backlog — dyad-gate each; do not start until this design PASSes)

1. **Outcome model** — structured north-star on `projects` + progress helper
   wired to existing KPI sources only; fail closed to `unmeasured`.
2. **Owner home shell** — compose Outcome + Trust + Talk/Know/Watch facets on
   project detail (Watch = existing situation; Talk = Tier-1 embed; Know =
   memory list). No new cognition.
3. **Trust strip + gate queue** — surface current autonomy + pending
   owner-yes items from situation reviews / approvals.
4. **Earned autonomy** — `autonomy_widen_events` + propose/confirm path using
   contract gate; capability grants still go through existing
   `grant_agent_capability`.
5. **Visible learning** — lesson list from `lessons_capture` + gate-fail
   receipts by id on Watch.
6. **Talk facet Tier-2** — only after Tier-2 design amends and PASSes (ModelPort
   v2 or constrained prompt→text path explicitly chosen; real budget ledger;
   link-table fan-in).
7. **Know facet full docs** — #507 slices (one policy point → memory
   unification → editor).
8. **Learn/Adapt v2 (instinct)** — **prerequisite slice 0:** gate+land Port-4
   (migration renumbered) then learning-ranker; only then wire Adapt bias into
   Rank. Until then this slice stays backlog.

Each slice: Kasra-core + diverse second-eye before merge. Unassigned until
pulled from backlog.

## 9. Open questions (for dyad-gate)

1. Is the primary owner home `/projects/:id` or a pot-level `/home` that picks
   a default project? Lean: enhance `/projects/:id`, add pot home later.
2. Required win count per autonomy step — default 3; product may tune per plan.
3. Should Outcome live only on root projects (not children)? Lean: root-only in
   v1 to match two-level hierarchy.
4. Metric connectors beyond `task_counter` / `github_prs` (GHL booked-calls,
   PostHog conversions) — each is its own connector slice; owner-experience
   must not invent numbers without a source.

## 10. Related arc

- Artifact 2026-07-23: chat · docs · board as one relationship.
- #500 lifecycle / #503 BYOA = labor behind Watch.
- #507 / #522–526 = Know.
- #505 = Talk for the few (Tier-1); Tier-2 = Talk for the many (blocked).
- Port-4 + learning ranker = Learn/Adapt depth (explicit unmet).
- This spec is the **unifying owner surface**; it does not replace those epics —
  it sequences them behind one coherent experience.
