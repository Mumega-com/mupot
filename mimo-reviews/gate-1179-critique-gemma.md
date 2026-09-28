# GATE CRITIQUE — mupot PR #1179

**VERDICT: DISAGREE (BLOCK)**

The PASS verdict is issued based on an incomplete understanding of the enforcement lifecycle and a significant logic mismatch between the admission layer (`flight_dispatch`) and the enforcement layer (`meter.checkAndReserve`).

### 1. The "False Security" Enforcement Gap (Critical)
The verdict claims that "the flight's own requested budget still bounds it". This is **factually incorrect** regarding actual enforcement.
- **Admission (`src/mcp/index.ts`):** For an unconfigured agent (where `budget_cap_cents` is `null`), the `requestedBudget` is the *only* bound applied at dispatch.
- **Enforcement (`src/agents/meter.ts`):** During execution, the meter **completely ignores** the `requestedBudget`. It only enforces the agent's `budget_cap_cents` and the hard daily caps (`MAX_TOKENS_PER_DAY`).
- **Result:** If an agent is unconfigured (unlimited dollars), a flight with `requestedBudget: 1` can actually spend up to the daily cap (e.g., $50) before `flight_land` (which only checks *after* spend) can flag it. The `requestedBudget` provides a **false sense of security**; it is a post-facto audit check, not a runtime boundary. This violates the core principle of "aligning admission with enforcement".

### 2. Silent Cap Mismatch via `isSafeInteger` (High)
There is a critical logic divergence in how "configured" caps are identified:
- **Admission (`src/mcp/index.ts`):** Uses `Number.isSafeInteger(cap) && cap > 0`. A fractional cap (e.g., `10.5` cents) is treated as **unconfigured** (unlimited).
- **Enforcement (`src/agents/meter.ts`):** Uses `typeof cap === 'number' && cap > 0`. A fractional cap is treated as a **valid, configured cap**.
- **Attack Scenario:** A user provides a fractional cap. The admission layer treats the agent as "unlimited" (adding it to `budgetUncapped`) and allows a large `requestedBudget`. The enforcement layer then applies the small fractional cap. This results in a **silent misconfiguration** and incorrect observability in the `budget_uncapped` telemetry.

### 3. Verdict Summary
The PR claims to align the two layers, but it actually introduces a scenario where the admission layer's concept of "unlimited" is much more permissive than the enforcement layer's concept of "unlimited" (which is still bounded by daily caps), and where the `requestedBudget` is a phantom bound for the most volatile phase of the lifecycle.

**Recommendation: BLOCK.**
The admission layer must either:
1. Enforce `requestedBudget` during execution (not just at landing).
2. Or, acknowledge that `requestedBudget` is purely a "target" and not a "bound" for unconfigured agents to avoid misleading users.
3. Standardize `isConfigured` logic to be consistent with `meter.ts`.
