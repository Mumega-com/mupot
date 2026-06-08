# P0 — Enforcement-Layer Budget Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-agent dollar budget (`agents.budget_cap_cents`) a HARD pre-call stop — the loop/execute meter blocks BEFORE any model spend once the day's recorded cost plus a conservative estimate would breach the cap, so an autonomous loop can never run past its budget.

**Architecture:** Extend the existing `checkAndReserve` meter gate (already the pre-call governor for dispatch-count + token caps) with a third check: the dollar cap. The cap value (`budget_cap_cents`) and a conservative cost estimate (from `cost.ts`, the #15 rate model) are passed by the two trusted callers (`loop.ts`, `execute.ts`) from the already-loaded `agent` row. The window's running cost lives in `execution_meter.cost_micro_usd` (#15). No migration — pure code. This is a canonical sensitive surface (eligibility/veto) → adversarial-gated before merge.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, D1, Vitest. Branch: `feat/loop-container` (already cut from `origin/main`; the spec doc lives here).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/agents/meter.ts` | the pre-call governor | add dollar-cap check + `'budget_cap_exceeded'` reason + cents→micro-USD const + `ReserveOpts` param |
| `src/agents/loop.ts` | goal-cycle planning call site | pass estimate + cap to meter; add `'budget_exhausted'` decided + map reason |
| `src/agents/execute.ts` | execute-mode call site | pass estimate (`cycleCostMicroUsd`) + cap to meter |
| `tests/execution-meter.test.ts` | meter unit tests | update mock SELECT to carry `cost_micro_usd`; add dollar-cap tests |
| `tests/goal-loop.test.ts` (or existing loop test) | loop decided mapping | add `budget_exhausted` decided test |
| `CHANGELOG.md` / `package.json` | release | 0.9.0 entry + version bump |

**Units & interfaces:**
- `checkAndReserve(env, agentId, opts?: ReserveOpts)` — `ReserveOpts = { estimateMicroUsd?: number; budgetCapCents?: number | null }`. No opts ⇒ today's behaviour (no dollar enforcement) — backward compatible for any caller/test that omits it.
- Semantics: cap is the ceiling you may **reach but not exceed**. Block if `currentCost >= capMicroUsd` (already at/over) OR `currentCost + estimate > capMicroUsd` (next cycle would breach). Estimate is a conservative UPPER bound (cost.ts over-estimates unknown models, #15) so we never under-count.
- `MICRO_USD_PER_CENT = 10_000` (1¢ = $0.01 = 10,000 micro-USD).

---

### Task 1: Meter — reason + types + constant (no behaviour yet)

**Files:**
- Modify: `src/agents/meter.ts:52-61` (result types), add const + `ReserveOpts`

- [ ] **Step 1: Write the failing test**

Add to `tests/execution-meter.test.ts` (after the existing imports/describe):

```ts
import { MICRO_USD_PER_CENT } from '../src/agents/meter'

describe('dollar-cap constants', () => {
  it('1 cent = 10_000 micro-USD', () => {
    expect(MICRO_USD_PER_CENT).toBe(10_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/mumega/mupot && npx vitest run tests/execution-meter.test.ts -t 'dollar-cap constants'`
Expected: FAIL — `MICRO_USD_PER_CENT` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/meter.ts`, extend the block reason union (line 54) and add the constant + opts type. Change:

```ts
export interface MeterBlockResult {
  ok: false
  reason: 'rate_limited' | 'budget_exhausted' | 'budget_cap_exceeded'
  windowKey: string
  count: number
  tokens: number
  retryAfterSec: number // seconds until the next UTC midnight (window reset)
}
```

And add, just above `checkAndReserve` (around line 62):

```ts
/** 1 cent = $0.01 = 10,000 micro-USD. Used to convert budget_cap_cents → micro-USD. */
export const MICRO_USD_PER_CENT = 10_000

/**
 * Options for the dollar-cap enforcement (issue #4). Both are supplied by the
 * trusted caller from the already-loaded agent row:
 *   estimateMicroUsd — a CONSERVATIVE upper bound on this cycle's spend (cost.ts).
 *   budgetCapCents   — agents.budget_cap_cents; null/≤0 ⇒ no dollar cap (unlimited).
 * Omitting opts entirely preserves the pre-#4 behaviour (count + token caps only).
 */
export interface ReserveOpts {
  estimateMicroUsd?: number
  budgetCapCents?: number | null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/mumega/mupot && npx vitest run tests/execution-meter.test.ts -t 'dollar-cap constants'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mumega/mupot
git add src/agents/meter.ts tests/execution-meter.test.ts
git commit -m "feat(meter): dollar-cap reason + MICRO_USD_PER_CENT + ReserveOpts (#4)"
```

---

### Task 2: Meter — enforce the dollar cap pre-reserve (the core)

**Files:**
- Modify: `src/agents/meter.ts:73-141` (`checkAndReserve`)
- Modify: `tests/execution-meter.test.ts` (mock SELECT carries `cost_micro_usd`; new tests)

- [ ] **Step 1: Update the mock + write failing tests**

In `tests/execution-meter.test.ts`, the mock's SELECT branch must return `cost_micro_usd`. Find the branch `if (sql.includes('SELECT count, tokens'))` and replace its body with:

```ts
              if (sql.includes('SELECT count, tokens')) {
                const key = args[0] as string
                const row = state.get(key)
                if (!row) return null as unknown as T
                return {
                  count: row.count,
                  tokens: row.tokens,
                  cost_micro_usd: row.cost_micro_usd ?? 0,
                } as unknown as T
              }
```

Then add a new describe block:

```ts
describe('checkAndReserve — dollar cap (#4)', () => {
  const ENV = { TENANT_SLUG: 't', DB: undefined } as unknown as Env

  function envWith(state: Map<string, WindowState>): Env {
    return { ...ENV, DB: makeMockDB(state).db } as unknown as Env
  }

  it('no cap (budgetCapCents null) → not enforced, reserves normally', async () => {
    const env = envWith(new Map([['t:a:' + utcDay(), { count: 0, tokens: 0, cost_micro_usd: 9_999_999 }]]))
    const r = await checkAndReserve(env, 'a', { estimateMicroUsd: 1_000_000, budgetCapCents: null })
    expect(r.ok).toBe(true)
  })

  it('under cap → reserves', async () => {
    // cap = 100¢ = 1_000_000 micro-USD; spent 200_000; estimate 100_000 → 300_000 ≤ cap
    const env = envWith(new Map([['t:a:' + utcDay(), { count: 0, tokens: 0, cost_micro_usd: 200_000 }]]))
    const r = await checkAndReserve(env, 'a', { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(true)
  })

  it('estimate would breach → blocks budget_cap_exceeded, no reserve', async () => {
    // cap 1_000_000; spent 950_000; estimate 100_000 → 1_050_000 > cap → block
    const state = new Map([['t:a:' + utcDay(), { count: 5, tokens: 0, cost_micro_usd: 950_000 }]])
    const env = envWith(state)
    const r = await checkAndReserve(env, 'a', { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('budget_cap_exceeded')
    // count unchanged — reservation did NOT happen
    expect(state.get('t:a:' + utcDay())!.count).toBe(5)
  })

  it('already at/over cap with zero estimate → still blocks', async () => {
    const env = envWith(new Map([['t:a:' + utcDay(), { count: 0, tokens: 0, cost_micro_usd: 1_000_000 }]]))
    const r = await checkAndReserve(env, 'a', { estimateMicroUsd: 0, budgetCapCents: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('budget_cap_exceeded')
  })

  it('exactly reaching the cap is allowed (reach but not exceed)', async () => {
    // spent 900_000 + estimate 100_000 = 1_000_000 == cap → allowed
    const env = envWith(new Map([['t:a:' + utcDay(), { count: 0, tokens: 0, cost_micro_usd: 900_000 }]]))
    const r = await checkAndReserve(env, 'a', { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(true)
  })
})
```

Add this `utcDay` helper near the top of the test file if not already present:

```ts
function utcDay(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
```

(Confirm `makeMockDB` returns `{ db, ... }`; the existing file destructures it — match that shape. If it returns the db directly, use `makeMockDB(state)` without `.db`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/mumega/mupot && npx vitest run tests/execution-meter.test.ts -t 'dollar cap'`
Expected: FAIL — `checkAndReserve` ignores `opts`; the breach test reserves instead of blocking.

- [ ] **Step 3: Implement the dollar-cap check**

In `src/agents/meter.ts`, change the `checkAndReserve` signature and SELECT, and insert the dollar-cap check AFTER the token check (line 114) and BEFORE the reserve UPSERT (line 116):

```ts
export async function checkAndReserve(
  env: Env,
  agentId: string,
  opts: ReserveOpts = {},
): Promise<MeterResult> {
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)
  const now = new Date().toISOString()

  const existing = await env.DB.prepare(
    `SELECT count, tokens, cost_micro_usd FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number; cost_micro_usd: number }>()

  const currentCount = existing?.count ?? 0
  const currentTokens = existing?.tokens ?? 0
  const currentCost = existing?.cost_micro_usd ?? 0

  const maxDispatches = parseCap(env, 'EXEC_MAX_DISPATCH_DAY', MAX_DISPATCHES_PER_DAY)
  const maxTokens = parseCap(env, 'EXEC_MAX_TOKENS_DAY', MAX_TOKENS_PER_DAY)

  if (currentCount >= maxDispatches) {
    return { ok: false, reason: 'rate_limited', windowKey, count: currentCount, tokens: currentTokens, retryAfterSec: secondsUntilNextUtcMidnight() }
  }

  if (currentTokens >= maxTokens) {
    return { ok: false, reason: 'budget_exhausted', windowKey, count: currentCount, tokens: currentTokens, retryAfterSec: secondsUntilNextUtcMidnight() }
  }

  // ── Dollar cap (issue #4): enforcement-layer HARD stop, BEFORE any spend. ──
  // The cap is the agent's budget_cap_cents (null/≤0 ⇒ unlimited). The estimate is a
  // CONSERVATIVE upper bound (cost.ts over-estimates unknown models, #15), so we never
  // under-count. Block if already at/over the cap, or if the next cycle could breach it.
  // The cap may be REACHED but not EXCEEDED.
  const capCents = opts.budgetCapCents
  if (typeof capCents === 'number' && capCents > 0) {
    const capMicroUsd = capCents * MICRO_USD_PER_CENT
    const estimate = opts.estimateMicroUsd && opts.estimateMicroUsd > 0 ? Math.round(opts.estimateMicroUsd) : 0
    if (currentCost >= capMicroUsd || currentCost + estimate > capMicroUsd) {
      return { ok: false, reason: 'budget_cap_exceeded', windowKey, count: currentCount, tokens: currentTokens, retryAfterSec: secondsUntilNextUtcMidnight() }
    }
  }

  // Reserve the slot: UPSERT → create on first use or increment count.
  await env.DB.prepare(
    `INSERT INTO execution_meter (id, window_key, count, tokens, window_start)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(window_key) DO UPDATE SET count = count + 1`,
  )
    .bind(crypto.randomUUID(), windowKey, now)
    .run()

  const post = await env.DB.prepare(
    `SELECT count, tokens FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number }>()

  return { ok: true, windowKey, count: post?.count ?? currentCount + 1, tokens: post?.tokens ?? 0 }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/mumega/mupot && npx vitest run tests/execution-meter.test.ts`
Expected: PASS (all existing meter tests + the 5 new dollar-cap tests). The existing `'SELECT count, tokens'` substring still matches the widened SELECT, so legacy tests stay green.

- [ ] **Step 5: Commit**

```bash
cd /home/mumega/mupot
git add src/agents/meter.ts tests/execution-meter.test.ts
git commit -m "feat(meter): enforce per-agent dollar cap pre-reserve, hard stop before spend (#4)"
```

---

### Task 3: Wire the goal loop to pass estimate + cap

**Files:**
- Modify: `src/agents/loop.ts:56` (import), `:69-74` (`GoalCycleDecided`), `:153-164` (meter call)
- Test: `tests/work-unit-loop.test.ts` (the loop test file; `makeAgent(overrides: Partial<Agent>)` factory at line 27)

- [ ] **Step 1: Write the failing test**

Add to `tests/work-unit-loop.test.ts`:

```ts
it('budget cap block → decided budget_exhausted, no spawn', async () => {
  const agent = makeAgent({ okr: 'grow', kpi_target: '10 things', effort: 'standard', autonomy: 'draft', budget_cap_cents: 50 })
  const meterCheck = vi.fn(async () => ({
    ok: false as const, reason: 'budget_cap_exceeded' as const,
    windowKey: 'w', count: 1, tokens: 0, retryAfterSec: 100,
  }))
  const r = await runGoalCycle(ENV, agent, { meterCheck })
  expect(r.decided).toBe('budget_exhausted')
  expect(r.spawned).toBe(0)
})
```

(`makeAgent` takes `Partial<Agent>`, so `budget_cap_cents: 50` works directly; reuse the file's `ENV`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/mumega/mupot && npx vitest run tests/work-unit-loop.test.ts -t 'budget cap block'`
Expected: FAIL — `decided` is `'rate_limited'` (current hardcode) and `'budget_exhausted'` is not a valid `GoalCycleDecided`.

- [ ] **Step 3: Implement**

In `src/agents/loop.ts`:

(a) Extend the import (line 56) and add the cost import:

```ts
import { checkAndReserve } from './meter'
import { costMicroUsd } from './cost'
```

(b) Add a planning-cost bound near the effort-budget consts (after line 65):

```ts
/** Conservative token bound for pricing ONE planning (proposal) model call. */
export const LOOP_PLANNING_MAX_TOKENS = 8_000
```

(c) Add `'budget_exhausted'` to `GoalCycleDecided` (lines 69-74):

```ts
export type GoalCycleDecided =
  | 'no-goal'
  | 'kpi-met'
  | 'rate_limited'
  | 'budget_exhausted'  // dollar cap reached — loop paused, zero spend (#4)
  | 'observe-only'
  | 'spawned'
```

(d) Replace the meter call (lines 153-164):

```ts
  const meterCheck = deps.meterCheck ?? checkAndReserve
  const estimateMicroUsd = costMicroUsd(agent.model, LOOP_PLANNING_MAX_TOKENS)
  const meterResult = await meterCheck(env, agent.id, {
    estimateMicroUsd,
    budgetCapCents: agent.budget_cap_cents,
  })
  if (!meterResult.ok) {
    const decided: GoalCycleDecided =
      meterResult.reason === 'budget_cap_exceeded' ? 'budget_exhausted' : 'rate_limited'
    return { ok: false, decided, spawned: 0, autonomy, effort, error: meterResult.reason }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/mumega/mupot && npx vitest run tests/work-unit-loop.test.ts`
Expected: PASS (new test + all existing loop tests; the seam type widened but old `meterCheck` mocks that ignore the 3rd arg still satisfy `typeof checkAndReserve`).

- [ ] **Step 5: Commit**

```bash
cd /home/mumega/mupot
git add src/agents/loop.ts tests/work-unit-loop.test.ts
git commit -m "feat(loop): pass cost estimate + budget cap to meter; surface budget_exhausted (#4)"
```

---

### Task 4: Wire execute-mode to pass estimate + cap

**Files:**
- Modify: `src/agents/execute.ts:111` (the `meter.checkAndReserve` call)

- [ ] **Step 1: Move `cycleCostMicroUsd` above the meter call (REQUIRED)**

`const cycleCostMicroUsd = costMicroUsd(agent.model, EXECUTE_MAX_TOKENS)` is currently at `src/agents/execute.ts:132`, AFTER the `checkAndReserve` call at `:111`. Cut that line from :132 and paste it just ABOVE the meter call at :111, so it is in scope there (it is still used at :156/:165/:172/:175 unchanged). Verify nothing else between :111 and :132 depends on ordering:

Run: `cd /home/mumega/mupot && grep -n "cycleCostMicroUsd\|EXECUTE_MAX_TOKENS\|checkAndReserve" src/agents/execute.ts`
Expected: after the move, the `const cycleCostMicroUsd` line sits before line ~111's `meter.checkAndReserve`.

- [ ] **Step 2: Write/extend the failing test**

In `tests/execute.test.ts` (the execute-mode test file), add:

```ts
it('blocks on budget cap before any model call', async () => {
  const checkAndReserve = vi.fn(async () => ({
    ok: false as const, reason: 'budget_cap_exceeded' as const,
    windowKey: 'w', count: 0, tokens: 0, retryAfterSec: 100,
  }))
  const model = { chat: vi.fn() }
  const agent = makeExecuteAgent({ budget_cap_cents: 10 })
  const res = await runTaskExecution(ENV, { /* task */ } as any, agent, {
    meter: { checkAndReserve, recordTokens: vi.fn() }, model,
  })
  expect(model.chat).not.toHaveBeenCalled() // hard stop BEFORE spend
})
```

(Adapt arg names to the file's actual `runTaskExecution`/`runExecute` signature + `makeExecuteAgent` factory. The assertion that matters: `model.chat` is never called when the meter blocks.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/mumega/mupot && npx vitest run tests/execute.test.ts -t 'budget cap'`
Expected: FAIL or pass-by-accident — confirm the call currently passes no opts. If the test passes without the change because the meter already blocks, still apply Step 4 so the dollar cap is actually enforced in production (the no-opts call never triggers the dollar branch).

- [ ] **Step 4: Implement**

In `src/agents/execute.ts`, change line 111 from:

```ts
  const meterResult = await meter.checkAndReserve(env, agent.id)
```

to:

```ts
  const meterResult = await meter.checkAndReserve(env, agent.id, {
    estimateMicroUsd: cycleCostMicroUsd,
    budgetCapCents: agent.budget_cap_cents,
  })
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /home/mumega/mupot && npx vitest run tests/execute.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 6: Commit**

```bash
cd /home/mumega/mupot
git add src/agents/execute.ts tests/execute.test.ts
git commit -m "feat(execute): enforce dollar cap pre-reserve in execute mode (#4)"
```

---

### Task 5: Full suite, adversarial gate, release

**Files:**
- Modify: `CHANGELOG.md`, `package.json`

- [ ] **Step 1: Full suite + typecheck**

Run: `cd /home/mumega/mupot && npx vitest run && npx tsc --noEmit`
Expected: ALL pass, tsc clean.

- [ ] **Step 2: Adversarial review (PARALLEL gate — required, sensitive surface)**

Dispatch `kasra-review` (read-only) on the diff of `feat/loop-container` vs `origin/main`. Review brief: this is an eligibility/veto surface (a spend gate). Probe specifically:
1. Off-by-one at the boundary — can the loop spend strictly MORE than `budget_cap_cents`? (reach-not-exceed semantics)
2. Bypass — any model/tool spend path that does NOT route through `checkAndReserve` (so the cap is skipped)? Enumerate every `model.chat` / tool-call site.
3. Under-estimate — can `estimateMicroUsd` ever be 0 or too low for a real model, letting one over-cap cycle through? (cost.ts fallback behaviour)
4. Cap source integrity — is `budget_cap_cents` read from the trusted agent row, never client-supplied?
5. Race — the documented D1 concurrency race: at most (concurrency−1) extra cycles at the boundary. Acceptable for a soft governor, but CONFIRM the dollar overspend it permits is bounded by one cycle's estimate, not unbounded.

Merge ONLY on GREEN (or after fixing each finding + re-review).

- [ ] **Step 3: CHANGELOG + version**

Add to `CHANGELOG.md` under a new `## [0.9.0] — 2026-06-08`:

```markdown
## [0.9.0] — 2026-06-08

The governance primitive: a HARD dollar brake on autonomous spend.

### Added
- **Enforcement-layer budget cap** (#4). `checkAndReserve` (the pre-call meter
  gate) now blocks BEFORE any model spend once the day's recorded cost plus a
  conservative estimate would breach the agent's `budget_cap_cents`. The cap may
  be REACHED but not EXCEEDED. Wired into both the goal loop and execute mode; a
  blocked goal cycle returns `decided: 'budget_exhausted'` (zero spend, loop
  pauses). This is enforcement, not the alert-only pattern the market ships —
  the loop cannot run past its budget. Adversarial-gated (eligibility/veto
  surface). Foundation for the Loop Container (see
  docs/superpowers/specs/2026-06-08-loop-container-design.md §6.1).
```

Bump `package.json` `"version"` to `0.9.0`.

- [ ] **Step 4: Commit + push**

```bash
cd /home/mumega/mupot
git add CHANGELOG.md package.json
git commit -m "chore(release): 0.9.0 — enforcement-layer budget cap (#4)"
git push -u origin feat/loop-container
```

- [ ] **Step 5: Deploy + close issue (after merge to main)**

Per the deploy playbook: FF-merge `feat/loop-container` → `main`, deploy all 3 pots, then:

```bash
gh -R Mumega-com/mupot issue close 4 -c "Shipped v0.9.0 — enforcement-layer dollar cap. checkAndReserve hard-blocks before spend once budget_cap_cents would be breached; wired into loop + execute; adversarial-gated GREEN. The governance primitive for the Loop Container (P0)."
```

---

## Notes / follow-ups (NOT this plan)
- **True pause** (stop the metabolism from kicking a capped agent each tick) is an optimisation — P0 already guarantees zero spend (the block is a cheap D1 read, no model call). Track separately if the wasted reads matter at scale.
- **Cost in the block result** — `MeterBlockResult` does not carry `cost`; reason is enough signal for P0. Add for observability later if needed.
- Migration 0011 (`cost_micro_usd`) is already applied to all 3 D1s — no new migration here.
